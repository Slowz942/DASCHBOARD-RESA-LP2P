# n8n flow setup — Discord WTS → Anthropic → Sourcing Sheet

This wires the Tampermonkey userscript's webhook into a 3-node n8n flow that
parses each Discord WTS post via Claude Haiku and writes structured listings
to a new Google Sheet, ready for the dashboard to match against demands.

## Architecture

```
Userscript (Tampermonkey)
       │  POST { messages: [{id, author, content, timestamp}, ...] }
       ▼
[Webhook]  →  [Code: Parse via Claude]  →  [Google Sheets: Append/Update]
```

The Code node calls the Anthropic Messages API once per Discord message, gets
back a JSON array of listings, and emits one n8n item per listing. The Sheets
node appends each row, using `listing_id` as the dedupe key.

---

## 1. Create the Google Sheet

Make a brand-new spreadsheet (don't reuse the inventory or CRM sheets).

**Tab name:** `Sheet1`
**Row 1 (headers, exact case, in this order):**

```
listing_id | seller_handle | seller_id | artist | event_date_iso | event_label | category | quantity | price_per_unit | price_total | block | notes | message_id | raw_message | posted_at | scraped_at | status
```

The `status` column at the end is for **you** to color-code, mirroring the
inventory pattern:

| Cell color on `status` | Meaning |
|---|---|
| Red `#ff0000` | Available (default for new rows) |
| Green `#00ff00` | Already taken / sold out |
| Purple | "à acheter" later |

The dashboard will read `status` cell colors via Apps Script (Phase 3) and
exclude greens from matching.

**Share:** File → Share → "Anyone with the link → Viewer" so the dashboard
can read via gviz CSV.

Copy the spreadsheet ID from the URL — you'll paste it in steps 3 and 5.

---

## 2. Set the Anthropic API key in n8n

1. n8n → **Settings → Variables** (or the **Credentials** screen, depending on
   your version).
2. Add a variable named `ANTHROPIC_API_KEY` with your key from
   https://console.anthropic.com/settings/keys.

If your n8n version doesn't expose `$env`, store the key as an HTTP credential
with header `x-api-key` instead and reference it in step 4 — see the comments
in `parse-via-claude.js` for the alternative call pattern.

---

## 3. Create a new n8n workflow

Name it: **Discord WTS Sourcing**

Add three nodes in order (copy the exact configuration below).

### Node A — Webhook (trigger)

- **Type:** Webhook
- **HTTP Method:** POST
- **Path:** `discord-wts` (or whatever you want — n8n will give you the URL)
- **Response Mode:** "Last Node"
- **Response Code:** 200

After you save and activate the workflow, n8n shows two URLs (test + production).
**Copy the production URL** — you'll paste it in step 6.

### Node B — Code (Parse via Claude)

- **Type:** Code
- **Mode:** Run Once for All Items
- **Language:** JavaScript
- **Code:** paste the contents of [`n8n/parse-via-claude.js`](./parse-via-claude.js)

⚠️ **One manual step inside the JS:** at the top of the file, replace the
placeholder

```js
const SYSTEM_PROMPT = `<<< paste contents of n8n/system-prompt.txt here >>>`;
```

with the full contents of [`n8n/system-prompt.txt`](./system-prompt.txt) wrapped
in backticks. (You can keep it as a single template literal — backticks support
multiline.)

### Node C — Google Sheets (Append or Update Row)

- **Type:** Google Sheets
- **Resource:** Sheet Within Document
- **Operation:** Append or Update Row
- **Document:** the new sourcing sheet you created in step 1
- **Sheet:** Sheet1
- **Mapping Column Mode:** Map Each Column Manually
- **Column to match on:** `listing_id`
- **Values to Send** — map every header to the corresponding `$json` field:

| Column | Value |
|---|---|
| `listing_id` *(match)* | `{{ $json.listing_id }}` |
| `seller_handle` | `{{ $json.seller_handle }}` |
| `seller_id` | `{{ $json.seller_id }}` |
| `artist` | `{{ $json.artist }}` |
| `event_date_iso` | `{{ $json.event_date_iso }}` |
| `event_label` | `{{ $json.event_label }}` |
| `category` | `{{ $json.category }}` |
| `quantity` | `{{ $json.quantity }}` |
| `price_per_unit` | `{{ $json.price_per_unit }}` |
| `price_total` | `{{ $json.price_total }}` |
| `block` | `{{ $json.block }}` |
| `notes` | `{{ $json.notes }}` |
| `message_id` | `{{ $json.message_id }}` |
| `raw_message` | `{{ $json.raw_message }}` |
| `posted_at` | `{{ $json.posted_at }}` |
| `scraped_at` | `{{ $json.scraped_at }}` |

(Don't map `status` — leave it blank so you can fill the cell color manually.)

Connect: **Webhook → Parse via Claude → Append to Sheet**.

---

## 4. Activate the workflow

Toggle the **Active** switch in the top-right. n8n turns the production URL
on (it's off while inactive — that's why testing uses the test URL).

---

## 5. Swap the Tampermonkey webhook URL

You're currently pointing the userscript at `https://webhook.site/...`. Swap it
to the n8n production URL:

1. Tampermonkey dashboard → LP2P script → **Editor** tab.
2. Find the line you added earlier:
   ```js
   GM_setValue('lp2p_wts_webhook', 'https://webhook.site/e8d21262-...');
   ```
3. Replace the URL with your n8n production URL (something like
   `https://your-n8n.example.com/webhook/discord-wts`).
4. Save (Ctrl+S).
5. Reload the Discord WTS tab.

The userscript will start posting every new WTS message to n8n, which feeds
the LLM, which writes structured rows to the sheet.

You can leave the `GM_setValue` line in place — it just overwrites the storage
on every page load with the same value, which is fine.

---

## 6. Verify it's working

After reloading the Discord WTS tab:

1. n8n → Executions tab. New entries should appear with each batch from the
   userscript.
2. Open the Sourcing Discord sheet. New rows should arrive with the parsed
   listings (one row per (artist × date × category × price) tuple — multi-event
   posts produce many rows).
3. If a row's `artist` is `PARSE_ERROR`, the LLM call failed for that message.
   The full Discord message is preserved in `raw_message` so you can inspect
   what went wrong.

---

## What's next (Phase 3)

Once data is flowing into the sheet, the dashboard work:

1. Apps Script for the new sheet (mirrors `google-apps-script/Code.gs`) so the
   dashboard sees the `status` cell colors.
2. `index.html` changes:
   - New `EXTERNAL_SOURCING_SHEET_ID` constant + `syncExternalSourcing()` poller.
   - `findMatches()` augmented to consider Discord listings alongside inventory.
   - Match panel renders Discord items with a "Source: Discord · @seller"
     badge instead of the EN STOCK pill, and uses the seller's price as the
     buy_price for the markup calculation.

That lands as a separate commit on `feature/discord-sourcing` once you confirm
the sheet is filling up.
