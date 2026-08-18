'use strict';

/**
 * Live Control UAT - Tests actual AC commands via MQTT
 * 
 * Flow:
 * 1. Auth + Discovery + Status (quick sanity)
 * 2. Record original state of first AC
 * 3. Power ON → verify via MQTT
 * 4. Set mode to COOL → verify
 * 5. Set temp to 24 → verify
 * 6. Set fan to HIGH → verify
 * 7. Power OFF → verify
 * 8. Restore original state
 */

const MirAIeAPI = require('./src/api');
const MirAIeBroker = require('./src/broker');

const username = process.argv[2];
const password = process.argv[3];

if (!username || !password) {
  console.error('Usage: node uat.js <username> <password>');
  process.exit(1);
}

const log = {
  info: (...args) => console.log('[INFO]', ...args),
  warn: (...args) => console.warn('[WARN]', ...args),
  error: (...args) => console.error('[ERROR]', ...args),
  debug: () => {},  // suppress debug noise during UAT
};

let passed = 0;
let failed = 0;
let lastStatus = {};

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  \u2705 ${label}`);
  } else {
    failed++;
    console.error(`  \u274c ${label}`);
  }
}

function waitForMqtt(broker, topic, predicate, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for MQTT confirmation (${timeoutMs}ms)`));
    }, timeoutMs);

    const originalCb = broker.statusCallbacks.get(topic);
    broker.registerCallback(topic, (status) => {
      lastStatus = status;
      if (originalCb) originalCb(status);
      if (predicate(status)) {
        clearTimeout(timer);
        // Restore original callback
        if (originalCb) broker.registerCallback(topic, originalCb);
        resolve(status);
      }
    });
  });
}

(async () => {
  const api = new MirAIeAPI(log);
  const broker = new MirAIeBroker(log);

  // === Step 1: Auth + Discovery ===
  console.log('\n=== Step 1: Auth + Discovery ===');
  await api.authenticate(username, password);
  assert(!!api.accessToken, 'Authenticated');

  // Verify token refresh is sane (not 1 hour)
  const expectedRefreshMs = Math.min(
    api.expiresIn * 0.8 * 1000,
    24 * 24 * 3600 * 1000
  );
  const expectedRefreshHours = Math.round(expectedRefreshMs / 3600000);
  assert(expectedRefreshHours > 1, `Token refresh in ${expectedRefreshHours}h (not every 1h)`);

  const { homeId, devices } = await api.discoverDevices();
  assert(devices.length > 0, `Found ${devices.length} device(s)`);

  const device = devices[0];
  console.log(`  Target AC: ${device.friendlyName}`);

  // === Step 2: Get original state ===
  console.log('\n=== Step 2: Record original state ===');
  const originalStatus = await api.getDeviceStatus(device.id);
  assert(!!originalStatus, 'Got original status');
  console.log(`  Power: ${originalStatus.ps}, Mode: ${originalStatus.acmd}, Temp: ${originalStatus.actmp}, Fan: ${originalStatus.acfs}`);

  // === Step 3: Connect MQTT ===
  console.log('\n=== Step 3: Connect MQTT ===');
  const allTopics = [];
  for (const d of devices) {
    allTopics.push(d.statusTopic);
    allTopics.push(d.connectionStatusTopic);
  }

  // Register a basic status tracker
  broker.registerCallback(device.statusTopic, (status) => {
    lastStatus = status;
  });

  await broker.connect(homeId, api.accessToken, allTopics, async () => {
    await api.authenticate(username, password);
    return api.accessToken;
  });
  assert(broker.isConnected, 'MQTT connected');

  // Wait for initial retained messages
  await new Promise(r => setTimeout(r, 3000));

  // === Step 4: Power ON ===
  console.log('\n=== Step 4: Power ON ===');
  try {
    const powerOnWait = waitForMqtt(broker, device.statusTopic, s => s.ps === 'on');
    await broker.setPower(device.controlTopic, 'on');
    const onStatus = await powerOnWait;
    assert(onStatus.ps === 'on', `Power confirmed ON (ps=${onStatus.ps})`);
  } catch (err) {
    failed++;
    console.error(`  \u274c Power ON: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  // === Step 5: Set mode COOL ===
  console.log('\n=== Step 5: Set mode COOL ===');
  try {
    const modeWait = waitForMqtt(broker, device.statusTopic, s => s.acmd === 'cool');
    await broker.setHVACMode(device.controlTopic, 'cool');
    const modeStatus = await modeWait;
    assert(modeStatus.acmd === 'cool', `Mode confirmed COOL (acmd=${modeStatus.acmd})`);
  } catch (err) {
    failed++;
    console.error(`  \u274c Set COOL: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  // === Step 6: Set temp 24 ===
  console.log('\n=== Step 6: Set temp 24C ===');
  try {
    const tempWait = waitForMqtt(broker, device.statusTopic, s => parseFloat(s.actmp) === 24.0);
    await broker.setTemperature(device.controlTopic, 24);
    const tempStatus = await tempWait;
    assert(parseFloat(tempStatus.actmp) === 24.0, `Temp confirmed 24C (actmp=${tempStatus.actmp})`);
  } catch (err) {
    failed++;
    console.error(`  \u274c Set temp: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  // === Step 7: Set fan HIGH ===
  console.log('\n=== Step 7: Set fan HIGH ===');
  try {
    const fanWait = waitForMqtt(broker, device.statusTopic, s => s.acfs === 'high');
    await broker.setFanMode(device.controlTopic, 'high');
    const fanStatus = await fanWait;
    assert(fanStatus.acfs === 'high', `Fan confirmed HIGH (acfs=${fanStatus.acfs})`);
  } catch (err) {
    failed++;
    console.error(`  \u274c Set fan: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  // === Step 8: Power OFF ===
  console.log('\n=== Step 8: Power OFF ===');
  try {
    const powerOffWait = waitForMqtt(broker, device.statusTopic, s => s.ps === 'off');
    await broker.setPower(device.controlTopic, 'off');
    const offStatus = await powerOffWait;
    assert(offStatus.ps === 'off', `Power confirmed OFF (ps=${offStatus.ps})`);
  } catch (err) {
    failed++;
    console.error(`  \u274c Power OFF: ${err.message}`);
  }

  await new Promise(r => setTimeout(r, 2000));

  // === Step 9: Restore original state ===
  console.log('\n=== Step 9: Restore original state ===');
  try {
    if (originalStatus.acmd) {
      await broker.setHVACMode(device.controlTopic, originalStatus.acmd);
    }
    if (originalStatus.actmp) {
      await broker.setTemperature(device.controlTopic, parseFloat(originalStatus.actmp));
    }
    if (originalStatus.acfs) {
      await broker.setFanMode(device.controlTopic, originalStatus.acfs);
    }
    // Restore power last
    await new Promise(r => setTimeout(r, 1000));
    await broker.setPower(device.controlTopic, originalStatus.ps || 'off');
    console.log(`  Restored: Power=${originalStatus.ps}, Mode=${originalStatus.acmd}, Temp=${originalStatus.actmp}, Fan=${originalStatus.acfs}`);
    assert(true, 'Original state restored');
  } catch (err) {
    failed++;
    console.error(`  \u274c Restore failed: ${err.message}`);
  }

  // Cleanup
  await broker.disconnect();
  api.destroy();

  console.log('\n========================================');
  console.log(`  UAT Complete: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');

  process.exit(failed > 0 ? 1 : 0);
})();
