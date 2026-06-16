#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'assets/template-swiss.html');
const OUT_DIR = path.join(ROOT, 'output/editable-pptx-validation');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const EXPECTED_SLIDES = 6;
const THEME_FILTER_EXPECTED_SLIDES = 2;
const EDITED_TEXT = 'JAD-64 editable text sentinel';
const INITIAL_IMAGE_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#e11d48"/><text x="4" y="16" font-size="8" fill="#ffffff">old</text></svg>');
const REPLACEMENT_IMAGE_BYTES = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#2563eb"/><text x="4" y="16" font-size="8" fill="#ffffff">new</text></svg>');
const INITIAL_IMAGE_HASH = hashBuffer(INITIAL_IMAGE_BYTES);
const REPLACEMENT_IMAGE_HASH = hashBuffer(REPLACEMENT_IMAGE_BYTES);
const INITIAL_IMAGE = `data:image/svg+xml;base64,${INITIAL_IMAGE_BYTES.toString('base64')}`;
const REPLACEMENT_IMAGE = `data:image/svg+xml;base64,${REPLACEMENT_IMAGE_BYTES.toString('base64')}`;

const args = new Set(process.argv.slice(2));
const legacyRed = args.has('--legacy-red');
const uiExport = args.has('--ui-export');
const uiVisualFidelity = args.has('--ui-visual-fidelity');
const cliUrl = getArg('--url');

if (!existsSync(CHROME_PATH)) {
  throw new Error(`Chrome executable not found: ${CHROME_PATH}
Set CHROME_PATH to a local Chrome/Chromium executable and rerun the validation.`);
}

mkdirSync(OUT_DIR, { recursive: true });

if (legacyRed) {
  await runLegacyRedValidation();
} else if (uiExport) {
  await runUiExportValidation();
} else if (uiVisualFidelity) {
  await runUiVisualFidelityValidation();
} else {
  await runEditableExportValidation();
}

async function runUiVisualFidelityValidation() {
  if (!cliUrl) throw new Error('Usage: node scripts/validate-editable-pptx-export.mjs --ui-visual-fidelity --url <preview-url>');
  const url = cliUrl;
  const staticFailures = inspectUiExportPath();
  const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
  const visualDir = path.join(OUT_DIR, 'ui-visual-fidelity');
  rmSync(visualDir, { recursive: true, force: true });
  mkdirSync(visualDir, { recursive: true });

  let page;
  let expectedSlides = null;
  let expectations = [];
  let pptxFile = null;
  let reportFile = null;
  let htmlScreenshot = null;
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1920, height: 1080 },
      ignoreHTTPSErrors: true,
    });
    page = await context.newPage();
    page.setDefaultTimeout(180000);
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    await page.goto(`${url}${url.includes('?') ? '&' : '?'}ui_visual=${Date.now()}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    expectedSlides = await page.evaluate(() => (window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')]).length);
    expectations = await collectUiVisualExpectations(page, expectedSlides);
    htmlScreenshot = path.join(visualDir, 'html-slide-001.png');
    await page.evaluate(async () => {
      window.go?.(0, { animate: false, force: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const activeSlide = await page.$('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (!activeSlide) throw new Error('Could not capture active slide screenshot.');
    await activeSlide.screenshot({ path: htmlScreenshot });

    await page.click('#preview-export-main');
    await page.click('#preview-export-pptx');
    await page.waitForFunction(() => window.__lastPptxExportResult?.filePath, null, { timeout: 240000 });
    const result = await page.evaluate(() => window.__lastPptxExportResult);
    pptxFile = result.filePath;
    reportFile = result.reportPath;
  } finally {
    await closePage(page);
    await browser.close().catch(() => {});
  }

  if (!pptxFile) throw new Error('UI export did not return a saved PPTX path.');
  const pptx = inspectPptx(pptxFile);
  const report = reportFile && existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null;
  const visual = runQuickLookVisualComparison(pptxFile, htmlScreenshot, visualDir);
  const failures = [
    ...staticFailures,
    ...validateEditablePptxInspection(pptx, { expectSlides: expectedSlides }),
    ...validateVisualFidelityReport({ report, pptx, expectations, expectedSlides, visual }),
  ];
  const result = {
    mode: 'ui-visual-fidelity',
    url,
    expectedSlides,
    passed: failures.length === 0,
    pptx: summarizeInspection(pptx),
    report: report ? summarizeVisualReport(report) : null,
    htmlScreenshot,
    quickLook: visual,
    sampleExpectations: expectations.filter(item => item.svgElements || item.canvasElements || item.backgroundImageElements).slice(0, 8),
    failures,
  };
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
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
    await page.click('#preview-export-pptx');
    await page.waitForFunction(() => window.__lastPptxExportResult?.filePath, null, { timeout: 180000 });
    const result = await page.evaluate(() => window.__lastPptxExportResult);
    pptxFile = result.filePath;
  } finally {
    await closePage(page);
    await browser.close().catch(() => {});
  }

  if (!pptxFile) throw new Error('UI export did not return a saved PPTX path.');
  const pptx = inspectPptx(pptxFile);
  const failures = [
    ...staticFailures,
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
    passed: failures.length === 0,
    pptx: summarizeInspection(pptx),
    failures,
  };
  if (failures.length) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}

async function collectUiVisualExpectations(page, expectedSlides) {
  const expectations = [];
  for (let i = 0; i < expectedSlides; i += 1) {
    expectations.push(await page.evaluate(async (index) => {
      window.go?.(index, { animate: false, force: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
            const text = (child.textContent || '').trim().replace(/\s+/g, ' ');
            if (!text) continue;
            const range = document.createRange();
            range.selectNodeContents(child);
            const rect = range.getBoundingClientRect();
            if (rect.width > 1 && rect.height > 1) metrics.textNodeRects += 1;
          } else if (child.nodeType === Node.ELEMENT_NODE) {
            walkText(child);
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
        if (tag === 'canvas') metrics.canvasElements += 1;
        if (tag === 'img') metrics.imageElements += 1;
      }
      walkText(slide);
      return metrics;
    }, i));
  }
  return expectations;
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

  const complexExpected = expectations.filter(item => (item.svgElements || 0) + (item.canvasElements || 0) + (item.backgroundUrlElements || 0) > 0);
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
      if ((item.svgElements || item.canvasElements) && summary?.imageNodes > 0) return false;
      return !summary || summary.capturedNodes < Math.min(40, Math.max(12, Math.floor(item.elementCount * 0.25))) || summary.maxDepth < Math.min(6, item.maxDepth);
    })
    .map(item => item.index);
  if (flatCaptures.length) {
    failures.push(`Captured tree is too shallow for visually rich slides: ${flatCaptures.slice(0, 12).join(', ')}.`);
  }

  if (visual.available) {
    if (visual.normalizedRmse > 0.65) {
      failures.push(`Quick Look visual RMSE is too high (${visual.normalizedRmse.toFixed(4)} > 0.6500).`);
    }
  } else {
    failures.push(`Quick Look visual comparison was unavailable: ${visual.reason}`);
  }
  return failures;
}

function summarizeVisualReport(report) {
  const summaries = Array.isArray(report.slideSummaries) ? report.slideSummaries : [];
  return {
    captureMode: report.captureMode || null,
    slideCount: report.slideCount,
    textObjects: report.textObjects,
    shapeObjects: report.shapeObjects,
    imageObjects: report.imageObjects,
    warningCount: Array.isArray(report.warnings) ? report.warnings.length : null,
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
  const ql = spawnSync('qlmanage', ['-t', '-s', '960', '-o', quickLookDir, pptxFile], { encoding: 'utf8' });
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
  const compare = spawnSync('magick', ['compare', '-metric', 'RMSE', htmlNorm, pptxNorm, 'null:'], { encoding: 'utf8' });
  const output = `${compare.stderr || ''}${compare.stdout || ''}`;
  const match = output.match(/\((0(?:\.\d+)?|1(?:\.0+)?)\)/);
  const normalizedRmse = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(normalizedRmse)) return { available: false, reason: `rmse-parse-failed:${output}` };
  return {
    available: true,
    normalizedRmse,
    htmlImage: htmlNorm,
    pptxImage: pptxNorm,
  };
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
  return failures;
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
    await browser.close().catch(() => {});
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
    await browser.close().catch(() => {});
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
  rmSync(OUT_DIR, { recursive: true, force: true });
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

function inspectSlideXml(xml, index, relsXml, mediaByEntry) {
  const text = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(match => decodeXml(match[1]));
  const shapeCount = (xml.match(/<p:sp\b/g) || []).length;
  const autoFitTextCount = (xml.match(/<a:spAutoFit\/>/g) || []).length;
  const pictureCount = (xml.match(/<p:pic\b/g) || []).length;
  const pictures = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)].map(match => {
    const ext = match[0].match(/<a:ext[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
    const embed = match[0].match(/r:embed="([^"]+)"/);
    const cx = Number(ext?.[1] || 0);
    const cy = Number(ext?.[2] || 0);
    return { cx, cy, rId: embed?.[1] || '', nearFullSlide: cx >= 0.9 * 16 * 914400 && cy >= 0.9 * 9 * 914400 };
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
    autoFitTextCount,
    shapeCount,
    pictureCount,
    pictures,
    pictureMediaHashes,
    fullSlideImageOnly: text.length === 0 && shapeCount <= 1 && pictures.length === 1 && pictures[0].nearFullSlide,
    hash: createHash('sha256').update(xml.replace(/id="\d+"/g, 'id=""')).digest('hex'),
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
