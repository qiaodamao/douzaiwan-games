// build.mjs — 都在玩 构建脚本
// 用法：
//   node build.mjs migrate   一次性迁移：从旧 data.js 生成各游戏 game.json + 复制封面进游戏目录
//   node build.mjs           常规构建：扫描 list/ 生成 data.js / thumbs/ / g/<id>.html / sitemap.xml
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

// ================= 配置 =================
const SITE_BASE = "";      // 站点线上根 URL（如 "https://xxx.edgeone.app"）；留空则跳过 sitemap 生成
const THUMB_SIZE = 400;    // 缩略图边长（px）
const WEBP_QUALITY = 80;   // WebP 压缩质量
// ========================================

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const LEGACY_TITLE = "<title>正在游戏 - 都在玩</title>";
const META_MARK = "<!--BUILD:META-->";
const GAME_MARK = "<!--BUILD:GAME-->";
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const COVER_NAMES = ["cover.png", "cover.jpg", "cover.jpeg", "cover.webp", "cover.gif"];
const idColl = new Intl.Collator(undefined, { numeric: true });

const errors = [];
const warnings = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 注意：本机环境下 node 的 fs.rmSync 会静默失效（不删除也不报错），删除文件统一走 unlinkSync
function rmFile(p) {
  try { fs.unlinkSync(p); } catch (e) { if (e.code !== "ENOENT") throw e; }
}

// 扫描 list/ 下所有游戏目录并校验
function scanGames() {
  const listDir = path.join(ROOT, "list");
  const games = [];
  for (const name of fs.readdirSync(listDir)) {
    const dir = path.join(listDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const slugOk = SLUG_RE.test(name) && name.length <= 50 && !name.endsWith("-");
    if (!slugOk) {
      err(`目录名 "${name}" 不合法：请用小写字母或数字开头的 slug（仅 [a-z0-9-]，不超过 50 字符，不以 - 结尾）`);
      continue;
    }
    const jsonPath = path.join(dir, "game.json");
    if (!fs.existsSync(jsonPath)) {
      err(`list/${name}/ 缺少 game.json（旧数据请先运行：node build.mjs migrate）`);
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    } catch (e) {
      err(`list/${name}/game.json 解析失败：${e.message}`);
      continue;
    }
    for (const f of ["title", "cat", "emoji"]) {
      if (typeof meta[f] !== "string" || !meta[f].trim()) err(`list/${name}/ game.json 字段 "${f}" 缺失或为空`);
    }
    if (typeof meta.entry !== "string" || !meta.entry.trim()) {
      err(`list/${name}/ game.json 字段 "entry" 缺失或为空`);
    } else if (meta.entry.includes("..") || meta.entry.startsWith("/")) {
      err(`list/${name}/ entry "${meta.entry}" 不允许包含 .. 或以 / 开头`);
    } else if (!fs.existsSync(path.join(dir, meta.entry))) {
      err(`list/${name}/ 入口文件 "${meta.entry}" 不存在`);
    }
    if (meta.hot === undefined) { meta.hot = false; warn(`list/${name}/ 未设置 hot，默认 false`); }
    if (typeof meta.title === "string" && meta.title.length > 20) warn(`list/${name}/ 标题超过 20 字，卡片会截断`);
    const cover = COVER_NAMES.map((c) => path.join(dir, c)).find((p) => fs.existsSync(p)) || null;
    if (!cover) warn(`list/${name}/ 无封面（cover.png/jpg/jpeg/webp/gif）`);
    games.push({ id: name, dir, meta, cover });
  }
  return games;
}

// 一次性迁移：从旧 data.js 生成 game.json，并把 images/ 封面复制进各游戏目录
function runMigration() {
  const src = fs.readFileSync(path.join(ROOT, "data.js"), "utf8");
  const games = new Function("window", src + "\nreturn window.GAMES;")({});
  if (!Array.isArray(games) || !games.length) {
    console.error("迁移失败：无法从 data.js 读取 window.GAMES");
    process.exit(1);
  }
  let created = 0, skipped = 0, missingDir = 0;
  for (const g of games) {
    const dir = path.join(ROOT, "list", String(g.id));
    if (!fs.existsSync(dir)) { console.error(`  跳过 id=${g.id}：list/${g.id}/ 目录不存在`); missingDir++; continue; }
    const jsonPath = path.join(dir, "game.json");
    if (fs.existsSync(jsonPath)) { skipped++; continue; }
    const meta = { title: g.title, cat: g.cat, emoji: g.emoji, entry: g.entry, hot: !!g.hot };
    fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
    created++;
  }
  let noCover = 0;
  for (const g of games) {
    const dir = path.join(ROOT, "list", String(g.id));
    if (COVER_NAMES.some((c) => fs.existsSync(path.join(dir, c)))) continue;
    const srcImg = path.join(ROOT, "images", g.img);
    if (!fs.existsSync(srcImg)) { console.error(`  警告：id=${g.id} 封面 images/${g.img} 不存在`); noCover++; continue; }
    fs.copyFileSync(srcImg, path.join(dir, "cover" + path.extname(g.img).toLowerCase()));
  }
  console.log(`迁移完成：${created} 个 game.json 新建，${skipped} 个已存在跳过，${missingDir} 个目录缺失，${noCover} 个缺封面`);
}

// 生成压缩缩略图 thumbs/<id>.webp，并清理已删游戏的过期缩略图
async function generateThumbs(games) {
  const thumbsDir = path.join(ROOT, "thumbs");
  fs.mkdirSync(thumbsDir, { recursive: true });
  let n = 0;
  for (const g of games) {
    if (!g.cover) continue;
    try {
      await sharp(g.cover)
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: "cover", withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toFile(path.join(thumbsDir, `${g.id}.webp`));
      n++;
    } catch (e) {
      warn(`list/${g.id}/ 封面处理失败（已跳过）：${e.message}`);
    }
  }
  const valid = new Set(games.map((g) => `${g.id}.webp`));
  for (const f of fs.readdirSync(thumbsDir)) {
    if (f.endsWith(".webp") && !valid.has(f)) {
      rmFile(path.join(thumbsDir, f));
      console.log(`  清理过期缩略图：thumbs/${f}`);
    }
  }
  return n;
}

// 生成 data.js（window.GAMES，接口不变）
function generateDataJs(games) {
  const sorted = [...games].sort((a, b) => idColl.compare(a.id, b.id));
  const lines = sorted.map((g) => {
    const img = g.cover ? `img: "thumbs/${g.id}.webp", ` : "";
    return `  { id: ${JSON.stringify(g.id)}, ${img}title: ${JSON.stringify(g.meta.title)}, cat: ${JSON.stringify(g.meta.cat)}, emoji: ${JSON.stringify(g.meta.emoji)}, entry: ${JSON.stringify(g.meta.entry)}, hot: ${g.meta.hot ? "true" : "false"} },`;
  });
  const out = `// 此文件由 build.mjs 自动生成，请勿手改。数据源：list/<目录名>/game.json\nwindow.GAMES = [\n${lines.join("\n")}\n];\n`;
  fs.writeFileSync(path.join(ROOT, "data.js"), out, "utf8");
}

// 以 play.html 为模板生成每款游戏的静态页 g/<id>.html（SEO 落地页）
function generatePages(games) {
  const template = fs.readFileSync(path.join(ROOT, "play.html"), "utf8");
  for (const mark of [LEGACY_TITLE, META_MARK, GAME_MARK]) {
    if (!template.includes(mark)) {
      console.error(`模板 play.html 缺少占位符：${mark}`);
      process.exit(1);
    }
  }
  const pagesDir = path.join(ROOT, "g");
  fs.mkdirSync(pagesDir, { recursive: true });
  for (const g of games) {
    const desc = g.meta.desc || `在线免费玩${g.meta.title}（${g.meta.cat}），手机电脑直接玩，无需下载。`;
    const game = { id: g.id, title: g.meta.title, cat: g.meta.cat, emoji: g.meta.emoji, entry: g.meta.entry, hot: !!g.meta.hot };
    if (g.cover) game.img = `../thumbs/${g.id}.webp`;
    const inline = JSON.stringify(game).replace(/<\//g, "<\\/"); // 防 </script> 破坏
    const page = template
      .replace(LEGACY_TITLE, `<title>${escHtml(g.meta.title)} - 都在玩</title>`)
      .replace(META_MARK, `<meta name="description" content="${escHtml(desc)}">`)
      .replace(GAME_MARK, `<script>window.GAME = ${inline};</script>`);
    fs.writeFileSync(path.join(pagesDir, `${g.id}.html`), page, "utf8");
  }
  // 清理 g/ 内已删游戏的过期页面
  const valid = new Set(games.map((g) => `${g.id}.html`));
  for (const f of fs.readdirSync(pagesDir)) {
    if (f.endsWith(".html") && !valid.has(f)) {
      rmFile(path.join(pagesDir, f));
      console.log(`  清理过期页面：g/${f}`);
    }
  }
  // 清理旧版根目录 g-<id>.html（已迁入 g/，一次性迁移）
  for (const f of fs.readdirSync(ROOT)) {
    if (/^g-.*\.html$/.test(f)) {
      rmFile(path.join(ROOT, f));
      console.log(`  清理旧版根目录页面：${f}`);
    }
  }
}

// 生成 sitemap.xml（SITE_BASE 为空则跳过）
function generateSitemap(games) {
  if (!SITE_BASE) {
    console.warn("警告：SITE_BASE 为空，跳过 sitemap.xml 生成（在 build.mjs 顶部填入线上域名后重新构建）");
    return;
  }
  const urls = [SITE_BASE + "/", ...games.map((g) => `${SITE_BASE}/g/${encodeURIComponent(g.id)}.html`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n") + `\n</urlset>\n`;
  fs.writeFileSync(path.join(ROOT, "sitemap.xml"), xml, "utf8");
}

async function main() {
  if (process.argv[2] === "migrate") runMigration();
  const games = scanGames();
  if (errors.length) {
    console.error(`\n发现 ${errors.length} 个错误，未生成任何输出：`);
    for (const e of errors) console.error("  ✗ " + e);
    process.exit(1);
  }
  console.log(`扫描到 ${games.length} 款游戏`);
  const thumbsN = await generateThumbs(games);
  generateDataJs(games);
  generatePages(games);
  generateSitemap(games);
  console.log(`构建完成：thumbs/ ${thumbsN} 张缩略图，${games.length} 个 g/*.html 页面，data.js 已更新`);
  if (warnings.length) {
    console.warn(`\n${warnings.length} 个警告：`);
    for (const w of warnings) console.warn("  ⚠ " + w);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
