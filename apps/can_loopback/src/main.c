/*
 * FDCAN loopback bring-up for the Arduino UNO Q (STM32U585).
 *
 * Proves the CAN peripheral TX/RX path works entirely on-chip using
 * CAN_MODE_LOOPBACK: every frame transmitted is also received internally, with
 * no transceiver and no external bus wiring. This is the on-MCU half of the
 * CAN-over-SPI bridge; once this is solid we pipe these frames out over SPI.
 *
 * The app sends a counter frame once per second and prints each frame it gets
 * back through the loopback, plus a green-LED heartbeat for liveness.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(can_loopback, LOG_LEVEL_INF);

#define TX_ID 0x123

static const struct device *const can_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_canbus));
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET_OR(DT_ALIAS(led0), gpios, {0});

CAN_MSGQ_DEFINE(rx_msgq, 4);

/*
 * SWD-observable proof globals. The QCM console UART path is uncertain on this
 * board, so we expose loopback state in RAM and read it via openocd `mdw` at
 * the symbol addresses (see nm). If g_rx_count tracks g_tx_count and
 * g_rx_match_count climbs, loopback is proven without any UART.
 *
 * g_state: 0=init, 1=mode set, 2=started, 3=filter ok / running, 0xE*=error.
 */
volatile uint32_t g_state;
volatile uint32_t g_tx_count;
volatile uint32_t g_rx_count;
volatile uint32_t g_rx_match_count;
volatile uint32_t g_last_rx_id;
volatile uint32_t g_last_rx_data;   /* first 4 data bytes, big-endian-ish */

static void heartbeat_thread(void)
{
	if (!gpio_is_ready_dt(&led)) {
		return;
	}
	gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	while (1) {
		gpio_pin_toggle_dt(&led);
		k_sleep(K_MSEC(500));
	}
}
K_THREAD_DEFINE(hb_tid, 512, heartbeat_thread, NULL, NULL, NULL, 7, 0, 0);

int main(void)
{
	int ret;

	LOG_INF("FDCAN loopback starting on %s", can_dev->name);

	if (!device_is_ready(can_dev)) {
		LOG_ERR("CAN device not ready");
		return -1;
	}

	g_state = 0;

	/* Loopback: TX frames are received back internally, no transceiver. */
	ret = can_set_mode(can_dev, CAN_MODE_LOOPBACK);
	if (ret != 0) {
		LOG_ERR("can_set_mode(LOOPBACK) failed: %d", ret);
		g_state = 0xE1;
		return -1;
	}
	g_state = 1;

	ret = can_start(can_dev);
	if (ret != 0) {
		LOG_ERR("can_start failed: %d", ret);
		g_state = 0xE2;
		return -1;
	}
	g_state = 2;

	/* Accept everything (mask 0) into the msgq. */
	const struct can_filter filter = {
		.flags = 0,
		.id = 0,
		.mask = 0,
	};
	int filter_id = can_add_rx_filter_msgq(can_dev, &rx_msgq, &filter);
	if (filter_id < 0) {
		LOG_ERR("can_add_rx_filter_msgq failed: %d", filter_id);
		g_state = 0xE3;
		return -1;
	}
	g_state = 3;
	LOG_INF("rx filter id %d; sending frames every 1s", filter_id);

	uint8_t counter = 0;

	while (1) {
		struct can_frame tx = {
			.id = TX_ID,
			.dlc = 4,
			.flags = 0,
		};
		tx.data[0] = 0xDE;
		tx.data[1] = 0xAD;
		tx.data[2] = 0xBE;
		tx.data[3] = counter;

		ret = can_send(can_dev, &tx, K_MSEC(100), NULL, NULL);
		if (ret == 0) {
			g_tx_count++;
			LOG_INF("TX  id=0x%03x dlc=%u data=%02x %02x %02x %02x",
				tx.id, tx.dlc, tx.data[0], tx.data[1],
				tx.data[2], tx.data[3]);
		} else {
			LOG_ERR("can_send failed: %d", ret);
		}

		/* Drain whatever looped back. */
		struct can_frame rx;
		while (k_msgq_get(&rx_msgq, &rx, K_MSEC(200)) == 0) {
			g_rx_count++;
			g_last_rx_id = rx.id;
			g_last_rx_data = ((uint32_t)rx.data[0] << 24) |
					 ((uint32_t)rx.data[1] << 16) |
					 ((uint32_t)rx.data[2] << 8) |
					 ((uint32_t)rx.data[3]);
			if (rx.id == TX_ID && rx.data[0] == 0xDE &&
			    rx.data[1] == 0xAD && rx.data[2] == 0xBE) {
				g_rx_match_count++;
			}
			LOG_INF("RX  id=0x%03x dlc=%u data=%02x %02x %02x %02x  <-- loopback",
				rx.id, rx.dlc, rx.data[0], rx.data[1],
				rx.data[2], rx.data[3]);
		}

		counter++;
		k_sleep(K_MSEC(1000));
	}

	return 0;
}
