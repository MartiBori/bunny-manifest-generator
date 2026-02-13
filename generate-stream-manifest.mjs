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
    (process.env.BUNNY_STREAM_PLAY_BASE || "https://video.bunnycdn.com/play").replace(
        /\/$/,
        ""
    );
const STREAM_HLS_BASE = process.env.BUNNY_STREAM_HLS_BASE; // ex: https://vz-f7f1c890-6a0.b-cdn.net


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
 * Docs: https://docs.bunny.net/reference/video_list :contentReference[oaicite:1]{index=1}
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
        await sleep(200); // petit pause per no spamejar l'API
    }

    console.log(`[stream] Total vídeos trobats: ${all.length}`);
    return all;
}

function buildHlsUrl(videoGuid) {
    if (!STREAM_HLS_BASE) return null;
    // https://vz-xxxx.b-cdn.net/<guid>/playlist.m3u8
    const base = STREAM_HLS_BASE.replace(/\/$/, "");
    return `${base}/${videoGuid}/playlist.m3u8`;
}

function buildDirectUrl(videoGuid) {
    // https://iframe.mediadelivery.net/play/<libraryId>/<guid>
    const base = STREAM_PLAY_BASE.replace(/\/$/, "");
    return `${base}/${STREAM_LIBRARY_ID}/${videoGuid}`;
}


/**
 * Genera un manifest molt simple:
 * {
 *   "files": [
 *     { "name": "Asia/Japon/.../Activity_001/Osaka", "url": "https://video.bunnycdn.com/...", "mime": "video/hls" }
 *   ]
 * }
 *
 * IMPORTANT:
 *  - El camp "name" és la nostra "clau de ruta virtual".
 *    Tu hauràs de posar aquest valor com a TÍTOL del vídeo a Stream, per exemple:
 *    "Asia/Japon/Japon_Itinerario_001/Japon_Iti_001_Dia_002/Japon_Iti_001_Dia_002_Activity_001/Osaka"
 */
async function run() {
    console.log(
        `[stream-generator] Inici -> StreamLibrary='${STREAM_LIBRARY_ID}'  StorageZone='${STORAGE_ZONE}'  Prefix='/${ROOT_PREFIX}'`
    );

    const videos = await listAllStreamVideos();

    const files = [];

    for (const v of videos) {
        // A l'API oficial el GUID del vídeo és a v.guid
        const guid = v.guid || v.videoGuid || v.id;
        if (!guid) continue;

        // Clau de ruta virtual -> fem servir el title
        const title = (v.title || v.name || "").trim();
        if (!title) {
            // Si el vídeo no té títol, no podem fer match amb la ruta de Storage
            console.warn(
                `[stream] Vídeo sense title, s'ignora. guid=${guid} (posa-li un title amb la ruta virtual si vols override)`
            );
            continue;
        }

        // --- MODEL NOU: la "key" és el title complet (ruta Activity + .mp4/.mov) ---
        const key = title.replace(/\\/g, "/").trim();

        // IMPORTANT: netegem bases (hi ha casos que l'env porta salts de línia)
        const hlsBase = (STREAM_HLS_BASE || "").replace(/\r?\n/g, "").trim().replace(/\/$/, "");
        const playBase = (STREAM_PLAY_BASE || "").replace(/\r?\n/g, "").trim().replace(/\/$/, "");

        // URLs
        const hlsUrl = hlsBase ? `${hlsBase}/${guid}/playlist.m3u8` : null;
        const directUrl = `${playBase}/${STREAM_LIBRARY_ID}/${guid}`;

        // Guardem només la key (i urls). No folder/file.
        files.push({
            key,
            hlsUrl,
            directUrl,
        });
    }

    const manifest = { files };

    // 1) Escriu localment
    const outLocal = path.join(process.cwd(), "stream-manifest.json");
    fs.writeFileSync(outLocal, JSON.stringify(manifest, null, 2));
    console.log(
        `[stream-generator] Manifest local -> ${outLocal} (files=${files.length})`
    );

    // 2) PUT a Storage, al mateix ROOT_PREFIX que l'altre manifest
    const subPath = ROOT_PREFIX ? `${ROOT_PREFIX}/stream-manifest-v2.json` : "stream-manifest-v2.json";
    const remotePath = `${STORAGE_API}/${encodeURIComponent(
        STORAGE_ZONE
    )}/${encodeURI(subPath)}`;

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
    console.error(
        "[stream-generator] ERROR:",
        err?.response?.data || err.message || err
    );
    process.exit(1);
});
