// Fix generators, deterministic, zero-dependency.
// Produces the actual files an AI-citable site needs (robots.txt, llms.txt,
// JSON-LD) and can apply the safe structural fixes directly to a page's HTML.
// No LLM, no network: everything here is derived from the input.
"use strict";

const AI_BOTS = [
  "GPTBot", "OAI-SearchBot", "ChatGPT-User",
  "ClaudeBot", "Claude-SearchBot", "Claude-User",
  "PerplexityBot", "Google-Extended", "Bingbot", "Applebot",
];

function cleanDomain(d) {
  return String(d || "").trim().toLowerCase()
    .replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
}
function today() { return new Date().toISOString().slice(0, 10); }

/** robots.txt that explicitly allows the AI crawlers that matter. */
function robotsTxt(domain) {
  const dom = cleanDomain(domain) || "your-site.com";
  return "# " + dom + ": AI crawlers allowed\n"
    + AI_BOTS.map(b => "User-agent: " + b + "\nAllow: /").join("\n")
    + "\n\nUser-agent: *\nAllow: /\nDisallow: /account/\nDisallow: /api/\n\n"
    + "Sitemap: https://" + dom + "/sitemap.xml\n";
}

/** llms.txt, a clean, quotable index for assistants. Brackets are yours to fill. */
function llmsTxt(domain, brand) {
  const dom = cleanDomain(domain) || "your-site.com";
  brand = brand || dom.split(".")[0];
  return "# " + brand + "\n\n> [One line: what " + brand + " does, who it's for.]\n\n"
    + "Last updated: " + today() + "\n\n"
    + "## Pages\n"
    + "- [Home](https://" + dom + "/): [what's here]\n"
    + "- [Pricing](https://" + dom + "/pricing): [your real numbers]\n\n"
    + "## Facts\n"
    + "- [category], [one verifiable number]\n"
    + "- Contact: hello@" + dom + "\n";
}

/** Organization + WebSite JSON-LD. [VERIFY] markers flag what you must confirm. */
function jsonLd(domain, brand) {
  const dom = cleanDomain(domain) || "your-site.com";
  brand = brand || dom.split(".")[0];
  return JSON.stringify({
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", "@id": "https://" + dom + "/#org", name: brand,
        url: "https://" + dom + "/", sameAs: ["[VERIFY: your LinkedIn URL]", "[VERIFY: your X/Twitter URL]"] },
      { "@type": "WebSite", url: "https://" + dom + "/", name: brand,
        publisher: { "@id": "https://" + dom + "/#org" } },
    ],
  }, null, 2);
}

/** A template opening paragraph. Specifics get quoted; adjectives don't. */
function openingRewrite(domain, brand) {
  const dom = cleanDomain(domain) || "your-site.com";
  brand = brand || dom.split(".")[0];
  return brand + " is a [category] that [what you do]. [One verifiable specific: a price, "
    + "a count, or a founding year]. [City, if you serve one.] Replace the brackets with your "
    + "real numbers; specifics are what assistants quote.";
}

function fixFiles(domain, brand) {
  const dom = cleanDomain(domain) || "your-site.com";
  brand = brand || dom.split(".")[0];
  return {
    domain: dom, brand,
    robots: robotsTxt(dom),
    llms: llmsTxt(dom, brand),
    jsonld: jsonLd(dom, brand),
    rewrite: openingRewrite(dom, brand),
    note: "robots.txt, llms.txt and the JSON-LD are paste-ready. The rewrite is a draft: "
        + "fill the [brackets] with your real numbers before publishing.",
  };
}

// ---- direct HTML fixes ----------------------------------------------------
function ldTypes(html) {
  const out = new Set();
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi; let m;
  while ((m = re.exec(html))) {
    let o; try { o = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const st = [o];
    while (st.length) {
      const x = st.pop();
      if (Array.isArray(x)) st.push(...x);
      else if (x && typeof x === "object") {
        const t = x["@type"];
        if (typeof t === "string") out.add(t);
        else if (Array.isArray(t)) t.forEach(y => typeof y === "string" && out.add(y));
        st.push(...Object.values(x));
      }
    }
  }
  return out;
}
function visibleFirst(html, n = 100) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").split(/\s+/).filter(Boolean).slice(0, n).join(" ");
}

/** The HTML-derivable subset of the rubric, what one page can satisfy on its own. */
function htmlReadiness(html) {
  const types = ldTypes(html);
  const checks = [
    ["<title> present", /<title[^>]*>\s*\S/i.test(html)],
    ["<meta description> present", /<meta[^>]+name=["']description["'][^>]+content=["']\s*\S/i.test(html)],
    ["Organization JSON-LD", types.has("Organization")],
    ["WebSite JSON-LD", types.has("WebSite")],
    ["FAQPage JSON-LD", types.has("FAQPage")],
    ["A number in the first 100 words", /\d/.test(visibleFirst(html))],
  ];
  const got = checks.filter(c => c[1]).length;
  return { score: Math.round(got / checks.length * 100), got, total: checks.length,
           checks: checks.map(c => ({ label: c[0], ok: c[1] })) };
}

function injectHead(html, snippet) {
  const m = html.match(/<\/head\s*>/i);
  if (m) return html.slice(0, m.index) + "  " + snippet + "\n" + html.slice(m.index);
  return snippet + "\n" + html;
}

/**
 * Apply the safe structural fixes to a page's HTML.
 * Only ever ADDS what's missing, never rewrites or deletes your content.
 */
function applyFixes(html, brand, domain) {
  const dom = cleanDomain(domain) || ((brand || "your-site").toLowerCase().replace(/\s+/g, "") + ".com");
  brand = brand || dom.split(".")[0];
  const before = html; let out = html; const changes = [];

  if (!/<title[^>]*>\s*\S/i.test(out)) {
    out = injectHead(out, "<title>" + brand + ": [what you do, in 5 words]</title>");
    changes.push({ label: "Added <title>", detail: "replace the bracket with your real headline" });
  }
  if (!/<meta[^>]+name=["']description["'][^>]+content=["']\s*\S/i.test(out)) {
    out = injectHead(out, '<meta name="description" content="' + brand
      + '. [One specific sentence: what you do, who for, one number].">');
    changes.push({ label: "Added <meta name=description>", detail: "placeholder, replace with a real specific" });
  }
  const types = ldTypes(out);
  if (!(types.has("Organization") && types.has("WebSite"))) {
    out = injectHead(out, '<script type="application/ld+json">' + jsonLd(dom, brand) + "</script>");
    changes.push({ label: "Injected Organization + WebSite JSON-LD", detail: "structured identity assistants read" });
  }
  return { before, after: out, changes, brand, domain: dom,
           readinessBefore: htmlReadiness(before), readinessAfter: htmlReadiness(out) };
}

module.exports = { fixFiles, robotsTxt, llmsTxt, jsonLd, openingRewrite, applyFixes, htmlReadiness, cleanDomain };
