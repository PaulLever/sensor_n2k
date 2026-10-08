#ifndef BILGE_H_
#define BILGE_H_

#include <zephyr/device.h>

/**
 * Initialise bilge pump monitoring: configure the 4 opto-isolated GPIO
 * inputs (see boards overlay for pin assignments) with edge interrupts,
 * and start the aggregation/report/broadcast thread.
 *
 * Must be called after n2k_negotiate_address() (PGN 127501 needs a
 * claimed source address) and after sensor_config_load().
 */
void bilge_init(const struct device *can_dev);

#endif /* BILGE_H_ */
