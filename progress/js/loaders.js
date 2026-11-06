// Baca file hasil scan LiDAR iPhone menjadi point cloud (Float32Array xyz meter + warna opsional).
// Format: PLY (point cloud atau mesh), OBJ, GLB/GLTF, dan teks XYZ/PTS/CSV/TXT.
// Mesh dikonversi menjadi titik dengan sampling permukaan supaya kepadatannya merata.
import * as THREE from 'three';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { sampleMeshes } from './viewer.js';
import { subsample, voxelDownsample } from './analysis.js';

export const MAX_POINTS = 1500000; // setelah voxel 2 cm: cukup untuk ±300 m² permukaan
export const VOXEL = 0.02;
export const ACCEPT = '.ply,.obj,.glb,.gltf,.xyz,.pts,.txt,.csv';

const MESH_DENSITY = 10000; // titik per m² permukaan mesh (lalu di-voxel 2 cm)

function meshesToCloud(meshes) {
  let area = 0;
  // Hitung luas dulu via sampling 1 titik (sampleMeshes mengembalikan total luas).
  area = sampleMeshes(meshes, 1).area;
  const count = Math.max(20000, Math.min(4000000, Math.round(area * MESH_DENSITY)));
  const { points, colors } = sampleMeshes(meshes, count, { withColor: true });
  const hasAnyColor = meshes.some((m) => m.geometry.attributes.color || m.material?.color);
  return { points, colors: hasAnyColor ? colors : null };
}

function geometryToCloud(geometry) {
  if (geometry.index) {
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMatrixWorld(true);
    return meshesToCloud([mesh]);
  }
  const pos = geometry.attributes.position;
  const points = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    points[i * 3] = pos.getX(i);
    points[i * 3 + 1] = pos.getY(i);
    points[i * 3 + 2] = pos.getZ(i);
  }
  let colors = null;
  const col = geometry.attributes.color;
  if (col) {
    colors = new Uint8Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      colors[i * 3] = Math.round(col.getX(i) * 255);
      colors[i * 3 + 1] = Math.round(col.getY(i) * 255);
      colors[i * 3 + 2] = Math.round(col.getZ(i) * 255);
    }
  }
  return { points, colors };
}

function objectToCloud(root) {
  root.updateMatrixWorld(true);
  const meshes = [];
  const pointsObjs = [];
  root.traverse((o) => {
    if (o.isMesh) meshes.push(o);
    else if (o.isPoints) pointsObjs.push(o);
  });
  if (meshes.length) return meshesToCloud(meshes);
  if (pointsObjs.length) {
    const g = pointsObjs[0].geometry.clone().applyMatrix4(pointsObjs[0].matrixWorld);
    return geometryToCloud(g);
  }
  throw new Error('File tidak berisi mesh atau titik.');
}

function parseText(text) {
  const lines = text.split(/\r?\n/);
  const pts = [];
  const cols = [];
  let colorScale = null;
  for (const line of lines) {
    const parts = line.trim().split(/[\s,;]+/);
    if (parts.length < 3) continue; // baris jumlah titik (PTS) atau kosong
    const v = parts.map(Number);
    if (!Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) continue; // header
    pts.push(v[0], v[1], v[2]);
    // XYZRGB (6 kolom) atau PTS: x y z intensitas r g b (7 kolom)
    const rgb = parts.length >= 7 ? v.slice(4, 7) : parts.length >= 6 ? v.slice(3, 6) : null;
    if (rgb && rgb.every(Number.isFinite)) {
      if (colorScale === null) colorScale = rgb.some((c) => c > 1) ? 1 : 255;
      cols.push(rgb[0] * colorScale, rgb[1] * colorScale, rgb[2] * colorScale);
    }
  }
  if (!pts.length) throw new Error('Tidak ada baris "x y z" yang terbaca.');
  return {
    points: new Float32Array(pts),
    colors: cols.length === pts.length ? Uint8Array.from(cols, (c) => Math.max(0, Math.min(255, c))) : null,
  };
}

/** Konversi Z-up (mis. ekspor CAD/LAS) ke Y-up: (x, y, z) -> (x, z, -y). */
export function zUpToYUp(points) {
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    out[i] = points[i];
    out[i + 1] = points[i + 2];
    out[i + 2] = -points[i + 1];
  }
  return out;
}

/**
 * @param {File} file
 * @param {{zUp?: boolean, unitScale?: number}} opts unitScale: 1 untuk meter, 0.001 untuk mm
 */
export async function loadScanFile(file, opts = {}) {
  const ext = file.name.split('.').pop().toLowerCase();
  let cloud;
  if (ext === 'ply') {
    cloud = geometryToCloud(new PLYLoader().parse(await file.arrayBuffer()));
  } else if (ext === 'obj') {
    cloud = objectToCloud(new OBJLoader().parse(await file.text()));
  } else if (ext === 'glb' || ext === 'gltf') {
    const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
    cloud = objectToCloud((await new GLTFLoader().parseAsync(data, '')).scene);
  } else if (['xyz', 'pts', 'txt', 'csv'].includes(ext)) {
    cloud = parseText(await file.text());
  } else {
    throw new Error(`Format .${ext} belum didukung. Ekspor ulang sebagai PLY, OBJ, GLB, atau XYZ.`);
  }
  let { points, colors } = cloud;
  const scale = opts.unitScale ?? 1;
  if (scale !== 1) points = points.map((v) => v * scale);
  if (opts.zUp) points = zUpToYUp(points);
  ({ points, colors } = subsample(points, 6000000, colors)); // batas memori sebelum voxel
  ({ points, colors } = voxelDownsample(points, colors, VOXEL));
  ({ points, colors } = subsample(points, MAX_POINTS, colors));
  return { points, colors };
}

// ---------- Model rencana (desain fit-out) ----------

export const PLAN_ACCEPT = '.glb,.gltf,.obj,.dae,.fbx';

/**
 * Muat model rencana dari ekspor SketchUp / Revit / dll. Nama grup/komponen menjadi nama
 * elemen, dan grup induknya menjadi kategori.
 * - DAE (SketchUp "Export 3D Model → Collada"): satuan & sumbu dibaca dari file.
 * - OBJ / FBX: satuan ditebak dari ukuran (unit restoran > 100 berarti cm, > 1000 berarti mm).
 * @param {File} file
 * @param {{zUp?: boolean}} opts
 * @returns {Promise<{root: THREE.Object3D, note: string}>}
 */
export async function loadPlanFile(file, opts = {}) {
  const ext = file.name.split('.').pop().toLowerCase();
  let root;
  if (ext === 'glb' || ext === 'gltf') {
    const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
    root = (await new GLTFLoader().parseAsync(data, '')).scene;
  } else if (ext === 'obj') {
    root = new OBJLoader().parse(await file.text());
  } else if (ext === 'dae') {
    const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
    root = new ColladaLoader().parse(await file.text(), '').scene;
  } else if (ext === 'fbx') {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    root = new FBXLoader().parse(await file.arrayBuffer(), '');
  } else {
    throw new Error(`Format .${ext} belum didukung untuk model rencana. Pakai GLB, OBJ, DAE, atau FBX.`);
  }
  const wrap = new THREE.Group();
  wrap.name = '';
  wrap.add(root);
  if (opts.zUp) root.rotation.x = -Math.PI / 2;
  wrap.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(wrap);
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  let unit = 'meter';
  if (ext !== 'dae' && ext !== 'glb' && ext !== 'gltf') {
    if (maxDim > 1000) { wrap.scale.setScalar(0.001); unit = 'milimeter'; }
    else if (maxDim > 100) { wrap.scale.setScalar(0.01); unit = 'sentimeter'; }
  }
  wrap.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(wrap);
  const s = box.getSize(new THREE.Vector3());
  // Posisi model tidak digeser: revisi model dari sumber yang sama tetap sejajar dengan scan lama.
  return {
    root: wrap,
    note: `satuan dibaca sebagai ${unit}, ukuran ${s.x.toFixed(1)} × ${s.z.toFixed(1)} m, tinggi ${s.y.toFixed(1)} m`,
  };
}
