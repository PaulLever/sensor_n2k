#ifndef ALARM_IO_H_
#define ALARM_IO_H_

#include <stdint.h>

/*
 * Abstracted hardware I/O for the physical alarm buzzer/LED/cancel-button
 * path. v1 hardware is on/off only (no PWM) — see alarm_io_set_buzzer()'s
 * volume parameter, which is accepted and stored but currently a no-op,
 * kept so a future PWM buzzer driver is a drop-in change rather than an
 * API change.
 *
 * Pin assignments are placeholders. GPIOF (as originally planned) has no
 * devicetree node in Zephyr's STM32U5 support at all — confirmed against
 * both mainline zephyr/dts/arm/st/u5/stm32u5.dtsi (defines gpioa..e, g, h;
 * skips f) and the vendor HAL header (GPIOF_BASE_NS is a real register
 * block on this silicon, so the pins physically exist — Zephyr just never
 * added the node). Adding that node means patching a shared vendored SoC
 * dtsi file used by every STM32U5 board, not a board-local overlay change.
 * Used GPIOH instead: already enabled on this board
 * (arduino_uno_q.overlay's `&gpioh { status = "okay"; };`), and PH0-PH2 are
 * free (PH10-PH15 are the on-board status LEDs, PH0-PH9 aren't otherwise
 * claimed). Real wiring for buzzer/LED/button is unconfirmed either way —
 * update alarm_buzzer_gpios/alarm_led_gpios/alarm_button_gpios on the
 * zephyr_user node in the board overlay once it is (same convention
 * pulse_counter.c already uses for pc0_gpios/pc1_gpios).
 */

/** Configure buzzer output, warning LED output, cancel-button input (with
 *  debounced interrupt). Call once at boot, after gpio devices are ready. */
void alarm_io_init(void);

/** pattern: 0=off, 1=continuous (alarm tier), 2=repeat-beep (warning
 *  tier), 3=beep-burst (buzzer tier, ~3 beeps then auto-stop),
 *  4=bell (rapid strike, mimics a marine bell alarm).
 *  volume: accepted/stored, no-op in v1 (on/off buzzer only). */
void alarm_io_set_buzzer(uint8_t pattern, uint8_t volume);

/** state: 0=off, 1=on, 2=blink. */
void alarm_io_set_led(uint8_t state);

/** Silence buzzer and LED immediately. */
void alarm_io_stop_all(void);

#endif /* ALARM_IO_H_ */
