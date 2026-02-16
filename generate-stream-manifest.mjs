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
const STREAM_PLAY_BASE =
    (process.env.BUNNY_STREAM_PLAY_BASE || "https://video.bunnycdn.com/play").replace(/\/$/, "");
const STREAM_HLS_BASE = process.env.BUNNY_STREAM_HLS_BASE; // ex: https://vz-xxxx.b-cdn.net

// Validacions mínimes
if (!STORAGE_ZONE) throw new Error("Falta BUNNY_STORAGE_ZONE");
if (typeof STORAGE_API_KEY !== "string" || !STORAGE_API_KEY.length) {
    throw new Error("Falta BUNNY_STORAGE_API_KEY");
}

if (!STREAM_LIBRARY_ID) throw new Error("Falta BUNNY_STREAM_LIBRARY_ID");
if (!STREAM_API_KEY) throw new Error("Falta BUNNY_STREAM_API_KEY");

// Normalitza ROOT_PREFIX (sense / inicial ni final)
const ROOT_PREFIX = ROOT_PREFIX_RAW.replace(/^\/+|\/+$/g, "");

// --- Helpers petits ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Llista tots els vídeos de Bunny Stream per a una Video Library
 * utilitzant l'endpoint "List Videos" (paginat).
 *
 * Docs: https://docs.bunny.net/reference/video_list
 */
async function listAllStreamVideos() {
    const all = [];
    let page = 1;
    const itemsPerPage = 100;

    // Com a màxim 100 pàgines per no entrar en bucle infinit
    for (let i = 0; i < 100; i++) {
        const url = `${STREAM_API}/library/${STREAM_LIBRARY_ID}/videos?page=${page}&itemsPerPage=${itemsPerPage}`;
        console.log(`[stream] GET ${url}`);

        const res = await axios.get(url, {
            headers: {
                AccessKey: STREAM_API_KEY,
                Accept: "application/json",
            },
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
    const base = STREAM_HLS_BASE.replace(/\r?\n/g, "").trim().replace(/\/$/, "");
    return `${base}/${videoGuid}/playlist.m3u8`;
}

function buildDirectUrl(videoGuid) {
    const base = STREAM_PLAY_BASE.replace(/\r?\n/g, "").trim().replace(/\/$/, "");
    return `${base}/${STREAM_LIBRARY_ID}/${videoGuid}`;
}

/**
 * MODEL NOU (clau única):
 * - El manifest porta: { key, hlsUrl, directUrl }
 * - "key" és EXACTAMENT el títol (title) del vídeo a Bunny Stream.
 * - Aquest title ha de ser la ruta virtual completa (incloent .mp4/.mov), per exemple:
 *   "América Sur/Argentina/Argentina Espectacular/006_Libre Buenos Aires/001_Buenos Aires/001_Buenos Aires.mp4"
 */
async function run() {
    console.log(
        `[stream-generator] Inici -> StreamLibrary='${STREAM_LIBRARY_ID}'  StorageZone='${STORAGE_ZONE}'  Prefix='/${ROOT_PREFIX}'`
    );

    const videos = await listAllStreamVideos();

    const files = [];

    for (const v of videos) {
        const guid = v.guid || v.videoGuid || v.id;
        if (!guid) continue;

        // IMPORTANT: només fem servir el title, sense fallbacks a v.name
        const title = (v.title || "").trim();
        if (!title) {
            console.warn(
                `[stream] Vídeo sense title, s\'ignora. guid=${guid} (posa-li un title amb la ruta virtual completa si vols override)`
            );
            continue;
        }

        const key = title.replace(/\\/g, "/").trim();

        files.push({
            key,
            hlsUrl: buildHlsUrl(guid),
            directUrl: buildDirectUrl(guid),
        });
    }

    const manifest = { files };

    // 1) Escriu localment
    const outLocal = path.join(process.cwd(), "stream-manifest.json");
    fs.writeFileSync(outLocal, JSON.stringify(manifest, null, 2));
    console.log(`[stream-generator] Manifest local -> ${outLocal} (files=${files.length})`);

    // 2) PUT a Storage, al mateix ROOT_PREFIX que l'altre manifest
    const subPath = ROOT_PREFIX
        ? `${ROOT_PREFIX}/stream-manifest-v2.json`
        : "stream-manifest-v2.json";

    const remotePath = `${STORAGE_API}/${encodeURIComponent(STORAGE_ZONE)}/${encodeURI(subPath)}`;

    console.log(`[stream-generator] Upload -> ${remotePath}`);

    await axios.put(remotePath, JSON.stringify(manifest), {
        headers: {
            AccessKey: STORAGE_API_KEY,
            "Content-Type": "application/json",
        },
        maxBodyLength: Infinity,
    });

    console.log("[stream-generator] Upload OK");
}

run().catch((err) => {
    console.error("[stream-generator] ERROR:", err?.response?.data || err.message || err);
    process.exit(1);
});
