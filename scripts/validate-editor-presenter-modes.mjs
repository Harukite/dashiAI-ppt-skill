#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'assets/template-swiss.html');
const PREVIEW_INDEX = path.join(ROOT, 'output/theme-preview/ppt/index.html');
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const cliUrl = getArg('--url');

if (!existsSync(CHROME_PATH)) {
  throw new Error(`Chrome executable not found: ${CHROME_PATH}
Set CHROME_PATH to a local Chrome/Chromium executable and rerun the validation.`);
}

if (!cliUrl && !existsSync(PREVIEW_INDEX)) {
  throw new Error(`Preview file missing: ${PREVIEW_INDEX}
Run npm run render:themes first, or pass --url to an existing preview.`);
}

const staticChecks = runStaticChecks();
const server = cliUrl ? null : await startPreviewServer();
const url = cliUrl || server.url;
const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
let page;

try {
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  page.setDefaultTimeout(30000);
  await page.goto(`${url}?editor_presenter_modes=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#deck > .slide');

  const defaultEdit = await readEditorPresenterState(page);
  const layoutWidths = [];
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await settle(page);
    layoutWidths.push(await readLayoutState(page, width));
  }

  const editNavigation = await runEditNavigationValidation(page);
  const editCapabilities = await readEditCapabilities(page);
  const rail = await runRailValidation(page);
  const present = await runPresentValidation(page);
  const exportState = await readExportState(page);

  const result = {
    url,
    passed: false,
    staticChecks,
    defaultEdit,
    layoutWidths,
    editNavigation,
    editCapabilities,
    rail,
    present,
    exportState,
  };
  const failures = validateResult(result);
  result.passed = failures.length === 0;
  if (failures.length) {
    console.error(JSON.stringify({ ...result, failures }, null, 2));
    throw new Error(failures.join('\n'));
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closePage(page);
  await closeBrowser(browser);
  if (server) await server.close();
}

function runStaticChecks() {
  const html = readFileSync(TEMPLATE, 'utf8');
  const previewController = sliceBetween(html, '/* =============== Preview Controller =============== */', '/* =============== Static HTML Export =============== */');
  const exportSource = sliceBetween(html, '/* =============== Static HTML Export =============== */', '</script>');
  const editableSource = sliceBetween(html, '/* =============== Editable Text Runtime =============== */', '</script>');
  const failures = [];

  if (!/deckMode/.test(html) || !/body\.dataset\.mode/.test(html)) {
    failures.push('Missing explicit deckMode/body.dataset.mode state model.');
  }
  if (/var\s+overviewOn|let\s+overviewOn|const\s+overviewOn|body\.overview-on|classList\.(add|remove|toggle)\(['"]overview-on['"]/.test(html)) {
    failures.push('Legacy overviewOn/body.overview-on mode state is still present.');
  }
  if (/window\.__toggleOverview\s*=|function\s+(openOverview|closeOverview|toggleOverview)\b/.test(html)) {
    failures.push('Legacy overview open/close/toggle API is still present.');
  }
  if (/id=["']preview-overview-btn["']|preview-overview-btn/.test(html)) {
    failures.push('Old preview-overview button still exists instead of a play/present button.');
  }
  if (/id=["']overview["']|\.id\s*=\s*['"]overview['"]|querySelector\(['"]#overview['"]\)/.test(html)) {
    failures.push('Legacy full-screen #overview container or export cleanup path is still present.');
  }
  if (!/id=["']slide-rail["']|data-slide-rail=["']true["']/.test(html)) {
    failures.push('Edit-mode left slide rail is missing.');
  }
  if (!/function\s+canEditDeck\b|window\.__canEditDeck\s*=/.test(html)) {
    failures.push('Missing unified edit guard for text, media, and property editing.');
  }
  if (/preview-panel-open/.test(editableSource) || /preview-panel-open/.test(sliceBetween(html, 'function isDeckEditableTextTarget', 'function isDeckInteractiveTarget'))) {
    failures.push('Editable text target detection still depends on preview-panel-open.');
  }
  if (!/enterPresentMode|exitPresentMode|__enterPresentMode|__exitPresentMode/.test(previewController + html)) {
    failures.push('Missing explicit enter/exit present mode flow.');
  }
  if (/overviewOn|overviewDisplay|#overview|overview-on/.test(exportSource)) {
    failures.push('Export capture/restore still stores or manipulates overview state.');
  }
  if (!/data-rail-card|data-slide-rail-card|dataset\.railCard/.test(html)) {
    failures.push('Rail cards are not represented as first-class catalog items.');
  }
  return failures;
}

async function readEditorPresenterState(page) {
  return page.evaluate(() => {
    const body = document.body;
    const rail = document.querySelector('#slide-rail,[data-slide-rail="true"]');
    const panel = document.getElementById('preview-panel');
    const viewport = document.getElementById('deck-viewport');
    const overview = document.getElementById('overview');
    return {
      mode: body.dataset.mode || '',
      panelOpen: body.classList.contains('preview-panel-open'),
      panelVisible: isVisible(panel),
      panelInert: Boolean(panel?.inert),
      railExists: Boolean(rail),
      railVisible: isVisible(rail),
      viewportVisible: isVisible(viewport),
      overviewExists: Boolean(overview),
      overviewVisible: isVisible(overview),
      currentIndex: window.__currentSlideIndex || 0,
      slideCount: window.__getVisibleSlides?.().length || document.querySelectorAll('#deck > .slide:not([hidden])').length,
      editableCount: document.querySelectorAll('#deck > .slide.active [contenteditable="true"]').length,
      canEdit: Boolean(window.__canEditDeck?.()),
      presentButtonExists: Boolean(document.querySelector('#preview-present-btn,[data-present-toggle="true"]')),
      oldOverviewButtonExists: Boolean(document.getElementById('preview-overview-btn')),
    };

    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
    }
  });
}

async function readLayoutState(page, width) {
  return page.evaluate((viewportWidth) => {
    const rail = document.querySelector('#slide-rail,[data-slide-rail="true"]');
    const panel = document.getElementById('preview-panel');
    const deck = document.getElementById('deck-viewport');
    const railRect = rail?.getBoundingClientRect();
    const panelRect = panel?.getBoundingClientRect();
    const deckRect = deck?.getBoundingClientRect();
    const railVisible = isVisible(rail);
    const panelVisible = isVisible(panel);
    const deckVisible = isVisible(deck);
    return {
      viewportWidth,
      mode: document.body.dataset.mode || '',
      railVisible,
      panelVisible,
      deckVisible,
      railRect: rectOf(railRect),
      panelRect: rectOf(panelRect),
      deckRect: rectOf(deckRect),
      aspect: deckRect ? deckRect.width / deckRect.height : 0,
      overlapsRail: Boolean(railVisible && deckRect && railRect && deckRect.left < railRect.right - 1),
      overlapsPanel: Boolean(panelVisible && deckRect && panelRect && deckRect.right > panelRect.left + 1),
    };

    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
    }
    function rectOf(rect) {
      if (!rect) return null;
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    }
  }, width);
}

async function runEditNavigationValidation(page) {
  await ensureEditMode(page);
  await page.evaluate(() => window.go?.(0, { animate: false, force: true }));
  await settle(page);
  const start = await currentIndex(page);
  await page.keyboard.press('ArrowRight');
  await settle(page);
  const afterRight = await currentIndex(page);
  await page.keyboard.press(' ');
  await settle(page);
  const afterSpace = await currentIndex(page);
  await page.mouse.click(720, 450);
  await settle(page);
  const afterClick = await currentIndex(page);
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('ArrowDown');
  await settle(page);
  const afterDown = await currentIndex(page);
  await page.keyboard.press('ArrowUp');
  await settle(page);
  const afterUp = await currentIndex(page);
  return { start, afterRight, afterSpace, afterClick, afterDown, afterUp };
}

async function readEditCapabilities(page) {
  await ensureEditMode(page);
  return page.evaluate(() => {
    const active = document.querySelector('#deck > .slide.active');
    const panel = document.getElementById('preview-panel');
    return {
      mode: document.body.dataset.mode || '',
      canEdit: Boolean(window.__canEditDeck?.()),
      editableCount: active?.querySelectorAll('[contenteditable="true"]').length || 0,
      editableReadyCount: active?.querySelectorAll('[data-editable-id]').length || 0,
      fileSlotCount: active?.querySelectorAll('[data-dashi-host-image-slot],image-slot,.gxn-slot,.pulse-imgframe,.acl-slot,.kx-imgslot,.dslot').length || 0,
      propControlCount: panel?.querySelectorAll('input,button,select,textarea').length || 0,
      panelVisible: isVisible(panel),
    };

    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
    }
  });
}

async function runRailValidation(page) {
  await ensureEditMode(page);
  await page.evaluate(() => window.go?.(0, { animate: false, force: true }));
  await settle(page);
  const initial = await getRailState(page);
  const clickJump = await clickRailCard(page, 3);
  const afterClick = await getRailState(page);
  await page.evaluate(() => window.go?.(30, { animate: false, force: true }));
  await settle(page);
  const afterScrollTarget = await getRailState(page);
  const dirty = await runRailDirtyValidation(page);
  const drag = await dragRailCard(page, 30, 33);
  await settle(page, 250);
  const afterDrag = await getRailState(page);
  const context = await runRailContextValidation(page);
  return { initial, clickJump, afterClick, afterScrollTarget, drag, afterDrag, context, dirty };
}

async function runPresentValidation(page) {
  await ensureEditMode(page);
  await page.evaluate(() => window.go?.(1, { animate: false, force: true }));
  await settle(page);
  const before = await currentIndex(page);
  const entered = await page.evaluate(() => {
    const button = document.querySelector('#preview-present-btn,[data-present-toggle="true"],#preview-overview-btn');
    button?.click();
    return Boolean(button);
  });
  await settle(page, 250);
  const presentState = await readEditorPresenterState(page);
  const presentLayout = await readLayoutState(page, page.viewportSize()?.width || 1440);
  await page.keyboard.press('ArrowRight');
  await settle(page);
  const afterRight = await currentIndex(page);
  await page.mouse.click(1000, 450);
  await settle(page);
  const afterClick = await currentIndex(page);
  const presentEditing = await readPresentEditGuards(page);
  await page.keyboard.press('Escape');
  await settle(page, 250);
  const afterEsc = await readEditorPresenterState(page);
  const afterEscIndex = await currentIndex(page);
  return { entered, before, presentState, presentLayout, afterRight, afterClick, presentEditing, afterEsc, afterEscIndex };
}

async function readPresentEditGuards(page) {
  return page.evaluate(() => {
    const active = document.querySelector('#deck > .slide.active');
    const panel = document.getElementById('preview-panel');
    const rail = document.querySelector('#slide-rail,[data-slide-rail="true"]');
    const propInputs = panel?.querySelectorAll('input,button,select,textarea') || [];
    return {
      mode: document.body.dataset.mode || '',
      canEdit: Boolean(window.__canEditDeck?.()),
      editableCount: active?.querySelectorAll('[contenteditable="true"]').length || 0,
      panelVisible: isVisible(panel),
      panelInert: Boolean(panel?.inert),
      railVisible: isVisible(rail),
      railInert: Boolean(rail?.inert),
      enabledPanelControlCount: [...propInputs].filter(el => !el.disabled && !el.closest('[hidden]')).length,
    };

    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
    }
  });
}

async function getRailState(page) {
  return page.evaluate(() => {
    const rail = document.querySelector('#slide-rail,[data-slide-rail="true"]');
    const scroller = document.querySelector('[data-rail-scroll="true"],#slide-rail-list') || rail;
    const cards = [...document.querySelectorAll('[data-rail-card="true"],[data-slide-rail-card="true"]')];
    const active = cards.find(card => card.dataset.railActive === 'true' || card.getAttribute('aria-current') === 'true');
    const firstThumb = cards[0]?.querySelector('[data-rail-thumb="true"],[data-overview-thumb="true"],[data-rail-frame="true"],[data-overview-frame="true"]');
    const thumbRect = firstThumb?.getBoundingClientRect();
    const activeRect = active?.getBoundingClientRect();
    const scrollRect = scroller?.getBoundingClientRect();
    const perf = window.__getRailPerfState?.() || window.__getOverviewPerfState?.() || null;
    return {
      exists: Boolean(rail),
      visible: isVisible(rail),
      cardCount: cards.length,
      activeIndex: active ? Number(active.dataset.index || -1) : -1,
      activeVisible: Boolean(activeRect && scrollRect && activeRect.top >= scrollRect.top - 2 && activeRect.bottom <= scrollRect.bottom + 2),
      thumbAspect: thumbRect ? thumbRect.width / thumbRect.height : 0,
      renderedCount: cards.filter(card => card.querySelector('[data-rail-thumb="true"][data-rail-rendered="true"],[data-overview-thumb="true"][data-overview-rendered="true"]')).length,
      placeholderCount: cards.filter(card => card.querySelector('[data-overview-placeholder="true"],[data-rail-placeholder="true"]')).length,
      cacheSize: perf?.cacheSize ?? null,
      queueLength: perf?.queueLength ?? null,
      lastDrop: perf?.lastDrop ?? null,
    };

    function isVisible(el) {
      if (!el) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 2 && rect.height > 2;
    }
  });
}

async function clickRailCard(page, index) {
  const selector = `[data-rail-card="true"][data-index="${index}"],[data-slide-rail-card="true"][data-index="${index}"]`;
  const locator = page.locator(selector).first();
  const exists = await locator.count();
  if (!exists) return { exists: false, before: await currentIndex(page), after: await currentIndex(page) };
  const before = await currentIndex(page);
  await locator.click();
  await settle(page);
  return { exists: true, before, after: await currentIndex(page) };
}

async function dragRailCard(page, fromIndex, toIndex) {
  const source = page.locator(`[data-rail-card="true"][data-index="${fromIndex}"],[data-slide-rail-card="true"][data-index="${fromIndex}"]`).first();
  const target = page.locator(`[data-rail-card="true"][data-index="${toIndex}"],[data-slide-rail-card="true"][data-index="${toIndex}"]`).first();
  if (!(await source.count()) || !(await target.count())) return { attempted: false };
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) return { attempted: false };
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 5 });
  await page.mouse.up();
  await settle(page, 300);
  const perf = await page.evaluate(() => window.__getRailPerfState?.() || window.__getOverviewPerfState?.() || null);
  return { attempted: true, lastDrop: perf?.lastDrop || null };
}

async function runRailContextValidation(page) {
  const card = page.locator('[data-rail-card="true"][aria-current="true"],[data-slide-rail-card="true"][aria-current="true"],[data-rail-card="true"],[data-slide-rail-card="true"]').first();
  if (!(await card.count())) return { hasCard: false };
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  if (!box) return { hasCard: false };
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });
  await settle(page);
  return page.evaluate(() => {
    const menu = document.querySelector('.rail-context-menu,.overview-context-menu');
    const buttons = [...(menu?.querySelectorAll('button') || [])].map(button => button.textContent?.trim() || '');
    return {
      hasCard: true,
      menuVisible: Boolean(menu && getComputedStyle(menu).display !== 'none'),
      hasSkip: buttons.some(text => /跳过|取消跳过/.test(text)),
      hasDelete: buttons.some(text => /删除/.test(text)),
    };
  });
}

async function runRailDirtyValidation(page) {
  await page.evaluate(() => {
    window.__queueNearbyOverviewThumbs?.();
  });
  await page.waitForFunction(() => {
    const perf = window.__getRailPerfState?.() || window.__getOverviewPerfState?.() || null;
    if (!perf?.activeSlideId || !perf?.cacheKeys?.length) return false;
    return perf.cacheKeys.some(key => key.includes(`|${perf.activeSlideId}|`));
  }, undefined, { timeout: 8000 });
  return page.evaluate(async () => {
    const perfBefore = window.__getRailPerfState?.() || window.__getOverviewPerfState?.() || null;
    const active = document.querySelector('#deck > .slide.active');
    const beforeKeys = perfBefore?.cacheKeys || [];
    window.__markRailThumbDirty?.(active);
    if (!window.__markRailThumbDirty && window.__markOverviewThumbDirty) window.__markOverviewThumbDirty(active);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const perfAfter = window.__getRailPerfState?.() || window.__getOverviewPerfState?.() || null;
    const afterKeys = perfAfter?.cacheKeys || [];
    return {
      hasDirtyApi: typeof window.__markRailThumbDirty === 'function',
      fallbackOverviewDirtyApi: typeof window.__markOverviewThumbDirty === 'function',
      beforeCacheSize: perfBefore?.cacheSize ?? null,
      afterCacheSize: perfAfter?.cacheSize ?? null,
      removedCount: beforeKeys.filter(key => !afterKeys.includes(key)).length,
      activeSlideId: perfAfter?.activeSlideId || '',
      queueLength: perfAfter?.queueLength ?? null,
    };
  });
}

async function readExportState(page) {
  return page.evaluate(() => ({
    hasCaptureExportViewState: document.documentElement.outerHTML.includes('captureExportViewState'),
    htmlContainsOverviewExportState: /function captureExportViewState[\s\S]{0,700}(overviewOn|overviewDisplay|#overview|overview-on)/.test(document.documentElement.outerHTML)
      || /function restoreExportViewState[\s\S]{0,900}(overviewOn|overviewDisplay|#overview|overview-on)/.test(document.documentElement.outerHTML),
  }));
}

function validateResult(result) {
  const failures = [...result.staticChecks];
  const defaultEdit = result.defaultEdit;
  if (defaultEdit.mode !== 'edit') failures.push(`Default mode should be edit, got "${defaultEdit.mode || '(empty)'}".`);
  if (!defaultEdit.railExists || !defaultEdit.railVisible) failures.push('Default edit mode should show the left slide rail.');
  if (!defaultEdit.panelOpen || !defaultEdit.panelVisible) failures.push('Right panel should be open and visible by default in edit mode.');
  if (!defaultEdit.viewportVisible) failures.push('Deck viewport is not visible in default edit mode.');
  if (defaultEdit.overviewExists || defaultEdit.overviewVisible || defaultEdit.oldOverviewButtonExists) failures.push('Legacy overview UI must not exist in the user path.');
  if (!defaultEdit.canEdit || defaultEdit.editableCount < 1) failures.push('Edit mode should enable text editing independently of panel-open state.');
  if (!defaultEdit.presentButtonExists) failures.push('Play/present button is missing.');

  for (const layout of result.layoutWidths) {
    if (layout.mode !== 'edit') failures.push(`Layout ${layout.viewportWidth}: expected edit mode.`);
    if (!layout.railVisible || !layout.panelVisible || !layout.deckVisible) failures.push(`Layout ${layout.viewportWidth}: rail, panel, and deck must all be visible.`);
    if (Math.abs(layout.aspect - 16 / 9) > 0.025) failures.push(`Layout ${layout.viewportWidth}: deck stage is not 16:9 (${layout.aspect}).`);
    if (layout.overlapsRail) failures.push(`Layout ${layout.viewportWidth}: deck overlaps left rail.`);
    if (layout.overlapsPanel) failures.push(`Layout ${layout.viewportWidth}: deck overlaps right panel.`);
    if (layout.panelRect && layout.panelRect.right > layout.viewportWidth + 1) failures.push(`Layout ${layout.viewportWidth}: right panel overflows the viewport.`);
  }

  if (result.editNavigation.afterRight !== result.editNavigation.start) failures.push('Edit mode ArrowRight should not change page.');
  if (result.editNavigation.afterSpace !== result.editNavigation.start) failures.push('Edit mode Space should not change page.');
  if (result.editNavigation.afterClick !== result.editNavigation.start) failures.push('Edit mode deck click should not advance page.');
  if (result.editNavigation.afterDown <= result.editNavigation.afterClick) failures.push('Edit mode ArrowDown should advance one page.');
  if (result.editNavigation.afterUp !== result.editNavigation.afterClick) failures.push('Edit mode ArrowUp should return to the previous page.');

  if (!result.editCapabilities.canEdit || result.editCapabilities.editableCount < 1) failures.push('Edit mode text editing capability is unavailable.');
  if (!result.editCapabilities.panelVisible || result.editCapabilities.propControlCount < 1) failures.push('Edit mode right-side property controls are unavailable.');

  const rail = result.rail;
  if (!rail.initial.exists || !rail.initial.visible) failures.push('Rail is missing or hidden.');
  if (rail.initial.cardCount < 70) failures.push(`Rail should contain the slide catalog, got ${rail.initial.cardCount} card(s).`);
  if (Math.abs(rail.initial.thumbAspect - 16 / 9) > 0.04) failures.push(`Rail thumbnails must be full 16:9, got aspect ${rail.initial.thumbAspect}.`);
  if (!rail.clickJump.exists || rail.clickJump.after !== 3) failures.push('Rail card click should jump to the clicked page.');
  if (!rail.afterScrollTarget.activeVisible) failures.push('Rail should scroll the active card into view.');
  if (!rail.drag.attempted || Number(rail.drag.lastDrop?.deckMoveCount || 0) !== 1) failures.push('Rail drag reorder should commit the real deck with one moved slide.');
  if (!rail.context.menuVisible || !rail.context.hasSkip || !rail.context.hasDelete) failures.push('Rail context menu should expose skip and delete actions.');
  if (!rail.dirty.hasDirtyApi || rail.dirty.removedCount < 1) failures.push('Rail dirty invalidation should expose rail API and invalidate only the active slide cache.');

  const present = result.present;
  if (!present.entered) failures.push('Present button could not be clicked.');
  if (present.presentState.mode !== 'present') failures.push(`Clicking play should enter present mode, got "${present.presentState.mode || '(empty)'}".`);
  if (present.presentState.railVisible || present.presentState.panelVisible) failures.push('Present mode should hide rail and right panel.');
  if (present.presentState.canEdit || present.presentEditing.canEdit || present.presentEditing.editableCount > 0) failures.push('Present mode must disable text editing.');
  if (present.presentEditing.enabledPanelControlCount > 0 && present.presentEditing.panelVisible) failures.push('Present mode must not expose enabled panel controls.');
  if (Math.abs(present.presentLayout.aspect - 16 / 9) > 0.025) failures.push('Present mode deck stage must remain 16:9.');
  if (present.presentLayout.deckRect && (present.presentLayout.deckRect.width < 1200 || present.presentLayout.deckRect.height < 675)) failures.push('Present mode deck should use the full viewport fit.');
  if (present.afterRight <= present.before) failures.push('Present mode ArrowRight should advance.');
  if (present.afterClick <= present.afterRight) failures.push('Present mode click should advance.');
  if (present.afterEsc.mode !== 'edit') failures.push('Escape should return from present mode to edit mode.');
  if (present.afterEscIndex !== present.afterClick) failures.push('Exiting present mode should preserve the current page.');

  if (result.exportState.htmlContainsOverviewExportState) failures.push('Export capture/restore still contains legacy overview fields.');
  return failures;
}

async function ensureEditMode(page) {
  const state = await readEditorPresenterState(page);
  if (state.mode === 'present') {
    await page.keyboard.press('Escape');
    await settle(page);
  }
}

async function currentIndex(page) {
  return page.evaluate(() => window.__currentSlideIndex || 0);
}

async function settle(page, ms = 280) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function sliceBetween(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  if (start < 0) return '';
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  return end > start ? source.slice(start, end) : source.slice(start);
}

async function startPreviewServer() {
  const port = await getFreePort();
  const child = spawn(process.execPath, ['scripts/serve-preview-https.mjs', 'output/theme-preview/ppt', String(port)], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk.toString(); });
  child.stderr.on('data', chunk => { output += chunk.toString(); });
  const previewUrl = `https://127.0.0.1:${port}/`;
  await waitForServer(previewUrl, child, () => output);
  return {
    url: previewUrl,
    close: () => new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      child.once('exit', finish);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!done) child.kill('SIGKILL');
        finish();
      }, 1500).unref();
    }),
  };
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForServer(previewUrl, child, getOutput) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Preview server exited early:\n${getOutput()}`);
    if (await canOpen(previewUrl)) return;
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`Preview server did not become ready:\n${getOutput()}`);
}

function canOpen(previewUrl) {
  return new Promise(resolve => {
    const req = https.get(previewUrl, { rejectUnauthorized: false }, res => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode < 500));
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function closePage(page) {
  if (!page) return;
  await Promise.race([
    page.close({ runBeforeUnload: false }).catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 2000)),
  ]);
}

async function closeBrowser(browser) {
  const browserProcess = typeof browser.process === 'function' ? browser.process() : null;
  await Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 4000)),
  ]);
  if (browserProcess && browserProcess.exitCode === null) browserProcess.kill('SIGKILL');
}
