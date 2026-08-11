---
title: Team Run Deletion Ownership Boundaries
status: proposed
purpose: Define authoritative ownership and safe cleanup semantics for Team Run deletion, including explicitly owned and legacy Kanban cards.
related_issue: ../issues/2026-08-11-team-run-deletion-preserves-owned-cards.md
---

# Team Run 删除的所有权边界与卡片清理设计

## 1. 决策摘要

Team Run 删除必须以持久化的显式所有权为最高优先级，而不能让 Session
执行历史覆盖所有权判断。

对 Kanban 卡片采用以下规范：

1. `task.teamRunId === deletedRootSessionId`：卡片明确属于待删除 Team，必须删除。
2. `task.teamRunId` 非空且不等于待删除 Team：卡片属于其他 Team，必须保留。
3. `task.teamRunId` 为空：作为历史数据，继续通过 Team Session 树进行保守推断；
   一旦同时关联树外存活 Session，则保留并标记为共享候选。

`sessionId`、`triggerSessionId`、`sessionIds` 和 `laneSessions[].sessionId`
描述卡片的执行历史，不是卡片所有权。它们只能用于兼容历史卡片，不能推翻
`teamRunId`。

此次修复不应通过给 Kanban lane Session 补造 `parentSessionId` 实现。Session
层级表达运行与展示关系，`teamRunId` 表达资源所有权，两者必须保持独立。

## 2. 背景

Routa 当前没有独立的 Team Run 数据表。一个 Team Run 是以下数据的组合视图：

- 一个 Team Lead 根 ACP Session；
- 通过 `parentSessionId` 连接的后代 Session 树；
- 指向根 Session ID 的 `task.teamRunId`；
- 与这些 Session 或卡片相关的 Agent、Artifact、Worktree、Note 和 Background Task。

删除入口包括：

- 预览：`GET /api/team-runs/{rootSessionId}/preview`
- 执行：`DELETE /api/team-runs/{rootSessionId}?workspaceId={workspaceId}`

两个入口复用 `buildTeamRunDeletionPlan`，因此预览和实际删除原则上共享同一套
边界。实际删除只会删除计划中的 ID；数据库驱动不会重新推断所有权。

## 3. 现有删除功能

### 3.1 服务边界

`team-run-deletion.ts` 采用 planning + execution 两阶段结构：

```text
HTTP preview/delete
  -> resolveTeamRun
  -> buildTeamRunDeletionPlan
  -> stop active processes
  -> persistent transaction
  -> clear in-memory Sessions
  -> best-effort filesystem cleanup
  -> publish Kanban deletion events
```

其中已有安全约束包括：

- 目标必须是 Team Run 根 Session；
- 请求的 `workspaceId` 必须与根 Session 一致；
- runner 模式 Session 无法本地终止时，删除在任何数据变更前失败；
- 所有存活进程必须先停止并确认退出；
- SQLite/Postgres 在单个事务内删除持久化数据；
- Worktree 分支和主仓库永远不删除；仅对 Team 独占的 Worktree 目录做
  best-effort 清理；
- Workspace、Codebase、Kanban Board 和其他 Team 不在删除范围内。

### 3.2 Team Session 树

`collectTeamSessionIds` 从根 Session 开始，仅沿 `parentSessionId` 广度优先遍历，
得到 `treeSet`。这个集合适合表示 Team 的结构化 Session 后代，但不能表达所有
与 Team 卡片有关的自动化 Session。

### 3.3 卡片候选分类

当前实现有两个候选来源：

- 显式候选：`task.teamRunId === root.sessionId`；
- 历史候选：没有被其他 Team 显式拥有，并且至少一个卡片 Session 引用位于
  `treeSet`。

随后，现有代码对两类候选统一计算：

```ts
const hasExternalLiveRef = refs.some(
  (id) => !treeSet.has(id) && existingSessionIds.has(id),
);

if (hasExternalLiveRef) {
  sharedKanbanTaskIds.push(task.id);
  continue;
}
```

只有进入 `kanbanTaskIds` 的卡片才会被传给 SQLite/Postgres 删除事务并触发
Kanban `deleted` 事件。

### 3.4 其他资源的既有语义

- Artifact：通过 `artifact.taskId` 唯一属于卡片，随被删除卡片删除。
- Worktree：删除卡片引用形成候选；任何存活卡片引用优先，因而共享 Worktree
  保留。
- Agent：Team 树内 Session 的 Agent 为候选；若树外 Session 使用相同 Agent，
  则保留。
- Note：删除 Team Session 创建的 Note，以及不属于存活 Session 的后代 Note。
- Background Task：`resultSessionId` 位于 Team 树时删除。

这些资源的 survivor-first 保护仍然有效，不应因卡片规则修复而整体移除。

## 4. 故障现象与完整链路

典型链路如下：

```text
Team Lead 创建卡片
  -> 卡片写入 teamRunId = Team 根 Session ID
  -> Kanban lane 自动化启动独立 ACP Session
  -> 卡片记录 triggerSessionId/sessionIds/laneSessions
  -> lane Session 未设置 parentSessionId = Team 根 Session ID
  -> 删除时 lane Session 不在 treeSet，但仍存在于 Session Store
  -> hasExternalLiveRef = true
  -> 明确属于 Team 的卡片进入 sharedKanbanTaskIds
  -> 卡片 ID 未进入数据库 DELETE
  -> Team 根 Session 删除，卡片残留
```

这里不是以下问题：

- 不是前端刷新失败：后端删除结果中的 `kanbanCards` 已不包含这些卡片；
- 不是 SQLite/Postgres 事务漏删：事务只执行计划传入的 `kanbanTaskIds`；
- 不是 `teamRunId` 未持久化：卡片加载后仍可正确得到显式 Team 所有权；
- 不是错误 API：确认弹窗和删除操作调用的是同一 Team Run 删除服务。

## 5. 根因分析

### 5.1 所有权优先级错误

代码先认定 `explicitOwner`，随后又允许 `hasExternalLiveRef` 覆盖它。最终优先级
实际上变成：

```text
树外存活 Session 引用 > 显式 teamRunId 所有权
```

正确优先级应为：

```text
显式 teamRunId 所有权 > 历史 Session 关联推断
```

### 5.2 关系方向被误读

`collectTaskSessionRefs(task)` 读取的是卡片上的 Session 字段，证明的是：

```text
Task -> execution Session
```

它并不能证明：

```text
outside Session -> owns or depends on Task
```

因此 `hasExternalLiveRef` 对显式拥有的卡片并不是可靠的“共享资源”证据。一个
Team-owned 卡片记录多个 lane 执行 Session 是正常情况，不代表该卡片被其他 Team
共享。

### 5.3 Session 树与卡片执行拓扑不同

Kanban 自动化从 `workflow-orchestrator-singleton.ts` 进入
`triggerAssignedTaskAgent`，最终调用 ACP `session/new`。该创建参数没有携带 Team
根 `parentSessionId`。

这不一定是 Session 创建 Bug：lane Session 可以是卡片执行拓扑的一部分，但不一定
是 Team UI 所展示的委派子树。删除逻辑不应假设两个拓扑完全相同。

### 5.4 回归测试缺口

提交 `3ea1dd39` 增加了 `teamRunId` 显式匹配，同时保留了树外存活 Session 保护。
现有测试覆盖：

- 显式拥有且无 Session 引用：删除；
- 显式拥有且只有不存在的 Session：删除；
- 显式拥有且引用合成的 `outsider-1`：保留。

缺失的真实场景是：显式 Team-owned 卡片关联一个由正常 lane 自动化创建、仍然
存活但没有 Team `parentSessionId` 的 Session。这个场景会稳定触发误判。

## 6. 规范化所有权模型

### 6.1 标识符职责

| 字段/集合 | 语义 | 是否可决定卡片所有权 |
|---|---|---|
| `task.teamRunId` | 创建或拥有卡片的 Team Run 根 ID | 是，权威来源 |
| `task.sessionId` | 卡片关联的主执行 Session | 否 |
| `task.triggerSessionId` | 当前/最近触发的自动化 Session | 否 |
| `task.sessionIds` | 卡片历史 Session 集合 | 否 |
| `task.laneSessions` | 各列执行历史及运行元数据 | 否 |
| Session `parentSessionId` | Team/委派 Session 的结构层级 | 仅用于历史推断 |
| `treeSet` | 从根 Session 得到的结构化后代集合 | 仅用于历史推断和其他资源清理 |

### 6.2 卡片决策矩阵

| `teamRunId` | 与待删 Team 的关系 | Team 树内引用 | 树外存活引用 | 决策 |
|---|---|---:|---:|---|
| 等于根 ID | 显式属于待删 Team | 任意 | 任意 | 删除 |
| 非空且不等于根 ID | 显式属于其他 Team | 任意 | 任意 | 保留 |
| 为空 | 历史卡片 | 无 | 任意 | 保留 |
| 为空 | 历史卡片 | 有 | 无 | 删除 |
| 为空 | 历史卡片 | 有 | 有 | 保留为共享候选 |

该矩阵体现两条硬规则：显式所有权优先；只有缺失显式所有权时才允许推断。

## 7. 修复设计

### 7.1 计划阶段算法

将显式所有权和历史推断拆成互斥分支：

```ts
for (const task of workspaceTasks) {
  if (task.teamRunId) {
    if (task.teamRunId === root.sessionId) {
      kanbanTaskIds.push(task.id);
      explicitKanbanTaskIds.push(task.id);
    }
    continue;
  }

  const refs = collectTaskSessionRefs(task);
  const linkedToDeletedTree = refs.some((id) => treeSet.has(id));
  if (!linkedToDeletedTree) continue;

  const linkedToLiveOutsideSession = refs.some(
    (id) => !treeSet.has(id) && existingSessionIds.has(id),
  );
  if (linkedToLiveOutsideSession) {
    sharedKanbanTaskIds.push(task.id);
    continue;
  }

  kanbanTaskIds.push(task.id);
  legacyKanbanTaskIds.push(task.id);
}
```

不需要修改 `deleteTeamRunDataPersistent`。一旦计划正确，现有事务会删除卡片、
Artifact 和相关独占数据。

### 7.2 预览语义

预览必须与实际执行共用同一计划，不允许 UI 自行重算。

建议保留现有计数：

- `explicitKanbanCards`：由 `teamRunId` 明确匹配、将被删除的卡片；
- `legacyKanbanCards`：通过历史 Session 树推断、将被删除的卡片；
- `preservedSharedKanbanCards`：仅限没有 `teamRunId` 且同时关联树内、树外存活
  Session 的历史卡片。

修复后，显式 Team-owned 卡片不应出现在 `sharedKanbanTaskIds`。

### 7.3 不采用的方案

#### 给 lane Session 自动补 `parentSessionId`

不采用。原因：

- 改变 Team 页面可见 Session 树；
- 可能改变 Session 恢复、停止和级联清理范围；
- 多列多次自动化不等同于 Team 委派关系；
- 只能掩盖所有权优先级错误，不能修正关系方向。

#### 移除全部共享保护

不采用。没有 `teamRunId` 的历史卡片仍需要保守保护；Agent 和 Worktree 也存在真实
共享关系。

#### 在 SQL 中重新判断所有权

不采用。计划层是 Web API、预览和多存储驱动的统一领域边界。把判断下沉到每个
数据库驱动会造成预览/执行不一致和双实现漂移。

## 8. 历史残留数据处理

修复正常删除路径只能防止新的残留。已经删除根 Session 的 Team 无法再次调用原
接口，因为 `resolveTeamRun` 会返回 `TEAM_RUN_NOT_FOUND`。

历史清理必须作为独立、显式且可预览的操作：

1. 在指定 Workspace 内查找 `teamRunId` 非空的卡片；
2. 验证对应根 Session 在持久化 Session Store 中不存在；
3. 输出待清理卡片、Artifact 和 Worktree 影响预览；
4. 默认不删除 Worktree 目录，除非现有 survivor-first 检查确认独占；
5. 用户确认后在单个数据库事务内清理；
6. 发布 Kanban 删除事件；
7. 记录被清理的孤儿 `teamRunId` 和卡片 ID，便于审计。

孤儿清理不能把所有 `teamRunId` 缺失的卡片当作垃圾，也不能依靠仓库标签、卡片
标题或当前默认 Codebase 猜测归属。

## 9. API 与双后端边界

本问题当前位于 Next.js Team Run 删除领域服务，SQLite 和 Postgres 共用同一计划
逻辑。数据库差异只发生在执行事务中，不影响根因。

当 Rust/Axum 暴露等价 Team Run 删除能力时，必须保持相同语义：

- `teamRunId` 是卡片显式所有权；
- Session 字段是执行历史；
- 显式属于其他 Team 的卡片永远保留；
- 历史推断保持保守；
- 预览与删除共享同一计划；
- Workspace 边界和事务性不变。

如果 API 响应字段发生变化，应同步更新 `api-contract.yaml`；本次算法修复本身不要求
改变现有 HTTP 形状。

## 10. 验证计划

### 10.1 领域单元测试

在 `team-run-deletion.test.ts` 至少覆盖：

1. 显式 Team-owned 卡片，无 Session 引用 -> 删除；
2. 显式 Team-owned 卡片，只有不存在的 Session -> 删除；
3. 显式 Team-owned 卡片，关联存活但无父级的 lane Session -> 删除；
4. 显式 Team-owned 卡片，同时关联 Team 树内和树外存活 Session -> 仍删除；
5. 显式属于其他 Team 的卡片，即使关联待删树 -> 保留；
6. 无 `teamRunId` 的历史卡片，仅关联待删树 -> 删除；
7. 无 `teamRunId` 的历史卡片，同时关联树内和树外存活 Session -> 保留；
8. 无所有权且无树内引用 -> 保留；
9. Artifact 仅随实际删除的卡片删除；
10. 共享 Worktree 继续由存活卡片保护。

### 10.2 API 测试

- preview 的显式、历史和保留计数与领域计划一致；
- DELETE 返回的 `deleted.kanbanCards` 与实际删除数一致；
- 错误 Workspace 不产生任何变更；
- 根 Session 不存在时仍返回稳定错误，不隐式触发孤儿清理。

### 10.3 持久化测试

- SQLite 事务收到显式 Team-owned 卡片 ID；
- Postgres/Neon 路径使用相同计划结果；
- 事务失败时 Team Session 和卡片不出现部分删除；
- 删除成功后发布每个卡片的 Kanban `deleted` 事件。

### 10.4 手工回归

1. 在同一 Workspace 创建两个 Team Run，并分别选择不同 Codebase；
2. 两个 Team 分别创建并运行多列 Kanban 卡片；
3. 删除其中一个 Team；
4. 确认该 Team 的卡片、Artifact 和独占运行资源消失；
5. 确认另一个 Team 的卡片、Session、Codebase 和 Worktree 不变；
6. 刷新浏览器并重启本地服务后再次确认持久化结果。

实现代码后应运行与行为变更相匹配的 focused tests、TypeScript 检查和
`entrix run --tier normal`。

## 11. 完成标准

- 所有卡片决策符合第 6.2 节矩阵；
- 显式 Team-owned 卡片不会再进入 `sharedKanbanTaskIds`；
- 删除计划、预览响应和实际事务使用同一组卡片 ID；
- 其他 Team 和无关 Workspace 资源不受影响；
- 现有 Agent、Worktree、Note 等安全边界没有被削弱；
- 新增真实 lane Session 回归测试；
- 历史孤儿数据只能通过独立预览与确认流程清理。
