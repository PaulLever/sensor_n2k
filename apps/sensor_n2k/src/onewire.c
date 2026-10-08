#include "onewire.h"
#include "sensor_config.h"
#include "n2k.h"
#include "spi_bridge.h"
#include "led.h"

#include <stdbool.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/w1.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/byteorder.h>

LOG_MODULE_REGISTER(onewire_n2k, LOG_LEVEL_INF);

/*
 * Drive the 1-Wire bus on PB4 (D8) directly using the W1 API.
 *
 * Sensors are discovered by ROM search (do_scan()) and matched to a
 * config slot (g_sensor_cfg.onewire.slot[0..3]) by its 64-bit ROM ID
 * (ow_slot_cfg_t.rom_id) — NOT by discovery order. Discovery order is
 * NOT stable: it's whatever the 1-Wire search algorithm's bit-resolution
 * walk returns this boot, and if one sensor drops off the bus (fails,
 * unplugged), every sensor after it in that order shifts down one
 * position. A slot with rom_id == 0 falls back to the old positional
 * behavior (slot N = the Nth device found) — this is only for configs
 * that haven't bound an explicit ROM yet; every slot should get a real
 * rom_id assigned via the config UI once its sensor is known-good, at
 * which point position no longer matters for that slot, and losing a
 * DIFFERENT sensor elsewhere on the bus can't reassign it out from under
 * the readings/alarms already configured for it.
 *
 * Protocol per cycle:
 *   1. SKIP ROM + CONVERT T  → all sensors start conversion simultaneously
 *   2. k_msleep(750)         → 12-bit conversion time
 *   3. MATCH ROM + READ SCRATCHPAD  for each discovered sensor individually
 *
 * CONFIG_W1_NET_FORCE_MULTIDROP_ADDRESSING=y ensures w1_write_read() always
 * uses MATCH ROM addressing regardless of the DTS slave_count.
 */

#define W1_NODE  DT_NODELABEL(w1_0)

#define DS18B20_FAMILY        0x28U
#define DS18B20_CMD_CONVERT_T 0x44U
#define DS18B20_CMD_READ_SP   0xBEU
#define DS18B20_SP_LEN        9U     /* scratchpad bytes: temp(2) + config(3) + reserved(3) + crc */
#define DS18B20_WAIT_MS       750U   /* 12-bit conversion time */
#define KELVIN_OFFSET         273.15f

/* Local-only diagnostic frame (never touches the physical bus — see
 * ALARM_BTN_CAN_ID in alarm_io.c for the same convention) reporting the
 * result of a 1-Wire ROM search to Linux, so the config webapp can show
 * "what's actually on the bus right now" when the user is binding a slot
 * to a sensor or replacing a failed one:
 *   Marker frame: data[0]=0xFF, data[1]=count of sensors found
 *   Then, for each of the `count` sensors, TWO frames back to back:
 *     ROM frame:  data[0..7] = 8-byte big-endian ROM ID (family + 6-byte
 *                 serial + CRC, per struct w1_rom / w1_rom_to_uint64()).
 *                 data[0] is always the DS18B20 family code (0x28),
 *                 which doubles as this frame's tag.
 *     TEMP frame: data[0]=ONEWIRE_TEMP_SENTINEL (0xFE — never a valid
 *                 family code, so ROM vs TEMP frames are unambiguous),
 *                 data[1]=1 if the read succeeded else 0, data[2..3]=
 *                 signed 16-bit LE temperature in centi-degrees C.
 * A live reading is taken for every sensor found (not just ones bound to
 * a config slot) so the UI can show "23.4 C" next to each unbound ROM —
 * the user can then identify a replacement sensor just by warming it in
 * their hand and watching which entry's reading moves. Sent after every
 * scan — both the automatic one at boot and any on-demand one via
 * onewire_request_rescan(). */
#define ONEWIRE_ROM_REPORT_CAN_ID 0x1EFFFECUL
#define ONEWIRE_TEMP_SENTINEL     0xFEU

static const struct device *w1_dev = DEVICE_DT_GET(W1_NODE);

/* Discovered sensors — populated by ROM search (do_scan()) */
static struct w1_slave_config s_slaves[MAX_OW_SENSORS];
static uint8_t s_slave_count;

static atomic_t s_rescan_requested;

void onewire_request_rescan(void)
{
	atomic_set(&s_rescan_requested, 1);
}

/* Defined further below (next to the rest of the DS18B20 read/convert
 * logic they're grouped with) — forward-declared here because do_scan()
 * needs them and is defined earlier in the file, before report_roms(). */
static int convert_all(void);
static int read_sensor(uint8_t idx, float *temp_c_out);

/* ── ROM search callback ─────────────────────────────────────────── */
static void search_cb(struct w1_rom rom, void *user_data)
{
    uint8_t *cnt = user_data;

    if (rom.family != DS18B20_FAMILY) {
        return;   /* ignore non-DS18B20 devices (other families) */
    }
    if (*cnt >= MAX_OW_SENSORS) {
        LOG_WRN("1-wire: more than %u DS18B20s found — ignoring extras",
                MAX_OW_SENSORS);
        return;
    }

    s_slaves[*cnt].rom      = rom;
    s_slaves[*cnt].overdrive = 0;

    /* Print ROM as 16 hex digits without %llx (not all RTT backends support it).
     * "found[N]" here is just this scan's discovery order, NOT a config
     * slot — see resolve_slave_index() for how a slot's bound rom_id maps
     * to one of these. */
    uint64_t id = w1_rom_to_uint64(&rom);
    uint32_t id_hi = (uint32_t)(id >> 32);
    uint32_t id_lo = (uint32_t)(id & 0xFFFFFFFFU);
    LOG_INF("1-wire: found[%u] DS18B20 ROM %08X%08X", *cnt, id_hi, id_lo);

    (*cnt)++;
}

/* Send this scan's results (and each sensor's freshly-read temperature)
 * to Linux — see ONEWIRE_ROM_REPORT_CAN_ID above for the wire format.
 * Best-effort: spi_bridge_enqueue() silently drops frames if the queue is
 * full (counted in spi_bridge_drop_count()) rather than blocking; the
 * host side treats a fresh marker frame as always restarting collection,
 * so a dropped frame here just means a stale/short report gets discarded
 * next time, not a permanently wedged state. */
static void report_roms(const float *temps, const bool *temp_valid)
{
    struct can_frame f = { 0 };

    f.id    = ONEWIRE_ROM_REPORT_CAN_ID;
    f.flags = CAN_FRAME_IDE;
    f.dlc   = 8;
    f.data[0] = 0xFFU;
    f.data[1] = s_slave_count;
    spi_bridge_enqueue(&f);

    for (uint8_t i = 0; i < s_slave_count; i++) {
        struct can_frame rf = { 0 };
        rf.id    = ONEWIRE_ROM_REPORT_CAN_ID;
        rf.flags = CAN_FRAME_IDE;
        rf.dlc   = 8;
        sys_put_be64(w1_rom_to_uint64(&s_slaves[i].rom), rf.data);
        spi_bridge_enqueue(&rf);

        struct can_frame tf = { 0 };
        tf.id    = ONEWIRE_ROM_REPORT_CAN_ID;
        tf.flags = CAN_FRAME_IDE;
        tf.dlc   = 8;
        tf.data[0] = ONEWIRE_TEMP_SENTINEL;
        tf.data[1] = temp_valid[i] ? 1U : 0U;
        sys_put_le16((uint16_t)(int16_t)(temps[i] * 100.0f), &tf.data[2]);
        spi_bridge_enqueue(&tf);
    }
}

/* Re-run the ROM search, take a live reading from every sensor found, and
 * report both to Linux. Only ever called from onewire_thread() itself
 * (boot, and in response to a rescan request) — see
 * onewire_request_rescan()'s header comment for why. Reuses convert_all()
 * / read_sensor() (the same SKIP-ROM-broadcast-then-read-each pattern the
 * normal polling loop uses below), so this costs one extra 750ms
 * conversion wait per scan — negligible for a boot-time or user-triggered
 * rescan. */
static void do_scan(void)
{
    s_slave_count = 0;
    int found = w1_search_bus(w1_dev, W1_CMD_SEARCH_ROM, W1_SEARCH_ALL_FAMILIES,
                               search_cb, &s_slave_count);
    if (found < 0) {
        LOG_ERR("1-wire: bus search error (%d)", found);
    } else {
        LOG_INF("1-wire: %u DS18B20 sensor(s) on bus", s_slave_count);
    }

    float temps[MAX_OW_SENSORS] = { 0 };
    bool  temp_valid[MAX_OW_SENSORS] = { 0 };
    if (s_slave_count > 0 && convert_all() == 0) {
        k_msleep(DS18B20_WAIT_MS);
        for (uint8_t i = 0; i < s_slave_count; i++) {
            temp_valid[i] = (read_sensor(i, &temps[i]) == 0);
        }
    }

    report_roms(temps, temp_valid);
}

/* Which s_slaves[] index (if any) currently backs this config slot.
 * rom_id == 0 means the slot was never explicitly bound — falls back to
 * the old "slot N = Nth device found" behavior so an un-migrated config
 * keeps working exactly as before (with the same instability that
 * motivated adding rom_id in the first place, but not a regression for
 * anyone who hasn't set it yet). Returns -1 if the slot is bound to a
 * specific ROM that isn't present in this scan (sensor failed/removed —
 * deliberately does NOT fall back to position in this case, that's the
 * whole point). */
static int resolve_slave_index(const ow_slot_cfg_t *slot, uint8_t slot_idx)
{
    if (slot->rom_id == 0) {
        return (slot_idx < s_slave_count) ? (int)slot_idx : -1;
    }
    for (uint8_t k = 0; k < s_slave_count; k++) {
        if (w1_rom_to_uint64(&s_slaves[k].rom) == slot->rom_id) {
            return (int)k;
        }
    }
    return -1;
}

/* ── Broadcast CONVERT T to all sensors via SKIP ROM ─────────────── */
static int convert_all(void)
{
    w1_lock_bus(w1_dev);

    int ret = w1_reset_bus(w1_dev);
    if (ret < 0) {
        w1_unlock_bus(w1_dev);
        return ret;
    }
    if (ret == 0) {
        w1_unlock_bus(w1_dev);
        return -ENODEV;   /* no presence pulse */
    }

    w1_write_byte(w1_dev, W1_CMD_SKIP_ROM);
    w1_write_byte(w1_dev, DS18B20_CMD_CONVERT_T);

    w1_unlock_bus(w1_dev);
    return 0;
}

/* ── Read scratchpad from one sensor by MATCH ROM ────────────────── */
static int read_sensor(uint8_t idx, float *temp_c_out)
{
    uint8_t cmd = DS18B20_CMD_READ_SP;
    uint8_t sp[DS18B20_SP_LEN];

    /* w1_write_read: lock → reset+MATCH ROM → write cmd → read sp → unlock */
    int ret = w1_write_read(w1_dev, &s_slaves[idx], &cmd, 1, sp, sizeof(sp));
    if (ret != 0) {
        return ret;
    }

    /* Detect no-response: all bytes 0xFF or 0x00 */
    uint8_t orv = 0, andv = 0xFF;
    for (uint8_t i = 0; i < DS18B20_SP_LEN; i++) {
        orv  |= sp[i];
        andv &= sp[i];
    }
    if (orv == 0x00 || andv == 0xFF) {
        return -EIO;
    }

    /* sp[0:1] = raw temperature, 1/16 °C per LSB (12-bit DS18B20) */
    int16_t raw = (int16_t)((uint16_t)sp[0] | ((uint16_t)sp[1] << 8));
    *temp_c_out  = (float)raw / 16.0f;
    return 0;
}

/* ── Main thread ─────────────────────────────────────────────────── */
void onewire_thread(void *unused0, void *unused1, void *unused2)
{
    ARG_UNUSED(unused0);
    ARG_UNUSED(unused1);
    ARG_UNUSED(unused2);

    if (!device_is_ready(w1_dev)) {
        LOG_ERR("1-wire: W1 bus not ready");
        return;
    }

    /* Enumerate all DS18B20s on the bus */
    do_scan();

    while (1) {
        if (atomic_cas(&s_rescan_requested, 1, 0)) {
            do_scan();
        }

        const ow_cfg_t *cfg    = &g_sensor_cfg.onewire;
        uint32_t        poll_ms = (cfg->poll_ms >= 800U) ? cfg->poll_ms : 2000U;

        /* Count slots that need real sensor I/O vs. any enabled slot at all */
        uint8_t real_slots = 0;
        uint8_t any_enabled = 0;
        for (uint8_t i = 0; i < MAX_OW_SENSORS; i++) {
            const ow_slot_cfg_t *s = &cfg->slot[i];
            if (!s->enabled) { continue; }
            any_enabled++;
            if (!s->test_mode && resolve_slave_index(s, i) >= 0) { real_slots++; }
        }

        if (any_enabled == 0) {
            k_sleep(K_MSEC(poll_ms));
            continue;
        }

        int64_t t0 = k_uptime_get();

        /* Step 1: trigger conversion only when real sensors need reading */
        if (real_slots > 0) {
            int ret = convert_all();
            if (ret != 0) {
                LOG_WRN("1-wire: CONVERT T failed (%d)", ret);
                k_sleep(K_MSEC(poll_ms));
                continue;
            }
            /* Step 2: wait for 12-bit conversion to complete */
            k_msleep(DS18B20_WAIT_MS);
        }

        /* Step 3: read or inject test value, then emit N2K frame */
        for (uint8_t i = 0; i < MAX_OW_SENSORS; i++) {
            const ow_slot_cfg_t *slot = &cfg->slot[i];
            if (!slot->enabled) { continue; }

            float temp_c;
            if (slot->test_mode) {
                temp_c = slot->test_value_c;
                int tc = (int)(temp_c * 100.0f);
                int tc_abs = (tc < 0) ? -tc : tc;
                LOG_INF("1-wire[%u]: TEST %s%d.%02d C  src=%u inst=%u",
                        i, (tc < 0) ? "-" : "",
                        tc_abs / 100, tc_abs % 100,
                        slot->n2k_source, slot->n2k_instance);
            } else {
                int idx = resolve_slave_index(slot, i);
                if (idx < 0) {
                    if (slot->rom_id != 0) {
                        LOG_WRN("1-wire[%u]: bound sensor not found on bus "
                                "(failed/removed? try Rescan in the config page)", i);
                    }
                    continue;
                }
                int ret = read_sensor((uint8_t)idx, &temp_c);
                if (ret != 0) {
                    LOG_WRN("1-wire[%u]: read failed (%d)", i, ret);
                    continue;
                }
                int tc = (int)(temp_c * 100.0f);
                int tc_abs = (tc < 0) ? -tc : tc;
                LOG_INF("1-wire[%u]: %s%d.%02d C  src=%u inst=%u",
                        i, (tc < 0) ? "-" : "",
                        tc_abs / 100, tc_abs % 100,
                        slot->n2k_source, slot->n2k_instance);
            }

            float temp_k = temp_c + KELVIN_OFFSET;

            struct can_frame frames[N2K_TEMP_MAX_FRAMES];
            int nframes = n2k_build_temp_frames(slot->n2k_pgn_id,
                                                slot->n2k_instance,
                                                slot->n2k_source,
                                                temp_k, frames);
            LED4B_BLINK(1);
            for (int fi = 0; fi < nframes; fi++) {
                int ret = n2k_send_frame(&frames[fi]);
                if (ret != 0) {
                    LOG_WRN("1-wire[%u]: FDCAN TX failed (%d)", i, ret);
                }
                ret = spi_bridge_enqueue(&frames[fi]);
                if (ret != 0) {
                    LOG_WRN("1-wire[%u]: SPI bridge TX full (%d)", i, ret);
                }
            }
        }

        /* Step 4: sleep for remaining poll time */
        int64_t elapsed  = k_uptime_get() - t0;
        int64_t sleep_ms = (int64_t)poll_ms - elapsed;
        if (sleep_ms > 0) {
            k_sleep(K_MSEC((uint32_t)sleep_ms));
        }
    }
}
