#!/usr/bin/env node
// `openaeo-audit log <file>`
//
// The audit asks what a fetch from this machine got. This asks what actually
// happened, which is a different and better question, and it is the only one that
// settles whether a crawler reached you.
//
// Nothing here uploads anything. The log is read from disk, parsed in this
// process, and thrown away. The single network call is fetching the operators'
// public address ranges so a request claiming to be GPTBot can be checked rather
// than believed.
"use strict";
const fs = require("fs");
const BL = require("../src/botlog");
const BV = require("../src/botverify");

const C = process.stdout.isTTY ? {
  dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`,
} : new Proxy({}, { get: () => (s => s) });

(async () => {
  const file = process.argv[3];
  const asJson = process.argv.includes("--json");
  if (!file || file.startsWith("-")) {
    console.log(`
${C.bold("OpenAEO")} read a server access log, locally

${C.bold("Usage:")}
  npx openaeo-audit log <file>          Report what AI crawlers actually got
  npx openaeo-audit log <file> --json   Machine-readable JSON

Understands the combined format nginx and Apache write by default, and JSON lines
from Cloudflare, Fastly, Vercel and Netlify. The log is parsed on this machine and
never sent anywhere.
`);
    process.exit(file ? 0 : 1);
  }

  let text;
  try { text = fs.readFileSync(file, "utf8"); }
  catch (e) { console.error("Could not read " + file + ": " + e.message); process.exit(1); }

  if (!asJson) process.stderr.write(C.dim("Reading " + file + " and checking crawler identities…\n"));
  let ranges = null;
  try { ranges = await BV.loadRanges(); } catch (e) { ranges = null; }
  const r = BL.parseAccessLog(text, ranges);

  if (asJson) { console.log(JSON.stringify(r, null, 2)); return; }

  console.log("");
  if (!r.bots.length) {
    console.log(r.parsed === 0
      ? C.yellow("  Could not read that as an access log.")
      : C.dim("  Read " + r.parsed + " lines. No AI crawler appears in them, which is itself an answer."));
    console.log("");
    return;
  }

  console.log(C.dim(`  ${r.parsed} of ${r.lines} lines read (${r.format}), ${r.botHits} crawler requests`));
  console.log("");
  for (const b of r.bots) {
    const colour = b.outcome === "served" ? C.green : b.outcome === "refused" ? C.red : C.yellow;
    const n = (k, one, many) => k + " " + (k === 1 ? one : many);
    console.log(`  ${C.bold(b.bot.padEnd(19))} ${colour(b.outcome.padEnd(14))} ${C.dim(n(b.hits, "request", "requests") + ", " + n(b.distinctPaths, "path", "paths"))}`);
    const codes = Object.keys(b.statuses).sort().map(k => k + " x" + b.statuses[k]).join("  ");
    console.log(C.dim(`    ${codes}`));
    if (b.verified) console.log(C.green(`    ${b.verified} confirmed from the operator's own network`));
    if (b.impostor) console.log(C.red(`    ${b.impostor} ${b.impostor === 1 ? "request claimed" : "requests claimed"} to be ${b.bot} from outside its published range: ${b.impostorIps.join(", ")}`));
    if (b.whyUnverifiable) console.log(C.dim(`    not verified: ${b.whyUnverifiable}`));
    if (b.topPaths.length) console.log(C.dim(`    ${b.topPaths.slice(0, 4).map(p => p.path + " x" + p.hits).join("  ")}`));
    console.log("");
  }
  const impostors = r.bots.reduce((n, b) => n + b.impostor, 0);
  if (impostors) {
    console.log(C.red(`  ${impostors} request${impostors === 1 ? "" : "s"} wore a crawler's name without owning the address.`));
    console.log(C.dim("  That is someone else scraping you under a name you may have chosen to allow."));
    console.log("");
  }
  console.log(C.dim("  Parsed locally. Nothing from this log left your machine."));
  console.log("");
})();
