---
dimension: architecture_quality
weight: 0
tier: normal
threshold:
  pass: 100
  warn: 80

metrics:
  - name: ts_backend_core_arch_boundaries
    command: npm run test:arch:backend-core -- --suite boundaries --json 2>&1
    pattern: '"summaryStatus":\s*"(pass|skipped)"'
    hard_gate: false
    gate: advisory
    tier: normal
    execution_scope: local
    run_when_changed:
      - src/core/**
      - src/app/api/**
      - architecture/rules/backend-core.archdsl.yaml
      - scripts/fitness/architecture-rule-dsl.ts
      - scripts/fitness/check-backend-architecture.ts
      - src/app/api/fitness/architecture/route.ts
      - docs/fitness/backend-architecture.md
    description: "TypeScript backend core 边界约束（src/core / src/app/api）通过 graph 执行器做本地 advisory 检查。"

  - name: ts_backend_core_arch_cycles
    command: npm run test:arch:backend-core -- --suite cycles --json 2>&1
    pattern: '"summaryStatus":\s*"(pass|skipped)"'
    hard_gate: false
    gate: advisory
    tier: normal
    execution_scope: local
    run_when_changed:
      - src/core/**
      - architecture/rules/backend-core.archdsl.yaml
      - scripts/fitness/architecture-rule-dsl.ts
      - scripts/fitness/check-backend-architecture.ts
      - src/app/api/fitness/architecture/route.ts
      - docs/fitness/backend-architecture.md
    description: "TypeScript backend core 循环依赖通过 TypeScript graph 执行器做本地 advisory 检查。"
---

# Backend Architecture

> 本维度用于承接 TypeScript backend core 的架构边界与结构约束，不替代现有 `dependency-cruiser` 的粗粒度 repo guard。
>
> 当前阶段只覆盖 `src/core/**` 与 `src/app/api/**`，并以 `local` advisory surface 方式接入，不进入默认 CI gate。

## Why This Exists

- `code_quality` 中的 `dependency-cruiser` 适合做 repo 级依赖健康检查，但不适合作为 backend core 规则的唯一承载层。
- 共享的 TypeScript graph 执行器（由原 Rust CLI 移植而来）已经能直接表达 `src/core` 与 `src/app/api` 的定向边界规则，以及 core 内部 cycle 检测。
- Loom-team 的多语言 UI 不应依赖外部 HTML report；第一阶段先产出结构化结果，再由 Harness/Fitness 页面消费。

## Current Scope

### Boundaries

- `src/core/**` 不依赖 `src/app/**`
- `src/core/**` 不依赖 `src/client/**`
- `src/app/api/**` 不依赖 `src/client/**`

### Cycles

- `src/core/**` 内部 cycle 作为独立 suite 检测

## Runtime Contract

- 规则模型默认从 `architecture/rules/backend-core.archdsl.yaml` 读取
- `npm run test:arch:backend-core` 调用 TypeScript graph 执行器（`scripts/fitness/check-backend-architecture.ts` → `scripts/fitness/architecture-rule-dsl.ts`）运行 backend-core suite
- Next.js 的 architecture endpoint（`src/app/api/fitness/architecture/route.ts`）复用同一份执行器输出契约

## Local Commands

```bash
npm run test:arch:dsl
npm run test:arch:backend-core -- --suite boundaries
npm run test:arch:backend-core -- --suite cycles
npm run test:arch:backend-core -- --suite boundaries --json
```

## Known Limits

- 当前只覆盖 TypeScript backend core（Web-only 仓库没有其他 backend 运行时）
- 结果作为 advisory evidence 由 Harness/Fitness 页面消费
- `scripts/fitness/architecture-rule-dsl.ts` 是权威 TypeScript 执行器，`scripts/fitness/check-backend-architecture.ts` 是 backend-core suite 入口
