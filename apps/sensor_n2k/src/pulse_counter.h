#ifndef PULSE_COUNTER_H_
#define PULSE_COUNTER_H_

#include <zephyr/device.h>

/**
 * Initialise both pulse-counter inputs and start the sampling thread.
 * GPIO pins: PC0 = D3 / PB0,  PC1 = D6 / PB1.
 * Each counter ISR increments atomically; one thread samples at the
 * configured update_ms interval and publishes via spi_bridge_enqueue().
 *
 * Must be called after n2k_negotiate_address() so g_sa is valid and
 * after sensor_config_load() so g_sensor_cfg.pulse[] is populated.
 *
 * Disabled counters (cfg->enabled == false) still have their pins
 * configured as pull-down inputs to prevent floating-pin noise.
 */
void pulse_counter_init(const struct device *can_dev);

#endif /* PULSE_COUNTER_H_ */
