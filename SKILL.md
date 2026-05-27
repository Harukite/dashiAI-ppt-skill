---
name: guizang-ppt-skill
description: 通过登记选项生成静态 HTML 横向翻页 PPT，使用 React 组件生成层和 Swiss 模板运行时。
---

# Guizang PPT Skill

生成一份**静态 HTML 横向翻页 PPT**。React 只作为生成层使用;最终交付仍是 `index.html` + `assets/motion.min.js`,浏览器直接打开即可。

## 核心模型

所有可变部分都必须从登记选项里**多选一**:

| 部分 | 字段 | 选项来源 | 规则 |
|---|---|---|---|
| 主题色 | `theme` | `THEME_OPTIONS` | 一个 deck 只能选一个 |
| 字体组合 | `fontSet` | `FONT_OPTIONS` | 一个 deck 只能选一个 |
| 页面版式 | `slide(layoutKey, props)` | `LAYOUT_OPTIONS` | 每一页从版式列表 n 选 1 |
| 动效 | 版式组件内部声明 | `src/components/swiss/*.jsx` | 不在 deck 配置里自造运行时 |

选项登记在 [src/options.jsx](/Users/jadon7/Documents/SynologyDrive/code/项目研究/guizang-ppt-skill-main/src/options.jsx)。不要临时发明 theme/font/layout key;需要新增能力时先登记选项,再使用。

## 何时使用

用于生成演讲、汇报、发布会、研究报告、内部复盘等视觉化 deck。特别适合:

- 需要统一视觉系统的多页汇报
- 需要批量生成不同主题内容的 deck
- 需要比较不同内容主题、字体组合、版式组合的呈现结果
- 需要保持最终产物轻量、离线、可直接打开

不适合:

- 大段表格和复杂可编辑图表
- 需要多人在 PPT 软件里协作编辑
- 需要任意自由排版且不受组件约束的页面

## 工作流

### 1. 明确内容主题

先把用户需求整理成:

- deck 标题
- 受众和场景
- 5-8 页页面节奏
- 每页的信息角色:封面、时间线、六宫格、KPI、排行、图片主视觉、收尾等
- 是否需要真实图片;没有图片时可先使用生成器内置的 `placeholder-21x9.svg`

### 2. 选择选项

从登记表中选择:

```jsx
export default {
  style: 'swiss',
  theme: 'ikb',
  fontSet: 'inter',
  title: 'Deck 标题',
  slides: [
    slide('cover', {...}),
    slide('s02', {...}),
    slide('closing', {...}),
  ],
};
```

当前主题选项:

| key | 用途 |
|---|---|
| `ikb` | 默认,科技、产品、管理汇报 |
| `lemon` | 活力、消费、零售、年轻主题 |
| `green` | 生态、未来、城市、可持续 |
| `orange` | 工业、警示、风险、决策节点 |

当前字体组合:

| key | 用途 |
|---|---|
| `inter` | 默认,现代科技和产品汇报 |
| `system` | 系统字体优先,适合跨机器稳定展示 |
| `compact` | 更紧凑,适合信息密度稍高的报告 |

当前页面版式:

| key | data-layout | 用途 |
|---|---|---|
| `s01` | `S01` | Index Cover |
| `s02` | `S02` | Vertical Timeline + KPI |
| `s03` | `S03` | Split Statement |
| `s04` | `S04` | Six Cells |
| `s05` | `S05` | Three Layers |
| `s06` | `S06` | KPI Tower |
| `s07` | `S07` | H-Bar Chart |
| `s08` | `S08` | Duo Compare |
| `s09` | `S09` | Dot Matrix Statement |
| `s10` | `S10` | Split Closing |
| `s11` | `S11` | Horizontal Timeline |
| `s12` | `S12` | Manifesto + Ink Banner |
| `s13` | `S13` | Three Forces |
| `s14` | `S14` | Loop Form |
| `s15` | `S15` | Matrix + Hero Stat |
| `s16` | `S16` | Multi-card Brief |
| `s17` | `S17` | System Diagram |
| `s18` | `S18` | Why Now |
| `s19` | `S19` | Four Cards |
| `s20` | `S20` | Stacked KPI Ledger |
| `s21` | `S21` | Tech Spec Sheet |
| `s22` | `S22` | Image Hero |
| `cover` | `SWISS-COVER-ASCII` | 封面 |
| `timeline` | `S02` | 时间线 + KPI |
| `sixCells` | `S04` | 六宫格概念/能力定义 |
| `kpiTower` | `S06` | KPI 塔 |
| `hBar` | `S07` | 横向柱状排行 |
| `imageHero` | `S22` | 21:9 图片主视觉 |
| `closing` | `SWISS-CLOSING-ASCII` | 收尾页 |

`s01`-`s22` 是原始 Swiss 正文布局的 canonical key;`cover`、`closing` 和旧的语义 key 保留给示例兼容。

### 3. 复制示例并改内容

从 `examples/component-decks/` 复制最接近的示例:

- `ai-ops-review.jsx`
- `all-layouts-showcase.jsx`
- `climate-field-report.jsx`
- `retail-launch-brief.jsx`
- `swiss-demo.jsx`

只改配置和 props。不要在 deck 配置里写浏览器运行时逻辑,不要手写 `<section>`。

### 4. 渲染

```bash
npm install
npm run render:deck -- examples/component-decks/ai-ops-review.jsx output/my-deck/ppt/index.html
```

渲染器会:

- 读取 `assets/template-swiss.html`
- 注入 React 静态 HTML
- 替换主题和字体 CSS 变量
- 复制 `assets/motion.min.js`
- 创建 `images/placeholder-21x9.svg`

### 5. 校验

```bash
npm run validate:swiss -- output/my-deck/ppt/index.html
npm run showcase:update
```

必须通过:

- 每页有合法 `data-layout`
- S22 图片有 `data-image-slot="s22-hero-21x9"`
- 不使用未登记实验版式
- SVG 不承载文字标签
- 顶部标题不做瑞士风禁用的居中 hack

提交前 hook 会运行 `npm run showcase:update`,确保 `examples/component-decks/all-layouts-showcase.jsx` 穷举全部 canonical `s01`-`s22` 布局,并刷新当前总览 demo HTML。

### 6. 视觉检查

打开生成的 `index.html`,至少检查:

- 封面主题色和 `accent-on` 是否可读
- 中文标题是否溢出
- KPI、卡片、图片槽位是否避开底部分页
- 动效完成后内容是否完整可见
- `B` 低功耗模式是否能切到静态

## Subagent 验证要求

如果要开多个 subagent 做验证,不能让它们只跑同一内容的不同配色。每个 subagent 必须至少改变三项:

- 内容主题不同,例如 AI 运营复盘 / 城市生态报告 / 零售上市简报
- 风格要求不同,例如科技冷静 / 生态田野 / 消费活力 / 工业警示
- 页面组合不同,例如时间线优先 / 图片页优先 / KPI+排行优先

允许主题色不同,但主题色只能作为结果差异的一部分,不能作为唯一差异。

## 资源文件

```text
guizang-ppt-skill/
├── SKILL.md
├── README.md
├── package.json
├── assets/
│   ├── template-swiss.html
│   └── motion.min.js
├── src/
│   ├── options.jsx
│   ├── renderDeck.jsx
│   └── components/swiss/
├── scripts/
│   ├── render-deck.jsx
│   └── validate-swiss-deck.mjs
├── examples/
│   └── component-decks/
└── references/
    └── component-workflow.md
```

## 修改原则

- 新主题色:加到 `THEME_OPTIONS`,不要直接改模板变量。
- 新字体组合:加到 `FONT_OPTIONS`,不要在单页写散落字体。
- 新页面类型:按一个布局一个文件放到 `src/components/swiss/`,共享基础件只放 `primitives.jsx`,再从 `index.jsx` 导出并登记到 `LAYOUT_OPTIONS`。
- 新校验规则:加到 `scripts/validate-swiss-deck.mjs`。
- 旧的手写模板骨架和截图背景资源已移除;不要重新引入另一套工作流。
