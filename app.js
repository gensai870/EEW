(() => {
'use strict';

/* ================= 定数・ユーティリティ ================= */
const WS_BASE = 'wss://ws-api.wolfx.jp/';
const API_BASE = 'https://api.wolfx.jp/';
const VP = 7.0;  // P波 km/s（概算）
const VS = 4.0;  // S波 km/s（概算）
const ACTIVE_MS = 5 * 60 * 1000;
const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = (s, r = document) => r.querySelector(s);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 保存できない環境は無視 */ } }
};

// 取得データは必ず textContent / createTextNode 経由で表示する（innerHTML は使わない）
function h(tag, props, ...kids) {
  const n = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v === true) n.setAttribute(k, '');
      else n.setAttribute(k, v);
    }
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return n;
}

const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.+-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const fix = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

const JST = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});
function fmtJST(ms, withDate = true) {
  if (!Number.isFinite(ms)) return '—';
  const p = Object.fromEntries(JST.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const t = `${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}`;
  return withDate ? `${p.month}/${p.day} ${t}` : t;
}
function parseJST(s) {
  const m = String(s ?? '').match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0));
}

/* ================= 震度 ================= */
const SH = {
  '0':  { l: '0',  r: 0,   c: '#44515c', t: '#dce6ee' },
  '1':  { l: '1',  r: 1,   c: '#3b6ea8', t: '#ffffff' },
  '2':  { l: '2',  r: 2,   c: '#2f9e8f', t: '#04201c' },
  '3':  { l: '3',  r: 3,   c: '#7cc84d', t: '#0f2204' },
  '4':  { l: '4',  r: 4,   c: '#e6c229', t: '#241c00' },
  '5-': { l: '5弱', r: 5,   c: '#f59e0b', t: '#241500' },
  '5+': { l: '5強', r: 5.5, c: '#ef6c1a', t: '#ffffff' },
  '6-': { l: '6弱', r: 6,   c: '#e53935', t: '#ffffff' },
  '6+': { l: '6強', r: 6.5, c: '#b71c4a', t: '#ffffff' },
  '7':  { l: '7',  r: 7,   c: '#7b1fa2', t: '#ffffff' }
};
function normShindo(v) {
  if (v == null) return null;
  const t = String(v).replace(/\s|震度|程度/g, '').replace(/[−－‐]/g, '-').replace(/＋/g, '+').replace('弱', '-').replace('強', '+');
  const m = t.match(/^([0-7])([+-])?/);
  if (!m) return null;
  let key = m[1];
  if (key === '5' || key === '6') key += (m[2] || '-');
  const x = SH[key];
  return x ? { key, label: x.l, rank: x.r, color: x.c, text: x.t } : null;
}
function shBadge(sh) {
  const b = h('span', { class: 'sh', text: sh ? sh.label : '—' });
  if (sh) { b.style.setProperty('--c', sh.color); b.style.setProperty('--t', sh.text); }
  return b;
}

/* ================= 状態 ================= */
const S = {
  clockOffset: 0,
  eew: null,
  eewKey: '',
  quakes: [],
  listUpdated: NaN,
  listInfo: '',
  user: null,
  layers: Object.assign({ eew: true, quakes: true, grid: true }, store.get('layers', {})),
  voice: false,
  notify: false,
  threshold: store.get('threshold', 'warn'),
  conn: {
    eew:  { label: '緊急地震速報', path: 'jma_eew',    state: '接続中', hb: 0, ver: '', id: '', msg: '' },
    list: { label: '地震情報',     path: 'jma_eqlist', state: '接続中', hb: 0, ver: '', id: '', msg: '' }
  }
};
const now = () => Date.now() + S.clockOffset;

/* ================= データ整形 ================= */
function normEEW(d) {
  if (!d || typeof d !== 'object' || (!d.EventID && !d.Hypocenter)) return null;
  return {
    id: String(d.EventID || ''),
    serial: num(d.Serial),
    announced: parseJST(d.AnnouncedTime),
    origin: parseJST(d.OriginTime),
    place: String(d.Hypocenter || ''),
    lat: num(d.Latitude),
    lon: num(d.Longitude),
    mag: num(d.Magnitude ?? d.Magunitude),
    depth: num(d.Depth),
    maxInt: normShindo(d.MaxIntensity),
    warn: !!d.isWarn,
    final: !!d.isFinal,
    cancel: !!d.isCancel,
    training: !!d.isTraining,
    assumption: !!d.isAssumption,
    sea: !!d.isSea,
    areas: Array.isArray(d.WarnArea) ? d.WarnArea.map((a) => ({
      name: String(a?.Chiiki ?? ''), hi: normShindo(a?.Shindo1), lo: normShindo(a?.Shindo2), type: String(a?.Type ?? '')
    })) : []
  };
}
function normList(d) {
  const out = [];
  for (const k of Object.keys(d || {})) {
    if (!/^No\d+$/.test(k)) continue;
    const q = d[k];
    if (!q || typeof q !== 'object') continue;
    out.push({
      no: +k.slice(2), time: parseJST(q.time), place: String(q.location || ''),
      mag: num(q.magnitude), shindo: normShindo(q.shindo), depth: num(q.depth),
      lat: num(q.latitude), lon: num(q.longitude), info: String(q.info || '')
    });
  }
  return out.sort((a, b) => a.no - b.no);
}
const isActive = (e) => !!e && !e.cancel && Number.isFinite(e.origin) && now() - e.origin < ACTIVE_MS;
function eewStatus(e) {
  if (!e) return { t: '受信待ち', c: 'idle' };
  if (e.cancel) return { t: '取消', c: 'idle' };
  if (!isActive(e)) return { t: '待機中', c: 'idle' };
  if (e.training) return { t: '訓練', c: 'train' };
  return e.warn ? { t: '警報', c: 'warn' } : { t: '予報', c: 'fcst' };
}

/* ================= 地図 ================= */
const cv = $('#map');
const ctx = cv.getContext('2d');
const V = { cx: 0.88, cy: 0.37, z: 5 };
let W = 0, H = 0, DPR = 1, LAND = [], fitted = false;

const proj = (lon, lat) => {
  const s = Math.sin(lat * Math.PI / 180);
  return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
};
const scale = () => 256 * Math.pow(2, V.z);
const toScreen = (lon, lat) => {
  const [x, y] = proj(lon, lat), s = scale();
  return [(x - V.cx) * s + W / 2, (y - V.cy) * s + H / 2];
};
const kmToPx = (km, lat) => (km * 1000) / (40075016.686 * Math.cos(lat * Math.PI / 180) / scale());

function clampView() {
  V.z = Math.min(9, Math.max(3, V.z));
  V.cx = Math.min(1, Math.max(0.74, V.cx));
  V.cy = Math.min(0.52, Math.max(0.2, V.cy));
}
function fitJapan() {
  const [x0, y0] = proj(122, 46.5), [x1, y1] = proj(148.5, 24);
  const zx = Math.log2(W / (256 * (x1 - x0) * 1.08));
  const zy = Math.log2(H / (256 * (y1 - y0) * 1.12));
  V.z = Math.min(zx, zy);
  V.cx = (x0 + x1) / 2;
  V.cy = (y0 + y1) / 2;
  clampView();
}
function flyTo(lon, lat, z = 6.5) {
  const [x, y] = proj(lon, lat);
  V.cx = x; V.cy = y; V.z = Math.max(V.z, z);
  clampView(); draw();
}
function zoomAt(px, py, dz) {
  const s = scale(), wx = V.cx + (px - W / 2) / s, wy = V.cy + (py - H / 2) / s;
  V.z += dz; clampView();
  const s2 = scale();
  V.cx = wx - (px - W / 2) / s2; V.cy = wy - (py - H / 2) / s2;
  clampView(); draw();
}

function resize() {
  const r = cv.getBoundingClientRect();
  DPR = Math.min(window.devicePixelRatio || 1, 2);
  W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
  cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
  if (!fitted) { fitJapan(); fitted = true; }
  draw();
}

function drawGrid(s) {
  ctx.strokeStyle = '#111b23'; ctx.lineWidth = 1; ctx.beginPath();
  for (let lon = 100; lon <= 180; lon += 5) {
    const x = (proj(lon, 0)[0] - V.cx) * s + W / 2;
    ctx.moveTo(x, 0); ctx.lineTo(x, H);
  }
  for (let lat = 5; lat <= 60; lat += 5) {
    const y = (proj(0, lat)[1] - V.cy) * s + H / 2;
    ctx.moveTo(0, y); ctx.lineTo(W, y);
  }
  ctx.stroke();
}

function draw() {
  if (!W) return;
  const s = scale();
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.fillStyle = '#080c10'; ctx.fillRect(0, 0, W, H);
  if (S.layers.grid) drawGrid(s);

  ctx.beginPath();
  for (const r of LAND) {
    for (let i = 0; i < r.length; i += 2) {
      const x = (r[i] - V.cx) * s + W / 2, y = (r[i + 1] - V.cy) * s + H / 2;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
  ctx.fillStyle = '#141c23'; ctx.fill('evenodd');
  ctx.strokeStyle = '#2b3b47'; ctx.lineWidth = 1; ctx.stroke();

  if (S.layers.quakes) drawQuakes();
  if (S.user) drawUser();
  if (S.layers.eew) drawEEW();
}

function quakeRadius(q) { return 3 + Math.max(0, Number.isFinite(q.mag) ? q.mag : 2) * 1.7; }

function drawQuakes() {
  const t = now();
  const items = S.quakes.filter((q) => Number.isFinite(q.lat) && Number.isFinite(q.lon)).slice().sort((a, b) => quakeRadius(b) - quakeRadius(a));
  for (const q of items) {
    const [x, y] = toScreen(q.lon, q.lat);
    if (x < -30 || y < -30 || x > W + 30 || y > H + 30) continue;
    const age = t - q.time;
    const a = age < 864e5 ? 0.92 : age < 6048e5 ? 0.6 : 0.35;
    ctx.globalAlpha = a;
    ctx.beginPath(); ctx.arc(x, y, quakeRadius(q), 0, Math.PI * 2);
    ctx.fillStyle = q.shindo ? q.shindo.color : '#55636d'; ctx.fill();
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawUser() {
  const [x, y] = toScreen(S.user.lon, S.user.lat), r = 6;
  ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
  ctx.fillStyle = '#5ee0ff'; ctx.fill(); ctx.strokeStyle = '#05212b'; ctx.lineWidth = 1.5; ctx.stroke();
}

function drawEEW() {
  const e = S.eew;
  if (!isActive(e) || !Number.isFinite(e.lat) || !Number.isFinite(e.lon)) return;
  const [x, y] = toScreen(e.lon, e.lat);
  const t = Math.max(0, (now() - e.origin) / 1000), d = Number.isFinite(e.depth) ? e.depth : 10;
  const rp = Math.sqrt(Math.max(0, (VP * t) ** 2 - d * d));
  const rs = Math.sqrt(Math.max(0, (VS * t) ** 2 - d * d));
  const dash = e.training || e.assumption ? [6, 5] : [];
  ctx.setLineDash(dash); ctx.lineWidth = 2;
  if (rp > 0) {
    const r = kmToPx(rp, e.lat);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(74,168,255,.06)'; ctx.fill(); ctx.strokeStyle = '#4aa8ff'; ctx.stroke();
  }
  if (rs > 0) {
    const r = kmToPx(rs, e.lat);
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,77,61,.13)'; ctx.fill(); ctx.strokeStyle = '#ff4d3d'; ctx.stroke();
  }
  ctx.setLineDash([]);
  const pulse = REDUCED ? 0 : (Math.sin(Date.now() / 220) + 1) / 2;
  const k = 9 + pulse * 3;
  ctx.strokeStyle = '#000'; ctx.lineWidth = 6; ctx.beginPath();
  ctx.moveTo(x - k, y - k); ctx.lineTo(x + k, y + k); ctx.moveTo(x + k, y - k); ctx.lineTo(x - k, y + k); ctx.stroke();
  ctx.strokeStyle = '#ff4d3d'; ctx.lineWidth = 3.5; ctx.stroke();
}

/* ---- 地図操作 ---- */
const ptrs = new Map();
let drag = null, moved = false, lastPinch = null;
const tip = $('#tip');

function pinchInfo() {
  const [a, b] = [...ptrs.values()];
  return { d: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
cv.addEventListener('pointerdown', (e) => {
  cv.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  moved = false; tip.hidden = true;
  if (ptrs.size === 1) drag = { x: e.offsetX, y: e.offsetY, cx: V.cx, cy: V.cy };
  else if (ptrs.size === 2) { drag = null; lastPinch = pinchInfo(); }
});
cv.addEventListener('pointermove', (e) => {
  if (!ptrs.has(e.pointerId)) { if (e.pointerType === 'mouse') showTip(e.offsetX, e.offsetY); return; }
  ptrs.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
  if (ptrs.size === 2 && lastPinch) {
    const p = pinchInfo(), s = scale();
    V.cx -= (p.x - lastPinch.x) / s; V.cy -= (p.y - lastPinch.y) / s;
    zoomAt(p.x, p.y, Math.log2(p.d / lastPinch.d));
    lastPinch = p; moved = true;
  } else if (drag) {
    const s = scale(), dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    V.cx = drag.cx - dx / s; V.cy = drag.cy - dy / s; clampView(); draw();
  }
});
function endPtr(e, tap) {
  const wasSingle = ptrs.size === 1;
  ptrs.delete(e.pointerId); lastPinch = null;
  if (ptrs.size === 1) { const p = [...ptrs.values()][0]; drag = { x: p.x, y: p.y, cx: V.cx, cy: V.cy }; moved = true; }
  else drag = null;
  if (tap && wasSingle && !moved) showTip(e.offsetX, e.offsetY);
}
cv.addEventListener('pointerup', (e) => endPtr(e, true));
cv.addEventListener('pointercancel', (e) => endPtr(e, false));
cv.addEventListener('pointerleave', () => { if (!ptrs.size) tip.hidden = true; });
cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.offsetX, e.offsetY, -e.deltaY * 0.0015); }, { passive: false });

function showTip(px, py) {
  let best = null, bd = 1e9;
  for (const q of S.quakes) {
    if (!S.layers.quakes || !Number.isFinite(q.lat) || !Number.isFinite(q.lon)) continue;
    const [x, y] = toScreen(q.lon, q.lat), dd = Math.hypot(x - px, y - py);
    if (dd < quakeRadius(q) + 6 && dd < bd) { bd = dd; best = q; }
  }
  const e = S.eew;
  if (S.layers.eew && isActive(e) && Number.isFinite(e.lat)) {
    const [x, y] = toScreen(e.lon, e.lat);
    if (Math.hypot(x - px, y - py) < 16) best = { eew: e };
  }
  if (!best) { tip.hidden = true; return; }
  tip.replaceChildren();
  if (best.eew) {
    tip.append(h('b', { text: `速報 ${best.eew.place}` }), h('br'), `M${fix(best.eew.mag)}　深さ${fix(best.eew.depth, 0)}km`);
  } else {
    tip.append(h('b', { text: best.place || '震源不明' }), h('br'),
      `${fmtJST(best.time)}`, h('br'),
      `M${fix(best.mag)}　深さ${fix(best.depth, 0)}km　最大震度${best.shindo ? best.shindo.label : '—'}`);
  }
  tip.hidden = false;
  tip.style.left = `${Math.min(px + 14, W - 250)}px`;
  tip.style.top = `${Math.min(py + 14, H - 80)}px`;
}

$('#z-in').addEventListener('click', () => zoomAt(W / 2, H / 2, 0.6));
$('#z-out').addEventListener('click', () => zoomAt(W / 2, H / 2, -0.6));
$('#z-home').addEventListener('click', () => { fitJapan(); draw(); });

const locStatus = $('#loc-status'), btnLoc = $('#z-loc');
let locTimer = 0;
function locMsg(text) {
  clearTimeout(locTimer);
  locStatus.textContent = text; locStatus.hidden = !text;
  if (text) locTimer = setTimeout(() => { locStatus.hidden = true; }, 5000);
}
btnLoc.addEventListener('click', () => {
  if (!('geolocation' in navigator)) { locMsg('この端末では現在地を取得できません。'); return; }
  btnLoc.disabled = true; locMsg('現在地を取得中…');
  navigator.geolocation.getCurrentPosition((pos) => {
    btnLoc.disabled = false;
    const lat = pos.coords.latitude, lon = pos.coords.longitude;
    if (!(lon >= 122 && lon <= 154 && lat >= 20 && lat <= 46.5)) { locMsg('現在地が日本の地図の範囲外です。'); return; }
    S.user = { lat, lon };
    locMsg('');
    flyTo(lon, lat, 8);
  }, (err) => {
    btnLoc.disabled = false;
    locMsg(err.code === 1 ? '位置情報の利用が許可されていません。ブラウザの設定を確認してください。'
      : err.code === 3 ? '現在地の取得がタイムアウトしました。' : '現在地を取得できませんでした。');
  }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
});
new ResizeObserver(resize).observe(cv);

fetch('/data/land.json').then((r) => r.json()).then((j) => {
  LAND = j.rings.map((flat) => {
    const o = new Float64Array(flat.length);
    for (let i = 0; i < flat.length; i += 2) { const p = proj(flat[i], flat[i + 1]); o[i] = p[0]; o[i + 1] = p[1]; }
    return o;
  });
  draw();
}).catch(() => { /* 地図データなしでも他機能は動作 */ });

/* ---- レイヤー切替 ---- */
document.querySelectorAll('input[data-layer]').forEach((el) => {
  el.checked = !!S.layers[el.dataset.layer];
  el.addEventListener('change', () => {
    S.layers[el.dataset.layer] = el.checked; store.set('layers', S.layers); draw();
  });
});
$('#lg-scale').append(...['1', '2', '3', '4', '5-', '5+', '6-', '6+', '7'].map((k) => shBadge(normShindo(k))));

/* ================= パネル描画 ================= */
function renderEEW() {
  const e = S.eew, st = eewStatus(e);
  const badge = $('#eew-badge');
  badge.className = `badge ${st.c}`; badge.textContent = st.t;
  const body = $('#eew-body');
  body.replaceChildren();

  if (!e) {
    body.append(h('p', { class: 'empty', text: '緊急地震速報の受信を待っています。発表がないときは、この表示のままです。' }));
    updateBanner(); return;
  }
  const flags = [];
  if (e.final) flags.push('最終報');
  if (e.assumption) flags.push('仮定震源要素');
  if (e.sea) flags.push('海域');
  if (e.training) flags.push('訓練報');
  if (e.cancel) flags.push('取消報');

  body.append(h('dl', { class: 'kv' },
    h('dt', { text: '震源地' }), h('dd', { text: e.place || '—' }),
    h('dt', { text: '最大震度' }), h('dd', {}, shBadge(e.maxInt)),
    h('dt', { text: 'マグニチュード' }), h('dd', { text: fix(e.mag) }),
    h('dt', { text: '深さ' }), h('dd', { text: Number.isFinite(e.depth) ? `${fix(e.depth, 0)} km` : '—' }),
    h('dt', { text: '発生' }), h('dd', { text: fmtJST(e.origin) }),
    h('dt', { text: '発表' }), h('dd', { text: fmtJST(e.announced) }),
    h('dt', { text: '報数' }), h('dd', { text: Number.isFinite(e.serial) ? `第${e.serial}報` : '—' }),
    h('dt', { text: '経過' }), h('dd', { id: 'eew-elapsed', text: elapsedText(e) }),
    flags.length ? h('dt', { text: '備考' }) : null,
    flags.length ? h('dd', { text: flags.join('・') }) : null
  ));

  if (e.areas.length) {
    const rows = e.areas.slice(0, 20).map((a) => h('tr', {},
      h('td', { text: a.name || '—' }),
      h('td', {}, shBadge(a.lo), a.hi && a.lo && a.hi.key !== a.lo.key ? ['〜', shBadge(a.hi)] : null),
      h('td', { text: a.type })));
    body.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', { text: '対象地域' }), h('th', { text: '予測震度' }), h('th', { text: '種別' }))),
      h('tbody', {}, rows)));
    if (e.areas.length > 20) body.append(h('p', { class: 'empty', text: `ほか ${e.areas.length - 20} 地域` }));
  }
  updateBanner();
}
function elapsedText(e) {
  if (!e || !Number.isFinite(e.origin)) return '—';
  const s = Math.max(0, Math.round((now() - e.origin) / 1000));
  return s < 120 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function updateBanner() {
  const e = S.eew, st = eewStatus(e), b = $('#banner');
  if (!e || !(st.c === 'warn' || st.c === 'fcst' || st.c === 'train')) { b.hidden = true; return; }
  b.hidden = false;
  b.className = `banner ${st.c}`;
  const bi = $('#b-int');
  bi.textContent = e.maxInt ? e.maxInt.label : '?';
  bi.style.setProperty('background', e.maxInt ? e.maxInt.color : '#44515c');
  bi.style.setProperty('color', e.maxInt ? e.maxInt.text : '#fff');
  $('#b-kind').textContent = `緊急地震速報（${st.t}）${Number.isFinite(e.serial) ? ` 第${e.serial}報` : ''}${e.final ? ' 最終' : ''}`;
  $('#b-place').textContent = e.place || '震源不明';
  $('#b-meta').textContent = `M${fix(e.mag)}　深さ${Number.isFinite(e.depth) ? fix(e.depth, 0) + 'km' : '—'}　発生から${elapsedText(e)}`;
}
$('#b-focus').addEventListener('click', () => { const e = S.eew; if (e && Number.isFinite(e.lat)) flyTo(e.lon, e.lat, 6); });

function renderList() {
  const body = $('#list-body');
  body.replaceChildren();
  $('#list-sub').textContent = S.quakes.length ? `${S.quakes.length}件・更新 ${fmtJST(S.listUpdated, false)}` : '';
  const note = $('#list-note');
  if (S.listInfo && S.listInfo !== '-') { note.hidden = false; note.textContent = `最新の地震：${S.listInfo}`; } else note.hidden = true;
  if (!S.quakes.length) { body.append(h('p', { class: 'empty', style: null, text: '地震情報を受信しています…' })); body.firstChild.style.setProperty('padding', '10px 12px'); return; }
  for (const q of S.quakes) {
    body.append(h('button', {
      type: 'button', class: 'row',
      'aria-label': `${fmtJST(q.time)} ${q.place} マグニチュード${fix(q.mag)} 最大震度${q.shindo ? q.shindo.label : '不明'}`,
      onclick: () => { if (Number.isFinite(q.lat) && Number.isFinite(q.lon)) flyTo(q.lon, q.lat, 6.5); }
    },
      h('span', { class: 't', text: fmtJST(q.time) }),
      h('span', { class: 'place', text: q.place || '震源不明' }),
      h('span', { class: 'm', text: `M${fix(q.mag)} ${Number.isFinite(q.depth) ? fix(q.depth, 0) + 'km' : ''}` }),
      shBadge(q.shindo)));
  }
}

function renderConn() {
  const body = $('#conn-body');
  const rows = Object.values(S.conn).map((c) => h('tr', {},
    h('td', { text: c.label }),
    h('td', { text: c.state }),
    h('td', { text: c.hb ? `${Math.round((Date.now() - c.hb) / 1000)}秒前` : '—' }),
    h('td', { text: c.ver || '—' })));
  body.replaceChildren(
    h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: '回線' }), h('th', { text: '状態' }), h('th', { text: '最終応答' }), h('th', { text: 'サーバー' }))), h('tbody', {}, rows)),
    ...Object.values(S.conn).filter((c) => c.msg).map((c) => h('p', { class: 'empty', text: `${c.label}：${c.msg}` })),
    h('p', { class: 'empty', text: `時計の補正：${S.clockOffset >= 0 ? '+' : ''}${(S.clockOffset / 1000).toFixed(2)} 秒` })
  );
  const map = { eew: '#chip-eew', list: '#chip-list' };
  for (const [k, sel] of Object.entries(map)) {
    const c = S.conn[k], el = $(sel);
    el.classList.remove('ok', 'wait', 'ng');
    el.classList.add(c.state === '接続済み' ? 'ok' : c.state === '接続中' ? 'wait' : 'ng');
  }
}

/* ================= 通信 ================= */
function handleEEW(d) {
  const e = normEEW(d);
  if (!e) return;
  const key = `${e.id}:${e.serial}:${e.cancel ? 1 : 0}`;
  const isNew = key !== S.eewKey;
  S.eew = e; S.eewKey = key;
  renderEEW(); draw();
  if (isNew && shouldAlert(e)) fireAlert(e);
}
function handleList(d) {
  const q = normList(d);
  if (!q.length) return;
  S.quakes = q;
  S.listUpdated = now();
  const first = d.No1 || d[Object.keys(d).find((k) => /^No\d+$/.test(k))];
  S.listInfo = first && typeof first.info === 'string' ? first.info : '';
  renderList(); draw();
}

function connect(key, onData) {
  const c = S.conn[key];
  let ws = null, retry = 0, timer = 0;
  const query = key === 'eew' ? 'query_jmaeew' : 'query_jmaeqlist';
  const setState = (s) => { c.state = s; renderConn(); };
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(open, Math.min(30000, 1000 * 2 ** retry++));
  };
  function open() {
    setState('接続中');
    try { ws = new WebSocket(WS_BASE + c.path); } catch { setState('再接続待ち'); schedule(); return; }
    ws.onopen = () => { retry = 0; c.hb = Date.now(); setState('接続済み'); try { ws.send(query); } catch { /* 無視 */ } };
    ws.onmessage = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch { return; }
      if (d && d.type === 'heartbeat') {
        c.hb = Date.now(); c.ver = String(d.ver || ''); c.id = String(d.id || ''); c.msg = String(d.message || '');
        try { ws.send('ping'); } catch { /* 無視 */ }
        renderConn(); return;
      }
      if (d && d.type === 'pong') { c.hb = Date.now(); return; }
      c.hb = Date.now();
      onData(d);
    };
    ws.onclose = () => { setState('再接続待ち'); schedule(); };
    ws.onerror = () => { try { ws.close(); } catch { /* 無視 */ } };
  }
  setInterval(() => {
    if (ws && ws.readyState === 1 && c.hb && Date.now() - c.hb > 150000) { try { ws.close(); } catch { /* 無視 */ } }
  }, 15000);
  open();
}

// WebSocketが使えないときのバックアップ（CORSで拒否される場合は何もしない）
async function pull(file, fn) {
  try { const r = await fetch(API_BASE + file, { cache: 'no-store' }); if (r.ok) fn(await r.json()); } catch { /* 無視 */ }
}
setInterval(() => {
  if (S.conn.eew.state !== '接続済み') pull('jma_eew.json', handleEEW);
  if (S.conn.list.state !== '接続済み') pull('jma_eqlist.json', handleList);
}, 15000);

/* ================= 通知・音声 ================= */
function shouldAlert(e) {
  if (e.training || e.cancel) return false;
  if (!(now() - e.announced < 90000)) return false;   // 古い電文は鳴らさない
  const t = S.threshold;
  if (t === 'all') return true;
  if (t === 'warn') return e.warn;
  const need = t === '3' ? 3 : 5;
  return e.warn || (e.maxInt ? e.maxInt.rank >= need : false);
}

let actx = null;
function beep() {
  if (!actx) return;
  const t0 = actx.currentTime;
  for (let i = 0; i < 6; i++) {
    const o = actx.createOscillator(), g = actx.createGain(), t = t0 + i * 0.3;
    o.type = 'sine'; o.frequency.value = i % 2 ? 880 : 660;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.3);
  }
}
function speak(text) {
  if (!('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(text); u.lang = 'ja-JP'; u.rate = 1.05;
  window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
}
function fireAlert(e) {
  const kind = e.warn ? '緊急地震速報（警報）' : '緊急地震速報（予報）';
  const intTxt = e.maxInt ? `最大震度${e.maxInt.label}程度` : '最大震度は不明';
  const body = `${e.place || '震源不明'}で地震。${intTxt}。M${fix(e.mag)}`;
  if (S.notify && 'Notification' in window && Notification.permission === 'granted') {
    const opt = { body, tag: `eew-${e.id}`, renotify: true, requireInteraction: e.warn, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', vibrate: [200, 100, 200, 100, 400] };
    (navigator.serviceWorker ? navigator.serviceWorker.ready : Promise.reject())
      .then((r) => r.showNotification(kind, opt))
      .catch(() => { try { new Notification(kind, { body }); } catch { /* 無視 */ } });
  }
  if (S.voice) {
    beep();
    setTimeout(() => speak(`${kind}。${e.place || '震源不明'}で地震。${intTxt}。`), 1900);
  }
}

const btnVoice = $('#btn-voice'), btnNotify = $('#btn-notify'), selTh = $('#sel-threshold');
function paintToggles() {
  btnVoice.textContent = `音声 ${S.voice ? 'オン' : 'オフ'}`; btnVoice.setAttribute('aria-pressed', String(S.voice));
  btnNotify.textContent = `通知 ${S.notify ? 'オン' : 'オフ'}`; btnNotify.setAttribute('aria-pressed', String(S.notify));
}
btnVoice.addEventListener('click', () => {
  S.voice = !S.voice;
  if (S.voice) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC && !actx) actx = new AC();
    if (actx && actx.state === 'suspended') actx.resume();
    beep();
    speak('音声を有効にしました');
  } else if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  paintToggles();
});
btnNotify.addEventListener('click', async () => {
  if (S.notify) { S.notify = false; paintToggles(); return; }
  if (!('Notification' in window)) { btnNotify.textContent = '通知 非対応'; return; }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm === 'granted') S.notify = true;
  else btnNotify.textContent = '通知 拒否されました';
  if (S.notify) paintToggles();
});
selTh.value = S.threshold;
selTh.addEventListener('change', () => { S.threshold = selTh.value; store.set('threshold', S.threshold); });

/* ================= ツール（IP・地域・時刻） ================= */
function renderTools() {
  const ipRes = h('div', { class: 'res', 'aria-live': 'polite' });
  const geoRes = h('div', { class: 'res', 'aria-live': 'polite' });
  const ntpRes = h('div', { class: 'res', id: 'ntp-res', 'aria-live': 'polite' });

  const run = async (btn, out, fn) => {
    btn.disabled = true; out.textContent = '確認中…';
    try { out.textContent = await fn(); } catch { out.textContent = '取得できませんでした。時間をおいて再度お試しください。'; }
    btn.disabled = false;
  };
  const bIp = h('button', { type: 'button', text: 'IPアドレスを確認' });
  const bGeo = h('button', { type: 'button', text: '接続元の地域を推定' });
  const bNtp = h('button', { type: 'button', text: '時刻を同期' });

  bIp.addEventListener('click', () => run(bIp, ipRes, async () => {
    const r = await fetch(API_BASE + 'ip.php', { cache: 'no-store' });
    if (!r.ok) throw new Error('ip');
    return `あなたのIPアドレス：${(await r.text()).trim()}`;
  }));
  bGeo.addEventListener('click', () => run(bGeo, geoRes, async () => {
    const r = await fetch(API_BASE + 'geoip.php', { cache: 'no-store' });
    if (!r.ok) throw new Error('geo');
    const g = await r.json();
    const lat = num(g.latitude), lon = num(g.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon)) { S.user = { lat, lon }; draw(); }
    const where = [g.country_name, g.province_name, g.city].filter(Boolean).join(' ');
    return `${where || '地域を特定できませんでした'}${S.user ? '（地図に表示）' : ''}`;
  }));
  bNtp.addEventListener('click', () => run(bNtp, ntpRes, syncClock));

  $('#tools-body').replaceChildren(h('div', { class: 'tools' },
    h('div', { class: 'btns' }, bIp, bGeo, bNtp),
    ipRes, geoRes, ntpRes,
    h('p', { class: 'hint', text: 'IPと地域のボタンを押すと、あなたのIPアドレスが Wolfx Project に送られます。地域は大まかな推定で、位置は保存しません。' })
  ));
  syncClock().then((t) => { ntpRes.textContent = t; }).catch(() => { /* 起動時は無言 */ });
}
async function syncClock() {
  const t0 = Date.now();
  const r = await fetch(API_BASE + 'ntp.json', { cache: 'no-store' });
  const t1 = Date.now();
  if (!r.ok) throw new Error('ntp');
  const d = await r.json();
  let ts = Number(d.timestamp);
  if (!Number.isFinite(ts)) throw new Error('ntp');
  if (ts < 1e12) ts *= 1000;
  S.clockOffset = ts + (t1 - t0) / 2 - t1;
  renderConn();
  return `サーバー時刻 ${d.JST || ''}／この端末との差 ${(S.clockOffset / 1000).toFixed(2)} 秒（補正済み）`;
}

/* ================= 時計・定期更新 ================= */
function tick() {
  $('#chip-clock').textContent = `${fmtJST(now(), false)} JST`;
  const e = S.eew;
  const active = isActive(e);
  if (active) {
    draw();
    const el = $('#eew-elapsed'); if (el) el.textContent = elapsedText(e);
    updateBanner();
  }
  if (active !== tick.was) { renderEEW(); tick.was = active; draw(); }
}
tick.was = false;
setInterval(tick, 250);
setInterval(renderConn, 5000);

/* ================= 起動 ================= */
paintToggles();
renderEEW();
renderList();
renderConn();
renderTools();
connect('eew', handleEEW);
connect('list', handleList);
pull('jma_eew.json', handleEEW);
pull('jma_eqlist.json', handleList);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* 無視 */ }); });
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault(); deferredInstall = ev; $('#btn-install').hidden = false;
});
$('#btn-install').addEventListener('click', async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt(); await deferredInstall.userChoice.catch(() => {});
  deferredInstall = null; $('#btn-install').hidden = true;
});

const dlgAbout = $('#dlg-about');
$('#btn-about').addEventListener('click', () => { if (!dlgAbout.open) dlgAbout.showModal(); });
$('#about-close').addEventListener('click', () => dlgAbout.close());
dlgAbout.addEventListener('click', (ev) => { if (ev.target === dlgAbout) dlgAbout.close(); });
})();
