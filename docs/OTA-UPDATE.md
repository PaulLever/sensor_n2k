# Over-the-Air Updates — sensor_n2k

Covers `ota-server.js` (port 3006) and `sensor-n2k-ota.service`: updating the
Linux services and reflashing the Zephyr firmware from a browser, over the
boat's own network, with no laptop wired to the board.

---

## Read this first — what this does NOT protect you from

This is the **simple tier** of OTA, chosen deliberately:

* **There is no MCUboot A/B fail-safe and no automatic firmware rollback.**
  A firmware image that flashes and verifies cleanly but is *logically* broken
  (hangs at boot, wrong device tree, no SPI) still needs a manual OpenOCD
  recovery run. The board's device tree already reserves `slot0`/`slot1`
  partitions for a future MCUboot conversion — that is the natural v2, and it
  is not implemented here.
* What you get instead is: a **backup of the currently running image taken
  before every flash**, and a **post-flash liveness check** that watches the
  bus monitor and tells you loudly if the new firmware never came back. It can
  detect a dead board. It cannot revive one.
* **Do not flash firmware underway.** Do it at the dock, with a laptop within
  reach.

The Linux app-update path is much safer — it is fully reversible from the same
page (**Restore previous**), and a bad tarball is rejected before the live
install is touched.

---

## Quick reference

| | |
|---|---|
| Page | `http://<board>:3006/` (also linked as **Updates** in the nav bar) |
| Service | `sensor-n2k-ota.service`, `User=root` |
| Deployed-version file | `/etc/sensor_n2k/host-tools-version.json` |
| App backups | `/opt/sensor_n2k/host-tools.bak-<timestamp>/` (last 2 kept) |
| Firmware staging | `/home/root/zephyr-flash/zephyr.bin` |
| Firmware backups | `/home/root/zephyr-flash/zephyr-backup-<timestamp>.bin` |
| Flash wrapper | `/home/root/zephyr-flash/ota-flash.sh` (regenerated on every service start) |
| Sudoers rule | `/etc/sudoers.d/sensor-n2k-ota` — **one-time device prep, see below** |

---

## One-time device prep

### 1. Install the unit

```bash
sudo cp host-tools/systemd/sensor-n2k-ota.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now sensor-n2k-ota
```

### 2. The scoped sudoers rule — DO NOT SKIP

Firmware flashing runs `sudo -n /home/root/zephyr-flash/ota-flash.sh`. This
board's `sudo` is **not** passwordless, and a systemd service can never answer a
password prompt, so a scoped rule must exist:

```bash
sudo visudo -f /etc/sudoers.d/sensor-n2k-ota
```

Enter **exactly one line** (adjust the user if you change `User=` in the unit;
`root` is what the unit ships with):

```
root ALL=(ALL) NOPASSWD: /home/root/zephyr-flash/ota-flash.sh
```

Then:

```bash
sudo chmod 0440 /etc/sudoers.d/sensor-n2k-ota
sudo visudo -c                     # MUST print "parsed OK" before you log out
sudo -n -l /home/root/zephyr-flash/ota-flash.sh   # should print the command, not prompt
```

> ### *** THIS MUST BE REDONE ON EVERY FRESH BOARD IMAGE ***
>
> * `sudoers` matches on the **literal path**. If the wrapper is ever moved or
>   renamed (`FLASH_SCRIPT` in `ota-server.js`), the rule silently stops
>   applying and every firmware update fails half-way through with
>   `sudo: a password is required`. Change both together, always.
> * **NEVER** widen this to `NOPASSWD: ALL`. The point is that one fixed script
>   is privileged, not the whole service.
> * While the unit ships with `User=root` this rule is technically redundant
>   (root needs no sudoers entry) — **which is exactly why it gets skipped**,
>   and why flashing then breaks the first time anyone de-privileges the unit.
>   Install it anyway.
> * `ota-server.js` checks for the file at startup and warns loudly in the
>   journal and in a banner on the Updates page if it is missing. If you see
>   that banner, this step was not done.
>
> This is the same class of easily-skipped, per-image prep as the
> `setcap cap_net_bind_service=+ep /usr/bin/node` requirement in
> `sensor-n2k-portal.service` — see the comment block there, and
> `docs/N2K-INSTALL-UNOQ.md`.

### 3. Confirm the SWD prep from the install doc is present

Firmware updates reuse the staging directory the manual procedure already sets
up (`docs/N2K-INSTALL-UNOQ.md` §6c):

```bash
ls /home/root/zephyr-flash/oo/unoq-swd.cfg
ls /opt/openocd/bin/openocd
```

If either is missing, do §6c of the install doc first. The Updates page shows a
warning banner when the OpenOCD config is absent.

---

## Linux app update

### Build a package (on your dev machine)

```bash
cd <repo root>
./package.sh                  # writes host-tools.tar.gz
```

`node_modules` is excluded on purpose — it is ~100 MB of arm64-native builds
that would be wrong for your laptop anyway. The board carries its existing
`node_modules` across, and re-runs `npm install` **only if `package.json`
changed** (which turns a JS-only update from a two-minute job into a
five-second one).

Doing it by hand is equivalent:

```bash
tar czf host-tools.tar.gz --exclude node_modules host-tools
```

### Install it

Upload on the Updates page. In order, the board:

1. Runs `tar tzf` on the upload **before touching anything** — a truncated
   transfer, a `.zip`, or the wrong tarball is rejected here, with the running
   install untouched.
2. Extracts to a staging directory and checks `canboatjs-signalk/` is present.
3. Moves `/opt/sensor_n2k/host-tools` aside to `host-tools.bak-<timestamp>`.
4. Moves the new tree into place (and puts the backup straight back if that
   fails — an aborted update never leaves the board with no `host-tools` at
   all).
5. Carries `node_modules` across; runs `npm install` if `package.json` changed.
6. Restarts `sensor-n2k-bridge`, `-config`, `-alarm`, `-busmonitor`, `-bilge`,
   `-portal`, `-netconfig`. Units not installed on this board are skipped, not
   treated as failures.
7. Prunes all but the newest 2 backups and records `{version, deployedAt}` to
   `/etc/sensor_n2k/host-tools-version.json`.

`sensor-n2k-ota` itself is **not** restarted — that would kill the update in
progress. Restart it by hand afterwards to pick up changes to `ota-server.js`:

```bash
sudo systemctl restart sensor-n2k-ota
```

Signal K is third-party and unaffected by `host-tools`, so it is not restarted
either.

### Rollback

**Restore previous** on any listed backup swaps it back in and restarts the
services. The version being rolled back *from* becomes a backup itself, so a
rollback is undoable too.

### Version tracking

There was none before this. `package.json`'s `"version": "1.0.0"` is static and
read by nothing. `/etc/sensor_n2k/host-tools-version.json` is the new source of
truth for "what is actually deployed on this board right now"; the optional
**Version label** field on the upload form is what it records.

---

## Zephyr firmware update

Build `zephyr.bin` the usual way (`build.sh`), then upload it on the Updates
page. In order, the board:

1. **Sanity-checks the image** — size bounds (4 KB … 512 KB, the STM32U585's
   flash), rejects an ELF (`zephyr.elf` instead of `zephyr.bin` is the classic
   mistake), and warns if the reset vector isn't in the `0x08xxxxxx` range.
2. **Dumps the currently running image** to
   `/home/root/zephyr-flash/zephyr-backup-<timestamp>.bin`. The install doc only
   ever did this once, for the original Arduino bootloader; doing it on every
   flash means there is always a known-good image on disk to recover to.
   **If this step fails, nothing is erased.**
3. Stages the upload at `/home/root/zephyr-flash/zephyr.bin` and runs the flash
   wrapper.
4. Polls `bus-monitor-server.js`'s existing `/api/bus` for up to 60 s, looking
   for a confirmed source address, devices, or a non-error CAN state.

Only one flash can run at a time — the page refuses to start a second one.
This mirrors the hardware constraint: **only one OpenOCD instance can hold the
SWD lines at once**, which is also why the wrapper runs `pkill -f openocd`
first.

### The flash sequence

The wrapper is generated by `ota-server.js` on every service start (so it can
never drift from the code) and contains exactly the sequence from
`docs/N2K-INSTALL-UNOQ.md` §6e:

```sh
gpioset -c gpiochip1 37=0 &          # hold BOOT0 for the whole run
sleep 0.3
/opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg -c init -c halt \
  -c "flash write_image erase /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "verify_image /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "reset run" -c shutdown
kill $BOOT0
```

SWD is bit-banged from the Linux MPU's own GPIOs to its own onboard STM32 —
there is no external programmer and no cable to plug in. That is what makes
this remotely triggerable at all.

**`Checksum mismatch — attempting binary compare` immediately followed by
`verified N bytes` is benign and expected.** Success is `verified N bytes` +
`shutdown command invoked` with no errors.

### Manual recovery

If the log says *"Flash verified, but NO bus activity"*, the MCU is not running
usefully. Recover the previous image over SSH:

```bash
sudo pkill -f openocd
sudo killall gpioset 2>/dev/null
gpioset -c gpiochip1 37=0 & BOOT0=$!; sleep 0.3
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg -c init -c halt \
  -c "flash write_image erase /home/root/zephyr-flash/zephyr-backup-<timestamp>.bin 0x08000000 bin" \
  -c "verify_image /home/root/zephyr-flash/zephyr-backup-<timestamp>.bin 0x08000000 bin" \
  -c "reset run" -c shutdown
kill $BOOT0 2>/dev/null
```

The exact backup path is printed in the update log and stored in
`/etc/sensor_n2k/host-tools-version.json` under `firmware.backup`.

If the Linux side is *also* unreachable, this is a laptop-and-a-cable job —
that is unchanged from before this feature existed. What changed is that the
normal case no longer requires one.

---

## Security note

Neither this service nor any other in this suite has authentication. They are
LAN-only by design, and this one can restart services and reflash the MCU.
Do not expose port 3006 (or 80/3001–3005) to the internet, and treat the
2.4 GHz bridge access point in `docs/NETWORK-SETUP.md` as granting the same
access as being on the boat's LAN.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Banner: "sudo is asking for a password" | The sudoers rule above was not installed (or the wrapper path changed). Firmware updates will fail; app updates are unaffected. |
| Banner: "/etc/sudoers.d/sensor-n2k-ota is missing" | Flashing works only because the service is root. Do the prep step so it keeps working if the unit is ever de-privileged. |
| Banner: "The OpenOCD SWD config is missing" | Run `docs/N2K-INSTALL-UNOQ.md` §6c. |
| "rejected: archive contains neither host-tools/ nor canboatjs-signalk/" | Wrong tarball — build one with `./package.sh` from the repo root. |
| "rejected: this is an ELF file" | You uploaded `zephyr.elf`. Upload `zephyr.bin`. |
| App update finished but the change isn't live | `ota-server.js` does not restart itself. `sudo systemctl restart sensor-n2k-ota`. Also check the log for `RESTART FAILED` on a specific unit. |
| Services won't start after an update | **Restore previous** on the newest backup. If the page itself is down, `sudo mv /opt/sensor_n2k/host-tools{,.broken} && sudo mv /opt/sensor_n2k/host-tools.bak-<ts> /opt/sensor_n2k/host-tools` over SSH, then restart the units. |
| "another update is already running" | One job at a time, on purpose. Wait for the log to finish. |
