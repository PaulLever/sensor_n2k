#!/usr/bin/env node
'use strict';

/*
 * spi-can-daemon.js  –  SPI block protocol ↔ SocketCAN (vcan0) bridge
 *
 * This daemon owns the raw SPI link to the Zephyr STM32.  It:
 *   1. Creates the vcan0 virtual CAN interface (if not already present).
 *   2. Reads 256-byte blocks from /dev/spidev0.0, extracts CAN frames,
 *      and injects them into vcan0 so canboatjs / bridge.js can read them
 *      with a normal CanSocket.
 *   3. Reads CAN frames injected into vcan0 by bridge.js (Signal K → N2K)
 *      and sends them to Zephyr in the next SPI TX block so the STM32
 *      forwards them to the physical NMEA 2000 bus via FDCAN1.
 *   4. Monitors the RDY GPIO from the STM32 and triggers a transfer
 *      whenever the STM32 asserts it (has sensor data ready).
 *
 * Run as root:
 *   sudo node spi-can-daemon.js [spidev] [rdyGpio] [canIf]
 *
 * Defaults:
 *   spidev   /dev/spidev0.0
 *   rdyGpio  70    (gpiochip1 line 70)
 *   canIf    vcan0
 *
 * Dependencies:  npm install  spi-device  onoff  socketcan
 */

const { execSync, execFileSync } = require('child_process');
const spiLib  = require('spi-device');
const { Gpio } = require('onoff');
const can      = require('socketcan');

const SPI_DEV  = process.argv[2] || '/dev/spidev0.0';
const RDY_GPIO = parseInt(process.argv[3] || '70', 10);
const CAN_IF   = process.argv[4] || 'vcan0';
const SPI_HZ   = 1_000_000;

/* ------------------------------------------------------------------ */
/* Block protocol (must match spi_bridge.c)                            */
/* ------------------------------------------------------------------ */

const BLOCK_SIZE        = 256;
const BLOCK_MAGIC       = 0xA5;
const BLOCK_VERSION     = 0x03;
const BLOCK_HEADER_SIZE = 16;
const BLOCK_MAX_FRAMES  = 15;
const BLOCK_RECORD_SIZE = 16;
const RECORD_IDE_FLAG   = 0x80000000;

function crc16ccitt(buf, offset, length) {
  let crc = 0xFFFF;
  for (let i = offset; i < offset + length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

/* ------------------------------------------------------------------ */
/* TX queue (CAN frames from vcan0 → destined for Zephyr SPI TX block) */
/* ------------------------------------------------------------------ */

const txQueue = [];
const TX_QUEUE_MAX = 128;

function enqueueTx(frame) {
  if (txQueue.length >= TX_QUEUE_MAX) {
    console.warn('[SPI-DAEMON] TX queue full, dropping frame');
    return;
  }
  txQueue.push(frame);
}

/* ------------------------------------------------------------------ */
/* Block build / parse                                                  */
/* ------------------------------------------------------------------ */

function buildTxBlock() {
  const block = Buffer.alloc(BLOCK_SIZE, 0xFF);
  block[0] = BLOCK_MAGIC;
  block[1] = BLOCK_VERSION;

  const count = Math.min(txQueue.length, BLOCK_MAX_FRAMES);
  block[4] = count;

  for (let i = 0; i < count; i++) {
    const frame  = txQueue.shift();
    const off    = BLOCK_HEADER_SIZE + i * BLOCK_RECORD_SIZE;
    let   idWord = frame.id & 0x1FFFFFFF;
    if (frame.ext) idWord = (idWord | RECORD_IDE_FLAG) >>> 0;
    block.writeUInt32LE(idWord, off);
    block[off + 4] = frame.data.length;
    frame.data.copy(block, off + 5, 0, 8);
  }

  const crc = crc16ccitt(block, 4, BLOCK_SIZE - 4);
  block.writeUInt16LE(crc, 2);
  return block;
}

function parseRxBlock(block) {
  if (block[0] !== BLOCK_MAGIC || block[1] !== BLOCK_VERSION) return [];

  const rxCrc   = block.readUInt16LE(2);
  const calcCrc = crc16ccitt(block, 4, BLOCK_SIZE - 4);
  if (rxCrc !== calcCrc) {
    console.warn(`[SPI-DAEMON] CRC error: calc=0x${calcCrc.toString(16)} expected=0x${rxCrc.toString(16)}`);
    return [];
  }

  const count  = Math.min(block[4], BLOCK_MAX_FRAMES);
  const frames = [];
  for (let i = 0; i < count; i++) {
    const off    = BLOCK_HEADER_SIZE + i * BLOCK_RECORD_SIZE;
    const idWord = block.readUInt32LE(off) >>> 0;
    const dlc    = Math.min(block[off + 4], 8);
    frames.push({
      id:  idWord & 0x1FFFFFFF,
      ext: !!(idWord & RECORD_IDE_FLAG),
      rtr: false,
      data: Buffer.from(block.slice(off + 5, off + 5 + dlc)),
    });
  }
  return frames;
}

/* ------------------------------------------------------------------ */
/* vcan0 setup                                                          */
/* ------------------------------------------------------------------ */

function ensureVcan(ifname) {
  try { execFileSync('modprobe', ['vcan'], { stdio: 'ignore' }); } catch (_) {}
  try {
    execFileSync('ip', ['link', 'add', 'dev', ifname, 'type', 'vcan'],
      { stdio: 'ignore' });
  } catch (_) { /* already exists */ }
  execFileSync('ip', ['link', 'set', 'up', ifname]);
  console.log(`[VCAN] ${ifname} up`);
}

/* ------------------------------------------------------------------ */
/* Main                                                                 */
/* ------------------------------------------------------------------ */

async function openSpi(dev) {
  const [bus, addr] = dev.match(/spidev(\d+)\.(\d+)/).slice(1).map(Number);
  return new Promise((resolve, reject) => {
    const s = spiLib.open(bus, addr, { maxSpeedHz: SPI_HZ, mode: spiLib.MODE0 },
      err => err ? reject(err) : resolve(s));
  });
}

async function transfer(spiDev, txBuf) {
  return new Promise((resolve, reject) => {
    const rxBuf = Buffer.alloc(BLOCK_SIZE);
    spiDev.transfer(
      [{ sendBuffer: txBuf, receiveBuffer: rxBuf, byteLength: BLOCK_SIZE }],
      err => err ? reject(err) : resolve(rxBuf));
  });
}

async function run() {
  ensureVcan(CAN_IF);

  console.log(`[SPI-DAEMON] Opening ${SPI_DEV}`);
  const spiDev = await openSpi(SPI_DEV);

  /* SocketCAN channel for vcan0 — raw, no timestamps */
  const channel = can.createRawChannel(CAN_IF, true);

  /* CAN frames written to vcan0 by bridge.js → queue for SPI TX */
  channel.addListener('onMessage', (msg) => {
    enqueueTx({ id: msg.id, ext: !!(msg.id & 0x80000000), data: msg.data || Buffer.alloc(0) });
  });
  channel.start();

  const doTransfer = async () => {
    const txBuf = buildTxBlock();
    try {
      const rxBuf  = await transfer(spiDev, txBuf);
      const frames = parseRxBlock(rxBuf);
      for (const frame of frames) {
        /* Inject into vcan0 so canboatjs / bridge.js can read them */
        channel.send({
          id:   frame.ext ? (frame.id | 0x80000000) : frame.id,
          data: frame.data,
        });
      }
    } catch (err) {
      console.error('[SPI-DAEMON] Transfer error:', err.message);
    }
  };

  /* RDY rising edge from STM32 → transfer immediately */
  const rdy = new Gpio(RDY_GPIO, 'in', 'rising', { debounceTimeout: 0 });
  rdy.watch((err) => {
    if (err) { console.error('[RDY] GPIO error:', err); return; }
    doTransfer();
  });

  /* Periodic poll: drain any frames queued from bridge.js (SK → Zephyr) */
  setInterval(() => {
    if (txQueue.length > 0) doTransfer();
  }, 50);

  console.log(`[SPI-DAEMON] Running: ${SPI_DEV} ↔ ${CAN_IF}`);
}

run().catch(err => { console.error('Fatal:', err); process.exit(1); });
