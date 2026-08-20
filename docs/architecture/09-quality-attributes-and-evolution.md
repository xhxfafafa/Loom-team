# 质量属性与演进

## 1. 当前质量治理

Fitness 覆盖 Code Quality、Governance、Testability、Security、API Contract、Design System、Evolvability 和 UI Consistency。Observability、Performance 与 Architecture Quality 目前主要作为零权重证据面。

架构边界和 Core Cycle 检查已存在，但属于本地 advisory。API Contract、TypeScript、Test 和 Lint 有更强的门禁地位。

## 2. 架构不变量与验证

| 不变量 | 当前证据 | 后续加强 |
|---|---|---|
| Core 不依赖 UI/App | Architecture DSL/Graph | 升级 CI Gate |
| Provider 输出归一化 | Adapter 单元测试 | 跨 Provider Contract Suite |
| Session History 幂等 | Store 测试 | 故障注入/并发测试 |
| Session Lease 单持有 | CAS Store 测试 | 多实例数据库测试 |
| Team 树归属正确 | Ownership/Binding 测试 | 删除与恢复 E2E |
| Kanban Queue 防陈旧 | Queue/Orchestrator 测试 | 进程重启测试 |
| UI/MCP Gate 一致 | Shared Evaluator 测试 | 跨入口 Contract Test |
| Workflow 依赖顺序 | Executor/Store 测试 | Retry/Restart 测试 |
| Workspace 隔离 | 多处 Route/Domain 测试 | 统一 ACL 后安全测试 |

## 3. 推荐 SLO

这些是目标，不是当前承诺：

| 指标 | 单实例目标 |
|---|---|
| 普通 API P95 | < 500ms |
| 已创建 Session 的事件到 UI P95 | < 2s |
| Session Runtime 恢复判定 | < 30s，不含 Provider 冷启动 |
| Background Task 重启恢复 | < 60s，需 Claim Lease 后生效 |
| 关键 History 事件丢失 | 0 |
| Team Run 聚合删除一致性 | 活跃 Runtime 未停时 0 数据删除 |

## 4. 性能热点

| 热点 | 当前保护 | Target |
|---|---|---|
| Session Message Delta | 合并 Chunk、History 上限 | 分层归档和 Cursor |
| SSE 慢客户端 | Controller 异常移除 | 有界发送队列和背压指标 |
| Provider 冷启动 | Warmup/Registry | Warm Pool 与能力缓存 |
| Background Polling | 5s/15s 轮询 | DB Claim + Event Wakeup |
| Git 大仓库 | 上下文限定 | 增量 Cache 与工作范围预算 |
| Trace 追加 | JSONL/DB | 批处理、轮转与保留策略 |

## 5. 优先演进 Backlog

### P0：正确性与安全

1. 持久化 Workflow Run。
2. 持久化 Permission Request。
3. 生产禁止静默 Memory 降级。
4. 明确公网前的认证与 Workspace ACL。
5. Webhook Delivery ID 去重。

### P1：可靠执行

1. Background Task Claim Lease/Heartbeat。
2. Kanban Transition Outbox。
3. Schedule 多实例 Claim。
4. Worker 重启恢复与故障注入测试。
5. 通用 Gate Result 结构化。

### P2：扩展

1. 共享 Event Bus。
2. Control Plane/Runner 分离。
3. Artifact 对象存储。
4. Session/Trace 冷热分层。
5. 多租户配额和公平调度。

## 6. 不建议过早实施

- 将每个领域拆成独立微服务；
- 在单实例阶段引入 Kafka 级消息平台；
- 为所有对象统一复杂 Saga；
- 在 Session/Task 状态语义未收口前建设通用 Workflow DSL；
- 将纯 Serverless 作为完整本地 Agent Runtime 的首选形态。

## 7. 变更守则

- 改 Session 生命周期前，先补 Recovery/Finalizer Characterization。
- 改 Kanban Transition 前，同时验证 REST 与 MCP。
- 改 Store 前，验证 SQLite/Postgres/Memory 语义差异。
- 改 Team Ownership 前，验证多层后代、环、跨 Workspace 和删除。
- 改 Workflow 前，验证重启、重复 Dispatch 和依赖输出。
- UI 字符串必须通过 i18n；前端请求继续使用统一请求边界。
- 一个知识类型只有一个权威归属：架构写边界，ADR 写决策，Design Doc 写专题意图，执行计划写临时步骤。
- 不通过复制旧文档解决发现性问题；应规范化内容并增加索引和来源链接。

## 8. 文档维护

- `docs/ARCHITECTURE.md` 只维护稳定原则。
- 本目录维护详细 Current/Transitional/Target。
- 决策变化进入 ADR。
- Endpoint 清单由 Feature Tree/API Contract 维护。
- 每次影响运行链路的变更应同步对应主题文档和 Implementation Mapping。
- Design Doc 的 `accepted/proposed/historical` 状态必须在详细架构中映射为 Current 或 Target，禁止抹平状态差异。
- 架构书描述“要构建什么、边界和链路为何如此”；具体请求字段、函数和端点细节进入可执行 API/实现文档。

上述维护规则继承自 [Core Beliefs](../design-docs/core-beliefs.md) 与 [Golden Rules](../design-docs/golden-rules.md)。

[返回目录](./README.md)
