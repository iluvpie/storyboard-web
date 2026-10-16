'use strict';
// `npm run selftest` drives the app with synthetic pen input, checks the
// results, saves screenshots and exits. `npm run perf` measures drawing speed.
// Neither touches any project file.

if (query.has('selftest')) ready.then(runSelftest);
if (query.has('perf')) ready.then(runPerf);
if (query.has('dragperf')) ready.then(runDragPerf);
if (query.has('loadperf')) ready.then(runLoadPerf);

// Opening a big board: builds one (shots x layers, each drawn on), opens it
// the way a file is opened, and reports how long the screen stays choppy
// while the timeline pictures and scrub previews are made.
async function runLoadPerf() {
  const shots = Number(query.get('shots') || 40);
  const layers = Number(query.get('layers') || 7);
  const settle = () => Promise.all(state.shots.flatMap((s) => s.layers.map((l) => l.pending)).filter(Boolean));
  for (let i = 1; i < shots; i++) await addShot();
  for (let i = 0; i < state.shots.length; i++) {
    await selectShot(i);
    // One shot at a time: the drawings of the shot just left are saved as
    // images before the next is drawn, or the copies waiting pile up.
    await settle();
    for (let k = 1; k < layers; k++) await addLayer();
    for (const layer of mounted.layers) {
      const ctx = live.get(layer.id).getContext('2d');
      ctx.strokeStyle = '#1b1b1f';
      ctx.lineWidth = 4;
      for (let k = 0; k < 12; k++) { ctx.beginPath(); ctx.moveTo(dims.FX + 100 + k * 140, dims.FY + 80 + i * 3); ctx.bezierCurveTo(dims.FX + 500, dims.FY + 900, dims.FX + 1300, dims.FY + 100, dims.FX + 1800 - k * 60, dims.FY + 1000); ctx.stroke(); }
      layer.dirty = true;
    }
  }
  await selectShot(0);
  await settle();
  const file = `${await window.api.selftestTempDir()}/load-perf.sboard`;
  await writeProject(file);
  await new Promise((r) => setTimeout(r, 3000));
  const lines = [];
  // The longest the screen went without a new frame, and the total over 50ms.
  const watch = () => {
    const frames = [];
    let last = performance.now();
    let on = true;
    const tick = (t) => { frames.push(t - last); last = t; if (on) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return () => { on = false; const f = frames.slice(1); return { worst: Math.round(Math.max(0, ...f)), stalled: Math.round(f.filter((v) => v > 50).reduce((a, b) => a + b, 0)), over200: f.filter((v) => v > 200).length }; };
  };
  const thumbsDone = () => state.shots.every((s) => s.thumbUrl);
  const warmed = () => state.shots.filter((s) => s !== mounted && (scrubFrames.get(s.id) || {}).key === scrubKey(s)).length >= Math.min(state.shots.length, scrubLimit()) - 1;
  const run = async (label, open) => {
    const stop = watch();
    const t0 = performance.now();
    await open();
    const opened = performance.now() - t0;
    let thumbsAt = 0;
    let warmAt = 0;
    while (performance.now() - t0 < 240000 && !(thumbsAt && warmAt)) {
      await new Promise((r) => setTimeout(r, 100));
      if (!thumbsAt && thumbsDone()) thumbsAt = performance.now() - t0;
      if (!warmAt && warmed()) warmAt = performance.now() - t0;
    }
    const f = stop();
    lines.push(`LOAD ${label}: first shot showing after ${Math.round(opened)}ms; timeline pictures ${Math.round(thumbsAt)}ms; scrub previews ${Math.round(warmAt)}ms; longest freeze ${f.worst}ms, frozen ${f.stalled}ms in all (${f.over200} freezes over 0.2s)`);
  };
  // The old way: the whole file as one string, drawings turned back from text in the window.
  await run('old way', async () => {
    const text = await window.api.selftestReadFile(file);
    await enqueue(() => loadData(JSON.parse(text), null));
  });
  await new Promise((r) => setTimeout(r, 3000));
  // A fair second run: nothing kept from the first.
  for (const [, { entry }] of scrubFrames) entry.promise.then(disposeFrameSource);
  scrubFrames.clear();
  await run('new way', async () => {
    const a = performance.now();
    const opened = await window.api.selftestOpen(file);
    const b = performance.now();
    const data = JSON.parse(opened.text);
    await enqueue(() => loadData(data, file, opened));
    lines.push(`LOAD   new way phases: reading the file and handing it over ${Math.round(b - a)}ms, laying out the board and showing shot 1 ${Math.round(performance.now() - b)}ms`);
  });
  const size = (await window.api.selftestReadFile(file)).length;
  window.api.selftestDone([`LOAD ${shots} shots x ${layers} layers, file ${(size / 1e6).toFixed(0)} MB`, ...lines]);
}
if (query.has('sliderperf')) ready.then(runSliderPerf);

// `npm start -- --sliders`: drags every slider in the app one step per frame
// and reports how long each takes to respond, and any late frames.
async function runSliderPerf() {
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  const lines = [];
  const sets = [['brush', () => setBrush('ink')], ['stamp brush', () => setBrush('apencil')], ['motion blur', () => setBrush('blur')]];
  const seen = new Set();
  for (const [label, setup] of sets) {
    setup();
    await frame();
    for (const input of document.querySelectorAll('input[type=range]')) {
      const id = input.id || input.closest('label')?.textContent.trim().slice(0, 18) || '?';
      if (seen.has(id) || !input.offsetParent) continue;
      seen.add(id);
      const min = Number(input.min || 0), max = Number(input.max || 100);
      const start = Number(input.value);
      const work = [];
      const gaps = [];
      let last = await frame();
      for (let k = 0; k < 40; k++) {
        input.value = String(min + ((max - min) * (k % 20)) / 20);
        const t = performance.now();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        work.push(performance.now() - t);
        const now = await frame();
        gaps.push(now - last);
        last = now;
      }
      input.value = String(start);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const sorted = [...gaps].sort((p, q) => p - q);
      const f = sorted[Math.floor(sorted.length / 2)];
      lines.push(`${(label + ': ' + id).padEnd(40)} work avg ${(work.reduce((p, q) => p + q, 0) / work.length).toFixed(1)} / max ${Math.max(...work).toFixed(1)} ms, late frames ${gaps.filter((g) => g > f * 1.5).length} of ${gaps.length}`);
    }
  }
  window.api.selftestDone(lines);
}

// `npm run perf -- --drag`: a board of 12 drawn shots, then real mouse drags
// that move a clip and stretch a clip's edge, reporting late frames for each.
// `npm run perf -- --drag --pen --lassofill`: with the lasso tool on and a
// selection made, a real pen press (through Chromium's input) on the selection
// bar's Fill button. Reports whether it filled.
async function runLassoFill() {
  setColor('#000000');
  setTool('lasso');
  setSelection([{ x: dims.FX + 400, y: dims.FY + 400 }, { x: dims.FX + 600, y: dims.FY + 400 }, { x: dims.FX + 600, y: dims.FY + 600 }, { x: dims.FX + 400, y: dims.FY + 600 }]);
  await new Promise((r) => setTimeout(r, 300));
  const log = [];
  for (const t of ['pointerdown', 'pointerup', 'click']) $('#selFill').addEventListener(t, (e) => log.push(`${t}:${e.pointerType || ''}`));
  window.api.onPerfReport(async () => {
    await enqueue(async () => {});
    const a = live.get(mounted.activeLayerId).getContext('2d').getImageData(dims.FX + 500, dims.FY + 500, 1, 1).data[3];
    window.api.selftestDone([`LASSOFILL alpha ${a}, selection ${state.selection ? 'kept' : 'gone'}, tool ${state.tool}, events ${log.join(' ')}`]);
  });
  const r = $('#selFill').getBoundingClientRect();
  const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  window.api.perfDrags([{ from: c, to: c }]);
}

async function runDragPerf() {
  if (query.has('lassofill')) { runLassoFill(); return; }
  // `--heavy`: a board like a real animatic, with 30 shots of mixed lengths,
  // 90 seconds of audio and a reference video, then a trim and a ruler scrub.
  const heavy = query.has('heavy');
  for (let i = 0; i < (heavy ? Number(query.get("shots") || 30) - 1 : 11); i++) await addShot();
  if (heavy) {
    state.shots.forEach((s, i) => { s.duration = 24 + (i * 17) % 60; });
    await loadAudio(makeWav(90), 'long.wav', 'audio/wav', 0);
    await useVideo(query.get('video') || await window.api.selftestMakeVideo('mp4'));
  }
  for (let i = 0; i < state.shots.length; i++) {
    await selectShot(i);
    const ctx = live.get(mounted.activeLayerId).getContext('2d');
    ctx.strokeStyle = '#1b1b1f';
    ctx.lineWidth = 6;
    for (let k = 0; k < 12; k++) {
      ctx.beginPath();
      ctx.moveTo(dims.FX + 200 + k * 120, dims.FY + 200 + (k % 4) * 150);
      ctx.bezierCurveTo(dims.FX + 600, dims.FY + 900, dims.FX + 1200, dims.FY + 100, dims.FX + 1700 - k * 50, dims.FY + 800);
      ctx.stroke();
    }
    mounted.layers[0].dirty = true;
    await updateThumb(mounted);
  }
  await selectShot(2);
  fitTimeline();
  if (heavy) setZoom(tl.ppf * 3);
  toggleCamera();
  setTool('perspective');
  await new Promise((r) => setTimeout(r, 500));
  const gaps = {};
  let last = 0;
  // How closely the size slider follows the pen: value changes per pen move.
  let sliderDragging = false;
  $('#railSize').addEventListener('pointerdown', () => { sliderDragging = true; });
  window.addEventListener('pointerup', () => { sliderDragging = false; }, true);
  const sliderLog = { moves: 0, inputs: 0, values: new Set() };
  $('#railSize').addEventListener('input', (e) => { sliderLog.inputs++; sliderLog.values.add(e.target.value); });
  window.addEventListener('pointermove', () => { if (sliderDragging) sliderLog.moves++; }, true);
  let lastWheel = 0;
  viewport.addEventListener('wheel', () => { lastWheel = performance.now(); }, true);
  window.api.onPerfTool((tool) => setTool(tool));
  const loaf = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < 7) continue;
      loaf.push(`LOAF ${Math.round(e.duration)}ms during ${tl.drag ? tl.drag.kind : '-'}: render ${Math.round(e.renderStart ? e.startTime + e.duration - e.renderStart : 0)}ms, style+layout ${Math.round(e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0)}ms, blocking ${Math.round(e.blockingDuration)}ms; scripts: ${e.scripts.map((s) => `${s.invoker || s.sourceFunctionName} ${Math.round(s.duration)}ms`).join(', ') || 'none'}`);
    }
  }).observe({ type: 'long-animation-frame', buffered: true });
  const loop = (t) => {
    const kind = tl.drag ? tl.drag.kind : camDrag ? `camera-${camDrag.mode}` : gridDrag ? `grid-${gridDrag.kind}` : scrubbing !== null ? 'scrub' : pan ? 'pan' : performance.now() - lastWheel < 200 ? 'zoom' : sliderDragging ? 'slider' : null;
    if (kind && last) (gaps[kind] = gaps[kind] || []).push(t - last);
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  window.api.onPerfReport(() => {
    const lines = Object.entries(gaps).map(([kind, g]) =>
      `${kind.padEnd(6)} frames over 12ms: ${g.filter((x) => x > 12).length}, over 9ms: ${g.filter((x) => x > 9).length} of ${g.length}  (${perf.stat(g)})`);
    lines.push(`size slider: ${sliderLog.inputs} value changes for ${sliderLog.moves} pointer moves while dragging it, ${sliderLog.values.size} different sizes`);
    window.api.selftestDone([...(lines.length ? lines : ['no drag frames recorded']), `scrub cache misses: ${scrubMisses.length} (${scrubMisses.join(', ')})`, ...loaf]);
  });
  const clip = document.querySelectorAll('.clip')[2].getBoundingClientRect();
  const midY = clip.top + clip.height / 2;
  if (heavy) {
    // Lets the idle warm-up finish, as it would while she works.
    const t0 = performance.now();
    while (performance.now() - t0 < 15000 && state.shots.some((s) => s !== mounted && !(scrubFrames.get(s.id) || {}).entry?.ready)) await new Promise((r) => setTimeout(r, 100));
    loaf.push(`WARM ${state.shots.filter((s) => (scrubFrames.get(s.id) || {}).entry?.ready).length} of ${state.shots.length} shots ready after ${Math.round(performance.now() - t0)}ms`);
    tl.scroll.scrollLeft = 0;
    await new Promise((r) => requestAnimationFrame(r));
    const c2 = document.querySelectorAll('.clip')[2].getBoundingClientRect();
    const hit = document.elementFromPoint(c2.right - 3, midY);
    loaf.push(`SETUP shots ${state.shots.length}, frames ${totalFrames()}, ppf ${tl.ppf.toFixed(2)}, reference ${state.reference ? state.reference.duration.toFixed(1) + 's' : 'none'}, audio ${state.audio ? state.audio.buffer.duration + 's' : 'none'}, clip right ${Math.round(c2.right)} of window ${innerWidth}, trim target ${hit ? hit.className : 'none'}`);
    const ruler = tl.ruler.getBoundingClientRect();
    const ry = ruler.top + ruler.height / 2;
    window.api.perfDrags([
      { from: { x: c2.right - 3, y: midY }, to: { x: c2.right + 250, y: midY } },
      { from: { x: ruler.left + 40, y: ry }, to: { x: ruler.right - 40, y: ry } },
    ]);
    return;
  }
  window.api.perfDrags([
    { from: { x: clip.left + clip.width / 2, y: midY }, to: { x: clip.left + clip.width / 2 + 600, y: midY } },
    { from: { x: clip.right - 3, y: midY }, to: { x: clip.right + 250, y: midY } },
    ...[['.cam-start .cam-tag', 200, 100], ['.cam-end .cam-se', -150, -80], ['.grid-handle.corner[data-key="2"]', 120, 60]].map(([sel, dx, dy]) => {
      const r = document.querySelector(sel).getBoundingClientRect();
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      return { from: c, to: { x: c.x + dx, y: c.y + dy } };
    }),
    ...(() => {
      const v = viewport.getBoundingClientRect();
      const c = { x: v.left + v.width / 2, y: v.top + v.height / 2 };
      return [
        { tool: 'pan', from: c, to: { x: c.x + 300, y: c.y + 150 } },
        { tool: 'brush', wheel: c },
        // The brush size slider in the left rail, dragged up its length.
        (() => {
          const s = $('#railSize').getBoundingClientRect();
          return { slider: true, from: { x: s.left + s.width / 2, y: s.bottom - 6 }, to: { x: s.left + s.width / 2, y: s.top + 6 } };
        })(),
      ];
    })(),
  ]);
}

async function runPerf() {
  // `--ref`: draw over a reference video, to check it costs nothing.
  if (query.has('ref')) await useVideo(query.get('video') || await window.api.selftestMakeVideo('mp4'));
  // `--shots=N --layers=N`: a board like a real one, every shot with N drawn layers.
  if (query.has('shots') || query.has('layers')) {
    const shots = Number(query.get('shots') || 1);
    const layers = Number(query.get('layers') || 1);
    for (let i = 1; i < shots; i++) await addShot();
    for (let i = 0; i < state.shots.length; i++) {
      await selectShot(i);
      for (let k = 1; k < layers; k++) await addLayer();
      for (const layer of mounted.layers) {
        const ctx = live.get(layer.id).getContext('2d');
        ctx.strokeStyle = '#1b1b1f';
        ctx.lineWidth = 4;
        for (let k = 0; k < 12; k++) { ctx.beginPath(); ctx.moveTo(dims.FX + 100 + k * 140, dims.FY + 80); ctx.bezierCurveTo(dims.FX + 500, dims.FY + 900, dims.FX + 1300, dims.FY + 100, dims.FX + 1800 - k * 60, dims.FY + 1000); ctx.stroke(); }
        layer.dirty = true;
      }
    }
    await selectShot(0);
    // Building the board leaves every layer of it to be saved as an image in
    // the background, which a real session never has all at once (opening a
    // project loads them already saved). Let that finish before measuring.
    await Promise.all(state.shots.flatMap((s) => s.layers.map((l) => l.pending)).filter(Boolean));
  }
  // `--brush=<id>`: measure a particular brush.
  if (query.get('brush')) setBrush(query.get('brush'));
  // `--save`: a 40-shot board saved every 1.5s while the pen draws, to see
  // whether saving interrupts drawing.
  if (query.has('save')) {
    for (let i = 0; i < 39; i++) await addShot();
    for (let i = 0; i < state.shots.length; i++) {
      await selectShot(i);
      const ctx = live.get(mounted.activeLayerId).getContext('2d');
      ctx.strokeStyle = '#1b1b1f';
      ctx.lineWidth = 5;
      for (let k = 0; k < 30; k++) { ctx.beginPath(); ctx.moveTo(dims.FX + 100 + k * 50, dims.FY + 100 + (k % 7) * 120); ctx.bezierCurveTo(dims.FX + 600, dims.FY + 900, dims.FX + 1300, dims.FY + 50, dims.FX + 1800 - k * 30, dims.FY + 1000); ctx.stroke(); }
      mounted.layers[0].dirty = true;
    }
    await selectShot(0);
    state.path = `${await window.api.selftestTempDir()}\\save-perf.sboard`;
    const saves = [];
    setInterval(() => { const t = performance.now(); save().then(() => saves.push(performance.now() - t)); }, 1500);
    window.saveTimes = saves;
    const loaf = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration > 30) loaf.push(`${Math.round(e.duration)}ms (blocking ${Math.round(e.blockingDuration)}; ${e.scripts.map((s) => `${s.sourceFunctionName || s.invoker} ${Math.round(s.duration)}`).join(', ') || 'no script'})`); }).observe({ type: 'long-animation-frame' });
    window.saveLoaf = loaf;
  }
  // `--settle`: wait for the background catch-up after building the board
  // (thumbnails and the scrub cache) before measuring, like drawing a while
  // after opening a project rather than straight away.
  if (query.has('settle')) {
    const t0 = performance.now();
    const warmed = () => state.shots.filter((s) => s !== mounted && (scrubFrames.get(s.id) || {}).key === scrubKey(s)).length >= Math.min(state.shots.length, scrubLimit()) - 1;
    while (performance.now() - t0 < 120000 && (!warmed() || thumbsDue.size || thumbTimer)) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 1000));
    console.log(`SETTLED after ${Math.round(performance.now() - t0)}ms, warm ${warmed()}`);
  }
  perf.start();
  const longFrames = [];
  new PerformanceObserver((list) => { for (const e of list.getEntries()) if (e.duration > 25) longFrames.push(`${Math.round(e.duration)}ms (blocking ${Math.round(e.blockingDuration)}; ${e.scripts.map((s) => `${s.sourceFunctionName || s.invoker || '?'} ${Math.round(s.duration)}`).join(', ') || 'no script'})`); }).observe({ type: 'long-animation-frame' });
  window.longFrames = longFrames;
  const slow = {};
  const timed = (name, fn) => function (...args) {
    const t = performance.now();
    const r = fn.apply(this, args);
    Promise.resolve(r).then(() => (slow[name] = slow[name] || []).push(performance.now() - t));
    return r;
  };
  endStroke = timed('endStroke', endStroke);
  updateThumb = timed('updateThumb', updateThumb);
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) (slow.longtask = slow.longtask || []).push(e.duration);
  }).observe({ type: 'longtask', buffered: true });
  const report = () => [
    ...perf.lines(),
    `early pen events ${RAW_EVENTS && state.rawEvents ? 'ON' : 'OFF'}`,
    `F2 readout showing after a real F2 press: ${!!document.getElementById('perfHud')}`,
    `frames over 12ms  ${perf.frames.filter((f) => f > 12).length} of ${perf.frames.length}`,
    (() => {
      const s = [...perf.frames].sort((p, q) => p - q);
      const frame = s[Math.floor(s.length / 2)] || 0;
      return `screen frame ${frame.toFixed(1)}ms (${Math.round(1000 / frame)}Hz); late frames (over 1.5 of those) ${perf.frames.filter((g) => g > frame * 1.5).length} of ${perf.frames.length}`;
    })(),
    ...Object.entries(slow).map(([k, v]) => `${k.padEnd(13)} ${perf.stat(v)} (x${v.length})`),
    ...(window.saveTimes ? [`saves         ${perf.stat(window.saveTimes)} (x${window.saveTimes.length})`] : []),
    ...(window.saveLoaf ? window.saveLoaf.slice(0, 8).map((l) => `LOAF ${l}`) : []),
    `long frames while drawing: ${window.longFrames.length}`,
    ...window.longFrames.slice(0, 10).map((l) => `  ${l}`),
    ...(window.saveParts ? [`save parts (serialize / stringify / send / wait, size): ${window.saveParts.slice(-3).map((p) => p.slice(0, 4).map((v) => Math.round(v)).join(' / ') + ', ' + Math.round(p[4] / 1e6) + 'MB').join(' | ')}`] : []),
  ];
  window.api.onPerfReport(() => window.api.selftestDone(report()));
  const r = frameEl.getBoundingClientRect();
  window.api.perfReady({ left: r.left, top: r.top, width: r.width, height: r.height, strokes: 12 });
}

async function runSelftest() {
  const out = [];
  const check = (ok, msg) => out.push(`${ok ? 'PASS' : 'FAIL'} ${msg}`);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const capture = async (name) => { await queue; await wait(250); return window.api.selftestCapture(name); };
  // Frame coordinates to layer coordinates.
  const F = (x, y) => ({ x: dims.FX + x, y: dims.FY + y });
  const alphaAt = (p, layerId = mounted.activeLayerId) =>
    live.get(layerId).getContext('2d').getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data[3];
  const pixelAt = (p, layerId = mounted.activeLayerId) =>
    [...live.get(layerId).getContext('2d').getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data];

  // points: [x, y, pressure] in frame coordinates.
  function pen(points, { type = 'pen', lift = true, whole = false, shift = false, ctrl = false, alt = false, tilt = null } = {}) {
    const vr = viewport.getBoundingClientRect();
    const round = (v) => (whole ? Math.round(v) : v);
    const ev = (kind, [x, y, p]) => {
      const s = toScreen({ x: dims.FX + x, y: dims.FY + y });
      return new PointerEvent(kind, {
        pointerId: 7, pointerType: type, isPrimary: true, bubbles: true,
        button: kind === 'pointermove' || kind === 'pointerrawupdate' ? -1 : 0, buttons: kind === 'pointerup' ? 0 : 1,
        pressure: kind === 'pointerup' ? 0 : p,
        clientX: round(vr.left + s.x), clientY: round(vr.top + s.y),
        shiftKey: shift, ctrlKey: ctrl, altKey: alt,
        ...(tilt ? { tiltX: tilt[0], tiltY: tilt[1] } : {}),
      });
    };
    if (busy) out.push(`NOTE a test stroke started while the app was busy (${busy}) and was ignored`);
    viewport.dispatchEvent(ev('pointerdown', points[0]));
    for (const pt of points.slice(1)) {
      if (RAW_EVENTS) viewport.dispatchEvent(ev('pointerrawupdate', pt));
      viewport.dispatchEvent(ev('pointermove', pt));
    }
    if (lift) viewport.dispatchEvent(ev('pointerup', points[points.length - 1]));
  }
  const wave = (x0, x1, y, amp, n = 80) => Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return [x0 + (x1 - x0) * t, y + Math.sin(t * TAU) * amp, 0.15 + 0.85 * Math.sin(t * Math.PI)];
  });
  const arc = (cx, cy, rad, a0 = 0, a1 = TAU, n = 120) => Array.from({ length: n }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / (n - 1);
    return [cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, 1];
  });
  const line = (x0, y0, x1, y1, n = 40) => Array.from({ length: n }, (_, i) => [x0 + ((x1 - x0) * i) / (n - 1), y0 + ((y1 - y0) * i) / (n - 1), 1]);
  const brushSetup = (id, props) => { setBrush(id); Object.assign(brush(), props); };

  try {
    await capture('fresh.png');

    // ---- brushes
    brushSetup('ink', { size: 30 });
    pen(wave(300, 1600, 540, 120));
    check(alphaAt(F(950, 540)) > 0, 'ink stroke draws pixels');
    check(alphaAt(F(950, 200)) === 0, 'pixels away from the stroke stay empty');
    await undo();
    check(alphaAt(F(950, 540)) === 0, 'undo removes the stroke');
    await redo();
    check(alphaAt(F(950, 540)) > 0, 'redo restores the stroke');

    // No stabilization: a sharp zigzag keeps its exact corner instead of
    // being rounded off.
    brushSetup('ink', { size: 8, minSize: 0.12, cleanup: 0 });
    const zig = [...line(300, 900, 400, 800, 40), ...line(400, 800, 500, 900, 40).slice(1)];
    pen(zig);
    check(alphaAt(F(400, 801)) > 0 && alphaAt(F(400, 812)) === 0, 'with the wiggle filter off, ink keeps corners exactly where the pen turned');
    brushSetup('ink', { size: 8, minSize: 0.12, cleanup: 3 });
    pen(zig.map(([x, y, p]) => [x + 300, y, p]));
    check(alphaAt(F(700, 806)) > 0 && alphaAt(F(700, 816)) === 0, 'with it on, corners round off by only a few pixels');
    brushSetup('nib', { size: 20, roundness: 0.3, angle: 35 });
    pen(zig.map(([x, y, p]) => [x + 700, y, p]));
    check(alphaAt(F(1100, 806)) > 0 && alphaAt(F(1100, 822)) === 0, 'oval nib corners too');
    await undo();
    await undo();
    await undo();

    // Smooth like Photoshop: the edge of a straight stroke is even (no bumps
    // where pieces overlap), and a stroke through a few far-apart points
    // follows a curve instead of straight pieces.
    await addShot();
    brushSetup('ink', { size: 16, minSize: 1 });
    pen(Array.from({ length: 200 }, (_, i) => [300 + i * 2, 600.3, 1]));
    const edgeRow = [];
    for (let x = 400; x < 600; x++) edgeRow.push(alphaAt(F(x, 600.3 + 7.5)));
    const typical = [...edgeRow].sort((p, q) => p - q)[edgeRow.length >> 1];
    const even = edgeRow.filter((v) => Math.abs(v - typical) <= 2).length / edgeRow.length;
    check(typical > 0 && even >= 0.98, `stroke edges are even, anti-aliased once (${Math.round(even * 100)}% of the edge identical)`);
    const ring = Array.from({ length: 7 }, (_, i) => {
      const a = (i / 6) * Math.PI;
      return [960 + Math.cos(a) * 300, 300 + Math.sin(a) * 300, 1];
    });
    brush().size = 6;
    pen(ring);
    const between = (2.5 / 6) * Math.PI; // halfway between two pen samples
    const onArc = F(960 + Math.cos(between) * 300, 300 + Math.sin(between) * 300);
    const chord = F(960 + Math.cos(between) * 300 * Math.cos(Math.PI / 12), 300 + Math.sin(between) * 300 * Math.cos(Math.PI / 12));
    check(alphaAt(onArc) > 0 && alphaAt(chord) === 0, 'between pen samples the line curves through, not straight across');
    // A quick sketchy circle: few samples, noisy pressure, like a fast hand.
    brush().size = 7;
    brush().minSize = 0.12;
    pen(Array.from({ length: 34 }, (_, i) => {
      const t = (i / 33) * TAU * 1.05;
      return [960 + Math.cos(t) * 160, 640 + Math.sin(t) * 150, 0.55 + 0.25 * Math.sin(i * 1.7) + 0.08 * Math.cos(i * 5.3)];
    }));
    state.view.z = 2.2; state.view.x = -(dims.FX + 960) * 2.2 + 600; state.view.y = -(dims.FY + 640) * 2.2 + 380; applyView();
    await capture('smooth.png');
    fitView();
    // Wiggle filter: a straight line drawn with jittery pen positions comes
    // out straight. Measures how far the line's centre wanders.
    const jitter = (i) => ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 1.5; // up to ±1.5px
    const wobbly = (y) => Array.from({ length: 400 }, (_, i) => [300 + i * 1.2, y + jitter(i), 1]);
    const wander = (y0) => {
      const xs = [];
      for (let x = 340; x < 740; x += 4) {
        let sum = 0;
        let wsum = 0;
        for (let dy = -14; dy <= 14; dy++) {
          const a = alphaAt(F(x, y0 + dy));
          sum += a * dy;
          wsum += a;
        }
        if (wsum) xs.push(sum / wsum);
      }
      const mean = xs.reduce((p, q) => p + q, 0) / xs.length;
      return Math.sqrt(xs.reduce((p, q) => p + (q - mean) ** 2, 0) / xs.length);
    };
    brushSetup('ink', { size: 8, minSize: 1, cleanup: 0 });
    pen(wobbly(800));
    const raw = wander(800);
    brushSetup('ink', { size: 8, minSize: 1, cleanup: 3 });
    pen(wobbly(900));
    const filtered = wander(900);
    check(filtered < 0.35 && filtered < raw / 2, `wiggle filter straightens a jittery line (wanders ${filtered.toFixed(2)}px, ${raw.toFixed(2)}px without)`);

    // The real cause: pen positions rounded to whole screen pixels. A slow
    // circle drawn that way, measured by how far the line's centre strays
    // from a perfect circle.
    const slowCircle = (cx) => Array.from({ length: 900 }, (_, i) => {
      const a = (i / 899) * TAU * 0.9;
      return [cx + Math.cos(a) * 160, 600 + Math.sin(a) * 160, 0.8];
    });
    // Reads the layer with sub-pixel (bilinear) sampling, so the measurement
    // does not add its own rounding noise.
    const stray = (cx) => {
      const c0 = F(cx - 180, 420);
      const img = live.get(mounted.activeLayerId).getContext('2d').getImageData(Math.floor(c0.x), Math.floor(c0.y), 360, 360);
      const at = (p) => {
        // Pixel centres sit at +0.5.
        const x = p.x - 0.5 - Math.floor(c0.x);
        const y = p.y - 0.5 - Math.floor(c0.y);
        const x0 = Math.floor(x);
        const y0 = Math.floor(y);
        const fx = x - x0;
        const fy = y - y0;
        const A = (xx, yy) => img.data[(yy * 360 + xx) * 4 + 3];
        return A(x0, y0) * (1 - fx) * (1 - fy) + A(x0 + 1, y0) * fx * (1 - fy) + A(x0, y0 + 1) * (1 - fx) * fy + A(x0 + 1, y0 + 1) * fx * fy;
      };
      const devs = [];
      for (let k = 0; k < 240; k++) {
        const a = 0.2 + (k / 240) * TAU * 0.8;
        let sum = 0;
        let wsum = 0;
        for (let d = -10; d <= 10; d += 0.25) {
          const al = at(F(cx + Math.cos(a) * (160 + d), 600 + Math.sin(a) * (160 + d)));
          sum += al * d;
          wsum += al;
        }
        if (wsum) devs.push(sum / wsum);
      }
      const mean = devs.reduce((p, q) => p + q, 0) / devs.length;
      return Math.sqrt(devs.reduce((p, q) => p + (q - mean) ** 2, 0) / devs.length);
    };
    await addShot(); // a blank shot, so other test strokes cannot skew the measurement
    brushSetup('ink', { size: 6, minSize: 1, cleanup: 0 });
    pen(slowCircle(560), { whole: true });
    const stairs = stray(560);
    brushSetup('ink', { size: 6, minSize: 1, cleanup: 0 });
    pen(slowCircle(1000));
    const perfect = stray(1000);
    check(perfect < 0.1, `the wobble measurement reads a perfect circle as straight (${perfect.toFixed(3)}px)`);
    await undo();
    brushSetup('ink', { size: 6, minSize: 1, cleanup: 4 });
    pen(slowCircle(1000), { whole: true });
    const cleaned = stray(1000);
    check(cleaned < stairs / 1.8, `pixel-rounded pen positions draw a clean circle (wobbles ${cleaned.toFixed(2)}px, ${stairs.toFixed(2)}px without the filter)`);
    // And it does not drag behind: during a slow, careful line (250 screen px
    // a second) the drawn line stays a few pixels from the pen, the rest of
    // the way being the live preview.
    brushSetup('ink', { size: 6, minSize: 1, cleanup: 4 });
    const slow = Array.from({ length: 200 }, (_, i) => [400 + i, 1000 + i * 0.3, 0.8]);
    pen(slow, { lift: false });
    const tip = F(...slow[slow.length - 1].slice(0, 2));
    const trail = Math.hypot(tip.x - stroke.lastDrawn.x, tip.y - stroke.lastDrawn.y) * state.view.z;
    viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'pen', bubbles: true, button: 0, buttons: 0 }));
    check(trail < 10, `a slow line is drawn within a few pixels of the pen (${trail.toFixed(1)} screen px behind)`);
    state.view.z = 2.4; state.view.x = -(dims.FX + 780) * 2.4 + 640; state.view.y = -(dims.FY + 470) * 2.4 + 260; applyView();
    await capture('wiggle.png');
    fitView();
    await deleteShot();
    await deleteShot();

    brushSetup('eraser', { size: 80 });
    pen([[900, 540, 1], [1000, 540, 1]]);
    check(alphaAt(F(950, 540)) === 0, 'eraser removes pixels');
    await undo();
    check(alphaAt(F(950, 540)) > 0, 'undo restores erased pixels');
    // The eraser is an oval nib too (softer than the Oval nib brush), and runs
    // along the same smooth curve.
    brushSetup('ink', { size: 100, minSize: 1 });
    pen(line(250, 300, 750, 300));
    brushSetup('eraser', { size: 60, roundness: 0.6, angle: 0, minSize: 1 });
    pen([[500, 300, 1]]);
    check(alphaAt(F(526, 300)) === 0 && alphaAt(F(500, 326)) > 0, 'the eraser is an oval, wide one way and thinner the other');
    brushSetup('eraser', { size: 16, roundness: 0.6, angle: 35, minSize: 1 });
    pen(arc(500, 380, 70, Math.PI * 1.15, Math.PI * 1.85, 40));
    const arcMid = F(500 + Math.cos(Math.PI * 1.5) * 70, 380 + Math.sin(Math.PI * 1.5) * 70);
    check(alphaAt(arcMid) === 0, 'and erases along a smooth curve');
    await undo();
    await undo();
    await undo();

    brushSetup('ink', { size: 20 });
    pen(line(-300, -150, -100, -150));
    check(alphaAt(F(-200, -150)) > 0, 'drawing outside the frame keeps the pixels');

    brushSetup('nib', { size: 40, roundness: 0.3, angle: 0, minSize: 0.2 });
    pen([[1500, 900, 1]]);
    check(alphaAt(F(1515, 900)) > 0 && alphaAt(F(1500, 915)) === 0, 'oval nib is wide one way and thin the other');
    brush().angle = 90;
    pen([[1700, 900, 1]]);
    check(alphaAt(F(1700, 915)) > 0 && alphaAt(F(1715, 900)) === 0, 'oval nib follows its angle');

    // Animator pencil, from Kyle Webster's Animator Pencil 2016 settings:
    // pressure drives flow, flow builds up within a stroke, the colour is kept.
    await addShot();
    setColor('#3a3a40');
    brushSetup('apencil', { cleanup: 0 });
    const centre = (y0) => {
      // Average across the line: single pixels vary with the paper grain.
      let sum = 0;
      for (let dy = -6; dy <= 6; dy++) for (let dx = 0; dx < 40; dx += 2) sum += alphaAt(F(500 + dx, y0 + dy));
      return Math.round(sum / (13 * 20));
    };
    const levels = [];
    for (const [i, p] of [[0, 0.1], [1, 0.5], [2, 1]].map(([i, p]) => [i, p])) {
      pen(Array.from({ length: 50 }, (_, k) => [300 + k * 8, 250 + i * 60, p]));
      levels.push(centre(250 + i * 60));
    }
    out.push(`INFO pencil darkness at pressure 10% / 50% / 100%: ${levels.map((v) => Math.round((v / 255) * 100) + '%').join(' / ')}`);
    check(levels[0] < levels[1] && levels[1] < levels[2] && levels[0] < 140, `animator pencil: pressure sets how dark the line builds (${levels.join(', ')})`);
    // Like Photoshop, pressing harder makes the pencil line both darker and
    // wider (the paper fills in and more of the tip reaches it), not only one.
    {
      const band = (y0) => {
        let sum = 0;
        let width = 0;
        for (let x = 520; x < 640; x += 4) {
          let w = 0;
          for (let dy = -10; dy <= 10; dy++) {
            const v = alphaAt(F(x, y0 + dy));
            sum += v;
            if (v > 60) w++;
          }
          width += w;
        }
        return { mean: sum / (30 * 21), width: width / 30 };
      };
      pen(Array.from({ length: 50 }, (_, k) => [300 + k * 8, 470, 0.3]));
      pen(Array.from({ length: 50 }, (_, k) => [300 + k * 8, 530, 1]));
      const soft = band(470);
      const hard = band(530);
      check(hard.mean > soft.mean * 1.5 && hard.width > soft.width * 1.3, `animator pencil: a harder press is darker and wider (${soft.mean.toFixed(0)} to ${hard.mean.toFixed(0)} average, ${soft.width.toFixed(1)}px to ${hard.width.toFixed(1)}px wide)`);
    }
    check(alphaAt(F(600, 700)) === 0 && alphaAt(F(1500, 900)) === 0, 'a pencil stroke leaves the rest of the layer empty');
    // A moderate press, averaged along the line: near the lightest touch the
    // reading depends on which patch of paper grain the line crosses.
    const along = (y0) => { let sum = 0; for (let x = 340; x < 660; x += 2) for (let dy = -6; dy <= 6; dy++) sum += alphaAt(F(x, y0 + dy)); return Math.round(sum / (160 * 13)); };
    const thereAndBack = [...Array.from({ length: 50 }, (_, k) => [300 + k * 8, 500, 0.4]), ...Array.from({ length: 50 }, (_, k) => [700 - k * 8, 500, 0.4])];
    pen(thereAndBack);
    const twice = along(500);
    pen(Array.from({ length: 50 }, (_, k) => [300 + k * 8, 560, 0.4]));
    const once = along(560);
    check(twice > once, `flow builds up within a stroke, like Photoshop (once ${once}, back over ${twice})`);
    const px = pixelAt(F(520, 370));
    // Within a few levels: the grainy stamps leave some pixels faint, and faint
    // pixels store their colour less precisely.
    check(Math.abs(px[0] - 0x3a) <= 7 && Math.abs(px[2] - 0x40) <= 7, `pencil keeps its colour (${px.slice(0, 3).join(',')})`);

    // The plain Pencil is a graphite pencil too: harder is darker and wider.
    {
      Object.assign(state.brushes.pencil, BRUSH_PRESETS.find((b) => b.id === 'pencil'));
      brushSetup('pencil', { cleanup: 0 });
      pen(Array.from({ length: 50 }, (_, k) => [900 + k * 8, 470, 0.3]));
      pen(Array.from({ length: 50 }, (_, k) => [900 + k * 8, 530, 1]));
      const box = (y0) => { let sum = 0; let w = 0; for (let x = 1100; x < 1220; x += 4) for (let dy = -10; dy <= 10; dy++) { const v = alphaAt(F(x, y0 + dy)); sum += v; if (v > 60) w++; } return { mean: sum / 630, width: w / 30 }; };
      const soft = box(470);
      const hard = box(530);
      check(hard.mean > soft.mean * 1.5 && hard.width > soft.width * 1.2, `pencil: a harder press is darker and wider (${soft.mean.toFixed(0)} to ${hard.mean.toFixed(0)} average, ${soft.width.toFixed(1)}px to ${hard.width.toFixed(1)}px wide)`);
    }
    // Ultimate pencil (KYLE Ultimate Pencil Hard): pressure sets size as well.
    Object.assign(state.brushes.upencil, BRUSH_PRESETS.find((b) => b.id === 'upencil'));
    brushSetup('upencil', { cleanup: 0, sizeJitter: 0, opacityJitter: 0 });
    pen(Array.from({ length: 60 }, (_, k) => [300 + k * 8, 650, 0.1]));
    pen(Array.from({ length: 60 }, (_, k) => [300 + k * 8, 720, 1]));
    const width = (y0) => { let n = 0; for (let dy = -12; dy <= 12; dy++) if (alphaAt(F(520, y0 + dy)) > 20) n++; return n; };
    const thin = width(650);
    const thick = width(720);
    const ink = (y0) => { let sum = 0; for (let x = 480; x < 560; x += 2) for (let dy = -12; dy <= 12; dy++) sum += alphaAt(F(x, y0 + dy)); return sum; };
    check(thick > thin && ink(720) > ink(650) * 2, `ultimate pencil: harder pressure is thicker and darker (${thin}px to ${thick}px)`);

    // Grain airbrush: soft, with a grainy texture through it.
    brushSetup('gair', { size: 200 });
    pen(Array.from({ length: 40 }, (_, k) => [900 + k * 10, 400, 0.8]));
    const spots = [];
    for (let k = 0; k < 40; k++) spots.push(alphaAt(F(1000 + k, 400 + (k % 5))));
    const mean = spots.reduce((p, q) => p + q, 0) / spots.length;
    const spread = Math.sqrt(spots.reduce((p, q) => p + (q - mean) ** 2, 0) / spots.length);
    check(mean > 20 && spread > 8, `grain airbrush sprays a grainy texture (alpha ${Math.round(mean)} ± ${Math.round(spread)})`);
    check(alphaAt(F(1100, 400 + 95)) < alphaAt(F(1100, 400)), 'and fades towards its edge');
    // Gesinski ink: pressure sets the size only; a light touch is still solid ink.
    brushSetup('gink', { size: 16, texture: 0, scatter: 0 });
    pen(Array.from({ length: 60 }, (_, k) => [300 + k * 8, 800, 0.25]));
    pen(Array.from({ length: 60 }, (_, k) => [300 + k * 8, 860, 1]));
    const inkThin = width(800);
    const inkThick = width(860);
    // Darkest point across the thin line (it is narrower than the averaging box).
    const darkest = (y0) => { let m = 0; for (let dy = -6; dy <= 6; dy++) for (let dx = 0; dx < 40; dx += 4) m = Math.max(m, alphaAt(F(500 + dx, y0 + dy))); return m; };
    check(inkThick > inkThin * 2 && darkest(800) > 200, `gesinski ink: pressure sets the width, light strokes stay solid (${inkThin}px to ${inkThick}px, centre ${darkest(800)})`);
    // Milk oolong: a flat paint brush; pressure sets size and how solid it lays down.
    brushSetup('oolong', { texture: 0, sizeJitter: 0, opacityJitter: 0, cleanup: 0 });
    pen(Array.from({ length: 60 }, (_, k) => [1000 + k * 8, 650, 0.15]));
    pen(Array.from({ length: 60 }, (_, k) => [1000 + k * 8, 750, 1]));
    const paintWidth = (y0) => { let n = 0; for (let dy = -30; dy <= 30; dy++) if (alphaAt(F(1220, y0 + dy)) > 20) n++; return n; };
    const paintCore = (y0) => { let m = 0; for (let dy = -6; dy <= 6; dy++) m = Math.max(m, alphaAt(F(1220, y0 + dy))); return m; };
    out.push(`INFO milk oolong at pressure 15% / 100%: ${paintWidth(650)}px ${Math.round(paintCore(650) / 2.55)}%, ${paintWidth(750)}px ${Math.round(paintCore(750) / 2.55)}%`);
    check(paintWidth(750) > paintWidth(650) * 2 && paintCore(750) > paintCore(650) && paintCore(750) > 230, `milk oolong: harder pressure is wider and more solid (${paintWidth(650)}px to ${paintWidth(750)}px)`);
    // A look at the two new brushes with their preset settings.
    for (const id of ['upencil', 'gair']) Object.assign(state.brushes[id], BRUSH_PRESETS.find((p) => p.id === id));
    setBrush('upencil');
    for (let k = 0; k < 3; k++) pen(Array.from({ length: 50 }, (_, i) => { const t = i / 49; return [300 + t * 500, 900 + Math.sin(t * Math.PI) * -60 + k * 25, 0.2 + 0.75 * Math.sin(t * Math.PI)]; }));
    setBrush('gair');
    pen(Array.from({ length: 30 }, (_, i) => [1100 + i * 15, 850, 0.6]));
    state.view.z = 1; state.view.x = -(dims.FX + 700) + 640; state.view.y = -(dims.FY + 850) + 330; applyView();
    await capture('stamps.png');
    fitView();
    // A quick sketch with the preset settings, for a look at the texture.
    Object.assign(state.brushes.apencil, BRUSH_PRESETS.find((b) => b.id === 'apencil'));
    setBrush('apencil');
    for (let loop = 0; loop < 3; loop++) {
      pen(Array.from({ length: 70 }, (_, i) => {
        const t = i / 69;
        const a = -1.2 + t * TAU * 1.05 + loop * 0.4;
        return [1300 + Math.cos(a) * (95 + loop * 4), 330 + Math.sin(a) * (88 - loop * 3), 0.2 + 0.7 * Math.sin(t * Math.PI)];
      }));
    }
    for (let k = 0; k < 4; k++) {
      pen(Array.from({ length: 40 }, (_, i) => {
        const t = i / 39;
        return [1180 - t * 380 - k * 12, 470 + t * 160 + k * 9, 0.15 + 0.8 * Math.sin(t * Math.PI)];
      }));
    }
    state.view.z = 1.6; state.view.x = -(dims.FX + 1150) * 1.6 + 640; state.view.y = -(dims.FY + 470) * 1.6 + 330; applyView();
    await capture('pencil.png');
    // Leaning the pen broadens the animator pencil the way it leans, like
    // Photoshop's Pen Tilt control. Measured as the inked height of a
    // sideways line, upright and then leaning towards the bottom.
    {
      await addShot();
      setBrush('apencil');
      const across = (y) => {
        let n = 0;
        for (const x of [400, 450, 500, 550, 600]) for (let dy = -12; dy <= 12; dy++) if (alphaAt(F(x, y + dy)) > 40) n++;
        return n / 5;
      };
      const flat = Array.from({ length: 60 }, (_, i) => [300 + i * 7, 400, 0.9]);
      pen(flat);
      pen(flat.map(([x, y, p]) => [x, y + 200, p]), { tilt: [0, 60] });
      const upright = across(400);
      const leaning = across(600);
      check(upright > 0 && leaning > upright * 1.2, `leaning the pen broadens the animator pencil (${upright.toFixed(1)}px upright, ${leaning.toFixed(1)}px leaning)`);
      await deleteShot();
    }
    // And the Gesinski ink with its preset settings: tapered swoops and hatching.
    Object.assign(state.brushes.gink, BRUSH_PRESETS.find((b) => b.id === 'gink'));
    setBrush('gink');
    setColor('#141416');
    for (let k = 0; k < 3; k++) {
      pen(Array.from({ length: 60 }, (_, i) => {
        const t = i / 59;
        return [300 + t * 520, 1000 + Math.sin(t * Math.PI * 1.3) * -90 + k * 40, 0.05 + 0.95 * Math.sin(t * Math.PI)];
      }));
    }
    for (let k = 0; k < 8; k++) pen(Array.from({ length: 12 }, (_, i) => { const t = i / 11; return [900 + k * 14 + t * 60, 960 + t * 110, 0.1 + 0.6 * Math.sin(t * Math.PI)]; }));
    state.view.z = 1.6; state.view.x = -(dims.FX + 700) * 1.6 + 640; state.view.y = -(dims.FY + 1000) * 1.6 + 330; applyView();
    await capture('gink.png');
    // Milk oolong with its preset settings: loose painted strokes.
    Object.assign(state.brushes.oolong, BRUSH_PRESETS.find((b) => b.id === 'oolong'));
    setBrush('oolong');
    for (let k = 0; k < 4; k++) {
      pen(Array.from({ length: 50 }, (_, i) => {
        const t = i / 49;
        return [1050 + t * 420, 1180 - Math.sin(t * Math.PI) * 50 + k * 30 - 200, 0.2 + 0.8 * Math.sin(t * Math.PI)];
      }));
    }
    for (let k = 0; k < 3; k++) pen(Array.from({ length: 30 }, (_, i) => { const t = i / 29; return [1520 + k * 45, 900 + t * 220, 0.3 + 0.7 * Math.sin(t * Math.PI)]; }));
    pen(Array.from({ length: 60 }, (_, i) => { const a = (i / 59) * TAU * 0.9; return [1300 + Math.cos(a) * 90, 1150 + Math.sin(a) * 60, 0.25 + 0.6 * Math.sin((i / 59) * Math.PI)]; }));
    state.view.z = 1.3; state.view.x = -(dims.FX + 1300) * 1.3 + 640; state.view.y = -(dims.FY + 1020) * 1.3 + 330; applyView();
    await capture('oolong.png');
    fitView();
    await deleteShot();
    setColor('#1b1b1f');

    brushSetup('airbrush', { size: 120, flow: 0.1, opacity: 1 });
    pen(line(200, 950, 600, 950));
    const air = alphaAt(F(400, 950));
    check(air > 0 && air < 255, `airbrush builds up softly (alpha ${air})`);

    // Motion blur brush: blurs the drawing under it along the stroke.
    brushSetup('ink', { size: 10 });
    pen(line(1200, 150, 1200, 350));
    pen(line(1500, 150, 1500, 350));
    check(alphaAt(F(1215, 250)) === 0, 'before blurring, the area beside the line is empty');
    // Across the first line (sideways): it spreads sideways.
    brushSetup('blur', { size: 80, strength: 1, length: 60, pressureStrength: false });
    pen(line(1120, 250, 1290, 250, 40));
    const beside = alphaAt(F(1215, 250));
    const under = alphaAt(F(1200, 250));
    check(beside > 0 && under > 20 && under < 240, `the motion blur brush blurs a line along the stroke (alpha ${under} on it, ${beside} beside it)`);
    check(alphaAt(F(1200, 160)) > 240 && alphaAt(F(1290, 250)) === 0, 'lines outside the brush stay crisp, and nothing is dragged to the end of the stroke');
    // Along the second line (up and down): it stays sharp sideways.
    pen(line(1500, 200, 1500, 300, 30));
    check(alphaAt(F(1515, 250)) === 0 && alphaAt(F(1500, 250)) > 200, 'brushing along a line leaves it sharp sideways (the blur follows the stroke)');
    await undo();
    await undo();
    check(alphaAt(F(1215, 250)) === 0 && alphaAt(F(1200, 250)) > 240, 'one undo takes each motion blur stroke off');


    // ---- fill
    await addShot();
    brushSetup('ink', { size: 8 });
    pen(arc(900, 500, 200));
    setTool('fill');
    state.fill.gap = 3;
    setColor('#3d6fd6');
    await fillAt(F(900, 500));
    const filled = pixelAt(F(900, 500));
    check(filled[3] === 255 && filled[2] > 150, 'fill colours the inside of a closed shape');
    check(alphaAt(F(900, 850)) === 0, 'fill stays inside the lines');
    check(alphaAt(F(900, 500 - 200 + 3)) > 0, 'fill reaches under the line, leaving no white edge');
    await undo();
    setColor('#1b1b1f');

    await addShot();
    brushSetup('ink', { size: 8 });
    pen(arc(900, 500, 200, 0.03, TAU - 0.03));
    setTool('fill');
    state.fill.gap = 3;
    await fillAt(F(900, 500));
    check(alphaAt(F(900, 500)) === 255 && alphaAt(F(1300, 500)) === 0, 'fill closes a small gap in the lines');
    await undo();
    state.fill.gap = 0;
    await fillAt(F(900, 500));
    check(alphaAt(F(1300, 500)) === 255, 'with gap closing off, the same fill leaks out (so the gap is real)');
    await undo();
    state.fill.gap = 3;

    // ---- lasso
    await addShot();
    brushSetup('ink', { size: 30 });
    pen([[500, 500, 1]]);
    setTool('lasso');
    pen([[400, 400, 1], [600, 400, 1], [600, 600, 1], [400, 600, 1], [400, 401, 1]]);
    check(!!state.selection, 'lasso makes a selection');
    pen([[500, 500, 1], [650, 500, 1], [800, 500, 1]]);
    check(!!lift, 'dragging inside the selection picks the pixels up');
    deselect();
    check(alphaAt(F(500, 500)) === 0 && alphaAt(F(800, 500)) > 0, 'moved pixels land where they were dropped');
    setTool('lasso');
    pen([[100, 100, 1], [300, 100, 1], [300, 300, 1], [100, 300, 1], [100, 101, 1]]);
    brushSetup('ink', { size: 20 });
    pen(line(50, 200, 350, 200));
    check(alphaAt(F(200, 200)) > 0 && alphaAt(F(60, 200)) === 0, 'brushes only paint inside the selection');
    await paintSelection('fill');
    check(alphaAt(F(150, 150)) === 255, 'lasso fill fills the selection');
    await capture('lasso.png');
    deselect();

    // Several areas at once, like Photoshop: Shift adds, Ctrl cuts (Alt too), both keep the overlap.
    {
      await addShot();
      setTool('lasso');
      const sq = (x0, y0, s) => [[x0, y0, 1], [x0 + s, y0, 1], [x0 + s, y0 + s, 1], [x0, y0 + s, 1], [x0, y0 + 1, 1]];
      pen(sq(200, 200, 200));
      pen(sq(700, 200, 200), { shift: true });
      check(state.selection && state.selection.polys.length === 2, `Shift with the lasso adds a second area (${state.selection ? state.selection.polys.length : 0} areas)`);
      pen(sq(260, 260, 80), { ctrl: true });
      check(state.selection && state.selection.polys[0].length + state.selection.polys[1].length === 3, `Ctrl with the lasso cuts a hole out`);
      // Alt picks a colour with the lasso, as with the brushes, and leaves the selection alone.
      setColor('#2050e0');
      brushSetup('ink', { size: 12 });
      pen([[840, 340, 1]]);
      setColor('#1b1b1f');
      setTool('lasso');
      pen(sq(840, 340, 40), { alt: true });
      await wait(200); // a colour pick lands after a moment
      await capture('lasso-multi.png');
      check(state.color.toLowerCase() === '#2050e0' && state.selection && state.selection.polys[0].length + state.selection.polys[1].length === 3, `Alt with the lasso picks a colour and leaves the selection as it was (${state.color})`);
      setColor('#1b1b1f');
      await paintSelection('fill');
      check(alphaAt(F(220, 220)) === 255 && alphaAt(F(800, 300)) === 255, `fill fills every selected area`);
      check(alphaAt(F(300, 300)) === 0 && alphaAt(F(550, 300)) === 0, `and leaves the hole and the gap between them empty`);
      // Dragging inside moves all the areas together.
      pen([[220, 220, 1], [270, 270, 1], [320, 320, 1]]);
      deselect();
      check(alphaAt(F(220 + 100, 380 + 100)) === 255 && alphaAt(F(800 + 100, 300 + 100)) === 255 && alphaAt(F(210, 210)) === 0, `dragging moves every selected area together`);
      // Shift and Ctrl together keep only the overlap.
      pen(sq(1100, 600, 200));
      pen(sq(1200, 700, 200), { shift: true, ctrl: true });
      const b = state.selection && state.selection.box;
      check(b && Math.abs(b.x - F(1200, 0).x) <= 2 && Math.abs(b.w - 100) <= 4 && Math.abs(b.h - 100) <= 4, `Shift+Ctrl keeps only where the two overlap (${b ? b.w + 'x' + b.h : 'none'})`);
      deselect();
      // The Lasso panel's Cut button does the same as holding Ctrl (for the iPad).
      pen(sq(200, 600, 150));
      document.querySelector('#toolPanel .seg-btn[data-mode="sub"], .seg-btn[data-mode="sub"]').click();
      pen(sq(240, 640, 40));
      const rings = state.selection ? state.selection.polys.flat().length : 0;
      document.querySelector('.seg-btn[data-mode="new"]').click();
      check(rings === 2 && state.lassoMode === 'new', `the Lasso panel's Cut button cuts without a key held (${rings} outlines)`);
      deselect();
      // Undo and redo step through selections, like Photoshop.
      pen(sq(200, 600, 150));
      pen(sq(500, 600, 150), { shift: true });
      const areas = () => (state.selection ? state.selection.polys.length : 0);
      await undo();
      const a1 = areas();
      await undo();
      const a0 = areas();
      await redo();
      await redo();
      check(a1 === 1 && a0 === 0 && areas() === 2, `undo and redo step through lasso selections (2 areas, undo: ${a1}, undo: ${a0}, redo twice: ${areas()})`);
      $('#selDone').click();
      const gone = !state.selection;
      await undo();
      check(gone && areas() === 2, 'Deselect can be undone');
      // Moving a selected piece: one undo puts the pixels and the outline back.
      setColor('#1b1b1f');
      await paintSelection('fill');
      const x0 = state.selection.box.x;
      pen([[275, 675, 1], [325, 675, 1], [375, 675, 1]]);
      await undo();
      check(alphaAt(F(215, 615)) === 255 && alphaAt(F(700, 675)) === 0 && Math.abs(state.selection.box.x - x0) <= 1 && !lift, `undo after moving a selection puts the pixels and the outline back (outline x ${state.selection.box.x - x0} from where it was)`);
      deselect();
      await deleteShot();
    }

    // ---- rotated canvas
    const vr = viewport.getBoundingClientRect();
    rotateAt(vr.width / 2, vr.height / 2, 0.6);
    brushSetup('ink', { size: 16 });
    pen(line(1400, 700, 1600, 700));
    check(alphaAt(F(1500, 700)) > 0 && alphaAt(F(1500, 760)) === 0, 'drawing on a rotated canvas lands where the pen is');
    const back = toCanvas({ clientX: vr.left + toScreen(F(321, 123)).x, clientY: vr.top + toScreen(F(321, 123)).y }, vr);
    check(Math.abs(back.x - F(321, 123).x) < 0.01 && Math.abs(back.y - F(321, 123).y) < 0.01, 'screen and canvas positions convert both ways when rotated');
    await capture('rotated.png');
    fitView();
    check(state.view.r === 0, 'fit to screen turns the canvas upright');

    // ---- image import
    const img = new OffscreenCanvas(400, 200);
    const ictx = img.getContext('2d');
    ictx.fillStyle = '#5fa86b';
    ictx.fillRect(0, 0, 400, 200);
    const layersBefore = mounted.layers.length;
    await importImage(await createImageBitmap(img), 'ref.png');
    check(mounted.layers.length === layersBefore + 1 && alphaAt(F(960, 540)) === 255, 'a dropped image lands on a new layer, centred in the frame');
    await undo();
    check(mounted.layers.length === layersBefore, 'undo removes the image layer');
    await redo();
    check(mounted.layers.length === layersBefore + 1 && alphaAt(F(960, 540)) === 255, 'redo brings the image back with its pixels');
    await undo();

    // ---- colour wheel, safe areas, tab wheel, camera easing
    const wr = wheel.c.getBoundingClientRect();
    const wg = wheelGeometry();
    const wp = (kind, x, y) => new PointerEvent(kind, { pointerId: 11, bubbles: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1, clientX: wr.left + x, clientY: wr.top + y });
    wheel.c.dispatchEvent(wp('pointerdown', wg.cx + wg.inner + 8, wg.cy));
    wheel.c.dispatchEvent(wp('pointerup', wg.cx + wg.inner + 8, wg.cy));
    wheel.c.dispatchEvent(wp('pointerdown', wg.cx + wg.half - 1, wg.cy - wg.half + 1));
    wheel.c.dispatchEvent(wp('pointerup', wg.cx + wg.half - 1, wg.cy - wg.half + 1));
    const picked = hexToHsv(state.color);
    check(Math.abs(picked.h - 90) < 6 && picked.s > 0.95 && picked.v > 0.95, `colour wheel picks hue from the ring and shade from the square (${state.color})`);
    await capture('wheel.png');
    setColor('#1b1b1f');
    check(document.querySelectorAll('#guides rect').length === 2 && guides.style.display !== 'none', 'safe-area guides show by default');

    // ---- layer opacity shows while drawing, not only in playback
    {
      await addShot();
      brushSetup('ink', { size: 60, opacity: 1 });
      setColor('#000000');
      pen(line(300, 400, 1500, 400, 40));
      const slider = $('#layerOpacity');
      slider.value = 30;
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      const c = live.get(mounted.activeLayerId);
      check(Number(getComputedStyle(c).opacity) === 0.3, 'the layer opacity slider fades the layer on the canvas');
      pen(line(300, 600, 1500, 600, 40), { lift: false });
      const during = Number(getComputedStyle(strokeGroup).opacity);
      check(Math.abs(during - 0.3) < 0.001 && [strokeCanvas, liveCanvas].every((k) => getComputedStyle(k).opacity === '1'), `a stroke in progress shows at the layer opacity too, as one piece (${during})`);
      state.view.z = 0.5; fitView();
      await capture('layeropacity.png');
      viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'pen', bubbles: true, button: 0, buttons: 0 }));
      await deleteShot();
      setColor('#1b1b1f');
    }

    // ---- hue, saturation, brightness
    {
      await addShot();
      brushSetup('ink', { size: 60, opacity: 1 });
      setColor('#ff0000');
      pen(line(300, 300, 900, 300, 30));
      $('#layerAdjust').click();
      check(!!adjust && !adjustPanel.hidden, 'Hue, saturation, brightness opens for the active layer');
      setAdjust('h', 120);
      renderAdjust();
      const turned = pixelAt(F(600, 300));
      await capture('adjust.png');
      check(turned[1] > 150 && turned[0] < 100, `hue previews live on the canvas: red turns green (${turned.slice(0, 3)})`);
      closeAdjust(false);
      check(pixelAt(F(600, 300))[0] > 240 && adjustPanel.hidden, 'Cancel puts the colour back');
      openAdjust();
      setAdjust('s', -100);
      closeAdjust(true);
      const grey = pixelAt(F(600, 300));
      check(Math.abs(grey[0] - grey[1]) < 6 && Math.abs(grey[1] - grey[2]) < 6 && grey[0] > 100 && grey[0] < 160 && grey[3] > 240, `saturation -100 turns red mid grey, not white, and keeps it solid (${grey})`);
      await undo();
      check(pixelAt(F(600, 300))[0] > 240 && pixelAt(F(600, 300))[1] < 20, 'Apply is one undo step');
      setColor('#000000');
      pen(line(300, 500, 900, 500, 30));
      openAdjust();
      setAdjust('b', 50);
      closeAdjust(true);
      const lifted = pixelAt(F(600, 500));
      check(lifted[0] > 100 && lifted[0] < 160 && lifted[3] > 240, `brightness lifts black line art to grey (${lifted.slice(0, 3)})`);
      // Only the selection changes when there is one.
      setSelection([F(250, 450), F(600, 450), F(600, 550), F(250, 550)]);
      openAdjust();
      setAdjust('b', -100);
      closeAdjust(true);
      check(pixelAt(F(400, 500))[0] < 10 && pixelAt(F(800, 500))[0] > 100, 'with a selection, only the selected part changes');
      deselect();

      // ---- lasso move
      setTool('lasso');
      pen([[700, 250, 1], [1000, 250, 1], [1000, 350, 1], [700, 350, 1], [700, 251, 1]]);
      check($('#selHint').textContent.includes('move') && $('#selMove').hidden, `the selection bar says how to move it (${$('#selHint').textContent})`);
      const sliderL = $('#layerOpacity');
      sliderL.value = 40;
      sliderL.dispatchEvent(new Event('input', { bubbles: true }));
      for (let k = 0; k < 5; k++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
      check(!!lift && lift.dy === 50 && Number(floatCanvas.style.opacity) === 0.4, `arrow keys nudge the selection, shown at the layer's opacity (moved ${lift && lift.dy}px, opacity ${floatCanvas.style.opacity})`);
      deselect();
      check(pixelAt(F(850, 350))[3] > 240 && pixelAt(F(850, 300))[3] === 0, 'the nudged pixels land 50px lower');
      setTool('brush');

      // ---- captions
      state.shots[state.cur].notes = 'He finally sees the bus. "Wait!"';
      refreshUI();
      const cv = $('#captionView');
      check(!cv.hidden && cv.textContent.includes('Wait!') && $('#captionCanvas').hidden, 'with Show captions off, the caption is a note under the frame (it is not exported)');
      await capture('caption.png');
      // With Show captions on it is drawn in the frame, by the code that burns it into the export.
      {
        $('#captionsOn').checked = true;
        $('#captionsOn').dispatchEvent(new Event('change'));
        const cc = $('#captionCanvas');
        const same = new OffscreenCanvas(cc.width, cc.height);
        drawCaption(same.getContext('2d'), state.shots[state.cur], cc.width, cc.height);
        const a = cc.getContext('2d').getImageData(0, 0, cc.width, cc.height).data;
        const b = same.getContext('2d').getImageData(0, 0, cc.width, cc.height).data;
        let diff = 0;
        let inked = 0;
        for (let i = 3; i < a.length; i += 4) { if (a[i] !== b[i]) diff++; if (a[i]) inked++; }
        const r = cc.getBoundingClientRect();
        const fr = frameEl.getBoundingClientRect();
        check(!cc.hidden && cv.hidden && inked > 500 && diff === 0 && Math.abs(r.left - fr.left) < 1.5 && Math.abs(r.width - fr.width) < 1.5 && Math.abs(r.top - fr.top) < 1.5,
          `with Show captions on, the caption is drawn in the frame exactly as the export draws it (${inked} pixels, ${diff} different, over the frame within ${Math.abs(r.left - fr.left).toFixed(1)}px)`);
        await capture('caption-inframe.png');
        // Its size and height can be set, and the frame follows at once.
        const bandOf = () => { const d = cc.getContext('2d').getImageData(Math.round(cc.width / 2), 0, 1, cc.height).data; let top = -1; let bottom = -1; for (let yy = 0; yy < cc.height; yy++) if (d[yy * 4 + 3] > 0) { if (top < 0) top = yy; bottom = yy; } return { top: top / cc.height, bottom: bottom / cc.height, tall: (bottom - top) / cc.height }; };
        const std = bandOf();
        const setSlider = (id, v) => { $(id).value = v; $(id).dispatchEvent(new Event('input')); };
        setSlider('#captionSize', 60);
        setSlider('#captionBottom', 200);
        const big = bandOf();
        check(std.bottom > 0.95 && std.tall < 0.06 && big.tall > std.tall * 1.6 && big.bottom < 0.82 && state.captionSize === 0.06 && state.captionBottom === 0.2,
          `the caption sits low and small by default (bottom at ${(std.bottom * 100).toFixed(0)}% of the frame, ${(std.tall * 100).toFixed(1)}% tall) and the Caption size and Caption height sliders move it (${(big.bottom * 100).toFixed(0)}%, ${(big.tall * 100).toFixed(1)}%)`);
        const saved = await serialize();
        check(saved.captionSize === 0.06 && saved.captionBottom === 0.2, 'and the caption setting is saved with the board');
        $('#captionSize').dispatchEvent(new Event('dblclick'));
        $('#captionBottom').dispatchEvent(new Event('dblclick'));
        $('#captionsOn').checked = false;
        $('#captionsOn').dispatchEvent(new Event('change'));
      }
      state.captions = true;
      state.time = shotStarts()[state.cur];
      togglePlay();
      await wait(300);
      await capture('caption-play.png');
      stopPlay();
      await wait(200);
      state.captions = false;
      const cap = new OffscreenCanvas(dims.W, dims.H);
      const cctx = cap.getContext('2d', { willReadFrequently: true });
      state.captions = false;
      drawCaption(cctx, mounted);
      const offPx = cctx.getImageData(dims.W / 2 - 300, dims.H * 0.86, 600, dims.H * 0.06).data;
      state.captions = true;
      drawCaption(cctx, mounted);
      const onPx = cctx.getImageData(dims.W / 2 - 300, dims.H * 0.86, 600, dims.H * 0.06).data;
      const count = (d) => { let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; };
      check(count(offPx) === 0 && count(onPx) > 1000, `with captions on, playback and export draw the caption as a subtitle (${count(onPx)} px)`);
      state.captions = false;
      const json = JSON.stringify(await serialize());
      check(/"captions":false/.test(json), 'the captions switch is saved with the project');
      await deleteShot();
      setColor('#1b1b1f');
    }

    // ---- parallax: back layers move less during a camera move, front ones more
    {
      await addShot();
      const back = activeLayer();
      brushSetup('ink', { size: 40, opacity: 1 });
      setColor('#ff0000');
      pen([[960, 540, 1], [961, 540, 1]]);
      await addLayer();
      const front = activeLayer();
      setColor('#0000ff');
      pen([[960, 700, 1], [961, 700, 1]]);
      await addLayer();
      const mid = activeLayer();
      setColor('#00aa00');
      pen([[960, 380, 1], [961, 380, 1]]);
      const shot = mounted;
      shot.camera = { start: { x: 0, y: 0, s: 1 }, end: { x: 400, y: 0, s: 1 }, ease: 'linear' };
      back.parallax = 0.5;
      front.parallax = 1.5;
      refreshUI();
      check($('#parallaxHint').textContent.includes('moves less'), 'the Parallax hint says a back layer moves less');
      commitLive();
      const where = async (t) => {
        const cache = new Map();
        const entry = frameSource(cache, shot, true);
        await entry.promise;
        const c = new OffscreenCanvas(dims.W, dims.H);
        const ctx = c.getContext('2d', { willReadFrequently: true });
        drawFrame(ctx, entry, shot, t);
        closeCache(cache);
        const d = ctx.getImageData(0, 0, dims.W, dims.H).data;
        const sums = { r: [0, 0], g: [0, 0], b: [0, 0] };
        for (let i = 0; i < d.length; i += 4) {
          const x = (i / 4) % dims.W;
          const key = d[i] > 200 && d[i + 1] < 60 && d[i + 2] < 60 ? 'r' : d[i + 2] > 200 && d[i] < 60 ? 'b' : d[i + 1] > 120 && d[i] < 60 && d[i + 2] < 60 ? 'g' : null;
          if (key) { sums[key][0] += x; sums[key][1]++; }
        }
        return { c, x: Object.fromEntries(Object.entries(sums).map(([k, [s, n]]) => [k, n ? s / n : NaN])) };
      };
      const t0 = await where(0);
      const t1 = await where(1);
      const moved = (k) => Math.round(t0.x[k] - t1.x[k]);
      check(Math.abs(t0.x.r - t0.x.b) < 3 && Math.abs(t0.x.r - t0.x.g) < 3, 'with parallax, every layer lines up as drawn at the start of the move');
      check(Math.abs(moved('g') - 400) < 4 && Math.abs(moved('r') - 200) < 4 && Math.abs(moved('b') - 600) < 4,
        `a 400px pan moves the back layer (50%) 200px and the front layer (150%) 600px (${moved('r')}, ${moved('g')}, ${moved('b')})`);
      shot.camera.end = { x: 0, y: 0, s: 0.5 };
      const zb = layerCam(shot, 1, 0.5);
      check(Math.abs(1 / zb.s - Math.SQRT2) < 1e-6, 'on a 2x push-in, a 50% layer grows 1.41x');
      const json = JSON.stringify(await serialize());
      check(/"parallax":0\.5/.test(json) && /"parallax":1\.5/.test(json), 'parallax is saved with the layers');
      // A look at the start and end of the pan side by side.
      shot.camera.end = { x: 400, y: 0, s: 1 };
      const s0 = await where(0);
      const s1 = await where(1);
      showPlayer();
      pctx.fillStyle = '#fff';
      pctx.fillRect(0, 0, dims.W, dims.H);
      pctx.drawImage(s0.c, 0, 0, dims.W, dims.H, 0, 0, dims.W / 2, dims.H / 2);
      pctx.drawImage(s1.c, 0, 0, dims.W, dims.H, dims.W / 2, 0, dims.W / 2, dims.H / 2);
      await capture('parallax.png');
      hidePlayer();
      await deleteShot();
      setColor('#1b1b1f');
    }

    // ---- Move tool: the whole layer, or just the selection
    {
      await addShot();
      brushSetup('ink', { size: 30, opacity: 1 });
      setColor('#000000');
      pen([[500, 500, 1], [501, 500, 1]]);
      pen([[1200, 500, 1], [1201, 500, 1]]);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', bubbles: true }));
      check(state.tool === 'move', 'V picks the Move tool');
      pen([[800, 800, 1], [850, 825, 1], [900, 850, 1]], { ctrl: true });
      check(alphaAt(F(600, 550)) > 200 && alphaAt(F(1300, 550)) > 200 && alphaAt(F(500, 500)) === 0, 'dragging with Move moves the whole layer');
      check(!state.selection && !lift && $('#selBar').hidden, 'and leaves no selection behind');
      await undo();
      check(alphaAt(F(500, 500)) > 200 && alphaAt(F(600, 550)) === 0, 'one undo puts the layer back');
      setTool('lasso');
      pen([[400, 400, 1], [600, 400, 1], [600, 600, 1], [400, 600, 1], [400, 401, 1]]);
      setTool('move');
      check(!!state.selection && $('#selHint').textContent.startsWith('Drag anywhere'), 'with a selection, Move keeps it and says it can be dragged anywhere');
      pen([[1000, 300, 1], [1050, 300, 1], [1100, 300, 1]]);
      deselect();
      check(alphaAt(F(600, 500)) > 200 && alphaAt(F(500, 500)) === 0 && alphaAt(F(1200, 500)) > 200, 'Move drags only the selected part, even from outside it');
      setTool('move');
      for (let k = 0; k < 3; k++) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true, bubbles: true }));
      await wait(900);
      check(alphaAt(F(1200, 530)) > 200 && alphaAt(F(1200, 490)) === 0 && !state.selection, 'arrow keys with Move nudge the whole layer and settle');
      await capture('move.png');
      await deleteShot();
      setColor('#1b1b1f');
      setTool('brush');
    }

    // ---- Shift, like Photoshop, and the Move tool's box
    {
      await addShot();
      brushSetup('ink', { size: 12, opacity: 1 });
      setColor('#000000');
      pen([[300, 300, 1], [301, 300, 1]]);
      pen([[700, 300, 1]], { shift: true });
      check(alphaAt(F(500, 300)) === 0 && alphaAt(F(700, 300)) > 200, 'Shift-click does not join up with the last stroke, it is just a dot');
      pen([[300, 600, 1], [330, 602, 1], [500, 630, 1], [700, 660, 1]], { shift: true });
      check(alphaAt(F(700, 600)) > 200 && alphaAt(F(700, 660)) === 0, 'Shift-drag keeps the line level');

      // A block to transform.
      await addLayer();
      setSelection([F(400, 400), F(600, 400), F(600, 500), F(400, 500)]);
      await paintSelection('fill');
      deselect();
      setTool('move');
      const box = shownRect();
      check(!!box && $('#moveLayer').querySelectorAll('.move-handle').length === 8, `the Move tool shows a box with eight handles (${box && Math.round(box.x1 - box.x0)} x ${box && Math.round(box.y1 - box.y0)})`);
      const corner = { x: box.x1 - dims.FX, y: box.y1 - dims.FY };
      // Free stretch: drag the bottom-right handle out by 200 x 100.
      pen([[corner.x, corner.y, 1], [corner.x + 100, corner.y + 50, 1], [corner.x + 200, corner.y + 100, 1]], { ctrl: true });
      check(alphaAt(F(780, 580)) > 200 && alphaAt(F(820, 620)) === 0 && alphaAt(F(410, 410)) > 200, 'dragging a corner handle stretches the layer');
      await undo();
      // Shift keeps the proportions: drag 200 across and only 20 down.
      pen([[corner.x, corner.y, 1], [corner.x + 100, corner.y + 10, 1], [corner.x + 200, corner.y + 20, 1]], { ctrl: true, shift: true });
      const r2 = contentBounds();
      check(Math.abs(r2.w / r2.h - 2) < 0.05 && Math.abs(r2.w - 400) < 4, `with Shift, stretching keeps the shape (${r2.w} x ${r2.h})`);
      await undo();
      // Alt stretches from the centre.
      pen([[corner.x, corner.y, 1], [corner.x + 50, corner.y, 1]], { ctrl: true, alt: true });
      const r3 = contentBounds();
      check(Math.abs(r3.x - (dims.FX + 350)) <= 2 && Math.abs(r3.w - 300) <= 3, `with Alt, it stretches from the centre (${r3.x - dims.FX}, ${r3.w} wide)`);
      await undo();
      // Snap: drag the block's left edge near the frame's left edge.
      const reach = 8 / state.view.z;
      pen([[500, 450, 1], [300, 450, 1], [100 + reach * 0.6, 450, 1]]);
      const r4 = contentBounds();
      check(Math.abs(r4.x - dims.FX) <= 1, `moving snaps the edge to the frame (left edge at ${r4.x - dims.FX})`);
      await undo();
      // Shift locks a move to one direction.
      pen([[500, 450, 1], [600, 470, 1], [700, 490, 1]], { shift: true, ctrl: true });
      const r5 = contentBounds();
      check(Math.abs(r5.y - box.y0) <= 1 && Math.abs(r5.x - box.x0 - 200) <= 2, `with Shift, a move stays level (moved ${r5.x - box.x0}, ${r5.y - box.y0})`);
      await undo();
      // Turning: drag the round handle above the box a quarter turn (Shift snaps to 15 degrees).
      const kr = shownCorners();
      const knob = rotateHandle(kr);
      const cen = boxPoint(kr, 0.5, 0.5);
      const rad = Math.hypot(knob.x - cen.x, knob.y - cen.y);
      const fx = (q) => [q.x - dims.FX, q.y - dims.FY, 1];
      check(!!handleAt({ clientX: viewportRect.left + toScreen(knob).x, clientY: viewportRect.top + toScreen(knob).y }) && handleAt({ clientX: viewportRect.left + toScreen(knob).x, clientY: viewportRect.top + toScreen(knob).y }).rotate, 'the Move box has a round turning handle above it');
      pen([fx(knob), fx({ x: cen.x + rad * 0.7, y: cen.y - rad * 0.7 }), fx({ x: cen.x + rad + 3, y: cen.y + 2 })], { shift: true });
      check(alphaAt(F(500, 370)) > 200 && alphaAt(F(500, 530)) > 200 && alphaAt(F(420, 450)) === 0 && alphaAt(F(580, 450)) === 0, 'dragging it turns the layer (a quarter turn, snapped by Shift)');
      await capture('rotate.png');
      await undo();
      // With a lasso selection the piece stays picked up: turn it, then stretch along its turned side.
      setSelection([F(395, 395), F(605, 395), F(605, 505), F(395, 505)]);
      const k2 = shownCorners();
      const knob2 = rotateHandle(k2);
      const c2 = boxPoint(k2, 0.5, 0.5);
      const a30 = -Math.PI / 2 + Math.PI / 6;
      const rr2 = Math.hypot(knob2.x - c2.x, knob2.y - c2.y);
      pen([fx(knob2), fx({ x: c2.x + Math.cos(a30) * rr2, y: c2.y + Math.sin(a30) * rr2 })], { shift: true });
      const turned = lift && lift.rot;
      const right = boxPoint(shownCorners(), 1, 0.5);
      const along = { x: Math.cos(Math.PI / 6), y: Math.sin(Math.PI / 6) };
      const wNow = Math.hypot(shownCorners()[1].x - shownCorners()[0].x, shownCorners()[1].y - shownCorners()[0].y);
      pen([fx(right), fx({ x: right.x + along.x * 100, y: right.y + along.y * 100 })], { ctrl: true });
      const wAfter = Math.hypot(shownCorners()[1].x - shownCorners()[0].x, shownCorners()[1].y - shownCorners()[0].y);
      check(Math.abs(turned - Math.PI / 6) < 1e-6 && Math.abs(lift.rot - Math.PI / 6) < 1e-6 && Math.abs(wAfter - wNow - 100) < 3, `a turned selection stretches along its own side and keeps its angle (${Math.round((turned * 180) / Math.PI)} degrees, ${Math.round(wNow)} to ${Math.round(wAfter)} wide)`);
      deselect();
      await undo();
      await capture('transform.png');
      await deleteShot();
      setColor('#1b1b1f');
      setTool('brush');
    }

    // ---- Move: Distort and Warp
    {
      await addShot();
      setSelection([F(400, 400), F(600, 400), F(600, 500), F(400, 500)]);
      setColor('#000000');
      await paintSelection('fill');
      deselect();
      setTool('move');
      setMoveMode('distort');
      check($('#moveLayer').querySelectorAll('.mesh-handle:not(.mid)').length === 4 && $('#moveLayer').querySelectorAll('.mesh-handle.mid').length === 4 && !!document.querySelector('.seg-btn.active[data-mode="distort"]'), 'Distort shows four corner handles and one in the middle of each edge');
      pen([[600, 400, 1], [650, 375, 1], [700, 350, 1]]);
      check(!$('#meshBar').hidden && meshCanvas.style.display === 'block', 'it previews live, with Apply and Cancel');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      check(alphaAt(F(650, 380)) > 200 && alphaAt(F(410, 410)) > 200 && alphaAt(F(590, 360)) === 0 && !lift && $('#meshBar').hidden, 'dragging one corner distorts the layer, and Enter applies it');
      await capture('distort.png');
      await undo();
      check(alphaAt(F(650, 380)) === 0 && alphaAt(F(590, 410)) > 200, 'one undo puts it back');
      // The middle of an edge moves the whole edge (both its corners), like Photoshop.
      pen([[500, 400, 1], [500, 375, 1], [500, 350, 1]]);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      check(alphaAt(F(410, 360)) > 200 && alphaAt(F(590, 360)) > 200 && alphaAt(F(500, 495)) > 200 && alphaAt(F(500, 345)) === 0, 'dragging the top middle handle raises the whole top edge');
      await undo();
      // Several selected layers bend together, each in its own layer.
      {
        const a = activeLayer();
        await addLayer();
        const b = activeLayer();
        setSelection([F(700, 400), F(800, 400), F(800, 500), F(700, 500)]);
        await paintSelection('fill');
        deselect();
        mounted.selLayers = new Set([a.id, b.id]);
        refreshUI();
        setMoveMode('distort');
        pen([[800, 400, 1], [825, 375, 1], [850, 350, 1]]);
        const previews = [...layerStack.querySelectorAll('canvas.mesh-preview')].length;
        const map = quadMap(lift.pts);
        const nearCorner = map(0.97, 0.06);
        const leftSide = map(0.03, 0.5);
        check(lift && lift.group && previews === 2 && live.get(a.id).style.visibility === 'hidden', `Distort works on several selected layers, previewing each in its place (${previews} previews)`);
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        // The new corner was empty on both layers before: now layer B has ink there, A does not.
        const got = [alphaAt(nearCorner, b.id), alphaAt(nearCorner, a.id), alphaAt(leftSide, a.id)];
        check(got[0] > 200 && got[1] === 0 && got[2] > 200, `Enter bends both layers, each keeping its own drawing (${got.join(', ')}; corner at ${Math.round(nearCorner.x - dims.FX)},${Math.round(nearCorner.y - dims.FY)})`);
        check(!lift && !layerStack.querySelector('canvas.mesh-preview') && live.get(a.id).style.visibility === '', 'and the previews go away');
        await undo();
        check(alphaAt(F(795, 405), b.id) > 200 && alphaAt(F(410, 410), a.id) > 200 && alphaAt(nearCorner, b.id) === 0, 'one undo puts both layers back');
        // Warp too, and Escape puts both back untouched.
        mounted.selLayers = new Set([a.id, b.id]);
        setMoveMode('warp');
        const gp = 400 + 400 / 3; // a point on the top row of the grid
        pen([[gp, 400, 1], [gp, 360, 1], [gp, 320, 1]]);
        state.view.z = 1.2; state.view.x = -(dims.FX + 600) * 1.2 + 640; state.view.y = -(dims.FY + 430) * 1.2 + 330; applyView();
        renderMoveBox();
        await capture('warp-layers.png');
        fitView();
        const bent = lift && lift.group && lift.mode === 'warp';
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await wait(50);
        check(bent && !lift && !layerStack.querySelector('canvas.mesh-preview') && alphaAt(F(795, 405), b.id) > 200 && alphaAt(F(410, 410), a.id) > 200 && alphaAt(F(gp, 340), a.id) === 0, 'Warp bends several layers too, and Escape puts them back untouched');
        setMoveMode('distort');
        mounted.selLayers = new Set();
        mounted.activeLayerId = a.id;
        refreshUI();
      }
      setMoveMode('warp');
      check($('#moveLayer').querySelectorAll('.mesh-handle').length === 16, 'Warp shows a 4 by 4 grid of points');
      const top1 = { x: 400 + 200 / 3, y: 400 };
      pen([[top1.x, top1.y, 1], [top1.x, top1.y - 40, 1], [top1.x, top1.y - 80, 1]]);
      await capture('warp.png');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      check(alphaAt(F(466, 372)) > 200 && alphaAt(F(590, 395)) === 0 && alphaAt(F(500, 495)) > 200, 'dragging a point bends the edge near it and leaves the far side');
      await undo();
      pen([[top1.x, top1.y, 1], [top1.x, top1.y - 80, 1]]);
      $('#meshCancel').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', button: 0, buttons: 1 }));
      check(!!lift && !lift.drag, 'pressing Cancel on the Warp bar does not start a drag');
      $('#meshCancel').dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen', button: 0, buttons: 0 }));
      $('#meshCancel').click();
      await new Promise((r) => setTimeout(r, 50));
      check(!lift && alphaAt(F(466, 372)) === 0 && alphaAt(F(500, 450)) > 200 && meshCanvas.style.display === 'none', 'Escape or Cancel puts it back as it was');
      setMoveMode('free');
      setTool('brush');
      await deleteShot();
      setColor('#1b1b1f');
    }

    // ---- a camera move carries on across a split (animating during a move)
    {
      await addShot();
      const shot = current();
      setDuration(shot, 48);
      setCamera(shot, { start: { x: 0, y: 0, s: 1 }, end: { x: 400, y: 0, s: 1 }, ease: 'smooth' }, null);
      const whole = [0, 0.25, 0.6, 1].map((u) => camAt(shot, u).x);
      state.time = shotStarts()[state.cur] + 12;
      await splitShot();
      const a = state.shots[state.cur];
      const b = state.shots[state.cur + 1];
      const first = state.shots.find((s) => s.camera && s.camera.range && s.camera.range[0] === 0 && s.camera.move);
      const second = state.shots.find((s) => s.camera && s.camera.move === first.camera.move && s !== first);
      const joins = Math.abs(camAt(first, 1).x - camAt(second, 0).x);
      // 60% through the whole move is 7/15 of the way through the second piece (frames 12 to 48).
      const later = Math.abs(camAt(second, (0.6 - 0.25) / 0.75).x - whole[2]);
      check(first.duration === 12 && second.duration === 36 && joins < 1e-6 && Math.abs(camAt(first, 1).x - whole[1]) < 1e-6 && later < 1e-6 && Math.abs(camAt(second, 1).x - 400) < 1e-6,
        `splitting a shot carries its camera move on across the pieces, exactly as before (join gap ${joins.toFixed(4)}, at the cut x ${camAt(first, 1).x.toFixed(1)}, want ${whole[1].toFixed(1)})`);
      void a; void b;
      // Changing the move on one piece changes it on the other.
      const from = structuredClone(second.camera);
      setCamera(second, { ...second.camera, end: { x: 800, y: 0, s: 1 } }, from);
      check(first.camera.end.x === 800 && first.camera.range[1] === 0.25 && Math.abs(camAt(first, 1).x - camAt(second, 0).x) < 1e-6, 'editing the move on one piece keeps the other in step');
      await undo();
      check(first.camera.end.x === 400 && second.camera.end.x === 400, 'and that is one undo step');
      await undo();
      const back = state.shots.find((s) => s.id === first.id);
      check(back.duration === 48 && !back.camera.range && Math.abs(camAt(back, 0.25).x - whole[1]) < 1e-6, 'undoing the split gives the whole move back to one shot');
      await deleteShot();
    }

    // ---- several layers: picked without keys (iPad), and moved up and down together
    {
      await addShot();
      const l1 = activeLayer();
      await addLayer();
      const l2 = activeLayer();
      await addLayer();
      const l3 = activeLayer();
      setInspectorTab('layers');
      const rowOf2 = (l) => [...document.querySelectorAll('#layers li')].find((li) => li.dataset.layerId === l.id);
      const press = (l) => rowOf2(l).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', button: 0, buttons: 1 }));
      press(l1);
      $('#layerMulti').click();
      press(l2);
      const picked = selectedLayers().map((l) => l.id);
      check(state.multiLayers && picked.length === 2 && picked.includes(l1.id) && picked.includes(l2.id) && !!document.querySelector('#mergeLayers:not([hidden])'), 'with Select several on, a plain tap adds a layer to the selection (no Ctrl needed)');
      await moveLayer(1);
      const order = mounted.layers.map((l) => l.id);
      check(order.join() === [l3.id, l1.id, l2.id].join(), 'the up arrow moves every selected layer up together, keeping their order');
      await moveLayer(1);
      check(mounted.layers.map((l) => l.id).join() === order.join(), 'and they stop at the top');
      await moveLayer(-1);
      check(mounted.layers.map((l) => l.id).join() === [l1.id, l2.id, l3.id].join(), 'the down arrow brings them back down');
      $('#layerMulti').click();
      press(l3);
      check(!state.multiLayers && selectedLayers().length === 1, 'turning it off goes back to one layer at a time');
      setInspectorTab('tool');
      await deleteShot();
    }

    // ---- memory: long sessions on big canvases must not run the graphics memory out
    {
      // Undo keeps to a budget: twenty whole-layer steps on a 5120 x 2160 canvas (88 MB each) do not all stay.
      const before = history.undo.length;
      let closed = 0;
      const fake = () => ({ type: 'pixels', shotId: 'none', layerId: 'none', x: 0, y: 0, w: 5120, h: 2160, before: Promise.resolve({ close() { closed++; } }), after: Promise.resolve({ close() { closed++; } }) });
      const made = [];
      for (let k = 0; k < 20; k++) { const e = fake(); made.push(e); pushHistory(e); }
      await wait(20);
      const kept = made.filter((e) => history.undo.includes(e)).length;
      check(historyBytes() <= HISTORY_BYTES && kept >= 10 && kept < 20 && history.undo[history.undo.length - 1] === made[19] && closed > 0,
        `undo history keeps to a memory budget: of 20 whole-layer steps on a 5120 x 2160 canvas, the newest ${kept} stay (${Math.round(historyBytes() / 1048576)} MB of ${Math.round(HISTORY_BYTES / 1048576)} MB)`);
      for (const e of made) { const i = history.undo.indexOf(e); if (i >= 0) history.undo.splice(i, 1); }
      void before;
      // The scrub previews keep to a budget too, letting go of the furthest shots.
      const limit = scrubLimit();
      const real = new Map(scrubFrames);
      for (let k = 0; k < limit + 12; k++) scrubFrames.set(`fake${k}`, { key: '', entry: { promise: Promise.resolve({ ready: null }) } });
      trimScrubFrames();
      const within = scrubFrames.size <= limit;
      for (const id of [...scrubFrames.keys()]) if (id.startsWith('fake')) scrubFrames.delete(id);
      for (const [id, v] of real) if (!scrubFrames.has(id)) scrubFrames.set(id, v);
      check(within && limit >= 8, `scrub previews keep to a memory budget (${limit} shots at this canvas size)`);
      // A drawing that cannot be decoded says what to do, and a good one still loads.
      let message = '';
      try { await decodeDrawing(new Blob(['not a picture'], { type: 'image/png' })); } catch (err) { message = err.message; }
      const tiny = new OffscreenCanvas(8, 8);
      tiny.getContext('2d').fillRect(0, 0, 8, 8);
      const good = await decodeDrawing(await tiny.convertToBlob());
      check(message.includes('not damaged') && message.includes('save') && good.width === 8, 'a drawing that cannot be loaded says the board is not damaged and what to do');
      good.close();
    }

    // ---- layer blend modes
    {
      await addShot();
      const base = activeLayer();
      setColor('#0000c0');
      setSelection([F(300, 300), F(700, 300), F(700, 600), F(300, 600)]);
      await paintSelection('fill');
      deselect();
      await addLayer();
      const top = activeLayer();
      setColor('#c00000');
      setSelection([F(500, 400), F(900, 400), F(900, 700), F(500, 700)]);
      await paintSelection('fill');
      deselect();
      $('#layerBlend').value = 'glow';
      $('#layerBlend').dispatchEvent(new Event('change'));
      const css = live.get(top.id).style.mixBlendMode;
      const off = await renderRegion(mounted, { x: dims.FX, y: dims.FY, w: dims.W, h: dims.H }, dims.W, dims.H);
      const px = (x, y) => [...off.getContext('2d').getImageData(x, y, 1, 1).data];
      const both = px(600, 500);
      const onlyTop = px(800, 650);
      check(top.blend === 'glow' && css === 'plus-lighter' && both[0] > 150 && both[2] > 150 && onlyTop[0] > 150 && onlyTop[1] > 150, `a Glow layer adds its light to what is under it, on screen and in playback (overlap ${both.slice(0, 3)}, over white paper ${onlyTop.slice(0, 3)})`);
      // Overlay: light grey over mid grey lightens it (pure white would make it white).
      setColor('#808080');
      mounted.activeLayerId = base.id;
      setSelection([F(1000, 300), F(1400, 300), F(1400, 600), F(1000, 600)]);
      await paintSelection('fill');
      deselect();
      mounted.activeLayerId = top.id;
      setColor('#c0c0c0');
      setSelection([F(1100, 300), F(1400, 300), F(1400, 600), F(1100, 600)]);
      await paintSelection('fill');
      deselect();
      top.blend = 'overlay';
      layoutStack();
      const off2 = await renderRegion(mounted, { x: dims.FX, y: dims.FY, w: dims.W, h: dims.H }, dims.W, dims.H);
      const ov = [...off2.getContext('2d').getImageData(1200, 450, 1, 1).data];
      check(ov[0] > 170 && ov[0] < 215 && live.get(top.id).style.mixBlendMode === 'overlay', `an Overlay layer lightens what is under it (light grey over mid grey: ${ov.slice(0, 3)}, expected about 191)`);
      const json = JSON.stringify(await serialize());
      check(/"blend":"overlay"/.test(json), 'the blend mode is saved with the layer');
      setColor('#1b1b1f');
      await deleteShot();
    }

    // ---- timeline: clip ends snap to the playhead; zoom keys
    {
      const shot = state.shots[state.cur];
      const start = shotStarts()[state.cur];
      state.time = start + shot.duration + 7;
      placePlayhead();
      renderTimeline();
      const clipEl = tl.clipEls.get(shot.id);
      const trim = clipEl.querySelector('.trim-r');
      const tr = trim.getBoundingClientRect();
      const cr = tl.content.getBoundingClientRect();
      const playX = cr.left + frameToX(state.time);
      const tp = (kind, x, extra = {}) => new PointerEvent(kind, { pointerId: 21, bubbles: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1, clientX: x, clientY: tr.top + tr.height / 2, ...extra });
      const dur0 = shot.duration;
      trim.dispatchEvent(tp('pointerdown', tr.left + tr.width / 2));
      clipEl.dispatchEvent(tp('pointermove', playX - 5));
      const lineShown = snapLine.style.display === 'block';
      clipEl.dispatchEvent(tp('pointerup', playX - 5));
      check(shotStarts()[state.cur] + shot.duration === state.time && lineShown, `stretching a clip snaps its end to the playhead, with a line (${dur0} to ${shot.duration} frames)`);
      await undo();
      const ppf0 = tl.ppf;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true }));
      const zoomedIn = tl.ppf;
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '-', bubbles: true }));
      check(zoomedIn > ppf0 * 1.3 && Math.abs(tl.ppf - ppf0) < 1e-6, `= and - zoom the timeline in and out (${ppf0.toFixed(2)} to ${zoomedIn.toFixed(2)} px per frame)`);
      tl.scroll.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, altKey: true, clientX: cr.left + 200, bubbles: true, cancelable: true }));
      check(tl.ppf > ppf0, 'Alt + scroll zooms the timeline too');
      window.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(92), bubbles: true }));
    }

    // ---- the right panel: one tab at a time
    {
      const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
      check(document.querySelectorAll('#tabs .tab').length === 3, 'the right panel has Brush (with Color), Layers and Shot tabs');
      document.querySelector('#tabs .tab[data-tab="layers"]').click();
      check(shown('secLayers') && !shown('secTool') && !shown('secColor') && !shown('secShot'), 'a tab shows only its own section');
      await capture('tab-layers.png');
      setTool('perspective');
      check(shown('secTool') && $('#tabToolName').textContent === 'Grid', 'picking a tool opens its settings, and the tab is named after it');
      setTool('brush');
      $('#railColor').click();
      check(shown('secColor') && shown('secTool') && $('#railColor').style.background !== '', 'brush and colour share a tab, and the rail swatch opens it');
      await capture('tab-color.png');
      $('#adjustBtn').click();
      check(!$('#adjustMenu').hidden && $('#adjustMenu').querySelectorAll('.menu-item').length === 5, 'the Adjust menu in the top bar lists Hue/Saturation/Brightness, the three blurs and Glow');
      await capture('adjust-menu.png');
      document.querySelector('#adjustMenu [data-blur="gaussian"]').click();
      check($('#adjustMenu').hidden && !!filter, 'picking one opens it and closes the menu');
      closeFilter(false);
      document.querySelector('#tabs .tab[data-tab="tool"]').click();
    }

    // ---- several layers: select, move together, merge
    {
      await addShot();
      brushSetup('ink', { size: 20, opacity: 1 });
      setColor('#ff0000');
      pen([[500, 500, 1], [501, 500, 1]]);
      await addLayer();
      setColor('#0000ff');
      pen([[700, 500, 1], [701, 500, 1]]);
      const [l1, l2] = mounted.layers;
      const rows = () => [...document.querySelectorAll('#layers li:not(.ref-row)')];
      rows()[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, shiftKey: true }));
      check(selectedLayers().length === 2 && !$('#mergeLayers').hidden && rows().every((r) => r.classList.contains('selected')), 'Shift-click selects a run of layers, and Merge appears');
      setTool('move');
      check(!!shownRect() && Math.abs(shownRect().x1 - shownRect().x0 - 220) < 6, `the Move box wraps both layers (${shownRect() && Math.round(shownRect().x1 - shownRect().x0)} wide)`);
      pen([[600, 700, 1], [650, 700, 1], [700, 700, 1]], { ctrl: true });
      check(alphaAt(F(600, 500), l1.id) > 200 && alphaAt(F(800, 500), l2.id) > 200 && alphaAt(F(500, 500), l1.id) === 0, 'Move drags all the selected layers together');
      await undo();
      check(alphaAt(F(500, 500), l1.id) > 200 && alphaAt(F(700, 500), l2.id) > 200 && alphaAt(F(600, 500), l1.id) === 0, 'one undo puts them all back');
      rows()[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ctrlKey: true }));
      check(selectedLayers().length === 1, 'Ctrl-click takes a layer out of the selection');
      rows()[0].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, ctrlKey: true }));
      await mergeLayers();
      check(mounted.layers.length === 1 && alphaAt(F(500, 500)) > 200 && alphaAt(F(700, 500)) > 200, 'Merge combines the selected layers into one');
      await capture('merged.png');
      await undo();
      check(mounted.layers.length === 2 && mounted.layers[0].id === l1.id && mounted.layers[1].id === l2.id && alphaAt(F(700, 500), l2.id) > 200, 'one undo splits them again');
      // The eye, pressed and released like a real pen, on the current layer and another one.
      const press = (node) => { node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen' })); node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen' })); node.click(); };
      const eyeOf = (i) => rows()[i].querySelector('.eye');
      press(eyeOf(0));
      const topHidden = !mounted.layers[1].visible;
      press(eyeOf(1));
      check(topHidden && !mounted.layers[0].visible, 'the eye hides a layer when pressed, on the current layer and on others');
      press(eyeOf(0));
      press(eyeOf(1));
      check(mounted.layers.every((l) => l.visible), 'and shows it again');
      // Double-press a layer that is not the current one, type a name, press Enter.
      setInspectorTab('layers');
      const other = mounted.layers.find((l) => l.id !== mounted.activeLayerId);
      const rowOf = (l) => document.querySelector(`#layers li[data-layer-id="${l.id}"]`);
      for (let k = 0; k < 2; k++) {
        rowOf(other).querySelector('.name').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen' }));
        window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen' }));
      }
      const box = rowOf(other).querySelector('input.name');
      check(!!box && document.activeElement === box, 'double-clicking a layer name opens it for renaming');
      if (box) {
        box.value = 'Background';
        box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      check(other.name === 'Background' && rowOf(other).querySelector('span.name').textContent === 'Background', 'and Enter keeps the new name');
      await capture('layers-renamed.png');
      setInspectorTab('tool');
      await deleteShot();
      setTool('brush');
      setColor('#1b1b1f');
    }

    // ---- if the graphics chip resets, the pencils still draw (2D stamps)
    {
      await addShot();
      const saved = pencilEngine;
      pencilEngine = null;
      Object.assign(state.brushes.apencil, BRUSH_PRESETS.find((b) => b.id === 'apencil'));
      setBrush('apencil');
      pen(Array.from({ length: 40 }, (_, k) => [300 + k * 8, 400, 1]));
      let a = 0;
      for (let dy = -5; dy <= 5; dy++) a = Math.max(a, alphaAt(F(460, 400 + dy)));
      pencilEngine = saved;
      check(a > 0, `with the GPU unavailable the animator pencil still draws (${a})`);
      await deleteShot();
    }

    // ---- GPU pencils keep to a lasso selection while drawing, not only after
    {
      await addShot();
      Object.assign(state.brushes.apencil, BRUSH_PRESETS.find((b) => b.id === 'apencil'));
      setBrush('apencil');
      setSelection([F(400, 300), F(600, 300), F(600, 500), F(400, 500)]);
      pen(Array.from({ length: 60 }, (_, k) => [300 + k * 7, 400, 1]), { lift: false });
      renderLive(stroke);
      const shown = (fx, fy) => {
        const p = F(fx, fy);
        const W = stroke.gpu && stroke.gpu.win;
        if (!W) return -1;
        let m = 0;
        const c = new OffscreenCanvas(1, 9);
        c.getContext('2d').drawImage(pencilCanvas, Math.round(p.x) - W.ox, Math.round(p.y) - W.oy - 4, 1, 9, 0, 0, 1, 9);
        const d = c.getContext('2d').getImageData(0, 0, 1, 9).data;
        for (let k = 3; k < d.length; k += 4) m = Math.max(m, d[k]);
        return m;
      };
      const liveOut = shown(350, 400);
      const liveIn = shown(500, 400);
      viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'pen', bubbles: true, button: 0, buttons: 0 }));
      let outside = 0;
      let inside = 0;
      for (let dy = -4; dy <= 4; dy++) { outside = Math.max(outside, alphaAt(F(350, 400 + dy))); inside = Math.max(inside, alphaAt(F(500, 400 + dy))); }
      check(liveIn > 0 && liveOut === 0, `the animator pencil keeps to the selection while drawing (${liveIn} inside, ${liveOut} outside)`);
      check(inside > 0 && outside === 0, `and once drawn (${inside} inside, ${outside} outside)`);
      deselect();
      await deleteShot();
    }

    // ---- the line reaches the pen while drawing (no trailing gap)
    {
      await addShot();
      const reach = (id) => {
        brushSetup(id, {});
        Object.assign(brush(), BRUSH_PRESETS.find((b) => b.id === id));
        const pts = Array.from({ length: 12 }, (_, k) => [300 + k * 30, 400 + Math.sin(k / 3) * 40, 0.8]);
        pen(pts, { lift: false });
        renderLive(stroke);
        const [px, py] = pts[pts.length - 1];
        const p = F(px - 4, py);
        const inked = (x, y) => {
          const L = stroke.live;
          const live = L && x >= L.ox && y >= L.oy && x < L.ox + L.size && y < L.oy + L.size ? liveCtx.getImageData(Math.round(x - L.ox), Math.round(y - L.oy), 1, 1).data[3] : 0;
          // GPU pencils show on their own canvas.
          let gpu = 0;
          if (stroke.gpu && stroke.gpu.win) {
            const c = new OffscreenCanvas(1, 1);
            c.getContext('2d').drawImage(pencilCanvas, Math.round(x) - stroke.gpu.win.ox, Math.round(y) - stroke.gpu.win.oy, 1, 1, 0, 0, 1, 1);
            gpu = c.getContext('2d').getImageData(0, 0, 1, 1).data[3];
          }
          return Math.max(live, gpu, strokeCtx.getImageData(Math.round(x), Math.round(y), 1, 1).data[3]);
        };
        let near = 0;
        for (let dy = -4; dy <= 4; dy++) near = Math.max(near, inked(p.x, p.y + dy));
        const tail = tailPoints(stroke).length;
        viewport.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, pointerType: 'pen', bubbles: true, button: 0, buttons: 0 }));
        return { near, tail };
      };
      for (const id of ['gink', 'apencil', 'ink']) {
        const r = reach(id);
        check(r.near > 0 && r.tail > 2, `${id}: while drawing, the line reaches the pen along its path (ink ${r.near} at the tip, ${r.tail} tail points)`);
      }
      await deleteShot();
      brushSetup('ink', {});
      Object.assign(brush(), BRUSH_PRESETS.find((b) => b.id === 'ink'));
    }

    // ---- copy and paste layers between shots
    {
      await addShot();
      const from = state.cur;
      brushSetup('ink', { size: 20, opacity: 1 });
      setColor('#ff0000');
      pen([[500, 500, 1], [501, 500, 1]]);
      await addLayer();
      setColor('#0000ff');
      pen([[700, 500, 1], [701, 500, 1]]);
      mounted.layers[1].name = 'Lineart';
      mounted.layers[1].opacity = 0.5;
      mounted.selLayers = new Set(mounted.layers.map((l) => l.id));
      refreshUI();
      const key = (k) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, bubbles: true }));
      key('c');
      await enqueue(async () => {});
      await addShot();
      const before = mounted.layers.length;
      key('v');
      await enqueue(async () => {});
      const pasted = mounted.layers.slice(-2);
      check(mounted.layers.length === before + 2 && pasted[1].name === 'Lineart' && pasted[1].opacity === 0.5 && alphaAt(F(500, 500), pasted[0].id) > 200 && alphaAt(F(700, 500), pasted[1].id) > 200,
        'Ctrl+C and Ctrl+V copy layers into another shot, in place, with their names and opacity');
      check(selectedLayers().length === 2, 'the pasted layers come in selected together');
      await undo();
      check(mounted.layers.length === before, 'one undo takes the paste away');
      await selectShot(from);
      mounted.selLayers = new Set();
      setSelection([F(650, 450), F(700, 450), F(700, 550), F(650, 550)]);
      $('#copyLayers').click();
      await enqueue(async () => {});
      deselect();
      await selectShot(from + 1);
      $('#pasteLayers').click();
      await enqueue(async () => {});
      const part = activeLayer();
      check(alphaAt(F(690, 500), part.id) > 200 && alphaAt(F(712, 500), part.id) === 0, 'with a lasso selection, only the selected part is copied');
      await deleteShot();
      await selectShot(from);
      await deleteShot();
      setColor('#1b1b1f');
    }

    // ---- Fill with the lasso tool still selected (both Fill buttons)
    {
      await addShot();
      setColor('#000000');
      setTool('lasso');
      pen([[400, 400, 1], [600, 400, 1], [600, 600, 1], [400, 600, 1], [400, 401, 1]]);
      const press = (node) => {
        node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', button: 0, buttons: 1, pressure: 0.5 }));
        node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen', button: 0, buttons: 0 }));
        node.click();
      };
      press($('#selFill'));
      await enqueue(async () => {});
      check(!!state.selection && alphaAt(F(500, 500)) > 200, 'Fill on the selection bar fills, with the lasso tool still on');
      await undo();
      const panelFill = [...$('#secTool').querySelectorAll('button')].find((b) => b.textContent === 'Fill');
      press(panelFill);
      await enqueue(async () => {});
      check(alphaAt(F(500, 500)) > 200, 'Fill in the Lasso panel fills too');
      deselect();
      await deleteShot();
      setTool('brush');
      setColor('#1b1b1f');
    }

    // ---- sliders follow a pen directly
    {
      const sl = $('#railSize');
      const r = sl.getBoundingClientRect();
      const pe = (kind, y) => new PointerEvent(kind, { pointerId: 31, pointerType: 'pen', bubbles: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1, pressure: 0.5, clientX: r.left + r.width / 2, clientY: y });
      const size0 = brush().size;
      sl.dispatchEvent(pe('pointerdown', r.bottom - 8));
      const low = brush().size;
      sl.dispatchEvent(pe('pointermove', r.top + r.height / 2));
      const mid = brush().size;
      sl.dispatchEvent(pe('pointermove', r.top + 8));
      const high = brush().size;
      sl.dispatchEvent(pe('pointerup', r.top + 8));
      check(low < mid && mid < high, `the size slider follows the pen from where it touches (${low}, ${mid}, ${high})`);
      setSize(size0);
    }

    // ---- 0 fits the view again (it had been taken by brush presets)
    state.view.z = 2.5;
    applyView();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true }));
    check(state.view.fit === true, '0 fits the frame to the screen');

    // ---- cursor and zoom feel
    fitView();
    const vr0 = viewport.getBoundingClientRect();
    const hover = () => viewport.dispatchEvent(new PointerEvent('pointermove', { pointerId: 13, pointerType: 'pen', bubbles: true, button: -1, buttons: 0, clientX: vr0.left + vr0.width / 2, clientY: vr0.top + vr0.height / 2 }));
    brushSetup('ink', { size: 30 });
    hover();
    check(/image-set/.test(viewport.style.cursor) && cursorRing.style.display === 'none', 'the brush outline is the system cursor, so it never trails the pen');
    setSize(2000 / state.view.z);
    check(cursorRing.style.display === 'block' && viewport.style.cursor === 'crosshair', 'brushes too big for a system cursor show a ring and a crosshair');
    setSize(30);
    check(/image-set/.test(viewport.style.cursor) && cursorRing.style.display === 'none', 'and the outline follows size changes without the pen moving');
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }));
    check(viewport.style.cursor === '' && getComputedStyle(viewport).cursor === 'grab', `holding Space shows the hand (${getComputedStyle(viewport).cursor})`);
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Space', key: ' ', bubbles: true }));
    check(/image-set/.test(viewport.style.cursor), 'and letting go brings the brush outline back');
    const z0 = state.view.z;
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, altKey: true, clientX: vr0.left + vr0.width / 2, clientY: vr0.top + vr0.height / 2, bubbles: true, cancelable: true }));
    const zNow = state.view.z;
    await wait(400);
    const zEnd = state.view.z;
    const want = z0 * Math.exp(0.15);
    check(zNow < want - 0.001 && Math.abs(zEnd - want) < want * 0.002, `a wheel notch glides to the new zoom (${z0.toFixed(3)} to ${zEnd.toFixed(3)}, at once ${zNow.toFixed(3)})`);
    fitView();
    // The rest of Photoshop's wheel: plain scroll moves up and down, Ctrl moves sideways.
    const viewBefore = { ...state.view };
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, clientX: vr0.left + 50, clientY: vr0.top + 50, bubbles: true, cancelable: true }));
    const afterScroll = { ...state.view };
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, clientX: vr0.left + 50, clientY: vr0.top + 50, bubbles: true, cancelable: true }));
    check(afterScroll.y === viewBefore.y - 100 && afterScroll.x === viewBefore.x && afterScroll.z === viewBefore.z && state.view.x === viewBefore.x - 100 && state.view.z === viewBefore.z,
      'scrolling moves the canvas up and down, Ctrl + scroll moves it sideways, neither zooms');
    viewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -3.5, ctrlKey: true, clientX: vr0.left + 300, clientY: vr0.top + 300, bubbles: true, cancelable: true }));
    check(state.view.z > viewBefore.z, 'a trackpad pinch still zooms');
    fitView();
    viewport.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 13, pointerType: 'pen' }));
    openRadial();
    check(!!radial && document.querySelectorAll('#radial .slice').length === RADIAL.length, 'Tab opens the brush and tool wheel');
    radial.hovered = RADIAL.findIndex((r) => r.label === 'Oval nib');
    closeRadial();
    check(state.brushId === 'nib' && !radial, 'letting go over a slice switches to it');
    setBrush('ink');
    const easeShot = { camera: { start: { x: 0, y: 0, s: 1 }, end: { x: 100, y: 0, s: 1 }, ease: 'linear' } };
    check(Math.abs(camAt(easeShot, 0.25).x - 25) < 0.01, 'constant-speed camera moves evenly');
    easeShot.camera.ease = 'in';
    check(camAt(easeShot, 0.25).x < 10, 'slow-start camera starts gently');

    // ---- perspective grid
    setTool('perspective');
    const gshot = current();
    check(!!gshot.grid && document.querySelectorAll('#gridLayer .grid-handle').length === 9, 'perspective tool adds a grid with 4 corner and 5 bend handles');
    const gmap = gridMap(gshot.grid);
    const fc = frameCenter();
    const c0 = gmap(0, 0);
    const c2 = gmap(1, 1);
    check(Math.abs(c0.x - (gshot.grid.corners[0].x + fc.x)) < 1e-6 && Math.abs(c2.y - (gshot.grid.corners[2].y + fc.y)) < 1e-6, 'grid corners land exactly on the handles');
    const inv = gridInverse(gmap, gmap(0.3, 0.7));
    check(Math.abs(inv.u - 0.3) < 1e-4 && Math.abs(inv.v - 0.7) < 1e-4, 'canvas points map back onto the grid');
    check(vanishingPoints(gshot.grid).length >= 1 && !!document.querySelector('.grid-horizon'), 'the horizon and vanishing point show');

    // Drag a corner with the pointer, then undo.
    const handle = document.querySelector('.grid-handle.corner[data-key="2"]');
    const hb = handle.getBoundingClientRect();
    const before2 = { ...gshot.grid.corners[2] };
    const gp = (kind, x, y) => new PointerEvent(kind, { pointerId: 12, bubbles: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1, clientX: x, clientY: y });
    handle.dispatchEvent(gp('pointerdown', hb.left + 6, hb.top + 6));
    window.dispatchEvent(gp('pointermove', hb.left + 66, hb.top + 26));
    window.dispatchEvent(gp('pointerup', hb.left + 66, hb.top + 26));
    const moved = gshot.grid.corners[2];
    check(Math.abs(moved.x - before2.x - 60 / state.view.z) < 1 && Math.abs(moved.y - before2.y - 20 / state.view.z) < 1, 'dragging a corner stretches the perspective');
    await undo();
    check(Math.abs(gshot.grid.corners[2].x - before2.x) < 1e-6, 'undo puts the corner back');
    const gs = (kind, x, y) => new PointerEvent(kind, { pointerId: 12, bubbles: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1, clientX: x, clientY: y, shiftKey: true });
    const hb2 = document.querySelector('.grid-handle.corner[data-key="2"]').getBoundingClientRect();
    document.querySelector('.grid-handle.corner[data-key="2"]').dispatchEvent(gs('pointerdown', hb2.left + 6, hb2.top + 6));
    window.dispatchEvent(gs('pointermove', hb2.left + 66, hb2.top + 26));
    window.dispatchEvent(gs('pointerup', hb2.left + 66, hb2.top + 26));
    const straight = gshot.grid.corners[2];
    check(Math.abs(straight.y - before2.y) < 1e-6 && straight.x - before2.x > 50, `with Shift, a grid corner moves along a straight line (moved ${Math.round(straight.x - before2.x)}, ${Math.round(straight.y - before2.y)})`);
    await undo();

    // Bend the top edge: its middle moves, its ends do not.
    const flatTop = gridMap(gshot.grid)(0.5, 0);
    updateGrid({ bends: { ...gshot.grid.bends, top: { x: 0, y: -80 } } });
    const bentMap = gridMap(gshot.grid);
    check(Math.abs(bentMap(0.5, 0).y - (flatTop.y - 80)) < 1e-6 && Math.abs(bentMap(0, 0).y - c0.y) < 1e-6, 'bending curves the edge between fixed corners');

    // Drawing the grid onto a layer: lines become pixels, cells stay empty.
    const layersBeforeStamp = mounted.layers.length;
    await stampGrid();
    const gridLayerObj = mounted.layers.find((l) => l.name === 'Grid');
    const gm = gridMap(gshot.grid);
    const onLine = gm(0.25, 0.5); // column 2 of 8
    const inCell = gm(0.1875, 0.4375); // middle of a cell
    check(mounted.layers.length === layersBeforeStamp + 1 && gridLayerObj && alphaAt(onLine, gridLayerObj.id) > 0 && alphaAt(inCell, gridLayerObj.id) === 0, 'Draw onto canvas puts the grid down as real lines on a new layer');
    // Points on the left and top edges between grid lines (inner lines end at the edges).
    const edgeMid = gm(0, 0.5625);
    const topMid = gm(0.5625, 0);
    check(alphaAt(edgeMid, gridLayerObj.id) === 0 && alphaAt(topMid, gridLayerObj.id) === 0, 'the drawn grid has no border, just the inner lines');
    check(!gshot.grid.visible && state.tool === 'brush' && !gridLayer.children.length, 'and hides the guide, so the new layer opacity is what shows');
    setTool('perspective');
    gshot.grid.visible = false;
    renderGrid();
    await capture('gridstamp.png');
    state.gridBorder = true;
    await stampGrid();
    const bordered = mounted.layers.find((l) => l.name === 'Grid' && l.id !== gridLayerObj.id);
    check(!!bordered && alphaAt(edgeMid, bordered.id) > 0, 'and the Include border switch puts the edges back');
    await undo();
    state.gridBorder = false;
    setTool('perspective');
    gshot.grid.visible = false;
    gshot.grid.visible = true;
    await undo();
    check(mounted.layers.length === layersBeforeStamp, 'undo removes the drawn grid layer');
    await redo();
    const redone = mounted.layers.find((l) => l.name === 'Grid');
    check(redone && alphaAt(onLine, redone.id) > 0, 'redo brings the drawn grid back');
    await undo();

    // Snapping: a wobbly stroke along a row lands on the curved grid row.
    setTool('brush');
    setBrush('ink');
    brush().size = 6;
    state.gridSnap = true;
    const row = (u) => bentMap(u, 0.25);
    const wobble = Array.from({ length: 60 }, (_, i) => {
      const t = i / 59;
      const q = row(0.2 + 0.6 * t);
      return [q.x - dims.FX + Math.sin(t * 20) * 6, q.y - dims.FY + Math.cos(t * 17) * 6, 1];
    });
    pen(wobble);
    // Snapping follows the grid line through where the stroke starts.
    const startPt = { x: dims.FX + wobble[0][0], y: dims.FY + wobble[0][1] };
    const vStart = gridInverse(bentMap, startPt).v;
    const midRow = bentMap(0.5, vStart);
    check(alphaAt(midRow) > 0, 'snapped stroke lies on the grid line through its start');
    const chordMid = (bentMap(0.2, vStart).y + bentMap(0.8, vStart).y) / 2;
    check(chordMid - midRow.y > 10 && alphaAt({ x: midRow.x, y: chordMid }) === 0, `and follows its curve, not a straight line (bulges ${(chordMid - midRow.y).toFixed(0)}px)`);
    check(alphaAt({ x: midRow.x, y: midRow.y - 12 }) === 0 && alphaAt({ x: midRow.x, y: midRow.y + 12 }) === 0, 'the pen wobble is gone');
    await undo();
    state.gridSnap = false;
    setTool('perspective');
    await capture('grid.png');
    removeGrid();
    setTool('brush');

    // ---- eyedropper
    const shotNow = mounted;
    await pickColor(F(150, 150));
    check(state.color === '#1b1b1f' && mounted === shotNow, `eyedropper picks the colour under the pen (picked ${state.color}, same shot ${mounted === shotNow}, pixel ${pixelAt(F(150, 150)).join('/')})`);
    setColor('#d94a3d');
    await pickColor(F(1000, 900));
    check(state.color === '#ffffff', 'eyedropper on empty paper picks white');
    setColor('#1b1b1f');

    // ---- shots and timeline
    check(state.shots.length === 4 && document.querySelectorAll('.clip').length === 4, 'timeline shows one clip per shot');
    const clip = document.querySelectorAll('.clip')[state.cur];
    const trim = clip.querySelector('.trim-r');
    const tr = trim.getBoundingClientRect();
    const before = current().duration;
    const pe = (kind, x) => new PointerEvent(kind, { pointerId: 9, bubbles: true, button: 0, buttons: kind === 'pointerup' ? 0 : 1, clientX: x, clientY: tr.top + 10 });
    trim.dispatchEvent(pe('pointerdown', tr.left + 4));
    clip.dispatchEvent(pe('pointermove', tr.left + 4 + tl.ppf * 12));
    clip.dispatchEvent(pe('pointerup', tr.left + 4 + tl.ppf * 12));
    check(current().duration === before + 12, `dragging a clip edge makes the shot longer (${before} to ${current().duration} frames)`);
    await undo();
    check(current().duration === before, 'undo restores the shot length');

    const firstId = state.shots[0].id;
    await moveShot(0, 2);
    check(state.shots[2].id === firstId, 'shots reorder');
    await undo();
    check(state.shots[0].id === firstId, 'undo puts the shot back');

    // ---- camera
    await selectShot(0);
    toggleCamera();
    check(!!current().camera && document.querySelectorAll('.cam-box').length === 2, 'camera move shows Start and End frames');
    current().camera.end = { x: 300, y: 0, s: 0.5 };
    const mid = camAt(current(), 0.5);
    check(Math.abs(mid.x - 150) < 1 && Math.abs(mid.s - 0.75) < 0.01, 'camera eases halfway between Start and End');
    await capture('editor.png');

    // ---- audio
    await loadAudio(makeWav(3), 'tone.wav', 'audio/wav', 6);
    check(state.audio && state.audio.peaks.length > 100 && document.querySelector('.audio-clip'), 'audio loads and shows a waveform');

    // ---- canvas size
    const thumbsInked = state.shots.every((s) => s.thumb);
    check(thumbsInked, 'every shot has a thumbnail');
    await selectShot(0);
    await resizeCanvas(1280, 720, 24);
    check(dims.W === 1280 && dims.H === 720, 'canvas resizes');
    check(alphaAt(F(950 - 320, 540 - 180)) > 0, 'drawings stay centred after resizing');
    await resizeCanvas(1920, 1080, 24);

    // ---- save and reopen
    const shotCount = state.shots.length;
    // Every shot has its timeline picture by now, and it is saved with the board.
    for (let k = 0; k < 100 && !state.shots.every((s) => s.thumbPng); k++) await wait(100);
    const json = JSON.stringify(await enqueue(serialize));
    await enqueue(() => loadData(JSON.parse(json), null));
    const savedThumbs = JSON.parse(json).shots.filter((s) => typeof s.thumb === 'string' && s.thumb.length > 100).length;
    check(savedThumbs === shotCount && state.shots.every((s) => s.thumbUrl && s.thumbUrl.startsWith('data:image/png;base64,')) && !thumbQueue.length,
      `timeline pictures are saved with the board and shown at once when it opens, none redrawn (${savedThumbs} of ${shotCount})`);
    check(state.shots.length === shotCount, `save and reopen keeps ${shotCount} shots (${Math.round(json.length / 1024)} KB file)`);
    check(alphaAt(F(950, 540)) > 0, 'reopened shot 1 has its drawing');
    check(!!state.shots[0].camera && state.audio && state.audio.offset === 6, 'camera move and audio survive save and reopen');
    // A real project file on disk, for checking that opening a .sboard file
    // with the app loads it (scripts in the README: --launch-check).
    const savedTo = await window.api.saveProject(`${await window.api.selftestTempDir()}\\launch-test.sboard`, json);
    check(!!savedTo, `a project saves to disk (${savedTo})`);
    // Autosave waits for a pause in drawing.
    const T = 1e7;
    check(!autosaveDue(T, T - 100, T - AUTOSAVE_MS - 1) && autosaveDue(T, T - AUTOSAVE_IDLE_MS, T - AUTOSAVE_MS - 1) && autosaveDue(T, T - 10, T - AUTOSAVE_LATEST_MS) && !autosaveDue(T, T - 1e6, T - 1000),
      'autosave waits until the pen has been still, but never longer than ten minutes');
    // The quick save path writes exactly what the full one does.
    const quickPath = `${await window.api.selftestTempDir()}\\quick-save.sboard`;
    sentParts = new WeakMap();
    await writeProject(quickPath);
    const firstParts = lastSaveParts;
    const onDisk = await window.api.selftestReadFile(quickPath);
    const full = JSON.stringify(await enqueue(serialize));
    check(onDisk === full, `saving writes exactly the same file as before (${Math.round(onDisk.length / 1024)} KB, ${firstParts} drawings sent)`);
    await writeProject(quickPath);
    check(lastSaveParts === 0 && (await window.api.selftestReadFile(quickPath)) === full, `saving again with no changes sends nothing and the file stays the same (${lastSaveParts} sent)`);
    pen([[900, 300, 1], [1000, 320, 1]]);
    await writeProject(quickPath);
    const afterEdit = await window.api.selftestReadFile(quickPath);
    check(lastSaveParts === 1 && afterEdit === JSON.stringify(await enqueue(serialize)), `after one stroke, only that drawing is sent and the file matches (${lastSaveParts} sent)`);
    // Opening a file: read in pieces (never as one string, which caps a board
    // at about 512 MB), the drawings arriving as bytes.
    {
      const opened = await window.api.selftestOpen(quickPath);
      const outline = JSON.parse(opened.text);
      const pngs = outline.shots.flatMap((s) => s.layers.map((l) => l.png)).filter(Boolean);
      const cut = pngs.filter((p) => /^@@PART\d+@@$/.test(p)).length;
      check(cut > 0 && opened.parts.length >= cut && opened.text.length < afterEdit.length / 10 && pngs.every((p) => /^@@PART\d+@@$/.test(p) || p.length < 512),
        `a board file opens in pieces: ${cut} drawings as bytes, an outline of ${Math.round(opened.text.length / 1024)} KB out of a ${Math.round(afterEdit.length / 1024)} KB file`);
      await enqueue(() => loadData(outline, quickPath, opened));
      check(state.shots.length === shotCount && alphaAt(F(950, 540)) > 0 && alphaAt(F(950, 310)) > 0 && !!state.shots[0].camera && state.audio && state.audio.offset === 6,
        'opened that way, the board comes back whole: shots, drawings, camera move and sound');
      await writeProject(quickPath);
      const again = await window.api.selftestReadFile(quickPath);
      check(lastSaveParts === 0 && again === afterEdit, `saving right after opening sends no drawings and leaves the file identical (${lastSaveParts} sent)`);
      pen([[900, 700, 1], [1000, 720, 1]]);
      await writeProject(quickPath);
      check(lastSaveParts === 1, `and after a stroke, only that one drawing is sent (${lastSaveParts})`);
      await undo();
    }
    // Backups: every save keeps a version in the app's own folder (not beside
    // the board); an older one opens as a copy and never writes the file.
    {
      const mine = async () => { await window.api.backupIdle(); return (await window.api.backupList()).find((b) => b.id === state.boardId); };
      await writeProject(quickPath);
      const one = await mine();
      check(one && one.versions.length >= 1 && one.versions[0].shots === state.shots.length && one.name === 'quick-save', `saving keeps a backup version in the app, named for the board (${one ? one.versions.length : 0} so far)`);
      const emptyBefore = alphaAt(F(1300, 950));
      brushSetup('ink', { size: 30 });
      pen([[1250, 950, 1], [1350, 950, 1]]);
      await writeProject(quickPath);
      const two = await mine();
      const fileNow = await window.api.selftestReadFile(quickPath);
      check(two.versions.length === one.versions.length + 1 && alphaAt(F(1300, 950)) > 0 && emptyBefore === 0, `the next save adds a version (${two.versions.length})`);
      // The dialog lists them, this board first.
      await showBackups();
      const rows = document.querySelectorAll('#backupList .backup-board[open] .backup-row').length;
      check($('#backupDialog').open && rows === two.versions.length && document.querySelector('#backupList .backup-board summary').textContent.includes('this board'), `the Backups button lists them by time, this board first (${rows} rows)`);
      $('#backupClose').click();
      // The version before the stroke, opened as a copy.
      state.dirty = false;
      const older = two.versions[1];
      const id = state.boardId;
      await openBackup(id, older.version);
      check(alphaAt(F(1300, 950)) === 0 && alphaAt(F(950, 540)) > 0 && state.path === null && state.dirty && state.boardId === id && state.shots.length === two.versions[1].shots,
        'an older version opens as an unsaved copy, with the drawing as it was then');
      check((await window.api.selftestReadFile(quickPath)) === fileNow, 'and the board\x27s own file is left exactly as it was');
      state.dirty = false;
    }

    // Version 1 files: one 1920x1080 PNG per layer, no room around the frame.
    const v1c = new OffscreenCanvas(1920, 1080);
    v1c.getContext('2d').fillRect(100, 100, 4, 4);
    const v1png = await blobToBase64(await v1c.convertToBlob({ type: 'image/png' }));
    await enqueue(() => loadData({ app: 'storyboard-app', version: 1, fps: 24, panels: [{ duration: 24, layers: [{ name: 'L', png: v1png }] }] }, null));
    check(alphaAt(F(101, 101)) > 0, 'boards from the first version open with drawings in place');
    await enqueue(() => loadData(JSON.parse(json), null));

    // ---- playback
    for (const s of state.shots) s.duration = 12;
    state.audio.offset = 0;
    refreshUI();
    await selectShot(0);
    state.time = 0;
    togglePlay();
    await wait(650);
    check(playing && shotIndexAt(state.time) === 1, 'playback reaches shot 2 on time');
    await capture('playback.png');
    await wait(2200);
    check(!playing && state.cur === state.shots.length - 1, 'playback stops at the end on the last shot');

    // ---- blur filters (they replaced the motion blur brush)
    await addShot();
    check(BRUSH_PRESETS.some((b) => b.id === 'blur' && b.kind === 'smear') && document.querySelectorAll('[data-blur]').length === 4, 'Gaussian, Motion and Perspective blur and Glow are in the Adjust menu, and the Motion blur brush is there too');
    brushSetup('ink', { size: 10, opacity: 1 });
    setColor('#000000');
    pen(line(400, 300, 400, 700));
    document.querySelector('[data-blur="gaussian"]').click();
    check(!!filter && !filterPanel.hidden && filterPanel.textContent.includes('Gaussian blur'), 'Gaussian blur opens for the active layer');
    filter.amount = 20;
    renderFilter();
    const soft = alphaAt(F(412, 500));
    check(soft > 0 && alphaAt(F(400, 500)) < 250, `Gaussian blur softens the line (alpha ${soft} beside it)`);
    closeFilter(false);
    check(alphaAt(F(412, 500)) === 0 && alphaAt(F(400, 500)) > 240 && filterPanel.hidden, 'Cancel puts the layer back');
    openFilter('motion');
    filter.amount = 120;
    filter.angle = 0;
    closeFilter(true);
    check(alphaAt(F(450, 500)) > 0 && alphaAt(F(400, 240)) === 0, 'Motion blur streaks along its angle only (sideways here)');
    await undo();
    check(alphaAt(F(450, 500)) === 0 && alphaAt(F(400, 500)) > 240, 'and Apply is one undo step');
    openFilter('motion');
    filter.amount = 120;
    filter.angle = 90;
    renderFilter();
    check(alphaAt(F(400, 260)) > 0 && alphaAt(F(450, 500)) === 0, 'at 90 degrees it streaks up and down');
    closeFilter(false);
    openFilter('perspective');
    check(!!filterMark.querySelector('.filter-centre'), 'Perspective blur shows its centre point');
    filter.amount = 30;
    renderFilter();
    check(alphaAt(F(360, 540)) > 0 && alphaAt(F(440, 540)) === 0, 'Perspective blur streaks away from its centre');
    await capture('blur.png');
    closeFilter(false);
    // Glow: a halo of the line's own colour spreads around it.
    {
      const before = alphaAt(F(430, 500));
      openFilter('glow');
      const titled = filterPanel.textContent.includes('Glow') && !!filterPanel.querySelector('[data-key="size"]');
      filter.amount = 150;
      filter.size = 60;
      renderFilter();
      const halo = alphaAt(F(430, 500));
      closeFilter(false);
      check(titled && before === 0 && halo > 0 && alphaAt(F(430, 500)) === 0, `Glow spreads a halo around the drawing, and Cancel takes it off (alpha ${halo} 30px out)`);
    }
    // Only the selection changes when there is one.
    setSelection([F(300, 250), F(500, 250), F(500, 450), F(300, 450)]);
    openFilter('gaussian');
    filter.amount = 30;
    closeFilter(true);
    check(alphaAt(F(415, 350)) > 0 && alphaAt(F(415, 600)) === 0, 'with a selection, only the selected part blurs');
    deselect();
    // Several selected layers blur together, as one undo step.
    {
      await undo();
      const a = activeLayer();
      await addLayer();
      const b = activeLayer();
      pen(line(800, 300, 800, 700));
      mounted.selLayers = new Set([a.id, b.id]);
      refreshUI();
      openFilter('motion');
      const named = filterPanel.textContent.includes('2 layers');
      filter.amount = 120;
      filter.angle = 0;
      closeFilter(true);
      check(named && alphaAt(F(450, 500), a.id) > 0 && alphaAt(F(850, 500), b.id) > 0 && alphaAt(F(850, 500), a.id) === 0, 'Motion blur works on several selected layers at once, each on its own layer');
      await undo();
      check(alphaAt(F(450, 500), a.id) === 0 && alphaAt(F(850, 500), b.id) === 0 && alphaAt(F(800, 500), b.id) > 240, 'and one undo takes the blur off every one of them');
      mounted.selLayers = new Set();
      mounted.activeLayerId = a.id;
      refreshUI();
    }
    // The panels' buttons, pressed like a pen: press, release, click.
    const tap = (node) => {
      node.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', button: 0, buttons: 1, pressure: 0.5 }));
      node.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen', button: 0, buttons: 0 }));
      node.click();
    };
    openFilter('motion');
    filter.amount = 120;
    filter.angle = 0;
    const applyBtn = [...filterPanel.querySelectorAll('button')].find((b) => b.textContent === 'Apply');
    applyBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'pen', button: 0, buttons: 1 }));
    const draggedByPress = !!(filter && filter.drag);
    applyBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'pen', button: 0, buttons: 0 }));
    applyBtn.click();
    check(!draggedByPress && !filter && alphaAt(F(450, 500)) > 0, 'pressing Apply on a blur applies it (the press is not taken as a canvas drag)');
    await undo();
    setSelection([F(300, 250), F(500, 250), F(500, 450), F(300, 450)]);
    setTool('brush');
    tap($('#selFill'));
    await enqueue(async () => {});
    check(!stroke && alphaAt(F(320, 270)) > 200, 'pressing Fill on the selection bar fills, without starting a stroke');
    await undo();
    deselect();

    // ---- linked layers: a background drawn once and held across shots
    {
      const tmp = `${await window.api.selftestTempDir()}\\linked.sboard`;
      await selectShot(0);
      await addLayer();
      const bg = activeLayer();
      bg.name = 'BG';
      brushSetup('ink', { size: 30 });
      pen([[300, 300, 1], [500, 300, 1]]);
      await extendLayer();
      await extendLayer();
      const has = (layer) => state.shots.map((s) => s.layers.includes(layer));
      const inShots = has(bg);
      const bands = state.shots.map((s) => tl.clipEls.get(s.id).classList.contains('linked'));
      const badge = document.querySelector(`#layers li[data-layer-id="${bg.id}"] .link-badge`);
      check(inShots[0] && inShots[1] && inShots[2] && !inShots[3] && state.cur === 0,
        `Extend to next shot puts the same layer in the next shots, twice gives shots 1 to 3, and stays on this shot (${inShots.map(Number).join('')})`);
      check(bands.slice(0, 3).every(Boolean) && !bands[3] && badge && badge.textContent === '3' && !$('#unlinkLayer').hidden,
        `the timeline marks the shots it is linked in and the layer shows a chain with 3 (${bands.map(Number).join('')})`);
      setInspectorTab('layers');
      await capture('linked-layers.png');
      await undo();
      const afterUndo = has(bg);
      await redo();
      check(afterUndo[1] && !afterUndo[2] && state.cur === 0 && has(bg)[2], 'undo takes it back out of the last shot without going there, redo puts it back');
      // Drawn in the third shot, it is there in the first and in the second shot's picture.
      await selectShot(2);
      mounted.activeLayerId = bg.id;
      refreshUI();
      pen([[300, 600, 1], [500, 600, 1]]);
      await selectShot(0);
      const pic = (await renderFrame(state.shots[1], null, dims.W, dims.H)).getContext('2d').getImageData(400, 600, 1, 1).data;
      check(alphaAt(F(400, 600), bg.id) > 0 && pic[0] < 128, 'drawing on a linked layer in one shot changes it in the others (seen in shot 1 and in shot 2\'s picture)');
      // The timeline thumbnails of the other shots catch up once the pen rests.
      await wait(1600);
      await queue;
      const th = state.shots[1].thumb;
      const tx = Math.round((400 / dims.W) * th.width);
      const ty = Math.round((600 / dims.H) * th.height);
      const patch = th.getContext('2d').getImageData(tx - 2, ty - 2, 5, 5).data;
      let darkest = 255;
      for (let k = 0; k < patch.length; k += 4) darkest = Math.min(darkest, patch[k]);
      check(darkest < 160, `the other shots' timeline thumbnails update too (darkest ${darkest} where the line is in shot 2's thumbnail)`);
      // Saved once, and reopened still linked.
      await writeProject(tmp);
      const opened = await window.api.selftestOpen(tmp);
      const outline = JSON.parse(opened.text);
      const links = outline.shots.flatMap((s) => s.layers).filter((l) => l.link);
      await enqueue(() => loadData(JSON.parse(opened.text), tmp, opened));
      const bg2 = state.shots[0].layers.find((l) => l.name === 'BG');
      check(links.length === 2 && links.every((l) => !l.png) && bg2 && has(bg2).slice(0, 4).join() === 'true,true,true,false' && alphaAt(F(400, 600), bg2.id) > 0,
        `the file keeps a linked layer's drawing once (${links.length} links) and it opens still linked, drawing and all`);
      // Unlink: the second shot gets its own copy to change alone.
      await selectShot(1);
      mounted.activeLayerId = bg2.id;
      await unlinkLayer();
      const own = activeLayer();
      check(own !== bg2 && own.name === 'BG' && !state.shots[1].layers.includes(bg2) && has(bg2)[0] && has(bg2)[2] && alphaAt(F(400, 300)) > 0 && $('#unlinkLayer').hidden,
        'Unlink from this shot gives it its own copy with the drawing; the other shots stay linked');
      pen([[300, 800, 1], [500, 800, 1]]);
      await selectShot(0);
      check(alphaAt(F(400, 800), bg2.id) === 0, 'drawing on the unlinked copy leaves the linked layer alone');
      await undo();
      await undo();
      check(state.shots[1].layers.includes(bg2) && !state.shots[1].layers.includes(own), 'undo links that shot again');
      // Taking it out of one shot leaves it in the others.
      await selectShot(2);
      mounted.activeLayerId = bg2.id;
      await deleteLayer();
      check(!state.shots[2].layers.includes(bg2) && has(bg2)[0] && has(bg2)[1], 'deleting a linked layer takes it out of this shot only');
      // Clean up for the tests after this.
      for (const [i, s] of state.shots.entries()) {
        if (!s.layers.includes(bg2)) continue;
        await selectShot(i);
        mounted.activeLayerId = bg2.id;
        await deleteLayer();
      }
      await selectShot(0);
    }

    // ---- layer folders: group a background's layers, extend the folder
    {
      const tmp = `${await window.api.selftestTempDir()}\\folders.sboard`;
      await selectShot(0);
      const made = [];
      for (const n of ['BG lines', 'BG color', 'BG shade']) { await addLayer(); activeLayer().name = n; made.push(activeLayer()); }
      pen([[300, 300, 1], [500, 300, 1]]);
      selectLayer(mounted, made[0], 'one');
      selectLayer(mounted, made[2], 'range');
      setInspectorTab('layers');
      await groupLayers();
      const g = made[0].group;
      const row = document.querySelector(`#layers li.folder-row[data-group="${g}"]`);
      const inRows = [...document.querySelectorAll('#layers li.in-folder')].length;
      check(g && made.every((l) => l.group === g) && state.groups[g] && row && row.querySelector('.name').textContent === 'Folder 1' && inRows === 3 && selectedLayers().length === 3 && mounted.selGroup === g,
        `Ctrl+G puts the picked layers in a folder, shown as a folder row with its 3 layers set in under it, and the folder is picked`);
      await capture('folders.png');
      // Extend the folder: all three go to the next shot, same order, same folder.
      await extendLayer();
      const next = state.shots[1];
      const order = next.layers.filter((l) => made.includes(l));
      check(order.length === 3 && order.every((l, i) => l === made[i]) && state.cur === 0 && $('#extendLayer').textContent.includes('Folder 1'),
        `with the folder picked, Extend puts all its layers in the next shot in the same order (${order.map((l) => l.name).join(', ')})`);
      // Closed, its layers are hidden in the list.
      toggleGroupOpen(g);
      const hiddenRows = [...document.querySelectorAll('#layers li.in-folder')].every((li) => li.hidden);
      toggleGroupOpen(g);
      check(hiddenRows && state.groups[g].open, 'a folder closes and opens in the Layers list');
      // The down arrow moves the whole folder past the layer under it.
      selectGroup(mounted, g);
      const under = mounted.layers[mounted.layers.indexOf(made[0]) - 1];
      await moveLayer(-1);
      const at = made.map((l) => mounted.layers.indexOf(l));
      check(under && mounted.layers.indexOf(under) === at[2] + 1 && at[1] === at[0] + 1 && at[2] === at[1] + 1, 'the down arrow moves the whole folder past the layer under it, keeping it together');
      await undo();
      check(mounted.layers.indexOf(under) === mounted.layers.indexOf(made[0]) - 1, 'and undo puts it back');
      // One layer picked inside the folder steps out of it at the folder's edge.
      selectLayer(mounted, made[2], 'one');
      await moveLayer(1);
      check(!made[2].group && made[0].group === g, 'a layer moved past the folder\'s edge steps out of the folder');
      await undo();
      check(made[2].group === g, 'and undo puts it back in');
      // Saved and reopened, the folder is still there with its name.
      state.groups[g].name = 'BG';
      await writeProject(tmp);
      const opened = await window.api.selftestOpen(tmp);
      await enqueue(() => loadData(JSON.parse(opened.text), tmp, opened));
      const back = state.shots[0].layers.filter((l) => l.group === g);
      check(state.groups[g] && state.groups[g].name === 'BG' && back.length === 3 && state.shots[1].layers.filter((l) => l.group === g).length === 3 && back.every((l) => state.shots[1].layers.includes(l)),
        'folders are saved with the board and open again, still linked in both shots');
      // Ungroup, then undo.
      selectGroup(mounted, g);
      await ungroupLayers();
      const loose = back.every((l) => !l.group) && !state.groups[g];
      await undo();
      check(loose && back.every((l) => l.group === g) && state.groups[g], 'Ctrl+Shift+G ungroups (the layers stay), and undo makes the folder again');
      // Delete with the folder picked deletes the whole folder from this shot.
      selectGroup(mounted, g);
      await deleteLayer();
      check(!state.shots[0].layers.some((l) => l.group === g) && state.shots[1].layers.filter((l) => l.group === g).length === 3, 'Delete with a folder picked takes the whole folder out of this shot only');
      await selectShot(1);
      selectGroup(mounted, g);
      await deleteLayer();
      forgetEmptyGroups();
      await selectShot(0);
    }

    // ---- board sheets
    state.shots[0].notes = 'Kid runs in, skids to a stop.\n"Wait for me!"';
    const pdf = await exportPdf(`${await window.api.selftestTempDir()}\\boards-test.pdf`);
    const pdfInfo = pdf ? await window.api.selftestPdfPages(pdf.path) : null;
    const pagesWanted = Math.ceil(state.shots.length / 6);
    check(pdfInfo && pdfInfo.pages === pagesWanted, `board sheets PDF has ${pagesWanted} page(s) (${pdfInfo ? pdfInfo.pages : 'none'})`);
    // Shots per page: the grid is worked out for any count, fits the paper,
    // and never leaves a whole row or column empty.
    {
      const bad = [];
      for (const aspect of [16 / 9, 2.37, 1, 9 / 16]) {
        for (let n = 1; n <= 30; n++) {
          const L = sheetLayout(n, aspect);
          const textH = 0.07 + (L.pt * 1.4) / 72 + 0.09 + (3 * L.pt * 0.9 * 1.35) / 72;
          const fitsW = L.cols * L.picW + (L.cols - 1) * 0.28 <= L.pw - 1 + 1e-6;
          const fitsH = L.rows * (L.picH + textH) + (L.rows - 1) * L.gapY <= L.ph - 1.32 + 1e-6;
          if (!(L.cols * L.rows >= n && (L.rows - 1) * L.cols < n && (L.cols - 1) * L.rows < n && fitsW && fitsH)) bad.push(`${n}@${aspect.toFixed(2)}`);
        }
      }
      const twelve = sheetLayout(12, 16 / 9);
      check(!bad.length, `the board sheet grid fits the paper for 1 to 30 shots a page at four frame shapes${bad.length ? ` (wrong: ${bad.join(' ')})` : ''}; 12 wide shots go ${twelve.cols} x ${twelve.rows}, ${twelve.landscape ? 'landscape' : 'portrait'}, ${twelve.picW.toFixed(2)}in each`);
      const wasPer = state.sheetPerPage;
      state.sheetPerPage = 2;
      const pdf2 = await exportPdf(`${await window.api.selftestTempDir()}\\boards-2.pdf`);
      state.sheetPerPage = state.shots.length;
      const pdfAll = await exportPdf(`${await window.api.selftestTempDir()}\\boards-all.pdf`);
      state.sheetPerPage = wasPer;
      const p2 = pdf2 ? await window.api.selftestPdfPages(pdf2.path) : null;
      const pAll = pdfAll ? await window.api.selftestPdfPages(pdfAll.path) : null;
      check(p2 && p2.pages === Math.ceil(state.shots.length / 2) && pAll && pAll.pages === 1,
        `shots per page sets the pages: 2 a page gives ${p2 ? p2.pages : 'none'} pages, all ${state.shots.length} a page gives ${pAll ? pAll.pages : 'none'}`);
    }

    // ---- export
    const target = `${await window.api.selftestTempDir()}\\export-test.mp4`;
    const path = await exportVideo(target);
    const probe = path ? await window.api.selftestProbe(path) : null;
    const expected = totalFrames() / state.fps;
    check(probe && Math.abs(probe.duration - expected) < 0.15, `export writes an MP4 of the right length (${probe ? probe.duration.toFixed(2) : 'none'}s, expected ${expected.toFixed(2)}s)`);
    check(probe && probe.video === '1920x1080' && probe.audio, `export has 1920x1080 video and an audio track (${probe ? `${probe.video}, audio ${probe.audio}` : 'none'})`);
    // With the timecode and shot numbers burned in, every frame is drawn: same length, still with sound.
    state.burnTimecode = true;
    state.burnShot = true;
    const burned = await exportVideo(`${await window.api.selftestTempDir()}/export-burn.mp4`);
    state.burnTimecode = false;
    state.burnShot = false;
    const probeB = burned ? await window.api.selftestProbe(burned) : null;
    check(probeB && Math.abs(probeB.duration - expected) < 0.15 && probeB.audio, `export with the timecode and shot numbers burned in is the same length, with sound (${probeB ? probeB.duration.toFixed(2) : 'none'}s)`);
    // Each shot as its own PNG, in a "<board> shots" folder: one picture per
    // shot, frame-sized, showing that shot (and its caption when captions are on).
    {
      const captionsWas = state.captions;
      state.captions = true;
      const each = await exportShots(await window.api.selftestTempDir());
      state.captions = captionsWas;
      const load = (f) => new Promise((res) => { const im = new Image(); im.onload = () => res(im); im.onerror = () => res(null); im.src = `file:///${f.replace(/\\/g, '/')}?${Date.now()}`; });
      const pics = each ? await Promise.all(each.files.map(load)) : [];
      const named = each && each.files.length === state.shots.length && /shots$/.test(each.folder)
        && each.files.every((f, i) => f.endsWith(`shot_${String(i + 1).padStart(3, '0')}.png`));
      check(named && pics.every((p) => p && p.naturalWidth === dims.W && p.naturalHeight === dims.H),
        `Each shot exports one PNG per shot at the frame size (${pics.filter(Boolean).length} of ${state.shots.length} pictures, ${pics[0] ? `${pics[0].naturalWidth}x${pics[0].naturalHeight}` : 'none'})`);
      // Each picture matches its own shot drawn fresh, above the caption.
      const px = (src) => { const c = new OffscreenCanvas(dims.W, dims.H); const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(src, 0, 0); return x.getImageData(0, 0, dims.W, dims.H).data; };
      let matches = 0;
      for (const [i, s] of state.shots.entries()) {
        if (!pics[i]) continue;
        const a = px(pics[i]);
        const b = px(await renderFrame(s, s.camera ? camAt(s, 0) : null, dims.W, dims.H));
        let off = 0;
        let n = 0;
        for (let y = 0; y < dims.H * 0.7; y += 7) for (let x = 0; x < dims.W; x += 7) { const k = (y * dims.W + x) * 4; n++; if (Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]) > 12) off++; }
        if (off / n < 0.002) matches++;
      }
      const cap = pics[0] ? px(pics[0]) : null;
      let ink = 0;
      if (cap) for (let y = Math.round(dims.H * 0.8); y < dims.H; y += 3) for (let x = Math.round(dims.W * 0.3); x < dims.W * 0.7; x += 3) if (cap[(y * dims.W + x) * 4] < 100) ink++;
      check(matches === state.shots.length && ink > 20, `each shot picture shows its own shot (${matches} of ${state.shots.length} match) with shot 1's caption burned in (${ink} caption pixels)`);
    }

    // ---- source files: a zip anyone can open
    {
      const zipPath = `${await window.api.selftestTempDir()}/source-test.zip`;
      state.path = `${await window.api.selftestTempDir()}/source-board.sboard`;
      await writeProject(state.path);
      state.dirty = false;
      mounted.layers[0].name = '线稿 / rough: v1';
      const made = await exportSource(zipPath);
      const entries = made ? await window.api.selftestZipList(zipPath) : [];
      const layerCount = state.shots.reduce((n, s) => n + s.layers.filter((l) => l.blob || l.snap || live.has(l.id)).length, 0);
      const pngs = entries.filter((e) => /^shots\/shot_\d{3}\/\d{2} .+\.png$/.test(e.name));
      const flats = entries.filter((e) => /^frames\/shot_\d{3}\.png$/.test(e.name));
      const names = entries.map((e) => e.name);
      check(made && made.ok && pngs.length >= state.shots.length && flats.length === state.shots.length && names.includes('shots.csv') && names.includes('README.txt') && names.includes('board.sboard'),
        `Source files exports a zip: ${pngs.length} layer pictures, ${flats.length} flattened shots, a timing sheet, a note and the board file (${entries.length} files, ${layerCount} layers in the board)`);
      check(entries.every((e) => e.crcOk) && pngs.concat(flats).every((e) => e.head === '89504e470d0a1a0a') && pngs.some((e) => e.name.includes('线稿 _ rough_ v1')),
        'every picture in it is a whole PNG, and layer names that cannot be file names are made safe (Chinese kept)');
      // The video burn-in: timecode and shot number tabs.
      const c = new OffscreenCanvas(dims.W, dims.H);
      const cx = c.getContext('2d', { willReadFrequently: true });
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, dims.W, dims.H);
      const dark = (x, y) => cx.getImageData(x, y, 1, 1).data[0] < 120;
      const size = Math.round(dims.H * 0.034);
      // The timecode alone: a tab top left, nothing top right.
      drawBurnIn(cx, { frame: 24 * 3725 + 7 });
      const tcLeft = dark(size * 0.9, size * 0.9) && !dark(dims.W - size * 1.2, size * 0.9);
      drawBurnIn(cx, { frame: 24 * 3725 + 7, shot: 12 });
      // Square corners: the very corner pixel of the tab is as dark as its middle.
      const cornerDark = dark(Math.round(size * 0.6) + 1, Math.round(size * 0.6) + 1);
      check(cornerDark, 'the burn-in tabs have square corners');
      check(burnTimecode(24 * 3725 + 7) === '01:02:05:07' && tcLeft && dark(dims.W - size * 1.2, size * 0.9) && !dark(dims.W / 2, dims.H / 2), 'the video burn-in draws the timecode top left and the shot number top right (01:02:05:07)');
      // A caption in Chinese (no spaces) wraps inside the frame.
      const wasCaptions = state.captions;
      state.captions = true;
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, dims.W, dims.H);
      drawCaption(cx, { notes: '这是一个很长的中文字幕用来测试没有空格的文字也能在画面里面自动换行而不会超出画面的边界这是一个很长的中文字幕用来测试没有空格的文字' });
      state.captions = wasCaptions;
      const edge = (x) => { for (let y = Math.round(dims.H * 0.7); y < dims.H; y += 4) if (dark(x, y)) return true; return false; };
      check(!edge(Math.round(dims.W * 0.04)) && !edge(Math.round(dims.W * 0.96)) && edge(Math.round(dims.W * 0.5)), 'a long caption with no spaces (Chinese) wraps inside the frame');
    }

    // ---- reference video (generated test videos only)
    await enqueue(() => loadBlank());
    const mp4 = await window.api.selftestMakeVideo('mp4');
    await useVideo(mp4);
    check(state.reference && Math.abs(state.reference.duration - 3) < 0.15 && refVideo.readyState >= 2, 'a video comes in as a reference under the drawing');
    check(state.shots.length === 1 && state.shots[0].duration === 72, 'a one-shot board stretches to the video length (3s, 72 frames)');
    check(state.audio && Math.abs(state.audio.buffer.duration - 3) < 0.25, "the video's sound becomes the audio track");
    state.time = 36;
    placePlayhead();
    await seekReference(1.5);
    check(Math.abs(refVideo.currentTime - 1.5) < 0.05 && refVideo.style.visibility !== 'hidden', 'the reference shows the frame at the playhead');
    const refRow = document.querySelector('#layers li.ref-row');
    check(!!refRow && refRow === document.querySelector('#layers').lastElementChild, 'the Layers panel shows the reference video as its own locked bottom row');
    const layersWithRef = mounted.layers.length;
    refRow.querySelector('.eye').click();
    check(!state.reference.visible && refVideo.style.display === 'none' && mounted.layers.length === layersWithRef, 'its eye hides the video and leaves the drawing layers alone');
    document.querySelector('#layers li.ref-row .eye').click();
    const refOp = document.querySelector('#layers li.ref-row .ref-op');
    refOp.value = 30;
    refOp.dispatchEvent(new Event('input', { bubbles: true }));
    check(state.reference.opacity === 0.3 && refVideo.style.opacity === '0.3' && $('#refOpacity').value === '30', 'the video row in Layers has its own opacity slider');
    refOp.value = 50;
    refOp.dispatchEvent(new Event('input', { bubbles: true }));
    brushSetup('ink', { size: 10 });
    pen(line(300, 300, 1600, 800));
    await capture('reference.png');
    await splitShot();
    check(state.shots.length === 2 && state.shots[0].duration === 36 && state.shots[1].duration === 36, 'Ctrl+K splits the shot at the playhead');
    await undo();
    check(state.shots.length === 1 && state.shots[0].duration === 72, 'undo joins the shot back together');
    // Scrubbing over the video: it must never flash blank while a seek is
    // under way (it used to draw white until each seek landed).
    {
      let blanks = 0;
      const frames = 50;
      const looks = new Set();
      for (let k = 0; k < frames; k++) {
        scrubTo(4 + k);
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const d = pctx.getImageData(1350, 250, 100, 60).data;
        let white = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) white++;
        if (white > (d.length / 4) * 0.99) blanks++;
        // The test pattern's colour bars stand still; its gradient band scrolls.
        const band = pctx.getImageData(300, 860, 600, 20).data;
        let sig = 0;
        for (let i = 0; i < band.length; i += 97) sig = (sig * 31 + band[i]) >>> 0;
        looks.add(sig);
      }
      endScrub();
      check(blanks === 0, `scrubbing over the reference video never flashes blank (${blanks} of ${frames} frames blank)`);
      check(looks.size >= 10, `and the video keeps moving while it scrubs (${looks.size} different pictures in ${frames} steps)`);
    }
    togglePlay();
    await wait(600);
    check(playing && !refVideo.paused, 'the reference plays under the boards in playback');
    stopPlay();
    await wait(200);
    const refJson = JSON.stringify(await enqueue(serialize));
    check(refJson.length < 2_000_000, `the board stores the video's path, not the video (${Math.round(refJson.length / 1024)} KB)`);
    await enqueue(() => loadData(JSON.parse(refJson), null));
    // Reopening jumps the video to the playhead; give that frame a moment to decode.
    for (let k = 0; k < 20 && refVideo.readyState < 2; k++) await wait(50);
    check(state.reference && state.reference.path === mp4 && refVideo.readyState >= 2, 'the reference video comes back when the board is reopened');
    // Pressing play shows the board over the video from the very first
    // picture, even when the first shot takes a while to put together (here:
    // heavy layers on a shot that is not open, so they have to be decoded).
    {
      await selectShot(0);
      brushSetup('ink', { size: 40 });
      setColor('#1b1b1f');
      pen(line(300, 300, 1600, 800));
      for (let k = 0; k < 5; k++) {
        await addLayer();
        const ctx = live.get(mounted.activeLayerId).getContext('2d');
        ctx.strokeStyle = 'rgba(40, 40, 60, 0.03)';
        for (let n = 0; n < 4000; n++) { ctx.beginPath(); ctx.moveTo(dims.FX + Math.random() * dims.W, dims.FY + Math.random() * dims.H); ctx.lineTo(dims.FX + Math.random() * dims.W, dims.FY + Math.random() * dims.H); ctx.stroke(); }
        mounted.layers.find((l) => l.id === mounted.activeLayerId).dirty = true;
      }
      await addShot();
      await Promise.all(state.shots.flatMap((s) => s.layers.map((l) => l.pending)).filter(Boolean));
      state.time = 0;
      placePlayhead();
      togglePlay();
      const t0 = performance.now();
      while ($('#player').hidden && performance.now() - t0 < 8000) await new Promise((r) => requestAnimationFrame(r));
      const shownAfter = Math.round(performance.now() - t0);
      // Every one of the first frames shown has the ink, opaque, where the line is.
      const seen = [];
      for (let k = 0; k < 10; k++) {
        const px = pctx.getImageData(950, 550, 1, 1).data;
        seen.push(px[3] === 255 && px[0] < 90 && px[1] < 90 ? 'ink' : `${px[0]},${px[1]},${px[2]},${px[3]}`);
        await new Promise((r) => requestAnimationFrame(r));
      }
      const bad = seen.filter((s) => s !== 'ink');
      check(!$('#player').hidden && !bad.length, `playback starts with the board over the video, not the video alone (${bad.length ? 'first frames: ' + seen.slice(0, 4).join(' | ') : 'ink in all of the first 10 frames'}, ${shownAfter}ms after Play)`);
      stopPlay();
      await wait(200);
    }

    // Stepping frame by frame over a reference video shows exactly the video
    // frame for that moment, at the common frame rates (she reboards over
    // animatics frame by frame, so one frame off would shift her timing).
    for (const rate of [24, 30, 60]) {
      const made = await window.api.selftestMakeVideo(`counter-${rate}`);
      if (!made) { check(false, `could not make a ${rate}fps test video`); continue; }
      await enqueue(() => loadBlank());
      state.fps = rate;
      await loadReference(made.file, { record: false });
      const probe = new OffscreenCanvas(8, 8);
      const pc = probe.getContext('2d', { willReadFrequently: true });
      const wrong = [];
      for (let k = 0; k < rate; k++) {
        state.time = k;
        syncReference();
        for (let w = 0; w < 50 && (refSeek.busy || refVideo.seeking || refVideo.readyState < 2); w++) await wait(20);
        pc.drawImage(refVideo, 0, 0, 8, 8);
        const shown = Math.round(pc.getImageData(4, 4, 1, 1).data[0] / (made.step * 255 / 219));
        if (shown !== k) wrong.push(`${k}->${shown}`);
      }
      check(wrong.length === 0, `stepping frame by frame over a ${rate}fps video shows its exact frames (${wrong.length ? 'wrong: ' + wrong.slice(0, 6).join(' ') : 'all ' + rate + ' right'})`);
    }
    // Changing the frame rate keeps the video at the same moment in seconds.
    {
      await enqueue(() => loadBlank());
      const made = await window.api.selftestMakeVideo('counter-24');
      await loadReference(made.file, { record: false });
      state.reference.offset = 12; // half a second in
      await resizeCanvas(dims.W, dims.H, 48);
      check(state.reference.offset === 24, `changing the frame rate keeps the reference video at the same time (offset ${state.reference.offset} frames at 48fps, want 24)`);
      await resizeCanvas(dims.W, dims.H, 24);
    }
    await enqueue(() => loadBlank());
    state.fps = 24;
    const mov = await window.api.selftestMakeVideo('prores');
    await useVideo(mov);
    check(state.reference && state.reference.path === mov && !!state.reference.proxy && refVideo.readyState >= 2, 'a video Chromium cannot play (ProRes) is converted and shown');
  } catch (err) {
    check(false, `crashed: ${err.stack}`);
  }
  window.api.selftestDone(out);
}

// A plain sine tone as WAV bytes.
function makeWav(seconds, rate = 22050) {
  const n = rate * seconds;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.sin((i / rate) * TAU * 440) * 12000, true);
  return new Uint8Array(buf);
}
