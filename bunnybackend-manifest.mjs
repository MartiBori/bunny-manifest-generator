// bunnybackend-manifest.mjs
// Backend molt simple per rebre posicions de pins des de Unity
// i escriure-les al manifest.json del repo de GitHub.

import http from 'http';
import axios from 'axios';

// ---- Config via variables d'entorn (Render) ----
const OWNER = process.env.GITHUB_OWNER;   // ex: "MartiBori"
const REPO = process.env.GITHUB_REPO;    // ex: "bunny-manifest-generator"
const PATH = process.env.MANIFEST_PATH;  // ex: "manifest.json"
const TOKEN = process.env.GITHUB_TOKEN;   // personal access token
const PORT = process.env.PORT || 10000;

if (!OWNER || !REPO || !PATH || !TOKEN) {
    console.error('[BunnyBackend] Falten variables d\'entorn GITHUB_OWNER/REPO/PATH/TOKEN');
    process.exit(1);
}

const GH_BASE = 'https://api.github.com';

// --- helpers GitHub ---

async function loadManifest() {
    const url = `${GH_BASE}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(PATH)}`;
    const res = await axios.get(url, {
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'bunny-pin-backend'
        }
    });

    const { content, sha } = res.data; // content en base64
    const jsonText = Buffer.from(content, 'base64').toString('utf8');
    const manifest = JSON.parse(jsonText || '{"children":[],"files":[]}');

    // Assegurem estructura mínima
    if (!manifest.children) manifest.children = [];
    if (!manifest.files) manifest.files = [];

    return { manifest, sha };
}

async function saveManifest(manifest, sha) {
    const url = `${GH_BASE}/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(PATH)}`;
    const newText = JSON.stringify(manifest, null, 2);
    const newContent = Buffer.from(newText, 'utf8').toString('base64');

    await axios.put(url, {
        message: 'Update pinPos from Unity',
        content: newContent,
        sha
    }, {
        headers: {
            'Authorization': `Bearer ${TOKEN}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'bunny-pin-backend'
        }
    });
}

// Troba (o crea) un node dins l'arbre seguint un path "A/B/C"
function ensureNodeForPath(root, pathStr) {
    const parts = pathStr.split('/').filter(p => p && p !== '.');
    let node = root;

    for (const part of parts) {
        if (!node.children) node.children = [];
        let child = node.children.find(c => c && c.name === part);
        if (!child) {
            child = { name: part, children: [], files: [] };
            node.children.push(child);
        }
        node = child;
    }
    return node;
}

// --- HTTP server ---

function sendJson(res, status, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
}

const server = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        return res.end();
    }

    if (req.method === 'POST' && req.url.startsWith('/syncPins')) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const data = JSON.parse(body || '{}');
                const pins = Array.isArray(data.pins) ? data.pins : [];

                console.log(`[BunnyBackend] Rebut syncPins amb ${pins.length} pins`);

                if (pins.length === 0) {
                    return sendJson(res, 400, { ok: false, error: 'No pins' });
                }

                const { manifest, sha } = await loadManifest();

                // Apliquem posicions
                let updated = 0;
                for (const p of pins) {
                    if (!p || !p.path) continue;
                    const node = ensureNodeForPath(manifest, p.path);
                    node.pinPos = { x: p.x || 0, y: p.y || 0, z: p.z || 0 };
                    updated++;
                }

                await saveManifest(manifest, sha);

                console.log(`[BunnyBackend] Guardat manifest amb ${updated} pins actualitzats`);
                return sendJson(res, 200, { ok: true, updated });
            } catch (err) {
                console.error('[BunnyBackend] Error a /syncPins:', err.message);
                return sendJson(res, 500, { ok: false, error: err.message });
            }
        });
    } else {
        sendJson(res, 404, { ok: false, error: 'Not found' });
    }
});

server.listen(PORT, () => {
    console.log(`[BunnyBackend] Escoltant al port ${PORT}`);
});
