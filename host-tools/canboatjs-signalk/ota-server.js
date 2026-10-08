#!/usr/bin/env node
'use strict';

/*
 * ota-server.js — remote updates for both processors, port 3006.
 *
 * Until now every change to this board needed physical presence: SCP +
 * `systemctl restart` for the Linux services, and for the Zephyr side a
 * hand-typed OpenOCD command over SSH (docs/N2K-INSTALL-UNOQ.md §6e). This
 * automates both, from a browser, over the boat's own network.
 *
 * TWO UPDATE PATHS, deliberately independent:
 *
 *   1. Linux app update — upload a tarball of host-tools/, back the
 *      current tree up to a timestamped .bak, extract, npm install if
 *      package.json changed, restart the affected units. Reversible: the
 *      .bak directories are kept (last BACKUP_KEEP of them) and "Restore
 *      previous" swaps one back in.
 *
 *   2. Zephyr firmware update — upload a zephyr.bin, dump the currently
 *      running image to a timestamped backup first, then run the exact
 *      same OpenOCD sequence the install doc already documents (quoted
 *      verbatim in buildFlashScript() below — this is automation of a
 *      known-good procedure, not a new one), then watch bus-monitor's
 *      /api/bus to see whether the new image actually came back up.
 *
 * WHAT THIS IS NOT: an MCUboot A/B fail-safe. There is no automatic
 * rollback of firmware. The device tree already reserves slot0/slot1
 * partitions for a future MCUboot conversion, and that is the natural v2
 * — but today, a firmware image that flashes and verifies cleanly and is
 * then logically broken still needs manual SWD recovery with a laptop.
 * The post-flash /api/bus poll below can *detect* that case and say so
 * loudly; it cannot fix it. Read docs/OTA-UPDATE.md before relying on
 * this at sea.
 *
 * *** ONE-TIME DEVICE PREP REQUIRED — /etc/sudoers.d/sensor-n2k-ota ***
 * Firmware flashing shells out through `sudo -n` to a single fixed
 * wrapper script (FLASH_SCRIPT below). This board's sudo is NOT
 * passwordless, so without a scoped sudoers rule naming exactly that
 * script, every firmware update dies with "sudo: a password is required"
 * — which this service can never answer.
 *
 * The rule is a no-op while the unit ships with User=root (root's sudo
 * needs no rule), and that is exactly why it is easy to skip and then be
 * bitten by later: it becomes load-bearing the moment anyone runs this
 * service as `arduino`, or copies this setup to a board where the unit
 * was de-privileged. Install it on every board, and NEVER widen it to
 * `NOPASSWD: ALL`. Full text + verification steps in
 * sensor-n2k-ota.service's comment block and docs/OTA-UPDATE.md.
 *
 * The Linux app-update path does not use sudo at all.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { SHARED_STYLE, navHtml } = require('./shared-ui');

const PORT = 3006;
const CONFIG_DIR = '/etc/sensor_n2k';
const VERSION_FILE = path.join(CONFIG_DIR, 'host-tools-version.json');

/* Deployment root on the device — matches WorkingDirectory/ExecStart in
 * every host-tools/systemd/*.service unit. */
const INSTALL_ROOT = '/opt/sensor_n2k';
const HOST_TOOLS_DIR = path.join(INSTALL_ROOT, 'host-tools');
const APP_DIR = path.join(HOST_TOOLS_DIR, 'canboatjs-signalk');

/* Same staging path the manual flash instructions already use, so a
 * hand-run recovery flash and an OTA flash operate on the same file. */
const FLASH_DIR = '/home/root/zephyr-flash';
const FIRMWARE_BIN = path.join(FLASH_DIR, 'zephyr.bin');
const OPENOCD_CFG = path.join(FLASH_DIR, 'oo', 'unoq-swd.cfg');
const OPENOCD_BIN = '/opt/openocd/bin/openocd';
const OPENOCD_SCRIPTS = '/opt/openocd/share/openocd/scripts';
/* The wrapper script the sudoers rule below whitelists. MUST match the
 * Cmnd_Alias in /etc/sudoers.d/sensor-n2k-ota exactly — sudoers matches
 * on the literal path, so moving or renaming this silently breaks
 * flashing (with a password prompt this service can never answer). */
const FLASH_SCRIPT = path.join(FLASH_DIR, 'ota-flash.sh');
/* Device-side only, deliberately NOT in the repo — permissions files with
 * host-specific usernames don't belong in git (same reasoning as
 * /etc/sensor_n2k/signalk.env, see sensor-n2k-bridge.service). Its
 * presence is checked at startup purely so a board that skipped the
 * one-time prep says so out loud. */
const SUDOERS_FILE = '/etc/sudoers.d/sensor-n2k-ota';

const UPLOAD_TMP = '/var/tmp/sensor_n2k-ota';
const BACKUP_KEEP = 2;

/* Startup device-prep probes; surfaced by /api/status and rendered as a
 * warning banner on the page. Declared here rather than next to
 * checkSudo() at the bottom so /api/status can read them. */
let g_sudoOk = null;
let g_sudoersRulePresent = null;

/* Units restarted after an app update. Ordered: bridge first (everything
 * else connects to its local bus at 127.0.0.1:3010 and reconnects on its
 * own), then the consumers. ota (this service) and signalk are
 * deliberately absent — restarting this process mid-update would kill the
 * update, and Signal K is third-party and unaffected by host-tools. */
const MANAGED_UNITS = [
  'sensor-n2k-bridge',
  'sensor-n2k-config',
  'sensor-n2k-alarm',
  'sensor-n2k-busmonitor',
  'sensor-n2k-bilge',
  'sensor-n2k-portal',
  'sensor-n2k-netconfig',
];

const BUS_MONITOR_URL = 'http://127.0.0.1:3003/api/bus';

/* ------------------------------------------------------------------ */
/* Job log — one in-memory rolling buffer, polled by the browser        */
/* ------------------------------------------------------------------ */

/* A websocket would be tidier, but this is a page you stare at for 30
 * seconds a few times a year; a polled buffer is a fraction of the code
 * and has no reconnect semantics to get wrong (and portal-server.js
 * already set the "just poll it" precedent for cross-service state). */
const LOG_MAX_LINES = 600;

const job = {
  kind: null,         /* 'app' | 'firmware' | 'rollback' | null */
  running: false,
  startedAt: null,
  finishedAt: null,
  ok: null,
  lines: [],
  seq: 0,             /* monotonic; the client polls with ?since=<seq> */
};

function logLine(text) {
  for (const line of String(text).replace(/\r/g, '\n').split('\n')) {
    if (line === '') continue;
    job.seq += 1;
    job.lines.push({ seq: job.seq, ts: Date.now(), text: line });
    console.log('[OTA]', line);
  }
  if (job.lines.length > LOG_MAX_LINES) {
    job.lines.splice(0, job.lines.length - LOG_MAX_LINES);
  }
}

function startJob(kind) {
  /* Single in-flight job, for two independent reasons: only one OpenOCD
   * instance can hold the SWD lines at a time (documented constraint —
   * see docs/N2K-INSTALL-UNOQ.md), and two concurrent app extractions
   * into the same directory would interleave into garbage. */
  if (job.running) return false;
  job.kind = kind;
  job.running = true;
  job.startedAt = Date.now();
  job.finishedAt = null;
  job.ok = null;
  job.lines = [];
  return true;
}

function endJob(ok, summary) {
  if (summary) logLine(summary);
  job.running = false;
  job.ok = ok;
  job.finishedAt = Date.now();
}

/* ------------------------------------------------------------------ */
/* Command execution                                                    */
/* ------------------------------------------------------------------ */

/** Run a command, streaming both stdout and stderr into the job log as
 *  they arrive so a long flash shows progress rather than 40 seconds of
 *  nothing. argv array, no shell — upload paths and version strings are
 *  attacker-influenced input. */
function runLogged(cmd, args, { timeoutMs = 300000, cwd = undefined } = {}) {
  return new Promise((resolve) => {
    logLine(`$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      logLine(`!! timed out after ${Math.round(timeoutMs / 1000)}s — killing`);
      try { child.kill('SIGKILL'); } catch (e) { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', d => logLine(d.toString()));
    child.stderr.on('data', d => logLine(d.toString()));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logLine(`!! spawn failed: ${e.message}`);
      resolve({ ok: false, code: -1 });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code });
    });
  });
}

function runQuiet(cmd, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err, stdout: stdout || '', stderr: stderr || '',
        error: err ? (String(stderr || '').trim() || err.message) : null,
      }));
  });
}

/* ------------------------------------------------------------------ */
/* Version tracking                                                     */
/* ------------------------------------------------------------------ */

/* There is no version tracking in this project today — package.json's
 * "version": "1.0.0" is static and nothing reads it. This file is the new
 * source of truth for "what is actually deployed on this board right
 * now", written on every successful app update. */
function loadVersion() {
  try {
    if (fs.existsSync(VERSION_FILE)) return JSON.parse(fs.readFileSync(VERSION_FILE, 'utf8'));
  } catch (e) {
    console.error('[OTA] version file read error:', e.message);
  }
  return { version: null, deployedAt: null, firmware: null };
}

function saveVersion(patch) {
  const cur = loadVersion();
  const next = { ...cur, ...patch };
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(VERSION_FILE, JSON.stringify(next, null, 2));
  } catch (e) {
    console.error('[OTA] version file write error:', e.message);
  }
  return next;
}

function timestamp() {
  /* 2026-08-26T14-03-11 — sortable, and safe in a filename (no colons,
   * which matter because these end up as directory suffixes). */
  return new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-');
}

/* ------------------------------------------------------------------ */
/* Upload handling                                                      */
/* ------------------------------------------------------------------ */

/* Raw-body uploads (fetch with the File as the body), NOT multipart:
 * multipart parsing without a dependency is a surprising amount of
 * fiddly code, and this project has deliberately zero web framework and
 * zero body-parser. The filename/size come from query parameters. */
function receiveUpload(req, destPath, maxBytes) {
  return new Promise((resolve) => {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const out = fs.createWriteStream(destPath);
    let bytes = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > maxBytes) {
        aborted = true;
        out.destroy();
        req.destroy();
        resolve({ ok: false, error: `upload exceeds ${maxBytes} byte limit` });
      }
    });
    req.on('error', (e) => {
      if (aborted) return;
      aborted = true;
      resolve({ ok: false, error: e.message });
    });
    out.on('error', (e) => {
      if (aborted) return;
      aborted = true;
      resolve({ ok: false, error: e.message });
    });
    out.on('finish', () => {
      if (aborted) return;
      resolve({ ok: true, bytes, path: destPath });
    });
    req.pipe(out);
  });
}

/* ------------------------------------------------------------------ */
/* Linux app update                                                     */
/* ------------------------------------------------------------------ */

function backupDirs() {
  try {
    return fs.readdirSync(INSTALL_ROOT)
      .filter(n => n.startsWith('host-tools.bak-'))
      .sort()
      .reverse();
  } catch (e) {
    return [];
  }
}

async function pruneBackups() {
  const dirs = backupDirs();
  for (const old of dirs.slice(BACKUP_KEEP)) {
    logLine(`pruning old backup ${old}`);
    await runQuiet('rm', ['-rf', path.join(INSTALL_ROOT, old)]);
  }
}

/** Hash of the deployed package.json, so `npm install` only runs when
 *  dependencies actually changed — it is by far the slowest step of an
 *  app update on this board, and skipping it turns a two-minute update
 *  into a five-second one for the common case (a JS change). */
function packageJsonFingerprint() {
  try {
    const raw = fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8');
    return crypto.createHash('sha256').update(raw).digest('hex');
  } catch (e) {
    return null;
  }
}

async function doAppUpdate(tarPath, versionLabel) {
  const stamp = timestamp();
  const backupPath = path.join(INSTALL_ROOT, `host-tools.bak-${stamp}`);
  const stagePath = path.join(UPLOAD_TMP, `stage-${stamp}`);

  try {
    logLine(`app update starting (tarball ${tarPath})`);

    /* Validate the archive BEFORE touching the live tree. A truncated or
     * non-tar upload must fail here, with the running install untouched,
     * rather than half-way through an extraction over it. */
    const listing = await runQuiet('tar', ['tzf', tarPath], { timeoutMs: 120000 });
    if (!listing.ok) {
      endJob(false, `rejected: not a readable gzip tarball (${listing.error})`);
      return;
    }
    const entries = listing.stdout.split('\n').filter(Boolean);
    logLine(`archive contains ${entries.length} entries`);

    /* Accept either a tarball rooted at host-tools/ (what package.sh
     * produces) or one rooted at the host-tools *contents*. Anything else
     * is almost certainly the wrong file. */
    const rootedAtHostTools = entries.some(e => /^\.?\/?host-tools\//.test(e));
    const rootedAtContents = entries.some(e => /^\.?\/?canboatjs-signalk\//.test(e));
    if (!rootedAtHostTools && !rootedAtContents) {
      endJob(false, 'rejected: archive contains neither host-tools/ nor canboatjs-signalk/ — ' +
        'this does not look like a host-tools package');
      return;
    }

    /* Extract to a staging directory first, same reason. */
    fs.mkdirSync(stagePath, { recursive: true });
    const untar = await runLogged('tar', ['xzf', tarPath, '-C', stagePath], { timeoutMs: 180000 });
    if (!untar.ok) {
      endJob(false, 'extraction failed — live install untouched');
      return;
    }
    const newTree = rootedAtHostTools ? path.join(stagePath, 'host-tools') : stagePath;
    if (!fs.existsSync(path.join(newTree, 'canboatjs-signalk'))) {
      endJob(false, `rejected: ${newTree}/canboatjs-signalk missing after extraction`);
      return;
    }

    const beforeFingerprint = packageJsonFingerprint();

    /* node_modules is NOT shipped in the tarball (it's ~100MB of arm64
     * binaries) — carry the existing one across so a JS-only update
     * doesn't force a full npm install with no network. */
    const oldModules = path.join(APP_DIR, 'node_modules');
    const newModules = path.join(newTree, 'canboatjs-signalk', 'node_modules');
    const carryModules = fs.existsSync(oldModules) && !fs.existsSync(newModules);

    logLine(`backing up current install to ${backupPath}`);
    const mv = await runLogged('mv', [HOST_TOOLS_DIR, backupPath]);
    if (!mv.ok) {
      endJob(false, 'backup move failed — live install untouched');
      return;
    }

    const place = await runLogged('mv', [newTree, HOST_TOOLS_DIR]);
    if (!place.ok) {
      /* Put the old tree straight back: an aborted update must never
       * leave the board with no host-tools at all. */
      logLine('!! placing new tree failed — restoring backup');
      await runLogged('mv', [backupPath, HOST_TOOLS_DIR]);
      endJob(false, 'install failed, previous version restored');
      return;
    }

    if (carryModules) {
      logLine('carrying node_modules across from the previous install');
      await runLogged('cp', ['-a', path.join(backupPath, 'canboatjs-signalk', 'node_modules'),
        path.join(APP_DIR, 'node_modules')], { timeoutMs: 300000 });
    }

    const afterFingerprint = packageJsonFingerprint();
    if (afterFingerprint !== beforeFingerprint || !fs.existsSync(path.join(APP_DIR, 'node_modules'))) {
      logLine('package.json changed (or node_modules missing) — running npm install');
      const npm = await runLogged('npm', ['install', '--no-audit', '--no-fund'],
        { cwd: APP_DIR, timeoutMs: 900000 });
      if (!npm.ok) {
        logLine('!! npm install failed — services will be restarted anyway, but they may not start. ' +
          'Use "Restore previous" if they do not come back.');
      }
    } else {
      logLine('package.json unchanged — skipping npm install');
    }

    await restartUnits();
    await pruneBackups();

    const v = saveVersion({
      version: versionLabel || stamp,
      deployedAt: new Date().toISOString(),
    });
    endJob(true, `app update complete — deployed version "${v.version}"`);
  } catch (e) {
    endJob(false, `app update crashed: ${e.message}`);
  } finally {
    await runQuiet('rm', ['-rf', stagePath]);
    await runQuiet('rm', ['-f', tarPath]);
  }
}

async function restartUnits() {
  for (const unit of MANAGED_UNITS) {
    /* is-enabled rather than is-active: a unit that exists but happens to
     * be stopped should still be restarted into the new code, while a
     * unit that isn't installed on this board at all (e.g. netconfig on a
     * board updated from an older image) must not fail the whole update. */
    const known = await runQuiet('systemctl', ['cat', `${unit}.service`], { timeoutMs: 10000 });
    if (!known.ok) {
      logLine(`skipping ${unit} (no such unit on this board)`);
      continue;
    }
    const r = await runLogged('systemctl', ['restart', `${unit}.service`], { timeoutMs: 60000 });
    logLine(`${unit}: ${r.ok ? 'restarted' : 'RESTART FAILED (exit ' + r.code + ')'}`);
  }
}

async function doRollback(backupName) {
  const backupPath = path.join(INSTALL_ROOT, backupName);
  const stamp = timestamp();
  try {
    if (!backupName.startsWith('host-tools.bak-') || !fs.existsSync(backupPath)) {
      endJob(false, `no such backup: ${backupName}`);
      return;
    }
    logLine(`rolling back to ${backupName}`);
    /* Swap, don't delete: the version being rolled back FROM becomes a
     * backup itself, so a rollback is undoable too. */
    const aside = path.join(INSTALL_ROOT, `host-tools.bak-${stamp}`);
    const mv1 = await runLogged('mv', [HOST_TOOLS_DIR, aside]);
    if (!mv1.ok) { endJob(false, 'could not move current install aside'); return; }
    const mv2 = await runLogged('mv', [backupPath, HOST_TOOLS_DIR]);
    if (!mv2.ok) {
      await runLogged('mv', [aside, HOST_TOOLS_DIR]);
      endJob(false, 'restore failed, current version put back');
      return;
    }
    await restartUnits();
    await pruneBackups();
    saveVersion({ version: `rolled-back:${backupName}`, deployedAt: new Date().toISOString() });
    endJob(true, `rolled back to ${backupName}`);
  } catch (e) {
    endJob(false, `rollback crashed: ${e.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Zephyr firmware update                                               */
/* ------------------------------------------------------------------ */

/*
 * The flash sequence, verbatim from docs/N2K-INSTALL-UNOQ.md §6e, wrapped
 * in a script so that (a) sudoers can whitelist ONE fixed command path
 * rather than a blanket rule, and (b) the BOOT0 GPIO hold, which has to
 * span the whole OpenOCD run and then be released, stays a single shell
 * job rather than three racing child processes here.
 *
 * Notes carried over from the manual procedure, do not "fix" these:
 *   - SWD is bit-banged from the Linux MPU's own GPIOs to its own onboard
 *     STM32. There is no external programmer and no cable to plug in.
 *   - Only ONE OpenOCD instance can hold the SWD lines, hence the pkill.
 *   - "Checksum mismatch — attempting binary compare" immediately followed
 *     by "verified N bytes" is BENIGN and expected. Success is
 *     "verified N bytes" + "shutdown command invoked" with no error.
 */
function buildFlashScript() {
  return `#!/bin/sh
# GENERATED by ota-server.js — do not edit by hand; it is rewritten on
# every service start. Whitelisted verbatim in /etc/sudoers.d/sensor-n2k-ota.
#
# Usage: ota-flash.sh flash | ota-flash.sh dump <outfile>
set -e

OPENOCD='${OPENOCD_BIN}'
SCRIPTS='${OPENOCD_SCRIPTS}'
CFG='${OPENOCD_CFG}'
BIN='${FIRMWARE_BIN}'

# Only one OpenOCD instance can hold the SWD lines at a time.
pkill -f openocd 2>/dev/null || true
killall gpioset 2>/dev/null || true
sleep 0.2

case "$1" in
  dump)
    OUT="$2"
    [ -n "$OUT" ] || { echo "dump: missing output path" >&2; exit 2; }
    "$OPENOCD" -s "$SCRIPTS" -f "$CFG" \\
      -c init -c halt \\
      -c "dump_image $OUT 0x08000000 0x80000" \\
      -c shutdown
    ;;
  flash)
    [ -f "$BIN" ] || { echo "flash: $BIN not found" >&2; exit 2; }
    gpioset -c gpiochip1 37=0 &
    BOOT0=$!
    sleep 0.3
    RC=0
    "$OPENOCD" -s "$SCRIPTS" -f "$CFG" \\
      -c init -c halt \\
      -c "flash write_image erase $BIN 0x08000000 bin" \\
      -c "verify_image $BIN 0x08000000 bin" \\
      -c "reset run" -c shutdown || RC=$?
    kill $BOOT0 2>/dev/null || true
    exit $RC
    ;;
  *)
    echo "usage: $0 flash|dump <outfile>" >&2
    exit 2
    ;;
esac
`;
}

/** Rewrite the flash wrapper on every start so it can never drift from
 *  the sequence above after an app update. Best-effort: if this service
 *  somehow isn't root the firmware path simply won't work, and says so. */
function installFlashScript() {
  try {
    fs.mkdirSync(FLASH_DIR, { recursive: true });
    fs.writeFileSync(FLASH_SCRIPT, buildFlashScript(), { mode: 0o755 });
    fs.chmodSync(FLASH_SCRIPT, 0o755);
    console.log(`[OTA] flash wrapper written to ${FLASH_SCRIPT}`);
    return true;
  } catch (e) {
    console.error(`[OTA] could not write ${FLASH_SCRIPT}: ${e.message} — ` +
      'firmware updates will not work until this is fixed (see docs/OTA-UPDATE.md)');
    return false;
  }
}

/** Poll bus-monitor-server.js's existing /api/bus for evidence the MCU
 *  came back. This is the honest safety net for the "no MCUboot" tier:
 *  it can tell you the board is dead, it cannot revive it. */
function fetchBus() {
  return new Promise((resolve) => {
    const req = http.get(BUS_MONITOR_URL, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

const POST_FLASH_POLL_MS = 3000;
const POST_FLASH_WINDOW_MS = 60000;

async function waitForBusAfterFlash() {
  logLine('waiting for the new firmware to come back on the CAN bus…');
  const deadline = Date.now() + POST_FLASH_WINDOW_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POST_FLASH_POLL_MS));
    const bus = await fetchBus();
    if (!bus) { logLine('bus monitor not answering yet…'); continue; }
    const state = bus.canState || bus.state || null;
    const devices = Array.isArray(bus.devices) ? bus.devices.length : 0;
    logLine(`bus: canState=${state} devices=${devices} saConfirmed=${bus.saConfirmed}`);
    /* Any of these three is real evidence the MCU is running and talking
     * SPI: a confirmed source address, a non-error CAN state, or at least
     * one device seen since the reset. */
    if (bus.saConfirmed || devices > 0 || (state && !/bus.?off|error|unknown/i.test(String(state)))) {
      return true;
    }
  }
  return false;
}

async function doFirmwareUpdate(uploadPath, versionLabel) {
  const stamp = timestamp();
  try {
    const size = fs.statSync(uploadPath).size;
    logLine(`firmware upload received: ${size} bytes`);

    /* Cheap sanity checks before erasing anything. A Zephyr image for
     * this target is tens of KB; a stray zephyr.elf, a .hex, or a
     * truncated transfer all get caught here rather than by the flash. */
    if (size < 4096) {
      endJob(false, `rejected: ${size} bytes is far too small to be a Zephyr image`);
      return;
    }
    if (size > 512 * 1024) {
      endJob(false, `rejected: ${size} bytes exceeds the 512KB flash on the STM32U585`);
      return;
    }
    /* First 8 bytes only — fs.readFileSync has no start/end (that's
     * createReadStream), so read through a descriptor rather than pulling
     * the whole image into memory to look at its header. */
    const head = Buffer.alloc(8);
    const fd = fs.openSync(uploadPath, 'r');
    try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }

    if (head.subarray(0, 4).toString('binary') === '\x7fELF') {
      endJob(false, 'rejected: this is an ELF file (zephyr.elf), not the raw binary — upload zephyr.bin');
      return;
    }
    /* A raw Cortex-M image starts with the initial stack pointer, which on
     * this part lives in SRAM (0x20000000-0x300xxxxx), followed by the
     * reset vector in flash (0x08xxxxxx). Checking the second word is the
     * more discriminating of the two. */
    const resetVector = head.readUInt32LE(4);
    if ((resetVector & 0xff000000) !== 0x08000000) {
      logLine(`!! warning: reset vector 0x${resetVector.toString(16)} is not in the 0x08xxxxxx flash ` +
        'range — this may not be an image linked for this target. Continuing anyway.');
    }

    if (!fs.existsSync(FLASH_SCRIPT)) {
      endJob(false, `flash wrapper ${FLASH_SCRIPT} is missing — see docs/OTA-UPDATE.md`);
      return;
    }
    if (!fs.existsSync(OPENOCD_CFG)) {
      endJob(false, `OpenOCD config ${OPENOCD_CFG} is missing — run the device prep in ` +
        'docs/N2K-INSTALL-UNOQ.md §6c first');
      return;
    }

    /* Back up what is currently RUNNING before erasing it. The install
     * doc only ever did this once, for the original Arduino bootloader;
     * doing it on every flash means there is always a known-good image on
     * disk to recover to with a manual OpenOCD run. */
    const backupBin = path.join(FLASH_DIR, `zephyr-backup-${stamp}.bin`);
    logLine(`dumping the currently-running image to ${backupBin}`);
    const dump = await runLogged('sudo', ['-n', FLASH_SCRIPT, 'dump', backupBin], { timeoutMs: 180000 });
    if (!dump.ok) {
      endJob(false, 'could not read back the current firmware. If the log above says ' +
        '"sudo: a password is required", the one-time /etc/sudoers.d/sensor-n2k-ota rule ' +
        'has not been installed — see docs/OTA-UPDATE.md. NOTHING WAS ERASED.');
      return;
    }

    fs.mkdirSync(FLASH_DIR, { recursive: true });
    fs.copyFileSync(uploadPath, FIRMWARE_BIN);
    logLine(`staged new image at ${FIRMWARE_BIN}`);

    logLine('flashing — do not power down the board');
    const flash = await runLogged('sudo', ['-n', FLASH_SCRIPT, 'flash'], { timeoutMs: 300000 });
    if (!flash.ok) {
      endJob(false, 'FLASH FAILED. The MCU may be in an unknown state. The image that was ' +
        `running before this attempt is saved at ${backupBin} — recover it with a manual ` +
        'OpenOCD run (docs/OTA-UPDATE.md, "Manual recovery").');
      return;
    }

    const alive = await waitForBusAfterFlash();
    saveVersion({
      firmware: {
        version: versionLabel || stamp,
        flashedAt: new Date().toISOString(),
        backup: backupBin,
        confirmedRunning: alive,
      },
    });

    if (alive) {
      endJob(true, 'flash verified and the new firmware is answering on the bus.');
    } else {
      endJob(false, 'Flash verified, but NO bus activity within ' +
        `${POST_FLASH_WINDOW_MS / 1000}s. The image may be logically broken. This tier of OTA ` +
        'has no automatic rollback — recover manually with the backup at ' +
        `${backupBin} (docs/OTA-UPDATE.md, "Manual recovery").`);
    }
  } catch (e) {
    endJob(false, `firmware update crashed: ${e.message}`);
  } finally {
    await runQuiet('rm', ['-f', uploadPath]);
  }
}

/* ------------------------------------------------------------------ */
/* HTTP API + webapp                                                    */
/* ------------------------------------------------------------------ */

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const MAX_APP_BYTES = 256 * 1024 * 1024;
const MAX_FW_BYTES = 4 * 1024 * 1024;

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    const v = loadVersion();
    json(res, 200, {
      version: v.version, deployedAt: v.deployedAt, firmware: v.firmware || null,
      backups: backupDirs(),
      units: MANAGED_UNITS,
      flashScript: FLASH_SCRIPT,
      flashScriptPresent: fs.existsSync(FLASH_SCRIPT),
      openocdCfgPresent: fs.existsSync(OPENOCD_CFG),
      sudoOk: g_sudoOk,
      sudoersRulePresent: g_sudoersRulePresent,
      runningAsRoot: process.getuid ? process.getuid() === 0 : null,
      job: {
        kind: job.kind, running: job.running, ok: job.ok,
        startedAt: job.startedAt, finishedAt: job.finishedAt,
      },
      uptime: Math.round(os.uptime()),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/log') {
    const since = parseInt(url.searchParams.get('since') || '0', 10);
    json(res, 200, {
      lines: job.lines.filter(l => l.seq > since),
      seq: job.seq,
      running: job.running,
      ok: job.ok,
      kind: job.kind,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/update/app') {
    if (!startJob('app')) { json(res, 409, { ok: false, error: 'another update is already running' }); return true; }
    const dest = path.join(UPLOAD_TMP, `host-tools-${timestamp()}.tar.gz`);
    const up = await receiveUpload(req, dest, MAX_APP_BYTES);
    if (!up.ok) { endJob(false, `upload failed: ${up.error}`); json(res, 400, { ok: false, error: up.error }); return true; }
    json(res, 200, { ok: true, bytes: up.bytes });
    doAppUpdate(dest, url.searchParams.get('version') || '');
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/update/firmware') {
    if (!startJob('firmware')) { json(res, 409, { ok: false, error: 'another update is already running' }); return true; }
    const dest = path.join(UPLOAD_TMP, `zephyr-${timestamp()}.bin`);
    const up = await receiveUpload(req, dest, MAX_FW_BYTES);
    if (!up.ok) { endJob(false, `upload failed: ${up.error}`); json(res, 400, { ok: false, error: up.error }); return true; }
    json(res, 200, { ok: true, bytes: up.bytes });
    doFirmwareUpdate(dest, url.searchParams.get('version') || '');
    return true;
  }

  const rollbackMatch = url.pathname.match(/^\/api\/rollback\/(.+)$/);
  if (req.method === 'POST' && rollbackMatch) {
    if (!startJob('rollback')) { json(res, 409, { ok: false, error: 'another update is already running' }); return true; }
    json(res, 200, { ok: true });
    doRollback(decodeURIComponent(rollbackMatch[1]));
    return true;
  }

  return false;
}

const WEBAPP_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sensor_n2k Updates</title>
${SHARED_STYLE}
</head>
<body>
${navHtml('ota')}
<div class="wrap">
<h1>Updates</h1>
<p class="sub">Update the Linux services and the Zephyr firmware over the network. Both keep a backup of
what they replaced.</p>

<div class="card">
<h2 style="margin-top:0">Currently deployed</h2>
<div class="stat-row">
<div class="stat">App version <b id="s-version">-</b></div>
<div class="stat">Deployed <b id="s-deployed">-</b></div>
<div class="stat">Firmware <b id="s-fw">-</b></div>
<div class="stat">Linux uptime <b id="s-uptime">-</b></div>
</div>
<p id="s-prep" class="sub" style="color:var(--warn)"></p>
</div>

<div class="card">
<h2 style="margin-top:0">Linux app update</h2>
<p class="sub">Upload a gzipped tarball of <code>host-tools/</code> (build one with <code>./package.sh</code>
at the repo root). The current install is moved aside to a timestamped backup, the new one is extracted,
<code>npm install</code> runs only if <code>package.json</code> changed, and the services are restarted.</p>
<label>Tarball <input type="file" id="app-file" accept=".tar.gz,.tgz"></label>
<label>Version label <input id="app-version" placeholder="(optional, e.g. 2026-08-26 wifi setup)"></label>
<br>
<button class="primary" id="app-btn" onclick="uploadApp()">Upload and install</button>
<span id="app-msg" class="sub" style="margin-left:1em"></span>
</div>

<div class="card">
<h2 style="margin-top:0">Zephyr firmware update</h2>
<p class="sub">Upload <code>zephyr.bin</code> (from <code>build.sh</code>). The image currently running is
dumped to a timestamped backup first, then flashed over SWD from this board's own GPIOs — no programmer,
no cable. Afterwards the bus monitor is watched for evidence the new firmware is alive.</p>
<p class="sub" style="color:var(--warn)"><b>No automatic rollback.</b> An image that flashes and verifies
cleanly but is logically broken still needs a manual OpenOCD recovery run. Do not do this underway.</p>
<label>Firmware <input type="file" id="fw-file" accept=".bin"></label>
<label>Version label <input id="fw-version" placeholder="(optional)"></label>
<br>
<button class="primary" id="fw-btn" onclick="uploadFirmware()">Upload and flash</button>
<span id="fw-msg" class="sub" style="margin-left:1em"></span>
</div>

<div class="card">
<h2 style="margin-top:0">Backups</h2>
<table id="bak-table"><thead><tr><th>Backup</th><th></th></tr></thead><tbody></tbody></table>
<p class="sub">The most recent ${BACKUP_KEEP} app backups are kept; older ones are pruned automatically.</p>
</div>

<div class="card">
<h2 style="margin-top:0">Log</h2>
<p id="job-state" class="sub">idle</p>
<pre id="log" style="background:var(--surface-2);border-radius:var(--radius);padding:0.8em;max-height:420px;overflow:auto;font-size:0.85em;margin:0;white-space:pre-wrap"></pre>
</div>
</div>

<script>
let logSeq = 0;

function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return isNaN(d) ? String(iso) : d.toLocaleString();
}

async function refresh() {
  let s;
  try { s = await fetch('/api/status').then(r => r.json()); }
  catch (e) { return; }   /* services restarting mid-update — keep last state */

  document.getElementById('s-version').textContent = s.version || '(unknown)';
  document.getElementById('s-deployed').textContent = fmtTime(s.deployedAt);
  document.getElementById('s-fw').textContent = s.firmware
    ? s.firmware.version + (s.firmware.confirmedRunning ? '' : ' (unconfirmed)')
    : '(unknown)';
  const up = s.uptime || 0;
  document.getElementById('s-uptime').textContent =
    up > 86400 ? Math.floor(up / 86400) + 'd ' + Math.floor((up % 86400) / 3600) + 'h'
      : up > 3600 ? Math.floor(up / 3600) + 'h ' + Math.floor((up % 3600) / 60) + 'm'
        : Math.floor(up / 60) + 'm';

  const prep = [];
  if (!s.flashScriptPresent) prep.push('The flash wrapper ' + s.flashScript + ' is missing — firmware updates will fail.');
  if (!s.openocdCfgPresent) prep.push('The OpenOCD SWD config is missing — run the device prep in the install doc.');
  if (s.sudoOk === false) prep.push('sudo is asking for a password: the one-time /etc/sudoers.d/sensor-n2k-ota rule ' +
    'has not been installed. Firmware updates will fail until it is. See docs/OTA-UPDATE.md.');
  else if (s.sudoersRulePresent === false) prep.push('/etc/sudoers.d/sensor-n2k-ota is missing — flashing works ' +
    'only because this service is running as root. Install the scoped rule (one-time, per board image) ' +
    'so it keeps working if the service is ever de-privileged. See docs/OTA-UPDATE.md.');
  document.getElementById('s-prep').textContent = prep.join(' ');

  const tbody = document.querySelector('#bak-table tbody');
  tbody.innerHTML = '';
  (s.backups || []).forEach(b => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + b + '</td><td></td>';
    const btn = document.createElement('button');
    btn.textContent = 'Restore previous';
    btn.onclick = () => rollback(b);
    btn.disabled = !!s.job.running;
    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  });

  const busy = !!s.job.running;
  document.getElementById('app-btn').disabled = busy;
  document.getElementById('fw-btn').disabled = busy;
  document.getElementById('job-state').textContent = busy
    ? (s.job.kind + ' update running…')
    : s.job.kind
      ? (s.job.kind + ' update ' + (s.job.ok ? 'succeeded' : 'FAILED') + ' at ' + fmtTime(new Date(s.job.finishedAt).toISOString()))
      : 'idle';
}

async function pollLog() {
  try {
    const r = await fetch('/api/log?since=' + logSeq).then(r => r.json());
    if (r.seq < logSeq) { logSeq = 0; document.getElementById('log').textContent = ''; }
    (r.lines || []).forEach(l => {
      document.getElementById('log').textContent += l.text + '\\n';
      logSeq = Math.max(logSeq, l.seq);
    });
    const pre = document.getElementById('log');
    pre.scrollTop = pre.scrollHeight;
  } catch (e) { /* mid-restart */ }
}

async function upload(kind, fileInput, versionInput, msgEl, confirmText) {
  const f = document.getElementById(fileInput).files[0];
  if (!f) { document.getElementById(msgEl).textContent = 'Choose a file first.'; return; }
  if (confirmText && !confirm(confirmText)) return;
  const version = encodeURIComponent(document.getElementById(versionInput).value || '');
  document.getElementById(msgEl).textContent = 'Uploading ' + f.name + ' (' + f.size + ' bytes)…';
  logSeq = 0;
  document.getElementById('log').textContent = '';
  try {
    const r = await fetch('/api/update/' + kind + '?version=' + version, { method: 'POST', body: f })
      .then(r => r.json());
    document.getElementById(msgEl).textContent = r.ok
      ? 'Uploaded — watch the log below.'
      : 'Failed: ' + (r.error || 'unknown error');
  } catch (e) {
    document.getElementById(msgEl).textContent = 'Upload failed: ' + e.message;
  }
  refresh();
}

function uploadApp() {
  upload('app', 'app-file', 'app-version', 'app-msg', null);
}

function uploadFirmware() {
  upload('firmware', 'fw-file', 'fw-version', 'fw-msg',
    'Flash this firmware now?\\n\\nThe MCU will be halted, erased and reprogrammed. ' +
    'There is no automatic rollback. Do not power the board down until the log says it is done.');
}

async function rollback(name) {
  if (!confirm('Restore ' + name + ' and restart all services?')) return;
  logSeq = 0;
  document.getElementById('log').textContent = '';
  await fetch('/api/rollback/' + encodeURIComponent(name), { method: 'POST' });
  refresh();
}

refresh();
pollLog();
setInterval(refresh, 4000);
setInterval(pollLog, 1500);
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await handleApi(req, res, url);
      if (!handled) json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[OTA] API error:', e.message);
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

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`[OTA] Port ${PORT} already in use`);
  else console.error('[OTA] Server error:', e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[OTA] Listening on http://0.0.0.0:${PORT}`);
});

/* ------------------------------------------------------------------ */
/* Startup checks — fail LOUD, not at 2am mid-flash                     */
/* ------------------------------------------------------------------ */

installFlashScript();
try { fs.mkdirSync(UPLOAD_TMP, { recursive: true }); } catch (e) { /* checked on use */ }

async function checkSudo() {
  /* `sudo -n -l <cmd>` asks "may I run this without a password?" without
   * running anything. This is the check that matters operationally — if
   * it fails, firmware updates fail. */
  const probe = await runQuiet('sudo', ['-n', '-l', FLASH_SCRIPT], { timeoutMs: 10000 });
  g_sudoOk = probe.ok;

  /* Separately: is the scoped rule file actually installed? As root the
   * probe above passes regardless, so without this second check a board
   * that never had the device-prep step done looks perfectly healthy —
   * right up until someone de-privileges the unit. Same class of silent,
   * easily-skipped, must-be-redone-per-image prep as the
   * `setcap cap_net_bind_service` requirement in
   * sensor-n2k-portal.service, and it gets the same loud treatment. */
  g_sudoersRulePresent = fs.existsSync(SUDOERS_FILE);

  if (!g_sudoOk) {
    console.warn(
      '[OTA] ****************************************************************\n' +
      `[OTA] *** sudo CANNOT run ${FLASH_SCRIPT}\n` +
      '[OTA] *** without a password. FIRMWARE UPDATES WILL FAIL.\n' +
      '[OTA] *** One-time device prep — see docs/OTA-UPDATE.md:\n' +
      `[OTA] ***   sudo visudo -f ${SUDOERS_FILE}\n` +
      `[OTA] ***   <user> ALL=(ALL) NOPASSWD: ${FLASH_SCRIPT}\n` +
      '[OTA] *** NEVER widen this to NOPASSWD: ALL.\n' +
      '[OTA] *** The Linux app-update path is unaffected.\n' +
      '[OTA] ****************************************************************');
  } else if (!g_sudoersRulePresent) {
    console.warn(
      '[OTA] ****************************************************************\n' +
      `[OTA] *** ${SUDOERS_FILE} is MISSING.\n` +
      '[OTA] *** Firmware updates work right now only because this service\n' +
      '[OTA] *** is running as root. The one-time device-prep step has not\n' +
      '[OTA] *** been done on this board, so flashing will break silently\n' +
      '[OTA] *** the moment the unit is run as any other user.\n' +
      '[OTA] *** MUST be redone on every fresh board image — see\n' +
      '[OTA] *** docs/OTA-UPDATE.md.\n' +
      '[OTA] ****************************************************************');
  } else {
    console.log('[OTA] sudo rule for the flash wrapper is in place');
  }
}

checkSudo();
