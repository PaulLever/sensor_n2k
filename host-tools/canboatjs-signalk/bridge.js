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
const n2kMapper = require('@signalk/n2k-signalk');
const WebSocket   = require('ws');
const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const { spawn }   = require('child_process');
const readline    = require('readline');

const SPI_DEV = process.argv[2] || '/dev/spidev0.0';
const SK_HOST = process.argv[3] || 'localhost';
const SK_PORT = parseInt(process.argv[4] || '3000', 10);

/* Local-only event bus for alarm-server.js / bus-monitor-server.js.
 * 127.0.0.1-bound — never exposed off-board. */
const LOCAL_BUS_PORT = 3010;

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
const SPI_DRAIN_PACING_MS = 150; /* see drainLoop() — Zephyr's SPI slave needs this long to re-arm between transfers */

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
  ALARM_BUZZER: 0x40, ALARM_LED: 0x41, ALARM_STOP: 0x42,
  DISCOVER_DEVICES: 0x43,
  REQUEST_PRODUCT_INFO: 0x44,
  OW0_ROM: 0x45, OW1_ROM: 0x46, OW2_ROM: 0x47, OW3_ROM: 0x48,
  OW_RESCAN: 0x49,
  BILGE0_ENABLED: 0x4A, BILGE1_ENABLED: 0x4B, BILGE2_ENABLED: 0x4C, BILGE3_ENABLED: 0x4D,
  BILGE_SWITCH_INSTANCE: 0x4E, BILGE_DEBOUNCE_MS: 0x4F,
  SAVE_NVS:   0xFF,
};

/* N2K_PGNCFG_* values (must match sensor_config.h) */
const PGNCFG = { TEMP: 0, TEMP_EXT: 1, ENV_PARAMS: 2, ENGINE_DYN: 3, TRANS_DYN: 4 };

const DEFAULT_CFG = {
  onewire: {
    poll_ms: 2000,
    /* rom_id: hex string (16 chars, matching the hex the ROM-report path
     * above already produces) identifying the bound DS18B20 by its 1-Wire
     * ROM, or null for legacy positional binding (slot N = the Nth sensor
     * found in bus-scan order — the original behavior, kept as a fallback
     * for slots nobody has explicitly bound yet). See resolve_slave_index()
     * in onewire.c for how the firmware uses this. */
    slots: [
      { enabled: true,  pgn_id: PGNCFG.TEMP, source: 2, instance: 1, test_mode: false, test_value_c: 20.0, rom_id: null },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 2, test_mode: false, test_value_c: 20.0, rom_id: null },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 3, test_mode: false, test_value_c: 20.0, rom_id: null },
      { enabled: false, pgn_id: PGNCFG.TEMP, source: 2, instance: 4, test_mode: false, test_value_c: 20.0, rom_id: null },
    ],
  },
  adc:     { enabled: true, pgn_id: PGNCFG.TEMP_EXT, source: 14, instance: 0, poll_ms: 1000, test_mode: false, test_value_c: 20.0 },
  pulse: [
    { enabled: false, mode: 'STW', hz_per_mps: 9.33,  update_ms: 1000, avg_samples: 5 },
    { enabled: false, mode: 'RPM', pulses_per_rev: 1.0, engine_instance: 0, update_ms: 500, avg_samples: 3 },
  ],
  /* Bilge pump monitor — firmware just reports state/cycles/on-time per
   * channel (see bilge.c); count/runtime alarm thresholds are configured
   * separately, in alarm-server.js's rules, not here. */
  bilge: {
    enabled: [false, false, false, false],
    switch_instance: 1,
    debounce_ms: 2000,
  },
};

function loadSensorConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    }
  } catch (e) { console.error('[CFG] load error:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_CFG));
}

/*
 * Engine/transmission fault notifications (PGN 127489/127493's
 * discreteStatus bit fields, mapped by @signalk/n2k-signalk to
 * notifications.propulsion.<id>.<flag> / .transmission.<flag>) are always
 * present in every delta once those PGNs are received, because this
 * device's firmware — having no actual fault sensors for e.g. oil
 * pressure, coolant level, water flow, etc. — always reports those bits
 * as "no fault" (see n2k.c's N2K_PGNCFG_ENGINE_DYN/TRANS_DYN: BITLOOKUP
 * fields have no "not available" bit pattern, so 0 is both "no fault" and
 * "never checked"). n2k-signalk itself has no third state for this either
 * — it's alarm-if-set, normal-otherwise, unconditionally. Left unfiltered
 * that's 24+5 "X is Normal" notifications per engine/transmission instance
 * for conditions this device was never wired to actually observe.
 *
 * notificationPassthrough.propulsion in config.json is an allow-list of
 * flag keys (e.g. "checkEngine", "transmission.overTemperature" — the
 * portion of the path after notifications.propulsion.<id>.) to let
 * through anyway. Empty by default. As real sensors for a given condition
 * get added (a real oil-pressure switch wired to a bilge/pulse channel,
 * say), add its flag key here via the Configuration page and its
 * notification starts flowing — no code change needed.
 */
const NOTIFICATION_PATH_RE = /^notifications\.propulsion\.[^.]+\.(.+)$/;
let notificationAllowList = new Set();

function refreshNotificationAllowList() {
  const cfg = loadSensorConfig();
  const list = (cfg.notificationPassthrough && Array.isArray(cfg.notificationPassthrough.propulsion))
    ? cfg.notificationPassthrough.propulsion
    : [];
  notificationAllowList = new Set(list);
}

function isBlockedNotification(path) {
  const m = NOTIFICATION_PATH_RE.exec(path);
  if (!m) return false;   /* not one of these propulsion fault notifications — never filtered */
  return !notificationAllowList.has(m[1]);
}

function u16LE(v) { return [v & 0xFF, (v >> 8) & 0xFF]; }
function floatLE(v) { const b = Buffer.allocUnsafe(4); b.writeFloatLE(v); return [...b]; }
function pad8(arr) { while (arr.length < 8) arr.push(0); return arr.slice(0, 8); }

/* 16-hex-char ROM id -> 8 big-endian bytes (matches bytes_to_u64_be() in
 * sensor_config.c and the hex string ONEWIRE_ROM_REPORT_CAN_ID reports
 * already use). null/unset -> all-zero, which the firmware reads as
 * "unbound" (falls back to positional binding). */
function romBE(hex) {
  if (!hex) return [0, 0, 0, 0, 0, 0, 0, 0];
  return [...Buffer.from(hex, 'hex')];
}

function cfgFrame(paramId, data) {
  return { id: (CFG_CAN_ID_BASE | (paramId & 0xFF)) >>> 0, data: Buffer.from(pad8(data)) };
}

function enqueueSensorConfig(cfg) {
  const q = txQueue;
  const ow = cfg.onewire;

  /* 1-Wire: shared poll interval + per-slot params */
  q.push(cfgFrame(P.OW_POLL_MS, u16LE(ow.poll_ms)));
  const owSlotParams = [
    [P.OW0_ENABLED, P.OW0_SOURCE, P.OW0_INSTANCE, P.OW0_PGN, P.OW0_TEST_EN, P.OW0_TEST_VAL, P.OW0_ROM],
    [P.OW1_ENABLED, P.OW1_SOURCE, P.OW1_INSTANCE, P.OW1_PGN, P.OW1_TEST_EN, P.OW1_TEST_VAL, P.OW1_ROM],
    [P.OW2_ENABLED, P.OW2_SOURCE, P.OW2_INSTANCE, P.OW2_PGN, P.OW2_TEST_EN, P.OW2_TEST_VAL, P.OW2_ROM],
    [P.OW3_ENABLED, P.OW3_SOURCE, P.OW3_INSTANCE, P.OW3_PGN, P.OW3_TEST_EN, P.OW3_TEST_VAL, P.OW3_ROM],
  ];
  (ow.slots || []).forEach((slot, i) => {
    if (i >= 4) { return; }
    const [ep, sp, ip, pp, tep, tvp, rp] = owSlotParams[i];
    q.push(cfgFrame(ep,  [slot.enabled ? 1 : 0]));
    q.push(cfgFrame(sp,  [slot.source]));
    q.push(cfgFrame(ip,  [slot.instance]));
    q.push(cfgFrame(pp,  [slot.pgn_id !== undefined ? slot.pgn_id : PGNCFG.TEMP]));
    q.push(cfgFrame(tep, [slot.test_mode ? 1 : 0]));
    q.push(cfgFrame(tvp, floatLE(slot.test_value_c !== undefined ? slot.test_value_c : 20.0)));
    q.push(cfgFrame(rp,  romBE(slot.rom_id)));
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

  const bilge = cfg.bilge || DEFAULT_CFG.bilge;
  const bilgeEnabledParams = [P.BILGE0_ENABLED, P.BILGE1_ENABLED, P.BILGE2_ENABLED, P.BILGE3_ENABLED];
  bilgeEnabledParams.forEach((p, i) => {
    q.push(cfgFrame(p, [(bilge.enabled && bilge.enabled[i]) ? 1 : 0]));
  });
  q.push(cfgFrame(P.BILGE_SWITCH_INSTANCE, [bilge.switch_instance !== undefined ? bilge.switch_instance : 1]));
  q.push(cfgFrame(P.BILGE_DEBOUNCE_MS, u16LE(bilge.debounce_ms !== undefined ? bilge.debounce_ms : 2000)));

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

/* ------------------------------------------------------------------ */
/* Local event bus (127.0.0.1:LOCAL_BUS_PORT) — alarm-server.js and       */
/* bus-monitor-server.js are the clients. Never exposed off-board.        */
/* ------------------------------------------------------------------ */

function handleLocalBusCommand(msg) {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'buzzer':
      /* pattern: 0=off,1=continuous,2=repeat-beep,3=single-beep (see
       * alarm_io.c). volume is accepted/stored on the Zephyr side but a
       * no-op in v1 hardware. */
      txQueue.push(cfgFrame(P.ALARM_BUZZER, [
        (msg.pattern || 0) & 0xFF, (msg.volume || 0) & 0xFF,
      ]));
      break;
    case 'led':
      txQueue.push(cfgFrame(P.ALARM_LED, [(msg.state || 0) & 0xFF]));
      break;
    case 'stop':
      txQueue.push(cfgFrame(P.ALARM_STOP, []));
      break;
    case 'discover': {
      /* On-demand device discovery — broadcasts an ISO Request for PGN
       * 60928, prompting even passive devices (e.g. instrument displays
       * that only transmit at their own power-on) to respond. See
       * n2k_discover_devices() in n2k.c. Follow up with Product Info
       * requests so devices that implement PGN 126996 also report their
       * real name — see n2k_request_product_info().
       *
       * Both requests go out as a single GLOBAL broadcast (dst=0xFF), so
       * on a bus with many devices they can all try to answer in the same
       * short window. PGN 126996 in particular is fast-packet (4-5 CAN
       * frames per device), and CAN's arbitration means the frames
       * themselves never collide on the wire — but a burst of ~10 devices
       * × ~5 frames each can exceed the SPI bridge's own instantaneous
       * throughput (see n2k_bench.py's documented loss wall), so WE drop
       * frames on the way in. A half-received fast-packet sequence never
       * completes (see fpAssembly's cleanup comment below), so that
       * device's Product Info response is silently lost for this attempt
       * — it falls back to manufacturer-only naming even though it does
       * support 126996. Confirmed on a real ~10-device bus: only devices
       * that "won" the race got a name; the rest didn't, and one manual
       * click gives every device exactly one chance to win it.
       *
       * Mitigation: repeat both broadcasts several times, spaced out, so
       * each attempt sees a different arrival-time pattern — a device
       * that lost the race on attempt 1 has 3 more independent chances.
       * Harmless to repeat: a device that already answered just resends
       * the same data, overwriting its own (identical) prior entry. This
       * doesn't help a device that genuinely doesn't implement PGN 126996
       * at all — no amount of retrying fixes that, it's a real limitation
       * of that specific device, not a bug here. */
      const DISCOVER_ATTEMPTS = 4;
      const ATTEMPT_SPACING_MS = 400;
      for (let i = 0; i < DISCOVER_ATTEMPTS; i++) {
        setTimeout(() => txQueue.push(cfgFrame(P.DISCOVER_DEVICES, [])), i * ATTEMPT_SPACING_MS);
      }
      const productInfoStart = (DISCOVER_ATTEMPTS - 1) * ATTEMPT_SPACING_MS + 1500;
      for (let i = 0; i < DISCOVER_ATTEMPTS; i++) {
        setTimeout(() => txQueue.push(cfgFrame(P.REQUEST_PRODUCT_INFO, [])), productInfoStart + i * ATTEMPT_SPACING_MS);
      }
      break;
    }
    case 'ow_rescan':
      /* Re-run the 1-Wire ROM search on the STM32 (see
       * onewire_request_rescan() in onewire.c). Results come back
       * asynchronously as an 'onewireRoms' broadcast once the scan
       * completes — see handleDiagFrame()'s ONEWIRE_ROM_REPORT_CAN_ID
       * handling above. Used by config-server.js's sensor-binding UI so
       * the user can see what's actually on the bus right now (e.g. to
       * identify a newly-swapped-in replacement sensor's ROM). */
      txQueue.push(cfgFrame(P.OW_RESCAN, []));
      break;
    default:
      console.warn('[LocalBus] unknown command type:', msg.type);
  }
}

function setupLocalBus() {
  const wss = new WebSocket.Server({ host: '127.0.0.1', port: LOCAL_BUS_PORT });
  const clients = new Set();

  wss.on('connection', (sock) => {
    clients.add(sock);
    console.log(`[LocalBus] client connected (${clients.size} total)`);
    sock.on('close', () => {
      clients.delete(sock);
      console.log(`[LocalBus] client disconnected (${clients.size} total)`);
    });
    sock.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (e) {
        console.warn('[LocalBus] malformed message:', e.message);
        return;
      }
      handleLocalBusCommand(msg);
    });
    sock.on('error', (e) => console.warn('[LocalBus] client socket error:', e.message));
  });

  wss.on('error', (err) => {
    console.error('[LocalBus] server error:', err.message,
      '— alarm-server.js/bus-monitor-server.js will not receive events until this is fixed');
  });

  _localBusBroadcast = (obj) => {
    if (clients.size === 0) return;
    const line = JSON.stringify(obj);
    for (const sock of clients) {
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(line);
      }
    }
  };

  console.log(`[LocalBus] listening on ws://127.0.0.1:${LOCAL_BUS_PORT}`);
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

/* engineInstNum()/tempSourcePath() (hand-rolled instance-numbering and
 * temperature-category path helpers) removed — handleParsedPgn() now
 * uses @signalk/n2k-signalk's toDelta(), which does the same job more
 * completely (skEngineId(), temperatureMappings.js) and, importantly,
 * follows real Signal K schema conventions ours didn't quite match (e.g.
 * environment.inside.<index>.temperature, the zoneObject pattern —
 * ours produced environment.inside.temperature.instanceN, a path no
 * standard Signal K client would recognize). See the comment above the
 * toDelta() call below. */

/*
 * decoder.on('pgn', handleParsedPgn) is a persistent, module-level
 * listener — canboatjs invokes it with whatever it puts in `parsed`, not
 * with extra args we choose, so a call-specific `src` can't be threaded
 * in as a second parameter the way a one-shot callback could. Since
 * `.parse()` is synchronous (canboatjs emits 'pgn' before returning, not
 * via setImmediate/a promise), tracking "the src of whatever frame we're
 * currently parsing" in a module-level var set immediately before each
 * .parse() call is safe on Node's single-threaded event loop — no two
 * parses can be in flight at once. Prefer parsed.src if canboatjs does
 * happen to include it (more directly correct if present) and fall back
 * to this otherwise; verify against the actual installed library once
 * `npm install` has run, this couldn't be confirmed without node_modules
 * present.
 */
let _lastFrameSrc = 0;

/* Local event bus (127.0.0.1:LOCAL_BUS_PORT) — see setupLocalBus() below.
 * Assigned once the WS server is created; broadcastLocalBus() is a no-op
 * until then (harmless during the brief startup window). */
let _localBusBroadcast = () => {};

/* ------------------------------------------------------------------ */
/* Alert catalog — real (alertSystem, alertSubSystem, alertId) values  */
/* as actually seen on the bus, paired with whatever text PGN 126985   */
/* carries for that alertId. These are manufacturer-assigned raw       */
/* numbers with no public lookup table — confirmed by checking          */
/* @signalk/n2k-signalk's own 126983.js/126985.js handlers, which use   */
/* them as raw numbers too, no enum resolution. Rather than needing the */
/* paid NMEA appendix, this builds a real, ground-truth catalog from    */
/* actual usage over time, which the Alarm page's dropdowns can be      */
/* populated from later (see alarm-server.js's GET /api/alert-catalog). */
/* ------------------------------------------------------------------ */
const ALERT_CATALOG_FILE = '/etc/sensor_n2k/alert-catalog.json';

let alertCatalog = {};
try {
  alertCatalog = JSON.parse(fs.readFileSync(ALERT_CATALOG_FILE, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') console.warn('[ALERT] failed to read', ALERT_CATALOG_FILE, '—', e.message);
}

let alertCatalogSaveTimer = null;
function saveAlertCatalog() {
  clearTimeout(alertCatalogSaveTimer);
  alertCatalogSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(ALERT_CATALOG_FILE), { recursive: true });
      fs.writeFileSync(ALERT_CATALOG_FILE, JSON.stringify(alertCatalog, null, 2));
    } catch (e) {
      console.warn('[ALERT] failed to save', ALERT_CATALOG_FILE, '—', e.message);
    }
  }, 1000);
}

/* PGN 126985 (Alert Text) and 126983 (the alert itself — system/
 * subSystem/id, but no text) can arrive in either order or independently
 * — whichever shows up first for a given alertId is cached here so the
 * catalog entry gets completed once both have been seen at least once. */
const pendingAlertText = new Map();

function logAlertPgn(parsed) {
  const pgn = parsed.pgn;
  const fields = parsed.fields || {};

  if (pgn === 126985) {
    const alertId = fields.alertId;
    if (alertId == null) return;
    pendingAlertText.set(alertId, {
      textDescription: fields.alertTextDescription || '',
      locationTextDescription: fields.alertLocationTextDescription || '',
    });
    return;
  }

  if (pgn !== 126983) return;
  const { alertType, alertCategory, alertSystem, alertSubSystem, alertId } = fields;
  if (alertSystem == null || alertId == null) return;

  const key = `${alertSystem}:${alertSubSystem ?? '?'}:${alertId}`;
  const text = pendingAlertText.get(alertId);
  const now = new Date().toISOString();
  /* prev is read-only from here on — entry is always a fresh object, not
   * prev mutated in place. `const entry = prev || {...}` would alias the
   * SAME object when prev exists, making prev.x !== entry.x compare a
   * property against itself post-mutation (always false) — confirmed
   * with a standalone repro before writing it this way; that bug would
   * have silently stopped persisting any update to an already-seen
   * alert (e.g. text arriving after the alert's first sighting). */
  const prev = alertCatalog[key];
  const entry = {
    alertSystem, alertSubSystem: alertSubSystem ?? null, alertId,
    alertType: alertType ?? (prev ? prev.alertType : null),
    alertCategory: alertCategory ?? (prev ? prev.alertCategory : null),
    textDescription: (text && text.textDescription) || (prev ? prev.textDescription : null),
    locationTextDescription: (text && text.locationTextDescription) || (prev ? prev.locationTextDescription : null),
    firstSeen: prev ? prev.firstSeen : now,
    lastSeen: now,
    count: (prev ? prev.count : 0) + 1,
  };

  /* Only save when something identity-relevant changed (new entry, or
   * text/type/category learned) — not on every single re-occurrence.
   * `count`/`lastSeen` update in memory regardless, so a live query
   * always has the true count, but the on-disk copy can lag behind it
   * slightly between saves; that's fine, count is a "how often" bonus
   * stat, not the point of this catalog (the identity→text mapping is,
   * and that's always persisted the moment it's learned). Deliberately
   * avoids a flash write on every occurrence of a frequently-repeating
   * alert. */
  const changed = !prev
    || prev.textDescription !== entry.textDescription
    || prev.alertType !== entry.alertType
    || prev.alertCategory !== entry.alertCategory;
  alertCatalog[key] = entry;
  if (changed) {
    console.log('[ALERT]', prev ? 'updated' : 'new', 'catalog entry:', key, entry.textDescription || '(no text yet)');
    saveAlertCatalog();
  }
}

/* Central handler for all decoded PGN events — called from both the main
 * canboatjs decoder (single-frame PGNs) and the fast-packet dispatcher. */
function handleParsedPgn(parsed) {
  console.log('[N2K] pgn event:', parsed.pgn, JSON.stringify(parsed.fields).substring(0, 80));
  const pgn    = parsed.pgn;
  const fields = parsed.fields || {};
  const ts     = new Date().toISOString();
  const src    = (parsed.src !== undefined) ? parsed.src : _lastFrameSrc;

  /* Broadcast every decoded PGN on the local bus — not just the curated
   * subset mapped to Signal K paths below (still not exhaustive; see that
   * section's own comment). alarm-server.js and bus-monitor-server.js
   * both need the full stream regardless. */
  _localBusBroadcast({ type: 'pgn', ts, src, pgn, fields });

  if (pgn === 126983 || pgn === 126985) {
    logAlertPgn(parsed);
  }

  /* PGN → Signal K conversion via @signalk/n2k-signalk's real N2kMapper
   * (the same one signalk-server itself uses), not hand-rolled per-PGN
   * logic — verified directly against the installed package: toDelta()
   * takes exactly the {prio, pgn, dst, src, timestamp, fields,
   * description} shape FromPgn emits (confirmed with a real parse, not
   * just reading its README), and its coverage (240 PGN handler files)
   * is both far broader and more standards-correct than what this file
   * used to hand-roll — e.g. its temperature-category paths follow the
   * real Signal K zoneObject schema (environment.inside.<index>.
   * temperature) where ours invented a non-standard convention
   * (environment.inside.temperature.instanceN). Requires
   * @signalk/signalk-schema installed alongside it — not in n2k-signalk's
   * own declared dependencies but required transitively by its AIS
   * ship-type module, which the whole PGN index eagerly loads even for
   * PGNs that aren't AIS. */
  let delta;
  try {
    delta = n2kMapper.toDelta({ ...parsed, src });
  } catch (e) {
    console.error('[N2K] n2kMapper.toDelta() error for PGN', pgn, ':', e.message);
    return;
  }
  if (!delta || !delta.updates || delta.updates.length === 0) return;

  /* Drop propulsion fault notifications this device can't actually vouch
   * for — see isBlockedNotification()'s comment above loadSensorConfig(). */
  delta.updates = delta.updates
    .map(u => ({ ...u, values: (u.values || []).filter(v => !isBlockedNotification(v.path)) }))
    .filter(u => u.values.length > 0);
  if (delta.updates.length === 0) return;

  sendDelta({ context: 'vessels.self', ...delta });
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

/* A continuation frame that never arrives (SPI bridge / RX overrun during
 * a burst of near-simultaneous responses — see the 'discover' case in
 * dispatchLocalMsg() for when this is most likely) leaves its entry here
 * forever otherwise: nothing ever deletes it, since deletion only happens
 * on successful completion above. Sweep out anything that's sat
 * incomplete for more than a couple seconds — real fast-packet sequences
 * complete in tens of milliseconds, so this only ever catches genuinely
 * abandoned ones, never a slow-but-still-arriving one. */
const FP_ASSEMBLY_MAX_AGE_MS = 2000;
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of fpAssembly) {
    if (now - entry.startedAt > FP_ASSEMBLY_MAX_AGE_MS) {
      fpAssembly.delete(key);
    }
  }
}, FP_ASSEMBLY_MAX_AGE_MS).unref();

function handleFpFrame(key, frame, pgn, src, prio) {
  const d  = frame.data;
  const fn = d[0] & 0x1F;

  if (fn === 0) {
    /* Start a new assembly, replacing any stale entry with the same key */
    fpAssembly.set(key, { prio, frames: [frame], total: d[1], startedAt: Date.now() });
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
      _lastFrameSrc = src;   /* see the comment above handleParsedPgn() */
      fp.parse(`${ts},${prio},${pgn},${src},255,${f.data.length},${hex}`);
    } catch (e) {
      console.error('[FP] decode error PGN', pgn, ':', e.message);
    }
  });
}

/* Fixed diagnostic/event CAN IDs from spi_bridge.c / alarm_io.c — same
 * proprietary 0x1EFFFEXX family as the sensor-config frames
 * (SENSOR_CFG_CAN_ID_BASE), but these three are plain fixed IDs, not part
 * of that param range, so they don't go through inject_block()'s
 * intercept on the Zephyr side — they're just frames that happen to use
 * IDs no real N2K PGN would ever use. Must be handled here, before
 * canIdToPgn()/decoder.parse(), since they aren't real PGNs at all and
 * would otherwise be silently mis-decoded (or ignored) by the generic path.
 */
const DIAG_CAN_ID      = 0x1EFFFEF;
const DIAG2_CAN_ID     = 0x1EFFFEE;
const ALARM_BTN_CAN_ID = 0x1EFFFED;
const ONEWIRE_ROM_REPORT_CAN_ID = 0x1EFFFEC;
const ONEWIRE_TEMP_SENTINEL     = 0xFE;

/* Collects a 1-Wire ROM-search report: a marker frame (data[0]=0xFF,
 * data[1]=count) followed by, for each of the `count` sensors found, TWO
 * frames back to back — an 8-byte big-endian ROM ID frame (data[0] is the
 * DS18B20 family code, 0x28) then a TEMP frame (data[0]=0xFE, data[1]=
 * valid flag, data[2..3]=signed 16-bit LE centi-degrees C) carrying a
 * live reading taken during that same scan — see ONEWIRE_ROM_REPORT_CAN_ID
 * in onewire.c for the firmware side of this. A fresh marker always
 * restarts collection (rather than requiring the previous report to have
 * completed cleanly), so a frame dropped mid-burst on the Zephyr side
 * (spi_bridge_enqueue() can silently drop under load — see
 * spi_bridge_drop_count()) just means this report is discarded, not a
 * permanently wedged collector. */
let _owReport = { expecting: 0, roms: [], pendingRom: null };

/* Bilge pump monitor report — see BILGE_REPORT_CAN_ID in bilge.c for the
 * wire format (4 frames per channel: state, last-1h, last-24h, last-7d). */
const BILGE_REPORT_CAN_ID = 0x1EFFFEB;
const BILGE_REC_STATE = 0xB0;
const BILGE_REC_1H    = 0xB1;
const BILGE_REC_24H   = 0xB2;
const BILGE_REC_7D    = 0xB3;
let _bilgeStats = [0, 1, 2, 3].map(() => ({
  state: 0, cycles_1h: 0, on_s_1h: 0, cycles_24h: 0, on_s_24h: 0, cycles_7d: 0, on_s_7d: 0,
}));

function handleDiagFrame(frame) {
  const d = frame.data;

  if (frame.id === DIAG_CAN_ID) {
    const canState  = d[1] & 0x7F;             /* low 3 bits actually used */
    const saConfirmed = !!(d[1] & 0x80);        /* see n2k_sa_confirmed() */
    const claimedSA = d[2];
    const uptimeS   = d[3] | (d[4] << 8);
    const rxFrameCount = d[5] | (d[6] << 8);
    const dropCount = d[7];

    _localBusBroadcast({
      type: 'busstate', canState, claimedSA, saConfirmed, uptimeS, rxFrameCount, dropCount,
    });
    return true;
  }

  if (frame.id === DIAG2_CAN_ID) {
    _localBusBroadcast({
      type: 'busstate', txErrCnt: d[1], rxErrCnt: d[2], canState: d[3],
    });
    return true;
  }

  if (frame.id === ALARM_BTN_CAN_ID) {
    console.log('[ALARM] cancel-button event received');
    _localBusBroadcast({ type: 'button' });
    return true;
  }

  if (frame.id === ONEWIRE_ROM_REPORT_CAN_ID) {
    if (d[0] === 0xFF) {
      _owReport = { expecting: d[1], roms: [], pendingRom: null };
      if (_owReport.expecting === 0) {
        _localBusBroadcast({ type: 'onewireRoms', roms: [] });
      }
      return true;
    }
    if (d[0] === ONEWIRE_TEMP_SENTINEL) {
      /* Pairs with the ROM frame collected just before it — see the
       * wire-format comment on _owReport above. A TEMP frame with no
       * pending ROM (protocol desync from a dropped frame) is discarded;
       * the next marker frame resets collection cleanly regardless. */
      if (_owReport.pendingRom !== null) {
        const valid = d[1] === 1;
        _owReport.roms.push({
          rom: _owReport.pendingRom,
          tempC: valid ? d.readInt16LE(2) / 100 : null,
          valid,
        });
        _owReport.pendingRom = null;
        _owReport.expecting--;
        if (_owReport.expecting === 0) {
          _localBusBroadcast({ type: 'onewireRoms', roms: _owReport.roms });
        }
      }
      return true;
    }
    if (_owReport.expecting > 0) {
      _owReport.pendingRom = Buffer.from(d.slice(0, 8)).toString('hex');
    }
    return true;
  }

  if (frame.id === BILGE_REPORT_CAN_ID) {
    const chan = d[0];
    const rec  = d[1];
    if (chan < _bilgeStats.length) {
      const st = _bilgeStats[chan];
      if (rec === BILGE_REC_STATE) {
        st.state = d[2];
      } else if (rec === BILGE_REC_1H) {
        st.cycles_1h = d.readUInt16LE(2);
        st.on_s_1h   = d.readUInt32LE(4);
      } else if (rec === BILGE_REC_24H) {
        st.cycles_24h = d.readUInt16LE(2);
        st.on_s_24h   = d.readUInt32LE(4);
      } else if (rec === BILGE_REC_7D) {
        st.cycles_7d = d.readUInt16LE(2);
        st.on_s_7d   = d.readUInt32LE(4);
      }
      /* No marker/count frame like the 1-Wire ROM report uses — the 4
       * record types per channel just stream in as bilge.c's report
       * thread builds them, a few ms apart. Broadcasting after every
       * single frame (rather than waiting for a "complete" set) means
       * consumers always see the latest known value per field with no
       * extra bookkeeping here; the four fields converge to a fresh
       * snapshot within the same report cycle regardless. */
      _localBusBroadcast({ type: 'bilge', channels: _bilgeStats });
    }
    return true;
  }

  return false;
}

function handleFrame(frame) {
  if (!frame.ext) return;
  if (handleDiagFrame(frame)) return;

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
  setupLocalBus();

  refreshNotificationAllowList();

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
        refreshNotificationAllowList();
        /* Any config save is a reasonable moment to also refresh the
         * 1-Wire ROM search: a sensor plugged in after boot only gets
         * picked up by resolve_slave_index() once do_scan() has run
         * again (see onewire.c's header comment on binding-by-ROM) —
         * without this, binding a slot to a just-plugged-in sensor's ROM
         * only actually starts working after a reboot, because that's
         * the only other time do_scan() otherwise runs. Piggybacking on
         * every save (not just the dedicated Rescan button) means the
         * common "plug in sensor, bind it, Save & Apply" flow just works
         * without an extra manual step. */
        txQueue.push(cfgFrame(P.OW_RESCAN, []));
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
   * producer can't turn one trigger into an unbounded tight loop.
   *
   * _drainActive serializes this against itself: drainLoop() is invoked
   * from multiple independent trigger sources (every gpiomon RDY rising
   * edge, plus the periodic backstop timer), and RDY fires constantly
   * during normal telemetry — so without this guard, two invocations
   * routinely overlap. doTransferOnce()'s _inFlight check stops them from
   * launching concurrent physical transfers, but each overlapping
   * invocation still burns through its OWN MAX_DRAIN_ITERS budget on
   * instant no-op skips (a skipped iteration returns immediately, doesn't
   * drain anything, and isn't retried by that invocation) — so the loser
   * can exhaust all 20 iterations without transferring a single real
   * block, and gives up while txQueue still has a large backlog (e.g. a
   * multi-block config push). Confirmed via RTT: only ever the *first*
   * 15-frame block of a 51-frame config push actually reached
   * sensor_config_update() on the Zephyr side, no matter how many
   * transfers bridge.js's own bookkeeping believed it completed. With
   * only one drainLoop "session" running at a time, a concurrent trigger
   * arriving mid-drain is just a no-op — the active session's own loop
   * already keeps going until txQueue is empty (or its 20-iteration cap),
   * so nothing is lost by skipping the redundant call. */
  let _drainActive = false;
  const drainLoop = async (source) => {
    if (_drainActive) return;
    _drainActive = true;
    try {
      for (let i = 0; i < MAX_DRAIN_ITERS; i++) {
        if (i > 0 && txQueue.length > 0) {
          /* Confirmed via RTT + SPI-level tracing: back-to-back transfers
           * with no gap get a *successful* Linux-side ioctl but garbage
           * RX content (magic=0xFF, count=255 — MISO floating), meaning
           * Zephyr's bridge_thread hadn't looped back to a re-armed
           * spi_transceive() yet. Needed *in addition to* the
           * single-session guard above, not instead of it — the earlier
           * attempt at pacing alone failed only because a second,
           * unguarded drainLoop() was sneaking real transfers into the
           * gap. Scoped to txQueue.length>0 (a real outbound backlog —
           * the confirmed/reproduced scenario, e.g. a multi-block config
           * push) rather than every continuation, so a `full` RX-only
           * streak (heavy incoming bus traffic, nothing queued to send)
           * isn't throttled to ~1 block/150ms for a problem that was
           * never demonstrated on that path. */
          await new Promise((resolve) => setTimeout(resolve, SPI_DRAIN_PACING_MS));
        }
        const full = await doTransferOnce();
        if (!full && txQueue.length === 0) break;
      }
    } finally {
      _drainActive = false;
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
