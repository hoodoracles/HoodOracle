// Load .env.local for standalone scripts.
//
// Next.js loads .env.local automatically; plain node does not. Without this a
// script reports a provider as disabled while the running app has it enabled,
// which is a confusing way to find out your test rig and your service disagree.

import { existsSync, readFileSync } from "node:fs";

export function loadEnv(file = ".env.local"): void {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Real environment wins, so `FOO=bar npm run x` still overrides the file.
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();
