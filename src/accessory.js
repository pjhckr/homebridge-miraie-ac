'use strict';

const {
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
} = require('./constants');

/**
 * MirAIe AC Accessory
 *
 * Exposes a SINGLE HomeKit accessory containing:
 *   - HeaterCooler service (primary) — Power, Cool/Heat/Auto mode, Target Temperature (16-30°C in 0.5° steps), Swing, Fan speed
 *   - Fan v2 service (linked)        — Granular fan speed control (Auto, Quiet, Low, Medium, High)
 *   - Vertical Swing Control (linked) — 5 position levels + Auto (0=Auto, 1, 2, 3, 4, 5)
 *   - Horizontal Swing Control (linked)— 5 position levels + Auto (0=Auto, 1, 2, 3, 4, 5)
 *   - Converti Capacity Control (linked)— Converti mode (Off, 40%, 55%, 70%, 80%, 90%, FC/100%, HC/110%)
 *   - Dry Mode Switch (linked)       — Toggle Dry / Dehumidify mode
 *   - Fan Mode Switch (linked)       — Toggle Fan-Only mode
 *   - Powerful / Turbo Switch (linked)— Toggle Powerful / Boost mode
 *   - Clean Switch (linked)          — Toggle Self-Clean mode
 *   - Eco Switch (linked)            — Toggle Eco mode
 *   - Display Switch (linked)        — Toggle AC LED display on/off
 *   - TemperatureSensor service      — Room temperature reading + online status
 *
 * All services are linked under a SINGLE accessory card in Apple Home and Homebridge.
 */
class MirAIeAccessory {
  constructor(platform, accessory, device) {
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;
    this.log = platform.log;
    this.broker = platform.broker;

    /** @type {import('homebridge').Service} */
    this.Service = platform.api.hap.Service;
    /** @type {import('homebridge').Characteristic} */
    this.Characteristic = platform.api.hap.Characteristic;

    // Current device state
    this.state = {
      isOnline: false,
      power: POWER_MODE.OFF,
      temperature: 24.0,
      roomTemperature: 24.0,
      hvacMode: HVAC_MODE.COOL,
      fanMode: FAN_MODE.AUTO,
      vSwing: SWING_MODE.AUTO,
      hSwing: SWING_MODE.AUTO,
      display: DISPLAY_MODE.ON,
      presetMode: PRESET_MODE.NONE,
      convertiMode: CONVERTI_MODE.OFF,
    };

    const cfg = platform.config || {};
    this.options = {
      enableEcoSwitch: cfg.enableEcoSwitch !== false,
      enablePowerfulSwitch: cfg.enablePowerfulSwitch !== false,
      enableDisplaySwitch: cfg.enableDisplaySwitch !== false,
      enableTemperatureSensor: cfg.enableTemperatureSensor !== false,
      enableCleanSwitch: cfg.enableCleanSwitch !== false,
      enableConvertiControl: cfg.enableConvertiControl === true,
      enableDrySwitch: cfg.enableDrySwitch !== false,
    };

    this._capabilitiesConfigured = false;

    // Set up core accessory information and primary AC HeaterCooler card
    this._setupAccessoryInfo();
    this._setupHeaterCoolerService();

    // Register MQTT callbacks for real-time updates
    this._registerMQTTCallbacks();
  }

  _setServiceName(service, name) {
    if (!service.testCharacteristic(this.Characteristic.Name)) {
      service.addCharacteristic(this.Characteristic.Name);
      service.setCharacteristic(this.Characteristic.Name, name);
    }
    
    // Set ConfiguredName for iOS 14+ to properly label sub-switches inside the AC card
    // Only set it initially to avoid overwriting user customizations (which resets room assignments)
    if (this.Characteristic.ConfiguredName) {
      if (!service.testCharacteristic(this.Characteristic.ConfiguredName)) {
        service.addCharacteristic(this.Characteristic.ConfiguredName);
        service.setCharacteristic(this.Characteristic.ConfiguredName, name);
      }
    }
  }

  _removeServiceIfExists(serviceType, subtype) {
    const service = subtype
      ? this.accessory.getServiceById(serviceType, subtype)
      : this.accessory.getService(serviceType);
    if (service) {
      this.log.info(`[${this.device.friendlyName}] Removing disabled service: ${service.displayName || subtype}`);
      this.accessory.removeService(service);
    }
  }

  _configureDynamicCapabilities(status) {
    if (!status || this._capabilitiesConfigured) {
      return;
    }
    this._capabilitiesConfigured = true;

    this.log.info(`[${this.device.friendlyName}] Dynamically detecting cloud capabilities from status payload...`);

    // Eco Mode Switch (only if AC payload reports acem)
    if (status.acem !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling Eco Mode switch`);
      this._setupEcoSwitch();
    } else {
      this._removeServiceIfExists(this.Service.Switch, 'eco');
      this.ecoSwitchService = null;
    }

    // Powerful/Turbo Switch (only if AC payload reports acpm)
    if (status.acpm !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling Powerful/Boost switch`);
      this._setupBoostSwitch();
    } else {
      this._removeServiceIfExists(this.Service.Switch, 'boost');
      this.boostSwitchService = null;
    }

    // AC LED Display Switch (only if AC payload reports acdc)
    if (status.acdc !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling AC Display switch`);
      this._setupDisplaySwitch();
    } else {
      this._removeServiceIfExists(this.Service.Switch, 'display');
      this.displaySwitchService = null;
    }

    if (status.acmd !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling Dry Mode switch`);
      this._setupDrySwitch();
    } else {
      this._removeServiceIfExists(this.Service.Switch, 'dry');
      this.drySwitchService = null;
    }

    // Self-Clean Switch (only if AC payload reports acec)
    if (status.acec !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling Self-Clean switch`);
      this._setupCleanSwitch();
    } else {
      this._removeServiceIfExists(this.Service.Switch, 'clean');
      this.cleanSwitchService = null;
    }

    // Converti Capacity Control (HC switch and 40% switch)
    if (status.cnv !== undefined && status.cnv !== 'NA') {
      this.log.info(`[${this.device.friendlyName}] Enabling Converti HC and 40% switches`);
      this._setupConvertiHcSwitch();
      this._setupConverti40Switch();
    } else {
      this._removeServiceIfExists(this.Service.Switch, 'converti_hc');
      this._removeServiceIfExists(this.Service.Switch, 'converti_40');
      this.convertiHcSwitchService = null;
      this.converti40SwitchService = null;
    }

    // Clean up old Fanv2 Converti service if it exists
    this._removeServiceIfExists(this.Service.Fanv2, 'converti');
    this._removeServiceIfExists(this.Service.Lightbulb, 'converti');

    // Dynamic Fan/Swing Capabilities
    if (status.acvs !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling Vertical Swing control`);
      this._setupVerticalSwingControl();
    } else {
      this._removeServiceIfExists(this.Service.Fanv2, 'vswing');
      this.vSwingService = null;
    }
    
    if (status.achs !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling Horizontal Swing control`);
      this._setupHorizontalSwingControl();
    } else {
      this._removeServiceIfExists(this.Service.Fanv2, 'hswing');
      this.hSwingService = null;
    }
    
    if (status.acfs !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling dedicated Fan switches`);
      this._setupFanSpeedSwitches();
    } else {
      this._removeServiceIfExists(this.Service.Fanv2, 'fan');
    }
    
    // Permanently remove legacy Fan-Only Mode switch
    this._removeServiceIfExists(this.Service.Switch, 'fanmode');

    // Temperature Sensor
    if (status.rmtmp !== undefined) {
      this.log.info(`[${this.device.friendlyName}] Enabling Temperature Sensor`);
      this._setupTemperatureSensorService();
    } else {
      this._removeServiceIfExists(this.Service.TemperatureSensor);
      this.temperatureSensorService = null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  ACCESSORY INFORMATION
  // ═══════════════════════════════════════════════════════════

  _setupAccessoryInfo() {
    const info =
      this.accessory.getService(this.Service.AccessoryInformation) ||
      this.accessory.addService(this.Service.AccessoryInformation);

    const details = this.device.details || {};

    info
      .setCharacteristic(this.Characteristic.Manufacturer, details.brand || 'Panasonic')
      .setCharacteristic(this.Characteristic.Model, details.modelName || 'MirAIe AC')
      .setCharacteristic(this.Characteristic.SerialNumber, details.serialNumber || this.device.id)
      .setCharacteristic(
        this.Characteristic.FirmwareRevision,
        details.firmwareVersion || '1.0.0',
      );
  }

  // ═══════════════════════════════════════════════════════════
  //  HEATER COOLER SERVICE (Primary)
  // ═══════════════════════════════════════════════════════════

  _setupHeaterCoolerService() {
    this.heaterCoolerService =
      this.accessory.getService(this.Service.HeaterCooler) ||
      this.accessory.addService(this.Service.HeaterCooler, this.device.friendlyName);

    this.heaterCoolerService.setPrimaryService(true);
    this._setServiceName(this.heaterCoolerService, this.device.friendlyName);

    // Active (on/off)
    this.heaterCoolerService
      .getCharacteristic(this.Characteristic.Active)
      .onGet(() => this._getActive())
      .onSet((value) => this._setActive(value));

    // Current Heater/Cooler State
    this.heaterCoolerService
      .getCharacteristic(this.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this._getCurrentState());

    // Target Heater/Cooler State
    this.heaterCoolerService
      .getCharacteristic(this.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          this.Characteristic.TargetHeaterCoolerState.AUTO,
          this.Characteristic.TargetHeaterCoolerState.HEAT,
          this.Characteristic.TargetHeaterCoolerState.COOL,
        ],
      })
      .onGet(() => this._getTargetState())
      .onSet((value) => this._setTargetState(value));

    // Current Temperature
    this.heaterCoolerService
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.state.roomTemperature);

    // Cooling Threshold Temperature
    this.heaterCoolerService
      .getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
      .updateValue(this.state.temperature)
      .setProps({
        minValue: MIN_TEMPERATURE,
        maxValue: MAX_TEMPERATURE,
        minStep: TEMPERATURE_STEP,
      })
      .onGet(() => this.state.temperature)
      .onSet((value) => this._setTemperature(value));

    // Heating Threshold Temperature
    this.heaterCoolerService
      .getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
      .updateValue(this.state.temperature)
      .setProps({
        minValue: MIN_TEMPERATURE,
        maxValue: MAX_TEMPERATURE,
        minStep: TEMPERATURE_STEP,
      })
      .onGet(() => this.state.temperature)
      .onSet((value) => this._setTemperature(value));

    // Rotation Speed (Fan speed)
    this.heaterCoolerService
      .getCharacteristic(this.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 25 })
      .onGet(() => this._getRotationSpeed())
      .onSet((value) => this._setRotationSpeed(value));
  }

  // ═══════════════════════════════════════════════════════════
  //  FAN SERVICE (Granular Fan Speed: Auto, Quiet, Low, Med, High)
  // ═══════════════════════════════════════════════════════════

  _setupFanSpeedSwitches() {
    // Remove the old dedicated fan slider if it existed
    this._removeServiceIfExists(this.Service.Fanv2, 'fan');

    this.fanSwitches = {};
    const speeds = [
      { mode: FAN_MODE.AUTO, name: 'Fan Auto', subtype: 'fan_auto' },
      { mode: FAN_MODE.QUIET, name: 'Fan Quiet', subtype: 'fan_quiet' },
      { mode: FAN_MODE.LOW, name: 'Fan Low', subtype: 'fan_low' },
      { mode: FAN_MODE.MEDIUM, name: 'Fan Medium', subtype: 'fan_medium' },
      { mode: FAN_MODE.HIGH, name: 'Fan High', subtype: 'fan_high' }
    ];

    for (const speed of speeds) {
      const svc = this.accessory.getServiceById(this.Service.Switch, speed.subtype) ||
                  this.accessory.addService(this.Service.Switch, speed.name, speed.subtype);
      this._setServiceName(svc, speed.name);

      svc.getCharacteristic(this.Characteristic.On)
        .onGet(() => this.state.fanMode === speed.mode)
        .onSet(async (value) => {
          if (value) {
            this.state.fanMode = speed.mode;
            try {
              await this.broker.setFanMode(this.device.controlTopic, speed.mode);
              this.log.info(`[${this.device.friendlyName}] Fan: ${speed.mode}`);
              this._pushUpdatesToHomeKit();
            } catch (error) {
              this.log.error(`[${this.device.friendlyName}] Failed to set fan:`, error.message);
            }
          } else {
            // Turning off a switch does nothing, as one mode must always be active.
            // We just force an update to snap the switch back on if it was the active one.
            setTimeout(() => this._pushUpdatesToHomeKit(), 50);
          }
        });
      this.fanSwitches[speed.mode] = svc;
      if (this.heaterCoolerService) {
        this.heaterCoolerService.addLinkedService(svc);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  VERTICAL SWING CONTROL (5 Levels + Auto: 0=Auto, 1..5=Pos)
  // ═══════════════════════════════════════════════════════════

  _setupVerticalSwingControl() {
    const subtype = 'vswing';

    const name = 'Vertical Swing';
    this.vSwingService =
      this.accessory.getServiceById(this.Service.Fanv2, subtype) ||
      this.accessory.addService(
        this.Service.Fanv2,
        name,
        subtype,
      );

    this._setServiceName(this.vSwingService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.vSwingService);
    }

    this.vSwingService
      .getCharacteristic(this.Characteristic.Active)
      .onGet(() => (this.state.vSwing !== undefined ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE))
      .onSet(async (value) => {
        const mode = value === this.Characteristic.Active.ACTIVE ? SWING_MODE.AUTO : SWING_MODE.ONE;
        await this._setVerticalSwingMode(mode);
      });

    // Rotation speed mapped: 0=Auto, 20=Pos 1, 40=Pos 2, 60=Pos 3, 80=Pos 4, 100=Pos 5
    this.vSwingService
      .getCharacteristic(this.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 20 })
      .onGet(() => (this.state.vSwing || 0) * 20)
      .onSet(async (value) => {
        const level = Math.round(value / 20); // 0..5
        await this._setVerticalSwingMode(level);
      });
  }

  async _setVerticalSwingMode(level) {
    this.state.vSwing = level;
    try {
      await this.broker.setVerticalSwing(this.device.controlTopic, level);
      this.log.info(`[${this.device.friendlyName}] Vertical Swing: ${level === 0 ? 'Auto' : 'Level ' + level}`);
      this._pushUpdatesToHomeKit();
    } catch (error) {
      this.log.error(`[${this.device.friendlyName}] Failed to set vertical swing:`, error.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  HORIZONTAL SWING CONTROL (5 Levels + Auto: 0=Auto, 1..5=Pos)
  // ═══════════════════════════════════════════════════════════

  _setupHorizontalSwingControl() {
    const subtype = 'hswing';

    const name = 'Horizontal Swing';
    this.hSwingService =
      this.accessory.getServiceById(this.Service.Fanv2, subtype) ||
      this.accessory.addService(
        this.Service.Fanv2,
        name,
        subtype,
      );

    this._setServiceName(this.hSwingService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.hSwingService);
    }

    this.hSwingService
      .getCharacteristic(this.Characteristic.Active)
      .onGet(() => (this.state.hSwing !== undefined ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE))
      .onSet(async (value) => {
        const mode = value === this.Characteristic.Active.ACTIVE ? SWING_MODE.AUTO : SWING_MODE.ONE;
        await this._setHorizontalSwingMode(mode);
      });

    // Rotation speed mapped: 0=Auto, 20=Pos 1, 40=Pos 2, 60=Pos 3, 80=Pos 4, 100=Pos 5
    this.hSwingService
      .getCharacteristic(this.Characteristic.RotationSpeed)
      .setProps({ minValue: 0, maxValue: 100, minStep: 20 })
      .onGet(() => (this.state.hSwing || 0) * 20)
      .onSet(async (value) => {
        const level = Math.round(value / 20); // 0..5
        await this._setHorizontalSwingMode(level);
      });
  }

  async _setHorizontalSwingMode(level) {
    this.state.hSwing = level;
    try {
      await this.broker.setHorizontalSwing(this.device.controlTopic, level);
      this.log.info(`[${this.device.friendlyName}] Horizontal Swing: ${level === 0 ? 'Auto' : 'Level ' + level}`);
      this._pushUpdatesToHomeKit();
    } catch (error) {
      this.log.error(`[${this.device.friendlyName}] Failed to set horizontal swing:`, error.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  CONVERTI MODE CONTROL (HC 110%, FC 100%, 90, 80, 70, 55, 40, Off)
  // ═══════════════════════════════════════════════════════════

  _setupConvertiHcSwitch() {
    const subtype = 'converti_hc';

    if (!this.options.enableConvertiControl) {
      this._removeServiceIfExists(this.Service.Switch, subtype);
      this.convertiHcSwitchService = null;
      return;
    }

    const name = '110% Capacity';
    this.convertiHcSwitchService =
      this.accessory.getServiceById(this.Service.Switch, subtype) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        subtype,
      );

    this._setServiceName(this.convertiHcSwitchService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.convertiHcSwitchService);
    }

    this.convertiHcSwitchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.state.convertiMode === CONVERTI_MODE.HC)
      .onSet(async (value) => {
        const mode = value ? CONVERTI_MODE.HC : CONVERTI_MODE.OFF;
        await this._setConvertiMode(mode);
      });
  }

  _setupConverti40Switch() {
    const subtype = 'converti_40';

    if (!this.options.enableConvertiControl) {
      this._removeServiceIfExists(this.Service.Switch, subtype);
      this.converti40SwitchService = null;
      return;
    }

    const name = '40% Capacity';
    this.converti40SwitchService =
      this.accessory.getServiceById(this.Service.Switch, subtype) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        subtype,
      );

    this._setServiceName(this.converti40SwitchService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.converti40SwitchService);
    }

    this.converti40SwitchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.state.convertiMode === CONVERTI_MODE.C40)
      .onSet(async (value) => {
        const mode = value ? CONVERTI_MODE.C40 : CONVERTI_MODE.OFF;
        await this._setConvertiMode(mode);
      });
  }

  async _setConvertiMode(mode) {
    this.state.convertiMode = mode;
    try {
      await this.broker.setConvertiMode(this.device.controlTopic, mode);
      this.log.info(`[${this.device.friendlyName}] Converti Mode: ${mode}%`);
      this._pushUpdatesToHomeKit();
    } catch (error) {
      this.log.error(`[${this.device.friendlyName}] Failed to set converti mode:`, error.message);
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  DRY MODE SWITCH SERVICE
  // ═══════════════════════════════════════════════════════════

  _setupDrySwitch() {
    const subtype = 'dry';

    if (!this.options.enableDrySwitch) {
      this._removeServiceIfExists(this.Service.Switch, subtype);
      this.drySwitchService = null;
      return;
    }

    const name = 'Dry Mode';
    
    this.drySwitchService =
      this.accessory.getServiceById(this.Service.Switch, subtype) ||
      this.accessory.addService(this.Service.Switch, name, subtype);

    this._setServiceName(this.drySwitchService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.drySwitchService);
    }

    this.drySwitchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.state.hvacMode === HVAC_MODE.DRY && this.state.power === POWER_MODE.ON)
      .onSet(async (value) => {
        const mode = value ? HVAC_MODE.DRY : HVAC_MODE.COOL;
        this.state.hvacMode = mode;
        try {
          await this.broker.setHVACMode(this.device.controlTopic, mode);
          this.log.info(`[${this.device.friendlyName}] Dry Mode: ${value ? 'ON' : 'OFF'}`);
          
          if (value && this.state.power === POWER_MODE.OFF) {
            this.state.power = POWER_MODE.ON;
            await this.broker.setPower(this.device.controlTopic, POWER_MODE.ON);
          }
          
          this._pushUpdatesToHomeKit();
        } catch (error) {
          this.log.error(`[${this.device.friendlyName}] Failed to set dry mode:`, error.message);
        }
      });
  }


  // ═══════════════════════════════════════════════════════════
  //  POWERFUL / TURBO SWITCH SERVICE
  // ═══════════════════════════════════════════════════════════

  _setupBoostSwitch() {
    const subtype = 'boost';
    if (!this.options.enablePowerfulSwitch) {
      this._removeServiceIfExists(this.Service.Switch, subtype);
      this.boostSwitchService = null;
      return;
    }

    const name = 'Powerful Mode';
    this.boostSwitchService =
      this.accessory.getServiceById(this.Service.Switch, subtype) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        subtype,
      );

    this._setServiceName(this.boostSwitchService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.boostSwitchService);
    }

    this.boostSwitchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.state.presetMode === PRESET_MODE.BOOST)
      .onSet(async (value) => {
        const mode = value ? PRESET_MODE.BOOST : PRESET_MODE.NONE;
        this.state.presetMode = mode;
        try {
          await this.broker.setPresetMode(this.device.controlTopic, mode);
          this.log.info(`[${this.device.friendlyName}] Powerful/Turbo: ${value ? 'ON' : 'OFF'}`);
          this._updatePresetSwitches();
        } catch (error) {
          this.log.error(`[${this.device.friendlyName}] Failed to set powerful mode:`, error.message);
        }
      });
  }

  // ═══════════════════════════════════════════════════════════
  //  CLEAN SWITCH SERVICE
  // ═══════════════════════════════════════════════════════════

  _setupCleanSwitch() {
    const subtype = 'clean';
    if (!this.options.enableCleanSwitch) {
      this._removeServiceIfExists(this.Service.Switch, subtype);
      this.cleanSwitchService = null;
      return;
    }

    const name = 'Clean Mode';
    this.cleanSwitchService =
      this.accessory.getServiceById(this.Service.Switch, subtype) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        subtype,
      );

    this._setServiceName(this.cleanSwitchService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.cleanSwitchService);
    }

    this.cleanSwitchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.state.presetMode === PRESET_MODE.CLEAN)
      .onSet(async (value) => {
        const mode = value ? PRESET_MODE.CLEAN : PRESET_MODE.NONE;
        this.state.presetMode = mode;
        try {
          await this.broker.setPresetMode(this.device.controlTopic, mode);
          this.log.info(`[${this.device.friendlyName}] Clean Mode: ${value ? 'ON' : 'OFF'}`);
          this._updatePresetSwitches();
        } catch (error) {
          this.log.error(`[${this.device.friendlyName}] Failed to set clean mode:`, error.message);
        }
      });
  }

  // ═══════════════════════════════════════════════════════════
  //  ECO SWITCH SERVICE
  // ═══════════════════════════════════════════════════════════

  _setupEcoSwitch() {
    const subtype = 'eco';
    if (!this.options.enableEcoSwitch) {
      this._removeServiceIfExists(this.Service.Switch, subtype);
      this.ecoSwitchService = null;
      return;
    }

    const name = 'Eco Mode';
    this.ecoSwitchService =
      this.accessory.getServiceById(this.Service.Switch, subtype) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        subtype,
      );

    this._setServiceName(this.ecoSwitchService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.ecoSwitchService);
    }

    this.ecoSwitchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.state.presetMode === PRESET_MODE.ECO)
      .onSet(async (value) => {
        const mode = value ? PRESET_MODE.ECO : PRESET_MODE.NONE;
        this.state.presetMode = mode;
        try {
          await this.broker.setPresetMode(this.device.controlTopic, mode);
          this.log.info(`[${this.device.friendlyName}] Eco Mode: ${value ? 'ON' : 'OFF'}`);
          this._updatePresetSwitches();
        } catch (error) {
          this.log.error(`[${this.device.friendlyName}] Failed to set eco mode:`, error.message);
        }
      });
  }

  // ═══════════════════════════════════════════════════════════
  //  DISPLAY SWITCH SERVICE
  // ═══════════════════════════════════════════════════════════

  _setupDisplaySwitch() {
    const subtype = 'display';
    if (!this.options.enableDisplaySwitch) {
      this._removeServiceIfExists(this.Service.Switch, subtype);
      this.displaySwitchService = null;
      return;
    }

    const name = 'Display';
    this.displaySwitchService =
      this.accessory.getServiceById(this.Service.Switch, subtype) ||
      this.accessory.addService(
        this.Service.Switch,
        name,
        subtype,
      );

    this._setServiceName(this.displaySwitchService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.displaySwitchService);
    }

    this.displaySwitchService
      .getCharacteristic(this.Characteristic.On)
      .onGet(() => this.state.display === DISPLAY_MODE.ON)
      .onSet(async (value) => {
        const mode = value ? DISPLAY_MODE.ON : DISPLAY_MODE.OFF;
        this.state.display = mode;
        try {
          await this.broker.setDisplayMode(this.device.controlTopic, mode);
          this.log.info(`[${this.device.friendlyName}] Display: ${mode}`);
        } catch (error) {
          this.log.error(`[${this.device.friendlyName}] Failed to set display:`, error.message);
        }
      });
  }

  // ═══════════════════════════════════════════════════════════
  //  TEMPERATURE SENSOR SERVICE
  // ═══════════════════════════════════════════════════════════

  _setupTemperatureSensorService() {
    if (!this.options.enableTemperatureSensor) {
      this._removeServiceIfExists(this.Service.TemperatureSensor);
      this.temperatureSensorService = null;
      return;
    }

    const name = 'Room Temperature';
    this.temperatureSensorService =
      this.accessory.getService(this.Service.TemperatureSensor) ||
      this.accessory.addService(
        this.Service.TemperatureSensor,
        name,
      );

    this._setServiceName(this.temperatureSensorService, name);
    if (this.heaterCoolerService) {
      this.heaterCoolerService.addLinkedService(this.temperatureSensorService);
    }

    this.temperatureSensorService
      .getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -40, maxValue: 100, minStep: 0.1 })
      .onGet(() => this.state.roomTemperature);

    this.temperatureSensorService
      .getCharacteristic(this.Characteristic.StatusActive)
      .onGet(() => this.state.isOnline);
  }

  // ═══════════════════════════════════════════════════════════
  //  CHARACTERISTIC HANDLERS
  // ═══════════════════════════════════════════════════════════

  _getActive() {
    return this.state.power === POWER_MODE.ON
      ? this.Characteristic.Active.ACTIVE
      : this.Characteristic.Active.INACTIVE;
  }

  async _setActive(value) {
    const power = value === this.Characteristic.Active.ACTIVE ? POWER_MODE.ON : POWER_MODE.OFF;
    this.state.power = power;
    try {
      await this.broker.setPower(this.device.controlTopic, power);
      this.log.info(`[${this.device.friendlyName}] Power: ${power}`);
      this._pushUpdatesToHomeKit();
    } catch (error) {
      this.log.error(`[${this.device.friendlyName}] Failed to set power:`, error.message);
    }
  }

  _getCurrentState() {
    if (this.state.power === POWER_MODE.OFF) {
      return this.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }

    switch (this.state.hvacMode) {
    case HVAC_MODE.COOL:
      return this.Characteristic.CurrentHeaterCoolerState.COOLING;
    case HVAC_MODE.HEAT:
      return this.Characteristic.CurrentHeaterCoolerState.HEATING;
    case HVAC_MODE.DRY:
    case HVAC_MODE.FAN:
      return this.Characteristic.CurrentHeaterCoolerState.IDLE;
    case HVAC_MODE.AUTO:
      if (this.state.roomTemperature > this.state.temperature) {
        return this.Characteristic.CurrentHeaterCoolerState.COOLING;
      } else if (this.state.roomTemperature < this.state.temperature) {
        return this.Characteristic.CurrentHeaterCoolerState.HEATING;
      }
      return this.Characteristic.CurrentHeaterCoolerState.IDLE;
    default:
      return this.Characteristic.CurrentHeaterCoolerState.IDLE;
    }
  }

  _getTargetState() {
    switch (this.state.hvacMode) {
    case HVAC_MODE.HEAT:
      return this.Characteristic.TargetHeaterCoolerState.HEAT;
    case HVAC_MODE.COOL:
    case HVAC_MODE.DRY:
    case HVAC_MODE.FAN:
      return this.Characteristic.TargetHeaterCoolerState.COOL;
    case HVAC_MODE.AUTO:
    default:
      return this.Characteristic.TargetHeaterCoolerState.AUTO;
    }
  }

  async _setTargetState(value) {
    let mode;
    switch (value) {
    case this.Characteristic.TargetHeaterCoolerState.HEAT:
      mode = HVAC_MODE.HEAT;
      break;
    case this.Characteristic.TargetHeaterCoolerState.COOL:
      mode = HVAC_MODE.COOL;
      break;
    case this.Characteristic.TargetHeaterCoolerState.AUTO:
    default:
      mode = HVAC_MODE.AUTO;
      break;
    }

    this.state.hvacMode = mode;
    try {
      await this.broker.setHVACMode(this.device.controlTopic, mode);
      this.log.info(`[${this.device.friendlyName}] HVAC mode: ${mode}`);

      if (this.state.power === POWER_MODE.OFF) {
        this.state.power = POWER_MODE.ON;
        await this.broker.setPower(this.device.controlTopic, POWER_MODE.ON);
      }
      this._pushUpdatesToHomeKit();
    } catch (error) {
      this.log.error(`[${this.device.friendlyName}] Failed to set mode:`, error.message);
    }
  }

  async _setTemperature(value) {
    const temp = Math.round(value * 2) / 2;
    this.state.temperature = temp;
    try {
      await this.broker.setTemperature(this.device.controlTopic, temp);
      this.log.info(`[${this.device.friendlyName}] Temperature: ${temp}°C`);
    } catch (error) {
      this.log.error(`[${this.device.friendlyName}] Failed to set temp:`, error.message);
    }
  }


  _getRotationSpeed() {
    switch (this.state.fanMode) {
    case FAN_MODE.AUTO:
      return 0;
    case FAN_MODE.QUIET:
      return 25;
    case FAN_MODE.LOW:
      return 50;
    case FAN_MODE.MEDIUM:
      return 75;
    case FAN_MODE.HIGH:
      return 100;
    default:
      return 0;
    }
  }

  async _setRotationSpeed(value) {
    let mode;
    if (value <= 10) mode = FAN_MODE.AUTO;
    else if (value <= 35) mode = FAN_MODE.QUIET;
    else if (value <= 60) mode = FAN_MODE.LOW;
    else if (value <= 85) mode = FAN_MODE.MEDIUM;
    else mode = FAN_MODE.HIGH;

    this.state.fanMode = mode;
    try {
      await this.broker.setFanMode(this.device.controlTopic, mode);
      this.log.info(`[${this.device.friendlyName}] Fan: ${mode}`);
      this._pushUpdatesToHomeKit();
    } catch (error) {
      this.log.error(`[${this.device.friendlyName}] Failed to set fan:`, error.message);
    }
  }


  _updatePresetSwitches() {
    if (this.ecoSwitchService) {
      this.ecoSwitchService
        .getCharacteristic(this.Characteristic.On)
        .updateValue(this.state.presetMode === PRESET_MODE.ECO);
    }

    if (this.boostSwitchService) {
      this.boostSwitchService
        .getCharacteristic(this.Characteristic.On)
        .updateValue(this.state.presetMode === PRESET_MODE.BOOST);
    }

    if (this.cleanSwitchService) {
      this.cleanSwitchService
        .getCharacteristic(this.Characteristic.On)
        .updateValue(this.state.presetMode === PRESET_MODE.CLEAN);
    }
  }

  _registerMQTTCallbacks() {
    this.broker.registerCallback(this.device.statusTopic, (status) => {
      this._handleStatusUpdate(status);
    });

    this.broker.registerCallback(this.device.connectionStatusTopic, (status) => {
      this._handleConnectionStatusUpdate(status);
    });
  }

  _parseRoomTemp(value) {
    const temp = parseFloat(value);
    if (isNaN(temp) || temp === -1) {
      return this.state.roomTemperature;
    }

    const fractional = temp - Math.floor(temp);
    if (fractional !== 0 && Math.abs(fractional - 0.5) > 0.01) {
      return Math.round(fractional * 100);
    }
    return temp;
  }

  _handleStatusUpdate(status) {
    this.log.debug(`[${this.device.friendlyName}] Status update:`, JSON.stringify(status));
    this._configureDynamicCapabilities(status);

    if (status.actmp !== undefined) {
      const temp = parseFloat(status.actmp);
      if (!isNaN(temp) && temp > 0) {
        this.state.temperature = temp;
      }
    }

    if (status.rmtmp !== undefined) {
      this.state.roomTemperature = this._parseRoomTemp(status.rmtmp);
    }

    const safeStringLower = (val) => (typeof val === 'string' ? val.toLowerCase() : val);

    if (status.ps !== undefined) {
      this.state.power = safeStringLower(status.ps);
    }

    if (status.acfs !== undefined) {
      this.state.fanMode = safeStringLower(status.acfs);
    }

    if (status.acvs !== undefined) {
      this.state.vSwing = parseInt(status.acvs, 10);
    }

    if (status.achs !== undefined) {
      this.state.hSwing = parseInt(status.achs, 10);
    }

    if (status.acdc !== undefined) {
      this.state.display = safeStringLower(status.acdc);
    }

    if (status.acmd !== undefined) {
      this.state.hvacMode = safeStringLower(status.acmd);
    }

    if (status.cnv !== undefined && status.cnv !== 'NA') {
      this.state.convertiMode = parseInt(status.cnv, 10);
    } else if (status.cnv === 'NA') {
      this.state.convertiMode = CONVERTI_MODE.OFF;
    }

    if (safeStringLower(status.acpm) === 'on') {
      this.state.presetMode = PRESET_MODE.BOOST;
    } else if (safeStringLower(status.acem) === 'on') {
      this.state.presetMode = PRESET_MODE.ECO;
    } else if (safeStringLower(status.acec) === 'on') {
      this.state.presetMode = PRESET_MODE.CLEAN;
    } else if (
      status.acpm !== undefined ||
      status.acem !== undefined ||
      status.acec !== undefined
    ) {
      this.state.presetMode = PRESET_MODE.NONE;
    }

    this._pushUpdatesToHomeKit();
  }

  _handleConnectionStatusUpdate(status) {
    this.state.isOnline = status.onlineStatus === 'true';
    this.log.info(`[${this.device.friendlyName}] Online: ${this.state.isOnline}`);

    if (this.temperatureSensorService) {
      this.temperatureSensorService
        .getCharacteristic(this.Characteristic.StatusActive)
        .updateValue(this.state.isOnline);
    }
  }

  _pushUpdatesToHomeKit() {
    // Primary HeaterCooler
    if (this.heaterCoolerService) {
      this.heaterCoolerService
        .getCharacteristic(this.Characteristic.Active)
        .updateValue(this._getActive());

      this.heaterCoolerService
        .getCharacteristic(this.Characteristic.CurrentHeaterCoolerState)
        .updateValue(this._getCurrentState());

      this.heaterCoolerService
        .getCharacteristic(this.Characteristic.TargetHeaterCoolerState)
        .updateValue(this._getTargetState());

      this.heaterCoolerService
        .getCharacteristic(this.Characteristic.CurrentTemperature)
        .updateValue(this.state.roomTemperature);

      this.heaterCoolerService
        .getCharacteristic(this.Characteristic.CoolingThresholdTemperature)
        .updateValue(this.state.temperature);

      this.heaterCoolerService
        .getCharacteristic(this.Characteristic.HeatingThresholdTemperature)
        .updateValue(this.state.temperature);


      this.heaterCoolerService
        .getCharacteristic(this.Characteristic.RotationSpeed)
        .updateValue(this._getRotationSpeed());
    }

    if (this.drySwitchService) {
      this.drySwitchService
        .getCharacteristic(this.Characteristic.On)
        .updateValue(this.state.hvacMode === HVAC_MODE.DRY && this.state.power === POWER_MODE.ON);
    }

    // Fan Speed Switches
    if (this.fanSwitches) {
      for (const [mode, svc] of Object.entries(this.fanSwitches)) {
        svc.getCharacteristic(this.Characteristic.On).updateValue(this.state.fanMode === mode);
      }
    }

    // Vertical Swing
    if (this.vSwingService) {
      this.vSwingService
        .getCharacteristic(this.Characteristic.Active)
        .updateValue(this.state.vSwing !== undefined ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE);

      this.vSwingService
        .getCharacteristic(this.Characteristic.RotationSpeed)
        .updateValue((this.state.vSwing || 0) * 20);
    }

    // Horizontal Swing
    if (this.hSwingService) {
      this.hSwingService
        .getCharacteristic(this.Characteristic.Active)
        .updateValue(this.state.hSwing !== undefined ? this.Characteristic.Active.ACTIVE : this.Characteristic.Active.INACTIVE);

      this.hSwingService
        .getCharacteristic(this.Characteristic.RotationSpeed)
        .updateValue((this.state.hSwing || 0) * 20);
    }

    // Converti HC Switch
    if (this.convertiHcSwitchService) {
      this.convertiHcSwitchService
        .getCharacteristic(this.Characteristic.On)
        .updateValue(this.state.convertiMode === CONVERTI_MODE.HC);
    }

    // Converti 40% Switch
    if (this.converti40SwitchService) {
      this.converti40SwitchService
        .getCharacteristic(this.Characteristic.On)
        .updateValue(this.state.convertiMode === CONVERTI_MODE.C40);
    }

    // Temperature sensor
    if (this.temperatureSensorService) {
      this.temperatureSensorService
        .getCharacteristic(this.Characteristic.CurrentTemperature)
        .updateValue(this.state.roomTemperature);
    }

    // Display switch
    if (this.displaySwitchService) {
      this.displaySwitchService
        .getCharacteristic(this.Characteristic.On)
        .updateValue(this.state.display === DISPLAY_MODE.ON);
    }

    // Preset switches
    this._updatePresetSwitches();
  }

  initializeFromStatus(status) {
    if (!status || status.ty !== 'AC') {
      this.log.warn(`[${this.device.friendlyName}] No valid status, using defaults`);
      return;
    }

    this._configureDynamicCapabilities(status);

    const safeStringLower = (val) => (typeof val === 'string' ? val.toLowerCase() : val);

    this.state.isOnline = status.onlineStatus === 'true';
    const parsedTemp = parseFloat(status.actmp) || 24.0;
    this.state.temperature = Math.min(MAX_TEMPERATURE, Math.max(MIN_TEMPERATURE, parsedTemp));
    this.state.roomTemperature = this._parseRoomTemp(status.rmtmp);
    this.state.power = safeStringLower(status.ps) || POWER_MODE.OFF;
    this.state.fanMode = safeStringLower(status.acfs) || FAN_MODE.AUTO;
    this.state.vSwing = status.acvs !== undefined ? parseInt(status.acvs, 10) : SWING_MODE.AUTO;
    this.state.hSwing = status.achs !== undefined ? parseInt(status.achs, 10) : SWING_MODE.AUTO;
    this.state.display = safeStringLower(status.acdc) || DISPLAY_MODE.ON;
    this.state.hvacMode = safeStringLower(status.acmd) || HVAC_MODE.AUTO;
    this.state.convertiMode = status.cnv !== undefined && status.cnv !== 'NA' ? parseInt(status.cnv, 10) : CONVERTI_MODE.OFF;

    if (safeStringLower(status.acpm) === 'on') {
      this.state.presetMode = PRESET_MODE.BOOST;
    } else if (safeStringLower(status.acem) === 'on') {
      this.state.presetMode = PRESET_MODE.ECO;
    } else if (safeStringLower(status.acec) === 'on') {
      this.state.presetMode = PRESET_MODE.CLEAN;
    } else {
      this.state.presetMode = PRESET_MODE.NONE;
    }

    this.log.info(
      `[${this.device.friendlyName}] Initialized - ` +
        `Power: ${this.state.power}, Mode: ${this.state.hvacMode}, ` +
        `Temp: ${this.state.temperature}°C, Room: ${this.state.roomTemperature}°C, ` +
        `Fan: ${this.state.fanMode}, Converti: ${this.state.convertiMode}%, Online: ${this.state.isOnline}`,
    );

    this._pushUpdatesToHomeKit();
  }
}

module.exports = MirAIeAccessory;
