cmake_minimum_required(VERSION 3.20.0)

# -----------------------------------------------------------------------
# CAN controller selection
#   OFF (default) — STM32 FDCAN1 on PB8/PB9 (D9/D10)
#   ON            — CANADUINO MCP2515 CAN Bus Shield via Arduino SPI2
#                   (CS=D10/PB9, INT=D2/PB3, SCK/MISO/MOSI=D13-D11)
# -----------------------------------------------------------------------
set(USE_MCP2515_SHIELD ON)

if(USE_MCP2515_SHIELD)
  list(APPEND EXTRA_DTC_OVERLAY_FILE
    "${CMAKE_CURRENT_SOURCE_DIR}/boards/arduino_uno_q_mcp2515.overlay")
  list(APPEND EXTRA_CONF_FILE
    "${CMAKE_CURRENT_SOURCE_DIR}/prj_mcp2515.conf")
endif()

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})

project(sensor_n2k)

target_sources(app PRIVATE
    src/main.c
    src/spi_bridge.c
    src/adc.c
    src/onewire.c
    src/n2k.c
    src/led.c
)
