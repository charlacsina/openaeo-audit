#!/usr/bin/env node
/**
 * OpenAEO MCP server, lets an AI coding agent (Cursor, Claude Code, or any
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
      + "<title>, <meta name=description>, and Organization+WebSite JSON-LD. Only ADDS what's absent, "
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
      + "to paste each one in THAT platform's admin, including an honest note when a platform can't do "
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
      + "wants you to actually FIX their site rather than just audit it, work the tickets in order, "
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
  {
    name: "aeo_read_log",
    description:
      "Read a server access log and report what AI crawlers actually got: which arrived, what status "
      + "they were given, which paths they reached, and whether each request really came from the "
      + "operator it claimed. Understands the combined format nginx and Apache write by default, and "
      + "JSON lines from Cloudflare, Fastly, Vercel and Netlify. "
      + "This is the tool that settles what an audit can only indicate: a fetch sent from this machine "
      + "wearing a crawler's name is an indication, and the log is the evidence. Where the two disagree, "
      + "the log is right. "
      + "Runs entirely locally. The log is parsed in this process and never sent anywhere; the only "
      + "network call is fetching the operators' public address ranges.",
    inputSchema: {
      type: "object",
      properties: {
        log: { type: "string", description: "The access log text. Paste it or read the file first." },
        bots: { type: "array", description: "Optional: the bots array from a previous aeo_audit call, "
                + "to reconcile what we measured against what actually happened.", items: { type: "object" } },
      },
      required: ["log"],
    },
  },
  {
    name: "aeo_verify_crawler",
    description:
      "Check whether an IP address really belongs to the crawler it claims to be, against the ranges "
      + "the operator publishes. OpenAI, Anthropic, Google, Microsoft, Perplexity and Apple all publish "
      + "these. Answers verified, impostor, or unverifiable, and never says impostor without positive "
      + "evidence: if the operator publishes nothing, or the feed fails to load, the answer is "
      + "unverifiable. Use when a log line looks suspicious or before allow-listing anything by name.",
    inputSchema: {
      type: "object",
      properties: {
        ip: { type: "string", description: "The client IP address from your log" },
        bot: { type: "string", description: "The crawler it claims to be, e.g. GPTBot" },
      },
      required: ["ip", "bot"],
    },
  },
  {
    name: "aeo_crawler_intel",
    description:
      "Has this site's CDN started refusing AI crawlers? Reads OpenAEO's corpus of per-crawler "
      + "reachability observations to show what each crawler is served today, what changed since the "
      + "last observation, and how often each has been blocked. Answers what robots.txt cannot: a CDN "
      + "can refuse ClaudeBot while robots.txt allows it, and a provider changing a default is invisible "
      + "to the site owner. Needs OPENAEO_API_KEY (Solo and above).",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Domain to look up, e.g. example.com" } },
      required: ["domain"],
    },
  },
  {
    name: "aeo_citations",
    description:
      "Run a citation test: ask the assistants a buyer question and record whether this business is "
      + "named. Runs on openaeo.dev because it needs provider keys for six surfaces. Needs "
      + "OPENAEO_API_KEY (Solo and above).",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "The domain to look for in the answers" },
        query: { type: "string", description: "The buyer question to ask, e.g. 'best film presets for portraits'" },
      },
      required: ["domain", "query"],
    },
  },
  {
    name: "aeo_history",
    description:
      "Score history for a tracked site: how the AEO score has moved over time, and which checks "
      + "changed. Needs OPENAEO_API_KEY (Solo and above).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "aeo_drift",
    description:
      "What regressed. Lists checks that were passing and are not any more, and crawlers that were "
      + "reachable and are not any more, so a deploy that broke AI visibility is caught before anyone "
      + "notices the traffic. Needs OPENAEO_API_KEY (Solo and above).",
    inputSchema: {
      type: "object",
      properties: { domain: { type: "string", description: "Domain to check, defaults to your tracked site" } },
      required: [],
    },
  },
  {
    name: "aeo_competitors",
    description:
      "Competitor share of voice: which domains the assistants name instead of you, across your "
      + "tracked prompts. Needs OPENAEO_API_KEY (Business and above).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];


/* ---- hosted tools -----------------------------------------------------------
 *
 * Everything above runs entirely on this machine. These five do not, and cannot:
 * citation testing needs provider keys for six assistants, and the crawler corpus
 * is an accumulation across every audit anyone has run. Shipping either in an MIT
 * package is not a licensing decision, it is impossible.
 *
 * So they are thin clients. The valuable part is the service, and the tool is the
 * few lines that reach it.
 *
 * When there is no key they explain what the tool needs and where to get it,
 * rather than returning an auth error. The agent is mid-conversation with someone
 * who has just asked a reasonable question, and "401" is not an answer to it.
 */
const API_BASE = process.env.OPENAEO_API_BASE || "https://openaeo.dev";

function apiKey() { return (process.env.OPENAEO_API_KEY || "").trim(); }

const NEEDS_KEY = {
  error: "This tool runs on openaeo.dev, so it needs an API key.",
  why: "Citation testing needs provider keys for six assistants, and crawler intelligence reads a "
     + "corpus collected across every audit. Neither can run locally.",
  how: "Create a key in your dashboard at https://openaeo.dev/dashboard, then set OPENAEO_API_KEY in "
     + "your MCP client's env. The local tools (aeo_audit, aeo_fix_files, aeo_fix_html, aeo_check_html, "
     + "aeo_packet, aeo_fix_my_site) need no key and are unaffected.",
};

async function hostedGet(path) {
  const key = apiKey();
  if (!key) return NEEDS_KEY;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const r = await fetch(API_BASE + path, {
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
      signal: ctrl.signal,
    });
    const body = await r.json().catch(() => ({}));
    if (r.status === 401) return { error: "That API key was not accepted.", how: NEEDS_KEY.how };
    if (r.status === 402) return { error: body.error || "That tool needs a paid plan.", upgrade: "https://openaeo.dev/pricing" };
    if (!r.ok) return { error: body.error || ("openaeo.dev returned " + r.status) };
    return body;
  } catch (e) {
    return { error: e.name === "AbortError" ? "openaeo.dev timed out." : "Could not reach openaeo.dev." };
  } finally { clearTimeout(t); }
}

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
  if (name === "aeo_crawler_intel") {
    const d = String(args.domain || "").trim();
    if (!d) return { error: "Which domain?" };
    return hostedGet("/api/crawler-intel?domain=" + encodeURIComponent(d));
  }
  if (name === "aeo_citations") {
    const d = String(args.domain || "").trim(), q = String(args.query || "").trim();
    if (!d || !q) return { error: "Need both `domain` and `query`." };
    return hostedGet("/api/citation-test?domain=" + encodeURIComponent(d) + "&q=" + encodeURIComponent(q));
  }
  if (name === "aeo_history") return hostedGet("/api/history");
  if (name === "aeo_drift") {
    const d = String(args.domain || "").trim();
    const intel = await hostedGet("/api/crawler-intel" + (d ? "?domain=" + encodeURIComponent(d) : ""));
    if (intel.error) return intel;
    return {
      domain: intel.domain,
      crawlerRegressions: intel.regressions || [],
      observations: intel.observations,
      note: (intel.regressions && intel.regressions.length)
        ? "A crawler that was reachable is not any more. This is usually a CDN or WAF rule, not robots.txt."
        : "No crawler regressions in the recorded window. " + (intel.note || ""),
    };
  }
  if (name === "aeo_competitors") {
    const d = await hostedGet("/api/dashboard");
    if (d.error) return d;
    return { shareOfVoice: d.shareOfVoice || null,
             note: d.shareOfVoice ? "Domains the assistants named across your tracked prompts."
                                  : "No share-of-voice data yet. It needs Business and at least one citation run." };
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
                             : "Nothing to inject, the page already has a title, meta description and Organization/WebSite JSON-LD.",
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
        + "exact text to copy for each step. Do NOT fill in the [bracketed] placeholders yourself, ask "
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
        + "Never invent values for [BRACKETS], ask the user. Never write schema for content that isn't "
        + "visible on the page. After the tickets are done, re-run aeo_audit to confirm the score moved.",
    };
  }
  if (name === "aeo_check_html") return G.htmlReadiness(String(args.html || ""));

  if (name === "aeo_read_log") {
    const BL = require("../src/botlog");
    const BV = require("../src/botverify");
    let ranges = null;
    try { ranges = await BV.loadRanges(); } catch (e) { ranges = null; }
    const parsed = BL.parseAccessLog(String(args.log || ""), ranges);
    if (!parsed.bots.length) {
      return { read: parsed.parsed + " of " + parsed.lines + " lines",
               crawlers: [],
               note: parsed.parsed === 0
                 ? "Could not read that as an access log. Understood formats: the combined format nginx "
                   + "and Apache write by default, and JSON lines from Cloudflare, Fastly, Vercel and Netlify."
                 : "No AI crawler appears in this log. That is itself an answer: in this window, none visited." };
    }
    const rec = BL.reconcile(Array.isArray(args.bots) ? args.bots : [], parsed.bots);
    return { stats: { lines: parsed.lines, parsed: parsed.parsed, unparsed: parsed.unparsed,
                      crawlerRequests: parsed.botHits, format: parsed.format },
             crawlers: parsed.bots, reconcile: rec,
             privacy: "Parsed locally. Nothing from this log left your machine." };
  }

  if (name === "aeo_verify_crawler") {
    const BV = require("../src/botverify");
    let ranges = null;
    try { ranges = await BV.loadRanges(); } catch (e) { ranges = null; }
    const v = BV.classify(String(args.ip || ""), String(args.bot || ""), ranges);
    return { ip: args.ip, claims: args.bot, verdict: v.status, why: v.why,
             operator: v.op || null, sources: BV.sourceList() };
  }
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
        "OpenAEO audits a website for AI-search visibility (AEO/GEO), whether ChatGPT, Claude,",
        "Gemini and Perplexity can read, trust and cite it, and generates the fixes.",
        "",
        "FIRST, work out which kind of user you have:",
        "- No codebase / site is on Squarespace, Wix, Webflow, WordPress, Shopify, Framer, Ghost,",
        "  Carrd, or they just gave you a domain and aren't a developer:",
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
        "If the audit reports crawlers blocked at the edge, say plainly that the fetch is an",
        "indication and not proof: it is sent from this machine wearing the crawler's name, while the",
        "real crawler arrives from its operator's own network. Ask the user for a server access log and",
        "run aeo_read_log on it. That reconciles what we measured against what actually happened, and",
        "where the two disagree the log is right. It also catches requests wearing a crawler's name",
        "from addresses the operator does not own, which is a different problem and a real one.",
        "",
        "Rules:",
        "- Generated files contain [bracketed] placeholders. NEVER invent values for them:",
        "  no fake prices, review counts, founding years, addresses or social URLs. Ask the user",
        "  for the real numbers, or leave the brackets in place for them to fill.",
        "- aeo_fix_html only ADDS missing head elements; it never rewrites page content. Don't",
        "  ask it to do more than that.",
        "- Show the user each file you're about to write and let them confirm.",
        "- A failing retrieval gate (JS-only rendering, blocked bots, robots.txt disallow) caps the",
        "  whole score, fix those before tuning schema or copy.",
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
