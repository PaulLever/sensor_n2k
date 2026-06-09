/*
 * NMEA 2000 loopback test
 *
 * Places FDCAN1 in loopback mode, takes a sample from ADC1 channel 9
 * (Arduino A0), encodes it as PGN 130316 EGT for engine 1, transmits on
 * the CAN bus, reads the frame back, and verifies the content byte-for-byte.
 */

#include <zephyr/ztest.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/can.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

#include "n2k.h"

LOG_MODULE_REGISTER(loopback_test, LOG_LEVEL_INF);

/* ------------------------------------------------------------------ */
/* Devices                                                              */
/* ------------------------------------------------------------------ */

static const struct device *can_dev  = DEVICE_DT_GET(DT_CHOSEN(zephyr_canbus));
static const struct device *adc_dev  = DEVICE_DT_GET(DT_NODELABEL(adc1));

/* ------------------------------------------------------------------ */
/* ADC helpers                                                          */
/* ------------------------------------------------------------------ */

#define ADC_CH          9
#define ADC_RESOLUTION  14
#define ADC_MAX_RAW     ((1 << ADC_RESOLUTION) - 1)

static const struct adc_channel_cfg adc_ch_cfg = {
	.gain             = ADC_GAIN_1,
	.reference        = ADC_REF_INTERNAL,
	.acquisition_time = ADC_ACQ_TIME_MAX,
	.channel_id       = ADC_CH,
	.differential     = 0,
};

/**
 * Read one sample from ADC channel 9 and return it.
 * Aborts the test on any error.
 */
static int16_t read_adc_raw(void)
{
	int16_t buf;
	struct adc_sequence seq = {
		.channels    = BIT(ADC_CH),
		.buffer      = &buf,
		.buffer_size = sizeof(buf),
		.resolution  = ADC_RESOLUTION,
	};
	int ret = adc_read(adc_dev, &seq);

	zassert_ok(ret, "ADC read failed: %d", ret);
	return buf;
}

/* ------------------------------------------------------------------ */
/* CAN RX helper                                                        */
/* ------------------------------------------------------------------ */

CAN_MSGQ_DEFINE(rx_msgq, 4);

static int rx_filter_id = -1;

static void install_rx_filter(uint32_t expected_can_id)
{
	struct can_filter f = {
		.flags = CAN_FILTER_IDE,
		.id    = expected_can_id,
		.mask  = CAN_EXT_ID_MASK,
	};
	rx_filter_id = can_add_rx_filter_msgq(can_dev, &rx_msgq, &f);
	zassert_true(rx_filter_id >= 0, "Failed to add RX filter: %d", rx_filter_id);
}

/* ------------------------------------------------------------------ */
/* Test fixture                                                          */
/* ------------------------------------------------------------------ */

static void *setup(void)
{
	int ret;

	zassert_true(device_is_ready(can_dev),  "CAN not ready");
	zassert_true(device_is_ready(adc_dev),  "ADC not ready");

	/* Put the controller in loopback: TX frames are also received locally. */
	ret = can_set_mode(can_dev, CAN_MODE_LOOPBACK);
	zassert_ok(ret, "can_set_mode(LOOPBACK) failed: %d", ret);

	ret = n2k_init(can_dev);
	zassert_ok(ret, "n2k_init failed: %d", ret);

	ret = adc_channel_setup(adc_dev, &adc_ch_cfg);
	zassert_ok(ret, "ADC channel setup failed: %d", ret);

	return NULL;
}

static void teardown(void *unused)
{
	ARG_UNUSED(unused);
	if (rx_filter_id >= 0) {
		can_remove_rx_filter(can_dev, rx_filter_id);
		rx_filter_id = -1;
	}
}

ZTEST_SUITE(sensor_n2k_loopback, NULL, setup, NULL, NULL, teardown);

/* ------------------------------------------------------------------ */
/* Test: ADC → PGN 130316 EGT loopback                                 */
/* ------------------------------------------------------------------ */

ZTEST(sensor_n2k_loopback, test_egt_loopback)
{
	/* Sample ADC */
	int16_t raw = read_adc_raw();
	LOG_INF("ADC raw = %d", raw);

	/* Scale to temperature: 0–16383 → 0–1000 °C → Kelvin */
	float temp_c = (float)raw * 1000.0f / (float)ADC_MAX_RAW;
	float temp_k = temp_c + 273.15f;
	uint32_t encoded = (uint32_t)(temp_k * 1000.0f);

	LOG_INF("EGT = %.1f °C  = %.2f K  encoded = %u (0x%06X)",
		(double)temp_c, (double)temp_k, encoded, encoded);

	/* Expected CAN ID for PGN 130316, priority 6, SA 0x30 */
	uint32_t exp_id = n2k_can_id(N2K_PGN_TEMP_EXT, N2K_PRIORITY, N2K_SRC_ADDR);
	install_rx_filter(exp_id);

	/* Transmit */
	int ret = n2k_send_temp_ext(can_dev, 0, N2K_TSRC_EGT, temp_k);
	zassert_ok(ret, "n2k_send_temp_ext failed: %d", ret);

	/* Receive looped-back frame (2 s timeout) */
	struct can_frame rx;
	ret = k_msgq_get(&rx_msgq, &rx, K_SECONDS(2));
	zassert_ok(ret, "No frame received within timeout: %d", ret);

	/* Verify CAN ID */
	zassert_equal(rx.id, exp_id,
		      "CAN ID mismatch: got 0x%08X expected 0x%08X", rx.id, exp_id);

	/* Verify DLC */
	zassert_equal(rx.dlc, 8, "DLC mismatch: %d", rx.dlc);

	/* Verify extended-ID flag */
	zassert_true((rx.flags & CAN_FRAME_IDE) != 0, "Frame is not extended ID");

	/* Verify payload */
	zassert_equal(rx.data[0], 0, "Wrong instance byte");
	zassert_equal(rx.data[1], (N2K_TSRC_EGT & 0x0FU) | 0xF0U,
		      "Wrong source byte: 0x%02X", rx.data[1]);

	uint32_t rx_encoded =
		(uint32_t)rx.data[2] |
		(uint32_t)rx.data[3] << 8 |
		(uint32_t)rx.data[4] << 16;

	zassert_equal(rx_encoded, encoded,
		      "Temperature mismatch: rx=%u expected=%u", rx_encoded, encoded);

	/* Set-temperature and reserved bytes should all be 0xFF */
	zassert_equal(rx.data[5], 0xFFU, "data[5] should be 0xFF");
	zassert_equal(rx.data[6], 0xFFU, "data[6] should be 0xFF");
	zassert_equal(rx.data[7], 0xFFU, "data[7] should be 0xFF");

	LOG_INF("PASS: EGT frame round-tripped through CAN loopback");
}
