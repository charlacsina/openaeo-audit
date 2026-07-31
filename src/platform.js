// Platform detection + where-to-paste guidance.
// Most small businesses don't have a codebase — their site is Squarespace, Wix,
// Webflow, WordPress or Shopify. This turns "inject JSON-LD into <head>" into
// "Settings → Advanced → Code Injection → Header", and is honest about the
// things a given platform simply won't let you do.
"use strict";

const PLATFORMS = [
  { id: "squarespace", name: "Squarespace",
    test: h => /static1\.squarespace\.com|squarespace\.com\/universal|Squarespace\.afterBodyLoad|data-block-type/i.test(h) },
  { id: "wix", name: "Wix",
    test: h => /static\.parastorage\.com|wix\.com\/website|X-Wix|_wixCIDX/i.test(h) },
  { id: "webflow", name: "Webflow",
    test: h => /data-wf-page|data-wf-site|webflow\.com|assets\.website-files\.com|cdn\.prod\.website-files\.com/i.test(h) },
  { id: "shopify", name: "Shopify",
    test: h => /cdn\.shopify\.com|Shopify\.theme|shopifycdn\.com/i.test(h) },
  { id: "wordpress", name: "WordPress",
    test: h => /wp-content|wp-includes|name=["']generator["'][^>]*WordPress/i.test(h) },
  { id: "framer", name: "Framer",
    test: h => /framerusercontent\.com|framer\.com\/m\/|__framer/i.test(h) },
  { id: "ghost", name: "Ghost",
    test: h => /name=["']generator["'][^>]*Ghost|ghost\.io/i.test(h) },
  { id: "carrd", name: "Carrd",
    test: h => /carrd\.co|cdn\.carrd\.co/i.test(h) },
];

function detectPlatform(html) {
  const h = String(html || "");
  for (const p of PLATFORMS) if (p.test(h)) return { id: p.id, name: p.name };
  return { id: "custom", name: "a custom or self-hosted site" };
}

// what: "robots" | "llms" | "jsonld" | "meta"
// Each entry: steps the owner can actually follow, or an honest "you can't here".
const GUIDES = {
  squarespace: {
    robots: { can: false,
      note: "Squarespace manages robots.txt for you and doesn't let you edit it. The good news: it already allows the major AI crawlers, so this usually isn't your problem. Skip it and do the JSON-LD instead.",
      steps: [] },
    llms: { can: false,
      note: "Squarespace can't serve an arbitrary /llms.txt file. Closest alternative: create a plain page at /llms (Pages → new page) with the same content as text. It's not the standard location, so treat it as a bonus rather than a fix.",
      steps: [] },
    jsonld: { can: true,
      note: "This is the high-value one on Squarespace, and it's fully supported.",
      steps: ["Open your site → Settings", "Advanced → Code Injection",
              "Paste the JSON-LD block into the HEADER box", "Save, then hit Publish"] },
    meta: { can: true, note: "Set per page, not in code.",
      steps: ["Pages → hover the page → ⚙ (gear)", "SEO tab",
              "Fill SEO Title and SEO Description with the text provided", "Save"] },
  },
  wix: {
    robots: { can: true, note: "Wix lets you edit robots.txt directly.",
      steps: ["Wix dashboard → Marketing & SEO → SEO Tools", "Robots.txt Editor",
              "Paste the provided rules", "Save"] },
    llms: { can: true, note: "Upload it as a file so it serves at your domain root.",
      steps: ["Settings → SEO / File Upload", "Upload llms.txt",
              "Confirm it loads at yoursite.com/llms.txt"] },
    jsonld: { can: true, note: "Wix has a dedicated structured-data field.",
      steps: ["Marketing & SEO → SEO Settings → the page you want",
              "Advanced SEO → Structured Data Markup", "Add new markup and paste the JSON-LD", "Save & publish"] },
    meta: { can: true, note: "",
      steps: ["SEO Settings → select the page", "Edit Title Tag and Meta Description", "Save & publish"] },
  },
  webflow: {
    robots: { can: true, note: "Built into site settings.",
      steps: ["Site settings → SEO tab", "Paste the rules into the robots.txt field", "Save, then Publish the site"] },
    llms: { can: false,
      note: "Webflow can't host an arbitrary /llms.txt at the root. Options: put the site behind a proxy/CDN that serves it, or skip it — llms.txt is a nice-to-have, not a retrieval gate.",
      steps: [] },
    jsonld: { can: true, note: "",
      steps: ["Site settings → Custom Code", "Paste the JSON-LD into Head Code (site-wide) —",
              "or Page settings → Custom Code for a single page", "Save, then Publish"] },
    meta: { can: true, note: "",
      steps: ["Page settings → SEO", "Fill Title Tag and Meta Description", "Save, then Publish"] },
  },
  shopify: {
    robots: { can: true, note: "Shopify supports a robots.txt template.",
      steps: ["Online Store → Themes → ⋯ → Edit code", "Templates → Add a new template → robots.txt",
              "Add the AI-crawler rules alongside the defaults", "Save"] },
    llms: { can: true, note: "Serve it as an asset or via a page.",
      steps: ["Edit code → Assets → Add a new asset → upload llms.txt",
              "(Root-level serving may need an app or proxy — check the URL after)"] },
    jsonld: { can: true, note: "",
      steps: ["Online Store → Themes → Edit code", "Layout → theme.liquid",
              "Paste the JSON-LD just before </head>", "Save"] },
    meta: { can: true, note: "",
      steps: ["Products/Pages → the item → Search engine listing → Edit",
              "Set the page title and description", "Save"] },
  },
  wordpress: {
    robots: { can: true, note: "Easiest via an SEO plugin.",
      steps: ["Yoast SEO → Tools → File editor → robots.txt (or Rank Math → General Settings → Edit robots.txt)",
              "Paste the rules", "Save changes"] },
    llms: { can: true, note: "",
      steps: ["Upload llms.txt to your site's web root via FTP/SFTP or your host's File Manager",
              "Confirm it loads at yoursite.com/llms.txt"] },
    jsonld: { can: true, note: "",
      steps: ["Appearance → Theme File Editor → header.php (child theme preferred),",
              "or use a plugin like WPCode / Insert Headers and Footers",
              "Paste the JSON-LD before </head>", "Update"] },
    meta: { can: true, note: "",
      steps: ["Edit the page → the SEO plugin box below the editor", "Set SEO title and meta description", "Update"] },
  },
  framer: {
    robots: { can: true, note: "",
      steps: ["Site settings → General → Robots.txt", "Paste the rules", "Publish"] },
    llms: { can: false, note: "Framer doesn't serve arbitrary root files. Skip it — it's not a gate.", steps: [] },
    jsonld: { can: true, note: "",
      steps: ["Site settings → General → Custom Code", "Paste the JSON-LD into 'Start of <head> tag'", "Publish"] },
    meta: { can: true, note: "",
      steps: ["Page → right panel → SEO", "Set title and description", "Publish"] },
  },
  ghost: {
    robots: { can: true, note: "Requires theme access.",
      steps: ["Edit your theme's robots.txt (or use a proxy/CDN rule)", "Re-upload the theme"] },
    llms: { can: true, note: "", steps: ["Add llms.txt to your theme's root and re-upload"] },
    jsonld: { can: true, note: "Ghost already outputs some schema; this adds Organization + WebSite.",
      steps: ["Settings → Code injection", "Paste the JSON-LD into Site Header", "Save"] },
    meta: { can: true, note: "", steps: ["Post/page settings → Meta data", "Set title and description", "Save"] },
  },
  carrd: {
    robots: { can: false, note: "Carrd doesn't expose robots.txt. Not a blocker — it allows crawlers by default.", steps: [] },
    llms: { can: false, note: "Not supported on Carrd.", steps: [] },
    jsonld: { can: true, note: "Requires a Pro plan for embed/code elements.",
      steps: ["Add an Embed element", "Set type to Code, paste the JSON-LD", "Publish"] },
    meta: { can: true, note: "", steps: ["Settings (gear) → SEO", "Set title and description", "Publish"] },
  },
  custom: {
    robots: { can: true, note: "",
      steps: ["Put robots.txt in the folder your site serves publicly (often public/, static/, or the web root)",
              "Confirm it loads at yoursite.com/robots.txt"] },
    llms: { can: true, note: "",
      steps: ["Put llms.txt in the same public folder", "Confirm it loads at yoursite.com/llms.txt"] },
    jsonld: { can: true, note: "",
      steps: ["Open the template that renders <head> (often a base layout)",
              "Paste the JSON-LD <script> just before </head>", "Deploy"] },
    meta: { can: true, note: "",
      steps: ["In the same <head> template, set <title> and <meta name=\"description\">", "Deploy"] },
  },
};

/**
 * Plain-English, platform-specific instructions for a non-technical owner.
 * Honest about what a platform can't do rather than giving steps that dead-end.
 */
function setupGuide(platformId, checks) {
  const id = GUIDES[platformId] ? platformId : "custom";
  const g = GUIDES[id];
  const name = (PLATFORMS.find(p => p.id === id) || {}).name || "your site";
  const want = { robots: "Allow AI crawlers (robots.txt)", llms: "Add an llms.txt index",
                 jsonld: "Add Organization + WebSite JSON-LD", meta: "Set the page title and description" };
  const tasks = Object.keys(want).map(k => ({
    task: want[k], supported: g[k].can, note: g[k].note || undefined,
    steps: g[k].steps.length ? g[k].steps : undefined,
  }));
  return {
    platform: id === "custom" ? "custom / self-hosted" : name,
    tasks,
    unsupported: tasks.filter(t => !t.supported).map(t => t.task),
    tip: "Do the JSON-LD first — it's supported nearly everywhere and it's what tells assistants who you are.",
  };
}

module.exports = { detectPlatform, setupGuide, PLATFORMS };
