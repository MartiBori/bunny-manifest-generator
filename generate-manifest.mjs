// generate-manifest.mjs
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import crypto from "crypto";
import "dotenv/config";

/**
 * Manifest generat:
 * {
 *   "children":[
 *     { "name":"Carpeta",
 *       "children":[ ... ],
 *       "files":[ { "name":"a.png", "url":"https://.../a.png" }, ... ]
 *     }
 *   ],
 *   "files":[ { "name":"arrel.png", "url":"https://.../arrel.png" } ]
 * }
 */

const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;          // p.ex. foto360
const API_KEY = process.env.BUNNY_STORAGE_API_KEY;       // Storage API (RW)
const CDN_BASE = process.env.BUNNY_CDN_BASE || "";        // p.ex. https://foto360.b-cdn.net
const ROOT_PREFIX = process.env.ROOT_PREFIX;                 // p.ex. Vila_Viatges (sense / inicial)
const ACCOUNT_KEY = process.env.BUNNY_ACCOUNT_API_KEY || ""; // opcional (purge)

if (!STORAGE_ZONE || !API_KEY || !ROOT_PREFIX) {
    console.error("[generator] Falten BUNNY_STORAGE_ZONE / BUNNY_STORAGE_API_KEY / ROOT_PREFIX");
    process.exit(1);
}

const STORAGE_API = "https://storage.bunnycdn.com";
const isDir = (it) => it?.IsDirectory === true || it?.isDirectory === true || it?.Type === "Directory";
const oName = (it) => it?.ObjectName || it?.Name || it?.name || "";
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

let folderCount = 0;
let fileCount = 0;

async function listFolder(prefix) {
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const url = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(normalized)}`;
    const res = await axios.get(url, {
        headers: { AccessKey: API_KEY, Accept: "application/json" },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: (s) => s === 200 || s === 404
    });
    if (res.status === 404) return [];
    const items = Array.isArray(res.data) ? res.data : (res.data.Items || []);
    return items;
}

/** Construeix node recursiu {name, children[], files:[{name,url}]} */
async function buildNode(prefix, nodeName) {
    const items = await listFolder(prefix);
    const node = { name: nodeName, children: [], files: [] };

    // Carpeta primer, després fitxers (ordre alfabètic)
    items.sort((a, b) => {
        const da = isDir(a), db = isDir(b);
        if (da !== db) return da ? -1 : 1;
        return oName(a).localeCompare(oName(b), "ca", { sensitivity: "base" });
    });

    for (const it of items) {
        const name = oName(it);
        if (!name) continue;

        if (isDir(it)) {
            folderCount++;
            const childPrefix = prefix.endsWith("/") ? `${prefix}${name}` : `${prefix}/${name}`;
            const child = await buildNode(childPrefix, name);
            node.children.push(child);
        } else {
            fileCount++;
            const relPath = prefix.endsWith("/") ? `${prefix}${name}` : `${prefix}/${name}`;
            const url = CDN_BASE ? `${CDN_BASE.replace(/\/$/, "")}/${encodeURI(relPath)}` : null;
            node.files.push({ name, url });
        }
    }
    return node;
}

// Canonicalització per comparar contingut (ordena claus)
const stableStringify = (value) => {
    const normalize = (v) => {
        if (Array.isArray(v)) return v.map(normalize);
        if (v && typeof v === "object") {
            return Object.keys(v).sort().reduce((o, k) => {
                o[k] = normalize(v[k]);
                return o;
            }, {});
        }
        return v;
    };
    return JSON.stringify(normalize(value));
};

// Fusiona els pinPos d'un manifest existent (oldNode) cap al nou arbre (newNode)
// només copia la propietat opcional 'pinPos' basant-se en el nom dels nodes.
const mergePinPos = (oldNode, newNode) => {
    if (!oldNode || !newNode) return;

    // Si el node antic tenia pinPos, el copiem tal qual al node nou
    if (oldNode.pinPos && typeof oldNode.pinPos === "object") {
        newNode.pinPos = {
            x: oldNode.pinPos.x ?? 0,
            y: oldNode.pinPos.y ?? 0,
            z: oldNode.pinPos.z ?? 0,
        };
    }

    const oldChildren = Array.isArray(oldNode.children) ? oldNode.children : [];
    const newChildren = Array.isArray(newNode.children) ? newNode.children : [];

    for (const childNew of newChildren) {
        if (!childNew || !childNew.name) continue;
        const childOld = oldChildren.find(c => c && c.name === childNew.name);
        if (childOld) {
            mergePinPos(childOld, childNew);
        }
    }
};

async function run() {
    console.log(
        `[generator] Inici -> Zona='${STORAGE_ZONE}'  Prefix='/${ROOT_PREFIX}'  CDN='${CDN_BASE}'`
    );

    // 0) Intenta carregar el manifest existent (per conservar pinPos)
    let prevManifest = null;
    try {
        const existingPath = path.join(process.cwd(), "manifest.json");
        if (fs.existsSync(existingPath)) {
            const txt = fs.readFileSync(existingPath, "utf8");
            const parsed = JSON.parse(txt);
            if (parsed && typeof parsed === "object") {
                if (!parsed.children) parsed.children = [];
                if (!parsed.files) parsed.files = [];
                prevManifest = parsed;
                console.log("[generator] Manifest existent trobat: s'utilitzarà per fusionar pinPos");
            }
        } else {
            console.log("[generator] Cap manifest existent local (no hi ha pinPos previs a fusionar)");
        }
    } catch (e) {
        console.warn("[generator] Error llegint manifest existent (s'ignora):", e.message);
    }

    // 1) Construeix l'arbre a partir de ROOT_PREFIX (Bunny)
    const tree = { children: [], files: [] };
    const rootItems = await listFolder(ROOT_PREFIX);

    rootItems.sort((a, b) => {
        const da = isDir(a), db = isDir(b);
        if (da !== db) return da ? -1 : 1;
        return oName(a).localeCompare(oName(b), "ca", { sensitivity: "base" });
    });

    for (const it of rootItems) {
        const name = oName(it);
        if (!name) continue;

        if (isDir(it)) {
            folderCount++;
            const prefix = `${ROOT_PREFIX}/${name}`;
            const child = await buildNode(prefix, name);
            tree.children.push(child);
        } else {
            fileCount++;
            const relPath = `${ROOT_PREFIX}/${name}`;
            const url = CDN_BASE ? `${CDN_BASE.replace(/\/$/, "")}/${encodeURI(relPath)}` : null;
            tree.files.push({ name, url });
        }
    }

    // 1b) Fusiona pinPos des del manifest anterior, si existeix
    if (prevManifest) {
        console.log("[generator] Fusionant pinPos des del manifest existent...");
        mergePinPos(prevManifest, tree);
    }
    // 1c) Copia també la versió, si existeix al manifest anterior
    if (prevManifest && typeof prevManifest.version === "number") {
        tree.version = prevManifest.version;
        console.log(`[generator] Versió de manifest preservada -> ${tree.version}`);
    } else if (typeof tree.version !== "number") {
        // Per si de cas, assegurem que sempre hi ha algun valor
        tree.version = 0;
        console.log("[generator] Manifest sense versió prèvia, establint version=0");
    }

    // 2) Escriu local i stats
    const json = JSON.stringify(tree, null, 2);
    const outLocal = path.join(process.cwd(), "manifest.json");
    fs.writeFileSync(outLocal, json);
    console.log(`[generator] Manifest local -> ${outLocal}`);
    console.log(`[generator] Comptatge -> carpetes=${folderCount}  fitxers=${fileCount}`);

    // 3) PUT a Storage (sempre)
    const remotePath = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(ROOT_PREFIX)}/manifest.json`;
    await axios.put(remotePath, json, {
        headers: { AccessKey: API_KEY, "Content-Type": "application/json" },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });
    console.log(`[generator] Pujat a Storage -> /${ROOT_PREFIX}/manifest.json`);

    // 4) Verificació pel CONTINGUT (claus ordenades)
    const verifyRes = await axios.get(remotePath, {
        headers: { AccessKey: API_KEY, Accept: "application/json" }
    });
    const localObj = JSON.parse(json);
    const remoteObj = (typeof verifyRes.data === "string")
        ? JSON.parse(verifyRes.data)
        : verifyRes.data;

    const localHash = sha1(stableStringify(localObj));
    const remoteHash = sha1(stableStringify(remoteObj));

    if (localHash === remoteHash) {
        console.log("[generator] Verificació OK (hash estable coincideix)");
    } else {
        console.warn("[generator] ATENCIÓ: el manifest a Storage és diferent (hash estable NO coincideix)");
        console.warn("  localHash =", localHash);
        console.warn("  remoteHash =", remoteHash);
    }

    // 5) Purge CDN (opcional)
    if (ACCOUNT_KEY && CDN_BASE) {
        const purgeUrl = `${CDN_BASE.replace(/\/$/, "")}/${ROOT_PREFIX}/manifest.json`;
        try {
            await axios.post(
                "https://api.bunny.net/purge",
                { Urls: [purgeUrl] },
                {
                    headers: {
                        AccessKey: ACCOUNT_KEY,
                        "Content-Type": "application/json",
                    },
                }
            );
            console.log(`[generator] Purge CDN -> ${purgeUrl}`);
        } catch (e) {
            console.warn("[generator] Purge CDN ERROR:", e?.response?.data || e.message);
        }
    } else {
        console.log("[generator] Purge CDN omès (sense BUNNY_ACCOUNT_API_KEY o sense BUNNY_CDN_BASE)");
    }
}

run().catch(err => {
    console.error("[generator] ERROR:", err?.response?.data || err.message || err);
    process.exit(1);
});
