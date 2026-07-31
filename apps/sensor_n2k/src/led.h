#ifndef LED_H_
#define LED_H_

void init_leds(void);

/* LED 3 — blink */
void led3r_blink(int times);
void led3g_blink(int times);
void led3b_blink(int times);

/* LED 4 — blink */
void led4r_blink(int times);
void led4g_blink(int times);
void led4b_blink(int times);

/* LED 3 — set state (1=on, 0=off) */
void led3r_set(int on);
void led3g_set(int on);
void led3b_set(int on);

/* LED 4 — set state (1=on, 0=off) */
void led4r_set(int on);
void led4g_set(int on);
void led4b_set(int on);

#define LED3R_BLINK(n) led3r_blink(n)
#define LED3G_BLINK(n) led3g_blink(n)
#define LED3B_BLINK(n) led3b_blink(n)

#define LED4R_BLINK(n) led4r_blink(n)
#define LED4G_BLINK(n) led4g_blink(n)
#define LED4B_BLINK(n) led4b_blink(n)

#define LED3R_SET(v) led3r_set(v)
#define LED3G_SET(v) led3g_set(v)
#define LED3B_SET(v) led3b_set(v)

#define LED4R_SET(v) led4r_set(v)
#define LED4G_SET(v) led4g_set(v)
#define LED4B_SET(v) led4b_set(v)

#endif /* LED_H_ */
