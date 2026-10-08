# WiFi Setup and Switching — sensor_n2k

Covers `netconfig-server.js` (port 3005) and `sensor-n2k-netconfig.service`:
joining a WiFi network from a browser, switching networks without stranding
the board, and the recovery access point it raises by itself when it can't
join anything.

Before this existed, moving the boat meant SSH-ing in and hand-typing `nmcli`
— which only works if you can already reach the board, which is exactly what
you can't do after the network changed.

---

## Quick reference

| | |
|---|---|
| Page | `http://<board>:3005/` (also linked as **Network** in the nav bar) |
| Setup access point SSID | `UNOQ-Setup` |
| Setup access point passphrase | `unoqsetup` (change it on the page; **write it down**) |
| Setup page while on the AP | `http://10.42.0.1:3005/` |
| Config file | `/etc/sensor_n2k/netconfig.json` |
| Service | `sensor-n2k-netconfig.service`, `User=root` |

---

## One-time device prep

There is **no** sudoers or setcap step for this service — unlike
`sensor-n2k-ota.service` (sudoers) and `sensor-n2k-portal.service` (setcap).
The unit runs as `root`, so every `nmcli` call and the `systemd-run` watchdog
work directly, with no privilege escalation in the code at all.

What you do need to confirm once, on a fresh board image:

```bash
# 1. NetworkManager is present and is the thing managing wlan0.
#    "wlan0  wifi  connected  <name>" (or "disconnected") is correct.
#    "unmanaged" is NOT — see the troubleshooting note below.
nmcli dev status

# 2. systemd-run is available (it is part of systemd; this just confirms
#    the path the service hard-codes).
which systemd-run          # expect /usr/bin/systemd-run

# 3. Install and enable the unit.
sudo cp host-tools/systemd/sensor-n2k-netconfig.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sensor-n2k-netconfig
journalctl -u sensor-n2k-netconfig -f
```

If `nmcli dev status` shows `wlan0` as **unmanaged**, NetworkManager has been
told to leave it alone (usually a leftover `/etc/NetworkManager/conf.d/*.conf`
with `unmanaged-devices=`, or a `wpa_supplicant` service configured
independently). Fix that first — every operation in this service is an `nmcli`
call and none of them will do anything useful until NetworkManager owns the
interface.

---

## Normal use: switching to a different network

1. Open **Network** in the nav bar.
2. **Scan**, pick a network, enter the passphrase, **Connect**.
3. The board arms a revert watchdog, then activates the new profile. Your
   browser loses the page at this point — that is expected, not a failure.
4. Rejoin the new network on your phone/laptop, load `http://<new-address>:3005/`
   again, and press **"I can reach this page — keep it"** in the red banner.

If you never press it, the watchdog fires after `watchdog_seconds` (default 45)
and the board returns to the network it was on before. **The board cannot
strand itself on a bad WiFi config.**

Finding the new address after a switch: the board keeps its hostname
(`unoqcan.local` via mDNS where that works), and if a Bluetooth speaker is
paired, `alarm-server.js` speaks the new IP address out loud at boot — see its
`announceIpAddress()`.

### How the watchdog actually works

```
armWatchdog()  ->  systemd-run --unit=netconfig-revert --on-active=45s \
                     /usr/bin/nmcli con up "<previous profile>" ifname wlan0
```

A **transient systemd timer**, not an in-process `setTimeout`. That matters:
the revert survives `netconfig-server.js` crashing, being restarted, or being
OOM-killed part-way through the switch — which is precisely when you most need
it. Pressing **Keep it** stops the timer (`systemctl stop netconfig-revert.timer`).

The timer is also disarmed unconditionally at service start, so a stale one
left over from a reboot can never yank a working network out from under a
running board.

---

## Recovery: the setup access point

If `wlan0` has not associated to anything within `auto_fallback.timeout_seconds`
(default 60) after the service starts, the board raises its own WPA2 access
point:

* SSID `UNOQ-Setup`, passphrase `unoqsetup` (both editable on the page)
* NetworkManager hotspot mode — it brings its own DHCP and NAT
  (`ipv4.method shared`). There is no `hostapd` or `dnsmasq` to install or
  configure.
* Join it from a phone and open **`http://10.42.0.1:3005/`** (NetworkManager's
  hotspot gateway address is always `10.42.0.1`).
* Scan, pick the real network, enter the passphrase, connect. The AP drops as
  the board joins.

You can also raise it on demand with **Reconfigure WiFi (raise access point
now)** — useful for switching networks pre-emptively rather than waiting to be
locked out.

### Why the passphrase is a fixed default, not random

The one moment you need this passphrase is the moment you have no other way to
reach the board — so it has to be knowable from this document rather than from
a page you can't load. You can change it on the Network page, but then **you**
own remembering it. If you change it and forget it, the way back in is a
keyboard and monitor, or SSH over the Ethernet adapter.

The AP profile is created with `connection.autoconnect no` on purpose:
otherwise a board that once fell back to setup mode could prefer its own access
point over the real network forever.

---

## 2.4 GHz bridge access point (optional, spike-gated)

Shares the board's uplink with 2.4 GHz-only devices (older instruments,
ESP-based sensors) that can't see a 5 GHz network.

### Hardware spike result — this board CAN do it

Whether the built-in radio can host an access point while it is also connected
as a client is a property of the chipset and driver and cannot be inferred from
anything in this repo. It was measured on the real board (`phy0`):

```
valid interface combinations:
  * #{ managed } <= 2, #{ AP, P2P-client, P2P-GO } <= 2, #{ P2P-device } <= 1,
    total <= 4, #channels <= 1                                [AP + station OK]
  * #{ managed } <= 2, #{ P2P-client } <= 2, #{ AP, P2P-GO } <= 1,
    #{ P2P-device } <= 1, total <= 4, #channels <= 2          [AP + station OK]
  * #{ managed } <= 1, #{ IBSS } <= 1, total <= 2, #channels <= 1

concurrent AP + station: SUPPORTED
```

The second combination has `#channels <= 2`, so the AP and the client may sit on
**different channels — i.e. genuinely different bands**. A 2.4 GHz bridge
alongside a 5 GHz uplink is possible on the built-in radio; no USB dongle is
required.

Reproduce it yourself either way:

```bash
python3 /opt/sensor_n2k/host-tools/canboatjs-signalk/iface-combinations.py
# or, if you install the standard tool:
sudo apt install iw && iw list
```

`iw` is **not** installed on this board's stock image, which is why
`iface-combinations.py` exists: it reads the same
`NL80211_ATTR_INTERFACE_COMBINATIONS` from the kernel over generic netlink, with
no packages and no privileges. `netconfig-server.js` prefers `iw list` when it is
present and falls back to the helper otherwise, so the capability card gives a
real answer out of the box.

### The bridge needs a SECOND interface

Concurrency is a property of the *radio*, not of one network interface. A single
interface is either a client or an access point — never both. So the bridge runs
on a second netdev:

* **Virtual AP interface on the built-in radio** — press **Create virtual AP
  interface (ap0)** on the Network page. This runs
  `iw dev wlan0 interface add ap0 type __ap`, which is the one step that really
  does need `iw` installed (`sudo apt install iw`).
* **USB WiFi dongle** — appears as `wlan1` in the Interface dropdown
  automatically. It is its own radio, so it is exempt from the concurrency
  question entirely.

`wlan0` itself is deliberately **not** offered, and enabling the bridge on it is
refused by the API: it is the interface carrying the uplink, and on this board
that is the only way back in. If what you want is "take `wlan0` over as an access
point", that is the **setup access point** above.

Once an interface is selected, the bridge uses the same `raiseHotspot()` helper
as the setup AP (one place where the hotspot flags live), just with
`autoconnect yes` so it survives a reboot, and NetworkManager's
`ipv4.method shared` giving DHCP and NAT out to the LAN and the internet.

> **Not yet tested live.** The spike (can the radio do it) is confirmed on real
> hardware. Actually raising the bridge AP was **not** exercised on the live
> board — doing so risks disturbing the only network path to it, and at the time
> of writing `sensor-n2k-netconfig.service` (and therefore its revert watchdog)
> was not yet deployed. Bring it up the first time with a second route to the
> board available: SSH over the Ethernet adapter, or a keyboard and monitor.

---

## Out of scope for v1: a physical setup button

`bridge.js` already broadcasts `{type:'button'}` on the local bus, and
`alarm-server.js` consumes it as "cancel all alarms". Extending it to also
trigger setup mode is a natural follow-up, but it needs two things that do not
exist yet:

1. Real, confirmed button wiring. The GPIO in
   `apps/sensor_n2k/boards/arduino_uno_q.overlay:59-75` and `alarm_io.h:13-27`
   is still an unconfirmed placeholder.
2. A long-press vs. short-press distinction in the firmware, so it doesn't
   collide with alarm-cancel.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Page loads but Scan returns nothing | `nmcli dev status` shows `wlan0` unmanaged, or the radio is already in AP mode (a hotspot can't scan). Stop the access point first. |
| "could not arm revert watchdog, refusing to switch" | `systemd-run` failed — check the service is really running as root (`systemctl show -p User sensor-n2k-netconfig`). The switch is deliberately refused rather than done unprotected. |
| Switched networks and now the board is back on the old one | The watchdog fired: you didn't press **Keep it** in time, or the new network didn't actually work. Both are the feature working. |
| Setup AP never appears after a failed boot | `journalctl -u sensor-n2k-netconfig` — look for `raising setup access point`. If `auto_fallback.enabled` is `false` in `/etc/sensor_n2k/netconfig.json`, it is switched off. |
| Duplicate `UNOQ-Setup 1`, `UNOQ-Setup 2` profiles | Shouldn't happen — `raiseHotspot()` deletes the same-named profile first. If it does, `nmcli con delete` the strays; the watchdog resolves profiles by name and duplicates make that ambiguous. |
