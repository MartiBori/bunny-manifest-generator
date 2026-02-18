// generate-stream-manifest.mjs
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import "dotenv/config";

const STORAGE_API = "https://storage.bunnycdn.com";
const STREAM_API = "https://video.bunnycdn.com";

// --- ENV STORAGE (per pujar el manifest al mateix lloc que l'altre) ---
const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
const ROOT_PREFIX_RAW = process.env.ROOT_PREFIX || "";
const STORAGE_API_KEY = process.env.BUNNY_STORAGE_API_KEY;

// --- ENV STREAM (per llegir vídeos de Bunny Stream) ---
const STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const STREAM_API_KEY = process.env.BUNNY_STREAM_API_KEY;

// Base per DIRECT (iframe.mediadelivery.net/play o video.bunnycdn.com/play)
const STREAM_PLAY_BASE = (process.env.BUNNY_STREAM_PLAY_BASE || "https://video.bunnycdn.com/play")
    .replace(/\r?\n/g, "")
    .trim()
    .replace(/\/$/, "");

// Base per HLS (vz-xxxx.b-cdn.net)
const STREAM_HLS_BASE = (process.env.BUNNY_STREAM_HLS_BASE || "")
    .replace(/\r?\n/g, "")
    .trim()
    .replace(/\/$/, "");

// Opcional: limitar a un “prefix/carpeta” dins el title (ex: 'VillaViatgesStream/')
const STREAM_TITLE_PREFIX_FILTER = (process.env.BUNNY_STREAM_TITLE_PREFIX_FILTER || "")
    .replace(/\r?\n/g, "")
    .trim()
    .replace(/\\/g, "/");

// Validacions mínimes
if (!STORAGE_ZONE) throw new Error("Falta BUNNY_STORAGE_ZONE");
if (typeof STORAGE_API_KEY !== "string" || !STORAGE_API_KEY.length) throw new Error("Falta BUNNY_STORAGE_API_KEY");
if (!STREAM_LIBRARY_ID) throw new Error("Falta BUNNY_STREAM_LIBRARY_ID");
if (!STREAM_API_KEY) throw new Error("Falta BUNNY_STREAM_API_KEY");

// Normalitza ROOT_PREFIX (sense / inicial ni final)
const ROOT_PREFIX = ROOT_PREFIX_RAW.replace(/^\/+|\/+$/g, "");

// --- Helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listAllStreamVideos() {
    const all = [];
    let page = 1;
    const itemsPerPage = 100;

    for (let i = 0; i < 100; i++) {
        const url = `${STREAM_API}/library/${STREAM_LIBRARY_ID}/videos?page=${page}&itemsPerPage=${itemsPerPage}`;
        console.log(`[stream] GET ${url}`);
        const res = await axios.get(url, {
            headers: { AccessKey: STREAM_API_KEY, Accept: "application/json" },
        });

        const data = res.data || {};
        const items = Array.isArray(data.items) ? data.items : Array.isArray(data.videos) ? data.videos : [];
        if (!items.length) break;

        all.push(...items);

        const currentPage = data.currentPage || page;
        const totalPages = data.totalPages || currentPage;
        if (currentPage >= totalPages) break;

        page++;
        await sleep(200);
    }

    console.log(`[stream] Total vídeos trobats: ${all.length}`);
    return all;
}

function buildHlsUrl(videoGuid) {
    if (!STREAM_HLS_BASE) return null;
    return `${STREAM_HLS_BASE}/${videoGuid}/playlist.m3u8`;
}

function buildDirectUrl(videoGuid) {
    // https://iframe.mediadelivery.net/play/<libraryId>/<guid>
    return `${STREAM_PLAY_BASE}/${STREAM_LIBRARY_ID}/${videoGuid}`;
}

async function run() {
    console.log(`[stream-generator] Inici -> StreamLibrary='${STREAM_LIBRARY_ID}' StorageZone='${STORAGE_ZONE}' Prefix='/${ROOT_PREFIX}'`);
    if (STREAM_TITLE_PREFIX_FILTER) console.log(`[stream-generator] Filter title prefix='${STREAM_TITLE_PREFIX_FILTER}'`);
    console.log(`[stream-generator] HLS_BASE='${STREAM_HLS_BASE}' PLAY_BASE='${STREAM_PLAY_BASE}'`);

    const videos = await listAllStreamVideos();
    const files = [];

    for (const v of videos) {
        const guid = v.guid || v.videoGuid || v.id;
        if (!guid) continue;

        const titleRaw = (v.title || "").trim();
        if (!titleRaw) {
            console.warn(`[stream] Vídeo sense title, s'ignora. guid=${guid}`);
            continue;
        }

        const key = titleRaw.replace(/\\/g, "/").trim();

        // Opcional: filtrar per prefix de title (carpeta virtual)
        if (STREAM_TITLE_PREFIX_FILTER) {
            if (!key.startsWith(STREAM_TITLE_PREFIX_FILTER)) continue;
        }

        // Derivem folder/file només per compatibilitat i lectura humana
        const lastSlash = key.lastIndexOf("/");
        let folder = "";
        let file = key;
        if (lastSlash >= 0) {
            folder = key.substring(0, lastSlash);
            file = key.substring(lastSlash + 1);
        }

        const hlsUrl = buildHlsUrl(guid);
        const directUrl = buildDirectUrl(guid);

        files.push({ key, folder, file, hlsUrl, directUrl });
    }

    const manifest = { files };

    // 1) Escriu localment
    const outLocal = path.join(process.cwd(), "stream-manifest.json");
    fs.writeFileSync(outLocal, JSON.stringify(manifest, null, 2), "utf8");
    console.log(`[stream-generator] Manifest local -> ${outLocal} (files=${files.length})`);

    // 2) PUT a Storage, al mateix ROOT_PREFIX que l'altre manifest
    const subPath = ROOT_PREFIX ? `${ROOT_PREFIX}/stream-manifest-v2.json` : "stream-manifest-v2.json";
    const remotePath = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(subPath)}`;

    console.log(`[stream-generator] Upload -> ${remotePath}`);

    await axios.put(remotePath, JSON.stringify(manifest), {
        headers: { AccessKey: STORAGE_API_KEY, "Content-Type": "application/json" },
        maxBodyLength: Infinity,
    });

    console.log("[stream-generator] Upload OK");
}

run().catch((err) => {
    console.error("[stream-generator] ERROR:", err?.response?.data || err.message || err);
    process.exit(1);
});
