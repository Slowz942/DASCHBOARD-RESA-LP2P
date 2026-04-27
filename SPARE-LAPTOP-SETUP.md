# Spare-Laptop Brief — Instagram DM Sender

> You (the Claude instance on the spare laptop) are receiving this brief cold.
> Read it fully before acting. The operator hands you a working repo and a
> blank laptop; your job is to turn that laptop into the IG-DM-sender side of
> a multi-machine pipeline. Read this **and** `CLAUDE.md` at the repo root
> before writing any code — `CLAUDE.md` defines the project conventions and
> you must respect them.

---

## What we're building

The operator runs a ticket-resale business. Existing pipeline (already working,
do not touch):

```
Tally form → n8n → Telegram notif with inline keyboard
                            │
                operator taps an option
                            │
            n8n callback workflow → builds proposal text
                            │
                 currently: copies text, operator pastes manually into IG
```

Your goal is to replace that final manual step with an automatic IG DM,
**without** using Instagram's Business Messaging API (we explicitly chose
not to pursue that route) and **without** running headless browsers on a
datacenter (datacenter IPs trigger IG's anti-abuse system; we explicitly
rejected Hetzner-style hosting).

Instead: the spare laptop you're on becomes a 24/7 IG-sender via Tampermonkey
on the operator's actual logged-in IG session. It mirrors the architectural
pattern the operator already trusts (see
`userscript/discord-wts-scraper.user.js` — Tampermonkey scraping Discord WTS
posts, no API, no ban risk).

### Target architecture

```
n8n callback workflow (existing, edit needed)
        │
        ├─ 1. answerCallbackQuery (untouched)
        ├─ 2. Resolve match → builds proposal_text (untouched)
        ├─ 3. NEW: append row to "IG DM Queue" sheet
        │      cols: id, ts, instagram_handle, proposal_text,
        │            status=PENDING, sent_at, error
        └─ 4. NEW: Telegram confirm to operator: "⏳ Queued: @<handle>"

Spare laptop, Chrome with IG open & logged in:
        Tampermonkey userscript (NEW, you write this)
        │
        ├─ Polls "IG DM Queue" sheet every ~15s via gviz CSV
        ├─ For each PENDING row:
        │    ├─ Random human-ish delay
        │    ├─ Open https://www.instagram.com/direct/t/<…>/ (resolved
        │    │    by navigating to https://ig.me/m/<handle>)
        │    ├─ Wait for message composer
        │    ├─ Type proposal_text into composer (real input events,
        │    │    not .textContent assignment — IG is React)
        │    ├─ Click Send
        │    └─ POST result to n8n status webhook (URL hardcoded)
        │
        └─ A new n8n webhook flow updates the queue sheet row
            and sends operator a Telegram ✅ / ❌ confirmation.
```

### Why this shape

- IG sees the operator's real residential IP and a real desktop Chrome with a
  long-established session. No datacenter IP, no headless fingerprint, no
  fresh login from a new geo. From IG's view it's a normal user clicking
  around their own DMs.
- Volume is low (5–20 DMs/day). Well below any rate threshold.
- Spare laptop sits at home, sleep prevented, Chrome always open. The browser
  doesn't need to be focused — IG runs fine in a background tab.

---

## What's already in place (the operator confirms before you start)

These are already deployed; you do **not** rebuild them. Verify they exist
when relevant; do not "improve" them.

- The repo you're in is `Slowz942/DASCHBOARD-RESA-LP2P`. It deploys
  `index.html` to GitHub Pages on push to `main`. Static, no build step.
- Existing Tampermonkey scraper for Discord:
  `userscript/discord-wts-scraper.user.js` — your new userscript should
  follow the same metadata-block patterns (`@connect *`, dedupe via
  `GM_setValue`/`GM_getValue`, menu commands for clear/pause/resend).
- n8n callback workflow (`n8n/callback-handler.js`) already produces a
  `proposal_text` and exposes `instagram` (the @ handle from Tally) on the
  `internal` payload of `buildProposalMessage()`. You will edit this flow
  in the n8n UI to add the queue-write step; the file in the repo is the
  Code-node body to mirror.
- Google Sheets are read by the dashboard via gviz CSV with
  "anyone with link can view" sharing. Same access model is fine for the
  new queue sheet (read by userscript via gviz, written by n8n via the
  Sheets node which uses the operator's existing Google credentials in n8n).
- Telegram bot token lives only in n8n. Don't ship it in the userscript.

### Sheet IDs (read-only context)

- Inventory: `1jSQNoni7qW6ShnRw3hi_g_fF90qn5YZ3koRaL1gYTLE`
- Sourcing Discord: `10QzZ14S4fA5zuM-UyROwmsIKLcwPata6cVLN23bukW8`
- CRM clients lp2p: ID configured inside n8n (operator can read it from
  the n8n Google Sheets node settings)

The new "IG DM Queue" sheet should live as a **new tab** inside the CRM
workbook (cohesive with operator workflow). The operator creates the tab
manually; you write the schema spec into the brief and they paste it.

---

## Conventions you must not break

These are the subset of `CLAUDE.md` that touches your work, plus a few
new ones specific to IG DM sending. Read `CLAUDE.md` for the rest.

1. **`@connect *`** in the userscript metadata block. Tampermonkey blocks
   cross-origin POSTs by default. Without this you cannot reach the n8n
   webhook from `instagram.com`.
2. **Dedupe via `GM_setValue`/`GM_getValue`** keyed by row id. The Discord
   scraper does the same — pattern is `seen_<id>: true`. Same menu commands
   for "clear seen / pause / resume".
3. **Three normalize-functions stay in sync** if you touch them. You
   probably won't need to here, but if any logic involves artist matching,
   do not introduce a fourth copy of `normalizeArtist`.
4. **Per-place pricing semantics.** Not your concern for the userscript —
   the `proposal_text` arrives already formatted from n8n. Do not parse and
   reformat it.
5. **Telegram callback 15s deadline.** Already handled in the existing
   workflow. Your queue-write step must run **after** `answerCallbackQuery`
   has fired, but **before** (or in parallel with) the operator confirm
   message. Don't reintroduce the 15s problem.
6. **No real secrets in repo.** The userscript will hardcode an n8n webhook
   URL (acts as a shared secret). Treat it like the Telegram bot token —
   the file in the repo holds a placeholder, the operator pastes the real
   URL locally and never commits it.

### IG-DM-specific gotchas (new)

7. **IG's web composer is a React contenteditable.** Setting `.textContent`
   or `.innerText` does not update React's internal state — the Send button
   stays disabled. Use `document.execCommand('insertText', false, text)` on
   the focused composer, OR dispatch an `InputEvent` with
   `inputType: 'insertText'` and `data: text`. Verify the Send button
   transitions to enabled before clicking.
8. **Wait for the composer to mount, not for a fixed delay.** IG SPA
   navigation is async. Use `MutationObserver` or a polling helper that
   resolves when `[role="textbox"][contenteditable="true"]` exists and is
   visible.
9. **Selectors via `aria-label` and `role`, not class names.** IG's CSS
   classes are obfuscated and rotate on every deploy. `aria-label="Message"`,
   `aria-label="Send"`, `role="textbox"`, `role="button"` are far more
   stable. Match locale: the operator's IG may be in French ("Message",
   "Envoyer") or English ("Message", "Send"). Read the live DOM once and
   handle both.
10. **`https://ig.me/m/<handle>` is the cleanest entry**: when logged in,
    it redirects to `instagram.com/direct/t/<thread-id>/` with the
    composer already mounted. Cheaper than navigating
    `instagram.com/<handle>/` and clicking "Message".
11. **Random delay between actions** (200–800ms typing, 1–3s between
    DMs). Don't burst. The operator's volume is low so this is generous.
12. **Cap DMs per hour** (e.g. 20/h). If exceeded, pause the queue and
    send the operator a Telegram alert. Better safe than soft-banned.
13. **Detect IG checkpoint screens.** If the URL contains `/challenge/` or
    a "We've detected unusual activity" modal appears, **STOP**. Pause the
    queue, send Telegram alert, do not retry. Resuming after a checkpoint
    requires the operator to interact with IG manually.
14. **Strip `@` from handle, lowercase it.** Tally answers may or may not
    include `@`; case is inconsistent. Normalize before navigating.
15. **Empty / malformed handle** → mark row ERROR, skip, continue.
    Never block the queue on a single bad row.

---

## Setup steps

Walk the operator through these. Do not assume the spare laptop's OS;
detect it (`process.platform`, or just ask) and adapt.

### Phase A — Spare laptop environment

1. **Prevent sleep.** Lid-closed sleep, idle sleep, display sleep — all off
   while plugged in. (The display can sleep; the OS must not.)
   - Windows: Settings → System → Power → Screen and sleep, set "When
     plugged in, put my device to sleep after" to "Never". Plus PowerToys
     "Awake" running in the tray as belt-and-suspenders.
   - macOS: `caffeinate -dimsu` in a terminal that stays open, OR Settings
     → Battery → Power Adapter → "Prevent automatic sleeping when display
     is off".
   - Linux: `systemd-inhibit --what=sleep --why="IG sender" sleep infinity`
     in a tmux session.
2. **Install Chrome.** (Firefox or Edge work but the userscript was
   designed against Chrome's behavior. Stick to Chrome unless there's a
   reason not to.)
3. **Install Tampermonkey** for Chrome.
4. **Log in to Instagram in Chrome.** This must be a normal interactive
   login the operator does themselves on this laptop. If IG asks for SMS /
   email verification because it's a new device, the operator completes it.
   Open IG once, browse for a few minutes, let the session "settle". Don't
   skip this — fresh logins from new devices are the highest-risk moment.
5. **Pin a tab to `https://www.instagram.com/`** so it's always present. The
   userscript will navigate it as needed.
6. **Clone the repo on this laptop too** if you want full project context:
   `git clone https://github.com/Slowz942/DASCHBOARD-RESA-LP2P.git`. The
   userscript file lives in `userscript/instagram-dm-sender.user.js` once
   you create it.

### Phase B — Queue infrastructure

The operator opens n8n in a browser (works from either laptop). You guide
them through:

1. **Create the queue tab.** In the CRM workbook, add a tab named
   `IG DM Queue` with these headers in row 1:

   ```
   id | ts | instagram_handle | proposal_text | status | sent_at | error
   ```

   `id` is a uuid or the n8n execution id; `ts` ISO timestamp; `status`
   is `PENDING`, `SENT`, or `ERROR`. Make the sheet "anyone with link
   can view".
2. **Edit the n8n callback workflow** to append a queue row after
   `Resolve match`. Use n8n's Google Sheets "Append" node mapped to the
   queue tab. Fields: `id` = `{{ $execution.id }}`, `ts` = `{{ $now.toISO() }}`,
   `instagram_handle` = `{{ $json.internal.instagram }}` stripped of `@`
   and lowercased (use a small Code node before the Sheets node if needed),
   `proposal_text` = `{{ $json.internal.proposal_text }}`, `status` =
   `PENDING`, leave `sent_at` and `error` blank.
3. **Replace the operator-facing `sendMessage`** at the end of the callback
   workflow with a confirmation: `⏳ Queued for IG: @{{handle}}` (keeps the
   operator in the loop without spoiling the proposal text in chat).
4. **Create a second n8n workflow** "IG queue status updater":
   - Webhook trigger: `POST /webhook/ig-status`. Body shape:
     `{ id, status: "SENT" | "ERROR", error?: string }`.
   - Google Sheets "Update Row" node: find row by `id`, set `status`,
     `sent_at`, `error`.
   - Telegram sendMessage to operator chat: `✅ DM sent to @{{handle}}` or
     `❌ DM failed @{{handle}}: {{error}}`.
   - Activate it. Note the production webhook URL — that's what the
     userscript will POST to.

### Phase C — Userscript (the meat)

Create `userscript/instagram-dm-sender.user.js`. Mirror the metadata block
style of `userscript/discord-wts-scraper.user.js`. Outline:

```js
// ==UserScript==
// @name         LP2P · Instagram DM Sender
// @namespace    https://github.com/Slowz942/DASCHBOARD-RESA-LP2P
// @version      0.1.0
// @description  Polls IG DM Queue sheet, sends DMs from operator's IG session
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// ==/UserScript==
```

Constants the operator pastes locally (placeholders in the committed
version):

```js
const QUEUE_CSV_URL = 'https://docs.google.com/spreadsheets/d/<CRM_SHEET_ID>/gviz/tq?tqx=out:csv&sheet=IG%20DM%20Queue';
const STATUS_WEBHOOK_URL = 'https://<n8n-host>/webhook/ig-status'; // operator pastes locally
const POLL_INTERVAL_MS = 15000;
const MAX_DMS_PER_HOUR = 20;
```

State and behavior:

- On script load: schedule first poll, register menu commands
  ("LP2P · Pause queue", "LP2P · Resume queue", "LP2P · Clear seen IDs",
  "LP2P · Send last queued now").
- Poll loop:
  - GET `QUEUE_CSV_URL`, parse CSV, find rows with `status === 'PENDING'`
    and `id` not in seen set (`GM_getValue('seen_<id>')`).
  - For each, queue locally; the loop processes one at a time with
    randomized inter-DM delay.
  - Before processing, check the hourly cap. If exceeded, alert and pause.
- Send-DM routine:
  - Detect IG checkpoint (`location.pathname.startsWith('/challenge')`,
    or any modal with text matching `/unusual activity|verify it's you/i`).
    If detected: pause queue, POST to status webhook with
    `status: 'ERROR', error: 'IG_CHECKPOINT'`, alert operator.
  - Navigate to `https://ig.me/m/<handle>` via `location.href` assignment.
    Wait for redirect to `/direct/t/<thread>/`.
  - Wait for composer (`role="textbox"` and `contenteditable="true"`) to
    mount (use a polling helper `waitFor(selector, timeoutMs)`).
  - Focus composer. Insert text via `document.execCommand('insertText',
    false, text)`. Verify text actually landed in the DOM (compare
    composer's `textContent` to expected).
  - Wait briefly for the Send button (`role="button"`,
    `aria-label="Send" | "Envoyer"`) to become enabled. Click it.
  - Verify the message appears in the thread (poll for a sent-message
    bubble matching the text). On verification success: POST status
    webhook with `SENT`. On failure (composer never mounted, send button
    never enabled, message never appeared): POST `ERROR` with diagnostic.
  - Mark row in `seen_<id>` regardless of outcome (avoid re-sending).
- Persistent UI: a small fixed-position badge in the corner showing
  current state (idle / sending / paused / error), recent activity log.
  Useful for the operator glancing at the laptop.

### Phase D — Test

1. Operator manually appends a test row to the IG DM Queue sheet:
   `id=test-1, instagram_handle=<a-test-account-the-operator-controls>,
   proposal_text="Test ping from LP2P sender, ignore."`,
   `status=PENDING`.
2. Within ~15s the script picks it up, navigates, types, sends.
3. Operator verifies the message arrived in the test account.
4. Operator checks the sheet row updated to `SENT`.
5. Operator checks they received a Telegram `✅ DM sent` message.

If any step fails, debug from the userscript's persistent log + browser
DevTools console (the script should log every state transition with a
`[LP2P-IG]` prefix).

Then run a real demand end-to-end: trigger a Tally form, tap an option in
Telegram, watch the queue row appear, watch the DM go out.

---

## Anti-ban discipline (do not relax these)

- **Don't burst.** Min 1.5s between DMs even if multiple are queued.
- **Don't over-poll.** 15s is fine. 5s is twitchy. 2s looks like a bot.
- **Don't navigate-and-type on the same tab the operator is using.** The
  script should claim its own tab (or window). If the operator is mid-DM
  on the active tab, queue work waits.
- **Hourly cap.** 20/h hard limit. If hit, pause and alert.
- **Stop on checkpoints.** No retries, no clever workarounds. Operator
  intervenes, then resumes via menu.
- **Don't add features beyond what's specified here without explicit
  approval.** Each new automation surface widens the ban exposure.

---

## Verification checklist (run before declaring done)

- [ ] Spare laptop does not sleep when lid closed (test: close lid for
      5 min, ssh in or check from another device that script is still
      polling)
- [ ] Chrome auto-starts on boot with IG tab open and logged in
- [ ] Tampermonkey + userscript installed
- [ ] Userscript constants pasted with real URLs locally; placeholder in
      the committed file
- [ ] Queue sheet exists with correct columns and shared correctly
- [ ] n8n callback workflow appends rows on operator option-tap
- [ ] n8n status updater workflow active
- [ ] End-to-end test row sends successfully and round-trips status
- [ ] Real demand goes through end-to-end at least once
- [ ] Hourly cap and checkpoint pause both manually triggered and
      observed working

---

## When in doubt

- Read `CLAUDE.md` first for project conventions.
- Read `userscript/discord-wts-scraper.user.js` for the userscript pattern
  the operator already trusts.
- Ask the operator before introducing new dependencies, new external
  services, or new browser permissions.
- Default to "stop and ask" rather than "send a possibly-wrong DM to a
  client". A stuck queue is recoverable; a wrong DM to a paying customer
  is not.
