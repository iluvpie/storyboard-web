'use strict';
// The timeline: shots as clips you can trim and drag to reorder, a playhead you
// scrub on the ruler, and an audio track.

const tl = {
  ppf: 4, // pixels per frame
  scroll: $('#tlScroll'),
  content: $('#tlContent'),
  ruler: $('#tlRuler'),
  shotTrack: $('#shotTrack'),
  audioTrack: $('#audioTrack'),
  playhead: $('#playhead'),
  drag: null,
  clipEls: new Map(),
};
const TL_X0 = 16;
const PPF_MIN = 0.3;
const PPF_MAX = 60;

const frameToX = (f) => TL_X0 + f * tl.ppf;
const xToFrame = (x) => (x - TL_X0) / tl.ppf;

function audioFrames() {
  return state.audio ? state.audio.buffer.duration * state.fps : 0;
}

function contentX(clientX) {
  return clientX - tl.content.getBoundingClientRect().left;
}

// ---------------------------------------------------------------- render

function renderTimeline() {
  const starts = shotStarts();
  const total = totalFrames();
  const refEnd = state.reference ? state.reference.offset + state.reference.duration * state.fps : 0;
  const end = Math.max(total, state.audio ? state.audio.offset + audioFrames() : 0, refEnd);
  tl.content.style.width = `${frameToX(end) + Math.max(400, tl.scroll.clientWidth * 0.5)}px`;

  const seen = new Set();
  // The shots the current layer is linked in get a band along their top, like
  // one long clip on a track in Procreate Dreams.
  const al = mounted ? activeLayer() : null;
  const linked = al && shotsWith(al).length > 1 ? al : null;
  const clips = state.shots.map((shot, i) => {
    seen.add(shot.id);
    let el = tl.clipEls.get(shot.id);
    if (!el) { el = makeClip(shot); tl.clipEls.set(shot.id, el); }
    // Clips sit on their own layers and are placed with a transform, so when a
    // trim shifts every clip after it, nothing has to be repainted; only the
    // clip being stretched redraws. Values are only written when they change.
    el.x = frameToX(starts[i]);
    if (!tl.drag || tl.drag.el !== el || tl.drag.kind !== 'move') setStyle(el, 'transform', `translateX(${el.x}px)`);
    setStyle(el, 'width', `${Math.max(2, shot.duration * tl.ppf - 2)}px`);
    el.classList.toggle('current', i === state.cur);
    el.classList.toggle('narrow', shot.duration * tl.ppf < 56);
    el.classList.toggle('linked', !!linked && shot.layers.includes(linked));
    setText(el.parts.num, i + 1);
    setText(el.parts.dur, `${(shot.duration / state.fps).toFixed(shot.duration % state.fps ? 2 : 0)}s`);
    if (el.parts.cam.hidden !== !shot.camera) el.parts.cam.hidden = !shot.camera;
    if (shot.thumbUrl) refreshClipThumb(shot, el);
    else if (!shot.thumb) queueThumb(shot);
    return el;
  });
  for (const id of [...tl.clipEls.keys()]) if (!seen.has(id)) tl.clipEls.delete(id);
  const marker = tl.shotTrack.querySelector('.drop-marker') || Object.assign(document.createElement('div'), { className: 'drop-marker' });
  const kids = tl.shotTrack.children;
  const same = kids.length === clips.length + 1 && clips.every((c, i) => kids[i] === c) && kids[clips.length] === marker;
  if (!same) tl.shotTrack.replaceChildren(...clips, marker);

  renderAudioClip();
  renderReferenceClip();
  drawRuler();
  placePlayhead();
}

function setStyle(el, prop, value) {
  if (el.style[prop] !== value) el.style[prop] = value;
}
function setText(node, value) {
  const text = String(value);
  if (node.textContent !== text) node.textContent = text;
}

function refreshClipThumb(shot, el = tl.clipEls.get(shot.id)) {
  if (!el || !shot.thumbUrl) return;
  const holder = el.querySelector('.clip-thumb');
  const url = `url("${shot.thumbUrl}")`;
  if (holder.style.backgroundImage !== url) holder.style.backgroundImage = url;
}

function placePlayhead(follow = false) {
  const x = frameToX(state.time);
  tl.playhead.style.transform = `translateX(${x}px)`;
  $('#tcNow').textContent = timecode(state.time);
  $('#tcTotal').textContent = timecode(totalFrames());
  syncReference();
  if (follow) {
    const left = tl.scroll.scrollLeft;
    const w = tl.scroll.clientWidth;
    if (x > left + w - 60 || x < left) tl.scroll.scrollLeft = x - 80;
  }
}

function drawRuler() {
  const c = tl.ruler;
  const dpr = window.devicePixelRatio || 1;
  const w = tl.scroll.clientWidth;
  const h = 26;
  if (c.width !== Math.round(w * dpr)) {
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    c.style.width = `${w}px`;
    c.style.height = `${h}px`;
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const left = tl.scroll.scrollLeft;
  const fps = state.fps;
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const secStep = steps.find((s) => s * fps * tl.ppf >= 70) || 600;
  const minor = tl.ppf >= 6 ? 1 : Math.max(1, Math.round((secStep * fps) / 5));
  const f0 = Math.max(0, Math.floor(xToFrame(left) / minor) * minor);
  const f1 = xToFrame(left + w);
  ctx.font = '10px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
  ctx.textBaseline = 'top';
  for (let f = f0; f <= f1; f += minor) {
    const x = Math.round(frameToX(f) - left) + 0.5;
    const major = f % (secStep * fps) === 0;
    ctx.strokeStyle = major ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.12)';
    ctx.beginPath();
    ctx.moveTo(x, major ? 12 : 19);
    ctx.lineTo(x, h);
    ctx.stroke();
    if (major) {
      const s = f / fps;
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillText(`${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`, x + 4, 2);
    }
  }
  // Shot boundaries, faintly.
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  for (const s of shotStarts()) {
    const x = frameToX(s) - left;
    if (x >= -2 && x <= w) ctx.fillRect(Math.round(x), h - 6, 1, 6);
  }
}

// ---------------------------------------------------------------- clips

function makeClip(shot) {
  const el = document.createElement('div');
  el.className = 'clip';
  el.innerHTML = `
    <div class="clip-thumb"></div>
    <div class="clip-meta"><span class="clip-num"></span><span class="clip-cam" title="Camera move" hidden>${ICONS.camera}</span><span class="clip-dur num"></span></div>
    <div class="trim trim-l" title="Drag to change length"></div>
    <div class="trim trim-r" title="Drag to change length"></div>`;
  el.parts = { num: el.querySelector('.clip-num'), dur: el.querySelector('.clip-dur'), cam: el.querySelector('.clip-cam') };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || playing) return;
    e.preventDefault();
    const edge = e.target.closest('.trim');
    try { el.setPointerCapture(e.pointerId); } catch {}
    tl.drag = {
      kind: edge ? (edge.classList.contains('trim-l') ? 'trimL' : 'trimR') : 'press',
      shot,
      el,
      id: e.pointerId,
      x0: e.clientX,
      dur0: shot.duration,
      from: state.shots.indexOf(shot),
      to: -1,
    };
    if (edge) document.body.classList.add('trimming');
    // Gets the clip its own layer now, so the first frame of a drag does not stall.
    else el.classList.add('pressed');
  });
  el.addEventListener('pointermove', (e) => {
    const d = tl.drag;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0;
    if (d.kind === 'trimL' || d.kind === 'trimR') {
      const delta = Math.round(dx / tl.ppf);
      let dur = Math.max(1, d.kind === 'trimR' ? d.dur0 + delta : d.dur0 - delta);
      // The clip's end snaps to the playhead, the cuts before it, and the
      // other tracks' ends.
      const i = state.shots.indexOf(d.shot);
      const start = shotStarts()[i];
      const marks = snapMarks({ cuts: false }).concat(shotStarts().slice(0, i + 1));
      const hit = e.ctrlKey ? null : snapFrame(start + dur, marks.filter((m) => m > start));
      if (hit !== null) dur = hit - start;
      d.shot.duration = dur;
      showSnapLine(hit);
      renderTimeline();
      showTimelineTip(e.clientX, `${(d.shot.duration / state.fps).toFixed(2)}s  ${d.shot.duration}f`);
      return;
    }
    if (d.kind === 'press' && Math.abs(dx) > 4) {
      d.kind = 'move';
      el.classList.add('dragging');
    }
    if (d.kind === 'move') {
      el.style.transform = `translateX(${el.x + dx}px)`;
      d.to = dropIndex(xToFrame(contentX(e.clientX)), d.from);
      showDropMarker(d.to, d.from);
    }
  });
  const finish = (e) => {
    const d = tl.drag;
    if (!d || d.id !== e.pointerId) return;
    tl.drag = null;
    document.body.classList.remove('trimming');
    hideTimelineTip();
    showSnapLine(null);
    el.classList.remove('dragging', 'pressed');
    tl.shotTrack.querySelector('.drop-marker').style.display = 'none';
    if (d.kind === 'trimL' || d.kind === 'trimR') {
      setDuration(d.shot, d.shot.duration, { from: d.dur0 });
    } else if (d.kind === 'move') {
      el.style.transform = `translateX(${el.x}px)`;
      if (d.to >= 0 && d.to !== d.from) moveShot(d.from, d.to); else renderTimeline();
    } else {
      selectShot(state.shots.indexOf(d.shot)).then(() => {
        state.time = shotStarts()[state.cur];
        placePlayhead();
      });
    }
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  return el;
}

// Where a dragged shot would land: the number of other shots whose middle is
// left of the pointer.
function dropIndex(frame, from) {
  const starts = shotStarts();
  let to = 0;
  state.shots.forEach((s, i) => {
    if (i !== from && starts[i] + s.duration / 2 < frame) to++;
  });
  return to;
}

function showDropMarker(to, from) {
  const starts = shotStarts();
  const others = state.shots.map((s, i) => i).filter((i) => i !== from);
  let frame;
  if (to < others.length) frame = starts[others[to]];
  else { const last = others[others.length - 1]; frame = last === undefined ? 0 : starts[last] + state.shots[last].duration; }
  const m = tl.shotTrack.querySelector('.drop-marker');
  m.style.display = 'block';
  m.style.transform = `translateX(${frameToX(frame) - 1}px)`;
}

let tipEl = null;
function showTimelineTip(clientX, text) {
  if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tl-tip num'; document.body.append(tipEl); }
  tipEl.textContent = text;
  tipEl.style.display = 'block';
  const r = tl.shotTrack.getBoundingClientRect();
  tipEl.style.left = `${clientX}px`;
  tipEl.style.top = `${r.top - 30}px`;
}
function hideTimelineTip() { if (tipEl) tipEl.style.display = 'none'; }

// ---------------------------------------------------------------- audio track

let audioEl = null;
function renderAudioClip() {
  const a = state.audio;
  if (!a) {
    audioEl = null;
    tl.audioTrack.innerHTML = '<div class="audio-empty">Drop an audio file here, or use Add audio</div>';
    return;
  }
  if (!audioEl || audioEl.dataset.name !== a.name) {
    audioEl = document.createElement('div');
    audioEl.className = 'audio-clip';
    audioEl.dataset.name = a.name;
    audioEl.innerHTML = `<canvas class="wave"></canvas><span class="audio-name"></span>
      <button class="audio-mute icon-btn" title="Mute">${ICONS.volume}</button>
      <button class="audio-remove icon-btn" title="Remove audio">${ICONS.close}</button>`;
    audioEl.querySelector('.audio-name').textContent = a.name;
    audioEl.querySelector('.audio-remove').addEventListener('click', (e) => { e.stopPropagation(); removeAudio(); });
    audioEl.querySelector('.audio-mute').addEventListener('click', (e) => {
      e.stopPropagation();
      a.muted = !a.muted;
      markDirty();
      renderAudioClip();
    });
    audioEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || playing) return;
      try { audioEl.setPointerCapture(e.pointerId); } catch {}
      tl.drag = { kind: 'audio', id: e.pointerId, x0: e.clientX, off0: a.offset };
    });
    audioEl.addEventListener('pointermove', (e) => {
      const d = tl.drag;
      if (!d || d.kind !== 'audio' || d.id !== e.pointerId) return;
      a.offset = d.off0 + Math.round((e.clientX - d.x0) / tl.ppf);
      const hit = e.ctrlKey ? null : snapSpan(a.offset, Math.round(audioFrames()), snapMarks({ audio: false }));
      if (hit) a.offset = hit.start;
      showSnapLine(hit && hit.at);
      renderAudioClip();
      showTimelineTip(e.clientX, `starts at ${timecode(Math.max(0, a.offset))}${a.offset < 0 ? ` (${(-a.offset / state.fps).toFixed(2)}s trimmed)` : ''}`);
    });
    const done = (e) => {
      const d = tl.drag;
      if (!d || d.kind !== 'audio' || d.id !== e.pointerId) return;
      tl.drag = null;
      hideTimelineTip();
      showSnapLine(null);
      if (a.offset !== d.off0) markDirty();
      renderTimeline();
    };
    audioEl.addEventListener('pointerup', done);
    audioEl.addEventListener('pointercancel', done);
    tl.audioTrack.replaceChildren(audioEl);
  }
  const width = Math.max(4, audioFrames() * tl.ppf);
  audioEl.style.left = `${frameToX(a.offset)}px`;
  audioEl.style.width = `${width}px`;
  audioEl.classList.toggle('muted', !!a.muted);
  drawWave(audioEl.querySelector('.wave'), width);
}

function drawWave(c, width) {
  const a = state.audio;
  const cw = Math.min(8000, Math.round(width));
  const h = 34;
  if (c.dataset.key === `${cw}|${a.name}`) return;
  c.dataset.key = `${cw}|${a.name}`;
  c.width = cw;
  c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  const peaks = a.peaks;
  for (let x = 0; x < cw; x++) {
    const i0 = Math.floor((x / cw) * peaks.length);
    const i1 = Math.max(i0 + 1, Math.floor(((x + 1) / cw) * peaks.length));
    let m = 0;
    for (let i = i0; i < i1; i++) m = Math.max(m, peaks[i]);
    const bh = Math.max(1, m * (h - 4));
    ctx.fillRect(x, (h - bh) / 2, 1, bh);
  }
}

// ---------------------------------------------------------------- scrubbing and zoom

let scrubbing = null;
function scrubFromEvent(e) {
  let f = clamp(xToFrame(contentX(e.clientX)), 0, Math.max(0, totalFrames() - 0.001));
  // Shift, like Premiere: the playhead snaps to the cuts between shots.
  if (e.shiftKey) {
    const hit = snapFrame(f, shotStarts());
    if (hit !== null) f = Math.min(hit, totalFrames() - 0.001);
  }
  scrubTo(Math.floor(f));
}

// ---------------------------------------------------------------- snapping
//
// Like Premiere and Procreate Dreams: dragging a clip's end, the audio or the
// video snaps to the playhead (and cuts, and the other tracks' ends) when it
// comes within a few pixels, with a line showing where. Ctrl drags freely.
const SNAP_REACH = 8; // screen pixels
const snapLine = Object.assign(document.createElement('div'), { className: 'snap-line' });
tl.content.append(snapLine);

function snapFrame(f, targets) {
  let best = null;
  for (const t of targets) if (Math.abs(t - f) * tl.ppf <= SNAP_REACH && (best === null || Math.abs(t - f) < Math.abs(best - f))) best = t;
  return best;
}
// Snaps a span (start, length) by whichever end is nearer a target.
function snapSpan(start, length, targets) {
  const a = snapFrame(start, targets);
  const b = snapFrame(start + length, targets);
  if (a === null && b === null) return null;
  if (b === null || (a !== null && Math.abs(a - start) <= Math.abs(b - start - length))) return { start: a, at: a };
  return { start: b - length, at: b };
}
function snapMarks({ cuts = true, audio = true, reference = true } = {}) {
  const marks = [Math.round(state.time), 0];
  if (cuts) marks.push(...shotStarts(), totalFrames());
  if (audio && state.audio) marks.push(state.audio.offset, state.audio.offset + Math.round(audioFrames()));
  if (reference && state.reference) marks.push(state.reference.offset, state.reference.offset + Math.round(state.reference.duration * state.fps));
  return marks;
}
function showSnapLine(frame) {
  if (frame === null || frame === undefined) { snapLine.style.display = 'none'; return; }
  snapLine.style.left = `${frameToX(frame)}px`;
  snapLine.style.display = 'block';
}

// Zooms around the playhead (or the middle, if the playhead is off screen).
function zoomTimeline(factor) {
  const r = tl.scroll.getBoundingClientRect();
  let ax = r.left + frameToX(state.time) - tl.scroll.scrollLeft;
  if (ax < r.left || ax > r.right) ax = r.left + r.width / 2;
  setZoom(tl.ppf * factor, ax);
}

tl.ruler.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || playing) return;
  try { tl.ruler.setPointerCapture(e.pointerId); } catch {}
  scrubbing = e.pointerId;
  scrubFromEvent(e);
});
tl.ruler.addEventListener('pointermove', (e) => { if (scrubbing === e.pointerId) scrubFromEvent(e); });
const endRulerScrub = (e) => {
  if (scrubbing !== e.pointerId) return;
  scrubbing = null;
  endScrub();
};
tl.ruler.addEventListener('pointerup', endRulerScrub);
tl.ruler.addEventListener('pointercancel', endRulerScrub);

tl.scroll.addEventListener('scroll', () => drawRuler());
tl.scroll.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.altKey) setZoom(tl.ppf * Math.exp(-e.deltaY * 0.002), e.clientX);
  else tl.scroll.scrollLeft += e.deltaY + e.deltaX;
}, { passive: false });

function setZoom(ppf, anchorClientX) {
  const r = tl.scroll.getBoundingClientRect();
  const ax = anchorClientX === undefined ? r.width / 2 : anchorClientX - r.left;
  const f = xToFrame(tl.scroll.scrollLeft + ax);
  tl.ppf = clamp(ppf, PPF_MIN, PPF_MAX);
  renderTimeline();
  tl.scroll.scrollLeft = frameToX(f) - ax;
  $('#tlZoom').value = (Math.log(tl.ppf / PPF_MIN) / Math.log(PPF_MAX / PPF_MIN)) * 100;
}

$('#tlZoom').addEventListener('input', (e) => {
  setZoom(PPF_MIN * (PPF_MAX / PPF_MIN) ** (e.target.value / 100));
});

// Fits the whole board into the visible timeline.
function fitTimeline() {
  const total = Math.max(1, totalFrames());
  setZoom(Math.min(10, (tl.scroll.clientWidth - TL_X0 - 60) / total));
  tl.scroll.scrollLeft = 0;
}

// Audio files dropped anywhere on the timeline.
const timelineEl = $('#timeline');
timelineEl.addEventListener('dragover', (e) => {
  if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); timelineEl.classList.add('drop-ok'); }
});
timelineEl.addEventListener('dragleave', () => timelineEl.classList.remove('drop-ok'));
timelineEl.addEventListener('drop', async (e) => {
  timelineEl.classList.remove('drop-ok');
  const video = [...e.dataTransfer.files].find((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(f.name));
  if (video) {
    e.preventDefault();
    await useVideo(window.api.pathForFile(video));
    return;
  }
  const file = [...e.dataTransfer.files].find((f) => f.type.startsWith('audio/') || /\.(mp3|wav|m4a|aac|ogg|flac)$/i.test(f.name));
  if (!file) return;
  e.preventDefault();
  await loadAudio(new Uint8Array(await file.arrayBuffer()), file.name, file.type, 0);
});
