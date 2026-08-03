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

/* N2K_PGNCFG_* (must match sensor_config.h and bridge.js) */
const PGNCFG = { TEMP: 0, TEMP_EXT: 1, ENV_PARAMS: 2, ENGINE_DYN: 3 };

/* Default alarm sub-object — consumed only by alarm-server.js's
 * default-rule sync, never pushed to the STM32 (see plan note: these
 * ranges are a host-side-only concept). */
function defaultAlarm() { return { enabled: false, min_c: null, max_c: null }; }

const DEFAULT_CONFIG = {
  onewire: {
    poll_ms: 2000,
    slots: [
      { enabled: true,  pgn_id: PGNCFG.TEMP, source: 2, instance: 1, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm() },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 2, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm() },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 3, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm() },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 4, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm() },
    ],
  },
  adc:   { enabled: true, pgn_id: PGNCFG.TEMP_EXT, source: 14, instance: 0, poll_ms: 1000, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm() },
  pulse: [
    { enabled: false, mode: 'STW', hz_per_mps: 9.33,  update_ms: 1000, avg_samples: 5 },
    { enabled: false, mode: 'RPM', pulses_per_rev: 1.0, engine_instance: 0, update_ms: 500, avg_samples: 3 },
  ],
};

/* ------------------------------------------------------------------ */
/* Config load / migrate / save                                         */
/* ------------------------------------------------------------------ */

function migrateConfig(cfg) {
  /* v1 → v2: flat onewire → onewire.slots array */
  if (cfg.onewire && !Array.isArray(cfg.onewire.slots)) {
    const ow = cfg.onewire;
    cfg.onewire = {
      poll_ms: ow.poll_ms || 2000,
      slots: [
        { enabled: ow.enabled !== false, pgn_id: PGNCFG.TEMP, source: ow.source || 2, instance: ow.instance || 1 },
        { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 2 },
        { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 3 },
        { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 4 },
      ],
    };
    console.log('[CFG] Migrated onewire config v1 -> v2');
  }
  /* Ensure 4 slots exist and each has a pgn_id */
  const slots = cfg.onewire.slots || [];
  while (slots.length < 4) {
    slots.push({ enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: slots.length + 1 });
  }
  slots.forEach(s => {
    if (s.pgn_id === undefined)     { s.pgn_id = PGNCFG.TEMP; }
    if (s.test_mode === undefined)  { s.test_mode = false; }
    if (s.test_value_c === undefined) { s.test_value_c = 20.0; }
    if (s.alarm === undefined)      { s.alarm = defaultAlarm(); }
  });
  cfg.onewire.slots = slots;
  /* Ensure adc has pgn_id and test fields */
  if (cfg.adc) {
    if (cfg.adc.pgn_id === undefined)     { cfg.adc.pgn_id = PGNCFG.TEMP_EXT; }
    if (cfg.adc.test_mode === undefined)  { cfg.adc.test_mode = false; }
    if (cfg.adc.test_value_c === undefined) { cfg.adc.test_value_c = 20.0; }
    if (cfg.adc.alarm === undefined)      { cfg.adc.alarm = defaultAlarm(); }
  }
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
/* Static HTML                                                          */
/* ------------------------------------------------------------------ */

var HTML = '<!DOCTYPE html>\n'
  + '<html lang="en"><head><meta charset="UTF-8">\n'
  + '<title>sensor_n2k Config</title>\n'
  + '<style>\n'
  + 'body{font-family:sans-serif;max-width:800px;margin:2em auto;padding:0 1em}\n'
  + 'h2{border-bottom:1px solid #ccc;padding-bottom:.3em}\n'
  + 'label{display:block;margin:.4em 0 .1em;font-weight:bold}\n'
  + 'input[type=number],select{width:100%;padding:.3em;box-sizing:border-box}\n'
  + '.row{display:flex;gap:1em}.row>div{flex:1}\n'
  + 'fieldset{margin:1em 0;border:1px solid #aaa;border-radius:4px;padding:.5em 1em}\n'
  + 'details{margin:.4em 0}summary{cursor:pointer;padding:.3em 0;font-weight:bold}\n'
  + '.save{margin-top:1.5em;padding:.6em 2em;font-size:1.1em;background:#0070b0;color:#fff;border:none;border-radius:4px;cursor:pointer}\n'
  + '.msg{margin-top:1em;color:green}\n'
  + '.note{font-size:.85em;color:#666;margin:.2em 0 .6em}\n'
  + '</style></head><body>\n'
  + '<h1>sensor_n2k Configuration</h1>\n'
  + '<p>Saved to <code>/etc/sensor_n2k/config.json</code>. bridge.js auto-detects changes and pushes to STM32.</p>\n'
  + '<form id="f">\n'

  /* 1-Wire */
  + '<h2>1-Wire Temperature Sensors (D8 / PB4)</h2>\n'
  + '<p class="note">Sensors discovered at boot by ROM search. Slot 0 = first found, Slot 1 = second, etc.</p>\n'
  + '<fieldset>\n'
  + '  <div class="row"><div>\n'
  + '    <label>Poll interval ms (shared for all slots)</label>\n'
  + '    <input type="number" id="ow_poll" min="800" max="10000" step="200">\n'
  + '  </div></div>\n'
  + '  <details open><summary>Slot 0 — first DS18B20 found</summary>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow0_en"> Enabled</label></div>\n'
  + '    <div><label>N2K PGN</label><select id="ow0_pgn"></select></div>\n'
  + '    <div><label>Source / Field</label><select id="ow0_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow0_inst" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow0_test_en"> TEST mode (use fixed value)</label></div>\n'
  + '    <div><label>Test value (°C)</label><input type="number" id="ow0_test_val" step="0.1" min="-55" max="1000" value="20"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow0_alarm_en"> Alarm enabled</label></div>\n'
  + '    <div><label>Threshold</label><select id="ow0_alarm_mode" onchange="onAlarmModeChange(\'ow0_\')"><option value="max">Max</option><option value="min">Min</option><option value="both">Both</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div id="ow0_alarm_min_label"><label>Alarm min (°C)</label><input type="number" id="ow0_alarm_min" step="0.1"></div>\n'
  + '    <div id="ow0_alarm_max_label"><label>Alarm max (°C)</label><input type="number" id="ow0_alarm_max" step="0.1"></div>\n'
  + '  </div>\n'
  + '  </details>\n'
  + '  <details><summary>Slot 1 — second DS18B20</summary>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow1_en"> Enabled</label></div>\n'
  + '    <div><label>N2K PGN</label><select id="ow1_pgn"></select></div>\n'
  + '    <div><label>Source / Field</label><select id="ow1_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow1_inst" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow1_test_en"> TEST mode (use fixed value)</label></div>\n'
  + '    <div><label>Test value (°C)</label><input type="number" id="ow1_test_val" step="0.1" min="-55" max="1000" value="20"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow1_alarm_en"> Alarm enabled</label></div>\n'
  + '    <div><label>Threshold</label><select id="ow1_alarm_mode" onchange="onAlarmModeChange(\'ow1_\')"><option value="max">Max</option><option value="min">Min</option><option value="both">Both</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div id="ow1_alarm_min_label"><label>Alarm min (°C)</label><input type="number" id="ow1_alarm_min" step="0.1"></div>\n'
  + '    <div id="ow1_alarm_max_label"><label>Alarm max (°C)</label><input type="number" id="ow1_alarm_max" step="0.1"></div>\n'
  + '  </div>\n'
  + '  </details>\n'
  + '  <details><summary>Slot 2 — third DS18B20</summary>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow2_en"> Enabled</label></div>\n'
  + '    <div><label>N2K PGN</label><select id="ow2_pgn"></select></div>\n'
  + '    <div><label>Source / Field</label><select id="ow2_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow2_inst" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow2_test_en"> TEST mode (use fixed value)</label></div>\n'
  + '    <div><label>Test value (°C)</label><input type="number" id="ow2_test_val" step="0.1" min="-55" max="1000" value="20"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow2_alarm_en"> Alarm enabled</label></div>\n'
  + '    <div><label>Threshold</label><select id="ow2_alarm_mode" onchange="onAlarmModeChange(\'ow2_\')"><option value="max">Max</option><option value="min">Min</option><option value="both">Both</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div id="ow2_alarm_min_label"><label>Alarm min (°C)</label><input type="number" id="ow2_alarm_min" step="0.1"></div>\n'
  + '    <div id="ow2_alarm_max_label"><label>Alarm max (°C)</label><input type="number" id="ow2_alarm_max" step="0.1"></div>\n'
  + '  </div>\n'
  + '  </details>\n'
  + '  <details><summary>Slot 3 — fourth DS18B20</summary>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow3_en"> Enabled</label></div>\n'
  + '    <div><label>N2K PGN</label><select id="ow3_pgn"></select></div>\n'
  + '    <div><label>Source / Field</label><select id="ow3_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow3_inst" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow3_test_en"> TEST mode (use fixed value)</label></div>\n'
  + '    <div><label>Test value (°C)</label><input type="number" id="ow3_test_val" step="0.1" min="-55" max="1000" value="20"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow3_alarm_en"> Alarm enabled</label></div>\n'
  + '    <div><label>Threshold</label><select id="ow3_alarm_mode" onchange="onAlarmModeChange(\'ow3_\')"><option value="max">Max</option><option value="min">Min</option><option value="both">Both</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div id="ow3_alarm_min_label"><label>Alarm min (°C)</label><input type="number" id="ow3_alarm_min" step="0.1"></div>\n'
  + '    <div id="ow3_alarm_max_label"><label>Alarm max (°C)</label><input type="number" id="ow3_alarm_max" step="0.1"></div>\n'
  + '  </div>\n'
  + '  </details>\n'
  + '</fieldset>\n'

  /* ADC */
  + '<h2>ADC Temperature (A0 / PA4, 0–1000 °C range)</h2>\n'
  + '<fieldset>\n'
  + '<div class="row">\n'
  + '  <div><label><input type="checkbox" id="adc_en"> Enabled</label></div>\n'
  + '  <div><label>N2K PGN</label><select id="adc_pgn"></select></div>\n'
  + '  <div><label>Source / Field</label><select id="adc_src"></select></div>\n'
  + '  <div><label>Instance</label><input type="number" id="adc_inst" min="0" max="253"></div>\n'
  + '  <div><label>Poll ms</label><input type="number" id="adc_poll" min="100" max="10000" step="100"></div>\n'
  + '</div>\n'
  + '<div class="row">\n'
  + '  <div><label><input type="checkbox" id="adc_test_en"> TEST mode (use fixed value)</label></div>\n'
  + '  <div><label>Test value (°C)</label><input type="number" id="adc_test_val" step="0.1" min="-55" max="1000" value="20"></div>\n'
  + '</div>\n'
  + '<div class="row">\n'
  + '  <div><label><input type="checkbox" id="adc_alarm_en"> Alarm enabled</label></div>\n'
  + '  <div><label>Threshold</label><select id="adc_alarm_mode" onchange="onAlarmModeChange(\'adc_\')"><option value="max">Max</option><option value="min">Min</option><option value="both">Both</option></select></div>\n'
  + '</div>\n'
  + '<div class="row">\n'
  + '  <div id="adc_alarm_min_label"><label>Alarm min (°C)</label><input type="number" id="adc_alarm_min" step="0.1"></div>\n'
  + '  <div id="adc_alarm_max_label"><label>Alarm max (°C)</label><input type="number" id="adc_alarm_max" step="0.1"></div>\n'
  + '</div>\n'
  + '</fieldset>\n'

  /* Pulse counter 0 */
  + '<h2>Pulse Counter 0 — D3 / PB0</h2>\n'
  + '<fieldset>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="pc0_en"> Enabled</label></div>\n'
  + '    <div><label>Mode</label><select id="pc0_mode"><option value="STW">STW — Speed Through Water (PGN 128259)</option><option value="RPM">Engine RPM (PGN 127488)</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Hz per m/s (STW)</label><input type="number" id="pc0_hz" min="0.1" max="1000" step="0.01"></div>\n'
  + '    <div><label>Pulses/rev (RPM)</label><input type="number" id="pc0_ppr" min="0.1" max="100" step="0.1"></div>\n'
  + '    <div><label>Engine instance</label><input type="number" id="pc0_eng" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Update ms (500–2000)</label><input type="number" id="pc0_upd" min="500" max="2000" step="100"></div>\n'
  + '    <div><label>Avg samples (1–10)</label><input type="number" id="pc0_avg" min="1" max="10"></div>\n'
  + '  </div>\n'
  + '</fieldset>\n'

  /* Pulse counter 1 */
  + '<h2>Pulse Counter 1 — D6 / PB1</h2>\n'
  + '<fieldset>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="pc1_en"> Enabled</label></div>\n'
  + '    <div><label>Mode</label><select id="pc1_mode"><option value="STW">STW — Speed Through Water (PGN 128259)</option><option value="RPM">Engine RPM (PGN 127488)</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Hz per m/s (STW)</label><input type="number" id="pc1_hz" min="0.1" max="1000" step="0.01"></div>\n'
  + '    <div><label>Pulses/rev (RPM)</label><input type="number" id="pc1_ppr" min="0.1" max="100" step="0.1"></div>\n'
  + '    <div><label>Engine instance</label><input type="number" id="pc1_eng" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Update ms (500–2000)</label><input type="number" id="pc1_upd" min="500" max="2000" step="100"></div>\n'
  + '    <div><label>Avg samples (1–10)</label><input type="number" id="pc1_avg" min="1" max="10"></div>\n'
  + '  </div>\n'
  + '</fieldset>\n'

  + '<button type="submit" class="save">Save &amp; Apply</button>\n'
  + '<div class="msg" id="msg"></div>\n'
  + '</form>\n'

  /* Client-side JS */
  + '<script>\n'
  /* PGN options: value = pgn_id (N2K_PGNCFG_*) */
  + 'var PGNS=[\n'
  + '  {v:0,l:"130312 — Temperature"},\n'
  + '  {v:1,l:"130316 — Temperature Extended Range"},\n'
  + '  {v:2,l:"130311 — Environmental Parameters"},\n'
  + '  {v:3,l:"127489 — Engine Params Dynamic (fast-packet)"},\n'
  + '  {v:4,l:"127493 — Transmission Params Dynamic"}\n'
  + '];\n'
  /* Temperature source options (for PGNs 130312/130316/130311) */
  + 'var SRCS=[\n'
  + '  {v:0,l:"0 — Sea Temperature"},\n'
  + '  {v:1,l:"1 — Outside Temperature"},\n'
  + '  {v:2,l:"2 — Inside Temperature"},\n'
  + '  {v:3,l:"3 — Engine Room Temperature"},\n'
  + '  {v:4,l:"4 — Main Cabin Temperature"},\n'
  + '  {v:5,l:"5 — Live Well Temperature"},\n'
  + '  {v:6,l:"6 — Bait Well Temperature"},\n'
  + '  {v:7,l:"7 — Refrigeration Temperature"},\n'
  + '  {v:8,l:"8 — Heating System Temperature"},\n'
  + '  {v:9,l:"9 — Dew Point Temperature"},\n'
  + '  {v:10,l:"10 — Apparent Wind Chill Temperature"},\n'
  + '  {v:11,l:"11 — Theoretical Wind Chill Temperature"},\n'
  + '  {v:12,l:"12 — Heat Index Temperature"},\n'
  + '  {v:13,l:"13 — Freezer Temperature"},\n'
  + '  {v:14,l:"14 — Exhaust Gas Temperature (EGT)"}\n'
  + '];\n'
  /* Source/field options for PGN 127489 (source repurposed as field selector) */
  + 'var ENG_FIELDS=[\n'
  + '  {v:0,l:"0 — Oil Temperature"},\n'
  + '  {v:1,l:"1 — Engine/Coolant Temperature"}\n'
  + '];\n'
  /* Source/field options for PGN 127493 — source field unused in this PGN */
  + 'var TRANS_FIELDS=[\n'
  + '  {v:0,l:"N/A — source unused for this PGN"}\n'
  + '];\n'
  + 'function pgnOpts(sel){return PGNS.map(function(p){return "<option value="+p.v+(p.v===sel?" selected":"")+">"+p.l+"</option>";}).join("");}\n'
  + 'function srcOpts(pgn,sel){\n'
  + '  var list=(pgn===3)?ENG_FIELDS:(pgn===4)?TRANS_FIELDS:SRCS;\n'
  + '  return list.map(function(s){return "<option value="+s.v+(s.v===sel?" selected":"")+">"+s.l+"</option>";}).join("");\n'
  + '}\n'
  + 'function g(id){return document.getElementById(id);}\n'
  /* Update source dropdown when PGN changes */
  + 'function onPgnChange(prefix){\n'
  + '  var pgn=+g(prefix+"pgn").value;\n'
  + '  var cur=+g(prefix+"src").value;\n'
  + '  g(prefix+"src").innerHTML=srcOpts(pgn,cur);\n'
  + '}\n'
  + 'function setupPgnListener(prefix){\n'
  + '  g(prefix+"pgn").addEventListener("change",function(){onPgnChange(prefix);});\n'
  + '}\n'
  /* Show only the relevant Alarm min/max input(s) — a sensor alarm is
   * almost always a single bound (over-temp OR under-temp), rarely both. */
  + 'function onAlarmModeChange(prefix){\n'
  + '  var mode=g(prefix+"alarm_mode").value;\n'
  + '  g(prefix+"alarm_min_label").style.display=(mode==="min"||mode==="both")?"":"none";\n'
  + '  g(prefix+"alarm_max_label").style.display=(mode==="max"||mode==="both")?"":"none";\n'
  + '}\n'
  + 'function alarmModeFor(a){return(a.min_c!=null&&a.max_c!=null)?"both":(a.min_c!=null?"min":"max");}\n'
  /* Load config from server */
  + 'fetch("/api/config").then(function(r){return r.json();}).then(function(c){\n'
  + '  g("ow_poll").value=c.onewire.poll_ms;\n'
  + '  [0,1,2,3].forEach(function(i){\n'
  + '    var s=c.onewire.slots[i]||{};\n'
  + '    var pgn=s.pgn_id||0;\n'
  + '    g("ow"+i+"_en").checked=!!s.enabled;\n'
  + '    g("ow"+i+"_pgn").innerHTML=pgnOpts(pgn);\n'
  + '    g("ow"+i+"_src").innerHTML=srcOpts(pgn,s.source);\n'
  + '    g("ow"+i+"_inst").value=s.instance;\n'
  + '    g("ow"+i+"_test_en").checked=!!s.test_mode;\n'
  + '    g("ow"+i+"_test_val").value=s.test_value_c!=null?s.test_value_c:20;\n'
  + '    var sa=s.alarm||{};\n'
  + '    g("ow"+i+"_alarm_en").checked=!!sa.enabled;\n'
  + '    g("ow"+i+"_alarm_min").value=sa.min_c!=null?sa.min_c:"";\n'
  + '    g("ow"+i+"_alarm_max").value=sa.max_c!=null?sa.max_c:"";\n'
  + '    g("ow"+i+"_alarm_mode").value=alarmModeFor(sa);\n'
  + '    onAlarmModeChange("ow"+i+"_");\n'
  + '    setupPgnListener("ow"+i+"_");\n'
  + '  });\n'
  + '  var ap=c.adc.pgn_id||1;\n'
  + '  g("adc_en").checked=!!c.adc.enabled;\n'
  + '  g("adc_pgn").innerHTML=pgnOpts(ap);\n'
  + '  g("adc_src").innerHTML=srcOpts(ap,c.adc.source);\n'
  + '  g("adc_inst").value=c.adc.instance;\n'
  + '  g("adc_poll").value=c.adc.poll_ms;\n'
  + '  g("adc_test_en").checked=!!c.adc.test_mode;\n'
  + '  g("adc_test_val").value=c.adc.test_value_c!=null?c.adc.test_value_c:20;\n'
  + '  var aa=c.adc.alarm||{};\n'
  + '  g("adc_alarm_en").checked=!!aa.enabled;\n'
  + '  g("adc_alarm_min").value=aa.min_c!=null?aa.min_c:"";\n'
  + '  g("adc_alarm_max").value=aa.max_c!=null?aa.max_c:"";\n'
  + '  g("adc_alarm_mode").value=alarmModeFor(aa);\n'
  + '  onAlarmModeChange("adc_");\n'
  + '  setupPgnListener("adc_");\n'
  + '  [0,1].forEach(function(i){\n'
  + '    var p=c.pulse[i];\n'
  + '    g("pc"+i+"_en").checked=!!p.enabled;\n'
  + '    g("pc"+i+"_mode").value=p.mode;\n'
  + '    g("pc"+i+"_hz").value=p.hz_per_mps;\n'
  + '    g("pc"+i+"_ppr").value=p.pulses_per_rev||1;\n'
  + '    g("pc"+i+"_eng").value=p.engine_instance||0;\n'
  + '    g("pc"+i+"_upd").value=p.update_ms;\n'
  + '    g("pc"+i+"_avg").value=p.avg_samples;\n'
  + '  });\n'
  + '});\n'
  /* Save handler */
  /* Gate min_c/max_c by the Threshold selector — matches alarmModeFor()
   * on load, so re-saving without touching the alarm block round-trips. */
  + 'function alarmFor(prefix){\n'
  + '  var mode=g(prefix+"alarm_mode").value;\n'
  + '  var minV=g(prefix+"alarm_min").value, maxV=g(prefix+"alarm_max").value;\n'
  + '  return{enabled:g(prefix+"alarm_en").checked,\n'
  + '    min_c:(mode==="min"||mode==="both")&&minV!==""?+minV:null,\n'
  + '    max_c:(mode==="max"||mode==="both")&&maxV!==""?+maxV:null};\n'
  + '}\n'
  + 'g("f").addEventListener("submit",function(e){\n'
  + '  e.preventDefault();\n'
  + '  var c={\n'
  + '    onewire:{poll_ms:+g("ow_poll").value,slots:[0,1,2,3].map(function(i){\n'
  + '      return{enabled:g("ow"+i+"_en").checked,pgn_id:+g("ow"+i+"_pgn").value,source:+g("ow"+i+"_src").value,instance:+g("ow"+i+"_inst").value,test_mode:g("ow"+i+"_test_en").checked,test_value_c:+g("ow"+i+"_test_val").value,'
  + '        alarm:alarmFor("ow"+i+"_")};\n'
  + '    })},\n'
  + '    adc:{enabled:g("adc_en").checked,pgn_id:+g("adc_pgn").value,source:+g("adc_src").value,instance:+g("adc_inst").value,poll_ms:+g("adc_poll").value,test_mode:g("adc_test_en").checked,test_value_c:+g("adc_test_val").value,'
  + '      alarm:alarmFor("adc_")},\n'
  + '    pulse:[0,1].map(function(i){return{enabled:g("pc"+i+"_en").checked,mode:g("pc"+i+"_mode").value,hz_per_mps:+g("pc"+i+"_hz").value,pulses_per_rev:+g("pc"+i+"_ppr").value,engine_instance:+g("pc"+i+"_eng").value,update_ms:+g("pc"+i+"_upd").value,avg_samples:+g("pc"+i+"_avg").value};})\n'
  + '  };\n'
  + '  fetch("/api/config",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(c)})\n'
  + '    .then(function(r){return r.json();})\n'
  + '    .then(function(j){g("msg").textContent=j.ok?"Saved. bridge.js will push to STM32 automatically.":"Error: "+j.error;});\n'
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
