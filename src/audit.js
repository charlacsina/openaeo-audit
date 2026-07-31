// OpenAEO — quick AEO/GEO audit engine.
// Fetches a URL the way an AI crawler (GPTBot) would, then scores how
// retrievable and citable the page is for AI answer engines (ChatGPT, Claude,
// Gemini, Perplexity). Pure Node, zero dependencies (needs Node 18+ for fetch).
// MIT licensed. The hosted version at https://openaeo.dev adds the full
// 49-check rubric, citation testing, and monitoring.
"use strict";

const BANDS = [
  [0, 25, "Not retrievable"],
  [26, 45, "Partial"],
  [46, 64, "AI-ready"],
  [65, 82, "AI-competitive"],
  [83, 100, "AI-dominant"],
];
function band(s) { for (const [lo, hi, n] of BANDS) { if (s >= lo && s <= hi) return n; } return "Partial"; }

// crude SSRF guard: reject localhost / private / link-local literals
function isPublicHost(host) {
  host = (host || "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local")) return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|::1|0\.0\.0\.0)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

const UA_BOT = "Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot) OpenAEO-audit (+https://github.com/charlacsina/openaeo-audit)";

async function fetchUrl(url, ua, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": ua, "Accept": "text/html,*/*" }, redirect: "follow", signal: ctrl.signal });
    const text = (await r.text()).slice(0, 600000);
    return { status: r.status, text };
  } finally { clearTimeout(t); }
}

function visibleText(h) {
  let s = h.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  s = s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
  return s.replace(/\s+/g, " ").trim();
}
function ldBlocks(h) {
  const out = []; const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(h))) { try { out.push(JSON.parse(m[1].trim())); } catch (e) {} }
  return out;
}
function flattenTypes(blocks) {
  const types = new Set();
  (function walk(o) {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") { const t = o["@type"]; if (typeof t === "string") types.add(t); else if (Array.isArray(t)) t.forEach(x => typeof x === "string" && types.add(x)); Object.values(o).forEach(walk); }
  })(blocks);
  return types;
}
function hasOfferPrice(b) { const t = JSON.stringify(b); return (t.includes('"Offer"') || t.includes('"AggregateOffer"') || t.includes('"Product"')) && t.includes('"price"'); }

async function robotsAllows(base) {
  try {
    const { text: body } = await fetchUrl(base + "/robots.txt", "OpenAEO-audit");
    const low = (body || "").toLowerCase(); const bots = ["gptbot", "claudebot", "perplexitybot"]; const blocked = [];
    for (const g of low.split(/^\s*user-agent:/im)) {
      const agent = (g.trim().split("\n")[0] || "").trim();
      if (/^\s*disallow:\s*\/\s*$/im.test(g)) { if (agent === "*") blocked.push("*"); for (const b of bots) if (agent === b && !blocked.includes(b)) blocked.push(b); }
    }
    if (blocked.includes("*") || bots.some(b => blocked.includes(b))) return ["fail", "robots.txt disallows " + blocked.join(", ")];
    return ["pass", "AI bots allowed"];
  } catch (e) { return ["warn", "no robots.txt found (default: allowed)"]; }
}

/**
 * Audit a URL for AI-search retrievability and citability.
 * @param {string} url - full URL or domain (https:// is assumed if omitted)
 * @returns {Promise<object>} { domain, score, band, verdict, sub, fixCount, edgeOk, checks[] } or { error }
 */
async function audit(url) {
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  let p; try { p = new URL(url); } catch (e) { return { error: "Enter a full domain, e.g. your-site.com" }; }
  if (!/^https?:$/.test(p.protocol)) return { error: "Enter a full domain, e.g. your-site.com" };
  if (!isPublicHost(p.hostname)) return { error: "That host can't be audited (private or unreachable)." };
  const base = p.protocol + "//" + p.host;

  let edgeOk = true, edgeNote = "", body = "";
  try {
    const r = await fetchUrl(url, UA_BOT); body = r.text;
    if (r.status >= 400) { edgeOk = false; edgeNote = "HTTP " + r.status + " (bot blocked at edge)"; }
  } catch (e) { return { error: "Couldn't reach " + p.host + "." }; }

  const text = visibleText(body); const words = text.split(/\s+/).filter(Boolean).length;
  const blocks = ldBlocks(body); const types = flattenTypes(blocks);
  const title = /<title[^>]*>\s*\S/i.test(body);
  const metaDesc = /<meta[^>]+name=["']description["'][^>]+content=["']\s*\S/i.test(body);
  const first100 = text.split(/\s+/).slice(0, 100).join(" ");
  const hasNumberEarly = /\d/.test(first100) && title && metaDesc;
  const templateHoles = /\{\{\s*\w/.test(body);
  const emptyRoot = /<div[^>]+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(body);
  const heavyJs = (body.match(/<script/gi) || []).length >= 1 && words < 40;
  const csr = templateHoles || (emptyRoot && words < 60) || heavyJs;
  const thin = !csr && words < 120;

  const checks = [];
  let g1, g1d;
  if (csr) { g1 = "fail"; g1d = "no content before JS runs"; }
  else if (thin) { g1 = "warn"; g1d = "only " + words + " visible words"; }
  else { g1 = "pass"; g1d = words + " visible words"; }
  checks.push(["Content readable in raw HTML", g1, g1d]);

  const [[rstatus, rdetail], llms] = await Promise.all([
    robotsAllows(base),
    fetchUrl(base + "/llms.txt", "OpenAEO-audit").then(r => r.status < 400 ? "pass" : "fail").catch(() => "fail"),
  ]);
  checks.push(["robots.txt allows GPTBot, ClaudeBot, PerplexityBot", rstatus, rdetail]);
  checks.push(["llms.txt index present", llms, llms === "pass" ? "found" : "missing"]);
  const org = (types.has("Organization") && types.has("WebSite")) ? "pass" : (types.size ? "warn" : "fail");
  checks.push(["Organization + WebSite JSON-LD", org, [...types].slice(0, 4).join(", ") || "no JSON-LD"]);
  const prod = hasOfferPrice(blocks) ? "pass" : "warn";
  checks.push(["Product / Offer schema with price", prod, prod === "pass" ? "priced offer found" : "no priced Offer"]);
  const ans = hasNumberEarly ? "pass" : (title ? "warn" : "fail");
  checks.push(["Answer + a number in the first 100 words", ans, ans === "pass" ? "specific + titled" : "vague / no title or meta"]);
  const faq = types.has("FAQPage") ? "pass" : "fail";
  checks.push(["FAQPage schema present", faq, faq === "pass" ? "found" : "missing"]);
  const fresh = JSON.stringify(blocks).includes('"dateModified"') ? "pass" : "warn";
  checks.push(["Freshness (dateModified) present", fresh, fresh === "pass" ? "dateModified set" : "no freshness signal"]);

  const pts = { pass: 1.0, warn: 0.4, fail: 0.0 };
  const baseScore = Math.round(checks.reduce((a, c) => a + pts[c[1]], 0) / checks.length * 100);
  let cap = 100;
  if (!edgeOk) cap = Math.min(cap, 25);
  if (csr) cap = Math.min(cap, 25);
  if (rstatus === "fail") cap = Math.min(cap, 40);
  const score = Math.min(baseScore, cap);
  const fails = checks.filter(c => c[1] === "fail").length;

  let verdict, sub;
  if (csr) { verdict = "Invisible to AI crawlers."; sub = "Your content only appears after JavaScript runs — a crawler receives an empty page. This caps everything else."; }
  else if (!edgeOk) { verdict = "Blocked at the edge (" + edgeNote + ")."; sub = "Your CDN or WAF is turning AI bots away before they see a byte. robots.txt can't fix a 403."; }
  else if (score >= 83) { verdict = "AI-dominant. Defend it."; sub = "You clear the gates and the answer layer is quotable. Keep it fresh and push off-site consensus."; }
  else if (score >= 65) { verdict = "AI-competitive — close the gaps."; sub = "The gates pass. Tighten schema and the answer layer to get named ahead of competitors."; }
  else if (score >= 46) { verdict = "AI-ready, not yet cited."; sub = "Retrievable, but thin on quotable specifics and structured data. Fixable without a redesign."; }
  else { verdict = "Partially retrievable."; sub = "Some content is readable, but missing structure and specifics keep you out of the answer."; }

  return {
    domain: p.host, score, band: band(score), verdict, sub, fixCount: fails, edgeOk,
    platform: require("./platform").detectPlatform(body),
    checks: checks.map(c => ({ label: c[0], status: c[1], detail: c[2] })),
  };
}

// ---- remediation ----------------------------------------------------------
const FIX_LIBRARY = {
  "raw html": { title: "Prerender content so crawlers get real HTML", check: "Content readable in raw HTML", why: "AI crawlers do not run your JavaScript. If content only appears after hydration, they receive an empty page — this caps your whole score.", how: "Server-render or statically prerender the page so the full markup is in the first HTTP response." },
  "robots": { title: "Unblock AI crawlers in robots.txt", check: "robots.txt allows GPTBot, ClaudeBot, PerplexityBot", why: "A single inherited Disallow line can hide you from ChatGPT and Perplexity entirely.", how: "Explicitly Allow GPTBot, OAI-SearchBot, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended and link your sitemap." },
  "llms": { title: "Publish an llms.txt index", check: "llms.txt index present", why: "llms.txt is an emerging convention that hands assistants a clean, quotable summary of your site.", how: "Add /llms.txt: one-line description, key pages with what's on each, and a short list of verifiable facts." },
  "organization": { title: "Add Organization + WebSite JSON-LD", check: "Organization + WebSite JSON-LD", why: "Structured identity is how assistants know who you are and connect your name to your site.", how: "Add an Organization node (name, url, sameAs) and a WebSite node in a JSON-LD <script>." },
  "offer": { title: "Add Product/Offer schema with price", check: "Product / Offer schema with price", why: "A priced Offer lets assistants answer 'how much does X cost' with your real number.", how: "Add a Product with an Offer { price, priceCurrency } that mirrors your visible pricing." },
  "answer": { title: "Rewrite the first 100 words to answer + cite a number", check: "Answer + a number in the first 100 words", why: "Assistants lift the first concrete, specific sentence. Adjectives don't get quoted; numbers do.", how: "Lead with what you are, who it's for, and one verifiable specific (a price, a count, a founding year)." },
  "faqpage": { title: "Add FAQPage schema mirroring visible Q&A", check: "FAQPage schema present", why: "FAQPage schema maps directly onto the question-shaped queries people type into assistants.", how: "Wrap your real on-page Q&A in FAQPage / Question / acceptedAnswer JSON-LD." },
  "freshness": { title: "Emit a truthful dateModified", check: "Freshness (dateModified) present", why: "Assistants prefer sources that signal they're current.", how: "Add a truthful dateModified to your schema and keep it accurate — do not fake it." },
};
const FIX_ORDER = ["raw html", "robots", "llms", "organization", "offer", "answer", "faqpage", "freshness"];

/**
 * Turn an audit result into an ordered list of the fixes that apply.
 * @param {object} auditResult - the object returned by audit()
 * @returns {Array<object>} ordered fixes (highest-leverage first)
 */
function remediationPlan(auditResult) {
  const status = {}; (auditResult.checks || []).forEach(c => status[c.label] = c.status);
  const steps = [];
  for (const key of FIX_ORDER) {
    const fx = FIX_LIBRARY[key]; let st = null;
    for (const [label, s] of Object.entries(status)) {
      if (label.toLowerCase().includes(fx.check.split(" ")[0].toLowerCase()) || label.toLowerCase().includes(key)) { st = s; break; }
    }
    if (st === "fail" || st === "warn") steps.push(fx);
  }
  return steps;
}

module.exports = { audit, band, remediationPlan, FIX_LIBRARY };
