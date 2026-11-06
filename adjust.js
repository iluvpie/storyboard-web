'use strict';
// Hue, saturation and brightness for the active layer (or just the selection on
// it). The sliders preview live on the canvas; Apply keeps the change as one
// undo step, Cancel or Escape puts the layer back.

const adjustPanel = $('#adjustPanel');
// `var`, so code in earlier files can check it before this file has run.
var adjust = null; // { layer, canvas, backup, h, s, b, raf }

function openAdjust() {
  if (adjust || !mounted || playing) return;
  if (typeof filter !== 'undefined' && filter) closeFilter(true);
  if (lift) dropSelection();
  const layer = activeLayer();
  if (!layer) return;
  const canvas = live.get(layer.id);
  const backup = new OffscreenCanvas(canvas.width, canvas.height);
  backup.getContext('2d').drawImage(canvas, 0, 0);
  adjust = { layer, canvas, backup, h: 0, s: 0, b: 0, raf: 0 };
  adjustGL.load(backup);
  for (const k of ['h', 's', 'b']) {
    $(`#adj-${k}`).value = 0;
    $(`#adj-${k}-val`).textContent = '0';
  }
  adjustPanel.hidden = false;
  $('#adjustLayerName').textContent = state.selection ? `${layer.name}, selection only` : layer.name;
}

// The adjustment runs on the GPU: each pixel goes to hue, saturation and value,
// is shifted, and comes back. (The browser's own hue-rotate filter is only an
// approximation that also darkens: pure red turned 120 degrees came out dark
// green.) Hue turns colours around the wheel; saturation goes to grey at -100
// and twice as strong at +100; brightness mixes towards white or black, so it
// lifts and darkens black line art as well as colour.
const adjustGL = (() => {
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
    uniform float hue, sat, bri;
    // HSL, like Photoshop's Hue/Saturation: taking the saturation out of red
    // leaves mid grey, not white.
    vec3 toHsl(vec3 c) {
      float mx = max(c.r, max(c.g, c.b));
      float mn = min(c.r, min(c.g, c.b));
      float l = (mx + mn) / 2.0;
      float d = mx - mn;
      if (d < 1e-6) return vec3(0.0, 0.0, l);
      float s = l > 0.5 ? d / (2.0 - mx - mn) : d / (mx + mn);
      float h = mx == c.r ? (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0) : mx == c.g ? (c.b - c.r) / d + 2.0 : (c.r - c.g) / d + 4.0;
      return vec3(h / 6.0, s, l);
    }
    vec3 toRgb(vec3 c) {
      vec3 k = clamp(abs(mod(c.x * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      return c.z + c.y * (k - 0.5) * (1.0 - abs(2.0 * c.z - 1.0));
    }
    void main() {
      vec4 c = texture2D(tex, uv);
      vec3 hsl = toHsl(c.rgb);
      hsl.x = fract(hsl.x + hue);
      hsl.y = clamp(hsl.y * sat, 0.0, 1.0);
      vec3 rgb = toRgb(hsl);
      rgb = bri >= 0.0 ? mix(rgb, vec3(1.0), bri) : mix(rgb, vec3(0.0), -bri);
      gl_FragColor = vec4(rgb * c.a, c.a);
    }`));
  gl.linkProgram(prog);
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, 'p');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  const u = { hue: gl.getUniformLocation(prog, 'hue'), sat: gl.getUniformLocation(prog, 'sat'), bri: gl.getUniformLocation(prog, 'bri') };
  return {
    canvas,
    // Uploads the layer once, with colours unpremultiplied so the maths sees
    // the real colour of half-transparent pixels.
    load(src) {
      canvas.width = src.width;
      canvas.height = src.height;
      gl.viewport(0, 0, src.width, src.height);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    },
    run(h, s, b) {
      gl.uniform1f(u.hue, h / 360);
      gl.uniform1f(u.sat, 1 + s / 100);
      gl.uniform1f(u.bri, b / 100);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      return canvas;
    },
  };
})();

function renderAdjust() {
  const a = adjust;
  if (!a) return;
  a.raf = 0;
  const out = adjustGL.run(a.h, a.s, a.b);
  const ctx = a.canvas.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, a.canvas.width, a.canvas.height);
  if (state.selection) {
    ctx.drawImage(a.backup, 0, 0);
    ctx.clip(state.selection.path);
    ctx.clearRect(0, 0, a.canvas.width, a.canvas.height);
  }
  ctx.drawImage(out, 0, 0);
  ctx.restore();
}

function setAdjust(key, value) {
  if (!adjust) return;
  adjust[key] = value;
  $(`#adj-${key}-val`).textContent = value > 0 ? `+${value}` : String(value);
  if (!adjust.raf) adjust.raf = requestAnimationFrame(renderAdjust);
}

function closeAdjust(keep) {
  const a = adjust;
  if (!a) return;
  cancelAnimationFrame(a.raf);
  adjust = null;
  adjustPanel.hidden = true;
  const changed = a.h || a.s || a.b;
  const ctx = a.canvas.getContext('2d');
  if (keep && changed) {
    renderAdjustInto(a);
    const before = createImageBitmap(a.backup);
    const after = createImageBitmap(a.canvas);
    a.layer.dirty = true;
    pushHistory({ type: 'pixels', shotId: mounted.id, layerId: a.layer.id, x: 0, y: 0, w: a.canvas.width, h: a.canvas.height, before, after });
    scheduleThumb();
    markDirty();
  } else {
    ctx.clearRect(0, 0, a.canvas.width, a.canvas.height);
    ctx.drawImage(a.backup, 0, 0);
  }
}

// Makes sure the canvas holds the final values, even if the last slider move
// has not been drawn yet.
function renderAdjustInto(a) {
  adjust = a;
  renderAdjust();
  adjust = null;
}

for (const k of ['h', 's', 'b']) {
  $(`#adj-${k}`).addEventListener('input', (e) => setAdjust(k, Number(e.target.value)));
  // Double-click a slider to put it back to 0.
  $(`#adj-${k}`).addEventListener('dblclick', (e) => { e.target.value = 0; setAdjust(k, 0); });
}
$('#adjustApply').addEventListener('click', () => closeAdjust(true));
$('#adjustCancel').addEventListener('click', () => closeAdjust(false));
$('#layerAdjust').addEventListener('click', openAdjust);
