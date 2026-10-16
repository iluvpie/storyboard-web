'use strict';
// Blur filters for the active layer, or every selected layer at once (or just
// the selection on them), like Procreate's: Gaussian, Motion and Perspective. They preview live; Apply (or
// Enter) keeps the result as one undo step, Cancel (or Escape) puts the layer
// back. While one is open, the canvas sets it too:
//   Gaussian     drag sideways for more or less
//   Motion       drag the way the thing moves; the length is the amount
//   Perspective  click or drag to place the centre it blurs away from

const filterPanel = $('#filterPanel');
const filterMark = $('#filterMark');
// `var`, so earlier files can check it before this one has run.
var filter = null; // { kind, items: [{ layer, canvas, backup, tex }], amount, angle, cx, cy, raf, drag }

const BLURS = {
  gaussian: { title: 'Gaussian blur', amount: 8, max: 100, unit: 'px', hint: 'Drag sideways on the canvas for more or less.' },
  motion: { title: 'Motion blur', amount: 60, max: 400, unit: 'px', hint: 'Drag on the canvas the way it moves.' },
  perspective: { title: 'Perspective blur', amount: 30, max: 100, unit: '%', hint: 'Click or drag on the canvas to place the centre.' },
  // Bloom: a soft halo of the drawing's own colours added on top of it, so
  // it shines (for light, magic, fire). Strongest on a dark background.
  glow: { title: 'Glow', amount: 80, max: 300, unit: '%', size: 40, hint: 'Drag sideways on the canvas to spread the glow more or less.' },
};

// Motion and Perspective: each pixel averages samples along a line, on the
// GPU. Colours are premultiplied so soft edges blur cleanly; anything beyond
// the layer counts as empty.
const blurGL = (() => {
  const canvas = new OffscreenCanvas(1, 1);
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true });
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 p; varying vec2 uv; void main() { uv = vec2((p.x + 1.0) / 2.0, (1.0 - p.y) / 2.0); gl_Position = vec4(p, 0.0, 1.0); }'));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, `
    precision highp float;
    varying vec2 uv;
    uniform sampler2D tex;
    uniform int mode;      // 0 motion, 1 perspective
    uniform vec2 dir;      // motion: the whole streak, in texture units
    uniform vec2 center;   // perspective: the centre, in texture units
    uniform float amount;  // perspective: how far towards the centre it reaches
    uniform int count;
    vec4 at(vec2 q) {
      return (q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0) ? vec4(0.0) : texture2D(tex, q);
    }
    void main() {
      vec4 sum = vec4(0.0);
      for (int i = 0; i < 128; i++) {
        if (i >= count) break;
        float t = float(i) / float(count - 1);
        vec2 q = mode == 0 ? uv + dir * (t - 0.5) : center + (uv - center) * (1.0 - amount * t);
        sum += at(q);
      }
      gl_FragColor = sum / float(count);
    }`));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const newTexture = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    return t;
  };
  const u = Object.fromEntries(['mode', 'dir', 'center', 'amount', 'count'].map((n) => [n, gl.getUniformLocation(prog, n)]));
  return {
    canvas,
    // One texture per layer being blurred (all layers are the same size).
    load(src) {
      canvas.width = src.width;
      canvas.height = src.height;
      gl.viewport(0, 0, src.width, src.height);
      const t = newTexture();
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      return t;
    },
    free(t) { gl.deleteTexture(t); },
    run(t, { mode, dir = [0, 0], center = [0.5, 0.5], amount = 0, count }) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(u.mode, mode);
      gl.uniform2f(u.dir, dir[0], dir[1]);
      gl.uniform2f(u.center, center[0], center[1]);
      gl.uniform1f(u.amount, amount);
      gl.uniform1i(u.count, Math.max(2, Math.min(128, Math.round(count))));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    },
  };
})();

const gaussianOut = new OffscreenCanvas(1, 1);

// Safari's canvas has no blur filter. There the Gaussian blur is two box
// blurs across and two down on the GPU, which comes out almost the same.
const canvasFilter = !window.noCanvasFilter && 'filter' in new OffscreenCanvas(1, 1).getContext('2d');
const gaussTemp = [new OffscreenCanvas(1, 1), new OffscreenCanvas(1, 1)];
function gaussianGL(tex, W, H, sigma) {
  // The width of a box that, run twice, spreads as far as the Gaussian.
  const len = Math.sqrt(6 * sigma * sigma + 1);
  const passes = [[1, 0], [0, 1], [1, 0], [0, 1]];
  let t = tex;
  let owned = null;
  let out = null;
  passes.forEach(([dx, dy], i) => {
    out = blurGL.run(t, { mode: 0, dir: [(dx * len) / W, (dy * len) / H], count: Math.ceil(len) + 1 });
    if (i === passes.length - 1) return;
    const tmp = gaussTemp[i % 2];
    if (tmp.width !== W || tmp.height !== H) { tmp.width = W; tmp.height = H; }
    const tc = tmp.getContext('2d');
    tc.clearRect(0, 0, W, H);
    tc.drawImage(out, 0, 0);
    if (owned) blurGL.free(owned);
    owned = t = blurGL.load(tmp);
  });
  if (owned) blurGL.free(owned);
  return out;
}

function openFilter(kind) {
  if (filter || !mounted || playing) return;
  if (typeof adjust !== 'undefined' && adjust) closeAdjust(true);
  if (lift) dropSelection();
  // Every selected layer that is showing (just the active one if none is).
  let layers = selectedLayers().filter((l) => l.visible);
  if (!layers.length) layers = [activeLayer()];
  if (!layers[0]) return;
  const items = layers.map((layer) => {
    const canvas = live.get(layer.id);
    const backup = new OffscreenCanvas(canvas.width, canvas.height);
    backup.getContext('2d').drawImage(canvas, 0, 0);
    const needsTex = kind === 'motion' || kind === 'perspective' || !canvasFilter;
    return { layer, canvas, backup, tex: needsTex ? blurGL.load(backup) : null };
  });
  const spec = BLURS[kind];
  filter = {
    kind, items, raf: 0, drag: null,
    amount: spec.amount, angle: 0, size: spec.size || 40,
    cx: dims.FX + dims.W / 2, cy: dims.FY + dims.H / 2,
  };
  buildFilterPanel();
  renderFilter();
  renderFilterMark();
}

function buildFilterPanel() {
  const f = filter;
  const spec = BLURS[f.kind];
  const row = (label, key, min, max, fmt) => {
    const input = el('input', { type: 'range', min, max, step: 1, value: f[key] });
    const val = el('span', { className: 'num', textContent: fmt(f[key]) });
    input.addEventListener('input', () => { f[key] = Number(input.value); val.textContent = fmt(f[key]); requestFilter(); renderFilterMark(); });
    input.addEventListener('dblclick', () => { input.value = BLURS[f.kind][key] ?? 0; input.dispatchEvent(new Event('input')); });
    const r = el('label', { className: 'slider-row' }, el('span', { textContent: label }), input, val);
    r.dataset.key = key;
    return r;
  };
  const rows = [row('Amount', 'amount', 0, spec.max, (v) => `${v}${spec.unit}`)];
  if (f.kind === 'motion') rows.push(row('Angle', 'angle', -180, 180, (v) => `${v}°`));
  if (f.kind === 'glow') rows.push(row('Size', 'size', 2, 300, (v) => `${v}px`));
  const what = f.items.length > 1 ? `${f.items.length} layers` : f.items[0].layer.name;
  const name = state.selection ? `${what}, selection only` : what;
  filterPanel.replaceChildren(
    el('div', { className: 'adjust-head' }, el('b', { textContent: spec.title }), el('span', { className: 'muted', textContent: name })),
    ...rows,
    el('p', { className: 'hint', textContent: spec.hint }),
    (() => {
      const cancel = el('button', { className: 'text-btn', textContent: 'Cancel' });
      const apply = el('button', { className: 'text-btn primary', textContent: 'Apply' });
      cancel.addEventListener('click', () => closeFilter(false));
      apply.addEventListener('click', () => closeFilter(true));
      return el('div', { className: 'adjust-actions' }, cancel, apply);
    })(),
  );
  filterPanel.hidden = false;
}

// Keeps the panel's sliders in step when the canvas sets the values.
function syncFilterPanel() {
  for (const r of filterPanel.querySelectorAll('.slider-row')) {
    const key = r.dataset.key;
    const input = r.querySelector('input');
    input.value = Math.round(filter[key]);
    input.dispatchEvent(new Event('input'));
  }
}

function requestFilter() {
  if (filter && !filter.raf) filter.raf = requestAnimationFrame(renderFilter);
}

function renderFilter() {
  const f = filter;
  if (!f) return;
  f.raf = 0;
  for (const it of f.items) renderFilterOn(f, it);
}

// Glow: the drawing, with two blurred copies of itself added on top, a tight
// one and a wide one, so it has a bright core and a soft halo.
const glowOut = new OffscreenCanvas(1, 1);
const glowBlur = new OffscreenCanvas(1, 1);
function glowOn(it, f, W, H) {
  for (const c of [glowOut, glowBlur]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
  const g = glowOut.getContext('2d');
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.clearRect(0, 0, W, H);
  g.drawImage(it.backup, 0, 0);
  for (const [radius, share] of [[f.size / 4, 0.5], [f.size, 0.7]]) {
    let blurred;
    if (canvasFilter) {
      const b = glowBlur.getContext('2d');
      b.clearRect(0, 0, W, H);
      b.filter = `blur(${Math.max(0.5, radius / 2)}px)`;
      b.drawImage(it.backup, 0, 0);
      b.filter = 'none';
      blurred = glowBlur;
    } else {
      blurred = gaussianGL(it.tex, W, H, Math.max(0.5, radius / 2));
    }
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = Math.min(1, (f.amount / 100) * share);
    // Above 100%, laid on twice.
    g.drawImage(blurred, 0, 0);
    if ((f.amount / 100) * share > 1) { g.globalAlpha = Math.min(1, (f.amount / 100) * share - 1); g.drawImage(blurred, 0, 0); }
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  return glowOut;
}

function renderFilterOn(f, it) {
  const W = it.canvas.width;
  const H = it.canvas.height;
  let out = it.backup;
  if (f.amount > 0) {
    if (f.kind === 'glow') {
      out = glowOn(it, f, W, H);
    } else if (f.kind === 'gaussian' && !canvasFilter) {
      out = gaussianGL(it.tex, W, H, f.amount / 2);
    } else if (f.kind === 'gaussian') {
      if (gaussianOut.width !== W || gaussianOut.height !== H) { gaussianOut.width = W; gaussianOut.height = H; }
      const g = gaussianOut.getContext('2d');
      g.clearRect(0, 0, W, H);
      g.filter = `blur(${f.amount / 2}px)`;
      g.drawImage(it.backup, 0, 0);
      g.filter = 'none';
      out = gaussianOut;
    } else if (f.kind === 'motion') {
      const a = (f.angle * Math.PI) / 180;
      out = blurGL.run(it.tex, { mode: 0, dir: [(Math.cos(a) * f.amount) / W, (Math.sin(a) * f.amount) / H], count: f.amount / 2 });
    } else {
      // How far the farthest corner is from the centre, to space the samples.
      const reach = Math.max(...[[0, 0], [W, 0], [0, H], [W, H]].map(([x, y]) => Math.hypot(x - f.cx, y - f.cy)));
      const amount = (f.amount / 100) * 0.6;
      out = blurGL.run(it.tex, { mode: 1, center: [f.cx / W, f.cy / H], amount, count: (reach * amount) / 3 });
    }
  }
  const ctx = it.canvas.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, W, H);
  if (state.selection) {
    ctx.drawImage(it.backup, 0, 0);
    ctx.clip(state.selection.path);
    ctx.clearRect(0, 0, W, H);
  }
  ctx.drawImage(out, 0, 0);
  ctx.restore();
}

function closeFilter(keep) {
  const f = filter;
  if (!f) return;
  cancelAnimationFrame(f.raf);
  if (keep) { filter = f; renderFilter(); }
  filter = null;
  filterPanel.hidden = true;
  filterMark.replaceChildren();
  if (keep && f.amount > 0) {
    // One undo step, for one layer or several.
    const entries = f.items.map(({ layer, canvas, backup }) => {
      layer.dirty = true;
      return { type: 'pixels', shotId: mounted.id, layerId: layer.id, x: 0, y: 0, w: canvas.width, h: canvas.height, before: createImageBitmap(backup), after: createImageBitmap(canvas) };
    });
    pushHistory(entries.length === 1 ? entries[0] : { type: 'multi', shotId: mounted.id, entries });
    scheduleThumb();
    markDirty();
  } else {
    for (const { canvas, backup } of f.items) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(backup, 0, 0);
    }
  }
  for (const it of f.items) if (it.tex) blurGL.free(it.tex);
}

// Dragging on the canvas while a filter is open.
function filterPointerDown(e) {
  const f = filter;
  const p = toCanvas(e);
  f.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, p0: p, amount: f.amount, size: f.size };
  if (f.kind === 'perspective') { f.cx = p.x; f.cy = p.y; requestFilter(); renderFilterMark(); }
  try { viewport.setPointerCapture(e.pointerId); } catch {}
  const move = (ev) => {
    if (!f.drag || ev.pointerId !== f.drag.id || filter !== f) return;
    const q = toCanvas(ev);
    if (f.kind === 'perspective') { f.cx = q.x; f.cy = q.y; renderFilterMark(); requestFilter(); return; }
    if (f.kind === 'gaussian') f.amount = clamp(Math.round(f.drag.amount + (ev.clientX - f.drag.x) / 4), 0, BLURS.gaussian.max);
    else if (f.kind === 'glow') f.size = clamp(Math.round(f.drag.size + (ev.clientX - f.drag.x) / 2), 2, 300);
    else {
      const dx = q.x - f.drag.p0.x;
      const dy = q.y - f.drag.p0.y;
      if (Math.hypot(dx, dy) * state.view.z < 4) return;
      f.amount = clamp(Math.round(Math.hypot(dx, dy)), 0, BLURS.motion.max);
      f.angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
    }
    syncFilterPanel();
    renderFilterMark();
  };
  const up = (ev) => {
    if (!f.drag || ev.pointerId !== f.drag.id) return;
    f.drag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    renderFilterMark();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// The perspective centre, and the motion streak while dragging it.
function renderFilterMark() {
  const f = filter;
  if (!f) { filterMark.replaceChildren(); return; }
  const vr = viewportRect;
  let svg = '';
  if (f.kind === 'perspective') {
    const c = toScreen({ x: f.cx, y: f.cy });
    svg = `<circle class="filter-centre" cx="${c.x}" cy="${c.y}" r="14"/><circle class="filter-dot" cx="${c.x}" cy="${c.y}" r="3"/>`;
  } else if (f.kind === 'motion' && f.drag) {
    const a = toScreen(f.drag.p0);
    const r = (f.angle * Math.PI) / 180;
    const b = toScreen({ x: f.drag.p0.x + Math.cos(r) * f.amount, y: f.drag.p0.y + Math.sin(r) * f.amount });
    svg = `<line class="filter-streak" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
  }
  filterMark.innerHTML = svg ? `<svg width="${vr.width}" height="${vr.height}">${svg}</svg>` : '';
}

for (const b of document.querySelectorAll('[data-blur]')) b.addEventListener('click', () => openFilter(b.dataset.blur));
