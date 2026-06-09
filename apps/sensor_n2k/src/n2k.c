#include "n2k.h"

#include <errno.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(n2k, LOG_LEVEL_INF);

/*
 * NMEA 2000 / J1939 CAN ID layout (29-bit extended frame):
 *
 *   Bits 28-26  Priority  (3 bits)
 *   Bit  25     Reserved  (0)
 *   Bit  24     Data Page (DP)
 *   Bits 23-16  PDU Format (PF)
 *   Bits 15-8   PDU Specific / Group Extension (PS/GE)
 *   Bits 7-0    Source Address (SA)
 *
 * For PDU2 (broadcast, PF ≥ 240) PGNs the full PGN is (DP<<16)|(PF<<8)|GE.
 */
uint32_t n2k_can_id(uint32_t pgn, uint8_t priority, uint8_t src)
{
	uint8_t dp = (pgn >> 16) & 0x01U;
	uint8_t pf = (pgn >> 8)  & 0xFFU;
	uint8_t ge = pgn          & 0xFFU;

	return (uint32_t)(priority & 0x7U) << 26 |
	       (uint32_t)dp                << 24 |
	       (uint32_t)pf                << 16 |
	       (uint32_t)ge                <<  8 |
	       src;
}

int n2k_init(const struct device *can_dev)
{
	int ret;

	if (!device_is_ready(can_dev)) {
		LOG_ERR("CAN device not ready");
		return -ENODEV;
	}

	ret = can_start(can_dev);
	if (ret != 0 && ret != -EALREADY) {
		LOG_ERR("Failed to start CAN: %d", ret);
		return ret;
	}

	LOG_INF("N2K CAN ready, SA=0x%02X", N2K_SRC_ADDR);
	return 0;
}

/*
 * PGN 130312 – Temperature (8 bytes)
 *
 * Byte 0   : SID
 * Byte 1   : Temperature Instance
 * Byte 2   : Temperature Source
 * Bytes 3-4: Actual Temperature  uint16-LE, 0.01 K/bit  (max ~382 °C)
 * Bytes 5-6: Set Temperature     uint16-LE, 0.01 K/bit  (0xFFFF = n/a)
 * Byte 7   : Reserved (0xFF)
 */
int n2k_send_temp(const struct device *can_dev,
		  uint8_t instance, uint8_t source, float temp_k)
{
	struct can_frame frame = {0};
	uint16_t raw;

	/* Clamp to representable range */
	if (temp_k > 655.35f) {
		temp_k = 655.35f;
	}
	raw = (uint16_t)(temp_k * 100.0f);

	frame.id    = n2k_can_id(N2K_PGN_TEMP, N2K_PRIORITY, n2k_sa_get());
	frame.flags = CAN_FRAME_IDE;
	frame.dlc   = 8;
	frame.data[0] = 0;        /* SID */
	frame.data[1] = instance;
	frame.data[2] = source;
	frame.data[3] = raw & 0xFFU;
	frame.data[4] = (raw >> 8) & 0xFFU;
	frame.data[5] = 0xFFU;    /* Set Temp N/A */
	frame.data[6] = 0xFFU;
	frame.data[7] = 0xFFU;

	return can_send(can_dev, &frame, K_MSEC(100), NULL, NULL);
}

/*
 * PGN 130316 – Temperature, Extended Range (8 bytes)
 *
 * Byte 0   : SID
 * Byte 1   : Temperature Instance
 * Byte 2   : Temperature Source
 * Bytes 3-5: Actual Temperature  uint24-LE, 0.001 K/bit (max ~16 777 K)
 * Bytes 6-7: Set Temperature     uint16-LE, 0.001 K/bit (0xFFFF = n/a)
 */
int n2k_send_temp_ext(const struct device *can_dev,
		      uint8_t instance, uint8_t source, float temp_k)
{
	struct can_frame frame = {0};
	uint32_t raw = (uint32_t)(temp_k * 1000.0f);

	frame.id    = n2k_can_id(N2K_PGN_TEMP_EXT, N2K_PRIORITY, n2k_sa_get());
	frame.flags = CAN_FRAME_IDE;
	frame.dlc   = 8;
	frame.data[0] = 0;        /* SID */
	frame.data[1] = instance;
	frame.data[2] = source;
	frame.data[3] = raw        & 0xFFU;
	frame.data[4] = (raw >> 8) & 0xFFU;
	frame.data[5] = (raw >> 16) & 0xFFU;
	frame.data[6] = 0xFFU;    /* Set Temp N/A */
	frame.data[7] = 0xFFU;

	return can_send(can_dev, &frame, K_MSEC(100), NULL, NULL);
}

/* ------------------------------------------------------------------ */
/* ISO 11783-5 address claiming and management                         */
/* ------------------------------------------------------------------ */

static uint8_t        g_sa   = N2K_SRC_ADDR;
static const uint64_t g_name = N2K_NAME;
static const struct device *s_can;

/*
 * PDU1 CAN ID (PF < 240, addressed frame): PS byte carries destination.
 * Used for PGN 59904 and PGN 60928, both of which are PDU1 PGNs.
 */
static uint32_t pdu1_id(uint8_t pf, uint8_t dst, uint8_t sa)
{
	return (uint32_t)(N2K_PRIORITY & 0x7U) << 26 |
	       (uint32_t)pf                    << 16 |
	       (uint32_t)dst                   <<  8 |
	       sa;
}

/* Broadcast PGN 60928 with the current g_sa and g_name. */
static int claim_send(void)
{
	struct can_frame f = {0};

	f.id    = pdu1_id(0xEEU, N2K_ADDR_GLOBAL, g_sa);
	f.flags = CAN_FRAME_IDE;
	f.dlc   = 8;
	for (int i = 0; i < 8; i++) {
		f.data[i] = (uint8_t)(g_name >> (i * 8));
	}
	return can_send(s_can, &f, K_MSEC(100), NULL, NULL);
}

/*
 * Compare an incoming PGN 60928 against our current SA and NAME.
 * Returns true if we lost the address (g_sa advanced to the next candidate).
 * Returns false if we won or the frame is for a different SA.
 */
static bool conflict_check(const struct can_frame *rx)
{
	if ((rx->id & 0xFFU) != g_sa) {
		return false;   /* different address — not our conflict */
	}

	uint64_t rx_name = 0;

	for (int i = 0; i < 8; i++) {
		rx_name |= (uint64_t)rx->data[i] << (i * 8);
	}
	if (rx_name == g_name) {
		return false;   /* our own frame reflected back */
	}
	if (rx_name < g_name) {
		/* Lower NAME wins (ISO 11783-5 §9.4.2); we must yield. */
		g_sa = (g_sa < 0xFDU) ? (uint8_t)(g_sa + 1U) : N2K_ADDR_NULL;
		return true;
	}
	/* Our NAME is lower — we hold the address; other device must yield. */
	return false;
}

/* CAN filters: PGN 60928 (PF=0xEE) and PGN 59904 (PF=0xEA), DP=0. */
static const struct can_filter claim_filt = {
	.flags = CAN_FILTER_IDE,
	.id    = 0x00EE0000UL,
	.mask  = 0x01FF0000UL,
};
static const struct can_filter req_filt = {
	.flags = CAN_FILTER_IDE,
	.id    = 0x00EA0000UL,
	.mask  = 0x01FF0000UL,
};

CAN_MSGQ_DEFINE(n2k_mgmt_q, 16);

#define MGMT_STACK_SIZE  768
#define MGMT_PRIO          4

K_THREAD_STACK_DEFINE(n2k_mgmt_stack, MGMT_STACK_SIZE);
static struct k_thread n2k_mgmt_td;

/*
 * Background thread: responds to ISO Requests (PGN 59904) and handles
 * address conflicts that arise after the startup claim window.
 */
static void mgmt_fn(void *a, void *b, void *c)
{
	ARG_UNUSED(a); ARG_UNUSED(b); ARG_UNUSED(c);
	struct can_frame rx;

	while (1) {
		k_msgq_get(&n2k_mgmt_q, &rx, K_FOREVER);

		uint8_t pf  = (uint8_t)((rx.id >> 16) & 0xFFU);
		uint8_t dst = (uint8_t)((rx.id >>  8) & 0xFFU);

		if (pf == 0xEEU) {
			/* Late address-claim conflict. */
			if (conflict_check(&rx) && g_sa != N2K_ADDR_NULL) {
				LOG_WRN("N2K late conflict: re-claiming SA=0x%02X", g_sa);
				claim_send();
			}
		} else if (pf == 0xEAU) {
			/* ISO Request — respond only if addressed to us or global. */
			if (dst != g_sa && dst != N2K_ADDR_GLOBAL) {
				continue;
			}
			if (rx.dlc < 3) {
				continue;
			}
			uint32_t req_pgn = (uint32_t)rx.data[0]
					 | ((uint32_t)rx.data[1] <<  8)
					 | ((uint32_t)rx.data[2] << 16);
			if (req_pgn == N2K_PGN_ISO_ADDR_CLAIM) {
				claim_send();
			}
		}
	}
}

int n2k_negotiate_address(const struct device *can_dev)
{
	s_can = can_dev;

	/*
	 * Attach permanent receive filters before transmitting the first claim
	 * so no conflict arriving in the same 250 ms window is missed.
	 */
	int fid1 = can_add_rx_filter_msgq(can_dev, &n2k_mgmt_q, &claim_filt);
	int fid2 = can_add_rx_filter_msgq(can_dev, &n2k_mgmt_q, &req_filt);

	if (fid1 < 0 || fid2 < 0) {
		LOG_ERR("N2K: filter add failed (%d, %d)", fid1, fid2);
		return (fid1 < 0) ? fid1 : fid2;
	}

	/* Claim loop: try successive addresses until one sticks. */
	for (;;) {
		if (g_sa >= N2K_ADDR_NULL) {
			LOG_ERR("N2K: no address available");
			return -EADDRINUSE;
		}

		claim_send();
		LOG_INF("N2K: claiming SA=0x%02X …", g_sa);

		/* ISO 11783-5 §9.4: wait 250 ms before declaring success. */
		int64_t deadline = k_uptime_get() + 250;
		bool retry = false;

		while (k_uptime_get() < deadline) {
			int64_t rem = deadline - k_uptime_get();
			struct can_frame rx;

			if (k_msgq_get(&n2k_mgmt_q, &rx, K_MSEC(rem)) != 0) {
				break;   /* timed out — no conflict */
			}
			/* Only address-claim frames matter during startup. */
			if (((rx.id >> 16) & 0xFFU) != 0xEEU) {
				continue;
			}
			if (conflict_check(&rx)) {
				retry = true;
				break;
			}
		}

		if (!retry) {
			break;
		}
	}

	LOG_INF("N2K: address claimed SA=0x%02X", g_sa);

	k_thread_create(&n2k_mgmt_td, n2k_mgmt_stack, MGMT_STACK_SIZE,
			mgmt_fn, NULL, NULL, NULL,
			MGMT_PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&n2k_mgmt_td, "n2k_mgmt");

	return 0;
}

uint8_t n2k_sa_get(void)
{
	return g_sa;
}
