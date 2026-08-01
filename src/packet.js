// Engineering packet — turns an audit into tickets a human (or a coding agent)
// can execute without us in the room.
//
// Every ticket carries: the audit evidence that justifies it, stack-specific
// implementation steps, acceptance criteria, and an `agentPrompt` that can be
// pasted straight into Claude Code / Cursor / Codex to do the work.
//
// Honesty rules baked in: nothing here invents a fact about the business.
// Anything we can't derive from the crawl ships as a [BRACKET] the owner fills.
"use strict";


// ---- competitor evidence ---------------------------------------------------
// The "here's who is being recommended instead of you" section. Built ONLY from
// the user's own citation runs — real answers from real assistants for their
// real prompts. Nothing here is inferred or invented; if there are no runs, the
// section is omitted rather than filled with plausible-sounding guesses.
const PLATFORMS = new Set(["reddit.com","youtube.com","facebook.com","twitter.com","x.com",
  "linkedin.com","instagram.com","medium.com","quora.com","pinterest.com","tiktok.com"]);

function registrable(host) {
  host = String(host || "").toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  const p = host.split("."); return p.length >= 2 ? p.slice(-2).join(".") : host;
}

function competitorEvidence(citationRuns, clientDomain, knownCompetitors) {
  if (!citationRuns || !citationRuns.length) return null;
  const run = citationRuns[citationRuns.length - 1];
  const results = (run.results || []).filter(r => !r.mock);   // never build evidence from mock answers
  if (!results.length) return null;

  const client = registrable(clientDomain);
  const comps = new Set((knownCompetitors || []).map(registrable));
  const byDomain = new Map();
  const yourQueries = new Set();
  let citedYou = 0, totalQ = new Set();

  for (const r of results) {
    totalQ.add(r.query);
    if (r.status === "cited") { citedYou++; yourQueries.add(r.query); }
    for (const src of (r.sources || [])) {
      const d = registrable(src);
      if (!d || d === client) continue;
      if (!byDomain.has(d)) byDomain.set(d, { domain: d, citations: 0, queries: new Set(), surfaces: new Set(), isCompetitor: comps.has(d), isPlatform: PLATFORMS.has(d) });
      const e = byDomain.get(d);
      e.citations++; e.queries.add(r.query); if (r.surface) e.surfaces.add(r.surface);
    }
  }
  const ranked = [...byDomain.values()].sort((a, b) => b.citations - a.citations);
  const shape = e => ({ domain: e.domain, citations: e.citations, queries: [...e.queries].sort(),
                        surfaces: [...e.surfaces].sort(), type: e.isCompetitor ? "competitor" : e.isPlatform ? "community" : "publication" });
  return {
    testedOn: run.date || "",
    promptsTested: totalQ.size,
    youWereCited: citedYou,
    competitors: ranked.filter(e => e.isCompetitor).slice(0, 8).map(shape),
    roundups: ranked.filter(e => !e.isCompetitor && !e.isPlatform).slice(0, 10).map(shape),
    community: ranked.filter(e => e.isPlatform).slice(0, 5).map(shape),
    note: "Every domain below was named by an assistant in response to your own target prompts on "
        + (run.date || "the last run") + ". Mock results are excluded — this is only real answers.",
  };
}

const EFFORT = { S: "S (under an hour)", M: "M (half a day)", L: "L (1–2 days)", XL: "XL (project — scope with the team)" };

// Where the fix physically goes, per platform. Keeps the packet actionable for
// a Squarespace owner and a Next.js team alike.
const STACK_HINTS = {
  squarespace: {
    head: "Settings → Advanced → Code Injection → HEADER",
    file: "Code Injection (Squarespace has no repo)",
    robots: "Squarespace manages robots.txt and it already allows the major AI crawlers — skip this ticket.",
    agent: false,
  },
  wix: { head: "Marketing & SEO → SEO Settings → the page → Advanced SEO → Structured Data",
         file: "Wix SEO panel", robots: "Marketing & SEO → SEO Tools → Robots.txt Editor", agent: false },
  webflow: { head: "Site settings → Custom Code → Head Code",
             file: "Webflow Custom Code", robots: "Site settings → SEO → robots.txt", agent: false },
  shopify: { head: "Online Store → Themes → Edit code → layout/theme.liquid, before </head>",
             file: "layout/theme.liquid", robots: "Templates → robots.txt.liquid", agent: true },
  wordpress: { head: "header.php (child theme) or a headers plugin, before </head>",
               file: "header.php", robots: "Yoast/Rank Math → robots.txt editor", agent: true },
  custom: { head: "the template that renders <head> (base layout)",
            file: "your base layout template", robots: "public/robots.txt (or your static root)", agent: true },
};
function hints(platformId) { return STACK_HINTS[platformId] || STACK_HINTS.custom; }

// Map a failing check to a ticket definition.
const TICKETS = [
  {
    match: /raw HTML/i, id: "G1", gate: "G1", effort: "XL", owner: "Frontend / platform",
    title: "Server-render substantive copy so crawlers get real HTML",
    value: "Uncaps the entire score — nothing else counts until this passes",
    why: "AI crawlers don't run JavaScript. If your copy only appears after hydration, an assistant receives an empty shell and cannot quote you at all.",
    impl: h => [
      "Inventory which routes are server-rendered vs client-rendered.",
      "Verify per template: curl -s https://YOURDOMAIN/<route> | grep \"<a sentence you can see on the page>\" — no match means that copy is invisible to crawlers.",
      "Move substantive copy into server-rendered components; keep only interactivity client-side.",
      "Re-check with the same curl until your headline and body copy appear in the raw response.",
    ],
    accept: ["curl of each key template contains the visible headline and body copy",
             "Audit check 'Content readable in raw HTML' returns pass"],
    cmd: d => `curl -s https://${d}/ | grep -c "$(curl -s https://${d}/ | sed -n 's/.*<h1[^>]*>\\([^<]*\\).*/\\1/p' | head -1)"  # expect >= 1`,
    points: 22, phase: 0,
    agent: "Find where this project renders page copy. Identify any substantive text that only exists after client-side hydration, and move it to server-rendered output. Do not change the design or wording. Then verify with curl that the headline appears in the raw HTML.",
  },
  {
    match: /robots\.txt/i, id: "G3", gate: "G3", effort: "S", owner: "Whoever owns deploys",
    title: "Allow the AI crawlers in robots.txt",
    value: "A single inherited Disallow can hide the whole site from ChatGPT and Perplexity",
    why: "robots.txt is checked before anything else is fetched. One stale line from a relaunch can make you invisible for months without any other symptom.",
    impl: h => ["Open " + h.robots + ".",
                "Add explicit Allow rules for GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended, Bingbot and Applebot.",
                "Keep your existing rules — merge, don't replace.",
                "Confirm it serves at https://YOURDOMAIN/robots.txt."],
    accept: ["/robots.txt returns 200 and lists the AI user-agents with Allow: /",
             "No Disallow: / applies to those agents"],
    cmd: d => `curl -s https://${d}/robots.txt | grep -A1 -iE "GPTBot|ClaudeBot|PerplexityBot"`,
    points: 12, phase: 0,
    agent: "Read the existing robots.txt if present, merge in Allow rules for the AI crawlers (GPTBot, OAI-SearchBot, ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, Google-Extended, Bingbot, Applebot) without removing existing rules, and write it back to the static root.",
  },
  {
    match: /llms\.txt/i, id: "A7", gate: "A7", effort: "S", owner: "Content + deploys",
    title: "Publish an llms.txt index",
    value: "Hands assistants a clean, quotable summary instead of making them infer one",
    why: "llms.txt is an emerging convention: a short, plain-text description of what you do and which pages matter. It costs nothing and removes ambiguity.",
    impl: h => ["Create /llms.txt at your static root.",
                "One line on what the business does and who it's for.",
                "List your key pages with one line each on what's on them.",
                "Add 2–4 verifiable facts (a price, a count, a founding year) — no marketing adjectives."],
    accept: ["/llms.txt returns 200", "Contains no unresolved [BRACKETS]"],
    cmd: d => `curl -sI https://${d}/llms.txt | head -1   # expect 200`,
    points: 4, phase: 1, needs: ["A one-line description of what the business does and who it is for", "2-4 verifiable facts (a price, a count, a founding year)"],
    agent: "Create an llms.txt at the static root following the llms.txt convention. Use only facts you can verify from the site's own content — leave [BRACKETS] for anything you cannot confirm and tell the user what to fill in.",
  },
  {
    match: /Organization \+ WebSite/i, id: "B1", gate: "B1", effort: "M", owner: "Frontend",
    title: "Add Organization + WebSite JSON-LD",
    value: "How assistants resolve who you are and connect your name to your domain",
    why: "Without structured identity an assistant has to guess whether your brand name refers to your business. Schema removes the guess.",
    impl: h => ["Add a JSON-LD <script> in " + h.head + ".",
                "Include an Organization node (name, url, sameAs) and a WebSite node.",
                "sameAs must list profiles you actually control — leave [VERIFY] markers rather than guessing.",
                "Validate at validator.schema.org before shipping."],
    accept: ["Page source contains valid Organization and WebSite JSON-LD",
             "No unresolved [VERIFY] markers remain", "validator.schema.org reports no errors"],
    cmd: d => `curl -s https://${d}/ | grep -o '"@type":"Organization"' | head -1`,
    points: 8, phase: 1, needs: ["Your LinkedIn / X / other profile URLs for sameAs (we will not guess these)"],
    agent: "Add Organization and WebSite JSON-LD to the site's <head> template. Derive name and url from the site itself. For sameAs, leave [VERIFY: ...] placeholders — do NOT invent social URLs. Validate the JSON parses.",
  },
  {
    match: /Product \/ Offer/i, id: "B4", gate: "B4", effort: "M", owner: "Frontend + whoever owns pricing",
    title: "Add Product/Offer schema with a real price",
    value: "Lets assistants answer \"how much does it cost\" with your number instead of a competitor's",
    why: "Priced Offer schema is what turns a pricing page into a quotable answer. It must mirror the price actually visible on the page.",
    impl: h => ["On the pricing page, add Product schema with an Offer (price, priceCurrency, availability).",
                "The price in schema MUST equal the price shown on the page — mismatches get discounted.",
                "If pricing is quote-based, publish a starting-from number or skip this ticket honestly."],
    accept: ["Pricing page carries a priced Offer", "Schema price matches the visible price exactly"],
    cmd: d => `curl -s https://${d}/pricing | grep -o '"price"[^,]*' | head -3`,
    points: 6, phase: 2, needs: ["Confirmed current prices, exactly as they appear on the page"],
    agent: "Add Product/Offer JSON-LD to the pricing page using the prices ALREADY VISIBLE on that page. Never invent or adjust a price. If no price is visible, stop and tell the user this ticket can't be completed honestly.",
  },
  {
    match: /first 100 words/i, id: "C1", gate: "C1", effort: "M", owner: "Content",
    title: "Rewrite the opening 100 words to answer, with a number",
    value: "Assistants quote the first concrete sentence — adjectives don't get cited, specifics do",
    why: "The opening of your key pages is what gets lifted into an answer. \"Premium, best-in-class\" is unquotable; \"$24, 300+ sold since 2019\" is.",
    impl: h => ["Open each key page with what you are, who it's for, and one verifiable specific.",
                "Put it in the first 100 words of visible copy — not below the fold.",
                "Make sure <title> and <meta name=\"description\"> agree with that opening.",
                "Use real numbers only; leave [BRACKETS] for anything unverified."],
    accept: ["First 100 words contain the category, the audience and at least one number",
             "title/meta/H1 agree semantically"],
    cmd: d => `curl -s https://${d}/ | sed 's/<[^>]*>/ /g' | tr -s " " | head -c 700 | grep -oE "[0-9]+"`,
    points: 9, phase: 2, needs: ["One verifiable specific per key page: a price, a customer count, a founding year, or a city"],
    agent: "Draft a rewritten opening paragraph for each key page. Use ONLY specifics you can verify from the existing site content; put [BRACKETS] around anything you cannot confirm and list them for the user. Present the draft for approval — do not publish copy changes silently.",
  },
  {
    match: /FAQPage/i, id: "B3", gate: "B3", effort: "M", owner: "Content + frontend",
    title: "Add FAQPage schema mirroring visible Q&A",
    value: "Maps directly onto the question-shaped queries people type into assistants",
    why: "Assistants answer questions. A page with real Q&A plus FAQPage schema is the closest thing to a pre-formatted answer you can publish.",
    impl: h => ["Write (or collect) 8–12 questions customers actually ask.",
                "Answer each in 40–80 words, self-contained, with a specific.",
                "Publish them visibly on the page, then mirror them in FAQPage JSON-LD.",
                "Schema must match the visible text — don't add questions only to the schema."],
    accept: ["FAQ page shows the Q&A visibly", "FAQPage JSON-LD mirrors it exactly", "8+ questions"],
    cmd: d => `curl -s https://${d}/faq | grep -o '"@type":"Question"' | wc -l   # expect >= 8`,
    points: 6, phase: 2, needs: ["8-12 questions customers actually ask, with your real answers"],
    agent: "Add FAQPage JSON-LD that mirrors the Q&A ALREADY VISIBLE on the page. If there is no visible FAQ, draft one from the site's existing content for the user to approve first — never ship schema for Q&A that isn't on the page.",
  },
  {
    match: /Freshness|dateModified/i, id: "B7", gate: "B7", effort: "S", owner: "Frontend",
    title: "Emit a truthful dateModified",
    value: "Assistants prefer sources that signal they're current",
    why: "A missing freshness signal makes a current page look stale. A faked one is worse — it's the kind of thing that gets a source discounted.",
    impl: h => ["Add dateModified to your page schema, wired to the real last-modified date.",
                "Surface a visible \"Updated <date>\" that matches it.",
                "Never bump the date without a real content change."],
    accept: ["dateModified present and equal to the visible updated date", "Value is genuinely accurate"],
    cmd: d => `curl -s https://${d}/ | grep -o '"dateModified":"[^"]*"' | head -1`,
    points: 5, phase: 3,
    agent: "Wire dateModified in the page schema to the real last-modified date from the CMS or git history. Do not hardcode today's date.",
  },
];

function ticketsFor(auditResult, platformId) {
  const h = hints(platformId);
  const failing = (auditResult.checks || []).filter(c => c.status !== "pass");
  const out = [];
  let n = 0;
  for (const def of TICKETS) {
    const check = failing.find(c => def.match.test(c.label));
    if (!check) continue;
    // platform can't do it → say so instead of issuing an impossible ticket
    if (def.id === "G3" && platformId === "squarespace") continue;
    n++;
    out.push({
      id: "AEO-" + String(n).padStart(2, "0"),
      rubric: def.gate,
      // VERIFIED = the crawl proved this gap (fail). POTENTIAL = it may already
      // partly pass (warn) — those raise the ceiling, never the forecast.
      confidence: check.status === "fail" ? "verified" : "potential",
      points: def.points || 0,
      phase: def.phase == null ? 3 : def.phase,
      acceptanceCommand: def.cmd ? def.cmd(auditResult.domain || "YOURDOMAIN") : null,
      needsFromYou: def.needs || [],
      title: def.title,
      owner: def.owner,
      effort: EFFORT[def.effort],
      priority: check.status === "fail" ? "P1" : "P2",
      value: def.value,
      why: def.why,
      evidence: check.label + " — " + check.detail,
      where: def.id === "G3" ? h.robots : h.head,
      implementation: def.impl(h),
      acceptance: def.accept,
      agentPrompt: def.agent,
    });
  }
  return out;
}

/** Build the whole packet from an audit result. */
const ON_SITE_CEILING = 82;   // on-site work alone can't reach AI-dominant

function buildPacket(auditResult, opts) {
  opts = opts || {};
  const platform = (auditResult.platform && auditResult.platform.id) || "custom";
  const platformName = (auditResult.platform && auditResult.platform.name) || "custom / self-hosted";
  const tickets = ticketsFor(auditResult, platform);
  const p1 = tickets.filter(t => t.priority === "P1").length;
  // Honest projection. Shipping these tickets clears the headline checks, but the
  // full rubric also scores off-site consensus (reviews, third-party roundups,
  // community mentions) and measurement — none of which a code change can fix.
  // So we cap the on-site projection at the top of AI-competitive (82) and say
  // plainly that 83+ needs off-site work. Never project a perfect score.
  const passing = (auditResult.checks || []).filter(c => c.status === "pass").length;
  const total = (auditResult.checks || []).length || 8;
  // NOTE: the real projection is computed from the phase table below (verified
  // points only). `raw` is kept only as the optimistic ceiling for context.
  const raw = Math.min(Math.round(((passing + tickets.length) / total) * 100), ON_SITE_CEILING);

  // Phase table. Projections count VERIFIED points only; potential points raise
  // the ceiling but never the forecast — the same discipline as the hand-built packets.
  const PHASE_NAME = { 0: "Phase 0 — the gate (do this first)", 1: "Phase 1 — quick wins",
                       2: "Phase 2 — big bets", 3: "Phase 3 — fill-ins" };
  const phases = [0, 1, 2, 3].map(ph => {
    const inPhase = tickets.filter(t => t.phase === ph);
    const verified = inPhase.filter(t => t.confidence === "verified").reduce((n, t) => n + t.points, 0);
    const potential = inPhase.filter(t => t.confidence === "potential").reduce((n, t) => n + t.points, 0);
    return { phase: ph, name: PHASE_NAME[ph], tickets: inPhase.map(t => t.id),
             verifiedPts: verified, potentialPts: potential };
  }).filter(p => p.tickets.length);
  // running projected score, verified points only, capped
  let running = auditResult.score;
  for (const ph of phases) { running = Math.min(running + ph.verifiedPts, ON_SITE_CEILING); ph.projected = running; }

  // Everything the owner must supply, deduped — the "send this list" section.
  const askSet = new Set();
  tickets.forEach(t => (t.needsFromYou || []).forEach(x => askSet.add(x)));
  const h2 = hints(platform);
  const access = h2.agent
    ? ["Repo access, or the template that renders <head> plus one rendered page (curl output)"]
    : ["Admin access to " + platformName + " (or someone who can paste into it)"];

  // ---- tier split ----------------------------------------------------------
  // free  = the open-source packet: tickets you can act on, no infrastructure.
  // solo+ = adds what needs a server or paid APIs behind it — the representative
  //         crawl, the phase plan, and competitor evidence from live citation runs.
  const tier = (opts.tier || "solo").toLowerCase();
  if (tier === "free") {
    return {
      meta: { domain: auditResult.domain, brand: opts.brand || (auditResult.domain || "").split(".")[0],
              generated: new Date().toISOString().slice(0, 10), platform: platformName,
              agentReady: hints(platform).agent, tier: "free", openSource: true },
      summary: { today: auditResult.score, band: auditResult.band, verdict: auditResult.verdict,
                 detail: auditResult.sub, ticketCount: tickets.length,
                 blocking: tickets.filter(t => t.priority === "P1").length },
      checks: auditResult.checks || [],
      tickets: tickets.map(t => ({
        id: t.id, rubric: t.rubric, title: t.title, priority: t.priority, owner: t.owner,
        effort: t.effort, value: t.value, why: t.why, evidence: t.evidence, where: t.where,
        implementation: t.implementation, acceptance: t.acceptance,
        acceptanceCommand: t.acceptanceCommand, agentPrompt: t.agentPrompt,
      })),
      notes: [
        "This is the open-source packet — everything here runs locally with no account (npx openaeo-audit).",
        "Anything we could not verify from your site ships as a [BRACKET]. We do not invent prices, counts, dates or profile URLs.",
      ],
      upgrade: {
        message: "Solo ($10/mo) adds a representative crawl across your templates, a phased plan with "
               + "verified-only forecasting, competitor evidence from live citation tests, and a "
               + "print-ready PDF.",
        url: "https://openaeo.dev/pricing",
      },
    };
  }

  return {
    meta: {
      domain: auditResult.domain,
      brand: opts.brand || (auditResult.domain || "").split(".")[0],
      generated: new Date().toISOString().slice(0, 10),
      platform: platformName,
      agentReady: hints(platform).agent,
      tier: "solo",
    },
    summary: {
      today: auditResult.score,
      band: auditResult.band,
      // verified-only forecast (last phase's running total) — never the optimistic one
      projected: phases.length ? phases[phases.length - 1].projected : auditResult.score,
      ceiling: raw,
      verdict: auditResult.verdict,
      detail: auditResult.sub,
      blocking: p1,
      ticketCount: tickets.length,
    },
    checks: auditResult.checks || [],
    competitors: competitorEvidence(opts.citationRuns, auditResult.domain, opts.competitors),
    phases,
    whatWeNeedFromYou: { access, values: [...askSet] },
    tickets,
    notes: [
      "Every ticket below is justified by evidence from the crawl of " + auditResult.domain + " on " + new Date().toISOString().slice(0, 10) + ".",
      "Anything we could not verify from your site ships as a [BRACKET] for you to fill. We do not invent prices, counts, dates or profile URLs.",
      "The projected score is what these on-site tickets can reach. It is capped at 82 on purpose: the rubric also scores off-site consensus — reviews, third-party roundups, community mentions — which no code change can fix. 83+ (AI-dominant) needs that separate off-site track.",
      "We will not project a perfect score. If a tool promises you 100/100 from code changes alone, it is not counting the same things.",
    ],
  };
}

module.exports = { buildPacket, ticketsFor, hints, competitorEvidence };
