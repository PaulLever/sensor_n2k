#include "spi_bridge.h"

#include <string.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "led.h"

LOG_MODULE_REGISTER(spi_bridge, LOG_LEVEL_INF);

/*
 * Block format — identical to can_spi_bridge_n2k:
 *   [0]     magic 0xA5
 *   [1]     ver   0x03
 *   [2]     count (0..15)
 *   [3]     seq
 *   [4..253] records (15 × 16 bytes)
 *   [254..255] CRC-16 LE  (over bytes 0..253)
 *
 * Record (16 bytes):
 *   [0..3]  CAN ID LE (29-bit)
 *   [4]     data length (0..8)
 *   [5]     flags (CAN_FRAME_IDE etc.)
 *   [6..7]  reserved
 *   [8..15] data
 */

#define BLOCK_SIZE   256U
#define BLK_MAGIC    0xA5U
#define BLK_VERSION  0x03U
#define REC_SIZE     16U
#define MAX_RECS     15U
#define MAX_DATA     8U
#define CRC_OFFSET   (BLOCK_SIZE - 2U)   /* 254 */

/* SPI3 — internal bus to the Linux MPU (same as can_spi_bridge_n2k) */
static const struct device *spi_dev = DEVICE_DT_GET(DT_NODELABEL(spi3));

/* RDY output: PG13 = gpiochip1:70 on the Linux side */
static const struct gpio_dt_spec rdy_gpio =
	GPIO_DT_SPEC_GET(DT_PATH(zephyr_user), rdy_gpios);

static const struct spi_config spi_cfg = {
	.frequency = 1000000U,
	.operation = SPI_OP_MODE_SLAVE | SPI_WORD_SET(8) | SPI_TRANSFER_MSB,
	.slave     = 0,
};

/* ------------------------------------------------------------------ */
/* CRC (same polynomial/seed as the working bridge)                    */
/* ------------------------------------------------------------------ */

static uint16_t block_crc(const uint8_t *p, size_t n)
{
	uint16_t crc = 0xFFFF;

	for (size_t i = 0; i < n; i++) {
		crc ^= (uint16_t)p[i] << 8;
		for (int b = 0; b < 8; b++) {
			crc = (crc & 0x8000)
				? (uint16_t)((crc << 1) ^ 0x1021)
				: (uint16_t)(crc << 1);
		}
	}
	return crc;
}

/* ------------------------------------------------------------------ */
/* TX queue (sensor threads + CAN RX → SPI blocks)                    */
/* ------------------------------------------------------------------ */

#define TX_QUEUE_DEPTH  64

static const struct device *s_can_dev;

CAN_MSGQ_DEFINE(ship_msgq, TX_QUEUE_DEPTH);

static uint8_t spi_tx[BLOCK_SIZE];
static uint8_t spi_rx[BLOCK_SIZE];

static void set_rdy(int level)
{
	gpio_pin_set_dt(&rdy_gpio, level);
}

/* ------------------------------------------------------------------ */
/* CAN RX → ship queue (physical N2K bus → Linux)                     */
/* ------------------------------------------------------------------ */

CAN_MSGQ_DEFINE(can_rx_msgq, 32);

static void can_rx_thread_fn(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);
	struct can_frame rx;

	while (1) {
		if (k_msgq_get(&can_rx_msgq, &rx, K_FOREVER) == 0) {
			LED3G_BLINK(1);
			if (k_msgq_put(&ship_msgq, &rx, K_NO_WAIT) == 0) {
				set_rdy(1);
			}
		}
	}
}

K_THREAD_DEFINE(can_rx_tid, 1024, can_rx_thread_fn,
		NULL, NULL, NULL, 5, 0, 0);

/* ------------------------------------------------------------------ */
/* Block assembly (matches pack_block() in can_spi_bridge_n2k)         */
/* ------------------------------------------------------------------ */

static uint8_t pack_block(uint8_t seq)
{
	memset(spi_tx, 0, BLOCK_SIZE);
	spi_tx[0] = BLK_MAGIC;
	spi_tx[1] = BLK_VERSION;
	spi_tx[3] = seq;

	uint8_t n = 0;
	struct can_frame f;

	while (n < MAX_RECS &&
	       k_msgq_get(&ship_msgq, &f, K_NO_WAIT) == 0) {
		uint8_t *r = &spi_tx[4 + n * REC_SIZE];
		r[0] = (uint8_t)(f.id        & 0xFF);
		r[1] = (uint8_t)((f.id >> 8) & 0xFF);
		r[2] = (uint8_t)((f.id >> 16) & 0xFF);
		r[3] = (uint8_t)((f.id >> 24) & 0xFF);
		uint8_t nbytes = (f.dlc > MAX_DATA) ? MAX_DATA : f.dlc;
		r[4] = nbytes;
		r[5] = f.flags;
		memcpy(&r[8], f.data, nbytes);
		n++;
	}

	spi_tx[2] = n;

	uint16_t crc = block_crc(spi_tx, CRC_OFFSET);
	spi_tx[CRC_OFFSET]     = (uint8_t)(crc & 0xFF);
	spi_tx[CRC_OFFSET + 1] = (uint8_t)((crc >> 8) & 0xFF);

	set_rdy((n > 0 || k_msgq_num_used_get(&ship_msgq) > 0) ? 1 : 0);
	return n;
}

/* ------------------------------------------------------------------ */
/* Block processing (Linux → Zephyr → FDCAN1)                         */
/* ------------------------------------------------------------------ */

static void inject_block(const uint8_t *blk)
{
	if (blk[0] != BLK_MAGIC || blk[1] != BLK_VERSION) {
		return;
	}

	uint16_t want = block_crc(blk, CRC_OFFSET);
	uint16_t have = (uint16_t)blk[CRC_OFFSET] |
			((uint16_t)blk[CRC_OFFSET + 1] << 8);

	if (want != have) {
		LOG_WRN("RX CRC error: want 0x%04X have 0x%04X", want, have);
		return;
	}

	LED3B_BLINK(1);
	
	uint8_t count = blk[2];
	if (count > MAX_RECS) {
		count = MAX_RECS;
	}

	for (uint8_t i = 0; i < count; i++) {
		const uint8_t *r = &blk[4 + i * REC_SIZE];
		struct can_frame f = {0};
		f.id = ((uint32_t)r[0]        |
			((uint32_t)r[1] <<  8) |
			((uint32_t)r[2] << 16) |
			((uint32_t)r[3] << 24)) & 0x1FFFFFFF;
		uint8_t nb = r[4];
		if (nb > MAX_DATA) nb = MAX_DATA;
		f.dlc   = nb;
		f.flags = CAN_FRAME_IDE;
		memcpy(f.data, &r[8], nb);
		can_send(s_can_dev, &f, K_MSEC(10), NULL, NULL);
	}
}

/* ------------------------------------------------------------------ */
/* Bridge thread — mirrors the main() loop of can_spi_bridge_n2k      */
/* ------------------------------------------------------------------ */

#define BRIDGE_STACK_SIZE  2048
#define BRIDGE_PRIO        3

K_THREAD_STACK_DEFINE(bridge_stack, BRIDGE_STACK_SIZE);
static struct k_thread bridge_thread_data;

static void bridge_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	const struct spi_buf     tx_buf = { .buf = spi_tx, .len = BLOCK_SIZE };
	const struct spi_buf     rx_buf = { .buf = spi_rx, .len = BLOCK_SIZE };
	const struct spi_buf_set tx_set = { .buffers = &tx_buf, .count = 1 };
	const struct spi_buf_set rx_set = { .buffers = &rx_buf, .count = 1 };

	uint8_t seq = 0;
	pack_block(seq);

	while (1) {
		int ret = spi_transceive(spi_dev, &spi_cfg, &tx_set, &rx_set);
		if (ret < 0) {
			LOG_WRN("SPI transceive error: %d", ret);
			k_sleep(K_MSEC(10));
			continue;
		}
		inject_block(spi_rx);
		seq++;
		pack_block(seq);
	}
}

/* ------------------------------------------------------------------ */
/* Public API                                                           */
/* ------------------------------------------------------------------ */

static const struct can_filter n2k_rx_filter = {
	.flags = CAN_FILTER_IDE,
	.id    = 0,
	.mask  = 0,
};

int spi_bridge_init(const struct device *can_dev)
{
	s_can_dev = can_dev;

	if (!device_is_ready(can_dev)) {
		LOG_ERR("CAN not ready");
		return -ENODEV;
	}
	if (!device_is_ready(spi_dev)) {
		LOG_ERR("SPI3 not ready");
		return -ENODEV;
	}
	if (!gpio_is_ready_dt(&rdy_gpio)) {
		LOG_ERR("RDY GPIO not ready");
		return -ENODEV;
	}

	gpio_pin_configure_dt(&rdy_gpio, GPIO_OUTPUT_INACTIVE);
	set_rdy(0);

	int ret = can_start(can_dev);
	if (ret != 0 && ret != -EALREADY) {
		LOG_ERR("can_start failed: %d", ret);
		return ret;
	}

	ret = can_add_rx_filter_msgq(can_dev, &can_rx_msgq, &n2k_rx_filter);
	if (ret < 0) {
		LOG_ERR("can_add_rx_filter_msgq failed: %d", ret);
		return ret;
	}

	k_thread_create(&bridge_thread_data, bridge_stack, BRIDGE_STACK_SIZE,
			bridge_thread, NULL, NULL, NULL,
			BRIDGE_PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&bridge_thread_data, "spi_bridge");

	LOG_INF("SPI bridge ready");
	return 0;
}

int spi_bridge_enqueue(const struct can_frame *frame)
{
	int ret = k_msgq_put(&ship_msgq, frame, K_NO_WAIT);

	if (ret == 0) {
		set_rdy(1);
	}
	return ret;
}
