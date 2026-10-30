#!/usr/bin/env python3
"""
plugin_runner.py - DSH xrxs-android-publish 插件子进程包装器

职责（对应实施方案 §12）：
1. 解析自身参数，`--` 之后为要执行的子脚本及其参数
2. 用同一 Python 可执行文件启动子脚本
3. 子进程环境由 DSH 侧注入（含已解析凭据与 PUBLISH_DISABLE_PROJECT_ENV=1），本脚本原样继承传递
4. 按行合并子进程 stdout/stderr
5. 对每行输出做精确子串脱敏后，才写入 stdout 与脱敏日志文件
6. 识别已知进度标记并输出 @@ANDROID_PUBLISH_PROGRESS@@ 结构化进度
7. 转发 @@ANDROID_PUBLISH_RESULT@@ 结构化结果；子脚本未输出时补发 {"parsed": false}
8. 取消时向整个子进程组转发信号
9. 将脱敏日志写入插件运行时目录，文件权限 0600

脱敏键集合通过环境变量 PLUGIN_REDACT_KEYS 指定（逗号分隔的环境变量名），
脱敏值实时从本进程 os.environ 读取，凭据不出现在任何 argv 中。
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path

PROGRESS_PREFIX = "@@ANDROID_PUBLISH_PROGRESS@@"
RESULT_PREFIX = "@@ANDROID_PUBLISH_RESULT@@"
REDACTED = "[redacted]"

# 子脚本人工日志中的步骤标记 -> 规范化 step 名
STEP_MAP = [
    ("[0/5]", "precheck"),
    ("[1/5] 打包", "build"),
    ("[1.5/5]", "bugly"),
    ("[1.6/5]", "jiagu"),
    ("[2/5]", "locate-apk"),
    ("[3/5]", "submit"),
    ("[4/5]", "git-tag"),
]


def load_secrets() -> dict:
    keys = os.environ.get("PLUGIN_REDACT_KEYS", "")
    secrets = {}
    for key in keys.split(","):
        key = key.strip()
        if not key:
            continue
        value = os.environ.get(key, "")
        if value:
            secrets[key] = value
    return secrets


def redact(line: str, secrets: dict) -> str:
    for value in secrets.values():
        if value and value in line:
            line = line.replace(value, REDACTED)
    return line


def emit(payload: dict) -> None:
    print(RESULT_PREFIX + " " + json.dumps(payload, ensure_ascii=False), flush=True)


def emit_progress(step: str, message: str) -> None:
    print(
        PROGRESS_PREFIX + " "
        + json.dumps({"step": step, "message": message}, ensure_ascii=False),
        flush=True,
    )


def detect_progress(line: str):
    for marker, step in STEP_MAP:
        if line.lstrip().startswith(marker):
            message = line.strip()
            return step, message
    return None


class Runner:
    def __init__(self, log_path: Path, secrets: dict):
        self.log_path = log_path
        self.secrets = secrets
        self.result_payload = None
        self._lock = threading.Lock()

    def handle_line(self, line: str, stream: str) -> None:
        safe = redact(line, self.secrets)
        with self._lock:
            sys.stdout.write(safe + "\n")
            sys.stdout.flush()
            try:
                with open(self.log_path, "a", encoding="utf-8") as fh:
                    fh.write(safe.rstrip("\n") + "\n")
            except OSError:
                pass
        progress = detect_progress(line)
        if progress:
            emit_progress(progress[0], progress[1])
        if line.startswith(RESULT_PREFIX):
            raw = line[len(RESULT_PREFIX):].strip()
            try:
                self.result_payload = json.loads(raw)
            except ValueError:
                self.result_payload = None

    def pump(self, stream, name: str) -> None:
        for raw in iter(stream.readline, ""):
            self.handle_line(raw.rstrip("\n"), name)
        stream.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="DSH android-publish plugin runner")
    parser.add_argument("--python", dest="python_exec", required=True,
                        help="用于执行子脚本的 Python 可执行文件路径")
    parser.add_argument("--log-dir", dest="log_dir", required=True,
                        help="脱敏日志目录（插件运行时目录）")
    parser.add_argument("--label", dest="label", default="run",
                        help="日志文件名标签")
    parser.add_argument("cmd", nargs=argparse.REMAINDER,
                        help="-- 之后为子脚本及参数")
    args = parser.parse_args()

    cmd = args.cmd
    if cmd and cmd[0] == "--":
        cmd = cmd[1:]
    if not cmd:
        emit({"exitCode": 2, "parsed": False, "error": "no child command"})
        return 2

    log_dir = Path(args.log_dir)
    log_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(log_dir, 0o700)
    except OSError:
        pass
    ts = time.strftime("%Y%m%d-%H%M%S")
    log_path = log_dir / f"android-publish-{args.label}-{ts}-{os.getpid()}.log"
    log_path.touch(mode=0o600)

    secrets = load_secrets()
    runner = Runner(log_path, secrets)

    env = dict(os.environ)
    # 双保险：子脚本自身也不允许读取项目本地 .publish_env
    env["PUBLISH_DISABLE_PROJECT_ENV"] = "1"
    # 脱敏键列表不需要传给子脚本，避免扩大暴露面
    env.pop("PLUGIN_REDACT_KEYS", None)

    start_ms = time.time() * 1000
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=env,
        start_new_session=True,
        text=True,
        errors="replace",
        bufsize=1,
    )

    def forward(signum, _frame):
        try:
            os.killpg(proc.pid, signum)
        except (ProcessLookupError, PermissionError):
            try:
                proc.send_signal(signum)
            except ProcessLookupError:
                pass

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)

    threads = [
        threading.Thread(target=runner.pump, args=(proc.stdout, "stdout"), daemon=True),
        threading.Thread(target=runner.pump, args=(proc.stderr, "stderr"), daemon=True),
    ]
    for t in threads:
        t.start()
    return_code = proc.wait()
    for t in threads:
        t.join(timeout=10)

    duration_ms = int(time.time() * 1000 - start_ms)
    if runner.result_payload is None:
        payload = {
            "exitCode": return_code if return_code is not None else -1,
            "parsed": False,
            "durationMs": duration_ms,
            "log": log_path.name,
        }
    else:
        payload = dict(runner.result_payload)
        payload.setdefault("parsed", True)
        payload.setdefault("durationMs", duration_ms)
        payload["log"] = log_path.name
    emit(payload)
    return return_code if return_code is not None else 1


if __name__ == "__main__":
    sys.exit(main())
