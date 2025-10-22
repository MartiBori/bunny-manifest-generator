// generate-manifest.mjs
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

/**
 * Genera manifest.json en format:
 * {
 *   "children":[ { "name":"Carpeta", "children":[...], "files":[ "a.png", "b.mp3" ] } ],
 *   "files":[ ... ]
 * }
 *
 * - Recorre TOTES les carpetes i fitxers sota ROOT_PREFIX (? nivells).
 * - Usa la Storage API de Bunny amb AccessKey (read/write).
 */

const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;       // p.ex. foto360
const API_KEY = process.env.BUNNY_STORAGE_API_KEY;    // Storage API key (write)
const CDN_BASE = process.env.BUNNY_CDN_BASE || "";     // p.ex. https://foto360.b-cdn.net (informatiu)
const ROOT_PREFIX = process.env.ROOT_PREFIX;              // p.ex. Vila_Viatges (sense '/' inicial)

if (!STORAGE_ZONE || !API_KEY || !ROOT_PREFIX) {
    console.error("[generator] Falten secrets: BUNNY_STORAGE_ZONE / BUNNY_STORAGE_API_KEY / ROOT_PREFIX");
    process.exit(1);
}

const STORAGE_API = "https://storage.bunnycdn.com";

// Helpers robustos segons variants de resposta
const isDir = (it) => it?.IsDirectory === true || it?.isDirectory === true || it?.Type === "Directory";
const oName = (it) => it?.ObjectName || it?.Name || it?.name || "";

/** Llista una carpeta de Storage (retorna array d'items) */
async function listFolder(prefix) {
    // Normalitza: assegura barra final (Bunny 404 si no n'hi ha en alguns casos)
    const normalized = prefix.endsWith("/") ? prefix : `${prefix}/`;
    // IMPORTANT: encodeURI (no encodeURIComponent) per conservar les barres dins el path
    const url = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(normalized)}`;

    const res = await axios.get(url, {
        headers: {
            AccessKey: API_KEY,
            Accept: "application/json",
        },
        // evita problemes amb grans directoris
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    // La Storage API pot tornar array directe o { Items: [...] }
    const items = Array.isArray(res.data) ? res.data : (res.data.Items || []);
    return items;
}

/** Construeix node recursiu {name, children[], files[]} per a un prefix */
async function buildNode(prefix, nodeName) {
    const items = await listFolder(prefix);
    const node = { name: nodeName, children: [], files: [] };

    // Ordenació: carpetes primer, després fitxers, alfabètic
    items.sort((a, b) => {
        const da = isDir(a), db = isDir(b);
        if (da !== db) return da ? -1 : 1;
        return oName(a).localeCompare(oName(b), "ca", { sensitivity: "base" });
    });

    for (const it of items) {
        const name = oName(it);
        if (!name) continue;

        if (isDir(it)) {
            const childPrefix = prefix.endsWith("/") ? `${prefix}${name}` : `${prefix}/${name}`;
            const child = await buildNode(childPrefix, name);
            node.children.push(child);
        } else {
            // Guarda NOM de fitxer (si vols URL absoluta, construeix-la aquí)
            node.files.push(name);

            // Ex. per URL absoluta:
            // const url = `${CDN_BASE.replace(/\/$/, "")}/${encodeURI(prefix)}/${encodeURIComponent(name)}`;
            // node.files.push(url);
        }
    }

    return node;
}

async function run() {
    console.log(`[generator] Inici -> Zona='${STORAGE_ZONE}'  Prefix='/${ROOT_PREFIX}'`);

    // Arrel del RBTree
    const tree = { children: [], files: [] };

    // Llista l'arrel i recorre cada entrada
    const rootItems = await listFolder(ROOT_PREFIX);

    // Ordenació d'arrel coherent
    rootItems.sort((a, b) => {
        const da = isDir(a), db = isDir(b);
        if (da !== db) return da ? -1 : 1;
        return oName(a).localeCompare(oName(b), "ca", { sensitivity: "base" });
    });

    for (const it of rootItems) {
        const name = oName(it);
        if (!name) continue;

        if (isDir(it)) {
            const prefix = `${ROOT_PREFIX}/${name}`;
            const child = await buildNode(prefix, name);
            tree.children.push(child);
        } else {
            tree.files.push(name);
        }
    }

    // Escriu localment
    const json = JSON.stringify(tree, null, 2);
    const outLocal = path.join(process.cwd(), "manifest.json");
    fs.writeFileSync(outLocal, json);
    console.log(`[generator] Manifest local -> ${outLocal}`);

    // Pujar a Storage: /<ZONE>/<ROOT_PREFIX>/manifest.json
    const remotePath = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(ROOT_PREFIX)}/manifest.json`;
    await axios.put(remotePath, json, {
        headers: {
            AccessKey: API_KEY,
            "Content-Type": "application/json",
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
    });

    const cdnUrl = `${(CDN_BASE || "").replace(/\/$/, "")}/${ROOT_PREFIX}/manifest.json`;
    console.log(`[generator] Pujat a Storage -> /${ROOT_PREFIX}/manifest.json`);
    if (CDN_BASE) console.log(`[generator] URL CDN -> ${cdnUrl}`);
}

run().catch(err => {
    console.error("[generator] ERROR:", err?.response?.data || err.message || err);
    process.exit(1);
});
