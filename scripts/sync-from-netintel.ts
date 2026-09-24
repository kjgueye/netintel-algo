/**
 * sync-from-netintel.ts — replay NetIntel's payment-agnostic source into this
 * repo, verbatim.
 *
 * src/routes/*.ts, src/utils/*.ts and src/services/*.ts are byte-identical
 * copies of NetIntel's: plain Express routers and helpers with handler logic
 * only — so the SAME files serve Algorand here, given src/config.ts and
 * src/accepts.ts expose the symbols they import (pricing, timeouts, paidAccepts…)
 * bound to Algorand instead of Base. A handful of single files (NetIntel's
 * config.ts → src/netintel-config.ts, mirror-402-body.ts, payment-headers.ts,
 * service-metadata.ts) are copied the same way.
 *
 * src/route-table.ts is GENERATED: the route table (helper consts + the
 * `routes` map + the post-map fixups) lifted out of NetIntel's src/index.ts,
 * plus the router imports, with an import header derived from what the lifted
 * text actually uses. NetIntel's index.ts interleaves Base wiring around that
 * table; the lift is anchored on markers and refuses (loudly) if Base wiring
 * or an unmapped module would leak through.
 *
 * Anything Algorand-specific belongs in src/config.ts, src/accepts.ts,
 * src/paywall.ts or src/index.ts — or upstream in NetIntel. Never hand-edit a synced file.
 *
 * This script only ever READS from the NetIntel repo. It never writes there.
 *
 *   npm run sync:from-netintel            # replay
 *   npm run sync:from-netintel -- --check # report drift, write nothing (exit 1 if drift)
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const netintelRoot = resolve(repoRoot, process.env.NETINTEL_SRC ?? "../NetIntel");
const checkOnly = process.argv.includes("--check");

// Directories copied verbatim: <NetIntel src>/<from> -> <this repo>/src/<to>
const DIRS = [
  { from: "routes", to: "routes" },
  { from: "utils", to: "utils" },
  { from: "services", to: "services" },
];

// Single files copied verbatim: <NetIntel src>/<from> -> <this repo>/src/<to>
const FILES = [
  // NetIntel's whole config module. src/config.ts re-exports its pricing /
  // timeouts / limits tables and shadows only `config` (the rail binding).
  { from: "config.ts", to: "netintel-config.ts" },
  { from: "mirror-402-body.ts", to: "mirror-402-body.ts" },
  { from: "payment-headers.ts", to: "payment-headers.ts" },
  { from: "head-challenge.ts", to: "head-challenge.ts" },
  { from: "service-metadata.ts", to: "service-metadata.ts" },
];

// Modules NetIntel's route table may import, mapped to what this repo provides.
// A relative module must exist here (synced copy or adapter); a bare module must
// be listed. Anything else used by the lifted text fails the sync.
const MODULE_MAP: Record<string, string> = {
  "@x402/extensions/bazaar": "@x402-avm/extensions",
  express: "express",
};

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

function writeIfChanged(destPath: string, next: string, label: string): void {
  let current: string | null = null;
  try {
    current = readFileSync(destPath, "utf8");
  } catch {
    current = null;
  }
  if (current === next) return;
  drifted.push(label);
  if (!checkOnly) {
    mkdirSync(dirname(destPath), { recursive: true });
    writeFileSync(destPath, next);
    copied++;
  }
}

for (const { from, to } of DIRS) {
  const srcDir = join(netintelRoot, "src", from);
  let entries: string[];
  try {
    entries = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
  } catch {
    throw new Error(
      `Cannot read ${srcDir}. Is NetIntel checked out? Set NETINTEL_SRC to its path.`
    );
  }
  for (const file of entries) {
    const next = normalize(readFileSync(join(srcDir, file), "utf8"));
    writeIfChanged(join(repoRoot, "src", to, file), next, `src/${to}/${file}`);
  }
}

for (const { from, to } of FILES) {
  const next = normalize(readFileSync(join(netintelRoot, "src", from), "utf8"));
  writeIfChanged(join(repoRoot, "src", to), next, `src/${to}`);
}

// --- src/route-table.ts ------------------------------------------------------

/**
 * Identifiers the source references as free variables: every Identifier node
 * that is not a property name, an object key, or declared in the source
 * itself. Parsed, not grepped — comments, strings and loop-locals (`path`,
 * `facilitator`…) in NetIntel's route table must not pull in Base imports.
 */
function freeIdentifiers(source: string): Set<string> {
  const sf = ts.createSourceFile("lift.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const referenced = new Set<string>();
  const declared = new Set<string>();
  const declareName = (name: ts.BindingName | ts.Identifier | undefined): void => {
    if (!name) return;
    if (ts.isIdentifier(name)) declared.add(name.text);
    else for (const el of name.elements) if (ts.isBindingElement(el)) declareName(el.name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)) declareName(node.name);
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) declared.add(node.name.text);
    else if (ts.isIdentifier(node)) {
      const p = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(p) && p.name === node) ||
        (ts.isPropertyAssignment(p) && p.name === node) ||
        (ts.isMethodDeclaration(p) && p.name === node) ||
        (ts.isPropertySignature(p) && p.name === node);
      if (!isPropertyName) referenced.add(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const d of declared) referenced.delete(d);
  return referenced;
}

function liftRouteTable(indexSource: string): string {
  const lines = normalize(indexSource).split("\n");
  const find = (re: RegExp, from = 0): number => {
    const i = lines.findIndex((l, idx) => idx >= from && re.test(l));
    if (i < 0) throw new Error(`lift: marker ${re} not found in NetIntel src/index.ts`);
    return i;
  };

  // Region 1: every helper const after the last landing/marketplace constant up
  // to the end of the `routes` map. Region 2: the post-map fixups (POST twins
  // for credential routes) through applyServiceMetadata(routes), with the
  // comment block directly above them.
  const start = find(/^const AGENTIC_MARKET_URL = /) + 1;
  const mapStart = find(/^const routes = \{$/, start);
  const mapEnd = find(/^\};$/, mapStart);
  const loopStart = find(/^const CREDENTIAL_IN_BODY_PATHS = /, mapEnd);
  let commentStart = loopStart;
  while (commentStart > 0 && /^\/\//.test(lines[commentStart - 1])) commentStart--;
  const loopEnd = find(/^applyServiceMetadata\(routes\);$/, loopStart);
  const lifted = [...lines.slice(start, mapEnd + 1), "", ...lines.slice(commentStart, loopEnd + 1)];

  for (const l of lifted) {
    if (/^(app\.|resourceServer\.|const (app|resourceServer|facilitatorClient)\b|process\.on)/.test(l)) {
      throw new Error(`lift: Base wiring leaked into the route table: ${l}`);
    }
  }

  // Router imports, verbatim (same relative path from src/route-table.ts).
  const routerImportRe = /^import \{ ([A-Za-z0-9]+Router) \} from "\.\/routes\/[a-z0-9-]+\.js";$/;
  const routerImports = lines.filter((l) => routerImportRe.test(l));
  const routerNames = routerImports.map((l) => l.match(routerImportRe)![1]);
  if (routerNames.length === 0) throw new Error("lift: no router imports found");

  // Non-router imports the lifted text actually uses, resolved for this repo.
  const headerEnd = Math.max(
    ...lines.map((l, i) => (/^(import .*|\} from "[^"]+";)$/.test(l) ? i : -1))
  );
  const header = lines.slice(0, headerEnd + 1).join("\n");
  const free = freeIdentifiers(lifted.join("\n"));
  const byModule = new Map<string, Set<string>>();
  const problems: string[] = [];
  const uses = (id: string) => free.has(id);
  const importRe = /import\s+(type\s+)?\{([^}]+)\}\s+from\s+"([^"]+)";|import\s+(\w+)\s+from\s+"([^"]+)";/g;
  for (const m of header.matchAll(importRe)) {
    const mod = m[3] ?? m[5];
    if (/^\.\/routes\//.test(mod)) continue;
    const specs = m[2]
      ? m[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => (m[1] ? `type ${s}` : s))
      : [`default ${m[4]}`];
    for (const spec of specs) {
      const local = spec.replace(/^(type|default)\s+/, "").split(/\s+as\s+/).pop()!;
      if (!uses(local)) continue;
      let target: string | undefined;
      if (mod.startsWith("./")) {
        if (existsSync(join(repoRoot, "src", mod.replace(/\.js$/, ".ts")))) target = mod;
      } else {
        target = MODULE_MAP[mod];
      }
      if (!target) {
        problems.push(`${local} (from "${mod}")`);
        continue;
      }
      if (!byModule.has(target)) byModule.set(target, new Set());
      byModule.get(target)!.add(spec);
    }
  }
  if (problems.length) {
    throw new Error(
      `lift: the route table uses identifiers this repo cannot provide:\n  ${problems.join("\n  ")}\n` +
        "Provide them in src/config.ts / src/accepts.ts, add the file to FILES, or map the module in MODULE_MAP."
    );
  }
  const importLines: string[] = [];
  for (const [mod, specs] of byModule) {
    const named = [...specs].filter((s) => !s.startsWith("default "));
    const def = [...specs].find((s) => s.startsWith("default "));
    if (def) importLines.push(`import ${def.slice(8)} from "${mod}";`);
    if (named.length) importLines.push(`import { ${named.join(", ")} } from "${mod}";`);
  }

  return [
    "/**",
    " * route-table.ts — GENERATED by scripts/sync-from-netintel.ts. Do not edit.",
    " *",
    " * The route table lifted verbatim from NetIntel's src/index.ts: the helper",
    " * consts, the `routes` map and its post-map fixups, plus every route router.",
    " * It names no payment rail — every `accepts` comes from ./accepts.js, which",
    " * this repo binds to Algorand — so the declarations that price and describe",
    " * the Base service price and describe the Algorand one.",
    " */",
    ...importLines,
    ...routerImports,
    "",
    ...lifted,
    "",
    "export { routes };",
    "",
    "/** Every route router, in NetIntel's declaration order. */",
    `export const routers = [${routerNames.join(", ")}];`,
    "",
  ].join("\n");
}

const routeTable = liftRouteTable(readFileSync(join(netintelRoot, "src", "index.ts"), "utf8"));
writeIfChanged(join(repoRoot, "src", "route-table.ts"), routeTable, "src/route-table.ts");

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
    "src/routes, src/utils, src/services, src/netintel-config.ts, src/mirror-402-body.ts,",
    "src/payment-headers.ts and src/service-metadata.ts are VERBATIM copies from the",
    "NetIntel (Base) repo; src/route-table.ts is generated from its src/index.ts.",
    "Do not hand-edit them — edits belong in src/config.ts, src/accepts.ts or",
    "src/index.ts, or upstream in NetIntel. Regenerate with: npm run sync:from-netintel",
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
