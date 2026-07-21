import "dotenv/config";
import { chmod, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { sessions, TelegramClient as MtprotoTelegramClient } from "telegram";

const apiId = Number.parseInt(process.env.TELEGRAM_API_ID ?? "", 10);
const apiHash = process.env.TELEGRAM_API_HASH?.trim();
if (!Number.isFinite(apiId) || !apiHash) {
  throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before running telegram:login");
}

const input = createInterface({ input: stdin, output: stdout });
const session = new sessions.StringSession("");
const client = new MtprotoTelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
const sessionOutputPath = process.env.TELEGRAM_USER_SESSION_OUTPUT?.trim() || ".telegram-user-session";

const sessionOutputFileName = basename(resolve(sessionOutputPath));
if (sessionOutputFileName === ".env" || sessionOutputFileName.startsWith(".env.")) {
  throw new Error("Refusing to overwrite an environment file; set TELEGRAM_USER_SESSION_OUTPUT to a separate protected file");
}

try {
  await client.start({
    phoneNumber: async () => input.question("Telegram phone: "),
    phoneCode: async () => input.question("Telegram code: "),
    password: async () => hiddenQuestion("Telegram 2FA password: "),
    onError: (error) => {
      console.error(error.message);
    }
  });
  await writeFile(sessionOutputPath, `${session.save()}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(sessionOutputPath, 0o600);
  console.log(`\nTelegram session saved to ${sessionOutputPath} with mode 0600.`);
  console.log("Copy its value into TELEGRAM_USER_SESSION in .env, then remove the file when it is no longer needed.");
} finally {
  input.close();
  await client.disconnect().catch(() => undefined);
}

async function hiddenQuestion(prompt: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error("Telegram 2FA password requires an interactive TTY");
  }

  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();

  return new Promise<string>((resolvePassword, rejectPassword) => {
    let password = "";

    const finish = (error?: Error): void => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdout.write("\n");
      if (error) {
        rejectPassword(error);
        return;
      }
      resolvePassword(password);
    };

    const onData = (chunk: Buffer): void => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("Telegram login cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          password = password.slice(0, -1);
          continue;
        }
        if (character >= " ") password += character;
      }
    };

    stdin.on("data", onData);
  });
}
