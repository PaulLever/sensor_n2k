#!/usr/bin/env node
'use strict';

/*
 * netconfig-server.js — WiFi setup / switching for sensor_n2k, port 3005.
 *
 * Solves the "the boat moved and now the board is on a network that no
 * longer exists" problem, which until now needed a laptop, a serial/SSH
 * session, and hand-typed `nmcli` (see docs/NETWORK-SETUP.md). Three
 * pieces, all built on NetworkManager (already the network stack in use
 * on this board — do NOT reach for raw wpa_supplicant/hostapd here):
 *
 *   1. Boot-time auto-fallback. If wlan0 hasn't associated to anything
 *      within AUTO_FALLBACK timeout, raise a WPA2 access point
 *      ("UNOQ-Setup") so the setup page below is reachable from a phone
 *      with no prior network at all. NetworkManager's own hotspot mode
 *      brings its own DHCP + NAT (ipv4.method shared) — no separate
 *      hostapd/dnsmasq needed, and the page lands on NM's hotspot gateway
 *      address, 10.42.0.1.
 *
 *   2. A scan → pick → password → connect page, equally usable from the
 *      setup AP or from a normal network. Deliberately the same
 *      shape as alarm-server.js's Bluetooth pairing flow (scan endpoint,
 *      client-rendered row list, a "dirty" flag so the live poll doesn't
 *      stomp half-typed input) — see alarm-server.js:848-918 / :1412-1435.
 *
 *   3. Safe-switch-with-watchdog. Changing WiFi from a web page served
 *      over that same WiFi is a chainsaw with no guard: get the password
 *      wrong and the device is gone. So every switch arms a transient
 *      systemd timer BEFORE activating the new profile, which reverts to
 *      the previously-active profile unless the user re-loads this page
 *      from the new network and confirms. The device can't strand itself.
 *
 * Runs as root (User=root in sensor-n2k-netconfig.service): every nmcli
 * call here mutates system connection state and systemd-run needs the
 * system manager. No sudo is involved anywhere in this file — unlike
 * ota-server.js, which does need a scoped sudoers rule.
 *
 * Persists to /etc/sensor_n2k/netconfig.json (see DEFAULT_NETCONFIG),
 * same loadX()/saveX() pattern as alarm-server.js:160-182.
 *
 * NOT here (deliberately): a physical "hold button for setup mode"
 * escape hatch. bridge.js already broadcasts {type:'button'} on the local
 * bus and alarm-server.js consumes it as "cancel all alarms"; extending
 * that to also trigger setup mode is a natural follow-up, but it needs
 * (a) real, confirmed button wiring — the GPIO in
 * apps/sensor_n2k/boards/arduino_uno_q.overlay:59-75 and alarm_io.h:13-27
 * is still an unconfirmed placeholder — and (b) a long-press vs.
 * short-press distinction in the firmware so it doesn't collide with
 * alarm-cancel. Neither exists yet, so this is web-only for v1.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { SHARED_STYLE, navHtml } = require('./shared-ui');

const PORT = 3005;
const CONFIG_DIR = '/etc/sensor_n2k';
const NETCONFIG_FILE = path.join(CONFIG_DIR, 'netconfig.json');

/* The board's only real radio. p2p-dev-wlan0 also shows up in `nmcli dev
 * status` but is a P2P control device, not something to configure. */
const WIFI_IFACE = 'wlan0';

/* Transient systemd unit name for the revert watchdog. Fixed (not
 * per-switch) on purpose: there must never be two armed reverts, and a
 * fixed name makes "disarm whatever is armed" a single stop+reset-failed
 * rather than bookkeeping. */
const REVERT_UNIT = 'netconfig-revert';

/* Separate transient unit for a delayed avahi-daemon restart — see
 * scheduleAvahiRestart()'s comment for why this exists at all. Deliberately
 * its own unit, not folded into REVERT_UNIT's command line: the revert
 * target (an SSID) is untrusted input that must never touch a shell (see
 * run()'s comment), so chaining "revert && restart avahi" would need one.
 * Two separate execFile-invoked systemd-run jobs, the second with a fixed,
 * zero-argument command, sidesteps that entirely. */
const REVERT_AVAHI_UNIT = 'netconfig-revert-avahi';

/* NetworkManager's hotspot mode always uses this gateway address; shown
 * in the UI/doc so the setup URL can be written down in advance. */
const HOTSPOT_GATEWAY = '10.42.0.1';

/* ------------------------------------------------------------------ */
/* Persistence                                                          */
/* ------------------------------------------------------------------ */

/* The setup AP password is a FIXED default, not randomly generated, and
 * that's the whole point: the one moment you need it is the moment you
 * have no other way to reach the board, so it has to be knowable from the
 * install doc rather than from a page you can't load. It's editable below
 * — but if you change it, you own remembering it. (Obscurity is thin
 * security, but this AP only exists when the board has failed to join any
 * known network, and it's the recovery path of last resort.) */
const DEFAULT_NETCONFIG = {
  hotspot: {
    con_name: 'UNOQ-Setup',
    ssid: 'UNOQ-Setup',
    password: 'unoqsetup',
  },
  auto_fallback: {
    enabled: true,
    /* Long enough for a cold boot + DHCP on a slow marina AP; short
     * enough that you're not standing on the dock guessing. Same
     * "poll until ready, then give up quietly" flavor as
     * alarm-server.js's announceBootWhenReady(). */
    timeout_seconds: 60,
  },
  /* Seconds between activating a new WiFi profile and the automatic
   * revert, unless confirmed. 45s is enough to reconnect a phone to the
   * new network and hit Confirm, short enough not to leave the boat
   * offline for long if it went wrong. */
  watchdog_seconds: 45,
  /* Feature 4 (2.4GHz bridge AP) — off until the hardware spike in
   * wifiCapabilities() says the radio can do AP+STA concurrently, or
   * until a USB dongle is present as a separate ifname. */
  bridge: {
    enabled: false,
    con_name: 'UNOQ-Bridge',
    ifname: '',
    ssid: 'UNOQ-Bridge',
    password: '',
    band: 'bg',   /* bg = 2.4GHz, a = 5GHz */
    /* null = pick a sane default for the band (6 for bg, 36 for a).
     * Confirmed on real hardware that leaving the channel unset entirely
     * on a shared-phy virtual AP interface is unreliable — be explicit. */
    channel: null,
  },
};

/* Default name for the second netdev created on the built-in phy so an AP
 * can run alongside the client connection. Not `wlan1` — that name
 * belongs to a USB dongle if one is ever plugged in, and having the two
 * collide would be maddening to debug. */
const VIRTUAL_AP_IFACE = 'ap0';

function loadNetConfig() {
  try {
    if (fs.existsSync(NETCONFIG_FILE)) {
      const raw = JSON.parse(fs.readFileSync(NETCONFIG_FILE, 'utf8'));
      /* Shallow-merge each section so a config written by an older build
       * picks up newly-added keys instead of reading them as undefined. */
      return {
        hotspot: { ...DEFAULT_NETCONFIG.hotspot, ...(raw.hotspot || {}) },
        auto_fallback: { ...DEFAULT_NETCONFIG.auto_fallback, ...(raw.auto_fallback || {}) },
        watchdog_seconds: raw.watchdog_seconds || DEFAULT_NETCONFIG.watchdog_seconds,
        bridge: { ...DEFAULT_NETCONFIG.bridge, ...(raw.bridge || {}) },
      };
    }
  } catch (e) {
    console.error('[NETCFG] Read error:', e.message);
  }
  return JSON.parse(JSON.stringify(DEFAULT_NETCONFIG));
}

function saveNetConfig() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(NETCONFIG_FILE, JSON.stringify(g_cfg, null, 2));
  } catch (e) {
    console.error('[NETCFG] Write error:', e.message);
  }
}

let g_cfg = loadNetConfig();

/* ------------------------------------------------------------------ */
/* Command execution                                                    */
/* ------------------------------------------------------------------ */

/* execFile (argv array), never exec/shell — SSIDs and passphrases are
 * arbitrary user input arriving over HTTP, and a network name containing
 * `;` or a backtick must be a network name, not a command. Never resolves
 * rejected: every caller here wants to inspect the failure and carry on
 * (a failed `nmcli con up` is a normal, reportable outcome, not a crash). */
function run(cmd, args, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          stdout: stdout || '',
          stderr: stderr || '',
          error: err ? (String(stderr || '').trim() || err.message) : null,
        });
      });
  });
}

function nm(args, opts) { return run('nmcli', args, opts); }

/* nmcli's terse (-t) output is colon-separated with literal colons inside
 * values backslash-escaped — which matters here, because SSIDs and MAC
 * addresses both routinely contain colons. A naive split(':') mangles
 * both. */
function splitTerse(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; }
    else if (c === ':') { out.push(cur); cur = ''; }
    else { cur += c; }
  }
  out.push(cur);
  return out;
}

function terseLines(stdout) {
  return stdout.split('\n').map(l => l.trim()).filter(Boolean).map(splitTerse);
}

/* ------------------------------------------------------------------ */
/* NetworkManager queries                                               */
/* ------------------------------------------------------------------ */

async function deviceState(ifname = WIFI_IFACE) {
  const r = await nm(['-t', '-f', 'DEVICE,TYPE,STATE,CONNECTION', 'dev', 'status']);
  const row = terseLines(r.stdout).find(f => f[0] === ifname);
  if (!row) return { device: ifname, present: false, state: 'unavailable', connection: null };
  return { device: row[0], present: true, type: row[1], state: row[2], connection: row[3] || null };
}

/** Every wifi-capable interface NetworkManager knows about, so the bridge
 *  card can offer a USB dongle (wlan1) as an alternative to a virtual
 *  interface on the built-in radio. */
async function wifiInterfaces() {
  const r = await nm(['-t', '-f', 'DEVICE,TYPE', 'dev', 'status']);
  return terseLines(r.stdout).filter(f => f[1] === 'wifi').map(f => f[0]);
}

/** Is `ifname` a genuinely separate radio (a USB dongle), or another
 *  netdev on the built-in phy (a virtual AP interface)? Read straight
 *  from sysfs — /sys/class/net/<if>/phy80211 symlinks to the phy that
 *  owns it, so two interfaces on the same radio resolve to the same phy.
 *  Matters because a dongle is exempt from the AP+station concurrency
 *  question entirely, while a virtual interface is not. */
async function isSeparateRadio(ifname) {
  const phyOf = (n) => {
    try { return fs.realpathSync(`/sys/class/net/${n}/phy80211`); }
    catch (e) { return null; }
  };
  const mine = phyOf(ifname);
  const primary = phyOf(WIFI_IFACE);
  if (!mine || !primary) return false;   /* unknown -> treat as same radio (the cautious answer) */
  return mine !== primary;
}

/** Actively create a virtual AP interface on the same phy as wlan0.
 *
 *  CORRECTED after real-world testing in two different environments: a
 *  fresh `ap0` does NOT appear on its own no matter how long wlan0 has
 *  been associated — confirmed on a boat, on a real marina AP, 8+ minutes
 *  after boot with wlan0 fully connected and still no `ap0` anywhere.
 *  NetworkManager does not create this interface; it has to be created
 *  explicitly with `iw`. (An earlier version of this code waited
 *  passively for NM to produce it, based on a home-network observation
 *  that turned out to be a leftover interface from earlier manual testing
 *  being adopted by NM, not genuine auto-creation — a reminder that "it
 *  appeared" and "the system creates it" are not the same claim.)
 *
 *  `iw dev wlan0 interface add <name> type __ap` reliably reports "Name
 *  not unique on network" on this chipset (ath10k/WCN3990) even on a
 *  completely clean boot with no prior interface of that name at all —
 *  confirmed this is COSMETIC: the interface is created successfully
 *  despite the reported error (almost certainly an internal MAC
 *  auto-assignment step colliding with wlan0's own permanent MAC, which
 *  raiseHotspot()'s `cloned-mac-address random` setting overwrites anyway
 *  moments later). So this never trusts the command's own exit code —
 *  only whether the interface actually exists afterward.
 *
 *  Once the kernel interface exists, NetworkManager takes over
 *  completely on its own: confirmed live that a saved connection profile
 *  for that ifname with autoconnect=yes activates itself automatically
 *  within about a second of the interface appearing — no `nmcli con up`
 *  needed from this code at that point (see bridgeStartup()).
 */
async function ensureVirtualApIface(name) {
  if ((await wifiInterfaces()).includes(name)) return { ok: true, already: true };

  await run('iw', ['dev', WIFI_IFACE, 'interface', 'add', name, 'type', '__ap']);
  await run('ip', ['link', 'set', name, 'up']);

  if ((await wifiInterfaces()).includes(name)) {
    console.log(`[NETCFG] created virtual AP interface ${name} on ${WIFI_IFACE}`);
    return { ok: true, already: false };
  }
  return { ok: false, error: `"${name}" could not be created on ${WIFI_IFACE}. ` +
    '`iw` must be installed (`sudo apt install iw`), or use a USB WiFi dongle instead.' };
}

/** Docker, when present, sets the FORWARD chain's default policy to DROP
 *  and only carves out ACCEPT rules for its own bridge networks —
 *  confirmed on real hardware that this silently blocks all forwarded
 *  traffic between a NetworkManager-managed AP and its uplink even though
 *  NetworkManager's own NAT/forward rules (its `nm-shared-<ifname>`
 *  nftables table) are entirely correct on their own. A client joins the
 *  AP, gets a DHCP lease, can reach the board itself — and gets no
 *  internet, with nothing in NetworkManager's own logs to explain why.
 *
 *  DOCKER-USER is the chain Docker itself documents and reserves for
 *  exactly this: it's evaluated before Docker's own rules and Docker never
 *  overwrites or flushes anything already in it. Absolute path, not just
 *  `iptables` — this runs from a systemd service whose PATH is not
 *  guaranteed to include /usr/sbin (confirmed different from an
 *  interactive login shell's PATH on this board).
 *
 *  A no-op — logged, not treated as an error — on any board without
 *  Docker, or where dockerd hasn't created its base chains yet. Retries
 *  for up to 30s to cover the boot race where this service (which starts
 *  After=NetworkManager.service) comes up before docker.service has. */
async function ensureDockerForwardRules(apIface, uplinkIface) {
  const IPTABLES = '/usr/sbin/iptables';
  const deadline = Date.now() + 30000;
  let haveChain = false;
  while (Date.now() < deadline) {
    if ((await run(IPTABLES, ['-L', 'DOCKER-USER', '-n'])).ok) { haveChain = true; break; }
    await new Promise(r => setTimeout(r, 3000));
  }
  if (!haveChain) {
    console.log('[NETCFG] no DOCKER-USER chain found (Docker not installed, or not started yet) — nothing to do');
    return;
  }
  const rules = [
    ['-i', apIface, '-o', uplinkIface, '-j', 'ACCEPT'],
    ['-i', uplinkIface, '-o', apIface, '-m', 'state', '--state', 'RELATED,ESTABLISHED', '-j', 'ACCEPT'],
  ];
  for (const rule of rules) {
    if ((await run(IPTABLES, ['-C', 'DOCKER-USER', ...rule])).ok) continue;   /* already present */
    const insert = await run(IPTABLES, ['-I', 'DOCKER-USER', '1', ...rule]);
    if (!insert.ok) console.warn('[NETCFG] failed to add DOCKER-USER forwarding rule:', insert.error);
  }
  console.log(`[NETCFG] DOCKER-USER forwarding rules ensured for ${apIface} <-> ${uplinkIface}`);
}

/** Name of the connection profile currently active on `ifname`, or null.
 *  This is the revert target for the watchdog — deliberately whatever is
 *  active right now, which may be a normal network OR the setup hotspot
 *  (first-boot case), so one code path covers both. */
async function activeProfile(ifname = WIFI_IFACE) {
  const r = await nm(['-t', '-f', 'NAME,TYPE,DEVICE', 'con', 'show', '--active']);
  const row = terseLines(r.stdout).find(f => f[2] === ifname && f[1] === '802-11-wireless');
  return row ? row[0] : null;
}

async function profileExists(name) {
  if (!name) return false;
  const r = await nm(['-t', '-f', 'connection.id', 'con', 'show', name]);
  return r.ok;
}

/** True if the named profile is an access point rather than a client
 *  connection. Checked via the profile's actual 802-11-wireless.mode
 *  rather than by comparing against the configured hotspot name — a
 *  hotspot raised by hand, or left over under a different name, still has
 *  to be recognised as "we are in AP mode". */
async function isApProfile(name) {
  if (!name) return false;
  const r = await nm(['-t', '-f', '802-11-wireless.mode', 'con', 'show', name]);
  return /(^|:)ap\s*$/i.test(r.stdout.trim());
}

/* The last real (non-AP) profile we were actually on. Tracked separately
 * from activeProfile() because once the setup hotspot is up, "currently
 * active" IS the hotspot — using that as a watchdog/teardown fallback
 * target means a failed switch-from-setup-mode reverts back into setup
 * mode instead of the network the board was actually working on before
 * "Reconfigure WiFi" was pressed. Confirmed on real hardware: without
 * this, dropHotspot() had nothing better than NetworkManager's generic
 * `dev connect` autoconnect heuristic to fall back on, which left the
 * board stuck showing "connected: UNOQ-Setup" even after the hotspot
 * connection itself was torn down. null only means "never seen a real
 * network at all" — genuine first boot, where the setup hotspot really
 * is the only place left to fall back to. */
let lastKnownGoodProfile = null;

/** Refreshes and returns the best "real network" fallback target: the
 *  active profile right now if it's a real (non-AP) connection — in
 *  which case it's also remembered for next time — otherwise whatever
 *  was last remembered, otherwise null. */
async function realFallbackProfile() {
  const active = await activeProfile();
  if (active && !(await isApProfile(active))) {
    lastKnownGoodProfile = active;
    return active;
  }
  return lastKnownGoodProfile;
}

async function savedWifiProfiles() {
  const r = await nm(['-t', '-f', 'NAME,TYPE,AUTOCONNECT', 'con', 'show']);
  return terseLines(r.stdout)
    .filter(f => f[1] === '802-11-wireless')
    .map(f => ({ name: f[0], autoconnect: f[2] === 'yes' }));
}

/** Scan results, deduped by SSID keeping the strongest BSS. Hidden
 *  networks (empty SSID) are dropped — there's nothing useful to show,
 *  and the form has a "hidden network" path for those. */
async function scanNetworks({ rescan = true } = {}) {
  if (rescan) {
    /* Fails with "Scanning not allowed immediately following previous
     * scan" if NM scanned seconds ago — harmless, the cached list below
     * is still fresh in exactly that case. Result deliberately ignored. */
    await nm(['dev', 'wifi', 'rescan', 'ifname', WIFI_IFACE], { timeoutMs: 25000 });
  }
  const r = await nm(['-t', '-f', 'SSID,SIGNAL,SECURITY,IN-USE', 'dev', 'wifi', 'list',
    'ifname', WIFI_IFACE], { timeoutMs: 25000 });
  const bySsid = new Map();
  for (const f of terseLines(r.stdout)) {
    const ssid = f[0];
    if (!ssid) continue;
    const signal = parseInt(f[1] || '0', 10) || 0;
    const security = (f[2] || '').trim();
    const inUse = (f[3] || '').trim() === '*';
    const prev = bySsid.get(ssid);
    if (!prev || signal > prev.signal) {
      bySsid.set(ssid, { ssid, signal, security, open: security === '' || security === '--', inUse });
    } else if (inUse) {
      prev.inUse = true;
    }
  }
  return Array.from(bySsid.values()).sort((a, b) => b.signal - a.signal);
}

/** First non-internal IPv4 address, preferring wlan0. Same helper (and
 *  same reasoning) as alarm-server.js's currentIpAddress() — duplicated
 *  rather than shared because pulling it into shared-ui.js would put
 *  network plumbing in a file that is otherwise pure presentation. */
function currentIpAddress() {
  const ifaces = os.networkInterfaces();
  const order = ifaces[WIFI_IFACE] ? [WIFI_IFACE] : Object.keys(ifaces);
  for (const name of order) {
    const addrs = ifaces[name];
    if (!addrs) continue;
    const v4 = addrs.find(a => a.family === 'IPv4' && !a.internal);
    if (v4) return v4.address;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Hotspot — ONE helper, shared by the setup AP (Feature 1) and the      */
/* 2.4GHz bridge AP (Feature 4). Deliberately not two copies of         */
/* `nmcli dev wifi hotspot`: the flags that matter (autoconnect,         */
/* ipv4 sharing, band) are exactly the ones that are easy to get subtly  */
/* different between two call sites and then debug for an hour.          */
/* ------------------------------------------------------------------ */

/**
 * Raise an access point on `ifname`.
 *
 * `nmcli dev wifi hotspot` creates the profile AND activates it in one
 * step, and sets ipv4.method=shared itself — that's what provides DHCP to
 * clients and NAT out through whatever else is connected, so there is no
 * hostapd/dnsmasq to install or configure.
 *
 * @param {object}  o
 * @param {string}  o.ifname      interface to host the AP on
 * @param {string}  o.conName     stable profile name (so it can be
 *                                re-activated later by name — the revert
 *                                watchdog relies on this)
 * @param {string}  o.ssid
 * @param {string}  o.password    WPA2 passphrase, >= 8 chars
 * @param {string?} o.band        'bg' (2.4GHz) | 'a' (5GHz) | null (NM picks)
 * @param {boolean} o.autoconnect persist across reboot? FALSE for the
 *                                setup AP (otherwise a board that once
 *                                fell back to setup mode could prefer its
 *                                own AP over the real network forever),
 *                                TRUE for the bridge AP (which is meant
 *                                to be permanently up).
 * @param {number?} o.channel     explicit channel within `band` (bridge AP
 *                                only — see below for why this matters).
 */
async function raiseHotspot({ ifname, conName, ssid, password, band = null, channel = null, autoconnect = false }) {
  if (!password || password.length < 8) {
    return { ok: false, error: 'WPA2 passphrase must be at least 8 characters' };
  }
  /* Delete any same-named profile first so repeated calls are idempotent
   * rather than accumulating "UNOQ-Setup 1", "UNOQ-Setup 2", … — nmcli
   * happily creates duplicate profiles with suffixed names, and the
   * watchdog's `nmcli con up <name>` would then be ambiguous. Failure is
   * expected and ignored on the first-ever call (nothing to delete). */
  await nm(['con', 'delete', conName]);

  if (ifname === WIFI_IFACE) {
    /* The proven, live-tested path for the setup AP: wlan0 is a single
     * real interface with its own real MAC, so none of the shared-phy
     * concerns below apply. Left exactly as validated — do not fold this
     * into the branch below without re-testing the setup-AP flow. */
    const args = ['dev', 'wifi', 'hotspot', 'ifname', ifname, 'con-name', conName,
      'ssid', ssid, 'password', password];
    if (band) args.push('band', band);
    const r = await nm(args, { timeoutMs: 40000 });
    if (!r.ok) return { ok: false, error: r.error };
    await nm(['con', 'modify', conName, 'connection.autoconnect', autoconnect ? 'yes' : 'no']);
    console.log(`[NETCFG] hotspot up: ${ssid} on ${ifname} (autoconnect=${autoconnect})`);
    return { ok: true, gateway: HOTSPOT_GATEWAY };
  }

  /* A second netdev on the same phy as wlan0 (ap0) or a USB dongle. Built
   * explicitly (add, then modify, then up) rather than via the one-shot
   * `nmcli dev wifi hotspot` convenience command above, so two settings
   * can be forced BEFORE first activation — confirmed on real hardware
   * that leaving either at NetworkManager's own default breaks this
   * completely, in two different ways:
   *
   *   - cloned-mac-address: ap0 and wlan0 share the same phy, so they
   *     also share the same PERMANENT hardware MAC. NM's default
   *     ("preserve") tries to use that permanent MAC for ap0 too, which
   *     fails activation immediately with "Name not unique on network"
   *     the moment wlan0 is already up and using it. A USB dongle is a
   *     separate radio with its own distinct MAC and doesn't need this,
   *     hence the isSeparateRadio() check below.
   *   - pmf / proto: NetworkManager's default AP security profile for a
   *     plain `wifi-sec.key-mgmt wpa-psk` setting is actually a mixed
   *     WPA2/WPA3-SAE "transition mode" (confirmed via the generated
   *     wpa_supplicant config: `key_mgmt WPA-PSK WPA-PSK-SHA256 SAE`).
   *     Real client devices have been observed joining this SSID, getting
   *     as far as association, and then silently giving up with no error
   *     shown anywhere — forcing plain WPA2-PSK/RSN only (pmf disabled)
   *     fixed it immediately, with no visible downside for a local
   *     convenience AP.
   */
  const add = await nm(['con', 'add', 'type', 'wifi', 'ifname', ifname, 'con-name', conName,
    'autoconnect', 'no', 'ssid', ssid]);
  if (!add.ok) return { ok: false, error: add.error };

  const modifyArgs = ['con', 'modify', conName,
    '802-11-wireless.mode', 'ap',
    'wifi-sec.key-mgmt', 'wpa-psk',
    'wifi-sec.psk-flags', '0',
    'wifi-sec.psk', password,
    '802-11-wireless-security.pmf', '1',
    '802-11-wireless-security.proto', 'rsn',
    'ipv4.method', 'shared',
  ];
  if (band) {
    modifyArgs.push('802-11-wireless.band', band);
    modifyArgs.push('802-11-wireless.channel', String(channel || (band === 'a' ? 36 : 6)));
  }
  if (!(await isSeparateRadio(ifname))) {
    modifyArgs.push('802-11-wireless.cloned-mac-address', 'random');
  }
  const mod = await nm(modifyArgs);
  if (!mod.ok) { await nm(['con', 'delete', conName]); return { ok: false, error: mod.error }; }

  const up = await nm(['con', 'up', conName, 'ifname', ifname], { timeoutMs: 40000 });
  if (!up.ok) return { ok: false, error: up.error };

  await nm(['con', 'modify', conName, 'connection.autoconnect', autoconnect ? 'yes' : 'no']);
  console.log(`[NETCFG] hotspot up: ${ssid} on ${ifname} (autoconnect=${autoconnect})`);
  return { ok: true, gateway: HOTSPOT_GATEWAY };
}

/** Bring an AP down and hand the interface back to normal autoconnect, so
 *  the board rejoins a known network on its own instead of sitting idle. */
async function dropHotspot(conName, ifname = WIFI_IFACE) {
  const down = await nm(['con', 'down', conName]);

  /* Prefer explicitly reactivating the network we know we were on before
   * — confirmed unreliable otherwise: NetworkManager's own `dev connect`
   * autoconnect heuristic right after tearing down an AP has been
   * observed leaving the radio stuck showing the dead hotspot connection
   * as still "connected" even though `con down` itself reported success. */
  if (lastKnownGoodProfile && await profileExists(lastKnownGoodProfile)) {
    const up = await nm(['con', 'up', lastKnownGoodProfile, 'ifname', ifname], { timeoutMs: 40000 });
    if (up.ok) {
      console.log(`[NETCFG] hotspot down: ${conName} — back on "${lastKnownGoodProfile}"`);
      await scheduleAvahiRestart(5);
      return { ok: true, error: null };
    }
    console.warn(`[NETCFG] hotspot down: ${conName}, but reactivating "${lastKnownGoodProfile}" failed (${up.error}) — falling back to autoconnect`);
  }

  /* No known-good profile (genuine first boot, nothing to return to) or
   * it failed to reactivate — last resort, let NM's own autoconnect
   * logic pick something. */
  await nm(['dev', 'connect', ifname], { timeoutMs: 40000 });
  console.log(`[NETCFG] hotspot down: ${conName}`);
  await scheduleAvahiRestart(5);
  return { ok: down.ok, error: down.error };
}

async function startSetupHotspot() {
  /* Remember whatever real network we're about to leave, if any, so
   * dropHotspot() and a later revert have somewhere real to go back to
   * instead of just re-running NM's generic autoconnect guess. */
  await realFallbackProfile();
  const h = g_cfg.hotspot;
  return raiseHotspot({
    ifname: WIFI_IFACE, conName: h.con_name, ssid: h.ssid, password: h.password,
    autoconnect: false,
  });
}

/* ------------------------------------------------------------------ */
/* Revert watchdog                                                      */
/* ------------------------------------------------------------------ */

/* { target, revertTo, armedAt, expiresAt, error } while a switch is
 * awaiting confirmation. In memory only — this service keeps running
 * straight through the network change (nothing restarts it), and
 * persisting it would only create a stale-state problem after a reboot
 * that already resolved itself. */
let pendingSwitch = null;
let pendingExpiryTimer = null;

/* Stop both the timer and any service instance a systemd-run unit may
 * already have spawned, then reset-failed so a later systemd-run can
 * reuse the same fixed unit name — without the reset, a unit left in
 * `failed` state makes the next arm fail with "unit already exists". */
async function disarmUnit(unit) {
  await run('systemctl', ['stop', `${unit}.timer`]);
  await run('systemctl', ['stop', `${unit}.service`]);
  await run('systemctl', ['reset-failed', `${unit}.timer`]);
  await run('systemctl', ['reset-failed', `${unit}.service`]);
}

async function disarmWatchdog() {
  await disarmUnit(REVERT_UNIT);
}

/**
 * A network change made by this service (switch, hotspot up/down) can
 * leave avahi-daemon showing "unoq-2.local" instead of "unoq.local" —
 * confirmed on real hardware, and confirmed NOT caused by a second real
 * device also named "unoq" on the network. avahi's own conflict detection
 * re-probes on every interface event, and a fast reconnect can make it see
 * a stale/reflected copy of its OWN prior announcement (still lingering in
 * the AP's forwarding tables) and back off, permanently, until something
 * restarts it. Since this service now causes network changes far more
 * often than before this feature existed, give avahi a clean restart a
 * few seconds after each change settles rather than trusting its own
 * probe timing mid-transition.
 *
 * A transient systemd-run job, not an in-process setTimeout, for the same
 * reason armWatchdog() uses one: it must survive this service being
 * restarted mid-switch. Always fixed, zero-argument command — see
 * REVERT_AVAHI_UNIT's comment for why this is a separate unit rather than
 * chained onto the revert command.
 */
async function scheduleAvahiRestart(afterSeconds) {
  await disarmUnit(REVERT_AVAHI_UNIT);
  const r = await run('systemd-run',
    ['--unit', REVERT_AVAHI_UNIT, `--on-active=${afterSeconds}s`,
      '/usr/bin/systemctl', 'restart', 'avahi-daemon']);
  if (!r.ok) console.warn('[NETCFG] failed to schedule avahi-daemon restart:', r.error);
}

/**
 * Arm the automatic revert. MUST be called before activating the new
 * profile, never after: the moment the new profile comes up this process
 * may be unreachable, and an unarmed watchdog at that point is exactly
 * the bricked-network scenario this whole mechanism exists to prevent.
 *
 * Uses a transient systemd timer rather than an in-process setTimeout so
 * the revert survives this service crashing, being restarted, or being
 * OOM-killed during the switch.
 */
async function armWatchdog(revertTo, seconds) {
  await disarmWatchdog();
  const r = await run('systemd-run',
    ['--unit', REVERT_UNIT, `--on-active=${seconds}s`,
      '/usr/bin/nmcli', 'con', 'up', revertTo, 'ifname', WIFI_IFACE]);
  if (r.ok) console.log(`[NETCFG] revert watchdog armed: back to "${revertTo}" in ${seconds}s`);
  else console.error('[NETCFG] failed to arm revert watchdog:', r.error);
  /* Unconditional: whichever way this resolves (confirmed on the new
   * network, or reverted back), the network will have changed by then. */
  await scheduleAvahiRestart(seconds + 5);
  return r;
}

function clearPending() {
  pendingSwitch = null;
  clearTimeout(pendingExpiryTimer);
  pendingExpiryTimer = null;
}

/* ------------------------------------------------------------------ */
/* Connect / switch                                                     */
/* ------------------------------------------------------------------ */

/** Create-or-update a client profile for `ssid`. Profile names follow
 *  NetworkManager's own convention of con-name == SSID (that's what
 *  `nmcli dev wifi connect` produces, and every profile already on this
 *  board follows it), which keeps "which profile is this network?"
 *  answerable without a second lookup. */
async function ensureWifiProfile(ssid, password, hidden) {
  const name = ssid;
  const exists = await profileExists(name);

  if (!exists) {
    const add = await nm(['con', 'add', 'type', 'wifi', 'con-name', name,
      'ifname', WIFI_IFACE, 'ssid', ssid]);
    if (!add.ok) return { ok: false, error: add.error };
  }

  if (hidden) await nm(['con', 'modify', name, '802-11-wireless.hidden', 'yes']);

  if (password) {
    /* wifi-sec.psk-flags 0 (NM_SETTING_SECRET_FLAG_NONE) is explicit on
     * purpose, not NetworkManager's default for a modify-after-add on
     * every NM version — confirmed on real hardware: without forcing
     * this, a profile could activate successfully once right after its
     * password was set (secret still fresh in NM's own memory from the
     * modify that just happened), then fail a later activation with
     * "Secrets were required, but not provided" once NM had to actually
     * reload the secret from storage instead of reusing what it already
     * had in hand. Forcing flags=0 guarantees the secret is durably
     * stored in the connection file itself, not dependent on flags a
     * given NM version happened to default to. */
    const sec = await nm(['con', 'modify', name,
      'wifi-sec.key-mgmt', 'wpa-psk',
      'wifi-sec.psk-flags', '0',
      'wifi-sec.psk', password]);
    if (!sec.ok) return { ok: false, error: sec.error };
  } else if (!exists) {
    /* Open network: clear security explicitly rather than leaving the
     * key-mgmt NM defaults in place on a freshly-added profile. */
    await nm(['con', 'modify', name, 'wifi-sec.key-mgmt', '']);
  }

  await nm(['con', 'modify', name, 'connection.autoconnect', 'yes']);
  return { ok: true, name };
}

/**
 * Bring the new profile up in the background and clean up after a fast
 * failure. Runs detached from the HTTP response on purpose: activating a
 * different WiFi network tears down the very TCP connection carrying the
 * response, so waiting for it before replying would mean the browser
 * usually sees a dead socket instead of the "now reconnect and confirm"
 * instructions it needs.
 */
async function runSwitch(name, revertTo) {
  const r = await nm(['con', 'up', name, 'ifname', WIFI_IFACE], { timeoutMs: 60000 });
  if (r.ok) {
    console.log(`[NETCFG] activated "${name}" — awaiting confirmation`);
    /* In-process, not the systemd-run job armWatchdog() already scheduled
     * for the far end of the watchdog window (that one exists to cover a
     * later revert, which needs to survive this process restarting; this
     * one just closes the gap between "switch succeeded" and "that later
     * job fires", so unoq.local doesn't sit wrong for up to 50s after a
     * switch that actually worked immediately). This process is still
     * alive here — the switch succeeding means the connection came up on
     * *this* device, not that this service went anywhere. */
    setTimeout(() => {
      run('systemctl', ['restart', 'avahi-daemon']).then((rr) => {
        if (!rr.ok) console.warn('[NETCFG] avahi-daemon restart failed:', rr.error);
      });
    }, 3000);
    return;
  }
  /* Failed immediately (wrong passphrase, AP out of range) — we're most
   * likely still on the old network with the caller still connected, so
   * don't make them sit out the full watchdog window for a switch that
   * has already provably failed. Revert now and leave the error where the
   * status poll will find it. */
  console.error(`[NETCFG] activation of "${name}" failed:`, r.error);
  await disarmWatchdog();
  if (revertTo) await nm(['con', 'up', revertTo, 'ifname', WIFI_IFACE]);
  if (pendingSwitch) pendingSwitch.error = r.error || 'activation failed';
  clearTimeout(pendingExpiryTimer);
  pendingExpiryTimer = setTimeout(clearPending, 30000);
}

/* ------------------------------------------------------------------ */
/* Feature 4 spike: does this radio do AP + station at the same time?    */
/* ------------------------------------------------------------------ */

/* Parse `iw list`'s "valid interface combinations:" block. This CANNOT be
 * inferred from anything in the repo or from nmcli — it is a property of
 * the specific chipset/driver, so the bridge feature stays disabled until
 * this says otherwise on real hardware.
 *
 * Block shape (indentation is the only reliable delimiter — the lines
 * after it are ordinary `iw list` capability lines at a shallower
 * indent):
 *
 *   valid interface combinations:
 *      * #{ managed } <= 1, #{ AP } <= 1, #{ P2P-device } <= 1,
 *        total <= 3, #channels <= 1
 */
function parseInterfaceCombinations(text) {
  const entries = [];
  let baseIndent = null;
  let cur = null;

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const line = raw.trim();
    const indent = raw.length - raw.replace(/^\s+/, '').length;

    if (baseIndent === null) {
      if (/^valid interface combinations:/i.test(line)) baseIndent = indent;
      continue;
    }
    if (indent <= baseIndent) {
      /* Dedented back out of the block. Reset so a second phy's block
       * later in the same output is still picked up. */
      if (cur) { entries.push(cur); cur = null; }
      baseIndent = null;
      if (/^valid interface combinations:/i.test(line)) baseIndent = indent;
      continue;
    }
    if (line.startsWith('*')) {
      if (cur) entries.push(cur);
      cur = line.replace(/^\*\s*/, '');
    } else if (cur) {
      cur += ' ' + line;
    }
  }
  if (cur) entries.push(cur);
  return entries.map(parseCombo);
}

function parseCombo(s) {
  const groups = [];
  const groupRe = /#\{([^}]*)\}\s*<=\s*(\d+)/g;
  let m;
  while ((m = groupRe.exec(s)) !== null) {
    groups.push({
      types: m[1].split(',').map(t => t.trim()).filter(Boolean),
      max: parseInt(m[2], 10),
    });
  }
  const total = /total\s*<=\s*(\d+)/.exec(s);
  const channels = /#channels\s*<=\s*(\d+)/.exec(s);
  return {
    raw: s.replace(/\s+/g, ' ').trim(),
    groups,
    total: total ? parseInt(total[1], 10) : null,
    channels: channels ? parseInt(channels[1], 10) : null,
  };
}

/** Can this combination hold an AP and a station at the same time? Either
 *  one group permits both types with a count of >= 2, or two distinct
 *  groups cover them separately. */
function comboSupportsApSta(c) {
  if (c.total != null && c.total < 2) return false;
  const has = (g, t) => g.types.includes(t);
  for (const g of c.groups) {
    if (has(g, 'AP') && has(g, 'managed') && g.max >= 2) return true;
  }
  const aps = c.groups.filter(g => has(g, 'AP') && g.max >= 1);
  const stas = c.groups.filter(g => has(g, 'managed') && g.max >= 1);
  for (const a of aps) for (const s of stas) if (a !== s) return true;
  return false;
}

/* Fallback when `iw` isn't installed (it isn't, on this board's stock
 * image). Reads the same NL80211_ATTR_INTERFACE_COMBINATIONS from the
 * kernel over generic netlink and emits the identical shape parseCombo()
 * produces, so everything downstream is unchanged. Python because Node
 * can't open an AF_NETLINK socket without a native addon, and this
 * project takes no new dependencies — see iface-combinations.py. */
const NL_HELPER = path.join(__dirname, 'iface-combinations.py');

async function combinationsViaNetlink() {
  if (!fs.existsSync(NL_HELPER)) return null;
  const r = await run('python3', [NL_HELPER, '--json'], { timeoutMs: 15000 });
  if (!r.ok) return null;
  try {
    const parsed = JSON.parse(r.stdout);
    if (parsed.error || !Array.isArray(parsed.combos)) return null;
    return parsed.combos;
  } catch (e) {
    return null;
  }
}

async function wifiCapabilities() {
  const ifaces = await wifiInterfaces();
  /* More than one wifi interface means a USB dongle is present, which
   * makes the whole concurrency question moot — the dongle can be the
   * dedicated AP regardless of what the built-in radio can do. */
  const extraIfaces = ifaces.filter(i => i !== WIFI_IFACE && !i.startsWith('p2p-'));

  /* `iw list` first — it's the documented tool and the thing a human will
   * reach for to double-check this. Netlink fallback second. */
  let combos = null;
  let source = null;
  const iwOut = await run('iw', ['list'], { timeoutMs: 15000 });
  if (iwOut.ok) {
    combos = parseInterfaceCombinations(iwOut.stdout);
    source = 'iw list';
  }
  if (!combos || combos.length === 0) {
    const viaNetlink = await combinationsViaNetlink();
    if (viaNetlink && viaNetlink.length) { combos = viaNetlink; source = 'nl80211 (iface-combinations.py)'; }
  }

  if (!combos || combos.length === 0) {
    return {
      ifaces, extraIfaces,
      spikeRun: false,
      concurrentApSta: null,
      dualBand: null,
      combos: [],
      source: null,
      note: 'Could not read the radio\'s interface combinations, so its AP+station ' +
        'capability is UNKNOWN. Neither `iw list` nor the built-in nl80211 helper ' +
        '(iface-combinations.py) returned anything — install iw (`sudo apt install iw`) ' +
        'and reload. A USB WiFi dongle sidesteps the question entirely — see ' +
        'docs/NETWORK-SETUP.md.',
    };
  }

  const supporting = combos.filter(comboSupportsApSta);
  return {
    ifaces, extraIfaces,
    spikeRun: true,
    source,
    concurrentApSta: supporting.length > 0,
    /* #channels <= 2 means the AP and the station may sit on different
     * channels, i.e. genuinely different bands (2.4GHz AP + 5GHz client).
     * With #channels <= 1 a concurrent AP is still possible but is pinned
     * to the client's channel, which defeats the point of the bridge. */
    dualBand: supporting.some(c => c.channels != null && c.channels >= 2),
    combos: combos.map(c => ({ raw: c.raw, apSta: comboSupportsApSta(c), channels: c.channels })),
    note: null,
  };
}

/* ------------------------------------------------------------------ */
/* HTTP API + webapp                                                    */
/* ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 65536) req.destroy(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function statusPayload() {
  const dev = await deviceState();
  const active = await activeProfile();
  const apMode = await isApProfile(active);
  return {
    iface: WIFI_IFACE,
    state: dev.state,
    present: dev.present,
    profile: active,
    apMode,
    ip: currentIpAddress(),
    hotspot: {
      ssid: g_cfg.hotspot.ssid,
      password: g_cfg.hotspot.password,
      con_name: g_cfg.hotspot.con_name,
      gateway: HOTSPOT_GATEWAY,
      active: apMode && active === g_cfg.hotspot.con_name,
    },
    auto_fallback: g_cfg.auto_fallback,
    watchdog_seconds: g_cfg.watchdog_seconds,
    pending: pendingSwitch
      ? { ...pendingSwitch, secondsLeft: Math.max(0, Math.round((pendingSwitch.expiresAt - Date.now()) / 1000)) }
      : null,
  };
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/status') {
    json(res, 200, await statusPayload());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/wifi/scan') {
    const networks = await scanNetworks({ rescan: url.searchParams.get('rescan') !== '0' });
    json(res, 200, { networks });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/wifi/saved') {
    json(res, 200, { profiles: await savedWifiProfiles() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/wifi/connect') {
    const body = JSON.parse(await readBody(req));
    const ssid = (body.ssid || '').trim();
    if (!ssid) { json(res, 400, { ok: false, error: 'ssid required' }); return true; }

    const prof = await ensureWifiProfile(ssid, body.password || '', !!body.hidden);
    if (!prof.ok) { json(res, 500, { ok: false, error: prof.error }); return true; }

    /* realFallbackProfile(), not activeProfile(): switching *from* the
     * setup hotspot (the "Reconfigure WiFi" flow, not first boot) must
     * revert to the real network the board was actually working on
     * before setup mode was entered, not back into setup mode itself —
     * confirmed on real hardware that without this distinction, a failed
     * switch away from the hotspot just reverts to the hotspot, leaving
     * the board sitting in setup mode instead of back on a working
     * network it already had. */
    const revertTo = await realFallbackProfile();
    const seconds = g_cfg.watchdog_seconds;

    if (revertTo && revertTo !== prof.name) {
      /* Arm BEFORE activating — see armWatchdog()'s comment. */
      const armed = await armWatchdog(revertTo, seconds);
      if (!armed.ok) {
        json(res, 500, { ok: false, error: 'could not arm revert watchdog, refusing to switch: ' + armed.error });
        return true;
      }
      pendingSwitch = {
        target: prof.name, revertTo, armedAt: Date.now(),
        expiresAt: Date.now() + seconds * 1000, error: null,
      };
      clearTimeout(pendingExpiryTimer);
      /* Local mirror of the systemd timer, only so the UI stops showing a
       * countdown that already elapsed. The real revert is systemd's. */
      pendingExpiryTimer = setTimeout(clearPending, (seconds + 15) * 1000);
    } else {
      clearPending();
    }

    /* Reply first, switch after — the switch kills this socket. */
    json(res, 200, {
      ok: true, profile: prof.name, revertTo,
      watchdogSeconds: revertTo && revertTo !== prof.name ? seconds : 0,
    });
    runSwitch(prof.name, revertTo);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/wifi/confirm') {
    await disarmWatchdog();
    clearPending();
    console.log('[NETCFG] switch confirmed by user — revert watchdog disarmed');
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/wifi/revert') {
    /* Manual "undo now", rather than waiting out the watchdog. */
    const target = pendingSwitch && pendingSwitch.revertTo;
    await disarmWatchdog();
    clearPending();
    if (!target) { json(res, 400, { ok: false, error: 'nothing to revert to' }); return true; }
    json(res, 200, { ok: true, revertTo: target });
    nm(['con', 'up', target, 'ifname', WIFI_IFACE]);
    return true;
  }

  const forgetMatch = url.pathname.match(/^\/api\/wifi\/forget\/(.+)$/);
  if (req.method === 'POST' && forgetMatch) {
    const name = decodeURIComponent(forgetMatch[1]);
    const activeNow = await activeProfile();
    if (name === activeNow) {
      json(res, 400, { ok: false, error: 'refusing to delete the network this board is currently using' });
      return true;
    }
    const r = await nm(['con', 'delete', name]);
    json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/hotspot/start') {
    /* Reply before raising the AP: this drops whatever network the caller
     * is on, so the response has to be out the door first. */
    json(res, 200, {
      ok: true, ssid: g_cfg.hotspot.ssid, password: g_cfg.hotspot.password,
      gateway: HOTSPOT_GATEWAY, port: PORT,
    });
    setTimeout(() => {
      startSetupHotspot().then(r => {
        if (!r.ok) console.error('[NETCFG] manual hotspot start failed:', r.error);
      });
    }, 500);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/hotspot/stop') {
    json(res, 200, { ok: true });
    setTimeout(() => { dropHotspot(g_cfg.hotspot.con_name); }, 500);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/hotspot/settings') {
    const body = JSON.parse(await readBody(req));
    const ssid = (body.ssid || '').trim();
    const password = body.password || '';
    if (!ssid) { json(res, 400, { ok: false, error: 'ssid required' }); return true; }
    if (password.length < 8) { json(res, 400, { ok: false, error: 'passphrase must be at least 8 characters' }); return true; }
    g_cfg.hotspot.ssid = ssid;
    g_cfg.hotspot.password = password;
    if (typeof body.auto_fallback_enabled === 'boolean') {
      g_cfg.auto_fallback.enabled = body.auto_fallback_enabled;
    }
    if (body.auto_fallback_timeout) {
      g_cfg.auto_fallback.timeout_seconds = parseInt(body.auto_fallback_timeout, 10) || 60;
    }
    saveNetConfig();
    json(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/capabilities') {
    json(res, 200, await wifiCapabilities());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/bridge') {
    const active = g_cfg.bridge.con_name ? await profileExists(g_cfg.bridge.con_name) : false;
    json(res, 200, { config: g_cfg.bridge, profileExists: active });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/bridge/virtual-iface') {
    /* Concurrency needs a SECOND netdev on the same phy — one interface
     * cannot be a client and an AP at once, no matter what the driver's
     * interface combinations allow. See ensureVirtualApIface()'s comment:
     * this interface does not appear on its own and has to be created
     * explicitly. */
    const body = JSON.parse(await readBody(req) || '{}');
    const name = (body.name || VIRTUAL_AP_IFACE).trim();
    if (!/^[a-z0-9_-]{1,15}$/i.test(name)) { json(res, 400, { ok: false, error: 'invalid interface name' }); return true; }

    const r = await ensureVirtualApIface(name);
    if (!r.ok) { json(res, 500, { ok: false, error: r.error }); return true; }
    json(res, 200, { ok: true, name, already: r.already });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/bridge') {
    const body = JSON.parse(await readBody(req));
    const enabled = !!body.enabled;
    const ifname = (body.ifname || '').trim() || g_cfg.bridge.ifname;
    const ssid = (body.ssid || '').trim() || g_cfg.bridge.ssid;
    const password = body.password || g_cfg.bridge.password;
    const band = body.band === 'a' ? 'a' : 'bg';

    if (enabled) {
      if (!ifname) {
        json(res, 400, { ok: false, error: 'pick an interface for the bridge access point' });
        return true;
      }
      if (ifname === WIFI_IFACE) {
        /* Hard refusal, and NOT the same question as "can this radio do
         * AP+STA". A single netdev is either a client or an AP; raising
         * the AP here tears down the uplink and, on this board, that is
         * the only way back in. Concurrency is achieved with a second
         * netdev on the same phy (see /api/bridge/virtual-iface), or with
         * a USB dongle — never by reusing wlan0. If what you actually
         * want is "take wlan0 over as an AP", that is the setup access
         * point, above. */
        json(res, 400, { ok: false, error:
          `Refusing to host the bridge on ${WIFI_IFACE} — that is the interface carrying the ` +
          'upstream connection, and one interface cannot be both a client and an access point. ' +
          'Create a virtual AP interface on the same radio, or plug in a USB WiFi dongle and ' +
          'select that instead.' });
        return true;
      }

      /* Spike gate: a virtual AP interface on the SAME radio only works
       * if the driver advertises a concurrent AP + station combination.
       * A dongle is its own radio, so it is exempt. */
      const onSameRadio = !(await isSeparateRadio(ifname));
      if (onSameRadio) {
        const caps = await wifiCapabilities();
        if (!caps.spikeRun) {
          json(res, 400, { ok: false, error: 'The radio\'s AP + station capability could not be read, ' +
            'so this is refused rather than risking the uplink. ' + caps.note });
          return true;
        }
        if (!caps.concurrentApSta) {
          json(res, 400, { ok: false, error: 'This radio does not advertise a concurrent AP + station ' +
            'interface combination. Use a USB WiFi dongle as a separate interface instead.' });
          return true;
        }
        if (band === 'bg' && !caps.dualBand) {
          console.warn('[NETCFG] bridge: radio allows only one channel — the AP will follow the ' +
            'upstream network\'s channel regardless of the requested band');
        }

        /* Belt-and-braces: the UI's "Create virtual AP interface" button
         * normally already did this, but enabling the bridge shouldn't
         * hard-depend on the user having clicked it first (a page reload,
         * a slow boot, a first-ever POST straight to the API). Idempotent
         * — a no-op if it already exists. */
        const created = await ensureVirtualApIface(ifname);
        if (!created.ok) { json(res, 500, { ok: false, error: created.error }); return true; }
      }
    }

    const channel = body.channel ? parseInt(body.channel, 10) : g_cfg.bridge.channel;
    g_cfg.bridge = { ...g_cfg.bridge, enabled, ifname, ssid, password, band, channel };
    saveNetConfig();

    if (!enabled) {
      await nm(['con', 'down', g_cfg.bridge.con_name]);
      await nm(['con', 'delete', g_cfg.bridge.con_name]);
      json(res, 200, { ok: true, enabled: false });
      return true;
    }

    /* Same helper as the setup AP — one place where the hotspot flags
     * live (see raiseHotspot()). autoconnect:true because the bridge is
     * meant to survive reboots, unlike the recovery AP. */
    const r = await raiseHotspot({
      ifname, conName: g_cfg.bridge.con_name, ssid, password, band, channel, autoconnect: true,
    });
    if (r.ok) await ensureDockerForwardRules(ifname, WIFI_IFACE);
    json(res, r.ok ? 200 : 500, { ok: r.ok, error: r.error });
    return true;
  }

  return false;
}

const WEBAPP_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>sensor_n2k Network</title>
${SHARED_STYLE}
</head>
<body>
${navHtml('netconfig')}
<div id="popup"><span id="popup-msg"></span><button onclick="confirmSwitch()">I can reach this page — keep it</button><button onclick="revertNow()">Undo now</button></div>
<div class="wrap">
<h1>Network</h1>
<p class="sub">WiFi setup and switching for this board. Changing networks is protected by an
automatic revert — if the new network doesn't work, the board goes back to the old one on its own.</p>

<div class="card">
<h2 style="margin-top:0">Status</h2>
<div class="stat-row">
<div class="stat">Interface <b id="s-iface">-</b></div>
<div class="stat">State <b id="s-state">-</b></div>
<div class="stat">Network <b id="s-profile">-</b></div>
<div class="stat">Address <b id="s-ip">-</b></div>
<div class="stat">Mode <b id="s-mode">-</b></div>
</div>
<p id="s-error" class="sub" style="color:var(--danger)"></p>
</div>

<div class="card">
<h2 style="margin-top:0">Available networks</h2>
<button id="scan-btn" class="primary" onclick="scan()">Scan</button>
<span id="scan-msg" class="sub" style="margin-left:1em"></span>
<table id="net-table" style="margin-top:0.8em"><thead><tr><th>Network</th><th>Signal</th><th>Security</th><th></th></tr></thead><tbody></tbody></table>
<fieldset id="connect-form" style="display:none">
<legend>Connect</legend>
<label>Network <input id="f-ssid" oninput="markDirty()"></label>
<label>Password <input id="f-password" type="password" oninput="markDirty()" placeholder="(leave blank for an open network)"></label>
<label><input type="checkbox" id="f-hidden" onchange="markDirty()"> Hidden network</label>
<br>
<button class="primary" onclick="connect()">Connect</button>
<button onclick="hideConnectForm()">Cancel</button>
<p class="sub" style="margin:0.6em 0 0">After connecting, this page will stop responding on the old network.
Rejoin the new network, load this page again, and press <b>Keep it</b> within
<span id="f-watchdog">45</span> seconds — otherwise the board reverts by itself.</p>
<p id="connect-msg" class="sub" style="color:var(--danger)"></p>
</fieldset>
<p><button onclick="showConnectForm('')">+ Other / hidden network</button></p>
</div>

<div class="card">
<h2 style="margin-top:0">Saved networks</h2>
<table id="saved-table"><thead><tr><th>Profile</th><th>Auto-connect</th><th></th></tr></thead><tbody></tbody></table>
</div>

<div class="card">
<h2 style="margin-top:0">Setup access point</h2>
<p class="sub">If the board can't join any known network it raises this access point by itself so you can
always reach this page from a phone. You can also raise it on demand to switch networks pre-emptively.</p>
<div class="stat-row">
<div class="stat">SSID <b id="ap-ssid-now">-</b></div>
<div class="stat">Setup URL <b id="ap-url">http://${HOTSPOT_GATEWAY}:${PORT}/</b></div>
<div class="stat">Currently <b id="ap-active">-</b></div>
</div>
<label>SSID <input id="ap-ssid" oninput="markDirty()"></label>
<label>Passphrase <input id="ap-password" oninput="markDirty()"></label>
<label><input type="checkbox" id="ap-fallback" onchange="markDirty()"> Raise automatically at boot if no network joins</label>
<label>Timeout (s) <input id="ap-timeout" type="number" style="width:6em" oninput="markDirty()"></label>
<br>
<button class="primary" onclick="saveHotspot()">Save</button>
<button onclick="hotspotStart()">Reconfigure WiFi (raise access point now)</button>
<button onclick="hotspotStop()">Stop access point</button>
<span id="ap-msg" class="sub" style="margin-left:1em"></span>
<p class="sub" style="margin-top:0.8em"><b>Write the passphrase down.</b> This access point is the recovery
path for a board that can't reach any network — if you change the passphrase and forget it, the only way
back in is a keyboard and monitor (or SSH over Ethernet).</p>
</div>

<div class="card">
<h2 style="margin-top:0">2.4 GHz bridge access point</h2>
<p class="sub">Optional. Shares this board's network with 2.4 GHz-only devices (older instruments, ESP-based
sensors) that can't see a 5 GHz network. Whether the built-in radio can host an access point while it is
also connected as a client is a property of the chipset, so it is checked here rather than assumed.</p>
<div id="cap-box" class="stat-row"><div class="stat">Checking capability…</div></div>
<p id="cap-note" class="sub"></p>
<div id="bridge-form">
<p class="sub">One interface cannot be a client and an access point at the same time, so the bridge needs a
second one: either a <b>virtual AP interface</b> on the built-in radio (only works if the capability check
above says AP + client is supported) or a <b>USB WiFi dongle</b>. ${WIFI_IFACE} itself is not offered —
taking it over as an access point is what the setup access point above does.</p>
<button onclick="createVirtualIface()">Create virtual AP interface (${VIRTUAL_AP_IFACE})</button>
<span id="br-vif-msg" class="sub" style="margin-left:1em"></span>
<br>
<label>Interface <select id="br-ifname" onchange="markDirty()"></select></label>
<label>SSID <input id="br-ssid" oninput="markDirty()"></label>
<label>Passphrase <input id="br-password" oninput="markDirty()" placeholder="at least 8 characters"></label>
<label>Band
<select id="br-band" onchange="markDirty()">
<option value="bg">2.4 GHz</option>
<option value="a">5 GHz</option>
</select>
</label>
<br>
<button class="primary" onclick="saveBridge(true)">Enable bridge</button>
<button onclick="saveBridge(false)">Disable</button>
<span id="br-msg" class="sub" style="margin-left:1em"></span>
</div>
</div>
</div>

<script>
/* Same idea as alarm-server.js's hwDirty: the 5s status poll below
 * repopulates every form field from the server, which would wipe a
 * half-typed passphrase out from under the user. Any input on a form
 * field sets this and stops the poll from writing to forms (it keeps
 * updating the read-only status row either way). */
let dirty = false;
let caps = null;
function markDirty() { dirty = true; }

function showConnectForm(ssid) {
  document.getElementById('connect-form').style.display = '';
  document.getElementById('f-ssid').value = ssid || '';
  document.getElementById('f-password').value = '';
  document.getElementById('f-hidden').checked = false;
  document.getElementById('connect-msg').textContent = '';
  dirty = true;
  if (!ssid) document.getElementById('f-ssid').focus();
  else document.getElementById('f-password').focus();
}
function hideConnectForm() {
  document.getElementById('connect-form').style.display = 'none';
  dirty = false;
}

function signalPill(sig) {
  const cls = sig >= 60 ? 'ok' : sig >= 35 ? 'warn' : 'danger';
  return '<span class="pill ' + cls + '">' + sig + '%</span>';
}

async function scan() {
  const btn = document.getElementById('scan-btn');
  const msg = document.getElementById('scan-msg');
  btn.disabled = true;
  msg.textContent = 'Scanning…';
  try {
    const r = await fetch('/api/wifi/scan').then(r => r.json());
    renderNetworks(r.networks || []);
    msg.textContent = (r.networks || []).length + ' network(s)';
  } catch (e) {
    msg.textContent = 'Scan failed: ' + e.message;
  }
  btn.disabled = false;
}

function renderNetworks(nets) {
  const tbody = document.querySelector('#net-table tbody');
  tbody.innerHTML = '';
  nets.forEach(n => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml(n.ssid) + (n.inUse ? ' <span class="pill ok">in use</span>' : '') + '</td>' +
      '<td>' + signalPill(n.signal) + '</td>' +
      '<td>' + (n.open ? 'open' : escapeHtml(n.security)) + '</td>' +
      '<td></td>';
    const btn = document.createElement('button');
    btn.textContent = 'Connect';
    btn.onclick = () => showConnectForm(n.ssid);
    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function connect() {
  const msg = document.getElementById('connect-msg');
  const ssid = document.getElementById('f-ssid').value.trim();
  if (!ssid) { msg.textContent = 'Enter a network name.'; return; }
  msg.textContent = 'Switching…';
  try {
    const r = await fetch('/api/wifi/connect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ssid,
        password: document.getElementById('f-password').value,
        hidden: document.getElementById('f-hidden').checked,
      }),
    }).then(r => r.json());
    if (!r.ok) { msg.textContent = 'Failed: ' + (r.error || 'unknown error'); return; }
    msg.textContent = r.watchdogSeconds
      ? 'Switching to "' + ssid + '". Rejoin that network, reload this page, and press "Keep it" within ' +
        r.watchdogSeconds + 's — otherwise the board returns to "' + r.revertTo + '".'
      : 'Connecting to "' + ssid + '"…';
    dirty = false;
  } catch (e) {
    /* Expected on a successful switch: the socket dies with the old
     * network before the response arrives. Not an error to report as one. */
    msg.textContent = 'Connection to this page dropped — that usually means the switch is under way. ' +
      'Rejoin "' + ssid + '" and reload this page to confirm it.';
  }
}

async function confirmSwitch() {
  await fetch('/api/wifi/confirm', { method: 'POST' });
  document.getElementById('popup').style.display = 'none';
  refresh();
}

async function revertNow() {
  await fetch('/api/wifi/revert', { method: 'POST' });
  refresh();
}

async function forgetProfile(name) {
  const r = await fetch('/api/wifi/forget/' + encodeURIComponent(name), { method: 'POST' }).then(r => r.json());
  if (!r.ok) alert('Could not forget "' + name + '": ' + (r.error || 'unknown error'));
  loadSaved();
}

async function loadSaved() {
  const r = await fetch('/api/wifi/saved').then(r => r.json());
  const tbody = document.querySelector('#saved-table tbody');
  tbody.innerHTML = '';
  (r.profiles || []).forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td>' + escapeHtml(p.name) + '</td><td>' + (p.autoconnect ? 'yes' : 'no') + '</td><td></td>';
    const btn = document.createElement('button');
    btn.textContent = 'Forget';
    btn.className = 'danger';
    btn.onclick = () => forgetProfile(p.name);
    tr.lastElementChild.appendChild(btn);
    tbody.appendChild(tr);
  });
}

async function saveHotspot() {
  const msg = document.getElementById('ap-msg');
  const r = await fetch('/api/hotspot/settings', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ssid: document.getElementById('ap-ssid').value,
      password: document.getElementById('ap-password').value,
      auto_fallback_enabled: document.getElementById('ap-fallback').checked,
      auto_fallback_timeout: document.getElementById('ap-timeout').value,
    }),
  }).then(r => r.json());
  msg.textContent = r.ok ? 'Saved.' : 'Failed: ' + (r.error || 'unknown error');
  if (r.ok) dirty = false;
  setTimeout(() => { msg.textContent = ''; }, 6000);
}

async function hotspotStart() {
  const msg = document.getElementById('ap-msg');
  if (!confirm('Raise the setup access point? This board will leave its current network, ' +
      'so this page will stop responding until you join the access point.')) return;
  const r = await fetch('/api/hotspot/start', { method: 'POST' }).then(r => r.json());
  msg.textContent = 'Access point coming up: join "' + r.ssid + '" (passphrase "' + r.password +
    '") then open http://' + r.gateway + ':' + r.port + '/';
}

async function hotspotStop() {
  const msg = document.getElementById('ap-msg');
  await fetch('/api/hotspot/stop', { method: 'POST' });
  msg.textContent = 'Access point stopping; the board will rejoin a known network.';
}

async function loadCaps() {
  caps = await fetch('/api/capabilities').then(r => r.json());
  const box = document.getElementById('cap-box');
  const note = document.getElementById('cap-note');
  const pill = (cls, txt) => '<div class="stat"><span class="pill ' + cls + '">' + txt + '</span></div>';
  let html = '';
  if (!caps.spikeRun) {
    html += pill('warn', 'capability unknown');
  } else {
    html += caps.concurrentApSta ? pill('ok', 'AP + client supported') : pill('danger', 'AP + client NOT supported');
    html += caps.dualBand ? pill('ok', 'two channels/bands') : pill('warn', 'single channel only');
  }
  if (caps.extraIfaces && caps.extraIfaces.length) {
    html += pill('ok', 'extra radio: ' + caps.extraIfaces.join(', '));
  }
  box.innerHTML = html;
  note.textContent = caps.note || (caps.spikeRun && !caps.dualBand && caps.concurrentApSta
    ? 'The radio can host an access point while connected, but only on the same channel as the ' +
      'upstream network — so a 2.4 GHz bridge only works if the upstream network is also 2.4 GHz. ' +
      'A USB dongle removes that restriction.'
    : '');

  /* The uplink interface is deliberately NOT offered — see the refusal in
   * POST /api/bridge for why. */
  const sel = document.getElementById('br-ifname');
  const candidates = (caps.ifaces || []).filter(i => !i.startsWith('p2p-') && i !== '${WIFI_IFACE}');
  sel.innerHTML = '';
  if (candidates.length === 0) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '(none — create a virtual interface or plug in a dongle)';
    sel.appendChild(opt);
  }
  candidates.forEach(i => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = i + ((caps.extraIfaces || []).includes(i) ? '' : ' (virtual, built-in radio)');
    sel.appendChild(opt);
  });

  const br = await fetch('/api/bridge').then(r => r.json());
  if (!dirty) {
    document.getElementById('br-ssid').value = br.config.ssid || '';
    document.getElementById('br-password').value = br.config.password || '';
    document.getElementById('br-band').value = br.config.band || 'bg';
    if (br.config.ifname) sel.value = br.config.ifname;
  }
}

async function createVirtualIface() {
  const msg = document.getElementById('br-vif-msg');
  msg.textContent = 'Creating…';
  try {
    const r = await fetch('/api/bridge/virtual-iface', { method: 'POST' }).then(r => r.json());
    msg.textContent = r.ok
      ? (r.already ? 'Already exists.' : 'Created "' + r.name + '".')
      : 'Failed: ' + (r.error || 'unknown error');
    if (r.ok) loadCaps();
  } catch (e) {
    msg.textContent = 'Failed: ' + e.message;
  }
}

async function saveBridge(enabled) {
  const msg = document.getElementById('br-msg');
  msg.textContent = enabled ? 'Enabling…' : 'Disabling…';
  const r = await fetch('/api/bridge', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enabled,
      ifname: document.getElementById('br-ifname').value,
      ssid: document.getElementById('br-ssid').value,
      password: document.getElementById('br-password').value,
      band: document.getElementById('br-band').value,
    }),
  }).then(r => r.json());
  msg.textContent = r.ok ? (enabled ? 'Bridge access point is up.' : 'Bridge disabled.')
    : 'Failed: ' + (r.error || 'unknown error');
  if (r.ok) dirty = false;
}

async function refresh() {
  let s;
  try { s = await fetch('/api/status').then(r => r.json()); }
  catch (e) { return; }   /* mid-switch; leave last-known state on screen */

  document.getElementById('s-iface').textContent = s.iface;
  document.getElementById('s-state').textContent = s.state;
  document.getElementById('s-profile').textContent = s.profile || '(none)';
  document.getElementById('s-ip').textContent = s.ip || '(none)';
  document.getElementById('s-mode').textContent = s.apMode ? 'access point' : 'client';
  document.getElementById('ap-ssid-now').textContent = s.hotspot.ssid;
  document.getElementById('ap-active').textContent = s.hotspot.active ? 'up' : 'down';
  document.getElementById('f-watchdog').textContent = s.watchdog_seconds;

  if (!dirty) {
    document.getElementById('ap-ssid').value = s.hotspot.ssid;
    document.getElementById('ap-password').value = s.hotspot.password;
    document.getElementById('ap-fallback').checked = !!s.auto_fallback.enabled;
    document.getElementById('ap-timeout').value = s.auto_fallback.timeout_seconds;
  }

  const popup = document.getElementById('popup');
  const err = document.getElementById('s-error');
  if (s.pending) {
    err.textContent = s.pending.error ? 'Switch failed: ' + s.pending.error : '';
    if (!s.pending.error) {
      document.getElementById('popup-msg').textContent =
        'Reverting to "' + s.pending.revertTo + '" in ' + s.pending.secondsLeft + 's unless confirmed. ';
      popup.style.display = 'block';
    } else {
      popup.style.display = 'none';
    }
  } else {
    err.textContent = '';
    popup.style.display = 'none';
  }
}

refresh();
loadSaved();
loadCaps();
scan();
setInterval(refresh, 5000);
</script>
</body></html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname.startsWith('/api/')) {
    try {
      const handled = await handleApi(req, res, url);
      if (!handled) json(res, 404, { error: 'not found' });
    } catch (e) {
      console.error('[NETCFG] API error:', e.message);
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
  if (e.code === 'EADDRINUSE') console.error(`[NETCFG] Port ${PORT} already in use`);
  else console.error('[NETCFG] Server error:', e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[NETCFG] Listening on http://0.0.0.0:${PORT}`);
});

/* ------------------------------------------------------------------ */
/* Boot-time auto-fallback                                              */
/* ------------------------------------------------------------------ */

const FALLBACK_POLL_MS = 3000;

/** Poll until wlan0 reports "connected", or the deadline passes. Same
 *  poll-with-deadline shape as alarm-server.js:1589-1615 — at boot the
 *  radio, NetworkManager and the AP are all coming up at once, and there
 *  is no event to wait on that means "we're really on the network". */
function waitForAssociation(timeoutSeconds) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutSeconds * 1000;
    const tick = async () => {
      const dev = await deviceState();
      /* "connected" is the only state that means an IP-capable
       * association; "connecting"/"disconnected"/"unavailable" are not. */
      if (dev.state && dev.state.startsWith('connected')) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(tick, FALLBACK_POLL_MS);
    };
    tick();
  });
}

async function bootFallback() {
  if (!g_cfg.auto_fallback.enabled) {
    console.log('[NETCFG] boot auto-fallback disabled by config');
    return;
  }
  const timeout = g_cfg.auto_fallback.timeout_seconds;
  console.log(`[NETCFG] waiting up to ${timeout}s for ${WIFI_IFACE} to associate…`);

  const ok = await waitForAssociation(timeout);
  if (ok) {
    /* realFallbackProfile() also seeds lastKnownGoodProfile — the whole
     * point of checking this at boot in the first place. */
    console.log(`[NETCFG] ${WIFI_IFACE} associated to "${await realFallbackProfile()}" — no fallback needed`);
    return;
  }

  /* Don't stomp an AP that is already up — e.g. the bridge AP is running
   * on this interface, or a previous fallback already fired. */
  const active = await activeProfile();
  if (await isApProfile(active)) {
    console.log(`[NETCFG] ${WIFI_IFACE} is already hosting an access point ("${active}") — leaving it alone`);
    return;
  }

  console.warn(`[NETCFG] no network joined within ${timeout}s — raising setup access point ` +
    `"${g_cfg.hotspot.ssid}" (setup page: http://${HOTSPOT_GATEWAY}:${PORT}/)`);
  const r = await startSetupHotspot();
  if (!r.ok) console.error('[NETCFG] failed to raise setup access point:', r.error);
}

/** If the bridge AP is enabled, its NetworkManager profile (autoconnect
 *  yes) survives this service restarting or the board rebooting — but a
 *  virtual AP interface on the built-in radio (ap0) does NOT survive a
 *  reboot; it's a runtime-only kernel object that has to be recreated
 *  from scratch every boot (see ensureVirtualApIface()). Confirmed live
 *  on a real reboot that NetworkManager then activates the saved profile
 *  on its own within about a second of the interface reappearing — this
 *  only needs to create the interface, not re-run raiseHotspot().
 *
 *  The DOCKER-USER iptables rule ensureDockerForwardRules() adds also
 *  does not survive a reboot (iptables state is in-kernel only, and
 *  dockerd recreates DOCKER-USER empty on every start) — re-applying it
 *  here is what keeps the bridge working across reboots on a board that
 *  has Docker installed.
 */
async function bridgeStartup() {
  if (!g_cfg.bridge.enabled || !g_cfg.bridge.ifname) return;
  const { ifname } = g_cfg.bridge;
  console.log(`[NETCFG] bridge is enabled ("${g_cfg.bridge.ssid}" on ${ifname}) — ` +
    'ensuring virtual interface + Docker forwarding rules');
  if (!(await isSeparateRadio(ifname))) {
    const created = await ensureVirtualApIface(ifname);
    if (!created.ok) console.error('[NETCFG] bridge startup: could not create virtual AP interface:', created.error);
  }
  await ensureDockerForwardRules(ifname, WIFI_IFACE);
}

/* Any watchdog left armed from before a restart is stale by definition —
 * whatever it was guarding either succeeded (and we're running fine) or
 * failed (and NetworkManager's own autoconnect has had its turn). Firing
 * it now would yank a working network out from under a running board. */
disarmWatchdog().then(bootFallback);
bridgeStartup();
