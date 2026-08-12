# homebridge-miraie-ac

Homebridge plugin for **Panasonic MirAIe** Air Conditioners. Seamlessly control your MirAIe-enabled ACs directly through Apple HomeKit!

## Features

Each AC unit automatically discovers its supported features directly from the MirAIe cloud and dynamically exposes them as Apple HomeKit tiles:

| Service | Apple HomeKit Feature | Controls |
|---|---|---|
| **HeaterCooler** | Thermostat Dial | Power on/off, Target temperature (16–30°C in 0.5° steps), and Mode (Cool/Heat/Auto) |
| **Room Temperature** | Temperature Sensor | Real-time ambient room temperature reading |
| **Dedicated Fan** | Fan Slider | Granular Fan Speed Control: Auto (0%), Quiet (25%), Low (50%), Medium (75%), High (100%) |
| **Vertical Swing** | Fan Slider | Discrete Swing Control: Auto (0%), Pos 1 (20%), Pos 2 (40%), Pos 3 (60%), Pos 4 (80%), Pos 5 (100%) |
| **Horizontal Swing** | Fan Slider | Discrete Swing Control: Auto (0%), Pos 1 (20%), Pos 2 (40%), Pos 3 (60%), Pos 4 (80%), Pos 5 (100%) |
| **Converti HC** | Switch | Toggle 110% Capacity (High Capacity) Mode |
| **Converti 40%** | Switch | Toggle 40% Capacity Mode |
| **Eco Mode** | Switch | Toggle energy-saving Eco Mode |
| **Powerful Mode** | Switch | Toggle Boost/Turbo Mode |
| **Clean Mode** | Switch | Toggle Self-Clean |
| **Display Mode** | Switch | Toggle the AC's front LED panel |

*(Note: Depending on your specific AC model, certain switches like Horizontal Swing or Converti may hide themselves if your AC doesn't physically support them).*

### How it works

- **Real-time instant updates** via MQTT (the exact same protocol the official MirAIe app uses)
- **Automatic token refresh** — stays connected 24/7 without needing to re-login
- **Auto-discovery** — automatically finds all ACs on your MirAIe account

## Installation

### Via Homebridge UI (Recommended)

Search for `homebridge-miraie-ac` in the Homebridge plugin search tab and click Install.

### Via CLI

```bash
npm install -g homebridge-miraie-ac
```

## Configuration

Add the following to your Homebridge `config.json`, or just use the Homebridge Web UI to configure it:

```json
{
  "platforms": [
    {
      "platform": "MirAIeAC",
      "name": "MirAIe AC",
      "username": "<your_miraie_username>",
      "password": "<your_miraie_password>"
    }
  ]
}
```

### Options

| Option | Required | Default | Description |
|---|---|---|---|
| `platform` | Yes | — | Must be `MirAIeAC` |
| `name` | Yes | `MirAIe AC` | Display name for the platform |
| `username` | Yes | — | MirAIe mobile number (e.g. 9876543210) or email |
| `password` | Yes | — | MirAIe account password |
| `pollingInterval` | No | `300` | Status poll interval in seconds (60–3600) for fallback |
| `enableEcoSwitch` | No | `true` | Expose Eco Mode switch |
| `enablePowerfulSwitch` | No | `true` | Expose Powerful Mode switch |
| `enableDisplaySwitch` | No | `true` | Expose AC Display LED switch |
| `enableCleanSwitch` | No | `true` | Expose Self-Clean switch |
| `enableConvertiControl` | No | `false` | Expose Converti Capacity switches |
| `enableTemperatureSensor` | No | `true` | Expose Room Temperature sensor |

## Troubleshooting

1. **Authentication fails**: Make sure your credentials work in the official MirAIe app first.
2. **Devices not found**: Ensure your ACs are registered and currently online in the MirAIe app.
3. **No Swing Controls**: If your AC does not report `acvs` or `achs` in its cloud payload, the swing controls will safely hide themselves.

## Credits

Massive credit to the [ha-miraie-ac](https://github.com/rkzofficial/ha-miraie-ac) Home Assistant integration and the [miraie-ac](https://github.com/rkzofficial/miraie-ac) Python library created by [@rkzofficial](https://github.com/rkzofficial). This Homebridge port leverages the incredible reverse-engineering work done on the MirAIe MQTT protocol by that project.

## License

MIT
