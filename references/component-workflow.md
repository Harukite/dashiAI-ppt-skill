# 组件选项工作流

本项目采用选项注册表生成 PPT。目标是让 Agent 在明确边界内组合,而不是手写长 HTML。

## 注册表

token 选项在 `src/tokens/`,页面版式登记在 `src/options.jsx`:

- `THEME_OPTIONS`: deck 级主题色,一个 deck 只选一个
- `FONT_OPTIONS`: deck 级字体组合,一个 deck 只选一个
- `LAYOUT_OPTIONS`: 页级版式,每页从中选一个
- `TYPE_SCALE_OPTIONS`、`SPACING_OPTIONS`: 组合层 token,用于后续组件化扩展

## Deck 配置

```jsx
import React from 'react';
import { slide } from '../../src/options.jsx';

export default {
  style: 'swiss',
  theme: 'ikb',
  fontSet: 'inter',
  title: 'Deck 标题',
  slides: [
    slide('cover', {
      title: '封面标题',
      kicker: 'SECTION LABEL',
      lead: '一段副标题。',
    }),
    slide('s02', {
      page: '02 / 05',
      title: '时间线标题',
      kicker: 'FLOW',
      nodes: [],
      metrics: [],
    }),
  ],
};
```

## 生成命令

```bash
npm run render:deck -- examples/component-decks/ai-ops-review.jsx output/ai-ops/ppt/index.html
npm run validate:swiss -- output/ai-ops/ppt/index.html
npm run showcase:update
```

## 新增选项

新增主题:

1. 在 `src/tokens/themes.js` 的 `THEME_OPTIONS` 加 key。
2. 写完整 CSS 变量,尤其是 `--surface-*`、`--inverse-*` 和 `--focus-*`。
3. 用至少一份示例 deck 验证可读性。

新增字体组合:

1. 在 `src/tokens/fonts.js` 的 `FONT_OPTIONS` 加 key。
2. 同时提供 `--sans`、`--sans-zh`、`--mono`。
3. 检查中文标题和数字页。

新增版式:

1. 按一个布局一个文件在对应组件目录写组件。
2. 组件输出合法 `data-layout`。
3. 从对应目录的 `index.jsx` 导出。
4. 在 `LAYOUT_OPTIONS` 登记 key。
5. 必要时更新 `scripts/validate-swiss-deck.mjs`。

新增基础组件:

1. 按职责放入 `src/components/shell/`、`text/`、`media/`、`metrics/`、`charts/`、`timelines/`、`cards/`、`decorations/` 或 `diagrams/`。
2. 从该目录 `index.jsx` 导出。
3. 布局 preset 通过对应目录的 `primitives.jsx` 或直接 import 复用,不要复制一份同类实现。

原始电子杂志布局使用 `a01` 到 `a10` 作为 key,输出 `A01` 到 `A10`。

原始 Swiss 正文布局使用 `s01` 到 `s22` 作为 canonical key。旧示例里的 `timeline`、`sixCells`、`kpiTower`、`hBar`、`imageHero` 只是兼容别名。

Style B / Swiss 还保留原项目登记扩展 `s08Map`:它仍使用 `data-layout="S08"`,用于地点、路线、人物住所、城市关系等地图页。新增 Style B 能力前先读 `themes-swiss.md`、`swiss-layout-lock.md`、`layouts-swiss.md`;涉及图片或截图时读 `image-prompts.md` 和 `screenshot-framing.md`。

## Subagent 测试

测试不能只换颜色。每个 subagent 需要生成不同内容主题和页面组合:

- AI/技术复盘:偏 `timeline`、`kpiTower`、`hBar`
- 城市/生态报告:偏 `imageHero`、`sixCells`、`timeline`
- 零售/消费简报:偏 `hBar`、`kpiTower`、`imageHero`
- 全量布局回归:运行 `npm run showcase:update`,检查 `output/all-components-showcase/ppt/index.html` 的 A01-A10、22 个 canonical Swiss 布局和 Style B 登记扩展

比较结果时看:

- 内容是否匹配所选版式
- 主题色是否服务内容语气
- 字体组合是否影响密度和可读性
- 页面组合是否有节奏,而不是只是换色
