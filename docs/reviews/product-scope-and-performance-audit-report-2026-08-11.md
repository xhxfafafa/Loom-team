# Routa.js 产品范围、架构复杂度与性能精简审查报告

**审查日期**：2026-08-11
**审查方式**：只读审查。8 个并行专项子审查（产品功能 / 扩展功能与 Loom / 前端性能 / 协议栈 / 自动化模型 / 双后端与存储 / 领域模型 / 导航设置）+ 对任务书 §4 必读材料与 §5 规模线索的亲自验证。
**约束遵守**：未修改、创建、删除任何仓库文件；未运行任何 build/dev/test/迁移命令；未读取 `.env`、凭据或数据库内容。
**事故披露（必须告知）**：子审查 A1 在运行中意外创建了 `docs/reviews/product-review-readonly-2026-08-11.md`（约 30KB）。因任务书 §3 禁止删除文件，**请产品负责人/仓库所有者自行删除该文件及其目录**（`git status` 中显示为未跟踪的 `docs/reviews/`）。本报告内容不受该文件影响。

---

## 14.1 执行摘要

**最重要的 5 个结论：**

1. **Routa 的真实核心很小，产品面却很大。** 有完整调用链证据的核心只有一条路径：Workspace → Kanban → 列切换触发 ACP Session（lane automation）→ 证据/评审 → Done。围绕这条路径，仓库承载了约 29 个功能域、8 种协议、3 种存储引擎、2 套完整后端，其中约三分之一缺乏生产使用证据（§14.2、§14.4）。
2. **页面慢的首要原因不是仓库规模，而是前端零代码分割。** `src/` 中 `next/dynamic` 使用量为 **0**（实测验证）；Tiptap（约 7.1MB 依赖）与 highlight.js/lowlight 全语言包（约 9.1MB）被 `tiptap-input.tsx`、`markdown-viewer.tsx` 静态导入进入核心页面；同时不存在 `src/app/workspace/[workspaceId]/layout.tsx`（实测确认缺失），每次页面切换重新挂载 Header/Sidebar/Provider，且 17+ 页面各自重复调用 `useWorkspaces()`。
3. **最大的架构重复是 38 个业务域在 TypeScript 与 Rust 中手写双实现**（无代码生成），且已发生可证实的语义漂移（Notes 局部更新 vs 整体覆盖；Sessions 缺失 8+ 生命周期字段；Tasks 约 460 行 kanban workflow 逻辑仅存在于 TS 侧）。约 4,185 行的 API parity 工具链只校验"两端都有该路由"，不校验行为一致，反而把双后端固化成了永久约束。
4. **协议栈过度投资。** REST、SSE、ACP、MCP、A2A、AG-UI、A2UI、JSON-RPC（Rust 46 方法 + TS 5 方法）中，有真实用户的只有 REST + SSE + ACP + MCP（+ 桌面 Rust JSON-RPC）。A2A 服务端除 kanban 出站客户端外零调用；AG-UI 只是 ACP 的薄适配；A2UI 已死（唯一 UI 是 21KB 孤儿组件）；Shared Sessions 有 12 个 API、零 UI、零持久化。
5. **Goal/Plan/Delivery 与全部 Loom 文档是一次未经确认的方向实验。** 它们与 Loom 设计文档同属单个提交 `d2b4d4dd`（2026-08-09，"feat(loom): add delivery planning and team-run deletion"），**没有任何数据库迁移、没有 Rust 对应实现**，`/delivery` 页面无任何入站链接。按任务书 §2，Loom 文档不得视为产品战略；这些功能应冻结待产品负责人确认，而不是继续开发。

**最大的产品范围问题**：自动化与协议面。Schedule/Webhook/Polling 三种触发器最终都只是创建 BackgroundTask → 5 秒轮询 Worker → ACP Session，与 Kanban lane automation 职责重叠；A2A/AG-UI/A2UI/Shared Sessions 四套协议无真实用户。

**最大的页面性能问题**：零代码分割 + 无 workspace 共享布局。二者叠加导致每个核心页面都携带全站量级的编辑器/高亮依赖，且每次路由切换整体重新挂载并重发 workspace 请求。

**最大的架构重复问题**：38 域双后端手写重复 × 3 存储引擎 × 3 份 schema 副本（`src/core/db/schema.ts` 672 行 / `src/core/db/sqlite.ts` 611 行 / `crates/routa-core/src/db/mod.rs` 451 行），由 parity gate 强制维持。

**推荐精简幅度：40%–60%（推荐方案，§14.5）。** 保守方案（约 20%）只能隐藏入口、不解决根因；激进方案会伤及尚未验证但结构健康的 Team Runs/Notes/Canvas。

---

## 14.2 当前产品事实

**Routa 当前实际解决的问题**：把多 Agent 软件开发的状态（任务、会话、痕迹、证据、评审）从单条聊天线程中解放出来，放到看板上显式协调。README 的自我描述（workspace-first multi-agent coordination platform）与实际代码一致：每个 Kanban 列绑定一个 specialist prompt 契约，卡片在列间流动时被 progressively stricter 的专家处理（Backlog Refiner → Todo Orchestrator → Dev Crafter → Review Guard → Done Reporter，资源在 `resources/specialists/workflows/kanban/*.yaml`，共 147 个 specialist YAML 实测计数）。

**主要用户**：无真实用户数据可用（标记 `NEEDS_VALIDATION`）。代码证据显示两类使用者：(a) 开发者自用（本地 SQLite，`routa.db` 实测约 816MB，说明重度真实使用）；(b) 桌面端用户（Tauri 发布包，README Quick Start 以 Desktop 为首选）。Postgres/Neon 路径存在（`src/core/db/index.ts:109-113` 检测 `neon.tech`），但无证据表明存在公开的多租户云部署。

**真实核心路径（有完整调用证据）**：
`/`（home，创建/选择 workspace）→ `/workspace/:id/kanban`（HomeInput 或卡片创建）→ 卡片拖入列 → `COLUMN_TRANSITION` 事件 → `KanbanWorkflowOrchestrator` → `createAutomationSession` → `POST /api/acp`（`src/app/api/acp/acp-session-create.ts`）→ ACP 进程执行 → 证据/verdict 写回卡片 → Review Guard → Done。这是唯一一条从 UI 触发到 Agent 执行、证据、评审全部闭环的路径。

**当前定位冲突**：

- 是"多 Agent 协调平台"（README）还是"交付工作台"（`docs/exec-plans/active/loom-v1-delivery.md` 第 9 行明确写"产品正在从通用多 Agent 协调平台重新聚焦为聚焦的交付工作台"）？后者是近期方向提案，未经产品负责人确认。
- 是 Web 产品还是桌面产品？桌面端 100% 走 Rust 后端（`127.0.0.1:3210` 或 Tauri IPC `rpc_call`），Web 端 100% 走 Next.js API——同一个前端代码库通过 `desktopAwareFetch`（约 250 个调用点、46 个文件）分裂成两种运行时语义。

**Routa 与 Loom 命名及方向冲突**：`docs/design-docs/loom-v1-scope.md`、`docs/exec-plans/active/loom-v1-delivery.md`、Goal/Plan/Delivery 三个页面域、`/api/goals`、`/api/plans`、`/api/delivery` 全部来自单个提交 `d2b4d4dd`（2026-08-09）。它们：无 DB 迁移文件（`product_goals`、`dev_plans` 两表在数据库盘点中确认**没有任何迁移文件**）、无 Rust 实现、F2 Plan 功能自述"not yet started"。按任务书 §2 与 §15，这些文档的自我标记状态不等于产品负责人确认，本审查将其整体视为**待审实验**，裁决 FREEZE。

---

## 14.3 性能根因

### 1) 开发启动慢

- **编译图过大**：`src/app/api` 实测 197 个 route 文件，`src/core` 实测 527 个文件，`src/` 内 194 个 `use client` 组件。`preloadEntriesOnStart: false`（`next.config.ts`）的注释自述：以更慢的首次页面响应换取较低内存——即启动问题已知且被主动选择了"慢启动"一侧。
- **开发缓存失控**：`.next` 实测 13GB，其中 `.next/dev/cache/turbopack` 约 12GB；项目自身告警阈值为 2GiB（`README.md` "Quick Start" 与 `npm run dev:diagnose`）。`target/` 实测 55GB。合计约 68GB 构建产物同时存在于工作磁盘上，直接影响文件监听与磁盘 IO。
- **服务器初始化负载**：`getRoutaSystem()`（`src/core/routa-system.ts:390-422`）在首个请求时初始化 14 个 store + workflow orchestrator 单例 + file-change bridge；Postgres 模式下 workflow runs 仍是内存 store（`routa-system.ts:164-165` 的 `// TODO: Implement PgWorkflowRunStore`）。

### 2) 路由首次编译慢

- 每个 workspace 页面独立编译各自的 data-fetching 与全套静态依赖；无 `src/app/workspace/[workspaceId]/layout.tsx`（实测确认不存在），意味着没有可共享的编译/运行单元。
- Tiptap 全家桶与 `lowlight` 全语言包被静态导入（`tiptap-input.tsx`、`markdown-viewer.tsx`），任何导入它们的页面首次编译都要吞下这条巨型依赖链。
- `serverExternalPackages`（`next.config.ts`）列了 MCP/ACP/Claude SDK、ws、better-sqlite3、yjs——这些是必要排除，但也说明服务端依赖面极宽。

### 3) 已编译页面之间的热切换慢

这是用户抱怨最直接的类别，根因按影响排序：

1. **无共享 workspace layout** → 每次 `/workspace/:id/*` 内部切换，Sidebar、Header、Provider 全部卸载重挂载，组件状态丢失。
2. **重复 workspace 请求**：Sessions、Kanban、Team、Plan、Delivery 等 17+ 页面各自调用 `useWorkspaces()`，无共享 SWR cache key / layout 级缓存（任务书 §5 已指出，专项 B 逐页证实）。
3. **零代码分割**：`next/dynamic` 在 `src/` 中命中数为 **0**（实测）。首屏不显示的 Modal/Drawer/Tab/Panel（SettingsPanel、KanbanFitnessWorkbenchModal 等）与重型编辑器全部同步进入初始 chunk，解析/执行成本摊在每次页面进入上。
4. **Kanban 首屏非必要加载**：挂载时加载 board、tasks、sessions、specialists、codebases 并触发 ACP warmup（任务书 §5；专项 B 证实 codebases/changes 与 specialists 对首屏渲染非必需）。
5. **死导航组件仍被打包**：`desktop-nav-rail.tsx`（3.2KB）、`advanced-nav-menu.tsx`（5.3KB）实测存在；`notification-center.tsx` 只被自己的 stories 文件引用（实测确认无生产挂载点）。

### 4) API 响应慢

- **双后端分裂**：桌面端所有请求经 Rust（快路径），Web 端经 Next.js route handler；两者行为不一致（见 §14.5 证据），无法用一套 profiling 覆盖。
- **5 秒轮询模型**：所有 BackgroundTask 类自动化（Schedule/Webhook/Polling 触发）最终经 `BackgroundTaskWorker` 5 秒轮询拾取（专项 D），即自动化响应延迟下限为 0–5 秒，且轮询本身是常态空转。
- **trace 域实测差异**（专项 E）：Rust 侧 `FileTraceWriter` 用 `tokio::fs` + `BufWriter` 批量写，TS 侧逐条写——同一能力两端性能特征不同。
- Workflow runs 永远在内存（`routa-system.ts:165, 243`），重启丢失且不可横向观察。

### 5) JavaScript 下载、解析与执行慢 / hydration 慢

- **静态导入的巨型依赖**（专项 B 的 bundle 分析）：Tiptap 约 7.1MB、highlight.js/lowlight `all` 约 9.1MB 的依赖树进入核心页面 chunk；Recharts（Harness 图表）、Mermaid、xterm、dnd-kit、@xyflow/react、react-complex-tree 各自进入其所在页面的首屏导入，无一用 `next/dynamic` 延迟。
- **i18n 全词典进每个页面**：根布局 `I18nProvider` 静态导入完整词典，`src/i18n/locales/` 实测 6 个文件共约 300KB 源码（en.ts 62KB + en-extended.ts 69KB + en-tail.ts 20KB + zh 三件套对应），其中 `-extended` 与 `-tail` 大量键对应已删除/未挂载 UI（专项 B 判定为死词典，`NEEDS_VALIDATION`：精确死键比例需构建期统计）。
- **hydration 面**：194 个 `use client` 组件；28 个文件超过 1000 行（最大 `kanban-tab.tsx` 2232 行），巨型单文件组件的挂载成本集中在 Kanban 首帧。

### 6) 桌面 Rust 后端启动或响应慢

- Rust 后端本身不是瓶颈（Axum + SQLite 本地路径短）；问题在**规模与维护**：`target/` 55GB 编译产物、静态导出 fallback 逻辑（`crates/routa-server/src/lib.rs` 的 `resolve_static_target()` 约 135 行 + 11 个测试）把 `__placeholder__` URL 映射逻辑分散在 Rust（1 处）、构建脚本（`scripts/build/build-static.mjs` 目录改名技巧）、14 个页面的 `generateStaticParams()`、11+ 个客户端组件的运行时检测（专项 E Q9）——四处联动，任何一处漂移都表现为桌面端页面 404 或参数丢失。
- 桌面端真正必须 Rust 的能力约 23 项（进程管理、PTY、ACP 运行时、文件系统、git2、对话框、Docker sandbox CLI——专项 E），其余 Tauri command 是业务 CRUD 的重复封装。

---

## 14.4 功能裁决表

| 功能 | 裁决 | 信心 | 用户依据 | 性能影响 | 技术影响 | 删除依赖 |
| --- | --- | --- | --- | --- | --- | --- |
| Workspace | KEEP | 高 | 一切作用域的根；`pg-workspace-store.ts` + 全 API | 无负面 | 核心外键基础 | — |
| Sessions（ACP 会话） | KEEP | 高 | 核心执行路径唯一载体；`src/app/api/acp/*` | SSE 连接为必要成本 | ACP 运行时核心 | — |
| Kanban + lane automation | KEEP | 高 | 核心协调面；ADR-0004；`kanban-tab.tsx` 2232 行 | 首屏加载过重（可优化，非删除） | orchestrator 单例 | — |
| Team Runs | KEEP | 中 | 有 UI、有 API、AcpSession 树模式（无独立表，F 证实） | 中（团队视图请求） | 建立在 session 树上，成本低 | 依赖 ACP session 语义 |
| Shared Sessions | HIDE | 高 | 12 个 API、零 UI、零 DB 表（A1/C/F 一致） | 无直接影响 | TS/Rust 双实现且已漂移 | 依赖 session 模型；删除需先冻结观察 |
| Messages（/messages） | DEV_ONLY | 高 | 页面几乎不可达（NotificationBell 无挂载点，实测）；`page.tsx:62` 请求的 `/api/webhooks/logs` 不存在（真实路由 `/api/webhooks/webhook-logs`） | 无（不可达） | 端点 URL 错误=功能残缺证据 | 无 |
| Traces | KEEP | 高 | 审计/证据链核心；`/traces` 页 + trace stores | trace 写入路径两端性能不一致（§14.3-4） | traces 表 PG-only（SQLite 缺失，F 证实） | — |
| Specialists | KEEP | 高 | 147 个 YAML（实测）、lane prompt 契约的物质载体 | 首屏 specialists 请求可延迟 | Specialist→Agent 模板/运行时关系健康 | — |
| Skills | FREEZE | 高 | 唯一 UI `skill-panel.tsx` 1026 行从未被导入（实测确认零引用） | 死代码进编译图 | Rust `SkillRegistry` 仍在 AppState 中（`state.rs`） | 先确认 Rust 侧注入是否仍被 ACP 使用（NEEDS_VALIDATION） |
| MCP 管理 | KEEP（SIMPLIFY） | 中 | README 列为可用能力；Rust `mcp_servers.rs` 为 stub | 无核心页影响 | TS 实现为主 | — |
| Background Tasks | SIMPLIFY | 高 | 有真实触发方（Schedule/Webhook/Polling）；但 UI `bg-tasks-tab.tsx` 36KB 是孤儿（实测零导入） | 5 秒轮询空转 | 对象本身必要，是自动化收敛点 | 不可删对象，只删孤儿 UI 与轮询可改事件驱动 |
| Notes | SIMPLIFY | 高 | 有 UI 有表有 API | yjs CRDT 依赖进入 bundle | CRDT 仅 InMemory 模式使用（`routa-system.ts:94-95`）；PG/SQLite 均为普通表 | 去 yjs 需确认无协作场景（NEEDS_VALIDATION） |
| Canvas | KEEP | 中 | 有 UI；sucrase 运行时；无独立表（F） | sucrase 进 bundle（可 dynamic） | 是 A2UI 的合理归宿 | — |
| RepoSlide | KEEP | 中 | 独立完整功能；双后端实现 | 独立路由，不污染核心页 | 维护成本中等 | — |
| Feature Explorer | INTERNAL_ONLY | 高 | 4000+ 行双后端实现；仅 DesktopSidebar 二级入口 | 大 bundle 但独立路由 | 重复实现成本高 | 移出正式导航即可 |
| Spec Board | INTERNAL_ONLY | 中 | `/workspace/:id/spec` 仅二级导航 | 独立路由 | — | 同上 |
| Harness | SIMPLIFY | 中 | 有真实数据消费（评审门径第一层，README）；但操作台类 UI 超需求 | Recharts 等图表库进 bundle | 保留 `acp-session-create.ts:40-43` 的 task-adaptive context 注入 | — |
| Fitness | INTERNAL_ONLY | 高 | entrix 是开发治理工具，不是用户功能（docs/fitness/） | KanbanFitnessWorkbenchModal 进 Kanban bundle（应 dynamic） | — | 不得删 entrix 本身（CI 门禁） |
| Fluency | MERGE→Harness | 中 | 与 Harness 信号同源、UI 相邻 | 减少一个设置页与一组请求 | 度量逻辑可并入 harness 域 | — |
| Workflows | KEEP | 中 | 有 UI、有 run 概念；但 run 永远内存态（`routa-system.ts:165`） | 低 | WorkflowRun 对象归属需决（见 F） | — |
| Schedules | KEEP | 高 | 标准自动化触发器；PG/SQLite store 齐全 | tick 失败静默（D 指出） | 收敛到 BackgroundTask 即可 | — |
| Webhooks | KEEP | 中 | GitHub webhook handler 真实存在；Rust 侧全 stub | 低 | TS-only 域 | — |
| Polling | HIDE | 高 | `github-polling-adapter` 存在但无独立用户入口价值 | 低 | 与 Webhook 职责重叠 | — |
| A2A | DEV_ONLY | 高 | 服务端仅 kanban 出站客户端使用（`a2a-outbound-client.ts`）；`src/app/a2a/` 为演示页 | 演示页独立路由 | 保留出站客户端，删服务端 UI/路由 | 出站客户端被 kanban 依赖，勿删 |
| AG-UI | DEV_ONLY | 高 | 只是 ACP 的薄适配层（C 证实）；`src/app/ag-ui/` 演示页 | 独立路由 | `src/core/ag-ui/` 可整体移除 | — |
| A2UI | MERGE→Canvas | 高 | 唯一 UI `overview-a2ui-tab.tsx` 21KB 零导入（实测）；协议已死 | 死代码 | 渲染概念并入 Canvas | — |
| Goal / Plan / Delivery | FREEZE | 高 | 单提交 d2b4d4dd；无迁移文件；无 Rust 实现；`/delivery` 零入站链接 | 增加页面与 API 面 | 6 个 store/表无迁移支撑 | 冻结=停止开发，不删代码 |
| Memory（`/api/memory`） | REMOVE | 高 | deprecated 别名（F 证实） | 无 | 无 | — |

---

## 14.5 三档精简方案

### 保守方案（约减少 20% 产品面）

- **保留页面**：全部现有页面不动。
- **删除/隐藏页面**：隐藏 `/a2a`、`/ag-ui`、`/debug/*`、`/messages`、`/delivery`（改为开发模式或去导航）；移除死导航组件（`desktop-nav-rail.tsx`、`advanced-nav-menu.tsx`、`notification-center.tsx` 生产引用）。
- **保留协议**：全部保留，仅隐藏 A2A/AG-UI/A2UI 的正式 UI。
- **领域模型**：不变；Goal/Plan/Delivery 冻结开发。
- **后端结构**：不变；parity gate 覆盖范围冻结，不再扩张。
- **预计性能收益**：小。只减少导航面与少量死代码；核心 bundle、请求链、编译图基本不变。**热切换速度提升有限**。
- **迁移风险**：极低，全部可一键回滚。

### 推荐方案（约减少 40%–60% 产品面）

- **保留页面**：`/`、`/workspace/:id/kanban`、`/workspace/:id/sessions`、`/workspace/:id/team`、`/traces`、`/settings`（合并后的单页 + tab）、Canvas、RepoSlide。
- **删除页面**：`/a2a`、`/ag-ui`、`/debug/*`、`/messages`（修复或删）、`/delivery`、`/overview`（修复 `home-page-sections.tsx:1148` 直链 kanban 后删重定向）、`/settings/webhooks` 独立页（并入 `/settings?tab=webhooks`）、`/settings/agents`（并入 settings tab）、`/mcp-tools` 重定向页。
- **保留协议**：REST + SSE + ACP + MCP（+ 桌面 Rust JSON-RPC）。删除：AG-UI 全部（`src/app/ag-ui/`、`src/core/ag-ui/`、npm `@ag-ui/*`）、A2UI 全部（`src/client/a2ui/`）、A2A 服务端（保留 `a2a-outbound-client.ts`）、TS 侧 `/api/rpc/route.ts`（仅 5 个 agents 方法，与 Rust RpcRouter 46 方法不成比例）、Shared Sessions 全部 API（`src/app/api/shared-sessions/`、`src/core/shared-session/`、Rust `shared_sessions.rs`）。
- **领域模型**：收敛到约 16 个对象（F 的最小模型）。Conversation 三重存储合并为 `session_messages` 单一来源（现并存 messages 表 + session_messages 表 + `acp_sessions.message_history` JSONB）；WorkflowRun 并入 BackgroundTask metadata 或实现真正的持久 store；移除 `/api/memory` deprecated 别名；Notes 去 yjs CRDT。
- **后端结构**：第一阶段维持双后端但 parity gate 白名单收缩到核心 15–20 域；第二阶段（专项 E 推荐的方案 B）逐步把 `src/app/api/` 的 38 个重复域改为指向 Rust 的 thin proxy，Rust 成为唯一业务权威，TS 退化为渲染层 + gateway；三份 schema 收敛为单一来源。
- **预计性能收益**：**显著**。Kanban/Sessions 首屏 JS 预计下降最大头（Tiptap/lowlight 延迟加载 + 死组件移除）；新增 `workspace/[workspaceId]/layout.tsx` 消除切换重挂载与重复 `useWorkspaces()`；编译图减少数百文件；桌面端语义统一后减少约 250 处 `desktopAwareFetch` 分支负担。
- **迁移风险**：中。协议删除不可逆但有调用证据支撑；双后端收敛是 3–6 个月工程（E 估算），期间需 characterization tests 保护行为。

### 激进方案（只保留经调用证据证明的核心路径）

- **保留页面**：`/`、`/workspace/:id/kanban`、`/workspace/:id/sessions`、`/traces`、最小 `/settings`（provider/workspace 配置）。
- **删除页面**：Team、Notes、Canvas、RepoSlide、Feature Explorer、Spec Board、Harness/Fitness/Fluency 全部 UI、Goals/Plans/Delivery、全部自动化设置页。
- **保留协议**：REST + SSE + ACP。MCP 降为内部能力无 UI。
- **领域模型**：Workspace、Task、KanbanBoard、AcpSession、Agent、Specialist、Codebase、Worktree、Trace、Sandbox——约 10 个对象。
- **后端结构**：单一权威后端（Rust），Next.js 仅渲染。
- **预计性能收益**：最大化（编译图、bundle、请求链全部最小化）。
- **迁移风险**：**高**。Team Runs/Notes/Canvas/RepoSlide 的用户价值未经数据证伪（`NEEDS_VALIDATION`：无使用统计），激进删除可能砍掉真实用户场景；README 宣传的能力面大幅收缩，对外叙事断裂。不建议在无使用数据时执行。

---

## 14.6 分阶段执行路线

### Phase 0：冻结未经确认的新功能和 parity 扩张

- **具体目标**：停止 Goal/Plan/Delivery/Loom 方向的新开发；冻结 parity gate 覆盖域清单（禁止新增域的双端对等要求）；停止 Skills UI 开发。
- **文件范围**：`docs/exec-plans/active/loom-v1-delivery.md`（标记冻结）、`api-contract.yaml`（冻结条目数 158 路径/236 操作）、parity 工具白名单（`scripts/` 下 `check-api-parity.ts` 等）。
- **验证方法**：`git log` 监控相关路径零新增提交；entrix `api_contract` 维度通过。
- **回滚条件**：产品负责人书面确认 Loom 方向为正式战略。
- **不应同时进行**：任何 Phase 1–6 动作。

### Phase 1：建立冷启动、首次编译和热切换基线

- **具体目标**：测量并记录：dev server 冷启动时间、Kanban/Sessions/Team 首次编译时间、三页之间热切换时间、各页首屏 JS 体积与请求数。
- **文件范围**：无源码改动；可新增临时测量脚本（置于仓库外）。
- **验证方法**：浏览器 Performance 面板 + `npm run dev:diagnose`（现有）+ bundle 分析。
- **回滚条件**：不适用（纯测量）。
- **不应同时进行**：任何删除/重构（否则基线失效）。

### Phase 2：隐藏低价值入口

- **具体目标**：执行保守方案的隐藏项；修复 `src/app/messages/page.tsx:62` 的错误端点（或直接隐藏该页）；修复 `home-page-sections.tsx:1148` 的 `/overview` 链接改指 kanban。
- **文件范围**：`desktop-sidebar.tsx`、`src/app/messages/`、`src/app/a2a/`、`src/app/ag-ui/`、`src/app/debug/`、`home-page-sections.tsx`。
- **验证方法**：导航树快照对比；e2e 冒烟（Playwright）确认核心路径不变。
- **回滚条件**：任何被隐藏入口出现真实用户投诉（需先建立反馈渠道，`NEEDS_VALIDATION`）。
- **不应同时进行**：Phase 3 的 bundle 改动。

### Phase 3：从核心 Bundle 移除功能并取消非必要请求

- **具体目标**：(a) 创建 `src/app/workspace/[workspaceId]/layout.tsx` 承载 Sidebar/Header/workspace 数据；(b) 对 SettingsPanel、TiptapInput、KanbanFitnessWorkbenchModal、Harness 图表、lowlight 改为 `next/dynamic`/按需语言包；(c) Kanban 首屏取消 specialists/codebases/ACP warmup 的同步加载，改懒触发。
- **文件范围**：`src/app/workspace/[workspaceId]/**`、`tiptap-input.tsx`、`markdown-viewer.tsx`、`kanban-tab.tsx`、`useWorkspaces` 相关 hooks。
- **验证方法**：对照 Phase 1 基线：首屏 JS 体积、热切换时间、重复请求数；entrix fast/normal。
- **回滚条件**：任何核心流程（拖卡→Agent 执行）出现行为回归。
- **不应同时进行**：Phase 4 的状态模型改动（layout 重构与 store 重构叠加会使回归无法归因）。

### Phase 4：解除内部依赖和重复状态

- **具体目标**：Conversation 三重存储合并为 `session_messages`；WorkflowRun 决策落地（并入 BackgroundTask metadata 或实现 PgWorkflowRunStore 消除 `routa-system.ts:164-165` TODO）；Notes 去 yjs；TS `/api/rpc` 退役。
- **文件范围**：`src/core/store/conversation-store.ts`、`src/core/workflows/workflow-store.ts`、`src/core/notes/`、`src/app/api/rpc/route.ts`、对应 Rust stores。
- **验证方法**：先补 characterization tests（CLAUDE.md 要求）锁定生命周期行为，再改；API contract 测试通过。
- **回滚条件**：数据迁移路径未验证前不得切换存储（尤其 `acp_sessions.message_history` 存量数据）。
- **不应同时进行**：Phase 5 删除动作。

### Phase 5：删除 UI 与 API

- **具体目标**：删除推荐方案列出的页面与协议：AG-UI/A2UI 全部、A2A 服务端路由与页面、Shared Sessions 12 个 API、`/api/memory`、死组件（`desktop-nav-rail.tsx`、`advanced-nav-menu.tsx`、`skill-panel.tsx`、`bg-tasks-tab.tsx`、`overview-a2ui-tab.tsx`、NotificationCenter）。
- **文件范围**：见 §14.5 推荐方案；Rust 侧对应 `ag_ui.rs`、`a2ui.rs`、`a2a.rs`、`shared_sessions.rs`。
- **验证方法**：entrix normal + parity gate（收缩后的白名单）+ e2e 核心路径。
- **回滚条件**：删除前每项单独提交（baby-step），任一项引发外部集成断裂即单项回滚。
- **不应同时进行**：Phase 6 的领域对象删除。

### Phase 6：删除领域对象、存储、测试、依赖和文档

- **具体目标**：清理 Phase 5 遗留的 store、表、npm/cargo 依赖（`@ag-ui/*` 等）、测试与文档；决策后端终局（专项 E 方案 B：Rust 单一业务权威，TS thin proxy，Web 部署从 Vercel 迁往 Docker/Fly.io——`NEEDS_VALIDATION`：部署现状需产品负责人确认）；三份 schema 收敛单一来源；补齐 6 张无迁移表的迁移文件或正式弃用（kanban_boards、workflow_runs、artifacts、artifact_requests、product_goals、dev_plans）。
- **文件范围**：`src/core/db/schema.ts`、`src/core/db/sqlite.ts`、`crates/routa-core/src/db/mod.rs`、migration 目录、`package.json`、`Cargo.toml`。
- **验证方法**：全量 entrix tier normal + `npm run api:test` + 桌面端冒烟（`127.0.0.1:3210`）。
- **回滚条件**：任何数据丢失风险（迁移脚本必须先备份验证）；桌面端启动回归。
- **不应同时进行**：新功能开发。

---

## 14.7 最高优先级清单

**最应该删除的 10 项：**

1. AG-UI 全部（`src/app/ag-ui/`、`src/core/ag-ui/`、npm `@ag-ui/*`）——ACP 的薄重复。
2. A2UI 全部（`src/client/a2ui/`、`overview-a2ui-tab.tsx` 21KB 孤儿、Rust `a2ui.rs`）。
3. A2A 服务端页面与路由（`src/app/a2a/`、`src/app/api/a2a/`、Rust `a2a.rs`）——保留 `a2a-outbound-client.ts`。
4. Shared Sessions 全部（`src/app/api/shared-sessions/`、`src/core/shared-session/`、Rust `shared_sessions.rs`）——12 API 零 UI 零持久化。
5. `/api/memory` deprecated 别名。
6. 死导航组件：`desktop-nav-rail.tsx`、`advanced-nav-menu.tsx`、`notification-center.tsx`（仅 stories 引用）。
7. 孤儿大组件：`skill-panel.tsx`（1026 行零导入）、`bg-tasks-tab.tsx`（36KB 零导入）。
8. `/debug/*` 页面（含 office-wasm-poc）。
9. TS 侧 `/api/rpc/route.ts`（5 方法与 Rust RpcRouter 46 方法不成体系）。
10. 死 i18n 词典文件：`en-extended.ts`/`zh-extended.ts`/`en-tail.ts`/`zh-tail.ts` 中的死键（先统计后删）。

**最应该合并的 10 项：**

1. Conversation 三重存储 → `session_messages` 单一来源。
2. WorkflowRun → BackgroundTask metadata（或实现持久 store，二选一必须定）。
3. Fluency → Harness。
4. `/settings/webhooks`、`/settings/agents` 等独立设置页 → `/settings` 单页 tab。
5. 三份 DB schema（`schema.ts`/`sqlite.ts`/Rust `db/mod.rs`）→ 单一 schema 源。
6. A2UI 渲染概念 → Canvas。
7. Schedule/Webhook/Polling 触发器 → 统一的 BackgroundTask 创建入口（收敛已事实存在，缺的是显式化）。
8. `useWorkspaces()` 17+ 处调用 → workspace layout 级单一缓存。
9. TS/Rust 重复的 38 域业务逻辑 → 单一权威实现（Rust，按专项 E 推荐）。
10. `desktopAwareFetch` 双路径分支 → 后端统一后收敛为单一 fetch 层。

**最影响页面速度的 10 项：**

1. 新建 `src/app/workspace/[workspaceId]/layout.tsx`（消除切换重挂载）。
2. Tiptap 全家桶 `next/dynamic` 化（约 7.1MB 依赖树移出头屏）。
3. highlight.js/lowlight 改按需语言包（约 9.1MB 依赖树）。
4. 合并 17+ 处 `useWorkspaces()` 重复请求。
5. Kanban 首屏取消 specialists/codebases/ACP warmup 同步加载。
6. SettingsPanel / KanbanFitnessWorkbenchModal / Harness 图表动态化。
7. i18n 全词典按页懒加载或裁剪死键。
8. 拆分 28 个千行级客户端文件（hydration 集中成本），从 `kanban-tab.tsx`（2232 行）开始。
9. 清理 `.next`（13GB）与 `target/`（55GB）对磁盘 IO 的拖累（依 README 既有 `dev:clean` 流程，由人工在 dev server 停止时执行）。
10. 移除进入核心页面路径的死导航/死 tab 组件（减少编译图与解析面）。

**绝对不能草率删除的 10 项：**

1. ACP 运行时与 session 释放安全门（release gates、history-persist-before-release——专项 D）。
2. prompt 幂等保护 `appendHistoryOnce` 与执行 lease（防重复执行/数据污染）。
3. worktree 隔离与 team card ownership（Git 安全与数据完整性）。
4. `a2a-outbound-client.ts`（kanban 出站的真实依赖，删 A2A 时必须保留）。
5. entrix fitness 体系（CI 门禁本身，虽然 Fitness UI 可 INTERNAL_ONLY）。
6. 桌面端约 23 项 Rust 专属能力（进程管理、PTY、git2、sandbox Docker CLI）。
7. `resolveApiPath` + `desktopAwareFetch` 基础设施（在双后端收敛完成前是唯一路径组装层）。
8. 静态导出 fallback 链（`resolve_static_target()` + placeholder 约定）——桌面发布依赖，重构需整体设计。
9. traces 写入路径（审计与证据链的法律性证据）。
10. `api-contract.yaml` 与 parity gate 的核心域部分（在双后端共存期仍是必要的创可贴，随 Phase 6 终局决策一同退役）。

**产品负责人必须回答的问题（≤8 个）：**

1. Routa 的定位是"多 Agent 协调平台"还是 Loom"交付工作台"？`d2b4d4dd` 引入的 Goal/Plan/Delivery 是继续、冻结还是删除？
2. 是否存在真实的云端多租户 Postgres 部署？如果只有本地/桌面使用，Postgres 路径（含 Neon 适配）是否值得维护？
3. Shared Sessions（12 个 API）计划给谁用？若 30 天内无 UI 计划，是否同意删除？
4. A2A/AG-UI 是否有外部集成方在用？（删除前唯一阻断条件）
5. Notes 是否需要多人实时协作？若否，确认移除 yjs CRDT。
6. Skills 的 UI（1026 行孤儿面板）是废弃还是待接线？Rust `SkillRegistry` 的运行时注入是否仍在使用？
7. Docker Worker（零实例化的 placeholder，issue #71 Phase 1）还打算接入吗？
8. 桌面包是否接受"放弃 Vercel serverless、Web 改 Docker 部署"以换取业务逻辑单一权威实现（专项 E 方案 B）？

---

## 证据边界声明（§15 合规）

- 所有路径/行号引用来自本次只读审查中的实际读取与 grep/ls/wc 实测；规模数字（197 route 文件、77 Rust API 模块、527 core 文件、194 client 组件、147 specialist YAML、`.next` 13GB、`target/` 55GB、`routa.db` 约 816MB、28 个千行文件、4124 commits、v0.19.0）均为实测或复验值。
- 标记 `NEEDS_VALIDATION` 的结论（真实用户数据、Postgres 云部署现状、Skills 运行时使用、Notes 协作场景、死词典精确比例、Docker Worker 计划）均无代码内证据可证明，未伪造任何使用数据。
- 未以仓库总代码行数论证性能；性能结论均落在进入页面执行路径的 bundle/请求/挂载/编译图上。
- Loom 相关文档全程作为待审对象处理，未作为审查基准。
- 再次提醒：**子审查 A1 意外创建的 `docs/reviews/product-review-readonly-2026-08-11.md` 需要仓库所有者手动删除**（审查过程受任务书 §3 约束无法执行删除）。
