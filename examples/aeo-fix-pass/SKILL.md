---
name: aeo-fix-pass
description: Audit this site for AI-search visibility (AEO/GEO) and apply the fixes to the codebase. Use when the user asks why ChatGPT/Claude/Gemini/Perplexity don't cite their site, wants to appear in AI search or AI answers, mentions AEO or GEO, or asks for robots.txt for AI crawlers, llms.txt, or JSON-LD schema work.
---

# AEO fix pass

Make a site readable, trustworthy and quotable by AI answer engines, then prove the score moved.

Requires the OpenAEO MCP server (`aeo_audit`, `aeo_fix_files`, `aeo_fix_html`, `aeo_check_html`).
If those tools aren't available, tell the user to add it:

```json
{ "mcpServers": { "openaeo": { "command": "npx", "args": ["-y", "openaeo-audit", "mcp"] } } }
```

## Steps

1. **Audit.** Call `aeo_audit` on the user's domain. Report the score, band and failing checks
   in plain language. Lead with the retrieval gates — a failing gate caps everything else, so
   there's no point tuning schema if AI bots get a 403 or the content only renders after JS.

2. **Find where things live.** Locate the site's public/static root (`public/`, `static/`,
   `dist/`, or the repo root) and the template that owns `<head>`. Don't guess — check.

3. **Generate the files.** Call `aeo_fix_files`. Write `robots.txt` and `llms.txt` to the static
   root. If a `robots.txt` already exists, **merge** rather than overwrite — preserve their
   existing rules and add the AI-crawler allows.

4. **Fix the pages.** For each key page (home, pricing, about, FAQ), read the HTML, call
   `aeo_fix_html`, and write `fixedHtml` back. For templated sites, apply the equivalent change
   to the layout/template instead of every rendered page.

5. **Verify.** Call `aeo_check_html` on what you wrote. After the user deploys, re-run
   `aeo_audit` to confirm the score actually moved.

## Rules

- **Never invent facts.** Generated files contain `[bracketed]` placeholders — prices, counts,
  founding years, addresses, social URLs. Ask the user for real values or leave the brackets.
  A fabricated number in schema is worse than no schema: assistants cross-check, and unverifiable
  claims cost trust.
- **Schema must mirror what's visible.** Don't put a rating or price in JSON-LD that doesn't
  appear on the page.
- **Additive only.** `aeo_fix_html` adds missing `<head>` elements; it never rewrites content.
  Any copy changes are a suggestion for the user to approve, not something you apply silently.
- **Show your work.** List the files you're about to create or modify, and let the user confirm
  before writing.
- **Don't hide anything from users.** Never add text that's visible to crawlers but not to
  people (hidden divs, `display:none` keyword blocks, instructions aimed at AI readers). It's
  cloaking, assistants penalise it, and it will destroy the trust the rest of this work builds.
