#include "sensor_config.h"

#include <string.h>
#include <zephyr/settings/settings.h>
#include <zephyr/logging/log.h>

LOG_MODULE_REGISTER(sensor_cfg, LOG_LEVEL_INF);

sensor_cfg_t g_sensor_cfg;

static const sensor_cfg_t g_defaults = {
    .onewire = {
        .poll_ms = CFG_DFLT_OW_POLL_MS,
        .slot = {
            [0] = { .enabled = CFG_DFLT_OW0_ENABLED, .n2k_pgn_id = CFG_DFLT_OW0_PGN_ID, .n2k_source = CFG_DFLT_OW0_SOURCE, .n2k_instance = CFG_DFLT_OW0_INSTANCE, .test_mode = CFG_DFLT_OW0_TEST_EN, .test_value_c = CFG_DFLT_OW0_TEST_VAL },
            [1] = { .enabled = CFG_DFLT_OW1_ENABLED, .n2k_pgn_id = CFG_DFLT_OW1_PGN_ID, .n2k_source = CFG_DFLT_OW1_SOURCE, .n2k_instance = CFG_DFLT_OW1_INSTANCE, .test_mode = CFG_DFLT_OW1_TEST_EN, .test_value_c = CFG_DFLT_OW1_TEST_VAL },
            [2] = { .enabled = CFG_DFLT_OW2_ENABLED, .n2k_pgn_id = CFG_DFLT_OW2_PGN_ID, .n2k_source = CFG_DFLT_OW2_SOURCE, .n2k_instance = CFG_DFLT_OW2_INSTANCE, .test_mode = CFG_DFLT_OW2_TEST_EN, .test_value_c = CFG_DFLT_OW2_TEST_VAL },
            [3] = { .enabled = CFG_DFLT_OW3_ENABLED, .n2k_pgn_id = CFG_DFLT_OW3_PGN_ID, .n2k_source = CFG_DFLT_OW3_SOURCE, .n2k_instance = CFG_DFLT_OW3_INSTANCE, .test_mode = CFG_DFLT_OW3_TEST_EN, .test_value_c = CFG_DFLT_OW3_TEST_VAL },
        },
    },
    .adc = {
        .enabled      = CFG_DFLT_ADC_ENABLED,
        .n2k_pgn_id   = CFG_DFLT_ADC_PGN_ID,
        .n2k_source   = CFG_DFLT_ADC_SOURCE,
        .n2k_instance = CFG_DFLT_ADC_INSTANCE,
        .poll_ms      = CFG_DFLT_ADC_POLL_MS,
        .test_mode    = CFG_DFLT_ADC_TEST_EN,
        .test_value_c = CFG_DFLT_ADC_TEST_VAL,
    },
    .pulse = {
        [0] = {
            .enabled         = CFG_DFLT_PC0_ENABLED,
            .mode            = CFG_DFLT_PC0_MODE,
            .hz_per_mps      = CFG_DFLT_PC0_HZ_PER_MPS,
            .pulses_per_rev  = 1.0f,
            .engine_instance = 0,
            .update_ms       = CFG_DFLT_PC0_UPDATE_MS,
            .avg_samples     = CFG_DFLT_PC0_AVG,
        },
        [1] = {
            .enabled         = CFG_DFLT_PC1_ENABLED,
            .mode            = CFG_DFLT_PC1_MODE,
            .hz_per_mps      = 9.33f,
            .pulses_per_rev  = CFG_DFLT_PC1_PPR,
            .engine_instance = CFG_DFLT_PC1_ENG_INST,
            .update_ms       = CFG_DFLT_PC1_UPDATE_MS,
            .avg_samples     = CFG_DFLT_PC1_AVG,
        },
    },
};

/* Version 4: added test_mode and test_value_c to ow_slot_cfg_t and temp_sensor_cfg_t */
#define SCFG_NVS_KEY  "scfg/blob"
#define SCFG_VERSION  4U

typedef struct {
    uint8_t      version;
    sensor_cfg_t cfg;
} scfg_nvs_t;

static int scfg_set(const char *key, size_t len,
                    settings_read_cb read_cb, void *cb_arg)
{
    if (strcmp(key, "blob") != 0) {
        return -ENOENT;
    }

    scfg_nvs_t stored;

    if (len != sizeof(stored)) {
        LOG_WRN("sensor_cfg: NVS size mismatch (%zu vs %zu) — using defaults",
                len, sizeof(stored));
        return -EINVAL;
    }

    ssize_t rc = read_cb(cb_arg, &stored, sizeof(stored));
    if (rc < 0) {
        return (int)rc;
    }

    if (stored.version != SCFG_VERSION) {
        LOG_WRN("sensor_cfg: NVS version %u ≠ %u — using defaults",
                stored.version, SCFG_VERSION);
        return -EINVAL;
    }

    g_sensor_cfg = stored.cfg;
    LOG_INF("sensor_cfg: loaded from NVS");
    return 0;
}

static struct settings_handler scfg_handler = {
    .name  = "scfg",
    .h_set = scfg_set,
};

void sensor_config_load(void)
{
    g_sensor_cfg = g_defaults;

    int rc = settings_subsys_init();
    if (rc != 0) {
        LOG_ERR("settings_subsys_init: %d — using defaults", rc);
        return;
    }

    rc = settings_register(&scfg_handler);
    if (rc != 0) {
        LOG_ERR("settings_register: %d", rc);
        return;
    }

    settings_load_subtree("scfg");
}

void sensor_config_save(void)
{
    scfg_nvs_t stored = {
        .version = SCFG_VERSION,
        .cfg     = g_sensor_cfg,
    };
    int rc = settings_save_one(SCFG_NVS_KEY, &stored, sizeof(stored));
    if (rc != 0) {
        LOG_ERR("sensor_cfg: save failed: %d", rc);
    } else {
        LOG_INF("sensor_cfg: saved to NVS");
    }
}

static inline float bytes_to_float_le(const uint8_t *b)
{
    union { uint32_t u; float f; } v;
    v.u = (uint32_t)b[0] | ((uint32_t)b[1] << 8) |
          ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
    return v.f;
}

static inline uint16_t bytes_to_u16_le(const uint8_t *b)
{
    return (uint16_t)(b[0] | ((uint16_t)b[1] << 8));
}

void sensor_config_update(uint8_t param_id, const uint8_t *d, uint8_t len)
{
    if (len < 1) {
        return;
    }

    switch (param_id) {
    /* 1-Wire slot 0 */
    case CFG_PARAM_OW0_ENABLED:  g_sensor_cfg.onewire.slot[0].enabled      = (d[0] != 0); break;
    case CFG_PARAM_OW0_SOURCE:   g_sensor_cfg.onewire.slot[0].n2k_source   = d[0];        break;
    case CFG_PARAM_OW0_INSTANCE: g_sensor_cfg.onewire.slot[0].n2k_instance = d[0];        break;
    case CFG_PARAM_OW0_PGN:      g_sensor_cfg.onewire.slot[0].n2k_pgn_id   = d[0];        break;
    case CFG_PARAM_OW0_TEST_EN:  g_sensor_cfg.onewire.slot[0].test_mode    = (d[0] != 0); break;
    case CFG_PARAM_OW0_TEST_VAL:
        if (len >= 4) { g_sensor_cfg.onewire.slot[0].test_value_c = bytes_to_float_le(d); }
        break;
    case CFG_PARAM_OW_POLL_MS:
        if (len >= 2) { g_sensor_cfg.onewire.poll_ms = bytes_to_u16_le(d); }
        break;
    /* 1-Wire slot 1 */
    case CFG_PARAM_OW1_ENABLED:  g_sensor_cfg.onewire.slot[1].enabled      = (d[0] != 0); break;
    case CFG_PARAM_OW1_SOURCE:   g_sensor_cfg.onewire.slot[1].n2k_source   = d[0];        break;
    case CFG_PARAM_OW1_INSTANCE: g_sensor_cfg.onewire.slot[1].n2k_instance = d[0];        break;
    case CFG_PARAM_OW1_PGN:      g_sensor_cfg.onewire.slot[1].n2k_pgn_id   = d[0];        break;
    case CFG_PARAM_OW1_TEST_EN:  g_sensor_cfg.onewire.slot[1].test_mode    = (d[0] != 0); break;
    case CFG_PARAM_OW1_TEST_VAL:
        if (len >= 4) { g_sensor_cfg.onewire.slot[1].test_value_c = bytes_to_float_le(d); }
        break;
    /* 1-Wire slot 2 */
    case CFG_PARAM_OW2_ENABLED:  g_sensor_cfg.onewire.slot[2].enabled      = (d[0] != 0); break;
    case CFG_PARAM_OW2_SOURCE:   g_sensor_cfg.onewire.slot[2].n2k_source   = d[0];        break;
    case CFG_PARAM_OW2_INSTANCE: g_sensor_cfg.onewire.slot[2].n2k_instance = d[0];        break;
    case CFG_PARAM_OW2_PGN:      g_sensor_cfg.onewire.slot[2].n2k_pgn_id   = d[0];        break;
    case CFG_PARAM_OW2_TEST_EN:  g_sensor_cfg.onewire.slot[2].test_mode    = (d[0] != 0); break;
    case CFG_PARAM_OW2_TEST_VAL:
        if (len >= 4) { g_sensor_cfg.onewire.slot[2].test_value_c = bytes_to_float_le(d); }
        break;
    /* 1-Wire slot 3 */
    case CFG_PARAM_OW3_ENABLED:  g_sensor_cfg.onewire.slot[3].enabled      = (d[0] != 0); break;
    case CFG_PARAM_OW3_SOURCE:   g_sensor_cfg.onewire.slot[3].n2k_source   = d[0];        break;
    case CFG_PARAM_OW3_INSTANCE: g_sensor_cfg.onewire.slot[3].n2k_instance = d[0];        break;
    case CFG_PARAM_OW3_PGN:      g_sensor_cfg.onewire.slot[3].n2k_pgn_id   = d[0];        break;
    case CFG_PARAM_OW3_TEST_EN:  g_sensor_cfg.onewire.slot[3].test_mode    = (d[0] != 0); break;
    case CFG_PARAM_OW3_TEST_VAL:
        if (len >= 4) { g_sensor_cfg.onewire.slot[3].test_value_c = bytes_to_float_le(d); }
        break;
    /* ADC */
    case CFG_PARAM_ADC_ENABLED:  g_sensor_cfg.adc.enabled      = (d[0] != 0); break;
    case CFG_PARAM_ADC_SOURCE:   g_sensor_cfg.adc.n2k_source   = d[0];        break;
    case CFG_PARAM_ADC_INSTANCE: g_sensor_cfg.adc.n2k_instance = d[0];        break;
    case CFG_PARAM_ADC_PGN:      g_sensor_cfg.adc.n2k_pgn_id   = d[0];        break;
    case CFG_PARAM_ADC_POLL_MS:
        if (len >= 2) { g_sensor_cfg.adc.poll_ms = bytes_to_u16_le(d); }
        break;
    case CFG_PARAM_ADC_TEST_EN:  g_sensor_cfg.adc.test_mode    = (d[0] != 0); break;
    case CFG_PARAM_ADC_TEST_VAL:
        if (len >= 4) { g_sensor_cfg.adc.test_value_c = bytes_to_float_le(d); }
        break;
    /* Pulse counter 0 */
    case CFG_PARAM_PC0_ENABLED:
        if (d[0] && !g_sensor_cfg.pulse[0].enabled) {
            extern void pulse_counter_reset(uint8_t idx);
            pulse_counter_reset(0);
        }
        g_sensor_cfg.pulse[0].enabled = (d[0] != 0);
        break;
    case CFG_PARAM_PC0_MODE:     g_sensor_cfg.pulse[0].mode            = (pc_mode_t)d[0]; break;
    case CFG_PARAM_PC0_HZ_PER_MPS:
        if (len >= 4) { g_sensor_cfg.pulse[0].hz_per_mps = bytes_to_float_le(d); }
        break;
    case CFG_PARAM_PC0_PPR:
        if (len >= 4) { g_sensor_cfg.pulse[0].pulses_per_rev = bytes_to_float_le(d); }
        break;
    case CFG_PARAM_PC0_ENG_INST: g_sensor_cfg.pulse[0].engine_instance = d[0]; break;
    case CFG_PARAM_PC0_UPDATE_MS:
        if (len >= 2) { g_sensor_cfg.pulse[0].update_ms = bytes_to_u16_le(d); }
        break;
    case CFG_PARAM_PC0_AVG:      g_sensor_cfg.pulse[0].avg_samples = d[0]; break;
    /* Pulse counter 1 */
    case CFG_PARAM_PC1_ENABLED:
        if (d[0] && !g_sensor_cfg.pulse[1].enabled) {
            extern void pulse_counter_reset(uint8_t idx);
            pulse_counter_reset(1);
        }
        g_sensor_cfg.pulse[1].enabled = (d[0] != 0);
        break;
    case CFG_PARAM_PC1_MODE:     g_sensor_cfg.pulse[1].mode            = (pc_mode_t)d[0]; break;
    case CFG_PARAM_PC1_HZ_PER_MPS:
        if (len >= 4) { g_sensor_cfg.pulse[1].hz_per_mps = bytes_to_float_le(d); }
        break;
    case CFG_PARAM_PC1_PPR:
        if (len >= 4) { g_sensor_cfg.pulse[1].pulses_per_rev = bytes_to_float_le(d); }
        break;
    case CFG_PARAM_PC1_ENG_INST: g_sensor_cfg.pulse[1].engine_instance = d[0]; break;
    case CFG_PARAM_PC1_UPDATE_MS:
        if (len >= 2) { g_sensor_cfg.pulse[1].update_ms = bytes_to_u16_le(d); }
        break;
    case CFG_PARAM_PC1_AVG:      g_sensor_cfg.pulse[1].avg_samples = d[0]; break;
    /* Persist */
    case CFG_PARAM_SAVE_NVS:     sensor_config_save(); break;
    default: break;
    }
}
