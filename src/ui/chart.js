//
// Workout profile chart
//
// The SVG viewBox is in workout units, x in seconds and y in watts, stretched to the box.
// Colours come from CSS classes so the page needs no inline styles.
//

import { toWatts, zone, maxTargetFor } from '../workout/target.js';

const ns = 'http://www.w3.org/2000/svg';

function svg(tag, attributes = {}) {
    const el = document.createElementNS(ns, tag);
    for(const [k, v] of Object.entries(attributes)) el.setAttribute(k, String(v));
    return el;
}

const fmt = (x) => (Math.round(x * 10) / 10).toString();

// (Workout, {ftp, scale, height}) -> [SVGPolygonElement], one per segment in zone colours
// drawn as ridden: scaled by the intensity setting and capped like the targets
function segmentPolygons(workout, {ftp, scale = 1, height}) {
    const y = (watts) => fmt(height - Math.min(Math.max(watts, 0), height));
    const watts = (value) => Math.min(toWatts(workout, value, ftp) * scale, maxTargetFor(ftp));
    return workout.segments.map((s) => {
        const from = watts(s.from);
        const to = watts(s.to);
        const end = s.start + s.duration;
        return svg('polygon', {
            class: `z${zone((from + to) / 2 / ftp)}`,
            points: `${s.start},${height} ${s.start},${y(from)} ${end},${y(to)} ${end},${height}`,
        });
    });
}

// (Workout, Number) -> SVGElement, a small profile for lists
export function drawProfile(workout, ftp) {
    let max = ftp;
    for(const s of workout.segments) {
        max = Math.max(max, toWatts(workout, s.from, ftp), toWatts(workout, s.to, ftp));
    }
    const height = Math.ceil(Math.min(max, maxTargetFor(ftp)) * 1.05);
    const root = svg('svg', {
        class: 'profile-thumb', viewBox: `0 0 ${workout.duration} ${height}`,
        preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false',
    });
    root.append(...segmentPolygons(workout, {ftp, height}));
    return root;
}

export function WorkoutChart(container) {
    const root = svg('svg', {class: 'chart-svg', preserveAspectRatio: 'none', role: 'img'});
    const profile = svg('g', {class: 'profile'});
    const ftpLine = svg('line', {class: 'ftp-line', 'vector-effect': 'non-scaling-stroke'});
    const trace = svg('polyline', {class: 'power-trace', 'vector-effect': 'non-scaling-stroke', points: ''});
    const done = svg('rect', {class: 'done', x: 0, y: 0, width: 0, height: 0});
    const cursor = svg('line', {class: 'cursor', 'vector-effect': 'non-scaling-stroke'});
    root.append(profile, done, ftpLine, trace, cursor);
    container.replaceChildren(root);

    let height = 1;
    let duration = 1;
    let points = [];

    const y = (watts) => fmt(height - Math.min(Math.max(watts, 0), height));

    // (Workout, {ftp, bias}) -> Void
    function draw(workout, {ftp, bias = 0}) {
        const scale = 1 + bias / 100;
        let max = ftp * 1.2;
        for(const s of workout.segments) {
            max = Math.max(max, toWatts(workout, s.from, ftp) * scale, toWatts(workout, s.to, ftp) * scale);
        }
        max = Math.min(max, Math.max(ftp * 1.2, maxTargetFor(ftp)));
        height = Math.ceil(max * 1.1);
        duration = workout.duration;
        root.setAttribute('viewBox', `0 0 ${duration} ${height}`);
        root.setAttribute('aria-label', `Workout profile, ${Math.round(duration / 60)} minutes`);

        profile.replaceChildren(...segmentPolygons(workout, {ftp, scale, height}));

        ftpLine.setAttribute('x1', 0);
        ftpLine.setAttribute('x2', duration);
        ftpLine.setAttribute('y1', y(ftp));
        ftpLine.setAttribute('y2', y(ftp));
        done.setAttribute('height', height);
        cursor.setAttribute('y1', 0);
        cursor.setAttribute('y2', height);
        renderTrace();
    }

    function renderTrace() {
        trace.setAttribute('points', points.map(([t, w]) => `${t},${y(w)}`).join(' '));
    }

    // Number -> Void
    function progress(t) {
        const x = fmt(Math.min(Math.max(t, 0), duration));
        done.setAttribute('width', x);
        cursor.setAttribute('x1', x);
        cursor.setAttribute('x2', x);
    }

    // (Number, Number) -> Void
    function addPower(t, watts) {
        if(!Number.isFinite(watts)) return;
        points.push([t, watts]);
        trace.setAttribute('points', `${trace.getAttribute('points')} ${t},${y(watts)}`.trim());
    }

    function clearPower() {
        points = [];
        renderTrace();
    }

    return Object.freeze({draw, progress, addPower, clearPower});
}
