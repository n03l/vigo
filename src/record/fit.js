//
// FIT activity encoder
//
// Writes the smallest activity file that Strava, intervals.icu and Garmin Connect accept:
// file_id, event start, records, event stop, lap, session, activity.
// Field numbers and scales are from the FIT SDK profile.
//

const fitEpoch = 631065600; // 1989-12-31T00:00:00Z in unix seconds

const baseTypes = {
    enum:    {id: 0x00, size: 1, invalid: 0xff},
    uint8:   {id: 0x02, size: 1, invalid: 0xff},
    uint16:  {id: 0x84, size: 2, invalid: 0xffff},
    uint32:  {id: 0x86, size: 4, invalid: 0xffffffff},
    uint32z: {id: 0x8c, size: 4, invalid: 0},
};

// [name, field number, base type, scale]
const messages = {
    fileId: {num: 0, fields: [
        ['type', 0, 'enum'], ['manufacturer', 1, 'uint16'], ['product', 2, 'uint16'],
        ['serialNumber', 3, 'uint32z'], ['timeCreated', 4, 'uint32'],
    ]},
    event: {num: 21, fields: [
        ['timestamp', 253, 'uint32'], ['event', 0, 'enum'], ['eventType', 1, 'enum'],
    ]},
    record: {num: 20, fields: [
        ['timestamp', 253, 'uint32'], ['heartRate', 3, 'uint8'], ['cadence', 4, 'uint8'],
        ['distance', 5, 'uint32', 100], ['speed', 6, 'uint16', 1000], ['power', 7, 'uint16'],
    ]},
    lap: {num: 19, fields: [
        ['timestamp', 253, 'uint32'], ['event', 0, 'enum'], ['eventType', 1, 'enum'],
        ['startTime', 2, 'uint32'], ['totalElapsedTime', 7, 'uint32', 1000],
        ['totalTimerTime', 8, 'uint32', 1000], ['totalDistance', 9, 'uint32', 100],
        ['totalCalories', 11, 'uint16'], ['avgSpeed', 13, 'uint16', 1000],
        ['avgHeartRate', 15, 'uint8'], ['maxHeartRate', 16, 'uint8'], ['avgCadence', 17, 'uint8'],
        ['avgPower', 19, 'uint16'], ['maxPower', 20, 'uint16'], ['sport', 25, 'enum'],
        ['subSport', 39, 'enum'],
    ]},
    session: {num: 18, fields: [
        ['timestamp', 253, 'uint32'], ['event', 0, 'enum'], ['eventType', 1, 'enum'],
        ['startTime', 2, 'uint32'], ['sport', 5, 'enum'], ['subSport', 6, 'enum'],
        ['totalElapsedTime', 7, 'uint32', 1000], ['totalTimerTime', 8, 'uint32', 1000],
        ['totalDistance', 9, 'uint32', 100], ['totalCalories', 11, 'uint16'],
        ['avgSpeed', 14, 'uint16', 1000], ['avgHeartRate', 16, 'uint8'], ['maxHeartRate', 17, 'uint8'],
        ['avgCadence', 18, 'uint8'], ['avgPower', 20, 'uint16'], ['maxPower', 21, 'uint16'],
        ['firstLapIndex', 25, 'uint16'], ['numLaps', 26, 'uint16'],
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

    function write(type, value) {
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
            out.write(type, fieldValue(type, values[field], scale));
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

// Ride -> Summary
//
// Ride {samples: [{t, power, heartRate, cadence, speed, distance}], events: [{t, type: 'start'|'stop'}]}
export function summarize({samples}) {
    if(samples.length === 0) return undefined;
    const first = samples[0];
    const last = samples[samples.length - 1];
    const power = samples.map((s) => s.power);
    const work = power.filter(Number.isFinite).reduce((a, b) => a + b, 0); // joules, one sample per second
    const timerTime = samples.length;
    const totalDistance = last.distance ?? undefined;

    return {
        startTime: first.t,
        endTime: last.t + 1,
        totalElapsedTime: last.t + 1 - first.t,
        totalTimerTime: timerTime,
        totalDistance,
        // roughly 1 kcal per kJ of work at the pedals
        totalCalories: work / 1000,
        avgSpeed: Number.isFinite(totalDistance) ? totalDistance / timerTime : undefined,
        avgPower: mean(power),
        maxPower: max(power),
        avgHeartRate: mean(samples.map((s) => s.heartRate).filter((x) => x > 0)),
        maxHeartRate: max(samples.map((s) => s.heartRate)),
        avgCadence: mean(samples.map((s) => s.cadence).filter((x) => x > 0)),
    };
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

    const totals = {
        timestamp: end,
        startTime: start,
        totalElapsedTime: summary.totalElapsedTime,
        totalTimerTime: summary.totalTimerTime,
        totalDistance: summary.totalDistance,
        totalCalories: summary.totalCalories,
        avgSpeed: summary.avgSpeed,
        avgHeartRate: summary.avgHeartRate,
        maxHeartRate: summary.maxHeartRate,
        avgCadence: summary.avgCadence,
        avgPower: summary.avgPower,
        maxPower: summary.maxPower,
        sport: enums.sportCycling,
        subSport: enums.subSportIndoorCycling,
    };
    w.message('lap', {...totals, event: enums.eventLap, eventType: enums.eventTypeStop});
    w.message('session', {
        ...totals, event: enums.eventSession, eventType: enums.eventTypeStop, firstLapIndex: 0, numLaps: 1,
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

function timerEvent(w, event) {
    w.message('event', {
        timestamp: toFitTime(event.t),
        event: enums.eventTimer,
        eventType: event.type === 'start' ? enums.eventTypeStart : enums.eventTypeStopAll,
    });
}
