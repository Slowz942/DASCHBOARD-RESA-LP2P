# Spare-Laptop Brief — Discord WTS Scraper Migration & Hardening

> You (the Claude instance on the spare laptop) are receiving this brief cold.
> Read it fully before acting. You already set up the IG DM Sender on this
> laptop — same patterns apply. Read `CLAUDE.md` (project conventions),
> `SPARE-LAPTOP-SETUP.md` (the IG sender brief, for context on the laptop's
> environment), and `IG-DM-SENDER-STATUS.md` (your own handoff from last
> session). Then come back here.

---

## What we're doing

Moving the existing Discord WTS scraper from the operator's main laptop to
this spare laptop, and adding two pieces of hardening on top of the move:

1. **Auto-scroll-to-bottom** so Discord's virtualized message list always
   renders new posts (the scraper depends on DOM mutation; if the channel
   scroll position drifts, new messages don't mount and we miss them).
2. **Heartbeat to n8n every 5 min + watchdog alerting** so silent failure
   (laptop sleep, Discord disconnect, script crash, channel changed) gets
   caught instead of just causing missing data.

The current scraper works correctly when the channel is actively rendering.
The bug is environmental: the operator wasn't keeping the WTS tab open.
Moving here fixes that. The two add-ons close the remaining failure modes.

### Architecture

```
Discord #wts channel (community sellers)
        │
        │ DOM mutation (new message renders)
        ▼
Spare laptop, Chrome with Discord pinned to #wts
        │
        ├─ Tampermonkey: discord-wts-scraper.user.js (existing, edited)
        │   ├─ MutationObserver on chat list → scanAndSend (unchanged)
        │   ├─ NEW: setInterval auto-scroll-to-bottom every 30s
        │   ├─ NEW: setInterval heartbeat POST every 5 min
        │   └─ NEW: detect Discord disconnect → auto-refresh after 60s
        │
        ├─ Existing: POST WTS messages → n8n parse-via-claude flow → Sourcing Discord sheet
        └─ NEW: POST heartbeat → n8n /webhook/discord-heartbeat

n8n (two new workflows)
        │
        ├─ Workflow A: "Discord Scraper Heartbeat"
        │   ├─ Webhook trigger on /discord-heartbeat
        │   ├─ Update "Heartbeats" sheet row (source=discord-scraper)
        │   └─ Return 200
        │
        └─ Workflow B: "Heartbeat Watchdog"
            ├─ Cron: every 15 min
            ├─ Read Heartbeats sheet, check last_seen per source
            ├─ If stale (>15 min) and alert_state was OK → Telegram alert + set alert_state=STALE
            └─ If fresh and alert_state was STALE → Telegram "back online" + set alert_state=OK
```

The watchdog is generic by design: future sources (e.g. the IG DM sender
itself, if you add heartbeats to it later) just write a new row in the
Heartbeats sheet and the watchdog picks them up automatically.

---

## What's already in place

You'll edit, not rebuild, these:

- `userscript/discord-wts-scraper.user.js` — current v0.1.2. Already
  installed on the **operator's main laptop**. After this work, it will
  run on this **spare laptop** (and stop on the main laptop).
- n8n parse-via-claude flow that consumes WTS messages from the existing
  webhook and appends to the "Sourcing Discord" sheet
  (`10QzZ14S4fA5zuM-UyROwmsIKLcwPata6cVLN23bukW8`). Don't touch.
- CRM workbook `1Id3KCN3_EVGvr04LJiAxks2yGTB1wOgNUfuD_M5pnK8` — already
  hosts the `IG DM Queue` tab. The new `Heartbeats` tab goes here for
  cohesion.
- Chrome on this laptop, sleep-prevention, IG already running on it.
  Discord will be a second pinned tab in the same browser. No conflict —
  the userscript metadata `@match` scopes it to the WTS channel URL.

---

## What stays the same (do not change)

- The DOM extraction logic in `extractMessage()` — works, leave it alone.
- The `looksLikeWTS()` regex and the WTS-only filter toggle.
- The dedupe pattern (`getSeen()` / `addSeen()` keyed on Discord message id).
- The webhook URL menu command (`LP2P · Set webhook URL`) and how the
  webhook URL persists via `GM_setValue`. The new heartbeat URL follows
  the same pattern.
- The toast helper, `@connect *` directive, batch POST shape.

If you find yourself rewriting any of the above, stop and ask the operator.

---

## Changes to ship

### Change 1 — Migrate to the spare laptop

This is operator-driven; you guide them.

1. **On this laptop**, open Discord in Chrome (web, not desktop client —
   the userscript only runs in the browser). The operator logs in with
   their normal Discord account. If 2FA / new device verification fires,
   they complete it. Browse for a few minutes to let the session settle.
2. Pin a tab on `https://discord.com/channels/1182738991943008387/1201954119804264458`
   (the server + WTS channel IDs, already encoded in the userscript's
   `@match` directive). This tab must stay on the WTS channel — switching
   channels stops the scraper, which is fine because the watchdog will
   alert on missing heartbeats.
3. Install the userscript in this laptop's Tampermonkey (import from the
   repo file `userscript/discord-wts-scraper.user.js`).
4. Tampermonkey menu → `LP2P · Set webhook URL` → paste the existing
   production webhook URL. Operator pulls this from their main-laptop
   Tampermonkey or from the n8n flow's webhook node settings.
5. **On the operator's main laptop**: disable the userscript in
   Tampermonkey there (toggle off — don't delete; keeps it as a backup).
   Otherwise both laptops scrape, both POST, and you get duplicate-row
   churn (the n8n flow does some dedupe but you don't want to rely on
   that).
6. Reload the spare laptop's WTS tab. Verify in DevTools console you see
   `[LP2P] Discord WTS scraper active on channel 1201954119804264458`.

### Change 2 — Auto-scroll + disconnect-recover

Edit `userscript/discord-wts-scraper.user.js`. Bump `@version` to `0.2.0`.

#### 2a. Auto-scroll-to-bottom

Discord virtualizes the message list. If scroll position drifts up (hover
on an embed, accidental wheel, something that took focus), new messages
at the bottom never mount in the DOM, MutationObserver never fires,
scraper silently misses everything. Fix: programmatic scroll-to-bottom on
a 30s interval.

Add a `findScroller()` helper that walks up from
`[data-list-id="chat-messages"]` to the first ancestor with
`overflow-y: auto|scroll` and `scrollHeight > clientHeight`. Cache the
result; refind if the cached node is detached.

Add a setInterval (30s) that, when not paused, sets
`scroller.scrollTop = scroller.scrollHeight`. Fire-and-forget; Discord's
own scroll handlers will load anything missing.

Add a menu command `LP2P · Pause auto-scroll` that toggles a `GM_setValue`
flag. Default ON. Reflect state in the existing `Show status` output.

This laptop is dedicated to scraping — the operator isn't reading message
history on this Chrome — so unconditional scroll-to-bottom is fine. The
pause toggle is just for debugging.

#### 2b. Disconnect-recover

Discord shows a "Reconnecting..." or "You are offline" banner when its
WebSocket drops. Heartbeats won't catch this — they fire on a timer
independent of Discord's connection — but missed messages will pile up.

Add a small detector that checks (every 30s) for the presence of a
disconnect indicator. Match by visible text *and* common aria patterns:

```js
const disconnectMarkers = [
  '[class*="connectionStatus"][class*="offline"]',
  '[role="status"][aria-live]',
];
```

If any marker is present and remains present for >60s, call
`location.reload()`. Log the reload reason via the heartbeat (next
heartbeat after reload includes `recovered_from: "disconnect"`).

Don't reload more than once per 10 minutes — guard against a tight loop
if the underlying issue isn't connection-related.

### Change 3 — Heartbeat + n8n watchdog

#### 3a. Userscript heartbeat

New menu command `LP2P · Set heartbeat URL` (parallel to the existing
webhook URL command). Stored under key `lp2p_wts_heartbeat`.

setInterval every 5 min (300_000 ms). On each fire, POST to the heartbeat
URL with:

```json
{
  "source": "discord-scraper",
  "ts": "<ISO>",
  "channel_id": "1201954119804264458",
  "version": "0.2.0",
  "messages_visible": <count of [id^="chat-messages-..."] in DOM>,
  "seen_count": <getSeen().size>,
  "auto_scroll": <bool>,
  "recovered_from": <optional, set on first heartbeat after a disconnect-reload>
}
```

Use `GM_xmlhttpRequest` (same as the WTS post). On non-2xx, log via
`console.warn` but don't retry — the watchdog tolerates a single missed
heartbeat (15 min threshold vs 5 min interval).

Also fire one heartbeat **immediately on script load**, after the initial
scan settles (~3s in). That gives a fast signal that startup worked.

If `heartbeat URL` is unset, skip silently — same pattern as the existing
webhook URL.

#### 3b. n8n side

You'll do this through the n8n web UI from either laptop.

**Sheet first:** create a new tab in the CRM workbook
(`1Id3KCN3_EVGvr04LJiAxks2yGTB1wOgNUfuD_M5pnK8`) named `Heartbeats`. Headers:

```
source | last_seen | version | alert_state | last_alert_at | notes
```

Seed one row: `source=discord-scraper`, `alert_state=OK`, others blank.
"Anyone with link can view" sharing.

**Workflow A — "Discord Scraper Heartbeat":**

1. **Webhook trigger.** Method POST, path `discord-heartbeat`. Activate
   to get the production URL. That URL is what the operator pastes into
   the userscript's `LP2P · Set heartbeat URL` menu.
2. **Code node "Parse Heartbeat":** extract `source`, `ts`, plus optional
   diag fields. Output a flat object the Sheets node can consume.
3. **Google Sheets — Update Row** on `Heartbeats` sheet:
   - Match column: `source`
   - Updates: `last_seen` = `ts`, `version`, `notes` (concat of
     `messages_visible`, `seen_count`, `recovered_from` for debugging)
   - **Settings → "Always Output Data" must be ON** (same gotcha as the
     IG status updater workflow you already know)
4. **Respond to Webhook** node returning 200.

**Workflow B — "Heartbeat Watchdog":**

1. **Cron / Schedule Trigger** every 15 min.
2. **Google Sheets — Read** all rows from `Heartbeats`.
3. **Code node "Check Stale":** for each row, parse `last_seen`,
   compute `stale = (now - last_seen) > 15min`. Output one of:
   - `{ source, action: "alert_stale", since, alert_state: "STALE" }`
   - `{ source, action: "alert_recovered", alert_state: "OK" }`
   - `{ source, action: "noop" }` (filtered out downstream)
   Decide by comparing `stale` flag against current `alert_state`:
   - stale && alert_state === "OK" → `alert_stale` (transition)
   - !stale && alert_state === "STALE" → `alert_recovered` (transition)
   - otherwise → noop
4. **IF node** filters out `action === "noop"`. **"Convert types" must
   be ON** (same gotcha as before).
5. **Switch node** branches on `action`:
   - `alert_stale` → Telegram sendMessage to operator chat
     (`5135913166`): `🚨 <source> silent for >15 min (last seen <since>).`
   - `alert_recovered` → Telegram sendMessage:
     `✅ <source> back online.`
6. After each branch, **Google Sheets — Update Row** on `Heartbeats`
   (match `source`): set `alert_state` and `last_alert_at = now`.

Activate both workflows.

#### 3c. Wire the userscript

Operator pastes the Workflow A production URL into the userscript via
`LP2P · Set heartbeat URL`. Reload the WTS tab. Within 5 min the
`Heartbeats` sheet's `discord-scraper` row should update.

---

## Per-file changes summary

| File | Change |
|------|--------|
| `userscript/discord-wts-scraper.user.js` | v0.1.2 → 0.2.0. Add: `findScroller()`, auto-scroll interval, pause toggle menu, disconnect detector + auto-reload, heartbeat interval, heartbeat URL menu. Update setup comment block. |
| n8n (UI only) | New sheet tab `Heartbeats` in CRM workbook. New workflow "Discord Scraper Heartbeat". New workflow "Heartbeat Watchdog". |
| Operator's main laptop | Disable (don't delete) the userscript in Tampermonkey. |

---

## Conventions you must not break

Reminders from `CLAUDE.md` and earlier work:

- `@connect *` stays in the userscript metadata (cross-origin POST).
- Webhook + heartbeat URLs live only in `GM_setValue`, never committed.
- Dedupe via `GM_setValue('lp2p_wts_seen', ...)` — don't fork the storage
  pattern. New keys go under the same `STORE` prefix (`lp2p_wts_`).
- n8n IF nodes: **"Convert types" ON**.
- n8n Sheets Update nodes: **"Always Output Data" ON**.
- Telegram chat ID is `5135913166`. Hardcode in n8n nodes.
- No real URLs, tokens, or chat IDs in committed files. Placeholders only.
- Heartbeat interval 5 min, watchdog threshold 15 min — three-strikes
  buffer (one missed heartbeat is still OK; two missed = stale).
- Auto-scroll interval 30s. Don't lower it without a reason — it's
  generous on purpose.
- Disconnect-reload throttle: max one reload per 10 min.
- Disable the script on the main laptop — don't run two scrapers in
  parallel.

---

## Testing checklist

Run all of these before declaring done.

- [ ] Spare laptop: WTS tab open, userscript reports active in console.
- [ ] Operator's main laptop: userscript toggled off in Tampermonkey.
- [ ] First heartbeat fires within ~10s of load. `Heartbeats` sheet
      row for `discord-scraper` shows fresh `last_seen`.
- [ ] Within 5 min, second heartbeat fires; `last_seen` updates again.
- [ ] Operator posts a test WTS message in #wts (or asks a known WTS-er
      to). Spare laptop forwards it within ~3s; row appears in
      `Sourcing Discord` sheet via the existing parse-via-claude flow.
- [ ] Auto-scroll: scroll the WTS tab up manually; within 30s the script
      scrolls back to bottom.
- [ ] Pause auto-scroll via menu; verify it stays where you scrolled.
      Resume via menu; verify it scrolls back down.
- [ ] Watchdog stale alert: manually edit the `last_seen` cell in the
      Heartbeats sheet to 30 min ago. Within 15 min the watchdog cron
      runs and you receive `🚨 discord-scraper silent for >15 min`.
- [ ] Watchdog recovery alert: let a real heartbeat update `last_seen`
      to fresh. Within 15 min you receive `✅ discord-scraper back online`.
- [ ] Disconnect-recover: open Chrome DevTools → Network tab → set to
      "Offline" for 90 seconds. Userscript should reload the page once
      after the 60s threshold. After page reload, heartbeat resumes.
      Restore network. Confirm no reload-loop (wait 5 min, no extra
      reloads).

---

## When in doubt

- Read `CLAUDE.md` first.
- Mirror the patterns in `userscript/instagram-dm-sender.user.js` and
  `userscript/discord-wts-scraper.user.js` rather than inventing new ones.
- Ask the operator before introducing new dependencies, new external
  services, or changes outside the three explicit Changes above.
- The existing parse-via-claude flow and the `Sourcing Discord` sheet are
  out of scope. Do not touch them.

---

## Out of scope (do not do)

- Don't migrate the WTS message webhook URL or the parse flow.
- Don't change `looksLikeWTS()` or `extractMessage()`.
- Don't add Discord login automation, multiple-channel support, or
  message editing/sending.
- Don't add heartbeats to the IG DM sender as part of this work
  (separate task; the watchdog is generic and ready for it later).
- Don't change the Tampermonkey storage prefix or the dedupe semantics.

If you finish all three Changes and the testing checklist passes, write
a concise `DISCORD-SCRAPER-V2-STATUS.md` (mirror `IG-DM-SENDER-STATUS.md`)
and commit it. That's the handoff back to the main-laptop Claude.
