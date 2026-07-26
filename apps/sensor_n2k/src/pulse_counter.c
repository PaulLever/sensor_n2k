#include "pulse_counter.h"
#include "sensor_config.h"
#include "n2k.h"
#include "spi_bridge.h"
#include "led.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/atomic.h>

LOG_MODULE_REGISTER(pulse_ctr, LOG_LEVEL_INF);

/* ── GPIO specs — D3/PB0 and D6/PB1 declared in boards overlay ───── */
static const struct gpio_dt_spec s_gpio[2] = {
    GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), pc0_gpios),
    GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), pc1_gpios),
};

/* ── Per-counter state ───────────────────────────────────────────── */
#define PC_AVG_MAX  10U

struct pc_state {
    atomic_t             count;         /* incremented in ISR                 */
    struct gpio_callback cb;
    float                ring[PC_AVG_MAX]; /* circular buffer of Hz samples   */
    uint8_t              head;          /* next write index (0…PC_AVG_MAX-1)  */
    uint8_t              filled;        /* how many ring slots are valid       */
};

static struct pc_state s_state[2];

/* ── GPIO ISR (interrupt context) ────────────────────────────────── */
static void pc_isr(const struct device *dev, struct gpio_callback *cb,
                   uint32_t pins)
{
    ARG_UNUSED(dev);
    ARG_UNUSED(pins);
    struct pc_state *s = CONTAINER_OF(cb, struct pc_state, cb);
    atomic_inc(&s->count);
}

/* ── N2K frame builder ───────────────────────────────────────────── */
static void pc_publish(uint8_t idx)
{
    const pc_cfg_t  *cfg = &g_sensor_cfg.pulse[idx];
    struct pc_state *s   = &s_state[idx];

    /* Snapshot and reset pulse count */
    int32_t pulses = (int32_t)atomic_set(&s->count, 0);
    if (pulses > 0) {
            LED4G_BLINK(1);
    }
    float   hz     = (float)pulses / ((float)cfg->update_ms * 0.001f);

    /* Push Hz into ring buffer (always at full PC_AVG_MAX width) */
    s->ring[s->head] = hz;
    s->head = (uint8_t)((s->head + 1U) % PC_AVG_MAX);
    if (s->filled < PC_AVG_MAX) {
        s->filled++;
    }

    /* Average the most recent min(filled, avg_samples) entries */
    uint8_t depth = cfg->avg_samples;
    if (depth < 1U)       { depth = 1U; }
    if (depth > PC_AVG_MAX) { depth = PC_AVG_MAX; }
    uint8_t n = (s->filled < depth) ? s->filled : depth;

    float sum = 0.0f;
    for (uint8_t j = 0; j < n; j++) {
        uint8_t k = (uint8_t)((s->head + PC_AVG_MAX - 1U - j) % PC_AVG_MAX);
        sum += s->ring[k];
    }
    float avg_hz = (n > 0U) ? (sum / (float)n) : 0.0f;

    /* Build the N2K CAN frame */
    struct can_frame f = {0};
    f.flags = CAN_FRAME_IDE;
    f.dlc   = 8;

    if (cfg->mode == PC_MODE_STW) {
        float safe_hz = (cfg->hz_per_mps > 0.0f) ? cfg->hz_per_mps : 9.33f;
        float mps = avg_hz / safe_hz;
        if (mps > 655.35f) { mps = 655.35f; }
        uint16_t raw = (uint16_t)(mps * 100.0f + 0.5f);   /* 0.01 m/s per bit */

        f.id      = n2k_can_id(N2K_PGN_STW, N2K_PRIORITY, n2k_sa_get());
        f.data[0] = 0;               /* SID */
        f.data[1] = raw & 0xFFU;     /* Speed Water Referenced LSB */
        f.data[2] = (raw >> 8) & 0xFFU;
        f.data[3] = 0xFF;            /* Speed Ground Referenced N/A */
        f.data[4] = 0xFF;
        f.data[5] = 0x00;            /* bits[3:0]=0 (paddle wheel), upper=0 */
        f.data[6] = 0xFF;
        f.data[7] = 0xFF;

        int mps_x100 = (int)(mps * 100.0f + 0.5f);
        LOG_INF("PC%u STW: %d.%02d m/s  avg_hz=%.2f",
                idx, mps_x100 / 100, mps_x100 % 100, (double)avg_hz);
    } else {
        float safe_ppr = (cfg->pulses_per_rev > 0.0f) ? cfg->pulses_per_rev : 1.0f;
        float rpm = avg_hz * 60.0f / safe_ppr;
        if (rpm > 16383.75f) { rpm = 16383.75f; }
        uint16_t raw = (uint16_t)(rpm * 4.0f + 0.5f);     /* 0.25 RPM per bit */

        f.id      = n2k_can_id(N2K_PGN_ENGINE_RAPID, N2K_PRIORITY, n2k_sa_get());
        f.data[0] = cfg->engine_instance;
        f.data[1] = raw & 0xFFU;     /* Engine Speed LSB */
        f.data[2] = (raw >> 8) & 0xFFU;
        f.data[3] = 0xFF;            /* Boost Pressure N/A */
        f.data[4] = 0xFF;
        f.data[5] = 0xFF;            /* Tilt/Trim N/A */
        f.data[6] = 0xFF;
        f.data[7] = 0xFF;

        int rpm_x10 = (int)(rpm * 10.0f + 0.5f);
        LOG_INF("PC%u RPM: %d.%d  avg_hz=%.2f",
                idx, rpm_x10 / 10, rpm_x10 % 10, (double)avg_hz);
    }

    LED4B_BLINK(1);
    int r = n2k_send_frame(&f);
    if (r != 0) {
        LOG_WRN("PC%u: FDCAN TX failed (%d)", idx, r);
    }
    spi_bridge_enqueue(&f);
}

/* ── Sampling thread — handles both counters ─────────────────────── */
#define PC_STACK_SIZE 768U
#define PC_PRIO         5

K_THREAD_STACK_DEFINE(pc_stack, PC_STACK_SIZE);
static struct k_thread pc_thread_data;

static void pc_thread(void *a, void *b, void *c)
{
    ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

    int64_t next[2] = {0, 0};

    while (1) {
        int64_t now      = k_uptime_get();
        int64_t sleep_to = now + 2000;  /* max sleep if both disabled */

        for (uint8_t i = 0; i < 2U; i++) {
            const pc_cfg_t *cfg = &g_sensor_cfg.pulse[i];
            if (!cfg->enabled) {
                continue;
            }
            if (now >= next[i]) {
                pc_publish(i);
                next[i] = now + cfg->update_ms;
            }
            if (next[i] < sleep_to) {
                sleep_to = next[i];
            }
        }

        int64_t sleep_ms = sleep_to - k_uptime_get();
        if (sleep_ms > 0) {
            k_msleep((int32_t)sleep_ms);
        }
    }
}

/* ── Public reset (called when a counter is enabled at runtime) ──── */
void pulse_counter_reset(uint8_t idx)
{
    if (idx >= 2U) { return; }
    atomic_set(&s_state[idx].count, 0);
    s_state[idx].head   = 0;
    s_state[idx].filled = 0;
}

/* ── Public init ─────────────────────────────────────────────────── */
void pulse_counter_init(const struct device *can_dev)
{
    ARG_UNUSED(can_dev);

    bool any_enabled = false;

    for (uint8_t i = 0; i < 2U; i++) {
        const pc_cfg_t *cfg = &g_sensor_cfg.pulse[i];

        if (!gpio_is_ready_dt(&s_gpio[i])) {
            LOG_ERR("PC%u: GPIO not ready", i);
            continue;
        }

        /* Always configure input + ISR so the counter works if enabled later
         * via runtime config update without needing a reboot. */
        gpio_pin_configure_dt(&s_gpio[i], GPIO_INPUT);

        atomic_set(&s_state[i].count, 0);
        s_state[i].head   = 0;
        s_state[i].filled = 0;

        gpio_init_callback(&s_state[i].cb, pc_isr, BIT(s_gpio[i].pin));
        gpio_add_callback(s_gpio[i].port, &s_state[i].cb);
        gpio_pin_interrupt_configure_dt(&s_gpio[i], GPIO_INT_EDGE_RISING);

        if (cfg->enabled) {
            LOG_INF("PC%u: %s  update=%u ms  avg=%u  %s",
                    i,
                    cfg->mode == PC_MODE_STW ? "STW" : "RPM",
                    cfg->update_ms,
                    cfg->avg_samples,
                    i == 0U ? "D3/PB0" : "D6/PB1");
            any_enabled = true;
        } else {
            LOG_INF("PC%u: disabled (will activate on config update)", i);
        }
    }

    /* Always start the thread — it checks cfg->enabled each iteration.
     * This allows runtime enable via bridge.js without a reboot. */
    (void)any_enabled;
    k_thread_create(&pc_thread_data, pc_stack, PC_STACK_SIZE,
                    pc_thread, NULL, NULL, NULL,
                    PC_PRIO, 0, K_NO_WAIT);
    k_thread_name_set(&pc_thread_data, "pulse_ctr");
}
