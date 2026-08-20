---
title: "chat transcript becomes stale when live session updates are missed"
date: "2026-08-16"
kind: issue
status: resolved
severity: medium
area: "chat-ui"
tags: ["chat", "session", "refresh", "sse", "web"]
reported_by: "human"
related_issues: []
github_issue: null
github_state: null
github_url: null
---

# 对话记录在实时更新丢失后只能通过手动刷新恢复

## What Happened

Web 对话页偶尔不会展示服务端已经持久化的新消息。用户必须手动刷新整个页面，才能看到最新对话记录。

## Expected Behavior

对话页应优先消费 SSE 实时事件；即使实时事件断开或漏发，也应在短时间内自动同步当前会话的已持久化 transcript，不要求用户刷新页面。

## Reproduction Context

- Environment: web
- Trigger: 打开一个仍在产生消息的 session，SSE 更新没有到达当前页面或连接短暂中断

## Why This Happened

- 当前 transcript 只在首次进入、切换 session 和收到 `turn_complete` 时主动重载。
- SSE 是唯一的持续更新来源；连接漏消息后没有低频同步兜底，也没有在页面重新获得焦点时重载。
- ACP 切换 session 时会清空 `updates` 缓冲区，但聊天 hook 原先没有同步重置已处理下标；新缓冲区长度尚未超过旧下标时，新消息会被跳过。

## Relevant Files

- `src/client/components/chat-panel/hooks/use-chat-messages.ts`
- `src/client/components/chat-panel/hooks/__tests__/use-chat-messages.test.tsx`

## Observations

- `fetchSessionHistory(sessionId, { force: true })` 已支持强制重载，可作为自动同步的现有入口。
- 已增加当前可见 session 的 5 秒低频 transcript 同步；最近 5 秒收到过 SSE 消息时跳过轮询。
- 标签页重新可见或窗口重新获得焦点时立即同步；隐藏标签页不轮询。
- transcript 请求按 session 去重，避免定时同步与其他重载路径产生并发请求。
- ACP 更新缓冲区清空或缩短时重置已处理下标，恢复会话切换后的实时消息处理。
- 相关 hook 测试覆盖定时同步、回到前台同步和 ACP 更新缓冲区重置。
