import { createHash, randomInt } from "node:crypto";
import { promisify } from "node:util";
import { gunzip as gunzipCallback } from "node:zlib";

const gunzip = promisify(gunzipCallback);

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryDelayMs(attempt: number, baseMs: number, maxMs = 30_000): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  const jitter = Math.floor(exponential * 0.2 * Math.random());
  return Math.min(maxMs, exponential + jitter);
}

export function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs: number
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
  return fetch(input, { ...init, signal });
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function truncate(input: string, max: number): string {
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1))}…`;
}

export function normalizeTopicName(input: string): string {
  return truncate(input.replace(/\s+/g, " ").trim() || "VK dialog", 128);
}

export function randomId(): number {
  return randomInt(1, 2_147_483_647);
}

export function stableHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function asNumber(value: bigint): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue)) {
    throw new Error(`Value is not a safe integer: ${value.toString()}`);
  }
  return numberValue;
}

export function compactText(parts: Array<string | undefined | null>): string {
  return parts.filter((part): part is string => Boolean(part && part.trim())).join("\n");
}

export function fileNameFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : fallback;
  } catch {
    return fallback;
  }
}

export async function readResponseBodyWithinLimit(response: Response, maxBytes: number): Promise<Buffer> {
  assertPositiveByteLimit(maxBytes, "Remote media limit");
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      if (value.byteLength > maxBytes - receivedBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`Remote media exceeds configured limit: ${maxBytes} bytes`);
      }

      chunks.push(value);
      receivedBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, receivedBytes);
}

export async function gunzipWithinLimit(input: Buffer, maxOutputBytes: number): Promise<Buffer> {
  assertPositiveByteLimit(maxOutputBytes, "TGS decompressed media limit");

  try {
    return await gunzip(input, { maxOutputLength: maxOutputBytes });
  } catch (error) {
    if (isOutputLimitError(error)) {
      throw new Error(`VK animated sticker exceeds configured decompressed limit: ${maxOutputBytes} bytes`, {
        cause: error
      });
    }
    throw error;
  }
}

function assertPositiveByteLimit(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function isOutputLimitError(error: unknown): boolean {
  return (
    error instanceof RangeError ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "ERR_BUFFER_TOO_LARGE")
  );
}
