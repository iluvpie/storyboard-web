'use strict';
// Camera moves: a Start and an End frame per shot, drawn over the canvas.
// Drag a label to move that frame, drag a corner to zoom it. Playback eases
// from Start to End across the shot.

const camLayer = $('#camLayer');
let camDrag = null;

const DEFAULT_CAMERA = () => ({ start: { x: 0, y: 0, s: 1 }, end: { x: 0, y: 0, s: 0.8 } });

function renderCameraBoxes() {
  const shot = current();
  if (!shot || !shot.camera || playing || scrub) { camLayer.replaceChildren(); return; }
  const { z, r: rot } = state.view;
  const boxes = ['start', 'end'].map((key) => {
    const r = camRect(shot.camera[key]);
    const corner = toScreen({ x: r.x, y: r.y });
    const el = document.createElement('div');
    el.className = `cam-box cam-${key}`;
    Object.assign(el.style, {
      left: `${corner.x}px`, top: `${corner.y}px`, width: `${r.w * z}px`, height: `${r.h * z}px`,
      transform: `rotate(${rot}rad)`,
    });
    const tag = document.createElement('div');
    tag.className = 'cam-tag cam-handle';
    tag.textContent = key === 'start' ? 'Start' : 'End';
    tag.title = 'Drag to move this camera frame';
    tag.addEventListener('pointerdown', (e) => beginCamDrag(e, shot, key, 'move'));
    el.append(tag);
    for (const corner of ['nw', 'ne', 'sw', 'se']) {
      const h = document.createElement('div');
      h.className = `cam-corner cam-handle cam-${corner}`;
      h.title = 'Drag to zoom this camera frame';
      h.addEventListener('pointerdown', (e) => beginCamDrag(e, shot, key, 'scale'));
      el.append(h);
    }
    return el;
  });
  // A piece of a split move: where the camera is as this piece begins.
  if (shot.camera.range && shot.camera.range[0] > 0) {
    const r = camRect(camAt(shot, 0));
    const corner = toScreen({ x: r.x, y: r.y });
    const el = document.createElement('div');
    el.className = 'cam-box cam-now';
    Object.assign(el.style, { left: `${corner.x}px`, top: `${corner.y}px`, width: `${r.w * z}px`, height: `${r.h * z}px`, transform: `rotate(${rot}rad)` });
    const tag = document.createElement('div');
    tag.className = 'cam-tag';
    tag.textContent = 'This shot';
    el.append(tag);
    boxes.push(el);
  }
  camLayer.replaceChildren(...boxes);
}

function beginCamDrag(e, shot, key, mode) {
  if (e.button !== 0) return;
  e.stopPropagation();
  e.preventDefault();
  try { e.target.setPointerCapture(e.pointerId); } catch {}
  const r = camRect(shot.camera[key]);
  camDrag = {
    id: e.pointerId,
    shot,
    key,
    mode,
    from: structuredClone(shot.camera),
    cam0: { ...shot.camera[key] },
    p0: toCanvas(e),
    center: { x: r.x + r.w / 2, y: r.y + r.h / 2 },
  };
  const move = (ev) => {
    if (!camDrag || ev.pointerId !== camDrag.id) return;
    const p = toCanvas(ev);
    const cam = camDrag.shot.camera[camDrag.key];
    if (camDrag.mode === 'move') {
      cam.x = camDrag.cam0.x + (p.x - camDrag.p0.x);
      cam.y = camDrag.cam0.y + (p.y - camDrag.p0.y);
    } else {
      const d0 = Math.hypot(camDrag.p0.x - camDrag.center.x, camDrag.p0.y - camDrag.center.y) || 1;
      const d1 = Math.hypot(p.x - camDrag.center.x, p.y - camDrag.center.y);
      cam.s = clamp(camDrag.cam0.s * (d1 / d0), 0.05, 3);
    }
    renderCameraBoxes();
  };
  const up = (ev) => {
    if (!camDrag || ev.pointerId !== camDrag.id) return;
    const d = camDrag;
    camDrag = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    setCamera(d.shot, d.shot.camera, d.from);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function toggleCamera() {
  const shot = current();
  if (!shot) return;
  const from = shot.camera;
  setCamera(shot, from ? null : DEFAULT_CAMERA(), from);
  if (!from) toast('Drag the Start and End labels to move them, and the corners to zoom');
}

function swapCamera() {
  const shot = current();
  if (!shot || !shot.camera) return;
  const from = structuredClone(shot.camera);
  setCamera(shot, { ...from, start: from.end, end: from.start }, from);
}
