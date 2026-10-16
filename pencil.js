'use strict';
// ---------------------------------------------------------------- pencil engine
//
// Textured pencils that work the way Photoshop's do, on the GPU. Two things
// give a Photoshop pencil its thick and thin, light and dark line:
//
//  - Very tight spacing (the Animator pencil stamps every 1% of its size), so
//    a line is hundreds of overlapping stamps that build up within the stroke.
//  - The paper texture in "Height" mode, applied to every stamp: each stamp
//    only marks the paper where its strength (tip times flow, and flow follows
//    pressure) is higher than the paper is deep there. A light touch only
//    catches the paper's high points, so it leaves a pale, grainy line. Press
//    harder and it fills in solid and dark, and the soft edge of the tip
//    starts to mark too, so the line gets wider.
//
// Stamped on the canvas's own 2D context that was far too slow at that
// spacing, and its blending cannot cut each stamp by the paper. So the stamps
// build up in a GPU buffer, shown in the brush colour by a small canvas that
// follows the pen (see pencilRender).
// The paper is generated noise, not Adobe's pattern.

const pencilCanvas = document.createElement('canvas');
pencilCanvas.className = 'live pencil';
strokeGroup.append(pencilCanvas);

const PAPER_SIZE = 512;

// Tileable paper: bumps of a few sizes, like cold-press paper, values 0 to 1.
function paperHeights() {
  const N = PAPER_SIZE;
  const acc = new Float32Array(N * N);
  const octave = (cell, amp) => {
    const n = N / cell;
    const g = new Float32Array(n * n).map(() => Math.random());
    const at = (i, j) => g[((j + n) % n) * n + ((i + n) % n)];
    const ease = (t) => t * t * (3 - 2 * t);
    for (let y = 0; y < N; y++) {
      const gy = y / cell;
      const j = Math.floor(gy);
      const fy = ease(gy - j);
      for (let x = 0; x < N; x++) {
        const gx = x / cell;
        const i = Math.floor(gx);
        const fx = ease(gx - i);
        const top = at(i, j) * (1 - fx) + at(i + 1, j) * fx;
        const bottom = at(i, j + 1) * (1 - fx) + at(i + 1, j + 1) * fx;
        acc[y * N + x] += amp * (top * (1 - fy) + bottom * fy);
      }
    }
  };
  for (const [cell, amp] of [[8, 0.12], [4, 0.25], [2, 0.4], [1, 0.4]]) octave(cell, amp);
  // Evened out so every height is as common as any other: how much of the
  // paper a stamp reaches then rises steadily with pressure.
  const order = Array.from(acc.keys()).sort((p, q) => acc[p] - acc[q]);
  const out = new Uint8Array(N * N);
  order.forEach((k, rank) => { out[k] = Math.floor((rank / order.length) * 256); });
  return out;
}

// Made the first time a GPU pencil is used, so startup stays quick. If the
// graphics driver resets, the pencils draw with the 2D stamp engine until it
// is back.
let pencilEngine;
pencilCanvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); pencilEngine = null; });
pencilCanvas.addEventListener('webglcontextrestored', () => { pencilEngine = undefined; });
function pencilGL() {
  if (pencilEngine === undefined) {
    try { pencilEngine = makePencilGL(); } catch (err) { console.error(err); pencilEngine = null; }
  }
  return pencilEngine;
}

function makePencilGL() {
  const gl = pencilCanvas.getContext('webgl2', { premultipliedAlpha: true, preserveDrawingBuffer: false, antialias: false, depth: false, stencil: false });
  if (!gl) return null;
  gl.getExtension('EXT_color_buffer_float');
  const program = (vs, fs) => {
    const p = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      gl.attachShader(p, s);
    }
    gl.bindAttribLocation(p, 0, 'corner');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  };
  // One stamp per instance: its centre, strength, and the tip's two axes on
  // the canvas (size, angle, stretch and roundness all in those). `origin`
  // and `res` place the drawing: the whole canvas, or the window by the pen.
  const dabProg = program(`#version 300 es
    in vec2 corner;
    layout(location = 1) in vec4 dab;
    layout(location = 2) in vec4 axes;
    uniform vec2 origin;
    uniform vec2 res;
    out vec2 uv;
    out vec2 world;
    out float strength;
    void main() {
      world = dab.xy + axes.xy * corner.x + axes.zw * corner.y;
      uv = corner + 0.5;
      strength = dab.z;
      vec2 p = (world - origin) / res;
      gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
    }`, `#version 300 es
    precision highp float;
    in vec2 uv;
    in vec2 world;
    in float strength;
    uniform sampler2D tip;
    uniform sampler2D paper;
    uniform float depth;
    uniform float bright;
    uniform float gain;
    uniform float grain;
    uniform vec3 color;
    uniform sampler2D mask;
    uniform vec4 maskRect;
    out vec4 o;
    float inside(vec2 p) {
      if (maskRect.z <= 0.0) return 1.0;
      vec2 q = (p - maskRect.xy) / maskRect.zw;
      return q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0 ? 0.0 : texture(mask, q).a;
    }
    void main() {
      float c = texture(tip, uv).a * inside(world);
      float h = clamp(texture(paper, world / (${PAPER_SIZE}.0 * grain)).r + bright, 0.0, 1.0);
      float a = min(1.0, max(0.0, c * strength - depth * (1.0 - h)) * gain);
      o = vec4(color * a, a);
    }`);
  // Shows part of the built-up stamps in the brush colour. `offset` turns a
  // pixel of the window into the same pixel of the buffer.
  const showProg = program(`#version 300 es
    in vec2 corner;
    void main() { gl_Position = vec4(corner * 2.0, 0.0, 1.0); }`, `#version 300 es
    precision highp float;
    uniform sampler2D built;
    uniform ivec2 offset;
    uniform vec3 color;
    uniform sampler2D mask;
    uniform vec4 maskRect;
    uniform vec3 win;
    out vec4 o;
    float inside(vec2 p) {
      if (maskRect.z <= 0.0) return 1.0;
      vec2 q = (p - maskRect.xy) / maskRect.zw;
      return q.x < 0.0 || q.y < 0.0 || q.x > 1.0 || q.y > 1.0 ? 0.0 : texture(mask, q).a;
    }
    void main() {
      vec2 world = vec2(win.x + gl_FragCoord.x, win.y + win.z - gl_FragCoord.y);
      float m = min(1.0, texelFetch(built, ivec2(gl_FragCoord.xy) + offset, 0).r) * inside(world);
      o = vec4(color * m, m);
    }`);

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, 0.5]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const inst = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  for (const [loc, off] of [[1, 0], [2, 16]]) {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 32, off);
    gl.vertexAttribDivisor(loc, 1);
  }

  const texture = (unit, filter, wrap) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return t;
  };
  const tipTex = texture(0, gl.LINEAR, gl.CLAMP_TO_EDGE);
  texture(1, gl.LINEAR, gl.REPEAT);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, PAPER_SIZE, PAPER_SIZE, 0, gl.RED, gl.UNSIGNED_BYTE, paperHeights());
  const builtTex = texture(2, gl.NEAREST, gl.CLAMP_TO_EDGE);
  const maskTex = texture(3, gl.LINEAR, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  let size = [0, 0];
  let tipKey = '';
  let maskRect = [0, 0, 0, 0];

  const U = (p, n) => gl.getUniformLocation(p, n);
  gl.useProgram(dabProg);
  gl.uniform1i(U(dabProg, 'tip'), 0);
  gl.uniform1i(U(dabProg, 'paper'), 1);
  gl.uniform1i(U(dabProg, 'mask'), 3);
  gl.useProgram(showProg);
  gl.uniform1i(U(showProg, 'built'), 2);
  gl.uniform1i(U(showProg, 'mask'), 3);
  const u = {
    origin: U(dabProg, 'origin'), grain: U(dabProg, 'grain'), res: U(dabProg, 'res'), gain: U(dabProg, 'gain'), depth: U(dabProg, 'depth'),
    bright: U(dabProg, 'bright'), dabColor: U(dabProg, 'color'), offset: U(showProg, 'offset'), showColor: U(showProg, 'color'),
    dabMask: U(dabProg, 'maskRect'), showMask: U(showProg, 'maskRect'), win: U(showProg, 'win'),
  };

  // The buffer the stamps build up in, as big as the canvas but never on
  // screen itself: one channel, half-float so hundreds of faint stamps add up
  // smoothly (8 bits would round most of them away).
  function resize(w, h) {
    if (size[0] === w && size[1] === h) return;
    size = [w, h];
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, builtTex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (const [inner, format, type] of [[gl.R16F, gl.RED, gl.HALF_FLOAT], [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE]]) {
      gl.texImage2D(gl.TEXTURE_2D, 0, inner, w, h, 0, format, type, null);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, builtTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) break;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function begin(tip) {
    resize(dims.CW, dims.CH);
    const key = JSON.stringify(tip);
    if (key !== tipKey) {
      tipKey = key;
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tipTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, softTip(tip));
    }
    // With a lasso selection, its shape (over its box), so the live line is
    // trimmed to it as the finished stroke will be.
    maskRect = [0, 0, 0, 0];
    const sel = state.selection;
    if (sel && sel.box.w >= 1 && sel.box.h >= 1) {
      const { x, y, w, h } = sel.box;
      const c = new OffscreenCanvas(Math.ceil(w), Math.ceil(h));
      const ctx = c.getContext('2d');
      ctx.translate(-x, -y);
      ctx.fill(sel.path);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, maskTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
      maskRect = [x, y, Math.ceil(w), Math.ceil(h)];
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function stamps(list, color, b, ox, oy, w, h) {
    if (!list.n) return;
    gl.useProgram(dabProg);
    gl.uniform2f(u.origin, ox, oy);
    gl.uniform2f(u.res, w, h);
    gl.uniform1f(u.depth, b.texture);
    gl.uniform1f(u.bright, b.paperLevel ?? 0);
    gl.uniform1f(u.grain, b.paperScale ?? 1);
    // Each stamp adds a share of what reaches the paper, scaled to how many
    // stamps overlap, so the line darkens gradually with pressure rather than
    // going solid wherever the paper is reached at all.
    gl.uniform1f(u.gain, ((b.gain ?? 16) * stampSpacing(b)) / (b.size * b.count));
    gl.uniform3fv(u.dabColor, color);
    gl.uniform4fv(u.dabMask, maskRect);
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.bufferData(gl.ARRAY_BUFFER, list.data.subarray(0, list.n * 8), gl.STREAM_DRAW);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, list.n);
    gl.disable(gl.BLEND);
  }

  // New settled stamps go into the buffer.
  function add(list, b) {
    if (!list.n) return;
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(0, 0, size[0], size[1]);
    stamps(list, [1, 1, 1], b, 0, 0, size[0], size[1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // Draws the window by the pen: the buffer there, then the provisional tail.
  function show(win, tail, color, b) {
    if (pencilCanvas.width !== win.size) {
      pencilCanvas.width = win.size;
      pencilCanvas.height = win.size;
    }
    gl.bindVertexArray(vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, win.size, win.size);
    gl.useProgram(showProg);
    gl.uniform2i(u.offset, win.ox, size[1] - win.oy - win.size);
    gl.uniform3fv(u.showColor, color);
    gl.uniform4fv(u.showMask, maskRect);
    gl.uniform3f(u.win, win.ox, win.oy, win.size);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (tail) stamps(tail, color, b, win.ox, win.oy, win.size, win.size);
  }

  // Empties part of the buffer, once it has been copied to the stroke canvas.
  function clearBox(x, y, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(x, size[1] - y - h, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.disable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  return { begin, add, show, clearBox };
}

// A growing list of stamps (8 numbers each) and the box they cover.
function stampList() {
  return { data: new Float32Array(8 * 4096), n: 0, x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
}
function pushStamp(list, x, y, a, ax, ay, bx, by, r) {
  if ((list.n + 1) * 8 > list.data.length) {
    const more = new Float32Array(list.data.length * 2);
    more.set(list.data);
    list.data = more;
  }
  list.data.set([x, y, a, 0, ax, ay, bx, by], list.n * 8);
  list.n++;
  list.x0 = Math.min(list.x0, x - r);
  list.y0 = Math.min(list.y0, y - r);
  list.x1 = Math.max(list.x1, x + r);
  list.y1 = Math.max(list.y1, y + r);
}
function emptyList(list) {
  list.n = 0;
  list.x0 = list.y0 = Infinity;
  list.x1 = list.y1 = -Infinity;
}

// The tip, strongest in the middle and fading to its rough edge, so that a
// harder press reaches further out and the line widens, as in Photoshop.
function softTip(tip) {
  const m = stampMask(tip);
  const c = new OffscreenCanvas(m.width, m.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(m, 0, 0);
  const img = ctx.getImageData(0, 0, m.width, m.height);
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) {
      const nx = (x + 0.5 - m.width / 2) / (m.width / 2);
      const ny = (y + 0.5 - m.height / 2) / (m.height / 2);
      const r = Math.min(1, Math.hypot(nx, ny));
      const k = (y * m.width + x) * 4 + 3;
      img.data[k] = Math.round(img.data[k] * (1 - r * r * (3 - 2 * r)) ** 0.7);
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const usesPencilGL = (b) => !!(b.height && pencilGL());

function pencilBegin(s) {
  const n = parseInt(state.color.slice(1), 16);
  s.gpu = { dabs: stampList(), win: null, color: [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255] };
  pencilGL().begin(s.b.tip);
}

// One spacing step: the same scatter, jitter, pressure and tilt as stampStep,
// as stamps for the GPU. Strength is flow by pressure, with opacity jitter;
// the paper decides what of it reaches the page.
function pencilStep(s, x, y, pr, random, list) {
  const b = s.b;
  const D = b.size * byPressure(b.minSize, pr);
  const strength = b.flow * byPressure(b.flowMin ?? 0, pr) * byPressure(b.opacityMin, pr);
  const lean = b.tilt && s.tilt ? s.tilt : null;
  const baseAngle = lean ? ((lean.dir - state.view.r) * 180) / Math.PI : b.angle;
  const stretch = lean ? 1 + (b.tilt - 1) * lean.mag : 1;
  const tip = stampMask(b.tip);
  const aspect = tip.height / tip.width;
  for (let k = 0; k < b.count; k++) {
    const sc = b.scatter * D;
    const px = x + (random() - 0.5) * 2 * sc;
    const py = y + (random() - 0.5) * 2 * sc;
    const ang = ((baseAngle + (random() - 0.5) * 2 * b.angleJitter * 180) * Math.PI) / 180;
    const size = D * (1 - b.sizeJitter * random());
    const a = strength * (1 - b.opacityJitter * random());
    const w = size * stretch;
    const h = size * aspect * b.roundness;
    const c = Math.cos(ang);
    const sn = Math.sin(ang);
    const r = Math.max(w, h) * 0.75;
    pushStamp(list, px, py, a, c * w, sn * w, -sn * h, c * h, r);
    if (list === s.gpu.dabs) grow(s, px, py, r);
  }
}

// The tail from the last settled point to the pen, stamped fresh each frame
// with repeatable random numbers so it does not shimmer.
function pencilTail(s) {
  const list = stampList();
  if (!s.prov || !s.lastDrawn) return list;
  const tail = tailPoints(s);
  const rnd = seededRandom(Math.round(s.lastDrawn.x * 7) * 73856093 ^ Math.round(s.lastDrawn.y * 7) * 19349663);
  const h = stampSpacing(s.b);
  let carry = s.dabCarry || 0;
  for (let i = 1; i < tail.length; i++) {
    const a = tail[i - 1];
    const b = tail[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.hypot(dx, dy);
    let pos = h - carry;
    while (pos <= d) {
      const t = pos / d;
      pencilStep(s, a.x + dx * t, a.y + dy * t, a.pr + (b.pr - a.pr) * t, rnd, list);
      pos += h;
    }
    carry = d - (pos - h);
  }
  return list;
}

// Only a small window around the pen is redrawn on screen each frame, like
// the live canvas of the other brushes (redrawing a canvas the size of the
// whole page every frame dropped one frame in five). When the pen nears its
// edge, what the window holds is copied onto the stroke canvas and emptied
// from the buffer, and the window moves along. Stamps built up in two parts
// and laid one over the other come out exactly as if built up in one.
function pencilSettle(s) {
  const P = s.gpu;
  const W = P.win;
  if (!W) return;
  pencilGL().show(W, null, P.color, s.b);
  strokeCtx.drawImage(pencilCanvas, W.ox, W.oy);
  pencilGL().clearBox(W.ox, W.oy, W.size, W.size);
  P.win = null;
}

function pencilRender(s, withTail = true) {
  const P = s.gpu;
  const tail = withTail ? pencilTail(s) : null;
  const pen = s.prov || s.lastDrawn;
  const reach = s.b.size * 2 + 8;
  const fits = (l) => !l || !l.n || (l.x0 >= P.win.ox && l.y0 >= P.win.oy && l.x1 <= P.win.ox + P.win.size && l.y1 <= P.win.oy + P.win.size);
  if (P.win && !(fits(P.dabs) && fits(tail))) pencilSettle(s);
  const spilled = P.dabs.n && !P.win;
  if (!P.win && pen) {
    const half = Math.ceil(LIVE_REACH + reach);
    P.win = { ox: Math.round(pen.x - half), oy: Math.round(pen.y - half), size: half * 2 };
    pencilCanvas.style.transform = `translate(${P.win.ox}px, ${P.win.oy}px)`;
    pencilCanvas.style.display = 'block';
  }
  // Stamps that land outside even the new window (a very fast jump) are
  // copied over on pen-up.
  if (spilled && !fits(P.dabs)) P.spill = { x0: Math.min(P.spill?.x0 ?? Infinity, P.dabs.x0), y0: Math.min(P.spill?.y0 ?? Infinity, P.dabs.y0), x1: Math.max(P.spill?.x1 ?? -Infinity, P.dabs.x1), y1: Math.max(P.spill?.y1 ?? -Infinity, P.dabs.y1) };
  pencilGL().add(P.dabs, s.b);
  emptyList(P.dabs);
  if (P.win) pencilGL().show(P.win, tail, P.color, s.b);
}

// Pen-up: the rest of the stroke goes onto the stroke canvas, to be merged
// like any other, so undo, opacity and selections work as for any brush.
function pencilEnd(s) {
  pencilRender(s, false);
  pencilSettle(s);
  const sp = s.gpu.spill;
  if (sp) {
    const size = Math.ceil(LIVE_REACH + s.b.size * 2 + 8) * 2;
    for (let y = Math.floor(sp.y0); y < sp.y1; y += size) {
      for (let x = Math.floor(sp.x0); x < sp.x1; x += size) {
        s.gpu.win = { ox: x, oy: y, size };
        pencilSettle(s);
      }
    }
  }
  pencilCanvas.style.display = 'none';
  s.gpu = null;
}
