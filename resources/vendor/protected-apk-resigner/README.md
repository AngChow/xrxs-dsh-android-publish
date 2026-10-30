# ProtectedApkResignerForWalle (skill 内置版)

本目录内置了外部 360 加固包处理所需的核心工具：

- `ApkResigner.py` / `channel` / `LICENSE` / `README.md`: 来自 ProtectedApkResignerForWalle
- `lib/CheckAndroidV2Signature.jar`: V2 签名校验
- `lib/walle-cli-all.jar`: Walle 渠道分包

skill 不使用原项目的 `config.py`，避免把 keystore 密码复制进 skill。实际编排入口是：

```bash
python3 ../../scripts/resign_protected_apk.py \
  <project_root> <hardened_apk> [output_dir] [--no-channel]
```

脚本会自动从项目 `app/build.gradle` 的 `signingConfigs.release` 解析签名信息，也可使用 `JIAGU_KEYSTORE_PATH`、`JIAGU_KEYSTORE_PASS`、`JIAGU_KEY_ALIAS`、`JIAGU_KEY_PASS` 覆盖。处理流程为：包名/版本/ABI 校验 -> `zipalign` -> `apksigner` 正式签名 -> V2 签名校验 -> 可选 Walle 渠道分包 -> 产物逐个验签。
