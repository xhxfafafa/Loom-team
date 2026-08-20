# 安全与权限

## 1. 当前信任模型

### Current

系统主要面向可信本地或受保护内网。没有覆盖全部 API 的统一用户认证中间件，也没有完整 Workspace ACL。Workspace ID 是资源作用域，不等同于访问授权。

因此高权限 ACP/MCP、Git、Worktree、Docker 和 Webhook 管理接口不应在没有外层身份网关的情况下直接暴露公网。

## 2. 已有安全边界

| 边界 | 当前能力 |
|---|---|
| MCP Request | 8 MiB Body 上限，避免无界 JSON 缓冲 |
| MCP Profile | Planning/Team Allowlist 与高风险 Task 字段写边界 |
| Permission | Agent 可请求 Coordinator 批准，并可携带 Sandbox Constraints |
| Sandbox | Workspace/Workdir Policy、Capability 和 Network Mode |
| Delivery Gate | Artifact、Checklist、Approval、Validator 和 Git Readiness |
| Webhook | GitHub HMAC-SHA256、Timing-safe compare、Trigger Log |
| Docker | Workspace/凭据挂载和环境变量脱敏辅助 |
| Trace | 可记录 Tool、文件与 VCS 上下文用于审计 |
| Attachment | 类型、数量、大小和 MIME 服务端复验；内容不进入日志；输入与证据分离 |
| Repository Guard | 提交前、推送前和 CI 对异常批量删除进行分层检测 |

## 3. Permission 语义

Permission Request 包含 Requester、Coordinator、Capability、Reason、Risk、Decision、Constraints 和 Response。只有 Pending 请求可以响应，重复响应返回失败。

### Transitional

PermissionStore 是进程内 Map：

- 重启后 Pending 请求消失；
- 多实例看不到彼此请求；
- 它不能充当不可抵赖审计记录。

Sandbox Constraint 应用可以调用内部 Sandbox API；当前仍保留可选外部 Rust Sandbox URL 的兼容代理语义，属于迁移残留边界。

## 4. Provider 权限差异

部分 Provider 为避免工具调用卡在无人处理的交互权限上，会使用自动批准或跳过权限的启动模式。平台 Permission UI 与 Provider Native Permission 不是完全等价。

架构要求：

1. Provider 是否跳过原生权限必须显式可见。
2. Platform Tool/Sandbox Policy 必须在 Provider 之外再次限制能力。
3. 不能把 Provider 的“自动批准”解释为用户授权。

## 5. Webhook 安全

GitHub Webhook 按 Config Secret 验证 HMAC。Secret 为空时接受所有签名，必须限制为开发或显式不安全模式。公网模式必须拒绝空 Secret，并按 Delivery ID 去重和防重放。

## 6. A2A Auth

A2A Auth Config 从环境配置解析 Header，并用于向远端 Agent 请求注入认证信息。它解决出站认证，不是 Loom-team 用户登录系统。

## 7. 主要威胁

| 威胁 | 当前覆盖 | 缺口/建议 |
|---|---|---|
| 未授权 API 调用 | 外层网络可保护 | Target：统一身份认证 |
| Workspace 越权 | 有 Workspace 参数/校验 | Target：用户 ACL 与对象归属授权 |
| MCP Tool 越权 | Profile/Write Boundary | Target：Session Capability Token |
| Prompt Injection | Gate 与 Sandbox 降低副作用 | 仍需不信任仓库/网页内容 |
| 路径穿越 | Workdir/Workspace Policy | 对所有文件 Tool 统一 Canonical Path 检查 |
| 命令注入 | 部分 Shell Escape | 对 Provider/Docker/Git 参数持续威胁建模 |
| Secret 泄漏 | 环境变量脱敏辅助 | 禁止进入 Prompt/Trace，使用短期凭据 |
| 容器逃逸 | Docker 隔离 | 最小挂载、非 Root、Capabilities 和网络限制 |
| Webhook 重放 | HMAC | 缺 Delivery ID Inbox |
| Runner 冒充 | 当前无完整远程 Runner 信任协议 | Target：双向身份与短期 Job Token |
| 批量文件误删 | Git 多层阈值检查 | 保留显式例外、审计理由和服务端门禁 |
| 提交身份污染 | 应用校验及部分 Hook/CI 设计 | 将作者与测试凭据校验收敛为统一门禁 |
| 附件型 Prompt Injection | 输入标签和 Sandbox | 内容始终视为不可信，不提升为系统指令 |

## 8. 仓库变更的纵深防护

仓库安全属于开发治理边界，不替代运行时授权。异常批量删除采用多层检查：提交前检查暂存删除、推送前检查将发送的提交、CI 在合并前复核。当前设计阈值为 200 个删除文件；超过阈值默认阻断，合法大规模重构必须显式说明并走受控例外，而不是静默绕过。

提交身份安全同样采用应用校验、Git Hook、推送检查和 CI 复核。测试身份、占位邮箱或异常作者不得进入主分支历史。具体层次和落地状态分别以 [File Deletion Safety](../design-docs/file-deletion-safety-mechanism.md) 与 [Git Commit Safety](../design-docs/git-commit-safety-mechanism.md) 为准；后者仍含未全部实现的设计项，不能整体宣称为 Current。

## 9. Target 授权模型

```text
Allow = User Identity
     ∩ Workspace ACL
     ∩ Session Capability
     ∩ MCP Tool Profile
     ∩ Sandbox Policy
     ∩ Operation-specific Gate
```

任何一层拒绝即禁止执行。

## 10. Target 分阶段

### 公网前必须完成

- 用户身份与 Workspace ACL；
- API、SSE、MCP 和 Runner 身份统一；
- CSRF/Origin、Rate Limit 和审计；
- Permission 持久化；
- Webhook 强制 Secret 与 Delivery 去重；
- Secret 生命周期和脱敏验证；
- 高风险 Tool 默认拒绝。

### 独立 Runner 前必须完成

- Runner 注册、双向认证和 Heartbeat；
- Job Scope Token；
- Repository/Secret 最小下发；
- Sandbox Attestation 与审计事件。

## 11. 部署建议

在上述 Target 完成前，默认部署声明应是“可信本地/内网工具”，而不是“公网多租户服务”。

[返回目录](./README.md)
