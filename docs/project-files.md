# 项目文件作用说明

本文件由 `scripts/update-project-docs.mjs` 生成,用于快速理解当前项目工作树下每个源码文件的主要作用。`output/` 是生成产物目录,不纳入源码文件清单。

```text
.
|-- .githooks/
|   `-- pre-commit - 本地 Git pre-commit hook,提交前重生成 README、ADR 和文件作用说明并自动 stage。
|-- assets/
|   |-- motion.min.js - 浏览器端 Motion One 动效 runtime,由渲染器复制到最终产物。
|   `-- template-swiss.html - 静态 PPT HTML 外壳模板,包含 CSS、背景、翻页、导航和动效入口。
|-- docs/
|   |-- ADR.md - 架构决策记录,描述当前生成链路和组件化边界。
|   `-- project-files.md - 项目文件作用说明,由脚本根据当前文件列表生成。
|-- examples/
|   `-- component-decks/
|       |-- ai-ops-review.jsx - AI 运营复盘示例 deck,演示技术/运营复盘主题的页面组合。
|       |-- all-layouts-showcase.jsx - Swiss S01-S22 布局总览示例 deck,顺序渲染全部原始正文布局。
|       |-- climate-field-report.jsx - 城市微气候田野报告示例 deck,演示生态/田野主题的页面组合。
|       |-- retail-launch-brief.jsx - 零售新品上市简报示例 deck,演示消费/上市主题的页面组合。
|       `-- swiss-demo.jsx - 组件选项机制 demo deck,可用环境变量切换主题和字体。
|-- references/
|   `-- component-workflow.md - 组件选项工作流参考,说明新增选项和 subagent 测试要求。
|-- scripts/
|   |-- render-deck.jsx - 渲染 CLI 入口,把 deck 配置文件输出成静态 HTML。
|   |-- update-project-docs.mjs - 文档同步脚本,更新 README、ADR 和项目文件作用说明。
|   |-- validate-layout-showcase.mjs - 布局总览覆盖校验器,确保 all-layouts-showcase 穷举所有 canonical S01-S22 布局。
|   `-- validate-swiss-deck.mjs - Swiss deck 静态校验器,检查合法 layout、图片槽位和禁用模式。
|-- src/
|   |-- components/
|   |   `-- swiss/
|   |       |-- Closing.jsx - 收尾页组件,对应 SWISS-CLOSING-ASCII。
|   |       |-- Cover.jsx - 封面组件,对应 SWISS-COVER-ASCII。
|   |       |-- HBar.jsx - 横向柱状排行组件,对应 S07。
|   |       |-- ImageHero.jsx - 图片主视觉页组件,对应 S22。
|   |       |-- index.jsx - Swiss 组件统一导出口,供 LAYOUT_OPTIONS 引用。
|   |       |-- KpiTower.jsx - KPI 塔组件,对应 S06。
|   |       |-- primitives.jsx - Swiss 组件共享基础件,包含 slide 外壳、画布卡、页眉、图标和 KPI 行。
|   |       |-- S01IndexCover.jsx - Index Cover 正文布局组件,对应 S01。
|   |       |-- S03SplitStatement.jsx - Split Statement 正文布局组件,对应 S03。
|   |       |-- S05ThreeLayers.jsx - Three Layers 正文布局组件,对应 S05。
|   |       |-- S08DuoCompare.jsx - Duo Compare 正文布局组件,对应 S08。
|   |       |-- S09DotMatrixStatement.jsx - Dot Matrix Statement 正文布局组件,对应 S09。
|   |       |-- S10SplitClosing.jsx - Split Closing 正文布局组件,对应 S10。
|   |       |-- S11HorizontalTimeline.jsx - Horizontal Timeline 正文布局组件,对应 S11。
|   |       |-- S12ManifestoBanner.jsx - Manifesto + Ink Banner 正文布局组件,对应 S12。
|   |       |-- S13ThreeForces.jsx - Three Forces 正文布局组件,对应 S13。
|   |       |-- S14LoopForm.jsx - Loop Form 正文布局组件,对应 S14。
|   |       |-- S15MatrixHeroStat.jsx - Matrix + Hero Stat 正文布局组件,对应 S15。
|   |       |-- S16MultiCardBrief.jsx - Multi-card Brief 正文布局组件,对应 S16。
|   |       |-- S17SystemDiagram.jsx - System Diagram 正文布局组件,对应 S17。
|   |       |-- S18WhyNow.jsx - Why Now 正文布局组件,对应 S18。
|   |       |-- S19FourCards.jsx - Four Cards 正文布局组件,对应 S19。
|   |       |-- S20StackedLedger.jsx - Stacked KPI Ledger 正文布局组件,对应 S20。
|   |       |-- S21TechSpec.jsx - Tech Spec Sheet 正文布局组件,对应 S21。
|   |       |-- SixCells.jsx - 六宫格组件,对应 S04。
|   |       `-- Timeline.jsx - 纵向时间线 + KPI 组件,对应 S02。
|   |-- options.jsx - 选项注册表,集中登记主题色、字体组合和页面版式。
|   `-- renderDeck.jsx - 核心渲染器,把 React slides 注入模板并替换主题/字体变量。
|-- .gitignore - 忽略本地依赖、生成产物和系统临时文件。
|-- AGENTS.md - 项目级 Agent 记忆,记录本仓库长期遵守的实现约束。
|-- package-lock.json - npm 依赖锁定文件。
|-- package.json - npm 脚本和 React/tsx 依赖声明。
|-- README.md - 项目入口说明,包含快速开始、当前选项和文档索引。
`-- SKILL.md - 给 Agent 使用的 skill 说明,定义 PPT 生成流程和约束。
```
