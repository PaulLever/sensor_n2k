#ifndef SENSOR_CONFIG_H_
#define SENSOR_CONFIG_H_

#include <stdbool.h>
#include <stdint.h>
#include "n2k.h"

/* ------------------------------------------------------------------ */
/* PGN selection for temperature / analogue sensors                    */
/*                                                                     */
/* Stored as uint8_t in each slot config. Determines which NMEA 2000  */
/* PGN the sensor publishes on both the physical bus and SPI bridge.   */
/* For ENGINE_DYN (127489, fast-packet): n2k_source selects the field  */
/*   0 = Oil Temperature  (payload bytes 3-4)                          */
/*   1 = Coolant/Engine Temperature (payload bytes 5-6)                */
/* n2k_instance is always the engine instance for 127489.              */
/* ------------------------------------------------------------------ */

#define N2K_PGNCFG_TEMP        0U  /* PGN 130312 – Temperature          */
#define N2K_PGNCFG_TEMP_EXT    1U  /* PGN 130316 – Temp Extended Range  */
#define N2K_PGNCFG_ENV_PARAMS  2U  /* PGN 130311 – Environmental Params */
#define N2K_PGNCFG_ENGINE_DYN  3U  /* PGN 127489 – Engine Params Dynamic (fast-packet) */
#define N2K_PGNCFG_TRANS_DYN   4U  /* PGN 127493 – Transmission Params Dynamic */

/* ------------------------------------------------------------------ */
/* 1-Wire multi-sensor config                                          */
/* ------------------------------------------------------------------ */

#define MAX_OW_SENSORS 4U

typedef struct {
    bool    enabled;
    uint8_t n2k_pgn_id;    /* N2K_PGNCFG_* */
    uint8_t n2k_source;    /* N2K_TSRC_* (or field selector for ENGINE_DYN) */
    uint8_t n2k_instance;  /* temperature instance / engine instance */
    bool    test_mode;     /* inject fixed value instead of reading sensor */
    float   test_value_c;  /* fixed temperature in °C used when test_mode=true */
} ow_slot_cfg_t;

typedef struct {
    uint16_t      poll_ms;
    ow_slot_cfg_t slot[MAX_OW_SENSORS];
} ow_cfg_t;

/* ------------------------------------------------------------------ */
/* Pulse-counter operating modes                                       */
/* ------------------------------------------------------------------ */

typedef enum {
    PC_MODE_STW = 0,  /* Speed Through Water — PGN 128259 */
    PC_MODE_RPM = 1,  /* Engine Speed (RPM)  — PGN 127488 */
} pc_mode_t;

/* ------------------------------------------------------------------ */
/* ADC config                                                          */
/* ------------------------------------------------------------------ */

typedef struct {
    bool     enabled;
    uint8_t  n2k_pgn_id;    /* N2K_PGNCFG_* */
    uint8_t  n2k_source;    /* N2K_TSRC_* (or field selector for ENGINE_DYN) */
    uint8_t  n2k_instance;
    uint16_t poll_ms;
    bool     test_mode;     /* inject fixed value instead of reading sensor */
    float    test_value_c;  /* fixed temperature in °C used when test_mode=true */
} temp_sensor_cfg_t;

/* ------------------------------------------------------------------ */
/* Pulse-counter config                                                */
/* ------------------------------------------------------------------ */

typedef struct {
    bool      enabled;
    pc_mode_t mode;
    float     hz_per_mps;
    float     pulses_per_rev;
    uint8_t   engine_instance;
    uint16_t  update_ms;
    uint8_t   avg_samples;
} pc_cfg_t;

/* ------------------------------------------------------------------ */
/* Top-level sensor config                                             */
/* ------------------------------------------------------------------ */

typedef struct {
    ow_cfg_t          onewire;
    temp_sensor_cfg_t adc;
    pc_cfg_t          pulse[2];
} sensor_cfg_t;

/* ------------------------------------------------------------------ */
/* Compile-time defaults                                               */
/* ------------------------------------------------------------------ */

#define CFG_DFLT_OW_POLL_MS      2000U

#define CFG_DFLT_OW0_ENABLED     true
#define CFG_DFLT_OW0_PGN_ID      N2K_PGNCFG_TEMP
#define CFG_DFLT_OW0_SOURCE      N2K_TSRC_INSIDE
#define CFG_DFLT_OW0_INSTANCE    1U
#define CFG_DFLT_OW0_TEST_EN     false
#define CFG_DFLT_OW0_TEST_VAL    20.0f

#define CFG_DFLT_OW1_ENABLED     false
#define CFG_DFLT_OW1_PGN_ID      N2K_PGNCFG_TEMP
#define CFG_DFLT_OW1_SOURCE      N2K_TSRC_INSIDE
#define CFG_DFLT_OW1_INSTANCE    2U
#define CFG_DFLT_OW1_TEST_EN     false
#define CFG_DFLT_OW1_TEST_VAL    20.0f

#define CFG_DFLT_OW2_ENABLED     false
#define CFG_DFLT_OW2_PGN_ID      N2K_PGNCFG_TEMP
#define CFG_DFLT_OW2_SOURCE      N2K_TSRC_INSIDE
#define CFG_DFLT_OW2_INSTANCE    3U
#define CFG_DFLT_OW2_TEST_EN     false
#define CFG_DFLT_OW2_TEST_VAL    20.0f

#define CFG_DFLT_OW3_ENABLED     false
#define CFG_DFLT_OW3_PGN_ID      N2K_PGNCFG_TEMP
#define CFG_DFLT_OW3_SOURCE      N2K_TSRC_INSIDE
#define CFG_DFLT_OW3_INSTANCE    4U
#define CFG_DFLT_OW3_TEST_EN     false
#define CFG_DFLT_OW3_TEST_VAL    20.0f

#define CFG_DFLT_ADC_ENABLED     true
#define CFG_DFLT_ADC_PGN_ID      N2K_PGNCFG_TEMP_EXT
#define CFG_DFLT_ADC_SOURCE      N2K_TSRC_EGT
#define CFG_DFLT_ADC_INSTANCE    0U
#define CFG_DFLT_ADC_POLL_MS     1000U
#define CFG_DFLT_ADC_TEST_EN     false
#define CFG_DFLT_ADC_TEST_VAL    20.0f

#define CFG_DFLT_PC0_ENABLED     false
#define CFG_DFLT_PC0_MODE        PC_MODE_STW
#define CFG_DFLT_PC0_HZ_PER_MPS  9.33f
#define CFG_DFLT_PC0_UPDATE_MS   1000U
#define CFG_DFLT_PC0_AVG         5U

#define CFG_DFLT_PC1_ENABLED     false
#define CFG_DFLT_PC1_MODE        PC_MODE_RPM
#define CFG_DFLT_PC1_PPR         1.0f
#define CFG_DFLT_PC1_ENG_INST    0U
#define CFG_DFLT_PC1_UPDATE_MS   500U
#define CFG_DFLT_PC1_AVG         3U

/* ------------------------------------------------------------------ */
/* Runtime config frame protocol (Linux → STM32 via SPI bridge)       */
/* ------------------------------------------------------------------ */

#define SENSOR_CFG_CAN_ID_BASE  0x1EFFFE00UL
#define SENSOR_CFG_CAN_ID_MASK  0x1FFFFF00UL

/* 1-Wire slot 0 */
#define CFG_PARAM_OW0_ENABLED    0x01U
#define CFG_PARAM_OW0_SOURCE     0x02U
#define CFG_PARAM_OW0_INSTANCE   0x03U
#define CFG_PARAM_OW_POLL_MS     0x04U
/* 1-Wire slot 1 */
#define CFG_PARAM_OW1_ENABLED    0x05U
#define CFG_PARAM_OW1_SOURCE     0x06U
#define CFG_PARAM_OW1_INSTANCE   0x07U
/* 1-Wire slot 2 */
#define CFG_PARAM_OW2_ENABLED    0x08U
#define CFG_PARAM_OW2_SOURCE     0x09U
#define CFG_PARAM_OW2_INSTANCE   0x0AU
/* 1-Wire slot 3 */
#define CFG_PARAM_OW3_ENABLED    0x0BU
#define CFG_PARAM_OW3_SOURCE     0x0CU
#define CFG_PARAM_OW3_INSTANCE   0x0DU
/* 1-Wire PGN selection (separate from source/instance) */
#define CFG_PARAM_OW0_PGN        0x0EU
#define CFG_PARAM_OW1_PGN        0x0FU
#define CFG_PARAM_OW2_PGN        0x10U
#define CFG_PARAM_OW3_PGN        0x1DU
/* ADC */
#define CFG_PARAM_ADC_ENABLED    0x11U
#define CFG_PARAM_ADC_SOURCE     0x12U
#define CFG_PARAM_ADC_INSTANCE   0x13U
#define CFG_PARAM_ADC_POLL_MS    0x14U
#define CFG_PARAM_ADC_PGN        0x15U
/* 1-Wire test mode (0x16-0x1C, 0x1E — avoids 0x1D=OW3_PGN) */
#define CFG_PARAM_OW0_TEST_EN    0x16U
#define CFG_PARAM_OW0_TEST_VAL   0x17U  /* float LE, °C */
#define CFG_PARAM_OW1_TEST_EN    0x18U
#define CFG_PARAM_OW1_TEST_VAL   0x19U
#define CFG_PARAM_OW2_TEST_EN    0x1AU
#define CFG_PARAM_OW2_TEST_VAL   0x1BU
#define CFG_PARAM_OW3_TEST_EN    0x1CU
#define CFG_PARAM_OW3_TEST_VAL   0x1EU
/* ADC test mode */
#define CFG_PARAM_ADC_TEST_EN    0x1FU
#define CFG_PARAM_ADC_TEST_VAL   0x20U  /* float LE, °C */
/* Pulse counter 0 */
#define CFG_PARAM_PC0_ENABLED    0x21U
#define CFG_PARAM_PC0_MODE       0x22U
#define CFG_PARAM_PC0_HZ_PER_MPS 0x23U
#define CFG_PARAM_PC0_PPR        0x24U
#define CFG_PARAM_PC0_ENG_INST   0x25U
#define CFG_PARAM_PC0_UPDATE_MS  0x26U
#define CFG_PARAM_PC0_AVG        0x27U
/* Pulse counter 1 */
#define CFG_PARAM_PC1_ENABLED    0x31U
#define CFG_PARAM_PC1_MODE       0x32U
#define CFG_PARAM_PC1_HZ_PER_MPS 0x33U
#define CFG_PARAM_PC1_PPR        0x34U
#define CFG_PARAM_PC1_ENG_INST   0x35U
#define CFG_PARAM_PC1_UPDATE_MS  0x36U
#define CFG_PARAM_PC1_AVG        0x37U
/* Persist */
#define CFG_PARAM_SAVE_NVS       0xFFU

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

extern sensor_cfg_t g_sensor_cfg;

void sensor_config_load(void);
void sensor_config_save(void);
void sensor_config_update(uint8_t param_id, const uint8_t *data, uint8_t len);

#endif /* SENSOR_CONFIG_H_ */
