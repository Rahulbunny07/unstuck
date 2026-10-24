# Unstuck

Paste an error from an AI builder (Lovable, Replit, Bolt, Cursor). Get the likely cause with evidence, a short prompt to paste back, how to check it worked, and how to undo it. Fixes that users confirm get a "Worked for N people" badge, so repeat errors are answered from the library with no AI call.

## Run it

```bash
npm install
copy .env.example .env   # then add GROQ_API_KEY (or ANTHROPIC_API_KEY)
npm start                # http://localhost:3000  (npm run dev restarts on changes)
npm test                 # 46 tests, no network or real AI needed
npm run eval             # real-AI check, see "Measuring quality"
```

Needs Node 22.13 or newer (uses the built-in `node:sqlite`).

Without an AI key the app still answers errors that are in the library; new errors show a clear "no AI key" message.

## How an answer is produced

1. `lib/clean.js` removes secrets, trims the log to the useful lines, and guesses the platform.
2. If a live site address was given, `lib/sitecheck.js` fetches the public page and reports provable problems (no AI).
3. `lib/db.js` looks for a stored fix: exact phrase rules first, then text similarity. A fix is shown directly only above `MATCH_THRESHOLD` (0.85) or on a phrase rule. Broad fixes carry exclusion phrases so they do not answer more specific errors.
4. On a miss, `lib/ai.js` asks the fast model (first try) or the strong model (retries), with the closest curated fixes as hints and the session's failed fixes excluded.
5. The server keeps only evidence quotes that really appear in the user's input, and lowers confidence if none do.
6. The user votes. After 3 failed attempts the app gives a reset summary instead of another guess.

## Limits that protect the AI key (`lib/quota.js`, `lib/throttle.js`)

- Daily AI answers per person, per network and for the whole site (UTC day). Library answers and people using their own key are not counted.
- A per-minute token throttle: extra requests wait in line (30 s cap), then get a retry time.
- Defaults fit a free Groq key. Raise them for a paid key. All settings are in `.env.example`.

## AI providers

Site key: Anthropic, Groq or an AgenticOrg agent (first one configured wins). Users can add their own key (Anthropic, OpenAI, Groq, any OpenAI-compatible endpoint, or AgenticOrg) on `/account.html`. User keys are verified with the provider, then stored encrypted (AES-256-GCM). MCP servers can be connected and their tools listed, but they are **not yet used in diagnoses**.

## Measuring quality

`eval/cases.js` and `eval/cases-holdout.js` hold realistic errors with expected causes. `npm run eval` sends them through a running server and grades the answers with a stronger model. The pass rate is an indication, not a benchmark: the cases and expected causes were written by the app's author, and the grader is an AI. It also spends a real share of the daily token allowance.

## Honest labels

- `Curated by the Unstuck team`: seed fixes in `lib/seeds.js`. Test each against a real app before relying on it.
- `Worked for N people` / `Verified by N people`: real votes only. Sample runs are excluded from votes and stats.
- `AI-generated, not verified yet`: a new answer nobody has confirmed.

## Before deploying

- Set `NODE_ENV=production` and a real `ENCRYPTION_KEY` (the server refuses to start without it). Keep that key safe: losing it makes stored user keys unreadable.
- Put the app behind HTTPS. Cookies are `Secure` and HSTS is sent only in production.
- Use a persistent disk for `data/` (`DB_PATH`), and back it up. The library, votes and accounts live there.
- Set the AI key and review the daily limits and throttle against your provider's real limits.
- Replace the placeholders in `public/legal.html` and have it reviewed.

## Not built yet

Email verification and password reset, account deletion, billing and credits, using MCP tools in diagnoses, a way to see the line from several server copies at once (the throttle is per process).
