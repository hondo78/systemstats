// Systemstats – Frontend (Vanilla JS, keine Abhängigkeiten außer charts.js)
'use strict';

// ============================================================== Hilfsfunktionen
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtBytes(n, digits = 1) {
  if (n == null || isNaN(n)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0, v = Math.abs(n);
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (n < 0 ? '-' : '') + v.toFixed(i === 0 ? 0 : digits).replace('.', ',') + ' ' + u[i];
}
const fmtRate = n => (n == null ? '–' : fmtBytes(n) + '/s');
function fmtNum(n, d = 1) {
  if (n == null || isNaN(n)) return '–';
  return Number(n).toLocaleString('de-AT', { minimumFractionDigits: d, maximumFractionDigits: d });
}
const fmtPct = (n, d = 1) => (n == null ? '–' : fmtNum(n, d) + ' %');
function fmtDur(sec) {
  if (sec == null) return '–';
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60);
  if (d) return `${d} T ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min`;
  return `${sec} s`;
}
function fmtDate(ts) {
  if (!ts) return '–';
  return new Date(ts * 1000).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtAgo(ts) { return ts ? fmtDur(Date.now() / 1000 - ts) : '–'; }
// Lesbare Namen für hwmon-Sensoren
function sensorLabel(k) {
  if (k === 'cpu_temp') return 'CPU';
  if (k === 'gpu_temp') return 'GPU';
  return k.replace(/^temp:/, '').replace(/^r8169_\d+_(\w+):\d+$/, 'LAN $1').replace(/^mt79\w*_phy\d+$/, 'WLAN').replace(/^iwlwifi.*$/, 'WLAN');
}
function level(v, warn, crit) { return v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok'; }
function bar(pct, cls) {
  const p = Math.max(0, Math.min(100, pct || 0));
  return `<div class="bar thin"><i class="${cls || level(p, 75, 90)}" style="width:${p}%"></i></div>`;
}
function setBar(el, pct, cls) {
  el.style.width = Math.max(0, Math.min(100, pct || 0)) + '%';
  el.className = cls || level(pct, 75, 90);
}
async function api(path, opts) {
  const r = await fetch(path, opts);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}
const LEVEL_TXT = { crit: 'Kritisch', warn: 'Warnung', info: 'Hinweis', ok: 'OK' };

// Sortierbare Tabellen: columns = [{key, label, num, fmt(row), cls, title}]
class SortTable {
  constructor(table, columns, opts = {}) {
    this.table = table;
    this.columns = columns;
    this.sortKey = opts.sortKey || columns[0].key;
    this.asc = opts.asc ?? false;
    this.onRow = opts.onRow;
    this.limit = opts.limit || 0;
    this.rowClass = opts.rowClass;
    this.renderHead();
  }
  renderHead() {
    const tr = this.columns.map(c => {
      const sorted = c.key === this.sortKey ? ` sorted${this.asc ? ' asc' : ''}` : '';
      return `<th class="${c.nosort ? '' : 'sortable'}${sorted}${c.num ? ' num' : ''}" data-k="${c.key}" title="${esc(c.title || '')}">${c.label}</th>`;
    }).join('');
    this.table.tHead.innerHTML = `<tr>${tr}</tr>`;
    $$('th.sortable', this.table.tHead).forEach(th => th.onclick = () => {
      const k = th.dataset.k;
      if (k === this.sortKey) this.asc = !this.asc;
      else { this.sortKey = k; const col = this.columns.find(c => c.key === k); this.asc = !col.num; }
      this.renderHead();
      if (this.rows) this.render(this.rows, true);
    });
  }
  sort(rows) {
    const k = this.sortKey, dir = this.asc ? 1 : -1;
    const col = this.columns.find(c => c.key === k) || {};
    const get = col.sortVal || (r => r[k]);
    return [...rows].sort((a, b) => {
      const va = get(a), vb = get(b);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === 'string') return va.localeCompare(vb, 'de') * dir;
      return (va - vb) * dir;
    });
  }
  render(rows, keepOrder = false, presorted = false) {
    this.rows = rows;
    let list = presorted ? rows : this.sort(rows);
    const total = list.length;
    if (this.limit && list.length > this.limit) list = list.slice(0, this.limit);
    const body = list.map(r => {
      const tds = this.columns.map(c => `<td class="${c.num ? 'num ' : ''}${c.cls || ''}">${c.fmt ? c.fmt(r) : esc(r[c.key])}</td>`).join('');
      const cls = (this.onRow ? 'clickable ' : '') + (this.rowClass ? this.rowClass(r) : '');
      return `<tr class="${cls}" data-id="${esc(r._id ?? r.pid ?? '')}">${tds}</tr>`;
    }).join('');
    const more = total > list.length ? `<tr><td colspan="${this.columns.length}" class="muted">… ${total - list.length} weitere Einträge – Suche/Filter verwenden</td></tr>` : '';
    this.table.tBodies[0].innerHTML = body + more || `<tr><td colspan="${this.columns.length}" class="empty">Keine Einträge</td></tr>`;
    if (this.onRow) {
      const map = new Map(list.map(r => [String(r._id ?? r.pid ?? ''), r]));
      $$('tr.clickable', this.table.tBodies[0]).forEach(tr => tr.onclick = e => this.onRow(map.get(tr.dataset.id), tr, e));
    }
  }
}

// ============================================================== Globaler Zustand
const state = {
  sys: null,
  samples: [],
  lastTs: 0,
  view: null,
  health: null,
  procs: null,
  containers: null,
  mounts: null,
  liveWindow: 900,
};
const MAX_SAMPLES = 1800;
const latest = () => state.samples[state.samples.length - 1] || {};

// ============================================================== Theme
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem('theme'); } catch (e) { /* egal */ }
  if (t) document.documentElement.dataset.theme = t;
  $('#themeBtn').onclick = () => {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('theme', next); } catch (e) { /* egal */ }
    redrawAllCharts();
  };
})();
const allCharts = [];
function chart(el, opts) { const c = new LineChart(el, opts); allCharts.push(c); return c; }
function redrawAllCharts() { allCharts.forEach(c => { c.renderLegend(); c.draw(); }); }

// ============================================================== Routing
const views = {};
function showView(name) {
  if (!views[name]) name = 'overview';
  state.view = name;
  $$('section.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + name));
  $$('#nav a').forEach(a => a.classList.toggle('active', a.dataset.view === name));
  views[name].enter?.();
  setTimeout(redrawAllCharts, 0);
}
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

// Periodische Aufgaben: nur ausführen, wenn Ansicht aktiv (oder global)
function every(ms, fn, viewName) {
  const run = async () => {
    if (!viewName || state.view === viewName) {
      try { await fn(); } catch (e) { console.warn(e); }
    }
  };
  setInterval(run, ms);
  return run;
}

// ============================================================== Live-Daten
async function pollLive() {
  const res = await api(`/api/live?since=${state.lastTs}&limit=${state.lastTs ? 300 : MAX_SAMPLES}`);
  if (res.samples.length) {
    state.samples.push(...res.samples);
    if (state.samples.length > MAX_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SAMPLES);
    state.lastTs = state.samples[state.samples.length - 1].ts;
  }
  views.overview.live();
  if (state.view === 'network') views.network.live();
}

async function pollHealth() {
  state.health = await api('/api/health');
  const dot = $('#statusDot');
  dot.className = 'dot ' + (state.health.overall === 'ok' ? '' : state.health.overall);
  dot.title = 'Zustand: ' + LEVEL_TXT[state.health.overall];
  views.overview.health();
  if (state.view === 'analysis') views.analysis.health();
}

async function loadSystem() {
  state.sys = await api('/api/system');
  const s = state.sys;
  $('#hostName').textContent = s.hostname;
  $('#hostMeta').textContent = `${s.os} · Kernel ${s.kernel}`;
  document.title = `${s.hostname} – Systemstats`;
  $('#kCpuModel').textContent = s.cpu_model.replace(/ w\/.*$/, '');
  if (s.gpu) $('#kGpuName').textContent = s.gpu.name;
  else $('#gpuCard').style.display = 'none';
  $('#kUptime').innerHTML = fmtDur(s.uptime) + ' <small>Laufzeit</small>';
  $('#kSys').innerHTML = `
    <span>Gestartet</span><span>${fmtDate(s.boot_time)}</span>
    <span>CPU</span><span>${s.cpu_cores} Kerne / ${s.cpu_threads} Threads</span>
    <span>RAM gesamt</span><span>${fmtBytes(s.mem_total)}</span>
    ${s.nvme.map(n => `<span>${esc(n.name)}</span><span title="${esc(n.serial)}">${esc(n.model)}</span>`).join('')}
    <span>Docker</span><span>${s.docker ? 'verbunden' : 'nicht erreichbar'}</span>
    <span>Datensammlung seit</span><span>${fmtAgo(s.collector_started)}</span>`;
}

// Zeitreihe aus Live-Puffer für ein Fenster (Sekunden)
function liveSeries(windowSec, keys, transform = {}) {
  const since = (latest().ts || 0) - windowSec;
  const rows = state.samples.filter(s => s.ts >= since);
  const data = {};
  keys.forEach(k => { data[k] = rows.map(r => (transform[k] ? transform[k](r) : r[k] ?? null)); });
  return { ts: rows.map(r => r.ts), data };
}

// ============================================================== Übersicht
views.overview = (() => {
  const charts = {};
  let topCpu, topMem;

  function init() {
    charts.mCpu = chart('#mCpu', { mini: true, max: 100, series: [{ key: 'cpu', label: 'CPU' }] });
    charts.mMem = chart('#mMem', { mini: true, max: 100, series: [{ key: 'memp', label: 'RAM', color: '--c2' }] });
    charts.mGpu = chart('#mGpu', { mini: true, max: 100, series: [{ key: 'gpu_busy', label: 'GPU', color: '--c5' }] });
    charts.mNet = chart('#mNet', { mini: true, series: [{ key: 'net_rx', label: 'RX', color: '--c6' }, { key: 'net_tx', label: 'TX', color: '--c3' }] });
    charts.cpu = chart('#cCpu', {
      max: 100, stacked: true, format: v => fmtNum(v, 0) + ' %',
      series: [{ key: 'cpu_user', label: 'User' }, { key: 'cpu_system', label: 'System', color: '--c4' }, { key: 'cpu_iowait', label: 'I/O-Wait', color: '--c3' }],
    });
    charts.mem = chart('#cMem', {
      format: v => fmtBytes(v, 0),
      series: [{ key: 'mem_used', label: 'Belegt', color: '--c2', fill: true }, { key: 'mem_cached', label: 'Cache', color: '--c6' }, { key: 'swap_used', label: 'Swap', color: '--c4' }],
    });
    charts.gpu = chart('#cGpu', {
      max: 100, format: v => fmtNum(v, 0) + ' %',
      series: [{ key: 'gpu_busy', label: 'Auslastung', color: '--c5', fill: true }, { key: 'vramp', label: 'VRAM', color: '--c1' }, { key: 'gttp', label: 'GTT', color: '--c6' }],
    });
    charts.net = chart('#cNet', { format: v => fmtRate(v), series: [{ key: 'net_rx', label: 'Empfangen', color: '--c6', fill: true }, { key: 'net_tx', label: 'Gesendet', color: '--c3' }] });
    charts.disk = chart('#cDisk', { format: v => fmtRate(v), series: [{ key: 'disk_r', label: 'Lesen', color: '--c2', fill: true }, { key: 'disk_w', label: 'Schreiben', color: '--c4' }] });
    charts.temp = chart('#cTemp', { format: v => fmtNum(v, 0) + ' °C', series: [] });
    $$('#liveWindow button').forEach(b => b.onclick = () => {
      $$('#liveWindow button').forEach(x => x.classList.toggle('active', x === b));
      state.liveWindow = +b.dataset.w;
      live();
    });
    const topCols = (valCol) => [
      { key: 'name', label: 'Prozess', fmt: r => `${esc(r.name)}${r.container ? ` <span class="badge">${esc(r.container)}</span>` : ''}` },
      valCol,
    ];
    topCpu = new SortTable(mkTable('#topCpu'), topCols({ key: 'cpu', label: 'CPU %', num: true, fmt: r => fmtNum(r.cpu) }), { sortKey: 'cpu', onRow: r => openProcess(r.pid) });
    topMem = new SortTable(mkTable('#topMem'), topCols({ key: 'rss', label: 'RAM', num: true, fmt: r => fmtBytes(r.rss) }), { sortKey: 'rss', onRow: r => openProcess(r.pid) });
  }

  function mkTable(sel) {
    $(sel).innerHTML = '<table><thead></thead><tbody></tbody></table>';
    return $(sel + ' table');
  }

  function live() {
    const s = latest();
    if (!s.ts) return;
    $('#kCpu').innerHTML = `${fmtNum(s.cpu)} <small>%</small>`;
    $('#kLoad').textContent = `${fmtNum(s.load1, 2)} / ${fmtNum(s.load5, 2)} / ${fmtNum(s.load15, 2)}`;
    $('#kFreq').textContent = s.cpu_freq ? fmtNum(s.cpu_freq / 1000, 2) + ' GHz' : '–';
    $('#kCpuTemp').textContent = s.cpu_temp != null ? fmtNum(s.cpu_temp, 0) + ' °C' : '–';
    $('#kCpuSplit').textContent = `${fmtNum(s.cpu_user, 0)} / ${fmtNum(s.cpu_system, 0)} / ${fmtNum(s.cpu_iowait, 0)} %`;
    const memp = s.mem_used / s.mem_total * 100;
    $('#kMem').innerHTML = `${fmtNum(memp)} <small>% · ${fmtBytes(s.mem_used)}</small>`;
    $('#kMemTxt').textContent = `${fmtBytes(s.mem_used)} / ${fmtBytes(s.mem_total)}`;
    setBar($('#kMemBar'), memp);
    const swp = s.swap_total ? s.swap_used / s.swap_total * 100 : 0;
    $('#kSwapTxt').textContent = s.swap_total ? `${fmtBytes(s.swap_used)} / ${fmtBytes(s.swap_total)}` : 'kein Swap';
    setBar($('#kSwapBar'), swp, level(swp, 50, 90));
    $('#kCache').textContent = fmtBytes(s.mem_cached);
    $('#kAvail').textContent = fmtBytes(s.mem_avail);
    if (s.gpu_busy != null) {
      $('#kGpu').innerHTML = `${fmtNum(s.gpu_busy, 0)} <small>% Auslastung</small>`;
      $('#kVramTxt').textContent = `${fmtBytes(s.vram_used)} / ${fmtBytes(s.vram_total)}`;
      setBar($('#kVramBar'), s.vram_used / s.vram_total * 100);
      $('#kGttTxt').textContent = `${fmtBytes(s.gtt_used)} / ${fmtBytes(s.gtt_total)}`;
      setBar($('#kGttBar'), s.gtt_used / s.gtt_total * 100);
      $('#kGpuTP').textContent = `${s.gpu_temp != null ? fmtNum(s.gpu_temp, 0) + ' °C' : '–'} / ${s.gpu_power != null ? fmtNum(s.gpu_power, 1) + ' W' : '–'}`;
      $('#kGpuClk').textContent = s.gpu_sclk ? fmtNum(s.gpu_sclk, 0) + ' MHz' : '–';
    }
    $('#kNet').innerHTML = `${fmtRate((s.net_rx || 0) + (s.net_tx || 0))} <small>Netz</small>`;
    $('#kRx').textContent = fmtRate(s.net_rx);
    $('#kTx').textContent = fmtRate(s.net_tx);
    $('#kDr').textContent = fmtRate(s.disk_r);
    $('#kDw').textContent = fmtRate(s.disk_w);
    if (state.sys) $('#kUptime').innerHTML = fmtDur(s.ts - state.sys.boot_time) + ' <small>Laufzeit</small>';

    // Kerne
    const cores = Object.keys(s).filter(k => k.startsWith('core:')).sort((a, b) => a.slice(5) - b.slice(5));
    const coresEl = $('#cores');
    if (coresEl.children.length !== cores.length) {
      coresEl.innerHTML = cores.map(k => `<div class="core"><b></b><span>${k.slice(5)}</span></div>`).join('');
    }
    cores.forEach((k, i) => {
      const v = s[k], el = coresEl.children[i];
      el.style.setProperty('--h', v + '%');
      el.style.setProperty('--c', v >= 90 ? 'var(--crit)' : v >= 70 ? 'var(--warn)' : 'var(--accent)');
      el.firstChild.textContent = Math.round(v);
    });
    const busy = cores.filter(k => s[k] > 50).length;
    $('#coreInfo').textContent = `${busy} von ${cores.length} über 50 %`;

    // Diagramme
    const w = state.liveWindow;
    const short = liveSeries(300, ['cpu', 'memp', 'gpu_busy', 'net_rx', 'net_tx'], { memp: r => r.mem_used / r.mem_total * 100 });
    ['mCpu', 'mMem', 'mGpu', 'mNet'].forEach(k => charts[k].setData(short.ts, short.data));
    let d = liveSeries(w, ['cpu_user', 'cpu_system', 'cpu_iowait']); charts.cpu.setData(d.ts, d.data);
    charts.mem.opts.max = s.mem_total;
    d = liveSeries(w, ['mem_used', 'mem_cached', 'swap_used']); charts.mem.setData(d.ts, d.data);
    d = liveSeries(w, ['gpu_busy', 'vramp', 'gttp'], { vramp: r => r.vram_used / r.vram_total * 100, gttp: r => r.gtt_used / r.gtt_total * 100 });
    charts.gpu.setData(d.ts, d.data);
    d = liveSeries(w, ['net_rx', 'net_tx']); charts.net.setData(d.ts, d.data);
    d = liveSeries(w, ['disk_r', 'disk_w']); charts.disk.setData(d.ts, d.data);
    const tkeys = ['cpu_temp', 'gpu_temp', ...Object.keys(s).filter(k => k.startsWith('temp:'))].filter(k => s[k] != null);
    if (charts.temp.series.length !== tkeys.length) {
      charts.temp.setSeries(tkeys.map(k => ({ key: k, label: sensorLabel(k) })));
    }
    d = liveSeries(w, tkeys); charts.temp.setData(d.ts, d.data);
  }

  function health() {
    const h = state.health;
    if (!h) return;
    $('#healthSummary').innerHTML = ['crit', 'warn', 'info', 'ok'].map(l => `<span class="badge ${l}">${h.summary[l]} ${LEVEL_TXT[l]}</span>`).join('');
    const items = h.items.filter(i => i.level !== 'ok').slice(0, 7);
    $('#healthTop').innerHTML = items.length ? items.map(findingHtml).join('') : '<div class="finding ok"><span class="badge ok">OK</span><div class="t">Alles im grünen Bereich</div><span></span></div>';
  }

  async function slow() {
    const top = await api('/api/processes/top?n=8');
    topCpu.render(top.by_cpu);
    topMem.render(top.by_mem);
    if (!state.mounts || Date.now() - state.mounts._t > 30000) {
      state.mounts = await api('/api/storage/mounts');
      state.mounts._t = Date.now();
    }
    $('#ovMounts').innerHTML = state.mounts.mounts.map(m => `
      <div class="meter"><span class="mono">${esc(m.mountpoint)}</span><span>${fmtBytes(m.used)} / ${fmtBytes(m.total)} · <b>${fmtPct(m.percent)}</b></span>${bar(m.percent, level(m.percent, 85, 95))}</div>`).join('');
  }

  return { init, live, health, slow };
})();

function findingHtml(i) {
  return `<div class="finding ${i.level}"><span class="badge ${i.level}">${LEVEL_TXT[i.level]}</span><div><div class="t">${esc(i.title)}</div><div class="d">${esc(i.detail)}</div></div><span class="badge">${esc(i.area)}</span></div>`;
}

// ============================================================== Prozesse
views.processes = (() => {
  let table, mode = 'list', expanded = new Set();
  const COLS = [
    { key: 'pid', label: 'PID', num: true, fmt: r => r.pid },
    { key: 'name', label: 'Name', fmt: r => `<b>${esc(r.name)}</b>` },
    { key: 'user', label: 'Benutzer' },
    { key: 'container', label: 'Container', fmt: r => r.container ? `<span class="badge info">${esc(r.container)}</span>` : '' },
    { key: 'cpu', label: 'CPU %', num: true, title: '100 % = ein voll ausgelasteter Kern', fmt: r => `<div class="cellbar">${fmtNum(r.cpu)}${bar(r.cpu / (state.procs?.ncpu || 1), r.cpu > 90 ? 'crit' : r.cpu > 50 ? 'warn' : '')}</div>` },
    { key: 'rss', label: 'RAM (RSS)', num: true, fmt: r => fmtBytes(r.rss) },
    { key: 'memp', label: 'RAM %', num: true, sortVal: r => r.rss, fmt: r => fmtNum(r.rss / (state.procs?.mem_total || 1) * 100, 2) },
    { key: 'threads', label: 'Threads', num: true },
    { key: 'io_read', label: 'I/O lesen', num: true, fmt: r => r.io_read ? fmtRate(r.io_read) : '<span class="muted">–</span>' },
    { key: 'io_write', label: 'I/O schreiben', num: true, fmt: r => r.io_write ? fmtRate(r.io_write) : '<span class="muted">–</span>' },
    { key: 'status', label: 'Status', fmt: r => r.status === 'zombie' ? '<span class="badge crit">zombie</span>' : r.status === 'running' ? '<span class="badge ok">läuft</span>' : esc(r.status) },
    { key: 'started', label: 'Gestartet', num: true, fmt: r => `<span title="${fmtDate(r.started)}">${fmtAgo(r.started)}</span>` },
    { key: 'cmdline', label: 'Befehl', cls: 'cmd', fmt: r => `<span title="${esc(r.cmdline)}">${esc(r.cmdline || '[' + r.name + ']')}</span>` },
  ];
  const GROUP_COLS = [
    { key: 'name', label: 'Prozessname', fmt: r => `<b>${esc(r.name)}</b>` },
    { key: 'count', label: 'Anzahl', num: true },
    { key: 'cpu', label: 'CPU % (Summe)', num: true, fmt: r => `<div class="cellbar">${fmtNum(r.cpu)}${bar(r.cpu / (state.procs?.ncpu || 1))}</div>` },
    { key: 'rss', label: 'RAM (Summe RSS)', num: true, fmt: r => fmtBytes(r.rss) },
    { key: 'threads', label: 'Threads', num: true },
    { key: 'io', label: 'I/O gesamt', num: true, fmt: r => r.io ? fmtRate(r.io) : '–' },
    { key: 'users', label: 'Benutzer', fmt: r => esc([...r.users].join(', ')) },
    { key: 'containers', label: 'Container', fmt: r => [...r.containers].map(c => `<span class="badge info">${esc(c)}</span>`).join(' ') },
  ];

  function init() {
    table = new SortTable($('#procTable'), COLS, { sortKey: 'cpu', limit: 600, onRow: r => openProcess(r.pid) });
    $('#procSearch').oninput = render;
    $('#procUser').onchange = render;
    $('#procContainer').onchange = render;
    $$('#procMode button').forEach(b => b.onclick = () => setMode(b.dataset.m));
  }

  function setMode(m) {
    mode = m;
    $$('#procMode button').forEach(x => x.classList.toggle('active', x.dataset.m === m));
    if (m === 'group') {
      table = new SortTable($('#procTable'), GROUP_COLS, { sortKey: 'cpu', onRow: r => { $('#procSearch').value = r.name; setMode('list'); } });
    } else {
      table = new SortTable($('#procTable'), m === 'tree' ? COLS.map(c => c.key === 'name' ? { ...c, nosort: true, fmt: treeName } : { ...c, nosort: true }) : COLS,
        { sortKey: m === 'tree' ? 'pid' : 'cpu', asc: m === 'tree', limit: 600, onRow: (r, tr) => openProcess(r.pid) });
    }
    render();
  }

  function treeName(r) {
    const toggle = r._kids ? `<span class="tg" data-pid="${r.pid}" style="cursor:pointer;display:inline-block;width:14px">${r._open ? '▾' : '▸'}</span>` : '<span style="display:inline-block;width:14px"></span>';
    return `<span style="padding-left:${r._depth * 16}px">${toggle}<b>${esc(r.name)}</b>${r._kids ? ` <span class="muted">(${r._kids})</span>` : ''}</span>`;
  }

  function filtered() {
    const p = state.procs;
    if (!p) return [];
    const q = $('#procSearch').value.trim().toLowerCase();
    const user = $('#procUser').value;
    const cont = $('#procContainer').value;
    return p.processes.filter(r => {
      if (user && r.user !== user) return false;
      if (cont === '__host' && r.container) return false;
      if (cont === '__any' && !r.container) return false;
      if (cont && !cont.startsWith('__') && r.container !== cont) return false;
      if (!q) return true;
      return String(r.pid) === q || r.name.toLowerCase().includes(q) || (r.cmdline || '').toLowerCase().includes(q)
        || (r.user || '').toLowerCase().includes(q) || (r.container || '').toLowerCase().includes(q);
    });
  }

  function render() {
    const rows = filtered();
    $('#procCount').textContent = `${rows.length} von ${state.procs?.processes.length || 0} Prozessen`;
    if (mode === 'group') {
      const g = new Map();
      rows.forEach(r => {
        let e = g.get(r.name);
        if (!e) g.set(r.name, e = { _id: r.name, name: r.name, count: 0, cpu: 0, rss: 0, threads: 0, io: 0, users: new Set(), containers: new Set() });
        e.count++; e.cpu += r.cpu; e.rss += r.rss; e.threads += r.threads; e.io += (r.io_read || 0) + (r.io_write || 0);
        e.users.add(r.user); if (r.container) e.containers.add(r.container);
      });
      table.render([...g.values()]);
    } else if (mode === 'tree') {
      table.render(buildTree(rows), false, true);
      $$('#procTable .tg').forEach(t => t.onclick = ev => {
        ev.stopPropagation();
        const pid = +t.dataset.pid;
        expanded.has(pid) ? expanded.delete(pid) : expanded.add(pid);
        render();
      });
    } else {
      table.render(rows);
    }
  }

  // Baumansicht: bei aktivem Filter werden Treffer samt Vorfahren gezeigt (alles aufgeklappt)
  function buildTree(rows) {
    const all = state.procs.processes;
    const byPid = new Map(all.map(r => [r.pid, r]));
    const filtering = rows.length !== all.length;
    let include = null;
    if (filtering) {
      include = new Set();
      rows.forEach(r => { let c = r; while (c && !include.has(c.pid)) { include.add(c.pid); c = byPid.get(c.ppid); } });
    }
    const kids = new Map();
    all.forEach(r => {
      if (include && !include.has(r.pid)) return;
      const parent = byPid.has(r.ppid) && r.ppid !== r.pid ? r.ppid : 0;
      if (!kids.has(parent)) kids.set(parent, []);
      kids.get(parent).push(r);
    });
    const out = [];
    const walk = (pid, depth) => {
      const list = (kids.get(pid) || []).sort((a, b) => b.cpu - a.cpu || a.pid - b.pid);
      list.forEach(r => {
        const n = (kids.get(r.pid) || []).length;
        const open = filtering || expanded.has(r.pid) || depth === 0;
        out.push({ ...r, _depth: depth, _kids: n, _open: open });
        if (open) walk(r.pid, depth + 1);
      });
    };
    walk(0, 0);
    return out;
  }

  async function refresh() {
    if ($('#procPause').checked) return;
    state.procs = await api('/api/processes');
    const p = state.procs.processes;
    const users = [...new Set(p.map(r => r.user))].sort();
    syncOptions($('#procUser'), users, 'Alle Benutzer');
    const conts = [...new Set(p.map(r => r.container).filter(Boolean))].sort();
    syncOptions($('#procContainer'), conts, null, [['', 'Host + Container'], ['__host', 'Nur Host'], ['__any', 'Nur Container']]);
    const st = {};
    p.forEach(r => st[r.status] = (st[r.status] || 0) + 1);
    const threads = p.reduce((a, r) => a + r.threads, 0);
    $('#procSummary').innerHTML = `<span class="badge info">${p.length} Prozesse</span><span class="badge">${threads} Threads</span>`
      + Object.entries(st).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="badge ${k === 'zombie' ? 'crit' : k === 'running' ? 'ok' : ''}">${v} ${esc(k)}</span>`).join('')
      + `<span class="badge">${conts.length} Container mit Prozessen</span>`;
    render();
  }

  return { init, refresh, enter: () => refresh(), setMode };
})();

function syncOptions(sel, values, allLabel, fixed) {
  const cur = sel.value;
  const base = fixed || [['', allLabel]];
  const key = values.join('|');
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  sel.innerHTML = base.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('') + values.map(v => `<option>${esc(v)}</option>`).join('');
  sel.value = cur;
}

// ============================================================== Prozess-Detail (Drawer)
function openDrawer(html) { $('#drawerBody').innerHTML = html; $('#drawer').classList.add('open'); }
function closeDrawer() { $('#drawer').classList.remove('open'); }
$('#drawerClose').onclick = closeDrawer;
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

async function openProcess(pid) {
  openDrawer('<div class="empty"><span class="spin"></span> lädt …</div>');
  let d;
  try { d = await api('/api/processes/' + pid); } catch (e) { openDrawer(`<div class="empty">Prozess ${pid} existiert nicht mehr.</div>`); return; }
  const m = d.memory || {};
  const link = p => `<a href="#" data-pid="${p.pid}">${esc(p.name)} (${p.pid})</a>`;
  openDrawer(`
    <h2>${esc(d.name)} <span class="muted">PID ${d.pid}</span></h2>
    <div class="statusline">${d.container ? `<span class="badge info">Container: ${esc(d.container)}</span>` : '<span class="badge">Host</span>'}<span class="badge">${esc(d.status)}</span><span class="badge">Benutzer ${esc(d.user)}</span></div>
    <pre class="box">${esc(d.cmdline || '[' + d.name + ']')}</pre>
    <div class="kv">
      <div>Programm</div><div class="mono">${esc(d.exe || '–')}</div>
      <div>Arbeitsverzeichnis</div><div class="mono">${esc(d.cwd || '–')}</div>
      <div>Gestartet</div><div>${fmtDate(d.create_time)} (vor ${fmtAgo(d.create_time)})</div>
      <div>CPU aktuell</div><div>${fmtPct(d.cpu)}</div>
      <div>CPU-Zeit user/sys</div><div>${fmtDur(d.cpu_user)} / ${fmtDur(d.cpu_system)}</div>
      <div>RSS / USS / PSS</div><div>${fmtBytes(m.rss)} / ${fmtBytes(m.uss)} / ${fmtBytes(m.pss)}</div>
      <div>Virtuell / Swap</div><div>${fmtBytes(m.vms)} / ${fmtBytes(m.swap)}</div>
      <div>Threads / FDs</div><div>${d.num_threads ?? '–'} / ${d.num_fds ?? '–'}</div>
      <div>Nice / I/O-Klasse</div><div>${d.nice ?? '–'} / ${esc(d.ionice ?? '–')}</div>
      <div>Kontextwechsel</div><div>${d.ctx_voluntary ?? '–'} freiwillig / ${d.ctx_involuntary ?? '–'} erzwungen</div>
      <div>Eltern</div><div>${(d.parents || []).map(link).join(' ← ') || '–'}</div>
      <div>Kinder</div><div>${(d.children || []).map(link).join(', ') || '–'}</div>
    </div>
    <h3 class="muted" style="font-size:13px">Netzwerkverbindungen (${d.connections.length})</h3>
    ${d.connections.length ? `<div class="tablewrap short"><table><thead><tr><th>Typ</th><th>Lokal</th><th>Gegenstelle</th><th>Status</th></tr></thead><tbody>${d.connections.map(c => `<tr><td>${c.type}</td><td class="mono">${esc(c.laddr)}</td><td class="mono">${esc(c.raddr)}</td><td>${esc(c.status)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">keine</div>'}
    <h3 class="muted" style="font-size:13px;margin-top:12px">Offene Dateien (${d.open_files.length})</h3>
    ${d.open_files.length ? `<pre class="box">${esc(d.open_files.join('\n'))}</pre>` : '<div class="muted">keine</div>'}
    <h3 class="muted" style="font-size:13px;margin-top:12px">cgroup</h3><pre class="box">${esc(d.cgroup)}</pre>`);
  $$('#drawerBody a[data-pid]').forEach(a => a.onclick = e => { e.preventDefault(); openProcess(+a.dataset.pid); });
}

// ============================================================== Container
const POLICY_TXT = { 'no': 'nie', 'always': 'immer', 'unless-stopped': 'außer manuell gestoppt', 'on-failure': 'bei Fehler' };
const ACTION_TXT = { start: 'Starten', stop: 'Stoppen', restart: 'Neu starten' };
const ACTION_ING = { start: 'startet', stop: 'stoppt', restart: 'startet neu' };

async function apiPost(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `${r.status} ${path}`);
  return data;
}

views.containers = (() => {
  let table, stateFilter = 'running', openStackName = null;
  const expanded = new Set();
  const policyLabel = p => p ? (POLICY_TXT[p.name] || p.name) + (p.name === 'on-failure' && p.max_retries ? ` (max. ${p.max_retries})` : '') : '–';
  const COLS = [
    { key: 'name', label: 'Name', fmt: r => r._group
        ? `<span class="tog" data-toggle="1">${expanded.has(r.name) ? '▾' : '▸'}</span><b>${esc(r.name)}</b> <span class="muted">(${r.count} Container)</span>`
        : `<span class="${r._member ? 'member' : ''}"><b>${esc(r.name)}</b></span>` },
    { key: 'project', label: 'Stack', fmt: r => esc(r.project || '') },
    { key: 'state', label: 'Status', sortVal: r => r._group ? r.running / r.count : (r.state === 'running' ? 1 : 0), fmt: r => r._group ? groupBadge(r) : stateBadge(r) },
    { key: 'restart', label: 'Neustart', title: 'Neustart-Richtlinie (restart policy)', sortVal: r => r._group ? r.policy : r.restart?.name,
      fmt: r => r._group ? (r.policy === '*' ? '<span class="badge warn">gemischt</span>' : `<span class="badge">${esc(POLICY_TXT[r.policy] || r.policy)}</span>`) : `<span class="muted">${esc(policyLabel(r.restart))}</span>` },
    { key: 'cpu', label: 'CPU %', num: true, title: '100 % = ein Kern', fmt: r => `<div class="cellbar">${fmtNum(r.cpu)}${bar(r.cpu / (state.sys?.cpu_threads || 1))}</div>` },
    { key: 'mem', label: 'RAM', num: true, fmt: r => `<div class="cellbar">${fmtBytes(r.mem)}${r.mem_limit ? bar(r.mem / r.mem_limit * 100) : ''}</div>` },
    { key: 'mem_limit', label: 'Limit', num: true, fmt: r => r.mem_limit ? fmtBytes(r.mem_limit, 0) : '<span class="muted">–</span>' },
    { key: 'procs', label: 'Prozesse', num: true },
    { key: 'io_read', label: 'I/O lesen', num: true, fmt: r => r.io_read ? fmtRate(r.io_read) : '–' },
    { key: 'io_write', label: 'I/O schreiben', num: true, fmt: r => r.io_write ? fmtRate(r.io_write) : '–' },
    { key: 'ports', label: 'Ports', sortVal: r => (r.ports || []).length, fmt: r => (r.ports || []).slice(0, 4).map(p => `<span class="badge">${esc(p)}</span>`).join(' ') + ((r.ports || []).length > 4 ? ' …' : '') },
    { key: 'image', label: 'Image', cls: 'cmd', fmt: r => esc(r.image || '') },
  ];

  function stateBadge(r) {
    const cls = r.state === 'running' ? (r.status.includes('unhealthy') ? 'warn' : 'ok') : r.state === 'restarting' ? 'warn' : '';
    return `<span class="badge ${cls}" title="${esc(r.status)}">${esc(r.status)}</span>`;
  }

  function jobOf(project) {
    const j = state.containers?.control?.jobs?.[project];
    return j && j.running ? j : null;
  }

  function groupBadge(g) {
    const j = jobOf(g.name);
    if (j) return `<span class="badge info">${ACTION_ING[j.action]} … ${j.done}/${j.total}</span>`;
    const cls = g.running === g.count ? (g.unhealthy ? 'warn' : 'ok') : g.running ? 'warn' : '';
    return `<span class="badge ${cls}">${g.running}/${g.count} laufend</span>`;
  }

  function init() {
    table = new SortTable($('#ctTable'), COLS, { sortKey: 'cpu', onRow: openRow });
    $('#ctSearch').oninput = render;
    $('#ctGroup').onchange = render;
    $$('#ctState button').forEach(b => b.onclick = () => {
      stateFilter = b.dataset.s;
      $$('#ctState button').forEach(x => x.classList.toggle('active', x === b));
      render();
    });
  }

  const matchState = c => stateFilter === 'all' || (stateFilter === 'running' ? c.state === 'running' : c.state !== 'running');

  function buildGroups(list) {
    const g = new Map();
    list.forEach(r => {
      const k = r.project || '(ohne Stack)';
      let e = g.get(k);
      if (!e) g.set(k, e = { _id: 'g:' + k, _group: true, name: k, project: r.project ? k : '', count: 0, running: 0, unhealthy: 0,
        cpu: 0, mem: 0, procs: 0, io_read: 0, io_write: 0, ports: [], members: [], policies: new Set() });
      e.count++; e.cpu += r.cpu; e.mem += r.mem; e.procs += r.procs; e.io_read += r.io_read; e.io_write += r.io_write;
      if (r.state === 'running') e.running++;
      if (r.status.includes('unhealthy')) e.unhealthy++;
      e.policies.add(r.restart?.name || 'no');
      e.ports.push(...(r.ports || [])); e.members.push(r);
    });
    g.forEach(e => e.policy = e.policies.size === 1 ? [...e.policies][0] : '*');
    return g;
  }

  function render() {
    if (!state.containers) return;
    const q = $('#ctSearch').value.trim().toLowerCase();
    const all = state.containers.containers;
    all.forEach(r => r._id = r.full_id);
    const hit = c => !q || [c.name, c.image, c.project, c.service].some(v => (v || '').toLowerCase().includes(q));
    if (!$('#ctGroup').checked) {
      table.render(all.filter(c => matchState(c) && hit(c)));
      return;
    }
    // Stacks: sichtbar, wenn ein Container zum Status-Filter passt; aufgeklappt mit allen Containern
    const groups = [...buildGroups(all.filter(hit)).values()].filter(g => g.members.some(matchState));
    const list = [];
    table.sort(groups).forEach(g => {
      list.push(g);
      if (expanded.has(g.name)) table.sort(g.members).forEach(m => list.push({ ...m, _member: true }));
    });
    table.render(list, false, true);
  }

  function openRow(r, tr, e) {
    if (!r._group) return openContainer(r);
    if (e?.target.closest('[data-toggle]') || !r.project) {
      expanded.has(r.name) ? expanded.delete(r.name) : expanded.add(r.name);
      return render();
    }
    openStack(r.name);
  }

  function openContainer(r) {
    openStackName = null;
    const procs = (state.procs?.processes || []).filter(p => p.container_id === r.full_id).sort((a, b) => b.cpu - a.cpu);
    openDrawer(`
      <h2>${esc(r.name)}</h2>
      <div class="statusline">${stateBadge(r)}${r.project ? `<a href="#containers" class="badge info" id="ctOpenStack">Stack ${esc(r.project)}</a>` : ''}${r.service ? `<span class="badge">Service ${esc(r.service)}</span>` : ''}</div>
      <div class="kv">
        <div>ID</div><div class="mono">${esc(r.id)}</div>
        <div>Image</div><div class="mono">${esc(r.image)}</div>
        <div>Erstellt</div><div>${fmtDate(r.created)}</div>
        <div>Neustart</div><div>${esc(policyLabel(r.restart))}</div>
        <div>CPU</div><div>${fmtPct(r.cpu)} (100 % = ein Kern)</div>
        <div>RAM</div><div>${fmtBytes(r.mem)}${r.mem_limit ? ' von ' + fmtBytes(r.mem_limit) : ' (kein Limit)'}</div>
        <div>I/O</div><div>${fmtRate(r.io_read)} lesen / ${fmtRate(r.io_write)} schreiben</div>
        <div>Ports</div><div>${(r.ports || []).map(p => `<span class="badge">${esc(p)}</span>`).join(' ') || '–'}</div>
      </div>
      <h3 class="muted" style="font-size:13px">Prozesse (${procs.length}) <a href="#processes" id="ctShowProcs" style="float:right">in Prozessliste öffnen →</a></h3>
      ${procs.length ? `<div class="tablewrap short"><table><thead><tr><th class="num">PID</th><th>Name</th><th class="num">CPU %</th><th class="num">RSS</th><th>Befehl</th></tr></thead><tbody>${procs.map(p => `<tr class="clickable" data-pid="${p.pid}"><td class="num">${p.pid}</td><td>${esc(p.name)}</td><td class="num">${fmtNum(p.cpu)}</td><td class="num">${fmtBytes(p.rss)}</td><td class="cmd">${esc(p.cmdline)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="muted">Prozessliste wird beim Öffnen der Prozess-Ansicht geladen.</div>'}`);
    $$('#drawerBody tr[data-pid]').forEach(tr => tr.onclick = () => openProcess(+tr.dataset.pid));
    if ($('#ctOpenStack')) $('#ctOpenStack').onclick = e => { e.preventDefault(); openStack(r.project); };
    $('#ctShowProcs').onclick = () => {
      closeDrawer();
      const sel = $('#procContainer');
      if (![...sel.options].some(o => o.value === r.name)) sel.insertAdjacentHTML('beforeend', `<option>${esc(r.name)}</option>`);
      sel.value = r.name;
    };
  }

  // ---------------------------------------------------------------- Stack-Steuerung
  function stackGroup(name) {
    return buildGroups(state.containers.containers.filter(c => c.project === name)).get(name);
  }

  function openStack(name) {
    const g = stackGroup(name);
    if (!g) return;
    openStackName = name;
    const ctl = state.containers.control || {};
    const locked = !ctl.enabled ? 'Steuerung ist deaktiviert (CONTROL_ENABLED=0).'
      : name === ctl.own_project ? 'Das ist der Stack des Dashboards selbst – er kann hier nicht gestoppt oder umgestellt werden.' : '';
    const dir = g.members.find(m => m.working_dir)?.working_dir;
    const pol = g.policy === '*' ? '' : g.policy;
    const retries = g.members.find(m => m.restart?.name === 'on-failure')?.restart.max_retries || 0;
    openDrawer(`
      <h2>Stack ${esc(name)}</h2>
      <div class="statusline" id="stkBadges"></div>
      ${dir ? `<div class="muted mono" style="font-size:12.5px">${esc(dir)}</div>` : ''}
      ${locked ? `<div class="notice info mt">${esc(locked)}</div>` : `
      <h3 class="muted" style="font-size:13px;margin-top:16px">Stack steuern</h3>
      <div class="toolbar" id="stkActions">
        <button class="btn" data-a="start">▶ Starten</button>
        <button class="btn" data-a="stop">■ Stoppen</button>
        <button class="btn" data-a="restart">↻ Neu starten</button>
      </div>
      <div id="stkConfirm"></div>
      <div id="stkJob" class="muted" style="font-size:12.5px"></div>
      <h3 class="muted" style="font-size:13px;margin-top:16px">Startverhalten (Neustart-Richtlinie)</h3>
      <div class="toolbar">
        <select id="stkPolicy">
          ${pol ? '' : '<option value="" selected>gemischt – bitte wählen</option>'}
          ${Object.entries(POLICY_TXT).map(([k, v]) => `<option value="${k}" ${k === pol ? 'selected' : ''}>${v} (${k})</option>`).join('')}
        </select>
        <label class="chk" id="stkRetriesWrap">max. Versuche <input type="number" id="stkRetries" min="0" max="100" value="${retries}" style="width:64px"></label>
        <button class="btn primary" id="stkPolicySave">Übernehmen</button>
      </div>
      <div id="stkPolicyMsg" style="font-size:12.5px"></div>
      <p class="muted" style="font-size:12px">
        <b>immer</b>: startet nach Absturz und mit Docker/dem Host, auch wenn der Stack vorher gestoppt wurde ·
        <b>außer manuell gestoppt</b>: wie immer, aber ein gestoppter Stack bleibt gestoppt ·
        <b>bei Fehler</b>: nur nach Absturz (Exit-Code ≠ 0) · <b>nie</b>: kein automatischer Start.<br>
        Die Änderung gilt sofort für die bestehenden Container. Erstellt <span class="mono">docker compose up</span> sie neu,
        gilt wieder der Wert aus der Compose-Datei – dauerhaft also dort <span class="mono">restart:</span> eintragen.
      </p>`}
      <h3 class="muted" style="font-size:13px;margin-top:16px">Container</h3>
      <div id="stkMembers"></div>`);
    if (!locked) {
      $$('#stkActions button').forEach(b => b.onclick = () => confirmAction(name, b.dataset.a));
      const syncRetries = () => $('#stkRetriesWrap').style.display = $('#stkPolicy').value === 'on-failure' ? '' : 'none';
      $('#stkPolicy').onchange = syncRetries;
      syncRetries();
      $('#stkPolicySave').onclick = () => savePolicy(name);
    }
    updateStack();
  }

  function updateStack() {
    if (!openStackName || !$('#drawer').classList.contains('open')) { openStackName = null; return; }
    const g = stackGroup(openStackName);
    if (!g || !$('#stkMembers')) return;
    $('#stkBadges').innerHTML = `${groupBadge(g)}<span class="badge info">CPU ${fmtPct(g.cpu)}</span><span class="badge info">RAM ${fmtBytes(g.mem)}</span>`;
    $('#stkMembers').innerHTML = `<div class="tablewrap short"><table><thead><tr><th>Name</th><th>Service</th><th>Status</th><th>Neustart</th><th class="num">CPU %</th><th class="num">RAM</th></tr></thead><tbody>${
      table.sort(g.members).map(m => `<tr class="clickable" data-id="${esc(m.full_id)}"><td><b>${esc(m.name)}</b></td><td>${esc(m.service)}</td><td>${stateBadge(m)}</td><td>${esc(policyLabel(m.restart))}</td><td class="num">${fmtNum(m.cpu)}</td><td class="num">${fmtBytes(m.mem)}</td></tr>`).join('')}</tbody></table></div>`;
    $$('#stkMembers tr[data-id]').forEach(tr => tr.onclick = () => openContainer(g.members.find(m => m.full_id === tr.dataset.id)));
    const job = state.containers.control?.jobs?.[openStackName];
    if ($('#stkJob') && job) {
      $('#stkJob').innerHTML = job.running
        ? `${ACTION_TXT[job.action]}: ${job.done}/${job.total} erledigt${job.current ? ' – gerade <b>' + esc(job.current) + '</b>' : ''} …`
        : `Zuletzt: <b>${ACTION_TXT[job.action]}</b> ${fmtAgo(job.finished)} – ${job.errors.length ? `<span class="crit">${job.errors.length} Fehler:</span><br>${job.errors.map(esc).join('<br>')}` : 'erfolgreich'}`;
      $$('#stkActions button').forEach(b => b.disabled = job.running);
    }
  }

  function confirmAction(name, action) {
    const g = stackGroup(name);
    const hint = action === 'stop' && g.members.some(m => m.restart?.name === 'always')
      ? '<br><span class="warn">Achtung: Container mit Richtlinie „immer“ starten nach einem Neustart von Docker/des Hosts wieder.</span>' : '';
    $('#stkConfirm').innerHTML = `<div class="notice warn">Stack <b>${esc(name)}</b> (${g.count} Container) wirklich ${ACTION_TXT[action].toLowerCase()}?${hint}
      <div class="toolbar" style="margin-top:8px"><button class="btn primary" id="stkYes">Ja, ${ACTION_TXT[action].toLowerCase()}</button><button class="btn" id="stkNo">Abbrechen</button></div></div>`;
    $('#stkNo').onclick = () => $('#stkConfirm').innerHTML = '';
    $('#stkYes').onclick = async () => {
      $('#stkConfirm').innerHTML = '';
      try {
        const job = await apiPost(`/api/stacks/${encodeURIComponent(name)}/action`, { action });
        state.containers.control.jobs[name] = job;
        updateStack();
        pollJob(name);
      } catch (err) {
        $('#stkJob').innerHTML = `<span class="crit">${esc(err.message)}</span>`;
      }
    };
  }

  async function pollJob(name) {
    for (let i = 0; i < 300; i++) {
      await new Promise(r => setTimeout(r, 1000));
      await refresh();
      if (!jobOf(name)) break;
    }
  }

  async function savePolicy(name) {
    const policy = $('#stkPolicy').value;
    if (!policy) return;
    $('#stkPolicyMsg').innerHTML = '<span class="muted">wird übernommen …</span>';
    try {
      const r = await apiPost(`/api/stacks/${encodeURIComponent(name)}/restart-policy`, { policy, max_retries: +$('#stkRetries').value || 0 });
      $('#stkPolicyMsg').innerHTML = r.errors.length
        ? `<span class="crit">${r.updated} geändert, ${r.errors.length} Fehler:</span><br>${r.errors.map(esc).join('<br>')}`
        : `<span class="ok">Für ${r.updated} Container übernommen.</span>`;
      await refresh();
    } catch (err) {
      $('#stkPolicyMsg').innerHTML = `<span class="crit">${esc(err.message)}</span>`;
    }
  }

  async function refresh() {
    state.containers = await api('/api/containers');
    const cs = state.containers.containers;
    const running = cs.filter(c => c.state === 'running');
    const unhealthy = cs.filter(c => c.status.includes('unhealthy')).length;
    const cpu = running.reduce((a, c) => a + c.cpu, 0), mem = running.reduce((a, c) => a + c.mem, 0);
    $('#ctSummary').innerHTML = state.containers.available ? `
      <span class="badge ok">${running.length} laufend</span><span class="badge">${cs.length - running.length} gestoppt</span>
      ${unhealthy ? `<span class="badge warn">${unhealthy} unhealthy</span>` : ''}
      <span class="badge info">CPU gesamt ${fmtPct(cpu)}</span><span class="badge info">RAM gesamt ${fmtBytes(mem)}</span>
      <span class="badge">${new Set(cs.map(c => c.project).filter(Boolean)).size} Stacks</span>`
      : '<span class="badge warn">Docker-Socket nicht erreichbar</span>';
    if (!state.procs) api('/api/processes').then(p => state.procs = p);
    render();
    updateStack();
  }

  return { init, refresh, enter: () => refresh() };
})();

// ============================================================== Speicher
views.storage = (() => {
  let scanId = null, scanPathView = null, scanTimer = null;
  const QUICK = ['/', '/home', '/var', '/var/lib/docker', '/var/log', '/data', '/opt', '/tmp'];

  function init() {
    $('#scanQuick').innerHTML = QUICK.map(p => `<button class="btn small mono" data-p="${p}">${p}</button>`).join('');
    $$('#scanQuick button').forEach(b => b.onclick = () => { $('#scanPath').value = b.dataset.p; startScan(); });
    $('#scanStart').onclick = startScan;
    $('#scanPath').onkeydown = e => { if (e.key === 'Enter') startScan(); };
    $('#scanCancel').onclick = async () => { if (scanId) await api('/api/storage/scan/' + scanId, { method: 'DELETE' }); };
    $('#scanHistory').onchange = () => { const id = $('#scanHistory').value; if (id) { scanId = id; scanPathView = null; pollScan(); } };
    $('#dfRefresh').onclick = () => loadDocker(true);
  }

  async function refresh() {
    const m = await api('/api/storage/mounts');
    m._t = Date.now();
    state.mounts = m;
    $('#stMounts').innerHTML = m.mounts.map(x => {
      const fc = x.forecast || {};
      const fcTxt = fc.per_day == null ? `<span class="muted">Prognose: noch zu wenig Verlauf (${fmtNum(fc.span_h || 0)} h)</span>`
        : fc.per_day <= 0 ? `<span class="muted">Trend: ${fmtBytes(fc.per_day)}/Tag (nicht wachsend)</span>`
          : `Trend <b>+${fmtBytes(fc.per_day)}/Tag</b> · voll in ca. <b class="${fc.days_until_full < 7 ? 'crit' : ''}">${fmtNum(fc.days_until_full, 0)} Tagen</b>`;
      return `<div class="mount">
        <div class="head"><b class="mono">${esc(x.mountpoint)}</b><span>${fmtPct(x.percent)}</span></div>
        ${bar(x.percent, level(x.percent, 85, 95))}
        <div class="muted" style="font-size:12.5px">${fmtBytes(x.used)} belegt · <b style="color:var(--text)">${fmtBytes(x.free)} frei</b> · ${fmtBytes(x.total)} gesamt · ${esc(x.fstype)} · <span class="mono">${esc(x.device)}</span>${x.aliases.length ? ' · auch unter ' + x.aliases.map(esc).join(', ') : ''}</div>
        <div style="font-size:12.5px">Inodes: ${fmtPct(x.inodes_percent)} (${fmtNum(x.inodes_used, 0)} / ${fmtNum(x.inodes_total, 0)}) · ${fcTxt}</div>
      </div>`;
    }).join('');
    const nvme = Object.fromEntries((m.nvme || []).map(n => [n.name, n]));
    const s = latest();
    const rows = Object.entries(m.disks).sort().map(([dev, v]) => {
      const n = nvme[dev.replace(/n\d+$/, '')];
      const temp = n ? s['temp:' + dev.replace(/n\d+$/, '')] : null;
      return `<tr><td class="mono"><b>${esc(dev)}</b></td><td>${n ? esc(n.model) : dev.startsWith('dm-') ? '<span class="muted">Device-Mapper (LVM/LUKS)</span>' : ''}</td>
        <td class="num">${fmtRate(v.disk_r)}</td><td class="num">${fmtRate(v.disk_w)}</td>
        <td class="num"><div class="cellbar">${fmtPct(v.disk_util)}${bar(v.disk_util)}</div></td><td class="num">${temp != null ? fmtNum(temp, 0) + ' °C' : ''}</td></tr>`;
    }).join('');
    $('#stDisks').innerHTML = `<div class="tablewrap short"><table><thead><tr><th>Gerät</th><th>Modell</th><th class="num">Lesen</th><th class="num">Schreiben</th><th class="num">Auslastung</th><th class="num">Temp.</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    const logs = await api('/api/storage/logs');
    $('#logsTotal').textContent = 'gesamt ' + fmtBytes(logs.total);
    $('#logsTable').tBodies[0].innerHTML = logs.logs.slice(0, 30).map(l => `<tr title="${esc(l.path)}"><td><b>${esc(l.container)}</b></td><td>${esc(l.state)}</td><td class="num ${l.size > 2 ** 31 ? 'crit' : ''}">${fmtBytes(l.size)}</td><td class="num muted">${fmtAgo(l.mtime)}</td></tr>`).join('')
      || '<tr><td class="empty">Keine json-Logs gefunden</td></tr>';
    loadScanHistory();
  }

  async function loadDocker(force = false) {
    const r = await api('/api/storage/docker' + (force ? '?refresh=1' : ''));
    $('#dfTime').innerHTML = r.running ? '<span class="spin"></span> berechne …' : r.time ? 'Stand: vor ' + fmtAgo(r.time) : '';
    const d = r.data;
    if (!d) { if (r.running) setTimeout(() => state.view === 'storage' && loadDocker(), 3000); return; }
    if (!d.available) { $('#dockerDf').innerHTML = '<div class="empty">Docker-Socket nicht erreichbar</div>'; return; }
    $('#dockerDf').innerHTML = `
      <div class="dfgrid">
        <div class="tile"><span class="muted">Images (${d.images.count})</span><b>${fmtBytes(d.images.size - d.images.shared)}</b><span class="muted">${d.images.unused_count} ungenutzt · ${fmtBytes(d.images.unused_size)}</span></div>
        <div class="tile"><span class="muted">Container (${d.containers.count})</span><b>${fmtBytes(d.containers.size_rw)}</b><span class="muted">beschreibbare Layer</span></div>
        <div class="tile"><span class="muted">Volumes (${d.volumes.count})</span><b>${fmtBytes(d.volumes.size)}</b><span class="muted">${d.volumes.unused_count} ungenutzt · ${fmtBytes(d.volumes.unused_size)}</span></div>
        <div class="tile"><span class="muted">Build-Cache (${d.build_cache.count})</span><b>${fmtBytes(d.build_cache.size)}</b><span class="muted">${fmtBytes(d.build_cache.reclaimable)} freigebbar</span></div>
      </div>
      <div class="muted mt" style="font-size:12.5px">Freigeben (manuell): <span class="mono">docker image prune -a</span> · <span class="mono">docker builder prune</span> · <span class="mono">docker volume prune</span></div>
      <div class="grid cols-2 mt">
        <div><div class="muted" style="margin-bottom:4px">Größte Images</div><div class="tablewrap short" style="max-height:300px"><table><tbody>${d.images.top.slice(0, 20).map(i => `<tr><td class="mono" style="word-break:break-all">${esc(i.tag)}</td><td>${i.used ? '<span class="badge ok">in Benutzung</span>' : '<span class="badge">ungenutzt</span>'}</td><td class="num">${fmtBytes(i.size)}</td></tr>`).join('')}</tbody></table></div></div>
        <div><div class="muted" style="margin-bottom:4px">Größte Volumes</div><div class="tablewrap short" style="max-height:300px"><table><tbody>${d.volumes.top.slice(0, 20).map(v => `<tr><td class="mono" style="word-break:break-all">${esc(v.name)}</td><td>${v.refs ? '' : '<span class="badge">ungenutzt</span>'}</td><td class="num">${fmtBytes(v.size)}</td></tr>`).join('')}</tbody></table></div></div>
      </div>`;
    if (r.running) setTimeout(() => state.view === 'storage' && loadDocker(), 3000);
  }

  async function loadScanHistory() {
    const r = await api('/api/storage/scans');
    const sel = $('#scanHistory');
    sel.innerHTML = '<option value="">Frühere Scans …</option>' + r.scans.map(s => `<option value="${s.id}">${esc(s.path)} · ${fmtBytes(s.bytes)} · vor ${fmtAgo(s.started)}${s.state === 'running' ? ' (läuft)' : ''}</option>`).join('');
    if (!scanId && r.scans.length) { scanId = r.scans[0].id; pollScan(); }
  }

  async function startScan() {
    const path = $('#scanPath').value.trim() || '/';
    const r = await api('/api/storage/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path }) });
    scanId = r.id;
    scanPathView = null;
    pollScan();
    loadScanHistory();
  }

  async function pollScan() {
    clearTimeout(scanTimer);
    if (!scanId) return;
    let r;
    try {
      r = await api(`/api/storage/scan/${scanId}` + (scanPathView ? '?path=' + encodeURIComponent(scanPathView) : ''));
    } catch (e) { scanId = null; return; }
    const s = r.summary;
    const running = s.state === 'running';
    $('#scanCancel').style.display = running ? '' : 'none';
    const stateTxt = { running: '<span class="spin"></span> läuft', done: 'fertig', cancelled: 'abgebrochen', error: 'Fehler: ' + esc(s.error) }[s.state];
    $('#scanStatus').innerHTML = `Scan <span class="mono">${esc(s.path)}</span>: ${stateTxt} · ${fmtBytes(s.bytes)} · ${fmtNum(s.files, 0)} Dateien · ${fmtNum(s.dirs, 0)} Verzeichnisse · ${fmtNum(s.duration)} s${s.errors ? ` · ${s.errors} Lesefehler` : ''}${running ? ` · <span class="mono">${esc(s.current)}</span>` : ''}`;
    renderScan(r.view);
    if (!running) {
      const l = await api(`/api/storage/scan/${scanId}/largest?limit=100`);
      $('#scanLargest').tBodies[0].innerHTML = l.files.map(f => `<tr><td class="mono" style="word-break:break-all">${esc(f.path)}</td><td class="num">${fmtBytes(f.size)}</td><td class="num muted" title="${fmtDate(f.mtime)}">${fmtAgo(f.mtime)}</td></tr>`).join('') || '<tr><td class="empty">–</td></tr>';
    } else {
      scanTimer = setTimeout(pollScan, 1000);
    }
  }

  function renderScan(v) {
    $('#scanResult').style.display = '';
    if (!v.found) { $('#scanTable').tBodies[0].innerHTML = '<tr><td class="empty">Noch keine Daten …</td></tr>'; return; }
    scanPathView = v.path;
    const parts = v.path.split('/').filter(Boolean);
    let acc = '';
    $('#scanCrumbs').innerHTML = `<a href="#" data-p="/">/</a>` + parts.map(p => { acc += '/' + p; return `<a href="#" data-p="${esc(acc)}">${esc(p)}</a>/`; }).join('')
      + ` <span class="muted" style="margin-left:8px">${fmtBytes(v.size)} · ${fmtNum(v.files, 0)} Dateien</span>`;
    $$('#scanCrumbs a').forEach(a => a.onclick = e => { e.preventDefault(); scanPathView = a.dataset.p; pollScan(); });
    const max = v.items.reduce((m, i) => Math.max(m, i.size), 0) || 1;
    const up = v.parent ? `<tr class="clickable" data-p="${esc(v.parent)}"><td colspan="4">⬑ ..</td></tr>` : '';
    $('#scanTable').tBodies[0].innerHTML = up + v.items.map(i => `
      <tr class="${i.type === 'dir' ? 'clickable' : ''}" data-p="${i.type === 'dir' ? esc(i.path) : ''}">
        <td class="mono" style="word-break:break-all">${i.type === 'dir' ? '📁' : i.type === 'link' ? '🔗' : '📄'} ${esc(i.name)}</td>
        <td style="width:30%">${bar(i.size / max * 100, 'alt')}</td>
        <td class="num">${fmtBytes(i.size)}</td>
        <td class="num muted">${v.size ? fmtPct(i.size / v.size * 100) : ''}${i.files != null ? ` · ${fmtNum(i.files, 0)} D.` : ''}</td>
      </tr>`).join('') + (v.more_files ? `<tr><td colspan="4" class="muted">… ${v.more_files} weitere Dateien</td></tr>` : '');
    $$('#scanTable tr[data-p]').forEach(tr => { if (tr.dataset.p) tr.onclick = () => { scanPathView = tr.dataset.p; pollScan(); }; });
  }

  return { init, refresh, enter: () => { refresh(); loadDocker(); } };
})();

// ============================================================== Netzwerk
views.network = (() => {
  let ifChart, data = null;
  function init() {
    ifChart = chart('#cIf', { format: v => fmtRate(v), series: [] });
    $('#netVirtual').onchange = render;
    $('#portSearch').oninput = renderPorts;
  }
  async function refresh() {
    data = await api('/api/network');
    render();
    renderPorts();
    $('#tcpStates').innerHTML = Object.entries(data.states).map(([k, v]) => `<span class="badge ${k === 'ESTABLISHED' ? 'ok' : ''}">${v} ${esc(k)}</span>`).join('') || '<span class="muted">keine</span>';
    $('#remoteTable').tBodies[0].innerHTML = data.top_remote.map(r => `<tr><td class="mono">${esc(r.ip)}</td><td class="num">${r.count}</td></tr>`).join('') || '<tr><td class="empty">–</td></tr>';
  }
  function render() {
    if (!data) return;
    const s = latest();
    const showVirt = $('#netVirtual').checked;
    const rows = data.interfaces.filter(i => showVirt || i.physical);
    $('#ifTable').tBodies[0].innerHTML = `<tr><th>Name</th><th>Status</th><th>Adressen</th><th class="num">RX</th><th class="num">TX</th><th class="num">Gesamt RX / TX</th><th class="num">Fehler/Drops</th></tr>` + rows.map(i => `
      <tr><td class="mono"><b>${esc(i.name)}</b><div class="muted" style="font-size:11px">${esc(i.mac)}</div></td>
      <td>${i.up ? `<span class="badge ok">up</span>` : '<span class="badge">down</span>'} ${i.speed ? `<span class="muted">${i.speed >= 1000 ? fmtNum(i.speed / 1000, 1) + ' Gbit/s' : i.speed + ' Mbit/s'}</span>` : ''}</td>
      <td class="mono" style="font-size:11.5px">${i.addresses.map(esc).join('<br>')}</td>
      <td class="num">${fmtRate(s['net_rx:' + i.name])}</td><td class="num">${fmtRate(s['net_tx:' + i.name])}</td>
      <td class="num">${fmtBytes(i.bytes_recv)} / ${fmtBytes(i.bytes_sent)}</td>
      <td class="num ${i.errin + i.errout + i.dropin + i.dropout ? 'warn' : 'muted'}">${i.errin + i.errout} / ${i.dropin + i.dropout}</td></tr>`).join('')
      + (showVirt ? '' : `<tr><td colspan="7" class="muted">${data.interfaces.length - rows.length} virtuelle Schnittstellen (Bridges) und ${data.veth_count} veth-Paare ausgeblendet</td></tr>`);
    live();
  }
  function live() {
    if (!data) return;
    const phys = data.interfaces.filter(i => i.physical && i.up).map(i => i.name);
    const keys = phys.flatMap(n => ['net_rx:' + n, 'net_tx:' + n]);
    if (ifChart.series.length !== keys.length) ifChart.setSeries(keys.map(k => ({ key: k, label: k.replace('net_rx:', '↓ ').replace('net_tx:', '↑ ') })));
    const d = liveSeries(900, keys);
    ifChart.setData(d.ts, d.data);
  }
  function renderPorts() {
    if (!data) return;
    const q = $('#portSearch').value.trim().toLowerCase();
    const rows = data.listening.filter(p => !q || String(p.port).includes(q) || (p.process || '').toLowerCase().includes(q) || (p.container || '').toLowerCase().includes(q));
    $('#portTable').tBodies[0].innerHTML = `<tr><th class="num">Port</th><th>Proto</th><th>Adresse</th><th>Prozess</th><th>Container</th></tr>` + rows.map(p => `
      <tr class="clickable" data-pid="${p.pid || ''}"><td class="num"><b>${p.port}</b></td><td>${p.proto}</td><td class="mono">${esc(p.ip)}</td>
      <td>${esc(p.process || '–')} <span class="muted">${p.pid || ''}</span></td><td>${p.container ? `<span class="badge info">${esc(p.container)}</span>` : ''}</td></tr>`).join('');
    $$('#portTable tr[data-pid]').forEach(tr => { if (tr.dataset.pid) tr.onclick = () => openProcess(+tr.dataset.pid); });
  }
  return { init, refresh, live, enter: () => refresh() };
})();

// ============================================================== Analyse
views.analysis = (() => {
  let range = '24h';
  const charts = {};
  const PCT = v => fmtNum(v, 0) + ' %';
  const DEF = [
    { id: 'cpu', title: 'CPU-Auslastung', format: PCT, max: 100, series: [{ key: 'cpu', label: 'Ø CPU', fill: true }, { key: 'cpu@max', label: 'Spitze', color: '--c4' }, { key: 'cpu_iowait', label: 'I/O-Wait', color: '--c3' }] },
    { id: 'load', title: 'Systemlast', format: v => fmtNum(v, 1), series: [{ key: 'load1', label: '1 min' }, { key: 'load5', label: '5 min', color: '--c3' }, { key: 'load15', label: '15 min', color: '--c4' }] },
    { id: 'mem', title: 'Arbeitsspeicher & Swap', format: v => fmtBytes(v, 0), series: [{ key: 'mem_used', label: 'RAM belegt', color: '--c2', fill: true }, { key: 'mem_used@max', label: 'RAM Spitze', color: '--c3' }, { key: 'swap_used', label: 'Swap', color: '--c4' }] },
    { id: 'gpu', title: 'GPU', format: PCT, max: 100, series: [{ key: 'gpu_busy', label: 'Ø Auslastung', color: '--c5', fill: true }, { key: 'gpu_busy@max', label: 'Spitze', color: '--c4' }] },
    { id: 'gpumem', title: 'GPU-Speicher', format: v => fmtBytes(v, 0), series: [{ key: 'vram_used', label: 'VRAM', color: '--c1', fill: true }, { key: 'gtt_used', label: 'GTT', color: '--c6' }] },
    { id: 'net', title: 'Netzwerk', format: v => fmtRate(v), series: [{ key: 'net_rx', label: 'Empfangen', color: '--c6', fill: true }, { key: 'net_tx', label: 'Gesendet', color: '--c3' }, { key: 'net_rx@max', label: 'RX Spitze', color: '--c1' }] },
    { id: 'disk', title: 'Datenträger-I/O', format: v => fmtRate(v), series: [{ key: 'disk_r', label: 'Lesen', color: '--c2', fill: true }, { key: 'disk_w', label: 'Schreiben', color: '--c4' }] },
    { id: 'temp', title: 'Temperaturen', format: v => fmtNum(v, 0) + ' °C', series: [] },
    { id: 'psi', title: 'Ressourcendruck (PSI)', format: v => fmtNum(v, 1) + ' %', series: [{ key: 'psi_cpu', label: 'CPU' }, { key: 'psi_mem', label: 'RAM', color: '--c2' }, { key: 'psi_io', label: 'I/O', color: '--c4' }] },
    { id: 'power', title: 'GPU-Leistung & Prozesse', format: v => fmtNum(v, 0), series: [{ key: 'gpu_power', label: 'GPU W', color: '--c5' }, { key: 'procs', label: 'Prozesse /10', color: '--c8' }] },
  ];
  const STAT_ROWS = [
    ['cpu', 'CPU', PCT], ['cpu_iowait', 'I/O-Wait', PCT], ['load5', 'Last (5 min)', v => fmtNum(v, 2)],
    ['mem_used', 'RAM belegt', v => fmtBytes(v)], ['swap_used', 'Swap belegt', v => fmtBytes(v)],
    ['gpu_busy', 'GPU', PCT], ['vram_used', 'VRAM', v => fmtBytes(v)], ['gtt_used', 'GTT', v => fmtBytes(v)], ['gpu_power', 'GPU-Leistung', v => fmtNum(v, 1) + ' W'],
    ['cpu_temp', 'CPU-Temperatur', v => fmtNum(v, 0) + ' °C'], ['gpu_temp', 'GPU-Temperatur', v => fmtNum(v, 0) + ' °C'],
    ['net_rx', 'Netz empfangen', fmtRate], ['net_tx', 'Netz gesendet', fmtRate], ['disk_r', 'Disk lesen', fmtRate], ['disk_w', 'Disk schreiben', fmtRate],
    ['psi_cpu', 'PSI CPU', v => fmtNum(v, 1) + ' %'], ['psi_mem', 'PSI RAM', v => fmtNum(v, 1) + ' %'], ['psi_io', 'PSI I/O', v => fmtNum(v, 1) + ' %'],
    ['procs', 'Prozesse', v => fmtNum(v, 0)],
  ];

  function init() {
    $('#anCharts').innerHTML = DEF.map(d => `<div class="card"><h3>${d.title}</h3><div class="chart" id="an_${d.id}"></div></div>`).join('');
    DEF.forEach(d => charts[d.id] = chart('#an_' + d.id, { format: d.format, max: d.max ?? null, series: d.series }));
    charts.ctCpu = chart('#anCtCpu', { format: v => fmtNum(v, 0) + ' %', series: [] });
    charts.ctMem = chart('#anCtMem', { format: v => fmtBytes(v, 0), series: [] });
    charts.disk_usage = chart('#anDisk', { format: v => fmtNum(v, 0) + ' %', max: 100, series: [] });
    $$('#anRange button').forEach(b => b.onclick = () => {
      range = b.dataset.r;
      $$('#anRange button').forEach(x => x.classList.toggle('active', x === b));
      refresh();
    });
  }

  function health() {
    const h = state.health;
    if (!h) return;
    $('#anHealthSummary').innerHTML = ['crit', 'warn', 'info', 'ok'].map(l => `<span class="badge ${l}">${h.summary[l]} ${LEVEL_TXT[l]}</span>`).join('');
    $('#anHealth').innerHTML = h.items.map(findingHtml).join('');
    const fc = h.forecast || {};
    $('#anForecast').innerHTML = `<table class="stats"><thead><tr><th>Mountpoint</th><th class="num">Belegt</th><th class="num">Frei</th><th class="num">Trend / Tag</th><th class="num">Voll in</th><th class="num">Datenbasis</th></tr></thead><tbody>`
      + (state.mounts?.mounts || []).map(m => {
        const f = fc[m.mountpoint] || {};
        return `<tr><td class="mono">${esc(m.mountpoint)}</td><td class="num">${fmtPct(m.percent)}</td><td class="num">${fmtBytes(m.free)}</td>
          <td class="num">${f.per_day == null ? '–' : (f.per_day > 0 ? '+' : '') + fmtBytes(f.per_day)}</td>
          <td class="num">${f.days_until_full == null ? '–' : fmtNum(f.days_until_full, 0) + ' Tage'}</td><td class="num muted">${fmtNum(f.span_h || 0)} h</td></tr>`;
      }).join('') + '</tbody></table>';
  }

  async function refresh() {
    const keys = ['cpu', 'cpu_iowait', 'load1', 'load5', 'load15', 'mem_used', 'mem_total', 'swap_used', 'gpu_busy', 'vram_used', 'gtt_used', 'gpu_power',
      'net_rx', 'net_tx', 'disk_r', 'disk_w', 'cpu_temp', 'gpu_temp', '*temp:', 'psi_cpu', 'psi_mem', 'psi_io', 'procs'];
    const [h, ct, top, disk] = await Promise.all([
      api(`/api/analysis/history?range=${range}&keys=${encodeURIComponent(keys.join(','))}`),
      api(`/api/analysis/history?range=${range}&keys=${encodeURIComponent('*ct_cpu:,*ct_mem:')}&points=300`),
      api(`/api/analysis/top?range=${range}`),
      api(`/api/analysis/disk?range=${['15m', '1h', '6h', '24h'].includes(range) ? '7d' : range}`),
    ]);
    if (!state.mounts) state.mounts = await api('/api/storage/mounts');
    $('#anInfo').textContent = `Quelle: ${h.source === 'live' ? 'Live-Puffer' : 'Minutenwerte'} · Auflösung ${fmtDur(h.resolution)} · abgedeckt ${fmtDur(h.coverage)}`
      + (h.coverage < ({ '15m': 900, '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800, '30d': 2592000 }[range] * 0.9) ? ' (Datensammlung läuft noch nicht so lange)' : '');

    const data = {};
    Object.entries(h.series).forEach(([k, v]) => data[k] = v);
    Object.entries(h.series_max).forEach(([k, v]) => data[k + '@max'] = v);
    data['procs'] = (h.series.procs || []).map(v => v == null ? null : v / 10);
    const tkeys = ['cpu_temp', 'gpu_temp', ...Object.keys(h.series).filter(k => k.startsWith('temp:'))].filter(k => h.stats[k]);
    charts.temp.setSeries(tkeys.map(k => ({ key: k, label: sensorLabel(k) })));
    DEF.forEach(d => charts[d.id].setData(h.ts, data));

    // Statistik
    $('#anStats').tBodies[0].innerHTML = `<tr><th>Metrik</th><th class="num">Min</th><th class="num">Ø</th><th class="num">p95</th><th class="num">Max</th><th class="num">Aktuell</th></tr>`
      + STAT_ROWS.filter(([k]) => h.stats[k]).map(([k, label, f]) => {
        const s = h.stats[k];
        return `<tr><td>${label}</td><td class="num">${f(s.min)}</td><td class="num">${f(s.avg)}</td><td class="num">${f(s.p95)}</td><td class="num"><b>${f(s.max)}</b></td><td class="num muted">${f(s.last)}</td></tr>`;
      }).join('');

    // Container: Top 8 nach Ø
    const topKeys = prefix => Object.keys(ct.stats).filter(k => k.startsWith(prefix) && ct.stats[k]).sort((a, b) => ct.stats[b].avg - ct.stats[a].avg).slice(0, 8);
    const ck = topKeys('ct_cpu:'), mk = topKeys('ct_mem:');
    charts.ctCpu.setSeries(ck.map(k => ({ key: k, label: k.slice(7) })));
    charts.ctCpu.setData(ct.ts, ct.series);
    charts.ctMem.setSeries(mk.map(k => ({ key: k, label: k.slice(7) })));
    charts.ctMem.setData(ct.ts, ct.series);

    // Top-Prozesse
    const procRow = (r, main) => `<tr><td><b>${esc(r.name)}</b>${r.container ? ` <span class="badge info">${esc(r.container)}</span>` : ''}</td><td class="num">${main}</td><td class="num muted">${r.count}×</td><td class="num muted" title="Anteil der Minuten, in denen die Gruppe in den Top-Listen war">${r.presence} %</td></tr>`;
    const head = (a, b) => `<tr><th>Prozessgruppe</th><th class="num">${a}</th><th class="num">Anzahl</th><th class="num">Präsenz</th></tr>`;
    $('#anTopCpu').tBodies[0].innerHTML = top.minutes ? head('Ø CPU % / Spitze') + top.by_cpu.map(r => procRow(r, `${fmtNum(r.cpu_avg)} / ${fmtNum(r.cpu_peak)}`)).join('') : '<tr><td class="empty">Noch keine Minutenwerte – nach einigen Minuten verfügbar.</td></tr>';
    $('#anTopMem').tBodies[0].innerHTML = top.minutes ? head('Ø RSS / Spitze') + top.by_mem.map(r => procRow(r, `${fmtBytes(r.rss_avg)} / ${fmtBytes(r.rss_peak)}`)).join('') : '<tr><td class="empty">Noch keine Minutenwerte – nach einigen Minuten verfügbar.</td></tr>';

    // Belegungsverlauf der Dateisysteme
    const mps = Object.keys(disk);
    const tsSet = [...new Set(mps.flatMap(mp => disk[mp].map(r => r[0])))].sort((a, b) => a - b);
    const dd = {};
    mps.forEach(mp => { const m = new Map(disk[mp].map(r => [r[0], r[1] / r[2] * 100])); dd[mp] = tsSet.map(t => m.get(t) ?? null); });
    charts.disk_usage.setSeries(mps.map(mp => ({ key: mp, label: mp })));
    charts.disk_usage.setData(tsSet, dd);
    health();
  }

  return { init, refresh, health, enter: () => refresh() };
})();

// ============================================================== Start
(async function main() {
  Object.values(views).forEach(v => v.init?.());
  await loadSystem().catch(console.warn);
  await pollLive().catch(console.warn);
  showView(location.hash.slice(1) || 'overview');
  pollHealth().catch(console.warn);
  views.overview.slow().catch(console.warn);
  every(2000, pollLive);
  every(10000, pollHealth);
  every(5000, () => views.overview.slow(), 'overview');
  every(3000, () => views.processes.refresh(), 'processes');
  every(3000, () => views.containers.refresh(), 'containers');
  every(30000, () => views.storage.refresh(), 'storage');
  every(5000, () => views.network.refresh(), 'network');
  every(60000, () => views.analysis.refresh(), 'analysis');
  every(300000, loadSystem);
})();
