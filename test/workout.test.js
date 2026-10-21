import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseWorkout, WorkoutError } from '../src/workout/parse.js';
import { targetAt, segmentIndexAt, maxWatts, zone } from '../src/workout/target.js';
import { Player } from '../src/workout/player.js';

const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');

test('parses an MRC file with steps and ramps', () => {
    const w = parseWorkout(fixture('sweetspot.mrc'));
    assert.equal(w.name, 'Sweet Spot 2x10');
    assert.equal(w.unit, 'pct');
    assert.equal(w.duration, 20 * 60);
    assert.deepEqual(w.segments, [
        {start: 0, duration: 300, from: 50, to: 75},
        {start: 300, duration: 600, from: 90, to: 90},
        {start: 900, duration: 300, from: 50, to: 50},
    ]);
});

test('parses an ERG file with CRLF and an FTP header', () => {
    const w = parseWorkout(fixture('steps.erg'));
    assert.equal(w.unit, 'w');
    assert.equal(w.fileFtp, 200);
    assert.equal(w.segments.length, 2);
});

test('uses the file name when the header has no name', () => {
    const w = parseWorkout('[COURSE HEADER]\nMINUTES WATTS\n[END COURSE HEADER]\n[COURSE DATA]\n0 100\n1 100\n[END COURSE DATA]',
        {fileName: 'My ride.erg'});
    assert.equal(w.name, 'My ride');
    assert.equal(w.fileFtp, undefined);
});

test('keeps hostile names as plain text, cleaned of control characters', () => {
    const w = parseWorkout(fixture('hostile-name.mrc'));
    assert.equal(w.name, '<img src=x onerror=alert(1)>');
    const w2 = parseWorkout('[COURSE HEADER]\nFILE NAME = a\u0000b\u001bc\nMINUTES PERCENT\n[END COURSE HEADER]\n[COURSE DATA]\n0 50\n1 50\n');
    assert.equal(w2.name, 'a b c');
});

test('FILE NAME is tidied into the name, DESCRIPTION kept apart', () => {
    const w = parseWorkout(fixture('user-style.mrc'), {fileName: 'renamed copy.mrc'});
    assert.equal(w.name, 'Sweet spot 45m');
    assert.equal(w.description, 'Three blocks at sweet spot, then cool down');
    const noName = parseWorkout('[COURSE HEADER]\nDESCRIPTION = Only a description\nMINUTES PERCENT\n[END COURSE HEADER]\n[COURSE DATA]\n0 50\n1 50\n');
    assert.equal(noName.name, 'Only a description');
    assert.equal(parseWorkout(fixture('sweetspot.mrc')).description, '');
});

test('COURSE TEXT messages are read, bounded and sorted', () => {
    const w = parseWorkout(fixture('user-style.mrc'));
    assert.deepEqual(w.texts, [
        {start: 0, duration: 10, text: 'Warm up easy'},
        {start: 30, duration: 10, text: 'Spin at 100 rpm'},
        {start: 120, duration: 300, text: 'Long message'},
        {start: 180, duration: 15, text: 'First block, settle in'},
        {start: 2690, duration: 1, text: 'Almost done'},
    ]);
    const many = parseWorkout(header + '0 50\n60 50\n[END COURSE DATA]\n[COURSE TEXT]\n'
        + Array.from({length: 600}, (_, i) => `${i}\tm${i}\t5`).join('\n') + '\n[END COURSE TEXT]\n');
    assert.equal(many.texts.length, 500);
    const long = parseWorkout(header + '0 50\n60 50\n[COURSE TEXT]\n1\t' + 'x'.repeat(1000) + '\t5\n');
    assert.equal(long.texts[0].text.length, 200);
});

test('hostile description and text messages stay plain text', () => {
    const w = parseWorkout(fixture('hostile-name.mrc'));
    assert.equal(w.description, '<script>alert(2)</script> & <img src=x onerror=alert(3)>');
    assert.equal(w.texts[0].text, '<img src=x onerror=alert(1)>');
});

const header = '[COURSE HEADER]\nMINUTES PERCENT\n[END COURSE HEADER]\n[COURSE DATA]\n';
const rejects = (text, pattern) => assert.throws(() => parseWorkout(text), (e) => {
    assert.ok(e instanceof WorkoutError, e);
    assert.match(e.message, pattern);
    return true;
});

test('rejects malformed and out of range files', () => {
    rejects('hello', /not an ERG or MRC/);
    rejects('[COURSE DATA]\n0 100\n', /MINUTES WATTS or MINUTES PERCENT/);
    rejects(header + '0 50\nabc 60\n', /line 6: 'abc' is not a number/);
    rejects(header + '0 50\n1e3 60\n', /not a number/);
    rejects(header + '0 50\nInfinity 60\n', /not a number/);
    rejects(header + '0 50\n1 301\n', /between 0 and 300/);
    rejects(header + '0 50\n1 -5\n', /between 0 and 300/);
    rejects(header + '0 50\n2 50\n1 50\n', /backwards/);
    rejects(header + '0 50\n721 50\n', /12 hours/);
    rejects(header + '0 50\n', /no intervals/);
    rejects(header + '0\n', /expected minutes and a value/);
    rejects('[COURSE HEADER]\nFTP = 5\nMINUTES WATTS\n', /FTP must be/);
    rejects('x'.repeat(1024 * 1024 + 1), /larger than 1 MB/);
    rejects(header + Array.from({length: 5001}, (_, i) => `${i / 100} 50`).join('\n'), /more than 5000 points/);
    assert.throws(() => parseWorkout(undefined), WorkoutError);
});

test('target follows steps and ramps, scaled by FTP and bias', () => {
    const w = parseWorkout(fixture('sweetspot.mrc'));
    assert.equal(targetAt(w, {ftp: 200, t: 0}), 100);
    assert.equal(targetAt(w, {ftp: 200, t: 150}), 125); // half way up the 50% -> 75% ramp
    assert.equal(targetAt(w, {ftp: 200, t: 300}), 180);
    assert.equal(targetAt(w, {ftp: 200, t: 300, bias: 5}), 189);
    assert.equal(targetAt(w, {ftp: 200, t: 300, bias: -10}), 162);
    assert.equal(targetAt(w, {ftp: 200, t: 1200}), undefined);
});

test('ERG watts are scaled by FTP / file FTP, or used as they are without a file FTP', () => {
    const w = parseWorkout(fixture('steps.erg'));
    assert.equal(targetAt(w, {ftp: 200, t: 30}), 100);
    assert.equal(targetAt(w, {ftp: 300, t: 90}), 300);
    const raw = parseWorkout('[COURSE HEADER]\nMINUTES WATTS\n[END COURSE HEADER]\n[COURSE DATA]\n0 150\n1 150\n');
    assert.equal(targetAt(raw, {ftp: 300, t: 10}), 150);
});

test('segment lookup, max watts and zones', () => {
    const w = parseWorkout(fixture('sweetspot.mrc'));
    assert.equal(segmentIndexAt(w, 0), 0);
    assert.equal(segmentIndexAt(w, 299.9), 0);
    assert.equal(segmentIndexAt(w, 300), 1);
    assert.equal(segmentIndexAt(w, 1199), 2);
    assert.equal(segmentIndexAt(w, 1200), -1);
    assert.equal(maxWatts(w, 200), 180);
    assert.deepEqual([0.5, 0.6, 0.8, 1.0, 1.1, 1.5].map(zone), [1, 2, 3, 4, 5, 6]);
});

function fakeClock() {
    let now = 0;
    let fn;
    return {
        now: () => now,
        setInterval: (f) => { fn = f; return 1; },
        clearInterval: () => { fn = undefined; },
        advance(ms) { now += ms; fn?.(); },
    };
}

test('player ticks once per second, pauses and finishes', () => {
    const w = parseWorkout(header + '0 50\n0.05 50\n0.05 100\n0.1 100\n'); // 2 x 3 s
    const clock = fakeClock();
    const ticks = [];
    const states = [];
    const p = Player({workout: w, onTick: (s) => ticks.push(s), onState: (s) => states.push(s), ...clock});

    p.start();
    assert.deepEqual(ticks, [0]);
    clock.advance(2500);
    assert.deepEqual(ticks, [0, 1, 2]);
    p.pause();
    clock.advance(10000);
    assert.deepEqual(ticks, [0, 1, 2]);
    assert.equal(p.elapsed, 2.5);
    p.start();
    clock.advance(1000);
    assert.deepEqual(ticks, [0, 1, 2, 3]);
    clock.advance(5000);
    assert.deepEqual(ticks, [0, 1, 2, 3, 4, 5]);
    assert.equal(p.state, 'finished');
    assert.equal(p.elapsed, 6);
    assert.deepEqual(states, ['running', 'paused', 'running', 'finished']);
});

test('player skip jumps to the next interval without ticking skipped seconds', () => {
    const w = parseWorkout(header + '0 50\n0.05 50\n0.05 100\n0.1 100\n');
    const clock = fakeClock();
    const ticks = [];
    const p = Player({workout: w, onTick: (s) => ticks.push(s), ...clock});
    p.start();
    clock.advance(1200);
    p.skip();
    assert.equal(p.elapsed, 3);
    assert.deepEqual(ticks, [0, 1, 3]);
    p.skip();
    assert.equal(p.state, 'finished');
});

test('targets are capped at twice the FTP and at 1500 W', async () => {
    const { maxTargetFor, absoluteMaxWatts } = await import('../src/workout/target.js');
    const hard = parseWorkout(header + '0 300\n1 300\n');               // 300% FTP
    assert.equal(targetAt(hard, {ftp: 200, t: 10}), 400);
    assert.equal(targetAt(hard, {ftp: 200, t: 10, bias: 50}), 400);
    const fixed = parseWorkout('[COURSE HEADER]\nMINUTES WATTS\n[END COURSE HEADER]\n[COURSE DATA]\n0 2000\n1 2000\n');
    assert.equal(targetAt(fixed, {ftp: 600, t: 10}), 1200);              // 2 x FTP
    assert.equal(targetAt(fixed, {ftp: 900, t: 10}), absoluteMaxWatts);  // the hard ceiling
    assert.equal(maxTargetFor(600), 1200);
    assert.equal(maxTargetFor(900), 1500);
    // normal workouts are untouched
    const normal = parseWorkout(header + '0 120\n1 120\n');
    assert.equal(targetAt(normal, {ftp: 250, t: 10, bias: 10}), 330);
});
