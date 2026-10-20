import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Connection } from '../src/ble/device.js';
import {
    defaultConfig, sanitizeConfig, loadDeviceConfig, saveDeviceConfig,
    rememberDevice, unregisterDevice, pickerFor,
} from '../src/store/devices.js';

function memoryStorage() {
    const items = new Map();
    return {
        getItem: (k) => (items.has(k) ? items.get(k) : null),
        setItem: (k, v) => items.set(k, String(v)),
        removeItem: (k) => items.delete(k),
    };
}

test('device config round trips', () => {
    const storage = memoryStorage();
    let config = loadDeviceConfig(storage);
    assert.deepEqual(config, defaultConfig());
    config = rememberDevice(config, 'trainer', {id: 'abc==', name: 'RAMPA 12345'});
    config = rememberDevice(config, 'hr', {id: 'def==', name: 'HRM-Pro'});
    config = {...config, autoConnect: false};
    saveDeviceConfig(config, storage);
    assert.deepEqual(loadDeviceConfig(storage), {
        version: 1,
        autoConnect: false,
        devices: {trainer: {id: 'abc==', name: 'RAMPA 12345'}, hr: {id: 'def==', name: 'HRM-Pro'}},
    });
    config = unregisterDevice(loadDeviceConfig(storage), 'hr');
    assert.deepEqual(Object.keys(config.devices), ['trainer']);
});

test('hostile or malformed config is cleaned', () => {
    const storage = memoryStorage();
    storage.setItem('vigo.devices', '{nope');
    assert.deepEqual(loadDeviceConfig(storage), defaultConfig());
    for(const bad of [null, 3, 'x', [], {devices: []}, {devices: 'x'}]) {
        assert.deepEqual(sanitizeConfig(bad), defaultConfig(), JSON.stringify(bad));
    }
    const config = sanitizeConfig(JSON.parse(`{
        "autoConnect": "yes",
        "devices": {
            "__proto__": {"id": "a", "name": "b"},
            "constructor": {"id": "a", "name": "b"},
            "trainer": {"id": 42, "name": "RAMPA"},
            "hr": {"id": "${'x'.repeat(129)}", "name": "HRM"},
            "csc": {"id": "ok", "name": "<img src=x onerror=alert(1)>", "extra": true}
        }
    }`));
    assert.equal(config.autoConnect, true);
    assert.deepEqual(config.devices, {csc: {id: 'ok', name: '<img src=x onerror=alert(1)>'}});
    assert.equal(Object.getPrototypeOf(config.devices), Object.prototype);
});

test('a device without a usable name or id keeps the saved one', () => {
    const config = rememberDevice(defaultConfig(), 'trainer', {id: 'abc', name: 'RAMPA'});
    assert.deepEqual(rememberDevice(config, 'trainer', {id: 'abc', name: undefined}), config);
    assert.deepEqual(rememberDevice(config, 'toaster', {id: 'x', name: 'y'}), config);
});

test('pickerFor narrows every filter to the device name', () => {
    const picker = {filters: [{services: ['s1']}], optionalServices: ['o']};
    assert.deepEqual(pickerFor(picker, 'RAMPA 12345'), {
        filters: [{services: ['s1'], name: 'RAMPA 12345'}],
        optionalServices: ['o'],
    });
    assert.deepEqual(picker.filters, [{services: ['s1']}], 'original untouched');
});

// a device that is off until `available` is set, `hang` makes connect never answer
function fakeDevice() {
    const device = new EventTarget();
    device.name = 'RAMPA 12345';
    device.available = false;
    device.hang = false;
    device.connects = 0;
    device.forgotten = false;
    device.watching = 0;
    device.gatt = {
        connected: false,
        connect() {
            device.connects += 1;
            if(device.hang) return new Promise(() => {});
            if(!device.available) return Promise.reject(new DOMException('Bluetooth Device is no longer in range.', 'NetworkError'));
            device.gatt.connected = true;
            return Promise.resolve({});
        },
        disconnect() {
            if(!device.gatt.connected) return;
            device.gatt.connected = false;
            device.dispatchEvent(new Event('gattserverdisconnected'));
        },
    };
    device.forget = async () => { device.forgotten = true; };
    device.watchAdvertisements = async ({signal}) => {
        device.watching += 1;
        signal.addEventListener('abort', () => { device.watching -= 1; });
    };
    device.advertise = () => device.dispatchEvent(new Event('advertisementreceived'));
    return device;
}

const flush = async () => { for(let i = 0; i < 10; i++) await Promise.resolve(); };

function setupConnection(t) {
    t.mock.timers.enable({apis: ['setTimeout']});
    const warn = console.warn;
    console.warn = () => {};
    t.after(() => { console.warn = warn; });
    const statuses = [];
    const connection = Connection({
        picker: {filters: []},
        setup: async () => ({ok: true}),
        onStatus: (status) => statuses.push(status),
    });
    return {connection, statuses};
}

test('adopt retries with backoff until the device shows up', async (t) => {
    const {connection, statuses} = setupConnection(t);
    const device = fakeDevice();
    delete device.watchAdvertisements;

    connection.adopt(device);
    await flush();
    assert.equal(connection.status, 'searching');
    assert.equal(device.connects, 1);

    // 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s at most
    for(const [wait, connects] of [[999, 1], [1, 2], [2000, 3], [4000, 4], [8000, 5], [16000, 6], [29999, 6], [1, 7], [30000, 8]]) {
        t.mock.timers.tick(wait);
        await flush();
        assert.equal(device.connects, connects, `after ${wait} ms`);
    }

    device.available = true;
    t.mock.timers.tick(30000);
    await flush();
    assert.equal(connection.status, 'connected');
    assert.deepEqual(connection.link, {ok: true});
    assert.equal(statuses[0], 'searching');
    assert.equal(statuses.at(-1), 'connected');
});

test('an advertisement triggers an attempt at once and the watch stops when connected', async (t) => {
    const {connection} = setupConnection(t);
    const device = fakeDevice();
    connection.adopt(device);
    await flush();
    assert.equal(device.watching, 1);
    t.mock.timers.tick(1000);
    await flush();
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(device.connects, 3);

    device.available = true;
    device.advertise();
    await flush();
    assert.equal(connection.status, 'connected');
    assert.equal(device.connects, 4);
    assert.equal(device.watching, 0);
});

test('a connect that never answers times out and is retried', async (t) => {
    const {connection} = setupConnection(t);
    const device = fakeDevice();
    device.hang = true;
    connection.adopt(device);
    await flush();
    assert.equal(device.connects, 1);
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(connection.status, 'searching');
    device.hang = false;
    device.available = true;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(connection.status, 'connected');
});

test('a dropout after connecting goes back to retrying', async (t) => {
    const {connection} = setupConnection(t);
    const device = fakeDevice();
    device.available = true;
    connection.adopt(device);
    await flush();
    assert.equal(connection.status, 'connected');

    device.available = false;
    device.gatt.disconnect();
    assert.equal(connection.status, 'reconnecting');
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(connection.status, 'reconnecting');
    device.available = true;
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(connection.status, 'connected');
});

test('nudge retries at once and resets the backoff', async (t) => {
    const {connection} = setupConnection(t);
    const device = fakeDevice();
    connection.adopt(device);
    await flush();
    for(const wait of [1000, 2000, 4000]) {
        t.mock.timers.tick(wait);
        await flush();
    }
    assert.equal(device.connects, 4);
    connection.nudge();
    await flush();
    assert.equal(device.connects, 5);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(device.connects, 6, 'backoff back to 1 s');
});

test('disconnect and unregister stop the loop, unregister revokes the permission', async (t) => {
    const {connection} = setupConnection(t);
    const device = fakeDevice();
    connection.adopt(device);
    await flush();
    connection.disconnect();
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(device.connects, 1);
    assert.equal(connection.status, 'disconnected');

    device.available = true;
    connection.adopt(device);
    await flush();
    assert.equal(connection.status, 'connected');
    await connection.unregister();
    assert.equal(device.forgotten, true);
    assert.equal(device.gatt.connected, false);
    assert.equal(connection.status, 'disconnected');
    assert.equal(connection.device, undefined);
    t.mock.timers.tick(60000);
    await flush();
    assert.equal(device.connects, 2);
});

// regressions: a slow trainer could not be connected by hand any more

function slowDevice(ms) {
    const device = fakeDevice();
    device.available = true;
    device.gatt.connect = () => {
        device.connects += 1;
        return new Promise((resolve, reject) => setTimeout(() => {
            if(!device.available) return reject(new DOMException('Bluetooth Device is no longer in range.', 'NetworkError'));
            device.gatt.connected = true;
            resolve({});
        }, ms));
    };
    return device;
}

function withPicker(t, device) {
    const bluetooth = {requestDevice: async () => device};
    Object.defineProperty(globalThis.navigator, 'bluetooth', {value: bluetooth, configurable: true});
    t.after(() => { delete globalThis.navigator.bluetooth; });
}

test('a manual connect has no timeout, a slow trainer still connects', async (t) => {
    const {connection} = setupConnection(t);
    const device = slowDevice(15000);
    withPicker(t, device);
    const done = connection.connect();
    await flush();
    t.mock.timers.tick(15000);
    await flush();
    await done;
    assert.equal(connection.status, 'connected');
});

test('a manual connect is not undone by a retry still running', async (t) => {
    const {connection} = setupConnection(t);
    const device = slowDevice(15000);
    device.available = false;
    delete device.watchAdvertisements;
    withPicker(t, device);

    // the retry loop is in the middle of an attempt that will time out after 10 s
    connection.adopt(device);
    await flush();
    t.mock.timers.tick(5000);
    await flush();
    assert.equal(connection.status, 'searching');

    // the trainer is switched on and connected by hand, which takes 8 s
    device.available = true;
    device.gatt.connect = () => {
        device.connects += 1;
        return new Promise((resolve) => setTimeout(() => { device.gatt.connected = true; resolve({}); }, 8000));
    };
    const done = connection.connect();
    await flush();
    t.mock.timers.tick(5000);  // the old attempt's timeout fires here
    await flush();
    assert.equal(device.gatt.connected, false, 'not connected yet');
    t.mock.timers.tick(3000);
    await flush();
    await done;
    assert.equal(connection.status, 'connected');
    assert.equal(device.gatt.connected, true, 'the stale timeout did not disconnect it');

    // and no leftover retry fires later
    const connects = device.connects;
    t.mock.timers.tick(120000);
    await flush();
    assert.equal(device.connects, connects);
    assert.equal(connection.status, 'connected');
});

test('the last error is kept for the settings page and cleared once connected', async (t) => {
    const {connection} = setupConnection(t);
    const device = fakeDevice();
    delete device.watchAdvertisements;
    connection.adopt(device);
    await flush();
    assert.match(connection.lastError, /no longer in range/);
    device.available = true;
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(connection.status, 'connected');
    assert.equal(connection.lastError, undefined);
});
