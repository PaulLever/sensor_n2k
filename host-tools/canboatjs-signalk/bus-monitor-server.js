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
const { SHARED_STYLE, navHtml } = require('./shared-ui');

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

let busState = { canState: null, claimedSA: null, saConfirmed: null, uptimeS: null,
  rxFrameCount: null, dropCount: null, txErrCnt: null, rxErrCnt: null };

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
      uniqueNumber: null, productName: null, customName: null, deviceClass: null, pgns: new Map() };
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
    /* deviceClass ("Display", "Navigation", "Communication", …) is part of
     * the SAME mandatory Address Claim every device already sends — unlike
     * Product Info (126996), which is optional and which several real
     * Garmin units on this exact bus were confirmed (via a live trace,
     * repeated discovery bursts, zero response ever) to simply not
     * implement at all. Without this, every such device collapses to the
     * bare manufacturer name and becomes indistinguishable from every
     * other device from the same vendor — which was the actual complaint:
     * not "no name", but "can't tell my three Garmin units apart". */
    dev.deviceClass = evt.fields.deviceClass ?? evt.fields['Device Class'] ?? dev.deviceClass;
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
  /* productName (from PGN 126996, Product Info) only ever arrives via our
   * own discovery request — a device that answered Address Claim (60928,
   * effectively mandatory) but hasn't been re-asked for Product Info yet,
   * or doesn't implement it, would otherwise show a permanently blank
   * name. manufacturer (from the same Address Claim) is already resolved
   * to a readable string (e.g. "Garmin") by canboatjs's own lookup, so
   * it's a reasonable placeholder until/unless a real product name shows
   * up — but bare manufacturer alone is indistinguishable across several
   * same-vendor devices that don't implement Product Info (confirmed real
   * case: 3+ Garmin units on one bus, all "Garmin"). Appending deviceClass
   * — from the same mandatory Address Claim, not a second request — turns
   * that into "Garmin Display" / "Garmin Navigation" / "Garmin
   * Communication", which is enough to tell them apart without inventing
   * a product name that was never actually broadcast. */
  dev.name = dev.customName || dev.productName ||
    (dev.manufacturer && dev.deviceClass ? `${dev.manufacturer} ${dev.deviceClass}` : dev.manufacturer) || null;
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
      customName: d.customName, productName: d.productName, deviceClass: d.deviceClass,
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
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sensor_n2k Bus Monitor</title>
${SHARED_STYLE}
<style>
.pgns { display: none; }
tr.dev.stale { opacity: 0.5; }
</style>
</head>
<body>
${navHtml('busmon')}
<div class="wrap">
<h1>Bus Monitor</h1>
<p class="sub">Live NMEA 2000 device and PGN visibility.</p>

<div class="card">
<button class="primary" onclick="discover()">Discover Devices</button>
<span id="discover-msg" style="margin-left:1em;color:var(--text-dim)"></span>
<p class="sub" style="margin:0.6em 0 0">
  Also polls automatically every 3 min — use this for an immediate check
  (e.g. right after a device that's already running, like an instrument
  display, doesn't show up on its own).
</p>
</div>

<div class="card">
<div class="stat-row" id="health"></div>
<table id="dev-table"><thead><tr><th>Src</th><th>Name</th><th>Mfg</th><th>PGNs</th><th>Total Frames</th><th>Last Seen</th></tr></thead><tbody></tbody></table>
</div>
</div>

<script>
/* A device that hasn't said anything in a while almost certainly isn't on
 * the bus anymore — there's no way to distinguish "gone" from "just quiet"
 * with only a lastSeen timestamp. Some devices (e.g. instrument displays
 * like a Garmin GMI20) don't broadcast anything on their own at all —
 * they only reply to our firmware's periodic discovery request, which
 * fires every DISCOVER_INTERVAL (n2k.c) = 3 minutes. A threshold shorter
 * than that cadence false-positives on every such device for the back
 * half of each cycle — confirmed on hardware: a Garmin that was fully
 * online spent roughly half of every 3-minute window marked "offline"
 * with a 90s threshold. Set comfortably past two full cycles (6 min) so
 * one missed reply (bus noise, a dropped frame) doesn't flip it either —
 * this is a "probably gone for good" signal, not a liveness ping. The
 * device list itself never expires entries (a device seen once stays
 * listed forever, by design — see onPgnEvent()), so this is purely a
 * display-side signal. */
const STALE_MS = 360000;

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

/* render() fully rebuilds #dev-table on every call — including from the
 * WebSocket, which fires on literally every decoded PGN (broadcastSnapshot()
 * runs on each onPgnEvent(), server-side), so on an active bus this can
 * happen many times a second. Without tracking expanded state separately,
 * each rebuild recreates every detail row hidden by default, collapsing
 * anything the user just opened almost immediately — confirmed on-device:
 * clicking a device flashed the PGN list open then instantly closed it. */
const expandedDevices = {};

function render(data) {
  const h = data.busState || {};
  document.getElementById('health').innerHTML = \`
    <div class="stat">CAN state <b>\${h.canState ?? '?'}</b> <span class="pill \${h.canState > 0 ? 'danger' : 'ok'}">\${h.canState > 0 ? 'error' : 'ok'}</span></div>
    <div class="stat">TX errors <b>\${h.txErrCnt ?? '?'}</b> \${h.txErrCnt ? '<span class="pill danger">!</span>' : ''}</div>
    <div class="stat">RX errors <b>\${h.rxErrCnt ?? '?'}</b> \${h.rxErrCnt ? '<span class="pill danger">!</span>' : ''}</div>
    <div class="stat">RX frames <b>\${h.rxFrameCount ?? '?'}</b></div>
    <div class="stat">Drop count <b>\${h.dropCount ?? '?'}</b> \${h.dropCount ? '<span class="pill warn">!</span>' : ''}</div>
    <div class="stat">Claimed SA <b>0x\${(h.claimedSA ?? 0).toString(16)}</b> \${
      h.saConfirmed == null ? ''
      : h.saConfirmed ? '<span class="pill ok">confirmed</span>'
      : '<span class="pill warn" title="No other device on the bus has ACKed this address yet">unconfirmed</span>'
    }</div>
  \`;

  const tbody = document.querySelector('#dev-table tbody');
  tbody.innerHTML = '';
  (data.devices || []).sort((a, b) => a.src - b.src).forEach(d => {
    const stale = !d.lastSeen || (Date.now() - d.lastSeen) > STALE_MS;
    const tr = document.createElement('tr');
    tr.className = 'dev' + (stale ? ' stale' : '');
    tr.innerHTML = \`<td>0x\${d.src.toString(16)} (\${d.src})</td>
      <td>\${escapeHtml(d.name || '-')} <a href="#" class="rename" title="Rename">✎</a></td>
      <td>\${escapeHtml(d.manufacturer ?? '-')}</td><td>\${d.pgnCount}</td><td>\${d.totalFrames}</td>
      <td>\${fmtAge(d.lastSeen)} <span class="pill \${stale ? 'danger' : 'ok'}">\${stale ? 'offline' : 'online'}</span></td>\`;
    tr.onclick = () => togglePgns(d.src);
    tr.querySelector('.rename').onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
      renameDevice(d.src, d.customName || '');
    };
    tbody.appendChild(tr);

    const detailTr = document.createElement('tr');
    detailTr.className = 'pgns pgns-' + d.src;
    detailTr.style.display = expandedDevices[d.src] ? 'table-row' : 'none';
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
  expandedDevices[src] = !expandedDevices[src];
  document.querySelectorAll('.pgns-' + src).forEach(el => {
    /* Clearing to '' doesn't work here — the stylesheet's ".pgns {
     * display: none }" rule (kept as the initial-hide default) still
     * applies once the inline override is gone, so the row never
     * actually became visible. Set an explicit value instead. */
    el.style.display = expandedDevices[src] ? 'table-row' : 'none';
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

/* The WS push below only fires render() when NEW data arrives — during a
 * quiet bus (nothing transmitting, e.g. every other node offline) that
 * means "Last Seen" and the online/offline pill silently freeze at
 * whatever they were on the last real update, even though real time keeps
 * passing. Re-rendering the last-known data on a plain tick (no new
 * fetch, no server load) keeps both current against the wall clock. */
let lastData = null;

function renderAndCache(data) {
  lastData = data;
  render(data);
}

fetch('/api/bus').then(r => r.json()).then(renderAndCache);
const ws = new WebSocket('ws://' + location.hostname + ':3003');
ws.onmessage = (ev) => renderAndCache(JSON.parse(ev.data));

setInterval(() => { if (lastData) render(lastData); }, 5000);
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
