const defaultScanMaxProductId = 20_000;
const productIdBatchSize = 2_000;
const extendedBatchSize = 100;
const minimumRequestIntervalMs = 350;

let catalogPromise;
let lastVkRequestAt = 0;

export function loadVkStickerCatalog({ token, apiVersion = "5.199", scanMaxProductId } = {}) {
  if (!token?.trim()) throw new Error("Missing VK_ACCESS_TOKEN");
  if (!catalogPromise) {
    catalogPromise = buildVkStickerCatalog({
      token: token.trim(),
      apiVersion,
      scanMaxProductId
    }).catch((error) => {
      catalogPromise = undefined;
      throw error;
    });
  }
  return catalogPromise;
}

async function buildVkStickerCatalog({ token, apiVersion, scanMaxProductId }) {
  const promoted = await vkProducts({ token, apiVersion, filters: "promoted", extended: 1 });
  const purchased = await vkProducts({ token, apiVersion, filters: "purchased", extended: 1 });
  const storefront = mergeProducts(promoted, purchased);
  const highestVisibleId = Math.max(0, ...storefront.map((product) => Number(product.id) || 0));
  const configuredMax = positiveInteger(
    scanMaxProductId ?? process.env.VK_STICKER_PRODUCT_ID_MAX,
    "VK_STICKER_PRODUCT_ID_MAX"
  );
  const maximumProductId = configuredMax ?? Math.max(defaultScanMaxProductId, highestVisibleId + 5_000);
  const discoveredIds = new Set();

  const idBatches = chunk(range(1, maximumProductId), productIdBatchSize);
  for (let index = 0; index < idBatches.length; index += 1) {
    const batch = idBatches[index];
    const products = await vkProducts({
      token,
      apiVersion,
      productIds: batch,
      extended: 0
    });
    for (const product of products) {
      const id = Number(product.id);
      if (id > 0) discoveredIds.add(id);
    }
    console.log(
      `VK historical catalog scan: ${index + 1}/${idBatches.length} ` +
        `(IDs ${batch[0]}-${batch.at(-1)}, found ${discoveredIds.size})`
    );
  }

  const storefrontIds = new Set(storefront.map((product) => Number(product.id)));
  const hiddenIds = [...discoveredIds]
    .filter((id) => !storefrontIds.has(id))
    .sort((left, right) => left - right);
  const hidden = [];
  const hiddenBatches = chunk(hiddenIds, extendedBatchSize);
  for (let index = 0; index < hiddenBatches.length; index += 1) {
    hidden.push(
      ...(await vkProducts({
        token,
        apiVersion,
        productIds: hiddenBatches[index],
        extended: 1
      }))
    );
    if (index === 0 || (index + 1) % 5 === 0 || index + 1 === hiddenBatches.length) {
      console.log(`VK hidden pack metadata: ${index + 1}/${hiddenBatches.length}`);
    }
  }

  const products = mergeProducts(storefront, hidden);
  const loadedIds = new Set(products.map((product) => Number(product.id)));
  const missingMetadataIds = [...discoveredIds].filter((id) => !loadedIds.has(id));
  if (missingMetadataIds.length) {
    throw new Error(
      `VK returned ${missingMetadataIds.length} historical product IDs without metadata: ` +
        `${missingMetadataIds.slice(0, 20).join(", ")}`
    );
  }

  return {
    promoted,
    purchased,
    hidden: hidden.sort((left, right) => Number(left.id) - Number(right.id)),
    products,
    scanMaxProductId: maximumProductId
  };
}

async function vkProducts({ token, apiVersion, filters, productIds, extended }) {
  const response = await vkApi(
    "store.getProducts",
    {
      type: "stickers",
      ...(filters ? { filters } : {}),
      ...(productIds?.length ? { product_ids: productIds.join(",") } : {}),
      extended
    },
    { token, apiVersion }
  );
  return Array.isArray(response) ? response : response?.items ?? [];
}

async function vkApi(method, params, { token, apiVersion }, attempt = 0) {
  const sinceLastRequest = Date.now() - lastVkRequestAt;
  if (sinceLastRequest < minimumRequestIntervalMs) {
    await sleep(minimumRequestIntervalMs - sinceLastRequest);
  }

  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) form.set(key, String(value));
  form.set("v", apiVersion);
  lastVkRequestAt = Date.now();
  const response = await fetchWithRetry(`https://api.vk.ru/method/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: form
  });
  const payload = await response.json();
  if (payload.error && [6, 9, 10, 29].includes(Number(payload.error.error_code)) && attempt < 6) {
    await sleep(700 * 2 ** attempt);
    return vkApi(method, params, { token, apiVersion }, attempt + 1);
  }
  if (payload.error) {
    throw new Error(`VK ${method}: ${payload.error.error_code} ${payload.error.error_msg}`);
  }
  return payload.response;
}

async function fetchWithRetry(url, init, attempt = 0) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
      await response.body?.cancel();
      const retryAfter = Number(response.headers.get("retry-after")) || 0;
      await sleep(Math.max(retryAfter * 1_000, 700 * 2 ** attempt));
      return fetchWithRetry(url, init, attempt + 1);
    }
    return response;
  } catch (error) {
    if (attempt >= 5) throw error;
    await sleep(700 * 2 ** attempt);
    return fetchWithRetry(url, init, attempt + 1);
  }
}

function mergeProducts(...lists) {
  const products = new Map();
  for (const product of lists.flat()) {
    const id = Number(product.id);
    if (!id) continue;
    const existing = products.get(id);
    if (!existing || stickerCount(product) > stickerCount(existing)) products.set(id, product);
  }
  return [...products.values()].sort((left, right) => Number(left.id) - Number(right.id));
}

function stickerCount(product) {
  return Array.isArray(product?.stickers) ? product.stickers.length : 0;
}

function range(start, endInclusive) {
  return Array.from({ length: endInclusive - start + 1 }, (_, index) => start + index);
}

function chunk(values, size) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function positiveInteger(value, name) {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
