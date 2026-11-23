// 3B model önizlemesi (three.js): tabla ızgarası, model, fareyle döndürme/yakınlaştırma ve
// yazıcı ekranı için küçük resim üretimi. panel.js'ten window.Viewer üzerinden kullanılır.
import * as THREE from './vendor/three.module.min.js';

const V = {
  renderer: null, scene: null, camera: null, canvas: null, bedGroup: null, mesh: null, geom: null,
  bed: { x0: 0, y0: 0, w: 255, h: 255, z: 260 }, color: '#ff8a1f', scale: 1,
  orbit: { r: 500, theta: -0.75, phi: 1.0 }, drag: null, ro: null, pending: false,
};

function lights(scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 1.25));
  const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(220, -320, 480); scene.add(d);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.45); d2.position.set(-300, 260, 160); scene.add(d2);
}

function buildBed() {
  if (V.bedGroup) { V.scene.remove(V.bedGroup); V.bedGroup.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); }); }
  const { w, h } = V.bed;
  const g = new THREE.Group();
  const plate = new THREE.Mesh(new THREE.BoxGeometry(w, h, 2), new THREE.MeshStandardMaterial({ color: 0x2a2e36, roughness: 0.9, metalness: 0.05 }));
  plate.position.set(0, 0, -1.01);
  g.add(plate);
  const minor = []; const major = [];
  for (let x = -w / 2; x <= w / 2 + 0.01; x += 10) (Math.round(x + w / 2) % 50 === 0 ? major : minor).push(x, -h / 2, 0.02, x, h / 2, 0.02);
  for (let y = -h / 2; y <= h / 2 + 0.01; y += 10) (Math.round(y + h / 2) % 50 === 0 ? major : minor).push(-w / 2, y, 0.02, w / 2, y, 0.02);
  const lines = (arr, color, opacity) => {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  };
  g.add(lines(minor, 0x8a93a6, 0.18));
  g.add(lines(major, 0xaab3c5, 0.42));
  V.bedGroup = g;
  V.scene.add(g);
}

function placeMesh() {
  if (!V.mesh) return;
  const s = V.scale;
  V.mesh.scale.set(s, s, s);
  V.geom.computeBoundingBox();
  const b = V.geom.boundingBox;
  // tablanın ortasına, tabanı z=0'a oturt (dilimleyicinin --arrange ile yaptığı gibi)
  V.mesh.position.set(-((b.min.x + b.max.x) / 2) * s, -((b.min.y + b.max.y) / 2) * s, -b.min.z * s);
}

function setCamera() {
  const { r, theta, phi } = V.orbit;
  const h = V.mesh ? (V.geom.boundingBox.max.z - V.geom.boundingBox.min.z) * V.scale : 0;
  const target = new THREE.Vector3(0, 0, Math.min(h / 2, V.bed.z / 2));
  V.camera.position.set(target.x + r * Math.sin(phi) * Math.cos(theta), target.y + r * Math.sin(phi) * Math.sin(theta), target.z + r * Math.cos(phi));
  V.camera.lookAt(target);
}

function draw() {
  if (!V.renderer || V.pending) return;
  V.pending = true;
  requestAnimationFrame(() => {
    V.pending = false;
    if (!V.renderer) return;
    setCamera();
    V.renderer.render(V.scene, V.camera);
  });
}

function resize() {
  if (!V.renderer || !V.canvas) return;
  const w = V.canvas.clientWidth; const h = V.canvas.clientHeight;
  if (!w || !h) return;
  V.renderer.setSize(w, h, false);
  V.camera.aspect = w / h; V.camera.updateProjectionMatrix();
  draw();
}

// Kamera: model varsa ona yakın (tablayı da biraz gösterecek kadar), yoksa bütün tabla
function frameBed() {
  const bedR = Math.max(V.bed.w, V.bed.h) * 1.75;
  let r = bedR;
  if (V.geom) {
    const b = V.geom.boundingBox;
    const diag = Math.hypot(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z) * V.scale;
    r = Math.min(bedR, Math.max(200, diag * 4.4));
  }
  V.orbit.r = r; V.orbit.theta = -Math.PI / 2 - 0.55; V.orbit.phi = 0.95;
}

function mount(canvas) {
  if (V.canvas === canvas && V.renderer) { resize(); return; }
  unmount();
  V.canvas = canvas;
  V.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  V.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  V.scene = new THREE.Scene();
  V.camera = new THREE.PerspectiveCamera(35, 1, 1, 8000);
  V.camera.up.set(0, 0, 1);
  lights(V.scene);
  buildBed();
  if (V.geom) addMesh();
  frameBed();
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('dblclick', () => { frameBed(); draw(); });
  V.ro = new ResizeObserver(resize); V.ro.observe(canvas);
  resize();
}

function unmount() {
  if (V.ro) { V.ro.disconnect(); V.ro = null; }
  if (V.canvas) {
    for (const [ev, fn] of [['pointerdown', onDown], ['pointermove', onMove], ['pointerup', onUp], ['pointercancel', onUp], ['wheel', onWheel]]) V.canvas.removeEventListener(ev, fn);
  }
  if (V.renderer) { V.renderer.dispose(); V.renderer.forceContextLoss(); }
  V.renderer = null; V.scene = null; V.camera = null; V.canvas = null; V.bedGroup = null; V.mesh = null;
}

function onDown(e) { V.drag = { x: e.clientX, y: e.clientY }; V.canvas.setPointerCapture(e.pointerId); V.canvas.style.cursor = 'grabbing'; }
function onMove(e) {
  if (!V.drag) return;
  const dx = e.clientX - V.drag.x; const dy = e.clientY - V.drag.y;
  V.drag = { x: e.clientX, y: e.clientY };
  V.orbit.theta -= dx * 0.008;
  V.orbit.phi = Math.max(0.12, Math.min(1.52, V.orbit.phi - dy * 0.008));
  draw();
}
function onUp() { V.drag = null; if (V.canvas) V.canvas.style.cursor = ''; }
function onWheel(e) {
  e.preventDefault();
  V.orbit.r = Math.max(40, Math.min(3000, V.orbit.r * (e.deltaY > 0 ? 1.1 : 0.9)));
  draw();
}

function material() { return new THREE.MeshStandardMaterial({ color: new THREE.Color(V.color), roughness: 0.5, metalness: 0.05 }); }

function addMesh() {
  if (V.mesh) { V.scene.remove(V.mesh); V.mesh.material.dispose(); }
  V.mesh = new THREE.Mesh(V.geom, material());
  V.scene.add(V.mesh);
  placeMesh();
}

function setModel(positions) {
  if (V.geom) V.geom.dispose();
  V.geom = null;
  if (V.mesh && V.scene) { V.scene.remove(V.mesh); V.mesh = null; }
  if (positions && positions.length) {
    V.geom = new THREE.BufferGeometry();
    V.geom.setAttribute('position', new THREE.BufferAttribute(positions instanceof Float32Array ? positions : new Float32Array(positions), 3));
    V.geom.computeVertexNormals();
    V.geom.computeBoundingBox();
    if (V.scene) addMesh();
  }
  frameBed();
  draw();
}

function setBed(bed) {
  if (!bed) return;
  const changed = bed.w !== V.bed.w || bed.h !== V.bed.h;
  V.bed = { ...V.bed, ...bed };
  if (V.scene && changed) { buildBed(); frameBed(); }
  draw();
}

function setColor(hex) {
  V.color = hex || '#ff8a1f';
  if (V.mesh) V.mesh.material.color.set(V.color);
  draw();
}

function setScale(s) { V.scale = s > 0 ? s : 1; placeMesh(); draw(); }

// Modeli tek başına, şeffaf arka planla, verilen boyutta PNG olarak çiz
function thumbnail(w, h) {
  if (!V.geom) return null;
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(w, h, false);
  const scene = new THREE.Scene();
  lights(scene);
  const mesh = new THREE.Mesh(V.geom, material());
  scene.add(mesh);
  V.geom.computeBoundingSphere();
  const s = V.geom.boundingSphere;
  const cam = new THREE.PerspectiveCamera(30, w / h, 0.1, 10000);
  cam.up.set(0, 0, 1);
  const fov = (30 * Math.PI) / 180;
  const fit = Math.max(s.radius / Math.sin(fov / 2), s.radius / Math.sin(Math.atan(Math.tan(fov / 2) * (w / h)))) * 1.02;
  const dir = new THREE.Vector3(0.9, -1.25, 0.95).normalize();
  cam.position.copy(s.center).addScaledVector(dir, fit);
  cam.lookAt(s.center);
  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  mesh.material.dispose();
  r.dispose(); r.forceContextLoss();
  return url;
}

function size() {
  if (!V.geom) return null;
  const b = V.geom.boundingBox; const s = V.scale;
  return { x: (b.max.x - b.min.x) * s, y: (b.max.y - b.min.y) * s, z: (b.max.z - b.min.z) * s };
}

window.Viewer = { mount, unmount, setModel, setBed, setColor, setScale, thumbnail, size, hasModel: () => !!V.geom };
window.dispatchEvent(new Event('viewer-ready'));
