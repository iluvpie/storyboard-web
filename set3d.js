// The 3D set's engine. An ES module that set.js loads only when a board uses
// 3D, so boards without a set never load three.js.
//
// It builds a three.js scene from the board's set (plain data, state.set),
// draws a shot camera's view of it for the board (under the drawing, in
// playback, scrubbing, the timeline and exports), and runs the 3D editor: an
// orbit view with a move / turn / size gizmo and click-to-pick. The data, its
// undo and the panel live in set.js; this file only draws and edits.
import * as THREE from './vendor/three/three.module.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { TransformControls } from './vendor/three/TransformControls.js';

const DEG = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ---------------------------------------------------------------- shapes
//
// Every shape stands on the floor: its origin is at the bottom centre, and a
// scale of 1 is one metre. Faces are a light grey with dark edges, like a
// layout pass, so a drawing over it reads first.

const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const GEOS = {
  box: unitBox,
  cylinder: new THREE.CylinderGeometry(0.5, 0.5, 1, 32).translate(0, 0.5, 0),
  sphere: new THREE.SphereGeometry(0.5, 32, 16).translate(0, 0.5, 0),
};
// Six steps in a 1 x 1 x 1 block, climbing away from the front (+z).
const STEPS = 6;
const stepGeos = Array.from({ length: STEPS }, (_, i) =>
  new THREE.BoxGeometry(1, (i + 1) / STEPS, 1 / STEPS).translate(0, (i + 1) / STEPS / 2, 0.5 - (i + 0.5) / STEPS));
// A stand-in person 1.75 m tall, with a nose so you can see which way they face.
const figureGeos = {
  body: new THREE.CapsuleGeometry(0.2, 1.02, 6, 16).translate(0, 0.71, 0),
  head: new THREE.SphereGeometry(0.13, 20, 14).translate(0, 1.62, 0),
  // a little cone pointing the way they face (a box here read as a sticker)
  nose: new THREE.ConeGeometry(0.035, 0.09, 12).rotateX(Math.PI / 2).translate(0, 1.61, 0.15),
};

const edgeCache = new Map();
const edgesOf = (geo) => {
  if (!edgeCache.has(geo)) edgeCache.set(geo, new THREE.EdgesGeometry(geo, 25));
  return edgeCache.get(geo);
};

// Faces sit a hair behind their edges (polygon offset) so the lines stay
// whole instead of flickering in and out of the faces they lie on.
const offset = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };
const MAT = {
  shape: new THREE.MeshLambertMaterial({ color: 0xdedede, ...offset }),
  floor: new THREE.MeshLambertMaterial({ color: 0xc9c9c9, ...offset }),
  figure: new THREE.MeshLambertMaterial({ color: 0xe9b48a, ...offset }),
  edge: new THREE.LineBasicMaterial({ color: 0x2b2b2e }),
  picked: new THREE.LineBasicMaterial({ color: 0x3d8bff }),
  // for "lines only": faces hide the lines behind them but draw nothing
  depthOnly: new THREE.MeshBasicMaterial({ colorWrite: false, ...offset }),
};

function partsOf(kind) {
  if (kind === 'figure') return [[figureGeos.body, MAT.figure], [figureGeos.head, MAT.figure], [figureGeos.nose, MAT.figure]];
  if (kind === 'stairs') return stepGeos.map((g) => [g, MAT.shape]);
  if (kind === 'floor') return [[unitBox, MAT.floor]];
  return [[GEOS[kind] || unitBox, MAT.shape]];
}

function buildObject(o) {
  const root = new THREE.Group();
  root.userData = { id: o.id, kind: o.kind };
  for (const [geo, mat] of partsOf(o.kind)) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.pick = o.id;
    root.add(mesh);
    // A figure is round all over: no edge lines, its shading carries it.
    if (o.kind !== 'figure') root.add(new THREE.LineSegments(edgesOf(geo), MAT.edge));
  }
  return root;
}

function place(root, o) {
  root.position.fromArray(o.p);
  root.rotation.set(o.r[0] * DEG, o.r[1] * DEG, o.r[2] * DEG, 'YXZ');
  root.scale.fromArray(o.s);
}

// ---------------------------------------------------------------- lenses
//
// Lenses in millimetres on a full-frame (36 mm wide) camera, the way a
// layout artist talks about them: 24 wide, 35, 50 normal, 85 long.
export function vfovFor(mm, aspect) {
  const hfov = 2 * Math.atan(36 / (2 * mm));
  return (2 * Math.atan(Math.tan(hfov / 2) / aspect)) / DEG;
}
export function mmFor(vfovDeg, aspect) {
  const hfov = 2 * Math.atan(Math.tan((vfovDeg * DEG) / 2) * aspect);
  return 36 / (2 * Math.tan(hfov / 2));
}

function aim(cam, view, aspect) {
  cam.position.fromArray(view.p);
  cam.up.set(0, 1, 0);
  cam.lookAt(view.t[0], view.t[1], view.t[2]);
  cam.aspect = aspect;
  cam.fov = vfovFor(view.mm, aspect);
  cam.updateProjectionMatrix();
}

// ---------------------------------------------------------------- the engine

export function createEngine() {
  const scene = new THREE.Scene();
  // Soft light from above and one side, so a shape's top, front and sides
  // come out as different greys against the white paper: tops about 233,
  // the floor 212, fronts 190, sides 179 and 154 (three.js divides light by
  // pi, hence the numbers). Much more and the floor went white into the paper.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8f8f96, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(4, 10, 6);
  scene.add(sun);

  const objects = new Map(); // id -> root
  const setRoot = new THREE.Group();
  scene.add(setRoot);
  // Editor-only things: hidden whenever the board's view is drawn.
  const helpers = new THREE.Group();
  scene.add(helpers);
  const grid = new THREE.GridHelper(40, 40, 0x7a7a84, 0x4a4a52);
  helpers.add(grid);
  const markers = new THREE.Group();
  helpers.add(markers);
  let gizmoHelper = null;
  let pickedId = null;

  // Matches the scene to the set's data: new shapes built, changed ones
  // moved, removed ones dropped.
  function sync(set) {
    const list = (set && set.objects) || [];
    const keep = new Set();
    for (const o of list) {
      keep.add(o.id);
      let root = objects.get(o.id);
      if (root && root.userData.kind !== o.kind) {
        setRoot.remove(root);
        root = null;
      }
      if (!root) {
        root = buildObject(o);
        objects.set(o.id, root);
        setRoot.add(root);
      }
      place(root, o);
    }
    for (const [id, root] of objects) {
      if (keep.has(id)) continue;
      setRoot.remove(root);
      objects.delete(id);
      if (ed && ed.gizmo.object === root) ed.gizmo.detach();
    }
    showPicked(pickedId && objects.has(pickedId) ? pickedId : null);
    requestRender();
  }

  function showPicked(id) {
    pickedId = id;
    for (const [oid, root] of objects) {
      for (const c of root.children) if (c.isLineSegments) c.material = oid === id ? MAT.picked : MAT.edge;
    }
  }

  // ---- the board's view of the set

  let board = null;
  const shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 2000);
  function boardRenderer() {
    if (!board) {
      board = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true });
      board.setPixelRatio(1);
    }
    return board;
  }

  // Draws a shot camera's view (view = { p, t, mm }) at w x h and returns the
  // canvas holding it, white paper behind the set. lines: just the edges, dark
  // on transparent, with what is hidden behind faces left out (for tracing).
  function render(view, w, h, { lines = false } = {}) {
    const r = boardRenderer();
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (r.domElement.width !== w || r.domElement.height !== h) r.setSize(w, h, false);
    aim(shotCam, view, w / h);
    const shown = helpers.visible;
    const gizmoShown = gizmoHelper ? gizmoHelper.visible : false;
    helpers.visible = false;
    if (gizmoHelper) gizmoHelper.visible = false;
    const pickedWas = pickedId;
    showPicked(null);
    const swapped = [];
    if (lines) {
      setRoot.traverse((o) => {
        if (o.isMesh) { swapped.push([o, o.material]); o.material = MAT.depthOnly; }
        else if (o.isLineSegments) { swapped.push([o, o.material]); o.material = MAT.edge; }
      });
      r.setClearColor(0x000000, 0);
    } else {
      r.setClearColor(0xffffff, 1);
    }
    r.render(scene, shotCam);
    for (const [o, m] of swapped) o.material = m;
    showPicked(pickedWas);
    helpers.visible = shown;
    if (gizmoHelper) gizmoHelper.visible = gizmoShown;
    return r.domElement;
  }

  // ---- the editor

  let ed = null; // { host, renderer, camera, orbit, gizmo, cb, look, mm, ... }
  let rafPending = 0;
  function requestRender() {
    if (!ed || !ed.open || rafPending) return;
    rafPending = requestAnimationFrame(() => {
      rafPending = 0;
      if (ed && ed.open) ed.renderer.render(scene, ed.camera);
    });
  }

  // The frame of the shot inside the editor view, when looking through the
  // camera: fitted with a margin, centred.
  function frameRect() {
    const { w, h } = ed.size;
    const a = ed.cb.aspect();
    const fw = Math.min(w * 0.9, h * 0.9 * a);
    return { x: (w - fw) / 2, y: (h - fw / a) / 2, w: fw, h: fw / a };
  }
  // In free view the editor has its own wide lens; looking through the
  // camera, its lens is set so the shot's frame shows exactly what the shot
  // camera sees.
  function applyLens() {
    const { w, h } = ed.size;
    ed.camera.aspect = w / h;
    if (ed.look) {
      const f = frameRect();
      ed.frameLabel.textContent = `${ed.cb.label ? ed.cb.label() : 'Camera'} · ${Math.round(ed.mm)} mm`;
      const shotV = vfovFor(ed.mm, ed.cb.aspect()) * DEG;
      ed.camera.fov = (2 * Math.atan(Math.tan(shotV / 2) * (h / f.h))) / DEG;
      Object.assign(ed.frameEl.style, { display: 'block', left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px` });
    } else {
      ed.camera.fov = 50;
      ed.frameEl.style.display = 'none';
    }
    ed.camera.updateProjectionMatrix();
    requestRender();
  }

  function resize() {
    if (!ed) return;
    const w = Math.max(1, ed.host.clientWidth);
    const h = Math.max(1, ed.host.clientHeight);
    ed.size = { w, h };
    ed.renderer.setSize(w, h, false);
    applyLens();
  }

  function openEditor(host, cb) {
    if (!ed) {
      const canvas = document.createElement('canvas');
      canvas.className = 'set-gl';
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      renderer.setClearColor(0x2a2a2f, 1);
      const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
      camera.position.set(7, 5.5, 9);
      const orbit = new OrbitControls(camera, canvas);
      orbit.target.set(0, 0.9, 0);
      orbit.update();
      const gizmo = new TransformControls(camera, canvas);
      gizmo.setSize(0.9);
      gizmoHelper = gizmo.getHelper();
      scene.add(gizmoHelper);
      const frameEl = document.createElement('div');
      frameEl.className = 'set-frame';
      const frameLabel = document.createElement('span');
      frameLabel.className = 'set-frame-label';
      frameEl.append(frameLabel);
      const hintEl = document.createElement('div');
      hintEl.className = 'set-hint';
      // On the iPad: fingers and the Pencil, no Alt key or right button.
      const touchFirst = matchMedia('(pointer: coarse)').matches;
      for (const line of touchFirst
        ? ['Drag to look round · Two fingers to pan, pinch to zoom', 'Tap a shape to pick it']
        : ['Drag to look round · Right-drag or Shift-drag to pan · Scroll to zoom', 'Alt-drag turns the camera where it stands · Click a shape to pick it']) {
        const span = document.createElement('span');
        span.textContent = line;
        hintEl.append(span);
      }
      ed = { host, canvas, renderer, camera, orbit, gizmo, frameEl, frameLabel, hintEl, cb, look: false, mm: 35, open: false, size: { w: 1, h: 1 }, snap: true };
      setSnap(true);

      gizmo.addEventListener('change', requestRender);
      orbit.addEventListener('change', () => {
        if (shownCams.length) showCameras(shownCams); // a marker hidden up close comes back
        requestRender();
        if (!ed.settingView) ed.cb.onView();
      });
      // Orbiting stops while a gizmo handle is dragged; the edit is kept
      // (with an undo step) when it is let go.
      let dragFrom = null;
      gizmo.addEventListener('dragging-changed', (e) => {
        orbit.enabled = !e.value;
        if (press) press.dragged = true;
        const root = gizmo.object;
        if (!root) return;
        if (e.value) dragFrom = root.userData.id;
        else if (dragFrom === root.userData.id) {
          dragFrom = null;
          ed.cb.onEdit(root.userData.id, readTransform(root));
        }
      });

      // Alt-drag turns the camera where it stands (a pan or tilt on a
      // tripod), instead of swinging it round what it looks at. It runs
      // before the orbit and the gizmo, which then never see the press.
      canvas.addEventListener('pointerdown', (e) => {
        if (!e.altKey || e.button !== 0) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        const cam = ed.camera;
        const look = ed.orbit.target.clone().sub(cam.position);
        const dist = look.length();
        const sph = new THREE.Spherical().setFromVector3(look);
        const x0 = e.clientX;
        const y0 = e.clientY;
        const turn = (ev) => {
          // a full drag across the view turns about as far as the view is wide
          const k = (ed.camera.fov * DEG) / Math.max(1, ed.size.h);
          const s = new THREE.Spherical(dist, clamp(sph.phi - (ev.clientY - y0) * k, 0.05, Math.PI - 0.05), sph.theta - (ev.clientX - x0) * k);
          ed.orbit.target.copy(cam.position).add(new THREE.Vector3().setFromSpherical(s));
          cam.lookAt(ed.orbit.target);
          ed.orbit.update();
          requestRender();
          ed.cb.onView();
        };
        const done = () => {
          window.removeEventListener('pointermove', turn);
          window.removeEventListener('pointerup', done);
          window.removeEventListener('pointercancel', done);
        };
        window.addEventListener('pointermove', turn);
        window.addEventListener('pointerup', done);
        window.addEventListener('pointercancel', done);
      }, true);

      // A click (not a drag) picks the shape under it, or nothing.
      let press = null;
      canvas.addEventListener('pointerdown', (e) => { press = { x: e.clientX, y: e.clientY, dragged: false }; });
      canvas.addEventListener('pointerup', (e) => {
        const p = press;
        press = null;
        if (!p || p.dragged || Math.hypot(e.clientX - p.x, e.clientY - p.y) > 5) return;
        ed.cb.onPick(pickAt(e.clientX, e.clientY));
      });
      new ResizeObserver(resize).observe(host);
    }
    ed.cb = cb;
    ed.host = host;
    host.prepend(ed.canvas);
    host.append(ed.frameEl, ed.hintEl);
    ed.open = true;
    resize();
    requestRender();
  }

  function closeEditor() {
    if (!ed) return;
    ed.open = false;
    ed.gizmo.detach();
    ed.canvas.remove();
    ed.frameEl.remove();
    ed.hintEl.remove();
  }

  const raycaster = new THREE.Raycaster();
  function pickAt(clientX, clientY) {
    const r = ed.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    // (the camera's matrices are only brought up to date when a frame is
    // drawn; a click straight after the view jumped would aim with the old ones)
    ed.camera.updateMatrixWorld();
    raycaster.setFromCamera(ndc, ed.camera);
    const hit = raycaster.intersectObjects(setRoot.children, true).find((h) => h.object.userData.pick);
    return hit ? hit.object.userData.pick : null;
  }

  function readTransform(root) {
    const e = new THREE.Euler().setFromQuaternion(root.quaternion, 'YXZ');
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return {
      p: root.position.toArray().map(r3),
      r: [e.x / DEG, e.y / DEG, e.z / DEG].map((v) => Math.round(v * 100) / 100),
      s: root.scale.toArray().map((v) => Math.max(0.02, r3(Math.abs(v)))),
    };
  }

  function select(id) {
    if (!ed) { showPicked(id); return; }
    const root = id ? objects.get(id) : null;
    if (root) ed.gizmo.attach(root);
    else ed.gizmo.detach();
    showPicked(root ? id : null);
    requestRender();
  }

  function setMode(mode) {
    if (!ed) return;
    ed.gizmo.setMode(mode);
    // Turning works around the shape's own axes; moving and sizing too.
    ed.gizmo.setSpace(mode === 'translate' ? 'world' : 'local');
    requestRender();
  }

  // Snapping: quarter metres, 15 degrees, tenths of the size.
  function setSnap(on) {
    if (!ed) return;
    ed.snap = on;
    ed.gizmo.setTranslationSnap(on ? 0.25 : null);
    ed.gizmo.setRotationSnap(on ? 15 * DEG : null);
    ed.gizmo.setScaleSnap(on ? 0.1 : null);
  }

  // The editor's view as a shot camera: where it is, what it looks at, the lens.
  function getView() {
    const r3 = (v) => Math.round(v * 1000) / 1000;
    return { p: ed.camera.position.toArray().map(r3), t: ed.orbit.target.toArray().map(r3), mm: Math.round(ed.mm * 10) / 10 };
  }
  function setView(view) {
    if (!ed || !view) return;
    ed.settingView = true;
    ed.camera.position.fromArray(view.p);
    ed.orbit.target.fromArray(view.t);
    if (view.mm) ed.mm = view.mm;
    ed.orbit.update();
    ed.settingView = false;
    applyLens();
  }
  function setLook(on) {
    if (!ed) return;
    ed.look = !!on;
    applyLens();
  }
  function setLens(mm) {
    if (!ed) return;
    ed.mm = mm;
    applyLens();
  }

  // Swings the view round to the picked shape (F), or the whole set.
  function frame(id) {
    if (!ed) return;
    const box = new THREE.Box3();
    if (id && objects.get(id)) box.setFromObject(objects.get(id));
    else box.setFromObject(setRoot);
    if (box.isEmpty()) box.set(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(2, 2, 2));
    const centre = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length() || 2;
    const dir = ed.camera.position.clone().sub(ed.orbit.target).normalize();
    const dist = (size / 2) / Math.tan((ed.camera.fov * DEG) / 2) * 1.15;
    setView({ p: centre.clone().add(dir.multiplyScalar(Math.max(dist, 1.5))).toArray(), t: centre.toArray(), mm: ed.mm });
    ed.cb.onView();
  }

  // Where a new shape goes: on the floor under the middle of the view.
  function dropPoint() {
    if (!ed) return [0, 0, 0];
    const t = ed.orbit.target;
    const r = (v) => Math.round(v * 4) / 4;
    return [r(t.x), 0, r(t.z)];
  }

  // The shot's camera(s) in the free view: a small pyramid from the camera
  // to its picture, with a notch on top for which way is up, white for Start
  // and orange for End. Left out when the view is standing right at it (from
  // inside, its lines just cross the whole view).
  let shownCams = [];
  function showCameras(list) {
    shownCams = list;
    markers.clear();
    const aspect = ed ? ed.cb.aspect() : 16 / 9;
    for (const { view, color } of list) {
      if (ed && ed.camera.position.distanceTo(new THREE.Vector3().fromArray(view.p)) < 0.35) continue;
      const cam = new THREE.PerspectiveCamera(vfovFor(view.mm, aspect), aspect, 0.1, 10);
      aim(cam, view, aspect);
      cam.updateMatrixWorld(true);
      const d = 0.55;
      const h = Math.tan((cam.fov * DEG) / 2) * d;
      const w = h * aspect;
      const c = [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => new THREE.Vector3(x, y, -d));
      const pts = [];
      for (let i = 0; i < 4; i++) pts.push(new THREE.Vector3(), c[i], c[i], c[(i + 1) % 4]);
      pts.push(new THREE.Vector3(-w * 0.35, h * 1.08, -d), new THREE.Vector3(0, h * 1.45, -d), new THREE.Vector3(0, h * 1.45, -d), new THREE.Vector3(w * 0.35, h * 1.08, -d));
      const lines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
      lines.applyMatrix4(cam.matrixWorld);
      markers.add(lines);
    }
    requestRender();
  }

  return {
    sync, render, select, setMode, setSnap, getView, setView, setLook, setLens, frame, dropPoint, showCameras,
    openEditor, closeEditor, requestRender,
    get editing() { return !!(ed && ed.open); },
    get dragging() { return !!(ed && ed.gizmo.dragging); },
    vfovFor, mmFor,
    // for the self-test
    _scene: scene,
    _editor: () => ed,
    // where a point in the set shows in the editor, in page coordinates
    _project(p) {
      ed.camera.updateMatrixWorld();
      const v = new THREE.Vector3().fromArray(p).project(ed.camera);
      const r = ed.canvas.getBoundingClientRect();
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
  };
}
