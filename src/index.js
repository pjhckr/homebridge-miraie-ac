'use strict';

const MirAIePlatform = require('./platform');

const PLUGIN_NAME = 'homebridge-miraie-ac';
const PLATFORM_NAME = 'MirAIeAC';

module.exports = (api) => {
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, MirAIePlatform);
};
