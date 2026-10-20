import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { decide, afterDownload, dataHash, hashText, isBlank, syncData, mergeBoth, parseSyncState, parseRemoteFile } from '../src/store/sync.js';
import { makeBackup, readBackup, maxRides } from '../src/store/backup.js';
import { packRide } from '../src/record/recorder.js';

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
const hostile = '<img src=x onerror=alert(1)>';
const synced = {fileId: 'f1', version: '7', hash: 'abc'};

function ride(start, workoutName = 'Sweet Spot') {
    return {
        workoutName, ftp: 250, maxHr: 190, hrZones: [95, 114, 133, 152, 171], devices: [], laps: [],
        events: [{t: start, type: 'start'}],
        samples: [0, 1, 2].map((i) => ({t: start + i, power: 200 + i, heartRate: 140, cadence: 90, speed: 8, distance: 8 * i})),
    };
}

const settings = {ftp: 250, wheel: 2105, sound: true, autoPause: 0, autoStart: false, maxHr: 190, hrZones: [95, 114, 133, 152, 171]};
const workout = (name, at) => ({fileName: name, text: fixture(name), addedAt: at, lastUsedAt: at});

function data({workouts = [workout('short.mrc', 5)], rides = [ride(1000)]} = {}) {
    return syncData({settings, workouts, rides: rides.map((r) => ({...packRide(r), interrupted: false}))});
}

// what a device reads back after taking a Drive file: the same steps as remoteData in app.js
function throughDrive(d) {
    const b = readBackup(JSON.stringify(makeBackup(d)));
    return syncData({settings: b.settings, workouts: b.workouts, rides: b.rides.map(({ride, interrupted}) => ({...packRide(ride), interrupted}))});
}

test('decide: every row of the table', () => {
    assert.equal(decide('abc', {}, null), 'create');
    assert.equal(decide('abc', synced, null), 'create');
    assert.equal(decide('abc', synced, {id: 'f1', version: '7'}), 'none');
    assert.equal(decide('xyz', synced, {id: 'f1', version: '7'}), 'push');
    assert.equal(decide('abc', synced, {id: 'f1', version: '9'}), 'pull');
    assert.equal(decide('xyz', synced, {id: 'f1', version: '9'}), 'conflict');
});

test('decide: a fresh device takes Drive, one with its own data asks', () => {
    assert.equal(decide('xyz', {}, {id: 'f1', version: '3'}, true), 'pull');
    assert.equal(decide('xyz', {}, {id: 'f1', version: '3'}), 'conflict');
});

test('decide: deleting everything after a sync is a change, never undone silently', () => {
    assert.equal(decide('blank', synced, {id: 'f1', version: '9'}, true), 'conflict');
    assert.equal(decide('blank', synced, {id: 'f1', version: '7'}, true), 'push');
});

test('decide: a different file is a change on Drive', () => {
    assert.equal(decide('abc', synced, {id: 'f2', version: '7'}), 'pull');
});

test('afterDownload', () => {
    const base = {local: 'L', localNow: 'L', synced: 'S', canTake: true};
    assert.equal(afterDownload('conflict', {...base, remote: 'L'}), 'record');
    // Drive's version moved but not its content
    assert.equal(afterDownload('conflict', {...base, remote: 'S'}), 'push');
    assert.equal(afterDownload('pull', {...base, local: 'S', localNow: 'S', remote: 'R'}), 'take');
    assert.equal(afterDownload('conflict', {...base, remote: 'R'}), 'conflict');
    // a ride in progress, or a change during the download
    assert.equal(afterDownload('pull', {...base, local: 'S', localNow: 'S', canTake: false, remote: 'R'}), 'conflict');
    assert.equal(afterDownload('pull', {...base, local: 'S', localNow: 'E', remote: 'R'}), 'conflict');
    // never pushes over Drive on a first sync
    assert.equal(afterDownload('conflict', {...base, synced: undefined, remote: 'R'}), 'conflict');
});

test('hashText and dataHash', () => {
    assert.equal(hashText('vigo'), hashText('vigo'));
    assert.notEqual(hashText('vigo'), hashText('vigp'));
    assert.match(hashText(''), /^[0-9a-z]+$/);
    assert.equal(dataHash({a: 1, b: [1, {c: 2, d: 3}]}), dataHash({b: [1, {d: 3, c: 2}], a: 1}));
    assert.notEqual(dataHash({a: 1}), dataHash({a: 2}));
});

test('data hashes the same after a trip through Drive', () => {
    const d = data({rides: [ride(2000), ride(1000, hostile)], workouts: [workout('steps.erg', 9), workout('short.mrc', 5)]});
    assert.equal(dataHash(throughDrive(d)), dataHash(d));
    assert.equal(dataHash(throughDrive(throughDrive(d))), dataHash(d));
});

test('syncData puts things in order and keeps each workout text and ride start once', () => {
    const d = syncData({
        settings,
        workouts: [workout('steps.erg', 9), {...workout('short.mrc', 5), lastUsedAt: 50}, {...workout('short.mrc', 7), lastUsedAt: 70}, {text: 42}, null],
        rides: [ride(2000), ride(1000), ride(1000, 'again'), {samples: 'x'}, null].map((r) => (r?.samples?.map ? {...packRide(r), interrupted: true} : r)),
    });
    assert.deepEqual(d.workouts.map((w) => [w.fileName, w.addedAt, w.lastUsedAt]), [['short.mrc', 5, 70], ['steps.erg', 9, 9]]);
    assert.deepEqual(d.rides.map((r) => [r.samples[0][0], r.workoutName, r.interrupted]), [[1000, 'Sweet Spot', true], [2000, 'Sweet Spot', true]]);
});

test('isBlank: no uploads and no rides', () => {
    assert.equal(isBlank(data({workouts: [], rides: []})), true);
    assert.equal(isBlank(data({rides: []})), false);
    assert.equal(isBlank(data({workouts: []})), false);
});

test('mergeBoth keeps both sides and this device’s settings', () => {
    const local = data({rides: [ride(1000)], workouts: [workout('short.mrc', 5)]});
    const remote = {...data({rides: [ride(1000, 'theirs'), ride(3000)], workouts: [workout('steps.erg', 6)]}), settings: {...settings, ftp: 300}};
    const merged = mergeBoth(local, remote);
    assert.deepEqual(merged.rides.map((r) => [r.samples[0][0], r.workoutName]), [[1000, 'Sweet Spot'], [3000, 'Sweet Spot']]);
    assert.equal(merged.workouts.length, 2);
    assert.equal(merged.settings.ftp, 250);
    // what it saves loads back
    assert.equal(dataHash(throughDrive(merged)), dataHash(merged));
});

test('mergeBoth refuses a result over the limits', () => {
    const many = (from) => Array.from({length: maxRides / 2 + 1}, (_, i) => ({...packRide(ride(from + i * 10)), interrupted: false}));
    const local = {settings, workouts: [], rides: many(0)};
    const remote = {settings, workouts: [], rides: many(1e7)};
    assert.throws(() => mergeBoth(local, remote), /more than/);
});

test('parseSyncState keeps valid fields and drops hostile ones', () => {
    const s = {fileId: 'a-B_1', version: '12', hash: 'k3j9', syncedAt: '2026-10-26T10:00:00.000Z', account: '0123'};
    assert.deepEqual(parseSyncState(s), s);
    assert.deepEqual(parseSyncState({}), {});
    for(const bad of [null, [], 'x', 42]) assert.equal(parseSyncState(bad), null);
    assert.deepEqual(parseSyncState({fileId: '../x?y', version: 12, hash: hostile, syncedAt: 'soon', account: hostile}), {});
    assert.deepEqual(parseSyncState(JSON.parse('{"__proto__": {"fileId": "f1"}}')), {});
});

test('parseRemoteFile accepts a Drive description and nothing else', () => {
    assert.deepEqual(parseRemoteFile({id: 'f1', version: '3', name: 'x'}), {id: 'f1', version: '3'});
    assert.throws(() => parseRemoteFile({id: 'f/1', version: '3'}));
    assert.throws(() => parseRemoteFile({id: 'f1', version: 3}));
    assert.throws(() => parseRemoteFile({id: hostile, version: '3'}));
    assert.throws(() => parseRemoteFile(JSON.parse('{"__proto__": {"id": "f1", "version": "3"}}')));
    assert.throws(() => parseRemoteFile(null));
});
