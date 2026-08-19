'use strict';

/**
 * MirAIe API Constants
 * Based on the miraie-ac Python library by rkzofficial
 */

// HTTP API
const HTTP_CLIENT_ID = 'PBcMcfG19njNCL8AOgvRzIC8AjQa';
const LOGIN_URL = 'https://auth.miraie.in/simplifi/v1/userManagement/login';
const HOMES_URL = 'https://app.miraie.in/simplifi/v1/homeManagement/homes';
const DEVICE_DETAILS_URL = 'https://app.miraie.in/simplifi/v1/deviceManagement/devices/deviceId';

// MQTT Broker
const MQTT_HOST = 'mqtt.miraie.in';
const MQTT_PORT = 8883;

// MQTT Base Payload
const MQTT_BASE_PAYLOAD = {
  ki: 1,
  cnt: 'an',
  sid: '1',
};

// HVAC Modes (acmd)
const HVAC_MODE = {
  COOL: 'cool',
  AUTO: 'auto',
  DRY: 'dry',
  FAN: 'fan',
  HEAT: 'heat',
};

// Fan Modes (acfs)
const FAN_MODE = {
  AUTO: 'auto',
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
  QUIET: 'quiet',
};

// Power Mode (ps)
const POWER_MODE = {
  ON: 'on',
  OFF: 'off',
};

// Swing Mode (acvs / achs)
const SWING_MODE = {
  AUTO: 0,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

// Display Mode (acdc)
const DISPLAY_MODE = {
  ON: 'on',
  OFF: 'off',
};

// Preset Mode
const PRESET_MODE = {
  NONE: 'none',
  ECO: 'eco',
  BOOST: 'boost',
  CLEAN: 'clean',
};

// Converti Mode (cnv)
const CONVERTI_MODE = {
  HC: 110,
  FC: 100,
  C90: 90,
  C80: 80,
  C70: 70,
  C55: 55,
  C40: 40,
  NS: 1,
  OFF: 0,
};

// Temperature limits
const MIN_TEMPERATURE = 16;
const MAX_TEMPERATURE = 30;
const TEMPERATURE_STEP = 0.5;

module.exports = {
  HTTP_CLIENT_ID,
  LOGIN_URL,
  HOMES_URL,
  DEVICE_DETAILS_URL,
  MQTT_HOST,
  MQTT_PORT,
  MQTT_BASE_PAYLOAD,
  HVAC_MODE,
  FAN_MODE,
  POWER_MODE,
  SWING_MODE,
  DISPLAY_MODE,
  PRESET_MODE,
  CONVERTI_MODE,
  MIN_TEMPERATURE,
  MAX_TEMPERATURE,
  TEMPERATURE_STEP,
};
