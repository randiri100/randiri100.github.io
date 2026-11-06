import { Viewer } from './viewer.js';
import { loadScanFile, ACCEPT } from './loaders.js';
import { store, serializeProject, parseProject } from './store.js';
import { renderProgressChart, escapeHtml } from './chart.js';
import { generateDemoScans } from './demo.js';
import {
  DEFAULT_SETTINGS, STATUS, alignScan, applyTransform, computeCoverage, exclusiveSamples,
  icpYaw, identityTransform, objectPoints, overallProgress, resolveStatuses, statusFromCoverage, subsample,
} from './analysis.js';

const DEFAULT_PLAN_URL = '../model.glb';
const DEFAULT_PLAN_NAME = 'model.glb (kabinet)';

const $ = (sel) => document.querySelector(sel);

const STATUS_LABEL = { done: '✓ Terpasang', partial: '◐ Sebagian', none: '○ Belum' };
const STATUS_TEXT = { done: 'Terpasang', partial: 'Sebagian', none: 'Belum' };

const state = {
  settings: { ...DEFAULT_SETTINGS },
  projectName: 'Progress Tracker',
  planName: DEFAULT_PLAN_NAME,
  elements: [],
  coverageElements: [], // sampel tanpa area sambungan
  target: null, // gabungan sampel semua elemen (untuk alignment)
  scans: [],
  coverage: new Map(), // scanId -> {key: frac}
  selectedScanId: null,
  selectedKey: null,
  pendingPhotos: [],
};

let viewer;

// ---------- utilitas UI ----------

const fmtPct = (v) => `${Math.round(v * 100)}%`;
const fmtDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
const fmtShortDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

async function busy(msg, fn) {
  $('#busy-msg').textContent = msg;
  $('#busy').hidden = false;
  await nextFrame();
  try {
    return await fn();
  } finally {
    $('#busy').hidden = true;
  }
}

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/** Perkecil foto kamera (maks 1600 px) menjadi JPEG data URL agar hemat penyimpanan. */
async function photoToDataUrl(file, max = 1600) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new Error(`Foto "${file.name}" tidak bisa dibaca browser ini (HEIC? coba pilih lewat Safari atau ubah ke JPEG).`);
  }
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.82);
}

// ---------- perhitungan ----------

function elementKeys() {
  return state.elements.map((e) => e.key);
}

function rebuildCoverageElements() {
  state.coverageElements = exclusiveSamples(state.elements, state.settings.tolerance * 1.5);
  const total = state.elements.reduce((s, e) => s + e.samples.length, 0);
  state.target = new Float32Array(total);
  let o = 0;
  for (const e of state.elements) { state.target.set(e.samples, o); o += e.samples.length; }
}

function computeScanCoverage(scan) {
  const moved = applyTransform(scan.points, scan.transform);
  const cov = computeCoverage(moved, state.coverageElements, state.settings.tolerance);
  state.coverage.set(scan.id, cov);
  return cov;
}

function recomputeAll() {
  for (const s of state.scans) computeScanCoverage(s);
}

function statusesFor(scan) {
  return resolveStatuses(state.coverage.get(scan.id) ?? {}, scan.overrides, state.settings, elementKeys());
}

function summaryFor(scan) {
  const st = statusesFor(scan);
  const keys = elementKeys();
  return {
    statuses: st,
    progress: overallProgress(st, keys),
    done: keys.filter((k) => st[k] === STATUS.DONE).length,
    partial: keys.filter((k) => st[k] === STATUS.PARTIAL).length,
    total: keys.length,
  };
}

function sortScans() {
  state.scans.sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

const selectedScan = () => state.scans.find((s) => s.id === state.selectedScanId) ?? null;

async function saveScan(scan) {
  try {
    await store.putScan(scan);
  } catch (err) {
    console.error(err);
    toast('Gagal menyimpan ke penyimpanan browser (penuh?). Ekspor proyek untuk backup.', 5000);
  }
}

// ---------- render ----------

function renderAll() {
  renderKpis();
  renderTabs();
  renderViewer();
  renderDetail();
  renderChart();
  renderMatrix();
}

function renderKpis() {
  const scans = state.scans;
  const photos = scans.reduce((s, x) => s + (x.photos?.length ?? 0), 0);
  $('#kpi-photos').textContent = String(photos);
  if (!scans.length) {
    $('#kpi-progress').textContent = '–';
    $('#kpi-delta').textContent = 'belum ada scan';
    $('#kpi-done').textContent = `0/${state.elements.length}`;
    $('#kpi-partial').innerHTML = '&nbsp;';
    $('#kpi-last').textContent = '–';
    $('#kpi-count').textContent = '0 scan';
    return;
  }
  const last = scans.at(-1);
  const sum = summaryFor(last);
  $('#kpi-progress').textContent = fmtPct(sum.progress);
  if (scans.length > 1) {
    const prev = summaryFor(scans.at(-2)).progress;
    const d = Math.round((sum.progress - prev) * 100);
    $('#kpi-delta').textContent = `${d >= 0 ? '+' : '−'}${Math.abs(d)} poin dari scan sebelumnya`;
  } else {
    $('#kpi-delta').textContent = 'scan pertama';
  }
  $('#kpi-done').textContent = `${sum.done}/${sum.total}`;
  $('#kpi-partial').textContent = sum.partial ? `${sum.partial} elemen sebagian` : 'tidak ada yang sebagian';
  $('#kpi-last').textContent = fmtDate(last.date);
  $('#kpi-count').textContent = `${scans.length} scan · ${last.label || ''}`.replace(/ · $/, '');
}

function renderTabs() {
  const wrap = $('#scan-tabs');
  wrap.innerHTML = '';
  if (!state.scans.length) {
    wrap.innerHTML = '<span class="empty" style="margin:0">Model rencana</span>';
    return;
  }
  for (const s of state.scans) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'scan-tab';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(s.id === state.selectedScanId));
    b.textContent = `${fmtShortDate(s.date)} · ${fmtPct(summaryFor(s).progress)}`;
    b.title = s.label || fmtDate(s.date);
    b.addEventListener('click', () => selectScan(s.id));
    wrap.appendChild(b);
  }
  wrap.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderViewer() {
  const scan = selectedScan();
  if (!scan) {
    viewer.setCloud(null);
    viewer.setStatuses({});
    return;
  }
  viewer.setStatuses(statusesFor(scan));
  if (viewer.cloudScanId !== scan.id) {
    viewer.setCloud(scan.points, scan.colors, scan.transform);
    viewer.cloudScanId = scan.id;
  } else {
    viewer.setCloudTransform(scan.transform);
  }
  viewer.select(state.selectedKey);
}

function renderDetail() {
  const box = $('#scan-detail');
  const scan = selectedScan();
  if (!scan) {
    box.innerHTML = `<p class="empty">Belum ada scan. Tekan <strong>+ Tambah scan</strong> untuk mengunggah hasil scan LiDAR,
      atau buka <strong>Menu → Muat data demo</strong> untuk mencoba.</p>
      <div><p class="section-title">Elemen rencana (${state.elements.length})</p>
      <ul class="el-list">${state.elements.map((e) => `<li class="el-row${e.key === state.selectedKey ? ' selected' : ''}" data-key="${escapeHtml(e.key)}">
        <span class="el-name">${escapeHtml(e.label)}</span><span class="el-cov">${(e.area).toFixed(2)} m² permukaan</span></li>`).join('')}</ul></div>`;
    box.querySelectorAll('.el-row').forEach((row) => row.addEventListener('click', () => selectElement(row.dataset.key)));
    return;
  }
  const sum = summaryFor(scan);
  const cov = state.coverage.get(scan.id) ?? {};
  const t = scan.transform;
  const weak = (scan.align?.inlierRatio ?? 1) < 0.15;
  box.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(scan.label || 'Scan')}</h2>
        <div class="date">${fmtDate(scan.date)}${scan.demo ? ' · demo' : ''}</div>
      </div>
      <div class="detail-progress">${fmtPct(sum.progress)}<small>${sum.done}/${sum.total} terpasang</small></div>
    </div>
    <textarea class="note-input" id="d-note" rows="2" maxlength="500" placeholder="Catatan lapangan…" aria-label="Catatan scan">${escapeHtml(scan.note || '')}</textarea>
    <div>
      <p class="section-title">Elemen</p>
      <ul class="el-list" id="d-elements"></ul>
    </div>
    <div>
      <p class="section-title">Foto lapangan (${scan.photos?.length ?? 0})</p>
      <div class="photos" id="d-photos">${(scan.photos ?? []).map((p) =>
        `<button type="button" data-photo="${p.id}" title="${escapeHtml(p.name || '')}"><img src="${p.dataUrl}" alt="${escapeHtml(p.name || 'Foto lapangan')}" loading="lazy" /></button>`).join('')}</div>
      <div class="photo-actions">
        <button class="btn small" type="button" id="d-camera">📷 Kamera</button>
        <button class="btn small" type="button" id="d-pick">Pilih foto</button>
      </div>
    </div>
    <div class="align-box">
      <p class="section-title">Penyelarasan ke model</p>
      <p class="meta${weak ? ' warn' : ''}">${alignText(scan)}${weak ? ' · kecocokan rendah, cek posisi point cloud' : ''}</p>
      <div class="align-actions">
        <button class="btn small" type="button" id="d-auto">Auto-align ulang</button>
        <button class="btn small" type="button" id="d-refine">Sempurnakan</button>
      </div>
      <details id="d-manual">
        <summary>Atur manual</summary>
        <div class="align-actions" style="margin-top:8px">
          <button class="btn small" type="button" data-rot="90">↺ 90°</button>
          <button class="btn small" type="button" data-rot="-90">↻ 90°</button>
          <button class="btn small" type="button" data-rot="180">180°</button>
        </div>
        <div class="align-grid">
          <label>Geser X (m)<input type="number" step="0.01" data-t="tx" value="${t.tx.toFixed(3)}" /></label>
          <label>Geser Y (m)<input type="number" step="0.01" data-t="ty" value="${t.ty.toFixed(3)}" /></label>
          <label>Geser Z (m)<input type="number" step="0.01" data-t="tz" value="${t.tz.toFixed(3)}" /></label>
          <label>Putar (°)<input type="number" step="1" data-t="yaw" value="${((t.yaw * 180) / Math.PI).toFixed(1)}" /></label>
        </div>
      </details>
    </div>
    <div class="detail-actions">
      <button class="btn small danger" type="button" id="d-delete">Hapus scan</button>
    </div>`;

  const list = box.querySelector('#d-elements');
  for (const e of state.elements) {
    const st = sum.statuses[e.key];
    const c = cov[e.key] ?? 0;
    const auto = statusFromCoverage(c, state.settings);
    const manual = scan.overrides?.[e.key];
    const li = document.createElement('li');
    li.className = `el-row${e.key === state.selectedKey ? ' selected' : ''}`;
    li.dataset.key = e.key;
    li.innerHTML = `
      <span class="el-name">${escapeHtml(e.label)} <span class="chip ${st}${manual ? ' manual' : ''}">${STATUS_LABEL[st]}</span></span>
      <span class="el-cov"><span class="bar" title="Permukaan tertutup scan"><i class="${auto}" style="width:${Math.min(100, c * 100)}%"></i><b style="left:${state.settings.doneThreshold * 100}%"></b></span>${fmtPct(c)}</span>
      <select aria-label="Status ${escapeHtml(e.label)}">
        <option value="">Otomatis</option>
        <option value="done">Terpasang</option>
        <option value="partial">Sebagian</option>
        <option value="none">Belum</option>
      </select>`;
    const sel = li.querySelector('select');
    sel.value = manual ?? '';
    sel.addEventListener('click', (ev) => ev.stopPropagation());
    sel.addEventListener('change', async () => {
      scan.overrides = { ...(scan.overrides ?? {}) };
      if (sel.value) scan.overrides[e.key] = sel.value;
      else delete scan.overrides[e.key];
      await saveScan(scan);
      renderAll();
    });
    li.addEventListener('click', () => selectElement(e.key));
    list.appendChild(li);
  }

  box.querySelector('#d-note').addEventListener('change', async (ev) => {
    scan.note = ev.target.value;
    await saveScan(scan);
  });
  box.querySelectorAll('[data-photo]').forEach((b) => b.addEventListener('click', () => openPhoto(scan, b.dataset.photo)));
  box.querySelector('#d-camera').addEventListener('click', () => $('#file-camera').click());
  box.querySelector('#d-pick').addEventListener('click', () => $('#file-photos').click());
  box.querySelector('#d-auto').addEventListener('click', () => realign(scan, false));
  box.querySelector('#d-refine').addEventListener('click', () => realign(scan, true));
  box.querySelector('#d-delete').addEventListener('click', () => deleteScan(scan));

  const manual = box.querySelector('#d-manual');
  if (state.manualOpen) manual.open = true;
  manual.addEventListener('toggle', () => { state.manualOpen = manual.open; });
  let timer;
  manual.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', async () => {
    scan.transform = rotateAboutModel(scan.transform, Number(b.dataset.rot));
    scan.align = null;
    computeScanCoverage(scan);
    await saveScan(scan);
    renderAll();
  }));
  manual.querySelectorAll('input[data-t]').forEach((inp) => inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v)) return;
    scan.transform = { ...scan.transform, [inp.dataset.t]: inp.dataset.t === 'yaw' ? (v * Math.PI) / 180 : v };
    scan.align = null;
    viewer.setCloudTransform(scan.transform);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      computeScanCoverage(scan);
      await saveScan(scan);
      renderKpis(); renderTabs(); renderViewer(); renderChart(); renderMatrix();
      refreshElementRows(scan);
    }, 250);
  }));
}

function alignText(scan) {
  const a = scan.align;
  if (!a) return 'Diatur manual · tekan Sempurnakan untuk menghaluskan dari posisi ini';
  const ref = a.reference === 'scan'
    ? `acuan: scan ${fmtShortDate(state.scans.find((s) => s.id === a.refId)?.date ?? scan.date)} + model`
    : a.reference === 'manual' ? 'dihaluskan dari posisi manual' : 'acuan: model rencana';
  return `${fmtPct(a.inlierRatio)} permukaan model cocok · selisih rata-rata ${(a.rmse * 1000).toFixed(1)} mm · ${ref}`;
}

/** Perbarui baris elemen tanpa merender ulang panel (agar input manual tidak kehilangan fokus). */
function refreshElementRows(scan) {
  const sum = summaryFor(scan);
  const cov = state.coverage.get(scan.id) ?? {};
  $('#scan-detail .detail-progress').innerHTML = `${fmtPct(sum.progress)}<small>${sum.done}/${sum.total} terpasang</small>`;
  $('#scan-detail .align-box .meta').textContent = alignText(scan);
  document.querySelectorAll('#d-elements .el-row').forEach((li) => {
    const k = li.dataset.key;
    const st = sum.statuses[k];
    const c = cov[k] ?? 0;
    const chip = li.querySelector('.chip');
    chip.className = `chip ${st}${scan.overrides?.[k] ? ' manual' : ''}`;
    chip.textContent = STATUS_LABEL[st];
    const bar = li.querySelector('.bar > i');
    bar.className = statusFromCoverage(c, state.settings);
    bar.style.width = `${Math.min(100, c * 100)}%`;
    li.querySelector('.el-cov').lastChild.textContent = fmtPct(c);
  });
}

function renderChart() {
  const rows = state.scans.map((s) => {
    const sum = summaryFor(s);
    return { id: s.id, date: s.date, label: s.label, progress: sum.progress, done: sum.done, total: sum.total };
  });
  renderProgressChart($('#chart'), rows, { selectedId: state.selectedScanId, onSelect: selectScan });
}

function renderMatrix() {
  const wrap = $('#matrix');
  if (!state.scans.length) {
    wrap.innerHTML = '<p class="empty">Tabel muncul setelah ada scan.</p>';
    return;
  }
  const sums = state.scans.map(summaryFor);
  const head = state.scans.map((s) =>
    `<th class="${s.id === state.selectedScanId ? 'sel' : ''}"><button type="button" data-scan="${s.id}">${fmtShortDate(s.date)}<br><span style="font-weight:500">${escapeHtml(s.label || '')}</span></button></th>`).join('');
  const body = state.elements.map((e) => `<tr><th scope="row">${escapeHtml(e.label)}</th>${state.scans.map((s, i) => {
    const st = sums[i].statuses[e.key];
    const c = state.coverage.get(s.id)?.[e.key] ?? 0;
    return `<td><span class="chip ${st}${s.overrides?.[e.key] ? ' manual' : ''}">${STATUS_LABEL[st]}</span><span class="pct">${fmtPct(c)}</span></td>`;
  }).join('')}</tr>`).join('');
  const foot = `<tr><th scope="row">Progress</th>${sums.map((x) => `<td>${fmtPct(x.progress)}</td>`).join('')}</tr>`;
  wrap.innerHTML = `<table class="matrix"><thead><tr><th>Elemen</th>${head}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
  wrap.querySelectorAll('[data-scan]').forEach((b) => b.addEventListener('click', () => selectScan(b.dataset.scan)));
}

// ---------- aksi ----------

function selectScan(id) {
  state.selectedScanId = id;
  renderTabs();
  renderViewer();
  renderDetail();
  renderChart();
  renderMatrix();
}

function selectElement(key) {
  state.selectedKey = state.selectedKey === key ? null : key;
  viewer.select(state.selectedKey);
  document.querySelectorAll('.el-row').forEach((r) => r.classList.toggle('selected', r.dataset.key === state.selectedKey));
  document.querySelector('.el-row.selected')?.scrollIntoView({ block: 'nearest' });
}

/**
 * Scan acuan untuk penyelarasan: scan terakhir sebelum (atau pada) tanggal yang sama,
 * kalau tidak ada pakai scan paling awal sesudahnya. Lantai, dinding, dan benda tetap
 * di scan acuan membuat arah scan baru tidak bisa tertukar.
 */
function referenceFor(date, excludeId = null) {
  const others = state.scans.filter((s) => s.id !== excludeId);
  const before = others.filter((s) => s.date <= date).at(-1);
  const ref = before ?? others.find((s) => s.date > date);
  if (!ref) return null;
  return { scan: ref, points: subsample(applyTransform(ref.points, ref.transform), 20000).points };
}

function alignInfo(res, ref) {
  return {
    inlierRatio: res.inlierRatio,
    rmse: res.rmse,
    reference: res.reference,
    refId: res.reference === 'scan' ? ref?.scan.id ?? null : null,
  };
}

async function ingestScan({ points, colors, date, label, note, photos = [], demo = false }) {
  const ref = referenceFor(date);
  const res = alignScan(points, state.target, ref?.points ?? null);
  const scan = {
    id: uid(),
    createdAt: Date.now(),
    date, label, note, demo,
    points, colors,
    transform: res?.transform ?? identityTransform(),
    align: res ? alignInfo(res, ref) : null,
    overrides: {},
    photos,
  };
  computeScanCoverage(scan);
  state.scans.push(scan);
  sortScans();
  await saveScan(scan);
  return scan;
}

async function realign(scan, fromCurrent) {
  await busy(fromCurrent ? 'Menyempurnakan posisi…' : 'Mencari posisi scan terhadap model…', async () => {
    let res;
    let ref = null;
    if (fromCurrent) {
      // Penghalusan lokal dari posisi sekarang, hanya titik elemen (lantai/dinding dibuang).
      const obj = subsample(objectPoints(scan.points, state.target), 15000).points;
      res = { ...icpYaw(obj, state.target, scan.transform, { radii: [0.1, 0.05, 0.03, 0.02], itersPerRadius: 8 }), reference: 'manual' };
    } else {
      ref = referenceFor(scan.date, scan.id);
      res = alignScan(scan.points, state.target, ref?.points ?? null);
    }
    if (!res) return;
    scan.transform = res.transform;
    scan.align = alignInfo(res, ref);
    computeScanCoverage(scan);
    await saveScan(scan);
  });
  renderAll();
  toast(`Kecocokan ${fmtPct(scan.align?.inlierRatio ?? 0)} permukaan model.`);
}

/** Putar point cloud sebesar `deg` derajat mengelilingi pusat model (sumbu vertikal). */
function rotateAboutModel(t, deg) {
  const d = (deg * Math.PI) / 180;
  const c = Math.cos(d), s = Math.sin(d);
  let cx = 0, cz = 0;
  const n = state.target.length / 3;
  for (let i = 0; i < state.target.length; i += 3) { cx += state.target[i]; cz += state.target[i + 2]; }
  cx /= n; cz /= n;
  const x = t.tx - cx, z = t.tz - cz;
  return { yaw: t.yaw + d, ty: t.ty, tx: c * x + s * z + cx, tz: -s * x + c * z + cz };
}

async function deleteScan(scan) {
  if (!confirm(`Hapus scan ${scan.label || ''} (${fmtDate(scan.date)}) beserta fotonya?`)) return;
  await store.deleteScan(scan.id);
  state.scans = state.scans.filter((s) => s.id !== scan.id);
  state.coverage.delete(scan.id);
  state.selectedScanId = state.scans.at(-1)?.id ?? null;
  viewer.cloudScanId = null;
  renderAll();
}

async function addPhotosToSelected(files) {
  const scan = selectedScan();
  if (!scan || !files.length) return;
  await busy('Menyimpan foto…', async () => {
    for (const f of files) {
      try {
        scan.photos = [...(scan.photos ?? []), { id: uid(), name: f.name, dataUrl: await photoToDataUrl(f), addedAt: Date.now() }];
      } catch (err) {
        toast(err.message, 5000);
      }
    }
    await saveScan(scan);
  });
  renderDetail();
  renderKpis();
}

function openPhoto(scan, photoId) {
  const p = scan.photos.find((x) => x.id === photoId);
  if (!p) return;
  const dlg = $('#dlg-photo');
  $('#photo-big').src = p.dataUrl;
  $('#photo-big').alt = p.name || 'Foto lapangan';
  $('#photo-caption').textContent = `${p.name || 'Foto'} · ${scan.label || ''} ${fmtDate(scan.date)}`;
  $('#photo-delete').onclick = async () => {
    if (!confirm('Hapus foto ini?')) return;
    scan.photos = scan.photos.filter((x) => x.id !== photoId);
    await saveScan(scan);
    dlg.close();
    renderDetail();
    renderKpis();
  };
  dlg.showModal();
}

async function loadDemo() {
  if (state.scans.some((s) => s.demo)) {
    if (!confirm('Data demo sudah ada. Buat ulang data demo?')) return;
    for (const s of state.scans.filter((x) => x.demo)) await store.deleteScan(s.id);
    state.scans = state.scans.filter((x) => !x.demo);
  }
  await busy('Membuat scan demo dan menyelaraskan ke model…', async () => {
    const demos = generateDemoScans(state.elements);
    for (const d of demos) {
      const scan = await ingestScan(d);
      // "Foto" demo: render tampilan scan dari viewer
      state.selectedScanId = scan.id;
      renderViewer();
      viewer.frame();
      viewer.setPlanVisible(false);
      viewer.setCloudVisible(true);
      await nextFrame();
      scan.photos = [{ id: uid(), name: 'render-demo.jpg', dataUrl: viewer.snapshot(800, 600), addedAt: Date.now() }];
      viewer.setPlanVisible($('#tg-plan').checked);
      viewer.setCloudVisible($('#tg-cloud').checked);
      await saveScan(scan);
      await nextFrame();
    }
  });
  state.selectedScanId = state.scans.at(-1)?.id ?? null;
  viewer.cloudScanId = null;
  renderAll();
  toast('Data demo dimuat: 3 scan, diselaraskan otomatis ke model.');
}

function exportCsv() {
  const sums = state.scans.map(summaryFor);
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Elemen', ...state.scans.flatMap((s) => [`${s.date} ${s.label || ''} status`, `${s.date} coverage %`])].map(q).join(',')];
  for (const e of state.elements) {
    lines.push([q(e.label), ...state.scans.flatMap((s, i) => [
      q(STATUS_TEXT[sums[i].statuses[e.key]]),
      Math.round((state.coverage.get(s.id)?.[e.key] ?? 0) * 100),
    ])].join(','));
  }
  lines.push([q('Progress keseluruhan %'), ...sums.flatMap((x) => [Math.round(x.progress * 100), ''])].join(','));
  download(`progress-${todayIso()}.csv`, `﻿${lines.join('\n')}`, 'text/csv');
}

async function exportProject() {
  const json = serializeProject({
    settings: { ...state.settings, projectName: state.projectName },
    scans: state.scans,
    planName: state.planName,
  });
  download(`proyek-progress-${todayIso()}.json`, json, 'application/json');
}

async function importProject(file) {
  const data = parseProject(await file.text());
  if (state.scans.length && !confirm('Impor akan menambah scan dari file ke proyek ini. Lanjut?')) return;
  await busy('Mengimpor proyek…', async () => {
    if (data.settings) {
      const { projectName, ...rest } = data.settings;
      state.settings = { ...state.settings, ...rest };
      if (projectName) state.projectName = projectName;
      await store.setMeta('settings', { ...state.settings, projectName: state.projectName });
      rebuildCoverageElements();
    }
    const existing = new Set(state.scans.map((s) => s.id));
    for (const s of data.scans) {
      if (existing.has(s.id)) continue;
      state.scans.push(s);
      await saveScan(s);
    }
    sortScans();
    recomputeAll();
  });
  if (data.planName && data.planName !== state.planName) {
    toast(`Proyek ini dibuat dengan model rencana "${data.planName}". Ganti model lewat Menu bila perlu.`, 6000);
  }
  state.selectedScanId = state.scans.at(-1)?.id ?? null;
  viewer.cloudScanId = null;
  applyProjectName();
  renderAll();
}

async function loadPlan(source, name) {
  $('#viewer-msg').hidden = false;
  $('#viewer-msg').textContent = 'Memuat model rencana…';
  state.elements = await viewer.loadPlan(source);
  state.planName = name;
  $('#plan-name').textContent = name;
  $('#viewer-msg').hidden = true;
  rebuildCoverageElements();
  recomputeAll();
  viewer.cloudScanId = null;
}

function applyProjectName() {
  $('#project-name').textContent = state.projectName;
  document.title = state.projectName === 'Progress Tracker' ? 'Progress Tracker' : `${state.projectName} · Progress`;
}

// ---------- event binding ----------

function bindUi() {
  const dlgAdd = $('#dlg-add');
  const fileInput = $('#add-file');
  fileInput.accept = ACCEPT;

  $('#btn-add').addEventListener('click', () => {
    $('#form-add').reset();
    $('#add-date').value = todayIso();
    $('#add-error').hidden = true;
    state.pendingPhotos = [];
    $('#add-photo-count').textContent = '0 foto';
    dlgAdd.showModal();
  });
  const addPending = (files) => {
    state.pendingPhotos.push(...files);
    $('#add-photo-count').textContent = `${state.pendingPhotos.length} foto`;
  };
  $('#add-camera').addEventListener('change', (e) => { addPending([...e.target.files]); e.target.value = ''; });
  $('#add-photos').addEventListener('change', (e) => { addPending([...e.target.files]); e.target.value = ''; });

  $('#form-add').addEventListener('submit', async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    ev.preventDefault();
    const file = fileInput.files[0];
    if (!file) return;
    const err = $('#add-error');
    err.hidden = true;
    try {
      const scan = await busy('Membaca scan, menyelaraskan ke model, menghitung progress…', async () => {
        const cloud = await loadScanFile(file, {
          zUp: $('#add-zup').checked,
          unitScale: parseFloat($('#add-unit').value),
        });
        const photos = [];
        for (const f of state.pendingPhotos) {
          try {
            photos.push({ id: uid(), name: f.name, dataUrl: await photoToDataUrl(f), addedAt: Date.now() });
          } catch (e) {
            toast(e.message, 5000);
          }
        }
        return ingestScan({
          ...cloud,
          date: $('#add-date').value || todayIso(),
          label: $('#add-label').value.trim(),
          note: $('#add-note').value.trim(),
          photos,
        });
      });
      dlgAdd.close();
      state.selectedScanId = scan.id;
      renderAll();
      const weak = (scan.align?.inlierRatio ?? 0) < 0.15;
      toast(weak
        ? 'Scan diproses, tapi kecocokan dengan model rendah. Cek posisi di panel Penyelarasan.'
        : `Scan diproses: ${(scan.points.length / 3).toLocaleString('id-ID')} titik, progress ${fmtPct(summaryFor(scan).progress)}.`, 5000);
    } catch (e) {
      console.error(e);
      err.textContent = e.message || String(e);
      err.hidden = false;
    }
  });

  $('#file-camera').addEventListener('change', (e) => { addPhotosToSelected([...e.target.files]); e.target.value = ''; });
  $('#file-photos').addEventListener('change', (e) => { addPhotosToSelected([...e.target.files]); e.target.value = ''; });

  // Viewer tools
  $('#tg-cloud').addEventListener('change', (e) => viewer.setCloudVisible(e.target.checked));
  $('#tg-plan').addEventListener('change', (e) => viewer.setPlanVisible(e.target.checked));
  $('#sel-color').addEventListener('change', (e) => viewer.setColorMode(e.target.value));
  $('#btn-frame').addEventListener('click', () => viewer.frame());
  viewer.onPick = (key) => { if (key) selectElement(key); };

  // Menu
  const menu = document.querySelector('.menu');
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.open = false; });
  menu.querySelectorAll('[data-action]').forEach((b) => b.addEventListener('click', async () => {
    menu.open = false;
    const a = b.dataset.action;
    try {
      if (a === 'demo') await loadDemo();
      else if (a === 'settings') openSettings();
      else if (a === 'plan') $('#file-plan').click();
      else if (a === 'plan-reset') {
        await store.deleteMeta('plan');
        await busy('Memuat model bawaan…', () => loadPlan(DEFAULT_PLAN_URL, DEFAULT_PLAN_NAME));
        renderAll();
      } else if (a === 'export') await exportProject();
      else if (a === 'import') $('#file-import').click();
      else if (a === 'csv') exportCsv();
      else if (a === 'print') window.print();
      else if (a === 'clear') {
        if (!confirm('Hapus SEMUA scan dan foto di perangkat ini? Ekspor proyek dulu bila perlu backup.')) return;
        await store.clearScans();
        state.scans = [];
        state.coverage.clear();
        state.selectedScanId = null;
        viewer.cloudScanId = null;
        renderAll();
      }
    } catch (e) {
      console.error(e);
      toast(e.message || String(e), 5000);
    }
  }));

  $('#file-plan').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const buf = f.name.toLowerCase().endsWith('.gltf') ? await f.text() : await f.arrayBuffer();
      await busy('Memuat model rencana baru…', () => loadPlan(buf, f.name));
      await store.setMeta('plan', { name: f.name, data: buf });
      renderAll();
      toast(`Model rencana: ${f.name} (${state.elements.length} elemen).`);
    } catch (err) {
      console.error(err);
      toast(`Gagal memuat model: ${err.message}`, 5000);
    }
  });
  $('#file-import').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      await importProject(f);
    } catch (err) {
      console.error(err);
      toast(`Gagal impor: ${err.message}`, 5000);
    }
  });

  // Settings
  $('#form-settings').addEventListener('submit', async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    const tol = parseFloat($('#set-tol').value) / 100;
    const done = parseFloat($('#set-done').value) / 100;
    const partial = parseFloat($('#set-partial').value) / 100;
    const name = $('#set-name').value.trim() || 'Progress Tracker';
    if (![tol, done, partial].every(Number.isFinite) || partial > done) {
      ev.preventDefault();
      toast('Periksa angka: batas "sebagian" harus ≤ batas "terpasang".');
      return;
    }
    const tolChanged = tol !== state.settings.tolerance;
    state.settings = { tolerance: tol, doneThreshold: done, partialThreshold: partial };
    state.projectName = name;
    await store.setMeta('settings', { ...state.settings, projectName: name });
    applyProjectName();
    if (tolChanged) {
      await busy('Menghitung ulang coverage…', async () => { rebuildCoverageElements(); recomputeAll(); });
    }
    renderAll();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => viewer.setTheme(e.matches));
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderChart, 120); });
}

function openSettings() {
  $('#set-name').value = state.projectName;
  $('#set-tol').value = +(state.settings.tolerance * 100).toFixed(1);
  $('#set-done').value = Math.round(state.settings.doneThreshold * 100);
  $('#set-partial').value = Math.round(state.settings.partialThreshold * 100);
  $('#dlg-settings').showModal();
}

// ---------- start ----------

async function init() {
  viewer = new Viewer($('#viewer'));
  bindUi();

  if (!(await store.available())) {
    toast('Penyimpanan browser tidak tersedia (mode privat?). Data hilang saat halaman ditutup.', 6000);
  }
  try {
    const saved = await store.getMeta('settings');
    if (saved) {
      const { projectName, ...rest } = saved;
      state.settings = { ...DEFAULT_SETTINGS, ...rest };
      if (projectName) state.projectName = projectName;
    }
  } catch { /* abaikan */ }
  applyProjectName();

  try {
    let plan = null;
    try { plan = await store.getMeta('plan'); } catch { /* abaikan */ }
    try {
      if (plan) await loadPlan(plan.data, plan.name);
      else await loadPlan(DEFAULT_PLAN_URL, DEFAULT_PLAN_NAME);
    } catch (err) {
      if (!plan) throw err;
      console.warn('Model rencana tersimpan gagal dimuat, pakai bawaan', err);
      await loadPlan(DEFAULT_PLAN_URL, DEFAULT_PLAN_NAME);
    }
  } catch (err) {
    console.error(err);
    $('#viewer-msg').textContent = `Model rencana gagal dimuat: ${err.message}. Pilih file GLB lewat Menu → Ganti model rencana.`;
  }

  try {
    state.scans = (await store.listScans()) ?? [];
  } catch {
    state.scans = [];
  }
  sortScans();
  recomputeAll();
  state.selectedScanId = state.scans.at(-1)?.id ?? null;
  renderAll();
}

init();

// Akses untuk debugging dari console browser (mis. progressTracker.state.scans).
window.progressTracker = { state };
