#include "led.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>

static const struct gpio_dt_spec led3r = GPIO_DT_SPEC_GET(DT_NODELABEL(led3_red),   gpios);
static const struct gpio_dt_spec led3g = GPIO_DT_SPEC_GET(DT_NODELABEL(led3_green), gpios);
static const struct gpio_dt_spec led3b = GPIO_DT_SPEC_GET(DT_NODELABEL(led3_blue),  gpios);
static const struct gpio_dt_spec led4r = GPIO_DT_SPEC_GET(DT_NODELABEL(led4_red),   gpios);
static const struct gpio_dt_spec led4g = GPIO_DT_SPEC_GET(DT_NODELABEL(led4_green), gpios);
static const struct gpio_dt_spec led4b = GPIO_DT_SPEC_GET(DT_NODELABEL(led4_blue),  gpios);

void init_leds(void)
{
	gpio_pin_configure_dt(&led3r, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led3g, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led3b, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led4r, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led4g, GPIO_OUTPUT_INACTIVE);
	gpio_pin_configure_dt(&led4b, GPIO_OUTPUT_INACTIVE);
}

static void do_blink(const struct gpio_dt_spec *led, int times)
{
	for (int i = 0; i < times; i++) {
		gpio_pin_set_dt(led, 1);
		k_sleep(K_MSEC(50));
		gpio_pin_set_dt(led, 0);
		k_sleep(K_MSEC(50));
	}
}

void led3r_blink(int times) { do_blink(&led3r, times); }
void led3g_blink(int times) { do_blink(&led3g, times); }
void led3b_blink(int times) { do_blink(&led3b, times); }
void led4r_blink(int times) { do_blink(&led4r, times); }
void led4g_blink(int times) { do_blink(&led4g, times); }
void led4b_blink(int times) { do_blink(&led4b, times); }

void led3r_set(int on) { gpio_pin_set_dt(&led3r, on); }
void led3g_set(int on) { gpio_pin_set_dt(&led3g, on); }
void led3b_set(int on) { gpio_pin_set_dt(&led3b, on); }
void led4r_set(int on) { gpio_pin_set_dt(&led4r, on); }
void led4g_set(int on) { gpio_pin_set_dt(&led4g, on); }
void led4b_set(int on) { gpio_pin_set_dt(&led4b, on); }
