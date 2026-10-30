# xrxs-dsh-android-publish

DeepSeek Harness (DSH) 插件：把 `android-publish` Codex skill 的 Android 发布流水线（打包 → Bugly 符号表 → 360 加固 → 应用宝/小米/华为/OPPO/vivo 提审）以安全、可审计的方式暴露给 DSH Agent。

- 目标 DSH 版本：`>=0.2.2-alpha.2 <0.3.0`（engines.dsh）
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

## 安装

```bash
# 打包
pnpm install && pnpm build && pnpm pack

# 安装到独立 profile（路径或 tgz 必须是绝对路径）
dsh plugin --profile android-publish add /absolute/path/to/xrxs-dsh-android-publish-0.1.0.tgz

# 注意：profile 必须先基于 web 模板创建（否则 bundles 里没有 web app 本体）：
dsh --profile android-publish --from-default-profile web --dump-config

# 检查组合
dsh --profile android-publish --dump-config

# 启动
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

## 与实施方案的已记录偏差（按 DSH 0.2.2-alpha.2 源码适配）

1. `@deepseek-ai/cordis` 实际版本线为 4.x（当前配套 `>=4.0.5-alpha.1`），`@deepseek-ai/schemastery` 为 `>=3.18.5`；方案中的 `0.2.2-alpha.2` 只适用于 `@deepseek-ai/dsh-*` 系列。DSH 兼容性由 `engines.dsh` 单独决定（cordis peer 不参与该检查）。
2. `ctx.jobs.start()` 直接返回 `JobId`；`{cancel, done}` 是 `run(job)` 返回的 `JobHooks`。
3. `ctx.credentials.resolve()` 未配置时返回 `undefined`（不是空对象）；local provider 的 source 取值为 `file` / `env` / `project-env` / `user-env`。
4. `ctx.jobs.readAt(id, from, caller)` 的第二参是流偏移；读取结果字段为 `next`（非 `nextOffset`），且 `readAt` 不返回 producer result（result 只在 `read()` 结算后给出一次）。
5. `ToolRunContext` 无 `sessionId` 字段；owner 会话经 `exec.agent.id`（`Agent.id` 即 SessionId）获取。
6. 生产确认锁：脚本实际使用 `--i-know-this-submits-to-production` 派生的 `YYB_CONFIRM_SUBMIT` 等分渠道变量，而非方案所写的单一 `PUBLISH_CONFIRM_SUBMIT=YES` 环境变量；语义等价。
7. 任务输出经 producer 侧 `job.append()` 泵入环形缓冲（250ms 轮询 runner stdout），脱敏后入环；未启用 subprocess spill 文件，第二份未脱敏全量输出不存在。
8. `userQuestions` approval intent 的 approve/reject 标签必须出现在该问题 options 中（实现已满足）。
9. `dsh bundle` patch 中增加 `platforms: [darwin]` 声明。

## 开发

```bash
pnpm install
npx tsc --noEmit   # 类型检查
npx vitest run     # 30 个测试：配置校验/请求策略/命令构造/脱敏/runner 集成/dotenv 隔离
npx tsdown         # 构建 lib/
```

人工发布验收（对照真实商店测试账号）尚未执行，见实施方案 §21 清单。
