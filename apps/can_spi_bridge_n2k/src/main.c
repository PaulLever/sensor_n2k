/*
 * NMEA 2000 CAN <-> SPI bridge for the Arduino UNO Q (STM32U585), mainline
 * Zephyr 4.4.
 *
 * NMEA 2000 = CLASSIC CAN 2.0B, 250 kbit/s, 29-bit EXTENDED identifiers. This
 * variant therefore runs the controller in classic mode (no CAN FD), tags every
 * frame as extended (CAN_FRAME_IDE), and carries up to 8 data bytes per frame.
 *
 * Same bidirectional, RDY-flow-controlled, CRC-16-protected SPI block design as
 * the CAN-FD variant -- only the CAN layer differs. Classic frames are 8 data
 * bytes max, so records are 16 bytes and a 256-byte block carries up to 15.
 *
 *  - MOSI (Linux->MCU): command block; MCU injects each record as a classic
 *    extended-ID CAN frame via can_send().
 *  - MISO (MCU->Linux): up to MAX_RECS received frames.
 *  - RDY (PG13 == QCM gpiochip1:70): HIGH while unread data is staged/queued.
 *
 * BENCH_LOOPBACK (default 1): on-chip CAN loopback so the bridge can be tested
 * and benchmarked with no transceiver. Set to 0 for a real N2K bus (requires a
 * CAN transceiver wired to PD0/PD1, 120 ohm termination, bus power) -- then the
 * controller runs in CAN_MODE_NORMAL and frames go out on the wire.
 *
 * Block format (same both directions), fixed BLOCK_SIZE:
 *   [0] magic 0xA5  [1] ver 0x03  [2] count  [3] seq  ...  [-2..-1] CRC-16 (LE)
 *   record (16 B): [0..3] id (LE u32, 29-bit) [4] len(0..8) [5] flags [6..7] rsvd
 *                  [8..15] data
 *
 * SWD proof globals: g_state, g_can_rx, g_blocks_sent, g_frames_packed,
 * g_frames_injected, g_rdy_level, g_rx_crc_err.
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/logging/log.h>
#include <string.h>

LOG_MODULE_REGISTER(n2k_bridge, LOG_LEVEL_INF);

/* 1 = on-chip loopback (bench/bringup, no transceiver). 0 = real bus. */
#define BENCH_LOOPBACK 0

#define BLOCK_SIZE  256
#define REC_SIZE    16            /* 8 header + 8 data (classic CAN max) */
#define MAX_DATA    8
#define MAX_RECS    15            /* (256 - 4 - 2 crc) / 16 = 15 */
#define BLK_MAGIC   0xA5
#define BLK_VERSION 0x03
#define CRC_OFFSET  (BLOCK_SIZE - 2)

static const struct device *const can_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_canbus));
static const struct device *const spi_dev = DEVICE_DT_GET(DT_NODELABEL(spi3));

static const struct gpio_dt_spec rdy =
	GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), rdy_gpios);

static const struct spi_config spi_cfg = {
	.frequency = 1000000U,
	.operation = SPI_OP_MODE_SLAVE | SPI_WORD_SET(8) | SPI_TRANSFER_MSB,
	.slave = 0,
};

CAN_MSGQ_DEFINE(can_rx_msgq, 32);
CAN_MSGQ_DEFINE(ship_msgq, 64);

volatile uint32_t g_state;
volatile uint32_t g_can_rx;
volatile uint32_t g_blocks_sent;
volatile uint32_t g_frames_packed;
volatile uint32_t g_frames_injected;
volatile uint32_t g_rdy_level;
volatile uint32_t g_rx_crc_err;

static uint16_t crc16(const uint8_t *p, size_t n)
{
	uint16_t crc = 0xFFFF;
	for (size_t i = 0; i < n; i++) {
		crc ^= (uint16_t)p[i] << 8;
		for (int b = 0; b < 8; b++) {
			crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021)
					     : (uint16_t)(crc << 1);
		}
	}
	return crc;
}

static uint8_t spi_tx[BLOCK_SIZE];
static uint8_t spi_rx[BLOCK_SIZE];

static void set_rdy(int level)
{
	gpio_pin_set_dt(&rdy, level);
	g_rdy_level = level;
}

static void inject_block(const uint8_t *blk)
{
	if (blk[0] != BLK_MAGIC || blk[1] != BLK_VERSION) {
		return;
	}
	uint16_t want = crc16(blk, CRC_OFFSET);
	uint16_t have = (uint16_t)blk[CRC_OFFSET] | ((uint16_t)blk[CRC_OFFSET + 1] << 8);
	if (want != have) {
		g_rx_crc_err++;
		return;
	}
	uint8_t count = blk[2];
	if (count > MAX_RECS) {
		count = MAX_RECS;
	}
	for (uint8_t i = 0; i < count; i++) {
		const uint8_t *r = &blk[4 + i * REC_SIZE];
		struct can_frame f = {0};
		f.id = ((uint32_t)r[0] | ((uint32_t)r[1] << 8) |
			((uint32_t)r[2] << 16) | ((uint32_t)r[3] << 24)) & 0x1FFFFFFF;
		uint8_t nbytes = r[4];
		if (nbytes > MAX_DATA) {
			nbytes = MAX_DATA;
		}
		f.dlc = nbytes;                 /* classic: dlc == byte count for 0..8 */
		f.flags = CAN_FRAME_IDE;        /* N2K is always 29-bit extended */
		memcpy(f.data, &r[8], nbytes);
		if (can_send(can_dev, &f, K_MSEC(10), NULL, NULL) == 0) {
			g_frames_injected++;
		}
	}
}

static uint8_t pack_block(uint8_t seq)
{
	memset(spi_tx, 0, BLOCK_SIZE);
	spi_tx[0] = BLK_MAGIC;
	spi_tx[1] = BLK_VERSION;
	spi_tx[3] = seq;

	uint8_t n = 0;
	struct can_frame f;
	while (n < MAX_RECS && k_msgq_get(&ship_msgq, &f, K_NO_WAIT) == 0) {
		uint8_t *r = &spi_tx[4 + n * REC_SIZE];
		r[0] = (uint8_t)(f.id & 0xff);
		r[1] = (uint8_t)((f.id >> 8) & 0xff);
		r[2] = (uint8_t)((f.id >> 16) & 0xff);
		r[3] = (uint8_t)((f.id >> 24) & 0xff);
		uint8_t nbytes = f.dlc > MAX_DATA ? MAX_DATA : f.dlc;
		r[4] = nbytes;
		r[5] = f.flags;
		memcpy(&r[8], f.data, nbytes);
		n++;
		g_frames_packed++;
	}
	spi_tx[2] = n;

	uint16_t crc = crc16(spi_tx, CRC_OFFSET);
	spi_tx[CRC_OFFSET] = (uint8_t)(crc & 0xff);
	spi_tx[CRC_OFFSET + 1] = (uint8_t)((crc >> 8) & 0xff);

	set_rdy((n > 0 || k_msgq_num_used_get(&ship_msgq) > 0) ? 1 : 0);
	return n;
}

static void can_rx_thread(void)
{
	struct can_frame rx;
	while (1) {
		if (k_msgq_get(&can_rx_msgq, &rx, K_FOREVER) == 0) {
			g_can_rx++;
			if (k_msgq_put(&ship_msgq, &rx, K_NO_WAIT) == 0) {
				set_rdy(1);
			}
		}
	}
}
K_THREAD_DEFINE(can_rx_tid, 1024, can_rx_thread, NULL, NULL, NULL, 5, 0, 0);

int main(void)
{
	LOG_INF("NMEA 2000 CAN<->SPI bridge (classic 250k, 29-bit ext)");

	if (!device_is_ready(can_dev) || !device_is_ready(spi_dev) ||
	    !gpio_is_ready_dt(&rdy)) {
		g_state = 0xE0;
		return -1;
	}

	gpio_pin_configure_dt(&rdy, GPIO_OUTPUT_INACTIVE);
	set_rdy(0);

#if BENCH_LOOPBACK
	can_mode_t mode = CAN_MODE_LOOPBACK;   /* on-chip, no transceiver */
#else
	can_mode_t mode = CAN_MODE_NORMAL;     /* real N2K bus via transceiver */
#endif
	if (can_set_mode(can_dev, mode) != 0) { g_state = 0xE1; return -1; }
	if (can_start(can_dev) != 0)           { g_state = 0xE2; return -1; }

	/* Accept all extended IDs into the rx queue. */
	const struct can_filter filter = {
		.flags = CAN_FILTER_IDE,
		.id = 0,
		.mask = 0,
	};
	if (can_add_rx_filter_msgq(can_dev, &can_rx_msgq, &filter) < 0) {
		g_state = 0xE3;
		return -1;
	}
	g_state = 3;

	const struct spi_buf tx = { .buf = spi_tx, .len = BLOCK_SIZE };
	const struct spi_buf rx = { .buf = spi_rx, .len = BLOCK_SIZE };
	const struct spi_buf_set tx_set = { .buffers = &tx, .count = 1 };
	const struct spi_buf_set rx_set = { .buffers = &rx, .count = 1 };

	uint8_t seq = 0;
	pack_block(seq);

	while (1) {
		int ret = spi_transceive(spi_dev, &spi_cfg, &tx_set, &rx_set);
		if (ret < 0) {
			g_state = 0xE4;
			k_sleep(K_MSEC(10));
			continue;
		}
		g_blocks_sent++;
		inject_block(spi_rx);
		seq++;
		pack_block(seq);
	}

	return 0;
}
