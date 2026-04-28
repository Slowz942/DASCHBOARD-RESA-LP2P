// ==UserScript==
// @name         LP2P · Instagram DM Sender
// @namespace    https://github.com/Slowz942/DASCHBOARD-RESA-LP2P
// @version      0.1.0
// @description  Polls IG DM Queue sheet, sends DMs from operator's IG session
// @author       LP2P
// @match        https://www.instagram.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

(() => {
    'use strict';

    // ---- constants (operator pastes real values locally) ---------------------
    const QUEUE_CSV_URL = 'https://docs.google.com/spreadsheets/d/<CRM_SHEET_ID>/gviz/tq?tqx=out:csv&sheet=IG%20DM%20Queue';
    const STATUS_WEBHOOK_URL = 'https://<n8n-host>/webhook/ig-status';
    const POLL_INTERVAL_MS = 15000;
    const MAX_DMS_PER_HOUR = 20;
    const INTER_DM_MIN_MS = 1500;
    const INTER_DM_MAX_MS = 4000;
    const TYPING_MIN_MS = 200;
    const TYPING_MAX_MS = 800;

    // ---- state --------------------------------------------------------------
    const STORE = 'lp2p_ig_';
    let paused = false;
    let sending = false;
    let hourLog = []; // timestamps of DMs sent in the rolling hour
    const localQueue = [];
    let pollTimer = null;

    // ---- storage helpers ----------------------------------------------------
    const get = (k, def) => GM_getValue(STORE + k, def);
    const set = (k, v) => GM_setValue(STORE + k, v);
    const isSeen = (id) => get('seen_' + id, false);
    const markSeen = (id) => set('seen_' + id, true);

    // ---- menu commands ------------------------------------------------------
    GM_registerMenuCommand('LP2P · Pause queue', () => {
        paused = true;
        badge.update('paused');
        log('Queue paused by operator');
    });
    GM_registerMenuCommand('LP2P · Resume queue', () => {
        paused = false;
        badge.update('idle');
        log('Queue resumed');
    });
    GM_registerMenuCommand('LP2P · Clear seen IDs', () => {
        if (!confirm('Clear all seen IDs? Pending rows will be re-processed on next poll.')) return;
        // GM storage doesn't support enumeration easily, so we track a list
        const ids = get('seenList', []);
        ids.forEach(id => GM_setValue(STORE + 'seen_' + id, false));
        set('seenList', []);
        log('Seen IDs cleared');
    });
    GM_registerMenuCommand('LP2P · Show status', () => {
        const ids = get('seenList', []);
        alert(
            'Status: ' + (paused ? 'PAUSED' : sending ? 'SENDING' : 'IDLE') +
            '\nSeen rows: ' + ids.length +
            '\nDMs this hour: ' + pruneHourLog().length + '/' + MAX_DMS_PER_HOUR +
            '\nQueue depth: ' + localQueue.length
        );
    });

    // ---- logging + badge ----------------------------------------------------
    const logLines = [];
    function log(msg) {
        const ts = new Date().toLocaleTimeString();
        const line = '[LP2P-IG] ' + ts + ' ' + msg;
        console.log(line);
        logLines.push(line);
        if (logLines.length > 50) logLines.shift();
        badge.setLog(logLines);
    }

    const badge = (() => {
        const el = document.createElement('div');
        el.id = 'lp2p-ig-badge';
        el.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:999999;' +
            'background:#1a1a2e;color:#eee;font:12px/1.4 monospace;padding:8px 12px;' +
            'border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.5);max-width:340px;' +
            'pointer-events:auto;user-select:text;border:1px solid #333;';
        const status = document.createElement('div');
        status.style.cssText = 'font-weight:bold;margin-bottom:4px;';
        const logEl = document.createElement('div');
        logEl.style.cssText = 'max-height:120px;overflow-y:auto;font-size:10px;opacity:.75;white-space:pre-wrap;word-break:break-all;';
        el.appendChild(status);
        el.appendChild(logEl);

        function mount() {
            if (document.body) document.body.appendChild(el);
            else setTimeout(mount, 500);
        }
        mount();

        return {
            update(state) {
                const colors = { idle: '#4ade80', sending: '#60a5fa', paused: '#fbbf24', error: '#f87171' };
                status.textContent = 'LP2P DM Sender: ' + state.toUpperCase();
                status.style.color = colors[state] || '#eee';
            },
            setLog(lines) {
                logEl.textContent = lines.slice(-8).join('\n');
                logEl.scrollTop = logEl.scrollHeight;
            },
        };
    })();
    badge.update('idle');

    // ---- CSV parsing --------------------------------------------------------
    function parseCSV(text) {
        const rows = []; let cur = '', row = [], inQ = false;
        for (let i = 0; i < text.length; i++) {
            const c = text[i];
            if (c === '"') { if (inQ && text[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
            else if (c === ',' && !inQ) { row.push(cur); cur = ''; }
            else if (c === '\n' && !inQ) { row.push(cur); cur = ''; rows.push(row); row = []; }
            else if (c === '\r') {}
            else cur += c;
        }
        if (cur.length || row.length) { row.push(cur); rows.push(row); }
        return rows.map(r => r.map(c => c.trim()));
    }

    // ---- hourly cap ---------------------------------------------------------
    function pruneHourLog() {
        const cutoff = Date.now() - 3600000;
        hourLog = hourLog.filter(t => t > cutoff);
        return hourLog;
    }

    // ---- checkpoint detection -----------------------------------------------
    function detectCheckpoint() {
        if (location.pathname.startsWith('/challenge')) return true;
        const body = document.body?.innerText || '';
        if (/unusual activity|verify it.s you|activit[eé] inhabituelle|confirmer? (votre|ton) identit/i.test(body)) return true;
        return false;
    }

    // ---- helpers: wait for element, random delay ----------------------------
    function waitFor(testFn, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const el = testFn();
                if (el) return resolve(el);
                if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
                setTimeout(check, 500);
            };
            check();
        });
    }

    function randomDelay(min, max) {
        return new Promise(r => setTimeout(r, min + Math.random() * (max - min)));
    }

    // ---- status webhook -----------------------------------------------------
    function postStatus(id, status, handle, error) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: STATUS_WEBHOOK_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ id, status, instagram_handle: handle, error: error || '' }),
            onload: r => log('Status POST ' + status + ' → ' + r.status),
            onerror: e => log('Status POST failed: ' + (e.statusText || e)),
        });
    }

    // ---- poll the queue sheet -----------------------------------------------
    function pollQueue() {
        if (paused || sending) return;

        GM_xmlhttpRequest({
            method: 'GET',
            url: QUEUE_CSV_URL + '&t=' + Date.now(),
            onload: r => {
                if (r.status < 200 || r.status >= 300) {
                    log('Poll failed: HTTP ' + r.status);
                    return;
                }
                try {
                    const rows = parseCSV((r.responseText || '').replace(/^\uFEFF/, ''));
                    if (rows.length < 2) return; // header only
                    const header = rows[0].map(h => h.toLowerCase());
                    const col = name => header.indexOf(name);
                    const iId = col('id'), iHandle = col('instagram_handle'),
                          iText = col('proposal_text'), iStatus = col('status');

                    for (let i = 1; i < rows.length; i++) {
                        const c = rows[i];
                        if (!c || !c.length) continue;
                        const id = (c[iId] || '').trim();
                        const status = (c[iStatus] || '').toUpperCase().trim();
                        if (status !== 'PENDING') continue;
                        if (!id || isSeen(id)) continue;

                        const handle = (c[iHandle] || '').replace(/^@/, '').toLowerCase().trim();
                        const text = (c[iText] || '').trim();

                        if (!handle || !text) {
                            markSeen(id);
                            trackSeen(id);
                            postStatus(id, 'ERROR', handle, 'EMPTY_HANDLE_OR_TEXT');
                            log('Skipped ' + id + ': empty handle or text');
                            continue;
                        }

                        localQueue.push({ id, handle, text });
                    }

                    if (localQueue.length > 0 && !sending && !paused) {
                        processQueue();
                    }
                } catch (e) {
                    log('Poll parse error: ' + e.message);
                }
            },
            onerror: e => log('Poll network error: ' + (e.statusText || e)),
        });
    }

    function trackSeen(id) {
        const list = get('seenList', []);
        list.push(id);
        // cap at 500 to avoid storage bloat
        if (list.length > 500) list.splice(0, list.length - 500);
        set('seenList', list);
    }

    // ---- process queue: pick one job, navigate (reload), type & send on reload
    async function processQueue() {
        if (sending || paused || localQueue.length === 0) return;

        // hourly cap check
        if (pruneHourLog().length >= MAX_DMS_PER_HOUR) {
            log('Hourly cap reached (' + MAX_DMS_PER_HOUR + '). Pausing.');
            paused = true;
            badge.update('paused');
            postStatus(localQueue[0].id, 'ERROR', localQueue[0].handle, 'HOURLY_CAP');
            return;
        }

        // checkpoint check
        if (detectCheckpoint()) {
            log('IG CHECKPOINT detected. Stopping.');
            paused = true;
            badge.update('error');
            postStatus(localQueue[0].id, 'ERROR', localQueue[0].handle, 'IG_CHECKPOINT');
            return;
        }

        const job = localQueue.shift();
        markSeen(job.id);
        trackSeen(job.id);

        // sendDM persists the job and navigates — page reloads, typeAndSend
        // picks it up on the next script load.
        sending = true;
        badge.update('sending');
        await sendDM(job);
    }

    // ---- send a single DM ---------------------------------------------------
    // Phase 1: persist job and navigate (page will reload)
    // Phase 2: on reload, detect we're on /direct/t/ with a pending job → type & send
    async function sendDM(job) {
        log('Opening DM to @' + job.handle + '...');

        // Save job to storage so we survive the page reload
        set('activeJob', JSON.stringify(job));

        // Navigate to the DM thread via ig.me/m/<handle>
        location.href = 'https://ig.me/m/' + encodeURIComponent(job.handle);

        // The page will reload here — execution stops.
        // typeAndSend() is called on the next script load from resumeActiveJob().
        // Return a promise that never resolves (the reload will kill this context).
        return new Promise(() => {});
    }

    // Called after page load when we detect an active job and we're on /direct/t/
    async function typeAndSend(job) {
        sending = true;
        badge.update('sending');
        log('Resuming DM to @' + job.handle + ' after navigation...');

        try {
            // Checkpoint check
            if (detectCheckpoint()) throw new Error('IG_CHECKPOINT');

            // Wait for the composer textbox
            const composer = await waitFor(() => {
                const el = document.querySelector('[role="textbox"][contenteditable="true"]');
                if (el && el.offsetParent !== null) return el;
                return null;
            }, 15000);

            // Focus the composer
            composer.focus();
            await randomDelay(300, 600);

            // Type text using execCommand (works with React's contenteditable)
            const chunks = splitIntoChunks(job.text);
            for (const chunk of chunks) {
                document.execCommand('insertText', false, chunk);
                await randomDelay(TYPING_MIN_MS, TYPING_MAX_MS);
            }

            // Verify text landed
            const typed = (composer.textContent || '').trim();
            if (!typed || typed.length < job.text.length * 0.5) {
                throw new Error('TEXT_NOT_INSERTED: got ' + typed.length + ' chars, expected ~' + job.text.length);
            }

            // Wait for Send button to become enabled
            const sendBtn = await waitFor(() => {
                const btns = document.querySelectorAll('[role="button"]');
                for (const b of btns) {
                    const label = (b.getAttribute('aria-label') || '').toLowerCase();
                    if (label === 'send' || label === 'envoyer') {
                        if (!b.disabled && b.offsetParent !== null) return b;
                    }
                }
                return null;
            }, 8000);

            await randomDelay(200, 500);
            sendBtn.click();

            // Verify message appears in thread
            await randomDelay(1500, 3000);
            const verified = await waitFor(() => {
                const msgs = document.querySelectorAll('[role="row"], [role="listitem"], div[class]');
                for (const m of msgs) {
                    const t = (m.textContent || '').trim();
                    if (t.includes(job.text.slice(0, 40))) return true;
                }
                return null;
            }, 10000).catch(() => null);

            if (!verified) {
                log('Warning: could not verify message in thread for @' + job.handle);
            }

            hourLog.push(Date.now());
            postStatus(job.id, 'SENT', job.handle, '');
            log('Sent DM to @' + job.handle);
        } catch (e) {
            postStatus(job.id, 'ERROR', job.handle, e.message || String(e));
            log('Failed @' + job.handle + ': ' + e.message);
        }

        // Clear the active job
        set('activeJob', '');
        sending = false;
        badge.update('idle');

        // Navigate back to IG home so we're ready for the next poll cycle
        await randomDelay(1000, 2000);
        location.href = 'https://www.instagram.com/';
    }

    // Check on script load if there's a job to resume
    function resumeActiveJob() {
        const raw = get('activeJob', '');
        if (!raw) return false;
        let job;
        try { job = JSON.parse(raw); } catch { set('activeJob', ''); return false; }
        if (!job || !job.id || !job.handle) { set('activeJob', ''); return false; }

        // Are we on the DM thread page?
        if (/\/direct\/t\/\d+/.test(location.pathname)) {
            // We landed on the right page — run type & send
            typeAndSend(job);
            return true;
        }

        // ig.me/m/ redirects — we might still be mid-redirect.
        // If we're on ig.me or instagram.com but not /direct/t/ yet,
        // wait a bit and check again. If we're on IG home, the redirect
        // may have failed (bad handle, etc.)
        if (location.hostname === 'ig.me') {
            // Still redirecting, wait
            setTimeout(() => resumeActiveJob(), 2000);
            return true;
        }

        // We're on instagram.com but not in /direct/t/ — redirect may have
        // failed or we got bounced. Give it one more chance.
        log('Active job found but not on DM thread, retrying navigation...');
        location.href = 'https://ig.me/m/' + encodeURIComponent(job.handle);
        return true;
    }

    // Split text into natural-looking chunks (by sentence or ~40-80 char segments)
    function splitIntoChunks(text) {
        const chunks = [];
        // Split on sentence boundaries, keep chunks reasonable
        const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
        for (const s of sentences) {
            if (s.length <= 80) {
                chunks.push(s);
            } else {
                // Split long sentences at spaces around 40-60 chars
                let remaining = s;
                while (remaining.length > 60) {
                    const cut = remaining.lastIndexOf(' ', 50 + Math.floor(Math.random() * 20));
                    if (cut <= 10) { chunks.push(remaining); remaining = ''; break; }
                    chunks.push(remaining.slice(0, cut + 1));
                    remaining = remaining.slice(cut + 1);
                }
                if (remaining) chunks.push(remaining);
            }
        }
        return chunks.length ? chunks : [text];
    }

    // ---- start --------------------------------------------------------------
    log('IG DM Sender loaded');

    // Initial delay to let IG settle, then check for active job or start polling
    setTimeout(() => {
        if (resumeActiveJob()) {
            log('Resuming active job...');
            // Start polling AFTER the job completes (typeAndSend navigates home when done)
            return;
        }
        pollQueue();
        pollTimer = setInterval(pollQueue, POLL_INTERVAL_MS);
        log('Polling started (' + (POLL_INTERVAL_MS / 1000) + 's interval)');
    }, 3000);
})();
