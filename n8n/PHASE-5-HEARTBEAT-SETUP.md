# Phase 5 — Discord scraper heartbeat + watchdog

The Discord WTS scraper (running on the spare laptop's Tampermonkey) POSTs
a heartbeat every 5 min. Two new n8n workflows turn that signal into
Telegram alerts when the scraper goes silent (laptop slept, Chrome
crashed, Discord disconnected, channel changed, etc.) and again when it
comes back online.

```
Userscript v0.2.0 (spare laptop)
   ↓ POST /webhook/discord-heartbeat (every 5 min, plus one ~3s after load)
[Workflow A: "Discord Scraper Heartbeat"]
   ↓ Update row in Heartbeats sheet (source = discord-scraper)
   ↓ 200 OK

[Workflow B: "Heartbeat Watchdog"]   (Schedule: every 15 min)
   ↓ Read all rows from Heartbeats sheet
   ↓ Code: per-row stale check; only emit on STATE TRANSITIONS
   ↓ IF action != noop  (Convert types ON)
   ↓ Switch on action
       ├─ alert_stale     → Telegram "🚨 <source> silent for >15 min..."
       └─ alert_recovered → Telegram "✅ <source> back online."
   ↓ Update row (alert_state, last_alert_at)
```

The watchdog is generic — any future source (e.g. the IG DM sender, if you
add heartbeats to it later) just writes a new row in the `Heartbeats`
sheet and the same workflow picks it up.

---

## 1. Sheet first — create the `Heartbeats` tab

In the CRM workbook (`1Id3KCN3_EVGvr04LJiAxks2yGTB1wOgNUfuD_M5pnK8`):

1. Add a new tab named **`Heartbeats`**.
2. Row 1 headers (one per column, exact spelling):
   ```
   source | last_seen | version | alert_state | last_alert_at | notes
   ```
3. Seed one row:
   ```
   source = discord-scraper
   alert_state = OK
   ```
   Leave `last_seen`, `version`, `last_alert_at`, `notes` blank.
4. Sharing → **Anyone with link can view** (matches the existing tabs).

---

## 2. Workflow A — "Discord Scraper Heartbeat"

This is the receiver. It updates the row whenever the userscript pings.

1. n8n → **+ Add workflow** → name **`Discord Scraper Heartbeat`**.
2. **Webhook** trigger node:
   - **HTTP Method** = `POST`
   - **Path** = `discord-heartbeat`
   - **Respond** = `Using Respond to Webhook node` (we add that node at the end)
3. **Code** node, named **`Parse Heartbeat`**.
   - Paste the entire contents of [`n8n/parse-heartbeat.js`](./parse-heartbeat.js):
     ```
     https://raw.githubusercontent.com/Slowz942/DASCHBOARD-RESA-LP2P/main/n8n/parse-heartbeat.js
     ```
   - No edits needed — it consumes both wrapped and direct webhook shapes.
4. **Google Sheets** node, **Update Row** operation, named **`Update Heartbeats Row`**.
   - **Credential** = your existing Google credential.
   - **Document** = CRM workbook (`1Id3KCN3_EVGvr04LJiAxks2yGTB1wOgNUfuD_M5pnK8`).
   - **Sheet** = `Heartbeats`.
   - **Mapping Column Mode** = `Map Each Column Manually`.
   - **Column to match on** = `source`.
   - **Values to send** (use `{{ $json.fieldname }}` expressions):
     - `last_seen`  → `{{ $json.last_seen }}`
     - `version`    → `{{ $json.version }}`
     - `notes`      → `{{ $json.notes }}`
   - **Settings → Always Output Data → ON.** (Same gotcha as the IG status updater workflow — without this the Respond node fires before the row update lands, and with empty data downstream nodes silently drop.)
5. **Respond to Webhook** node, named **`OK`**.
   - **Respond With** = `Text` (or empty JSON), **Response Code** = `200`.
6. **Activate** the workflow (toggle top-right). Copy the **production URL** of the Webhook node — that's what the userscript will POST to.

---

## 3. Workflow B — "Heartbeat Watchdog"

This is the alerter. Runs on a schedule independent of the userscript.

1. n8n → **+ Add workflow** → name **`Heartbeat Watchdog`**.
2. **Schedule Trigger** node:
   - **Mode** = `Every X` → **15 minutes**.
3. **Google Sheets** node, **Read Rows** operation, named **`Read Heartbeats`**.
   - Same credential, same workbook, sheet = `Heartbeats`.
   - **Range** = `A:F` (or auto-detect headers — either works).
4. **Code** node, named **`Check Stale`**.
   - Paste the entire contents of [`n8n/check-stale.js`](./check-stale.js):
     ```
     https://raw.githubusercontent.com/Slowz942/DASCHBOARD-RESA-LP2P/main/n8n/check-stale.js
     ```
5. **IF** node, named **`Has Action`**.
   - **Condition**: `{{ $json.action }}` **not equal** `noop`
   - **Settings → Convert types → ON.** (CLAUDE.md gotcha — the comparison silently fails without this.)
6. **Switch** node on the `true` branch of the IF, named **`Route Action`**.
   - Mode = `Expression`.
   - Output 0 condition: `{{ $json.action }}` equals `alert_stale`
   - Output 1 condition: `{{ $json.action }}` equals `alert_recovered`
7. **Telegram sendMessage** node on each Switch output:
   - Output 0 → name **`Alert Stale`**:
     - **Chat ID** = `5135913166` (hardcoded — operator's chat)
     - **Text** = `{{ $json.text }}`
   - Output 1 → name **`Alert Recovered`**:
     - **Chat ID** = `5135913166`
     - **Text** = `{{ $json.text }}`
   - Use the same Telegram credential as the existing flows.
8. **Google Sheets** node, **Update Row** on each Telegram node's output:
   - Same workbook, sheet = `Heartbeats`, match on `source`.
   - Values:
     - `alert_state`    → `{{ $json.alert_state }}`
     - `last_alert_at`  → `{{ $json.last_alert_at }}`
   - **Settings → Always Output Data → ON.**
   - Name them `Mark STALE` and `Mark OK` for clarity.
9. **Activate** the workflow.

---

## 4. Wire the userscript

Back on the spare laptop:

1. Tampermonkey menu (on the WTS Discord tab) → **`LP2P · Set heartbeat URL`**.
2. Paste the production URL from Workflow A's Webhook node (from step 2.6 above).
3. Reload the WTS tab. The userscript fires one heartbeat ~3s after load and then every 5 min.
4. Within ~10s the `Heartbeats` sheet's `discord-scraper` row should show fresh values in `last_seen`, `version`, `notes`.
5. `LP2P · Show status` will now display the heartbeat URL alongside the webhook URL.

---

## 5. Test

Per the migration brief's checklist:

- **Heartbeat round-trip:** reload the WTS tab; within ~10s the row updates; within 5 min it updates again.
- **Stale alert:** edit the `last_seen` cell to ~30 min ago. Within 15 min the watchdog cron fires and you receive `🚨 discord-scraper silent for >15 min`. The row's `alert_state` flips to `STALE`.
- **Recovery alert:** wait for a real heartbeat (≤5 min) to refresh `last_seen`. Within 15 min you receive `✅ discord-scraper back online`. `alert_state` flips back to `OK`.
- **No spam:** with the row stable in either state, subsequent watchdog runs emit `noop` and the IF node filters them out — no Telegram messages sent.

---

## Conventions reminder

- `Heartbeats` sheet headers exact: `source | last_seen | version | alert_state | last_alert_at | notes`.
- `alert_state` is `OK` or `STALE` (uppercase). The Code node tolerates lowercase but the Sheets row should stay uppercase.
- Telegram chat ID `5135913166` is hardcoded in both Telegram nodes.
- All Sheets Update Row nodes need **Always Output Data ON**.
- The IF node needs **Convert types ON**.
- Heartbeat 5 min, watchdog 15 min — the three-strikes buffer is intentional. Don't tighten without a reason.
- The webhook URL produced by Workflow A is treated like a shared secret — paste it into Tampermonkey only, don't commit it anywhere.
