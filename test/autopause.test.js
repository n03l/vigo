import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PedalWatch } from '../src/workout/autopause.js';

// ([[t, pedaling]]) -> [event], the events of a run of updates
const run = (watch, steps) => steps.map(([t, pedaling]) => watch.update(t, pedaling));

test('stops after the delay without pedaling, once', () => {
    const watch = PedalWatch({delay: 5});
    assert.deepEqual(run(watch, [[0, true], [1, false], [5.9, false], [6, false], [7, false], [20, false]]),
        [undefined, undefined, undefined, 'stopped', undefined, undefined]);
});

test('pedaling again after a stop is reported once', () => {
    const watch = PedalWatch({delay: 5});
    assert.deepEqual(run(watch, [[0, false], [5, false], [6, true], [7, true], [8, false]]),
        [undefined, 'stopped', 'pedaling', undefined, undefined]);
});

test('short gaps in pedaling do not stop it', () => {
    const watch = PedalWatch({delay: 10});
    assert.deepEqual(run(watch, [[0, false], [9, false], [9.5, true], [10, false], [19, false], [20, false]]),
        [undefined, undefined, undefined, undefined, undefined, 'stopped']);
});

test('reset starts the wait again', () => {
    const watch = PedalWatch({delay: 5});
    run(watch, [[0, false], [5, false]]);
    watch.reset();
    assert.deepEqual(run(watch, [[6, true], [7, false], [11, false], [12, false]]),
        [undefined, undefined, undefined, 'stopped']);
});

test('a delay of 0 is off', () => {
    const watch = PedalWatch({delay: 0});
    assert.deepEqual(run(watch, [[0, false], [100, false], [101, true]]), [undefined, undefined, undefined]);
});
