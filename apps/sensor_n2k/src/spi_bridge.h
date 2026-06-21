#ifndef SPI_BRIDGE_H_
#define SPI_BRIDGE_H_

#include <zephyr/drivers/can.h>

/*
 * SPI block protocol (256-byte blocks, full-duplex):
 *
 *  Offset  Size  Field
 *  ------  ----  -----
 *   0       1    Magic        (0xA5)
 *   1       1    Version      (0x03)
 *   2-3     2    CRC-16/CCITT over bytes [4..255]
 *   4       1    Frame count  (0..15)
 *   5-15   11    Reserved     (0xFF)
 *  16-255  240   15 × 16-byte CAN records
 *
 * CAN record (16 bytes):
 *   0-3   uint32-LE  CAN ID; bit 31 = IDE (extended-ID) flag
 *   4     uint8      DLC
 *   5-12  uint8[8]   Frame data
 *  13-15  uint8[3]   Reserved (0xFF)
 *
 * RDY GPIO: asserted by Zephyr (active-high) when the TX block is non-empty.
 * Linux polls RDY and initiates a SPI transfer to drain the block.
 * Linux may also initiate a transfer at any time to inject N2K frames.
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
 * Non-blocking: returns -EAGAIN if the queue is full.
 */
int spi_bridge_enqueue(const struct can_frame *frame);

#endif /* SPI_BRIDGE_H_ */
