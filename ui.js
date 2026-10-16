'use strict';
// Toolbar, rail, inspector, keyboard and start-up.

const svg = (body) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const ICONS = {
  brush: svg('<path d="M4 20l1-4L15.5 5.5a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M13.5 7.5l3 3"/>'),
  eraser: svg('<path d="M7 20h13"/><path d="M4.6 14.6l8.8-8.8a2 2 0 0 1 2.8 0l2.4 2.4a2 2 0 0 1 0 2.8L11 18.6H8.4l-3.8-3.8a.6.6 0 0 1 0-.2z"/><path d="M9 10l5.5 5.5"/>'),
  fill: svg('<path d="M4.5 11.5L11 5l7 7-6.5 6.5a2 2 0 0 1-2.8 0l-4.2-4.2a2 2 0 0 1 0-2.8z"/><path d="M4.5 12.5h13"/><path d="M20 15.5s1.6 2 1.6 3.1a1.6 1.6 0 0 1-3.2 0c0-1.1 1.6-3.1 1.6-3.1z"/>'),
  move: svg('<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>'),
  palette: svg('<path d="M12 3a9 9 0 1 0 0 18c1.2 0 1.8-.9 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="14.5" cy="7" r="1.2"/>'),
  layers: svg('<path d="M12 4l9 4.5-9 4.5-9-4.5z"/><path d="M3 12.5l9 4.5 9-4.5"/><path d="M3 16.5l9 4.5 9-4.5"/>'),
  wand: svg('<path d="M4 20L15 9"/><path d="M15 9l2-2"/><path d="M17 3v2M20 6h2M19.5 4.5l1.5-1.5M12 3l.6 1.4M21 12l-1.4-.6"/>'),
  multi: svg('<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><path d="M14 7.5h6M14 16.5h6"/><path d="M5.8 7.6l1.3 1.3 2.2-2.6M5.8 16.6l1.3 1.3 2.2-2.6"/>'),
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>'),
  paste: svg('<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1"/><path d="M9.5 11h5M9.5 15h5"/>'),
  lasso: svg('<path d="M7.5 15.8C4.8 14.7 3 12.6 3 10.2 3 6.8 7 4 12 4s9 2.8 9 6.2-4 6.2-9 6.2c-1 0-2-.1-2.9-.3"/><path d="M9.5 16c0 2-1.2 3.5-3 4"/><circle cx="8.4" cy="15.6" r="1.4"/>'),
  hand: svg('<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12"/><path d="M11 11.5V5a1.5 1.5 0 0 1 3 0v6.5"/><path d="M14 11.5V7a1.5 1.5 0 0 1 3 0v7c0 3.9-2.6 7-6.2 7-2.4 0-3.9-1.1-5.1-3.1l-2.1-3.6a1.5 1.5 0 0 1 2.5-1.7L8 14"/>'),
  undo: svg('<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>'),
  redo: svg('<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>'),
  play: svg('<path d="M7 4.8v14.4a.6.6 0 0 0 .9.5l11.4-7.2a.6.6 0 0 0 0-1L7.9 4.3a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>'),
  skipStart: svg('<path d="M6 5v14"/><path d="M18 6.2v11.6a.6.6 0 0 1-.9.5L9 12.5a.6.6 0 0 1 0-1l8.1-5.8a.6.6 0 0 1 .9.5z" fill="currentColor" stroke="none"/>'),
  left: svg('<path d="M15 6l-6 6 6 6"/>'),
  right: svg('<path d="M9 6l6 6-6 6"/>'),
  up: svg('<path d="M6 15l6-6 6 6"/>'),
  down: svg('<path d="M6 9l6 6 6-6"/>'),
  onion: svg('<circle cx="9.5" cy="12" r="6"/><circle cx="14.5" cy="12" r="6" stroke-dasharray="2 2.4"/>'),
  fit: svg('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  canvas: svg('<path d="M7 3v14h14"/><path d="M3 7h14v14"/>'),
  help: svg('<circle cx="12" cy="12" r="9"/><path d="M9.6 9.3a2.5 2.5 0 0 1 4.8.9c0 1.7-2.4 2.2-2.4 3.6"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  trash: svg('<path d="M4 7h16"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l.9 12.2a1 1 0 0 0 1 .8h7.2a1 1 0 0 0 1-.8L17.5 7"/>'),
  eye: svg('<path d="M2.5 12S6 6 12 6s9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.6"/>'),
  eyeOff: svg('<path d="M4 4l16 16"/><path d="M9.9 6.3A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-2.6 3.3M6.4 7.9A16.4 16.4 0 0 0 2.5 12S6 18 12 18c1.5 0 2.8-.4 4-.9"/>'),
  duplicate: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>'),
  camera: svg('<rect x="3" y="7" width="12.5" height="10" rx="2"/><path d="M15.5 11l5-3v8l-5-3"/>'),
  music: svg('<path d="M9 18V5.5l11-2V16"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
  volume: svg('<path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5z"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  film: svg('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 5v14M17 5v14M3 9.5h4M3 14.5h4M17 9.5h4M17 14.5h4"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  folder: svg('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
  split: svg('<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8.2 8.3L20 17M8.2 15.7L20 7"/>'),
  perspective: svg('<path d="M8.5 5h7L21 19H3z"/><path d="M12 5v14M10.2 5l-3.6 14M13.8 5l3.6 14M5.4 12.5h13.2"/>'),
  safe: svg('<rect x="3" y="5" width="18" height="14" rx="1.5"/><rect x="6.5" y="8" width="11" height="8" stroke-dasharray="2 2"/>'),
};
document.querySelectorAll('[data-icon]').forEach((el) => { el.outerHTML = ICONS[el.dataset.icon]; });

let uiReady = false;

// ---------------------------------------------------------------- small helpers

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function markDirty() {
  if (!state.dirty) { state.dirty = true; updateTitle(); }
}

function projectName() {
  return state.path ? state.path.split(/[\\/]/).pop().replace(/\.sboard$/, '') : 'Untitled';
}

function updateTitle() {
  document.title = `${projectName()}${state.dirty ? ' *' : ''} | Storyboard`;
  $('#projectName').textContent = projectName();
  $('#dirtyDot').hidden = !state.dirty;
}

function el(tag, props = {}, ...kids) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

// A labelled range slider. fmt turns the value into the label text.
function sliderRow(label, value, min, max, step, fmt, onInput) {
  const out = el('span', { className: 'num' });
  const input = el('input', { type: 'range', min, max, step, value });
  const sync = () => { out.textContent = fmt(Number(input.value)); };
  input.addEventListener('input', () => { onInput(Number(input.value)); sync(); });
  sync();
  return el('label', { className: 'slider-row' }, el('span', { textContent: label }), input, out);
}

// ---------------------------------------------------------------- brush sizes

const MAX_SIZE = 500;
const sizeToSlider = (s) => (Math.log(s) / Math.log(MAX_SIZE)) * 100;
const sliderToSize = (v) => Math.max(1, Math.round(Math.exp((v / 100) * Math.log(MAX_SIZE))));

function setSize(size) {
  brush().size = clamp(Math.round(size), 1, MAX_SIZE);
  renderRail();
}

// ---------------------------------------------------------------- render

function refreshUI() {
  if (!uiReady) return;
  renderTabs();
  warmScrubFrames();
  renderMoveBox();
  renderToolbar();
  renderRail();
  renderInspector();
  renderTimeline();
  renderCameraBoxes();
  renderGrid();
  updateTitle();
}

function renderToolbar() {
  const active = state.tool === 'brush' ? (state.brushId === 'eraser' ? 'eraser' : 'brush') : state.tool;
  document.querySelectorAll('.tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === active));
  $('#onionBtn').classList.toggle('active', state.onion);
  $('#tlPlay').innerHTML = playing ? ICONS.pause : ICONS.play;
  $('#tlPlay').title = playing ? 'Stop (Enter)' : 'Play from the playhead (Enter)';
  $('#selBar').hidden = !state.selection || playing || wholeMove;
  const moving = state.tool === 'lasso' || state.tool === 'move';
  $('#selHint').textContent = state.tool === 'move' ? 'Drag anywhere to move, arrows nudge' : moving ? 'Drag inside to move. Shift adds, Ctrl cuts' : 'Selection';
  $('#selMove').hidden = moving;
  viewport.dataset.tool = state.tool;
}

function renderRail() {
  refreshCursor();
  const b = brush();
  const size = $('#railSize');
  if (document.activeElement !== size) size.value = sizeToSlider(b.size);
  $('#railSizeVal').textContent = b.size;
  const op = $('#railOpacity');
  if (document.activeElement !== op) op.value = Math.round(b.opacity * 100);
  $('#railOpacityVal').textContent = `${Math.round(b.opacity * 100)}%`;
}

// Small sample stroke for each brush in the list.
const previewCache = new Map();
function brushPreview(b) {
  const key = `${b.id}|${b.roundness}|${b.angle}|${b.minSize}`;
  if (previewCache.has(key)) return previewCache.get(key);
  const c = el('canvas', { width: 112, height: 36, className: 'brush-preview' });
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#e8e8ea';
  ctx.strokeStyle = '#e8e8ea';
  const pts = Array.from({ length: 40 }, (_, i) => {
    const t = i / 39;
    const p = Math.sin(t * Math.PI);
    return { x: 10 + t * 92, y: 18 + Math.sin(t * TAU) * 9, r: Math.max(0.6, 5 * (b.minSize + (1 - b.minSize) * p)) };
  });
  if (b.kind === 'air') {
    const g = ctx.createLinearGradient(0, 0, 112, 0);
    for (const p of pts) {
      const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 9);
      rg.addColorStop(0, 'rgba(232,232,234,0.12)');
      rg.addColorStop(1, 'rgba(232,232,234,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(p.x - 9, p.y - 9, 18, 18);
    }
    void g;
  } else if (b.kind === 'stamp') {
    // Light to dark and back, like pressing harder in the middle.
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i];
      const t = i / (pts.length - 1);
      ctx.globalAlpha = 0.25 + 0.75 * Math.sin(t * Math.PI);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.r * 0.8, Math.max(0.4, p.r * 0.8 * b.roundness), (b.angle * Math.PI) / 180, 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else if (b.kind === 'smear') {
    // A ring with a streaky trail behind it.
    ctx.lineWidth = 1.6;
    for (let k = 14; k >= 0; k--) {
      ctx.globalAlpha = k === 0 ? 1 : 0.07;
      ctx.beginPath();
      ctx.arc(84 - k * 4.5, 18, 9, 0, TAU);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  } else {
    const sh = nibShape({ roundness: b.roundness, angle: b.angle });
    let prev = null;
    for (const p of pts) { stamp(ctx, prev, p, sh); prev = p; }
    if (b.kind === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillRect(48, 0, 16, 36);
    }
  }
  previewCache.set(key, c);
  return c;
}

let toolKey = '';
function renderInspector() {
  const shot = current();
  const sec = $('#secTool');
  const key = `${state.tool}|${state.brushId}|${state.moveMode}|${state.lassoMode}|${state.tool === 'perspective' && shot ? `${shot.id}:${shot.grid ? JSON.stringify([shot.grid.visible, shot.grid.cols, shot.grid.rows, shot.grid.opacity]) : 'none'}` : ''}`;
  if (key !== toolKey) {
    toolKey = key;
    sec.replaceChildren(...toolPanel());
  }
  // Brush list highlight follows the current brush.
  sec.querySelectorAll('.brush-item').forEach((b) => b.classList.toggle('active', b.dataset.id === state.brushId));

  // Color
  $('#colorChip').style.background = state.color;
  const rc = document.getElementById('railColor');
  if (rc) rc.style.background = state.color;
  $('#colorPicker').value = state.color;
  if (document.activeElement !== $('#colorHex')) $('#colorHex').value = state.color.toUpperCase();
  renderSwatches();

  // Layers
  if (shot) {
    const layerRows = [...shot.layers].reverse().map((layer) => {
      const picked = layer.id === shot.activeLayerId || (shot.selLayers && shot.selLayers.has(layer.id));
      const inFolder = layer.group && state.groups[layer.group];
      const li = el('li', { className: (layer.id === shot.activeLayerId && !shot.selGroup ? 'active' : '') + (picked ? ' selected' : '') + (layer.visible ? '' : ' hidden-layer') + (inFolder ? ' in-folder' : '') });
      if (inFolder && !inFolder.open) li.hidden = true;
      const eye = el('button', { className: 'icon-btn sm eye', title: layer.visible ? 'Hide layer' : 'Show layer' });
      eye.innerHTML = layer.visible ? ICONS.eye : ICONS.eyeOff;
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        layoutStack();
        refreshUI();
        for (const s of shotsWith(layer)) scheduleThumb(s);
        markDirty();
      });
      // Double-click the name to rename it (see startRename).
      const name = el('span', { className: 'name', textContent: layer.name, title: 'Double-click to rename' });
      li.dataset.layerId = layer.id;
      li.append(eye, name);
      // A linked layer (in several shots) shows a chain and how many shots.
      const shared = shotsWith(layer).length;
      if (shared > 1) {
        const badge = el('span', { className: 'link-badge num', title: `Linked in shots ${shotList(layer)}: drawing on it changes all of them` });
        badge.innerHTML = ICONS.link;
        badge.append(String(shared));
        li.append(badge);
      }
      li.addEventListener('pointerdown', (e) => {
        // The eye is its own button: pressing it must not redraw the list, or
        // the button is replaced before its click lands.
        if (e.target.closest('.eye') || e.target.closest('input')) return;
        // A second press on the same layer soon after renames it. (Picking a
        // layer redraws the list, so the browser's own double-click cannot be used.)
        const now = performance.now();
        const modified = e.ctrlKey || e.metaKey || e.shiftKey || state.multiLayers;
        if (!modified && lastLayerTap.id === layer.id && now - lastLayerTap.t < 450) {
          lastLayerTap = {};
          window.addEventListener('pointerup', () => startRename(layer), { once: true });
          return;
        }
        lastLayerTap = modified ? {} : { id: layer.id, t: now };
        // With Select several on (for the iPad, where there are no keys to hold), a tap adds or removes.
        selectLayer(shot, layer, e.ctrlKey || e.metaKey || state.multiLayers ? 'toggle' : e.shiftKey ? 'range' : 'one');
      });
      return li;
    });
    // Folders: a row above each folder's layers (top first, like the list).
    const rows = [];
    const shown = new Set();
    [...shot.layers].reverse().forEach((layer, i) => {
      const g = layer.group;
      if (g && state.groups[g] && !shown.has(g)) { shown.add(g); rows.push(folderRow(shot, g)); }
      rows.push(layerRows[i]);
    });
    // The reference video is its own track under every layer: shown here as a
    // locked bottom row so it is clear nothing is drawn onto it.
    if (state.reference) {
      const ref = state.reference;
      const li = el('li', { className: 'ref-row' + (ref.visible ? '' : ' hidden-layer'), title: 'Reference video: its own track under your layers. You cannot draw on it.' });
      const eye = el('button', { className: 'icon-btn sm eye', title: ref.visible ? 'Hide the reference video' : 'Show the reference video' });
      eye.innerHTML = ref.visible ? ICONS.eye : ICONS.eyeOff;
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        ref.visible = !ref.visible;
        layoutReference();
        syncReference();
        markDirty();
        renderInspector();
      });
      const label = el('span', { className: 'name ref-name' });
      label.append(el('span', { textContent: ref.name }));
      const lock = el('span', { className: 'ref-lock' });
      lock.innerHTML = ICONS.lock;
      // Its opacity, here where the layers' own controls are.
      const pct = Math.round(ref.opacity * 100);
      const op = el('input', { type: 'range', className: 'ref-op', min: 5, max: 100, value: pct, title: 'Video opacity' });
      const opVal = el('span', { className: 'ref-op-val num', textContent: `${pct}%` });
      op.addEventListener('click', (e) => e.stopPropagation());
      op.addEventListener('input', (e) => {
        ref.opacity = Number(e.target.value) / 100;
        opVal.textContent = `${e.target.value}%`;
        $('#refOpacity').value = e.target.value;
        $('#refOpacityVal').textContent = `${e.target.value}%`;
        layoutReference();
        markDirty();
      });
      li.append(eye, label, op, opVal, lock);
      rows.push(li);
    }
    $('#layers').replaceChildren(...rows);
    const many = selectedLayers(shot).length;
    $('#mergeLayers').hidden = many < 2;
    const cur = shot.layers.find((l) => l.id === shot.activeLayerId);
    const linkedIn = shotsWith(cur).length;
    const pickedLayers = selectedLayers(shot);
    $('#unlinkLayer').hidden = !pickedLayers.some((l) => shotsWith(l).length > 1);
    $('#ungroupLayers').hidden = !(shot.selGroup || (cur && cur.group && state.groups[cur.group]));
    $('#extendLayer').querySelector('span').textContent = pickedLayers.length > 1 ? `Extend ${pickedName(pickedLayers)} to next shot` : 'Extend to next shot';
    $('#linkHint').hidden = linkedIn < 2;
    if (linkedIn > 1) $('#linkHint').textContent = `${shot.selGroup ? pickedName(pickedLayers) : cur.name} is linked in shots ${shotList(cur)}. Drawing on it changes all of them.`;
    $('#mergeLayers').textContent = `Merge ${many} layers`;
    const al = shot.layers.find((l) => l.id === shot.activeLayerId);
    const op = Math.round((al ? al.opacity : 1) * 100);
    if (document.activeElement !== $('#layerOpacity')) $('#layerOpacity').value = op;
    $('#layerOpacityVal').textContent = `${op}%`;
    const blendSel = $('#layerBlend');
    if (!blendSel.options.length) for (const [k, b] of Object.entries(BLENDS)) blendSel.append(el('option', { value: k, textContent: b.label }));
    blendSel.value = (al && al.blend) || 'normal';
    const px = Math.round((al ? al.parallax ?? 1 : 1) * 100);
    if (document.activeElement !== $('#layerParallax')) $('#layerParallax').value = px;
    $('#layerParallaxVal').textContent = `${px}%`;
    $('#parallaxHint').textContent = !shot.camera
      ? 'Parallax works with a camera move. Turn on Camera movement below.'
      : px < 100 ? 'Further back: moves less during the camera move.'
      : px > 100 ? 'Nearer: moves more during the camera move.'
      : 'Under 100% sits further back and moves less; over 100% sits nearer and moves more.';

    // Shot
    $('#shotTitle').textContent = `Shot ${state.cur + 1} of ${state.shots.length}`;
    $('#tlShotName').textContent = `Shot ${state.cur + 1}`;
    const dur = $('#duration');
    if (document.activeElement !== dur) dur.value = +(shot.duration / state.fps).toFixed(2);
    $('#durationFrames').textContent = `${shot.duration}f`;
    $('#camToggle').classList.toggle('on', !!shot.camera);
    $('#camToggle').setAttribute('aria-checked', String(!!shot.camera));
    $('#camSwap').hidden = !shot.camera;
    $('#camEaseRow').hidden = !shot.camera;
    if (shot.camera) $('#camEase').value = shot.camera.ease || 'smooth';
    if (document.activeElement !== $('#shotNotes')) $('#shotNotes').value = shot.notes || '';
    $('#captionsOn').checked = !!state.captions;
    if (document.activeElement !== $('#captionSize')) $('#captionSize').value = Math.round(state.captionSize * 1000);
    $('#captionSizeVal').textContent = `${(state.captionSize * 100).toFixed(1)}%`;
    if (document.activeElement !== $('#captionBottom')) $('#captionBottom').value = Math.round(state.captionBottom * 1000);
    $('#captionBottomVal').textContent = `${(state.captionBottom * 100).toFixed(1)}%`;
    renderCaptionView();
  }
  const ref = state.reference;
  $('#secRef').hidden = !ref;
  if (ref) {
    $('#refName').textContent = ref.name;
    $('#refShow').classList.toggle('on', ref.visible);
    if (document.activeElement !== $('#refOpacity')) $('#refOpacity').value = Math.round(ref.opacity * 100);
    $('#refOpacityVal').textContent = `${Math.round(ref.opacity * 100)}%`;
  }
}

function toolPanel() {
  const head = (title) => el('div', { className: 'sec-head' }, el('h2', { textContent: title }));
  if (state.tool === 'move') {
    const seg = el('div', { className: 'seg' });
    for (const [mode, label] of [['free', 'Free'], ['distort', 'Distort'], ['warp', 'Warp']]) {
      const b = el('button', { className: 'seg-btn' + (state.moveMode === mode ? ' active' : ''), textContent: label });
      b.dataset.mode = mode;
      b.addEventListener('click', () => setMoveMode(mode));
      seg.append(b);
    }
    const hints = {
      free: 'Drag to move, drag a handle to stretch, drag the round handle above (or just outside a corner) to turn. Shift keeps the shape or snaps the turn to 15°, Alt stretches from the centre, Ctrl places without snapping. Arrows nudge.',
      distort: 'Drag each corner on its own, for perspective. Drag anywhere else to move it. Enter applies, Escape cancels.',
      warp: 'Drag the points to bend it. Drag anywhere else to move it. Enter applies, Escape cancels.',
    };
    return [head('Move'), seg, el('p', { className: 'hint', textContent: hints[state.moveMode] })];
  }
  if (state.tool === 'fill') {
    return [
      head('Fill'),
      el('p', { className: 'hint', textContent: 'Tap inside your lines to fill. It looks at every visible layer and fills on the current one.' }),
      sliderRow('Tolerance', state.fill.tolerance, 0, 120, 1, (v) => v, (v) => { state.fill.tolerance = v; }),
      sliderRow('Close gaps', state.fill.gap, 0, 12, 1, (v) => `${v}px`, (v) => { state.fill.gap = v; }),
    ];
  }
  if (state.tool === 'lasso') {
    const row = el('div', { className: 'btn-row' });
    const mk = (label, fn) => { const b = el('button', { className: 'text-btn', textContent: label }); b.addEventListener('click', fn); return b; };
    row.append(mk('Fill', () => paintSelection('fill')), mk('Clear', () => paintSelection('clear')), mk('Deselect', deselectStep));
    // What a new lasso does, for when there are no keys to hold (the iPad).
    const seg = el('div', { className: 'seg seg-4' });
    for (const [mode, label] of [['new', 'New'], ['add', 'Add'], ['sub', 'Cut'], ['and', 'Overlap']]) {
      const b = el('button', { className: 'seg-btn' + (state.lassoMode === mode ? ' active' : ''), textContent: label });
      b.dataset.mode = mode;
      b.addEventListener('click', () => { state.lassoMode = mode; refreshUI(); });
      seg.append(b);
    }
    return [
      head('Lasso'),
      seg,
      el('p', { className: 'hint', textContent: 'Draw around something to select it. Hold Shift to add another area, Ctrl to cut one out (or pick Add or Cut above). Drag inside the selection to move it. Brushes only paint inside a selection. Undo takes selections back too.' }),
      row,
    ];
  }
  if (state.tool === 'perspective') {
    const shot = current();
    const g = shot && shot.grid;
    if (!g) {
      const add = el('button', { className: 'text-btn', textContent: 'Add a grid to this shot' });
      add.addEventListener('click', ensureGrid);
      return [head('Perspective grid'), el('div', { className: 'btn-row' }, add)];
    }
    const row = el('div', { className: 'btn-row' });
    const mk = (label, title, fn) => { const b = el('button', { className: 'text-btn', textContent: label, title }); b.addEventListener('click', fn); return b; };
    row.append(
      mk('Straighten', 'Take the bends out', straightenGrid),
      mk('All shots', 'Copy this grid to every shot', copyGridToAll),
      mk('Remove', 'Remove the grid from this shot', removeGrid),
    );
    // Sliders change the grid live and record one undo step when let go.
    const live = (label, key, min, max, step, fmt) => {
      const r = sliderRow(label, g[key], min, max, step, fmt, (v) => { g[key] = v; renderGrid(); markDirty(); });
      const input = r.querySelector('input');
      let from = null;
      input.addEventListener('pointerdown', () => { from = structuredClone(g); });
      input.addEventListener('change', () => { if (from) { const to = structuredClone(g); g[key] = from[key]; setGrid(current(), to, from); from = null; } });
      return r;
    };
    return [
      head('Perspective grid'),
      el('p', { className: 'hint', textContent: 'Drag the corners to set the perspective, the blue dots to bend it, and inside it to move it.' }),
      switchRow('Show grid', g.visible, (v) => updateGrid({ visible: v })),
      switchRow('Snap strokes to grid', state.gridSnap, (v) => { state.gridSnap = v; }),
      live('Columns', 'cols', 1, 30, 1, (v) => v),
      live('Rows', 'rows', 1, 30, 1, (v) => v),
      live('Opacity', 'opacity', 0.1, 1, 0.01, (v) => `${Math.round(v * 100)}%`),
      row,
      el('div', { className: 'sec-head sub' }, el('h2', { textContent: 'Draw onto canvas' })),
      el('p', { className: 'hint', textContent: 'Puts the grid down as real lines on a new layer, in your current colour.' }),
      sliderRow('Line width', state.gridLine, 0.5, 12, 0.5, (v) => `${v}px`, (v) => { state.gridLine = v; }),
      switchRow('Include horizon', state.gridHorizon, (v) => { state.gridHorizon = v; }),
      switchRow('Include border', state.gridBorder, (v) => { state.gridBorder = v; }),
      (() => { const b = el('button', { className: 'solid-btn wide', textContent: 'Draw grid onto a new layer' }); b.addEventListener('click', stampGrid); return b; })(),
    ];
  }
  if (state.tool === 'pan') {
    return [head('Pan'), el('p', { className: 'hint', textContent: 'Drag to move around. Scroll to zoom, 0 to fit. Hold Space to pan from any tool.' })];
  }
  const b = brush();
  const list = el('div', { className: 'brush-list' });
  BRUSH_PRESETS.forEach((p, i) => {
    const item = el('button', { className: 'brush-item', title: `${p.name} (${i + 1})` });
    item.dataset.id = p.id;
    item.append(el('span', { className: 'brush-name', textContent: p.name }), brushPreview(state.brushes[p.id]));
    item.addEventListener('click', () => setBrush(p.id));
    list.append(item);
  });
  const rows = [head('Brush'), list];
  const pct = (v) => `${Math.round(v * 100)}%`;
  if (b.kind !== 'smear') rows.push(sliderRow('Pressure', 1 - b.minSize, 0, 1, 0.01, pct, (v) => { b.minSize = 1 - v; refreshPreview(b); }));
  if (b.kind === 'stamp') {
    rows.push(sliderRow('Flow', b.flow, 0.02, 1, 0.01, pct, (v) => { b.flow = v; }));
    rows.push(sliderRow('Scatter', b.scatter, 0, 1, 0.01, pct, (v) => { b.scatter = v; }));
    rows.push(sliderRow('Angle jitter', b.angleJitter, 0, 1, 0.01, pct, (v) => { b.angleJitter = v; }));
    rows.push(sliderRow('Paper texture', b.texture, 0, 0.8, 0.01, pct, (v) => { b.texture = v; }));
  }
  if (b.kind === 'solid' || b.kind === 'stamp' || b.kind === 'erase') {
    rows.push(sliderRow('Wiggle filter', b.cleanup || 0, 0, 10, 0.5, (v) => (v ? `${v}px` : 'Off'), (v) => { b.cleanup = v; }));
  }
  if (b.kind === 'solid' || b.kind === 'erase' || b.kind === 'stamp') {
    rows.push(sliderRow('Roundness', b.roundness, 0.1, 1, 0.01, pct, (v) => { b.roundness = v; refreshPreview(b); }));
    rows.push(sliderRow('Angle', b.angle, -90, 90, 1, (v) => `${v}°`, (v) => { b.angle = v; refreshPreview(b); }));
  }
  if (b.kind === 'air') rows.push(sliderRow('Flow', b.flow, 0.01, 0.4, 0.01, pct, (v) => { b.flow = v; }));
  if (b.kind === 'smear') {
    rows.push(el('p', { className: 'hint', textContent: 'Brush over the drawing the way it moves: it blurs along your stroke.' }));
    rows.push(sliderRow('Strength', b.strength, 0.05, 1, 0.01, pct, (v) => { b.strength = v; }));
    rows.push(sliderRow('Blur length', b.length, 4, 300, 1, (v) => `${v}px`, (v) => { b.length = v; }));
    rows.push(sliderRow('Feather', b.feather, 0, 1, 0.01, pct, (v) => { b.feather = v; }));
    rows.push(switchRow('Pressure sets strength', b.pressureStrength, (v) => { b.pressureStrength = v; }));
  }
  return rows;
}

function switchRow(label, value, onChange) {
  const sw = el('button', { className: 'switch' + (value ? ' on' : ''), type: 'button' });
  sw.append(el('span'));
  sw.addEventListener('click', () => {
    const on = !sw.classList.contains('on');
    sw.classList.toggle('on', on);
    onChange(on);
  });
  return el('div', { className: 'field-row' }, el('span', { textContent: label }), sw);
}

function refreshPreview(b) {
  const item = document.querySelector(`.brush-item[data-id="${b.id}"]`);
  if (item) item.querySelector('canvas').replaceWith(brushPreview(b));
}

// ---------------------------------------------------------------- colour wheel

// Hue ring around a saturation (left to right) and brightness (top to bottom)
// square, like Pencil2D's and PencilBoard's.
const wheel = { c: $('#wheel'), h: 0, s: 0, v: 0.1, drag: null, size: 200 };

function hsvToHex(h, s, v) {
  const f = (n) => {
    const k = (n + h / 60) % 6;
    return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255);
  };
  return `#${[f(5), f(3), f(1)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

function hexToHsv(hex) {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function wheelGeometry() {
  const S = wheel.size;
  const outer = S / 2 - 2;
  const inner = outer - 16;
  const half = (inner - 8) / Math.SQRT2;
  return { S, cx: S / 2, cy: S / 2, outer, inner, half };
}

function drawWheel() {
  const dpr = window.devicePixelRatio || 1;
  const { S, cx, cy, outer, inner, half } = wheelGeometry();
  const c = wheel.c;
  const px = Math.round(S * dpr);
  if (c.width !== px || c.height !== px) { c.width = px; c.height = px; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);
  // Hue ring
  const ring = ctx.createConicGradient(-Math.PI / 2, cx, cy);
  for (let i = 0; i <= 12; i++) ring.addColorStop(i / 12, `hsl(${i * 30}, 100%, 50%)`);
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, TAU);
  ctx.arc(cx, cy, inner, 0, TAU, true);
  ctx.fillStyle = ring;
  ctx.fill();
  // Shade square
  const x0 = cx - half;
  const y0 = cy - half;
  ctx.fillStyle = `hsl(${wheel.h}, 100%, 50%)`;
  ctx.fillRect(x0, y0, half * 2, half * 2);
  const white = ctx.createLinearGradient(x0, 0, x0 + half * 2, 0);
  white.addColorStop(0, '#fff');
  white.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = white;
  ctx.fillRect(x0, y0, half * 2, half * 2);
  const black = ctx.createLinearGradient(0, y0, 0, y0 + half * 2);
  black.addColorStop(0, 'rgba(0,0,0,0)');
  black.addColorStop(1, '#000');
  ctx.fillStyle = black;
  ctx.fillRect(x0, y0, half * 2, half * 2);
  // Markers
  const a = (wheel.h / 360) * TAU - Math.PI / 2;
  const rm = (outer + inner) / 2;
  const marker = (x, y) => {
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, TAU);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#fff';
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.stroke();
  };
  marker(cx + Math.cos(a) * rm, cy + Math.sin(a) * rm);
  marker(x0 + wheel.s * half * 2, y0 + (1 - wheel.v) * half * 2);
}

function wheelPick(e, mode) {
  const r = wheel.c.getBoundingClientRect();
  const { cx, cy, half } = wheelGeometry();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  if (mode === 'hue') {
    wheel.h = ((Math.atan2(y - cy, x - cx) + Math.PI / 2 + TAU) % TAU) * (180 / Math.PI);
  } else {
    wheel.s = clamp((x - (cx - half)) / (half * 2), 0, 1);
    wheel.v = clamp(1 - (y - (cy - half)) / (half * 2), 0, 1);
  }
  setColor(hsvToHex(wheel.h, wheel.s, wheel.v), { fromWheel: true, remember: false });
}

wheel.c.addEventListener('pointerdown', (e) => {
  const r = wheel.c.getBoundingClientRect();
  const { cx, cy, inner, outer, half } = wheelGeometry();
  const x = e.clientX - r.left - cx;
  const y = e.clientY - r.top - cy;
  const d = Math.hypot(x, y);
  let mode = null;
  if (d >= inner - 4 && d <= outer + 4) mode = 'hue';
  else if (Math.abs(x) <= half + 4 && Math.abs(y) <= half + 4) mode = 'shade';
  if (!mode) return;
  try { wheel.c.setPointerCapture(e.pointerId); } catch {}
  wheel.drag = { id: e.pointerId, mode };
  wheelPick(e, mode);
});
wheel.c.addEventListener('pointermove', (e) => {
  if (wheel.drag && wheel.drag.id === e.pointerId) wheelPick(e, wheel.drag.mode);
});
const endWheel = (e) => {
  if (!wheel.drag || wheel.drag.id !== e.pointerId) return;
  wheel.drag = null;
  setColor(state.color, { fromWheel: true });
};
wheel.c.addEventListener('pointerup', endWheel);
wheel.c.addEventListener('pointercancel', endWheel);

function renderSwatches() {
  drawWheel();
  const mk = (c) => {
    const s = el('button', { className: 'swatch' + (c.toLowerCase() === state.color.toLowerCase() ? ' active' : ''), title: c.toUpperCase() });
    s.style.background = c;
    s.addEventListener('click', () => setColor(c));
    return s;
  };
  $('#recent').replaceChildren(...state.recentColors.slice(0, 7).map(mk));
}

// remember: add to the recent colours row (not while dragging on the wheel).
function setColor(c, { fromWheel = false, remember = true } = {}) {
  if (!/^#[0-9a-f]{6}$/i.test(c)) return;
  state.color = c.toLowerCase();
  if (!fromWheel) {
    const hsv = hexToHsv(state.color);
    if (hsv.s > 0 && hsv.v > 0) wheel.h = hsv.h;
    wheel.s = hsv.s;
    wheel.v = hsv.v;
  }
  if (remember) state.recentColors = [state.color, ...state.recentColors.filter((x) => x !== state.color)].slice(0, 12);
  if (state.brushId === 'eraser' && state.tool === 'brush') setBrush(state.lastDrawBrush);
  renderInspector();
}

// ---------------------------------------------------------------- safe areas

// Action safe (5% in from each edge) and title safe (10%), as dashed guides.
const guides = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
guides.id = 'guides';
stage.append(guides);
state.safe = true;

function renderGuides() {
  guides.setAttribute('viewBox', `0 0 ${dims.CW} ${dims.CH}`);
  guides.setAttribute('width', dims.CW);
  guides.setAttribute('height', dims.CH);
  guides.style.display = state.safe ? '' : 'none';
  const fs = Math.max(10, Math.round(dims.H * 0.016));
  guides.innerHTML = [[0.05, 'Action safe'], [0.1, 'Title safe']].map(([m, label]) => {
    const x = dims.FX + dims.W * m;
    const y = dims.FY + dims.H * m;
    return `<rect x="${x}" y="${y}" width="${dims.W * (1 - 2 * m)}" height="${dims.H * (1 - 2 * m)}"/>` +
      `<text x="${x + fs * 0.4}" y="${y + fs * 1.2}" font-size="${fs}">${label}</text>`;
  }).join('');
  $('#safeBtn').classList.toggle('active', state.safe);
}

// ---------------------------------------------------------------- tab wheel

// Hold Tab for a ring of brushes and tools around the pointer; let go over one
// to switch to it. A click works too.
const RADIAL = [
  ...BRUSH_PRESETS.map((b) => ({ label: b.name, run: () => setBrush(b.id), on: () => state.tool === 'brush' && state.brushId === b.id })),
  { label: 'Fill', run: () => setTool('fill'), on: () => state.tool === 'fill' },
  { label: 'Move', run: () => setTool('move'), on: () => state.tool === 'move' },
  { label: 'Lasso', run: () => setTool('lasso'), on: () => state.tool === 'lasso' },
  { label: 'Perspective', run: () => setTool('perspective'), on: () => state.tool === 'perspective' },
  { label: 'Pan', run: () => setTool('pan'), on: () => state.tool === 'pan' },
];
let radial = null;
const lastPointer = { x: innerWidth / 2, y: innerHeight / 2 };
window.addEventListener('pointermove', (e) => {
  lastPointer.x = e.clientX;
  lastPointer.y = e.clientY;
  if (radial) hoverRadial(e.clientX, e.clientY);
}, true);

function openRadial() {
  if (radial || stroke || playing) return;
  const box = $('#radial');
  const n = RADIAL.length;
  const R = 140;
  const r0 = 46;
  const sector = (i) => {
    const a0 = (i / n) * TAU - Math.PI / 2 - Math.PI / n + 0.012;
    const a1 = ((i + 1) / n) * TAU - Math.PI / 2 - Math.PI / n - 0.012;
    const p = (r, a) => `${150 + Math.cos(a) * r},${150 + Math.sin(a) * r}`;
    return `M${p(r0, a0)}L${p(R, a0)}A${R},${R} 0 0 1 ${p(R, a1)}L${p(r0, a1)}A${r0},${r0} 0 0 0 ${p(r0, a0)}Z`;
  };
  box.innerHTML = `<svg width="300" height="300" viewBox="0 0 300 300">${RADIAL.map((item, i) => {
    const a = (i / n) * TAU - Math.PI / 2;
    const tx = 150 + Math.cos(a) * ((R + r0) / 2);
    const ty = 150 + Math.sin(a) * ((R + r0) / 2);
    return `<path class="slice${item.on() ? ' current' : ''}" data-i="${i}" d="${sector(i)}"/><text data-i="${i}" x="${tx}" y="${ty}">${item.label}</text>`;
  }).join('')}<circle class="hub" cx="150" cy="150" r="${r0 - 6}"/></svg>`;
  box.style.left = `${clamp(lastPointer.x, 150, innerWidth - 150)}px`;
  box.style.top = `${clamp(lastPointer.y, 150, innerHeight - 150)}px`;
  box.hidden = false;
  radial = { box, hovered: -1 };
  box.querySelectorAll('.slice').forEach((s) => s.addEventListener('click', () => closeRadial(Number(s.dataset.i))));
  hoverRadial(lastPointer.x, lastPointer.y);
}

function hoverRadial(x, y) {
  const r = radial.box.getBoundingClientRect();
  const dx = x - (r.left + 150);
  const dy = y - (r.top + 150);
  const n = RADIAL.length;
  let i = -1;
  if (Math.hypot(dx, dy) > 40) i = Math.round((((Math.atan2(dy, dx) + Math.PI / 2) / TAU) * n + n) % n) % n;
  radial.hovered = i;
  radial.box.querySelectorAll('[data-i]').forEach((node) => node.classList.toggle('hover', Number(node.dataset.i) === i));
}

function closeRadial(pick = radial ? radial.hovered : -1) {
  if (!radial) return;
  radial.box.hidden = true;
  radial = null;
  if (pick >= 0) RADIAL[pick].run();
}

// ---------------------------------------------------------------- controls

$('#tools').addEventListener('click', (e) => {
  const b = e.target.closest('.tool[data-tool]');
  if (b) setTool(b.dataset.tool);
});
$('#undoBtn').addEventListener('click', undo);
$('#redoBtn').addEventListener('click', redo);
$('#railSize').addEventListener('input', (e) => setSize(sliderToSize(Number(e.target.value))));
$('#railOpacity').addEventListener('input', (e) => { brush().opacity = Number(e.target.value) / 100; renderRail(); });
$('#onionBtn').addEventListener('click', toggleOnion);
$('#fitBtn').addEventListener('click', fitView);
$('#canvasBtn').addEventListener('click', () => openCanvasDialog('resize'));
$('#helpBtn').addEventListener('click', () => $('#helpDialog').showModal());
$('#helpClose').addEventListener('click', () => $('#helpDialog').close());
$('#speedBtn').addEventListener('click', () => { $('#helpDialog').close(); perf.toggleHud(); });
$('#newProject').addEventListener('click', newProject);
$('#open').addEventListener('click', openProject);
$('#save').addEventListener('click', () => save());
$('#exportBtn').addEventListener('click', openExport);
$('#exVideo').addEventListener('click', () => { $('#exportChoice').close(); exportVideo(); });
$('#exShots').addEventListener('click', () => { $('#exportChoice').close(); exportShots(); });
$('#exPdf').addEventListener('click', () => { $('#exportChoice').close(); exportPdf(); });
// Source files: asks first whether to put the board file in too (it is big,
// and only opens in this app, but it is the project file).
$('#exSource').addEventListener('click', () => { $('#exportChoice').close(); exportSource(); });
$('#exTimecode').addEventListener('change', (e) => { state.burnTimecode = e.target.checked; });
$('#exShotNo').addEventListener('change', (e) => { state.burnShot = e.target.checked; });
$('#exSource').hidden = typeof isWeb !== 'undefined' && isWeb;
// On the iPad each video would be its own download.
$('#exShots').hidden = typeof isWeb !== 'undefined' && isWeb;
$('#exSourceBoardRow').hidden = typeof isWeb !== 'undefined' && isWeb;
$('#exChoiceCancel').addEventListener('click', () => $('#exportChoice').close());
$('#shotNotes').addEventListener('input', (e) => {
  const shot = current();
  if (!shot) return;
  shot.notes = e.target.value;
  renderCaptionView();
  markDirty();
});

function openExport() {
  if (stroke || playing || exporting) return;
  $('#exPerPage').value = sheetPerPage();
  showSheetFit();
  $('#exportChoice').showModal();
}
// The grid and paper direction the board sheets will use, worked out from
// the number of shots per page.
function showSheetFit() {
  const L = sheetLayout(Math.min(sheetPerPage(), state.shots.length) || 1, dims.W / dims.H, state.shots.some((s) => s.notes && s.notes.trim()));
  const pages = Math.ceil(state.shots.length / sheetPerPage());
  $('#exPerPageFit').textContent = `(${L.cols} × ${L.rows}, ${L.landscape ? 'landscape' : 'portrait'}, ${pages} page${pages === 1 ? '' : 's'})`;
}
$('#exPerPage').addEventListener('input', (e) => {
  const n = Math.round(Number(e.target.value));
  if (!(n >= 1)) return;
  const v = Math.min(SHEET_MAX, n);
  if (v !== state.sheetPerPage) { state.sheetPerPage = v; markDirty(); }
  showSheetFit();
});
$('#exPerPage').addEventListener('change', (e) => { e.target.value = sheetPerPage(); });
$('#selMove').addEventListener('click', () => setTool('move'));
$('#selFill').addEventListener('click', () => paintSelection('fill'));
$('#selClear').addEventListener('click', () => paintSelection('clear'));
$('#selDone').addEventListener('click', deselectStep);

$('#colorPicker').addEventListener('input', (e) => setColor(e.target.value));
$('#colorHex').addEventListener('change', (e) => {
  let v = e.target.value.trim();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/i.test(v)) v = `#${v[1]}${v[1]}${v[2]}${v[2]}${v[3]}${v[3]}`;
  setColor(v);
});

$('#addLayer').addEventListener('click', addLayer);
$('#delLayer').addEventListener('click', deleteLayer);
$('#layerUp').addEventListener('click', () => moveLayer(1));
$('#layerDown').addEventListener('click', () => moveLayer(-1));
$('#layerOpacity').addEventListener('input', (e) => {
  const layer = activeLayer();
  if (!layer) return;
  layer.opacity = e.target.value / 100;
  $('#layerOpacityVal').textContent = `${e.target.value}%`;
  layoutStack();
  scheduleThumb();
  markDirty();
});

$('#dupShot').addEventListener('click', duplicateShot);
$('#delShot').addEventListener('click', deleteShot);
$('#duration').addEventListener('change', (e) => {
  const shot = current();
  const secs = parseFloat(e.target.value);
  if (!(secs > 0)) { renderInspector(); return; }
  setDuration(shot, secs * state.fps);
});
$('#camToggle').addEventListener('click', toggleCamera);
$('#camEase').addEventListener('change', (e) => {
  const shot = current();
  if (!shot || !shot.camera) return;
  const from = structuredClone(shot.camera);
  setCamera(shot, { ...shot.camera, ease: e.target.value }, from);
});
$('#safeBtn').addEventListener('click', () => { state.safe = !state.safe; renderGuides(); });
$('#camSwap').addEventListener('click', swapCamera);

$('#tlPlay').addEventListener('click', togglePlay);
$('#tlStart').addEventListener('click', goToStart);
$('#tlPrev').addEventListener('click', () => selectShot(state.cur - 1));
$('#tlNext').addEventListener('click', () => selectShot(state.cur + 1));
$('#tlAddShot').addEventListener('click', addShot);
$('#tlSplit').addEventListener('click', splitShot);
$('#tlVideo').addEventListener('click', importReference);
$('#refRemove').addEventListener('click', removeReference);
$('#refShow').addEventListener('click', () => {
  if (!state.reference) return;
  state.reference.visible = !state.reference.visible;
  layoutReference();
  syncReference();
  markDirty();
  renderInspector();
});
$('#refOpacity').addEventListener('input', (e) => {
  if (!state.reference) return;
  state.reference.opacity = e.target.value / 100;
  $('#refOpacityVal').textContent = `${e.target.value}%`;
  layoutReference();
  markDirty();
});
$('#tlAudio').addEventListener('click', importAudio);
$('#tlFit').addEventListener('click', fitTimeline);

function goToStart() {
  if (playing) stopPlay();
  state.time = 0;
  selectShot(0);
  tl.scroll.scrollLeft = 0;
}

function toggleOnion() {
  state.onion = !state.onion;
  enqueue(renderOnion);
  renderToolbar();
}

window.addEventListener('keydown', (e) => {
  const typing = (e.target instanceof HTMLInputElement && !['range', 'color'].includes(e.target.type)) || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement;
  if (typing && e.key !== 'Escape') return;
  if (document.querySelector('dialog[open]')) return;
  if (stroke) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (playing) {
    if (['enter', 'escape', ' '].includes(key)) { e.preventDefault(); stopPlay(); }
    return;
  }
  if (key === 'r' && !e.repeat) {
    rotateDown = true;
    viewport.dataset.tool = 'rotate';
    hideCursor();
    return;
  }
  if (e.code === 'Space') {
    e.preventDefault();
    if (!spaceDown) { spaceDown = true; viewport.dataset.tool = 'pan'; hideCursor(); }
    return;
  }
  if (ctrl) {
    if (key === 'z' && e.shiftKey) redo();
    else if (key === 'z') undo();
    else if (key === 'y') redo();
    else if (key === 's') save(e.shiftKey);
    else if (key === 'o') openProject();
    else if (key === 'n') newProject();
    else if (key === 'd') duplicateShot();
    else if (key === 'e') openExport();
    else if (key === 'k') splitShot();
    else if (key === 'c') copyLayers();
    else if (key === 'v') pasteLayers();
    else if (key === 'g' && e.shiftKey) ungroupLayers();
    else if (key === 'g') groupLayers();
    else return;
    e.preventDefault();
    return;
  }
  if (e.key === 'Tab') { e.preventDefault(); if (!e.repeat) openRadial(); return; }
  if (/^[1-9]$/.test(e.key)) { setBrush(BRUSH_PRESETS[Number(e.key) - 1].id); e.preventDefault(); return; }
  switch (key) {
    case 'b': setTool('brush'); break;
    case 'e': setTool('eraser'); break;
    case 'g': setTool('fill'); break;
    case 'l': setTool('lasso'); break;
    case '=': case '+': zoomTimeline(1.4); break;
    case '-': zoomTimeline(1 / 1.4); break;
    case '\\': fitTimeline(); break;
    case 'v': setTool('move'); break;
    case 'h': setTool('pan'); break;
    case 'p': setTool('perspective'); break;
    case '[': setSize(brush().size * 0.85 - 0.5); break;
    case ']': setSize(brush().size * 1.18 + 0.5); break;
    case 'n': addShot(); break;
    case 'o': toggleOnion(); break;
    case '0': fitView(); break;
    case 'home': goToStart(); break;
    case 'enter': if (adjust) closeAdjust(true); else if (filter) closeFilter(true); else if (meshLive()) applyMesh(); else togglePlay(); break;
    case 'escape': if (radial) closeRadial(-1); else if (adjust) closeAdjust(false); else if (filter) closeFilter(false); else if (meshLive()) cancelLift(); else deselectStep(); break;
    case 'f2': perf.toggleHud(); break;
    case 'arrowleft': case 'arrowright': case 'arrowup': case 'arrowdown':
      if ((state.selection && state.tool === 'lasso') || state.tool === 'move') {
        const step = e.shiftKey ? 10 : 1;
        nudgeSelection({ arrowleft: -step, arrowright: step }[key] || 0, { arrowup: -step, arrowdown: step }[key] || 0);
      } else if (key === 'arrowleft') selectShot(state.cur - 1);
      else if (key === 'arrowright') selectShot(state.cur + 1);
      else return;
      break;
    case ',': selectShot(state.cur - 1); break;
    case '.': selectShot(state.cur + 1); break;
    case 'delete': case 'backspace':
      if (e.shiftKey) deleteShot();
      else if (state.selection) paintSelection('clear');
      else clearLayer();
      break;
    default: return;
  }
  e.preventDefault();
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'Tab' && radial) { e.preventDefault(); closeRadial(); }
  if (e.code === 'Space') { spaceDown = false; viewport.dataset.tool = state.tool; refreshCursor(); }
  if (e.key.toLowerCase() === 'r') { rotateDown = false; viewport.dataset.tool = state.tool; refreshCursor(); }
});
window.addEventListener('blur', () => { spaceDown = false; rotateDown = false; viewport.dataset.tool = state.tool; });

// ---------------------------------------------------------------- speed readout

// Drawing performance numbers. F2 (or the button in Shortcuts) shows them.
const perf = {
  on: false,
  delay: [], // ms from the pen event being created to our handler running
  work: [], // ms spent drawing that event
  frames: [], // ms between screen frames while a stroke is active
  points: 0,
  positions: 0, // pen positions seen
  pressures: [], // raw pen pressure readings
  finer: 0, // ...of which were finer than a whole screen pixel
  last: 0,
  hud: null,
  sample(delay, work, n) {
    this.delay.push(delay);
    this.work.push(work);
    this.points += n;
  },
  reset() {
    this.delay = [];
    this.work = [];
    this.frames = [];
    this.points = 0;
    this.positions = 0;
    this.finer = 0;
    this.pressures = [];
  },
  start() {
    if (this.on) return;
    this.on = true;
    this.reset();
    const loop = (t) => {
      if (!this.on) return;
      if (stroke && this.last) this.frames.push(t - this.last);
      this.last = t;
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  },
  stat(a) {
    if (!a.length) return 'n/a';
    const s = [...a].sort((x, y) => x - y);
    const avg = s.reduce((x, y) => x + y, 0) / s.length;
    return `avg ${avg.toFixed(1)} / p95 ${s[Math.floor(s.length * 0.95)].toFixed(1)} / max ${s[s.length - 1].toFixed(1)} ms`;
  },
  lines() {
    return [
      `input delay   ${this.stat(this.delay)}`,
      `draw work     ${this.stat(this.work)}`,
      `frame gap     ${this.stat(this.frames)}`,
      `points/event  ${(this.points / Math.max(1, this.delay.length)).toFixed(1)}  (${this.delay.length} events)`,
      `pen pressure  ${this.pressures.length ? `typical ${Math.round([...this.pressures].sort((p, q) => p - q)[this.pressures.length >> 1] * 100)}% / max ${Math.round(Math.max(...this.pressures) * 100)}%` : 'n/a (not a pen)'}`,
      `pen precision ${this.positions ? (this.finer / this.positions > 0.2 ? 'finer than a pixel' : 'whole pixels') : 'n/a'}`,
    ];
  },
  toggleHud() {
    if (this.hud) {
      clearInterval(this.hud.timer);
      this.hud.remove();
      this.hud = null;
      this.on = false;
      return;
    }
    this.start();
    this.hud = el('pre', { id: 'perfHud', textContent: 'Draw a few strokes...' });
    viewport.append(this.hud);
    this.hud.timer = setInterval(() => {
      if (!this.delay.length) return;
      this.hud.textContent = this.lines().join('\n');
      this.reset();
    }, 2000);
  },
};

// ---------------------------------------------------------------- start

// Watches the drawing area itself, not just the window: it also changes size
// when panels around it change.
new ResizeObserver(() => {
  if (state.view.fit) fitView(); else renderCameraBoxes();
  drawRuler();
}).observe(viewport);
new ResizeObserver(() => drawRuler()).observe(tl.scroll);

// The GPU sets up its drawing paths on first use, which froze the first
// stroke for ~70ms. Do that work at launch, with marks nobody sees.
function warmUp() {
  segment(strokeCtx, { x: 4, y: 4, r: 3 }, { x: 12, y: 6, r: 4 });
  strokeCtx.clearRect(0, 0, 20, 20);
}

setDims(1920, 1080);
sizeSelectionLayer();
renderGuides();
setColor(state.color, { remember: false });
uiReady = true;
warmUp();
const ready = enqueue(async () => {
  await loadBlank();
  fitTimeline();
});
// Opens the project the app was started with, if any.
ready.then(async () => {
  if (query.has('selftest') || query.has('perf') || query.has('dragperf')) return;
  const res = await window.api.launchFile();
  if (res) {
    try {
      await enqueue(() => loadData(JSON.parse(res.text), res.path, res.parts ? res : null));
    } catch (err) {
      toast(`Could not open ${res.path.split(/[\\/]/).pop()}: ${err.message}`);
    }
  }
  if (query.has('launchcheck')) {
    window.api.selftestDone([`LAUNCH ${res ? 'opened' : 'no file'}: ${state.shots.length} shots, path ${state.path || 'none'}, title "${document.title}"`]);
  }
});

// The caption's size and how high it sits, for the whole board; the frame shows the result as it is set.
for (const [id, key, reset] of [['captionSize', 'captionSize', 0.03], ['captionBottom', 'captionBottom', 0.035]]) {
  const set = (v) => {
    state[key] = v;
    $(`#${id}Val`).textContent = `${(v * 100).toFixed(1)}%`;
    markDirty();
    renderCaptionView();
  };
  $(`#${id}`).addEventListener('input', (e) => set(Number(e.target.value) / 1000));
  $(`#${id}`).addEventListener('dblclick', (e) => { e.target.value = reset * 1000; set(reset); });
}
$('#captionsOn').addEventListener('change', (e) => {
  state.captions = e.target.checked;
  markDirty();
  renderCaptionView();
});

// The blend mode applies to every selected layer.
$('#layerBlend').addEventListener('change', (e) => {
  if (!mounted) return;
  for (const l of selectedLayers()) l.blend = e.target.value;
  layoutStack();
  scheduleThumb();
  markDirty();
  renderInspector();
});

const setParallax = (v) => {
  const layer = activeLayer();
  if (!layer) return;
  layer.parallax = v / 100;
  markDirty();
  renderInspector();
};
$('#layerParallax').addEventListener('input', (e) => setParallax(Number(e.target.value)));
$('#layerParallax').addEventListener('dblclick', (e) => { e.target.value = 100; setParallax(100); });

// Sliders follow a pen (or a finger) straight away. Windows passes a Wacom
// pen through Windows Ink, and the browser's own sliders can hold off moving
// until they are sure the pen is not scrolling, which feels like lag. With a
// pen, the app moves the slider itself, to wherever the pen is.
document.addEventListener('pointerdown', (e) => {
  const input = e.target;
  if (!(input instanceof HTMLInputElement) || input.type !== 'range' || e.pointerType === 'mouse' || e.button !== 0) return;
  e.preventDefault();
  try { input.setPointerCapture(e.pointerId); } catch {}
  input.focus({ preventScroll: true });
  const set = (ev) => {
    const r = input.getBoundingClientRect();
    const cs = getComputedStyle(input);
    const vertical = cs.writingMode.startsWith('vertical');
    const half = 8; // the thumb's centre stops this far from each end
    let t = vertical ? (ev.clientY - r.top - half) / (r.height - half * 2) : (ev.clientX - r.left - half) / (r.width - half * 2);
    t = clamp(t, 0, 1);
    if (cs.direction === 'rtl') t = 1 - t;
    const min = Number(input.min || 0);
    const max = Number(input.max || 100);
    const step = Number(input.step) || 1;
    const v = clamp(min + Math.round((t * (max - min)) / step) * step, min, max);
    if (Number(input.value) !== v) {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  set(e);
  const move = (ev) => { if (ev.pointerId === e.pointerId) set(ev); };
  const up = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    input.removeEventListener('pointermove', move);
    input.removeEventListener('pointerup', up);
    input.removeEventListener('pointercancel', up);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  input.addEventListener('pointermove', move);
  input.addEventListener('pointerup', up);
  input.addEventListener('pointercancel', up);
}, true);

// ---------------------------------------------------------------- panel tabs

// The right panel shows one tab at a time: the current tool's settings, the
// colour, the layers, or the shot. The last one used comes back next time.
const TOOL_TAB_NAMES = { brush: 'Brush', eraser: 'Eraser', fill: 'Fill', move: 'Move', lasso: 'Lasso', perspective: 'Grid', pan: 'Pan' };
function setInspectorTab(tab) {
  if (tab === 'color') tab = 'tool'; // Color shares the Brush tab now
  const inspector = $('#inspector');
  inspector.dataset.tab = tab;
  for (const b of document.querySelectorAll('#tabs .tab')) b.classList.toggle('active', b.dataset.tab === tab);
  inspector.scrollTop = 0;
  try { localStorage.setItem('inspectorTab', tab); } catch {}
}
function renderTabs() {
  const name = state.tool === 'brush' && state.brushId === 'eraser' ? 'Eraser' : TOOL_TAB_NAMES[state.tool] || 'Tool';
  const label = document.getElementById('tabToolName');
  if (label && label.textContent !== name) label.textContent = name;
}
for (const b of document.querySelectorAll('#tabs .tab')) b.addEventListener('click', () => setInspectorTab(b.dataset.tab));
$('#railColor').addEventListener('click', () => {
  setInspectorTab('tool');
  $('#secColor').scrollIntoView({ block: 'start', behavior: 'smooth' });
});
setInspectorTab((() => { try { return localStorage.getItem('inspectorTab') || 'tool'; } catch { return 'tool'; } })());

// ---------------------------------------------------------------- adjust menu

const adjustMenu = $('#adjustMenu');
$('#adjustBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  adjustMenu.hidden = !adjustMenu.hidden;
  $('#adjustBtn').classList.toggle('active', !adjustMenu.hidden);
});
adjustMenu.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-item')) return;
  adjustMenu.hidden = true;
  $('#adjustBtn').classList.remove('active');
});
window.addEventListener('pointerdown', (e) => {
  if (adjustMenu.hidden || e.target.closest('.menu-wrap')) return;
  adjustMenu.hidden = true;
  $('#adjustBtn').classList.remove('active');
}, true);

// Like Photoshop: click picks one layer, Ctrl-click adds or removes one,
// Shift-click picks the run between the current layer and this one. The
// highlighted layer is still the one you draw on.
// A folder's row in the Layers list: open/close arrow, an eye for all its
// layers, its name (double-press to rename) and, if linked, the shot count.
// Pressing it picks every layer in it, so Extend, Move, Delete and the arrows
// work on the whole folder.
let lastFolderTap = {};
function folderRow(shot, g) {
  const def = state.groups[g];
  const members = groupMembers(shot, g);
  const visible = members.some((l) => l.visible);
  const li = el('li', { className: 'folder-row' + (shot.selGroup === g ? ' active selected' : '') + (visible ? '' : ' hidden-layer') });
  li.dataset.group = g;
  const arrow = el('button', { className: 'icon-btn sm folder-arrow', title: def.open ? 'Close the folder' : 'Open the folder' });
  arrow.innerHTML = def.open ? ICONS.down : ICONS.right;
  arrow.addEventListener('click', (e) => { e.stopPropagation(); toggleGroupOpen(g); });
  const eye = el('button', { className: 'icon-btn sm eye', title: visible ? 'Hide the folder' : 'Show the folder' });
  eye.innerHTML = visible ? ICONS.eye : ICONS.eyeOff;
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    for (const l of members) l.visible = !visible;
    layoutStack();
    refreshUI();
    for (const s of new Set(members.flatMap((l) => shotsWith(l)))) scheduleThumb(s);
    markDirty();
  });
  const icon = el('span', { className: 'folder-icon' });
  icon.innerHTML = ICONS.folder;
  const name = el('span', { className: 'name', textContent: def.name, title: 'Double-click to rename' });
  li.append(arrow, eye, icon, name);
  const shared = Math.max(...members.map((l) => shotsWith(l).length));
  if (shared > 1) {
    const badge = el('span', { className: 'link-badge num', title: `Linked in shots ${shotList(members[members.length - 1])}: drawing on it changes all of them` });
    badge.innerHTML = ICONS.link;
    badge.append(String(shared));
    li.append(badge);
  }
  li.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.eye') || e.target.closest('.folder-arrow') || e.target.closest('input')) return;
    const now = performance.now();
    const modified = e.ctrlKey || e.metaKey || e.shiftKey || state.multiLayers;
    if (!modified && lastFolderTap.g === g && now - lastFolderTap.t < 450) {
      lastFolderTap = {};
      window.addEventListener('pointerup', () => startRename(def, li), { once: true });
      return;
    }
    lastFolderTap = modified ? {} : { g, t: now };
    selectGroup(shot, g, e.ctrlKey || e.metaKey || e.shiftKey || state.multiLayers ? 'toggle' : 'one');
  });
  return li;
}

function selectLayer(shot, layer, how) {
  const sel = shot.selLayers || (shot.selLayers = new Set());
  if (shot.selGroup) { shot.selGroup = null; if (how === 'one') { sel.clear(); shot.activeLayerId = layer.id; layoutStack(); refreshUI(); return; } }
  // Nothing changes: leave the list alone (so renaming can start, too).
  if (how === 'one' && shot.activeLayerId === layer.id && sel.size === 0) return;
  if (how === 'one') {
    sel.clear();
    shot.activeLayerId = layer.id;
  } else if (how === 'toggle') {
    sel.add(shot.activeLayerId);
    if (sel.has(layer.id) && sel.size > 1) {
      sel.delete(layer.id);
      if (shot.activeLayerId === layer.id) shot.activeLayerId = [...sel].pop();
    } else {
      sel.add(layer.id);
      shot.activeLayerId = layer.id;
    }
  } else {
    const ids = shot.layers.map((l) => l.id);
    const a = ids.indexOf(shot.activeLayerId);
    const b = ids.indexOf(layer.id);
    sel.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) sel.add(ids[i]);
    shot.activeLayerId = layer.id;
  }
  if (sel.size < 2) sel.clear();
  layoutStack();
  refreshUI();
}
$('#mergeLayers').addEventListener('click', () => mergeLayers());
$('#extendLayer').addEventListener('click', () => extendLayer());
$('#extendLayerTop').addEventListener('click', () => extendLayer());
$('#groupLayers').addEventListener('click', () => groupLayers());
$('#ungroupLayers').addEventListener('click', () => ungroupLayers());
$('#unlinkLayer').addEventListener('click', () => unlinkLayer());
$('#layerMulti').addEventListener('click', () => {
  state.multiLayers = !state.multiLayers;
  $('#layerMulti').classList.toggle('active', state.multiLayers);
  toast(state.multiLayers ? 'Tap layers to add them to the selection' : 'Back to picking one layer at a time');
});

let lastLayerTap = {};
// Swaps the layer's name for a text box; Enter or clicking away keeps the new
// name, Escape leaves it as it was.
function startRename(layer, row = document.querySelector(`#layers li[data-layer-id="${layer.id}"]`)) {
  const label = row && row.querySelector('.name');
  if (!label) return;
  const input = el('input', { className: 'name renaming', value: layer.name, spellcheck: false });
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (keep && v && v !== layer.name) { layer.name = v; markDirty(); }
    renderInspector();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  label.replaceWith(input);
  input.focus();
  input.select();
}

$('#meshApply').addEventListener('click', () => applyMesh());
$('#meshCancel').addEventListener('click', () => cancelLift());

$('#copyLayers').addEventListener('click', () => copyLayers());
$('#pasteLayers').addEventListener('click', () => pasteLayers());
