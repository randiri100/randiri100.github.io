// Data demo: scan sintetis yang meniru ekspor LiDAR iPhone (lantai, dinding, benda lain,
// noise ±3 mm, dan frame koordinat ARKit yang acak). Scan ini lewat pipeline yang sama
// dengan file asli (auto-align -> coverage), jadi demo sekaligus menguji alur analisis.
import { sampleMeshes, seededRandom } from './viewer.js';
import { invertTransformPoints } from './analysis.js';

function rng(seed) {
  let s = seed % 2147483647;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Ambil hanya bagian awal elemen (sepanjang sumbu terpanjangnya) untuk meniru pemasangan sebagian. */
function partialCut(points, fraction) {
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
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

function centerY(points) {
  let s = 0;
  for (let i = 1; i < points.length; i += 3) s += points[i];
  return s / (points.length / 3);
}

/**
 * Rencana pemasangan demo: elemen dipasang dari bawah ke atas (urut titik tengah Y).
 * Tiap tahap menambah elemen, dengan satu elemen "sebagian" (15%) kecuali tahap terakhir.
 */
function demoStages(elements) {
  const order = [...elements].sort((a, b) => centerY(a.samples) - centerY(b.samples)).map((e) => e.key);
  const n = order.length;
  const a = Math.max(1, Math.round(n * 0.34));
  const b = Math.max(a + 1, Math.round(n * 0.67));
  const stage = (full, partial) => ({ full: order.slice(0, full), partial: partial < n ? [order[partial]] : [] });
  return [stage(a, a), stage(b, b), stage(n, n)];
}

export function generateDemoScans(elements, seed = 42) {
  const rnd = rng(seed);
  const stages = demoStages(elements);
  const nameOf = (k) => elements.find((e) => e.key === k)?.label ?? k;
  // Batas model untuk menaruh lantai & dinding
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const el of elements) for (let i = 0; i < el.samples.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], el.samples[i + k]);
    max[k] = Math.max(max[k], el.samples[i + k]);
  }
  const labels = ['Minggu 1', 'Minggu 2', 'Minggu 3'];
  const days = [16, 9, 2];

  return stages.map((st, si) => {
    const pts = [];
    const cols = [];
    const wood = (v) => [196 + v * 30, 150 + v * 25, 105 + v * 20];
    const push = (x, y, z, c) => {
      pts.push(x + (rnd() - 0.5) * 0.006, y + (rnd() - 0.5) * 0.006, z + (rnd() - 0.5) * 0.006);
      cols.push(...c);
    };
    const DENSITY = 4000; // titik per m², seragam untuk elemen dan lingkungan (seperti LiDAR)
    for (const el of elements) {
      const full = st.full.includes(el.key);
      const part = st.partial.includes(el.key);
      if (!full && !part) continue;
      const count = Math.max(300, Math.round(el.area * DENSITY));
      let p = Array.from(sampleMeshes(el.meshes, count, { random: seededRandom(seed * 31 + si * 7 + el.order) }).points);
      if (part) p = partialCut(p, 0.2);
      for (let i = 0; i < p.length; i += 3) push(p[i], p[i + 1], p[i + 2], wood(rnd() - 0.5));
    }
    // Sudut workshop: lantai, dinding belakang (3 cm di belakang kabinet), dinding samping,
    // dan barang di lantai.
    const floorY = min[1];
    const x0 = min[0] - 0.45, x1 = max[0] + 1.6;
    const z0 = min[2] - 0.03, z1 = max[2] + 1.8;
    const rect = (n, f) => { for (let i = 0; i < n; i++) f(rnd(), rnd()); };
    rect(Math.round((x1 - x0) * (z1 - z0) * DENSITY), (u, v) => {
      const g = 120 + rnd() * 30;
      push(x0 + u * (x1 - x0), floorY, z0 + v * (z1 - z0), [g, g, g - 5]);
    });
    rect(Math.round((x1 - x0) * 2.4 * DENSITY), (u, v) => {
      const g = 220 + rnd() * 20;
      push(x0 + u * (x1 - x0), floorY + v * 2.4, z0, [g, g - 4, g - 10]);
    });
    rect(Math.round((z1 - z0) * 2.4 * DENSITY), (u, v) => {
      const g = 205 + rnd() * 20;
      push(x0, floorY + v * 2.4, z0 + u * (z1 - z0), [g, g - 6, g - 14]);
    });
    rect(3000, (u, v) => push(max[0] + 0.5 + u * 0.4, floorY + v * 0.45, max[2] + 0.4 + rnd() * 0.4, [160, 120, 70]));
    rect(2000, (u, v) => push(x0 + 0.05 + u * 0.25, floorY + v * 0.6, max[2] + 0.9 + rnd() * 0.3, [90, 110, 140]));
    // Frame ARKit acak: sesi scan berbeda = origin & arah berbeda
    const truth = { yaw: rnd() * Math.PI * 2, tx: (rnd() - 0.5) * 4, ty: -1.2 - rnd() * 0.3, tz: (rnd() - 0.5) * 4 };
    const raw = invertTransformPoints(new Float32Array(pts), truth);
    return {
      date: isoDaysAgo(days[si]),
      label: labels[si],
      note: `Data demo. Dipasang: ${st.full.map(nameOf).join(', ')}.` +
        (st.partial.length ? ` Sedang dipasang: ${st.partial.map(nameOf).join(', ')}.` : ''),
      points: raw,
      colors: Uint8Array.from(cols, (c) => Math.max(0, Math.min(255, c))),
      demo: true,
    };
  });
}
