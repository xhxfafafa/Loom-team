# Routa.js 产品范围、架构复杂度与页面性能审查任务书

## 1. 文档用途

本文档用于指导外部代码审查 Agent 对 Routa.js 进行一次只读技术审查，目标是回答三个问题：

1. Routa 当前哪些功能真正有用户价值，哪些功能应当保留、合并、隐藏、冻结或删除？
2. 启动慢和页面切换慢的主要原因是什么，哪些低价值功能正在进入核心页面的 Bundle、挂载流程或请求链？
3. 协议、自动化、双后端、存储和领域模型中存在哪些重复设计，可以如何安全缩减？

本文档是审查任务书，不代表已经作出的产品决策，也不授权 Agent 修改代码。

## 2. 项目身份与重要纠偏

- 项目名称是 **Routa.js**。
- 仓库目录、`package.json`、`README.md` 和主要架构文档都以 Routa 为产品身份。
- `docs/design-docs/loom-v1-scope.md`、`docs/exec-plans/active/loom-v1-delivery.md` 以及其他 Loom 命名内容是近期加入的方向提案。
- Loom 相关文档不得被自动视为当前产品战略或审查基准；它们本身也是待审对象。
- 审查者必须从现有用户入口、真实调用关系、运行性能和维护成本反推 Routa 的核心，而不是预设产品应该收敛成某个已写好的方案。

## 3. 安全与工作区约束

当前工作区存在大量未提交改动。审查过程中必须遵守以下约束：

- 不修改、创建、删除、移动、格式化或还原任何仓库文件。
- 不执行 `git reset`、`git checkout`、`git clean`、`rm` 或其他破坏性命令。
- 不运行会生成构建产物或改写缓存的 `build`、`dev`、测试、迁移、格式化命令。
- 不修改 `.next`、数据库、migration、lockfile 或用户配置。
- 允许使用 `rg`、`find`、`sed`、`git log`、`git show`、`git diff`、`git status`、`wc`、`du` 等只读命令。
- 不读取或输出 `.env`、密钥、Token、凭据、数据库内容和用户隐私数据。
- 最终只输出审查报告，不实施修复。

## 4. 必读材料

按以下顺序阅读：

1. `AGENTS.md`
2. `README.md`
3. `docs/ARCHITECTURE.md`
4. `docs/adr/README.md` 以及任务相关 ADR
5. `docs/fitness/README.md`
6. `docs/product-specs/FEATURE_TREE.md`
7. `api-contract.yaml`
8. `package.json`
9. `next.config.ts`
10. `src/core/routa-system.ts`
11. `crates/routa-core/src/state.rs`
12. `crates/routa-server/src/lib.rs`

同时阅读但不得默认接受：

- `docs/design-docs/loom-v1-scope.md`
- `docs/exec-plans/active/loom-v1-delivery.md`
- 其他与 Loom、Goal、Plan、Delivery 方向相关的设计和计划文件

## 5. 已知规模与待验证线索

以下数据来自一次初步只读扫描。审查者应验证或纠正，不得直接当作最终结论：

- `src/app/api` 下约有 197 个 Next.js route 文件。
- `crates/routa-server/src/api` 下约有 77 个 Rust API 模块。
- `src/core` 约有 526 个文件。
- `crates/routa-core/src` 约有 114 个文件。
- `src/app` 与 `src/client` 中约有 193 个 React Client Component。
- `.next` 曾达到约 13.45 GiB，其中 `.next/dev/cache/turbopack` 约 12.05 GiB。
- 项目自身的 Turbopack 缓存告警阈值为 2 GiB。
- `next.config.ts` 设置了 `preloadEntriesOnStart: false`，其注释明确说明这是以更慢的首次页面响应换取较低内存使用。
- Workspace 路由目前没有共享的 `src/app/workspace/[workspaceId]/layout.tsx`。
- Sessions、Kanban、Team、Plan、Delivery 等页面分别调用 `useWorkspaces()`。
- Kanban 页面挂载时会加载 board、tasks、sessions、specialists、codebases，并触发 ACP warmup。
- `I18nProvider` 位于根布局，静态导入完整中英文词典。
- 多个核心客户端文件超过 1000 行，例如 Kanban、Team Run、Session、Message、Trace 和 Settings 相关模块。

注意：仓库总代码量不会直接导致浏览器页面切换慢。必须区分源码规模与实际进入页面执行路径的代码。

## 6. 审查原则

### 6.1 产品价值原则

- 没有明确用户问题、入口和调用方的功能默认需要证明自身价值。
- “以后可能有用”不是保留理由。
- 已投入大量开发成本不是保留理由。
- 已有 ADR、测试或完整实现不代表产品仍然需要该功能。
- 内部基础设施必须证明它直接支持用户可感知的核心能力。
- 调试页、协议演示和内部治理页不应自动成为正式产品页面。

### 6.2 性能因果原则

必须分别分析：

1. 开发服务器启动慢
2. 路由首次编译慢
3. 已编译页面之间的热切换慢
4. API 响应慢
5. JavaScript 下载、解析和执行慢
6. React hydration、挂载和重渲染慢
7. 桌面 Rust 后端启动或响应慢

删除后端代码只有在减少启动初始化、编译图、文件监听、核心 API 延迟或前端调用时，才能被认定为页面性能收益。

### 6.3 安全边界原则

- Git 安全、数据完整性、权限控制和必要审计能力不能在没有风险分析时删除。
- 能用明确失败和手动重试解决的问题，不应默认保留复杂自动恢复。
- 为多租户、云高可用、远程协作或跨组织协议设计的能力，需要证明它符合 Routa 当前真实使用场景。

## 7. 专项审查 A：产品功能与用户路径

请根据页面、导航、API、调用方和完成度，总结 Routa 当前实际上解决的问题，并找出完成一次多 Agent 软件开发任务的最短真实用户路径。

逐项审查：

- Workspace
- Sessions
- Kanban
- Team Runs
- Shared Sessions
- Messages
- Traces
- Notes
- Canvas
- RepoSlide
- Feature Explorer
- Spec Board
- Harness
- Fitness
- Fluency
- Workflows
- Schedules
- Webhooks
- Polling
- Background Tasks
- Specialists
- Skills
- MCP 管理
- A2A
- AG-UI
- A2UI
- Goal
- Plan
- Delivery

对每项输出：

| 字段 | 要求 |
| --- | --- |
| 功能名称 | 用户可理解的名称 |
| 用户入口 | 页面、导航或外部入口 |
| 主要源码 | UI、API、core、store 的关键路径 |
| 用户问题 | 它具体解决什么问题 |
| 调用证据 | 谁创建、读取和消费它 |
| 完成度 | 稳定、演进中、实验、残缺、兼容 |
| 用户价值 | 0-5 |
| 维护成本 | 0-5 |
| 重复程度 | 0-5 |
| 性能影响 | Bundle、请求、初始化、后台连接 |
| 建议 | 见统一裁决枚举 |
| 理由 | 基于证据，不基于想象 |
| 删除影响 | 用户、数据、API、桌面端和兼容风险 |

统一裁决枚举：

- `KEEP`
- `SIMPLIFY`
- `MERGE`
- `INTERNAL_ONLY`
- `DEV_ONLY`
- `HIDE`
- `FREEZE`
- `REMOVE`
- `NEEDS_VALIDATION`

专项结论必须包含：

- Routa 当前实际核心
- 最短用户闭环
- 应立即停止继续开发的功能
- 可以立即隐藏的入口
- 可以低风险删除的功能
- 精简后一级导航
- 真正需要产品负责人回答的问题

## 8. 专项审查 B：前端启动与页面切换性能

重点检查：

- `src/app/layout.tsx`
- `next.config.ts`
- `src/i18n/`
- `src/client/components/desktop-sidebar.tsx`
- `src/client/components/desktop-nav-rail.tsx`
- `src/client/components/advanced-nav-menu.tsx`
- `src/client/components/settings-center-nav.tsx`
- `src/app/page.tsx`
- `src/app/workspace/[workspaceId]/kanban/`
- `src/app/workspace/[workspaceId]/sessions/`
- `src/app/workspace/[workspaceId]/team/`
- `src/app/settings/`

重点分析重量级依赖：

- Tiptap
- CodeMirror
- `@pierre/diffs`
- `dnd-kit`
- `@xyflow/react`
- Recharts
- Mermaid
- xterm
- `react-complex-tree`
- Office/WASM viewer
- Canvas runtime

逐页调查：

- 首屏静态导入
- Client Component 边界
- 首屏 API 请求
- `no-store` 请求
- 重复 workspace 请求
- EventSource、轮询和定时器
- 首屏不显示但已导入的 Modal、Drawer、Tab、Panel
- 重量级编辑器、Diff、图表和可视化组件
- 页面切换时被重新挂载的 Header、Sidebar 和 Provider

重点回答：

1. 哪些功能即使用户没有打开，也进入核心页面 Bundle？
2. 哪些隐藏组件在页面挂载时提前请求数据？
3. 哪些页面重复加载 workspace、sessions、specialists 或 provider 数据？
4. 是否应建立 `src/app/workspace/[workspaceId]/layout.tsx`？
5. 是否存在多套重复的 Sidebar、Nav Rail、Header 或 Settings 导航？
6. 完整中英文词典是否进入所有页面客户端 Bundle？
7. Kanban 首屏加载 sessions、specialists、codebases 和 ACP warmup 是否必要？
8. Harness/Fitness、Canvas、RepoSlide、Background Agent、GitHub Import 等能力是否被耦合进核心页面？
9. 哪些正式页面应改为开发模式专用或完全删除？

输出页面矩阵：

| 页面 | Client JS 来源 | 首屏请求 | 重复请求 | 重型依赖 | 非核心模块 | 推荐动作 |
| --- | --- | --- | --- | --- | --- | --- |

最终列出：

- 按实际用户等待时间排序的根因
- 最高收益的 10 个删除项
- 最高收益的 10 个结构简化项
- 可以取消或延迟的首屏请求
- 可以移出核心 Bundle 的模块
- 冷启动和热切换的不同解决方案
- 每项建议的验证指标

## 9. 专项审查 C：协议栈

审查以下协议和管理面：

- REST
- SSE
- ACP
- MCP
- A2A
- AG-UI
- A2UI
- JSON-RPC
- Shared Sessions
- MCP Server 启停
- 自定义 MCP Server 配置
- Agent registry/install/runtime/warmup

对每种协议回答：

- 当前真实调用方是谁？
- 用户是否直接使用？
- 是否只有演示页或测试页？
- 是否进入 Routa 核心执行路径？
- 是否与其他协议承担相同职责？
- TypeScript 和 Rust 是否重复实现？
- 引入了哪些 session、stream、store 和错误处理？
- 删除后是否可由 REST、SSE、ACP 或 MCP 最小子集替代？
- 是否只需保留内部能力而删除正式 UI？

必须给出最小协议架构候选，并列出可以一起删除的页面、API、依赖、store 和测试范围。

## 10. 专项审查 D：自动化与执行模型

审查：

- Tasks
- Kanban lane automation
- Background Tasks
- Workflows 与 Workflow Runs
- Schedules
- Webhooks
- Polling
- Team Runs
- Shared Sessions
- task decomposition
- dependency DAG
- retry/recovery
- 手动 trigger/run/tick

为每套机制列出：

- 触发源
- 创建的领域对象
- 状态机
- store 和数据库
- 执行路径
- UI 入口
- 与其他机制的重叠
- 真实用户用例
- 失败处理

重点判断：

- Workflow、Schedule、Webhook、Polling 是否最终都只是创建 Task 或 Session？
- BackgroundTask 是否有必要成为独立领域对象？
- Kanban 列触发 Agent 是否已经覆盖主要自动化需求？
- Team Run 和普通 Task/Session 的关系是否过于复杂？
- 哪些自动恢复可以改成明确失败和手动重试？
- 哪些可靠性保障涉及数据或 Git 安全，必须保留？

最终提出一个最小执行模型候选，但不得先假定该模型一定正确。

## 11. 专项审查 E：双后端、存储与运行时

审查：

- Next.js API
- Rust/Axum API
- Tauri 桌面端
- Postgres
- SQLite
- in-memory store
- Local Worker
- Docker Worker
- Sandbox
- Worktree
- 静态导出
- Desktop placeholder/fallback
- API parity gate

输出重复能力矩阵：

| 能力 | TypeScript 实现 | Rust 实现 | 调用方 | 语义差异 | 推荐权威实现 |
| --- | --- | --- | --- | --- | --- |

重点回答：

- 哪些领域逻辑在 TypeScript 和 Rust 中重复？
- 两套实现是否真的保持一致？
- 哪套实现拥有更多真实调用方？
- 双后端对启动、编译、API 和前端页面有什么实际影响？
- 桌面端真正必须由 Rust 完成的能力有哪些？
- 业务领域逻辑能否只保留一份？
- Postgres、SQLite 和 in-memory 是否都有真实部署需求？
- Docker Worker 是否有核心使用证据？
- 静态导出和 SSR 兼容是否显著扩大复杂度？
- API parity 是在保护核心能力，还是扩大低价值功能维护范围？

至少比较三种目标架构：

1. 保留双后端但大幅缩减能力
2. Rust 只负责本地系统能力，业务逻辑保留单一权威实现
3. 单后端架构

每种方案说明删除范围、性能影响、打包影响、迁移成本和桌面能力风险。

## 12. 专项审查 F：领域模型与持久化

审查以下对象：

- Workspace
- Goal
- Plan
- Delivery
- Task
- KanbanBoard/Column
- Session
- ACP Session
- Conversation
- Team Run
- Shared Session
- Background Task
- Workflow Run
- Schedule
- Note/CRDT
- Artifact
- Evidence
- Trace
- Review/Finding/Verdict
- Codebase
- Worktree
- Memory
- Specialist
- Skill
- Agent
- Provider
- Sandbox

对每个对象调查：

- 创建入口
- 读取入口
- UI 入口
- API
- store
- 数据库表
- TypeScript/Rust 是否重复
- 是否存在完整数据生命周期
- 是否只是其他对象的投影
- 删除后能否由更简单对象表达

重点验证：

- Session、ACP Session、Conversation、Team Run、Shared Session 是否过度拆分
- Artifact、Evidence、Trace、Review Finding 是否重复
- Specialist、Skill、Agent、Provider、Role 是否概念过多
- Goal、Plan、Delivery 是稳定产品能力还是近期方向实验
- Notes 的 CRDT 实时协作是否匹配当前使用场景
- Memory 是否存在命名冲突和低价值兼容面
- deprecated API 和兼容字段是否应结束生命周期
- 哪些表没有稳定写入和读取路径

输出当前领域模型、最小领域模型候选，以及 `KEEP / MERGE / INLINE / FREEZE / REMOVE` 裁决表。

## 13. 专项审查 G：导航与设置

逐页审查：

- `/`
- `/a2a`
- `/ag-ui`
- `/messages`
- `/traces`
- `/debug/*`
- `/mcp-tools`
- `/settings`
- `/settings/agents`
- `/settings/mcp`
- `/settings/specialists`
- `/settings/schedules`
- `/settings/webhooks`
- `/settings/workflows`
- `/settings/harness`
- `/settings/fitness`
- `/settings/fluency`
- `/workspace/:id/sessions`
- `/workspace/:id/kanban`
- `/workspace/:id/team`
- `/workspace/:id/spec`
- `/workspace/:id/feature-explorer`
- `/workspace/:id/goal`
- `/workspace/:id/plan`
- `/workspace/:id/delivery`
- RepoSlide
- Canvas

对每个页面判断：

- 用户为什么进入？
- 是否有明确上游和下游？
- 是否与另一个页面重复？
- 是否只是内部调试或协议演示？
- 是否有稳定后端能力？
- 是否应进入一级导航？
- 是否导致大型客户端 Bundle 或首屏请求？
- 应保留、合并、开发模式化、隐藏、冻结还是删除？

输出当前导航树、建议导航树、应移出一级导航的页面、开发模式页面、可删除兼容路由、可合并设置页和 5 分钟新用户路径。

## 14. 最终报告格式

最终报告标题：

`Routa.js 产品范围、架构复杂度与性能精简审查报告`

报告必须包含以下章节。

### 14.1 执行摘要

- 最重要的 5 个结论
- 最大的产品范围问题
- 最大的页面性能问题
- 最大的架构重复问题
- 推荐的精简幅度

### 14.2 当前产品事实

- Routa 当前实际解决的问题
- 主要用户
- 真实核心路径
- 当前定位冲突
- Routa 与 Loom 命名及方向冲突

### 14.3 性能根因

分别说明：

- 开发启动
- 首次编译
- 热切换
- API
- JavaScript 与 hydration
- 桌面后端

每个结论必须引用源码或测量证据。

### 14.4 功能裁决表

| 功能 | 裁决 | 信心 | 用户依据 | 性能影响 | 技术影响 | 删除依赖 |
| --- | --- | --- | --- | --- | --- | --- |

### 14.5 三档精简方案

保守方案：

- 主要隐藏调试、实验和重复入口
- 目标减少约 20% 产品面

推荐方案：

- 删除或合并低价值功能、协议、状态模型和核心页面耦合
- 目标减少约 40%-60% 产品面

激进方案：

- 只保留经调用证据证明的核心路径

每档必须说明：

- 保留页面
- 删除页面
- 保留协议
- 领域模型
- 后端结构
- 预计性能收益
- 迁移风险

### 14.6 分阶段执行路线

- Phase 0：冻结未经确认的新功能和 parity 扩张
- Phase 1：建立冷启动、首次编译和热切换基线
- Phase 2：隐藏低价值入口
- Phase 3：从核心 Bundle 移除功能并取消非必要请求
- Phase 4：解除内部依赖和重复状态
- Phase 5：删除 UI 与 API
- Phase 6：删除领域对象、存储、测试、依赖和文档

每阶段必须给出：

- 具体目标
- 文件范围
- 验证方法
- 回滚条件
- 不应同时进行的改动

### 14.7 最高优先级清单

- 最应该删除的 10 项
- 最应该合并的 10 项
- 最影响页面速度的 10 项
- 绝对不能草率删除的 10 项
- 产品负责人必须回答的问题，最多 8 个

## 15. 证据要求

- 所有重要结论都必须引用具体文件路径，必要时引用行号。
- 判断功能价值时同时检查 UI、API、core、store、数据库和测试。
- 判断删除收益时说明它是否减少 Client JS、API 请求、后台连接、编译图、启动初始化或双后端维护。
- 无法证明的结论标记为 `NEEDS_VALIDATION`，不得伪造使用数据。
- 不使用仓库总代码行数替代性能分析。
- 不把近期设计文档的自我标记状态当作产品负责人确认。

## 16. 可直接交给审查 Agent 的指令

```text
请完整阅读 docs/routa-product-scope-and-performance-audit-brief.md，并严格按照其中的安全约束、审查范围、证据要求和最终报告格式，对 Routa.js 进行只读审查。

项目是 Routa.js。不得把任何 Loom 文档自动视为当前产品战略；Loom 相关文档和代码本身也是待审对象。

当前工作区有大量未提交改动。禁止修改、创建、删除、格式化、还原任何文件，禁止执行构建、开发服务器、测试、迁移或其他会写入工作区和缓存的命令。

请使用本地源码证据完成审查，并直接输出完整的《Routa.js 产品范围、架构复杂度与性能精简审查报告》。不要实施任何修改。
```
