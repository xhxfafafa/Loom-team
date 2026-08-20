# Loom 个人多智能体工作台：品牌与前端体验改造方案

**状态**：待实施  
**创建日期**：2026-08-16  
**产品定位**：面向个人开发者的多智能体软件协作工作台  
**目标品牌**：Loom

## 1. 背景与目标

当前产品已经具备 Workspace、Kanban、Team Run、Session、Trace、Harness 等完整能力，但
产品界面仍混合存在 `Loom-team`、`Routa` 和旧 Desktop/Tauri 命名，主导航也同时暴露了
核心工作流与开发治理工具。对个人用户而言，入口较多、优先级不清，第一次使用时难以快速
理解“从目标到交付”的主线。

本次改造目标：

1. 所有用户可见品牌统一为 **Loom**。
2. 让核心流程变成：选择项目 → 创建任务 → Kanban 推进 → Team 协作 → 查看结果。
3. 保留现有主题颜色与浅色/深色能力，不进行全量换肤。
4. 主导航只展示高频页面；高级能力保留路由，通过“更多/高级工具”进入。
5. 优先改善 Kanban 与 Team 页面的人性化表达，不改变其核心自动化语义。
6. 增加本地背景图片个性化功能，不上传用户图片。
7. 中文作为首次使用默认语言，继续支持中英文切换并尊重已有用户选择。

## 2. 产品原则

### 2.1 核心定位

推荐产品文案：

> Loom —— 面向个人开发者的多智能体软件协作工作台。

英文文案：

> Loom — A personal multi-agent workspace for software delivery.

### 2.2 保留的架构不变量

- Workspace 仍然是所有任务、Session、Team Run 和代码库的顶层边界。
- Kanban 列移动仍可能触发 Agent 自动化，视觉改造不得把它降级成纯展示看板。
- Team Run 的 Session 恢复、流式输出和 Prompt 交付协议保持不变。
- API 路径、数据库结构和协议类型不因品牌改造而重命名。
- UI 文案必须进入 i18n，不在组件中硬编码中文或英文。
- Shell 继续消费 `--dt-*` 主题 token，不建立第二套颜色系统。

## 3. 品牌改造边界

### 3.1 用户可见内容

以下内容统一改为 Loom：

- 浏览器标题、description、favicon、apple touch icon。
- 侧边栏名称、图片 alt、登录/引导/空状态文案。
- README、中文 README、架构文档首页和部署说明中的产品名。
- `package.json` 的 name、description、homepage、bugs、repository 和 keywords。
- Docker、Vercel、示例环境变量说明及公开部署文案。
- Storybook、截图快照和测试中面向用户的品牌断言。

### 3.2 内部兼容层

用户界面不再显示 Routa，但以下内部符号首阶段保留：

- `ROUTA` Agent 角色枚举。
- `RoutaSystem`、`RoutaRpcClient` 等内部 TypeScript 标识。
- 已发布 API、数据库字段、事件名和协议字段。

界面将 `ROUTA` 显示为“协调者 / Coordinator”。内部标识重命名属于独立的低优先级技术债，
不能和本次 UI 改造混在一起。

### 3.3 浏览器存储键迁移

现有 `routa.*` LocalStorage 键迁移为 `loom.*`：

- 首次读取优先读取 `loom.*`。
- 新键不存在时读取旧键并复制到新键。
- 一个兼容周期内保留旧键读取，避免主题、语言和侧边栏状态丢失。
- 不在本次改造中删除旧键或清空用户数据。

## 4. Logo 与图标系统

### 4.1 Logo 概念

正式方向为 **Orbit L**，由三种语义组成：

- L 形单线框架：直接建立 Loom 的名称识别。
- 单一协作轨道：用一次穿插表达多个 Agent 围绕同一目标协作，避免具象 DNA/编织图案。
- 两个克制节点：分别表达任务入口与协作过程，不再使用多色 Agent 圆点阵列。

风格要求：

- 几何、极简、可在 16px 下识别。
- 不使用聊天气泡或机器人头像。
- 仅沿用当前主题的蓝色与中性色，不新增品牌主色或黄绿辅助色。
- 提供 symbol、wordmark、light、dark、favicon 五种 SVG 资产。
- 动画版本只用于 README 或首次引导，不进入高频导航，避免干扰。

### 4.2 实现方式

- Logo 使用手工维护的 SVG/vector，不生成位图主资产。
- 建立一个共享 `LoomMark` React 组件，页面不直接复制 SVG。
- `public/logo*.svg` 统一替换；旧文件名可先保持以降低引用改动，内容和 alt 必须更新。
- 为 16、32、180、512 像素场景验证边缘清晰度。

## 5. 信息架构与导航

### 5.1 主导航

主导航保留：

1. 首页
2. Kanban
3. Team
4. Sessions

底部保留：

- 高级工具
- 设置

### 5.2 高级工具

从主导航隐藏但不删除：

- Spec
- Feature Explorer
- Harness
- Fluency
- Traces
- MCP Tools
- Schedules
- Webhooks
- Workflows
- Specialists

“高级工具”使用弹出菜单或独立索引页显示这些入口。所有现有 URL 保持可访问，书签和深链不失效。

### 5.3 导航行为

- Workspace 切换保持全局可见。
- 当前页面必须具有明确 active 状态。
- 高级页面激活时，“高级工具”入口显示 active 状态。
- 折叠侧边栏仍保留 tooltip 和 accessible name。
- 移动/窄窗口下不新增全新的导航模型，先沿用当前 shell 的折叠能力。

## 6. 页面体验方案

### 6.1 首页

首页从功能陈列改为个人工作台：

- 顶部：当前 Workspace、代码库和运行环境状态。
- 主操作：输入“你想完成什么”，可直接创建任务或 Team Run。
- 最近工作：最近 Kanban 任务、Team Run、Session。
- 首次使用：连接代码库 → 选择 Agent → 创建任务 → 查看交付的四步引导。
- 高级治理数据不占据首页主视觉。

### 6.2 Kanban

保留现有列、拖拽、自动化、队列和 Git 交互，小步优化：

- 页面头部只保留看板名、运行状态、创建任务和更多操作。
- 新建任务使用清晰的主按钮；支持从自然语言目标快速生成卡片。
- 卡片优先显示标题、状态、执行 Agent、最近活动和阻塞原因。
- 自动化列使用轻量标识说明“移入后会启动 Agent”。
- 拖入自动化列前仅在存在高成本或破坏性操作时确认，普通移动不增加弹窗。
- 空列、加载、失败、无代码库状态使用统一组件与人性化说明。
- 文件变化、Git 详情和高级配置保持二级展开，不挤占主看板。

### 6.3 Team

保留 Team Run 列表与详情能力，小步优化：

- Team 首页突出“新建协作任务”和最近运行。
- 创建流程按“目标 → 选择协作方式 → 确认运行”组织，隐藏不必要的协议术语。
- Team Run 详情优先展示：当前目标、协调者状态、Agent 成员、进度、对话与交付物。
- 将内部状态翻译成用户语言，例如 `restorable` 显示为“可恢复”。
- 恢复、重试、等待租约等状态使用统一 banner，不暴露内部实例 ID。
- 保留现有 Team Run 恢复逻辑，UI 重构不得改变 `selectSession` 与 `session/load` 的互斥关系。
- 超长 `team-run-page-client.tsx` 按“页面编排壳 + 数据/恢复 hook + 视图区域”继续拆分，避免扩大现有文件预算超限。

### 6.4 Sessions

- 作为历史与单 Agent 执行入口保留在主导航。
- 强化搜索、最近使用和状态筛选。
- 将 Trace、上下文和调试信息放入详情二级入口。

## 7. 中文默认与国际化

- 将 `DEFAULT_LOCALE` 改为 `zh`，服务端首屏 `<html lang>` 同步为中文。
- 已保存语言选择的用户继续使用原选择。
- 语言切换仍提供中文/English。
- 品牌名 Loom 不翻译。
- 用户可见的 `Routa` 全部替换为 Loom 或“协调者 / Coordinator”。
- 增加测试：无存储时默认中文、旧键迁移、显式 English 设置优先。

## 8. 背景图片功能

### 8.1 范围

在“设置 → 外观”增加背景设置，默认不启用。背景可应用到整个 Workspace 主内容区，首页、
Kanban、Team 和 Sessions 使用同一设置；侧边栏与标题栏继续使用现有主题背景，保证导航稳定。

支持：

- 上传 JPG、PNG、WebP。
- 预览、应用、更换、恢复默认。
- 调整遮罩强度、模糊程度和图片位置。
- `cover` 填充，避免不同窗口比例产生空白。
- 深浅主题分别记录遮罩强度，但共用背景图片。

### 8.2 存储

- 图片 Blob 保存到 IndexedDB，避免 LocalStorage 体积限制。
- LocalStorage 仅保存开关和展示参数，例如 `loom.appearance.background`。
- 图片只保存在当前浏览器，不上传服务器、不写入代码仓库、不跨设备同步。
- 首版限制单张图片不超过 8 MB，并在选择时校验 MIME 和大小。
- 使用 Object URL 展示，切换或卸载时释放 URL，避免内存泄漏。

### 8.3 可读性与性能

- 背景层放在共享 Shell 内，内容层保持独立 stacking context。
- 默认增加半透明主题遮罩，不直接降低所有内容组件 opacity。
- 面板仍使用现有 `--dt-bg-*` token；必要时只增加语义化的背景透明 token。
- 尊重 `prefers-reduced-motion`，背景不增加视差或持续动画。
- 图片解码失败时自动回退默认背景并显示可恢复错误。
- E2E 验证刷新后仍可加载、恢复默认后 Blob 与设置都被清理。

### 8.4 建议模块

- `src/client/appearance/background-store.ts`：IndexedDB 读写和对象 URL 生命周期。
- `src/client/appearance/background-preference.ts`：设置模型与旧值兼容。
- `src/client/components/workspace-background.tsx`：共享背景渲染层。
- `src/client/components/background-settings.tsx`：设置、预览与重置 UI。

## 9. 实施阶段与提交边界

### 9.0 多 Agent 交接边界

当前 Logo/方案 Agent 负责：

- 确定 Logo 概念与视觉语义。
- 交付 `public/logo.svg`、`logo-symbol.svg`、`logo-symbol-dark.svg` 和
  `logo-animated.svg`。
- 维护本实施方案和交接 Prompt。

后续实施 Agent 负责：

- 将既定 Logo 接入产品、文档、favicon 和部署表面，不重新设计 Logo。
- 完成品牌文案、导航、中文默认、背景图片、Kanban 和 Team 的实现与验证。
- 按阶段拆分提交，保护工作区已有改动。

后续实施 Agent 不得：

- 删除高级页面或对应 API。
- 修改现有主题颜色体系。
- 重命名数据库、API、协议字段或内部 `ROUTA` 角色枚举。
- 改变 Kanban 列迁移触发、队列并发或 Team Session 恢复语义。
- 顺带处理与本计划无关的问题或进行全仓抽象重构。

### 阶段 0：基线

- 记录首页、Kanban、Team、Sessions、设置的当前截图与可访问性结构。
- 锁定关键导航、Kanban 自动化与 Team 恢复行为测试。
- 建立完整的品牌字符串清单，区分用户可见与内部兼容符号。

### 阶段 1：品牌基础

- 新 Logo、favicon、metadata 和共享 `LoomMark`。
- 中文默认与存储键兼容迁移。
- 用户可见品牌文本替换。
- 更新 package、README、部署与仓库链接。

建议提交：`feat(brand): establish Loom product identity`

### 阶段 2：Shell 与导航

- 精简主导航。
- 增加高级工具入口。
- 保持全部深链可访问。
- 更新 shell Storybook、单元测试和 E2E baseline。

建议提交：`feat(navigation): focus Loom on core workflows`

### 阶段 3：背景个性化

- IndexedDB 背景存储。
- Shell 背景层。
- 设置页外观面板。
- 大小、格式、解码错误和重置测试。

建议提交：`feat(appearance): add local workspace backgrounds`

### 阶段 4：Kanban 体验

- 页面头部、卡片信息层级、空状态和自动化提示。
- 不修改列迁移触发和队列语义。
- 补 Playwright 主流程与视觉证据。

建议提交：`feat(kanban): simplify personal task coordination`

### 阶段 5：Team 体验

- Team 列表、创建流程、运行详情的信息层级。
- 拆分超长页面编排文件。
- 保留并回归 stale-owner recovery 与 prompt exactly-once 行为。

建议提交：`feat(team): clarify multi-agent run experience`

### 阶段 6：首页、Sessions 与文档收尾

- 个人工作台首页和 Sessions 二级调试入口。
- 清理剩余用户可见 Routa/Loom-team 文本。
- 更新部署、截图、README 和产品说明。

建议提交：`docs(brand): complete Loom product documentation`

## 10. 验证标准

每一阶段至少执行对应的单元测试和：

```bash
npm run lint:css
npm run lint:brand-semantics
npm run lint:color-system
npm run storybook:governance
npm run fitness:run -- --tier fast --scope local --min-score 0
```

完成 UI 阶段后执行：

```bash
npm run fitness:run -- --tier normal --scope local --min-score 0
npm run test:e2e:web-shell
npm run test:accessibility
npm run validate:web
```

验收结果：

- 浏览器与产品主界面不再出现用户可见的 Routa 或 Loom-team。
- 首次打开默认中文；已有英文选择不被覆盖。
- 主导航只显示首页、Kanban、Team、Sessions、高级工具和设置。
- 所有被隐藏页面仍能通过高级工具或原 URL 打开。
- Kanban 列移动仍按原规则触发自动化。
- Team Run 的 active/restorable 恢复路径及 Prompt exactly-once 测试保持通过。
- 背景图片不产生网络上传，刷新后可恢复，重置后清理本地数据。
- 无背景、浅色、深色和自定义背景四种状态下文字与交互控件清晰可用。
- 关键页面具备一个 `<main>`、有效标题和可命名交互元素。

## 11. 非目标

- 本轮不重写 API、数据库或 Agent 协议。
- 不删除高级页面及其后端能力。
- 不重新设计主题颜色。
- 不将个人背景图片同步到服务器或多设备。
- 不在品牌阶段批量重命名所有 `Routa*` 内部类与文件。
- 不同时实施移动端全新布局。

## 12. 风险与控制

- **品牌字符串误伤协议**：先生成清单，只替换用户可见层；内部标识单独评审。
- **导航隐藏导致能力不可发现**：提供高级工具索引、搜索和原 URL 兼容。
- **背景降低可读性**：使用独立遮罩、默认强遮罩和面板 token，不修改内容 opacity。
- **IndexedDB 不可用**：捕获异常并回退默认背景，不阻塞主流程。
- **Kanban UI 改动影响自动化**：先用行为测试锁定列迁移和队列不变量。
- **Team 页面重构影响恢复**：保留恢复 hook，围绕 active/restorable/prompt delivery 做特征测试。

## 13. 交给实施 Agent 的 Prompt

> 请在当前仓库实施 `docs/exec-plans/active/loom-product-ui-rebrand.md`。严格遵守文档中的
> 多 Agent 交接边界，保留现有主题色、路由、API、Kanban 自动化与 Team 恢复语义；不要
> 重新设计 `public/logo*.svg`。按文档阶段做 baby-step 提交，每阶段补齐 i18n、测试和视觉
> 验证；遇到与现有未提交改动重叠时先停止并说明。
