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
 * Usage (run as root for SPI + GPIO access):
 *   sudo node bridge.js [spidev] [rdyGpio] [skHost] [skPort]
 *
 * Defaults:
 *   spidev    /dev/spidev0.0
 *   rdyGpio   70    (gpiochip1 line 70 — RDY output from STM32)
 *   skHost    localhost
 *   skPort    3000
 *
 * Dependencies:  npm install  spi-device  onoff  @canboat/canboatjs  ws
 */

const spiLib  = require('spi-device');
const { FromPgn } = require('@canboat/canboatjs');
const WebSocket   = require('ws');

const SPI_DEV = process.argv[2] || '/dev/spidev0.0';
const SK_HOST = process.argv[3] || 'localhost';
const SK_PORT = parseInt(process.argv[4] || '3000', 10);
const SPI_HZ  = 1_000_000;
const POLL_MS = 50;   /* poll interval — adequate for 1 Hz sensor data */

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

function parseRxBlock(block) {
  _transferCount++;

  if (_transferCount <= 5 || _transferCount % 20 === 0) {
    console.log(`[SPI] block #${_transferCount} magic=0x${block[0].toString(16)} ver=0x${block[1].toString(16)} count=${block[2]}`);
    console.log(`[SPI]  hdr[0..7]:   ${block.slice(0, 8).toString('hex')}`);
    console.log(`[SPI]  tail[248..]: ${block.slice(248).toString('hex')}`);
  }

  if (block[0] !== BLOCK_MAGIC || block[1] !== BLOCK_VERSION) return [];

  const rxCrc   = block[CRC_OFFSET] | (block[CRC_OFFSET + 1] << 8);
  const calcCrc = crc16(block, CRC_OFFSET);
  if (rxCrc !== calcCrc) {
    console.warn(`[SPI] CRC mismatch: calc=0x${calcCrc.toString(16)} expected=0x${rxCrc.toString(16)} — processing anyway`);
  }

  const count = Math.min(block[2], BLOCK_MAX_FRAMES);
  if (count > 0) console.log(`[SPI] ${count} frame(s) in block`);

  const frames = [];
  for (let i = 0; i < count; i++) {
    const off    = RECORDS_OFFSET + i * RECORD_SIZE;
    const idWord = block.readUInt32LE(off) >>> 0;
    const dlc    = Math.min(block[off + 4], 8);
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

function connectSK() {
  const url = `ws://${SK_HOST}:${SK_PORT}/signalk/v1/stream?subscribe=none`;
  ws = new WebSocket(url);
  ws.on('open', () => {
    console.log(`[SK] Connected to ${url}`);
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
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(msg);
  else wsPending.push(msg);
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

decoder.on('pgn', (parsed) => {
  console.log('[N2K] pgn event:', parsed.pgn, JSON.stringify(parsed.fields).substring(0, 80));
  const pgn    = parsed.pgn;
  const fields = parsed.fields || {};
  const ts     = new Date().toISOString();
  const values = [];

  if (pgn === 130316 || pgn === 130312) {
    /* canboatjs v3 uses camelCase field names and numeric source codes */
    const source   = fields.source;
    const instance = fields.instance !== undefined ? fields.instance : (fields.sid || 0);
    const tempK    = fields.temperature;   /* Kelvin */
    if (tempK == null) return;
    const tempC = tempK - 273.15;

    let path;
    /* source is a number (14=EGT, 2=Inside, 3=EngineRoom, 1=Outside) */
    if      (source === 14 || source === 'Exhaust Gas Temperature')  path = `propulsion.${instance}.exhaustTemperature`;
    else if (source === 2  || source === 'Inside Temperature')        path = `environment.inside.temperature`;
    else if (source === 3  || source === 'Engine Room Temperature')   path = `environment.engineRoom.temperature`;
    else if (source === 1  || source === 'Outside Temperature')       path = `environment.outside.temperature`;
    else                                                               path = `environment.temperature.instance${source}`;

    values.push({ path, value: tempC });
    console.log(`[N2K] PGN ${pgn} (${source}): ${tempC.toFixed(2)} °C → ${path}`);
  }

  if (pgn === 127489) {
    const inst = fields['Engine Instance'];
    if (fields['Oil Pressure']       != null) values.push({ path: `propulsion.${inst}.oilPressure`,        value: fields['Oil Pressure'] });
    if (fields['Oil Temperature']    != null) values.push({ path: `propulsion.${inst}.oilTemperature`,     value: fields['Oil Temperature'] - 273.15 });
    if (fields['Engine Temperature'] != null) values.push({ path: `propulsion.${inst}.coolantTemperature`, value: fields['Engine Temperature'] - 273.15 });
  }

  if (pgn === 128259 && fields['Speed Water Referenced'] != null) {
    values.push({ path: 'navigation.speedThroughWater', value: fields['Speed Water Referenced'] });
  }

  if (values.length === 0) return;

  sendDelta({
    context: 'vessels.self',
    updates: [{ source: { label: 'n2k-bridge', type: 'NMEA2000' }, timestamp: ts, values }],
  });
});

function handleFrame(frame) {
  if (!frame.ext) return;

  const pgn  = canIdToPgn(frame.id);
  const src  = frame.id & 0xFF;
  const prio = (frame.id >> 26) & 0x7;
  const ts   = new Date().toISOString();
  const hex  = Array.from(frame.data).map(b => b.toString(16).padStart(2, '0')).join(',');

  /* canboatjs v3.x: parse() fires the 'pgn' event synchronously */
  const line = `${ts},${prio},${pgn},${src},255,${frame.data.length},${hex}`;
  try {
    decoder.parse(line);
  } catch (e) {
    console.error('[N2K] parse error:', e.message, 'line:', line);
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

async function run() {
  console.log(`[SPI] Opening ${SPI_DEV} at ${SPI_HZ} Hz`);
  const spiDev = await openSpi(SPI_DEV);

  connectSK();

  const doTransfer = async () => {
    try {
      const rxBuf = await transfer(spiDev, buildTxBlock());
      parseRxBlock(rxBuf).forEach(handleFrame);
    } catch (err) {
      console.error('[SPI] Transfer error:', err.message);
    }
  };

  /* Poll at fixed interval — no sysfs GPIO required */
  setInterval(doTransfer, POLL_MS);

  console.log(`[bridge] Polling ${SPI_DEV} every ${POLL_MS} ms`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
