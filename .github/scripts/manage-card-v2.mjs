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
function pageIdFromUrl(url) {
  const pathname = decodeURIComponent(new URL(url).pathname);
  const match = pathname.replace(/[^0-9a-f]/gi, "").match(/([0-9a-f]{32})$/i);
  if (!match) return "";
  const hex = match[1].toLowerCase();
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}

function titleFromRuns(runs) {
  if (!Array.isArray(runs)) return "";
  return runs.map(run => Array.isArray(run) ? String(run[0] ?? "") : typeof run === "string" ? run : "").join("").trim();
}

function isGenericNotionTitle(value) {
  const title = String(value || "").replace(/\s+/g, " ").trim();
  return /^notion\s*[|｜│:—-]\s*where teams and agents work together$/i.test(title) ||
    /^notion\s*[|｜│:—-]\s*(?:a workspace for your notes|the connected workspace)$/i.test(title);
}

async function getNotionMetadata(url) {
  const parsed = new URL(url);
  let name = "";
  let apiError = "";

  // Public Notion pages are React shells; their actual page title is available
  // from Notion's own public page-chunk API, not reliably from <meta> tags.
  const pageId = pageIdFromUrl(url);
  if (pageId) {
    const apiBase = parsed.hostname.toLowerCase().endsWith(".notion.site")
      ? parsed.origin + "/api/v3"
      : "https://www.notion.so/api/v3";
    try {
      const response = await fetch(apiBase + "/loadCachedPageChunkV2", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "Mozilla/5.0 (notion-reader)"
        },
        body: JSON.stringify({
          page: { id: pageId },
          limit: 100,
          cursor: { stack: [] },
          chunkNumber: 0,
          verticalColumns: false
        })
      });
      if (!response.ok) {
        apiError = "Notion API HTTP " + response.status;
      } else {
        const chunk = await response.json();
        const blocks = chunk?.recordMap?.block || {};
        const normalizedId = pageId.replace(/-/g, "").toLowerCase();
        let record = blocks[pageId];
        if (!record) {
          record = Object.entries(blocks).find(([key, item]) =>
            String(key).replace(/-/g, "").toLowerCase() === normalizedId ||
            String(item?.value?.value?.id || item?.value?.id || "").replace(/-/g, "").toLowerCase() === normalizedId
          )?.[1];
        }
        const pageBlock = record?.value?.value || record?.value || record;
        name = titleFromRuns(pageBlock?.properties?.title);
        if (!name) apiError = "Notion API returned no page title";
      }
    } catch (error) {
      apiError = error?.message || String(error);
    }
  } else {
    apiError = "The URL does not contain a 32-character Notion page ID";
  }

  // Fallback to HTML metadata only when it looks like a real page title.
  if (!name || isGenericNotionTitle(name)) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; TwitterCardtoNotion/1.0)",
          "Accept": "text/html,application/xhtml+xml"
        }
      });
      if (response.ok) {
        const html = await response.text();
        const meta = {};
        for (const item of html.matchAll(/<meta\b[^>]*>/gi)) {
          const attrs = parseAttributes(item[0]);
          const key = String(attrs.property || attrs.name || attrs.itemprop || "").toLowerCase();
          if (key && attrs.content) meta[key] = attrs.content;
        }
        const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
        const htmlTitle = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]*>/g, "").trim()) : "";
        const candidates = [htmlTitle, meta["og:title"], meta["twitter:title"]];
        name = candidates.map(value => String(value || "").replace(/\s*[|｜│]\s*Notion\s*$/i, "").trim())
          .find(value => value && !isGenericNotionTitle(value)) || "";
      }
    } catch {
      // A useful error is reported below when neither source yields a title.
    }
  }

  if (!name || isGenericNotionTitle(name)) {
    throw new Error("Notionのページタイトルを取得できませんでした。ページがWeb公開されているか、正しいNotionページURLか確認してください。" + (apiError ? " (" + apiError + ")" : ""));
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