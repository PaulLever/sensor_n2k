#!/usr/bin/env node
'use strict';

/*
 * bridge.js  –  SPI block protocol → canboatjs → Signal K
 *
 * Single process: no vcan / kernel module required.
 *
 * Data flow:
 *   Zephyr SPI slave ──/dev/spidev0.0──► this process
 *     ├─ canboatjs FromPgn ──► Signal K WebSocket (sensor data & bus PGNs)
 *     └─ SPI TX queue ◄── Signal K outgoing PGNs (future)
 *
 * Usage (run as root for SPI access):
 *   sudo node bridge.js [spidev] [skHost] [skPort]
 *
 * Defaults:
 *   spidev    /dev/spidev0.0
 *   skHost    localhost
 *   skPort    3000
 *
 * Dependencies:  npm install  spi-device  @canboat/canboatjs  ws
 *
 * NOTE on RDY (gpiochip1 line 70): the Zephyr side still drives this GPIO
 * high whenever it has data queued (see spi_bridge.c set_rdy()), but this
 * process does not read it — it polls on a fixed timer instead (see
 * POLL_MS below) and ignores RDY entirely. An interrupt-driven design
 * (block on a GPIO edge event instead of sleeping a fixed interval) would
 * cut both average latency and the risk of the Zephyr-side ship_msgq
 * (64 frames, non-blocking enqueue, no drop counter) overflowing under a
 * burst — see the PGN throughput report. Blocked on this kernel not
 * exposing legacy sysfs GPIO (/sys/class/gpio does not exist here), so the
 * old `onoff` dependency this file used to list never worked on this board
 * and was dropped; a working version needs the modern GPIO character-device
 * edge-event ioctls (e.g. via a libgpiod binding), which is more work than
 * this fixed-interval tuning pass. Left as a follow-up, not done here.
 */

const spiLib  = require('spi-device');
const { FromPgn } = require('@canboat/canboatjs');
const WebSocket   = require('ws');
const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const { spawn }   = require('child_process');
const readline    = require('readline');

const SPI_DEV = process.argv[2] || '/dev/spidev0.0';
const SK_HOST = process.argv[3] || 'localhost';
const SK_PORT = parseInt(process.argv[4] || '3000', 10);

/* Optional Signal K credentials — set SK_USER / SK_PASS in the systemd
 * service Environment= lines (or export them before running manually).
 * If unset, connection is attempted without a token (works only when SK
 * security is disabled or set to allow unauthenticated writes). */
const SK_USER = process.env.SK_USER || '';
const SK_PASS = process.env.SK_PASS || '';
const SPI_HZ  = 1_000_000;

/*
 * Transfer trigger: interrupt-driven (RDY GPIO edge via gpiomon), not a
 * fixed poll interval.
 *
 * Zephyr already drives gpiochip1 line 70 high whenever ship_msgq has data
 * (spi_bridge.c set_rdy()) — this used to be read by nothing at all. This
 * process previously blind-polled on a 500ms timer instead (later tuned to
 * 50ms), a leftover of an abandoned attempt to use the `onoff` npm package
 * for GPIO interrupts, which needs legacy sysfs GPIO (/sys/class/gpio) that
 * doesn't exist on this kernel. `node-libgpiod` was tried next but targets
 * libgpiod's old v1 C API (gpiod_line, gpiod_line_bulk) — this board ships
 * libgpiod 2.2.1, which removed those types, so it fails to even compile.
 * `gpiomon`, libgpiod v2's own CLI tool, is already installed (same
 * package as gpioset/gpioget, used elsewhere in this project) and is
 * guaranteed to match the installed library version. Spawning it and
 * reading edge events off its stdout avoids native compilation entirely.
 *
 * BACKSTOP_MS_* remain as a safety net, not the primary path:
 *   - catches any edge gpiomon's process might miss (crash/respawn window)
 *   - drains the outbound (Signal K → Zephyr) txQueue, which RDY doesn't
 *     signal for at all — RDY only reflects Zephyr's own TX side
 *   - preserves the existing STM32-(re)connect-detection logic below,
 *     which relies on a transfer happening periodically even when idle
 * The backstop runs tight (50ms, matching the old pure-polling tuning)
 * whenever gpiomon isn't confirmed healthy, and relaxed (250ms) once it is,
 * since interrupts handle the hot path at that point.
 */
const BACKSTOP_MS_FALLBACK = 50;
const BACKSTOP_MS_NORMAL   = 250;
const RDY_CHIP = 'gpiochip1';
const RDY_LINE = '70';
const MAX_DRAIN_ITERS = 20;   /* cap per trigger burst: 20 x 15 = 300 frames */

/* ------------------------------------------------------------------ */
/* Sensor config — load from /etc/sensor_n2k/config.json at startup    */
/* ------------------------------------------------------------------ */

const CONFIG_FILE       = '/etc/sensor_n2k/config.json';
const CFG_CAN_ID_BASE   = 0x1EFFFE00;  /* must match sensor_config.h   */

/* Param IDs (must match sensor_config.h CFG_PARAM_* defines) */
const P = {
  OW0_ENABLED: 0x01, OW0_SOURCE: 0x02, OW0_INSTANCE: 0x03, OW_POLL_MS: 0x04,
  OW1_ENABLED: 0x05, OW1_SOURCE: 0x06, OW1_INSTANCE: 0x07,
  OW2_ENABLED: 0x08, OW2_SOURCE: 0x09, OW2_INSTANCE: 0x0A,
  OW3_ENABLED: 0x0B, OW3_SOURCE: 0x0C, OW3_INSTANCE: 0x0D,
  OW0_PGN: 0x0E, OW1_PGN: 0x0F, OW2_PGN: 0x10, OW3_PGN: 0x1D,
  ADC_ENABLED: 0x11, ADC_SOURCE: 0x12, ADC_INSTANCE: 0x13, ADC_POLL_MS: 0x14,
  ADC_PGN: 0x15,
  OW0_TEST_EN: 0x16, OW0_TEST_VAL: 0x17,
  OW1_TEST_EN: 0x18, OW1_TEST_VAL: 0x19,
  OW2_TEST_EN: 0x1A, OW2_TEST_VAL: 0x1B,
  OW3_TEST_EN: 0x1C, OW3_TEST_VAL: 0x1E,
  ADC_TEST_EN: 0x1F, ADC_TEST_VAL: 0x20,
  PC0_ENABLED: 0x21, PC0_MODE:    0x22, PC0_HZ:  0x23, PC0_PPR: 0x24,
  PC0_ENG:    0x25, PC0_UPD:     0x26, PC0_AVG: 0x27,
  PC1_ENABLED: 0x31, PC1_MODE:    0x32, PC1_HZ:  0x33, PC1_PPR: 0x34,
  PC1_ENG:    0x35, PC1_UPD:     0x36, PC1_AVG: 0x37,
  SAVE_NVS:   0xFF,
};

/* N2K_PGNCFG_* values (must match sensor_config.h) */
const PGNCFG = { TEMP: 0, TEMP_EXT: 1, ENV_PARAMS: 2, ENGINE_DYN: 3, TRANS_DYN: 4 };

const DEFAULT_CFG = {
  onewire: {
    poll_ms: 2000,
    slots: [
      { enabled: true,  pgn_id: PGNCFG.TEMP, source: 2, instance: 1, test_mode: false, test_value_c: 20.0 },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 2, test_mode: false, test_value_c: 20.0 },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 3, test_mode: false, test_value_c: 20.0 },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 4, test_mode: false, test_value_c: 20.0 },
    ],
  },
  adc:     { enabled: true, pgn_id: PGNCFG.TEMP_EXT, source: 14, instance: 0, poll_ms: 1000, test_mode: false, test_value_c: 20.0 },
  pulse: [
    { enabled: false, mode: 'STW', hz_per_mps: 9.33,  update_ms: 1000, avg_samples: 5 },
    { enabled: false, mode: 'RPM', pulses_per_rev: 1.0, engine_instance: 0, update_ms: 500, avg_samples: 3 },
  ],
};

function loadSensorConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { console.error('[CFG] load error:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_CFG));
}

function u16LE(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }
function floatLE(v) { const b = Buffer.allocUnsafe(4); b.writeFloatLE(v); return [...b]; }
function pad8(arr) { while (arr.length < 8) arr.push(0); return arr.slice(0, 8); }

function cfgFrame(paramId, data) {
  return { id: (CFG_CAN_ID_BASE | (paramId & 0xFF)) >>> 0, data: Buffer.from(pad8(data)) };
}

function enqueueSensorConfig(cfg) {
  const q = txQueue;
  const ow = cfg.onewire;

  /* 1-Wire: shared poll interval + per-slot params */
  q.push(cfgFrame(P.OW_POLL_MS, u16LE(ow.poll_ms)));
  const owSlotParams = [
    [P.OW0_ENABLED, P.OW0_SOURCE, P.OW0_INSTANCE, P.OW0_PGN, P.OW0_TEST_EN, P.OW0_TEST_VAL],
    [P.OW1_ENABLED, P.OW1_SOURCE, P.OW1_INSTANCE, P.OW1_PGN, P.OW1_TEST_EN, P.OW1_TEST_VAL],
    [P.OW2_ENABLED, P.OW2_SOURCE, P.OW2_INSTANCE, P.OW2_PGN, P.OW2_TEST_EN, P.OW2_TEST_VAL],
    [P.OW3_ENABLED, P.OW3_SOURCE, P.OW3_INSTANCE, P.OW3_PGN, P.OW3_TEST_EN, P.OW3_TEST_VAL],
  ];
  (ow.slots || []).forEach((slot, i) => {
    if (i >= 4) { return; }
    const [ep, sp, ip, pp, tep, tvp] = owSlotParams[i];
    q.push(cfgFrame(ep,  [slot.enabled ? 1 : 0]));
    q.push(cfgFrame(sp,  [slot.source]));
    q.push(cfgFrame(ip,  [slot.instance]));
    q.push(cfgFrame(pp,  [slot.pgn_id !== undefined ? slot.pgn_id : PGNCFG.TEMP]));
    q.push(cfgFrame(tep, [slot.test_mode ? 1 : 0]));
    q.push(cfgFrame(tvp, floatLE(slot.test_value_c !== undefined ? slot.test_value_c : 20.0)));
  });

  const ad = cfg.adc;
  q.push(cfgFrame(P.ADC_ENABLED,  [ad.enabled ? 1 : 0]));
  q.push(cfgFrame(P.ADC_SOURCE,   [ad.source]));
  q.push(cfgFrame(P.ADC_INSTANCE, [ad.instance]));
  q.push(cfgFrame(P.ADC_POLL_MS,  u16LE(ad.poll_ms)));
  q.push(cfgFrame(P.ADC_PGN,      [ad.pgn_id !== undefined ? ad.pgn_id : PGNCFG.TEMP_EXT]));
  q.push(cfgFrame(P.ADC_TEST_EN,  [ad.test_mode ? 1 : 0]));
  q.push(cfgFrame(P.ADC_TEST_VAL, floatLE(ad.test_value_c !== undefined ? ad.test_value_c : 20.0)));

  const p0 = cfg.pulse[0];
  q.push(cfgFrame(P.PC0_ENABLED, [p0.enabled ? 1 : 0]));
  q.push(cfgFrame(P.PC0_MODE,    [p0.mode === 'RPM' ? 1 : 0]));
  q.push(cfgFrame(P.PC0_HZ,      floatLE(p0.hz_per_mps || 9.33)));
  q.push(cfgFrame(P.PC0_PPR,     floatLE(p0.pulses_per_rev || 1.0)));
  q.push(cfgFrame(P.PC0_ENG,     [p0.engine_instance || 0]));
  q.push(cfgFrame(P.PC0_UPD,     u16LE(p0.update_ms)));
  q.push(cfgFrame(P.PC0_AVG,     [p0.avg_samples]));

  const p1 = cfg.pulse[1];
  q.push(cfgFrame(P.PC1_ENABLED, [p1.enabled ? 1 : 0]));
  q.push(cfgFrame(P.PC1_MODE,    [p1.mode === 'RPM' ? 1 : 0]));
  q.push(cfgFrame(P.PC1_HZ,      floatLE(p1.hz_per_mps || 9.33)));
  q.push(cfgFrame(P.PC1_PPR,     floatLE(p1.pulses_per_rev || 1.0)));
  q.push(cfgFrame(P.PC1_ENG,     [p1.engine_instance || 0]));
  q.push(cfgFrame(P.PC1_UPD,     u16LE(p1.update_ms)));
  q.push(cfgFrame(P.PC1_AVG,     [p1.avg_samples]));

  q.push(cfgFrame(P.SAVE_NVS, []));   /* trigger STM32 NVS persist */
  console.log(`[CFG] Queued ${q.length} config frames for STM32`);
}

/* ------------------------------------------------------------------ */
/* SPI block protocol (must match spi_bridge.c on the Zephyr side)    */
/* ------------------------------------------------------------------ */

/* Block format matches can_spi_bridge_n2k / spi_bridge.c exactly:
 *   [0] magic  [1] ver  [2] count  [3] seq
 *   [4..253]   records (15 × 16 bytes)
 *   [254..255] CRC-16 LE over bytes [0..253]
 *
 * Record: [0..3] CAN ID LE  [4] len  [5] flags  [6..7] rsvd  [8..15] data
 */
const BLOCK_SIZE       = 256;
const BLOCK_MAGIC      = 0xA5;
const BLOCK_VERSION    = 0x03;
const RECORDS_OFFSET   = 4;
const BLOCK_MAX_FRAMES = 15;
const RECORD_SIZE      = 16;
const CRC_OFFSET       = 254;   /* BLOCK_SIZE - 2 */

function crc16(buf, length) {
  let crc = 0xFFFF;
  for (let i = 0; i < length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

/* ------------------------------------------------------------------ */
/* TX queue (Signal K → Zephyr)                                        */
/* ------------------------------------------------------------------ */

const txQueue = [];

function buildTxBlock() {
  const block = Buffer.alloc(BLOCK_SIZE, 0x00);
  block[0] = BLOCK_MAGIC;
  block[1] = BLOCK_VERSION;
  const count = Math.min(txQueue.length, BLOCK_MAX_FRAMES);
  block[2] = count;
  for (let i = 0; i < count; i++) {
    const frame = txQueue.shift();
    const off   = RECORDS_OFFSET + i * RECORD_SIZE;
    block.writeUInt32LE(frame.id & 0x1FFFFFFF, off);
    block[off + 4] = frame.data.length;
    block[off + 5] = 0x04;   /* CAN_FRAME_IDE */
    frame.data.copy(block, off + 8, 0, 8);
  }
  const c = crc16(block, CRC_OFFSET);
  block[CRC_OFFSET]     = c & 0xFF;
  block[CRC_OFFSET + 1] = (c >> 8) & 0xFF;
  return block;
}

let _transferCount = 0;
let _stmLastSeen   = 0;   /* ms timestamp of last valid STM32 block */
let _cfgScheduled  = false;

/* Dropped-block tracking. block[3] ("seq") is Zephyr's own counter,
 * incremented once per completed SPI transaction (spi_bridge.c: seq++;
 * pack_block(seq);) regardless of whether that block carried any frames.
 * As SPI slave, Zephyr's spi_transceive() only returns once the master
 * (this process) has actually clocked a transaction, so under normal
 * operation a CRC-valid block's seq should be exactly (last valid seq + 1),
 * mod 256. A gap here means a transaction happened but this process never
 * kept a usable block for it — the only way that occurs in this protocol
 * is a corrupted block that failed CRC and was discarded (see below), but
 * tracking it via seq (ground truth from Zephyr) rather than just counting
 * CRC failures also catches anything else that could cause the same
 * symptom without assuming the cause. */
let _lastGoodSeq    = null;
let _crcFailures    = 0;   /* diagnostic: how many blocks arrived corrupted */
let _seqGapTotal    = 0;   /* authoritative: total blocks lost, any cause */

/* Schedule a fresh config push sequence starting from 'now'.
 * Called whenever the STM32 is detected (re)connecting. */
function scheduleConfigPush() {
  _cfgScheduled = true;
  [1100, 3700, 8300, 14900].forEach((ms, i) => {
    setTimeout(() => {
      pushConfig(i + 1);
      if (i === 3) { _cfgScheduled = false; }   /* all done */
    }, ms);
  });
}

function parseRxBlock(block) {
  _transferCount++;

  if (_transferCount <= 5 || _transferCount % 20 === 0) {
    console.log(`[SPI] block #${_transferCount} magic=0x${block[0].toString(16)} ver=0x${block[1].toString(16)} count=${block[2]}`);
    console.log(`[SPI]  hdr[0..7]:   ${block.slice(0, 8).toString('hex')}`);
    console.log(`[SPI]  tail[248..]: ${block.slice(248).toString('hex')}`);
  }

  if (block[0] !== BLOCK_MAGIC || block[1] !== BLOCK_VERSION) return [];

  /* Detect STM32 (re)boot: first valid block after a 5-second gap */
  const now = Date.now();
  if (!_cfgScheduled && (now - _stmLastSeen) > 5000) {
    console.log('[CFG] STM32 online — scheduling config push…');
    scheduleConfigPush();
  }
  _stmLastSeen = now;

  const rxCrc   = block[CRC_OFFSET] | (block[CRC_OFFSET + 1] << 8);
  const calcCrc = crc16(block, CRC_OFFSET);
  if (rxCrc !== calcCrc) {
    _crcFailures++;
    console.warn(`[SPI] DROPPED block: CRC mismatch (calc=0x${calcCrc.toString(16)} expected=0x${rxCrc.toString(16)}) — discarding, not processing corrupted data. crcFailures=${_crcFailures}`);
    /* Do NOT advance _lastGoodSeq here — block[3] itself may be corrupted
     * too, so it isn't trustworthy. The gap this leaves will be reported
     * against the next block that DOES pass CRC. */
    return [];
  }

  const seq = block[3];
  if (_lastGoodSeq !== null) {
    const gap = (seq - _lastGoodSeq - 1) & 0xFF;
    if (gap > 0) {
      _seqGapTotal += gap;
      console.warn(`[SPI] DROPPED ${gap} block(s): sequence gap (last good seq=${_lastGoodSeq}, now=${seq}) — total blocks lost=${_seqGapTotal}`);
    }
  }
  _lastGoodSeq = seq;

  const count = Math.min(block[2], BLOCK_MAX_FRAMES);
  if (count > 0) console.log(`[SPI] ${count} frame(s) in block`);

  const frames = [];
  for (let i = 0; i < count; i++) {
    const off    = RECORDS_OFFSET + i * RECORD_SIZE;
    const idWord = block.readUInt32LE(off) >>> 0;
    const dlc    = Math.min(block[off + 4], 8);
    /* Diagnostic: dump raw record bytes to confirm what Zephyr sent */
    console.log(`[SPI] record[${i}] raw[off=${off}..${off+15}]: ${block.slice(off, off + 16).toString('hex')}`);
    const frame  = {
      id:   idWord & 0x1FFFFFFF,
      ext:  !!(block[off + 5] & 0x01),   /* CAN_FRAME_IDE = BIT(0) in Zephyr */
      data: Buffer.from(block.slice(off + 8, off + 8 + dlc)),
    };
    console.log(`[SPI] frame CAN ID=0x${frame.id.toString(16)} ext=${frame.ext} dlc=${dlc} data=${frame.data.toString('hex')}`);
    frames.push(frame);
  }
  return frames;
}

/* ------------------------------------------------------------------ */
/* Signal K WebSocket                                                   */
/* ------------------------------------------------------------------ */

let ws        = null;
let wsPending = [];
let skToken   = null;   /* JWT from SK login; refreshed on reconnect */

/* POST /signalk/v1/auth/login → JWT token, or null on failure/no-auth. */
function skLogin() {
  return new Promise((resolve) => {
    if (!SK_USER || !SK_PASS) { resolve(null); return; }
    const body = JSON.stringify({ username: SK_USER, password: SK_PASS });
    const req  = http.request({
      hostname: SK_HOST, port: SK_PORT,
      path: '/signalk/v1/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.token) { console.log('[SK] Authenticated as', SK_USER); resolve(j.token); }
          else { console.warn('[SK] Login failed:', data.substring(0, 120)); resolve(null); }
        } catch (e) { resolve(null); }
      });
    });
    req.on('error', (e) => { console.warn('[SK] Login request error:', e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function connectSK() {
  skToken = await skLogin();
  const tokenParam = skToken ? `&token=${encodeURIComponent(skToken)}` : '';
  const url = `ws://${SK_HOST}:${SK_PORT}/signalk/v1/stream?subscribe=none${tokenParam}`;
  ws = new WebSocket(url);
  ws.on('open', () => {
    console.log(`[SK] Connected to ${url.replace(/token=[^&]+/, 'token=***')}`);
    wsPending.forEach(m => ws.send(m));
    wsPending = [];
  });
  ws.on('error', err => console.error('[SK] WS error:', err.message));
  ws.on('close', () => {
    console.warn('[SK] Disconnected, retrying in 5 s…');
    setTimeout(connectSK, 5000);
  });
}

function sendDelta(delta) {
  const msg = JSON.stringify(delta);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(msg);
  } else {
    if (wsPending.length === 0) {
      console.warn('[SK] Not connected — buffering delta (Signal K not yet reachable?)');
    }
    wsPending.push(msg);
  }
}

/* ------------------------------------------------------------------ */
/* N2K PGN → Signal K path mapping                                     */
/* ------------------------------------------------------------------ */

/* canboatjs v3.x FromPgn is event-based: call .parse(string), listen for 'pgn' event */
const decoder = new FromPgn();
console.log('[N2K] FromPgn methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(decoder)).filter(k => typeof decoder[k] === 'function'));

/* Extract NMEA 2000 PGN from a 29-bit CAN ID */
function canIdToPgn(canId) {
  const dp = (canId >> 24) & 0x01;
  const pf = (canId >> 16) & 0xFF;
  const ge = (canId >>  8) & 0xFF;
  return pf >= 0xF0
    ? (dp << 16) | (pf << 8) | ge
    : (dp << 16) | (pf << 8);
}

/* ── Engine instance: canboatjs translates 0→"Single Engine or Dual Engine Port",
 *    1→"Dual Engine Starboard" via its ENGINE_INSTANCE lookup. Return numeric index. ── */
function engineInstNum(fields) {
  const raw = fields.engineInstance ?? fields['Engine Instance'] ?? fields.instance;
  if (raw == null) return 0;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    if (raw.toLowerCase().includes('starboard')) return 1;
    if (raw.toLowerCase().includes('center') || raw.toLowerCase().includes('centre')) return 2;
    return 0;  /* Single engine, port, or unknown label */
  }
  return 0;
}

/* ── Temperature source → Signal K path helper ── */
function tempSourcePath(source, instance) {
  if      (source === 14 || source === 'Exhaust Gas Temperature')  return `propulsion.${instance}.exhaustTemperature`;
  else if (source === 2  || source === 'Inside Temperature')        return 'environment.inside.temperature';
  else if (source === 3  || source === 'Engine Room Temperature')   return 'environment.engineRoom.temperature';
  else if (source === 1  || source === 'Outside Temperature')       return 'environment.outside.temperature';
  else                                                               return `environment.temperature.instance${source}`;
}

/* Central handler for all decoded PGN events — called from both the main
 * canboatjs decoder (single-frame PGNs) and the fast-packet dispatcher. */
function handleParsedPgn(parsed) {
  console.log('[N2K] pgn event:', parsed.pgn, JSON.stringify(parsed.fields).substring(0, 80));
  const pgn    = parsed.pgn;
  const fields = parsed.fields || {};
  const ts     = new Date().toISOString();
  const values = [];

  if (pgn === 130316 || pgn === 130312) {
    const source   = fields.source   ?? fields.temperatureSource;
    const instance = fields.instance ?? fields.temperatureInstance ?? 0;
    const tempK    = fields.actualTemperature ?? fields.temperature;
    if (tempK == null) return;
    const path = tempSourcePath(source, instance);
    values.push({ path, value: tempK });
    console.log(`[N2K] PGN ${pgn} (${source}): ${(tempK - 273.15).toFixed(2)} °C → ${path}`);
  }

  if (pgn === 130311) {
    const source = fields.temperatureSource ?? fields.source ?? 0;
    const tempK  = fields.temperature;
    if (tempK == null) return;
    const path = tempSourcePath(source, 0);
    values.push({ path, value: tempK });
    if (fields.humidity != null)          values.push({ path: 'environment.outside.humidity', value: fields.humidity });
    if (fields.atmosphericPressure != null) values.push({ path: 'environment.outside.pressure', value: fields.atmosphericPressure });
    console.log(`[N2K] PGN 130311 (${source}): ${(tempK - 273.15).toFixed(2)} °C → ${path}`);
  }

  if (pgn === 127489) {
    const inst = engineInstNum(fields);
    const oil  = fields.oilTemperature ?? fields['Oil Temperature'];
    if (oil != null) values.push({ path: `propulsion.${inst}.oilTemperature`, value: oil });
    const coolant = fields.temperature ?? fields['Engine Temperature'];
    if (coolant != null) {
      values.push({ path: `propulsion.${inst}.coolantTemperature`, value: coolant });
      console.log(`[N2K] PGN 127489 inst=${inst} coolant ${(coolant - 273.15).toFixed(2)} °C`);
    }
  }

  if (pgn === 127493) {
    const inst    = engineInstNum(fields);
    const oilTemp = fields.oilTemperature ?? fields['Oil Temperature'];
    if (oilTemp != null) {
      values.push({ path: `propulsion.${inst}.transmission.oilTemperature`, value: oilTemp });
      console.log(`[N2K] PGN 127493 inst=${inst}: ${(oilTemp - 273.15).toFixed(2)} °C`);
    }
  }

  if (pgn === 128259) {
    const stw = fields.speedWaterReferenced ?? fields['Speed Water Referenced'];
    if (stw != null) values.push({ path: 'navigation.speedThroughWater', value: stw });
  }

  if (pgn === 127488 && fields.engineSpeed != null) {
    const inst = fields.engineInstance ?? 0;
    values.push({ path: `propulsion.${inst}.revolutions`, value: fields.engineSpeed / 60 });
  }

  if (values.length === 0) return;
  sendDelta({
    context: 'vessels.self',
    updates: [{ source: { label: 'n2k-bridge', type: 'NMEA2000' }, timestamp: ts, values }],
  });
}

decoder.on('pgn', handleParsedPgn);

/* ------------------------------------------------------------------ */
/* Generic fast-packet reassembly                                       */
/*                                                                      */
/* Canboatjs keys its fast-packet buffer on (pgn, src) only. When two  */
/* sequences from the same source and PGN arrive back-to-back (e.g.    */
/* two engine instances both using PGN 127489) it may fail to start    */
/* the second assembly cleanly.                                         */
/*                                                                      */
/* Fix: intercept all frames for known fast-packet PGNs before they    */
/* reach canboatjs. Reassemble using (src, pgn, seq) as the key so     */
/* concurrent sequences never collide. Each complete sequence is fed    */
/* to a FRESH FromPgn instance for field decoding, then routed through  */
/* handleParsedPgn exactly as if it had come from the main decoder.     */
/* ------------------------------------------------------------------ */

/* PGNs that use NMEA 2000 fast-packet framing (payload > 8 bytes).
 * Derived from canboat pgns.json; extend as needed. */
const FAST_PACKET_PGNS = new Set([
  65240,  126208, 126464, 126996, 126998, 127237,
  127489, 127503, 127506, 127507, 127508,
  128275, 129029, 129038, 129039, 129040, 129041,
  129044, 129045, 129794, 129809, 129810,
  130074, 130323, 130577,
]);

const fpAssembly = new Map();  /* key: `${src}_${pgn}_${seq}` */

function handleFpFrame(key, frame, pgn, src, prio) {
  const d  = frame.data;
  const fn = d[0] & 0x1F;

  if (fn === 0) {
    /* Start a new assembly, replacing any stale entry with the same key */
    fpAssembly.set(key, { prio, frames: [frame], total: d[1] });
  } else {
    const entry = fpAssembly.get(key);
    if (!entry) { return; }   /* continuation without a known fn=0 → discard */
    entry.frames.push(frame);
    /* frame 0 carries 6 payload bytes; each subsequent frame carries 7 */
    const received = 6 + (entry.frames.length - 1) * 7;
    if (received >= entry.total) {
      fpAssembly.delete(key);
      dispatchFastPacket(pgn, src, entry.prio, entry.frames);
    }
  }
}

function dispatchFastPacket(pgn, src, prio, frames) {
  /* Fresh FromPgn per sequence — no stale buffer state, no inter-sequence collision */
  const fp = new FromPgn();
  fp.on('pgn', handleParsedPgn);
  const ts = new Date().toISOString();
  frames.forEach(f => {
    const hex = Array.from(f.data).map(b => b.toString(16).padStart(2, '0')).join(',');
    try {
      fp.parse(`${ts},${prio},${pgn},${src},255,${f.data.length},${hex}`);
    } catch (e) {
      console.error('[FP] decode error PGN', pgn, ':', e.message);
    }
  });
}

function handleFrame(frame) {
  if (!frame.ext) return;

  const pgn  = canIdToPgn(frame.id);
  const src  = frame.id & 0xFF;
  const prio = (frame.id >> 26) & 0x7;
  const d    = frame.data;
  const fn   = d[0] & 0x1F;
  const seq  = (d[0] >> 5) & 0x07;
  const key  = `${src}_${pgn}_${seq}`;

  /* Fast-packet PGNs: route through our assembler regardless of frame number */
  if (FAST_PACKET_PGNS.has(pgn)) {
    if (fn === 0 || fpAssembly.has(key)) {
      handleFpFrame(key, frame, pgn, src, prio);
      return;
    }
  }

  /* Single-frame PGN → canboatjs */
  const ts  = new Date().toISOString();
  const hex = Array.from(d).map(b => b.toString(16).padStart(2, '0')).join(',');
  try {
    decoder.parse(`${ts},${prio},${pgn},${src},255,${d.length},${hex}`);
  } catch (e) {
    console.error('[N2K] parse error:', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* SPI transfer loop                                                    */
/* ------------------------------------------------------------------ */

function openSpi(dev) {
  const [bus, addr] = dev.match(/spidev(\d+)\.(\d+)/).slice(1).map(Number);
  return new Promise((resolve, reject) => {
    const s = spiLib.open(bus, addr, { maxSpeedHz: SPI_HZ, mode: spiLib.MODE0 },
      err => err ? reject(err) : resolve(s));
  });
}

function transfer(spiDev, txBuf) {
  return new Promise((resolve, reject) => {
    const rxBuf = Buffer.alloc(BLOCK_SIZE);
    spiDev.transfer(
      [{ sendBuffer: txBuf, receiveBuffer: rxBuf, byteLength: BLOCK_SIZE }],
      err => err ? reject(err) : resolve(rxBuf));
  });
}

function pushConfig(attempt) {
  const cfg = loadSensorConfig();
  console.log(`[CFG] Pushing sensor config to STM32 (attempt ${attempt})…`);
  enqueueSensorConfig(cfg);
}

async function run() {
  console.log(`[SPI] Opening ${SPI_DEV} at ${SPI_HZ} Hz`);
  const spiDev = await openSpi(SPI_DEV);

  await connectSK();

  /* Config is pushed dynamically when the STM32 is detected online
   * (see scheduleConfigPush / parseRxBlock above). No static timers needed. */

  /* Re-push config whenever config.json is saved from the web UI */
  if (require('fs').existsSync(CONFIG_FILE)) {
    let reloadTimer = null;
    require('fs').watch(CONFIG_FILE, () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        console.log('[CFG] Config file changed — re-pushing to STM32…');
        enqueueSensorConfig(loadSensorConfig());
      }, 200);
    });
    console.log('[CFG] Watching', CONFIG_FILE, 'for changes');
  }

  let _inFlight = false;
  let _overlapSkips = 0;
  let _xferDurations = [];   /* rolling window of transfer durations, ms */

  /* One SPI transaction. Returns true if the received block was completely
   * full (count === BLOCK_MAX_FRAMES) — a heuristic for "more is probably
   * still queued behind this", used by drainLoop() to decide whether to
   * immediately transfer again rather than wait for the next trigger. */
  const doTransferOnce = async () => {
    if (_inFlight) {
      /* Previous transfer hasn't resolved yet — skip rather than starting
       * a second concurrent spiDev.transfer() on the same fd. Should be
       * rare given ~3-6ms measured transfers vs. the intervals/triggers
       * this fires on; if this counter climbs, something upstream (an
       * event storm, a stuck transfer) needs attention. */
      _overlapSkips++;
      return false;
    }
    _inFlight = true;
    const t0 = process.hrtime.bigint();
    let full = false;
    try {
      const rxBuf = await transfer(spiDev, buildTxBlock());
      parseRxBlock(rxBuf).forEach(handleFrame);
      full = rxBuf[2] === BLOCK_MAX_FRAMES;
    } catch (err) {
      console.error('[SPI] Transfer error:', err.message);
    } finally {
      const durMs = Number(process.hrtime.bigint() - t0) / 1e6;
      _xferDurations.push(durMs);
      if (_xferDurations.length >= 100) {
        const avg = _xferDurations.reduce((a, b) => a + b, 0) / _xferDurations.length;
        const max = Math.max(..._xferDurations);
        console.log(`[SPI] transfer latency over last ${_xferDurations.length}: avg=${avg.toFixed(2)}ms max=${max.toFixed(2)}ms overlapSkips=${_overlapSkips} crcFailures=${_crcFailures} blocksLost=${_seqGapTotal}`);
        _xferDurations = [];
      }
      _inFlight = false;
    }
    return full;
  };

  /* Keep transferring while the last block came back full (probable
   * backlog) or there's outbound data queued, bounded so a runaway
   * producer can't turn one trigger into an unbounded tight loop. */
  const drainLoop = async (source) => {
    for (let i = 0; i < MAX_DRAIN_ITERS; i++) {
      const full = await doTransferOnce();
      if (!full && txQueue.length === 0) break;
    }
  };

  /* ---------------- interrupt-driven trigger (gpiomon) ---------------- */

  let gpiomonHealthy = false;

  function startGpiomon() {
    let proc;
    try {
      proc = spawn('gpiomon', ['-c', RDY_CHIP, '-e', 'rising', '-F', '%e', RDY_LINE],
        { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      console.error('[GPIO] Failed to spawn gpiomon:', err.message,
        '— staying on backstop-only polling');
      return;
    }

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', () => {
      gpiomonHealthy = true;
      drainLoop('irq').catch(err => console.error('[SPI] drainLoop(irq) error:', err.message));
    });

    proc.stderr.on('data', d => {
      console.error('[GPIO] gpiomon stderr:', d.toString().trim());
    });

    proc.on('error', err => {
      gpiomonHealthy = false;
      console.error('[GPIO] gpiomon process error:', err.message,
        '— falling back to backstop-only polling');
    });

    proc.on('exit', (code, signal) => {
      gpiomonHealthy = false;
      console.error(`[GPIO] gpiomon exited (code=${code} signal=${signal}) — ` +
        `dropping to ${BACKSTOP_MS_FALLBACK}ms backstop polling and respawning in 2s`);
      setTimeout(startGpiomon, 2000);
    });

    console.log(`[GPIO] gpiomon watching ${RDY_CHIP} line ${RDY_LINE} for rising edges (RDY)`);
  }

  /* ---------------- backstop (missed edges, outbound TX, reconnect) --- */

  function scheduleBackstop() {
    const interval = gpiomonHealthy ? BACKSTOP_MS_NORMAL : BACKSTOP_MS_FALLBACK;
    setTimeout(async () => {
      try {
        await drainLoop('backstop');
      } catch (err) {
        console.error('[SPI] drainLoop(backstop) error:', err.message);
      }
      scheduleBackstop();
    }, interval);
  }

  startGpiomon();
  scheduleBackstop();
  drainLoop('startup').catch(err => console.error('[SPI] drainLoop(startup) error:', err.message));

  console.log(`[bridge] Interrupt-driven on ${RDY_CHIP}:${RDY_LINE}, ` +
    `backstop ${BACKSTOP_MS_FALLBACK}/${BACKSTOP_MS_NORMAL}ms (fallback/normal)`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
