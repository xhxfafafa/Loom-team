<div align="center">

<img src="public/logo-animated.svg" alt="Loom-team" width="360" />

# Loom-team

**以工作区为核心、面向软件交付的多智能体协同平台（Web-only）**

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16.2-black.svg)](https://nextjs.org/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

[演示](#演示) • [架构](#架构) • [工作流程](#工作流程) • [为什么是 Loom-team](#为什么是-loom-team) • [快速开始](#快速开始) • [文档](#文档) • [English](README.md)

</div>

---

Loom-team 是一个以工作区为核心的多智能体协同平台，面向真实的软件交付流程。它把目标、任务、会话、追踪、证据和评审状态放回看板，而不是让这些信息淹没在单一聊天线程里。

本仓库是该产品的 Web-only 版本：由单一 Next.js 后端同时承载 UI、API 与 Agent 运行时。原 Tauri 桌面壳与 Rust 后端 crates 已被移除，其面向 Web 的能力已全部移植到 TypeScript/Node。

[架构文档](docs/ARCHITECTURE.md) · [功能树](docs/product-specs/FEATURE_TREE.md) · [快速开始](docs/quick-start.md) · [贡献指南](CONTRIBUTING.md)

## 演示

- [Bilibili 演示视频](https://www.bilibili.com/video/BV16CwyzUED5/)
- [YouTube 演示视频](https://www.youtube.com/watch?v=spjmr_1AQLM)

![Loom-team Kanban Overview](https://github.com/user-attachments/assets/8fdf7934-f8ba-469f-a8b8-70e215637a45)

## 架构

### 系统架构

![Loom-team architecture](docs/architecture.svg)

当前实现是单后端 Web 产品。

- Web：`src/` 中的 Next.js 页面与路由处理器，底层是 `src/core/` 的 TypeScript 领域核心
- 存储：本地优先开发使用 SQLite，生产部署使用 Postgres
- 契约：`api-contract.yaml` 是后端所有端点的唯一事实来源
- 集成表面：ACP、MCP、A2UI、REST 与 SSE

> 说明：内部标识符（环境变量前缀 `ROUTA_`、部分组件与 key 名称）在本版本中有意保持不变。
> 完整的品牌重命名是独立的后续阶段。

### Review Gate 架构

![Loom-team review gate](docs/review-gate.svg)

交付 Gate 不是一个 reviewer 角色，而是一条分层决策路径。

- Harness traces 负责回答“到底发生了什么”，它暴露 traces、改动文件、执行命令、git 状态和归因信息
- Fitness functions 负责回答“哪些事情必须成立”，它执行 hard gates、证据要求以及文件预算或策略检查（TypeScript fitness 引擎位于 `scripts/fitness/` 与 `src/core/fitness/`）
- Gate Specialist 负责回答“这张卡是否可以继续前进”，它逐条验证 acceptance criteria，并决定进入 Done、打回 Dev 或升级到人工处理

## 工作流程

```text
你："构建一个包含登录、注册和密码重置的用户认证系统"
                                                            ↓
                                    Workspace + 看板
                                                            ↓
 Backlog              Todo              Dev               Review            Done
 Backlog Refiner  ->  Todo Orchestrator -> Dev Crafter -> Review Guard -> Done Reporter
                                                            ↘
                                                                Blocked Resolver
```

Loom-team 把看板同时当成规划界面和协同总线。关键点在于：每个泳道背后都是不同的 specialist prompt，而且下游泳道会故意比上游更严格。

可以把它理解成两层 specialist 同时工作：

- 核心角色层：ROUTA 负责协调，CRAFTER 负责实现，GATE 负责验证
- 看板泳道层：每个列都有自己的 prompt 合同和证据合同

### 端到端过程

1. 你用自然语言描述目标。
2. ROUTA 或看板自动化把这个目标变成 workspace 范围内的卡片。
3. Backlog Refiner 把粗糙需求改写成 canonical YAML story，里面必须有 acceptance criteria、constraints、dependencies 和 INVEST 快照。
4. Todo Orchestrator 不信任上游卡片，会重新解析 YAML，退回质量不足的卡片，并补出可以直接执行的 brief。
5. Dev Crafter 再次检查计划是否可执行，只有在 story 足够清晰时才开始编码；它只实现卡片范围内的变更，运行验证，提交代码，并追加 Dev Evidence。
6. Review Guard 不信任 Dev 的自评，会逐条独立验证 acceptance criteria，要求测试证据和干净的 git 状态，然后要么打回 Dev，要么批准进入 Done。
7. Done Reporter 追加一个简短的完成总结，说明交付了什么，以及依靠什么证据判定它已完成。
8. 如果工作被环境、依赖或需求歧义阻塞，Blocked Resolver 会把阻塞原因写清楚，并把卡片路由回正确泳道，而不是让问题继续隐式存在。

### 泳道合同

| 泳道 | Specialist | Prompt 强制要求 | 会写回卡片的内容 | 典型交接 |
| --- | --- | --- | --- | --- |
| Backlog | Backlog Refiner | 只澄清范围，不允许编码；除非卡片里存在且仅存在一个 canonical YAML story block，否则不能推进 | Canonical YAML story，包含问题陈述、验收标准、影响范围、依赖、out-of-scope 与 INVEST 检查 | 只有 story 可解析且可独立执行时才移动到 Todo |
| Todo | Todo Orchestrator | 重新验证 Backlog 产物，拒绝格式错误或模糊卡片，把有效 story 变成 execution-ready brief | Execution Plan、Key Files and Entry Points、Dependency Plan、Risk Notes | 只有实现者能在几分钟内开工时才移动到 Dev |
| Dev | Dev Crafter | 再次确认卡片真的可执行，只实现范围内改动，运行验证，提交代码，并保持 git 干净 | Dev Evidence，含修改文件、完成内容、测试记录、逐条 AC 验证、注意事项 | 只有存在提交且 worktree 干净时才移动到 Review |
| Review | Review Guard | 独立验证每条 acceptance criteria，拒绝缺失证据、scope creep、dirty git、lint 或类型检查失败 | Review Findings，含 verdict、逐条 AC 状态、发现的问题、评审备注 | 只有明确 APPROVED 才移动到 Done |
| Done | Done Reporter | 把 Done 视为终态，不再向后推进，只留下简明 completion note | Completion Summary，含交付内容、关键证据和完成时间 | 保持在 Done |
| Blocked | Blocked Resolver | 分类 blocker、解释根因，只有在存在明确下一步时才重新路由 | Blocker Analysis，含 blocker type、root cause、resolution、routing decision | 返回 Backlog、Todo、Dev、Review，或继续停留在 Blocked |

### 卡片产物会逐步变严格

同一张卡片会随着流转不断补充结构化产物：

- Backlog 产出 canonical story YAML
- Todo 产出 execution brief
- Dev 产出实现与验证证据
- Review 产出正式 verdict 与 findings
- Done 产出 completion summary

这也是为什么看板不只是视觉状态。每推进一列，下一位 specialist 能信任的内容都会被重新定义。

### 看板背后的核心 Specialist Prompt

- ROUTA Coordinator：先做计划，绝不直接改文件，先写 spec，等用户批准，再按 wave 委派实现，并在实现后拉起 GATE 做验证。
- CRAFTER Implementor：严格待在任务范围内，不做顺手重构，不做 scope creep；如果有文件冲突需要先协调；按任务要求运行验证并做小步提交。
- GATE Verifier：只对 acceptance criteria 负责，证据不足就不算通过，不允许部分批准，输出必须是明确 verdict，而不是模糊判断。

内置的 Kanban 泳道 prompt 在 `resources/specialists/workflows/kanban/*.yaml`，核心角色 prompt 在 `resources/specialists/core/{routa,crafter,gate}.yaml`。

## 为什么是 Loom-team

单一 Agent 聊天适合处理孤立任务，但一旦同一条线程同时承担拆解、实现、评审、证据收集和发布决策，语义边界就会迅速混乱。

Loom-team 把这些职责显式化：

- 工作从 workspace 开始，而不是隐式的全局仓库状态
- 看板泳道负责在不同 specialist 之间路由工作，而不是把所有角色揉进一个 prompt
- 会话、追踪、笔记、产物、代码库和 worktree 都是持久化对象
- Provider 运行时通过适配层做标准化，而不是把各家的协议差异直接暴露到产品层
- Review 边界是一个真正的交付 Gate，而不是另一个带主观看法的 reviewer

## 当前能力

- 创建以 workspace 为范围的 overview、Kanban、session、team 和 codebase 视图
- 运行 Agent 会话，并支持 create、prompt、cancel、reconnect、streaming 与 trace 检查
- 通过队列和每个看板的自动化策略在 specialist 泳道之间路由任务
- 管理本地仓库、worktree、文件搜索、Git refs 和提交检查
- 将 GitHub 仓库导入为虚拟 workspace，并浏览目录树、文件、issue、PR 和评论
- 接入 MCP 工具以及自定义 MCP server
- 用 schedule、webhook、background task 和 workflow run 驱动持续自动化
- 基于 findings、severity、trace、harness signals 和 fitness report 做评审
- 以 self-hosted web 模式部署：本地优先使用 SQLite，生产环境使用 Postgres

## 快速开始

Loom-team 完全运行在浏览器中，后端是自托管的 Next.js 服务。

```bash
npm install --legacy-peer-deps
npm run dev
```

打开 `http://localhost:3000`。

`npm run dev` 启动 Webpack dev server（内存行为更稳的默认选项）；
`npm run dev:turbopack` 保留 Turbopack dev server 用于对比和测试。生产构建不受影响。

Next dev 缓存（`.next/`）是可丢弃的生成产物，但只能在没有任何 dev server 运行时删除：

1. 停止正在运行的 dev server。
2. 运行 `npm run dev:clean` —— 检测到仍有 dev server 时会明确报错拒绝，只删除仓库内的 `.next` 目录。
3. 重新启动所选 bundler（`npm run dev` 或 `npm run dev:turbopack`）。

运行 `npm run dev:diagnose` 可以报告 `.next` 缓存大小；当 Turbopack dev 缓存
（`.next/dev/cache/turbopack`）超过 2 GiB 时会给出警告。报告问题时请附上它的输出，
而不是直接翻查本地文件。

然后：

1. 创建一个 workspace。
2. 启用一个 provider。
3. 关联一个仓库。
4. 先用 Session 做临时任务，或直接进入 Kanban 做路由式交付。

部署、环境变量与 provider 配置见
[docs/administration/self-hosting.md](docs/administration/self-hosting.md)、
[docs/deployment/index.md](docs/deployment/index.md) 和
[docs/configuration/environment-variables.md](docs/configuration/environment-variables.md)。

## 从源码开发

### Web 运行时

```bash
npm install --legacy-peer-deps
npm run dev
```

### Docker

```bash
docker compose up --build
docker compose --profile postgres up --build
```

Docker 镜像构建 standalone Next.js 产物（`ROUTA_WEB_STANDALONE=1`），对外提供同一个 Web 服务。

## 验证

把 [docs/fitness/README.md](docs/fitness/README.md) 视为权威验证规则手册。
Web-only 汇总门禁为：

```bash
npm run validate:web        # lint、tsc、api schema、dependency-cruiser、vitest、snapshots、build
npm run validate:web:e2e    # 针对测试 server 运行 contract 测试与 Team/Kanban Playwright spec
npm run test
npm run test:e2e
npm run api:test:nextjs
npm run lint
```

## 仓库地图

| 路径 | 作用 |
| --- | --- |
| `src/app/` | Next.js App Router 页面与 API 路由 |
| `src/client/` | 客户端组件、hooks、view model 与 UI 协议辅助层 |
| `src/core/` | TypeScript 领域服务：ACP/MCP、Kanban、workflow、trace、review、harness、fitness 与 stores |
| `scripts/fitness/` | TypeScript fitness 函数运行器与门禁辅助脚本 |
| `api-contract.yaml` | OpenAPI 契约：后端 API 的唯一事实来源 |
| `docs/ARCHITECTURE.md` | 权威架构边界与不变量 |
| `docs/adr/` | 架构决策记录 |
| `docs/product-specs/FEATURE_TREE.md` | 自动生成的路由与端点清单 |
| `docs/fitness/` | 验证规则与质量门禁 |

## 文档

- [架构总览](docs/ARCHITECTURE.md)
- [ADR 索引](docs/adr/README.md)
- [快速开始](docs/quick-start.md)
- [功能树](docs/product-specs/FEATURE_TREE.md)
- [Fitness 规则](docs/fitness/README.md)
- [贡献指南](CONTRIBUTING.md)
- [安全说明](SECURITY.md)

## 许可证

MIT。见 [LICENSE](LICENSE)。
