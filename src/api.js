'use strict';

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  HTTP_CLIENT_ID,
  LOGIN_URL,
  HOMES_URL,
  DEVICE_DETAILS_URL,
} = require('./constants');

class MirAIeAPI {
  constructor(log, storagePath) {
    this.log = log;
    this.storagePath = storagePath;
    this.accessToken = null;
    this.refreshToken = null;
    this.homeId = null;
  }

  _getTokenCachePath() {
    return path.join(this.storagePath, '.miraie-token-cache.json');
  }

  _loadCachedToken() {
    try {
      const cachePath = this._getTokenCachePath();
      if (!fs.existsSync(cachePath)) {
        return false;
      }
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (Date.now() < cached.expiresAt - 86400000) {
        this.accessToken = cached.accessToken;
        this.refreshToken = cached.refreshToken || null;
        this.homeId = cached.homeId;
        return true;
      }
      // Keep refreshToken loaded even if accessToken expired, to attempt token refresh
      this.refreshToken = cached.refreshToken || null;
      this.homeId = cached.homeId;
      return false;
    } catch (e) {
      return false;
    }
  }

  _saveCachedToken(expiresAt) {
    try {
      const cachePath = this._getTokenCachePath();
      fs.writeFileSync(cachePath, JSON.stringify({
        accessToken: this.accessToken,
        refreshToken: this.refreshToken,
        homeId: this.homeId,
        expiresAt: expiresAt,
      }));
    } catch (e) {
      this.log.debug('Could not save token cache:', e.message);
    }
  }

  async getValidToken(username, password) {
    if (this._loadCachedToken()) {
      this.log.info('Using cached authentication token');
      return this.accessToken;
    }
    if (this.refreshToken) {
      try {
        this.log.info('Cached access token expired, attempting refresh using refresh token...');
        await this.refreshAccessToken();
        return this.accessToken;
      } catch (e) {
        this.log.warn('Token refresh failed, falling back to full authentication:', e.message);
      }
    }
    this.log.info('Cached token expired or missing, authenticating...');
    await this.authenticate(username, password);
    return this.accessToken;
  }

  async refreshAccessToken() {
    if (!this.refreshToken) {
      throw new Error('No refresh token available');
    }
    const data = {
      clientId: HTTP_CLIENT_ID,
      refreshToken: this.refreshToken,
    };
    const response = await axios.post('https://auth.miraie.in/simplifi/v1/userManagement/token/refresh', data, {
      headers: { 'Content-Type': 'application/json' },
    });
    if (response.status === 200 && response.data.accessToken) {
      this.accessToken = response.data.accessToken;
      if (response.data.refreshToken) {
        this.refreshToken = response.data.refreshToken;
      }
      const expiresIn = response.data.expiresIn || 6480000;
      const expiresAt = Date.now() + (expiresIn * 1000);
      this._saveCachedToken(expiresAt);
      const days = Math.round((expiresAt - Date.now()) / 86400000);
      this.log.info('Token refresh successful (valid for ' + days + ' days)');
      return true;
    }
    throw new Error(`Token refresh failed with status ${response.status}`);
  }

  async authenticate(username, password) {
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
        this.refreshToken = response.data.refreshToken || null;
        const expiresIn = response.data.expiresIn || 6480000;
        const expiresAt = Date.now() + (expiresIn * 1000);
        this._saveCachedToken(expiresAt);
        const days = Math.round((expiresAt - Date.now()) / 86400000);
        this.log.info('Authentication successful (token valid for ' + days + ' days)');
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

  _getHeaders() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json',
    };
  }

  async discoverDevices() {
    try {
      const response = await axios.get(HOMES_URL, {
        headers: this._getHeaders(),
      });

      const homeData = response.data[0];
      this.homeId = homeData.homeId;

      // Persist homeId alongside cached token
      try {
        const cachePath = this._getTokenCachePath();
        if (fs.existsSync(cachePath)) {
          const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          cached.homeId = this.homeId;
          fs.writeFileSync(cachePath, JSON.stringify(cached));
        }
      } catch (e) {
        this.log.debug('Could not update homeId in token cache:', e.message);
      }

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
}

module.exports = MirAIeAPI;
