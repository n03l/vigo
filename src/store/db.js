//
// IndexedDB storage for workouts and rides
//
// workouts  {id, name, fileName, text, addedAt, lastUsedAt}       uploads only
// rides     {id, startedAt, workoutName, ftp, interrupted, summary} for the history list
// rideData  {id, workoutName, ftp, events, samples}                 read only to export
// meta      {id: 'writer', value: tab id}                           the tab that saves (claim)
//           {id: 'sync', value: SyncState}                          Google Drive sync, see sync.js
//
// One tab saves at a time. Each tab, the installed app's window and a forgotten background tab keep their own
// copy of the settings and the sync state, so an older one must not write over what a newer one saved. At
// start a tab claims the data; every write checks the claim in the same transaction and fails with an
// OtherTabError (and onOtherTab) once another tab has claimed it. Saving a ride is the exception: a ride is
// new data under its own key, so the tab that recorded it can always keep it.
//
// Records come back from the browser's storage, callers validate them before use.
//

const dbName = 'vigo';
const version = 2;
const storeNames = ['workouts', 'rides', 'rideData', 'meta'];

const promisify = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

// Void -> Error
export const otherTabError = () => Object.assign(
    new Error('vigo is open in another tab or window, which saves from now on.'), {code: 'other-tab'});
export const isOtherTab = (error) => error?.code === 'other-tab';

// a random id for this tab, crypto.randomUUID needs a secure context and the LAN address has none
function tabId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function open(onBlocked) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);
        request.onupgradeneeded = () => {
            const db = request.result;
            for(const name of storeNames) {
                if(!db.objectStoreNames.contains(name)) db.createObjectStore(name, {keyPath: 'id'});
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        // an older version in another tab holds the database open; the upgrade goes on once it closes
        request.onblocked = () => onBlocked?.();
    });
}

function IndexedStore(db, {onOtherTab = () => {}} = {}) {
    const tab = tabId();

    // guarded: a write that first checks this tab still holds the claim
    function run(names, mode, fn, guarded = false) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(guarded ? [...names, 'meta'] : names, mode);
            let result;
            let other = false;
            const go = () => Promise.resolve(fn(tx)).then((value) => { result = value; }, reject);
            if(guarded) {
                const writer = tx.objectStore('meta').get('writer');
                writer.onsuccess = () => {
                    const holder = writer.result?.value;
                    if(holder !== undefined && holder !== tab) {
                        other = true;
                        tx.abort();
                    } else {
                        go();
                    }
                };
            } else {
                go();
            }
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => {
                if(other) onOtherTab();
                reject(other ? otherTabError() : tx.error ?? new Error('transaction aborted'));
            };
        });
    }
    const write = (names, fn) => run(names, 'readwrite', fn, true);

    return Object.freeze({
        persistent: true,
        getAll: (name) => run([name], 'readonly', (tx) => promisify(tx.objectStore(name).getAll())),
        get: (name, id) => run([name], 'readonly', (tx) => promisify(tx.objectStore(name).get(id))),
        put: (name, value) => write([name], (tx) => { tx.objectStore(name).put(value); }),
        delete: (name, id) => write([name], (tx) => { tx.objectStore(name).delete(id); }),
        // the history row and its data are written and deleted together
        putRide: (meta, data) => run(['rides', 'rideData'], 'readwrite', (tx) => {
            tx.objectStore('rides').put(meta);
            tx.objectStore('rideData').put(data);
        }),
        deleteRide: (id) => write(['rides', 'rideData'], (tx) => {
            tx.objectStore('rides').delete(id);
            tx.objectStore('rideData').delete(id);
        }),
        // ([workout], [{meta, data}]) -> Promise, everything replaced at once (Drive's copy taken)
        replaceAll: (workouts, rides) => write(['workouts', 'rides', 'rideData'], (tx) => {
            for(const name of ['workouts', 'rides', 'rideData']) tx.objectStore(name).clear();
            for(const w of workouts) tx.objectStore('workouts').put(w);
            for(const {meta, data} of rides) {
                tx.objectStore('rides').put(meta);
                tx.objectStore('rideData').put(data);
            }
        }),
        // a value in meta, undefined deletes it
        getMeta: (id) => run(['meta'], 'readonly', (tx) => promisify(tx.objectStore('meta').get(id)))
            .then((record) => record?.value),
        putMeta: (id, value) => write([], (tx) => {
            if(value === undefined) tx.objectStore('meta').delete(id);
            else tx.objectStore('meta').put({id, value});
        }),
        // this tab saves from now on, the others stop
        claim: () => run(['meta'], 'readwrite', (tx) => { tx.objectStore('meta').put({id: 'writer', value: tab}); }),
        isWriter: () => run(['meta'], 'readonly', (tx) => promisify(tx.objectStore('meta').get('writer')))
            .then((record) => record?.value === undefined || record.value === tab),
    });
}

// same interface, gone on reload, for browsers where IndexedDB is blocked
export function MemoryStore() {
    const stores = Object.fromEntries(storeNames.map((name) => [name, new Map()]));
    const copy = (x) => (x === undefined ? undefined : structuredClone(x));
    return Object.freeze({
        persistent: false,
        getAll: async (name) => [...stores[name].values()].map(copy),
        get: async (name, id) => copy(stores[name].get(id)),
        put: async (name, value) => { stores[name].set(value.id, copy(value)); },
        delete: async (name, id) => { stores[name].delete(id); },
        putRide: async (meta, data) => {
            stores.rides.set(meta.id, copy(meta));
            stores.rideData.set(data.id, copy(data));
        },
        deleteRide: async (id) => {
            stores.rides.delete(id);
            stores.rideData.delete(id);
        },
        replaceAll: async (workouts, rides) => {
            for(const name of ['workouts', 'rides', 'rideData']) stores[name].clear();
            for(const w of workouts) stores.workouts.set(w.id, copy(w));
            for(const {meta, data} of rides) {
                stores.rides.set(meta.id, copy(meta));
                stores.rideData.set(data.id, copy(data));
            }
        },
        getMeta: async (id) => copy(stores.meta.get(id)),
        putMeta: async (id, value) => {
            if(value === undefined) stores.meta.delete(id);
            else stores.meta.set(id, copy(value));
        },
        claim: async () => {},
        isWriter: async () => true,
    });
}

// ({onBlocked?, onOtherTab?, onVersionChange?}) -> Promise<Store>
export async function openStore({onBlocked, onOtherTab, onVersionChange} = {}) {
    try {
        if(typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
        const db = await open(onBlocked);
        // a newer vigo in another tab needs the database: let it go, this tab can't save any more
        db.onversionchange = () => {
            db.close();
            onVersionChange?.();
        };
        const store = IndexedStore(db, {onOtherTab});
        await store.claim();
        // ask the browser not to evict rides when space runs low, it may say no
        navigator.storage?.persist?.().catch(() => {});
        return store;
    } catch(error) {
        console.warn('vigo: IndexedDB unavailable, nothing will be kept', error);
        return MemoryStore();
    }
}
