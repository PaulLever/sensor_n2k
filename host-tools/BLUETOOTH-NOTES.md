# Bluetooth audio (bt_speaker) — RESOLVED (2026-08-01)

## Symptom (original)
"Play Test Tone" in the Alarms webapp's Hardware tab did nothing (or,
after the alarm-server.js honesty fix, correctly reported failure) even
when the paired speaker (tested with a JBL Go 3) showed `Connected: yes`
in `bluetoothctl`. `wpctl status` (run as the `arduino` user — the one
`bt-speaker.js`/`alarm-server.js` actually use) never showed a Bluetooth
sink at all, only "Built-in Audio".

## Actual root cause: a real bug in `monitors/bluez.lua`
Found by reading the script directly
(`/usr/share/wireplumber/scripts/monitors/bluez.lua`, WirePlumber 0.5.8),
around line 543:

```lua
if config.seat_monitoring then
  logind_plugin = Plugin.find("logind")
end
if logind_plugin then
  function startStopMonitor(seat_state)
    log:info(logind_plugin, "Seat state changed: " .. seat_state)
    if seat_state == "active" then
      monitor = createMonitor()
    elseif monitor then
      monitor:deactivate(Feature.SpaDevice.ENABLED)
      monitor = nil
    end
  end
  logind_plugin:connect("state-changed", function(p, s) startStopMonitor(s) end)
  startStopMonitor(logind_plugin:call("get-state"))
else
  monitor = createMonitor()
end
```

`config.seat_monitoring` is `Core.test_feature("monitor.bluez.seat-monitoring")`,
which under this board's plain `main` WirePlumber profile is enabled by
default (a `disabled` setting for it exists in
`/usr/share/wireplumber/wireplumber.conf`, but only inside the
`mixin.systemwide-session` block — a block meant for the *separate*
`main-systemwide` profile, which this board doesn't use; `main` never
inherits it, so it doesn't apply).

With seat-monitoring on, the script waits for the seat to report
`seat_state == "active"` before ever creating the Bluetooth device
monitor at all. Confirmed via `WIREPLUMBER_DEBUG=3` foreground runs: the
`arduino` user's WirePlumber logs exactly `Seat state changed: online` —
**"online", not "active"** — and then does nothing further, forever. For
a headless board where `arduino` connects only via SSH + a lingering
systemd user session (never an interactive seat login), the seat state
for that session is never going to be `"active"` — only ever `"online"`.
The check is simply never satisfiable on this kind of setup, so the
Bluetooth device monitor never starts, no matter how long you wait or how
many times you reconnect the speaker.

(Side investigation, not the root cause but real and worth knowing: this
board also runs a second, fully independent PipeWire/WirePlumber instance
under the `lightdm` system user, uid 103, spawned by the always-running
`lightdm` greeter session on `seat0` — since nobody ever logs into a
physical display on this headless board. That instance *is* the one
systemd-logind considers seat-`active`, so historically its
seat-monitoring check passed and it alone could register a Bluetooth A2DP
endpoint — just on an entirely separate PipeWire socket
[`/run/user/103/`] that `arduino`'s `pw-cat`/`pw-dump` calls can never
reach. This matches a community-documented UNO Q issue — Arduino forum
thread "BT Audio Manager - UNO Q",
https://forum.arduino.cc/t/bt-audio-manager/1445978, "two competing
WirePlumber instances (lightdm + user session)". Its referenced fix repo,
`github.com/DMIYTRO/bt-audio-fix`, no longer exists (404 on the repo URL,
the GitHub API, and the author's repo listing, confirmed 2026-08-01), so
none of this section could be verified against it — it was independently
re-derived on this board.)

## The fix
Two changes, both required together — each alone was tried and
confirmed insufficient (see "Things that were tried" below).

### 1. Disable Bluetooth seat-monitoring for `arduino`'s WirePlumber
`Core.test_feature()` reads from a profile's feature declarations
(`wireplumber.profiles.<profile>.<feature>`), **not** from
`wireplumber.settings` — a `wireplumber.settings` override was tried
first and silently had no effect. The correct override:

```
# /etc/wireplumber/wireplumber.conf.d/51-disable-bluez-seat-monitoring.conf
wireplumber.profiles = {
  main = {
    monitor.bluez.seat-monitoring = disabled
  }
}
```

With this in place, `config.seat_monitoring` is false, `logind_plugin`
stays nil, and the script takes the `else` branch —
`monitor = createMonitor()` — unconditionally, with no seat check at all.
Confirmed via debug logs: the "Seat state changed" line disappears
entirely, and `spa.bluez5` starts registering real A2DP media endpoints
(`Registering DBus media endpoint: /MediaEndpoint/A2DPSink/sbc` etc.).

### 2. Remove the competing `lightdm` PipeWire/WirePlumber instance
Even with the above fix, `arduino`'s WirePlumber registering its own
endpoints wasn't enough on its own — reconnecting the speaker still
produced no sink in `wpctl status`, apparently because the still-running
`lightdm` instance's endpoints were winning whatever BlueZ uses to decide
which registered endpoint handles a given connection. Masking
`lightdm`'s audio stack (keeps its login-screen function fully intact,
only removes its unnecessary PipeWire/WirePlumber):

```
sudo mkdir -p /var/lib/lightdm/.config/systemd/user
for u in pipewire.service pipewire.socket pipewire-pulse.service pipewire-pulse.socket wireplumber.service; do
  sudo ln -sf /dev/null /var/lib/lightdm/.config/systemd/user/$u
done
sudo chown -R lightdm:lightdm /var/lib/lightdm/.config
sudo systemctl restart user@103.service
```

(`systemctl restart lightdm` alone does *not* apply this — it only
recreates the greeter UI process, not the underlying `lightdm` systemd
user-manager instance that actually owns PipeWire/WirePlumber. You must
restart `user@103.service` directly.)

### 3. One more restart needed after combining both
After applying both of the above, `wpctl status` can hang indefinitely
(process states stay normal — `do_epoll_wait`/`do_sys_poll`, not
deadlocked — but the tool itself never returns) if BlueZ still has stale
profile/endpoint registrations left over from the churn of testing. A
clean `sudo systemctl restart bluetooth`, followed by restarting
`arduino`'s WirePlumber/PipeWire, clears this:

```
sudo systemctl restart bluetooth
sudo -n -u arduino XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart wireplumber pipewire pipewire-pulse
```

After that, reconnecting the speaker (`bluetoothctl connect <mac>`, or
just powering it back on if it auto-reconnects) produces a real sink:

```
Audio
 ├─ Devices:
 │      48. Built-in Audio                      [alsa]
 │      57. JBL Go 3                            [bluez5]
 ├─ Sinks:
 │      49. Built-in Audio Headphones playback  [vol: 0.40]
 │  *   58. JBL Go 3                            [vol: 0.40]
```

Confirmed end-to-end through the actual app:
`curl -X POST http://<board>:3002/api/bt/test` → `{"ok": true}`, with a
real `pw-cat` stream visible in `wpctl status` actively playing to the
JBL sink.

## To undo everything in this file
```
sudo rm -f /etc/wireplumber/wireplumber.conf.d/51-disable-bluez-seat-monitoring.conf
sudo rm -rf /var/lib/lightdm/.config/systemd/user
sudo systemctl restart user@103.service
sudo -n -u arduino XDG_RUNTIME_DIR=/run/user/1000 systemctl --user restart wireplumber pipewire pipewire-pulse
```
`lightdm.service` itself was never disabled in the final fix (that was
tried separately and reverted — see "Things that were tried" below) —
only its audio stack is masked, so no `systemctl enable/disable` undo is
needed for it.

## Things that were tried and did NOT work, in order
For anyone tempted to re-explore this space — these were all tried
first, before finding the actual fix above, and are documented so nobody
repeats them expecting a different result:

1. **Masking only `lightdm`'s audio stack, without the seat-monitoring
   fix.** Made things *worse*: `bluetoothctl connect` started failing
   outright with `org.bluez.Error.Failed br-connection-profile-unavailable`,
   since at that point *nothing* was registering an A2DP endpoint
   (`arduino`'s WirePlumber still hadn't been fixed yet, so removing
   `lightdm`'s working-but-unreachable registration just left a total
   gap). Reverted.

2. **Disabling `lightdm.service` entirely, without the seat-monitoring
   fix.** Same failure as #1, for the same reason. Reverted
   (`sudo systemctl enable --now lightdm`).

3. **A `wireplumber.settings` override for `monitor.bluez.seat-monitoring`**
   (rather than a `wireplumber.profiles` override). Silently had no
   effect — confirmed via debug logs that the "Seat state changed" log
   line still appeared afterward, meaning `Core.test_feature()` wasn't
   reading it. This is what led to finding the correct mechanism (profile
   feature declarations, not the settings store).

The lesson: the seat-monitoring fix and the `lightdm` audio-stack removal
are both *necessary* — neither alone produces a working sink.
