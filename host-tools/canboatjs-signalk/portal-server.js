#!/usr/bin/env node
'use strict';

/*
 * portal-server.js — landing page for the sensor_n2k web app suite.
 * Serves on port 80 (root, same precedent as bus-monitor-server.js —
 * this is the only way to make `http://unoq.local/` work with no port
 * number) with:
 *   - links to the other apps this project owns (Configuration, Alarms,
 *     Bus Monitor, Bilge Pumps, Network, Updates) plus Signal K
 *   - an Active Alarms panel with one-click Cancel, proxied server-side
 *     to alarm-server.js's REST API (avoids CORS entirely — same reason
 *     alarm-server.js itself proxies bus-monitor-server.js for its
 *     Source dropdown, see fetchBusDevices() there)
 *
 * No local state of its own — purely a proxy + static page.
 */

const http = require('http');
const { SHARED_STYLE, navHtml } = require('./shared-ui');

const PORT = 80;
const ALARM_SERVER_URL = 'http://127.0.0.1:3002';

function proxyJson(path, method = 'GET') {
  return new Promise((resolve) => {
    const req = http.request(`${ALARM_SERVER_URL}${path}`, { method, timeout: 4000 }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try { resolve({ ok: true, status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ ok: false, error: 'invalid response from alarm server' }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'alarm server timed out' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end();
  });
}

const WEBAPP_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UNO Q — N2K Sensor Bridge</title>
${SHARED_STYLE}
</head><body>
${navHtml('portal')}
<div id="popup"><span id="popup-msg"></span></div>
<div class="wrap">
<h1>UNO Q — N2K Sensor Bridge</h1>
<p class="sub">NMEA 2000 sensor bridge, alarm engine, and bus monitor for this vessel.</p>

<div class="card" id="active-card" style="display:none">
<h2>Active Alarms</h2>
<table id="active-table"><thead><tr><th>Label</th><th>Since</th><th>Acked</th><th></th></tr></thead><tbody></tbody></table>
</div>

<div class="card">
<h2>Apps</h2>
<div class="stat-row" id="app-links"></div>
</div>
</div>

<script>
const APPS = [
  { label: 'Configuration', desc: 'Sensor slot / PGN / alarm-threshold setup', port: 3001 },
  { label: 'Alarms', desc: 'Rules, hardware output, active alarms', port: 3002 },
  { label: 'Bus Monitor', desc: 'Live N2K device/PGN visibility', port: 3003 },
  { label: 'Bilge Pumps', desc: 'Cycle counts, runtime, current state', port: 3004 },
  { label: 'Network', desc: 'WiFi setup, switching, setup access point', port: 3005 },
  { label: 'Updates', desc: 'App + Zephyr firmware updates and rollback', port: 3006 },
  { label: 'Signal K', desc: 'Marine data server / admin UI', port: 3000, newTab: true },
];

function renderLinks() {
  const el = document.getElementById('app-links');
  el.innerHTML = '';
  APPS.forEach(a => {
    const div = document.createElement('a');
    div.className = 'btn primary';
    div.style.cssText = 'display:block;padding:1em 1.2em;text-decoration:none;min-width:180px;flex:1';
    div.href = '//' + location.hostname + ':' + a.port + '/';
    // Signal K is third-party and not part of this nav — opens in a new
    // tab so getting back here is just switching tabs, not fighting its
    // own SPA navigation history with the back button. See shared-ui.js's
    // navHtml() comment for the full reasoning (same choice, same reason).
    if (a.newTab) { div.target = '_blank'; div.rel = 'noopener'; }
    div.innerHTML = '<div style="font-size:1.05em">' + a.label + '</div>' +
      '<div style="font-weight:400;font-size:0.85em;opacity:0.85;margin-top:0.2em">' + a.desc + '</div>';
    el.appendChild(div);
  });
}

function fmtAge(ts) {
  if (!ts) return '-';
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 60 ? s + 's ago' : Math.round(s / 60) + 'm ago';
}

async function refreshActive() {
  try {
    const r = await fetch('/api/active-alarms').then(r => r.json());
    if (!r.ok) return;
    const { rules, active } = r.body;
    const card = document.getElementById('active-card');
    const tbody = document.querySelector('#active-table tbody');
    tbody.innerHTML = '';
    if (!active || active.length === 0) {
      card.style.display = 'none';
      document.getElementById('popup').style.display = 'none';
      return;
    }
    card.style.display = '';
    let anyUnacked = false;
    active.forEach(a => {
      const rule = (rules || []).find(x => x.id === a.id);
      if (!a.acked) anyUnacked = true;
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + (rule ? rule.label : a.id) + '</td>' +
        '<td>' + new Date(a.since).toLocaleTimeString() + '</td>' +
        '<td><span class="pill ' + (a.acked ? 'neutral' : 'danger') + '">' + (a.acked ? 'acked' : 'active') + '</span></td>' +
        '<td><button class="danger" onclick="cancelAlarm(\\'' + a.id + '\\')" ' + (a.acked ? 'disabled' : '') + '>Cancel</button></td>';
      tbody.appendChild(tr);
    });
    const popup = document.getElementById('popup');
    if (anyUnacked) {
      const first = active.find(a => !a.acked);
      const rule = (rules || []).find(x => x.id === first.id);
      document.getElementById('popup-msg').textContent = 'ALARM: ' + (rule ? rule.label : first.id) +
        (active.length > 1 ? ' (+' + (active.length - 1) + ' more)' : '');
      popup.style.display = 'block';
    } else {
      popup.style.display = 'none';
    }
  } catch (e) { /* alarm server unreachable — leave last-known state on screen */ }
}

async function cancelAlarm(id) {
  await fetch('/api/cancel/' + id, { method: 'POST' });
  refreshActive();
}

renderLinks();
refreshActive();
setInterval(refreshActive, 4000);
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'GET' && url.pathname === '/api/active-alarms') {
    const r = await proxyJson('/api/alarms');
    res.writeHead(r.ok ? 200 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.ok ? { ok: true, body: r.body } : { ok: false, error: r.error }));
    return;
  }

  const cancelMatch = url.pathname.match(/^\/api\/cancel\/([^/]+)$/);
  if (req.method === 'POST' && cancelMatch) {
    const r = await proxyJson(`/api/alarms/${encodeURIComponent(cancelMatch[1])}/cancel`, 'POST');
    res.writeHead(r.ok ? 200 : 502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r.ok ? { ok: true } : { ok: false, error: r.error }));
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(WEBAPP_HTML);
    return;
  }

  res.writeHead(404);
  res.end();
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[PORTAL] Port ${PORT} already in use`);
  } else {
    console.error('[PORTAL] Server error:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[PORTAL] Listening on http://0.0.0.0:${PORT}`);
});
