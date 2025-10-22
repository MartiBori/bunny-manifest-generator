import 'dotenv/config';
import axios from 'axios';
import path from 'path';

const ZONE = process.env.BUNNY_STORAGE_ZONE;
const KEY  = process.env.BUNNY_STORAGE_API_KEY;
const CDN  = process.env.BUNNY_CDN_BASE;
const ROOT = (process.env.ROOT_PREFIX || 'Test').replace(/^\/+|\/+$/g, '');

if (!ZONE || !KEY || !CDN) { console.error('Falten BUNNY_STORAGE_ZONE, BUNNY_STORAGE_API_KEY, BUNNY_CDN_BASE'); process.exit(1); }

const storage = axios.create({
  baseURL: `https://storage.bunnycdn.com/${ZONE}/`,
  headers: { AccessKey: KEY },
  responseType: 'json',
  validateStatus: () => true
});

function isAssetFile(name) {
  const ext = path.extname(name).toLowerCase();
  const IMG = ['.jpg','.jpeg','.png','.webp','.avif','.gif'];
  const AUD = ['.mp3','.wav','.ogg'];
  const VID = ['.mp4','.m4v','.mov','.webm','.m3u8'];
  return IMG.includes(ext) || AUD.includes(ext) || VID.includes(ext);
}

async function listDir(relPath = '') {
  const clean = relPath.replace(/^\/+|\/+$/g, '');
  const url = clean ? `${clean}/` : '';
  const res = await storage.get(encodeURI(url));
  if (res.status >= 400) throw new Error(`List error ${res.status} @ ${url}: ${res.data?.Message || res.statusText}`);
  return res.data;
}

async function crawlTestStructure(rootPrefix) {
  const itineraries = [];
  const firstLevel = await listDir(rootPrefix);
  for (const it of firstLevel) {
    if (it.IsDirectory !== true) continue;
    const itineraryName = it.ObjectName;
    const days = [];
    const daysList = await listDir(`${rootPrefix}/${itineraryName}`);
    for (const d of daysList) {
      if (d.IsDirectory !== true) continue;
      const dayName = d.ObjectName;
      const assets = [];
      const files = await listDir(`${rootPrefix}/${itineraryName}/${dayName}`);
      for (const f of files) {
        if (f.IsDirectory === true) continue;
        if (!isAssetFile(f.ObjectName)) continue;
        const rel = `${rootPrefix}/${itineraryName}/${dayName}/${f.ObjectName}`;
        assets.push({ url: `${CDN}/${encodeURI(rel)}`, name: f.ObjectName });
      }
      days.push({ name: dayName, assets });
    }
    itineraries.push({ name: itineraryName, days });
  }
  return { itineraries };
}

async function uploadJson(jsonText, targetPath) {
  const res = await storage.put(encodeURI(targetPath), jsonText, { headers: { 'Content-Type': 'application/json' } });
  if (res.status < 200 || res.status >= 300) throw new Error(`Upload error ${res.status}: ${res.data?.Message || res.statusText}`);
  return true;
}

(async () => {
  try {
    const manifest = await crawlTestStructure(ROOT);
    const json = JSON.stringify(manifest, null, 2);
    const target = `${ROOT}/manifest.json`;
    await uploadJson(json, target);
    console.log(`Manifest generat i pujat: ${target}`);
    console.log(`URL pública: ${CDN}/${target}`);
  } catch (err) {
    console.error('FALLA:', err.message || err);
    process.exit(1);
  }
})();
