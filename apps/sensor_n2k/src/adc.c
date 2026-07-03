#include "adc.h"
#include "sensor_config.h"
#include "n2k.h"
#include "spi_bridge.h"
#include "led.h"

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/can.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(adc_n2k, LOG_LEVEL_INF);

#define ADC_NODE        DT_NODELABEL(adc1)
#define ADC_CHANNEL_ID  9               /* PA4 / Arduino A0 */
#define ADC_RESOLUTION  14
#define ADC_MAX_RAW     ((1 << ADC_RESOLUTION) - 1)  /* 16383 */
#define KELVIN_OFFSET   273.15f

static const struct device *adc_dev = DEVICE_DT_GET(ADC_NODE);

static const struct adc_channel_cfg ch_cfg = {
    .gain             = ADC_GAIN_1,
    .reference        = ADC_REF_INTERNAL,
    .acquisition_time = ADC_ACQ_TIME_MAX,
    .channel_id       = ADC_CHANNEL_ID,
    .differential     = 0,
};

void adc_thread(void *unused0, void *unused1, void *unused2)
{
    ARG_UNUSED(unused0);
    ARG_UNUSED(unused1);
    ARG_UNUSED(unused2);

    int16_t sample_buf;
    int ret;

    struct adc_sequence seq = {
        .channels    = BIT(ADC_CHANNEL_ID),
        .buffer      = &sample_buf,
        .buffer_size = sizeof(sample_buf),
        .resolution  = ADC_RESOLUTION,
    };

    if (!device_is_ready(adc_dev)) {
        LOG_ERR("ADC not ready");
        return;
    }

    ret = adc_channel_setup(adc_dev, &ch_cfg);
    if (ret != 0) {
        LOG_ERR("ADC channel setup failed: %d", ret);
        return;
    }

    while (1) {
        const temp_sensor_cfg_t *cfg = &g_sensor_cfg.adc;
        uint32_t poll_ms = (cfg->poll_ms >= 100U) ? cfg->poll_ms : 1000U;

        if (!cfg->enabled) {
            k_sleep(K_MSEC(poll_ms));
            continue;
        }

        ret = adc_read(adc_dev, &seq);
        if (ret != 0) {
            LOG_WRN("ADC read error: %d", ret);
            k_sleep(K_MSEC(poll_ms));
            continue;
        }

        /* Linear map 14-bit raw → 0–1000 °C */
        float temp_c = (float)sample_buf * 1000.0f / (float)ADC_MAX_RAW;
        float temp_k = temp_c + KELVIN_OFFSET;

        /* Log without %f: print integer + fractional parts */
        int tc10 = (int)(temp_c * 10.0f + 0.5f);
        LOG_INF("ADC raw=%d  EGT=%d.%d C  src=%u inst=%u",
                sample_buf, tc10 / 10, tc10 % 10,
                cfg->n2k_source, cfg->n2k_instance);

        uint32_t raw = (uint32_t)(temp_k * 1000.0f);

        struct can_frame frame = {0};
        frame.id      = n2k_can_id(N2K_PGN_TEMP_EXT, N2K_PRIORITY, n2k_sa_get());
        frame.flags   = CAN_FRAME_IDE;
        frame.dlc     = 8;
        frame.data[0] = 0;
        frame.data[1] = cfg->n2k_instance;
        frame.data[2] = cfg->n2k_source;
        frame.data[3] = raw         & 0xFFU;
        frame.data[4] = (raw >>  8) & 0xFFU;
        frame.data[5] = (raw >> 16) & 0xFFU;
        frame.data[6] = 0xFFU;
        frame.data[7] = 0xFFU;

        LED4G_BLINK(1);

        ret = spi_bridge_enqueue(&frame);
        if (ret != 0) {
            LOG_WRN("SPI bridge TX full: %d", ret);
        }

        k_sleep(K_MSEC(poll_ms));
    }
}
