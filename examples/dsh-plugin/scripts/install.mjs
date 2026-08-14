#!/usr/bin/env node
// Install the OpenViking memory plugin into a dsh profile's cordis.patch.yml.
//
// Usage:
//   node scripts/install.mjs [--profile <name>] [--mcp]
//
//   --profile <name>  profile under $DSH_HOME/profiles (default: tui)
//   --mcp             also install @deepseek-ai/dsh-mcp-client and mount the
//                     OpenViking /mcp endpoint for the full tool closure
//
// Idempotent: existing entries are left untouched. The patch layer uses a
// root-level `insert` because the profile patch semantics only override or
// insert into the composed entry list — a bare entry is rejected.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ENTRY = resolve(HERE, "..", "src", "index.mjs");

const args = process.argv.slice(2);
const profileArg = args.find((arg) => arg.startsWith("--profile"));
const profile = profileArg ? profileArg.split("=")[1] || args[args.indexOf(profileArg) + 1] : "tui";
const withMcp = args.includes("--mcp");

const dshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const profileDir = join(dshHome, "profiles", profile);
const patchPath = join(profileDir, "cordis.patch.yml");

if (!existsSync(profileDir)) {
  console.error(`dsh profile not found: ${profileDir}`);
  process.exit(1);
}

function appendEntries(entries, marker) {
  let patch = existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
  if (patch.includes(marker)) {
    console.log(`already installed: ${marker} present in ${patchPath}`);
    return false;
  }
  if (patch.length > 0 && !patch.endsWith("\n")) patch += "\n";
  writeFileSync(patchPath, patch + entries);
  console.log(`updated ${patchPath}`);
  return true;
}

appendEntries(
  `\n# OpenViking long-term memory (installed by examples/dsh-plugin/scripts/install.mjs)\n`
    + `- insert:\n`
    + `    - id: openviking\n`
    + `      name: '${PLUGIN_ENTRY}'\n`
    + `      config:\n`
    + `        autoRecall: true\n`
    + `        autoCapture: true\n`
    + `        commitTurnThreshold: 8\n`,
  "id: openviking",
);

if (withMcp) {
  appendEntries(
    `\n# OpenViking MCP tool closure (installed by examples/dsh-plugin/scripts/install.mjs)\n`
      + `- insert:\n`
      + `    - id: openviking-mcp\n`
      + `      name: '@deepseek-ai/dsh-mcp-client'\n`
      + `      config:\n`
      + `        serverName: openviking\n`
      + `        transport: streamable-http\n`
      + `        url: 'http://127.0.0.1:1933/mcp'\n`,
    "id: openviking-mcp",
  );
  try {
    execFileSync("dsh", ["plugin", "--profile", profile, "--", "add", "@deepseek-ai/dsh-mcp-client"], {
      stdio: "inherit",
    });
    console.log("installed @deepseek-ai/dsh-mcp-client into the profile");
  } catch {
    console.error("could not run `dsh plugin add` — install @deepseek-ai/dsh-mcp-client manually in the profile");
  }
}

console.log(`\nDone. Restart your dsh (or reload the profile) and verify with /viking.`);
