'use strict';
// The Move tool's box: drag inside it (or anywhere) to move, drag one of its
// eight handles to stretch. Like Photoshop:
//   Shift  keeps the proportions while stretching, and locks a move to
//          horizontal or vertical
//   Alt    stretches from the centre
//   Ctrl   places freely; otherwise edges and centres snap to the frame's
//          edges and centre line, with a guide shown while they do
// Each drag is put down when the pen lifts (one undo step); a lasso selection
// stays picked up until it is deselected, so it can be stretched again without
// losing quality.

const moveBoxEl = $('#moveLayer');
const HANDLE_HIT = 10; // screen pixels
const SNAP_PX = 8; // screen pixels

// The drawn area of a layer (the active one by default), measured once per change.
const boundsCache = new Map();
let boundsStamp = -1;
function contentBounds(layer = activeLayer()) {
  if (!layer || !mounted) return null;
  if (boundsStamp !== historyStamp) { boundsCache.clear(); boundsStamp = historyStamp; }
  const key = `${mounted.id}:${layer.id}`;
  if (boundsCache.has(key)) return boundsCache.get(key);
  const c = live.get(layer.id);
  const px = new Uint32Array(c.getContext('2d').getImageData(0, 0, c.width, c.height).data.buffer);
  const W = c.width;
  const H = c.height;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    let first = -1;
    for (let x = 0; x < W; x++) if (px[row + x] >>> 24) { first = x; break; }
    if (first < 0) continue;
    let last = first;
    for (let x = W - 1; x > first; x--) if (px[row + x] >>> 24) { last = x; break; }
    if (y < y0) y0 = y;
    y1 = y;
    if (first < x0) x0 = first;
    if (last > x1) x1 = last;
  }
  const rect = x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  boundsCache.set(key, rect);
  return rect;
}

// Everything drawn on the selected layers, as one box.
function groupBounds(layers) {
  let box = null;
  for (const l of layers) {
    const r = contentBounds(l);
    if (!r) continue;
    if (!box) { box = { ...r }; continue; }
    const x1 = Math.max(box.x + box.w, r.x + r.w);
    const y1 = Math.max(box.y + box.h, r.y + r.h);
    box.x = Math.min(box.x, r.x);
    box.y = Math.min(box.y, r.y);
    box.w = x1 - box.x;
    box.h = y1 - box.y;
  }
  return box;
}
const movingMany = () => !state.selection && selectedLayers().length > 1;

// Several layers move together without being picked up: their canvases are
// shown moved while dragging, and redrawn in place when the pen lifts.
function liftGroup() {
  const layers = selectedLayers();
  const box = groupBounds(layers);
  if (!box) return null;
  return { group: true, box, items: layers.map((layer) => ({ layer, canvas: live.get(layer.id) })), dx: 0, dy: 0, sx: 1, sy: 1, rot: 0 };
}
function dropGroup() {
  const l = lift;
  if (!l || !l.group) return;
  // A bend still live (Distort or Warp) is applied as it stands.
  if (l.mode && l.mode !== 'free') { commitMeshGroup(l); return; }
  lift = null;
  const { box } = l;
  if (l.sx === 1 && l.sy === 1 && !l.rot) { l.dx = Math.round(l.dx); l.dy = Math.round(l.dy); }
  const entries = [];
  for (const { layer, canvas } of l.items) {
    canvas.style.transform = '';
    if (!l.dx && !l.dy && l.sx === 1 && l.sy === 1 && !l.rot) continue;
    const copy = new OffscreenCanvas(canvas.width, canvas.height);
    copy.getContext('2d').drawImage(canvas, 0, 0);
    const ctx = canvas.getContext('2d');
    ctx.save();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(box.x + l.dx, box.y + l.dy);
    ctx.rotate(l.rot || 0);
    ctx.scale(l.sx, l.sy);
    ctx.translate(-box.x, -box.y);
    ctx.drawImage(copy, 0, 0);
    ctx.restore();
    layer.dirty = true;
    entries.push({ type: 'pixels', shotId: mounted.id, layerId: layer.id, x: 0, y: 0, w: canvas.width, h: canvas.height, before: createImageBitmap(copy), after: createImageBitmap(canvas) });
  }
  if (entries.length) {
    pushHistory({ type: 'multi', shotId: mounted.id, entries });
    scheduleThumb();
    markDirty();
  }
  renderMoveBox();
}

// The box as two opposite corners (x1 < x0 when flipped).
function liftMapper(t, b = t.box || state.selection.box) {
  const c = Math.cos(t.rot || 0);
  const s = Math.sin(t.rot || 0);
  return (p) => {
    const ux = (p.x - b.x) * t.sx;
    const uy = (p.y - b.y) * t.sy;
    return { x: b.x + t.dx + c * ux - s * uy, y: b.y + t.dy + s * ux + c * uy };
  };
}
// The box's corners (top-left, top-right, bottom-right, bottom-left), turned
// with the piece.
function liftCorners(l) {
  const b = l.box || state.selection.box;
  const m = liftMapper(l, b);
  return [m({ x: b.x, y: b.y }), m({ x: b.x + b.w, y: b.y }), m({ x: b.x + b.w, y: b.y + b.h }), m({ x: b.x, y: b.y + b.h })];
}
function shownCorners() {
  if (lift && (lift.group || state.selection) && (!lift.mode || lift.mode === 'free')) return liftCorners(lift);
  const r = shownRect();
  return r ? [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }] : null;
}
// A point on the box: (u, v) from 0 to 1 across and down.
function boxPoint(k, u, v) {
  const top = { x: k[0].x + (k[1].x - k[0].x) * u, y: k[0].y + (k[1].y - k[0].y) * u };
  const bot = { x: k[3].x + (k[2].x - k[3].x) * u, y: k[3].y + (k[2].y - k[3].y) * u };
  return { x: top.x + (bot.x - top.x) * v, y: top.y + (bot.y - top.y) * v };
}
// The turning handle: on a short stalk above the top edge.
function rotateHandle(k) {
  const top = boxPoint(k, 0.5, 0);
  const mid = boxPoint(k, 0.5, 0.5);
  const len = Math.hypot(top.x - mid.x, top.y - mid.y) || 1;
  const reach = 28 / state.view.z;
  return { x: top.x + ((top.x - mid.x) / len) * reach, y: top.y + ((top.y - mid.y) / len) * reach };
}

function liftRect(l) {
  const b = l.box || state.selection.box;
  return { x0: b.x + l.dx, y0: b.y + l.dy, x1: b.x + l.dx + b.w * l.sx, y1: b.y + l.dy + b.h * l.sy };
}
function shownRect() {
  if (lift && (lift.group || state.selection)) return liftRect(lift);
  const b = state.selection ? state.selection.box : movingMany() ? groupBounds(selectedLayers()) : contentBounds();
  return b ? { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h } : null;
}

const HANDLES = [-1, 0, 1].flatMap((hy) => [-1, 0, 1].map((hx) => ({ hx, hy }))).filter((h) => h.hx || h.hy);
function handleAt(e) {
  const k = shownCorners();
  if (!k) return null;
  const vr = viewportRect;
  const dist = (q) => { const s = toScreen(q); return Math.hypot(e.clientX - vr.left - s.x, e.clientY - vr.top - s.y); };
  if (dist(rotateHandle(k)) <= HANDLE_HIT) return { rotate: true };
  for (const h of HANDLES) if (dist(boxPoint(k, (h.hx + 1) / 2, (h.hy + 1) / 2)) <= HANDLE_HIT) return h;
  // Just outside a corner also turns it, like Photoshop.
  for (const q of k) {
    const d = dist(q);
    if (d > HANDLE_HIT && d <= HANDLE_HIT + 16 && !insideCorners(k, toCanvas(e))) return { rotate: true };
  }
  return null;
}
function insideCorners(k, p) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = k[i];
    const b = k[(i + 1) % 4];
    const c = Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
    if (c && sign && c !== sign) return false;
    if (c) sign = c;
  }
  return true;
}

const frameLinesX = () => [dims.FX, dims.FX + dims.W / 2, dims.FX + dims.W];
const frameLinesY = () => [dims.FY, dims.FY + dims.H / 2, dims.FY + dims.H];
// The nearest frame line to any of `values`, if one is within reach.
function snapTo(values, lines, reach) {
  let best = null;
  for (const v of values) for (const t of lines) {
    const d = t - v;
    if (Math.abs(d) <= reach && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, t };
  }
  return best;
}

let moveGuides = [];

function beginTransform(e, p) {
  if (state.moveMode !== 'free') { beginMeshDrag(e, p); return; }
  const handle = handleAt(e);
  if (!lift) lift = state.selection ? liftSelection() : movingMany() ? liftGroup() : liftWholeLayer();
  if (!lift) return;
  lift.drag = { id: e.pointerId, p0: p, start: liftRect(lift), corners: liftCorners(lift), t0: { dx: lift.dx, dy: lift.dy, sx: lift.sx, sy: lift.sy, rot: lift.rot || 0 }, handle };
}

// Turning: around the box's centre; Shift snaps to 15 degrees.
function rotateTransform(e, g, b) {
  const p = toCanvas(e);
  const t0 = g.t0;
  const centre = boxPoint(g.corners, 0.5, 0.5);
  let rot = t0.rot + Math.atan2(p.y - centre.y, p.x - centre.x) - Math.atan2(g.p0.y - centre.y, g.p0.x - centre.x);
  if (e.shiftKey) rot = Math.round(rot / (Math.PI / 12)) * (Math.PI / 12);
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const ux = (t0.sx * b.w) / 2;
  const uy = (t0.sy * b.h) / 2;
  lift.rot = rot;
  lift.dx = centre.x - (c * ux - s * uy) - b.x;
  lift.dy = centre.y - (s * ux + c * uy) - b.y;
}

// Stretching a turned box: along its own sides, the opposite handle (or the
// centre, with Alt) staying put. Shift keeps the shape.
function stretchTurned(e, g, b) {
  const p = toCanvas(e);
  const t0 = g.t0;
  const { hx, hy } = g.handle;
  const H = { x: hx < 0 ? 0 : hx > 0 ? b.w : b.w / 2, y: hy < 0 ? 0 : hy > 0 ? b.h : b.h / 2 };
  const A = e.altKey ? { x: b.w / 2, y: b.h / 2 } : { x: hx < 0 ? b.w : hx > 0 ? 0 : b.w / 2, y: hy < 0 ? b.h : hy > 0 ? 0 : b.h / 2 };
  const WA = liftMapper(t0, b)({ x: b.x + A.x, y: b.y + A.y });
  const c = Math.cos(t0.rot);
  const s = Math.sin(t0.rot);
  const vx = p.x - WA.x;
  const vy = p.y - WA.y;
  const lx = c * vx + s * vy;
  const ly = -s * vx + c * vy;
  let sx = hx ? lx / (H.x - A.x) : t0.sx;
  let sy = hy ? ly / (H.y - A.y) : t0.sy;
  if (e.shiftKey) {
    const fx = hx ? sx / t0.sx : null;
    const fy = hy ? sy / t0.sy : null;
    const f = Math.abs(fx === null ? fy : fy === null ? fx : Math.abs(fx) > Math.abs(fy) ? fx : fy);
    sx = (fx === null ? 1 : Math.sign(fx) || 1) * f * t0.sx;
    sy = (fy === null ? 1 : Math.sign(fy) || 1) * f * t0.sy;
  }
  if (Math.abs(sx * b.w) < 1) sx = (Math.sign(sx) || 1) / b.w;
  if (Math.abs(sy * b.h) < 1) sy = (Math.sign(sy) || 1) / b.h;
  lift.sx = sx;
  lift.sy = sy;
  lift.dx = WA.x - (c * sx * A.x - s * sy * A.y) - b.x;
  lift.dy = WA.y - (s * sx * A.x + c * sy * A.y) - b.y;
}

function updateTransform(e) {
  if (lift.drag.mesh) { updateMeshDrag(e); return; }
  const g = lift.drag;
  const p = toCanvas(e);
  let mx = p.x - g.p0.x;
  let my = p.y - g.p0.y;
  const reach = SNAP_PX / state.view.z;
  const snap = !e.ctrlKey;
  const s = g.start;
  const b = lift.box || state.selection.box;
  moveGuides = [];
  if (g.handle && g.handle.rotate) {
    rotateTransform(e, g, b);
  } else if (g.handle && g.t0.rot) {
    stretchTurned(e, g, b);
  } else if (!g.handle) {
    if (e.shiftKey) { if (Math.abs(mx) >= Math.abs(my)) my = 0; else mx = 0; }
    if (snap) {
      // The outer box of the (possibly turned) piece snaps to the frame.
      const bx = g.corners.map((q) => q.x);
      const by = g.corners.map((q) => q.y);
      const [lx, hx2, ly, hy2] = [Math.min(...bx), Math.max(...bx), Math.min(...by), Math.max(...by)];
      const xs = [lx, hx2, (lx + hx2) / 2].map((v) => v + mx);
      const ys = [ly, hy2, (ly + hy2) / 2].map((v) => v + my);
      const sx = !(e.shiftKey && mx === 0) && snapTo(xs, frameLinesX(), reach);
      const sy = !(e.shiftKey && my === 0) && snapTo(ys, frameLinesY(), reach);
      if (sx) { mx += sx.d; moveGuides.push({ x: sx.t }); }
      if (sy) { my += sy.d; moveGuides.push({ y: sy.t }); }
    }
    lift.dx = g.t0.dx + mx;
    lift.dy = g.t0.dy + my;
  } else {
    const { hx, hy } = g.handle;
    const cx = (s.x0 + s.x1) / 2;
    const cy = (s.y0 + s.y1) / 2;
    let { x0, x1, y0, y1 } = s;
    if (hx > 0) x1 += mx;
    if (hx < 0) x0 += mx;
    if (hy > 0) y1 += my;
    if (hy < 0) y0 += my;
    if (snap) {
      const edgeX = hx > 0 ? 'x1' : hx < 0 ? 'x0' : null;
      const edgeY = hy > 0 ? 'y1' : hy < 0 ? 'y0' : null;
      const ex = edgeX && snapTo([edgeX === 'x1' ? x1 : x0], frameLinesX(), reach);
      const ey = edgeY && snapTo([edgeY === 'y1' ? y1 : y0], frameLinesY(), reach);
      if (ex) { if (edgeX === 'x1') x1 += ex.d; else x0 += ex.d; moveGuides.push({ x: ex.t }); }
      if (ey) { if (edgeY === 'y1') y1 += ey.d; else y0 += ey.d; moveGuides.push({ y: ey.t }); }
    }
    if (e.altKey) {
      if (hx > 0) x0 = 2 * cx - x1;
      if (hx < 0) x1 = 2 * cx - x0;
      if (hy > 0) y0 = 2 * cy - y1;
      if (hy < 0) y1 = 2 * cy - y0;
    }
    if (e.shiftKey) {
      // Same proportions: both sides grow by the bigger of the two changes.
      const w0 = s.x1 - s.x0;
      const h0 = s.y1 - s.y0;
      const fx = hx ? (x1 - x0) / w0 : null;
      const fy = hy ? (y1 - y0) / h0 : null;
      const f = Math.abs(fx === null ? fy : fy === null ? fx : Math.abs(fx) > Math.abs(fy) ? fx : fy);
      const kx = (fx === null ? 1 : Math.sign(fx) || 1) * f;
      const ky = (fy === null ? 1 : Math.sign(fy) || 1) * f;
      if (e.altKey || !hx) { x0 = cx - (w0 * kx) / 2; x1 = cx + (w0 * kx) / 2; } else if (hx > 0) x1 = x0 + w0 * kx; else x0 = x1 - w0 * kx;
      if (e.altKey || !hy) { y0 = cy - (h0 * ky) / 2; y1 = cy + (h0 * ky) / 2; } else if (hy > 0) y1 = y0 + h0 * ky; else y0 = y1 - h0 * ky;
    }
    if (Math.abs(x1 - x0) < 1) x1 = x0 + (x1 >= x0 ? 1 : -1);
    if (Math.abs(y1 - y0) < 1) y1 = y0 + (y1 >= y0 ? 1 : -1);
    lift.dx = x0 - b.x;
    lift.dy = y0 - b.y;
    lift.sx = (x1 - x0) / b.w;
    lift.sy = (y1 - y0) / b.h;
  }
  applyLiftStyle(lift);
  if (!lift.whole && !lift.group) drawSelectionOutline(liftedPoints(lift));
  renderMoveBox();
}

// The box, its handles and any snap guides, drawn over the canvas.
function renderMoveBox() {
  const bar = document.getElementById('meshBar');
  if (bar) {
    bar.hidden = !meshLive();
    if (meshLive()) bar.querySelector('.mesh-title').textContent = lift.mode === 'distort' ? 'Distort: drag the corners or the edges' : 'Warp: drag the points to bend';
  }
  if (state.tool !== 'move' || !mounted || playing || scrub || stroke) { moveBoxEl.replaceChildren(); return; }
  const vr = viewportRect;
  if (state.moveMode !== 'free') {
    const svg = meshOverlay();
    moveBoxEl.innerHTML = svg ? `<svg width="${vr.width}" height="${vr.height}">${svg}</svg>` : '';
    return;
  }
  const k = shownCorners();
  if (!k) { moveBoxEl.replaceChildren(); return; }
  const S = (p) => toScreen(p);
  const corners = k.map(S);
  const top = S(boxPoint(k, 0.5, 0));
  const knob = S(rotateHandle(k));
  const turn = `<line class="move-box" x1="${top.x}" y1="${top.y}" x2="${knob.x}" y2="${knob.y}"/><circle class="rotate-handle" cx="${knob.x}" cy="${knob.y}" r="5.5"/>`;
  const box = `<polygon class="move-box" points="${corners.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')}"/>`;
  const handles = turn + HANDLES.map((h) => {
    const q = S(boxPoint(k, (h.hx + 1) / 2, (h.hy + 1) / 2));
    return `<rect class="move-handle" x="${(q.x - 5).toFixed(1)}" y="${(q.y - 5).toFixed(1)}" width="10" height="10"/>`;
  }).join('');
  const far = dims.CW + dims.CH;
  const guides = (lift && lift.drag ? moveGuides : []).map((g) => {
    const a = S(g.x !== undefined ? { x: g.x, y: -far } : { x: -far, y: g.y });
    const c = S(g.x !== undefined ? { x: g.x, y: far } : { x: far, y: g.y });
    return `<line class="move-guide" x1="${a.x}" y1="${a.y}" x2="${c.x}" y2="${c.y}"/>`;
  }).join('');
  moveBoxEl.innerHTML = `<svg width="${vr.width}" height="${vr.height}">${guides}${box}${handles}</svg>`;
}

// The resize cursor that matches a handle, as the view is turned.
function handleCursor(h) {
  if (h.rotate) return 'grab';
  const angle = ((Math.atan2(h.hy, h.hx) * 180) / Math.PI + (state.view.r * 180) / Math.PI + 360) % 180;
  return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(angle / 45) % 4];
}

// ---------------------------------------------------------------- distort and warp
//
// Two more Move modes, like Photoshop's and Procreate's:
//   Distort  each corner moves on its own (perspective)
//   Warp     a 4 x 4 grid of points bends the picture smoothly
// They stay live across several drags, so the picture is only resampled once:
// Enter (or Apply) keeps the result, Escape (or Cancel) puts it back. The
// picture is drawn on the graphics chip as a fine mesh that follows the points.
// They work on one layer, a lasso selection, or several selected layers (each
// layer is bent on its own and shown in its own place in the stack).

state.moveMode = 'free';
const MESH = 40; // squares per side of the drawing mesh

const meshCanvas = document.createElement('canvas');
meshCanvas.id = 'meshCanvas';
stage.append(meshCanvas);

const meshGL = (() => {
  const gl = meshCanvas.getContext('webgl', { premultipliedAlpha: true, preserveDrawingBuffer: true, alpha: true });
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, 'attribute vec2 pos; attribute vec2 uv; uniform vec2 size; varying vec2 vuv; void main() { vuv = uv; gl_Position = vec4(pos.x / size.x * 2.0 - 1.0, 1.0 - pos.y / size.y * 2.0, 0.0, 1.0); }'));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, 'precision highp float; varying vec2 vuv; uniform sampler2D tex; void main() { gl_FragColor = texture2D(tex, vuv); }'));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const n = MESH + 1;
  const uvs = new Float32Array(n * n * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { uvs[(j * n + i) * 2] = i / MESH; uvs[(j * n + i) * 2 + 1] = j / MESH; }
  const index = new Uint16Array(MESH * MESH * 6);
  let k = 0;
  for (let j = 0; j < MESH; j++) for (let i = 0; i < MESH; i++) {
    const a = j * n + i;
    index.set([a, a + 1, a + n, a + 1, a + n + 1, a + n], k);
    k += 6;
  }
  const uvBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
  gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);
  const uvLoc = gl.getAttribLocation(prog, 'uv');
  gl.enableVertexAttribArray(uvLoc);
  gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 0, 0);
  const posBuf = gl.createBuffer();
  const posLoc = gl.getAttribLocation(prog, 'pos');
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  const idxBuf = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idxBuf);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
  const newTexture = () => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [p, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, p, v);
    return t;
  };
  const tex = newTexture();
  const sizeLoc = gl.getUniformLocation(prog, 'size');
  const pos = new Float32Array(n * n * 2);
  return {
    load(src, t = tex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    },
    // A texture of its own, for each of several layers bent together.
    texture(src) {
      const t = newTexture();
      this.load(src, t);
      return t;
    },
    free(t) { if (t !== tex) gl.deleteTexture(t); },
    draw(map, t = tex) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      if (meshCanvas.width !== dims.CW || meshCanvas.height !== dims.CH) { meshCanvas.width = dims.CW; meshCanvas.height = dims.CH; }
      gl.viewport(0, 0, dims.CW, dims.CH);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const q = map(i / MESH, j / MESH);
        pos[(j * n + i) * 2] = q.x;
        pos[(j * n + i) * 2 + 1] = q.y;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
      gl.uniform2f(sizeLoc, dims.CW, dims.CH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawElements(gl.TRIANGLES, index.length, gl.UNSIGNED_SHORT, 0);
    },
  };
})();

// The unit square onto any four corners (top-left, top-right, bottom-right,
// bottom-left), with true perspective.
function quadMap([p0, p1, p2, p3]) {
  const sx = p0.x - p1.x + p2.x - p3.x;
  const sy = p0.y - p1.y + p2.y - p3.y;
  let g = 0;
  let h = 0;
  if (Math.abs(sx) > 1e-9 || Math.abs(sy) > 1e-9) {
    const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dy1 = p1.y - p2.y, dy2 = p3.y - p2.y;
    const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
    g = (sx * dy2 - dx2 * sy) / den;
    h = (dx1 * sy - sx * dy1) / den;
  }
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
  };
}
// A smooth (bicubic) surface pulled by 16 points; evenly spaced points leave
// the picture as it was.
const bern = (t) => { const s = 1 - t; return [s * s * s, 3 * t * s * s, 3 * t * t * s, t * t * t]; };
function warpMap(P) {
  return (u, v) => {
    const bu = bern(u);
    const bv = bern(v);
    let x = 0;
    let y = 0;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const w = bu[i] * bv[j];
      x += w * P[j * 4 + i].x;
      y += w * P[j * 4 + i].y;
    }
    return { x, y };
  };
}
const meshMap = (l) => (l.mode === 'distort' ? quadMap(l.pts) : warpMap(l.pts));
const meshLive = () => !!(lift && lift.mode && lift.mode !== 'free');

function startPoints(mode, k) {
  if (mode === 'distort') return k.map((q) => ({ ...q }));
  const pts = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) pts.push(boxPoint(k, i / 3, j / 3));
  return pts;
}

// Turns a picked-up piece into a live Distort or Warp, starting from where it is now.
function startMesh(l, mode) {
  l.mode = mode;
  l.pts = startPoints(mode, liftCorners(l));
  if (l.group) { startMeshGroup(l); return; }
  meshGL.load(floatCanvas);
  floatCanvas.style.display = 'none';
  meshCanvas.style.display = 'block';
  meshCanvas.style.opacity = l.layer.opacity;
  if (!l.whole) drawSelectionOutline([]);
  renderMesh(l);
}
function renderMesh(l = lift) {
  if (!l || !l.mode || l.mode === 'free') return;
  if (l.group) { renderMeshGroup(l); return; }
  meshGL.draw(meshMap(l));
}

// ---- several layers at once
//
// Each selected layer's drawing is cut out to a texture of its own; while
// bending, the layer is hidden and a preview canvas in its place in the stack
// shows it bent (sized to the bent area only: redrawing canvases the size of
// the page every frame is what made drawing lag before).
const meshPreviews = new Map(); // layer id -> preview canvas

function startMeshGroup(l) {
  const { box } = l;
  for (const it of l.items) {
    it.canvas.style.transform = '';
    const crop = new OffscreenCanvas(Math.max(1, box.w), Math.max(1, box.h));
    crop.getContext('2d').drawImage(it.canvas, -box.x, -box.y);
    it.tex = meshGL.texture(crop);
    const pv = document.createElement('canvas');
    pv.className = 'mesh-preview';
    pv.style.opacity = it.layer.opacity;
    it.preview = pv;
    meshPreviews.set(it.layer.id, pv);
    it.canvas.style.visibility = 'hidden';
  }
  layoutStack();
  renderMeshGroup(l);
}

// The area the bent picture covers, from the drawing mesh's own points.
function meshBounds(map) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let j = 0; j <= MESH; j += 4) for (let i = 0; i <= MESH; i += 4) {
    const q = map(i / MESH, j / MESH);
    x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
  }
  for (let k = 0; k <= MESH; k++) {
    for (const q of [map(k / MESH, 0), map(k / MESH, 1), map(0, k / MESH), map(1, k / MESH)]) {
      x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
    }
  }
  const x = clamp(Math.floor(x0) - 2, 0, dims.CW);
  const y = clamp(Math.floor(y0) - 2, 0, dims.CH);
  return { x, y, w: clamp(Math.ceil(x1) + 2, 0, dims.CW) - x, h: clamp(Math.ceil(y1) + 2, 0, dims.CH) - y };
}

function renderMeshGroup(l) {
  const map = meshMap(l);
  const r = meshBounds(map);
  if (r.w <= 0 || r.h <= 0) return;
  for (const it of l.items) {
    meshGL.draw(map, it.tex);
    const pv = it.preview;
    // Grows, never shrinks, so it is not reallocated on every move.
    if (pv.width < r.w || pv.height < r.h) {
      pv.width = Math.max(pv.width, Math.ceil(r.w * 1.25));
      pv.height = Math.max(pv.height, Math.ceil(r.h * 1.25));
    }
    const ctx = pv.getContext('2d');
    ctx.clearRect(0, 0, pv.width, pv.height);
    ctx.drawImage(meshCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
    pv.style.transform = `translate(${r.x}px, ${r.y}px)`;
  }
}

// Puts the previews away and shows the layers again.
function endMeshGroup(l) {
  for (const it of l.items) {
    it.canvas.style.visibility = '';
    meshPreviews.delete(it.layer.id);
    meshGL.free(it.tex);
  }
  layoutStack();
}

// Bends each layer for real: one undo step for all of them.
function commitMeshGroup(l) {
  lift = null;
  const map = meshMap(l);
  const r = meshBounds(map);
  const entries = [];
  for (const it of l.items) {
    const before = createImageBitmap(it.canvas);
    meshGL.draw(map, it.tex);
    const ctx = it.canvas.getContext('2d');
    ctx.clearRect(0, 0, it.canvas.width, it.canvas.height);
    if (r.w > 0 && r.h > 0) ctx.drawImage(meshCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    it.layer.dirty = true;
    entries.push({ type: 'pixels', shotId: mounted.id, layerId: it.layer.id, x: 0, y: 0, w: it.canvas.width, h: it.canvas.height, before, after: createImageBitmap(it.canvas) });
  }
  endMeshGroup(l);
  pushHistory({ type: 'multi', shotId: mounted.id, entries });
  scheduleThumb();
  markDirty();
  renderMoveBox();
}
// Draws the finished mesh onto the layer (called from dropSelection).
function commitMesh(l, ctx) {
  renderMesh(l);
  ctx.drawImage(meshCanvas, 0, 0);
  meshCanvas.style.display = 'none';
}
function applyMesh() {
  if (!meshLive()) return;
  if (lift.group) commitMeshGroup(lift);
  else if (lift.whole) dropWholeLayer(); else dropSelection();
  renderMoveBox();
}
// Puts the layer back as it was before it was picked up.
async function cancelLift() {
  const l = lift;
  if (!l) return;
  if (l.group) {
    // Only a bend is left live on several layers; their pixels were never touched.
    if (l.mode && l.mode !== 'free') { lift = null; endMeshGroup(l); renderMoveBox(); }
    return;
  }
  lift = null;
  const bm = await l.backup;
  const ctx = l.canvas.getContext('2d');
  ctx.clearRect(0, 0, l.canvas.width, l.canvas.height);
  ctx.drawImage(bm, 0, 0);
  floatCanvas.style.display = 'none';
  meshCanvas.style.display = 'none';
  if (l.whole) { wholeMove = false; setSelection(null); } else drawSelectionOutline(state.selection);
  renderMoveBox();
}

function setMoveMode(mode) {
  if (mode === state.moveMode) return;
  if (meshLive()) applyMesh();
  state.moveMode = mode;
  if (mode !== 'free' && lift && (!lift.group || !lift.drag)) startMesh(lift, mode);
  refreshUI();
}

// The points to show and grab: the live ones, or where they would start.
function meshPoints() {
  if (meshLive()) return lift.pts;
  const k = shownCorners();
  return k ? startPoints(state.moveMode, k) : null;
}
// What can be grabbed: each point on its own; with Distort also the middle of
// each edge, which moves that edge's two corners together, as in Photoshop.
const DISTORT_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0]];
function meshHandles(pts) {
  const own = pts.map((q, i) => ({ q, moves: [i] }));
  if (state.moveMode !== 'distort') return own;
  const f = quadMap(pts);
  const mids = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]].map(([u, v], k) => ({ q: f(u, v), moves: DISTORT_EDGES[k], mid: true }));
  return own.concat(mids);
}
function meshPointAt(e, handles) {
  const vr = viewportRect;
  let best = -1;
  let bestD = HANDLE_HIT + 2;
  handles.forEach(({ q }, i) => {
    const s = toScreen(q);
    const d = Math.hypot(e.clientX - vr.left - s.x, e.clientY - vr.top - s.y);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}
function beginMeshDrag(e, p) {
  const pts0 = meshPoints();
  const handles = pts0 ? meshHandles(pts0) : [];
  const idx = handles.length ? meshPointAt(e, handles) : -1;
  if (!lift) lift = state.selection ? liftSelection() : movingMany() ? liftGroup() : liftWholeLayer();
  if (!lift) return;
  if (!meshLive()) startMesh(lift, state.moveMode);
  // Grabbing nothing in particular moves the whole thing.
  lift.drag = { id: e.pointerId, p0: p, mesh: true, moves: idx >= 0 ? handles[idx].moves : null, start: lift.pts.map((q) => ({ ...q })) };
}
function updateMeshDrag(e) {
  const g = lift.drag;
  const p = toCanvas(e);
  const dx = p.x - g.p0.x;
  const dy = p.y - g.p0.y;
  lift.pts = g.start.map((q, i) => (!g.moves || g.moves.includes(i) ? { x: q.x + dx, y: q.y + dy } : { ...q }));
  renderMesh();
  renderMoveBox();
}

// The Distort corners or the Warp grid, drawn over the canvas.
function meshOverlay() {
  const pts = meshPoints();
  if (!pts) return '';
  const S = (q) => toScreen(q);
  const fmt = (q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`;
  let lines = '';
  if (state.moveMode === 'distort') {
    lines = `<polygon class="move-box" points="${pts.map((q) => fmt(S(q))).join(' ')}"/>`;
  } else {
    const f = warpMap(pts);
    const curve = (fn) => `<polyline class="move-box" points="${Array.from({ length: 25 }, (_, k) => fmt(S(fn(k / 24)))).join(' ')}"/>`;
    for (let k = 0; k <= 3; k++) lines += curve((t) => f(k / 3, t)) + curve((t) => f(t, k / 3));
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      if (i < 3) lines += `<line class="warp-net" x1="${S(pts[j * 4 + i]).x}" y1="${S(pts[j * 4 + i]).y}" x2="${S(pts[j * 4 + i + 1]).x}" y2="${S(pts[j * 4 + i + 1]).y}"/>`;
      if (j < 3) lines += `<line class="warp-net" x1="${S(pts[j * 4 + i]).x}" y1="${S(pts[j * 4 + i]).y}" x2="${S(pts[j * 4 + i + 4]).x}" y2="${S(pts[j * 4 + i + 4]).y}"/>`;
    }
  }
  const handles = meshHandles(pts).map(({ q, mid }) => { const s = S(q); return `<circle class="mesh-handle${mid ? ' mid' : ''}" cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${mid ? 4.5 : 5.5}"/>`; }).join('');
  return lines + handles;
}
