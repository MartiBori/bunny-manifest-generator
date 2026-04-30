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

const PINPOS_RETENTION_FILE =
    process.env.PINPOS_RETENTION_FILE || "pinpos-retention.json";

const PINPOS_RETENTION_AUTOMATIC_REFRESHES = Math.max(
    1,
    Number(process.env.PINPOS_RETENTION_AUTOMATIC_REFRESHES || 2)
);

const IS_AUTOMATIC_REFRESH = process.env.GITHUB_EVENT_NAME === "schedule";

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

function loadJsonFileSafe(path, fallback) {
    try {
        if (!fs.existsSync(path)) return fallback;
        const txt = fs.readFileSync(path, "utf8");
        if (!txt || !txt.trim()) return fallback;
        return JSON.parse(txt);
    } catch {
        return fallback;
    }
}

function saveJsonFilePretty(path, data) {
    fs.writeFileSync(path, JSON.stringify(data, null, 2), "utf8");
}

function normalizeRetentionStore(raw) {
    if (!raw || typeof raw !== "object") return { entries: [] };
    if (!Array.isArray(raw.entries)) return { entries: [] };
    return { entries: raw.entries };
}

function clonePinPos(pinPos) {
    if (!pinPos) return null;
    return {
        x: Number(pinPos.x || 0),
        y: Number(pinPos.y || 0),
        z: Number(pinPos.z || 0),
    };
}

function walkNodes(nodeOrTree, currentPath = "", outMap = new Map()) {
    if (!nodeOrTree) return outMap;

    const children = Array.isArray(nodeOrTree.children) ? nodeOrTree.children : [];

    for (const child of children) {
        if (!child || !child.name) continue;

        const fullPath = currentPath ? `${currentPath}/${child.name}` : child.name;

        outMap.set(fullPath, child);
        walkNodes(child, fullPath, outMap);
    }

    return outMap;
}

function buildPathNodeMap(tree) {
    return walkNodes(tree, "", new Map());
}

function ensureRetentionEntryMap(retentionStore) {
    const map = new Map();
    for (const entry of retentionStore.entries) {
        if (!entry || !entry.path) continue;
        map.set(entry.path, entry);
    }
    return map;
}

function pruneExpiredRetentionEntries(retentionStore) {
    retentionStore.entries = retentionStore.entries.filter((entry) => {
        return entry &&
            entry.path &&
            entry.pinPos &&
            Number(entry.remainingAutoRefreshes) > 0;
    });
}

function collectDeletedPinPosIntoRetention(previousTree, newTree, retentionStore) {
    const previousMap = buildPathNodeMap(previousTree);
    const newMap = buildPathNodeMap(newTree);
    const retentionMap = ensureRetentionEntryMap(retentionStore);

    const newlyAddedPaths = new Set();

    for (const [path, prevNode] of previousMap.entries()) {
        if (newMap.has(path)) continue;
        if (!prevNode || !prevNode.pinPos) continue;

        if (!retentionMap.has(path)) {
            retentionMap.set(path, {
                path,
                pinPos: clonePinPos(prevNode.pinPos),
                files: getFileSignature(prevNode),
                remainingAutoRefreshes: PINPOS_RETENTION_AUTOMATIC_REFRESHES,
            });

            newlyAddedPaths.add(path);
        }
    }

    retentionStore.entries = Array.from(retentionMap.values());
    return newlyAddedPaths;
}

function restorePinPosFromRetention(newTree, retentionStore) {
    const newMap = buildPathNodeMap(newTree);
    const keptEntries = [];

    for (const entry of retentionStore.entries) {
        if (!entry || !entry.path || !entry.pinPos) continue;

        const node = newMap.get(entry.path);
        if (node) {
            node.pinPos = clonePinPos(entry.pinPos);
            continue;
        }

        keptEntries.push(entry);
    }

    retentionStore.entries = keptEntries;
}

function decrementRetentionOnlyOnAutomaticRefresh(retentionStore, skipPaths = new Set()) {
    if (!IS_AUTOMATIC_REFRESH) return;

    for (const entry of retentionStore.entries) {
        if (!entry) continue;
        if (skipPaths.has(entry.path)) continue;

        entry.remainingAutoRefreshes = Number(entry.remainingAutoRefreshes || 0) - 1;
    }

    pruneExpiredRetentionEntries(retentionStore);
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
    const retentionStore = normalizeRetentionStore(
        loadJsonFileSafe(PINPOS_RETENTION_FILE, { entries: [] })
    );

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
    let newlyRetainedPaths = new Set();

    if (prevManifest) {
        newlyRetainedPaths = collectDeletedPinPosIntoRetention(prevManifest, tree, retentionStore);
    }

    restorePinPosFromRetention(tree, retentionStore);

    // Fallback 1: pare renombrat però fill igual
    restorePinPosFromRetentionByRenamedParent(tree, retentionStore);

    function getFileSignature(node) {
        const files = Array.isArray(node?.files) ? node.files : [];

        return files
            .map(f => String(f?.name || "").trim().toLowerCase())
            .filter(Boolean)
            .sort();
    }

    function countCommonItems(a, b) {
        const setB = new Set(b);
        let count = 0;

        for (const x of a) {
            if (setB.has(x)) count++;
        }

        return count;
    }

    function scoreRetentionCandidate(entry, candidatePath, candidateNode) {
        const oldName = getLastSegment(entry.path);
        const newName = getLastSegment(candidatePath);

        if (!oldName || !newName) return 0;
        if (isGenericNodeName(oldName)) return 0;

        let score = 0;

        // Mateix nom final
        if (oldName === newName) score += 45;

        // Mateixa profunditat
        if (getDepth(entry.path) === getDepth(candidatePath)) score += 20;

        // Mateix context superior, ignorant el pare immediat
        if (getGrandParentPrefix(entry.path) === getGrandParentPrefix(candidatePath)) score += 25;

        // Arxius semblants
        const oldFiles = Array.isArray(entry.files) ? entry.files : [];
        const newFiles = getFileSignature(candidateNode);

        if (oldFiles.length > 0 && newFiles.length > 0) {
            const common = countCommonItems(oldFiles, newFiles);
            const ratio = common / Math.max(oldFiles.length, newFiles.length);

            if (ratio >= 0.75) score += 20;
            else if (ratio >= 0.5) score += 10;
        }

        return score;
    }

    function restorePinPosFromRetentionByScore(newTree, retentionStore, minScore = 80, minGap = 20) {
        const newMap = buildPathNodeMap(newTree);
        const keptEntries = [];

        for (const entry of retentionStore.entries) {
            if (!entry || !entry.path || !entry.pinPos) continue;

            if (newMap.has(entry.path)) {
                keptEntries.push(entry);
                continue;
            }

            const candidates = [];

            for (const [candidatePath, candidateNode] of newMap.entries()) {
                if (candidatePath === entry.path) continue;
                if (getDepth(candidatePath) !== getDepth(entry.path)) continue;

                const score = scoreRetentionCandidate(entry, candidatePath, candidateNode);

                if (score > 0) {
                    candidates.push({ path: candidatePath, node: candidateNode, score });
                }
            }

            candidates.sort((a, b) => b.score - a.score);

            const best = candidates[0];
            const second = candidates[1];

            const isClear =
                best &&
                best.score >= minScore &&
                (!second || (best.score - second.score) >= minGap);

            if (isClear) {
                best.node.pinPos = clonePinPos(entry.pinPos);
                console.log(`[generator] Retenció scoring OK: '${entry.path}' -> '${best.path}' score=${best.score}`);
                continue;
            }

            keptEntries.push(entry);
        }

        retentionStore.entries = keptEntries;
    }
    // Fallback 2: scoring conservador
    restorePinPosFromRetentionByScore(tree, retentionStore, 80, 20);

    // 1f) Només els refresh automàtics consumeixen intents
    decrementRetentionOnlyOnAutomaticRefresh(retentionStore, newlyRetainedPaths);

    // 1g) Guardem l'estat de retenció a disc
    saveJsonFilePretty(path.join(process.cwd(), PINPOS_RETENTION_FILE), retentionStore);

    const retentionJson = JSON.stringify(retentionStore, null, 2);
    const retentionRemotePath = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(ROOT_PREFIX)}/${PINPOS_RETENTION_FILE}`;

    await axios.put(retentionRemotePath, retentionJson, {
        headers: { AccessKey: API_KEY, "Content-Type": "application/json" },
        maxContentLength: Infinity,
        maxBodyLength: Infinity
    });

    console.log(`[generator] Pujat a Storage -> /${ROOT_PREFIX}/${PINPOS_RETENTION_FILE}`);

    console.log(
        `[generator] Retenció pinPos -> entries=${retentionStore.entries.length} automatic=${IS_AUTOMATIC_REFRESH}`
    );

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
    function getPathParts(pathStr) {
        return String(pathStr || "")
            .split("/")
            .map(s => s.trim())
            .filter(Boolean);
    }

    function getLastSegment(pathStr) {
        const parts = getPathParts(pathStr);
        return parts.length ? parts[parts.length - 1] : "";
    }

    function getGrandParentPrefix(pathStr) {
        const parts = getPathParts(pathStr);
        if (parts.length <= 2) return "";
        return parts.slice(0, parts.length - 2).join("/");
    }

    function getParentPath(pathStr) {
        const parts = getPathParts(pathStr);
        if (parts.length <= 1) return "";
        return parts.slice(0, parts.length - 1).join("/");
    }

    function getDepth(pathStr) {
        return getPathParts(pathStr).length;
    }

    function isGenericNodeName(name) {
        const n = String(name || "").trim().toLowerCase();

        const genericNames = new Set([
            "salida",
            "llegada",
            "llegamos",
            "hoteles",
            "zz_hoteles",
            "zz_restaurantes",
            "aviosalida",
            "aviollegada",
            "trensalida",
            "trenllegada",
            "cochesalida",
            "cochellegada"
        ]);

        return genericNames.has(n);
    }

    function findSingleEquivalentPathByRenamedParent(oldPath, newTree) {
        const oldName = getLastSegment(oldPath);
        if (!oldName) return null;

        // Per evitar restauracions errònies amb noms massa genèrics
        if (isGenericNodeName(oldName)) return null;

        const oldDepth = getDepth(oldPath);
        const oldGrandParentPrefix = getGrandParentPrefix(oldPath);

        const newMap = buildPathNodeMap(newTree);
        const candidates = [];

        for (const [candidatePath] of newMap.entries()) {
            if (candidatePath === oldPath) continue;
            if (getDepth(candidatePath) !== oldDepth) continue;
            if (getLastSegment(candidatePath) !== oldName) continue;
            if (getGrandParentPrefix(candidatePath) !== oldGrandParentPrefix) continue;

            candidates.push(candidatePath);
        }

        return candidates.length === 1 ? candidates[0] : null;
    }
    function restorePinPosFromRetentionByRenamedParent(newTree, retentionStore) {
        const newMap = buildPathNodeMap(newTree);
        const keptEntries = [];

        for (const entry of retentionStore.entries) {
            if (!entry || !entry.path || !entry.pinPos) {
                continue;
            }

            // Si ja existeix exactament, aquesta entrada la gestiona
            // restorePinPosFromRetention(...) i aquí no cal tocar-la.
            if (newMap.has(entry.path)) {
                keptEntries.push(entry);
                continue;
            }

            const candidatePath = findSingleEquivalentPathByRenamedParent(entry.path, newTree);

            if (candidatePath) {
                const node = newMap.get(candidatePath);
                if (node) {
                    node.pinPos = clonePinPos(entry.pinPos);
                    continue; // consumim la retenció
                }
            }

            keptEntries.push(entry);
        }

        retentionStore.entries = keptEntries;
    }
}

run().catch(err => {
    console.error("[generator] ERROR:", err?.response?.data || err.message || err);
    process.exit(1);
});
