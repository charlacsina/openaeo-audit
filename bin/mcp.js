#!/usr/bin/env node
/**
 * OpenAEO MCP server — lets an AI coding agent (Cursor, Claude Code, or any
 * MCP client) audit a site for AI-search visibility and apply the fixes to
 * your local files, with your review.
 *
 * Speaks MCP over stdio (JSON-RPC 2.0, newline-delimited). Implemented by hand
 * so the package stays dependency-free.
 *
 * Register in Cursor (~/.cursor/mcp.json) or Claude Code (.mcp.json):
 *   { "mcpServers": { "openaeo": { "command": "npx",
 *       "args": ["-y", "openaeo-audit", "mcp"] } } }
 */
"use strict";

const { audit, remediationPlan } = require("../src/audit");
const G = require("../src/generate");
const P = require("../src/platform");
const PK = require("../src/packet");

const PROTOCOL = "2024-11-05";
const SERVER = { name: "openaeo", version: require("../package.json").version };

// ---- tool definitions -----------------------------------------------------
const TOOLS = [
  {
    name: "aeo_audit",
    description:
      "Audit a live website for AI-search visibility (AEO/GEO). Fetches the page as an AI crawler "
      + "would and returns a 0-100 score, a band, every passing/failing check, and prioritised fixes. "
      + "Use this first to find out why a site isn't being cited by ChatGPT, Claude, Gemini or Perplexity.",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Domain or full URL, e.g. example.com" } },
      required: ["domain"],
    },
  },
  {
    name: "aeo_fix_files",
    description:
      "Generate the paste-ready files a site needs to be readable and citable by AI assistants: "
      + "robots.txt (allowing the AI crawlers), llms.txt (a quotable index), Organization+WebSite "
      + "JSON-LD, and a template opening paragraph. Write these into the user's project.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain, e.g. example.com" },
        brand: { type: "string", description: "Business/brand name (optional; defaults from the domain)" },
      },
      required: ["domain"],
    },
  },
  {
    name: "aeo_fix_html",
    description:
      "Take a page's HTML and return it with the missing structural pieces injected into <head>: "
      + "<title>, <meta name=description>, and Organization+WebSite JSON-LD. Only ADDS what's absent — "
      + "never rewrites or deletes existing content. Returns the fixed HTML plus a before/after readiness "
      + "score. Use this on a local file, then write the result back.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "The full HTML source of the page" },
        domain: { type: "string", description: "Domain, e.g. example.com" },
        brand: { type: "string", description: "Business/brand name (optional)" },
      },
      required: ["html"],
    },
  },
  {
    name: "aeo_fix_my_site",
    description:
      "ONE-SHOT for people who don't have a codebase. Give it a domain and it audits the site, "
      + "detects the platform (Squarespace, Wix, Webflow, WordPress, Shopify, Framer, Ghost, Carrd or "
      + "custom), generates the exact files/snippets, and returns click-by-click instructions for where "
      + "to paste each one in THAT platform's admin — including an honest note when a platform can't do "
      + "something. Use this whenever the user isn't a developer or their site is on a website builder.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain or full URL, e.g. example.com" },
        brand: { type: "string", description: "Business name (optional; defaults from the domain)" },
      },
      required: ["domain"],
    },
  },
  {
    name: "aeo_packet",
    description:
      "Generate an engineering packet for a domain (the open-source version): an ordered list of tickets, each with the audit "
      + "evidence that justifies it, where the change goes for that stack, implementation steps, "
      + "acceptance criteria, and an `agentPrompt` you can execute directly. Use this when the user "
      + "wants you to actually FIX their site rather than just audit it — work the tickets in order, "
      + "P1 first, showing the user each change before you make it.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Domain or full URL" },
        brand: { type: "string", description: "Business name (optional)" },
      },
      required: ["domain"],
    },
  },
  {
    name: "aeo_check_html",
    description:
      "Score a page's HTML against the checks a single file can satisfy (title, meta description, "
      + "Organization/WebSite/FAQPage JSON-LD, a number in the first 100 words) without making changes. "
      + "Use to verify your edits worked.",
    inputSchema: {
      type: "object",
      properties: { html: { type: "string", description: "The full HTML source of the page" } },
      required: ["html"],
    },
  },
];

// ---- tool implementations -------------------------------------------------
async function runTool(name, args) {
  args = args || {};
  if (name === "aeo_audit") {
    const res = await audit(String(args.domain || ""));
    if (res.error) return { error: res.error };
    return {
      domain: res.domain, score: res.score, band: res.band,
      verdict: res.verdict, detail: res.sub,
      checks: res.checks,
      fixes: remediationPlan(res).map((f, i) => ({ priority: i + 1, title: f.title, why: f.why, how: f.how })),
      note: "Score is from the 8 headline checks. The hosted product at https://openaeo.dev runs the full "
          + "49-check rubric and tracks it over time.",
    };
  }
  if (name === "aeo_fix_files") return G.fixFiles(args.domain, args.brand);
  if (name === "aeo_fix_html") {
    const html = String(args.html || "");
    if (!html.trim()) return { error: "Provide the page's HTML in `html`." };
    if (html.length > 800000) return { error: "That HTML is too large (800KB max)." };
    const r = G.applyFixes(html, args.brand, args.domain);
    return {
      fixedHtml: r.after, changes: r.changes,
      readinessBefore: r.readinessBefore.score, readinessAfter: r.readinessAfter.score,
      unchanged: r.changes.length === 0,
      note: r.changes.length ? "Write `fixedHtml` back to the file. Replace any [bracketed] placeholders with real values."
                             : "Nothing to inject — the page already has a title, meta description and Organization/WebSite JSON-LD.",
    };
  }
  if (name === "aeo_fix_my_site") {
    const res = await audit(String(args.domain || ""));
    if (res.error) return { error: res.error };
    const files = G.fixFiles(res.domain, args.brand);
    const guide = P.setupGuide(res.platform.id);
    const failing = res.checks.filter(c => c.status !== "pass").map(c => c.label);
    return {
      domain: res.domain, score: res.score, band: res.band, verdict: res.verdict,
      platform: guide.platform,
      whatsWrong: failing,
      whereToPaste: guide.tasks,
      cantDoOnThisPlatform: guide.unsupported.length ? guide.unsupported : undefined,
      files: { "robots.txt": files.robots, "llms.txt": files.llms,
               "json-ld (paste in <head>)": files.jsonld, "opening paragraph (draft)": files.rewrite },
      tip: guide.tip,
      forTheUser:
        "Walk the user through this one task at a time, in their platform's own words. Show them the "
        + "exact text to copy for each step. Do NOT fill in the [bracketed] placeholders yourself — ask "
        + "them for their real prices, counts and dates, or leave the brackets for them.",
    };
  }
  if (name === "aeo_packet") {
    const res = await audit(String(args.domain || ""));
    if (res.error) return { error: res.error };
    const pk = PK.buildPacket(res, { brand: args.brand, tier: "free" });
    return {
      domain: pk.meta.domain, platform: pk.meta.platform,
      scoreToday: pk.summary.today, band: pk.summary.band,
      ticketCount: pk.summary.ticketCount, blocking: pk.summary.blocking,
      tickets: pk.tickets,
      rules: pk.notes,
      alsoAvailable: pk.upgrade,
      forTheAgent:
        "Work these in order, P1 before P2. For each ticket: show the user the change first, then apply it. "
        + "Never invent values for [BRACKETS] — ask the user. Never write schema for content that isn't "
        + "visible on the page. After the tickets are done, re-run aeo_audit to confirm the score moved.",
    };
  }
  if (name === "aeo_check_html") return G.htmlReadiness(String(args.html || ""));
  return { error: "Unknown tool: " + name };
}

// ---- JSON-RPC plumbing ----------------------------------------------------
function send(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }
function result(id, r) { send({ jsonrpc: "2.0", id, result: r }); }
function failure(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return result(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: SERVER,
      instructions: [
        "OpenAEO audits a website for AI-search visibility (AEO/GEO) — whether ChatGPT, Claude,",
        "Gemini and Perplexity can read, trust and cite it — and generates the fixes.",
        "",
        "FIRST, work out which kind of user you have:",
        "- No codebase / site is on Squarespace, Wix, Webflow, WordPress, Shopify, Framer, Ghost,",
        "  Carrd — or they just gave you a domain and aren't a developer:",
        "  use aeo_fix_my_site. It returns click-by-click steps for THEIR platform's admin.",
        "  Walk them through one task at a time and paste the exact text for each step.",
        "- They have the site's source open in this project: use the workflow below.",
        "",
        "Workflow when the user has a codebase:",
        "1. aeo_audit their domain. Report the score, the band, and which checks failed.",
        "2. aeo_fix_files to generate robots.txt, llms.txt and JSON-LD. Write robots.txt and",
        "   llms.txt into the site's public/static root (e.g. public/, static/, or the repo root).",
        "3. aeo_fix_html on each key page's HTML, then write `fixedHtml` back to the file.",
        "4. aeo_check_html to verify, and re-run aeo_audit after deploying to confirm the score moved.",
        "",
        "Rules:",
        "- Generated files contain [bracketed] placeholders. NEVER invent values for them —",
        "  no fake prices, review counts, founding years, addresses or social URLs. Ask the user",
        "  for the real numbers, or leave the brackets in place for them to fill.",
        "- aeo_fix_html only ADDS missing head elements; it never rewrites page content. Don't",
        "  ask it to do more than that.",
        "- Show the user each file you're about to write and let them confirm.",
        "- A failing retrieval gate (JS-only rendering, blocked bots, robots.txt disallow) caps the",
        "  whole score — fix those before tuning schema or copy.",
      ].join("\n"),
    });
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return; // no reply
  if (method === "ping") return result(id, {});
  if (method === "tools/list") return result(id, { tools: TOOLS });
  if (method === "tools/call") {
    const tname = params && params.name;
    try {
      const out = await runTool(tname, params && params.arguments);
      return result(id, {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
        isError: !!(out && out.error),
      });
    } catch (e) {
      return result(id, { content: [{ type: "text", text: "Error: " + (e && e.message) }], isError: true });
    }
  }
  if (id !== undefined) failure(id, -32601, "Method not found: " + method);
}

let buf = "";
let pending = 0;          // in-flight tool calls
let stdinClosed = false;
function maybeExit() { if (stdinClosed && pending === 0) process.exit(0); }

process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { continue; }
    pending++;
    Promise.resolve(handle(msg))
      .catch(e => { if (msg && msg.id !== undefined) failure(msg.id, -32603, String((e && e.message) || e)); })
      // never exit with a tool call still running (aeo_audit does a network fetch)
      .finally(() => { pending--; maybeExit(); });
  }
});
process.stdin.on("end", () => { stdinClosed = true; maybeExit(); });
