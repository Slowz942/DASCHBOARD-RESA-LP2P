# Discord WTS Scraper v0.2.0 — Implementation Status

> Written 2026-05-01 after completing the Phase 5 follow-up work on the spare laptop.
> Hand this file to the Claude Code instance on the main laptop for full context.

---

## What was built

Three changes on top of the existing `userscript/discord-wts-scraper.user.js`:

1. **Migration of the scraper to the spare laptop.** The userscript runs in this laptop's Tampermonkey on a pinned WTS Discord tab. The main laptop's copy is toggled OFF (kept as backup, not deleted).
2. **Auto-scroll-to-bottom + disconnect-recover** in the userscript so Discord's virtualized message list always renders new posts and so a dropped WebSocket triggers a reload after sustained disconnect.
3. **Heartbeat to n8n every 5 min + a generic watchdog** that alerts on Telegram if any registered source goes silent (and again when it recovers). The watchdog reads from a new `Heartbeats` sheet that future sources can append to without changing the workflow.

### Architecture

```
Discord #wts (community sellers)
        │
Spare laptop, Chrome with Discord pinned to #wts
        │
        ├─ Tampermonkey: discord-wts-scraper.user.js v0.2.0
        │   ├─ MutationObserver on chat list → scanAndSend (unchanged)
        │   ├─ setInterval auto-scroll-to-bottom every 30s (pause toggle in menu)
        │   ├─ setInterval disconnect-detect every 30s; ≥60s sustained → location.reload
        │   │   (throttled to ≤1 reload per 10 min; sets recovered_from='disconnect'
        │   │    flag for the next heartbeat after reload)
        │   ├─ setInterval heartbeat POST every 5 min (plus one ~3s after load)
        │   └─ POST WTS messages → n8n parse-via-claude flow (UNCHANGED)
        │
        └─ POST heartbeat → n8n /webhook/discord-heartbeat (NEW)

n8n
        │
        ├─ Workflow A "Discord Scraper Heartbeat" (NEW)
        │   Webhook → Parse Heartbeat (Code) → Sheets Update Row → Respond 200
        │
        └─ Workflow B "Heartbeat Watchdog" (NEW)
            Schedule (15min) → Sheets Read → Check Stale (Code) → Switch
                ├─ output 0 (alert_stale) ─┬─ Telegram 🚨
                │                          └─ Sheets Update Row (alert_state=STALE)
                └─ output 1 (alert_recovered) ─┬─ Telegram ✅
                                                └─ Sheets Update Row (alert_state=OK)
```

The watchdog is generic by design. To wire a new source (e.g. heartbeats from the IG DM sender later), append a row to the `Heartbeats` sheet with that source's identifier — Workflow B picks it up automatically on the next 15-min run.

---

## Files created / modified

### Modified
- **`userscript/discord-wts-scraper.user.js`** — v0.1.2 → v0.2.0. Added `findScroller`, `autoScrollTick`, `checkDisconnect`, `heartbeat` functions. New menu commands `LP2P · Set heartbeat URL` and `LP2P · Pause auto-scroll`. Extended `Show status` alert with version, heartbeat URL, auto-scroll state, last reload timestamp.

### New in repo
- **`n8n/parse-heartbeat.js`** — Workflow A's Code node body.
- **`n8n/check-stale.js`** — Workflow B's Code node body. Only emits on state transitions (OK→STALE, STALE→OK), so no Telegram spam during a sustained outage.
- **`n8n/PHASE-5-HEARTBEAT-SETUP.md`** — step-by-step setup walkthrough for sheet + both workflows.
- **`DISCORD-SCRAPER-V2-STATUS.md`** (this file).

### Modified in n8n (UI only, not in repo)
- **New workflow: "Discord Scraper Heartbeat"** (Webhook → Parse Heartbeat → Update Heartbeats Row → OK respond). Production webhook URL: `https://bpartnersassistant.app.n8n.cloud/webhook/discord-heartbeat`.
- **New workflow: "Heartbeat Watchdog"** (Schedule 15min → Read Heartbeats → Check Stale → Switch → two parallel Telegram + Sheets-Update branches). The `IF` filter from the original brief was removed — see "Gotchas" below.

### Google Sheets
- **CRM workbook** (`1Id3KCN3_EVGvr04LJiAxks2yGTB1wOgNUfuD_M5pnK8`): new tab `Heartbeats`.
  - Columns: `source | last_seen | version | alert_state | last_alert_at | notes`
  - Seed row: `source=discord-scraper, alert_state=OK`, others blank.
  - Sharing: anyone with link can view.

---

## What works

- **Cutover**: spare laptop scrapes the WTS channel, main laptop's userscript toggled off, no duplicate POSTs.
- **Real WTS message round-trip**: `[LP2P] forwarded N messages -> 200` confirmed in console; rows land in `Sourcing Discord` via the existing parse-via-claude flow (untouched).
- **Heartbeat round-trip**: row updates within ~10s of tab reload, then every 5 min. `notes` column shows live diag (`msgs=N seen=N autoscroll=true`).
- **Stale alert**: backdating `last_seen` triggers `🚨 discord-scraper silent for >15 min...` Telegram + sheet flips to `STALE`.
- **Recovered alert**: a fresh heartbeat after STALE triggers `✅ discord-scraper back online.` Telegram + sheet flips back to `OK`.
- **No-spam steady state**: with state=OK and fresh heartbeat, the Switch drops the `noop` and no Telegram fires.
- **Auto-scroll**: scrolling up snaps back within 30s. `LP2P · Pause auto-scroll` menu toggle holds the scroll position; toggling back resumes.
- **Disconnect-recover**: DevTools → Network → Offline for 90s triggers `location.reload()` after the 60s threshold; next heartbeat after reload includes `recovered_from=disconnect` in `notes`. Reload throttled to ≤1 per 10 min.

---

## Gotchas hit this session

These are new gotchas discovered while wiring up Workflow B. Worth folding into `CLAUDE.md` if they bite again.

1. **n8n Telegram node response replaces `$json` for downstream nodes.** The original wiring per the brief was Switch → Telegram → Sheets-Update. After the Telegram step, `$json` becomes the Telegram API response (`{ ok, result.message_id, ... }`) — `$json.alert_state` and `$json.last_alert_at` are gone. Result: Sheets-Update silently fails with "result undefined". **Fix:** branch the Sheets-Update **in parallel** with Telegram from the same Switch output. Both nodes get the original Code-node output as `$json`. (Alternative: `{{ $('Check Stale').item.json.alert_state }}` to reach back, but parallel branches are cleaner.)

2. **`Map Each Column Manually` is finicky; `Auto-Map` is more forgiving.** Manual mode requires explicit field rows for every column you want to write, and it's easy to miss one. Switching the Sheets Update Row nodes to `Auto-Map Input Data` made everything work because the Code node already outputs JSON keys that match the sheet column headers exactly (`source`, `alert_state`, `last_alert_at`).

3. **The `IF` node before the `Switch` is redundant.** The original brief had `IF (action != noop)` between Code and Switch. n8n's `Switch` (in Rules mode) drops items that match no rule by default — so noop items vanish naturally. Removing the `IF` simplified the workflow and removed one source of misconfiguration. Switch's `Fallback Output` should stay set to `None`.

4. **Boundary check on staleness threshold.** The Code uses `(now - last_seen) > 15min`. At exactly 15 min the row is *not* stale. If you're testing right at the boundary you may see `noop` when you expected `alert_stale`. Backdate to 30+ min to be unambiguous.

---

## Spare laptop setup (already done)

- Windows 10 Pro, sleep disabled (Settings + PowerToys Awake), Chrome auto-starts on boot.
- Discord logged in via web (not desktop client), pinned tab on `https://discord.com/channels/1182738991943008387/1201954119804264458`.
- Tampermonkey: userscript installed at v0.2.0 with both URLs set.
- IG DM sender (per `IG-DM-SENDER-STATUS.md`) continues to run alongside in the same Chrome — no conflict, the userscripts' `@match` directives scope them to different hosts.

### Real URLs (in Tampermonkey local storage only — placeholders in repo)
```
WTS webhook URL    = (existing prod URL pulled from n8n parse-via-claude flow)
Heartbeat URL      = https://bpartnersassistant.app.n8n.cloud/webhook/discord-heartbeat
```

---

## If things break

- **Heartbeat sheet not updating**: open Workflow A "Discord Scraper Heartbeat" → Executions tab. If no recent runs, the userscript isn't POSTing — check Tampermonkey menu `LP2P · Show status`, the Heartbeat URL must be set. If runs are there but the row isn't moving, check the Sheets node's "Update Row" execution log for "Updated 0 rows" (column-name mismatch).
- **No Telegram alerts despite stale rows**: open Workflow B "Heartbeat Watchdog" → Executions tab. Confirm the workflow is **active** (the schedule won't run if it's not). Manually click **Execute Workflow** to force a run; check each node's output. If Switch drops everything, the Code node's `action` field isn't matching `alert_stale`/`alert_recovered`.
- **Telegram spam every 15 min during outage**: shouldn't happen — Code only emits on transitions. If it does, check that the Sheets-Update on the alert branch successfully wrote `alert_state=STALE`. If the sheet still says `OK`, the next watchdog run sees state=OK, still stale → emits `alert_stale` again (re-transition). Sheets-Update is the load-bearing step here.
- **Userscript stops after a Discord update**: Discord rotates CSS classes constantly; the disconnect detector's `connectionStatus` selector or the auto-scroll's scroller traversal may break. Selectors used: `[data-list-id="chat-messages"]` (stable), `[class*="connectionStatus"][class*="offline"]` (semi-stable), `time` element / `data-user-id` attr (stable). If the disconnect detector breaks, worst case the script just stops auto-recovering — heartbeats still fire, watchdog still alerts, operator manually reloads.
- **Need to silence alerts temporarily**: deactivate Workflow B in n8n. Re-activate when ready.
- **Need to roll back to main laptop**: spare laptop Tampermonkey → toggle the userscript OFF; main laptop Tampermonkey → toggle ON. Heartbeat will go silent on the spare and the watchdog will alert (intentional). Either silence Workflow B during the swap or accept the one-time alert.
- **Disconnect-reload loop suspected**: Tampermonkey storage key `lp2p_wts_last_reload_ts` is the timestamp of the most recent reload. If reloads are too frequent, that key + the 10-min throttle in `RELOAD_THROTTLE_MS` is the place to look.

---

## Repo conventions reminder

- Placeholder URLs in committed files; real URLs only in Tampermonkey local storage.
- No secrets (tokens, webhook URLs, chat IDs) in git — all real values come from `GM_setValue` or n8n credentials.
- Telegram chat ID `5135913166` IS hardcoded in the n8n Telegram nodes (not a secret per `CLAUDE.md`).
- All Sheets Update Row nodes need **Always Output Data ON** (existing convention).
- Heartbeat 5min, watchdog 15min, auto-scroll 30s, reload throttle 10min. Don't tighten without a reason — three-strikes buffer is intentional.
- See `DISCORD-SCRAPER-MIGRATION.md` for the original brief and `n8n/PHASE-5-HEARTBEAT-SETUP.md` for the n8n setup recipe.
