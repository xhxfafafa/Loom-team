# Loom-team 架构事实核验报告

> 核验日期：2026-08-19  
> 核验对象：详细技术架构设计书与 Loom-team Web-only 实现  
> 结论：原设计书方向基本合理，但将多项目标能力写成了当前能力，且单文件过长；需要拆分并重写

## 1. 总体结论

Loom-team 当前是 Workspace-first 的 Next.js/Node 模块化单体。Web 页面、API、领域服务、ACP/MCP、后台调度和本地 Agent 进程位于同一运行面。SQLite 是本地默认存储，Postgres 是生产持久化选择，内存实现用于测试和降级。系统通过 ACP 组织 Agent Session，通过 MCP 暴露协作 Tool，通过 SSE 向浏览器推送增量事件。

原设计书准确把握了 Workspace、Provider Adapter、Kanban 自动化、证据门禁和本地优先等核心方向，但混入了尚未落地的 Outbox、Inbox、持久 Worker Lease、共享 Event Bus、远程 Runner、统一 Version 和完整用户授权。若不加区分，会让读者误判系统的可靠性与公网部署能力。

原设计书共 1200 余行，领域、协议、数据、安全和目标演进相互交叉。继续维护单文件会造成重复和语义漂移。本次决定拆分为入口加九个主题文档，并以 `Current / Transitional / Target` 标记状态。

## 2. 已确认的当前架构

| 领域 | 当前事实 |
|---|---|
| 运行面 | 单 Next.js Web/Node 运行面，无独立生产 Runner 服务 |
| 顶层边界 | Workspace 是主要资源作用域，但仍存在 `default` 回退 |
| Team Run | Root Session 及其后代、Task、Note、Artifact、Worktree 的聚合视图，不是独立实体表 |
| Session | 持久元数据与进程内实时状态并存，支持 Provider Session ID、Runtime Binding 和 Session Lease |
| Session 状态 | ACP 连接态为 `connecting/ready/error`；完成、失败、超时记录在 Activity 终态中 |
| Task | 独立持久工作单元，拥有 Team、Lane、Worktree、证据和 GitHub 元数据 |
| Kanban | Column Policy 可驱动 ACP/A2A Lane Session，并带多步、并发和多类 Gate |
| Workflow | YAML Definition 展开为 Background Task；Workflow Run 当前统一装配为内存 Store |
| Background Worker | 进程内轮询，最大并发为固定值；通过内部 HTTP 调用 ACP Session 创建与 Prompt |
| Permission | Permission Request 存在，但 Store 为进程内 Map |
| 实时事件 | ACP、Kanban、Notes 等使用 SSE；Broadcaster 与 Controller 均为进程内状态 |
| Trace | 本地写 JSONL；Serverless + Postgres 时可写 Trace 表 |
| 安全 | 有 Sandbox、Tool Profile、写边界、Webhook HMAC；没有覆盖全部 API 的用户认证/Workspace ACL |
| 部署 | 本地和单实例 Docker 最贴合；Serverless 对长进程、轮询和 SSE 存在天然张力 |

## 3. 原设计书中合理的部分

- Workspace-first 作为主要资源边界。
- 使用 ACP 收敛 Provider Session 语义。
- 使用 MCP 作为 Agent 调用平台能力的边界。
- Task 与 Session 分离。
- Kanban Column 同时承载状态和自动化策略。
- Delivery Gate 必须由服务器规则执行，不能只依赖 Prompt。
- 本地 SQLite、生产 Postgres 的双模式思路。
- 控制面与 Runner 分离作为长期演进方向。
- 长任务需要幂等、租约、恢复和补偿。

## 4. 原设计书中的主要偏差

| 偏差 | 真实情况 | 处理 |
|---|---|---|
| 将 Team Run 画成独立聚合实体 | Team Run 由 Root Session 和关联资源推导 | 按聚合视图重写 |
| 使用理想化 Session 状态机 | 连接态和 Activity 终态是两层状态 | 分层表达状态 |
| 假设所有任务有持久 Lease | 只有 Session Store 已有 CAS Lease；Background Task 主要靠状态抢占 | 标为 Target |
| 假设 Outbox 已存在 | 当前 EventBus 和 Broadcaster 主要在进程内 | 标为 Target |
| 假设 Workflow Run 持久化 | 数据结构存在，但系统装配使用内存 Store | 标为 Transitional |
| 假设 Permission 持久化 | PermissionStore 为内存 Map | 标为 Transitional |
| 假设远程 Runner 架构已成立 | 当前有 execution mode/runner 路由语义，但主运行形态仍是嵌入式 | 标为 Target/Partial |
| 假设全局用户认证与 ACL | 当前没有统一用户身份边界 | 明确当前信任模型 |
| 假设 SSE 有 Cursor 协议 | ACP History 有 Event ID/afterEventId；一般 Broadcaster 没有完整 Cursor | 分协议说明 |
| 假设所有 Webhook 都严格拒绝无 Secret | Secret 为空时接受签名缺失，适合开发但不适合公网 | 写入安全限制 |
| 假设 Background Task 状态丰富 | 当前只有五态，无 Claimed/Blocked/Retrying | 使用真实五态 |
| 假设 Worktree 有 Ready/Releasable | 当前只有 creating/active/error/removing | 使用真实四态 |

## 5. 实际存在但原设计书遗漏或弱化的能力

- Team Chain 元数据只允许顶层 Team Lead Session 使用。
- Team Runtime Binding 可以从持久 Session 树恢复 Lead 与后代映射。
- Team Run 删除采用预览、先停止全部活跃进程、再聚合删除的安全语义。
- Session History 支持按 Event ID 原子追加一次，用于 Prompt 和 Child Report 去重。
- Session Runtime Finalizer 在 History 未持久化或 Provider Recovery 信息不充分时拒绝释放。
- Kanban 支持 ACP 与 A2A 两种 Transport。
- Lane Session 具有 watchdog/ralph-loop、完成要求、恢复原因和 Handoff。
- Task 带 JIT Context、Delivery Snapshot、Fallback Agent Chain 和 GitHub 同步信息。
- MCP Server Profile 可限制 Planning 与 Team Coordination Tool 集合。
- Webhook 支持 GitHub HMAC、触发日志、Workflow 或单任务分派，但缺少 Delivery ID 去重。
- 架构边界与循环依赖检查当前为 advisory，而非强制 CI 阻断。

## 6. 关键风险

1. **进程内状态风险**：Workflow Run、Permission、SSE Controller 和部分 Worker 关联在重启后丢失。
2. **多实例风险**：进程内 EventBus、Broadcaster 和轮询 Worker 不具备跨实例一致性。
3. **安全风险**：没有统一用户认证和 Workspace ACL，高权限 Agent API 不应直接暴露公网。
4. **降级风险**：SQLite 初始化失败可回退内存，若没有显式诊断可能产生持久性误判。
5. **Serverless 风险**：本地进程、长 SSE、文件系统和后台轮询与短生命周期运行平台不匹配。
6. **Webhook 重复风险**：签名验证存在，但 GitHub Delivery ID 没有成为明确幂等键。
7. **自调用风险**：Background Worker 通过内部 HTTP 调用 ACP，复用行为的同时增加 Base URL 和网络故障面。

## 7. 文档拆分决定

详细架构拆分到 `docs/architecture/`：

| 文档 | 主题 |
|---|---|
| `README.md` | 总入口、状态标记和阅读路线 |
| `01-system-overview.md` | 系统上下文、运行拓扑和分层 |
| `02-domain-model.md` | 领域对象、关系、状态与不变量 |
| `03-agent-session-and-protocols.md` | ACP、MCP、Provider、Session 与恢复 |
| `04-team-and-kanban-orchestration.md` | Team、Task、Kanban、Queue 和 Gate |
| `05-workflow-and-background-execution.md` | Workflow、后台任务、Schedule 与 Webhook |
| `06-data-and-consistency.md` | 存储、持久化、一致性与目标演进 |
| `07-security-and-permissions.md` | 当前信任模型、Permission、Sandbox 和目标安全 |
| `08-deployment-reliability-observability.md` | 部署、事件、恢复、Trace 和扩展 |
| `09-quality-attributes-and-evolution.md` | SLO、验证不变量和演进优先级 |
| `implementation-mapping.md` | 集中的实现映射与状态证据 |

## 8. 仍需负责人确认的问题

- 公网部署是否属于近期目标，还是仅支持可信本地/内网。
- 是否保留 Serverless 作为完整 Agent Runtime 的部署目标。
- Workflow Run 和 Permission 的持久化优先级。
- Background Task 是否需要数据库 Claim/Lease。
- GitHub Webhook 是否必须按 Delivery ID 强制去重。
- 独立 Runner 的实际时间表和协议边界。
- 是否彻底移除所有 `default` Workspace 回退。

## 9. 核验依据

核验覆盖系统装配、数据库驱动、Session Store 与恢复、Provider Registry、Team 聚合删除、Kanban Queue 和 Gate、Workflow/Worker、Scheduler、Webhook、MCP Profile、Permission、Sandbox、SSE、Trace、部署配置和架构质量规则。实现位置集中列于详细架构的 `implementation-mapping.md`，避免在正文重复堆叠。
