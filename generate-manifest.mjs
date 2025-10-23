// generate-manifest.mjs
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import crypto from "crypto";
import "dotenv/config";

/**
 * Manifest generat:
 * {
 *   "children":[ { "name":"Carpeta", "children":[...], "files":[ "a.png", "b.mp3" ] } ],
 *   "files":[ ... ]
 * }
 *
 * - Recorre totes les carpetes i fitxers sota ROOT_PREFIX (? nivells).
 * - PUT sempre a /<ZONE>/<ROOT_PREFIX>/manifest.json.
 * - Verifica pel CONTINGUT (claus ordenades) per evitar falsos negatius.
 * - Purge del CDN opcional (BUNNY_ACCOUNT_API_KEY).
 */

const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;        // p.ex. foto360
const API_KEY = process.env.BUNNY_STORAGE_API_KEY;     // Storage API (RW)
const CDN_BASE = process.env.BUNNY_CDN_BASE || "";      // p.ex. https://foto360.b-cdn.net
const ROOT_PREFIX = process.env.ROOT_PREFIX;               // p.ex. Vila_Viatges (sense / inicial)
const ACCOUNT_KEY = process.env.BUNNY_ACCOUNT_API_KEY || "";// opcional (purge)

if (!STORAGE_ZONE || !API_KEY || !ROOT_PREFIX) {
    console.error("[generator] Falten BUNNY_STORAGE_ZONE / BUNNY_STORAGE_API_KEY / ROOT_PREFIX");
    process.exit(1);
}

const STORAGE_API = "https://storage.bunnycdn.com";

// Helpers lectura Storage
const isDir = (it) => it?.IsDirectory === true || it?.isDirectory === true || it?.Type === "Directory";
const oName = (it) => it?.ObjectName || it?.Name || it?.name || "";

// Hash
const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

// Stats
let folderCount = 0;
let fileCount = 0;

/** Llista una carpeta de Storage */
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

/** Construeix node recursiu {name, children[], files[]} */
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
            node.files.push(name);
            // Si vols URL completa en lloc de nom:
            // const url = `${CDN_BASE.replace(/\/$/, "")}/${encodeURI(prefix)}/${encodeURIComponent(name)}`;
            // node.files.push(url);
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

async function run() {
    console.log(
        `[generator] Inici -> Zona='${STORAGE_ZONE}'  Prefix='/${ROOT_PREFIX}'  CDN='${CDN_BASE}'`
    );

    // 1) Construeix l'arbre a partir de ROOT_PREFIX
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
            tree.files.push(name);
        }
    }

    // 2) Escriu localment
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

    // 4) Verificació per CONTINGUT (claus ordenades)
    const verifyRes = await axios.get(remotePath, {
        headers: { AccessKey: API_KEY, Accept: "application/json" }
    });

    const localObj = JSON.parse(json);
    const remoteObj = (typeof verifyRes.data === "string")
        ? JSON.parse(verifyRes.data)
        : verifyRes.data;

    const localHash = sha1(stableStringify(localObj));
    const remoteHash = sha1(stableStringify(remoteObj));

    console.log(`[generator] Verify Storage -> local sha1=${localHash}  remote sha1=${remoteHash}`);
    if (localHash !== remoteHash) {
        throw new Error("Storage content does not match the uploaded manifest (revisa Zona/Prefix/API key).");
    }

    // 5) Purge CDN (opcional)
    if (ACCOUNT_KEY && CDN_BASE) {
        const purgeUrl = `${CDN_BASE.replace(/\/$/, "")}/${ROOT_PREFIX}/manifest.json`;
        try {
            await axios.post("https://api.bunny.net/purge", { url: purgeUrl }, {
                headers: { AccessKey: ACCOUNT_KEY }
            });
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
