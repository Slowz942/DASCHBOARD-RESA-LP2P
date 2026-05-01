/**
 * n8n Code node — runs once per heartbeat POST.
 *
 * Input (from the webhook): the userscript posts JSON like
 *   { source, ts, channel_id, version, messages_visible, seen_count,
 *     auto_scroll, recovered_from? }
 *
 * The webhook node wraps the body under `data.body` (see CLAUDE.md gotcha
 * #11). We tolerate either shape so the same code handles direct piping
 * during dev too.
 *
 * Output: a single flat object the downstream Google Sheets "Update Row"
 * node consumes to update the matching row in the `Heartbeats` tab. The
 * Sheets node matches on the `source` column and writes:
 *   - last_seen  ← ts (ISO from the userscript)
 *   - version    ← userscript version (e.g. "0.2.0")
 *   - notes      ← concise diag string (msgs/seen/autoscroll/recovered_from)
 *
 * Wired up like:   Webhook  →  this Code node  →  Sheets Update Row  →  Respond 200
 */

const data = $input.first().json;
const body = data && data.body ? data.body : data;

const source = body.source || 'unknown';
const ts = body.ts || new Date().toISOString();
const version = body.version || '';

const noteParts = [];
if (body.messages_visible !== undefined) noteParts.push('msgs=' + body.messages_visible);
if (body.seen_count !== undefined) noteParts.push('seen=' + body.seen_count);
if (body.auto_scroll !== undefined) noteParts.push('autoscroll=' + body.auto_scroll);
if (body.recovered_from) noteParts.push('recovered_from=' + body.recovered_from);

return [{
  json: {
    source,
    last_seen: ts,
    version,
    notes: noteParts.join(' '),
  },
}];
