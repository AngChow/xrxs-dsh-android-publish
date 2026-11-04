# Changelog

## 0.2.1

放宽 DSH 版本下界（无需任何新版本特性，纯声明与一处类型补全）：

- `engines.dsh` 由 `>=0.2.1-rc.5 <0.3.0` 改为 `>=0.2.0-rc.1 <0.3.0-0`，覆盖整个 `0.2.x` 线。
  宿主用 `semver.satisfies(version, range, { includePrerelease: true })` 判定（见
  `@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility`），因此旧的 `>=0.2.1-rc.5`
  会把 `0.2.1-rc.1`～`0.2.1-rc.4`、`0.2.0-rc.1`/`rc.2` 这些已发布版本一律判为不兼容。
- 上界改为 `<0.3.0-0`：`includePrerelease` 下 `<0.3.0` 会放行 `0.3.0-rc.1`，与「未验证 0.3」矛盾。
- `peerDependencies` 同步放宽到 `>=0.2.0-rc.1 <0.3.0-0`，`@deepseek-ai/cordis` 降到 `>=4.0.4`
  （`0.2.0-rc.1`/`rc.2` 配套 4.0.4，`0.2.1-rc.x` 配套 4.0.5），`@deepseek-ai/schemastery` 降到 `>=3.18.4`。
- `src/index.ts` 补 `import '@deepseek-ai/dsh-system-prompt'`：`ctx.systemPrompt` 的 Context 声明来自
  该包的模块增强，旧版 `dsh-tools` 不再间接引入它，缺这行时 `0.2.0-rc.1`/`rc.2` 下 `tsc` 报
  `Property 'systemPrompt' does not exist on type 'Context'`。
- `devDependencies` 下移到最低支持版本，CI 的类型检查即等价于下界回归。
- 无行为变更：`defineTool`（`presentCall` / `output.presentationMeta` / `exec.signal`）、
  `ctx.jobs`、`ctx.credentials`、`ctx.userQuestions.ask` 的 `plan-review` 意图、`ctx.subprocess.spawn`、
  `tool.call.toolview` 槽位与 `block.meta` 在 `0.2.0-rc.1` 都已存在，接口形状一致。

## 0.2.0

发布卡片与审批体验升级（Host 半身重做 + 新增 Web 客户端半身）：

- 新增客户端半身：`package.json` 声明 `dsh.client`（`platform: web`）与 `./client` 导出；
  `lib/client.js` 由 `scripts/build-client.mjs`（esbuild）生成，为 5 个工具各注册一个
  `tool.call.toolview` 视图。
- 卡片数据改走 `output.presentationMeta` 的结构化 meta 通道（客户端读 `block.meta`）；
  模型可见文本由 `renderCardText()` 生成，不再回显整段 JSON。
- 修复审批卡片与审计/任务使用不同 planId 的问题：`planId` 只生成一次，贯穿审批卡片、
  `approval_denied`、`start` 审计与任务标签。
- 修复在审批卡片上取消/关闭时抛 `ASK_CANCELLED` 的问题：现在返回
  `{ ok: true, approved: false, reason: 'user_cancelled' }` 并写 `approval_denied` 审计，
  不启动任何任务。
- 审批卡片标题改为人类可读（`# 生产提审：<应用> → <渠道>`），不再以「方案 ID: ap-…」开头。
- `android_publish_status` 解析 `@@ANDROID_PUBLISH_PROGRESS/RESULT@@` 标记，卡片展示当前步骤、
  分渠道结果与输出尾部；后台任务标签包含模式、应用与目标渠道。
- 新增测试：客户端 bundle 加载与 5 个视图注册、卡片文本、标记解析、工具契约。

## 0.1.3

修复插件页仍显示英文包名的问题，**无任何行为变更**：

- `package.json` 补上 `"./locale/*.json"` 导出。0.1.2 加入的 `locale/zh.json` 因未出现在
  `exports` 中，宿主读不到 `meta.title`，插件页一直回退到包名 `xrxs-dsh-android-publish`；
  现在按 DSH 语言显示「安卓应用提审（五商店）」。
- 新增 `"./icon"` 导出与 `icon.svg`（Android 绿底：包裹 + 上传箭头 + 审批勾），
  便于和「鸿蒙应用提审 (AGC)」在插件页用颜色区分。
- `types` 及 `.` 导出的 types 由不存在的 `lib/types/index.d.ts` 改为实际产物 `lib/index.d.ts`。

## 0.1.2

用户可见文案中文化，**无任何行为变更**：

- 新增 `locale/zh.json`、`locale/en.json`（`meta.title` / `meta.description`），
  插件页按 DSH 当前语言显示中文标题与描述。
- 5 个工具的描述与参数说明改为中文（工具名、参数名、枚举值保持不变）。
- `doctor` / `plan` 输出的问题与警告文案改为中文。
- `systemPrompt` 段落改用中文表述。
- 底层校验报错（`config.ts` / `request.ts`）暂保留英文，因其被测试以正则断言。

## 0.1.1

### 兼容性

- 审批意图由 `kind: 'approval'` 改为 `kind: 'plan-review'`，使同一份源码同时兼容
  DSH `0.2.1-rc.5` 与 `0.2.2-alpha.2`。`kind: 'approval'` 自 `0.2.2` 才引入，
  此前仓库无法在 `0.2.1-rc.5` 上通过类型检查。
- `engines.dsh` 放宽为 `>=0.2.1-rc.5 <0.3.0`。
- `devDependencies` 中的 `@deepseek-ai/*` 对齐到 `0.2.1-rc.5`（类型检查以最低支持版本为准）。
- 裁决逻辑保持 fail-closed：除批准标签外的任何结果（含未选择）都视为拒绝。

### 仓库

- **32MB 的 Bugly 工具 jar 移出仓库与产物**：改由
  [`tools-v1` Release](https://github.com/AngChow/xrxs-dsh-android-publish/releases/tag/tools-v1)
  托管，`upload_bugly_symbol.py` 首次使用时下载并校验 SHA256。产物从 ~30MB 降到 200KB 以内；
  `.gitignore` 排除该 jar，`files` 白名单不再包含 `resources/tools/`。
- 新增 GitHub Actions CI：`typecheck` + `test` + `build`。
- CI 增加产物校验：`@deepseek-ai/*` 不得出现在 `dependencies` 中。
  这类包必须由宿主提供；一旦被复制进 profile 的 `node_modules`，
  `TOOL_RUNTIME_SCHEDULER` Symbol 会出现两份，导致所有工具调用失败。
- 补充 `repository` / `bugs` / `keywords` 元数据。
- `.gitignore` 补充 `.DS_Store`、`*.log`、`coverage/`。

## 0.1.0

首个可用版本。
