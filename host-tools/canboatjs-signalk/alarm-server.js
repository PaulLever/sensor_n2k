#!/usr/bin/env node
'use strict';

/*
 * alarm-server.js — user-defined alarm engine for sensor_n2k.
 *
 * Ingests decoded PGN events from bridge.js's local event bus
 * (ws://127.0.0.1:3010), evaluates alarm rules (range-based or native N2K
 * Alert PGN 126983), drives hardware output (buzzer/LED via the same
 * local bus, or a Bluetooth speaker via bt-speaker.js), and serves a
 * webapp + REST API on port 3002.
 *
 * PGN 126983 field names (alertType/alertCategory/alertSystem/alertId)
 * were confirmed against the real @canboat/ts-pgns schema
 * (getPGNWithNumber(126983)) on-device before writing the matcher below —
 * the plan's illustrative names turned out to be exactly right.
 *
 * Persists to /etc/sensor_n2k/alarms.json (see DEFAULT_ALARMS below for
 * the schema). Same one-service-per-concern pattern as bridge.js /
 * config-server.js / signalk-server.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { SHARED_STYLE, navHtml } = require('./shared-ui');

const bt = require('./bt-speaker.js');

const PORT = 3002;
const ALARMS_DIR  = '/etc/sensor_n2k';
const ALARMS_FILE = path.join(ALARMS_DIR, 'alarms.json');
const SENSOR_CONFIG_FILE = path.join(ALARMS_DIR, 'config.json');

const LOCAL_BUS_URL = 'ws://127.0.0.1:3010';
const BUS_MONITOR_URL = 'http://127.0.0.1:3003/api/bus';

/* ------------------------------------------------------------------ */
/* PGN catalog + Alert enums, from @canboat/ts-pgns — powers the Rules  */
/* form's PGN/Field dropdowns and the Alert Type/Category dropdowns.    */
/* ------------------------------------------------------------------ */

let pgnCatalog = [];
let alertTypeValues = {};
let alertCategoryValues = {};
/* PGN 127489/127493's "instance" field is FieldType LOOKUP (enum
 * ENGINE_INSTANCE) — canboatjs decodes it to a label string (e.g.
 * "Single Engine or Dual Engine Port"), not the raw number. This is the
 * reverse map (label -> number) matchRangeRule() needs to compare it
 * against a rule's configured instance; see resolveInstance() below. */
let engineInstanceValues = {};
/* number -> name, e.g. 2 -> "Inside Temperature" — used to build
 * meaningful default-rule labels in syncDefaultRulesFromConfig() (same
 * enum config-server.js's SRCS dropdown is built from). */
let temperatureSourceNames = {};

try {
  const tsPgns = require('@canboat/ts-pgns');
  alertTypeValues = tsPgns.AlertTypeValues || {};
  alertCategoryValues = tsPgns.AlertCategoryValues || {};
  engineInstanceValues = tsPgns.EngineInstanceValues || {};
  temperatureSourceNames = Object.fromEntries(
    Object.entries(tsPgns.TemperatureSourceValues || {}).map(([name, val]) => [val, name])
  );

  /* ts-pgns doesn't export a single "list all PGNs" call — but it does
   * export one function per base PGN, named e.g. "PGN_130312". Recover
   * the numeric PGN list from those export names, then pull each one's
   * real definition (mnemonic Id, Description, Fields) via
   * getPGNWithNumber(). Restricted to PGNs with at least one NUMBER
   * field, since anything else has nothing a range alarm could target. */
  const pgnNums = new Set();
  for (const key of Object.keys(tsPgns)) {
    const m = /^PGN_(\d+)$/.exec(key);
    if (m) pgnNums.add(parseInt(m[1], 10));
  }
  for (const pgn of pgnNums) {
    try {
      const def = (tsPgns.getPGNWithNumber(pgn) || [])[0];
      if (!def) continue;
      const fields = (def.Fields || [])
        .filter(f => f.FieldType === 'NUMBER')
        .map(f => ({ id: f.Id, name: f.Name, unit: f.Unit || null }));
      if (fields.length === 0) continue;
      pgnCatalog.push({ pgn, id: def.Id, description: def.Description, fields });
    } catch (e) { /* skip unparseable definitions */ }
  }
  pgnCatalog.sort((a, b) => a.pgn - b.pgn);
  console.log(`[ALARM] PGN catalog: ${pgnCatalog.length} PGNs with numeric fields`);
} catch (e) {
  console.warn('[ALARM] @canboat/ts-pgns not found — PGN/Alert-Type dropdowns will be ' +
    'empty; run npm install in this directory.');
}

/** Best-effort device list from bus-monitor-server.js, for the alert
 *  rule's Source dropdown. Returns [] if bus-monitor isn't reachable —
 *  the form falls back to a plain numeric Source field in that case. */
function fetchBusDevices() {
  return new Promise((resolve) => {
    const req = http.get(BUS_MONITOR_URL, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve((parsed.devices || []).map(d => ({ src: d.src, name: d.name || d.manufacturer || null })));
        } catch (e) { resolve([]); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve([]));
  });
}

/* Same env-file mechanism as sensor-n2k-bridge.service
 * (/etc/sensor_n2k/signalk.env, root:root mode 600) — shared credentials,
 * not duplicated into a second file. */
const SK_HOST = process.env.SK_HOST || 'localhost';
const SK_PORT = parseInt(process.env.SK_PORT || '3000', 10);
const SK_USER = process.env.SK_USER || '';
const SK_PASS = process.env.SK_PASS || '';

/* N2K_PGNCFG_* — must match sensor_config.h / bridge.js / config-server.js */
const PGNCFG = { TEMP: 0, TEMP_EXT: 1, ENV_PARAMS: 2, ENGINE_DYN: 3, TRANS_DYN: 4 };

/* alarm_type → alarm_io.c buzzer pattern (see alarm_io.h) and →
 * bt-speaker.js's ALARM_LEVELS key — same four names used in both places.
 * Ordering matches the target loudness table: buzzer (85-95dB) <
 * warning (95-105dB) < alarm (105-115dB+) < bell (new, most urgent —
 * rapid marine-bell strike, above alarm). Patterns differ by cadence,
 * not real volume on the physical buzzer (v1 hardware is on/off only —
 * see alarm_io.h); the bt_speaker path has real (relative) gain control,
 * see bt-speaker.js's ALARM_LEVELS. */
const ALARM_TYPE_PATTERN = { buzzer: 3, warning: 2, alarm: 1, bell: 4 };

/* Old names, kept only so previously-persisted alarms.json rules migrate
 * cleanly on load (see migrateAlarmType() below) rather than silently
 * falling back to a default pattern. */
const ALARM_TYPE_MIGRATE = { loud: 'alarm', mid: 'warning' };

function migrateAlarmType(type) {
  return ALARM_TYPE_MIGRATE[type] || type;
}

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_ALARMS = {
  hardware: {
    output: 'buzzer_simple',   /* buzzer_simple | buzzer_led_button | bt_speaker */
    bt_speaker: { mac: '', name: '' },
  },
  /* Off-boat push notifications — see notifyRemote() below. Off by
   * default: this is the one alarm channel that leaves the vessel, and it
   * should be an explicit choice, not something that starts happening
   * because the software was updated. */
  remoteNotify: {
    enabled: false,
    channel: 'ntfy',           /* the seam: 'ntfy' today, 'email' later */
    ntfyServer: 'https://ntfy.sh',
    topic: '',
  },
  rules: [],
};

function loadAlarms() {
  try {
    if (fs.existsSync(ALARMS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(ALARMS_FILE, 'utf8'));
      if (!raw.hardware) raw.hardware = JSON.parse(JSON.stringify(DEFAULT_ALARMS.hardware));
      /* Merged rather than replaced so an alarms.json written before
       * remote notifications existed picks up the new defaults, and one
       * written before a later key was added picks up just that key. */
      raw.remoteNotify = { ...DEFAULT_ALARMS.remoteNotify, ...(raw.remoteNotify || {}) };
      if (!Array.isArray(raw.rules)) raw.rules = [];
      raw.rules.forEach(r => { r.alarm_type = migrateAlarmType(r.alarm_type); });
      return raw;
    }
  } catch (e) {
    console.error('[ALARM] Read error:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_ALARMS));
}

function saveAlarms() {
  try {
    if (!fs.existsSync(ALARMS_DIR)) fs.mkdirSync(ALARMS_DIR, { recursive: true });
    fs.writeFileSync(ALARMS_FILE, JSON.stringify(g_alarms, null, 2));
  } catch (e) {
    console.error('[ALARM] Write error:', e.message);
  }
}

let g_alarms = loadAlarms();

function findRule(id) { return g_alarms.rules.find(r => r.id === id); }

/* ------------------------------------------------------------------ */
/* Local bus (bridge.js) — ingest pgn/busstate/button, send hardware cmds */
/* ------------------------------------------------------------------ */

let localBusWs = null;

function localBusSend(msg) {
  if (localBusWs && localBusWs.readyState === WebSocket.OPEN) {
    localBusWs.send(JSON.stringify(msg));
  }
}

function connectLocalBus() {
  localBusWs = new WebSocket(LOCAL_BUS_URL);
  localBusWs.on('open', () => console.log('[ALARM] Connected to local bus', LOCAL_BUS_URL));
  localBusWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (msg.type === 'pgn') { evaluateRules(msg); }
    else if (msg.type === 'bilge') { evaluateRules(msg); }
    else if (msg.type === 'button') { cancelAll(); }
    /* type:'busstate' — not currently consumed here; bus-monitor-server.js owns it. */
  });
  localBusWs.on('error', (e) => console.warn('[ALARM] local bus error:', e.message));
  localBusWs.on('close', () => {
    console.warn('[ALARM] local bus disconnected, retrying in 3s…');
    setTimeout(connectLocalBus, 3000);
  });
}

/* ------------------------------------------------------------------ */
/* Rule matching                                                        */
/* ------------------------------------------------------------------ */

/** Resolve a decoded "instance" field to a plain number. Most PGNs
 *  (temperature ones) carry it as FieldType NUMBER, so it's already a
 *  number — but PGN 127489/127493 carry it as FieldType LOOKUP
 *  (ENGINE_INSTANCE), which canboatjs decodes to a label string like
 *  "Single Engine or Dual Engine Port" rather than 0. Number("Single
 *  Engine...") is NaN, which would never match a configured instance,
 *  so this instance filter has to resolve the label back to its number
 *  via the same enum canboatjs used to produce it. */
function resolveInstance(inst) {
  if (inst == null) return null;
  if (typeof inst === 'number') return inst;
  if (Object.prototype.hasOwnProperty.call(engineInstanceValues, inst)) {
    return engineInstanceValues[inst];
  }
  const n = Number(inst);
  return Number.isNaN(n) ? null : n;
}

function matchRangeRule(rule, evt) {
  if (rule.pgn !== evt.pgn) return null;
  if (rule.src != null && Number(rule.src) !== Number(evt.src)) return null;

  if (rule.instance != null) {
    const raw = evt.fields.instance ?? evt.fields.Instance ?? evt.fields.engineInstance;
    const inst = resolveInstance(raw);
    if (inst != null && inst !== Number(rule.instance)) return null;
  }

  const val = evt.fields[rule.field];
  if (val == null || typeof val !== 'number') return null;

  const belowMin = rule.min != null && val <= rule.min;
  const aboveMax = rule.max != null && val >= rule.max;

  return { outOfRange: belowMin || aboveMax, value: val };
}

function matchAlertRule(rule, evt) {
  if (evt.pgn !== 126983) return null;
  /* rule.src: null/undefined = any source. Set = scope this rule (match
   * or ignore) to one specific device, e.g. to silence a known-noisy
   * alert from one instrument without losing the same alert from others. */
  if (rule.src != null && Number(rule.src) !== Number(evt.src)) return null;
  if (rule.ignore) return null;   /* "set this source to ignore" case */

  const f = evt.fields;
  const identityMatches =
    f.alertType === rule.alertType &&
    f.alertCategory === rule.alertCategory &&
    f.alertSystem === rule.alertSystem &&
    f.alertSubSystem === rule.alertSubSystem &&
    f.alertId === rule.alertId;

  if (!identityMatches) return null;

  /* PGN 126983 itself carries alert *state* (see canboat's alertState
   * lookup — active vs not) as one of its fields; canboatjs surfaces the
   * decoded lookup label. Treat anything other than an explicit
   * "not active"-shaped value as active — verify the exact label text
   * against real hardware/simulator output once available; this couldn't
   * be checked against a live 126983 alert without a device emitting one. */
  const stateField = f.alertState ?? f['Alert State'];
  const outOfRange = stateField == null
    ? true
    : !/normal|not active|no alert/i.test(String(stateField));

  return { outOfRange, value: stateField };
}

/* Bilge pump count/runtime rules. Unlike the PGN-decoded rules above,
 * these match against bilge.c's own rolling-window stats (see
 * BILGE_REPORT_CAN_ID in bridge.js) rather than a real N2K field —
 * rule.metric picks cycles vs. on-time, rule.period picks which of the
 * three rolling windows the firmware maintains. There's no separate
 * "state" concept here the way matchRangeRule's belowMin/aboveMax has —
 * this fires (and stays fired, same as any other rule) whenever the
 * chosen window's count/runtime is at or above threshold, and clears
 * once it rolls back below — e.g. "more than 20 cycles in the last hour"
 * will clear on its own an hour after the last qualifying cycle, once
 * that cycle ages out of the rolling window, without needing a manual
 * cancel. */
function matchBilgeRule(rule, evt) {
  if (evt.type !== 'bilge') return null;
  if (rule.channel == null || rule.channel < 0 || rule.channel > 3) return null;

  const ch = evt.channels[rule.channel];
  if (!ch) return null;

  const field = {
    count_1h: 'cycles_1h', count_24h: 'cycles_24h', count_7d: 'cycles_7d',
    runtime_1h: 'on_s_1h', runtime_24h: 'on_s_24h', runtime_7d: 'on_s_7d',
  }[`${rule.metric}_${rule.period}`];
  if (!field) return null;

  const val = ch[field];
  if (val == null) return null;

  return { outOfRange: rule.threshold != null && val >= rule.threshold, value: val };
}

/* ------------------------------------------------------------------ */
/* Active-alarm state machine                                          */
/* ------------------------------------------------------------------ */

/* ruleId -> {since, lastRepeat, acked} */
const activeAlarms = new Map();

/* Handle from bt.monitorAndReconnect() — has .stop(). Only one should
 * ever be running; re-synced (stopped/restarted) whenever hardware
 * settings or the paired device change, not just once at startup —
 * otherwise picking "Bluetooth Speaker" and clicking Save has no effect
 * on reconnect behavior until the service is restarted. */
let btReconnectHandle = null;

function syncBtReconnectMonitor() {
  if (btReconnectHandle) {
    btReconnectHandle.stop();
    btReconnectHandle = null;
  }
  const mac = g_alarms.hardware.bt_speaker && g_alarms.hardware.bt_speaker.mac;
  if (g_alarms.hardware.output === 'bt_speaker' && mac) {
    btReconnectHandle = bt.monitorAndReconnect(mac, 30000);
  }
}

/* ------------------------------------------------------------------ */
/* IP announcement — via the paired Bluetooth speaker, spoken once at  */
/* boot (see announceBootWhenReady() below) so the board's address can */
/* be found after moving to a network where mDNS (.local) resolution   */
/* isn't reliable (confirmed unreliable over at least one Android      */
/* hotspot) and the old IP no longer applies — no prior network access */
/* needed to hear it, just Bluetooth range.                            */
/* ------------------------------------------------------------------ */

/** First non-internal IPv4 address, preferring wlan0 (this board's normal
 *  network path) if present. Returns null if nothing's up yet (e.g. still
 *  associating at boot). */
function currentIpAddress() {
  const ifaces = os.networkInterfaces();
  const order = ifaces.wlan0 ? ['wlan0'] : Object.keys(ifaces);
  for (const name of order) {
    const addrs = ifaces[name];
    if (!addrs) continue;
    const v4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

/** "192.168.43.2" -> "1 9 2 dot 1 6 8 dot 4 3 dot 2" — spelling out each
 *  digit individually rather than as multi-digit numbers ("one hundred
 *  ninety two") is far less ambiguous to write down from hearing once. */
function speakableIp(ip) {
  return ip.split('.').map(octet => octet.split('').join(' ')).join(' dot ');
}

async function announceIpAddress() {
  const mac = g_alarms.hardware.bt_speaker && g_alarms.hardware.bt_speaker.mac;
  if (g_alarms.hardware.output !== 'bt_speaker' || !mac) {
    console.log('[ALARM] announceIpAddress: no Bluetooth speaker configured, skipping');
    return;
  }
  const ip = currentIpAddress();
  const text = ip
    ? `Sensor N2K network address: ${speakableIp(ip)}`
    : 'Sensor N2K has no network address yet';
  console.log('[ALARM] announcing:', text);
  try {
    /* Piper's normal pace (length_scale 1.0) runs digits together enough
     * to blur on a first listen — confirmed by ear. 1.25 is a modest
     * slowdown (not the more aggressive rate alarm speech might want),
     * tuned for "write this IP down as you hear it" rather than routine
     * alarm announcements, which stay at normal speed. */
    const IP_LENGTH_SCALE = 1.25;
    const ok = await bt.announce(text, mac, IP_LENGTH_SCALE);
    if (!ok) console.error('[ALARM] announceIpAddress: playback failed (no audio reached the device)');
  } catch (e) {
    console.error('[ALARM] announceIpAddress error:', e.message);
  }
}

/** What gets spoken for a rule: an explicit rule.voice override if set,
 *  else the display label. Kept separate from rule.label because the
 *  label is meant to be readable in the Rules table ("1-Wire slot 0 —
 *  Coolant/Engine Temperature") while the spoken announcement should be
 *  just the source ("coolant engine temperature") — see
 *  syncDefaultRulesFromConfig()'s voiceLabelFor() for how the default is
 *  generated. */
function voiceTextFor(rule) {
  return (rule.voice && rule.voice.trim()) || rule.label;
}

function driveHardwareOn(rule) {
  const output = g_alarms.hardware.output;
  const pattern = ALARM_TYPE_PATTERN[rule.alarm_type] || ALARM_TYPE_PATTERN.warning;

  if (output === 'bt_speaker') {
    const btMac = g_alarms.hardware.bt_speaker && g_alarms.hardware.bt_speaker.mac;
    bt.playAlert(voiceTextFor(rule), btMac, rule.alarm_type)
      .then(ok => { if (!ok) console.error('[ALARM] bt playAlert: playback failed (no audio reached the device)'); })
      .catch(e => console.error('[ALARM] bt playAlert error:', e.message));
    return;
  }

  localBusSend({ type: 'buzzer', pattern, volume: 0 });
  if (output === 'buzzer_led_button') {
    localBusSend({ type: 'led', state: 1 });
  }
}

function driveHardwareOff() {
  const output = g_alarms.hardware.output;
  if (output === 'bt_speaker') return;   /* nothing sustained to stop */
  localBusSend({ type: 'stop' });
}

function publishSkNotification(rule, state) {
  if (!rule.publish_to_signalk) return;
  sendSkDelta({
    context: 'vessels.self',
    updates: [{
      source: { label: 'alarm-server', type: 'alarm' },
      timestamp: new Date().toISOString(),
      values: [{
        path: `notifications.alarms.${rule.id}`,
        value: {
          state: state === 'active' ? 'alarm' : 'normal',
          method: ['sound', 'visual'],
          message: rule.label,
        },
      }],
    }],
  });
}

function notifyWebClients(type, rule) {
  broadcastToWebClients({ type, rule: { id: rule.id, label: rule.label, alarm_type: rule.alarm_type } });
}

/* ------------------------------------------------------------------ */
/* Remote notification (off-boat) — ntfy.sh push                        */
/* ------------------------------------------------------------------ */

/* Every other alarm channel in this file is local: buzzer, LED, BT
 * speaker, Signal K, web popup. All of them keep working with no
 * internet, which is a deliberate design property of this project (see
 * PIPER-NOTES.md — "this is a boat alarm system, not a cloud-TTS
 * candidate"), not an accident. This channel is the exception: it is the
 * only one that needs the outside world, so it is built to be the only
 * one that can fail without anyone noticing.
 *
 * Fire-and-forget, hard: short timeout, every error swallowed, nothing
 * awaited by the caller, and no throw path back into triggerAlarm(). A
 * dead uplink, a DNS timeout, or a 500 from ntfy.sh must be completely
 * invisible to the buzzer.
 *
 * ntfy.sh needs no signup and no API key: POST the message body to
 * https://ntfy.sh/<topic>, subscribe to the same topic in the phone app.
 * The flip side is that the topic string IS the credential — anyone who
 * guesses it can read the alarms (and send fake ones), so the UI pushes
 * for a long random topic name.
 */

const REMOTE_NOTIFY_TIMEOUT_MS = 5000;

/** Build the {title, message, priority, tags} for a rule/state pair, in
 *  one place, so any future channel (email/SMTP, per the intent to add it
 *  later) renders the same content rather than inventing its own. */
function remoteNotifyPayload(rule, state) {
  const active = state === 'active';
  return {
    title: active ? `ALARM: ${rule.label}` : `Cleared: ${rule.label}`,
    message: active
      ? `${rule.label} went out of range on ${os.hostname()}.`
      : `${rule.label} is back to normal on ${os.hostname()}.`,
    /* ntfy priorities: 1 min .. 5 max. A "bell"/"alarm" rule should
     * bypass a phone's quiet hours; a routine clear should not. */
    priority: active ? (rule.alarm_type === 'alarm' || rule.alarm_type === 'bell' ? '5' : '4') : '3',
    tags: active ? 'warning' : 'white_check_mark',
  };
}

/** POST to ntfy. Resolves {ok, error} — never rejects. */
function sendNtfy(cfg, payload) {
  return new Promise((resolve) => {
    let target;
    try {
      const base = (cfg.ntfyServer || 'https://ntfy.sh').replace(/\/+$/, '');
      target = new URL(`${base}/${encodeURIComponent(cfg.topic)}`);
    } catch (e) {
      resolve({ ok: false, error: `bad ntfy server URL: ${e.message}` });
      return;
    }

    /* Node's built-in http/https — no HTTP client library. This project
     * has zero of them today and one POST does not justify the first. */
    const mod = target.protocol === 'http:' ? http : https;
    const body = Buffer.from(payload.message, 'utf8');
    const req = mod.request(target, {
      method: 'POST',
      timeout: REMOTE_NOTIFY_TIMEOUT_MS,
      headers: {
        /* ntfy reads its metadata from headers. They must be
         * header-safe: a rule label with a newline in it would otherwise
         * be a header-injection, and a non-ASCII label makes some HTTP
         * stacks throw on write. */
        'Title': headerSafe(payload.title),
        'Priority': payload.priority,
        'Tags': payload.tags,
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
      },
    }, (res) => {
      res.resume();   /* drain, or the socket lingers */
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      resolve({ ok, error: ok ? null : `ntfy returned HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timed out' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.end(body);
  });
}

function headerSafe(s) {
  return String(s).replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
}

/**
 * The single fan-out seam for off-boat notifications, called from
 * triggerAlarm()/clearAlarm() next to publishSkNotification(). Adding
 * email/SMTP later is a new branch on `channel` plus a sender function —
 * not a rewrite, and not another call site to remember.
 *
 * @param {object} rule
 * @param {'active'|'normal'} state
 */
function notifyRemote(rule, state) {
  const cfg = g_alarms.remoteNotify || {};
  if (!cfg.enabled) return;
  if (!rule.notify_remote) return;   /* per-rule opt-in, mirrors rule.publish_to_signalk */
  sendRemoteNotification(cfg, remoteNotifyPayload(rule, state))
    .then(r => {
      if (!r.ok) console.warn('[ALARM] remote notify failed (local alarms unaffected):', r.error);
    })
    .catch(e => console.warn('[ALARM] remote notify error (local alarms unaffected):', e.message));
}

function sendRemoteNotification(cfg, payload) {
  switch (cfg.channel || 'ntfy') {
    case 'ntfy':
      if (!cfg.topic) return Promise.resolve({ ok: false, error: 'no ntfy topic configured' });
      return sendNtfy(cfg, payload);
    default:
      return Promise.resolve({ ok: false, error: `unknown remote channel "${cfg.channel}"` });
  }
}

function triggerAlarm(rule) {
  const entry = { since: Date.now(), lastRepeat: Date.now(), acked: false };
  activeAlarms.set(rule.id, entry);
  driveHardwareOn(rule);
  publishSkNotification(rule, 'active');
  notifyRemote(rule, 'active');
  notifyWebClients('alarm_triggered', rule);
  console.log(`[ALARM] triggered: ${rule.label} (${rule.id})`);
}

function clearAlarm(rule) {
  activeAlarms.delete(rule.id);
  driveHardwareOff();
  publishSkNotification(rule, 'normal');
  notifyRemote(rule, 'normal');
  notifyWebClients('alarm_cleared', rule);
  console.log(`[ALARM] cleared: ${rule.label} (${rule.id})`);
}

function cancelAll() {
  for (const [ruleId, entry] of activeAlarms) {
    entry.acked = true;
  }
  driveHardwareOff();
  console.log('[ALARM] all active alarms cancelled');
  broadcastToWebClients({ type: 'all_cancelled' });
}

function cancelOne(ruleId) {
  const entry = activeAlarms.get(ruleId);
  if (!entry) return false;
  entry.acked = true;
  driveHardwareOff();
  const rule = findRule(ruleId);
  if (rule) notifyWebClients('alarm_cancelled', rule);
  return true;
}

function evaluateRules(evt) {
  for (const rule of g_alarms.rules) {
    if (!rule.enabled) continue;

    let result = null;
    if (rule.kind === 'range') result = matchRangeRule(rule, evt);
    else if (rule.kind === 'alert_pgn') result = matchAlertRule(rule, evt);
    else if (rule.kind === 'bilge') result = matchBilgeRule(rule, evt);
    if (!result) continue;

    const active = activeAlarms.get(rule.id);

    if (result.outOfRange) {
      if (!active) {
        triggerAlarm(rule);
        continue;
      }
      if (active.acked) continue;   /* silenced until it clears and re-triggers */

      const now = Date.now();
      switch (rule.repeat_mode) {
        case 'repeat_n':
          if (now - active.lastRepeat >= (rule.repeat_seconds || 30) * 1000) {
            driveHardwareOn(rule);
            active.lastRepeat = now;
          }
          break;
        case 'once':
          break; /* already fired, no re-trigger while still out of range */
        case 'continuous':
        default:
          break; /* self-sustaining pattern already running on the MCU */
      }
    } else if (active) {
      clearAlarm(rule);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Signal K publish (same login/connect/send pattern as bridge.js)      */
/* ------------------------------------------------------------------ */

let skWs = null;
let skPending = [];

function skLogin() {
  return new Promise((resolve) => {
    if (!SK_USER || !SK_PASS) { resolve(null); return; }
    const body = JSON.stringify({ username: SK_USER, password: SK_PASS });
    const req = http.request({
      hostname: SK_HOST, port: SK_PORT,
      path: '/signalk/v1/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j.token || null);
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.write(body);
    req.end();
  });
}

async function connectSK() {
  const token = await skLogin();
  const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
  const url = `ws://${SK_HOST}:${SK_PORT}/signalk/v1/stream?subscribe=none${tokenParam}`;
  skWs = new WebSocket(url);
  skWs.on('open', () => {
    console.log('[ALARM] Connected to Signal K');
    skPending.forEach(m => skWs.send(m));
    skPending = [];
  });
  skWs.on('error', (e) => console.warn('[ALARM] SK WS error:', e.message));
  skWs.on('close', () => setTimeout(connectSK, 5000));
}

function sendSkDelta(delta) {
  const msg = JSON.stringify(delta);
  if (skWs && skWs.readyState === WebSocket.OPEN) skWs.send(msg);
  else skPending.push(msg);
}

/* ------------------------------------------------------------------ */
/* config.json default-rule sync                                       */
/* ------------------------------------------------------------------ */

function slotRuleId(kind, idx) { return `default_${kind}_${idx}`; }

function syncDefaultRulesFromConfig() {
  let cfg;
  try {
    if (!fs.existsSync(SENSOR_CONFIG_FILE)) return;
    cfg = JSON.parse(fs.readFileSync(SENSOR_CONFIG_FILE, 'utf8'));
  } catch (e) {
    console.error('[ALARM] config.json read error:', e.message);
    return;
  }

  /* The real canboatjs field id per PGN choice — verified against
   * getPGNWithNumber() output on-device. NOT simply 'temperature' for
   * every PGN: 130312 uses 'actualTemperature', 127493 only has
   * 'oilTemperature', and 127489 has both ('temperature' = coolant,
   * 'oilTemperature' = oil) selected by source per sensor_config.h
   * (0=Oil Temperature, 1=Coolant/Engine Temperature). */
  const pgnFieldFor = (pgnId, source) => {
    switch (pgnId) {
      case PGNCFG.TEMP:       return 'actualTemperature';   /* PGN 130312 */
      case PGNCFG.TEMP_EXT:   return 'temperature';          /* PGN 130316 */
      case PGNCFG.ENV_PARAMS: return 'temperature';          /* PGN 130311 */
      case PGNCFG.ENGINE_DYN: return source === 0 ? 'oilTemperature' : 'temperature'; /* PGN 127489 */
      case PGNCFG.TRANS_DYN:  return 'oilTemperature';       /* PGN 127493 */
      default: return null;
    }
  };

  /* Human name for the source-field selector, for the rule label — "1-Wire
   * slot 0" alone isn't meaningful once there's more than one enabled
   * slot; "1-Wire slot 0 — Inside Temperature" is. ENGINE_DYN/TRANS_DYN
   * repurpose the source byte as a field selector (see sensor_config.h),
   * not the N2K TEMPERATURE_SOURCE enum, so those are named directly. */
  const sourceLabelFor = (pgnId, source) => {
    if (pgnId === PGNCFG.ENGINE_DYN) return source === 0 ? 'Oil Temperature' : 'Coolant/Engine Temperature';
    if (pgnId === PGNCFG.TRANS_DYN) return 'Oil Temperature';
    return temperatureSourceNames[source] || `Source ${source}`;
  };

  /* Spoken form of the same source name — lowercase, "/" flattened to a
   * space ("Coolant/Engine Temperature" -> "coolant engine temperature").
   * The rule.label (above) stays slot-prefixed for the Rules table, since
   * "1-Wire slot 0" is genuinely useful context there — but announced out
   * loud it's just noise; only the source matters. */
  const sourceVoiceFor = (pgnId, source) =>
    sourceLabelFor(pgnId, source).toLowerCase().replace(/\//g, ' ').replace(/\s+/g, ' ').trim();

  const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const spokenInstance = (n) => (NUMBER_WORDS[n] !== undefined ? NUMBER_WORDS[n] : String(n));

  let changed = false;
  const upsert = (id, label, voice, pgnId, instance, source, alarm) => {
    if (!alarm || !alarm.enabled) return;
    const existing = findRule(id);
    /* One-directional, non-destructive: skip if the user edited this rule
     * directly in the alarm webapp (default flipped to false). */
    if (existing && existing.default === false) return;

    const pgn = pgnId === PGNCFG.TEMP ? 130312
      : pgnId === PGNCFG.TEMP_EXT ? 130316
      : pgnId === PGNCFG.ENV_PARAMS ? 130311
      : pgnId === PGNCFG.ENGINE_DYN ? 127489
      : pgnId === PGNCFG.TRANS_DYN ? 127493
      : null;
    if (pgn == null) return;
    const field = pgnFieldFor(pgnId, source);
    if (field == null) return;

    const rule = existing || {
      id, kind: 'range', default: true, enabled: true, ignore: false,
      alarm_type: 'warning', repeat_mode: 'repeat_n', repeat_seconds: 30,
      publish_to_signalk: false, notify_remote: false,
    };
    rule.label = label;
    rule.voice = voice;
    rule.pgn = pgn;
    rule.field = field;
    rule.instance = instance;
    rule.min = alarm.min_c != null ? alarm.min_c + 273.15 : null;   /* N2K temps are Kelvin */
    rule.max = alarm.max_c != null ? alarm.max_c + 273.15 : null;

    if (!existing) { g_alarms.rules.push(rule); }
    changed = true;
  };

  /* Collect all slots up front (not upsert-as-we-go) so duplicate source
   * names can be detected across the whole set before generating any
   * voice text — "coolant engine temperature" is fine alone, but needs
   * "...zero" / "...one" appended once a second slot uses the same
   * source, per the requested "if more than 1 instance exists" rule. */
  const slotDescriptors = [];
  if (cfg.onewire && Array.isArray(cfg.onewire.slots)) {
    cfg.onewire.slots.forEach((slot, i) => {
      slotDescriptors.push({
        id: slotRuleId('ow', i), kindLabel: `1-Wire slot ${i}`,
        pgnId: slot.pgn_id, instance: slot.instance, source: slot.source, alarm: slot.alarm,
      });
    });
  }
  if (cfg.adc) {
    slotDescriptors.push({
      id: slotRuleId('adc', 0), kindLabel: 'ADC sensor',
      pgnId: cfg.adc.pgn_id, instance: cfg.adc.instance, source: cfg.adc.source, alarm: cfg.adc.alarm,
    });
  }

  const voiceCounts = {};
  slotDescriptors
    .filter(d => d.alarm && d.alarm.enabled)
    .forEach(d => {
      const voice = sourceVoiceFor(d.pgnId, d.source);
      voiceCounts[voice] = (voiceCounts[voice] || 0) + 1;
    });

  slotDescriptors.forEach(d => {
    const label = `${d.kindLabel} — ${sourceLabelFor(d.pgnId, d.source)}`;
    const voiceBase = sourceVoiceFor(d.pgnId, d.source);
    const voice = voiceCounts[voiceBase] > 1 ? `${voiceBase} ${spokenInstance(d.instance)}` : voiceBase;
    upsert(d.id, label, voice, d.pgnId, d.instance, d.source, d.alarm);
  });

  if (changed) saveAlarms();
}

function watchSensorConfig() {
  if (!fs.existsSync(SENSOR_CONFIG_FILE)) return;
  let reloadTimer = null;
  fs.watch(SENSOR_CONFIG_FILE, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(syncDefaultRulesFromConfig, 200);
  });
}

/* ------------------------------------------------------------------ */
/* Webapp WS (separate from the internal 127.0.0.1:3010 bus)           */
/* ------------------------------------------------------------------ */

const webClients = new Set();

function broadcastToWebClients(obj) {
  const line = JSON.stringify(obj);
  for (const sock of webClients) {
    if (sock.readyState === WebSocket.OPEN) sock.send(line);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP API + webapp                                                    */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/alarms') {
    json(res, 200, {
      hardware: g_alarms.hardware,
      remoteNotify: g_alarms.remoteNotify,
      rules: g_alarms.rules,
      active: Array.from(activeAlarms.entries()).map(([id, e]) => ({ id, ...e })),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/alarms') {
    const body = JSON.parse(await readBody(req));
    body.id = body.id || crypto.randomUUID();
    body.default = false;   /* rules created/edited via the webapp are never "default" */
    const idx = g_alarms.rules.findIndex(r => r.id === body.id);
    if (idx >= 0) g_alarms.rules[idx] = body; else g_alarms.rules.push(body);
    saveAlarms();

    /* Editing a rule that's currently active-but-cancelled used to stay
     * silent indefinitely — cancelOne() sets acked on the activeAlarms
     * entry, keyed by rule id, completely separate from the rule object
     * itself, so replacing the rule here never touched it. Un-ack it so
     * the very next matching PGN re-asserts with whatever just changed
     * (new threshold, new alarm_type, etc.) instead of staying quiet
     * until the value happens to drop back in range and re-trigger. */
    const active = activeAlarms.get(body.id);
    if (active) {
      active.acked = false;
      active.lastRepeat = 0;
    }

    json(res, 200, { ok: true, id: body.id });
    return true;
  }

  const ruleMatch = url.pathname.match(/^\/api\/alarms\/([^/]+)$/);
  if (req.method === 'DELETE' && ruleMatch) {
    g_alarms.rules = g_alarms.rules.filter(r => r.id !== ruleMatch[1]);
    activeAlarms.delete(ruleMatch[1]);
    saveAlarms();
    json(res, 200, { ok: true });
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/api\/alarms\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const ok = cancelOne(cancelMatch[1]);
    json(res, ok ? 200 : 404, { ok });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/pgn-catalog') {
    json(res, 200, { pgns: pgnCatalog, alertTypes: alertTypeValues, alertCategories: alertCategoryValues });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/alert-catalog') {
    /* Real (alertSystem, alertSubSystem, alertId) values as actually seen
     * on the bus, built up by bridge.js from PGN 126983/126985 — see its
     * own comment for why (no public lookup table for these exists).
     * Read fresh from disk on each request rather than duplicating
     * bridge.js's in-memory state here — this is checked occasionally,
     * not on any hot path, so simplicity wins over plumbing a live feed
     * through the local bus for it. */
    let catalog = {};
    try {
      catalog = JSON.parse(fs.readFileSync('/etc/sensor_n2k/alert-catalog.json', 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error('[ALARM] failed to read alert-catalog.json:', e.message);
    }
    json(res, 200, { alerts: Object.values(catalog) });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/devices') {
    json(res, 200, { devices: await fetchBusDevices() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/hardware') {
    json(res, 200, g_alarms.hardware);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/hardware') {
    const body = JSON.parse(await readBody(req));
    g_alarms.hardware = { ...g_alarms.hardware, ...body };
    saveAlarms();
    syncBtReconnectMonitor();
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/remote-notify') {
    json(res, 200, g_alarms.remoteNotify);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/remote-notify') {
    const body = JSON.parse(await readBody(req));
    g_alarms.remoteNotify = { ...g_alarms.remoteNotify, ...body };
    saveAlarms();
    json(res, 200, { ok: true });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/remote-notify/test') {
    /* Mirrors /api/bt/test above: exercise the real send path (not a
     * mocked one) and report the actual failure text, since "nothing
     * arrived on my phone" has half a dozen causes and only the server
     * can distinguish "no internet" from "wrong topic". Uses the config
     * as POSTed if supplied, so the button can be pressed before Save. */
    let override = {};
    try { override = JSON.parse(await readBody(req) || '{}'); } catch (e) { /* no body is fine */ }
    const cfg = { ...g_alarms.remoteNotify, ...override };
    if (!cfg.topic) {
      json(res, 400, { ok: false, error: 'Set a topic first.' });
      return true;
    }
    const r = await sendRemoteNotification(cfg, {
      title: `sensor_n2k test — ${os.hostname()}`,
      message: 'This is a test notification from your sensor_n2k alarm system. ' +
        'If you can read this on your phone, remote alarms will reach you.',
      priority: '3',
      tags: 'white_check_mark',
    });
    json(res, r.ok ? 200 : 502, { ok: r.ok, error: r.ok ? undefined : r.error });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/bt/known') {
    const devices = await bt.listKnownDevices();
    json(res, 200, { devices });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/bt/scan') {
    const seconds = parseInt(url.searchParams.get('seconds') || '8', 10);
    const devices = await bt.scanDevices(seconds * 1000);
    json(res, 200, { devices });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/bt/pair') {
    const body = JSON.parse(await readBody(req));
    const prevMac = g_alarms.hardware.bt_speaker && g_alarms.hardware.bt_speaker.mac;

    if (prevMac && prevMac !== body.mac) {
      /* Switching speakers: stop the background reconnect monitor for the
       * old device first — otherwise it can re-issue `connect <prevMac>`
       * every 30s while we're mid-connect to the new one, both contending
       * for the same Bluetooth radio (see monitorAndReconnect()). Then
       * explicitly disconnect the old device — pairAndConnect() never did
       * this on its own, so the previously-connected speaker just stayed
       * connected underneath, and BlueZ was left juggling two devices. */
      if (btReconnectHandle) { btReconnectHandle.stop(); btReconnectHandle = null; }
      await bt.disconnect(prevMac);
    }

    const result = await bt.pairAndConnect(body.mac);
    console.log(`[BT] pair ${body.mac} (${body.name || '?'}) -> connected=${result.connected} paired=${result.paired} trusted=${result.trusted}`);
    if (result.connected) {
      g_alarms.hardware.bt_speaker = { mac: body.mac, name: body.name || '' };
      saveAlarms();
    } else if (prevMac && prevMac !== body.mac) {
      /* Already disconnected the old device to make room for this one —
       * don't leave hardware.bt_speaker silently pointing at a speaker we
       * just told to disconnect when the new one failed to come up. */
      console.log(`[BT] connect to ${body.mac} failed after disconnecting previous device ${prevMac} — clearing configured speaker`);
      g_alarms.hardware.bt_speaker = null;
      saveAlarms();
    }
    syncBtReconnectMonitor();
    json(res, 200, result);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/bt/disconnect') {
    const mac = g_alarms.hardware.bt_speaker && g_alarms.hardware.bt_speaker.mac;
    console.log(`[BT] disconnect requested for ${mac || '(none configured)'}`);
    if (btReconnectHandle) { btReconnectHandle.stop(); btReconnectHandle = null; }
    const result = mac ? await bt.disconnect(mac) : { disconnected: true };
    g_alarms.hardware.bt_speaker = null;
    saveAlarms();
    json(res, 200, result);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/bt/status') {
    const paired = g_alarms.hardware.bt_speaker;
    const mac = paired && paired.mac;
    if (!mac) { json(res, 200, { connected: false }); return true; }
    const status = await bt.getStatus(mac);
    json(res, 200, { ...status, name: paired.name || null });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/bt/test') {
    const testMac = g_alarms.hardware.bt_speaker && g_alarms.hardware.bt_speaker.mac;
    const ok = await bt.playAlert('This is a test alert from sensor n2k', testMac);
    json(res, ok ? 200 : 500, { ok,
      error: ok ? undefined : 'Playback failed — no audio reached the device. ' +
        'Bluetooth may be connected at the pairing level but PipeWire has no audio ' +
        'sink for it (check `wpctl status` for a Bluetooth sink after pairing).' });
    return true;
  }

  return false;
}

const WEBAPP_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sensor_n2k Alarms</title>
${SHARED_STYLE}
</head>
<body>
${navHtml('alarms')}
<div id="popup"><span id="popup-msg"></span><button onclick="cancelAlarm(currentAlarmId)">Cancel</button></div>
<div class="wrap">
<h1>Alarms</h1>
<div class="tabs">
<button class="active" onclick="showTab('rules')">Rules</button>
<button onclick="showTab('hardware')">Hardware</button>
<button onclick="showTab('active')">Active Alarms</button>
</div>

<div id="tab-rules" class="tab active">
<div class="card">
<h2 style="margin-top:0">Rules</h2>
<table id="rules-table"><thead><tr><th>Label</th><th>Kind</th><th>Enabled</th><th>Type</th><th>Repeat</th><th>SK</th><th>Push</th><th></th></tr></thead><tbody></tbody></table>
<button onclick="showAddForm()">+ Add Rule</button>
<fieldset id="add-form" style="display:none">
<legend>Rule</legend>
<input type="hidden" id="f-id">
<label>Label <input id="f-label"></label><br>
<label>Kind
<select id="f-kind" onchange="toggleKindFields()">
<option value="range">Range (sensor value)</option>
<option value="alert_pgn">Alert PGN (126983)</option>
<option value="bilge">Bilge Pump</option>
</select></label><br>
<div id="range-fields">
<label>PGN
<select id="f-pgn" onchange="onPgnChange()"></select>
</label>
<label>Field <select id="f-field" onchange="onFieldChange()"></select></label>
<label>Instance <input id="f-instance" type="number"></label><br>
<label>Threshold
<select id="f-threshold-mode" onchange="onThresholdModeChange()">
<option value="max">Max (alarm if value goes above)</option>
<option value="min">Min (alarm if value goes below)</option>
<option value="both">Both (rare)</option>
</select>
</label>
<label id="f-min-label">Min <span id="f-min-unit"></span><input id="f-min" type="number" step="any"></label>
<label id="f-max-label">Max <span id="f-max-unit"></span><input id="f-max" type="number" step="any"></label>
</div>
<div id="alert-fields" style="display:none">
<label>Alert Type <select id="f-alertType"></select></label>
<label>Category <select id="f-alertCategory"></select></label>
<label>System <input id="f-alertSystem" type="number"></label>
<label>Sub-System <input id="f-alertSubSystem" type="number"></label>
<label>Alert ID <input id="f-alertId" type="number"></label><br>
<label>Source
<select id="f-alert-src"><option value="">Any source</option></select>
</label>
<label><input type="checkbox" id="f-ignore"> Ignore matching alerts from this source</label>
</div>
<div id="bilge-fields" style="display:none">
<label>Channel
<select id="f-bilge-channel">
<option value="0">Bilge Pump 1</option>
<option value="1">Bilge Pump 2</option>
<option value="2">Bilge Pump 3</option>
<option value="3">Bilge Pump 4</option>
</select>
</label>
<label>Metric
<select id="f-bilge-metric" onchange="onBilgeMetricChange()">
<option value="count">Cycle count</option>
<option value="runtime">Time running</option>
</select>
</label>
<label>Period
<select id="f-bilge-period">
<option value="1h">Last 1 hour</option>
<option value="24h">Last 24 hours</option>
<option value="7d">Last 7 days (current week)</option>
</select>
</label>
<label id="f-bilge-threshold-label">Threshold (cycles) <input id="f-bilge-threshold" type="number" step="any"></label>
</div>
<br>
<label>Alarm Type
<select id="f-alarm_type">
<option value="buzzer">Buzzer (85-95 dB)</option>
<option value="warning">Warning (95-105 dB)</option>
<option value="alarm">Alarm (105-115+ dB)</option>
<option value="bell">Bell (marine bell, most urgent)</option>
</select>
</label>
<label>Voice announcement <input id="f-voice" placeholder="(defaults to Label)"></label>
<label>Repeat
<select id="f-repeat_mode" onchange="toggleRepeatSeconds()">
<option value="continuous">Continuous</option><option value="repeat_n">Every N seconds</option><option value="once">Once</option>
</select>
</label>
<label id="repeat-seconds-label">Seconds <input id="f-repeat_seconds" type="number" value="30"></label><br>
<label><input type="checkbox" id="f-publish_to_signalk"> Publish to Signal K notifications</label><br>
<label><input type="checkbox" id="f-notify_remote"> Send a phone notification (configure under Hardware → Remote notifications)</label><br>
<label><input type="checkbox" id="f-enabled" checked> Enabled</label><br>
<button class="primary" onclick="saveRule()">Save</button> <button onclick="hideAddForm()">Cancel</button>
</fieldset>
</div>
</div>

<div id="tab-hardware" class="tab">
<div class="card">
<h2 style="margin-top:0">Hardware</h2>
<label>Output
<select id="hw-output" onchange="onHwOutputSelect()">
<option value="buzzer_simple">Buzzer (simple)</option>
<option value="buzzer_led_button">Buzzer + LED + Button</option>
<option value="bt_speaker">Bluetooth Speaker</option>
</select>
</label>
<button class="primary" onclick="saveHardware()">Save</button>
<div id="bt-panel" style="display:none">
<h3>Bluetooth Speaker</h3>
<p>Status: <span id="bt-status" class="pill neutral">unknown</span> <button id="bt-disconnect-btn" onclick="btDisconnect()">Disconnect</button></p>
<p class="sub" style="margin:0.8em 0 0.2em">Already paired</p>
<ul id="bt-known" style="max-height:200px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);padding:0.4em 0.8em;margin:0.2em 0"><li>Loading…</li></ul>
<p class="sub" style="margin:1em 0 0.2em">New device — hold its pairing button until the light flashes, then scan</p>
<button id="bt-scan-btn" onclick="btScan()">Scan</button>
<ul id="bt-devices" style="max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:var(--radius);padding:0.4em 0.8em;margin:0.5em 0"></ul>
<button onclick="btTest()">Play Test Tone + Announcement</button>
<span id="bt-test-msg" style="margin-left:1em;color:var(--danger)"></span>
</div>
</div>

<div class="card">
<h2 style="margin-top:0">Remote notifications</h2>
<p class="sub">Push alarms to a phone when you are off the boat, via <a href="https://ntfy.sh" target="_blank" rel="noopener">ntfy.sh</a>
(free, no account needed — install the ntfy app and subscribe to the same topic).
Tick <b>Send a phone notification</b> on each rule that should reach you.</p>
<label><input type="checkbox" id="rn-enabled" onchange="rnDirty=true"> Enabled</label><br>
<label>Server <input id="rn-server" style="width:16em" oninput="rnDirty=true"></label>
<label>Topic <input id="rn-topic" style="width:22em" oninput="rnDirty=true" placeholder="e.g. svgeorgia-n2k-7f3a91c2"></label>
<button onclick="rnRandomTopic()">Generate</button>
<br>
<button class="primary" onclick="rnSave()">Save</button>
<button onclick="rnTest()">Send test notification</button>
<span id="rn-msg" style="margin-left:1em"></span>
<p class="sub" style="margin-top:0.8em"><b>Use a long, random topic name.</b> On the public ntfy.sh server the
topic string is the only thing protecting your alarms — anyone who guesses it can read them, and send fake
ones. Do not use the boat's name on its own.</p>
<p class="sub">This channel needs internet. Every local channel — buzzer, LED, Bluetooth speaker, the popup on
these pages — keeps working exactly as it does now when there is none; a push that cannot be delivered simply
fails silently.</p>
</div>
</div>

<div id="tab-active" class="tab">
<div class="card">
<h2 style="margin-top:0">Active Alarms</h2>
<table id="active-table"><thead><tr><th>Label</th><th>Since</th><th>Acked</th><th></th></tr></thead><tbody></tbody></table>
</div>
</div>
</div>

<script>
let currentAlarmId = null;
let allRules = [];
let pgnCatalog = [];
let alertTypes = {};
let alertCategories = {};
let busDevices = [];
let hwDirty = false;
let btKnownLoaded = false;
/* Same purpose as hwDirty, for the Remote notifications card — the 5s
 * refresh() would otherwise wipe a half-typed ntfy topic. */
let rnDirty = false;

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  event.target.classList.add('active');
}

function toggleKindFields() {
  const kind = document.getElementById('f-kind').value;
  document.getElementById('range-fields').style.display = kind === 'range' ? '' : 'none';
  document.getElementById('alert-fields').style.display = kind === 'alert_pgn' ? '' : 'none';
  document.getElementById('bilge-fields').style.display = kind === 'bilge' ? '' : 'none';
}
function onBilgeMetricChange() {
  const isCount = document.getElementById('f-bilge-metric').value === 'count';
  document.getElementById('f-bilge-threshold-label').firstChild.textContent =
    isCount ? 'Threshold (cycles) ' : 'Threshold (minutes) ';
}
function toggleRepeatSeconds() {
  document.getElementById('repeat-seconds-label').style.display =
    document.getElementById('f-repeat_mode').value === 'repeat_n' ? '' : 'none';
}

function onThresholdModeChange() {
  const mode = document.getElementById('f-threshold-mode').value;
  document.getElementById('f-min-label').style.display = (mode === 'min' || mode === 'both') ? '' : 'none';
  document.getElementById('f-max-label').style.display = (mode === 'max' || mode === 'both') ? '' : 'none';
}

/** Raw N2K unit for a PGN's field (e.g. "K", "Pa", "%"), or null. Temps
 *  are always transmitted/compared in Kelvin — see fieldDisplayUnit(). */
function fieldRawUnit(pgn, fieldId) {
  const entry = pgnCatalog.find(p => p.pgn === pgn);
  const f = entry && entry.fields.find(x => x.id === fieldId);
  return f ? f.unit : null;
}

/** Unit the Min/Max inputs are shown/entered in. Kelvin is displayed and
 *  entered as °C (matching the Configuration page) and converted at the
 *  save/load boundary — see toStorageValue()/toDisplayValue(). Every
 *  other unit is shown as-is since the raw PGN value is what's compared. */
function fieldDisplayUnit(pgn, fieldId) {
  const raw = fieldRawUnit(pgn, fieldId);
  return raw === 'K' ? '°C' : raw;
}
function toStorageValue(v, pgn, fieldId) {
  return fieldRawUnit(pgn, fieldId) === 'K' ? v + 273.15 : v;
}
function toDisplayValue(v, pgn, fieldId) {
  return fieldRawUnit(pgn, fieldId) === 'K' ? v - 273.15 : v;
}
function round2(v) { return Math.round(v * 100) / 100; }

function refreshUnitLabels() {
  const pgn = parseInt(document.getElementById('f-pgn').value, 10);
  const field = document.getElementById('f-field').value;
  const unit = fieldDisplayUnit(pgn, field);
  const suffix = unit ? '(' + unit + ')' : '';
  document.getElementById('f-min-unit').textContent = suffix;
  document.getElementById('f-max-unit').textContent = suffix;
}

function onFieldChange() { refreshUnitLabels(); }

function onPgnChange() {
  const pgn = parseInt(document.getElementById('f-pgn').value, 10);
  const entry = pgnCatalog.find(p => p.pgn === pgn);
  const fsel = document.getElementById('f-field');
  fsel.innerHTML = '';
  (entry ? entry.fields : []).forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.name + (f.unit ? ' (' + f.unit + ')' : '');
    fsel.appendChild(opt);
  });
  refreshUnitLabels();
}

async function loadCatalog() {
  const r = await fetch('/api/pgn-catalog').then(r => r.json());
  pgnCatalog = r.pgns || [];
  alertTypes = r.alertTypes || {};
  alertCategories = r.alertCategories || {};

  const psel = document.getElementById('f-pgn');
  psel.innerHTML = '';
  pgnCatalog.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.pgn;
    opt.textContent = p.pgn + ' — ' + p.description + ' (' + p.id + ')';
    psel.appendChild(opt);
  });
  onPgnChange();

  const fill = (selectId, values) => {
    const sel = document.getElementById(selectId);
    sel.innerHTML = '';
    Object.entries(values).forEach(([name, val]) => {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = name + ' (' + val + ')';
      sel.appendChild(opt);
    });
  };
  fill('f-alertType', alertTypes);
  fill('f-alertCategory', alertCategories);
}

async function loadDevices() {
  const r = await fetch('/api/devices').then(r => r.json());
  busDevices = r.devices || [];
  const sel = document.getElementById('f-alert-src');
  sel.innerHTML = '<option value="">Any source</option>';
  busDevices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.src;
    opt.textContent = (d.name || ('Src ' + d.src)) + ' (0x' + d.src.toString(16) + ')';
    sel.appendChild(opt);
  });
}

function resetForm() {
  document.getElementById('f-id').value = '';
  document.getElementById('f-label').value = '';
  document.getElementById('f-voice').value = '';
  document.getElementById('f-kind').value = 'range';
  toggleKindFields();
  document.getElementById('f-instance').value = '';
  document.getElementById('f-threshold-mode').value = 'max';
  onThresholdModeChange();
  document.getElementById('f-min').value = '';
  document.getElementById('f-max').value = '';
  if (pgnCatalog.length) { document.getElementById('f-pgn').selectedIndex = 0; onPgnChange(); }
  document.getElementById('f-alertSystem').value = '';
  document.getElementById('f-alertSubSystem').value = '';
  document.getElementById('f-alertId').value = '';
  document.getElementById('f-alert-src').value = '';
  document.getElementById('f-ignore').checked = false;
  document.getElementById('f-bilge-channel').value = '0';
  document.getElementById('f-bilge-metric').value = 'count';
  onBilgeMetricChange();
  document.getElementById('f-bilge-period').value = '1h';
  document.getElementById('f-bilge-threshold').value = '';
  document.getElementById('f-alarm_type').value = 'warning';
  document.getElementById('f-repeat_mode').value = 'continuous';
  toggleRepeatSeconds();
  document.getElementById('f-repeat_seconds').value = 30;
  document.getElementById('f-publish_to_signalk').checked = false;
  document.getElementById('f-notify_remote').checked = false;
  document.getElementById('f-enabled').checked = true;
}

function showAddForm() { resetForm(); document.getElementById('add-form').style.display = ''; }
function hideAddForm() { document.getElementById('add-form').style.display = 'none'; }

function editRule(id) {
  const rule = allRules.find(r => r.id === id);
  if (!rule) return;
  showAddForm();
  document.getElementById('f-id').value = rule.id;
  document.getElementById('f-label').value = rule.label || '';
  document.getElementById('f-voice').value = rule.voice || '';
  document.getElementById('f-kind').value = rule.kind;
  toggleKindFields();
  document.getElementById('f-alarm_type').value = rule.alarm_type || 'warning';
  document.getElementById('f-repeat_mode').value = rule.repeat_mode || 'continuous';
  toggleRepeatSeconds();
  document.getElementById('f-repeat_seconds').value = rule.repeat_seconds || 30;
  document.getElementById('f-publish_to_signalk').checked = !!rule.publish_to_signalk;
  document.getElementById('f-notify_remote').checked = !!rule.notify_remote;
  document.getElementById('f-enabled').checked = !!rule.enabled;

  if (rule.kind === 'range') {
    document.getElementById('f-pgn').value = rule.pgn;
    onPgnChange();   /* rebuilds Field options, using the first one by default */
    document.getElementById('f-field').value = rule.field;
    refreshUnitLabels();   /* now that the real field is selected, not the default */
    document.getElementById('f-instance').value = rule.instance ?? '';
    const mode = (rule.min != null && rule.max != null) ? 'both' : (rule.min != null ? 'min' : 'max');
    document.getElementById('f-threshold-mode').value = mode;
    onThresholdModeChange();
    document.getElementById('f-min').value = rule.min != null ? round2(toDisplayValue(rule.min, rule.pgn, rule.field)) : '';
    document.getElementById('f-max').value = rule.max != null ? round2(toDisplayValue(rule.max, rule.pgn, rule.field)) : '';
  } else if (rule.kind === 'alert_pgn') {
    document.getElementById('f-alertType').value = rule.alertType ?? '';
    document.getElementById('f-alertCategory').value = rule.alertCategory ?? '';
    document.getElementById('f-alertSystem').value = rule.alertSystem ?? '';
    document.getElementById('f-alertSubSystem').value = rule.alertSubSystem ?? '';
    document.getElementById('f-alertId').value = rule.alertId ?? '';
    document.getElementById('f-alert-src').value = rule.src ?? '';
    document.getElementById('f-ignore').checked = !!rule.ignore;
  } else if (rule.kind === 'bilge') {
    document.getElementById('f-bilge-channel').value = rule.channel ?? 0;
    document.getElementById('f-bilge-metric').value = rule.metric || 'count';
    onBilgeMetricChange();
    document.getElementById('f-bilge-period').value = rule.period || '1h';
    /* Stored threshold is cycles (as-is) or seconds (runtime) — display
     * runtime in minutes, matching the input's own label/unit. */
    document.getElementById('f-bilge-threshold').value = rule.threshold == null ? ''
      : (rule.metric === 'runtime' ? round2(rule.threshold / 60) : rule.threshold);
  }
}

async function refresh() {
  const r = await fetch('/api/alarms').then(r => r.json());
  allRules = r.rules;
  const tbody = document.querySelector('#rules-table tbody');
  tbody.innerHTML = '';
  r.rules.forEach(rule => {
    const tr = document.createElement('tr');
    tr.innerHTML = \`<td>\${rule.label}</td><td>\${rule.kind}</td><td>\${rule.enabled ? '<span class="pill ok">yes</span>' : '<span class="pill neutral">no</span>'}</td>
      <td>\${rule.alarm_type}</td><td>\${rule.repeat_mode}</td><td>\${rule.publish_to_signalk ? 'yes' : 'no'}</td>
      <td>\${rule.notify_remote ? 'yes' : 'no'}</td>
      <td><button onclick="editRule('\${rule.id}')">Edit</button> <button onclick="deleteRule('\${rule.id}')">Delete</button></td>\`;
    tbody.appendChild(tr);
  });

  const activeBody = document.querySelector('#active-table tbody');
  activeBody.innerHTML = '';
  r.active.forEach(a => {
    const rule = r.rules.find(x => x.id === a.id);
    const tr = document.createElement('tr');
    tr.innerHTML = \`<td>\${rule ? rule.label : a.id}</td><td>\${new Date(a.since).toLocaleTimeString()}</td>
      <td>\${a.acked ? '<span class="pill neutral">yes</span>' : '<span class="pill danger">no</span>'}</td>
      <td><button class="danger" onclick="cancelAlarm('\${a.id}')" \${a.acked ? 'disabled' : ''}>Cancel</button></td>\`;
    activeBody.appendChild(tr);
  });

  /* Skip while the user has an unsaved dropdown change (e.g. just picked
   * "Bluetooth Speaker" to start a scan) — otherwise this 5s poll reverts
   * it to the last-saved value and hides the panel out from under them. */
  if (!hwDirty) {
    document.getElementById('hw-output').value = r.hardware.output;
    onHwOutputChange();
    /* Load the "already paired" list the first time we learn the saved
     * output is bt_speaker — NOT unconditionally, since refresh() itself
     * runs every 5s and this would otherwise re-query bluetoothctl (and
     * reset any in-progress "Connecting…" button) on every poll tick.
     * A manual switch to bt_speaker is handled separately, unconditionally,
     * by onHwOutputSelect(). */
    if (r.hardware.output === 'bt_speaker' && !btKnownLoaded) {
      btKnownLoaded = true;
      btLoadKnown();
    }
  }

  if (!rnDirty && r.remoteNotify) {
    document.getElementById('rn-enabled').checked = !!r.remoteNotify.enabled;
    document.getElementById('rn-server').value = r.remoteNotify.ntfyServer || 'https://ntfy.sh';
    document.getElementById('rn-topic').value = r.remoteNotify.topic || '';
  }
}

async function deleteRule(id) {
  await fetch('/api/alarms/' + id, { method: 'DELETE' });
  refresh();
}

async function saveRule() {
  const kind = document.getElementById('f-kind').value;
  const rule = {
    id: document.getElementById('f-id').value || undefined,
    label: document.getElementById('f-label').value,
    voice: document.getElementById('f-voice').value || undefined,
    kind,
    enabled: document.getElementById('f-enabled').checked,
    alarm_type: document.getElementById('f-alarm_type').value,
    repeat_mode: document.getElementById('f-repeat_mode').value,
    repeat_seconds: parseInt(document.getElementById('f-repeat_seconds').value || '30', 10),
    publish_to_signalk: document.getElementById('f-publish_to_signalk').checked,
    notify_remote: document.getElementById('f-notify_remote').checked,
  };
  if (kind === 'range') {
    const mode = document.getElementById('f-threshold-mode').value;
    rule.pgn = parseInt(document.getElementById('f-pgn').value, 10);
    rule.field = document.getElementById('f-field').value;
    rule.instance = document.getElementById('f-instance').value ? parseInt(document.getElementById('f-instance').value, 10) : null;
    /* Min/Max are entered in fieldDisplayUnit() (°C for Kelvin fields,
     * matching the Configuration page) — convert to the raw unit the
     * PGN actually carries (Kelvin) before storing, since that's what
     * gets compared against the decoded value. */
    rule.min = (mode === 'min' || mode === 'both') && document.getElementById('f-min').value !== ''
      ? toStorageValue(parseFloat(document.getElementById('f-min').value), rule.pgn, rule.field) : null;
    rule.max = (mode === 'max' || mode === 'both') && document.getElementById('f-max').value !== ''
      ? toStorageValue(parseFloat(document.getElementById('f-max').value), rule.pgn, rule.field) : null;
  } else if (kind === 'alert_pgn') {
    rule.alertType = parseInt(document.getElementById('f-alertType').value, 10);
    rule.alertCategory = parseInt(document.getElementById('f-alertCategory').value, 10);
    rule.alertSystem = parseInt(document.getElementById('f-alertSystem').value || '0', 10);
    rule.alertSubSystem = parseInt(document.getElementById('f-alertSubSystem').value || '0', 10);
    rule.alertId = parseInt(document.getElementById('f-alertId').value || '0', 10);
    rule.src = document.getElementById('f-alert-src').value !== ''
      ? parseInt(document.getElementById('f-alert-src').value, 10) : null;
    rule.ignore = document.getElementById('f-ignore').checked;
  } else if (kind === 'bilge') {
    rule.channel = parseInt(document.getElementById('f-bilge-channel').value, 10);
    rule.metric = document.getElementById('f-bilge-metric').value;
    rule.period = document.getElementById('f-bilge-period').value;
    const thresholdVal = document.getElementById('f-bilge-threshold').value;
    /* Runtime is entered in minutes (matches the input's label) but
     * stored in seconds, matching bilge.c's on_s_* fields. */
    rule.threshold = thresholdVal === '' ? null
      : (rule.metric === 'runtime' ? parseFloat(thresholdVal) * 60 : parseInt(thresholdVal, 10));
  }
  await fetch('/api/alarms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rule) });
  hideAddForm();
  refresh();
}

async function cancelAlarm(id) {
  await fetch('/api/alarms/' + id + '/cancel', { method: 'POST' });
  document.getElementById('popup').style.display = 'none';
  refresh();
}

function onHwOutputChange() {
  document.getElementById('bt-panel').style.display =
    document.getElementById('hw-output').value === 'bt_speaker' ? '' : 'none';
}
/* Bound to the dropdown itself — marks the selection unsaved so the
 * 5s periodic refresh() doesn't stomp it back to the last-saved value
 * (and hide the Bluetooth panel) before the user gets to use it. Also
 * where the "already paired" list gets (re-)loaded — NOT inside
 * onHwOutputChange(), which refresh() also calls every 5s regardless of
 * whether anything changed; a live bluetoothctl query on every poll tick
 * would be wasteful and would reset any in-progress "Connecting…" button. */
function onHwOutputSelect() {
  hwDirty = true;
  onHwOutputChange();
  if (document.getElementById('hw-output').value === 'bt_speaker') { btLoadKnown(); }
}
async function saveHardware() {
  await fetch('/api/hardware', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ output: document.getElementById('hw-output').value }) });
  hwDirty = false;
}
/* bluetoothctl reports a placeholder "name" (the MAC with ':' -> '-') for
 * devices it hasn't resolved a real advertised name for yet — e.g.
 * "4F-5E-B5-EA-81-01" for 4F:5E:B5:EA:81:01. Most scans turn up a wall of
 * these alongside the handful of devices with a real name; without
 * sorting, the actual speaker you're looking for can be buried among them. */
function hasRealBtName(d) {
  return d.name.replace(/-/g, ':').toUpperCase() !== d.mac.toUpperCase();
}

/* Shared by the "Already paired" list and the scan-results list — both
 * just need a name/mac and a button that pairs+connects via the same
 * endpoint (harmless/idempotent on an already-paired device: bluetoothctl
 * reports "AlreadyExists" for the pair step and moves straight on to
 * trust+connect). */
function btDeviceRow(d, btnLabel) {
  const li = document.createElement('li');
  li.textContent = \`\${d.name} (\${d.mac}) \`;
  const btn = document.createElement('button');
  btn.textContent = btnLabel;
  const msg = document.createElement('span');
  msg.style.marginLeft = '0.5em';
  msg.style.color = 'var(--danger)';
  btn.onclick = async () => {
    btn.disabled = true;
    btn.textContent = 'Connecting…';
    msg.textContent = '';
    try {
      const r = await fetch('/api/bt/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d) }).then(r => r.json());
      btn.textContent = r.connected ? 'Connected' : btnLabel;
      if (!r.connected) {
        msg.textContent = 'Failed to connect' + (r.paired ? ' (paired, but connect did not complete — try again)' : '');
      }
    } catch (e) {
      btn.textContent = btnLabel;
      msg.textContent = 'Error: ' + e.message;
    }
    btn.disabled = false;
    btStatus();
  };
  li.appendChild(btn);
  li.appendChild(msg);
  return li;
}

async function btLoadKnown() {
  const ul = document.getElementById('bt-known');
  const r = await fetch('/api/bt/known').then(r => r.json());
  ul.innerHTML = '';
  if (r.devices.length === 0) {
    ul.innerHTML = '<li>None yet — scan below to pair a new speaker.</li>';
    return;
  }
  r.devices.forEach(d => ul.appendChild(btDeviceRow(d, 'Connect')));
}

async function btScan() {
  const SCAN_SECONDS = 8;
  const btn = document.getElementById('bt-scan-btn');
  const ul = document.getElementById('bt-devices');
  btn.disabled = true;
  let remaining = SCAN_SECONDS;
  ul.innerHTML = \`<li>Scanning… (\${remaining}s)</li>\`;
  /* Purely cosmetic countdown — the fetch below carries the real timing —
   * but without it the button just sits there for 8+ seconds looking
   * frozen rather than working. */
  const tick = setInterval(() => {
    remaining -= 1;
    if (remaining > 0) { ul.innerHTML = \`<li>Scanning… (\${remaining}s)</li>\`; }
  }, 1000);

  let devices = [];
  try {
    const r = await fetch(\`/api/bt/scan?seconds=\${SCAN_SECONDS}\`).then(r => r.json());
    devices = [...r.devices].sort((a, b) => hasRealBtName(b) - hasRealBtName(a));
  } catch (e) {
    clearInterval(tick);
    btn.disabled = false;
    ul.innerHTML = '<li>Scan failed: ' + e.message + '</li>';
    return;
  }
  clearInterval(tick);
  btn.disabled = false;
  ul.innerHTML = '';
  if (devices.length === 0) {
    ul.innerHTML = '<li>No devices found. For a speaker, hold its pairing button until the light flashes and try again.</li>';
    return;
  }
  devices.forEach(d => ul.appendChild(btDeviceRow(d, 'Pair')));
}
async function btDisconnect() {
  const btn = document.getElementById('bt-disconnect-btn');
  btn.disabled = true;
  await fetch('/api/bt/disconnect', { method: 'POST' });
  btn.disabled = false;
  btStatus();
}
async function btStatus() {
  const r = await fetch('/api/bt/status').then(r => r.json());
  const label = r.connected ? 'connected' : 'not connected';
  document.getElementById('bt-status').textContent = r.name ? \`\${label} — \${r.name}\` : label;
}
/* A guessable topic on the public ntfy.sh server is the whole attack
 * surface for this feature, so make the safe option the easy one: one
 * click produces a topic nobody is going to guess. */
function rnRandomTopic() {
  const rnd = new Uint8Array(9);
  crypto.getRandomValues(rnd);
  const hex = Array.from(rnd).map(b => b.toString(16).padStart(2, '0')).join('');
  document.getElementById('rn-topic').value = 'sensor-n2k-' + hex;
  rnDirty = true;
}

function rnConfigFromForm() {
  return {
    enabled: document.getElementById('rn-enabled').checked,
    ntfyServer: document.getElementById('rn-server').value.trim() || 'https://ntfy.sh',
    topic: document.getElementById('rn-topic').value.trim(),
  };
}

async function rnSave() {
  const msgEl = document.getElementById('rn-msg');
  const r = await fetch('/api/remote-notify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rnConfigFromForm()),
  }).then(r => r.json());
  msgEl.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
  msgEl.textContent = r.ok ? 'Saved.' : 'Failed: ' + (r.error || 'unknown error');
  if (r.ok) rnDirty = false;
  setTimeout(() => { msgEl.textContent = ''; }, 6000);
}

async function rnTest() {
  const msgEl = document.getElementById('rn-msg');
  msgEl.style.color = 'var(--text-dim)';
  msgEl.textContent = 'Sending…';
  try {
    /* Send the form values, not the saved ones, so the button works
     * before pressing Save — the common case is "type a topic, test it,
     * then keep it". */
    const r = await fetch('/api/remote-notify/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rnConfigFromForm()),
    }).then(r => r.json());
    msgEl.style.color = r.ok ? 'var(--ok)' : 'var(--danger)';
    msgEl.textContent = r.ok
      ? 'Sent — it should arrive on any phone subscribed to that topic.'
      : 'Failed: ' + (r.error || 'unknown error');
  } catch (e) {
    msgEl.style.color = 'var(--danger)';
    msgEl.textContent = 'Failed: ' + e.message;
  }
}

async function btTest() {
  const msgEl = document.getElementById('bt-test-msg');
  msgEl.textContent = 'Playing…';
  try {
    const r = await fetch('/api/bt/test', { method: 'POST' }).then(r => r.json());
    msgEl.textContent = r.ok ? '' : 'Failed: ' + (r.error || 'unknown error');
  } catch (e) {
    msgEl.textContent = 'Failed: ' + e.message;
  }
}

const ws = new WebSocket('ws://' + location.hostname + ':3002');
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.type === 'alarm_triggered') {
    currentAlarmId = msg.rule.id;
    document.getElementById('popup-msg').textContent = 'ALARM: ' + msg.rule.label;
    document.getElementById('popup').style.display = 'block';
  } else if (msg.type === 'alarm_cleared' || msg.type === 'all_cancelled') {
    document.getElementById('popup').style.display = 'none';
  }
  refresh();
};

toggleKindFields();
toggleRepeatSeconds();
onThresholdModeChange();
loadCatalog();
loadDevices();
btStatus();
refresh();
setInterval(refresh, 5000);
setInterval(loadDevices, 30000);
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await handleApi(req, res, url);
      if (!handled) json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[ALARM] API error:', e.message);
      json(res, 500, { error: e.message });
    }
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

const wss = new WebSocket.Server({ server });
wss.on('connection', (sock) => {
  webClients.add(sock);
  sock.on('close', () => webClients.delete(sock));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[ALARM] Listening on http://0.0.0.0:${PORT}`);
});

connectLocalBus();
connectSK();
syncDefaultRulesFromConfig();
watchSensorConfig();

syncBtReconnectMonitor();

/* One-time boot announcement — a chime ("uno q n2k", at buzzer-tier
 * volume, the quietest of the four levels, appropriate for a routine
 * "I'm up" ping rather than an actual alarm) immediately followed by the
 * current network address, once a Bluetooth speaker is configured AND
 * actually reachable (findBluezSinkTarget() checks for a real PipeWire
 * sink, not just BlueZ "paired" — see its comment for why that
 * distinction matters on this board). The IP half is what makes this
 * board findable on a new network with zero prior network access — see
 * announceIpAddress() above. Polls because the sink can take a few
 * seconds to appear after this service starts; gives up quietly after
 * BOOT_ANNOUNCE_TIMEOUT_MS if one never does (no speaker configured, or
 * it's not in range yet — not an error). Runs once per service start,
 * not on every reconnect. */
const BOOT_ANNOUNCE_POLL_MS = 4000;
const BOOT_ANNOUNCE_TIMEOUT_MS = 90000;

function announceBootWhenReady() {
  if (g_alarms.hardware.output !== 'bt_speaker') return;
  const mac = g_alarms.hardware.bt_speaker && g_alarms.hardware.bt_speaker.mac;
  if (!mac) return;

  const deadline = Date.now() + BOOT_ANNOUNCE_TIMEOUT_MS;
  const tick = async () => {
    const target = await bt.findBluezSinkTarget(mac);
    if (target) {
      const ok = await bt.playAlert('uno q n2k', mac, 'buzzer');
      if (!ok) console.error('[ALARM] boot announcement: playback failed');
      /* Same "sink is ready" moment covers the IP too — no separate
       * poll loop needed. */
      await announceIpAddress();
      return;
    }
    if (Date.now() < deadline) {
      setTimeout(tick, BOOT_ANNOUNCE_POLL_MS);
    } else {
      console.warn('[ALARM] boot announcement: no Bluetooth sink appeared within timeout, skipping');
    }
  };
  tick();
}

announceBootWhenReady();
