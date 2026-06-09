#include "onewire.h"
#include "n2k.h"
#include "spi_bridge.h"
#include "led.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(onewire_n2k, LOG_LEVEL_INF);

/*
 * DS18B20 sensor bound to the 1-Wire GPIO bus defined in the board overlay.
 * Sensor range: −55 … +125 °C — well within the PGN 130312 uint16 limit.
 */
#define DS18B20_NODE  DT_NODELABEL(ds18b20_0)

/* DS18B20 reports in 0.0625 °C steps; allow 1 s between conversions. */
#define OW_POLL_MS    2000

#define KELVIN_OFFSET 273.15f

static const struct device *ds18b20 = DEVICE_DT_GET(DS18B20_NODE);

void onewire_thread(void *unused0, void *unused1, void *unused2)
{
	ARG_UNUSED(unused0);
	ARG_UNUSED(unused1);
	ARG_UNUSED(unused2);

	struct sensor_value val;
	int ret;

	if (!device_is_ready(ds18b20)) {
		LOG_ERR("DS18B20 not ready");
		return;
	}

	while (1) {
		ret = sensor_sample_fetch(ds18b20);
		if (ret != 0) {
			LOG_WRN("DS18B20 fetch error: %d", ret);
			k_sleep(K_MSEC(OW_POLL_MS));
			continue;
		}

		ret = sensor_channel_get(ds18b20, SENSOR_CHAN_AMBIENT_TEMP, &val);
		if (ret != 0) {
			LOG_WRN("DS18B20 get error: %d", ret);
			k_sleep(K_MSEC(OW_POLL_MS));
			continue;
		}

		float temp_c = sensor_value_to_float(&val);
		float temp_k = temp_c + KELVIN_OFFSET;

		LOG_INF("1-wire temp=%.4f °C", (double)temp_c);

		/*
		 * Build PGN 130312 (temperature, instance 1) and hand to the
		 * SPI bridge.  Same round-trip as ADC: Zephyr → SPI → Linux →
		 * SignalK → SPI → Zephyr FDCAN1 → physical N2K bus.
		 */
		struct can_frame frame = {0};
		uint16_t raw = (uint16_t)(temp_k * 100.0f);

		frame.id      = n2k_can_id(N2K_PGN_TEMP, N2K_PRIORITY, n2k_sa_get());
		frame.flags   = CAN_FRAME_IDE;
		frame.dlc     = 8;
		frame.data[0] = 0;                            /* SID */
		frame.data[1] = 1;                            /* Temperature Instance 1 */
		frame.data[2] = N2K_TSRC_INSIDE;              /* Temperature Source = 2 */
		frame.data[3] = raw        & 0xFFU;
		frame.data[4] = (raw >> 8) & 0xFFU;
		frame.data[5] = 0xFFU;                        /* Set Temp N/A */
		frame.data[6] = 0xFFU;
		frame.data[7] = 0xFFU;

		LED4B_BLINK(1); //blue for 1-wire

		ret = spi_bridge_enqueue(&frame);
		if (ret != 0) {
			LOG_WRN("SPI bridge TX full: %d", ret);
		}

		k_sleep(K_MSEC(OW_POLL_MS));
	}
}
