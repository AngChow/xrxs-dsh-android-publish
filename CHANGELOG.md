# Changelog

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
