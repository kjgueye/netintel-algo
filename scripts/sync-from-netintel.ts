/**
 * sync-from-netintel.ts — replay NetIntel's route/util sources into this repo.
 *
 * src/routes/*.ts and src/utils/*.ts are byte-identical copies of NetIntel's
 * (Base). They are payment-agnostic — plain Express routers with handler logic
 * only — so the SAME files serve Algorand here, given src/config.ts exposes the
 * same config/pricing/timeouts symbols backed by Algorand env vars.
 *
 * Keeping the copies verbatim is what makes upstream fixes a one-command replay
 * instead of a 70-file hand-merge. Anything that would require editing a copied
 * file belongs in src/config.ts or src/index.ts instead.
 *
 * Usage:
 *   npm run sync:from-netintel            # write changes
 *   npm run sync:from-netintel -- --check # report drift, write nothing (exit 1 if drift)
 *
 * NETINTEL_SRC overrides the NetIntel checkout location (default: ../NetIntel).
 *
 * This script only ever READS from the NetIntel repo. It never writes there.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const netintelRoot = resolve(repoRoot, process.env.NETINTEL_SRC ?? "../NetIntel");
const checkOnly = process.argv.includes("--check");

// Directories copied verbatim: <NetIntel src>/<from> -> <this repo>/src/<to>
const DIRS = [
  { from: "routes", to: "routes" },
  { from: "utils", to: "utils" },
];

/** NetIntel is authored on Windows (CRLF). Normalize so diffs are real changes. */
function normalize(source: string): string {
  return source.replace(/\r\n/g, "\n");
}

function netintelSha(): string {
  try {
    return execFileSync("git", ["-C", netintelRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

let copied = 0;
const drifted: string[] = [];

for (const { from, to } of DIRS) {
  const srcDir = join(netintelRoot, "src", from);
  const destDir = join(repoRoot, "src", to);

  let entries: string[];
  try {
    entries = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  } catch {
    throw new Error(
      `Cannot read ${srcDir}. Is NetIntel checked out? Set NETINTEL_SRC to its path.`
    );
  }

  mkdirSync(destDir, { recursive: true });

  for (const file of entries) {
    const next = normalize(readFileSync(join(srcDir, file), "utf8"));
    const destPath = join(destDir, file);

    let current: string | null = null;
    try {
      current = readFileSync(destPath, "utf8");
    } catch {
      current = null;
    }

    if (current === next) continue;

    drifted.push(`src/${to}/${file}`);
    if (!checkOnly) {
      writeFileSync(destPath, next);
      copied++;
    }
  }
}

const sha = netintelSha();

if (checkOnly) {
  if (drifted.length === 0) {
    console.log(`In sync with NetIntel @ ${sha.slice(0, 8)} — no drift.`);
    process.exit(0);
  }
  console.error(`Drift vs NetIntel @ ${sha.slice(0, 8)} in ${drifted.length} file(s):`);
  for (const f of drifted) console.error(`  ${f}`);
  console.error("\nRun `npm run sync:from-netintel` to replay them.");
  process.exit(1);
}

// Record what we synced from, so drift is auditable without re-running the diff.
writeFileSync(
  join(repoRoot, "src", "SYNCED-FROM.txt"),
  [
    "src/routes and src/utils are VERBATIM copies from the NetIntel (Base) repo.",
    "Do not hand-edit them — edits belong in src/config.ts or src/index.ts, or",
    "upstream in NetIntel. Regenerate with: npm run sync:from-netintel",
    "",
    `netintel-commit: ${sha}`,
    "",
  ].join("\n")
);

console.log(
  copied === 0
    ? `Already in sync with NetIntel @ ${sha.slice(0, 8)}.`
    : `Synced ${copied} file(s) from NetIntel @ ${sha.slice(0, 8)}.`
);
