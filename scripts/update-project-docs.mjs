import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const descriptions = {
  '.githooks/pre-commit': '本地 Git pre-commit hook,提交前重生成 README、ADR 和文件作用说明并自动 stage。',
  '.gitignore': '忽略本地依赖、生成产物和系统临时文件。',
  'AGENTS.md': '项目级 Agent 记忆,记录本仓库长期遵守的实现约束。',
  'README.md': '项目入口说明,包含快速开始、当前选项和文档索引。',
  'SKILL.md': '给 Agent 使用的 skill 说明,定义 PPT 生成流程和约束。',
  'assets/motion.min.js': '浏览器端 Motion One 动效 runtime,由渲染器复制到最终产物。',
  'assets/template-swiss.html': '静态 PPT HTML 外壳模板,包含 CSS、背景、翻页、导航和动效入口。',
  'docs/ADR.md': '架构决策记录,描述当前生成链路和组件化边界。',
  'docs/project-files.md': '项目文件作用说明,由脚本根据当前文件列表生成。',
  'examples/component-decks/ai-ops-review.jsx': 'AI 运营复盘示例 deck,演示技术/运营复盘主题的页面组合。',
  'examples/component-decks/all-layouts-showcase.jsx': 'Swiss S01-S22 布局总览示例 deck,顺序渲染全部原始正文布局。',
  'examples/component-decks/climate-field-report.jsx': '城市微气候田野报告示例 deck,演示生态/田野主题的页面组合。',
  'examples/component-decks/retail-launch-brief.jsx': '零售新品上市简报示例 deck,演示消费/上市主题的页面组合。',
  'examples/component-decks/swiss-demo.jsx': '组件选项机制 demo deck,可用环境变量切换主题和字体。',
  'package-lock.json': 'npm 依赖锁定文件。',
  'package.json': 'npm 脚本和 React/tsx 依赖声明。',
  'references/component-workflow.md': '组件选项工作流参考,说明新增选项和 subagent 测试要求。',
  'scripts/render-deck.jsx': '渲染 CLI 入口,把 deck 配置文件输出成静态 HTML。',
  'scripts/update-project-docs.mjs': '文档同步脚本,更新 README、ADR 和项目文件作用说明。',
  'scripts/validate-layout-showcase.mjs': '布局总览覆盖校验器,确保 all-layouts-showcase 穷举所有 canonical S01-S22 布局。',
  'scripts/validate-swiss-deck.mjs': 'Swiss deck 静态校验器,检查合法 layout、图片槽位和禁用模式。',
  'src/components/swiss/Closing.jsx': '收尾页组件,对应 SWISS-CLOSING-ASCII。',
  'src/components/swiss/Cover.jsx': '封面组件,对应 SWISS-COVER-ASCII。',
  'src/components/swiss/HBar.jsx': '横向柱状排行组件,对应 S07。',
  'src/components/swiss/ImageHero.jsx': '图片主视觉页组件,对应 S22。',
  'src/components/swiss/KpiTower.jsx': 'KPI 塔组件,对应 S06。',
  'src/components/swiss/S01IndexCover.jsx': 'Index Cover 正文布局组件,对应 S01。',
  'src/components/swiss/S03SplitStatement.jsx': 'Split Statement 正文布局组件,对应 S03。',
  'src/components/swiss/S05ThreeLayers.jsx': 'Three Layers 正文布局组件,对应 S05。',
  'src/components/swiss/S08DuoCompare.jsx': 'Duo Compare 正文布局组件,对应 S08。',
  'src/components/swiss/S09DotMatrixStatement.jsx': 'Dot Matrix Statement 正文布局组件,对应 S09。',
  'src/components/swiss/S10SplitClosing.jsx': 'Split Closing 正文布局组件,对应 S10。',
  'src/components/swiss/S11HorizontalTimeline.jsx': 'Horizontal Timeline 正文布局组件,对应 S11。',
  'src/components/swiss/S12ManifestoBanner.jsx': 'Manifesto + Ink Banner 正文布局组件,对应 S12。',
  'src/components/swiss/S13ThreeForces.jsx': 'Three Forces 正文布局组件,对应 S13。',
  'src/components/swiss/S14LoopForm.jsx': 'Loop Form 正文布局组件,对应 S14。',
  'src/components/swiss/S15MatrixHeroStat.jsx': 'Matrix + Hero Stat 正文布局组件,对应 S15。',
  'src/components/swiss/S16MultiCardBrief.jsx': 'Multi-card Brief 正文布局组件,对应 S16。',
  'src/components/swiss/S17SystemDiagram.jsx': 'System Diagram 正文布局组件,对应 S17。',
  'src/components/swiss/S18WhyNow.jsx': 'Why Now 正文布局组件,对应 S18。',
  'src/components/swiss/S19FourCards.jsx': 'Four Cards 正文布局组件,对应 S19。',
  'src/components/swiss/S20StackedLedger.jsx': 'Stacked KPI Ledger 正文布局组件,对应 S20。',
  'src/components/swiss/S21TechSpec.jsx': 'Tech Spec Sheet 正文布局组件,对应 S21。',
  'src/components/swiss/SixCells.jsx': '六宫格组件,对应 S04。',
  'src/components/swiss/Timeline.jsx': '纵向时间线 + KPI 组件,对应 S02。',
  'src/components/swiss/index.jsx': 'Swiss 组件统一导出口,供 LAYOUT_OPTIONS 引用。',
  'src/components/swiss/primitives.jsx': 'Swiss 组件共享基础件,包含 slide 外壳、画布卡、页眉、图标和 KPI 行。',
  'src/options.jsx': '选项注册表,集中登记主题色、字体组合和页面版式。',
  'src/renderDeck.jsx': '核心渲染器,把 React slides 注入模板并替换主题/字体变量。',
};

const generatedFiles = ['docs/ADR.md', 'docs/project-files.md'];

const files = [...new Set([
  ...execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
  cwd: ROOT,
  encoding: 'utf8',
  })
  .split('\n')
  .map((file) => file.trim())
  .filter(Boolean),
  ...generatedFiles,
])]
  .filter((file) => file !== '.DS_Store')
  .filter((file) => fs.existsSync(path.join(ROOT, file)))
  .sort();

writeFile('docs/project-files.md', renderProjectFiles(files));
writeFile('docs/ADR.md', renderAdr());
updateReadme(files);

function renderProjectFiles(fileList) {
  const tree = renderTree(fileList);
  return `# 项目文件作用说明

本文件由 \`scripts/update-project-docs.mjs\` 生成,用于快速理解当前项目工作树下每个源码文件的主要作用。\`output/\` 是生成产物目录,不纳入源码文件清单。

\`\`\`text
.
${tree}
\`\`\`
`;
}

function renderAdr() {
  return `# ADR

本文件由 \`scripts/update-project-docs.mjs\` 生成,记录当前项目已经采用的架构决策。

## ADR-001: 最终产物保持为静态 HTML

最终交付仍是 \`index.html\`、\`assets/motion.min.js\` 和图片资源。React 只作为生成层使用,不进入浏览器运行时。

## ADR-002: 可变部分使用登记选项多选一

\`theme\` 从 \`THEME_OPTIONS\` 选择,\`fontSet\` 从 \`FONT_OPTIONS\` 选择,每页通过 \`slide(layoutKey, props)\` 从 \`LAYOUT_OPTIONS\` 选择。Agent 不直接手写自由 HTML 页面。

## ADR-003: 模板负责浏览器运行时

\`assets/template-swiss.html\` 负责 CSS 视觉系统、背景、翻页、导航和动效入口。React 组件只生成注入到 \`#deck\` 内的 slide markup。

## ADR-004: 输出目录是生成物

\`output/\` 用于 demo、验证 deck 和截图产物,已加入 \`.gitignore\`,不作为源码提交。

## ADR-005: 提交前同步项目文档

\`.githooks/pre-commit\` 会运行 \`scripts/update-project-docs.mjs\`,并 stage \`README.md\`、\`docs/ADR.md\`、\`docs/project-files.md\`。

## ADR-006: Swiss 布局组件按文件拆分

每个 Swiss 页面布局组件独立放在 \`src/components/swiss/*.jsx\`,共享基础件放在 \`src/components/swiss/primitives.jsx\`,统一导出放在 \`src/components/swiss/index.jsx\`。\`src/options.jsx\` 只负责把 layout key 登记到组件。

## ADR-007: 原始 Swiss 正文布局使用 canonical key

原始 Swiss \`S01\` 到 \`S22\` 正文布局统一登记为 \`s01\` 到 \`s22\`。旧的语义 key 仅保留给已有示例兼容,新的正文页面优先使用 canonical key。

## ADR-008: 提交前刷新全布局总览

\`.githooks/pre-commit\` 会运行 \`npm run showcase:update\`,先确认 \`examples/component-decks/all-layouts-showcase.jsx\` 覆盖全部 canonical 布局,再重生成并校验 \`output/all-components-showcase/ppt/index.html\`。
`;
}

function updateReadme(fileList) {
  const readmePath = path.join(ROOT, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');
  const section = renderReadmeSection(fileList);
  fs.writeFileSync(readmePath, replaceSection(readme, 'project-docs', section));
}

function renderReadmeSection(fileList) {
  const sourceCount = fileList.length;
  return `## 项目文档

以下文档由 \`npm run docs:update\` 同步,提交前也会由 \`.githooks/pre-commit\` 自动更新。

提交前 hook 还会运行 \`npm run showcase:update\`,确保 \`all-layouts-showcase.jsx\` 覆盖全部 \`S01-S22\`,并刷新 \`output/all-components-showcase/ppt/index.html\`。

- [ADR](docs/ADR.md): 当前架构决策记录
- [项目文件作用说明](docs/project-files.md): 当前 ${sourceCount} 个源码文件的主要作用
`;
}

function replaceSection(content, name, body) {
  const start = `<!-- ${name}:start -->`;
  const end = `<!-- ${name}:end -->`;
  const block = `${start}\n${body.trim()}\n${end}`;
  const pattern = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`);

  if (pattern.test(content)) {
    return content.replace(pattern, block);
  }

  return `${content.trim()}\n\n${block}\n`;
}

function describe(file) {
  if (descriptions[file]) return descriptions[file];
  if (file.startsWith('assets/')) return '静态模板或浏览器运行时资源。';
  if (file.startsWith('docs/')) return '项目文档。';
  if (file.startsWith('examples/component-decks/')) return '组件化 deck 示例配置。';
  if (file.startsWith('references/')) return 'Agent 或开发者参考资料。';
  if (file.startsWith('scripts/')) return '本地命令脚本。';
  if (file.startsWith('src/')) return 'React 生成层源码。';
  return '项目源码或配置文件。';
}

function renderTree(fileList) {
  const root = { children: new Map() };

  for (const file of fileList) {
    let cursor = root;
    const parts = file.split('/');

    parts.forEach((part, index) => {
      if (!cursor.children.has(part)) {
        cursor.children.set(part, {
          name: part,
          path: parts.slice(0, index + 1).join('/'),
          children: new Map(),
          isFile: index === parts.length - 1,
        });
      }
      cursor = cursor.children.get(part);
    });
  }

  return renderTreeNode(root).join('\n');
}

function renderTreeNode(node, prefix = '') {
  const entries = [...node.children.values()].sort((a, b) => {
    if (a.isFile !== b.isFile) return a.isFile ? 1 : -1;
    return a.name.localeCompare(b.name);
  });

  return entries.flatMap((entry, index) => {
    const isLast = index === entries.length - 1;
    const marker = isLast ? '`-- ' : '|-- ';
    const nextPrefix = `${prefix}${isLast ? '    ' : '|   '}`;

    if (entry.isFile) {
      return [`${prefix}${marker}${entry.name} - ${describe(entry.path)}`];
    }

    return [
      `${prefix}${marker}${entry.name}/`,
      ...renderTreeNode(entry, nextPrefix),
    ];
  });
}

function writeFile(relativePath, content) {
  const filePath = path.join(ROOT, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
