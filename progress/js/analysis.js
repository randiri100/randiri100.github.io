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
  tolerance: 0.02, // m: jarak maksimum titik scan ke permukaan elemen
  doneThreshold: 0.3, // >= 30% permukaan tertutup titik scan -> terpasang
  partialThreshold: 0.08, // >= 8% -> sebagian
});

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
 * Disimpan sebagai daftar sel terurut (tanpa Map per titik) agar hemat memori.
 */
export class SpatialGrid {
  constructor(points, cellSize) {
    this.points = points;
    this.cell = cellSize;
    this.inv = 1 / cellSize;
    const n = points.length / 3;
    const keys = new Array(n);
    for (let i = 0; i < n; i++) {
      keys[i] = this.key(
        Math.floor(points[i * 3] * this.inv),
        Math.floor(points[i * 3 + 1] * this.inv),
        Math.floor(points[i * 3 + 2] * this.inv),
      );
    }
    this.buckets = new Map();
    for (let i = 0; i < n; i++) {
      let b = this.buckets.get(keys[i]);
      if (!b) {
        b = [];
        this.buckets.set(keys[i], b);
      }
      b.push(i);
    }
  }

  key(ix, iy, iz) {
    // Gabungkan tiga indeks sel (17 bit per sumbu, < 2^53) menjadi satu angka:
    // tepat untuk ±650 m pada sel 1 cm. Di luar itu hanya terjadi tabrakan kunci,
    // yang aman karena jarak tetap dicek satu per satu.
    return (ix + 65536) * 17179869184 + (iy + 65536) * 131072 + (iz + 65536);
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
          const b = this.buckets.get(this.key(ix + dx, iy + dy, iz + dz));
          if (!b) continue;
          for (let k = 0; k < b.length; k++) {
            const j = b[k] * 3;
            const ex = p[j] - x;
            const ey = p[j + 1] - y;
            const ez = p[j + 2] - z;
            const d = ex * ex + ey * ey + ez * ez;
            if (d <= bestD) {
              bestD = d;
              best = b[k];
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
          const b = this.buckets.get(this.key(ix + dx, iy + dy, iz + dz));
          if (!b) continue;
          for (let k = 0; k < b.length; k++) {
            const j = b[k] * 3;
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
  for (const r of radii) {
    const grid = new SpatialGrid(scan, r); // grid di frame scan mentah, dibangun sekali per radius
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
  return { transform: normalizeYaw(t), ...alignmentScore(scan, target, t, opts.scoreRadius ?? 0.02) };
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
    removeWhere((x, y, z) => {
      if (Math.abs(cp.dist(x, y, z)) > band) return false;
      const [u, v] = cp.uv(x, y, z);
      return cp.cells.has(`${Math.floor(u / cp.cell)},${Math.floor(v / cp.cell)}`);
    });
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
export function voteCandidates(scan, target, floorY, opts = {}) {
  const steps = opts.yawSteps ?? 24;
  const perYaw = opts.perYaw ?? 2;
  const bin = opts.bin ?? 0.04;
  const tb = bounds(target);
  const ty = tb.min[1] - floorY;
  const S = subsample(scan, opts.scanPoints ?? 1500).points;
  const M = subsample(target, opts.targetPoints ?? 300).points;
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
        if (Math.abs(M[j + 1] - y) > 0.03) continue; // hanya pasangan setinggi
        const key = Math.round((M[j] - rx) / bin) * 100000 + Math.round((M[j + 2] - rz) / bin);
        votes.set(key, (votes.get(key) ?? 0) + 1);
      }
    }
    // Jumlahkan dengan 8 tetangga supaya puncak tidak terpecah di batas bin.
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
      if (picked.some((p) => Math.abs(p.ix - ix) <= 3 && Math.abs(p.iz - iz) <= 3)) continue; // puncak berbeda
      picked.push({ ix, iz, sum });
      if (picked.length >= perYaw) break;
    }
    for (const p of picked) out.push({ yaw, tx: p.ix * bin, ty, tz: p.iz * bin, votes: p.sum });
  }
  return out;
}

/**
 * Auto-align: coba beberapa sudut awal dengan data kecil (cepat), lalu
 * sempurnakan dua kandidat terbaik dengan data lebih banyak.
 * Skor pilihan = fraksi permukaan acuan yang tertutup scan - penalti ruang kosong.
 * opts.freeSpace=false mematikan penalti (dipakai saat acuannya scan lain, bukan model).
 */
export function autoAlign(scan, target, opts = {}) {
  const useFree = opts.freeSpace ?? true;
  const floorY = opts.floorY ?? estimateFloor(subsample(scan, 50000).points);
  if (opts.removeEnvironment) scan = objectPoints(scan, target);
  const coarseScan = subsample(scan, opts.coarsePoints ?? 4000).points;
  const coarseTarget = subsample(target, 1500).points;
  const freeGrid = useFree ? new SpatialGrid(target, 0.03) : null;
  const score = (res, pts) => {
    res.violation = useFree ? freeSpaceViolation(pts, target, res.transform, 0.03, freeGrid) : 0;
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
    const quickGrid = new SpatialGrid(coarseScan, 0.04);
    const voted = voteCandidates(coarseScan, target, floorY).map((c) => {
      const q = alignmentScore(coarseScan, coarseTarget, c, 0.04, quickGrid);
      return { c, q: q.inlierRatio - (useFree ? freeSpaceViolation(coarseScan, target, c, 0.03, freeGrid) : 0) };
    }).sort((a, b) => b.q - a.q);
    // Kandidat voting sudah tepat ±4 cm: haluskan dengan radius kecil supaya tidak ditarik benda lain.
    starts.push(...voted.slice(0, opts.voteStarts ?? 8).map((v) => ({ ...v.c, near: true })));
  }
  // Tebakan dari titik tengah: cadangan bila voting mati atau tidak menghasilkan kandidat.
  const guessSteps = opts.yawSteps ?? (useVotes && starts.length > (opts.init ? 1 : 0) ? 0 : 12);
  for (let k = 0; k < guessSteps; k++) starts.push(coarseGuess(coarseScan, target, (k / guessSteps) * 2 * Math.PI, floorY));
  const coarse = starts.map((init) => score(
    icpYaw(coarseScan, coarseTarget, init, {
      radii: init.near ? [0.08, 0.04] : [0.3, 0.15, 0.08], itersPerRadius: 5, scoreRadius: 0.04,
    }),
    coarseScan));
  coarse.sort((a, b) => (better(a, b) ? -1 : 1));

  const fineScan = subsample(scan, opts.maxPoints ?? 15000).points;
  let best = null;
  for (const c of coarse.slice(0, opts.keep ?? 4)) {
    const res = score(icpYaw(fineScan, target, c.transform, { radii: [0.08, 0.04, 0.02], itersPerRadius: 8 }), fineScan);
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
  const all = [];
  const owner = [];
  elements.forEach((el, idx) => {
    for (let i = 0; i < el.samples.length; i++) all.push(el.samples[i]);
    for (let i = 0; i < el.samples.length / 3; i++) owner.push(idx);
  });
  const allPts = new Float32Array(all);
  const grid = new SpatialGrid(allPts, radius);
  const r2 = radius * radius;
  return elements.map((el, idx) => {
    const keep = [];
    const s = el.samples;
    for (let i = 0; i < s.length; i += 3) {
      const x = s[i], y = s[i + 1], z = s[i + 2];
      let shared = false;
      const ix = Math.floor(x * grid.inv), iy = Math.floor(y * grid.inv), iz = Math.floor(z * grid.inv);
      outer: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const b = grid.buckets.get(grid.key(ix + dx, iy + dy, iz + dz));
        if (!b) continue;
        for (const j of b) {
          if (owner[j] === idx) continue;
          const ex = allPts[j * 3] - x, ey = allPts[j * 3 + 1] - y, ez = allPts[j * 3 + 2] - z;
          if (ex * ex + ey * ey + ez * ez <= r2) { shared = true; break outer; }
        }
      }
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
  const cleaned = removeEnvironmentPlanes(subsample(scan, 60000).points, { minExtent: Math.max(1.5, size * 1.3) });
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
  const objects = subsample(objectsAll, 15000).points;
  const viaScan = icpYaw(objects, plan, coarse.transform, { radii: [0.06, 0.03, 0.02], itersPerRadius: 8 });
  // Pengaman untuk lingkungan yang "licin" (mis. hanya satu dinding, scan bisa bergeser
  // sepanjang dinding): bandingkan dengan penyelarasan langsung ke model, ambil yang
  // jelas lebih baik. Hasil via scan diberi keunggulan kecil karena tidak bisa tertukar arah.
  const viaPlan = autoAlign(objectsAll, plan, { floorY, ...opts });
  const sc = (r) => r.inlierRatio - freeSpaceViolation(objects, plan, r.transform);
  if (viaPlan && sc(viaPlan) > sc(viaScan) + 0.05) return { ...viaPlan, reference: 'plan' };
  return { ...viaScan, reference: 'scan' };
}
