export function shortError(error, secrets = []) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message, secrets).replace(/\s+/g, " ").slice(0, 300);
}

export function safeRemoteLabel(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "remote source";
  }
}

export function redactSensitiveText(value, secrets = []) {
  let redacted = String(value);
  for (const secret of secrets) {
    if (secret) redacted = redacted.replaceAll(secret, "<redacted>");
  }

  return redacted
    .replace(/https?:\/\/\S+/gi, "<redacted-url>")
    .replace(/\b(?:bot)?\d{6,}:[A-Za-z0-9_-]+\b/g, "<redacted>")
    .replace(/\b(?:access[_-]?token|api[_-]?key|authorization)\s*[=:]\s*[^\s,;]+/gi, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      return `${match.split(separator, 1)[0]}${separator}<redacted>`;
    });
}
