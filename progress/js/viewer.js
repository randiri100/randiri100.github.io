// Viewer 3D: model rencana (GLB), warna status per elemen, dan overlay point cloud scan.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';

const GENERIC_NAME = /^(3dgeom|mesh|node|object|geometry|group|scene|primitive)[-_ ]?\d*$/i;

// Warna status tetap (good / warning) + abu-abu untuk "belum".
const STATUS_COLOR = { done: 0x0ca30c, partial: 0xfab219, none: 0x9a9893 };

function displayName(node) {
  return node.userData?.name || node.name || '';
}

/** Luas permukaan mesh dalam koordinat dunia (m²). */
function worldArea(mesh) {
  const g = mesh.geometry;
  const pos = g.attributes.position;
  const idx = g.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const triCount = idx ? idx.count / 3 : pos.count / 3;
  let area = 0;
  for (let i = 0; i < triCount; i++) {
    const i0 = idx ? idx.getX(i * 3) : i * 3;
    const i1 = idx ? idx.getX(i * 3 + 1) : i * 3 + 1;
    const i2 = idx ? idx.getX(i * 3 + 2) : i * 3 + 2;
    a.fromBufferAttribute(pos, i0).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, i1).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, i2).applyMatrix4(mesh.matrixWorld);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  return area;
}

/** Generator acak dengan seed (Park–Miller), supaya sampling bisa diulang persis. */
export function seededRandom(seed) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Ambil `count` titik acak (berbobot luas) dari permukaan sekumpulan mesh, koordinat dunia.
 * `random` opsional: fungsi acak ber-seed agar hasilnya sama setiap kali dimuat.
 */
export function sampleMeshes(meshes, count, { withColor = false, random = null } = {}) {
  const areas = meshes.map(worldArea);
  const total = areas.reduce((s, a) => s + a, 0) || 1;
  const out = new Float32Array(count * 3);
  const colors = withColor ? new Uint8Array(count * 3) : null;
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const col = new THREE.Color();
  let k = 0;
  meshes.forEach((mesh, mi) => {
    const want = mi === meshes.length - 1 ? count - k : Math.round((areas[mi] / total) * count);
    if (want <= 0) return;
    const sampler = new MeshSurfaceSampler(mesh);
    if (random) sampler.setRandomGenerator(random);
    sampler.build();
    const hasColor = withColor && mesh.geometry.attributes.color;
    for (let i = 0; i < want && k < count; i++, k++) {
      sampler.sample(p, n, hasColor ? col : undefined);
      p.applyMatrix4(mesh.matrixWorld);
      out[k * 3] = p.x; out[k * 3 + 1] = p.y; out[k * 3 + 2] = p.z;
      if (colors) {
        const c = hasColor ? col : mesh.material?.color ?? col.set(0xb0b0b0);
        colors[k * 3] = c.r * 255; colors[k * 3 + 1] = c.g * 255; colors[k * 3 + 2] = c.b * 255;
      }
    }
  });
  return { points: k < count ? out.subarray(0, k * 3) : out, colors, area: total };
}

/**
 * Pecah model rencana menjadi elemen. Satu elemen = node bernama terdekat
 * (mis. "[1]TOP") di atas mesh; mesh tanpa nama spesifik digabung ke induknya.
 */
export function extractElements(root) {
  root.updateMatrixWorld(true);
  const groups = new Map();
  root.traverse((obj) => {
    if (!obj.isMesh) return;
    let node = obj;
    while (node && node !== root && (!displayName(node) || GENERIC_NAME.test(displayName(node)))) node = node.parent;
    if (!node || node === root) node = obj;
    if (!groups.has(node)) groups.set(node, []);
    groups.get(node).push(obj);
  });
  const used = new Map();
  const elements = [];
  for (const [node, meshes] of groups) {
    const raw = displayName(node) || `Elemen ${elements.length + 1}`;
    const m = raw.match(/^\[(\d+)\]\s*(.*)$/);
    const label = m ? `${m[1]} · ${m[2] || raw}` : raw;
    let key = raw;
    const dup = used.get(raw) ?? 0;
    used.set(raw, dup + 1);
    if (dup) key = `${raw}#${dup + 1}`;
    const area = meshes.reduce((s, mesh) => s + worldArea(mesh), 0);
    // Kepadatan sampel ±1 per 4 cm², dibatasi 200..1500 per elemen.
    const count = Math.max(200, Math.min(1500, Math.round(area * 2500)));
    // Seed dari nama elemen: sampel (dan coverage) identik setiap halaman dimuat.
    const { points } = sampleMeshes(meshes, count, { random: seededRandom(hashString(key)) });
    elements.push({ key, label, meshes, area, samples: points, order: m ? Number(m[1]) : 1e6 + elements.length });
  }
  elements.sort((a, b) => a.order - b.order);
  return elements;
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 200);
    this.camera.position.set(1.6, 1.2, -1.8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 1.6));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(3, 5, -2);
    this.scene.add(dir);

    this.grid = new THREE.GridHelper(4, 40, 0x888888, 0xcccccc);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.35;
    this.scene.add(this.grid);

    this.planRoot = null;
    this.elements = [];
    this.cloud = null;
    this.colorMode = 'status';
    this.selectedKey = null;
    this.onPick = null;

    this._bindPicking();
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(container);
    this.resize();
    this.setTheme(matchMedia('(prefers-color-scheme: dark)').matches);
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  setTheme(dark) {
    this.scene.background = new THREE.Color(dark ? 0x1f1f1d : 0xf3f2ef);
    this.grid.material.color?.set?.(dark ? 0x555555 : 0xbbbbbb);
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  async loadPlan(source) {
    const loader = new GLTFLoader();
    const gltf = typeof source === 'string'
      ? await loader.loadAsync(source)
      : await loader.parseAsync(source, '');
    if (this.planRoot) this.scene.remove(this.planRoot);
    this.select(null);
    this.planRoot = gltf.scene;
    this.scene.add(this.planRoot);
    this.elements = extractElements(this.planRoot);
    for (const el of this.elements) {
      for (const mesh of el.meshes) {
        mesh.userData.elementKey = el.key;
        mesh.userData.originalMaterial = mesh.material;
        mesh.userData.statusMaterial = new THREE.MeshStandardMaterial({
          color: STATUS_COLOR.none, roughness: 0.7, metalness: 0, transparent: true, opacity: 0.25,
          side: THREE.DoubleSide, depthWrite: false,
        });
      }
    }
    this.frame();
    return this.elements;
  }

  /** Arahkan kamera agar model terlihat penuh. */
  frame() {
    if (!this.planRoot) return;
    const box = new THREE.Box3().setFromObject(this.planRoot);
    const size = box.getSize(new THREE.Vector3()).length();
    const center = box.getCenter(new THREE.Vector3());
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(0.9, 0.7, -1.1).multiplyScalar(size * 1.4));
    this.camera.near = size / 100;
    this.camera.far = size * 200;
    this.camera.updateProjectionMatrix();
    this.grid.position.y = box.min.y;
  }

  /** statuses: key -> 'done' | 'partial' | 'none' */
  setStatuses(statuses) {
    this.statuses = statuses;
    this._applyMaterials();
  }

  setColorMode(mode) {
    this.colorMode = mode;
    this._applyMaterials();
  }

  select(key) {
    this.selectedKey = key;
    // Sorot elemen terpilih dengan kotak biru, warna status tetap terlihat.
    if (this.selectionBox) {
      this.scene.remove(this.selectionBox);
      this.selectionBox.geometry.dispose();
      this.selectionBox = null;
    }
    const el = this.elements.find((e) => e.key === key);
    if (el) {
      const box = new THREE.Box3();
      for (const mesh of el.meshes) box.expandByObject(mesh);
      box.expandByScalar(0.006);
      this.selectionBox = new THREE.Box3Helper(box, 0x2a78d6);
      this.selectionBox.material.depthTest = false;
      this.selectionBox.renderOrder = 10;
      this.scene.add(this.selectionBox);
    }
    this._applyMaterials();
  }

  _applyMaterials() {
    for (const el of this.elements) {
      const st = this.statuses?.[el.key] ?? 'none';
      const selected = el.key === this.selectedKey;
      for (const mesh of el.meshes) {
        if (this.colorMode === 'original') {
          mesh.material = mesh.userData.originalMaterial;
          continue;
        }
        const m = mesh.userData.statusMaterial;
        m.color.set(STATUS_COLOR[st]);
        m.opacity = st === 'none' ? 0.22 : st === 'partial' ? 0.75 : 0.9;
        m.depthWrite = st !== 'none';
        mesh.material = m;
      }
    }
  }

  /**
   * Tampilkan point cloud scan. Titik ditampilkan di frame mentah, lalu objeknya
   * diberi transform alignment (rotasi Y + translasi), sama persis dengan analysis.js.
   */
  setCloud(points, colors, transform) {
    if (this.cloud) {
      this.scene.remove(this.cloud);
      this.cloud.geometry.dispose();
      this.cloud.material.dispose();
      this.cloud = null;
    }
    if (!points) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(points, 3));
    if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    const m = new THREE.PointsMaterial({
      size: 0.006, sizeAttenuation: true, vertexColors: !!colors, color: colors ? 0xffffff : 0x2a78d6,
    });
    this.cloud = new THREE.Points(g, m);
    this.cloud.visible = this.cloudVisible ?? true;
    this.scene.add(this.cloud);
    this.setCloudTransform(transform);
  }

  setCloudTransform(t) {
    if (!this.cloud || !t) return;
    this.cloud.rotation.set(0, t.yaw, 0);
    this.cloud.position.set(t.tx, t.ty, t.tz);
  }

  setCloudVisible(v) {
    this.cloudVisible = v;
    if (this.cloud) this.cloud.visible = v;
  }

  setPlanVisible(v) {
    if (this.planRoot) this.planRoot.visible = v;
  }

  /** Render gambar kecil dari tampilan saat ini (untuk foto demo / laporan). */
  snapshot(width = 640, height = 480) {
    const prev = new THREE.Vector2();
    this.renderer.getSize(prev);
    const aspect = this.camera.aspect;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL('image/jpeg', 0.85);
    this.renderer.setSize(prev.x, prev.y, false);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    return url;
  }

  _bindPicking() {
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 6) return; // drag, bukan klik
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const meshes = this.elements.flatMap((x) => x.meshes);
      const hit = ray.intersectObjects(meshes, false)[0];
      this.onPick?.(hit ? hit.object.userData.elementKey : null);
    });
  }
}
