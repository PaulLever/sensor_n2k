#!/usr/bin/env node
'use strict';

/*
 * bus-monitor-server.js — read-only N2K bus/device visibility webapp.
 *
 * Connects to bridge.js's local event bus (ws://127.0.0.1:3010), tracks
 * which source addresses are on the bus and which PGNs each is sending,
 * and shows live CAN bus error counts. Device *discovery* state (what's
 * currently on the bus, PGN counts) is pure in-memory and resets on
 * restart, but device *names* — auto-learned Product Info and any
 * user-set custom label — are persisted to disk (see NAMES_FILE below)
 * so they survive a restart even if the device isn't on the bus yet.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

let getPGNWithNumber = null;
try {
  ({ getPGNWithNumber } = require('@canboat/ts-pgns'));
} catch (e) {
  console.warn('[BUSMON] @canboat/ts-pgns not found — PGN mnemonics will show as "?"; ' +
    'run npm install in this directory.');
}

const PORT = 3003;
const LOCAL_BUS_URL = 'ws://127.0.0.1:3010';

/* src -> { lastSeen, name, manufacturer, uniqueNumber, productName,
 *          customName, pgns: Map(pgn -> {count, lastSeen}) } */
const devices = new Map();

let busState = { canState: null, claimedSA: null, uptimeS: null, rxFrameCount: null,
  dropCount: null, txErrCnt: null, rxErrCnt: null };

/* ------------------------------------------------------------------ */
/* Persistent device names                                             */
/*                                                                      */
/* Keyed by "<manufacturerCode>:<uniqueNumber>" — the two fields from   */
/* PGN 60928 (Address Claim) that together identify a physical device   */
/* regardless of which source address it currently holds (SA can be     */
/* reassigned on conflict, especially across reboots). Falls back to    */
/* "src:<n>" for a device we haven't seen an Address Claim from yet —    */
/* that key isn't stable across a reboot, so a custom name set before    */
/* the real identity is known may need to be re-set once it is.         */
/* ------------------------------------------------------------------ */

const NAMES_FILE = '/etc/sensor_n2k/bus-monitor-names.json';

let namesStore = {};
try {
  namesStore = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') {
    console.warn('[BUSMON] failed to read', NAMES_FILE, '—', e.message);
  }
}

let saveTimer = null;
function saveNamesStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(NAMES_FILE), { recursive: true });
      fs.writeFileSync(NAMES_FILE, JSON.stringify(namesStore, null, 2));
    } catch (e) {
      console.warn('[BUSMON] failed to save', NAMES_FILE, '—', e.message);
    }
  }, 500);
}

function identityKeyFor(dev) {
  return (dev.manufacturer && dev.uniqueNumber != null)
    ? `${dev.manufacturer}:${dev.uniqueNumber}`
    : `src:${dev.src}`;
}

/** Pull any previously-learned name onto a device once its identity is
 *  known (e.g. it reconnected on a different source address). */
function applyPersistedName(dev) {
  const stored = namesStore[identityKeyFor(dev)];
  if (!stored) return;
  if (stored.customName && !dev.customName) dev.customName = stored.customName;
  if (stored.productName && !dev.productName) dev.productName = stored.productName;
}

/** Record a newly-learned (auto) field so it survives a restart. */
function persistLearned(dev, field) {
  const key = identityKeyFor(dev);
  const entry = namesStore[key] || {};
  if (entry[field] === dev[field]) return;
  namesStore[key] = { ...entry, [field]: dev[field] };
  if (dev.manufacturer) namesStore[key].manufacturer = dev.manufacturer;
  saveNamesStore();
}

/** User-set override, from the webapp's rename control. Pass name=null/''
 *  to clear the override and fall back to the auto-learned product name. */
function setCustomName(src, name) {
  const dev = devices.get(src);
  if (!dev) return false;
  dev.customName = name || null;
  dev.name = dev.customName || dev.productName || null;
  const key = identityKeyFor(dev);
  const entry = namesStore[key] || {};
  if (dev.customName) {
    namesStore[key] = { ...entry, customName: dev.customName };
  } else {
    namesStore[key] = { ...entry };
    delete namesStore[key].customName;
  }
  if (dev.manufacturer) namesStore[key].manufacturer = dev.manufacturer;
  saveNamesStore();
  return true;
}

function pgnMeta(pgn) {
  if (!getPGNWithNumber) return { Id: '?', Description: '?' };
  try {
    const defs = getPGNWithNumber(pgn);
    if (defs && defs.length > 0) return { Id: defs[0].Id, Description: defs[0].Description };
  } catch (e) { /* unknown PGN */ }
  return { Id: '?', Description: 'Unknown PGN' };
}

function onPgnEvent(evt) {
  let dev = devices.get(evt.src);
  if (!dev) {
    dev = { src: evt.src, lastSeen: 0, name: null, manufacturer: null,
      uniqueNumber: null, productName: null, customName: null, pgns: new Map() };
    devices.set(evt.src, dev);
  }
  dev.lastSeen = Date.now();

  let p = dev.pgns.get(evt.pgn);
  if (!p) {
    p = { pgn: evt.pgn, count: 0, lastSeen: 0, ...pgnMeta(evt.pgn) };
    dev.pgns.set(evt.pgn, p);
  }
  p.count++;
  p.lastSeen = Date.now();

  /* PGN 60928 (ISO Address Claim) / 126996 (Product Info) carry
   * manufacturer/device-name fields — capture them onto the device entry
   * when seen, best-effort (field names vary by canboatjs version). */
  if (evt.pgn === 60928) {
    dev.manufacturer = evt.fields.manufacturerCode ?? evt.fields['Manufacturer Code'] ?? dev.manufacturer;
    dev.uniqueNumber = evt.fields.uniqueNumber ?? evt.fields['Unique Number'] ?? dev.uniqueNumber;
  }
  if (evt.pgn === 126996) {
    const modelId = evt.fields.modelId ?? evt.fields['Model ID'] ?? dev.productName;
    dev.manufacturer = evt.fields.manufacturerCode ?? evt.fields['Manufacturer Code'] ?? dev.manufacturer;
    if (modelId !== dev.productName) {
      dev.productName = modelId;
      persistLearned(dev, 'productName');
    }
  }

  /* Identity (manufacturer + uniqueNumber) may only just have become known
   * on this event — pick up any name learned for it on a previous run or
   * a previous source address. */
  applyPersistedName(dev);
  dev.name = dev.customName || dev.productName || null;
}

function onBusStateEvent(evt) {
  busState = { ...busState, ...evt };
  delete busState.type;
}

let localBusWs = null;

function connectLocalBus() {
  const ws = new WebSocket(LOCAL_BUS_URL);
  localBusWs = ws;
  ws.on('open', () => console.log('[BUSMON] Connected to local bus', LOCAL_BUS_URL));
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'pgn') { onPgnEvent(msg); broadcastSnapshot(); }
    else if (msg.type === 'busstate') { onBusStateEvent(msg); broadcastSnapshot(); }
  });
  ws.on('error', (e) => console.warn('[BUSMON] local bus error:', e.message));
  ws.on('close', () => {
    if (localBusWs === ws) localBusWs = null;
    console.warn('[BUSMON] local bus disconnected, retrying in 3s…');
    setTimeout(connectLocalBus, 3000);
  });
}

/** Ask Zephyr to broadcast an ISO Request (PGN 59904) for PGN 60928, so
 *  passive devices that only transmit at their own power-on (an
 *  instrument display, say) get prompted to respond. Returns false if
 *  the local bus isn't currently connected. */
function requestDiscovery() {
  if (!localBusWs || localBusWs.readyState !== WebSocket.OPEN) return false;
  localBusWs.send(JSON.stringify({ type: 'discover' }));
  return true;
}

function snapshot() {
  return {
    busState,
    devices: Array.from(devices.values()).map(d => ({
      src: d.src, lastSeen: d.lastSeen, name: d.name, manufacturer: d.manufacturer,
      customName: d.customName, productName: d.productName,
      pgnCount: d.pgns.size,
      totalFrames: Array.from(d.pgns.values()).reduce((a, p) => a + p.count, 0),
      pgns: Array.from(d.pgns.values()),
    })),
  };
}

const webClients = new Set();
function broadcastSnapshot() {
  if (webClients.size === 0) return;
  const line = JSON.stringify({ type: 'snapshot', ...snapshot() });
  for (const sock of webClients) {
    if (sock.readyState === WebSocket.OPEN) sock.send(line);
  }
}

const WEBAPP_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>sensor_n2k Bus Monitor</title>
<style>
body{font-family:sans-serif;max-width:1000px;margin:2em auto;padding:0 1em}
table{border-collapse:collapse;width:100%;margin-bottom:1em}
th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;font-size:14px}
th{background:#f0f0f0}
.health{display:flex;gap:2em;margin-bottom:1em;font-size:15px}
.health div{background:#f5f5f5;padding:8px 14px;border-radius:6px}
.bad{color:#c00;font-weight:bold}
.pgns{display:none}
tr.dev{cursor:pointer}
</style></head>
<body>
<h1>sensor_n2k — Bus Monitor</h1>
<p>
<button onclick="discover()">Discover Devices</button>
<span id="discover-msg" style="margin-left:1em;color:#666"></span>
<span style="margin-left:1em;color:#999;font-size:.85em">
  Also polls automatically every 3 min — use this for an immediate check
  (e.g. right after a device that's already running, like an instrument
  display, doesn't show up on its own).
</span>
</p>
<div class="health" id="health"></div>
<table id="dev-table"><thead><tr><th>Src</th><th>Name</th><th>Mfg</th><th>PGNs</th><th>Total Frames</th><th>Last Seen</th></tr></thead><tbody></tbody></table>

<script>
function fmtAge(ts) {
  if (!ts) return '-';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function render(data) {
  const h = data.busState || {};
  document.getElementById('health').innerHTML = \`
    <div>CAN state: <b class="\${h.canState > 0 ? 'bad' : ''}">\${h.canState ?? '?'}</b></div>
    <div>TX errors: <b class="\${h.txErrCnt ? 'bad' : ''}">\${h.txErrCnt ?? '?'}</b></div>
    <div>RX errors: <b class="\${h.rxErrCnt ? 'bad' : ''}">\${h.rxErrCnt ?? '?'}</b></div>
    <div>RX frames: \${h.rxFrameCount ?? '?'}</div>
    <div>Drop count: <b class="\${h.dropCount ? 'bad' : ''}">\${h.dropCount ?? '?'}</b></div>
    <div>Claimed SA: 0x\${(h.claimedSA ?? 0).toString(16)}</div>
  \`;

  const tbody = document.querySelector('#dev-table tbody');
  tbody.innerHTML = '';
  (data.devices || []).sort((a, b) => a.src - b.src).forEach(d => {
    const tr = document.createElement('tr');
    tr.className = 'dev';
    tr.innerHTML = \`<td>0x\${d.src.toString(16)} (\${d.src})</td>
      <td>\${escapeHtml(d.name || '-')} <a href="#" class="rename" title="Rename">✎</a></td>
      <td>\${escapeHtml(d.manufacturer ?? '-')}</td><td>\${d.pgnCount}</td><td>\${d.totalFrames}</td><td>\${fmtAge(d.lastSeen)}</td>\`;
    tr.onclick = () => togglePgns(d.src);
    tr.querySelector('.rename').onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      renameDevice(d.src, d.customName || '');
    };
    tbody.appendChild(tr);

    const detailTr = document.createElement('tr');
    detailTr.className = 'pgns pgns-' + d.src;
    detailTr.style.display = 'none';
    const inner = document.createElement('td');
    inner.colSpan = 6;
    const t = document.createElement('table');
    t.innerHTML = '<thead><tr><th>PGN</th><th>Mnemonic</th><th>Description</th><th>Count</th><th>Last</th></tr></thead>';
    const tb = document.createElement('tbody');
    d.pgns.sort((a, b) => a.pgn - b.pgn).forEach(p => {
      const r = document.createElement('tr');
      r.innerHTML = \`<td>\${p.pgn}</td><td>\${p.Id}</td><td>\${p.Description}</td><td>\${p.count}</td><td>\${fmtAge(p.lastSeen)}</td>\`;
      tb.appendChild(r);
    });
    t.appendChild(tb);
    inner.appendChild(t);
    detailTr.appendChild(inner);
    tbody.appendChild(detailTr);
  });
}

function togglePgns(src) {
  document.querySelectorAll('.pgns-' + src).forEach(el => {
    el.style.display = el.style.display === 'none' ? '' : 'none';
  });
}

async function renameDevice(src, current) {
  const name = prompt('Device name (leave blank to clear override and fall back to the auto-detected name):', current);
  if (name === null) return;   /* cancelled */
  try {
    const r = await fetch('/api/device-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src, name }),
    }).then(r => r.json());
    if (!r.ok) { alert('Failed: ' + (r.error || 'unknown error')); return; }
    fetch('/api/bus').then(r => r.json()).then(render);
  } catch (e) {
    alert('Failed: ' + e.message);
  }
}

async function discover() {
  const msgEl = document.getElementById('discover-msg');
  msgEl.textContent = 'Requesting…';
  try {
    const r = await fetch('/api/discover', { method: 'POST' }).then(r => r.json());
    msgEl.textContent = r.ok
      ? 'Sent — new/passive devices should appear within a few seconds.'
      : 'Failed: ' + (r.error || 'unknown error');
  } catch (e) {
    msgEl.textContent = 'Failed: ' + e.message;
  }
  setTimeout(() => { msgEl.textContent = ''; }, 8000);
}

fetch('/api/bus').then(r => r.json()).then(render);
const ws = new WebSocket('ws://' + location.hostname + ':3003');
ws.onmessage = (ev) => render(JSON.parse(ev.data));
</script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/bus') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/discover') {
    const sent = requestDiscovery();
    res.writeHead(sent ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: sent,
      error: sent ? undefined : 'local bus not connected' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/device-name') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid JSON' }));
        return;
      }
      const src = Number(parsed.src);
      const name = typeof parsed.name === 'string' ? parsed.name.trim().slice(0, 64) : '';
      if (!Number.isInteger(src)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'src must be an integer' }));
        return;
      }
      const ok = setCustomName(src, name);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok, error: ok ? undefined : 'unknown device' }));
      if (ok) broadcastSnapshot();
    });
    return;
  }
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(WEBAPP_HTML);
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });
wss.on('connection', (sock) => {
  webClients.add(sock);
  sock.send(JSON.stringify({ type: 'snapshot', ...snapshot() }));
  sock.on('close', () => webClients.delete(sock));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[BUSMON] Listening on http://0.0.0.0:${PORT}`);
});

connectLocalBus();
