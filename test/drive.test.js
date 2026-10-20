import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DriveApi, clientIdOf, needsSignIn } from '../src/store/drive.js';

const id = '123-abc.apps.googleusercontent.com';
const hostile = '<img src=x onerror=alert(1)>';

function fakeGis(reply = {access_token: 'tok', expires_in: 3599}, granted = true) {
    const calls = {requests: 0, revoked: [], prompts: []};
    const gis = {
        initTokenClient: ({callback}) => ({requestAccessToken: (opts) => {
            calls.requests += 1;
            calls.prompts.push(opts?.prompt);
            callback(reply);
        }}),
        hasGrantedAllScopes: () => granted,
        revoke: (t) => calls.revoked.push(t),
    };
    return {gis: async () => gis, calls};
}

function fakeFetch(route) {
    const seen = [];
    const fetch = async (url, init = {}) => {
        seen.push({url, init});
        return route(url, init);
    };
    return {fetch, seen};
}

const json = (v, status = 200) => new Response(JSON.stringify(v), {status, headers: {'Content-Type': 'application/json'}});

async function signedIn(route, gis = fakeGis()) {
    const {fetch, seen} = fakeFetch(route);
    const api = DriveApi(id, {gis: gis.gis, fetch});
    await api.token(true);
    return {api, seen, calls: gis.calls};
}

test('the client id must look like one', () => {
    assert.equal(clientIdOf(id), id);
    for(const bad of ['', 'x', hostile, `${id}?x`, 42, null, undefined]) assert.equal(clientIdOf(bad), '');
});

test('it needs a tap before it has a token', async () => {
    const api = DriveApi(id, {gis: fakeGis().gis, fetch: fakeFetch(() => json({})).fetch});
    await assert.rejects(api.find(), (e) => needsSignIn(e));
    assert.equal(api.hasToken(), false);
});

test('sign-in refusals and missing scopes are errors', async () => {
    await assert.rejects(DriveApi(id, {gis: fakeGis(undefined, false).gis}).token(true), /permission/);
    await assert.rejects(DriveApi(id, {gis: fakeGis({error: 'access_denied'}).gis}).token(true), /cancelled/);
    await assert.rejects(DriveApi(id, {gis: fakeGis({access_token: 42}).gis}).token(true), /failed/);
    await assert.rejects(DriveApi('', {gis: fakeGis().gis}).token(true), /set up/);
});

test('it finds the vigo file and sends the token', async () => {
    const {api, seen} = await signedIn(() => json({files: [{id: 'f1', version: '4'}]}));
    assert.deepEqual(await api.find(), {id: 'f1', version: '4'});
    assert.equal(seen[0].init.headers.Authorization, 'Bearer tok');
    assert.match(decodeURIComponent(seen[0].url), /appProperties has \{ key='vigo' and value='data' \}/);
});

test('unexpected replies are refused', async () => {
    await assert.rejects((await signedIn(() => json({files: {id: 'f1'}}))).api.find(), /unexpected/);
    await assert.rejects((await signedIn(() => json({files: [{id: hostile, version: '1'}]}))).api.find(), /unexpected/);
    await assert.rejects((await signedIn(() => new Response('<html>'))).api.find(), /couldn’t read/);
});

test('file ids are escaped in URLs', async () => {
    const {api, seen} = await signedIn(() => json({id: 'f1', version: '2'}));
    await api.update('a/b?c', '{}');
    assert.match(seen[0].url, /\/files\/a%2Fb%3Fc\?/);
});

test('a missing or trashed file is gone', async () => {
    assert.equal(await (await signedIn(() => json({error: {}}, 404))).api.meta('f1'), null);
    assert.equal(await (await signedIn(() => json({id: 'f1', version: '2', trashed: true}))).api.meta('f1'), null);
});

test('a 401 drops the token, other errors say what happened', async () => {
    const {api} = await signedIn(() => json({}, 401));
    await assert.rejects(api.find(), (e) => needsSignIn(e));
    assert.equal(api.hasToken(), false);
    await assert.rejects((await signedIn(() => json({}, 503))).api.find(), /busy/);
    await assert.rejects((await signedIn(() => { throw new TypeError('offline'); })).api.find(), /Couldn’t reach Google Drive/);
});

test('create marks the file and uploads the data', async () => {
    const {api, seen} = await signedIn(() => json({id: 'f9', version: '1'}));
    assert.deepEqual(await api.create('{"format":"vigo-backup"}'), {id: 'f9', version: '1'});
    assert.equal(seen[0].init.method, 'POST');
    assert.match(String(seen[0].init.body), /"appProperties":\{"vigo":"data"\}/);
    assert.match(String(seen[0].init.body), /\{"format":"vigo-backup"\}/);
});

test('oversized downloads are refused', async () => {
    const {api} = await signedIn(() => new Response('x', {headers: {'content-length': String(300 * 1024 * 1024)}}));
    await assert.rejects(api.download('f1'), /200 MB/);
});

test('sign-out revokes the token', async () => {
    const {api, calls} = await signedIn(() => json({}));
    await api.signOut();
    assert.deepEqual(calls.revoked, ['tok']);
    assert.equal(api.hasToken(), false);
});

test('the signed-in account is read once per token, and checked', async () => {
    const {api, seen} = await signedIn(() => json({user: {permissionId: '0123456789'}}));
    assert.equal(await api.account(), '0123456789');
    assert.equal(await api.account(), '0123456789');
    assert.equal(seen.length, 1);
    await assert.rejects((await signedIn(() => json({user: {permissionId: '../x'}}))).api.account(), /unexpected account/);
});

test('after the wrong account the next sign-in offers the account chooser', async () => {
    const gis = fakeGis();
    const {api} = await signedIn(() => json({}), gis);
    api.chooseAccount();
    assert.equal(api.hasToken(), false);
    await api.token(true);
    await api.signOut();
    await api.token(true);
    assert.deepEqual(gis.calls.prompts, ['', 'select_account', '']);
});
