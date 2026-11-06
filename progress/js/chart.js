// Grafik garis progress (%) per tanggal scan, SVG murni.
// Satu seri -> tanpa legenda (judul kartu sudah menamainya); tooltip + crosshair saat hover;
// klik titik untuk memilih scan.

const NS = 'http://www.w3.org/2000/svg';

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.appendChild(e);
  return e;
}

const fmtDate = (iso) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtShort = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });

/**
 * @param {HTMLElement} container
 * @param {{id:string,date:string,label:string,progress:number,done:number,total:number}[]} rows terurut tanggal
 */
export function renderProgressChart(container, rows, { selectedId, onSelect } = {}) {
  container.innerHTML = '';
  if (!rows.length) {
    container.innerHTML = '<p class="empty">Belum ada scan. Tambah scan atau muat data demo.</p>';
    return;
  }
  const W = Math.max(280, container.clientWidth || 600);
  const H = 220;
  const m = { t: 16, r: 44, b: 28, l: 40 };
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const times = rows.map((r) => new Date(`${r.date}T00:00:00`).getTime());
  let t0 = Math.min(...times);
  let t1 = Math.max(...times);
  if (t0 === t1) { t0 -= 86400000 * 3; t1 += 86400000 * 3; }
  const x = (t) => m.l + ((t - t0) / (t1 - t0)) * iw;
  const y = (p) => m.t + (1 - p) * ih;

  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': `Progress keseluruhan per scan, terakhir ${Math.round(rows.at(-1).progress * 100)}%` }, container);

  // Grid & sumbu Y (recessive)
  for (const p of [0, 0.25, 0.5, 0.75, 1]) {
    el('line', { x1: m.l, x2: W - m.r, y1: y(p), y2: y(p), class: p === 0 ? 'axis' : 'grid' }, svg);
    const tx = el('text', { x: m.l - 8, y: y(p) + 4, 'text-anchor': 'end', class: 'tick' }, svg);
    tx.textContent = `${p * 100}%`;
  }
  // Label sumbu X: maksimal ±6 label agar tidak bertabrakan
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(iw / 90))));
  rows.forEach((r, i) => {
    if (i % every && i !== rows.length - 1) return;
    const tx = el('text', { x: x(times[i]), y: H - 8, 'text-anchor': 'middle', class: 'tick' }, svg);
    tx.textContent = fmtShort(r.date);
  });

  // Garis
  const d = rows.map((r, i) => `${i ? 'L' : 'M'}${x(times[i]).toFixed(1)},${y(r.progress).toFixed(1)}`).join('');
  el('path', { d, class: 'series-line' }, svg);

  // Crosshair
  const cross = el('line', { y1: m.t, y2: m.t + ih, class: 'crosshair', visibility: 'hidden' }, svg);

  // Titik
  const dots = rows.map((r, i) =>
    el('circle', { cx: x(times[i]), cy: y(r.progress), r: r.id === selectedId ? 6 : 4.5,
      class: `series-dot${r.id === selectedId ? ' selected' : ''}` }, svg));

  // Label langsung hanya untuk nilai terakhir
  const last = rows.at(-1);
  const lbl = el('text', { x: x(times.at(-1)) + 10, y: y(last.progress) + 4, class: 'direct-label' }, svg);
  lbl.textContent = `${Math.round(last.progress * 100)}%`;

  // Tooltip (HTML) + area hover
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.appendChild(tip);
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
    tip.innerHTML = `<strong>${Math.round(r.progress * 100)}%</strong><span>${fmtDate(r.date)}</span>` +
      `<span>${r.label ? `${escapeHtml(r.label)} · ` : ''}${r.done}/${r.total} terpasang</span>`;
    const scale = svg.getBoundingClientRect().width / W;
    const left = Math.min(Math.max(cx * scale - tip.offsetWidth / 2, 0), container.clientWidth - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(0, y(r.progress) * scale - tip.offsetHeight - 12)}px`;
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
