//
// Workout profile chart
//
// The SVG viewBox is in workout units, x in seconds and y in watts, stretched to the box.
// Heart rate and cadence share a fixed 0-220 scale of their own, so power keeps its axis.
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

const sensorMax = 220; // bpm and rpm at the top of the chart

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
    const trace = (name) => svg('polyline', {class: `${name}-trace`, 'vector-effect': 'non-scaling-stroke', points: ''});
    // [key, polyline, value -> y in chart units]
    const traces = [
        ['power', trace('power'), (w) => w],
        ['heartRate', trace('hr'), (bpm) => bpm / sensorMax * height],
        ['cadence', trace('cadence'), (rpm) => rpm / sensorMax * height],
    ].map(([key, line, scale]) => ({key, line, scale, points: []}));
    root.append(profile, done, ftpLine, ...traces.map((tr) => tr.line).reverse(), cursor);
    container.replaceChildren(root);

    let height = 1;
    let duration = 1;

    const y = (value) => fmt(height - Math.min(Math.max(value, 0), height));

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
        for(const tr of traces) renderTrace(tr);
    }

    function renderTrace(tr) {
        tr.line.setAttribute('points', tr.points.map(([t, v]) => `${t},${y(tr.scale(v))}`).join(' '));
        if(legend) legend.querySelector(`[data-line="${tr.key}"]`).hidden = tr.points.length === 0;
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
