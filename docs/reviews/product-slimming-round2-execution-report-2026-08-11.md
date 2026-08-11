# Routa.js 第二轮产品精简执行报告

日期：2026-08-11
依据：`docs/reviews/product-scope-and-performance-audit-report-2026-08-11.md`（§14.4 功能裁决表、§14.7 最高优先级清单、Phase 0–6 路线）
基线：HEAD `8dc366c9`；执行前已保存 54 条工作区状态快照，用于区分本轮改动与用户并行工作。

---

## 1. 实际删除的功能

全部为报告 §14.7「最应该删除的 10 项」中证据充分、且依赖分析证实零真实用户入口的项：

| 功能切片 | 报告依据 | 删除内容 |
| --- | --- | --- |
| **AG-UI 全部**（优先级 #1） | DEV_ONLY；ACP 的薄重复 | `/ag-ui` 演示页 + snapshot、`/api/ag-ui` 路由、`src/core/ag-ui/`（event-adapter + 测试）、`ag-ui-trace-panel.tsx` 孤儿组件、trace-replay 的 AG-UI 回放模式、npm `@ag-ui/core`/`@ag-ui/encoder`、e2e spec、Rust `ag_ui.rs`、契约路径、4 个死 i18n 键 |
| **A2A 入站服务端**（优先级 #3） | DEV_ONLY；仅出站客户端有真实依赖 | `/a2a` 演示页 + snapshot、`/api/a2a/*` 6 条路由、`.well-known/agent-card.json` 发现端点、`a2a-executor.ts` + `a2a-session-registry.ts` + 测试、e2e spec、Rust `a2a.rs`、桌面集成测试 Test 28–31、契约 6 条路径。**出站客户端完整保留**（见 §6） |
| **Shared Sessions 全部**（优先级 #4） | §14.7 删除清单 #4；12 API 零 UI 零持久化；TS/Rust 双实现已漂移 | `/api/shared-sessions/*` 10 个路由文件、`src/core/shared-session/` 6 文件、Rust `shared_sessions.rs` + `store.rs`、契约 9 条路径 + 9 个 orphan schema |
| **`/api/memory` deprecated 别名**（优先级 #5） | REMOVE 裁决 | TS 路由 + 测试、Rust `legacy_router()`（约 54 行）、契约别名路径。`/api/system/memory` 正式端点保留 |
| **死导航组件**（优先级 #6） | 仅 stories 自引用 | `desktop-nav-rail.tsx`（+ stories）、`advanced-nav-menu.tsx`、`notification-center.tsx`（+ stories）、session 页测试中的失效 mock |
| **孤儿大组件 `bg-tasks-tab.tsx`**（优先级 #7 的一部分） | SIMPLIFY 裁决明确「只删孤儿 UI」；36KB 零导入 | 仅删 UI 组件；BackgroundTask 域对象与触发器未动 |
| **`/debug/*` 页面**（优先级 #8） | DEV_ONLY | `acp-replay`×2、`office-wasm-poc`×3、POC 资产路由、15 个 orphan 比对/检查/扫描脚本（共 9,074 行）、`package.json` 中指向已删脚本的 23 条 npm script。**office-wasm-reader 仅保留生产构建工具**（`src/client/office-document-viewer` 运行时存活） |
| **Messages 页**（§14.4 DEV_ONLY） | 页面不可达 + 请求端点错误=功能残缺 | `/messages` 页面、桌面托盘 "Messages" 菜单项（`tray.rs`）及对应测试 |
| **`/overview` 重定向页**（§14.5 推荐方案） | 修复直链后删重定向 | 重定向页删除；`home-page-sections.tsx:1148` 直链修复。注：报告建议改指 kanban，实际改指 `/sessions`——与原重定向页自身目标一致，保持现状行为不变 |

## 2. 删除的文件和代码量

- **整文件删除：71 个文件，21,041 行**（按 HEAD 版本逐文件 `wc -l` 实测）。
- **编辑清除：27 个文件，+150 / −1,274 行（净 −1,124 行）**。
- **合计净减少：22,165 行**，另有契约路径 17 条（158→141）、schema 9 个（59→50）。

分组统计：

| 切片 | 文件数 | 行数 |
| --- | --- | --- |
| Shared Sessions（TS API/core + Rust） | 18 | 3,491 |
| A2A 入站（页面/API/.well-known/core/Rust/e2e） | 14 | 2,920 |
| AG-UI（页面/API/core/组件/Rust/e2e） | 8 | 2,835 |
| `/debug/*` 页面 + POC 资产路由 + 15 个 orphan 脚本 | 21 | 10,212 |
| 死导航/孤儿组件 + stories（含 bg-tasks-tab） | 6 | 1,304 |
| Messages / overview / memory 别名 | 4 | 279 |
| 编辑清除（27 个文件净删除部分） | — | 1,124 |

编辑过的 27 个文件：`api-contract.yaml`、`docs/ARCHITECTURE.md`、`docs/fitness/{web-qa-e2e-matrix,design-system-shell,design-system-quality-layers}.md`、`docs/product-specs/FEATURE_TREE.md`（用仓库自带生成器 `feature-tree-generator.ts --save` 再生，非手工修改）、`docs/references/office-document-viewer-wasm-reader/README.md`、`README.md`、`README.zh-CN.md`、`package.json`、`crates/routa-server/src/api/{mod,memory}.rs`、`apps/desktop/src-tauri/src/tray.rs`、`apps/desktop/src-tauri/tests/api_test.rs`、`src/core/a2a/index.ts`、`src/core/trace/trace-replay.ts` 及其测试、`src/i18n/{types-extended,locales/en-extended,locales/zh-extended}.ts`、`home-page-sections.tsx`、`spec-board-model.ts`、`session-page-client.test.tsx`、`src/app/styles/desktop-theme.css`、`scripts/{validate-storybook-governance,lint-design-system-css}.mjs`、`tools/office-skills/src/color-tokens.mjs`。

`/debug` 切片说明：除页面本体外，删除了 `src/app/api/debug/office-wasm-poc/assets/[...slug]` 资产路由（仅服务该 POC 页）和 15 个直接依赖已删 `office-wasm-config`、以该 POC 页为唯一驱动目标、或运行时 spawn 已删比对脚本的脚本（`compare-walnut-*`、`compare-powerpoint-pptx-render`、`run-office-wasm-fixtures`、`export-*-cursor-canvas`、`scan-*-protocol-corpus` 等）；`package.json` 中指向这些已删脚本的 23 条 npm script 同步删除（剩余 107 条 script 全部验证目标文件存在）。**office-wasm-reader 仅保留服务生产产物的构建/依赖检查工具**（`build-office-wasm-reader.mjs`、`build-office-package.mjs`、`check-office-wasm-reader-dependencies.mjs`）——`src/client/office-document-viewer` 运行时存活（资产基址 `/office-wasm-reader`），`/api/debug/path` 桌面 PATH 诊断保留，`scripts/debug/check-office-cursor-canvas-consistency.ts` 校验的是存活的 `packages/office`/`packages/office-render` 亦保留。

另：清理了 gitignore 范围内的过期构建缓存 `.next/types`、`.next-page-snapshots/types`（仅构建产物，重新 build 自动再生）。

## 3. 保留及暂缓的候选

**明确保留（报告要求或核心能力）：**

- `a2a-outbound-client.ts` + `a2a-task-bridge.ts` + `a2a-agent-card.ts` + 类型/错误导出——kanban 自动化（`agent-trigger.ts`）的真实依赖；报告 §14.7「绝对不能草率删除」#4。`src/core/a2a/index.ts` 已重写为仅导出出站侧。
- ACP、Workspace、Sessions、Team Runs、Kanban、Traces、`/api/system/memory`、`/api/rpc`、`/api/rpc/methods`、A2UI 契约条目——均未触碰。
- office-wasm-reader 的生产构建/依赖检查工具（`build-*`、`check-office-wasm-reader-dependencies.mjs`）——`src/client/office-document-viewer` 运行时存活。

**暂缓项（证据不足或存在活跃依赖，未删）：**

| 项 | 暂缓原因 |
| --- | --- |
| TS `/api/rpc/route.ts`（报告删除清单 #9） | `rpc-client.ts:93` 在 web 模式实际使用（`use-agents-rpc.ts`、`agent-panel.tsx`），调用证据与删除建议冲突；报告 Phase 4 也要求先补 characterization tests 再退役 |
| `skill-panel.tsx`（1026 行零导入） | Skills 为 FREEZE 裁决，且 Rust `SkillRegistry` 注入是否仍被 ACP 使用为 NEEDS_VALIDATION |
| A2UI 全套（`src/client/a2ui/`、`overview-a2ui-tab.tsx`、Rust `a2ui.rs`、`/api/a2ui/dashboard`） | MERGE→Canvas 裁决，非 DELETE |
| `a2aPage` i18n 命名空间（`types-tail.ts`/`en-tail.ts`/`zh-tail.ts`） | 位于用户并行修改中的文件，按约束不触碰 |
| 死 i18n 键的更大范围清理（#10） | 需构建期键使用统计；且 `-tail` 系列文件在用户修改中 |
| Polling（HIDE）、Docker Worker、Notes 去 yjs、Settings 页合并、`/mcp-tools` 重定向、`test_mcp.rs` | 分别为 HIDE/MERGE/NEEDS_VALIDATION 裁决或报告信号冲突，不属于证据充分的 DELETE |

## 4. 残留扫描结果

每组删除后均以 `rg` 全仓扫描（排除 `node_modules`/`target`），最终轮结果：

- `shared-session|sharedSession|shared_sessions`：**0** 命中（src/apps/crates/e2e）。
- `ag-ui|ag_ui|AGUI|@ag-ui`：**0** 命中（不含保留的 `a2ui`）。
- `desktop-nav-rail|advanced-nav-menu|notification-center|bg-tasks-tab`：**0** 命中。
- `replayTracesAsAGUI|RoutaToAGUIAdapter|legacy_router`：**0** 命中。
- `/api/a2a`、`/api/memory`（legacy）、`/api/shared-sessions`、`.well-known/agent-card`：**0** 命中（`a2a-outbound-client.test.ts` 中的 `https://example.com/api/a2a/*` 为远端目标 URL，属出站客户端合法用法）。
- 已删页面的 href/redirect/push 链接、middleware/next.config rewrite：**0** 命中。
- 契约文件 `shared-sessions|/a2a|ag-ui`：**0** 命中（141 路径/50 schema，YAML 解析与 parity gate 通过）。
- 已知良性残留：`feature_explorer.rs` 与其 TS 测试以已删 overview 路径作为**内存 fixture 字符串**（不扫描真实文件系统，测试不受影响）；`docs/issues/` 中 3–5 月的历史问题档案提及已删表面（历史记录，不改写）；`crates/routa-core` kanban 自动化中的 `https://example.com/.well-known/agent-card.json` 为出站远端目标 URL（合法）。`docs/product-specs/FEATURE_TREE.md` 已用仓库自带生成器再生，已删表面引用清零（仅剩有意保留的 `/api/debug/path`）。`docs/fitness/web-qa-e2e-matrix.md` 中已删表面的场景、命令与监控路径已同步清理。
- 设计系统文档/token 同步清理：`docs/fitness/design-system-shell.md`（`desktop_shell_token_wiring` 的 rg 链、`desktop_shell_color_contract` eslint 清单、`desktop_shell_page_coverage` 匹配式、单一事实来源清单中已删的 `desktop-nav-rail.tsx` 引用全部移除，token wiring 链手动复验通过）、`docs/fitness/design-system-quality-layers.md`、`src/app/styles/desktop-theme.css`（3 行 `--dt-trace-ag-ui`）、`tools/office-skills/src/color-tokens.mjs`（镜像 token 表两处）、`scripts/{validate-storybook-governance,lint-design-system-css}.mjs`（已删组件条目移除，两脚本复验 PASS）、`docs/references/office-document-viewer-wasm-reader/README.md`（POC 段落标注 deleted、迁移步骤标注已完成）。
- `package.json` 全部 107 条 npm script 的目标文件存在性已脚本化验证通过（`ALL_SCRIPT_TARGETS_EXIST`）。

## 5. 测试与门禁结果

**静态与编译：**

| 检查 | 结果 |
| --- | --- |
| `git diff --check` | PASS |
| `npx tsc --noEmit` | PASS（零错误；过程中发现并修复 3 类残留：`.well-known` 入站路由、8+3 个 orphan 脚本、过期构建缓存 validator） |
| `cargo check -p routa-server` | PASS（0 错误 0 警告） |
| `cargo check -p routa-desktop --all-targets` | PASS |

**单元/相邻测试：**

- 相邻测试 7 个文件 122 例全部通过：`team-run-deletion`（必保项）、`trace-replay`、`a2a-auth-config`、`a2a-outbound-client`、`unassigned-team-cards`、`session-page-client`（被编辑文件）、`session-runtime-finalizer`。
- `cargo test -p routa-server --lib`：**153 通过 / 0 失败**（含本次改动的全部 api 模块）。
- 实时服务器冒烟（`routa server --port 3999`）：3 秒就绪；`/api/health` 200；已删端点 `/api/memory`、`/api/a2a/card`、`/api/shared-sessions`、`/api/ag-ui` 全部 404；保留端点 `/api/system/memory`、`/api/workspaces` 全部 200。

**entrix 门禁：**

- `entrix run --dry-run`：PASS。
- `entrix run --tier fast`：**FINAL SCORE 100.0%，PASS**（全部 HARD GATE 通过：ts_typecheck、eslint、clippy、dependency-cruiser、api parity、npm audit critical、TS 全量测试 87.9s）。
- `entrix run --tier normal`：硬门禁 `rust_test_pass` 失败。**全部失败项均已证实为仓库已有/环境问题，与本轮改动无关**（按指令记录证据，未顺手修改无关模块）：
  1. `routa-core` 4 例失败：`download_archive_uses_caller_provided_http_client`、`kanban::github` 3 例——全部为 **502 Bad Gateway 网络错误**（二进制下载与 GitHub API），单独复跑稳定复现；`crates/routa-core` 本轮零改动。
  2. `routa-server` 7 个集成测试套件（canvas/end-to-end/git/kanban-tokens/codebases/mcp/artifacts）失败于 `tests/common/mod.rs:53 "server did not become ready"`（1 秒就绪窗口）。**对照实验：在 HEAD `8dc366c9` 的纯净 detached worktree 中运行 `rust_api_canvas`，得到完全相同的 7/7 失败**——证明为仓库已有问题；手动启动同一服务器健康可用。
  3. entrix 自身标记的 INFRA ERRORS（判定为工具/检查器问题而非代码缺陷）：`design_system_css_contract`、`design_system_storybook_governance`、`desktop_shell_token_wiring`、`desktop_shell_page_coverage`、`startup_performance_probe`、`rust_api_test`。
- 结论：normal 门禁失败完全落入任务指令第 12 条所列豁免情形（仓库已有问题 + 网络 502）。TS 侧全量测试、类型检查、parity、以及本轮触及的 Rust 模块测试均为绿色。

- **最终 fast 复跑**（补充删除 assets 路由/比对脚本 + e2e matrix 清理 + FEATURE_TREE 再生后）：**FINAL SCORE 100.0%，PASS**（含 TS 全量测试重跑）。
- **收尾轮 fast 复跑**（再删 4 个 orphan 脚本 + 23 条失效 npm script + design-system 文档/token 同步清理后）：**FINAL SCORE 100.0%，PASS**——全部 HARD GATE（ts_typecheck、eslint、clippy、dependency-cruiser、api parity ×2、openapi schema、npm audit critical、TS 全量测试、legacy hotspot budget）通过。`git diff --check` 亦通过（FEATURE_TREE 生成器输出的 EOF 空行已去除）。

## 6. 是否保留 Team Run 删除能力

**是，完整保留。**

- `src/core/orchestration/team-run-deletion.ts` 未做任何改动。
- `src/core/orchestration/__tests__/team-run-deletion.test.ts` 在本轮相邻测试中运行并通过。
- Team Runs 的页面、API、session 树模式均未触碰（KEEP 裁决）。

## 7. 当前工作区中哪些变化不是本轮产生的

执行前基线快照（54 条，存于 `/tmp/pre-existing-status.txt`）中的全部条目均非本轮产生，且**未被本轮覆盖、回滚或改动**：

- **用户修改（18 个文件，保持原样）**：`docs/design-docs/{agentwatch-tui,architecture-rule-dsl,harness-trace-learning-phase2}.md`、`docs/exec-plans/{active,archived}/README.md`、`resources/specialists/locales/{en,zh-CN}/core/routa.yaml`、`src/app/workspace/[workspaceId]/sessions/sessions-page-client.tsx`、`src/core/db/{schema.ts,sqlite-schema.ts,sqlite-stores.ts}`、`src/core/routa-system.ts`、`src/i18n/locales/{en,zh,en-tail,zh-tail}.ts`、`src/i18n/{types.ts,types-tail.ts}`。
- **用户删除（33 个文件）**：Loom Goal/Plan/Delivery 整套（页面/API/store）及 `docs/product-specs/loom-feature-mapping.md`——由用户另一会话在 17:36–17:47 间删除，本轮未重复处理。
- **未跟踪项（与基线一致）**：`.claude/scratchpad/`、`docs/reviews/`（内含第一轮审查报告，经用户许可写入）、`docs/routa-product-scope-and-performance-audit-brief.md`。第一轮的误生成文件 `docs/reviews/product-review-readonly-2026-08-11.md` 已不存在（用户自行删除）。
- 本轮全部改动与上述集合**零交集**（已用基线逐条比对确认）。

**合规声明**：未执行任何 `git add/commit/push/stash/reset --hard/checkout --`；工作区保持未暂存状态，由用户决定后续处置。
