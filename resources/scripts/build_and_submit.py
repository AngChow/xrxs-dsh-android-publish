#!/usr/bin/env python3
"""
Android 应用打包 + 多渠道上传提审一条龙

支持渠道:
  - yyb    腾讯应用宝
  - xiaomi 小米应用商店
  - huawei 华为应用市场
  - oppo   OPPO 应用市场
  - vivo   vivo 应用市场
  - all    所有已配置凭据的渠道（默认）

流程:
  0. 预检查: 签名配置 + 版本号 (调用 pre_check.py)
  1. ./gradlew clean assembleRelease  (打正式包)
  1.5. 上传符号表到 Bugly (非阻塞)
  1.6. 360 加固 + 自动重签名 (可选，配置 JIAGU_* 凭据后执行)
  2. 定位待提交 APK（加固后产物，未加固则用 app-arm64-v8a-release.apk）
     2.5 外部加固包模式 (--hardened-apk): 对齐 + 正式签名 + V2 校验 + Walle 分包
  3. 按指定渠道依次上传 + 提审
  4. 全部成功后 Git 打 tag (合并到 master + 创建版本 tag)

安全锁（必须同时满足）:
  1. 命令行带 --i-know-this-submits-to-production
  2. 环境变量 PUBLISH_CONFIRM_SUBMIT=YES（或对应渠道的 YYB_CONFIRM_SUBMIT / MI_CONFIRM_SUBMIT）
  build_and_submit.py 会在 --confirm 时自动为各渠道子进程设置对应环境变量，
  所以只需设 PUBLISH_CONFIRM_SUBMIT=YES 即可。

用法:
  # 打包 + 全渠道提审
  PUBLISH_CONFIRM_SUBMIT=YES python3 build_and_submit.py \
      --i-know-this-submits-to-production \
      --update-desc "修复已知问题" \
      /Users/Ang/workspace/mobile-android

  # 仅应用宝
  PUBLISH_CONFIRM_SUBMIT=YES python3 build_and_submit.py \
      --store yyb --i-know-this-submits-to-production \
      /Users/Ang/workspace/mobile-android

  # 仅打包 + 上传，不提审
  python3 build_and_submit.py --dry-run /Users/Ang/workspace/mobile-android

  # 跳过打包，直接用已有 APK
  PUBLISH_CONFIRM_SUBMIT=YES python3 build_and_submit.py \
      --skip-build --store xiaomi --i-know-this-submits-to-production \
      /Users/Ang/workspace/mobile-android

  # 使用外部 360 加固包: 对齐 + 正式签名 + Walle 渠道包 + 提审
  PUBLISH_CONFIRM_SUBMIT=YES python3 build_and_submit.py \
      --hardened-apk /path/to/app-release.encrypted.apk \
      --i-know-this-submits-to-production \
      --update-desc "修复已知问题" \
      /Users/Ang/workspace/mobile-android

  # 定时上架（北京时间 YYYY-MM-DD HH:MM:SS）
  PUBLISH_CONFIRM_SUBMIT=YES python3 build_and_submit.py \
      --i-know-this-submits-to-production \
      --online-time "2026-07-20 10:00:00" \
      --update-desc "修复已知问题" \
      /Users/Ang/workspace/mobile-android

退出码:
  0 = 全部成功
  1 = 至少一个渠道失败
  2 = 参数错误
"""

import sys
import os
import time
import argparse
import glob
import json
import subprocess
from datetime import datetime, timezone, timedelta
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _yyb_common import log, load_env  # noqa: E402

# 64 位 APK 固定文件名和相对路径
APK_NAME = "app-arm64-v8a-release.apk"
APK_OUTPUT_DIR = "app/build/outputs/apk/release"
# 360 加固产物输出目录（相对项目根目录）
JIAGU_OUTPUT_DIR = "app/build/outputs/apk/release-jiagu"
# 外部加固包处理产物目录（相对项目根目录）
PROTECTED_RESIGNER_OUTPUT_DIR = "app/build/outputs/apk/release-protected-resigner"

BUILD_TIMEOUT = 1800  # 30 分钟

ALL_STORES = ["yyb", "xiaomi", "huawei", "oppo", "vivo"]

# Walle 渠道名 -> 商店标识
STORE_CHANNEL = {
    "yyb": "channel_tencent",
    "xiaomi": "channel_xiaomi",
    "huawei": "channel_huawei",
    "oppo": "channel_oppo",
    "vivo": "channel_vivo",
}

# 北京时区
BJ_TZ = timezone(timedelta(hours=8))


def parse_online_time(time_str):
    """将 'YYYY-MM-DD HH:MM:SS' (北京时间) 转换为各渠道所需格式

    返回 dict:
      seconds:  秒级 Unix 时间戳 (应用宝 deploy_time)
      ms:       毫秒级 Unix 时间戳 (小米 onlineTime)
      datetime: 原始字符串 'YYYY-MM-DD HH:MM:SS' (OPPO sche_online_time / vivo scheOnlineTime)
    """
    dt = datetime.strptime(time_str, "%Y-%m-%d %H:%M:%S")
    dt_bj = dt.replace(tzinfo=BJ_TZ)
    return {
        "seconds": int(dt_bj.timestamp()),
        "ms": int(dt_bj.timestamp() * 1000),
        "datetime": time_str,
    }


def run_build(project_root):
    """运行 ./gradlew clean assembleRelease"""
    gradlew = os.path.join(project_root, "gradlew")
    if not os.path.isfile(gradlew):
        log(f"未找到 gradlew: {gradlew}", "ERROR")
        sys.exit(1)

    log("开始打包: ./gradlew clean assembleRelease", "STEP")
    log(f"项目目录: {project_root}", "INFO")
    start = time.time()

    result = subprocess.run(
        [gradlew, "clean", "assembleRelease"],
        cwd=project_root,
        timeout=BUILD_TIMEOUT,
    )

    elapsed = time.time() - start
    if result.returncode != 0:
        log(f"打包失败 (exit code {result.returncode})，耗时 {elapsed:.0f}s", "ERROR")
        sys.exit(1)

    log(f"打包成功，耗时 {elapsed:.0f}s", "OK")


def upload_bugly_symbol(project_root):
    """打包后上传符号表到 Bugly（非阻塞，失败不影响后续提审）"""
    cmd = [sys.executable, str(SCRIPT_DIR / "upload_bugly_symbol.py"), project_root]
    log("调用 upload_bugly_symbol.py...", "STEP")
    result = subprocess.run(cmd, cwd=project_root)
    if result.returncode != 0:
        log("Bugly 符号表上传失败，继续后续流程（非阻塞）", "WARN")
    return result.returncode


def run_jiagu(project_root, apk_path, args):
    """对 APK 执行 360 加固 + 自动重签名，返回 (rc, 加固后 APK 路径或 None)

    rc:
      0 = 加固成功，返回加固后 APK 路径
      2 = 未配置 360 加固（跳过，返回 None，调用方用原始 APK）
      1 = 加固失败（调用方应中止，避免提交未加固的包）
    """
    out_dir = os.path.join(project_root, JIAGU_OUTPUT_DIR)
    cmd = [sys.executable, str(SCRIPT_DIR / "jiagu_360.py"),
           project_root, apk_path, out_dir]
    env = dict(os.environ)
    if getattr(args, "jiagu_home", None):
        env["JIAGU_HOME"] = args.jiagu_home

    log("调用 jiagu_360.py 执行 360 加固...", "STEP")
    result = subprocess.run(cmd, cwd=project_root, env=env)

    rc = result.returncode
    if rc == 2:
        log("未配置 360 加固，跳过加固步骤", "WARN")
        return rc, None
    if rc != 0:
        log("360 加固失败，中止发布流程（避免提交未加固的包）", "ERROR")
        return rc, None

    # 定位加固产物
    apks = glob.glob(os.path.join(out_dir, "**", "*.apk"), recursive=True)
    apks = [a for a in apks if os.path.abspath(a) != os.path.abspath(apk_path)]
    if not apks:
        log("360 加固未生成产物 APK，中止发布流程", "ERROR")
        return 1, None
    apks.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    hardened = apks[0]
    log("360 加固完成，产物: " + hardened, "OK")
    return 0, hardened


def run_protected_resigner(project_root, hardened_apk, args):
    """处理外部 360 加固包，返回 manifest dict"""
    output_dir = os.path.join(project_root, PROTECTED_RESIGNER_OUTPUT_DIR)
    cmd = [sys.executable, str(SCRIPT_DIR / "resign_protected_apk.py"),
           project_root, hardened_apk, output_dir]
    if args.no_channel:
        cmd.append("--no-channel")
    else:
        cmd.extend(["--channel-file", args.channel_file])

    log("调用 resign_protected_apk.py 处理外部加固包...", "STEP")
    result = subprocess.run(cmd, cwd=project_root)
    if result.returncode != 0:
        log("外部加固包处理失败，停止发布流程", "ERROR")
        sys.exit(1)

    manifest_path = os.path.join(output_dir, "manifest.json")
    try:
        with open(manifest_path, encoding="utf-8") as f:
            manifest = json.load(f)
        if not manifest.get("base_apk"):
            raise ValueError("manifest 中缺少 base_apk")
    except (OSError, ValueError, json.JSONDecodeError) as e:
        log("读取外部加固包处理结果失败: {} ({})".format(manifest_path, e), "ERROR")
        sys.exit(1)
    return manifest


def get_submit_apk(manifest, store, no_channel):
    """按商店选择 Walle 渠道包；无渠道模式使用基础签名包"""
    base_apk = manifest["base_apk"]
    if no_channel or not manifest.get("channels"):
        return base_apk

    channel = STORE_CHANNEL.get(store)
    if not channel:
        log("商店 {} 没有对应的 Walle 渠道映射".format(store), "ERROR")
        sys.exit(1)
    apk_path = manifest["channels"].get(channel)
    if not apk_path or not os.path.isfile(apk_path):
        log("缺少 {} 渠道包: {}".format(store, channel), "ERROR")
        sys.exit(1)
    return apk_path


def find_apk(project_root):
    """定位 app-arm64-v8a-release.apk"""
    apk_path = os.path.join(project_root, APK_OUTPUT_DIR, APK_NAME)
    if not os.path.isfile(apk_path):
        log(f"未找到 APK: {apk_path}", "ERROR")
        out_dir = os.path.join(project_root, APK_OUTPUT_DIR)
        if os.path.isdir(out_dir):
            apks = [f for f in os.listdir(out_dir) if f.endswith(".apk")]
            if apks:
                log(f"目录下找到的 APK: {', '.join(apks)}", "INFO")
        sys.exit(1)

    size_mb = os.path.getsize(apk_path) / 1024 / 1024
    log(f"找到 APK: {apk_path} ({size_mb:.1f} MB)", "OK")
    return apk_path


def check_store_configured(store, project_root):
    """检查某渠道的凭据是否已配置"""
    load_env(project_root)
    if store == "yyb":
        return bool(os.environ.get("YYB_USER_ID") and os.environ.get("YYB_ACCESS_SECRET"))
    elif store == "xiaomi":
        return bool(os.environ.get("MI_USER_NAME") and os.environ.get("MI_PRIVATE_KEY"))
    elif store == "huawei":
        return bool(os.environ.get("HW_CLIENT_ID") and os.environ.get("HW_CLIENT_SECRET"))
    elif store == "oppo":
        return bool(os.environ.get("OPPO_CLIENT_ID") and os.environ.get("OPPO_CLIENT_SECRET"))
    elif store == "vivo":
        return bool(os.environ.get("VIVO_ACCESS_KEY") and os.environ.get("VIVO_ACCESS_SECRET"))
    return False


def make_child_env(confirm):
    """构建子进程环境变量，设置安全锁"""
    env = dict(os.environ)
    if confirm:
        env["YYB_CONFIRM_SUBMIT"] = "YES"
        env["MI_CONFIRM_SUBMIT"] = "YES"
        env["HW_CONFIRM_SUBMIT"] = "YES"
        env["OPPO_CONFIRM_SUBMIT"] = "YES"
        env["VIVO_CONFIRM_SUBMIT"] = "YES"
    return env


def submit_yyb(apk_path, project_root, args, env):
    """委托 submit_apk.py 上传提审到应用宝"""
    cmd = [sys.executable, str(SCRIPT_DIR / "submit_apk.py"), "--apk64", apk_path]
    if args.confirm:
        cmd.append("--i-know-this-submits-to-production")
    if args.dry_run:
        cmd.append("--dry-run")
    if args.update_desc:
        cmd.extend(["--feature", args.update_desc])
    if hasattr(args, "_online_time"):
        cmd.extend(["--deploy-type", "2", "--deploy-time", str(args._online_time["seconds"])])
    cmd.extend(["--project-root", project_root])

    log("调用 submit_apk.py (应用宝)...", "STEP")
    result = subprocess.run(cmd, cwd=project_root, env=env)
    return result.returncode


def submit_xiaomi(apk_path, project_root, args, env):
    """委托 mi_submit.py 上传提审到小米"""
    cmd = [sys.executable, str(SCRIPT_DIR / "mi_submit.py"),
           "--apk", apk_path, "--update-desc", args.update_desc]
    if args.confirm:
        cmd.append("--i-know-this-submits-to-production")
    if args.icon_path:
        cmd.extend(["--icon", args.icon_path])
    if args.privacy_url:
        cmd.extend(["--privacy-url", args.privacy_url])
    if hasattr(args, "_online_time"):
        cmd.extend(["--online-time", str(args._online_time["ms"])])
    cmd.extend(["--project-root", project_root])

    log("调用 mi_submit.py (小米)...", "STEP")
    result = subprocess.run(cmd, cwd=project_root, env=env)
    return result.returncode


def submit_huawei(apk_path, project_root, args, env):
    """委托 hw_submit.py 上传提审到华为"""
    cmd = [sys.executable, str(SCRIPT_DIR / "hw_submit.py"),
           "--apk", apk_path]
    if args.confirm:
        cmd.append("--i-know-this-submits-to-production")
    if args.update_desc:
        cmd.extend(["--update-desc", args.update_desc])
    if args.remark:
        cmd.extend(["--remark", args.remark])
    cmd.extend(["--project-root", project_root])

    log("调用 hw_submit.py (华为)...", "STEP")
    result = subprocess.run(cmd, cwd=project_root, env=env)
    return result.returncode


def submit_oppo(apk_path, project_root, args, env):
    """委托 oppo_submit.py 上传提审到 OPPO"""
    cmd = [sys.executable, str(SCRIPT_DIR / "oppo_submit.py"),
           "--apk", apk_path,
           "--update-desc", args.update_desc]
    if args.confirm:
        cmd.append("--i-know-this-submits-to-production")
    if hasattr(args, "_online_time"):
        cmd.extend(["--online-type", "2", "--sche-online-time", args._online_time["datetime"]])
    cmd.extend(["--project-root", project_root])

    log("调用 oppo_submit.py (OPPO)...", "STEP")
    result = subprocess.run(cmd, cwd=project_root, env=env)
    return result.returncode


def submit_vivo(apk_path, project_root, args, env):
    """委托 vivo_submit.py 上传提审到 vivo"""
    cmd = [sys.executable, str(SCRIPT_DIR / "vivo_submit.py"),
           "--apk", apk_path,
           "--update-desc", args.update_desc]
    if args.confirm:
        cmd.append("--i-know-this-submits-to-production")
    if hasattr(args, "_online_time"):
        cmd.extend(["--online-type", "2", "--sche-online-time", args._online_time["datetime"]])
    cmd.extend(["--project-root", project_root])

    log("调用 vivo_submit.py (vivo)...", "STEP")
    result = subprocess.run(cmd, cwd=project_root, env=env)
    return result.returncode


def main():
    parser = argparse.ArgumentParser(
        description="Android 应用打包 + 多渠道上传提审一条龙",
        add_help=False,
    )
    parser.add_argument("--store", dest="store", action="append", default=[],
                        choices=["yyb", "xiaomi", "huawei", "oppo", "vivo", "all"],
                        help="目标渠道(可重复): yyb=应用宝, xiaomi=小米, huawei=华为, oppo=OPPO, vivo=vivo; all=全部已配置渠道(默认)")
    parser.add_argument("--i-know-this-submits-to-production",
                        dest="confirm", action="store_true",
                        help="确认提审（安全锁）")
    parser.add_argument("--dry-run", dest="dry_run", action="store_true",
                        help="仅打包 + 上传，不提审")
    parser.add_argument("--update-desc", dest="update_desc",
                        default="修复已知问题，优化用户体验",
                        help="更新文案（默认: 修复已知问题，优化用户体验）")
    parser.add_argument("--remark", dest="remark", default="",
                        help="华为提审备注（10-300 字符）")
    parser.add_argument("--icon", dest="icon_path", default=None,
                        help="图标路径（仅小米需要时传）")
    parser.add_argument("--privacy-url", dest="privacy_url", default=None,
                        help="隐私政策 URL（仅小米需要时传）")
    parser.add_argument("--skip-build", dest="skip_build", action="store_true",
                        help="跳过打包，直接上传已有 APK")
    parser.add_argument("--hardened-apk", dest="hardened_apk", default=None,
                        help="外部 360 加固 APK 路径；处理后提交，不重新打包")
    parser.add_argument("--no-channel", dest="no_channel", action="store_true",
                        help="外部加固包不写 Walle 渠道信息，所有渠道共用基础签名包")
    parser.add_argument("--channel-file", dest="channel_file", default=None,
                        help="Walle 渠道定义文件，默认使用 skill 内置 channel 文件")
    parser.add_argument("--skip-check", dest="skip_check", action="store_true",
                        help="跳过预检查（签名配置 + 版本号）")
    parser.add_argument("--skip-bugly", dest="skip_bugly", action="store_true",
                        help="跳过 Bugly 符号表上传")
    parser.add_argument("--skip-jiagu", dest="skip_jiagu", action="store_true",
                        help="跳过 360 加固，直接提交原始 APK")
    parser.add_argument("--jiagu-home", dest="jiagu_home", default=None,
                        help="360 命令行工具目录（覆盖 JIAGU_HOME 环境变量）")
    parser.add_argument("--skip-git", dest="skip_git", action="store_true",
                        help="跳过 Git 打 tag")
    parser.add_argument("--online-time", dest="online_time", default=None,
                        help="定时上架时间 (格式: YYYY-MM-DD HH:MM:SS, 北京时间). "
                             "设置后所有支持渠道将定时上架; 华为不支持需手动设置")
    parser.add_argument("--help", "-h", action="store_true")
    parser.add_argument("project_root", nargs="?", default=".",
                        help="Android 项目根目录（默认当前目录）")
    args = parser.parse_args()

    if args.hardened_apk:
        args.hardened_apk = os.path.abspath(args.hardened_apk)
        if not os.path.isfile(args.hardened_apk):
            log("外部加固 APK 不存在: " + args.hardened_apk, "ERROR")
            sys.exit(2)

    if not args.channel_file:
        args.channel_file = str(
            SCRIPT_DIR.parent / "vendor" / "protected-apk-resigner" / "channel"
        )

    if args.help:
        print(__doc__)
        sys.exit(0)

    # 解析定时上架时间，转换为各渠道所需格式
    if args.online_time:
        try:
            args._online_time = parse_online_time(args.online_time)
            log(f"定时上架时间: {args.online_time} "
                f"(应用宝: {args._online_time['seconds']}, "
                f"小米: {args._online_time['ms']})", "WARN")
        except ValueError:
            log(f"--online-time 格式错误，请使用 YYYY-MM-DD HH:MM:SS 格式", "ERROR")
            sys.exit(2)
        # 华为不支持 API 定时上架
        requested_stores_early = args.store or ["all"]
        if "huawei" in requested_stores_early or "all" in requested_stores_early:
            log("华为应用市场不支持 API 定时上架，需在 AGC 控制台手动设置", "WARN")

    project_root = os.path.abspath(args.project_root)

    # Step 0: 预检查（签名配置 + 版本号）
    if not args.skip_check:
        print()
        log("[0/5] 预检查", "STEP")
        check_result = subprocess.run(
            [sys.executable, str(SCRIPT_DIR / "pre_check.py"), project_root],
            cwd=project_root,
        )
        if check_result.returncode != 0:
            log("预检查未通过，停止发布流程", "ERROR")
            sys.exit(1)
    else:
        log("跳过预检查 (--skip-check)", "WARN")

    # 确定目标渠道
    requested_stores = args.store or ["all"]
    if "all" in requested_stores and len(requested_stores) != 1:
        log("--store all 不能与具名渠道同时使用", "ERROR")
        sys.exit(2)
    if requested_stores == ["all"]:
        stores = [s for s in ALL_STORES if check_store_configured(s, project_root)]
        if not stores:
            log("未找到任何已配置凭据的渠道，请检查凭据配置（插件模式下来自 DSH 凭据库）", "ERROR")
            sys.exit(2)
    else:
        stores = requested_stores

    print()
    print("=" * 55)
    print(f"  Android 应用上架 - 打包 + 提审")
    print(f"  目标渠道: {', '.join(stores)}")
    print("=" * 55)

    # Step 1: 打包
    if args.hardened_apk:
        log("使用外部加固包，跳过重新打包 (--hardened-apk)", "WARN")
    elif args.skip_build:
        log("跳过打包步骤 (--skip-build)", "WARN")
    else:
        print()
        log("[1/5] 打包 Release APK", "STEP")
        run_build(project_root)

    # Step 1.5: 上传符号表到 Bugly（非阻塞）
    if (not args.skip_build or args.hardened_apk) and not args.skip_bugly:
        print()
        log("[1.5/5] 上传符号表到 Bugly", "STEP")
        upload_bugly_symbol(project_root)

    # Step 1.6: 360 加固（可选，配置 JIAGU_* 凭据后自动执行）
    apk_path = None
    if args.hardened_apk:
        log("使用外部加固包，跳过内置 360 加固步骤", "WARN")
    elif args.skip_jiagu:
        log("跳过 360 加固 (--skip-jiagu)", "WARN")
    else:
        print()
        log("[1.6/5] 360 加固", "STEP")
        original_apk = find_apk(project_root)
        jiagu_rc, hardened_apk = run_jiagu(project_root, original_apk, args)
        if jiagu_rc == 1:
            log("360 加固失败，停止发布流程", "ERROR")
            sys.exit(1)
        if hardened_apk:
            apk_path = hardened_apk

    # Step 2: 定位待提交 APK（未加固则用原始 64 位包）
    if args.hardened_apk:
        pass
    elif apk_path is None:
        print()
        log("[2/5] 定位 64 位 APK", "STEP")
        apk_path = find_apk(project_root)
    else:
        print()
        log("[2/5] 待提交 APK（360 加固后）: " + apk_path, "OK")

    protected_manifest = None
    if args.hardened_apk:
        print()
        log("[2/5] 处理外部加固包", "STEP")
        protected_manifest = run_protected_resigner(
            project_root, args.hardened_apk, args
        )
        base_apk = protected_manifest["base_apk"]
        log("外部加固包处理完成，基础包: " + base_apk, "OK")

        # 先检查所有目标商店的渠道包，避免部分渠道提交后才暴露缺包。
        if not args.no_channel:
            for store in stores:
                submit_apk = get_submit_apk(protected_manifest, store, False)
                log("{} 渠道包: {}".format(store, submit_apk), "INFO")

    # Step 3: 逐渠道上传 + 提审
    env = make_child_env(args.confirm)
    results = {}   # store_id -> exit code
    skipped = []   # dry-run 下不支持仅上传的渠道

    for i, store in enumerate(stores, 1):
        # 小米和华为的提审脚本不单独支持 dry-run，跳过
        if store in ("xiaomi", "huawei", "oppo", "vivo") and args.dry_run:
            log(f"{store}: dry-run 模式下跳过（该渠道不支持仅上传不提审）", "WARN")
            skipped.append(store)
            continue

        print()
        prefix = f"[3/5] 渠道 {i}/{len(stores)}"
        submit_apk = (
            get_submit_apk(protected_manifest, store, args.no_channel)
            if protected_manifest else apk_path
        )
        if store == "yyb":
            log(f"{prefix} 应用宝", "STEP")
            results["yyb"] = submit_yyb(submit_apk, project_root, args, env)
        elif store == "xiaomi":
            log(f"{prefix} 小米应用商店", "STEP")
            results["xiaomi"] = submit_xiaomi(submit_apk, project_root, args, env)
        elif store == "huawei":
            log(f"{prefix} 华为应用市场", "STEP")
            results["huawei"] = submit_huawei(submit_apk, project_root, args, env)
        elif store == "oppo":
            log(f"{prefix} OPPO 应用市场", "STEP")
            results["oppo"] = submit_oppo(submit_apk, project_root, args, env)
        elif store == "vivo":
            log(f"{prefix} vivo 应用市场", "STEP")
            results["vivo"] = submit_vivo(submit_apk, project_root, args, env)

    # 汇总
    print()
    print("=" * 55)
    log("提审结果汇总:", "STEP")
    all_ok = True
    display_names = {"yyb": "应用宝", "xiaomi": "小米", "huawei": "华为",
                     "oppo": "OPPO", "vivo": "vivo"}
    for store, rc in results.items():
        if rc == 0:
            log(f"  {display_names.get(store, store)}: 成功", "OK")
        else:
            log(f"  {display_names.get(store, store)}: 失败 (exit {rc})", "ERROR")
            all_ok = False

    if all_ok:
        log("全部渠道提审成功!", "OK")

        # Step 4: Git 打 tag（仅在全部成功且非 dry-run 时执行）
        git_tagged = False
        if not args.dry_run and not args.skip_git:
            print()
            log("[4/5] Git 打 tag", "STEP")
            tag_cmd = [sys.executable, str(SCRIPT_DIR / "git_tag.py"),
                       project_root, "--update-desc", args.update_desc]
            tag_result = subprocess.run(tag_cmd, cwd=project_root)
            if tag_result.returncode != 0:
                log("Git 打 tag 失败（不影响已提交的提审）", "WARN")
            else:
                git_tagged = True
        elif args.skip_git:
            log("跳过 Git 打 tag (--skip-git)", "WARN")
    else:
        log("部分渠道失败，跳过 Git 打 tag", "WARN")

    exit_code = 0 if all_ok else 1
    result_payload = {
        "exitCode": exit_code,
        "mode": "dry-run" if args.dry_run else "submit",
        "stores": stores,
        "success": sorted(s for s, rc in results.items() if rc == 0),
        "failed": sorted(s for s, rc in results.items() if rc != 0),
        "skipped": skipped,
        "gitTagged": git_tagged if all_ok else False,
    }
    print("@@ANDROID_PUBLISH_RESULT@@ " + json.dumps(result_payload, ensure_ascii=False))
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
