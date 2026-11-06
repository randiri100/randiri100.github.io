// Data demo fit-out restoran: 5 scan mingguan sintetis yang meniru ekspor LiDAR iPhone
// (kepadatan seragam ±500 titik/m², noise ±3 mm, frame koordinat ARKit acak, koridor mall,
// tumpukan material, dan plafon yang menutupi ducting di atasnya). Scan ini lewat pipeline
// yang sama dengan file asli (penyelarasan → coverage), jadi demo sekaligus menguji analisis.
import { sampleMeshes, seededRandom } from './viewer.js';
import { invertTransformPoints } from './analysis.js';
import { UNIT, DEMO_WEIGHTS } from './demo-plan.js';

const DENSITY = 500; // titik per m²

function isoDaysFromToday(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Urutan kerja fit-out: elemen yang selesai / sedang dikerjakan di tiap scan. */
const STAGES = [
  { day: -28, label: 'Minggu 1', full: [], partial: ['Ducting AC utama', 'Partisi dapur 1'] },
  {
    day: -21, label: 'Minggu 2',
    full: ['Ducting AC utama', 'Ducting exhaust dapur', 'Partisi dapur 1', 'Partisi dapur 2', 'Partisi dapur sisi kanan'],
    partial: ['Partisi toilet tengah', 'Rangka shopfront'],
  },
  {
    day: -14, label: 'Minggu 3',
    full: ['Partisi toilet tengah', 'Partisi toilet depan', 'Rangka shopfront', 'Plafon dapur', 'Lantai panggung kayu'],
    partial: ['Plafon dining zona A', 'Bar counter'],
  },
  {
    day: -7, label: 'Minggu 4',
    full: ['Plafon dining zona A', 'Plafon toilet', 'Bar counter', 'Kitchen hood', 'Meja masak (cooking line)'],
    partial: ['Plafon dining zona B', 'Back bar kabinet', 'Signage box'],
  },
  {
    day: -1, label: 'Minggu 5',
    full: ['Plafon dining zona B', 'Back bar kabinet', 'Meja prep stainless', 'Chiller', 'Signage box'],
    partial: ['Booth seating'],
  },
];

/** Status pekerjaan finishing yang diisi manual dari foto (tidak terdeteksi LiDAR). */
const MANUAL = [
  {},
  {},
  { 'Keramik lantai dining': 'partial' },
  { 'Keramik lantai dining': 'done', 'Cat plafon dining': 'partial' },
  { 'Kaca shopfront': 'partial' },
];

/** Kurva S rencana (target progress kumulatif per tanggal, relatif terhadap hari ini). */
export function demoSchedule() {
  return [[-35, 0], [-28, 0.08], [-21, 0.22], [-14, 0.42], [-7, 0.65], [0, 0.85], [7, 0.97], [10, 1]]
    .map(([d, target]) => ({ date: isoDaysFromToday(d), target }));
}

export function demoElementConfig(elements) {
  const cfg = {};
  for (const e of elements) if (DEMO_WEIGHTS[e.label] != null) cfg[e.key] = { weight: DEMO_WEIGHTS[e.label] };
  return cfg;
}

function partialCut(points, fraction) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], points[i + k]);
    max[k] = Math.max(max[k], points[i + k]);
  }
  const ext = max.map((v, k) => v - min[k]);
  const ax = ext.indexOf(Math.max(...ext));
  const limit = min[ax] + ext[ax] * fraction;
  const out = [];
  for (let i = 0; i < points.length; i += 3) if (points[i + ax] <= limit) out.push(points[i], points[i + 1], points[i + 2]);
  return out;
}

const CAT_COLOR = {
  MEP: [150, 165, 185], Partisi: [225, 220, 205], Plafon: [240, 238, 232], Fasad: [95, 105, 115],
  'Bar & Dapur': [176, 138, 100], Interior: [168, 116, 79], Finishing: [215, 200, 170],
};

export function generateDemoScans(elements, seed = 42) {
  const rnd = seededRandom(seed);
  const byLabel = new Map(elements.map((e) => [e.label, e]));
  const done = new Set();

  return STAGES.map((st, si) => {
    st.full.forEach((n) => done.add(n));
    const pts = [];
    const cols = [];
    const push = (x, y, z, c) => {
      pts.push(x + (rnd() - 0.5) * 0.006, y + (rnd() - 0.5) * 0.006, z + (rnd() - 0.5) * 0.006);
      const v = (rnd() - 0.5) * 24;
      cols.push(c[0] + v, c[1] + v, c[2] + v);
    };
    // Plafon yang sudah terpasang menutupi semua yang ada di atasnya (ducting, slab atas).
    const ceilings = elements.filter((e) => e.category === 'Plafon' && done.has(e.label)).map((e) => {
      const b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, y: -Infinity };
      for (let i = 0; i < e.samples.length; i += 3) {
        b.x0 = Math.min(b.x0, e.samples[i]); b.x1 = Math.max(b.x1, e.samples[i]);
        b.z0 = Math.min(b.z0, e.samples[i + 2]); b.z1 = Math.max(b.z1, e.samples[i + 2]);
        b.y = Math.max(b.y, e.samples[i + 1]);
      }
      return b;
    });
    // (hanya bagian dalam: tepi 20 cm dibiarkan, mis. signage di luar garis shopfront)
    const hidden = (x, y, z) => ceilings.some((b) => x > b.x0 + 0.2 && x < b.x1 - 0.2 && z > b.z0 + 0.2 && z < b.z1 - 0.2 && y > b.y + 0.02);
    const inside = (x, y, z) => x >= -0.01 && x <= UNIT.x1 + 0.01 && z >= -0.01 && z <= UNIT.z1 + 0.05 &&
      y >= -0.01 && y <= UNIT.height + 0.01;

    for (const el of elements) {
      const isFull = el.existing || done.has(el.label);
      const isPart = !isFull && st.partial.includes(el.label);
      if ((!isFull && !isPart) || el.manual) continue; // finishing tidak punya bentuk yang terbaca LiDAR
      const count = Math.max(200, Math.round(el.area * DENSITY));
      const rand = seededRandom(seed * 31 + si * 7 + Math.round(el.area * 1000));
      let p = Array.from(sampleMeshes(el.meshes, count, { random: rand }).points);
      if (isPart) p = partialCut(p, 0.2);
      const c = el.existing ? [170, 168, 160] : CAT_COLOR[el.category] ?? [200, 200, 200];
      for (let i = 0; i < p.length; i += 3) {
        const x = p[i], y = p[i + 1], z = p[i + 2];
        if (el.existing && !inside(x, y, z)) continue; // sisi luar shell tidak terlihat dari dalam unit
        if (hidden(x, y, z)) continue;
        push(x, y, z, c);
      }
    }
    // Koridor mall di depan shopfront + toko seberang (nanti dibuang oleh crop).
    for (let i = 0; i < 20 * 5 * DENSITY * 0.5; i++) push(-2 + rnd() * 20, 0, 12 + rnd() * 5, [205, 200, 190]);
    for (let i = 0; i < 20 * 4.5 * DENSITY * 0.5; i++) push(-2 + rnd() * 20, rnd() * 4.5, 17, [120, 130, 140]);
    // Tumpukan material / perancah, berpindah tiap minggu.
    for (let b = 0; b < 4; b++) {
      const x = 1 + rnd() * 13, z = 4.8 + rnd() * 6, w = 0.6 + rnd() * 0.8, h = 0.4 + rnd() * 1.2;
      for (let i = 0; i < 1500; i++) {
        const f = Math.floor(rnd() * 5);
        const u = rnd(), v = rnd();
        const c = [190, 160, 110];
        if (f === 0) push(x + u * w, h, z + v * w, c);
        else if (f === 1) push(x, v * h, z + u * w, c);
        else if (f === 2) push(x + w, v * h, z + u * w, c);
        else if (f === 3) push(x + u * w, v * h, z, c);
        else push(x + u * w, v * h, z + w, c);
      }
    }
    // Frame ARKit acak: tiap sesi scan punya origin & arah sendiri.
    const truth = { yaw: rnd() * Math.PI * 2, tx: (rnd() - 0.5) * 6, ty: -1.3 - rnd() * 0.3, tz: (rnd() - 0.5) * 6 };
    const overrides = {};
    for (const [name, status] of Object.entries(MANUAL[si])) {
      const el = byLabel.get(name);
      if (el) overrides[el.key] = status;
    }
    return {
      date: isoDaysFromToday(st.day),
      label: st.label,
      note: `Data demo. Selesai minggu ini: ${st.full.join(', ') || '–'}.` +
        (st.partial.length ? ` Sedang dikerjakan: ${st.partial.join(', ')}.` : ''),
      points: invertTransformPoints(new Float32Array(pts), truth),
      colors: Uint8Array.from(cols, (c) => Math.max(0, Math.min(255, c))),
      overrides,
      expected: { full: [...done], partial: st.partial }, // untuk pengujian
      truth, // pose sebenarnya (frame ARKit → model), untuk pengujian
      demo: true,
    };
  });
}
