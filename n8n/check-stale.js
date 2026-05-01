/**
 * n8n Code node — runs every 15 min from a Schedule Trigger.
 *
 * Input: every row from the `Heartbeats` tab (Google Sheets "Read" node).
 * Each row: { source, last_seen, version, alert_state, last_alert_at, notes }.
 *
 * For each row, decide the action by comparing freshness vs. current
 * `alert_state`. We only emit on STATE TRANSITIONS — that way the operator
 * gets one alert when something goes silent and one alert when it comes
 * back, not a stale-spam every 15 min.
 *
 *   stale   && alert_state === 'OK'    → action 'alert_stale'      (transition)
 *   !stale  && alert_state === 'STALE' → action 'alert_recovered'  (transition)
 *   otherwise                          → action 'noop'             (filtered out)
 *
 * Threshold: 15 min. The userscript heartbeats every 5 min, so two missed
 * heartbeats = stale. One missed heartbeat is still fine (three-strikes
 * buffer per the migration brief).
 *
 * Output: one item per row with everything downstream nodes need:
 *   - source         row identifier (matches the Sheets `source` column)
 *   - action         alert_stale | alert_recovered | noop
 *   - alert_state    next state to write back (STALE or OK)
 *   - last_alert_at  ISO now (written back when the alert fires)
 *   - since          ISO of last_seen (or 'never') for the alert text
 *   - text           prebuilt Telegram message body
 *
 * Wired up like:   Schedule  →  Sheets Read  →  this Code node
 *                  →  IF (action != 'noop', "Convert types" ON)
 *                  →  Switch (alert_stale | alert_recovered)
 *                  →  Telegram sendMessage  →  Sheets Update Row
 */

const STALE_THRESHOLD_MS = 15 * 60 * 1000;
const now = Date.now();
const nowIso = new Date(now).toISOString();

const out = [];

for (const item of $input.all()) {
  const row = item.json || {};
  const source = (row.source || '').trim();
  if (!source) continue;

  const lastSeenMs = row.last_seen ? Date.parse(row.last_seen) : 0;
  const isStale = !lastSeenMs || (now - lastSeenMs) > STALE_THRESHOLD_MS;
  const since = lastSeenMs ? new Date(lastSeenMs).toISOString() : 'never';
  const alertState = ((row.alert_state || 'OK') + '').trim().toUpperCase();

  let action = 'noop';
  let nextState = alertState;
  let text = '';

  if (isStale && alertState === 'OK') {
    action = 'alert_stale';
    nextState = 'STALE';
    text = '🚨 ' + source + ' silent for >15 min (last seen ' + since + ').';
  } else if (!isStale && alertState === 'STALE') {
    action = 'alert_recovered';
    nextState = 'OK';
    text = '✅ ' + source + ' back online.';
  }

  out.push({
    json: {
      source,
      action,
      alert_state: nextState,
      last_alert_at: nowIso,
      since,
      text,
    },
  });
}

return out;
