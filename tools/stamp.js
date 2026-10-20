//
// Writes the deploy's src/version.json and src/config.json, Vercel's build command
//
//   VERCEL_GIT_COMMIT_SHA   the commit shown in the header
//   GOOGLE_CLIENT_ID        the OAuth client id for Drive sync, empty leaves it off
//
// The client id is public (Google shows it to anyone who signs in), it is not a secret. An id that doesn't
// look like one fails the deploy rather than shipping a broken Drive card.
//

import { writeFileSync } from 'node:fs';

const sha = process.env.VERCEL_GIT_COMMIT_SHA || '';
const clientId = (process.env.GOOGLE_CLIENT_ID ?? '').trim();

if(clientId && !/^[\w-]{1,200}\.apps\.googleusercontent\.com$/.test(clientId)) {
    console.error('stamp: GOOGLE_CLIENT_ID is not an OAuth client id (…apps.googleusercontent.com)');
    process.exit(1);
}

const src = new URL('../src/', import.meta.url);
writeFileSync(new URL('version.json', src), JSON.stringify({commit: /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : 'dev'}) + '\n');
writeFileSync(new URL('config.json', src), JSON.stringify({googleClientId: clientId}) + '\n');
console.log(`stamp: commit ${sha.slice(0, 7) || 'dev'}, Drive sync ${clientId ? 'on' : 'off'}`);
