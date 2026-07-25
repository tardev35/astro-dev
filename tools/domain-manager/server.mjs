// Local Domain Manager — a tiny web UI to add a domain on the hosting VPS by
// running `./add-site.sh <domain>` over SSH. It authenticates with a PASSWORD
// (from .env via node-ssh), so a machine that has NO SSH key to the server
// (e.g. a freshly cloned dev Windows Server) can still add domains — no key
// setup required.
//
// Kept as its OWN tool, separate from the asset uploader, on purpose: this one
// holds a root password and can run a root command on the server, so it must
// never ride along with (or be hosted like) the uploader.
//
// Run:  node --env-file=tools/domain-manager/.env tools/domain-manager/server.mjs
//       (or double-click start-domain-manager.cmd). Binds localhost only.

import express from "express";
import { NodeSSH } from "node-ssh";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT) || 3000;
const VPS_HOST = process.env.VPS_HOST || "45.32.122.181";
const VPS_USER = process.env.VPS_USER || "root";
const VPS_PASSWORD = process.env.VPS_PASSWORD || "";

// add-site.sh runs as root, so the domain MUST be validated before it is placed
// in the remote command. This strict whitelist (a-z 0-9 . -, real TLD) blocks
// every shell metacharacter (space ; & | $ backtick ' ") that could smuggle an
// extra command onto the server — the difference between "add a site" and
// "run anything as root".
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

app.post("/api/add-site", async (req, res) => {
  const domain = String(req.body?.domain ?? "").trim().toLowerCase();
  if (!domain) {
    return res.status(400).json({ success: false, error: "กรุณากรอกชื่อโดเมน" });
  }
  if (!DOMAIN_RE.test(domain)) {
    return res.status(400).json({ success: false, error: `โดเมนไม่ถูกต้อง: '${domain}' (เช่น mybrand-review.com)` });
  }
  if (!VPS_PASSWORD) {
    return res.status(500).json({ success: false, error: "ยังไม่ได้ตั้ง VPS_PASSWORD ใน .env (คัดลอกจาก .env.example)" });
  }

  const ssh = new NodeSSH();
  try {
    await ssh.connect({ host: VPS_HOST, username: VPS_USER, password: VPS_PASSWORD });
    // domain is whitelisted above, so this interpolation is safe.
    const result = await ssh.execCommand(`./add-site.sh ${domain}`);
    return res.json({ success: true, output: result.stdout, errorOutput: result.stderr });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    ssh.dispose();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`\n  Domain manager: http://localhost:${PORT}   (bind ${HOST})`);
  console.log(`  Target VPS: ${VPS_USER}@${VPS_HOST}`);
  if (!VPS_PASSWORD) console.log(`  [!] VPS_PASSWORD ยังว่าง — ตั้งใน tools/domain-manager/.env ก่อนใช้งาน`);
  console.log("");
});
