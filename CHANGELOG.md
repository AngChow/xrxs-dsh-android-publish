# Changelog

## 0.1.1

### 兼容性

- 审批意图由 `kind: 'approval'` 改为 `kind: 'plan-review'`，使同一份源码同时兼容
  DSH `0.2.1-rc.5` 与 `0.2.2-alpha.2`。`kind: 'approval'` 自 `0.2.2` 才引入，
  此前仓库无法在 `0.2.1-rc.5` 上通过类型检查。
- `engines.dsh` 放宽为 `>=0.2.1-rc.5 <0.3.0`。
- `devDependencies` 中的 `@deepseek-ai/*` 对齐到 `0.2.1-rc.5`（类型检查以最低支持版本为准）。
- 裁决逻辑保持 fail-closed：除批准标签外的任何结果（含未选择）都视为拒绝。

### 仓库

- 新增 GitHub Actions CI：`typecheck` + `test` + `build`。
- CI 增加产物校验：`@deepseek-ai/*` 不得出现在 `dependencies` 中。
  这类包必须由宿主提供；一旦被复制进 profile 的 `node_modules`，
  `TOOL_RUNTIME_SCHEDULER` Symbol 会出现两份，导致所有工具调用失败。
- 补充 `repository` / `bugs` / `keywords` 元数据。
- `.gitignore` 补充 `.DS_Store`、`*.log`、`coverage/`。

## 0.1.0

首个可用版本。
