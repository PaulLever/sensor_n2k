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

        float temp_c;
        if (cfg->test_mode) {
            temp_c = cfg->test_value_c;
            int tc10 = (int)(temp_c * 10.0f + 0.5f);
            LOG_INF("ADC TEST val=%d.%d C  pgn=%u src=%u inst=%u",
                    tc10 / 10, tc10 % 10,
                    cfg->n2k_pgn_id, cfg->n2k_source, cfg->n2k_instance);
        } else {
            ret = adc_read(adc_dev, &seq);
            if (ret != 0) {
                LOG_WRN("ADC read error: %d", ret);
                k_sleep(K_MSEC(poll_ms));
                continue;
            }
            /* Linear map 14-bit raw → 0–1000 °C */
            temp_c = (float)sample_buf * 1000.0f / (float)ADC_MAX_RAW;
            int tc10 = (int)(temp_c * 10.0f + 0.5f);
            LOG_INF("ADC raw=%d  %d.%d C  pgn=%u src=%u inst=%u",
                    sample_buf, tc10 / 10, tc10 % 10,
                    cfg->n2k_pgn_id, cfg->n2k_source, cfg->n2k_instance);
        }
        float temp_k = temp_c + KELVIN_OFFSET;

        struct can_frame frames[N2K_TEMP_MAX_FRAMES];
        int nframes = n2k_build_temp_frames(cfg->n2k_pgn_id,
                                            cfg->n2k_instance,
                                            cfg->n2k_source,
                                            temp_k, frames);
        LED4G_BLINK(1);
        for (int fi = 0; fi < nframes; fi++) {
            ret = n2k_send_frame(&frames[fi]);
            if (ret != 0) {
                LOG_WRN("ADC: FDCAN TX failed (%d)", ret);
            }
            ret = spi_bridge_enqueue(&frames[fi]);
            if (ret != 0) {
                LOG_WRN("ADC: SPI bridge TX full (%d)", ret);
            }
        }

        k_sleep(K_MSEC(poll_ms));
    }
}
