#ifndef N2K_H_
#define N2K_H_

#include <zephyr/drivers/can.h>
#include <stdint.h>

/* Source address this device claims on the N2K bus */
#define N2K_SRC_ADDR   0x30U
/* Default priority for environmental / engine PGNs */
#define N2K_PRIORITY   6U

/*
 * PGN 130312 – Temperature (single frame, max ~382 °C).
 * Use for 1-wire DS18B20 readings (range −55 … +125 °C).
 */
#define N2K_PGN_STW           128259UL  /* Speed Through Water            */
#define N2K_PGN_ENGINE_RAPID  127488UL  /* Engine Parameters Rapid Update */
#define N2K_PGN_ENGINE_DYN    127489UL  /* Engine Parameters Dynamic (fast-packet, 26 bytes) */
#define N2K_PGN_TRANS_DYN     127493UL  /* Transmission Parameters Dynamic */

#define N2K_PGN_TEMP          130312UL  /* Temperature (8 bytes, single frame) */
#define N2K_PGN_ENV_PARAMS    130311UL  /* Environmental Parameters (8 bytes, single frame) */
#define N2K_PGN_BINARY_SWITCH_STATUS 127501UL  /* Binary Switch Bank Status (8 bytes, single frame) */

/*
 * PGN 130316 – Temperature, Extended Range (single frame, up to ~16 500 °C).
 * Use for exhaust gas temperature (EGT) or other high-range measurements.
 */
#define N2K_PGN_TEMP_EXT    130316UL

/* Temperature source codes (shared by PGN 130312 and 130316) */
#define N2K_TSRC_SEA         0U
#define N2K_TSRC_OUTSIDE     1U
#define N2K_TSRC_INSIDE      2U
#define N2K_TSRC_ENGINE_ROOM 3U
#define N2K_TSRC_EGT        14U   /* Exhaust Gas Temperature */

/**
 * Start the CAN controller (must be called before any send).
 * Returns 0 on success, negative errno on error.
 */
int n2k_init(const struct device *can_dev, bool loopback);

/**
 * PGN 130312 – Temperature (8 bytes, single CAN frame).
 * @param temp_k  Temperature in Kelvin (clamped to uint16 × 0.01 K range).
 */
int n2k_send_temp(const struct device *can_dev,
		  uint8_t instance, uint8_t source, float temp_k);

/**
 * PGN 130316 – Temperature Extended Range (8 bytes, single CAN frame).
 * @param temp_k  Temperature in Kelvin, encoded as uint24 × 0.001 K.
 */
int n2k_send_temp_ext(const struct device *can_dev,
		      uint8_t instance, uint8_t source, float temp_k);

/** Build the 29-bit CAN ID for a PDU2 (broadcast) NMEA 2000 PGN. */
uint32_t n2k_can_id(uint32_t pgn, uint8_t priority, uint8_t src);

/**
 * Transmit a pre-built CAN frame directly on the physical N2K bus (FDCAN).
 * Usable after n2k_negotiate_address() has been called.
 * Returns 0 on success, negative errno on error.
 */
int n2k_send_frame(const struct can_frame *frame);

/*
 * Maximum CAN frames produced by n2k_build_temp_frames().
 * Single-frame PGNs (130312, 130316, 130311) produce 1 frame.
 * PGN 127489 (fast-packet, 26 bytes) produces 4 frames.
 */
#define N2K_TEMP_MAX_FRAMES 4U

/**
 * Build CAN frame(s) for a temperature reading according to the chosen PGN.
 *
 * @param pgn_id    N2K_PGNCFG_* constant from sensor_config.h
 * @param instance  Temperature instance, or engine instance for ENGINE_DYN
 * @param source    N2K_TSRC_* source code, or field selector for ENGINE_DYN:
 *                    0 = Oil Temperature (payload bytes 3-4)
 *                    1 = Engine/Coolant Temperature (payload bytes 5-6)
 * @param temp_k    Temperature in Kelvin
 * @param out       Array of at least N2K_TEMP_MAX_FRAMES can_frame structs
 * @return          Number of frames written to out[] (1–4), or 0 on error
 */
int n2k_build_temp_frames(uint8_t pgn_id, uint8_t instance, uint8_t source,
                           float temp_k, struct can_frame out[N2K_TEMP_MAX_FRAMES]);

/**
 * Build a single CAN frame for PGN 127501 – Binary Switch Bank Status.
 * Reports up to 4 indicators (indicators 1-4 of the 28 the PGN supports);
 * the remaining 24 are always reported as 3 (Unavailable) since this
 * device doesn't own those channels.
 *
 * @param instance  Switch bank instance number
 * @param states    4 channel states: 0 = off, 1 = on
 * @param out       Single can_frame to fill in
 * @return          0 on success
 */
int n2k_build_switch_frame(uint8_t instance, const uint8_t states[4],
                            struct can_frame *out);

/* ------------------------------------------------------------------ */
/* ISO 11783-5 address management                                       */
/* ------------------------------------------------------------------ */

#define N2K_PGN_ISO_REQUEST      59904UL   /* 0xEA00 — request any PGN */
#define N2K_PGN_ISO_ADDR_CLAIM   60928UL   /* 0xEE00 — address claim   */
#define N2K_PGN_PRODUCT_INFO    126996UL   /* 0x1F014 — product info (fast packet) */
#define N2K_ADDR_NULL            0xFEU     /* cannot claim an address  */
#define N2K_ADDR_GLOBAL          0xFFU     /* broadcast / no dest      */

/* ------------------------------------------------------------------ */
/* PGN 126996 – Product Information content (adjust per device)        */
/* ------------------------------------------------------------------ */

#define N2K_PROD_DB_VERSION   2100U        /* NMEA 2000 DB version × 100 (21.00) */
#define N2K_PROD_CODE            0U        /* manufacturer product code           */
#define N2K_PROD_MODEL_ID   "sensor_n2k"  /* model name,      max 32 chars       */
#define N2K_PROD_SW_CODE       "1.0.0"    /* software version, max 32 chars      */
#define N2K_PROD_MODEL_VER     "1.0"      /* hardware revision, max 32 chars     */
#define N2K_PROD_SERIAL_CODE "00000001"   /* serial number,   max 32 chars       */
#define N2K_PROD_CERT_LEVEL      0U        /* 0 = not certified                  */
#define N2K_PROD_LOAD_EQ         1U        /* 1 LEN = ≤50 mA bus current         */

/*
 * 64-bit device NAME (ISO 11783-5 §4.2).  Adjust the field constants to
 * match the actual device class and manufacturer.
 *
 * Bit layout, MSB→LSB of the uint64_t:
 *   [63]    Arbitrary Address Capable (1 = device can resolve conflicts)
 *   [62:60] Industry Group            (4 = Marine)
 *   [59:56] System Instance           (0)
 *   [55:49] Device Class              (75 = Sensors)
 *   [48]    Reserved                  (0)
 *   [47:40] Function                  (130 = Temperature Sensor)
 *   [39:35] Function Instance         (0)
 *   [34:32] ECU Instance              (0)
 *   [31:21] Manufacturer Code         (0x7FF = proprietary/unregistered)
 *   [20:0]  Identity Number           (unique per physical device, 21 bits)
 */
#define N2K_NAME_ARBITRARY_ADDR  1U
#define N2K_NAME_INDUSTRY_GROUP  4U      /* Marine */
#define N2K_NAME_SYS_INSTANCE    0U
#define N2K_NAME_DEVICE_CLASS   75U      /* Propulsion */
#define N2K_NAME_FUNCTION      130U      /* Temperature Sensor */
#define N2K_NAME_FUNC_INSTANCE   0U
#define N2K_NAME_ECU_INSTANCE    0U
#define N2K_NAME_MANUFACTURER 0x7FEU     /* custom DIY, */
#define N2K_NAME_IDENTITY        1U      /* change per physical device */

#define N2K_NAME ( \
	((uint64_t)(N2K_NAME_ARBITRARY_ADDR & 0x01U)    << 63) | \
	((uint64_t)(N2K_NAME_INDUSTRY_GROUP & 0x07U)    << 60) | \
	((uint64_t)(N2K_NAME_SYS_INSTANCE   & 0x0FU)    << 56) | \
	((uint64_t)(N2K_NAME_DEVICE_CLASS   & 0x7FU)    << 49) | \
	((uint64_t)(N2K_NAME_FUNCTION       & 0xFFU)    << 40) | \
	((uint64_t)(N2K_NAME_FUNC_INSTANCE  & 0x1FU)    << 35) | \
	((uint64_t)(N2K_NAME_ECU_INSTANCE   & 0x07U)    << 32) | \
	((uint64_t)(N2K_NAME_MANUFACTURER   & 0x7FFU)   << 21) | \
	((uint64_t)(N2K_NAME_IDENTITY       & 0x1FFFFFUL)     ))

/**
 * Claim a source address on the NMEA 2000 bus (ISO 11783-5 §9.4).
 *
 * Sends PGN 60928, waits 250 ms for conflicts, and retries with the next
 * available SA if another device with a lower NAME already holds this one.
 * On success, starts a background thread that responds to ISO Requests
 * (PGN 59904) and resolves any late address conflicts.
 *
 * Must be called after the CAN controller is started (i.e. after
 * spi_bridge_init) and before any sensor frames are transmitted.
 *
 * Returns 0 on success, negative errno on error.
 */
int n2k_negotiate_address(const struct device *can_dev);

/** Return the currently claimed SA (0x00–0xFD), or N2K_ADDR_NULL if
 *  address claiming failed. */
uint8_t n2k_sa_get(void);

/**
 * Return true only if n2k_sa_get()'s SA has actually been ACKed on the wire
 * by another device. On a bus with no other node present, n2k_negotiate_address()
 * still returns success with an SA assigned (see N2K_CLAIM_MAX_UNCONFIRMED_ATTEMPTS
 * in n2k.c) so the rest of the system can start up, but that SA is *unconfirmed*
 * until a real device answers — this distinguishes the two for callers (e.g. the
 * SPI bridge diagnostic frame / bus-monitor UI) that shouldn't report it as a
 * solid claim.
 */
bool n2k_sa_confirmed(void);

/**
 * Broadcast an ISO Request (PGN 59904, global destination) for the given
 * PGN. Standard ISO 11783 / N2K mechanism for soliciting a response from
 * any device on the bus, including ones that only transmit at their own
 * power-on (e.g. passive instrument displays) — every device is required
 * to respond to a global request for its own Address Claim (PGN 60928),
 * so this is how a bus/device monitor discovers devices that were already
 * up and settled before this node started listening, without needing
 * them power-cycled.
 *
 * Only usable after n2k_negotiate_address() has completed (needs a valid
 * source address to send from).
 */
void n2k_send_iso_request(uint32_t requested_pgn);

/** Convenience wrapper: n2k_send_iso_request(N2K_PGN_ISO_ADDR_CLAIM). */
void n2k_discover_devices(void);

/** Convenience wrapper: n2k_send_iso_request(N2K_PGN_PRODUCT_INFO).
 *  Broadcast so every device that implements it replies with PGN 126996
 *  (model/serial/software info) — lets bus-monitor-server.js auto-populate
 *  a device's real name instead of just its manufacturer. */
void n2k_request_product_info(void);

#endif /* N2K_H_ */
