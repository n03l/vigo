import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { makeBackup, readBackup, backupFileName } from '../src/store/backup.js';
import { packRide } from '../src/record/recorder.js';

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

const ride = {
    workoutName: 'Sweet Spot',
    ftp: 250,
    maxHr: 190,
    hrZones: [95, 114, 133, 152, 171],
    devices: [{kind: 'trainer', name: 'RAMPA 12345'}],
    laps: [1000003],
    events: [{t: 1000000, type: 'start'}, {t: 1000005, type: 'stop'}],
    samples: [0, 1, 2, 3, 4].map((i) => ({t: 1000000 + i, power: 200 + i, heartRate: 140, cadence: 90, speed: 8, distance: 8 * i})),
};

function backupText() {
    const backup = makeBackup({
        settings: {ftp: 250, sound: false},
        workouts: [{id: 'u-0000000000000000', name: 'x', fileName: 'short.mrc', text: fixture('short.mrc'), addedAt: 5, lastUsedAt: 6, workout: {}}],
        rides: [{interrupted: true, ...packRide(ride)}],
    }, new Date('2026-10-29T10:00:00Z'));
    return JSON.stringify(backup);
}

test('a backup reads back what was written', () => {
    const read = readBackup(backupText());
    assert.deepEqual(read.settings, {ftp: 250, sound: false});
    assert.deepEqual(read.workouts, [{text: fixture('short.mrc'), fileName: 'short.mrc', addedAt: 5, lastUsedAt: 6}]);
    assert.equal(read.rides.length, 1);
    assert.equal(read.rides[0].interrupted, true);
    assert.deepEqual(read.rides[0].ride.samples, ride.samples);
    assert.deepEqual(read.rides[0].ride.laps, ride.laps);
    assert.equal(read.rides[0].ride.workoutName, 'Sweet Spot');
    assert.equal(read.skipped, 0);
});

test('only the workout fields are written, not the parsed workout or its id', () => {
    const backup = JSON.parse(backupText());
    assert.equal(backup.format, 'vigo-backup');
    assert.equal(backup.exportedAt, '2026-10-29T10:00:00.000Z');
    assert.deepEqual(Object.keys(backup.workouts[0]).sort(), ['addedAt', 'fileName', 'lastUsedAt', 'text']);
});

test('files that are not backups are refused', () => {
    assert.throws(() => readBackup('not json'), /not a vigo backup/);
    assert.throws(() => readBackup('[]'), /not a vigo backup/);
    assert.throws(() => readBackup('{"format": "other"}'), /not a vigo backup/);
    assert.throws(() => readBackup('{"format": "vigo-backup", "version": 2}'), /newer version/);
});

test('bad entries are skipped and counted, the rest is kept', () => {
    const backup = JSON.parse(backupText());
    backup.workouts.push({text: 'garbage'}, {text: 42}, null, {text: 'x'.repeat(2 * 1024 * 1024)});
    backup.rides.push({samples: 'no'}, null, [], {events: [], samples: [['x']]});
    const read = readBackup(JSON.stringify(backup));
    assert.equal(read.workouts.length, 1);
    assert.equal(read.rides.length, 1);
    assert.equal(read.skipped, 8);
});

test('a hostile workout name and odd field types come through as plain data', () => {
    const backup = JSON.parse(backupText());
    backup.workouts = [{text: fixture('hostile-name.mrc'), fileName: {toString: 1}, addedAt: 'soon', lastUsedAt: -5}];
    backup.rides[0].workoutName = '<img src=x onerror=alert(1)>';
    backup.rides[0].interrupted = 'yes';
    backup.settings = ['ftp'];
    const read = readBackup(JSON.stringify(backup));
    assert.deepEqual(read.workouts, [{text: fixture('hostile-name.mrc'), fileName: '', addedAt: 0, lastUsedAt: 0}]);
    assert.equal(read.rides[0].ride.workoutName, '<img src=x onerror=alert(1)>');
    assert.equal(read.rides[0].interrupted, false);
    assert.equal(read.settings, undefined);
});

test('__proto__ in the file does not reach the prototype', () => {
    const text = '{"format": "vigo-backup", "version": 1, "settings": {"__proto__": {"polluted": true}}, "workouts": [], "rides": []}';
    const read = readBackup(text);
    assert.equal(({}).polluted, undefined);
    assert.equal(read.settings.polluted, undefined);
});

test('backupFileName', () => {
    assert.equal(backupFileName(new Date(2026, 0, 5, 9, 0)), 'vigo-backup-20260105.json');
});
