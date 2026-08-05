#!/usr/bin/env node
// OpenAEO CLI — audit a site for AI-search visibility from your terminal.
//   npx openaeo-audit yoursite.com
//   npx openaeo-audit yoursite.com --json
"use strict";

const { audit, remediationPlan } = require("../src/audit");

// `openaeo-audit mcp` starts the MCP server for Cursor / Claude Code.
// Hand off before any stdout writing — MCP owns stdout for JSON-RPC.
if (process.argv[2] === "mcp") { require("./mcp.js"); return; }

// `openaeo-audit log access.log` reads a server log and reports what the AI
// crawlers actually got, checking each request against the address ranges the
// operators publish. The audit tells you what a fetch from this machine got; the
// log tells you what happened. Where they disagree, the log is right.
//
// It runs here rather than on a server on purpose: a log is a list of your
// visitors' addresses, and the version of this that uploads one is a worse
// product however much nicer the dashboard looks.
if (process.argv[2] === "log") { require("./readlog.js"); return; }

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const url = args.find(a => !a.startsWith("-"));

const C = process.stdout.isTTY ? {
  dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`, yellow: s => `\x1b[33m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`,
} : new Proxy({}, { get: () => (s => s) });

const MARK = { pass: C.green("✓"), warn: C.yellow("⚠"), fail: C.red("✗") };

function usage() {
  console.log(`
${C.bold("OpenAEO")} — quick AEO/GEO audit for AI-search visibility

${C.bold("Usage:")}
  npx openaeo-audit <domain>          Audit a site (pretty output)
  npx openaeo-audit <domain> --json   Machine-readable JSON
  npx openaeo-audit log <file>        Read a server access log, locally
  npx openaeo-audit mcp               Start the MCP server

${C.bold("Examples:")}
  npx openaeo-audit example.com
  npx openaeo-audit https://example.com --json
  npx openaeo-audit log /var/log/nginx/access.log

Full 49-check rubric, citation testing across ChatGPT/Claude/Gemini/Perplexity,
and monitoring live at ${C.cyan("https://openaeo.dev")}
`);
}

(async () => {
  if (!url || args.includes("-h") || args.includes("--help")) { usage(); process.exit(url ? 0 : 1); }

  if (!asJson) process.stderr.write(C.dim(`Auditing ${url} as an AI crawler…\n`));
  let res;
  try { res = await audit(url); }
  catch (e) { console.error(C.red("Error: ") + e.message); process.exit(1); }

  if (res.error) {
    if (asJson) { console.log(JSON.stringify(res, null, 2)); process.exit(1); }
    console.error(C.red("Error: ") + res.error); process.exit(1);
  }

  if (asJson) {
    console.log(JSON.stringify({ ...res, fixes: remediationPlan(res) }, null, 2));
    return;
  }

  const scoreColor = res.score >= 65 ? C.green : res.score >= 46 ? C.yellow : C.red;
  console.log("");
  console.log(`  ${C.bold(res.domain)}`);
  console.log(`  ${scoreColor(C.bold(String(res.score) + "/100"))}  ${C.dim("·")}  ${scoreColor(res.band)}`);
  console.log(`  ${res.verdict}`);
  console.log(C.dim("  " + res.sub));
  console.log("");
  for (const c of res.checks) {
    // A check that does not apply is not a warning. Printing it as one is how a
    // tool ends up telling somebody to put Offer schema on a page that sells
    // nothing, which is the practice this tool exists to argue against.
    const mark = c.applicable === false ? C.dim("·") : (MARK[c.status] || "?");
    const label = c.applicable === false ? C.dim(c.label) : c.label;
    console.log(`  ${mark} ${label}  ${C.dim("- " + c.detail)}`);
  }
  const na = res.checks.filter(c => c.applicable === false);
  if (na.length) {
    console.log("");
    console.log(C.dim(`  ${na.length} check${na.length === 1 ? "" : "s"} not applicable to this page:`));
    na.forEach(c => console.log(C.dim(`     ${c.label}: ${c.notApplicableWhy}`)));
    console.log(C.dim(`  Scored out of ${res.checksScored}, not ${res.checks.length}.`));
  }
  if (res.crawlerEvidence && res.crawlerEvidence.confidence) {
    const cf = res.crawlerEvidence.confidence;
    console.log("");
    console.log(C.dim(`  Crawler reading: ${cf.level}. ${cf.note}`));
    if (cf.level !== "clear") console.log(C.dim(`  ${res.crawlerEvidence.settles_it}`));
  }

  const fixes = remediationPlan(res);
  if (fixes.length) {
    console.log("");
    console.log(C.bold(`  ${fixes.length} fix${fixes.length === 1 ? "" : "es"} to raise your score:`));
    fixes.forEach((f, i) => {
      console.log(`  ${C.cyan(String(i + 1) + ".")} ${C.bold(f.title)}`);
      console.log(C.dim(`     Why:  ${f.why}`));
      console.log(C.dim(`     How:  ${f.how}`));
    });
  } else {
    console.log("");
    console.log(C.green("  No blocking issues found. Nice work."));
  }
  console.log("");
  console.log(C.dim(`  Deeper audit + citation testing + monitoring: `) + C.cyan("https://openaeo.dev"));
  console.log("");
})();
