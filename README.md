# Guizang PPT Skill

一个用**登记选项 + React 组件生成层**生成静态 HTML 横向翻页 PPT 的本地 skill。

最终产物仍是普通静态文件:

```text
output/my-deck/ppt/
├── index.html
├── assets/motion.min.js
└── images/
```

浏览器直接打开 `index.html` 即可演示。React 不进入最终运行时。

## 核心思路

每个可变部分都是多选一:

- `theme`: 从主题色选项中选一个
- `fontSet`: 从字体组合中选一个
- 每一页: 从页面版式选项中选一个

选项集中登记在 [src/options.jsx](/Users/jadon7/Documents/SynologyDrive/code/项目研究/guizang-ppt-skill-main/src/options.jsx),页面组件在 [src/components/swiss/](/Users/jadon7/Documents/SynologyDrive/code/项目研究/guizang-ppt-skill-main/src/components/swiss/index.jsx)。

## 快速开始

```bash
npm install
npm run render:demo
npm run validate:swiss -- output/component-demo/ppt/index.html
```

渲染全部 `S01-S22` 布局总览:

```bash
npm run showcase:update
```

渲染指定 deck:

```bash
npm run render:deck -- examples/component-decks/ai-ops-review.jsx output/ai-ops/ppt/index.html
```

渲染内置三份不同主题示例:

```bash
npm run render:examples
```

## 示例 Deck

| 文件 | 内容主题 | 选项特点 |
|---|---|---|
| `examples/component-decks/ai-ops-review.jsx` | AI 运营系统季度复盘 | IKB + Inter + 时间线/KPI/排行 |
| `examples/component-decks/all-layouts-showcase.jsx` | Swiss S01-S22 布局总览 | 顺序展示全部 22 个正文布局 |
| `examples/component-decks/climate-field-report.jsx` | 城市微气候田野报告 | Green + Compact + 图片主视觉/六宫格/时间线 |
| `examples/component-decks/retail-launch-brief.jsx` | 零售新品上市简报 | Lemon + System + 排行/KPI/上市节奏 |
| `examples/component-decks/swiss-demo.jsx` | 组件选项机制演示 | 可用环境变量切换 theme/fontSet |

## 当前选项

主题色:

- `ikb`
- `lemon`
- `green`
- `orange`

字体组合:

- `inter`
- `system`
- `compact`

页面版式:

- `s01` 到 `s22`: 原始 Swiss 22 个正文布局
- `cover`: 特殊 ASCII 封面
- `closing`: 特殊 ASCII 收尾页
- `timeline`、`sixCells`、`kpiTower`、`hBar`、`imageHero`: 旧示例兼容 key,分别指向 `S02`、`S04`、`S06`、`S07`、`S22`

## 项目结构

```text
assets/
  template-swiss.html
  motion.min.js
src/
  options.jsx
  renderDeck.jsx
  components/swiss/
scripts/
  render-deck.jsx
  validate-swiss-deck.mjs
examples/component-decks/
references/
  component-workflow.md
```

## 验证方式

```bash
npm test
npm run render:examples
npm run validate:swiss -- output/examples/ai-ops-review/ppt/index.html
npm run validate:swiss -- output/examples/climate-field-report/ppt/index.html
npm run validate:swiss -- output/examples/retail-launch-brief/ppt/index.html
```

多个 subagent 做测试时,不要只换配色。每个测试 deck 应该换内容主题、风格要求和页面组合,再比较呈现结果。

<!-- project-docs:start -->
## 项目文档

以下文档由 `npm run docs:update` 同步,提交前也会由 `.githooks/pre-commit` 自动更新。

提交前 hook 还会运行 `npm run showcase:update`,确保 `all-layouts-showcase.jsx` 覆盖全部 `S01-S22`,并刷新 `output/all-components-showcase/ppt/index.html`。

- [ADR](docs/ADR.md): 当前架构决策记录
- [项目文件作用说明](docs/project-files.md): 当前 49 个源码文件的主要作用
<!-- project-docs:end -->
