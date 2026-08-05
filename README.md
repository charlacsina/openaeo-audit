# OpenAEO Audit

**Check whether your website is retrievable and citable by AI answer engines — ChatGPT, Claude, Gemini, and Perplexity — from your terminal, in one command.**

```bash
npx openaeo-audit yoursite.com
```

No install, no signup, no dependencies. It fetches your page the way an AI crawler does, scores it out of 100, and hands you the exact fixes that raise it.

AEO (Answer Engine Optimization) and GEO (Generative Engine Optimization) are the new SEO: your customers increasingly ask an assistant instead of scrolling ten blue links, and the winners are whoever the AI can *read, trust, and recommend*. This tool tells you where you stand.

---

## Quick start

```bash
# pretty report
npx openaeo-audit example.com

# machine-readable JSON (for CI, dashboards, scripts)
npx openaeo-audit example.com --json
```

Example output:

```
  example.com
  54/100  ·  AI-ready
  AI-ready, not yet cited.
  Retrievable, but thin on quotable specifics and structured data. Fixable without a redesign.

  ✓ Content readable in raw HTML  — 1,240 visible words
  ✗ robots.txt allows GPTBot, ClaudeBot, PerplexityBot  — robots.txt disallows gptbot
  ✗ llms.txt index present  — missing
  ⚠ Organization + WebSite JSON-LD  — Organization
  ⚠ Product / Offer schema with price  — no priced Offer
  ⚠ Answer + a number in the first 100 words  — vague / no title or meta
  ✗ FAQPage schema present  — missing
  ✓ Freshness (dateModified) present  — dateModified set

  6 fixes to raise your score:
  1. Unblock AI crawlers in robots.txt
     Why:  A single inherited Disallow line can hide you from ChatGPT and Perplexity entirely.
     How:  Explicitly Allow GPTBot, OAI-SearchBot, ClaudeBot, ... and link your sitemap.
  ...
```

---

## What it checks

The audit runs the checks that most often decide whether an AI assistant can quote you:

| Check | Why it matters |
|---|---|
| **Content readable in raw HTML** | AI crawlers don't run your JavaScript. If content only appears after hydration, they see an empty page. |
| **robots.txt allows AI bots** | One inherited `Disallow` line can hide you from ChatGPT and Perplexity entirely. |
| **Per-bot edge reachability** | robots.txt is a request; a CDN is an enforcer. We fetch as GPTBot, OAI-SearchBot, ClaudeBot, Claude-SearchBot, PerplexityBot, Googlebot, Bingbot and Applebot, and record the status each is given. Google-Extended is a robots.txt token with no crawler behind it, so it is read rather than fetched. |
| **llms.txt index present** | An emerging convention that hands assistants a clean, quotable summary of your site. |
| **Organization + WebSite JSON-LD** | Structured identity is how assistants know who you are. |
| **Product / Offer schema with price** | Lets assistants answer "how much does X cost" with your real number. |
| **Answer + a number in the first 100 words** | Assistants lift the first concrete, specific sentence. Adjectives don't get quoted; numbers do. |
| **FAQPage schema** | Maps directly onto the question-shaped queries people type into assistants. |
| **Freshness (dateModified)** | Assistants prefer sources that signal they're current. |

### Scoring

Each check scores `pass` (1.0), `warn` (0.4), or `fail` (0.0), averaged to a 0–100 score, then placed in a band:

| Score | Band |
|---|---|
| 0–25 | Not retrievable |
| 26–45 | Partial |
| 46–64 | AI-ready |
| 65–82 | AI-competitive |
| 83–100 | AI-dominant |

Some failures **cap** the score no matter what else passes, because they block retrieval entirely:
- Content invisible without JavaScript → capped at 25
- Bot blocked at the edge (4xx/403) → capped at 25
- robots.txt disallows AI bots → capped at 40

An honest low score you can act on beats a flattering one that hides the real problem.

---

## Use it as a library

```js
const { audit, remediationPlan } = require("openaeo-audit");

const result = await audit("example.com");
console.log(result.score, result.band);      // 54 "AI-ready"

const fixes = remediationPlan(result);        // ordered, highest-leverage first
fixes.forEach(f => console.log(f.title));
```

`audit(url)` returns:

```jsonc
{
  "domain": "example.com",
  "score": 54,
  "band": "AI-ready",
  "verdict": "AI-ready, not yet cited.",
  "sub": "Retrievable, but thin on quotable specifics ...",
  "fixCount": 2,
  "edgeOk": true,
  "bots": [ { "name": "GPTBot", "surface": "ChatGPT", "kind": "fetched", "status": 200, "ok": true }, ... ],
  "checks": [ { "label": "...", "status": "pass|warn|fail", "detail": "..." }, ... ]
}
```

### In CI

Fail a build if your score drops below a threshold:

```bash
score=$(npx openaeo-audit yoursite.com --json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).score))")
[ "$score" -ge 65 ] || { echo "AEO score $score below 65"; exit 1; }
```

---

## Use it from Cursor or Claude Code (MCP)

OpenAEO ships an [MCP](https://modelcontextprotocol.io) server, so your AI coding agent can audit
your site and **apply the fixes to your actual files** — with you reviewing every edit. Nothing is
uploaded, no account needed, and it never touches production.

**Cursor** — add to `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "openaeo": { "command": "npx", "args": ["-y", "openaeo-audit", "mcp"] }
  }
}
```

**Claude Code / Claude Cowork** — run this in your project:

```bash
claude mcp add openaeo -- npx -y openaeo-audit mcp
```

…or copy [`examples/.mcp.json`](examples/.mcp.json) to your project root.

For a repeatable workflow, drop [`examples/aeo-fix-pass/`](examples/aeo-fix-pass/SKILL.md) into
`.claude/skills/` — then `/aeo-fix-pass` runs the whole audit-fix-verify pass, including the
guardrails (merge robots.txt rather than overwrite, never invent numbers for the placeholders).

Then just ask:

> *"Audit example.com and fix my site."*

The agent will run the audit, write `robots.txt` and `llms.txt`, inject the JSON-LD into your
`<head>`, and re-check its work.

### Not a developer? You only need your web address.

If your site is on **Squarespace, Wix, Webflow, WordPress, Shopify, Framer, Ghost or Carrd**, you
don't have files to edit — so ask instead:

> *"My website is remyfilm.co — help me show up in AI search."*

OpenAEO detects which platform you're on and replies with click-by-click steps for **your**
admin ("Settings → Advanced → Code Injection → paste this in the Header"), plus the exact text
to copy. It'll also tell you honestly when your platform *can't* do something, so you don't hunt
for a setting that doesn't exist.

### Tools it exposes

| Tool | What it does |
|---|---|
| `aeo_fix_my_site` | **One shot, no codebase needed.** Audits, detects your platform, and returns where-to-paste steps for that platform's admin |
| `aeo_audit` | Audits a live domain — score, band, every check, prioritised fixes |
| `aeo_fix_files` | Generates paste-ready `robots.txt`, `llms.txt`, JSON-LD, and an opening paragraph |
| `aeo_fix_html` | Takes a page's HTML, returns it with `<title>`, meta description and JSON-LD injected — **only adds what's missing, never rewrites your content** |
| `aeo_check_html` | Scores HTML without changing it, to verify the edits worked |
| `aeo_read_log` | Reads a server access log and reports what the crawlers **actually** got: which arrived, what status, which paths, and whether each request really came from the operator it claimed. Parsed on your machine; the log never leaves it |
| `aeo_verify_crawler` | Checks one IP against the ranges the operator publishes. Answers verified, impostor, or unverifiable, and never says impostor without positive evidence |

**Hosted tools.** These five call openaeo.dev and need `OPENAEO_API_KEY`, because they
cannot run locally: citation testing needs provider keys for six assistants, and crawler
intelligence reads a corpus collected across every audit anyone runs. Without a key they
explain what they need rather than failing; the eight tools above are unaffected.

The line between the two lists is not commercial squeamishness, it is what each thing needs.
Anything that only requires your own site and public data runs on your machine, including the
crawler verification and the log reading. Anything that needs *other people's* domains, or a
yesterday to compare today against, needs a server that has been watching.

| Tool | What it does |
|---|---|
| `aeo_crawler_intel` | Has this site's CDN started refusing AI crawlers, and when did that change |
| `aeo_citations` | Ask the assistants a buyer question, record whether you were named |
| `aeo_history` | How the score has moved over time |
| `aeo_drift` | What was passing and is not any more |
| `aeo_competitors` | Which domains get named instead of you |

### Reading a server log

An audit fetches your page from this machine wearing each crawler's user agent. That is an
indication, not proof: a real crawler arrives from its operator's own network, and a firewall
checking the address can refuse us while allowing the real one, or the reverse.

Your access log is what settles it.

```bash
npx openaeo-audit log /var/log/nginx/access.log
```

```
  Googlebot           refused        2 requests, 2 paths
    403 x2
    2 confirmed from the operator's own network
    /docs x1  /pricing x1

  GPTBot              impostor-only  1 request, 1 path
    200 x1
    1 request claimed to be GPTBot from outside its published range: 45.83.12.9
```

Two things fall out of this that a fetch cannot tell you. The first is when our reading was
simply wrong, and the log corrects it. The second is that "GPTBot" in your log is a claim, not
an identity: anyone can send that user agent, and plenty do, precisely because sites allow it.
Every request is checked against the address ranges OpenAI, Anthropic, Google, Microsoft,
Perplexity and Apple publish for exactly this purpose.

A crawler is only ever called an impostor on positive evidence. If an operator publishes
nothing, or a feed fails to load, the answer is "unverifiable" and never "impostor": the cost of
a false accusation here is you blocking traffic you wanted.

The log is read from disk, parsed in the process, and discarded. The one network call is fetching
those public address ranges. Nothing from your log is uploaded, which is the entire reason this
lives in the package rather than behind a login.

---

## Requirements

- **Node.js 18+** (uses the built-in `fetch`)
- Zero npm dependencies

---

## What this is — and isn't

**What's in this repo.** The audit engine: 5 retrieval gates, 8 headline checks, and a per-bot edge
matrix that fetches your site as 8 named AI crawlers and records the HTTP status
each one is given, plus the generators for `robots.txt`, `llms.txt` and JSON-LD,
the CLI and the MCP server. Free forever, MIT, no account, no telemetry.
It's the same engine that powers the free tier at [openaeo.dev](https://openaeo.dev).

**What isn't.** The hosted service: the full 49-check weighted rubric tracked
over time, weekly citation testing across six assistant surfaces, drift alerts,
competitor share-of-voice, and audit history. That runs on our infrastructure,
not yours.

The split is not about withholding the good part. Fixing a site is mostly a
one-time job, and everything you need for it is here. Whether an assistant names
you changes every week, and that is a thing that has to keep running whether or
not anyone is watching. Sell the service, not the permission.

If the CLI is useful, [the hosted version](https://openaeo.dev) is the next step. Both tell you the truth; the hosted one keeps telling you over time.

---

## Contributing

Issues and PRs welcome — especially new checks, better detection heuristics, and fixes for edge cases in how frameworks render. Keep the engine dependency-free.

## License

[MIT](LICENSE) © OpenAEO. Use it, fork it, build on it.

## Trademark

"OpenAEO" and the OpenAEO logo are trademarks of OpenAEO and are not licensed
under the MIT License. Forks and derivative works may use this code freely, but
must not use the OpenAEO name or logo in a way that suggests endorsement,
affiliation, or that they are the official OpenAEO product or service.
