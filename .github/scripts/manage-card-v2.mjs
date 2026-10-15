import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DATA_FILE = path.join(ROOT, "cards.json");
const SITE_BASE = "https://sarscoc.github.io/TwitterCardtoNotion/";
const operation = String(process.env.CARD_OPERATION || "").trim();
const id = String(process.env.CARD_ID || "").trim();
const type = String(process.env.CARD_TYPE || "other").trim();
const notionUrl = String(process.env.NOTION_URL || "").trim();
const imagePath = String(process.env.IMAGE_PATH || "").trim();
const createdAtInput = String(process.env.CREATED_AT || "").trim();

function fail(message) {
  console.error(message);
  process.exit(1);
}
function safeId(value) {
  return /^[a-z0-9-]{4,80}$/i.test(value);
}
function htmlEscape(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => {
      const code = Number.parseInt(n, 16);
      return code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : _;
    });
}
function parseAttributes(tag) {
  const attrs = {};
  const re = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(re)) {
    attrs[match[1].toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? "");
  }
  return attrs;
}
function allowedNotionUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("Notion URLが正しくありません。");
  }
  const host = url.hostname.toLowerCase();
  const allowed = host === "notion.site" || host.endsWith(".notion.site") || host === "notion.so" || host === "www.notion.so";
  if (url.protocol !== "https:" || !allowed) {
    fail("Notionの公開ページURL（https://*.notion.site または notion.so）を指定してください。");
  }
  return url.href;
}
async function getNotionMetadata(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; TwitterCardtoNotion/1.0)",
      "Accept": "text/html,application/xhtml+xml"
    }
  });
  if (!response.ok) {
    throw new Error("Notionページを取得できませんでした（HTTP " + response.status + "）。公開ページか確認してください。");
  }
  const html = await response.text();
  const meta = {};
  for (const item of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = parseAttributes(item[0]);
    const key = String(attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
    if (key && attrs.content) meta[key] = attrs.content;
  }
  let rawTitle = meta["og:title"] || meta["twitter:title"] || "";
  if (!rawTitle) {
    const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    rawTitle = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]*>/g, "").trim()) : "";
  }
  let name = String(rawTitle).replace(/\s*[|｜│]\s*Notion\s*$/i, "").trim();
  if (!name) {
    const pathPart = new URL(url).pathname.split("/").filter(Boolean).pop() || "";
    name = pathPart.replace(/-[0-9a-f]{32}$/i, "").replace(/-/g, " ").trim();
  }
  if (!name) {
    throw new Error("Notionページのタイトルを取得できませんでした。ページを公開し、タイトルが設定されているか確認してください。");
  }
  return { name, description: name + "│Notion" };
}
function makeCardHtml(card) {
  const cardUrl = SITE_BASE + "cards/" + encodeURIComponent(card.id) + "/";
  const imageUrl = new URL(card.imagePath, SITE_BASE).href;
  const moveScript = JSON.stringify(card.notion).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return [
    "<!doctype html>",
    '<html lang="ja">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="robots" content="noindex">',
    "<title>" + htmlEscape(card.description) + "</title>",
    '<meta property="og:type" content="website">',
    '<meta property="og:title" content="' + htmlEscape(card.name) + '">',
    '<meta property="og:description" content="' + htmlEscape(card.description) + '">',
    '<meta property="og:url" content="' + htmlEscape(cardUrl) + '">',
    '<meta property="og:image" content="' + htmlEscape(imageUrl) + '">',
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:title" content="' + htmlEscape(card.name) + '">',
    '<meta name="twitter:description" content="' + htmlEscape(card.description) + '">',
    '<meta name="twitter:image" content="' + htmlEscape(imageUrl) + '">',
    '<link rel="canonical" href="' + htmlEscape(card.notion) + '">',
    '<meta http-equiv="refresh" content="0; url=' + htmlEscape(card.notion) + '">',
    "<script>location.replace(" + moveScript + ");</script>",
    "</head>",
    '<body><a href="' + htmlEscape(card.notion) + '">Notionへ移動</a></body>',
    "</html>"
  ].join("\n") + "\n";
}

if (!["save", "delete"].includes(operation)) fail("不明な操作です。");
if (!safeId(id)) fail("カードIDが正しくありません。");
let cards = [];
try {
  cards = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!Array.isArray(cards)) fail("cards.jsonの形式が正しくありません。");
} catch (error) {
  if (error?.code !== "ENOENT") fail("cards.jsonを読み込めません: " + error.message);
}
const existingIndex = cards.findIndex(card => card.id === id);
const cardDir = path.join(ROOT, "cards", id);
const cardHtmlPath = path.join(cardDir, "index.html");
if (operation === "delete") {
  if (existingIndex < 0) fail("削除対象のカードが見つかりません。");
  cards.splice(existingIndex, 1);
  fs.writeFileSync(DATA_FILE, JSON.stringify(cards, null, 2) + "\n", "utf8");
  if (fs.existsSync(cardHtmlPath)) fs.rmSync(cardDir, { recursive: true, force: true });
  console.log("Deleted card " + id);
} else {
  if (!["character", "report", "other"].includes(type)) fail("カードの種類が正しくありません。");
  const safeNotionUrl = allowedNotionUrl(notionUrl);
  if (!/^images\/[A-Za-z0-9._-]+\.(png|jpe?g|webp|gif)$/i.test(imagePath)) fail("画像パスが正しくありません。");
  const info = await getNotionMetadata(safeNotionUrl);
  const now = new Date().toISOString();
  const previous = existingIndex >= 0 ? cards[existingIndex] : null;
  const card = {
    id,
    type,
    tags: Array.isArray(previous?.tags) ? previous.tags : [],
    name: info.name,
    description: info.description,
    imagePath,
    notion: safeNotionUrl,
    createdAt: previous?.createdAt || (createdAtInput && !Number.isNaN(Date.parse(createdAtInput)) ? createdAtInput : now),
    updatedAt: now
  };
  if (existingIndex >= 0) cards.splice(existingIndex, 1);
  cards.unshift(card);
  fs.writeFileSync(DATA_FILE, JSON.stringify(cards, null, 2) + "\n", "utf8");
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(cardHtmlPath, makeCardHtml(card), "utf8");
  console.log("Saved card " + id + " (" + info.name + ")");
}