#include "onewire.h"
#include "sensor_config.h"
#include "n2k.h"
#include "spi_bridge.h"
#include "led.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/w1.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(onewire_n2k, LOG_LEVEL_INF);

/*
 * Drive the 1-Wire bus on PB4 (D8) directly using the W1 API.
 * Sensors are discovered by ROM search at startup; each maps to a
 * config slot (g_sensor_cfg.onewire.slot[0..3]) in discovery order.
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

static const struct device *w1_dev = DEVICE_DT_GET(W1_NODE);

/* Discovered sensors — populated by ROM search at startup */
static struct w1_slave_config s_slaves[MAX_OW_SENSORS];
static uint8_t s_slave_count;

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

    /* Print ROM as 16 hex digits without %llx (not all RTT backends support it) */
    uint64_t id = w1_rom_to_uint64(&rom);
    uint32_t id_hi = (uint32_t)(id >> 32);
    uint32_t id_lo = (uint32_t)(id & 0xFFFFFFFFU);
    LOG_INF("1-wire: slot %u → DS18B20 ROM %08X%08X", *cnt, id_hi, id_lo);

    (*cnt)++;
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
    s_slave_count = 0;
    int found = w1_search_bus(w1_dev, W1_CMD_SEARCH_ROM, W1_SEARCH_ALL_FAMILIES,
                               search_cb, &s_slave_count);
    if (found < 0) {
        LOG_ERR("1-wire: bus search error (%d)", found);
    } else {
        LOG_INF("1-wire: %u DS18B20 sensor(s) on bus", s_slave_count);
    }

    while (1) {
        const ow_cfg_t *cfg    = &g_sensor_cfg.onewire;
        uint32_t        poll_ms = (cfg->poll_ms >= 800U) ? cfg->poll_ms : 2000U;

        if (s_slave_count == 0) {
            k_sleep(K_MSEC(poll_ms));
            continue;
        }

        int64_t t0 = k_uptime_get();

        /* Step 1: trigger conversion on all sensors at once */
        int ret = convert_all();
        if (ret != 0) {
            LOG_WRN("1-wire: CONVERT T failed (%d)", ret);
            k_sleep(K_MSEC(poll_ms));
            continue;
        }

        /* Step 2: wait for 12-bit conversion to complete */
        k_msleep(DS18B20_WAIT_MS);

        /* Step 3: read each sensor and emit N2K frame for enabled slots */
        for (uint8_t i = 0; i < s_slave_count; i++) {
            const ow_slot_cfg_t *slot = &cfg->slot[i];

            if (!slot->enabled) {
                continue;
            }

            float temp_c;
            ret = read_sensor(i, &temp_c);
            if (ret != 0) {
                LOG_WRN("1-wire[%u]: read failed (%d)", i, ret);
                continue;
            }

            /* Log as integer parts to avoid %f */
            int tc = (int)(temp_c * 100.0f);
            int tc_abs = (tc < 0) ? -tc : tc;
            LOG_INF("1-wire[%u]: %s%d.%02d C  src=%u inst=%u",
                    i, (tc < 0) ? "-" : "",
                    tc_abs / 100, tc_abs % 100,
                    slot->n2k_source, slot->n2k_instance);

            float    temp_k = temp_c + KELVIN_OFFSET;
            uint16_t raw    = (uint16_t)(temp_k * 100.0f);

            struct can_frame frame = {0};
            frame.id      = n2k_can_id(N2K_PGN_TEMP, N2K_PRIORITY, n2k_sa_get());
            frame.flags   = CAN_FRAME_IDE;
            frame.dlc     = 8;
            frame.data[0] = 0;                    /* SID */
            frame.data[1] = slot->n2k_instance;
            frame.data[2] = slot->n2k_source;
            frame.data[3] = raw        & 0xFFU;
            frame.data[4] = (raw >> 8) & 0xFFU;
            frame.data[5] = 0xFFU;                /* Set Temp N/A */
            frame.data[6] = 0xFFU;
            frame.data[7] = 0xFFU;

            LED4B_BLINK(1);

            /* Transmit on the physical N2K bus for other devices (chartplotters etc.) */
            ret = n2k_send_frame(&frame);
            if (ret != 0) {
                LOG_WRN("1-wire[%u]: FDCAN TX failed (%d)", i, ret);
            }

            /* Also forward to Linux/SignalK via SPI bridge */
            ret = spi_bridge_enqueue(&frame);
            if (ret != 0) {
                LOG_WRN("SPI bridge TX full: %d", ret);
            }
        }

        /* Step 4: sleep for remaining poll time (conversion already consumed 750 ms) */
        int64_t elapsed  = k_uptime_get() - t0;
        int64_t sleep_ms = (int64_t)poll_ms - elapsed;
        if (sleep_ms > 0) {
            k_sleep(K_MSEC((uint32_t)sleep_ms));
        }
    }
}
