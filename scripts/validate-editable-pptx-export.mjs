#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'assets/template-swiss.html');
const OUT_DIR = path.resolve(process.env.EDITABLE_PPTX_VALIDATION_OUT_DIR || path.join(ROOT, 'output/editable-pptx-validation'));
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXPECTED_SLIDES = 6;
const THEME_FILTER_EXPECTED_SLIDES = 2;
const VISUAL_RMSE_LIMIT = 0.24;
const VISUAL_EDGE_RMSE_LIMIT = 0.245;
const VISUAL_MAE_LIMIT = 0.11;
const DEFAULT_VISUAL_SAMPLE_COUNT = 6;
const MATRIX_THEME_PACKS = [
  'theme03',
  ...Array.from({ length: 12 }, (_, index) => `theme${String(index + 1).padStart(2, '0')}`).filter(theme => theme !== 'theme03'),
];
const FALLBACK_TEXT_RISK_THEME_PACKS = MATRIX_THEME_PACKS;
const EMU_PER_IN = 914400;
const PPT_W = 16;
const PPT_H = 9;
const SAMPLE_TEXT_LAYOUT_ANCHORS = new Map([
  [16, [
    { text: '43.3%', align: 'r', maxWidth: 1.2 },
    { text: '25.3%', align: 'r', maxWidth: 1.2 },
    { text: '16.3%', align: 'r', maxWidth: 1.2 },
    { text: '10.0%', align: 'r', maxWidth: 1.2 },
    { text: '5.1%', align: 'r', maxWidth: 1.2 },
    { text: '420', align: 'r', maxWidth: 0.8 },
    { text: '245', align: 'r', maxWidth: 0.8 },
    { text: '158', align: 'r', maxWidth: 0.8 },
    { text: '97', align: 'r', maxWidth: 0.6 },
    { text: '50', align: 'r', maxWidth: 0.6 },
  ]],
  [18, [
    { text: '科技巨头', align: 'r', maxWidth: 1.6 },
    { text: '风险投资', align: 'r', maxWidth: 1.6 },
    { text: '主权 / 私募', align: 'r', maxWidth: 2.0 },
    { text: '企业风投', align: 'r', maxWidth: 1.6 },
    { text: 'STRATEGIC', align: 'r', maxWidth: 1.4 },
    { text: 'VC', align: 'r', maxWidth: 0.6 },
    { text: 'SOVEREIGN · PE', align: 'r', maxWidth: 1.8 },
    { text: 'CVC', align: 'r', maxWidth: 0.8 },
  ]],
]);
const SAMPLE_HIGHLIGHT_ANCHORS = new Map([
  ['theme02:1', [
    { id: 'ai-company-research-report', text: 'AI 公司调研报告' },
    { id: '970', text: '970' },
  ]],
]);
const SAMPLE_SLOT_ANCHORS = new Map([
  ['theme02:1', [
    { id: 'cover-image-slot', selector: '.gxn-slot', text: '拖入配图 · IMAGE' },
  ]],
]);
const EDITED_TEXT = 'JAD-64 editable text sentinel';
const INITIAL_IMAGE_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#e11d48"/><text x="4" y="16" font-size="8" fill="#ffffff">old</text></svg>');
const REPLACEMENT_IMAGE_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#2563eb"/><text x="4" y="16" font-size="8" fill="#ffffff">new</text></svg>');
const INITIAL_IMAGE_HASH = hashBuffer(INITIAL_IMAGE_BYTES);
const REPLACEMENT_IMAGE_HASH = hashBuffer(REPLACEMENT_IMAGE_BYTES);
const INITIAL_IMAGE = `data:image/svg+xml;base64,${INITIAL_IMAGE_BYTES.toString('base64')}`;
const REPLACEMENT_IMAGE = `data:image/svg+xml;base64,${REPLACEMENT_IMAGE_BYTES.toString('base64')}`;
const PPTX_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const args = new Set(process.argv.slice(2));
const legacyRed = args.has('--legacy-red');
const uiExport = args.has('--ui-export');
const uiExportProgress = args.has('--ui-export-progress');
const uiExportCodexBrowserGuard = args.has('--ui-export-codex-browser-guard');
const uiVisualFidelity = args.has('--ui-visual-fidelity');
const uiVisualMatrix = args.has('--ui-visual-matrix');
const fallbackTextRisk = args.has('--fallback-text-risk');
const fallbackTextRiskMatrix = args.has('--fallback-text-risk-matrix');
const theme10UserRegressions = args.has('--theme10-user-regressions');
const jad64FollowupRegressions = args.has('--jad64-followup-regressions');
const jad64AcceptanceRegressions = args.has('--jad64-acceptance-regressions');
const jad64RootCauseRegressions = args.has('--jad64-root-cause-regressions');
const jad64Random30Regressions = args.has('--jad64-random30-regressions');
const jad64CutoutRegressions = args.has('--jad64-cutout-regressions');
const jad64MaterialLayerRegressions = args.has('--jad64-material-layer-regressions');
const cliUrl = getArg('--url');
const cliThemePack = getArg('--theme-pack');
const cliSelectionSummary = getArg('--selection-summary') || '/Users/jadon7/Downloads/theme-30-random-pptx-export-20260618T033406/selection-summary.json';
const cliSamplesPerTheme = Math.max(DEFAULT_VISUAL_SAMPLE_COUNT, Number(getArg('--samples-per-theme') || DEFAULT_VISUAL_SAMPLE_COUNT));

if (!existsSync(CHROME_PATH)) {
  throw new Error(`Chrome executable not found: ${CHROME_PATH}
Set CHROME_PATH to a local Chrome/Chromium executable and rerun the validation.`);
}

mkdirSync(OUT_DIR, { recursive: true });

if (legacyRed) {
  await runLegacyRedValidation();
} else if (uiExport) {
  await runUiExportValidation();
} else if (uiExportProgress) {
  await runUiExportProgressValidation();
} else if (uiExportCodexBrowserGuard) {
  await runUiExportCodexBrowserGuardValidation();
} else if (uiVisualMatrix) {
  await runUiVisualMatrixValidation();
} else if (uiVisualFidelity) {
  await runUiVisualFidelityValidation();
} else if (fallbackTextRiskMatrix) {
  await runFallbackTextRiskMatrixValidation();
} else if (fallbackTextRisk) {
  await runFallbackTextRiskValidation();
} else if (jad64FollowupRegressions) {
  await runJad64FollowupRegressionValidation();
} else if (jad64AcceptanceRegressions) {
  await runJad64AcceptanceRegressionValidation();
} else if (jad64RootCauseRegressions) {
  await runJad64RootCauseRegressionValidation();
} else if (jad64Random30Regressions) {
  await runJad64Random30RegressionValidation();
} else if (jad64CutoutRegressions) {
  await runJad64CutoutRegressionValidation();
} else if (jad64MaterialLayerRegressions) {
  await runJad64MaterialLayerRegressionValidation();
} else if (theme10UserRegressions) {
  await runTheme10UserRegressionValidation();
} else {
  await runEditableExportValidation();
}

async function runJad64MaterialLayerRegressionValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --jad64-material-layer-regressions --url <preview-url>');
  const outDir = path.join(OUT_DIR, 'jad64-material-layer-regressions');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const samples = [
    {
      id: 'theme02-orbit-material-text-double-draw',
      themePack: 'theme02',
      key: 'theme02_page065',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_WnTYsvm57P/CleanShot 2026-06-18 at 14.24.34@2x.png',
      textProbe: 'AI 资本图景',
      minTextCount: 6,
      maxHiddenMaterialRmse: 0.10,
    },
    {
      id: 'theme09-cover-glass-alpha',
      themePack: 'theme09',
      key: 'theme09_page001',
      minTextCount: 12,
      minTransparentMediaCount: 2,
    },
    {
      id: 'theme07-data-year-lens-alpha',
      themePack: 'theme07',
      key: 'theme07_page005',
      minTextCount: 18,
      minTransparentMediaCount: 4,
    },
    {
      id: 'theme07-method-decorative-wash-hard-edge',
      themePack: 'theme07',
      key: 'theme07_page008',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_20dyhbuwD4/CleanShot 2026-06-18 at 14.26.08@2x.png',
      maxLargeDecorativeGradientShapes: 0,
      minTextCount: 24,
    },
    {
      id: 'theme07-case-decorative-wash-hard-edge',
      themePack: 'theme07',
      key: 'theme07_page009',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_kFUDwWaOPU/CleanShot 2026-06-18 at 14.26.29@2x.png',
      maxLargeDecorativeGradientShapes: 0,
      minTextCount: 30,
    },
    {
      id: 'theme01-cover-material-layer-control',
      themePack: 'theme01',
      key: 'theme01_page004',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_YN7SZF3Wmz/CleanShot 2026-06-18 at 14.24.48@2x.png',
      minTextCount: 8,
    },
  ];
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let context;
  let page;
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
  const results = [];
  const failures = [];
  try {
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${cliUrl}${cliUrl.includes('?') ? '&' : '?'}jad64_material_layer=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    for (const sample of samples) {
      const sampleDir = path.join(outDir, sample.id);
      mkdirSync(sampleDir, { recursive: true });
      const nav = await navigateValidationSample(page, sample);
      if (!nav.found) {
        const message = `${sample.id} could not find ${sample.key} in ${sample.themePack}; available keys: ${nav.availableKeys.slice(0, 10).join(', ')}`;
        failures.push(message);
        results.push({ ...sample, found: false, failures: [message] });
        continue;
      }
      const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
      const htmlScreenshot = path.join(sampleDir, 'html-slide.png');
      if (activeSlide) await activeSlide.screenshot({ path: htmlScreenshot });
      const dom = await collectMaterialLayerDomProbe(page, sample);
      writeFileSync(path.join(sampleDir, 'dom-probe.json'), JSON.stringify(dom, null, 2) + '\n');
      const hiddenMaterial = sample.textProbe && dom.materialTextRegion
        ? await captureHiddenMaterialTextReference(page, dom.materialTextRegion, sampleDir)
        : null;
      const pptxFile = path.join(sampleDir, `${sample.id}.pptx`);
      const reportFile = path.join(sampleDir, `${sample.id}-report.json`);
      const exportResult = await mod.exportEditablePptxFromPage(page, {
        outFile: pptxFile,
        reportFile,
        title: `JAD-64 material layer regression ${sample.id}`,
        slideIndexes: [nav.index],
      });
      const pptx = inspectPptx(pptxFile);
      const mediaDir = path.join(sampleDir, 'media');
      mkdirSync(mediaDir, { recursive: true });
      spawnSync('unzip', ['-q', '-o', pptxFile, 'ppt/media/*', '-d', mediaDir], { encoding: 'utf8' });
      const media = inspectExtractedMedia(mediaDir);
      const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
      const pairImage = createSamplePairImage(sample, visual, sampleDir);
      const materialText = hiddenMaterial
        ? analyzeMaterialTextInRaster(sample, { pptx, media, dom, hiddenMaterial, sampleDir })
        : null;
      const checks = validateMaterialLayerSample(sample, { pptx, dom, media, materialText });
      failures.push(...checks.failures);
      if (sample.screenshot && existsSync(sample.screenshot) && pairImage && commandAvailable('magick')) {
        spawnSync('magick', [
          sample.screenshot,
          '-resize',
          '640x360>',
          pairImage,
          '-resize',
          '960x540!',
          '-append',
          path.join(sampleDir, 'user-failure-vs-current-render.png'),
        ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      }
      results.push({
        ...sample,
        found: true,
        index: nav.index,
        htmlScreenshot,
        pptxFile,
        reportFile,
        pairImage,
        dom,
        hiddenMaterial,
        materialText,
        pptx: summarizeInspection(pptx),
        quickLook: visual,
        exportSummary: {
          slideCount: exportResult.slideCount,
          textObjects: exportResult.textObjects,
          shapeObjects: exportResult.shapeObjects,
          imageObjects: exportResult.imageObjects,
          warningCount: exportResult.warnings?.length || 0,
          fallbackWarnings: (exportResult.warnings || []).filter(warning => warning.type === 'node-image-fallback'),
        },
        checks,
      });
    }
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  const contactSheet = createSampleContactSheet(results, outDir);
  const result = {
    mode: 'jad64-material-layer-regressions',
    url: cliUrl,
    outDir,
    contactSheet,
    passed: failures.length === 0,
    samples: results,
    failures,
  };
  writeFileSync(path.join(outDir, 'jad64-material-layer-regressions.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
}

async function runJad64CutoutRegressionValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --jad64-cutout-regressions --url <preview-url>');
  const outDir = path.join(OUT_DIR, 'jad64-cutout-regressions');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const samples = [
    {
      id: 'theme09-risk-top-right-cutout',
      themePack: 'theme09',
      key: 'theme09_page027',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_9OgGc08oRa/CleanShot 2026-06-18 at 13.25.02@2x.png',
      checkTopBlack: true,
      minTextCount: 24,
    },
    {
      id: 'theme09-cover-top-right-cutout',
      themePack: 'theme09',
      key: 'theme09_page002',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_dt5xTXb4kk/CleanShot 2026-06-18 at 13.25.22@2x.png',
      checkTopBlack: true,
      minTextCount: 8,
    },
    {
      id: 'theme09-appendix-left-sidebar',
      themePack: 'theme09',
      key: 'theme09_page030',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_QowZ3ZBR0l/CleanShot 2026-06-18 at 13.25.45@2x.png',
      checkLeftSidebar: true,
      minTextCount: 8,
    },
    {
      id: 'theme09-rank-left-sidebar',
      themePack: 'theme09',
      key: 'theme09_page036',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_EgiNcmafBv/CleanShot 2026-06-18 at 13.26.11@2x.png',
      checkLeftSidebar: true,
      minTextCount: 40,
    },
    {
      id: 'theme09-contact-left-sidebar',
      themePack: 'theme09',
      key: 'theme09_page039',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_vimeyv9Qur/CleanShot 2026-06-18 at 13.26.33@2x.png',
      checkLeftSidebar: true,
      minTextCount: 16,
    },
    {
      id: 'theme02-orbit-center-text',
      themePack: 'theme02',
      key: 'theme02_page065',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_Do9pzPYSI8/CleanShot 2026-06-18 at 13.29.14@2x.png',
      minTextCount: 6,
    },
    {
      id: 'theme01-cover-material-overlap',
      themePack: 'theme01',
      key: 'theme01_page004',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_s1ERJPUjGZ/CleanShot 2026-06-18 at 13.30.04@2x.png',
      minTextCount: 8,
    },
  ];
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let context;
  let page;
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
  const results = [];
  const failures = [];
  try {
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${cliUrl}${cliUrl.includes('?') ? '&' : '?'}jad64_cutout=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    for (const sample of samples) {
      const sampleDir = path.join(outDir, sample.id);
      mkdirSync(sampleDir, { recursive: true });
      const nav = await navigateValidationSample(page, sample);
      if (!nav.found) {
        const message = `${sample.id} could not find ${sample.key} in ${sample.themePack}; available keys: ${nav.availableKeys.slice(0, 10).join(', ')}`;
        failures.push(message);
        results.push({ ...sample, found: false, failures: [message] });
        continue;
      }
      const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
      const htmlScreenshot = path.join(sampleDir, 'html-slide.png');
      if (activeSlide) await activeSlide.screenshot({ path: htmlScreenshot });
      const dom = await collectCutoutDomProbe(page);
      writeFileSync(path.join(sampleDir, 'dom-probe.json'), JSON.stringify(dom, null, 2) + '\n');
      const pptxFile = path.join(sampleDir, `${sample.id}.pptx`);
      const reportFile = path.join(sampleDir, `${sample.id}-report.json`);
      const exportResult = await mod.exportEditablePptxFromPage(page, {
        outFile: pptxFile,
        reportFile,
        title: `JAD-64 cutout regression ${sample.id}`,
        slideIndexes: [nav.index],
      });
      const pptx = inspectPptx(pptxFile);
      const mediaDir = path.join(sampleDir, 'media');
      mkdirSync(mediaDir, { recursive: true });
      spawnSync('unzip', ['-q', '-o', pptxFile, 'ppt/media/*', '-d', mediaDir], { encoding: 'utf8' });
      const media = inspectExtractedMedia(mediaDir);
      const mediaStats = analyzeSampleRasterFallbacks(pptx, media);
      const contamination = analyzeCutoutMediaContamination(sample, pptx, media, sampleDir);
      const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
      const pairImage = createSamplePairImage(sample, visual, sampleDir);
      const checks = validateCutoutSample(sample, { pptx, contamination, exportResult });
      failures.push(...checks.failures);
      if (sample.screenshot && existsSync(sample.screenshot) && pairImage && commandAvailable('magick')) {
        spawnSync('magick', [
          sample.screenshot,
          '-resize',
          '640x360>',
          pairImage,
          '-resize',
          '960x540!',
          '-append',
          path.join(sampleDir, 'user-failure-vs-current-render.png'),
        ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      }
      results.push({
        ...sample,
        found: true,
        index: nav.index,
        htmlScreenshot,
        pptxFile,
        reportFile,
        pairImage,
        dom,
        pptx: summarizeInspection(pptx),
        quickLook: visual,
        mediaStats,
        contamination,
        exportSummary: {
          slideCount: exportResult.slideCount,
          textObjects: exportResult.textObjects,
          shapeObjects: exportResult.shapeObjects,
          imageObjects: exportResult.imageObjects,
          warningCount: exportResult.warnings?.length || 0,
          fallbackWarnings: (exportResult.warnings || []).filter(warning => warning.type === 'node-image-fallback'),
        },
        checks,
      });
    }
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  const contactSheet = createSampleContactSheet(results, outDir);
  const result = {
    mode: 'jad64-cutout-regressions',
    url: cliUrl,
    outDir,
    contactSheet,
    passed: failures.length === 0,
    samples: results,
    failures,
  };
  writeFileSync(path.join(outDir, 'jad64-cutout-regressions.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
}

async function runJad64Random30RegressionValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --jad64-random30-regressions --url <preview-url> [--selection-summary <path>]');
  if (!existsSync(cliSelectionSummary)) throw new Error(`Missing selection summary: ${cliSelectionSummary}`);
  const outDir = path.join(OUT_DIR, 'jad64-random30-regressions');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const selection = JSON.parse(readFileSync(cliSelectionSummary, 'utf8'));
  const sampleSpecs = [
    {
      id: 'theme11-cover-ui-clip',
      themePack: 'theme11',
      key: 'theme11_page001',
      coverage: 'fallback screenshots must not capture slide thumbnails or UI-like panels into the slide',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_RwKcG7MQdg/CleanShot 2026-06-18 at 11.46.27@2x.png',
      maxRmse: 0.22,
      maxDiffRatio: 0.24,
      maxLeftStripDiffRatio: 0.18,
      maxLargeRasterArea: 0.42,
    },
    {
      id: 'theme11-stacked-chart-layering',
      themePack: 'theme11',
      key: 'theme11_page039',
      coverage: 'chart/local fallback layers must not duplicate or overpaint stacked chart content',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_MWenjWMDd1/CleanShot 2026-06-18 at 11.47.33@2x.png',
      maxRmse: 0.23,
      maxDiffRatio: 0.22,
      maxLargeRasterArea: 0.50,
    },
    {
      id: 'theme11-halfscreen-overlay',
      themePack: 'theme11',
      key: 'theme11_page075',
      coverage: 'large translucent fallback overlays must not cover half the slide',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_S8dOy496Gl/CleanShot 2026-06-18 at 11.48.23@2x.png',
      maxRmse: 0.22,
      maxDiffRatio: 0.24,
      maxLeftStripDiffRatio: 0.18,
      maxLargeRasterArea: 0.42,
    },
    {
      id: 'theme10-risk-profile-loss',
      themePack: 'theme10',
      key: 'theme10_page008',
      coverage: 'previously-good theme10 geometry/text must not lose visible elements',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_pyKRjzo48O/CleanShot 2026-06-18 at 11.48.44@2x.png',
      maxRmse: 0.20,
      maxDiffRatio: 0.18,
      minTextCount: 8,
    },
    {
      id: 'theme09-cover-text-baked-into-background',
      themePack: 'theme09',
      key: 'theme09_page002',
      coverage: 'background/material fallback must not bake editable title text into a raster image',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_8WLR5lIE0X/CleanShot 2026-06-18 at 11.49.47@2x.png',
      maxRmse: 0.22,
      maxDiffRatio: 0.32,
      maxLargeRasterArea: 0.55,
      minTextCount: 8,
      textProbes: ['美国大额融资', 'AI 公司', '调研报告'],
    },
    {
      id: 'theme09-chart-black-block',
      themePack: 'theme09',
      key: 'theme09_page017',
      coverage: 'chart fallback must not create black blocks or misplaced local raster layers',
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_N3kjh8z7g7/CleanShot 2026-06-18 at 11.50.36@2x.png',
      maxRmse: 0.22,
      maxDiffRatio: 0.20,
      maxLargeRasterArea: 0.45,
    },
  ];
  const samples = resolveRandom30Samples(selection, sampleSpecs);
  writeFileSync(path.join(outDir, 'sample-selection.json'), JSON.stringify({ selectionSummary: cliSelectionSummary, samples }, null, 2) + '\n');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let context;
  let page;
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
  const results = [];
  const failures = [];
  try {
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${cliUrl}${cliUrl.includes('?') ? '&' : '?'}jad64_random30=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    for (const sample of samples) {
      const sampleDir = path.join(outDir, sample.id);
      mkdirSync(sampleDir, { recursive: true });
      const nav = await navigateValidationSample(page, sample);
      if (!nav.found) {
        const message = `${sample.id} could not find ${sample.key} in ${sample.themePack}; available keys: ${nav.availableKeys.slice(0, 10).join(', ')}`;
        failures.push(message);
        results.push({ ...sample, found: false, failures: [message] });
        continue;
      }
      const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
      const htmlScreenshot = path.join(sampleDir, 'html-slide.png');
      if (activeSlide) await activeSlide.screenshot({ path: htmlScreenshot });
      const dom = await collectRandom30DomProbe(page, sample);
      writeFileSync(path.join(sampleDir, 'dom-probe.json'), JSON.stringify(dom, null, 2) + '\n');
      const pptxFile = path.join(sampleDir, `${sample.id}.pptx`);
      const reportFile = path.join(sampleDir, `${sample.id}-report.json`);
      const exportResult = await mod.exportEditablePptxFromPage(page, {
        outFile: pptxFile,
        reportFile,
        title: `JAD-64 random30 regression ${sample.id}`,
        slideIndexes: [nav.index],
      });
      const pptx = inspectPptx(pptxFile);
      const mediaDir = path.join(sampleDir, 'media');
      mkdirSync(mediaDir, { recursive: true });
      spawnSync('unzip', ['-q', '-o', pptxFile, 'ppt/media/*', '-d', mediaDir], { encoding: 'utf8' });
      const media = inspectExtractedMedia(mediaDir);
      const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
      const pairImage = createSamplePairImage(sample, visual, sampleDir);
      const diffStats = analyzeRenderedDiff(visual, sampleDir);
      const mediaStats = analyzeSampleRasterFallbacks(pptx, media);
      const checks = validateRandom30Sample(sample, { dom, pptx, visual, diffStats, mediaStats, exportResult });
      failures.push(...checks.failures);
      if (sample.screenshot && existsSync(sample.screenshot) && pairImage && commandAvailable('magick')) {
        spawnSync('magick', [
          sample.screenshot,
          '-resize',
          '640x360>',
          pairImage,
          '-resize',
          '960x540!',
          '-append',
          path.join(sampleDir, 'user-failure-vs-current-render.png'),
        ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      }
      results.push({
        ...sample,
        found: true,
        index: nav.index,
        htmlScreenshot,
        pptxFile,
        reportFile,
        pairImage,
        userFailureVsCurrentRender: sample.screenshot ? path.join(sampleDir, 'user-failure-vs-current-render.png') : null,
        dom,
        pptx: summarizeInspection(pptx),
        quickLook: visual,
        diffStats,
        mediaStats,
        exportSummary: {
          slideCount: exportResult.slideCount,
          textObjects: exportResult.textObjects,
          shapeObjects: exportResult.shapeObjects,
          imageObjects: exportResult.imageObjects,
          warningCount: exportResult.warnings?.length || 0,
          fallbackWarnings: (exportResult.warnings || []).filter(warning => warning.type === 'node-image-fallback'),
        },
        checks,
      });
    }
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  const contactSheet = createSampleContactSheet(results, outDir);
  const result = {
    mode: 'jad64-random30-regressions',
    url: cliUrl,
    selectionSummary: cliSelectionSummary,
    outDir,
    contactSheet,
    passed: failures.length === 0,
    samples: results,
    failures,
  };
  writeFileSync(path.join(outDir, 'jad64-random30-regressions.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (failures.length) process.exitCode = 1;
}

async function runJad64RootCauseRegressionValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --jad64-root-cause-regressions --url <preview-url>');
  const outDir = path.join(OUT_DIR, 'jad64-root-cause-regressions');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const samples = [
    {
      label: 'theme04-cover-neon-material',
      themePack: 'theme04',
      key: 'theme04_page001',
      coverage: 'PowerPoint-visible glass/neon material fidelity for rounded local highlight surfaces',
      probes: ['material-region'],
      textProbes: ['重新分配'],
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_6wZe8ktxF9/CleanShot 2026-06-18 at 10.41.22@2x.png',
    },
    {
      label: 'theme07-waterfall-svg-crop',
      themePack: 'theme07',
      key: 'theme07_page023',
      coverage: 'SVG/chart fallback crop must include the full browser-rendered visual bbox',
      probes: ['svg-crop'],
      textProbes: ['+50', '其他'],
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_CARCyRC48K/CleanShot 2026-06-18 at 10.25.28@2x.png',
    },
    {
      label: 'theme02-radar-svg-aspect',
      themePack: 'theme02',
      key: 'theme02_page016',
      coverage: 'SVG/chart fallback aspect must match the rendered HTML chart region',
      probes: ['svg-aspect'],
      textProbes: ['模型能力', '商业化', '算力储备'],
      screenshot: '/Users/jadon7/Library/Application Support/CleanShot/media/media_JSQQ3rlqc9/CleanShot 2026-06-18 at 10.26.43@2x.png',
    },
    {
      label: 'theme09-rounded-material-cross-theme',
      themePack: 'theme09',
      key: 'theme09_page010',
      coverage: 'cross-theme rounded/glass material region uses the same local fallback geometry',
      probes: ['material-region'],
    },
    {
      label: 'theme04-radar-svg-aspect-cross-page',
      themePack: 'theme04',
      key: 'theme04_page030',
      coverage: 'cross-page radar SVG aspect uses the same fallback sizing logic',
      probes: ['svg-aspect'],
      textProbes: ['模型能力', '资本储备'],
    },
    {
      label: 'theme04-waterfall-svg-crop-cross-page',
      themePack: 'theme04',
      key: 'theme04_page047',
      coverage: 'cross-page waterfall SVG crop uses the same fallback visual bbox logic',
      probes: ['svg-crop'],
      textProbes: ['其他赛道', 'OTHERS'],
    },
  ];
  const rootCauseMatrix = [
    {
      cluster: 'local material fallback bbox',
      samples: ['theme04-cover-neon-material', 'theme09-rounded-material-cross-theme'],
      sharedMechanism: 'CSS gradient/shadow/glow/glass regions are browser-rendered visual surfaces; PPT native approximations need a bounded local image fallback at the element visual bbox while preserving text as editable objects.',
    },
    {
      cluster: 'SVG fallback aspect and crop',
      samples: ['theme07-waterfall-svg-crop', 'theme02-radar-svg-aspect', 'theme04-radar-svg-aspect-cross-page', 'theme04-waterfall-svg-crop-cross-page'],
      sharedMechanism: 'SVG/chart fallback images must use the browser-rendered visual bbox and rendered aspect instead of the raw element CSS box when exported to PowerPoint.',
    },
  ];
  const renderPath = {
    primary: 'Quick Look qlmanage thumbnail rendered from the exported PPTX, normalized to 960x540 for deterministic local crop comparison.',
    candidates: [
      {
        renderer: 'Microsoft PowerPoint AppleScript save as PNG/PDF',
        status: 'rejected',
        reason: 'PowerPoint is installed and scriptable, but save-as PNG/PDF AppleScript calls returned success without creating files in this environment.',
      },
      {
        renderer: 'Microsoft PowerPoint slide show + screencapture',
        status: 'rejected',
        reason: 'A slide show window can be created, but macOS screencapture captured the foreground desktop/app stack instead of the slide show surface, so it would create false evidence.',
      },
      {
        renderer: 'LibreOffice',
        status: 'unavailable',
        reason: 'LibreOffice/soffice is not installed on this machine.',
      },
    ],
    limitation: 'Quick Look is not identical to an interactive PowerPoint edit window, but it renders the actual exported PPTX through the macOS presentation preview stack and is repeatable for automated red/green visual evidence.',
  };
  writeFileSync(path.join(outDir, 'root-cause-matrix.json'), JSON.stringify(rootCauseMatrix, null, 2) + '\n');
  writeFileSync(path.join(outDir, 'render-path.json'), JSON.stringify(renderPath, null, 2) + '\n');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let context;
  let page;
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
  const results = [];
  const failures = [];
  try {
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${cliUrl}${cliUrl.includes('?') ? '&' : '?'}jad64_root_cause=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);

    for (const sample of samples) {
      const sampleDir = path.join(outDir, sample.label);
      mkdirSync(sampleDir, { recursive: true });
      const nav = await navigateValidationSample(page, sample);
      if (!nav.found) {
        failures.push(`${sample.label} could not find ${sample.key} in ${sample.themePack}; available keys: ${nav.availableKeys.slice(0, 10).join(', ')}`);
        results.push({ ...sample, found: false, availableKeys: nav.availableKeys });
        continue;
      }
      const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
      const htmlScreenshot = path.join(sampleDir, 'html-slide.png');
      if (activeSlide) await activeSlide.screenshot({ path: htmlScreenshot });
      const dom = await collectJad64RootCauseDomProbe(page, sample);
      writeFileSync(path.join(sampleDir, 'dom-probe.json'), JSON.stringify(dom, null, 2) + '\n');

      const pptxFile = path.join(sampleDir, `${sample.label}.pptx`);
      const reportFile = path.join(sampleDir, `${sample.label}-report.json`);
      await mod.exportEditablePptxFromPage(page, {
        outFile: pptxFile,
        reportFile,
        title: `JAD-64 root cause ${sample.label}`,
        slideIndexes: [nav.index],
      });
      const pptx = inspectPptx(pptxFile);
      const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
      const pairImage = createSamplePairImage(sample, visual, sampleDir);
      const regionChecks = analyzeJad64RootCauseRegions(sample, dom, visual, sampleDir);
      const checks = validateJad64RootCauseSample(sample, dom, pptx, visual, regionChecks);
      failures.push(...checks.failures);
      if (!visual?.available || !pairImage) failures.push(`${sample.label} did not produce rendered PPTX visual evidence (${visual?.reason || 'missing-pair'}).`);
      if (sample.screenshot && existsSync(sample.screenshot) && pairImage && commandAvailable('magick')) {
        spawnSync('magick', [
          sample.screenshot,
          '-resize',
          '640x360>',
          pairImage,
          '-resize',
          '960x540!',
          '-append',
          path.join(sampleDir, 'user-failure-vs-current-render.png'),
        ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
      }
      results.push({
        ...sample,
        found: true,
        index: nav.index,
        htmlScreenshot,
        pptxFile,
        reportFile,
        pairImage,
        userFailureVsCurrentRender: sample.screenshot ? path.join(sampleDir, 'user-failure-vs-current-render.png') : null,
        quickLook: visual,
        dom,
        pptx: summarizeInspection(pptx),
        regionChecks,
        checks,
      });
    }
  } finally {
    await closePage(page);
    await context?.close().catch(() => {});
    await closeBrowser(browser);
  }
  const contactSheet = createSampleContactSheet(results, outDir);
  const result = {
    mode: 'jad64-root-cause-regressions',
    url: cliUrl,
    outDir,
    rootCauseMatrix: path.join(outDir, 'root-cause-matrix.json'),
    renderPath: path.join(outDir, 'render-path.json'),
    contactSheet,
    passed: failures.length === 0,
    samples: results,
    failures,
  };
  writeFileSync(path.join(outDir, 'jad64-root-cause-regressions.json'), JSON.stringify(result, null, 2) + '\n');
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

async function runJad64AcceptanceRegressionValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --jad64-acceptance-regressions --url <preview-url>');
  const outDir = path.join(OUT_DIR, 'jad64-acceptance-regressions');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const selectionSummary = path.join('output', 'theme-20-pptx-export-20260617T215810', 'selection-summary.json');
  const failureScreenshots = path.join(ROOT, 'output/jad64-user-acceptance-fail-20260617T2234');
  const samples = [
    {
      id: '01-text-stacking',
      screenshot: path.join(failureScreenshots, '01-text-stacking.png'),
      themePack: 'theme02',
      key: 'theme02_page074',
      selectedSlide: 20,
      sourcePptx: 'theme02-20-pages.pptx',
      coverage: 'large closing title must not duplicate/stack styled statement layers',
      probes: ['text-stacking'],
      textProbes: ['AI 融资盛宴仍在继续', '但音乐节奏正在变化'],
      positionProbes: ['但音乐节奏正在'],
    },
    {
      id: '02-rounded-corner-mismatch',
      screenshot: path.join(failureScreenshots, '02-rounded-corner-mismatch.png'),
      themePack: 'theme02',
      key: 'theme02_page016',
      selectedSlide: 5,
      sourcePptx: 'theme02-20-pages.pptx',
      coverage: 'glass list cards should keep rounded outlines without square border or crop artifacts',
      probes: ['rounded-cards'],
      textProbes: ['OpenAI', 'Anthropic', 'Google DeepMind', 'Mistral'],
    },
    {
      id: '03-aspect-stretch',
      screenshot: path.join(failureScreenshots, '03-aspect-stretch.png'),
      themePack: 'theme02',
      key: 'theme02_page016',
      selectedSlide: 5,
      sourcePptx: 'theme02-20-pages.pptx',
      coverage: 'radar SVG should preserve its rendered bbox/aspect and not stretch/shift',
      probes: ['svg-aspect'],
      textProbes: ['模型能力', '商业化', '算力储备', '数据壁垒', '安全对齐', '资本厚度'],
    },
    {
      id: '04-material-mismatch',
      screenshot: path.join(failureScreenshots, '04-material-mismatch.png'),
      themePack: 'theme04',
      key: 'theme04_page001',
      selectedSlide: 1,
      sourcePptx: 'theme04-20-pages.pptx',
      coverage: 'glass highlight pill should retain local material bbox and readable editable text',
      probes: ['material-highlight'],
      textProbes: ['资本，正在', '重新分配'],
      positionProbes: ['重新分配'],
    },
    {
      id: '05-incomplete-crop',
      screenshot: path.join(failureScreenshots, '05-incomplete-crop.png'),
      themePack: 'theme07',
      key: 'theme07_page023',
      selectedSlide: 7,
      sourcePptx: 'theme07-20-pages.pptx',
      coverage: 'waterfall SVG/text should stay inside slide bounds with no left/bottom crop',
      probes: ['crop-bounds'],
      textProbes: ['融资额贡献瀑布', '全年合计', '基础设施', 'AI 芯片'],
    },
  ];
  const rootCauseMatrix = [
    {
      cluster: 'text stacking',
      samples: ['01-text-stacking'],
      sharedMechanism: 'editable text and local image/material fallbacks can both carry the same visible glyphs, or large transformed text can be exported twice at the same position',
    },
    {
      cluster: 'rounded border/material mismatch',
      samples: ['02-rounded-corner-mismatch', '04-material-mismatch'],
      sharedMechanism: 'rounded gradient/shadow boxes need mutually exclusive native lines and clipped local material fallbacks at the element bbox',
    },
    {
      cluster: 'aspect stretch',
      samples: ['03-aspect-stretch'],
      sharedMechanism: 'SVG fallback images must use the browser-rendered visual bbox and preserve the DOM aspect ratio in the PPT image object',
    },
    {
      cluster: 'incomplete crop',
      samples: ['05-incomplete-crop'],
      sharedMechanism: 'complex SVG/text fallbacks must not emit negative or off-slide object boxes after clipping and coordinate conversion',
    },
  ];
  writeFileSync(path.join(outDir, 'root-cause-matrix.json'), JSON.stringify(rootCauseMatrix, null, 2) + '\n');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let context;
  let page;
  const results = [];
  const failures = [];
  try {
    context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, ignoreHTTPSErrors: true });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${cliUrl}${cliUrl.includes('?') ? '&' : '?'}jad64_acceptance=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));

    for (const sample of samples) {
      const sampleDir = path.join(outDir, sample.id);
      mkdirSync(sampleDir, { recursive: true });
      const nav = await navigateValidationSample(page, sample);
      if (!nav.found) {
        failures.push(`${sample.id} could not find ${sample.key} in ${sample.themePack}; available keys: ${nav.availableKeys.slice(0, 10).join(', ')}`);
        results.push({ ...sample, found: false, availableKeys: nav.availableKeys });
        continue;
      }
      const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
      const htmlScreenshot = path.join(sampleDir, 'html-slide.png');
      if (activeSlide) await activeSlide.screenshot({ path: htmlScreenshot });
      const dom = await collectJad64AcceptanceDomProbe(page, sample);
      writeFileSync(path.join(sampleDir, 'dom-probe.json'), JSON.stringify(dom, null, 2) + '\n');
      const pptxFile = path.join(sampleDir, `${sample.id}.pptx`);
      const reportFile = path.join(sampleDir, `${sample.id}-report.json`);
      await mod.exportEditablePptxFromPage(page, {
        outFile: pptxFile,
        reportFile,
        title: `JAD-64 acceptance ${sample.id}`,
        slideIndexes: [nav.index],
      });
      const pptx = inspectPptx(pptxFile);
      const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
      const pairImage = createSamplePairImage(sample, visual, sampleDir);
      if (sample.screenshot && existsSync(sample.screenshot) && pairImage && commandAvailable('magick')) {
        spawnSync('magick', [sample.screenshot, '-resize', '480x270>', pairImage, '-resize', '960x270!', '-append', path.join(sampleDir, 'failure-vs-current-pair.png')], { encoding: 'utf8' });
      }
      const checks = validateJad64AcceptanceSample(sample, dom, pptx, visual);
      failures.push(...checks.failures);
      if (!visual?.available || !pairImage) failures.push(`${sample.id} did not produce Quick Look visual evidence (${visual?.reason || 'missing-pair'}).`);
      results.push({
        ...sample,
        found: true,
        index: nav.index,
        htmlScreenshot,
        pptxFile,
        reportFile,
        pairImage,
        failureVsCurrentPair: path.join(sampleDir, 'failure-vs-current-pair.png'),
        quickLook: visual,
        dom,
        pptx: summarizeInspection(pptx),
        pptxSlide: summarizeSlideForAcceptance(pptx.slides[0]),
        checks,
      });
    }
  } finally {
    await closePage(page);
    await context?.close().catch(() => {});
    await closeBrowser(browser);
  }
  const contactSheet = createSampleContactSheet(results, outDir);
  const result = {
    mode: 'jad64-acceptance-regressions',
    url: cliUrl,
    outDir,
    selectionSummary,
    contactSheet,
    rootCauseMatrix: path.join(outDir, 'root-cause-matrix.json'),
    passed: failures.length === 0,
    samples: results,
    failures,
  };
  writeFileSync(path.join(outDir, 'jad64-acceptance-regressions.json'), JSON.stringify(result, null, 2) + '\n');
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

async function runJad64FollowupRegressionValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --jad64-followup-regressions --url <preview-url>');
  const outDir = path.join(OUT_DIR, 'jad64-followup-regressions');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const samples = [
    {
      screenshot: [3, 4],
      themePack: 'theme09',
      key: 'theme09_page010',
      label: 'theme09-contents-rounded-cards',
      coverage: 'rounded card borders and glass glow should stay rounded instead of gaining square edge strips',
      probes: ['rounded-border-artifacts'],
    },
    {
      screenshot: 14,
      themePack: 'theme08',
      key: 'theme08_page060',
      label: 'theme08-resource-inline-highlight',
      coverage: 'inline emphasized phrase should not become an overlapping duplicate text run',
      probes: ['inline-highlight-duplication'],
    },
    {
      screenshot: 18,
      themePack: 'theme06',
      key: 'theme06_page070',
      label: 'theme06-workflow-connectors',
      coverage: 'CSS pseudo arrows/triangles with percent offsets should become geometry, not misplaced text glyphs',
      probes: ['pseudo-arrow-geometry'],
    },
    {
      screenshot: 19,
      themePack: 'theme04',
      key: 'theme04_page001',
      label: 'theme04-cover-highlight-pill',
      coverage: 'large highlight pill and decorative sparkle should keep geometry/material without text overlap',
      probes: ['highlight-pill-border-artifacts'],
    },
  ];
  const rootCauseMatrix = [
    {
      cluster: 'rounded borders',
      screenshots: [3, 4, 9, 12, 13, 14, 19],
      currentExporterGap: 'Rounded elements with uniform borders are exported as a rounded shape plus four square border rectangles, so PowerPoint shows mismatched corners and edge strips.',
      sharedMechanism: true,
    },
    {
      cluster: 'pseudo arrows and triangles',
      screenshots: [17, 18],
      currentExporterGap: 'Pseudo elements using percentage offsets and CSS border triangles are measured as plain pixel offsets and only one triangle direction is supported.',
      sharedMechanism: true,
    },
    {
      cluster: 'inline styled text',
      screenshots: [1, 14, 19],
      currentExporterGap: 'Inline emphasis is decomposed into independent text boxes and decoration boxes; when sizing or border strips drift, PowerPoint can show duplicated or overlaid styled phrases.',
      sharedMechanism: true,
    },
    {
      cluster: 'blend/glow/material',
      screenshots: [1, 2, 6, 14, 19],
      currentExporterGap: 'CSS blend modes and soft glows remain approximate in editable PPTX; obvious rectangular artifacts should still be eliminated.',
      sharedMechanism: false,
    },
  ];
  writeFileSync(path.join(outDir, 'root-cause-matrix.json'), JSON.stringify(rootCauseMatrix, null, 2) + '\n');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let context;
  let page;
  const results = [];
  const failures = [];
  try {
    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${cliUrl}${cliUrl.includes('?') ? '&' : '?'}jad64_followup=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));

    for (const sample of samples) {
      const sampleDir = path.join(outDir, sample.label);
      mkdirSync(sampleDir, { recursive: true });
      const nav = await navigateValidationSample(page, sample);
      if (!nav.found) {
        failures.push(`${sample.label} could not find ${sample.key} in ${sample.themePack}; available keys: ${nav.availableKeys.slice(0, 10).join(', ')}`);
        results.push({ ...sample, found: false, availableKeys: nav.availableKeys });
        continue;
      }
      const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
      const htmlScreenshot = path.join(sampleDir, 'html-slide.png');
      if (activeSlide) await activeSlide.screenshot({ path: htmlScreenshot });
      const dom = await collectJad64FollowupDomProbe(page);
      writeFileSync(path.join(sampleDir, 'dom-probe.json'), JSON.stringify(dom, null, 2) + '\n');
      const pptxFile = path.join(sampleDir, `${sample.label}.pptx`);
      const reportFile = path.join(sampleDir, `${sample.label}-report.json`);
      await mod.exportEditablePptxFromPage(page, {
        outFile: pptxFile,
        reportFile,
        title: `JAD-64 follow-up ${sample.label}`,
        slideIndexes: [nav.index],
      });
      const pptx = inspectPptx(pptxFile);
      const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
      const pairImage = createSamplePairImage(sample, visual, sampleDir);
      const checks = validateJad64FollowupSample(sample, dom, pptx);
      failures.push(...checks.failures);
      if (!visual?.available || !pairImage) failures.push(`${sample.label} did not produce Quick Look visual evidence (${visual?.reason || 'missing-pair'}).`);
      results.push({
        ...sample,
        found: true,
        index: nav.index,
        htmlScreenshot,
        pptxFile,
        reportFile,
        pairImage,
        quickLook: visual,
        dom,
        pptx: summarizeInspection(pptx),
        checks,
      });
    }
    const synthetic = await runSyntheticCssTriangleRegression(context, mod, outDir);
    results.push(synthetic);
    failures.push(...synthetic.checks.failures);
  } finally {
    await closePage(page);
    await context?.close().catch(() => {});
    await closeBrowser(browser);
  }

  const result = {
    mode: 'jad64-followup-regressions',
    url: cliUrl,
    outDir,
    rootCauseMatrix: path.join(outDir, 'root-cause-matrix.json'),
    passed: failures.length === 0,
    samples: results,
    failures,
  };
  writeFileSync(path.join(outDir, 'jad64-followup-regressions.json'), JSON.stringify(result, null, 2) + '\n');
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

async function runSyntheticCssTriangleRegression(context, mod, outDir) {
  const sample = {
    synthetic: true,
    label: 'synthetic-css-border-triangle-matrix-translate',
    coverage: 'real browser CSS ::before width:0;height:0 border triangle with computed matrix translate',
  };
  const sampleDir = path.join(outDir, sample.label);
  rmSync(sampleDir, { recursive: true, force: true });
  mkdirSync(sampleDir, { recursive: true });
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(45000);
    await page.setContent(`<!doctype html>
      <html><head><meta charset="utf-8">
      <style>
        body { margin: 0; background: #111827; }
        #deck { width: 1920px; height: 1080px; }
        .slide { position: relative; width: 1920px; height: 1080px; overflow: hidden; background: #111827; color: #f8fafc; font-family: Arial, sans-serif; }
        .probe { position: absolute; left: 820px; top: 470px; width: 160px; height: 80px; border-radius: 14px; border: 2px solid #38bdf8; background: rgba(56,189,248,.12); }
        .probe::before { content: ""; position: absolute; left: 50%; top: 50%; width: 0; height: 0; border-left: 18px solid transparent; border-right: 18px solid transparent; border-bottom: 32px solid #ff3d97; transform: translate(-50%, -50%); }
        .probe-label { position: absolute; left: 1040px; top: 482px; font-size: 44px; font-weight: 700; }
      </style></head>
      <body><div id="deck"><section class="slide active" data-layout-key="synthetic-css-triangle"><div class="probe"></div><div class="probe-label">CSS triangle probe</div></section></div></body></html>`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active');
    const activeSlide = await page.$('#deck > .slide.active');
    const htmlScreenshot = path.join(sampleDir, 'html-slide.png');
    await activeSlide.screenshot({ path: htmlScreenshot });
    const dom = await page.evaluate(() => {
      const slide = document.querySelector('#deck > .slide.active');
      const probe = document.querySelector('.probe');
      const slideRect = slide.getBoundingClientRect();
      const rect = probe.getBoundingClientRect();
      const style = getComputedStyle(probe, '::before');
      const px = value => parseFloat(value || '0') || 0;
      const matrix = String(style.transform || '').match(/matrix\(([^)]+)\)/);
      const parts = matrix ? matrix[1].split(',').map(Number) : [];
      const tx = Number.isFinite(parts[4]) ? parts[4] : 0;
      const ty = Number.isFinite(parts[5]) ? parts[5] : 0;
      const visualW = px(style.width) + px(style.borderLeftWidth) + px(style.borderRightWidth);
      const visualH = px(style.height) + px(style.borderTopWidth) + px(style.borderBottomWidth);
      const left = px(style.left);
      const top = px(style.top);
      const expectedPx = {
        x: rect.left - slideRect.left + left + tx,
        y: rect.top - slideRect.top + top + ty,
        w: visualW,
        h: visualH,
      };
      return {
        key: slide.dataset.layoutKey,
        parentRect: { x: rect.left - slideRect.left, y: rect.top - slideRect.top, w: rect.width, h: rect.height },
        pseudo: {
          left: style.left,
          top: style.top,
          width: style.width,
          height: style.height,
          transform: style.transform,
          borderLeftWidth: style.borderLeftWidth,
          borderRightWidth: style.borderRightWidth,
          borderBottomWidth: style.borderBottomWidth,
          expectedPx,
          expectedIn: {
            x: expectedPx.x / slideRect.width * 16,
            y: expectedPx.y / slideRect.height * 9,
            w: expectedPx.w / slideRect.width * 16,
            h: expectedPx.h / slideRect.height * 9,
          },
        },
      };
    });
    writeFileSync(path.join(sampleDir, 'dom-probe.json'), JSON.stringify(dom, null, 2) + '\n');
    const pptxFile = path.join(sampleDir, `${sample.label}.pptx`);
    const reportFile = path.join(sampleDir, `${sample.label}-report.json`);
    await mod.exportEditablePptxFromPage(page, {
      outFile: pptxFile,
      reportFile,
      title: 'JAD-64 synthetic CSS triangle regression',
      slideIndexes: [0],
    });
    const pptx = inspectPptx(pptxFile);
    const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
    const pairImage = createSamplePairImage(sample, visual, sampleDir);
    const checks = validateSyntheticCssTriangleSample(sample, dom, pptx);
    if (!visual?.available || !pairImage) checks.failures.push(`${sample.label} did not produce Quick Look visual evidence (${visual?.reason || 'missing-pair'}).`);
    return {
      ...sample,
      htmlScreenshot,
      pptxFile,
      reportFile,
      pairImage,
      quickLook: visual,
      dom,
      pptx: summarizeInspection(pptx),
      checks,
    };
  } finally {
    await closePage(page);
  }
}

async function runTheme10UserRegressionValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --theme10-user-regressions --url <preview-url>');
  const outDir = path.join(OUT_DIR, 'theme10-user-regressions');
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const samples = [
    { screenshot: 1, slide: 79, key: 'theme10_page079-831', layout: 'SlidePoster', label: 'unicorn-poster-rule', coverage: 'unicorn/shader background + foreground gradient rule' },
    { screenshot: 2, slide: 76, key: 'theme10_page076-828', layout: 'SlideCollage', label: 'collage-polaroid', coverage: 'rotated media cards, borders, stacking' },
    { screenshot: 3, slide: 82, key: 'theme10_page082-834', layout: 'SlidePyramid', label: 'pyramid-polygon', coverage: 'clip-path polygon trapezoids' },
    { screenshot: 4, slide: 86, key: 'theme10_page086-838', layout: 'SlideVenn', label: 'venn-blend', coverage: 'radial gradients, alpha overlap, labels' },
    { screenshot: 5, slide: 87, key: 'theme10_page087-839', layout: 'SlideBalance', label: 'balance-scale', coverage: 'rotated gradient line, triangle pivot, cards' },
    { screenshot: 6, slide: 91, key: 'theme10_page091-843', layout: 'SlideHive', label: 'hive-hexagons', coverage: 'clip-path polygon hexagons' },
  ];
  const rootCauseMatrix = [
    {
      screenshot: 1,
      slide: 79,
      layout: 'SlidePoster',
      failureType: 'unicorn foreground overlay rasterization',
    currentExporterGap: 'Narrow CSS linear-gradient foreground rules are exported as small PNG media instead of native PPT shape/line objects.',
    suggestedFix: 'Render narrow non-text linear-gradient foreground elements as native shapes with representative fill; keep unicorn/shader as a separate local background image.',
    sharedMechanism: true,
    status: 'fixed',
    },
    {
      screenshot: 2,
      slide: 76,
      layout: 'SlideCollage',
      failureType: 'transform/rotation/stage layout drift',
      currentExporterGap: 'Text inside rotated polaroid frames was exported without the parent rotation, causing captions and placeholders to drift against the cards.',
      suggestedFix: 'Propagate cumulative parent rotation into captured text styles so editable text stays aligned with rotated frames.',
      sharedMechanism: true,
      status: 'fixed',
    },
    {
      screenshot: 3,
      slide: 82,
      layout: 'SlidePyramid',
      failureType: 'clip-path polygon lost',
    currentExporterGap: 'CSS polygon trapezoids are rendered as rectangular PPT shapes.',
    suggestedFix: 'Map supported CSS polygon shapes to PPT freeform/native geometry or bounded local fallback with text extracted.',
    sharedMechanism: true,
    status: 'fixed',
    },
    {
      screenshot: 4,
      slide: 86,
      layout: 'SlideVenn',
      failureType: 'alpha blend/radial gradient mismatch',
      currentExporterGap: 'Radial-gradient discs with mix-blend-mode were also receiving rectangular border segments; blend/glow intensity remains an approximation.',
      suggestedFix: 'Render circle-like bordered elements with ellipse geometry only, avoiding four rectangular border artifacts. Keep true screen-blend/glow parity as a later rendering boundary.',
      sharedMechanism: true,
      status: 'partially-fixed',
    },
    {
      screenshot: 5,
      slide: 87,
      layout: 'SlideBalance',
      failureType: 'rotated gradient line and pseudo geometry mismatch',
      currentExporterGap: 'The tilted gradient beam, triangle support, and small circular pseudo/bullet elements required cumulative transform, border-triangle mapping, and ellipse geometry for circle-like boxes.',
      suggestedFix: 'Render the beam as a rotated native narrow gradient shape, the pivot as a custom triangle, and tiny circular controls/bullets as PPT ellipses instead of tiny roundRects.',
      sharedMechanism: true,
      status: 'fixed',
    },
    {
      screenshot: 6,
      slide: 91,
      layout: 'SlideHive',
      failureType: 'clip-path polygon lost',
    currentExporterGap: 'CSS hexagons are exported as rectangles; pseudo outline is not preserving hex geometry.',
    suggestedFix: 'Share the polygon mapping/fallback strategy with SlidePyramid.',
    sharedMechanism: true,
    status: 'fixed',
    },
  ];
  writeFileSync(path.join(outDir, 'root-cause-matrix.json'), JSON.stringify(rootCauseMatrix, null, 2) + '\n');

  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let page;
  let posterInfo = null;
  let pptx = null;
  let media = [];
  const polygonChecks = [];
  const balanceChecks = [];
  const collageChecks = [];
  const vennChecks = [];
  const visualChecks = [];
  const failures = [];
  const addVisualEvidence = (sample, sampleDir, pptxFile) => {
    const htmlScreenshot = path.join(sampleDir, 'html-slide.png');
    const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
    const pairImage = createSamplePairImage(sample, visual, sampleDir);
    const passed = Boolean(visual?.available && pairImage);
    visualChecks.push({
      slide: sample.slide,
      key: sample.key,
      label: sample.label,
      htmlScreenshot,
      pptxFile,
      pairImage,
      quickLook: visual,
      passed,
    });
    if (!passed) failures.push(`${sample.label} did not produce HTML/PPTX visual evidence pair (${visual?.reason || 'missing-compare-pair'}).`);
  };
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${cliUrl}${cliUrl.includes('?') ? '&' : '?'}theme10_regressions=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    await page.evaluate(async () => {
      window.__setActiveThemePack?.('theme10', { navigate: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__finishEditablePptxAnimations?.(document);
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    for (const sample of samples) {
      const sampleDir = path.join(outDir, `sample-${String(sample.slide).padStart(3, '0')}-${sample.label}`);
      mkdirSync(sampleDir, { recursive: true });
      await page.evaluate(async slide => {
        window.go?.(slide - 1, { animate: false, force: true });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__finishEditablePptxAnimations?.(document);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }, sample.slide);
      const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
      if (activeSlide) await activeSlide.screenshot({ path: path.join(sampleDir, 'html-slide.png') });
      if (sample.slide === 79) {
        posterInfo = await page.evaluate(() => {
          const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
          const frame = slide?.querySelector('.bt-unicorn-frame');
          const rule = slide?.querySelector('.pst-rule');
          const slideRect = slide?.getBoundingClientRect();
          const frameRect = frame?.getBoundingClientRect();
          const ruleRect = rule?.getBoundingClientRect();
          const local = rect => rect && slideRect ? ({
            x: rect.left - slideRect.left,
            y: rect.top - slideRect.top,
            w: rect.width,
            h: rect.height,
          }) : null;
          return {
            key: slide?.dataset.vmSlideId || slide?.dataset.layoutKey || slide?.id || '',
            text: (slide?.innerText || '').trim().replace(/\s+/g, ' '),
            slide: slideRect ? { x: slideRect.left, y: slideRect.top, w: slideRect.width, h: slideRect.height } : null,
            frame: local(frameRect),
            rule: local(ruleRect),
          };
        });
        writeFileSync(path.join(sampleDir, 'poster-dom.json'), JSON.stringify(posterInfo, null, 2) + '\n');
        if (!posterInfo?.rule) failures.push('theme10 poster sample is missing the .pst-rule foreground gradient rule.');
        const slidePng = path.join(sampleDir, 'html-slide.png');
        if (posterInfo?.rule && commandAvailable('magick')) {
          const crop = expandedCropSpec(posterInfo.rule, posterInfo.slide, 18);
          spawnSync('magick', [slidePng, '-crop', crop, path.join(sampleDir, 'html-rule-crop.png')], { encoding: 'utf8' });
          await page.evaluate(() => {
            const rule = document.querySelector('#deck > .slide.active .pst-rule, #deck > .slide[data-deck-active] .pst-rule');
            window.__theme10RuleStyle = rule?.getAttribute('style') ?? null;
            rule?.style.setProperty('opacity', '0', 'important');
          });
          if (activeSlide) await activeSlide.screenshot({ path: path.join(sampleDir, 'html-slide-rule-hidden.png') });
          spawnSync('magick', [path.join(sampleDir, 'html-slide-rule-hidden.png'), '-crop', crop, path.join(sampleDir, 'html-rule-hidden-crop.png')], { encoding: 'utf8' });
          await page.evaluate(() => {
            const rule = document.querySelector('#deck > .slide.active .pst-rule, #deck > .slide[data-deck-active] .pst-rule');
            if (!rule) return;
            if (window.__theme10RuleStyle == null) rule.removeAttribute('style');
            else rule.setAttribute('style', window.__theme10RuleStyle);
            delete window.__theme10RuleStyle;
          });
        }
        const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
        const pptxFile = path.join(sampleDir, 'poster.pptx');
        const reportFile = path.join(sampleDir, 'poster-report.json');
        await mod.exportEditablePptxFromPage(page, {
          outFile: pptxFile,
          reportFile,
          title: 'JAD-64 theme10 poster regression',
          slideIndexes: [sample.slide - 1],
        });
        pptx = inspectPptx(pptxFile);
        addVisualEvidence(sample, sampleDir, pptxFile);
        const mediaDir = path.join(sampleDir, 'media');
        mkdirSync(mediaDir, { recursive: true });
        spawnSync('unzip', ['-q', '-o', pptxFile, 'ppt/media/*', '-d', mediaDir], { encoding: 'utf8' });
        media = inspectExtractedMedia(mediaDir);
        const largest = media.slice().sort((a, b) => (b.width * b.height) - (a.width * a.height))[0];
        if (largest && posterInfo?.rule && commandAvailable('magick')) {
          const crop = expandedCropSpec({
            x: posterInfo.rule.x - (posterInfo.frame?.x || 0),
            y: posterInfo.rule.y - (posterInfo.frame?.y || 0),
            w: posterInfo.rule.w,
            h: posterInfo.rule.h,
          }, { w: largest.width, h: largest.height }, 18);
          spawnSync('magick', [largest.file, '-crop', crop, path.join(sampleDir, 'pptx-background-rule-crop.png')], { encoding: 'utf8' });
        }
        const narrowRuleMedia = media.filter(item => item.width <= 24 && item.height >= Math.max(140, (posterInfo?.rule?.h || 0) * 0.6));
        if (narrowRuleMedia.length) {
          failures.push(`theme10 poster foreground gradient rule is still exported as ${narrowRuleMedia.length} narrow PNG media object(s), not a native PPT shape/line.`);
        }
        if (pptx?.fullSlideImageOnlySlides?.length) failures.push(`theme10 poster became full-slide-image-only: ${pptx.fullSlideImageOnlySlides.join(', ')}.`);
        const allText = normalizeSearchText(pptx?.allText || '');
        for (const probe of ['时间，是', '最被低估的', '复利']) {
          if (!allText.includes(normalizeSearchText(probe))) failures.push(`theme10 poster PPTX is missing editable text: ${probe}`);
        }
      }
      if (sample.slide === 82 || sample.slide === 91) {
        const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
        const pptxFile = path.join(sampleDir, `${sample.label}.pptx`);
        const reportFile = path.join(sampleDir, `${sample.label}-report.json`);
        await mod.exportEditablePptxFromPage(page, {
          outFile: pptxFile,
          reportFile,
          title: `JAD-64 theme10 ${sample.label} regression`,
          slideIndexes: [sample.slide - 1],
        });
        const samplePptx = inspectPptx(pptxFile);
        addVisualEvidence(sample, sampleDir, pptxFile);
        const geoms = samplePptx.slides[0]?.shapeGeoms || [];
        const polygonGeomCount = geoms.filter(geom => ['custGeom', 'hexagon', 'trapezoid', 'nonIsoscelesTrapezoid'].includes(geom)).length;
        const expected = sample.slide === 82 ? 4 : 6;
        const passed = polygonGeomCount >= expected;
        polygonChecks.push({
          slide: sample.slide,
          key: sample.key,
          label: sample.label,
          pptxFile,
          reportFile,
          expectedPolygonShapes: expected,
          polygonGeomCount,
          shapeGeoms: geoms,
          passed,
        });
        if (!passed) {
          failures.push(`${sample.label} exported ${polygonGeomCount}/${expected} polygon shape geometries; clip-path polygons are still being flattened to rectangles.`);
        }
      }
      if (sample.slide === 76) {
        const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
        const pptxFile = path.join(sampleDir, `${sample.label}.pptx`);
        const reportFile = path.join(sampleDir, `${sample.label}-report.json`);
        const dom = await page.evaluate(() => {
          const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
          return [...slide?.querySelectorAll('.clg-frame') || []].map(frame => ({
            text: (frame.innerText || '').trim().replace(/\s+/g, ' '),
            transform: getComputedStyle(frame).transform,
            rect: (() => {
              const slideRect = slide.getBoundingClientRect();
              const rect = frame.getBoundingClientRect();
              return { x: rect.left - slideRect.left, y: rect.top - slideRect.top, w: rect.width, h: rect.height };
            })(),
          }));
        });
        await mod.exportEditablePptxFromPage(page, {
          outFile: pptxFile,
          reportFile,
          title: 'JAD-64 theme10 collage regression',
          slideIndexes: [sample.slide - 1],
        });
        const samplePptx = inspectPptx(pptxFile);
        addVisualEvidence(sample, sampleDir, pptxFile);
        const textBoxes = samplePptx.slides[0]?.textBoxes || [];
        const rotatedTextBoxes = textBoxes.filter(box => Math.abs(box.rotate || 0) >= 1);
        const expectedRotatedText = Math.max(8, dom.length * 2);
        const passed = rotatedTextBoxes.length >= expectedRotatedText;
        collageChecks.push({
          slide: sample.slide,
          key: sample.key,
          label: sample.label,
          pptxFile,
          reportFile,
          frameCount: dom.length,
          expectedRotatedText,
          rotatedTextCount: rotatedTextBoxes.length,
          sampleRotatedText: rotatedTextBoxes.slice(0, 8),
          passed,
        });
        if (!passed) {
          failures.push(`${sample.label} exported ${rotatedTextBoxes.length}/${expectedRotatedText} rotated collage text boxes; text inside rotated frames is not following parent rotation.`);
        }
      }
      if (sample.slide === 86) {
        const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
        const pptxFile = path.join(sampleDir, `${sample.label}.pptx`);
        const reportFile = path.join(sampleDir, `${sample.label}-report.json`);
        await mod.exportEditablePptxFromPage(page, {
          outFile: pptxFile,
          reportFile,
          title: 'JAD-64 theme10 venn regression',
          slideIndexes: [sample.slide - 1],
        });
        const samplePptx = inspectPptx(pptxFile);
        addVisualEvidence(sample, sampleDir, pptxFile);
        const details = samplePptx.slides[0]?.shapeDetails || [];
        const thinRectArtifacts = details.filter(shape => {
          if (shape.geom !== 'rect') return false;
          const minSide = Math.min(shape.w || 0, shape.h || 0);
          const maxSide = Math.max(shape.w || 0, shape.h || 0);
          return minSide > 0 && minSide <= 0.04 && maxSide >= 2.2;
        });
        const ellipseCount = details.filter(shape => shape.geom === 'ellipse').length;
        const passed = thinRectArtifacts.length === 0 && ellipseCount >= 3;
        vennChecks.push({
          slide: sample.slide,
          key: sample.key,
          label: sample.label,
          pptxFile,
          reportFile,
          ellipseCount,
          thinRectArtifacts,
          passed,
        });
        if (thinRectArtifacts.length) failures.push(`${sample.label} exported ${thinRectArtifacts.length} long thin rect border artifact(s) around Venn circles.`);
        if (ellipseCount < 3) failures.push(`${sample.label} exported ${ellipseCount}/3 ellipse circle geometries for the Venn discs.`);
      }
      if (sample.slide === 87) {
        const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
        const pptxFile = path.join(sampleDir, `${sample.label}.pptx`);
        const reportFile = path.join(sampleDir, `${sample.label}-report.json`);
        const dom = await page.evaluate(() => {
          const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
          const slideRect = slide?.getBoundingClientRect();
          const beam = slide?.querySelector('.bal-beam-bar');
          const pivot = slide?.querySelector('.bal-pivot');
          const local = el => {
            const rect = el?.getBoundingClientRect();
            if (!rect || !slideRect) return null;
            return {
              x: rect.left - slideRect.left,
              y: rect.top - slideRect.top,
              w: rect.width,
              h: rect.height,
              transform: getComputedStyle(el).transform,
              parentTransform: el.parentElement ? getComputedStyle(el.parentElement).transform : '',
            };
          };
          return { beam: local(beam), pivot: local(pivot) };
        });
        writeFileSync(path.join(sampleDir, 'balance-dom.json'), JSON.stringify(dom, null, 2) + '\n');
        await mod.exportEditablePptxFromPage(page, {
          outFile: pptxFile,
          reportFile,
          title: 'JAD-64 theme10 balance regression',
          slideIndexes: [sample.slide - 1],
        });
        const samplePptx = inspectPptx(pptxFile);
        addVisualEvidence(sample, sampleDir, pptxFile);
        const details = samplePptx.slides[0]?.shapeDetails || [];
        const pptRect = rect => rect ? ({
          x: rect.x / 1356 * 16,
          y: rect.y / 762.75 * 9,
          w: rect.w / 1356 * 16,
          h: rect.h / 762.75 * 9,
        }) : null;
        const expectedPivot = pptRect(dom.pivot);
        const rotatedBeam = details.find(shape => {
          const narrow = Math.min(shape.w || 0, shape.h || 0) <= 0.16 && Math.max(shape.w || 0, shape.h || 0) >= 4.5;
          return narrow && Math.abs(shape.rotate || 0) >= 4;
        });
        const trianglePivot = expectedPivot && details.find(shape => {
          if (!['custGeom', 'triangle', 'rtTriangle'].includes(shape.geom)) return false;
          return Math.abs(shape.x - expectedPivot.x) <= 0.08
            && Math.abs(shape.y - expectedPivot.y) <= 0.08
            && Math.abs(shape.w - expectedPivot.w) <= 0.08
            && Math.abs(shape.h - expectedPivot.h) <= 0.12;
        });
        const artifactRoundRects = details.filter(shape => {
          if (shape.geom !== 'roundRect') return false;
          const maxSide = Math.max(shape.w || 0, shape.h || 0);
          return maxSide > 0 && maxSide <= 0.26;
        });
        const passed = Boolean(rotatedBeam) && Boolean(trianglePivot) && artifactRoundRects.length === 0;
        balanceChecks.push({
          slide: sample.slide,
          key: sample.key,
          label: sample.label,
          pptxFile,
          reportFile,
          dom,
          expectedPivot,
          rotatedBeam: rotatedBeam || null,
          trianglePivot: trianglePivot || null,
          artifactRoundRects,
          passed,
        });
        if (!rotatedBeam) failures.push(`${sample.label} did not export the tilted balance beam as a rotated narrow PPT shape.`);
        if (!trianglePivot) failures.push(`${sample.label} did not export the balance pivot as a triangle/custom PPT shape at the DOM pivot position.`);
        if (artifactRoundRects.length) failures.push(`${sample.label} exported ${artifactRoundRects.length} tiny roundRect shape(s), which render as visible spike artifacts in PowerPoint/Quick Look.`);
      }
    }
  } finally {
    await closePage(page);
    await closeBrowser(browser);
  }

  const result = {
    mode: 'theme10-user-regressions',
    passed: failures.length === 0,
    outDir,
    rootCauseMatrix: path.join(outDir, 'root-cause-matrix.json'),
    poster: {
      dom: posterInfo,
      pptx: pptx ? summarizeInspection(pptx) : null,
      media,
    },
    polygonChecks,
    balanceChecks,
    collageChecks,
    vennChecks,
    visualChecks,
    samples,
    failures,
  };
  writeFileSync(path.join(outDir, 'theme10-user-regressions.json'), JSON.stringify(result, null, 2) + '\n');
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

async function runUiVisualMatrixValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --ui-visual-matrix --url <preview-url>');
  const themes = (getArg('--themes') || MATRIX_THEME_PACKS.join(','))
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const script = fileURLToPath(import.meta.url);
  const matrixDir = path.join(OUT_DIR, `matrix-${timestampForPath()}`);
  mkdirSync(matrixDir, { recursive: true });
  rmSync(path.join(OUT_DIR, 'ui-visual-matrix.json'), { force: true });
  rmSync(path.join(OUT_DIR, 'ui-visual-matrix.partial.json'), { force: true });
  writeFileSync(path.join(OUT_DIR, 'ui-visual-matrix.latest.txt'), `${matrixDir}\n`);
  const themeResults = [];
  for (const theme of themes) {
    const child = runVisualMatrixThemeChild(script, theme, matrixDir);
    themeResults.push(summarizeMatrixTheme(theme, child.parsed, child.status));
    writeFileSync(path.join(matrixDir, 'ui-visual-matrix.partial.json'), JSON.stringify({
      mode: 'ui-visual-matrix',
      url: cliUrl,
      matrixDir,
      samplesPerTheme: cliSamplesPerTheme,
      themes: themeResults,
    }, null, 2) + '\n');
  }

  const fallbackChild = spawnSync(process.execPath, [
    script,
    '--fallback-text-risk',
    '--url',
    cliUrl,
    '--theme-pack',
    'theme03',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 60 * 1024 * 1024,
    timeout: 5 * 60 * 1000,
    env: { ...process.env, EDITABLE_PPTX_VALIDATION_OUT_DIR: matrixDir, EDITABLE_PPTX_COMPACT_OUTPUT: '1' },
  });
  const fallbackParsed = parseJsonProcessOutput(fallbackChild.stdout, fallbackChild.stderr);
  const fallbackSummary = summarizeFallbackTextRisk(fallbackParsed, fallbackChild.status);
  const failures = [
    ...themeResults.filter(item => !item.passed).map(item => `${item.themePack} failed visual fidelity matrix checks.`),
    ...(fallbackSummary.passed ? [] : ['theme03 fallback text risk check reported text baked into local fallback images.']),
  ];
  const allThemesContactSheet = createMatrixContactSheet(themeResults, matrixDir);
  const result = {
    mode: 'ui-visual-matrix',
    url: cliUrl,
    matrixDir,
    matrixJson: path.join(matrixDir, 'ui-visual-matrix.json'),
    allThemesContactSheet,
    samplesPerTheme: cliSamplesPerTheme,
    passed: failures.length === 0,
    themes: themeResults,
    theme03FallbackTextRisk: fallbackSummary,
    failures,
  };
  writeFileSync(path.join(matrixDir, 'ui-visual-matrix.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(path.join(OUT_DIR, 'ui-visual-matrix.json'), JSON.stringify(result, null, 2) + '\n');
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

function runVisualMatrixThemeChild(script, theme, matrixDir) {
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const child = spawnSync(process.execPath, [
      script,
      '--ui-visual-fidelity',
      '--url',
      cliUrl,
      '--theme-pack',
      theme,
      '--samples-per-theme',
      String(cliSamplesPerTheme),
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 120 * 1024 * 1024,
      timeout: 10 * 60 * 1000,
      env: { ...process.env, EDITABLE_PPTX_VALIDATION_OUT_DIR: matrixDir, EDITABLE_PPTX_COMPACT_OUTPUT: '1' },
    });
    let parsed = parseJsonProcessOutput(child.stdout, child.stderr);
    if (parsed?.parseError && child.stderr?.trim().startsWith('{')) {
      try {
        parsed = JSON.parse(child.stderr.trim());
      } catch {}
    }
    if (!parsed?.parseError) {
      parsed.validationAttempts = attempt;
      return { parsed, status: child.status };
    }
    writeFileSync(path.join(matrixDir, `ui-visual-matrix-${theme}-raw-attempt-${attempt}.txt`), `${child.stdout || ''}\n${child.stderr || ''}`);
    last = { parsed, status: child.status };
  }
  writeFileSync(path.join(matrixDir, `ui-visual-matrix-${theme}-raw.txt`), last?.parsed?.raw || '');
  return last;
}

async function runUiVisualFidelityValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --ui-visual-fidelity --url <preview-url>');
  const url = cliUrl;
  const staticFailures = inspectUiExportPath();
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const visualDir = path.join(OUT_DIR, cliThemePack ? `ui-visual-fidelity-${safePathSegment(cliThemePack)}` : 'ui-visual-fidelity');
  rmSync(visualDir, { recursive: true, force: true });
  mkdirSync(visualDir, { recursive: true });

  let page;
  let expectedSlides = null;
  let expectations = [];
  let pptxFile = null;
  let reportFile = null;
  let htmlScreenshot = null;
  let sampleVisuals = [];
  let contactSheet = null;
  let context = null;
  try {
    context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}ui_visual=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    if (cliThemePack) {
      await page.evaluate(async themePack => {
        window.__setActiveThemePack?.(themePack, { navigate: true });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__finishEditablePptxAnimations?.(document);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }, cliThemePack);
    }
    expectedSlides = await page.evaluate(() => (window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')]).length);
    expectations = await collectUiVisualExpectations(page, expectedSlides);
    await closePage(page);
    await context.close().catch(() => {});
    context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}ui_visual_export=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    if (cliThemePack) {
      await page.evaluate(async themePack => {
        window.__setActiveThemePack?.(themePack, { navigate: true });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__finishEditablePptxAnimations?.(document);
        await new Promise(resolve => requestAnimationFrame(resolve));
      }, cliThemePack);
    }
    const exportSlides = await page.evaluate(() => (window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')]).length);
    if (exportSlides !== expectedSlides) {
      throw new Error(`Visual fidelity export page has ${exportSlides} visible slides; expected ${expectedSlides}.`);
    }
    htmlScreenshot = path.join(visualDir, 'html-slide-001.png');
    await page.evaluate(async () => {
      window.go?.(0, { animate: false, force: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__finishEditablePptxAnimations?.(document);
      await new Promise(resolve => requestAnimationFrame(resolve));
    });
    const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!activeSlide) throw new Error('Could not capture active slide screenshot.');
    await activeSlide.screenshot({ path: htmlScreenshot });

    await page.click('#preview-export-main');
    const exportResponsePromise = waitForEditablePptxExportResponse(page, 240000);
    await page.click('#preview-export-pptx');
    const result = await exportResponsePromise;
    pptxFile = result.filePath;
    reportFile = result.reportPath;
    sampleVisuals = await collectSampleVisualComparisons(page, expectations, visualDir);
    contactSheet = createSampleContactSheet(sampleVisuals, visualDir);
  } finally {
    await closePage(page);
    await context?.close().catch(() => {});
    await closeBrowser(browser);
  }

  if (!pptxFile) throw new Error('UI export did not return a saved PPTX path.');
  const pptx = inspectPptx(pptxFile);
  const report = reportFile && existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, visualDir);
  const failures = [
    ...staticFailures,
    ...validateEditablePptxInspection(pptx, { expectSlides: expectedSlides }),
    ...validateVisualFidelityReport({ report, pptx, expectations, expectedSlides, visual }),
    ...validateSampleVisuals(sampleVisuals),
  ];
  const result = {
    mode: 'ui-visual-fidelity',
    url,
    themePack: cliThemePack || null,
    expectedSlides,
    passed: failures.length === 0,
    pptx: summarizeInspection(pptx),
    report: report ? summarizeVisualReport(report) : null,
    htmlScreenshot,
    quickLook: visual,
    contactSheet,
    samples: sampleVisuals,
    sampleExpectations: expectations.filter(item => item.svgElements || item.canvasElements || item.backgroundImageElements).slice(0, 8),
    failures,
  };
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

async function runUiExportValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --ui-export --url <preview-url>');
  const url = cliUrl;
  const staticFailures = inspectUiExportPath();
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let page;
  let mutation = null;
  let expectedSlides = null;
  let pptxFile = null;
  let downloadedFile = null;
  let suggestedFilename = null;
  let downloadHeaders = null;
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}ui_export=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    expectedSlides = await page.evaluate(() => (window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')]).length);
    mutation = await applyUserEdits(page);
    await page.click('#preview-export-main');
    const exportResponsePromise = waitForEditablePptxExportResponse(page, 240000);
    const downloadPromise = page.waitForEvent('download', { timeout: 240000 })
      .then(download => ({ download }))
      .catch(error => ({ error: error.message || String(error) }));
    await page.click('#preview-export-pptx');
    const result = await exportResponsePromise;
    pptxFile = result.filePath;
    if (result.downloadUrl) {
      downloadHeaders = await readDownloadHeaders(new URL(result.downloadUrl, url).href);
    }
    const downloadResult = await Promise.race([
      downloadPromise,
      new Promise(resolve => setTimeout(() => resolve({ error: 'download-event-timeout-after-export' }), 10000)),
    ]);
    if (downloadResult.download) {
      suggestedFilename = downloadResult.download.suggestedFilename();
      downloadedFile = path.join(OUT_DIR, 'ui-export-download.pptx');
      await downloadResult.download.saveAs(downloadedFile);
    }
  } finally {
    await closePage(page);
    await closeBrowser(browser);
  }

  if (!pptxFile) throw new Error('UI export did not return a saved PPTX path.');
  const pptx = inspectPptx(downloadedFile || pptxFile);
  const failures = [
    ...staticFailures,
    ...(downloadedFile ? validateDownloadedPptx(downloadedFile, suggestedFilename) : ['UI export did not trigger a browser download after the server saved the PPTX.']),
    ...validateDownloadHeaders(downloadHeaders),
    ...validateEditablePptxInspection(pptx, {
      expectSlides: expectedSlides,
      mutation,
      requireEditedText: true,
      requireReplacementImage: true,
    }),
  ];
  const result = {
    mode: 'ui-export',
    url,
    expectedSlides,
    suggestedFilename,
    downloadHeaders,
    serverFile: pptxFile,
    passed: failures.length === 0,
    pptx: summarizeInspection(pptx),
    failures,
  };
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

async function runUiExportProgressValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --ui-export-progress --url <preview-url>');
  const url = cliUrl;
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let page;
  let result = null;
  let downloadedFile = null;
  let suggestedFilename = null;
  const observations = [];
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(120000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}ui_export_progress=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await page.click('#preview-export-main');

    const requestPromise = page.waitForRequest(req =>
      req.method() === 'POST' && new URL(req.url()).pathname === '/api/export-editable-pptx',
      { timeout: 120000 },
    );
    const responsePromise = waitForEditablePptxExportResponse(page, 300000);
    let responseDone = false;
    const trackedResponsePromise = responsePromise.finally(() => { responseDone = true; });
    const downloadPromise = page.waitForEvent('download', { timeout: 300000 })
      .then(download => ({ download }))
      .catch(error => ({ error: error.message || String(error) }));
    await page.click('#preview-export-pptx');
    await requestPromise;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 6000 && !responseDone) {
      const text = await page.locator('.deck-export-detail').textContent().catch(() => '');
      observations.push({
        elapsedMs: Date.now() - startedAt,
        text,
        percent: parseProgressPercent(text),
      });
      await new Promise(resolve => setTimeout(resolve, 300));
    }
    result = await trackedResponsePromise;
    const downloadResult = await Promise.race([
      downloadPromise,
      new Promise(resolve => setTimeout(() => resolve({ error: 'download-event-timeout-after-export' }), 10000)),
    ]);
    if (downloadResult.download) {
      suggestedFilename = downloadResult.download.suggestedFilename();
      downloadedFile = path.join(OUT_DIR, 'ui-export-progress-download.pptx');
      await downloadResult.download.saveAs(downloadedFile);
    }
  } finally {
    await closePage(page);
    await closeBrowser(browser);
  }

  const maxPercent = Math.max(0, ...observations.map(item => Number(item.percent || 0)));
  const distinctDetails = new Set(observations.map(item => String(item.text || '').replace(/\s*·\s*\d+%\s*$/, '').trim()).filter(Boolean));
  const windowMs = observations.length ? observations.at(-1).elapsedMs - observations[0].elapsedMs : 0;
  const failures = [];
  if (!observations.length) failures.push('UI progress validation did not observe the editable PPTX generation phase.');
  if (windowMs >= 2500 && maxPercent <= 0) {
    failures.push(`Editable PPTX UI stayed at 0% for ${windowMs}ms after the server export request started.`);
  }
  if (windowMs >= 2500 && distinctDetails.size <= 1 && maxPercent <= 0) {
    failures.push('Editable PPTX UI did not show any server generation stage progress while waiting for the long export request.');
  }
  if (!downloadedFile) failures.push('UI progress export did not complete with a browser download.');
  const resultSummary = {
    mode: 'ui-export-progress',
    url,
    passed: failures.length === 0,
    serverFile: result?.filePath || null,
    downloadedFile,
    suggestedFilename,
    maxPercent,
    observedWindowMs: windowMs,
    distinctDetails: [...distinctDetails],
    observations,
    failures,
  };
  if (failures.length) {
    console.error(JSON.stringify(resultSummary, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(resultSummary, null, 2));
  process.exit(0);
}

async function runUiExportCodexBrowserGuardValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --ui-export-codex-browser-guard --url <preview-url>');
  const url = cliUrl;
  const expectedMessage = 'codex 自带浏览器不支持导出，需要复制地址到浏览器再进行操作';
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let codexResult = null;
  let normalResult = null;
  try {
    codexResult = await runCodexBrowserGuardScenario(browser, url, {
      userAgent: 'Mozilla/5.0 CodexBrowser/1.0',
      expectedMessage,
    });
    normalResult = await runCodexBrowserGuardScenario(browser, url, {
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
      expectedMessage,
    });
  } finally {
    await closeBrowser(browser);
  }
  const failures = [];
  if (codexResult.dialogMessage !== expectedMessage) {
    failures.push(`Codex browser guard did not show the required alert. Got: ${codexResult.dialogMessage || 'none'}.`);
  }
  if (codexResult.exportRequestSeen) failures.push('Codex browser guard still entered the editable PPTX export request path.');
  if (!normalResult.exportRequestSeen) failures.push('Normal browser path did not enter the editable PPTX export request path.');
  if (normalResult.dialogMessage === expectedMessage) failures.push('Normal browser path was incorrectly blocked by the Codex browser guard.');
  const result = {
    mode: 'ui-export-codex-browser-guard',
    url,
    passed: failures.length === 0,
    codexResult,
    normalResult,
    failures,
  };
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

async function runCodexBrowserGuardScenario(browser, url, { userAgent, expectedMessage }) {
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1920, height: 1080 },
    ignoreHTTPSErrors: true,
    userAgent,
  });
  let page;
  const result = {
    userAgent,
    dialogMessage: null,
    blockedMessage: null,
    exportRequestSeen: false,
  };
  try {
    page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.on('dialog', async dialog => {
      result.dialogMessage = dialog.message();
      await dialog.dismiss().catch(() => {});
    });
    await page.route('**/api/export-editable-pptx', async route => {
      result.exportRequestSeen = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          filePath: '/tmp/codex-browser-guard-test.pptx',
          relativePath: 'codex-browser-guard-test.pptx',
          downloadUrl: '/api/export-editable-pptx-download?file=codex-browser-guard-test.pptx',
          downloadName: 'codex-browser-guard-test.pptx',
        }),
      });
    });
    await page.route('**/api/export-editable-pptx-progress**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ stage: 'test', detail: 'test', percent: 50 }),
      });
    });
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}codex_browser_guard=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await page.click('#preview-export-main');
    await page.click('#preview-export-pptx');
    await page.waitForFunction(
      message => window.__lastPptxExportResult || window.__codexExportBlockedMessage === message,
      expectedMessage,
      { timeout: 45000 },
    ).catch(() => {});
    await page.waitForTimeout(500);
    result.blockedMessage = await page.evaluate(() => window.__codexExportBlockedMessage || null).catch(() => null);
  } finally {
    await closePage(page);
    await context.close().catch(() => {});
  }
  return result;
}

function parseProgressPercent(text) {
  const match = String(text || '').match(/(\d+)\s*%/);
  return match ? Number(match[1]) : 0;
}

async function waitForEditablePptxExportResponse(page, timeout) {
  const response = await page.waitForResponse(resp =>
    resp.request().method() === 'POST' && new URL(resp.url()).pathname === '/api/export-editable-pptx',
  { timeout });
  const result = await response.json();
  if (!response.ok() || !result?.filePath) {
    throw new Error(result?.error || `Editable PPTX export endpoint failed (${response.status()})`);
  }
  return result;
}

async function runFallbackTextRiskMatrixValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --fallback-text-risk-matrix --url <preview-url>');
  const themes = (getArg('--themes') || FALLBACK_TEXT_RISK_THEME_PACKS.join(','))
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  const script = fileURLToPath(import.meta.url);
  const matrixDir = path.join(OUT_DIR, `fallback-text-risk-matrix-${timestampForPath()}`);
  mkdirSync(matrixDir, { recursive: true });
  const themeResults = [];
  for (const theme of themes) {
    const child = runFallbackTextRiskThemeChild(script, theme, matrixDir);
    const parsed = child.parsed;
    themeResults.push({
      themePack: theme,
      passed: child.status === 0 && parsed?.passed === true,
      status: child.status,
      expectedSlides: parsed?.expectedSlides || null,
      selectedRiskCount: parsed?.selectedRiskCount || 0,
      expectedRiskCount: parsed?.expectedRiskCount || 0,
      extractedCount: parsed?.extractedCount || 0,
      overlayExtractedCount: parsed?.overlayExtractedCount || 0,
      riskCount: parsed?.riskCount || 0,
      evidenceDir: parsed?.evidenceDir || null,
      reportFile: parsed?.reportFile || null,
      pptxFile: parsed?.pptxFile || null,
      failures: parsed?.failures || (parsed?.parseError ? ['fallback text risk child JSON parse failed'] : child.status === 0 ? [] : ['fallback text risk child validation failed']),
    });
    writeFileSync(path.join(matrixDir, 'fallback-text-risk-matrix.partial.json'), JSON.stringify({
      mode: 'fallback-text-risk-matrix',
      url: cliUrl,
      matrixDir,
      themes: themeResults,
    }, null, 2) + '\n');
  }
  const failures = themeResults.flatMap(theme => theme.passed ? [] : theme.failures.map(failure => `${theme.themePack}: ${failure}`));
  const result = {
    mode: 'fallback-text-risk-matrix',
    url: cliUrl,
    matrixDir,
    samplesPerTheme: cliSamplesPerTheme,
    passed: failures.length === 0,
    themes: themeResults,
    failures,
  };
  writeFileSync(path.join(matrixDir, 'fallback-text-risk-matrix.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(path.join(OUT_DIR, 'fallback-text-risk-matrix.json'), JSON.stringify(result, null, 2) + '\n');
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

function runFallbackTextRiskThemeChild(script, theme, matrixDir) {
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const child = spawnSync(process.execPath, [
      script,
      '--fallback-text-risk',
      '--url',
      cliUrl,
      '--theme-pack',
      theme,
      '--samples-per-theme',
      String(cliSamplesPerTheme),
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 120 * 1024 * 1024,
      timeout: 12 * 60 * 1000,
      env: { ...process.env, EDITABLE_PPTX_VALIDATION_OUT_DIR: matrixDir, EDITABLE_PPTX_COMPACT_OUTPUT: '1' },
    });
    const parsed = parseJsonProcessOutput(child.stdout, child.stderr);
    if (!parsed?.parseError) {
      parsed.validationAttempts = attempt;
      return { parsed, status: child.status };
    }
    writeFileSync(path.join(matrixDir, `fallback-text-risk-${theme}-raw-attempt-${attempt}.txt`), `${child.stdout || ''}\n${child.stderr || ''}`);
    last = { parsed, status: child.status };
  }
  return last;
}

async function runFallbackTextRiskValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --fallback-text-risk --url <preview-url> --theme-pack <theme>');
  const themePack = cliThemePack || 'theme03';
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let page;
  let pptxFile = null;
  let reportFile = null;
  let expectedSlides = null;
  let expectedRisks = [];
  let selectedRisks = [];
  let evidenceChecks = [];
  let evidenceDir = null;
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`${cliUrl}${cliUrl.includes('?') ? '&' : '?'}fallback_text_risk=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    await installValidationHelpers(page);
    await page.evaluate(async theme => {
      window.__setActiveThemePack?.(theme, { navigate: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__finishEditablePptxAnimations?.(document);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, themePack);
    expectedSlides = await page.evaluate(() => (window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')]).length);
    expectedRisks = await collectFallbackTextRiskExpectations(page, expectedSlides);
    const outDir = path.join(OUT_DIR, `fallback-text-risk-${safePathSegment(themePack)}`);
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(outDir, { recursive: true });
    evidenceDir = path.join(outDir, 'evidence');
    selectedRisks = selectFallbackTextRiskSamples(expectedRisks, cliSamplesPerTheme);
    evidenceChecks = await captureFallbackTextRiskEvidence(page, selectedRisks, evidenceDir);
    if (expectedRisks.length) {
      const slideIndexes = [...new Set(selectedRisks.map(item => item.slide - 1))]
        .filter(index => Number.isInteger(index) && index >= 0)
        .slice(0, cliSamplesPerTheme);
      const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
      pptxFile = path.join(outDir, `${themePack}.pptx`);
      reportFile = path.join(outDir, `${themePack}.json`);
      await mod.exportEditablePptxFromPage(page, {
        outFile: pptxFile,
        reportFile,
        title: `JAD-64 ${themePack} fallback text risk`,
        slideIndexes,
      });
    }
  } finally {
    await closePage(page);
    await closeBrowser(browser);
  }
  const report = reportFile && existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  const pptx = pptxFile && existsSync(pptxFile) ? inspectPptx(pptxFile) : null;
  const risks = (report?.warnings || []).filter(warning => warning?.type === 'node-image-fallback-text-risk');
  const extracted = (report?.warnings || []).filter(warning => warning?.type === 'node-image-fallback-text-extracted');
  const overlayExtracted = (report?.warnings || []).filter(warning => warning?.type === 'node-image-fallback-overlay-extracted');
  const missingClassifications = selectedRisks.filter(risk => !fallbackRiskWasClassified(risk, [...risks, ...extracted, ...overlayExtracted]));
  const missingTextObjects = pptx ? missingFallbackTextObjects(selectedRisks, pptx) : [];
  const failures = [];
  if (expectedRisks.length && !report) failures.push('Fallback text risk validation did not write a report file.');
  if (expectedRisks.length && !pptx) failures.push('Fallback text risk validation did not write a PPTX file.');
  if (expectedRisks.length && !risks.length && !extracted.length) {
    failures.push(`${themePack} has ${expectedRisks.length} DOM fallback text candidate(s), but export report did not classify them as extracted or risky.`);
  }
  if (missingClassifications.length) {
    failures.push(`${themePack} has ${missingClassifications.length} selected fallback text candidate(s) that were not classified by the export report.`);
  }
  if (missingTextObjects.length) {
    failures.push(`${themePack} has ${missingTextObjects.length} selected fallback text candidate(s) missing corresponding PPT text object probes.`);
  }
  const failedEvidenceChecks = evidenceChecks.filter(check => check.checked && !check.passed);
  if (failedEvidenceChecks.length) {
    failures.push(`${themePack} has ${failedEvidenceChecks.length} fallback evidence crop(s) that did not change after hiding overlay paint.`);
  }
  if (risks.length) failures.push(`${themePack} has ${risks.length} local fallback image(s) that include visible fallback text.`);
  const result = {
    mode: 'fallback-text-risk',
    themePack,
    expectedSlides,
    passed: failures.length === 0,
    pptxFile,
    reportFile,
    evidenceDir,
    riskCount: risks.length,
    extractedCount: extracted.length,
    overlayExtractedCount: overlayExtracted.length,
    expectedRiskCount: expectedRisks.length,
    selectedRiskCount: selectedRisks.length,
    expectedRisks: expectedRisks.slice(0, 40),
    selectedRisks,
    missingClassifications,
    missingTextObjects,
    evidenceChecks,
    pptx: pptx ? summarizeInspection(pptx) : null,
    extracted: extracted.slice(0, 40),
    overlayExtracted: overlayExtracted.slice(0, 40),
    risks: risks.slice(0, 40),
    failures,
  };
  const printableResult = process.env.EDITABLE_PPTX_COMPACT_OUTPUT ? compactFallbackTextRiskResult(result) : result;
  if (failures.length) {
    console.error(JSON.stringify(printableResult, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(printableResult, null, 2));
  process.exit(0);
}

function compactFallbackTextRiskResult(result) {
  return {
    mode: result.mode,
    themePack: result.themePack,
    expectedSlides: result.expectedSlides,
    passed: result.passed,
    pptxFile: result.pptxFile,
    reportFile: result.reportFile,
    evidenceDir: result.evidenceDir,
    riskCount: result.riskCount,
    extractedCount: result.extractedCount,
    overlayExtractedCount: result.overlayExtractedCount,
    expectedRiskCount: result.expectedRiskCount,
    selectedRiskCount: result.selectedRiskCount,
    missingClassifications: (result.missingClassifications || []).map(compactFallbackRisk),
    missingTextObjects: result.missingTextObjects || [],
    evidenceChecks: (result.evidenceChecks || []).map(check => ({
      slide: check.slide,
      kind: check.kind,
      checked: check.checked,
      passed: check.passed,
      minRmse: check.minRmse,
      failures: check.failures,
    })),
    pptx: result.pptx,
    extracted: (result.extracted || []).slice(0, 12),
    overlayExtracted: (result.overlayExtracted || []).slice(0, 12),
    risks: (result.risks || []).slice(0, 12),
    failures: result.failures || [],
  };
}

function compactFallbackRisk(risk) {
  return {
    slide: risk.slide,
    key: risk.key,
    kind: risk.kind,
    textCount: risk.textCount,
    overlayCount: risk.overlayItems?.length || 0,
    sample: risk.sample,
  };
}

async function collectUiVisualExpectations(page, expectedSlides) {
  const expectations = [];
  for (let i = 0; i < expectedSlides; i += 1) {
    expectations.push(await page.evaluate(async (index) => {
      window.go?.(index, { animate: false, force: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__finishEditablePptxAnimations?.(document);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
      if (!slide) return { index: index + 1, missing: true };
      const slideRect = slide.getBoundingClientRect();
      const all = [slide, ...slide.querySelectorAll('*')];
      const metrics = {
        index: index + 1,
        key: slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '',
        elementCount: 0,
        textNodeRects: 0,
        backgroundColorElements: 0,
        backgroundImageElements: 0,
        backgroundUrlElements: 0,
        gradientElements: 0,
        borderElements: 0,
        radiusElements: 0,
        shadowElements: 0,
        svgElements: 0,
        canvasElements: 0,
        unicornFrameElements: 0,
        unicornCanvasElements: 0,
        imageElements: 0,
        maxDepth: 0,
      };

      const isVisible = (el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1
          && rect.right >= slideRect.left && rect.left <= slideRect.right
          && rect.bottom >= slideRect.top && rect.top <= slideRect.bottom;
      };
      const depthOf = (el) => {
        let depth = 0;
        for (let node = el; node && node !== slide; node = node.parentElement) depth += 1;
        return depth;
      };
      const hasPaint = (color) => {
        const raw = String(color || '').trim();
        return raw && raw !== 'transparent' && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(raw);
      };
      const walkText = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) {
            if (child.parentElement && !isVisible(child.parentElement)) continue;
            const text = (child.textContent || '').trim().replace(/\s+/g, ' ');
            if (!text) continue;
            const range = document.createRange();
            range.selectNodeContents(child);
            const rect = range.getBoundingClientRect();
            range.detach?.();
            if (rect.width > 1 && rect.height > 1
                && rect.right >= slideRect.left && rect.left <= slideRect.right
                && rect.bottom >= slideRect.top && rect.top <= slideRect.bottom) metrics.textNodeRects += 1;
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            if (isVisible(child)) walkText(child);
          }
        }
      };

      for (const el of all) {
        if (!isVisible(el)) continue;
        metrics.elementCount += 1;
        metrics.maxDepth = Math.max(metrics.maxDepth, depthOf(el));
        const tag = el.tagName.toLowerCase();
        const style = getComputedStyle(el);
        if (hasPaint(style.backgroundColor)) metrics.backgroundColorElements += 1;
        if (style.backgroundImage && style.backgroundImage !== 'none') {
          metrics.backgroundImageElements += 1;
          if (/url\(/.test(style.backgroundImage)) metrics.backgroundUrlElements += 1;
          if (/gradient\(/.test(style.backgroundImage)) metrics.gradientElements += 1;
        }
        if (['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(style[`border${side}Width`] || '0') > 0 && hasPaint(style[`border${side}Color`]))) {
          metrics.borderElements += 1;
        }
        if (['TopLeft', 'TopRight', 'BottomRight', 'BottomLeft'].some(corner => parseFloat(style[`border${corner}Radius`] || '0') > 0)) {
          metrics.radiusElements += 1;
        }
        if (style.boxShadow && style.boxShadow !== 'none') metrics.shadowElements += 1;
        if (tag === 'svg') metrics.svgElements += 1;
        if (el.classList.contains('bt-unicorn-frame')) metrics.unicornFrameElements += 1;
        if (tag === 'canvas') {
          if (el.closest('.bt-unicorn-frame')) metrics.unicornCanvasElements += 1;
          else metrics.canvasElements += 1;
        }
        if (tag === 'img') metrics.imageElements += 1;
      }
      walkText(slide);
      return metrics;
    }, i));
  }
  return expectations;
}

async function installValidationHelpers(page) {
  await page.addScriptTag({
    content: `
      window.__finishEditablePptxAnimations = function(scope) {
        const root = scope || document;
        try {
          for (const animation of document.getAnimations({ subtree: true })) {
            const target = animation.effect?.target;
            if (root !== document && target instanceof Node && !root.contains(target)) continue;
            try {
              animation.updatePlaybackRate?.(1);
              animation.finish();
            } catch {
              try {
                animation.currentTime = animation.effect?.getTiming?.().duration || 999999;
                animation.pause();
              } catch {}
            }
          }
        } catch {}
      };
    `,
  });
}

async function navigateValidationSample(page, sample) {
  return await page.evaluate(async ({ themePack, key }) => {
    window.__setActiveThemePack?.(themePack, { navigate: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__finishEditablePptxAnimations?.(document);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const slides = window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')];
    const availableKeys = slides.map(slide => slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '');
    const index = availableKeys.findIndex(item => item === key || item.startsWith(`${key}-`));
    if (index < 0) return { found: false, index: -1, availableKeys };
    window.go?.(index, { animate: false, force: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__finishEditablePptxAnimations?.(document);
    await new Promise(resolve => requestAnimationFrame(resolve));
    return { found: true, index, availableKeys };
  }, sample);
}

async function collectJad64RootCauseDomProbe(page, sample) {
  return await page.evaluate(({ textProbes }) => {
    const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!slide) return { key: '', slide: null, materialRegions: [], svgRegions: [], textAnchors: [], text: '' };
    const slideRect = slide.getBoundingClientRect();
    const localRect = rect => ({
      x: Math.max(0, rect.left - slideRect.left),
      y: Math.max(0, rect.top - slideRect.top),
      w: Math.max(1, Math.min(rect.right, slideRect.right) - Math.max(rect.left, slideRect.left)),
      h: Math.max(1, Math.min(rect.bottom, slideRect.bottom) - Math.max(rect.top, slideRect.top)),
    });
    const normalize = value => String(value || '').replace(/[^\p{L}\p{N}%+]+/gu, '').toLowerCase();
    const isVisible = (el, style = getComputedStyle(el)) => {
      if (!el || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2
        && rect.right >= slideRect.left && rect.left <= slideRect.right
        && rect.bottom >= slideRect.top && rect.top <= slideRect.bottom;
    };
    const colorVisible = value => {
      const raw = String(value || '').trim();
      return raw && raw !== 'transparent' && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(raw);
    };
    const radiusPx = style => Math.max(
      parseFloat(style.borderTopLeftRadius || '0') || 0,
      parseFloat(style.borderTopRightRadius || '0') || 0,
      parseFloat(style.borderBottomRightRadius || '0') || 0,
      parseFloat(style.borderBottomLeftRadius || '0') || 0,
    );
    const borderVisible = style => ['Top', 'Right', 'Bottom', 'Left'].some(side => {
      const width = parseFloat(style[`border${side}Width`] || '0') || 0;
      return width > 0 && colorVisible(style[`border${side}Color`]);
    });
    const hasMaterialPaint = style => {
      const bg = String(style.backgroundImage || '');
      return bg.includes('gradient')
        || bg.includes('url(')
        || (style.boxShadow && style.boxShadow !== 'none')
        || (style.filter && style.filter !== 'none')
        || (style.mixBlendMode && style.mixBlendMode !== 'normal')
        || (radiusPx(style) >= 10 && (colorVisible(style.backgroundColor) || borderVisible(style)));
    };
    const textAnchors = (textProbes || []).map(probe => {
      const target = normalize(probe);
      const matches = [];
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!target || !normalize(node.textContent).includes(target)) continue;
        const parent = node.parentElement;
        if (!isVisible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = range.getBoundingClientRect();
        range.detach?.();
        if (rect.width > 1 && rect.height > 1) matches.push({ text: node.textContent || '', rect: localRect(rect) });
      }
      return { probe, found: matches.length > 0, matches: matches.slice(0, 8) };
    });
    const probeSet = new Set((textProbes || []).map(normalize).filter(Boolean));
    const materialRegions = [...slide.querySelectorAll('*')]
      .map(el => {
        const style = getComputedStyle(el);
        if (!isVisible(el, style) || !hasMaterialPaint(style)) return null;
        const rect = el.getBoundingClientRect();
        const areaRatio = (rect.width * rect.height) / Math.max(1, slideRect.width * slideRect.height);
        if (areaRatio > 0.68 || areaRatio < 0.0002) return null;
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        const normalizedText = normalize(text);
        const probeHit = [...probeSet].some(probe => normalizedText.includes(probe));
        const bg = String(style.backgroundImage || '');
        const score = (probeHit ? 10000 : 0)
          + (bg.includes('gradient') ? 360 : 0)
          + ((style.boxShadow && style.boxShadow !== 'none') ? 420 : 0)
          + ((style.filter && style.filter !== 'none') ? 320 : 0)
          + (radiusPx(style) >= 10 ? 260 : 0)
          + Math.min(260, Math.sqrt(rect.width * rect.height) / 2)
          - (areaRatio > 0.35 ? 2500 : 0);
        return {
          tag: el.tagName.toLowerCase(),
          className: String(el.className || '').slice(0, 160),
          text: text.slice(0, 160),
          rect: localRect(rect),
          score,
          probeHit,
          style: {
            backgroundColor: style.backgroundColor,
            backgroundImage: bg.slice(0, 220),
            boxShadow: String(style.boxShadow || '').slice(0, 220),
            filter: String(style.filter || '').slice(0, 120),
            mixBlendMode: style.mixBlendMode,
            borderRadius: [
              style.borderTopLeftRadius,
              style.borderTopRightRadius,
              style.borderBottomRightRadius,
              style.borderBottomLeftRadius,
            ],
          },
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 24);
    const svgRegions = [...slide.querySelectorAll('svg')]
      .map(el => {
        if (!isVisible(el)) return null;
        const rect = el.getBoundingClientRect();
        const union = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
        const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
        for (const child of el.querySelectorAll('*')) {
          const childStyle = getComputedStyle(child);
          if (childStyle.display === 'none' || childStyle.visibility === 'hidden' || Number(childStyle.opacity || 1) <= 0.01) continue;
          const childRect = child.getBoundingClientRect();
          if (childRect.width <= 0.5 || childRect.height <= 0.5) continue;
          union.left = Math.min(union.left, childRect.left);
          union.top = Math.min(union.top, childRect.top);
          union.right = Math.max(union.right, childRect.right);
          union.bottom = Math.max(union.bottom, childRect.bottom);
        }
        const visualRect = localRect({
          left: Math.max(slideRect.left, union.left),
          top: Math.max(slideRect.top, union.top),
          right: Math.min(slideRect.right, union.right),
          bottom: Math.min(slideRect.bottom, union.bottom),
        });
        const box = localRect(rect);
        const normalizedText = normalize(text);
        const probeHit = [...probeSet].some(probe => normalizedText.includes(probe));
        const overflow = {
          left: Math.max(0, rect.left - union.left),
          top: Math.max(0, rect.top - union.top),
          right: Math.max(0, union.right - rect.right),
          bottom: Math.max(0, union.bottom - rect.bottom),
        };
        return {
          tag: 'svg',
          className: String(el.className?.baseVal || el.getAttribute('class') || '').slice(0, 160),
          text: text.slice(0, 240),
          rect: box,
          visualRect,
          overflow,
          probeHit,
          viewBox: el.getAttribute('viewBox') || '',
          preserveAspectRatio: el.getAttribute('preserveAspectRatio') || '',
          score: (probeHit ? 10000 : 0) + box.w * box.h / 1000 + text.length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score);
    return {
      key: slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '',
      slide: { w: slideRect.width, h: slideRect.height },
      text: (slide.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 1200),
      textAnchors,
      materialRegions,
      svgRegions,
    };
  }, sample);
}

async function collectJad64FollowupDomProbe(page) {
  return await page.evaluate(() => {
    const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!slide) return { key: '', rounded: [], pseudoTriangles: [], inlineHighlights: [], text: '' };
    const slideRect = slide.getBoundingClientRect();
    const localRect = rect => ({
      x: rect.left - slideRect.left,
      y: rect.top - slideRect.top,
      w: rect.width,
      h: rect.height,
    });
    const isVisible = (el, style = getComputedStyle(el)) => {
      if (!el || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1
        && rect.right >= slideRect.left && rect.left <= slideRect.right
        && rect.bottom >= slideRect.top && rect.top <= slideRect.bottom;
    };
    const colorVisible = value => {
      const raw = String(value || '').trim();
      return raw && raw !== 'transparent' && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(raw);
    };
    const borderWidths = style => ['Top', 'Right', 'Bottom', 'Left'].map(side => parseFloat(style[`border${side}Width`] || '0') || 0);
    const borderColors = style => ['Top', 'Right', 'Bottom', 'Left'].map(side => style[`border${side}Color`] || '');
    const isUniformBorder = style => {
      const widths = borderWidths(style);
      const colors = borderColors(style);
      return widths.every(width => width > 0)
        && Math.max(...widths) - Math.min(...widths) < 0.3
        && colors.every(color => color === colors[0]);
    };
    const rounded = [...slide.querySelectorAll('*')]
      .filter(el => {
        const style = getComputedStyle(el);
        const radii = [
          parseFloat(style.borderTopLeftRadius || '0') || 0,
          parseFloat(style.borderTopRightRadius || '0') || 0,
          parseFloat(style.borderBottomRightRadius || '0') || 0,
          parseFloat(style.borderBottomLeftRadius || '0') || 0,
        ];
        return isVisible(el, style) && Math.max(...radii) >= 8 && isUniformBorder(style);
      })
      .slice(0, 24)
      .map(el => {
        const style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ''),
          rect: localRect(el.getBoundingClientRect()),
          radius: Math.max(
            parseFloat(style.borderTopLeftRadius || '0') || 0,
            parseFloat(style.borderTopRightRadius || '0') || 0,
            parseFloat(style.borderBottomRightRadius || '0') || 0,
            parseFloat(style.borderBottomLeftRadius || '0') || 0,
          ),
          borderWidths: borderWidths(style),
          borderColors: borderColors(style),
        };
      });
    const pseudoTriangles = [];
    for (const el of slide.querySelectorAll('*')) {
      if (!isVisible(el)) continue;
      for (const pseudo of ['::before', '::after']) {
        const style = getComputedStyle(el, pseudo);
        const widths = borderWidths(style);
        const colors = borderColors(style);
        const visibleBorders = colors.filter(colorVisible).length;
        const rawPosition = [style.left, style.top, style.right, style.bottom, style.transform].join(' ');
        const hasTriangle = widths.filter(width => width > 0).length >= 3 && visibleBorders === 1;
        if (!hasTriangle) continue;
        pseudoTriangles.push({
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ''),
          pseudo,
          parentRect: localRect(el.getBoundingClientRect()),
          width: style.width,
          height: style.height,
          left: style.left,
          top: style.top,
          right: style.right,
          bottom: style.bottom,
          transform: style.transform,
          hasPercentOffset: rawPosition.includes('%'),
          borderWidths: widths,
          borderColors: colors,
        });
      }
    }
    const inlineHighlights = [...slide.querySelectorAll('span,b,strong,em')]
      .filter(el => {
        const style = getComputedStyle(el);
        const bg = style.backgroundImage || '';
        return isVisible(el, style)
          && ((bg && bg !== 'none') || colorVisible(style.backgroundColor))
          && (el.textContent || '').trim().length >= 2;
      })
      .slice(0, 24)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        className: String(el.className || ''),
        text: (el.textContent || '').trim().replace(/\s+/g, ' '),
        rect: localRect(el.getBoundingClientRect()),
        backgroundImage: getComputedStyle(el).backgroundImage,
        backgroundColor: getComputedStyle(el).backgroundColor,
        transform: getComputedStyle(el).transform,
      }));
    return {
      key: slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '',
      text: (slide.innerText || '').trim().replace(/\s+/g, ' '),
      rounded,
      pseudoTriangles,
      inlineHighlights,
    };
  });
}

async function collectJad64AcceptanceDomProbe(page, sample) {
  return await page.evaluate(({ textProbes }) => {
    const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!slide) return { key: '', text: '', slide: null, textAnchors: [], rounded: [], svgs: [], inlineHighlights: [] };
    const slideRect = slide.getBoundingClientRect();
    const localRect = rect => ({
      x: rect.left - slideRect.left,
      y: rect.top - slideRect.top,
      w: rect.width,
      h: rect.height,
    });
    const isVisible = (el, style = getComputedStyle(el)) => {
      if (!el || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1
        && rect.right >= slideRect.left && rect.left <= slideRect.right
        && rect.bottom >= slideRect.top && rect.top <= slideRect.bottom;
    };
    const colorVisible = value => {
      const raw = String(value || '').trim();
      return raw && raw !== 'transparent' && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(raw);
    };
    const normalize = value => String(value || '').replace(/[^\p{L}\p{N}%]+/gu, '').toLowerCase();
    const textAnchors = (textProbes || []).map(probe => {
      const target = normalize(probe);
      const matches = [];
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent || '';
        if (!normalize(text).includes(target)) continue;
        const parent = node.parentElement;
        if (!isVisible(parent)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter(rect => rect.width > 1 && rect.height > 1);
        const bounds = range.getBoundingClientRect();
        range.detach?.();
        const rect = rects.length ? rects[0] : bounds;
        if (rect.width <= 1 || rect.height <= 1) continue;
        const style = getComputedStyle(parent);
        matches.push({
          text: text.trim().replace(/\s+/g, ' '),
          rect: localRect(rect),
          fontSize: parseFloat(style.fontSize || '0') || 0,
          color: style.color,
          backgroundColor: style.backgroundColor,
          backgroundImage: style.backgroundImage,
          transform: style.transform,
        });
      }
      return { probe, count: matches.length, matches };
    });
    const rounded = [...slide.querySelectorAll('*')]
      .filter(el => {
        const style = getComputedStyle(el);
        if (!isVisible(el, style)) return false;
        const rect = el.getBoundingClientRect();
        const radii = [
          parseFloat(style.borderTopLeftRadius || '0') || 0,
          parseFloat(style.borderTopRightRadius || '0') || 0,
          parseFloat(style.borderBottomRightRadius || '0') || 0,
          parseFloat(style.borderBottomLeftRadius || '0') || 0,
        ];
        return rect.width * rect.height >= 900 && Math.max(...radii) >= 8;
      })
      .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height))
      .slice(0, 32)
      .map(el => {
        const style = getComputedStyle(el);
        return {
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ''),
          rect: localRect(el.getBoundingClientRect()),
          radius: Math.max(
            parseFloat(style.borderTopLeftRadius || '0') || 0,
            parseFloat(style.borderTopRightRadius || '0') || 0,
            parseFloat(style.borderBottomRightRadius || '0') || 0,
            parseFloat(style.borderBottomLeftRadius || '0') || 0,
          ),
          backgroundColor: style.backgroundColor,
          backgroundImage: String(style.backgroundImage || '').slice(0, 180),
          boxShadow: String(style.boxShadow || '').slice(0, 180),
        };
      });
    const svgs = [...slide.querySelectorAll('svg')]
      .filter(el => isVisible(el))
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          tag: 'svg',
          className: String(el.getAttribute('class') || ''),
          rect: localRect(rect),
          area: rect.width * rect.height,
          aspect: rect.height ? rect.width / rect.height : 0,
          viewBox: el.getAttribute('viewBox') || '',
          preserveAspectRatio: el.getAttribute('preserveAspectRatio') || '',
          textCount: el.querySelectorAll('text').length,
        };
      })
      .sort((a, b) => b.area - a.area)
      .slice(0, 12);
    const inlineHighlights = [...slide.querySelectorAll('span,b,strong,em')]
      .filter(el => {
        const style = getComputedStyle(el);
        const bg = style.backgroundImage || '';
        return isVisible(el, style)
          && ((bg && bg !== 'none') || colorVisible(style.backgroundColor) || style.boxShadow !== 'none')
          && (el.textContent || '').trim().length >= 2;
      })
      .slice(0, 24)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        className: String(el.className || ''),
        text: (el.textContent || '').trim().replace(/\s+/g, ' '),
        rect: localRect(el.getBoundingClientRect()),
        backgroundImage: String(getComputedStyle(el).backgroundImage || '').slice(0, 180),
        backgroundColor: getComputedStyle(el).backgroundColor,
        boxShadow: String(getComputedStyle(el).boxShadow || '').slice(0, 180),
        transform: getComputedStyle(el).transform,
      }));
    return {
      key: slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '',
      slide: { w: slideRect.width, h: slideRect.height },
      text: (slide.innerText || '').trim().replace(/\s+/g, ' '),
      textAnchors,
      rounded,
      svgs,
      inlineHighlights,
    };
  }, sample);
}

function validateJad64AcceptanceSample(sample, dom, pptx, visual) {
  const failures = [];
  const slide = pptx.slides[0] || {};
  const details = slide.shapeDetails || [];
  const textBoxes = slide.textBoxes || [];
  const pictures = slide.pictures || [];
  const normalizedPptText = normalizeSearchText(pptx.allText || '');
  const thinRectArtifacts = details.filter(shape => {
    if (shape.geom !== 'rect') return false;
    const minSide = Math.min(shape.w || 0, shape.h || 0);
    const maxSide = Math.max(shape.w || 0, shape.h || 0);
    return minSide > 0 && minSide <= 0.045 && maxSide >= 0.45;
  });
  const roundedGeomCount = details.filter(shape => ['roundRect', 'ellipse'].includes(shape.geom)).length;
  const objectBoundsFailures = acceptanceObjectBounds(slide).filter(item =>
    item.x < -0.03 || item.y < -0.03 || item.x + item.w > PPT_W + 0.03 || item.y + item.h > PPT_H + 0.03);

  for (const probe of sample.textProbes || []) {
    if (!normalizedPptText.includes(normalizeSearchText(probe))) {
      failures.push(`${sample.id} is missing text probe "${probe}" in PPTX text.`);
    }
  }
  const positionFailures = compareTextProbePositions(sample, dom, textBoxes);
  failures.push(...positionFailures);
  if (sample.probes.includes('text-stacking')) {
    const duplicates = findOverlappingDuplicateTextBoxes(textBoxes, sample.textProbes || []);
    if (duplicates.length) {
      failures.push(`${sample.id} has overlapping duplicate text boxes: ${duplicates.map(item => item.probe).join(', ')}`);
    }
    const largeTextBoxes = textBoxes.filter(box => (box.h || 0) > 0.55 && (box.w || 0) > 1.5);
    if (largeTextBoxes.length > 4) failures.push(`${sample.id} exported ${largeTextBoxes.length} large statement text boxes, indicating stacked title layers.`);
  }
  if (sample.probes.includes('rounded-cards')) {
    const roundedDom = (dom.rounded || []).filter(item => item.rect.w > 300 && item.rect.h > 60);
    if (roundedDom.length >= 3 && roundedGeomCount < Math.min(roundedDom.length, 5)) {
      failures.push(`${sample.id} exported ${roundedGeomCount} rounded PPT geometries for ${roundedDom.length} rounded DOM card candidates.`);
    }
    if (thinRectArtifacts.length > 4) failures.push(`${sample.id} exported ${thinRectArtifacts.length} long thin rect artifacts around rounded cards.`);
  }
  if (sample.probes.includes('svg-aspect')) {
    const domSvg = (dom.svgs || [])[0];
    const matchingPicture = domSvg ? findPictureMatchingDomRect(domSvg.rect, dom.slide, pictures) : null;
    if (!domSvg) failures.push(`${sample.id} did not find a visible SVG radar in the DOM.`);
    if (!matchingPicture) failures.push(`${sample.id} did not export a local image object for the radar SVG.`);
    if (domSvg && matchingPicture) {
      const pptAspect = matchingPicture.h ? matchingPicture.w / matchingPicture.h : 0;
      const delta = Math.abs(pptAspect - domSvg.aspect);
      if (delta > 0.08) {
        failures.push(`${sample.id} changed SVG aspect ratio from ${domSvg.aspect.toFixed(3)} to ${pptAspect.toFixed(3)}.`);
      }
    }
  }
  if (sample.probes.includes('material-highlight')) {
    const highlights = dom.inlineHighlights || [];
    if (!highlights.some(item => normalizeSearchText(item.text).includes(normalizeSearchText('重新分配')))) {
      failures.push(`${sample.id} did not capture the glass highlight DOM anchor.`);
    }
    const highlightDuplicates = findOverlappingDuplicateTextBoxes(textBoxes, ['重新分配']);
    if (highlightDuplicates.length) failures.push(`${sample.id} duplicated the highlight text box.`);
    if (pictures.length < 1) failures.push(`${sample.id} did not export any local image/material fallback object for complex glow/gradient material.`);
  }
  if (sample.probes.includes('crop-bounds')) {
    if (objectBoundsFailures.length) {
      failures.push(`${sample.id} exported ${objectBoundsFailures.length} object(s) outside slide bounds.`);
    }
    if ((slide.text || []).length < 10) failures.push(`${sample.id} lost too much editable chart text (${(slide.text || []).length} text runs).`);
  }
  if (visual?.available) {
    const rmseLimit = sample.probes.includes('material-highlight') ? 0.31 : 0.28;
    const edgeLimit = sample.probes.includes('material-highlight') ? 0.34 : 0.31;
    if (visual.normalizedRmse > rmseLimit) failures.push(`${sample.id} visual RMSE ${visual.normalizedRmse.toFixed(4)} exceeds ${rmseLimit.toFixed(4)}.`);
    if (visual.edgeRmse > edgeLimit) failures.push(`${sample.id} edge RMSE ${visual.edgeRmse.toFixed(4)} exceeds ${edgeLimit.toFixed(4)}.`);
  }
  return {
    passed: failures.length === 0,
    textBoxCount: textBoxes.length,
    roundedDomCount: (dom.rounded || []).length,
    roundedGeomCount,
    thinRectArtifactCount: thinRectArtifacts.length,
    pictureCount: pictures.length,
    positionFailures,
    objectBoundsFailures,
    failures,
  };
}

function compareTextProbePositions(sample, dom, textBoxes) {
  const failures = [];
  const anchors = dom.textAnchors || [];
  for (const probe of sample.positionProbes || []) {
    const anchor = anchors.find(item => normalizeSearchText(item.probe) === normalizeSearchText(probe));
    const domMatch = anchor?.matches?.[0];
    if (!domMatch?.rect || !dom.slide) continue;
    const pptMatches = textBoxes.filter(box => normalizeSearchText(box.text || '').includes(normalizeSearchText(probe)));
    if (!pptMatches.length) continue;
    const expected = {
      x: domMatch.rect.x / dom.slide.w * PPT_W,
      y: domMatch.rect.y / dom.slide.h * PPT_H,
      w: domMatch.rect.w / dom.slide.w * PPT_W,
      h: domMatch.rect.h / dom.slide.h * PPT_H,
    };
    const best = pptMatches
      .map(box => ({ box, dx: Math.abs((box.x || 0) - expected.x), dy: Math.abs((box.y || 0) - expected.y) }))
      .sort((a, b) => (a.dx + a.dy) - (b.dx + b.dy))[0];
    if (!best) continue;
    const tolerance = sample.probes.includes('material-highlight') ? 0.65 : 0.35;
    if (best.dx > tolerance || best.dy > tolerance) {
      failures.push(`${sample.id} text probe "${probe}" is misplaced in PPTX (dx ${best.dx.toFixed(2)}in, dy ${best.dy.toFixed(2)}in).`);
    }
  }
  return failures;
}

function findPictureMatchingDomRect(rect, slide, pictures) {
  if (!rect || !slide) return null;
  const expected = {
    x: rect.x / slide.w * PPT_W,
    y: rect.y / slide.h * PPT_H,
    w: rect.w / slide.w * PPT_W,
    h: rect.h / slide.h * PPT_H,
  };
  return pictures
    .filter(picture => !picture.nearFullSlide)
    .map(picture => ({
      picture,
      score: Math.abs((picture.x || 0) - expected.x)
        + Math.abs((picture.y || 0) - expected.y)
        + Math.abs((picture.w || 0) - expected.w)
        + Math.abs((picture.h || 0) - expected.h),
    }))
    .sort((a, b) => a.score - b.score)[0]?.picture || null;
}

function findOverlappingDuplicateTextBoxes(textBoxes, probes) {
  const duplicates = [];
  for (const probe of probes) {
    const target = normalizeSearchText(probe);
    if (!target) continue;
    const matches = textBoxes.filter(box => normalizeSearchText(box.text || '').includes(target));
    for (let i = 0; i < matches.length; i += 1) {
      for (let j = i + 1; j < matches.length; j += 1) {
        if (rectOverlapRatio(matches[i], matches[j]) > 0.18) {
          duplicates.push({ probe, a: matches[i], b: matches[j] });
        }
      }
    }
  }
  return duplicates;
}

function rectOverlapRatio(a, b) {
  const left = Math.max(a.x || 0, b.x || 0);
  const top = Math.max(a.y || 0, b.y || 0);
  const right = Math.min((a.x || 0) + (a.w || 0), (b.x || 0) + (b.w || 0));
  const bottom = Math.min((a.y || 0) + (a.h || 0), (b.y || 0) + (b.h || 0));
  const area = Math.max(0, right - left) * Math.max(0, bottom - top);
  const minArea = Math.max(0.0001, Math.min((a.w || 0) * (a.h || 0), (b.w || 0) * (b.h || 0)));
  return area / minArea;
}

function acceptanceObjectBounds(slide = {}) {
  return [
    ...(slide.textBoxes || []).map(item => ({ kind: 'text', text: item.text, x: item.x, y: item.y, w: item.w, h: item.h })),
    ...(slide.shapeDetails || []).map(item => ({ kind: `shape:${item.geom}`, x: item.x, y: item.y, w: item.w, h: item.h })),
    ...(slide.pictures || []).map(item => ({ kind: 'picture', x: item.x, y: item.y, w: item.w, h: item.h })),
  ].filter(item => Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.w) && Number.isFinite(item.h));
}

function summarizeSlideForAcceptance(slide = {}) {
  return {
    textBoxes: (slide.textBoxes || []).slice(0, 80),
    shapeDetails: (slide.shapeDetails || []).slice(0, 80),
    pictures: (slide.pictures || []).slice(0, 40),
  };
}

function validateJad64FollowupSample(sample, dom, pptx) {
  const failures = [];
  const details = pptx.slides[0]?.shapeDetails || [];
  const textBoxes = pptx.slides[0]?.textBoxes || [];
  const normalizedText = normalizeSearchText(pptx.allText || '');
  const thinRectArtifacts = details.filter(shape => {
    if (shape.geom !== 'rect') return false;
    const minSide = Math.min(shape.w || 0, shape.h || 0);
    const maxSide = Math.max(shape.w || 0, shape.h || 0);
    return minSide > 0 && minSide <= 0.045 && maxSide >= 0.45;
  });
  const roundedGeomCount = details.filter(shape => ['roundRect', 'ellipse'].includes(shape.geom)).length;
  const triangleGeomCount = details.filter(shape => ['custGeom', 'triangle', 'rtTriangle'].includes(shape.geom)).length;
  const symbolTextBoxes = textBoxes.filter(box => /[→↔⇒➜➤▶►◆◇⬩✦✧★☆]/.test(box.text || ''));
  const highlightTexts = (dom.inlineHighlights || [])
    .map(item => normalizeSearchText(item.text))
    .filter(text => text.length >= 2);
  const duplicatedHighlightTexts = highlightTexts.filter(text => {
    if (!text) return false;
    const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return (normalizedText.match(new RegExp(escaped, 'g')) || []).length > 1;
  });

  if (sample.probes.includes('rounded-border-artifacts')) {
    if ((dom.rounded || []).length >= 3 && roundedGeomCount < 3) {
      failures.push(`${sample.label} exported ${roundedGeomCount} rounded geometries for ${(dom.rounded || []).length} rounded DOM elements.`);
    }
    if (thinRectArtifacts.length > 8) {
      failures.push(`${sample.label} exported ${thinRectArtifacts.length} long thin rect border artifacts around rounded UI.`);
    }
  }
  if (sample.probes.includes('inline-highlight-duplication')) {
    if (!highlightTexts.length) failures.push(`${sample.label} did not exercise inline highlighted text.`);
    if (duplicatedHighlightTexts.length) failures.push(`${sample.label} duplicated highlighted text in PPTX: ${duplicatedHighlightTexts.join(', ')}`);
  }
  if (sample.probes.includes('pseudo-arrow-geometry')) {
    if ((dom.pseudoTriangles || []).length && triangleGeomCount < dom.pseudoTriangles.length) {
      failures.push(`${sample.label} exported ${triangleGeomCount}/${dom.pseudoTriangles.length} CSS pseudo triangles as PPT geometry.`);
    }
    if (symbolTextBoxes.length) {
      failures.push(`${sample.label} exported arrow/diamond decorative symbols as text glyphs: ${symbolTextBoxes.map(box => box.text).join(', ')}`);
    }
  }
  if (sample.probes.includes('highlight-pill-border-artifacts')) {
    if (thinRectArtifacts.length > 4) failures.push(`${sample.label} exported ${thinRectArtifacts.length} thin rect artifacts around highlight/material elements.`);
    if (!highlightTexts.length) failures.push(`${sample.label} did not exercise the cover highlight pill.`);
  }
  return {
    passed: failures.length === 0,
    roundedDomCount: (dom.rounded || []).length,
    roundedGeomCount,
    thinRectArtifactCount: thinRectArtifacts.length,
    triangleDomCount: (dom.pseudoTriangles || []).length,
    triangleGeomCount,
    symbolTextBoxes,
    highlightedTextCount: highlightTexts.length,
    duplicatedHighlightTexts,
    failures,
  };
}

function validateSyntheticCssTriangleSample(sample, dom, pptx) {
  const failures = [];
  const details = pptx.slides[0]?.shapeDetails || [];
  const expected = dom?.pseudo?.expectedIn;
  const triangleShapes = details.filter(shape => ['custGeom', 'triangle', 'rtTriangle'].includes(shape.geom));
  const matchingTriangle = expected && triangleShapes.find(shape => (
    Math.abs(shape.x - expected.x) <= 0.05
    && Math.abs(shape.y - expected.y) <= 0.05
    && Math.abs(shape.w - expected.w) <= 0.05
    && Math.abs(shape.h - expected.h) <= 0.05
  ));
  if (!triangleShapes.length) failures.push(`${sample.label} did not export the CSS border triangle as PPT geometry.`);
  if (!matchingTriangle) {
    failures.push(`${sample.label} did not place the CSS triangle at the browser-computed matrix translate position.`);
  }
  return {
    passed: failures.length === 0,
    expected,
    triangleShapeCount: triangleShapes.length,
    matchingTriangle: matchingTriangle || null,
    triangleShapes,
    failures,
  };
}

async function collectFallbackTextRiskExpectations(page, expectedSlides) {
  const risks = [];
  for (let i = 0; i < expectedSlides; i += 1) {
    risks.push(...await page.evaluate(async index => {
      window.go?.(index, { animate: false, force: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__finishEditablePptxAnimations?.(document);
      await new Promise(resolve => requestAnimationFrame(resolve));
      const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
      if (!slide) return [];
      const slideRect = slide.getBoundingClientRect();
      const out = [];
      const isVisible = (el) => {
        const style = getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1
          && rect.right >= slideRect.left && rect.left <= slideRect.right
          && rect.bottom >= slideRect.top && rect.top <= slideRect.bottom;
      };
      const rectObject = (rect) => ({
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      });
      const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const textInRect = (root, clipRect) => {
        const items = [];
        const seen = new Set();
        const add = (text, rect) => {
          const value = (text || '').trim().replace(/\s+/g, ' ');
          if (!value || rect.width <= 1 || rect.height <= 1 || !intersects(rect, clipRect)) return;
          const key = `${value}:${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
          if (seen.has(key)) return;
          seen.add(key);
          items.push({
            text: value,
            rect: {
              x: Math.max(0, rect.left - slideRect.left),
              y: Math.max(0, rect.top - slideRect.top),
              w: Math.max(1, rect.width),
              h: Math.max(1, rect.height),
            },
          });
        };
        const walk = (node) => {
          for (const child of node.childNodes || []) {
            if (child.nodeType === Node.TEXT_NODE) {
              const text = (child.textContent || '').trim().replace(/\s+/g, ' ');
              if (!text) continue;
              const range = document.createRange();
              range.selectNodeContents(child);
              const rects = [...range.getClientRects()];
              const rect = range.getBoundingClientRect();
              range.detach?.();
              for (const item of rects.length ? rects : [rect]) add(text, item);
            } else if (child.nodeType === Node.ELEMENT_NODE && isVisible(child)) {
              walk(child);
            }
          }
        };
        walk(root);
        root.querySelectorAll?.('svg text')?.forEach(el => {
          if (!isVisible(el)) return;
          add(el.textContent || '', el.getBoundingClientRect());
        });
        return items;
      };
      const overlayObjectsInRect = (root, frame, clipRect) => {
        const items = [];
        const seen = new Set();
        const isMostlyFrameSized = (rect) => {
          const area = rect.width * rect.height;
          const frameArea = Math.max(1, clipRect.width * clipRect.height);
          return area / frameArea > 0.86
            && Math.abs(rect.left - clipRect.left) < 8
            && Math.abs(rect.top - clipRect.top) < 8
            && Math.abs(rect.right - clipRect.right) < 8
            && Math.abs(rect.bottom - clipRect.bottom) < 8;
        };
        const hasPaint = (el) => {
          const style = getComputedStyle(el);
          const bg = String(style.backgroundColor || '').trim();
          const bgImage = String(style.backgroundImage || '').trim();
          const hasBg = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
          const hasBgImage = bgImage && bgImage !== 'none';
          const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(side => {
            const width = parseFloat(style[`border${side}Width`] || '0') || 0;
            const color = String(style[`border${side}Color`] || '').trim();
            return width > 0 && color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
          });
          return hasBg || hasBgImage || hasBorder || (style.boxShadow && style.boxShadow !== 'none') || ['IMG', 'SVG', 'CANVAS', 'VIDEO'].includes(el.tagName);
        };
        const add = (el) => {
          if (!el || el === frame || frame.contains(el) || el.contains(frame)) return;
          if (!isVisible(el)) return;
          if (!hasPaint(el)) return;
          const rect = el.getBoundingClientRect();
          if (!intersects(rect, clipRect)) return;
          if (isMostlyFrameSized(rect)) return;
          const area = rect.width * rect.height;
          if (area < 120) return;
          const key = `${el.tagName}:${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}`;
          if (seen.has(key)) return;
          seen.add(key);
          const style = getComputedStyle(el);
          items.push({
            tag: el.tagName.toLowerCase(),
            className: String(el.className || '').slice(0, 120),
            text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
            rect: {
              x: Math.max(0, rect.left - slideRect.left),
              y: Math.max(0, rect.top - slideRect.top),
              w: Math.max(1, rect.width),
              h: Math.max(1, rect.height),
            },
            paint: {
              backgroundColor: style.backgroundColor,
              backgroundImage: String(style.backgroundImage || '').slice(0, 120),
              borderTop: `${style.borderTopWidth} ${style.borderTopColor}`,
              boxShadow: String(style.boxShadow || '').slice(0, 120),
            },
          });
        };
        root.querySelectorAll?.('*')?.forEach(add);
        return items.sort((a, b) => (b.rect.w * b.rect.h) - (a.rect.w * a.rect.h)).slice(0, 24);
      };
      const addRisk = (el, kind, textItems = [], overlayItems = []) => {
        if (!textItems.length && !overlayItems.length) return;
        const rect = el.getBoundingClientRect();
        const texts = textItems.map(item => item.text);
        out.push({
          slide: index + 1,
          key: slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '',
          kind,
          textCount: texts.length,
          sample: texts.join(' ').slice(0, 120),
          textItems: textItems.slice(0, 40),
          overlayItems: overlayItems.slice(0, 40),
          rect: {
            x: Math.max(0, rect.left - slideRect.left),
            y: Math.max(0, rect.top - slideRect.top),
            w: Math.max(1, Math.min(rect.right, slideRect.right) - Math.max(rect.left, slideRect.left)),
            h: Math.max(1, Math.min(rect.bottom, slideRect.bottom) - Math.max(rect.top, slideRect.top)),
          },
        });
      };
      slide.querySelectorAll('.bt-unicorn-frame').forEach(el => {
        if (!isVisible(el)) return;
        const rect = rectObject(el.getBoundingClientRect());
        addRisk(el, 'unicorn-overlay-text', textInRect(slide, rect));
        addRisk(el, 'unicorn-overlay-object', [], overlayObjectsInRect(slide, el, rect));
      });
      slide.querySelectorAll('svg').forEach(el => {
        if (!isVisible(el)) return;
        const texts = [...el.querySelectorAll('text')]
          .map(textEl => ({
            text: (textEl.textContent || '').trim().replace(/\s+/g, ' '),
            rect: rectObject(textEl.getBoundingClientRect()),
          }))
          .filter(item => item.text);
        addRisk(el, 'svg-text', texts);
      });
      return out;
    }, i));
  }
  return risks;
}

function selectFallbackTextRiskSamples(expectedRisks, limit) {
  const bySlide = [];
  const seen = new Set();
  const ordered = [...expectedRisks].sort((a, b) => fallbackRiskPriority(b) - fallbackRiskPriority(a));
  for (const risk of ordered) {
    const key = `${risk.slide}:${risk.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bySlide.push(risk);
    if (bySlide.length >= limit) break;
  }
  return bySlide;
}

function fallbackRiskPriority(risk) {
  if (risk.kind === 'unicorn-overlay-object') return 130;
  if (risk.kind === 'unicorn-overlay-text') return 120;
  if (risk.kind === 'unicorn-background') return 100;
  if (risk.kind === 'canvas') return 80;
  if (risk.kind === 'svg-text') return 60;
  return 40;
}

async function captureFallbackTextRiskEvidence(page, risks, evidenceDir) {
  if (!risks.length) return [];
  mkdirSync(evidenceDir, { recursive: true });
  const checks = [];
  for (const risk of risks) {
    const sampleDir = path.join(evidenceDir, `slide-${String(risk.slide).padStart(3, '0')}-${safePathSegment(risk.kind)}`);
    mkdirSync(sampleDir, { recursive: true });
    const htmlSlide = path.join(sampleDir, 'html-slide.png');
    const htmlFallback = path.join(sampleDir, 'html-fallback-region.png');
    const hiddenSlide = path.join(sampleDir, 'html-slide-text-hidden.png');
    const hiddenFallback = path.join(sampleDir, 'html-fallback-region-text-hidden.png');
    const overlayHiddenSlide = path.join(sampleDir, 'html-slide-overlays-hidden.png');
    const overlayHiddenFallback = path.join(sampleDir, 'html-fallback-region-overlays-hidden.png');
    await page.evaluate(async slideIndex => {
      window.go?.(slideIndex - 1, { animate: false, force: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__finishEditablePptxAnimations?.(document);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, risk.slide);
    const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!activeSlide) continue;
    await activeSlide.screenshot({ path: htmlSlide });
    if (risk.rect && commandAvailable('magick')) {
      const crop = `${Math.max(1, Math.round(risk.rect.w))}x${Math.max(1, Math.round(risk.rect.h))}+${Math.max(0, Math.round(risk.rect.x))}+${Math.max(0, Math.round(risk.rect.y))}`;
      spawnSync('magick', [htmlSlide, '-crop', crop, htmlFallback], { encoding: 'utf8' });
      await page.evaluate(async risk => {
        const rect = risk.rect;
        const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
        if (!slide) return;
        const slideRect = slide.getBoundingClientRect();
        const clip = {
          left: slideRect.left + rect.x,
          top: slideRect.top + rect.y,
          right: slideRect.left + rect.x + rect.w,
          bottom: slideRect.top + rect.y + rect.h,
        };
        const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const entries = [];
        const markText = (el) => {
          if (!el || entries.some(entry => entry.el === el)) return;
          entries.push({ el, style: el.getAttribute('style') });
          const style = getComputedStyle(el);
          el.style.setProperty('color', 'transparent', 'important');
          el.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
          el.style.setProperty('-webkit-text-stroke-color', 'transparent', 'important');
          el.style.setProperty('text-shadow', 'none', 'important');
          el.style.setProperty('text-decoration-color', 'transparent', 'important');
          el.style.setProperty('fill', 'transparent', 'important');
          el.style.setProperty('stroke', 'transparent', 'important');
          if (String(style.backgroundClip || '').includes('text') || String(style.webkitBackgroundClip || '').includes('text')) {
            el.style.setProperty('background-image', 'none', 'important');
          }
        };
        const markOverlay = (el) => {
          if (!el || entries.some(entry => entry.el === el)) return;
          entries.push({ el, style: el.getAttribute('style') });
          el.style.setProperty('opacity', '0', 'important');
        };
        const hasPaint = (el) => {
          const style = getComputedStyle(el);
          const bg = String(style.backgroundColor || '').trim();
          const bgImage = String(style.backgroundImage || '').trim();
          const hasBg = bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)';
          const hasBgImage = bgImage && bgImage !== 'none';
          const hasBorder = ['Top', 'Right', 'Bottom', 'Left'].some(side => {
            const width = parseFloat(style[`border${side}Width`] || '0') || 0;
            const color = String(style[`border${side}Color`] || '').trim();
            return width > 0 && color && color !== 'transparent' && color !== 'rgba(0, 0, 0, 0)';
          });
          return hasBg || hasBgImage || hasBorder || (style.boxShadow && style.boxShadow !== 'none') || ['IMG', 'SVG', 'CANVAS', 'VIDEO'].includes(el.tagName);
        };
        const isMostlyClipSized = (rect) => {
          const area = rect.width * rect.height;
          const clipArea = Math.max(1, (clip.right - clip.left) * (clip.bottom - clip.top));
          return area / clipArea > 0.86
            && Math.abs(rect.left - clip.left) < 8
            && Math.abs(rect.top - clip.top) < 8
            && Math.abs(rect.right - clip.right) < 8
            && Math.abs(rect.bottom - clip.bottom) < 8;
        };
        if (risk.kind === 'unicorn-overlay-object') {
          const frame = [...slide.querySelectorAll('.bt-unicorn-frame')]
            .find(item => {
              const frameRect = item.getBoundingClientRect();
              return Math.abs(frameRect.left - clip.left) < 4
                && Math.abs(frameRect.top - clip.top) < 4
                && Math.abs(frameRect.width - (clip.right - clip.left)) < 8
                && Math.abs(frameRect.height - (clip.bottom - clip.top)) < 8;
            });
          slide.querySelectorAll('*').forEach(el => {
            if (el === frame || frame?.contains(el) || el.contains(frame)) return;
            const style = getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return;
            const itemRect = el.getBoundingClientRect();
            if (itemRect.width <= 2 || itemRect.height <= 2 || !intersects(itemRect, clip)) return;
            if (isMostlyClipSized(itemRect) || !hasPaint(el)) return;
            markOverlay(el);
          });
        }
        const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!(walker.currentNode.textContent || '').trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(walker.currentNode);
          const rects = [...range.getClientRects()];
          const bounds = range.getBoundingClientRect();
          range.detach?.();
          if ((rects.length ? rects : [bounds]).some(item => item.width > 1 && item.height > 1 && intersects(item, clip))) {
            markText(walker.currentNode.parentElement);
          }
        }
        slide.querySelectorAll('svg text').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 1 && rect.height > 1 && intersects(rect, clip)) markText(el);
        });
        window.__fallbackRiskHiddenTextEntries = entries;
      }, risk);
      await activeSlide.screenshot({ path: hiddenSlide });
      spawnSync('magick', [hiddenSlide, '-crop', crop, hiddenFallback], { encoding: 'utf8' });
      if (risk.kind === 'unicorn-overlay-object') {
        copyFileSync(hiddenSlide, overlayHiddenSlide);
        copyFileSync(hiddenFallback, overlayHiddenFallback);
      }
      checks.push(analyzeFallbackTextRemoval(risk, htmlFallback, hiddenFallback, sampleDir));
      checks.push(analyzeFallbackOverlayRemoval(risk, htmlFallback, hiddenFallback, sampleDir));
      await page.evaluate(() => {
        const entries = window.__fallbackRiskHiddenTextEntries || [];
        for (const entry of entries) {
          if (entry.style == null) entry.el.removeAttribute('style');
          else entry.el.setAttribute('style', entry.style);
        }
        delete window.__fallbackRiskHiddenTextEntries;
      });
    }
    writeFileSync(path.join(sampleDir, 'risk.json'), JSON.stringify(risk, null, 2) + '\n');
  }
  return checks;
}

function analyzeFallbackTextRemoval(risk, htmlFallback, hiddenFallback, sampleDir) {
  if (risk.kind !== 'unicorn-overlay-text' || !risk.rect || !commandAvailable('magick')) {
    return { slide: risk.slide, kind: risk.kind, checked: false, passed: true, reason: 'not-unicorn-overlay' };
  }
  const cropDir = path.join(sampleDir, 'text-removal-crops');
  mkdirSync(cropDir, { recursive: true });
  const candidates = (risk.textItems || [])
    .map((item, index) => {
      const rect = item.rect || {};
      const x = Number(rect.x ?? rect.left ?? 0) - Number(risk.rect.x || 0);
      const y = Number(rect.y ?? rect.top ?? 0) - Number(risk.rect.y || 0);
      const w = Number(rect.w ?? rect.width ?? 0);
      const h = Number(rect.h ?? rect.height ?? 0);
      return { index, text: item.text || '', x, y, w, h, area: w * h };
    })
    .filter(item => item.w >= 8 && item.h >= 8 && item.area >= 120 && String(item.text || '').trim().length >= 2)
    .sort((a, b) => b.area - a.area)
    .slice(0, 8);
  const results = [];
  for (const item of candidates) {
    const spec = `${Math.max(1, Math.round(item.w))}x${Math.max(1, Math.round(item.h))}+${Math.max(0, Math.round(item.x))}+${Math.max(0, Math.round(item.y))}`;
    const before = path.join(cropDir, `text-${String(item.index).padStart(2, '0')}-before.png`);
    const after = path.join(cropDir, `text-${String(item.index).padStart(2, '0')}-after.png`);
    spawnSync('magick', [htmlFallback, '-crop', spec, before], { encoding: 'utf8' });
    spawnSync('magick', [hiddenFallback, '-crop', spec, after], { encoding: 'utf8' });
    const rmse = compareImageMetric('RMSE', before, after);
    results.push({
      index: item.index,
      text: item.text.slice(0, 80),
      rmse,
      before,
      after,
      passed: Number.isFinite(rmse) && rmse >= 0.004,
    });
  }
  const failures = results.filter(item => !item.passed);
  return {
    slide: risk.slide,
    key: risk.key,
    kind: risk.kind,
    checked: results.length > 0,
    passed: failures.length === 0,
    minRmse: results.length ? Math.min(...results.map(item => Number.isFinite(item.rmse) ? item.rmse : 0)) : null,
    failures: failures.map(item => ({ index: item.index, text: item.text, rmse: item.rmse, before: item.before, after: item.after })),
    samples: results,
  };
}

function analyzeFallbackOverlayRemoval(risk, htmlFallback, hiddenFallback, sampleDir) {
  if (risk.kind !== 'unicorn-overlay-object' || !risk.rect || !commandAvailable('magick')) {
    return { slide: risk.slide, kind: risk.kind, checked: false, passed: true, reason: 'not-unicorn-overlay-object' };
  }
  const cropDir = path.join(sampleDir, 'overlay-removal-crops');
  mkdirSync(cropDir, { recursive: true });
  const candidates = (risk.overlayItems || [])
    .map((item, index) => {
      const rect = item.rect || {};
      const x = Number(rect.x ?? rect.left ?? 0) - Number(risk.rect.x || 0);
      const y = Number(rect.y ?? rect.top ?? 0) - Number(risk.rect.y || 0);
      const w = Number(rect.w ?? rect.width ?? 0);
      const h = Number(rect.h ?? rect.height ?? 0);
      return { index, tag: item.tag || '', className: item.className || '', x, y, w, h, area: w * h };
    })
    .filter(item => item.w >= 8 && item.h >= 8 && item.area >= 120)
    .sort((a, b) => b.area - a.area)
    .slice(0, 8);
  const results = [];
  for (const item of candidates) {
    const spec = `${Math.max(1, Math.round(item.w))}x${Math.max(1, Math.round(item.h))}+${Math.max(0, Math.round(item.x))}+${Math.max(0, Math.round(item.y))}`;
    const before = path.join(cropDir, `overlay-${String(item.index).padStart(2, '0')}-before.png`);
    const after = path.join(cropDir, `overlay-${String(item.index).padStart(2, '0')}-after.png`);
    spawnSync('magick', [htmlFallback, '-crop', spec, before], { encoding: 'utf8' });
    spawnSync('magick', [hiddenFallback, '-crop', spec, after], { encoding: 'utf8' });
    const rmse = compareImageMetric('RMSE', before, after);
    results.push({
      index: item.index,
      tag: item.tag,
      className: item.className,
      rmse,
      before,
      after,
      passed: Number.isFinite(rmse) && rmse >= 0.006,
    });
  }
  const failures = results.filter(item => !item.passed);
  return {
    slide: risk.slide,
    key: risk.key,
    kind: risk.kind,
    checked: results.length > 0,
    passed: failures.length === 0,
    minRmse: results.length ? Math.min(...results.map(item => Number.isFinite(item.rmse) ? item.rmse : 0)) : null,
    failures: failures.map(item => ({ index: item.index, tag: item.tag, className: item.className, rmse: item.rmse, before: item.before, after: item.after })),
    samples: results,
  };
}

function fallbackRiskWasClassified(risk, warnings) {
  return warnings.some(warning => {
    if (Number(warning?.slide) !== Number(risk.slide)) return false;
    if (risk.kind === 'svg-text') return warning.node === 'svg';
    if (risk.kind === 'unicorn-overlay-object') return warning.node === 'unicorn-background' && warning.type === 'node-image-fallback-overlay-extracted';
    if (risk.kind === 'unicorn-background' || risk.kind === 'unicorn-overlay-text') return warning.node === 'unicorn-background';
    return warning.node === risk.kind;
  });
}

function missingFallbackTextObjects(risks, pptx) {
  const allText = normalizeSearchText(pptx.allText);
  const missing = [];
  for (const risk of risks) {
    const probes = [...new Set((risk.textItems || [])
      .map(item => fallbackTextProbe(item?.text))
      .filter(Boolean))]
      .slice(0, 8);
    const missingProbes = probes.filter(probe => !allText.includes(probe));
    if (missingProbes.length) {
      missing.push({
        slide: risk.slide,
        key: risk.key,
        kind: risk.kind,
        missingProbes,
      });
    }
  }
  return missing;
}

function fallbackTextProbe(value) {
  const normalized = normalizeSearchText(value);
  if (normalized.length < 2) return '';
  return normalized.slice(0, Math.min(24, normalized.length));
}

function normalizeSearchText(value) {
  return String(value || '').replace(/[^\p{L}\p{N}%]+/gu, '').toLowerCase();
}

async function collectSampleVisualComparisons(page, expectations, visualDir) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
  const samples = selectVisualSamples(expectations);
  const out = [];
  for (const sample of samples) {
    const sampleDir = path.join(visualDir, `sample-${String(sample.index).padStart(3, '0')}`);
    mkdirSync(sampleDir, { recursive: true });
    const htmlScreenshot = path.join(sampleDir, `html-slide-${String(sample.index).padStart(3, '0')}.png`);
    await page.evaluate(async index => {
      window.go?.(index, { animate: false, force: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      window.__finishEditablePptxAnimations?.(document);
      await new Promise(resolve => requestAnimationFrame(resolve));
    }, sample.index - 1);
    const highlightAnchors = await collectHighlightAnchorRects(page, sample);
    const slotAnchors = await collectSlotAnchorRects(page, sample);
    const pptxFile = path.join(sampleDir, `sample-slide-${String(sample.index).padStart(3, '0')}.pptx`);
    const reportFile = path.join(sampleDir, `sample-slide-${String(sample.index).padStart(3, '0')}.json`);
    await mod.exportEditablePptxFromPage(page, {
      outFile: pptxFile,
      reportFile,
      title: `JAD-64 Visual Sample ${sample.index}`,
      slideIndexes: [sample.index - 1],
      freezeElementScreenshots: true,
    });
    const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!activeSlide) {
      out.push({ ...sample, available: false, reason: 'missing-active-slide' });
      continue;
    }
    await activeSlide.screenshot({ path: htmlScreenshot });
    const pptx = inspectPptx(pptxFile);
    const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, sampleDir);
    const highlightChecks = analyzeHighlightAnchors(highlightAnchors, visual);
    const slotChecks = analyzeSlotAnchors(slotAnchors, visual, pptx);
    const textLayoutFailures = validateSampleTextLayout(sample, pptx);
    const expected = summarizeExpectation(expectations.find(item => item.index === sample.index));
    const pairImage = createSamplePairImage(sample, visual, sampleDir);
    out.push({
      ...sample,
      expected,
      pptx: summarizeInspection(pptx),
      quickLook: visual,
      pairImage,
      textLayoutFailures,
      highlightChecks,
      slotChecks,
      htmlScreenshot,
      pptxFile,
      reportFile,
    });
  }
  return out;
}

function createSamplePairImage(sample, visual, sampleDir) {
  if (!visual?.available || !existsSync(visual.htmlImage) || !existsSync(visual.pptxImage) || !commandAvailable('magick')) return null;
  const out = path.join(sampleDir, 'compare-pair.png');
  const row = spawnSync('magick', [
    visual.htmlImage,
    '-resize',
    '480x270!',
    visual.pptxImage,
    '-resize',
    '480x270!',
    '+append',
    out,
  ], { encoding: 'utf8' });
  return row.status === 0 ? out : null;
}

function resolveRandom30Samples(selection, sampleSpecs) {
  const themes = new Map((selection.themes || []).map(theme => [theme.key, theme]));
  return sampleSpecs.map(spec => {
    const theme = themes.get(spec.themePack);
    const selected = theme?.selectedPages || [];
    const selectedIndex = selected.findIndex(page => page.key === spec.key);
    return {
      ...spec,
      sourcePackage: selection.outDir || path.dirname(cliSelectionSummary),
      selectedIndex: selectedIndex >= 0 ? selectedIndex : null,
      selectedSlideNumber: selectedIndex >= 0 ? selectedIndex + 1 : null,
      selectedPage: selectedIndex >= 0 ? selected[selectedIndex] : null,
      selectionMatched: selectedIndex >= 0,
    };
  });
}

async function collectRandom30DomProbe(page, sample) {
  return await page.evaluate(({ textProbes }) => {
    const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!slide) return { key: '', slide: null, text: '', textAnchors: [], materialCandidates: [], svgCount: 0 };
    const slideRect = slide.getBoundingClientRect();
    const normalize = value => String(value || '').replace(/[^\p{L}\p{N}%+]+/gu, '').toLowerCase();
    const isVisible = el => {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0.01
        && rect.width > 2
        && rect.height > 2
        && rect.right > slideRect.left
        && rect.left < slideRect.right
        && rect.bottom > slideRect.top
        && rect.top < slideRect.bottom;
    };
    const localRect = rect => ({
      x: Math.max(0, rect.left - slideRect.left),
      y: Math.max(0, rect.top - slideRect.top),
      w: Math.max(1, Math.min(rect.right, slideRect.right) - Math.max(rect.left, slideRect.left)),
      h: Math.max(1, Math.min(rect.bottom, slideRect.bottom) - Math.max(rect.top, slideRect.top)),
    });
    const text = (slide.innerText || '').replace(/\s+/g, ' ').trim();
    const textAnchors = (textProbes || []).map(probe => {
      const wanted = normalize(probe);
      const matches = [];
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const value = (walker.currentNode.textContent || '').replace(/\s+/g, ' ').trim();
        if (!value || !normalize(value).includes(wanted)) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const rect = range.getBoundingClientRect();
        range.detach?.();
        if (rect.width > 1 && rect.height > 1) matches.push({ text: value, rect: localRect(rect) });
      }
      return { probe, found: matches.length > 0, matches };
    });
    const materialCandidates = [...slide.querySelectorAll('*')]
      .filter(isVisible)
      .map(el => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const bg = String(style.backgroundImage || '');
        const hasMaterial = bg.includes('gradient')
          || (style.boxShadow && style.boxShadow !== 'none')
          || (style.filter && style.filter !== 'none')
          || (style.mixBlendMode && style.mixBlendMode !== 'normal');
        if (!hasMaterial) return null;
        const r = localRect(rect);
        return {
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ''),
          text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          rect: r,
          areaRatio: r.w * r.h / Math.max(1, slideRect.width * slideRect.height),
          backgroundImage: bg.slice(0, 160),
          boxShadow: String(style.boxShadow || '').slice(0, 160),
          filter: String(style.filter || ''),
          childElementCount: el.querySelectorAll('*').length,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.areaRatio - a.areaRatio)
      .slice(0, 16);
    return {
      key: slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '',
      slide: { w: slideRect.width, h: slideRect.height },
      text,
      textAnchors,
      materialCandidates,
      svgCount: slide.querySelectorAll('svg').length,
      imageCount: slide.querySelectorAll('img, canvas, video').length,
    };
  }, sample);
}

async function collectCutoutDomProbe(page) {
  return await page.evaluate(() => {
    const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!slide) return { key: '', slide: null, offSlideMaterialCandidates: [] };
    const slideRect = slide.getBoundingClientRect();
    const isVisible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0.01
        && rect.width > 2
        && rect.height > 2
        && rect.right > slideRect.left
        && rect.left < slideRect.right
        && rect.bottom > slideRect.top
        && rect.top < slideRect.bottom;
    };
    const localRect = rect => ({
      x: Math.max(0, rect.left - slideRect.left),
      y: Math.max(0, rect.top - slideRect.top),
      w: Math.max(1, Math.min(rect.right, slideRect.right) - Math.max(rect.left, slideRect.left)),
      h: Math.max(1, Math.min(rect.bottom, slideRect.bottom) - Math.max(rect.top, slideRect.top)),
    });
    const offSlideMaterialCandidates = [...slide.querySelectorAll('*')]
      .filter(isVisible)
      .map(el => {
        const style = getComputedStyle(el);
        const bg = String(style.backgroundImage || '');
        const hasMaterial = bg.includes('gradient')
          || (style.boxShadow && style.boxShadow !== 'none')
          || (style.filter && style.filter !== 'none')
          || (style.mixBlendMode && style.mixBlendMode !== 'normal');
        if (!hasMaterial) return null;
        const rect = el.getBoundingClientRect();
        const offSlide = rect.left < slideRect.left - 1
          || rect.top < slideRect.top - 1
          || rect.right > slideRect.right + 1
          || rect.bottom > slideRect.bottom + 1;
        if (!offSlide) return null;
        const clipped = localRect(rect);
        return {
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ''),
          text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
          clipped,
          clippedAreaRatio: clipped.w * clipped.h / Math.max(1, slideRect.width * slideRect.height),
          backgroundImage: bg.slice(0, 180),
          filter: String(style.filter || ''),
          boxShadow: String(style.boxShadow || '').slice(0, 180),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.clippedAreaRatio - a.clippedAreaRatio)
      .slice(0, 16);
    return {
      key: slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '',
      slide: { w: slideRect.width, h: slideRect.height },
      offSlideMaterialCandidates,
    };
  });
}

async function collectMaterialLayerDomProbe(page, sample) {
  return await page.evaluate(({ textProbe }) => {
    const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!slide) return { key: '', slide: null, materialTextRegion: null, decorativeGradientRegions: [] };
    const slideRect = slide.getBoundingClientRect();
    const normalizedProbe = String(textProbe || '').replace(/\s+/g, '');
    const localRect = rect => {
      const left = Math.max(rect.left, slideRect.left);
      const top = Math.max(rect.top, slideRect.top);
      const right = Math.min(rect.right, slideRect.right);
      const bottom = Math.min(rect.bottom, slideRect.bottom);
      return {
        x: left - slideRect.left,
        y: top - slideRect.top,
        w: Math.max(0, right - left),
        h: Math.max(0, bottom - top),
      };
    };
    const pptRect = rect => ({
      x: rect.x / slideRect.width * 16,
      y: rect.y / slideRect.height * 9,
      w: rect.w / slideRect.width * 16,
      h: rect.h / slideRect.height * 9,
    });
    const isVisible = el => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && Number(style.opacity || 1) > 0.01
        && rect.width > 2
        && rect.height > 2
        && rect.right > slideRect.left
        && rect.left < slideRect.right
        && rect.bottom > slideRect.top
        && rect.top < slideRect.bottom;
    };
    const visibleChildren = el => [...(el.children || [])].filter(isVisible);
    const textOf = el => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
    const elements = [...slide.querySelectorAll('*')].filter(isVisible);
    let materialTextRegion = null;
    if (normalizedProbe) {
      const candidates = elements
        .map(el => {
          const style = getComputedStyle(el);
          const text = textOf(el);
          const rect = localRect(el.getBoundingClientRect());
          const background = String(style.backgroundImage || '');
          const hasMaterial = background.includes('gradient')
            || (style.boxShadow && style.boxShadow !== 'none')
            || (style.filter && style.filter !== 'none')
            || Math.max(parseFloat(style.borderTopLeftRadius || '0') || 0, parseFloat(style.borderTopRightRadius || '0') || 0) >= 10;
          if (!hasMaterial || !text.replace(/\s+/g, '').includes(normalizedProbe) || rect.w <= 4 || rect.h <= 4) return null;
          return {
            el,
            text,
            rect,
            pptRect: pptRect(rect),
            areaRatio: rect.w * rect.h / Math.max(1, slideRect.width * slideRect.height),
            backgroundImage: background.slice(0, 180),
            boxShadow: String(style.boxShadow || '').slice(0, 180),
            filter: String(style.filter || ''),
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.areaRatio - b.areaRatio);
      if (candidates[0]) {
        const token = `jad64-material-text-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        candidates[0].el.setAttribute('data-jad64-material-text-probe', token);
        materialTextRegion = { ...candidates[0], el: undefined, token };
      }
    }
    const decorativeGradientRegions = elements
      .map(el => {
        const style = getComputedStyle(el);
        const background = String(style.backgroundImage || '');
        const rect = localRect(el.getBoundingClientRect());
        if (!background.includes('radial-gradient') || rect.w <= 4 || rect.h <= 4) return null;
        if (textOf(el)) return null;
        if (visibleChildren(el).length) return null;
        const bg = String(style.backgroundColor || '').trim().toLowerCase();
        const transparentBg = !bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)';
        if (!transparentBg) return null;
        const areaRatio = rect.w * rect.h / Math.max(1, slideRect.width * slideRect.height);
        if (areaRatio < 0.12) return null;
        return {
          tag: el.tagName.toLowerCase(),
          className: String(el.className || ''),
          rect,
          pptRect: pptRect(rect),
          areaRatio,
          backgroundImage: background.slice(0, 180),
          opacity: style.opacity,
          filter: String(style.filter || ''),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.areaRatio - a.areaRatio)
      .slice(0, 8);
    return {
      key: slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '',
      slide: { w: slideRect.width, h: slideRect.height },
      materialTextRegion,
      decorativeGradientRegions,
    };
  }, sample);
}

async function captureHiddenMaterialTextReference(page, materialTextRegion, sampleDir) {
  if (!materialTextRegion?.token) return null;
  const visibleFile = path.join(sampleDir, 'material-visible.png');
  const hiddenFile = path.join(sampleDir, 'material-hidden-text.png');
  const info = await page.evaluate(async token => {
    const el = document.querySelector(`[data-jad64-material-text-probe="${token}"]`);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const entries = [];
    const remember = item => {
      if (!item || entries.some(entry => entry.el === item)) return;
      entries.push({ el: item, style: item.getAttribute('style') });
    };
    const hide = item => {
      if (!item) return;
      remember(item);
      item.style.setProperty('color', 'transparent', 'important');
      item.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      item.style.setProperty('-webkit-text-stroke-color', 'transparent', 'important');
      item.style.setProperty('text-shadow', 'none', 'important');
      item.style.setProperty('text-decoration-color', 'transparent', 'important');
      item.style.setProperty('fill', 'transparent', 'important');
      item.style.setProperty('stroke', 'transparent', 'important');
      item.style.setProperty('caret-color', 'transparent', 'important');
    };
    window.__jad64MaterialHiddenTextEntries = entries;
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, materialTextRegion.token);
  if (!info) return null;
  await page.screenshot({ path: visibleFile, clip: screenshotClip(info) });
  await page.evaluate(token => {
    const el = document.querySelector(`[data-jad64-material-text-probe="${token}"]`);
    if (!el) return;
    const hide = item => {
      if (!item) return;
      const entries = window.__jad64MaterialHiddenTextEntries || [];
      if (!entries.some(entry => entry.el === item)) entries.push({ el: item, style: item.getAttribute('style') });
      window.__jad64MaterialHiddenTextEntries = entries;
      item.style.setProperty('color', 'transparent', 'important');
      item.style.setProperty('-webkit-text-fill-color', 'transparent', 'important');
      item.style.setProperty('-webkit-text-stroke-color', 'transparent', 'important');
      item.style.setProperty('text-shadow', 'none', 'important');
      item.style.setProperty('text-decoration-color', 'transparent', 'important');
      item.style.setProperty('fill', 'transparent', 'important');
      item.style.setProperty('stroke', 'transparent', 'important');
      item.style.setProperty('caret-color', 'transparent', 'important');
    };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      if ((walker.currentNode.textContent || '').trim()) hide(walker.currentNode.parentElement);
    }
    el.querySelectorAll('*').forEach(child => {
      if ((child.textContent || '').trim()) hide(child);
    });
  }, materialTextRegion.token);
  await page.waitForTimeout(80);
  await page.screenshot({ path: hiddenFile, clip: screenshotClip(info) });
  await page.evaluate(() => {
    const entries = window.__jad64MaterialHiddenTextEntries || [];
    for (const entry of entries) {
      if (entry.style == null) entry.el.removeAttribute('style');
      else entry.el.setAttribute('style', entry.style);
    }
    delete window.__jad64MaterialHiddenTextEntries;
  }).catch(() => {});
  return { visibleFile, hiddenFile, rect: info };
}

function screenshotClip(rect) {
  return {
    x: Math.max(0, Math.floor(rect.x)),
    y: Math.max(0, Math.floor(rect.y)),
    width: Math.max(1, Math.ceil(rect.width)),
    height: Math.max(1, Math.ceil(rect.height)),
  };
}

function analyzeMaterialTextInRaster(sample, { pptx, media, dom, hiddenMaterial, sampleDir }) {
  const region = dom.materialTextRegion;
  if (!region || !hiddenMaterial?.hiddenFile || !commandAvailable('magick')) {
    return { checked: false, passed: true, reason: 'missing-material-region' };
  }
  const mediaByHash = new Map((media || []).map(item => [item.hash, item]));
  const rows = (pptx.slides?.[0]?.pictures || [])
    .map((picture, index) => {
      if (picture.nearFullSlide) return null;
      const overlap = rectOverlapRatio(picture, region.pptRect);
      if (overlap < 0.45) return null;
      const pictureArea = Math.max(0.0001, (picture.w || 0) * (picture.h || 0));
      const regionArea = Math.max(0.0001, (region.pptRect.w || 0) * (region.pptRect.h || 0));
      const sizeSimilarity = Math.min(pictureArea, regionArea) / Math.max(pictureArea, regionArea);
      if (sizeSimilarity < 0.25) return null;
      const hash = pptx.slides?.[0]?.pictureMediaHashes?.[index] || '';
      const mediaItem = mediaByHash.get(hash);
      if (!mediaItem?.file) return null;
      const normalizedMedia = path.join(sampleDir, `material-picture-${String(index + 1).padStart(2, '0')}.png`);
      const normalizedVisible = path.join(sampleDir, `material-visible-${String(index + 1).padStart(2, '0')}.png`);
      const normalizedHidden = path.join(sampleDir, `material-hidden-${String(index + 1).padStart(2, '0')}.png`);
      spawnSync('magick', [mediaItem.file, '-resize', '256x256!', normalizedMedia], { encoding: 'utf8' });
      spawnSync('magick', [hiddenMaterial.visibleFile, '-resize', '256x256!', normalizedVisible], { encoding: 'utf8' });
      spawnSync('magick', [hiddenMaterial.hiddenFile, '-resize', '256x256!', normalizedHidden], { encoding: 'utf8' });
      const rmseToVisible = compareImageMetric('RMSE', normalizedMedia, normalizedVisible);
      const rmseToHidden = compareImageMetric('RMSE', normalizedMedia, normalizedHidden);
      const closerToVisible = Number.isFinite(rmseToVisible)
        && Number.isFinite(rmseToHidden)
        && rmseToVisible < rmseToHidden * 0.75;
      return {
        pictureIndex: index + 1,
        overlap,
        sizeSimilarity,
        x: picture.x,
        y: picture.y,
        w: picture.w,
        h: picture.h,
        mediaFile: mediaItem.file,
        normalizedMedia,
        normalizedVisible,
        normalizedHidden,
        rmseToVisible,
        rmseToHidden,
        failed: closerToVisible && rmseToHidden > sample.maxHiddenMaterialRmse,
      };
    })
    .filter(Boolean);
  return {
    checked: true,
    passed: rows.every(row => !row.failed),
    maxRmse: rows.reduce((max, row) => Math.max(max, Number.isFinite(row.rmseToHidden) ? row.rmseToHidden : 0), 0),
    rows,
  };
}

function validateMaterialLayerSample(sample, { pptx, dom, media, materialText }) {
  const failures = [];
  if (pptx.fullSlideImageOnlySlides.length) failures.push(`${sample.id} became full-slide-image-only: ${pptx.fullSlideImageOnlySlides.join(', ')}.`);
  if (Number.isFinite(sample.minTextCount) && pptx.textCount < sample.minTextCount) {
    failures.push(`${sample.id} exported only ${pptx.textCount} text object(s), expected at least ${sample.minTextCount}.`);
  }
  const largeDecorativeGradientShapes = countDecorativeGradientShapes(pptx, dom);
  if (Number.isFinite(sample.maxLargeDecorativeGradientShapes) && largeDecorativeGradientShapes.length > sample.maxLargeDecorativeGradientShapes) {
    failures.push(`${sample.id} exported ${largeDecorativeGradientShapes.length} large decorative radial gradient region(s) as hard-edged native shape(s).`);
  }
  const transparentMedia = countTransparentMedia(media);
  if (Number.isFinite(sample.minTransparentMediaCount) && transparentMedia.length < sample.minTransparentMediaCount) {
    failures.push(`${sample.id} exported only ${transparentMedia.length} transparent PNG media item(s), expected at least ${sample.minTransparentMediaCount}.`);
  }
  const materialTextFailures = materialText?.rows?.filter(row => row.failed) || [];
  if (materialTextFailures.length) {
    failures.push(`${sample.id} has ${materialTextFailures.length} material raster fallback(s) that still include editable text.`);
  }
  return {
    passed: failures.length === 0,
    failures,
    largeDecorativeGradientShapes,
    transparentMedia,
    materialText,
  };
}

function countTransparentMedia(media = []) {
  return media.filter(item => {
    const channels = String(item.channels || '').toLowerCase();
    const hasAlpha = channels.includes('a');
    const opaque = item.opaque === true || /^true$/i.test(String(item.opaque || ''));
    const minAlpha = Number(item.minAlpha);
    const maxAlpha = Number(item.maxAlpha);
    return hasAlpha && !opaque && Number.isFinite(minAlpha) && Number.isFinite(maxAlpha) && minAlpha < maxAlpha;
  });
}

function countDecorativeGradientShapes(pptx, dom) {
  const shapes = pptx.slides?.[0]?.shapeDetails || [];
  const regions = dom.decorativeGradientRegions || [];
  return regions
    .map(region => {
      const match = shapes.find(shape => rectSimilarity(shape, region.pptRect) > 0.78);
      return match ? { region, shape: match, similarity: rectSimilarity(match, region.pptRect) } : null;
    })
    .filter(Boolean);
}

function rectSimilarity(a, b) {
  if (!a || !b) return 0;
  const ax1 = Number(a.x || 0);
  const ay1 = Number(a.y || 0);
  const ax2 = ax1 + Number(a.w || 0);
  const ay2 = ay1 + Number(a.h || 0);
  const bx1 = Number(b.x || 0);
  const by1 = Number(b.y || 0);
  const bx2 = bx1 + Number(b.w || 0);
  const by2 = by1 + Number(b.h || 0);
  const overlap = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1)) * Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
  const union = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1) + Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1) - overlap;
  return union > 0 ? overlap / union : 0;
}

function analyzeRenderedDiff(visual, sampleDir) {
  if (!visual?.available || !existsSync(visual.htmlImage) || !existsSync(visual.pptxImage) || !commandAvailable('magick')) return null;
  const diffImage = path.join(sampleDir, 'compare', 'diff.png');
  spawnSync('magick', [visual.htmlImage, visual.pptxImage, '-compose', 'difference', '-composite', diffImage], { encoding: 'utf8' });
  const left = readNormalizedRgbImage(visual.htmlImage);
  const right = readNormalizedRgbImage(visual.pptxImage);
  if (!left || !right || left.width !== right.width || left.height !== right.height) return null;
  const pixels = Math.min(left.pixels, right.pixels);
  const width = left.width;
  const height = left.height;
  const strips = {
    left: { changed: 0, total: 0 },
    right: { changed: 0, total: 0 },
    center: { changed: 0, total: 0 },
  };
  let changed = 0;
  let strongChanged = 0;
  let totalDiff = 0;
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 3;
    const diff = Math.abs(left.buffer[offset] - right.buffer[offset])
      + Math.abs(left.buffer[offset + 1] - right.buffer[offset + 1])
      + Math.abs(left.buffer[offset + 2] - right.buffer[offset + 2]);
    totalDiff += diff / 765;
    const isChanged = diff > 96;
    const isStrong = diff > 180;
    if (isChanged) changed += 1;
    if (isStrong) strongChanged += 1;
    const x = index % width;
    const bucket = x < width * 0.18 ? strips.left : (x > width * 0.82 ? strips.right : strips.center);
    bucket.total += 1;
    if (isChanged) bucket.changed += 1;
  }
  const ratio = item => item.total ? item.changed / item.total : 0;
  return {
    width,
    height,
    diffImage: existsSync(diffImage) ? diffImage : null,
    diffRatio: pixels ? changed / pixels : 0,
    strongDiffRatio: pixels ? strongChanged / pixels : 0,
    meanDiff: pixels ? totalDiff / pixels : 0,
    leftStripDiffRatio: ratio(strips.left),
    rightStripDiffRatio: ratio(strips.right),
    centerDiffRatio: ratio(strips.center),
  };
}

function readNormalizedRgbImage(file) {
  if (!file || !existsSync(file) || !commandAvailable('magick')) return null;
  const identified = spawnSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' });
  const [width, height] = String(identified.stdout || '').trim().split(/\s+/).map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const raw = spawnSync('magick', [file, '-resize', `${width}x${height}!`, '-depth', '8', 'rgb:-'], { encoding: null, maxBuffer: 128 * 1024 * 1024 });
  if (raw.status !== 0 || !raw.stdout?.length) return null;
  return { width, height, buffer: raw.stdout, pixels: Math.min(width * height, Math.floor(raw.stdout.length / 3)) };
}

function analyzeSampleRasterFallbacks(pptx, media) {
  const mediaByHash = new Map((media || []).map(item => [item.hash, item]));
  const pictureRows = (pptx.slides?.[0]?.pictures || []).map((picture, index) => {
    const hash = pptx.slides?.[0]?.pictureMediaHashes?.[index] || '';
    const mediaItem = mediaByHash.get(hash);
    const areaRatio = picture.w * picture.h / (PPT_W * PPT_H);
    return {
      index: index + 1,
      x: picture.x,
      y: picture.y,
      w: picture.w,
      h: picture.h,
      areaRatio,
      nearFullSlide: picture.nearFullSlide,
      hash,
      mediaWidth: mediaItem?.width || 0,
      mediaHeight: mediaItem?.height || 0,
      mediaSize: mediaItem?.size || 0,
      mediaFile: mediaItem?.file || '',
    };
  }).sort((a, b) => b.areaRatio - a.areaRatio);
  const nonBackgroundPictures = pictureRows.filter(item => !item.nearFullSlide);
  return {
    pictureCount: pictureRows.length,
    largestRasterAreaRatio: pictureRows[0]?.areaRatio || 0,
    largestNonBackgroundRasterAreaRatio: nonBackgroundPictures[0]?.areaRatio || 0,
    largeRasterPictures: pictureRows.filter(item => item.areaRatio > 0.18),
    largeNonBackgroundRasterPictures: nonBackgroundPictures.filter(item => item.areaRatio > 0.18),
    pictures: pictureRows,
  };
}

function validateRandom30Sample(sample, { dom, pptx, visual, diffStats, mediaStats }) {
  const failures = [];
  const warnings = [];
  if (!sample.selectionMatched) failures.push(`${sample.id} is not present in the reviewed random-30 selection summary.`);
  if (!visual?.available) failures.push(`${sample.id} rendered PPTX comparison unavailable: ${visual?.reason || 'unknown'}.`);
  if (pptx.fullSlideImageOnlySlides.length) failures.push(`${sample.id} became full-slide-image-only: ${pptx.fullSlideImageOnlySlides.join(', ')}.`);
  if (Number.isFinite(sample.minTextCount) && pptx.textCount < sample.minTextCount) {
    failures.push(`${sample.id} exported only ${pptx.textCount} text object(s), expected at least ${sample.minTextCount}.`);
  }
  if (visual?.available && Number.isFinite(sample.maxRmse) && visual.normalizedRmse > sample.maxRmse) {
    failures.push(`${sample.id} Quick Look RMSE ${visual.normalizedRmse.toFixed(4)} exceeds ${sample.maxRmse.toFixed(4)}.`);
  }
  if (diffStats && Number.isFinite(sample.maxDiffRatio) && diffStats.diffRatio > sample.maxDiffRatio) {
    failures.push(`${sample.id} rendered diff coverage ${(diffStats.diffRatio * 100).toFixed(1)}% exceeds ${(sample.maxDiffRatio * 100).toFixed(1)}%.`);
  }
  if (diffStats && Number.isFinite(sample.maxLeftStripDiffRatio) && diffStats.leftStripDiffRatio > sample.maxLeftStripDiffRatio) {
    failures.push(`${sample.id} left-strip diff ${(diffStats.leftStripDiffRatio * 100).toFixed(1)}% exceeds ${(sample.maxLeftStripDiffRatio * 100).toFixed(1)}%, consistent with UI/sidebar capture.`);
  }
  if (mediaStats && Number.isFinite(sample.maxLargeRasterArea) && mediaStats.largestNonBackgroundRasterAreaRatio > sample.maxLargeRasterArea) {
    failures.push(`${sample.id} largest non-background raster fallback covers ${(mediaStats.largestNonBackgroundRasterAreaRatio * 100).toFixed(1)}% of slide, exceeds ${(sample.maxLargeRasterArea * 100).toFixed(1)}%.`);
  }
  for (const anchor of dom.textAnchors || []) {
    if (!anchor.found) warnings.push(`${sample.id} could not find optional DOM text probe "${anchor.probe}".`);
  }
  return { passed: failures.length === 0, failures, warnings };
}

function analyzeCutoutMediaContamination(sample, pptx, media, sampleDir) {
  const mediaByHash = new Map((media || []).map(item => [item.hash, item]));
  const copiedDir = path.join(sampleDir, 'contaminated-media');
  const rows = (pptx.slides?.[0]?.pictures || []).map((picture, index) => {
    const hash = pptx.slides?.[0]?.pictureMediaHashes?.[index] || '';
    const mediaItem = mediaByHash.get(hash);
    if (!mediaItem?.file || picture.nearFullSlide) return null;
    const metrics = cutoutMediaMetrics(mediaItem.file);
    const matchesLeftSidebar = sample.checkLeftSidebar && metrics?.leftSidebar;
    const matchesTopBlackBar = sample.checkTopBlack && metrics?.topBlackBar;
    if (!matchesLeftSidebar && !matchesTopBlackBar) return null;
    mkdirSync(copiedDir, { recursive: true });
    const evidenceFile = path.join(copiedDir, `${String(index + 1).padStart(2, '0')}-${path.basename(mediaItem.file)}`);
    copyFileSync(mediaItem.file, evidenceFile);
    return {
      pictureIndex: index + 1,
      x: picture.x,
      y: picture.y,
      w: picture.w,
      h: picture.h,
      areaRatio: picture.w * picture.h / (PPT_W * PPT_H),
      mediaFile: mediaItem.file,
      evidenceFile,
      mediaWidth: mediaItem.width,
      mediaHeight: mediaItem.height,
      metrics,
    };
  }).filter(Boolean);
  return {
    contaminatedCount: rows.length,
    leftSidebarCount: rows.filter(row => row.metrics.leftSidebar).length,
    topBlackBarCount: rows.filter(row => row.metrics.topBlackBar).length,
    rows,
  };
}

function cutoutMediaMetrics(file) {
  const image = readSampledRgbImage(file, 160, 160);
  if (!image) return null;
  const fraction = (x0, y0, x1, y1, predicate) => {
    let matched = 0;
    let total = 0;
    const startX = Math.max(0, Math.floor(x0 * image.width));
    const endX = Math.min(image.width, Math.ceil(x1 * image.width));
    const startY = Math.max(0, Math.floor(y0 * image.height));
    const endY = Math.min(image.height, Math.ceil(y1 * image.height));
    for (let y = startY; y < endY; y += 1) {
      for (let x = startX; x < endX; x += 1) {
        const offset = (y * image.width + x) * 3;
        const r = image.buffer[offset];
        const g = image.buffer[offset + 1];
        const b = image.buffer[offset + 2];
        total += 1;
        if (predicate(r, g, b)) matched += 1;
      }
    }
    return total ? matched / total : 0;
  };
  const white = (r, g, b) => r > 225 && g > 225 && b > 225;
  const dark = (r, g, b) => r < 50 && g < 65 && b < 95;
  const black = (r, g, b) => r < 15 && g < 15 && b < 20;
  const nearBlack = (r, g, b) => r < 30 && g < 30 && b < 40;
  const blue = (r, g, b) => b > 110 && b > r + 15 && b > g - 15;
  const leftWhite = fraction(0, 0, 0.24, 1, white);
  const rightBlue = fraction(0.24, 0, 1, 1, blue);
  const rightDark = fraction(0.24, 0, 1, 1, dark);
  const overallWhite = fraction(0, 0, 1, 1, white);
  const overallBlue = fraction(0, 0, 1, 1, blue);
  const overallDark = fraction(0, 0, 1, 1, dark);
  const topBlack = fraction(0, 0, 1, 0.16, black);
  const topNearBlack = fraction(0, 0, 1, 0.16, nearBlack);
  const belowNearBlack = fraction(0, 0.16, 1, 1, nearBlack);
  return {
    width: image.sourceWidth,
    height: image.sourceHeight,
    leftWhite,
    rightBlue,
    rightDark,
    overallWhite,
    overallBlue,
    overallDark,
    topBlack,
    topNearBlack,
    belowNearBlack,
    leftSidebar: image.sourceWidth >= 160
      && image.sourceHeight >= 120
      && leftWhite > 0.22
      && overallWhite < 0.72
      && (rightBlue > 0.18 || rightDark > 0.18 || overallBlue > 0.18),
    topBlackBar: image.sourceWidth >= 160
      && image.sourceHeight >= 100
      && ((topBlack > 0.5 && overallDark < 0.88) || (topNearBlack > 0.82 && belowNearBlack < 0.68))
      && overallWhite < 0.85,
  };
}

function readSampledRgbImage(file, width, height) {
  if (!file || !existsSync(file) || !commandAvailable('magick')) return null;
  const identified = spawnSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' });
  const [sourceWidth, sourceHeight] = String(identified.stdout || '').trim().split(/\s+/).map(Number);
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) return null;
  const raw = spawnSync('magick', [file, '-resize', `${width}x${height}!`, '-depth', '8', 'rgb:-'], { encoding: null, maxBuffer: width * height * 3 + 1024 });
  if (raw.status !== 0 || !raw.stdout?.length) return null;
  return { sourceWidth, sourceHeight, width, height, buffer: raw.stdout };
}

function validateCutoutSample(sample, { pptx, contamination, exportResult }) {
  const failures = [];
  const warnings = [];
  if (pptx.fullSlideImageOnlySlides.length) failures.push(`${sample.id} became full-slide-image-only: ${pptx.fullSlideImageOnlySlides.join(', ')}.`);
  if (Number.isFinite(sample.minTextCount) && pptx.textCount < sample.minTextCount) {
    failures.push(`${sample.id} exported only ${pptx.textCount} text object(s), expected at least ${sample.minTextCount}.`);
  }
  if (sample.checkLeftSidebar && contamination.leftSidebarCount > 0) {
    failures.push(`${sample.id} exported ${contamination.leftSidebarCount} raster image(s) containing a preview/sidebar strip.`);
  }
  if (sample.checkTopBlack && contamination.topBlackBarCount > 0) {
    failures.push(`${sample.id} exported ${contamination.topBlackBarCount} raster image(s) containing an off-slide black top bar.`);
  }
  const fallbackWarnings = (exportResult.warnings || []).filter(warning => warning.type === 'node-image-fallback');
  return { passed: failures.length === 0, failures, warnings, fallbackWarnings };
}

function createSampleContactSheet(samples, visualDir) {
  const rows = samples.map(sample => sample.pairImage).filter(Boolean);
  if (!rows.length || !commandAvailable('magick')) return null;
  const out = path.join(visualDir, 'contact-sheet.png');
  const sheet = spawnSync('magick', [
    ...rows,
    '-append',
    out,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return sheet.status === 0 ? out : null;
}

function analyzeJad64RootCauseRegions(sample, dom, visual, sampleDir) {
  return (sample.probes || []).map(probe => {
    const region = selectJad64RootCauseRegion(probe, dom);
    if (!region) return { probe, available: false, reason: 'region-not-found' };
    const metrics = analyzeRenderedRegionPair({
      probe,
      region,
      slide: dom.slide,
      visual,
      sampleDir,
      padPx: probe === 'material-region' ? 18 : 24,
    });
    return {
      probe,
      available: Boolean(metrics),
      reason: metrics ? undefined : 'rendered-region-analysis-failed',
      region,
      metrics,
    };
  });
}

function selectJad64RootCauseRegion(probe, dom = {}) {
  if (probe === 'material-region') return dom.materialRegions?.[0] || null;
  if (probe === 'svg-aspect' || probe === 'svg-crop') return dom.svgRegions?.[0] || null;
  return null;
}

function analyzeRenderedRegionPair({ probe, region, slide, visual, sampleDir, padPx }) {
  if (!visual?.available || !existsSync(visual.htmlImage) || !existsSync(visual.pptxImage) || !commandAvailable('magick')) return null;
  const rect = probe === 'material-region' ? region.rect : (region.visualRect || region.rect);
  if (!rect || !slide?.w || !slide?.h) return null;
  const crop = renderedCropSpec(rect, slide, padPx);
  const compareDir = path.join(sampleDir, 'region-compare');
  mkdirSync(compareDir, { recursive: true });
  const safeProbe = safePathSegment(probe);
  const htmlCrop = path.join(compareDir, `${safeProbe}-html.png`);
  const pptxCrop = path.join(compareDir, `${safeProbe}-pptx.png`);
  const htmlEdge = path.join(compareDir, `${safeProbe}-html-edge.png`);
  const pptxEdge = path.join(compareDir, `${safeProbe}-pptx-edge.png`);
  const cropHtml = spawnSync('magick', [visual.htmlImage, '-crop', crop.spec, htmlCrop], { encoding: 'utf8' });
  const cropPptx = spawnSync('magick', [visual.pptxImage, '-crop', crop.spec, pptxCrop], { encoding: 'utf8' });
  if (cropHtml.status !== 0 || cropPptx.status !== 0) return null;
  const edgeHtml = spawnSync('magick', [htmlCrop, '-colorspace', 'Gray', '-edge', '1', htmlEdge], { encoding: 'utf8' });
  const edgePptx = spawnSync('magick', [pptxCrop, '-colorspace', 'Gray', '-edge', '1', pptxEdge], { encoding: 'utf8' });
  const edgeRmse = edgeHtml.status === 0 && edgePptx.status === 0 ? compareImageMetric('RMSE', htmlEdge, pptxEdge) : Number.NaN;
  const htmlStats = summarizeRenderedRegionPixels(htmlCrop);
  const pptxStats = summarizeRenderedRegionPixels(pptxCrop);
  return {
    crop,
    htmlCrop,
    pptxCrop,
    htmlEdge: edgeHtml.status === 0 ? htmlEdge : null,
    pptxEdge: edgePptx.status === 0 ? pptxEdge : null,
    rmse: compareImageMetric('RMSE', htmlCrop, pptxCrop),
    mae: compareImageMetric('MAE', htmlCrop, pptxCrop),
    edgeRmse,
    htmlStats,
    pptxStats,
    contentAspectDelta: contentAspectDelta(htmlStats, pptxStats),
    contentWidthRatio: contentRatio(htmlStats?.contentBounds?.w, pptxStats?.contentBounds?.w),
    contentHeightRatio: contentRatio(htmlStats?.contentBounds?.h, pptxStats?.contentBounds?.h),
  };
}

function renderedCropSpec(rect, slide, padPx = 0) {
  const scaleX = 960 / Number(slide.w || 1920);
  const scaleY = 540 / Number(slide.h || 1080);
  const x = Math.max(0, Math.floor(Number(rect.x || 0) * scaleX - padPx));
  const y = Math.max(0, Math.floor(Number(rect.y || 0) * scaleY - padPx));
  const right = Math.min(960, Math.ceil((Number(rect.x || 0) + Number(rect.w || 0)) * scaleX + padPx));
  const bottom = Math.min(540, Math.ceil((Number(rect.y || 0) + Number(rect.h || 0)) * scaleY + padPx));
  const w = Math.max(1, right - x);
  const h = Math.max(1, bottom - y);
  return { x, y, w, h, spec: `${w}x${h}+${x}+${y}` };
}

function summarizeRenderedRegionPixels(file) {
  if (!file || !existsSync(file) || !commandAvailable('magick')) return null;
  const identified = spawnSync('magick', ['identify', '-format', '%w %h', file], { encoding: 'utf8' });
  const [width, height] = String(identified.stdout || '').trim().split(/\s+/).map(Number);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const raw = spawnSync('magick', [file, '-depth', '8', 'rgb:-'], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (raw.status !== 0 || !raw.stdout?.length) return null;
  const buffer = raw.stdout;
  const pixels = Math.min(width * height, Math.floor(buffer.length / 3));
  const cornerSamples = [
    0,
    Math.max(0, width - 1),
    Math.max(0, (height - 1) * width),
    Math.max(0, height * width - 1),
  ].filter(index => index >= 0 && index < pixels);
  const corner = cornerSamples.reduce((acc, index) => {
    acc.r += buffer[index * 3];
    acc.g += buffer[index * 3 + 1];
    acc.b += buffer[index * 3 + 2];
    return acc;
  }, { r: 0, g: 0, b: 0 });
  const divisor = Math.max(1, cornerSamples.length);
  const bg = { r: corner.r / divisor, g: corner.g / divisor, b: corner.b / divisor };
  let greenPixels = 0;
  let brightPixels = 0;
  let nearBlackPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < pixels; i += 1) {
    const r = buffer[i * 3];
    const g = buffer[i * 3 + 1];
    const b = buffer[i * 3 + 2];
    const max = Math.max(r, g, b);
    if (max > 110) brightPixels += 1;
    if (max < 38) nearBlackPixels += 1;
    if (g >= 96 && g >= r + 22 && g >= b + 10) greenPixels += 1;
    const bgDistance = Math.abs(r - bg.r) + Math.abs(g - bg.g) + Math.abs(b - bg.b);
    if (bgDistance > 38 && max > 24) {
      const x = i % width;
      const y = Math.floor(i / width);
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  const contentBounds = maxX >= minX && maxY >= minY
    ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, aspect: (maxX - minX + 1) / Math.max(1, maxY - minY + 1) }
    : null;
  return {
    width,
    height,
    pixels,
    greenRatio: pixels ? greenPixels / pixels : 0,
    brightRatio: pixels ? brightPixels / pixels : 0,
    nearBlackRatio: pixels ? nearBlackPixels / pixels : 0,
    contentBounds,
  };
}

function contentAspectDelta(htmlStats, pptxStats) {
  const left = htmlStats?.contentBounds?.aspect;
  const right = pptxStats?.contentBounds?.aspect;
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.abs(left - right) / Math.max(0.001, left);
}

function contentRatio(htmlValue, pptxValue) {
  if (!Number.isFinite(htmlValue) || !Number.isFinite(pptxValue) || htmlValue <= 0) return null;
  return pptxValue / htmlValue;
}

function validateJad64RootCauseSample(sample, dom, pptx, visual, regionChecks) {
  const failures = [];
  const warnings = [];
  if (!visual?.available) failures.push(`${sample.label} rendered PPTX comparison unavailable: ${visual?.reason || 'unknown'}.`);
  if (pptx.fullSlideImageOnlySlides.length) failures.push(`${sample.label} became full-slide-image-only: ${pptx.fullSlideImageOnlySlides.join(', ')}.`);
  for (const anchor of dom.textAnchors || []) {
    if (!anchor.found) warnings.push(`${sample.label} could not find optional DOM text probe "${anchor.probe}".`);
  }
  for (const check of regionChecks || []) {
    if (!check.available) {
      failures.push(`${sample.label} ${check.probe} region analysis unavailable: ${check.reason || 'unknown'}.`);
      continue;
    }
    const m = check.metrics || {};
    const rmse = Number(m.rmse);
    const edgeRmse = Number(m.edgeRmse);
    if (check.probe === 'material-region') {
      if (Number.isFinite(rmse) && rmse > 0.18) failures.push(`${sample.label} material crop RMSE ${rmse.toFixed(4)} exceeds 0.1800.`);
      if (Number.isFinite(edgeRmse) && edgeRmse > 0.245) failures.push(`${sample.label} material edge RMSE ${edgeRmse.toFixed(4)} exceeds 0.2450.`);
      const htmlGreen = Number(m.htmlStats?.greenRatio || 0);
      const pptxGreen = Number(m.pptxStats?.greenRatio || 0);
      if (htmlGreen > 0.04 && pptxGreen < htmlGreen * 0.55) {
        failures.push(`${sample.label} material crop lost green/cyan glow pixels (${pptxGreen.toFixed(4)} < ${(htmlGreen * 0.55).toFixed(4)}; HTML ${htmlGreen.toFixed(4)}).`);
      }
    } else {
      const rmseLimit = check.probe === 'svg-aspect' ? 0.14 : 0.22;
      if (Number.isFinite(rmse) && rmse > rmseLimit) failures.push(`${sample.label} ${check.probe} crop RMSE ${rmse.toFixed(4)} exceeds ${rmseLimit.toFixed(4)}.`);
      if (Number.isFinite(edgeRmse) && edgeRmse > 0.30) failures.push(`${sample.label} ${check.probe} edge RMSE ${edgeRmse.toFixed(4)} exceeds 0.3000.`);
      if (Number.isFinite(m.contentAspectDelta) && m.contentAspectDelta > 0.14) {
        failures.push(`${sample.label} ${check.probe} content aspect drift ${(m.contentAspectDelta * 100).toFixed(1)}% exceeds 14.0%.`);
      }
      if (Number.isFinite(m.contentWidthRatio) && m.contentWidthRatio < 0.82) {
        failures.push(`${sample.label} ${check.probe} rendered content width ratio ${m.contentWidthRatio.toFixed(3)} is below 0.820, indicating crop/loss.`);
      }
      if (Number.isFinite(m.contentHeightRatio) && m.contentHeightRatio < 0.82) {
        failures.push(`${sample.label} ${check.probe} rendered content height ratio ${m.contentHeightRatio.toFixed(3)} is below 0.820, indicating crop/loss.`);
      }
    }
  }
  return { passed: failures.length === 0, failures, warnings };
}

function createMatrixContactSheet(themeResults, matrixDir) {
  if (!commandAvailable('magick')) return null;
  const contactDir = path.join(matrixDir, 'contact-sheets');
  const labeledDir = path.join(contactDir, 'labeled');
  mkdirSync(labeledDir, { recursive: true });
  const font = firstExistingFile([
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Helvetica.ttc',
  ]);
  const labeled = [];
  for (const theme of themeResults) {
    if (!theme.contactSheet || !existsSync(theme.contactSheet)) continue;
    const out = path.join(labeledDir, `${safePathSegment(theme.themePack)}.png`);
    const args = [
      '-background',
      'white',
      '-fill',
      'black',
      ...(font ? ['-font', font] : []),
      '-pointsize',
      '28',
      `label:${theme.themePack}`,
      theme.contactSheet,
      '-resize',
      '480x',
      '-append',
      out,
    ];
    const label = spawnSync('magick', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (label.status === 0 && existsSync(out)) labeled.push(out);
  }
  if (!labeled.length) return null;
  const out = path.join(contactDir, 'all-themes-contact-sheet.png');
  const montage = spawnSync('magick', [
    'montage',
    ...(font ? ['-font', font] : []),
    ...labeled,
    '-tile',
    '4x3',
    '-geometry',
    '+20+20',
    '-background',
    '#f4f4f4',
    out,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return montage.status === 0 && existsSync(out) ? out : null;
}

function firstExistingFile(files) {
  return files.find(file => existsSync(file)) || null;
}

function timestampForPath() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function selectVisualSamples(expectations) {
  const picks = [];
  const add = (label, predicate) => {
    const found = expectations.find(item => predicate(item) && !picks.some(pick => pick.index === item.index));
    if (found) picks.push({ index: found.index, key: found.key || '', label, types: classifySampleTypes(found) });
  };
  add('cover', item => item.index === 1);
  add('title-section', item => item.index !== 1 && item.textNodeRects >= 6 && item.elementCount <= 35);
  add('data-table', item => item.borderElements >= 8 && item.textNodeRects >= 20);
  add('chart-values', item => item.svgElements > 0 || item.canvasElements > 0);
  add('canvas-chart', item => item.canvasElements > 0);
  add('media-slot', item => item.imageElements > 0 || item.backgroundUrlElements > 0 || item.unicornFrameElements > 0);
  add('complex-background', item => item.gradientElements >= 3 || item.shadowElements >= 4 || item.maxDepth >= 8);
  add('dense-data', item => item.elementCount >= 65 || item.textNodeRects >= 30);
  const ranked = [...expectations]
    .filter(item => !item.missing && !picks.some(pick => pick.index === item.index))
    .sort((a, b) => sampleComplexityScore(b) - sampleComplexityScore(a));
  for (const item of ranked) {
    if (picks.length >= cliSamplesPerTheme) break;
    picks.push({ index: item.index, key: item.key || '', label: 'coverage-fill', types: classifySampleTypes(item) });
  }
  return picks.slice(0, Math.min(cliSamplesPerTheme, expectations.length));
}

function classifySampleTypes(item = {}) {
  const types = [];
  if (item.index === 1) types.push('cover');
  if (item.index !== 1 && item.textNodeRects >= 6 && item.elementCount <= 35) types.push('title-section');
  if (item.borderElements >= 8 && item.textNodeRects >= 20) types.push('data-table');
  if (item.svgElements > 0 || item.canvasElements > 0) types.push('chart-values');
  if (item.imageElements > 0 || item.backgroundUrlElements > 0 || item.unicornFrameElements > 0) types.push('media-slot');
  if (item.gradientElements >= 3 || item.shadowElements >= 4 || item.maxDepth >= 8) types.push('complex-background');
  if (item.elementCount >= 65 || item.textNodeRects >= 30) types.push('dense-data');
  return types.length ? types : ['general'];
}

function sampleComplexityScore(item = {}) {
  return Number(item.textNodeRects || 0) * 2
    + Number(item.elementCount || 0)
    + Number(item.borderElements || 0) * 4
    + Number(item.svgElements || 0) * 12
    + Number(item.canvasElements || 0) * 12
    + Number(item.backgroundUrlElements || 0) * 10
    + Number(item.unicornFrameElements || 0) * 10
    + Number(item.gradientElements || 0) * 2
    + Number(item.shadowElements || 0) * 3
    + Number(item.maxDepth || 0) * 3;
}

function summarizeExpectation(item = {}) {
  return {
    textNodeRects: item.textNodeRects || 0,
    elementCount: item.elementCount || 0,
    backgroundColorElements: item.backgroundColorElements || 0,
    backgroundImageElements: item.backgroundImageElements || 0,
    backgroundUrlElements: item.backgroundUrlElements || 0,
    gradientElements: item.gradientElements || 0,
    borderElements: item.borderElements || 0,
    radiusElements: item.radiusElements || 0,
    shadowElements: item.shadowElements || 0,
    svgElements: item.svgElements || 0,
    canvasElements: item.canvasElements || 0,
    unicornFrameElements: item.unicornFrameElements || 0,
    imageElements: item.imageElements || 0,
    maxDepth: item.maxDepth || 0,
  };
}

function validateVisualFidelityReport({ report, pptx, expectations, expectedSlides, visual }) {
  const failures = [];
  if (!report) {
    failures.push('UI export did not write a report file for visual fidelity validation.');
    return failures;
  }
  if (report.captureMode !== 'captured-tree') {
    failures.push('Visual fidelity export must use the captured-tree collector, not the legacy flat DOM scanner.');
  }
  if (!Array.isArray(report.slideSummaries) || report.slideSummaries.length !== expectedSlides) {
    failures.push('Visual fidelity report must include one captured-tree summary per exported slide.');
  }

  const complexWarnings = (report.warnings || []).filter(warning =>
    warning?.type === 'complex-node' && ['svg', 'canvas'].includes(warning.node));
  if (complexWarnings.length) {
    failures.push(`Visual fidelity export skipped ${complexWarnings.length} SVG/canvas slide occurrence(s) instead of exporting local fallback objects.`);
  }

  const complexExpected = expectations.filter(item => (item.svgElements || 0) + (item.canvasElements || 0) + (item.backgroundUrlElements || 0) + (item.unicornFrameElements || 0) > 0);
  if (complexExpected.length) {
    const missingLocalImages = complexExpected
      .filter(item => (pptx.slides[item.index - 1]?.pictureCount || 0) <= 0)
      .map(item => item.index);
    if (missingLocalImages.length) {
      failures.push(`Slides with SVG/canvas/background URL images must emit local image objects: ${missingLocalImages.slice(0, 12).join(', ')}.`);
    }
  }

  const richExpected = expectations.filter(item => item.maxDepth >= 6 || item.borderElements >= 8 || item.shadowElements >= 4 || item.textNodeRects >= 25);
  const summaries = Array.isArray(report.slideSummaries) ? report.slideSummaries : [];
  const flatCaptures = richExpected
    .filter(item => {
      const summary = summaries[item.index - 1];
      const slide = pptx.slides[item.index - 1];
      const minText = item.textNodeRects >= 6 ? Math.max(2, Math.ceil(item.textNodeRects * 0.35)) : 0;
      const minForeground = item.elementCount >= 20 ? Math.max(4, Math.ceil(item.elementCount * 0.08)) : 0;
      const hasForeground = slide
        && slide.text.length >= minText
        && foregroundObjectCount(slide, item) >= minForeground;
      if ((item.svgElements || item.canvasElements) && summary?.imageNodes > 0) return false;
      return !summary || (summary.capturedNodes < Math.min(40, Math.max(12, Math.floor(item.elementCount * 0.25))) && !hasForeground);
    })
    .map(item => item.index);
  if (flatCaptures.length) {
    failures.push(`Captured tree is too shallow for visually rich slides: ${flatCaptures.slice(0, 12).join(', ')}.`);
  }

  const foregroundLoss = expectations
    .filter(item => item.textNodeRects >= 6 || item.elementCount >= 20)
    .map(item => {
      const slide = pptx.slides[item.index - 1];
      if (!slide) return { item, lost: true, detail: 'missing-slide' };
      const minText = item.textNodeRects >= 6 ? Math.max(2, Math.ceil(item.textNodeRects * 0.35)) : 0;
      const minForeground = item.elementCount >= 20 ? Math.max(4, Math.ceil(item.elementCount * 0.08)) : 0;
      const foreground = foregroundObjectCount(slide, item);
      const lost = slide.text.length < minText || foreground < minForeground;
      return { item, lost, detail: `text ${slide.text.length}/${minText}, foreground ${foreground}/${minForeground}, pictures ${slide.pictureCount || 0}, elements ${item.elementCount}` };
    })
    .filter(entry => entry.lost);
  if (foregroundLoss.length) {
    failures.push(`Slides appear to have lost foreground content: ${foregroundLoss.slice(0, 12).map(entry => `${entry.item.index} (${entry.detail})`).join(', ')}.`);
  }

  if (!visual.available) {
    failures.push(`Quick Look visual comparison was unavailable: ${visual.reason}`);
  }
  return failures;
}

function validateSampleVisuals(samples) {
  const failures = [];
  if (!samples.length) {
    failures.push('Visual fidelity validation did not select any multi-page samples.');
    return failures;
  }
  if (samples.length < cliSamplesPerTheme) {
    failures.push(`Visual fidelity validation selected only ${samples.length} sample page(s), expected ${cliSamplesPerTheme}.`);
  }
  for (const sample of samples) {
    const label = `${sample.label || 'sample'} slide ${sample.index}`;
    if (sample.pptx?.slideCount !== 1) failures.push(`${label} did not render as a single-slide visual sample.`);
    if (sample.pptx?.fullSlideImageOnlySlides?.length) failures.push(`${label} became a full-slide-image-only PPTX sample.`);
    failures.push(...validateSampleStructure(sample, label));
    const visual = sample.quickLook;
    if (!visual?.available) {
      failures.push(`${label} Quick Look comparison unavailable: ${visual?.reason || sample.reason || 'unknown'}.`);
      continue;
    }
    if (visual.normalizedRmse > VISUAL_RMSE_LIMIT) failures.push(`${label} RMSE ${visual.normalizedRmse.toFixed(4)} exceeds ${VISUAL_RMSE_LIMIT.toFixed(4)}.`);
    if (visual.edgeRmse > VISUAL_EDGE_RMSE_LIMIT) failures.push(`${label} edge RMSE ${visual.edgeRmse.toFixed(4)} exceeds ${VISUAL_EDGE_RMSE_LIMIT.toFixed(4)}.`);
    if (visual.meanAbsoluteError > VISUAL_MAE_LIMIT) failures.push(`${label} MAE ${visual.meanAbsoluteError.toFixed(4)} exceeds ${VISUAL_MAE_LIMIT.toFixed(4)}.`);
    for (const textFailure of sample.textLayoutFailures || []) failures.push(`${label} ${textFailure}`);
    for (const highlightFailure of validateHighlightChecks(sample.highlightChecks || [])) failures.push(`${label} ${highlightFailure}`);
    for (const slotFailure of validateSlotChecks(sample.slotChecks || [])) failures.push(`${label} ${slotFailure}`);
  }
  return failures;
}

async function collectHighlightAnchorRects(page, sample) {
  const anchors = SAMPLE_HIGHLIGHT_ANCHORS.get(`${cliThemePack || ''}:${sample.index}`) || [];
  if (!anchors.length) return [];
  return page.evaluate((items) => {
    const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!slide) return items.map(item => ({ ...item, found: false, reason: 'missing-active-slide' }));
    const slideRect = slide.getBoundingClientRect();
    const normalize = value => String(value || '').replace(/\s+/g, '');
    const visibleRect = (rect) => {
      const left = Math.max(rect.left, slideRect.left);
      const top = Math.max(rect.top, slideRect.top);
      const right = Math.min(rect.right, slideRect.right);
      const bottom = Math.min(rect.bottom, slideRect.bottom);
      if (right <= left || bottom <= top) return null;
      return { x: left - slideRect.left, y: top - slideRect.top, w: right - left, h: bottom - top };
    };
    const isVisible = (el) => {
      if (!el) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1
        && rect.right >= slideRect.left && rect.left <= slideRect.right
        && rect.bottom >= slideRect.top && rect.top <= slideRect.bottom;
    };

    return items.map(item => {
      const target = normalize(item.text);
      const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
      let best = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement;
        if (!isVisible(parent)) continue;
        if (!normalize(node.textContent).includes(target)) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const rect = visibleRect(range.getBoundingClientRect());
        range.detach?.();
        if (!rect || rect.w < 2 || rect.h < 2) continue;
        const style = getComputedStyle(parent);
        const score = rect.w * rect.h + (parseFloat(style.fontSize || '0') || 0) * 100;
        if (!best || score > best.score) {
          best = {
            ...item,
            found: true,
            rect,
            slide: { w: slideRect.width, h: slideRect.height },
            style: {
              color: style.color,
              backgroundImage: style.backgroundImage,
              backgroundClip: style.backgroundClip,
              webkitBackgroundClip: style.webkitBackgroundClip,
              webkitTextFillColor: style.webkitTextFillColor,
              fontSize: style.fontSize,
            },
            score,
          };
        }
      }
      return best || { ...item, found: false, reason: 'text-anchor-not-found' };
    });
  }, anchors);
}

function analyzeHighlightAnchors(anchors, visual) {
  if (!anchors.length) return [];
  return anchors.map(anchor => {
    if (!anchor.found) return anchor;
    if (!visual?.available) return { ...anchor, available: false, reason: 'quicklook-unavailable' };
    const compareDir = path.dirname(visual.htmlImage);
    const htmlCrop = path.join(compareDir, `html-anchor-${anchor.id}.png`);
    const pptxCrop = path.join(compareDir, `pptx-anchor-${anchor.id}.png`);
    const htmlStats = cropHighlightStats(visual.htmlImage, anchor, htmlCrop);
    const pptxStats = cropHighlightStats(visual.pptxImage, anchor, pptxCrop);
    return {
      ...anchor,
      available: Boolean(htmlStats && pptxStats),
      htmlCrop,
      pptxCrop,
      htmlStats,
      pptxStats,
      reason: htmlStats && pptxStats ? undefined : 'crop-analysis-failed',
    };
  });
}

function cropHighlightStats(imagePath, anchor, outPath) {
  if (!imagePath || !existsSync(imagePath) || !anchor?.rect || !anchor?.slide) return null;
  const crop = anchorCropSpec(anchor);
  const save = spawnSync('magick', [imagePath, '-crop', crop.spec, outPath], { encoding: 'utf8' });
  if (save.status !== 0) return null;
  const raw = spawnSync('magick', [imagePath, '-crop', crop.spec, '-depth', '8', 'rgb:-'], {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (raw.status !== 0 || !raw.stdout?.length) return null;
  return summarizeHighlightPixels(raw.stdout);
}

function anchorCropSpec(anchor) {
  const scaleX = 960 / Number(anchor.slide.w || 1920);
  const scaleY = 540 / Number(anchor.slide.h || 1080);
  const padX = 5;
  const padY = 4;
  const x = Math.max(0, Math.floor(anchor.rect.x * scaleX - padX));
  const y = Math.max(0, Math.floor(anchor.rect.y * scaleY - padY));
  const right = Math.min(960, Math.ceil((anchor.rect.x + anchor.rect.w) * scaleX + padX));
  const bottom = Math.min(540, Math.ceil((anchor.rect.y + anchor.rect.h) * scaleY + padY));
  const w = Math.max(1, right - x);
  const h = Math.max(1, bottom - y);
  return { x, y, w, h, spec: `${w}x${h}+${x}+${y}` };
}

function summarizeHighlightPixels(buffer) {
  const pixels = Math.floor(buffer.length / 3);
  let highlightPixels = 0;
  let nearBlackPixels = 0;
  let brightPixels = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  for (let i = 0; i < pixels; i += 1) {
    const r = buffer[i * 3];
    const g = buffer[i * 3 + 1];
    const b = buffer[i * 3 + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    sumR += r;
    sumG += g;
    sumB += b;
    if (max <= 52) nearBlackPixels += 1;
    if (max >= 92) brightPixels += 1;
    if (max >= 88 && max - min >= 24 && (g >= r + 18 || b >= r + 18) && (g >= 100 || b >= 100)) {
      highlightPixels += 1;
    }
  }
  return {
    pixels,
    highlightPixels,
    highlightRatio: pixels ? highlightPixels / pixels : 0,
    nearBlackRatio: pixels ? nearBlackPixels / pixels : 0,
    brightRatio: pixels ? brightPixels / pixels : 0,
    avgR: pixels ? sumR / pixels : 0,
    avgG: pixels ? sumG / pixels : 0,
    avgB: pixels ? sumB / pixels : 0,
  };
}

function validateHighlightChecks(checks) {
  const failures = [];
  for (const check of checks) {
    if (!check.found) {
      failures.push(`is missing highlight anchor "${check.text}" in the HTML sample (${check.reason || 'not-found'}).`);
      continue;
    }
    if (!check.available) {
      failures.push(`could not analyze highlight anchor "${check.text}" (${check.reason || 'unavailable'}).`);
      continue;
    }
    const htmlRatio = Number(check.htmlStats?.highlightRatio || 0);
    const pptxRatio = Number(check.pptxStats?.highlightRatio || 0);
    const requiredRatio = Math.max(0.006, htmlRatio * 0.35);
    if (pptxRatio < requiredRatio) {
      failures.push(`highlight anchor "${check.text}" lost cyan/green pixels in PPTX crop (${pptxRatio.toFixed(4)} < ${requiredRatio.toFixed(4)}; HTML ${htmlRatio.toFixed(4)}).`);
    }
    if (Number(check.pptxStats?.nearBlackRatio || 0) > 0.9 && Number(check.htmlStats?.nearBlackRatio || 0) < 0.9) {
      failures.push(`highlight anchor "${check.text}" is near-black in the PPTX crop.`);
    }
  }
  return failures;
}

async function collectSlotAnchorRects(page, sample) {
  const anchors = SAMPLE_SLOT_ANCHORS.get(`${cliThemePack || ''}:${sample.index}`) || [];
  if (!anchors.length) return [];
  return page.evaluate((items) => {
    const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!slide) return items.map(item => ({ ...item, found: false, reason: 'missing-active-slide' }));
    const slideRect = slide.getBoundingClientRect();
    const toRect = (rect) => {
      const left = Math.max(rect.left, slideRect.left);
      const top = Math.max(rect.top, slideRect.top);
      const right = Math.min(rect.right, slideRect.right);
      const bottom = Math.min(rect.bottom, slideRect.bottom);
      if (right <= left || bottom <= top) return null;
      return { x: left - slideRect.left, y: top - slideRect.top, w: right - left, h: bottom - top };
    };
    return items.map(item => {
      const el = slide.querySelector(item.selector);
      if (!el) return { ...item, found: false, reason: 'slot-not-found' };
      const rect = toRect(el.getBoundingClientRect());
      if (!rect || rect.w < 4 || rect.h < 4) return { ...item, found: false, reason: 'slot-not-visible' };
      const cap = el.querySelector('.gxn-slot-cap');
      const capRect = cap ? toRect(cap.getBoundingClientRect()) : null;
      const style = getComputedStyle(el);
      return {
        ...item,
        found: true,
        rect,
        capRect,
        slide: { w: slideRect.width, h: slideRect.height },
        style: {
          backgroundImage: style.backgroundImage,
          backgroundColor: style.backgroundColor,
          borderTopColor: style.borderTopColor,
          borderTopWidth: style.borderTopWidth,
          borderTopLeftRadius: style.borderTopLeftRadius,
        },
      };
    });
  }, anchors);
}

function analyzeSlotAnchors(anchors, visual, pptx) {
  if (!anchors.length) return [];
  return anchors.map(anchor => {
    if (!anchor.found) return anchor;
    if (!visual?.available) return { ...anchor, available: false, reason: 'quicklook-unavailable' };
    const compareDir = path.dirname(visual.htmlImage);
    const htmlCrop = path.join(compareDir, `html-slot-${anchor.id}.png`);
    const pptxCrop = path.join(compareDir, `pptx-slot-${anchor.id}.png`);
    const htmlBackgroundCrop = path.join(compareDir, `html-slot-${anchor.id}-background.png`);
    const pptxBackgroundCrop = path.join(compareDir, `pptx-slot-${anchor.id}-background.png`);
    const htmlStats = cropSlotStats(visual.htmlImage, anchor, htmlCrop, htmlBackgroundCrop);
    const pptxStats = cropSlotStats(visual.pptxImage, anchor, pptxCrop, pptxBackgroundCrop);
    return {
      ...anchor,
      available: Boolean(htmlStats && pptxStats),
      htmlCrop,
      pptxCrop,
      htmlBackgroundCrop,
      pptxBackgroundCrop,
      htmlStats,
      pptxStats,
      textObjectPresent: Boolean(pptx?.slides?.[0]?.text?.includes(anchor.text)),
      reason: htmlStats && pptxStats ? undefined : 'slot-crop-analysis-failed',
    };
  });
}

function cropSlotStats(imagePath, anchor, fullOutPath, backgroundOutPath) {
  if (!imagePath || !existsSync(imagePath) || !anchor?.rect || !anchor?.slide) return null;
  const full = slotCropSpec(anchor, { x: 0, y: 0, w: 1, h: 1 });
  const background = slotCropSpec(anchor, { x: 0.08, y: 0.08, w: 0.84, h: 0.22 });
  const fullSave = spawnSync('magick', [imagePath, '-crop', full.spec, fullOutPath], { encoding: 'utf8' });
  if (fullSave.status !== 0) return null;
  const bgSave = spawnSync('magick', [imagePath, '-crop', background.spec, backgroundOutPath], { encoding: 'utf8' });
  if (bgSave.status !== 0) return null;
  const raw = spawnSync('magick', [imagePath, '-crop', background.spec, '-depth', '8', 'rgb:-'], {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (raw.status !== 0 || !raw.stdout?.length) return null;
  return summarizeTexturePixels(raw.stdout, background.w, background.h);
}

function slotCropSpec(anchor, inset) {
  const scaleX = 960 / Number(anchor.slide.w || 1920);
  const scaleY = 540 / Number(anchor.slide.h || 1080);
  const x = Math.max(0, Math.floor((anchor.rect.x + anchor.rect.w * inset.x) * scaleX));
  const y = Math.max(0, Math.floor((anchor.rect.y + anchor.rect.h * inset.y) * scaleY));
  const w = Math.max(1, Math.ceil(anchor.rect.w * inset.w * scaleX));
  const h = Math.max(1, Math.ceil(anchor.rect.h * inset.h * scaleY));
  return { x, y, w, h, spec: `${w}x${h}+${x}+${y}` };
}

function summarizeTexturePixels(buffer, width, height) {
  const pixels = Math.min(width * height, Math.floor(buffer.length / 3));
  const luma = new Float32Array(pixels);
  let sum = 0;
  let sum2 = 0;
  let nearSolid = 0;
  for (let i = 0; i < pixels; i += 1) {
    const r = buffer[i * 3];
    const g = buffer[i * 3 + 1];
    const b = buffer[i * 3 + 2];
    const value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luma[i] = value;
    sum += value;
    sum2 += value * value;
  }
  let edge = 0;
  let edgeCount = 0;
  let diagonal = 0;
  let diagonalCount = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = y * width + x;
      const current = luma[offset];
      if (x + 1 < width) {
        edge += Math.abs(current - luma[offset + 1]);
        edgeCount += 1;
      }
      if (y + 1 < height) {
        edge += Math.abs(current - luma[offset + width]);
        edgeCount += 1;
      }
      if (x + 1 < width && y + 1 < height) {
        diagonal += Math.abs(current - luma[offset + width + 1]);
        diagonalCount += 1;
      }
      if (current < 18) nearSolid += 1;
    }
  }
  const mean = pixels ? sum / pixels : 0;
  const variance = pixels ? sum2 / pixels - mean * mean : 0;
  return {
    pixels,
    mean,
    sd: Math.sqrt(Math.max(0, variance)),
    edgeMean: edgeCount ? edge / edgeCount : 0,
    diagonalMean: diagonalCount ? diagonal / diagonalCount : 0,
    nearDarkRatio: pixels ? nearSolid / pixels : 0,
  };
}

function validateSlotChecks(checks) {
  const failures = [];
  for (const check of checks) {
    if (!check.found) {
      failures.push(`is missing image slot "${check.id}" in the HTML sample (${check.reason || 'not-found'}).`);
      continue;
    }
    if (!check.available) {
      failures.push(`could not analyze image slot "${check.id}" (${check.reason || 'unavailable'}).`);
      continue;
    }
    if (!check.textObjectPresent) {
      failures.push(`image slot "${check.id}" placeholder text "${check.text}" is not exported as an editable PPT text object.`);
    }
    const htmlEdge = Number(check.htmlStats?.edgeMean || 0);
    const pptxEdge = Number(check.pptxStats?.edgeMean || 0);
    const htmlSd = Number(check.htmlStats?.sd || 0);
    const pptxSd = Number(check.pptxStats?.sd || 0);
    const requiredEdge = Math.max(0.18, htmlEdge * 0.35);
    const requiredSd = Math.max(0.7, htmlSd * 0.3);
    if (pptxEdge < requiredEdge || pptxSd < requiredSd) {
      failures.push(`image slot "${check.id}" lost the diagonal texture/background variation in PPTX crop (edge ${pptxEdge.toFixed(3)} < ${requiredEdge.toFixed(3)} or sd ${pptxSd.toFixed(3)} < ${requiredSd.toFixed(3)}; HTML edge ${htmlEdge.toFixed(3)}, sd ${htmlSd.toFixed(3)}).`);
    }
  }
  return failures;
}

function validateSampleStructure(sample, label) {
  const failures = [];
  const expected = sample.expected || {};
  const pptx = sample.pptx || {};
  const expectedText = Number(expected.textNodeRects || 0);
  if (expectedText >= 6) {
    const minText = Math.max(2, Math.ceil(expectedText * 0.5));
    if (Number(pptx.textCount || 0) < minText) {
      failures.push(`${label} is missing editable text content (${pptx.textCount || 0} text objects for ${expectedText} visible text rects).`);
    }
  }
  const expectedComplexImage = Number(expected.svgElements || 0) + Number(expected.canvasElements || 0) + Number(expected.backgroundUrlElements || 0) + Number(expected.unicornFrameElements || 0);
  if (expectedComplexImage > 0 && Number(pptx.pictureCount || 0) <= 0) {
    failures.push(`${label} expected local image fallback objects for SVG/canvas/background media, but exported none.`);
  }
  if (Number(expected.elementCount || 0) >= 20) {
    const nonBackgroundObjects = foregroundObjectCount({ text: Array.from({ length: Number(pptx.textCount || 0) }), pictureCount: Number(pptx.pictureCount || 0) }, expected);
    if (nonBackgroundObjects < Math.max(4, Math.ceil(Number(expected.elementCount || 0) * 0.12))) {
      failures.push(`${label} appears to have lost foreground content (${nonBackgroundObjects} text/image objects for ${expected.elementCount} visible elements).`);
    }
  }
  return failures;
}

function foregroundObjectCount(slide, expected) {
  const textCount = Array.isArray(slide?.text) ? slide.text.length : Number(slide?.textCount || 0);
  const pictureCount = Number(slide?.pictureCount || 0);
  return textCount + pictureCount * 8;
}

function validateSampleTextLayout(sample, pptx) {
  if (cliThemePack && cliThemePack !== 'theme01') return [];
  const anchors = SAMPLE_TEXT_LAYOUT_ANCHORS.get(sample.index) || [];
  const slide = pptx.slides[0];
  const failures = [];
  for (const anchor of anchors) {
    const box = slide?.textBoxes?.find(item => item.text === anchor.text);
    if (!box) {
      failures.push(`is missing text box "${anchor.text}".`);
      continue;
    }
    if (anchor.align && box.align !== anchor.align) {
      failures.push(`text "${anchor.text}" has align ${box.align || 'none'}, expected ${anchor.align}.`);
    }
    if (box.w > anchor.maxWidth) {
      failures.push(`text "${anchor.text}" box is too wide (${box.w.toFixed(2)}in > ${anchor.maxWidth.toFixed(2)}in), which can push aligned text out of position.`);
    }
  }
  return failures;
}

function summarizeVisualReport(report) {
  const summaries = Array.isArray(report.slideSummaries) ? report.slideSummaries : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  return {
    captureMode: report.captureMode || null,
    slideCount: report.slideCount,
    textObjects: report.textObjects,
    shapeObjects: report.shapeObjects,
    imageObjects: report.imageObjects,
    warningCount: warnings.length,
    fallbackTextRiskCount: warnings.filter(warning => warning?.type === 'node-image-fallback-text-risk').length,
    slideSummaries: summaries.slice(0, 5),
  };
}

function runQuickLookVisualComparison(pptxFile, htmlScreenshot, visualDir) {
  if (!htmlScreenshot || !existsSync(htmlScreenshot)) return { available: false, reason: 'missing-html-screenshot' };
  if (!commandAvailable('qlmanage')) return { available: false, reason: 'qlmanage-not-found' };
  if (!commandAvailable('magick')) return { available: false, reason: 'magick-not-found' };
  const quickLookDir = path.join(visualDir, 'quicklook');
  const compareDir = path.join(visualDir, 'compare');
  rmSync(quickLookDir, { recursive: true, force: true });
  rmSync(compareDir, { recursive: true, force: true });
  mkdirSync(quickLookDir, { recursive: true });
  mkdirSync(compareDir, { recursive: true });
  const ql = spawnSync('qlmanage', ['-t', '-x', '-s', '960', '-o', quickLookDir, pptxFile], { encoding: 'utf8' });
  if (ql.status !== 0) return { available: false, reason: `qlmanage-failed:${ql.stderr || ql.stdout}` };
  const png = readdirSync(quickLookDir).find(name => name.endsWith('.png'));
  if (!png) return { available: false, reason: 'qlmanage-produced-no-png' };
  const pptxPreview = path.join(quickLookDir, png);
  const htmlNorm = path.join(compareDir, 'html-960.png');
  const pptxNorm = path.join(compareDir, 'pptx-960.png');
  const resizeHtml = spawnSync('magick', [htmlScreenshot, '-resize', '960x540!', htmlNorm], { encoding: 'utf8' });
  if (resizeHtml.status !== 0) return { available: false, reason: `html-resize-failed:${resizeHtml.stderr || resizeHtml.stdout}` };
  const resizePptx = spawnSync('magick', [pptxPreview, '-resize', '960x540!', pptxNorm], { encoding: 'utf8' });
  if (resizePptx.status !== 0) return { available: false, reason: `pptx-resize-failed:${resizePptx.stderr || resizePptx.stdout}` };
  const normalizedRmse = compareImageMetric('RMSE', htmlNorm, pptxNorm);
  const meanAbsoluteError = compareImageMetric('MAE', htmlNorm, pptxNorm);
  const htmlEdge = path.join(compareDir, 'html-edge.png');
  const pptxEdge = path.join(compareDir, 'pptx-edge.png');
  const edgeHtml = spawnSync('magick', [htmlNorm, '-colorspace', 'Gray', '-edge', '1', htmlEdge], { encoding: 'utf8' });
  if (edgeHtml.status !== 0) return { available: false, reason: `html-edge-failed:${edgeHtml.stderr || edgeHtml.stdout}` };
  const edgePptx = spawnSync('magick', [pptxNorm, '-colorspace', 'Gray', '-edge', '1', pptxEdge], { encoding: 'utf8' });
  if (edgePptx.status !== 0) return { available: false, reason: `pptx-edge-failed:${edgePptx.stderr || edgePptx.stdout}` };
  const edgeRmse = compareImageMetric('RMSE', htmlEdge, pptxEdge);
  if (![normalizedRmse, meanAbsoluteError, edgeRmse].every(Number.isFinite)) return { available: false, reason: 'image-metric-parse-failed' };
  return {
    available: true,
    normalizedRmse,
    edgeRmse,
    meanAbsoluteError,
    htmlImage: htmlNorm,
    pptxImage: pptxNorm,
    htmlEdge,
    pptxEdge,
  };
}

function compareImageMetric(metric, left, right) {
  const compare = spawnSync('magick', ['compare', '-metric', metric, left, right, 'null:'], { encoding: 'utf8' });
  const output = `${compare.stderr || ''}${compare.stdout || ''}`;
  const match = output.match(/\((0(?:\.\d+)?|1(?:\.0+)?)\)/);
  return match ? Number(match[1]) : Number.NaN;
}

function parseJsonProcessOutput(stdout, stderr) {
  const sources = [stdout || '', stderr || '', `${stdout || ''}\n${stderr || ''}`];
  for (const source of sources) {
    const combined = source.trim();
    if (combined.startsWith('{') && combined.endsWith('}')) {
      try {
        return JSON.parse(combined);
      } catch {}
    }
    const last = combined.lastIndexOf('}');
    if (last < 0) continue;
    const starts = [];
    for (let index = combined.lastIndexOf('\n{', last); index >= 0 && starts.length < 20; index = combined.lastIndexOf('\n{', index - 1)) {
      starts.push(index + 1);
    }
    starts.push(combined.indexOf('{'));
    for (const first of [...new Set(starts)].filter(index => index >= 0 && index < last)) {
      try {
        return JSON.parse(combined.slice(first, last + 1));
      } catch {}
    }
  }
  const combined = `${stdout || ''}\n${stderr || ''}`.trim();
  return { parseError: true, raw: combined.slice(0, 4000) };
}

function summarizeMatrixTheme(themePack, result, status) {
  const failures = Array.isArray(result?.failures) ? result.failures : [`validation process exited with status ${status}`];
  const samples = Array.isArray(result?.samples) ? result.samples.map(sample => ({
    index: sample.index,
    key: sample.key || '',
    label: sample.label || '',
    types: sample.types || [],
    htmlImage: sample.quickLook?.htmlImage || sample.htmlScreenshot || null,
    pptxImage: sample.quickLook?.pptxImage || null,
    pairImage: sample.pairImage || null,
    rmse: sample.quickLook?.normalizedRmse ?? null,
    edgeRmse: sample.quickLook?.edgeRmse ?? null,
    mae: sample.quickLook?.meanAbsoluteError ?? null,
    expected: sample.expected || null,
    pptx: sample.pptx || null,
  })) : [];
  return {
    themePack,
    passed: status === 0 && result?.passed === true,
    expectedSlides: result?.expectedSlides ?? null,
    failureCategories: categorizeFailures(failures, result),
    failures,
    samples,
    contactSheet: result?.contactSheet || null,
    fullDeck: result?.pptx || null,
    report: result?.report || null,
    validationAttempts: result?.validationAttempts ?? null,
    parseError: result?.parseError || false,
  };
}

function summarizeFallbackTextRisk(result, status) {
  return {
    passed: status === 0 && result?.passed === true,
    themePack: result?.themePack || 'theme03',
    riskCount: result?.riskCount ?? null,
    extractedCount: result?.extractedCount ?? null,
    expectedRiskCount: result?.expectedRiskCount ?? null,
    extracted: Array.isArray(result?.extracted) ? result.extracted.slice(0, 20) : [],
    risks: Array.isArray(result?.risks) ? result.risks.slice(0, 20) : [],
    failures: Array.isArray(result?.failures) ? result.failures : [`validation process exited with status ${status}`],
    parseError: result?.parseError || false,
  };
}

function categorizeFailures(failures, result) {
  const categories = new Set();
  const text = failures.join('\n');
  if (/text|foreground content|主体|editable text/i.test(text)) categories.add('content-loss');
  if (/RMSE|MAE|visual/i.test(text)) categories.add('visual-drift');
  if (/edge RMSE|align|layout|too wide|position/i.test(text)) categories.add('alignment-layout');
  if (/background|gradient|fill/i.test(text)) categories.add('background-fill');
  if (/SVG|canvas|fallback|image objects|media/i.test(text)) categories.add('complex-node-fallback');
  if (/Captured tree is too shallow|captured-tree|DOM/i.test(text)) categories.add('capture-depth');
  if (/animation|opacity|transition/i.test(text)) categories.add('animation-final-state');
  if (result?.report?.fallbackTextRiskCount > 0) categories.add('fallback-text-baked');
  return [...categories];
}

function commandAvailable(name) {
  return spawnSync('which', [name], { stdio: 'ignore' }).status === 0;
}

function inspectUiExportPath() {
  const html = readFileSync(TEMPLATE, 'utf8');
  const start = html.indexOf('window.__exportDeckPptx = async function');
  const end = html.indexOf('function buildEditablePptxExportSnapshot', start);
  const source = start >= 0 && end > start ? html.slice(start, end) : '';
  const failures = [];
  if (/response\.blob\s*\(/.test(source) || /downloadBlob\s*\(/.test(source)) {
    failures.push('UI PPTX export must not use response.blob() + downloadBlob() as the primary path.');
  }
  if (!/\/api\/export-editable-pptx/.test(source)) {
    failures.push('UI PPTX export must call the editable server export endpoint.');
  }
  if (!/downloadUrl/.test(source)) {
    failures.push('UI PPTX export must trigger a same-origin server download URL after editable export.');
  }
  return failures;
}

function validateDownloadedPptx(file, suggestedFilename) {
  const failures = [];
  if (!/\.pptx$/i.test(String(suggestedFilename || ''))) {
    failures.push(`Browser download filename should end with .pptx, got ${suggestedFilename || 'empty'}.`);
  }
  const header = readFileSync(file).subarray(0, PPTX_SIGNATURE.length);
  if (!header.equals(PPTX_SIGNATURE)) {
    failures.push('Browser download file does not have a PPTX/ZIP signature.');
  }
  return failures;
}

function validateDownloadHeaders(result) {
  const failures = [];
  if (!result) {
    failures.push('UI PPTX export did not expose a server download URL for header validation.');
    return failures;
  }
  if (result.statusCode !== 200) {
    failures.push(`Server download URL returned ${result.statusCode}, expected 200.`);
  }
  const disposition = String(result.headers?.['content-disposition'] || '');
  if (!/\battachment\b/i.test(disposition)) {
    failures.push(`Server download URL must use Content-Disposition attachment, got "${disposition || 'empty'}".`);
  }
  const type = String(result.headers?.['content-type'] || '');
  if (!/presentationml\.presentation/i.test(type)) {
    failures.push(`Server download URL should return PPTX content type, got "${type || 'empty'}".`);
  }
  return failures;
}

function readDownloadHeaders(downloadUrl) {
  return new Promise(resolve => {
    const req = https.request(downloadUrl, { method: 'HEAD', rejectUnauthorized: false }, res => {
      res.resume();
      resolve({ statusCode: res.statusCode, headers: res.headers });
    });
    req.on('error', error => resolve({ statusCode: 0, headers: {}, error: error.message || String(error) }));
    req.end();
  });
}

async function runLegacyRedValidation() {
  const staticFindings = inspectLegacyBrowserPptxPath();
  const { url, close } = await renderValidationDeck();
  const pptxFile = path.join(OUT_DIR, 'legacy-browser-export.pptx');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let page;
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(45000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    await page.goto(`${url}?legacy_red=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    const downloadPromise = page.waitForEvent('download', { timeout: 90000 });
    await page.evaluate(() => window.__exportDeckPptx?.());
    const download = await downloadPromise;
    await download.saveAs(pptxFile);
  } finally {
    await closePage(page);
    await closeBrowser(browser);
    await close();
  }

  const pptx = inspectPptx(pptxFile);
  const failures = [];
  if (staticFindings.usesHtmlToImage) failures.push('Legacy browser PPTX path calls htmlToImage.toPng / captureSlideImage.');
  if (staticFindings.usesFullSlideAddImage) failures.push('Legacy browser PPTX path writes each slide as a full-slide addImage.');
  if (pptx.textCount === 0) failures.push('Legacy browser PPTX export contains no editable text nodes in slide XML.');
  if (pptx.fullSlideImageOnlySlides.length) failures.push(`Legacy browser PPTX has full-slide-image-only pages: ${pptx.fullSlideImageOnlySlides.join(', ')}.`);

  console.error(JSON.stringify({
    mode: 'legacy-red',
    passed: false,
    expectedFailure: true,
    staticFindings,
    pptx: summarizeInspection(pptx),
    failures,
  }, null, 2));
  process.exit(1);
}

async function runEditableExportValidation() {
  const exportSource = readFileSync(path.join(ROOT, 'src/export-pptx/editable.mjs'), 'utf8');
  const staticFailures = inspectEditableExportSource(exportSource);
  const { url, close } = await renderValidationDeck();
  const pptxFile = path.join(OUT_DIR, 'editable-export.pptx');
  const reportFile = path.join(OUT_DIR, 'editable-export-report.json');
  const filteredPptxFile = path.join(OUT_DIR, 'editable-theme-filter-export.pptx');
  const filteredReportFile = path.join(OUT_DIR, 'editable-theme-filter-report.json');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  let page;
  let mutation = null;
  try {
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(45000);
    await page.goto(`${url}?editable_validation=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    const visibleGuard = await runThemeFilterGuard(page, filteredPptxFile, filteredReportFile);
    if (!visibleGuard.passed) staticFailures.push(visibleGuard.message);

    mutation = await applyUserEdits(page);
    if (!mutation.textEdited) staticFailures.push('Validation could not simulate a user text edit.');
    if (!mutation.imageEdited) staticFailures.push('Validation could not simulate a user image slot edit.');

    const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
    const result = await mod.exportEditablePptxFromPage(page, {
      outFile: pptxFile,
      reportFile,
      title: 'JAD-64 Editable Export Validation',
      includeAllThemePacks: true,
    });
    if (result.slideCount !== EXPECTED_SLIDES) {
      staticFailures.push(`Editable exporter returned ${result.slideCount} slide(s), expected ${EXPECTED_SLIDES}.`);
    }
  } finally {
    await closePage(page);
    await closeBrowser(browser);
    await close();
  }

  const pptx = inspectPptx(pptxFile);
  const filteredPptx = inspectPptx(filteredPptxFile);
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  const failures = [
    ...staticFailures,
    ...validateEditablePptxInspection(pptx, {
      expectSlides: EXPECTED_SLIDES,
      mutation,
      requireEditedText: true,
      requireReplacementImage: true,
    }),
  ];
  if (filteredPptx.slideCount !== THEME_FILTER_EXPECTED_SLIDES) failures.push(`Default export ignored current theme filter: got ${filteredPptx.slideCount} slide(s), expected ${THEME_FILTER_EXPECTED_SLIDES}.`);
  if (!report?.warnings || !Array.isArray(report.warnings)) failures.push('Editable exporter did not write a warnings report.');

  const result = {
    mode: 'editable-export',
    passed: failures.length === 0,
    pptx: summarizeInspection(pptx),
    themeFilterGuard: summarizeInspection(filteredPptx),
    report: report ? {
      slideCount: report.slideCount,
      textObjects: report.textObjects,
      shapeObjects: report.shapeObjects,
      imageObjects: report.imageObjects,
      warningCount: report.warnings.length,
    } : null,
    failures,
  };

  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}

function validateEditablePptxInspection(pptx, { expectSlides, mutation, requireEditedText = false, requireReplacementImage = false } = {}) {
  const failures = [];
  if (expectSlides !== null && expectSlides !== undefined && pptx.slideCount !== expectSlides) failures.push(`PPTX has ${pptx.slideCount} slide(s), expected ${expectSlides}.`);
  if (pptx.textCount <= 0) failures.push('PPTX slide XML has no <a:t> editable text nodes.');
  if (pptx.textCount > 0 && pptx.autoFitTextCount <= 0) failures.push('PPTX slide XML has no auto-width text boxes (<a:spAutoFit/>).');
  if (expectSlides && pptx.textCount < expectSlides) failures.push(`PPTX has too few editable text nodes: ${pptx.textCount} for ${expectSlides} slide(s).`);
  if (requireEditedText && !pptx.allText.includes(EDITED_TEXT)) failures.push('User-edited text sentinel is missing from PPTX text nodes.');
  if (pptx.shapeCount <= 0) failures.push('PPTX slide XML has no shape objects.');
  if (expectSlides && pptx.shapeCount < expectSlides) failures.push(`PPTX has too few shape objects: ${pptx.shapeCount} for ${expectSlides} slide(s).`);
  if (pptx.pictureCount <= 0) failures.push('PPTX slide XML has no image objects.');
  if (requireReplacementImage) {
    if (!pptx.mediaHashes.includes(REPLACEMENT_IMAGE_HASH)) failures.push('Replacement image hash is missing from ppt/media/*.');
    if (REPLACEMENT_IMAGE_HASH === INITIAL_IMAGE_HASH) failures.push('Replacement image hash unexpectedly equals the initial image hash.');
    if (mutation?.imageSlideNumber && !pptx.slides[mutation.imageSlideNumber - 1]?.pictureMediaHashes.includes(REPLACEMENT_IMAGE_HASH)) {
      failures.push(`Replacement image is not referenced by target slide ${mutation.imageSlideNumber}.`);
    }
  }
  if (pptx.fullSlideImageOnlySlides.length) failures.push(`PPTX has full-slide-image-only pages: ${pptx.fullSlideImageOnlySlides.join(', ')}.`);
  if (expectSlides && pptx.uniqueSlideHashes !== expectSlides) failures.push('Slide XML content hashes repeat; page switching may have failed.');
  return failures;
}

function inspectLegacyBrowserPptxPath() {
  const html = readFileSync(TEMPLATE, 'utf8');
  const start = html.indexOf('window.__exportDeckPptx = async function');
  const end = html.indexOf('window.__exportDeckHtml', start);
  const source = start >= 0 && end > start ? html.slice(start, end) : '';
  return {
    hasExportFunction: start >= 0,
    usesHtmlToImage: /htmlToImage\.toPng|captureSlideImage/.test(source) && /loadExportScript\(['"]assets\/vendor\/html-to-image\.js/.test(source),
    usesFullSlideAddImage: /pptSlide\.addImage\(\{\s*data:\s*imageData,\s*x:\s*0,\s*y:\s*0,\s*w:\s*PPT_W,\s*h:\s*PPT_H\s*\}\)/.test(source),
  };
}

function inspectEditableExportSource(source) {
  const failures = [];
  if (/htmlToImage\.toPng|captureSlideImage/.test(source)) {
    failures.push('Editable export path must not call htmlToImage.toPng or captureSlideImage.');
  }
  if (/addImage\(\{[^}]*x:\s*0[^}]*y:\s*0[^}]*w:\s*(?:PPT_W|16)[^}]*h:\s*(?:PPT_H|9)/s.test(source)) {
    failures.push('Editable export path must not add a full-slide image.');
  }
  return failures;
}

async function renderValidationDeck() {
  cleanEditableExportValidationOutputs();
  mkdirSync(OUT_DIR, { recursive: true });
  const configFile = path.join(OUT_DIR, 'validation-deck.jsx');
  const indexFile = path.join(OUT_DIR, 'ppt/index.html');
  writeFileSync(configFile, createValidationDeckSource());
  const render = spawnSync(path.join(ROOT, 'node_modules/.bin/tsx'), [
    path.join(ROOT, 'scripts/render-deck.jsx'),
    configFile,
    indexFile,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  if (render.status !== 0) {
    throw new Error(`Validation deck render failed:\n${render.stdout}\n${render.stderr}`);
  }
  const server = await startStaticServer(path.dirname(indexFile));
  return server;
}

function cleanEditableExportValidationOutputs() {
  for (const name of [
    'editable-export.pptx',
    'editable-export-report.json',
    'editable-theme-filter-export.pptx',
    'editable-theme-filter-report.json',
    'validation-deck.jsx',
    'ppt',
  ]) {
    rmSync(path.join(OUT_DIR, name), { recursive: true, force: true });
  }
}

function createValidationDeckSource() {
  return `import { slide } from '../../src/options.jsx';

const initialImg = '${INITIAL_IMAGE}';

export default {
  title: 'JAD-64 Editable Export Validation',
  preview: { themeSwitcher: true },
  slides: [
    slide('theme01_page001', {
      title: 'Theme01 Editable Cover',
      titleLines: ['Theme01 Editable Cover', 'Text object baseline'],
    }),
    slide('theme01_page008', {
      title: 'Theme01 Image Slot Baseline',
      imageSlotCount: 1,
      images: [initialImg],
      caption: 'Theme01 image object baseline',
    }),
    slide('theme02_page001', {
      title: 'Theme02 Editable Cover',
      titleEm: 'Text object baseline',
      imageCount: 1,
      images: [initialImg],
    }),
    slide('theme02_page006', {
      title: 'Theme02 Shape Baseline',
      subtitle: 'Color blocks and text are exported as editable objects.',
    }),
    slide('theme03_page001', {
      title: 'Theme03 Editable Cover',
      imageCount: 1,
      images: [{ src: initialImg, kind: 'image' }],
    }),
    slide('theme03_page005', {
      title: 'Theme03 Image Baseline',
      imageCount: 1,
      images: [{ src: initialImg, kind: 'image' }],
    }),
  ],
};
`;
}

async function runThemeFilterGuard(page, outFile, reportFile) {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/export-pptx/editable.mjs')));
  await page.evaluate(async () => {
    window.__setActiveThemePack?.('theme02', { navigate: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const visibleCount = await page.evaluate(() => (window.__getVisibleSlides?.() || []).length);
  const result = await mod.exportEditablePptxFromPage(page, {
    outFile,
    reportFile,
    title: 'JAD-64 Theme Filter Guard',
  });
  await page.evaluate(async () => {
    window.__setActiveThemePack?.('', { navigate: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  return {
    passed: visibleCount === THEME_FILTER_EXPECTED_SLIDES && result.slideCount === visibleCount,
    message: `Default export should preserve theme-filtered visible slides: visible=${visibleCount}, exported=${result.slideCount}.`,
  };
}

async function applyUserEdits(page) {
  return page.evaluate(({ text, image }) => {
    const result = { textEdited: false, imageEdited: false };
    window.go?.(0, { animate: false, force: true });
    const active = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    const editable = active?.querySelector?.('[data-editable-id]');
    if (editable) {
      editable.textContent = text;
      editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      window.__flushEditableTextState?.();
      window.__syncDeckViewModelFromDom?.();
      result.textEdited = true;
    }

    const slides = window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')];
    const targetIndex = slides.findIndex(slide => {
      const root = slide.querySelector?.('[data-prop-defaults]');
      if (!root) return false;
      try {
        const props = JSON.parse(root.dataset.propDefaults || '{}');
        return Array.isArray(props.images) || 'imageCount' in props || 'imageSlotCount' in props;
      } catch {
        return false;
      }
    });
    if (targetIndex >= 0) {
      const slide = slides[targetIndex];
      const root = slide.querySelector('[data-prop-defaults]');
      let props = {};
      try { props = JSON.parse(root.dataset.propDefaults || '{}') || {}; } catch {}
      const next = {
        ...props,
        imageCount: Number(props.imageCount || props.imageSlotCount || 1),
        imageSlotCount: Number(props.imageSlotCount || props.imageCount || 1),
        images: [{ src: image, kind: 'image' }, image],
      };
      window.__deckViewModel?.setProps?.(slide.dataset.vmSlideId, next);
      window.__renderRuntimeSlide?.(slide, next);
      window.__initEditableText?.(slide);
      window.go?.(targetIndex, { animate: false, force: true });
      result.imageEdited = !!slide.querySelector('img');
      result.imageSlideNumber = targetIndex + 1;
      window.go?.(0, { animate: false, force: true });
    }
    return result;
  }, { text: EDITED_TEXT, image: REPLACEMENT_IMAGE });
}

function inspectPptx(file) {
  if (!existsSync(file)) throw new Error(`Missing PPTX file: ${file}`);
  const entries = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
  const slideEntries = entries
    .filter(entry => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml/)?.[1] || 0) - Number(b.match(/slide(\d+)\.xml/)?.[1] || 0));
  const mediaEntries = entries.filter(entry => /^ppt\/media\/[^/]+$/.test(entry)).sort();
  const media = mediaEntries.map(entry => {
    const bytes = execFileSync('unzip', ['-p', file, entry], { encoding: 'buffer', maxBuffer: 20 * 1024 * 1024 });
    return { entry, hash: hashBuffer(bytes), size: bytes.length };
  });
  const mediaByEntry = new Map(media.map(item => [item.entry, item]));
  const slides = slideEntries.map((entry, index) => {
    const xml = execFileSync('unzip', ['-p', file, entry], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
    const relsEntry = `ppt/slides/_rels/slide${index + 1}.xml.rels`;
    const relsXml = entries.includes(relsEntry) ? execFileSync('unzip', ['-p', file, relsEntry], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }) : '';
    return inspectSlideXml(xml, index + 1, relsXml, mediaByEntry);
  });
  const allText = slides.flatMap(slide => slide.text).join('\n');
  const hashes = new Set(slides.map(slide => slide.hash));
  return {
    file,
    slideCount: slides.length,
    slides,
    allText,
    textCount: slides.reduce((sum, slide) => sum + slide.text.length, 0),
    autoFitTextCount: slides.reduce((sum, slide) => sum + slide.autoFitTextCount, 0),
    shapeCount: slides.reduce((sum, slide) => sum + slide.shapeCount, 0),
    pictureCount: slides.reduce((sum, slide) => sum + slide.pictureCount, 0),
    media,
    mediaHashes: media.map(item => item.hash),
    fullSlideImageOnlySlides: slides.filter(slide => slide.fullSlideImageOnly).map(slide => slide.index),
    uniqueSlideHashes: hashes.size,
  };
}

function inspectExtractedMedia(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  const walk = folder => {
    for (const name of readdirSync(folder, { withFileTypes: true })) {
      const file = path.join(folder, name.name);
      if (name.isDirectory()) walk(file);
      else if (/\.(png|jpe?g|gif)$/i.test(name.name)) files.push(file);
    }
  };
  walk(dir);
  return files.map(file => {
    const identified = commandAvailable('magick')
      ? spawnSync('magick', ['identify', '-format', '%w\t%h\t%[mean]\t%[channels]\t%[opaque]\t%[fx:minima.a]\t%[fx:maxima.a]', file], { encoding: 'utf8' })
      : null;
    const [widthValue, heightValue, meanValue, channels = '', opaqueValue = '', minAlphaValue = '', maxAlphaValue = ''] = String(identified?.stdout || '').trim().split(/\t/);
    const width = Number(widthValue);
    const height = Number(heightValue);
    const mean = Number(meanValue);
    const minAlpha = Number(minAlphaValue);
    const maxAlpha = Number(maxAlphaValue);
    return {
      file,
      relativePath: path.relative(ROOT, file),
      width: Number.isFinite(width) ? width : 0,
      height: Number.isFinite(height) ? height : 0,
      mean: Number.isFinite(mean) ? mean : null,
      channels,
      opaque: /^true$/i.test(opaqueValue),
      minAlpha: Number.isFinite(minAlpha) ? minAlpha : null,
      maxAlpha: Number.isFinite(maxAlpha) ? maxAlpha : null,
      hash: hashBuffer(readFileSync(file)),
      size: readFileSync(file).length,
    };
  });
}

function expandedCropSpec(rect, bounds = {}, pad = 0) {
  const maxW = Number(bounds.w ?? bounds.width ?? Infinity);
  const maxH = Number(bounds.h ?? bounds.height ?? Infinity);
  const x = Math.max(0, Math.floor(Number(rect.x || 0) - pad));
  const y = Math.max(0, Math.floor(Number(rect.y || 0) - pad));
  const right = Math.min(Number.isFinite(maxW) ? maxW : x + Number(rect.w || 0) + pad * 2, Math.ceil(Number(rect.x || 0) + Number(rect.w || 0) + pad));
  const bottom = Math.min(Number.isFinite(maxH) ? maxH : y + Number(rect.h || 0) + pad * 2, Math.ceil(Number(rect.y || 0) + Number(rect.h || 0) + pad));
  return `${Math.max(1, right - x)}x${Math.max(1, bottom - y)}+${x}+${y}`;
}

function inspectSlideXml(xml, index, relsXml, mediaByEntry) {
  const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1]));
  const textBoxes = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)]
    .map(match => inspectTextBoxShape(match[0]))
    .filter(Boolean);
  const shapeCount = (xml.match(/<p:sp\b/g) || []).length;
  const autoFitTextCount = (xml.match(/<a:spAutoFit\/>/g) || []).length;
  const shapeDetails = [...xml.matchAll(/<p:sp\b[\s\S]*?<\/p:sp>/g)].map(match => {
    const shapeXml = match[0];
    const geom = shapeXml.includes('<a:custGeom>')
      ? 'custGeom'
      : shapeXml.match(/<a:prstGeom\b[^>]*\bprst="([^"]+)"/)?.[1] || '';
    const xfrm = shapeXml.match(/<a:xfrm\b([^>]*)>[\s\S]*?<a:off x="(\d+)" y="(\d+)"[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/);
    const rotateRaw = xfrm?.[1]?.match(/\brot="(-?\d+)"/)?.[1];
    return {
      geom,
      rotate: rotateRaw == null ? 0 : Number(rotateRaw) / 60000,
      x: Number(xfrm?.[2] || 0) / EMU_PER_IN,
      y: Number(xfrm?.[3] || 0) / EMU_PER_IN,
      w: Number(xfrm?.[4] || 0) / EMU_PER_IN,
      h: Number(xfrm?.[5] || 0) / EMU_PER_IN,
    };
  }).filter(item => item.geom);
  const shapeGeoms = shapeDetails.map(item => item.geom);
  const pictureCount = (xml.match(/<p:pic\b/g) || []).length;
  const pictures = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)].map(match => {
    const xfrm = match[0].match(/<a:xfrm\b[^>]*>[\s\S]*?<a:off x="(-?\d+)" y="(-?\d+)"[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/);
    const embed = match[0].match(/r:embed="([^"]+)"/);
    const x = Number(xfrm?.[1] || 0);
    const y = Number(xfrm?.[2] || 0);
    const cx = Number(xfrm?.[3] || 0);
    const cy = Number(xfrm?.[4] || 0);
    return {
      x: x / EMU_PER_IN,
      y: y / EMU_PER_IN,
      w: cx / EMU_PER_IN,
      h: cy / EMU_PER_IN,
      cx,
      cy,
      rId: embed?.[1] || '',
      nearFullSlide: cx >= 0.9 * 16 * 914400 && cy >= 0.9 * 9 * 914400,
    };
  });
  const relTargets = parseSlideRelationships(relsXml);
  const pictureMediaHashes = pictures
    .map(picture => relTargets.get(picture.rId))
    .filter(Boolean)
    .map(target => mediaByEntry.get(target)?.hash)
    .filter(Boolean);
  return {
    index,
    text,
    textBoxes,
    shapeGeoms,
    shapeDetails,
    autoFitTextCount,
    shapeCount,
    pictureCount,
    pictures,
    pictureMediaHashes,
    fullSlideImageOnly: text.length === 0 && shapeCount <= 1 && pictures.length === 1 && pictures[0].nearFullSlide,
    hash: createHash('sha256').update(xml.replace(/id="\d+"/g, 'id=""')).digest('hex'),
  };
}

function inspectTextBoxShape(xml) {
  const runs = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1]));
  if (!runs.length) return null;
  const xfrm = xml.match(/<a:xfrm\b([^>]*)>[\s\S]*?<a:off x="(\d+)" y="(\d+)"[\s\S]*?<a:ext cx="(\d+)" cy="(\d+)"/);
  if (!xfrm) return null;
  const rotateRaw = xfrm[1]?.match(/\brot="(-?\d+)"/)?.[1];
  const align = xml.match(/<a:pPr\b[^>]*\balgn="([^"]+)"/)?.[1] || 'l';
  return {
    text: runs.join(''),
    align,
    rotate: rotateRaw == null ? 0 : Number(rotateRaw) / 60000,
    x: Number(xfrm[2]) / EMU_PER_IN,
    y: Number(xfrm[3]) / EMU_PER_IN,
    w: Number(xfrm[4]) / EMU_PER_IN,
    h: Number(xfrm[5]) / EMU_PER_IN,
  };
}

function parseSlideRelationships(xml) {
  const out = new Map();
  for (const match of xml.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"/g)) {
    const target = match[2].replace(/^\.\.\//, 'ppt/');
    out.set(match[1], target);
  }
  return out;
}

function summarizeInspection(pptx) {
  return {
    file: pptx.file,
    slideCount: pptx.slideCount,
    textCount: pptx.textCount,
    autoFitTextCount: pptx.autoFitTextCount,
    shapeCount: pptx.shapeCount,
    pictureCount: pptx.pictureCount,
    mediaCount: pptx.media.length,
    fullSlideImageOnlySlides: pptx.fullSlideImageOnlySlides,
    uniqueSlideHashes: pptx.uniqueSlideHashes,
  };
}

function hashBuffer(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeXml(value) {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&');
}

async function startStaticServer(rootDir) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    const requested = path.resolve(rootDir, `.${pathname}`);
    const file = requested.startsWith(rootDir) && existsSync(requested) && !isDirectory(requested)
      ? requested
      : path.join(rootDir, 'index.html');
    const ext = path.extname(file).toLowerCase();
    const type = ext === '.js' ? 'text/javascript'
      : ext === '.css' ? 'text/css'
        : ext === '.json' ? 'application/json'
          : ext === '.png' ? 'image/png'
            : ext === '.svg' ? 'image/svg+xml'
              : 'text/html';
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function closePage(page) {
  try { await page?.close(); } catch {}
}

async function closeBrowser(browser) {
  if (!browser) return;
  const close = browser.close().catch(() => {});
  try {
    const result = await Promise.race([
      close.then(() => 'closed'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    if (result === 'timeout') {
      try { browser.process?.()?.kill?.('SIGKILL'); } catch {}
      await Promise.race([
        close,
        new Promise(resolve => setTimeout(resolve, 1000)),
      ]);
    }
  } catch {}
}

function isDirectory(file) {
  try {
    return execFileSync('test', ['-d', file]).length === 0;
  } catch {
    return false;
  }
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function safePathSegment(value) {
  return String(value || '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'deck';
}
