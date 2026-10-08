#ifndef ONEWIRE_H_
#define ONEWIRE_H_

/* 1-Wire / DS18B20 thread entry — sensor data goes to the SPI bridge. */
void onewire_thread(void *unused0, void *unused1, void *unused2);

/**
 * Re-run the 1-Wire ROM search and report the results to Linux (see
 * onewire.c's ONEWIRE_ROM_REPORT_CAN_ID for the wire format). Safe to call
 * from any thread — just sets a flag; the actual scan runs from
 * onewire_thread() itself, since that's the only thread that otherwise
 * touches the W1 bus, avoiding any question about concurrent bus access.
 * Triggered by CFG_PARAM_OW_RESCAN (see sensor_config.c) — the host UI
 * uses this to show "what's currently on the bus" when the user is
 * assigning a slot to a sensor's ROM ID or replacing a failed one.
 */
void onewire_request_rescan(void);

#endif /* ONEWIRE_H_ */
