#include "n2k.h"

#include <errno.h>
#include <string.h>
#include <zephyr/drivers/can.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "led.h"

LOG_MODULE_REGISTER(n2k, LOG_LEVEL_INF);

static K_SEM_DEFINE(claim_tx_sem, 0, 1);

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

int n2k_init(const struct device *can_dev, bool loopback)
{
	int ret;

	if (!device_is_ready(can_dev)) {
		LOG_ERR("CAN device not ready");
		return -ENODEV;
	}

	if (loopback) {
		ret = can_set_mode(can_dev, CAN_MODE_LOOPBACK);
		if (ret != 0) {
			led3r_set(1);
			LOG_ERR("Failed to set Loopback Mode: %d", ret);
			return ret;
		}
	} else {
		/* Stop the controller before altering hardware timing engines */
		can_stop(can_dev);

		/* 1. Calculate precise NMEA 2000 timings: 250,000 bps at 87.5% sample point */
		struct can_timing timing;
		int ret = can_calc_timing(can_dev, &timing, 250000, 875);
		if (ret < 0) {
			led3r_set(1);
			LOG_ERR("Failed to set timing calculation: %d", ret);
			return -1;
		}
		/* ret = sample-point deviation in ‰ from 875‰ (0 = exact match).
		 * Hardware TSEG1 = prop_seg + phase_seg1. */
		LOG_INF("CAN timing: sp_dev=%d‰ BRP=%u prop=%u phase1=%u phase2=%u SJW=%u",
			ret, timing.prescaler, timing.prop_seg,
			timing.phase_seg1, timing.phase_seg2, timing.sjw);
		/* 2. Commit the calculated timing to the Bosch hardware registers */
		ret = can_set_timing(can_dev, &timing);
		if (ret != 0) {
			led3r_set(1);
			LOG_ERR("Failed to set timing: %d", ret);
			return -1;
		}
	}

	ret = can_start(can_dev);
	if (ret != 0 && ret != -EALREADY) {
		LOG_ERR("Failed to start CAN: %d", ret);
		return ret;
	}
	/* let the can HW settle in */
	k_msleep(100);
	
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
	uint32_t id = (uint32_t)(N2K_PRIORITY & 0x7U) << 26 |
	       (uint32_t)pf                    << 16 |
	       (uint32_t)dst                   <<  8 |
	       sa;
	return id & 0x1FFFFFFFU; /* Strict mask to ensure clean Zephyr FDCAN register writing */
}

/*
 * TX callback: fired by the CAN driver when the hardware finishes (or aborts)
 * the claim frame. We record the error but never gate the 250ms conflict
 * window on it — the window starts at transmission time per ISO 11783-5 §9.4.
 */
static volatile int claim_tx_err;

static void claim_tx_cb(const struct device *dev, int error, void *user_data)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(user_data);
	claim_tx_err = error;
	k_sem_give(&claim_tx_sem);
}

/*
 * Build and queue PGN 60928 for broadcast with the current g_sa / g_name.
 * Returns 0 if the frame was accepted by the CAN controller, negative errno
 * if the controller rejected it immediately (bus-off, no mailbox within 100ms).
 *
 * The caller MUST start the 250ms conflict window immediately after this
 * returns 0 — do NOT wait for the TX callback first.
 */
static int claim_send(void)
{
	struct can_frame f = {0};

	f.id    = pdu1_id(0xEEU, N2K_ADDR_GLOBAL, g_sa);
	f.flags = CAN_FRAME_IDE;
	f.dlc   = 8;
	for (int i = 0; i < 8; i++) {
		f.data[i] = (uint8_t)(g_name >> (i * 8));
	}

	k_sem_reset(&claim_tx_sem);
	claim_tx_err = 0;

	/*
	 * 100 ms mailbox timeout: on a healthy 250 kbit/s bus a frame takes
	 * ~0.3 ms; 100 ms is ample even under heavy load.  If we wait longer
	 * we push the 250ms conflict window dangerously late.
	 */
	return can_send(s_can, &f, K_MSEC(100), claim_tx_cb, NULL);
}

/*
 * ISO 11783-5 §9.3 — Cannot Claim Address.
 * Sent when all 253 unicast SAs are exhausted.  Uses SA=0xFE (NULL address)
 * so other devices know we exist but have no usable address.
 */
static void cannot_claim_send(void)
{
	struct can_frame f = {0};

	f.id    = pdu1_id(0xEEU, N2K_ADDR_GLOBAL, N2K_ADDR_NULL);
	f.flags = CAN_FRAME_IDE;
	f.dlc   = 8;
	for (int i = 0; i < 8; i++) {
		f.data[i] = (uint8_t)(g_name >> (i * 8));
	}
	can_send(s_can, &f, K_MSEC(100), NULL, NULL);
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

#define MGMT_STACK_SIZE  1024   /* enlarged for fast-packet payload on stack */
#define MGMT_PRIO           4

K_THREAD_STACK_DEFINE(n2k_mgmt_stack, MGMT_STACK_SIZE);
static struct k_thread n2k_mgmt_td;

/* ------------------------------------------------------------------ */
/* PGN 126996 – Product Information (NMEA 2000 Fast Packet)            */
/* ------------------------------------------------------------------ */

/*
 * Fast Packet layout (ISO 11783-3 / NMEA 2000):
 *   Frame 0  — byte[0]: (seq<<5)|0x00  byte[1]: total_bytes  bytes[2-7]: payload[0..5]
 *   Frame N  — byte[0]: (seq<<5)|N     bytes[1-7]: payload[6+(N-1)*7 .. +7]
 *
 * PGN 126996 payload = 134 bytes → 1 first frame + 19 continuation = 20 frames total.
 */
static uint8_t s_fp_seq; /* 3-bit rolling sequence tag, incremented per message */

static void product_info_send(void)
{
	uint8_t payload[134];

	memset(payload, 0xFF, sizeof(payload));

	/* NMEA 2000 Database Version (uint16 LE) */
	payload[0] = (uint8_t)(N2K_PROD_DB_VERSION & 0xFFU);
	payload[1] = (uint8_t)(N2K_PROD_DB_VERSION >> 8);

	/* Manufacturer Product Code (uint16 LE) */
	payload[2] = (uint8_t)(N2K_PROD_CODE & 0xFFU);
	payload[3] = (uint8_t)(N2K_PROD_CODE >> 8);

	/* String fields — copy into 32-byte slots; unused bytes remain 0xFF */
	const char *s;
	size_t      n;

	s = N2K_PROD_MODEL_ID;
	n = strlen(s);
	memcpy(&payload[4],   s, MIN(n, 32U));   /* Model ID            */

	s = N2K_PROD_SW_CODE;
	n = strlen(s);
	memcpy(&payload[36],  s, MIN(n, 32U));   /* Software Version    */

	s = N2K_PROD_MODEL_VER;
	n = strlen(s);
	memcpy(&payload[68],  s, MIN(n, 32U));   /* Model Version       */

	s = N2K_PROD_SERIAL_CODE;
	n = strlen(s);
	memcpy(&payload[100], s, MIN(n, 32U));   /* Serial Code         */

	payload[132] = N2K_PROD_CERT_LEVEL;
	payload[133] = N2K_PROD_LOAD_EQ;

	uint32_t can_id = n2k_can_id(N2K_PGN_PRODUCT_INFO, N2K_PRIORITY, g_sa);
	uint8_t  seq    = s_fp_seq & 0x07U;
	s_fp_seq = (uint8_t)((s_fp_seq + 1U) & 0x07U);

	struct can_frame f = {0};
	f.id    = can_id;
	f.flags = CAN_FRAME_IDE;
	f.dlc   = 8;

	/* Frame 0: sequence tag, total byte count, first 6 payload bytes */
	f.data[0] = (uint8_t)((seq << 5) | 0x00U);
	f.data[1] = (uint8_t)sizeof(payload);
	memcpy(&f.data[2], payload, 6);
	can_send(s_can, &f, K_MSEC(100), NULL, NULL);

	/* Continuation frames: 7 payload bytes each */
	size_t  offset = 6;
	uint8_t fn     = 1;

	while (offset < sizeof(payload)) {
		size_t chunk = MIN(7U, sizeof(payload) - offset);

		f.data[0] = (uint8_t)((seq << 5) | fn);
		memcpy(&f.data[1], &payload[offset], chunk);
		if (chunk < 7U) {
			memset(&f.data[1 + chunk], 0xFFU, 7U - chunk);
		}
		can_send(s_can, &f, K_MSEC(100), NULL, NULL);
		offset += chunk;
		fn++;
	}

	LOG_INF("N2K: sent PGN 126996 product info (%u frames)", fn);
}

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
		LED4B_BLINK(1);   /* any mgmt frame (PGN 60928 or 59904) received */

		uint8_t pf  = (uint8_t)((rx.id >> 16) & 0xFFU);
		uint8_t dst = (uint8_t)((rx.id >>  8) & 0xFFU);

		if (pf == 0xEEU) {
			/* Late address-claim conflict. */
			if (conflict_check(&rx)) {
				if (g_sa == N2K_ADDR_NULL) {
					LOG_ERR("N2K: late conflict, all addresses exhausted");
					cannot_claim_send();
				} else {
					LOG_WRN("N2K: late conflict, re-claiming SA=0x%02X", g_sa);
					claim_send();
				}
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
				/* Reply with our current claim (or Cannot Claim if g_sa==0xFE). */
				if (g_sa == N2K_ADDR_NULL) {
					cannot_claim_send();
				} else {
					claim_send();
				}
			} else if (req_pgn == N2K_PGN_PRODUCT_INFO) {
				/* Reply with PGN 126996 Product Information (fast packet). */
				if (g_sa != N2K_ADDR_NULL) {
					product_info_send();
				}
			}
		}
	}
}

/*
 * Recover the CAN controller from bus-off and restart it.
 * Waits up to `recovery_ms` for the hardware recovery sequence.
 */
static void busoff_recover(uint32_t recovery_ms)
{
	enum can_state cs;
	can_get_state(s_can, &cs, NULL);

	if (cs == CAN_STATE_BUS_OFF) {
		/* can_recover() clears CCCR.INIT and waits for it to read back 0,
		 * but M_CAN PSR.BO takes an additional ~6 ms (128×11 bits at
		 * 250 kbit/s) to clear after INIT is released.  Wait for both. */
		int rc = can_recover(s_can, K_MSEC(recovery_ms));
		if (rc != 0) {
			LOG_WRN("N2K: can_recover timed out (%d), proceeding", rc);
		}
		/* Let hardware finish the 128×11 recessive-bit sequence so
		 * PSR.BO clears before we read state or send the next frame. */
		k_msleep(15);
	} else {
		/* Error-passive with pending TX: stop cancels it, start resets
		 * the controller state (note: TEC is preserved across stop/start). */
		can_stop(s_can);
		k_msleep(15);
	}
	can_start(s_can);

	struct can_bus_err_cnt err_cnt;
	can_get_state(s_can, &cs, &err_cnt);
	LOG_INF("N2K: recovery complete, state=%d, err TX=%d,RX=%d",
		cs, err_cnt.tx_err_cnt, err_cnt.rx_err_cnt);
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
		/*
		 * ISO 11783-5 §9.3 — Cannot Claim Address.
		 * All unicast SAs exhausted; broadcast with SA=0xFE so other
		 * devices know this node exists without a usable address.
		 */
		if (g_sa >= N2K_ADDR_NULL) {
			LED3R_SET(1);
			LOG_ERR("N2K: all addresses exhausted, sending Cannot Claim");
			cannot_claim_send();
			return -EADDRINUSE;
		}

		/* Recover from bus-off before attempting TX — a failed prior
		 * send can leave FDCAN1 in bus-off which silences the RX path. */
		{
			enum can_state cs;
			if (can_get_state(s_can, &cs, NULL) == 0 &&
			    cs == CAN_STATE_BUS_OFF) {
				LOG_WRN("N2K: bus-off before claim, recovering");
				busoff_recover(2000);
				k_sleep(K_MSEC(50));
			}
		}

		LOG_INF("N2K: claiming SA=0x%02X", g_sa);

		int err = claim_send();
		if (err != 0) {
			/*
			 * Controller rejected the frame immediately (bus-off,
			 * no mailbox, etc.).  Recover and retry the same SA.
			 */
			LOG_WRN("N2K: claim enqueue failed (%d), recovering", err);
			busoff_recover(1000);
			k_sleep(K_MSEC(200));
			continue;
		}

		/*
		 * ISO 11783-5 §9.4.2 / IEC 61162-3:
		 * The 250 ms conflict-detection window opens at TRANSMISSION
		 * TIME, not after the ACK is received.  We must not block on
		 * the TX callback before starting this window.
		 */
		int64_t deadline = k_uptime_get() + 250;
		bool conflict = false;

		while (k_uptime_get() < deadline) {
			int64_t rem = deadline - k_uptime_get();
			struct can_frame rx;

			if (k_msgq_get(&n2k_mgmt_q, &rx, K_MSEC(rem)) != 0) {
				break;   /* window expired — no conflict */
			}
			/* Only address-claim frames are relevant during startup. */
			if (((rx.id >> 16) & 0xFFU) != 0xEEU) {
				continue;
			}
			if (conflict_check(&rx)) {
				conflict = true;
				break;   /* yielded; g_sa already incremented */
			}
		}

		if (conflict) {
			continue;   /* retry with the new g_sa */
		}

		/*
		 * No conflict in 250 ms: address is ours per ISO 11783-5 §9.4.
		 *
		 * Now wait for the TX callback to confirm the claim frame actually
		 * reached the wire.  The callback may be delayed if the bus was
		 * busy with higher-priority traffic during the conflict window.
		 *
		 * IEC 61162-3 / ISO 11783-5 recovery cases:
		 *   TX OK          → address confirmed, done.
		 *   TX error+busoff → recover controller, retry same SA.
		 *   TX error only   → retry same SA (transient ACK failure).
		 *   TX never done   → bus healthy but still busy; re-queue and
		 *                     wait once more before giving up.
		 */
		{
			int tx_result = k_sem_take(&claim_tx_sem, K_MSEC(1000));
			enum can_state cs;
			can_get_state(s_can, &cs, NULL);

			if (tx_result == 0 && claim_tx_err == 0) {
				/* TX confirmed on wire — address claimed. */
				LOG_INF("N2K: address claimed SA=0x%02X", g_sa);
				break;
			}

			if (cs == CAN_STATE_BUS_OFF) {
				LOG_WRN("N2K: bus-off after claim window "
					"(tx=%d err=%d); recovering SA=0x%02X",
					tx_result, claim_tx_err, g_sa);
				busoff_recover(2000);
				k_sleep(K_MSEC(50));
				continue;
			}

			if (tx_result == 0 && claim_tx_err != 0) {
				/* Callback fired but reported an error; bus is OK. */
				LOG_WRN("N2K: claim TX error %d (state=%d); retrying SA=0x%02X",
					claim_tx_err, cs, g_sa);
				continue;
			}

			/*
			 * tx_result != 0: callback never fired in 1250 ms.
			 * The frame is auto-retransmitting; adding another frame
			 * would jam all three TX mailbox slots. Recover instead
			 * and let the outer loop issue a fresh single claim.
			 */
			LOG_WRN("N2K: claim TX timeout 1.25s "
				"(state=%d); recovering SA=0x%02X", cs, g_sa);
			busoff_recover(2000);
			continue;
		}
	}

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
