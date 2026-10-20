import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cueTimes, cueAt, nextCue } from '../src/workout/cues.js';
import { builtins } from '../src/workout/builtin.js';

const builtin = (name) => builtins.find((b) => b.name === name).workout;

// [[seconds, from, to?]] -> workout in % of FTP
function workoutOf(steps) {
    let start = 0;
    const segments = steps.map(([duration, from, to = from]) => {
        const s = {start, duration, from, to};
        start += duration;
        return s;
    });
    return {unit: 'pct', duration: start, segments};
}

test('cues at every work/recovery switch of the built-ins', () => {
    assert.deepEqual(cueTimes(builtin('Sweet Spot 3×10'), 250), [600, 1200, 1500, 2100, 2400, 3000]);
    // after the last interval, 3 + 3 min at the same 50% are one stretch: the next cue is the cool-down
    assert.deepEqual(cueTimes(builtin('VO2max 5×3'), 250),
        [900, 1080, 1260, 1440, 1620, 1800, 1980, 2160, 2340, 2520, 2700]);
    assert.equal(cueTimes(builtin('40/20s'), 250).length, 3 * 16 + 1);
});

test('a ramp of small steps has no cues, the jump after it has one', () => {
    const ramp = Array.from({length: 100}, (_, i) => [1, 40 + i * 0.4]);
    assert.deepEqual(cueTimes(workoutOf(ramp), 250), []);
    assert.deepEqual(cueTimes(workoutOf([...ramp, [60, 100]]), 250), [100]);
});

test('jumps under 5% of FTP are not cues, in watts files too', () => {
    assert.deepEqual(cueTimes(workoutOf([[60, 50], [60, 54], [60, 59]]), 250), [120]);
    const watts = {unit: 'watts', duration: 120, segments: [
        {start: 0, duration: 60, from: 200, to: 200},
        {start: 60, duration: 60, from: 212, to: 212},
    ]};
    assert.deepEqual(cueTimes(watts, 250), []);     // 12 W is 4.8% of 250
    assert.deepEqual(cueTimes(watts, 200), [60]);   // and 6% of 200
});

test('cueAt counts down 5 seconds, then goes', () => {
    const times = [600, 1200];
    const at = (s) => cueAt(times, s);
    assert.deepEqual([594, 595, 596, 597, 598, 599, 600, 601].map(at),
        [undefined, 'count', 'count', 'count', 'count', 'count', 'go', undefined]);
    assert.equal(at(0), undefined);
    assert.equal(at(1199), 'count');
    assert.equal(at(1200), 'go');
    assert.equal(at(1201), undefined);
    assert.equal(cueAt([], 10), undefined);
});

test('cueAt with fractional and close cues', () => {
    // a cue at 10.5 s: five counts on 6..10, go on the second that crosses it
    assert.deepEqual([5, 6, 7, 8, 9, 10, 11, 12].map((s) => cueAt([10.5], s)),
        [undefined, 'count', 'count', 'count', 'count', 'count', 'go', undefined]);
    // cues 3 s apart: each still gets its go
    assert.deepEqual([9, 10, 11, 12, 13, 14].map((s) => cueAt([10, 13], s)),
        ['count', 'go', 'count', 'count', 'go', undefined]);
});

test('nextCue', () => {
    assert.equal(nextCue([600, 1200], 0), 600);
    assert.equal(nextCue([600, 1200], 600), 1200);
    assert.equal(nextCue([600, 1200], 1250), undefined);
});
