# Loom-team 技术架构设计书

原单文件设计书经过实现核验后已拆分，详细入口如下：

- [Loom-team 详细架构](../architecture/README.md)
- [架构事实核验报告](./loom-team-architecture-verification-2026-08-19.md)

拆分原因：原文将当前架构、过渡状态和目标设计混在一个 1200 余行文件中，且部分理想化状态机与真实运行语义不一致。新的文档集以 `Current / Transitional / Target / Open` 标记状态，并将实现路径集中到单独映射表。
