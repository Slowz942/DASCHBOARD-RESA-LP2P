/**
 * n8n Code node — runs once per webhook invocation.
 * Splits incoming Discord messages, calls Claude Haiku for each, expands the
 * returned listings into one row per (artist, date, category, quantity, price).
 *
 * Pre-reqs in the n8n instance:
 *   - Set the environment variable ANTHROPIC_API_KEY in n8n's settings.
 *   - The system prompt is in this same folder (n8n/system-prompt.txt). Paste
 *     the entire contents into the SYSTEM_PROMPT constant below.
 *
 * Wired up like:   Webhook  →  this Code node  →  Google Sheets (Append/Update)
 */

const SYSTEM_PROMPT = `<<< paste contents of n8n/system-prompt.txt here >>>`;

const out = [];
const data = $input.first().json;

// The webhook payload is shaped like:
// { source, channel_id, scraped_at, messages: [{ id, author, authorId, content, timestamp }, ...] }
const messages = Array.isArray(data.messages) ? data.messages : [];
if (messages.length === 0) return out;

const apiKey = $env.ANTHROPIC_API_KEY;
if (!apiKey) {
  throw new Error('ANTHROPIC_API_KEY env var is not set in n8n. Settings → Variables → add it.');
}

for (const msg of messages) {
  const content = (msg.content || '').trim();
  if (!content) continue;

  let listings = [];
  try {
    const resp = await this.helpers.httpRequest({
      method: 'POST',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: {
        model: 'claude-haiku-4-6',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      },
      json: true,
    });

    const text = resp?.content?.[0]?.text || '[]';
    const cleaned = text
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) listings = parsed;
  } catch (err) {
    // Don't blow up the whole batch on one bad message — emit a placeholder row instead
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
        notes: 'Claude parse error: ' + (err.message || String(err)),
        message_id: msg.id || '',
        listing_id: (msg.id || '') + '_err',
        raw_message: content,
        posted_at: msg.timestamp || '',
        scraped_at: data.scraped_at || new Date().toISOString(),
      },
    });
    continue;
  }

  // Empty list = couldn't parse a real listing. Skip silently (LLM judged the message
  // didn't contain enough info — better than fake rows).
  if (listings.length === 0) continue;

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
        // listing_id makes appendOrUpdate idempotent: same message re-sent won't duplicate
        listing_id: (msg.id || '') + '_' + idx,
        raw_message: content,
        posted_at: msg.timestamp || '',
        scraped_at: data.scraped_at || new Date().toISOString(),
      },
    });
  });
}

return out;
