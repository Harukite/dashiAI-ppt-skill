# ADR

本文件由 `scripts/update-project-docs.mjs` 生成,记录当前项目已经采用的架构决策。

## ADR-001: 最终产物保持为静态 HTML

最终交付仍是 `index.html`、`assets/motion.min.js` 和图片资源。React 只作为生成层使用,不进入浏览器运行时。

## ADR-002: 可变部分使用登记选项多选一

`theme` 从 `THEME_OPTIONS` 选择,`fontSet` 从 `FONT_OPTIONS` 选择,每页通过 `slide(layoutKey, props)` 从 `LAYOUT_OPTIONS` 选择。Agent 不直接手写自由 HTML 页面。

## ADR-003: 模板负责浏览器运行时

`assets/template-swiss.html` 负责 CSS 视觉系统、背景、翻页、导航和动效入口。React 组件只生成注入到 `#deck` 内的 slide markup。

## ADR-004: 输出目录是生成物

`output/` 用于 demo、验证 deck 和截图产物,已加入 `.gitignore`,不作为源码提交。

## ADR-005: 提交前同步项目文档

`.githooks/pre-commit` 会运行 `scripts/update-project-docs.mjs`,并 stage `README.md`、`docs/ADR.md`、`docs/project-files.md`。

## ADR-006: Swiss 布局组件按文件拆分

每个 Swiss 页面布局组件独立放在 `src/components/swiss/*.jsx`,共享基础件放在 `src/components/swiss/primitives.jsx`,统一导出放在 `src/components/swiss/index.jsx`。`src/options.jsx` 只负责把 layout key 登记到组件。

## ADR-007: 原始 Swiss 正文布局使用 canonical key

原始 Swiss `S01` 到 `S22` 正文布局统一登记为 `s01` 到 `s22`。旧的语义 key 仅保留给已有示例兼容,新的正文页面优先使用 canonical key。

## ADR-008: 提交前刷新全布局总览

`.githooks/pre-commit` 会运行 `npm run showcase:update`,先确认 `examples/component-decks/all-layouts-showcase.jsx` 覆盖全部 canonical 布局,再重生成并校验 `output/all-components-showcase/ppt/index.html`。
