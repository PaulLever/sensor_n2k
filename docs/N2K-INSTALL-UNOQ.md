# Zephyr Toolchain Install — Arduino UNO Q (STM32U585) Only

Minimal install: only what is needed to build for the `arduino_uno_q` board.
No QEMU, no extra architectures, no bloat. WSL2 only.

---

## 1. Host dependencies (WSL2 / Ubuntu 22.04+)

```bash
sudo apt update && sudo apt install --no-install-recommends -y \
  git cmake ninja-build gperf ccache dfu-util device-tree-compiler wget \
  python3-dev python3-venv python3-pip xz-utils file make gcc \
  libsdl2-dev libmagic1
```

---

## 2. West + source

```bash
python3 -m venv ~/.venv-zephyr && source ~/.venv-zephyr/bin/activate
pip install west

mkdir -p ~/unoq-ws && cd ~/unoq-ws
west init -m https://github.com/EmbeddedAndroid/zephyr --mr can-unoq .
west update
west zephyr-export
pip install -r zephyr/scripts/requirements.txt
```

> If the workspace is already initialized, skip `west init` and just run
> `west update && west zephyr-export && pip install -r zephyr/scripts/requirements.txt`.

---

## 3. Zephyr SDK — ARM only (saves ~2 GB)

The full SDK installs every supported architecture (~4 GB). For UNO Q you only
need the ARM Cortex-M toolchain. Use SDK 0.16.8 — known-good with the split
toolchain archives.

```bash
SDK_VER="0.16.8"
cd ~
wget "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${SDK_VER}/zephyr-sdk-${SDK_VER}_linux-x86_64_minimal.tar.xz" \
  && wget "https://github.com/zephyrproject-rtos/sdk-ng/releases/download/v${SDK_VER}/toolchain_linux-x86_64_arm-zephyr-eabi.tar.xz" \
  && tar xf zephyr-sdk-${SDK_VER}_linux-x86_64_minimal.tar.xz \
  && cd zephyr-sdk-${SDK_VER} \
  && tar xf ~/toolchain_linux-x86_64_arm-zephyr-eabi.tar.xz \
  && ./setup.sh -t arm-zephyr-eabi -h -c
```

> `west sdk install` pulls the *full* SDK. The manual steps above stay ARM-only.

Add the toolchain to PATH (also add to `~/.bashrc` to make it permanent):

```bash
export PATH=~/zephyr-sdk-0.16.8/arm-zephyr-eabi/bin:$PATH
```

---

## 4. Verify

```bash
arm-zephyr-eabi-gcc --version
```

---

## 5. Build (UNO Q only)

```bash
source ~/.venv-zephyr/bin/activate
cd ~/unoq-ws
west build -p always -b arduino_uno_q zephyr/unoq/apps/can_spi_bridge_n2k \
  -- -DCONFIG_USE_DT_CODE_PARTITION=n
```

Output: `build/zephyr/zephyr.bin`

---

## Space saved

| Install type        | Approx. disk use |
|---------------------|-----------------|
| Full SDK            | ~4 GB           |
| ARM-only (this doc) | ~500 MB         |

---

## 6. Deploy and flash (WSL window + SSH window)

You need two terminals open: **WSL** for building and copying files, **SSH**
(`ssh arduino@192.168.87.35`) for everything on the device.

### 6a. First-time device prep (SSH — run once)

Install OpenOCD with `linuxgpiod` support (apt's version lacks it):

```bash
sudo apt update && sudo apt install -y --no-install-recommends \
  build-essential autoconf automake libtool pkg-config \
  libgpiod-dev libgpiod3 libjim-dev libjaylink-dev \
  git ca-certificates gpiod && \
git clone --depth 1 https://github.com/openocd-org/openocd.git /tmp/openocd-src && \
cd /tmp/openocd-src && \
./bootstrap nosubmodule && \
./configure --enable-linuxgpiod --disable-werror \
  --disable-doxygen-html --disable-doxygen-pdf \
  --disable-internal-jimtcl --disable-internal-libjaylink \
  --prefix=/opt/openocd && \
make -j$(nproc) && \
sudo make install
```

Patch the SWD config to suppress the `adapter speed` reset event that
`linuxgpiod` doesn't support:

```bash
printf '\n$_TARGETNAME configure -event reset-start {}\n$_TARGETNAME configure -event reset-init {}\n' \
  | sudo tee -a /home/root/zephyr-flash/oo/unoq-swd.cfg
```

Patch `n2k_test.py` to use the system `gpioget` instead of the missing bundle binary:

```bash
sudo sed -i 's|OO+"/bin/gpioget"|"/usr/bin/gpioget"|g' /tmp/host-tools/n2k_test.py
```

### 6b. Copy files to device (WSL)

```bash
TARGET="arduino@192.168.87.35"
scp ~/unoq-ws/build/zephyr/zephyr.bin ${TARGET}:/tmp/zephyr.bin && \
scp -r ~/unoq-ws/zephyr/unoq/openocd-flasher ${TARGET}:/tmp/oo && \
scp -r ~/unoq-ws/zephyr/unoq/host-tools ${TARGET}:/tmp/host-tools
```

### 6c. Device prep (SSH)

```bash
sudo mkdir -p /home/root/zephyr-flash && \
sudo cp -r /tmp/oo /home/root/zephyr-flash/oo && \
sudo cp /tmp/zephyr.bin /home/root/zephyr-flash/zephyr.bin && \
sudo chmod +x /home/root/zephyr-flash/oo/*.sh
```

### 6d. Backup Arduino bootloader (SSH — run once, keep the file safe)

```bash
cd /home/root/zephyr-flash/oo && \
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "dump_image /home/root/arduino-loader-backup.bin 0x08000000 0x80000" \
  -c shutdown
```

### 6e. Flash firmware (SSH)

```bash
sudo killall gpioset 2>/dev/null; \
gpioset -c gpiochip1 37=0 & BOOT0=$!; sleep 0.3 && \
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "flash write_image erase /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "verify_image /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "reset run" -c shutdown && \
kill $BOOT0 2>/dev/null
```

Look for `verified 42464 bytes` and `shutdown command invoked` with no errors.

---

## 7. Debug output

### Linux side — run the loopback test with live output (SSH)

```bash
cd /tmp/host-tools && sudo python3 -u n2k_test.py 30
```

Expected: `PASS: extended-ID classic CAN frames round-tripped, no loss`

Throughput sweep:

```bash
sudo python3 -u n2k_bench.py 600
```

Expected: lossless ceiling ~1235 frames/s @ 0.4 ms/frame, loss wall at ~0.3 ms/frame.

### Zephyr side — read firmware counters over SWD (SSH)

Get counter addresses from the build (run in WSL):

```bash
arm-zephyr-eabi-nm ~/unoq-ws/build/zephyr/zephyr.elf \
  | grep -E ' g_(can_rx|frames_injected|frames_packed|rx_crc_err)'
```

Then read them live over SWD (substitute addresses from nm output):

```bash
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "mdw <addr_g_frames_injected>" \
  -c "mdw <addr_g_can_rx>" \
  -c "mdw <addr_g_frames_packed>" \
  -c "mdw <addr_g_rx_crc_err>" \
  -c shutdown
```

A clean run shows `g_frames_injected == g_can_rx == g_frames_packed` and
`g_rx_crc_err == 0`.

### Restore Arduino bootloader (SSH — undo flash)

```bash
cd /home/root/zephyr-flash/oo && \
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "flash write_image erase /home/root/arduino-loader-backup.bin 0x08000000 bin" \
  -c "reset run" -c shutdown
```
######################################################################
WSL — Build
TARGET="arduino@192.168.86.33"
sudo cp -r /mnt/d/svjeo/zephyrproject/zephyr/unoq ~/unoq-ws/zephyr/
scp -r ~/unoq-ws/zephyr/unoq/host-tools/canboatjs-signalk \
    ${TARGET}:/tmp/host-tools/

source ~/.venv-zephyr/bin/activate
cd ~/unoq-ws
west build -p always -b arduino_uno_q zephyr/unoq/apps/sensor_n2k \
  -- -DCONFIG_USE_DT_CODE_PARTITION=n

WSL — Copy to device
TARGET="arduino@192.168.86.33"
scp ~/unoq-ws/build/zephyr/zephyr.bin ${TARGET}:/tmp/zephyr.bin && \
scp -r ~/unoq-ws/zephyr/unoq/openocd-flasher ${TARGET}:/tmp/oo && \
scp -r ~/unoq-ws/zephyr/unoq/host-tools ${TARGET}:/tmp/host-tools

SSH — Device prep (once per deploy)
mkdir /tmp/host-tools       **before wsl copy

sudo mkdir -p /home/root/zephyr-flash && \
sudo cp -r /tmp/oo /home/root/zephyr-flash/oo && \
sudo cp /tmp/zephyr.bin /home/root/zephyr-flash/zephyr.bin && \
sudo chmod +x /home/root/zephyr-flash/oo/*.sh

SSH — Flash
sudo killall gpioset 2>/dev/null; \
gpioset -c gpiochip1 37=0 & BOOT0=$!; sleep 0.3 && \
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "flash write_image erase /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "verify_image /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "reset run" -c shutdown && \
kill $BOOT0 2>/dev/null



SSH — Start Linux bridge (after flash)
cd /tmp/host-tools/canboatjs-signalk
npm install
**no more****sudo node spi-can-daemon.js &******
sudo node bridge.js

in seperate SSH
signalk-server


if needed:
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

Force clean build
west build -p always -b arduino_uno_q zephyr/unoq/apps/sensor_n2k \
  -- -DCONFIG_USE_DT_CODE_PARTITION=n


  scratch
  Startup sequence (n2k_negotiate_address, called from main before threads start):
1. Attaches CAN receive filters for PGN 60928 and 59904 before transmitting — so no conflict arriving in the same 250 ms window can slip past.
2. Sends PGN 60928 (Address Claim) with the device's 64-bit NAME.
3. Waits 250 ms (ISO 11783-5 §9.4 minimum). If a device with a lower NAME claims the same SA, we increment SA and restart the timer.
4. Once the 250 ms passes with no conflict, the address is ours.

Background thread (mgmt_fn):
- Late conflicts: if another device powers up later and claims our SA with a lower NAME, we yield and re-claim on the next address.
- ISO Requests (PGN 59904): other devices (chartplotters, MFDs) send these to discover what addresses are active — we respond with our PGN 60928 so they can build their device list.

NAME fields to customise (all in n2k.h):
- N2K_NAME_IDENTITY — must be unique per physical device (use the last 21 bits of the STM32 UID from 0x0BFA0700 for production).
- N2K_NAME_DEVICE_CLASS — 75 (Propulsion) is correct for an EGT sensor; change to 60 if it's a general environmental sensor.
- N2K_NAME_MANUFACTURER — register a manufacturer code with NMEA for a real product.

*************************************
Step 1 — flash and leave OpenOCD open:
sudo killall gpioset 2>/dev/null
gpioset -c gpiochip1 37=0 & BOOT0=$!
sleep 0.3
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "flash write_image erase /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "verify_image /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "reset run" &
OOCD=$!
sleep 2
kill $BOOT0 2>/dev/null

OpenOCD is now running in the background with the STM32 executing.

Step 2 — attach RTT in a second terminal:
telnet localhost 4444

Then at the OpenOCD prompt:
rtt setup 0x20000000 0xC0000 "SEGGER RTT"
rtt start
rtt server start 9090 0

Step 3 — read the output in a third terminal:
telnet localhost 9090

You should immediately see the Zephyr boot banner and then all the LOG_INF/LOG_WRN/LOG_ERR messages including which CAN/SPI check is failing. The bus sniff result (Bus sniff: no traffic or N2K traffic detected) will be among the first lines after boot.
*********************
/dev/ttyS0 is it — that's the STM32 USART1 routed internally through the Linux MPU. Open a second terminal on the UNO Q and monitor it before you flash:

stty -F /dev/ttyS0 115200 cs8 -cstopb -parenb -crtscts && cat /dev/ttyS0

Then run your flash command in the first terminal. The moment reset run fires you should see the Zephyr boot banner in the monitoring terminal, followed by all the LOG output.

Also note: the gpioset: Permission denied on gpiochip1 means BOOT0 isn't being held during flash, but it doesn't matter — OpenOCD controls the reset/halt directly over SWD and is flashing fine without it. You can strip that gpioset boilerplate from your flash command:

sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "flash write_image erase /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "verify_image /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "reset run" -c shutdown
  ********************************************8
  Rebuild and copy the new zephyr.bin. Then on the UNO Q, replace your entire flash command with this single script — it flashes, keeps OpenOCD alive, starts RTT, and pipes the output straight to your terminal:

sudo killall openocd 2>/dev/null
sleep 1
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c "init" -c "halt" \
  -c "flash write_image erase /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "verify_image /home/root/zephyr-flash/zephyr.bin 0x08000000 bin" \
  -c "reset run" \
  -c "rtt setup 0x20000000 0xC0000 {SEGGER RTT}" \
  -c "rtt start" \
  -c "rtt server start 9090 0" &
sleep 4 && nc localhost 9090

nc (netcat) is the serial monitor equivalent here — it just prints everything that comes out of the RTT buffer to your terminal. You'll see the Zephyr boot banner, the bus sniff result, and all the CAN/N2K log messages. Ctrl-C to stop.

reboot the STM32 without reflashing using this:

sudo killall openocd 2>/dev/null
sleep 1
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c "init" \
  -c "reset run" \
  -c "rtt setup 0x20000000 0xC0000 {SEGGER RTT}" \
  -c "rtt start" \
  -c "rtt server start 9090 0" &
sleep 3 && nc localhost 9090



==========================================
canbus shield notes
Done. Here's a summary of all changes:

---
What changed

CMakeLists.txt — one-line switch at the top:
set(USE_MCP2515_SHIELD OFF)   ← change to ON for the shield
When ON, it automatically appends the MCP2515 overlay and conf file to the build.

boards/arduino_uno_q.overlay (existing) — added &spi2 { status = "disabled"; }. The board's base DTS has SPI2 enabled with spi2_nss_pb9, which would fight for PB9 against FDCAN1_TX. This fix prevents that silently-broken pin conflict that already existed.

boards/arduino_uno_q_mcp2515.overlay (new) — applied on top of the base overlay when the shield is selected. It:
- Routes zephyr,canbus to &mcp2515
- Disables fdcan1 (releases PB8/PB9)
- Overrides SPI2 pinctrl to exclude hardware NSS (so PB9 stays GPIO for software CS)
- Declares the MCP2515 device: CS=D10/PB9, INT=D2/PB3, 8 MHz crystal, 250 kbit/s / 87.5% sample point

prj_mcp2515.conf (new) — MCP2515 thread stack/priority config. CONFIG_CAN_MCP2515 itself is auto-enabled by Zephyr when the DTS node exists.

No changes to any .c or .h files — the CAN API calls in n2k.c and main.c work identically with the MCP2515 driver. The can_recover() call will return -ENOTSUP on MCP2515 (no bus-off recovery API), which busoff_recover() already handles with a warning and continues.
now on 192.168.86.33


SignalK is not running — no signalk-server process and nothing on port 3000. The bridge.js SPI daemon also appears to be down. Both need to be restarted.

Open two SSH sessions to the UNO Q:

SSH window 1 — SPI-CAN bridge (talks to STM32 over SPI3):
cd /tmp/host-tools/canboatjs-signalk && sudo node bridge.js

SSH window 2 — SignalK server:
signalk-server

SignalK listens on port 3000 (HTTP) and 8375 (WebSocket). After starting, confirm it's up:
sudo ss -tulpn | grep -E '3000|8375'

Then access the UI at http://192.168.87.35:3000 from your browser.

If signalk-server command isn't found:
npm list -g signalk-server 2>/dev/null || sudo npm install -g signalk-server

=====================
Here's a summary of all changes across all 4 features:

---
What was implemented

1 — Pulse counters (src/pulse_counter.h/.c)

- Two GPIO interrupt counters: PC0 on D3/PB0, PC1 on D6/PB1 (free in both FDCAN and MCP2515 builds)
- Single sampling thread handles both at their independent rates
- Per-counter config: mode (STW/RPM), Hz/m·s⁻¹ or pulses/rev, update interval 500–2000 ms, ring-buffer average 1–10 samples
- STW → PGN 128259 (0.01 m/s per bit), RPM → PGN 127488 (0.25 RPM per bit), both via spi_bridge_enqueue
- Thread only starts if at least one counter is enabled
- GPIO pins added to boards/arduino_uno_q.overlay inside the existing zephyr_user node

2 — Float LOG fix (src/onewire.c, src/adc.c, prj.conf)

- CONFIG_CBPRINTF_FP_SUPPORT=y added to prj.conf — fixes %f in LOG macros globally
- Both sensor files also rewritten to use integer-part logging (%d.%02d) as belt-and-suspenders, and to read n2k_source/n2k_instance from g_sensor_cfg

3 — Configuration table (src/sensor_config.h/.c, src/spi_bridge.c, Linux tools)

- sensor_cfg_t struct covers 1-Wire, ADC, and both pulse counters; compile-time defaults in sensor_config.h
- NVS persistence via Zephyr Settings (storage_partition at 0xE0000); sensor_config_load() called before any thread starts
- Runtime update protocol: bridge.js sends vendor-proprietary CAN frames (ID 0x1EFFFE__) at startup; spi_bridge.c inject_block() intercepts them before they reach the bus and calls sensor_config_update()
- host-tools/canboatjs-signalk/config-server.js: single-file Node.js HTTP server on port 3001 with a full-page HTML form — no frameworks, no new npm deps
- bridge.js: loads /etc/sensor_n2k/config.json, enqueues config frames 500 ms after SPI opens, added PGN 127488 → Signal K propulsion.N.revolutions decode

4 — Autostart (host-tools/systemd/, docs/LINUX-AUTOSTART.md)

- Three systemd services: sensor-n2k-bridge, sensor-n2k-signalk, sensor-n2k-config
- Bridge starts first; SignalK Wants= the bridge
- Full install + update + uninstall procedure in docs/LINUX-AUTOSTART.md

To enable a pulse counter, edit sensor_config.h defaults (for permanent default) or use the web UI at http://<board-ip>:3001 (runtime, persisted to NVS).


=======================
 how do I see debug logs for zephyr side

OpenOCD is already running (you can see it on ports 3333/4444/6666). Since prj.conf has CONFIG_LOG_BACKEND_RTT=y and CONFIG_RTT_CONSOLE=y, all Zephyr LOG output goes to RTT buffer 0. Access it through OpenOCD's RTT server:

SSH window 1 — start RTT in OpenOCD:
telnet localhost 4444
Then in the OpenOCD prompt:
rtt setup 0x20000000 0x50000 "SEGGER RTT"
rtt start
rtt server start 9100 0
(Searches first 320 KB of RAM for the RTT control block, then exposes channel 0 as a TCP stream on port 9100.)

SSH window 2 — read the log stream:
nc localhost 9100

You should immediately see log output like:
[00:00:00.012,000] <inf> sensor_cfg: loaded from NVS
[00:00:00.015,000] <inf> onewire_n2k: 1-wire: 1 DS18B20 sensor(s) on bus
[00:00:00.750,000] <inf> onewire_n2k: 1-wire[0]: 22.06 C  src=2 inst=1
[00:00:01.001,000] <inf> adc_n2k: ADC raw=8192  EGT=500.0 C ...

If rtt start says "RTT not found", the symbol address search window might need to be wider — try:
rtt setup 0x20000000 0xC0000 "SEGGER RTT"
rtt start
(STM32U585 has 786 KB SRAM total.)

To increase verbosity, add this to prj.conf and rebuild:
CONFIG_LOG_DEFAULT_LEVEL=4
Level 4 = DBG (shows all LOG_DBG calls). Current default is 3 (INF).

Teardown when done:
rtt server stop 9100
rtt stop
in the OpenOCD telnet, or just close the telnet session.

-----------
OpenOCD has stopped since the last session. Check first:

ps aux | grep openocd

If nothing comes back, start it in a dedicated SSH window — without the flash commands, just the init so it stays connected for RTT:

sudo /opt/openocd/bin/openocd \
  -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg

It should print something like:
Info : Listening on port 3333 for gdb connections
Info : Listening on port 4444 for telnet connections
Info : Listening on port 6666 for tcl connections

and stay running. Then in a second window:

telnet localhost 4444

If you don't remember the exact config file path:
find /home/root /opt/openocd -name "*.cfg" 2>/dev/null | grep -i unoq
# or
find /home/arduino -name "*.cfg" 2>/dev/null

If you want everything in one step (OpenOCD + RTT server, no manual telnet commands needed):

sudo /opt/openocd/bin/openocd \
  -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c "init" \
  -c "rtt setup 0x20000000 0x50000 {SEGGER RTT}" \
  -c "rtt start" \
  -c "rtt server start 9100 0"

Then in another window: nc localhost 9100