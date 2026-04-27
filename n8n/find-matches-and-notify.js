/**
 * n8n Code node — runs after "format message" (the Tally email parser).
 *
 * Builds the rich Telegram notification (demand summary + inline keyboard
 * with up to 8 proposable options pulled from the Inventory and the
 * Sourcing Discord sheets) AND fires it directly to Telegram.
 *
 * Why fire the Telegram call from this Code node instead of the downstream
 * Telegram node: n8n's Telegram "Reply Markup" parameter is a structured
 * dropdown (None/Force Reply/Inline Keyboard/Reply Keyboard) — there's no
 * clean way to pass a dynamic 1-8-button keyboard built at runtime. Calling
 * api.telegram.org/bot<token>/sendMessage from here gives full control.
 *
 * SETUP:
 *   1. EDIT the three lines marked >>> EDIT <<< below.
 *   2. Drop this Code node right after "format message".
 *   3. The existing "sourcing request messsage" Telegram node is now
 *      redundant — disable or delete it (right-click → Disable). Other
 *      branches (CRM sheet update, etc.) keep working as before.
 *
 * Output: the Code node still emits demand / top_matches / etc. as JSON so
 * any downstream nodes you keep can use them.
 */

// >>> EDIT THESE THREE LINES <<<
const TELEGRAM_BOT_TOKEN = 'PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE'; // from BotFather (looks like 1234567890:ABC...)
const TELEGRAM_CHAT_ID   = '5135913166';                          // your personal chat with the bot
const APPS_SCRIPT_URL    = 'https://script.google.com/macros/s/AKfycbwKCiudNgJU4RtPk-tCv5A33IX3TVtIEJAU_LwbmdhpXHPbWRqYoLbYDUWzkR12zkQ8Hw/exec'; // leave as-is (your inventory Apps Script)
// <<< END EDIT >>>

const INVENTORY_SHEET_ID = '1jSQNoni7qW6ShnRw3hi_g_fF90qn5YZ3koRaL1gYTLE';
const DISCORD_SHEET_ID   = '10QzZ14S4fA5zuM-UyROwmsIKLcwPata6cVLN23bukW8';

const MIN_MARKUP  = 0.30;
const MAX_OPTIONS = 8; // Telegram inline keyboard, ~8 rows = clean

const KNOWN_ARTISTS = ['JUL','SCH','NINHO','PNL','BOOBA','DAMSO','ORELSAN','CELINE DION','CÉLINE DION','BAD BUNNY','BADBUNNY','DAVID GUETTA','BRUNO MARS','BRUNOS MARS','AYA NAKAMURA','AYA','TAME IMPALA','BTS','CIRCOLOCO','DRAKE','TRAVIS SCOTT','GIMS','JOSMAN','THEODORA','ROMY','STROMAE','ANGELE','NEKFEU','GAZO','SOPRANO','TAYC','DADJU','NISKA','HAMZA','SDM','PLK','WERENOI','TIAKOLA','DINOS','ZIAK','THE WEEKND','WEEKND','LAMANO','LA MANO','L2B','LUIDJI','FREEZE CORLEONE','LOMEPAL','FALLY IPUPA','CHARLIE PUTH','PINKPANTHERESS','HARRY STYLES','ARIANA GRANDE','SOLIDAYS','KEINEMUSIK','BON JOVI','LILY ALLEN','PATRICK BRUEL','THE STROKES','NEIGHBERHOOD','THE NEIGHBOURHOOD'];

const FR_MONTHS = {janvier:'01','février':'02',fevrier:'02',mars:'03',avril:'04',mai:'05',juin:'06',juillet:'07','août':'08',aout:'08',septembre:'09',octobre:'10',novembre:'11','décembre':'12',decembre:'12'};

// ============== helpers (ported from index.html) ==============

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
    if(dm){
        dateDay=dm[1].padStart(2,'0');
        dateMonth=FR_MONTHS[dm[2].toLowerCase()]||null;
        dateLabel=dm[1]+' '+dm[2];
    } else {
        const mo=oneLine.match(/\b(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\b/i);
        if(mo){ dateMonth=FR_MONTHS[mo[1].toLowerCase()]||null; dateLabel=mo[1]; }
    }
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
    else if(d.dateEvent){ const p=d.dateEvent.split('-'); if(p.length>=2){ dateMonth=p[1]; dateDay=p[2]||null; } }
    else {
        const dm2=s.match(/\b(\d{1,2})\/(\d{1,2})\b/);
        if(dm2){ dateDay=dm2[1].padStart(2,'0'); dateMonth=dm2[2].padStart(2,'0'); }
    }
    return {artist,cat,catNC,nbPlaces,dateMonth,dateDay};
}

function suggestedSellPrice(m){
    const achat=m.prixAchat||0;
    const floor=Math.ceil(achat*(1+MIN_MARKUP));
    const sheetPrice=m.prixVente||0;
    return Math.max(sheetPrice,floor);
}

// Drop visually identical matches: same seller (or same stock cleanName),
// same cat, same qty, same price, same date label.
function dedupeMatches(arr){
    const seen=new Set();
    const out=[];
    for(const m of arr){
        const id=[
            m.source,
            m.seller || m.cleanName || '',
            m.cat || '',
            m.qty || '',
            m.prixAchat || '',
            m.dateLabel || m.eventDateIso || '',
        ].join('|');
        if(seen.has(id)) continue;
        seen.add(id);
        out.push(m);
    }
    return out;
}

// Human-friendly relative time: "il y a 2h" / "hier" / "il y a 3j" / "le 26/04"
function formatPostedAt(iso){
    if(!iso) return '';
    const d=new Date(iso);
    if(isNaN(d.getTime())) return '';
    const diffH=Math.floor((Date.now()-d.getTime())/3600000);
    if(diffH<1) return 'il y a <1h';
    if(diffH<24) return 'il y a '+diffH+'h';
    const diffD=Math.floor(diffH/24);
    if(diffD===1) return 'hier';
    if(diffD<7) return 'il y a '+diffD+'j';
    const dd=String(d.getDate()).padStart(2,'0');
    const mm=String(d.getMonth()+1).padStart(2,'0');
    return 'le '+dd+'/'+mm;
}

// ============== fetch helpers ==============

async function fetchInventoryViaAppsScript(){
    const r = await this.helpers.httpRequest({
        method:'GET', url: APPS_SCRIPT_URL + (APPS_SCRIPT_URL.includes('?')?'&':'?') + 't=' + Date.now(),
        json: true,
    });
    const out=[];
    (r||[]).forEach(row=>{
        const nom=(row.values&&row.values[0])||'';
        const low=nom.toString().toLowerCase().trim();
        if(!low||low==='nom'||low.includes('total')||low.includes('valeur')||low.includes('treso')||low.includes('revolut')||low.includes('paypal')||low.includes('cash')||low.includes('à sourcer')||low.includes('a sourcer')) return;
        const it=parseInvRow(nom,row.values[1],row.values[2],row.values[3]);
        if(!it) return;
        it.bgColor=row.color||'';
        it.stockStatus=classifyColor(row.color);
        it.available=(it.stockStatus!=='sold');
        out.push(it);
    });
    return out;
}

async function fetchInventoryViaCSV(){
    const r = await this.helpers.httpRequest({
        method:'GET',
        url:'https://docs.google.com/spreadsheets/d/'+INVENTORY_SHEET_ID+'/gviz/tq?tqx=out:csv&t='+Date.now(),
    });
    const clean=(r||'').replace(/^﻿/,'');
    const rows=parseFullCSV(clean);
    const out=[];
    rows.forEach(cols=>{
        if(!cols.length) return;
        const nom=cols[0]||'';
        const low=nom.toLowerCase().trim();
        if(!low||low==='nom'||low.includes('total')||low.includes('valeur')||low.includes('treso')||low.includes('revolut')||low.includes('paypal')||low.includes('cash')||low.includes('à sourcer')||low.includes('a sourcer')) return;
        const it=parseInvRow(nom,cols[1],cols[2],cols[3]);
        if(!it) return;
        it.stockStatus='unknown';
        it.available=true;
        out.push(it);
    });
    return out;
}

async function fetchDiscordListings(){
    const r = await this.helpers.httpRequest({
        method:'GET',
        url:'https://docs.google.com/spreadsheets/d/'+DISCORD_SHEET_ID+'/gviz/tq?tqx=out:csv&t='+Date.now(),
    });
    const clean=(r||'').replace(/^﻿/,'');
    const rows=parseFullCSV(clean);
    if(rows.length===0) return [];
    const header=rows[0].map(h=>(h||'').trim().toLowerCase());
    const idx=name=>header.indexOf(name);
    const cI=idx('listing_id'),sH=idx('seller_handle'),sI=idx('seller_id'),
          aR=idx('artist'),dI=idx('event_date_iso'),dL=idx('event_label'),
          cT=idx('category'),qT=idx('quantity'),pU=idx('price_per_unit'),
          pT=idx('price_total'),bL=idx('block'),nT=idx('notes'),
          mI=idx('message_id'),pA=idx('posted_at'),sA=idx('scraped_at'),
          sT=idx('status');
    const out=[];
    for(let i=1;i<rows.length;i++){
        const cols=rows[i];
        if(!cols||!cols.length) continue;
        const artist=normalizeArtist((cols[aR]||'').trim());
        if(!artist||['PARSE_ERROR','NO_LISTING','NO_MESSAGES_IN_INPUT'].includes(artist)) continue;
        const status=((cols[sT]||'').toString().toLowerCase());
        const isUnavailable=/taken|sold|vendu|unavailable|gone|reserved|reserv[eé]/i.test(status);
        let dateMonth=null,dateDay=null;
        const iso=(cols[dI]||'').trim();
        const isoM=iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if(isoM){ dateMonth=isoM[2]; dateDay=isoM[3]; }
        else {
            const label=cols[dL]||'';
            const dm=label.match(/\b(\d{1,2})\s+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)\b/i);
            if(dm){ dateDay=dm[1].padStart(2,'0'); dateMonth=FR_MONTHS[dm[2].toLowerCase()]||null; }
            else { const dm2=label.match(/\b(\d{1,2})\/(\d{1,2})\b/); if(dm2){ dateDay=dm2[1].padStart(2,'0'); dateMonth=dm2[2].padStart(2,'0'); } }
        }
        const cat=(cols[cT]||'NC').toString().toUpperCase().trim();
        const qty=parseInt(cols[qT])||1;
        const ppu=parseFloat((cols[pU]||'').toString().replace(',','.'))||0;
        const total=parseFloat((cols[pT]||'').toString().replace(',','.'))||null;
        const seller=(cols[sH]||'').trim();
        const block=(cols[bL]||'').trim()||null;
        const cleanName=[qty>1?'x'+qty:'',cat&&cat!=='NC'?cat:'',artist,cols[dL]||'',block?'('+block+')':''].filter(Boolean).join(' ').trim();
        out.push({
            listingId: cols[cI]||'', source:'discord', seller, sellerId:(cols[sI]||'').trim(),
            artist, cat, qty,
            dateMonth, dateDay, dateLabel:(cols[dL]||'').trim(),
            prixAchat: ppu, prixVente: 0, priceTotal: total,
            block, notes: (cols[nT]||'').trim(), cleanName,
            messageId: pA>=0?(cols[mI]||'').trim():'',
            postedAt: pA>=0?(cols[pA]||'').trim():'',
            scrapedAt: sA>=0?(cols[sA]||'').trim():'',
            status, available: !isUnavailable, stockStatus:'discord',
        });
    }
    return out;
}

// ============== match scoring (port of dashboard findMatches) ==============

function findMatches(demand, inventory, discord){
    const m = demandMeta(demand);
    if(!m.artist || m.artist==='NC') return [];
    const catAccepts = (it) => m.catNC || it.cat===m.cat || looseCatMatch(m.cat,it.cat);
    const out=[];
    inventory.forEach(it=>{
        if(!it.available) return;
        if(it.artist!==m.artist) return;
        if(!catAccepts(it)) return;
        let score=10;
        if(it.cat===m.cat) score+=15;
        else if(m.catNC) score+=3;
        else if(looseCatMatch(m.cat,it.cat)) score+=8;
        if(m.dateMonth&&it.dateMonth&&m.dateMonth===it.dateMonth){
            score+=6;
            if(m.dateDay&&it.dateDay&&m.dateDay===it.dateDay) score+=8;
        }
        if(!it.prixAchat) score-=2;
        if(it.stockStatus==='inStock') score+=5;
        out.push({...it,source:'stock',score});
    });
    discord.forEach(it=>{
        if(!it.available) return;
        if(it.artist!==m.artist) return;
        if(!catAccepts(it)) return;
        let score=8;
        if(it.cat===m.cat) score+=15;
        else if(m.catNC) score+=3;
        else if(looseCatMatch(m.cat,it.cat)) score+=8;
        if(m.dateMonth&&it.dateMonth&&m.dateMonth===it.dateMonth){
            score+=6;
            if(m.dateDay&&it.dateDay&&m.dateDay===it.dateDay) score+=8;
        }
        if(!it.prixAchat) score-=2;
        out.push({...it,source:'discord',score});
    });
    out.sort((a,b)=>b.score-a.score);
    return out;
}

// ============== MAIN ==============

const tally = $input.first().json;

const demand = {
    client:     tally.nom || '',
    instagram:  tally.instagram || '',
    artist:     normalizeArtist(tally.event || ''),
    cat:        (tally.categorie || 'NC').toUpperCase(),
    dateDisp:   tally.date || '',
    dateEvent:  '',
    places:     parseInt(tally.places) || 1,
    sourceTag:  tally.recommandation || '',
    notes:      '',
    submittedAt: tally.created_at || tally.submitted || new Date().toISOString(),
};

let inventory=[], discord=[];
try {
    inventory = APPS_SCRIPT_URL
        ? await fetchInventoryViaAppsScript.call(this)
        : await fetchInventoryViaCSV.call(this);
} catch(e){ console.error('inventory fetch failed', e.message||e); }

try {
    discord = await fetchDiscordListings.call(this);
} catch(e){ console.error('discord fetch failed', e.message||e); }

const allMatches = dedupeMatches(findMatches(demand, inventory, discord));
const top = allMatches.slice(0, MAX_OPTIONS);

// ============== build Telegram message ==============

const escHtml = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const NUMS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣'];

let text  = '📨 <b>Nouvelle demande</b>\n';
text += '━━━━━━━━━━━━━━━━━━━\n';
text += `👤 ${escHtml(demand.client)}`;
if (demand.instagram) text += ` <code>${escHtml(demand.instagram)}</code>`;
text += '\n';
text += `🎤 <b>${escHtml(demand.artist || '—')}</b>\n`;
if (demand.dateDisp) text += `📅 ${escHtml(demand.dateDisp)}\n`;
if (demand.cat && demand.cat !== 'NC') text += `🎫 ${escHtml(demand.cat)}\n`;
text += `📍 ${demand.places} place${demand.places>1?'s':''}\n`;
if (demand.sourceTag) text += `🤝 ${escHtml(demand.sourceTag)}\n`;

let reply_markup_obj = {};
let demandHash = '';

if (top.length === 0) {
    text += '\n❌ <i>Aucune option disponible (ni stock, ni Discord).</i>';
} else {
    text += `\n🔍 <b>${top.length} option${top.length>1?'s':''}:</b>\n\n`;
    top.forEach((mt, i) => {
        const sugg = suggestedSellPrice(mt);
        const benef = sugg - (mt.prixAchat || 0);
        const pct = mt.prixAchat ? ((benef / mt.prixAchat) * 100).toFixed(0) : '?';
        const num = NUMS[i] || ((i+1) + '.');
        if (mt.source === 'discord') {
            const posted = formatPostedAt(mt.postedAt);
            const ageTag = posted ? ' · <i>posté ' + posted + '</i>' : '';
            text += `${num} <b>DISCORD</b> · @${escHtml(mt.seller || '?')}${ageTag}\n`;
            text += `   ${escHtml(mt.cleanName)}\n`;
            text += `   Vendeur ${mt.prixAchat}€ → propose <b>${sugg}€</b> (+${pct}%)\n\n`;
        } else {
            const tag = mt.stockStatus === 'inStock' ? 'EN STOCK' : 'STOCK';
            text += `${num} <b>${tag}</b>\n`;
            text += `   ${escHtml(mt.cleanName)}\n`;
            text += `   Achat ${mt.prixAchat}€ → propose <b>${sugg}€</b> (+${pct}%)\n\n`;
        }
    });

    // demand hash so the callback handler can reconstruct who this was for
    demandHash = (demand.client + '|' + demand.instagram + '|' + demand.submittedAt)
        .replace(/[^a-zA-Z0-9]/g,'').substring(0, 24);

    const inline_keyboard = top.map((mt, i) => {
        const sugg = suggestedSellPrice(mt);
        const num  = NUMS[i] || ((i+1) + '.');
        const label = mt.source === 'discord'
            ? `${num} ${(mt.seller||'').substring(0,12)} · ${sugg}€`
            : `${num} STOCK · ${sugg}€`;
        return [{
            text: label,
            // Compact callback_data: p:<src>:<idx>:<demandHash>
            callback_data: 'p:' + mt.source[0] + ':' + i + ':' + demandHash,
        }];
    });
    inline_keyboard.push([{ text: '❌ Aucune', callback_data: 'n:' + demandHash }]);
    reply_markup_obj = { inline_keyboard };
}

// Send the Telegram message ourselves so we can attach the dynamic
// inline_keyboard cleanly. Skip if the token wasn't filled in.
let telegramResult = null;
if (TELEGRAM_BOT_TOKEN && TELEGRAM_BOT_TOKEN !== 'PASTE_YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    try {
        const body = {
            chat_id: TELEGRAM_CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
        };
        if (Object.keys(reply_markup_obj).length) body.reply_markup = reply_markup_obj;
        const resp = await this.helpers.httpRequest({
            method: 'POST',
            url: 'https://api.telegram.org/bot' + TELEGRAM_BOT_TOKEN + '/sendMessage',
            headers: { 'content-type': 'application/json' },
            body,
            json: true,
        });
        telegramResult = { ok: !!resp?.ok, message_id: resp?.result?.message_id || null };
    } catch (err) {
        const dig = (e) => e?.response?.body || e?.cause?.response?.body || e?.body || null;
        const errBody = dig(err);
        telegramResult = {
            ok: false,
            error: (err?.message || String(err)).substring(0, 200),
            body: errBody ? (typeof errBody === 'string' ? errBody : JSON.stringify(errBody)).substring(0, 400) : '(no body)',
        };
    }
}

return [{
    json: {
        // Pass everything the original "format message" produced through, plus our additions.
        ...tally,
        telegram_text: text,
        reply_markup: JSON.stringify(reply_markup_obj),
        telegram_result: telegramResult,
        demand,
        top_matches: top,
        demand_hash: demandHash,
        match_count: top.length,
        inventory_count: inventory.length,
        discord_count: discord.length,
    },
}];
