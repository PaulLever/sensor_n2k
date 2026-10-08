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
const WebSocket = require('ws');
const { SHARED_STYLE, navHtml } = require('./shared-ui');

const PORT        = 3001;
const CONFIG_DIR  = '/etc/sensor_n2k';
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const LOCAL_BUS_URL = 'ws://127.0.0.1:3010';

/* N2K_PGNCFG_* (must match sensor_config.h and bridge.js) */
const PGNCFG = { TEMP: 0, TEMP_EXT: 1, ENV_PARAMS: 2, ENGINE_DYN: 3 };

/* Default alarm sub-object — consumed only by alarm-server.js's
 * default-rule sync, never pushed to the STM32 (see plan note: these
 * ranges are a host-side-only concept). */
function defaultAlarm() { return { enabled: false, min_c: null, max_c: null }; }

const DEFAULT_CONFIG = {
  onewire: {
    poll_ms: 2000,
    /* rom_id: 16-hex-char 1-Wire ROM id binding this slot to a specific
     * physical sensor, or null for legacy positional binding (slot N =
     * the Nth sensor found in bus-scan order). See the "Bind sensor"
     * workflow below and resolve_slave_index() in onewire.c. */
    slots: [
      { enabled: true,  pgn_id: PGNCFG.TEMP, source: 2, instance: 1, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm(), rom_id: null },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 2, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm(), rom_id: null },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 3, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm(), rom_id: null },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 4, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm(), rom_id: null },
    ],
  },
  adc:   { enabled: true, pgn_id: PGNCFG.TEMP_EXT, source: 14, instance: 0, poll_ms: 1000, test_mode: false, test_value_c: 20.0, alarm: defaultAlarm() },
  pulse: [
    { enabled: false, mode: 'STW', hz_per_mps: 9.33,  update_ms: 1000, avg_samples: 5 },
    { enabled: false, mode: 'RPM', pulses_per_rev: 1.0, engine_instance: 0, update_ms: 500, avg_samples: 3 },
  ],
  /* labels: free-text suffix shown after "Bilge N" (config page + bilge
   * monitoring page), e.g. "Aft" -> "Bilge 1 Aft". Host-side display only,
   * never pushed to the STM32 (same class of field as onewire/adc alarm). */
  bilge: { enabled: [false, false, false, false], switch_instance: 1, debounce_ms: 2000, labels: ['', '', '', ''] },
  /* Engine/transmission fault notifications (PGN 127489/127493) this
   * device is allowed to pass through to Signal K. Empty by default —
   * this device has no sensors backing any of these conditions, so
   * bridge.js suppresses all of them until a flag key is added here (see
   * the "Engine/Transmission Fault Notifications" section below and the
   * matching comment in bridge.js). */
  notificationPassthrough: { propulsion: [] },
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
    if (s.rom_id === undefined)     { s.rom_id = null; }
  });
  cfg.onewire.slots = slots;
  /* Ensure adc has pgn_id and test fields */
  if (cfg.adc) {
    if (cfg.adc.pgn_id === undefined)     { cfg.adc.pgn_id = PGNCFG.TEMP_EXT; }
    if (cfg.adc.test_mode === undefined)  { cfg.adc.test_mode = false; }
    if (cfg.adc.test_value_c === undefined) { cfg.adc.test_value_c = 20.0; }
    if (cfg.adc.alarm === undefined)      { cfg.adc.alarm = defaultAlarm(); }
  }
  /* Ensure bilge exists (config.json predating this feature) */
  if (!cfg.bilge || !Array.isArray(cfg.bilge.enabled) || cfg.bilge.enabled.length !== 4) {
    cfg.bilge = { enabled: [false, false, false, false], switch_instance: 1, debounce_ms: 2000, labels: ['', '', '', ''] };
  }
  if (cfg.bilge.switch_instance === undefined) { cfg.bilge.switch_instance = 1; }
  if (cfg.bilge.debounce_ms === undefined) { cfg.bilge.debounce_ms = 2000; }
  if (!Array.isArray(cfg.bilge.labels) || cfg.bilge.labels.length !== 4) {
    cfg.bilge.labels = ['', '', '', ''];
  }
  /* Ensure notificationPassthrough exists (config.json predating this feature) */
  if (!cfg.notificationPassthrough || !Array.isArray(cfg.notificationPassthrough.propulsion)) {
    cfg.notificationPassthrough = { propulsion: [] };
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
/* Local bus (bridge.js) — trigger 1-Wire rescans, receive ROM reports */
/* ------------------------------------------------------------------ */

let localBusWs = null;
/* Last scan result. ts=0 means "no scan yet this boot" — the UI uses that
 * to distinguish "haven't scanned" from "scanned, found nothing". */
let lastScan = { ts: 0, roms: [] };

function localBusSend(msg) {
  if (localBusWs && localBusWs.readyState === WebSocket.OPEN) {
    localBusWs.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function connectLocalBus() {
  localBusWs = new WebSocket(LOCAL_BUS_URL);
  localBusWs.on('open', () => console.log('[CFG] Connected to local bus', LOCAL_BUS_URL));
  localBusWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'onewireRoms') {
      lastScan = { ts: Date.now(), roms: msg.roms || [] };
      console.log('[CFG] 1-Wire scan result:', lastScan.roms);
    }
  });
  localBusWs.on('error', (e) => console.warn('[CFG] local bus error:', e.message));
  localBusWs.on('close', () => {
    console.warn('[CFG] local bus disconnected, retrying in 3s…');
    setTimeout(connectLocalBus, 3000);
  });
}

/* ------------------------------------------------------------------ */
/* Static HTML                                                          */
/* ------------------------------------------------------------------ */

var HTML = '<!DOCTYPE html>\n'
  + '<html lang="en"><head><meta charset="UTF-8">\n'
  + '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
  + '<title>sensor_n2k Config</title>\n'
  + SHARED_STYLE + '\n'
  + '<style>\n'
  + 'label{display:block;margin:.4em 0 .1em;font-weight:600;color:var(--text)}\n'
  + 'input[type=number],input[type=text],select{width:100%;padding:.4em .5em;box-sizing:border-box}\n'
  + '.row{display:flex;gap:1em}.row>div{flex:1}\n'
  + 'details{margin:.4em 0}summary{cursor:pointer;padding:.3em 0;font-weight:600}\n'
  + '.note{font-size:.85em;color:var(--text-dim);margin:.2em 0 .6em}\n'
  + '</style></head><body>\n'
  + navHtml('config') + '\n'
  + '<div class="wrap">\n'
  + '<h1>Configuration</h1>\n'
  + '<p class="sub">Saved to <code>/etc/sensor_n2k/config.json</code>. bridge.js auto-detects changes and pushes to STM32.</p>\n'
  + '<form id="f">\n'
  + '<div class="card">\n'

  /* 1-Wire */
  + '<h2>1-Wire Temperature Sensors (D8 / PB4)</h2>\n'
  + '<p class="note">Each slot can be bound to a specific sensor by its 1-Wire ROM ID (recommended — survives sensors failing/reordering), or left unbound to fall back to bus-scan position (slot 0 = first sensor found, etc.)</p>\n'
  + '<fieldset>\n'
  + '  <div class="row"><div>\n'
  + '    <label>Poll interval ms (shared for all slots)</label>\n'
  + '    <input type="number" id="ow_poll" min="800" max="10000" step="200">\n'
  + '  </div></div>\n'
  + '  <div class="row"><div>\n'
  + '    <button type="button" id="ow_livescan_btn" onclick="toggleLiveScan()">Start Live Scan</button>\n'
  + '    <span class="note" id="ow_scan_status">No scan yet this boot.</span>\n'
  + '  </div></div>\n'
  /* Plain non-modal list, not a <select> — a dropdown menu blocks clicks
   * on the rest of the page (incl. this very button) while open, and its
   * options can\'t visibly update while it\'s open anyway, which defeats
   * "watch the live reading change while I warm the sensor in my hand".
   * Binding happens via a button per row instead. */
  + '  <div class="row"><div id="ow_live_list" style="width:100%"></div></div>\n'
  + '  <details open><summary>Slot 0 — first DS18B20 found</summary>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="ow0_en"> Enabled</label></div>\n'
  + '    <div><label>N2K PGN</label><select id="ow0_pgn"></select></div>\n'
  + '    <div><label>Source / Field</label><select id="ow0_src"></select></div>\n'
  + '    <div><label>Instance</label><input type="number" id="ow0_inst" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div style="flex:2"><label>Bound sensor</label><div class="note" id="ow0_rom" style="padding:.4em 0"></div></div>\n'
  + '    <div><label>&nbsp;</label><button type="button" onclick="unbindSlot(0)">Unbind</button></div>\n'
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
  + '    <div style="flex:2"><label>Bound sensor</label><div class="note" id="ow1_rom" style="padding:.4em 0"></div></div>\n'
  + '    <div><label>&nbsp;</label><button type="button" onclick="unbindSlot(1)">Unbind</button></div>\n'
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
  + '    <div style="flex:2"><label>Bound sensor</label><div class="note" id="ow2_rom" style="padding:.4em 0"></div></div>\n'
  + '    <div><label>&nbsp;</label><button type="button" onclick="unbindSlot(2)">Unbind</button></div>\n'
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
  + '    <div style="flex:2"><label>Bound sensor</label><div class="note" id="ow3_rom" style="padding:.4em 0"></div></div>\n'
  + '    <div><label>&nbsp;</label><button type="button" onclick="unbindSlot(3)">Unbind</button></div>\n'
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
  + '    <div><label>Mode</label><select id="pc0_mode" onchange="onPulseModeChange(0)"><option value="STW">STW — Speed Through Water (PGN 128259)</option><option value="RPM">Engine RPM (PGN 127488)</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Hz per m/s (STW)</label><input type="number" id="pc0_hz" min="0.1" max="1000" step="0.01"></div>\n'
  + '    <div><label>Pulses/rev (RPM)</label><input type="number" id="pc0_ppr" min="0.1" max="500" step="0.1"></div>\n'
  + '    <div><label>Engine instance</label><input type="number" id="pc0_eng" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Update ms (100–2000)</label><input type="number" id="pc0_upd" min="100" max="2000" step="1"></div>\n'
  + '    <div><label>Avg samples (1–10)</label><input type="number" id="pc0_avg" min="1" max="10"></div>\n'
  + '  </div>\n'
  + '</fieldset>\n'

  /* Pulse counter 1 */
  + '<h2>Pulse Counter 1 — D6 / PB1</h2>\n'
  + '<fieldset>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="pc1_en"> Enabled</label></div>\n'
  + '    <div><label>Mode</label><select id="pc1_mode" onchange="onPulseModeChange(1)"><option value="STW">STW — Speed Through Water (PGN 128259)</option><option value="RPM">Engine RPM (PGN 127488)</option></select></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Hz per m/s (STW)</label><input type="number" id="pc1_hz" min="0.1" max="1000" step="0.01"></div>\n'
  + '    <div><label>Pulses/rev (RPM)</label><input type="number" id="pc1_ppr" min="0.1" max="500" step="0.1"></div>\n'
  + '    <div><label>Engine instance</label><input type="number" id="pc1_eng" min="0" max="253"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>Update ms (100–2000)</label><input type="number" id="pc1_upd" min="100" max="2000" step="1"></div>\n'
  + '    <div><label>Avg samples (1–10)</label><input type="number" id="pc1_avg" min="1" max="10"></div>\n'
  + '  </div>\n'
  + '</fieldset>\n'

  /* Bilge pump monitor */
  + '<h2>Bilge Pump Monitor</h2>\n'
  + '<fieldset>\n'
  + '  <div class="row">\n'
  + '    <div><label><input type="checkbox" id="bilge0_en"> Bilge 1 (D2)</label><input type="text" id="bilge0_label" placeholder="e.g. Aft" maxlength="24"></div>\n'
  + '    <div><label><input type="checkbox" id="bilge1_en"> Bilge 2 (D7)</label><input type="text" id="bilge1_label" placeholder="e.g. Forward" maxlength="24"></div>\n'
  + '    <div><label><input type="checkbox" id="bilge2_en"> Bilge 3 (D11)</label><input type="text" id="bilge2_label" placeholder="e.g. Engine Room" maxlength="24"></div>\n'
  + '    <div><label><input type="checkbox" id="bilge3_en"> Bilge 4 (D12)</label><input type="text" id="bilge3_label" placeholder="e.g. Shower Sump" maxlength="24"></div>\n'
  + '  </div>\n'
  + '  <div class="row">\n'
  + '    <div><label>N2K Switch Bank Instance (PGN 127501)</label><input type="number" id="bilge_switch_instance" min="0" max="252"></div>\n'
  + '    <div><label>Switch debounce (ms)</label><input type="number" id="bilge_debounce_ms" min="0" max="10000" step="100"></div>\n'
  + '  </div>\n'
  + '  <p class="note">Real float switches chatter for much longer than a clean electrical bounce as they bob with wave action — '
  + 'if cycle counts look inflated on the <a href="#" id="bilge-link">Bilge Pumps</a> page, raise this. Shared by all 4 channels.</p>\n'
  + '  <p class="note">Alarm thresholds on these counts/runtime are on the Alarms page.</p>\n'
  + '</fieldset>\n'

  /* Engine/transmission fault notification passthrough */
  + '<h2>Engine/Transmission Fault Notifications</h2>\n'
  + '<fieldset>\n'
  + '  <p class="note">This device has no sensors for any of these conditions — Signal K would otherwise show '
  + 'all of them as "Normal" (not "no data"; PGN 127489/127493 have no way to say that per-flag), which is misleading.'
  + ' All are hidden from Signal K by default. If you wire up a real sensor for one of these later, select it below (ctrl/cmd-click '
  + 'for more than one) to let its notification through.</p>\n'
  + '  <select id="notif_select" multiple size="12" style="width:100%"></select>\n'
  + '</fieldset>\n'

  + '</div>\n'
  + '<button type="submit" class="primary" style="padding:.7em 2em;font-size:1.05em">Save &amp; Apply</button>\n'
  + '<div class="msg" id="msg" style="margin-top:1em;color:var(--ok);font-weight:600"></div>\n'
  + '</form>\n'
  + '</div>\n'

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
  /* Engine/transmission fault flags — key matches the path segment bridge.js
   * checks against notificationPassthrough.propulsion (see its comment
   * above loadSensorConfig() / isBlockedNotification()). Grouped to match
   * the three discreteStatus bit tables in n2k-signalk's PGN 127489/127493
   * handlers, so it is obvious which physical byte each checkbox maps to. */
  + 'var NOTIF_FLAGS=[\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"checkEngine",l:"Check Engine"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"overTemperature",l:"Over Temperature"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"lowOilPressure",l:"Low Oil Pressure"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"lowOilLevel",l:"Low Oil Level"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"lowFuelPressure",l:"Low Fuel Pressure"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"lowSystemVoltage",l:"Low System Voltage"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"lowCoolantLevel",l:"Low Coolant Level"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"waterFlow",l:"Water Flow"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"waterInFuel",l:"Water In Fuel"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"chargeIndicator",l:"Charge Indicator"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"preheatIndicator",l:"Preheat Indicator"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"highBoostPressure",l:"High Boost Pressure"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"revLimitExceeded",l:"Rev Limit Exceeded"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"eGRSystem",l:"EGR System"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"throttlePositionSensor",l:"Throttle Position Sensor"},\n'
  + '  {g:"Engine Status 1 — PGN 127489",k:"emergencyStopMode",l:"Emergency Stop"},\n'
  + '  {g:"Engine Status 2 — PGN 127489",k:"warningLevel1",l:"Warning Level 1"},\n'
  + '  {g:"Engine Status 2 — PGN 127489",k:"warningLevel2",l:"Warning Level 2"},\n'
  + '  {g:"Engine Status 2 — PGN 127489",k:"powerReduction",l:"Power Reduction"},\n'
  + '  {g:"Engine Status 2 — PGN 127489",k:"maintenanceNeeded",l:"Maintenance Needed"},\n'
  + '  {g:"Engine Status 2 — PGN 127489",k:"commError",l:"Engine Comm Error"},\n'
  + '  {g:"Engine Status 2 — PGN 127489",k:"subOrSecondaryThrottle",l:"Sub or Secondary Throttle"},\n'
  + '  {g:"Engine Status 2 — PGN 127489",k:"neutralStartProtect",l:"Neutral Start Protect"},\n'
  + '  {g:"Engine Status 2 — PGN 127489",k:"shuttingDown",l:"Engine Shutting Down"},\n'
  + '  {g:"Transmission Status 1 — PGN 127493",k:"transmission.checkTransmission",l:"Check Transmission"},\n'
  + '  {g:"Transmission Status 1 — PGN 127493",k:"transmission.overTemperature",l:"Over Temperature"},\n'
  + '  {g:"Transmission Status 1 — PGN 127493",k:"transmission.lowOilPressure",l:"Low Oil Pressure"},\n'
  + '  {g:"Transmission Status 1 — PGN 127493",k:"transmission.lowOilLevel",l:"Low Oil Level"},\n'
  + '  {g:"Transmission Status 1 — PGN 127493",k:"transmission.sailDrive",l:"Sail Drive"}\n'
  + '];\n'
  + 'function renderNotifGroups(){\n'
  + '  var groups=[];\n'
  + '  NOTIF_FLAGS.forEach(function(f){if(groups.indexOf(f.g)===-1){groups.push(f.g);}});\n'
  + '  g("notif_select").innerHTML=groups.map(function(grp){\n'
  + '    var opts=NOTIF_FLAGS.filter(function(f){return f.g===grp;})\n'
  + '      .map(function(f){return "<option value=\\""+f.k+"\\">"+f.l+"</option>";})\n'
  + '      .join("");\n'
  + '    return "<optgroup label=\\""+grp+"\\">"+opts+"</optgroup>";\n'
  + '  }).join("");\n'
  + '}\n'
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
  /* STW and RPM modes use disjoint calibration fields (Hz/m/s vs.
   * Pulses/rev + Engine instance) — disable whichever set doesn\'t apply
   * to the selected mode rather than leaving both editable, since a
   * value typed into the inactive set is silently ignored either way. */
  + 'function onPulseModeChange(i){\n'
  + '  var stw=g("pc"+i+"_mode").value==="STW";\n'
  + '  g("pc"+i+"_hz").disabled=!stw;\n'
  + '  g("pc"+i+"_ppr").disabled=stw;\n'
  + '  g("pc"+i+"_eng").disabled=stw;\n'
  + '}\n'
  /* 1-Wire sensor ID binding — see toggleLiveScan()/bindToSlot()/
   * renderRomUi() below. gConfig/gRoms are populated once both fetches
   * below resolve. */
  + 'var gConfig=null,gRoms={ts:0,roms:[]};\n'
  + 'function boundSlotFor(rom){\n'
  + '  for(var i=0;i<4;i++){if(gConfig.onewire.slots[i].rom_id===rom){return i;}}\n'
  + '  return -1;\n'
  + '}\n'
  /* gRoms.roms entries are {rom,tempC,valid} — tempC is a live reading
   * taken during the scan, letting the user identify an unbound sensor
   * by warming it in their hand and watching which entry\'s value moves. */
  + 'function tempLabel(r){return r.valid?(r.tempC.toFixed(1)+"\\u00b0C"):"no reading";}\n'
  /* Read-only "what's this slot bound to" line inside each slot's own
   * fieldset — the actual bind action lives in the shared live list below. */
  + 'function renderSlotBoundLabel(i){\n'
  + '  var cur=gConfig.onewire.slots[i].rom_id;\n'
  + '  var el=g("ow"+i+"_rom");\n'
  + '  if(!cur){el.textContent="Unbound — using bus position "+i; return;}\n'
  + '  var seen=gRoms.roms.filter(function(r){return r.rom===cur;})[0];\n'
  + '  el.textContent=seen?(cur+" — "+tempLabel(seen)):(cur+" (not seen in last scan)");\n'
  + '}\n'
  /* Central, always-visible (never a blocking <select>) list of every
   * sensor seen in the last scan, each with its live temperature and one
   * button per slot to bind it directly — see toggleLiveScan() for how
   * this list keeps refreshing on its own while the user works. */
  + 'function renderLiveList(){\n'
  + '  var el=g("ow_live_list");\n'
  + '  if(gRoms.roms.length===0){\n'
  + '    el.innerHTML=\'<div class="note">No sensors seen yet — click Start Live Scan.</div>\';\n'
  + '    return;\n'
  + '  }\n'
  + '  el.innerHTML=gRoms.roms.map(function(r){\n'
  + '    var boundTo=boundSlotFor(r.rom);\n'
  + '    var btns=[0,1,2,3].map(function(i){\n'
  + '      var isCur=(boundTo===i);\n'
  + '      return \'<button type="button" style="margin-left:.3em"\'\n'
  + '        +(isCur?\' disabled title="Currently bound here"\':\'\')\n'
  + '        +\' onclick="bindToSlot(\\\'\'+r.rom+\'\\\',\'+i+\')">\'\n'
  + '        +(isCur?"\\u2713 Slot "+i:"\\u2192 Slot "+i)+"</button>";\n'
  + '    }).join("");\n'
  + '    return \'<div class="row" style="align-items:center;margin:.3em 0">\'\n'
  + '      +\'<div style="flex:2"><code>\'+r.rom+"</code> — "+tempLabel(r)+"</div>"\n'
  + '      +"<div>"+btns+"</div></div>";\n'
  + '  }).join("");\n'
  + '}\n'
  + 'function renderRomUi(){\n'
  + '  [0,1,2,3].forEach(renderSlotBoundLabel);\n'
  + '  renderLiveList();\n'
  + '  g("ow_scan_status").textContent=gRoms.ts\n'
  + '    ?(new Date(gRoms.ts).toLocaleTimeString()+" — "+gRoms.roms.length+" sensor(s) found on bus"+(liveScanTimer?" (live)":""))\n'
  + '    :"No scan yet this boot — click Start Live Scan to see what\\u2019s on the bus.";\n'
  + '}\n'
  + 'function bindToSlot(rom,i){\n'
  + '  fetch("/api/onewire/bind",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slot:i,rom_id:rom})})\n'
  + '    .then(function(r){return r.json();})\n'
  + '    .then(function(j){\n'
  + '      if(j.ok){\n'
  + '        gConfig.onewire.slots[i].rom_id=rom;\n'
  + '        renderRomUi();\n'
  + '        g("msg").textContent="Slot "+i+" bound to sensor "+rom+".";\n'
  + '      }else{\n'
  + '        g("msg").textContent="Bind error: "+j.error;\n'
  + '      }\n'
  + '    });\n'
  + '}\n'
  + 'function unbindSlot(i){\n'
  + '  fetch("/api/onewire/bind",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({slot:i,rom_id:null})})\n'
  + '    .then(function(r){return r.json();})\n'
  + '    .then(function(j){\n'
  + '      if(j.ok){\n'
  + '        gConfig.onewire.slots[i].rom_id=null;\n'
  + '        renderRomUi();\n'
  + '        g("msg").textContent="Slot "+i+" unbound (back to bus position).";\n'
  + '      }else{\n'
  + '        g("msg").textContent="Unbind error: "+j.error;\n'
  + '      }\n'
  + '    });\n'
  + '}\n'
  /* Live Scan: keeps re-triggering a bus scan (~1s cadence — comfortably
   * longer than the ~750ms conversion the firmware does per scan) and
   * separately polling the result twice a second, so the list above just
   * keeps updating on its own — no click-and-wait, and nothing modal to
   * block clicking Stop or a bind button mid-scan. Auto-stops after 3
   * minutes as a safety net in case a tab gets left open. */
  + 'var liveScanTimer=null,liveRomsTimer=null,liveScanStopAt=null;\n'
  + 'function pollRomsOnce(){\n'
  + '  fetch("/api/onewire/roms").then(function(r){return r.json();}).then(function(rj){\n'
  + '    if(rj.ts>gRoms.ts){gRoms=rj;renderRomUi();}\n'
  + '  });\n'
  + '}\n'
  + 'function triggerRescan(){\n'
  + '  fetch("/api/onewire/rescan",{method:"POST"}).then(function(r){return r.json();}).then(function(j){\n'
  + '    if(!j.ok){g("ow_scan_status").textContent="Rescan failed: "+j.error+" — stopping live scan.";stopLiveScan();}\n'
  + '  });\n'
  + '  if(liveScanStopAt&&Date.now()>liveScanStopAt){\n'
  + '    stopLiveScan();\n'
  + '    g("ow_scan_status").textContent+=" (auto-stopped after 3 min)";\n'
  + '  }\n'
  + '}\n'
  + 'function stopLiveScan(){\n'
  + '  if(liveScanTimer){clearInterval(liveScanTimer);liveScanTimer=null;}\n'
  + '  if(liveRomsTimer){clearInterval(liveRomsTimer);liveRomsTimer=null;}\n'
  + '  liveScanStopAt=null;\n'
  + '  g("ow_livescan_btn").textContent="Start Live Scan";\n'
  + '}\n'
  + 'function toggleLiveScan(){\n'
  + '  if(liveScanTimer){stopLiveScan();renderRomUi();return;}\n'
  + '  g("ow_livescan_btn").textContent="Stop Live Scan";\n'
  + '  liveScanStopAt=Date.now()+3*60*1000;\n'
  + '  triggerRescan();\n'
  + '  liveScanTimer=setInterval(triggerRescan,1000);\n'
  + '  liveRomsTimer=setInterval(pollRomsOnce,500);\n'
  + '}\n'
  /* Load config from server */
  + 'Promise.all([\n'
  + '  fetch("/api/config").then(function(r){return r.json();}),\n'
  + '  fetch("/api/onewire/roms").then(function(r){return r.json();})\n'
  + ']).then(function(results){\n'
  + '  var c=results[0]; gConfig=c; gRoms=results[1];\n'
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
  + '  renderRomUi();\n'
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
  + '    onPulseModeChange(i);\n'
  + '  });\n'
  + '  var bilge=c.bilge||{enabled:[false,false,false,false],switch_instance:1,debounce_ms:2000,labels:["","","",""]};\n'
  + '  [0,1,2,3].forEach(function(i){ g("bilge"+i+"_en").checked=!!bilge.enabled[i]; g("bilge"+i+"_label").value=(bilge.labels&&bilge.labels[i])||""; });\n'
  + '  g("bilge_switch_instance").value=bilge.switch_instance;\n'
  + '  g("bilge_debounce_ms").value=bilge.debounce_ms!=null?bilge.debounce_ms:2000;\n'
  + '  renderNotifGroups();\n'
  + '  var allowed=(c.notificationPassthrough&&c.notificationPassthrough.propulsion)||[];\n'
  + '  Array.prototype.forEach.call(g("notif_select").options, function(o){ o.selected=allowed.indexOf(o.value)!==-1; });\n'
  + '});\n'
  + 'document.getElementById("bilge-link").addEventListener("click",function(e){\n'
  + '  e.preventDefault();\n'
  + '  location.href="//"+location.hostname+":3004/";\n'
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
  /* rom_id is managed by the separate Bind button (immediate, its own
   * endpoint) — round-trip whatever gConfig currently holds so a plain
   * Save & Apply here never clobbers a binding the user just set. */
  + '        rom_id:gConfig.onewire.slots[i].rom_id,alarm:alarmFor("ow"+i+"_")};\n'
  + '    })},\n'
  + '    adc:{enabled:g("adc_en").checked,pgn_id:+g("adc_pgn").value,source:+g("adc_src").value,instance:+g("adc_inst").value,poll_ms:+g("adc_poll").value,test_mode:g("adc_test_en").checked,test_value_c:+g("adc_test_val").value,'
  + '      alarm:alarmFor("adc_")},\n'
  + '    pulse:[0,1].map(function(i){return{enabled:g("pc"+i+"_en").checked,mode:g("pc"+i+"_mode").value,hz_per_mps:+g("pc"+i+"_hz").value,pulses_per_rev:+g("pc"+i+"_ppr").value,engine_instance:+g("pc"+i+"_eng").value,update_ms:+g("pc"+i+"_upd").value,avg_samples:+g("pc"+i+"_avg").value};}),\n'
  + '    bilge:{enabled:[0,1,2,3].map(function(i){return g("bilge"+i+"_en").checked;}),switch_instance:+g("bilge_switch_instance").value,debounce_ms:+g("bilge_debounce_ms").value,labels:[0,1,2,3].map(function(i){return g("bilge"+i+"_label").value;})},\n'
  + '    notificationPassthrough:{propulsion:Array.prototype.filter.call(g("notif_select").options,function(o){return o.selected;}).map(function(o){return o.value;})}\n'
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

  if (req.method === 'GET' && req.url === '/api/onewire/roms') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(lastScan));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/onewire/rescan') {
    const sent = localBusSend({ type: 'ow_rescan' });
    res.writeHead(sent ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sent
      ? { ok: true }
      : { ok: false, error: 'not connected to bridge.js local bus' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/api/onewire/bind') {
    var bindBody = '';
    req.on('data', function(d) { bindBody += d; });
    req.on('end', function() {
      try {
        var b = JSON.parse(bindBody);
        var slotIdx = b.slot | 0;
        var romId = b.rom_id || null;   /* null = unbind -> back to positional */
        if (slotIdx < 0 || slotIdx > 3) { throw new Error('slot must be 0-3'); }
        if (romId !== null && !/^[0-9a-fA-F]{16}$/.test(romId)) {
          throw new Error('rom_id must be 16 hex chars');
        }
        var cfg = loadConfig();
        cfg.onewire.slots[slotIdx].rom_id = romId ? romId.toLowerCase() : null;
        saveConfig(cfg);
        console.log('[CFG] Bound slot', slotIdx, 'to ROM', romId || '(unbound)');
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

connectLocalBus();
