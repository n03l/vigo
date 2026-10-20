//
// IndexedDB storage for workouts and rides
//
// workouts  {id, name, fileName, text, addedAt, lastUsedAt}       uploads only
// rides     {id, startedAt, workoutName, ftp, interrupted, summary} for the history list
// rideData  {id, workoutName, ftp, events, samples}                 read only to export
//
// Records come back from the browser's storage, callers validate them before use.
//

const dbName = 'vigo';
const version = 1;
const storeNames = ['workouts', 'rides', 'rideData'];

const promisify = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
});

function open() {
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
        request.onblocked = () => reject(new Error('the database is open in an older tab'));
    });
}

function IndexedStore(db) {
    function run(names, mode, fn) {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(names, mode);
            let result;
            Promise.resolve(fn(tx)).then((value) => { result = value; }, reject);
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
        });
    }

    return Object.freeze({
        persistent: true,
        getAll: (name) => run([name], 'readonly', (tx) => promisify(tx.objectStore(name).getAll())),
        get: (name, id) => run([name], 'readonly', (tx) => promisify(tx.objectStore(name).get(id))),
        put: (name, value) => run([name], 'readwrite', (tx) => { tx.objectStore(name).put(value); }),
        delete: (name, id) => run([name], 'readwrite', (tx) => { tx.objectStore(name).delete(id); }),
        // the history row and its data are written and deleted together
        putRide: (meta, data) => run(['rides', 'rideData'], 'readwrite', (tx) => {
            tx.objectStore('rides').put(meta);
            tx.objectStore('rideData').put(data);
        }),
        deleteRide: (id) => run(['rides', 'rideData'], 'readwrite', (tx) => {
            tx.objectStore('rides').delete(id);
            tx.objectStore('rideData').delete(id);
        }),
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
    });
}

// Void -> Promise<Store>
export async function openStore() {
    try {
        if(typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
        const store = IndexedStore(await open());
        // ask the browser not to evict rides when space runs low, it may say no
        navigator.storage?.persist?.().catch(() => {});
        return store;
    } catch(error) {
        console.warn('vigo: IndexedDB unavailable, nothing will be kept', error);
        return MemoryStore();
    }
}
