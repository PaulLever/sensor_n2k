#ifndef SENSOR_CONFIG_H_
#define SENSOR_CONFIG_H_

#include <stdbool.h>
#include <stdint.h>
#include "n2k.h"

/* ------------------------------------------------------------------ */
/* 1-Wire multi-sensor config                                           */
/*                                                                      */
/* Up to MAX_OW_SENSORS DS18B20s on the shared PB4 bus.                */
/* Discovery order (ROM search) maps to slot index at boot.             */
/* ------------------------------------------------------------------ */

#define MAX_OW_SENSORS 4U

typedef struct {
    bool    enabled;
    uint8_t n2k_source;    /* N2K_TSRC_* temperature source code */
    uint8_t n2k_instance;
} ow_slot_cfg_t;

typedef struct {
    uint16_t      poll_ms;          /* shared cycle period for all slots */
    ow_slot_cfg_t slot[MAX_OW_SENSORS];
} ow_cfg_t;

/* ------------------------------------------------------------------ */
/* Pulse-counter operating modes                                        */
/* ------------------------------------------------------------------ */

typedef enum {
    PC_MODE_STW = 0,  /* Speed Through Water  — PGN 128259 */
    PC_MODE_RPM = 1,  /* Engine Speed (RPM)   — PGN 127488 */
} pc_mode_t;

/* ------------------------------------------------------------------ */
/* ADC / pulse-counter config (unchanged from previous version)        */
/* ------------------------------------------------------------------ */

typedef struct {
    bool     enabled;
    uint8_t  n2k_source;
    uint8_t  n2k_instance;
    uint16_t poll_ms;
} temp_sensor_cfg_t;

typedef struct {
    bool      enabled;
    pc_mode_t mode;
    float     hz_per_mps;       /* STW: Hz per m/s (default 9.33)         */
    float     pulses_per_rev;   /* RPM: pulses/revolution (default 1.0)   */
    uint8_t   engine_instance;  /* RPM: N2K engine instance (0 = port)    */
    uint16_t  update_ms;        /* publish interval: 500–2000 ms          */
    uint8_t   avg_samples;      /* running-average depth: 1–10            */
} pc_cfg_t;

/* ------------------------------------------------------------------ */
/* Top-level sensor config                                              */
/* ------------------------------------------------------------------ */

typedef struct {
    ow_cfg_t          onewire;   /* 1-Wire: up to 4 DS18B20 slots          */
    temp_sensor_cfg_t adc;       /* ADC A0: EGT / analogue temp            */
    pc_cfg_t          pulse[2];  /* D3/PB0 = PC0,  D6/PB1 = PC1           */
} sensor_cfg_t;

/* ------------------------------------------------------------------ */
/* Compile-time defaults  (edit here to change factory values)         */
/* ------------------------------------------------------------------ */

#define CFG_DFLT_OW_POLL_MS      2000U

/* Slot 0 — first DS18B20 found on bus */
#define CFG_DFLT_OW0_ENABLED     true
#define CFG_DFLT_OW0_SOURCE      N2K_TSRC_INSIDE   /* 2 */
#define CFG_DFLT_OW0_INSTANCE    1U

/* Slots 1-3 — additional sensors, disabled by default */
#define CFG_DFLT_OW1_ENABLED     false
#define CFG_DFLT_OW1_SOURCE      N2K_TSRC_INSIDE
#define CFG_DFLT_OW1_INSTANCE    2U

#define CFG_DFLT_OW2_ENABLED     false
#define CFG_DFLT_OW2_SOURCE      N2K_TSRC_INSIDE
#define CFG_DFLT_OW2_INSTANCE    3U

#define CFG_DFLT_OW3_ENABLED     false
#define CFG_DFLT_OW3_SOURCE      N2K_TSRC_INSIDE
#define CFG_DFLT_OW3_INSTANCE    4U

#define CFG_DFLT_ADC_ENABLED     true
#define CFG_DFLT_ADC_SOURCE      N2K_TSRC_EGT      /* 14 */
#define CFG_DFLT_ADC_INSTANCE    0U
#define CFG_DFLT_ADC_POLL_MS     1000U

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
/* Runtime config frame protocol (Linux → STM32 via SPI bridge)        */
/*                                                                      */
/* CAN ID = SENSOR_CFG_CAN_ID_BASE | param_id.                         */
/* spi_bridge.c intercepts these; they never reach the N2K bus.        */
/* ------------------------------------------------------------------ */

#define SENSOR_CFG_CAN_ID_BASE  0x1EFFFE00UL
#define SENSOR_CFG_CAN_ID_MASK  0x1FFFFF00UL

/* 1-Wire: slot 0 (params 0x01-0x04 unchanged for back-compat) */
#define CFG_PARAM_OW0_ENABLED    0x01U  /* data[0]: 0/1                */
#define CFG_PARAM_OW0_SOURCE     0x02U  /* data[0]: N2K_TSRC_*        */
#define CFG_PARAM_OW0_INSTANCE   0x03U  /* data[0]                     */
#define CFG_PARAM_OW_POLL_MS     0x04U  /* data[0:1] LE uint16 (shared) */
/* 1-Wire: slots 1-3 */
#define CFG_PARAM_OW1_ENABLED    0x05U
#define CFG_PARAM_OW1_SOURCE     0x06U
#define CFG_PARAM_OW1_INSTANCE   0x07U
#define CFG_PARAM_OW2_ENABLED    0x08U
#define CFG_PARAM_OW2_SOURCE     0x09U
#define CFG_PARAM_OW2_INSTANCE   0x0AU
#define CFG_PARAM_OW3_ENABLED    0x0BU
#define CFG_PARAM_OW3_SOURCE     0x0CU
#define CFG_PARAM_OW3_INSTANCE   0x0DU
/* ADC */
#define CFG_PARAM_ADC_ENABLED    0x11U
#define CFG_PARAM_ADC_SOURCE     0x12U
#define CFG_PARAM_ADC_INSTANCE   0x13U
#define CFG_PARAM_ADC_POLL_MS    0x14U
/* Pulse counter 0 */
#define CFG_PARAM_PC0_ENABLED    0x21U
#define CFG_PARAM_PC0_MODE       0x22U
#define CFG_PARAM_PC0_HZ_PER_MPS 0x23U  /* data[0:3] LE float32        */
#define CFG_PARAM_PC0_PPR        0x24U  /* data[0:3] LE float32        */
#define CFG_PARAM_PC0_ENG_INST   0x25U
#define CFG_PARAM_PC0_UPDATE_MS  0x26U  /* data[0:1] LE uint16         */
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
/* API                                                                  */
/* ------------------------------------------------------------------ */

extern sensor_cfg_t g_sensor_cfg;

void sensor_config_load(void);
void sensor_config_save(void);
void sensor_config_update(uint8_t param_id, const uint8_t *data, uint8_t len);

#endif /* SENSOR_CONFIG_H_ */
