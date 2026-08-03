#!/usr/bin/env node
'use strict';

/*
 * bt-speaker.js — Bluetooth speaker pairing/connection manager and alert
 * playback, used by alarm-server.js when hardware.output === 'bt_speaker'.
 *
 * Audio stack on this board, confirmed on-device (the implementer note in
 * the plan flagged this couldn't be determined from source alone):
 *   - PipeWire (pipewire.service, user-session), NOT PulseAudio — no
 *     pulseaudio.service unit exists at all.
 *   - pipewire-pulse.service (the PulseAudio-compatibility shim) IS
 *     running, but the client tools that talk to it (`paplay`/`pactl`,
 *     from the pulseaudio-utils package) are NOT installed.
 *   - PipeWire's own native CLI (`pw-play`, `pw-cat`) IS installed.
 *   => Use `pw-cat --playback` directly rather than `paplay`/`aplay`
 *      (aplay is ALSA-direct, unreliable once PipeWire owns the audio
 *      devices exclusively, which is the normal PipeWire setup).
 *
 * Speech synthesis: Piper (neural TTS, CPU-only, fully offline), not
 * espeak-ng — espeak-ng's formant synthesis was intelligible but sounded
 * distinctly robotic/harsh, especially over a small speaker; Piper is a
 * clear, material quality improvement for the same offline/no-internet
 * constraint (this is a boat alarm system — no cloud TTS). Installed
 * manually to /opt/piper (not an apt package): the prebuilt
 * piper_linux_aarch64.tar.gz release plus one voice model
 * (en_US-lessac-medium, ~63MB) downloaded from HuggingFace — see
 * PIPER-NOTES.md in this directory for exact URLs/versions and how to
 * redo this on a fresh board image. Confirmed on this board: real-time
 * factor ~0.6 (faster than real-time), ~2s one-time model load +
 * <1s inference per short alert phrase — acceptable for an alarm that
 * isn't fired back-to-back-to-back.
 *
 * `bluetoothctl` (BlueZ 5.82) has no non-interactive subcommand mode for
 * scan/pair/trust/connect — confirmed on-device (`echo help |
 * bluetoothctl` just launches the interactive prompt) — so this scripts
 * it the classic way: spawn as a persistent child process, write commands
 * to stdin, parse stdout.
 */

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BLUETOOTHCTL_TIMEOUT_MS = 15000;

const PIPER_DIR = '/opt/piper';
const PIPER_BIN = path.join(PIPER_DIR, 'piper');
const PIPER_MODEL = path.join(PIPER_DIR, 'voices', 'en_US-lessac-medium.onnx');

/* ------------------------------------------------------------------ */
/* bluetoothctl scripting                                              */
/* ------------------------------------------------------------------ */

/* Run a short sequence of bluetoothctl commands, collecting stdout, with
 * an overall timeout. Resolves with the full captured output. */
function runBluetoothctl(commands, { timeoutMs = BLUETOOTHCTL_TIMEOUT_MS, settleMs = 0 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn('bluetoothctl', [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let done = false;

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { proc.stdin.write('quit\n'); } catch (e) { /* already closing */ }
      setTimeout(() => { try { proc.kill(); } catch (e) {} }, 200);
      resolve(out);
    };

    const timer = setTimeout(finish, timeoutMs);

    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', (d) => { out += d.toString(); });
    proc.on('error', (e) => {
      out += `\n[bt-speaker] bluetoothctl spawn error: ${e.message}\n`;
      finish();
    });

    /* bluetoothctl needs a beat to attach to bluetoothd before commands
     * queued immediately on stdin are guaranteed to be processed. */
    setTimeout(() => {
      commands.forEach((cmd, i) => {
        setTimeout(() => {
          try { proc.stdin.write(cmd + '\n'); } catch (e) { /* proc likely gone */ }
        }, i * 300);
      });
      if (settleMs > 0) {
        setTimeout(finish, commands.length * 300 + settleMs);
      }
    }, 300);
  });
}

/** Scan for nearby devices for durationMs, return [{mac, name}]. */
async function scanDevices(durationMs) {
  const out = await runBluetoothctl(['scan on'], {
    timeoutMs: durationMs + 2000,
    settleMs: durationMs,
  });

  const devices = new Map();
  const re = /Device ([0-9A-Fa-f:]{17}) (.+)/g;
  let m;

  while ((m = re.exec(out)) !== null) {
    const mac  = m[1];
    const name = m[2].trim();
    /* bluetoothctl emits repeated "Device MAC ..." lines (RSSI updates
     * etc.) for the same device during a scan — last name wins, dedupe
     * by MAC. */
    devices.set(mac, { mac, name });
  }
  return Array.from(devices.values());
}

/** Pair, trust, and connect to mac. Returns {paired, trusted, connected}. */
async function pairAndConnect(mac) {
  const out = await runBluetoothctl(
    [`pair ${mac}`, `trust ${mac}`, `connect ${mac}`],
    { timeoutMs: BLUETOOTHCTL_TIMEOUT_MS, settleMs: 2000 }
  );

  return {
    paired:    /Pairing successful/i.test(out) || /already paired/i.test(out),
    trusted:   !/Failed to trust/i.test(out),
    connected: /Connection successful/i.test(out) || /already connected/i.test(out),
    raw: out,
  };
}

/** Connected boolean, parsed from `bluetoothctl info <mac>`. */
async function getStatus(mac) {
  const out = await runBluetoothctl([`info ${mac}`], { timeoutMs: 5000, settleMs: 500 });
  const connected = /Connected:\s*yes/i.test(out);
  const trusted   = /Trusted:\s*yes/i.test(out);
  const paired    = /Paired:\s*yes/i.test(out);

  return { mac, connected, trusted, paired };
}

/** Poll every intervalMs; if trusted-but-disconnected, try to reconnect.
 *  Returns a handle with .stop(). */
function monitorAndReconnect(mac, intervalMs) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      const status = await getStatus(mac);

      if (status.trusted && !status.connected) {
        console.log(`[bt-speaker] ${mac} trusted but disconnected — reconnecting…`);
        await runBluetoothctl([`connect ${mac}`], { timeoutMs: 10000, settleMs: 1500 });
      }
    } catch (e) {
      console.error('[bt-speaker] monitor tick error:', e.message);
    }
    if (!stopped) {
      handle.timer = setTimeout(tick, intervalMs);
    }
  };

  const handle = {
    timer: setTimeout(tick, intervalMs),
    stop() {
      stopped = true;
      clearTimeout(handle.timer);
    },
  };
  return handle;
}

/* ------------------------------------------------------------------ */
/* Audio playback                                                       */
/* ------------------------------------------------------------------ */

/* Four severity tiers, matching alarm_io.c's buzzer patterns 1-4 and the
 * target loudness table (buzzer 85-95dB / warning 95-105dB / alarm
 * 105-115dB+, bell added as a 4th, most-urgent tier above alarm — a
 * classic rapid marine bell strike, see
 * https://www.go2marine.com/products/aqualarm-marine-bell-alarm-12v-volt-32v-volt).
 *
 * There is no way to hit an absolute dB SPL target from software — that
 * depends on the physical speaker's own max output, which this app can't
 * measure. What's actually adjustable, and used here, is everything
 * upstream of that physical ceiling:
 *   - gain: digital sample amplitude baked into the synthesized WAV
 *     (0-1 before soft-clip saturation — see generateToneWav()).
 *   - sinkVolume: the PipeWire/WirePlumber mixer level for the Bluetooth
 *     sink itself, set via `wpctl set-volume` right before playback (see
 *     setSinkVolume()). This was the biggest hidden ceiling: the JBL's
 *     sink volume just sits wherever it was last left (56% observed on
 *     this board) — a loud WAV still gets attenuated on top of that
 *     unless the sink is explicitly pushed up first. For a Bluetooth
 *     A2DP sink this generally relays through AVRCP absolute volume to
 *     the speaker's own amplifier, so it's the closest thing to a real
 *     "make the speaker itself louder" control available.
 * (Voice loudness has no separate knob of its own — Piper doesn't expose
 * an amplitude flag the way espeak-ng did — it's carried entirely by
 * sinkVolume too, same as the tone; see speak()'s comment for why adding
 * our own digital gain on top of Piper's output isn't worth the risk.)
 * Ordering matches the target loudness table (buzzer quietest, alarm/bell
 * loudest); each tier's tone is also now materially longer than the old
 * flat 400ms every tier used previously. */
const ALARM_LEVELS = {
  buzzer:  { gain: 0.40, sinkVolume: 0.60, toneMs: 1000, freqHz: 880,  bell: false },
  warning: { gain: 0.70, sinkVolume: 0.85, toneMs: 1400, freqHz: 1046, bell: false },
  alarm:   { gain: 1.00, sinkVolume: 1.00, toneMs: 1800, freqHz: 1318, bell: false },
  bell:    { gain: 1.00, sinkVolume: 1.00, toneMs: 2200, freqHz: 900,  bell: true  },
};
const DEFAULT_LEVEL = 'warning';

/** Synthesize a WAV tone in-process — no binary asset files to ship/track
 *  in git. 16-bit mono PCM. Two shapes:
 *   - plain (buzzer/warning/alarm): sine wave with a linear fade-out.
 *   - bell: three struck-bell "dings" spaced through the duration, each a
 *     fundamental + two slightly-sharp overtones with independent
 *     exponential decay (higher partials die out faster) — much closer to
 *     an actual bell than a looping sine, without needing a sampled asset. */
function generateToneWav({ freqHz = 880, durationMs = 1200, sampleRate = 22050, gain = 0.6, bell = false } = {}) {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const dataSize = numSamples * 2; /* 16-bit mono */
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);          /* fmt chunk size */
  buf.writeUInt16LE(1, 20);           /* PCM */
  buf.writeUInt16LE(1, 22);           /* mono */
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); /* byte rate */
  buf.writeUInt16LE(2, 32);           /* block align */
  buf.writeUInt16LE(16, 34);          /* bits per sample */
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  const strikeIntervalS = bell ? (durationMs / 1000) / 3 : 0;

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    let s;
    if (bell) {
      s = 0;
      for (let k = 0; k < 3; k++) {
        const ts = t - k * strikeIntervalS;
        if (ts < 0) continue;
        s += Math.sin(2 * Math.PI * freqHz * ts) * Math.exp(-ts * 3.5) * 0.5
           + Math.sin(2 * Math.PI * freqHz * 2.4 * ts) * Math.exp(-ts * 6.0) * 0.3
           + Math.sin(2 * Math.PI * freqHz * 3.8 * ts) * Math.exp(-ts * 8.5) * 0.2;
      }
    } else {
      const fadeOut = 1 - (i / numSamples) * 0.3; /* gentle fade, avoid a click */
      s = Math.sin(2 * Math.PI * freqHz * t) * fadeOut;
    }
    /* Soft-clip (tanh) rather than hard-clamp: raises average loudness at
     * gain=1.0 through harmonic saturation instead of flat digital
     * clipping — same "loudness maximizer" idea mastering engines use,
     * meaningfully louder-sounding for the alarm/bell tiers without the
     * harsh distortion a hard clamp produces once s*gain exceeds ±1. */
    const driven = s * gain * 1.35;
    const sample = Math.tanh(driven) / Math.tanh(1.35);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, sample)) * 32767), 44 + i * 2);
  }
  return buf;
}

const toneFileCache = new Map();

function ensureToneFile(level) {
  const key = ALARM_LEVELS[level] ? level : DEFAULT_LEVEL;
  const cached = toneFileCache.get(key);
  if (cached) return cached;

  const cfg = ALARM_LEVELS[key];
  const filePath = path.join(os.tmpdir(), `sensor_n2k_alert_tone_${key}.wav`);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, generateToneWav({
      freqHz: cfg.freqHz, durationMs: cfg.toneMs, gain: cfg.gain, bell: cfg.bell,
    }));
  }
  toneFileCache.set(key, filePath);
  return filePath;
}

/** Find the PipeWire sink node for a paired Bluetooth device, if PipeWire
 *  has actually created one for it. BlueZ reporting "Connected: yes" does
 *  NOT guarantee this — PipeWire's bluez5 monitor has to separately pick
 *  the device up and register an Audio/Sink node for it (confirmed on this
 *  board's image: a JBL speaker paired/trusted/connected at the BlueZ
 *  level, but `wpctl status` showed no Bluetooth section at all — the
 *  monitor never created a node for it). Without this check, pw-cat would
 *  silently play to whatever the current default sink is (e.g. the
 *  board's built-in headphone jack) and report success, while the
 *  Bluetooth speaker gets nothing — see playFile()/speak()'s `target`. */
async function findBluezSinkTarget(mac) {
  const macUpper = mac.toUpperCase();
  return new Promise((resolve) => {
    execFile('pw-dump', { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) { resolve(null); return; }
      let objects;
      try { objects = JSON.parse(stdout); } catch (e) { resolve(null); return; }
      const node = (objects || []).find((o) => {
        const p = o.info && o.info.props;
        return o.type === 'PipeWire:Interface:Node' && p &&
          p['media.class'] === 'Audio/Sink' &&
          p['api.bluez5.address'] &&
          p['api.bluez5.address'].toUpperCase() === macUpper;
      });
      if (!node) { resolve(null); return; }
      resolve({ id: node.id, name: node.info.props['node.name'] || String(node.id) });
    });
  });
}

/** Push the sink's own PipeWire/WirePlumber mixer volume up before
 *  playback — see ALARM_LEVELS' comment on why this matters (a loud WAV
 *  is still attenuated by whatever the sink's mixer is currently set to,
 *  and for this board it was sitting at just 56%, unrelated to anything
 *  this app had done). Best-effort: a failure here still lets playback
 *  proceed at whatever volume the sink already has. */
function setSinkVolume(id, vol) {
  return new Promise((resolve) => {
    execFile('wpctl', ['set-volume', String(id), String(vol)], (err, stdout, stderr) => {
      if (err) {
        console.error('[bt-speaker] wpctl set-volume failed:', err.message, stderr && stderr.toString());
      }
      resolve(!err);
    });
  });
}

function playFile(filePath, target) {
  return new Promise((resolve) => {
    const args = ['--playback'];
    if (target) args.push('--target', target);
    args.push(filePath);
    execFile('pw-cat', args, (err, stdout, stderr) => {
      if (err) {
        console.error('[bt-speaker] pw-cat playback error:', err.message, stderr && stderr.toString());
      }
      resolve(!err);
    });
  });
}

/** Piper has no amplitude/gain flag (unlike espeak-ng's old -a) — voice
 *  loudness is controlled entirely via the sink-volume push in
 *  playAlert(), same as everything else. Deliberately NOT applying our
 *  own digital gain on top of Piper's output either: that's exactly the
 *  kind of clipping/distortion that made espeak-ng's high-amplitude
 *  tiers sound worse, not better, and clarity is the whole point of
 *  switching engines. */
function speak(text, target) {
  return new Promise((resolve) => {
    const piper = spawn(PIPER_BIN, ['--model', PIPER_MODEL, '--output_file', '-', '--quiet'],
      { env: { ...process.env, LD_LIBRARY_PATH: PIPER_DIR } });
    const args = ['--playback'];
    if (target) args.push('--target', target);
    args.push('-');
    const player = spawn('pw-cat', args);

    piper.stdin.write(text);
    piper.stdin.end();
    piper.stdout.pipe(player.stdin);
    piper.on('error', (e) => console.error('[bt-speaker] piper error:', e.message));
    player.on('error', (e) => console.error('[bt-speaker] pw-cat error:', e.message));
    player.on('close', (code) => resolve(code === 0));
  });
}

/** Tone (level-appropriate loudness/duration/timbre — see ALARM_LEVELS),
 *  then spoken text, routed to the paired Bluetooth device's PipeWire
 *  sink specifically — NOT PipeWire's system default — when mac is given.
 *  Returns false (without playing anything) if that sink doesn't exist,
 *  rather than silently succeeding by playing to whatever sink happens to
 *  be default. Omit mac to play to the default sink. level defaults to
 *  'warning' if omitted or unrecognized. */
async function playAlert(label, mac, level) {
  const cfg = ALARM_LEVELS[level] || ALARM_LEVELS[DEFAULT_LEVEL];
  const tonePath = ensureToneFile(level);

  let target = null;
  if (mac) {
    const sink = await findBluezSinkTarget(mac);
    if (!sink) {
      console.error(`[bt-speaker] no PipeWire sink for Bluetooth device ${mac} — ` +
        `it may be connected at the BlueZ level but PipeWire hasn't created an audio ` +
        `sink for it (check 'wpctl status' for a Bluetooth section)`);
      return false;
    }
    target = sink.name;
    await setSinkVolume(sink.id, cfg.sinkVolume);
  }

  const toneOk = await playFile(tonePath, target);
  const speakOk = await speak(label, target);
  return toneOk && speakOk;
}

module.exports = {
  scanDevices,
  pairAndConnect,
  getStatus,
  monitorAndReconnect,
  playAlert,
  findBluezSinkTarget,
  ALARM_LEVELS,
};
