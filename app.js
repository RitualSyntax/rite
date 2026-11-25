'use strict';
// rite - daily planner. tasks in indexeddb, peeks at grimoire + tithe, reminders via the google script

const DEFAULTS = {
  email: '', hour: 7, calendar: true,
  scriptUrl: '', scriptToken: '',
  lists: ['Home', 'Work', 'Life'],
  lastSync: 0, showCal: true
};
const S = { settings: { ...DEFAULTS }, tasks: [], events: { at: 0, list: [] } };

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T12:00'); d.setDate(d.getDate() + n); return iso(d); };
const dow = s => new Date(s + 'T12:00').getDay();
const nowHM = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const GBP = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const DOWS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function niceDate(s) {
  if (!s) return '';
  const t = today();
  if (s === t) return 'Today';
  if (s === addDays(t, 1)) return 'Tomorrow';
  if (s === addDays(t, -1)) return 'Yesterday';
  const d = new Date(s + 'T12:00');
  const diff = (d - new Date(t + 'T12:00')) / 864e5;
  if (diff > 0 && diff < 7) return d.toLocaleDateString('en-GB', { weekday: 'long' });
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(s.slice(0, 4) !== t.slice(0, 4) ? { year: 'numeric' } : {}) });
}
const fmt12 = hm => { if (!hm) return ''; const [h, m] = hm.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + pad(m) : ''}${h < 12 ? 'am' : 'pm'}`; };

function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), ms);
}
let undoFn = null;
function undoBar(msg, fn) {
  undoFn = fn;
  $('#undoMsg').textContent = msg; $('#undo').hidden = false;
  $('#toast').classList.remove('on'); document.body.classList.add('undoing');
  clearTimeout(undoBar.t); undoBar.t = setTimeout(() => { $('#undo').hidden = true; undoFn = null; document.body.classList.remove('undoing'); }, 5000);
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// 9x9 pixel icons
const PX = {
  today: ['..#####..', '.#.....#.', '#...#...#', '#...#...#', '#...###.#', '#.......#', '#.......#', '.#.....#.', '..#####..'],
  upcoming: ['.#.....#.', '#########', '#.......#', '#.##.##.#', '#.......#', '#.##.##.#', '#.......#', '#.##....#', '#########'],
  lists: ['.........', '##.######', '.........', '##.######', '.........', '##.######', '.........', '##.####..', '.........'],
  gear: ['...#.#...', '.#.###.#.', '..#####..', '.###.###.', '..##.##..', '.###.###.', '..#####..', '.#.###.#.', '...#.#...']
};
const pix = n => `<svg class="px" viewBox="0 0 9 9" shape-rendering="crispEdges">${PX[n].map((row, y) =>
  [...row].map((c, x) => c === '#' ? `<rect x="${x}" y="${y}" width="1" height="1" fill="currentColor"/>` : '').join('')).join('')}</svg>`;

// ---------- db ----------
const db = {
  open() {
    return this.p = this.p || new Promise((res, rej) => {
      const r = indexedDB.open('rite', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  },
  async req(mode, fn) {
    const d = await this.open();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode), q = fn(t.objectStore('kv'));
      t.oncomplete = () => res(q && q.result);
      t.onerror = () => rej(t.error);
    });
  },
  get: k => db.req('readonly', o => o.get(k)),
  put: (k, v) => db.req('readwrite', o => o.put(v, k))
};
const save = k => db.put(k, S[k]).catch(e => toast('Save failed: ' + e.message, 5000));
function saveTasks() { save('tasks'); queueSync(); }

// peek at another app's kv store. only open dbs that exist or we'd make a blank one
async function peek(name, keys) {
  try {
    if (!indexedDB.databases || !(await indexedDB.databases()).some(d => d.name === name)) return null;
    const d = await new Promise((res, rej) => { const r = indexedDB.open(name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    if (!d.objectStoreNames.contains('kv')) { d.close(); return null; }
    const out = {};
    for (const k of keys) out[k] = await new Promise(res => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); });
    d.close();
    return out;
  } catch (e) { return null; }
}

// ---------- repeats ----------
// rep: {u:'day'|'week'|'month', n, days:[0-6], dom}
function nextAfter(rep, from, anchor) {
  if (rep.u === 'day') return addDays(from, rep.n || 1);
  if (rep.u === 'week') {
    const days = rep.days && rep.days.length ? rep.days : [dow(anchor || from)];
    let d = addDays(from, 1);
    for (let i = 0; i < 14; i++) { if (days.includes(dow(d))) return d; d = addDays(d, 1); }
    return addDays(from, 7);
  }
  if (rep.u === 'month') {
    const dom = rep.dom || +(anchor || from).slice(8);
    let [y, m] = from.split('-').map(Number);
    for (let i = 0; i < 24; i++) {
      const last = new Date(y, m, 0).getDate();
      const c = `${y}-${pad(m)}-${pad(Math.min(dom, last))}`;
      if (c > from) return c;
      if (++m > 12) { m = 1; y++; }
    }
  }
  return addDays(from, 1);
}
// first occurrence on or after a day
const firstFrom = (rep, d) => nextAfter(rep, addDays(d, -1), d);

function repText(rep) {
  if (!rep) return '';
  if (rep.u === 'day') return rep.n > 1 ? (rep.n % 7 === 0 ? `Every ${rep.n / 7} weeks` : `Every ${rep.n} days`) : 'Daily';
  if (rep.u === 'week') {
    const d = (rep.days || []).slice().sort();
    if (d.join() === '1,2,3,4,5') return 'Weekdays';
    if (d.join() === '0,6') return 'Weekends';
    if (d.length === 7) return 'Daily';
    return d.length ? 'Every ' + d.map(x => DOW_NAMES[x]).join(', ') : 'Weekly';
  }
  if (rep.u === 'month') return 'Monthly';
  return '';
}

function streak(t) {
  if (!t.rep || !t.log || !t.log.length) return 0;
  const done = new Set(t.log);
  // walk back over the days it was due
  let n = 0, d = done.has(today()) ? today() : addDays(today(), -1);
  for (let i = 0; i < 400; i++) {
    if (t.rep.u === 'week' && t.rep.days && t.rep.days.length && !t.rep.days.includes(dow(d))) { d = addDays(d, -1); continue; }
    if (t.rep.u !== 'day' && t.rep.u !== 'week') break;
    if (t.rep.u === 'day' && (t.rep.n || 1) > 1) break;
    if (!done.has(d)) break;
    n++; d = addDays(d, -1);
  }
  return n;
}

// ---------- quick add ----------
const DOW_RE = '(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?';
const dowIdx = w => DOWS.indexOf(w.toLowerCase().slice(0, 3));
const monIdx = w => MONS.indexOf(w.toLowerCase().slice(0, 3));
function nextDow(d, incToday) { let x = incToday ? today() : addDays(today(), 1); for (let i = 0; i < 7; i++) { if (dow(x) === d) return x; x = addDays(x, 1); } return x; }

function parseQuick(raw) {
  let s = ' ' + raw.trim() + ' ';
  const out = { title: '', due: null, time: '', rep: null, list: null, star: false, bits: [] };
  const cut = re => { const m = s.match(re); if (m) s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length); return m; };
  let m;

  if ((m = cut(/\s#([\w-]+)(?=\s)/))) {
    const want = m[1].toLowerCase();
    out.list = ['Inbox', ...S.settings.lists].find(l => l.toLowerCase() === want) || m[1].charAt(0).toUpperCase() + m[1].slice(1);
  }
  if (cut(/\s!+(?=\s)/)) out.star = true;

  // repeats
  if ((m = cut(new RegExp(`\\s(?:every\\s+((?:${DOW_RE})(?:(?:\\s*(?:,|and|&)\\s*|\\s+)(?:${DOW_RE}))*))(?=\\s)`, 'i')))) {
    const days = [...m[1].matchAll(new RegExp(DOW_RE, 'gi'))].map(x => dowIdx(x[0]));
    out.rep = { u: 'week', days: [...new Set(days)] };
  } else if ((m = cut(/\s(?:every\s+(other\s+)?(day|weekday|week|month|fortnight)|every\s+(\d+)\s+(days?|weeks?|months?)|(daily|weekly|monthly|fortnightly)|(?:on\s+)?(weekdays|weekends))(?=\s)/i))) {
    const w = (m[2] || m[4] || m[5] || m[6] || '').toLowerCase(), n = +m[3] || (m[1] ? 2 : 1);
    if (/^weekday/.test(w)) out.rep = { u: 'week', days: [1, 2, 3, 4, 5] };
    else if (/^weekend/.test(w)) out.rep = { u: 'week', days: [0, 6] };
    else if (/^(day|daily)/.test(w)) out.rep = { u: 'day', n };
    else if (/fortnight/.test(w)) out.rep = { u: 'day', n: 14 };
    else if (/^week/.test(w)) out.rep = n > 1 ? { u: 'day', n: n * 7 } : { u: 'week', days: [] };
    else if (/^month/.test(w)) out.rep = { u: 'month' };
  }

  // time
  if ((m = cut(/\s(?:at\s+|@\s*)?(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)(?=\s)/i))) {
    let h = +m[1] % 12; if (m[3].toLowerCase() === 'pm') h += 12;
    out.time = `${pad(h)}:${m[2] || '00'}`;
  } else if ((m = cut(/\s(?:at\s+|@\s*)?([01]?\d|2[0-3])[:.]([0-5]\d)(?=\s)/))) out.time = `${pad(+m[1])}:${m[2]}`;
  else if ((m = cut(/\s(?:at\s+)?(noon|midday)(?=\s)/i))) out.time = '12:00';
  else if ((m = cut(/\s(?:this|in the)\s+(morning|afternoon|evening)(?=\s)/i))) out.time = { morning: '09:00', afternoon: '14:00', evening: '18:00' }[m[1].toLowerCase()];

  // dates
  const t = today();
  if ((m = cut(/\s(?:by\s+|on\s+)?(today|tonight|tod)(?=\s)/i))) { out.due = t; if (/tonight/i.test(m[1]) && !out.time) out.time = '19:00'; }
  else if ((m = cut(/\s(?:by\s+|on\s+)?(tomorrow|tmrw|tmr|tomoz)(?=\s)/i))) out.due = addDays(t, 1);
  else if ((m = cut(/\sin\s+(\d+)\s+(days?|weeks?)(?=\s)/i))) out.due = addDays(t, +m[1] * (/^w/i.test(m[2]) ? 7 : 1));
  else if ((m = cut(/\s(?:by\s+)?next\s+week(?=\s)/i))) out.due = nextDow(1);
  else if ((m = cut(/\s(?:by\s+|at\s+)?(?:this\s+|the\s+)?weekend(?=\s)/i))) out.due = nextDow(6, true);
  else if ((m = cut(new RegExp(`\\s(?:by\\s+|on\\s+)?(?:(next|this)\\s+)?${DOW_RE}(?=\\s)`, 'i')))) out.due = nextDow(dowIdx(m[2]), m[1] && m[1].toLowerCase() === 'this');
  else if ((m = cut(/\s(?:by\s+|on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*(?:\s+(\d{4}))?(?=\s)/i)) ||
           (m = cut(/\s(?:by\s+|on\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s+(\d{4}))?(?=\s)/i))) {
    const a = isNaN(+m[1]) ? [m[2], m[1], m[3]] : [m[1], m[2], m[3]];
    let y = +a[2] || +t.slice(0, 4);
    let d = `${y}-${pad(monIdx(a[1]) + 1)}-${pad(+a[0])}`;
    if (!a[2] && d < t) d = `${y + 1}-${d.slice(5)}`;
    out.due = d;
  } else if ((m = cut(/\s(?:by\s+|on\s+)?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?=\s)/))) {
    let y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : +t.slice(0, 4);
    let d = `${y}-${pad(+m[2])}-${pad(+m[1])}`;
    if (!m[3] && d < t) d = `${y + 1}-${d.slice(5)}`;
    out.due = d;
  } else if ((m = cut(/\s(?:by\s+|on\s+)the\s+(\d{1,2})(?:st|nd|rd|th)(?=\s)/i))) {
    let [y, mo] = t.split('-').map(Number);
    let d = `${y}-${pad(mo)}-${pad(+m[1])}`;
    if (d < t) { if (++mo > 12) { mo = 1; y++; } d = `${y}-${pad(mo)}-${pad(+m[1])}`; }
    out.due = d;
    if (out.rep && out.rep.u === 'month') out.rep.dom = +m[1];
  }

  // fill gaps
  if (out.rep && !out.due) out.due = firstFrom(out.rep, t);
  else if (out.rep && out.rep.u === 'week' && out.rep.days.length && !out.rep.days.includes(dow(out.due))) out.due = firstFrom(out.rep, out.due);
  if (out.rep && out.rep.u === 'week' && !out.rep.days.length) out.rep.days = [dow(out.due)];
  if (out.time && !out.due) out.due = out.time > nowHM() ? t : addDays(t, 1);

  out.title = s.replace(/\s+/g, ' ').trim().replace(/\s+(on|at|by|for|every|@)$/i, '').replace(/^(on|at|by)\s+/i, '').trim();
  if (out.due) out.bits.push(niceDate(out.due));
  if (out.time) out.bits.push(fmt12(out.time));
  if (out.rep) out.bits.push('↻ ' + repText(out.rep));
  if (out.list) out.bits.push('#' + out.list);
  if (out.star) out.bits.push('★');
  return out;
}

// ---------- task helpers ----------
const open = () => S.tasks.filter(t => !t.done);
const sortTasks = a => a.sort((x, y) => (x.due || '9999').localeCompare(y.due || '9999') || (x.time || '99').localeCompare(y.time || '99') || (y.star ? 1 : 0) - (x.star ? 1 : 0) || x.created - y.created);

function complete(t) {
  const before = JSON.parse(JSON.stringify(t));
  if (t.rep) {
    const td = today();
    t.log = [...new Set([...(t.log || []), td])].slice(-120);
    const base = t.due && t.due > td ? t.due : td;
    t.due = nextAfter(t.rep, base, t.due || td);
    undoBar(`Done · next ${niceDate(t.due)}`, () => Object.assign(t, before));
  } else {
    t.done = true; t.doneAt = Date.now();
    undoBar('Done', () => { Object.assign(t, before); delete t.doneAt; });
  }
  if (navigator.vibrate) navigator.vibrate(20);
  saveTasks(); render();
}

function taskRow(t, opts = {}) {
  const td = today(), late = t.due && t.due < td && !t.done;
  const st = streak(t);
  const meta = [
    opts.noDate || !t.due ? '' : `<span class="${late ? 'late' : ''}">${niceDate(t.due)}</span>`,
    opts.showTime && t.time ? fmt12(t.time) : '',
    t.rep ? `↻ ${repText(t.rep)}` : '',
    st > 1 ? `<span class="streak">${st} in a row</span>` : '',
    t.list && !opts.noList ? '#' + esc(t.list) : '',
    t.notes ? '✎' : ''
  ].filter(Boolean);
  return `<div class="tk ${t.star ? 'star' : ''} ${t.done ? 'done' : ''}" data-act="openTask" data-id="${t.id}">
    <span class="box" data-act="tick" data-id="${t.id}">${t.done ? '✓' : ''}</span>
    <div class="tb"><div class="tt">${t.star ? '<span class="red">★</span> ' : ''}${esc(t.title)}</div>${meta.length ? `<div class="tm">${meta.join('')}</div>` : ''}</div>
    ${!opts.showTime && t.time ? `<span class="time">${fmt12(t.time)}</span>` : ''}
  </div>`;
}

// ---------- other apps ----------
let feed = null;
async function loadFeed() {
  const td = today(), out = { meals: [], owed: null, due: [] };
  const g = await peek('grimoire', ['plan', 'recipes']);
  if (g && g.plan) {
    const rs = g.recipes || [];
    out.meals = (g.plan[td] || []).map(e => ({ meal: e.meal, title: (rs.find(r => r.id === e.rid) || {}).title || 'Something' }));
    out.grimoire = true;
  }
  const ti = await peek('tithe', ['invoices', 'clients']);
  if (ti && ti.invoices) {
    const tot = i => (i.items || []).reduce((a, l) => a + (+l.qty || 0) * (+l.rate || 0), 0) * (1 + (+i.vatRate || 0) / 100);
    const sent = ti.invoices.filter(i => i.status === 'sent');
    const over = sent.filter(i => i.due < td);
    out.owed = { n: sent.length, amt: sent.reduce((a, i) => a + tot(i), 0), over: over.length, overAmt: over.reduce((a, i) => a + tot(i), 0) };
    out.drafts = ti.invoices.filter(i => i.status === 'draft').length;
    out.tithe = true;
  }
  feed = out;
  if (tab === 'today') render();
}
const MEAL_ORDER = ['Breakfast', 'Lunch', 'Dinner', 'Snacks'];

// ---------- google calendar (read only) ----------
function eventsOn(d) {
  if (!S.settings.showCal) return [];
  return (S.events.list || []).filter(e => {
    const sd = e.s.slice(0, 10), ed = e.e.slice(0, 10);
    if (e.all) return sd <= d && d < ed;
    return sd === d || (sd < d && (ed > d || (ed === d && e.e.slice(11) > '00:00')));
  });
}
function evRow(e, d) {
  const sd = e.s.slice(0, 10), ed = e.e.slice(0, 10);
  const when = e.all ? 'All day' : sd < d ? (ed === d ? 'Until ' + fmt12(e.e.slice(11)) : 'All day') : fmt12(e.s.slice(11)) + (ed === d ? '–' + fmt12(e.e.slice(11)) : '');
  const [y, m, dd] = d.split('-').map(Number);
  return `<a class="ev" href="https://calendar.google.com/calendar/r/day/${y}/${m}/${dd}" target="_blank" rel="noopener">
    <span class="dot" style="background:${esc(e.col || '#8a8a8a')}"></span>
    <div class="tb"><div class="tt">${esc(e.t)}</div><div class="tm">${[esc(when), e.loc ? esc(e.loc) : '', esc(e.cal)].filter(Boolean).join(' · ')}</div></div></a>`;
}
async function fetchEvents(loud) {
  if (!S.settings.showCal) return;
  const sc = await script(); if (!sc) return;
  try {
    const j = await (await fetch(sc.url, { method: 'POST', body: JSON.stringify({ token: sc.token, riteEvents: 14 }) })).json();
    if (!j.ok || !j.events) throw new Error(j.error || 'needs update');
    S.events = { at: Date.now(), list: j.events }; save('events'); render(); refreshList();
  } catch (e) { if (loud) toast(/email|pdf|update/i.test(e.message) ? 'Your script needs the latest update to show your calendar' : 'Calendar failed: ' + e.message, 5000); }
}

// ---------- views ----------
let tab = 'today', showDone = false;
const TABS = [['today', 'Today'], ['upcoming', 'Upcoming'], ['lists', 'Lists']];

function render() {
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${tab === k ? 'on' : ''}">${pix(k)}${l}</button>`).join('');
  const q = $('#app #qa'), keep = q && document.activeElement === q ? { v: q.value } : null;
  $('#app').innerHTML = VIEWS[tab]();
  if (keep && $('#app #qa')) { $('#app #qa').value = keep.v; $('#app #qa').focus(); drawPrev(); }
}

const quickAdd = ph => `<div class="qa"><input id="qa" placeholder="${ph}" enterkeyhint="done" autocomplete="off">
  <div class="prev" id="qaPrev"></div></div>`;

const VIEWS = {
  today() {
    const td = today(), d = new Date();
    const over = sortTasks(open().filter(t => t.due && t.due < td));
    const now = sortTasks(open().filter(t => t.due === td));
    const doneToday = S.tasks.filter(t => (t.done && t.doneAt && iso(new Date(t.doneAt)) === td) || (t.rep && (t.log || []).includes(td) && t.due !== td));
    const f = feed;
    const feedRows = [];
    if (f) {
      if (f.grimoire) feedRows.push(`<a class="feed" href="../grimoire/" target="_blank"><span class="lab">Food</span><span class="val">${f.meals.length ? f.meals.sort((a, b) => MEAL_ORDER.indexOf(a.meal) - MEAL_ORDER.indexOf(b.meal)).map(m => `${m.meal}: <b>${esc(m.title)}</b>`).join('<br>') : '<span class="muted">Nothing planned in Grimoire</span>'}</span><span class="go">›</span></a>`);
      if (f.tithe) feedRows.push(`<a class="feed" href="../tithe/" target="_blank"><span class="lab">Money</span><span class="val">${f.owed.n ? `${GBP.format(f.owed.amt)} owed${f.owed.over ? ` · <b class="red">${f.owed.over} overdue</b>` : ''}` : '<span class="muted">Nothing owed</span>'}${f.drafts ? `<br><span class="muted">${f.drafts} draft${f.drafts === 1 ? '' : 's'} to finish</span>` : ''}</span><span class="go">›</span></a>`);
    }
    feedRows.push(`<a class="feed" href="intent://open#Intent;scheme=forge;package=com.ritualsyntax.forge;end"><span class="lab">Training</span><span class="val">Open Forge</span><span class="go">›</span></a>`);
    return `
      <div class="today-h"><div class="big">${d.toLocaleDateString('en-GB', { weekday: 'long' })}</div>
        <div class="mono muted">${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}${now.length ? ` · ${now.length} to do` : ''}${eventsOn(td).length ? ` · ${eventsOn(td).length} in calendar` : ''}</div></div>
      ${quickAdd('Add a task… e.g. bins every tue 8pm')}
      ${over.length ? `<div class="card"><h3>Overdue</h3>${over.map(t => taskRow(t)).join('')}</div>` : ''}
      ${eventsOn(td).length ? `<div class="card"><h3>Calendar</h3>${eventsOn(td).map(e => evRow(e, td)).join('')}</div>` : ''}
      <div class="card"><h3>Today</h3>
        ${now.length ? now.map(t => taskRow(t, { noDate: true })).join('') : `<div class="empty">${over.length ? 'Nothing else today.' : 'Clear. Add something above, or enjoy it.'}</div>`}
        ${doneToday.length ? `<button class="more" data-act="toggleDone">${showDone ? 'Hide' : 'Show'} ${doneToday.length} done</button>${showDone ? doneToday.map(t => taskRow({ ...t, done: true }, { noDate: true })).join('') : ''}` : ''}
      </div>
      <div class="card"><h3>From your apps</h3>${feedRows.join('')}</div>`;
  },

  upcoming() {
    const td = today(), days = Array.from({ length: 14 }, (_, i) => addDays(td, i));
    const o = open();
    const later = o.filter(t => t.due && t.due > days[13]);
    const nodate = o.filter(t => !t.due);
    // repeating ones also show their future hits in the next 2 weeks
    const on = d => sortTasks(o.filter(t => {
      if (t.due === d) return true;
      if (!t.rep || !t.due || t.due >= d) return false;
      let x = t.due;
      for (let i = 0; i < 20 && x < d; i++) x = nextAfter(t.rep, x, t.due);
      return x === d;
    }));
    const over = o.filter(t => t.due && t.due < td);
    return `
      ${quickAdd('Add a task…')}
      ${over.length ? `<div class="dayh">Overdue</div><div class="card" style="margin-top:4px">${sortTasks(over).map(t => taskRow(t)).join('')}</div>` : ''}
      ${days.map(d => { const ts = on(d), es = eventsOn(d); return ts.length || es.length ? `<div class="dayh ${d === td ? 'today' : ''}">${niceDate(d)}${d === td || d === addDays(td, 1) ? ' · ' + new Date(d + 'T12:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }) : ''}</div>
        <div class="card" style="margin-top:4px">${es.map(e => evRow(e, d)).join('')}${ts.map(t => taskRow(t.due === d ? t : { ...t, _ghost: 1 }, { noDate: true })).join('')}</div>` : ''; }).join('') || '<div class="card"><div class="empty">Nothing in the next two weeks.</div></div>'}
      ${later.length ? `<div class="dayh">Later</div><div class="card" style="margin-top:4px">${sortTasks(later).map(t => taskRow(t)).join('')}</div>` : ''}
      ${nodate.length ? `<div class="dayh">No date</div><div class="card" style="margin-top:4px">${sortTasks(nodate).map(t => taskRow(t)).join('')}</div>` : ''}`;
  },

  lists() {
    const o = open(), names = ['Inbox', ...S.settings.lists];
    const count = l => o.filter(t => (t.list || 'Inbox') === l).length;
    const stray = [...new Set(o.map(t => t.list).filter(l => l && !names.includes(l)))];
    return `
      ${quickAdd('Add a task… use #list to file it')}
      <div class="card">${[...names, ...stray].map(l => `<div class="lst" data-act="openList" data-l="${esc(l)}"><span>${esc(l)}</span><span class="n">${count(l)}</span></div>`).join('')}</div>
      <div class="actions"><button class="btn ghost" data-act="newList">+ New list</button></div>
      <div class="card"><h3>Habits & repeats</h3>${sortTasks(o.filter(t => t.rep)).map(t => taskRow(t)).join('') || '<div class="empty">Nothing repeating yet. Try "gym every mon wed thu" or "bins every tue".</div>'}</div>`;
  }
};

const qaEl = () => (!$('#sheet').hidden && $('#sheet #qa')) || $('#app #qa');
function drawPrev() {
  const inp = qaEl(); if (!inp) return;
  const el = inp.parentNode.querySelector('.prev');
  const v = inp.value.trim();
  if (!v) { el.innerHTML = ''; return; }
  const p = parseQuick(v);
  el.innerHTML = p.bits.map(b => `<span>${esc(b)}</span>`).join('');
}

function addQuick(listDefault) {
  const inp = qaEl(); if (!inp) return;
  const v = inp.value.trim(); if (!v) return;
  const p = parseQuick(v);
  if (!p.title) { toast('What is it?'); return; }
  if (p.list && p.list !== 'Inbox' && !S.settings.lists.includes(p.list)) { S.settings.lists.push(p.list); save('settings'); }
  const def = tab === 'today' && !listDefault && $('#sheet').hidden ? today() : null;
  S.tasks.push({ id: uid(), title: p.title, notes: '', list: p.list || listDefault || null, due: p.due || def, time: p.time, rep: p.rep, star: p.star, done: false, created: Date.now() });
  saveTasks();
  inp.value = ''; render(); const again = qaEl(); if (again) again.focus();
  toast(p.bits.length ? 'Added · ' + p.bits.join(' · ') : 'Added');
}

// ---------- sheets ----------
let sheetBack = null;
function openSheet(html, mount, back) {
  const el = $('#sheet');
  delete el.dataset.list;
  el.innerHTML = `<div class="sheet-bg" data-act="closeSheet"></div><div class="sheet-inner">${html}</div>`;
  el.hidden = false; document.body.classList.add('locked');
  sheetBack = back || null;
  if (mount) mount(el);
}
function closeSheet(done) {
  const cb = sheetBack; sheetBack = null;
  $('#sheet').hidden = true; $('#sheet').innerHTML = ''; delete $('#sheet').dataset.list;
  document.body.classList.remove('locked');
  if (!done && cb) cb();
}
const head = (title, extra = '') => `<div class="sheet-head"><h2>${title}</h2>${extra}<button class="x" data-act="closeSheet">✕</button></div>`;
function ask(msg, yes = 'Yes') {
  return new Promise(res => {
    const el = $('#dialog');
    el.innerHTML = `<div class="dlg"><p>${esc(msg)}</p><div class="row">
      <button class="btn ghost" id="dNo">Cancel</button><button class="btn solid" id="dYes">${esc(yes)}</button></div></div>`;
    el.hidden = false;
    $('#dNo').onclick = () => { el.hidden = true; res(false); };
    $('#dYes').onclick = () => { el.hidden = true; res(true); };
  });
}

// task editor
let ct = null, ctDays = [];
function taskSheet(id, back) {
  const t = S.tasks.find(x => x.id === id); if (!t) return;
  ct = t;
  const rep = t.rep;
  const kind = !rep ? 'none' : rep.u === 'day' ? (rep.n > 1 ? 'every' : 'daily') : rep.u === 'month' ? 'monthly' : 'weekly';
  ctDays = rep && rep.u === 'week' ? [...(rep.days || [])] : [];
  const st = streak(t);
  openSheet(`
    ${head(t.rep ? 'Repeating task' : 'Task')}
    <label>Task<input id="tTitle" value="${esc(t.title)}"></label>
    <div class="grid2">
      <label>Date<input id="tDue" type="date" value="${t.due || ''}"></label>
      <label>Time<input id="tTime" type="time" value="${t.time || ''}"></label>
    </div>
    <div class="grid2">
      <label>Repeat<select id="tRep">
        ${[['none', 'Never'], ['daily', 'Daily'], ['weekly', 'Weekly on…'], ['monthly', 'Monthly'], ['every', 'Every few days']].map(([k, l]) => `<option value="${k}" ${k === kind ? 'selected' : ''}>${l}</option>`).join('')}
      </select></label>
      <label>List<select id="tList">${['Inbox', ...S.settings.lists].map(l => `<option ${(t.list || 'Inbox') === l ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
    </div>
    <div id="tRepX"></div>
    <label class="check"><input type="checkbox" id="tStar" ${t.star ? 'checked' : ''}>Important</label>
    <label>Notes<textarea id="tNotes" rows="3">${esc(t.notes)}</textarea></label>
    ${t.rep ? `<p class="hint">${st ? `${st} in a row. ` : ''}Done ${(t.log || []).length} time${(t.log || []).length === 1 ? '' : 's'} so far.</p>` : ''}
    <div class="actions">
      <button class="btn solid" data-act="saveTask">Save</button>
      ${t.done ? '<button class="btn ghost" data-act="reopen">Not done</button>' : `<button class="btn ghost ok" data-act="tickOpen">Done</button>`}
      <button class="btn ghost danger" data-act="delTask">Delete</button>
    </div>
  `, () => {
    const drawX = () => {
      const k = $('#tRep').value, x = $('#tRepX');
      if (k === 'weekly') {
        if (!ctDays.length) ctDays = [dow($('#tDue').value || today())];
        x.innerHTML = `<div class="days">${[1, 2, 3, 4, 5, 6, 0].map(d => `<button class="${ctDays.includes(d) ? 'on' : ''}" data-d="${d}">${DOW_NAMES[d].slice(0, 2)}</button>`).join('')}</div>`;
        x.querySelectorAll('[data-d]').forEach(b => b.onclick = () => { const d = +b.dataset.d; ctDays = ctDays.includes(d) ? ctDays.filter(z => z !== d) : [...ctDays, d]; drawX(); });
      } else if (k === 'every') x.innerHTML = `<label>Every how many days<input id="tN" type="number" inputmode="numeric" min="2" value="${rep && rep.u === 'day' && rep.n > 1 ? rep.n : 2}"></label>`;
      else x.innerHTML = '';
    };
    $('#tRep').onchange = drawX; drawX();
  }, back);
}

function listSheet(l) {
  const ts = sortTasks(S.tasks.filter(t => (t.list || 'Inbox') === l && (showDone || !t.done)));
  const doneN = S.tasks.filter(t => (t.list || 'Inbox') === l && t.done).length;
  openSheet(`
    ${head(esc(l))}
    ${quickAdd(`Add to ${esc(l)}…`)}
    <div class="card">${ts.length ? ts.map(t => taskRow(t, { noList: true, showTime: true })).join('') : '<div class="empty">Empty.</div>'}
      ${doneN ? `<button class="more" data-act="toggleDoneList" data-l="${esc(l)}">${showDone ? 'Hide' : 'Show'} ${doneN} done</button>` : ''}</div>
    ${l !== 'Inbox' && S.settings.lists.includes(l) ? `<div class="actions"><button class="btn ghost" data-act="renameList" data-l="${esc(l)}">Rename</button><button class="btn ghost danger" data-act="delList" data-l="${esc(l)}">Delete list</button></div>` : ''}
    ${doneN ? `<div class="actions"><button class="btn ghost sm" data-act="clearDone" data-l="${esc(l)}">Clear done</button></div>` : ''}
  `, el => { el.dataset.list = l; });
}

function settingsSheet() {
  const st = S.settings;
  openSheet(`
    ${head('Settings')}
    <div class="sec">Reminders</div>
    <p class="hint">Your Google script does these, the same one Tithe and Grimoire use, so they still come when Rite is closed:</p>
    <p class="hint">• Anything with a time goes into a "Rite" Google Calendar, so your phone buzzes on time.<br>• A morning email lists today's tasks and anything overdue.</p>
    <label>Email for the morning list<input id="sEmail" type="email" value="${esc(st.email)}" placeholder="Your Gmail"></label>
    <div class="grid2">
      <label>Send it at<select id="sHour">${[5, 6, 7, 8, 9, 10].map(h => `<option value="${h}" ${+st.hour === h ? 'selected' : ''}>${h}am</option>`).join('')}</select></label>
      <div></div>
    </div>
    <label class="check"><input type="checkbox" id="sCal" ${st.calendar ? 'checked' : ''}>Put timed tasks in Google Calendar</label>
    <label class="check"><input type="checkbox" id="sShowCal" ${st.showCal ? 'checked' : ''}>Show my Google Calendar events in Rite</label>
    <label>Script URL<input id="sUrl" type="url" value="${esc(st.scriptUrl)}" placeholder="Blank = use Tithe's"></label>
    <label>Script token<input id="sTok" value="${esc(st.scriptToken)}"></label>
    <p class="hint" id="syncState">${st.lastSync ? 'Last synced ' + new Date(st.lastSync).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'Not synced yet.'}</p>
    <div class="actions"><button class="btn ghost" data-act="syncNow">Sync now</button><button class="btn solid" data-act="saveSettings">Save settings</button></div>
    <div class="sec">Quick add tricks</div>
    <p class="hint">"dentist fri 3pm" · "pay rent on the 1st every month" · "bins every tue 8pm" · "gym every mon wed thu" · "call accountant tomorrow #work !" (! means important) · "renew passport 12 march"</p>
    <div class="sec">Backup</div>
    <p class="hint">Tasks live on this phone. Export a backup now and then.</p>
    <div class="actions"><button class="btn ghost" data-act="exportBackup">Export backup</button><button class="btn ghost" data-act="importBackup">Restore backup</button></div>
  `);
}

// ---------- sync to the google script ----------
async function script() {
  const st = S.settings;
  if (st.scriptUrl) return { url: st.scriptUrl, token: st.scriptToken };
  const t = await peek('tithe', ['settings']);
  return t && t.settings && t.settings.scriptUrl ? { url: t.settings.scriptUrl, token: t.settings.scriptToken, email: t.settings.email } : null;
}
let syncT = null;
function queueSync() { clearTimeout(syncT); syncT = setTimeout(() => sync(false), 2500); }
async function sync(loud) {
  const sc = await script();
  if (!sc) { if (loud) toast('No script set up yet'); return; }
  const td = today(), lo = addDays(td, -30), hi = addDays(td, 60);
  const tasks = sortTasks(open().filter(t => t.due && t.due >= lo && t.due <= hi)).slice(0, 80)
    .map(t => ({ id: t.id, t: t.title.slice(0, 80), d: t.due, tm: t.time || '' }));
  const st = S.settings;
  try {
    const j = await (await fetch(sc.url, { method: 'POST', body: JSON.stringify({ token: sc.token, rite: { email: st.email || sc.email || '', hour: +st.hour || 7, calendar: !!st.calendar, tasks } }) })).json();
    if (!j.ok) throw new Error(j.error || 'Script said no');
    st.lastSync = Date.now(); save('settings');
    if (j.events) { S.events = { at: Date.now(), list: j.events }; save('events'); render(); }
    if (loud) toast(`Synced. ${j.synced || 0} in your calendar.`);
  } catch (e) {
    if (loud) toast(/Missing email|pdf/i.test(e.message) ? 'Your script needs the Rite update. See README.' : 'Sync failed: ' + e.message, 5000);
  }
}

// in-app nudge when something's due and rite is open
const nudged = new Set();
function nudge() {
  const td = today(), hm = nowHM();
  open().filter(t => t.due === td && t.time && t.time <= hm && !nudged.has(t.id + t.due)).forEach(t => {
    nudged.add(t.id + t.due);
    if (t.time >= addMins(hm, -2)) { toast('⏰ ' + t.title, 6000); if (navigator.vibrate) navigator.vibrate([200, 100, 200]); }
  });
}
const addMins = (hm, n) => { const [h, m] = hm.split(':').map(Number); const t = Math.max(0, h * 60 + m + n); return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`; };

// ---------- actions ----------
const ACTS = {
  tab: d => { tab = d.tab; render(); scrollTo(0, 0); if (tab === 'today') loadFeed(); },
  settings: () => settingsSheet(),
  closeSheet: () => closeSheet(),
  undo: () => { if (undoFn) { undoFn(); undoFn = null; saveTasks(); render(); refreshList(); } $('#undo').hidden = true; document.body.classList.remove('undoing'); },
  toggleDone: () => { showDone = !showDone; render(); },
  tick: (d, el, e) => {
    e.stopPropagation();
    const t = S.tasks.find(x => x.id === d.id); if (!t) return;
    if (t.done) { t.done = false; delete t.doneAt; saveTasks(); render(); }
    else complete(t);
    refreshList();
  },
  openTask: (d, el, e) => {
    if (e.target.closest('[data-act=tick]')) return;
    const l = $('#sheet').dataset && !$('#sheet').hidden ? $('#sheet').dataset.list : null;
    taskSheet(d.id, l ? () => listSheet(l) : null);
  },
  tickOpen: () => { closeSheet(); complete(ct); },
  reopen: () => { ct.done = false; delete ct.doneAt; saveTasks(); closeSheet(); render(); },
  saveTask: () => {
    const title = $('#tTitle').value.trim();
    if (!title) { toast('Needs a name'); return; }
    const k = $('#tRep').value, due = $('#tDue').value || null;
    let rep = null;
    if (k === 'daily') rep = { u: 'day', n: 1 };
    else if (k === 'every') rep = { u: 'day', n: Math.max(2, +$('#tN').value || 2) };
    else if (k === 'weekly') rep = { u: 'week', days: ctDays.length ? ctDays : [dow(due || today())] };
    else if (k === 'monthly') rep = { u: 'month', dom: +((due || today()).slice(8)) };
    Object.assign(ct, { title, due: rep && !due ? firstFrom(rep, today()) : due, time: $('#tTime').value || '', rep, list: $('#tList').value === 'Inbox' ? null : $('#tList').value, star: $('#tStar').checked, notes: $('#tNotes').value.trim() });
    if (rep && rep.u === 'week' && !rep.days.includes(dow(ct.due))) ct.due = firstFrom(rep, ct.due);
    saveTasks(); closeSheet(); render(); toast('Saved');
  },
  delTask: async () => {
    if (!await ask(`Delete "${ct.title}"?`, 'Delete')) return;
    const t = ct, i = S.tasks.indexOf(t);
    S.tasks.splice(i, 1); saveTasks(); closeSheet(); render();
    undoBar('Deleted', () => S.tasks.splice(i, 0, t));
  },
  openList: d => listSheet(d.l),
  toggleDoneList: d => { showDone = !showDone; listSheet(d.l); },
  clearDone: d => { S.tasks = S.tasks.filter(t => !(t.done && (t.list || 'Inbox') === d.l)); saveTasks(); listSheet(d.l); render(); },
  newList: () => {
    openSheet(`${head('New list')}<label>Name<input id="lName" placeholder="e.g. Freelance, House, Shopping"></label>
      <div class="actions"><button class="btn solid" data-act="saveList">Create</button></div>`, () => $('#lName').focus());
  },
  saveList: () => {
    const n = $('#lName').value.trim();
    if (!n) return;
    if (n.toLowerCase() === 'inbox' || S.settings.lists.some(l => l.toLowerCase() === n.toLowerCase())) { toast('Already got that one'); return; }
    S.settings.lists.push(n); save('settings'); closeSheet(true); render();
  },
  renameList: d => {
    openSheet(`${head('Rename list')}<label>Name<input id="lName" value="${esc(d.l)}"></label>
      <div class="actions"><button class="btn solid" data-act="doRename" data-l="${esc(d.l)}">Rename</button></div>`, null, () => listSheet(d.l));
  },
  doRename: d => {
    const n = $('#lName').value.trim(); if (!n) return;
    S.settings.lists = S.settings.lists.map(l => l === d.l ? n : l);
    S.tasks.forEach(t => { if (t.list === d.l) t.list = n; });
    save('settings'); saveTasks(); closeSheet(true); render(); listSheet(n);
  },
  delList: async d => {
    if (!await ask(`Delete the ${d.l} list? Its tasks move to Inbox.`, 'Delete')) return;
    S.settings.lists = S.settings.lists.filter(l => l !== d.l);
    S.tasks.forEach(t => { if (t.list === d.l) t.list = null; });
    save('settings'); saveTasks(); closeSheet(true); render();
  },
  syncNow: () => { ACTS.saveSettings(true); sync(true); fetchEvents(true); },
  saveSettings: keepOpen => {
    const url = $('#sUrl').value.trim();
    if (url && !/^https:\/\/script\.google\.com\//.test(url)) { toast('Script URL should start https://script.google.com/'); return; }
    Object.assign(S.settings, { email: $('#sEmail').value.trim(), hour: +$('#sHour').value, calendar: $('#sCal').checked, showCal: $('#sShowCal').checked, scriptUrl: url, scriptToken: $('#sTok').value.trim() });
    save('settings');
    if (keepOpen !== true) { closeSheet(true); toast('Saved'); queueSync(); fetchEvents(false); render(); }
  },
  exportBackup: () => download(new Blob([JSON.stringify({ app: 'rite', v: 1, at: new Date().toISOString(), settings: S.settings, tasks: S.tasks })], { type: 'application/json' }), `rite-backup-${today()}.json`),
  importBackup: () => {
    const inp = $('#backupPick'); inp.value = '';
    inp.onchange = async () => {
      const f = inp.files[0]; if (!f) return;
      let d;
      try { d = JSON.parse(await f.text()); } catch (e) { toast('That isn\'t a backup file'); return; }
      if (d.app !== 'rite') { toast('That isn\'t a Rite backup'); return; }
      if (!await ask(`Restore the backup from ${(d.at || '').slice(0, 10)}?\nThis replaces everything here.`, 'Restore')) return;
      S.settings = { ...DEFAULTS, ...d.settings }; S.tasks = d.tasks || [];
      save('settings'); saveTasks(); closeSheet(true); render(); toast('Restored');
    };
    inp.click();
  }
};
// redraw an open list sheet after ticking inside it
function refreshList() { const s = $('#sheet'); if (!s.hidden && s.dataset.list) listSheet(s.dataset.list); }

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]');
  if (t && ACTS[t.dataset.act]) ACTS[t.dataset.act](t.dataset, t, e);
});
document.addEventListener('input', e => { if (e.target.id === 'qa') drawPrev(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.id === 'qa') {
    e.preventDefault();
    const s = $('#sheet'), l = !s.hidden && s.dataset.list;
    addQuick(l && l !== 'Inbox' ? l : null);
    if (l) { listSheet(l); const q = $('#sheet #qa'); if (q) q.focus(); }
  }
  if (e.key === 'Escape' && !$('#sheet').hidden) closeSheet();
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  render(); if (tab === 'today') loadFeed();
  if (Date.now() - (S.events.at || 0) > 10 * 60e3) fetchEvents(false);
  if (Date.now() - (S.settings.lastSync || 0) > 6 * 3600e3) sync(false);
});

// ---------- boot ----------
(async () => {
  $('#gearBtn').innerHTML = pix('gear');
  try {
    S.tasks = (await db.get('tasks')) || [];
    S.settings = { ...DEFAULTS, ...((await db.get('settings')) || {}) };
    S.events = (await db.get('events')) || { at: 0, list: [] };
  } catch (e) { toast('Storage broke: ' + e.message, 8000); }
  render(); loadFeed();
  if (Date.now() - (S.events.at || 0) > 10 * 60e3) fetchEvents(false);
  setInterval(() => { nudge(); }, 30000);
  // midnight rollover
  let day = today();
  setInterval(() => { if (today() !== day) { day = today(); render(); loadFeed(); } }, 60000);
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  if (Date.now() - (S.settings.lastSync || 0) > 6 * 3600e3) setTimeout(() => sync(false), 3000);
})();
