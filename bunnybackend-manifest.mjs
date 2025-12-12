import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch"; // si uses Node 18+ pots fer servir global fetch

// ----------- CONFIG per ENV -----------
// IMPORTANT: posa això al sistema (Vercel, Railway, etc.), NO hardcodejat.
const {
    GITHUB_TOKEN,     // token amb perms de repo (contents:write)
    GITHUB_OWNER,     // ex: "MetamaxVR"
    GITHUB_REPO,      // ex: "villa-viatges-manifests"
    MANIFEST_PATH,    // ex: "manifest.json" o "Vila_Viatges/manifest.json"
    API_KEY           // clau PROPIA per Unity -> backend (opcional però recomanable)
} = process.env;

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !MANIFEST_PATH) {
    console.error("Falten variables d'entorn GITHUB_*/MANIFEST_PATH");
    process.exit(1);
}

const app = express();
app.use(bodyParser.json());

// ---------- helper GitHub ----------

async function fetchManifestFromGitHub() {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${MANIFEST_PATH}`;

    const res = await fetch(url, {
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json"
        }
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Error GET manifest: ${res.status} ${txt}`);
    }

    const data = await res.json();
    const { content, sha } = data; // content és base64

    const jsonText = Buffer.from(content, "base64").toString("utf8");
    return { jsonText, sha };
}

async function updateManifestInGitHub(newJsonText, oldSha) {
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${MANIFEST_PATH}`;

    const payload = {
        message: "Update pinPos from Unity",
        content: Buffer.from(newJsonText, "utf8").toString("base64"),
        sha: oldSha
    };

    const res = await fetch(url, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${GITHUB_TOKEN}`,
            Accept: "application/vnd.github+json"
        },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const txt = await res.text();
        throw new Error(`Error PUT manifest: ${res.status} ${txt}`);
    }

    return await res.json();
}

// ---------- helper per aplicar pinPos ----------

/**
 * pinsByPath: { [path:string]: { x:number,y:number,z:number } }
 * manifestRoot: object (RBTree o variant)
 */
function applyPinsToManifest(manifestRoot, pinsByPath) {
    // El manifest pot tenir diverses formes (RBTree, diccionari amb "Vila_Viatges", etc.).
    // Ens basem en BunnyRuntimeCatalog: hi ha un RBTree amb children/files.
    // Pensem que la part interessant està sota .children.

    if (!manifestRoot) return manifestRoot;

    // Normalitzem el cas: busquem un array de nodes de primer nivell
    let rootNodes = [];

    if (manifestRoot.children && Array.isArray(manifestRoot.children)) {
        rootNodes = manifestRoot.children;
    } else if (Array.isArray(manifestRoot)) {
        rootNodes = manifestRoot;
    } else {
        // Podria ser un diccionari de continents, etc.
        // Busquem qualsevol value que sigui un node amb children.
        for (const k of Object.keys(manifestRoot)) {
            const val = manifestRoot[k];
            if (val && typeof val === "object" && val.children && Array.isArray(val.children)) {
                rootNodes.push(val);
            }
        }
    }

    // recorrem recursivament tots els nodes
    for (const node of rootNodes) {
        traverseNode(node, "", pinsByPath);
    }

    return manifestRoot;
}

/**
 * node: { name, children, files, ... }
 * curPath: path acumulat fins ara (sense incloure node.name)
 */
function traverseNode(node, curPath, pinsByPath) {
    if (!node || typeof node !== "object") return;

    const nodeName = node.name || "";
    const pathHere = curPath ? `${curPath}/${nodeName}` : nodeName;

    // Si tenim entrada per aquest path, afegim/actualitzem pinPos
    const pin = pinsByPath[pathHere];
    if (pin) {
        node.pinPos = { x: pin.x, y: pin.y, z: pin.z };
    }

    // Recorrem fills
    if (Array.isArray(node.children)) {
        for (const child of node.children) {
            traverseNode(child, pathHere, pinsByPath);
        }
    }
}

// ---------- ruta principal /syncPins ----------

app.post("/syncPins", async (req, res) => {
    try {
        // auth molt simple opcional
        if (API_KEY) {
            const sent = req.headers["x-api-key"];
            if (!sent || sent !== API_KEY) {
                return res.status(401).json({ ok: false, error: "Unauthorized" });
            }
        }

        const body = req.body || {};
        const pins = Array.isArray(body.pins) ? body.pins : [];

        if (pins.length === 0) {
            return res.status(400).json({ ok: false, error: "No pins array in body" });
        }

        // 1) Convertir a diccionari path -> pos
        const pinsByPath = {};
        for (const p of pins) {
            if (!p || !p.path) continue;
            pinsByPath[p.path] = { x: p.x || 0, y: p.y || 0, z: p.z || 0 };
        }

        // 2) Llegir manifest actual de GitHub
        const { jsonText, sha } = await fetchManifestFromGitHub();

        let manifestObj;
        try {
            manifestObj = JSON.parse(jsonText);
        } catch (e) {
            throw new Error("Manifest JSON invàlid: " + e.message);
        }

        // 3) Aplicar pinPos al manifest
        applyPinsToManifest(manifestObj, pinsByPath);

        const newJsonText = JSON.stringify(manifestObj, null, 2);

        // 4) Pujar manifest actualitzat a GitHub (nou commit)
        await updateManifestInGitHub(newJsonText, sha);

        // 5) Resposta a Unity
        return res.json({ ok: true });
    } catch (err) {
        console.error("Error /syncPins:", err);
        return res.status(500).json({ ok: false, error: String(err) });
    }
});

// ---------- arrencar servidor ----------

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Bunny pin sync backend escoltant al port ${PORT}`);
});
