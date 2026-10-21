import { test } from 'node:test';
import assert from 'node:assert/strict';

import { builtins } from '../src/workout/builtin.js';
import { workoutId, fromRecord, mergeLibrary, describe } from '../src/store/library.js';
import { parseWorkout } from '../src/workout/parse.js';
import { packRide, sanitizeRide } from '../src/record/recorder.js';
import { MemoryStore } from '../src/store/db.js';

const mrc = (name, rows) => `[COURSE HEADER]\nFILE NAME = ${name}\nMINUTES PERCENT\n[END COURSE HEADER]\n[COURSE DATA]\n${rows}\n[END COURSE DATA]\n`;

test('built-in workouts parse and have the planned lengths', () => {
    const minutes = Object.fromEntries(builtins.map((b) => [b.id, b.workout.duration / 60]));
    assert.deepEqual(minutes, {
        'b-recovery': 30,
        'b-endurance': 60,
        'b-tempo-3x10': 60,
        'b-sweet-spot-3x10': 60,
        'b-threshold-2x20': 70,
        'b-vo2max-5x3': 55,
        'b-40-20s': 55,
    });
    for(const b of builtins) {
        assert.equal(b.builtin, true);
        assert.equal(b.workout.name, b.name);
        assert.deepEqual(parseWorkout(b.text), b.workout, `${b.id} text round trips`);
    }
});

test('the 40/20s have 24 efforts of 40 s at 120%', () => {
    const w = builtins.find((b) => b.id === 'b-40-20s').workout;
    const efforts = w.segments.filter((s) => s.from === 120 && s.to === 120);
    assert.equal(efforts.length, 24);
    for(const s of efforts) assert.ok(Math.abs(s.duration - 40) < 0.01, s.duration);
});

test('workout ids are stable and depend only on the text', async () => {
    const a = await workoutId(mrc('A', '0 50\n1 50'));
    assert.match(a, /^u-[0-9a-f]{16}$/);
    assert.equal(await workoutId(mrc('A', '0 50\n1 50')), a);
    assert.notEqual(await workoutId(mrc('A', '0 50\n1 51')), a);
});

test('records from storage are parsed again, damaged ones are dropped', () => {
    const good = {id: 'u-0123456789abcdef', fileName: 'a.mrc', text: mrc('Hard', '0 50\n1 50'), addedAt: 1, lastUsedAt: 2};
    const entry = fromRecord(good);
    assert.equal(entry.name, 'Hard');
    assert.equal(entry.builtin, false);

    assert.equal(fromRecord({...good, id: 'b-recovery'}), undefined, 'cannot shadow a built-in');
    assert.equal(fromRecord({...good, id: '__proto__'}), undefined);
    assert.equal(fromRecord({...good, text: 'garbage'}), undefined);
    assert.equal(fromRecord({...good, text: 42}), undefined);
    assert.equal(fromRecord(null), undefined);
    assert.equal(fromRecord({...good, addedAt: 'x'}).addedAt, 0);
});

test('library lists uploads by last use, then the built-ins, without duplicates', () => {
    const up = (id, lastUsedAt) => ({id, lastUsedAt, addedAt: 0, builtin: false});
    const list = mergeLibrary(builtins, [up('u-1', 10), up('u-2', 30), up('u-3', 20), up('u-2', 5)]);
    assert.deepEqual(list.slice(0, 3).map((e) => e.id), ['u-2', 'u-3', 'u-1']);
    assert.equal(list.length, 3 + builtins.length);
    assert.equal(list[3].id, 'b-recovery');
});

test('describe gives duration, average watts and how values scale', () => {
    const w = parseWorkout(mrc('X', '0 50\n10 50\n10 100\n20 100'));
    const d = describe(w, 200);
    assert.equal(d.duration, 1200);
    assert.equal(d.avgWatts, 150);
    assert.equal(d.intensity, 0.75);
    assert.equal(d.scaling, '% of FTP');
    const erg = parseWorkout('[COURSE HEADER]\nFTP=250\nMINUTES WATTS\n[END COURSE HEADER]\n[COURSE DATA]\n0 250\n1 250\n');
    assert.equal(describe(erg, 200).avgWatts, 200);
});

test('rides pack and sanitize back to the same ride', () => {
    const ride = {
        workoutName: 'W', ftp: 250, maxHr: 190, hrZones: [95, 114, 133, 152, 171],
        devices: [{kind: 'hr', name: 'HRM'}], laps: [12, 20],
        events: [{t: 10, type: 'start'}],
        samples: [{t: 10, power: 200, heartRate: null, cadence: 90, speed: 8, distance: 8}],
    };
    assert.deepEqual(sanitizeRide(structuredClone(packRide(ride))), ride);
});

test('a ride saved before laps, zones and devices still loads', () => {
    const ride = sanitizeRide({workoutName: 'W', ftp: 250, events: [{t: 10, type: 'start'}], samples: [[10, 200]]});
    assert.deepEqual([ride.laps, ride.maxHr, ride.hrZones, ride.devices], [[], null, null, []]);
});

test('sanitizeRide cleans laps, zones and devices', () => {
    const ride = sanitizeRide({
        events: [], samples: [[1, 200]],
        laps: [5, 3, 'x', 8, 8, Infinity, 9],
        hrZones: [100, 90, 120, 130, 140],
        devices: [{kind: 'hr', name: 'a\u0000<img src=x onerror=alert(1)>'.repeat(5)}, {kind: '__proto__', name: 'x'}, null],
    });
    assert.deepEqual(ride.laps, [5, 8, 9]);
    assert.equal(ride.hrZones, null);
    assert.equal(ride.devices.length, 1);
    assert.equal(ride.devices[0].name.length, 40);
    assert.ok(!/\u0000/.test(ride.devices[0].name));
});

test('sanitizeRide drops what does not belong', () => {
    assert.equal(sanitizeRide(undefined), undefined);
    assert.equal(sanitizeRide({samples: [], events: []}), undefined);
    assert.equal(sanitizeRide({samples: {length: 1}, events: []}), undefined);
    const ride = sanitizeRide({
        workoutName: '<img src=x onerror=alert(1)>'.repeat(20),
        ftp: '250',
        events: [{t: 1, type: 'start'}, {t: 2, type: 'boom'}, null],
        samples: [[1, 200, 'x', 90, null, 1], [Infinity, 1], {t: 2}],
    });
    assert.equal(ride.workoutName.length, 120);
    assert.equal(ride.ftp, null);
    assert.deepEqual(ride.events, [{t: 1, type: 'start'}]);
    assert.deepEqual(ride.samples, [{t: 1, power: 200, heartRate: null, cadence: 90, speed: null, distance: 1}]);
});

test('memory store keeps rides and their data together and returns copies', async () => {
    const store = MemoryStore();
    assert.equal(store.persistent, false);
    await store.putRide({id: 'r-1', startedAt: 1}, {id: 'r-1', samples: [[1]]});
    const meta = await store.get('rides', 'r-1');
    meta.startedAt = 99;
    assert.equal((await store.get('rides', 'r-1')).startedAt, 1);
    assert.deepEqual((await store.get('rideData', 'r-1')).samples, [[1]]);
    await store.deleteRide('r-1');
    assert.deepEqual(await store.getAll('rides'), []);
    assert.equal(await store.get('rideData', 'r-1'), undefined);
});

test('describe reports the peak after the cap', () => {
    const w = parseWorkout(mrc('Sprints', '0 50\n1 50\n1 250\n1.2 250'));
    assert.deepEqual([describe(w, 200).peakWatts, describe(w, 200).peakCapped], [400, true]);
    const easy = parseWorkout(mrc('Easy', '0 50\n10 60'));
    assert.deepEqual([describe(easy, 200).peakWatts, describe(easy, 200).peakCapped], [120, false]);
});

test('describe averages the capped watts', () => {
    const w = parseWorkout(mrc('Way too hard', '0 250\n1 250'));
    assert.equal(describe(w, 250).avgWatts, 500);
});
