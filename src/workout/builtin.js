//
// Workouts that come with the app
//
// Written as steps and turned into MRC text, so they go through the same parser as uploads.
//

import { parseWorkout } from './parse.js';

// step: [minutes, percent] or a ramp: [minutes, from, to]
function toMrc(name, steps) {
    let t = 0;
    const rows = [];
    for(const [minutes, from, to = from] of steps) {
        rows.push(`${t.toFixed(4)}\t${from}`);
        t += minutes;
        rows.push(`${t.toFixed(4)}\t${to}`);
    }
    return [
        '[COURSE HEADER]',
        `FILE NAME = ${name}`,
        'MINUTES PERCENT',
        '[END COURSE HEADER]',
        '[COURSE DATA]',
        ...rows,
        '[END COURSE DATA]',
        '',
    ].join('\n');
}

const repeat = (n, steps) => Array.from({length: n}, () => steps).flat();
// n x work with recoveries between, not after the last one
const intervals = (n, work, recovery) => [...repeat(n - 1, [work, recovery]), work];

const definitions = [
    ['recovery', 'Recovery', [
        [5, 40, 55], [10, 50], [10, 55], [5, 50, 40],
    ]],
    ['endurance', 'Endurance', [
        [10, 45, 65], [20, 65], [20, 70], [10, 65, 45],
    ]],
    ['tempo-3x10', 'Tempo 3×10', [
        [10, 45, 75], ...intervals(3, [10, 80], [5, 55]), [10, 60, 45],
    ]],
    ['sweet-spot-3x10', 'Sweet Spot 3×10', [
        [10, 45, 75], ...intervals(3, [10, 90], [5, 55]), [10, 60, 45],
    ]],
    ['threshold-2x20', 'Threshold 2×20', [
        [15, 45, 80], ...intervals(2, [20, 98], [5, 55]), [10, 60, 45],
    ]],
    ['vo2max-5x3', 'VO2max 5×3', [
        [15, 45, 75], ...intervals(5, [3, 118], [3, 50]), [3, 50], [10, 60, 40],
    ]],
    ['40-20s', '40/20s', [
        [15, 45, 80],
        ...intervals(3, repeat(8, [[40 / 60, 120], [20 / 60, 50]]), [[5, 50]]).flat(),
        [6, 60, 40],
    ]],
];

// [{id, name, text, workout, builtin: true}]
export const builtins = Object.freeze(definitions.map(([slug, name, steps]) => {
    const text = toMrc(name, steps);
    return Object.freeze({id: `b-${slug}`, name, text, workout: parseWorkout(text), builtin: true});
}));
