# 360 天御（加固保）命令行工具

本目录存放 360 加固命令行客户端所需的**配置模板**。加固客户端程序本身体积较大（约 450MB，
且按平台区分 Mac x64 / Apple 芯片 / Windows / Linux），**不随 skill 入库**，需团队各自下载对应
平台的版本。

## 1. 获取命令行工具

登录 [360 加固保控制台](https://jiagu.360.cn) → 下载「360 天御命令行加固工具」对应你系统的
压缩包，解压后得到一个形如 `jiagu_cli_client_mac_x64`（Windows 为 `jiagu_cli_client_win_x64`，
Linux 为 `jiagu_cli_client_linux_x64`）的目录，里面包含 `startup`（或 `startup.bat` / `startup.sh`）。

## 2. 放置工具并指定 JIAGU_HOME

有两种方式，任选其一：

- **方式 A（推荐）**：解压到任意目录，在项目的 `.publish_env` 中指定：

  ```bash
  JIAGU_HOME="/path/to/jiagu_cli_client_mac_x64"
  ```

- **方式 B**：把解压后的 `jiagu_cli_client_*` 目录直接放到本目录（`vendor/360jiagu/`）下，
  脚本会自动发现（该目录已被 `.gitignore` 忽略，不会入 git）。

> 首次解压若遇到 Java 运行时被系统 `Killed: 9` 或无法启动，请先执行
> `xattr -dr com.apple.quarantine <工具目录>`（macOS 下载文件隔离属性）。脚本已自动处理。

## 3. 配置授权（license）

工具目录下需要 `license` 文件（本目录的 `license.template` 是模板）：

```
qid=你的360账号QID
api_id=API ID
api_key=API Key
```

这三个值在 [https://jiagu.360.cn/#/global/api/center](https://jiagu.360.cn/#/global/api/center)
的「密钥管理」里获取。**无需手动填写**：运行 `jiagu_360.py` 时会自动根据 `.publish_env` 里的
`JIAGU_QID` / `JIAGU_API_ID` / `JIAGU_API_KEY` 生成 license。

## 4. templates/ 模板说明

这些是加固功能里需要「配置文件」的模板（对应 `--config-jiagu-apk update` 里带 `=配置文件路径`
的参数）：

| 文件 | 用于 |
|------|------|
| `assets_protection_profile.txt` | `--assets=路径` 资源文件保护（排除/指定） |
| `dex_custom_profile.txt` | `--custom-dex=路径` Dex 定制加壳 |
| `dexshadow_profile.txt` | `--dex-shadow=路径` DexShadow（跳过类） |
| `android_harmony_full_vmp_profile.txt` | `--vmp=路径` 全 VMP（跳过类） |
| `android_harmony_custom_vmp_profile.txt` | `--vmp-custom=路径` 定制 VMP（指定类） |
| `multi-pkg_profile.json` | `--config-mul-pkg update` 多渠道打包配置 |
| `harmony_next_abc_protection_profile.txt` | 鸿蒙 NEXT `--harmony-next-abc-protection=路径` |

默认（不额外配置）使用的加固功能为 `--cert-check --string-obfus --anti-log`，
可通过 `.publish_env` 的 `JIAGU_FEATURES` 覆盖。
