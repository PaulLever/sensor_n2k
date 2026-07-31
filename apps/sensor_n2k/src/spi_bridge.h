#ifndef SPI_BRIDGE_H_
#define SPI_BRIDGE_H_

#include <zephyr/drivers/can.h>

/*
 * SPI block protocol (256-byte blocks, full-duplex). This previously
 * documented a different byte layout than spi_bridge.c actually
 * implements — corrected to match the real implementation:
 *
 *  Offset  Size  Field
 *  ------  ----  -----
 *   0       1    Magic        (0xA5)
 *   1       1    Version      (0x03)
 *   2       1    Frame count  (0..15)
 *   3       1    Sequence     (increments once per transfer, wraps at 256)
 *   4-253  250   15 × 16-byte CAN records
 *  254-255   2    CRC-16/CCITT-FALSE over bytes [0..253]
 *
 * CAN record (16 bytes):
 *   0-3   uint32-LE  CAN ID (29-bit)
 *   4     uint8      DLC (0..8)
 *   5     uint8      Flags (CAN_FRAME_IDE etc.)
 *   6-7   uint8[2]   Reserved
 *   8-15  uint8[8]   Frame data
 *
 * RDY GPIO: asserted by Zephyr (active-high) when ship_msgq is non-empty,
 * cleared once a transfer drains it. Linux (bridge.js) watches this via
 * gpiomon for edge-triggered transfers, with a fixed-interval poll as a
 * backstop — see bridge.js for why (RDY existed but went unused for a
 * long time before that).
 */

/**
 * Initialise the SPI slave and start the bridge thread.
 *
 * @param can_dev  FDCAN1 device — frames received from Linux are forwarded here.
 * @return 0 on success, negative errno on failure.
 */
int spi_bridge_init(const struct device *can_dev);

/**
 * Attach the catch-all CAN RX filter.  Must be called AFTER
 * n2k_negotiate_address() so the N2K management filters occupy lower
 * filter indices and take priority over this catch-all in M_CAN hardware.
 */
int spi_bridge_attach_rx(const struct device *can_dev);

/**
 * Enqueue a CAN frame for transmission to Linux in the next SPI block.
 * Non-blocking: returns -EAGAIN if the queue is full, in which case the
 * frame is dropped (counted in spi_bridge_drop_count(), not retried).
 */
int spi_bridge_enqueue(const struct can_frame *frame);

/**
 * Total frames dropped because ship_msgq was full when spi_bridge_enqueue()
 * was called — covers both real CAN-bus RX and sensor-thread-originated
 * frames, since both funnel through spi_bridge_enqueue(). Saturates at
 * 0xFF (255) rather than wrapping, so it fits in the diagnostic heartbeat
 * frame's single spare byte; read the RTT/journal log for an exact count
 * beyond that.
 */
uint32_t spi_bridge_drop_count(void);

#endif /* SPI_BRIDGE_H_ */
