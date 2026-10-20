import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCyclingPower } from '../src/ble/cps.js';
import { parseSpeedCadence } from '../src/ble/cscs.js';
import { parseHeartRate } from '../src/ble/hrs.js';
import { RevCounter } from '../src/ble/revs.js';
import { encodeTargetPower, encodeBrakeLevel, parseOutOfRange, LatestWriter } from '../src/ble/rampa.js';

const view = (bytes) => new DataView(new Uint8Array(bytes).buffer);
const array = (u8) => [...u8];

// byte sequences from the Auuki elite-rampa tests, checked on a Rampa with firmware 135
test('Rampa target power', () => {
    assert.deepEqual(array(encodeTargetPower(200)), [0x00, 0xc8, 0x00]);
    assert.deepEqual(array(encodeTargetPower(300)), [0x00, 0x2c, 0x01]);
    assert.deepEqual(array(encodeTargetPower(-10)), [0x00, 0x00, 0x00]);
    assert.deepEqual(array(encodeTargetPower(5000)), [0x00, 0xa0, 0x0f]);
    assert.deepEqual(array(encodeTargetPower(NaN)), [0x00, 0x00, 0x00]);
    assert.deepEqual(array(encodeTargetPower(199.6)), [0x00, 0xc8, 0x00]);
});

test('Rampa brake level and out of range', () => {
    assert.deepEqual(array(encodeBrakeLevel(0)), [0x01, 0x00]);
    assert.deepEqual(array(encodeBrakeLevel(200)), [0x01, 0xc8]);
    assert.deepEqual(array(encodeBrakeLevel(255)), [0x01, 0xc8]);
    assert.deepEqual(array(encodeBrakeLevel(-1)), [0x01, 0x00]);
    assert.equal(parseOutOfRange(view([0x01])), true);
    assert.equal(parseOutOfRange(view([0x00])), false);
    assert.equal(parseOutOfRange(view([])), false);
});

test('LatestWriter writes one at a time and drops stale values', async () => {
    const written = [];
    let release;
    const write = (v) => new Promise((resolve) => { written.push(v); release = resolve; });
    const writer = LatestWriter(write);

    const done = writer.push(1);
    writer.push(2);
    writer.push(3);
    assert.deepEqual(written, [1]);
    release();
    await new Promise((r) => setTimeout(r));
    assert.deepEqual(written, [1, 3]);
    release();
    await done;
    assert.equal(writer.busy, false);
});

test('LatestWriter keeps going after a failed write', async () => {
    const errors = [];
    const written = [];
    const writer = LatestWriter(async (v) => {
        written.push(v);
        if(v === 1) throw new Error('GATT operation failed');
    }, {onError: (e) => errors.push(e.message)});
    await writer.push(1);
    await writer.push(2);
    assert.deepEqual(written, [1, 2]);
    assert.deepEqual(errors, ['GATT operation failed']);
});

test('cycling power with crank data', () => {
    // flags 0x20 crank present, power 300, crank revs 18, time 0x04f7
    assert.deepEqual(parseCyclingPower(view([0x20, 0x00, 0x2c, 0x01, 0x12, 0x00, 0xf7, 0x04])),
        {power: 300, crankRevs: 18, crankTime: 0x04f7});
});

test('cycling power with wheel and crank data', () => {
    const data = parseCyclingPower(view([0x30, 0x00, 0x21, 0x00, 0x2a, 0x00, 0x00, 0x00, 0xc4, 0x60, 0x12, 0x00, 0xf7, 0x04]));
    assert.deepEqual(data, {power: 33, wheelRevs: 42, wheelTime: 0x60c4, crankRevs: 18, crankTime: 0x04f7});
});

test('cycling power skips balance and torque, tolerates truncation', () => {
    // balance + torque + crank
    assert.deepEqual(parseCyclingPower(view([0x25, 0x00, 0x64, 0x00, 0x32, 0x10, 0x00, 0x05, 0x00, 0x00, 0x04])),
        {power: 100, crankRevs: 5, crankTime: 0x0400});
    assert.deepEqual(parseCyclingPower(view([0x20, 0x00, 0x64, 0x00, 0x05])), {power: 100});
    assert.throws(() => parseCyclingPower(view([0x00, 0x00])), RangeError);
});

test('speed and cadence', () => {
    assert.deepEqual(parseSpeedCadence(view([0x03, 0x10, 0x00, 0x00, 0x00, 0x00, 0x04, 0x07, 0x00, 0x00, 0x08])),
        {wheelRevs: 16, wheelTime: 0x0400, crankRevs: 7, crankTime: 0x0800});
    assert.deepEqual(parseSpeedCadence(view([0x02, 0x07, 0x00, 0x00, 0x08])), {crankRevs: 7, crankTime: 0x0800});
    assert.deepEqual(parseSpeedCadence(view([0x01, 0x10])), {});
});

test('heart rate 8 and 16 bit', () => {
    assert.deepEqual(parseHeartRate(view([0x00, 0x8c])), {heartRate: 140});
    assert.deepEqual(parseHeartRate(view([0x16, 0x8c, 0x01, 0x00, 0x04])), {heartRate: 140}); // RR present
    assert.deepEqual(parseHeartRate(view([0x01, 0x2c, 0x01])), {heartRate: 300});
    assert.throws(() => parseHeartRate(view([0x01, 0x2c])), RangeError);
});

test('rev counter: rate, repeated events, timeout, rollover', () => {
    const c = RevCounter({timeout: 3000});
    assert.equal(c.update(10, 1024, 0), 0);
    assert.equal(c.update(11, 2048, 1000), 1); // 1 rev in 1 s
    assert.equal(c.update(11, 2048, 1500), 1); // same event repeated, hold
    assert.equal(c.value(3900), 1);
    assert.equal(c.value(4100), 0);            // no event for > 3 s
    // rollover of both counters
    const r = RevCounter();
    r.update(65535, 65024, 0);                 // 65024 = 63.5 s
    assert.equal(r.update(1, 512, 1000), 2);   // 2 revs in 1 s across the wrap
});

test('rev counter ignores absurd rates', () => {
    const c = RevCounter({maxRate: 4});
    c.update(0, 0, 0);
    assert.equal(c.update(1, 1024, 1000), 1);
    assert.equal(c.update(500, 2048, 2000), 1);
    assert.equal(c.update(502, 3072, 3000), 2);
});
