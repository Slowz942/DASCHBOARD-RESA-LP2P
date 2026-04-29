# IG DM Sender — Implementation Status

> Written 2026-04-29 after completing setup on the spare laptop.
> Hand this file to the Claude Code instance on the main laptop for full context.

---

## What was built

Automated Instagram DM sending for the LP2P ticket-resale pipeline. When the
operator taps a match option in Telegram, the proposal DM is automatically
sent to the client's Instagram within ~30 seconds. No Instagram API, no
headless browser — runs via Tampermonkey on the operator's real logged-in
IG session on a spare laptop.

### Architecture

```
Operator taps Telegram button
        │
        ▼
n8n callback workflow (edited)
        │
        ├─ answerCallbackQuery (parallel, unchanged)
        ├─ Resolve match → builds proposal_text (unchanged)
        ├─ Prep Queue Row (new Code node) → strips @, lowercases handle
        ├─ Has Queue Row (IF node, "Convert types" enabled)
        ├─ Google Sheets Append → "IG DM Queue" tab in CRM workbook
        └─ Telegram: "⏳ Queued for IG: @<handle>"
                │
                ▼
Spare laptop (Chrome + Tampermonkey, IG logged in)
        │
        ├─ Userscript polls "IG DM Queue" sheet every 15s via gviz CSV
        ├─ Finds PENDING rows → navigates to instagram.com/<handle>/
        ├─ Clicks "Message" button (handles popup or full-page DM)
        ├─ Types proposal_text via execCommand (React-compatible)
        ├─ Clicks Send
        └─ POSTs status to n8n webhook
                │
                ▼
n8n "IG Queue Status Updater" workflow (new)
        │
        ├─ Webhook: POST /webhook/ig-status
        ├─ Google Sheets Update Row → sets status=SENT/ERROR, sent_at, error
        └─ Telegram: "✅ DM sent to @<handle>" or "❌ DM failed @<handle>: <error>"
```

---

## Files created/modified

### New files
- **`userscript/instagram-dm-sender.user.js`** (committed to repo with placeholder URLs)
  - v0.2.1 — profile-based navigation, follow-back logic, deferred jobs, popup DM support
- **`IG-DM-SENDER-STATUS.md`** (this file)

### Modified in n8n (UI only, not in repo files)
- **Callback workflow** — added after Resolve match:
  1. `Prep Queue Row` (Code node) — strips @ from handle, lowercases, builds queue row object
  2. `Has Queue Row` (IF node) — checks `_skipQueue === false`, **"Convert types" must be enabled**
  3. Google Sheets Append → "IG DM Queue" tab
  4. Telegram sendMessage → "⏳ Queued for IG: @handle" (chat ID hardcoded to `5135913166`)
- **New workflow: "IG Queue Status Updater"**
  1. Webhook trigger: `POST /ig-status` (production URL: `https://bpartnersassistant.app.n8n.cloud/webhook/ig-status`)
  2. Parse Status (Code node)
  3. Valid Payload (IF node)
  4. Google Sheets Update Row → matches on `id` column, updates `status`, `sent_at`, `error`
     - **IMPORTANT:** Settings → "Always Output Data" must be ON (otherwise Telegram node doesn't fire)
  5. Telegram sendMessage → ✅ or ❌ confirmation

### Google Sheets
- **CRM workbook** (`1Id3KCN3_EVGvr04LJiAxks2yGTB1wOgNUfuD_M5pnK8`): new tab `IG DM Queue`
  - Columns: `id | ts | instagram_handle | proposal_text | status | sent_at | error`
  - Sharing: "Anyone with link can view"

---

## What works

- **Full end-to-end flow**: Tally form → Telegram notif → operator taps option → DM queued → DM sent → sheet updated → Telegram confirmation. Under 30 seconds.
- **Profile-based navigation**: goes to `instagram.com/<handle>/`, clicks Message button. Works with IG's new popup DM window.
- **Follow-back logic**: if no Message button visible, clicks Follow. If public account, Message appears and DM proceeds. If private account, defers job for 6 hours.
- **Deferred jobs**: private account follows are retried automatically after 6 hours.
- **Status reporting**: webhook updates sheet row and sends Telegram confirmation.
- **Safety features**: 20/hour DM cap, checkpoint detection (stops on `/challenge/` or unusual activity modals), 3 retry max on navigation failures.
- **Tampermonkey menu commands**: Pause/Resume queue, Clear seen IDs, Clear deferred jobs, Force clear active job, Show status.
- **UI badge**: bottom-right corner shows IDLE/SENDING/PAUSED/ERROR with recent activity log.

---

## What doesn't work / known issues

1. **`ig.me/m/<handle>` is unreliable** — sometimes returns error page. That's why we switched to profile-based navigation. Do NOT go back to `ig.me/m/`.

2. **IG popup DM window** — IG recently changed to open a small popup window instead of navigating to `/direct/t/`. The script handles this by not waiting for URL change, just waiting for the composer to appear. Works but the operator described it as "works weirdly" — may need future tuning if IG changes the popup behavior again.

3. **The "Convert types" checkbox** on the IF node in the callback workflow MUST be enabled. Without it, comparing `_skipQueue` (boolean) to `false` (string) fails silently and no rows get queued.

4. **Google Sheets Update node** in the status updater workflow MUST have "Always Output Data" enabled in Settings. Without it, the update returns no output and the downstream Telegram node never fires.

5. **Grammarly extension** throws console errors on IG pages (permissions policy violations). These are harmless but noisy. Consider disabling Grammarly on the spare laptop's Chrome if the console noise bothers you.

6. **`encodeURIComponent` was removed** from profile navigation URLs. Handles with special characters (unlikely for IG) would break. All real IG handles are `[a-zA-Z0-9._]` so this is fine.

---

## Spare laptop setup (already done)

- Windows 10 Pro, sleep disabled (Settings + PowerToys Awake)
- Chrome installed, Tampermonkey installed
- IG logged in, tab pinned
- Repo cloned at `C:\projects\DASCHBOARD-RESA-LP2P`
- Git authenticated via `gh auth login` (user: MirakFLB)
- Userscript installed in Tampermonkey with real URLs (not committed to repo)

### Real URLs (in Tampermonkey only, placeholders in repo)
```
QUEUE_CSV_URL = https://docs.google.com/spreadsheets/d/1Id3KCN3_EVGvr04LJiAxks2yGTB1wOgNUfuD_M5pnK8/gviz/tq?tqx=out:csv&sheet=IG%20DM%20Queue
STATUS_WEBHOOK_URL = https://bpartnersassistant.app.n8n.cloud/webhook/ig-status
```

---

## If things break

- **Script stuck in SENDING**: Tampermonkey menu → "LP2P · Force clear active job"
- **Rows not being picked up**: Tampermonkey menu → "LP2P · Clear seen IDs"
- **Sheet not updating**: Check n8n "IG Queue Status Updater" → Executions tab. Verify the workflow is active and "Always Output Data" is on.
- **DM not typing**: Check DevTools console for `[LP2P-IG]` logs. The script logs every step.
- **IG checkpoint/unusual activity**: Script auto-pauses. Operator must manually resolve on IG, then Tampermonkey menu → "LP2P · Resume queue".
- **Need to reinstall userscript**: Import from repo file, then edit lines 21-22 in Tampermonkey editor to paste real URLs. Ctrl+S.

---

## Repo conventions reminder

- Placeholder URLs in committed files, real URLs only in Tampermonkey local storage
- No secrets (tokens, webhook URLs) in git
- The userscript follows the same patterns as `userscript/discord-wts-scraper.user.js`
- See `CLAUDE.md` for full project conventions
- See `SPARE-LAPTOP-SETUP.md` for the original brief
