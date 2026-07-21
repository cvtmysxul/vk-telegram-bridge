import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { safeRemoteLabel, shortError } from "./lib/safe-log.mjs";
import { loadVkStickerCatalog } from "./vk-sticker-catalog.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manualCandidatesPath = resolve(root, "sticker-pack-candidates.json");
const discoveredCandidatesPath = resolve(root, "sticker-pack-candidates.discovered.json");
const outputPath = resolve(root, "sticker-mapping.json");
const cacheDir = resolve(root, ".cache/sticker-map");
const telegramSetCacheDir = resolve(cacheDir, "telegram-sets");
const args = new Set(process.argv.slice(2));
const productFilter = numberArg("--product");
const threshold = numberArg("--threshold") ?? 22;
const debugVkIndex = numberArg("--debug-vk-index");
const shouldWrite = !args.has("--dry-run");
const visualMatch = args.has("--visual");
const refresh = args.has("--refresh");

const telegramToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const vkToken = requiredEnv("VK_ACCESS_TOKEN");
const vkApiVersion = process.env.VK_API_VERSION || "5.199";
const redactError = (error) => shortError(error, [telegramToken, vkToken]);

await mkdir(telegramSetCacheDir, { recursive: true });
const [manualCandidates, discoveredDocument, vkCatalog] = await Promise.all([
  readJson(manualCandidatesPath),
  readJson(discoveredCandidatesPath),
  loadVkStickerCatalog({ token: vkToken, apiVersion: vkApiVersion })
]);
const candidates = mergeCandidates(discoveredDocument.candidates ?? [], manualCandidates);
const products = vkCatalog.products;
const productsById = new Map(products.map((product) => [Number(product.id), product]));
const selectedCandidates = candidates
  .filter((candidate) => productsById.has(Number(candidate.vkProductId)))
  .filter((candidate) => !productFilter || candidate.vkProductId === productFilter)
  .sort((left, right) => left.vkProductId - right.vkProductId);

if (!selectedCandidates.length) {
  throw new Error(`No candidate configuration for VK product ${productFilter}`);
}

console.log(
  `VK catalog: ${vkCatalog.promoted.length} promoted + ${vkCatalog.purchased.length} purchased + ` +
    `${vkCatalog.hidden.length} hidden = ${products.length} unique (scanned through ${vkCatalog.scanMaxProductId}); ` +
    `${selectedCandidates.length} configured`
);

const telegramSetNames = unique(
  selectedCandidates.flatMap((candidate) => candidate.telegramSetNames)
);
const telegramSetResults = await mapLimit(
  telegramSetNames,
  6,
  async (setName, index) => {
    if (index % 25 === 0 || index + 1 === telegramSetNames.length) {
      console.log(`Telegram sets: ${index + 1}/${telegramSetNames.length} ${setName}`);
    }
    return getStickerSetCached(setName);
  },
  "Telegram set"
);
const telegramSetsByName = new Map(
  telegramSetResults
    .filter(Boolean)
    .map((set) => [set.name.toLowerCase(), set])
);
const outputPacks = [];
let configuredStickerCount = 0;

for (const [candidateIndex, candidate] of selectedCandidates.entries()) {
  const product = productsById.get(candidate.vkProductId);
  if (!product) {
    console.warn(`SKIP ${candidate.vkProductId} ${candidate.vkTitle}: pack is not available to the VK token`);
    continue;
  }

  const vkStickers = Array.isArray(product.stickers) ? product.stickers : [];
  configuredStickerCount += vkStickers.length;
  const telegramSets = candidate.telegramSetNames
    .map((setName) => telegramSetsByName.get(setName.toLowerCase()))
    .filter(Boolean);

  if (!vkStickers.length || !telegramSets.length) {
    console.warn(`SKIP ${candidate.vkProductId} ${candidate.vkTitle}: no stickers or Telegram sets`);
    continue;
  }

  const telegramStickerSources = telegramSets.flatMap((set) =>
    set.stickers.map((sticker, index) => ({ set, sticker, index }))
  );
  const vkFingerprints = visualMatch
    ? await mapLimit(vkStickers, 6, async (sticker) => ({
        sticker,
        fingerprint: await vkStickerFingerprint(sticker)
      }), "VK fingerprint")
    : vkStickers.map((sticker) => ({ sticker }));
  const telegramFingerprints = visualMatch
    ? await mapLimit(telegramStickerSources, 6, async (source) => ({
        ...source,
        fingerprint: await telegramStickerFingerprint(source.sticker)
      }), "Telegram fingerprint")
    : telegramStickerSources;

  const matches = visualMatch
    ? visualMatches(vkFingerprints, telegramFingerprints, threshold)
    : configuredOrderMatches(candidate, vkStickers, telegramStickerSources);

  const matchesBySet = new Map();
  for (const match of matches) {
    const vk = vkFingerprints[match.vkIndex].sticker;
    const telegram = telegramFingerprints[match.telegramIndex];
    const list = matchesBySet.get(telegram.set.name) ?? [];
    list.push({
      vkStickerId: Number(vk.sticker_id ?? vk.id),
      telegramFileUniqueId: telegram.sticker.file_unique_id,
      vkIndex: match.vkIndex,
      distance: match.distance
    });
    matchesBySet.set(telegram.set.name, list);
  }

  for (const set of telegramSets) {
    const setMatches = matchesBySet.get(set.name) ?? [];
    if (!setMatches.length) continue;
    setMatches.sort((left, right) => left.vkIndex - right.vkIndex);
    outputPacks.push({
      vkProductId: candidate.vkProductId,
      vkTitle: product.title || candidate.vkTitle,
      telegramSetName: set.name,
      telegramTitle: set.title,
      stickers: setMatches.map(({ vkStickerId, telegramFileUniqueId }) => ({
        vkStickerId,
        telegramFileUniqueId
      }))
    });
  }

  const average = visualMatch && matches.length
    ? (matches.reduce((sum, match) => sum + match.distance, 0) / matches.length).toFixed(2)
    : undefined;
  const complete = matches.length === vkStickers.length;
  if (!complete || productFilter || candidateIndex === 0 || (candidateIndex + 1) % 100 === 0 || candidateIndex + 1 === selectedCandidates.length) {
    console.log(
      `${complete ? "OK" : "PARTIAL"} ${candidate.vkProductId} ${product.title}: ` +
        `${matches.length}/${vkStickers.length}${average ? `, average distance ${average}` : ", curated order mapping"}`
    );
  }
  if (visualMatch) {
    console.log(
      `  ${[...matchesBySet.entries()].map(([setName, setMatches]) => `${setName}: ${setMatches.length}`).join(", ")}`
    );
    if (productFilter) {
      console.log(
        matches
          .sort((left, right) => left.vkIndex - right.vkIndex)
          .map((match) => {
            const source = telegramFingerprints[match.telegramIndex];
            return `  VK[${match.vkIndex}] -> ${source.set.name}[${source.index}], distance ${match.distance.toFixed(2)}`;
          })
          .join("\n")
      );
    }
  }
}

outputPacks.sort((left, right) => left.vkProductId - right.vkProductId || left.telegramSetName.localeCompare(right.telegramSetName));
validateOutput(outputPacks);
const mappedProductIds = new Set(outputPacks.map((pack) => pack.vkProductId));
const mappedVkStickerIds = new Set(
  outputPacks.flatMap((pack) => pack.stickers.map((sticker) => sticker.vkStickerId))
);
const configuredProductIds = new Set(selectedCandidates.map((candidate) => candidate.vkProductId));
const uniqueSourceStickerIds = new Set(
  products.flatMap((product) =>
    (Array.isArray(product.stickers) ? product.stickers : [])
      .map((sticker) => Number(sticker.sticker_id ?? sticker.id))
      .filter(Boolean)
  )
);
const missingProducts = products
  .filter((product) => !mappedProductIds.has(Number(product.id)))
  .map((product) => ({
    vkProductId: Number(product.id),
    vkTitle: product.title,
    stickerCount: Array.isArray(product.stickers) ? product.stickers.length : 0
  }))
  .sort((left, right) => left.vkProductId - right.vkProductId);
const output = {
  version: 1,
  generatedAt: new Date().toISOString(),
  catalog: {
    promotedPacks: vkCatalog.promoted.length,
    purchasedPacks: vkCatalog.purchased.length,
    hiddenPacks: vkCatalog.hidden.length,
    scanMaxProductId: vkCatalog.scanMaxProductId,
    uniquePacks: products.length,
    configuredPacks: configuredProductIds.size,
    mappedPacks: mappedProductIds.size,
    missingPacks: missingProducts.length,
    uniqueVkStickers: uniqueSourceStickerIds.size,
    mappedVkStickers: mappedVkStickerIds.size
  },
  missingPacks: missingProducts,
  packs: outputPacks
};

if (shouldWrite) {
  if (productFilter) {
    throw new Error("Refusing to overwrite the complete map with --product; add --dry-run or run without --product");
  }
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`WROTE ${outputPath}`);
}
console.log(
  `TOTAL ${mappedVkStickerIds.size}/${uniqueSourceStickerIds.size} unique VK stickers mapped; ` +
    `${mappedProductIds.size}/${products.length} packs, ${outputPacks.length} set mappings; ` +
    `${configuredStickerCount} configured pack sticker slots`
);

async function getStickerSetCached(setName) {
  const cachePath = resolve(
    telegramSetCacheDir,
    `${createHash("sha256").update(setName.toLowerCase()).digest("hex")}.json`
  );
  if (!refresh) {
    try {
      const cached = await readJson(cachePath);
      if (cached?.name && Array.isArray(cached.stickers)) return cached;
    } catch {}
  }
  const set = await telegramApi("getStickerSet", { name: setName });
  await writeFile(cachePath, `${JSON.stringify(set)}\n`);
  return set;
}

async function vkStickerFingerprint(sticker) {
  const stickerId = Number(sticker.sticker_id ?? sticker.id);
  if (!stickerId) return undefined;
  const source =
    bestImage(sticker.images) ||
    bestImage(sticker.images_with_background) ||
    `https://vk.ru/sticker/1-${stickerId}-512-`;
  return cachedFingerprint(`vk:${stickerId}:${source}`, () => fetchBuffer(source));
}

async function telegramStickerFingerprint(sticker) {
  if (!sticker.file_unique_id) return undefined;
  const source = (sticker.is_animated || sticker.is_video) && sticker.thumbnail ? sticker.thumbnail : sticker;
  return cachedFingerprint(`tg:${source.file_unique_id ?? sticker.file_unique_id}`, async () => {
    const file = await telegramApi("getFile", { file_id: source.file_id });
    if (!file.file_path) throw new Error(`Telegram file ${source.file_id} has no file_path`);
    return fetchBuffer(`https://api.telegram.org/file/bot${telegramToken}/${file.file_path}`);
  });
}

async function cachedFingerprint(key, load) {
  const cachePath = resolve(cacheDir, `${createHash("sha256").update(key).digest("hex")}.gray`);
  try {
    const cached = await readFile(cachePath);
    if (cached.length === 1024) return cached;
  } catch {}

  const fingerprint = await normalizeImage(await load());
  await writeFile(cachePath, fingerprint);
  return fingerprint;
}

function normalizeImage(buffer) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-vf",
      "scale=32:32:force_original_aspect_ratio=decrease,pad=32:32:(ow-iw)/2:(oh-ih)/2:color=white,format=gray",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1"
    ]);
    const chunks = [];
    const errors = [];
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(chunks);
      if (code !== 0 || output.length !== 1024) {
        reject(new Error(`ffmpeg fingerprint failed (${code}): ${Buffer.concat(errors).toString("utf8").trim()}`));
        return;
      }
      resolvePromise(output);
    });
    child.stdin.end(buffer);
  });
}

function fingerprintDistance(left, right) {
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference += Math.abs(left[index] - right[index]);
  }
  return difference / left.length;
}

function visualMatches(vkFingerprints, telegramFingerprints, maximumDistance) {
  const pairs = [];
  const distances = Array.from({ length: vkFingerprints.length }, () =>
    new Float64Array(telegramFingerprints.length).fill(Number.POSITIVE_INFINITY)
  );
  for (let vkIndex = 0; vkIndex < vkFingerprints.length; vkIndex += 1) {
    const vk = vkFingerprints[vkIndex];
    if (!vk?.fingerprint) continue;
    for (let telegramIndex = 0; telegramIndex < telegramFingerprints.length; telegramIndex += 1) {
      const telegram = telegramFingerprints[telegramIndex];
      if (!telegram?.fingerprint) continue;
      const distance = fingerprintDistance(vk.fingerprint, telegram.fingerprint);
      distances[vkIndex][telegramIndex] = distance;
      pairs.push({
        vkIndex,
        telegramIndex,
        distance,
        orderDistance: Math.abs(vkIndex - telegram.index)
      });
    }
  }
  pairs.sort((left, right) => left.distance - right.distance || left.orderDistance - right.orderDistance);
  if (debugVkIndex !== undefined) {
    console.log(
      pairs
        .filter((pair) => pair.vkIndex === debugVkIndex)
        .slice(0, 10)
        .map((pair) => {
          const source = telegramFingerprints[pair.telegramIndex];
          return `  VK index ${debugVkIndex} -> ${source.set.name}[${source.index}], distance ${pair.distance.toFixed(2)}`;
        })
        .join("\n")
    );
  }

  const rows = vkFingerprints.length + 1;
  const columns = telegramFingerprints.length + 1;
  const scores = new Float64Array(rows * columns);
  const trace = new Uint8Array(rows * columns);
  const gapPenalty = Math.max(5, maximumDistance * 0.25);
  let bestScore = 0;
  let bestRow = 0;
  let bestColumn = 0;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const distance = distances[row - 1][column - 1];
      const matchScore = Number.isFinite(distance) && distance <= maximumDistance
        ? maximumDistance - distance
        : -gapPenalty * 2;
      const diagonal = scores[(row - 1) * columns + column - 1] + matchScore;
      const above = scores[(row - 1) * columns + column] - gapPenalty;
      const left = scores[row * columns + column - 1] - gapPenalty;
      const index = row * columns + column;
      const score = Math.max(0, diagonal, above, left);
      scores[index] = score;
      trace[index] = score === 0 ? 0 : score === diagonal ? 1 : score === above ? 2 : 3;
      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
        bestColumn = column;
      }
    }
  }

  const matches = [];
  let row = bestRow;
  let column = bestColumn;
  while (row > 0 && column > 0) {
    const direction = trace[row * columns + column];
    if (!direction) break;
    if (direction === 1) {
      const distance = distances[row - 1][column - 1];
      if (distance <= maximumDistance) {
        matches.push({
          vkIndex: row - 1,
          telegramIndex: column - 1,
          distance,
          orderDistance: Math.abs(row - column)
        });
      }
      row -= 1;
      column -= 1;
    } else if (direction === 2) {
      row -= 1;
    } else {
      column -= 1;
    }
  }
  return matches.reverse();
}

function configuredOrderMatches(candidate, vkStickers, telegramStickerSources) {
  const defaultSetName = candidate.telegramSetNames[0];
  const segments = candidate.segments ?? [
    { telegramSetName: defaultSetName, vkStart: 0, telegramStart: 0 }
  ];
  const sourceIndex = new Map(
    telegramStickerSources.map((source, index) => [`${source.set.name.toLowerCase()}:${source.index}`, index])
  );
  const matches = [];

  for (const segment of segments) {
    const vkStart = segment.vkStart ?? 0;
    const telegramStart = segment.telegramStart ?? 0;
    const requestedCount = segment.count ?? Number.POSITIVE_INFINITY;
    for (let offset = 0; offset < requestedCount && vkStart + offset < vkStickers.length; offset += 1) {
      const telegramIndex = sourceIndex.get(`${segment.telegramSetName.toLowerCase()}:${telegramStart + offset}`);
      if (telegramIndex === undefined) break;
      matches.push({ vkIndex: vkStart + offset, telegramIndex, distance: 0, orderDistance: 0 });
    }
  }
  return matches;
}

function bestImage(images) {
  if (!Array.isArray(images)) return undefined;
  return [...images]
    .filter((image) => image && typeof image.url === "string")
    .sort((left, right) => (Number(right.width) || 0) * (Number(right.height) || 0) - (Number(left.width) || 0) * (Number(left.height) || 0))[0]?.url;
}

function mergeCandidates(discovered, manual) {
  const candidates = new Map();
  for (const candidate of discovered) candidates.set(Number(candidate.vkProductId), candidate);
  for (const candidate of manual) {
    const id = Number(candidate.vkProductId);
    if (candidate.disabled) candidates.delete(id);
    else candidates.set(id, candidate);
  }
  return [...candidates.values()];
}

function validateOutput(packs) {
  const vkToTelegram = new Map();
  for (const pack of packs) {
    for (const sticker of pack.stickers) {
      const existingTelegram = vkToTelegram.get(sticker.vkStickerId);
      if (existingTelegram && existingTelegram !== sticker.telegramFileUniqueId) {
        throw new Error(
          `VK sticker ${sticker.vkStickerId} maps to both ${existingTelegram} and ${sticker.telegramFileUniqueId}`
        );
      }
      vkToTelegram.set(sticker.vkStickerId, sticker.telegramFileUniqueId);
    }
  }
}

async function vkApi(method, params) {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) form.set(key, String(value));
  form.set("v", vkApiVersion);
  const response = await fetchWithRetry(`https://api.vk.ru/method/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${vkToken}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`VK ${method}: ${payload.error.error_code} ${payload.error.error_msg}`);
  return payload.response;
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

async function fetchBuffer(url) {
  const response = await fetchWithRetry(url);
  if (!response.ok) throw new Error(`Download failed ${response.status} from ${safeRemoteLabel(url)}`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchWithRetry(url, init, attempt = 0) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await response.body?.cancel();
      await sleep(750 * 2 ** attempt);
      return fetchWithRetry(url, init, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt >= 4) throw error;
    await sleep(750 * 2 ** attempt);
    return fetchWithRetry(url, init, attempt + 1);
  }
}

async function mapLimit(values, limit, mapper, label = "Task") {
  const output = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      try {
        output[index] = await mapper(values[index], index);
      } catch (error) {
        console.warn(`${label} ${index + 1}/${values.length} failed: ${redactError(error)}`);
        output[index] = undefined;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return output;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function unique(values) {
  return [...new Set(values)];
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function numberArg(name) {
  const separateIndex = process.argv.indexOf(name);
  const raw = separateIndex >= 0 ? process.argv[separateIndex + 1] : process.argv.find((value) => value.startsWith(`${name}=`))?.split("=")[1];
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}: ${raw}`);
  return value;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
