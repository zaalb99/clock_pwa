'use strict';
/* Clock PWA — World Clock, Alarms, Stopwatch (configurable speed), Timers. */

// ---------------------------------------------------------------- utilities
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const pad = (n, w = 2) => String(n).padStart(w, '0');
const store = {
  get(k, d) { try { const v = localStorage.getItem('clock.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('clock.' + k, JSON.stringify(v)); } catch {} },
};
const uid = () => Math.random().toString(36).slice(2, 10);
const LOCAL_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const IS_12H = (() => {
  try { const hc = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions(); return hc.hour12 ?? /h1[12]/.test(hc.hourCycle); } catch { return true; }
})();

// ------------------------------------------------------------ stopwatch speed
// Priority: ?speed= URL param (also saved) > saved setting > default 1.25
const DEFAULT_SPEED = 1.25;
(function initSpeed() {
  const p = parseFloat(new URLSearchParams(location.search).get('speed'));
  if (isFinite(p) && p > 0) store.set('speed', p);
})();
const getSpeed = () => { const s = store.get('speed', DEFAULT_SPEED); return isFinite(s) && s > 0 ? s : DEFAULT_SPEED; };

// ------------------------------------------------------------ audio
const SOUNDS = ['Radial', 'Radar', 'Beacon', 'Chimes', 'Circuit', 'Constellation', 'Cosmic', 'Crystals', 'Hillside', 'Illuminate', 'Night Owl', 'Opening', 'Playtime', 'Presto', 'Radiate', 'Reflection', 'Ripples', 'Sencha', 'Signal', 'Silk', 'Slow Rise', 'Stargaze', 'Summit', 'Twinkle', 'Uplift', 'Waves'];
let actx = null;
function audio() {
  if (!actx) { const C = window.AudioContext || window.webkitAudioContext; if (C) actx = new C(); }
  if (actx && actx.state === 'suspended') actx.resume();
  return actx;
}
['touchstart', 'pointerdown', 'keydown'].forEach(ev => window.addEventListener(ev, () => audio(), { once: true, passive: true }));

function hashStr(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; }
// Each sound name maps to a deterministic synthesized pattern (original tones).
function soundPattern(name) {
  if (name === 'Radial' || name === 'Radar') return { notes: [[1318, 0], [1318, .09], [1318, .18], [1318, .27]], len: 1.0, type: 'sine', dur: .07 };
  const h = hashStr(name);
  const scale = [523, 587, 659, 784, 880, 988, 1047, 1175, 1319, 1568];
  const n = 3 + (h % 4), step = .12 + ((h >> 3) % 5) * .04, notes = [];
  for (let i = 0; i < n; i++) notes.push([scale[(h >> (i * 3)) % scale.length], i * step]);
  return { notes, len: n * step + .5, type: ['sine', 'triangle', 'square'][h % 3], dur: step * .9 };
}
function playOnce(name, gain = .25) {
  const ctx = audio(); if (!ctx || name === 'None' || name === 'Stop Playing') return 0;
  const p = soundPattern(name), t0 = ctx.currentTime + .02;
  for (const [f, at] of p.notes) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = p.type; o.frequency.value = f;
    g.gain.setValueAtTime(0, t0 + at);
    g.gain.linearRampToValueAtTime(gain * (p.type === 'square' ? .35 : 1), t0 + at + .01);
    g.gain.exponentialRampToValueAtTime(.0001, t0 + at + p.dur);
    o.connect(g).connect(ctx.destination); o.start(t0 + at); o.stop(t0 + at + p.dur + .05);
  }
  return p.len;
}
let ringTimer = null;
function startRinging(name) {
  stopRinging();
  if (name === 'Stop Playing') return;
  const loop = () => { const len = playOnce(name); ringTimer = setTimeout(loop, Math.max(.6, len) * 1000); if (navigator.vibrate) navigator.vibrate(400); };
  loop();
}
function stopRinging() { clearTimeout(ringTimer); ringTimer = null; if (navigator.vibrate) navigator.vibrate(0); }
let previewTimer = null;
function preview(name) { clearTimeout(previewTimer); playOnce(name); }

// ------------------------------------------------------------ notifications
let swReg = null;
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').then(r => (swReg = r)).catch(() => {});
function askNotify() { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {}); }
function notify(title, body) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  const opts = { body, tag: 'clock-' + title, renotify: true, requireInteraction: true, icon: 'icons/icon-192.png' };
  if (swReg) swReg.showNotification(title, opts).catch(() => {}); else try { new Notification(title, opts); } catch {}
}

// ------------------------------------------------------------ tabs
const tabs = document.querySelectorAll('.tabbar button');
function showTab(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.dataset.tab === name));
  tabs.forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  store.set('tab', name);
  if (name === 'stopwatch') swRender(true);
  if (name === 'timer' && typeof tLayout === 'function') tLayout();
}
tabs.forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ------------------------------------------------------------ swipe-to-delete + reorder helpers
function makeSwipeRow(li, content, onDelete) {
  const del = el('button', 'swipe-delete', 'Delete');
  li.append(del, content);
  let sx = 0, sy = 0, dx = 0, open = false, tracking = false, decided = false;
  content.addEventListener('pointerdown', e => {
    if (e.target.closest('.switch,.handle,.minus,.rc-play')) return;
    sx = e.clientX; sy = e.clientY; dx = 0; tracking = true; decided = false;
  });
  content.addEventListener('pointermove', e => {
    if (!tracking) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!decided) { if (Math.abs(mx) < 8 && Math.abs(my) < 8) return; decided = true; if (Math.abs(my) > Math.abs(mx)) { tracking = false; return; } content.setPointerCapture(e.pointerId); }
    dx = Math.min(0, mx + (open ? -90 : 0));
    content.style.transition = 'none'; content.style.transform = `translateX(${dx}px)`;
  });
  const end = () => {
    if (!tracking) return; tracking = false; content.style.transition = '';
    if (!decided) return;
    open = dx < -45; content.style.transform = open ? 'translateX(-90px)' : '';
    content._suppressClick = true; setTimeout(() => (content._suppressClick = false), 50);
  };
  content.addEventListener('pointerup', end); content.addEventListener('pointercancel', end);
  del.addEventListener('click', onDelete);
  li._reveal = () => { open = !open; content.style.transform = open ? 'translateX(-90px)' : ''; };
}
function enableReorder(ul, getArr, save) {
  ul.addEventListener('pointerdown', e => {
    const h = e.target.closest('.handle'); if (!h) return;
    e.preventDefault();
    const li = h.closest('li'), items = [...ul.children], from = items.indexOf(li), hgt = li.offsetHeight, y0 = e.clientY;
    li.classList.add('dragging'); h.setPointerCapture(e.pointerId);
    let to = from;
    const move = ev => {
      const dy = ev.clientY - y0; li.style.transform = `translateY(${dy}px)`;
      to = Math.max(0, Math.min(items.length - 1, from + Math.round(dy / hgt)));
      items.forEach((it, i) => { if (it === li) return; let s = 0; if (from < to && i > from && i <= to) s = -hgt; if (from > to && i < from && i >= to) s = hgt; it.style.transition = 'transform .2s'; it.style.transform = s ? `translateY(${s}px)` : ''; });
    };
    const up = () => {
      h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
      items.forEach(it => { it.style.transform = ''; it.style.transition = ''; }); li.classList.remove('dragging');
      if (to !== from) { const a = getArr(); const [x] = a.splice(from, 1); a.splice(to, 0, x); save(); }
    };
    h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
  });
}

// ------------------------------------------------------------ sheets (iOS 26 style: round glass ✕ / ✓ buttons)
const ICON_X = '<svg viewBox="0 0 16 16"><path d="M2 2l12 12M14 2 2 14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 16 16"><path d="M1.5 8.5 6 13l8.5-10" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 16 16"><path d="M11 1.5 4.5 8l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function openSheet({ title, right, onLeft, onRight, body, push = false, rightText }) {
  const root = $('#sheet-root');
  const bd = push ? null : el('div', 'backdrop');
  const sh = el('div', 'sheet' + (push ? ' push' : ''));
  if (push) sh.style.zIndex = 53 + root.children.length;
  const nav = el('div', 'sheet-nav');
  const lb = el('button', 'pill circle sl', push ? ICON_BACK : ICON_X);
  const tt = el('div', 'snav-title'); tt.textContent = title;
  const rb = right ? el('button', 'pill circle sr confirm', ICON_CHECK) : null;
  if (rightText && rb) { rb.className = 'pill sr'; rb.textContent = rightText; }
  nav.append(lb, tt); if (rb) nav.append(rb);
  const bodyEl = el('div', 'sheet-body'); bodyEl.append(body);
  sh.append(nav, bodyEl);
  if (bd) root.append(bd);
  root.append(sh);
  requestAnimationFrame(() => { bd && bd.classList.add('show'); sh.classList.add('show'); });
  const close = () => { sh.classList.remove('show'); bd && bd.classList.remove('show'); setTimeout(() => { sh.remove(); bd && bd.remove(); }, 350); };
  lb.addEventListener('click', () => { onLeft && onLeft(); close(); });
  rb && rb.addEventListener('click', () => { if (onRight && onRight() === false) return; close(); });
  if (bd) bd.addEventListener('click', () => { onLeft && onLeft(); close(); });
  return { close, sheet: sh, nav, rightBtn: rb };
}
function groupRow(label, valueNode, { tappable, onTap } = {}) {
  const r = el('li', 'row' + (tappable ? ' tappable' : ''));
  r.append(el('span', '', label)); if (valueNode) r.append(valueNode);
  if (onTap) r.addEventListener('click', onTap);
  return r;
}
function switchEl(on, onChange) {
  const s = el('button', 'switch' + (on ? ' on' : '')); s.setAttribute('role', 'switch');
  s.addEventListener('click', e => { e.stopPropagation(); s.classList.toggle('on'); onChange(s.classList.contains('on')); });
  return s;
}
function valueChev(text) { const v = el('span', 'row-value'); const t = el('span', '', text); v.append(t, el('i', 'chev')); v._text = t; return v; }

// ------------------------------------------------------------ drum picker
// A real cylinder: rows sit on a drum of radius R (pt), one row per THETA radians, viewed in
// perspective from distance P. A transparent native scroll view drives each column (momentum +
// snapping for free); the visible digits are a small pool repositioned on every scroll frame.
const DRUM = { R: 88, H: 32, P: 900, C: 104 };          // C = picker centre line (px from top)
DRUM.THETA = DRUM.H / DRUM.R;
class Wheel {
  // anchor: x of the column's alignment edge relative to the picker's horizontal centre
  constructor(picker, values, { loop = false, initial = 0, onChange, anchor = 0, align = 'right', width = 90, label, labelGap = 6.5, fontSize } = {}) {
    Object.assign(this, { picker, values, n: values.length, loop, onChange, anchor, align, last: initial, _initial: initial });
    this.reps = loop ? 41 : 1;
    // driver (invisible, scrollable)
    const left = align === 'right' ? anchor - width + 10 : align === 'left' ? anchor - 10 : anchor - width / 2;
    this.driver = el('div', 'driver');
    this.driver.style.left = `calc(50% + ${left}px)`; this.driver.style.width = (width + (label ? 50 : 0)) + 'px';
    const frag = document.createDocumentFragment();
    frag.append(el('div', 'pad'));
    for (let i = 0; i < this.n * this.reps; i++) frag.append(el('div'));
    frag.append(el('div', 'pad'));
    this.driver.append(frag);
    picker.append(this.driver);
    // visible pool
    this.pool = [];
    for (let k = 0; k < 9; k++) {
      const it = el('div', 'drum-item');
      if (fontSize) it.style.fontSize = fontSize + 'px';
      if (align === 'right') it.style.right = `calc(50% - ${anchor}px)`;
      else if (align === 'left') it.style.left = `calc(50% + ${anchor}px)`;
      else { it.style.left = `calc(50% + ${anchor}px)`; it.style.translate = '-50% 0'; }
      picker.append(it); this.pool.push(it);
    }
    this.cx = align === 'right' ? anchor - 8 : align === 'left' ? anchor + 12 : anchor; // approx. ink centre for perspective
    if (label) {
      const lab = el('div', 'drum-label', label);
      lab.style.left = `calc(50% + ${anchor + labelGap}px)`;
      picker.append(lab);
    }
    let raf = 0, idle = 0;
    this.driver.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.paint(); });
      clearTimeout(idle); idle = setTimeout(() => this.settle(), 130);
    }, { passive: true });
    this.driver.addEventListener('click', e => {
      const r = this.driver.getBoundingClientRect(), dyc = e.clientY - r.top - DRUM.C;
      const steps = Math.round(Math.asin(Math.max(-1, Math.min(1, dyc / DRUM.R))) / DRUM.THETA);
      if (steps) this.driver.scrollBy({ top: steps * DRUM.H, behavior: 'smooth' });
    });
  }
  mount() { this.set(this._initial); return this; }
  base() { return this.loop ? this.n * Math.floor(this.reps / 2) : 0; }
  pos() { return this.driver.scrollTop / DRUM.H; }
  rawIndex() { return Math.round(this.pos()); }
  get index() { return ((this.rawIndex() % this.n) + this.n) % this.n; }
  get value() { return this.values[this.index]; }
  set(i) { this.driver.scrollTop = (this.base() + i) * DRUM.H; this.last = i; this.paint(); }
  settle() {
    if (this.loop) { const r = this.rawIndex(); if (r < this.n * 5 || r > this.n * (this.reps - 5)) this.set(this.index); }
    if (this.index !== this.last) { this.last = this.index; this.onChange && this.onChange(this.index); if (navigator.vibrate) navigator.vibrate(4); }
  }
  paint() {
    const f = this.pos(), c0 = Math.round(f), { R, P, THETA } = DRUM, total = this.n * this.reps;
    this.pool.forEach((it, k) => {
      const idx = c0 + k - 4, d = idx - f, a = d * THETA;
      if (idx < 0 || idx >= total || Math.abs(a) >= Math.PI / 2 - .02) { it.style.visibility = 'hidden'; return; }
      const cos = Math.cos(a), s = P / (P + R * (1 - cos));
      const y = R * Math.sin(a) * s, dx = this.cx * (s - 1);
      it.style.visibility = 'visible';
      const txt = this.values[((idx % this.n) + this.n) % this.n];
      if (it.textContent !== txt) it.textContent = txt;
      it.style.transform = `translate(${dx.toFixed(2)}px, ${y.toFixed(2)}px) scale(${s.toFixed(4)}, ${(s * cos).toFixed(4)})`;
      const w = Math.max(0, 1 - Math.abs(d) * 2);                         // inside the selection bar
      it.style.color = w > 0 ? `rgb(${Math.round(141 + (230 - 141) * w)},${Math.round(141 + (230 - 141) * w)},${Math.round(146 + (231 - 146) * w)})` : '#8d8d92';
      it.style.opacity = w > 0 ? 1 : cos.toFixed(3);
    });
  }
}
function makePicker(container) { container.innerHTML = ''; container.append(el('div', 'picker-bar')); return container; }

// ======================================================================
// WORLD CLOCK
// ======================================================================
const CITIES = [
  ['Abu Dhabi', 'United Arab Emirates', 'Asia/Dubai'], ['Accra', 'Ghana', 'Africa/Accra'], ['Addis Ababa', 'Ethiopia', 'Africa/Addis_Ababa'], ['Adelaide', 'Australia', 'Australia/Adelaide'],
  ['Algiers', 'Algeria', 'Africa/Algiers'], ['Almaty', 'Kazakhstan', 'Asia/Almaty'], ['Amsterdam', 'Netherlands', 'Europe/Amsterdam'], ['Anchorage', 'U.S.A.', 'America/Anchorage'],
  ['Athens', 'Greece', 'Europe/Athens'], ['Atlanta', 'U.S.A.', 'America/New_York'], ['Auckland', 'New Zealand', 'Pacific/Auckland'], ['Austin', 'U.S.A.', 'America/Chicago'],
  ['Baghdad', 'Iraq', 'Asia/Baghdad'], ['Bangkok', 'Thailand', 'Asia/Bangkok'], ['Barcelona', 'Spain', 'Europe/Madrid'], ['Beijing', 'China', 'Asia/Shanghai'],
  ['Beirut', 'Lebanon', 'Asia/Beirut'], ['Belgrade', 'Serbia', 'Europe/Belgrade'], ['Berlin', 'Germany', 'Europe/Berlin'], ['Bogotá', 'Colombia', 'America/Bogota'],
  ['Boston', 'U.S.A.', 'America/New_York'], ['Brisbane', 'Australia', 'Australia/Brisbane'], ['Brussels', 'Belgium', 'Europe/Brussels'], ['Bucharest', 'Romania', 'Europe/Bucharest'],
  ['Budapest', 'Hungary', 'Europe/Budapest'], ['Buenos Aires', 'Argentina', 'America/Argentina/Buenos_Aires'], ['Cairo', 'Egypt', 'Africa/Cairo'], ['Calgary', 'Canada', 'America/Edmonton'],
  ['Cape Town', 'South Africa', 'Africa/Johannesburg'], ['Caracas', 'Venezuela', 'America/Caracas'], ['Casablanca', 'Morocco', 'Africa/Casablanca'], ['Chicago', 'U.S.A.', 'America/Chicago'],
  ['Copenhagen', 'Denmark', 'Europe/Copenhagen'], ['Cupertino', 'U.S.A.', 'America/Los_Angeles'], ['Dallas', 'U.S.A.', 'America/Chicago'], ['Damascus', 'Syria', 'Asia/Damascus'],
  ['Darwin', 'Australia', 'Australia/Darwin'], ['Delhi', 'India', 'Asia/Kolkata'], ['Denver', 'U.S.A.', 'America/Denver'], ['Detroit', 'U.S.A.', 'America/Detroit'],
  ['Dhaka', 'Bangladesh', 'Asia/Dhaka'], ['Doha', 'Qatar', 'Asia/Qatar'], ['Dubai', 'United Arab Emirates', 'Asia/Dubai'], ['Dublin', 'Ireland', 'Europe/Dublin'],
  ['Edinburgh', 'U.K.', 'Europe/London'], ['Frankfurt', 'Germany', 'Europe/Berlin'], ['Geneva', 'Switzerland', 'Europe/Zurich'], ['Guatemala City', 'Guatemala', 'America/Guatemala'],
  ['Halifax', 'Canada', 'America/Halifax'], ['Hanoi', 'Vietnam', 'Asia/Bangkok'], ['Havana', 'Cuba', 'America/Havana'], ['Helsinki', 'Finland', 'Europe/Helsinki'],
  ['Ho Chi Minh City', 'Vietnam', 'Asia/Ho_Chi_Minh'], ['Hong Kong', 'China', 'Asia/Hong_Kong'], ['Honolulu', 'U.S.A.', 'Pacific/Honolulu'], ['Houston', 'U.S.A.', 'America/Chicago'],
  ['Istanbul', 'Türkiye', 'Europe/Istanbul'], ['Jakarta', 'Indonesia', 'Asia/Jakarta'], ['Jerusalem', 'Israel', 'Asia/Jerusalem'], ['Johannesburg', 'South Africa', 'Africa/Johannesburg'],
  ['Kabul', 'Afghanistan', 'Asia/Kabul'], ['Karachi', 'Pakistan', 'Asia/Karachi'], ['Kathmandu', 'Nepal', 'Asia/Kathmandu'], ['Kyiv', 'Ukraine', 'Europe/Kyiv'],
  ['Kolkata', 'India', 'Asia/Kolkata'], ['Kuala Lumpur', 'Malaysia', 'Asia/Kuala_Lumpur'], ['Kuwait City', 'Kuwait', 'Asia/Kuwait'], ['Lagos', 'Nigeria', 'Africa/Lagos'],
  ['Las Vegas', 'U.S.A.', 'America/Los_Angeles'], ['Lima', 'Peru', 'America/Lima'], ['Lisbon', 'Portugal', 'Europe/Lisbon'], ['London', 'U.K.', 'Europe/London'],
  ['Los Angeles', 'U.S.A.', 'America/Los_Angeles'], ['Madrid', 'Spain', 'Europe/Madrid'], ['Manila', 'Philippines', 'Asia/Manila'], ['Melbourne', 'Australia', 'Australia/Melbourne'],
  ['Mexico City', 'Mexico', 'America/Mexico_City'], ['Miami', 'U.S.A.', 'America/New_York'], ['Milan', 'Italy', 'Europe/Rome'], ['Minneapolis', 'U.S.A.', 'America/Chicago'],
  ['Montevideo', 'Uruguay', 'America/Montevideo'], ['Montréal', 'Canada', 'America/Toronto'], ['Moscow', 'Russia', 'Europe/Moscow'], ['Mumbai', 'India', 'Asia/Kolkata'],
  ['Munich', 'Germany', 'Europe/Berlin'], ['Nairobi', 'Kenya', 'Africa/Nairobi'], ['New Orleans', 'U.S.A.', 'America/Chicago'], ['New York', 'U.S.A.', 'America/New_York'],
  ['Oslo', 'Norway', 'Europe/Oslo'], ['Panama City', 'Panama', 'America/Panama'], ['Paris', 'France', 'Europe/Paris'], ['Perth', 'Australia', 'Australia/Perth'],
  ['Philadelphia', 'U.S.A.', 'America/New_York'], ['Phoenix', 'U.S.A.', 'America/Phoenix'], ['Prague', 'Czechia', 'Europe/Prague'], ['Reykjavík', 'Iceland', 'Atlantic/Reykjavik'],
  ['Rio de Janeiro', 'Brazil', 'America/Sao_Paulo'], ['Riyadh', 'Saudi Arabia', 'Asia/Riyadh'], ['Rome', 'Italy', 'Europe/Rome'], ['San Francisco', 'U.S.A.', 'America/Los_Angeles'],
  ['San Juan', 'Puerto Rico', 'America/Puerto_Rico'], ['Santiago', 'Chile', 'America/Santiago'], ['São Paulo', 'Brazil', 'America/Sao_Paulo'], ['Seattle', 'U.S.A.', 'America/Los_Angeles'],
  ['Seoul', 'South Korea', 'Asia/Seoul'], ['Shanghai', 'China', 'Asia/Shanghai'], ['Singapore', 'Singapore', 'Asia/Singapore'], ['St. Louis', 'U.S.A.', 'America/Chicago'],
  ['Stockholm', 'Sweden', 'Europe/Stockholm'], ['Sydney', 'Australia', 'Australia/Sydney'], ['Taipei', 'Taiwan', 'Asia/Taipei'], ['Tehran', 'Iran', 'Asia/Tehran'],
  ['Tel Aviv', 'Israel', 'Asia/Jerusalem'], ['Tokyo', 'Japan', 'Asia/Tokyo'], ['Toronto', 'Canada', 'America/Toronto'], ['Vancouver', 'Canada', 'America/Vancouver'],
  ['Vienna', 'Austria', 'Europe/Vienna'], ['Warsaw', 'Poland', 'Europe/Warsaw'], ['Washington, D.C.', 'U.S.A.', 'America/New_York'], ['Wellington', 'New Zealand', 'Pacific/Auckland'],
  ['Winnipeg', 'Canada', 'America/Winnipeg'], ['Zürich', 'Switzerland', 'Europe/Zurich'],
];
// add any other IANA zones not covered, so every zone is reachable from search
try {
  const have = new Set(CITIES.map(c => c[2]));
  for (const tz of Intl.supportedValuesOf('timeZone')) {
    if (have.has(tz) || !tz.includes('/')) continue;
    const parts = tz.split('/'); CITIES.push([parts[parts.length - 1].replace(/_/g, ' '), parts[0].replace(/_/g, ' '), tz]);
  }
} catch {}
CITIES.sort((a, b) => a[0].localeCompare(b[0]));

const dtfCache = {};
function tzParts(tz, d = new Date()) {
  const f = dtfCache[tz] || (dtfCache[tz] = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }));
  const o = {}; for (const p of f.formatToParts(d)) o[p.type] = +p.value;
  return o;
}
function tzOffsetMin(tz, d = new Date()) { const p = tzParts(tz, d); return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - d.getTime()) / 60000); }
function fmtHM(h, m) {
  if (!IS_12H) return { t: `${pad(h)}:${pad(m)}`, ap: '' };
  return { t: `${h % 12 || 12}:${pad(m)}`, ap: h < 12 ? 'AM' : 'PM' };
}

let cities = store.get('cities', [{ name: 'Cupertino', tz: 'America/Los_Angeles' }]);
let worldEditing = false;
const worldList = $('#world-list');
function saveCities() { store.set('cities', cities); renderWorld(); }
function renderWorld() {
  worldList.innerHTML = '';
  worldList.classList.toggle('editing', worldEditing);
  $('#world-empty').classList.toggle('hidden', cities.length > 0);
  $('#world-edit').classList.toggle('hidden', cities.length === 0 && !worldEditing);
  cities.forEach((c, i) => {
    const li = el('li', 'wc-row');
    const content = el('div', 'row-content');
    const minus = el('button', 'minus');
    const shift = el('div', 'shift', `<div class="t wc-sub"></div><div class="t wc-city"></div>`);
    shift.style.cssText = 'position:absolute;inset:0';
    shift.querySelector('.wc-city').textContent = c.name;
    const time = el('div', 't wc-time');
    content.append(minus, shift, time, el('div', 'handle'));
    makeSwipeRow(li, content, () => { cities.splice(i, 1); saveCities(); });
    minus.addEventListener('click', () => { minus.classList.toggle('rot'); li._reveal(); });
    li._sub = shift.querySelector('.wc-sub'); li._time = time; li._tz = c.tz;
    worldList.append(li);
  });
  tickWorld();
}
function tickWorld() {
  const now = new Date();
  const localOff = -now.getTimezoneOffset();
  const lp = tzParts(LOCAL_TZ, now), localDay = Date.UTC(lp.year, lp.month - 1, lp.day);
  for (const li of worldList.children) {
    const p = tzParts(li._tz, now), diff = tzOffsetMin(li._tz, now) - localOff;
    const dd = Math.round((Date.UTC(p.year, p.month - 1, p.day) - localDay) / 864e5);
    const day = dd === 0 ? 'Today' : dd === 1 ? 'Tomorrow' : dd === -1 ? 'Yesterday' : '';
    const ah = Math.floor(Math.abs(diff) / 60), am = Math.abs(diff) % 60;
    const off = (diff < 0 ? '-' : '+') + ah + (am ? ':' + pad(am) : 'HRS');
    const sub = `${day}, ${off}`;
    if (li._sub.textContent !== sub) li._sub.textContent = sub;
    const { t, ap } = fmtHM(p.hour % 24, p.minute);
    const html = t + (ap ? `<small>${ap}</small>` : '');
    if (li._time.innerHTML !== html) li._time.innerHTML = html;
  }
}
$('#world-edit').addEventListener('click', () => { worldEditing = !worldEditing; $('#world-edit').textContent = worldEditing ? 'Done' : 'Edit'; $('#world-edit').classList.toggle('done', worldEditing); renderWorld(); });
enableReorder(worldList, () => cities, () => saveCities());

$('#world-add').addEventListener('click', () => {
  const body = el('div');
  const wrap = el('div', 'search-wrap');
  const s = el('label', 'search', `<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m15.5 15.5 5 5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg><input type="search" placeholder="Search" autocomplete="off">`);
  wrap.append(s);
  const list = el('ul', 'city-list');
  body.append(list);
  const sh = openSheet({ title: 'Choose a City', body });
  sh.sheet.insertBefore(wrap, sh.sheet.querySelector('.sheet-body'));
  const input = s.querySelector('input');
  const render = () => {
    const q = input.value.trim().toLowerCase();
    list.innerHTML = ''; let letter = '';
    const frag = document.createDocumentFragment();
    for (const [name, country, tz] of CITIES) {
      const label = `${name}, ${country}`;
      if (q && !label.toLowerCase().includes(q)) continue;
      const L = name[0].toUpperCase();
      if (!q && L !== letter) { letter = L; frag.append(el('div', 'city-letter', L)); }
      const li = el('li'); li.textContent = label;
      li.addEventListener('click', () => { cities.push({ name, tz }); saveCities(); sh.close(); });
      frag.append(li);
    }
    list.append(frag);
  };
  input.addEventListener('input', render); render();
});

// ======================================================================
// ALARMS
// ======================================================================
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
let alarms = store.get('alarms', []);
let alarmEditing = false;
const alarmList = $('#alarm-list');
function repeatText(days) {
  if (!days.length) return '';
  const s = [...days].sort().join();
  if (s === '0,1,2,3,4,5,6') return 'every day';
  if (s === '1,2,3,4,5') return 'every weekday';
  if (s === '0,6') return 'every weekend';
  if (days.length === 1) return 'every ' + DAYS[days[0]];
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.filter(d => days.includes(d)).map(d => DAY_SHORT[d]).join(' ');
}
function repeatShort(days) {
  if (!days.length) return 'Never';
  const t = repeatText(days); return t.replace(/^every /, 'Every ').replace(/^(Every )?([a-z])/, (m, a, b) => (a || '') + b.toUpperCase());
}
function saveAlarms() { alarms.sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m)); store.set('alarms', alarms); renderAlarms(); }
function alarmTimeHTML(h, m) { const { t, ap } = fmtHM(h, m); return t + (ap ? `<small>${ap}</small>` : ''); }
function renderAlarms() {
  alarmList.innerHTML = ''; alarmList.classList.toggle('editing', alarmEditing);
  const others = alarms.filter(a => !a.sleep), wake = alarms.find(a => a.sleep);
  $('#other-label').parentElement.classList.toggle('hidden', others.length === 0);
  alarmList.classList.toggle('hidden', others.length === 0);
  const st = $('#sleep-text');
  if (wake) { st.innerHTML = alarmTimeHTML(wake.h, wake.m); st.classList.toggle('on', wake.on); }
  else { st.textContent = 'No Alarm'; st.classList.remove('on'); }
  others.forEach(a => {
    const li = el('li', 'al-row' + (a.on ? '' : ' off'));
    const content = el('div', 'row-content');
    const minus = el('button', 'minus');
    const shift = el('div', 'shift', `<div class="t al-time">${alarmTimeHTML(a.h, a.m)}</div><div class="t al-sub"></div>`);
    shift.style.cssText = 'position:absolute;inset:0';
    const rt = repeatText(a.days);
    shift.querySelector('.al-sub').textContent = (a.label || 'Alarm') + (rt ? ', ' + rt : '');
    const sw = switchEl(a.on, on => { a.on = on; a.snoozeUntil = 0; a.lastFired = minuteKey(); store.set('alarms', alarms); li.classList.toggle('off', !on); if (on) askNotify(); });
    const chev = el('i', 'chev al-chev');
    content.append(minus, shift, sw, chev);
    makeSwipeRow(li, content, () => { alarms = alarms.filter(x => x !== a); saveAlarms(); });
    minus.addEventListener('click', e => { e.stopPropagation(); minus.classList.toggle('rot'); li._reveal(); });
    content.addEventListener('click', e => { if (content._suppressClick || e.target.closest('.switch,.minus')) return; if (alarmEditing) editAlarm(a); });
    alarmList.append(li);
  });
}
$('#alarm-edit').addEventListener('click', () => { alarmEditing = !alarmEditing; $('#alarm-edit').textContent = alarmEditing ? 'Done' : 'Edit'; $('#alarm-edit').classList.toggle('done', alarmEditing); renderAlarms(); });
$('#alarm-add').addEventListener('click', () => editAlarm(null));
$('#sleep-change').addEventListener('click', () => editAlarm(alarms.find(a => a.sleep) || null, true));

function timePicker(container, h, m) {
  makePicker(container);
  const mins = Array.from({ length: 60 }, (_, i) => pad(i));
  let hw, mw, pw;
  if (IS_12H) {
    hw = new Wheel(container, Array.from({ length: 12 }, (_, i) => String(i + 1)), { loop: true, initial: (h % 12 || 12) - 1, anchor: -50, align: 'right', width: 70 });
    mw = new Wheel(container, mins, { loop: true, initial: m, anchor: -24, align: 'left', width: 60 });
    pw = new Wheel(container, ['AM', 'PM'], { initial: h < 12 ? 0 : 1, anchor: 40, align: 'left', width: 70 });
  } else {
    hw = new Wheel(container, Array.from({ length: 24 }, (_, i) => pad(i)), { loop: true, initial: h, anchor: -10, align: 'right', width: 70 });
    mw = new Wheel(container, mins, { loop: true, initial: m, anchor: 10, align: 'left', width: 70 });
  }
  return {
    mount() { hw.mount(); mw.mount(); pw && pw.mount(); },
    get() { let hh = parseInt(hw.value, 10); if (IS_12H) hh = (hh % 12) + (pw.index === 1 ? 12 : 0); return [hh, parseInt(mw.value, 10)]; },
  };
}
function editAlarm(existing, sleep = false) {
  const now = new Date();
  const a = existing ? { ...existing, days: [...existing.days] } : { id: uid(), h: sleep ? 7 : now.getHours(), m: sleep ? 0 : now.getMinutes(), days: sleep ? [0, 1, 2, 3, 4, 5, 6] : [], label: sleep ? 'Wake Up' : 'Alarm', sound: 'Radial', snooze: true, on: true, sleep };
  const body = el('div');
  const pickerEl = el('div', 'picker'); body.append(pickerEl);
  const T = timePicker(pickerEl, a.h, a.m);

  const g = el('ul', 'group');
  const repVal = valueChev(repeatShort(a.days));
  const labelIn = el('input', 'row-input'); labelIn.value = a.label; labelIn.placeholder = 'Alarm'; labelIn.maxLength = 40;
  const soundVal = valueChev(a.sound);
  g.append(
    groupRow('Repeat', repVal, { tappable: true, onTap: () => pickRepeat(a, () => (repVal._text.textContent = repeatShort(a.days))) }),
    groupRow('Label', labelIn),
    groupRow('Sound', soundVal, { tappable: true, onTap: () => pickSound(a.sound, s => { a.sound = s; soundVal._text.textContent = s; }, false) }),
    groupRow('Snooze', switchEl(a.snooze, v => (a.snooze = v))),
  );
  body.append(g);
  if (existing) {
    body.append(el('div', 'group-gap'));
    const dg = el('ul', 'group');
    const del = el('li', 'row danger tappable', sleep ? 'Remove Wake Up Alarm' : 'Delete Alarm');
    dg.append(del); body.append(dg);
    del.addEventListener('click', () => { alarms = alarms.filter(x => x.id !== a.id); saveAlarms(); sh.close(); });
  }
  const sh = openSheet({
    title: sleep ? 'Wake Up' : existing ? 'Edit Alarm' : 'Add Alarm', right: true, body,
    onRight: () => {
      const [h, m] = T.get();
      Object.assign(a, { h, m, label: labelIn.value.trim() || 'Alarm', on: true, snoozeUntil: 0, lastFired: minuteKey() });
      if (existing) Object.assign(existing, a); else alarms.push(a);
      askNotify(); saveAlarms();
    },
  });
  requestAnimationFrame(() => T.mount());
}
function pickRepeat(a, done) {
  const g = el('ul', 'group');
  [0, 1, 2, 3, 4, 5, 6].forEach(d => {
    const ck = el('span', 'check' + (a.days.includes(d) ? ' on' : ''), '✓');
    g.append(groupRow('Every ' + DAYS[d], ck, { tappable: true, onTap: () => { if (a.days.includes(d)) a.days = a.days.filter(x => x !== d); else a.days.push(d); ck.classList.toggle('on'); done(); } }));
  });
  const body = el('div'); body.append(el('div', 'group-gap'), g);
  openSheet({ title: 'Repeat', body, push: true });
}
function pickSound(current, done, isTimer) {
  const body = el('div');
  const g = el('ul', 'group');
  const list = isTimer ? [...SOUNDS, 'Stop Playing'] : [...SOUNDS, 'None'];
  const checks = [];
  body.append(el('div', 'group-title', 'Ringtones'));
  list.forEach(s => {
    const ck = el('span', 'check' + (s === current ? ' on' : ''), '✓'); checks.push(ck);
    const r = el('li', 'row tappable'); r.style.justifyContent = 'flex-start';
    r.append(ck, el('span', '', s)); r.firstChild.style.marginRight = '12px';
    r.addEventListener('click', () => { checks.forEach(c => c.classList.remove('on')); ck.classList.add('on'); current = s; preview(s); if (!isTimer) done(s); });
    g.append(r);
  });
  body.append(g);
  // Timer's sheet is modal with Cancel / Set; the alarm's is a pushed page that applies immediately.
  if (isTimer) openSheet({ title: 'Sound', right: true, body, onRight: () => done(current) });
  else openSheet({ title: 'Sound', body, push: true });
}

// alarm engine
let ringingAlarm = null;
const minuteKey = (now = new Date()) => `${now.getFullYear()}-${now.getMonth()}-${now.getDate()} ${now.getHours()}:${now.getMinutes()}`;
function checkAlarms() {
  const now = new Date(), key = minuteKey(now);
  for (const a of alarms) {
    if (!a.on || ringingAlarm) continue;
    const due = a.snoozeUntil ? Date.now() >= a.snoozeUntil
      : (a.h === now.getHours() && a.m === now.getMinutes() && (!a.days.length || a.days.includes(now.getDay())) && a.lastFired !== key);
    if (!due) continue;
    a.lastFired = key; a.snoozeUntil = 0;
    if (!a.days.length) a.on = false;
    store.set('alarms', alarms); renderAlarms();
    ringAlarm(a);
  }
}
function ringAlarm(a) {
  ringingAlarm = a;
  startRinging(a.sound);
  notify(a.label || 'Alarm', 'Alarm');
  const { t } = fmtHM(new Date().getHours(), new Date().getMinutes());
  const ov = el('div', 'alert', `<div><div class="alert-time">${t}</div><div class="alert-label"></div></div><div class="alert-buttons"></div>`);
  ov.querySelector('.alert-label').textContent = a.label || 'Alarm';
  const btns = ov.querySelector('.alert-buttons');
  if (a.snooze) {
    const sn = el('button', 'alert-btn primary', 'Snooze'); btns.append(sn);
    sn.addEventListener('click', () => { const live = alarms.find(x => x.id === a.id); if (live) { live.on = true; live.snoozeUntil = Date.now() + 9 * 60000; store.set('alarms', alarms); renderAlarms(); } dismiss(); });
  }
  const st = el('button', 'alert-btn', 'Stop'); btns.append(st); st.addEventListener('click', dismiss);
  document.body.append(ov);
  function dismiss() { stopRinging(); ov.remove(); ringingAlarm = null; }
}

// ======================================================================
// STOPWATCH (runs at a configurable multiple of real time)
// ======================================================================
// State in *stopwatch* milliseconds: acc = accumulated before current run; startReal = performance-independent epoch ms of current run start.
let sw = store.get('sw', { running: false, acc: 0, startReal: 0, speed: null, laps: [] });
// laps: array of cumulative stopwatch-ms at each lap press
function swElapsed() { return sw.running ? sw.acc + (Date.now() - sw.startReal) * (sw.speed || getSpeed()) : sw.acc; }
function swSave() { store.set('sw', sw); }
function fmtSW(ms) {
  const cs = Math.floor(ms / 10) % 100, s = Math.floor(ms / 1000) % 60, m = Math.floor(ms / 60000) % 60, h = Math.floor(ms / 3600000);
  return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(s) + '.' + pad(cs);
}
const swLeft = $('#sw-left'), swRight = $('#sw-right'), swDigital = $('#sw-digital'), swLaps = $('#sw-laps');
function swButtons() {
  const L = swLeft.firstChild, R = swRight.firstChild;
  if (sw.running) { R.textContent = 'Stop'; swRight.className = 'round sw-right red'; L.textContent = 'Lap'; swLeft.disabled = false; }
  else { R.textContent = 'Start'; swRight.className = 'round sw-right green'; L.textContent = swElapsed() > 0 ? 'Reset' : 'Lap'; swLeft.disabled = swElapsed() === 0; }
}
swRight.addEventListener('click', () => {
  if (sw.running) { sw.acc = swElapsed(); sw.running = false; }
  else { sw.running = true; sw.startReal = Date.now(); sw.speed = getSpeed(); }
  swSave(); swButtons(); swRenderLaps();
});
swLeft.addEventListener('click', () => {
  if (sw.running) { sw.laps.push(swElapsed()); }
  else { sw = { running: false, acc: 0, startReal: 0, speed: null, laps: [] }; }
  swSave(); swButtons(); swRenderLaps(); swRender(true);
});
let lapCurrentEl = null;
function swRenderLaps() {
  swLaps.innerHTML = ''; lapCurrentEl = null;
  const total = swElapsed();
  if (!sw.laps.length && total === 0) return;
  const splits = sw.laps.map((t, i) => t - (i ? sw.laps[i - 1] : 0));
  let best = -1, worst = -1;
  if (splits.length >= 2) { best = splits.indexOf(Math.min(...splits)); worst = splits.indexOf(Math.max(...splits)); }
  const cur = el('li', '', `<span>Lap ${splits.length + 1}</span><span></span>`);
  lapCurrentEl = cur.lastChild; lapCurrentEl.textContent = fmtSW(total - (sw.laps.at(-1) || 0));
  swLaps.append(cur);
  for (let i = splits.length - 1; i >= 0; i--) {
    swLaps.append(el('li', i === best ? 'best' : i === worst ? 'worst' : '', `<span>Lap ${i + 1}</span><span>${fmtSW(splits[i])}</span>`));
  }
}
// analog face
const svgNS = 'http://www.w3.org/2000/svg';
const analog = $('#sw-analog');
function svg(tag, attrs, parent = analog) { const e = document.createElementNS(svgNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); parent.append(e); return e; }
// Analog face, in 440-wide stage units (iOS scales the stopwatch screen with the device width).
// Geometry measured from a device screenshot: dial centre (220, 229.85), outer radius 152.1.
const AF = { cx: 220, cy: 229.85, R: 152.1, sub: { cx: 220, cy: 175.7 }, gray: '#474749', orange: '#f1994a' };
(function buildAnalog() {
  analog.setAttribute('viewBox', '0 0 440 480');
  const { cx, cy, R } = AF, rad = d => d * Math.PI / 180;
  const ray = (c, deg, r1, r2, stroke, w, parent = analog) => svg('line', {
    x1: (c.cx + Math.sin(rad(deg)) * r1).toFixed(2), y1: (c.cy - Math.cos(rad(deg)) * r1).toFixed(2),
    x2: (c.cx + Math.sin(rad(deg)) * r2).toFixed(2), y2: (c.cy - Math.cos(rad(deg)) * r2).toFixed(2), stroke, 'stroke-width': w }, parent);
  // 240 quarter-second ticks; whole seconds longer; every 5 s white
  for (let i = 0; i < 240; i++) {
    const deg = i * 1.5, sec = i % 4 === 0, five = i % 20 === 0;
    ray(AF, deg, sec ? 139.2 : 145.2, R, five ? '#fff' : AF.gray, five ? 2.1 : 1.7);
  }
  for (let n = 5; n <= 60; n += 5) {
    const deg = n * 6, r = 119, fs = 25.2;
    const t = svg('text', { x: (cx + Math.sin(rad(deg)) * r).toFixed(2), y: (cy - Math.cos(rad(deg)) * r + fs * .705 / 2).toFixed(2), fill: '#fff', 'font-size': fs, 'text-anchor': 'middle' });
    t.textContent = n;
  }
  // 30-minute sub-dial: 60 half-minute ticks, white every 5 minutes, numbers 5..30
  const S = AF.sub;
  for (let i = 0; i < 60; i++) ray(S, i * 6, 34.4, 42.4, i % 10 === 0 ? '#fff' : AF.gray, 1.1);
  for (let n = 5; n <= 30; n += 5) {
    const deg = n * 12, r = 23.5, fs = 12;
    const t = svg('text', { x: (S.cx + Math.sin(rad(deg)) * r).toFixed(2), y: (S.cy - Math.cos(rad(deg)) * r + fs * .705 / 2).toFixed(2), fill: '#fff', 'font-size': fs, 'text-anchor': 'middle' });
    t.textContent = n;
  }
  analog._digits = svg('text', { x: cx, y: 297.2, fill: '#fff', 'font-size': 19.2, 'text-anchor': 'middle', style: 'font-variant-numeric: tabular-nums' });
  // hands
  analog._min = svg('g', {});
  svg('line', { x1: S.cx, y1: S.cy, x2: S.cx, y2: S.cy - 43.6, stroke: AF.orange, 'stroke-width': 2, 'stroke-linecap': 'round' }, analog._min);
  svg('circle', { cx: S.cx, cy: S.cy, r: 3.3, fill: AF.orange });
  const hand = color => {
    const g = svg('g', {});
    svg('line', { x1: cx, y1: cy + 31, x2: cx, y2: cy - 151.7, stroke: color, 'stroke-width': 1.7 }, g);
    svg('circle', { cx, cy, r: 3.2, fill: '#000', stroke: color, 'stroke-width': 2.4 }, g);
    return g;
  };
  analog._lap = hand('#0a84ff');
  analog._sec = hand(AF.orange);
})();
let lastDigital = '';
function swRender(force) {
  const t = swElapsed(), s = fmtSW(t);
  if (s !== lastDigital || force) {
    lastDigital = s; swDigital.textContent = s; swDigital.classList.toggle('hours', t >= 3600000);
    analog._digits.textContent = s;
    if (lapCurrentEl) lapCurrentEl.textContent = fmtSW(t - (sw.laps.at(-1) || 0));
  }
  analog._sec.setAttribute('transform', `rotate(${((t / 1000) % 60 * 6).toFixed(3)} ${AF.cx} ${AF.cy})`);
  analog._min.setAttribute('transform', `rotate(${((t / 60000) % 30 * 12).toFixed(3)} ${AF.sub.cx} ${AF.sub.cy})`);
  analog._lap.style.display = sw.laps.length ? '' : 'none';
  if (sw.laps.length) analog._lap.setAttribute('transform', `rotate(${(((t - sw.laps.at(-1)) / 1000) % 60 * 6).toFixed(3)} ${AF.cx} ${AF.cy})`);
}
$('#sw-pager').addEventListener('scroll', e => { const p = Math.round(e.target.scrollLeft / e.target.clientWidth); $('#dot0').classList.toggle('on', p === 0); $('#dot1').classList.toggle('on', p === 1); }, { passive: true });

// Hidden speed setting: long-press the stopwatch face (digital or analog)
(function speedLongPress() {
  let t = null;
  const start = () => { clearTimeout(t); t = setTimeout(openSpeedSettings, 700); };
  const cancel = () => clearTimeout(t);
  for (const n of [swDigital, analog]) {
    n.addEventListener('pointerdown', start); n.addEventListener('pointerup', cancel); n.addEventListener('pointerleave', cancel); n.addEventListener('pointercancel', cancel);
    n.addEventListener('contextmenu', e => e.preventDefault());
  }
})();
function openSpeedSettings() {
  if (navigator.vibrate) navigator.vibrate(15);
  const body = el('div');
  const g = el('ul', 'group');
  const input = el('input', 'row-input'); input.type = 'number'; input.step = '0.01'; input.min = '0.01'; input.inputMode = 'decimal'; input.value = getSpeed();
  input.style.webkitUserSelect = 'text'; input.style.userSelect = 'text';
  g.append(groupRow('Speed multiplier', input));
  body.append(el('div', 'group-gap'), g);
  const presets = el('div', 'speed-presets');
  [1, 1.1, 1.25, 1.5, 2].forEach(v => {
    const b = el('button', +input.value === v ? 'on' : '', '×' + v);
    b.addEventListener('click', () => { input.value = v; presets.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); });
    presets.append(b);
  });
  body.append(presets);
  body.append(el('p', 'note', 'The stopwatch advances this many seconds for every real second. Default is ×1.25. A change applies from the next Start. You can also set it with <b>?speed=1.25</b> in the URL. Long-press the stopwatch time to open this screen.'));
  openSheet({
    title: 'Stopwatch Speed', right: 'Save', body,
    onRight: () => {
      const v = parseFloat(input.value); if (!(v > 0 && v <= 1000)) { input.style.color = 'var(--red)'; return false; }
      store.set('speed', v);
      if (sw.running) { sw.acc = swElapsed(); sw.startReal = Date.now(); sw.speed = v; swSave(); }
    },
  });
}

// ======================================================================
// TIMER
// ======================================================================
let timer = store.get('timer', { state: 'idle', duration: 0, endAt: 0, remaining: 0, label: '', sound: 'Radial', pick: [0, 15, 0] });
let recents = store.get('recents', []);
const tPicker = makePicker($('#timer-picker'));
const NUMS = n => Array.from({ length: n }, (_, i) => String(i));
// column geometry measured from the device: numbers right-aligned 114/4pt left of / 106pt right of centre, labels 6.5pt after
const hW = new Wheel(tPicker, NUMS(24), { initial: timer.pick[0], onChange: () => syncPick(), anchor: -114, width: 80, label: 'hours' });
const mW = new Wheel(tPicker, NUMS(60), { initial: timer.pick[1], onChange: () => syncPick(), anchor: -4, width: 70, label: 'min' });
const sW = new Wheel(tPicker, NUMS(60), { initial: timer.pick[2], onChange: () => syncPick(), anchor: 106, width: 70, label: 'sec' });
function positionLabels() {}
function syncPick() { timer.pick = [hW.index, mW.index, sW.index]; tSave(); tButtons(); }
const tStart = $('#timer-start'), tCancel = $('#timer-cancel'), ringFg = $('#ring-fg');
const CIRC = 2 * Math.PI * 96; ringFg.style.strokeDasharray = CIRC;
$('#timer-label').value = timer.label;
$('#timer-label').addEventListener('input', e => { timer.label = e.target.value; tSave(); });
$('#timer-sound-name').textContent = timer.sound;
$('#timer-sound-row').addEventListener('click', () => pickSound(timer.sound, s => { timer.sound = s; $('#timer-sound-name').textContent = s; tSave(); }, true));
function tSave() { store.set('timer', timer); }
function tRemaining() { return timer.state === 'running' ? Math.max(0, timer.endAt - Date.now()) : timer.remaining; }
function fmtTimer(ms) {
  const tot = Math.ceil(ms / 1000), h = Math.floor(tot / 3600), m = Math.floor(tot / 60) % 60, s = tot % 60;
  return h ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
function fmtDurationWords(ms) {
  const tot = Math.round(ms / 1000), h = Math.floor(tot / 3600), m = Math.floor(tot / 60) % 60, s = tot % 60, p = [];
  if (h) p.push(h + ' hr'); if (m) p.push(m + ' min'); if (s) p.push(s + ' sec'); return p.join(', ');
}
function startTimer(ms, label) {
  if (ms <= 0) return;
  askNotify();
  timer.duration = ms; timer.endAt = Date.now() + ms; timer.state = 'running';
  if (label != null) { timer.label = label; $('#timer-label').value = label; }
  recents = recents.filter(r => r.ms !== ms); recents.unshift({ ms, label: timer.label }); recents = recents.slice(0, 10); store.set('recents', recents);
  tSave(); tLayout(); renderRecents();
}
tStart.addEventListener('click', () => {
  if (timer.state === 'idle') startTimer(((hW.index * 60 + mW.index) * 60 + sW.index) * 1000);
  else if (timer.state === 'running') { timer.remaining = tRemaining(); timer.state = 'paused'; tSave(); tLayout(); }
  else if (timer.state === 'paused') { timer.endAt = Date.now() + timer.remaining; timer.state = 'running'; tSave(); tLayout(); }
});
tCancel.addEventListener('click', () => { if (timer.state !== 'idle') { timer.state = 'idle'; tSave(); tLayout(); } });
function tButtons() {
  const idle = timer.state === 'idle';
  tCancel.disabled = idle;
  tStart.className = 'round tbtn t-start ' + (timer.state === 'running' ? 'orange' : 'green');
  tStart.disabled = idle && timer.pick.every(v => v === 0);
  tStart.setAttribute('aria-label', idle ? 'Start' : timer.state === 'running' ? 'Pause' : 'Resume');
}
function tLayout() {
  const idle = timer.state === 'idle';
  $('#timer-picker').classList.toggle('hidden', !idle);
  $('#timer-run').classList.toggle('hidden', idle);
  $('#timer-run').classList.toggle('paused', timer.state === 'paused');
  if (idle) requestAnimationFrame(() => { hW.set(timer.pick[0]); mW.set(timer.pick[1]); sW.set(timer.pick[2]); });
  tButtons(); tTick();
}
function tTick() {
  if (timer.state === 'idle') return;
  const rem = tRemaining();
  const s = fmtTimer(rem), r = $('#timer-remaining');
  if (r.textContent !== s) { r.textContent = s; r.classList.toggle('long', rem > 3600000 - 1000); }
  ringFg.style.strokeDashoffset = String(CIRC * (1 - rem / timer.duration));
  const end = new Date(timer.state === 'running' ? timer.endAt : Date.now() + rem);
  const { t, ap } = fmtHM(end.getHours(), end.getMinutes());
  $('#timer-endtime').textContent = t + (ap ? ' ' + ap : '');
  if (timer.state === 'running' && rem <= 0) timerDone();
}
function timerDone() {
  const dur = timer.duration, label = timer.label;
  timer.state = 'idle'; tSave(); tLayout();
  startRinging(timer.sound);
  notify(label || 'Timer', 'Timer done');
  const ov = el('div', 'alert', `<div><div class="alert-time">Timer</div><div class="alert-label"></div></div><div class="alert-buttons"></div>`);
  ov.querySelector('.alert-label').textContent = label || '';
  const btns = ov.querySelector('.alert-buttons');
  const stop = el('button', 'alert-btn primary', 'Stop'), rep = el('button', 'alert-btn', 'Repeat');
  btns.append(stop, rep); document.body.append(ov);
  stop.addEventListener('click', () => { stopRinging(); ov.remove(); });
  rep.addEventListener('click', () => { stopRinging(); ov.remove(); startTimer(dur, label); });
}
let recentsEditing = false;
function renderRecents() {
  const ul = $('#timer-recents'); ul.innerHTML = '';
  ul.classList.toggle('editing', recentsEditing);
  $('#recents-block').classList.toggle('hidden', !recents.length);
  recents.forEach((r, i) => {
    const li = el('li'); const content = el('div', 'row-content');
    const tot = Math.round(r.ms / 1000), h = Math.floor(tot / 3600), m = Math.floor(tot / 60) % 60, s = tot % 60;
    const big = h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    const minus = el('button', 'minus');
    const shift = el('div', 'shift', `<div class="t rc-time">${big}</div><div class="t rc-sub"></div>`);
    shift.style.cssText = 'position:absolute;inset:0';
    shift.querySelector('.rc-sub').textContent = r.label || fmtDurationWords(r.ms);
    const play = el('button', 'rc-play', '<svg viewBox="0 0 20 23"><path fill="currentColor" d="M2.6 1.2 18.6 10a1.7 1.7 0 0 1 0 3L2.6 21.8A1.7 1.7 0 0 1 0 20.3V2.7a1.7 1.7 0 0 1 2.6-1.5Z"/></svg>');
    play.addEventListener('click', () => startTimer(r.ms, r.label || ''));
    content.append(minus, shift, play);
    makeSwipeRow(li, content, () => { recents.splice(i, 1); store.set('recents', recents); renderRecents(); });
    minus.addEventListener('click', e => { e.stopPropagation(); minus.classList.toggle('rot'); li._reveal(); });
    ul.append(li);
  });
}
$('#timer-edit').addEventListener('click', () => { recentsEditing = !recentsEditing; $('#timer-edit').textContent = recentsEditing ? 'Done' : 'Edit'; $('#timer-edit').classList.toggle('done', recentsEditing); renderRecents(); });

// ======================================================================
// main loop & boot
// ======================================================================
renderWorld(); renderAlarms(); swButtons(); swRenderLaps(); renderRecents();
showTab(store.get('tab', 'stopwatch'));
requestAnimationFrame(() => { [hW, mW, sW].forEach(w => w.mount()); tLayout(); });

function frame() {
  if ($('#view-stopwatch').classList.contains('active') && sw.running) swRender();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => { tickWorld(); tTick(); checkAlarms(); }, 250);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tickWorld(); tTick(); checkAlarms(); swRender(true); } });
