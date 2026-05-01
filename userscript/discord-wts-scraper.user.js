// ==UserScript==
// @name         LP2P · Discord WTS scraper
// @namespace    lp2p
// @version      0.2.0
// @description  Forwards new WTS posts in your community's #wts channel to your n8n webhook for sourcing. Includes auto-scroll, disconnect-recover, and a 5-min heartbeat for unattended operation.
// @author       LP2P
// @match        https://discord.com/channels/1182738991943008387/1201954119804264458*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      n8n.cloud
// @connect      app.n8n.cloud
// @connect      webhook.site
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Setup:
 *   1. Open Discord in Chrome and pin the WTS channel as a tab.
 *   2. Tampermonkey menu → "LP2P · Set webhook URL" → paste your n8n webhook
 *      (or https://webhook.site/<id> while testing).
 *   3. Tampermonkey menu → "LP2P · Set heartbeat URL" → paste the n8n
 *      heartbeat webhook so the watchdog can detect silent failures.
 *   4. Reload the channel; the script auto-scans and forwards every WTS message
 *      it sees (deduped by Discord message ID).
 *
 * What it does:
 *   - Watches the message list with a MutationObserver while you have the
 *     channel open. No API calls, no token usage, no automation of your account.
 *   - For each new message that looks like a WTS post (matches /wts|vds|vends|sell/i),
 *     extracts { id, author, authorId, content, timestamp } and POSTs them
 *     in batches to your webhook.
 *   - Stores seen message IDs in Tampermonkey storage so reloading the channel
 *     doesn't re-send messages you've already forwarded.
 *   - Auto-scrolls the channel to the bottom every 30s so Discord's virtualized
 *     list keeps mounting new messages even if scroll position drifts.
 *   - Detects Discord disconnect banners and reloads the page if the
 *     condition persists ≥60s (max one reload per 10 minutes).
 *   - Posts a heartbeat to the heartbeat URL every 5 minutes (plus one on
 *     startup) so a downstream watchdog can alert if this scraper goes silent.
 *
 * Tampermonkey menu commands:
 *   - "LP2P · Set webhook URL"        set / change the WTS webhook target
 *   - "LP2P · Set heartbeat URL"      set / change the heartbeat webhook target
 *   - "LP2P · Show status"            webhook + heartbeat + state stats
 *   - "LP2P · Re-send last visible"   forget seen-IDs and resend everything currently rendered
 *   - "LP2P · Clear seen IDs"         wipe the dedupe cache (use if testing)
 *   - "LP2P · Toggle WTS-only filter" off = forward every message (debug)
 *   - "LP2P · Pause auto-scroll"      toggle auto-scroll on/off (debug)
 */

(() => {
    'use strict';

    const CHANNEL_ID = '1201954119804264458';
    const STORE = 'lp2p_wts_';
    const SEEN_CAP = 2000;
    const VERSION = '0.2.0';
    const HEARTBEAT_MS = 5 * 60 * 1000;          // POST heartbeat every 5 min
    const FIRST_HEARTBEAT_DELAY_MS = 3000;       // also fire one ~3s after load
    const AUTO_SCROLL_MS = 30 * 1000;            // scroll-to-bottom every 30s
    const DISCONNECT_CHECK_MS = 30 * 1000;       // poll for disconnect banner every 30s
    const DISCONNECT_THRESHOLD_MS = 60 * 1000;   // sustained ≥60s → reload
    const RELOAD_THROTTLE_MS = 10 * 60 * 1000;   // ≤ 1 reload per 10 min
    const DISCONNECT_SELECTORS = [
        '[class*="connectionStatus"][class*="offline"]',
        '[role="status"][aria-live]',
    ];

    // ---- storage helpers -------------------------------------------------
    const get = (k, def) => GM_getValue(STORE + k, def);
    const set = (k, v) => GM_setValue(STORE + k, v);
    const getSeen = () => new Set(get('seen', []));
    const addSeen = (ids) => {
        const s = getSeen();
        ids.forEach(id => s.add(id));
        const arr = [...s].slice(-SEEN_CAP);
        set('seen', arr);
    };

    // ---- menu ------------------------------------------------------------
    GM_registerMenuCommand('LP2P · Set webhook URL', () => {
        const cur = get('webhook', '');
        const v = prompt('n8n webhook URL for WTS messages (use https://webhook.site/<id> to test first):', cur);
        if (v === null) return;
        set('webhook', (v || '').trim());
        toast('Webhook saved');
    });

    GM_registerMenuCommand('LP2P · Set heartbeat URL', () => {
        const cur = get('heartbeat', '');
        const v = prompt('n8n heartbeat webhook URL (POSTed every 5 min so the watchdog can alert on silence):', cur);
        if (v === null) return;
        set('heartbeat', (v || '').trim());
        toast('Heartbeat URL saved');
    });

    GM_registerMenuCommand('LP2P · Show status', () => {
        const wh = get('webhook', '');
        const hb = get('heartbeat', '');
        const seen = getSeen();
        const filt = get('wtsOnly', true);
        const autoScroll = !get('autoscroll_paused', false);
        const lastReload = get('last_reload_ts', 0);
        alert(
            'Version:     ' + VERSION +
            '\nWebhook:     ' + (wh || '(not set)') +
            '\nHeartbeat:   ' + (hb || '(not set)') +
            '\nSeen msgs:   ' + seen.size +
            '\nWTS filter:  ' + (filt ? 'ON (only forwards WTS posts)' : 'OFF (forwards every message)') +
            '\nAuto-scroll: ' + (autoScroll ? 'ON (every 30s)' : 'PAUSED') +
            '\nLast reload: ' + (lastReload ? new Date(lastReload).toISOString() : '(never)')
        );
    });

    GM_registerMenuCommand('LP2P · Re-send last visible', () => {
        scanAndSend(true);
    });

    GM_registerMenuCommand('LP2P · Clear seen IDs', () => {
        if (!confirm('Wipe the dedupe cache? Next scan will re-send everything visible.')) return;
        set('seen', []);
        toast('Seen IDs cleared');
    });

    GM_registerMenuCommand('LP2P · Toggle WTS-only filter', () => {
        const next = !get('wtsOnly', true);
        set('wtsOnly', next);
        toast('WTS-only filter: ' + (next ? 'ON' : 'OFF'));
    });

    GM_registerMenuCommand('LP2P · Pause auto-scroll', () => {
        const next = !get('autoscroll_paused', false);
        set('autoscroll_paused', next);
        toast('Auto-scroll: ' + (next ? 'PAUSED' : 'ON'));
    });

    // ---- DOM extraction --------------------------------------------------
    function extractMessage(li) {
        try {
            // li.id is "chat-messages-<channelId>-<messageId>"
            const m = li.id.match(/^chat-messages-\d+-(\d+)$/);
            if (!m) return null;
            const id = m[1];

            // Content lives in an element with id starting with "message-content-<id>"
            const contentEl = li.querySelector('[id^="message-content-' + id + '"]');
            let content = (contentEl?.innerText || '').trim();
            if (!content) return null; // skip embeds-only / system messages
            // Strip Discord's "(edited)" indicator + the timestamp tooltip text that
            // gets concatenated into innerText, e.g. "(edited)\nSunday, April 26, 2026 at 4:57 PM"
            content = content
                .replace(/\s*\(edited\)[\s\S]*$/i, '')
                .trim();
            if (!content) return null;

            // Author header: only the first message in a group renders the username.
            // Walk back through previous siblings until we find one with a header.
            let authorEl = li.querySelector('h3 [class*="username"]')
                       || li.querySelector('[class*="header"] [class*="username"]');
            let probe = li;
            while (!authorEl && probe.previousElementSibling
                   && /^chat-messages-\d+-\d+$/.test(probe.previousElementSibling.id || '')) {
                probe = probe.previousElementSibling;
                authorEl = probe.querySelector('h3 [class*="username"]')
                        || probe.querySelector('[class*="header"] [class*="username"]');
            }
            const author = (authorEl?.textContent || '').trim();
            // Author user ID: data-user-id is set on the avatar / mention nodes.
            const authorIdEl = probe.querySelector('[data-user-id]');
            const authorId = authorIdEl?.getAttribute('data-user-id') || '';

            // Timestamp: <time datetime="...">
            const timeEl = li.querySelector('time') || probe.querySelector('time');
            const timestamp = timeEl?.getAttribute('datetime') || '';

            return { id, author, authorId, content, timestamp };
        } catch (e) {
            console.warn('[LP2P] extract failed', e);
            return null;
        }
    }

    // ---- send ------------------------------------------------------------
    function postBatch(messages) {
        const url = get('webhook', '');
        if (!url) {
            console.warn('[LP2P] No webhook configured. Tampermonkey menu → "LP2P · Set webhook URL".');
            return;
        }
        GM_xmlhttpRequest({
            method: 'POST',
            url,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                source: 'discord_wts',
                channel_id: CHANNEL_ID,
                scraped_at: new Date().toISOString(),
                messages,
            }),
            onload: r => {
                if (r.status >= 200 && r.status < 300) {
                    console.log('[LP2P] forwarded', messages.length, 'messages -> ' + r.status);
                } else {
                    console.warn('[LP2P] webhook non-2xx', r.status, r.responseText);
                }
            },
            onerror: e => console.error('[LP2P] webhook error', e),
        });
    }

    // ---- scan ------------------------------------------------------------
    function looksLikeWTS(text) {
        return /\b(wts|vds|vends|sell|sale)\b/i.test(text);
    }

    function scanAndSend(force = false) {
        const filter = get('wtsOnly', true);
        const lis = document.querySelectorAll('[id^="chat-messages-' + CHANNEL_ID + '-"]');
        if (!lis.length) return;
        const seen = force ? new Set() : getSeen();
        const out = [];
        lis.forEach(li => {
            const msg = extractMessage(li);
            if (!msg) return;
            if (seen.has(msg.id)) return;
            if (filter && !looksLikeWTS(msg.content)) {
                seen.add(msg.id); // mark non-WTS as seen so we don't re-evaluate them every tick
                return;
            }
            out.push(msg);
        });
        if (out.length === 0) return;
        addSeen(out.map(m => m.id));
        postBatch(out);
    }

    // ---- toast (small confirmation in the corner) ------------------------
    let toastEl = null;
    function toast(msg) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#2b2d31;color:#fff;padding:10px 14px;border-radius:8px;font:13px/1.4 sans-serif;z-index:99999;box-shadow:0 4px 16px rgba(0,0,0,.4);border:1px solid #1f2226;pointer-events:none;opacity:0;transition:opacity .2s';
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = '[LP2P] ' + msg;
        toastEl.style.opacity = '1';
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { toastEl.style.opacity = '0'; }, 2400);
    }

    // ---- auto-scroll -----------------------------------------------------
    let cachedScroller = null;
    function findScroller() {
        if (cachedScroller && document.contains(cachedScroller)) return cachedScroller;
        cachedScroller = null;
        const list = document.querySelector('[data-list-id="chat-messages"]');
        if (!list) return null;
        let node = list.parentElement;
        while (node && node !== document.body) {
            const cs = getComputedStyle(node);
            const ovy = cs.overflowY;
            if ((ovy === 'auto' || ovy === 'scroll') && node.scrollHeight > node.clientHeight) {
                cachedScroller = node;
                return node;
            }
            node = node.parentElement;
        }
        return null;
    }

    function autoScrollTick() {
        if (get('autoscroll_paused', false)) return;
        const sc = findScroller();
        if (!sc) return;
        sc.scrollTop = sc.scrollHeight;
    }

    // ---- disconnect detect + recover -------------------------------------
    let disconnectFirstSeen = 0;
    function isDisconnected() {
        for (const sel of DISCONNECT_SELECTORS) {
            const el = document.querySelector(sel);
            if (!el) continue;
            // The connectionStatus class selector is already specific.
            if (sel.includes('connectionStatus')) return true;
            // The aria-live[role=status] selector matches many transient regions
            // (typing, new-message indicator, etc.). Filter by visible text.
            const txt = (el.textContent || '').trim();
            if (/reconnect|connecting|you are offline|no (internet|connection)|trying to (reconnect|connect)/i.test(txt)) {
                return true;
            }
        }
        return false;
    }

    function checkDisconnect() {
        if (!isDisconnected()) {
            disconnectFirstSeen = 0;
            return;
        }
        const now = Date.now();
        if (!disconnectFirstSeen) {
            disconnectFirstSeen = now;
            console.warn('[LP2P] Discord disconnect indicator detected; monitoring...');
            return;
        }
        if (now - disconnectFirstSeen < DISCONNECT_THRESHOLD_MS) return;
        const lastReload = get('last_reload_ts', 0);
        if (now - lastReload < RELOAD_THROTTLE_MS) {
            console.warn('[LP2P] Disconnect persists but reload throttled (last reload ' +
                new Date(lastReload).toISOString() + ').');
            return;
        }
        console.warn('[LP2P] Disconnect persisted ≥' + (DISCONNECT_THRESHOLD_MS / 1000) + 's — reloading.');
        set('pending_recovered_from', 'disconnect');
        set('last_reload_ts', now);
        location.reload();
    }

    // ---- heartbeat -------------------------------------------------------
    function heartbeat() {
        const url = get('heartbeat', '');
        if (!url) return;
        const messagesVisible = document.querySelectorAll(
            '[id^="chat-messages-' + CHANNEL_ID + '-"]'
        ).length;
        const recoveredFrom = get('pending_recovered_from', '');
        const body = {
            source: 'discord-scraper',
            ts: new Date().toISOString(),
            channel_id: CHANNEL_ID,
            version: VERSION,
            messages_visible: messagesVisible,
            seen_count: getSeen().size,
            auto_scroll: !get('autoscroll_paused', false),
        };
        if (recoveredFrom) body.recovered_from = recoveredFrom;
        GM_xmlhttpRequest({
            method: 'POST',
            url,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify(body),
            onload: r => {
                if (r.status >= 200 && r.status < 300) {
                    if (recoveredFrom) set('pending_recovered_from', '');
                } else {
                    console.warn('[LP2P] heartbeat non-2xx', r.status, r.responseText);
                }
            },
            onerror: e => console.warn('[LP2P] heartbeat error', e),
        });
    }

    // ---- observer + initial scan ----------------------------------------
    let scanTimer = null;
    const observer = new MutationObserver(() => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(() => scanAndSend(false), 1200);
    });

    function startObserver() {
        // Discord lazy-mounts the chat region. Wait for it.
        const main = document.querySelector('main');
        const messagesContainer = document.querySelector('[data-list-id="chat-messages"]') || main;
        if (!messagesContainer) {
            setTimeout(startObserver, 800);
            return;
        }
        observer.observe(messagesContainer, { childList: true, subtree: true });
        console.log('[LP2P] Discord WTS scraper active on channel', CHANNEL_ID, 'v' + VERSION);
        toast('WTS scraper active v' + VERSION);
        // First scan after a short settle delay
        setTimeout(() => scanAndSend(false), 2500);
        // Background loops
        setInterval(autoScrollTick, AUTO_SCROLL_MS);
        setInterval(checkDisconnect, DISCONNECT_CHECK_MS);
        setInterval(heartbeat, HEARTBEAT_MS);
        setTimeout(heartbeat, FIRST_HEARTBEAT_DELAY_MS);
    }

    startObserver();
})();
