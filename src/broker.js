'use strict';

const mqtt = require('mqtt');
const {
  MQTT_HOST,
  MQTT_PORT,
  MQTT_BASE_PAYLOAD,
  POWER_MODE,
  HVAC_MODE,
  FAN_MODE,
  SWING_MODE,
  DISPLAY_MODE,
  PRESET_MODE,
  CONVERTI_MODE,
} = require('./constants');

/**
 * MirAIe MQTT Broker Client
 * Handles real-time communication with AC units via MQTT.
 */
class MirAIeBroker {
  constructor(log) {
    this.log = log;
    this.client = null;
    this.statusCallbacks = new Map();
    this.topics = [];
    this._reconnectInterval = 5000;
    this._connected = false;
    this._getToken = null;
  }

  /**
   * Register a callback for a specific MQTT topic
   * @param {string} topic
   * @param {Function} callback
   */
  registerCallback(topic, callback) {
    this.statusCallbacks.set(topic, callback);
  }

  /**
   * Remove a callback for a specific MQTT topic
   * @param {string} topic
   */
  removeCallback(topic) {
    this.statusCallbacks.delete(topic);
  }

  /**
   * Connect to the MirAIe MQTT broker
   * @param {string} homeId - User's home ID (used as MQTT username)
   * @param {string} accessToken - Access token (used as MQTT password)
   * @param {Array<string>} topics - Topics to subscribe to
   * @param {Function} getToken - Async function to refresh the token
   */
  async connect(homeId, accessToken, topics, getToken) {
    this.topics = topics;
    this._getToken = getToken;

    const clientId = `hb-miraie-${Math.floor(Math.random() * 10000)}`;

    const options = {
      host: MQTT_HOST,
      port: MQTT_PORT,
      protocol: 'mqtts',
      clientId: clientId,
      username: homeId,
      password: accessToken,
      rejectUnauthorized: true,
      reconnectPeriod: this._reconnectInterval,
      connectTimeout: 30000,
      keepalive: 60,
    };

    return new Promise((resolve, reject) => {
      this.client = mqtt.connect(options);

      this.client.on('connect', () => {
        this._connected = true;
        this.log.info('Connected to MirAIe MQTT broker');

        // Subscribe to all device topics
        for (const topic of this.topics) {
          this.client.subscribe(topic, (err) => {
            if (err) {
              this.log.error(`Failed to subscribe to ${topic}:`, err.message);
            } else {
              this.log.debug(`Subscribed to ${topic}`);
            }
          });
        }

        resolve();
      });

      this.client.on('message', (topic, payload) => {
        try {
          const parsed = JSON.parse(payload.toString());
          const callback = this.statusCallbacks.get(topic);
          if (callback) {
            callback(parsed);
          }
        } catch (error) {
          this.log.error('Error parsing MQTT message:', error.message);
        }
      });

      this.client.on('error', (error) => {
        this.log.error('MQTT error:', error.message);
        this._connected = false;
      });

      this.client.on('close', () => {
        this.log.warn('MQTT connection closed');
        this._connected = false;
      });

      this.client.on('reconnect', async () => {
        this.log.info('Reconnecting to MQTT broker...');
        // Refresh token on reconnect
        if (this._getToken) {
          try {
            const newToken = await this._getToken();
            if (newToken && this.client) {
              this.client.options.password = newToken;
            }
          } catch (error) {
            this.log.error('Token refresh during reconnect failed:', error.message);
          }
        }
      });

      this.client.on('offline', () => {
        this.log.warn('MQTT client is offline');
        this._connected = false;
      });

      // Timeout for initial connection
      setTimeout(() => {
        if (!this._connected) {
          reject(new Error('MQTT connection timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Build the base MQTT payload
   */
  _buildBasePayload() {
    return { ...MQTT_BASE_PAYLOAD };
  }

  /**
   * Publish a command to a device's control topic
   * @param {string} topic - Control topic
   * @param {Object} payload - Command payload
   */
  async publish(topic, payload) {
    if (!this.client || !this._connected) {
      throw new Error('Cannot publish: MQTT not connected');
    }

    return new Promise((resolve, reject) => {
      this.client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
        if (err) {
          this.log.error(`Failed to publish to ${topic}:`, err.message);
          reject(err);
        } else {
          this.log.debug(`Published to ${topic}:`, JSON.stringify(payload));
          resolve();
        }
      });
    });
  }

  // ── Power ──────────────────────────────────────────────

  async setPower(topic, power) {
    const payload = this._buildBasePayload();
    payload.ps = power;
    await this.publish(topic, payload);
  }

  // ── Temperature ────────────────────────────────────────

  async setTemperature(topic, temperature) {
    const payload = this._buildBasePayload();
    payload.actmp = String(temperature);
    await this.publish(topic, payload);
  }

  // ── HVAC Mode ──────────────────────────────────────────

  async setHVACMode(topic, mode) {
    const payload = this._buildBasePayload();
    payload.acmd = mode;
    await this.publish(topic, payload);
  }

  // ── Fan Mode ───────────────────────────────────────────

  async setFanMode(topic, mode) {
    const payload = this._buildBasePayload();
    payload.acfs = mode;
    await this.publish(topic, payload);
  }

  // ── Preset Mode ────────────────────────────────────────

  async setPresetMode(topic, mode) {
    const payload = this._buildBasePayload();

    switch (mode) {
    case PRESET_MODE.NONE:
      payload.acem = 'off';
      payload.acpm = 'off';
      payload.acec = 'off';
      payload.cnv = 0;
      break;
    case PRESET_MODE.ECO:
      payload.acem = 'on';
      payload.acpm = 'off';
      payload.acec = 'off';
      payload.actmp = 26.0;
      payload.cnv = 0;
      break;
    case PRESET_MODE.BOOST:
      payload.acem = 'off';
      payload.acpm = 'on';
      payload.acec = 'off';
      payload.cnv = 0;
      break;
    case PRESET_MODE.CLEAN:
      payload.acem = 'off';
      payload.acpm = 'off';
      payload.acec = 'on';
      payload.cnv = 0;
      break;
    }

    await this.publish(topic, payload);
  }

  // ── Vertical Swing ─────────────────────────────────────

  async setVerticalSwing(topic, mode) {
    const payload = this._buildBasePayload();
    payload.acvs = mode;
    await this.publish(topic, payload);
  }

  // ── Horizontal Swing ───────────────────────────────────

  async setHorizontalSwing(topic, mode) {
    const payload = this._buildBasePayload();
    payload.achs = mode;
    await this.publish(topic, payload);
  }

  // ── Display Mode ───────────────────────────────────────

  async setDisplayMode(topic, mode) {
    const payload = this._buildBasePayload();
    payload.acdc = mode;
    await this.publish(topic, payload);
  }

  // ── Converti Mode ──────────────────────────────────────

  async setConvertiMode(topic, mode) {
    const payload = this._buildBasePayload();
    payload.acem = 'off';
    payload.acpm = 'off';
    payload.cnv = mode;
    await this.publish(topic, payload);
  }

  /**
   * Check if connected
   */
  get isConnected() {
    return this._connected;
  }

  /**
   * Disconnect from the MQTT broker
   */
  async disconnect() {
    if (this.client) {
      this.client.end(true);
      this._connected = false;
      this.log.info('Disconnected from MQTT broker');
    }
  }
}

module.exports = MirAIeBroker;
