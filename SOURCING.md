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
