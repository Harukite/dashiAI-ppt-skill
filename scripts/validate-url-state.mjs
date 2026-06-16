#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
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

const server = cliUrl ? null : await startPreviewServer();
const url = cliUrl || server.url;
const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
let contextA;
let contextB;

try {
  contextA = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const pageA = await contextA.newPage();
  pageA.setDefaultTimeout(30000);
  await installHistoryProbe(pageA);
  await pageA.goto(`${url}?url_state_validation=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  await waitForDeck(pageA);

  const edited = await exerciseEditorState(pageA);
  await pageA.waitForFunction(() => location.href.includes('deckState='), undefined, { timeout: 4000 });
  await settle(pageA, 650);
  const shareUrl = pageA.url();
  const historyProbe = await pageA.evaluate(() => window.__urlStateHistoryProbe || {});
  const encodedState = new URL(shareUrl).searchParams.get('deckState') || '';

  contextB = await browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: true });
  const pageB = await contextB.newPage();
  pageB.setDefaultTimeout(30000);
  await pageB.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        get length(){ return 0; },
      },
    });
  });
  await pageB.goto(shareUrl, { waitUntil: 'domcontentloaded' });
  await waitForDeck(pageB);
  await settle(pageB, 700);
  const restored = await readRestoredState(pageB, edited);

  const mediaTrimProbe = await runMediaTrimProbe(pageA);
  const tooLargeProbe = await runTooLargeProbe(pageA);

  const result = {
    url,
    passed: false,
    edited,
    shareUrlLength: shareUrl.length,
    encodedStateLength: encodedState.length,
    historyProbe,
    restored,
    mediaTrimProbe,
    tooLargeProbe,
  };
  const failures = validateResult(result);
  result.passed = failures.length === 0;
  if (failures.length) {
    console.error(JSON.stringify({ ...result, failures }, null, 2));
    throw new Error(failures.join('\n'));
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeContext(contextB);
  await closeContext(contextA);
  await closeBrowser(browser);
  if (server) await server.close();
}

async function installHistoryProbe(page) {
  await page.addInitScript(() => {
    const originalReplaceState = history.replaceState.bind(history);
    const originalPushState = history.pushState.bind(history);
    window.__urlStateHistoryProbe = { replaceState: 0, pushState: 0 };
    history.replaceState = function patchedReplaceState(...args){
      window.__urlStateHistoryProbe.replaceState += 1;
      return originalReplaceState(...args);
    };
    history.pushState = function patchedPushState(...args){
      window.__urlStateHistoryProbe.pushState += 1;
      return originalPushState(...args);
    };
  });
}

async function waitForDeck(page) {
  await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
  await page.waitForFunction(() => window.__deckViewModel?.getState && window.__getVisibleSlides?.().length > 10);
}

async function exerciseEditorState(page) {
  await page.evaluate(() => {
    window.__setActiveThemePack?.('theme01', { navigate: false });
    window.go?.(0, { animate: false, force: true });
    window.__refreshRailCatalog?.();
  });
  await settle(page);

  const textEdit = await editActiveText(page);
  const propEdit = await editCurrentProps(page);
  const beforeOrder = await readOrder(page);
  const drag = await dragRailCard(page, 2, 5);
  await page.waitForFunction(before => {
    const current = window.__deckViewModel?.getState?.().slideOrder || [];
    return current.join('|') !== before.join('|');
  }, beforeOrder);
  await settle(page, 500);

  const beforeCopy = await readRailState(page);
  const copyTarget = await chooseRailMutationTarget(page, { preferIndex: 4, requireEditable: true });
  const copy = await clickRailContextAction(page, copyTarget.slideId, /复制页面|复制/);
  const afterCopy = await readRailState(page);
  const copiedSlideId = findCopiedSlideId(beforeCopy, afterCopy, copyTarget.slideId);
  const copyTextEdit = await editCopiedSlideTextAndProps(page, copiedSlideId);

  const skipTarget = await chooseRailMutationTarget(page, { preferIndex: 6, excludeSlideIds: [copiedSlideId].filter(Boolean) });
  const skip = await clickRailContextAction(page, skipTarget.slideId, /跳过页面/);
  const deleteTarget = await chooseRailMutationTarget(page, {
    preferIndex: 8,
    excludeSlideIds: [copiedSlideId, skipTarget.slideId].filter(Boolean),
  });
  const deletion = await clickRailContextAction(page, deleteTarget.slideId, /删除页面/);
  await page.evaluate(() => {
    window.go?.(3, { animate: false, force: true });
    window.__refreshRailCatalog?.();
  });
  await settle(page, 750);

  const state = await page.evaluate(() => {
    const vm = window.__deckViewModel?.getState?.() || {};
    return {
      themePack: document.documentElement.dataset.themePack || '',
      currentIndex: window.__currentSlideIndex || 0,
      slideOrder: [...(vm.slideOrder || [])],
      skippedSlides: [...(vm.skippedSlides || [])],
      deletedSlides: [...(vm.deletedSlides || [])],
      duplicatedSlides: [...(vm.duplicatedSlides || [])],
      text: { ...(vm.text || {}) },
      props: { ...(vm.props || {}) },
      visibleSlideIds: (window.__getVisibleSlides?.() || []).map(slide => slide.dataset.vmSlideId || slide.dataset.slideId || ''),
      railSlideIds: [...document.querySelectorAll('[data-rail-card="true"],[data-slide-rail-card="true"]')].map(card => card.dataset.slideId || ''),
    };
  });

  return {
    textEdit,
    propEdit,
    drag,
    copy,
    copyTarget,
    copiedSlideId,
    copyTextEdit,
    skip,
    skipTarget,
    delete: deletion,
    deleteTarget,
    state,
  };
}

async function editActiveText(page) {
  return page.evaluate(() => {
    const active = document.querySelector('#deck > .slide.active');
    const el = active?.querySelector('[data-editable-id]');
    if (!active || !el) return { found: false };
    const slideId = active.dataset.vmSlideId || active.dataset.slideId || '';
    const key = el.dataset.editableId || '';
    const value = `URL_STATE_TEXT_${Date.now()}`;
    el.innerHTML = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
    el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    window.__flushEditableTextState?.(active);
    return { found: true, slideId, key, value };
  });
}

async function editCurrentProps(page) {
  return page.evaluate(() => {
    const slides = window.__getVisibleSlides?.() || [];
    let target = null;
    let props = {};
    for (const [index, slide] of slides.entries()) {
      const root = slide.querySelector('[data-prop-controls]');
      if (!root) continue;
      const controls = JSON.parse(root.dataset.propControls || '[]');
      const defaults = JSON.parse(root.dataset.propDefaults || '{}');
      const control = controls.find(item => item && item.key && !['image', 'media', 'picture', 'text', 'textarea', 'string', 'input', 'url', 'email'].includes(item.type));
      if (!control) continue;
      const slideId = slide.dataset.vmSlideId || slide.dataset.slideId || '';
      const current = window.__deckViewModel?.getState?.().props?.[slideId] || {};
      let value;
      if (control.type === 'toggle') value = !(current[control.key] ?? defaults[control.key] ?? control.default ?? false);
      else if (control.type === 'selection' || control.type === 'select' || control.type === 'segment' || control.type === 'color') {
        const options = (control.options || []).map(item => Array.isArray(item) ? item[0] : item?.value ?? item);
        value = options.find(item => String(item) !== String(current[control.key] ?? defaults[control.key] ?? control.default)) ?? options[0];
      } else {
        const min = Number(control.min ?? 0);
        const max = Number(control.max ?? 10);
        const previous = Number(current[control.key] ?? defaults[control.key] ?? control.default ?? min);
        value = previous < max ? Math.min(max, previous + Number(control.step || 1)) : min;
      }
      props = { ...defaults, ...current, [control.key]: value };
      window.go?.(index, { animate: false, force: true });
      window.__deckViewModel?.setProps?.(slideId, props);
      window.__ensureRuntimeSlideRendered?.(slide, props);
      target = { found: true, slideId, key: control.key, value, index };
      break;
    }
    return target || { found: false };
  });
}

async function editCopiedSlideTextAndProps(page, copiedSlideId) {
  return page.evaluate(copiedId => {
    const slides = window.__getVisibleSlides?.() || [];
    const index = slides.findIndex(slide => (slide.dataset.vmSlideId || slide.dataset.slideId || '') === copiedId);
    const slide = slides[index];
    if (!slide) return { found: false, copiedId };
    window.go?.(index, { animate: false, force: true });
    const el = slide.querySelector('[data-editable-id]');
    const textValue = `URL_STATE_COPY_TEXT_${Date.now()}`;
    if (el) {
      el.innerHTML = textValue;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textValue }));
      el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
    }
    window.__flushEditableTextState?.(slide);
    const currentProps = window.__deckViewModel?.getState?.().props?.[copiedId] || {};
    const props = { ...currentProps, __urlStateCopyProbe: `copy-prop-${Date.now()}` };
    window.__deckViewModel?.setProps?.(copiedId, props);
    return {
      found: true,
      copiedId,
      index,
      textKey: el?.dataset.editableId || '',
      textValue,
      propKey: '__urlStateCopyProbe',
      propValue: props.__urlStateCopyProbe,
    };
  }, copiedSlideId);
}

async function readOrder(page) {
  return page.evaluate(() => [...(window.__deckViewModel?.getState?.().slideOrder || [])]);
}

async function readRailState(page) {
  return page.evaluate(() => {
    const state = window.__deckViewModel?.getState?.() || {};
    const cards = [...document.querySelectorAll('[data-rail-card="true"],[data-slide-rail-card="true"]')].map(card => ({
      index: Number(card.dataset.index || -1),
      slideId: card.dataset.slideId || card.dataset.slideKey || '',
      active: card.getAttribute('aria-current') === 'true' || card.dataset.railActive === 'true',
      skippedBadge: Boolean(card.querySelector('.rail-skip-badge,.overview-skip-badge')),
    }));
    return {
      cards,
      slideOrder: [...(state.slideOrder || [])],
      skippedSlides: [...(state.skippedSlides || [])],
      deletedSlides: [...(state.deletedSlides || [])],
    };
  });
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
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await settle(page, 550);
  const perf = await page.evaluate(() => window.__getRailPerfState?.() || window.__getOverviewPerfState?.() || null);
  return { attempted: true, lastDrop: perf?.lastDrop || null };
}

async function chooseRailMutationTarget(page, { excludeSlideIds = [], preferIndex = 1, requireEditable = false } = {}) {
  return page.evaluate(({ excludeSlideIds, preferIndex, requireEditable }) => {
    const excluded = new Set(excludeSlideIds);
    const visibleSlides = window.__getVisibleSlides?.() || [];
    const hasEditableText = slideId => {
      const slide = visibleSlides.find(item => (item.dataset.vmSlideId || item.dataset.slideId || '') === slideId);
      return Boolean(slide?.querySelector('[data-editable-id]'));
    };
    const cards = [...document.querySelectorAll('[data-rail-card="true"],[data-slide-rail-card="true"]')]
      .map(card => ({
        index: Number(card.dataset.index || -1),
        slideId: card.dataset.slideId || card.dataset.slideKey || '',
        active: card.getAttribute('aria-current') === 'true' || card.dataset.railActive === 'true',
      }))
      .filter(card => card.slideId && !card.active && !excluded.has(card.slideId) && (!requireEditable || hasEditableText(card.slideId)));
    return cards.find(card => card.index >= preferIndex) || cards[0] || null;
  }, { excludeSlideIds, preferIndex, requireEditable });
}

async function clickRailContextAction(page, slideId, label) {
  const opened = await openRailContextMenu(page, { slideId });
  if (!opened.hasCard) return { hasTarget: false, clicked: false };
  const button = page.locator('.rail-context-menu button,.overview-context-menu button').filter({ hasText: label }).first();
  const count = await button.count();
  if (!count) return { hasTarget: true, clicked: false };
  await button.click();
  await settle(page, 450);
  return { hasTarget: true, clicked: true };
}

async function openRailContextMenu(page, { slideId = '' } = {}) {
  const selector = `[data-rail-card="true"][data-slide-id="${slideId}"],[data-slide-rail-card="true"][data-slide-id="${slideId}"]`;
  let card = page.locator(selector).first();
  if (!(await card.count())) return { hasCard: false };
  await card.scrollIntoViewIfNeeded();
  await settle(page, 80);
  await card.evaluate(el => {
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + Math.min(16, rect.width / 2),
      clientY: rect.top + Math.min(16, rect.height / 2),
    }));
  });
  await settle(page, 120);
  return { hasCard: true };
}

function findCopiedSlideId(before, after, sourceId) {
  const beforeIds = new Set((before?.cards || []).map(card => card.slideId));
  const added = (after?.cards || []).filter(card => card.slideId && !beforeIds.has(card.slideId));
  if (added.length) return added[0].slideId;
  const beforeCount = (before?.cards || []).filter(card => card.slideId === sourceId).length;
  const repeated = (after?.cards || []).filter(card => card.slideId === sourceId);
  return repeated.length > beforeCount ? sourceId : '';
}

async function readRestoredState(page, edited) {
  const target = edited.copyTextEdit || {};
  await page.waitForFunction(({ copiedSlideId }) => {
    const state = window.__deckViewModel?.getState?.() || {};
    return !copiedSlideId || (state.slideOrder || []).includes(copiedSlideId);
  }, { copiedSlideId: edited.copiedSlideId }, { timeout: 5000 }).catch(() => {});
  return page.evaluate(({ edited, target }) => {
    const vm = window.__deckViewModel?.getState?.() || {};
    const visibleSlides = window.__getVisibleSlides?.() || [];
    const copiedSlide = visibleSlides.find(slide => (slide.dataset.vmSlideId || slide.dataset.slideId || '') === edited.copiedSlideId);
    return {
      themePack: document.documentElement.dataset.themePack || '',
      currentIndex: window.__currentSlideIndex || 0,
      slideOrder: [...(vm.slideOrder || [])],
      skippedSlides: [...(vm.skippedSlides || [])],
      deletedSlides: [...(vm.deletedSlides || [])],
      duplicatedSlides: [...(vm.duplicatedSlides || [])],
      text: { ...(vm.text || {}) },
      props: { ...(vm.props || {}) },
      visibleSlideIds: visibleSlides.map(slide => slide.dataset.vmSlideId || slide.dataset.slideId || ''),
      railSlideIds: [...document.querySelectorAll('[data-rail-card="true"],[data-slide-rail-card="true"]')].map(card => card.dataset.slideId || ''),
      copiedSlideExists: Boolean(copiedSlide),
      copiedTextHtml: copiedSlide?.querySelector('[data-editable-id]')?.innerHTML || '',
      copiedTextKey: copiedSlide?.querySelector('[data-editable-id]')?.dataset.editableId || '',
      expectedCopyTextKey: target.textKey || '',
    };
  }, { edited, target });
}

async function runMediaTrimProbe(page) {
  return page.evaluate(async () => {
    const slide = (window.__getVisibleSlides?.() || []).find(item => item.dataset.vmSlideId);
    const slideId = slide?.dataset.vmSlideId || '';
    if (!slideId) return { skipped: true };
    const dataUrl = 'data:image/png;base64,' + 'a'.repeat(2048);
    const props = { ...(window.__deckViewModel?.getState?.().props?.[slideId] || {}), images: [{ src: dataUrl, kind: 'image' }], poster: dataUrl };
    window.__deckViewModel?.setProps?.(slideId, props);
    await new Promise(resolve => setTimeout(resolve, 500));
    return {
      slideId,
      status: window.__deckUrlStateStatus || null,
      hrefContainsDataImage: location.href.includes('data:image'),
      hrefContainsEncodedDataImage: location.href.includes('data%3Aimage') || location.href.includes('ZGF0YTppbWFnZQ'),
    };
  });
}

async function runTooLargeProbe(page) {
  return page.evaluate(async () => {
    const state = window.__deckViewModel?.getState?.() || {};
    const text = { ...(state.text || {}), 'text:url-state-large-probe:1': 'L'.repeat(90000) };
    window.__deckViewModel?.setTextState?.(text);
    await new Promise(resolve => setTimeout(resolve, 700));
    return {
      status: window.__deckUrlStateStatus || null,
      hrefLength: location.href.length,
      hasDeckState: new URL(location.href).searchParams.has('deckState'),
    };
  });
}

function validateResult(result) {
  const failures = [];
  const { edited, restored, historyProbe, mediaTrimProbe } = result;

  if (!edited.textEdit?.found) failures.push('Text edit target was not found.');
  if (!edited.propEdit?.found) failures.push('Props edit target was not found.');
  if (!edited.drag?.attempted || Number(edited.drag.lastDrop?.deckMoveCount || 0) !== 1) failures.push('Rail drag reorder did not commit one deck move.');
  if (!edited.copy?.clicked || !edited.copiedSlideId || edited.copiedSlideId === edited.copyTarget?.slideId) failures.push('Rail copy did not create an independent copied slide id.');
  if (!edited.copyTextEdit?.found) failures.push('Copied slide text/props edit was not exercised.');
  if (!edited.skip?.clicked || !edited.state.skippedSlides.includes(edited.skipTarget?.slideId)) failures.push('Rail skip state was not saved before URL sharing.');
  if (!edited.delete?.clicked || !edited.state.deletedSlides.includes(edited.deleteTarget?.slideId)) failures.push('Rail delete state was not saved before URL sharing.');
  if (!result.encodedStateLength) failures.push('URL did not receive a deckState parameter.');
  if ((historyProbe.replaceState || 0) < 1) failures.push('URL updates should use history.replaceState.');
  if ((historyProbe.pushState || 0) !== 0) failures.push('URL updates must not use history.pushState.');

  if (restored.themePack !== edited.state.themePack) failures.push(`Theme pack did not restore: ${restored.themePack} !== ${edited.state.themePack}`);
  if (restored.currentIndex !== edited.state.currentIndex) failures.push(`Current slide did not restore: ${restored.currentIndex} !== ${edited.state.currentIndex}`);
  if (restored.text[edited.textEdit.key] !== edited.textEdit.value) failures.push('Edited text did not restore from URL.');
  if (restored.props[edited.propEdit.slideId]?.[edited.propEdit.key] !== edited.propEdit.value) failures.push('Edited props did not restore from URL.');
  if (restored.slideOrder.join('|') !== edited.state.slideOrder.join('|')) failures.push('slideOrder did not restore from URL.');
  if (!restored.skippedSlides.includes(edited.skipTarget?.slideId)) failures.push('Skipped slide id did not restore from URL.');
  if (!restored.deletedSlides.includes(edited.deleteTarget?.slideId)) failures.push('Deleted slide id did not restore from URL.');
  if (!restored.copiedSlideExists) failures.push('Copied slide did not restore from URL.');
  if (!restored.slideOrder.includes(edited.copiedSlideId)) failures.push('Copied slide id is missing from restored slideOrder.');
  if (restored.copiedTextKey === edited.copyTarget?.slideId) failures.push('Copied slide text key overlaps the source id.');
  if (restored.text[edited.copyTextEdit.textKey] !== edited.copyTextEdit.textValue) failures.push('Copied slide text did not restore from URL.');
  if (restored.props[edited.copiedSlideId]?.[edited.copyTextEdit.propKey] !== edited.copyTextEdit.propValue) failures.push('Copied slide props did not restore from URL.');
  if (restored.visibleSlideIds.includes(edited.skipTarget?.slideId)) failures.push('Skipped slide is visible after URL restore.');
  if (restored.visibleSlideIds.includes(edited.deleteTarget?.slideId)) failures.push('Deleted slide is visible after URL restore.');
  if (mediaTrimProbe.hrefContainsDataImage || mediaTrimProbe.hrefContainsEncodedDataImage) failures.push('URL state contains media data URL content.');
  if (mediaTrimProbe.status?.tooLarge && !mediaTrimProbe.status?.lastError) failures.push('Too-large URL state should expose a status/error.');
  if (!result.tooLargeProbe.status?.tooLarge || result.tooLargeProbe.status?.lastError !== 'too-large') failures.push('Too-large URL state fallback was not exposed.');
  if (result.tooLargeProbe.hasDeckState) failures.push('Too-large URL state should not leave a stale deckState parameter in the URL.');

  return failures;
}

async function settle(page, ms = 280) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
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

async function closeContext(context) {
  if (!context) return;
  await Promise.race([
    context.close().catch(() => {}),
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
