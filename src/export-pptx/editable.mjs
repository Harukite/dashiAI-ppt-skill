import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';

const SOURCE_W = 1920;
const SOURCE_H = 1080;
const PPT_W = 16;
const PPT_H = 9;
const PX_TO_PT = 0.75;

export async function exportEditablePptxFromPage(page, options = {}) {
  const outFile = path.resolve(options.outFile || 'editable-export.pptx');
  const reportFile = options.reportFile ? path.resolve(options.reportFile) : null;
  const title = options.title || 'Editable Deck Export';
  const deck = await collectEditableDeck(page, options);

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'DASHI_WIDE', width: PPT_W, height: PPT_H });
  pptx.layout = 'DASHI_WIDE';
  pptx.author = 'Dashi PPT Skill';
  pptx.subject = 'Editable PPTX export';
  pptx.title = title;

  const warnings = [...deck.warnings];
  const totals = { textObjects: 0, shapeObjects: 0, imageObjects: 0 };
  const slideSummaries = [];

  for (const slideData of deck.slides) {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    const before = { ...totals };
    renderCapturedNode(slide, slideData.root, slideData.rect, warnings, totals);
    warnings.push(...slideData.warnings);
    slideSummaries.push({
      index: slideData.index,
      key: slideData.summary?.key || '',
      capturedNodes: slideData.summary?.capturedNodes || 0,
      maxDepth: slideData.summary?.maxDepth || 0,
      textNodes: slideData.summary?.textNodes || 0,
      backgroundImages: slideData.summary?.backgroundImages || 0,
      svgImages: slideData.summary?.svgImages || 0,
      canvasImages: slideData.summary?.canvasImages || 0,
      imageNodes: slideData.summary?.imageNodes || 0,
      shapeCandidates: slideData.summary?.shapeCandidates || 0,
      renderedTextObjects: totals.textObjects - before.textObjects,
      renderedShapeObjects: totals.shapeObjects - before.shapeObjects,
      renderedImageObjects: totals.imageObjects - before.imageObjects,
    });
  }

  mkdirSync(path.dirname(outFile), { recursive: true });
  await pptx.writeFile({ fileName: outFile });

  const report = {
    captureMode: 'captured-tree',
    slideCount: deck.slides.length,
    textObjects: totals.textObjects,
    shapeObjects: totals.shapeObjects,
    imageObjects: totals.imageObjects,
    slideSummaries,
    warnings,
  };
  if (reportFile) {
    mkdirSync(path.dirname(reportFile), { recursive: true });
    writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  }
  return { outFile, reportFile, ...report };
}

export async function exportEditablePptxFromUrl(browser, url, options = {}) {
  const context = await browser.newContext({ viewport: { width: SOURCE_W, height: SOURCE_H }, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  try {
    page.setDefaultTimeout(options.timeout || 45000);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
    if (options.snapshot) await applyDeckSnapshot(page, options.snapshot);
    return await exportEditablePptxFromPage(page, options);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

async function applyDeckSnapshot(page, snapshot) {
  await page.evaluate(async (snapshot) => {
    window.__applyEditablePptxSnapshotText = function(scope) {
      const textState = window.__editablePptxSnapshotTextState;
      if (!scope || !textState || typeof textState !== 'object') return;
      const elements = [
        ...(scope.dataset?.editableId ? [scope] : []),
        ...(scope.querySelectorAll?.('[data-editable-id]') || []),
      ];
      elements.forEach(el => {
        const synced = el.dataset.syncText ? textState[`sync:${el.dataset.syncText}`] : undefined;
        const value = synced !== undefined ? synced : textState[el.dataset.editableId];
        if (value !== undefined) el.innerHTML = value;
      });
    };
    const state = snapshot?.state || {};
    if (snapshot?.themePack !== undefined) {
      window.__setActiveThemePack?.(snapshot.themePack || '', { navigate: false });
    }
    if (Array.isArray(state.slideOrder)) window.__deckViewModel?.setSlideOrder?.(state.slideOrder);
    if (Array.isArray(state.skippedSlides)) window.__deckViewModel?.setSkippedSlides?.(state.skippedSlides);
    if (Array.isArray(state.deletedSlides)) window.__deckViewModel?.setDeletedSlides?.(state.deletedSlides);
    if (state.text && typeof state.text === 'object') window.__deckViewModel?.setTextState?.(state.text);
    window.__editablePptxSnapshotTextState = state.text && typeof state.text === 'object' ? state.text : {};
    if (state.props && typeof state.props === 'object') {
      Object.entries(state.props).forEach(([slideId, props]) => window.__deckViewModel?.setProps?.(slideId, props));
    }
    window.__syncDeckViewModelFromDom?.();
    window.__layoutDeck?.();
    const slides = window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')];
    slides.forEach(slide => {
      window.__ensureRuntimeSlideRendered?.(slide);
      window.__applyEditablePptxSnapshotText?.(slide);
    });
    if (Array.isArray(snapshot?.canvasSnapshots)) {
      snapshot.canvasSnapshots.forEach(item => {
        const slide = slides[item.slideIndex];
        if (!slide || !item?.data) return;
        const original = slide.querySelectorAll?.('canvas')?.[item.canvasIndex];
        if (original) original.style.display = 'none';
        const img = document.createElement('img');
        img.src = item.data;
        img.setAttribute('data-editable-pptx-canvas-snapshot', '');
        Object.assign(img.style, {
          position: 'absolute',
          left: `${item.left}%`,
          top: `${item.top}%`,
          width: `${item.width}%`,
          height: `${item.height}%`,
          zIndex: '2147480000',
          pointerEvents: 'none',
        });
        slide.appendChild(img);
      });
    }
    const index = Math.max(0, Math.min(slides.length - 1, Number(snapshot?.currentIndex || 0)));
    window.go?.(index, { animate: false, force: true });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, snapshot);
}

async function collectEditableDeck(page, options = {}) {
  await page.evaluate(async ({ includeAllThemePacks }) => {
    window.__editablePptxRestoreState = {
      locked: window.__deckExportLocked,
      themePack: document.documentElement.dataset.themePack || '',
    };
    if (includeAllThemePacks) window.__setActiveThemePack?.('', { navigate: false });
    window.__deckExportLocked = true;
    window.__flushEditableTextState?.();
    window.__syncDeckViewModelFromDom?.();
    window.__setEditableTextMode?.(false);
    window.__layoutDeck?.();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, { includeAllThemePacks: options.includeAllThemePacks === true });

  try {
    const count = await page.evaluate(() => {
      const slides = window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')];
      return slides.length;
    });

    await installBrowserCollector(page);
    const slides = [];
    const warnings = [];
    for (let i = 0; i < count; i += 1) {
      await page.evaluate(async index => {
        window.go?.(index, { animate: false, force: true });
        const slides = window.__getVisibleSlides?.() || [...document.querySelectorAll('#deck > .slide:not([hidden])')];
        window.__ensureRuntimeSlideRendered?.(slides[index]);
        window.__applyEditablePptxSnapshotText?.(slides[index]);
        window.__restoreEffectIframes?.(slides[index]);
        window.__layoutDeck?.();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }, i);
      slides.push(await page.evaluate(index => window.__collectEditablePptxSlide(index), i + 1));
    }

    return { slides, warnings };
  } finally {
    await page.evaluate(async () => {
      const restore = window.__editablePptxRestoreState || {};
      if ((document.documentElement.dataset.themePack || '') !== (restore.themePack || '')) {
        window.__setActiveThemePack?.(restore.themePack || '', { navigate: false });
      }
      window.__deckExportLocked = Boolean(restore.locked);
      window.__setEditableTextMode?.(window.__canEditDeck?.());
      delete window.__editablePptxSnapshotTextState;
      delete window.__applyEditablePptxSnapshotText;
      delete window.__editablePptxRestoreState;
      window.__layoutDeck?.();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }).catch(() => {});
  }
}

async function installBrowserCollector(page) {
  await page.addScriptTag({
    content: `
      window.__collectEditablePptxSlide = (() => {
        const STYLE_KEYS = ${JSON.stringify([
          'display',
          'visibility',
          'opacity',
          'position',
          'backgroundColor',
          'backgroundImage',
          'backgroundSize',
          'backgroundPosition',
          'borderTopWidth',
          'borderRightWidth',
          'borderBottomWidth',
          'borderLeftWidth',
          'borderTopColor',
          'borderRightColor',
          'borderBottomColor',
          'borderLeftColor',
          'borderTopStyle',
          'borderRightStyle',
          'borderBottomStyle',
          'borderLeftStyle',
          'borderTopLeftRadius',
          'borderTopRightRadius',
          'borderBottomRightRadius',
          'borderBottomLeftRadius',
          'boxShadow',
          'color',
          'fontFamily',
          'fontSize',
          'fontWeight',
          'fontStyle',
          'lineHeight',
          'letterSpacing',
          'textAlign',
          'textDecorationLine',
          'textTransform',
          'whiteSpace',
          'verticalAlign',
          'objectFit',
          'objectPosition',
          'transform',
          'filter',
          'clipPath',
          'overflow',
        ])};
        ${collectActiveSlide.toString()}
        ${captureElement.toString()}
        ${captureTextNode.toString()}
        ${readStyle.toString()}
        ${summarizeCapturedTree.toString()}
        ${summarizeNode.toString()}
        ${elementImageData.toString()}
        ${svgElementData.toString()}
        ${cloneSvgWithComputedStyle.toString()}
        ${backgroundUrl.toString()}
        ${fetchImageDataUrl.toString()}
        ${blobToDataUrl.toString()}
        ${isVisibleElement.toString()}
        ${isMediaChrome.toString()}
        ${clippedRect.toString()}
        ${rectObject.toString()}
        ${normalizeText.toString()}
        ${hasPaint.toString()}
        ${hasAnyBorder.toString()}
        return collectActiveSlide;
      })();
    `,
  });
}

function renderCapturedNode(slide, node, slideRect, warnings, totals) {
  if (!node || node.style?.display === 'none' || node.style?.visibility === 'hidden') return;
  if (Number(node.style?.opacity || 1) <= 0.01) return;
  if (!node.rect || node.rect.w < 0.5 || node.rect.h < 0.5) return;

  if (node.tag === '#text') {
    renderText(slide, node, slideRect, warnings, totals);
    return;
  }

  renderBox(slide, node, slideRect, warnings, totals);
  renderNodeImage(slide, node, slideRect, warnings, totals);

  if (node.tag === 'img' || node.tag === 'svg' || node.tag === 'canvas') return;
  for (const child of node.children || []) renderCapturedNode(slide, child, slideRect, warnings, totals);
}

function renderBox(slide, node, slideRect, warnings, totals) {
  const c = coords(node, slideRect);
  if (c.w < 0.003 || c.h < 0.003) return;
  const style = node.style || {};
  const fill = parseCssColor(style.backgroundColor) || colorFromBackgroundImage(style.backgroundImage);
  const radius = Math.min(maxRadiusPx(style), 48) / slideRect.w * PPT_W;
  const borders = readBorders(style);
  const hasBorder = borders.some(border => border.width > 0 && border.color);
  const shadow = parseBoxShadow(style.boxShadow);
  const hasFill = fill && fill.alpha > 0.01;
  const isLargeGradient = fill?.gradient && c.w > PPT_W * 0.72 && c.h > PPT_H * 0.72;
  const fillAlpha = fill?.gradient && !isLargeGradient ? Math.min(fill.alpha, 0.16) : fill?.alpha;
  const shapeName = fill?.gradient && !isLargeGradient && radius > Math.min(c.w, c.h) * 0.2
    ? 'ellipse'
    : radius > 0.02 ? 'roundRect' : 'rect';

  if (hasFill || hasBorder) {
    try {
      slide.addShape(shapeName, {
        ...c,
        fill: hasFill
          ? { color: fill.color, transparency: combinedTransparency(fillAlpha, style.opacity) }
          : { color: 'FFFFFF', transparency: 100 },
        line: { color: hasBorder ? borders.find(border => border.color)?.color || fill?.color || 'FFFFFF' : 'FFFFFF', transparency: 100 },
        rectRadius: shapeName === 'roundRect' ? radius || undefined : undefined,
        shadow: hasFill && shadow ? shadow : undefined,
      });
      totals.shapeObjects += 1;
    } catch {
      warnings.push({ slide: node.slideIndex, type: 'render-shape-failed', tag: node.tag });
    }
  }

  if (hasBorder) renderBorders(slide, c, borders, slideRect, style.opacity, totals);
}

function renderBorders(slide, c, borders, slideRect, opacity, totals) {
  const [top, right, bottom, left] = borders;
  const borderRects = [
    top.width > 0 && top.color ? { x: c.x, y: c.y, w: c.w, h: Math.max(0.002, top.width / slideRect.h * PPT_H), color: top.color, alpha: top.alpha } : null,
    right.width > 0 && right.color ? { x: c.x + c.w - Math.max(0.002, right.width / slideRect.w * PPT_W), y: c.y, w: Math.max(0.002, right.width / slideRect.w * PPT_W), h: c.h, color: right.color, alpha: right.alpha } : null,
    bottom.width > 0 && bottom.color ? { x: c.x, y: c.y + c.h - Math.max(0.002, bottom.width / slideRect.h * PPT_H), w: c.w, h: Math.max(0.002, bottom.width / slideRect.h * PPT_H), color: bottom.color, alpha: bottom.alpha } : null,
    left.width > 0 && left.color ? { x: c.x, y: c.y, w: Math.max(0.002, left.width / slideRect.w * PPT_W), h: c.h, color: left.color, alpha: left.alpha } : null,
  ].filter(Boolean);

  for (const rect of borderRects) {
    slide.addShape('rect', {
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      fill: { color: rect.color, transparency: combinedTransparency(rect.alpha, opacity) },
      line: { color: rect.color, transparency: 100 },
    });
    totals.shapeObjects += 1;
  }
}

function renderText(slide, node, slideRect, warnings, totals) {
  const value = applyTextTransform(node.text || '', node.style?.textTransform);
  if (!value.trim()) return;
  const c = coords(node, slideRect);
  if (c.w < 0.01 || c.h < 0.01) return;
  const style = node.style || {};
  const color = parseCssColor(style.color) || { color: '111111', alpha: 1 };
  const fontSizePx = Math.max(4, Math.min(140, parseFloat(style.fontSize || '16') || 16));
  const weight = String(style.fontWeight || '');
  const singleLine = node.singleLine && !/[\r\n]/.test(value);
  const options = {
    x: c.x,
    y: c.y,
    h: Math.max(0.04, c.h + 0.03),
    margin: 0,
    breakLine: false,
    fit: singleLine ? 'resize' : 'shrink',
    wrap: singleLine ? false : !isNoWrap(style.whiteSpace),
    fontFace: firstFont(style.fontFamily),
    fontSize: fontSizePx * PX_TO_PT,
    color: color.color,
    bold: weight === 'bold' || Number.parseInt(weight, 10) >= 600,
    italic: style.fontStyle === 'italic',
    underline: String(style.textDecorationLine || '').includes('underline'),
    strike: String(style.textDecorationLine || '').includes('line-through'),
    align: normalizeAlign(style.textAlign),
    valign: normalizeValign(style.verticalAlign),
    rotate: rotateFromTransform(style.transform) || 0,
    transparency: combinedTransparency(color.alpha, style.opacity),
    charSpace: letterSpacing(style.letterSpacing),
  };
  if (!singleLine) options.w = Math.max(0.08, c.w + 0.04);
  try {
    slide.addText(value, options);
    totals.textObjects += 1;
  } catch {
    warnings.push({ slide: node.slideIndex, type: 'render-text-failed', text: value.slice(0, 60) });
  }
}

function renderNodeImage(slide, node, slideRect, warnings, totals) {
  const items = [];
  if (node.backgroundImageData) items.push({ data: node.backgroundImageData, kind: 'background-image' });
  if (node.imageData) items.push({ data: node.imageData, kind: node.imageKind || node.tag });
  if (!items.length) return;

  const c = coords(node, slideRect);
  for (const item of items) {
    try {
      slide.addImage({
        data: item.data,
        x: c.x,
        y: c.y,
        w: c.w,
        h: c.h,
        transparency: elementTransparency(node.style?.opacity),
        sizing: imageSizing(node, c, item.kind),
      });
      totals.imageObjects += 1;
    } catch {
      warnings.push({ slide: node.slideIndex, type: 'render-image-failed', tag: node.tag, kind: item.kind });
    }
  }
}

function coords(node, slideRect) {
  return {
    x: round((node.rect.x - slideRect.x) / slideRect.w * PPT_W),
    y: round((node.rect.y - slideRect.y) / slideRect.h * PPT_H),
    w: round(node.rect.w / slideRect.w * PPT_W),
    h: round(node.rect.h / slideRect.h * PPT_H),
  };
}

function imageSizing(node, c, kind) {
  const style = node.style || {};
  const fit = style.objectFit || (style.backgroundSize === 'cover' || style.backgroundSize === 'contain' ? style.backgroundSize : '');
  if ((kind === 'background-image' || node.tag === 'img') && (fit === 'cover' || fit === 'contain')) {
    return { type: fit, w: c.w, h: c.h };
  }
  return undefined;
}

async function collectActiveSlide(slideNumber) {
  const slide = document.querySelector('#deck > .slide.active, #deck > .slide[data-deck-active]');
  if (!slide) {
    return { index: slideNumber, rect: { x: 0, y: 0, w: 1920, h: 1080 }, root: null, warnings: [{ type: 'missing-slide' }], summary: null };
  }
  const rawRect = slide.getBoundingClientRect();
  const slideRect = rectObject(rawRect);
  const warnings = [];
  const root = await captureElement(slide, slideRect, warnings, 0, slideNumber);
  const summary = summarizeCapturedTree(root);
  summary.key = slide.dataset.vmSlideId || slide.dataset.layoutKey || slide.id || '';
  return { index: slideNumber, rect: slideRect, root, warnings, summary };
}

async function captureElement(el, slideRect, warnings, depth, slideIndex) {
  if (!(el instanceof Element) || isMediaChrome(el)) return null;
  const style = readStyle(el);
  if (!isVisibleElement(el, slideRect, style)) return null;
  const clipped = clippedRect(el.getBoundingClientRect(), slideRect);
  if (!clipped) return null;
  const tag = el.tagName.toLowerCase();
  const node = {
    tag,
    slideIndex,
    rect: rectObject(clipped),
    style,
    children: [],
  };
  if (tag === 'a' && el.href && !String(el.getAttribute('href') || '').startsWith('#')) node.href = el.href;

  if (tag === 'img') {
    node.imageData = await elementImageData(el, el.currentSrc || el.src || el.getAttribute('src') || '');
    node.imageKind = 'img';
    if (!node.imageData) warnings.push({ slide: slideIndex, type: 'image-skipped', reason: 'unreadable-img' });
    return node;
  }
  if (tag === 'canvas') {
    try {
      node.imageData = el.toDataURL('image/png');
      node.imageKind = 'canvas';
      warnings.push({ slide: slideIndex, type: 'node-image-fallback', node: 'canvas', count: 1 });
    } catch {
      warnings.push({ slide: slideIndex, type: 'canvas-skipped', reason: 'tainted-or-empty' });
    }
    return node;
  }
  if (tag === 'svg') {
    node.imageData = await svgElementData(el, clipped.width, clipped.height);
    node.imageKind = 'svg';
    if (node.imageData) warnings.push({ slide: slideIndex, type: 'node-image-fallback', node: 'svg', count: 1 });
    else warnings.push({ slide: slideIndex, type: 'svg-skipped', reason: 'rasterize-failed' });
    return node;
  }

  const bg = backgroundUrl(style.backgroundImage);
  if (bg) {
    node.backgroundImageData = await fetchImageDataUrl(bg);
    if (!node.backgroundImageData) warnings.push({ slide: slideIndex, type: 'background-image-skipped', url: bg.slice(0, 160) });
  }

  for (const child of el.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const textNode = captureTextNode(child, el, slideRect, style, slideIndex);
      if (textNode) node.children.push(textNode);
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const childNode = await captureElement(child, slideRect, warnings, depth + 1, slideIndex);
      if (childNode) node.children.push(childNode);
    }
  }
  return node;
}

function captureTextNode(textNode, parent, slideRect, style, slideIndex) {
  const keepWhitespace = ['pre', 'pre-wrap', 'pre-line', 'break-spaces'].includes(style.whiteSpace);
  const value = keepWhitespace ? textNode.textContent || '' : normalizeText(textNode.textContent || '');
  if (!value.trim()) return null;
  const range = document.createRange();
  range.selectNodeContents(textNode);
  const lineRects = [...range.getClientRects()].filter(rect => rect.width > 1 && rect.height > 1);
  const singleLine = lineRects.length <= 1 && !/[\r\n]/.test(value);
  let clipped = clippedRect(range.getBoundingClientRect(), slideRect);
  range.detach?.();
  const tag = parent.tagName.toLowerCase();
  const textNodeCount = [...parent.childNodes]
    .filter(child => child.nodeType === Node.TEXT_NODE && normalizeText(child.textContent || ''))
    .length;
  const visibleElementChildren = [...parent.children].filter(child => isVisibleElement(child, slideRect)).length;
  if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'blockquote', 'button', 'label'].includes(tag)
      && textNodeCount === 1
      && visibleElementChildren === 0) {
    clipped = clippedRect(parent.getBoundingClientRect(), slideRect) || clipped;
  }
  if (!clipped || clipped.width < 1 || clipped.height < 1) return null;
  const parentStyle = readStyle(parent);
  return {
    tag: '#text',
    slideIndex,
    rect: rectObject(clipped),
    style: parentStyle,
    text: value,
    singleLine,
    href: parent.closest('a')?.href || undefined,
    children: [],
  };
}

function readStyle(el) {
  const cs = getComputedStyle(el);
  const style = {};
  for (const key of STYLE_KEYS) style[key] = cs[key] || '';
  return style;
}

function summarizeCapturedTree(root) {
  const summary = {
    capturedNodes: 0,
    maxDepth: 0,
    textNodes: 0,
    backgroundImages: 0,
    svgImages: 0,
    canvasImages: 0,
    imageNodes: 0,
    shapeCandidates: 0,
  };
  summarizeNode(root, summary, 0);
  return summary;
}

function summarizeNode(node, summary, depth) {
  if (!node) return;
  summary.capturedNodes += 1;
  summary.maxDepth = Math.max(summary.maxDepth, depth);
  if (node.tag === '#text') summary.textNodes += 1;
  if (node.backgroundImageData) summary.backgroundImages += 1;
  if (node.imageKind === 'svg') summary.svgImages += 1;
  if (node.imageKind === 'canvas') summary.canvasImages += 1;
  if (node.imageData) summary.imageNodes += 1;
  if (hasPaint(node.style?.backgroundColor) || backgroundUrl(node.style?.backgroundImage) || node.style?.backgroundImage?.includes('gradient') || hasAnyBorder(node.style)) {
    summary.shapeCandidates += 1;
  }
  for (const child of node.children || []) summarizeNode(child, summary, depth + 1);
}

async function elementImageData(img, src) {
  if (!src) return null;
  if (src.startsWith('data:image/')) return src;
  try {
    const canvas = document.createElement('canvas');
    const width = img.naturalWidth || Math.max(1, Math.round(img.getBoundingClientRect().width));
    const height = img.naturalHeight || Math.max(1, Math.round(img.getBoundingClientRect().height));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  } catch {}
  return fetchImageDataUrl(src);
}

async function svgElementData(svg, width, height) {
  try {
    const clone = cloneSvgWithComputedStyle(svg);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    if (!clone.getAttribute('width')) clone.setAttribute('width', String(Math.max(1, Math.round(width))));
    if (!clone.getAttribute('height')) clone.setAttribute('height', String(Math.max(1, Math.round(height))));
    const xml = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * 2));
      canvas.height = Math.max(1, Math.round(height * 2));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png');
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return null;
  }
}

function cloneSvgWithComputedStyle(svg) {
  const clone = svg.cloneNode(true);
  const source = [svg, ...svg.querySelectorAll('*')];
  const target = [clone, ...clone.querySelectorAll('*')];
  source.forEach((el, index) => {
    const cs = getComputedStyle(el);
    const copy = target[index];
    if (!copy) return;
    const inline = [
      'fill',
      'stroke',
      'stroke-width',
      'stroke-linecap',
      'stroke-linejoin',
      'opacity',
      'font-family',
      'font-size',
      'font-weight',
      'color',
    ].map(name => `${name}:${cs.getPropertyValue(name)}`).join(';');
    copy.setAttribute('style', `${copy.getAttribute('style') || ''};${inline}`);
  });
  return clone;
}

function backgroundUrl(backgroundImage) {
  const match = String(backgroundImage || '').match(/url\\(["']?([^"')]+)["']?\\)/);
  if (!match) return null;
  try {
    return new URL(match[1], location.href).href;
  } catch {
    return null;
  }
}

async function fetchImageDataUrl(url) {
  try {
    if (url.startsWith('data:image/')) return url;
    const response = await fetch(url, { credentials: new URL(url, location.href).origin === location.origin ? 'same-origin' : 'omit' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return null;
    return await blobToDataUrl(blob);
  } catch {
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

function isVisibleElement(el, slideRect, style = getComputedStyle(el)) {
  if (!(el instanceof Element)) return false;
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) <= 0.01) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0.5 || rect.height <= 0.5) return false;
  if (rect.right < slideRect.x || rect.left > slideRect.x + slideRect.w || rect.bottom < slideRect.y || rect.top > slideRect.y + slideRect.h) return false;
  return true;
}

function isMediaChrome(el) {
  return !!el.closest('script,style,noscript,template,#nav,#preview-panel,#slide-rail,.theme03-theme-toggle');
}

function clippedRect(rect, slideRect) {
  const left = Math.max(rect.left, slideRect.x);
  const top = Math.max(rect.top, slideRect.y);
  const right = Math.min(rect.right, slideRect.x + slideRect.w);
  const bottom = Math.min(rect.bottom, slideRect.y + slideRect.h);
  if (right <= left || bottom <= top) return null;
  return { left, top, width: right - left, height: bottom - top };
}

function rectObject(rect) {
  return {
    x: rect.left ?? rect.x,
    y: rect.top ?? rect.y,
    w: rect.width ?? rect.w,
    h: rect.height ?? rect.h,
  };
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hasPaint(color) {
  const raw = String(color || '').trim();
  return raw && raw !== 'transparent' && !/^rgba?\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)$/i.test(raw);
}

function hasAnyBorder(style) {
  return ['Top', 'Right', 'Bottom', 'Left'].some(side => parseFloat(style?.[`border${side}Width`] || '0') > 0 && hasPaint(style?.[`border${side}Color`]));
}

function parseCssColor(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'transparent') return null;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) {
    const hex = raw.slice(1);
    return { color: (hex.length === 3 ? hex.replace(/./g, c => c + c) : hex).toUpperCase(), alpha: 1 };
  }
  const rgba = raw.match(/rgba?\(([^)]+)\)/i);
  if (!rgba) return null;
  const parts = rgba[1].split(',').map(part => part.trim());
  const r = clampColor(parts[0]);
  const g = clampColor(parts[1]);
  const b = clampColor(parts[2]);
  const alpha = parts[3] == null ? 1 : Math.max(0, Math.min(1, Number(parts[3])));
  if (alpha <= 0.01) return null;
  return {
    color: [r, g, b].map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase(),
    alpha,
  };
}

function colorFromBackgroundImage(value) {
  const raw = String(value || '');
  if (!raw.includes('gradient')) return null;
  const colors = [...raw.matchAll(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/ig)]
    .map(match => parseCssColor(match[0]))
    .filter(Boolean);
  if (!colors.length) return null;
  const baseColors = colors.filter(color => color.alpha >= 0.85);
  const source = baseColors.length ? baseColors : colors;
  const rgb = source.reduce((acc, color) => {
    acc.r += Number.parseInt(color.color.slice(0, 2), 16);
    acc.g += Number.parseInt(color.color.slice(2, 4), 16);
    acc.b += Number.parseInt(color.color.slice(4, 6), 16);
    acc.a += color.alpha;
    return acc;
  }, { r: 0, g: 0, b: 0, a: 0 });
  const count = source.length;
  return {
    color: [rgb.r / count, rgb.g / count, rgb.b / count].map(n => clampColor(n).toString(16).padStart(2, '0')).join('').toUpperCase(),
    alpha: Math.max(0, Math.min(1, rgb.a / count)),
    gradient: true,
  };
}

function readBorders(style) {
  return ['Top', 'Right', 'Bottom', 'Left'].map(side => {
    const color = parseCssColor(style[`border${side}Color`]);
    const width = parseFloat(style[`border${side}Width`] || '0') || 0;
    const styleValue = style[`border${side}Style`];
    return {
      width: styleValue === 'none' || styleValue === 'hidden' ? 0 : width,
      color: color?.color || null,
      alpha: color?.alpha || 0,
    };
  });
}

function maxRadiusPx(style) {
  return Math.max(
    parseFloat(style.borderTopLeftRadius || '0') || 0,
    parseFloat(style.borderTopRightRadius || '0') || 0,
    parseFloat(style.borderBottomRightRadius || '0') || 0,
    parseFloat(style.borderBottomLeftRadius || '0') || 0,
  );
}

function parseBoxShadow(value) {
  const raw = String(value || '');
  if (!raw || raw === 'none') return null;
  const color = parseCssColor(raw.match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i)?.[0]);
  if (!color) return null;
  const numbers = raw.replace(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/ig, '').match(/-?\d+(\.\d+)?px/g) || [];
  const offsetX = parseFloat(numbers[0] || '0') || 0;
  const offsetY = parseFloat(numbers[1] || '0') || 0;
  const blur = parseFloat(numbers[2] || '8') || 8;
  const angle = ((Math.atan2(offsetY, offsetX) * 180 / Math.PI) + 360) % 360;
  const offset = Math.sqrt(offsetX ** 2 + offsetY ** 2) * PX_TO_PT;
  return {
    type: 'outer',
    color: color.color,
    opacity: Math.max(0.05, Math.min(0.7, color.alpha)),
    blur: Math.max(1, Math.min(24, blur * PX_TO_PT)),
    offset: Math.max(1, Math.min(18, offset)),
    angle,
  };
}

function combinedTransparency(alpha, opacity) {
  const composite = Math.max(0, Math.min(1, Number(alpha ?? 1) * Number(opacity || 1)));
  return Math.round((1 - composite) * 100);
}

function elementTransparency(opacity) {
  return combinedTransparency(1, opacity);
}

function rotateFromTransform(value) {
  const raw = String(value || '');
  if (!raw || raw === 'none') return 0;
  const matrix = raw.match(/matrix\(([^)]+)\)/);
  if (!matrix) return 0;
  const [a, b] = matrix[1].split(',').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round(Math.atan2(b, a) * 180 / Math.PI);
}

function letterSpacing(value) {
  const n = parseFloat(value || '0');
  return Number.isFinite(n) ? Math.max(-2, Math.min(12, n * PX_TO_PT)) : 0;
}

function firstFont(value) {
  return String(value || 'Arial').split(',')[0].replace(/^["']|["']$/g, '').trim() || 'Arial';
}

function normalizeAlign(value) {
  if (value === 'center' || value === 'right' || value === 'justify') return value;
  return 'left';
}

function normalizeValign(value) {
  if (value === 'bottom' || value === 'sub') return 'bottom';
  if (value === 'middle') return 'mid';
  return 'top';
}

function isNoWrap(value) {
  return value === 'nowrap';
}

function applyTextTransform(text, transform) {
  if (transform === 'uppercase') return text.toUpperCase();
  if (transform === 'lowercase') return text.toLowerCase();
  return text;
}

function clampColor(value) {
  return Math.max(0, Math.min(255, Math.round(Number.parseFloat(value) || 0)));
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}
