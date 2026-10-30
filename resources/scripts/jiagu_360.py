#!/usr/bin/env python3
"""
360 天御(加固保)命令行加固封装

在 Android 项目打包后、上传应用市场前，对 APK 执行 360 加固并自动重签名。
产出"加固后且已重签名"的 APK，供后续多渠道提审直接使用。

用法:
  python3 jiagu_360.py <project_root> <input_apk> <output_dir>

流程:
  1. 读取 <project_root>/.publish_env 中的 JIAGU_* 凭据，缺则跳过(退出码 2)
  2. 定位 360 命令行工具目录(JIAGU_HOME)，校验启动器存在
  3. macOS 下移除 quarantine 隔离属性(避免 Java 运行时被系统 Killed: 9)
  4. 生成/更新工具目录下的 license 授权文件(基于 JIAGU_* 凭据)
  5. 配置加固功能 (--config-jiagu-apk update)
  6. 配置签名 (--config-sign-apk add)，供 --auto-sign 自动重签名
  7. 执行加固任务 (--jiagu-apk <apk> <out> --auto-sign)
  8. 在输出目录定位加固后的 APK，并向 stdout 打印标记行

退出码:
  0 = 加固成功
  1 = 加固失败
  2 = 未配置 360 加固(跳过，由调用方回退到原始 APK)

环境变量(来自 .publish_env，可用系统环境变量覆盖):
  JIAGU_QID            360 账号 QID（必填）
  JIAGU_API_ID         API ID（必填）
  JIAGU_API_KEY        API Key（必填）
  JIAGU_HOME           360 命令行工具目录，即包含 startup/startup.sh/startup.bat 的目录
  JIAGU_FEATURES       加固功能，空格分隔，默认 "--cert-check --string-obfus --anti-log"
  JIAGU_CONFIG_NAME    加固配置名，仅数字/字母/中文，默认 "jiagu360"
  JIAGU_KEYSTORE_PATH  签名 keystore 路径（缺省自动从 app/build.gradle 解析）
  JIAGU_KEYSTORE_PASS  keystore 密码（缺省自动解析）
  JIAGU_KEY_ALIAS      别名（缺省自动解析）
  JIAGU_KEY_PASS       别名密码（缺省自动解析）
"""

import sys
import os
import re
import glob
import shutil
import subprocess
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _yyb_common import log, load_env  # noqa: E402

# 输出标记行（stdout），由 build_and_submit.py 解析
MARKER_PREFIX = "JIAGU_OUTPUT_APK="

DEFAULT_FEATURES = "--cert-check --string-obfus --anti-log"
DEFAULT_CONFIG_NAME = "jiagu360"


def split_features(features_str):
    """把 '--a --so=a,b --vmp' 拆成列表（支持带 '=' 参数）"""
    return features_str.split()


def locate_jiagu_home():
    """定位 360 命令行工具目录，返回 (工具目录, 启动器绝对路径)，找不到返回 (None, None)"""
    home = os.environ.get("JIAGU_HOME", "").strip()

    candidates = []
    if home:
        candidates.append(home)

    # skill 内置 vendor 目录（若用户把工具解压到这里）
    skill_root = Path(__file__).resolve().parent.parent
    vendor_dir = skill_root / "vendor" / "360jiagu"
    if vendor_dir.is_dir():
        for d in vendor_dir.iterdir():
            if d.is_dir():
                candidates.append(str(d))

    # 常见默认安装位置
    candidates += [
        "/usr/local/360jiagu",
        "/opt/360jiagu",
        os.path.expanduser("~/360jiagu"),
        os.path.expanduser("~/Downloads/TYJiaguCli_Mac_x64"),
    ]

    if sys.platform == "win32":
        launcher_names = ["startup.bat"]
    elif sys.platform == "darwin":
        launcher_names = ["startup", "startup.sh"]
    else:
        launcher_names = ["startup.sh", "startup"]

    for cand in candidates:
        if not cand or not os.path.isdir(cand):
            continue
        # 目录本身，或目录下可能还有一层 jiagu_cli_client_* 子目录
        bases = [cand]
        try:
            bases += [os.path.join(cand, d) for d in os.listdir(cand)
                      if os.path.isdir(os.path.join(cand, d))]
        except OSError:
            pass
        for base in bases:
            for name in launcher_names:
                launcher = os.path.join(base, name)
                if os.path.isfile(launcher) and os.access(launcher, os.X_OK):
                    return base, launcher
    return None, None


def strip_quarantine(jiagu_home):
    """macOS 下去除 quarantine 隔离属性，避免 Java 被 Killed: 9"""
    if sys.platform != "darwin":
        return
    if not shutil.which("xattr"):
        return
    subprocess.run(["xattr", "-dr", "com.apple.quarantine", jiagu_home],
                   capture_output=True)


def write_license(jiagu_home, qid, api_id, api_key):
    """生成/更新 license 授权文件"""
    license_path = os.path.join(jiagu_home, "license")
    content = "qid={}\napi_id={}\napi_key={}\n".format(qid, api_id, api_key)
    with open(license_path, "w", encoding="utf-8") as f:
        f.write(content)
    log("已写入 license: " + license_path, "INFO")


def extract_block(content, keyword):
    """从 Groovy 文本中提取 keyword { ... } 块的内容"""
    pattern = rf'\b{keyword}\s*\{{'
    m = re.search(pattern, content)
    if not m:
        return None
    start = m.end()
    depth = 0
    for i in range(start, len(content)):
        if content[i] == '{':
            depth += 1
        elif content[i] == '}':
            if depth == 0:
                return content[start:i]
            depth -= 1
    return None


def _unquote(s):
    s = s.strip()
    if len(s) >= 2 and s[0] in ('"', "'") and s[-1] == s[0]:
        return s[1:-1]
    return s


def detect_keystore(project_root):
    """从 app/build.gradle 的 signingConfigs.release 块解析签名信息

    返回 (keystore_path, store_password, alias, key_password)，解析失败返回 None
    """
    gradle_path = os.path.join(project_root, "app", "build.gradle")
    if not os.path.isfile(gradle_path):
        return None
    with open(gradle_path, encoding="utf-8") as f:
        content = f.read()

    sc_block = extract_block(content, "signingConfigs")
    if not sc_block:
        return None
    release_block = extract_block(sc_block, "release")
    if not release_block:
        return None

    store_file_m = re.search(r'storeFile\s*=?\s*file\s*\(\s*"?([^")]+)"?\s*\)', release_block)
    store_pass_m = re.search(r'storePassword\s*=?\s*["\']([^"\']*)["\']', release_block)
    key_alias_m = re.search(r'keyAlias\s*=?\s*["\']([^"\']*)["\']', release_block)
    key_pass_m = re.search(r'keyPassword\s*=?\s*["\']([^"\']*)["\']', release_block)

    if not store_file_m:
        return None
    store_file = _unquote(store_file_m.group(1)).strip()
    store_pass = _unquote(store_pass_m.group(1)) if store_pass_m else ""
    key_alias = _unquote(key_alias_m.group(1)) if key_alias_m else ""
    key_pass = _unquote(key_pass_m.group(1)) if key_pass_m else ""

    app_dir = os.path.join(project_root, "app")
    store_file = store_file.replace("$projectDir", project_root)
    if not os.path.isabs(store_file):
        store_file = os.path.join(app_dir, store_file)
    store_file = os.path.abspath(store_file)

    if not os.path.isfile(store_file):
        log("解析到的 keystore 不存在: " + store_file, "WARN")
        return None

    return store_file, store_pass, key_alias, key_pass


def detect_package(project_root):
    """包名优先级: 环境变量 YYB_PKG_NAME > app/build.gradle applicationId"""
    pkg = os.environ.get("YYB_PKG_NAME", "").strip()
    if pkg:
        return pkg
    gradle_path = os.path.join(project_root, "app", "build.gradle")
    if os.path.isfile(gradle_path):
        with open(gradle_path, encoding="utf-8") as f:
            content = f.read()
        m = re.search(r'applicationId\s+["\']([^"\']+)["\']', content)
        if m:
            return m.group(1)
    return ""


def run_cli(launcher, args, timeout=1800, capture=False):
    """在工具目录下运行启动器，返回 subprocess.CompletedProcess

    capture=True 时捕获输出，失败时回显；False 时直接透传（用于长任务实时显示进度）
    """
    jiagu_home = os.path.dirname(launcher)
    cmd = [launcher] + args
    log("执行: " + " ".join([os.path.basename(launcher)] + args), "INFO")
    result = subprocess.run(cmd, cwd=jiagu_home, timeout=timeout,
                            capture_output=capture, text=capture)
    if capture and result.returncode != 0:
        out = (result.stdout or "") + (result.stderr or "")
        if out:
            sys.stderr.write(out)
    return result


def main():
    if len(sys.argv) < 4:
        print(__doc__)
        sys.exit(2)

    project_root = os.path.abspath(sys.argv[1])
    input_apk = os.path.abspath(sys.argv[2])
    output_dir = os.path.abspath(sys.argv[3])

    print()
    print("=" * 55)
    print("  360 天御(加固保) APK 加固")
    print("=" * 55)

    load_env(project_root)

    # 1. 凭据
    qid = os.environ.get("JIAGU_QID", "").strip()
    api_id = os.environ.get("JIAGU_API_ID", "").strip()
    api_key = os.environ.get("JIAGU_API_KEY", "").strip()
    if not (qid and api_id and api_key):
        log("未配置 360 加固凭据 (JIAGU_QID/JIAGU_API_ID/JIAGU_API_KEY)，跳过加固", "WARN")
        log("请在 .publish_env 中添加对应配置以启用 360 加固", "WARN")
        sys.exit(2)

    # 2. 定位工具
    jiagu_home, launcher = locate_jiagu_home()
    if not launcher:
        log("未找到 360 命令行工具，请设置 JIAGU_HOME 指向工具目录（包含 startup）", "ERROR")
        log("例如在 .publish_env 中: JIAGU_HOME=/path/to/jiagu_cli_client_mac_x64", "ERROR")
        sys.exit(1)
    log("360 工具目录: " + jiagu_home, "INFO")

    # 3. 去除 quarantine（macOS）
    strip_quarantine(jiagu_home)

    # 4. 写入 license
    write_license(jiagu_home, qid, api_id, api_key)

    # 5. 加固功能配置
    features = os.environ.get("JIAGU_FEATURES", DEFAULT_FEATURES).strip()
    config_name = os.environ.get("JIAGU_CONFIG_NAME", DEFAULT_CONFIG_NAME).strip()
    if not re.fullmatch(r"[0-9A-Za-z\u4e00-\u9fff]+", config_name):
        log("JIAGU_CONFIG_NAME 仅支持数字/字母/中文，当前值非法: " + config_name, "ERROR")
        sys.exit(1)
    pkg = detect_package(project_root)
    if not pkg:
        log("无法确定包名，请检查 .publish_env 的 YYB_PKG_NAME 或 app/build.gradle 的 applicationId", "ERROR")
        sys.exit(1)

    log("加固功能: " + features, "INFO")
    log("配置名: " + config_name + "，绑定包名: " + pkg, "INFO")
    r = run_cli(launcher, ["--config-jiagu-apk", "update"] + split_features(features)
                + ["--name", config_name, "--pn", pkg], capture=True)
    if r.returncode != 0:
        log("加固功能配置失败 (exit {})".format(r.returncode), "ERROR")
        sys.exit(1)

    # 6. 签名配置（供 --auto-sign）
    ks_path = os.environ.get("JIAGU_KEYSTORE_PATH", "").strip()
    ks_pass = os.environ.get("JIAGU_KEYSTORE_PASS", "").strip()
    ks_alias = os.environ.get("JIAGU_KEY_ALIAS", "").strip()
    ks_keypass = os.environ.get("JIAGU_KEY_PASS", "").strip()
    if not (ks_path and ks_pass and ks_alias and ks_keypass):
        detected = detect_keystore(project_root)
        if detected:
            ks_path, ks_pass, ks_alias, ks_keypass = detected
        else:
            log("未提供签名信息 (JIAGU_KEYSTORE_*)，且无法从 app/build.gradle 解析", "WARN")
            log("将跳过自动签名配置；加固后将不会重签名（需手动签名）", "WARN")

    if ks_path and ks_alias:
        log("配置签名: " + ks_path + " (alias=" + ks_alias + ")", "INFO")
        r = run_cli(launcher, ["--config-sign-apk", "add", ks_path, ks_pass, ks_alias, ks_keypass], capture=True)
        if r.returncode != 0:
            log("签名配置失败 (exit {})".format(r.returncode), "ERROR")
            sys.exit(1)
        auto_sign = ["--auto-sign"]
    else:
        auto_sign = []

    # 7. 执行加固任务
    if not os.path.isfile(input_apk):
        log("输入 APK 不存在: " + input_apk, "ERROR")
        sys.exit(1)
    os.makedirs(output_dir, exist_ok=True)
    log("开始加固: " + os.path.basename(input_apk), "STEP")
    r = run_cli(launcher, ["--jiagu-apk", input_apk, output_dir] + auto_sign, timeout=3600)
    if r.returncode != 0:
        log("加固任务失败 (exit {})".format(r.returncode), "ERROR")
        sys.exit(1)

    # 8. 定位加固产物
    apks = glob.glob(os.path.join(output_dir, "**", "*.apk"), recursive=True)
    apks = [a for a in apks if os.path.abspath(a) != input_apk]
    if not apks:
        log("加固失败：输出目录未生成加固 APK: " + output_dir, "ERROR")
        log("常见原因: 授权数量限制/加固额度已用完(见上方日志中的 授权数量限制 提示)，或网络异常", "ERROR")
        log("请到 https://jiagu.360.cn 加固保控制台确认授权额度，或查看上方完整日志定位原因", "ERROR")
        sys.exit(1)
    apks.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    out_apk = apks[0]
    log("加固产物: " + out_apk + " ({:.1f} MB)".format(os.path.getsize(out_apk) / 1024 / 1024), "OK")

    # 打印标记行到 stdout，供调用方解析
    print(MARKER_PREFIX + out_apk)
    sys.exit(0)


if __name__ == "__main__":
    main()
