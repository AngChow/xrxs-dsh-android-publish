#!/usr/bin/env python3
"""
处理外部 360 加固 APK: zipalign -> apksigner 重签名 -> V2 校验 -> Walle 渠道包

用法:
  python3 resign_protected_apk.py <project_root> <hardened_apk> [output_dir]
      [--channel-file FILE] [--no-channel]

签名信息来源:
  1. JIAGU_KEYSTORE_PATH / JIAGU_KEYSTORE_PASS / JIAGU_KEY_ALIAS / JIAGU_KEY_PASS
  2. 项目 app/build.gradle 的 signingConfigs.release

输出:
  manifest.json 记录基础包与各渠道包路径；渠道模式同时生成 channels/*.apk。
"""

import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from _yyb_common import log, load_env  # noqa: E402
from jiagu_360 import detect_keystore  # noqa: E402

SKILL_ROOT = SCRIPT_DIR.parent
VENDOR_DIR = SKILL_ROOT / "vendor" / "protected-apk-resigner"
CHECK_V2_JAR = VENDOR_DIR / "lib" / "CheckAndroidV2Signature.jar"
WALLE_JAR = VENDOR_DIR / "lib" / "walle-cli-all.jar"


def run(cmd, cwd=None, timeout=600):
    display = [os.path.basename(cmd[0])] + cmd[1:]
    # apksigner 命令中包含密码，只显示文件名，不显示完整参数。
    if cmd[0].endswith("apksigner") and "sign" in cmd:
        display = ["apksigner", "sign", "<signing arguments>"]
    log("执行: " + " ".join(display), "INFO")
    return subprocess.run(cmd, cwd=cwd, timeout=timeout, text=True,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def fail(message, result=None):
    if result is not None and result.stdout:
        print(result.stdout.strip())
    log(message, "ERROR")
    sys.exit(1)


def locate_build_tools():
    env_dir = os.environ.get("ANDROID_BUILD_TOOLS", "").strip()
    if env_dir:
        candidates = [env_dir]
    else:
        candidates = []
        for env_name in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
            root = os.environ.get(env_name, "").strip()
            if root:
                candidates += glob.glob(os.path.join(root, "build-tools", "*"))
        candidates += glob.glob(os.path.expanduser(
            "~/Library/Android/sdk/build-tools/*"))
        candidates += glob.glob(os.path.expanduser(
            "~/develop/android-sdk*/build-tools/*"))
        for name in ("aapt", "zipalign", "apksigner"):
            path = shutil.which(name)
            if path:
                candidates.append(os.path.dirname(path))

    for directory in candidates:
        tools = {name: os.path.join(directory, name)
                 for name in ("aapt", "zipalign", "apksigner")}
        if all(os.path.isfile(path) and os.access(path, os.X_OK)
               for path in tools.values()):
            return tools

    fail("未找到 Android build-tools，请设置 ANDROID_BUILD_TOOLS 指向包含 aapt/zipalign/apksigner 的目录")


def read_apk_info(aapt, apk_path):
    result = run([aapt, "dump", "badging", apk_path])
    if result.returncode != 0:
        fail("读取 APK 信息失败: " + apk_path, result)

    package_match = re.search(
        r"package: name='([^']+)' versionCode='(\d+)' versionName='([^']*)'",
        result.stdout,
    )
    if not package_match:
        fail("无法解析 APK 包名或版本信息", result)

    native_match = re.search(r"^native-code: (.+)$", result.stdout, re.MULTILINE)
    return {
        "package": package_match.group(1),
        "version_code": int(package_match.group(2)),
        "version_name": package_match.group(3),
        "abis": native_match.group(1).strip() if native_match else "",
    }


def read_project_info(project_root):
    gradle_path = os.path.join(project_root, "app", "build.gradle")
    if not os.path.isfile(gradle_path):
        fail("未找到 app/build.gradle: " + gradle_path)

    with open(gradle_path, encoding="utf-8") as f:
        content = f.read()

    package_match = re.search(r'applicationId\s+["\']([^"\']+)["\']', content)
    code_match = re.search(r"versionCode\s+(\d+)", content)
    name_match = re.search(r'versionName\s+["\']?([A-Za-z0-9._-]+)["\']?', content)
    if not package_match or not code_match:
        fail("无法从 app/build.gradle 解析包名或 versionCode")

    version_name = name_match.group(1) if name_match else ""
    if version_name == "APP_VERSION":
        properties_path = os.path.join(project_root, "gradle.properties")
        if os.path.isfile(properties_path):
            with open(properties_path, encoding="utf-8") as f:
                prop_match = re.search(r"^APP_VERSION=(.+)$", f.read(), re.MULTILINE)
                if prop_match:
                    version_name = prop_match.group(1).strip()

    return {
        "package": package_match.group(1),
        "version_code": int(code_match.group(1)),
        "version_name": version_name,
    }


def check_apk_matches_project(aapt, apk_path, project_root):
    apk_info = read_apk_info(aapt, apk_path)
    project_info = read_project_info(project_root)

    problems = []
    if apk_info["package"] != project_info["package"]:
        problems.append(
            "包名不一致: APK={} / 项目={}".format(
                apk_info["package"], project_info["package"])
        )
    if apk_info["version_code"] != project_info["version_code"]:
        problems.append(
            "versionCode 不一致: APK={} / 项目={}".format(
                apk_info["version_code"], project_info["version_code"])
        )
    if project_info["version_name"] and apk_info["version_name"] != project_info["version_name"]:
        problems.append(
            "versionName 不一致: APK={} / 项目={}".format(
                apk_info["version_name"], project_info["version_name"])
        )
    if "arm64-v8a" not in apk_info["abis"].split("'"):
        problems.append("当前流程仅支持 arm64-v8a APK，实际 native-code: " + apk_info["abis"])

    if problems:
        for problem in problems:
            log(problem, "ERROR")
        fail("外部加固包与项目配置不一致，停止处理")

    log("APK 与项目配置匹配: {} {} ({})".format(
        apk_info["package"], apk_info["version_name"], apk_info["version_code"]), "OK")


def resolve_signing_config(project_root):
    load_env(project_root)
    env = os.environ
    values = (
        env.get("JIAGU_KEYSTORE_PATH", "").strip(),
        env.get("JIAGU_KEYSTORE_PASS", "").strip(),
        env.get("JIAGU_KEY_ALIAS", "").strip(),
        env.get("JIAGU_KEY_PASS", "").strip(),
    )
    if not all(values):
        detected = detect_keystore(project_root)
        if not detected:
            fail("无法解析 signingConfigs.release，请设置 JIAGU_KEYSTORE_* 环境变量")
        values = detected

    keystore_path, store_password, alias, key_password = values
    if not os.path.isfile(keystore_path):
        fail("keystore 不存在: " + keystore_path)
    return keystore_path, store_password, alias, key_password


def verify_apk(tools, apk_path, check_v2_jar):
    align_result = run([tools["zipalign"], "-c", "-p", "4", apk_path])
    if align_result.returncode != 0:
        fail("zipalign 校验失败: " + apk_path, align_result)

    sign_result = run([tools["apksigner"], "verify", "--verbose", apk_path])
    if sign_result.returncode != 0:
        fail("apksigner 校验失败: " + apk_path, sign_result)
    if "Verified using v2 scheme (APK Signature Scheme v2): true" not in sign_result.stdout:
        fail("APK 未通过 V2 签名校验: " + apk_path, sign_result)

    check_result = run(["java", "-jar", str(check_v2_jar), apk_path])
    try:
        payload = json.loads(check_result.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        fail("CheckAndroidV2Signature 输出无法解析: " + apk_path, check_result)
    if check_result.returncode != 0 or not payload.get("isV2OK"):
        fail("CheckAndroidV2Signature 校验失败: " + apk_path, check_result)


def parse_channels(channel_file):
    channels = []
    with open(channel_file, encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            channel = line.split("#", 1)[0].strip()
            if channel:
                channels.append(channel)
    if not channels:
        fail("渠道定义文件为空: " + channel_file)
    return channels


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("project_root")
    parser.add_argument("hardened_apk")
    parser.add_argument("output_dir", nargs="?")
    parser.add_argument("--channel-file", default=str(VENDOR_DIR / "channel"))
    parser.add_argument("--no-channel", action="store_true")
    args = parser.parse_args()

    project_root = os.path.abspath(args.project_root)
    input_apk = os.path.abspath(args.hardened_apk)
    output_dir = os.path.abspath(args.output_dir or os.path.join(
        project_root, "app", "build", "outputs", "apk", "release-protected-resigner"
    ))
    channel_file = os.path.abspath(args.channel_file)

    if not os.path.isfile(input_apk):
        fail("外部加固 APK 不存在: " + input_apk)
    if not os.path.isfile(CHECK_V2_JAR) or not os.path.isfile(WALLE_JAR):
        fail("skill 内置 ProtectedApkResigner 依赖缺失，请检查 vendor/protected-apk-resigner/lib")

    load_env(project_root)
    tools = locate_build_tools()
    check_apk_matches_project(tools["aapt"], input_apk, project_root)

    if os.path.isdir(output_dir):
        shutil.rmtree(output_dir)
    os.makedirs(output_dir)

    aligned_apk = os.path.join(output_dir, "protected-aligned.apk")
    signed_apk = os.path.join(output_dir, "protected-signed.apk")

    log("输入加固包: " + input_apk, "INFO")
    log("输出目录: " + output_dir, "INFO")

    align_result = run([tools["zipalign"], "-f", "-p", "4", input_apk, aligned_apk])
    if align_result.returncode != 0:
        fail("zipalign 处理失败", align_result)

    keystore_path, store_password, alias, key_password = resolve_signing_config(project_root)
    sign_result = run([
        tools["apksigner"], "sign",
        "--ks", keystore_path,
        "--ks-key-alias", alias,
        "--ks-pass", "pass:" + store_password,
        "--key-pass", "pass:" + key_password,
        "--v1-signing-enabled", "true",
        "--v2-signing-enabled", "true",
        "--out", signed_apk,
        aligned_apk,
    ])
    if sign_result.returncode != 0:
        fail("APK 重签名失败", sign_result)
    log("正式签名完成: " + signed_apk, "OK")

    manifest = {
        "input_apk": input_apk,
        "base_apk": signed_apk,
        "channels": {},
    }

    if args.no_channel:
        verify_apk(tools, signed_apk, CHECK_V2_JAR)
        log("已跳过 Walle 渠道分包 (--no-channel)", "WARN")
    else:
        if not os.path.isfile(channel_file):
            fail("渠道定义文件不存在: " + channel_file)
        channels = parse_channels(channel_file)
        channel_dir = os.path.join(output_dir, "channels")
        os.makedirs(channel_dir)

        walle_result = run([
            "java", "-jar", str(WALLE_JAR), "batch",
            "-f", channel_file, signed_apk, channel_dir,
        ], timeout=1800)
        if walle_result.returncode != 0:
            fail("Walle 渠道分包失败", walle_result)

        for channel in channels:
            matches = glob.glob(os.path.join(channel_dir, "*" + channel + ".apk"))
            if len(matches) == 1:
                channel_apk = matches[0]
            else:
                channel_apk = os.path.join(channel_dir, channel + ".apk")
            if not os.path.isfile(channel_apk):
                fail("Walle 未生成渠道包: " + channel_apk)
            verify_apk(tools, channel_apk, CHECK_V2_JAR)
            manifest["channels"][channel] = channel_apk

    manifest_path = os.path.join(output_dir, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    log("处理完成，manifest: " + manifest_path, "OK")
    print("PROTECTED_RESIGNER_MANIFEST=" + manifest_path)
    sys.exit(0)


if __name__ == "__main__":
    main()
