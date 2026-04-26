# Phase 4 — Telegram notification with selectable proposal options

When a new Tally form lands, your existing `Discord WTS Sourcing` flow already
parses it and writes to the CRM sheet. **Phase 4 adds a richer Telegram
notification:** the demand summary plus an inline keyboard with up to 8
proposable options drawn from your inventory and the Sourcing Discord sheet.
Tapping a button sends a second Telegram message containing the ready-to-paste
client proposal text. (Phase 5 will swap that for a real ManyChat → IG DM.)

```
Tally email
   ↓
[format message]   (existing)
   ↓
[NEW: Find matches + build notif]   ← reads Inventory + Sourcing Discord sheets
   ↓
[Telegram sendMessage]              ← uses the computed text + reply_markup
   ↓
[update CRM] (existing branch, parallel)


Second flow (separate workflow):

[Telegram Trigger]                  ← updates filter: callback_query
   ↓
[NEW: Build proposal]               ← parses callback_data, refetches matches by index
   ↓
[Telegram sendMessage]              ← bot sends YOU back the ready-to-paste IG DM text
```

---

## 1. Modify the Tally workflow — insert "Find matches"

1. Open your existing **Tally → CRM** workflow.
2. Right-click the connection between **`format message`** and **`sourcing
   request messsage`** (the Telegram node) and click "Add node here".
3. Add a **Code** node, name it **`Find matches`**.
4. Open the Code node, **Ctrl+A → Delete**, then paste the entire contents of
   [`n8n/find-matches-and-notify.js`](./find-matches-and-notify.js):
   ```
   https://raw.githubusercontent.com/Slowz942/DASCHBOARD-RESA-LP2P/main/n8n/find-matches-and-notify.js
   ```
5. Close the panel.

You don't need to change the API key or anything else — this Code node only
reads the public Google Sheets, it doesn't call Anthropic.

## 2. Update the Telegram `sourcing request messsage` node

1. Click the existing Telegram node (the one with name **`sourcing request
   messsage`**).
2. **Text** field → set to:
   ```
   {{ $json.telegram_text }}
   ```
3. Open **"Additional Fields"** → enable **`Parse Mode`** → set to `HTML`.
4. Open **"Additional Fields"** → enable **`Reply Markup`** (or "Keyboard / Reply
   Markup" depending on your n8n version) → set to:
   ```
   {{ $json.reply_markup }}
   ```
   (it's a JSON string already, n8n's Telegram node will pass it through.)
5. Save.

That's the notification side done.

## 3. Build the second workflow — callback handler

This is the part that responds when you tap a button.

1. Click **+ Add workflow** in n8n. Name it **`Discord/Stock callback handler`**.
2. Add a **Telegram Trigger** node:
   - **Updates** → check **`callback_query`** only (uncheck "message" etc.)
   - **Credential** → use your existing Telegram bot credential
3. Add a **Code** node, named **`Resolve match`**.
4. Paste the contents of [`n8n/callback-handler.js`](./callback-handler.js):
   ```
   https://raw.githubusercontent.com/Slowz942/DASCHBOARD-RESA-LP2P/main/n8n/callback-handler.js
   ```
5. Add a **Telegram** node, **`sendMessage`**:
   - **Chat ID:** `={{ $json.chat_id }}`
   - **Text:** `={{ $json.telegram_text }}`
   - **Additional Fields → Parse Mode:** `HTML`
6. Add another **Telegram** node right after, **`answerCallbackQuery`** (so the
   button stops showing the loading spinner):
   - **Resource:** Callback Query → **Operation:** Answer
   - **Callback Query ID:** `={{ $json.callback_query_id }}`
   - **Text** (optional): `Préparation…`
7. Wire: **Telegram Trigger → Resolve match → sendMessage → answerCallbackQuery**
8. Toggle **Active** ON.

## 4. Test

1. Submit a fresh Tally form (or replay a previous one from the n8n
   `Executions` tab on the Tally workflow → "Retry execution").
2. The Telegram chat should now show:
   ```
   🎫 Nouvelle demande
   ━━━━━━━━━━━━━━━━━━━
   👤 Karim Assaf @karim_flb
   🎤 BAD BUNNY
   📅 4/5 Juil 2026
   📍 2 places

   🔍 3 options:

   1️⃣ STOCK
      x1 Fosse BadBunny billet 7
      Achat 129€ → propose 190€ (+47%)

   2️⃣ DISCORD · @milanaise
      x2 CAT OR BAD BUNNY Marseille (allée)
      Vendeur 380€ → propose 494€ (+30%)

   3️⃣ DISCORD · @Dav trt
      x2 FOSSE BAD BUNNY Marseille
      Vendeur 420€ → propose 546€ (+30%)

   [1️⃣ STOCK · 190€]
   [2️⃣ milanaise · 494€]
   [3️⃣ Dav trt · 546€]
   [❌ Aucune]
   ```
3. Tap one button. The bot should reply with:
   ```
   ✅ Option sélectionnée
   ━━━━━━━━━━━━━━━━━━━
   🟢 STOCK
      x1 Fosse BadBunny billet 7
      Achat 129€ → propose 190€ (+47%)

   📋 À envoyer au client (copy):
   Salut Karim! J'ai trouve pour BAD BUNNY (4/5 Juil 2026) en NC. Je te la propose a 190EUR. Ca t'interesse ?
   ```
4. Long-press the `<code>` block to copy → paste in your IG DM with the client.
   That's Phase 4 — Phase 5 will fully automate that last step.

## 5. Troubleshooting

- **Buttons do nothing.** Check the second workflow is **Active** and the
  Telegram Trigger has **callback_query** enabled.
- **`telegram_text` is blank.** Open the failed execution → click the `Find
  matches` node → check its Output. If it's empty, the upstream `format
  message` node didn't produce expected fields. Check `tally.event`,
  `tally.categorie`, `tally.places` are populated.
- **No options showing even though you have stock.** Verify the demand's
  `event` field actually contains a known artist (e.g. "JUL", "BAD BUNNY"). If
  the user typed something free-form (e.g. "Compagnie Création"), normalizeArtist
  will return that string and no inventory item will match. Add the artist to
  `KNOWN_ARTISTS` in both the notification builder and the callback handler.
- **`HTTP 400` errors when fetching sheets.** The sheets must be
  **"Anyone with the link → Viewer"**. Re-share if needed.
