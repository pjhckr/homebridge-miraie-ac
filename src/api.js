'use strict';

const axios = require('axios');
const {
  HTTP_CLIENT_ID,
  LOGIN_URL,
  HOMES_URL,
  STATUS_URL,
  DEVICE_DETAILS_URL,
} = require('./constants');

/**
 * MirAIe HTTP API Client
 * Handles authentication, device discovery, and status polling.
 */
class MirAIeAPI {
  constructor(log) {
    this.log = log;
    this.accessToken = null;
    this.refreshToken = null;
    this.userId = null;
    this.expiresIn = null;
    this.username = null;
    this.password = null;
    this.homeId = null;
    this._tokenRefreshTimer = null;
  }

  /**
   * Authenticate with the MirAIe cloud
   * @param {string} username - Mobile number or email
   * @param {string} password - Account password
   * @returns {Promise<boolean>}
   */
  async authenticate(username, password) {
    this.username = username;
    this.password = password;

    const isEmail = /^[0-9a-zA-Z._]+@[0-9a-zA-Z]+\.[0-9a-zA-Z]+$/.test(username);

    const data = {
      clientId: HTTP_CLIENT_ID,
      password: password,
      scope: 'an_14214235325',
    };

    if (isEmail) {
      data.email = username;
    } else {
      data.mobile = username;
    }

    try {
      const response = await axios.post(LOGIN_URL, data, {
        headers: { 'Content-Type': 'application/json' },
      });

      if (response.status === 200) {
        this.accessToken = response.data.accessToken;
        this.refreshToken = response.data.refreshToken;
        this.userId = response.data.userId;
        this.expiresIn = response.data.expiresIn;

        // Schedule token refresh before expiry (80% of expiry time)
        this._scheduleTokenRefresh();

        this.log.info('MirAIe authentication successful');
        return true;
      }

      throw new Error(`Authentication failed with status ${response.status}`);
    } catch (error) {
      this.log.error('MirAIe authentication failed:', error.message);
      if (error.response) {
        this.log.debug('Response status:', error.response.status);
        this.log.debug('Response data:', JSON.stringify(error.response.data));
      }
      throw new Error('Authentication failed');
    }
  }

  /**
   * Schedule automatic token refresh
   * Honors the server's actual TTL. Uses chained timers to work around
   * JavaScript's setTimeout max of ~24.8 days (2^31-1 ms).
   */
  _scheduleTokenRefresh() {
    if (this._tokenRefreshTimer) {
      clearTimeout(this._tokenRefreshTimer);
    }

    const MAX_TIMEOUT_MS = 2147483647; // 2^31-1 ms (~24.8 days), JS setTimeout max
    const refreshMs = (this.expiresIn || 3600) * 0.8 * 1000;
    const refreshHours = Math.round(refreshMs / 3600000);
    const expiryHours = Math.round((this.expiresIn || 3600) / 3600);
    this.log.info(`Token refresh scheduled in ${refreshHours}h (expires in ${expiryHours}h)`);

    this._scheduleTokenRefreshAt(Date.now() + refreshMs, MAX_TIMEOUT_MS);
  }

  /**
   * Internal: schedule a timer that fires at the target timestamp.
   * If the wait exceeds JS setTimeout max, chains intermediate timers.
   */
  _scheduleTokenRefreshAt(targetTime, maxTimeout) {
    const remaining = targetTime - Date.now();

    if (remaining <= 0) {
      // Time to refresh
      this._doTokenRefresh();
      return;
    }

    const delay = Math.min(remaining, maxTimeout);
    this._tokenRefreshTimer = setTimeout(() => {
      if (Date.now() >= targetTime) {
        this._doTokenRefresh();
      } else {
        // Not yet — chain another timer for the remaining time
        this._scheduleTokenRefreshAt(targetTime, maxTimeout);
      }
    }, delay);
  }

  async _doTokenRefresh() {
    try {
      this.log.info('Refreshing MirAIe access token...');
      await this.authenticate(this.username, this.password);
    } catch (error) {
      this.log.error('Token refresh failed:', error.message);
      // Retry in 60 seconds
      this._tokenRefreshTimer = setTimeout(() => this._scheduleTokenRefresh(), 60000);
    }
  }

  /**
   * Get authorization headers
   */
  _getHeaders() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Discover all homes and devices
   * @returns {Promise<{homeId: string, devices: Array}>}
   */
  async discoverDevices() {
    try {
      const response = await axios.get(HOMES_URL, {
        headers: this._getHeaders(),
      });

      const homeData = response.data[0];
      this.homeId = homeData.homeId;

      const devices = [];

      for (const space of homeData.spaces) {
        for (const device of space.devices) {
          const baseTopic = device.topic[0];
          devices.push({
            id: device.deviceId,
            name: device.deviceName,
            friendlyName: device.deviceName,
            controlTopic: `${baseTopic}/control`,
            statusTopic: `${baseTopic}/status`,
            connectionStatusTopic: `${baseTopic}/connectionStatus`,
            spaceName: space.spaceName || 'Home',
          });
        }
      }

      // Disambiguate duplicate device names by prepending the space/room name
      const nameCount = {};
      for (const d of devices) {
        nameCount[d.name] = (nameCount[d.name] || 0) + 1;
      }
      for (const d of devices) {
        if (nameCount[d.name] > 1 && d.spaceName && d.spaceName !== 'Home') {
          d.friendlyName = `${d.spaceName} ${d.name}`;
        } else if (nameCount[d.name] > 1) {
          // Fallback: append last 4 chars of device ID
          d.friendlyName = `${d.name} (${d.id.slice(-4)})`;
        }
      }

      // Fetch device details
      if (devices.length > 0) {
        const deviceIds = devices.map((d) => d.id).join(',');
        const detailsResponse = await axios.get(
          `${DEVICE_DETAILS_URL}/${deviceIds}`,
          { headers: this._getHeaders() },
        );

        for (const dd of detailsResponse.data) {
          const device = devices.find((d) => d.id === dd.deviceId);
          if (device) {
            device.details = {
              modelName: dd.modelName,
              macAddress: dd.macAddress,
              category: dd.category,
              brand: dd.brand,
              firmwareVersion: dd.firmwareVersion,
              serialNumber: dd.serialNumber,
              modelNumber: dd.modelNumber,
              productSerialNumber: dd.productSerialNumber,
            };
          }
        }
      }

      this.log.info(`Discovered ${devices.length} MirAIe device(s)`);
      return { homeId: this.homeId, devices };
    } catch (error) {
      this.log.error('Device discovery failed:', error.message);
      throw error;
    }
  }

  /**
   * Get status for a single device
   * @param {string} deviceId
   * @returns {Promise<Object>}
   */
  async getDeviceStatus(deviceId) {
    try {
      const url = STATUS_URL.replace('{deviceId}', deviceId);
      const response = await axios.get(url, {
        headers: this._getHeaders(),
      });
      return response.data;
    } catch (error) {
      this.log.error(`Failed to get status for device ${deviceId}:`, error.message);
      return null;
    }
  }

  /**
   * Get status for all devices
   * @param {Array} devices
   * @returns {Promise<Array>}
   */
  async getAllDeviceStatuses(devices) {
    const statuses = await Promise.allSettled(
      devices.map((device) => this.getDeviceStatus(device.id)),
    );

    return statuses.map((result, index) => ({
      deviceId: devices[index].id,
      status: result.status === 'fulfilled' ? result.value : null,
    }));
  }

  /**
   * Cleanup
   */
  destroy() {
    if (this._tokenRefreshTimer) {
      clearTimeout(this._tokenRefreshTimer);
    }
  }
}

module.exports = MirAIeAPI;
