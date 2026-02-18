/**
 * generate-stream-manifest.mjs
 * Genera generate-stream-manifest.json con:
 *  - route: string EXACTA (acentos/espacios/Mayúsculas) SIN extensión
 *  - videos: [{ key, hlsUrl, directUrl }]
 *
 * Requiere variables de entorno (ejemplo):
 *  BUNNY_STREAM_LIBRARY_ID
 *  BUNNY_STREAM_API_KEY
 *  OUTPUT_PATH=./generate-stream-manifest.json
 *
 * NOTA: Ajusta los endpoints según tu setup real de Bunny Stream.
 */

import fs from "node:fs";

const LIBRARY_ID = process.env.BUNNY_STREAM_LIBRARY_ID;
const API_KEY = process.env.BUNNY_STREAM_API_KEY;
const OUTPUT_PATH = process.env.OUTPUT_PATH || "./generate-stream-manifest.json";

if (!LIBRARY_ID || !API_KEY) {
    console.error("Faltan ENV: BUNNY_STREAM_LIBRARY_ID y/o BUNNY_STREAM_API_KEY");
    process.exit(1);
}

function stripExt(name) {
    return name.replace(/\.[^/.]+$/, "");
}

// ---- TODO: Ajustar a tu endpoint real de Bunny Stream ----
// Ejemplo típico (puede variar):
//   GET https://video.bunnycdn.com/library/{LIBRARY_ID}/videos
async function listVideos() {
    const url = `https://video.bunnycdn.com/library/${LIBRARY_ID}/videos?page=1&itemsPerPage=1000`;
    const res = await fetch(url, {
        headers: { AccessKey: API_KEY },
    });
    if (!res.ok) throw new Error(`ListVideos HTTP ${res.status}`);
    return await res.json();
}

// Ejemplo: construir URLs (ajústalo a tu patrón real)
// - HLS suele ser algo tipo: https://vz-xxxx.b-cdn.net/{VIDEO_ID}/playlist.m3u8
// - Direct play puede ser: https://vz-xxxx.b-cdn.net/{VIDEO_ID}/play_720p.mp4 (depende)
function buildUrls(video) {
    // ?? Ajusta a tu CDN/zone real y a lo que Bunny te devuelve.
    // Si tu API ya te devuelve hlsUrl/directUrl, usa eso y elimina este builder.
    const videoId = video.guid || video.videoGuid || video.id;
    const base = video.cdnBaseUrl || video.cdnUrl || video.cdn || ""; // si lo tienes
    const hlsUrl = video.hlsUrl || (base ? `${base}/${videoId}/playlist.m3u8` : "");
    const directUrl = video.directUrl || (base ? `${base}/${videoId}/play.mp4` : "");
    return { hlsUrl, directUrl };
}

async function main() {
    const data = await listVideos();

    // Bunny a veces devuelve { items: [...] } o directamente [...]
    const items = Array.isArray(data) ? data : (data.items || []);

    // Agrupar por route
    const map = new Map();

    for (const v of items) {
        // Aquí está la CLAVE: el "title/name" del vídeo contiene la ruta exacta.
        // Usa el campo correcto según tu API: title, name, etc.
        const rawRoute = v.title || v.name || "";
        if (!rawRoute) continue;

        const route = stripExt(rawRoute); // SIN .mp4
        const key = route.split("/").at(-1) || route;

        const { hlsUrl, directUrl } = buildUrls(v);

        if (!map.has(route)) map.set(route, []);
        map.get(route).push({ key, hlsUrl, directUrl });
    }

    // Construir manifest final
    const manifest = {
        updatedAt: new Date().toISOString(),
        items: Array.from(map.entries()).map(([route, videos]) => ({
            route,
            videos: videos.sort((a, b) => (a.key || "").localeCompare(b.key || "", "es")),
        })),
    };

    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2), "utf8");
    console.log(`OK: escrito ${OUTPUT_PATH} routes=${manifest.items.length}`);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
