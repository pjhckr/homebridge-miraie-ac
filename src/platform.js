'use strict';

const MirAIeAPI = require('./api');
const MirAIeBroker = require('./broker');
const MirAIeAccessory = require('./accessory');

const PLUGIN_NAME = 'homebridge-miraie-ac';
const PLATFORM_NAME = 'MirAIeAC';

/**
 * MirAIe AC Platform Plugin for Homebridge
 */
class MirAIePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = new Map();
    this.mirAIeAccessories = new Map();
    this.mirAIeAPI = new MirAIeAPI(log, api.user.storagePath());
    this.broker = new MirAIeBroker(log);

    if (!config) {
      this.log.warn('No configuration found');
      return;
    }

    this.username = config.username;
    this.password = config.password;

    if (!this.username || !this.password) {
      this.log.error('username and password required');
      return;
    }

    this.api.on('didFinishLaunching', () => {
      this.log.info('MirAIeAC platform finished launching');
      this._initialize();
    });
  }

  async _initialize() {
    try {
      // Step 1: Get valid token (uses cache, only authenticates if expired)
      this.log.info('Obtaining authentication token...');
      await this.mirAIeAPI.getValidToken(this.username, this.password);

      // Step 2: Get devices — from Homebridge cache if available, otherwise discover via HTTP
      const { homeId, devices } = await this._getDevices();
      this.homeId = homeId;
      this.devices = devices;
      this.log.info(`${devices.length} AC unit(s) configured`);

      // Step 3: Register/update accessories
      this._configureAccessories(devices);

      // Step 4: Connect to MQTT — real-time status delivered via subscription
      const allTopics = [];
      for (const device of devices) {
        allTopics.push(device.statusTopic);
        allTopics.push(device.connectionStatusTopic);
      }

      await this.broker.connect(
        homeId,
        this.mirAIeAPI.accessToken,
        allTopics,
        async () => {
          // On MQTT reconnect, re-authenticate if needed
          await this.mirAIeAPI.getValidToken(this.username, this.password);
          return this.mirAIeAPI.accessToken;
        },
      );

      // Step 5: Update platform accessories after all services are configured
      const updatedAccessories = [];
      for (const device of devices) {
        const uuid = this.api.hap.uuid.generate(device.id);
        const accessory = this.accessories.get(uuid);
        if (accessory) {
          updatedAccessories.push(accessory);
        }
      }
      if (updatedAccessories.length > 0) {
        this.api.updatePlatformAccessories(updatedAccessories);
      }

      this.log.info('MirAIeAC platform initialization complete!');
    } catch (error) {
      this.log.error('Failed to initialize MirAIeAC platform:', error.message);
      this.log.error('Stack:', error.stack);
      this.log.info('Retrying initialization in 60 seconds...');
      setTimeout(() => this._initialize(), 60000);
    }
  }

  async _getDevices() {
    // Try to use cached device info from Homebridge's accessory cache
    if (this.accessories.size > 0) {
      const devices = [];
      let homeId = this.mirAIeAPI.homeId; // From token cache

      for (const accessory of this.accessories.values()) {
        if (accessory.context.device) {
          devices.push(accessory.context.device);
          if (!homeId && accessory.context.homeId) {
            homeId = accessory.context.homeId;
          }
        }
      }

      if (devices.length > 0 && homeId) {
        this.log.info('Using cached device info from Homebridge');
        return { homeId, devices };
      }
    }

    // No usable cache — discover via HTTP (first launch or cache cleared)
    this.log.info('Discovering devices from MirAIe cloud...');
    return await this.mirAIeAPI.discoverDevices();
  }

  _configureAccessories(devices) {
    const discoveredUUIDs = new Set();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.id);
      discoveredUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (accessory) {
        // Existing accessory — update it
        this.log.info(`Restoring cached accessory: ${device.friendlyName}`);
        accessory.context.device = device;
        accessory.context.homeId = this.homeId;
        const handler = new MirAIeAccessory(this, accessory, device);
        this.mirAIeAccessories.set(device.id, handler);
      } else {
        // New accessory
        this.log.info(`Adding new accessory: ${device.friendlyName}`);
        accessory = new this.api.platformAccessory(
          device.friendlyName,
          uuid,
        );

        accessory.context.device = device;
        accessory.context.homeId = this.homeId;

        const handler = new MirAIeAccessory(this, accessory, device);
        this.mirAIeAccessories.set(device.id, handler);
        this.accessories.set(uuid, accessory);

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }

    // Remove accessories that are no longer discovered
    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredUUIDs.has(uuid)) {
        this.log.info(`Removing stale accessory: ${accessory.displayName}`);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
  }

  configureAccessory(accessory) {
    this.log.info(`Restoring from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }
}

module.exports = MirAIePlatform;
