import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

/**
 * Recorre TOTES les carpetes i fitxers a partir de ROOT_PREFIX
 * i genera un JSON en format:
 * { children: [ { name, children: [...], files: [...] } ], files: [...] }
 */

const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;   // ex: foto360
const API_KEY = process.env.BUNNY_STORAGE_API_KEY; // Storage API (write)
const CDN_BASE = process.env.BUNNY_CDN_BASE;        // ex: https://foto360.b-cdn.net
const ROOT_PREFIX = process.env.ROOT_PREFIX;           // ex: Vila_Viatges

if (!STORAGE_ZONE || !API_KEY || !CDN_BASE || !ROOT_PREFIX) {
    console.error("Falten secrets: BUNNY_STORAGE_ZONE / BUNNY_STORAGE_API_KEY / BUNNY_CDN_BASE / ROOT_PREFIX");
    process.exit(1);
}

const STORAGE_API = "https://storage.bunnycdn.com";

// util robust per camps
const isDir = (it) => it?.IsDirectory === true || it?.isDirectory === true || it?.Type === "Directory";
const objName = (it) => it?.ObjectName || it?.Name || it?.name || "";

/** Llista una carpeta de Storage (retorna array d'items) */
async function listFolder(prefix) {
    // IMPORTANT: encodeURI (no encodeURIComponent) per conservar les barres
    const url = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(prefix)}`;
    const res = await axios.get(url, { headers: { AccessKey: API_KEY } });
    // segons versió d'API pot venir com a array o com { Items: [...] }
    const items = Array.isArray(res.data) ? res.data : (res.data.Items || []);
    return items;
}

/** Construeix node recursiu {name, children[], files[]} per a un prefix */
async function buildNode(prefix, nodeName) {
    const items = await listFolder(prefix);
    const node = { name: nodeName, children: [], files: [] };

    // Ordena: carpetes primer, després fitxers, alfabètic
    items.sort((a, b) => {
        const da = isDir(a), db = isDir(b);
        if (da !== db) return da ? -1 : 1;
        return objName(a).localeCompare(objName(b), "ca", { sensitivity: "base" });
    });

    for (const it of items) {
        const name = objName(it);
        if (!name) continue;

        if (isDir(it)) {
            const childPrefix = prefix.endsWith("/") ? `${prefix}${name}` : `${prefix}/${name}`;
            const child = await buildNode(childPrefix, name);
            node.children.push(child);
        } else {
            node.files.push(name); // Nom de fitxer (si vols URL absoluta, aquí pots construir-la)
            // Ex d'URL absoluta:
            // const url = `${CDN_BASE.replace(/\/$/, "")}/${encodeURI(prefix)}/${encodeURIComponent(name)}`;
            // node.files.push(url);
        }
    }
    return node;
}

async function run() {
    console.log(`[generator] Inici -> /${ROOT_PREFIX}`);

    // Llista l'arrel del projecte (Vila_Viatges) i construeix RBTree
    const rootItems = await listFolder(ROOT_PREFIX);
    const tree = { children: [], files: [] };

    // Ordena items de l'arrel (carpetes primer)
    rootItems.sort((a, b) => {
        const da = isDir(a), db = isDir(b);
        if (da !== db) return da ? -1 : 1;
        return objName(a).localeCompare(objName(b), "ca", { sensitivity: "base" });
    });

    for (const it of rootItems) {
        const name = objName(it);
        if (!name) continue;

        if (isDir(it)) {
            const prefix = `${ROOT_PREFIX}/${name}`;
            const node = await buildNode(prefix, name);
            tree.children.push(node);
        } else {
            tree.files.push(name);
        }
    }

    // Escriu localment i puja a Bunny
    const json = JSON.stringify(tree, null, 2);
    const outLocal = path.join(process.cwd(), "manifest.json");
    fs.writeFileSync(outLocal, json);
    console.log(`[generator] Manifest local -> ${outLocal}`);

    const remotePath = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(ROOT_PREFIX)}/manifest.json`;
    await axios.put(remotePath, json, {
        headers: {
            AccessKey: API_KEY,
            "Content-Type": "application/json"
        }
    });

    const cdnUrl = `${CDN_BASE.replace(/\/$/, "")}/${ROOT_PREFIX}/manifest.json`;
    console.log(`[generator] Pujat a Storage -> /${ROOT_PREFIX}/manifest.json`);
    console.log(`[generator] URL CDN -> ${cdnUrl}`);
}

run().catch(err => {
    console.error("[generator] ERROR:", err?.response?.data || err.message || err);
    process.exit(1);
});
