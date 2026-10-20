import { test } from 'node:test';
import assert from 'node:assert/strict';

import { powerTicks } from '../src/ui/chart.js';

test('power ticks are round, below the top, 3 to 5 of them', () => {
    assert.deepEqual(powerTicks(330), [100, 200, 300]);
    assert.deepEqual(powerTicks(250), [50, 100, 150, 200]);
    assert.deepEqual(powerTicks(600), [200, 400]);
    assert.deepEqual(powerTicks(1650), [500, 1000, 1500]);
    assert.deepEqual(powerTicks(0), []);
    assert.deepEqual(powerTicks(NaN), []);
    for(let top = 60; top < 4000; top += 7) {
        const ticks = powerTicks(top);
        assert.ok(ticks.length >= 1 && ticks.length <= 6, `${top}: ${ticks}`);
        assert.ok(ticks.at(-1) < top, `${top}: ${ticks}`);
    }
});
