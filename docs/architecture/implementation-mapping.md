# 实现映射

本文件集中记录架构概念与实现位置。正文架构文档避免重复路径。

## 1. 系统与存储

| 概念 | 位置 | 状态 |
|---|---|---|
| 系统装配 | `src/core/routa-system.ts` | Current |
| 数据库驱动 | `src/core/db/index.ts` | Current |
| Postgres Schema | `src/core/db/schema.ts` | Current |
| SQLite Schema | `src/core/db/sqlite-schema.ts` | Current |
| Node 启动服务 | `src/instrumentation.ts` | Current |
| Workflow Run DB Store | — | Target；表存在但未装配 Store |
| Permission DB Store | — | Target |

## 2. Agent Session 与协议

| 概念 | 位置 | 状态 |
|---|---|---|
| ACP API | `src/app/api/acp/` | Current |
| Session 创建 Workflow | `src/app/api/acp/acp-session-create.ts` | Current |
| HTTP Session Store/SSE | `src/core/acp/http-session-store.ts` | Current，进程内实时态 |
| Session 持久化 | `src/core/acp/session-db-persister.ts` | Current |
| Session Lease | `src/core/acp/session-lease.ts`、Session Stores | Current |
| Runtime Recovery | `src/core/acp/session-runtime-recovery.ts` | Current |
| Runtime Finalizer | `src/core/acp/session-runtime-finalizer.ts` | Current |
| Provider Registry | `src/core/acp/provider-registry.ts` | Current |
| Provider Presets | `src/core/acp/acp-presets.ts` | Current |
| Provider Adapters | `src/core/acp/provider-adapter/` | Current |
| MCP Gateway/Executor | `src/app/api/mcp/`、`src/core/mcp/` | Current |
| MCP Profile | `src/core/mcp/mcp-server-profiles.ts` | Current |
| Task Write Boundary | `src/core/mcp/mcp-task-write-boundary.ts` | Current |

## 3. Team 与 Kanban

| 概念 | 位置 | 状态 |
|---|---|---|
| Team Root/Ownership | `src/core/orchestration/team-run-identity.ts`、`team-run-ownership.ts` | Current |
| Team Chain | `src/core/orchestration/team-chain.ts` | Current |
| Team Runtime Binding | `src/core/orchestration/team-runtime-bindings.ts` | Current |
| Team Report Delivery | `src/core/orchestration/team-report-delivery.ts` | Current |
| Team Aggregate Delete | `src/core/orchestration/team-run-deletion.ts` | Current |
| Task Model | `src/core/models/task.ts` | Current |
| Board/Column Model | `src/core/models/kanban.ts` | Current |
| Column Transition | `src/core/kanban/column-transition.ts` | Current |
| Workflow Orchestrator | `src/core/kanban/workflow-orchestrator.ts` | Current |
| Board Queue | `src/core/kanban/kanban-session-queue.ts` | Current，进程内协调 |
| Agent Prompt/Trigger | `src/core/kanban/agent-trigger.ts` | Current |
| Delivery Readiness | `src/core/kanban/task-delivery-readiness.ts` | Current |
| Persistent Lane Job Claim | — | Target |
| Transition Outbox | — | Target |

## 4. Workflow 与后台服务

| 概念 | 位置 | 状态 |
|---|---|---|
| Workflow Types/Loader | `src/core/workflows/` | Current/Partial |
| Workflow Executor | `src/core/workflows/workflow-executor.ts` | Current |
| Workflow Store | `src/core/workflows/workflow-store.ts` | Transitional：仅内存 |
| Background Task | `src/core/models/background-task.ts` | Current |
| Background Worker | `src/core/background-worker/index.ts` | Current，进程内轮询 |
| Scheduler | `src/core/scheduling/` | Current |
| GitHub Webhook | `src/app/api/webhooks/github/`、`src/core/webhooks/` | Current |
| GitHub Polling | `src/core/polling/` | Current |
| Background Claim Lease | — | Target |
| Webhook Delivery Inbox | — | Target |

## 5. Runtime、安全与可观测性

| 概念 | 位置 | 状态 |
|---|---|---|
| Permission Store | `src/core/tools/permission-store.ts` | Transitional：进程内 |
| Sandbox Policy | `src/core/sandbox/` | Current/Transitional |
| Local/Docker Worker | `src/core/worker/` | Current |
| Trace | `src/core/trace/` | Current |
| OpenTelemetry | `src/core/telemetry/` | Current，可选 |
| Kanban SSE | `src/core/kanban/kanban-event-broadcaster.ts` | Current，进程内 |
| Note SSE | `src/core/notes/note-event-broadcaster.ts` | Current，进程内 |
| 全局用户认证/ACL | — | Target |
| 共享 Event Bus | — | Target |
| 独立 Remote Runner Control Plane | 部分 execution mode 语义 | Partial/Target |

## 6. 质量与规范

| 概念 | 位置 | 状态 |
|---|---|---|
| Canonical Architecture | `docs/ARCHITECTURE.md` | Canonical |
| ADR | `docs/adr/` | Canonical decisions |
| API Contract | `api-contract.yaml` | Canonical API surface |
| Feature Tree | `docs/product-specs/FEATURE_TREE.md` | Generated product index |
| Fitness | `docs/fitness/`、`scripts/fitness/` | Current |
| Architecture DSL | `architecture/rules/backend-core.archdsl.yaml` | Current advisory |

## 7. 原有设计依据映射

| 架构主题 | 原有文档 | 文档状态 | 在本架构书中的处理 |
|---|---|---|---|
| 产品执行模式 | [Execution Modes](../design-docs/execution-modes.md) | 当前行为基线 | 系统总览、Team/Kanban |
| Workspace-first | [Workspace-Centric Redesign](../design-docs/workspace-centric-redesign.md) | 部分落地 | 系统总览、领域模型 |
| 委派与 Task 生命周期 | [Team Task Lifecycle](../design-docs/team-task-lifecycle-consistency.md) | accepted | 领域模型、Team 编排 |
| Session Runtime 恢复 | [Team Session Runtime Recovery](../design-docs/team-session-runtime-recovery.md) | proposed | Session 章节按 Current/Target 拆分 |
| Team Run 删除归属 | [Deletion Ownership](../design-docs/team-run-deletion-ownership-boundaries.md) | proposed | 已有行为写 Current，新增约束写 Target |
| 报告 Note 分类 | [Report Note Classification](../design-docs/team-report-note-task-tree-classification.md) | proposed | 领域不变量与兼容投影规则 |
| Team 时间线收敛 | [Timeline Refresh](../design-docs/team-timeline-live-refresh-and-auto-follow.md) | accepted | Team UI 数据链路 |
| Task 输入附件 | [Task Input Attachments](../design-docs/kanban-task-input-attachments.md) | 专题设计 | Artifact 边界与失败补偿 |
| 文件删除安全 | [File Deletion Safety](../design-docs/file-deletion-safety-mechanism.md) | design + implementation | 安全纵深防护 |
| 提交身份安全 | [Git Commit Safety](../design-docs/git-commit-safety-mechanism.md) | design | 未落地部分保持 Target |
| 文档治理 | [Core Beliefs](../design-docs/core-beliefs.md)、[Golden Rules](../design-docs/golden-rules.md) | 规范 | 文档权威层级与维护规则 |

历史 Web-only 迁移材料只作为来源记录，不覆盖当前 Canonical Architecture；含桌面或 Rust 运行面的旧描述必须经过现状核验后才能进入本架构书。

## 8. ADR 约束映射

| ADR | 对详细架构的约束 | 当前解释 |
|---|---|---|
| [0001 Dual-Backend Parity](../adr/0001-dual-backend-semantic-parity.md) | 原 API/领域语义一致性原则 | ADR 元数据仍为 accepted，但双运行面已被 Web-only 迁移事实取代；仅保留“契约一致性”原则，桌面/Rust 结论视为历史，后续应单独修正 ADR 状态 |
| [0002 Provider via ACP](../adr/0002-provider-normalization-via-acp.md) | Provider 差异收敛在 Adapter | Session 与协议 |
| [0003 Workspace First](../adr/0003-workspace-first-scope.md) | Workspace 是最高协调作用域 | 系统总览、领域模型 |
| [0004 Kanban Automation](../adr/0004-kanban-driven-automation.md) | 列迁移触发 ACP Session，受 Board Queue 并发控制 | Team 与 Kanban |
| [0005 Specialist Externalization](../adr/0005-specialist-externalization.md) | Specialist 配置外置并按优先级解析 | Provider/Session 创建 |
| [0006 Orchestration Shell](../adr/0006-orchestration-shell-pattern.md) | 复杂入口保持薄壳，按工作流分支拆分 | 所有应用链路的模块边界 |
| [0007 Delivery Policies](../adr/0007-kanban-delivery-transition-policies.md) | UI、API、MCP 共享同一列迁移 Gate | Team 与 Kanban、质量验证 |

[返回目录](./README.md)
