//
// Saved Bluetooth devices
//
// Only the id and name are kept, Chrome keeps the permission itself. The id is what getDevices()
// returns for the same device, the name is used to filter the picker when getDevices() isn't there.
//

const storageKey = 'vigo.devices';
export const kinds = Object.freeze(['trainer', 'hr', 'csc']);

const isText = (x, max) => typeof x === 'string' && x.length > 0 && x.length <= max;

export function defaultConfig() {
    return {version: 1, autoConnect: true, devices: {}};
}

// untrusted value -> config, anything unexpected is dropped
export function sanitizeConfig(data) {
    const config = defaultConfig();
    if(typeof data !== 'object' || data === null || Array.isArray(data)) return config;
    if(typeof data.autoConnect === 'boolean') config.autoConnect = data.autoConnect;

    const devices = data.devices;
    if(typeof devices !== 'object' || devices === null || Array.isArray(devices)) return config;
    for(const kind of kinds) {
        if(!Object.hasOwn(devices, kind)) continue;
        const d = devices[kind];
        if(isText(d?.id, 128) && isText(d?.name, 64)) config.devices[kind] = {id: d.id, name: d.name};
    }
    return config;
}

export function loadDeviceConfig(storage = globalThis.localStorage) {
    try {
        return sanitizeConfig(JSON.parse(storage?.getItem(storageKey) ?? 'null'));
    } catch(_) {
        return defaultConfig();
    }
}

export function saveDeviceConfig(config, storage = globalThis.localStorage) {
    try {
        storage?.setItem(storageKey, JSON.stringify(sanitizeConfig(config)));
    } catch(error) {
        console.warn('vigo: could not save the devices', error);
    }
}

// (Config, String, BluetoothDevice) -> Config
export function rememberDevice(config, kind, device) {
    if(!kinds.includes(kind)) return config;
    const next = sanitizeConfig({...config, devices: {...config.devices, [kind]: {id: device?.id, name: device?.name}}});
    // a device without a usable id or name can't be found again, keep what was saved
    return Object.hasOwn(next.devices, kind) ? next : config;
}

// (Config, String) -> Config
export function unregisterDevice(config, kind) {
    const devices = {...config.devices};
    delete devices[kind];
    return sanitizeConfig({...config, devices});
}

// (Picker, String) -> Picker, the same picker narrowed to one device name
export function pickerFor(picker, name) {
    return {
        ...picker,
        filters: picker.filters.map((filter) => ({...filter, name})),
    };
}
