#include "adc.h"
#include "n2k.h"
#include "onewire.h"
#include "spi_bridge.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "led.h"

LOG_MODULE_REGISTER(sensor_n2k, LOG_LEVEL_INF);

#define STACK_SIZE  1536
#define PRIO        5

K_THREAD_STACK_DEFINE(adc_stack, STACK_SIZE);
K_THREAD_STACK_DEFINE(ow_stack,  STACK_SIZE);

static struct k_thread adc_thread_data;
static struct k_thread ow_thread_data;

/*
 * FDCAN1 — used by spi_bridge to forward frames received from Linux onto
 * the physical NMEA 2000 bus.  Sensor data flows the other way: threads →
 * spi_bridge TX queue → SPI block → Linux → SignalK → SPI block →
 * spi_bridge RX → FDCAN1.
 */
static const struct device *can_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_canbus));

int main(void)
{
	int ret;

	//init the LEDs first so we can show progress with blinks
	init_leds();
	
	/*
	 * spi_bridge_init() starts the CAN controller and the SPI slave
	 * bridge thread.  After this returns, the SPI link to Linux is live
	 * and FDCAN1 is ready to transmit frames that arrive from Linux.
	 */
	ret = spi_bridge_init(can_dev);
	if (ret != 0) {
		return ret;
	}

	ret = n2k_negotiate_address(can_dev);
	if (ret != 0) {
		return ret;
	}

	k_thread_create(&adc_thread_data, adc_stack, STACK_SIZE,
			adc_thread, NULL, NULL, NULL,
			PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&adc_thread_data, "adc");

	k_thread_create(&ow_thread_data, ow_stack, STACK_SIZE,
			onewire_thread, NULL, NULL, NULL,
			PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&ow_thread_data, "1wire");

	return 0;
}
