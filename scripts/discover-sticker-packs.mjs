import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shortError } from "./lib/safe-log.mjs";
import { loadVkStickerCatalog } from "./vk-sticker-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = resolve(root, ".cache/sticker-discovery");
const searchCacheDir = resolve(cacheDir, "search");
const setCacheDir = resolve(cacheDir, "sets");
const manualCandidatesPath = resolve(root, "sticker-pack-candidates.json");
const outputPath = resolve(root, "sticker-pack-candidates.discovered.json");
const refresh = process.argv.includes("--refresh");
const productFilter = numberArg("--product");
const searchConcurrency = 8;
const telegramConcurrency = 6;

const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const vkToken = requiredEnv("VK_ACCESS_TOKEN");
const vkApiVersion = process.env.VK_API_VERSION || "5.199";
const redactError = (error) => shortError(error, [telegramToken, vkToken]);

await mkdir(searchCacheDir, { recursive: true });
await mkdir(setCacheDir, { recursive: true });

const [vkCatalog, manualCandidates, existingDocument] = await Promise.all([
  loadVkStickerCatalog({ token: vkToken, apiVersion: vkApiVersion }),
  readJson(manualCandidatesPath),
  readJsonIfExists(outputPath)
]);
const products = vkCatalog.products
  .filter((product) => !productFilter || Number(product.id) === productFilter)
  .sort((left, right) => Number(right.id) - Number(left.id));
const manualIds = new Set(manualCandidates.map((candidate) => Number(candidate.vkProductId)));
const existingCandidates = refresh ? [] : existingDocument?.candidates ?? [];
const productIds = new Set(products.map((product) => Number(product.id)));
const preservedCandidates = existingCandidates.filter(
  (candidate) => productIds.has(Number(candidate.vkProductId)) && !manualIds.has(Number(candidate.vkProductId))
);
const knownIds = new Set([
  ...manualIds,
  ...preservedCandidates.map((candidate) => Number(candidate.vkProductId))
]);
const productsToDiscover = products.filter((product) => !knownIds.has(Number(product.id)));

console.log(
  `VK catalog: ${vkCatalog.promoted.length} promoted + ${vkCatalog.purchased.length} purchased + ` +
    `${vkCatalog.hidden.length} hidden = ${products.length} unique (scanned through ${vkCatalog.scanMaxProductId}); ` +
    `${preservedCandidates.length} preserved, ${productsToDiscover.length} require discovery`
);

const primarySearches = await mapLimit(productsToDiscover, searchConcurrency, async (product, index) => {
  progress("Search @stickers_vk", index, productsToDiscover.length, product.title);
  try {
    return {
      product,
      associations: await searchChannel("stickers_vk", product.title),
      searchErrors: []
    };
  } catch (error) {
    console.warn(`WARN @stickers_vk ${product.id} ${product.title}: ${redactError(error)}`);
    return { product, associations: [], searchErrors: [redactError(error)] };
  }
});
const primarySetNames = unique(
  primarySearches.flatMap((result) => result.associations.map((association) => association.setName))
);
const metadata = new Map();
await loadSetMetadata(primarySetNames, metadata, "Validate primary sets");

const discovered = [...preservedCandidates];
const unresolved = [];
for (const search of primarySearches) {
  const selected = chooseCandidate(search.product, search.associations, metadata);
  if (selected) discovered.push(toCandidate(search.product, selected));
  else unresolved.push(search);
}

console.log(
  `Primary catalog matched ${discovered.length - preservedCandidates.length}/${productsToDiscover.length}; ` +
    `fallback search ${unresolved.length}`
);

const fallbackSearches = await mapLimit(unresolved, searchConcurrency, async (unresolvedSearch, index) => {
  progress("Search @TgSticker", index, unresolved.length, unresolvedSearch.product.title);
  let fallback = [];
  const searchErrors = [...(unresolvedSearch.searchErrors ?? [])];
  try {
    fallback = await searchChannel("TgSticker", unresolvedSearch.product.title);
  } catch (error) {
    searchErrors.push(redactError(error));
    console.warn(`WARN @TgSticker ${unresolvedSearch.product.id} ${unresolvedSearch.product.title}: ${redactError(error)}`);
  }
  return {
    product: unresolvedSearch.product,
    associations: deduplicateAssociations([...unresolvedSearch.associations, ...fallback]),
    searchErrors
  };
});
const fallbackSetNames = unique(
  fallbackSearches.flatMap((result) => result.associations.map((association) => association.setName))
);
await loadSetMetadata(fallbackSetNames, metadata, "Validate fallback sets");

const unresolvedAfterFallback = [];
for (const search of fallbackSearches) {
  const selected = chooseCandidate(search.product, search.associations, metadata);
  if (selected) discovered.push(toCandidate(search.product, selected));
  else unresolvedAfterFallback.push(search);
}

const guessedSearches = unresolvedAfterFallback.map((search) => ({
  ...search,
  associations: deduplicateAssociations([
    ...search.associations,
    ...guessSetNames(search.product.title).map((setName) => ({
      setName,
      channel: "guessed",
      text: search.product.title
    }))
  ])
}));
const guessedSetNames = unique(
  guessedSearches.flatMap((result) =>
    result.associations
      .filter((association) => association.channel === "guessed")
      .map((association) => association.setName)
  )
);
await loadSetMetadata(guessedSetNames, metadata, "Validate guessed sets");

const missing = [];
for (const search of guessedSearches) {
  const selected = chooseCandidate(search.product, search.associations, metadata);
  if (selected) discovered.push(toCandidate(search.product, selected));
  else {
    const topCandidates = candidateScores(search.product, search.associations, metadata)
      .slice(0, 5)
      .map((candidate) => ({
        setName: candidate.set.name,
        telegramTitle: candidate.set.title,
        telegramStickerCount: candidate.set.stickerCount,
        score: Number(candidate.score.toFixed(2)),
        sourceChannel: candidate.association.channel,
        sourcePost: candidate.association.post
      }));
    missing.push({
      vkProductId: Number(search.product.id),
      vkTitle: search.product.title,
      stickerCount: stickerCount(search.product),
      searchedSetNames: unique(search.associations.map((association) => association.setName)),
      ...(search.searchErrors?.length ? { searchErrors: search.searchErrors } : {}),
      topCandidates
    });
  }
}

discovered.sort((left, right) => left.vkProductId - right.vkProductId);
missing.sort((left, right) => left.vkProductId - right.vkProductId);
const output = {
  version: 1,
  generatedAt: new Date().toISOString(),
  catalog: {
    promotedPacks: vkCatalog.promoted.length,
    purchasedPacks: vkCatalog.purchased.length,
    hiddenPacks: vkCatalog.hidden.length,
    scanMaxProductId: vkCatalog.scanMaxProductId,
    uniquePacks: products.length,
    manualPacks: products.filter((product) => manualIds.has(Number(product.id))).length,
    discoveredPacks: discovered.length,
    missingPacks: missing.length
  },
  candidates: discovered,
  missing
};
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(
  `WROTE ${outputPath}: ${discovered.length} discovered + ${output.catalog.manualPacks} manual, ${missing.length} missing`
);

async function searchChannel(channel, title) {
  const key = createHash("sha256").update(`${channel.toLowerCase()}:${title.trim().toLowerCase()}`).digest("hex");
  const cachePath = resolve(searchCacheDir, `${key}.json`);
  if (!refresh) {
    const cached = await readJsonIfExists(cachePath);
    if (cached) return cached;
  }

  const url = `https://telegram.me/s/${channel}?q=${encodeURIComponent(title.trim())}`;
  const response = await fetchWithRetry(url, { headers: { "user-agent": "Mozilla/5.0 sticker-map-sync" } });
  if (!response.ok) throw new Error(`Telegram public search ${channel} failed: ${response.status}`);
  const associations = parseTelegramSearch(await response.text(), channel);
  await writeFile(cachePath, `${JSON.stringify(associations)}\n`);
  return associations;
}

function parseTelegramSearch(html, channel) {
  const marker = '<div class="tgme_widget_message_wrap js-widget_message_wrap">';
  const chunks = html.split(marker).slice(1);
  const associations = [];
  for (const chunk of chunks) {
    const post = chunk.match(new RegExp(`data-post="${escapeRegex(channel)}\\/(\\d+)"`, "i"))?.[1];
    const textHtml = chunk.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "";
    const text = htmlToText(textHtml);
    const setNames = unique(
      [...chunk.matchAll(/https?:\/\/(?:t|telegram)\.me\/addstickers\/([A-Za-z0-9_]+)/gi)].map((match) => match[1])
    );
    for (const setName of setNames) {
      associations.push({ setName, channel, post: post ? Number(post) : undefined, text });
    }
  }
  return deduplicateAssociations(associations);
}

async function loadSetMetadata(setNames, metadata, label) {
  const pending = unique(setNames).filter((setName) => !metadata.has(setName.toLowerCase()));
  await mapLimit(pending, telegramConcurrency, async (setName, index) => {
    progress(label, index, pending.length, setName);
    const key = setName.toLowerCase();
    const cachePath = resolve(setCacheDir, `${safeFilename(key)}.json`);
    if (!refresh) {
      const cached = await readJsonIfExists(cachePath);
      if (cached) {
        metadata.set(key, cached.valid ? cached : undefined);
        return;
      }
    }

    let value;
    try {
      const set = await telegramApi("getStickerSet", { name: setName });
      value = {
        valid: true,
        name: set.name,
        title: set.title,
        stickerCount: set.stickers.length
      };
    } catch (error) {
      value = { valid: false, name: setName, error: redactError(error) };
    }
    metadata.set(key, value.valid ? value : undefined);
    await writeFile(cachePath, `${JSON.stringify(value)}\n`);
  });
}

function chooseCandidate(product, associations, metadata) {
  const scored = candidateScores(product, associations, metadata);
  const best = scored[0];
  if (!best) return undefined;
  const strongTitle = Math.max(
    best.setSimilarity,
    best.firstLineSimilarity,
    best.transliteratedTitleSimilarity,
    best.setNameSimilarity
  ) >= 0.72;
  const exactCountEvidence = best.set.stickerCount === stickerCount(product) && best.score >= 100;
  if (best.score < 95 || (!strongTitle && !exactCountEvidence)) return undefined;
  return best;
}

function candidateScores(product, associations, metadata) {
  const productTitle = normalizeTitle(product.title);
  const transliteratedProductTitle = normalizeLatin(transliterateRu(productTitle));
  const expectedCount = stickerCount(product);
  const uniqueAssociations = deduplicateAssociations(associations);
  const scored = [];

  for (const association of uniqueAssociations) {
    const set = metadata.get(association.setName.toLowerCase());
    if (!set) continue;
    const setTitle = normalizeTitle(set.title);
    const latinSetTitle = normalizeLatin(set.title);
    const latinSetName = normalizeLatin(set.name.replace(/(?:_vk|vk|_animated|animated)$/gi, ""));
    const firstLine = normalizeTitle(association.text.split("\n").find((line) => line.trim()) ?? "");
    const fullText = normalizeTitle(association.text);
    const setSimilarity = titleSimilarity(productTitle, setTitle);
    const firstLineSimilarity = titleSimilarity(productTitle, firstLine);
    const transliteratedTitleSimilarity = fuzzySimilarity(transliteratedProductTitle, latinSetTitle);
    const setNameSimilarity = fuzzySimilarity(transliteratedProductTitle, latinSetName);
    let score =
      setSimilarity * 120 +
      firstLineSimilarity * 100 +
      Math.max(transliteratedTitleSimilarity, setNameSimilarity) * 90;
    if (containsPhrase(fullText, productTitle)) score += 30;
    if (set.stickerCount === expectedCount) score += 45;
    else if (set.stickerCount >= expectedCount) score += Math.max(10, 30 - (set.stickerCount - expectedCount));
    else score += Math.max(-25, 10 - (expectedCount - set.stickerCount) * 2);
    if (/(_vk|vk)$/i.test(set.name)) score += 8;
    if (association.channel.toLowerCase() === "stickers_vk") score += 5;
    scored.push({
      association,
      set,
      score,
      setSimilarity,
      firstLineSimilarity,
      transliteratedTitleSimilarity,
      setNameSimilarity
    });
  }

  const bestBySet = new Map();
  for (const candidate of scored) {
    const key = candidate.set.name.toLowerCase();
    const existing = bestBySet.get(key);
    if (!existing || candidate.score > existing.score) bestBySet.set(key, candidate);
  }
  return [...bestBySet.values()].sort(
    (left, right) => right.score - left.score || right.set.stickerCount - left.set.stickerCount
  );
}

function toCandidate(product, selected) {
  return {
    vkProductId: Number(product.id),
    vkTitle: product.title,
    telegramSetNames: [selected.set.name],
    discovery: {
      telegramTitle: selected.set.title,
      telegramStickerCount: selected.set.stickerCount,
      vkStickerCount: stickerCount(product),
      sourceChannel: selected.association.channel,
      sourcePost: selected.association.post,
      score: Number(selected.score.toFixed(2))
    }
  };
}

function normalizeTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/@[a-z0-9_]+/gi, " ")
    .replace(/\b(?:telegram|стикеры|стикерпак|stickers?|vk|вк|от)\b/giu, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function titleSimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (right.startsWith(`${left} `) || left.startsWith(`${right} `)) return 0.85;
  if (containsPhrase(left, right) || containsPhrase(right, left)) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }
  const leftTokens = new Set(left.split(" ").filter((token) => token.length > 1));
  const rightTokens = new Set(right.split(" ").filter((token) => token.length > 1));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function fuzzySimilarity(left, right) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const phraseSimilarity = titleSimilarity(left, right);
  if (left.length < 3 || right.length < 3) return phraseSimilarity;
  const distance = levenshtein(left, right);
  return Math.max(phraseSimilarity, 1 - distance / Math.max(left.length, right.length));
}

function levenshtein(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function normalizeLatin(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/@[a-z0-9_]+/g, " ")
    .replace(/\b(?:telegram|tgsticker|stickers?|stikeronn|vk|animated|ot|from)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function transliterateRu(value) {
  const letters = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u",
    ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sch", ы: "y", э: "e", ю: "yu", я: "ya",
    ь: "", ъ: ""
  };
  return [...value].map((character) => letters[character] ?? character).join("");
}

function guessSetNames(title) {
  const transliterated = transliterateRu(normalizeTitle(title))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const compact = transliterated.replace(/_/g, "");
  return unique([
    `${transliterated}_vk`,
    transliterated,
    `${compact}_vk`,
    compact,
    `vk_${transliterated}`
  ]).filter((value) => value.length >= 3 && value.length <= 64);
}

function containsPhrase(text, phrase) {
  return Boolean(text && phrase && (` ${text} `).includes(` ${phrase} `));
}

function htmlToText(value) {
  return decodeHtml(
    value
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<\/p\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function decodeHtml(value) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function deduplicateAssociations(associations) {
  const output = [];
  const seen = new Set();
  for (const association of associations) {
    const key = `${association.setName.toLowerCase()}:${association.channel.toLowerCase()}:${association.post ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(association);
  }
  return output;
}

async function telegramApi(method, body) {
  const response = await fetchWithRetry(`https://api.telegram.org/bot${telegramToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram ${method}: ${payload.error_code} ${payload.description}`);
  return payload.result;
}

async function fetchWithRetry(url, init, attempt = 0) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after")) || 0;
      await sleep(Math.max(retryAfter * 1000, 600 * 2 ** attempt));
      return fetchWithRetry(url, init, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt >= 5) throw error;
    await sleep(600 * 2 ** attempt);
    return fetchWithRetry(url, init, attempt + 1);
  }
}

async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        output[index] = await mapper(values[index], index);
      } catch (error) {
        console.warn(`WARN ${index + 1}/${values.length}: ${redactError(error)}`);
        output[index] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output.filter(Boolean);
}

function progress(label, index, total, value) {
  if (index === 0 || (index + 1) % 25 === 0 || index + 1 === total) {
    console.log(`${label}: ${index + 1}/${total}${value ? ` (${value})` : ""}`);
  }
}

function stickerCount(product) {
  return Array.isArray(product.stickers) ? product.stickers.length : 0;
}

function safeFilename(value) {
  return value.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 180);
}

function unique(values) {
  return [...new Set(values)];
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readJsonIfExists(path) {
  try {
    return await readJson(path);
  } catch {
    return undefined;
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function numberArg(name) {
  const separateIndex = process.argv.indexOf(name);
  const raw = separateIndex >= 0
    ? process.argv[separateIndex + 1]
    : process.argv.find((value) => value.startsWith(`${name}=`))?.split("=")[1];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
