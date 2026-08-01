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
  const ON_SITE_CEILING = 82;
  const passing = (auditResult.checks || []).filter(c => c.status === "pass").length;
  const total = (auditResult.checks || []).length || 8;
  const raw = Math.round(((passing + tickets.length) / total) * 100);
  const projected = Math.min(raw, ON_SITE_CEILING);

  return {
    meta: {
      domain: auditResult.domain,
      brand: opts.brand || (auditResult.domain || "").split(".")[0],
      generated: new Date().toISOString().slice(0, 10),
      platform: platformName,
      agentReady: hints(platform).agent,
    },
    summary: {
      today: auditResult.score,
      band: auditResult.band,
      projected: Math.min(projected, 100),
      verdict: auditResult.verdict,
      detail: auditResult.sub,
      blocking: p1,
      ticketCount: tickets.length,
    },
    checks: auditResult.checks || [],
    tickets,
    notes: [
      "Every ticket below is justified by evidence from the crawl of " + auditResult.domain + " on " + new Date().toISOString().slice(0, 10) + ".",
      "Anything we could not verify from your site ships as a [BRACKET] for you to fill. We do not invent prices, counts, dates or profile URLs.",
      "The projected score is what these on-site tickets can reach. It is capped at 82 on purpose: the rubric also scores off-site consensus — reviews, third-party roundups, community mentions — which no code change can fix. 83+ (AI-dominant) needs that separate off-site track.",
      "We will not project a perfect score. If a tool promises you 100/100 from code changes alone, it is not counting the same things.",
    ],
  };
}

module.exports = { buildPacket, ticketsFor, hints };
