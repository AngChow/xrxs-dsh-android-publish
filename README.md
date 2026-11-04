# xrxs-dsh-android-publish

[![ci](https://github.com/AngChow/xrxs-dsh-android-publish/actions/workflows/ci.yml/badge.svg)](https://github.com/AngChow/xrxs-dsh-android-publish/actions/workflows/ci.yml)

DeepSeek Harness (DSH) 插件：把 `android-publish` Codex skill 的 Android 发布流水线（打包 → Bugly 符号表 → 360 加固 → 应用宝/小米/华为/OPPO/vivo 提审）以安全、可审计的方式暴露给 DSH Agent。

- 目标 DSH 版本：`>=0.2.1-rc.5 <0.3.0`（`engines.dsh`）
- 同一份源码同时兼容 `0.2.1-rc.5` 与 `0.2.2-alpha.2`，CI 以最低支持版本做类型检查
- 首发平台：**macOS**（生产提审仅限 darwin；Windows 不支持）
- 完整实施方案见原始文档 `xrxs-dsh-android-publish-implementation-plan.md`

## 安全模型

1. **凭据零暴露**：所有密钥经 DSH 凭据库（`~/.dsh/.credentials.yaml`，ref 名映射）在每次操作时现解析，只注入子进程环境；模型可见输出、任务环形缓冲、审计日志全部经精确子串脱敏。
2. **`.publish_env` 隔离**：插件驱动运行时始终设置 `PUBLISH_DISABLE_PROJECT_ENV=1`，脚本侧 `load_env()` 遇该变量直接返回，项目本地明文凭据文件不再被读取（有回归测试覆盖）。
3. **模型不能传任意凭据/旗标**：环境键白名单（secret 形走 `credentialRefs`，其余走 `plainEnv`）；`--skip-*` 等旗标全部由 profile 策略推导。
4. **生产提审三重闸门**：profile `allowProductionSubmit: true` + 预检通过 + 用户在审批卡片上明确点选「确认提交生产」。拒绝则什么都不会启动。
5. **默认拒绝**：`allowProductionSubmit` / `allowGitTag` / `allowUnhardenedSubmit` 默认 `false`；`hardeningMode` 默认 `required`；`requireManagedCredentialSource` 默认 `true`（生产要求凭据来源为 `file`，即 DSH 托管凭据库）。
6. **审计**：`<runtimeDir>/audit.ndjson` 记录 start / preflight / approval_denied / complete / failed / cancelled。

## 模型工具

| 工具 | 用途 |
| --- | --- |
| `android_publish_doctor` | 体检：Python/依赖/Java/gradlew/构建工具/凭据配置状态（只报状态，永不报值） |
| `android_publish_plan` | 生成确定性发布计划（校验策略/渠道/路径/凭据，不执行） |
| `android_publish_preflight` | 跑 `pre_check.py`（签名/版本号），不打包不提审 |
| `android_publish_start` | 启动打包或提审后台任务；生产模式走审批卡片 |
| `android_publish_status` | 非消费式读取任务状态与脱敏输出 |

## 界面（DSH Web 客户端）

插件带一个客户端半身（`dsh.client` + `lib/client.js`），在桌面端/Web 端把 5 个工具渲染成发布卡片：

- 标题 + 状态徽标（运行中 / 通过 / 失败 / 已取消），一行摘要带 profile 与目标渠道；
- 展开后是事实表、流程步骤、分渠道结果、警告与输出尾部；
- 卡片数据走 `output.presentationMeta` 的结构化通道（客户端读 `block.meta`），不解析模型可见文本；
  旧会话里没有 meta 时回退展示原文本。
- 客户端包只依赖宿主提供的 `react`，不引用任何 `@deepseek-ai/dsh-client-*` 包。
- 升级宿主版本后需要重新 `pnpm build`，重新生成 `lib/client.js`。

审批卡片仍由宿主 `userQuestions` 渲染（`plan-review`），插件只负责标题与正文。

## 安装

`lib/` 构建产物不入库。请从 [Releases](https://github.com/AngChow/xrxs-dsh-android-publish/releases) 下载 `xrxs-dsh-android-publish-<version>.tgz`，或自行构建：

```bash
pnpm install
pnpm pack            # 产物在仓库根目录，文件名含版本号
```

### 桌面版 DSH（已在 `0.2.1-rc.5` 验证）

桌面版**没有** `dsh` CLI（`Contents/Resources/runtime/bin` 下只有 `node`），需直接改 profile。编辑 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "xrxs-dsh-android-publish": "file:/absolute/path/to/xrxs-dsh-android-publish-0.1.1.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "xrxs-dsh-android-publish"
      ]
    }
  }
}
```

在该 profile 目录执行安装，然后**完全退出并重开 App**：

```bash
cd ~/.dsh/profiles/desktop && pnpm install
ls node_modules            # 应只有 xrxs-dsh-android-publish
```

> ⚠️ `@deepseek-ai/dsh-*` **绝不能**出现在本插件的 `dependencies` 里，它们必须由宿主提供。
> 一旦这些包被复制进 profile 的 `node_modules`，进程内会出现两份
> `TOOL_RUNTIME_SCHEDULER` Symbol，注册与查找用的不是同一个对象，
> 结果是该 DSH 实例下**所有**工具调用立即失败（`Cannot read properties of undefined (reading 'prepare')`）。
> CI 中有一道专门校验在防止这个回归。

### CLI 版

以下命令沿用原方案文档，本次未在桌面版环境验证：

```bash
# profile 需先基于 web 模板创建，否则 bundles 里没有 web app 本体
dsh --profile android-publish --from-default-profile web --dump-config

dsh plugin --profile android-publish add /absolute/path/to/xrxs-dsh-android-publish-<version>.tgz

dsh --profile android-publish --dump-config       # 检查组合
dsh --profile android-publish --no-open --port 3080
```

## 配置

在你的 profile 覆盖层（`~/.dsh/profiles/<name>/cordis.patch.yml`）中按 `id` 整行覆盖配置（整对象替换，非深合并）：

```yaml
- id: xrxs-android-publish
  name: xrxs-dsh-android-publish
  config:
    pythonExecutable: /usr/bin/python3
    profiles:
      xrxs-android:
        displayName: XRXS Android
        projectRoot: /absolute/android/project
        allowedStores: [yyb, xiaomi, huawei, oppo, vivo]
        packageName: com.xrxs.example
        allowProductionSubmit: true   # 生产提审总开关，默认 false
        allowGitTag: false            # 提审成功后是否允许 git tag，默认 false
        hardeningMode: required       # required | optional | disabled
        requireBugly: true
        requireManagedCredentialSource: true
        credentialRefs:               # 脚本环境变量名 -> DSH 凭据 ref 名（引用，不是值）
          YYB_USER_ID: ANDROID_PUBLISH_XRXS_YYB_USER_ID
          YYB_ACCESS_SECRET: ANDROID_PUBLISH_XRXS_YYB_ACCESS_SECRET
          YYB_APP_ID: ANDROID_PUBLISH_XRXS_YYB_APP_ID
          # ...见方案 §9 凭据矩阵
        plainEnv:                     # 非密环境值（白名单键）
          JIAGU_HOME: /path/to/jiagu_cli_client_mac_x64
          ANDROID_BUILD_TOOLS: /path/Android/sdk/build-tools/34.0.0
```

凭据值写入 DSH 凭据库（勿写入任何代码/聊天/`.publish_env`）：

```yaml
# ~/.dsh/.credentials.yaml
version: 1
refs:
  ANDROID_PUBLISH_XRXS_YYB_USER_ID: your-user-id
  ANDROID_PUBLISH_XRXS_YYB_ACCESS_SECRET: your-secret
```

Python 依赖（requests / pycryptodome / cryptography）需在目标解释器可用，见 `resources/requirements.txt`；插件不自动安装。

## 行为约束（沿用原 skill）

- 仅应用宝支持 dry-run 与 API 定时上架；小米/华为/OPPO/vivo 上传即提审。
- 华为不支持 API 定时上架；OPPO/vivo 每接口每日 50 次；应用宝约 100 上传/50 更新。
- Bugly 失败不阻断（除非 `requireBugly: true`）；360 加固失败在启用加固时阻断提审。
- 不自动重试失败的渠道；由人决策。
- 生产提审不允许 `all` 渠道，必须显式列出。

## 资源与体积

- `lib/index.js` 约 52 KB，**发布产物本身不到 200 KB**。
- 腾讯 Bugly 官方符号表上传工具（`buglyqq-upload-symbol.jar`，约 32 MB）**不随包分发**，托管在
  [`tools-v1` Release](https://github.com/AngChow/xrxs-dsh-android-publish/releases/tag/tools-v1)。
- 首次执行 Bugly 符号表上传时，`upload_bugly_symbol.py` 会自动下载并校验 SHA256
  （`351273b8…e15f68`），写入 `resources/tools/`；该目录不可写时退回
  `$XDG_CACHE_HOME/xrxs-dsh/tools/`（默认 `~/.cache`）。
- 下载失败或校验不一致视为「无法获得 jar」：`requireBugly: true` 时阻断提审，否则跳过。
- 已持有本地 jar 时可用 `BUGLY_JAR_PATH` 指定以跳过下载；`BUGLY_JAR_URL` 可覆盖下载源。

## 与实施方案的已记录偏差（按 DSH `0.2.1-rc.5` / `0.2.2-alpha.2` 源码适配）

1. `@deepseek-ai/cordis` 实际版本线为 4.x（当前配套 `>=4.0.5-alpha.1`），`@deepseek-ai/schemastery` 为 `>=3.18.5`；方案中的 `0.2.2-alpha.2` 只适用于 `@deepseek-ai/dsh-*` 系列。DSH 兼容性由 `engines.dsh` 单独决定（cordis peer 不参与该检查）。
2. `ctx.jobs.start()` 直接返回 `JobId`；`{cancel, done}` 是 `run(job)` 返回的 `JobHooks`。
3. `ctx.credentials.resolve()` 未配置时返回 `undefined`（不是空对象）；local provider 的 source 取值为 `file` / `env` / `project-env` / `user-env`。
4. `ctx.jobs.readAt(id, from, caller)` 的第二参是流偏移；读取结果字段为 `next`（非 `nextOffset`），且 `readAt` 不返回 producer result（result 只在 `read()` 结算后给出一次）。
5. `ToolRunContext` 无 `sessionId` 字段；owner 会话经 `exec.agent.id`（`Agent.id` 即 SessionId）获取。
6. 生产确认锁：脚本实际使用 `--i-know-this-submits-to-production` 派生的 `YYB_CONFIRM_SUBMIT` 等分渠道变量，而非方案所写的单一 `PUBLISH_CONFIRM_SUBMIT=YES` 环境变量；语义等价。
7. 任务输出经 producer 侧 `job.append()` 泵入环形缓冲（250ms 轮询 runner stdout），脱敏后入环；未启用 subprocess spill 文件，第二份未脱敏全量输出不存在。
8. 审批意图使用 `kind: 'plan-review'`（自 0.1.1 起）：该 kind 在 `0.2.1-rc.5` 与 `0.2.2-alpha.2` 中都存在，而 `kind: 'approval'` 自 `0.2.2` 才引入，用它会导致在 rc.5 上类型检查失败。裁决规则为「选中项等于 `approve` 标签才算批准，其余（含未选择）一律拒绝」，保持 fail-closed。
9. `dsh bundle` patch 中增加 `platforms: [darwin]` 声明。

## 开发

```bash
pnpm install
pnpm run typecheck   # tsc --noEmit
pnpm test            # 30 个测试：tests/config.spec.ts、tests/request.spec.ts、tests/runner.spec.ts
pnpm run build       # tsdown -> lib/
```

> `submit` 路径受 `src/request.ts` 的 Darwin-only 守卫限制，因此 CI 在 `macos-latest` 上运行，而非 Linux。

人工发布验收（对照真实商店测试账号）尚未执行，见实施方案 §21 清单。
