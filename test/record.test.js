import { test } from 'node:test';
import assert from 'node:assert/strict';

import { encodeActivity, summarize, crc16 } from '../src/record/fit.js';
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
                values[f.num] = f.size === 1 ? view.getUint8(i) : f.size === 2 ? view.getUint16(i, true) : view.getUint32(i, true);
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
