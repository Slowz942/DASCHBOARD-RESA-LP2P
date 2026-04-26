/**
 * n8n Code node — runs once per webhook invocation.
 *
 * EDIT JUST ONE LINE: replace PASTE_YOUR_ANTHROPIC_KEY_HERE below with your
 * actual key from https://console.anthropic.com/settings/keys. Then paste
 * the entire file into the Code node.
 */

// >>> EDIT THIS ONE LINE WITH YOUR ANTHROPIC API KEY (starts with sk-ant-) <<<
const ANTHROPIC_API_KEY = 'PASTE_YOUR_ANTHROPIC_KEY_HERE';

// Use a fully-versioned ID for maximum compatibility across Anthropic plans.
// Other valid options to try if this 400s:
//   'claude-3-5-haiku-latest'
//   'claude-haiku-4-5-20250115'
//   'claude-3-haiku-20240307'  (older fallback)
const MODEL = 'claude-3-5-haiku-20241022';

const SYSTEM_PROMPT = `You are a parser for WTS (Want To Sell) ticket posts on Discord, written in French, English, or a mix. Given the message content, extract every individual ticket listing into a JSON array. Each entry represents one (artist, date, category, quantity, price) tuple.

Schema for each entry:
{
  "artist": string (uppercased canonical artist name, e.g. "BAD BUNNY", "CELINE DION", "JUL", "AYA NAKAMURA", "THE WEEKND", "BRUNO MARS", "PLK", "DAMSO", "TAME IMPALA", "BTS", "HAMZA", "DAVID GUETTA", "CHARLIE PUTH", "PINKPANTHERESS", "FALLY IPUPA", "HARRY STYLES", "ARIANA GRANDE", "WERENOI", "JOSMAN", "THEODORA", "ROMY", "DRAKE", "TRAVIS SCOTT", "L2B", "LAMANO", "SOLIDAYS", "NEIGHBERHOOD", "LES ARDENTES" — or "NC" if no artist mentioned),
  "event_date_iso": string or null (YYYY-MM-DD; today is the message timestamp's date; year defaults to current 2026 if omitted, or 2027 if the date would otherwise be in the past),
  "event_label": string (free-form date/venue label as written, e.g. "29/05" or "Stade de France 12/07" or "Marseille"),
  "category": string (must be exactly one of: FOSSE, FOSSE OR, CARRE OR, CAT 1, CAT 2, CAT 3, CAT 4, CAT 5, CAT OR, VIP, PARTERRE, PARTERRE DIAMANT, TRIBUNE OR, PELOUSE, PELOUSE OR, GRADIN, DISCO, SQUARE, CIRCLE, ANNEX, NC),
  "quantity": integer (parse "x2"=2, "duo"=2, "trio"=3, "quatuor"=4, "solo"=1, defaults to 1),
  "price_per_unit": number (in EUR; "350 each", "350/place", "@350", "350/u", "350 ea" all = 350),
  "price_total": number or null (only when message says "all", "total" — and the per-unit price = total / quantity),
  "block": string or null (e.g. "Bloc D4, Rang 19" or "Section 406 rang T seat 591"),
  "notes": string (any extra info like "CS", "compte fourni", "retail", "TM", negociation hints; empty string if none)
}

Rules:
- One message can produce many entries. Multi-event posts are common (e.g. "AYA 29/05 + THE WEEKND 08/07 + ...").
- If the artist is not stated explicitly anywhere in the message, set "artist": "NC".
- If "Solo", "Duo", "Trio", "Quatuor" appear with no integer prefix, treat as quantity 1, 2, 3, 4 respectively.
- "x2/x4 ..." or "x10 multiple options" → use the smaller / explicit number; if multiple distinct quantities are listed for the same configuration, output one entry per (quantity, price) pair.
- French months: janvier, février/fevrier, mars, avril, mai, juin, juillet, août/aout, septembre, octobre, novembre, décembre/decembre.
- "350 each", "350/each", "@350", "350 ea", "350/place", "350/u" → price_per_unit=350, price_total=null.
- "350 all", "350 total", "1000 all" → price_total=350 (or 1000), and price_per_unit = round(total / quantity).
- "retail" or no price → price_per_unit=0 and notes="retail".
- "PARTERRE DIAMANT" specifically — keep it as a single category string, never split.
- "CAT 1 PARTERRE", "CAT 1 GRADIN" — extract the CAT N as category, append the location to notes.
- Output ONLY the JSON array. No prose. No markdown code fences. Nothing else.
- If you cannot extract any listing, return [].

Examples:

Input: "WTS Tame Impala Paris 3 mai\\nCat1 Bloc N lower\\nx2 160€ each"
Output: [{"artist":"TAME IMPALA","event_date_iso":"2026-05-03","event_label":"3 mai Paris","category":"CAT 1","quantity":2,"price_per_unit":160,"price_total":null,"block":"Bloc N lower","notes":""}]

Input: "WTS BAD BUNNY (01/07/2026) :\\nx2 CAT 2 CS (Bloc L, Rang 63) - 225€ each"
Output: [{"artist":"BAD BUNNY","event_date_iso":"2026-07-01","event_label":"01/07/2026","category":"CAT 2","quantity":2,"price_per_unit":225,"price_total":null,"block":"Bloc L, Rang 63","notes":"CS"}]

Input: "WTS CELINE DION\\n(16/09 Paris) :\\n-x4 Parterre Assis Prestige normal, Entrée K, Rang 15, 2250 each\\n-x2 Tribune Or Parterre normal, Entrée T, Rang 112, 1350 each\\n\\n(25/09 Paris) :\\n-x2 Catégorie 1 Parterre Allée normal, Entrée P, Rang 72, 1050 each"
Output: [
  {"artist":"CELINE DION","event_date_iso":"2026-09-16","event_label":"16/09 Paris","category":"PARTERRE","quantity":4,"price_per_unit":2250,"price_total":null,"block":"Entrée K, Rang 15","notes":"Parterre Assis Prestige"},
  {"artist":"CELINE DION","event_date_iso":"2026-09-16","event_label":"16/09 Paris","category":"TRIBUNE OR","quantity":2,"price_per_unit":1350,"price_total":null,"block":"Entrée T, Rang 112","notes":"Tribune Or Parterre"},
  {"artist":"CELINE DION","event_date_iso":"2026-09-25","event_label":"25/09 Paris","category":"CAT 1","quantity":2,"price_per_unit":1050,"price_total":null,"block":"Entrée P, Rang 72","notes":"Parterre Allée"}
]

Input: "WTS BAD BUNNY \\nMarseille \\nDuo Cat or allee 380€ each \\nAriana grande \\nDate du 16 août : \\nSolo Section 406 rang T seat 591 375€ each \\nBts :\\n17/07\\nQuatuor cat 1 300€ each \\n18/07\\n12 fosse 240€ each \\nQuatuor cat 1 300€ each \\nAll première main"
Output: [
  {"artist":"BAD BUNNY","event_date_iso":null,"event_label":"Marseille","category":"CAT OR","quantity":2,"price_per_unit":380,"price_total":null,"block":"allée","notes":"première main"},
  {"artist":"ARIANA GRANDE","event_date_iso":"2026-08-16","event_label":"16 août","category":"NC","quantity":1,"price_per_unit":375,"price_total":null,"block":"Section 406 rang T seat 591","notes":"première main"},
  {"artist":"BTS","event_date_iso":"2026-07-17","event_label":"17/07","category":"CAT 1","quantity":4,"price_per_unit":300,"price_total":null,"block":null,"notes":"première main"},
  {"artist":"BTS","event_date_iso":"2026-07-18","event_label":"18/07","category":"FOSSE","quantity":12,"price_per_unit":240,"price_total":null,"block":null,"notes":"première main"},
  {"artist":"BTS","event_date_iso":"2026-07-18","event_label":"18/07","category":"CAT 1","quantity":4,"price_per_unit":300,"price_total":null,"block":null,"notes":"première main"}
]

Input: "WTS \\nDion\\n 18/09\\n•⁠  ⁠Catégorie 1 Gradin : Bloc 418 — Rang 49 (x2) 1000 all\\n 23/09\\n•⁠  ⁠Parterre Diamant Allée : Bloc E — Rang 63 (x2) 1600 all\\n\\nTake all 2k5 (Fast deal) +50 refs"
Output: [
  {"artist":"CELINE DION","event_date_iso":"2026-09-18","event_label":"18/09","category":"CAT 1","quantity":2,"price_per_unit":500,"price_total":1000,"block":"Bloc 418 — Rang 49","notes":"Gradin"},
  {"artist":"CELINE DION","event_date_iso":"2026-09-23","event_label":"23/09","category":"PARTERRE DIAMANT","quantity":2,"price_per_unit":800,"price_total":1600,"block":"Bloc E — Rang 63","notes":"Allée; bundle 2k5 si take all"}
]

Input: "WTS DAMSO MARSEILLE ce soir \\nx 2 cat. 1 - 50€ ea"
Output: [{"artist":"DAMSO","event_date_iso":null,"event_label":"Marseille ce soir","category":"CAT 1","quantity":2,"price_per_unit":50,"price_total":null,"block":null,"notes":""}]

Input: "WTS SOLIDAYS\\n2× pass 3J, 100€ each"
Output: [{"artist":"SOLIDAYS","event_date_iso":null,"event_label":"pass 3J","category":"NC","quantity":2,"price_per_unit":100,"price_total":null,"block":null,"notes":"pass 3 jours"}]

Now extract listings from the message that follows. Output ONLY the JSON array.`;

if (ANTHROPIC_API_KEY === 'PASTE_YOUR_ANTHROPIC_KEY_HERE') {
  throw new Error('Anthropic API key not set. Edit the ANTHROPIC_API_KEY constant at the top of the Code node.');
}

const out = [];
const data = $input.first().json;

// n8n's Webhook node wraps the POST body under `body`. Fall back to top-level
// in case the user wires this Code node directly to mock data without the
// webhook wrapper.
const payload = (data && typeof data.body === 'object' && data.body) ? data.body : data;

// Webhook payload: { source, channel_id, scraped_at, messages: [{ id, author, authorId, content, timestamp }, ...] }
const messages = Array.isArray(payload.messages) ? payload.messages : [];
if (messages.length === 0) {
  // Surface the actual input shape so it's obvious what went wrong instead of
  // silently producing nothing.
  return [{
    json: {
      seller_handle: '',
      seller_id: '',
      artist: 'NO_MESSAGES_IN_INPUT',
      event_date_iso: null,
      event_label: '',
      category: 'NC',
      quantity: 0,
      price_per_unit: 0,
      price_total: null,
      block: null,
      notes: 'Input had no messages array. Top-level keys: ' + Object.keys(data || {}).join(', ') +
             '; body keys: ' + (data && data.body ? Object.keys(data.body).join(', ') : '(no body)'),
      message_id: '',
      listing_id: 'no_messages_' + Date.now(),
      raw_message: JSON.stringify(data).substring(0, 400),
      posted_at: '',
      scraped_at: new Date().toISOString(),
    },
  }];
}

for (const msg of messages) {
  const content = (msg.content || '').trim();
  if (!content) continue;

  let listings = [];
  let resp;
  let apiErrorDetail = null;
  try {
    resp = await this.helpers.httpRequest({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: {
        model: MODEL,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      },
      json: true,
    });
  } catch (err) {
    // Surface every plausible location an HTTP client might park the response
    // body. n8n has shipped both got and axios under the hood across versions
    // and the error shape differs each time.
    const dig = (e) => {
      if (!e) return null;
      const candidates = [
        e?.response?.body, e?.response?.data, e?.response?.text,
        e?.cause?.response?.body, e?.cause?.response?.data,
        e?.body, e?.data, e?.responseBody,
        e?.context?.body, e?.context?.data,
      ];
      for (const c of candidates) {
        if (c !== undefined && c !== null && c !== '') return c;
      }
      return null;
    };
    const body = dig(err);
    apiErrorDetail =
      'HTTP exception | model=' + MODEL +
      ' | message=' + (err?.message || String(err)).substring(0, 200) +
      ' | err_keys=' + Object.keys(err || {}).join(',') +
      ' | status=' + (err?.statusCode || err?.response?.statusCode || err?.cause?.statusCode || 'n/a') +
      ' | body=' + (body ? (typeof body === 'string' ? body : JSON.stringify(body)).substring(0, 800) : '(no body)');
  }

  // If the response doesn't have the expected content array, treat it as an API error
  // and surface it as a row instead of silently dropping the listing.
  if (!apiErrorDetail && (!resp || !Array.isArray(resp.content) || resp.content.length === 0)) {
    apiErrorDetail = 'Unexpected Anthropic response shape: ' + JSON.stringify(resp).substring(0, 400);
  }

  if (!apiErrorDetail) {
    try {
      const text = resp.content[0]?.text || '[]';
      const cleaned = text
        .replace(/^\s*```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '')
        .trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        listings = parsed;
      } else {
        apiErrorDetail = 'Claude returned non-array: ' + cleaned.substring(0, 200);
      }
    } catch (err) {
      apiErrorDetail = 'JSON.parse failed on Claude output: ' + (err.message || String(err)) +
        ' | raw=' + (resp?.content?.[0]?.text || '').substring(0, 200);
    }
  }

  if (apiErrorDetail) {
    out.push({
      json: {
        seller_handle: msg.author || '',
        seller_id: msg.authorId || '',
        artist: 'PARSE_ERROR',
        event_date_iso: null,
        event_label: '',
        category: 'NC',
        quantity: 1,
        price_per_unit: 0,
        price_total: null,
        block: null,
        notes: apiErrorDetail,
        message_id: msg.id || '',
        listing_id: (msg.id || '') + '_err',
        raw_message: content,
        posted_at: msg.timestamp || '',
        scraped_at: payload.scraped_at || new Date().toISOString(),
      },
    });
    continue;
  }

  // Empty list = LLM judged this message had no valid listing. Emit a "no_listing"
  // row so we at least see the message in the sheet (helpful for tuning the prompt).
  if (listings.length === 0) {
    out.push({
      json: {
        seller_handle: msg.author || '',
        seller_id: msg.authorId || '',
        artist: 'NO_LISTING',
        event_date_iso: null,
        event_label: '',
        category: 'NC',
        quantity: 1,
        price_per_unit: 0,
        price_total: null,
        block: null,
        notes: 'Claude returned empty array',
        message_id: msg.id || '',
        listing_id: (msg.id || '') + '_empty',
        raw_message: content,
        posted_at: msg.timestamp || '',
        scraped_at: payload.scraped_at || new Date().toISOString(),
      },
    });
    continue;
  }

  listings.forEach((listing, idx) => {
    out.push({
      json: {
        seller_handle: msg.author || '',
        seller_id: msg.authorId || '',
        artist: (listing.artist || 'NC').toString().toUpperCase(),
        event_date_iso: listing.event_date_iso || null,
        event_label: listing.event_label || '',
        category: (listing.category || 'NC').toString().toUpperCase(),
        quantity: Number(listing.quantity) || 1,
        price_per_unit: Number(listing.price_per_unit) || 0,
        price_total: listing.price_total != null ? Number(listing.price_total) : null,
        block: listing.block || null,
        notes: listing.notes || '',
        message_id: msg.id || '',
        listing_id: (msg.id || '') + '_' + idx,
        raw_message: content,
        posted_at: msg.timestamp || '',
        scraped_at: payload.scraped_at || new Date().toISOString(),
      },
    });
  });
}

return out;
