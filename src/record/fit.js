//
// FIT activity encoder
//
// An activity file for Strava, intervals.icu and Garmin Connect: file_id, file_creator, device_info for
// vigo and each sensor, sport, workout (its name), zones_target and hr_zone (FTP, heart rate zones),
// then records with timer events, a lap per workout interval, session and activity.
// Field numbers and scales are from the FIT SDK profile. Strings are fixed size, UTF-8, null padded.
//

import { defaultHrZones } from '../workout/hrzones.js';

const fitEpoch = 631065600; // 1989-12-31T00:00:00Z in unix seconds

const baseTypes = {
    enum:    {id: 0x00, size: 1, invalid: 0xff},
    uint8:   {id: 0x02, size: 1, invalid: 0xff},
    uint16:  {id: 0x84, size: 2, invalid: 0xffff},
    uint32:  {id: 0x86, size: 4, invalid: 0xffffffff},
    uint32z: {id: 0x8c, size: 4, invalid: 0},
    string16: {id: 0x07, size: 16, string: true},
    string32: {id: 0x07, size: 32, string: true},
    string64: {id: 0x07, size: 64, string: true},
};

const softwareVersion = 1.0;

// [name, field number, base type, scale]
const messages = {
    fileId: {num: 0, fields: [
        ['type', 0, 'enum'], ['manufacturer', 1, 'uint16'], ['product', 2, 'uint16'],
        ['serialNumber', 3, 'uint32z'], ['timeCreated', 4, 'uint32'],
    ]},
    fileCreator: {num: 49, fields: [
        ['softwareVersion', 0, 'uint16', 100],
    ]},
    deviceInfo: {num: 23, fields: [
        ['timestamp', 253, 'uint32'], ['deviceIndex', 0, 'uint8'], ['deviceType', 1, 'uint8'],
        ['manufacturer', 2, 'uint16'], ['product', 4, 'uint16'], ['softwareVersion', 5, 'uint16', 100],
        ['sourceType', 25, 'enum'], ['productName', 27, 'string32'],
    ]},
    sport: {num: 12, fields: [
        ['sport', 0, 'enum'], ['subSport', 1, 'enum'], ['name', 3, 'string16'],
    ]},
    workout: {num: 26, fields: [
        ['sport', 4, 'enum'], ['numValidSteps', 6, 'uint16'], ['wktName', 8, 'string64'], ['subSport', 11, 'enum'],
    ]},
    zonesTarget: {num: 7, fields: [
        ['maxHeartRate', 1, 'uint8'], ['functionalThresholdPower', 3, 'uint16'],
        ['hrCalcType', 5, 'enum'], ['pwrCalcType', 7, 'enum'],
    ]},
    hrZone: {num: 8, fields: [
        ['messageIndex', 254, 'uint16'], ['highBpm', 1, 'uint8'], ['name', 2, 'string16'],
    ]},
    event: {num: 21, fields: [
        ['timestamp', 253, 'uint32'], ['event', 0, 'enum'], ['eventType', 1, 'enum'],
    ]},
    record: {num: 20, fields: [
        ['timestamp', 253, 'uint32'], ['heartRate', 3, 'uint8'], ['cadence', 4, 'uint8'],
        ['distance', 5, 'uint32', 100], ['speed', 6, 'uint16', 1000], ['power', 7, 'uint16'],
    ]},
    lap: {num: 19, fields: [
        ['messageIndex', 254, 'uint16'],
        ['timestamp', 253, 'uint32'], ['event', 0, 'enum'], ['eventType', 1, 'enum'],
        ['startTime', 2, 'uint32'], ['totalElapsedTime', 7, 'uint32', 1000],
        ['totalTimerTime', 8, 'uint32', 1000], ['totalDistance', 9, 'uint32', 100],
        ['totalCalories', 11, 'uint16'], ['avgSpeed', 13, 'uint16', 1000],
        ['avgHeartRate', 15, 'uint8'], ['maxHeartRate', 16, 'uint8'], ['avgCadence', 17, 'uint8'],
        ['maxCadence', 18, 'uint8'], ['avgPower', 19, 'uint16'], ['maxPower', 20, 'uint16'],
        ['lapTrigger', 24, 'enum'], ['sport', 25, 'enum'], ['normalizedPower', 33, 'uint16'],
        ['subSport', 39, 'enum'], ['totalWork', 41, 'uint32'],
    ]},
    session: {num: 18, fields: [
        ['timestamp', 253, 'uint32'], ['event', 0, 'enum'], ['eventType', 1, 'enum'],
        ['startTime', 2, 'uint32'], ['sport', 5, 'enum'], ['subSport', 6, 'enum'],
        ['totalElapsedTime', 7, 'uint32', 1000], ['totalTimerTime', 8, 'uint32', 1000],
        ['totalDistance', 9, 'uint32', 100], ['totalCalories', 11, 'uint16'],
        ['avgSpeed', 14, 'uint16', 1000], ['avgHeartRate', 16, 'uint8'], ['maxHeartRate', 17, 'uint8'],
        ['avgCadence', 18, 'uint8'], ['maxCadence', 19, 'uint8'], ['avgPower', 20, 'uint16'],
        ['maxPower', 21, 'uint16'], ['firstLapIndex', 25, 'uint16'], ['numLaps', 26, 'uint16'],
        ['normalizedPower', 34, 'uint16'], ['trainingStressScore', 35, 'uint16', 10],
        ['intensityFactor', 36, 'uint16', 1000], ['thresholdPower', 45, 'uint16'], ['totalWork', 48, 'uint32'],
    ]},
    activity: {num: 34, fields: [
        ['timestamp', 253, 'uint32'], ['totalTimerTime', 0, 'uint32', 1000], ['numSessions', 1, 'uint16'],
        ['type', 2, 'enum'], ['event', 3, 'enum'], ['eventType', 4, 'enum'], ['localTimestamp', 5, 'uint32'],
    ]},
};

const enums = {
    fileActivity: 4,
    manufacturerDevelopment: 255,
    eventTimer: 0, eventLap: 9, eventSession: 8, eventActivity: 26,
    eventTypeStart: 0, eventTypeStop: 1, eventTypeStopAll: 4,
    sportCycling: 2, subSportIndoorCycling: 6,
    activityManual: 0,
    sourceLocal: 5, sourceBle: 3,
    // ble_device_type
    deviceTypes: {trainer: 7, hr: 1, csc: 3},
    hrCalcCustom: 0, hrCalcPercentMax: 1, pwrCalcPercentFtp: 1,
    lapTriggerTime: 1, lapTriggerSessionEnd: 7,
};

const crcTable = [
    0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
    0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400,
];

// (Uint8Array, Int, Int, Int) -> Int
export function crc16(bytes, start = 0, end = bytes.length, crc = 0) {
    for(let i = start; i < end; i++) {
        const byte = bytes[i];
        let tmp = crcTable[crc & 0xf];
        crc = (crc >> 4) & 0x0fff;
        crc = crc ^ tmp ^ crcTable[byte & 0xf];
        tmp = crcTable[crc & 0xf];
        crc = (crc >> 4) & 0x0fff;
        crc = crc ^ tmp ^ crcTable[(byte >> 4) & 0xf];
    }
    return crc;
}

function Bytes() {
    let buffer = new Uint8Array(1024);
    let view = new DataView(buffer.buffer);
    let length = 0;

    function ensure(n) {
        if(length + n <= buffer.length) return;
        const next = new Uint8Array(Math.max(buffer.length * 2, length + n));
        next.set(buffer);
        buffer = next;
        view = new DataView(buffer.buffer);
    }

    // (String, Int) -> Void, UTF-8 cut on a character boundary, null terminated and padded
    function writeString(text, size) {
        ensure(size);
        let bytes = new TextEncoder().encode(String(text ?? ''));
        if(bytes.length > size - 1) {
            let end = size - 1;
            while(end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
            bytes = bytes.slice(0, end);
        }
        buffer.fill(0, length, length + size);
        buffer.set(bytes, length);
        length += size;
    }

    function write(type, value) {
        if(type.string) return writeString(value, type.size);
        ensure(type.size);
        if(type.size === 1) view.setUint8(length, value);
        else if(type.size === 2) view.setUint16(length, value, true);
        else view.setUint32(length, value, true);
        length += type.size;
    }

    return {
        u8: (v) => write(baseTypes.uint8, v),
        u16: (v) => write(baseTypes.uint16, v),
        u32: (v) => write(baseTypes.uint32, v),
        write,
        get length() { return length; },
        bytes: () => buffer.slice(0, length),
    };
}

// missing, non numeric or out of range values are written as the type's invalid value
function fieldValue(type, value, scale = 1) {
    if(value === null || value === undefined || !Number.isFinite(Number(value))) return type.invalid;
    const scaled = Math.round(Number(value) * scale);
    const max = type.invalid === 0 ? 2 ** (type.size * 8) - 1 : type.invalid - 1;
    const min = type.invalid === 0 ? 1 : 0;
    if(scaled < min || scaled > max) return type.invalid;
    return scaled;
}

function Writer() {
    const out = Bytes();
    const localTypes = {};

    function message(name, values) {
        const spec = messages[name];
        if(!(name in localTypes)) {
            const local = Object.keys(localTypes).length;
            localTypes[name] = local;
            out.u8(0x40 | local);
            out.u8(0);      // reserved
            out.u8(0);      // little endian
            out.u16(spec.num);
            out.u8(spec.fields.length);
            for(const [, num, type] of spec.fields) {
                out.u8(num);
                out.u8(baseTypes[type].size);
                out.u8(baseTypes[type].id);
            }
        }
        out.u8(localTypes[name]);
        for(const [field, , typeName, scale] of spec.fields) {
            const type = baseTypes[typeName];
            out.write(type, type.string ? values[field] : fieldValue(type, values[field], scale));
        }
    }

    return {message, bytes: out.bytes};
}

const toFitTime = (unixSeconds) => Math.round(unixSeconds) - fitEpoch;

function mean(values) {
    const valid = values.filter((x) => Number.isFinite(x));
    if(valid.length === 0) return undefined;
    return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function max(values) {
    const valid = values.filter((x) => Number.isFinite(x));
    return valid.length ? Math.max(...valid) : undefined;
}

// [Number | null] -> Number | undefined, 30 s rolling average, raised to the 4th power, averaged,
// 4th root; a missing second counts as 0 W
export function normalizedPower(power) {
    if(power.length < 30) return undefined;
    let sum = 0;
    let total = 0;
    const watts = power.map((w) => (Number.isFinite(w) ? w : 0));
    for(let i = 0; i < watts.length; i++) {
        sum += watts[i];
        if(i >= 30) sum -= watts[i - 30];
        if(i >= 29) total += (sum / 30) ** 4;
    }
    return (total / (watts.length - 29)) ** 0.25;
}

// (Ride, {distanceBefore}) -> Summary, distanceBefore is where a lap starts in a ride's distance
//
// Ride {samples: [{t, power, heartRate, cadence, speed, distance}], events: [{t, type: 'start'|'stop'}], ftp?}
export function summarize({samples, ftp}, {distanceBefore = 0} = {}) {
    if(samples.length === 0) return undefined;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const power = samples.map((s) => s.power);
    const work = power.filter(Number.isFinite).reduce((a, b) => a + b, 0); // joules, one sample per second
    const timerTime = samples.length;
    const totalDistance = Number.isFinite(last.distance) ? last.distance - (distanceBefore ?? 0) : undefined;
    const np = normalizedPower(power);
    const intensityFactor = Number.isFinite(np) && ftp > 0 ? np / ftp : undefined;

    return {
        startTime: first.t,
        endTime: last.t + 1,
        totalElapsedTime: last.t + 1 - first.t,
        totalTimerTime: timerTime,
        totalDistance,
        totalWork: work,
        // roughly 1 kcal per kJ of work at the pedals
        totalCalories: work / 1000,
        avgSpeed: Number.isFinite(totalDistance) ? totalDistance / timerTime : undefined,
        avgPower: mean(power),
        maxPower: max(power),
        normalizedPower: np,
        intensityFactor,
        trainingStressScore: Number.isFinite(intensityFactor) ? timerTime * np * intensityFactor / (ftp * 3600) * 100 : undefined,
        avgHeartRate: mean(samples.map((s) => s.heartRate).filter((x) => x > 0)),
        maxHeartRate: max(samples.map((s) => s.heartRate)),
        avgCadence: mean(samples.map((s) => s.cadence).filter((x) => x > 0)),
        maxCadence: max(samples.map((s) => s.cadence)),
    };
}

// (Ride) -> [[Sample]], the samples split at the start of each workout interval
function lapSlices({samples, laps = []}) {
    const slices = [[]];
    let next = 0;
    for(const s of samples) {
        let moved = false;
        while(next < laps.length && laps[next] <= s.t) {
            next += 1;
            moved = true;
        }
        if(moved && slices.at(-1).length > 0) slices.push([]);
        slices.at(-1).push(s);
    }
    return slices;
}

// (Ride, {timezoneOffset: minutes}) -> Uint8Array
export function encodeActivity(ride, {timezoneOffset = 0} = {}) {
    const summary = summarize(ride);
    if(!summary) throw new Error('nothing to export, the ride has no samples');

    const w = Writer();
    const start = toFitTime(summary.startTime);
    const end = toFitTime(summary.endTime);

    w.message('fileId', {
        type: enums.fileActivity,
        manufacturer: enums.manufacturerDevelopment,
        product: 0,
        serialNumber: (summary.startTime % 0xfffffffe) + 1,
        timeCreated: start,
    });
    writeHeader(w, ride, start);

    const events = ride.events.length ? ride.events : [{t: summary.startTime, type: 'start'}];
    const samples = [...ride.samples];
    let e = 0;
    // interleave pause/resume events with the records in time order
    for(const s of samples) {
        while(e < events.length && events[e].t <= s.t) {
            timerEvent(w, events[e]);
            e += 1;
        }
        w.message('record', {
            timestamp: toFitTime(s.t),
            heartRate: s.heartRate,
            cadence: s.cadence,
            distance: s.distance,
            speed: s.speed,
            power: s.power,
        });
    }
    for(; e < events.length; e++) {
        if(events[e].type !== 'stop') timerEvent(w, events[e]);
    }
    w.message('event', {timestamp: end, event: enums.eventTimer, eventType: enums.eventTypeStopAll});

    const totals = (s) => ({
        ...s,
        timestamp: toFitTime(s.endTime),
        startTime: toFitTime(s.startTime),
        sport: enums.sportCycling,
        subSport: enums.subSportIndoorCycling,
    });
    const slices = lapSlices(ride);
    let distanceBefore = 0;
    // laps follow each other with no gap, a pause at an interval change counts in the lap before it,
    // so their elapsed times and distances add up to the session's as the FIT docs ask
    slices.forEach((slice, i) => {
        const lap = summarize({samples: slice, ftp: ride.ftp}, {distanceBefore});
        distanceBefore = slice.at(-1).distance ?? distanceBefore;
        const last = i === slices.length - 1;
        lap.startTime = i === 0 ? summary.startTime : slice[0].t;
        lap.endTime = last ? summary.endTime : slices[i + 1][0].t;
        lap.totalElapsedTime = lap.endTime - lap.startTime;
        w.message('lap', {
            ...totals(lap), messageIndex: i, event: enums.eventLap, eventType: enums.eventTypeStop,
            lapTrigger: last ? enums.lapTriggerSessionEnd : enums.lapTriggerTime,
        });
    });
    w.message('session', {
        ...totals(summary), timestamp: end, event: enums.eventSession, eventType: enums.eventTypeStop,
        firstLapIndex: 0, numLaps: slices.length, thresholdPower: ride.ftp,
    });
    w.message('activity', {
        timestamp: end,
        totalTimerTime: summary.totalTimerTime,
        numSessions: 1,
        type: enums.activityManual,
        event: enums.eventActivity,
        eventType: enums.eventTypeStop,
        localTimestamp: end - timezoneOffset * 60,
    });

    const data = w.bytes();
    const file = new Uint8Array(14 + data.length + 2);
    const view = new DataView(file.buffer);
    view.setUint8(0, 14);              // header size
    view.setUint8(1, 0x20);            // protocol 2.0
    view.setUint16(2, 2132, true);     // profile 21.32
    view.setUint32(4, data.length, true);
    file.set([0x2e, 0x46, 0x49, 0x54], 8); // '.FIT'
    view.setUint16(12, crc16(file, 0, 12), true);
    file.set(data, 14);
    view.setUint16(14 + data.length, crc16(file, 0, 14 + data.length), true);
    return file;
}

// the messages that describe the ride before its records
function writeHeader(w, ride, start) {
    w.message('fileCreator', {softwareVersion});
    w.message('deviceInfo', {
        timestamp: start, deviceIndex: 0, manufacturer: enums.manufacturerDevelopment, product: 0,
        softwareVersion, sourceType: enums.sourceLocal, productName: 'vigo',
    });
    (ride.devices ?? []).forEach((device, i) => w.message('deviceInfo', {
        timestamp: start, deviceIndex: i + 1, deviceType: enums.deviceTypes[device.kind],
        sourceType: enums.sourceBle, productName: device.name,
    }));
    w.message('sport', {sport: enums.sportCycling, subSport: enums.subSportIndoorCycling, name: 'Indoor cycling'});
    if(ride.workoutName) {
        w.message('workout', {
            sport: enums.sportCycling, subSport: enums.subSportIndoorCycling, numValidSteps: 0, wktName: ride.workoutName,
        });
    }
    const zones = ride.hrZones;
    const standard = zones && ride.maxHr && defaultHrZones(ride.maxHr).every((z, i) => z === zones[i]);
    w.message('zonesTarget', {
        maxHeartRate: ride.maxHr, functionalThresholdPower: ride.ftp,
        hrCalcType: !zones ? undefined : standard ? enums.hrCalcPercentMax : enums.hrCalcCustom,
        pwrCalcType: enums.pwrCalcPercentFtp,
    });
    if(zones && ride.maxHr) {
        // Garmin's layout: the top of the range below zone 1, then of zones 1 to 5, each top being where the
        // next zone starts (a heart rate on a boundary counts in the higher zone), and max HR last
        const tops = [...zones, ride.maxHr];
        tops.forEach((highBpm, i) => w.message('hrZone', {messageIndex: i, highBpm, name: i ? `Zone ${i}` : 'Below zone 1'}));
    }
}

function timerEvent(w, event) {
    w.message('event', {
        timestamp: toFitTime(event.t),
        event: enums.eventTimer,
        eventType: event.type === 'start' ? enums.eventTypeStart : enums.eventTypeStopAll,
    });
}
