# sensor_n2k Linux Autostart — Arduino UNO Q

Installs bridge.js, config-server.js, and SignalK as systemd services so they
start automatically on boot with no shell attached.

---

## Prerequisites (run on the Arduino UNO Q via SSH)

```bash
# Node.js 20 (if not already installed)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt install -y nodejs

# SignalK server (global npm install)
sudo npm install -g signalk-server

mkdir /tmp/host-tools
WSL — Copy to device
TARGET="arduino@192.168.86.33"
scp ~/unoq-ws/build/zephyr/zephyr.bin ${TARGET}:/tmp/zephyr.bin && \
scp -r ~/unoq-ws/zephyr/unoq/openocd-flasher ${TARGET}:/tmp/oo && \
scp -r ~/unoq-ws/zephyr/unoq/host-tools ${TARGET}:/tmp/host-tools

# npm dependencies for the bridge
cd /tmp/host-tools/canboatjs-signalk
npm install
```

---

## 1. Deploy host tools to a permanent location

```bash
sudo mkdir -p /opt/sensor_n2k/host-tools
sudo cp -r /tmp/host-tools /opt/sensor_n2k/
# Install npm packages in the permanent location
cd /opt/sensor_n2k/host-tools/canboatjs-signalk
sudo npm install
```

---

## 2. Create the config directory

```bash
sudo mkdir -p /etc/sensor_n2k
# Optionally seed a config (edit as needed):
sudo tee /etc/sensor_n2k/config.json <<'EOF'
{
  "onewire": { "enabled": true,  "source": 2,  "instance": 1, "poll_ms": 2000 },
  "adc":     { "enabled": true,  "source": 14, "instance": 0, "poll_ms": 1000 },
  "pulse": [
    { "enabled": false, "mode": "STW", "hz_per_mps": 9.33,  "update_ms": 1000, "avg_samples": 5 },
    { "enabled": false, "mode": "RPM", "pulses_per_rev": 1.0, "engine_instance": 0, "update_ms": 500, "avg_samples": 3 }
  ]
}
EOF
```

---

## 3. Install systemd services

```bash
sudo cp /opt/sensor_n2k/host-tools/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable sensor-n2k-bridge sensor-n2k-signalk sensor-n2k-config
sudo systemctl start  sensor-n2k-bridge sensor-n2k-signalk sensor-n2k-config
```

---

## 4. Verify

```bash
sudo systemctl status sensor-n2k-bridge
sudo systemctl status sensor-n2k-signalk
sudo systemctl status sensor-n2k-config
# Live logs:
sudo journalctl -fu sensor-n2k-bridge
```

Ports after start:
| Service          | Port  | Purpose                       |
|------------------|-------|-------------------------------|
| SignalK HTTP     | 3000  | Dashboard & WebSocket          |
| Config web UI    | 3001  | Sensor parameter editing       |
| SPI bridge       | —     | Background, no network port    |

Access the config UI from any browser on the same network:
`http://192.168.86.33:3001`

---

## 5. Updating firmware + redeploying host tools

```bash
# From WSL — build & copy new firmware
west build -p always -b arduino_uno_q zephyr/unoq/apps/sensor_n2k -- -DCONFIG_USE_DT_CODE_PARTITION=n
TARGET="arduino@192.168.87.35"
scp ~/unoq-ws/build/zephyr/zephyr.bin ${TARGET}:/tmp/zephyr.bin
scp -r ~/unoq-ws/zephyr/unoq/host-tools ${TARGET}:/tmp/host-tools

# On device — update bridge + config-server, then re-deploy services
sudo cp /tmp/host-tools/canboatjs-signalk/bridge.js       /opt/sensor_n2k/host-tools/canboatjs-signalk/
sudo cp /tmp/host-tools/canboatjs-signalk/config-server.js /opt/sensor_n2k/host-tools/canboatjs-signalk/
sudo systemctl restart sensor-n2k-bridge sensor-n2k-config

# Flash firmware (services stay running during flash)
sudo killall openocd 2>/dev/null
sleep 1
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "flash write_image erase /tmp/zephyr.bin 0x08000000 bin" \
  -c "verify_image /tmp/zephyr.bin 0x08000000 bin" \
  -c "reset run" -c shutdown
```

---

## 6. Uninstall

```bash
sudo systemctl disable --now sensor-n2k-bridge sensor-n2k-signalk sensor-n2k-config
sudo rm /etc/systemd/system/sensor-n2k-*.service
sudo systemctl daemon-reload
```


====================================
● Update(zephyr\unoq\host-tools\systemd\sensor-n2k-signalk.service)
Added 3 lines, removed 1 line
Type=simple
User=arduino
WorkingDirectory=/home/arduino
ExecStart=/usr/bin/signalk-server
# npm global bin may be in /usr/local/bin (nodesource install) or /usr/bin
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/env signalk-server
Restart=on-failure
RestartSec=5
StandardOutput=journal

Now deploy both fixes on the device — run these commands over SSH:

# 1. Verify where signalk-server actually lives
which signalk-server
# (if nothing, try: npm bin -g)

# 2. Copy the updated config-server and the fixed service file
sudo cp /tmp/host-tools/canboatjs-signalk/config-server.js \
        /opt/sensor_n2k/host-tools/canboatjs-signalk/config-server.js

sudo cp /tmp/host-tools/systemd/sensor-n2k-signalk.service \
        /etc/systemd/system/sensor-n2k-signalk.service

# 3. Reload systemd and restart both services
sudo systemctl daemon-reload
sudo systemctl restart sensor-n2k-config sensor-n2k-signal

# 4. Check status
sudo systemctl status sensor-n2k-config sensor-n2k-signalk

If which signalk-server returns nothing after step 1, SignalK still isn't installed for the arduino user's PATH. Run:

# Re-install globally (if not found)
sudo npm install -g signalk-server


sudo journalctl -u sensor-n2k-config -n 20
================
The same hash is expected — that's Zephyr's own git commit, not the application. The binary at /tmp/zephyr.bin has all the new application code compiled in. Now flash it:

sudo /opt/openocd/bin/openocd \
  -s /opt/openocd/share/openocd/scripts \
  -f /tmp/oo/unoq-swd.cfg \
  -c "init" \
  -c "reset halt" \
  -c "flash write_image erase /tmp/zephyr.bin 0x08000000 bin" \
  -c "verify_image /tmp/zephyr.bin 0x08000000 bin" \
  -c "reset run" \
  -c "shutdown"

Then deploy the updated host-tools and restart the services:

sudo cp /tmp/host-tools/canboatjs-signalk/bridge.js \
        /opt/sensor_n2k/host-tools/canboatjs-signalk/bridge.js
sudo cp /tmp/host-tools/canboatjs-signalk/config-server.js \
        /opt/sensor_n2k/host-tools/canboatjs-signalk/config-server.js
sudo cp /tmp/host-tools/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart sensor-n2k-bridge sensor-n2k-config

Then open RTT to see the new firmware:

sudo /opt/openocd/bin/openocd \
  -s /opt/openocd/share/openocd/scripts \
  -f /tmp/oo/unoq-swd.cfg \
  -c "init" \
  -c "rtt setup 0x20000000 0x50000 {SEGGER RTT}" \
  -c "rtt start" \
  -c "rtt server start 9100 0" &

nc localhost 9100
 ====================
 # WSL
cp -r /mnt/d/svjeo/zephyrproject/zephyr/unoq ~/unoq-ws/zephyr/
source ~/.venv-zephyr/bin/activate && cd ~/unoq-ws
west build -p always -b arduino_uno_q zephyr/unoq/apps/sensor_n2k \
  -- -DCONFIG_USE_DT_CODE_PARTITION=n
scp ~/unoq-ws/build/zephyr/zephyr.bin arduino@192.168.87.35:/tmp/zephyr.bin

# Device — flash then restart bridge
sudo killall gpioset 2>/dev/null
gpioset -c gpiochip1 37=0 & BOOT0=$!; sleep 0.3 && \
sudo /opt/openocd/bin/openocd -s /opt/openocd/share/openocd/scripts \
  -f /home/root/zephyr-flash/oo/unoq-swd.cfg \
  -c init -c halt \
  -c "flash write_image erase /tmp/zephyr.bin 0x08000000 bin" \
  -c "verify_image /tmp/zephyr.bin 0x08000000 bin" \
  -c "reset run" -c shutdown && kill $BOOT0 2>/dev/null

# After reset, start bridge
cd /tmp/host-tools/canboatjs-signalk && sudo node bridge.js
===========================
Good catch. The permanent location is /opt/sensor_n2k/host-tools/canboatjs-signalk/. Copy the fixed bridge.js there directly on the device:

sudo cp /tmp/host-tools/canboatjs-signalk/bridge.js \
    /opt/sensor_n2k/host-tools/canboatjs-signalk/bridge.js

Check if node_modules are already installed in the persistent location:

ls /opt/sensor_n2k/host-tools/canboatjs-signalk/node_modules/@canboat 2>/dev/null \
  || echo "MISSING — need npm install"

If missing:
cd /opt/sensor_n2k/host-tools/canboatjs-signalk && sudo npm install

Then restart the service:
sudo systemctl start sensor-n2k-bridge
sudo journalctl -u sensor-n2k-bridge -f | grep -E "pgn event|PGN 130|SK"

For future deployments from WSL, target the persistent path directly:
scp .../bridge.js arduino@192.168.87.35:/opt/sensor_n2k/host-tools/canboatjs-signalk/bridge.js

Similarly, the Zephyr binary should live in /opt/sensor_n2k/ or /home/root/zephyr-flash/ (whatever survives reboots on this Debian image) rather than /tmp/.
