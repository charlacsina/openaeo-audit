// OpenAEO, quick AEO/GEO audit engine.
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


/* ---- the per-bot edge matrix ----
 *
 * robots.txt is a request; a content delivery network is an enforcer, and they
 * disagree more often than anyone expects. A site can allow ClaudeBot in
 * robots.txt and still have its CDN answer that crawler a 403, and no edit to
 * robots.txt undoes a 403. The only way to know is to ask as each crawler and
 * record what came back.
 *
 * Google-Extended is deliberately not fetched. It is a robots.txt token telling
 * Google whether it may use the content for Gemini; no crawler identifies as it,
 * Googlebot does the fetching. Inventing a Google-Extended user agent would
 * produce a number that looks like evidence and is not, so it is read from
 * robots.txt and reported as policy rather than reachability.
 */
// What kind of page is this, and therefore which checks are fair to apply.
//
// Scoring every page against every check quietly rewards schema stuffing. An
// About page has no product and no FAQ, so demanding Product/Offer and FAQPage
// there pushes the owner to bolt on markup describing content that does not
// exist. That is floating schema, the practice this tool tells people to avoid,
// and until now this tool was recommending it: run the CLI against your own
// About page and it would tell you to add an Offer to a page that sells nothing.
function pageKind(pathname, types) {
  const path = String(pathname || "/").toLowerCase().replace(/\/+$/, "") || "/";
  if (types.has("Product") || types.has("Offer") ||
      /^\/(pricing|plans?|buy|shop|store|products?|checkout|order)(\/|$)/.test(path)) return "commerce";
  if (types.has("Article") || types.has("BlogPosting") || types.has("NewsArticle") ||
      /^\/(blog|news|articles?|posts?|stories)(\/|$)/.test(path)) return "article";
  if (/^\/(docs?|documentation|api|guides?|reference|help|support|manual|changelog)(\/|$)/.test(path)) return "docs";
  if (/^\/(about|contact|team|careers?|privacy|terms|legal|licen[cs]e|imprint|security)(\/|$)/.test(path))
    return "informational";
  return path === "/" ? "homepage" : "general";
}

// A price on the page is what makes Offer schema honest, not the page's job title.
const MONEY_RE = /(?:[$£€¥]\s?\d|\b\d+(?:\.\d+)?\s?(?:usd|eur|gbp)\b|\bper month\b|\/mo\b)/i;

function faqMirrorRate(blocks, text) {
  const norm = t => String(t || "").replace(/\s+/g, " ").trim().toLowerCase();
  const visible = norm(text);
  const answers = [];
  const walk = n => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    const t = n["@type"];
    if ((t === "Question" || (Array.isArray(t) && t.includes("Question")))) {
      const a = n.acceptedAnswer || n.suggestedAnswer;
      const txt = a && (a.text || (Array.isArray(a) && a[0] && a[0].text));
      if (txt) answers.push(norm(String(txt).replace(/<[^>]+>/g, " ")));
    }
    for (const k of Object.keys(n)) walk(n[k]);
  };
  walk(blocks);
  if (!answers.length) return { total: 0, mirrored: 0 };
  const mirrored = answers.filter(a => a.length > 24 && visible.includes(a.slice(0, 120))).length;
  return { total: answers.length, mirrored };
}

function freshnessTruth(blocks, body) {
  const m = JSON.stringify(blocks).match(/"dateModified"\s*:\s*"([\d-]{10})/);
  if (!m) return { present: false };
  const stamped = m[1];
  const today = new Date().toISOString().slice(0, 10);
  // The stamp is the one labelled "Updated", not merely the first <time> in the
  // file. A page may legitimately carry other dates: this site reports a crawler
  // measurement taken on someone else's server, marked up as <time> because that
  // is what it is, and reading that as the page's freshness stamp reports a
  // disagreement that does not exist.
  const vis = body.match(/Updated\s*<time[^>]+datetime="([\d-]{10})"/i)
           || body.match(/<time[^>]+datetime="([\d-]{10})"[^>]*>[^<]*<\/time>\s*<\/(?:p|div|footer)/i)
           || body.match(/<time[^>]+datetime="([\d-]{10})"/i);
  return {
    present: true, stamped,
    future: stamped > today,
    visible: vis ? vis[1] : null,
    disagrees: !!(vis && vis[1] !== stamped),
  };
}

// Question-shaped content is what makes FAQPage honest.
function looksFaq(body, types) {
  if (types.has("FAQPage") || types.has("QAPage")) return true;
  if (/id=["'][^"']*faq|class=["'][^"']*faq|frequently asked/i.test(body)) return true;
  return (body.match(/<h[2-4][^>]*>[^<]*\?\s*<\/h[2-4]>/gi) || []).length >= 2;
}

const AI_BOTS = [
  { name: "GPTBot",           surface: "ChatGPT",      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot" },
  { name: "OAI-SearchBot",    surface: "ChatGPT",      ua: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot" },
  { name: "ClaudeBot",        surface: "Claude",       ua: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)" },
  { name: "Claude-SearchBot", surface: "Claude",       ua: "Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +claudebot@anthropic.com)" },
  { name: "PerplexityBot",    surface: "Perplexity",   ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot" },
  { name: "Googlebot",        surface: "AI Overviews", ua: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
  { name: "Bingbot",          surface: "Copilot",      ua: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)" },
  { name: "Applebot",         surface: "Siri",         ua: "Mozilla/5.0 (compatible; Applebot/0.1; +http://www.apple.com/go/applebot)" },
];

function robotsDisallowsAgent(low, agent) {
  for (const g of String(low || "").split(/^\s*user-agent:/im)) {
    const who = (g.trim().split("\n")[0] || "").trim();
    if ((who === agent || who === "*") && /^\s*disallow:\s*\/\s*$/im.test(g)) return true;
  }
  return false;
}

// A HEAD is enough to learn whether the edge lets a crawler in, and it costs the
// audited site almost nothing. Servers that reject HEAD are retried with a GET.
async function botStatus(url, ua) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    let r = await fetch(url, { method: "HEAD", headers: { "User-Agent": ua, Accept: "text/html,*/*" }, redirect: "follow", signal: ctrl.signal });
    if (r.status === 405 || r.status === 501) {
      r = await fetch(url, { headers: { "User-Agent": ua, Accept: "text/html,*/*" }, redirect: "follow", signal: ctrl.signal });
    }
    return { status: r.status, server: r.headers.get("server") || "" };
  } catch (e) {
    return { status: 0, server: "", error: e.name === "AbortError" ? "timeout" : "unreachable" };
  } finally { clearTimeout(t); }
}

// Every crawler asked at once. allSettled, because one hostile response must not
// lose the other seven results.
// A neutral non-browser client, used as a control.
//
// This is what makes the matrix interpretable rather than merely suggestive. We
// fetch with a crawler's user agent from this machine, and a real crawler arrives
// from its operator's network. A firewall that keys on the address can refuse us
// precisely because we are an unverified client claiming to be GPTBot, while
// waving the real one through, and the reverse also happens.
//
// So a 403 alone does not distinguish "this site refuses GPTBot" from "this site
// refuses anything that is not a browser". The control separates them.
const UA_CONTROL = "OpenAEO-control/1.0 (+https://openaeo.dev/crawler-check)";

async function edgeMatrix(url, robotsBody) {
  const [settled, control] = await Promise.all([
    Promise.allSettled(AI_BOTS.map(b => botStatus(url, b.ua))),
    botStatus(url, UA_CONTROL),
  ]);
  const low = String(robotsBody || "").toLowerCase();
  const bots = AI_BOTS.map((b, i) => {
    const r = settled[i].status === "fulfilled" ? settled[i].value : { status: 0, error: "unreachable" };
    const reachable = r.status > 0 && r.status < 400;
    return { name: b.name, surface: b.surface, kind: "fetched", status: r.status,
             server: r.server || undefined, ok: reachable,
             note: reachable ? "" : (r.error || ("HTTP " + r.status + " at the edge")) };
  });
  const dis = robotsDisallowsAgent(low, "google-extended");
  bots.push({ name: "Google-Extended", surface: "Gemini", kind: "policy", status: null,
              ok: !dis,
              note: dis ? "disallowed in robots.txt" : "robots.txt token only, no crawler identifies as it" });

  const controlOk = control.status > 0 && control.status < 400;
  const anyBlocked = bots.some(b => b.kind === "fetched" && !b.ok);
  if (!anyBlocked) {
    bots.confidence = { level: "clear", control: control.status,
      note: "Every crawler we asked was served, and so was a plain unidentified client." };
  } else if (controlOk) {
    bots.confidence = { level: "name-based", control: control.status,
      note: "A plain unidentified client was served while these crawlers were refused, so the rule "
          + "keys on the crawler's name rather than on us being an unknown client." };
  } else {
    bots.confidence = { level: "inconclusive", control: control.status,
      note: "A plain unidentified client was refused too, so this site turns away anything that is not "
          + "a recognised browser. We cannot tell from the outside whether AI crawlers are singled out." };
  }
  return bots;
}

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

  // Ask every crawler, not one. robots.txt is fetched once and shared with the
  // matrix, which needs it for the single agent that has no crawler behind it.
  const robotsBody = await fetchUrl(p.protocol + "//" + p.host + "/robots.txt", UA_BOT)
    .then(r => r.text).catch(() => "");
  const bots = await edgeMatrix(url, robotsBody);
  const blockedBots = bots.filter(b => b.kind === "fetched" && !b.ok);
  const fetchedBots = bots.filter(b => b.kind === "fetched");
  if (blockedBots.length) {
    edgeOk = false;
    edgeNote = blockedBots.length === fetchedBots.length
      ? "every AI crawler blocked at the edge"
      : blockedBots.map(b => b.name).join(", ") + " blocked at the edge";
  }

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
  const kind = pageKind(p.pathname, types);
  const offerApplies = kind === "commerce" || hasOfferPrice(blocks) || MONEY_RE.test(text);
  const prod = hasOfferPrice(blocks) ? "pass" : "warn";
  checks.push(["Product / Offer schema with price", prod,
    offerApplies ? (prod === "pass" ? "priced offer found" : "no priced Offer") : "nothing is sold on this page",
    offerApplies,
    offerApplies ? null : "This page shows no price, so Offer schema here would describe a product that is not on it."]);
  const ans = hasNumberEarly ? "pass" : (title ? "warn" : "fail");
  checks.push(["Answer + a number in the first 100 words", ans, ans === "pass" ? "specific + titled" : "vague / no title or meta"]);
  const faqApplies = looksFaq(body, types);
  let faq, faqDetail;
  if (!types.has("FAQPage")) { faq = "fail"; faqDetail = "missing"; }
  else {
    const mir = faqMirrorRate(blocks, text);
    if (!mir.total) { faq = "warn"; faqDetail = "FAQPage declared with no questions in it"; }
    else if (mir.mirrored === mir.total) { faq = "pass"; faqDetail = mir.total + " of " + mir.total + " answers appear on the page"; }
    else if (mir.mirrored === 0) { faq = "fail"; faqDetail = "none of the " + mir.total + " answers appear in the visible copy"; }
    else { faq = "warn"; faqDetail = mir.mirrored + " of " + mir.total + " answers appear in the visible copy"; }
  }
  checks.push(["FAQPage schema mirroring the page", faq,
    faqApplies ? faqDetail : "no question and answer content here",
    faqApplies,
    faqApplies ? null : "This page asks no questions, so FAQPage schema here would be markup with nothing behind it."]);
  const ft = freshnessTruth(blocks, body);
  let fresh, freshDetail;
  if (!ft.present) { fresh = "warn"; freshDetail = "no freshness signal"; }
  else if (ft.future) { fresh = "fail"; freshDetail = "dateModified " + ft.stamped + " is in the future"; }
  else if (ft.disagrees) { fresh = "warn"; freshDetail = "dateModified " + ft.stamped + " but the page shows " + ft.visible; }
  else { fresh = "pass"; freshDetail = "dateModified " + ft.stamped + (ft.visible ? ", and the page says so too" : ""); }
  checks.push(["Freshness date that is true", fresh, freshDetail]);

  const pts = { pass: 1.0, warn: 0.4, fail: 0.0 };
  // Score over what applies to this page. A page is never marked down for
  // declining to publish schema about content it does not have.
  const scored = checks.filter(c => c[3] !== false);
  const notApplicable = checks.length - scored.length;
  const baseScore = Math.round(scored.reduce((a, c) => a + pts[c[1]], 0) / scored.length * 100);
  let cap = 100;
  if (!edgeOk) cap = Math.min(cap, 25);
  if (csr) cap = Math.min(cap, 25);
  if (rstatus === "fail") cap = Math.min(cap, 40);
  const score = Math.min(baseScore, cap);
  const fails = scored.filter(c => c[1] === "fail").length;

  let verdict, sub;
  if (csr) { verdict = "Invisible to AI crawlers."; sub = "Your content only appears after JavaScript runs, a crawler receives an empty page. This caps everything else."; }
  else if (!edgeOk) { verdict = "Blocked at the edge (" + edgeNote + ")."; sub = "Your CDN or WAF is turning AI bots away before they see a byte. robots.txt can't fix a 403."; }
  else if (score >= 83) { verdict = "AI-dominant. Defend it."; sub = "You clear the gates and the answer layer is quotable. Keep it fresh and push off-site consensus."; }
  else if (score >= 65) { verdict = "AI-competitive. Close the gaps."; sub = "The gates pass. Tighten schema and the answer layer to get named ahead of competitors."; }
  else if (score >= 46) { verdict = "AI-ready, not yet cited."; sub = "Retrievable, but thin on quotable specifics and structured data. Fixable without a redesign."; }
  else { verdict = "Partially retrievable."; sub = "Some content is readable, but missing structure and specifics keep you out of the answer."; }

  return {
    domain: p.host, score, band: band(score), verdict, sub, fixCount: fails, edgeOk, bots,
    platform: require("./platform").detectPlatform(body),
    pageType: kind, checksScored: scored.length, checksNotApplicable: notApplicable,
    crawlerEvidence: {
      method: "We request the page with each crawler's user agent, from this machine.",
      limitation: "A real crawler arrives from its operator's published address range. A firewall that "
                + "checks the address can refuse us and allow the real one, or the reverse. Treat this "
                + "as an indication.",
      settles_it: "Your own server logs. Run `openaeo-audit log <file>` to read one, or use the "
                + "aeo_read_log tool, and it will check every crawler against the range its operator "
                + "publishes. Nothing leaves your machine.",
      confidence: (bots && bots.confidence) || null,
    },
    checks: checks.map(c => ({ label: c[0], status: c[1], detail: c[2],
      applicable: c[3] !== false, notApplicableWhy: c[4] || null })),
  };
}

// ---- remediation ----------------------------------------------------------
const FIX_LIBRARY = {
  "raw html": { title: "Prerender content so crawlers get real HTML", check: "Content readable in raw HTML", why: "AI crawlers do not run your JavaScript. If content only appears after hydration, they receive an empty page, this caps your whole score.", how: "Server-render or statically prerender the page so the full markup is in the first HTTP response." },
  "robots": { title: "Unblock AI crawlers in robots.txt", check: "robots.txt allows GPTBot, ClaudeBot, PerplexityBot", why: "A single inherited Disallow line can hide you from ChatGPT and Perplexity entirely.", how: "Explicitly Allow GPTBot, OAI-SearchBot, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended and link your sitemap." },
  "llms": { title: "Publish an llms.txt index", check: "llms.txt index present", why: "llms.txt is an emerging convention that hands assistants a clean, quotable summary of your site.", how: "Add /llms.txt: one-line description, key pages with what's on each, and a short list of verifiable facts." },
  "organization": { title: "Add Organization + WebSite JSON-LD", check: "Organization + WebSite JSON-LD", why: "Structured identity is how assistants know who you are and connect your name to your site.", how: "Add an Organization node (name, url, sameAs) and a WebSite node in a JSON-LD <script>." },
  "offer": { title: "Add Product/Offer schema with price", check: "Product / Offer schema with price", why: "A priced Offer lets assistants answer 'how much does X cost' with your real number.", how: "Add a Product with an Offer { price, priceCurrency } that mirrors your visible pricing." },
  "answer": { title: "Rewrite the first 100 words to answer + cite a number", check: "Answer + a number in the first 100 words", why: "Assistants lift the first concrete, specific sentence. Adjectives don't get quoted; numbers do.", how: "Lead with what you are, who it's for, and one verifiable specific (a price, a count, a founding year)." },
  "faqpage": { title: "Add FAQPage schema mirroring visible Q&A", check: "FAQPage schema mirroring the page", why: "FAQPage schema maps directly onto the question-shaped queries people type into assistants.", how: "Wrap your real on-page Q&A in FAQPage / Question / acceptedAnswer JSON-LD." },
  "freshness": { title: "Emit a truthful dateModified", check: "Freshness date that is true", why: "Assistants prefer sources that signal they're current.", how: "Add a truthful dateModified to your schema and keep it accurate, do not fake it." },
};
const FIX_ORDER = ["raw html", "robots", "llms", "organization", "offer", "answer", "faqpage", "freshness"];

/**
 * Turn an audit result into an ordered list of the fixes that apply.
 * @param {object} auditResult - the object returned by audit()
 * @returns {Array<object>} ordered fixes (highest-leverage first)
 */
function remediationPlan(auditResult) {
  // Not-applicable checks never become fixes. This is the whole point of the
  // page-type work: printing "Add FAQPage schema" under a page that asks no
  // questions is instructing somebody to publish markup with nothing behind it,
  // and an agent reading this list will simply do it.
  const status = {};
  (auditResult.checks || []).forEach(c => { if (c.applicable !== false) status[c.label] = c.status; });
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

module.exports = { audit, band, remediationPlan, edgeMatrix, AI_BOTS, FIX_LIBRARY };
