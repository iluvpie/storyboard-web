'use strict';
// Reference video: a video (say, a rough animatic from another app) shown under
// the drawing inside the frame, in step with the playhead, to board or clean
// up over. It plays under the boards in playback but never goes into exports.
//
// The project stores the video's file path, not the video itself, so boards
// stay small. Formats Chromium cannot play are converted once with ffmpeg.

const refVideo = $('#refVideo');
const refTrack = $('#refTrack');
state.reference = null; // { path, proxy, name, offset (frames), opacity, visible, duration, vw, vh }

// file:/// URL for a Windows or POSIX path, with every part escaped (paths can
// hold spaces and Chinese characters).
function fileUrl(p) {
  const parts = p.replace(/\\/g, '/').split('/');
  return 'file:///' + parts.map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part))).join('/').replace(/^file:\/\/\/\//, 'file:///');
}

// Where to load a video from: a file on disk, or (web version) the copy kept
// in the browser.
const mediaUrl = async (p) => (p.startsWith('web:') ? webMediaUrl(p) : fileUrl(p));

function waitForVideo(src) {
  return new Promise((resolve) => {
    const done = (ok) => {
      refVideo.onloadeddata = null;
      refVideo.onerror = null;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 15000);
    refVideo.onloadeddata = () => done(refVideo.videoWidth > 0);
    refVideo.onerror = () => done(false);
    refVideo.src = src;
    refVideo.load();
  });
}

async function loadReference(path, { offset = 0, opacity = 0.5, visible = true, record = true, proxy = null } = {}) {
  const name = path.split(/[\\/]/).pop();
  let playable = proxy;
  let ok = false;
  if (proxy) ok = await waitForVideo(await mediaUrl(proxy));
  if (!ok) {
    playable = null;
    ok = await waitForVideo(await mediaUrl(path));
  }
  if (!ok && !isWeb) {
    toast(`Converting ${name} so it can play here...`);
    const res = await window.api.videoProxy(path);
    if (res && res.path) {
      playable = res.path;
      ok = await waitForVideo(fileUrl(res.path));
    }
  }
  if (!ok) {
    toast(isWeb ? `This browser cannot play ${name}. Export it as an MP4 (H.264) and add that instead.` : `Could not open ${name} as a video`);
    refVideo.removeAttribute('src');
    refVideo.load();
    return false;
  }
  refVideo.muted = true;
  refStillReady = false;
  state.reference = {
    path, proxy: playable, name, offset, opacity, visible,
    duration: refVideo.duration, vw: refVideo.videoWidth, vh: refVideo.videoHeight,
  };
  layoutReference();
  syncReference();
  if (record) markDirty();
  refreshUI();
  return true;
}

function removeReference() {
  state.reference = null;
  refStillReady = false;
  refVideo.pause();
  refVideo.removeAttribute('src');
  refVideo.load();
  layoutReference();
  markDirty();
  refreshUI();
}

// Where the video sits inside the frame (fitted, centred), in frame space.
function refRect() {
  const r = state.reference;
  const k = Math.min(dims.W / r.vw, dims.H / r.vh);
  const w = r.vw * k;
  const h = r.vh * k;
  return { x: (dims.W - w) / 2, y: (dims.H - h) / 2, w, h };
}

function layoutReference() {
  const r = state.reference;
  if (!r) { refVideo.style.display = 'none'; return; }
  const rr = refRect();
  Object.assign(refVideo.style, {
    display: r.visible ? 'block' : 'none',
    left: `${dims.FX + rr.x}px`, top: `${dims.FY + rr.y}px`, width: `${rr.w}px`, height: `${rr.h}px`,
    opacity: r.opacity,
  });
}

// Seconds into the video for a timeline frame, or null outside the video.
function refTimeAt(frame) {
  const r = state.reference;
  if (!r) return null;
  const t = (frame - r.offset) / state.fps;
  return t >= 0 && t <= r.duration ? t : null;
}

// Shows the video frame at the playhead.
function syncReference() {
  const r = state.reference;
  if (!r || playing) return;
  const t = refTimeAt(state.time);
  refVideo.style.visibility = t === null ? 'hidden' : 'visible';
  if (t !== null) requestRefSeek(t);
}

// One seek at a time. Scrubbing asks for a new position on every pen move;
// starting a seek each time made the video decoder throw away its work over
// and over and the timeline stutter. While a seek is under way, newer positions
// just replace the target, and when it lands the scrub view redraws and the
// video moves on to wherever the playhead is now.
const refSeek = { busy: false, target: null };

// The last frame a seek landed on. While the next seek is decoding the video
// has no picture to give, so scrubbing drew blank frames; it shows this instead.
const refStill = new OffscreenCanvas(1, 1);
let refStillReady = false;
function keepRefStill() {
  if (!state.reference || refVideo.readyState < 2 || refVideo.seeking || !refVideo.videoWidth) return;
  const k = Math.min(1, 1920 / refVideo.videoWidth);
  const w = Math.max(1, Math.round(refVideo.videoWidth * k));
  const h = Math.max(1, Math.round(refVideo.videoHeight * k));
  if (refStill.width !== w || refStill.height !== h) { refStill.width = w; refStill.height = h; }
  refStill.getContext('2d').drawImage(refVideo, 0, 0, w, h);
  refStillReady = true;
}
// The video's own picture when it has one, otherwise the kept frame.
function refPicture() {
  if (refVideo.readyState >= 2 && !refVideo.seeking) return refVideo;
  return refStillReady ? refStill : null;
}
// Seeks aim 1ms into the frame. Aiming at its exact start, the browser rounds
// the time to whole microseconds and often lands just before it, so stepping
// frame by frame showed the previous video frame on two steps out of three
// (some frames twice, some never), which threw off timing when reboarding over
// an animatic.
const SEEK_INTO_FRAME = 0.001;
function requestRefSeek(t) {
  refSeek.target = Math.min(t + SEEK_INTO_FRAME, state.reference.duration - 0.001);
  if (!refSeek.busy) pumpRefSeek();
}
function pumpRefSeek() {
  const t = refSeek.target;
  if (t === null || !state.reference || Math.abs(refVideo.currentTime - t) < 0.001) {
    refSeek.busy = false;
    return;
  }
  refSeek.busy = true;
  let done = false;
  const next = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    keepRefStill();
    if (scrub) requestScrubDraw(scrub);
    pumpRefSeek();
  };
  const timer = setTimeout(next, 400);
  refVideo.addEventListener('seeked', next, { once: true });
  refVideo.currentTime = t;
}

// Draws the current video frame into a player-sized canvas, as the camera sees it.
function drawReferenceFrame(ctx, cam, src = refVideo) {
  const r = state.reference;
  if (!r || !r.visible || !src || (src === refVideo && refVideo.readyState < 2)) return;
  const c = camRect(cam);
  const rr = refRect();
  const sx = dims.W / c.w;
  const sy = dims.H / c.h;
  ctx.save();
  ctx.globalAlpha = r.opacity;
  ctx.drawImage(src, (dims.FX + rr.x - c.x) * sx, (dims.FY + rr.y - c.y) * sy, rr.w * sx, rr.h * sy);
  ctx.restore();
}

function seekReference(t) {
  t = Math.min(t + SEEK_INTO_FRAME, state.reference ? state.reference.duration - 0.001 : t);
  return new Promise((resolve) => {
    if (Math.abs(refVideo.currentTime - t) < 0.001) { resolve(); return; }
    const timer = setTimeout(resolve, 400);
    refVideo.addEventListener('seeked', () => { clearTimeout(timer); resolve(); }, { once: true });
    refVideo.currentTime = t;
  });
}

// Brings a video in: shows it under the drawing, stretches a one-shot board to
// its length (ready to split at each cut), and uses its sound if the board
// has none yet.
async function useVideo(path) {
  if (!path) { toast('Could not find that video file'); return; }
  const ok = await loadReference(path);
  if (!ok) return;
  const r = state.reference;
  const frames = Math.max(1, Math.round(r.duration * state.fps));
  if (state.shots.length === 1) setDuration(state.shots[0], frames);
  if (!state.audio) {
    const sound = await window.api.videoAudio(path);
    if (sound) await loadAudio(sound.bytes, `${r.name} (sound)`, sound.mime || 'audio/mp4', r.offset);
  }
  fitTimeline();
  toast(`Added ${r.name} under the drawing. Ctrl+K splits the shot at the playhead.`);
}

async function importReference() {
  const res = await window.api.openVideo();
  if (res) await useVideo(res.path);
}

// ---------------------------------------------------------------- timeline row

let refEl = null;
function renderReferenceClip() {
  const r = state.reference;
  if (!r) {
    refEl = null;
    refTrack.innerHTML = '<div class="audio-empty">Drop a video here to board over it</div>';
    return;
  }
  if (!refEl || refEl.dataset.path !== r.path) {
    refEl = document.createElement('div');
    refEl.className = 'ref-clip';
    refEl.dataset.path = r.path;
    refEl.innerHTML = `<span class="audio-name"></span><button class="ref-remove icon-btn" title="Remove the reference video">${ICONS.close}</button>`;
    refEl.querySelector('.audio-name').textContent = r.name;
    refEl.querySelector('.ref-remove').addEventListener('click', (e) => { e.stopPropagation(); removeReference(); });
    refEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || playing) return;
      try { refEl.setPointerCapture(e.pointerId); } catch {}
      tl.drag = { kind: 'ref', id: e.pointerId, x0: e.clientX, off0: r.offset };
    });
    refEl.addEventListener('pointermove', (e) => {
      const d = tl.drag;
      if (!d || d.kind !== 'ref' || d.id !== e.pointerId) return;
      state.reference.offset = d.off0 + Math.round((e.clientX - d.x0) / tl.ppf);
      const hit = e.ctrlKey ? null : snapSpan(state.reference.offset, Math.round(state.reference.duration * state.fps), snapMarks({ reference: false }));
      if (hit) state.reference.offset = hit.start;
      showSnapLine(hit && hit.at);
      renderReferenceClip();
      syncReference();
      showTimelineTip(e.clientX, `starts at ${timecode(Math.max(0, state.reference.offset))}`);
    });
    const done = (e) => {
      const d = tl.drag;
      if (!d || d.kind !== 'ref' || d.id !== e.pointerId) return;
      tl.drag = null;
      hideTimelineTip();
      showSnapLine(null);
      if (state.reference.offset !== d.off0) markDirty();
      renderTimeline();
    };
    refEl.addEventListener('pointerup', done);
    refEl.addEventListener('pointercancel', done);
    refTrack.replaceChildren(refEl);
  }
  refEl.style.left = `${frameToX(r.offset)}px`;
  refEl.style.width = `${Math.max(4, r.duration * state.fps * tl.ppf)}px`;
  refEl.classList.toggle('muted', !r.visible);
}
