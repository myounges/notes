import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { bootstrapPassword, authConfigured } from "./auth.js";
import { ensureDirs } from "../storage/notes.js";

async function main(): Promise<void> {
  await ensureDirs();
  if (authConfigured()) {
    console.warn("Auth is already configured. Running again will overwrite the password.");
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const password = await rl.question("New password (min 8 chars): ");
  rl.close();
  const pwd = password.trim();
  await bootstrapPassword(pwd);
  console.log(`Password set. Auth config written to ${/* config */ (await import("./config.js")).config.configDir}/auth.json`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});