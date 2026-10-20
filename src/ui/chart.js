//
// Workout profile chart
//
// The SVG viewBox is in workout units, x in seconds and y in watts, stretched to the box.
// Heart rate (40-215 bpm) and cadence (0-175 rpm) have fixed scales of their own, so power keeps its axis.
// The axis labels are in a second SVG without a viewBox, placed in percent of the height, so the text
// isn't stretched; the plot is inset by CSS gutters (has-hr, has-cadence on the box) to leave them room.
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

// fixed scales for the right-hand axes: [bottom, top, ticks], with headroom above the last tick like power
const sensorScales = Object.freeze({
    heartRate: Object.freeze([40, 215, Object.freeze([80, 120, 160, 200])]),
    cadence:   Object.freeze([0, 175, Object.freeze([40, 80, 120, 160])]),
});

// Number -> [Number], round power ticks below the top of the chart, 3 to 5 of them when there's room
export function powerTicks(top) {
    if(!(top > 0)) return [];
    const step = [50, 100, 200, 500, 1000].find((s) => top / s <= 5.5) ?? 1000;
    const ticks = [];
    for(let w = step; w < top * 0.95; w += step) ticks.push(w);
    return ticks;
}

const sensorColumn = 34;  // px per right-hand axis, matches the gutters in app.css

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

// (Element, Element) -> Chart, the legend lists only the lines that have points
export function WorkoutChart(container, legend) {
    const root = svg('svg', {class: 'chart-svg', preserveAspectRatio: 'none', role: 'img'});
    const profile = svg('g', {class: 'profile'});
    const ftpLine = svg('line', {class: 'ftp-line', 'vector-effect': 'non-scaling-stroke'});
    const done = svg('rect', {class: 'done', x: 0, y: 0, width: 0, height: 0});
    const cursor = svg('line', {class: 'cursor', 'vector-effect': 'non-scaling-stroke'});
    const grid = svg('g', {class: 'grid'});
    const axes = svg('svg', {class: 'chart-axes', 'aria-hidden': 'true', focusable: 'false'});
    const powerAxis = svg('g', {class: 'axis-power'});
    const sensorAxes = {heartRate: svg('g', {class: 'axis-hr'}), cadence: svg('g', {class: 'axis-cadence'})};
    axes.append(powerAxis, sensorAxes.heartRate, sensorAxes.cadence);
    const trace = (name) => svg('polyline', {class: `${name}-trace`, 'vector-effect': 'non-scaling-stroke', points: ''});
    // [key, polyline, value -> y in chart units]
    const traces = [
        ['power', trace('power'), (w) => w],
        ['heartRate', trace('hr'), sensorScale('heartRate')],
        ['cadence', trace('cadence'), sensorScale('cadence')],
    ].map(([key, line, scale]) => ({key, line, scale, points: []}));
    root.append(profile, grid, done, ftpLine, ...traces.map((tr) => tr.line).reverse(), cursor);
    container.replaceChildren(root, axes);

    let height = 1;
    let duration = 1;

    const y = (value) => fmt(height - Math.min(Math.max(value, 0), height));

    // String -> (Number -> Number), a sensor value in chart units
    function sensorScale(key) {
        const [bottom, top] = sensorScales[key];
        return (v) => (v - bottom) / (top - bottom) * height;
    }

    // (Number, String, Number) -> SVGTextElement, fraction 0 at the bottom, 1 at the top
    function label(fraction, text, attributes) {
        const t = svg('text', {y: `${fmt((1 - fraction) * 100)}%`, 'dominant-baseline': 'middle', 'text-anchor': 'end', ...attributes});
        t.textContent = text;
        return t;
    }

    function drawPowerAxis() {
        const ticks = powerTicks(height);
        powerAxis.replaceChildren(...ticks.map((w) => label(w / height, String(w), {x: 32})));
        grid.replaceChildren(...ticks.map((w) => svg('line', {
            class: 'grid-line', 'vector-effect': 'non-scaling-stroke', x1: 0, x2: duration, y1: y(w), y2: y(w),
        })));
    }

    // the sensor axes with points, cadence outermost on the right
    function drawSensorAxes() {
        const shown = traces.filter((tr) => tr.key in sensorAxes && tr.points.length > 0).map((tr) => tr.key);
        container.classList.toggle('has-hr', shown.includes('heartRate'));
        container.classList.toggle('has-cadence', shown.includes('cadence'));
        for(const [key, group] of Object.entries(sensorAxes)) {
            if(!shown.includes(key)) {
                group.replaceChildren();
                continue;
            }
            const column = shown.length - 1 - shown.indexOf(key);  // 0 is the rightmost
            const [bottom, top, ticks] = sensorScales[key];
            group.replaceChildren(...ticks.map((v) => label((v - bottom) / (top - bottom), String(v),
                {x: '100%', dx: -4 - column * sensorColumn})));
        }
    }

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
        drawPowerAxis();
        for(const tr of traces) renderTrace(tr);
    }

    function renderTrace(tr) {
        tr.line.setAttribute('points', tr.points.map(([t, v]) => `${t},${y(tr.scale(v))}`).join(' '));
        if(legend) legend.querySelector(`[data-line="${tr.key}"]`).hidden = tr.points.length === 0;
        if(tr.key in sensorAxes) drawSensorAxes();
    }

    // Number -> Void
    function progress(t) {
        const x = fmt(Math.min(Math.max(t, 0), duration));
        done.setAttribute('width', x);
        cursor.setAttribute('x1', x);
        cursor.setAttribute('x2', x);
    }

    // (Number, {power, heartRate, cadence}) -> Void, missing values leave a line as it is
    function addSample(t, values) {
        for(const tr of traces) {
            const v = values[tr.key];
            if(!Number.isFinite(v)) continue;
            tr.points.push([t, v]);
            if(tr.points.length === 1) {
                renderTrace(tr);
                continue;
            }
            tr.line.setAttribute('points', `${tr.line.getAttribute('points')} ${t},${y(tr.scale(v))}`);
        }
    }

    function clearTraces() {
        for(const tr of traces) {
            tr.points = [];
            renderTrace(tr);
        }
    }

    return Object.freeze({draw, progress, addSample, clearTraces});
}
