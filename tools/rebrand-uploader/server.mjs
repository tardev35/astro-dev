// Local-only asset uploader for the rebrand workflow.
// Run with: npm run rebrand:upload   (opens http://localhost:4000)
//
// It stages a new brand's files into src/assets and public with the exact
// filenames + extensions the components import, so the "extension drift" bug
// class (Phase 4 of the rebrand-site skill) can't happen. It does NOT run the
// rebrand itself — after staging, tell Claude to rebrand per the skill.
//
// Deps: Node built-ins + sharp (already in package.json). No new dependency.

import http from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readdir, unlink, writeFile, mkdir } from "node:fs/promises";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const ASSETS = join(ROOT, "src", "assets");
const PUBLIC = join(ROOT, "public");
const PORT = 4000;

const IMAGE_EXTS = ["png", "webp", "jpg", "jpeg", "avif", "gif", "svg"];

// Cap the stored source width. 2560px covers a full-bleed hero on a 27" QHD
// monitor without upscaling smaller uploads — only genuinely oversized files
// (e.g. a 4000px export) get downscaled, so the repo can't bloat while big
// screens still stay crisp. Bump this if you serve 4K-native hero art.
const MAX_SOURCE_WIDTH = 2560;

// Promotion / carousel slides are never rendered wider than 600px
// (SmoothCarousel uses widths=[200,400,600]), so storing the full-size export
// is wasted bytes. Fit inside a 600x600 box: keeps aspect ratio, never crops,
// never upscales a smaller upload.
const SLIDE_BOX = 600;

// Normalize an upload before it is stored: downscale only when larger than the
// limit (never upscale). Returns a sharp pipeline the caller finishes + writes.
async function prep(buf, { maxWidth = MAX_SOURCE_WIDTH, box = null } = {}) {
  const meta = await sharp(buf).metadata();
  let img = sharp(buf);
  if (box) {
    img = img.resize({ width: box, height: box, fit: "inside", withoutEnlargement: true });
  } else if (meta.width && meta.width > maxWidth) {
    img = img.resize({ width: maxWidth });
  }
  return img;
}

// Remove same-base image files with a different extension so a hardcoded import
// or a glob (e.g. logo.*, banner*.{png,webp,...}) can't pick a stale leftover.
async function cleanupSiblings(dir, base, keepExt) {
  for (const ext of IMAGE_EXTS) {
    if (ext === keepExt) continue;
    try {
      await unlink(join(dir, `${base}.${ext}`));
    } catch {
      /* not present — fine */
    }
  }
}

// sharp cannot write .ico. Wrap a PNG payload in a minimal ICO container
// (ICO supports embedded PNG since Windows Vista; modern browsers read it).
function buildIco(pngBuffer, size) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // image count
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size >= 256 ? 0 : size, 0); // width  (0 => 256)
  entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8); // size of image data
  entry.writeUInt32LE(6 + 16, 12); // offset of image data
  return Buffer.concat([header, entry, pngBuffer]);
}

async function toPng(buf, dir, base, opts) {
  // Lossless PNG optimization: identical pixels, ~80% smaller than sharp's
  // default png() on photographic banners/slides. No banding, safe for hero art.
  const img = await prep(buf, opts);
  await img.png({ compressionLevel: 9, effort: 10 }).toFile(join(dir, `${base}.png`));
  await cleanupSiblings(dir, base, "png");
  return `${base}.png`;
}

async function toWebp(buf, dir, base, opts) {
  const img = await prep(buf, opts);
  await img.webp({ quality: 90, effort: 6 }).toFile(join(dir, `${base}.webp`));
  await cleanupSiblings(dir, base, "webp");
  return `${base}.webp`;
}

// sharp can't vectorize a bitmap. For a raster favicon, wrap a square PNG as a
// base64 data URI inside a minimal SVG so favicon.svg still refreshes with the
// new brand instead of keeping the previous one. (A real .svg upload is written
// through untouched — see the favicon slot.)
async function rasterToSvg(buf, size = 512) {
  const png = await sharp(buf)
    .resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const dataUri = `data:image/png;base64,${png.toString("base64")}`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">` +
      `<image width="${size}" height="${size}" href="${dataUri}"/>` +
      `</svg>\n`,
    "utf8",
  );
}

async function handleUpload(slot, index, ext, buf) {
  const n = Number(index);
  switch (slot) {
    case "logo":
      // one upload -> both src/assets/logo.webp and public/logo.webp (same logo)
      await toWebp(buf, ASSETS, "logo");
      await toWebp(buf, PUBLIC, "logo");
      return ["src/assets/logo.webp", "public/logo.webp"];
    case "docx":
      await writeFile(join(ASSETS, "content.docx"), buf);
      return ["content.docx"];
    case "bg":
      return [await toPng(buf, ASSETS, "bg")];
    case "banner":
      if (!(n >= 1 && n <= 4)) throw new Error("banner index must be 1-4");
      return [await toPng(buf, ASSETS, `banner${n}`)];
    case "slide":
      if (!(n >= 1 && n <= 4)) throw new Error("slide index must be 1-4");
      return [await toPng(buf, ASSETS, `slide${n}`, { box: SLIDE_BOX })];
    case "favicon": {
      const written = [];
      const rasters = [
        ["favicon-96x96.png", 96],
        ["apple-touch-icon.png", 180],
        ["web-app-manifest-192x192.png", 192],
        ["web-app-manifest-512x512.png", 512],
      ];
      for (const [name, size] of rasters) {
        await sharp(buf).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(join(PUBLIC, name));
        written.push(name);
      }
      const icoPng = await sharp(buf).resize(48, 48, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      await writeFile(join(PUBLIC, "favicon.ico"), buildIco(icoPng, 48));
      written.push("favicon.ico");
      if (ext === "svg") {
        await writeFile(join(PUBLIC, "favicon.svg"), buf);
      } else {
        // raster upload: still refresh favicon.svg by embedding the PNG in it
        await writeFile(join(PUBLIC, "favicon.svg"), await rasterToSvg(buf));
      }
      written.push("favicon.svg");
      return written;
    }
    default:
      throw new Error(`unknown slot: ${slot}`);
  }
}

function readBody(req) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolvePromise(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const PAGE = /* html */ `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rebrand Asset Uploader</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: system-ui, "Segoe UI", sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
  header { padding: 20px 24px; background: #111827; border-bottom: 1px solid #1f2937; }
  header h1 { margin: 0 0 4px; font-size: 20px; }
  header p { margin: 0; color: #94a3b8; font-size: 13px; }
  main { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); padding: 24px; max-width: 1100px; margin: 0 auto; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 14px; padding: 18px; }
  .card h2 { margin: 0 0 4px; font-size: 16px; }
  .card > .sub { margin: 0 0 14px; font-size: 12px; color: #94a3b8; }
  .field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 1px solid #334155; }
  .field:first-of-type { border-top: 0; }
  .field .row { display: flex; align-items: center; gap: 10px; }
  .field label { font-size: 14px; font-weight: 600; }
  .field .target { font-size: 11px; color: #38bdf8; font-family: ui-monospace, monospace; }
  .field .opt { font-size: 11px; color: #64748b; font-weight: 400; }
  .field input[type=file] { font-size: 12px; color: #cbd5e1; }
  .field .status { font-size: 12px; min-height: 16px; }
  .thumb { width: 44px; height: 44px; object-fit: contain; border-radius: 8px; background: #0f172a; border: 1px solid #334155; display: none; }
  .thumb.show { display: block; }
  .bar { position: sticky; bottom: 0; background: #111827; border-top: 1px solid #1f2937; padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
  button { background: #2563eb; color: #fff; border: 0; padding: 11px 22px; font-size: 15px; font-weight: 600; border-radius: 10px; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  #log { flex: 1; font-size: 12px; font-family: ui-monospace, monospace; max-height: 90px; overflow: auto; }
  #log div.ok { color: #4ade80; }
  #log div.err { color: #f87171; }
</style>
</head>
<body>
<header>
  <h1>Rebrand Asset Uploader</h1>
  <p>เลือกไฟล์แล้วกด "อัพโหลดทั้งหมด" — ระบบจะเซฟลง <code>src/assets</code> และ <code>public</code> ด้วยชื่อ/นามสกุลที่ถูกต้องอัตโนมัติ พร้อม<strong>บีบอัดรูปแบบ lossless</strong> (คมเท่าเดิม ไฟล์เล็กลง) ย่อรูปที่กว้างเกิน ${MAX_SOURCE_WIDTH}px ให้พอดี และย่อรูป <strong>Promotion/Carousel เหลือ ${SLIDE_BOX}×${SLIDE_BOX}</strong> (ขนาดที่หน้าเว็บใช้จริง) — แค่ stage ไฟล์ ไม่ได้รัน rebrand</p>
</header>
<main>
  <section class="card" id="card1">
    <h2>ไฟล์แบรนด์ทั้งหมด</h2>
    <p class="sub">โลโก้ / favicon / เนื้อหา (docx) / พื้นหลัง / แบนเนอร์ / รูป promotion + carousel</p>
    <div class="field" data-img>
      <div class="row"><label>Logo</label><span class="target">logo.webp (src/assets + public)</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="logo" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field">
      <div class="row"><label>Content brief</label><span class="target">content.docx</span></div>
      <div class="row"><input type="file" accept=".docx" data-slot="docx" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Background</label><span class="target">bg.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="bg" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 1</label><span class="target">banner1.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="1" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 2</label><span class="opt">optional</span><span class="target">banner2.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="2" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 3</label><span class="opt">optional</span><span class="target">banner3.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="3" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Banner 4</label><span class="opt">optional</span><span class="target">banner4.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="4" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Promotion + Carousel 1</label><span class="target">slide1.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="1" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Promotion + Carousel 2</label><span class="target">slide2.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="2" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Promotion + Carousel 3</label><span class="target">slide3.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="3" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Promotion + Carousel 4</label><span class="opt">optional</span><span class="target">slide4.png</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="4" /><img class="thumb" /></div>
      <span class="status"></span>
    </div>
    <div class="field" data-img>
      <div class="row"><label>Favicon</label><span class="target">favicon.ico + .png set + .svg</span></div>
      <div class="row"><input type="file" accept="image/*,.svg" data-slot="favicon" /><img class="thumb" /></div>
      <span class="status">สร้างชุด PNG + .ico + .svg ให้อัตโนมัติ (รูป raster จะฝังลงใน favicon.svg; ถ้าอัพโหลด .svg จะใช้ไฟล์นั้นตรงๆ)</span>
    </div>
  </section>
</main>
<div class="bar">
  <button id="uploadAll">อัพโหลดทั้งหมด</button>
  <div id="log"></div>
</div>
<script>
  // live thumbnails
  document.querySelectorAll('.field[data-img] input[type=file]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const thumb = inp.parentElement.querySelector('.thumb');
      if (!thumb) return;
      if (inp.files[0]) { thumb.src = URL.createObjectURL(inp.files[0]); thumb.classList.add('show'); }
      else thumb.classList.remove('show');
    });
  });

  const log = document.getElementById('log');
  function addLog(msg, ok) { const d = document.createElement('div'); d.className = ok ? 'ok' : 'err'; d.textContent = (ok ? '✓ ' : '✗ ') + msg; log.prepend(d); }
  function setStatus(inp, txt) { const s = inp.closest('.field').querySelector('.status'); s.textContent = txt; }

  document.getElementById('uploadAll').addEventListener('click', async () => {
    const inputs = [...document.querySelectorAll('input[type=file]')];
    let any = false;
    for (const inp of inputs) {
      if (!inp.files.length) continue;
      any = true;
      const file = inp.files[0];
      const slot = inp.dataset.slot;
      const index = inp.dataset.index || '';
      const ext = (file.name.split('.').pop() || '').toLowerCase();
      const q = new URLSearchParams({ slot, index, ext });
      setStatus(inp, '⏳ กำลังอัพโหลด...');
      try {
        const res = await fetch('/upload?' + q.toString(), { method: 'POST', body: file });
        const j = await res.json();
        if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
        setStatus(inp, '✅ ' + j.written.join(', '));
        addLog(slot + (index ? index : '') + ' → ' + j.written.join(', '), true);
      } catch (e) {
        setStatus(inp, '❌ ' + e.message);
        addLog(slot + (index ? index : '') + ': ' + e.message, false);
      }
    }
    if (!any) addLog('ยังไม่ได้เลือกไฟล์ใดๆ', false);
  });
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  if (req.method === "POST" && url.pathname === "/upload") {
    try {
      const slot = url.searchParams.get("slot") || "";
      const index = url.searchParams.get("index") || "";
      const ext = (url.searchParams.get("ext") || "").toLowerCase();
      const buf = await readBody(req);
      if (!buf.length) throw new Error("empty upload");
      const written = await handleUpload(slot, index, ext, buf);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, written }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

// ensure target dirs exist (they normally do in this repo)
await mkdir(ASSETS, { recursive: true });
await mkdir(PUBLIC, { recursive: true });

server.listen(PORT, () => {
  console.log(`\n  Rebrand asset uploader running:\n  → http://localhost:${PORT}\n`);
  console.log(`  Writes into:\n  - ${ASSETS}\n  - ${PUBLIC}\n`);
  console.log("  Ctrl+C to stop. This only stages files; run the rebrand via Claude afterward.\n");
});
