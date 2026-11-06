import { Viewer } from './viewer.js';
import { loadScanFile, loadPlanFile, ACCEPT, PLAN_ACCEPT } from './loaders.js';
import { store, serializeProject, parseProject } from './store.js';
import { renderProgressChart, escapeHtml } from './chart.js';
import { generateDemoScans, demoSchedule, demoElementConfig } from './demo.js';
import { buildDemoPlan, DEMO_PLAN_NAME } from './demo-plan.js';
import {
  DEFAULT_SETTINGS, STATUS, alignScan, applyTransform, bounds, computeCoverage, cropToBounds, exclusiveSamples,
  icpYaw, identityTransform, objectPoints, plannedAt, resolveTimeline, sCurve, statusFromCoverage, subsample,
  voxelCap, weightedProgress,
} from './analysis.js';

const $ = (sel) => document.querySelector(sel);

const STATUS_LABEL = { done: '✓ Selesai', partial: '◐ Dikerjakan', none: '○ Belum' };
const STATUS_TEXT = { done: 'Selesai', partial: 'Dikerjakan', none: 'Belum' };
const SOURCE_TEXT = { manual: 'manual', carried: 'terbawa' };

const state = {
  settings: { ...DEFAULT_SETTINGS },
  projectName: 'Fit-out Restoran',
  planName: DEMO_PLAN_NAME,
  planSig: '',
  planBox: null,
  elements: [], // semua elemen model (termasuk eksisting)
  elementConfig: {}, // key -> {weight, existing, manual}
  schedule: [], // [{date, target}]
  coverageElements: [],
  target: null,
  scans: [],
  coverage: new Map(), // scanId -> {key: frac}
  timeline: new Map(), // scanId -> {statuses, sources}
  selectedScanId: null,
  selectedKey: null,
  pendingPhotos: [],
  openCats: new Set(),
};

let viewer;

// ---------- utilitas ----------

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
const fmtPoints = (d) => {
  const v = Math.round(d * 100);
  return `${v >= 0 ? '▲ +' : '▼ −'}${Math.abs(v)} poin`;
};

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
async function busyStep(msg) {
  $('#busy-msg').textContent = msg;
  await nextFrame();
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
    throw new Error(`Foto "${file.name}" tidak bisa dibaca browser ini (HEIC? pilih lewat Safari atau ubah ke JPEG).`);
  }
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s);
  c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.82);
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

// ---------- elemen, coverage, status ----------

/** Terapkan konfigurasi pengguna (bobot, eksisting, manual) ke objek elemen. */
function applyElementConfig() {
  for (const e of state.elements) {
    const c = state.elementConfig[e.key] ?? {};
    e.autoExisting ??= e.existing;
    e.autoManual ??= e.manual;
    e.existing = c.existing ?? e.autoExisting;
    e.manual = c.manual ?? e.autoManual;
    e.weight = c.weight ?? 1;
  }
}

const tracked = () => state.elements.filter((e) => !e.existing);
const categories = () => [...new Set(tracked().map((e) => e.category))];

function rebuildPlanData() {
  // Pekerjaan yang dinilai dari foto (kaca, cat, keramik) tidak terlihat bentuknya oleh LiDAR,
  // jadi tidak ikut memotong sampel di sambungan dengan pekerjaan lain.
  state.coverageElements = exclusiveSamples(state.elements.filter((e) => !e.manual), state.settings.tolerance * 1.5);
  const total = state.elements.reduce((s, e) => s + e.samples.length, 0);
  state.target = new Float32Array(total);
  let o = 0;
  for (const e of state.elements) { state.target.set(e.samples, o); o += e.samples.length; }
  state.planBox = bounds(state.target);
  state.planSig = hashString(state.planName + state.elements.map((e) => `${e.key}:${e.samples.length}:${e.manual ? 'm' : ''}`).join('|'));
}

function coverageSig(scan) {
  const t = scan.transform;
  return `${state.planSig}|${state.settings.tolerance}|${t.yaw.toFixed(6)},${t.tx.toFixed(5)},${t.ty.toFixed(5)},${t.tz.toFixed(5)}`;
}

/** Coverage per elemen; disimpan di scan supaya tidak dihitung ulang setiap halaman dibuka. */
function computeScanCoverage(scan, { force = false } = {}) {
  const sig = coverageSig(scan);
  if (!force && scan.covCache?.sig === sig) {
    state.coverage.set(scan.id, scan.covCache.values);
    return false;
  }
  const moved = applyTransform(scan.points, scan.transform);
  const values = computeCoverage(moved, state.coverageElements, state.settings.tolerance);
  scan.covCache = { sig, values };
  state.coverage.set(scan.id, values);
  return true;
}

async function recomputeAll() {
  for (const s of state.scans) if (computeScanCoverage(s)) await saveScan(s);
  refreshTimeline();
}

function refreshTimeline() {
  state.timeline = resolveTimeline(state.scans, state.coverage, tracked(), state.settings);
}

function summaryFor(scan) {
  const t = state.timeline.get(scan.id) ?? { statuses: {}, sources: {} };
  const els = tracked();
  const byCat = {};
  for (const c of categories()) byCat[c] = weightedProgress(t.statuses, els.filter((e) => e.category === c));
  return {
    statuses: t.statuses,
    sources: t.sources,
    progress: weightedProgress(t.statuses, els),
    planned: plannedAt(state.schedule, scan.date),
    byCat,
    done: els.filter((e) => t.statuses[e.key] === STATUS.DONE).length,
    partial: els.filter((e) => t.statuses[e.key] === STATUS.PARTIAL).length,
    total: els.length,
  };
}

function sortScans() {
  state.scans.sort((a, b) => a.date.localeCompare(b.date) || (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

const selectedScan = () => state.scans.find((s) => s.id === state.selectedScanId) ?? null;
const elementByKey = (k) => state.elements.find((e) => e.key === k);

async function saveScan(scan) {
  try {
    await store.putScan(scan);
  } catch (err) {
    console.error(err);
    toast('Gagal menyimpan ke penyimpanan browser (penuh?). Ekspor proyek untuk backup.', 5000);
  }
}

async function saveMeta() {
  await store.setMeta('settings', { ...state.settings, projectName: state.projectName });
  await store.setMeta('elementConfig', state.elementConfig);
  await store.setMeta('schedule', state.schedule);
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
  const total = tracked().length;
  if (!scans.length) {
    $('#kpi-progress').textContent = '–';
    $('#kpi-delta').textContent = 'belum ada scan';
    $('#kpi-dev').textContent = '–';
    $('#kpi-dev').className = 'kpi-value';
    $('#kpi-plan').textContent = state.schedule.length ? `rencana hari ini ${fmtPct(plannedAt(state.schedule, todayIso()))}` : 'atur jadwal di Menu';
    $('#kpi-done').textContent = `0/${total}`;
    $('#kpi-partial').textContent = 'pekerjaan';
    $('#kpi-last').textContent = '–';
    $('#kpi-count').textContent = `0 scan · ${photos} foto`;
    return;
  }
  const last = scans.at(-1);
  const sum = summaryFor(last);
  $('#kpi-progress').textContent = fmtPct(sum.progress);
  if (scans.length > 1) {
    const d = Math.round((sum.progress - summaryFor(scans.at(-2)).progress) * 100);
    $('#kpi-delta').textContent = `${d >= 0 ? '+' : '−'}${Math.abs(d)} poin dari scan sebelumnya`;
  } else {
    $('#kpi-delta').textContent = 'scan pertama';
  }
  if (sum.planned != null) {
    const dev = sum.progress - sum.planned;
    const ok = dev >= -0.005;
    $('#kpi-dev').textContent = fmtPoints(dev);
    $('#kpi-dev').className = `kpi-value ${ok ? 'ahead' : 'behind'}`;
    $('#kpi-plan').textContent = `${ok ? 'sesuai / lebih cepat' : 'terlambat'} · rencana ${fmtPct(sum.planned)}`;
  } else {
    $('#kpi-dev').textContent = '–';
    $('#kpi-dev').className = 'kpi-value';
    $('#kpi-plan').textContent = 'atur jadwal di Menu';
  }
  $('#kpi-done').textContent = `${sum.done}/${sum.total}`;
  $('#kpi-partial').textContent = `${sum.partial} sedang dikerjakan`;
  $('#kpi-last').textContent = fmtDate(last.date);
  $('#kpi-count').textContent = `${scans.length} scan · ${photos} foto`;
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
    viewer.cloudScanId = null;
    viewer.setStatuses({});
    viewer.select(state.selectedKey);
    return;
  }
  viewer.setStatuses(summaryFor(scan).statuses);
  if (viewer.cloudScanId !== scan.id) {
    viewer.setCloud(scan.points, scan.colors, scan.transform);
    viewer.cloudScanId = scan.id;
  } else {
    viewer.setCloudTransform(scan.transform);
  }
  viewer.select(state.selectedKey);
}

function alignText(scan) {
  const a = scan.align;
  if (!a) return 'Diatur manual · tekan Sempurnakan untuk menghaluskan dari posisi ini';
  const ref = a.reference === 'scan'
    ? `acuan: scan ${fmtShortDate(state.scans.find((s) => s.id === a.refId)?.date ?? scan.date)} + model`
    : a.reference === 'manual' ? 'dihaluskan dari posisi manual' : 'acuan: model rencana';
  return `${fmtPct(a.inlierRatio)} permukaan model cocok · selisih rata-rata ${(a.rmse * 1000).toFixed(1)} mm · ${ref}`;
}

function elementRowHtml(e, scan, sum, cov) {
  const st = sum.statuses[e.key];
  const src = sum.sources[e.key];
  const c = cov[e.key] ?? 0;
  const auto = statusFromCoverage(c, state.settings);
  const override = scan.overrides?.[e.key];
  const nPhotos = (scan.photos ?? []).filter((p) => p.elementKey === e.key).length;
  const srcText = override ? 'manual' : src === 'carried' ? 'terbawa' : '';
  const measure = e.manual
    ? '<span class="el-cov"><span class="tag">dinilai dari foto</span></span>'
    : `<span class="el-cov"><span class="bar" title="Permukaan tertutup titik scan"><i class="${auto}" style="width:${Math.min(100, c * 100)}%"></i><b style="left:${state.settings.doneThreshold * 100}%"></b></span><span class="cov-num">${fmtPct(c)}</span></span>`;
  return `<li class="el-row${e.key === state.selectedKey ? ' selected' : ''}" data-key="${escapeHtml(e.key)}">
    <span class="el-name">${escapeHtml(e.label)} <span class="chip ${st}">${STATUS_LABEL[st]}</span>${srcText ? `<span class="src">${srcText}</span>` : ''}${nPhotos ? `<span class="src">📷 ${nPhotos}</span>` : ''}</span>
    ${measure}
    <select aria-label="Status ${escapeHtml(e.label)}">
      <option value="">${e.manual ? 'Dari scan lalu' : 'Otomatis'}</option>
      <option value="done">Selesai</option>
      <option value="partial">Dikerjakan</option>
      <option value="none">Belum</option>
    </select>
  </li>`;
}

function renderDetail() {
  const box = $('#scan-detail');
  const scan = selectedScan();
  if (!scan) {
    box.innerHTML = `<p class="empty">Belum ada scan. Tekan <strong>+ Tambah scan</strong> untuk mengunggah scan LiDAR unit,
      atau buka <strong>Menu → Muat data demo</strong> untuk mencoba.</p>
      <div><p class="section-title">Pekerjaan di model rencana (${tracked().length})</p>
      <ul class="el-list">${tracked().map((e) => `<li class="el-row${e.key === state.selectedKey ? ' selected' : ''}" data-key="${escapeHtml(e.key)}">
        <span class="el-name">${escapeHtml(e.label)}</span><span class="el-cov">${escapeHtml(e.category)} · ${e.area.toFixed(1)} m²${e.manual ? ' · dinilai dari foto' : ''}</span></li>`).join('')}</ul></div>`;
    box.querySelectorAll('.el-row').forEach((row) => row.addEventListener('click', () => selectElement(row.dataset.key)));
    return;
  }
  const sum = summaryFor(scan);
  const cov = state.coverage.get(scan.id) ?? {};
  const t = scan.transform;
  const weak = (scan.align?.inlierRatio ?? 1) < 0.15;
  const sel = elementByKey(state.selectedKey);
  const dev = sum.planned != null
    ? `<small class="${sum.progress - sum.planned >= -0.005 ? 'ahead' : 'behind'}">${fmtPoints(sum.progress - sum.planned)} vs rencana</small>`
    : '';
  const cats = categories();
  if (!state.openCats.size) cats.forEach((c) => state.openCats.add(c));
  box.innerHTML = `
    <div class="detail-head">
      <div>
        <h2>${escapeHtml(scan.label || 'Scan')}</h2>
        <div class="date">${fmtDate(scan.date)}${scan.demo ? ' · demo' : ''}</div>
      </div>
      <div class="detail-progress"><span id="d-pct">${fmtPct(sum.progress)}</span><small>${sum.done}/${sum.total} selesai</small>${dev}</div>
    </div>
    <textarea class="note-input" id="d-note" rows="2" maxlength="800" placeholder="Catatan lapangan, kendala, koordinasi dengan mall…" aria-label="Catatan scan">${escapeHtml(scan.note || '')}</textarea>
    <div id="d-elements">${cats.map((c) => `
      <details class="cat" data-cat="${escapeHtml(c)}" ${state.openCats.has(c) ? 'open' : ''}>
        <summary><span>${escapeHtml(c)}</span><span class="cat-pct">${fmtPct(sum.byCat[c])}</span></summary>
        <ul class="el-list">${tracked().filter((e) => e.category === c).map((e) => elementRowHtml(e, scan, sum, cov)).join('')}</ul>
      </details>`).join('')}
    </div>
    <div>
      <p class="section-title">Foto lapangan (${scan.photos?.length ?? 0})</p>
      <div class="photos" id="d-photos">${(scan.photos ?? []).map((p) => {
        const tag = p.elementKey ? elementByKey(p.elementKey)?.label : '';
        return `<button type="button" data-photo="${p.id}" title="${escapeHtml(tag || p.name || '')}"><img src="${p.dataUrl}" alt="${escapeHtml(tag || 'Foto lapangan')}" loading="lazy" />${tag ? `<span>${escapeHtml(tag)}</span>` : ''}</button>`;
      }).join('')}</div>
      <div class="photo-actions">
        <button class="btn small" type="button" id="d-camera">📷 Kamera</button>
        <button class="btn small" type="button" id="d-pick">Pilih foto</button>
      </div>
      <p class="hint" id="d-photo-hint">${sel ? `Foto baru ditandai ke <strong>${escapeHtml(sel.label)}</strong>. Klik elemen itu lagi untuk melepas.` : 'Pilih pekerjaan dulu (di daftar atau model 3D) supaya foto ditandai ke pekerjaan itu.'}</p>
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

  box.querySelectorAll('details.cat').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) state.openCats.add(d.dataset.cat); else state.openCats.delete(d.dataset.cat);
  }));
  box.querySelectorAll('.el-row').forEach((li) => {
    const key = li.dataset.key;
    const sel2 = li.querySelector('select');
    sel2.value = scan.overrides?.[key] ?? '';
    sel2.addEventListener('click', (ev) => ev.stopPropagation());
    sel2.addEventListener('change', async () => {
      scan.overrides = { ...(scan.overrides ?? {}) };
      if (sel2.value) scan.overrides[key] = sel2.value;
      else delete scan.overrides[key];
      await saveScan(scan);
      refreshTimeline();
      renderAll();
    });
    li.addEventListener('click', () => selectElement(key));
  });

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
  manual.querySelectorAll('[data-rot]').forEach((b) => b.addEventListener('click', async () => {
    scan.transform = rotateAboutModel(scan.transform, Number(b.dataset.rot));
    scan.align = null;
    computeScanCoverage(scan);
    refreshTimeline();
    await saveScan(scan);
    renderAll();
  }));
  let timer;
  manual.querySelectorAll('input[data-t]').forEach((inp) => inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (!Number.isFinite(v)) return;
    scan.transform = { ...scan.transform, [inp.dataset.t]: inp.dataset.t === 'yaw' ? (v * Math.PI) / 180 : v };
    scan.align = null;
    viewer.setCloudTransform(scan.transform);
    clearTimeout(timer);
    timer = setTimeout(async () => {
      computeScanCoverage(scan);
      refreshTimeline();
      await saveScan(scan);
      renderKpis(); renderTabs(); renderViewer(); renderChart(); renderMatrix();
      refreshElementRows(scan);
    }, 300);
  }));
}

/** Perbarui baris elemen tanpa merender ulang panel (agar input manual tidak kehilangan fokus). */
function refreshElementRows(scan) {
  const sum = summaryFor(scan);
  const cov = state.coverage.get(scan.id) ?? {};
  $('#d-pct').textContent = fmtPct(sum.progress);
  $('#scan-detail .align-box .meta').textContent = alignText(scan);
  document.querySelectorAll('#d-elements details.cat').forEach((d) => {
    d.querySelector('.cat-pct').textContent = fmtPct(sum.byCat[d.dataset.cat] ?? 0);
  });
  document.querySelectorAll('#d-elements .el-row').forEach((li) => {
    const k = li.dataset.key;
    const st = sum.statuses[k];
    const chip = li.querySelector('.chip');
    chip.className = `chip ${st}`;
    chip.textContent = STATUS_LABEL[st];
    const bar = li.querySelector('.bar > i');
    if (!bar) return;
    const c = cov[k] ?? 0;
    bar.className = statusFromCoverage(c, state.settings);
    bar.style.width = `${Math.min(100, c * 100)}%`;
    li.querySelector('.cov-num').textContent = fmtPct(c);
  });
}

function renderChart() {
  const rows = state.scans.map((s) => {
    const sum = summaryFor(s);
    return { id: s.id, date: s.date, label: s.label, progress: sum.progress, planned: sum.planned, done: sum.done, total: sum.total };
  });
  renderProgressChart($('#chart'), rows, {
    plan: state.schedule, selectedId: state.selectedScanId, onSelect: selectScan, today: todayIso(),
  });
}

function renderMatrix() {
  const wrap = $('#matrix');
  if (!state.scans.length) {
    wrap.innerHTML = '<p class="empty">Tabel muncul setelah ada scan.</p>';
    return;
  }
  const sums = state.scans.map(summaryFor);
  const totalW = tracked().reduce((s, e) => s + e.weight, 0) || 1;
  const head = state.scans.map((s) =>
    `<th class="${s.id === state.selectedScanId ? 'sel' : ''}"><button type="button" data-scan="${s.id}">${fmtShortDate(s.date)}<br><span style="font-weight:500">${escapeHtml(s.label || '')}</span></button></th>`).join('');
  const body = categories().map((c) => {
    const els = tracked().filter((e) => e.category === c);
    const catW = els.reduce((s, e) => s + e.weight, 0);
    const catRow = `<tr class="cat-row"><th scope="row">${escapeHtml(c)}</th><td>${fmtPct(catW / totalW)}</td>${sums.map((x) => `<td>${fmtPct(x.byCat[c])}</td>`).join('')}</tr>`;
    return catRow + els.map((e) => `<tr><th scope="row" class="el-th">${escapeHtml(e.label)}</th><td class="w">${fmtPct(e.weight / totalW)}</td>${state.scans.map((s, i) => {
      const st = sums[i].statuses[e.key];
      const c2 = state.coverage.get(s.id)?.[e.key] ?? 0;
      const note = s.overrides?.[e.key] ? 'manual' : e.manual ? '' : fmtPct(c2);
      return `<td><span class="chip ${st}">${STATUS_LABEL[st]}</span><span class="pct">${note}</span></td>`;
    }).join('')}</tr>`).join('');
  }).join('');
  const planRow = state.schedule.length
    ? `<tr><th scope="row">Rencana</th><td></td>${sums.map((x) => `<td>${fmtPct(x.planned)}</td>`).join('')}</tr>`
    : '';
  const foot = `<tr><th scope="row">Progress aktual</th><td>100%</td>${sums.map((x) => `<td>${fmtPct(x.progress)}</td>`).join('')}</tr>${planRow}`;
  wrap.innerHTML = `<table class="matrix"><thead><tr><th>Pekerjaan</th><th>Bobot</th>${head}</tr></thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
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
  const el = elementByKey(key);
  if (el?.existing) return; // shell mall tidak dipilih
  state.selectedKey = state.selectedKey === key ? null : key;
  viewer.select(state.selectedKey);
  if (state.selectedKey && el) state.openCats.add(el.category);
  renderDetail();
  document.querySelector('.el-row.selected')?.scrollIntoView({ block: 'nearest' });
}

/**
 * Scan acuan untuk penyelarasan: scan terakhir sebelum (atau pada) tanggal yang sama,
 * kalau tidak ada pakai scan paling awal sesudahnya. Shell mall dan benda tetap di scan
 * acuan membuat arah scan baru tidak bisa tertukar.
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

async function ingestScan({ points, colors, date, label, note, photos = [], demo = false, overrides = {} }) {
  const ref = referenceFor(date);
  const res = alignScan(points, state.target, ref?.points ?? null);
  const transform = res?.transform ?? identityTransform();
  // Buang koridor mall / unit tetangga: simpan hanya area model + 1 m.
  if (res) ({ points, colors } = cropToBounds(points, colors, transform, state.planBox, 1));
  const scan = {
    id: uid(),
    createdAt: Date.now(),
    date, label, note, demo,
    points, colors,
    transform,
    align: res ? alignInfo(res, ref) : null,
    overrides,
    photos,
  };
  computeScanCoverage(scan);
  state.scans.push(scan);
  sortScans();
  refreshTimeline();
  await saveScan(scan);
  return scan;
}

async function realign(scan, fromCurrent) {
  await busy(fromCurrent ? 'Menyempurnakan posisi…' : 'Mencari posisi scan terhadap model…', async () => {
    let res;
    let ref = null;
    if (fromCurrent) {
      const obj = voxelCap(objectPoints(scan.points, state.target), 400000, 0.02).points;
      const tgt = subsample(state.target, 20000).points;
      res = { ...icpYaw(obj, tgt, scan.transform, { radii: [0.1, 0.06, 0.04, 0.03], itersPerRadius: 8 }), reference: 'manual' };
    } else {
      ref = referenceFor(scan.date, scan.id);
      res = alignScan(scan.points, state.target, ref?.points ?? null);
    }
    if (!res) return;
    scan.transform = res.transform;
    scan.align = alignInfo(res, ref);
    computeScanCoverage(scan);
    refreshTimeline();
    await saveScan(scan);
  });
  renderAll();
  toast(`Kecocokan ${fmtPct(scan.align?.inlierRatio ?? 0)} permukaan model.`);
}

/** Putar point cloud sebesar `deg` derajat mengelilingi pusat model (sumbu vertikal). */
function rotateAboutModel(t, deg) {
  const d = (deg * Math.PI) / 180;
  const c = Math.cos(d), s = Math.sin(d);
  const cx = (state.planBox.min[0] + state.planBox.max[0]) / 2;
  const cz = (state.planBox.min[2] + state.planBox.max[2]) / 2;
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
  refreshTimeline();
  renderAll();
}

async function addPhotosToSelected(files) {
  const scan = selectedScan();
  if (!scan || !files.length) return;
  const el = elementByKey(state.selectedKey);
  const elementKey = el && !el.existing ? el.key : null;
  await busy('Menyimpan foto…', async () => {
    for (const f of files) {
      try {
        scan.photos = [...(scan.photos ?? []), { id: uid(), name: f.name, dataUrl: await photoToDataUrl(f), addedAt: Date.now(), elementKey }];
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
  const tag = p.elementKey ? elementByKey(p.elementKey)?.label : null;
  $('#photo-big').src = p.dataUrl;
  $('#photo-big').alt = tag || p.name || 'Foto lapangan';
  $('#photo-caption').textContent = `${tag ? `${tag} · ` : ''}${scan.label || ''} ${fmtDate(scan.date)}`;
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
  if (state.planName !== DEMO_PLAN_NAME &&
    !confirm('Data demo memakai model contoh restoran 16 × 12 m. Ganti model rencana ke contoh itu? (Scan yang ada tetap disimpan.)')) return;
  if (state.scans.some((s) => s.demo) && !confirm('Data demo sudah ada. Buat ulang data demo?')) return;
  await busy('Menyiapkan data demo…', async () => {
    if (state.planName !== DEMO_PLAN_NAME) {
      await store.deleteMeta('plan');
      await loadPlan(buildDemoPlan(), DEMO_PLAN_NAME);
    }
    for (const s of state.scans.filter((x) => x.demo)) await store.deleteScan(s.id);
    state.scans = state.scans.filter((x) => !x.demo);
    state.elementConfig = { ...state.elementConfig, ...demoElementConfig(state.elements) };
    state.schedule = demoSchedule();
    if (state.projectName === 'Fit-out Restoran' || !state.projectName) state.projectName = 'Fit-out Restoran (demo)';
    applyElementConfig();
    rebuildPlanData();
    await saveMeta();
    applyProjectName();
    await busyStep('Membuat 5 scan demo…');
    const demos = generateDemoScans(state.elements);
    for (const [i, d] of demos.entries()) {
      await busyStep(`Scan demo ${i + 1}/${demos.length}: menyelaraskan ke ${i ? 'scan sebelumnya + ' : ''}model, menghitung progress…`);
      const scan = await ingestScan(d);
      // "Foto" demo: render point cloud scan (pengganti foto kamera).
      state.selectedScanId = scan.id;
      renderViewer();
      viewer.frame();
      viewer.setPlanVisible(false);
      viewer.setCloudVisible(true);
      await nextFrame();
      scan.photos = [{ id: uid(), name: 'render-demo.jpg', dataUrl: viewer.snapshot(800, 600), addedAt: Date.now(), elementKey: null }];
      viewer.setPlanVisible($('#tg-plan').checked);
      viewer.setCloudVisible($('#tg-cloud').checked);
      await saveScan(scan);
    }
  });
  state.selectedScanId = state.scans.at(-1)?.id ?? null;
  viewer.cloudScanId = null;
  renderAll();
  toast('Data demo dimuat: 5 scan mingguan, diselaraskan otomatis.', 4000);
}

function exportCsv() {
  const sums = state.scans.map(summaryFor);
  const totalW = tracked().reduce((s, e) => s + e.weight, 0) || 1;
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [[
    'Kategori', 'Pekerjaan', 'Bobot %', 'Penilaian',
    ...state.scans.flatMap((s) => [`${s.date} ${s.label || ''} status`, `${s.date} coverage %`]),
  ].map(q).join(',')];
  for (const e of tracked()) {
    lines.push([
      q(e.category), q(e.label), (100 * e.weight / totalW).toFixed(1), q(e.manual ? 'foto/manual' : 'LiDAR'),
      ...state.scans.flatMap((s, i) => [
        q(STATUS_TEXT[sums[i].statuses[e.key]]),
        e.manual ? '' : Math.round((state.coverage.get(s.id)?.[e.key] ?? 0) * 100),
      ]),
    ].join(','));
  }
  lines.push([q(''), q('Progress aktual %'), '100', '', ...sums.flatMap((x) => [Math.round(x.progress * 100), ''])].join(','));
  if (state.schedule.length) {
    lines.push([q(''), q('Rencana %'), '', '', ...sums.flatMap((x) => [Math.round(x.planned * 100), ''])].join(','));
  }
  download(`progress-${todayIso()}.csv`, `﻿${lines.join('\n')}`, 'text/csv');
}

async function exportProject() {
  const json = serializeProject({
    settings: { ...state.settings, projectName: state.projectName },
    scans: state.scans,
    planName: state.planName,
    elementConfig: state.elementConfig,
    schedule: state.schedule,
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
    }
    if (data.elementConfig) state.elementConfig = { ...state.elementConfig, ...data.elementConfig };
    if (data.schedule?.length) state.schedule = data.schedule;
    applyElementConfig();
    rebuildPlanData();
    await saveMeta();
    const existing = new Set(state.scans.map((s) => s.id));
    for (const s of data.scans) if (!existing.has(s.id)) state.scans.push(s);
    sortScans();
    await recomputeAll();
    for (const s of state.scans) await saveScan(s);
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
  state.selectedKey = null;
  $('#plan-name').textContent = name;
  $('#viewer-msg').hidden = true;
  applyElementConfig();
  rebuildPlanData();
  // Ruangan: potong di bawah plafon supaya interior terlihat dari atas.
  const height = state.planBox.max[1] - state.planBox.min[1];
  $('#sel-clip').value = height > 3 ? '2.6' : '';
  viewer.setClipHeight($('#sel-clip').value ? Number($('#sel-clip').value) : null);
  viewer.cloudScanId = null;
}

function applyProjectName() {
  $('#project-name').textContent = state.projectName;
  document.title = `${state.projectName} · Progress`;
}

// ---------- dialog: elemen & bobot ----------

function openElementsDialog() {
  const rows = state.elements.map((e) => `<tr data-key="${escapeHtml(e.key)}">
      <td>${escapeHtml(e.category)}</td>
      <th scope="row">${escapeHtml(e.label)}<div class="hint">${e.area.toFixed(1)} m² permukaan</div></th>
      <td><input type="number" min="0" step="0.5" value="${e.weight}" data-f="weight" aria-label="Bobot ${escapeHtml(e.label)}" ${e.existing ? 'disabled' : ''} /></td>
      <td class="c"><input type="checkbox" data-f="existing" ${e.existing ? 'checked' : ''} aria-label="Eksisting ${escapeHtml(e.label)}" /></td>
      <td class="c"><input type="checkbox" data-f="manual" ${e.manual ? 'checked' : ''} aria-label="Dinilai dari foto ${escapeHtml(e.label)}" /></td>
    </tr>`).join('');
  $('#el-table').innerHTML = `<table class="matrix cfg"><thead><tr><th>Kategori</th><th>Pekerjaan</th><th>Bobot</th><th>Eksisting</th><th>Dari foto</th></tr></thead><tbody>${rows}</tbody></table>`;
  $('#el-table').querySelectorAll('input[data-f="existing"]').forEach((cb) => cb.addEventListener('change', () => {
    cb.closest('tr').querySelector('input[data-f="weight"]').disabled = cb.checked;
  }));
  $('#dlg-elements').showModal();
}

async function saveElementsDialog() {
  const cfg = {};
  $('#el-table').querySelectorAll('tr[data-key]').forEach((tr) => {
    const key = tr.dataset.key;
    const e = elementByKey(key);
    const w = parseFloat(tr.querySelector('[data-f="weight"]').value);
    const existing = tr.querySelector('[data-f="existing"]').checked;
    const manual = tr.querySelector('[data-f="manual"]').checked;
    const c = {};
    if (Number.isFinite(w) && w !== 1) c.weight = Math.max(0, w);
    if (existing !== e.autoExisting) c.existing = existing;
    if (manual !== e.autoManual) c.manual = manual;
    if (Object.keys(c).length) cfg[key] = c;
  });
  state.elementConfig = cfg;
  applyElementConfig();
  await busy('Menghitung ulang progress…', async () => {
    rebuildPlanData();
    await recomputeAll();
  });
  await saveMeta();
  renderAll();
}

// ---------- dialog: jadwal (kurva S) ----------

function scheduleRowHtml(p = { date: todayIso(), target: 0 }) {
  return `<tr><td><input type="date" value="${p.date}" aria-label="Tanggal" /></td>
    <td><input type="number" min="0" max="100" step="1" value="${Math.round(p.target * 100)}" aria-label="Target %" /></td>
    <td><button type="button" class="btn small" data-del aria-label="Hapus baris">✕</button></td></tr>`;
}

function fillScheduleTable(points) {
  const tb = $('#sched-rows');
  tb.innerHTML = points.map(scheduleRowHtml).join('');
  tb.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => b.closest('tr').remove()));
}

function openScheduleDialog() {
  fillScheduleTable(state.schedule);
  $('#sched-start').value = state.schedule[0]?.date ?? todayIso();
  $('#sched-end').value = state.schedule.at(-1)?.date ?? '';
  $('#dlg-schedule').showModal();
}

// ---------- event binding ----------

function bindUi() {
  const dlgAdd = $('#dlg-add');
  const fileInput = $('#add-file');
  fileInput.accept = ACCEPT;
  $('#plan-file').accept = PLAN_ACCEPT;

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
      const scan = await busy('Membaca scan…', async () => {
        const cloud = await loadScanFile(file, {
          zUp: $('#add-zup').checked,
          unitScale: parseFloat($('#add-unit').value),
        });
        await busyStep(`Menyelaraskan ${(cloud.points.length / 3).toLocaleString('id-ID')} titik ke model, menghitung progress…`);
        const photos = [];
        for (const f of state.pendingPhotos) {
          try {
            photos.push({ id: uid(), name: f.name, dataUrl: await photoToDataUrl(f), addedAt: Date.now(), elementKey: null });
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
        : `Scan diproses: ${(scan.points.length / 3).toLocaleString('id-ID')} titik di area unit, progress ${fmtPct(summaryFor(scan).progress)}.`, 5000);
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
  $('#sel-clip').addEventListener('change', (e) => viewer.setClipHeight(e.target.value ? Number(e.target.value) : null));
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
      else if (a === 'elements') openElementsDialog();
      else if (a === 'schedule') openScheduleDialog();
      else if (a === 'plan') { $('#form-plan').reset(); $('#dlg-plan').showModal(); }
      else if (a === 'export') await exportProject();
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
        refreshTimeline();
        renderAll();
      }
    } catch (e) {
      console.error(e);
      toast(e.message || String(e), 5000);
    }
  }));

  // Model rencana
  $('#form-plan').addEventListener('submit', async (ev) => {
    const v = ev.submitter?.value;
    if (v === 'demo-plan') {
      await store.deleteMeta('plan');
      await busy('Memuat model contoh…', async () => { await loadPlan(buildDemoPlan(), DEMO_PLAN_NAME); await recomputeAll(); });
      renderAll();
      return;
    }
    if (v !== 'ok') return;
    const f = $('#plan-file').files[0];
    if (!f) { ev.preventDefault(); return; }
    const zUp = $('#plan-zup').checked;
    try {
      let note = '';
      await busy('Memuat model rencana…', async () => {
        const res = await loadPlanFile(f, { zUp });
        note = res.note;
        await loadPlan(res.root, f.name);
        await busyStep('Menghitung ulang progress semua scan…');
        await recomputeAll();
      });
      await store.setMeta('plan', { name: f.name, data: await f.arrayBuffer(), zUp });
      renderAll();
      toast(`Model rencana: ${f.name} · ${tracked().length} pekerjaan, ${state.elements.length - tracked().length} eksisting · ${note}.`, 7000);
    } catch (err) {
      console.error(err);
      toast(`Gagal memuat model: ${err.message}`, 6000);
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

  // Elemen & bobot
  $('#el-equal').addEventListener('click', () => {
    $('#el-table').querySelectorAll('input[data-f="weight"]').forEach((i) => { i.value = 1; });
  });
  $('#el-area').addEventListener('click', () => {
    $('#el-table').querySelectorAll('tr[data-key]').forEach((tr) => {
      tr.querySelector('[data-f="weight"]').value = Math.max(0.1, elementByKey(tr.dataset.key).area).toFixed(1);
    });
  });
  $('#form-elements').addEventListener('submit', async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    await saveElementsDialog();
  });

  // Jadwal
  $('#sched-gen').addEventListener('click', () => {
    const pts = sCurve($('#sched-start').value, $('#sched-end').value);
    if (!pts.length) { toast('Isi tanggal mulai dan target opening (setelah tanggal mulai).'); return; }
    fillScheduleTable(pts);
  });
  $('#sched-add').addEventListener('click', () => {
    $('#sched-rows').insertAdjacentHTML('beforeend', scheduleRowHtml());
    const last = $('#sched-rows').lastElementChild;
    last.querySelector('[data-del]').addEventListener('click', () => last.remove());
  });
  $('#form-schedule').addEventListener('submit', async (ev) => {
    const v = ev.submitter?.value;
    if (v === 'clear') state.schedule = [];
    else if (v === 'ok') {
      state.schedule = [...$('#sched-rows').querySelectorAll('tr')].map((tr) => {
        const [d, p] = tr.querySelectorAll('input');
        return { date: d.value, target: Math.min(1, Math.max(0, parseFloat(p.value) / 100)) };
      }).filter((p) => p.date && Number.isFinite(p.target)).sort((a, b) => a.date.localeCompare(b.date));
    } else return;
    await saveMeta();
    renderAll();
  });

  // Pengaturan
  $('#form-settings').addEventListener('submit', async (ev) => {
    if (ev.submitter?.value !== 'ok') return;
    const tol = parseFloat($('#set-tol').value) / 100;
    const done = parseFloat($('#set-done').value) / 100;
    const partial = parseFloat($('#set-partial').value) / 100;
    const name = $('#set-name').value.trim() || 'Fit-out Restoran';
    if (![tol, done, partial].every(Number.isFinite) || partial > done) {
      ev.preventDefault();
      toast('Periksa angka: batas "dikerjakan" harus ≤ batas "selesai".');
      return;
    }
    const tolChanged = tol !== state.settings.tolerance;
    state.settings = { tolerance: tol, doneThreshold: done, partialThreshold: partial, keepStatus: $('#set-keep').checked };
    state.projectName = name;
    await saveMeta();
    applyProjectName();
    await busy('Menghitung ulang…', async () => {
      if (tolChanged) rebuildPlanData();
      await recomputeAll();
    });
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
  $('#set-keep').checked = !!state.settings.keepStatus;
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
    state.elementConfig = (await store.getMeta('elementConfig')) ?? {};
    state.schedule = (await store.getMeta('schedule')) ?? [];
  } catch { /* abaikan */ }
  applyProjectName();

  try {
    let plan = null;
    try { plan = await store.getMeta('plan'); } catch { /* abaikan */ }
    try {
      if (plan) {
        const res = await loadPlanFile(new File([plan.data], plan.name), { zUp: plan.zUp });
        await loadPlan(res.root, plan.name);
      } else {
        await loadPlan(buildDemoPlan(), DEMO_PLAN_NAME);
      }
    } catch (err) {
      if (!plan) throw err;
      console.warn('Model rencana tersimpan gagal dimuat, pakai contoh', err);
      await loadPlan(buildDemoPlan(), DEMO_PLAN_NAME);
    }
  } catch (err) {
    console.error(err);
    $('#viewer-msg').textContent = `Model rencana gagal dimuat: ${err.message}. Pilih file lewat Menu → Model rencana.`;
  }

  try {
    state.scans = (await store.listScans()) ?? [];
  } catch {
    state.scans = [];
  }
  sortScans();
  if (state.scans.length) await busy('Menghitung progress…', () => recomputeAll());
  else refreshTimeline();
  state.selectedScanId = state.scans.at(-1)?.id ?? null;
  renderAll();
}

init();

// Akses untuk debugging dari console browser (mis. progressTracker.state.scans).
window.progressTracker = { state };
