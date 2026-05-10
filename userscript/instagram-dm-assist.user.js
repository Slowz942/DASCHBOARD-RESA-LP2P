// ==UserScript==
// @name         LP2P · Instagram DM Assist
// @namespace    https://github.com/Slowz942/DASCHBOARD-RESA-LP2P
// @version      0.1.0
// @description  Reads the open IG DM thread, parses the client's intent via n8n, surfaces top-3 inventory + Sourcing Discord matches with copyable proposal text. Toggle on/off from the floating widget.
// @author       LP2P
// @match        https://www.instagram.com/direct/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_setClipboard
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * Setup:
 *   1. Edit WEBHOOK_URL below — paste the production URL of the n8n
 *      "IG DM Assist" workflow. Save (Ctrl+S in Tampermonkey editor).
 *   2. Reload an IG DM page. Floating widget appears bottom-right.
 *   3. Click to toggle ON. Click "Re-match" or send/receive a message
 *      to fire the matcher.
 *
 * What it does:
 *   - On IG /direct/* pages, mounts a floating widget (toggle + status).
 *   - When toggle is ON: reads the open thread (last 15 messages,
 *     left-aligned = client, right-aligned = operator), POSTs to the
 *     n8n webhook, renders top-3 matches in a slide-up panel.
 *   - Auto-fires on each new CLIENT message (not on operator's own).
 *   - Skips trivial messages ("ok", "merci", emojis-only).
 *   - 8s cooldown between auto-fires; manual Re-match always works.
 *
 * State: per-thread auto-fire dedupe (so reloading or navigating
 *   away+back doesn't re-fire). Toggle persists globally.
 *
 * Privacy: only active on /direct/*. Toggle OFF = no DOM reads, no
 *   network. Conversation is sent to your own n8n only.
 */

(() => {
    'use strict';

    // ---- constants ----------------------------------------------------------
    const WEBHOOK_URL = 'https://<n8n-host>/webhook/ig-dm-assist'; // EDIT IN TAMPERMONKEY
    const STORE = 'lp2p_iga_';
    const HISTORY_TURNS = 15;
    const AUTO_COOLDOWN_MS = 8000;
    const TRIVIAL_RE = /^(ok|okay|merci|thanks|yes|yep|yeah|no|nope|salut|bonjour|hi|hello|👍|👌|❤️|😂|🙏)$/i;

    // ---- state --------------------------------------------------------------
    let widgetEl = null;
    let panelEl = null;
    let observer = null;
    let lastFireAt = 0;
    let lastMessageSig = '';   // dedupe of latest client message per thread
    let currentThread = '';
    let inFlight = false;

    // ---- storage ------------------------------------------------------------
    const get = (k, def) => GM_getValue(STORE + k, def);
    const set = (k, v) => GM_setValue(STORE + k, v);
    const isEnabled = () => !!get('enabled', false);
    const setEnabled = (v) => set('enabled', !!v);

    // ---- log ----------------------------------------------------------------
    const log = (...args) => console.log('[LP2P-IGA]', ...args);
    const warn = (...args) => console.warn('[LP2P-IGA]', ...args);

    // ---- menu commands ------------------------------------------------------
    GM_registerMenuCommand('LP2P · Toggle assist on/off', () => {
        setEnabled(!isEnabled());
        renderWidget();
        if(isEnabled()) fireMatch('toggle-on');
        else hidePanel();
    });
    GM_registerMenuCommand('LP2P · Show webhook URL', () => {
        alert('Webhook: ' + WEBHOOK_URL);
    });

    // ---- UI: widget ---------------------------------------------------------
    function renderWidget(){
        if(!widgetEl){
            widgetEl = document.createElement('div');
            widgetEl.id = 'lp2p-iga-widget';
            widgetEl.style.cssText = `
                position:fixed; right:18px; bottom:18px; z-index:99998;
                background:#1f1f23; color:#fff; border-radius:999px;
                padding:8px 14px; font:600 13px/1.2 -apple-system,BlinkMacSystemFont,sans-serif;
                box-shadow:0 6px 24px rgba(0,0,0,.4); border:1px solid #2c2c33;
                cursor:pointer; user-select:none; display:flex; align-items:center; gap:8px;
                transition:transform .1s ease;
            `;
            widgetEl.addEventListener('mouseenter', () => widgetEl.style.transform = 'translateY(-1px)');
            widgetEl.addEventListener('mouseleave', () => widgetEl.style.transform = '');
            widgetEl.addEventListener('click', (e) => {
                if(e.target.dataset?.action === 'rematch'){
                    e.stopPropagation();
                    fireMatch('manual');
                    return;
                }
                setEnabled(!isEnabled());
                renderWidget();
                if(isEnabled()){
                    fireMatch('toggle-on');
                } else {
                    hidePanel();
                }
            });
            document.body.appendChild(widgetEl);
        }
        const on = isEnabled();
        const dot = on
            ? '<span style="width:8px;height:8px;border-radius:50%;background:#22c55e;display:inline-block;box-shadow:0 0 8px #22c55e"></span>'
            : '<span style="width:8px;height:8px;border-radius:50%;background:#52525b;display:inline-block"></span>';
        widgetEl.innerHTML = `
            ${dot}
            <span>🎯 ${on ? 'ON' : 'OFF'}</span>
            ${on ? '<span data-action="rematch" style="margin-left:6px;padding:3px 8px;border-radius:6px;background:#2c2c33;font-weight:500;font-size:11px">Re-match</span>' : ''}
        `;
    }

    // ---- UI: results panel --------------------------------------------------
    function ensurePanel(){
        if(panelEl) return panelEl;
        panelEl = document.createElement('div');
        panelEl.id = 'lp2p-iga-panel';
        panelEl.style.cssText = `
            position:fixed; right:18px; bottom:64px; z-index:99997;
            width:340px; max-height:70vh; overflow:auto;
            background:#1f1f23; color:#fff; border-radius:14px;
            font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;
            box-shadow:0 12px 40px rgba(0,0,0,.55); border:1px solid #2c2c33;
            display:none;
        `;
        document.body.appendChild(panelEl);
        return panelEl;
    }
    function hidePanel(){
        if(panelEl) panelEl.style.display = 'none';
    }
    function renderLoading(){
        const p = ensurePanel();
        p.style.display = 'block';
        p.innerHTML = `<div style="padding:14px 16px;color:#a1a1aa">Reading conversation…</div>`;
    }
    function renderError(msg){
        const p = ensurePanel();
        p.style.display = 'block';
        p.innerHTML = `<div style="padding:14px 16px;color:#f87171">⚠ ${escapeHTML(msg)}</div>`;
    }
    function renderResults(data){
        const p = ensurePanel();
        p.style.display = 'block';

        const parsed = data.parsed || {};
        const matches = data.matches || [];

        const intentChips = [
            parsed.artist || '?artist',
            (parsed.dates || []).map(frenchDate).join(', ') || '?date',
            parsed.category || 'NC',
            (parsed.places || 1) + ' place' + (parsed.places > 1 ? 's' : ''),
        ].map(c => `<span style="padding:2px 8px;border-radius:6px;background:#2c2c33;margin-right:6px;font-size:11px">${escapeHTML(c)}</span>`).join('');

        let body = `
            <div style="padding:12px 16px;border-bottom:1px solid #2c2c33">
                <div style="font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Parsed intent</div>
                <div>${intentChips}</div>
            </div>
        `;

        if(!matches.length){
            body += `<div style="padding:14px 16px;color:#a1a1aa">
                No match in inventory or Sourcing Discord for that demand.
                <div style="margin-top:6px;font-size:11px;color:#71717a">${data.debug?.inventory_count || 0} inv · ${data.debug?.discord_count || 0} disc · ${data.debug?.llm_ms || '?'}ms</div>
            </div>`;
        } else {
            body += `<div style="padding:6px 0">`;
            matches.forEach((m, i) => {
                const stripeColor = m.dateMatch ? '#22c55e' : '#f59e0b';
                const sourceLabel = m.source === 'inventory' ? '🎫 Inventory' : '💬 Discord';
                const ageChip = (m.source === 'discord' && m.post_age_hours != null)
                    ? `<span style="font-size:10px;color:#a1a1aa;margin-left:6px">posté il y a ${formatHoursAgo(m.post_age_hours)}</span>`
                    : '';
                const dateLabel = m.date ? frenchDate(m.date) : '';
                body += `
                    <div data-idx="${i}" style="display:flex;border-left:3px solid ${stripeColor};padding:10px 14px;margin:0;border-bottom:1px solid #1c1c20;cursor:default">
                        <div style="flex:1">
                            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">
                                <strong style="font-size:13px">${escapeHTML(m.artist || '?')}</strong>
                                <span style="font-size:11px;color:#a1a1aa">${escapeHTML(sourceLabel)}${ageChip}</span>
                            </div>
                            <div style="font-size:11px;color:#a1a1aa;margin-bottom:4px">
                                ${escapeHTML(dateLabel)} · ${escapeHTML(m.category || 'NC')} · qty ${m.qty || '?'}
                            </div>
                            <div style="font-size:12px;margin-bottom:6px">
                                <strong>${m.price_per_place}€/place</strong>
                                <span style="color:#a1a1aa"> · total ${m.price_total}€</span>
                            </div>
                            <button data-copy="${i}" style="
                                padding:5px 10px;border-radius:6px;background:#3f3f46;color:#fff;
                                border:0;font-size:11px;cursor:pointer;font-weight:600
                            ">📋 Copy proposal</button>
                            <span data-copied="${i}" style="display:none;margin-left:8px;color:#22c55e;font-size:11px">✓ Copied</span>
                        </div>
                    </div>
                `;
            });
            body += `</div>`;
            body += `<div style="padding:8px 16px;font-size:10px;color:#52525b;border-top:1px solid #2c2c33">${data.debug?.inventory_count || 0} inv · ${data.debug?.discord_count || 0} disc · LLM ${data.debug?.llm_ms || '?'}ms · total ${data.debug?.total_ms || '?'}ms</div>`;
        }

        p.innerHTML = body;

        // Wire copy buttons
        p.querySelectorAll('[data-copy]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.getAttribute('data-copy'), 10);
                const text = matches[idx]?.proposal_text;
                if(!text) return;
                try {
                    if(typeof GM_setClipboard === 'function'){
                        GM_setClipboard(text, 'text');
                    } else {
                        navigator.clipboard.writeText(text);
                    }
                    const flag = p.querySelector(`[data-copied="${idx}"]`);
                    if(flag){
                        flag.style.display = 'inline';
                        setTimeout(() => { flag.style.display = 'none'; }, 1500);
                    }
                    log('copied proposal #' + idx);
                } catch (err) {
                    warn('clipboard failed', err);
                }
            });
        });
    }

    // ---- DOM extraction -----------------------------------------------------
    function getThreadHandle(){
        // The thread header has the @handle as a heading or link to the user's profile.
        // Try common patterns; prefer the link to /<handle>/ near the top of the page.
        const headerLinks = document.querySelectorAll('header a[role="link"], section a[role="link"]');
        for(const a of headerLinks){
            const href = a.getAttribute('href') || '';
            const m = href.match(/^\/([A-Za-z0-9._]+)\/?$/);
            if(m){
                const txt = (a.textContent || '').trim();
                if(txt && /^[A-Za-z0-9._]+$/.test(txt)) return txt.toLowerCase();
                return m[1].toLowerCase();
            }
        }
        // Fallback: any visible heading with an @-shaped name
        const headings = document.querySelectorAll('h1, h2, [role="heading"]');
        for(const h of headings){
            const t = (h.textContent || '').trim();
            if(/^[A-Za-z0-9._]+$/.test(t) && t.length >= 2 && t.length <= 30) return t.toLowerCase();
        }
        return '';
    }

    function findMessageList(){
        // Walk down from main looking for a scroller with many [role="row"] descendants
        const candidates = document.querySelectorAll('div[role="grid"], [aria-label*="Messages" i], [aria-label*="messages" i], main');
        for(const c of candidates){
            if(c.querySelectorAll('[role="row"], [role="listitem"]').length >= 2) return c;
        }
        return document.querySelector('main') || document.body;
    }

    function extractMessages(){
        const list = findMessageList();
        if(!list){ warn('no message list'); return []; }
        const rows = Array.from(list.querySelectorAll('[role="row"], [role="listitem"]'));
        if(!rows.length){ warn('no rows'); return []; }

        const parentRect = list.getBoundingClientRect();
        const centerX = parentRect.left + parentRect.width / 2;

        const out = [];
        for(const row of rows){
            const text = (row.innerText || '').trim();
            if(!text) continue;
            // Strip any embedded date/time labels Discord-style — IG occasionally
            // injects timestamps in row.innerText. Keep alphanumerics + punctuation.
            // Heuristic: long run of bullets or "Sent" markers => skip.
            if(/^(seen|sent|delivered|reactions?:)$/i.test(text)) continue;
            if(text.length > 1000) continue; // probably embed

            const r = row.getBoundingClientRect();
            const rowCenter = r.left + r.width / 2;
            const from = (rowCenter > centerX) ? 'me' : 'client';

            out.push({ from, text });
        }

        // De-duplicate consecutive identical entries (IG sometimes nests)
        const dedup = [];
        for(const m of out){
            const last = dedup[dedup.length - 1];
            if(last && last.from === m.from && last.text === m.text) continue;
            dedup.push(m);
        }

        return dedup.slice(-HISTORY_TURNS);
    }

    function getThreadId(){
        const m = location.pathname.match(/\/direct\/t\/(\d+)/);
        return m ? m[1] : '';
    }

    // ---- match request ------------------------------------------------------
    function fireMatch(reason){
        if(!isEnabled()){ log('skip fire (disabled):', reason); return; }
        if(inFlight){ log('skip fire (in flight):', reason); return; }
        if(!getThreadId()){ log('skip fire (not in a thread):', reason); return; }

        const conversation = extractMessages();
        if(!conversation.length){
            warn('skip fire (no conversation extracted) — IG DOM may have changed');
            renderError('Could not read conversation messages.');
            return;
        }

        const handle = getThreadHandle();
        log('firing match:', { reason, handle, msgs: conversation.length });

        renderLoading();
        inFlight = true;

        GM_xmlhttpRequest({
            method: 'POST',
            url: WEBHOOK_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
                client_handle: handle,
                conversation,
                thread_id: getThreadId(),
                fired_at: new Date().toISOString(),
                reason,
            }),
            timeout: 30000,
            onload: r => {
                inFlight = false;
                if(r.status < 200 || r.status >= 300){
                    warn('webhook non-2xx', r.status, r.responseText);
                    renderError('Server error ' + r.status);
                    return;
                }
                let data;
                try { data = JSON.parse(r.responseText); }
                catch(e){ warn('bad JSON', r.responseText); renderError('Bad JSON from n8n'); return; }
                // n8n may wrap or unwrap; tolerate both
                if(Array.isArray(data)) data = data[0]?.json || data[0] || data;
                if(data?.json) data = data.json;
                log('match result:', data);
                renderResults(data);
                lastFireAt = Date.now();
            },
            onerror: e => {
                inFlight = false;
                warn('webhook error', e);
                renderError('Network error');
            },
            ontimeout: () => {
                inFlight = false;
                warn('webhook timeout');
                renderError('Timeout');
            },
        });
    }

    // ---- auto-fire on new client message ------------------------------------
    function onMessagesMutated(){
        if(!isEnabled()) return;
        const since = Date.now() - lastFireAt;
        if(since < AUTO_COOLDOWN_MS){
            // schedule a recheck after the cooldown window
            return;
        }
        const conv = extractMessages();
        if(!conv.length) return;
        const last = conv[conv.length - 1];
        if(!last || last.from !== 'client') return;

        const sig = getThreadId() + '|' + last.text;
        if(sig === lastMessageSig) return;
        lastMessageSig = sig;

        if(last.text.length < 5 || TRIVIAL_RE.test(last.text.trim())){
            log('skip auto-fire (trivial):', last.text.slice(0, 30));
            return;
        }
        fireMatch('auto-new-client-msg');
    }

    function attachObserver(){
        if(observer){ observer.disconnect(); observer = null; }
        const list = findMessageList();
        if(!list) return;
        let timer = null;
        observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(onMessagesMutated, 800);
        });
        observer.observe(list, { childList: true, subtree: true, characterData: true });
        log('observer attached on', list);
    }

    // ---- thread change detection (IG is a SPA) ------------------------------
    function checkThreadChange(){
        const tid = getThreadId();
        if(tid !== currentThread){
            log('thread changed:', currentThread, '→', tid);
            currentThread = tid;
            lastMessageSig = '';
            hidePanel();
            attachObserver();
            if(isEnabled() && tid){
                // small delay to let messages render
                setTimeout(() => fireMatch('thread-open'), 600);
            }
        }
    }

    // Patch history methods so we get notified on SPA navigation
    (function patchHistory(){
        const _push = history.pushState;
        const _replace = history.replaceState;
        history.pushState = function(){ const r = _push.apply(this, arguments); window.dispatchEvent(new Event('lp2p-locchange')); return r; };
        history.replaceState = function(){ const r = _replace.apply(this, arguments); window.dispatchEvent(new Event('lp2p-locchange')); return r; };
        window.addEventListener('popstate', () => window.dispatchEvent(new Event('lp2p-locchange')));
        window.addEventListener('lp2p-locchange', () => setTimeout(checkThreadChange, 200));
    })();

    // ---- helpers ------------------------------------------------------------
    function escapeHTML(s){
        return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
            '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
        }[c]));
    }
    function frenchDate(iso){
        if(!iso) return '';
        const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if(!m) return iso;
        const months = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
        const day = parseInt(m[3], 10);
        const mon = months[parseInt(m[2], 10) - 1] || '';
        return `${day} ${mon}`;
    }
    function formatHoursAgo(h){
        if(h == null) return '';
        if(h < 1) return Math.round(h * 60) + 'min';
        if(h < 24) return Math.round(h) + 'h';
        return Math.round(h / 24) + 'j';
    }

    // ---- bootstrap ----------------------------------------------------------
    function boot(){
        log('IG DM Assist booting on', location.pathname);
        renderWidget();
        currentThread = getThreadId();
        attachObserver();
        if(isEnabled() && currentThread){
            setTimeout(() => fireMatch('boot'), 1000);
        }
    }

    // Wait a tick for IG to mount its main UI
    if(document.readyState === 'complete' || document.readyState === 'interactive'){
        setTimeout(boot, 600);
    } else {
        window.addEventListener('load', () => setTimeout(boot, 600));
    }
})();
