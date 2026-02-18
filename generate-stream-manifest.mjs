// generate-stream-manifest.mjs
// Genera un manifest de Bunny Stream (HLS + Direct) i el puja a Bunny Storage.
// IMPORTANT: Manté espais i accents: la 'key' és EXACTAMENT el title del vídeo a Stream.

import axios from "axios";
import "dotenv/config";

const STORAGE_API = "https://storage.bunnycdn.com";
const STREAM_API = "https://video.bunnycdn.com";

// --- ENV STORAGE ---
const STORAGE_ZONE = process.env.BUNNY_STORAGE_ZONE;
const ROOT_PREFIX_RAW = process.env.ROOT_PREFIX || "";
const STORAGE_API_KEY = process.env.BUNNY_STORAGE_API_KEY;

// --- ENV STREAM ---
const STREAM_LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const STREAM_API_KEY = process.env.BUNNY_STREAM_API_KEY;

// Bases (IMPORTANT: les normalitzem perquè no entrin \r\n al JSON)
const STREAM_HLS_BASE_RAW = process.env.BUNNY_STREAM_HLS_BASE || ""; // ex: https://vz-xxxx.b-cdn.net
const STREAM_PLAY_BASE_RAW =
    process.env.BUNNY_STREAM_PLAY_BASE || "https://iframe.mediadelivery.net/play"; // ex: https://iframe.mediadelivery.net/play
const STREAM_TITLE_PREFIX_FILTER_RAW =
    process.env.BUNNY_STREAM_TITLE_PREFIX_FILTER || ""; // ex: VillaViatgesStream/

// --- Utils ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanBase(s) {
    if (!s) return "";
    // elimina CR/LF (típic de secrets), trims i treu '/' final
    return String(s)
        .replace(/\r/g, "")
        .replace(/\n/g, "")
        .trim()
        .replace(/\/+$/, "");
}

const STREAM_HLS_BASE = cleanBase(STREAM_HLS_BASE_RAW);
const STREAM_PLAY_BASE = cleanBase(STREAM_PLAY_BASE_RAW);
const STREAM_TITLE_PREFIX_FILTER = String(STREAM_TITLE_PREFIX_FILTER_RAW)
    .replace(/\\/g, "/")
    .trim();

// Normalitza ROOT_PREFIX (sense / inicial ni final)
const ROOT_PREFIX = String(ROOT_PREFIX_RAW).replace(/^\/+|\/+$/g, "");

// Validacions mínimes
if (!STORAGE_ZONE) throw new Error("Falta BUNNY_STORAGE_ZONE");
if (typeof STORAGE_API_KEY !== "string" || !STORAGE_API_KEY.length)
    throw new Error("Falta BUNNY_STORAGE_API_KEY");
if (!STREAM_LIBRARY_ID) throw new Error("Falta BUNNY_STREAM_LIBRARY_ID");
if (!STREAM_API_KEY) throw new Error("Falta BUNNY_STREAM_API_KEY");

async function listAllStreamVideos() {
    const all = [];
    let page = 1;
    const itemsPerPage = 100;

    for (let i = 0; i < 200; i++) {
        const url = `${STREAM_API}/library/${STREAM_LIBRARY_ID}/videos?page=${page}&itemsPerPage=${itemsPerPage}`;
        console.log(`[stream] GET ${url}`);

        const res = await axios.get(url, {
            headers: { AccessKey: STREAM_API_KEY, Accept: "application/json" },
        });

        const data = res.data || {};
        const items = Array.isArray(data.items)
            ? data.items
            : Array.isArray(data.videos)
                ? data.videos
                : [];

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
    return `${STREAM_PLAY_BASE}/${STREAM_LIBRARY_ID}/${videoGuid}`;
}

function splitFolderFile(key) {
    const k = key.replace(/\\/g, "/");
    const idx = k.lastIndexOf("/");
    if (idx < 0) return { folder: "", file: k };
    return { folder: k.substring(0, idx), file: k.substring(idx + 1) };
}

async function uploadToStorage(jsonText) {
    const remotePath = ROOT_PREFIX
        ? `${ROOT_PREFIX}/stream-manifest-v2.json`
        : "stream-manifest-v2.json";
    const url = `${STORAGE_API}/${STORAGE_ZONE}/${remotePath}`;

    console.log(`[storage] PUT ${url}`);

    await axios.put(url, jsonText, {
        headers: {
            AccessKey: STORAGE_API_KEY,
            "Content-Type": "application/json; charset=utf-8",
        },
        maxBodyLength: Infinity,
    });

    console.log(`[storage] OK -> ${remotePath}`);
}

async function run() {
    console.log(
        `[stream-generator] Inici -> StreamLibrary='${STREAM_LIBRARY_ID}' StorageZone='${STORAGE_ZONE}' Prefix='/${ROOT_PREFIX}'`
    );
    console.log(
        `[stream-generator] HLS_BASE='${STREAM_HLS_BASE}' PLAY_BASE='${STREAM_PLAY_BASE}' PREFIX_FILTER='${STREAM_TITLE_PREFIX_FILTER}'`
    );

    const videos = await listAllStreamVideos();
    const files = [];

    for (const v of videos) {
        const guid = v.guid || v.videoGuid || v.id;
        if (!guid) continue;

        const title = (v.title || "").trim();
        if (!title) {
            console.warn(`[stream] Vídeo sense title, s'ignora. guid=${guid}`);
            continue;
        }

        // Key = title tal qual (espais/accents OK)
        const key = title.replace(/\\/g, "/").trim();

        // Filtre opcional (només inclou vídeos que comencen per aquest prefix)
        if (STREAM_TITLE_PREFIX_FILTER) {
            if (!key.startsWith(STREAM_TITLE_PREFIX_FILTER)) continue;
        }

        const { folder, file } = splitFolderFile(key);

        // Construïm les URLs i eliminem CR/LF per seguretat
        const hlsUrlRaw = buildHlsUrl(guid);
        const directUrlRaw = buildDirectUrl(guid);

        const hlsUrl = hlsUrlRaw
            ? String(hlsUrlRaw).replace(/\r/g, "").replace(/\n/g, "").trim()
            : null;
        const directUrl = directUrlRaw
            ? String(directUrlRaw).replace(/\r/g, "").replace(/\n/g, "").trim()
            : null;

        files.push({
            key,
            folder,
            file,
            hlsUrl,
            directUrl,
        });
    }

    const manifest = { files };
    const jsonText = JSON.stringify(manifest);

    console.log(`[stream-generator] Manifest entries: ${files.length}`);
    await uploadToStorage(jsonText);
}

run().catch((err) => {
    console.error("[stream-generator] ERROR:", err?.response?.data || err?.message || err);
    process.exit(1);
});
