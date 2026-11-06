// Model rencana demo: fit-out restoran di unit mall 16 × 12 m (tinggi slab ke slab 4,5 m).
// Disusun seperti ekspor SketchUp: grup kategori → elemen (grup/komponen bernama) → mesh.
// Koordinat meter, Y ke atas. Shopfront menghadap koridor mall di z = 12; dapur di belakang.
import * as THREE from 'three';

export const DEMO_PLAN_NAME = 'Contoh: restoran 16 × 12 m (demo)';
export const UNIT = { x0: 0, x1: 16, z0: 0, z1: 12, height: 4.5 };

const COLORS = {
  'Eksisting (shell mall)': 0xb9b6ae,
  MEP: 0x8fa3b8,
  Partisi: 0xe3ddd0,
  Plafon: 0xf2f0ea,
  Fasad: 0x6f7a86,
  'Bar & Dapur': 0xb08a64,
  Interior: 0xa8744f,
  Finishing: 0xd9c9a8,
};

/** Struktur demo: kategori → elemen → kotak [x0,y0,z0,x1,y1,z1]. */
export const DEMO_LAYOUT = {
  'Eksisting (shell mall)': {
    'Slab lantai': [[0, -0.2, 0, 16, 0, 12]],
    'Dinding unit belakang': [[-0.2, 0, -0.2, 16.2, 4.5, 0]],
    'Dinding unit kiri': [[-0.2, 0, 0, 0, 4.5, 12]],
    'Dinding unit kanan': [[16, 0, 0, 16.2, 4.5, 12]],
    'Kolom C1': [[5.7, 0, 5.7, 6.3, 4.5, 6.3]],
    'Kolom C2': [[11.7, 0, 7.7, 12.3, 4.5, 8.3]],
    'Slab atas': [[0, 4.5, 0, 16, 4.7, 12]],
  },
  MEP: {
    'Ducting AC utama': [[1, 3.6, 6.6, 15, 4.0, 7.2]],
    'Ducting exhaust dapur': [[2, 3.3, 0.4, 6, 3.9, 1.0]],
  },
  Partisi: {
    'Partisi dapur 1': [[0, 0, 4.2, 7, 3.2, 4.35]],
    'Partisi dapur 2': [[8.2, 0, 4.2, 10.65, 3.2, 4.35]],
    'Partisi dapur sisi kanan': [[10.5, 0, 0, 10.65, 3.2, 4.2]],
    'Partisi toilet tengah': [[13.25, 0, 0, 13.37, 3.0, 4.2]],
    'Partisi toilet depan': [[10.65, 0, 4.2, 12, 3.0, 4.32], [13, 0, 4.2, 16, 3.0, 4.32]],
  },
  Plafon: {
    'Plafon dapur': [[0, 2.8, 0, 10.5, 2.812, 4.2]],
    'Plafon dining zona A': [[0, 3.0, 4.35, 8, 3.012, 12]],
    'Plafon dining zona B': [[8, 3.0, 4.35, 16, 3.012, 12]],
    'Plafon toilet': [[10.65, 2.7, 0, 16, 2.712, 4.2]],
  },
  Fasad: {
    'Rangka shopfront': [
      ...[0, 2, 4, 6.94, 9, 11, 13, 15.94].map((x) => [x, 0, 11.88, x + 0.06, 3.0, 12]),
      [0, 2.9, 11.88, 16, 3.0, 12],
    ],
    'Kaca shopfront': [[0.06, 0, 11.93, 6.94, 2.9, 11.942], [9.06, 0, 11.93, 15.94, 2.9, 11.942]],
    'Signage box': [[4, 3.1, 11.9, 12, 3.8, 12.15]],
  },
  'Bar & Dapur': {
    'Bar counter': [[2, 0, 8, 7, 1.1, 8.7]],
    'Back bar kabinet': [[0.05, 0, 5.5, 0.65, 2.2, 9.5]],
    'Kitchen hood': [[1, 1.9, 0.15, 5, 2.5, 1.25]],
    'Meja masak (cooking line)': [[1, 0, 0.15, 5, 0.9, 1.0]],
    'Meja prep stainless': [[6, 0, 0.15, 9.5, 0.9, 0.85]],
    Chiller: [[8.2, 0, 2.6, 10.3, 2.0, 3.4]],
  },
  Interior: {
    'Lantai panggung kayu': [[9, 0, 8.6, 15.5, 0.15, 11.5]],
    'Booth seating': [[15.3, 0, 4.6, 16, 1.2, 6.2], [15.3, 0, 6.4, 16, 1.2, 8.0]],
    'Meja makan zona A': [[1.5, 6.9], [3.5, 6.9], [1.5, 9.4], [3.5, 9.4], [5.5, 9.4], [1.5, 10.8]]
      .map(([x, z]) => [x, 0, z, x + 0.8, 0.75, z + 0.8]),
  },
  Finishing: {
    'Keramik lantai dining': [[0, 0, 4.35, 16, 0.012, 12]],
    'Cat plafon dining': [[0, 2.99, 4.35, 16, 3.0, 12]],
  },
};

/** Bobot pekerjaan demo (mis. dari RAB); elemen lain bobot 1. */
export const DEMO_WEIGHTS = {
  'Ducting AC utama': 4, 'Ducting exhaust dapur': 3,
  'Partisi dapur 1': 2, 'Partisi dapur 2': 1.5, 'Partisi dapur sisi kanan': 1, 'Partisi toilet tengah': 1, 'Partisi toilet depan': 1.5,
  'Plafon dapur': 2.5, 'Plafon dining zona A': 3, 'Plafon dining zona B': 3, 'Plafon toilet': 1,
  'Rangka shopfront': 3, 'Kaca shopfront': 3, 'Signage box': 2,
  'Bar counter': 4, 'Back bar kabinet': 2.5, 'Kitchen hood': 4, 'Meja masak (cooking line)': 3, 'Meja prep stainless': 2, Chiller: 2,
  'Lantai panggung kayu': 2.5, 'Booth seating': 3, 'Meja makan zona A': 1.5,
  'Keramik lantai dining': 5, 'Cat plafon dining': 2,
};

export function buildDemoPlan() {
  const root = new THREE.Group();
  root.name = '';
  for (const [cat, items] of Object.entries(DEMO_LAYOUT)) {
    const g = new THREE.Group();
    g.name = cat;
    const mat = new THREE.MeshStandardMaterial({
      color: COLORS[cat] ?? 0xcccccc, roughness: 0.8,
      transparent: cat.startsWith('Eksisting'), opacity: cat.startsWith('Eksisting') ? 0.35 : 1,
    });
    for (const [name, boxes] of Object.entries(items)) {
      const el = new THREE.Group();
      el.name = name;
      for (const [x0, y0, z0, x1, y1, z1] of boxes) {
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
        mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
        el.add(mesh);
      }
      g.add(el);
    }
    root.add(g);
  }
  root.updateMatrixWorld(true);
  return root;
}
