import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { viewFor, views } from '../src/ui/router.js';

test('hash to view', () => {
    for(const hash of ['', '#', '#/', undefined, null]) assert.equal(viewFor(hash), 'ride');
    assert.equal(viewFor('#/workouts'), 'workouts');
    assert.equal(viewFor('#/history'), 'history');
    assert.equal(viewFor('#/settings'), 'settings');
    for(const name of Object.keys(views)) assert.equal(viewFor(views[name].hash), name);
});

test('unknown and hostile hashes fall back to the ride view', () => {
    for(const hash of ['#/__proto__', '#/constructor', '#/toString', '#/hasOwnProperty', '#/../x', '#/x',
                       '#/workouts/1', '#/WORKOUTS', `#/${'a'.repeat(1000)}`, '#/<img src=x onerror=alert(1)>']) {
        assert.equal(viewFor(hash), 'ride', hash);
    }
});

// GitHub Pages serves the app under /vigo/, a root absolute URL would point outside it
const src = new URL('../src/', import.meta.url).pathname;

function files(dir) {
    return readdirSync(dir, {withFileTypes: true}).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]);
}

test('no root absolute URLs, so the app works under a subpath', () => {
    const problems = [];
    const html = readFileSync(join(src, 'index.html'), 'utf8');
    for(const m of html.matchAll(/\b(?:src|href)="([^"]*)"/g)) {
        if(m[1].startsWith('/')) problems.push(`index.html: ${m[1]}`);
    }

    const manifest = JSON.parse(readFileSync(join(src, 'manifest.webmanifest'), 'utf8'));
    for(const url of [manifest.start_url, manifest.scope, ...manifest.icons.map((i) => i.src)]) {
        if(url.startsWith('/')) problems.push(`manifest: ${url}`);
    }

    for(const file of files(src).filter((f) => f.endsWith('.js'))) {
        const code = readFileSync(file, 'utf8');
        for(const m of code.matchAll(/\b(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)) {
            if(!m[1].startsWith('./') && !m[1].startsWith('../')) problems.push(`${file}: import ${m[1]}`);
        }
        for(const m of code.matchAll(/register\(\s*['"]([^'"]+)['"]/g)) {
            if(m[1].startsWith('/')) problems.push(`${file}: register ${m[1]}`);
        }
    }

    const sw = readFileSync(join(src, 'sw.js'), 'utf8');
    const shell = [...sw.slice(sw.indexOf('const shell'), sw.indexOf('];')).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    for(const entry of shell) {
        if(entry.startsWith('/')) problems.push(`sw.js shell: ${entry}`);
    }

    assert.deepEqual(problems, []);
});

test('the service worker caches every app file', () => {
    const sw = readFileSync(join(src, 'sw.js'), 'utf8');
    const shell = new Set([...sw.slice(sw.indexOf('const shell'), sw.indexOf('];')).matchAll(/'([^']+)'/g)].map((m) => m[1]));
    const appFiles = files(src).map((f) => f.slice(src.length)).filter((f) => f !== 'sw.js');
    assert.deepEqual(appFiles.filter((f) => !shell.has(f)), []);
});
