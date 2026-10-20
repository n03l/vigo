import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultHrZones, validHrZones, hrZone } from '../src/workout/hrzones.js';

test('default zones are 50 to 90% of max heart rate', () => {
    assert.deepEqual(defaultHrZones(190), [95, 114, 133, 152, 171]);
    assert.deepEqual(defaultHrZones(200), [100, 120, 140, 160, 180]);
});

test('zones must be five whole numbers going up, up to max heart rate', () => {
    assert.ok(validHrZones([95, 114, 133, 152, 171], 190));
    assert.ok(!validHrZones([95, 114, 133, 152], 190));
    assert.ok(!validHrZones([95, 114, 114, 152, 171], 190));
    assert.ok(!validHrZones([95, 114, 133, 152, 191], 190));
    assert.ok(!validHrZones([30, 114, 133, 152, 171], 190));
    assert.ok(!validHrZones([95.5, 114, 133, 152, 171], 190));
    assert.ok(!validHrZones(['95', 114, 133, 152, 171], 190));
    assert.ok(!validHrZones({length: 5}, 190));
    assert.ok(!validHrZones(null, 190));
});

test('a heart rate falls in the zone whose lower bound it reached', () => {
    const zones = [95, 114, 133, 152, 171];
    assert.equal(hrZone(80, zones), 0);
    assert.equal(hrZone(95, zones), 1);
    assert.equal(hrZone(133, zones), 3);
    assert.equal(hrZone(151, zones), 3);
    assert.equal(hrZone(200, zones), 5);
    assert.equal(hrZone(undefined, zones), 0);
    assert.equal(hrZone(NaN, zones), 0);
});
