#!/usr/bin/env node
'use strict';

/*
 * config-server.js  —  sensor_n2k web configuration UI
 *
 * Serves a static HTML page on port 3001.
 * Config is read/written at /etc/sensor_n2k/config.json.
 * bridge.js reads the same file at startup and pushes settings to STM32.
 *
 * Usage:  sudo node config-server.js
 * UI:     http://<board-ip>:3001
 */

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT        = 3001;
const CONFIG_DIR  = '/etc/sensor_n2k';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG = {
  onewire: {
    poll_ms: 2000,
    slots: [
      { enabled: true,  source: 2, instance: 1 },
      { enabled: false, source: 2, instance: 2 },
      { enabled: false, source: 2, instance: 3 },
      { enabled: false, source: 2, instance: 4 },
    ],
  },
  adc:   { enabled: true,  source: 14, instance: 0, poll_ms: 1000 },
  pulse: [
    { enabled: false, mode: 'STW', hz_per_mps: 9.33,  update_ms: 1000, avg_samples: 5 },
    { enabled: false, mode: 'RPM', pulses_per_rev: 1.0, engine_instance: 0, update_ms: 500, avg_samples: 3 },
  ],
};

/* ------------------------------------------------------------------ */
/* Config load / migrate / save                                         */
/* ------------------------------------------------------------------ */

function migrateConfig(cfg) {
  /* v1 → v2: flat onewire object becomes onewire.slots array */
  if (cfg.onewire && !Array.isArray(cfg.onewire.slots)) {
    const ow = cfg.onewire;
    cfg.onewire = {
      poll_ms: ow.poll_ms || 2000,
      slots: [
        { enabled: ow.enabled !== false, source: ow.source || 2, instance: ow.instance || 1 },
        { enabled: false, source: 2, instance: 2 },
        { enabled: false, source: 2, instance: 3 },
        { enabled: false, source: 2, instance: 4 },
      ],
    };
    console.log('[CFG] Migrated onewire config v1 -> v2');
  }
  /* Always ensure 4 slots exist */
  const slots = cfg.onewire.slots || [];
  while (slots.length < 4) {
    slots.push({ enabled: false, source: 2, instance: slots.length + 1 });
  }
  cfg.onewire.slots = slots;
  return cfg;
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      return migrateConfig(raw);
    }
  } catch (e) {
    console.error('[CFG] Read error:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(cfg) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ------------------------------------------------------------------ */
/* Static HTML — config is loaded/saved by client-side fetch()         */
/* No server-side template rendering; avoids template literal issues.  */
/* ------------------------------------------------------------------ */

var HTML = '<!DOCTYPE html>\n'
  + '<html lang="en"><head><meta charset="UTF-8">\n'
  + '<title>sensor_n2k Config</title>\n'
  + '<style>\n'
  + 'body{font-family:sans-serif;max-width:720px;margin:2em auto;padding:0 1em}\n'
  + 'h2{border-bottom:1px solid #ccc;padding-bottom:.3em}\n'
  + 'label{display:block;margin:.4em 0 .1em;font-weight:bold}\n'
  + 'input[type=number],select{width:100%;padding:.3em;box-sizing:border-box}\n'
  + '.row{display:flex;gap:1em}.row>div{flex:1}\n'
  + 'fieldset{margin:1em 0;border:1px solid #aaa;border-radius:4px;padding:.5em 1em}\n'
  + 'details{margin:.4em 0}summary{cursor:pointer;padding:.3em 0;font-weight:bold}\n'
  + '.save{margin-top:1.5em;padding:.6em 2em;font-size:1.1em;background:#0070b0;color:#fff;border:none;border-radius:4px;cursor:pointer}\n'
  + '.msg{margin-top:1em;color:green}\n'
  + '</style></head><body>\n'
  + '<h1>sensor_n2k Configuration</h1>\n'
  + '<p>Saved to <code>/etc/sensor_n2k/config.json</code>. Restart bridge.js to push to STM32.</p>\n'
  + '<form id="f">\n'

  /* 1-Wire */
  + '<h2>1-Wire Temperature (D8 / PB4)</h2>\n'
  + '<p style="font-size:.9em;color:#555">Sensors discovered at boot by ROM search. Slot 0 = first found, Slot 1 = second, etc.</p>\n'
  + '<fieldset>\n'
  + '  <div class="row"><div>\n'
  + '    <label>Poll interval ms (shared for all slots)</label>\n'
  + '    <input type="number" id="ow_poll" min="800" max="10000" step="200">\n'
  + '  </div></div>\n'
  + '  <details open><summary>Slot 0 — first DS18B20 found</summary><div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow0_en"> Enabled</label></div>\n'
  + '    <div><label>N2K Source</label><select id="ow0_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow0_inst" min="0" max="253"></div>\n'
  + '  </div></details>\n'
  + '  <details><summary>Slot 1 — second DS18B20</summary><div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow1_en"> Enabled</label></div>\n'
  + '    <div><label>N2K Source</label><select id="ow1_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow1_inst" min="0" max="253"></div>\n'
  + '  </div></details>\n'
  + '  <details><summary>Slot 2 — third DS18B20</summary><div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow2_en"> Enabled</label></div>\n'
  + '    <div><label>N2K Source</label><select id="ow2_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow2_inst" min="0" max="253"></div>\n'
  + '  </div></details>\n'
  + '  <details><summary>Slot 3 — fourth DS18B20</summary><div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow3_en"> Enabled</label></div>\n'
  + '    <div><label>N2K Source</label><select id="ow3_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow3_inst" min="0" max="253"></div>\n'
  + '  </div></details>\n'
  + '</fieldset>\n'

  /* ADC */
  + '<h2>ADC Temperature (A0 / PA4)</h2>\n'
  + '<fieldset><div class="row">\n'
  + '  <div><label><input type="checkbox" id="adc_en"> Enabled</label></div>\n'
  + '  <div><label>N2K Source</label><select id="adc_src"></select></div>\n'
  + '  <div><label>Instance</label><input type="number" id="adc_inst" min="0" max="253"></div>\n'
  + '  <div><label>Poll ms</label><input type="number" id="adc_poll" min="100" max="10000" step="100"></div>\n'
  + '</div></fieldset>\n'

  /* Pulse counter 0 */
  + '<h2>Pulse Counter 0 — D3 / PB0</h2>\n'
  + '<fieldset>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="pc0_en"> Enabled</label></div>\n'
  + '    <div><label>Mode</label><select id="pc0_mode"><option value="STW">STW — Speed Through Water</option><option value="RPM">Engine RPM</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Hz per m/s (STW)</label><input type="number" id="pc0_hz" min="0.1" max="1000" step="0.01"></div>\n'
  + '    <div><label>Pulses/rev (RPM)</label><input type="number" id="pc0_ppr" min="0.1" max="100" step="0.1"></div>\n'
  + '    <div><label>Engine instance</label><input type="number" id="pc0_eng" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Update ms (500-2000)</label><input type="number" id="pc0_upd" min="500" max="2000" step="100"></div>\n'
  + '    <div><label>Avg samples (1-10)</label><input type="number" id="pc0_avg" min="1" max="10"></div>\n'
  + '  </div>\n'
  + '</fieldset>\n'

  /* Pulse counter 1 */
  + '<h2>Pulse Counter 1 — D6 / PB1</h2>\n'
  + '<fieldset>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="pc1_en"> Enabled</label></div>\n'
  + '    <div><label>Mode</label><select id="pc1_mode"><option value="STW">STW — Speed Through Water</option><option value="RPM">Engine RPM</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Hz per m/s (STW)</label><input type="number" id="pc1_hz" min="0.1" max="1000" step="0.01"></div>\n'
  + '    <div><label>Pulses/rev (RPM)</label><input type="number" id="pc1_ppr" min="0.1" max="100" step="0.1"></div>\n'
  + '    <div><label>Engine instance</label><input type="number" id="pc1_eng" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Update ms (500-2000)</label><input type="number" id="pc1_upd" min="500" max="2000" step="100"></div>\n'
  + '    <div><label>Avg samples (1-10)</label><input type="number" id="pc1_avg" min="1" max="10"></div>\n'
  + '  </div>\n'
  + '</fieldset>\n'

  + '<button type="submit" class="save">Save &amp; Apply</button>\n'
  + '<div class="msg" id="msg"></div>\n'
  + '</form>\n'

  /* Client-side JS — no template literals, no backticks */
  + '<script>\n'
  + 'var SRCS=[{v:0,l:"Sea"},{v:1,l:"Outside"},{v:2,l:"Inside"},{v:3,l:"Engine Room"},{v:4,l:"Main Cabin"},{v:13,l:"Heating System"},{v:14,l:"Exhaust Gas (EGT)"}];\n'
  + 'function srcOpts(sel){return SRCS.map(function(s){return "<option value="+s.v+(s.v===sel?" selected":"")+">"+s.v+" - "+s.l+"</option>";}).join("");}\n'
  + 'function g(id){return document.getElementById(id);}\n'
  + 'fetch("/api/config").then(function(r){return r.json();}).then(function(c){\n'
  + '  g("ow_poll").value=c.onewire.poll_ms;\n'
  + '  [0,1,2,3].forEach(function(i){var s=c.onewire.slots[i]||{};g("ow"+i+"_en").checked=!!s.enabled;g("ow"+i+"_src").innerHTML=srcOpts(s.source);g("ow"+i+"_inst").value=s.instance;});\n'
  + '  g("adc_en").checked=!!c.adc.enabled;g("adc_src").innerHTML=srcOpts(c.adc.source);g("adc_inst").value=c.adc.instance;g("adc_poll").value=c.adc.poll_ms;\n'
  + '  [0,1].forEach(function(i){var p=c.pulse[i];g("pc"+i+"_en").checked=!!p.enabled;g("pc"+i+"_mode").value=p.mode;g("pc"+i+"_hz").value=p.hz_per_mps;g("pc"+i+"_ppr").value=p.pulses_per_rev||1;g("pc"+i+"_eng").value=p.engine_instance||0;g("pc"+i+"_upd").value=p.update_ms;g("pc"+i+"_avg").value=p.avg_samples;});\n'
  + '});\n'
  + 'g("f").addEventListener("submit",function(e){\n'
  + '  e.preventDefault();\n'
  + '  var c={\n'
  + '    onewire:{poll_ms:+g("ow_poll").value,slots:[0,1,2,3].map(function(i){return{enabled:g("ow"+i+"_en").checked,source:+g("ow"+i+"_src").value,instance:+g("ow"+i+"_inst").value};})},\n'
  + '    adc:{enabled:g("adc_en").checked,source:+g("adc_src").value,instance:+g("adc_inst").value,poll_ms:+g("adc_poll").value},\n'
  + '    pulse:[0,1].map(function(i){return{enabled:g("pc"+i+"_en").checked,mode:g("pc"+i+"_mode").value,hz_per_mps:+g("pc"+i+"_hz").value,pulses_per_rev:+g("pc"+i+"_ppr").value,engine_instance:+g("pc"+i+"_eng").value,update_ms:+g("pc"+i+"_upd").value,avg_samples:+g("pc"+i+"_avg").value};})\n'
  + '  };\n'
  + '  fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(c)}).then(function(r){return r.json();}).then(function(j){g("msg").textContent=j.ok?"Saved. Restart bridge.js to push to STM32.":"Error: "+j.error;});\n'
  + '});\n'
  + '</script>\n'
  + '</body></html>\n';

/* ------------------------------------------------------------------ */
/* HTTP server                                                          */
/* ------------------------------------------------------------------ */

var server = http.createServer(function(req, res) {
  if (req.method === 'GET' && req.url === '/api/config') {
    var cfg = loadConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(cfg));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/config') {
    var body = '';
    req.on('data', function(d) { body += d; });
    req.on('end', function() {
      try {
        var cfg = JSON.parse(body);
        saveConfig(cfg);
        console.log('[CFG] Config saved to', CONFIG_FILE);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
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
    console.error('[CFG] Port', PORT, 'already in use — another instance running?');
  } else {
    console.error('[CFG] Server error:', e.message);
  }
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', function() {
  console.log('[CFG] Config server listening on http://0.0.0.0:' + PORT);
  console.log('[CFG] Config file: ' + CONFIG_FILE);
});
