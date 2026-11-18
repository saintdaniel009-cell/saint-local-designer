// Saint Local Designer — Figma side.
// Receives a JSON layout spec from designer.py and builds native Figma frames
// (auto layout, text, component instances, prototype links). Also exports PNGs
// for the model to review, and serializes frames you fixed by hand into
// training data ("harvest").

figma.showUI(__html__, { width: 260, height: 90 });

const status = (t) => figma.ui.postMessage({ status: t });
let WARN = [];
let LINKS = [];
let DEFAULT_FONT = 'Inter';

// ---------- fonts ----------
let FONTS = null;
const loadedFonts = new Set();
const WEIGHT_STYLES = {
  100: ['Thin'], 200: ['ExtraLight', 'Extra Light'], 300: ['Light'], 400: ['Regular'],
  500: ['Medium'], 600: ['SemiBold', 'Semi Bold'], 700: ['Bold'],
  800: ['ExtraBold', 'Extra Bold'], 900: ['Black', 'Heavy'],
};
async function fontIndex() {
  if (FONTS) return FONTS;
  FONTS = {};
  const list = await figma.listAvailableFontsAsync();
  for (const f of list) {
    const fam = f.fontName.family;
    if (!FONTS[fam]) FONTS[fam] = new Set();
    FONTS[fam].add(f.fontName.style);
  }
  return FONTS;
}
async function pickFont(family, weight) {
  const idx = await fontIndex();
  let fam = family;
  if (!idx[fam]) {
    WARN.push('Font "' + family + '" not installed; used Inter');
    fam = idx['Inter'] ? 'Inter' : Object.keys(idx)[0];
  }
  const styles = idx[fam];
  const w = Math.max(100, Math.min(900, Math.round((weight || 400) / 100) * 100));
  let style = null;
  for (const ww of [w, w + 100, w - 100, w + 200, w - 200, 400]) {
    for (const s of WEIGHT_STYLES[ww] || []) if (styles.has(s)) { style = s; break; }
    if (style) break;
  }
  if (!style) style = styles.has('Regular') ? 'Regular' : Array.from(styles)[0];
  const fn = { family: fam, style: style };
  const key = fam + '|' + style;
  if (!loadedFonts.has(key)) { await figma.loadFontAsync(fn); loadedFonts.add(key); }
  return fn;
}

// ---------- colour ----------
function rgba(hex) {
  let h = String(hex).trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) { WARN.push('Bad colour "' + hex + '"'); h = 'FF00FF'; }
  const n = parseInt(h.slice(0, 6), 16);
  return {
    r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255,
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}
function paints(f) {
  if (f == null || f === 'none' || f === 'transparent') return [];
  if (typeof f === 'object' && f.gradient) {
    const t = ((f.angle == null ? 180 : f.angle) * Math.PI) / 180; // CSS angle
    const dx = Math.sin(t), dy = -Math.cos(t), px = Math.cos(t), py = Math.sin(t);
    const n = f.gradient.length;
    return [{
      type: 'GRADIENT_LINEAR',
      gradientStops: f.gradient.map((c, i) => {
        const x = rgba(c);
        return { position: n > 1 ? i / (n - 1) : 0, color: { r: x.r, g: x.g, b: x.b, a: x.a } };
      }),
      gradientTransform: [[dx, dy, 0.5 - 0.5 * (dx + dy)], [px, py, 0.5 - 0.5 * (px + py)]],
    }];
  }
  const x = rgba(f);
  return [{ type: 'SOLID', color: { r: x.r, g: x.g, b: x.b }, opacity: x.a }];
}

// ---------- components ----------
let COMPS = null;
async function components() {
  if (COMPS) return COMPS;
  await figma.loadAllPagesAsync();
  COMPS = {};
  for (const n of figma.root.findAllWithCriteria({ types: ['COMPONENT_SET', 'COMPONENT'] })) {
    if (n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET') continue;
    COMPS[n.name.toLowerCase()] = n;
  }
  return COMPS;
}
async function catalog() {
  const c = await components();
  const out = [];
  for (const key of Object.keys(c).slice(0, 400)) {
    const n = c[key];
    const props = {};
    try {
      const defs = n.componentPropertyDefinitions;
      for (const p in defs) {
        const d = defs[p];
        props[p.split('#')[0]] = d.type === 'VARIANT' ? d.variantOptions : d.type.toLowerCase();
      }
    } catch (e) {}
    out.push({ name: n.name, w: Math.round(n.width), h: Math.round(n.height), props: props, desc: n.description || '' });
  }
  return { file: figma.root.name, page: figma.currentPage.name, components: out };
}

// ---------- build ----------
const ALIGN = { start: 'MIN', center: 'CENTER', end: 'MAX', space: 'SPACE_BETWEEN', between: 'SPACE_BETWEEN' };
function pad(n, p) {
  let t, r, b, l;
  if (typeof p === 'number') t = r = b = l = p;
  else if (Array.isArray(p) && p.length === 2) { t = b = p[0]; r = l = p[1]; }
  else if (Array.isArray(p) && p.length === 4) { t = p[0]; r = p[1]; b = p[2]; l = p[3]; }
  else return;
  n.paddingTop = t; n.paddingRight = r; n.paddingBottom = b; n.paddingLeft = l;
}
function safe(label, fn) {
  try { fn(); } catch (e) { WARN.push(label + ': ' + (e && e.message ? e.message : e)); }
}

async function build(s, parent, path) {
  const t = s.type || 'frame';
  const parentAuto = parent.type !== 'SECTION' && parent.type !== 'PAGE' && 'layoutMode' in parent && parent.layoutMode !== 'NONE';
  let n;
  if (t === 'text') n = figma.createText();
  else if (t === 'rect' || t === 'image') n = figma.createRectangle();
  else if (t === 'ellipse') n = figma.createEllipse();
  else if (t === 'instance') {
    const c = (await components())[String(s.component || '').toLowerCase()];
    if (c) n = (c.type === 'COMPONENT_SET' ? c.defaultVariant : c).createInstance();
    else {
      WARN.push(path + ': component "' + s.component + '" not found — placeholder used');
      n = figma.createFrame();
      n.fills = paints('#EEE7F6');
      n.cornerRadius = 8;
      n.name = 'MISSING: ' + s.component;
    }
  } else {
    n = figma.createFrame();
    n.fills = [];
    n.clipsContent = !!s.clip;
  }
  parent.appendChild(n);
  if (s.name) n.name = s.name;

  // auto layout
  if (n.type === 'FRAME' && s.layout && s.layout !== 'none') safe(path + ' layout', () => {
    n.layoutMode = s.layout === 'row' ? 'HORIZONTAL' : 'VERTICAL';
    n.primaryAxisSizingMode = 'AUTO';
    n.counterAxisSizingMode = 'AUTO';
    if (typeof s.gap === 'number') n.itemSpacing = s.gap;
    if (s.pad != null) pad(n, s.pad);
    n.primaryAxisAlignItems = ALIGN[s.align] || 'MIN';
    const ca = ALIGN[s.cross];
    n.counterAxisAlignItems = ca === 'CENTER' || ca === 'MAX' ? ca : 'MIN';
    if (s.wrap && n.layoutMode === 'HORIZONTAL') n.layoutWrap = 'WRAP';
  });

  // text
  if (t === 'text') {
    const fn = await pickFont(s.font || DEFAULT_FONT, s.weight || 400);
    n.fontName = fn;
    n.characters = s.text == null ? '' : String(s.text);
    safe(path + ' text', () => {
      n.fontSize = s.size || 16;
      n.fills = paints(s.color || '#111111');
      if (s.lineHeight) n.lineHeight = s.lineHeight > 4 ? { unit: 'PIXELS', value: s.lineHeight } : { unit: 'PERCENT', value: s.lineHeight * 100 };
      if (s.tracking != null) n.letterSpacing = { unit: 'PERCENT', value: s.tracking };
      if (s.textAlign) n.textAlignHorizontal = { left: 'LEFT', center: 'CENTER', right: 'RIGHT' }[s.textAlign] || 'LEFT';
    });
  }

  // instance overrides
  if (n.type === 'INSTANCE') {
    if (s.props) {
      const defs = n.componentProperties;
      const out = {};
      for (const k in s.props) {
        const key = Object.keys(defs).find((d) => d === k || d.split('#')[0].toLowerCase() === k.toLowerCase());
        if (!key) { WARN.push(path + ': no prop "' + k + '" on ' + s.component); continue; }
        let val = s.props[k];
        if (defs[key].type === 'INSTANCE_SWAP' && typeof val === 'string') {
          const all = await components();
          const pn = key.split('#')[0];
          const c = all[val.toLowerCase()] || all[(pn + '/' + val).toLowerCase()] || all[('icon/' + val).toLowerCase()];
          if (!c) { WARN.push(path + ': icon "' + val + '" not found'); continue; }
          val = c.id;
        }
        out[key] = val;
      }
      safe(path + ' props', () => n.setProperties(out));
    }
    if (s.text != null) {
      const tn = n.findOne((x) => x.type === 'TEXT');
      if (tn && tn.fontName !== figma.mixed) {
        await figma.loadFontAsync(tn.fontName);
        tn.characters = String(s.text);
      }
    }
  }

  // appearance
  safe(path + ' style', () => {
    if (t === 'image') { n.fills = paints(s.fill || '#E3D6F2'); n.name = 'IMG: ' + (s.alt || s.name || 'image'); }
    else if (s.fill !== undefined && t !== 'text' && n.type !== 'INSTANCE') n.fills = paints(s.fill);
    if (s.radius != null && 'cornerRadius' in n) {
      if (Array.isArray(s.radius)) { n.topLeftRadius = s.radius[0]; n.topRightRadius = s.radius[1]; n.bottomRightRadius = s.radius[2]; n.bottomLeftRadius = s.radius[3]; }
      else n.cornerRadius = s.radius;
    }
    if (s.stroke) {
      n.strokes = paints(typeof s.stroke === 'object' && !s.stroke.gradient ? s.stroke.color : s.stroke);
      n.strokeWeight = (typeof s.stroke === 'object' && s.stroke.width) || 1;
      n.strokeAlign = 'INSIDE';
    }
    if (s.shadow) {
      const c = rgba(s.shadow.color || '#3D145A26');
      n.effects = [{ type: 'DROP_SHADOW', color: { r: c.r, g: c.g, b: c.b, a: c.a }, offset: { x: s.shadow.x || 0, y: s.shadow.y == null ? 8 : s.shadow.y }, radius: s.shadow.blur == null ? 24 : s.shadow.blur, spread: s.shadow.spread || 0, visible: true, blendMode: 'NORMAL' }];
    }
    if (s.opacity != null) n.opacity = s.opacity;
  });

  // sizing & position
  safe(path + ' size', () => {
    const W = s.w, H = s.h;
    if (typeof W === 'number' || typeof H === 'number') {
      n.resize(typeof W === 'number' ? W : n.width, typeof H === 'number' ? H : n.height);
    }
    if (n.type === 'TEXT') n.textAutoResize = typeof W === 'number' || W === 'fill' ? 'HEIGHT' : 'WIDTH_AND_HEIGHT';
    if (n.type === 'FRAME' && n.layoutMode !== 'NONE') {
      if (typeof W === 'number') n.layoutSizingHorizontal = 'FIXED';
      if (typeof H === 'number') n.layoutSizingVertical = 'FIXED';
    }
    if (parentAuto) {
      if (s.absolute) n.layoutPositioning = 'ABSOLUTE';
      else {
        if (W === 'fill') n.layoutSizingHorizontal = 'FILL';
        if (H === 'fill') n.layoutSizingVertical = 'FILL';
      }
    }
    if ((s.absolute || !parentAuto) && parent.type !== 'SECTION') {
      if (typeof s.x === 'number') n.x = s.x;
      if (typeof s.y === 'number') n.y = s.y;
    }
  });

  if (s.modes && typeof s.modes === 'object') {
    const cols = await figma.variables.getLocalVariableCollectionsAsync();
    for (const cname in s.modes) {
      const col = cols.find((c) => c.name.toLowerCase() === cname.toLowerCase());
      const mode = col && col.modes.find((m) => m.name.toLowerCase() === String(s.modes[cname]).toLowerCase());
      if (!mode) { WARN.push(path + ': no mode "' + s.modes[cname] + '" in "' + cname + '"'); continue; }
      safe(path + ' mode', () => n.setExplicitVariableModeForCollection(col, mode.modeId));
    }
  }
  if (s.goto) LINKS.push([n, String(s.goto)]);

  const kids = Array.isArray(s.children) && n.type !== 'INSTANCE' ? s.children : [];
  if (n.type === 'INSTANCE' && Array.isArray(s.children) && s.children.length) WARN.push(path + ': children inside a component were ignored');
  for (let i = 0; i < kids.length; i++) {
    if (kids[i] && typeof kids[i] === 'object') await build(kids[i], n, path + '.' + i);
  }
  return n;
}

async function exportPng(node, scale) {
  const bytes = await node.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: scale || 1 } });
  return figma.base64Encode(bytes);
}

async function render(m) {
  WARN = []; LINKS = [];
  DEFAULT_FONT = m.defaultFont || 'Inter';
  let x0 = null, y0 = 0;
  if (m.replace) {
    const old = await figma.getNodeByIdAsync(m.replace);
    if (old) { x0 = old.x; y0 = old.y; old.remove(); }
  }
  if (x0 === null) {
    let maxX = 0;
    for (const c of figma.currentPage.children) maxX = Math.max(maxX, c.x + c.width);
    x0 = figma.currentPage.children.length ? maxX + 400 : 0;
  }
  const section = figma.createSection();
  section.name = m.title || 'Local Designer';
  section.x = x0; section.y = y0;

  const built = [];
  let x = 120, maxH = 0;
  const screens = m.spec.screens || [];
  for (let i = 0; i < screens.length; i++) {
    status('Building ' + (i + 1) + '/' + screens.length + ': ' + (screens[i].name || 'screen'));
    const base = { type: 'frame', layout: 'col', w: m.w || 430, h: m.h || 932, fill: '#FFFFFF', clip: true };
    const f = await build(Object.assign(base, screens[i]), section, 'screens[' + i + ']');
    f.x = x; f.y = 160;
    x += f.width + 120;
    maxH = Math.max(maxH, f.height);
    built.push(f);
  }
  section.resizeWithoutConstraints(Math.max(x, 400), maxH + 320);

  const byName = {};
  for (const f of built) byName[f.name.toLowerCase()] = f;
  for (const pair of LINKS) {
    const dest = byName[pair[1].toLowerCase()];
    if (!dest) { WARN.push('goto "' + pair[1] + '" has no matching screen'); continue; }
    try {
      await pair[0].setReactionsAsync([{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: dest.id, navigation: 'NAVIGATE', transition: { type: 'SMART_ANIMATE', easing: { type: 'EASE_OUT' }, duration: 0.3 }, resetVideoPosition: false }] }]);
    } catch (e) { WARN.push('link ' + pair[1] + ': ' + e.message); }
  }
  figma.viewport.scrollAndZoomIntoView([section]);

  status('Exporting previews…');
  const images = [];
  for (const f of built) images.push(await exportPng(f, m.scale || 1));
  return { section: section.id, screens: built.map((f) => f.name), images: images, warnings: WARN.slice(0, 40) };
}

// ---------- serialize (harvest your hand-fixed frames as training data) ----------
function hex(c, o) {
  const h = (v) => Math.round(v * 255).toString(16).padStart(2, '0');
  const a = o == null || o >= 0.999 ? '' : h(o);
  return ('#' + h(c.r) + h(c.g) + h(c.b) + a).toUpperCase();
}
function serPaint(fills) {
  if (fills === figma.mixed || !fills || !fills.length) return undefined;
  const p = fills.find((f) => f.visible !== false);
  if (!p) return undefined;
  if (p.type === 'SOLID') return hex(p.color, p.opacity);
  if (p.type === 'GRADIENT_LINEAR') {
    const m = p.gradientTransform;
    const angle = Math.round((Math.atan2(m[0][0], -m[0][1]) * 180) / Math.PI);
    return { gradient: p.gradientStops.map((s) => hex(s.color, s.color.a)), angle: (angle + 360) % 360 };
  }
  if (p.type === 'IMAGE') return '#E3D6F2';
  return undefined;
}
const REV = { MIN: 'start', CENTER: 'center', MAX: 'end', SPACE_BETWEEN: 'space' };
function sizeOf(n, axis) {
  const k = axis === 'w' ? 'layoutSizingHorizontal' : 'layoutSizingVertical';
  const v = n[k];
  if (v === 'FILL') return 'fill';
  if (v === 'HUG') return undefined;
  return Math.round(axis === 'w' ? n.width : n.height);
}
async function ser(n, isRoot) {
  const s = { name: n.name };
  if (n.type === 'TEXT') {
    s.type = 'text';
    s.text = n.characters;
    if (n.fontName !== figma.mixed) {
      s.font = n.fontName.family;
      const st = n.fontName.style.replace(' ', '');
      for (const w in WEIGHT_STYLES) if (WEIGHT_STYLES[w].map((x) => x.replace(' ', '')).indexOf(st) >= 0) s.weight = +w;
    }
    if (n.fontSize !== figma.mixed) s.size = n.fontSize;
    s.color = serPaint(n.fills);
    if (n.lineHeight !== figma.mixed && n.lineHeight.unit !== 'AUTO') s.lineHeight = n.lineHeight.unit === 'PIXELS' ? n.lineHeight.value : n.lineHeight.value / 100;
    if (n.letterSpacing !== figma.mixed && n.letterSpacing.value) s.tracking = n.letterSpacing.unit === 'PERCENT' ? n.letterSpacing.value : +(n.letterSpacing.value / (n.fontSize || 16) * 100).toFixed(1);
    if (n.textAlignHorizontal !== 'LEFT') s.textAlign = n.textAlignHorizontal.toLowerCase();
    if (n.textAutoResize !== 'WIDTH_AND_HEIGHT') s.w = sizeOf(n, 'w');
  } else if (n.type === 'INSTANCE') {
    s.type = 'instance';
    const main = await n.getMainComponentAsync();
    s.component = main ? (main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent.name : main.name) : n.name;
    const props = {};
    try { for (const k in n.componentProperties) { const cp = n.componentProperties[k]; let v = cp.value; if (cp.type === 'INSTANCE_SWAP') { const ic = await figma.getNodeByIdAsync(v); v = ic ? ic.name.replace(/^Icon\//, '') : v; } props[k.split('#')[0]] = v; } } catch (e) {}
    if (Object.keys(props).length) s.props = props;
    s.w = sizeOf(n, 'w'); s.h = sizeOf(n, 'h');
  } else if (n.type === 'RECTANGLE' || n.type === 'ELLIPSE' || n.type === 'VECTOR' || n.type === 'LINE' || n.type === 'BOOLEAN_OPERATION' || n.type === 'STAR' || n.type === 'POLYGON') {
    const img = n.fills !== figma.mixed && n.fills && n.fills.some((f) => f.type === 'IMAGE');
    s.type = img ? 'image' : n.type === 'ELLIPSE' ? 'ellipse' : 'rect';
    if (img) s.alt = n.name;
    s.w = Math.round(n.width); s.h = Math.round(n.height);
    s.fill = serPaint(n.fills);
  } else {
    s.type = 'frame';
    if ('layoutMode' in n && n.layoutMode !== 'NONE') {
      s.layout = n.layoutMode === 'HORIZONTAL' ? 'row' : 'col';
      if (n.itemSpacing) s.gap = n.itemSpacing;
      const p = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
      if (p.some((v) => v)) s.pad = p.every((v) => v === p[0]) ? p[0] : p[0] === p[2] && p[1] === p[3] ? [p[0], p[1]] : p;
      if (n.primaryAxisAlignItems !== 'MIN') s.align = REV[n.primaryAxisAlignItems];
      if (n.counterAxisAlignItems !== 'MIN') s.cross = REV[n.counterAxisAlignItems];
    }
    if ('fills' in n) s.fill = serPaint(n.fills);
    if ('cornerRadius' in n && n.cornerRadius && n.cornerRadius !== figma.mixed) s.radius = n.cornerRadius;
    if ('clipsContent' in n && n.clipsContent && !isRoot) s.clip = true;
    if (isRoot) { s.w = Math.round(n.width); s.h = Math.round(n.height); }
    else if ('layoutSizingHorizontal' in n) { s.w = sizeOf(n, 'w'); s.h = sizeOf(n, 'h'); }
    else { s.w = Math.round(n.width); s.h = Math.round(n.height); }
    if ('children' in n && n.children.length) { s.children = []; for (const c of n.children) if (c.visible) s.children.push(await ser(c, false)); }
  }
  if ('strokes' in n && n.strokes.length && n.type !== 'TEXT') { const c = serPaint(n.strokes); if (c) s.stroke = { color: c, width: n.strokeWeight === figma.mixed ? 1 : n.strokeWeight }; }
  if ('opacity' in n && n.opacity < 1) s.opacity = +n.opacity.toFixed(2);
  if ('layoutPositioning' in n && n.layoutPositioning === 'ABSOLUTE') { s.absolute = true; s.x = Math.round(n.x); s.y = Math.round(n.y); }
  const r = n.reactions || [];
  for (const re of r) {
    const a = (re.actions || [re.action]).find((x) => x && x.type === 'NODE' && x.destinationId);
    if (a) { const d = await figma.getNodeByIdAsync(a.destinationId); if (d) s.goto = d.name; }
  }
  for (const k of Object.keys(s)) if (s[k] === undefined) delete s[k];
  return s;
}
function selectedScreens() {
  let sel = figma.currentPage.selection.slice();
  if (sel.length === 1 && sel[0].type === 'SECTION') sel = sel[0].children.filter((c) => c.type === 'FRAME');
  if (!sel.length) throw new Error('Select the screen frame(s) (or their section) in Figma first.');
  return sel.sort((a, b) => a.x - b.x);
}


// ---------- motion (animate command) ----------
const PRESETS = {
  'fade-in': [['Opacity', { type: 'fadeIn' }]],
  'fade-up': [['Opacity', { type: 'fadeIn' }], ['Position', { type: 'slide_in', direction: 'bottom', distance: 24 }]],
  'fade-down': [['Opacity', { type: 'fadeIn' }], ['Position', { type: 'slide_in', direction: 'top', distance: 24 }]],
  'slide-left': [['Opacity', { type: 'fadeIn' }], ['Position', { type: 'slide_in', direction: 'right', distance: 60 }]],
  'slide-right': [['Opacity', { type: 'fadeIn' }], ['Position', { type: 'slide_in', direction: 'left', distance: 60 }]],
  'pop': [['Opacity', { type: 'fadeIn' }], ['Scale', { type: 'scaleIn', amount: 70 }]],
  'draw': [['Path', { type: 'draw' }]],
  'text-reveal': [['TextStagger', { textDelayGrouping: 'WORD', direction: 'bottom', distance: 16, opacityEnabled: true }]],
};
function applyPreset(node, preset, at, dur) {
  for (const [style, props] of PRESETS[preset]) {
    node.applyAnimationStyle(style, { duration: dur, timelineOffset: at, props: Object.assign({}, props) });
  }
}
function layerNames(root) {
  const out = [];
  const walk = (n, d) => {
    if (d > 0) out.push(n.name + (n.type === 'TEXT' ? ' (text)' : n.type === 'INSTANCE' ? ' (component)' : '') + ('children' in n && n.type !== 'INSTANCE' && n.children.length ? ' [' + n.children.length + ' children]' : ''));
    if ('children' in n && n.type !== 'INSTANCE' && d < 4) for (const c of n.children) walk(c, d + 1);
  };
  walk(root, 0);
  return out;
}
async function motionTree() {
  return selectedScreens().map((s) => ({ name: s.name, layers: layerNames(s) }));
}
async function animate(m) {
  WARN = [];
  const screens = selectedScreens();
  const done = [];
  for (const spec of m.spec.screens || []) {
    const screen = screens.find((s) => s.name.toLowerCase() === String(spec.name || '').toLowerCase()) || (screens.length === 1 ? screens[0] : null);
    if (!screen) { WARN.push('screen "' + spec.name + '" is not selected'); continue; }
    for (const n of screen.findAll((x) => 'animationStyles' in x && x.animationStyles && x.animationStyles.length)) {
      for (const st of n.animationStyles) { try { n.removeAnimationStyle(st.id); } catch (e) {} }
    }
    try { for (const st of screen.animationStyles || []) screen.removeAnimationStyle(st.id); } catch (e) {}
    let end = 0;
    for (const a of spec.animations || []) {
      const preset = String(a.preset || '').toLowerCase();
      if (!PRESETS[preset] && preset !== 'stagger') { WARN.push('unknown preset "' + a.preset + '"'); continue; }
      const name = String(a.target || '').toLowerCase();
      const target = name === screen.name.toLowerCase() ? screen : screen.findOne((x) => x.name.toLowerCase() === name);
      if (!target) { WARN.push('no layer named "' + a.target + '" on ' + screen.name); continue; }
      const at = typeof a.at === 'number' ? a.at : 0;
      const dur = typeof a.duration === 'number' ? a.duration : 0.45;
      try {
        if (preset === 'stagger') {
          const kids = 'children' in target ? target.children.filter((k) => k.visible) : [];
          const gap = typeof a.gap === 'number' ? a.gap : 0.06;
          kids.forEach((k, i) => applyPreset(k, 'fade-up', at + i * gap, dur));
          end = Math.max(end, at + Math.max(0, kids.length - 1) * gap + dur);
        } else if (preset === 'draw') {
          const vecs = target.findAll ? target.findAll((x) => x.type === 'VECTOR' || x.type === 'ELLIPSE' || x.type === 'LINE') : [target];
          for (const v of vecs.length ? vecs : [target]) applyPreset(v, 'draw', at, dur);
          end = Math.max(end, at + dur);
        } else if (preset === 'text-reveal') {
          const texts = target.type === 'TEXT' ? [target] : target.findAll((x) => x.type === 'TEXT');
          for (const t of texts) applyPreset(t, 'text-reveal', at, dur);
          end = Math.max(end, at + dur);
        } else {
          applyPreset(target, preset, at, dur);
          end = Math.max(end, at + dur);
        }
        done.push(screen.name + ': ' + a.target + ' → ' + preset);
      } catch (e) { WARN.push(a.target + ' ' + preset + ': ' + (e.message || e)); }
    }
    try { screen.setTimelineDuration(screen.id, Math.max(1, Math.round((end + 0.5) * 10) / 10)); } catch (e) { WARN.push('timeline: ' + e.message); }
  }
  return { applied: done, warnings: WARN.slice(0, 40) };
}
// ---------- message router ----------
figma.ui.onmessage = async (m) => {
  try {
    let data;
    if (m.cmd === 'ping') data = 'pong';
    else if (m.cmd === 'catalog') data = await catalog();
    else if (m.cmd === 'render') data = await render(m);
    else if (m.cmd === 'motion_tree') data = await motionTree();
    else if (m.cmd === 'animate') data = await animate(m);
    else if (m.cmd === 'export_selection') {
      const sel = selectedScreens();
      data = [];
      for (const n of sel) data.push(await exportPng(n, 1));
    } else if (m.cmd === 'serialize_selection') {
      await figma.loadAllPagesAsync();
      data = { screens: [] };
      for (const n of selectedScreens()) data.screens.push(await ser(n, true));
    } else throw new Error('Unknown command ' + m.cmd);
    figma.ui.postMessage({ id: m.id, ok: true, data: data });
  } catch (e) {
    figma.ui.postMessage({ id: m.id, ok: false, error: String(e && e.message ? e.message : e) });
  }
};
