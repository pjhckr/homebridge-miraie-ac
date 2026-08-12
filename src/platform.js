'use strict';

const MirAIeAPI = require('./api');
const MirAIeBroker = require('./broker');
const MirAIeAccessory = require('./accessory');

const PLUGIN_NAME = 'homebridge-miraie-ac';
const PLATFORM_NAME = 'MirAIeAC';

/**
 * MirAIe AC Platform
 *
 * This is a dynamic platform plugin. It discovers all AC units
 * on the user's MirAIe account and creates a single accessory
 * per AC — all controls (power, mode, temperature, fan, swing,
 * display, eco, boost) live under that one accessory.
 */
class MirAIePlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    // Cached accessories from Homebridge
    this.accessories = new Map();

    // Active MirAIe accessory handlers
    this.mirAIeAccessories = new Map();

    // API and MQTT clients
    this.mirAIeAPI = new MirAIeAPI(log);
    this.broker = new MirAIeBroker(log);

    if (!config) {
      this.log.warn('No configuration found for MirAIeAC platform');
      return;
    }

    this.username = config.username;
    this.password = config.password;
    this.pollingInterval = (config.pollingInterval || 300) * 1000; // Default: 5 min

    if (!this.username || !this.password) {
      this.log.error('MirAIeAC: username and password are required');
      return;
    }

    // Wait for Homebridge to finish launching before initializing
    this.api.on('didFinishLaunching', () => {
      this.log.info('MirAIeAC platform finished launching');
      this._initialize();
    });
  }

  /**
   * Initialize the platform: authenticate, discover, connect MQTT
   */
  async _initialize() {
    try {
      // Step 1: Authenticate
      this.log.info('Authenticating with MirAIe cloud...');
      await this.mirAIeAPI.authenticate(this.username, this.password);

      // Step 2: Discover devices
      this.log.info('Discovering devices...');
      const { homeId, devices } = await this.mirAIeAPI.discoverDevices();
      this.homeId = homeId;
      this.devices = devices;

      this.log.info(`Found ${devices.length} AC unit(s)`);

      // Step 3: Register/update accessories
      this._configureAccessories(devices);

      // Step 4: Get initial status for all devices
      const statuses = await this.mirAIeAPI.getAllDeviceStatuses(devices);

      // Step 5: Connect to MQTT broker
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
          // Token refresh callback
          await this.mirAIeAPI.authenticate(this.username, this.password);
          return this.mirAIeAPI.accessToken;
        },
      );

      // Step 6: Initialize accessories with current status
      for (const { deviceId, status } of statuses) {
        const handler = this.mirAIeAccessories.get(deviceId);
        if (handler && status) {
          handler.initializeFromStatus(status);
        }
      }

      // Step 7: Set up periodic status polling as fallback
      this._startPolling();

      this.log.info('MirAIeAC platform initialization complete!');
    } catch (error) {
      this.log.error('Failed to initialize MirAIeAC platform:', error.message);
      this.log.error('Stack:', error.stack);

      // Retry after 60 seconds
      this.log.info('Retrying initialization in 60 seconds...');
      setTimeout(() => this._initialize(), 60000);
    }
  }

  /**
   * Configure accessories for discovered devices
   */
  _configureAccessories(devices) {
    const discoveredUUIDs = new Set();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.id);
      discoveredUUIDs.add(uuid);

      let accessory = this.accessories.get(uuid);

      if (accessory) {
        // Existing accessory — update it
        this.log.info(`Restoring cached accessory: ${device.friendlyName}`);
        const handler = new MirAIeAccessory(this, accessory, device);
        this.mirAIeAccessories.set(device.id, handler);
        this.api.updatePlatformAccessories([accessory]);
      } else {
        // New accessory
        this.log.info(`Adding new accessory: ${device.friendlyName}`);
        accessory = new this.api.platformAccessory(
          device.friendlyName,
          uuid,
        );

        // Store device info in the accessory context for restoration
        accessory.context.device = device;

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

  /**
   * Called by Homebridge when restoring cached accessories
   */
  configureAccessory(accessory) {
    this.log.info(`Restoring from cache: ${accessory.displayName}`);
    this.accessories.set(accessory.UUID, accessory);
  }

  /**
   * Start periodic polling for device status (fallback for missed MQTT messages)
   */
  _startPolling() {
    if (this._pollingTimer) {
      clearInterval(this._pollingTimer);
    }

    this._pollingTimer = setInterval(async () => {
      try {
        if (!this.devices || this.devices.length === 0) {
          return;
        }

        this.log.debug('Polling device statuses...');
        const statuses = await this.mirAIeAPI.getAllDeviceStatuses(this.devices);

        for (const { deviceId, status } of statuses) {
          if (status) {
            const handler = this.mirAIeAccessories.get(deviceId);
            if (handler) {
              handler.initializeFromStatus(status);
            }
          }
        }
      } catch (error) {
        this.log.error('Polling error:', error.message);
      }
    }, this.pollingInterval);
  }
}

module.exports = MirAIePlatform;
