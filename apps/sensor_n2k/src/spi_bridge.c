#include "spi_bridge.h"
#include "n2k.h"
#include "sensor_config.h"

#include <string.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/can.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/cache.h>
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

/* 32-byte alignment matches the Cortex-M33 D-cache line size.
 * Cache coherency with the GPDMA is handled by explicit flush/invalidate
 * calls in bridge_thread around each spi_transceive(). */
static uint8_t spi_tx[BLOCK_SIZE] __aligned(32);
static uint8_t spi_rx[BLOCK_SIZE] __aligned(32);

static void set_rdy(int level)
{
	gpio_pin_set_dt(&rdy_gpio, level);
}

/* ------------------------------------------------------------------ */
/* CAN RX → ship queue (physical N2K bus → Linux)                     */
/* ------------------------------------------------------------------ */

CAN_MSGQ_DEFINE(can_rx_msgq, 32);

static atomic_t s_rx_count;

static void can_rx_thread_fn(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);
	struct can_frame rx;

	while (1) {
		if (k_msgq_get(&can_rx_msgq, &rx, K_FOREVER) == 0) {
			atomic_inc(&s_rx_count);
			LED3G_BLINK(1);
			/* Route through spi_bridge_enqueue() rather than
			 * k_msgq_put() directly so bus-RX frames and
			 * sensor-thread frames share one drop counter — see
			 * s_drop_count below.
			 */
			spi_bridge_enqueue(&rx);
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

		/* Config frames (0x1EFFFE..) are consumed here; not forwarded to bus */
		if ((f.id & SENSOR_CFG_CAN_ID_MASK) == SENSOR_CFG_CAN_ID_BASE) {
			sensor_config_update((uint8_t)(f.id & 0xFFU), f.data, nb);
			continue;
		}

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

	static uint32_t s_err_count;

	while (1) {
		/* Flush spi_tx from D-cache to SRAM so GPDMA reads current data.
		 * Invalidate spi_rx after transfer so CPU reads what GPDMA wrote,
		 * not stale cache lines.  Required because the STM32U5 GPDMA bypasses
		 * D-cache; without these calls the TX carries old block data and RX
		 * reads are coherent with cache (not SRAM) — identical symptom to a
		 * nocache buffer, but handled here rather than via MPU/linker section
		 * since ARCH_HAS_NOCACHE_MEMORY_SUPPORT is not available for STM32U5. */
		sys_cache_data_flush_range(spi_tx, BLOCK_SIZE);
		int ret = spi_transceive(spi_dev, &spi_cfg, &tx_set, &rx_set);
		sys_cache_data_invd_range(spi_rx, BLOCK_SIZE);
		if (ret < 0) {
			s_err_count++;
			/* 1-2 timeouts per poll cycle are normal (slave re-arms faster
			 * than bridge.js polls).  Only log when a real outage starts
			 * (>10 consecutive errors) and every 50th after that. */
			if (s_err_count == 10 || s_err_count % 50 == 0) {
				LOG_WRN("SPI: no master for %u cycles (err=%d)",
					s_err_count, ret);
			}
			k_sleep(K_MSEC(50));
			continue;
		}
		if (s_err_count >= 10) {
			LOG_INF("SPI: recovered after %u timeout(s)", s_err_count);
		}
		s_err_count = 0;
		inject_block(spi_rx);
		seq++;
		pack_block(seq);
	}
}

/* ------------------------------------------------------------------ */
/* Diagnostic heartbeat (visible in bridge.js SPI output)              */
/* ------------------------------------------------------------------ */

/*
 * Every 2 s, enqueue one frame to Linux so we can see Zephyr state
 * without a serial terminal.  CAN ID 0x1EFFFEXX is vendor-proprietary
 * (will not match any real N2K PGN).
 *
 * Frame data layout:
 *   [0] 0x44 ('D') — diagnostic magic
 *   [1] CAN state  (0=active 1=warning 2=passive 3=bus_off 4=stopped)
 *   [2] Claimed SA (0xFE = not yet claimed)
 *   [3] Uptime seconds, low byte
 *   [4] Uptime seconds, high byte
 *   [5]   RX frame count low byte (frames received from bus via FDCAN1)
 *   [6]   RX frame count high byte
 *   [7]   ship_msgq drop count, saturating at 0xFF — see
 *         spi_bridge_drop_count(). Previously "Last ISO Request TX
 *         result", a field nothing ever actually wrote (always read back
 *         0xFF="not sent"); repurposed rather than leaving it dead.
 *
 * A second frame on DIAG2_CAN_ID carries what didn't fit above — the raw
 * CAN bus error counters, needed to tell error-passive/bus-off apart from
 * a healthy bus rather than just inferring it from `cs` alone:
 *   [0] 0x45 ('E') — diagnostic-2 magic
 *   [1] TX error counter (struct can_bus_err_cnt.tx_err_cnt)
 *   [2] RX error counter (struct can_bus_err_cnt.rx_err_cnt)
 *   [3] CAN state — redundant with DIAG_CAN_ID's [1], cheap to include
 *   [4..7] reserved
 */
#define DIAG_CAN_ID   0x1EFFFEFUL
#define DIAG2_CAN_ID  0x1EFFFEEUL
#define DIAG_INTERVAL K_SECONDS(2)

K_THREAD_STACK_DEFINE(diag_stack, 1024);
static struct k_thread diag_td;

static void diag_thread(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);

	while (1) {
		k_sleep(DIAG_INTERVAL);

		enum can_state cs = CAN_STATE_STOPPED;
		struct can_bus_err_cnt err_cnt = {0};

		can_get_state(s_can_dev, &cs, &err_cnt);

		uint32_t up_s = (uint32_t)(k_uptime_get() / 1000U);
		uint16_t rxc  = (uint16_t)atomic_get(&s_rx_count);

		struct can_frame f = {0};
		f.id      = DIAG_CAN_ID;
		f.flags   = CAN_FRAME_IDE;
		f.dlc     = 8;
		f.data[0] = 0x44U;
		f.data[1] = (uint8_t)cs;
		f.data[2] = n2k_sa_get();
		f.data[3] = (uint8_t)(up_s & 0xFFU);
		f.data[4] = (uint8_t)((up_s >> 8) & 0xFFU);
		f.data[5] = (uint8_t)(rxc & 0xFFU);
		f.data[6] = (uint8_t)((rxc >> 8) & 0xFFU);
		f.data[7] = (uint8_t)spi_bridge_drop_count();

		spi_bridge_enqueue(&f);

		/* Extended stats: bus-off/error-passive detection needs the raw
		 * TEC/REC counters, which DIAG_CAN_ID above has no spare byte for.
		 */
		struct can_frame f2 = {0};

		f2.id      = DIAG2_CAN_ID;
		f2.flags   = CAN_FRAME_IDE;
		f2.dlc     = 8;
		f2.data[0] = 0x45U;
		f2.data[1] = err_cnt.tx_err_cnt;
		f2.data[2] = err_cnt.rx_err_cnt;
		f2.data[3] = (uint8_t)cs;   /* redundant with DIAG_CAN_ID, cheap to include */
		spi_bridge_enqueue(&f2);
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
		led3r_blink(3);   /* 3 red blinks = CAN not ready */
		return -ENODEV;
	}
	if (!device_is_ready(spi_dev)) {
		LOG_ERR("SPI3 not ready");
		led3g_blink(3);   /* 3 green blinks = SPI3 not ready */
		return -ENODEV;
	}
	if (!gpio_is_ready_dt(&rdy_gpio)) {
		LOG_ERR("RDY GPIO not ready");
		led3b_blink(3);   /* 3 blue blinks = RDY GPIO not ready */
		return -ENODEV;
	}

	gpio_pin_configure_dt(&rdy_gpio, GPIO_OUTPUT_INACTIVE);
	set_rdy(0);

	int ret = can_start(can_dev);
	if (ret != 0 && ret != -EALREADY) {
		LOG_ERR("can_start failed: %d", ret);
		led4r_blink(3);   /* 3 LED4-red blinks = can_start failed */
		return ret;
	}

	k_thread_create(&bridge_thread_data, bridge_stack, BRIDGE_STACK_SIZE,
			bridge_thread, NULL, NULL, NULL,
			BRIDGE_PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&bridge_thread_data, "spi_bridge");

	k_thread_create(&diag_td, diag_stack, 512,
			diag_thread, NULL, NULL, NULL,
			6, 0, K_NO_WAIT);
	k_thread_name_set(&diag_td, "spi_diag");

	LOG_INF("SPI bridge ready");
	return 0;
}

int spi_bridge_attach_rx(const struct device *can_dev)
{
	/* Add catch-all AFTER the specific N2K management filters so it gets
	 * a higher filter index.  M_CAN checks filters in ascending index
	 * order and uses the first match — putting the catch-all last means
	 * PGN 60928 and PGN 59904 frames still reach n2k_mgmt_q (lower
	 * indices) while everything else flows here to ship_msgq. */
	int ret = can_add_rx_filter_msgq(can_dev, &can_rx_msgq, &n2k_rx_filter);

	if (ret < 0) {
		LOG_ERR("spi_bridge catch-all filter failed: %d", ret);
	}
	return ret;
}

/* Every producer into ship_msgq (real CAN-bus RX via can_rx_thread_fn,
 * plus onewire/adc/pulse_counter sensor threads and the diagnostic
 * heartbeat, all via this function) goes through K_NO_WAIT — a full queue
 * means the frame is silently gone, no retry, no backpressure to the
 * caller beyond the return code. Nothing previously counted or logged
 * this. Saturating (not wrapping) so a burst that drops hundreds of
 * frames reads as "255+", not a confusingly small wrapped number.
 */
static atomic_t s_drop_count;

int spi_bridge_enqueue(const struct can_frame *frame)
{
	int ret = k_msgq_put(&ship_msgq, frame, K_NO_WAIT);

	if (ret == 0) {
		set_rdy(1);
	} else {
		uint32_t n = (uint32_t)atomic_inc(&s_drop_count) + 1U;

		/* Same throttling pattern as the SPI timeout log above:
		 * first hit gets attention immediately, then every 50th
		 * so a sustained burst doesn't flood the log itself.
		 */
		if (n == 1U || n % 50U == 0U) {
			LOG_WRN("ship_msgq full, dropping CAN frame id=0x%08X "
				"(total dropped=%u)", frame->id, n);
		}
	}
	return ret;
}

uint32_t spi_bridge_drop_count(void)
{
	uint32_t n = (uint32_t)atomic_get(&s_drop_count);

	return (n > 0xFFU) ? 0xFFU : n;
}
