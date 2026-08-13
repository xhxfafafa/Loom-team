---
title: Loom-team Web-only Migration
status: revised_after_independent_review
target_repository: https://github.com/xhxfafafa/Loom-team
target_directory: /Users/xie/Documents/vibecoding/Loom-team
source_repository: Routa.js
owners:
  - migration-agent-team
last_updated: 2026-08-14
revision: 2
---

# Loom-team Web-only Migration

## 1. 文档目的

本文是把 Routa.js 迁移为独立 `Loom-team` Web 产品的执行规范。它面向后续实施迁移的 Agent，负责定义目标架构、保留与删除边界、迁移阶段、验证门禁和禁止事项。

本次迁移不是提取一个孤立的 Team 页面，也不是重写 Team 功能。迁移的准确含义是：

> 完整保留 Routa 当前以 Team、Kanban 和多 Agent 会话为核心的 TypeScript Web 产品能力，移除 Tauri 桌面运行面以及为了维持 Next.js/Rust 双后端而存在的兼容成本。

所有目标仓库修改必须发生在固定目录：

```text
/Users/xie/Documents/vibecoding/Loom-team
```

`/Users/xie/Documents/vibecoding/Loom-v2/routa` 是源仓库和行为参考，不是迁移后的产品工作目录。除更新本迁移文档或用户明确授权外，实施 Agent 不得在源仓库执行迁移删除或重构。

迁移应优先保持行为不变。品牌重命名、视觉重做、数据库重构、鉴权设计和功能删减都不属于首轮迁移。

## 2. 决策摘要

### 2.1 目标运行时

最终生产运行拓扑只有一套：

```text
Browser
  -> Next.js App Router pages
  -> Next.js route handlers under /api
  -> TypeScript domain services
  -> Postgres (production) or SQLite (local development)
  -> local/remote agent provider processes through the existing Web ACP layer
```

最终目标仓库不要求 Rust/Cargo 才能构建或运行。当前由 Rust CLI/Entrix 支撑、但仍被 Team 或 Kanban Web 界面消费的能力，必须先移植到 TypeScript/Node，再删除 Rust 实现；不得通过删除入口来规避移植。

以下拓扑不再是目标运行时：

```text
Tauri WebView
  -> static Next.js export
  -> 127.0.0.1:3210
  -> Rust/Axum routa-server
  -> SQLite/local desktop runtime
```

### 2.2 核心决策

1. **Team 业务不切割。** Team Run、任务归属、子会话、报告交付、删除语义和恢复语义必须完整保留。
2. **Kanban 完整保留。** Kanban 是 Team 的任务与执行控制面，不得视为可选 UI。
3. **Next.js 是唯一产品后端。** `src/app/api/**` 与 `src/core/**` 成为产品运行时的唯一权威实现。
4. **先复制完整 Web 基线，再删除桌面能力。** 禁止从空 Next.js 项目逐文件拼装 Team。
5. **先解除依赖，再删除文件。** 每批删除都必须由搜索证据和测试证明无运行时引用。
6. **迁移阶段不改变领域语义。** 不顺便修改状态机、API 响应、数据库字段或 Team/Task/Session 关系。
7. **保留单后端 API 契约。** 删除双后端 parity，不删除 `api-contract.yaml` 和 Web 契约测试。
8. **最终代码必须完成去冗余收口。** 不得留下桌面死代码、双后端残留、未使用依赖、无入口页面、不可达 API、无消费者导出或重复实现；但任何删除都必须有引用扫描和行为测试证据。
9. **GitHub 上传属于完成条件。** 迁移修改必须形成可审查提交并推送到 `https://github.com/xhxfafafa/Loom-team.git`；只存在于本地工作树不算交付完成。

## 3. 范围

### 3.1 必须保留的用户能力

以下能力属于迁移后的 Web 产品基线：

- Workspace 创建、选择、查看和归档
- Workspace 与 Codebase 的绑定
- Team Run 创建、列表、详情、继续执行和删除
- Team 链、Team Lead、子 Agent、父子 Session 和任务归属关系
- Kanban board、列、卡片、任务流转和 lane automation
- Task 创建、更新、状态流转、Session 绑定、产物与变更摘要
- Agent 与 Specialist 发现、选择和执行
- ACP Session 创建、Prompt、增量消息、恢复、结束和历史读取
- Team Run 与 Session 的 transcript、工具调用和状态展示
- ChatPanel、消息气泡、AskUserQuestion、工具事件和富文本输入
- Codebase、Worktree、Git changes 等 Team/Kanban 当前直接使用的能力
- Notes、Artifacts、Permissions 等当前 Team 或 Agent 工具链直接依赖的能力
- Web 端 SSE、事件广播和运行状态更新
- Web 端 SQLite 本地开发与 Postgres 生产存储
- i18n、主题、设计系统和响应式 Web 布局

### 3.2 首轮明确不做

- 不重设计 Team、Kanban 或 Session UI
- 不把 Team 页面拆成独立 npm package
- 不把 Next.js API 改造成单独的微服务
- 不切换 ORM、数据库或迁移工具
- 不引入新的用户系统、组织模型、RBAC 或计费
- 不统一重命名所有 `Routa` 标识
- 不修改 ACP 协议或替换 Agent provider
- 不删除 Docker、Git、Codebase 或 Worktree，仅因为它们看起来像本地能力
- 不在完成 Web 消费者审计和 TypeScript/Node 能力移植前删除 CLI/治理工具
- 不在迁移提交中做大文件重构
- 不处理与桌面移除无关的既有技术债

### 3.3 后续可选工作，不阻塞首轮迁移

- Routa -> Loom-team 的完整品牌重命名
- 登录、团队、租户和权限体系
- SaaS 化的远程 Agent runner
- 单一生产数据库策略
- 删除未使用的产品页面
- Team/Kanban 大组件的结构性重构

## 4. 领域边界与不可破坏的不变量

### 4.1 Workspace 是顶层边界

所有 Team、Session、Task、Kanban、Codebase、Worktree、Note 和 Artifact 都必须保持 workspace scope。不得在迁移时把它们改成全局列表。

必须保持：

- Team 列表通过 `workspaceId` 过滤 Session
- Task 的 `teamRunId` 查询同时受 `workspaceId` 约束
- Kanban board 与 Workspace 一致
- Codebase/Worktree 解析不跨 Workspace 泄漏
- 现有 `default` workspace 回退只能原样保留或由独立变更处理，不能在平台迁移中随意扩大

### 4.2 Team Run 不是一张独立表或一个页面

当前 Team Run 是多个领域对象共同形成的运行视图：

```text
Workspace
  -> root Team Session
      -> child Sessions / Agents
      -> Team chain and ownership
      -> Tasks linked by teamRunId
      -> Transcripts and messages
      -> Notes / reports / artifacts
      -> Codebase / Worktree execution context
```

因此不得只复制：

- `src/app/workspace/[workspaceId]/team/**`
- `src/app/api/team-runs/**`

而遗漏 Session、Task、ACP、Agent、Specialist、Kanban、存储和编排代码。

### 4.3 Kanban 是执行控制面

`getRoutaSystem()` 会启动 workflow orchestrator，Kanban 列迁移可以触发 Session、队列和恢复行为。以下语义必须保持：

- 卡片状态机与终态判断
- 列策略与自动运行
- lane session 历史
- 每 board 并发控制
- Session/Task 的双向归属
- 失败、超时、恢复和重试
- Team 卡片的 Codebase/Worktree 上下文
- SSE/event bus 驱动的 UI 更新

### 4.4 Session 与 ACP 是 Team 的运行内核

必须保留：

- root/child Session 关系
- `teamRunId`、`teamChainId`、Team Lead 身份规则
- ACP provider 选择、Session 创建、Prompt 和流式更新
- Session runtime finalization 与 recovery
- 历史记录、transcript 和持久化
- forwarded notifications 和工具调用增量
- 运行实例/lease 相关的现有恢复语义

### 4.5 删除 Team Run 必须是聚合删除

不得把 Team Run 删除简化为删除一条 Session。应保留现有 preview + confirmed delete 流程，以及对以下资源的清理或保留策略：

- root 与 child Sessions
- Tasks 和 Team Run 绑定
- Agent runtime/process
- Worktree
- 持久化 Session 与消息
- Kanban 事件通知
- 数据库与本地 Session provider 中的记录

## 5. 代码边界

### 5.1 P0：产品运行时，必须保留

首轮迁移应默认完整保留这些目录，然后通过测试证明其中个别文件可删，而不是反向挑选：

| 路径 | 原因 |
|---|---|
| `src/app/**` | Next.js Web 页面与唯一 API 后端 |
| `src/client/**` | Web UI、hooks、ChatPanel、请求与状态逻辑 |
| `src/core/**` | Team/Kanban/ACP/Session/Task/Store/DB 领域实现 |
| `src/instrumentation.ts` | Web Scheduler、BackgroundWorker 与 telemetry 启动入口 |
| `src/css/**`, `src/theme/**`, `src/types/**`, `src/test/**` | Web 样式、主题、共享类型与测试基础设施 |
| `src/i18n/**` | UI 字符串与语言切换 |
| `resources/specialists/**` | Team Agent/Specialist 运行输入 |
| `resources/canvas/**` | Kanban fitness workbench 与 Canvas SDK 的静态契约 |
| `resources/flows/**` | Workflow loader 的运行时扫描输入 |
| `drizzle/**` | Postgres schema migration |
| `drizzle-sqlite/**` | SQLite schema migration |
| `tests/api-contract/**` | 单后端 API 契约验证基础 |
| `tests/unit/**` | Web/TypeScript 单元测试 |
| `e2e/**` 中 Web 用例 | Team、Kanban、Session 的浏览器回归 |
| `public/**` | Web 静态资源 |
| `docker/**`, `Dockerfile`, `docker-compose.yml` | Web 容器构建与部署 |
| `vercel.json` | Web cron 与 Vercel 部署配置 |
| `api-contract.yaml` | Web API 的单一契约 |
| `next.config.ts` | Web 构建配置，移除桌面分支后保留 |
| `tsconfig.json`, `vitest.config.ts`, `playwright.config.ts` | Web 编译与测试配置 |
| `package.json` / lockfile | Web 依赖与脚本基线 |

### 5.2 P0：明确的桌面运行时删除候选

只有在 Phase 1 建立 Web 基线后才能删除：

| 路径或配置 | 处理方式 |
|---|---|
| `apps/desktop/**` | 删除 Tauri shell、Rust embed、桌面配置与资源 |
| 根 `package.json` 的 `workspaces` | 同步移除 `apps/desktop`，否则 `npm ci` 失败 |
| `Dockerfile` 的 desktop workspace COPY | 同步删除 `COPY apps/desktop/package.json ...` |
| `playwright.tauri.config.ts` | 删除 |
| `e2e/tauri-backend-check.spec.ts` | 删除 |
| 其他仅验证 Tauri/static-export 的 E2E | 逐项确认后删除或改成 Web 用例；`e2e/desktop-shell-visual.spec.ts` 实际是 Web viewport 回归，必须保留并在后续重命名 |
| `scripts/build/build-desktop-bundle.mjs` | 删除 |
| 桌面专用启动/打包脚本 | 从 `package.json` 删除 |
| `.github/workflows/tauri-build.yml` | 删除 |
| `.github/workflows/tauri-release.yml` | 删除 |
| Tauri 插件依赖 | 删除 |
| `tsconfig.desktop.json` | 无引用后删除 |
| `ROUTA_BUILD_STATIC` 与页面 placeholder guards | 删除静态桌面导出分支；逐页保留正常 Web 路由 |

Phase 2 还必须剥离 `src/` 中的桌面分支，不能只删除 `apps/desktop`。允许且要求修改：

- `src/core/platform/tauri-bridge.ts`：删除 Tauri bridge；保留 Web/server bridge。
- `src/core/platform/index.ts`：移除 Tauri 检测与注册说明，保持 Web platform API。
- `src/client/utils/diagnostics.ts`：移除 Tauri marker、端口回退与 Tauri log bridge。
- `src/client/rpc-client.ts`：删除 Tauri IPC 分支，固定使用 HTTP `/api/rpc`。
- `src/client/utils/external-links.ts`：删除 Tauri open-url 分支，保留 Web 安全打开逻辑。
- `src/client/components/agent-install-panel.tsx`：删除 Tauri registry/install 分支，保留 Web API 路径。
- `src/client/components/repo-picker.tsx`：删除 native dialog 分支，保留 Web 输入/选择流程。
- `src/client/components/terminal/pty-terminal.tsx`：若只提供 Tauri PTY，则删除组件及入口；若 Web 页面仍有消费者，先提供明确的 Web terminal 替代或 disabled state characterization test。
- 对应 Tauri-only tests、mocks、types 和 i18n 文案同步清理。

### 5.3 P1：解除双后端后删除

以下内容不能与 Tauri 目录一次性盲删。最终目标是删除全部 Rust/Cargo 代码，但必须先证明 Next.js Web 已覆盖同一产品行为和仍被 Web 消费的工具能力：

| 范围 | 目标处理 |
|---|---|
| `crates/routa-server/**` | 移除 Rust/Axum 产品 API 后端 |
| `crates/routa-core/**` | 在行为测试移植后移除 |
| `crates/routa-rpc/**` | 与 `routa-core` 一并移除；Web `/api/rpc` 是独立 TypeScript 实现 |
| `crates/routa-cli/**` | 先移植 Web 调用能力，再删除 CLI、server 子命令和发布链 |
| `crates/entrix/**` | 先为 Kanban fitness workbench 提供 TypeScript/Node 执行器，再删除 |
| `crates/routa-scanner/**`, `crates/feature-trace/**`, `crates/trace-parser/**` | 无 Web 必要消费者后删除；有消费者则先移植 |
| `crates/harness-monitor/**` | 独立桌面/TUI 产品，不属于 Loom-team Web，删除 |
| `Cargo.toml`, `Cargo.lock` | 所有 Rust 能力移植且 crate 删除后删除 |
| `packages/routa-cli/**`, `packages/harness-monitor/**` | 删除对应二进制分发包 |
| Rust API tests | 用 Web API/Vitest/Playwright 覆盖后删除 |
| `ROUTA_RUST_BACKEND_URL` rewrite | 从 `next.config.ts` 删除 |
| `api:test:rust` | 从脚本与 CI 删除 |
| Next/Rust parity scripts | 改为单后端 schema/route contract 检查 |
| Rust server port `3210` 约定 | 从客户端与文档删除 |

根 `Cargo.toml` 的 workspace members 必须随每个 crate 删除同步更新。在最终删除 `Cargo.toml` 前，每个中间提交都必须保持剩余 workspace 可解析，禁止产生“目录已删、member 仍在”的中间状态。

当前 Web 对 Rust 命令的已知依赖必须显式移植：

| Web 能力 | 当前 Rust 依赖 | 目标实现 |
|---|---|---|
| Kanban fitness workbench `/api/fitness/run` | `entrix` binary 或 `cargo run -p entrix` | Node fitness runner，直接编排保留的 npm/schema/security/test 命令并返回兼容 JSON |
| `/api/graph/analyze` | `routa-cli graph analyze` | TypeScript graph analyzer/dependency-cruiser adapter |
| `/api/harness/instructions` audit | `routa-cli specialist run` | 复用现有 Web ACP/Specialist 执行路径 |
| Feature tree generation | `routa-cli feature-tree` | 直接调用 `src/core/spec/feature-tree-generator.ts` 的 TypeScript API |
| Fitness architecture DSL | `routa-cli fitness arch-dsl` | 保留并使用 `scripts/fitness/architecture-rule-dsl.ts` 或抽取共享 TS 模块 |

Web API 的 JSON/status/error 合约必须在移植前以 characterization tests 锁定。移植完成前不得删除对应 Rust crate；不得用隐藏按钮、返回占位数据或删除 Kanban fitness 入口代替移植。

### 5.4 P1：客户端请求层的处理

当前大量组件调用 `desktopAwareFetch()`。迁移时禁止在一个提交中机械改写所有调用点。

推荐顺序：

1. 保留 `desktopAwareFetch` 导出，先将其内部行为简化为同源 Web 请求。
2. 保留 `resolveApiPath` 对 `/api` 前缀的规范化。
3. 移除 Tauri marker、`__TAURI__` 检测、`127.0.0.1:3210` 回退和桌面日志桥接。
4. 将名称迁移为 `apiFetch` 作为后续独立重构；首轮可保留旧名称避免大范围无意义 diff。

目标实现语义：

```ts
export function desktopAwareFetch(path: string, options?: RequestInit) {
  return fetch(resolveApiPath(path), options);
}
```

上例只说明目标语义，不要求原样复制；必须保留现有错误处理、测试和 API path 规则。

### 5.5 P1：`next.config.ts` 目标边界

保留：

- 普通 Next.js build
- `serverExternalPackages`
- Agent SDK 与 Specialist 的 output file tracing
- Web 所需的 memory optimization
- Web 部署所需的 allowed origins

删除：

- `ROUTA_BUILD_STATIC`
- `ROUTA_DESKTOP_SERVER_BUILD`
- `ROUTA_RUST_BACKEND_URL`
- 桌面 `.next-desktop` 输出目录
- 桌面 static export 条件分支

`ROUTA_DESKTOP_STANDALONE` 不能直接删除，因为它当前同时驱动 Docker Web 的 `.next/standalone` 输出。处理方式：

1. 重命名为 `ROUTA_WEB_STANDALONE`。
2. 同步修改 `package.json` 的 `build:docker`。
3. 同步修改 `next.config.ts` 的 standalone 条件分支。
4. 同步修改 `Dockerfile` 注释和构建假设。
5. 验证 `.next/standalone/server.js` 与 SQLite chunk 仍被正确生成。

`ROUTA_PAGE_SNAPSHOT_SERVER` 若仍被 Web 视觉测试使用则保留，不得因名称相似而删除。

### 5.6 最终代码去冗余边界

“没有冗余”在本迁移中指可以通过静态证据和行为验证确认的无效代码全部移除，而不是以最少文件数为目标。最终仓库不得存在：

- Tauri、桌面静态导出、Rust product server 或端口 `3210` 的生产代码残留
- 同一 API 同时存在 Next.js 与已废弃 Rust 后端实现
- 仅被已删除桌面入口引用的组件、hooks、脚本、配置和资源
- `package.json` 中没有任何生产、构建、测试或治理消费者的依赖和 scripts
- Cargo workspace 中没有保留理由、没有 CI 消费者的 crate
- 没有页面入口、API 入口、测试入口或运行时动态加载证据的孤立模块
- 已被新 Web 实现取代、且调用点为零的兼容 wrapper
- 指向已删除路径的文档、workflow、tsconfig include、构建脚本或测试配置
- 同一领域规则在多个新位置复制粘贴形成的迁移期重复实现
- 临时 adapter、feature flag、fallback、TODO 或注释掉的旧实现长期留在最终状态

以下内容不能只凭静态“未引用”结果删除：

- Next.js 文件系统路由
- 动态 import/require 目标
- Agent provider 与 runtime registry
- Specialist、skill、MCP 和资源目录
- Next.js output file tracing 明确包含的文件
- CLI、脚本、GitHub Actions 或 release 流程通过字符串调用的入口
- 数据库 migration 和向后兼容读取路径

每个删除批次必须提交一份简短证据，至少包含：

1. 删除候选的入口与反向依赖搜索结果。
2. 动态加载、配置引用和 CI 调用检查。
3. 删除前后构建与相关测试结果。
4. 为什么不会损坏 Team、Kanban、ACP、Session 和数据兼容性。

允许保留的代码必须至少满足一个条件：

- 被 Web 产品运行时直接或间接使用
- 被构建、测试、迁移、CI、发布或仓库治理明确使用
- 为数据或 API 向后兼容所必需，并有测试证明
- 已登记为暂时保留项，写明 owner、原因和后续删除条件

### 5.7 非核心资产的明确处置

为避免 Phase 7 把未分类资产当成死代码，默认处置如下：

| 资产 | 决策 | 理由或删除条件 |
|---|---|---|
| `apps/vscode/**` 与 `vscode:*` scripts | 删除 | VS Code extension 不是 Web 产品；先确认无 Team runtime import |
| Docusaurus 配置、docs scripts、`docs-pages.yml` | 保留 | 作为 Loom-team Web 的开发和架构文档站，更新品牌与内容 |
| Storybook、Chromatic、storybook governance | 保留 | Team/Kanban UI 复杂，属于设计系统和视觉回归门禁 |
| `packages/office/**`, `packages/office-render/**` | 删除候选 | 当前 `src/` 无运行时 import；先移除仅有的 workspace/transpile/scripts 引用并通过 build/canvas tests |
| `packages/routa-cli/**`, `packages/harness-monitor/**` | 删除 | 对应最终移除的 Rust 二进制分发 |
| `tools/hook-runtime/**` 与 `.husky/**` | 保留 | Git 提交、pre-push 和 co-author 治理仍在使用 |
| `tools/codemods/**` 及其他 `tools/**` | Phase 7 逐项审计 | 有 package script、CI 或文档消费者则保留，否则删除 |
| `resources/canvas/**`, `resources/flows/**` | 保留 | 存在静态 import 或运行时目录扫描，且被 Kanban/Workflow 消费 |
| `Dockerfile`, `docker/**`, `docker-compose.yml` | 保留并改为 Web-only | 生产 Web 容器路径，不属于桌面能力 |
| `vercel.json` | 保留 | Web cron 调用 `/api/schedules/tick` |
| `src/instrumentation.ts` | 保留 | Web 后台服务和 telemetry 启动入口 |
| Feature Explorer/Harness/Fitness Web 页面 | 默认保留 | Kanban fitness 和治理 UI 有真实消费者；Rust 依赖先移植，任何产品删减需另行授权 |

上述“删除候选”只有在引用扫描、动态加载检查、测试和 Web build 全部通过后才能删除。默认保留项若最终被证明完全无消费者，也必须通过独立提交和证据处理，不能在平台迁移提交中顺手删除。

## 6. 数据与存储边界

### 6.1 首轮保留现有存储选择

首轮迁移继续支持：

- `DATABASE_URL` -> Postgres
- `ROUTA_DB_DRIVER=sqlite` -> SQLite
- 测试或轻量场景 -> InMemory

不得在平台迁移中同时强制所有环境改用 Postgres，也不得删除 SQLite，因为它是 Web 本地开发路径，不是桌面专属能力。

### 6.2 必须保留的数据对象

至少保留当前 schema 中以下对象及关联：

- `workspaces`
- `codebases`
- `agents`
- `tasks`
- `kanbanBoards`
- `notes`
- `messages`
- `acpSessions`
- `sessionMessages`
- `traces`
- `skills`
- `workspaceSkills`
- `customMcpServers`
- `worktrees`
- `specialists`
- `artifacts`
- `artifactRequests`

`workflowRuns`、`backgroundTasks`、`schedules` 等自动化表不得在首轮删除。应先证明 Team/Kanban 工作流没有读取或写入，再作为后续产品裁剪处理。

### 6.3 数据迁移策略

本次仓库迁移默认只迁移代码，不迁移现有生产数据。如果需要数据迁移，必须新增独立计划，至少定义：

- 源数据库与目标数据库
- schema 版本
- 数据导出、导入和回滚
- ID 与外键保持策略
- Session transcript 与本地 trace 文件迁移
- Codebase/Worktree 本地路径在新部署环境中的有效性

## 7. API 边界

### 7.1 Team 核心 API 集合

以下 API 是最低保留集合，但不是完整删除白名单：

- `/api/workspaces/**`
- `/api/codebases/**`
- `/api/worktrees/**`
- `/api/team-runs/**`
- `/api/sessions/**`
- `/api/tasks/**`
- `/api/agents/**`
- `/api/specialists/**`
- `/api/acp/**`
- `/api/kanban/**`
- `/api/notes/**`
- `/api/artifacts/**`
- `/api/mcp/**`
- `/api/rpc`
- `/api/fitness/**`（Kanban fitness workbench 直接消费）
- `/api/canvas/**`
- `/api/harness/task-adaptive/**`
- `/api/workflows/**`
- `/api/schedules/**`（包括 `vercel.json` cron 调用的 `/api/schedules/tick`）
- Team/Kanban 当前调用的 Git、file changes 和 runtime API

Agent 必须根据静态引用、API 合约和运行 walkthrough 识别补充依赖，不得把本列表当作“列表之外都可以删除”。

### 7.2 API 合约处理

保留：

- `api-contract.yaml`
- OpenAPI/schema validation
- Next.js API contract tests
- breaking-change 检查（调整为单后端基线）

删除或重写：

- “Next route 与 Rust route 数量/方法一致”的检查
- Rust runtime contract test job
- Rust-only API 文档证据

迁移中不得无意改变：

- HTTP method
- status code
- query 参数
- JSON 字段和 nullability
- SSE event 类型
- Team/Task/Session 的过滤与归属语义

## 8. Agent 执行计划

每个阶段都应单独建立分支或至少使用独立 baby-step commits。一个 Agent 不得跨越多个阶段提交混合修改。

### Phase 0：建立源基线

目标：证明迁移前 Web Team 主流程可运行，并记录可比较的基线。

任务：

1. 使用干净的源 commit 作为迁移基线，记录 SHA。
2. 不把当前工作树中未提交、与迁移无关的文件带入目标仓库。
3. 记录 Node/npm 版本和必要系统依赖。
4. 安装依赖并验证 Web build。
5. 运行 Team、Kanban、Session、ACP 相关测试。
6. 保存测试命令和结果文本，不提交截图、录屏和构建产物。
7. 使用临时 SQLite 数据库验证 schema 初始化、启动和重启后读取。
8. 记录当前 Entrix、API contract 和 page snapshot 门禁结果，作为后续替换基线。

最低验证：

```bash
npm ci
npm run lint
npm run test:run
npm run api:schema:validate
npm run snapshots:validate
npm run build
```

另起本地 Web server 后运行：

```bash
npm run db:sqlite:push
npm run api:test:nextjs
```

SQLite 冒烟必须通过 `ROUTA_DB_DRIVER=sqlite` 和一个专用临时 `ROUTA_DB_PATH` 执行，不得复用或覆盖源仓库现有数据库。迁移前的 Entrix 基线还应运行 `entrix run --tier fast` 和 `entrix run --tier normal`；Rust 全部移除后由 Phase 5 定义的 Web-only 门禁替代。

若全量测试已有与迁移无关的失败，必须记录为 baseline exception；不能静默忽略，也不能在迁移提交里顺手修复。

### Phase 1：创建 Loom-team 基线仓库

目标：目标仓库首先能运行未经裁剪的 Web 基线。

本阶段及后续阶段的固定工作目录是：

```text
/Users/xie/Documents/vibecoding/Loom-team
```

每个 Agent 开始写操作前必须运行 `pwd` 和 `git remote -v`，确认没有在源仓库工作。若该目录不存在、不是预期仓库或 remote 不指向 `xhxfafafa/Loom-team`，应停止写操作并报告，不得自行改写其他目录。

推荐保留 Git 历史。目标 GitHub 仓库为空时，使用现有 Routa 工作副本或 clone 创建迁移分支，再把新仓库设为新的 push remote。不要在 Routa 工作目录内执行 `git init`，也不要用 `echo >> README.md` 制造无关差异。

源仓库实际地址为 `https://github.com/xhxfafafa/Loom-v2.git`。目标目录不存在时的建议流程：

```bash
git clone https://github.com/xhxfafafa/Loom-v2.git /Users/xie/Documents/vibecoding/Loom-team
cd /Users/xie/Documents/vibecoding/Loom-team
git remote rename origin upstream
git remote add origin https://github.com/xhxfafafa/Loom-team.git
git branch -M main
git push -u origin main
```

若目标目录已存在，必须先检查它是否为空仓库、当前分支和 remote，不得再次 clone 或覆盖。由于本文档当前可能尚未进入源仓库历史，Phase 1 必须显式把最终评审版文档复制到目标仓库的 `docs/design-docs/`，在任何删除提交之前单独提交并推送。

如果目标仓库已含初始化提交，应先判断能否 fast-forward。禁止用 `--force` 覆盖远端；需要替换远端历史时必须获得仓库所有者明确授权。

验收：

- 目标仓库的 baseline SHA 可追溯到源仓库
- `npm ci`、`npm run dev` 和 `npm run build` 工作
- Team 与 Kanban 页面在未删除桌面代码前可访问
- `git remote get-url origin` 返回 `https://github.com/xhxfafafa/Loom-team.git` 或等价 SSH 地址
- baseline 分支已经推送到 GitHub，且本地 commit SHA 能在远端查询

### Phase 2：移除 Tauri 产品壳

目标：删除桌面包装和 `src/` 中的 Tauri 分支，同时保持 Web 领域行为不变。

允许修改：

- `apps/desktop/**`
- Tauri build/release workflow
- 桌面 Playwright config 与纯桌面测试
- root `package.json` 的 Tauri/desktop scripts
- root `package.json` 的 `workspaces` 数组与 lockfile
- `Dockerfile` 中 desktop workspace COPY
- 桌面构建脚本和桌面文档入口
- §5.2 点名的 platform、RPC、external link、Agent install、repo picker 与 terminal 文件
- 带 `ROUTA_BUILD_STATIC` 的页面和对应 characterization tests

禁止修改：

- `src/core/orchestration/**`
- `src/core/kanban/**`
- `src/core/acp/**`
- Team/Kanban 的领域状态机与编排逻辑；允许为移除桌面 UI 分支做最小组件修改
- DB schema

验证：

```bash
npm ci
npm run lint
npm run test:run
npm run build
rg -n "@tauri-apps|__TAURI__|isTauriRuntime|tauri:dev|tauri:build|playwright\.tauri|apps/desktop|ROUTA_BUILD_STATIC" src package.json next.config.ts Dockerfile .github scripts e2e tests
```

最后一条搜索若命中测试 fixture，必须逐项确认它用于防回归而非继续模拟桌面运行；生产代码、有效构建和 CI 入口不得再有命中。

### Phase 3：把请求层收敛为 Web-only

目标：浏览器请求始终落到同源 Next.js `/api`。

任务：

1. 为 `resolveApiPath` 和请求封装补充/调整 characterization tests。
2. 移除 Tauri runtime marker 与 `window.__TAURI__` 分支。
3. 移除桌面默认端口和 desktop static error。
4. 保持所有现有调用点继续工作。
5. 删除只用于设置桌面后端地址的 UI。
6. 锁定 `src/client/acp-client.ts` 的 SSE URL 构造。
7. 锁定 `src/client/hooks/use-kanban-events.ts` 与 `use-notes.ts` 的相对 EventSource URL。
8. 锁定 `src/client/rpc-client.ts` 始终走 HTTP `/api/rpc`。
9. 验证所有原 `ROUTA_BUILD_STATIC` 页面在普通 Next.js dynamic route 下工作。

验证搜索：

```bash
rg -n "__TAURI__|isTauriRuntime|ROUTA_RUST_BACKEND_URL|127\.0\.0\.1:3210|routa\.backendBaseUrl" src scripts e2e tests next.config.ts package.json
```

目标是无生产运行时命中；测试 fixture 或迁移说明中的命中应逐项解释。

### Phase 4：移植 Rust-backed Web 能力并移除 Rust/Cargo

目标：Next.js/Node 成为唯一产品运行时，同时不降低 Team、Kanban、Fitness、Harness 和 Feature Tree 的现有 Web 行为覆盖。

执行前置条件：

- Phase 0 的 Web 测试通过
- Team/Kanban 关键行为在 TypeScript/Vitest 或 Web API 测试中有证据
- Rust 测试中独有的 Team/Kanban 行为已经移植为 Web 测试
- `tests/api-contract` 已新增 `team-runs` 与 `kanban` suite，或有等价 route-level integration tests
- 已有 Team 页面 Playwright 用例覆盖创建、子 Session 展示、刷新恢复与删除 preview/confirm
- §5.3 列出的 Rust-backed Web 能力已各自获得 TypeScript 替代实现及兼容测试

重点迁移 Rust 独有验证：

- `GET /api/tasks?teamRunId=&workspaceId=` 的 Workspace 隔离
- Team chain ID 校验
- Session lifecycle 与 recovery
- Task 状态机非法转移
- Kanban import/export 与事件持久化
- Codebase/Worktree 的负向路径
- Team Run 删除聚合行为

已确认 Web 已覆盖、应保留的现有测试证据：

- Workspace + `teamRunId` 隔离：`src/app/api/tasks/__tests__/route.test.ts`
- Team chain 校验：`src/core/orchestration/__tests__/team-chain.test.ts`
- Session finalization/recovery：`src/core/acp/__tests__/session-runtime-finalizer.test.ts`、`session-runtime-recovery.test.ts`
- Team Run 聚合删除：`src/core/orchestration/__tests__/team-run-deletion.test.ts`

必须补齐的缺口：

- Team Run API contract suite
- Kanban board CRUD/import/export API contract 或 route tests
- Task 状态机非法转移 Web 负向测试
- Kanban event persistence Web 测试
- Team 页面创建、子 Session、刷新恢复和删除 Playwright 流程

任务：

1. 生成 Rust API 测试能力清单。
2. 对每项标记 `already-covered`、`ported-to-web` 或 `not-product-relevant`。
3. 先提交新增的 Web characterization tests。
4. 按 §5.3 的表逐项移植 Entrix、graph、instruction audit、feature tree 和 architecture DSL。
5. 移植完成并通过调用方测试后，先删除 Rust binary/package release 链。
6. 按 crate 分批删除 `routa-server`、`routa-core`、`routa-rpc`、`routa-cli` 及其余 crates；每批同步更新根 `Cargo.toml` members。
7. 所有 crates 删除后删除根 `Cargo.toml`、`Cargo.lock` 和 Rust-only workflows/scripts/docs。
8. 删除 proxy、端口、Rust API 测试和 parity job。
9. 将 API 检查改成 schema + Next route coverage。

禁止用 `ALLOW_MASS_DELETE=1` 或 `--no-verify` 绕过仓库保护。每个 crate/能力使用独立提交，确保单次删除少于 `.husky/pre-commit` 的 200 文件阈值，并让每个中间 commit 可构建或至少可被下一步明确恢复。

禁止在缺少替代测试时直接删除 Rust 测试。

### Phase 5：收敛 CI、Fitness 与发布

目标：CI 只验证实际存在的 Web 产品和明确保留的仓库工具。

至少保留：

- ESLint
- TypeScript typecheck
- Vitest fast/full
- Next.js build
- API schema validation
- Next API contract tests
- Playwright Web E2E
- npm audit/security scan
- Design system、accessibility 和必要视觉检查
- page snapshot validation
- dependency-cruiser

移除：

- Tauri build/release
- Rust server API tests
- 双后端 parity
- 只检查已删除 crate 的 clippy/cargo audit job
- `rust_test_pass`、cargo audit、clippy 和 Rust coverage gates
- `cli-release.yml`、`entrix-release.yml`、`harness-monitor-release.yml`、Cargo release 与对应 npm binary release scripts

必须逐项处置：

- `scripts/fitness/check-api-parity.ts`：改成 `api-contract.yaml` 对 Next routes 的单后端检查，保留 `api:check` 名称可减少 CI diff。
- `scripts/fitness/validate-api-parity.ts`：删除 Rust/3210 runtime 对比，改成 Next runtime contract smoke 或删除重复入口。
- `scripts/fitness/rust-coverage.ts` 与 `rust:cov*` scripts：删除。
- Entrix `api_contract_parity` gate：由新的 Web contract gate 替代。
- Entrix `rust_test_pass`：删除，不得伪装成 Web 测试；Web 全量测试使用独立明确命名的 hard gate。
- `fitness:fluency` 与 `scripts/fitness/check-backend-architecture.ts`：切到 TypeScript/Node 实现。

Phase 5 完成后，`entrix run` 不再是目标仓库验收前提；等价 Web-only gate 必须通过 npm scripts 暴露并在 CI 中执行。

### Phase 6：品牌与文档收口

目标：只在功能迁移稳定后处理名称和说明。

任务：

- 更新 README 的产品名称与 Web-only 架构
- 更新开发、部署和环境变量说明
- 删除桌面安装与 Tauri 调试说明
- 更新架构图为单后端
- 更新 `api-contract.yaml` 的 server 描述
- 决定环境变量前缀是否继续使用 `ROUTA_`

首轮可以保留内部类名、localStorage key 和环境变量名，避免一次高风险全局重命名。重命名必须是独立阶段。

### Phase 7：去冗余与最终瘦身

目标：在行为稳定、桌面和双后端已移除后，清理迁移过程中遗留的死代码、依赖、配置和重复实现。

本阶段必须最后执行，不能提前与 Tauri/Rust 后端删除混在同一个提交中。

任务：

1. 从页面、API、CLI、scripts、workflow 和动态资源入口生成实际入口清单。
2. 使用 `rg` 和 dependency-cruiser 检查反向依赖、循环依赖和越层依赖。
3. 审计 `package.json` 的 dependencies、devDependencies 和 scripts。
4. 确认 `Cargo.toml`、`Cargo.lock`、`crates/**`、Rust binary packages 和 Rust release workflows 已全部移除。
5. 搜索所有 desktop/Tauri/Rust backend 环境变量、端口、路径和兼容分支。
6. 清理已删除功能对应的测试 fixture、mock、类型、CSS、i18n key 和静态资源。
7. 清理无消费者 export、不可达 route helper 和迁移期 adapter。
8. 对看似重复但承载领域差异的代码先补 characterization tests，再决定是否合并。
9. 每一类清理使用独立提交，并在删除后运行完整 Web 门禁。
10. 根据最终真实目录、scripts、环境变量和部署方式再次更新 README、架构与开发文档，避免 Phase 6 文档被后续删除操作写旧。

建议验证命令：

```bash
npm run lint
npx tsc --noEmit
npx --yes dependency-cruiser --config .dependency-cruiser.cjs src --validate
npm run test:run
npm run api:schema:validate
npm run build
rg -n "__TAURI__|ROUTA_DESKTOP|ROUTA_RUST_BACKEND_URL|127\.0\.0\.1:3210|apps/desktop|routa-server|cargo run|routa-cli" . \
  -g '!node_modules/**' -g '!.git/**' -g '!.next/**'
```

最后一个搜索存在文档历史命中时，必须逐项分类。生产代码、有效配置和 CI 中不得存在残留。

## 9. Agent 工作包划分

推荐把迁移交给多个 Agent 时按以下工作包划分，避免多人同时修改核心文件：

| 工作包 | 主要范围 | 可并行性 | 交付物 |
|---|---|---|---|
| A：Baseline & inventory | 只读扫描、测试基线 | 最先独占 | 基线 SHA、命令结果、依赖清单 |
| B：Tauri removal | `apps/desktop`、platform/client 桌面分支、desktop scripts/workflows | A 后独占 | 桌面壳与 Tauri 引用删除提交 |
| C：Web request boundary | backend config、diagnostics、相关 tests | 与 D 谨慎并行 | Web-only 请求封装 |
| D：Contract migration | API tests、parity scripts、fitness docs | 可与 C 并行 | 单后端契约门禁 |
| E：Rust-backed Web port | Rust tests + Entrix/graph/audit/feature-tree -> TypeScript | D 后独占 | characterization tests 与 Node 实现 |
| F：Rust runtime removal | 全部 crates、Cargo、binary packages 与 release 链 | E 后独占 | 纯 Node/Next 仓库 |
| G：CI/release cleanup | workflows、package scripts | B/F 后 | Web-only CI |
| H：Docs/branding | README、architecture、env docs | 最后 | Loom-team 文档 |
| I：Dead-code cleanup | 全仓引用、依赖和配置审计，最后同步文档 | H 后独占 | 去冗余报告、小步删除提交与最终文档 |

并行 Agent 的文件所有权约束：

- 同一时间只有一个 Agent 可以修改 `package.json`。
- 同一时间只有一个 Agent 可以修改 `next.config.ts`。
- `src/core/routa-system.ts`、`src/core/acp/**`、`src/core/kanban/**` 必须由行为迁移负责人修改。
- 删除 crate 的 Agent 不得同时改 Team/Kanban UI。
- 每个工作包先提交测试或证据，再提交删除。
- Agent 完成后必须报告修改文件、验证命令、失败项和仍存引用。
- 所有写操作的 `cwd` 必须是 `/Users/xie/Documents/vibecoding/Loom-team`。
- 工作包 I 不得与 B、C、D、E、F、G 并行，避免把迁移中的暂时断链误判为死代码。

## 10. 迁移过程中的 Git 纪律

遵循 baby-step commits，一个提交只表达一个关注点。建议提交序列：

```text
chore(repo): establish Loom-team web baseline
test(web): characterize Team and Kanban runtime behavior
chore(desktop): remove Tauri application shell
refactor(web): collapse API routing to same-origin Next.js
test(api): port Team runtime contracts to Next.js
feat(web): port Rust-backed Web capabilities to Node
chore(backend): remove Rust and Cargo runtime
ci(web): replace dual-backend gates with Web gates
docs(web): document Loom-team architecture and setup
```

每个 commit：

- 不混入格式化整个仓库
- 不提交 `.next`、`out`、截图、录屏、数据库文件或 Agent 临时文件
- 不覆盖用户已有的未提交修改
- 不使用 `git reset --hard` 或强推
- 按目标仓库 `AGENTS.md` 要求添加恰好一条 Co-authored-by
- 不使用 `--no-verify` 绕过 `.husky/pre-commit` 或 `commit-msg`
- 单次删除不得触发 200 文件保护；按 crate/资产拆分提交

### 10.1 远端上传要求

目标 remote 固定为：

```text
origin -> https://github.com/xhxfafafa/Loom-team.git
```

每个工作包的标准交付流程：

1. 在 `/Users/xie/Documents/vibecoding/Loom-team` 确认当前分支和 remote。
2. 检查 `git status --short`，区分自己修改与用户/其他 Agent 修改。
3. 运行该工作包要求的验证。
4. 只暂存当前工作包拥有的文件。
5. 按 baby-step 原则创建 Conventional Commit，并添加一条合规 Co-authored-by。
6. 推送当前迁移分支到 `origin`。
7. 报告 branch、commit SHA、push 结果和未提交文件。

默认使用 `codex/` 前缀的工作分支，例如：

```text
codex/web-only-baseline
codex/remove-tauri-shell
codex/web-api-runtime
codex/remove-rust-backend
codex/web-only-cleanup
```

若由多个 Agent 并行执行，每个工作包使用独立分支，通过 PR 或明确的集成分支合并。未经用户授权，不得直接覆盖已有 `main`，不得使用 `git push --force` 或 `--force-with-lease`。

只有以下条件同时满足时才能上传：

- 没有 `.env`、API key、token、credential 或本地用户配置
- 没有 SQLite 数据库、trace、聊天记录或其他可能含敏感内容的运行数据
- 没有 `.next`、`out`、`target`、录屏、截图和临时文件
- 提交范围与当前工作包一致
- 必要测试通过，或提交说明中明确记录继承自 baseline 的失败

最终迁移完成时，必须确认：

```bash
git status --short
git remote -v
git branch --show-current
git log -1 --oneline
git ls-remote --heads origin
```

最终目标是迁移结果存在于 GitHub 远端可审查分支，并按仓库策略合并到 `main`。本地 commit 未 push、push 到错误 remote、或者只有未提交工作树修改都视为未完成。

## 11. 验证矩阵

### 11.1 静态与构建门禁

```bash
npm ci
npm run lint
npx tsc --noEmit
npm run api:schema:validate
npx --yes dependency-cruiser --config .dependency-cruiser.cjs src --validate
npm run test:run
npm run snapshots:validate
npm run build
```

Phase 5 必须提供一个汇总入口（建议 `npm run validate:web`）在本地和 CI 中执行上述门禁。启动 Next.js 测试 server 后，还必须运行 `npm run api:test:nextjs` 和 Team/Kanban Playwright spec。

去冗余审计还必须确认：

- dependencies/devDependencies 均有消费者
- scripts 均有人工、CI、release 或文档入口
- `Cargo.toml`、`Cargo.lock`、`crates/**` 与 Rust binary packages 均不存在
- 无桌面生产引用
- 无失效路径、孤立配置和已删除功能的测试残留
- 无为了迁移临时复制的领域实现

### 11.2 Team 主流程

必须人工或 Playwright 验证：

1. 创建或选择 Workspace。
2. 添加或选择 Codebase。
3. 打开 Team 页面。
4. 选择 Specialist/Team 配置并创建 Team Run。
5. Root Session 成功创建并显示运行状态。
6. 子 Agent/子 Session 能创建并显示父子关系。
7. Prompt 与工具调用增量可见。
8. 刷新页面后 Team Run、Task 和历史仍可恢复。
9. Team Run 列表只显示当前 Workspace 数据。
10. 删除操作先展示 preview，确认后清理正确资源。

### 11.3 Kanban 主流程

1. 创建 board、column 和 task。
2. 将 task 绑定到 Team Run 或由 Team Run 创建任务。
3. 移动卡片触发预期 lane policy。
4. 允许自动运行的列正确创建 Session。
5. UI 显示正确的 Agent、Specialist、Session、Codebase 和 Worktree。
6. 运行中 Session 阻止重复启动。
7. completed/failed Session 不永久阻止 retry。
8. Session 消息、文件变化和状态通过 SSE/event 更新到卡片。
9. 刷新后 lane history 与 task status 保持。
10. Workspace 切换后 board/task 不串数据。

### 11.4 存储矩阵

至少覆盖：

| 环境 | 存储 | 要求 |
|---|---|---|
| 单元测试 | InMemory/mock | 快速、确定性 |
| 本地 Web | SQLite | 重启后持久化 |
| CI/生产等价 | Postgres | schema 与核心 CRUD/Team flow 正确 |

### 11.5 Provider 矩阵

迁移不要求所有 provider 在线执行，但至少要验证：

- registry/specialist 列表可读取
- 一个受支持 provider 能完成 create -> prompt -> stream -> complete
- provider 不可用时错误可见，不产生永久 running Session
- 恢复和 finalizer 路径不会依赖 Tauri/Rust server

## 12. 完成定义

只有同时满足以下条件，才能宣布 Web-only 迁移完成：

- Team 与 Kanban 用户能力没有有意裁剪
- 浏览器所有产品请求只访问 Next.js Web API
- 生产运行不需要 Tauri、Axum 或 `127.0.0.1:3210`
- `npm run build` 不读取桌面目录或 Rust server 产物
- 目标构建、测试、CI 和部署均不要求 Cargo/Rust toolchain
- Team、Kanban、Session、Task、ACP 的关键测试通过
- SQLite 本地开发路径通过
- Postgres 生产路径至少有契约/集成证据
- API schema 和 Next API contract tests 通过
- Web Playwright smoke 通过
- 已移除桌面和双后端 CI job
- README、架构和环境变量文档只描述真实运行方式
- `rg` 搜索对 Tauri、Rust backend URL 和端口 3210 的生产命中为零
- 目标工作目录确认为 `/Users/xie/Documents/vibecoding/Loom-team`
- 依赖、scripts、routes、exports、配置和资源均有可说明的实际消费者
- 已完成独立 Phase 7 去冗余审计，所有暂时保留项都有 owner、理由和删除条件
- 没有提交构建产物、截图、数据库或 Agent 临时文件
- 所有迁移提交已经推送到 `xhxfafafa/Loom-team` 的远端分支
- 最终远端 commit SHA 与本地验收使用的 commit SHA 一致
- 迁移结果已通过 PR 或仓库约定流程合并到 `main`，或者明确处于等待用户审查的远端分支

## 13. 风险登记

| 风险 | 级别 | 缓解方式 |
|---|---|---|
| 把 Rust 独有行为随 server 一起删除 | 高 | 先做 Rust/Web 行为差异清单，再移植测试 |
| 误把 SQLite 当成桌面能力删除 | 高 | 保留 Node `better-sqlite3` Web 本地路径 |
| Team 页面可渲染但 Agent 无法执行 | 高 | 用 create/prompt/stream/complete 端到端验收 |
| Kanban 卡片状态与 Session 状态漂移 | 高 | 保留 orchestrator、queue、recovery 与 SSE 测试 |
| 批量替换 `desktopAwareFetch` 引入 URL 错误 | 中 | 先缩小实现，不批量改调用点 |
| 删除 Cargo workspace 导致 Fitness/CI 消失 | 高 | 先将 Web 消费的 Entrix/CLI 能力移植到 Node，并建立 `validate:web` |
| 新仓库失去源历史与问题追溯 | 中 | 优先保留 Git history 和 source SHA |
| 品牌重命名造成环境变量/存储 key 失效 | 中 | 放到稳定后的独立阶段 |
| 本地路径/Worktree 在云部署不可用 | 中 | 明确部署模型；不要在迁移阶段假设 SaaS runner |
| 多 Agent 并行修改共享配置产生冲突 | 中 | 使用工作包所有权和 baby-step commits |

## 14. Agent 开工模板

每个实施 Agent 开工前应在回复或任务记录中填写：

```text
Work package:
Source baseline SHA:
Working directory: /Users/xie/Documents/vibecoding/Loom-team
Owned paths:
Explicitly out-of-scope paths:
Behavior/tests that must remain green:
Expected commits:
```

完成时填写：

```text
Changed files:
Deleted files:
Tests added before deletion:
Commands run and results:
Remaining desktop/Rust references:
Known failures inherited from baseline:
Follow-up required:
Git branch:
Commit SHA(s):
Remote push result:
PR URL (if created):
```

## 15. 最终原则

当“删除更多代码”和“保持 Team/Kanban 行为”发生冲突时，优先保持行为。无法证明无用的模块先保留并登记，不得猜测删除。

“无冗余”不是一次激进删除，而是完成行为迁移后，用入口清单、反向依赖、动态加载审计、测试和构建逐项证明。无法证明安全删除的代码不得由 Agent 自行裁剪；暂时保留时必须形成显式记录，不能成为无人负责的永久遗留。

本迁移的成功标准不是仓库最小，而是：

> Loom-team 只用 Web 运行时部署，但用户看到的 Team、Kanban 和多 Agent 协作能力与迁移前一致。

## 16. 评审处置与修订记录

本节记录对 2026-08-14 独立技术评审的处理。修订不是逐字接受评审，而是以“Team/Kanban 行为不裁剪、最终纯 Next.js/Node、无冗余”为决策标准重新确定边界。

### 16.1 P0/P1 处置矩阵

| Finding | 处置 | 独立判断与正文落点 |
|---|---|---|
| P0-1 `src/` Tauri 引用遗漏 | 接受 | §5.2 与 Phase 2 已点名 platform、RPC、external links、Agent install、repo picker、PTY、diagnostics；platform 只删除 Tauri bridge，不删除 Web/server bridge |
| P0-2 npm workspace 与 Dockerfile | 接受 | Phase 2 要求同步更新 root workspace、lockfile 和 Dockerfile COPY |
| P0-3 standalone 标志复用 | 接受并调整 | 不删除 standalone 能力；将 `ROUTA_DESKTOP_STANDALONE` 改名为 `ROUTA_WEB_STANDALONE`，保持 Docker Web 构建 |
| P0-4 Cargo members 与 `routa-rpc` | 接受并扩大 | 不只处理三个产品 crate；最终删除全部 Rust crates、Cargo files 与 binary packages，每批同步 members |
| P1-1 `routa-cli` 去留矛盾 | 接受，决定删除 | 最终不保留 `routa-cli`；其 Web 消费能力必须先移植到 Node，相关 release/fitness/architecture 调用同步替换 |
| P1-2 parity 与 Entrix gates 不明确 | 接受 | Phase 5 点名 parity、runtime parity、rust coverage、`api_contract_parity` 和 `rust_test_pass` 的改写或删除 |
| P1-3 Team/Kanban 测试缺口 | 接受 | Phase 4 增加 Team Run/Kanban contract、状态机负向、事件持久化和 Team Playwright 前置条件 |
| P1-4 强制门禁遗漏 | 接受但改变终态 | Phase 0 保存 Entrix 基线；Phase 5 用 `validate:web` 替代 Rust Entrix 总入口，并保留 schema、API、snapshot、dependency、Vitest、Playwright 门禁 |
| P1-5 未决资产 | 接受 | §5.7 已明确 VS Code、Docs、Storybook、Office、tools、Vercel、Docker、Canvas/Flows 和 Web governance surfaces 的默认处置 |

### 16.2 P2/P3 处置摘要

- 保留表已补充 Canvas/Flows、instrumentation、样式/主题/类型、测试、Docker、Vercel 和核心配置。
- API 保留集合已补充 RPC、Fitness、Canvas、Harness task-adaptive、Workflow 与 Schedule。
- Phase 3 已点名 SSE、EventSource、RPC HTTP 和 static route guard 测试。
- Phase 4 明确按 crate 小步删除，不绕过 Husky 200 文件保护或 commit-msg hook。
- Phase 0 已加入临时 SQLite 和 Next API contract 基线。
- 移除过时的 `out/workspace/__placeholder__/` 删除项。
- 明确 `e2e/desktop-shell-visual.spec.ts` 是 Web 视觉测试，禁止按名称删除。
- Phase 1 使用真实源地址，并要求把未跟踪的最终文档显式复制、提交到目标仓库。
- Phase 3 的残留搜索扩展到 `scripts/`、`e2e/`、`tests/` 和 root config。

### 16.3 修订后的阶段准入结论

- Phase 0、Phase 1 可以开始。
- Phase 2 只有在 Web build 基线、Tauri 引用清单和相关 characterization tests 就绪后才能开始。
- Phase 4 只有在 Team/Kanban 测试缺口补齐、Rust-backed Web 能力全部完成 Node 移植后才能删除 Rust。
- 文档层面的 P0/P1 已形成明确处置，但这不等于执行前置条件已经满足。任何 Agent 不得仅凭本节把删除阶段标记为可立即执行。

## 17. 参考实现位置

- `docs/ARCHITECTURE.md`
- `docs/adr/0001-dual-backend-semantic-parity.md`
- `docs/adr/0002-provider-normalization-via-acp.md`
- `docs/adr/0003-workspace-first-scope.md`
- `docs/adr/0004-kanban-driven-automation.md`
- `docs/adr/0007-kanban-delivery-transition-policies.md`
- `src/core/routa-system.ts`
- `src/core/orchestration/team-*.ts`
- `src/core/kanban/**`
- `src/core/acp/**`
- `src/app/workspace/[workspaceId]/team/**`
- `src/app/workspace/[workspaceId]/kanban/**`
- `src/app/api/team-runs/**`
- `src/app/api/sessions/**`
- `src/app/api/tasks/**`
- `src/app/api/kanban/**`
- `src/client/config/backend.ts`
- `src/client/utils/diagnostics.ts`
- `src/client/rpc-client.ts`
- `src/core/platform/**`
- `src/instrumentation.ts`
- `src/core/fitness/entrix-runner.ts`
- `src/core/spec/feature-tree-cli.ts`
- `src/app/api/graph/analyze/route.ts`
- `src/app/api/harness/instructions/route.ts`
- `Dockerfile`
- `vercel.json`
- `.husky/**`
- `tests/api-contract/run.ts`
- `api-contract.yaml`

## 18. 独立技术评审

- 评审日期：2026-08-14
- 评审基线：源仓库 `/Users/xie/Documents/vibecoding/Loom-v2/routa`，HEAD `ff6ac33c`（main 分支，共 4162 个提交），工作树含少量未跟踪文件（含本文档）
- 评审方式：将本文档逐条与仓库实际代码对照，包括结构核查（目录/配置/脚本/CI）、Team/Kanban 依赖闭包追踪、桌面/Tauri/3210 全量引用扫描、Cargo crate 依赖图分析、Web 测试覆盖盘点；并核实目标仓库 `https://github.com/xhxfafafa/Loom-team.git` 当前为空仓库（`git ls-remote --heads` 无分支）
- 评审范围：仅评审本迁移文档，未修改任何项目代码

### 18.1 评审结论

**APPROVED_WITH_CHANGES**

文档的整体结构、阶段划分、证据驱动删除原则（§5.6）、baby-step 提交纪律（§10）和风险登记（§13）质量很高，核心判断（Team 不切割、Kanban 是控制面、SQLite 属于 Web 路径、先复制基线再删除）与代码事实一致。已验证的正确点包括：

- Team/Kanban 的 import 闭包确实落在 `src/app/**`、`src/client/**`、`src/core/**` 内（入口：`src/app/workspace/[workspaceId]/team/team-page-client.tsx`、`src/app/api/kanban/boards/route.ts` 等），§5.1 的保留策略方向正确；
- `desktopAwareFetch` 约 225 个调用点、`resolveApiPath` 约 36 个调用点，§5.4 "保留导出、收缩实现、不批量改调用点"的策略是安全的；
- 服务端代码（`src/app/api/**`、`src/core/**` 生产路径）不引用 Tauri/3210，桌面逻辑集中在客户端与 `src/core/platform/`，删除面可控；
- Docker 部署路径（`Dockerfile`、`docker-compose.yml`）本身不依赖 Rust/Tauri 运行时。

但存在 4 个 P0 级执行性缺陷（照文档原文执行会直接导致构建失败）和若干 P1 级边界矛盾，必须先修订再进入删除阶段。

### 18.2 问题清单

#### P0（阻塞项：照原文执行会直接破坏构建/运行，必须在执行对应阶段前修订文档）

**P0-1 Phase 2 范围遗漏 `src/` 内的 Tauri 引用点，删除 `apps/desktop` 会直接破坏 `npm run build`。**
证据：`@tauri-apps/*` 依赖全部挂在 `apps/desktop/package.json`（根 `package.json` 无此类依赖），但 `src/` 中有 5 个非测试文件直接动态 import 它们：`src/core/platform/tauri-bridge.ts:56-76`（`@tauri-apps/api/core`、`api/event`、`plugin-shell`、`plugin-fs`、`plugin-dialog`、`api/path`）、`src/client/components/repo-picker.tsx:443`、`src/client/components/terminal/pty-terminal.tsx:119,187`。删除 `apps/desktop` workspace 后这些包不再被安装，webpack 对动态 import 的静态解析会使 `npm run build` 报 Module not found。而 Phase 2 的"允许修改"清单不含这些 `src/` 文件，"禁止修改"又声明不碰 Web 领域逻辑，实施 Agent 会陷入死锁。注意 `src/core/platform/index.ts` 的 `getServerBridge` 被 Web 运行时间接依赖（`src/core/tools/workspace-tools.ts`、`src/core/kanban/github-issues.ts`、`src/core/acp/mcp-setup.ts`、`src/core/skills/skill-loader.ts` 等），platform 层不能整目录删除，只能剥离 Tauri 分支。
修订要求：Phase 2 增加"src/ 内 Tauri 引用清理"子步骤与文件清单，或明确将这些文件的修改授权给 Phase 2。

**P0-2 删除 `apps/desktop` 必须同步修改根 `package.json` 的 `workspaces` 数组与 `Dockerfile`，否则 `npm ci` 与 Docker 构建失败。**
证据：`package.json` `"workspaces": ["apps/desktop", "packages/office-render"]`；`Dockerfile:16` `COPY apps/desktop/package.json ./apps/desktop/package.json`。§5.2 与 Phase 2 均未提及这两处同步修改。
修订要求：Phase 2 任务清单加入 workspaces 数组更新与 Dockerfile COPY 行清理。

**P0-3 §5.5 要求删除的 `ROUTA_DESKTOP_STANDALONE` 分支同时是 Docker 生产构建的 standalone 开关，与 §3.2 "不删除 Docker" 直接冲突。**
证据：`next.config.ts:5,58-69`（该 env 启用 `output: "standalone"` 及 `better-sqlite3` 的 outputFileTracingIncludes）；`package.json` `build:docker` 脚本（`ROUTA_DESKTOP_STANDALONE=1 next build && node scripts/build/build-docker.mjs`）；`Dockerfile:46-50` 注释与 `RUN npm run build:docker`。照 §5.5 删除该分支后，`.next/standalone` 不再产出，Dockerfile 的 `COPY --from=builder /app/.next/standalone` 阶段失败。
修订要求：将该分支改名为非桌面的 Web standalone 构建标志（如 `ROUTA_WEB_STANDALONE`），同步更新 `build:docker` 与文档，而不是直接删除。

**P0-4 删除 Rust 产品 crate 必须同步更新根 `Cargo.toml` 的 workspace members，且文档完全遗漏了 `crates/routa-rpc`。**
证据：根 `Cargo.toml:3-14` members 包含 `apps/desktop/src-tauri`、`crates/routa-server`、`crates/routa-core`、`crates/routa-rpc`；`crates/routa-rpc/Cargo.toml` 依赖 `routa-core`（TS 侧零引用，`src/app/api/rpc/route.ts` 是纯 TypeScript 实现，与该 crate 无关）。Phase 2 删除 `apps/desktop/`、Phase 4 删除 server/core 后，若 members 列表不同步更新，`cargo build`、`cargo test --workspace`（entrix hard gate `rust_test_pass`）与 `defense.yaml` 的 `cargo audit` 全部失败；`routa-rpc` 不删也会因失去 `routa-core` 编译失败。
修订要求：§5.2/§5.3 增加根 `Cargo.toml` members 更新任务；§5.3 将 `crates/routa-rpc` 列入删除清单并注明理由（死代码，依赖 routa-core）。

#### P1（重要问题：对应阶段执行前必须解决）

**P1-1 `routa-cli` 保留决策与 Phase 4 自相矛盾。**
证据：`crates/routa-cli/Cargo.toml` `[dependencies]` 同时依赖 `routa-core`、`routa-server`、`routa-scanner`；`crates/routa-cli/src/main.rs` 头部注释自述复用 routa-core 领域逻辑与 routa-server bootstrap（`server` 子命令直接启动 Axum）。§5.3 注意事项把 `routa-cli` 列为"不得批量删除"的治理工具，但 Phase 4 删除 core/server 后它必然无法编译，连锁破坏：`.github/workflows/cli-release.yml`（`cargo build --release --package routa-cli`）、`package.json` `fitness:fluency`（`cargo run -p routa-cli -- fitness fluency`）、`scripts/fitness/check-backend-architecture.ts`（经 `cargo run -p routa-cli` 跑 arch-dsl）。
修订要求：在 §5.3 明确二选一——routa-cli 随产品后端一起删除，或先剥离其 server 子命令再保留，并把三个连锁消费者列入改写清单。

**P1-2 parity 脚本与 entrix 门禁未逐一点名。**
证据：`scripts/fitness/check-api-parity.ts` 三方对比 `api-contract.yaml` vs Next 路由 vs `crates/routa-server/src/api/*.rs`；`scripts/fitness/validate-api-parity.ts` 双活对比 `localhost:3000` vs `localhost:3210`；`scripts/fitness/rust-coverage.ts` 默认跑 `routa-core`；`package.json` `api:check`/`api:validate`/`rust:cov*` 脚本；entrix hard gate `api_contract_parity` 引用 `npm run api:check`（见 `docs/fitness/README.md`）。§5.3 只笼统说"改为单后端检查"。Phase 4 后这些脚本与门禁会失败或失真。
修订要求：Phase 4/5 任务清单点名上述脚本、脚本对应的 npm scripts 及 entrix gate 的处置方式（改写/删除/改义）。

**P1-3 测试缺口使 Phase 4 前置条件不完备。**
证据：
- `tests/api-contract/run.ts` 的 suite 只有 workspaces/agents/tasks/notes/sessions/skills/schema-validation，**没有 team-runs 与 kanban suite**；
- `e2e/` 目录无任何 Team 页面流程 spec（创建 Team Run、子 Session、删除 preview 均只能靠 §11.2 人工 walkthrough）；
- Kanban board import/export（UI 侧调用见 `src/app/workspace/[workspaceId]/kanban/kanban-settings-modal.tsx` 的 `/api/kanban/import|export`）与 task 状态机负向转移在 Web 侧缺少显式测试，而 Rust 侧存在对应断言（`crates/routa-server/tests/rust_api_tasks_team_run.rs`、`rust_api_kanban_board_tokens.rs`、`src/api/acp_routes/team_chain_tests.rs` 等）。
已验证 Web 侧已覆盖的部分（无需移植）：workspace 隔离（`src/app/api/tasks/__tests__/route.test.ts:234`）、team chain 校验（`src/core/orchestration/__tests__/team-chain.test.ts`）、session finalization/recovery（`src/core/acp/__tests__/session-runtime-finalizer.test.ts`、`session-runtime-recovery.test.ts`）、team-run 聚合删除（`src/core/orchestration/__tests__/team-run-deletion.test.ts`）。
修订要求：Phase 4 前置条件从"Rust 独有验证移植"细化为上述具体缺口清单，并要求 team-runs/kanban 至少进入 api-contract suite 或 Vitest route 测试。

**P1-4 §11.1 验证矩阵遗漏仓库现行强制门禁。**
证据：`AGENTS.md` Validation 一节要求 PR 前运行 `entrix run --tier fast/normal`（`docs/fitness/README.md` 定义 hard gates）；`.github/workflows/page-snapshot-validation.yml` 是 CI 门禁（`resources/page-snapshot-registry.json` 中 kanban target `ci: true`，配套 `scripts/fitness/validate-snapshots.mjs`）；§11.1 只列了静态的 `api:schema:validate`，未列运行时契约 `api:test`（`tests/api-contract/run.ts`）；Phase 5 后 entrix `rust_test_pass`（`cargo test --workspace`）语义变化需要显式改义。
修订要求：§11.1 补入 `entrix run --tier fast/normal`（或声明其在迁移期的替代）、`npm run api:test`、`npm run snapshots:validate`，并在 Phase 5 写明 `rust_test_pass` 的处置。

**P1-5 一批资产既不在保留清单也不在删除清单，Phase 7 审计将无据可依。**
证据：`apps/vscode/`（13 个受跟踪文件 + `package.json` `vscode:compile/build/prepare-assets` 脚本，含 `src/routa-client.ts`）；Docusaurus 文档站（`docusaurus.config.js`、`sidebars.js`、`docs:dev/build/serve` 脚本、`.github/workflows/docs-pages.yml`）；Storybook（`.storybook/`、`chromatic`、`.github/workflows/storybook-governance.yml`）；`packages/office`、`packages/office-render`（`next.config.ts:19` `transpilePackages: ["@autodev/office-render"]`，但 `src/` 中未发现任何 import，需在删除前复核）；`tools/**`（含 `tools/hook-runtime`，被 `prepare`/`postinstall` hooks 与 `.husky/` 使用）；`vercel.json`（crons 指向 `/api/schedules/tick`）。§5.6 要求最终状态"无无消费者依赖/scripts"，但这些资产没有归属结论。
修订要求：在 §5.1/§5.3 之间补一节"未决资产分类"，至少给出上述资产的默认处置（保留/待评估/删除）与 owner。

#### P2（非阻塞建议）

**P2-1 §5.1 保留表不完整。** 遗漏：`resources/canvas/**`（`src/core/canvas/generation-contract.ts:1`、`src/core/canvas/sdk-resource-contract.ts:3` 静态 import 两个 JSON，Kanban fitness workbench 使用）；`resources/flows/**`（`src/core/workflows/workflow-loader.ts` 运行时扫描，`/api/workflows` 与 `src/client/.../workflow-panel.tsx` 消费）；`src/instrumentation.ts`（启动 SchedulerService、BackgroundWorker、telemetry，`vercel.json` cron 依赖其调度）；以及 `src/css`、`src/theme`、`src/types`、`src/test`、`tests/unit/**`、`docker/**`、`Dockerfile`、`docker-compose.yml`、`vercel.json`、`vitest.config.ts`、`playwright.config.ts`、`tsconfig.json`。Phase 1 全仓复制会掩盖该问题，但该表是删除阶段的权威参照，应补全。

**P2-2 §7.1 最低 API 集合遗漏。** 建议补入：`/api/rpc`（`src/client/rpc-client.ts` HTTP 回退路径）、`/api/fitness/**` 与 `/api/canvas/**`（`kanban-fitness-workbench-modal.tsx` 调用）、`/api/workflows`、`/api/schedules`（`vercel.json` cron → `/api/schedules/tick`）。文档已声明该列表不是删除白名单，补入只是降低 Phase 7 误判概率。

**P2-3 Phase 3 请求层 characterization tests 应点名高风险点。** 包括：`src/client/acp-client.ts:711` 的 SSE URL 构造（已带 `window.location.origin` 兜底）、`src/client/hooks/use-kanban-events.ts:33-35` 与 `use-notes.ts` 的 EventSource 地址（浏览器 EventSource 接受相对 URL，简化后不会破坏，但需测试锁定）、`src/client/rpc-client.ts:132` 的 `isTauriRuntime() → tauriInvoke("rpc_call")` 分支（简化后必须保证永不触发，注意 `isTauriRuntime` 还会读 `localStorage["routa.runtime"]`）、以及 13 个带 `ROUTA_BUILD_STATIC` 守卫的 `src/app/**/page.tsx`。

**P2-4 Git hooks 会拦截大批量删除提交。** `.husky/pre-commit` 对单次提交删除 ≥200 文件直接阻断（需 `ALLOW_MASS_DELETE=1`）：`routa-server`(92) + `routa-core`(120) + `routa-rpc`(3) 合计 215 个受跟踪文件，Phase 4 若合并为一个提交会被拦截。建议在 Phase 4 明确按 crate 拆分提交。另 `commit-msg` hook（`tools/hook-runtime/src/coauthor.ts`）强制校验 Co-authored-by 格式，§10 的要求与其一致，但文档未提及 hooks 的存在，建议在 §10 补一句以免实施 Agent 误用 `--no-verify`。

**P2-5 Phase 0 基线验证未包含 SQLite 本地路径。** §11.4 要求存储矩阵，但 Phase 0 最低验证只有 lint/test/schema/build，建议补 `db:sqlite:push` + `ROUTA_DB_DRIVER=sqlite npm run dev` 的启动冒烟，作为后续"SQLite 未被桌面删除误伤"的基线证据。

#### P3（措辞与细节）

- **P3-1** 本迁移文档目前在源仓库未跟踪（`git status` 显示 `?? docs/design-docs/loom-team-web-only-migration.md`），Phase 1 从远端 clone 不会带上它。建议先把本文档提交进源仓库（或显式复制到目标仓库）。
- **P3-2** §5.2 的 `out/workspace/__placeholder__/`：`out/` 已被 `.gitignore` 忽略且当前工作树不存在该目录，条目过时但无害。
- **P3-3** Phase 3 验证 rg 范围 `src next.config.ts` 漏掉 `scripts/`、`e2e/`、`tests/`（3210 命中存在于 `tests/api-contract/helpers.ts`、e2e specs 与 `src/core/**/__tests__` fixture）。
- **P3-4** `e2e/desktop-shell-visual.spec.ts` 名称含 "desktop" 但实为 Web viewport 视觉回归（配套 runner `scripts/deprecated/run-desktop-shell-regression.mjs` 使用 `next dev`），建议 §5.2 明确"保留、勿按名称误删"。
- **P3-5** §8 Phase 1 示例 `git clone <routa-source-url>`：源仓库实际 remote 为 `https://github.com/xhxfafafa/Loom-v2.git`（main 分支），目标仓库已确认为空仓库，可直接 `push -u origin main`；建议写明实际地址减少实施歧义。
- **P3-6** §16 参考实现位置建议补充：`src/instrumentation.ts`、`src/core/platform/`、`Dockerfile`、`vercel.json`、`.husky/`、`tests/api-contract/run.ts`。

### 18.3 必须修改项

1. **P0-1**：Phase 2 增加 `src/` 内 Tauri 引用清理子步骤（5 个文件清单 + `src/core/platform/` 剥离方案）。
2. **P0-2**：Phase 2 增加根 `package.json` `workspaces` 数组与 `Dockerfile:16` 的同步更新任务。
3. **P0-3**：§5.5 将"删除 `ROUTA_DESKTOP_STANDALONE`"改为"重命名为 Web standalone 标志并同步 `build:docker`/`Dockerfile`"。
4. **P0-4**：§5.2/§5.3 增加根 `Cargo.toml` members 更新任务；`crates/routa-rpc` 列入删除清单。
5. **P1-1**：§5.3 明确 `routa-cli` 的去留决策及其三个连锁消费者（cli-release.yml、fitness:fluency、check-backend-architecture.ts）。
6. **P1-2**：Phase 4/5 点名 parity 脚本（check-api-parity、validate-api-parity、rust-coverage）、对应 npm scripts 与 entrix `api_contract_parity` gate 的处置。
7. **P1-3**：Phase 4 前置条件补入具体测试缺口（api-contract 的 team-runs/kanban suite、Team 页面 e2e、kanban import/export 与状态机负向测试）。
8. **P1-4**：§11.1 验证矩阵补入 entrix tier、`api:test`、`snapshots:validate`；Phase 5 写明 `rust_test_pass` 改义。
9. **P1-5**：补充未决资产分类节（vscode、Docusaurus、Storybook、packages/office*、tools/**、vercel.json）。

### 18.4 非阻塞建议

- §5.1 保留表补全（P2-1）；§7.1 API 集合补入 rpc/fitness/canvas/workflows/schedules（P2-2）。
- Phase 3 characterization tests 点名 SSE/EventSource/rpc-client/ROUTA_BUILD_STATIC 守卫等具体位置（P2-3）。
- Phase 4 按 crate 拆分删除提交以避开 husky 批量删除保护；§10 补充 hooks 说明（P2-4）。
- Phase 0 基线加入 SQLite 冒烟（P2-5）。
- P3-1 ～ P3-6 的措辞与参照修正。

### 18.5 文档评分

**8 / 10**

得分依据：目标定义精确、领域不变量（§4）与代码事实高度吻合、"先证据后删除"的去冗余标准（§5.6）安全且可执行、工作包与 Git 纪律（§9/§10）可直接落地。扣分集中在：二级构建耦合（npm workspaces、Dockerfile、Cargo members、standalone 标志复用）未被识别；`routa-cli`/`routa-rpc` 边界矛盾；测试验收对 team-runs/kanban 契约层与 Team 页面 e2e 的缺口无对策；少量仓库现行门禁（entrix、page snapshot）未纳入验证矩阵。

### 18.6 是否可以开始迁移

**可以开始（限定 Phase 0 与 Phase 1）。** 这两个阶段只做基线记录、目标仓库建立与完整 Web 基线推送，不触碰任何上述 P0/P1 边界。目标仓库已确认为空仓库，`git push -u origin main` 无 force-push 风险；源仓库 `.gitignore` 已覆盖 `*.db`（含 952MB 的本地 `routa.db`）、`.next`、`out`、`target`，基线推送无敏感/大文件泄漏风险。开始前建议先落实 P3-1（把本文档提交进源仓库）。

### 18.7 是否可以开始删除桌面及 Rust 后端

**暂不可以。** Phase 2（Tauri 壳删除）与 Phase 4（Rust 后端删除）必须先完成以下修订：

1. 修复 P0-1 ～ P0-4（Phase 2 的 src/ Tauri 引用清单、workspaces/Dockerfile 同步、standalone 标志改名、Cargo members + routa-rpc 处置）；
2. 就 P1-1 的 `routa-cli` 去留做出明确决策；
3. 按 P1-2/P1-3 补齐 parity 脚本处置清单与 Phase 4 前置测试缺口对策。

完成上述修订后，Phase 2 可先行；Phase 4 需在其前置测试（P1-3 清单）提交并绿后再执行。
