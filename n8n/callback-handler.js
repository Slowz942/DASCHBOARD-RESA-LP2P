/**
 * n8n Code node — runs after a Telegram Trigger fires on a callback_query.
 *
 * Wire:
 *    [Telegram Trigger]   ← updates filter: callback_query
 *        ↓
 *    [THIS Code node]     ← parses callback_data, refetches sheets, rebuilds the proposal
 *        ↓
 *    [Telegram sendMessage]   ← bot DMs you the ready-to-paste proposal
 *
 * For Phase 4 the bot just sends YOU back the proposal text formatted as if
 * you were going to copy-paste it into Instagram. In Phase 5 we'll swap the
 * final Telegram node for ManyChat / IG DM API to fire it directly.
 *
 * The callback_data we set in find-matches-and-notify.js is:
 *    'p:<s|d>:<idx>:<demandHash>'   (propose option <idx> from source)
 *    'n:<demandHash>'               (no option / dismiss)
 *
 * Because n8n cloud has no shared state between executions, this Code node
 * RE-RUNS the same matching logic as the notification builder to reconstruct
 * the match by (demandHash, idx). Slightly more work per click but stateless
 * and reliable.
 */

const INVENTORY_SHEET_ID = '1jSQNoni7qW6ShnRw3hi_g_fF90qn5YZ3koRaL1gYTLE';
const DISCORD_SHEET_ID   = '10QzZ14S4fA5zuM-UyROwmsIKLcwPata6cVLN23bukW8';
const APPS_SCRIPT_URL    = 'https://script.google.com/macros/s/AKfycbwKCiudNgJU4RtPk-tCv5A33IX3TVtIEJAU_LwbmdhpXHPbWRqYoLbYDUWzkR12zkQ8Hw/exec';
const MIN_MARKUP  = 0.30;
const MAX_OPTIONS = 8;

// IMPORTANT: the demandHash is built from (nom, instagram, submittedAt) at
// notification time. Phase 4 is best-effort: when you tap a button the bot
// sends back the proposal for the most recent demand whose hash matches,
// resolved against the LATEST CRM-clients sheet. That covers the common case
// (you tap quickly after the demand lands). If you need watertight pairing
// later, write the demandHash → demand record into a small "callbacks" sheet
// in the notification flow and read it here.
const CRM_SHEET_ID = ''; // optional — fill if you want exact lookup

const KNOWN_ARTISTS = ['JUL','SCH','NINHO','PNL','BOOBA','DAMSO','ORELSAN','CELINE DION','CÉLINE DION','BAD BUNNY','BADBUNNY','DAVID GUETTA','BRUNO MARS','BRUNOS MARS','AYA NAKAMURA','AYA','TAME IMPALA','BTS','CIRCOLOCO','DRAKE','TRAVIS SCOTT','GIMS','JOSMAN','THEODORA','ROMY','STROMAE','ANGELE','NEKFEU','GAZO','SOPRANO','TAYC','DADJU','NISKA','HAMZA','SDM','PLK','WERENOI','TIAKOLA','DINOS','ZIAK','THE WEEKND','WEEKND','LAMANO','LA MANO','L2B','LUIDJI','FREEZE CORLEONE','LOMEPAL','FALLY IPUPA','CHARLIE PUTH','PINKPANTHERESS','HARRY STYLES','ARIANA GRANDE','SOLIDAYS','KEINEMUSIK','BON JOVI','LILY ALLEN','PATRICK BRUEL','THE STROKES','NEIGHBERHOOD','THE NEIGHBOURHOOD'];

const FR_MONTHS = {janvier:'01','février':'02',fevrier:'02',mars:'03',avril:'04',mai:'05',juin:'06',juillet:'07','août':'08',aout:'08',septembre:'09',octobre:'10',novembre:'11','décembre':'12',decembre:'12'};

// ============== helpers (same as notification builder) ==============

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
function parseFullCSV(text){
    const rows=[];let cur='',row=[],inQ=false;
    for(let i=0;i<text.length;i++){
        const c=text[i];
        if(c==='"'){ if(inQ&&text[i+1]==='"'){cur+='"';i++;} else inQ=!inQ; }
        else if(c===','&&!inQ){row.push(cur);cur='';}
        else if(c==='\n'&&!inQ){row.push(cur);cur='';rows.push(row);row=[];}
        else if(c==='\r'){}
        else cur+=c;
    }
    if(cur.length||row.length){row.push(cur);rows.push(row);}
    return rows.map(r=>r.map(c=>c.trim()));
}
function inventoryTotalsToPerPlace(it){
    if(!it) return it;
    const qty=it.qty||1;
    if(qty>1){
        if(it.prixAchat) it.prixAchat=+(it.prixAchat/qty).toFixed(2);
        if(it.prixVente) it.prixVente=+(it.prixVente/qty).toFixed(2);
    }
    return it;
}

function parseInvRow(nom, achat, revente, benef){
    const raw=(nom||'').replace(/\r/g,'').trim();
    if(!raw) return null;
    const oneLine=raw.replace(/\n/g,' ');
    const up=oneLine.toUpperCase();
    if(/\b(DOUDOUNE|JOTT|NEW BALANCE|COFFRET|POKEMON|EVOLUTION PRISMATIQUE)\b/.test(up)) return null;
    let artist='';
    for(const a of KNOWN_ARTISTS){
        const re=new RegExp('\\b'+a.replace(/ /g,'\\s+')+'\\b');
        if(re.test(up)){ artist=normalizeArtist(a); break; }
    }
    let cat='NC';
    if(/\bFOSSES?\s+OR\b/.test(up)) cat='FOSSE OR';
    else if(/\bFOSSES?\b/.test(up)) cat='FOSSE';
    else if(/\bCAT\s*OR\b/.test(up)) cat='CAT OR';
    else {
        const cm=up.match(/\bCAT[EÉ]?G?O?R?I?E?\s*(\d)\b/) || up.match(/\bCAT\s*(\d)\b/);
        if(cm) cat='CAT '+cm[1];
        else if(/\bVIP\b|\bDIAMANT\b|\bCARR[EÉ]\s+OR\b/.test(up)) cat='VIP';
        else if(/\bPARTERRE\b/.test(up)) cat='PARTERRE';
        else if(/\bGRADIN\b/.test(up)) cat='GRADIN';
        else if(/\bANNEX\b/.test(up)) cat='ANNEX';
    }
    let qty=1;
    const qm1=up.match(/\bX\s*(\d+)/) || up.match(/^(\d+)\s*X\b/);
    if(qm1) qty=parseInt(qm1[1])||1;
    if(/\bDUO\b/.test(up) && qty<2) qty=2;
    if(/\bSOLO\b/.test(up)) qty=1;
    let dateMonth=null, dateDay=null, dateLabel='';
    const dm=oneLine.match(/\b(\d{1,2})\s+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\b/i);
    if(dm){ dateDay=dm[1].padStart(2,'0'); dateMonth=FR_MONTHS[dm[2].toLowerCase()]||null; dateLabel=dm[1]+' '+dm[2]; }
    const cleanName=raw.split('\n')[0].trim();
    const prixAchat=parseFloat((achat||'').toString().replace(',','.'))||0;
    const prixVente=parseFloat((revente||'').toString().replace(',','.'))||0;
    const benefVal=parseFloat((benef||'').toString().replace(',','.'))||(prixVente-prixAchat);
    return { raw, cleanName, artist, cat, qty, dateMonth, dateDay, dateLabel, prixAchat, prixVente, benef:benefVal, available:true, stockStatus:'unknown' };
}
function classifyColor(hex){
    if(!hex) return 'unknown';
    const h=hex.toString().trim().toLowerCase();
    if(!h||h==='#ffffff'||h==='#000000'||h==='transparent') return 'unknown';
    const m=h.match(/^#?([0-9a-f]{6})$/);
    if(!m) return 'unknown';
    const r=parseInt(m[1].slice(0,2),16),g=parseInt(m[1].slice(2,4),16),b=parseInt(m[1].slice(4,6),16);
    if(r>240&&g>240&&b>240) return 'unknown';
    if(g>r+12&&g>b+12) return 'sold';
    if(r>g+12&&r>b+12) return 'inStock';
    return 'unknown';
}
function looseCatMatch(a,b){
    const A=String(a||'').toUpperCase(),B=String(b||'').toUpperCase();
    if(!A||!B) return false;
    if(A===B) return true;
    if(A.includes('FOSSE')&&B.includes('FOSSE')) return true;
    const aN=A.match(/CAT\s*(\d)/), bN=B.match(/CAT\s*(\d)/);
    if(aN&&bN) return aN[1]===bN[1];
    if(A.includes('CAT OR')&&B.includes('CAT OR')) return true;
    return false;
}
function isNoPrefCat(cat){
    if(!cat) return true;
    const c=String(cat).toLowerCase().trim();
    if(!c||c==='nc'||c==='—'||c==='-'||c==='na'||c==='n/a') return true;
    return /n.?importe|peu importe|pas de pr[eé]f|aucun.*pr[eé]f|toute.*dispo|tout.*disp|sans pr[eé]f|libre|whatever|^any$|^all$|no preference|toute cat|peu m.imp/.test(c);
}
function normalizeCat(cat){
    if(isNoPrefCat(cat)) return 'NC';
    let c=String(cat).toUpperCase().trim();
    c = c.replace(/CATÉGORIE/g,'CAT').replace(/CATEGORIE/g,'CAT').replace(/CAT\./g,'CAT').replace(/\s+/g,' ').trim();
    return c||'NC';
}
function demandMeta(d){
    const artist=normalizeArtist(d.artist||'');
    const cat=normalizeCat(d.cat||'');
    const catNC=cat==='NC';
    const nbPlaces=parseInt((d.places||'1').toString().replace(/[^\d]/g,''))||1;
    const s=(d.dateDisp||d.dateEvent||'');
    let dateMonth=null,dateDay=null;
    const dm=s.match(/\b(\d{1,2})\s+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre|jan|fev|fév|avr|jui|juil|aou|sep|oct|nov|dec|déc)/i);
    if(dm){ dateDay=dm[1].padStart(2,'0'); const k=dm[2].toLowerCase(); dateMonth=FR_MONTHS[k]||FR_MONTHS[Object.keys(FR_MONTHS).find(x=>x.startsWith(k))||'']||null; }
    else { const dm2=s.match(/\b(\d{1,2})\/(\d{1,2})\b/); if(dm2){ dateDay=dm2[1].padStart(2,'0'); dateMonth=dm2[2].padStart(2,'0'); } }
    return {artist,cat,catNC,nbPlaces,dateMonth,dateDay};
}
function suggestedSellPrice(m){
    const achat=m.prixAchat||0;
    const floor=Math.ceil(achat*(1+MIN_MARKUP));
    return Math.max(m.prixVente||0,floor);
}
function dedupeMatches(arr){
    const seen=new Set();
    const out=[];
    for(const m of arr){
        const id=[m.source,m.seller||m.cleanName||'',m.cat||'',m.qty||'',m.prixAchat||'',m.dateLabel||m.eventDateIso||''].join('|');
        if(seen.has(id)) continue;
        seen.add(id);
        out.push(m);
    }
    return out;
}
function isSameDateAsDemand(item, m){
    if(!m.dateMonth) return true;
    if(!item.dateMonth) return false;
    if(item.dateMonth !== m.dateMonth) return false;
    if(m.dateDay && item.dateDay && item.dateDay !== m.dateDay) return false;
    return true;
}
async function fetchInventory(){
    if(APPS_SCRIPT_URL){
        const r = await this.helpers.httpRequest({ method:'GET', url: APPS_SCRIPT_URL+'?t='+Date.now(), json:true });
        const out=[];
        (r||[]).forEach(row=>{
            const nom=(row.values&&row.values[0])||'';
            const low=nom.toString().toLowerCase().trim();
            if(!low||low==='nom'||low.includes('total')||low.includes('valeur')||low.includes('treso')||low.includes('revolut')||low.includes('paypal')||low.includes('cash')||low.includes('à sourcer')||low.includes('a sourcer')) return;
            const it=parseInvRow(nom,row.values[1],row.values[2],row.values[3]);
            if(!it) return;
            inventoryTotalsToPerPlace(it);
            it.bgColor=row.color||''; it.stockStatus=classifyColor(row.color); it.available=(it.stockStatus!=='sold');
            out.push(it);
        });
        return out;
    }
    const r = await this.helpers.httpRequest({ method:'GET', url:'https://docs.google.com/spreadsheets/d/'+INVENTORY_SHEET_ID+'/gviz/tq?tqx=out:csv&t='+Date.now() });
    const rows=parseFullCSV((r||'').replace(/^﻿/,''));
    const out=[];
    rows.forEach(cols=>{
        if(!cols.length) return;
        const nom=cols[0]||'';
        const low=nom.toLowerCase().trim();
        if(!low||low==='nom'||low.includes('total')||low.includes('valeur')||low.includes('treso')||low.includes('revolut')||low.includes('paypal')||low.includes('cash')||low.includes('à sourcer')||low.includes('a sourcer')) return;
        const it=parseInvRow(nom,cols[1],cols[2],cols[3]);
        if(it){ inventoryTotalsToPerPlace(it); it.stockStatus='unknown'; it.available=true; out.push(it); }
    });
    return out;
}
async function fetchDiscord(){
    const r = await this.helpers.httpRequest({ method:'GET', url:'https://docs.google.com/spreadsheets/d/'+DISCORD_SHEET_ID+'/gviz/tq?tqx=out:csv&t='+Date.now() });
    const rows=parseFullCSV((r||'').replace(/^﻿/,''));
    if(!rows.length) return [];
    const header=rows[0].map(h=>(h||'').trim().toLowerCase());
    const idx=name=>header.indexOf(name);
    const cI=idx('listing_id'),sH=idx('seller_handle'),sI=idx('seller_id'),aR=idx('artist'),dI=idx('event_date_iso'),dL=idx('event_label'),cT=idx('category'),qT=idx('quantity'),pU=idx('price_per_unit'),pT=idx('price_total'),bL=idx('block'),nT=idx('notes'),mI=idx('message_id'),pA=idx('posted_at'),sA=idx('scraped_at'),sT=idx('status');
    const out=[];
    for(let i=1;i<rows.length;i++){
        const cols=rows[i]; if(!cols||!cols.length) continue;
        const artist=normalizeArtist((cols[aR]||'').trim());
        if(!artist||['PARSE_ERROR','NO_LISTING','NO_MESSAGES_IN_INPUT'].includes(artist)) continue;
        const status=((cols[sT]||'').toString().toLowerCase());
        const isUnavailable=/taken|sold|vendu|unavailable|gone|reserved|reserv[eé]/i.test(status);
        let dateMonth=null,dateDay=null;
        const iso=(cols[dI]||'').trim();
        const isoM=iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if(isoM){ dateMonth=isoM[2]; dateDay=isoM[3]; }
        else { const label=cols[dL]||''; const dm=label.match(/\b(\d{1,2})\s+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\b/i); if(dm){ dateDay=dm[1].padStart(2,'0'); dateMonth=FR_MONTHS[dm[2].toLowerCase()]||null; } else { const dm2=label.match(/\b(\d{1,2})\/(\d{1,2})\b/); if(dm2){ dateDay=dm2[1].padStart(2,'0'); dateMonth=dm2[2].padStart(2,'0'); } } }
        const cat=(cols[cT]||'NC').toString().toUpperCase().trim();
        const qty=parseInt(cols[qT])||1;
        const ppu=parseFloat((cols[pU]||'').toString().replace(',','.'))||0;
        const total=parseFloat((cols[pT]||'').toString().replace(',','.'))||null;
        const seller=(cols[sH]||'').trim();
        const block=(cols[bL]||'').trim()||null;
        const cleanName=[qty>1?'x'+qty:'',cat&&cat!=='NC'?cat:'',artist,cols[dL]||'',block?'('+block+')':''].filter(Boolean).join(' ').trim();
        out.push({ listingId:cols[cI]||'', source:'discord', seller, sellerId:(cols[sI]||'').trim(), artist, cat, qty, dateMonth, dateDay, dateLabel:(cols[dL]||'').trim(), prixAchat:ppu, prixVente:0, priceTotal:total, block, notes:(cols[nT]||'').trim(), cleanName, messageId:mI>=0?(cols[mI]||'').trim():'', postedAt:pA>=0?(cols[pA]||'').trim():'', scrapedAt:sA>=0?(cols[sA]||'').trim():'', status, available:!isUnavailable, stockStatus:'discord' });
    }
    return out;
}

// ============== MAIN ==============

const update = $input.first().json;
const cb = update.callback_query || update;
const callbackData = cb?.data || cb?.callback_query?.data || '';
const chatId = cb?.message?.chat?.id || cb?.from?.id || cb?.chat?.id;
const callbackId = cb?.id;

if (!callbackData) {
    return [{ json: { skip: true, reason: 'no callback_data' } }];
}

// Parse: 'p:<src>:<idx>:<hash>' or 'n:<hash>'
const parts = callbackData.split(':');
const action = parts[0];

if (action === 'n') {
    return [{
        json: {
            chat_id: chatId,
            callback_query_id: callbackId,
            telegram_text: '❌ <i>Demande ignorée.</i>',
        },
    }];
}

if (action !== 'p' || parts.length < 4) {
    return [{ json: { chat_id: chatId, callback_query_id: callbackId, telegram_text: '⚠️ Bouton invalide.' } }];
}

const src = parts[1];          // 's' or 'd'
const idx = parseInt(parts[2]);
const demandHash = parts.slice(3).join(':');

// Reconstruct the demand from the original Telegram message (the bot put the
// demand summary in the body of the message containing the button). We grab
// it from cb.message.text and parse out artist/places/dateDisp/cat.
const msgText = cb?.message?.text || cb?.message?.caption || '';

function parseDemandFromMessage(t){
    // Extract by emoji-prefixed lines. We look for the FIRST line per emoji
    // that doesn't match a title/header word, so changes to the heading
    // don't poison the parsed fields.
    const out={};
    const lines = (t || '').split('\n');
    const findLine = (emoji, skipPattern) => {
        for (const line of lines) {
            const m = line.match(new RegExp(emoji + '\\s+(.+?)\\s*$'));
            if (!m) continue;
            const val = m[1].trim();
            if (skipPattern && skipPattern.test(val)) continue;
            return val;
        }
        return '';
    };
    out.client    = findLine('👤');
    // Instagram handle is appended to the client line as @handle (or in <code>)
    const ig = (t.match(/@[a-zA-Z0-9_.]+/) || [])[0] || '';
    out.instagram = ig;
    if (ig) out.client = out.client.replace(ig, '').trim();
    out.artist    = findLine('🎤', /^Nouvelle/i);
    out.dateDisp  = findLine('📅');
    out.cat       = findLine('🎫', /^Nouvelle/i) || 'NC';
    const placesLine = findLine('📍');
    out.places    = parseInt((placesLine.match(/\d+/) || ['1'])[0]);
    return out;
}

const demand = parseDemandFromMessage(msgText);

// Refetch sheets, run the matcher, take the same top match by index.
let inventory=[], discord=[];
try { inventory = await fetchInventory.call(this); } catch(e){ console.error('inv fetch failed', e.message||e); }
try { discord = await fetchDiscord.call(this); } catch(e){ console.error('discord fetch failed', e.message||e); }

const m = demandMeta(demand);
const catAccepts = (it) => m.catNC || it.cat===m.cat || looseCatMatch(m.cat,it.cat);
const all = [];
inventory.forEach(it=>{ if(!it.available||it.artist!==m.artist) return; if(!catAccepts(it)) return; let sc=10; if(it.cat===m.cat) sc+=15; else if(m.catNC) sc+=3; else if(looseCatMatch(m.cat,it.cat)) sc+=8; if(m.dateMonth&&it.dateMonth&&m.dateMonth===it.dateMonth){sc+=6; if(m.dateDay&&it.dateDay&&m.dateDay===it.dateDay) sc+=8;} if(!it.prixAchat) sc-=2; if(it.stockStatus==='inStock') sc+=5; all.push({...it,source:'stock',score:sc}); });
discord.forEach(it=>{ if(!it.available||it.artist!==m.artist) return; if(!catAccepts(it)) return; let sc=8; if(it.cat===m.cat) sc+=15; else if(m.catNC) sc+=3; else if(looseCatMatch(m.cat,it.cat)) sc+=8; if(m.dateMonth&&it.dateMonth&&m.dateMonth===it.dateMonth){sc+=6; if(m.dateDay&&it.dateDay&&m.dateDay===it.dateDay) sc+=8;} if(!it.prixAchat) sc-=2; all.push({...it,source:'discord',score:sc}); });
all.forEach(o => { o.dateMatch = isSameDateAsDemand(o, m); });
all.sort((a,b) => {
    if(a.dateMatch !== b.dateMatch) return (b.dateMatch?1:0) - (a.dateMatch?1:0);
    return b.score - a.score;
});
const top = dedupeMatches(all).slice(0, MAX_OPTIONS);
const chosen = top[idx];

if (!chosen) {
    return [{ json: { chat_id: chatId, callback_query_id: callbackId, telegram_text: '⚠️ Option introuvable (la liste a changé).' } }];
}

// Build the proposal message exactly the way the dashboard's
// buildProposalMessage() does — same wording so client-facing copy is
// identical whether you tap from Telegram or click in the dashboard.
const sugg = suggestedSellPrice(chosen);
const benef = sugg - (chosen.prixAchat||0);
const pct = chosen.prixAchat ? ((benef/chosen.prixAchat)*100).toFixed(0) : '?';
const name = (demand.client||'').split('(')[0].trim();
const cat = chosen.cat && chosen.cat !== 'NC' ? chosen.cat : (demand.cat||'');
const dateLbl = demand.dateDisp || chosen.dateLabel || '';

// Per-place + buyer-total breakdown.
const buyerPlaces = parseInt((demand.places||'1').toString().replace(/[^\d]/g,''))||1;
const totalCost = chosen.prixAchat ? Math.round(chosen.prixAchat*buyerPlaces) : 0;
const totalSell = Math.round(sugg*buyerPlaces);
const showTot = buyerPlaces > 1;

const priceClause = showTot
    ? `${sugg}EUR/place soit ${totalSell}EUR pour les ${buyerPlaces} places`
    : `${sugg}EUR`;

const proposal = `Salut ${name}! J'ai trouve pour ${demand.artist}${dateLbl?' ('+dateLbl+')':''}${cat?' en '+cat:''}. Je te la propose a ${priceClause}. Ca t'interesse ?`;

const escHtml = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
let summary  = '✅ <b>Option sélectionnée</b>\n';
summary += '━━━━━━━━━━━━━━━━━━━\n';
summary += chosen.source === 'discord'
    ? `🟦 <b>DISCORD</b> · @${escHtml(chosen.seller)}\n`
    : `🟢 <b>STOCK</b>\n`;
summary += `   ${escHtml(chosen.cleanName)}\n`;
summary += `   ${chosen.source==='discord'?'Vendeur':'Achat'} <b>${chosen.prixAchat}€/place</b>${showTot?' (total '+totalCost+'€)':''}\n`;
summary += `   → propose <b>${sugg}€/place</b>${showTot?' = total <b>'+totalSell+'€</b>':''} (+${pct}%)\n\n`;
summary += `📋 <b>À envoyer au client (copy):</b>\n<code>${escHtml(proposal)}</code>`;

return [{
    json: {
        chat_id: chatId,
        callback_query_id: callbackId,
        telegram_text: summary,
        // Useful downstream context if you wire ManyChat in Phase 5
        client: demand.client,
        instagram: demand.instagram,
        proposal_text: proposal,
        sell_price: sugg,
        buy_price: chosen.prixAchat,
        listing: chosen,
    },
}];
