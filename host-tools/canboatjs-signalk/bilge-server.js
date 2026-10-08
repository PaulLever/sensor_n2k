#!/usr/bin/env node
'use strict';

/*
 * bilge-server.js — bilge pump monitoring web UI
 *
 * Displays live state + rolling cycle-count/runtime stats (last 1h/24h/7d)
 * for up to 4 opto-isolated bilge pump channels — see bilge.c on the
 * Zephyr side for how those stats are computed and reported, and
 * BILGE_REPORT_CAN_ID in bridge.js for the relay into the local event
 * bus this page subscribes to.
 *
 * This page is display-only. Per-channel enabled + the shared PGN 127501
 * switch bank instance are configured on config-server.js's Configuration
 * page (same as every other sensor's setup), reading/writing the "bilge"
 * key of the same /etc/sensor_n2k/config.json bridge.js also uses — this
 * page only reads that config (read-only, via GET /api/config) to know
 * which channels are enabled for display purposes.
 *
 * Alarm thresholds (count-in-period / time-on-in-period) are also NOT
 * configured here — same division of labor as every other alarm in this
 * project, they live in alarm-server.js's Rules page, matched against
 * the same live stats this page displays.
 *
 * Usage:  sudo node bilge-server.js
 * UI:     http://<board-ip>:3004
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { SHARED_STYLE, navHtml } = require('./shared-ui');

const PORT        = 3004;
const CONFIG_DIR  = '/etc/sensor_n2k';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOCAL_BUS_URL = 'ws://127.0.0.1:3010';
const NUM_CHANNELS = 4;

const DEFAULT_BILGE = { enabled: [false, false, false, false], switch_instance: 1, labels: ['', '', '', ''] };

/* ------------------------------------------------------------------ */
/* Config load / save — shares config.json with bridge.js/config-server */
/* ------------------------------------------------------------------ */

function loadFullConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[BILGE] config read error:', e.message);
  }
  return {};
}

function loadBilgeConfig() {
  const b = loadFullConfig().bilge || {};
  return {
    enabled: Array.isArray(b.enabled) && b.enabled.length === NUM_CHANNELS
      ? b.enabled : DEFAULT_BILGE.enabled.slice(),
    switch_instance: b.switch_instance !== undefined
      ? b.switch_instance : DEFAULT_BILGE.switch_instance,
    labels: Array.isArray(b.labels) && b.labels.length === NUM_CHANNELS
      ? b.labels : DEFAULT_BILGE.labels.slice(),
  };
}

/* ------------------------------------------------------------------ */
/* Local bus (bridge.js) — live per-channel stats                      */
/* ------------------------------------------------------------------ */

let localBusWs = null;
let lastBilge = {
  ts: 0,
  channels: [0, 1, 2, 3].map(() => ({
    state: 0, cycles_1h: 0, on_s_1h: 0, cycles_24h: 0, on_s_24h: 0, cycles_7d: 0, on_s_7d: 0,
  })),
};

function connectLocalBus() {
  localBusWs = new WebSocket(LOCAL_BUS_URL);
  localBusWs.on('open', () => console.log('[BILGE] Connected to local bus', LOCAL_BUS_URL));
  localBusWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'bilge' && Array.isArray(msg.channels)) {
      lastBilge = { ts: Date.now(), channels: msg.channels };
    }
  });
  localBusWs.on('error', (e) => console.warn('[BILGE] local bus error:', e.message));
  localBusWs.on('close', () => {
    console.warn('[BILGE] local bus disconnected, retrying in 3s…');
    setTimeout(connectLocalBus, 3000);
  });
}

/* ------------------------------------------------------------------ */
/* Static HTML                                                          */
/* ------------------------------------------------------------------ */

function channelCard(i) {
  return ''
    + '<div class="card" id="chan' + i + '_card">\n'
    + '  <h2 style="display:flex;align-items:center;gap:.6em;justify-content:space-between">\n'
    + '    <span id="chan' + i + '_title">Bilge Pump ' + (i + 1) + '</span>\n'
    + '    <span class="pill neutral" id="chan' + i + '_state">unknown</span>\n'
    + '  </h2>\n'
    + '  <div class="stat-row">\n'
    + '    <div class="stat"><b id="chan' + i + '_c1h">—</b> cycles / <b id="chan' + i + '_t1h">—</b> running<div class="note">last 1 hour</div></div>\n'
    + '    <div class="stat"><b id="chan' + i + '_c24h">—</b> cycles / <b id="chan' + i + '_t24h">—</b> running<div class="note">last 24 hours</div></div>\n'
    + '    <div class="stat"><b id="chan' + i + '_c7d">—</b> cycles / <b id="chan' + i + '_t7d">—</b> running<div class="note">last 7 days</div></div>\n'
    + '  </div>\n'
    + '</div>\n';
}

var HTML = '<!DOCTYPE html>\n'
  + '<html lang="en"><head><meta charset="UTF-8">\n'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
  + '<title>Bilge Pumps</title>\n'
  + SHARED_STYLE + '\n'
  + '<style>\n'
  + 'label{display:block;margin:.6em 0 .1em;font-weight:600;color:var(--text)}\n'
  + '.note{font-size:.8em;color:var(--text-dim)}\n'
  + 'input[type=number]{width:100%;padding:.4em .5em;box-sizing:border-box}\n'
  + '</style></head><body>\n'
  + navHtml('bilge') + '\n'
  + '<div class="wrap">\n'
  + '<h1>Bilge Pumps</h1>\n'
  + '<p class="sub">4-channel opto-isolated pump monitor. Counts/runtime update every few seconds. '
  + 'Enable channels and set the N2K switch bank instance on the <a href="#" id="config-link">Configuration</a> page; '
  + 'alarm thresholds on these stats are on the <a href="#" id="alarms-link">Alarms</a> page.</p>\n'
  + channelCard(0) + channelCard(1) + channelCard(2) + channelCard(3)
  + '</div>\n'

  + '<script>\n'
  + 'function g(id){return document.getElementById(id);}\n'
  + 'document.getElementById("config-link").addEventListener("click",function(e){\n'
  + '  e.preventDefault();\n'
  + '  location.href="//"+location.hostname+":3001/";\n'
  + '});\n'
  + 'document.getElementById("alarms-link").addEventListener("click",function(e){\n'
  + '  e.preventDefault();\n'
  + '  location.href="//"+location.hostname+":3002/";\n'
  + '});\n'

  + 'function fmtDur(totalSeconds){\n'
  + '  var s=totalSeconds||0;\n'
  + '  var h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=Math.floor(s%60);\n'
  + '  if(h>0){return h+"h "+m+"m";}\n'
  + '  if(m>0){return m+"m "+sec+"s";}\n'
  + '  return sec+"s";\n'
  + '}\n'

  + 'var chanEnabled=[false,false,false,false];\n'

  + 'function renderLive(data){\n'
  + '  (data.channels||[]).forEach(function(ch,i){\n'
  + '    var stateEl=g("chan"+i+"_state");\n'
  + '    if(!chanEnabled[i]){stateEl.textContent="not enabled";stateEl.className="pill neutral";}\n'
  + '    else if(ch.state){stateEl.textContent="RUNNING";stateEl.className="pill danger";}\n'
  + '    else{stateEl.textContent="off";stateEl.className="pill ok";}\n'
  + '    g("chan"+i+"_c1h").textContent=ch.cycles_1h;\n'
  + '    g("chan"+i+"_t1h").textContent=fmtDur(ch.on_s_1h);\n'
  + '    g("chan"+i+"_c24h").textContent=ch.cycles_24h;\n'
  + '    g("chan"+i+"_t24h").textContent=fmtDur(ch.on_s_24h);\n'
  + '    g("chan"+i+"_c7d").textContent=ch.cycles_7d;\n'
  + '    g("chan"+i+"_t7d").textContent=fmtDur(ch.on_s_7d);\n'
  + '  });\n'
  + '}\n'

  + 'function pollLive(){\n'
  + '  fetch("/api/live").then(function(r){return r.json();}).then(renderLive)\n'
  + '    .catch(function(){});\n'
  + '}\n'
  + 'fetch("/api/config").then(function(r){return r.json();}).then(function(cfg){\n'
  + '  chanEnabled=cfg.enabled;\n'
  + '  (cfg.labels||[]).forEach(function(label,i){\n'
  + '    if(label){ g("chan"+i+"_title").textContent="Bilge Pump "+(i+1)+" "+label; }\n'
  + '  });\n'
  + '  pollLive();\n'
  + '  setInterval(pollLive,2000);\n'
  + '});\n'
  + '</script>\n'
  + '</body></html>\n';

/* ------------------------------------------------------------------ */
/* HTTP server                                                          */
/* ------------------------------------------------------------------ */

var server = http.createServer(function(req, res) {
  if (req.method === 'GET' && req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadBilgeConfig()));
    return;
  }

  if (req.method === 'GET' && req.url === '/api/live') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastBilge));
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.on('error', function(e) {
  if (e.code === 'EADDRINUSE') {
    console.error('[BILGE] Port', PORT, 'already in use — another instance running?');
  } else {
    console.error('[BILGE] Server error:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('[BILGE] Bilge pump server listening on http://0.0.0.0:' + PORT);
  console.log('[BILGE] Config file: ' + CONFIG_FILE);
});

connectLocalBus();
