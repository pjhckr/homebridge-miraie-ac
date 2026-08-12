# homebridge-miraie-ac

Homebridge plugin for **Panasonic MirAIe** Air Conditioners. Control your MirAIe-enabled ACs through Apple HomeKit.

## Features

Each AC unit appears as a **single accessory** in HomeKit containing:

| Service | Controls |
|---|---|
| **HeaterCooler** (primary) | Power on/off, Cool/Heat/Auto mode, Target temperature (16–30°C in 0.5° steps), Swing toggle, Fan speed |
| **Fan** (linked) | Granular fan control with Auto, Quiet, Low, Medium, High |
| **Temperature Sensor** (linked) | Room temperature reading with online status |
| **Display Switch** (linked) | Toggle the AC's LED display on/off |
| **Eco Switch** (linked) | Toggle Eco/energy-saving mode |
| **Turbo Switch** (linked) | Toggle Boost/Turbo mode |

### How it works

- **Real-time updates** via MQTT (same protocol the MirAIe app uses)
- **Automatic token refresh** — stays connected 24/7
- **Periodic polling** as a fallback for missed MQTT messages
- **Auto-discovery** — finds all ACs on your MirAIe account

## Installation

### Via Homebridge UI

Search for `homebridge-miraie-ac` in the Homebridge plugin search.

### Via CLI

```bash
npm install -g homebridge-miraie-ac
```

## Configuration

Add the following to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "MirAIeAC",
      "name": "MirAIe AC",
      "username": "<your_miraie_username>",
      "password": "<your_miraie_password>",
      "pollingInterval": 300
    }
  ]
}
```

### Options

| Option | Required | Default | Description |
|---|---|---|---|
| `platform` | Yes | — | Must be `MirAIeAC` |
| `name` | Yes | `MirAIe AC` | Display name for the platform |
| `username` | Yes | — | MirAIe mobile number or email |
| `password` | Yes | — | MirAIe account password |
| `pollingInterval` | No | `300` | Status poll interval in seconds (60–3600) |

## HomeKit Controls Mapping

### Mode Selection
- **Auto** → MirAIe Auto mode
- **Cool** → MirAIe Cool mode (also maps Dry & Fan-only)
- **Heat** → MirAIe Heat mode

### Fan Speed (HeaterCooler)
| HomeKit % | MirAIe Mode |
|---|---|
| 0–10% | Auto |
| 11–30% | Low |
| 31–55% | Medium |
| 56–100% | High |

### Fan Speed (Fan Service - more granular)
| HomeKit % | MirAIe Mode |
|---|---|
| 0–10% | Auto |
| 11–30% | Quiet |
| 31–50% | Low |
| 51–70% | Medium |
| 71–100% | High |

### Swing
- **Enabled** → Auto swing
- **Disabled** → Fixed position

## Troubleshooting

1. **Authentication fails**: Make sure your credentials work in the MirAIe app first
2. **Devices not found**: Ensure your ACs are registered and online in the MirAIe app
3. **MQTT disconnects**: The plugin auto-reconnects with token refresh — check Homebridge logs
4. **Stale state**: Reduce `pollingInterval` to 60 seconds for more frequent updates

## Credits

Based on the [ha-miraie-ac](https://github.com/rkzofficial/ha-miraie-ac) Home Assistant integration and the [miraie-ac](https://github.com/rkzofficial/miraie-ac) Python library by [@rkzofficial](https://github.com/rkzofficial).

## License

MIT
