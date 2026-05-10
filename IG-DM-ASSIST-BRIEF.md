# IG DM Assist — real-time match suggestions while you DM clients

> Daily-driver feature on the operator's main laptop. While they're in
> Instagram DMs talking to a client, a floating widget reads the open
> conversation, parses intent, runs the inventory + Sourcing Discord
> matcher in n8n, and surfaces the top proposals as one-click copyable
> text. No IG API, no headless browser. Toggle on/off from the widget.

---

## What we're building

A third userscript in the LP2P ecosystem (alongside the Discord WTS
scraper and the IG DM Sender), plus one new n8n workflow. Together:

```
Operator on instagram.com/direct/t/<thread>/   (main laptop, normal Chrome)
        │
        │ Tampermonkey: LP2P · IG DM Assist
        │  - Toggle ON: enable auto-match
        │  - On every new client message in the open thread → POST conversation
        │  - Manual "Re-match" button always available when ON
        ▼
n8n webhook /webhook/ig-dm-assist (NEW workflow)
        ├─ Code node: Parse intent via Claude Haiku
        │   → { artist, dates, category, places, budget? }
        ├─ Code node: fetch Inventory (Apps Script) + Sourcing Discord (CSV)
        ├─ Code node: run matcher (same logic as find-matches-and-notify)
        ├─ Code node: build proposal_text per top-3 match
        └─ Respond to Webhook with JSON
        │
        ▼
Floating panel on the IG tab renders:
  - Parsed intent line: JUL · 16 Mai · FOSSE · 2 places
  - Top 3 matches (per-place price, total, source, post-age, green/amber stripe)
  - 📋 Copy button per match → puts proposal_text on clipboard → operator Ctrl+V into IG
```

### Why this shape

- Tampermonkey + n8n: same trusted patterns as the Discord scraper and IG
  sender. Zero ban surface (reads operator's own DOM, doesn't send/automate).
- All matcher logic stays in n8n (no 4th copy of `findMatches` /
  `normalizeArtist` to keep in sync — `CLAUDE.md` already warns about three).
- LLM cost: Claude Haiku, ~500 input + ~200 output tokens per parse.
  At 30 conversations/day, ~$0.02/month. Negligible.
- Privacy: only reads when on `instagram.com/direct/*`. Toggle off → idle.

---

## Files in this delivery

- **`IG-DM-ASSIST-BRIEF.md`** (this file) — the install + test walkthrough
- **`n8n/ig-dm-assist.js`** — the Code-node body for the new n8n workflow
  (single mega-node like `find-matches-and-notify.js`; keeps the matcher
  port colocated)
- **`userscript/instagram-dm-assist.user.js`** — the Tampermonkey script

---

## Setup steps

### Phase A — Create the n8n workflow

You'll do this in the n8n web UI from any browser.

1. **Create a new workflow** named `IG DM Assist`.
2. **Webhook trigger**: Method `POST`, Path `ig-dm-assist`,
   Response Mode `When last node finishes`. Activate the workflow once the
   rest is wired so n8n gives you the production URL — you'll paste that
   into the userscript later.
3. **Code node** named `Run assist`. Paste the entire body of
   `n8n/ig-dm-assist.js` (open the file from this repo) into it. Then edit
   the three lines marked `>>> EDIT <<<` at the top:
   - `ANTHROPIC_API_KEY` — same key as the existing `parse-via-claude-full`
     flow uses (copy it from there). Never commit it back.
   - `APPS_SCRIPT_URL` — already filled with the inventory Apps Script URL
     used elsewhere; verify it matches `find-matches-and-notify.js`.
   - Sheet IDs are pre-filled and shouldn't need touching.
4. **Respond to Webhook** node, returning `{{ $json }}` from the Code node.
5. Activate the workflow. Copy the production webhook URL.

Smoke test from anywhere with `curl` (or Postman / a test n8n run):

```
POST <your-prod-webhook-url>
Content-Type: application/json

{
  "client_handle": "test_client",
  "conversation": [
    {"from": "client", "text": "salut, encore dispo le 16 mai pour jul ?"},
    {"from": "me", "text": "oui en fosse"},
    {"from": "client", "text": "ok 2 places ca donne quoi"}
  ]
}
```

You should get back `{ parsed: { artist: "JUL", ... }, matches: [...] }`.

### Phase B — Install the userscript on the main laptop

1. Open Chrome on the **main laptop** (the one you actually DM clients on),
   open Tampermonkey, click **Create new script**.
2. Paste the contents of `userscript/instagram-dm-assist.user.js`.
3. Edit line ~22 — replace the placeholder `WEBHOOK_URL` with the
   production URL from Phase A. Save (`Ctrl+S`).
4. Open `https://www.instagram.com/direct/inbox/`. The floating widget
   appears bottom-right (small "🎯 OFF" pill).

### Phase C — Test

1. Open a real client thread (or a test thread with a friend).
2. Click the widget — it switches to "🎯 ON" with a green dot.
3. Click **Re-match** (always-on button). Within ~2s, the panel slides up
   showing parsed intent + top 3 matches.
4. Pick one, click **📋 Copy**. Paste into the IG composer. Send.
5. Have the test partner send a follow-up. Within ~3s the panel re-runs
   automatically (auto-match on new client message).
6. Toggle OFF. Send another test message — panel does nothing. Toggle ON
   again — panel re-runs.

If anything looks wrong, open DevTools → Console. Every step logs with
`[LP2P-IGA]` prefix. Common issues:

- **Widget doesn't appear**: check Tampermonkey is enabled and the script
  is matching the URL (should match `instagram.com/direct/*`).
- **Match request fails**: check the webhook URL is pasted correctly
  and the n8n workflow is active.
- **Parser gets artist wrong**: the parser's prompt lives in
  `n8n/ig-dm-assist.js` — the `KNOWN_ARTISTS` list and the `normalizeArtist`
  alias map are the canonical guides. Add new artists/aliases there
  (mirror in `index.html` and `find-matches-and-notify.js` per
  `CLAUDE.md` rule 3).
- **Messages misattributed (client vs me)**: the script uses bubble
  layout (left = received, right = sent) to decide. If IG's layout
  changes, the `extractMessages()` function needs updating. Check
  console logs for the raw extraction output.

---

## Conventions you must respect

Subset of `CLAUDE.md` plus a few new ones for this work:

- **No new `findMatches` / `normalizeArtist` copy.** All matcher logic in
  this feature lives in `n8n/ig-dm-assist.js`. If you change matching
  behavior, also update `index.html` and `n8n/find-matches-and-notify.js`
  / `n8n/callback-handler.js` (CLAUDE.md rule 3).
- **Per-place pricing** (CLAUDE.md rule 1): inventory comes through
  `inventoryTotalsToPerPlace()` exactly like the existing flows. Don't fork.
- **Buyer's places drives totals**, not seller's qty (CLAUDE.md rule 2).
- **`@connect *`** in the userscript metadata block — required for the
  cross-origin POST to n8n.
- **No real URLs in committed files.** The `WEBHOOK_URL` placeholder in
  the script and the `>>> EDIT <<<` markers in `ig-dm-assist.js` follow
  the same pattern as the rest of the project. Real URLs only in
  Tampermonkey local storage / n8n.
- **Logging prefix `[LP2P-IGA]`** — never silent failures. Log every
  request, parse result, render call.
- **Cooldown 8s between auto-fires.** Don't burn LLM calls on rapid-fire
  messages.
- **Skip auto-fire on trivial messages**: `< 5 chars`, or matching
  `/^(ok|okay|merci|thanks|yes|no|👍|👌|❤️|😂)/i`. Manual Re-match button
  always works regardless.

---

## Testing checklist

- [ ] n8n workflow active, smoke test via curl returns valid match JSON
- [ ] Userscript installed, widget appears on `instagram.com/direct/*`
- [ ] Toggle ON → green dot visible
- [ ] Re-match button → panel renders within ~2s with parsed intent + top 3
- [ ] Copy button → text actually lands on clipboard (Ctrl+V into anywhere)
- [ ] New client message in the open thread auto-fires re-match
- [ ] Trivial message ("ok") does NOT auto-fire
- [ ] Switch to a different thread → panel clears, re-fires for new thread
- [ ] Toggle OFF → no auto-fires, no LLM calls (verify in n8n executions tab)
- [ ] Toggle persists across page reloads (`GM_setValue`)
- [ ] No duplicate widgets if you navigate within IG (SPA routing)

---

## Out of scope for v1 (don't build now)

- Editable parsed intent (operator corrects artist/date and re-matches).
  v2 — start by adding a "wrong parse?" link that opens a tiny edit
  popover.
- Direct insert into IG composer (risks mangling a half-typed reply).
- Auto-broadcast to community Discord when no match.
- Voice notes / images understanding.
- Analytics sheet (log every assist + outcome). Useful but not blocking.
- Heartbeat to the watchdog workflow. Nice to add once Discord scraper
  v2 ships its watchdog (DISCORD-SCRAPER-MIGRATION.md). Just append a
  new row to the Heartbeats sheet.

---

## When in doubt

- Read `CLAUDE.md` first for project conventions.
- Mirror patterns from `userscript/instagram-dm-sender.user.js` and
  `userscript/discord-wts-scraper.user.js`.
- Don't change behavior in `n8n/find-matches-and-notify.js` or
  `n8n/callback-handler.js` — those are upstream of the Tally + Telegram
  pipeline and out of scope.
- If a parse looks wrong on a real conversation, the fix is usually in
  the prompt at the top of `n8n/ig-dm-assist.js`. Don't paper over it
  in the userscript.
