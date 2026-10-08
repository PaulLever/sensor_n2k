#include "adc.h"
#include "bilge.h"
#include "n2k.h"
#include "onewire.h"
#include "pulse_counter.h"
#include "sensor_config.h"
#include "spi_bridge.h"
#include "alarm_io.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include "led.h"

/*
    LED Usage
	LED3R: CAN error (set on error)
	LED3G: CAN RX activity 
	LED3B: CAN TX activity
	LED4R: sensor acquisition error (set on error)
	LED4G: sensor read
	LED4B: new sensor debug
	*/

LOG_MODULE_REGISTER(sensor_n2k, LOG_LEVEL_INF);

#define STACK_SIZE  1536
#define PRIO        5

K_THREAD_STACK_DEFINE(adc_stack, STACK_SIZE);
K_THREAD_STACK_DEFINE(ow_stack,  STACK_SIZE);

static struct k_thread adc_thread_data;
static struct k_thread ow_thread_data;

/*
 * FDCAN1 — used by spi_bridge to forward frames received from Linux onto
 * the physical NMEA 2000 bus.  Sensor data flows the other way: threads →
 * spi_bridge TX queue → SPI block → Linux → SignalK → SPI block →
 * spi_bridge RX → FDCAN1.
 */
static const struct device *can_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_canbus));

CAN_MSGQ_DEFINE(sniff_q, 4);
CAN_MSGQ_DEFINE(mon_q,   32);

/*
 * Listen-only sniff: put FDCAN1 in passive mode for 3 s and check whether
 * any extended frames arrive from the N2K bus.
 *
 * LED result (shown after the 10-blink startup sequence):
 *   LED4G × 5  — Garmin traffic heard, RX path is OK
 *   LED4R × 5  — silence: CANH/CANL not reaching the chip
 */
static void can_bus_sniff(void)
{
	static const struct can_filter f = {
		.flags = CAN_FILTER_IDE, .id = 0, .mask = 0,
	};

	LOG_INF("Bus sniff: start");

#if defined(CONFIG_CAN_MCP2515)
	/*
	 * MCP2515: entering CONFIG mode (required for set_mode) stalls while any
	 * CAN frame is in-flight, which hangs the sniff when bus traffic is
	 * present and adds 10–20 s even on a quiet bus due to retry overhead.
	 * The MCP2515 is already started in Normal mode by n2k_init(); just add
	 * a catch-all filter and listen from the current mode.  Normal mode
	 * generates ACKs, which is acceptable for a go/no-go bus presence check.
	 */
	int fid = can_add_rx_filter_msgq(can_dev, &sniff_q, &f);
	struct can_frame rx;
	bool heard = (k_msgq_get(&sniff_q, &rx, K_SECONDS(3)) == 0);
	if (fid >= 0) {
		can_remove_rx_filter(can_dev, fid);
	}
#else
	/*
	 * FDCAN / native CAN: use NORMAL mode, not listen-only.
	 *
	 * Listen-only never drives an ACK bit, by design. If this is the only
	 * other live node acking a sender's frame, the sender sees a
	 * hardware ACK error and immediately retransmits the identical
	 * frame - CAN's normal, spec-compliant behavior. With a real bus
	 * node present that keeps retrying, this turns a "quiet observation"
	 * into a full-rate retry storm, which is the opposite of "not
	 * disturbing the bus". Confirmed on hardware: LISTENONLY produced a
	 * sustained flood of one node's request frame near line rate;
	 * switching this to NORMAL (which lets us ACK) dropped it to the
	 * handful of frames actually sent. Normal mode is safe here (unlike
	 * the historical note further down, which predates the FDCAN clock
	 * fix — see can_bus_monitor()).
	 */
	int err;
	struct can_frame rx;
	bool heard = false;

	can_stop(can_dev);
	err = can_set_mode(can_dev, CAN_MODE_NORMAL);
	if (err != 0) {
		LOG_ERR("Bus sniff: failed to set mode %d", err);
		goto restore;
	}
	err = can_start(can_dev);
	if ((err != 0) && (err != -EALREADY)) {
		LOG_ERR("Bus sniff: failed to start CAN controller %d", err);
		goto restore;
	}

	int fid = can_add_rx_filter_msgq(can_dev, &sniff_q, &f);
	heard = (k_msgq_get(&sniff_q, &rx, K_SECONDS(3)) == 0);
	if (fid >= 0) {
		can_remove_rx_filter(can_dev, fid);
	}
	can_stop(can_dev);

restore:
	can_set_mode(can_dev, CAN_MODE_NORMAL);
#endif /* CONFIG_CAN_MCP2515 */

	if (heard) {
		LOG_INF("Bus sniff: N2K traffic detected — RX OK");
		led4g_blink(5);
	} else {
		LOG_WRN("Bus sniff: no traffic in 3 s — check CANH/CANL");
		led4r_blink(5);
	}
}


/*
 * 30-second active bus monitor.
 *
 * Runs in NORMAL mode, not listen-only. Earlier versions of this function
 * used CAN_MODE_LISTENONLY on the theory that suppressing our own ACK/error
 * frames would be gentler on the bus. That's backwards: CAN's ACK slot is
 * part of the protocol, not optional politeness. A sender whose frame goes
 * unacknowledged sees a hardware ACK error and immediately retransmits the
 * identical frame — that's automatic, spec-mandated retry, not a bug in the
 * sender. With only one other live node on the bus and this node unable to
 * ACK, that retry loop free-runs at (near) full bus rate indefinitely.
 *
 * Confirmed on hardware: a run in LISTENONLY mode logged 43,000+ frames in
 * ~24 s (near line-rate for 250 kbit/s) — a single ISO Request being retried
 * nonstop because nothing ever acked it. Switching this function to NORMAL
 * mode dropped that to 3 frames total, with clean silence afterward — the
 * real amount of traffic the other node actually intended to send.
 *
 * There IS a historical note (see git blame, commit 552eacf1, 2026-06-21)
 * that normal mode "corrupted Garmin's frames" with REC hitting 127 and 0
 * frames received. That predates the FDCAN kernel-clock fix (this board's
 * FDCAN was silently running at ~25 kbit/s instead of 250 kbit/s at the
 * time — see the fdcan1 `clocks` property in arduino_uno_q.overlay and
 * debug_can_clocks() in this file). A node transmitting bit-timing garbage
 * at the wrong rate would produce exactly that symptom on any other node
 * regardless of ACK behavior. With the clock fix in place, normal mode is
 * clean — verified end to end here, plus address claim and product-info
 * broadcast succeeding immediately afterward.
 *
 * How to use:
 *   1. Flash and power on this board.
 *   2. Wait for "Bus monitor: ready" in RTT.
 *   3. Power on Garmin devices.
 *   4. Watch the log for 30 s:
 *        RX frame lines  → CRX signal is good; frames decode cleanly
 *        Silence only    → CRX signal too degraded to form a valid CAN frame
 */
static void can_bus_monitor(void)
{
	static const struct can_filter f_all = {
		.flags = CAN_FILTER_IDE, .id = 0, .mask = 0,
	};
	int err;

	can_stop(can_dev);
	err = can_set_mode(can_dev, CAN_MODE_NORMAL);
	if (err != 0) {
		LOG_ERR("Bus monitor: set mode failed %d", err);
		goto restore;
	}
	err = can_start(can_dev);
	if (err != 0 && err != -EALREADY) {
		LOG_ERR("Bus monitor: start failed %d", err);
		goto restore;
	}

	int fid = can_add_rx_filter_msgq(can_dev, &mon_q, &f_all);
	if (fid < 0) {
		LOG_ERR("Bus monitor: filter add failed %d", fid);
		goto stop;
	}

	LOG_INF("Bus monitor: normal mode, 30 s — power on Garmin now");

	uint32_t n_frames = 0;
	int64_t  t0       = k_uptime_get();
	int64_t  deadline = t0 + 30000;
	int64_t  next_hb  = t0 + 5000;

	while (k_uptime_get() < deadline) {
		struct can_frame rx;
		int64_t rem = deadline - k_uptime_get();

		if (k_msgq_get(&mon_q, &rx, K_MSEC(MIN(rem, 200))) == 0) {
			uint8_t  pri =  (rx.id >> 26) & 0x7U;
			uint8_t  dp  =  (rx.id >> 24) & 0x1U;
			uint8_t  pf  =  (rx.id >> 16) & 0xFFU;
			uint8_t  ps  =  (rx.id >>  8) & 0xFFU;
			uint8_t  sa  =   rx.id        & 0xFFU;
			uint32_t pgn = (pf < 240U)
				? ((uint32_t)dp << 16) | ((uint32_t)pf << 8)
				: ((uint32_t)dp << 16) | ((uint32_t)pf << 8) | ps;

			LOG_INF("RX #%u +%llds pri=%u pgn=0x%05X sa=0x%02X "
				"%02X%02X%02X%02X%02X%02X%02X%02X",
				++n_frames,
				(long long)((k_uptime_get() - t0) / 1000),
				pri, pgn, sa,
				rx.data[0], rx.data[1], rx.data[2], rx.data[3],
				rx.data[4], rx.data[5], rx.data[6], rx.data[7]);
		}

		if (k_uptime_get() >= next_hb) {
			LOG_INF("Bus monitor: +%llds — %u frames received",
				(long long)((k_uptime_get() - t0) / 1000),
				n_frames);
			next_hb += 5000;
		}
	}

	LOG_INF("Bus monitor: done — %u frames in 30 s", n_frames);
	if (n_frames == 0) {
		LOG_WRN("Bus monitor: no frames — "
			"CRX signal too degraded or Garmin did not transmit");
	}

	can_remove_rx_filter(can_dev, fid);

stop:
	can_stop(can_dev);
restore:
	can_set_mode(can_dev, CAN_MODE_NORMAL);
}

void debug_can_clocks(void)
{
    // 1. Check if the physical HSE Crystal is actually turned ON and STABLE
    uint32_t rcc_cr = RCC->CR;
    bool hse_on = (rcc_cr & RCC_CR_HSEON) != 0;
    bool hse_ready = (rcc_cr & RCC_CR_HSERDY) != 0;
    
    // 2. Query the exact Clock Multiplexer source assigned to FDCAN
    // On the STM32U5, the CCIPR1 register manages the peripheral kernel selections
    uint32_t fdcan_sel = (RCC->CCIPR1 & RCC_CCIPR1_FDCANSEL_Msk) >> RCC_CCIPR1_FDCANSEL_Pos;

    printk("=== NMEA 2000 Clock Debug ===\n");
    printk("HSE Oscillator Active: %s\n", hse_on ? "YES" : "NO");
    printk("HSE Clock Stabilized:  %s\n", hse_ready ? "YES" : "NO");

    /* There is no HCLK input on the FDCAN kernel mux. Per RM0456 CCIPR1[25:24]
     * and DS13086 Fig. 5, the mux is fed only by HSE, pll1_q_ck, pll2_p_ck:
     * 00=HSE, 01=PLL1_Q, 10=PLL2_P, 11=reserved. The previous table here
     * reported the opposite of the truth (00 as HCLK, 10 as HSE).
     */
    if (fdcan_sel == 0) {
        printk("FDCAN Kernel Source:   HSE\n");
    } else if (fdcan_sel == 1) {
        printk("FDCAN Kernel Source:   PLL1_Q\n");
    } else if (fdcan_sel == 2) {
        printk("FDCAN Kernel Source:   PLL2_P\n");
    } else {
        printk("FDCAN Kernel Source:   Reserved/Unknown (%d)\n", fdcan_sel);
    }

    /* This is what actually sets the bit rate - print it directly rather
     * than trusting the mux decode above.
     */
    uint32_t rate = 0;
    can_get_core_clock(can_dev, &rate);
    printk("FDCAN core clock as seen by driver: %u Hz\n", rate);

    printk("=============================\n");
}
#include <zephyr/drivers/gpio.h>
/* PB9 is Pin 9 on Port B — FDCAN1_TX on new wiring (D10) */
#define TEST_TX_PIN  9
static const struct device *gpiob_dev = DEVICE_DT_GET(DT_NODELABEL(gpiob));

int main(void)
{
	int ret;

	init_leds();
	led3r_blink(10);
	led4g_blink(10);

	alarm_io_init();


#if 0
    if (!device_is_ready(gpiob_dev)) {
        printk("Error: GPIOB peripheral port not ready!\n");
        return -1;
    }

    /* Force PB9 (D10, CTX) HIGH — transceiver should drive bus recessive (0 V diff) */
    ret = gpio_pin_configure(gpiob_dev, TEST_TX_PIN, GPIO_OUTPUT_ACTIVE | GPIO_PULL_UP);
    if (ret < 0) {
        printk("Failed to configure PB9: %d\n", ret);
        return -1;
    }

    printk("PB9 (D10, CAN_TX) forced HIGH — measure CAN-H to CAN-L delta now (expect ~0 V)\n");
	int ii = 15;
    while (ii--) {
        k_sleep(K_MSEC(1000));
    }

    /* Force PB9 (D10, CTX) LOW — transceiver should drive bus dominant (~2 V diff) */
    ret = gpio_pin_configure(gpiob_dev, TEST_TX_PIN, GPIO_OUTPUT_INACTIVE | GPIO_PULL_UP);
    if (ret < 0) {
        printk("Failed to configure PB9: %d\n", ret);
        return -1;
    }

    printk("PB9 (D10, CAN_TX) forced LOW — measure CAN-H to CAN-L delta now (expect ~2 V)\n");

    while (1) {
        k_sleep(K_MSEC(1000));
    }
	return 0;
#endif
	
	sensor_config_load();   /* populate g_sensor_cfg from NVS (or compile-time defaults) */

	/* Give the Arduino UNO Q's internal SPI bridge time to negotiate its
	 * link with the Qualcomm processor before enabling CAN interrupts. */
	k_msleep(2000);
	bool loop_back = false;
	LOG_INF("Initializing N2K CAN in %s mode...", loop_back ? "loopback" : "normal");
	if ((ret = n2k_init(can_dev, loop_back)) != 0) {
		led3r_set(1);
		LOG_ERR("N2K init failed: %d", ret);
		////return ret;
	}

	debug_can_clocks();
#if defined(CONFIG_CAN_STM32_FDCAN)
	can_bus_monitor();   /* FDCAN path diagnostic — 30 s listen window */
#else
	can_bus_sniff();     /* MCP2515 / SPI CAN: quick 3 s go/no-go check */
#endif

	/*
	 * spi_bridge_init() starts the CAN controller and the SPI slave
	 * bridge thread.  After this returns, the SPI link to Linux is live
	 * and FDCAN1 is ready to transmit frames that arrive from Linux.
	 */
	ret = spi_bridge_init(can_dev);
	if (ret != 0) {
		return ret;
	}

	ret = n2k_negotiate_address(can_dev);
	if (ret != 0) {
		led3r_set(1);
		return ret;
	}

	/* Attach catch-all RX filter AFTER address claiming so the N2K
	 * management filters (PGN 60928, 59904) already occupy lower M_CAN
	 * filter indices and win the hardware priority check first. */
	ret = spi_bridge_attach_rx(can_dev);
	if (ret < 0) {
		return ret;
	}

	k_thread_create(&adc_thread_data, adc_stack, STACK_SIZE,
			adc_thread, NULL, NULL, NULL,
			PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&adc_thread_data, "adc");

	k_thread_create(&ow_thread_data, ow_stack, STACK_SIZE,
			onewire_thread, NULL, NULL, NULL,
			PRIO, 0, K_NO_WAIT);
	k_thread_name_set(&ow_thread_data, "1wire");

	pulse_counter_init(can_dev);   /* starts thread only if a counter is enabled */

	bilge_init(can_dev);

	return 0;
}
