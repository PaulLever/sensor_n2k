#include "adc.h"
#include "n2k.h"
#include "spi_bridge.h"
#include "led.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/can.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(adc_n2k, LOG_LEVEL_INF);

/*
 * ADC channel 9 = PA4 = Arduino A0.
 *
 * For a marine EGT application wire a K-type thermocouple amplifier
 * (e.g. MAX31855) with its analogue output to A0.  For bench testing any
 * resistive voltage divider connected to A0 works.
 *
 * The raw 14-bit value is linearly mapped to 0–1000 °C.
 */

#define ADC_NODE        DT_NODELABEL(adc1)
#define ADC_CHANNEL_ID  9
#define ADC_RESOLUTION  14
#define ADC_MAX_RAW     ((1 << ADC_RESOLUTION) - 1)   /* 16383 */

/* Kelvin offset */
#define KELVIN_OFFSET   273.15f

/* Poll period */
#define ADC_POLL_MS     1000

static const struct device *adc_dev = DEVICE_DT_GET(ADC_NODE);

static const struct adc_channel_cfg ch_cfg = {
	.gain             = ADC_GAIN_1,
	.reference        = ADC_REF_INTERNAL,
	.acquisition_time = ADC_ACQ_TIME_MAX,
	.channel_id       = ADC_CHANNEL_ID,
	.differential     = 0,
};

void adc_thread(void *unused0, void *unused1, void *unused2)
{
	ARG_UNUSED(unused0);
	ARG_UNUSED(unused1);
	ARG_UNUSED(unused2);

	int16_t sample_buf;
	int ret;

	struct adc_sequence seq = {
		.channels    = BIT(ADC_CHANNEL_ID),
		.buffer      = &sample_buf,
		.buffer_size = sizeof(sample_buf),
		.resolution  = ADC_RESOLUTION,
	};

	if (!device_is_ready(adc_dev)) {
		LOG_ERR("ADC not ready");
		return;
	}

	ret = adc_channel_setup(adc_dev, &ch_cfg);
	if (ret != 0) {
		LOG_ERR("ADC channel setup failed: %d", ret);
		return;
	}

	while (1) {
		ret = adc_read(adc_dev, &seq);
		if (ret != 0) {
			LOG_WRN("ADC read error: %d", ret);
			k_sleep(K_MSEC(ADC_POLL_MS));
			continue;
		}

		/*
		 * Map 14-bit ADC to 0–1000 °C then convert to Kelvin.
		 * Adjust the scaling for the actual sensor transfer function.
		 */
		float temp_c = (float)sample_buf * 1000.0f / (float)ADC_MAX_RAW;
		float temp_k = temp_c + KELVIN_OFFSET;

		LOG_INF("ADC raw=%d  EGT=%.1f °C", sample_buf, (double)temp_c);

		/*
		 * Build PGN 130316 (EGT, engine instance 0) and hand it to the
		 * SPI bridge.  The bridge sends it to Linux in the next SPI block;
		 * Linux/SignalK decodes it and, when it decides to emit the value
		 * on the N2K bus, sends the frame back via SPI to this device,
		 * where spi_bridge.c forwards it to FDCAN1 (the physical bus).
		 */
		struct can_frame frame = {0};
		uint32_t raw = (uint32_t)(temp_k * 1000.0f);

		frame.id      = n2k_can_id(N2K_PGN_TEMP_EXT, N2K_PRIORITY, n2k_sa_get());
		frame.flags   = CAN_FRAME_IDE;
		frame.dlc     = 8;
		frame.data[0] = 0;                  /* SID */
		frame.data[1] = 0;                  /* Temperature Instance 0 (engine 1) */
		frame.data[2] = N2K_TSRC_EGT;     /* Temperature Source = 14 */
		frame.data[3] = raw        & 0xFFU; /* Actual Temp LSB (0.001 K) */
		frame.data[4] = (raw >> 8) & 0xFFU;
		frame.data[5] = (raw >> 16) & 0xFFU;
		frame.data[6] = 0xFFU;              /* Set Temp N/A */
		frame.data[7] = 0xFFU;

		LED4G_BLINK(1); //green for ADC

		ret = spi_bridge_enqueue(&frame);
		if (ret != 0) {
			LOG_WRN("SPI bridge TX full: %d", ret);
		}

		k_sleep(K_MSEC(ADC_POLL_MS));
	}
}
