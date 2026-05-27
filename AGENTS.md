# Project Memory

## Swiss 组件组织

- Swiss 页面布局组件必须各自独立:一个布局一个 JSX 文件,放在 `src/components/swiss/`。
- 共享基础件只放在 `src/components/swiss/primitives.jsx`,例如 `SwissSlide`、`CanvasCard`、`Chrome`、`Icon`、`MetricRow`。
- 新增布局时,先新增独立组件文件,再从 `src/components/swiss/index.jsx` 导出,最后登记到 `src/options.jsx` 的 `LAYOUT_OPTIONS`。
- 不要把多个页面布局重新合并到一个大组件文件里。
- 原始 Swiss 正文布局使用 `s01` 到 `s22` 作为 canonical key;旧语义 key 只用于示例兼容。
- 每次提交前必须刷新全布局总览:`npm run showcase:update` 会检查 `all-layouts-showcase.jsx` 覆盖全部 canonical 布局,并重生成当前 demo HTML。
