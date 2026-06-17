#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_ROOT = process.env.DASHI_PPT_SKILL_ROOT || path.join(os.homedir(), '.agents/skills/dashi-ppt-skill');

const EXPECTED_THEMES = {
  theme01: {
    displayName: '轻拟态风',
    scenario: '产品介绍、企业汇报、方案说明、轻量级发布',
    audience: '创业团队、产品经理、销售顾问、企业内部汇报者',
  },
  theme02: {
    displayName: '炫光紫绿风',
    scenario: '科技发布会、AI/自动驾驶/机器人主题、增长故事、创新项目展示',
    audience: '科技公司创始人、技术负责人、品牌市场团队、投资路演团队',
  },
  theme03: {
    displayName: '深浅代码风',
    scenario: '技术方案、开发者大会、系统架构、AI 工程实践',
    audience: '工程师、技术管理者、架构师、开发者社区',
  },
  theme04: {
    displayName: '玻璃糖果风',
    scenario: '年轻化品牌、消费产品、创意提案、社媒感内容',
    audience: '品牌团队、设计师、内容创作者、消费品团队',
  },
  theme05: {
    displayName: '色谱图表风',
    scenario: '数据报告、市场分析、KPI 复盘、行业研究',
    audience: '数据分析师、咨询顾问、研究员、业务负责人',
  },
  theme06: {
    displayName: '深色图谱风',
    scenario: '高密度数据展示、战略分析、科技/金融/产业报告',
    audience: '战略团队、投资人、产业研究团队、高管汇报者',
  },
  theme07: {
    displayName: '冷白调研风',
    scenario: '调研报告、白皮书、竞品分析、学术/政策型表达',
    audience: '研究机构、咨询团队、政府/高校/智库、B2B 团队',
  },
  theme08: {
    displayName: '黑金实验风',
    scenario: '高端发布、品牌提案、实验性概念、奢华科技叙事',
    audience: '高端品牌、创意总监、科技品牌、发布会策划团队',
  },
  theme09: {
    displayName: '深蓝杂志风',
    scenario: '品牌故事、人物访谈、企业形象册、深度专题',
    audience: '公关团队、媒体编辑、创始人、企业品牌部',
  },
  theme10: {
    displayName: '金色指数风',
    scenario: '金融数据、投资报告、商业指数、年度榜单',
    audience: '投资机构、金融分析师、咨询公司、商业媒体',
  },
  theme11: {
    displayName: '高能增长风',
    scenario: '增长复盘、商业计划、融资路演、市场扩张方案',
    audience: '创业者、增长团队、销售团队、VC/PE 路演团队',
  },
  theme12: {
    displayName: '声波霓虹风',
    scenario: '音乐娱乐、潮流活动、直播内容、年轻化发布',
    audience: '娱乐品牌、活动策划、内容团队、潮流消费品牌',
  },
};

const OLD_VISIBLE_NAMES = [
  '01-轻拟态质感',
  '02-炫光紫绿',
  '03-深浅代码风',
  '04-玻璃糖果',
  '05-PULSE 色谱图表',
  '06-深色数据图谱',
  '07-冷白调研图谱',
  '08-黑金实验质感',
  '09-深蓝杂志',
  '10-金色指数图表',
  '11-高能增长图谱',
  '12-声波霓虹',
];

const failures = [];

validateGeneratedMetadata();
validateLayoutQuery();
validateSkillReferences();
validateUiPreviewSources();

if (failures.length) {
  console.error(`Theme display name validation failed (${failures.length}):`);
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}

console.log('Theme display name validation passed.');

function validateGeneratedMetadata() {
  const file = path.join(ROOT, 'src/components/themes/generated-metadata.js');
  const source = fs.readFileSync(file, 'utf8');
  const packs = parseExportedJson(source, 'GENERATED_THEME_PACKS');
  const pages = parseExportedJson(source, 'GENERATED_THEME_PAGES');
  const expectedKeys = Object.keys(EXPECTED_THEMES);
  const packByKey = new Map(packs.map((pack) => [pack.key, pack]));

  if (packs.length !== expectedKeys.length) {
    fail(`${relative(file)} must declare ${expectedKeys.length} theme packs, found ${packs.length}.`);
  }

  for (const [key, expected] of Object.entries(EXPECTED_THEMES)) {
    const pack = packByKey.get(key);
    if (!pack) {
      fail(`${relative(file)} is missing ${key}.`);
      continue;
    }
    for (const field of ['displayName', 'label', 'name']) {
      if (pack[field] !== expected.displayName) {
        fail(`${key}.${field} must be "${expected.displayName}", found ${JSON.stringify(pack[field])}.`);
      }
    }
    if (pack.scenario !== expected.scenario) {
      fail(`${key}.scenario must be "${expected.scenario}".`);
    }
    if (pack.audience !== expected.audience) {
      fail(`${key}.audience must be "${expected.audience}".`);
    }
    for (const oldName of OLD_VISIBLE_NAMES) {
      if ([pack.displayName, pack.label, pack.name].includes(oldName)) {
        fail(`${key} still exposes old visible theme name "${oldName}".`);
      }
    }
  }

  const extraKeys = packs.map((pack) => pack.key).filter((key) => !EXPECTED_THEMES[key]);
  if (extraKeys.length) {
    fail(`Generated metadata contains unexpected theme pack keys: ${extraKeys.join(', ')}.`);
  }

  for (const page of pages) {
    if (!/^theme\d{2}_page\d{3}$/.test(page.key || '')) {
      fail(`Layout key must stay themeXX_pageYYY, found ${JSON.stringify(page.key)}.`);
    }
    if (!EXPECTED_THEMES[page.themeKey]) {
      fail(`${page.key} uses unexpected themeKey ${JSON.stringify(page.themeKey)}.`);
    } else if (!String(page.key).startsWith(`${page.themeKey}_page`)) {
      fail(`${page.key} does not preserve its themeKey prefix ${page.themeKey}.`);
    }
  }
}

function validateLayoutQuery() {
  for (const [key, expected] of Object.entries(EXPECTED_THEMES)) {
    const output = execFileSync(process.execPath, ['scripts/layout-query.mjs', '--theme', key, '--limit', '1'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output);
    if (parsed.theme !== key) fail(`layout-query theme echo changed for ${key}: ${JSON.stringify(parsed.theme)}.`);
    if (parsed.themeDisplayName !== expected.displayName) {
      fail(`layout-query top-level themeDisplayName for ${key} must be "${expected.displayName}".`);
    }
    if (parsed.themeScenario !== expected.scenario) {
      fail(`layout-query top-level themeScenario for ${key} must be "${expected.scenario}".`);
    }
    if (parsed.themeAudience !== expected.audience) {
      fail(`layout-query top-level themeAudience for ${key} must be "${expected.audience}".`);
    }
    const firstLayout = parsed.layouts?.[0];
    if (!firstLayout) {
      fail(`layout-query returned no layouts for ${key}.`);
      continue;
    }
    if (firstLayout.layout && !firstLayout.layout.startsWith(`${key}_page`)) {
      fail(`layout-query changed internal layout key shape for ${key}: ${firstLayout.layout}.`);
    }
    if (firstLayout.themeDisplayName !== expected.displayName) {
      fail(`layout-query layout row for ${key} must include themeDisplayName "${expected.displayName}".`);
    }
  }
}

function validateSkillReferences() {
  const rootSkill = path.join(ROOT, 'SKILL.md');
  const installedSkill = path.join(SKILL_ROOT, 'SKILL.md');
  const docs = [
    { file: rootSkill, requireScenario: false },
    { file: installedSkill, requireScenario: false },
    { file: path.join(SKILL_ROOT, 'README.md'), requireScenario: true },
    { file: path.join(SKILL_ROOT, 'references/options.md'), requireScenario: true },
    { file: path.join(SKILL_ROOT, 'references/layout-pool.md'), requireScenario: true },
  ];

  for (const doc of docs) {
    if (!fs.existsSync(doc.file)) {
      fail(`${relative(doc.file)} is missing; run npm run skill:sync after changing skill references.`);
      continue;
    }
    const text = fs.readFileSync(doc.file, 'utf8');
    for (const [key, expected] of Object.entries(EXPECTED_THEMES)) {
      if (!text.includes(expected.displayName)) {
        fail(`${relative(doc.file)} does not include ${key} display name "${expected.displayName}".`);
      }
      if (doc.requireScenario && !text.includes(expected.scenario)) {
        fail(`${relative(doc.file)} does not include ${key} scenario "${expected.scenario}".`);
      }
      if (doc.requireScenario && !text.includes(expected.audience)) {
        fail(`${relative(doc.file)} does not include ${key} audience "${expected.audience}".`);
      }
    }
    for (const oldName of OLD_VISIBLE_NAMES) {
      if (text.includes(oldName)) {
        fail(`${relative(doc.file)} still includes old visible theme name "${oldName}".`);
      }
    }
  }
}

function validateUiPreviewSources() {
  const themeIndex = fs.readFileSync(path.join(ROOT, 'src/components/themes/index.jsx'), 'utf8');
  const viewModel = fs.readFileSync(path.join(ROOT, 'src/view-model/index.jsx'), 'utf8');
  const template = fs.readFileSync(path.join(ROOT, 'assets/template-swiss.html'), 'utf8');

  for (const snippet of ['label: theme.label', 'displayName: theme.displayName', 'scenario: theme.scenario', 'audience: theme.audience']) {
    if (!themeIndex.includes(snippet)) {
      fail(`THEME_PACK_OPTIONS must pass through ${snippet}.`);
    }
  }

  for (const snippet of ['displayName: option.displayName', 'scenario: option.scenario', 'audience: option.audience']) {
    if (!viewModel.includes(snippet)) {
      fail(`Serialized preview theme options must pass through ${snippet}.`);
    }
  }

  if (!/optionEl\.textContent\s*=\s*option\.label\s*\|\|\s*option\.displayName\s*\|\|\s*key/.test(template)) {
    fail('Preview theme selector must render the metadata label/displayName, not only the internal key.');
  }
}

function parseExportedJson(source, exportName) {
  const match = source.match(new RegExp(`export const ${exportName} = ([\\s\\S]*?);\\n`));
  if (!match) throw new Error(`Missing ${exportName}.`);
  return JSON.parse(match[1]);
}

function fail(message) {
  failures.push(message);
}

function relative(file) {
  return file.startsWith(ROOT) ? path.relative(ROOT, file) : file;
}
