#include "alarm_io.h"
#include "spi_bridge.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(alarm_io, LOG_LEVEL_INF);

/* Single fixed CAN ID for the cancel-button event — same family as
 * DIAG_CAN_ID (0x1EFFFEF) / DIAG2_CAN_ID (0x1EFFFEE) in spi_bridge.c, all
 * outside SENSOR_CFG_CAN_ID_BASE/MASK so spi_bridge.c's catch-all RX filter
 * would forward them if they arrived from the bus — but this frame never
 * touches the physical bus at all, it goes straight to spi_bridge_enqueue()
 * the same way the diagnostic heartbeat does, since it's a purely local
 * (button → Linux) event, not N2K bus traffic. */
#define ALARM_BTN_CAN_ID 0x1EFFFEDUL

/* Same convention as pulse_counter.c's pc0_gpios/pc1_gpios: properties on
 * the shared zephyr_user node, not standalone labeled nodes. */
static const struct gpio_dt_spec buzzer = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), alarm_buzzer_gpios);
static const struct gpio_dt_spec led    = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), alarm_led_gpios);
static const struct gpio_dt_spec button = GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), alarm_button_gpios);

static struct gpio_callback button_cb;

/* Buzzer pattern state, driven by a single repeating timer:
 *   0 off, 1 continuous (steady on, timer unused), 2 repeat-beep
 *   (toggle every BEEP_TOGGLE_MS, "warning" tier), 3 beep-burst
 *   (SINGLE_BEEP_COUNT toggles at SINGLE_BEEP_MS then auto-stop, "buzzer"
 *   tier), 4 bell (fast toggle forever at BELL_TOGGLE_MS, mimicking a
 *   marine bell alarm's rapid strike cadence).
 *
 * v1 hardware is on/off only (no PWM) — there is no way to hit the
 * target dB ranges (buzzer 85-95dB / warning 95-105dB / alarm 105-115dB+)
 * from software on this piezo. Loudness/urgency is instead differentiated
 * by cadence: buzzer's brief burst < warning's steady toggle < alarm's
 * continuous tone < bell's rapid strike. Real calibrated dB control only
 * exists for the bt_speaker output path (see bt-speaker.js).
 * volume is stored for API completeness only — no-op in v1 hardware. */
#define BEEP_TOGGLE_MS      400U   /* warning tier: repeats until cleared */
#define BELL_TOGGLE_MS      130U   /* bell tier: repeats until cleared */
#define SINGLE_BEEP_MS      350U   /* buzzer tier: per on/off phase */
#define SINGLE_BEEP_COUNT     6U   /* buzzer tier: total toggles (3 beeps), then auto-stop */

static uint8_t  s_buzzer_pattern;
static uint8_t  s_buzzer_volume;
static bool     s_buzzer_on;
static uint16_t s_beep_toggles_left;

static void buzzer_timer_fn(struct k_timer *t);
K_TIMER_DEFINE(buzzer_timer, buzzer_timer_fn, NULL);

static void buzzer_timer_fn(struct k_timer *t)
{
	ARG_UNUSED(t);

	switch (s_buzzer_pattern) {
	case 2: /* warning: toggle forever */
	case 4: /* bell: toggle forever, faster period */
		s_buzzer_on = !s_buzzer_on;
		gpio_pin_set_dt(&buzzer, s_buzzer_on ? 1 : 0);
		break;
	case 3: /* buzzer: fixed-count toggle burst, then auto-stop */
		s_buzzer_on = !s_buzzer_on;
		gpio_pin_set_dt(&buzzer, s_buzzer_on ? 1 : 0);
		if (--s_beep_toggles_left == 0) {
			k_timer_stop(&buzzer_timer);
			s_buzzer_pattern = 0;
		}
		break;
	default:
		break;
	}
}

void alarm_io_set_buzzer(uint8_t pattern, uint8_t volume)
{
	s_buzzer_volume = volume;   /* stored, unused — see header comment */
	k_timer_stop(&buzzer_timer);

	switch (pattern) {
	case 0: /* off */
		gpio_pin_set_dt(&buzzer, 0);
		s_buzzer_on = false;
		break;
	case 1: /* continuous (alarm tier) */
		gpio_pin_set_dt(&buzzer, 1);
		s_buzzer_on = true;
		break;
	case 2: /* repeat-beep (warning tier) */
		s_buzzer_on = true;
		gpio_pin_set_dt(&buzzer, 1);
		k_timer_start(&buzzer_timer, K_MSEC(BEEP_TOGGLE_MS), K_MSEC(BEEP_TOGGLE_MS));
		break;
	case 3: /* beep-burst (buzzer tier) */
		s_buzzer_on = true;
		gpio_pin_set_dt(&buzzer, 1);
		s_beep_toggles_left = SINGLE_BEEP_COUNT - 1U;   /* first ON phase already applied above */
		k_timer_start(&buzzer_timer, K_MSEC(SINGLE_BEEP_MS), K_MSEC(SINGLE_BEEP_MS));
		break;
	case 4: /* bell */
		s_buzzer_on = true;
		gpio_pin_set_dt(&buzzer, 1);
		k_timer_start(&buzzer_timer, K_MSEC(BELL_TOGGLE_MS), K_MSEC(BELL_TOGGLE_MS));
		break;
	default:
		LOG_WRN("alarm_io: unknown buzzer pattern %u", pattern);
		return;
	}
	s_buzzer_pattern = pattern;
}

void alarm_io_set_led(uint8_t state)
{
	switch (state) {
	case 0: gpio_pin_set_dt(&led, 0); break;
	case 1: gpio_pin_set_dt(&led, 1); break;
	case 2:
		/* Blink is driven the same way host-side alarm-server.js drives
		 * buzzer repeat patterns — poll/toggle from there via repeated
		 * {type:'led',state:0/1} commands — rather than a second
		 * independent on-MCU timer for one LED. Treat as "on" here so
		 * the LED is at least visible if blink commands stop arriving. */
		gpio_pin_set_dt(&led, 1);
		break;
	default:
		LOG_WRN("alarm_io: unknown led state %u", state);
		break;
	}
}

void alarm_io_stop_all(void)
{
	k_timer_stop(&buzzer_timer);
	s_buzzer_pattern = 0;
	s_buzzer_on = false;
	gpio_pin_set_dt(&buzzer, 0);
	gpio_pin_set_dt(&led, 0);
}

/* ------------------------------------------------------------------ */
/* Cancel button — debounced ISR, deferred send                       */
/* ------------------------------------------------------------------ */

/* GPIO ISRs run in interrupt context and must not block; can_send()/
 * spi_bridge_enqueue() are not ISR-safe (same reason pulse_counter.c's
 * ISR only does atomic_inc() and defers real work to a thread). The ISR
 * here just debounces and submits a work item; the actual enqueue happens
 * in system-workqueue context.
 */
#define BUTTON_DEBOUNCE_MS 250

static int64_t s_last_press_uptime;
static struct k_work button_work;

static void button_work_fn(struct k_work *w)
{
	ARG_UNUSED(w);

	struct can_frame f = { 0 };

	f.id      = ALARM_BTN_CAN_ID;
	f.flags   = CAN_FRAME_IDE;
	f.dlc     = 1;
	f.data[0] = 0x42U;   /* magic, matches the single-purpose fixed-ID pattern */

	int ret = spi_bridge_enqueue(&f);

	if (ret != 0) {
		LOG_WRN("alarm_io: cancel-button event dropped (queue full): %d", ret);
	} else {
		LOG_INF("alarm_io: cancel-button pressed");
	}
}

static void button_isr(const struct device *dev, struct gpio_callback *cb, uint32_t pins)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(cb);
	ARG_UNUSED(pins);

	int64_t now = k_uptime_get();

	if ((now - s_last_press_uptime) < BUTTON_DEBOUNCE_MS) {
		return;
	}
	s_last_press_uptime = now;
	k_work_submit(&button_work);
}

void alarm_io_init(void)
{
	if (!gpio_is_ready_dt(&buzzer) || !gpio_is_ready_dt(&led) || !gpio_is_ready_dt(&button)) {
		LOG_ERR("alarm_io: GPIO device(s) not ready — buzzer/led/button pins "
			"are placeholders pending real wiring confirmation, see alarm_io.h");
		return;
	}

	gpio_pin_configure_dt(&buzzer, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&button, GPIO_INPUT);

	k_work_init(&button_work, button_work_fn);

	gpio_init_callback(&button_cb, button_isr, BIT(button.pin));
	gpio_add_callback(button.port, &button_cb);
	gpio_pin_interrupt_configure_dt(&button, GPIO_INT_EDGE_TO_ACTIVE);

	LOG_INF("alarm_io: ready (buzzer/led/button on placeholder GPIOH pins)");
}
