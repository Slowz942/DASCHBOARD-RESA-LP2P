// ==UserScript==
// @name         LP2P · Instagram DM Sender
// @namespace    https://github.com/Slowz942/DASCHBOARD-RESA-LP2P
// @version      0.2.1
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

    // ---- constants ----------------------------------------------------------
    const QUEUE_CSV_URL = 'https://docs.google.com/spreadsheets/d/<CRM_SHEET_ID>/gviz/tq?tqx=out:csv&sheet=IG%20DM%20Queue';
    const STATUS_WEBHOOK_URL = 'https://<n8n-host>/webhook/ig-status';
    const POLL_INTERVAL_MS = 15000;
    const MAX_DMS_PER_HOUR = 20;
    const INTER_DM_MIN_MS = 1500;
    const INTER_DM_MAX_MS = 4000;
    const TYPING_MIN_MS = 200;
    const TYPING_MAX_MS = 800;
    const DEFERRED_WAIT_MS = 6 * 60 * 60 * 1000;
    const MAX_NAV_RETRIES = 3;

    // ---- state --------------------------------------------------------------
    const STORE = 'lp2p_ig_';
    let paused = false;
    let sending = false;
    let hourLog = [];
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
        const ids = get('seenList', []);
        ids.forEach(id => GM_setValue(STORE + 'seen_' + id, false));
        set('seenList', []);
        log('Seen IDs cleared');
    });
    GM_registerMenuCommand('LP2P · Clear deferred jobs', () => {
        set('deferredJobs', []);
        log('Deferred jobs cleared');
    });
    GM_registerMenuCommand('LP2P · Force clear active job', () => {
        set('activeJob', '');
        set('navRetries', 0);
        sending = false;
        badge.update('idle');
        log('Active job force-cleared');
    });
    GM_registerMenuCommand('LP2P · Show status', () => {
        const ids = get('seenList', []);
        const deferred = get('deferredJobs', []);
        const activeRaw = get('activeJob', '');
        alert(
            'Status: ' + (paused ? 'PAUSED' : sending ? 'SENDING' : 'IDLE') +
            '\nSeen rows: ' + ids.length +
            '\nDMs this hour: ' + pruneHourLog().length + '/' + MAX_DMS_PER_HOUR +
            '\nQueue depth: ' + localQueue.length +
            '\nDeferred (private accts): ' + deferred.length +
            '\nActive job: ' + (activeRaw ? 'YES' : 'none') +
            '\nPath: ' + location.pathname
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

    // ---- helpers ------------------------------------------------------------
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
        log('Posting status: ' + status + ' for @' + handle);
        GM_xmlhttpRequest({
            method: 'POST',
            url: STATUS_WEBHOOK_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ id, status, instagram_handle: handle, error: error || '' }),
            onload: r => log('Status POST ' + status + ' → HTTP ' + r.status),
            onerror: e => log('Status POST failed: ' + (e.statusText || e)),
        });
    }

    // ---- deferred jobs ------------------------------------------------------
    function getDeferredJobs() { return get('deferredJobs', []); }
    function saveDeferredJobs(jobs) { set('deferredJobs', jobs); }

    function deferJob(job) {
        const deferred = getDeferredJobs();
        deferred.push({
            id: job.id,
            handle: job.handle,
            text: job.text,
            retryAfter: Date.now() + DEFERRED_WAIT_MS,
        });
        saveDeferredJobs(deferred);
        log('Deferred @' + job.handle + ' (private account) — retry in 6h');
    }

    function checkDeferredJobs() {
        const deferred = getDeferredJobs();
        if (!deferred.length) return;
        const now = Date.now();
        const ready = [];
        const remaining = [];
        for (const j of deferred) {
            if (now >= j.retryAfter) ready.push(j);
            else remaining.push(j);
        }
        if (ready.length > 0) {
            saveDeferredJobs(remaining);
            for (const j of ready) {
                log('Deferred job ready: @' + j.handle);
                localQueue.push({ id: j.id, handle: j.handle, text: j.text });
            }
        }
    }

    // ---- poll the queue sheet -----------------------------------------------
    function pollQueue() {
        log('Poll tick: paused=' + paused + ' sending=' + sending);
        if (paused || sending) return;

        checkDeferredJobs();

        log('Fetching queue CSV...');
        GM_xmlhttpRequest({
            method: 'GET',
            url: QUEUE_CSV_URL + '&t=' + Date.now(),
            onload: r => {
                log('CSV response: HTTP ' + r.status + ', length=' + (r.responseText || '').length);
                if (r.status < 200 || r.status >= 300) {
                    log('Poll failed: HTTP ' + r.status);
                    return;
                }
                try {
                    const rows = parseCSV((r.responseText || '').replace(/^\uFEFF/, ''));
                    log('CSV parsed: ' + rows.length + ' rows');
                    if (rows.length < 2) { log('No data rows'); return; }
                    const header = rows[0].map(h => h.toLowerCase());
                    const col = name => header.indexOf(name);
                    const iId = col('id'), iHandle = col('instagram_handle'),
                          iText = col('proposal_text'), iStatus = col('status');
                    log('Columns: id=' + iId + ' handle=' + iHandle + ' text=' + iText + ' status=' + iStatus);

                    let foundPending = 0;
                    for (let i = 1; i < rows.length; i++) {
                        const c = rows[i];
                        if (!c || !c.length) continue;
                        const id = (c[iId] || '').trim();
                        const status = (c[iStatus] || '').toUpperCase().trim();
                        if (status !== 'PENDING') continue;
                        foundPending++;
                        if (!id) { log('Row ' + i + ': empty id, skip'); continue; }
                        if (isSeen(id)) { log('Row ' + i + ': id=' + id + ' already seen, skip'); continue; }

                        const handle = (c[iHandle] || '').replace(/^@/, '').toLowerCase().trim();
                        const text = (c[iText] || '').trim();

                        if (!handle || !text) {
                            markSeen(id);
                            trackSeen(id);
                            postStatus(id, 'ERROR', handle, 'EMPTY_HANDLE_OR_TEXT');
                            log('Skipped ' + id + ': empty handle or text');
                            continue;
                        }

                        log('Queuing job: id=' + id + ' handle=@' + handle);
                        localQueue.push({ id, handle, text });
                    }
                    log('Found ' + foundPending + ' PENDING rows, queue depth=' + localQueue.length);

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
        if (list.length > 500) list.splice(0, list.length - 500);
        set('seenList', list);
    }

    // ---- process queue ------------------------------------------------------
    async function processQueue() {
        if (sending || paused || localQueue.length === 0) return;

        if (pruneHourLog().length >= MAX_DMS_PER_HOUR) {
            log('Hourly cap reached (' + MAX_DMS_PER_HOUR + '). Pausing.');
            paused = true;
            badge.update('paused');
            postStatus(localQueue[0].id, 'ERROR', localQueue[0].handle, 'HOURLY_CAP');
            return;
        }

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

        sending = true;
        badge.update('sending');

        set('activeJob', JSON.stringify({ ...job, phase: 'profile' }));
        set('navRetries', 0);
        log('Navigating to profile @' + job.handle + '...');
        location.href = 'https://www.instagram.com/' + job.handle + '/';
        // Page reloads here. resumeActiveJob picks up on next load.
    }

    // ---- profile page handler -----------------------------------------------
    async function handleProfile(job) {
        sending = true;
        badge.update('sending');
        log('On profile page for @' + job.handle + ', looking for buttons...');

        await randomDelay(2000, 3000); // let profile fully render

        if (detectCheckpoint()) {
            failJob(job, 'IG_CHECKPOINT');
            return;
        }

        // Find a button by exact text content (handles EN + FR)
        const findButton = (...labels) => {
            const btns = document.querySelectorAll('button, [role="button"]');
            for (const b of btns) {
                const txt = (b.textContent || '').trim().toLowerCase();
                for (const label of labels) {
                    if (txt === label.toLowerCase()) return b;
                }
            }
            return null;
        };

        // Log all visible buttons for debugging
        const allBtns = document.querySelectorAll('button, [role="button"]');
        const btnTexts = [];
        allBtns.forEach(b => {
            const txt = (b.textContent || '').trim();
            if (txt && txt.length < 40) btnTexts.push(txt);
        });
        log('Buttons on page: ' + btnTexts.join(' | '));

        // 1. Check if Message button is already visible
        let msgBtn = findButton('Message', 'Envoyer un message');
        if (msgBtn) {
            log('Message button found, clicking...');
            await clickMessageAndSend(msgBtn, job);
            return;
        }

        // 2. Check for Follow Back / Follow button
        let followBtn = findButton(
            'Follow Back', 'Suivre en retour',
            'Follow', 'Suivre'
        );

        if (!followBtn) {
            failJob(job, 'NO_MESSAGE_OR_FOLLOW_BUTTON');
            return;
        }

        log('No Message button. Clicking Follow for @' + job.handle + '...');
        followBtn.click();
        await randomDelay(2000, 3500);

        // 3. After following, check if Message button appeared (public account)
        msgBtn = findButton('Message', 'Envoyer un message');
        if (msgBtn) {
            log('Public account — Message button appeared after follow. Clicking...');
            await clickMessageAndSend(msgBtn, job);
            return;
        }

        // 4. Private account → defer
        log('Private account — no Message button after follow.');
        deferJob(job);
        postStatus(job.id, 'ERROR', job.handle, 'PRIVATE_ACCOUNT_DEFERRED_6H');
        set('activeJob', '');
        sending = false;
        badge.update('idle');
        await randomDelay(1000, 2000);
        location.href = 'https://www.instagram.com/';
    }

    // ---- click Message and send DM ------------------------------------------
    async function clickMessageAndSend(msgBtn, job) {
        msgBtn.click();
        log('Clicked Message, waiting for composer (popup or full page)...');

        // IG may open a popup DM window (no URL change) or navigate to /direct/t/.
        // Either way, we just wait for the composer textbox to appear anywhere on the page.
        await randomDelay(1500, 2500);
        await typeAndSend(job);
    }

    // ---- type and send the DM -----------------------------------------------
    async function typeAndSend(job) {
        sending = true;
        badge.update('sending');
        log('Typing DM to @' + job.handle + '...');

        try {
            if (detectCheckpoint()) throw new Error('IG_CHECKPOINT');

            const composer = await waitFor(() => {
                const el = document.querySelector('[role="textbox"][contenteditable="true"]');
                if (el && el.offsetParent !== null) return el;
                return null;
            }, 15000);
            log('Composer found');

            composer.focus();
            await randomDelay(300, 600);

            const chunks = splitIntoChunks(job.text);
            for (const chunk of chunks) {
                document.execCommand('insertText', false, chunk);
                await randomDelay(TYPING_MIN_MS, TYPING_MAX_MS);
            }

            const typed = (composer.textContent || '').trim();
            log('Typed ' + typed.length + ' chars (expected ~' + job.text.length + ')');
            if (!typed || typed.length < job.text.length * 0.5) {
                throw new Error('TEXT_NOT_INSERTED: got ' + typed.length + ' chars, expected ~' + job.text.length);
            }

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
            log('Send button found, clicking...');

            await randomDelay(200, 500);
            sendBtn.click();

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

        set('activeJob', '');
        sending = false;
        badge.update('idle');
        await randomDelay(1000, 2000);
        location.href = 'https://www.instagram.com/';
    }

    // ---- fail a job cleanly -------------------------------------------------
    function failJob(job, error) {
        postStatus(job.id, 'ERROR', job.handle, error);
        log('Failed @' + job.handle + ': ' + error);
        set('activeJob', '');
        sending = false;
        badge.update('error');
        setTimeout(() => { location.href = 'https://www.instagram.com/'; }, 2000);
    }

    // ---- resume active job on page load -------------------------------------
    function resumeActiveJob() {
        const raw = get('activeJob', '');
        if (!raw) { log('No active job to resume'); return false; }
        let job;
        try { job = JSON.parse(raw); } catch { set('activeJob', ''); return false; }
        if (!job || !job.id || !job.handle) { set('activeJob', ''); return false; }

        const retries = get('navRetries', 0);
        const phase = job.phase || 'profile';
        log('Active job found: @' + job.handle + ' phase=' + phase + ' retries=' + retries + ' path=' + location.pathname);

        // Phase: dm
        if (phase === 'dm') {
            if (/\/direct\/t\/\d+/.test(location.pathname)) {
                set('navRetries', 0);
                typeAndSend(job);
                return true;
            }
            if (retries >= MAX_NAV_RETRIES) {
                log('DM nav failed after ' + retries + ' retries for @' + job.handle);
                failJob(job, 'NAV_FAILED');
                return true;
            }
            set('navRetries', retries + 1);
            set('activeJob', JSON.stringify({ ...job, phase: 'profile' }));
            log('Falling back to profile nav, retry ' + (retries + 1) + '/' + MAX_NAV_RETRIES);
            location.href = 'https://www.instagram.com/' + job.handle + '/';
            return true;
        }

        // Phase: profile
        const onProfile = location.pathname.replace(/\/$/, '').toLowerCase() ===
                          '/' + job.handle.toLowerCase();
        log('Profile check: onProfile=' + onProfile + ' expected=/' + job.handle.toLowerCase());

        if (onProfile) {
            set('navRetries', 0);
            handleProfile(job);
            return true;
        }

        if (retries >= MAX_NAV_RETRIES) {
            log('Profile nav failed after ' + retries + ' retries for @' + job.handle);
            failJob(job, 'NAV_FAILED');
            return true;
        }

        set('navRetries', retries + 1);
        log('Not on profile page, retry ' + (retries + 1) + '/' + MAX_NAV_RETRIES);
        location.href = 'https://www.instagram.com/' + job.handle + '/';
        return true;
    }

    // ---- split text into chunks ---------------------------------------------
    function splitIntoChunks(text) {
        const chunks = [];
        const sentences = text.match(/[^.!?]+[.!?]*\s*/g) || [text];
        for (const s of sentences) {
            if (s.length <= 80) {
                chunks.push(s);
            } else {
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
    log('IG DM Sender loaded, path=' + location.pathname);

    setTimeout(() => {
        if (resumeActiveJob()) {
            log('Resuming active job...');
            return;
        }
        pollQueue();
        pollTimer = setInterval(pollQueue, POLL_INTERVAL_MS);
        log('Polling started (' + (POLL_INTERVAL_MS / 1000) + 's interval)');
    }, 3000);
})();
