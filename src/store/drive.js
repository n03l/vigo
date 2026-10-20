//
// Google Drive from the browser
//
// Google Identity Services hands out short-lived access tokens (about an hour, no refresh token without a
// backend) and the Drive REST API stores one JSON file, marked with appProperties {vigo: 'data'}. The scope
// is drive.file, so vigo sees only files it created. Tokens stay in memory: never stored, put in a URL or
// logged. Every reply is checked (parseRemoteFile, the account id); the file itself is the caller's to check.
//

import { driveId, parseRemoteFile } from './sync.js';
import { maxBytes } from './backup.js';

const gisUrl = 'https://accounts.google.com/gsi/client';
const scope = 'https://www.googleapis.com/auth/drive.file';
const filesUrl = 'https://www.googleapis.com/drive/v3/files';
const aboutUrl = 'https://www.googleapis.com/drive/v3/about';
const uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files';
const fileName = 'vigo data.json';
const fields = 'id,version';

// Any -> String, the OAuth client id from config.json, or '' when Drive sync isn't set up; it is public
export const clientIdOf = (v) => (typeof v === 'string' && /^[\w-]{1,200}\.apps\.googleusercontent\.com$/.test(v) ? v : '');

// (String, String?) -> Error; code 'signin': no valid token, getting one needs a tap
export function driveError(message, code = 'drive') {
    return Object.assign(new Error(message), {code});
}

export const needsSignIn = (error) => error?.code === 'signin';

let gisLoad = null;

// Void -> Promise<Gis>, Google's sign-in script, loaded on first use so an offline start doesn't need it
export function loadGis() {
    gisLoad ??= new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = gisUrl;
        script.async = true;
        script.onload = () => {
            const gis = window.google?.accounts?.oauth2;
            if(gis) resolve(gis);
            else reject(driveError('Google sign-in didn’t load. Try again later.'));
        };
        script.onerror = () => {
            gisLoad = null;
            script.remove();
            reject(driveError('Couldn’t reach Google sign-in. Check your connection and try again.'));
        };
        document.head.append(script);
    });
    return gisLoad;
}

const signInError = (type) => (type === 'popup_closed' ? 'The Google sign-in window was closed before it finished.'
    : type === 'popup_failed_to_open' ? 'The browser blocked the Google sign-in window. Allow pop-ups for this site and try again.'
    : 'Google sign-in failed. Try again.');

function statusError(status) {
    if(status === 401) return driveError('Tap Sync now to sign in to Google again.', 'signin');
    if(status === 403) return driveError('Drive refused the request (403). Disconnect and connect Google Drive again in Settings.');
    if(status === 404) return driveError('The vigo file is no longer in Drive.', 'notfound');
    if(status === 429 || status >= 500) return driveError(`Drive is busy right now (${status}). Try again in a minute.`);
    return driveError(`Drive request failed (${status}).`);
}

const own = (o, key) => (typeof o === 'object' && o !== null && Object.hasOwn(o, key) ? o[key] : undefined);

// (String, {gis?, fetch?}) -> DriveApi
export function DriveApi(clientId, {gis = loadGis, fetch: fetchFn = (...a) => fetch(...a)} = {}) {
    let token = null; // {value, expiresAt, account?}
    let prompt = '';  // 'select_account' after a sign-in to the wrong account

    const hasToken = () => token !== null && token.expiresAt > Date.now() + 60_000;

    // Boolean -> Promise<String>; without a token, interactive opens Google's sign-in window (from a tap only)
    async function getToken(interactive) {
        if(hasToken()) return token.value;
        if(!interactive) throw driveError('Tap Sync now to sign in to Google again.', 'signin');
        if(!clientId) throw driveError('Drive sync isn’t set up in this build.');
        const g = await gis();
        const r = await new Promise((resolve, reject) => {
            g.initTokenClient({
                client_id: clientId,
                scope,
                callback: resolve,
                error_callback: (e) => reject(driveError(signInError(e?.type))),
            }).requestAccessToken({prompt});
        });
        const value = own(r, 'access_token');
        if(own(r, 'error') || typeof value !== 'string' || !value) {
            throw driveError(own(r, 'error') === 'access_denied' ? 'Google sign-in was cancelled.' : signInError());
        }
        if(!g.hasGrantedAllScopes(r, scope)) {
            throw driveError('vigo needs permission to keep its file in your Drive. Connect again and allow it.');
        }
        const seconds = Number(own(r, 'expires_in'));
        token = {value, expiresAt: Date.now() + (Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) : 3000) * 1000};
        prompt = '';
        return value;
    }

    async function call(url, init = {}) {
        const value = await getToken(false);
        let response;
        try {
            response = await fetchFn(url, {...init, headers: {...init.headers, Authorization: `Bearer ${value}`}});
        } catch(_) {
            throw driveError('Couldn’t reach Google Drive. Check your connection and try again.');
        }
        if(response.status === 401) token = null;
        if(!response.ok) throw statusError(response.status);
        return response;
    }

    async function json(url, init) {
        const response = await call(url, init);
        try {
            return await response.json();
        } catch(_) {
            throw driveError('Drive sent a reply vigo couldn’t read.');
        }
    }

    // Void -> Promise<String>, Drive's permission id for the signed-in account (the token doesn't say)
    async function account() {
        const t = token;
        if(t?.account) return t.account;
        const id = own(own(await json(`${aboutUrl}?fields=${encodeURIComponent('user(permissionId)')}`), 'user'), 'permissionId');
        if(typeof id !== 'string' || !driveId.test(id)) throw driveError('Drive sent an unexpected account description.');
        if(t && token === t) t.account = id;
        return id;
    }

    // Void -> Promise<{id, version} | null>, the vigo file, the newest if there are several
    async function find() {
        const q = "appProperties has { key='vigo' and value='data' } and trashed = false";
        const url = `${filesUrl}?q=${encodeURIComponent(q)}&orderBy=modifiedTime%20desc&pageSize=10&spaces=drive`
            + `&fields=${encodeURIComponent(`files(${fields})`)}`;
        const files = own(await json(url), 'files');
        if(!Array.isArray(files)) throw driveError('Drive sent an unexpected file list.');
        return files.length ? parseRemoteFile(files[0]) : null;
    }

    // String -> Promise<{id, version} | null>, null when the file was deleted or trashed
    async function meta(id) {
        try {
            const body = await json(`${filesUrl}/${encodeURIComponent(id)}?fields=${fields},trashed`);
            if(own(body, 'trashed') === true) return null;
            return parseRemoteFile(body);
        } catch(error) {
            if(error.code === 'notfound') return null;
            throw error;
        }
    }

    // String -> Promise<String>, the file's text, unchecked: callers read it with readBackup
    async function download(id) {
        const response = await call(`${filesUrl}/${encodeURIComponent(id)}?alt=media`);
        const tooBig = () => driveError('The file in Drive is larger than 200 MB, too big to be vigo data.');
        if(Number(response.headers.get('content-length')) > maxBytes) throw tooBig();
        const text = await response.text();
        if(text.length > maxBytes) throw tooBig();
        return text;
    }

    // String -> Promise<{id, version}>
    async function create(text) {
        const boundary = `vigo-${Math.random().toString(36).slice(2)}`;
        const metadata = {name: fileName, mimeType: 'application/json', appProperties: {vigo: 'data'}};
        const body = [
            `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(metadata),
            `--${boundary}`, 'Content-Type: application/json', '', text,
            `--${boundary}--`, '',
        ].join('\r\n');
        return parseRemoteFile(await json(`${uploadUrl}?uploadType=multipart&fields=${fields}`, {
            method: 'POST',
            headers: {'Content-Type': `multipart/related; boundary=${boundary}`},
            body,
        }));
    }

    // (String, String) -> Promise<{id, version}>
    async function update(id, text) {
        return parseRemoteFile(await json(`${uploadUrl}/${encodeURIComponent(id)}?uploadType=media&fields=${fields}`, {
            method: 'PATCH',
            headers: {'Content-Type': 'application/json'},
            body: text,
        }));
    }

    return Object.freeze({
        hasToken,
        token: getToken,
        account,
        find,
        meta,
        download,
        create,
        update,
        // drop a wrong account's token (without revoking it) and offer the account chooser next time
        chooseAccount() {
            token = null;
            prompt = 'select_account';
        },
        // forget the token and ask Google to revoke it; the file in Drive stays
        async signOut() {
            const value = token?.value;
            token = null;
            if(value) await gis().then((g) => g.revoke(value), () => undefined);
        },
    });
}
