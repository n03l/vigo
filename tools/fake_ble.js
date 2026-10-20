// A fake navigator.bluetooth for UI tests: an Elite Rampa, a heart rate strap and a
// speed/cadence sensor. Injected before the app loads; window.__ble records what the app writes.
//
// sessionStorage fakeble.trainer = "ftms" makes the trainer an FTMS one (KICKR-Fake) with Cycling
// Power, "ftms-ibd" one without it that only sends Indoor Bike Data.
//
// Like Chrome with the Web Bluetooth flags on, devices picked once stay allowed across reloads
// (kept in sessionStorage) and come back from getDevices(). Set window.__bleNoGetDevices before
// this script to get Chrome without the flags, or window.__bleNoPersist for the experimental flag
// without the new permissions backend: getDevices() exists but forgets everything on reload.
(() => {
    const uuid = (s) => `0000${s}-0000-1000-8000-00805f9b34fb`;
    const elite = '347b0001-7635-408b-8918-8ff3949ce592';
    const brake = '347b0010-7635-408b-8918-8ff3949ce592';
    const outOfRange = '347b0011-7635-408b-8918-8ff3949ce592';
    const ftms = uuid('1826');
    const controlPoint = uuid('2ad9');
    const bikeData = uuid('2ad2');
    const powerRange = uuid('2ad8');

    const load = (key, fallback) => {
        try { return JSON.parse(sessionStorage.getItem(key)) ?? fallback; } catch(_) { return fallback; }
    };
    const store = (key, value) => sessionStorage.setItem(key, JSON.stringify(value));

    const persist = !window.__bleNoPersist;
    const granted = new Set(persist ? load('fakeble.granted', []) : []);
    const storeGranted = () => { if(persist) store('fakeble.granted', [...granted]); };
    const available = load('fakeble.available', {trainer: true, hr: true, csc: true});
    const trainerKind = load('fakeble.trainer', 'rampa');
    const isFtms = trainerKind.startsWith('ftms');
    const names = load('fakeble.names', {trainer: isFtms ? 'KICKR-Fake' : 'RAMPA 12345', hr: 'HRM-Fake', csc: 'CSC-Fake'});

    const ble = window.__ble = {writes: [], target: 0, connects: 0, requests: [], forgotten: [], watching: {}};

    class Characteristic extends EventTarget {
        constructor(id, properties = {notify: true}) {
            super();
            this.uuid = id;
            this.properties = properties;
        }
        async startNotifications() { this.notifying = true; return this; }
        async readValue() {
            return new DataView(new Uint8Array(this.properties.value ?? []).buffer);
        }
        async writeValueWithResponse(value) {
            const bytes = [...new Uint8Array(value.buffer ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value)];
            ble.writes.push(bytes);
            await new Promise((r) => setTimeout(r, 20));
            if(this.uuid === controlPoint) {
                // 0x05 set target power, 0x08 stop/pause, answered with 0x80 <op> <result>
                if(bytes[0] === 0x05) ble.target = bytes[1] | (bytes[2] << 8);
                if(bytes[0] === 0x08) ble.target = 0;
                const result = ble.refuseControl && bytes[0] === 0x00 ? 0x05 : 0x01;
                setTimeout(() => this.emit([0x80, bytes[0], result]), 5);
                return;
            }
            if(bytes[0] === 0x00) ble.target = bytes[1] | (bytes[2] << 8);
            if(bytes[0] === 0x01) ble.target = 0;
        }
        emit(bytes) {
            if(!this.notifying) return;
            this.value = new DataView(new Uint8Array(bytes).buffer);
            this.dispatchEvent(new Event('characteristicvaluechanged'));
        }
    }

    function Device(kind, serviceMap) {
        const device = new EventTarget();
        device.id = `fake-${kind}-id`;
        device.name = names[kind];
        let chars = {};
        const server = {
            connected: false,
            async connect() {
                ble.connects += 1;
                await new Promise((r) => setTimeout(r, 10));
                if(!available[kind]) throw new DOMException('Bluetooth Device is no longer in range.', 'NetworkError');
                chars = {};
                server.connected = true;
                return server;
            },
            disconnect() {
                if(!server.connected) return;
                server.connected = false;
                device.dispatchEvent(new Event('gattserverdisconnected'));
            },
            async getPrimaryService(id) {
                if(!server.connected) throw new DOMException('GATT Server is disconnected', 'NetworkError');
                if(!(id in serviceMap)) throw new DOMException(`No Services matching UUID ${id}`, 'NotFoundError');
                return {
                    uuid: id,
                    async getCharacteristic(cid) {
                        if(!(cid in serviceMap[id])) throw new DOMException(`No Characteristics matching UUID ${cid}`, 'NotFoundError');
                        chars[cid] ??= new Characteristic(cid, serviceMap[id][cid]);
                        return chars[cid];
                    },
                };
            },
        };
        device.gatt = server;
        device.char = (cid) => chars[cid];
        device.forget = async () => {
            ble.forgotten.push(kind);
            granted.delete(kind);
            storeGranted();
            server.disconnect();
        };
        device.watchAdvertisements = async ({signal} = {}) => {
            ble.watching[kind] = true;
            signal?.addEventListener('abort', () => { ble.watching[kind] = false; });
        };
        return device;
    }

    const devices = {
        trainer: Device('trainer', isFtms
            ? {
                [ftms]: {
                    [controlPoint]: {write: true, indicate: true},
                    [bikeData]: {notify: true},
                    [powerRange]: {read: true, value: [0x00, 0x00, 0xd0, 0x07, 0x01, 0x00]}, // 0..2000 W
                },
                ...(trainerKind === 'ftms-ibd' ? {} : {[uuid('1818')]: {[uuid('2a63')]: {notify: true}}}),
            }
            : {
                [elite]: {[brake]: {write: true}, [outOfRange]: {notify: true}},
                [uuid('1818')]: {[uuid('2a63')]: {notify: true}},
            }),
        hr: Device('hr', {[uuid('180d')]: {[uuid('2a37')]: {notify: true}}}),
        csc: Device('csc', {[uuid('1816')]: {[uuid('2a5b')]: {notify: true}}}),
    };
    const { trainer, hr, csc } = devices;
    const byService = {[elite]: 'trainer', [ftms]: 'trainer', [uuid('180d')]: 'hr', [uuid('1816')]: 'csc'};

    ble.dropTrainer = () => trainer.gatt.disconnect();
    ble.outOfRange = (on) => trainer.char(outOfRange)?.emit([on ? 1 : 0]);
    // advertise: false is a device that is on but whose advertisement the browser hasn't seen yet
    ble.setAvailable = (kind, on, {advertise = true} = {}) => {
        available[kind] = on;
        store('fakeble.available', available);
        if(!on) devices[kind].gatt.disconnect();
        else if(advertise && ble.watching[kind]) devices[kind].dispatchEvent(new Event('advertisementreceived'));
    };
    ble.granted = () => [...granted];

    navigator.bluetooth = {
        async requestDevice(options) {
            const filter = options?.filters?.[0] ?? {};
            ble.requests.push(JSON.parse(JSON.stringify(options ?? {})));
            const kind = byService[filter.services?.[0]];
            const device = devices[kind];
            // a name filter only lists that device, another name means nothing to pick
            if(!device || (filter.name !== undefined && filter.name !== device.name)) {
                throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
            }
            granted.add(kind);
            storeGranted();
            return device;
        },
    };
    if(!window.__bleNoGetDevices) {
        navigator.bluetooth.getDevices = async () => [...granted].map((kind) => devices[kind]);
    }

    // sensor data
    const t0 = performance.now();
    const u16 = (x) => [x & 0xff, (x >> 8) & 0xff];
    const u32 = (x) => [x & 0xff, (x >>> 8) & 0xff, (x >>> 16) & 0xff, (x >>> 24) & 0xff];
    const revs = (rate, s, resolution) => {
        const count = Math.floor(rate * s);
        return [count, Math.floor(count / rate * resolution)];
    };

    setInterval(() => {
        const s = (performance.now() - t0) / 1000;
        if(trainer.gatt.connected) {
            const [cr, ct] = revs(1.5, s, 1024);
            const power = ble.target ? ble.target + (Math.round(s) % 3) - 1 : 0;
            trainer.char(uuid('2a63'))?.emit([0x20, 0x00, ...u16(power), ...u16(cr & 0xffff), ...u16(ct & 0xffff)]);
            // more data (no speed), cadence 92 rpm in 0.5 rpm, power
            trainer.char(bikeData)?.emit([0x45, 0x00, ...u16(184), ...u16(power)]);
        }
        if(hr.gatt.connected) hr.char(uuid('2a37'))?.emit([0x00, 140]);
        if(csc.gatt.connected) {
            const [cr, ct] = revs(85 / 60, s, 1024);
            const [wr, wt] = revs(4, s, 1024);    // 4 rev/s x 2.105 m = 30.3 km/h
            csc.char(uuid('2a5b'))?.emit([0x03, ...u32(wr), ...u16(wt & 0xffff), ...u16(cr & 0xffff), ...u16(ct & 0xffff)]);
        }
    }, 250);
})();
