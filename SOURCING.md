# Auto-sourcing setup

The dashboard matches demands against the inventory sheet
(`1jSQNoni7qW6ShnRw3hi_g_fF90qn5YZ3koRaL1gYTLE`) and proposes a sell price with
a **30% minimum markup**. Sell prices below that floor get bumped up automatically.

## 1. Read cell colors (recommended)

Google's public CSV endpoint only returns values, not colors. To let the
dashboard see which rows are **sold** (green) vs **in stock** (red), deploy
the Apps Script under `google-apps-script/Code.gs` as a Web App.

**One-time setup:**

1. Open the inventory Google Sheet.
2. **Extensions → Apps Script.**
3. Replace the default code with the contents of `google-apps-script/Code.gs`.
4. Save (disk icon).
5. **Deploy → New deployment.**
   - Type: **Web app**
   - Execute as: **Me (your account)**
   - Who has access: **Anyone**
6. Click **Deploy**. The first time, Google asks you to authorize the script —
   accept.
7. Copy the **Web app URL** (ends in `/exec`).
8. Open the dashboard → sidebar → **Apps Script (couleurs)** → paste the URL.

The sidebar will now show e.g. `Inventaire: 32 dispo (12 stock / 20 vendus)`.

**Color rules:**
- Green cell on "Nom" column → item is **sold** (hidden from matches)
- Red cell on "Nom" column → item is **in stock** (boosted in match ranking)
- Any other color / white → **unknown** (still matched, but ranked lower)

If you want to update the script later (e.g. change the sheet tab), re-deploy
as a **new version** of the same deployment.

## 2. Telegram approval flow (optional — Phase 2)

The **[Proposer]** button on each match copies a ready-to-send client message
to the clipboard. If you configure a webhook URL (sidebar → **Webhook
Telegram**), the same click also POSTs a JSON payload to your n8n flow:

```json
{
  "event": "match_found",
  "demand": {
    "client": "Le Mentec Louis (@louislemtc)",
    "artist": "JUL",
    "event": "15 Mai 2026",
    "category": "FOSSE",
    "places": "1",
    "source": "instagram",
    "notes": "..."
  },
  "match": {
    "client": "...",
    "artist": "JUL",
    "event": "15 Mai 2026",
    "category": "FOSSE",
    "places_requested": "1",
    "item": "Solo FOSSES early sud JUL 15 mai",
    "buy_price": 124,
    "proposed_price": 200,
    "expected_profit": 76,
    "expected_profit_pct": "61%"
  },
  "suggested_message": "Salut Le Mentec Louis! J'ai trouve pour JUL (15 Mai 2026) en FOSSE. Je te la propose a 200EUR. Ca t'interesse ?",
  "ts": "..."
}
```

A basic n8n flow to consume that:

```
Webhook (POST)
  → Telegram: sendMessage with inline keyboard
        [✓ Envoyer a 200€] [✗ Decliner] [✏ Prix custom]
  → Wait for callback_query
  → Switch:
        Accept → ManyChat API (send IG DM to client)
        Decline → (nothing / log)
        Custom → Telegram: ask price → ManyChat API with that price
```

ManyChat has an official Instagram Messaging API
(`/fb/sending/sendContent`) tied to your IG business account, so proposals
can be fully auto-sent without Instagram-scraping risk.

## 3. Markup floor

The floor is 30%, defined in `index.html` as `const MIN_MARKUP = 0.30`. If
the sheet's `Revente` column is below `Achat × 1.30`, the dashboard displays
the sheet price struck-through and proposes the bumped price with an
`↑ palier 30%` flag. Custom prices entered via the **Custom €** button are
also clamped to the floor.

## 4. External sourcing — Discord WTS scraper (Phase 2 in progress)

A Tampermonkey userscript watches a community Discord #wts channel from
your browser and forwards new posts to an n8n webhook. n8n then asks
Anthropic to extract structured rows (artist, date, category, qty, price,
seller handle) and writes them to a separate "Sourcing Discord" Google
Sheet. The dashboard then matches demands against external offers too.

This route avoids both Discord bots (you're not a server admin) and
selfbots (against ToS) — the userscript only observes what's already
rendered in your browser tab. No Discord API calls, no token usage, no
account-ban risk.

### 4.1 Install the userscript

**Prerequisite:** install the **Tampermonkey** browser extension
(https://www.tampermonkey.net/) — Chrome, Edge, or Firefox.

1. Open this file in your browser:
   `userscript/discord-wts-scraper.user.js`
   on the GitHub raw URL — Tampermonkey detects it and offers to install.
2. Confirm install. The script is configured to only run on the WTS
   channel URL (`@match` directive).
3. Open Discord in Chrome. **Pin the WTS channel as a tab** so you keep
   it open during the day.
4. From the Tampermonkey icon → **LP2P · Discord WTS scraper** menu,
   click **"Set webhook URL"**.

   For initial testing, paste a `https://webhook.site/<id>` URL. Watch
   the messages arrive there to confirm the format. Once happy, swap to
   your real n8n webhook (Phase 2 below).

5. Reload the WTS channel. You'll see a small `[LP2P] WTS scraper active`
   toast at the bottom-right and the console will log every batch
   forwarded.

### 4.2 What gets sent

For every NEW message that mentions `WTS`, `VDS`, `vends`, `sell`, or
`sale`, the script POSTs a payload to your webhook:

```json
{
  "source": "discord_wts",
  "channel_id": "1201954119804264458",
  "scraped_at": "2026-04-26T11:30:00.000Z",
  "messages": [
    {
      "id": "1234567890123456789",
      "author": "maximej",
      "authorId": "98765432109876543",
      "content": "WTS AYA 29/05 :\nx2 CAT OR (Bloc D4, Rang 19) - retail\nx2 CAT 1 (Bloc A6, Rang 25) - retail",
      "timestamp": "2026-04-26T10:28:00.000+00:00"
    },
    ...
  ]
}
```

Already-seen messages (tracked by Discord message ID in Tampermonkey
storage) are not re-sent on reload.

### 4.3 Tampermonkey menu commands

- **Set webhook URL** — change the n8n / webhook.site target
- **Show status** — current webhook + count of seen message IDs
- **Re-send last visible** — useful for backfilling: forget seen-IDs and
  forward every message currently rendered
- **Clear seen IDs** — wipe the dedupe cache
- **Toggle WTS-only filter** — turn off to forward every channel message
  (useful for debugging)

### 4.4 n8n flow + dashboard integration (Phase 2 — TODO)

Once messages start arriving at your test webhook and look correct, the
next step is a new n8n workflow:

```
Webhook (POST)
  → Loop: Code node — for each message, call Anthropic Messages API
      prompt: "extract list of {artist, date, category, qty, price, ...} from this WTS post; return JSON array"
  → Code node — flatten LLM output into one row per (artist, date, category, qty, price) tuple
  → Google Sheets (append) — write to a new "Sourcing Discord" sheet
```

Then a second Apps Script (mirroring `google-apps-script/Code.gs`) reads
that sheet, and the dashboard's `findMatches()` augments inventory matches
with Discord offers tagged `Source: Discord · @seller_handle`.

Wired up in a follow-up commit on `feature/discord-sourcing`.
