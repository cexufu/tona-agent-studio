const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'teamflow-lite', 'server.js'), 'utf8');
const hub = fs.readFileSync(path.join(root, 'teamflow-lite', 'public', 'hub.js'), 'utf8');
const render = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');

assert.match(server, /TONA_RESEARCH_OWNER_EMAIL/);
assert.match(server, /account\?\.email/);
assert.match(server, /researchStudio/);
assert.match(server, /enabled: false/);
assert.match(hub, /renderResearchStudio/);
assert.match(hub, /if \(!feature\?\.enabled \|\| !feature\.url\) return/);
assert.match(hub, /Research Studio/);
assert.match(hub, /research-tag/);
assert.match(hub, /grid-template-columns:repeat\(3/);
assert.match(render, /TONA_RESEARCH_OWNER_EMAIL/);
assert.match(render, /TONA_RESEARCH_STUDIO_URL/);

console.log('Research Studio Hub owner-only entry checks passed.');
