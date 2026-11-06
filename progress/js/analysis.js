// Analisis progress: perbandingan point cloud hasil scan LiDAR dengan model rencana.
// Modul ini sengaja tidak bergantung pada three.js supaya bisa dites di Node.
//
// Konvensi koordinat: meter, sumbu Y ke atas (sama seperti ARKit dan glTF).
// Transform scan -> model: p' = Ry(yaw) * p + t, dengan
//   x' =  cos(yaw) * x + sin(yaw) * z + tx
//   y' =  y + ty
//   z' = -sin(yaw) * x + cos(yaw) * z + tz
// (sama dengan rotasi sumbu Y di three.js, jadi viewer bisa memakai object.rotation.y = yaw).

export const STATUS = Object.freeze({ DONE: 'done', PARTIAL: 'partial', NONE: 'none' });

export const STATUS_VALUE = Object.freeze({ done: 1, partial: 0.5, none: 0 });

export const DEFAULT_SETTINGS = Object.freeze({
  tolerance: 0.03, // m: jarak maksimum titik scan ke permukaan elemen
  doneThreshold: 0.3, // >= 30% permukaan tertutup titik scan -> terpasang
  partialThreshold: 0.08, // >= 8% -> sebagian
  // Status tidak turun antar scan (mis. ducting tertutup plafon tetap dihitung terpasang).
  // Hanya koreksi manual yang bisa menurunkan status.
  keepStatus: true,
});

export const STATUS_RANK = Object.freeze({ none: 0, partial: 1, done: 2 });

export function identityTransform() {
  return { tx: 0, ty: 0, tz: 0, yaw: 0 };
}

/** Terapkan transform ke Float32Array xyz, hasil array baru. */
export function applyTransform(points, t) {
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    out[i] = c * x + s * z + t.tx;
    out[i + 1] = y + t.ty;
    out[i + 2] = -s * x + c * z + t.tz;
  }
  return out;
}

/** Ambil maksimum `max` titik secara merata (deterministik). */
export function subsample(points, max, colors = null) {
  const n = points.length / 3;
  if (n <= max) return { points, colors };
  const step = n / max;
  const p = new Float32Array(max * 3);
  const c = colors ? new Uint8Array(max * 3) : null;
  for (let i = 0; i < max; i++) {
    const j = Math.floor(i * step) * 3;
    p[i * 3] = points[j];
    p[i * 3 + 1] = points[j + 1];
    p[i * 3 + 2] = points[j + 2];
    if (c) {
      c[i * 3] = colors[j];
      c[i * 3 + 1] = colors[j + 1];
      c[i * 3 + 2] = colors[j + 2];
    }
  }
  return { points: p, colors: c };
}

export function bounds(points) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = points[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * Grid hash spasial untuk pencarian tetangga terdekat.
 * Seluruhnya typed array (titik diurutkan per sel + tabel hash open addressing),
 * sehingga jutaan titik scan satu ruangan tetap hemat memori.
 */
export class SpatialGrid {
  constructor(points, cellSize) {
    this.points = points;
    this.cell = cellSize;
    this.inv = 1 / cellSize;
    const n = points.length / 3;
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      keys[i] = this.key(
        Math.floor(points[i * 3] * this.inv),
        Math.floor(points[i * 3 + 1] * this.inv),
        Math.floor(points[i * 3 + 2] * this.inv),
      );
    }
    const order = new Uint32Array(n);
    for (let i = 0; i < n; i++) order[i] = i;
    order.sort((a, b) => keys[a] - keys[b]);
    let u = 0;
    for (let i = 0; i < n; i++) if (i === 0 || keys[order[i]] !== keys[order[i - 1]]) u++;
    const cellKeys = new Float64Array(u);
    const cellStart = new Uint32Array(u + 1);
    let c = -1;
    for (let i = 0; i < n; i++) {
      const k = keys[order[i]];
      if (c < 0 || k !== cellKeys[c]) { c++; cellKeys[c] = k; cellStart[c] = i; }
    }
    cellStart[u] = n;
    let size = 16;
    while (size < u * 2) size *= 2;
    const table = new Int32Array(size).fill(-1);
    const mask = size - 1;
    for (let i = 0; i < u; i++) {
      let h = this.hash(cellKeys[i]) & mask;
      while (table[h] !== -1) h = (h + 1) & mask;
      table[h] = i;
    }
    Object.assign(this, { order, cellKeys, cellStart, table, mask });
  }

  key(ix, iy, iz) {
    // Gabungkan tiga indeks sel (17 bit per sumbu, < 2^53) menjadi satu angka:
    // tepat untuk ±650 m pada sel 1 cm. Di luar itu hanya terjadi tabrakan kunci,
    // yang aman karena jarak tetap dicek satu per satu.
    return (ix + 65536) * 17179869184 + (iy + 65536) * 131072 + (iz + 65536);
  }

  hash(k) {
    const hi = Math.floor(k / 4294967296);
    const lo = (k - hi * 4294967296) | 0;
    let h = Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b);
    h ^= h >>> 13;
    return Math.imul(h, 0xc2b2ae35) ^ (h >>> 16);
  }

  /** Indeks sel untuk kunci, atau -1. */
  cellOf(k) {
    let h = this.hash(k) & this.mask;
    for (;;) {
      const c = this.table[h];
      if (c === -1) return -1;
      if (this.cellKeys[c] === k) return c;
      h = (h + 1) & this.mask;
    }
  }

  /** Panggil fn(indeksTitik) untuk titik di 27 sel sekitar (x,y,z); berhenti bila fn mengembalikan true. */
  visit(x, y, z, fn) {
    const ix = Math.floor(x * this.inv);
    const iy = Math.floor(y * this.inv);
    const iz = Math.floor(z * this.inv);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const c = this.cellOf(this.key(ix + dx, iy + dy, iz + dz));
          if (c < 0) continue;
          for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) if (fn(this.order[k])) return true;
        }
      }
    }
    return false;
  }

  /** Indeks titik terdekat dalam radius `r` (r <= cellSize), atau -1. */
  nearest(x, y, z, r) {
    const ix = Math.floor(x * this.inv);
    const iy = Math.floor(y * this.inv);
    const iz = Math.floor(z * this.inv);
    let best = -1;
    let bestD = r * r;
    const p = this.points;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const c = this.cellOf(this.key(ix + dx, iy + dy, iz + dz));
          if (c < 0) continue;
          for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) {
            const i = this.order[k];
            const j = i * 3;
            const ex = p[j] - x;
            const ey = p[j + 1] - y;
            const ez = p[j + 2] - z;
            const d = ex * ex + ey * ey + ez * ez;
            if (d <= bestD) {
              bestD = d;
              best = i;
            }
          }
        }
      }
    }
    return best;
  }

  /** True jika ada titik dalam radius `r`. */
  hasWithin(x, y, z, r) {
    const ix = Math.floor(x * this.inv);
    const iy = Math.floor(y * this.inv);
    const iz = Math.floor(z * this.inv);
    const r2 = r * r;
    const p = this.points;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const c = this.cellOf(this.key(ix + dx, iy + dy, iz + dz));
          if (c < 0) continue;
          for (let k = this.cellStart[c], e = this.cellStart[c + 1]; k < e; k++) {
            const j = this.order[k] * 3;
            const ex = p[j] - x;
            const ey = p[j + 1] - y;
            const ez = p[j + 2] - z;
            if (ex * ex + ey * ey + ez * ez <= r2) return true;
          }
        }
      }
    }
    return false;
  }
}

/**
 * Coverage per elemen: fraksi titik sampel permukaan elemen yang punya titik scan
 * dalam jarak `tolerance`. Satu sisi panel yang ter-scan memberi ~50%.
 * @param {Float32Array} scanPoints titik scan yang SUDAH ditransform ke frame model
 * @param {{key:string, samples:Float32Array}[]} elements
 * @returns {Record<string, number>}
 */
export function computeCoverage(scanPoints, elements, tolerance) {
  const grid = new SpatialGrid(scanPoints, tolerance);
  const out = {};
  for (const el of elements) {
    const s = el.samples;
    const n = s.length / 3;
    let hit = 0;
    for (let i = 0; i < n; i++) {
      if (grid.hasWithin(s[i * 3], s[i * 3 + 1], s[i * 3 + 2], tolerance)) hit++;
    }
    out[el.key] = n ? hit / n : 0;
  }
  return out;
}

export function statusFromCoverage(cov, settings) {
  if (cov >= settings.doneThreshold) return STATUS.DONE;
  if (cov >= settings.partialThreshold) return STATUS.PARTIAL;
  return STATUS.NONE;
}

/**
 * Progress keseluruhan = rata-rata nilai status (terpasang 1, sebagian 0.5, belum 0).
 * @param {Record<string,string>} statuses key elemen -> status
 */
export function overallProgress(statuses, elementKeys) {
  if (!elementKeys.length) return 0;
  let sum = 0;
  for (const k of elementKeys) sum += STATUS_VALUE[statuses[k] ?? STATUS.NONE];
  return sum / elementKeys.length;
}

/** Status final per elemen: override manual menang atas hasil otomatis. */
export function resolveStatuses(coverage, overrides, settings, elementKeys) {
  const out = {};
  for (const k of elementKeys) {
    out[k] = overrides?.[k] ?? statusFromCoverage(coverage[k] ?? 0, settings);
  }
  return out;
}

/**
 * Status final setiap elemen di setiap scan (scan harus urut tanggal).
 * Sumber status per elemen:
 *  - 'manual'  : dikoreksi manual di scan ini
 *  - 'auto'    : dari coverage LiDAR
 *  - 'carried' : dibawa dari scan sebelumnya (elemen manual/finishing, atau status yang
 *                tidak boleh turun karena elemen tertutup pekerjaan lain)
 * @param {{id:string, overrides?:Record<string,string>}[]} scans
 * @param {Map<string, Record<string, number>>} coverageById
 * @param {{key:string, manual?:boolean}[]} elements elemen yang dihitung (tanpa eksisting)
 * @returns {Map<string, {statuses:Record<string,string>, sources:Record<string,string>}>}
 */
export function resolveTimeline(scans, coverageById, elements, settings) {
  const out = new Map();
  const prev = {};
  for (const scan of scans) {
    const cov = coverageById.get(scan.id) ?? {};
    const statuses = {};
    const sources = {};
    for (const el of elements) {
      const k = el.key;
      const manual = scan.overrides?.[k];
      if (manual) {
        statuses[k] = manual;
        sources[k] = 'manual';
      } else if (el.manual) {
        statuses[k] = prev[k] ?? STATUS.NONE;
        sources[k] = prev[k] && prev[k] !== STATUS.NONE ? 'carried' : 'manual';
      } else {
        const auto = statusFromCoverage(cov[k] ?? 0, settings);
        if (settings.keepStatus && prev[k] && STATUS_RANK[prev[k]] > STATUS_RANK[auto]) {
          statuses[k] = prev[k];
          sources[k] = 'carried';
        } else {
          statuses[k] = auto;
          sources[k] = 'auto';
        }
      }
      prev[k] = statuses[k];
    }
    out.set(scan.id, { statuses, sources });
  }
  return out;
}

/** Progress berbobot: Σ bobot × nilai status / Σ bobot. */
export function weightedProgress(statuses, elements) {
  let sum = 0;
  let total = 0;
  for (const el of elements) {
    const w = el.weight ?? 1;
    total += w;
    sum += w * STATUS_VALUE[statuses[el.key] ?? STATUS.NONE];
  }
  return total ? sum / total : 0;
}

/** Target rencana pada tanggal tertentu (interpolasi linear kurva S), atau null. */
export function plannedAt(schedule, isoDate) {
  if (!schedule?.length) return null;
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  const pts = schedule.map((p) => [Date.parse(`${p.date}T00:00:00Z`), p.target]).sort((a, b) => a[0] - b[0]);
  if (t <= pts[0][0]) return pts[0][1];
  if (t >= pts.at(-1)[0]) return pts.at(-1)[1];
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i][0]) {
      const [t0, v0] = pts[i - 1];
      const [t1, v1] = pts[i];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0 || 1);
    }
  }
  return pts.at(-1)[1];
}

/** Kurva S standar (smoothstep) dari tanggal mulai sampai target selesai, per minggu. */
export function sCurve(startIso, endIso) {
  const t0 = Date.parse(`${startIso}T00:00:00Z`);
  const t1 = Date.parse(`${endIso}T00:00:00Z`);
  if (!(t1 > t0)) return [];
  const week = 7 * 86400000;
  const out = [];
  for (let t = t0; t < t1; t += week) {
    const u = (t - t0) / (t1 - t0);
    out.push({ date: new Date(t).toISOString().slice(0, 10), target: Math.round(u * u * (3 - 2 * u) * 1000) / 1000 });
  }
  out.push({ date: endIso, target: 1 });
  return out;
}

/**
 * Satu langkah solusi closed-form: rotasi sumbu Y + translasi 3D yang paling
 * cocok untuk pasangan titik (src -> dst). ARKit sudah menyelaraskan sumbu Y
 * dengan gravitasi, jadi rotasi lain tidak diperlukan.
 */
export function solveYawTranslation(src, dst) {
  const n = src.length / 3;
  let sx = 0, sy = 0, sz = 0, mx = 0, my = 0, mz = 0;
  for (let i = 0; i < n; i++) {
    sx += src[i * 3]; sy += src[i * 3 + 1]; sz += src[i * 3 + 2];
    mx += dst[i * 3]; my += dst[i * 3 + 1]; mz += dst[i * 3 + 2];
  }
  sx /= n; sy /= n; sz /= n; mx /= n; my /= n; mz /= n;
  let a = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    const px = src[i * 3] - sx;
    const pz = src[i * 3 + 2] - sz;
    const qx = dst[i * 3] - mx;
    const qz = dst[i * 3 + 2] - mz;
    a += qx * px + qz * pz;
    b += qx * pz - qz * px;
  }
  const yaw = Math.atan2(b, a);
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return {
    yaw,
    tx: mx - (c * sx + s * sz),
    ty: my - sy,
    tz: mz - (-s * sx + c * sz),
  };
}

/** Invers transform: p = Ry(-yaw) * (p' - t). */
export function invertTransformPoints(points, t) {
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  const out = new Float32Array(points.length);
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i] - t.tx;
    const y = points[i + 1] - t.ty;
    const z = points[i + 2] - t.tz;
    out[i] = c * x - s * z;
    out[i + 1] = y;
    out[i + 2] = s * x + c * z;
  }
  return out;
}

/**
 * ICP (iterative closest point) dengan rotasi sumbu Y saja.
 * Pencocokan dari arah MODEL ke scan: tiap titik sampel model mencari titik scan
 * terdekat. Arah ini tahan terhadap lantai, dinding, dan benda lain di scan,
 * karena titik terdekat dari permukaan elemen yang sudah terpasang adalah
 * permukaan elemen itu sendiri. Elemen yang belum terpasang tidak punya pasangan
 * (atau tersaring saat radius mengecil).
 * @param {Float32Array} scan titik scan mentah (frame ARKit)
 * @param {Float32Array} target titik sampel permukaan model rencana
 * @param {object} init transform awal
 * @returns {{transform, inlierRatio:number, rmse:number}}
 */
export function icpYaw(scan, target, init, opts = {}) {
  const radii = opts.radii ?? [0.3, 0.15, 0.08, 0.04, 0.02];
  const itersPerRadius = opts.itersPerRadius ?? 6;
  let t = { ...init };
  const n = target.length / 3;
  const src = new Float32Array(target.length);
  const dst = new Float32Array(target.length);
  // Grid di frame scan mentah, dibangun sekali per radius (dan dipakai ulang antar kandidat).
  const grids = opts.grids ?? new Map();
  const gridFor = (r) => {
    if (!grids.has(r)) grids.set(r, new SpatialGrid(scan, r));
    return grids.get(r);
  };
  for (const r of radii) {
    const grid = gridFor(r);
    for (let it = 0; it < itersPerRadius; it++) {
      const local = invertTransformPoints(target, t);
      let m = 0;
      for (let i = 0; i < n; i++) {
        const j = grid.nearest(local[i * 3], local[i * 3 + 1], local[i * 3 + 2], r);
        if (j < 0) continue;
        src[m * 3] = scan[j * 3];
        src[m * 3 + 1] = scan[j * 3 + 1];
        src[m * 3 + 2] = scan[j * 3 + 2];
        dst[m * 3] = target[i * 3];
        dst[m * 3 + 1] = target[i * 3 + 1];
        dst[m * 3 + 2] = target[i * 3 + 2];
        m++;
      }
      if (m < 10) break;
      const next = solveYawTranslation(src.subarray(0, m * 3), dst.subarray(0, m * 3));
      const delta = Math.abs(next.yaw - t.yaw) + Math.hypot(next.tx - t.tx, next.ty - t.ty, next.tz - t.tz);
      t = next;
      if (delta < 1e-5) break;
    }
  }
  const sr = opts.scoreRadius ?? 0.03;
  return { transform: normalizeYaw(t), ...alignmentScore(scan, target, t, sr, gridFor(sr)) };
}

/** Skor kecocokan: fraksi titik MODEL yang tertutup scan, plus RMSE pasangan inlier. */
export function alignmentScore(scan, target, t, r, grid = null) {
  const g = grid ?? new SpatialGrid(scan, r);
  const local = invertTransformPoints(target, t);
  const n = target.length / 3;
  let hit = 0;
  let se = 0;
  for (let i = 0; i < n; i++) {
    const x = local[i * 3];
    const y = local[i * 3 + 1];
    const z = local[i * 3 + 2];
    const j = g.nearest(x, y, z, r);
    if (j < 0) continue;
    hit++;
    const dx = scan[j * 3] - x;
    const dy = scan[j * 3 + 1] - y;
    const dz = scan[j * 3 + 2] - z;
    se += dx * dx + dy * dy + dz * dz;
  }
  return { inlierRatio: n ? hit / n : 0, rmse: hit ? Math.sqrt(se / hit) : Infinity };
}

function normalizeYaw(t) {
  let y = t.yaw % (2 * Math.PI);
  if (y > Math.PI) y -= 2 * Math.PI;
  if (y < -Math.PI) y += 2 * Math.PI;
  return { ...t, yaw: y };
}

/** Tinggi lantai = persentil 2% sumbu Y (tidak bergantung rotasi sumbu Y). */
export function estimateFloor(points) {
  const n = points.length / 3;
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) ys[i] = points[i * 3 + 1];
  ys.sort();
  return ys[Math.floor(n * 0.02)];
}

function percentileRange(values, lo = 0.02, hi = 0.98) {
  if (!values.length) return 0;
  const v = Float32Array.from(values).sort();
  return v[Math.floor((v.length - 1) * hi)] - v[Math.floor((v.length - 1) * lo)];
}

/**
 * Buang bidang besar lingkungan (lantai, plafon, dinding) dari scan sebelum
 * diselaraskan ke model rencana. Bidang dianggap lingkungan jika lebarnya
 * > `minExtent` meter. Sumbu Y ARKit = gravitasi, jadi cukup cari bidang
 * horizontal (histogram Y) dan bidang vertikal (histogram jarak per sudut).
 * @returns {Float32Array} titik yang tersisa (elemen + benda kecil)
 */
export function removeEnvironmentPlanes(points, opts = {}) {
  const band = opts.band ?? 0.015;
  const minExtent = opts.minExtent ?? 1.5;
  const minFrac = opts.minFraction ?? 0.03;
  let pts = points;
  const removedPlanes = [];
  const removeWhere = (pred) => {
    const keep = [];
    for (let i = 0; i < pts.length; i += 3) if (!pred(pts[i], pts[i + 1], pts[i + 2])) keep.push(pts[i], pts[i + 1], pts[i + 2]);
    pts = new Float32Array(keep);
  };
  const bin = 0.01;
  for (let round = 0; round < 6; round++) {
    const n = pts.length / 3;
    if (n < 200) break;
    const peak = (ang) => {
      const c = Math.cos(ang ?? 0);
      const sn = Math.sin(ang ?? 0);
      const hist = new Map();
      for (let i = 0; i < pts.length; i += 3) {
        const d = ang === null ? pts[i + 1] : pts[i] * c + pts[i + 2] * sn;
        const b = Math.round(d / bin);
        hist.set(b, (hist.get(b) ?? 0) + 1);
      }
      let top = null;
      for (const [b, cnt] of hist) {
        const total = cnt + (hist.get(b - 1) ?? 0) + (hist.get(b + 1) ?? 0);
        if (!top || total > top.count) top = { ang, d: b * bin, count: total };
      }
      return top;
    };
    // Horizontal (sudut null) + vertikal per 2°, lalu haluskan sudut vertikal terbaik per 0,1°
    const horiz = peak(null);
    let vert = null;
    for (let a = 0; a < 180; a += 2) {
      const p = peak((a * Math.PI) / 180);
      if (!vert || p.count > vert.count) vert = p;
    }
    const a0 = vert.ang;
    for (let da = -2; da <= 2; da += 0.1) {
      const p = peak(a0 + (da * Math.PI) / 180);
      if (p.count > vert.count) vert = p;
    }
    const distFn = (pl) => {
      const c = Math.cos(pl.ang ?? 0);
      const sn = Math.sin(pl.ang ?? 0);
      return pl.ang === null ? (x, y) => y - pl.d : (x, y, z) => x * c + z * sn - pl.d;
    };
    // Komponen tersambung terbesar dari titik di dalam pita bidang (grid 2D sel 5 cm).
    // Lebar diukur dari komponen itu saja, supaya potongan benda-benda terpisah yang
    // kebetulan setinggi/sebidang tidak terbaca sebagai satu bidang lebar.
    const component = (pl) => {
      const c = Math.cos(pl.ang ?? 0);
      const sn = Math.sin(pl.ang ?? 0);
      const dist = distFn(pl);
      const cell = 0.05;
      const cells = new Map();
      const uv = (x, y, z) => (pl.ang === null ? [x, z] : [-x * sn + z * c, y]);
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i], y = pts[i + 1], z = pts[i + 2];
        if (Math.abs(dist(x, y, z)) > band) continue;
        const [u, v] = uv(x, y, z);
        const k = `${Math.floor(u / cell)},${Math.floor(v / cell)}`;
        cells.set(k, (cells.get(k) ?? 0) + 1);
      }
      const seen = new Set();
      let bestComp = null;
      for (const start of cells.keys()) {
        if (seen.has(start)) continue;
        const comp = [];
        const stack = [start];
        seen.add(start);
        let count = 0, umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
        while (stack.length) {
          const k = stack.pop();
          comp.push(k);
          count += cells.get(k);
          const [iu, iv] = k.split(',').map(Number);
          umin = Math.min(umin, iu); umax = Math.max(umax, iu); vmin = Math.min(vmin, iv); vmax = Math.max(vmax, iv);
          for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
            const nk = `${iu + du},${iv + dv}`;
            if (cells.has(nk) && !seen.has(nk)) { seen.add(nk); stack.push(nk); }
          }
        }
        if (!bestComp || count > bestComp.count) {
          const wu = (umax - umin + 1) * cell;
          const wv = (vmax - vmin + 1) * cell;
          bestComp = { cells: new Set(comp), count, width: pl.ang === null ? Math.max(wu, wv) : wu };
        }
      }
      return bestComp && { ...bestComp, pl, dist, uv, cell };
    };
    // Bidang lebar (lingkungan) dengan titik terbanyak; panel elemen selalu lebih sempit.
    const wideOnes = [horiz, vert]
      .map((pl) => pl && component(pl))
      .filter((cp) => cp && cp.count >= n * minFrac && cp.width >= minExtent)
      .sort((p, q) => q.count - p.count);
    if (!wideOnes.length) break;
    const cp = wideOnes[0];
    const onPlane = (x, y, z) => {
      if (Math.abs(cp.dist(x, y, z)) > band) return false;
      const [u, v] = cp.uv(x, y, z);
      return cp.cells.has(`${Math.floor(u / cp.cell)},${Math.floor(v / cp.cell)}`);
    };
    removedPlanes.push(onPlane);
    removeWhere(onPlane);
  }
  // Deteksi di sampel kecil, lalu terapkan ke seluruh titik (kepadatan asli tetap).
  if (opts.applyTo) {
    if (!removedPlanes.length) return opts.applyTo;
    pts = opts.applyTo;
    removeWhere((x, y, z) => removedPlanes.some((f) => f(x, y, z)));
  }
  return pts;
}

/**
 * Tebakan awal kasar: lantai scan (persentil 2% sumbu Y) disamakan dengan dasar model,
 * pusat horizontal titik scan yang dekat lantai+tinggi model disamakan dengan pusat model.
 */
export function coarseGuess(scan, target, yaw = 0, floorY = null) {
  const tb = bounds(target);
  const rotated = applyTransform(scan, { tx: 0, ty: 0, tz: 0, yaw });
  const n = rotated.length / 3;
  const floor = floorY ?? estimateFloor(scan);
  const height = tb.max[1] - tb.min[1];
  let cx = 0, cz = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const y = rotated[i * 3 + 1] - floor;
    if (y < 0.01 || y > height) continue; // abaikan lantai dan benda di atas model
    cx += rotated[i * 3];
    cz += rotated[i * 3 + 2];
    m++;
  }
  if (!m) m = 1;
  return {
    yaw,
    tx: (tb.min[0] + tb.max[0]) / 2 - cx / m,
    ty: tb.min[1] - floor,
    tz: (tb.min[2] + tb.max[2]) / 2 - cz / m,
  };
}

/**
 * Penalti ruang kosong: fraksi titik scan yang jatuh DI DALAM volume model
 * (kotak batas, tanpa 3 cm terbawah supaya lantai tidak terhitung) tetapi tidak
 * menempel pada permukaan elemen mana pun. Pose yang salah (mis. dinding
 * dicocokkan ke panel belakang) membuat elemen yang benar-benar ter-scan
 * melayang di tempat kosong, sehingga penaltinya besar.
 */
export function freeSpaceViolation(scan, target, t, r = 0.03, targetGrid = null) {
  const tb = bounds(target);
  const g = targetGrid ?? new SpatialGrid(target, r);
  const moved = applyTransform(scan, t);
  const floor = tb.min[1] + 0.03;
  let inside = 0;
  let bad = 0;
  for (let i = 0; i < moved.length; i += 3) {
    const x = moved[i], y = moved[i + 1], z = moved[i + 2];
    if (x < tb.min[0] || x > tb.max[0] || y < floor || y > tb.max[1] || z < tb.min[2] || z > tb.max[2]) continue;
    inside++;
    if (!g.hasWithin(x, y, z, r)) bad++;
  }
  return inside ? bad / inside : 0;
}

/**
 * Kandidat pose global tanpa tebakan awal: untuk tiap sudut, setiap pasangan
 * (sampel model, titik scan) memberi suara untuk satu pergeseran horizontal
 * (bin 4 cm). Puncak suara = pergeseran yang menempatkan banyak titik scan tepat
 * di permukaan model. Tinggi (Y) diambil dari lantai.
 */
/**
 * Kandidat tinggi lantai di model rencana: dasar model, plus bidang horizontal kuat
 * di 50 cm terbawah (mis. sisi atas slab, bukan sisi bawahnya yang tidak terlihat).
 */
export function planFloorCandidates(target) {
  const tb = bounds(target);
  const out = [tb.min[1]];
  const bin = 0.02;
  const hist = new Map();
  let band = 0;
  for (let i = 1; i < target.length; i += 3) {
    const y = target[i];
    if (y > tb.min[1] + 0.5) continue;
    band++;
    const b = Math.round(y / bin);
    hist.set(b, (hist.get(b) ?? 0) + 1);
  }
  const peaks = [...hist].filter(([, c]) => c >= band * 0.05).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [b] of peaks) if (out.every((y) => Math.abs(y - b * bin) > 0.03)) out.push(b * bin);
  return out;
}

/**
 * Kandidat pose global tanpa tebakan awal, dengan mencocokkan "denah" irisan horizontal
 * setinggi dinding (di atas lantai, di bawah plafon) antara scan dan model:
 *  1. Titik di pita ketinggian itu diubah menjadi sel 2D (x, z) yang terisi.
 *  2. Sudut kandidat: selisih arah dinding dominan (ruangan hampir selalu siku, jadi
 *     kelipatan 90°) + sapuan kasar sebagai cadangan.
 *  3. Untuk tiap sudut, setiap pasangan sel (model, scan) memberi suara untuk satu
 *     pergeseran (akumulator typed array). Puncak = translasi kandidat.
 * Tinggi (Y) diambil dari lantai scan vs kandidat lantai model.
 */
export function voteCandidates(scan, target, floorY, opts = {}) {
  const tb = bounds(target);
  const size = Math.max(tb.max[0] - tb.min[0], tb.max[2] - tb.min[2]);
  const bin = opts.bin ?? Math.min(0.12, Math.max(0.03, size / 120));
  const sweep = opts.yawSteps ?? 24;
  const perYaw = opts.perYaw ?? 2;
  const out = [];
  for (const planFloor of opts.planFloors ?? planFloorCandidates(target)) {
    const height = tb.max[1] - planFloor;
    const lo = Math.min(0.15, height * 0.15);
    const hi = Math.max(lo + 0.1, Math.min(2.4, height - 0.25));
    const M = sub2(bandCells(target, planFloor + lo, planFloor + hi, bin).points2, opts.targetCells ?? 1200);
    const S = sub2(bandCells(scan, floorY + lo, floorY + hi, bin).points2, opts.scanCells ?? 2000);
    if (M.length < 6 || S.length < 6) continue;
    const yaws = [];
    const am = dominantAngle(M, bin);
    const as = dominantAngle(S, bin);
    for (let k = 0; k < 4; k++) for (const d of [-1, 0, 1]) yaws.push(as - am + (k * Math.PI) / 2 + (d * Math.PI) / 180);
    for (let k = 0; k < sweep; k++) yaws.push((k / sweep) * 2 * Math.PI);
    for (const yaw of yaws) {
      for (const p of correlate(S, M, yaw, bin, perYaw)) {
        out.push({ yaw, tx: p.ox, ty: planFloor - floorY, tz: p.oz, votes: p.votes });
      }
    }
    // Benda kecil (mis. satu kabinet): irisan bisa melewatkan bagian rendah; tambah voting
    // pasangan titik 3D yang setinggi.
    if (size < 3) out.push(...votePairs(scan, target, planFloor - floorY, opts));
  }
  return out;
}

function votePairs(scan, target, ty, opts) {
  const steps = 24;
  const bin = 0.04;
  const S = subsample(scan, 1500).points;
  const M = subsample(target, 300).points;
  const out = [];
  for (let k = 0; k < steps; k++) {
    const yaw = (k / steps) * 2 * Math.PI;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const votes = new Map();
    for (let i = 0; i < S.length; i += 3) {
      const y = S[i + 1] + ty;
      const rx = c * S[i] + sn * S[i + 2];
      const rz = -sn * S[i] + c * S[i + 2];
      for (let j = 0; j < M.length; j += 3) {
        if (Math.abs(M[j + 1] - y) > 0.03) continue;
        const key = Math.round((M[j] - rx) / bin) * 100000 + Math.round((M[j + 2] - rz) / bin);
        votes.set(key, (votes.get(key) ?? 0) + 1);
      }
    }
    const scored = [];
    for (const [key, v] of votes) {
      if (v < 3) continue;
      let sum = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) sum += votes.get(key + dx * 100000 + dz) ?? 0;
      scored.push([key, sum]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const picked = [];
    for (const [key, sum] of scored) {
      const ix = Math.round(key / 100000);
      const iz = key - ix * 100000;
      if (picked.some((p) => Math.abs(p.ix - ix) <= 3 && Math.abs(p.iz - iz) <= 3)) continue;
      picked.push({ ix, iz, sum });
      if (picked.length >= 2) break;
    }
    for (const p of picked) out.push({ yaw, tx: p.ix * bin, ty, tz: p.iz * bin, votes: p.sum });
  }
  return out;
}

function sub2(P, max) {
  const n = P.length / 2;
  if (n <= max) return P;
  const out = new Float32Array(max * 2);
  const step = n / max;
  for (let i = 0; i < max; i++) { const j = Math.floor(i * step) * 2; out[i * 2] = P[j]; out[i * 2 + 1] = P[j + 1]; }
  return out;
}

/** Sel 2D unik (pusat x, z) dari titik dengan y di [lo, hi]. Hasil: {points2: Float32Array [x,z,...]}. */
function bandCells(points, lo, hi, cell) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < points.length; i += 3) {
    const y = points[i + 1];
    if (y < lo || y > hi) continue;
    const ix = Math.floor(points[i] / cell);
    const iz = Math.floor(points[i + 2] / cell);
    const k = ix * 1000003 + iz;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push((ix + 0.5) * cell, (iz + 0.5) * cell);
  }
  return { points2: new Float32Array(out) };
}

/** Arah dinding dominan (0..90°) dari sel 2D: sudut yang membuat proyeksi paling "tajam". */
function dominantAngle(P, bin) {
  const sharp = (a) => {
    const c = Math.cos(a), s = Math.sin(a);
    const h1 = new Map(), h2 = new Map();
    for (let i = 0; i < P.length; i += 2) {
      const u = Math.round((P[i] * c + P[i + 1] * s) / bin);
      const v = Math.round((-P[i] * s + P[i + 1] * c) / bin);
      h1.set(u, (h1.get(u) ?? 0) + 1);
      h2.set(v, (h2.get(v) ?? 0) + 1);
    }
    let e = 0;
    for (const n of h1.values()) e += n * n;
    for (const n of h2.values()) e += n * n;
    return e;
  };
  let best = 0, bestE = -1;
  for (let d = 0; d < 90; d += 2) {
    const e = sharp((d * Math.PI) / 180);
    if (e > bestE) { bestE = e; best = d; }
  }
  for (let d = best - 2; d <= best + 2; d += 0.25) {
    const e = sharp((d * Math.PI) / 180);
    if (e > bestE) { bestE = e; best = d; }
  }
  return (best * Math.PI) / 180;
}

/** Korelasi 2D: puncak pergeseran (ox, oz) supaya sel scan (diputar yaw) menimpa sel model. */
function correlate(S, M, yaw, bin, perYaw) {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  const n = S.length / 2;
  const R = new Float32Array(S.length);
  let rx0 = Infinity, rx1 = -Infinity, rz0 = Infinity, rz1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = c * S[i * 2] + s * S[i * 2 + 1];
    const z = -s * S[i * 2] + c * S[i * 2 + 1];
    R[i * 2] = x; R[i * 2 + 1] = z;
    if (x < rx0) rx0 = x; if (x > rx1) rx1 = x; if (z < rz0) rz0 = z; if (z > rz1) rz1 = z;
  }
  let mx0 = Infinity, mx1 = -Infinity, mz0 = Infinity, mz1 = -Infinity;
  for (let i = 0; i < M.length; i += 2) {
    if (M[i] < mx0) mx0 = M[i]; if (M[i] > mx1) mx1 = M[i];
    if (M[i + 1] < mz0) mz0 = M[i + 1]; if (M[i + 1] > mz1) mz1 = M[i + 1];
  }
  const ox0 = mx0 - rx1, oz0 = mz0 - rz1;
  const W = Math.ceil((mx1 - rx0 - ox0) / bin) + 2;
  const H = Math.ceil((mz1 - rz0 - oz0) / bin) + 2;
  if (W * H > 4e6) return [];
  const acc = new Int32Array(W * H);
  for (let j = 0; j < M.length; j += 2) {
    const mx = M[j] - ox0, mz = M[j + 1] - oz0;
    for (let i = 0; i < n; i++) {
      const u = Math.round((mx - R[i * 2]) / bin);
      const v = Math.round((mz - R[i * 2 + 1]) / bin);
      acc[v * W + u]++;
    }
  }
  // Jumlahkan 3x3 supaya puncak tidak terpecah di batas bin, lalu ambil puncak yang berjauhan.
  const peaks = [];
  for (let v = 1; v < H - 1; v++) {
    for (let u = 1; u < W - 1; u++) {
      const a = acc[v * W + u];
      if (a < 3) continue;
      let sum = 0;
      for (let dv = -1; dv <= 1; dv++) for (let du = -1; du <= 1; du++) sum += acc[(v + dv) * W + u + du];
      if (peaks.length < perYaw * 8 || sum > peaks[peaks.length - 1].votes) {
        peaks.push({ u, v, votes: sum });
        peaks.sort((p, q) => q.votes - p.votes);
        if (peaks.length > perYaw * 8) peaks.pop();
      }
    }
  }
  const picked = [];
  for (const p of peaks) {
    if (picked.some((q) => Math.abs(q.u - p.u) <= 3 && Math.abs(q.v - p.v) <= 3)) continue;
    picked.push(p);
    if (picked.length >= perYaw) break;
  }
  return picked.map((p) => ({ ox: ox0 + p.u * bin, oz: oz0 + p.v * bin, votes: p.votes }));
}

/**
 * Auto-align: coba beberapa sudut awal dengan data kecil (cepat), lalu
 * sempurnakan dua kandidat terbaik dengan data lebih banyak.
 * Skor pilihan = fraksi permukaan acuan yang tertutup scan - penalti ruang kosong.
 * opts.freeSpace=false mematikan penalti (dipakai saat acuannya scan lain, bukan model).
 */
// Radius akhir 2 cm: cukup pasangan untuk scan yang di-voxel 2 cm, dan tidak tertarik
// ke dinding/benda yang berjarak 3 cm dari permukaan elemen.
const FINE_RADII = [0.12, 0.06, 0.03, 0.02];

export function autoAlign(scan, target, opts = {}) {
  const useFree = opts.freeSpace ?? true;
  const floorY = opts.floorY ?? estimateFloor(subsample(scan, 50000).points);
  if (opts.removeEnvironment) scan = objectPoints(scan, target);
  // Voxel (bukan subsample acak) supaya kepadatan permukaan tetap rata: penting untuk ruangan.
  const { points: coarseScan, voxel: cv } = voxelCap(scan, opts.coarsePoints ?? 60000, 0.05);
  const coarseTarget = subsample(target, 1500).points;
  const cr = Math.max(0.04, cv); // radius skor kasar mengikuti ukuran voxel
  const coarseGrids = new Map();
  // Radius "ruang kosong" mengikuti ukuran model: 3 cm untuk benda, sampai 15 cm untuk ruangan.
  const tbx = bounds(target);
  const fr = Math.min(0.15, Math.max(0.03, Math.max(tbx.max[0] - tbx.min[0], tbx.max[2] - tbx.min[2]) / 100));
  const freeGrid = useFree ? new SpatialGrid(target, fr) : null;
  // Penalti ruang kosong dihitung di titik kasar (cukup sebagai fraksi, jauh lebih cepat).
  const score = (res) => {
    res.violation = useFree ? freeSpaceViolation(coarseScan, target, res.transform, fr, freeGrid) : 0;
    res.score = res.inlierRatio - res.violation;
    return res;
  };
  const better = (a, b) => !b || a.score > b.score + 1e-6 ||
    (Math.abs(a.score - b.score) <= 1e-6 && a.rmse < b.rmse);

  const starts = opts.init ? [opts.init] : [];
  const useVotes = opts.votes ?? true;
  if (useVotes) {
    // Kandidat dari voting: nilai semuanya dengan skor cepat (tanpa ICP), lalu hanya
    // yang terbaik yang diteruskan ke ICP.
    const quickGrid = new SpatialGrid(coarseScan, cr);
    coarseGrids.set(cr, quickGrid);
    const voted = voteCandidates(coarseScan, target, floorY).map((c) => {
      const q = alignmentScore(coarseScan, coarseTarget, c, cr, quickGrid);
      return { c, q: q.inlierRatio - (useFree ? freeSpaceViolation(coarseScan, target, c, fr, freeGrid) : 0) };
    }).sort((a, b) => b.q - a.q);
    // Kandidat voting sudah tepat ±4 cm: haluskan dengan radius kecil supaya tidak ditarik benda lain.
    starts.push(...voted.slice(0, opts.voteStarts ?? 8).map((v) => ({ ...v.c, near: true })));
  }
  // Tebakan dari titik tengah: cadangan bila voting mati atau tidak menghasilkan kandidat.
  const guessSteps = opts.yawSteps ?? (useVotes && starts.length > (opts.init ? 1 : 0) ? 0 : 12);
  for (let k = 0; k < guessSteps; k++) starts.push(coarseGuess(coarseScan, target, (k / guessSteps) * 2 * Math.PI, floorY));
  const coarse = starts.map((init) => score(
    icpYaw(coarseScan, coarseTarget, init, {
      radii: init.near ? [Math.max(0.3, cv * 2.5), Math.max(0.12, cv * 1.6), cr] : [Math.max(0.3, cv * 3), Math.max(0.15, cv * 2), Math.max(0.08, cv * 1.6)],
      itersPerRadius: 5, scoreRadius: cr, grids: coarseGrids,
    }),
  ));
  coarse.sort((a, b) => (better(a, b) ? -1 : 1));

  const fineScan = voxelCap(scan, opts.maxPoints ?? 400000, 0.02).points;
  const fineTarget = subsample(target, opts.targetPoints ?? 20000).points;
  const fineGrids = new Map();
  let best = null;
  for (const c of coarse.slice(0, opts.keep ?? 3)) {
    const res = score(icpYaw(fineScan, fineTarget, c.transform, { radii: FINE_RADII, itersPerRadius: 8, grids: fineGrids }));
    if (better(res, best)) best = res;
  }
  return best;
}

/**
 * Buang titik sampel yang berada di sambungan dengan elemen lain (dalam jarak `radius`
 * dari permukaan elemen lain). Tanpa ini, elemen yang belum terpasang ikut terhitung
 * "sebagian" karena tepinya menempel pada elemen tetangga yang sudah ter-scan.
 */
export function exclusiveSamples(elements, radius) {
  const total = elements.reduce((n, el) => n + el.samples.length, 0);
  const allPts = new Float32Array(total);
  const owner = new Uint32Array(total / 3);
  // Radius sambungan per elemen: minimal `radius`, tapi ikut jarak antar-sampel elemen itu
  // (slab/dinding besar disampel jarang, jadi butuh radius lebih besar untuk menangkap
  // sisi pekerjaan yang menempel padanya).
  const rad = elements.map((el) => {
    const spacing = el.area && el.samples.length ? Math.sqrt(el.area / (el.samples.length / 3)) : 0;
    return Math.min(0.15, Math.max(radius, spacing * 1.2));
  });
  const maxR = Math.max(radius, ...rad);
  let o = 0;
  elements.forEach((el, idx) => {
    allPts.set(el.samples, o);
    owner.fill(idx, o / 3, (o + el.samples.length) / 3);
    o += el.samples.length;
  });
  const grid = new SpatialGrid(allPts, maxR);
  return elements.map((el, idx) => {
    const keep = [];
    const s = el.samples;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      const shared = grid.visit(x, y, z, (j) => {
        const oj = owner[j];
        if (oj === idx) return false;
        const r = rad[oj];
        const ex = allPts[j * 3] - x, ey = allPts[j * 3 + 1] - y, ez = allPts[j * 3 + 2] - z;
        return ex * ex + ey * ey + ez * ez <= r * r;
      });
      if (!shared) keep.push(x, y, z);
    }
    // Elemen yang seluruhnya tertutup elemen lain: pakai semua sampel apa adanya.
    return { ...el, samples: keep.length >= 30 ? new Float32Array(keep) : el.samples };
  });
}

/** Titik scan tanpa bidang besar lingkungan; kembali ke scan utuh bila sisanya terlalu sedikit. */
export function objectPoints(scan, target) {
  const tb = bounds(target);
  const size = Math.max(tb.max[0] - tb.min[0], tb.max[2] - tb.min[2]);
  const cleaned = removeEnvironmentPlanes(subsample(scan, 60000).points, { minExtent: Math.max(1.5, size * 1.3), applyTo: scan });
  return cleaned.length / 3 >= 300 ? cleaned : scan;
}

/**
 * Selaraskan scan ke model rencana.
 * - Tanpa acuan: cari pose terhadap model (lingkungan dibuang dulu).
 * - Dengan acuan (titik scan sebelumnya, sudah di frame model): pose kasar dari
 *   kecocokan lingkungan (lantai, dinding, benda tetap) sehingga tidak bisa
 *   tertukar arah, lalu dihaluskan ke model memakai titik elemen saja.
 * @returns {{transform, inlierRatio, rmse, reference: 'plan'|'scan'}}
 */
export function alignScan(scan, plan, reference = null, opts = {}) {
  const floorY = estimateFloor(subsample(scan, 50000).points);
  const objectsAll = objectPoints(scan, plan);
  if (!reference) {
    const res = autoAlign(objectsAll, plan, { floorY, ...opts });
    return res && { ...res, reference: 'plan' };
  }
  const coarse = autoAlign(scan, subsample(reference, 8000).points, { freeSpace: false, floorY, keep: 2, ...opts });
  const objects = voxelCap(objectsAll, 400000, 0.02).points;
  const planSub = subsample(plan, 20000).points;
  // Model rencana adalah acuan sebenarnya: haluskan dari radius cukup besar supaya kesalahan
  // kecil pada scan acuan (beberapa cm sampai ±20 cm) tidak terwariskan ke scan berikutnya.
  const viaScan = icpYaw(objects, planSub, coarse.transform, { radii: [0.25, 0.12, 0.06, 0.03, 0.02], itersPerRadius: 8 });
  // Pengaman untuk lingkungan yang "licin" (mis. hanya satu dinding, scan bisa bergeser
  // sepanjang dinding): bandingkan dengan penyelarasan langsung ke model, ambil yang
  // jelas lebih baik. Hasil via scan diberi keunggulan kecil karena tidak bisa tertukar arah.
  // Hasil via scan acuan biasanya sudah benar; cek ulang ke model hanya bila kecocokannya lemah.
  if (viaScan.inlierRatio >= (opts.trustRatio ?? 0.15) && viaScan.rmse <= 0.025) return { ...viaScan, reference: 'scan' };
  const viaPlan = autoAlign(objectsAll, plan, { floorY, ...opts });
  const pb = bounds(plan);
  const fr = Math.min(0.15, Math.max(0.03, Math.max(pb.max[0] - pb.min[0], pb.max[2] - pb.min[2]) / 100));
  const planGrid = new SpatialGrid(plan, fr);
  const objCoarse = voxelCap(objectsAll, 60000, 0.05).points;
  const sc = (r) => r.inlierRatio - freeSpaceViolation(objCoarse, plan, r.transform, fr, planGrid);
  if (viaPlan && sc(viaPlan) > sc(viaScan) + 0.05) return { ...viaPlan, reference: 'plan' };
  return { ...viaScan, reference: 'scan' };
}

/**
 * Voxel downsampling: satu titik per kubus `voxel` meter. Kepadatan scan jadi seragam
 * (dekat/jauh dari iPhone) dan ukuran data turun drastis untuk scan satu ruangan.
 * Memakai tabel hash typed array (tanpa Map) supaya kuat untuk jutaan titik.
 */
export function voxelDownsample(points, colors, voxel = 0.02) {
  const n = points.length / 3;
  let size = 16;
  while (size < n * 2) size *= 2;
  const table = new Float64Array(size).fill(-1);
  const mask = size - 1;
  const inv = 1 / voxel;
  const grid = SpatialGrid.prototype;
  const keep = new Uint32Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const k = grid.key(
      Math.floor(points[i * 3] * inv),
      Math.floor(points[i * 3 + 1] * inv),
      Math.floor(points[i * 3 + 2] * inv),
    );
    let h = grid.hash(k) & mask;
    let fresh = true;
    while (table[h] !== -1) {
      if (table[h] === k) { fresh = false; break; }
      h = (h + 1) & mask;
    }
    if (!fresh) continue;
    table[h] = k;
    keep[m++] = i;
  }
  const p = new Float32Array(m * 3);
  const c = colors ? new Uint8Array(m * 3) : null;
  for (let j = 0; j < m; j++) {
    const i = keep[j] * 3;
    p[j * 3] = points[i]; p[j * 3 + 1] = points[i + 1]; p[j * 3 + 2] = points[i + 2];
    if (c) { c[j * 3] = colors[i]; c[j * 3 + 1] = colors[i + 1]; c[j * 3 + 2] = colors[i + 2]; }
  }
  return { points: p, colors: c };
}

/**
 * Buang titik scan di luar kotak batas model (+ margin) setelah transform diketahui,
 * mis. koridor mall atau unit tetangga yang ikut ter-scan.
 */
export function cropToBounds(points, colors, transform, box, margin = 1) {
  const moved = applyTransform(points, transform);
  const keep = [];
  for (let i = 0; i < moved.length; i += 3) {
    const x = moved[i], y = moved[i + 1], z = moved[i + 2];
    if (x < box.min[0] - margin || x > box.max[0] + margin) continue;
    if (y < box.min[1] - margin || y > box.max[1] + margin) continue;
    if (z < box.min[2] - margin || z > box.max[2] + margin) continue;
    keep.push(i / 3);
  }
  const p = new Float32Array(keep.length * 3);
  const c = colors ? new Uint8Array(keep.length * 3) : null;
  keep.forEach((idx, j) => {
    const i = idx * 3;
    p[j * 3] = points[i]; p[j * 3 + 1] = points[i + 1]; p[j * 3 + 2] = points[i + 2];
    if (c) { c[j * 3] = colors[i]; c[j * 3 + 1] = colors[i + 1]; c[j * 3 + 2] = colors[i + 2]; }
  });
  return { points: p, colors: c };
}

/**
 * Voxel downsampling dengan ukuran voxel yang dinaikkan bertahap sampai jumlah titik
 * <= maxPoints. Hasilnya tetap merata di seluruh permukaan (beda dengan subsample acak).
 */
export function voxelCap(points, maxPoints, startVoxel = 0.02) {
  let voxel = startVoxel;
  let out = points;
  for (let i = 0; i < 8; i++) {
    out = voxelDownsample(points, null, voxel).points;
    if (out.length / 3 <= maxPoints) break;
    voxel *= 1.6;
  }
  return { points: out.length / 3 <= maxPoints ? out : subsample(out, maxPoints).points, voxel };
}
