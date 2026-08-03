/*
 * One-shot diagnostic: measure the real HSE crystal frequency on this board
 * by cross-timing DWT->CYCCNT (core clock cycles) against the RTC subsecond
 * counter, which is clocked from LSE (32.768 kHz), independently of HSE/PLL.
 *
 * Sequence:
 *   1. Program the RTC prescalers for a 256 Hz subsecond tick off LSE.
 *   2. Switch SYSCLK directly to HSE (AHB prescaler = 1), so HCLK == HSE.
 *   3. Count DWT cycles across a fixed number of RTC ticks (0.5 s window).
 *   4. freq_hz = cycles_elapsed / window_seconds.
 *
 * This does not touch CAN, SPI, ADC, or flash/NVS, so it is safe to run
 * standalone regardless of what sensor_n2k is doing.
 */

#include <stdbool.h>
#include <zephyr/kernel.h>
#include <zephyr/irq.h>
#include <zephyr/sys/printk.h>
#include <cmsis_core.h>
#include <stm32_ll_bus.h>
#include <stm32_ll_pwr.h>
#include <stm32_ll_rcc.h>
#include <stm32_ll_rtc.h>

#define RTC_TICK_HZ    256U  /* PREDIV_A = 127 -> ck_apre = 32768/(127+1) = 256 Hz */
#define MEASURE_TICKS  128U  /* 128 / 256 Hz = 0.5 s measurement window */
#define WAIT_SPINS     2000000U

/* Real-time bounded wait (kernel tick still valid; used before the SYSCLK
 * switch / irq_lock). A raw cycle-count spin isn't a safe timeout here: at
 * 160 MHz, 2,000,000 iterations of a trivial check is only tens of ms of
 * real time - nowhere near enough margin for LSE crystal startup.
 */
static int wait_until_ms(bool (*cond)(void), int64_t timeout_ms)
{
	int64_t deadline = k_uptime_get() + timeout_ms;

	while (k_uptime_get() < deadline) {
		if (cond()) {
			return 0;
		}
	}
	return -1;
}

/* Raw cycle-count spin: only for the brief window after irq_lock(), where
 * the kernel tick is frozen and time-based waits can't be used.
 */
static int spin_until(bool (*cond)(void))
{
	for (uint32_t i = 0; i < WAIT_SPINS; i++) {
		if (cond()) {
			return 0;
		}
	}
	return -1;
}

static bool lse_ready(void) { return LL_RCC_LSE_IsReady(); }
static bool hse_ready(void) { return LL_RCC_HSE_IsReady(); }
static bool rtc_init_active(void) { return LL_RTC_IsActiveFlag_INIT(RTC) != 0; }
static bool sysclk_is_hse(void)
{
	return LL_RCC_GetSysClkSource() == LL_RCC_SYS_CLKSOURCE_STATUS_HSE;
}

static uint32_t ssr_ticks_elapsed(uint32_t start_ssr, uint32_t cur_ssr)
{
	/* SSR counts DOWN from PREDIV_S (255) to 0, then reloads. */
	int32_t diff = (int32_t)start_ssr - (int32_t)cur_ssr;

	if (diff < 0) {
		diff += 256;
	}
	return (uint32_t)diff;
}

int main(void)
{
	/* Let normal Zephyr boot banner / earlier logging flush first. */
	k_sleep(K_MSEC(500));

	printk("\n=== HSE frequency probe (LSE-referenced, on-chip) ===\n");

	/* Unlock backup domain so we can touch RCC->BDCR / RTC. */
	LL_AHB3_GRP1_EnableClock(LL_AHB3_GRP1_PERIPH_PWR);
	LL_PWR_EnableBkUpAccess();

	printk("BDCR before domain reset: 0x%08x\n", (unsigned int)RCC->BDCR);

	/* RTCSEL is sticky once non-zero (HW forbids changing it without a
	 * backup domain reset). Prior firmware on this board (Arduino loader,
	 * earlier experiments) may have already claimed it for something
	 * other than LSE, which would silently leave RTC unclocked. Force a
	 * clean slate so LSE selection below is guaranteed to take.
	 */
	LL_RCC_ForceBackupDomainReset();
	LL_RCC_ReleaseBackupDomainReset();

	if (!LL_RCC_LSE_IsReady()) {
		printk("LSE not ready yet, enabling...\n");
		LL_RCC_LSE_Enable();
		if (wait_until_ms(lse_ready, 2000) != 0) {
			printk("ERROR: LSE failed to start within 2s; aborting probe\n");
			goto idle;
		}
	}
	printk("LSE ready (32768 Hz reference)\n");

	/* Route LSE to RTC and enable the RTC peripheral clock.
	 *
	 * BDCR.RTCEN only gates the internal RTCCLK (calendar counting
	 * clock). The register/bus interface needs a SEPARATE bus clock,
	 * RCC_APB3ENR.RTCAPBEN - without it every RTC register (ICSR, PRER,
	 * WPR, ...) silently reads/writes as 0, with no bus fault. Confirmed
	 * live via OpenOCD: ICSR was stuck at 0x00000000 regardless of BDCR
	 * state until RTCAPBEN was set, at which point it immediately showed
	 * live status bits.
	 */
	LL_APB3_GRP1_EnableClock(LL_APB3_GRP1_PERIPH_RTCAPB);
	LL_RCC_SetRTCClockSource(LL_RCC_RTC_CLKSOURCE_LSE);
	LL_RCC_EnableRTC();

	/* RTCEN crosses into the LSE (32768 Hz) clock domain; give it a
	 * couple of RTCCLK cycles (~1ms is generous) to actually start
	 * ticking before touching RTC registers.
	 */
	k_sleep(K_MSEC(5));
	printk("BDCR after RTC clock config: 0x%08x\n", (unsigned int)RCC->BDCR);

	/* Program prescalers for a 256 Hz subsecond tick: 32768/(127+1)=256,
	 * PREDIV_S=255 gives a 1 Hz calendar second from that 256 Hz tick.
	 */
	LL_RTC_DisableWriteProtection(RTC);
	LL_RTC_EnableInitMode(RTC);
	if (wait_until_ms(rtc_init_active, 200) != 0) {
		printk("ERROR: RTC init mode never entered within 200ms (ICSR=0x%08x); aborting probe\n",
		       (unsigned int)RTC->ICSR);
		LL_RTC_EnableWriteProtection(RTC);
		goto idle;
	}
	LL_RTC_SetAsynchPrescaler(RTC, 127);
	LL_RTC_SetSynchPrescaler(RTC, 255);
	LL_RTC_DisableInitMode(RTC);
	LL_RTC_EnableWriteProtection(RTC);

	/* Let the new prescaler settle for a few RTC ticks before trusting it. */
	k_sleep(K_MSEC(50));

	/* Enable the DWT cycle counter (tracks core clock cycles 1:1). */
	DCB->DEMCR |= DCB_DEMCR_TRCENA_Msk;
	DWT->CYCCNT = 0;
	DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;

	if (!LL_RCC_HSE_IsReady()) {
		printk("HSE not ready yet, enabling...\n");
		LL_RCC_HSE_Enable();
		if (wait_until_ms(hse_ready, 500) != 0) {
			printk("ERROR: HSE failed to start within 500ms; aborting probe\n");
			goto idle;
		}
	}
	printk("HSE oscillator ready (hardware), frequency unknown - measuring...\n");

	/* Switch SYSCLK directly to HSE, AHB prescaler /1, so HCLK == HSE
	 * exactly. Flash wait-states are already set for 160 MHz PLL1
	 * operation, which is MORE latency than a slower HSE clock needs,
	 * so this direction is safe without touching FLASH->ACR.
	 */
	unsigned int key = irq_lock();

	LL_RCC_SetAHBPrescaler(LL_RCC_SYSCLK_DIV_1);
	LL_RCC_SetSysClkSource(LL_RCC_SYS_CLKSOURCE_HSE);
	if (spin_until(sysclk_is_hse) != 0) {
		irq_unlock(key);
		printk("ERROR: SYSCLK never switched to HSE; aborting probe\n");
		goto idle;
	}

	/* Wait for a tick boundary, snapshot cycles, wait MEASURE_TICKS more
	 * boundaries, snapshot cycles again.
	 */
	uint32_t ssr_prev = LL_RTC_TIME_GetSubSecond(RTC);
	uint32_t ssr_now;

	do {
		ssr_now = LL_RTC_TIME_GetSubSecond(RTC);
	} while (ssr_now == ssr_prev);

	uint32_t cyc_start = DWT->CYCCNT;

	ssr_prev = ssr_now;
	uint32_t ticks = 0;

	while (ticks < MEASURE_TICKS) {
		ssr_now = LL_RTC_TIME_GetSubSecond(RTC);
		if (ssr_now != ssr_prev) {
			ticks += ssr_ticks_elapsed(ssr_prev, ssr_now);
			ssr_prev = ssr_now;
		}
	}

	uint32_t cyc_end = DWT->CYCCNT;

	irq_unlock(key);

	uint32_t elapsed_cycles = cyc_end - cyc_start;
	uint32_t window_us = (uint32_t)((uint64_t)ticks * 1000000ULL / RTC_TICK_HZ);
	uint64_t freq_hz = (uint64_t)elapsed_cycles * 1000000ULL / window_us;

	printk("RTC ticks counted: %u (window %u us)\n", ticks, window_us);
	printk("DWT cycles elapsed: %u\n", elapsed_cycles);
	printk("MEASURED HSE FREQUENCY: %llu Hz\n", freq_hz);

	if (freq_hz > 40000000ULL) {
		printk("=> closest to 48 MHz\n");
	} else if (freq_hz > 12000000ULL) {
		printk("=> closest to 16 MHz\n");
	} else {
		printk("=> unexpected value, does not match 16 or 48 MHz\n");
	}

idle:
	printk("=== probe done ===\n");
	for (;;) {
	}
	return 0;
}
