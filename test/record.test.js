import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeActivity, summarize, normalizedPower, crc16 } from '../src/record/fit.js';
import { Recorder, loadSavedRide, clearSavedRide } from '../src/record/recorder.js';

function memoryStorage() {
    const items = new Map();
    return {
        getItem: (k) => (items.has(k) ? items.get(k) : null),
        setItem: (k, v) => items.set(k, String(v)),
        removeItem: (k) => items.delete(k),
        items,
    };
}

// a small FIT reader, enough to check what the encoder wrote
function readFit(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headerSize = view.getUint8(0);
    const dataSize = view.getUint32(4, true);
    assert.equal(headerSize, 14);
    assert.equal(String.fromCharCode(...bytes.slice(8, 12)), '.FIT');
    assert.equal(view.getUint16(12, true), crc16(bytes, 0, 12), 'header crc');
    assert.equal(bytes.length, headerSize + dataSize + 2);
    assert.equal(view.getUint16(headerSize + dataSize, true), crc16(bytes, 0, headerSize + dataSize), 'file crc');
    assert.equal(crc16(bytes), 0, 'crc over the whole file is 0');

    const definitions = {};
    const out = [];
    let i = headerSize;
    while(i < headerSize + dataSize) {
        const header = view.getUint8(i++);
        assert.equal(header & 0x80, 0, 'no compressed timestamps');
        const local = header & 0x0f;
        if(header & 0x40) {
            assert.equal(view.getUint8(i + 1), 0, 'little endian');
            const num = view.getUint16(i + 2, true);
            const count = view.getUint8(i + 4);
            i += 5;
            const fields = [];
            for(let f = 0; f < count; f++) {
                fields.push({num: view.getUint8(i), size: view.getUint8(i + 1), type: view.getUint8(i + 2)});
                i += 3;
            }
            definitions[local] = {num, fields};
        } else {
            const def = definitions[local];
            assert.ok(def, `data message for undefined local type ${local}`);
            const values = {};
            for(const f of def.fields) {
                if(f.type === 0x07) {
                    const raw = bytes.slice(i, i + f.size);
                    assert.equal(raw[f.size - 1], 0, 'strings are null terminated');
                    values[f.num] = new TextDecoder().decode(raw.slice(0, raw.indexOf(0)));
                } else {
                    values[f.num] = f.size === 1 ? view.getUint8(i) : f.size === 2 ? view.getUint16(i, true) : view.getUint32(i, true);
                }
                i += f.size;
            }
            out.push({num: def.num, values});
        }
    }
    return out;
}

const fitEpoch = 631065600;
const t0 = 1792500000; // 2026-10-20

function sampleRide() {
    const storage = memoryStorage();
    const r = Recorder({storage});
    r.start({t: t0, workoutName: 'Test'});
    for(let s = 0; s < 5; s++) {
        r.sample({t: t0 + s, power: 200 + s, heartRate: s === 0 ? null : 140, cadence: 90, speed: 10});
    }
    r.pause(t0 + 5);
    r.resume(t0 + 65);
    for(let s = 0; s < 5; s++) r.sample({t: t0 + 65 + s, power: 100, heartRate: 150, cadence: 0, speed: undefined});
    return {r, storage};
}

test('summary', () => {
    const {r} = sampleRide();
    const s = summarize(r.ride);
    assert.equal(s.totalTimerTime, 10);
    assert.equal(s.totalElapsedTime, 70);
    assert.equal(s.avgPower, 151);
    assert.equal(s.maxPower, 204);
    assert.equal(s.totalDistance, 50);
    assert.equal(s.avgCadence, 90);
    assert.equal(s.maxHeartRate, 150);
    assert.equal(s.avgHeartRate, (140 * 4 + 150 * 5) / 9);
});

test('FIT file is valid and has the expected messages', () => {
    const {r} = sampleRide();
    const messages = readFit(encodeActivity(r.ride, {timezoneOffset: -120}));
    const nums = messages.map((m) => m.num);

    assert.equal(nums[0], 0, 'file_id first');
    assert.deepEqual(nums.slice(-3), [19, 18, 34], 'lap, session, activity last');
    assert.equal(nums.indexOf(20) > nums.lastIndexOf(7), true, 'header messages before the records');
    assert.equal(nums.filter((n) => n === 20).length, 10, '10 records');

    const records = messages.filter((m) => m.num === 20);
    assert.equal(records[0].values[253], t0 - fitEpoch);
    assert.equal(records[0].values[7], 200);
    assert.equal(records[0].values[3], 0xff, 'missing heart rate is invalid');
    assert.equal(records[1].values[3], 140);
    assert.equal(records[0].values[6], 10000, 'speed in mm/s');
    assert.equal(records[4].values[5], 5000, 'distance in cm');
    assert.equal(records[5].values[6], 0xffff, 'missing speed is invalid');

    const events = messages.filter((m) => m.num === 21).map((m) => [m.values[253] - (t0 - fitEpoch), m.values[1]]);
    assert.deepEqual(events, [[0, 0], [5, 4], [65, 0], [70, 4]]);

    const session = messages.find((m) => m.num === 18).values;
    assert.equal(session[5], 2, 'cycling');
    assert.equal(session[6], 6, 'indoor cycling');
    assert.equal(session[8], 10000, 'timer time ms');
    assert.equal(session[7], 70000, 'elapsed time ms');
    assert.equal(session[20], 151);

    const activity = messages.find((m) => m.num === 34).values;
    assert.equal(activity[5] - activity[253], 7200, 'local timestamp');
});

test('FIT export refuses an empty ride', () => {
    assert.throws(() => encodeActivity({samples: [], events: []}), /no samples/);
});

test('recorder autosaves and the saved ride loads back', () => {
    const {r, storage} = sampleRide();
    r.save();
    const ride = loadSavedRide(storage);
    assert.equal(ride.workoutName, 'Test');
    assert.equal(ride.samples.length, 10);
    assert.deepEqual(ride.samples[0], {t: t0, power: 200, heartRate: null, cadence: 90, speed: 10, distance: 10});
    assert.deepEqual(ride.events.map((e) => e.type), ['start', 'stop', 'start']);
    clearSavedRide(storage);
    assert.equal(loadSavedRide(storage), undefined);
});

test('a tampered saved ride is cleaned or ignored', () => {
    const storage = memoryStorage();
    storage.setItem('vigo.ride', '{not json');
    assert.equal(loadSavedRide(storage), undefined);
    storage.setItem('vigo.ride', JSON.stringify({version: 1, samples: 'x', events: []}));
    assert.equal(loadSavedRide(storage), undefined);
    storage.setItem('vigo.ride', JSON.stringify({
        version: 1,
        workoutName: {toString: 1},
        events: [{t: 1, type: 'start'}, {t: 'x', type: 'start'}, {t: 2, type: '<b>'}],
        samples: [[t0, '200', 140, null, 1, 1], 'junk', [null, 1], [t0 + 1, 1e400, 140, 90, 1, 2]],
    }));
    const ride = loadSavedRide(storage);
    assert.equal(ride.workoutName, '');
    assert.deepEqual(ride.events, [{t: 1, type: 'start'}]);
    assert.equal(ride.samples.length, 2);
    assert.equal(ride.samples[0].power, null);
    assert.equal(ride.samples[1].power, null);
    // still encodes
    readFit(encodeActivity(ride));
});

test('recorder survives storage that throws', () => {
    const storage = {getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); }};
    const warn = console.warn;
    console.warn = () => {};
    try {
        const r = Recorder({storage});
        r.start({t: t0});
        r.sample({t: t0, power: 1});
        r.clear();
        assert.equal(loadSavedRide(storage), undefined);
    } finally {
        console.warn = warn;
    }
});

function intervalRide() {
    const r = Recorder({storage: memoryStorage()});
    r.start({
        t: t0, workoutName: 'Sweet spot 45m', ftp: 200, maxHr: 190, hrZones: [95, 114, 133, 152, 171],
        devices: [{kind: 'trainer', name: 'RAMPA 12345'}, {kind: 'hr', name: 'HRM-Fake'}],
    });
    for(let s = 0; s < 120; s++) {
        if(s === 60) r.lap(t0 + s);
        r.sample({t: t0 + s, power: s < 60 ? 100 : 300, heartRate: 140, cadence: s < 60 ? 85 : 95, speed: 10});
    }
    return r.ride;
}

test('FIT file carries the workout name, sport, devices and zones', () => {
    const messages = readFit(encodeActivity(intervalRide()));
    const one = (num) => messages.find((m) => m.num === num).values;

    assert.equal(one(49)[0], 100, 'file_creator software version 1.00');
    const devices = messages.filter((m) => m.num === 23).map((m) => [m.values[0], m.values[27], m.values[1], m.values[25]]);
    assert.deepEqual(devices, [[0, 'vigo', 0xff, 5], [1, 'RAMPA 12345', 7, 3], [2, 'HRM-Fake', 1, 3]]);
    assert.deepEqual(one(12), {0: 2, 1: 6, 3: 'Indoor cycling'});
    assert.equal(one(26)[8], 'Sweet spot 45m');
    assert.equal(one(26)[4], 2);
    assert.equal(one(26)[11], 6);
    assert.deepEqual(one(7), {1: 190, 3: 200, 5: 1, 7: 1}, 'standard zones are % of max HR');
    assert.deepEqual(messages.filter((m) => m.num === 8).map((m) => m.values[1]), [95, 114, 133, 152, 171, 190]);
});

test('FIT file has a lap per workout interval and NP, IF and TSS in the session', () => {
    const messages = readFit(encodeActivity(intervalRide()));
    const laps = messages.filter((m) => m.num === 19).map((m) => m.values);
    assert.equal(laps.length, 2);
    assert.deepEqual(laps.map((l) => [l[254], l[2] - (t0 - fitEpoch), l[8], l[19], l[18], l[9]]),
        [[0, 0, 60000, 100, 85, 60000], [1, 60, 60000, 300, 95, 60000]]);
    assert.deepEqual(laps.map((l) => l[24]), [1, 7], 'time, then session end');

    const session = messages.find((m) => m.num === 18).values;
    assert.equal(session[26], 2, 'num laps');
    assert.equal(session[45], 200, 'threshold power');
    assert.equal(session[48], 60 * 100 + 60 * 300, 'total work in J');
    assert.equal(session[19], 95, 'max cadence');
    const np = normalizedPower(intervalRide().samples.map((s) => s.power));
    assert.equal(session[34], Math.round(np));
    assert.equal(session[36], Math.round(np / 200 * 1000));
    assert.equal(session[35], Math.round(120 * np * (np / 200) / (200 * 3600) * 100 * 10));
});

test('normalized power: steady power is itself, and needs 30 seconds', () => {
    assert.equal(normalizedPower(Array(29).fill(200)), undefined);
    assert.equal(Math.round(normalizedPower(Array(600).fill(200))), 200);
    const surges = Array.from({length: 600}, (_, i) => (Math.floor(i / 60) % 2 ? 300 : 100));
    assert.ok(normalizedPower(surges) > 200);
});

test('custom zones and odd strings are written safely', () => {
    const ride = {...intervalRide(), hrZones: [100, 120, 140, 160, 180], workoutName: 'é'.repeat(40) + '<img src=x onerror=alert(1)>'};
    const messages = readFit(encodeActivity(ride));
    assert.equal(messages.find((m) => m.num === 7).values[5], 0, 'custom zones');
    const name = messages.find((m) => m.num === 26).values[8];
    assert.equal(name, 'é'.repeat(31), 'cut on a character boundary inside 63 bytes');
});

test('a ride without zones, devices or name still encodes', () => {
    const {r} = sampleRide();
    const messages = readFit(encodeActivity({...r.ride, workoutName: ''}));
    assert.equal(messages.some((m) => m.num === 26), false, 'no workout message without a name');
    assert.equal(messages.some((m) => m.num === 8), false);
    assert.equal(messages.filter((m) => m.num === 19).length, 1);
});

test('laps add up to the session, also with a pause at an interval change', () => {
    const r = Recorder({storage: memoryStorage()});
    r.start({t: t0, workoutName: 'W', ftp: 200});
    for(let s = 0; s < 40; s++) r.sample({t: t0 + s, power: 150, speed: 5});
    r.pause(t0 + 40);
    r.resume(t0 + 100);
    r.lap(t0 + 100);
    for(let s = 0; s < 20; s++) r.sample({t: t0 + 100 + s, power: 250, speed: 5});
    r.lap(t0 + 120);
    for(let s = 0; s < 10; s++) r.sample({t: t0 + 120 + s, power: 100, speed: 5});
    const messages = readFit(encodeActivity(r.ride));
    const laps = messages.filter((m) => m.num === 19).map((m) => m.values);
    const session = messages.find((m) => m.num === 18).values;
    assert.deepEqual(laps.map((l) => [l[2] - (t0 - fitEpoch), l[253] - (t0 - fitEpoch), l[7], l[8]]),
        [[0, 100, 100000, 40000], [100, 120, 20000, 20000], [120, 130, 10000, 10000]]);
    for(const [field, total] of [[7, 'elapsed'], [8, 'timer'], [9, 'distance']]) {
        assert.equal(laps.reduce((sum, l) => sum + l[field], 0), session[field], `lap ${total} times add up`);
    }
});
