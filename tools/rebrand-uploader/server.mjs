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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { readFile, unlink, writeFile, mkdir, rename, readdir, stat } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const ASSETS = join(ROOT, "src", "assets");
const PUBLIC = join(ROOT, "public");
const PAGES = join(ROOT, "src", "pages");
// Parking lot for pages that exist but must not ship with the current brand.
// Astro only routes src/pages/, so a file moved here is off the site while
// staying in the repo for the next brand that wants it (same idea as the
// unused component variants — inventory, never deleted).
const PAGES_DISABLED = join(ROOT, "src", "pages-disabled");
const CONFIG = join(ROOT, "astro.config.mjs");
// Astro's static output. The operator deploys by uploading this folder to
// Cloudflare by hand, so the tool's last step is producing it — see /build.
const DIST = join(ROOT, "dist");
// Port/host are env-overridable but default to a localhost-only bind: every
// endpoint rewrites source files with NO auth, so it must never be reachable
// off-machine as-is. A future hosted deployment sets HOST=0.0.0.0 *after*
// adding auth/HTTPS — the default keeps a bare run safe.
const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || "127.0.0.1";

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

// A solid colour / gradient background is NOT rendered as an image — that would
// ship a full-screen bitmap for something that is just a CSS declaration. The
// uploader instead writes src/assets/bg.json, which MainLayout reads to decide:
//   { "mode": "image" }                          → <Image> the bg.png (default)
//   { "mode": "color", "color": "#rrggbb" }       → CSS background-color, 0 bytes
//   { "mode": "gradient", "css": "linear-…" }     → CSS gradient, 0 bytes
// bg.png is kept on disk either way so image mode always has a source to import.
const BG_CONFIG = join(ASSETS, "bg.json");

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

// ── palette measurement (src/assets/palette.json) ───────────────────────────
// The rebrand reads exact hex instead of judging the artwork by eye, so every
// image upload re-measures that image and updates one shared JSON file. Two
// lists per image, because they answer different questions:
//   vivid    — the brand hue. Buckets scored by saturation × area with
//              near-black / near-white / grey dropped, so logo.webp's vivid[0]
//              is the most reliable single "this is the brand colour".
//   dominant — the most AREA, which on a banner or slide is nearly always the
//              dark background: right for a page background, misleading as an
//              accent.
// `updatedAt` is what tells a rebrand which entries belong to the current asset
// drop — same-name files from an older brand linger in this repo on purpose.
const PALETTE_FILE = "palette.json";

function hsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return { s: max === 0 ? 0 : (max - min) / max, v: max / 255 };
}
const toHex = (r, g, b) => "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");

async function measurePalette(buf) {
  // 96px is plenty to rank colours and keeps this well under a frame of work.
  const { data } = await sharp(buf)
    .resize(96, 96, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  // Quantize to a 32-level cube so near-identical pixels count as one colour,
  // then average the real pixels inside each bucket back into an exact hex.
  const buckets = new Map();
  for (let i = 0; i + 2 < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const key = ((r >> 5) << 10) | ((g >> 5) << 5) | (b >> 5);
    let e = buckets.get(key);
    if (!e) buckets.set(key, (e = { n: 0, r: 0, g: 0, b: 0 }));
    e.n++; e.r += r; e.g += g; e.b += b;
  }
  const colours = [...buckets.values()].map((e) => {
    const r = Math.round(e.r / e.n), g = Math.round(e.g / e.n), b = Math.round(e.b / e.n);
    return { hex: toHex(r, g, b), n: e.n, ...hsv(r, g, b) };
  });
  const dominant = [...colours].sort((a, b) => b.n - a.n).slice(0, 5).map((c) => c.hex);
  const vivid = colours
    .filter((c) => c.s >= 0.25 && c.v >= 0.18 && c.v <= 0.98)
    .sort((a, b) => b.s * b.n - a.s * a.n)
    .slice(0, 5)
    .map((c) => c.hex);
  return { vivid, dominant };
}

// Best-effort: a palette we can't measure must never fail the upload itself —
// the image is already written and the rebrand can still read it by eye.
async function updatePalette(fileName, buf) {
  try {
    let all = {};
    try { all = JSON.parse(await readFile(join(ASSETS, PALETTE_FILE), "utf8")); } catch { /* first write */ }
    all[fileName] = { ...(await measurePalette(buf)), updatedAt: new Date().toISOString() };
    await writeFile(join(ASSETS, PALETTE_FILE), JSON.stringify(all, null, 2) + "\n", "utf8");
    return PALETTE_FILE;
  } catch (err) {
    console.warn(`[uploader] palette ${fileName}: ${err.message}`);
    return null;
  }
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

// ── Background: image | solid colour | gradient ─────────────────────────────
// The three are mutually exclusive; handleBackground() below enforces that
// exactly one of them was supplied and rejects zero or two+.

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Validate + expand to 6-digit lowercase. Every colour that reaches the CSS
// string / bg.json goes through here, so an operator can never inject arbitrary
// CSS (e.g. `red;url(...)`) into the value MainLayout drops into a style attr.
function hexColor(value, label) {
  const s = String(value ?? "").trim();
  if (!HEX_RE.test(s)) {
    throw new Error(`${label} ต้องเป็นรหัสสี hex เช่น #1a2b3c (ได้รับ: ${s || "ว่าง"})`);
  }
  const body = s.slice(1).toLowerCase();
  return "#" + (body.length === 3 ? [...body].map((c) => c + c).join("") : body);
}

function angleDeg(value) {
  const n = Number(String(value ?? "").trim() || 180);
  if (!Number.isFinite(n)) throw new Error(`มุมไล่สีต้องเป็นตัวเลข (ได้รับ: ${value})`);
  return ((n % 360) + 360) % 360;
}

// The CSS value MainLayout paints. Built from validated hex + a clamped angle,
// and it is exactly the string the browser preview shows — no image involved.
function gradientCss({ type, from, to, angle }) {
  return type === "radial"
    ? `radial-gradient(circle at 50% 50%, ${from}, ${to})`
    : `linear-gradient(${angle}deg, ${from}, ${to})`;
}

// Persist the chosen background mode for MainLayout. Colour/gradient ship as a
// CSS string (no bitmap); image mode resets the config so a previously stored
// colour/gradient can't keep overriding the freshly uploaded bg.png.
async function writeBgConfig(config) {
  await writeFile(BG_CONFIG, JSON.stringify(config, null, 2) + "\n");
  return "bg.json";
}

async function handleBackground(params, buf) {
  const color = (params.get("color") || "").trim();
  const from = (params.get("from") || "").trim();
  const to = (params.get("to") || "").trim();

  // The 3 conditions — exactly one must be present.
  const picked = [
    buf.length > 0 && "image",
    color !== "" && "color",
    (from !== "" || to !== "") && "gradient",
  ].filter(Boolean);

  if (picked.length === 0) {
    throw new Error("background: ต้องเลือก 1 อย่าง — อัพโหลดรูป / เลือกสีเดียว / ไล่สี (gradient)");
  }
  if (picked.length > 1) {
    throw new Error(`background: เลือกได้อย่างเดียวเท่านั้น แต่ส่งมา ${picked.length} อย่าง (${picked.join(" + ")})`);
  }

  switch (picked[0]) {
    case "image": {
      const png = await toPng(buf, ASSETS, "bg");
      const cfg = await writeBgConfig({ mode: "image" });
      return [png, cfg, ...withPalette(await updatePalette(png, buf))];
    }
    case "color":
      return [await writeBgConfig({ mode: "color", color: hexColor(color, "สีพื้นหลัง") })];
    case "gradient": {
      const type = params.get("type") === "radial" ? "radial" : "linear";
      const css = gradientCss({
        type,
        from: hexColor(from, "สีเริ่มต้นของ gradient"),
        to: hexColor(to, "สีปลายทางของ gradient"),
        angle: angleDeg(params.get("angle")),
      });
      return [await writeBgConfig({ mode: "gradient", css })];
    }
  }
}

// ── Text links: affiliate redirect + LINE redirect ──────────────────────────
// These are not files — they are string literals living inside source files:
//   • login.astro / register.astro:  const targetUrl = "<aff>";
//   • astro.config.mjs redirects:     "/line": "<line>",
// The uploader edits those literals in place so an operator can rebrand the
// links without touching code. Both values land inside a double-quoted string,
// so validateLink() rejects anything that isn't a clean http(s) URL — an
// operator can never inject a stray quote/newline and break the file.

const AFF_RE = /(const\s+targetUrl\s*=\s*)"[^"]*"/;
const LINE_RE = /("\/line"\s*:\s*)"[^"]*"/;

function validateLink(value, label) {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label}: ยังไม่ได้กรอกลิงก์`);
  if (/["'\n\r\\]/.test(s)) throw new Error(`${label}: ลิงก์มีอักขระต้องห้าม (\" ' \\ หรือขึ้นบรรทัดใหม่)`);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${label}: ต้องเป็น URL ที่ถูกต้อง เช่น https://example.com/abc (ได้รับ: ${s})`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`${label}: รองรับเฉพาะ http/https (ได้รับ: ${u.protocol})`);
  }
  return s;
}

// Replace `regex`'s captured literal in one file; error if the anchor is gone
// (e.g. someone renamed targetUrl) rather than silently writing nothing.
async function replaceInFile(file, regex, value, label) {
  const src = await readFile(file, "utf8");
  if (!regex.test(src)) throw new Error(`${label}: ไม่พบตำแหน่งลิงก์ในไฟล์ ${file}`);
  await writeFile(file, src.replace(regex, `$1"${value}"`));
}

async function handleAffLink(value) {
  const url = validateLink(value, "ลิงก์ aff");
  await replaceInFile(join(PAGES, "login.astro"), AFF_RE, url, "ลิงก์ aff (login)");
  await replaceInFile(join(PAGES, "register.astro"), AFF_RE, url, "ลิงก์ aff (register)");
  return ["src/pages/login.astro", "src/pages/register.astro"];
}

async function handleLineLink(value) {
  const url = validateLink(value, "ลิงก์ไลน์");
  await replaceInFile(CONFIG, LINE_RE, url, "ลิงก์ไลน์ (/line)");
  return ["astro.config.mjs"];
}

// Read the links currently in the source so the UI can pre-fill its inputs.
async function readCurrentLinks() {
  const out = { aff: "", line: "" };
  try {
    out.aff = (await readFile(join(PAGES, "login.astro"), "utf8")).match(AFF_RE)?.[0]?.match(/"([^"]*)"/)?.[1] || "";
  } catch { /* file missing — leave blank */ }
  try {
    out.line = (await readFile(CONFIG, "utf8")).match(LINE_RE)?.[0]?.match(/:\s*"([^"]*)"/)?.[1] || "";
  } catch { /* file missing — leave blank */ }
  return out;
}

// ── Sub-page SEO: Title + Meta description, sourced from content.docx ────────
// The four sub-pages set their <title>/<meta name="description"> via props on a
// single <MainLayout title="..." description="..."> tag (MainLayout renders them
// into the head + OG/Twitter). The brand's content.docx carries a
// "SUB-PAGES (Title & Meta Description)" section with a [heading] per page and a
// "Title:" / "Meta:" line under each. The uploader parses that section so an
// operator can pull the copy in, review it, and save it into the pages.
//
// Which page each entry maps to: keyed by the Thai heading used in the docx,
// matched loosely (with/without brackets, a few synonyms) so small wording
// differences still land on the right file.
const PAGE_META = {
  promotion: { file: "promotion.astro", label: "โปรโมชั่น", match: ["โปรโมชั่น", "promotion"] },
  contactus: { file: "contact-us.astro", label: "ติดต่อเรา", match: ["ติดต่อเรา", "ติดต่อ", "contact"] },
  demo: { file: "ทดลองเล่น.astro", label: "ทดลองเล่น", match: ["ทดลองเล่น", "ทดลอง", "demo"] },
  entrance: { file: "ทางเข้า.astro", label: "ทางเข้า", match: ["ทางเข้า", "entrance"] },
};

// ── Optional pages the operator toggles per brand ───────────────────────────
// Unlike PAGE_META (which edits pages that always exist), these rows are
// DECLARATIVE: the toggle state is what the brand being staged should ship.
//   ON  → the page(s) live in src/pages/ (scaffolded if they exist nowhere yet,
//         restored from src/pages-disabled/ if a previous brand parked them)
//         and their { name, path } links are wired into the ACTIVE navbar.
//   OFF → the page(s) are MOVED to src/pages-disabled/ (Astro ignores that
//         folder, so the routes disappear) and their links are stripped from
//         the active navbar AND footer.
// Nothing is ever deleted — off means parked, not gone. This matters because a
// page created for one brand otherwise persists into the next one: a slot brand
// used to ship the previous lottery brand's /ตรวจหวย, and an about-us written
// for brand A used to stay live for brand B.
// `boxTitle` present = the tool may scaffold the file from scratch (blank shell
// + TODO body for Claude); absent = move-only (the file ships with the repo and
// is never generated). `route` is the Astro file-based route (Thai filename →
// Thai route); `navLabel` is the menu text. Add a row here to offer more.
const PRESET_PAGES = {
  article: {
    label: "บทความ",
    boxTitle: "บทความ",
    pages: [{ file: "บทความ.astro", route: "/บทความ", navLabel: "บทความ" }],
  },
  aboutus: {
    label: "เกี่ยวกับเรา",
    boxTitle: "เกี่ยวกับเรา",
    pages: [{ file: "about-us.astro", route: "/about-us", navLabel: "เกี่ยวกับเรา" }],
  },
  // Lottery pages: move-only (they ship with the repo, hand-built with their own
  // Huay theme), and they come as a PAIR — a lottery brand gets both or neither.
  // Turning this on is also what makes the "คำสั่ง Rebrand" card put the word "เว็บหวย" in the
  // rebrand prompt, which is the trigger the skill's Phase 4.5 keys off.
  huay: {
    label: "เว็บหวย (ตรวจหวย + แนวทาง)",
    pages: [
      { file: "ตรวจหวย.astro", route: "/ตรวจหวย", navLabel: "ตรวจหวย" },
      { file: "แนวทาง.astro", route: "/แนวทาง", navLabel: "แนวทาง" },
    ],
  },
};
// A generated page is cloned from this existing sub-page's frontmatter so it
// stays on the brand's current component variants without hardcoding names here.
const CANONICAL_PAGE = "ทางเข้า.astro";
// The layout imports exactly one active navbar and one active footer; a page's
// links must go into (or come out of) whichever files those are — they rotate
// each rebrand, so resolve them dynamically instead of hardcoding names.
const NAV_IMPORT_RE = /import\s+Navbar\s+from\s+["']\.\.\/components\/([^"']+)["']/;
const FOOTER_IMPORT_RE = /import\s+Footer\s+from\s+["']\.\.\/components\/([^"']+)["']/;

// Anchor on the <MainLayout ...> opening tag specifically. The Thai pages also
// pass a title= to <ContentBox>, so a bare /title=/ would hit the wrong tag —
// these two regexes only ever touch attributes inside the MainLayout tag.
const ML_TITLE_RE = /(<MainLayout\b[^>]*?\btitle=)"[^"]*"/;
// Also normalises the pre-existing `,description=` typo in contact-us.astro to a
// clean ` description=` on write.
const ML_DESC_RE = /(<MainLayout\b[^>]*?)[,\s]+description=("|')[^"']*\2/;

// Title/Meta land inside a double-quoted Astro attribute, so forbid anything
// that would break out of it (quote, angle brackets, backtick, newline). Thai
// text and the "|" separator used in the briefs are fine.
function validateText(value, label) {
  const s = String(value ?? "").trim();
  if (!s) throw new Error(`${label}: ยังไม่ได้กรอกข้อความ`);
  if (/["'<>`\n\r]/.test(s)) throw new Error(`${label}: ห้ามมีอักขระ \" ' < > \` หรือขึ้นบรรทัดใหม่`);
  return s;
}

// ── Minimal ZIP reader (a .docx is a ZIP; no zip dependency in this repo) ────
// Read via the central directory (reliable sizes/offsets even for streamed
// entries) and inflate the one member we need. Enough for Office-produced docx.
function extractZipEntry(buf, wantName) {
  // End Of Central Directory record: signature 0x06054b50, scan from the end.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ไฟล์ docx ไม่ถูกต้อง (ไม่พบ EOCD ของ ZIP)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16); // offset of central directory
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break; // central file header sig
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wantName) {
      // Jump to the local header to find where the data actually starts.
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.subarray(dataStart, dataStart + compSize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`ไม่พบ ${wantName} ใน docx`);
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// One text line per Word paragraph (concatenate its <w:t> runs).
function docxToLines(xml) {
  const paras = xml.match(/<w:p[ >][\s\S]*?<\/w:p>/g) || [];
  const lines = [];
  for (const para of paras) {
    const runs = [...para.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => m[1]);
    const line = decodeXmlEntities(runs.join("")).trim();
    if (line) lines.push(line);
  }
  return lines;
}

// Given the docx lines, find the [heading] blocks and pull the Title/Meta line
// under each, mapping headings to page keys via PAGE_META. best-effort: pages
// not found in the docx are reported in `warnings`, never guessed.
function parseSubPages(lines) {
  const pages = {};
  const found = new Set();
  let current = null; // page key of the section we're inside
  const titleRe = /^\s*title\s*[:：]\s*(.+)$/i;
  // Briefs label the description line "Meta:", "Meta Description:", "Description:"
  // or "Des:" — all four must match. Missing "Meta Description:" meant the meta
  // was silently never pulled from a docx that used the long form.
  const metaRe = /^\s*(?:meta(?:\s*desc(?:ription)?)?|desc(?:ription)?|des)\s*[:：]\s*(.+)$/i;
  for (const raw of lines) {
    const line = raw.trim();
    // A heading line switches the current section. Strip brackets, then see
    // whether any page's match-terms appear in it.
    const bare = line.replace(/^\[|\]$/g, "").trim();
    const hit = Object.entries(PAGE_META).find(
      ([, cfg]) => cfg.match.some((m) => bare.includes(m)),
    );
    // Treat a line as a heading only when it's short and not a Title/Meta line —
    // avoids a long paragraph that merely mentions "โปรโมชั่น" flipping sections.
    // EVERY heading closes the current section, including one this tool has no
    // page for ([บทความ], [เข้าสู่ระบบ], "2. Main Title & Meta Description").
    // Leaving `current` alone there made the next section's Title/Meta overwrite
    // the page above it — [บทความ] landed in โปรโมชั่น, [เข้าสู่ระบบ] in ติดต่อเรา,
    // and the site-wide title in ทดลองเล่น. Unmapped copy is dropped, not moved.
    if (bare.length <= 40 && !titleRe.test(line) && !metaRe.test(line)) {
      current = hit ? hit[0] : null;
      if (current) pages[current] ??= { title: "", meta: "" };
      continue;
    }
    if (!current) continue;
    const t = line.match(titleRe);
    if (t) { pages[current].title = t[1].trim(); found.add(current); continue; }
    const d = line.match(metaRe);
    if (d) { pages[current].meta = d[1].trim(); found.add(current); }
  }
  // Keep only pages that yielded at least a title or meta.
  const result = {};
  for (const key of found) result[key] = pages[key];
  const warnings = Object.keys(PAGE_META)
    .filter((k) => !result[k])
    .map((k) => `${PAGE_META[k].label}: ไม่พบใน docx`);
  return { pages: result, warnings };
}

// Parse a docx buffer straight into sub-page copy — used both for the staged
// file and for a file the operator has only browsed (not uploaded yet), so the
// preview reflects the source they actually picked.
function parseDocxBuffer(buf) {
  const xml = extractZipEntry(buf, "word/document.xml").toString("utf8");
  return parseSubPages(docxToLines(xml));
}

async function readDocxSubPages() {
  let buf;
  try {
    buf = await readFile(join(ASSETS, "content.docx"));
  } catch {
    return { pages: {}, warnings: ["ยังไม่มี content.docx — อัพโหลด Content brief ในการ์ดแรกก่อน"] };
  }
  return parseDocxBuffer(buf);
}

// Read the title/description currently on each page's <MainLayout> tag so the UI
// can pre-fill (and so the operator sees what a blank docx result falls back to).
async function readCurrentPageMeta() {
  const out = {};
  for (const [key, cfg] of Object.entries(PAGE_META)) {
    const entry = { file: `src/pages/${cfg.file}`, label: cfg.label, title: "", meta: "" };
    try {
      const src = await readFile(join(PAGES, cfg.file), "utf8");
      entry.title = src.match(ML_TITLE_RE)?.[0]?.match(/"([^"]*)"$/)?.[1] || "";
      entry.meta = src.match(ML_DESC_RE)?.[0]?.match(/description=("|')([^"']*)\1/)?.[2] || "";
    } catch { /* file missing — leave blank */ }
    out[key] = entry;
  }
  return out;
}

// Write Title/Meta onto a file's <MainLayout> tag. Errors (rather than silently
// no-ops) if either prop anchor is missing. Shared by the existing sub-pages and
// the optional preset pages, which use the same <MainLayout title/desc> shape.
async function setMainLayoutMeta(file, title, desc, label) {
  const t = validateText(title, `Title ${label}`);
  const d = validateText(desc, `Meta ${label}`);
  const src = await readFile(file, "utf8");
  if (!ML_TITLE_RE.test(src)) throw new Error(`${label}: ไม่พบ title บนแท็ก <MainLayout>`);
  if (!ML_DESC_RE.test(src)) throw new Error(`${label}: ไม่พบ description บนแท็ก <MainLayout>`);
  const next = src
    .replace(ML_TITLE_RE, `$1"${t}"`)
    .replace(ML_DESC_RE, `$1 description="${d}"`);
  await writeFile(file, next);
}

async function writePageMeta(key, title, desc) {
  const cfg = PAGE_META[key];
  if (!cfg) throw new Error(`unknown page: ${key}`);
  const label = `${cfg.label} (${cfg.file})`;
  await setMainLayoutMeta(join(PAGES, cfg.file), title, desc, label);
  return [`src/pages/${cfg.file}`];
}

async function fileExists(p) {
  try { await readFile(p); return true; } catch { return false; }
}

// Move one page file between src/pages/ and src/pages-disabled/. rename()
// overwrites an existing destination on both platforms, which is what we want:
// the copy being moved is always the newer, current-brand one.
async function movePageFile(file, from, to) {
  await mkdir(to, { recursive: true });
  await rename(join(from, file), join(to, file));
}

// Scaffold a brand-new preset page. Title/Meta are OPTIONAL: blank is fine —
// the tool has no AI to "write" copy, so a blank new page gets safe default
// Title/Meta (just enough to build with non-empty SEO) and a ContentBox body
// holding a 1-paragraph placeholder. Claude writes the real Title/Meta AND the
// real ~1-paragraph article at rebrand time (SKILL.md Phase 4.5).
async function scaffoldPage(cfg, page, title, desc) {
  const label = `${page.navLabel} (${page.file})`;
  const t = title?.trim() ? validateText(title, `Title ${label}`) : cfg.boxTitle;
  const d = desc?.trim() ? validateText(desc, `Meta ${label}`) : `หน้า${page.navLabel} (อยู่ระหว่างจัดทำเนื้อหา)`;
  const canonical = await readFile(join(PAGES, CANONICAL_PAGE), "utf8");
  const fm = canonical.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) throw new Error(`ไม่พบ frontmatter ใน ${CANONICAL_PAGE} (ต้นแบบหน้าย่อย)`);
  const src =
    `---\n${fm[1]}\n---\n\n` +
    `<MainLayout title="${t}" description="${d}">\n` +
    `  <Announcement />\n\n` +
    `  <ContentBox title="${cfg.boxTitle}">\n` +
    `    <!-- TODO(rebrand): เขียนบทความจริงของ "${page.navLabel}" ~1 ย่อหน้าใน <ContentBox> นี้ + ตั้ง title/description บน <MainLayout> จาก content.docx ตอนรีแบรนด์ -->\n` +
    `    <p class="py-6 text-center text-white/70">อยู่ระหว่างปรับปรุงเนื้อหา</p>\n` +
    `  </ContentBox>\n\n` +
    `  <Navfoot />\n` +
    `</MainLayout>\n`;
  await writeFile(join(PAGES, page.file), src);
}

// Toggle ON: make every page of a preset live in src/pages/. Three cases per
// file — already live (only refresh Title/Meta, NEVER the body), parked in
// src/pages-disabled/ by a previous brand (move it back), or absent entirely
// (scaffold it, if this preset is scaffoldable). Title/Meta are refreshed only
// when BOTH were supplied; blank = leave the existing page untouched.
async function enablePreset(key, title, desc) {
  const cfg = PRESET_PAGES[key];
  if (!cfg) throw new Error(`ไม่รู้จักหน้า preset: ${key}`);
  const written = [];
  let created = false;
  let restored = false;
  for (const page of cfg.pages) {
    const live = join(PAGES, page.file);
    const parked = join(PAGES_DISABLED, page.file);
    if (await fileExists(live)) {
      // already on
    } else if (await fileExists(parked)) {
      await movePageFile(page.file, PAGES_DISABLED, PAGES);
      restored = true;
    } else if (cfg.boxTitle) {
      await scaffoldPage(cfg, page, title, desc);
      created = true;
      written.push(`src/pages/${page.file}`);
      continue; // freshly scaffolded: its Title/Meta are already what was asked for
    } else {
      throw new Error(`ไม่พบ ${page.file} ทั้งใน src/pages และ src/pages-disabled — เปิดหน้านี้ไม่ได้`);
    }
    if (cfg.boxTitle && title?.trim() && desc?.trim()) {
      await setMainLayoutMeta(live, title, desc, `${page.navLabel} (${page.file})`);
    }
    written.push(`src/pages/${page.file}`);
  }
  return { written, created, restored };
}

// Toggle OFF: park every page of a preset in src/pages-disabled/ so it stops
// being a route. Idempotent — a preset that is already off writes nothing.
async function disablePreset(key) {
  const cfg = PRESET_PAGES[key];
  if (!cfg) throw new Error(`ไม่รู้จักหน้า preset: ${key}`);
  const written = [];
  for (const page of cfg.pages) {
    if (!(await fileExists(join(PAGES, page.file)))) continue;
    await movePageFile(page.file, PAGES, PAGES_DISABLED);
    written.push(`src/pages-disabled/${page.file}`);
  }
  return { written, moved: written.length };
}

// Resolve the chrome file MainLayout currently imports (it rotates each
// rebrand, so never hardcode a name). `which` is "Navbar" or "Footer".
async function activeChromeFile(which) {
  const ml = await readFile(join(ROOT, "src", "layouts", "MainLayout.astro"), "utf8");
  const m = ml.match(which === "Footer" ? FOOTER_IMPORT_RE : NAV_IMPORT_RE);
  if (!m) return null;
  return { name: m[1], path: join(ROOT, "src", "components", m[1]) };
}

// Escape a route for use inside a RegExp (Thai routes have no metacharacters
// today, but a future "/faq?" would silently break the match).
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Best-effort: add a { name, path } entry to the ACTIVE navbar's link arrays.
// Handles both shapes this repo uses — an inline `[ {…path…} ].map(` array and
// a `const links = [ … ];` array rendered later (desktop + mobile alike).
// Idempotent — skips if the route is already linked. If the navbar variant
// matches neither shape, it writes nothing and returns a warning telling the
// operator/Claude to wire the link by hand.
async function addNavLink(route, label) {
  const nav = await activeChromeFile("Navbar");
  if (!nav) return { warning: `หา import Navbar ใน MainLayout.astro ไม่เจอ — เพิ่มลิงก์ ${route} (${label}) ในเมนูเองตอนรีแบรนด์` };
  let src;
  try { src = await readFile(nav.path, "utf8"); }
  catch { return { navFile: nav.name, warning: `เปิด navbar ${nav.name} ไม่ได้ — เพิ่มลิงก์ ${route} (${label}) ในเมนูเองตอนรีแบรนด์` }; }
  if (src.includes(`path: "${route}"`) || src.includes(`path: '${route}'`)) {
    return { navFile: nav.name, already: true };
  }
  // Match the LAST object before the array closes; `[^{}]*` keeps the match to a
  // single object. Rebuild it (normalising its trailing comma) and append the
  // new sibling right after it, at the same indentation.
  const re = /(\n([ \t]*))(\{[^{}]*\bpath:\s*["'][^"']*["'][^{}]*\}),?(\s*\](?:\.map\(|;|\s*\n))/g;
  let count = 0;
  const next = src.replace(re, (_full, lead, _indent, lastObj, tail) => {
    count++;
    // Siblings in some navbars carry an `icon:`; a missing one renders as
    // nothing, but a neutral glyph keeps the menu visually consistent.
    const item = /\bicon:/.test(lastObj)
      ? `{ name: "${label}", path: "${route}", icon: "📄" }`
      : `{ name: "${label}", path: "${route}" }`;
    return `${lead}${lastObj},${lead}${item},${tail}`;
  });
  if (count === 0) {
    return { navFile: nav.name, warning: `navbar ${nav.name} ไม่ตรงรูปแบบ array ที่รองรับ — เพิ่มลิงก์ ${route} (${label}) ในเมนูเองตอนรีแบรนด์` };
  }
  await writeFile(nav.path, next);
  return { navFile: nav.name, inserted: count };
}

// Enabling only writes the navbar link: footer link markup is per-theme (an
// `<li><a>` with the footer's own classes and a "&gt;" prefix in some variants),
// so the tool reports the gap instead of generating markup it can't theme. The
// rebrand rewrites the footer anyway — this warning is what tells it to include
// the route in the link list.
async function checkFooterLink(route, label) {
  const footer = await activeChromeFile("Footer");
  if (!footer) return `หา import Footer ใน MainLayout.astro ไม่เจอ — ตรวจลิงก์ ${route} ใน footer เองตอนรีแบรนด์`;
  let src;
  try { src = await readFile(footer.path, "utf8"); }
  catch { return `เปิด footer ${footer.name} ไม่ได้ — ตรวจลิงก์ ${route} เองตอนรีแบรนด์`; }
  if (src.includes(`href="${route}"`) || src.includes(`href='${route}'`)) return null;
  return `footer ${footer.name} ยังไม่มีลิงก์ ${route} (${label}) — เพิ่มในรายการลิงก์ของ footer ตอนรีแบรนด์`;
}

// Best-effort inverse of addNavLink: strip a route from the ACTIVE navbar AND
// the ACTIVE footer. The footer matters because the *Huay footer carries its
// own /ตรวจหวย and /แนวทาง <li> links under "ทางลัดหน้าเว็บ" — the easiest
// stale link to miss, since the navbar is the obvious place to look. Only the
// two active files are touched; links inside inventory variants are dormant and
// stay as they are. Removing a link the file doesn't have is a no-op.
async function removeNavLink(route) {
  const out = { removed: 0, warnings: [] };
  const navObj = new RegExp(`\\n[ \\t]*\\{[^{}]*\\bpath:\\s*["']${escRe(route)}["'][^{}]*\\},?`, "g");
  const footerLi = new RegExp(`\\n[ \\t]*<li>[^\\n]*href="${escRe(route)}"[^\\n]*</li>`, "g");
  for (const [which, re] of [["Navbar", navObj], ["Footer", footerLi]]) {
    const chrome = await activeChromeFile(which);
    if (!chrome) { out.warnings.push(`หา import ${which} ใน MainLayout.astro ไม่เจอ — ลบลิงก์ ${route} เองตอนรีแบรนด์`); continue; }
    let src;
    try { src = await readFile(chrome.path, "utf8"); }
    catch { out.warnings.push(`เปิด ${chrome.name} ไม่ได้ — ลบลิงก์ ${route} เองตอนรีแบรนด์`); continue; }
    const next = src.replace(re, "");
    if (next === src) {
      // Still mentioned but in a shape we don't rewrite → tell a human.
      if (src.includes(route)) out.warnings.push(`${chrome.name} ยังอ้างถึง ${route} ในรูปแบบที่เครื่องมือลบให้ไม่ได้ — ลบเองตอนรีแบรนด์`);
      continue;
    }
    await writeFile(chrome.path, next);
    out.removed++;
    out.files = [...(out.files || []), chrome.name];
  }
  return out;
}

// Read the current state of each preset so the UI can set its toggle: live in
// src/pages (on + prefilled Title/Meta), parked in src/pages-disabled (off, but
// badge it as "จะย้ายกลับมา" rather than "จะสร้างใหม่"), or absent entirely.
// A multi-page preset counts as on when ANY of its files is live — a half-on
// state is exactly what the operator needs to see and fix.
async function readCurrentNewPages() {
  const out = {};
  for (const [key, cfg] of Object.entries(PRESET_PAGES)) {
    const entry = {
      label: cfg.label,
      files: cfg.pages.map((p) => `src/pages/${p.file}`),
      routes: cfg.pages.map((p) => p.route),
      canScaffold: !!cfg.boxTitle,
      exists: false,
      parked: false,
      title: "",
      meta: "",
    };
    for (const page of cfg.pages) {
      const live = await fileExists(join(PAGES, page.file));
      if (live) entry.exists = true;
      else if (await fileExists(join(PAGES_DISABLED, page.file))) entry.parked = true;
    }
    if (entry.exists && cfg.boxTitle) {
      const src = await readFile(join(PAGES, cfg.pages[0].file), "utf8");
      entry.title = src.match(ML_TITLE_RE)?.[0]?.match(/"([^"]*)"$/)?.[1] || "";
      entry.meta = src.match(ML_DESC_RE)?.[0]?.match(/description=("|')([^"']*)\1/)?.[2] || "";
    }
    out[key] = entry;
  }
  return out;
}

// palette.json is a side effect of an image upload, not its point — fold it
// into the "written" list only when the measurement actually succeeded.
const withPalette = (name) => (name ? [name] : []);

async function handleUpload(slot, index, ext, buf) {
  const n = Number(index);
  switch (slot) {
    case "logo": {
      // One upload, both destinations: src/assets/logo.webp for the component
      // imports and public/logo.webp for the absolute og/schema logo URL. They
      // must stay identical, so there is no separate "public logo" field.
      const name = await toWebp(buf, ASSETS, "logo");
      await toWebp(buf, PUBLIC, "logo");
      return ["src/assets/" + name, "public/" + name, ...withPalette(await updatePalette(name, buf))];
    }
    case "docx": {
      await writeFile(join(ASSETS, "content.docx"), buf);
      // Also drop the plain text next to it: the rebrand's first step is reading
      // the brief, and one Read beats unzipping the docx by hand every time.
      // Best-effort — a docx we can't parse still uploads fine.
      const written = ["content.docx"];
      try {
        const lines = docxToLines(extractZipEntry(buf, "word/document.xml").toString("utf8"));
        await writeFile(join(ASSETS, "content.txt"), lines.join("\n") + "\n", "utf8");
        written.push(`content.txt (${lines.length} ย่อหน้า)`);
      } catch (err) {
        console.warn(`[uploader] content.txt: ${err.message}`);
      }
      return written;
    }
    case "banner": {
      if (!(n >= 1 && n <= 4)) throw new Error("banner index must be 1-4");
      const name = await toPng(buf, ASSETS, `banner${n}`);
      return [name, ...withPalette(await updatePalette(name, buf))];
    }
    case "slide": {
      if (!(n >= 1 && n <= 4)) throw new Error("slide index must be 1-4");
      const name = await toPng(buf, ASSETS, `slide${n}`, { box: SLIDE_BOX });
      return [name, ...withPalette(await updatePalette(name, buf))];
    }
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

// ── Build: npm run build → dist/ ────────────────────────────────────────────
// The site ships by uploading dist/ to Cloudflare by hand, so the tool stops at
// producing that folder. It runs the project's OWN build script — nothing
// bespoke — because `npm run build` (astro check + build) is this repo's
// definition of done, and streams the output back so a failed build is read
// here instead of in a terminal nobody opened.
// One at a time: two concurrent `astro build` runs share one dist/ and would
// interleave their writes into a folder someone is about to upload.
let buildRunning = false;

const fmtBytes = (n) =>
  n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

async function distStats(dir = DIST) {
  let files = 0, bytes = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { files: 0, bytes: 0, exists: false };
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const s = await distStats(p);
      files += s.files;
      bytes += s.bytes;
    } else {
      files++;
      try { bytes += (await stat(p)).size; } catch { /* vanished mid-walk */ }
    }
  }
  return { files, bytes, exists: true };
}

// State for the card's resting label: is there a dist/ on disk, and how fresh?
// dist/index.html is what Astro rewrites on every build, so its mtime is the
// build time even when a folder mtime wouldn't move.
async function readDistStatus() {
  const s = await distStats();
  let builtAt = null;
  try { builtAt = (await stat(join(DIST, "index.html"))).mtime.toISOString(); } catch { /* never built */ }
  return { ...s, builtAt, path: DIST, running: buildRunning };
}

// FORCE_COLOR=0 covers most of it, but vite/astro still emit a few cursor codes.
// Built from a charcode so the ESC byte never has to survive an editor round-trip.
const ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]", "g");
const stripAnsi = (s) => s.replace(ANSI_RE, "");

// Stream the build as NDJSON: one {line} per output line, then a final
// {done,ok,...}. A plain buffered response would leave the UI blank for the
// ~30s a build takes, which is exactly when an operator starts clicking again.
function streamBuild(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  // Writing to a socket the operator already closed (tab shut mid-build) would
  // throw ERR_STREAM_DESTROYED out of a child 'data' handler and take the whole
  // uploader down — the build outlives the reader on purpose, so every write is
  // conditional and the response's own errors are swallowed.
  res.on("error", (err) => console.warn(`[uploader] build stream: ${err.message}`));
  const alive = () => !res.destroyed && !res.writableEnded;
  const send = (obj) => { if (alive()) res.write(JSON.stringify(obj) + "\n"); };
  const startedAt = Date.now();
  let finished = false;
  const finish = async (ok, code, error) => {
    if (finished) return;
    finished = true;
    buildRunning = false;
    const stats = ok ? await distStats() : { files: 0, bytes: 0 };
    send({
      done: true,
      ok,
      code,
      error: error || null,
      ms: Date.now() - startedAt,
      files: stats.files,
      size: fmtBytes(stats.bytes),
      path: DIST,
    });
    if (alive()) res.end();
  };

  // A .cmd shim can't be spawned without a shell on Windows (Node ≥ 20.12), and
  // every argument here is a constant — nothing operator-supplied gets in.
  const child = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: ROOT,
    shell: process.platform === "win32",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });

  let tail = "";
  const feed = (chunk) => {
    tail += chunk.toString();
    const lines = tail.split(/\r?\n/);
    tail = lines.pop();
    for (const line of lines) if (line.trim()) send({ line: stripAnsi(line) });
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.on("error", (err) => {
    send({ line: "spawn error: " + err.message });
    finish(false, null, `รัน npm ไม่ได้: ${err.message}`);
  });
  child.on("close", (code) => {
    if (tail.trim()) send({ line: stripAnsi(tail) });
    finish(code === 0, code, code === 0 ? null : `build ล้มเหลว (exit ${code})`);
  });
  // The tab closing must NOT kill the child: half of a dist/ someone is about to
  // upload is worse than an unwatched build. It finishes, buildRunning clears on
  // 'close', and the operator just re-opens the page to build again.
}

// Convenience for the "upload dist myself" workflow: pop the folder open in the
// OS file manager so it can be dragged straight into Cloudflare.
function openDistFolder() {
  const cmd = process.platform === "win32" ? "explorer.exe"
    : process.platform === "darwin" ? "open"
    : "xdg-open";
  // explorer.exe exits 1 even on success, so the result is deliberately ignored.
  const child = spawn(cmd, [DIST], { detached: true, stdio: "ignore" });
  child.on("error", (err) => console.warn(`[uploader] open dist: ${err.message}`));
  child.unref();
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
<link rel="icon" href="data:," />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<!-- Google Sans ครอบคลุม latin + thai; display=swap ทำให้ตอนออฟไลน์ตกไปใช้ฟอนต์ระบบแทนได้เลย -->
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Google+Sans:wght@400;500;700&display=swap" />
<style>
  :root {
    color-scheme: dark;
    --bg: #0d1124;
    --panel: #151b33;
    --card-a: #1c2444;
    --card-b: #161d36;
    --line: #2d3760;
    --line-soft: #232b4b;
    --ink: #eef2ff;
    --muted: #a6b1d2;
    --faint: #7885ac;
    --sky: #7dd3fc;
    --lav: #a5b4fc;
    --teal: #5eead4;
    --accent: #7dd3fc;
    --grad: linear-gradient(135deg, #5eead4 0%, #7dd3fc 52%, #a5b4fc 100%);
    --ok: #86efac;
    --err: #fda4af;
    --radius: 22px;
    --font-sans: "Google Sans", "Segoe UI", system-ui, -apple-system, sans-serif;
  }
  * { box-sizing: border-box; }
  /* the UA's [hidden] rule is weaker than any class rule that sets display —
     .ghost { display: inline-flex } was overriding it and showing the modal's
     close button mid-run. Make hidden mean hidden, whatever else matches. */
  [hidden] { display: none !important; }
  html, body { overflow-x: hidden; }
  body {
    font-family: var(--font-sans);
    margin: 0; color: var(--ink); min-height: 100vh;
    background:
      radial-gradient(820px 460px at 88% -6%, rgba(165,180,252,0.15), transparent 62%),
      radial-gradient(760px 440px at 4% 0%, rgba(125,211,252,0.15), transparent 58%),
      radial-gradient(700px 520px at 50% 108%, rgba(94,234,212,0.10), transparent 60%),
      var(--bg);
    background-attachment: fixed;
  }

  /* ── header ─────────────────────────────────────────── */
  header {
    position: sticky; top: 0; z-index: 20;
    padding: 15px 26px;
    background: rgba(13,17,36,0.74);
    backdrop-filter: blur(16px);
    border-bottom: 1px solid var(--line-soft);
  }
  header h1 {
    margin: 0; font-size: 21px; font-weight: 800; letter-spacing: -0.02em;
    display: flex; align-items: center; gap: 12px;
  }
  header h1 .mark {
    width: 36px; height: 36px; border-radius: 13px; flex: none;
    background: var(--grad); display: grid; place-items: center;
    font-size: 19px; box-shadow: 0 10px 22px -8px rgba(125,211,252,0.7);
    animation: bob 3.4s ease-in-out infinite;
  }
  @keyframes bob { 0%,100% { transform: translateY(0) rotate(-3deg); } 50% { transform: translateY(-3px) rotate(3deg); } }
  @media (prefers-reduced-motion: reduce) { header h1 .mark { animation: none; } }
  header h1 .grad-text {
    background: var(--grad); -webkit-background-clip: text; background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  header code { background: rgba(166,177,210,0.14); padding: 1px 6px; border-radius: 6px; font-size: 11.5px; color: #d5ddf5; }

  /* ── layout: 3 flex columns, cards stack inside each ──────────────────────
     Column A holds the long file card; B the settings + SEO stack; C the
     rebrand-prompt card, which is sticky so it stays on screen no matter how
     far column A scrolls (the whole point: no hunting for it at the bottom). */
  main {
    counter-reset: card;
    display: flex; flex-wrap: wrap; align-items: flex-start;
    gap: 18px; padding: 22px 26px 120px; margin: 0;
  }
  .col { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
  .col-a { flex: 1.06 1 360px; }
  .col-b { flex: 1 1 340px; }
  .col-c { flex: 0.92 1 300px; position: sticky; top: 84px; }
  @media (max-width: 900px) {
    /* one column: flex-basis would become a HEIGHT here and align-items
       flex-start would shrink each column to its content width — so pin the
       columns to full width and let them size by content. */
    main { flex-direction: column; align-items: stretch; padding: 18px 14px 120px; }
    .col { flex: 0 0 auto; width: 100%; }
    .col-c { position: static; }
    header { padding: 14px 16px; }
  }

  /* ── card ───────────────────────────────────────────── */
  .card {
    counter-increment: card;
    position: relative; isolation: isolate; overflow: hidden;
    background: linear-gradient(180deg, var(--card-a), var(--card-b));
    border: 1px solid var(--line); border-radius: var(--radius);
    padding: 20px 20px 18px;
    box-shadow: 0 16px 40px -26px rgba(0,0,0,0.9);
    transition: border-color .18s ease, box-shadow .18s ease, transform .18s ease;
  }
  .card::before {
    content: ""; position: absolute; inset: 0 0 auto 0; height: 4px;
    background: var(--grad); opacity: .95;
  }
  .card::after {
    content: ""; position: absolute; z-index: -1; top: -70px; right: -60px;
    width: 190px; height: 190px; border-radius: 50%;
    background: radial-gradient(circle, rgba(125,211,252,0.18), transparent 68%);
    filter: blur(6px); pointer-events: none;
  }
  .card:hover { border-color: #3d4a7d; transform: translateY(-2px); box-shadow: 0 26px 52px -26px rgba(0,0,0,0.95); }
  .card h2 {
    margin: 0 0 6px; font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em;
    display: flex; align-items: center; gap: 10px;
  }
  .card h2::before {
    content: counter(card); flex: none;
    width: 26px; height: 26px; border-radius: 10px;
    display: grid; place-items: center;
    background: var(--grad); color: #101736; font-weight: 800; font-size: 13px;
    box-shadow: 0 6px 14px -5px rgba(125,211,252,0.6);
  }
  .card h2 .emo { font-size: 15px; }
  .card > .sub { margin: 0 0 12px; padding-left: 36px; font-size: 11.5px; color: var(--muted); line-height: 1.55; }

  /* group inside a merged card */
  .group { margin-top: 14px; padding-top: 13px; border-top: 1px dashed var(--line); }
  .group:first-of-type { margin-top: 4px; padding-top: 0; border-top: 0; }
  .group > h3 {
    margin: 0 0 2px; font-size: 12.5px; font-weight: 700; color: #d7deff;
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  }
  .group > .note { margin: 3px 0 0; font-size: 11px; color: var(--faint); line-height: 1.55; }

  /* ── fields ─────────────────────────────────────────── */
  .field { display: flex; flex-direction: column; gap: 6px; padding: 11px 0; border-top: 1px solid var(--line-soft); }
  .field:first-of-type { border-top: 0; padding-top: 4px; }
  .group .field:first-of-type { border-top: 0; }
  .field .row { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; }
  .field label { font-size: 13px; font-weight: 600; color: #dee5fb; }
  .field .target {
    font-size: 10px; color: var(--sky); font-family: ui-monospace, monospace;
    background: rgba(125,211,252,0.09); border: 1px solid rgba(125,211,252,0.22);
    padding: 2px 8px; border-radius: 999px;
  }
  .field .opt {
    font-size: 9.5px; color: var(--faint); font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
    background: rgba(166,177,210,0.1); padding: 2px 8px; border-radius: 999px;
  }

  /* inputs — unified look */
  /* form controls ไม่ inherit font-family เอง ต้องสั่งตรงๆ ไม่งั้น input/button/select
     จะยังเป็นฟอนต์ default ของ browser อยู่ ตัวที่ตั้งใจให้เป็น mono ตั้งทับไว้ข้างล่างแล้ว */
  button, input, select, textarea { font-family: inherit; }
  .field input[type=file] { font-size: 11.5px; color: var(--muted); max-width: 100%; }
  input[type=file]::file-selector-button {
    font: inherit; font-weight: 700; font-size: 11.5px; cursor: pointer; margin-right: 9px;
    color: #101736; background: var(--grad);
    border: 0; border-radius: 999px; padding: 7px 14px;
    transition: filter .15s, transform .12s;
  }
  input[type=file]::file-selector-button:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .field input.linkinput, .field .metatitle, .field .metadesc {
    width: 100%; font-size: 12.5px; color: var(--ink);
    background: var(--panel); border: 1px solid var(--line); border-radius: 13px; padding: 9px 12px;
    transition: border-color .15s, box-shadow .15s;
  }
  .field input.linkinput { font-family: ui-monospace, monospace; }
  .field .metadesc { resize: vertical; font-family: var(--font-sans); line-height: 1.5; }
  .field input.linkinput:focus, .field .metatitle:focus, .field .metadesc:focus,
  .panel input:focus, .panel select:focus {
    outline: none; border-color: var(--sky); box-shadow: 0 0 0 3px rgba(125,211,252,0.2);
  }
  .field .status { font-size: 11px; min-height: 14px; color: var(--muted); line-height: 1.5; }
  .field .status code { background: rgba(166,177,210,0.12); padding: 1px 5px; border-radius: 5px; }

  /* compact image tiles (banners + slides) — keeps card 1 from running long */
  .tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 9px; padding-top: 11px; }
  .tiles .field {
    padding: 10px 11px; gap: 7px;
    border: 1px solid var(--line-soft); border-radius: 15px;
    background: rgba(125,211,252,0.03);
    transition: border-color .15s, background .15s;
  }
  .tiles .field:hover { border-color: var(--line); background: rgba(125,211,252,0.07); }
  .tiles .field label { font-size: 12px; }
  .tiles .field .row { gap: 7px; }
  .tiles .field .status { font-size: 10px; min-height: 0; }
  /* hide the long native filename inside a narrow tile; the thumb shows the pick */
  .tiles input[type=file] { font-size: 0; width: 100%; }
  .tiles input[type=file]::file-selector-button { font-size: 11px; padding: 6px 12px; margin-right: 0; }
  .tiles .thumb { width: 34px; height: 34px; }

  /* toggle switch + state badge (optional pages) */
  .switch { position: relative; display: inline-flex; width: 42px; height: 24px; flex: none; cursor: pointer; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .switch .slider { position: absolute; inset: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 999px; transition: .18s; }
  .switch .slider::before { content: ""; position: absolute; width: 16px; height: 16px; left: 3px; top: 3px; background: var(--faint); border-radius: 50%; transition: .18s; }
  .switch input:checked + .slider { background: rgba(125,211,252,0.18); border-color: var(--sky); }
  .switch input:checked + .slider::before { transform: translateX(18px); background: var(--grad); }
  .switch input:focus-visible + .slider { box-shadow: 0 0 0 3px rgba(125,211,252,0.22); }
  .badge { font-size: 9.5px; font-weight: 700; padding: 3px 9px; border-radius: 999px; line-height: 1.35; }
  .badge.new { color: var(--muted); background: rgba(166,177,210,0.1); border: 1px solid var(--line); }
  .badge.exists { color: var(--teal); background: rgba(94,234,212,0.12); border: 1px solid rgba(94,234,212,0.3); }
  .np-body { display: flex; flex-direction: column; gap: 6px; margin-top: 7px; }
  .np-body[hidden] { display: none; }

  .thumb { width: 42px; height: 42px; object-fit: contain; border-radius: 12px; background: var(--panel); border: 1px solid var(--line); display: none; }
  .thumb.show { display: block; }

  /* background mode chips + panels */
  .modes { flex-wrap: wrap; gap: 6px; }
  .modes label {
    display: flex; align-items: center; gap: 6px; font-size: 11.5px; font-weight: 600; cursor: pointer;
    padding: 6px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel);
    transition: all .15s;
  }
  .modes label:has(input:checked) { border-color: var(--sky); color: var(--sky); background: rgba(125,211,252,0.12); box-shadow: 0 0 0 3px rgba(125,211,252,0.14); }
  .modes input { accent-color: var(--sky); margin: 0; }
  .panel[hidden] { display: none; }
  .panel { flex-wrap: wrap; gap: 8px; }
  .panel input[type=color] { width: 38px; height: 32px; padding: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); cursor: pointer; }
  .panel input[type=text] { width: 90px; font-family: ui-monospace, monospace; font-size: 11.5px; text-transform: lowercase; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 7px 9px; }
  .panel select { font-size: 11.5px; background: var(--panel); color: var(--ink); border: 1px solid var(--line); border-radius: 10px; padding: 7px 9px; }
  .panel .hint { font-size: 10.5px; color: var(--faint); align-self: center; }
  #bgPreview { width: 100%; height: 52px; border-radius: 13px; border: 1px solid var(--line); }

  /* ghost button (pull-from-docx / copy) */
  button.ghost {
    background: var(--panel); color: var(--sky); border: 1px solid var(--line);
    padding: 8px 15px; font-size: 12px; font-weight: 700; border-radius: 999px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 7px; transition: all .15s;
  }
  button.ghost:hover { background: rgba(125,211,252,0.12); border-color: var(--sky); transform: translateY(-1px); }
  .pull-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 2px 0 10px; padding-bottom: 12px; border-bottom: 1px dashed var(--line); }
  .pull-hint { flex: 1 1 180px; min-width: 0; font-size: 10.5px; color: var(--faint); line-height: 1.5; }
  /* the 4 sub-page SEO slots sit two-up so this card stays about as tall as
     its neighbours — the whole point of the 3-column layout is that nothing
     forces a scroll to reach the card next to it. */
  .seo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(204px, 1fr)); gap: 9px; }
  .seo-grid .field { padding: 10px 11px; border: 1px solid var(--line-soft); border-radius: 15px; background: rgba(125,211,252,0.03); }
  .seo-grid .field:hover { border-color: var(--line); background: rgba(125,211,252,0.07); }

  /* ── build card ─────────────────────────────────────── */
  button.solid {
    background: var(--grad); color: #101736; border: 0;
    box-shadow: 0 10px 22px -10px rgba(125,211,252,0.6);
  }
  button.solid:hover { background: var(--grad); filter: brightness(1.07); border: 0; }
  button.ghost:disabled, button.solid:disabled { opacity: .5; cursor: progress; transform: none; filter: none; }
  .buildout {
    margin-top: 8px; max-height: 168px; overflow: auto;
    background: rgba(7,10,22,0.5); border: 1px solid var(--line-soft); border-radius: 13px;
    padding: 9px 11px; font-family: ui-monospace, monospace; font-size: 10.5px; line-height: 1.65;
    color: var(--muted); white-space: pre-wrap; word-break: break-word;
  }
  .buildout[hidden] { display: none; }
  .buildout div.err { color: var(--err); }
  .buildout div.done { color: var(--ok); font-weight: 700; }
  .buildout::-webkit-scrollbar { width: 8px; }
  .buildout::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }

  /* ── upload modal ───────────────────────────────────── */
  .modal {
    position: fixed; inset: 0; z-index: 40; display: grid; place-items: center; padding: 20px;
    background: rgba(7,10,22,0.68); backdrop-filter: blur(7px); animation: fadein .16s ease;
  }
  .modal[hidden] { display: none; }
  @keyframes fadein { from { opacity: 0; } to { opacity: 1; } }
  .sheet {
    position: relative; overflow: hidden; width: min(460px, 100%); text-align: center;
    background: linear-gradient(180deg, var(--card-a), var(--card-b));
    border: 1px solid var(--line); border-radius: 24px; padding: 26px 24px 22px;
    box-shadow: 0 32px 70px -30px rgba(0,0,0,0.95);
    animation: pop .22s cubic-bezier(.2,.9,.3,1.25);
  }
  .sheet::before { content: ""; position: absolute; inset: 0 0 auto 0; height: 4px; background: var(--grad); }
  @keyframes pop { from { transform: translateY(10px) scale(.96); opacity: 0; } to { transform: none; opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .modal, .sheet { animation: none; } }
  .spin {
    width: 48px; height: 48px; margin: 6px auto 13px; border-radius: 50%;
    border: 3px solid rgba(166,177,210,0.18); border-top-color: var(--sky); border-right-color: var(--teal);
    animation: spin .8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sheet.done .spin, .sheet.fail .spin {
    animation: none; border: 0; display: grid; place-items: center;
    font-size: 25px; font-weight: 800; color: #101736;
  }
  .sheet.done .spin { background: var(--grad); }
  .sheet.done .spin::after { content: "✓"; }
  .sheet.fail .spin { background: rgba(253,164,175,0.16); color: var(--err); border: 1px solid rgba(253,164,175,0.4); }
  .sheet.fail .spin::after { content: "!"; }
  .sheet h3 { margin: 0 0 4px; font-size: 17px; font-weight: 800; letter-spacing: -0.01em; }
  .upsub { margin: 0 0 14px; font-size: 11.5px; color: var(--muted); line-height: 1.55; }
  .upbar { height: 5px; border-radius: 999px; background: rgba(166,177,210,0.14); overflow: hidden; }
  .upbar span { display: block; height: 100%; width: 38%; border-radius: 999px; background: var(--grad); animation: slidebar 1.1s ease-in-out infinite; }
  @keyframes slidebar { from { transform: translateX(-110%); } to { transform: translateX(300%); } }
  .sheet.done .upbar span, .sheet.fail .upbar span { animation: none; width: 100%; transform: none; }
  .sheet.fail .upbar span { background: var(--err); }
  .uplist {
    margin-top: 13px; max-height: 190px; overflow: auto; text-align: left;
    font-family: ui-monospace, monospace; font-size: 11px; line-height: 1.7;
  }
  .uplist div.ok { color: var(--ok); }
  .uplist div.err { color: var(--err); }
  .uplist::-webkit-scrollbar { width: 8px; }
  .uplist::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }
  #upClose { margin-top: 14px; }

  /* ── sticky action bar ──────────────────────────────── */
  .bar {
    position: sticky; bottom: 0; z-index: 15;
    background: rgba(13,17,36,0.85); backdrop-filter: blur(16px);
    border-top: 1px solid var(--line-soft);
    box-shadow: 0 -10px 30px -14px rgba(0,0,0,0.7);
    padding: 13px 26px; display: flex; align-items: center; gap: 16px;
  }
  #uploadAll {
    background: var(--grad); color: #101736; border: 0;
    padding: 12px 26px; font-size: 14.5px; font-weight: 800; border-radius: 999px; cursor: pointer;
    box-shadow: 0 12px 26px -10px rgba(125,211,252,0.6); transition: transform .12s, filter .15s, box-shadow .15s;
    flex: none; letter-spacing: .01em;
  }
  #uploadAll:hover { filter: brightness(1.07); transform: translateY(-2px); box-shadow: 0 16px 32px -10px rgba(94,234,212,0.55); }
  #uploadAll:active { transform: translateY(0); }
  #log { flex: 1; font-size: 11px; font-family: ui-monospace, monospace; max-height: 84px; overflow: auto; line-height: 1.7; }
  #log div.ok { color: var(--ok); }
  #log div.err { color: var(--err); }
  #log::-webkit-scrollbar { width: 8px; }
  #log::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; }
</style>
</head>
<body>
<header>
  <div class="head-inner">
    <h1><span class="mark">🧁</span> <span class="grad-text">Rebrand Asset Uploader</span></h1>
  </div>
</header>
<main>
  <div class="col col-a">
  <section class="card" id="cardFiles">
    <h2><span class="emo">🎨</span> ไฟล์แบรนด์ · src/assets</h2>
    <p class="sub">โลโก้ / เนื้อหา (docx) / พื้นหลัง (รูป หรือ สี/ไล่สี) / แบนเนอร์ / รูป promotion + carousel</p>
    <div class="field" data-img>
      <div class="row"><label>Logo</label><span class="target">src/assets/logo.webp + public/logo.webp</span></div>
      <div class="row"><input type="file" accept="image/*" data-slot="logo" /><img class="thumb" /></div>
      <span class="status">อัพครั้งเดียว เซฟลงทั้ง src/assets และ public ให้อัตโนมัติ</span>
    </div>
    <div class="field">
      <div class="row"><label>Content brief</label><span class="target">content.docx</span></div>
      <div class="row"><input type="file" accept=".docx" data-slot="docx" /></div>
      <span class="status"></span>
    </div>
    <div class="field" id="bgField" data-img>
      <div class="row"><label>Background</label><span class="target">bg.png</span><span class="opt">เลือกอย่างใดอย่างหนึ่ง</span></div>
      <div class="row modes">
        <label><input type="radio" name="bgmode" value="image" checked /> รูปภาพ</label>
        <label><input type="radio" name="bgmode" value="color" /> สีเดียว</label>
        <label><input type="radio" name="bgmode" value="gradient" /> ไล่สี (gradient)</label>
      </div>
      <div class="row panel" data-mode="image">
        <input type="file" accept="image/*" data-slot="bg" id="bgFile" /><img class="thumb" />
      </div>
      <div class="row panel" data-mode="color" hidden>
        <input type="color" id="bgColor" value="#0f172a" />
        <input type="text" id="bgColorHex" value="#0f172a" spellcheck="false" />
        <span class="hint">ใช้เป็น CSS สีเดียว — ไม่โหลดรูป</span>
      </div>
      <div class="row panel" data-mode="gradient" hidden>
        <input type="color" id="bgFrom" value="#0f172a" />
        <input type="text" id="bgFromHex" value="#0f172a" spellcheck="false" />
        <input type="color" id="bgTo" value="#1e3a8a" />
        <input type="text" id="bgToHex" value="#1e3a8a" spellcheck="false" />
        <select id="bgType">
          <option value="linear">เส้นตรง</option>
          <option value="radial">รัศมี (radial)</option>
        </select>
        <select id="bgAngle">
          <option value="180" selected>บน → ล่าง</option>
          <option value="0">ล่าง → บน</option>
          <option value="90">ซ้าย → ขวา</option>
          <option value="270">ขวา → ซ้าย</option>
          <option value="135">ทแยง ↘</option>
          <option value="225">ทแยง ↙</option>
          <option value="45">ทแยง ↗</option>
          <option value="315">ทแยง ↖</option>
        </select>
      </div>
      <div class="row"><div id="bgPreview" hidden></div></div>
      <span class="status"></span>
    </div>
    <div class="tiles">
      <div class="field" data-img>
        <div class="row"><label>Banner 1</label><span class="target">banner1</span></div>
        <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="1" /><img class="thumb" /></div>
        <span class="status">hero</span>
      </div>
      <div class="field" data-img>
        <div class="row"><label>Banner 2</label><span class="target">banner2</span></div>
        <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="2" /><img class="thumb" /></div>
        <span class="status">รูปประกอบบทความ · optional</span>
      </div>
      <div class="field" data-img>
        <div class="row"><label>Banner 3</label><span class="target">banner3</span></div>
        <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="3" /><img class="thumb" /></div>
        <span class="status">รูปประกอบบทความ · optional</span>
      </div>
      <div class="field" data-img>
        <div class="row"><label>Banner 4</label><span class="target">banner4</span></div>
        <div class="row"><input type="file" accept="image/*" data-slot="banner" data-index="4" /><img class="thumb" /></div>
        <span class="status">รูปประกอบบทความ · optional</span>
      </div>
      <div class="field" data-img>
        <div class="row"><label>Slide 1</label><span class="target">slide1</span></div>
        <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="1" /><img class="thumb" /></div>
        <span class="status">promotion + og:image</span>
      </div>
      <div class="field" data-img>
        <div class="row"><label>Slide 2</label><span class="target">slide2</span></div>
        <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="2" /><img class="thumb" /></div>
        <span class="status">promotion + carousel</span>
      </div>
      <div class="field" data-img>
        <div class="row"><label>Slide 3</label><span class="target">slide3</span></div>
        <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="3" /><img class="thumb" /></div>
        <span class="status">promotion + carousel</span>
      </div>
      <div class="field" data-img>
        <div class="row"><label>Slide 4</label><span class="target">slide4</span></div>
        <div class="row"><input type="file" accept="image/*" data-slot="slide" data-index="4" /><img class="thumb" /></div>
        <span class="status">promotion + carousel · optional</span>
      </div>
    </div>
  </section>
  </div>

  <div class="col col-b">
  <section class="card" id="cardSetup">
    <h2><span class="emo">🧩</span> ไอคอน · ลิงก์ · หน้าเสริม</h2>
    <p class="sub">รวมของเดิมส่วนที่ 2 + 3 + 5 ไว้ที่เดียว</p>

    <div class="group">
      <h3><span class="emo">🔖</span> ไอคอนเว็บ · public</h3>
      <p class="note">อัพ favicon ใบเดียว สร้างชุดไอคอนให้ครบ — โลโก้ใน public ดึงจาก Logo การ์ดแรกให้เอง</p>
      <div class="field" data-img>
        <div class="row"><label>Favicon</label><span class="target">favicon.ico + .png set + .svg</span></div>
        <div class="row"><input type="file" accept="image/*,.svg" data-slot="favicon" /><img class="thumb" /></div>
        <span class="status"></span>
      </div>
    </div>

    <div class="group">
      <h3><span class="emo">🔗</span> ลิงก์ · aff / ไลน์</h3>
      <div class="field" id="affField">
        <div class="row"><label>ลิงก์ aff</label><span class="target">login.astro + register.astro</span></div>
        <div class="row"><input type="url" class="linkinput" id="affInput" placeholder="https://..." spellcheck="false" /></div>
        <span class="status">แก้ค่า <code>targetUrl</code> ในทั้งหน้า login และ register พร้อมกัน</span>
      </div>
      <div class="field" id="lineField">
        <div class="row"><label>ลิงก์ไลน์</label><span class="target">astro.config.mjs → "/line"</span></div>
        <div class="row"><input type="url" class="linkinput" id="lineInput" placeholder="https://..." spellcheck="false" /></div>
        <span class="status">แก้ปลายทางของ redirect <code>/line</code></span>
      </div>
    </div>

    <div class="group">
      <h3><span class="emo">🗂️</span> หน้าเสริม (เปิด/ปิดต่อแบรนด์)</h3>
  
      <div class="field newpage" data-newpage="article">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>บทความ</label>
          <span class="target">บทความ.astro</span>
          <span class="badge np-badge"></span>
        </div>
        <div class="np-body" hidden>
          <input type="text" class="metatitle" data-k="title" placeholder="Title (เว้นว่างได้ — Claude เขียนให้)" spellcheck="false" />
          <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description (เว้นว่างได้ — Claude เขียนให้)" spellcheck="false"></textarea>
        </div>
        <span class="status"></span>
      </div>
      <div class="field newpage" data-newpage="aboutus">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>เกี่ยวกับเรา</label>
          <span class="target">about-us.astro</span>
          <span class="badge np-badge"></span>
        </div>
        <div class="np-body" hidden>
          <input type="text" class="metatitle" data-k="title" placeholder="Title (เว้นว่างได้ — Claude เขียนให้)" spellcheck="false" />
          <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description (เว้นว่างได้ — Claude เขียนให้)" spellcheck="false"></textarea>
        </div>
        <span class="status"></span>
      </div>
      <div class="field newpage" data-newpage="huay">
        <div class="row">
          <label class="switch"><input type="checkbox" class="np-toggle" /><span class="slider"></span></label>
          <label>เว็บหวย</label>
          <span class="target">ตรวจหวย + แนวทาง</span>
          <span class="badge np-badge"></span>
        </div>
        <span class="status"></span>
      </div>
    </div>
  </section>

  <section class="card" id="cardSeo">
    <h2><span class="emo">🔍</span> SEO · Title / Meta หน้าย่อย</h2>
    <div class="pull-row">
      <button type="button" id="pullDocx" class="ghost">📄 ดึงจาก content.docx</button>
      <span class="pull-hint">อัพ Content brief (docx) ในการ์ดแรกก่อน แล้วค่อยกดปุ่มนี้</span>
    </div>
    <div class="seo-grid">
    <div class="field" data-page="promotion">
      <div class="row"><label>โปรโมชั่น</label><span class="target">promotion.astro</span></div>
      <input type="text" class="metatitle" data-k="title" placeholder="Title" spellcheck="false" />
      <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description" spellcheck="false"></textarea>
      <span class="status"></span>
    </div>
    <div class="field" data-page="contactus">
      <div class="row"><label>ติดต่อเรา</label><span class="target">contact-us.astro</span></div>
      <input type="text" class="metatitle" data-k="title" placeholder="Title" spellcheck="false" />
      <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description" spellcheck="false"></textarea>
      <span class="status"></span>
    </div>
    <div class="field" data-page="demo">
      <div class="row"><label>ทดลองเล่น</label><span class="target">ทดลองเล่น.astro</span></div>
      <input type="text" class="metatitle" data-k="title" placeholder="Title" spellcheck="false" />
      <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description" spellcheck="false"></textarea>
      <span class="status"></span>
    </div>
    <div class="field" data-page="entrance">
      <div class="row"><label>ทางเข้า</label><span class="target">ทางเข้า.astro</span></div>
      <input type="text" class="metatitle" data-k="title" placeholder="Title" spellcheck="false" />
      <textarea class="metadesc" data-k="desc" rows="2" placeholder="Meta description" spellcheck="false"></textarea>
      <span class="status"></span>
    </div>
    </div>
  </section>
  </div>

  <div class="col col-c">
  <section class="card" id="cardPrompt">
    <h2><span class="emo">✨</span> คำสั่ง Rebrand (ให้ Claude Code)</h2>
    <p class="sub">กรอกแล้วกด Copy → วางใน Claude Code</p>
    <div class="field">
      <div class="row"><label>ชื่อแบรนด์</label></div>
      <input type="text" class="linkinput" id="rbBrand" placeholder="เช่น PABLO666" spellcheck="false" />
    </div>
    <div class="field">
      <div class="row"><label>URL production จริง</label><span class="opt">optional</span></div>
      <input type="url" class="linkinput" id="rbUrl" placeholder="เช่น https://www.pablo666-brand.com" spellcheck="false" />
      <span class="status">ใส่เมื่อรู้โดเมนจริง — เว้นว่างได้ คำสั่งจะสั่งห้ามเปลี่ยนโดเมนเดิม</span>
    </div>
    <div class="field">
      <div class="row"><label>หมายเหตุ / variant hints</label><span class="opt">optional</span></div>
      <textarea class="metadesc" id="rbNotes" rows="2" placeholder="เช่น โทนทอง-ดำ, ใช้ NavbarPremium, เน้นหน้าโปรโมชั่น" spellcheck="false"></textarea>
    </div>
    <div class="field">
      <div class="row"><label>คำสั่งที่จะ copy</label><button type="button" id="rbCopy" class="ghost">📋 Copy</button></div>
      <textarea class="metadesc" id="rbPrompt" rows="4" readonly spellcheck="false"></textarea>
      <span class="status">flow: Copy → วางใน Claude Code → รอเสร็จ → <code>npm run preview</code> ตรวจด้วยตา → ค่อย Build</span>
    </div>
  </section>

  <section class="card" id="cardBuild">
    <h2><span class="emo">🚀</span> Build → dist</h2>
    <p class="sub">สั่ง <code>npm run build</code> จากหน้านี้ แล้วเอาโฟลเดอร์ <code>dist/</code> ไปอัพขึ้น Cloudflare เอง</p>
    <div class="field">
      <div class="row">
        <button type="button" id="buildBtn" class="ghost solid">🚀 Build</button>
        <button type="button" id="openDist" class="ghost">📂 เปิดโฟลเดอร์ dist</button>
      </div>
      <span class="status" id="buildStatus">กำลังตรวจสถานะ dist...</span>
      <div class="buildout" id="buildOut" hidden></div>
    </div>
  </section>
  </div>
</main>
<div class="bar">
  <button id="uploadAll">อัพโหลดทั้งหมด</button>
  <div id="log"></div>
</div>
<div class="modal" id="upModal" hidden>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="upTitle" aria-live="polite">
    <div class="spin" id="upSpin"></div>
    <h3 id="upTitle">กำลังอัพโหลด...</h3>
    <p class="upsub" id="upSub">กำลังเขียนไฟล์ลงโปรเจค อย่าเพิ่งปิดหน้านี้</p>
    <div class="upbar"><span></span></div>
    <div class="uplist" id="upList"></div>
    <button type="button" class="ghost" id="upClose" hidden>ปิด</button>
  </div>
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

  // ── run overlay ───────────────────────────────────────────────────────────
  // "อัพโหลดทั้งหมด" fires a dozen requests in sequence; the bar log alone made
  // it hard to tell whether a run was still going. The modal owns that state:
  // it opens on click, mirrors every log line, and closes ITSELF once the run
  // finishes clean. It deliberately stays open when something failed — an
  // auto-dismissed error is an error nobody reads.
  const modal = document.getElementById('upModal');
  const sheet = modal.querySelector('.sheet');
  const upTitle = document.getElementById('upTitle');
  const upSub = document.getElementById('upSub');
  const upList = document.getElementById('upList');
  const upClose = document.getElementById('upClose');
  let runOpen = false, runErrors = 0, runOk = 0, closeTimer = 0;

  function modalStart() {
    runOpen = true; runErrors = 0; runOk = 0;
    clearTimeout(closeTimer);
    sheet.className = 'sheet';
    upList.textContent = '';
    upTitle.textContent = 'กำลังอัพโหลด...';
    upSub.textContent = 'กำลังเขียนไฟล์ลงโปรเจค อย่าเพิ่งปิดหน้านี้';
    upClose.hidden = true;
    modal.hidden = false;
  }
  function modalClose() { clearTimeout(closeTimer); modal.hidden = true; runOpen = false; }
  function modalFinish(kind, title, sub) {
    runOpen = false;
    sheet.className = 'sheet ' + kind;
    upTitle.textContent = title;
    upSub.textContent = sub;
    if (kind === 'done') closeTimer = setTimeout(modalClose, 1600);
    else upClose.hidden = false;   // failures wait for a human
  }
  upClose.addEventListener('click', modalClose);
  modal.addEventListener('click', (e) => { if (e.target === modal && !runOpen) modalClose(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden && !runOpen) modalClose(); });

  const log = document.getElementById('log');
  function addLog(msg, ok) {
    const d = document.createElement('div'); d.className = ok ? 'ok' : 'err';
    d.textContent = (ok ? '✓ ' : '✗ ') + msg;
    log.prepend(d);
    if (!runOpen) return;
    if (ok) runOk++; else runErrors++;
    const m = d.cloneNode(true);
    upList.appendChild(m);
    upList.scrollTop = upList.scrollHeight;
  }
  // Never let a missing/renamed .status span abort an upload run: this is a
  // cosmetic sink, so a markup slip must not throw out of the click handler
  // and skip the actual fetch (that shipped once — the favicon field had no
  // .status, so picking a favicon silently uploaded nothing).
  function setStatus(inp, txt) {
    setText(inp?.closest('.field')?.querySelector('.status'), txt, inp?.dataset?.slot ?? inp);
  }
  // Same rule for every other status/badge sink in this page. A row whose
  // .status span was never added (that shipped too — the หวย row had none, so
  // "อัพโหลดทั้งหมด" threw inside sendNewPage and every image after it was
  // skipped) must degrade to a console warning, not kill the run.
  function setText(el, txt, what) {
    if (el) el.textContent = txt;
    else console.warn('[uploader] missing status/badge element for:', what ?? txt);
  }

  // ── Background: image / solid colour / gradient — pick exactly one ─────────
  const bgField = document.getElementById('bgField');
  const bgFile = document.getElementById('bgFile');
  const bgPreview = document.getElementById('bgPreview');
  const $ = (id) => document.getElementById(id);
  const bgMode = () => bgField.querySelector('input[name=bgmode]:checked').value;

  // keep each <input type=color> and its hex textbox in sync, both directions
  [['bgColor','bgColorHex'], ['bgFrom','bgFromHex'], ['bgTo','bgToHex']].forEach(([pick, text]) => {
    $(pick).addEventListener('input', () => { $(text).value = $(pick).value; drawPreview(); });
    $(text).addEventListener('input', () => {
      const v = $(text).value.trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v)) { $(pick).value = v.length === 4 ? '#' + [...v.slice(1)].map(c => c + c).join('') : v; }
      drawPreview();
    });
  });
  ['bgType','bgAngle'].forEach((id) => $(id).addEventListener('change', drawPreview));

  // The CSS here mirrors the server's SVG geometry, so this swatch is a true
  // preview of the bg.png that will be written.
  function drawPreview() {
    const mode = bgMode();
    if (mode === 'color') {
      bgPreview.hidden = false;
      bgPreview.style.background = $('bgColorHex').value.trim();
    } else if (mode === 'gradient') {
      bgPreview.hidden = false;
      const from = $('bgFromHex').value.trim(), to = $('bgToHex').value.trim();
      bgPreview.style.background = $('bgType').value === 'radial'
        ? 'radial-gradient(circle at 50% 50%, ' + from + ', ' + to + ')'
        : 'linear-gradient(' + $('bgAngle').value + 'deg, ' + from + ', ' + to + ')';
    } else {
      bgPreview.hidden = true;
    }
    $('bgAngle').hidden = $('bgType').value === 'radial';
  }

  bgField.querySelectorAll('input[name=bgmode]').forEach((r) => {
    r.addEventListener('change', () => {
      bgField.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.mode !== bgMode(); });
      drawPreview();
    });
  });
  drawPreview();

  // Builds the /upload call for whichever bg mode is active. Returns null when
  // the image mode is selected but no file was chosen (bg stays untouched).
  function bgRequest() {
    const mode = bgMode();
    if (mode === 'image') {
      if (!bgFile.files.length) return null;
      return { q: new URLSearchParams({ slot: 'bg' }), body: bgFile.files[0], label: 'bg (รูปภาพ)' };
    }
    if (mode === 'color') {
      return { q: new URLSearchParams({ slot: 'bg', color: $('bgColorHex').value.trim() }), body: null, label: 'bg (สีเดียว)' };
    }
    const q = new URLSearchParams({
      slot: 'bg',
      from: $('bgFromHex').value.trim(),
      to: $('bgToHex').value.trim(),
      type: $('bgType').value,
      angle: $('bgAngle').value,
    });
    return { q, body: null, label: 'bg (ไล่สี)' };
  }

  // ── Text links: pre-fill with the values currently in the source ──────────
  const affInput = document.getElementById('affInput');
  const lineInput = document.getElementById('lineInput');
  function setLinkStatus(field, txt) { setText(document.getElementById(field)?.querySelector('.status'), txt, field); }
  fetch('/current').then((r) => r.json()).then((j) => {
    if (j.aff) affInput.placeholder = j.aff;
    if (j.line) lineInput.placeholder = j.line;
  }).catch(() => {});

  // POST one text link if its box was filled in; blank = leave the code as-is.
  async function sendLink(slot, input, fieldId, label) {
    const value = input.value.trim();
    if (!value) return false;
    const q = new URLSearchParams({ slot, value });
    setLinkStatus(fieldId, '⏳ กำลังบันทึก...');
    try {
      const res = await fetch('/upload?' + q.toString(), { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      setLinkStatus(fieldId, '✅ ' + j.written.join(', '));
      addLog(label + ' → ' + j.written.join(', '), true);
      input.placeholder = value;
      input.value = '';
    } catch (e) {
      setLinkStatus(fieldId, '❌ ' + e.message);
      addLog(label + ': ' + e.message, false);
    }
    return true;
  }

  // ── Sub-page Title/Meta: pre-fill from source, pull from docx, save ────────
  const metaFields = [...document.querySelectorAll('.field[data-page]')];
  const metaEls = (f) => ({
    title: f.querySelector('[data-k=title]'),
    desc: f.querySelector('[data-k=desc]'),
    status: f.querySelector('.status'),
  });
  // remember what's currently saved so "อัพโหลดทั้งหมด" only writes changed pages
  function markSaved(f, title, desc) { f.dataset.origTitle = title; f.dataset.origDesc = desc; }

  fetch('/current-pages').then((r) => r.json()).then((cur) => {
    for (const f of metaFields) {
      const c = cur[f.dataset.page];
      if (!c) continue;
      const { title, desc } = metaEls(f);
      title.value = c.title || '';
      desc.value = c.meta || '';
      markSaved(f, title.value, desc.value);
    }
  }).catch(() => {});

  document.getElementById('pullDocx').addEventListener('click', async () => {
    try {
      // Prefer the file the operator just browsed (not yet uploaded) so the
      // preview reads the original source; fall back to the staged content.docx.
      const docxInput = document.querySelector('input[data-slot="docx"]');
      const picked = docxInput && docxInput.files && docxInput.files[0];
      const res = picked
        ? await fetch('/parse-docx', { method: 'POST', body: picked })
        : await fetch('/parse-docx');
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      let filled = 0;
      for (const f of metaFields) {
        const p = j.pages[f.dataset.page];
        const { title, desc, status } = metaEls(f);
        if (p) {
          if (p.title) title.value = p.title;
          if (p.meta) desc.value = p.meta;
          setText(status, '📄 ดึงจาก docx แล้ว — ตรวจ/แก้ก่อนกดอัพโหลด', f.dataset.page);
          filled++;
        } else {
          setText(status, 'ไม่พบใน docx — คงค่าเดิม', f.dataset.page);
        }
      }
      (j.warnings || []).forEach((w) => addLog('docx: ' + w, false));
      const src = picked ? ('ไฟล์ที่เลือก (' + picked.name + ')') : 'content.docx ในโปรเจค';
      addLog('ดึงจาก ' + src + ': เติมได้ ' + filled + ' หน้า', filled > 0);
    } catch (e) {
      addLog('ดึงจาก docx: ' + e.message, false);
    }
  });

  // POST one page's Title/Meta if it changed since last save. Blank = skip.
  async function sendPageMeta(f) {
    const { title, desc, status } = metaEls(f);
    const t = title.value.trim(), d = desc.value.trim();
    if (t === (f.dataset.origTitle || '') && d === (f.dataset.origDesc || '')) return false;
    if (!t || !d) { setText(status, '⚠️ ต้องกรอกทั้ง Title และ Meta', f.dataset.page); return false; }
    const q = new URLSearchParams({ slot: 'pagemeta', page: f.dataset.page, title: t, desc: d });
    setText(status, '⏳ กำลังบันทึก...', f.dataset.page);
    try {
      const res = await fetch('/upload?' + q.toString(), { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      setText(status, '✅ ' + j.written.join(', '), f.dataset.page);
      addLog(f.dataset.page + ' → ' + j.written.join(', '), true);
      markSaved(f, t, d);
    } catch (e) {
      setText(status, '❌ ' + e.message, f.dataset.page);
      addLog(f.dataset.page + ': ' + e.message, false);
    }
    return true;
  }

  // ── Optional preset pages ("หน้าเสริม"): toggle → move/scaffold + nav link ──
  const newpageFields = [...document.querySelectorAll('.field[data-newpage]')];
  const npEls = (f) => ({
    toggle: f.querySelector('.np-toggle'),
    body: f.querySelector('.np-body'),
    title: f.querySelector('[data-k=title]'),
    desc: f.querySelector('[data-k=desc]'),
    status: f.querySelector('.status'),
    badge: f.querySelector('.np-badge'),
  });
  for (const f of newpageFields) {
    const { toggle, body } = npEls(f);
    toggle.addEventListener('change', () => {
      if (body) body.hidden = !toggle.checked;
      refreshPrompt();  // the หวย toggle feeds the rebrand-prompt card
    });
  }
  // Every toggle starts OFF, on purpose — including for a page that is live
  // right now. Each brand declares its own extra pages from scratch, so an
  // untouched run parks all of them instead of quietly inheriting whatever the
  // previous brand happened to switch on. The badge (not the toggle) is what
  // shows the CURRENT repo state, so the operator can see what flipping — or
  // not flipping — is about to do. Title/Meta are deliberately NOT prefilled
  // from a live page: that text belongs to the previous brand.
  fetch('/current-newpages').then((r) => r.json()).then((cur) => {
    for (const f of newpageFields) {
      const c = cur[f.dataset.newpage];
      if (!c) continue;
      const { badge } = npEls(f);
      if (!badge) { console.warn('[uploader] missing .np-badge for:', f.dataset.newpage); continue; }
      if (c.exists) {
        badge.textContent = 'ตอนนี้เปิดอยู่ — ไม่เปิดสวิตช์ = ย้ายไป pages-disabled';
        badge.className = 'badge np-badge exists';
      } else if (c.parked) {
        badge.textContent = 'ตอนนี้ปิดอยู่ (พักใน pages-disabled)';
        badge.className = 'badge np-badge new';
      } else {
        badge.textContent = 'ยังไม่มีไฟล์ — เปิดสวิตช์ = สร้างใหม่';
        badge.className = 'badge np-badge new';
      }
    }
    refreshPrompt();
  }).catch(() => {});

  // POST every preset row, on AND off — the toggle is a declaration of what this
  // brand ships, so "off" is a real request that parks the page in
  // src/pages-disabled and strips its menu links (it never deletes anything).
  // Title/Meta are optional — blank is fine, the page is scaffolded with default
  // meta + a placeholder article for Claude to write at rebrand time.
  async function sendNewPage(f) {
    const { toggle, title, desc, status } = npEls(f);
    const on = toggle.checked;
    const t = title ? title.value.trim() : '', d = desc ? desc.value.trim() : '';
    const q = new URLSearchParams({ slot: 'newpage', page: f.dataset.newpage, title: t, desc: d, on: on ? '1' : '0' });
    setText(status, !on ? '⏳ กำลังปิด (ย้ายไป pages-disabled)...'
      : (!t && !d) ? '⏳ กำลังเปิด (Claude เขียนเนื้อหาให้ตอนรีแบรนด์)...' : '⏳ กำลังเปิด...', f.dataset.newpage);
    try {
      const res = await fetch('/upload?' + q.toString(), { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      setText(status, '✅ ' + j.written.join(', '), f.dataset.newpage);
      addLog(f.dataset.newpage + ' → ' + j.written.join(', '), true);
      if (j.navAlready) addLog(f.dataset.newpage + ': ลิงก์เมนูมีอยู่แล้ว (ข้าม)', true);
      if (j.navWarning) addLog('navbar/footer: ' + j.navWarning, false);
    } catch (e) {
      setText(status, '❌ ' + e.message, f.dataset.newpage);
      addLog(f.dataset.newpage + ': ' + e.message, false);
    }
    return true;
  }

  // ── Rebrand prompt card: assemble the exact prompt, client-side only ───────
  // No server call — just helps a dev paste a correct, typo-free command into
  // Claude Code, in the one-liner style they actually use. URL clause is dropped
  // when empty (playbook + the URL-scope rule already keep a bare rebrand off the
  // domain); the verify / stop-at-preview reminder lives in the UI hint, not the
  // copied text, to keep the prompt short.
  const rbBrand = document.getElementById('rbBrand');
  const rbUrl = document.getElementById('rbUrl');
  const rbNotes = document.getElementById('rbNotes');
  const rbPrompt = document.getElementById('rbPrompt');
  const rbCopy = document.getElementById('rbCopy');
  // The หวย toggle in the "หน้าเสริม" group is what puts "เว็บหวย" in here — that
  // exact word is the trigger the skill's Phase 4.5 reads to keep the lottery
  // pages on and leave their Huay theme alone. No toggle, no word, no lottery.
  function huayOn() {
    const f = document.querySelector('.field[data-newpage=huay] .np-toggle');
    return !!(f && f.checked);
  }
  function buildPrompt() {
    const brand = rbBrand.value.trim() || '<ชื่อแบรนด์>';
    const url = rbUrl.value.trim();
    const notes = rbNotes.value.trim();
    let p = 'rebrand and retheme to "' + brand + '"';
    if (url) p += ' then real url is "' + url + '"';
    if (huayOn()) p += ' เป็นเว็บหวย';
    p += ' ทำแบบ 2-agent ขนานตาม playbook';
    if (notes) p += ' — ' + notes;
    return p;
  }
  function refreshPrompt() { rbPrompt.value = buildPrompt(); }
  [rbBrand, rbUrl, rbNotes].forEach((el) => el.addEventListener('input', refreshPrompt));
  refreshPrompt();
  rbCopy.addEventListener('click', async () => {
    refreshPrompt();
    try {
      await navigator.clipboard.writeText(rbPrompt.value);
      addLog('คัดลอกคำสั่ง rebrand แล้ว — วางใน Claude Code ได้เลย', true);
    } catch {
      rbPrompt.select();
      addLog('คัดลอกอัตโนมัติไม่ได้ (เลือกข้อความให้แล้ว กด Ctrl+C)', false);
    }
  });

  const uploadAllBtn = document.getElementById('uploadAll');

  // ── Build card: run npm run build, stream its output, point at dist/ ──────
  // Deploy is manual (the operator uploads dist/ to Cloudflare themselves), so
  // this button stops exactly at "dist/ is fresh" and never touches a remote.
  const buildBtn = document.getElementById('buildBtn');
  const openDistBtn = document.getElementById('openDist');
  const buildStatus = document.getElementById('buildStatus');
  const buildOut = document.getElementById('buildOut');
  let building = false;

  function buildLine(text, cls) {
    buildOut.hidden = false;
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.textContent = text;
    buildOut.appendChild(d);
    // A full astro build is hundreds of lines; only the tail is ever useful.
    while (buildOut.childElementCount > 300) buildOut.removeChild(buildOut.firstChild);
    buildOut.scrollTop = buildOut.scrollHeight;
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleString('th-TH', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  function showDistStatus(j) {
    if (!j || !j.exists || !j.files) {
      buildStatus.textContent = 'ยังไม่มี dist/ — กด Build เพื่อสร้าง';
      return;
    }
    buildStatus.textContent = 'dist/ ล่าสุด: ' + j.files + ' ไฟล์'
      + (j.builtAt ? ' · build เมื่อ ' + fmtWhen(j.builtAt) : '');
  }
  fetch('/dist-status').then((r) => r.json()).then(showDistStatus).catch(() => {
    buildStatus.textContent = '';
  });

  buildBtn.addEventListener('click', async () => {
    if (building) return;
    building = true;
    buildBtn.disabled = true;
    uploadAllBtn.disabled = true;
    buildOut.textContent = '';
    buildOut.hidden = false;
    const t0 = Date.now();
    const tick = setInterval(() => {
      buildStatus.textContent = '⏳ กำลัง build... ' + Math.round((Date.now() - t0) / 1000) + ' วิ (อย่าเพิ่งปิดหน้านี้)';
    }, 500);
    let result = null;
    try {
      const res = await fetch('/build', { method: 'POST' });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || ('HTTP ' + res.status));
      }
      // NDJSON: one {line} per output line, then a final {done,...}
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        const parts = buf.split('\\n');
        buf = parts.pop();
        for (const part of parts) {
          if (!part.trim()) continue;
          let msg;
          try { msg = JSON.parse(part); } catch { continue; }
          if (msg.done) result = msg;
          else buildLine(msg.line);
        }
      }
      if (!result) throw new Error('การเชื่อมต่อขาดก่อน build จะจบ');
      const secs = (result.ms / 1000).toFixed(1) + ' วิ';
      if (result.ok) {
        buildLine('✓ build สำเร็จ · ' + result.files + ' ไฟล์ · ' + result.size + ' · ' + secs, 'done');
        buildLine('โฟลเดอร์ที่ต้องอัพขึ้น Cloudflare: ' + result.path, 'done');
        buildStatus.textContent = '✅ build สำเร็จ (' + secs + ') — เอา dist/ ไปอัพขึ้น Cloudflare ได้เลย';
        addLog('build สำเร็จ → dist/ ' + result.files + ' ไฟล์ · ' + result.size, true);
      } else {
        buildLine('✗ ' + result.error, 'err');
        buildStatus.textContent = '❌ ' + result.error + ' — อ่าน log ด้านบน แก้แล้ว build ใหม่';
        addLog('build: ' + result.error, false);
      }
    } catch (e) {
      buildLine('✗ ' + e.message, 'err');
      buildStatus.textContent = '❌ ' + e.message;
      addLog('build: ' + e.message, false);
    } finally {
      clearInterval(tick);
      building = false;
      buildBtn.disabled = false;
      uploadAllBtn.disabled = false;
      if (result && result.ok) fetch('/dist-status').then((r) => r.json()).then(showDistStatus).catch(() => {});
    }
  });

  openDistBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/open-dist', { method: 'POST' });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
      addLog('เปิดโฟลเดอร์ ' + j.path, true);
    } catch (e) {
      buildStatus.textContent = '❌ ' + e.message;
      addLog('เปิดโฟลเดอร์ dist: ' + e.message, false);
    }
  });

  uploadAllBtn.addEventListener('click', async () => {
    if (building) return;   // a build reads the very files an upload rewrites
    const inputs = [...document.querySelectorAll('input[type=file]')].filter((i) => i !== bgFile);
    let any = false;
    uploadAllBtn.disabled = true;
    buildBtn.disabled = true;
    modalStart();
    try {
      // One row blowing up must never cost the run its remaining steps — the
      // image uploads come last, so an early throw used to skip all of them.
      const step = async (label, fn) => {
        try { if (await fn()) any = true; }
        catch (e) { addLog(label + ': ' + e.message, false); }
      };
      await step('ลิงก์ aff', () => sendLink('aff', affInput, 'affField', 'ลิงก์ aff'));
      await step('ลิงก์ไลน์', () => sendLink('line', lineInput, 'lineField', 'ลิงก์ไลน์'));
      for (const f of metaFields) await step(f.dataset.page, () => sendPageMeta(f));
      for (const f of newpageFields) await step(f.dataset.newpage, () => sendNewPage(f));

      const bgReq = bgRequest();
      if (bgReq) {
        any = true;
        setStatus(bgFile, '⏳ กำลังอัพโหลด...');
        try {
          const res = await fetch('/upload?' + bgReq.q.toString(), { method: 'POST', body: bgReq.body });
          const j = await res.json();
          if (!res.ok || !j.ok) throw new Error(j.error || ('HTTP ' + res.status));
          setStatus(bgFile, '✅ ' + j.written.join(', '));
          addLog(bgReq.label + ' → ' + j.written.join(', '), true);
        } catch (e) {
          setStatus(bgFile, '❌ ' + e.message);
          addLog(bgReq.label + ': ' + e.message, false);
        }
      }

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
    } catch (e) {
      // every step already catches its own failure, so reaching here means
      // something unexpected broke — still close out the modal, never leave it
      // spinning forever.
      addLog('อัพโหลดหยุดกลางคัน: ' + e.message, false);
    } finally {
      uploadAllBtn.disabled = false;
      buildBtn.disabled = false;
      if (!any) modalFinish('fail', 'ยังไม่มีอะไรให้อัพโหลด', 'เลือกไฟล์ กรอกลิงก์ หรือเปิดสวิตช์หน้าเสริมก่อน แล้วกดใหม่อีกครั้ง');
      else if (runErrors) modalFinish('fail', 'เสร็จแล้ว แต่มี ' + runErrors + ' รายการไม่สำเร็จ', 'อ่านรายการด้านบน แก้แล้วกดอัพโหลดใหม่เฉพาะส่วนที่พลาดได้');
      else modalFinish('done', 'เสร็จเรียบร้อย ✨', 'บันทึก ' + runOk + ' รายการลงโปรเจคแล้ว — หน้าต่างนี้จะปิดเอง');
    }
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
  if (req.method === "GET" && url.pathname === "/current") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await readCurrentLinks()));
    return;
  }
  if (req.method === "GET" && url.pathname === "/current-pages") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await readCurrentPageMeta()));
    return;
  }
  if (req.method === "GET" && url.pathname === "/current-newpages") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await readCurrentNewPages()));
    return;
  }
  if (req.method === "GET" && url.pathname === "/dist-status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(await readDistStatus()));
    return;
  }
  if (req.method === "POST" && url.pathname === "/build") {
    if (buildRunning) {
      res.writeHead(409, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "มี build กำลังรันอยู่ — รอให้เสร็จก่อน" }));
      return;
    }
    buildRunning = true;
    streamBuild(res);
    return;
  }
  if (req.method === "POST" && url.pathname === "/open-dist") {
    const s = await distStats();
    if (!s.exists) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "ยังไม่มีโฟลเดอร์ dist — กด Build ก่อน" }));
      return;
    }
    openDistFolder();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: DIST }));
    return;
  }
  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/parse-docx") {
    try {
      // POST body = the docx the operator just browsed (preview before upload);
      // GET = fall back to the staged src/assets/content.docx.
      let result;
      if (req.method === "POST") {
        const buf = await readBody(req);
        if (!buf.length) throw new Error("ไม่พบไฟล์ docx ที่ส่งมา");
        result = parseDocxBuffer(buf);
      } else {
        result = await readDocxSubPages();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/upload") {
    try {
      const slot = url.searchParams.get("slot") || "";
      const index = url.searchParams.get("index") || "";
      const ext = (url.searchParams.get("ext") || "").toLowerCase();
      const buf = await readBody(req);
      let written;
      let extra = {};
      if (slot === "bg") {
        // the one slot that may arrive with no body (colour / gradient mode)
        written = await handleBackground(url.searchParams, buf);
      } else if (slot === "aff") {
        // text-only slots: the new link comes in ?value=, never as a body
        written = await handleAffLink(url.searchParams.get("value"));
      } else if (slot === "line") {
        written = await handleLineLink(url.searchParams.get("value"));
      } else if (slot === "pagemeta") {
        // sub-page SEO: page key + title + desc arrive in the query, no body
        written = await writePageMeta(
          url.searchParams.get("page") || "",
          url.searchParams.get("title"),
          url.searchParams.get("desc"),
        );
      } else if (slot === "newpage") {
        // optional preset page(s): ?on=1 puts them in src/pages + wires the nav
        // links; ?on=0 parks them in src/pages-disabled + strips the links. No
        // body either way. Off is a real action, not "do nothing" — that is what
        // stops one brand's extra pages from shipping with the next brand.
        const key = url.searchParams.get("page") || "";
        const cfg = PRESET_PAGES[key];
        if (!cfg) throw new Error(`ไม่รู้จักหน้า preset: ${key}`);
        const on = url.searchParams.get("on") !== "0";
        const navWarnings = [];
        if (on) {
          const pageRes = await enablePreset(key, url.searchParams.get("title"), url.searchParams.get("desc"));
          written = [...pageRes.written];
          let already = true;
          for (const page of cfg.pages) {
            const navRes = await addNavLink(page.route, page.navLabel);
            if (navRes.inserted) { written.push(`navbar ${navRes.navFile} (+${navRes.inserted}: ${page.route})`); already = false; }
            if (navRes.warning) navWarnings.push(navRes.warning);
            const footerWarning = await checkFooterLink(page.route, page.navLabel);
            if (footerWarning) navWarnings.push(footerWarning);
          }
          extra = {
            created: pageRes.created,
            restored: pageRes.restored,
            navWarning: navWarnings.join(" / ") || null,
            navAlready: already && !navWarnings.length,
          };
        } else {
          const pageRes = await disablePreset(key);
          written = [...pageRes.written];
          for (const page of cfg.pages) {
            const navRes = await removeNavLink(page.route);
            if (navRes.removed) written.push(`ลบลิงก์ ${page.route} จาก ${(navRes.files || []).join(", ")}`);
            navWarnings.push(...navRes.warnings);
          }
          if (!written.length) written.push(`${cfg.label}: ปิดอยู่แล้ว (ไม่มีอะไรต้องย้าย)`);
          extra = { disabled: true, moved: pageRes.moved, navWarning: navWarnings.join(" / ") || null };
        }
      } else {
        if (!buf.length) throw new Error("empty upload");
        written = await handleUpload(slot, index, ext, buf);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, written, ...extra }));
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

server.listen(PORT, HOST, () => {
  const shown = HOST === "0.0.0.0" ? "localhost" : HOST;
  console.log(`\n  Rebrand asset uploader running:\n  → http://${shown}:${PORT}   (bind ${HOST})\n`);
  console.log(`  Writes into:\n  - ${ASSETS}\n  - ${PUBLIC}\n`);
  console.log("  Ctrl+C to stop. This only stages files; run the rebrand via Claude afterward.\n");
});
