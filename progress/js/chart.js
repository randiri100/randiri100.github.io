// Grafik kurva S: progress aktual per scan vs rencana, SVG murni.
// Dua seri -> legenda + label langsung di ujung garis; tooltip + crosshair saat hover;
// klik titik untuk membuka scan.

const NS = 'http://www.w3.org/2000/svg';
const DAY = 86400000;

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

const ts = (iso) => new Date(`${iso}T00:00:00`).getTime();
const fmtDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = (t) => new Date(t).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
const pct = (v) => `${Math.round(v * 100)}%`;

/**
 * @param {HTMLElement} container
 * @param {{id,date,label,progress,done,total,planned}[]} rows aktual, urut tanggal
 * @param {{plan?: {date:string,target:number}[], selectedId?: string, onSelect?: Function, today?: string}} opts
 */
export function renderProgressChart(container, rows, { plan = [], selectedId, onSelect, today } = {}) {
  container.innerHTML = '';
  if (!rows.length && !plan.length) {
    container.innerHTML = '<p class="empty">Belum ada scan. Tambah scan atau muat data demo.</p>';
    return;
  }
  const hasPlan = plan.length > 0;
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  legend.innerHTML = '<span><i class="key actual"></i>Aktual (scan)</span>' +
    (hasPlan ? '<span><i class="key plan"></i>Rencana (kurva S)</span>' : '');
  container.appendChild(legend);

  const W = Math.max(280, container.clientWidth || 600);
  const H = 230;
  const m = { t: 14, r: 48, b: 28, l: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const times = rows.map((r) => ts(r.date));
  const planPts = plan.map((p) => [ts(p.date), p.target]).sort((a, b) => a[0] - b[0]);
  const all = [...times, ...planPts.map((p) => p[0])];
  let t0 = Math.min(...all);
  let t1 = Math.max(...all);
  if (t0 === t1) { t0 -= DAY * 3; t1 += DAY * 3; }
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
  const y = (p) => m.t + (1 - p) * ih;

  const svg = el('svg', {
    viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': rows.length ? `Progress aktual terakhir ${pct(rows.at(-1).progress)}` : 'Kurva S rencana',
  }, container);

  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(p), y2: y(p), class: p === 0 ? 'axis' : 'grid' }, svg);
    el('text', { x: m.l - 8, y: y(p) + 4, 'text-anchor': 'end', class: 'tick' }, svg).textContent = `${p * 100}%`;
  }
  // Label tanggal: ±1 per 90 px
  const nTicks = Math.max(2, Math.floor(iw / 90));
  for (let i = 0; i <= nTicks; i++) {
    const t = t0 + ((t1 - t0) * i) / nTicks;
    el('text', { x: x(t), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === nTicks ? 'end' : 'middle', class: 'tick' }, svg)
      .textContent = fmtShort(t);
  }
  // Hari ini
  if (today) {
    const tt = ts(today);
    if (tt >= t0 && tt <= t1) {
      el('line', { x1: x(tt), x2: x(tt), y1: m.t, y2: m.t + ih, class: 'today' }, svg);
      el('text', { x: x(tt) + 4, y: m.t + 10, class: 'tick' }, svg).textContent = 'hari ini';
    }
  }
  // Rencana (putus-putus)
  if (hasPlan) {
    const d = planPts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('');
    el('path', { d, class: 'plan-line' }, svg);
    const [lt, lv] = planPts.at(-1);
    el('text', { x: x(lt) + 8, y: y(lv) + 4 + (rows.length && Math.abs(y(lv) - y(rows.at(-1).progress)) < 14 && Math.abs(x(lt) - x(times.at(-1))) < 40 ? 14 : 0), class: 'direct-label muted' }, svg)
      .textContent = 'Rencana';
  }
  // Aktual
  let dots = [];
  if (rows.length) {
    const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(r.progress).toFixed(1)}`).join('');
    el('path', { d, class: 'series-line' }, svg);
    dots = rows.map((r, i) => el('circle', {
      cx: x(times[i]), cy: y(r.progress), r: r.id === selectedId ? 6 : 4.5,
      class: `series-dot${r.id === selectedId ? ' selected' : ''}`,
    }, svg));
    const last = rows.at(-1);
    el('text', { x: x(times.at(-1)) + 8, y: y(last.progress) + 4, class: 'direct-label' }, svg).textContent = pct(last.progress);
  }

  const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' }, svg);
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.appendChild(tip);
  if (!rows.length) return;

  const hit = el('rect', { x: m.l - 10, y: 0, width: iw + 20, height: H, fill: 'transparent' }, svg);
  hit.style.cursor = onSelect ? 'pointer' : 'default';
  const nearestIndex = (evt) => {
    const rect = svg.getBoundingClientRect();
    const px = ((evt.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < rows.length; i++) if (Math.abs(x(times[i]) - px) < Math.abs(x(times[best]) - px)) best = i;
    return best;
  };
  hit.addEventListener('pointermove', (evt) => {
    const i = nearestIndex(evt);
    const r = rows[i];
    const cx = x(times[i]);
    cross.setAttribute('x1', cx);
    cross.setAttribute('x2', cx);
    cross.setAttribute('visibility', 'visible');
    dots.forEach((dot, k) => dot.classList.toggle('hover', k === i));
    tip.hidden = false;
    const dev = r.planned == null ? '' : (() => {
      const dp = Math.round((r.progress - r.planned) * 100);
      return `<span>Rencana ${pct(r.planned)} · ${dp >= 0 ? '▲ +' : '▼ −'}${Math.abs(dp)} poin</span>`;
    })();
    tip.innerHTML = `<strong>${pct(r.progress)}</strong><span>${fmtDate(r.date)}${r.label ? ` · ${escapeHtml(r.label)}` : ''}</span>` +
      `${dev}<span>${r.done}/${r.total} elemen selesai</span>`;
    const scale = svg.getBoundingClientRect().width / W;
    const left = Math.min(Math.max(cx * scale - tip.offsetWidth / 2, 0), container.clientWidth - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, legend.offsetHeight + y(r.progress) * scale - tip.offsetHeight - 12)}px`;
  });
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden');
    dots.forEach((dot) => dot.classList.remove('hover'));
    tip.hidden = true;
  });
  hit.addEventListener('click', (evt) => onSelect?.(rows[nearestIndex(evt)].id));
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
