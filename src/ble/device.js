//
// Web Bluetooth connections
//
// A Connection picks a device once (needs a user gesture), then keeps it connected:
// when the link drops it reconnects with backoff and runs setup again,
// because characteristics from the old GATT session are dead.
//

import { services, characteristics } from './uuids.js';
import { parseCyclingPower } from './cps.js';
import { parseSpeedCadence } from './cscs.js';
import { parseHeartRate } from './hrs.js';
import { encodeTargetPower, encodeBrakeLevel, parseOutOfRange, LatestWriter } from './rampa.js';
import * as ftms from './ftms.js';

export const isSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

export const pickers = Object.freeze({
    // an Elite Rampa or any FTMS trainer; a Drivo by name too, in case it doesn't advertise the Elite service
    trainer: {
        filters: [{services: [services.elite]}, {services: [services.fitnessMachine]}, {namePrefix: 'Drivo'}, {namePrefix: 'DRIVO'}],
        optionalServices: [services.elite, services.fitnessMachine, services.cyclingPower, services.speedCadence, services.deviceInfo],
    },
    heartRate: {
        filters: [{services: [services.heartRate]}],
    },
    speedCadence: {
        filters: [{services: [services.speedCadence]}],
    },
});

// status: 'disconnected' | 'connecting' | 'searching' | 'connected' | 'reconnecting'
//
// searching: a saved device that hasn't connected yet, reconnecting: one that dropped
export function Connection({picker, setup, onStatus = () => {},
                            connectTimeout = 10000, maxBackoff = 30000}) {
    let device;
    let link; // whatever setup returned for the current GATT session
    let status = 'disconnected';
    let closed = true;
    let attempts = 0;
    let retryTimer;
    let busy = false;
    let everConnected = false;
    let adverts;
    let lastError;
    // every connect, disconnect and adopt starts a new generation: an attempt still running
    // from an older one must not touch the connection (e.g. disconnect it on its timeout)
    let generation = 0;

    function setStatus(next) {
        status = next;
        onStatus(status, {name: device?.name ?? '', link, lastError});
    }

    function withTimeout(promise, ms) {
        let timer;
        return Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`no answer in ${ms / 1000} s`)), ms);
            }),
        ]).finally(() => clearTimeout(timer));
    }

    // (Int, Number) -> Bool, false when a newer generation took over meanwhile
    async function open(gen, timeout) {
        const pending = device.gatt.connect();
        const server = timeout ? await withTimeout(pending, timeout) : await pending;
        if(gen !== generation) return false;
        const next = await setup(server);
        if(gen !== generation) return false;
        link = next;
        attempts = 0;
        everConnected = true;
        lastError = undefined;
        stopWatching();
        setStatus('connected');
        return true;
    }

    function nextDelay() {
        const delay = Math.min(maxBackoff, 1000 * 2 ** attempts);
        attempts += 1;
        return delay;
    }

    function scheduleRetry() {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(attempt, nextDelay());
        startWatching();
    }

    function cancelRetry() {
        clearTimeout(retryTimer);
        retryTimer = undefined;
    }

    // retries have a timeout: a connect to a device that is off can hang for a long time
    async function attempt() {
        retryTimer = undefined;
        if(closed || busy) return;
        const gen = generation;
        busy = true;
        try {
            await open(gen, connectTimeout);
        } catch(error) {
            if(gen !== generation) return;
            link = undefined;
            lastError = error?.message ?? String(error);
            console.warn(`vigo: connecting to ${device?.name} failed`, error);
            // cancel the connect that is still pending after a timeout
            if(device?.gatt.connected || /no answer/.test(lastError)) device?.gatt.disconnect();
            if(!closed) {
                setStatus(everConnected ? 'reconnecting' : 'searching');
                scheduleRetry();
            }
        } finally {
            if(gen === generation) busy = false;
        }
    }

    function onDisconnected() {
        link = undefined;
        // a failed attempt, a manual connect or a pending retry already takes care of it
        if(closed || busy || retryTimer) return;
        setStatus('reconnecting');
        scheduleRetry();
    }

    // a device that starts advertising is in range and awake, try now instead of waiting
    function onAdvertisement() {
        if(closed || busy || status === 'connected') return;
        cancelRetry();
        attempt();
    }

    function startWatching() {
        if(adverts || !device?.watchAdvertisements) return;
        adverts = new AbortController();
        device.watchAdvertisements({signal: adverts.signal}).catch(() => { adverts = undefined; });
    }

    function stopWatching() {
        adverts?.abort();
        adverts = undefined;
    }

    function attach(next) {
        if(device === next) return;
        detach();
        device = next;
        device.addEventListener('gattserverdisconnected', onDisconnected);
        device.addEventListener('advertisementreceived', onAdvertisement);
    }

    function detach() {
        if(!device) return;
        device.removeEventListener('gattserverdisconnected', onDisconnected);
        device.removeEventListener('advertisementreceived', onAdvertisement);
    }

    // must be called from a click handler, the browser shows the device picker
    async function connect({picker: chooser = picker} = {}) {
        if(!isSupported()) throw new Error('This browser has no Web Bluetooth');
        const picked = await navigator.bluetooth.requestDevice(chooser);
        if(device && device !== picked) disconnect();
        attach(picked);
        // the user is connecting by hand: stop the retry loop, no timeout, like a plain connect
        const gen = ++generation;
        cancelRetry();
        stopWatching();
        closed = false;
        busy = true;
        attempts = 0;
        everConnected = false;
        lastError = undefined;
        setStatus('connecting');
        try {
            await open(gen, 0);
        } catch(error) {
            if(gen === generation) {
                closed = true;
                lastError = error?.message ?? String(error);
                if(device.gatt.connected) device.gatt.disconnect();
                setStatus('disconnected');
            }
            throw error;
        } finally {
            if(gen === generation) busy = false;
        }
        return device;
    }

    // a device the browser already allows (getDevices), connected without a picker,
    // retried until it shows up
    function adopt(next) {
        if(device && device !== next) disconnect();
        attach(next);
        if(status === 'connected' || busy) return;
        generation += 1;
        cancelRetry();
        closed = false;
        attempts = 0;
        everConnected = false;
        setStatus('searching');
        attempt();
    }

    // try again right away, e.g. when the page comes back to the front
    function nudge() {
        if(closed || busy || status === 'connected') return;
        attempts = 0;
        cancelRetry();
        attempt();
    }

    function disconnect() {
        generation += 1;
        closed = true;
        busy = false;
        cancelRetry();
        stopWatching();
        link = undefined;
        if(device?.gatt.connected) device.gatt.disconnect();
        setStatus('disconnected');
    }

    // stop using the device and drop the browser's permission for it where possible
    async function unregister() {
        disconnect();
        const old = device;
        detach();
        device = undefined;
        lastError = undefined;
        try {
            await old?.forget?.();
        } catch(error) {
            console.warn('vigo: could not revoke the device permission', error);
        }
        setStatus('disconnected');
    }

    return Object.freeze({
        connect,
        adopt,
        nudge,
        disconnect,
        unregister,
        get status() { return status; },
        get name() { return device?.name ?? ''; },
        get device() { return device; },
        get link() { return link; },
        get lastError() { return lastError; },
    });
}

async function subscribe(service, uuid, parse, handler) {
    const characteristic = await service.getCharacteristic(uuid);
    characteristic.addEventListener('characteristicvaluechanged', (event) => {
        let data;
        try {
            data = parse(event.target.value);
        } catch(error) {
            // a malformed packet, skip it
            console.warn(`vigo: bad notification on ${uuid}`, error);
            return;
        }
        handler(data);
    });
    await characteristic.startNotifications();
    return characteristic;
}

function writerFor(characteristic) {
    const p = characteristic.properties ?? {};
    if(p.writeWithoutResponse && !p.write && characteristic.writeValueWithoutResponse) {
        return (value) => characteristic.writeValueWithoutResponse(value);
    }
    if(characteristic.writeValueWithResponse) return (value) => characteristic.writeValueWithResponse(value);
    return (value) => characteristic.writeValue(value);
}

// (BluetoothRemoteGATTServer, String) -> BluetoothRemoteGATTService | undefined
async function optionalService(server, uuid) {
    try {
        return await server.getPrimaryService(uuid);
    } catch(error) {
        if(error?.name === 'NotFoundError') return undefined;
        throw error;
    }
}

// (BluetoothRemoteGATTService, String) -> BluetoothRemoteGATTCharacteristic | undefined
async function optionalCharacteristic(service, uuid) {
    try {
        return await service.getCharacteristic(uuid);
    } catch(error) {
        if(error?.name === 'NotFoundError') return undefined;
        throw error;
    }
}

// Elite Rampa: data on Cycling Power, control on the Elite brake characteristic
async function eliteLink(server, elite, brake, {onPower, onOutOfRange}) {
    try {
        await subscribe(elite, characteristics.eliteOutOfRange, parseOutOfRange, onOutOfRange);
    } catch(error) {
        console.warn('vigo: no out of range notifications', error);
    }

    const power = await server.getPrimaryService(services.cyclingPower);
    await subscribe(power, characteristics.cyclingPowerMeasurement, parseCyclingPower, onPower);

    const writer = LatestWriter(writerFor(brake), {
        onError: (error) => console.warn('vigo: trainer write failed', error),
    });

    return Object.freeze({
        protocol: 'Elite',
        setTarget: (watts) => writer.push(encodeTargetPower(watts)),
        release: () => writer.push(encodeBrakeLevel(0)),
    });
}

// FTMS control point: one request at a time, each one waits for its indication
//
// (BluetoothRemoteGATTCharacteristic, Number) -> {send(Uint8Array) -> Promise}
async function openControlPoint(characteristic, timeout) {
    let waiting; // {opCode, resolve, reject}
    characteristic.addEventListener('characteristicvaluechanged', (event) => {
        const response = ftms.parseControlPointResponse(event.target.value);
        if(!response || !waiting || response.opCode !== waiting.opCode) return;
        const {resolve, reject} = waiting;
        waiting = undefined;
        if(response.result === ftms.results.success) resolve();
        else reject(new Error(`trainer refused op ${response.opCode}: ${ftms.describeResult(response.result)}`));
    });
    await characteristic.startNotifications();

    const write = writerFor(characteristic);
    let queue = Promise.resolve();

    function request(value) {
        let timer;
        const answered = new Promise((resolve, reject) => {
            waiting = {opCode: value[0], resolve, reject};
            timer = setTimeout(() => {
                waiting = undefined;
                reject(new Error(`no answer in ${timeout / 1000} s`));
            }, timeout);
        });
        return Promise.all([write(value), answered]).finally(() => {
            clearTimeout(timer);
            waiting = undefined;
        });
    }

    function send(value) {
        const next = queue.then(() => request(value));
        queue = next.catch(() => {});
        return next;
    }

    return {send};
}

// FTMS trainer: control on the control point, data on Cycling Power when the trainer has it,
// else on Indoor Bike Data. FTMS has no "out of range" notification.
async function ftmsLink(server, service, {onPower, onCadence, responseTimeout}) {
    const point = await openControlPoint(await service.getCharacteristic(characteristics.ftmsControlPoint), responseTimeout);
    await point.send(ftms.encodeRequestControl());

    let range = ftms.defaultPowerRange;
    try {
        const read = await (await service.getCharacteristic(characteristics.supportedPowerRange)).readValue();
        range = ftms.parseSupportedPowerRange(read) ?? range;
    } catch(error) {
        console.warn('vigo: no supported power range', error);
    }

    const power = await optionalService(server, services.cyclingPower);
    if(power) {
        await subscribe(power, characteristics.cyclingPowerMeasurement, parseCyclingPower, onPower);
    } else {
        await subscribe(service, characteristics.indoorBikeData, ftms.parseIndoorBikeData, (data) => {
            if(data.power !== undefined) onPower({power: data.power});
            if(data.cadence !== undefined) onCadence(data.cadence);
        });
    }

    // a paused trainer needs a start before it takes a target again
    let started = false;
    const writer = LatestWriter(async (command) => {
        if(command.release) {
            started = false;
            await point.send(ftms.encodePause());
            return;
        }
        if(!started) {
            await point.send(ftms.encodeStart());
            started = true;
        }
        await point.send(ftms.encodeTargetPower(command.watts, range));
    }, {
        onError: (error) => console.warn('vigo: trainer write failed', error),
    });

    return Object.freeze({
        protocol: 'FTMS',
        setTarget: (watts) => writer.push({watts}),
        release: () => writer.push({release: true}),
    });
}

// a Rampa is driven through the Elite service even if its firmware also has FTMS; an Elite service
// without the brake characteristic (other Elite models, untested) falls through to FTMS
//
// {onPower, onCadence, onOutOfRange} -> (BluetoothRemoteGATTServer) -> {protocol, setTarget, release}
export function trainerSetup({onPower, onCadence = () => {}, onOutOfRange, responseTimeout = 3000}) {
    return async function(server) {
        const elite = await optionalService(server, services.elite);
        const brake = elite && await optionalCharacteristic(elite, characteristics.eliteBrake);
        if(brake) return eliteLink(server, elite, brake, {onPower, onOutOfRange});
        const machine = await optionalService(server, services.fitnessMachine);
        if(machine) return ftmsLink(server, machine, {onPower, onCadence, responseTimeout});
        if(elite) throw new Error('This trainer has the Elite service but no brake control, and no FTMS');
        throw new Error('This trainer has neither the Elite nor the FTMS control service');
    };
}

export function heartRateSetup({onHeartRate}) {
    return async function(server) {
        const service = await server.getPrimaryService(services.heartRate);
        await subscribe(service, characteristics.heartRateMeasurement, parseHeartRate, onHeartRate);
        return {};
    };
}

export function speedCadenceSetup({onSpeedCadence}) {
    return async function(server) {
        const service = await server.getPrimaryService(services.speedCadence);
        await subscribe(service, characteristics.speedCadenceMeasurement, parseSpeedCadence, onSpeedCadence);
        return {};
    };
}
