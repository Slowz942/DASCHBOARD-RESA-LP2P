/**
 * n8n Code node — body for the "IG DM Assist" workflow.
 *
 * Receives a conversation snippet from the operator's IG DM Assist
 * Tampermonkey userscript, parses the client's intent via Claude Haiku,
 * runs the inventory + Sourcing Discord matcher (same logic as
 * find-matches-and-notify.js), and returns the top 3 ranked proposals
 * with pre-built proposal_text per match.
 *
 * Webhook input shape:
 *   {
 *     client_handle: "karim_flb",
 *     conversation: [
 *       { from: "client", text: "..." },
 *       { from: "me",     text: "..." },
 *       ...
 *     ]
 *   }
 *
 * Output:
 *   {
 *     parsed: { artist, dates: [...], category, places, budget_max_per_place },
 *     matches: [
 *       {
 *         source: "inventory" | "discord",
 *         artist, date, category, qty,
 *         price_per_place, price_total,
 *         post_age_hours,           // discord only
 *         dateMatch: bool, score: number,
 *         proposal_text: "..."      // ready to paste
 *       },
 *       ... up to 3
 *     ],
 *     no_matches: bool,
 *     debug: { llm_ms, total_ms }
 *   }
 *
 * SETUP — edit the three lines marked >>> EDIT <<< below.
 */

// >>> EDIT THESE LINES <<<
const ANTHROPIC_API_KEY = 'PASTE_YOUR_ANTHROPIC_API_KEY_HERE';        // same key as parse-via-claude-full
const APPS_SCRIPT_URL   = 'https://script.google.com/macros/s/AKfycbwKCiudNgJU4RtPk-tCv5A33IX3TVtIEJAU_LwbmdhpXHPbWRqYoLbYDUWzkR12zkQ8Hw/exec';
const MODEL             = 'claude-3-5-haiku-20241022';
// <<< END EDIT >>>

const INVENTORY_SHEET_ID = '1jSQNoni7qW6ShnRw3hi_g_fF90qn5YZ3koRaL1gYTLE';
const DISCORD_SHEET_ID   = '10QzZ14S4fA5zuM-UyROwmsIKLcwPata6cVLN23bukW8';

const MIN_MARKUP  = 0.30;
const TOP_N       = 3;

const KNOWN_ARTISTS = ['JUL','SCH','NINHO','PNL','BOOBA','DAMSO','ORELSAN','CELINE DION','BAD BUNNY','DAVID GUETTA','BRUNO MARS','AYA NAKAMURA','TAME IMPALA','BTS','CIRCOLOCO','DRAKE','TRAVIS SCOTT','GIMS','JOSMAN','THEODORA','ROMY','STROMAE','ANGELE','NEKFEU','GAZO','SOPRANO','TAYC','DADJU','NISKA','HAMZA','SDM','PLK','WERENOI','TIAKOLA','DINOS','ZIAK','THE WEEKND','LAMANO','L2B','LUIDJI','FREEZE CORLEONE','LOMEPAL','FALLY IPUPA','CHARLIE PUTH','PINKPANTHERESS','HARRY STYLES','ARIANA GRANDE','SOLIDAYS','KEINEMUSIK','BON JOVI','LILY ALLEN','PATRICK BRUEL','THE STROKES','NEIGHBERHOOD'];

const FR_MONTHS = {janvier:'01','février':'02',fevrier:'02',mars:'03',avril:'04',mai:'05',juin:'06',juillet:'07','août':'08',aout:'08',septembre:'09',octobre:'10',novembre:'11','décembre':'12',decembre:'12'};

// ============== helpers (mirror of find-matches-and-notify.js) ==============

function normalizeArtist(a){
    if(!a) return '';
    let up = String(a).toUpperCase().trim()
        .replace(/[ÉÈÊË]/g,'E').replace(/[ÀÁÂÃÄ]/g,'A')
        .replace(/[ÌÍÎÏ]/g,'I').replace(/[ÒÓÔÕÖ]/g,'O')
        .replace(/[ÙÚÛÜ]/g,'U').replace(/[Ç]/g,'C');
    const ALIASES = {
        'BADBUNNY':'BAD BUNNY','BRUNOS MARS':'BRUNO MARS',
        'WEEKND':'THE WEEKND','WEEKEND':'THE WEEKND',
        'LA MANO':'LAMANO',
        'NEIGHBOURHOOD':'NEIGHBERHOOD','THE NEIGHBOURHOOD':'NEIGHBERHOOD',
        'NEIGHBORHOOD':'NEIGHBERHOOD','THE NEIGHBORHOOD':'NEIGHBERHOOD',
        'CELINE':'CELINE DION','DION':'CELINE DION',
        'BRUNO':'BRUNO MARS',
        'AYA':'AYA NAKAMURA','NAKAMURA':'AYA NAKAMURA',
        'TAME':'TAME IMPALA','IMPALA':'TAME IMPALA',
        'GUETTA':'DAVID GUETTA','DAVID':'DAVID GUETTA',
        'CHARLIE':'CHARLIE PUTH','PUTH':'CHARLIE PUTH',
        'HARRY':'HARRY STYLES','STYLES':'HARRY STYLES',
        'ARIANA':'ARIANA GRANDE','GRANDE':'ARIANA GRANDE',
        'PATRICK':'PATRICK BRUEL','BRUEL':'PATRICK BRUEL',
        'STROKES':'THE STROKES',
        'JOVI':'BON JOVI',
        'LILY':'LILY ALLEN','ALLEN':'LILY ALLEN',
        'IPUPA':'FALLY IPUPA','FALLY':'FALLY IPUPA',
        'PINK PANTHERESS':'PINKPANTHERESS',
    };
    return ALIASES[up] || up;
}

function normalizeCat(c){
    if(!c) return '';
    const up = String(c).toUpperCase().trim()
        .replace(/[ÉÈÊË]/g,'E').replace(/[ÀÁÂÃÄ]/g,'A');
    if(/N'IMPORTE|PAS DE PREFERENCE|PEU IMPORTE|TOUT|LIBRE|INDIFFERENT|AUCUN/.test(up)) return 'NC';
    const m = up.match(/CAT(?:EGORIE)?\.?\s*(\d+)/);
    if(m) return 'CAT ' + m[1];
    if(/FOSSE\s*OR/.test(up)) return 'FOSSE OR';
    if(/FOSSE/.test(up)) return 'FOSSE';
    if(/CAT\s*OR|OR\b/.test(up)) return 'CAT OR';
    if(/CARRE\s*OR/.test(up)) return 'CARRE OR';
    return up;
}

function looseCatMatch(a, b){
    if(!a || !b || a==='NC' || b==='NC') return true;
    const A = a.toUpperCase(), B = b.toUpperCase();
    if(A === B) return true;
    if(A.includes('FOSSE') && B.includes('FOSSE')) return true;
    if(A.includes('CARRE OR') && B.includes('CARRE OR')) return true;
    return false;
}

function parseFullCSV(text){
    const rows=[];let cur='',row=[],inQ=false;
    for(let i=0;i<text.length;i++){
        const c=text[i];
        if(c==='"'){
            if(inQ&&text[i+1]==='"'){cur+='"';i++;}
            else inQ=!inQ;
        } else if(c===','&&!inQ){row.push(cur);cur='';}
        else if(c==='\n'&&!inQ){row.push(cur);cur='';rows.push(row);row=[];}
        else if(c==='\r'){/* skip */}
        else cur+=c;
    }
    if(cur.length||row.length){row.push(cur);rows.push(row);}
    return rows.map(r=>r.map(c=>c.trim()));
}

// Inventory's Achat/Revente are TOTALS — convert to per-place.
function inventoryTotalsToPerPlace(it){
    if(!it) return it;
    const qty = it.qty || 1;
    if(qty>1){
        if(it.prixAchat) it.prixAchat = +(it.prixAchat / qty).toFixed(2);
        if(it.prixVente) it.prixVente = +(it.prixVente / qty).toFixed(2);
    }
    return it;
}

function toNum(v){
    if(v == null) return 0;
    const n = parseFloat(String(v).replace(/[^\d.,-]/g,'').replace(',','.'));
    return Number.isFinite(n) ? n : 0;
}

function parseDate(s){
    if(!s) return null;
    s = String(s).trim().toLowerCase();
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if(m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if(m){
        const d = m[1].padStart(2,'0'), mo = m[2].padStart(2,'0');
        let y = m[3]; if(y.length===2) y = '20'+y;
        return `${y}-${mo}-${d}`;
    }
    m = s.match(/(\d{1,2})\s+([a-zû]+)(?:\s+(\d{2,4}))?/i);
    if(m){
        const d = m[1].padStart(2,'0');
        const mo = FR_MONTHS[m[2].toLowerCase()] || null;
        if(!mo) return null;
        let y = m[3]; if(!y) y = String(new Date().getFullYear());
        if(y.length===2) y = '20'+y;
        return `${y}-${mo}-${d}`;
    }
    return null;
}

// ============== fetch inventory + sourcing ==============

async function fetchInventoryViaAppsScript(){
    const r = await this.helpers.httpRequest({
        method: 'GET', url: APPS_SCRIPT_URL, json: true,
    });
    const items = (r?.items || []).map(it => inventoryTotalsToPerPlace({
        artist:    normalizeArtist(it.artist || it.artiste || ''),
        date:      parseDate(it.date),
        category:  normalizeCat(it.cat || it.categorie || ''),
        qty:       parseInt(it.qty || it.quantite || it.places || '1', 10) || 1,
        prixAchat: toNum(it.achat),
        prixVente: toNum(it.revente || it.vente),
        statut:    it.statut || it.status || '',
        color:     it.color || it.couleur || '',
        raw:       it,
    }));
    return items.filter(it => {
        const s = (it.statut || '').toLowerCase();
        const c = (it.color || '').toLowerCase();
        const taken = /vendu|sold|reserved|reserve|hold|taken|partie/.test(s + ' ' + c);
        return !taken && (it.artist || it.date);
    });
}

async function fetchSourcingDiscord(){
    const url = `https://docs.google.com/spreadsheets/d/${DISCORD_SHEET_ID}/gviz/tq?tqx=out:csv`;
    const csv = await this.helpers.httpRequest({ method: 'GET', url });
    const rows = parseFullCSV(csv);
    if(rows.length < 2) return [];
    const headers = rows[0].map(h => h.toLowerCase().trim());
    const idx = (...names) => {
        for(const n of names){
            const i = headers.indexOf(n);
            if(i >= 0) return i;
        }
        return -1;
    };
    const iArtist  = idx('artist','artiste');
    const iDate    = idx('date');
    const iCat     = idx('category','categorie','cat');
    const iQty     = idx('qty','quantity','places');
    const iPrice   = idx('price_per_unit','prix','price');
    const iStatus  = idx('status','statut');
    const iPosted  = idx('posted_at','timestamp','date_post');
    const iAuthor  = idx('author','seller');

    const now = Date.now();
    const out = [];
    for(let i=1; i<rows.length; i++){
        const r = rows[i];
        if(!r || !r.length) continue;
        const status = (r[iStatus] || '').toLowerCase();
        if(/sold|vendu|taken|partie|done/.test(status)) continue;

        const artist = normalizeArtist(r[iArtist] || '');
        const date   = parseDate(r[iDate] || '');
        if(!artist && !date) continue;

        let postedAtMs = null;
        if(iPosted >= 0 && r[iPosted]){
            const t = Date.parse(r[iPosted]);
            if(!isNaN(t)) postedAtMs = t;
        }
        out.push({
            artist,
            date,
            category: normalizeCat(r[iCat] || ''),
            qty: parseInt(r[iQty] || '1', 10) || 1,
            prixVente: toNum(r[iPrice]),       // already per-place
            prixAchat: 0,
            statut: r[iStatus] || '',
            author: iAuthor >= 0 ? (r[iAuthor] || '') : '',
            post_age_hours: postedAtMs ? +((now - postedAtMs) / 3600000).toFixed(1) : null,
        });
    }
    return out;
}

// ============== matcher (mirror of find-matches-and-notify scoring) ==============

function findMatches(demand, inventory, discord){
    const out = [];
    const targetArtist = demand.artist || '';
    const targetCat    = demand.category || '';
    const targetDates  = demand.dates || [];
    const targetPlaces = demand.places || 1;

    const considerInv = inventory.map(it => ({...it, source: 'inventory'}));
    const considerDis = discord.map(it => ({...it, source: 'discord'}));

    const all = considerInv.concat(considerDis);

    for(const it of all){
        if(targetArtist && it.artist && targetArtist !== it.artist) continue;
        if(targetCat && targetCat !== 'NC' && !looseCatMatch(targetCat, it.category)) continue;

        let score = 0;
        if(it.artist === targetArtist) score += 50;
        if(it.qty >= targetPlaces) score += 20;
        if(looseCatMatch(targetCat, it.category)) score += 10;

        let dateMatch = false;
        if(targetDates.length && it.date){
            if(targetDates.includes(it.date)){ score += 30; dateMatch = true; }
        } else if(!targetDates.length){
            dateMatch = true; // no date constraint = treat all as "ok"
        }

        // Discord listings are per-place; inventory has been converted.
        const pricePerPlace = it.prixVente || 0;
        const total = +(pricePerPlace * targetPlaces).toFixed(2);

        // Skip clearly-low inventory (negative margin)
        if(it.source === 'inventory' && it.prixAchat && pricePerPlace < it.prixAchat * (1 + MIN_MARKUP)){
            score -= 5;
        }

        out.push({
            source: it.source,
            artist: it.artist,
            date: it.date,
            category: it.category || (targetCat || ''),
            qty: it.qty,
            price_per_place: pricePerPlace,
            price_total: total,
            post_age_hours: it.post_age_hours ?? null,
            dateMatch,
            score,
            _raw: it,
        });
    }

    // Sort: dateMatch first, then score
    out.sort((a, b) => {
        if(a.dateMatch !== b.dateMatch) return a.dateMatch ? -1 : 1;
        return b.score - a.score;
    });

    // Dedupe by (source, artist, date, category, price)
    const seen = new Set();
    const deduped = [];
    for(const m of out){
        const key = `${m.source}|${m.artist}|${m.date}|${m.category}|${m.price_per_place}`;
        if(seen.has(key)) continue;
        seen.add(key);
        deduped.push(m);
    }

    return deduped;
}

function buildProposalText(match, demand){
    const places = demand.places || 1;
    const artistLabel = match.artist || demand.artist || '';
    const dateLabel = match.date ? frenchDate(match.date) : (demand.dates?.[0] ? frenchDate(demand.dates[0]) : '');
    const catLabel = match.category || demand.category || '';

    const pricePer = match.price_per_place;
    const total = match.price_total;

    const parts = [];
    parts.push(artistLabel ? `${artistLabel}` : '');
    parts.push(dateLabel ? `le ${dateLabel}` : '');
    parts.push(catLabel ? `en ${catLabel}` : '');
    const headline = parts.filter(Boolean).join(' ');

    const placesLabel = places === 1 ? 'la place' : `${places} places`;
    const priceLine = places === 1
        ? `Je te la propose à ${pricePer}EUR.`
        : `Je te les propose à ${pricePer}EUR/place soit ${total}EUR pour les ${places} places.`;

    return `Hey ! ${headline ? 'Pour ' + headline + ', ' : ''}j'ai ${placesLabel} de dispo. ${priceLine} Ca t'interesse ?`;
}

function frenchDate(iso){
    if(!iso) return '';
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return iso;
    const months = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];
    const day = parseInt(m[3], 10);
    const mon = months[parseInt(m[2], 10) - 1] || '';
    return `${day} ${mon}`;
}

// ============== Claude Haiku parser ==============

async function parseConversationViaClaude(conversation, clientHandle){
    const transcript = conversation
        .map(m => `${m.from === 'me' ? 'OPERATOR' : 'CLIENT'}: ${m.text}`)
        .join('\n');

    const system = `You parse Instagram DM conversations between a French ticket reseller (the OPERATOR) and a CLIENT looking to buy resale concert/event tickets. The conversation may be in French, English, or mixed. You extract the CLIENT's current request as structured data.

Return ONLY valid JSON, no markdown, no commentary. Schema:
{
  "artist": "<canonical artist name in caps, or empty string if unknown>",
  "dates": ["<YYYY-MM-DD>", ...],   // event date(s) the client mentions; can be multiple if flexible
  "category": "<FOSSE | FOSSE OR | CARRE OR | CAT OR | CAT 1 | CAT 2 | CAT 3 | CAT 4 | NC>",
  "places": <integer, default 1>,
  "budget_max_per_place": <number or null>
}

Known artists (use the canonical form): ${KNOWN_ARTISTS.join(', ')}.
Aliases: "Celine"→"CELINE DION", "Bruno"→"BRUNO MARS", "Aya"→"AYA NAKAMURA", "Weekend"→"THE WEEKND".
French months: janvier=01 ... décembre=12. If year is missing, assume the next occurrence (current year if month not yet passed; next year otherwise; current year is ${new Date().getFullYear()}).
Categories: "Catégorie 1"/"Cat 1"/"C1"→"CAT 1". "Fosse Or"→"FOSSE OR". "Fosse"→"FOSSE". "Carré Or"/"Carre Or"→"CARRE OR". "Cat Or"/"Or"→"CAT OR". If not specified or "n'importe"/"libre"→"NC".
Places: parse "2 places", "duo", "trio"=3. Default to 1 if absent.

If multiple plausible interpretations, pick the one most recently expressed by the CLIENT.`;

    const userMsg = `Client handle: @${clientHandle || 'unknown'}\n\nConversation (latest at bottom):\n${transcript}\n\nReturn JSON only.`;

    const t0 = Date.now();
    let resp;
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
                max_tokens: 400,
                system,
                messages: [{ role: 'user', content: userMsg }],
            },
            json: true,
        });
    } catch (err) {
        const body = err?.response?.body || err?.response?.data || err?.cause?.response?.body || err?.message || String(err);
        throw new Error('Anthropic call failed: ' + (typeof body === 'string' ? body : JSON.stringify(body)));
    }
    const llmMs = Date.now() - t0;

    let payload = resp;
    if(typeof resp === 'string'){
        try { payload = JSON.parse(resp); } catch (_) { payload = { content: [{ text: resp }] }; }
    }
    const text = payload?.content?.[0]?.text || '';
    let parsed;
    try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (e) {
        throw new Error('Failed to parse LLM JSON: ' + text);
    }

    return {
        parsed: {
            artist: normalizeArtist(parsed.artist || ''),
            dates: Array.isArray(parsed.dates) ? parsed.dates.filter(Boolean) : [],
            category: normalizeCat(parsed.category || 'NC'),
            places: parseInt(parsed.places || 1, 10) || 1,
            budget_max_per_place: parsed.budget_max_per_place || null,
        },
        llm_ms: llmMs,
    };
}

// ============== main ==============

async function run(){
    const t0 = Date.now();
    const items = $input.all();
    const body = items[0]?.json?.body || items[0]?.json || {};

    const clientHandle = String(body.client_handle || body.handle || '').replace(/^@/, '').toLowerCase();
    const conversation = Array.isArray(body.conversation) ? body.conversation : [];

    if(!conversation.length){
        return [{ json: { error: 'empty_conversation', parsed: null, matches: [] } }];
    }

    const { parsed, llm_ms } = await parseConversationViaClaude.call(this, conversation, clientHandle);

    const [inventory, discord] = await Promise.all([
        fetchInventoryViaAppsScript.call(this),
        fetchSourcingDiscord.call(this),
    ]);

    const demand = {
        artist: parsed.artist,
        dates: parsed.dates,
        category: parsed.category,
        places: parsed.places,
    };

    const matches = findMatches(demand, inventory, discord);
    const top = matches.slice(0, TOP_N).map(m => ({
        ...m,
        proposal_text: buildProposalText(m, demand),
    }));

    return [{
        json: {
            client_handle: clientHandle,
            parsed,
            matches: top,
            no_matches: top.length === 0,
            debug: { llm_ms, total_ms: Date.now() - t0, inventory_count: inventory.length, discord_count: discord.length },
        },
    }];
}

return run.call(this);
