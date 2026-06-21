#include "adc.h"
#include "n2k.h"
#include "onewire.h"
#include "spi_bridge.h"

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
	int err;
	static const struct can_filter f = {
		.flags = CAN_FILTER_IDE, .id = 0, .mask = 0,
	};

	LOG_INF("Bus sniff: start");
	can_stop(can_dev);
	err = can_set_mode(can_dev, CAN_MODE_LISTENONLY);
	if (err != 0) {
		LOG_ERR("Bus sniff: failed to set listen-only mode %d", err);
		goto restore;
	}
	err = can_start(can_dev);
	if ((err != 0) && (err != -EALREADY)) {
		LOG_ERR("Bus sniff: failed to start CAN controller %d", err);
		goto restore;
	}

	int fid = can_add_rx_filter_msgq(can_dev, &sniff_q, &f);

	struct can_frame rx;
	bool heard = (k_msgq_get(&sniff_q, &rx, K_SECONDS(3)) == 0);

	if (fid >= 0) {
		can_remove_rx_filter(can_dev, fid);
	}
	can_stop(can_dev);

	if (heard) {
		LOG_INF("Bus sniff: N2K traffic detected — RX OK");
		led4g_blink(5);
	} else {
		LOG_WRN("Bus sniff: no traffic in 3 s — check CANH/CANL");
		led4r_blink(5);
	}

restore:
	can_set_mode(can_dev, CAN_MODE_NORMAL);
}


/*
 * 30-second active bus monitor.
 *
 * Runs in LISTEN-ONLY (bus monitoring) mode: we generate zero bus traffic —
 * no ACK bits, no error flags, nothing.  This lets Garmin's frames complete
 * cleanly without us corrupting them.  Error counters are frozen by the
 * M_CAN hardware in this mode, so only the frame count is meaningful.
 *
 * Previous run (normal mode) result: REC hit 127 the moment Garmin powered
 * on but 0 valid frames were received.  In normal mode our FDCAN was sending
 * active error flags that corrupted Garmin's frames.  This listen-only run
 * removes that interference to isolate whether the CRX signal itself is good.
 *
 * How to use:
 *   1. Flash and power on this board.
 *   2. Wait for "Bus monitor: ready" in RTT.
 *   3. Power on Garmin devices.
 *   4. Watch the log for 30 s:
 *        RX frame lines  → CRX signal is good; Garmin frames decode cleanly
 *        Silence only    → CRX signal too degraded to form a valid CAN frame
 */
static void can_bus_monitor(void)
{
	static const struct can_filter f_all = {
		.flags = CAN_FILTER_IDE, .id = 0, .mask = 0,
	};
	int err;

	can_stop(can_dev);
	err = can_set_mode(can_dev, CAN_MODE_LISTENONLY);
	if (err != 0) {
		LOG_ERR("Bus monitor: listen-only mode failed %d", err);
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

	LOG_INF("Bus monitor: listen-only, 30 s — power on Garmin now");

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

    /* RM0456 §7.4.29 CCIPR1 bits[25:24] FDCAN1SEL: 00=HCLK, 01=PLL1_Q, 10=HSE, 11=rsvd */
    if (fdcan_sel == 0) {
        printk("FDCAN Kernel Source:   HCLK=160MHz (MSIS-PLL, LSE-locked) [OK for 250kbit/s]\n");
    } else if (fdcan_sel == 1) {
        printk("FDCAN Kernel Source:   PLL1_Q\n");
    } else if (fdcan_sel == 2) {
        printk("FDCAN Kernel Source:   HSE (Crystal 48MHz)\n");
    } else {
        printk("FDCAN Kernel Source:   Reserved/Unknown (%d)\n", fdcan_sel);
    }
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
	
	// Give the Arduino Uno Q's internal SPI bridge plenty of time 
    // to negotiate its link with the Qualcomm processor before enabling CAN interrupts.
    k_msleep(2000); 
	if ((ret = n2k_init(can_dev, false)) != 0) {
		led3r_set(1);
		LOG_ERR("N2K init failed: %d", ret);
		////return ret;
	}

	debug_can_clocks();
	can_bus_monitor();   /* diagnostic: replace with can_bus_sniff() when done */

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

	return 0;
}
