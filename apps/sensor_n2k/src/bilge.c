#include "bilge.h"
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
#include <zephyr/sys/byteorder.h>

LOG_MODULE_REGISTER(bilge, LOG_LEVEL_INF);

/*
 * Bilge pump monitoring — 4 opto-isolated digital inputs, edge-timestamped
 * to track per-channel: current on/off state, cycle count (off->on
 * transitions), and total on-time, each as a ROLLING window over the last
 * 1 hour, last 24 hours, and last 7 days ("current week"). Also broadcasts
 * current state as PGN 127501 (Binary Switch Bank Status).
 *
 * Alarm THRESHOLDS on these rolling stats (e.g. "more than N cycles in the
 * last hour") are host-side, in alarm-server.js — same division of labor
 * as every other alarm in this project: firmware reports data, the host
 * applies rules and drives notifications.
 *
 * Rolling-window implementation: two ring buffers of fixed-size buckets
 * per channel, indexed by k_uptime_get()-derived minute/hour number (i.e.
 * relative to boot, not wall-clock — this board has no RTC). A bucket's
 * `tag` records which absolute minute/hour it holds data for; a bucket
 * whose tag doesn't match the minute/hour it's about to be written into
 * is stale (either never used, or wrapped around from >7 days ago) and
 * gets cleared first. This bounds memory to a fixed size regardless of
 * how long the device has been running, at the cost of losing sub-bucket
 * precision (a transition is attributed to whichever bucket(s) the time
 * it actually occurred in falls into, split across a boundary if needed)
 * and losing all history across a reboot (no NVS persistence for this —
 * a straightforward addition later if a week's continuity across a
 * power-cycle turns out to matter in practice).
 *
 *   - 60 one-minute buckets  -> exact rolling 1-hour window
 *   - 168 one-hour buckets   -> rolling 24-hour window (trailing 24 of the
 *                               168) and rolling 7-day window (all 168)
 */

#define BILGE_MINUTE_BUCKETS 60U
#define BILGE_HOUR_BUCKETS   168U
#define BILGE_REPORT_MS      5000U  /* report + PGN 127501 broadcast cadence */
#define BILGE_TAG_UNUSED     0xFFFFFFFFUL

/* Debounce window is runtime-configurable (g_sensor_cfg.bilge.debounce_ms,
 * CFG_PARAM_BILGE_DEBOUNCE_MS) rather than a compile-time constant — a
 * real float switch chatters for much longer than a clean opto/electrical
 * bounce as it bobs with wave action, and the right value depends on the
 * actual switch, only knowable once real hardware is wired up. See
 * bilge_isr() below for where this is read. */

/* Local-only diagnostic frame (never touches the physical bus — same
 * 0x1EFFFEx family as the other local-diagnostic IDs, see onewire.c's
 * ONEWIRE_ROM_REPORT_CAN_ID for the sibling convention) reporting each
 * channel's live state + rolling stats to Linux, so the host UI can show
 * per-pump counts/runtime without needing to replicate this bucket math
 * itself. Sent once per BILGE_REPORT_MS, 4 frames per channel:
 *   data[0] = channel (0-3)
 *   data[1] = record type: 0xB0=state, 0xB1=last-1h, 0xB2=last-24h, 0xB3=last-7d
 *   state:     data[2] = 0/1 (off/on), rest unused
 *   1h/24h/7d: data[2..3] = cycle count (u16 LE), data[4..7] = on-time
 *              in seconds (u32 LE)
 */
#define BILGE_REPORT_CAN_ID 0x1EFFFEBUL
#define BILGE_REC_STATE  0xB0U
#define BILGE_REC_1H     0xB1U
#define BILGE_REC_24H    0xB2U
#define BILGE_REC_7D     0xB3U

static const struct gpio_dt_spec s_gpio[BILGE_NUM_CHANNELS] = {
	GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), bilge0_gpios),
	GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), bilge1_gpios),
	GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), bilge2_gpios),
	GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), bilge3_gpios),
};

struct bilge_bucket {
	uint32_t tag;     /* absolute minute/hour number, BILGE_TAG_UNUSED = never written */
	uint16_t cycles;
	uint32_t on_ms;
};

struct bilge_state {
	struct gpio_callback cb;
	struct k_spinlock    lock;   /* guards everything below, shared ISR/thread */

	atomic_t level;              /* 0=off,1=on — current debounced state */
	int64_t  last_edge_ms;       /* uptime of last *accepted* edge, for debounce */
	int64_t  committed_ms;       /* uptime up to which bucket time has been committed */

	struct bilge_bucket minute[BILGE_MINUTE_BUCKETS];
	struct bilge_bucket hour[BILGE_HOUR_BUCKETS];
};

static struct bilge_state s_state[BILGE_NUM_CHANNELS];

/* ── Bucket accounting (caller must hold s->lock) ────────────────────
 * Attributes the [from_ms, to_ms) on-time span to every minute/hour
 * bucket it overlaps, splitting at bucket boundaries. Safe to call with
 * any span, including one spanning many buckets (a long-stuck-on pump) —
 * cost is proportional to the number of buckets crossed, bounded by the
 * ring sizes above. */
static void bilge_commit_span(struct bilge_state *s, int64_t from_ms, int64_t to_ms)
{
	if (to_ms <= from_ms) {
		return;
	}

	int64_t t = from_ms;
	while (t < to_ms) {
		uint32_t minute_num = (uint32_t)(t / 60000);
		int64_t  minute_end = ((int64_t)minute_num + 1) * 60000;
		int64_t  seg_end    = MIN(to_ms, minute_end);
		struct bilge_bucket *b = &s->minute[minute_num % BILGE_MINUTE_BUCKETS];

		if (b->tag != minute_num) {
			b->tag = minute_num;
			b->cycles = 0;
			b->on_ms = 0;
		}
		b->on_ms += (uint32_t)(seg_end - t);
		t = seg_end;
	}

	t = from_ms;
	while (t < to_ms) {
		uint32_t hour_num = (uint32_t)(t / 3600000);
		int64_t  hour_end = ((int64_t)hour_num + 1) * 3600000;
		int64_t  seg_end  = MIN(to_ms, hour_end);
		struct bilge_bucket *b = &s->hour[hour_num % BILGE_HOUR_BUCKETS];

		if (b->tag != hour_num) {
			b->tag = hour_num;
			b->cycles = 0;
			b->on_ms = 0;
		}
		b->on_ms += (uint32_t)(seg_end - t);
		t = seg_end;
	}
}

/* Record a cycle (off->on transition) starting at now_ms — caller must
 * hold s->lock. A cycle is tagged to the single bucket its *start* falls
 * in, unlike on-time which can split across buckets. */
static void bilge_record_cycle(struct bilge_state *s, int64_t now_ms)
{
	uint32_t minute_num = (uint32_t)(now_ms / 60000);
	struct bilge_bucket *mb = &s->minute[minute_num % BILGE_MINUTE_BUCKETS];

	if (mb->tag != minute_num) {
		mb->tag = minute_num;
		mb->cycles = 0;
		mb->on_ms = 0;
	}
	mb->cycles++;

	uint32_t hour_num = (uint32_t)(now_ms / 3600000);
	struct bilge_bucket *hb = &s->hour[hour_num % BILGE_HOUR_BUCKETS];

	if (hb->tag != hour_num) {
		hb->tag = hour_num;
		hb->cycles = 0;
		hb->on_ms = 0;
	}
	hb->cycles++;
}

/* ── GPIO ISR ─────────────────────────────────────────────────────── */
static void bilge_isr(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
	ARG_UNUSED(pins);
	struct bilge_state *s = CONTAINER_OF(cb, struct bilge_state, cb);
	uint8_t chan = (uint8_t)(s - s_state);

	int64_t now = k_uptime_get();

	k_spinlock_key_t key = k_spin_lock(&s->lock);

	if ((now - s->last_edge_ms) < (int64_t)g_sensor_cfg.bilge.debounce_ms) {
		k_spin_unlock(&s->lock, key);
		return;   /* debounce: ignore, and deliberately don't touch last_edge_ms */
	}
	s->last_edge_ms = now;

	int new_level = gpio_pin_get_dt(&s_gpio[chan]);   /* logical level, ACTIVE_LOW already resolved */
	int old_level = (int)atomic_get(&s->level);

	if (new_level == old_level) {
		k_spin_unlock(&s->lock, key);
		return;   /* both-edges IRQ can fire without a logical change under noise */
	}

	/* Commit on-time accrued since the last commit point up to now, then
	 * move the commit point forward — unifies the edge-driven commit
	 * here with the thread's periodic in-progress commit below. */
	if (old_level == 1) {
		bilge_commit_span(s, s->committed_ms, now);
	}

	if (new_level == 1) {
		bilge_record_cycle(s, now);
		s->committed_ms = now;
		/* No LED4G_BLINK() here — do_blink() (led.c) calls k_sleep(),
		 * which is illegal from interrupt context and faults the MCU on
		 * every rising edge. bilge_thread() already blinks LED4B once
		 * per report cycle from thread context, which is the safe
		 * place for this kind of visual feedback. */
	}

	atomic_set(&s->level, new_level);
	k_spin_unlock(&s->lock, key);
}

/* ── Query: current rolling stats for one channel ────────────────── */
struct bilge_stats {
	uint8_t  state;
	uint16_t cycles_1h;
	uint32_t on_s_1h;
	uint16_t cycles_24h;
	uint32_t on_s_24h;
	uint16_t cycles_7d;
	uint32_t on_s_7d;
};

static void bilge_query(uint8_t chan, struct bilge_stats *out)
{
	struct bilge_state *s = &s_state[chan];
	k_spinlock_key_t key = k_spin_lock(&s->lock);

	/* Bring bucket accounting up to "now" for an in-progress on-period,
	 * so a query reflects a currently-running pump immediately rather
	 * than only once it eventually switches off. */
	int64_t now = k_uptime_get();
	if (atomic_get(&s->level)) {
		bilge_commit_span(s, s->committed_ms, now);
		s->committed_ms = now;
	}

	uint32_t cur_minute = (uint32_t)(now / 60000);
	uint32_t cur_hour   = (uint32_t)(now / 3600000);

	uint64_t c1h = 0, ms1h = 0;
	for (uint32_t i = 0; i < BILGE_MINUTE_BUCKETS; i++) {
		struct bilge_bucket *b = &s->minute[i];
		if (b->tag != BILGE_TAG_UNUSED && (cur_minute - b->tag) < BILGE_MINUTE_BUCKETS) {
			c1h += b->cycles;
			ms1h += b->on_ms;
		}
	}

	uint64_t c24 = 0, ms24 = 0, c7d = 0, ms7d = 0;
	for (uint32_t i = 0; i < BILGE_HOUR_BUCKETS; i++) {
		struct bilge_bucket *b = &s->hour[i];
		if (b->tag == BILGE_TAG_UNUSED || (cur_hour - b->tag) >= BILGE_HOUR_BUCKETS) {
			continue;
		}
		c7d += b->cycles;
		ms7d += b->on_ms;
		if ((cur_hour - b->tag) < 24U) {
			c24 += b->cycles;
			ms24 += b->on_ms;
		}
	}

	out->state       = (uint8_t)atomic_get(&s->level);
	out->cycles_1h   = (uint16_t)MIN(c1h, 0xFFFFUL);
	out->on_s_1h     = (uint32_t)(ms1h / 1000U);
	out->cycles_24h  = (uint16_t)MIN(c24, 0xFFFFUL);
	out->on_s_24h    = (uint32_t)(ms24 / 1000U);
	out->cycles_7d   = (uint16_t)MIN(c7d, 0xFFFFUL);
	out->on_s_7d     = (uint32_t)(ms7d / 1000U);

	k_spin_unlock(&s->lock, key);
}

/* ── Report to Linux (see BILGE_REPORT_CAN_ID above for wire format) ─ */
static void bilge_send_report(uint8_t chan, const struct bilge_stats *st)
{
	struct can_frame f = { 0 };
	f.flags = CAN_FRAME_IDE;
	f.dlc = 8;
	f.id = BILGE_REPORT_CAN_ID;

	f.data[0] = chan;
	f.data[1] = BILGE_REC_STATE;
	f.data[2] = st->state;
	spi_bridge_enqueue(&f);

	memset(f.data, 0, sizeof(f.data));
	f.data[0] = chan;
	f.data[1] = BILGE_REC_1H;
	sys_put_le16(st->cycles_1h, &f.data[2]);
	sys_put_le32(st->on_s_1h, &f.data[4]);
	spi_bridge_enqueue(&f);

	memset(f.data, 0, sizeof(f.data));
	f.data[0] = chan;
	f.data[1] = BILGE_REC_24H;
	sys_put_le16(st->cycles_24h, &f.data[2]);
	sys_put_le32(st->on_s_24h, &f.data[4]);
	spi_bridge_enqueue(&f);

	memset(f.data, 0, sizeof(f.data));
	f.data[0] = chan;
	f.data[1] = BILGE_REC_7D;
	sys_put_le16(st->cycles_7d, &f.data[2]);
	sys_put_le32(st->on_s_7d, &f.data[4]);
	spi_bridge_enqueue(&f);
}

/* ── Thread: periodic in-progress commit, report, PGN 127501 ─────── */
#define BILGE_STACK_SIZE 1024U
#define BILGE_PRIO       5

K_THREAD_STACK_DEFINE(bilge_stack, BILGE_STACK_SIZE);
static struct k_thread bilge_thread_data;

static void bilge_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	while (1) {
		const bilge_cfg_t *cfg = &g_sensor_cfg.bilge;
		uint8_t switch_states[4] = { 0, 0, 0, 0 };
		bool any_enabled = false;

		for (uint8_t i = 0; i < BILGE_NUM_CHANNELS; i++) {
			if (!cfg->enabled[i]) {
				continue;
			}
			any_enabled = true;

			struct bilge_stats st;
			bilge_query(i, &st);
			switch_states[i] = st.state;
			bilge_send_report(i, &st);
		}

		if (any_enabled) {
			struct can_frame f;
			n2k_build_switch_frame(cfg->switch_bank_instance, switch_states, &f);
			LED4B_BLINK(1);
			int r = n2k_send_frame(&f);
			if (r != 0) {
				LOG_WRN("bilge: FDCAN TX failed (%d)", r);
			}
			spi_bridge_enqueue(&f);
		}

		k_msleep(BILGE_REPORT_MS);
	}
}

/* ── Public init ──────────────────────────────────────────────────── */
void bilge_init(const struct device *can_dev)
{
	ARG_UNUSED(can_dev);

	for (uint8_t i = 0; i < BILGE_NUM_CHANNELS; i++) {
		struct bilge_state *s = &s_state[i];

		if (!gpio_is_ready_dt(&s_gpio[i])) {
			LOG_ERR("bilge%u: GPIO not ready", i);
			continue;
		}

		gpio_pin_configure_dt(&s_gpio[i], GPIO_INPUT);

		for (uint32_t m = 0; m < BILGE_MINUTE_BUCKETS; m++) {
			s->minute[m].tag = BILGE_TAG_UNUSED;
		}
		for (uint32_t h = 0; h < BILGE_HOUR_BUCKETS; h++) {
			s->hour[h].tag = BILGE_TAG_UNUSED;
		}
		atomic_set(&s->level, gpio_pin_get_dt(&s_gpio[i]));
		s->last_edge_ms = k_uptime_get();
		s->committed_ms = s->last_edge_ms;

		gpio_init_callback(&s->cb, bilge_isr, BIT(s_gpio[i].pin));
		gpio_add_callback(s_gpio[i].port, &s->cb);
		gpio_pin_interrupt_configure_dt(&s_gpio[i], GPIO_INT_EDGE_BOTH);

		if (g_sensor_cfg.bilge.enabled[i]) {
			LOG_INF("bilge%u: enabled, initial state=%ld", i, atomic_get(&s->level));
		} else {
			LOG_INF("bilge%u: disabled (will activate on config update)", i);
		}
	}

	/* Always start the thread — it checks cfg->enabled[] each iteration,
	 * same pattern as pulse_counter.c, so runtime enable via bridge.js
	 * works without a reboot. */
	k_thread_create(&bilge_thread_data, bilge_stack, BILGE_STACK_SIZE,
			bilge_thread, NULL, NULL, NULL,
			BILGE_PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&bilge_thread_data, "bilge");
}
