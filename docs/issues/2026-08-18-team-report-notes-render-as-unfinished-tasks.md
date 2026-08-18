---
title: "Team completion-report Notes render as unfinished tasks"
date: "2026-08-18"
kind: issue
status: resolved
severity: medium
area: "team-ui"
tags: ["team", "task", "note", "report", "classification", "lifecycle", "web"]
reported_by: "human"
related_issues:
  - "2026-08-11-team-task-lifecycle-card-consistency.md"
github_issue: null
github_state: null
github_url: null
---

# Team 完成报告 Note 被显示为未开始任务

## What Happened

已完成的 Team Run 中，真实 Task 已经是 `COMPLETED`，会话也包含提交、推送和 QA 通过证据，
但左侧任务树仍出现标题为“优化分析报告”“P0-1 完成报告”“P0-2 完成报告”的未勾选行，
状态显示为 `NOT STARTED`。

## Expected Behavior

- 持久化 `Task` 是任务树的主要且唯一可变工作项来源。
- 完成报告属于文档/交付物，不应成为第二个任务节点。
- 一个已完成 Task 在任务树中只出现一次，并显示为已勾选的 `DONE`。
- 历史 task Note 兼容必须基于明确任务字段，不能只根据 `metadata.type` 判断。

## Confirmed Evidence

复现 Team Run：`260d08a9-f18f-42d6-9bce-f40f5ee97e7f`。

三个错误节点对应：

- `report-code-quality-architecture`
- `task-p0-1-dep-security-report`
- `task-p0-2-contact-form-report`

它们都是只有 `metadata: { type: "task" }` 的 Note，没有 `taskStatus`、`linkedTaskId`、
`parentNoteId` 或分配信息。对应的真实持久化 Tasks 已通过 Team Run scoped Tasks API 核验为
`COMPLETED`。

## Why This Happens

1. 通用 `create_note` 工具允许 Agent 选择 `type: "task"`，但工具没有解释“任务报告仍应使用
   `general`”，也无法同时写入结构化任务关联字段。
2. `buildTeamTaskTree()` 将所有未匹配 `linkedTaskId` 的 task 类型 Note 保留为 legacy task。
3. legacy 节点使用 `normalizeTaskStatus(note.metadata.taskStatus)`；缺少状态时默认成为
   `not-started`。

因此，报告 Note 被重复投影成了一个新的未开始任务。真实 Task 状态没有丢失。

## Scope

修复写入分类与 Team 任务树读取保护：

- 报告类 Note 使用 `general`；
- 通用 Note 创建不能生成缺少任务语义字段的裸 task Note；
- legacy task Note 必须具有显式任务语义字段；
- 保留结构化历史 task Note 和 `linkedTaskId` 去重；
- 提供有 dry-run、可限定 workspace/session 的旧数据修复方式。

不修改 Task/Kanban 状态机，不从报告文本推断完成状态，也不处理时间线刷新问题。

## Implementation Specification

Follow
[`docs/design-docs/team-report-note-task-tree-classification.md`](../design-docs/team-report-note-task-tree-classification.md).

实现不得只改标题提示或只修复这三个 Note ID。必须同时关闭写入端和读取端，否则新 Team Run
仍会复现。

## Verification Required

- Team task-tree model 回归测试：`COMPLETED` Task + bare task report Note 只显示一个 `DONE` 节点。
- MCP/domain 测试：通用 `create_note(type="task")` 被拒绝并给出正确引导。
- REST Note API 测试：裸 task Note 拒绝，结构化 task Note 保持兼容。
- 旧数据修复 dry-run/idempotency/scoping 测试。
- 使用真实 Team Run 做浏览器核验：报告仍在 Deliverables，任务树不再出现重复未开始节点。

## Resolution (2026-08-18)

按 `docs/design-docs/team-report-note-task-tree-classification.md` 同时关闭写入端与读取端：

- 读取端：`team-run-page-model.ts` 的 `isLegacyTaskNote` 使用共享谓词
  `hasTaskSemanticMetadata`（`src/core/models/note.ts`），仅带 linkedTaskId / taskStatus /
  parentNoteId / 非空 assignedAgentIds 的历史 task Note 进入 legacy 分支；裸
  `{type:"task"}` 报告不再投影为任务节点；持久化 Task 为唯一主源，COMPLETED 只显示一次 DONE。
- 写入端：`NoteTools.createNote`、两个 MCP 表面（`mcp-tool-executor.ts`、
  `routa-mcp-tool-manager.ts`）与 REST `POST /api/notes` 均拒绝裸 task 创建并给出
  create_task / convert_task_blocks 引导；结构化 task Note 与既有畸形记录的可读可编辑性保留。
- 修复工具：`scripts/maintenance/repair-bare-task-notes.ts`（`npm run notes:repair-bare-task`），
  默认 dry-run、`--workspace` 必需、可选 `--session`、`--apply` 显式生效、幂等。

验证：命名 vitest 套件全绿（model 40、note-tools 12、MCP 双表面、repair 7、Notes API 14）；
fitness fast 100.0 / normal 93.3（hard_gate_blocked=false）；`validate:web` 的 lint/tsc/
api-schema/dependency-cruiser/test:run 全过，仅 snapshots:validate 因基线自 2026-03-13 起陈旧
（与在途 UI rebrand 叠加）失败——既有问题，与本修复无关。浏览器核验
`260d08a9-f18f-42d6-9bce-f40f5ee97e7f`：任务树 12 个持久化 Task 全部 DONE、无幻影未开始节点；
三份完成报告在 Deliverables 可见；刷新后保持不变（截图存 `tmp/qa-note-classification/`）。

附带发现（未在本 issue 修复，另开跟进候选）：`tests/api-contract/test-schema-validation.ts`
向运行中的 default workspace POST "Schema Validation Note" 且无清理，验证运行曾污染真实 DB，
叠加 Deliverables 既有 top-8 上限一度把完成报告挤出可见区；本次已删除 5 条测试残留 Note。

## References

- Design: `docs/design-docs/team-report-note-task-tree-classification.md`
- Existing lifecycle design: `docs/design-docs/team-task-lifecycle-consistency.md`
- Prior resolved lifecycle issue: `docs/issues/2026-08-11-team-task-lifecycle-card-consistency.md`
