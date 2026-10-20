import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    encodeRequestControl, encodeStart, encodePause, encodeTargetPower,
    parseControlPointResponse, parseSupportedPowerRange, parseIndoorBikeData, describeResult,
} from '../src/ble/ftms.js';
import { trainerSetup } from '../src/ble/device.js';
import { services, characteristics } from '../src/ble/uuids.js';

const view = (bytes) => new DataView(new Uint8Array(bytes).buffer);
const array = (u8) => [...u8];

test('FTMS control point commands', () => {
    assert.deepEqual(array(encodeRequestControl()), [0x00]);
    assert.deepEqual(array(encodeStart()), [0x07]);
    assert.deepEqual(array(encodePause()), [0x08, 0x02]);
    assert.deepEqual(array(encodeTargetPower(200)), [0x05, 0xc8, 0x00]);
    assert.deepEqual(array(encodeTargetPower(300)), [0x05, 0x2c, 0x01]);
    assert.deepEqual(array(encodeTargetPower(199.6)), [0x05, 0xc8, 0x00]);
    assert.deepEqual(array(encodeTargetPower(-10)), [0x05, 0x00, 0x00]);
    assert.deepEqual(array(encodeTargetPower(NaN)), [0x05, 0x00, 0x00]);
    assert.deepEqual(array(encodeTargetPower(5000)), [0x05, 0xa0, 0x0f]);
    // clamped to what the trainer says it supports
    assert.deepEqual(array(encodeTargetPower(5000, {min: 25, max: 1500})), [0x05, 0xdc, 0x05]);
    assert.deepEqual(array(encodeTargetPower(10, {min: 25, max: 1500})), [0x05, 0x19, 0x00]);
    assert.deepEqual(array(encodeTargetPower(50000, {min: -5, max: 40000})), [0x05, 0xff, 0x7f]);
});

test('FTMS control point responses', () => {
    assert.deepEqual(parseControlPointResponse(view([0x80, 0x00, 0x01])), {opCode: 0x00, result: 0x01});
    assert.deepEqual(parseControlPointResponse(view([0x80, 0x05, 0x05])), {opCode: 0x05, result: 0x05});
    assert.equal(parseControlPointResponse(view([0x80, 0x05])), undefined);
    assert.equal(parseControlPointResponse(view([0x05, 0xc8, 0x00])), undefined);
    assert.equal(describeResult(0x05), 'control not permitted');
    assert.equal(describeResult(0x42), 'error 66');
});

test('FTMS supported power range', () => {
    assert.deepEqual(parseSupportedPowerRange(view([0x00, 0x00, 0xd0, 0x07, 0x01, 0x00])), {min: 0, max: 2000, step: 1});
    assert.equal(parseSupportedPowerRange(view([0x00, 0x00, 0xd0])), undefined);
    assert.equal(parseSupportedPowerRange(view([0x10, 0x00, 0x00, 0x00, 0x01, 0x00])), undefined); // max 0
    assert.equal(parseSupportedPowerRange(view([0xe8, 0x03, 0x64, 0x00, 0x01, 0x00])), undefined); // max < min
});

test('FTMS indoor bike data', () => {
    // speed (bit 0 clear) 30.00 km/h, cadence 85 rpm, power 250 W
    assert.deepEqual(parseIndoorBikeData(view([0x44, 0x00, 0xb8, 0x0b, 0xaa, 0x00, 0xfa, 0x00])),
        {speed: 30, cadence: 85, power: 250});
    // more data set: no speed; cadence 90.5, total distance and resistance skipped, power 180
    assert.deepEqual(parseIndoorBikeData(view([0x75, 0x00, 0xb5, 0x00, 0x10, 0x27, 0x00, 0x14, 0x00, 0xb4, 0x00])),
        {cadence: 90.5, power: 180});
    // average speed, average cadence and heart rate skipped
    assert.deepEqual(parseIndoorBikeData(view([0x4e, 0x02, 0x01, 0x00, 0x02, 0x00, 0xa0, 0x00, 0x04, 0x00, 0x2c, 0x01, 0x8c])),
        {speed: 0.01, cadence: 80, power: 300});
    // negative power is passed on, the app floors it
    assert.deepEqual(parseIndoorBikeData(view([0x41, 0x00, 0xf6, 0xff])), {power: -10});
    // truncated: keeps what was complete
    assert.deepEqual(parseIndoorBikeData(view([0x44, 0x00, 0xb8, 0x0b, 0xaa])), {speed: 30});
    assert.deepEqual(parseIndoorBikeData(view([0x00, 0x00, 0xb8])), {});
    // unknown high flags with nothing after them
    assert.deepEqual(parseIndoorBikeData(view([0x01, 0xe0])), {});
    assert.throws(() => parseIndoorBikeData(view([0x44])), RangeError);
});

// a GATT server with the given services, {serviceUuid: {charUuid: {read?, onWrite?}}}
function fakeServer(layout) {
    const chars = {};
    const written = [];
    const server = {
        async getPrimaryService(uuid) {
            if(!(uuid in layout)) throw new DOMException(`No Services matching UUID ${uuid}`, 'NotFoundError');
            return {
                async getCharacteristic(cid) {
                    const spec = layout[uuid][cid];
                    if(!spec) throw new DOMException(`No Characteristics matching UUID ${cid}`, 'NotFoundError');
                    if(chars[cid]) return chars[cid];
                    const c = new EventTarget();
                    c.properties = {write: true, notify: true};
                    c.startNotifications = async () => { c.notifying = true; };
                    c.readValue = async () => view(spec.read);
                    c.writeValueWithResponse = async (value) => {
                        const bytes = array(value);
                        written.push(bytes);
                        const reply = spec.onWrite?.(bytes);
                        if(reply) queueMicrotask(() => c.emit(reply));
                    };
                    c.emit = (bytes) => {
                        c.value = view(bytes);
                        c.dispatchEvent(new Event('characteristicvaluechanged'));
                    };
                    return (chars[cid] = c);
                },
            };
        },
    };
    return {server, chars, written};
}

const ftmsLayout = ({cps = true, reply = () => 0x01} = {}) => ({
    [services.fitnessMachine]: {
        [characteristics.ftmsControlPoint]: {onWrite: (bytes) => [0x80, bytes[0], reply(bytes)]},
        [characteristics.supportedPowerRange]: {read: [0x00, 0x00, 0xe8, 0x03, 0x01, 0x00]},
        [characteristics.indoorBikeData]: {},
    },
    ...(cps ? {[services.cyclingPower]: {[characteristics.cyclingPowerMeasurement]: {}}} : {}),
});

const settle = () => new Promise((r) => setTimeout(r, 5));

test('FTMS trainer: control, target, pause, power from Cycling Power', async () => {
    const {server, chars, written} = fakeServer(ftmsLayout());
    const powers = [];
    const link = await trainerSetup({onPower: (d) => powers.push(d), onOutOfRange: () => {}})(server);
    assert.equal(link.protocol, 'FTMS');
    assert.deepEqual(written, [[0x00]]);

    await link.setTarget(200);
    await link.setTarget(1200); // clamped to the 1000 W the trainer supports
    await link.release();
    await link.setTarget(150);   // started again after the pause
    assert.deepEqual(written, [[0x00], [0x07], [0x05, 0xc8, 0x00], [0x05, 0xe8, 0x03],
        [0x08, 0x02], [0x07], [0x05, 0x96, 0x00]]);

    assert.equal(chars[characteristics.indoorBikeData], undefined, 'Cycling Power is preferred');
    chars[characteristics.cyclingPowerMeasurement].emit([0x00, 0x00, 0xc8, 0x00]);
    assert.deepEqual(powers, [{power: 200}]);
});

test('FTMS trainer without Cycling Power uses Indoor Bike Data', async (t) => {
    const warn = console.warn;
    console.warn = () => {};
    t.after(() => { console.warn = warn; });
    const {server, chars} = fakeServer(ftmsLayout({cps: false}));
    const powers = [];
    const cadences = [];
    const link = await trainerSetup({onPower: (d) => powers.push(d), onCadence: (c) => cadences.push(c), onOutOfRange: () => {}})(server);
    assert.equal(link.protocol, 'FTMS');
    chars[characteristics.indoorBikeData].emit([0x44, 0x00, 0xb8, 0x0b, 0xaa, 0x00, 0xfa, 0x00]);
    chars[characteristics.indoorBikeData].emit([0x44]); // malformed, skipped
    assert.deepEqual(powers, [{power: 250}]);
    assert.deepEqual(cadences, [85]);
});

test('FTMS trainer that refuses control or never answers fails the setup', async (t) => {
    const warn = console.warn;
    console.warn = () => {};
    t.after(() => { console.warn = warn; });

    const refusing = fakeServer(ftmsLayout({reply: () => 0x05}));
    await assert.rejects(trainerSetup({onPower: () => {}, onOutOfRange: () => {}})(refusing.server), /control not permitted/);

    const silent = fakeServer(ftmsLayout());
    silent.server.getPrimaryService = ((get) => async (uuid) => {
        const service = await get(uuid);
        return {getCharacteristic: async (cid) => {
            const c = await service.getCharacteristic(cid);
            if(cid === characteristics.ftmsControlPoint) c.writeValueWithResponse = async () => {};
            return c;
        }};
    })(silent.server.getPrimaryService);
    await assert.rejects(trainerSetup({onPower: () => {}, onOutOfRange: () => {}, responseTimeout: 20})(silent.server), /no answer/);
});

test('FTMS target write that is refused is logged and the next one still goes out', async (t) => {
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    t.after(() => { console.warn = warn; });

    const {server, written} = fakeServer(ftmsLayout({reply: (bytes) => bytes[0] === 0x05 && bytes[1] === 0x2c ? 0x03 : 0x01}));
    const link = await trainerSetup({onPower: () => {}, onOutOfRange: () => {}})(server);
    await link.setTarget(300);
    await link.setTarget(200);
    await settle();
    assert.deepEqual(written.slice(-2), [[0x05, 0x2c, 0x01], [0x05, 0xc8, 0x00]]);
    assert.ok(warnings.some((w) => /invalid parameter/.test(w)));
});

test('a trainer with both services is driven through the Elite service', async () => {
    const {server, written} = fakeServer({
        ...ftmsLayout(),
        [services.elite]: {[characteristics.eliteBrake]: {}, [characteristics.eliteOutOfRange]: {}},
    });
    const link = await trainerSetup({onPower: () => {}, onOutOfRange: () => {}})(server);
    assert.equal(link.protocol, 'Elite');
    await link.setTarget(200);
    assert.deepEqual(written, [[0x00, 0xc8, 0x00]]);
});

test('a trainer with neither service is refused', async () => {
    const {server} = fakeServer({[services.cyclingPower]: {[characteristics.cyclingPowerMeasurement]: {}}});
    await assert.rejects(trainerSetup({onPower: () => {}, onOutOfRange: () => {}})(server), /neither the Elite nor the FTMS/);
});
