/**
 * @name Snooze-WhaleHelper
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Whale Helper: Rerollable Pool Button (Loot page), Drop Chance viewer (Loot page), Skin Tier Badges (Champ Select), Hide Unowned Skins/Chromas (Champion Select).
 * @link https://github.com/ReformedDoge/Snooze-Manager
 */
import Utils from './generalUtils.js';

// Config
const STYLE_ID = 'sm-whale-helper-styles';
const BTN_ID   = 'sm-whale-helper-btn';
const PANEL_ID = 'sm-whale-helper-panel';
const BTN_ATTR = 'data-sm-whale-btn';

// Skin Tier Config
const HIDE_CLASSIC = true;
const BADGE_ATTR = 'data-sm-tier-badge';
const CLASSIC_RARITIES = new Set(['kNoRarity', 'kDefault', '']);

// State
let isLootEnabled     = true;
let isSkinTierEnabled = true;
let isDropOddsEnabled = true;
let isHideUnownedEnabled = false;

// Shared Cache
let skinsCache = new Map(); // skinId → skin object
let emberHookRegistered = false;

// Loot Diffing State
let currentTab = 'skins';
let searchQuery = '';

const tabData = {
    skins: { loaded: false, items: [], cardMap: new Map(), activeFilter: 'all', fetcher: fetchUnownedSkins, subtitle: "Rerollable Skins you don't own yet" },
    icons: { loaded: false, items: [], cardMap: new Map(), activeFilter: 'all', fetcher: fetchUnownedIcons, subtitle: "Rerollable Icons you don't own yet" },
    wards: { loaded: false, items: [], cardMap: new Map(), activeFilter: 'all', fetcher: fetchUnownedWards, subtitle: "Rerollable Wards you don't own yet" },
    emotes: { loaded: false, items: [], cardMap: new Map(), activeFilter: 'all', fetcher: fetchUnownedEmotes, subtitle: "Rerollable Emotes you don't own yet" }
};
let sessionUnsub = null;
let currentChampId = null;

// Styles
function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
        /* -- LOOT BUTTON & PANEL -- */
        #${BTN_ID} {
            display: flex; align-items: center; justify-content: center;
            width: 36px; height: 36px; margin-left: 10px; border-radius: 4px;
            cursor: pointer; transition: background 0.2s, border-color 0.2s; flex-shrink: 0;
        }
        #${BTN_ID}:hover { background: rgba(200, 170, 110, 0.2); border-color: #c8aa6e; }
        #${BTN_ID} svg {
            width: 42px; height: 42px; fill: #c8aa6e; opacity: 0.55;
            transition: opacity 0.2s, transform 0.2s cubic-bezier(0.25, 1, 0.5, 1);
            transform: translate(1px, 2px) scale(1);
        }
        #${BTN_ID}:hover svg { opacity: 1; transform: translate(1px, 2px) scale(0.85); }

        #${PANEL_ID} {
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            z-index: 2147483600; display: flex; opacity: 0; visibility: hidden;
            align-items: center; justify-content: center;
            font-family: var(--font-body), 'Segoe UI', sans-serif;
            pointer-events: none; transition: opacity 0.25s, visibility 0.25s;
        }
        #${PANEL_ID}.sm-show { opacity: 1; visibility: visible; pointer-events: auto; }
        #sm-whale-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(3px); }

        #sm-whale-modal {
            position: relative; z-index: 1; width: 860px; max-height: 80vh;
            background: rgba(1, 10, 19, 0.92); border: 1px solid rgba(200, 170, 110, 0.25);
            border-radius: 12px; display: flex; flex-direction: column; overflow: hidden;
            box-shadow: 0 16px 48px rgba(0,0,0,0.8), inset 0 1px 0 rgba(255,255,255,0.05);
            backdrop-filter: blur(25px) saturate(140%); color: #a09b8c;
            transform: scale(0.95); transition: transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        #${PANEL_ID}.sm-show #sm-whale-modal { transform: scale(1); }

        #sm-whale-modal-header {
            display: flex; justify-content: space-between; align-items: center;
            padding: 18px 24px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(0,0,0,0.2); flex-shrink: 0;
        }
        #sm-whale-modal-header h2 { margin: 0; color: #c8aa6e; font-size: 18px; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; }
        #sm-whale-subtitle { font-size: 12px; color: #4a6070; margin-top: 3px; }
        #sm-whale-close-btn { background: none; border: none; color: #a09b8c; font-size: 22px; cursor: pointer; line-height: 1; transition: color 0.15s; padding: 0; }
        #sm-whale-close-btn:hover { color: #f0e6d2; }

        #sm-whale-modal-body { flex: 1; overflow-y: auto; padding: 20px 24px; position: relative; }
        #sm-whale-modal-body::-webkit-scrollbar { width: 6px; }
        #sm-whale-modal-body::-webkit-scrollbar-track { background: transparent; }
        #sm-whale-modal-body::-webkit-scrollbar-thumb { background: rgba(200,170,110,0.15); border-radius: 3px; }

        #sm-whale-toolbar {
            display: flex; align-items: center; gap: 8px; margin-bottom: 16px; flex-wrap: wrap;
            position: sticky; top: -20px; z-index: 10;
            background: rgba(1, 10, 19, 0.95);
            padding: 16px 24px; margin: -20px -24px 16px -24px;
            border-bottom: 1px solid rgba(255,255,255,0.06);
            box-shadow: 0 4px 10px rgba(0,0,0,0.5);
        }
        #sm-whale-toolbar.hidden { display: none; }

        .sm-whale-filter-chip {
            padding: 4px 12px; border-radius: 12px; border: 1px solid rgba(200,170,110,0.2);
            background: rgba(0,0,0,0.3); color: #a09b8c; font-size: 12px; cursor: pointer; transition: all 0.15s; user-select: none;
        }
        .sm-whale-filter-chip:hover { border-color: #c8aa6e; color: #f0e6d2; }
        .sm-whale-filter-chip.active { background: rgba(200,170,110,0.15); border-color: #c8aa6e; color: #c8aa6e; font-weight: bold; }

        .sm-whale-search-wrapper { display: flex; align-items: center; }
        .sm-whale-search {
            background: rgba(0,0,0,0.4); border: 1px solid rgba(200,170,110,0.3); color: #f0e6d2;
            padding: 6px 12px; border-radius: 4px; font-size: 12px; outline: none; width: 180px; transition: border-color 0.2s, background 0.2s;
        }
        .sm-whale-search:focus { border-color: #c8aa6e; background: rgba(0,0,0,0.6); }
        .sm-whale-search::placeholder { color: rgba(160, 155, 140, 0.5); }
        #sm-whale-count { margin-left: auto; font-size: 12px; color: #4a6070; white-space: nowrap; }

        .sm-whale-status { text-align: center; padding: 40px 20px; color: #c8aa6e; font-size: 14px; }
        .sm-whale-status.error { color: #e84057; }
        .sm-whale-status.empty { color: #4a6070; }

        #sm-whale-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }

        .sm-whale-card { 
            position: relative; border-radius: 6px; overflow: hidden; 
            border: 1px solid rgba(255,255,255,0.06); background: rgba(255,255,255,0.02); 
            transition: border-color 0.2s, transform 0.15s; 
            content-visibility: auto; 
            contain-intrinsic-size: 150px 200px;
        }
        .sm-whale-card:hover { border-color: rgba(200,170,110,0.3); transform: translateY(-2px); }
        .sm-whale-card-img { width: 100%; aspect-ratio: 1; object-fit: cover; display: block; background: #0a0e14; }
        .sm-whale-card-info { padding: 8px; background: rgba(0,0,0,0.6); }
        .sm-whale-card-name { font-size: 11px; color: #f0e6d2; font-weight: bold; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .sm-whale-card-rarity { font-size: 10px; margin-top: 3px; display: flex; align-items: center; gap: 4px; }
        .sm-whale-card-rarity img { width: 12px; height: 12px; object-fit: contain; }
        
        #sm-whale-tabs-container {
            position: absolute; bottom: 0px; right: 6px;
            display: flex; gap: 8px;
            border: 1px solid rgba(255,255,255,0.1);
            padding: 8px; border-radius: 12px; backdrop-filter: blur(10px);
            z-index: 100; box-shadow: 0 8px 24px rgba(0,0,0,0.6);
        }
        .sm-whale-tab-icon {
            width: 12px; height: 12px; border-radius: 8px; padding: 6px;
            cursor: pointer; transition: all 0.2s; border: 1px solid transparent;
            background: rgba(255,255,255,0.05); display: flex; align-items: center; justify-content: center;
        }
        .sm-whale-tab-icon:hover { background: rgba(200,170,110,0.15); transform: translateY(-2px); }
        .sm-whale-tab-icon.active { border-color: #c8aa6e; background: rgba(200,170,110,0.25); box-shadow: inset 0 0 0 1px #c8aa6e; }
        .sm-whale-tab-icon img { width: 100%; height: 100%; object-fit: contain; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5)); }

        /* -- CHAMP SELECT TIER BADGES -- */

        .sm-tier-badge {
            display: flex; align-items: center; justify-content: center; gap: 4px;
            padding: 2px 8px; border-radius: 2px; font-size: 10px; font-weight: bold;
            letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid rgba(255,255,255,0.12);
            line-height: 1.4; white-space: nowrap; pointer-events: none; width: fit-content; margin: 0 auto 5px;
        }
        .sm-tier-badge .sm-tier-icon { display: flex; align-items: center; justify-content: center; width: 14px; height: 14px; }
        .sm-tier-badge .sm-tier-icon img { width: 100%; height: 100%; object-fit: contain; }
        
        .sm-tier-badge[data-rarity="kUltimate"], .sm-tier-badge[data-rarity="kTranscendent"], .sm-tier-badge[data-rarity="kExalted"] { box-shadow: 0 0 6px 1px rgba(240,192,112,0.4); }
        .sm-tier-badge[data-rarity="kMythic"], .sm-tier-badge[data-rarity="kExclusive"] { box-shadow: 0 0 6px 1px rgba(200,150,232,0.4); }
        .sm-tier-badge[data-rarity="kLegendary"] { box-shadow: 0 0 5px 1px rgba(232,160,64,0.3); }
        
        .champion-skin-name { display: flex !important; flex-direction: column !important; align-items: center !important; }
        .skin-name-text { display: block !important; }
    `;
    document.head.appendChild(style);
}

// Metadata
const RARITY_META = {
    kTranscendent: { label: 'Transcendent', color: '#f0e6d2', bg: '#3a1500', icon: '/lol-game-data/assets/v1/rarity-gem-icons/transcendent.png' },
    kExalted:      { label: 'Exalted',      color: '#f0e6d2', bg: '#3a1500', icon: '/lol-game-data/assets/v1/rarity-gem-icons/exalted.png' },
    kUltimate:     { label: 'Ultimate',     color: '#f0c070', bg: '#2a1500', icon: '/lol-game-data/assets/v1/rarity-gem-icons/ultimate.png' },
    kMythic:       { label: 'Mythic',       color: '#c896e8', bg: '#1a0028', icon: '/lol-game-data/assets/v1/rarity-gem-icons/mythic.png' },
    kLegendary:    { label: 'Legendary',    color: '#e8a040', bg: '#1e1000', icon: '/lol-game-data/assets/v1/rarity-gem-icons/legendary.png' },
    kEpic:         { label: 'Epic',         color: '#9090f4', bg: '#0a0018', icon: '/lol-game-data/assets/v1/rarity-gem-icons/epic.png' },
    kExclusive:    { label: 'Mythic',       color: '#c896e8', bg: '#1a0028', icon: '/lol-game-data/assets/v1/rarity-gem-icons/mythic.png' },
    kDefault:      { label: 'Classic',      color: '#a09b8c', bg: '#111',    icon: '' },
    kNoRarity:     { label: 'Classic',      color: '#a09b8c', bg: '#111',    icon: '' },
    '':            { label: 'Classic',      color: '#a09b8c', bg: '#111',    icon: '' },
};
const RARITY_ORDER = ['kTranscendent','kExalted','kUltimate','kMythic','kExclusive','kLegendary','kEpic','kDefault','kNoRarity',''];

function getRarityMeta(rarity) {
    return RARITY_META[rarity] ?? RARITY_META[''];
}

// Shared Cache Initialization
async function loadSkinsCache() {
    if (skinsCache.size > 0) return;
    try {
        const data = await Utils.LCU.get('/lol-game-data/assets/v1/skins.json');
        
        const processSkin = (skin) => {
            if (skin?.id === undefined) return;
            skinsCache.set(Number(skin.id), skin);
        };

        if (Array.isArray(data)) {
            data.forEach(skin => {
                processSkin(skin);
                if (Array.isArray(skin.chromas)) {
                    skin.chromas.forEach(chroma => {
                        if (chroma?.id !== undefined) skinsCache.set(Number(chroma.id), {...skin, id: chroma.id});
                    });
                }
            });
        } else if (data && typeof data === 'object') {
            Object.values(data).forEach(skin => {
                processSkin(skin);
                if (Array.isArray(skin.chromas)) {
                    skin.chromas.forEach(chroma => {
                        if (chroma?.id !== undefined) skinsCache.set(Number(chroma.id), {...skin, id: chroma.id});
                    });
                }
            });
        }
        Utils.Debug.log(`[WhaleHelper] Cached ${skinsCache.size} skins.`);
    } catch (err) {
        Utils.Debug.error('[WhaleHelper] Failed to load skins cache:', err);
    }
}

// CHAMP SELECT SKIN TIER DISPLAY
function buildBadge(rarity) {
    rarity = rarity ?? '';
    if (HIDE_CLASSIC && CLASSIC_RARITIES.has(rarity)) return null;

    const meta = getRarityMeta(rarity);

    const badge = document.createElement('span');
    badge.className = 'sm-tier-badge';
    badge.setAttribute(BADGE_ATTR, 'true');
    badge.setAttribute('data-rarity', rarity || 'kDefault');
    badge.title = meta.label + ' skin';
    badge.style.color      = meta.color;
    badge.style.background = meta.bg;

    const iconSpan = document.createElement('span');
    iconSpan.className = 'sm-tier-icon';
    if (meta.icon) {
        const img = document.createElement('img');
        img.src = meta.icon;
        iconSpan.appendChild(img);
    }

    const labelSpan = document.createElement('span');
    labelSpan.textContent = meta.label;

    badge.appendChild(iconSpan);
    badge.appendChild(labelSpan);
    return badge;
}

function updateBadge(nameContainer, skinId) {
    if (!isSkinTierEnabled) return;

    const root = nameContainer.classList?.contains('champion-skin-name')
        ? nameContainer
        : nameContainer.closest?.('.champion-skin-name') ?? nameContainer;

    const existingBadges = root.querySelectorAll(`[${BADGE_ATTR}]`);

    if (!skinId || !skinsCache.has(skinId)) {
        if (existingBadges.length > 0) existingBadges.forEach(el => el.remove());
        return;
    }

    const skinObj = skinsCache.get(skinId);
    const rarity = skinObj.rarity ?? '';
    const targetRarityAttr = rarity || 'kDefault';
    
    if (HIDE_CLASSIC && CLASSIC_RARITIES.has(rarity)) {
        if (existingBadges.length > 0) existingBadges.forEach(el => el.remove());
        return;
    }

    if (existingBadges.length === 1 && existingBadges[0].getAttribute('data-rarity') === targetRarityAttr) {
        return;
    }

    existingBadges.forEach(el => el.remove());
    const badge = buildBadge(rarity);
    if (!badge) return;

    const textEl = root.querySelector('.skin-name-text');
    if (textEl) root.insertBefore(badge, textEl);
    else root.appendChild(badge);
}

function getComponentFromElement(element) {
    const globalEmber = window.Ember || window.__SM_EMBER_INSTANCE;
    if (!globalEmber || !element || !element.id) return null;
    return globalEmber.View?.views?.[element.id] || null;
}

function extractSkinIdFromComponent(component) {
    if (!component) return null;
    try {
        return component.get?.('viewSkin.id') 
            || component.get?.('skin.id') 
            || component.get?.('selectedSkinId')
            || component.get?.('skinId')
            || component.skin?.id 
            || component.selectedSkin?.id;
    } catch (e) {
        return null;
    }
}

function refreshAllBadges() {
    document.querySelectorAll('.champion-skin-name').forEach(nameEl => {
        const comp = getComponentFromElement(nameEl);
        if (comp) {
            updateBadge(nameEl, extractSkinIdFromComponent(comp));
        }
    });
}


function handleSession(session) {
    if (!session) return;
    const localCell = session.localPlayerCellId;
    const local = (session.myTeam || []).find(p => p.cellId === localCell);
    if (!local) return;
    const champId = local.championId || local.championPickIntent || 0;
    if (champId !== currentChampId) currentChampId = champId;
}

function mountSessionObserver() {
    if (sessionUnsub) return;
    sessionUnsub = Utils.LCU.observe('/lol-champ-select/v1/session', event => handleSession(event?.data));
    Utils.LCU.get('/lol-champ-select/v1/session').then(handleSession).catch(() => {});
}

function unmountSessionObserver() {
    if (sessionUnsub) { sessionUnsub(); sessionUnsub = null; }
    currentChampId = null;
}


// LOOT WHALE HELPER
async function getSessionToken() {
    const tokenRes = await fetch('/lol-league-session/v1/league-session-token');
    if (tokenRes.headers.get('content-type')?.includes('application/json')) {
        return await tokenRes.json();
    } else {
        return (await tokenRes.text()).replace(/^"|"$/g, '');
    }
}

async function evaluateSgpQuery(commonBase, sessionToken, query) {
    const res = await fetch(`${commonBase}/loot/v2/query/evaluate`, {
        method: 'PUT',
        headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'Authorization': `Bearer ${sessionToken}` },
        body: JSON.stringify({ query })
    });
    if (!res.ok) throw new Error(`SGP loot query failed: ${res.status}`);
    return res.json();
}

async function fetchUnownedSkins() {
    const { commonBase } = await Utils.GameData.getSgpContext();
    const sessionToken = await getSessionToken();

    const [resNonExclusive, resExclusive] = await Promise.all([
        evaluateSgpQuery(commonBase, sessionToken, '!hasTag("exclusive") && ((type == SKIN_RENTAL && ((value == 1820) || (value == 1350) || (value == 975) || (value == 750) || (value == 520))) || (type == SKIN && value == 3250))'),
        evaluateSgpQuery(commonBase, sessionToken, 'hasTag("exclusive") && (type==SKIN)')
    ]);

    const exclusiveSet = new Set(resExclusive.lootItemNames || []);
    const combined = [...new Set([...(resNonExclusive.lootItemNames || []), ...exclusiveSet])];

    const summoner = await Utils.LCU.get('/lol-summoner/v1/current-summoner');
    const lcuSkins = await Utils.LCU.get(`/lol-champions/v1/inventories/${summoner.summonerId}/skins-minimal`);
    const ownedSkinIds = new Set(lcuSkins.filter(skin => skin.owned ?? skin.ownership?.owned ?? true).map(skin => skin.id));

    const results = [];
    for (const item of combined) {
        const match = item.match(/\d+$/);
        const skinId = match ? parseInt(match[0], 10) : null;
        if (!skinId || ownedSkinIds.has(skinId)) continue;

        const skin = skinsCache.get(skinId);
        const name = skin?.name ?? `Unknown Skin (${skinId})`;
        results.push({
            id: skinId, originalName: item, name: name, lowerName: name.toLowerCase(),
            rarity: skin?.rarity ?? '', tilePath: skin?.tilePath ?? '',
            isRental: item.includes('SKIN_RENTAL'), isExclusive: exclusiveSet.has(item) && !item.includes('SKIN_RENTAL'),
        });
    }

    results.sort((a, b) => {
        const ri = RARITY_ORDER.indexOf(a.rarity || '');
        const rj = RARITY_ORDER.indexOf(b.rarity || '');
        if (ri !== rj) return ri - rj;
        return a.name.localeCompare(b.name);
    });

    return results;
}

async function fetchUnownedIcons() {
    const { commonBase } = await Utils.GameData.getSgpContext();
    const sessionToken = await getSessionToken();
    const query = "type == SUMMONERICON  && !hasTag('norerolloutput')";
    const res = await evaluateSgpQuery(commonBase, sessionToken, query);
    
    const inventory = await Utils.LCU.get('/lol-inventory/v2/inventory/SUMMONER_ICON').catch(() => []);
    const ownedIds = new Set(inventory.map(i => i.itemId));
    
    const data = await Utils.LCU.get('/lol-game-data/assets/v1/summoner-icons.json').catch(() => []);
    const dataMap = new Map();
    if (Array.isArray(data)) data.forEach(d => dataMap.set(d.id, d));
    
    const results = [];
    for (const item of res.lootItemNames || []) {
        const match = item.match(/\d+$/);
        const id = match ? parseInt(match[0], 10) : null;
        if (!id || ownedIds.has(id)) continue;
        
        const d = dataMap.get(id);
        const name = d?.title || d?.name || `Unknown Icon (${id})`;
        results.push({
            id: id, originalName: item, name: name, lowerName: name.toLowerCase(),
            rarity: '', tilePath: d?.iconPath || `/lol-game-data/assets/v1/profile-icons/${id}.jpg`,
            isRental: false, isExclusive: false
        });
    }
    
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

async function fetchUnownedWards() {
    const { commonBase } = await Utils.GameData.getSgpContext();
    const sessionToken = await getSessionToken();
    const query = "type == WARDSKIN && value == 640 && !hasTag('norerolloutput')";
    const res = await evaluateSgpQuery(commonBase, sessionToken, query);
    
    const inventory = await Utils.LCU.get('/lol-inventory/v2/inventory/WARD_SKIN').catch(() => []);
    const ownedIds = new Set(inventory.map(i => i.itemId));
    
    const data = await Utils.LCU.get('/lol-game-data/assets/v1/ward-skins.json').catch(() => []);
    const dataMap = new Map();
    if (Array.isArray(data)) data.forEach(d => dataMap.set(d.id, d));
    
    const results = [];
    for (const item of res.lootItemNames || []) {
        const match = item.match(/\d+$/);
        const id = match ? parseInt(match[0], 10) : null;
        if (!id || ownedIds.has(id)) continue;
        
        const d = dataMap.get(id);
        const name = d?.name || `Unknown Ward (${id})`;
        results.push({
            id: id, originalName: item, name: name, lowerName: name.toLowerCase(),
            rarity: '', tilePath: d?.wardImagePath || '',
            isRental: true, isExclusive: false
        });
    }
    
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

async function fetchUnownedEmotes() {
    const { commonBase } = await Utils.GameData.getSgpContext();
    const sessionToken = await getSessionToken();
    const query = "!hasTag(\"norerolloutput\") && type == EMOTE";
    const res = await evaluateSgpQuery(commonBase, sessionToken, query);
    
    const catalog = await Utils.LCU.get('/lol-catalog/v1/items/EMOTE').catch(() => []);
    const unownedMap = new Map();
    if (Array.isArray(catalog)) {
        catalog.forEach(c => {
            if (!c.owned) unownedMap.set(c.itemId, c);
        });
    }
    
    const results = [];
    for (const item of res.lootItemNames || []) {
        const match = item.match(/\d+$/);
        const id = match ? parseInt(match[0], 10) : null;
        if (!id || !unownedMap.has(id)) continue;
        
        const c = unownedMap.get(id);
        const name = c.name || `Unknown Emote (${id})`;
        results.push({
            id: id, originalName: item, name: name, lowerName: name.toLowerCase(),
            rarity: '', tilePath: c.imagePath || '',
            isRental: false, isExclusive: false
        });
    }
    
    results.sort((a, b) => a.name.localeCompare(b.name));
    return results;
}

let panelEl = null;


function closePanel(e) {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    if (panelEl) panelEl.classList.remove('sm-show');
}

function buildCard(item) {
    const meta = getRarityMeta(item.rarity);
    const card = document.createElement('div');
    card.className = 'sm-whale-card';
    card.title = item.name;
    
    const img = document.createElement('img');
    img.className = 'sm-whale-card-img'; 
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = item.tilePath || '';
    img.onerror = () => { img.style.opacity = '0.2'; };
    card.appendChild(img);

    const info = document.createElement('div');
    info.className = 'sm-whale-card-info';

    const nameEl = document.createElement('div');
    nameEl.className = 'sm-whale-card-name'; nameEl.textContent = item.name;
    info.appendChild(nameEl);

    if (item.rarity) {
        const rarityEl = document.createElement('div');
        rarityEl.className = 'sm-whale-card-rarity'; rarityEl.style.color = meta.color;
        if (meta.icon) {
            const gemImg = document.createElement('img');
            gemImg.src = meta.icon; rarityEl.appendChild(gemImg);
        }
        rarityEl.appendChild(document.createTextNode(meta.label));
        info.appendChild(rarityEl);
    }

    card.appendChild(info);
    return card;
}

function applyFilter(filter) {
    const data = tabData[currentTab];
    data.activeFilter = filter;
    let visibleCount = 0;
    
    for (const item of data.items) {
        let matchesChip = false;
        if (filter === 'all') matchesChip = true;
        else if (filter === 'rental') matchesChip = item.isRental;
        else if (filter === 'others') matchesChip = (item.rarity === 'kDefault' || item.rarity === 'kNoRarity' || item.rarity === '');
        else if (filter === 'kMythic' || filter === 'kExclusive') matchesChip = (item.rarity === 'kMythic' || item.rarity === 'kExclusive');
        else matchesChip = (item.rarity === filter);

        let isVisible = matchesChip && (searchQuery === '' || item.lowerName.includes(searchQuery));
        
        const el = data.cardMap.get(item.originalName);
        if (el) {
            const targetDisplay = isVisible ? '' : 'none';
            if (el.style.display !== targetDisplay) el.style.display = targetDisplay;
            if (isVisible) visibleCount++;
        }
    }

    const countEl = document.getElementById('sm-whale-count');
    if (countEl) countEl.textContent = `${visibleCount} item${visibleCount !== 1 ? 's' : ''}`;

    const grid = document.getElementById('sm-whale-grid');
    const emptyState = document.getElementById('sm-whale-empty-state');
    if (grid && emptyState) {
        if (visibleCount === 0) { grid.style.display = 'none'; emptyState.style.display = 'block'; } 
        else { grid.style.display = 'grid'; emptyState.style.display = 'none'; }
    }
}

function rebuildFilterChips() {
    const toolbar = document.getElementById('sm-whale-toolbar');
    const countEl = document.getElementById('sm-whale-count');
    if (!toolbar) return;
    toolbar.querySelectorAll('.sm-whale-filter-chip').forEach(c => c.remove());

    const data = tabData[currentTab];
    const rarityGroups = new Set(data.items.map(s => s.rarity));
    const hasOthers = data.items.some(s => s.rarity === 'kDefault' || s.rarity === 'kNoRarity' || s.rarity === '');

    const chipDefs = [
        { key: 'all', label: 'All' }
    ];

    if (currentTab === 'skins') {
        // chipDefs.push({ key: 'rental', label: 'Shards' });
        RARITY_ORDER.filter(r => rarityGroups.has(r) && r !== '' && r !== 'kDefault' && r !== 'kNoRarity').forEach(r => {
            chipDefs.push({ key: r, label: getRarityMeta(r).label });
        });
        if (hasOthers) chipDefs.push({ key: 'others', label: 'Others' });
    }

    const seenLabels = new Set();
    for (const def of chipDefs) {
        if (def.key !== 'all' && seenLabels.has(def.label)) continue;
        seenLabels.add(def.label);

        const chip = document.createElement('div');
        chip.className = 'sm-whale-filter-chip' + (def.key === data.activeFilter ? ' active' : '');
        chip.textContent = def.label; chip.dataset.filter = def.key;
        
        chip.addEventListener('click', () => {
            toolbar.querySelectorAll('.sm-whale-filter-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active'); applyFilter(def.key);
        });
        
        if (countEl) toolbar.insertBefore(chip, countEl); else toolbar.appendChild(chip);
    }
    
    if (!chipDefs.some(d => d.key === data.activeFilter)) {
        applyFilter('all');
        const allChip = toolbar.querySelector('[data-filter="all"]');
        if (allChip) allChip.classList.add('active');
    }
}

function switchTab(tabId) {
    currentTab = tabId;
    searchQuery = '';
    const searchInput = document.querySelector('.sm-whale-search');
    if (searchInput) searchInput.value = '';

    document.querySelectorAll('.sm-whale-tab-icon').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tabId);
    });

    const data = tabData[tabId];
    const subtitle = document.getElementById('sm-whale-subtitle');
    if (subtitle) subtitle.textContent = data.loaded ? data.subtitle : 'Loading...';
    
    const grid = document.getElementById('sm-whale-grid');
    if (!grid) return;
    grid.innerHTML = '';
    
    if (!data.loaded) {
        document.getElementById('sm-whale-toolbar').classList.add('hidden');
        grid.innerHTML = '<div class="sm-whale-status">Fetching data...</div>';
        loadTabData(tabId);
    } else {
        document.getElementById('sm-whale-toolbar').classList.remove('hidden');
        const fragment = document.createDocumentFragment();
        data.items.forEach(item => {
            const el = data.cardMap.get(item.originalName);
            if (el) fragment.appendChild(el);
        });
        grid.appendChild(fragment);
        rebuildFilterChips();
        applyFilter(data.activeFilter);
    }
}

async function loadTabData(tabId) {
    const data = tabData[tabId];
    const grid = document.getElementById('sm-whale-grid');
    const subtitle = document.getElementById('sm-whale-subtitle');
    const toolbar = document.getElementById('sm-whale-toolbar');

    try {
        if (tabId === 'skins') await loadSkinsCache();
        data.items = await data.fetcher();
        data.loaded = true;

        if (currentTab !== tabId) return;

        subtitle.textContent = data.subtitle;
        toolbar.classList.remove('hidden');
        grid.innerHTML = '';

        const fragment = document.createDocumentFragment();
        data.items.forEach(item => {
            const card = buildCard(item);
            data.cardMap.set(item.originalName, card);
            fragment.appendChild(card);
        });
        grid.appendChild(fragment);

        rebuildFilterChips(); 
        applyFilter(data.activeFilter);
    } catch (err) {
        Utils.Debug.error(`[WhaleHelper] Fetch failed for ${tabId}:`, err);
        if (currentTab === tabId) {
            subtitle.textContent = 'Error loading data';
            grid.innerHTML = `<div class="sm-whale-status error">Failed to load data.<br><span style="font-size:11px;">${err.message}</span></div>`;
        }
    }
}

async function backgroundSyncData() {
    const data = tabData[currentTab];
    if (!data.loaded) return;
    
    const subtitle = document.getElementById('sm-whale-subtitle');
    if (subtitle) subtitle.textContent = 'Syncing...';

    try {
        const newItems = await data.fetcher();
        const activeTabWhenStarted = currentTab;
        
        const oldNames = new Set(data.items.map(s => s.originalName));
        const newNames = new Set(newItems.map(s => s.originalName));
        let changed = false;

        data.items = data.items.filter(s => {
            if (!newNames.has(s.originalName)) {
                data.cardMap.get(s.originalName)?.remove(); 
                data.cardMap.delete(s.originalName); 
                changed = true; 
                return false;
            }
            return true;
        });

        const grid = document.getElementById('sm-whale-grid');
        const fragment = document.createDocumentFragment();
        for (const s of newItems) {
            if (!oldNames.has(s.originalName)) {
                data.items.push(s);
                const card = buildCard(s); 
                data.cardMap.set(s.originalName, card);
                if (grid && activeTabWhenStarted === currentTab) {
                    fragment.appendChild(card);
                }
                changed = true;
            }
        }
        if (fragment.children.length > 0 && grid && activeTabWhenStarted === currentTab) {
            grid.appendChild(fragment);
        }

        if (changed) {
            data.items.sort((a, b) => {
                const ri = RARITY_ORDER.indexOf(a.rarity || ''); 
                const rj = RARITY_ORDER.indexOf(b.rarity || '');
                if (ri !== rj) return ri - rj; 
                return a.name.localeCompare(b.name);
            });
            if (grid && activeTabWhenStarted === currentTab) {
                const sortFragment = document.createDocumentFragment();
                data.items.forEach(s => { 
                    const el = data.cardMap.get(s.originalName); 
                    if (el) sortFragment.appendChild(el);
                });
                grid.appendChild(sortFragment);
                rebuildFilterChips(); 
                applyFilter(data.activeFilter);
            }
        }
        if (subtitle && activeTabWhenStarted === currentTab) subtitle.textContent = data.subtitle;
    } catch (err) {
        if (subtitle) subtitle.textContent = `Offline (Sync failed)`;
    }
}

async function openPanel() {
    if (!panelEl) createPanel();
    panelEl.classList.add('sm-show');

    const data = tabData[currentTab];
    if (!data.loaded) {
        switchTab(currentTab);
    } else {
        backgroundSyncData();
    }
}

function createPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    panelEl = document.createElement('div'); panelEl.id = PANEL_ID;

    const overlay = document.createElement('div'); overlay.id = 'sm-whale-overlay';
    overlay.addEventListener('click', closePanel); panelEl.appendChild(overlay);

    const modal = document.createElement('div'); modal.id = 'sm-whale-modal';
    const header = document.createElement('div'); header.id = 'sm-whale-modal-header';

    const titleWrap = document.createElement('div');
    const title = document.createElement('h2'); title.textContent = 'Whale Helper';
    const subtitle = document.createElement('div'); subtitle.id = 'sm-whale-subtitle'; subtitle.textContent = 'Loading...';
    titleWrap.appendChild(title); titleWrap.appendChild(subtitle);
    
    const headerBtns = document.createElement('div');
    headerBtns.style.cssText = 'display:flex;gap:12px;align-items:center;';

    const refreshBtn = document.createElement('button');
    refreshBtn.innerHTML = '&#x21bb;'; refreshBtn.title = "Refresh Data";
    refreshBtn.style.cssText = 'background:none;border:none;color:#a09b8c;font-size:20px;cursor:pointer;padding:0;line-height:1;transition:color 0.15s;';
    refreshBtn.onmouseover = () => refreshBtn.style.color = '#0ac8b9';
    refreshBtn.onmouseout = () => refreshBtn.style.color = '#a09b8c';
    refreshBtn.addEventListener('click', backgroundSyncData);

    const closeBtn = document.createElement('button'); closeBtn.id = 'sm-whale-close-btn';
    closeBtn.innerHTML = '&#x2715;'; closeBtn.addEventListener('click', closePanel);

    headerBtns.appendChild(refreshBtn); headerBtns.appendChild(closeBtn);
    header.appendChild(titleWrap); header.appendChild(headerBtns); modal.appendChild(header);

    const body = document.createElement('div'); body.id = 'sm-whale-modal-body';
    const toolbar = document.createElement('div'); toolbar.id = 'sm-whale-toolbar'; toolbar.classList.add('hidden');

    const searchWrap = document.createElement('div'); searchWrap.className = 'sm-whale-search-wrapper';
    const searchInput = document.createElement('input'); searchInput.type = 'text'; searchInput.className = 'sm-whale-search';
    searchInput.placeholder = 'Search items...'; searchInput.spellcheck = false;
    
    searchInput.addEventListener('input', (e) => {
        searchQuery = e.target.value.toLowerCase().trim(); 
        applyFilter(tabData[currentTab].activeFilter);
    });
    searchWrap.appendChild(searchInput);

    const countEl = document.createElement('span'); countEl.id = 'sm-whale-count';
    toolbar.appendChild(countEl); toolbar.appendChild(searchWrap);

    const grid = document.createElement('div'); grid.id = 'sm-whale-grid';
    const emptyState = document.createElement('div'); emptyState.id = 'sm-whale-empty-state';
    emptyState.className = 'sm-whale-status empty'; emptyState.style.display = 'none';
    emptyState.textContent = 'No items match this filter.';

    body.appendChild(toolbar); body.appendChild(grid); body.appendChild(emptyState);
    modal.appendChild(body); 

    const tabsContainer = document.createElement('div');
    tabsContainer.id = 'sm-whale-tabs-container';
    
    const tabs = [
        { id: 'skins', icon: '/fe/lol-loot/assets/category_icons/skin.png', title: 'Skins' },
        { id: 'icons', icon: '/fe/lol-loot/assets/category_icons/summonericon.png', title: 'Icons' },
        { id: 'wards', icon: '/fe/lol-loot/assets/category_icons/wardskin.png', title: 'Wards' },
        { id: 'emotes', icon: '/fe/lol-loot/assets/category_icons/emote.png', title: 'Emotes' }
    ];

    tabs.forEach(t => {
        const btn = document.createElement('div');
        btn.className = 'sm-whale-tab-icon' + (t.id === currentTab ? ' active' : '');
        btn.dataset.tab = t.id;
        btn.title = t.title;
        const img = document.createElement('img');
        img.src = t.icon;
        btn.appendChild(img);
        
        btn.addEventListener('click', () => {
            if (currentTab !== t.id) switchTab(t.id);
        });
        tabsContainer.appendChild(btn);
    });

    modal.appendChild(tabsContainer);
    panelEl.appendChild(modal);

    const viewportOverlay = document.querySelector('.rcp-fe-viewport-overlay');
    if (viewportOverlay?.parentNode === document.body) viewportOverlay.after(panelEl); else document.body.appendChild(panelEl);
}

function injectButton(actionTabsContainer) {
    if (!isLootEnabled) return;
    if (actionTabsContainer.querySelector(`#${BTN_ID}`)) return;

    const btn = document.createElement('div');
    btn.id = BTN_ID; btn.setAttribute(BTN_ATTR, 'true'); btn.title = 'Whale Helper — skins you don\'t own yet';

    btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" viewBox="-5.0 -10.0 110.0 135.0">
	 <path d="m93.117 34.301c-0.14453-0.89453-0.85547-1.5859-1.7539-1.7031-0.89844-0.11719-1.7617 0.37109-2.1289 1.1992-0.82422 1.8594-2.5234 2.2031-5.4492 2.6602-2.7617 0.14453-5.3984 1.2148-7.4805 3.0391-1.6914-1.9023-3.8398-3.3438-6.2461-4.1875-2.2305-0.69531-4.1367-2.1758-5.3633-4.1641-0.54297-0.83203-1.5234-1.2578-2.5-1.0898-0.99609 0.16797-1.7891 0.91406-2.0234 1.8906-1.0391 4.3945-1.5508 9.5117 2.5469 14.152v0.003906c2.0859 2.2344 4.6094 4.0156 7.4141 5.2383 0.21094 0.085937 0.32813 0.32031 0.26953 0.54297-0.066406 0.28125-0.17969 0.54688-0.33594 0.79297-1.1797 1.4453-3 2.207-4.8594 2.0352-1.9336-0.17578-3.0977-1.7109-5.1562-4.6445-0.76562-1.0898-1.6328-2.3281-2.6641-3.5742-4.3789-5.2969-10.156-9.2617-16.676-11.445-2.4922-0.77344-15.43-4.1992-25.336 4.4336-6.1797 5.5586-9.4023 13.691-8.6992 21.973 0.10547 1.1562 0.29688 2.3047 0.57031 3.4336 0.015625 0.074219 0.03125 0.14844 0.054687 0.21875 0.98047 4.6328 3.7695 8.6797 7.75 11.246 4.0352 2.2773 8.4141 3.875 12.965 4.7305 3.0273 3.7695 7.6445 5.9141 12.477 5.7852h0.023437c1.0469 0.007812 2-0.61328 2.4141-1.5781 0.41406-0.96484 0.20703-2.082-0.51953-2.8359 1.3945-0.019531 2.7852-0.082031 4.1602-0.19922 3.6641 1.7031 7.668 2.5469 11.703 2.4688h0.10937c1.0273 0 1.9453-0.63672 2.3086-1.5938 0.37891-0.97656 0.11328-2.082-0.66406-2.7812-0.26172-0.23828-0.49219-0.47656-0.71094-0.71484 5.7383-1.8398 10.832-5.2852 14.672-9.9297 1.543-1.9609 2.8164-4.1211 3.7852-6.418 0.011718-0.019531 0.015624-0.039062 0.027343-0.058594h-0.003906c1.4297-3.4297 2.293-7.0664 2.5586-10.77 0.03125-0.37109 0.29688-0.67969 0.66016-0.75781 3.3359-0.61328 6.4688-2.0508 9.1055-4.1836 3.8086-3.7539 3.5117-9.8906 2.9961-13.215zm-59.426 47.715c1.5781 0.18359 3.1758 0.30469 4.7812 0.375 0.25781 0.45312 0.54688 0.89062 0.86719 1.3008-1.9805-0.14062-3.9102-0.71094-5.6484-1.6758zm-4.4883-3.8516-0.011719-0.003906c-4.3945-0.77734-8.6289-2.2891-12.52-4.4766v-0.003906c-2.5273-1.5938-4.4688-3.9609-5.5352-6.75 2.7344 0.79297 5.5703 1.1914 8.4219 1.1875 3.3477-0.011719 6.6719-0.53516 9.8594-1.5625 0.70703 0.12109 1.4062 0.28125 2.0977 0.47656 2.0625 0.60938 4 1.582 5.7148 2.875 0.52734 3.6328 2.3008 6.9648 5.0156 9.4336-4.3789 0.0625-8.75-0.33203-13.043-1.1758zm28.324-1.2305c-0.26172-0.53125-0.50781-1.082-0.76953-1.6758-0.22656-0.50781-0.46094-1.0352-0.71875-1.5742 0.57813-0.125 1.168-0.25781 1.7852-0.39453 4.8281-1.0977 9.4531-2.957 13.699-5.5078-3.6641 4.3633-8.5312 7.5469-13.996 9.1523zm30.398-31.645c-2.2266 1.7148-4.8359 2.8672-7.6016 3.3633-1.7031 0.37891-2.957 1.8281-3.082 3.5703-0.22656 3.1953-0.94141 6.3359-2.1172 9.3125-5.2734 4.2148-11.422 7.1914-18 8.7109-0.94141 0.21094-1.8242 0.40234-2.6797 0.58203-1.0508-1.5898-2.2969-3.043-3.707-4.3281-0.30078-0.28125-0.70703-0.42969-1.1211-0.41406-0.41406 0.015624-0.80469 0.19531-1.0859 0.5-0.28125 0.30078-0.42969 0.70703-0.41406 1.1211 0.015624 0.41406 0.19531 0.80469 0.5 1.0859 2.3359 2.1328 4.1445 4.7773 5.2812 7.7305 0.46875 1.1133 1.7461 2.2852 2.5156 3.3828 2.1289 3.0312 3.9648 5.6484 7.4375 5.9609 2.9883 0.29297 5.9102-0.98828 7.7148-3.3867 0.36328-0.53906 0.625-1.1406 0.78125-1.7695 0.45312-1.7148-0.42188-3.5039-2.0547-4.1992-2.3828-1.0352-4.5312-2.543-6.3125-4.4375-2.3125-2.6172-2.9648-5.5781-2.1406-10h0.003906c1.543 1.9258 3.6055 3.3711 5.9414 4.1641 2.5391 0.85547 4.7227 2.5352 6.2031 4.7734 0.3125 0.43359 0.82422 0.68359 1.3633 0.66016 0.53516-0.03125 1.0195-0.33594 1.2812-0.80859 1.3633-2.4727 3.7656-2.8438 6.5508-3.2773v0.003906c2.1602-0.14062 4.2383-0.85547 6.0273-2.0664 0.085938 2.6328-0.32422 5.8008-2.3633 7.8086z"/>
	 <path d="m32.402 57.078c0 2.6055-3.9062 2.6055-3.9062 0s3.9062-2.6055 3.9062 0"/>
	 <path d="m29.414 22.188c0.33594 0.042969 0.66406 0.125 0.98047 0.24219 0.47656 0.19141 1.1602 0.62891 2.2539 2.3242 0.79297 1.3008 1.3789 2.7188 1.7383 4.1992 0.19531 0.66406 0.80469 1.1211 1.4961 1.1211 0.042969 0 0.082032 0 0.125-0.003907 0.0625-0.011718 0.125-0.027343 0.18359-0.046874 0.058594 0.019531 0.12109 0.035156 0.18359 0.046874 0.042969 0.003907 0.082031 0.003907 0.125 0.003907 0.69141 0 1.3008-0.45703 1.4961-1.1211 0.35938-1.4805 0.94531-2.8984 1.7383-4.1992 1.0898-1.6953 1.7773-2.1328 2.25-2.3242 0.32031-0.11719 0.65234-0.19922 0.98828-0.24219 0.89453-0.078125 1.7383-0.46094 2.3867-1.0859 1.3047-1.2773 1.6211-3.2578 0.78125-4.8789-0.96875-2.0352-3.0977-3.2539-5.3438-3.0664-2.0391 0.28125-3.7891 1.6094-4.6055 3.5039-0.81641-1.8945-2.5664-3.2227-4.6055-3.5039-2.2461-0.18359-4.3711 1.0391-5.3438 3.0664-0.83984 1.6211-0.52344 3.6016 0.78125 4.8789 0.64844 0.625 1.4922 1.0078 2.3906 1.0859zm8.6797-1.7461c0.63672-2.5234 1.7383-4.0469 3.0156-4.1758 0.058594-0.003906 0.11719-0.007813 0.17578-0.007813h0.003906c0.86328 0.042969 1.6406 0.54297 2.0312 1.3164 0.26953 0.42969 0.19141 0.99219-0.1875 1.3359-0.082031 0.082032-0.15234 0.10938-0.67187 0.19531-0.5625 0.078125-1.1133 0.21875-1.6445 0.42578-1.1992 0.53516-2.2305 1.3906-2.9727 2.4727 0.042969-0.52734 0.12891-1.0469 0.25-1.5625zm-9.0312-2.8672c0.39062-0.77344 1.168-1.2734 2.0352-1.3164 0.058594 0 0.11719 0.003907 0.17578 0.007813 1.2812 0.12891 2.3789 1.6484 3.0156 4.1758 0.12109 0.51562 0.20703 1.0352 0.25 1.5625-0.74219-1.082-1.7734-1.9375-2.9727-2.4727-0.53125-0.20703-1.082-0.35156-1.6445-0.42578-0.51953-0.085938-0.59375-0.11328-0.67188-0.19531-0.37891-0.34375-0.45703-0.90625-0.1875-1.3359z"/>
	</svg>`;

    btn.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!isLootEnabled) return;
        openPanel();
    });

    actionTabsContainer.appendChild(btn);
}

function removeButton() {
    document.getElementById(BTN_ID)?.remove();
}

// HOOKS & LIFECYCLE

async function showOddsModal(item, recipeName) {
    try {
        const sessionToken = await Utils.LCU.get('/lol-league-session/v1/league-session-token');
        const { commonBase } = await Utils.GameData.getSgpContext();
        
        Utils.Debug.log("[WhaleHelper Debug] Fetching SGP odds from:", `${commonBase}/loot/v2/recipes/${recipeName}/odds`);
        
        const resp = await fetch(`${commonBase}/loot/v2/recipes/${recipeName}/odds`, {
            headers: {
                'Authorization': `Bearer ${sessionToken}`,
                'User-Agent': 'LeagueOfLegendsClient',
                'Accept': 'application/json'
            }
        });
        if (!resp.ok) {
            throw new Error('SGP Odds Response Error: ' + resp.status);
        }
        const odds = await resp.json();
        if (odds) {
            renderOddsModal(item, odds);
        } else {
            renderOddsModal(item, { message: "Drop rates are currently unavailable for this item." });
        }
    } catch (e) {
        Utils.Debug.error("[WhaleHelper] Failed to fetch SGP odds:", e);
        renderOddsModal(item, { message: "Drop rates are not published for this item." });
    }
}function flattenOddsTree(node, currentRate = 1) {
    const results = [];
    const rate = currentRate * (node.dropRate !== undefined ? node.dropRate : 1);
    
    const isBundle = node.lootId && node.lootId.startsWith('LOOTBUNDLE_');
    
    if (isBundle && node.children && node.children.length > 0) {
        const childLabels = node.children.map(child => {
            return parseQueryToFriendlyLabel(child.label || child.lootId, child.quantity || 1);
        });
        
        const counts = {};
        childLabels.forEach(l => {
            counts[l] = (counts[l] || 0) + 1;
        });
        
        const groupedLabels = [];
        for (const [l, c] of Object.entries(counts)) {
            if (c > 1) {
                const match = l.match(/^(\d+)x\s(.*)/);
                if (match) {
                    groupedLabels.push(`${parseInt(match[1], 10) * c}x ${match[2]}`);
                } else {
                    groupedLabels.push(`${c}x ${l}`);
                }
            } else {
                groupedLabels.push(l);
            }
        }

        results.push({
            lootId: node.lootId,
            label: groupedLabels.join(' + '),
            quantity: 1,
            rate: rate
        });
    } else if (!node.children || node.children.length === 0) {
        results.push({
            lootId: node.lootId,
            label: parseQueryToFriendlyLabel(node.label || node.lootId, node.quantity || 1),
            quantity: 1,
            rate: rate
        });
    } else {
        for (const child of node.children) {
            results.push(...flattenOddsTree(child, rate));
        }
    }
    return results;
}

function parseQueryToFriendlyLabel(raw, quantity) {
    raw = String(raw || '').trim();
    if (!raw) return 'Unknown Item';
    
    let isSpecific = false;
    
    if (raw.includes("lootName == 'CURRENCY_mythic'") || raw.includes("CURRENCY_mythic")) {
        return quantity > 1 ? quantity + " Mythic Essence" : "Mythic Essence";
    }
    if (raw.includes("lootName == 'CURRENCY_cosmetic'") || raw.includes("CURRENCY_cosmetic")) {
        return quantity > 1 ? quantity + " Orange Essence" : "Orange Essence";
    }
    if (raw.includes("lootName == 'CURRENCY_champion'") || raw.includes("CURRENCY_champion")) {
        return quantity > 1 ? quantity + " Blue Essence" : "Blue Essence";
    }
    if (raw.includes("lootName == 'MATERIAL_key'") || raw.includes("MATERIAL_key")) {
        return quantity > 1 ? quantity + " Key Shards" : "Key Shard";
    }
    if (raw.includes("lootName == 'CHEST_generic'") || raw.includes("CHEST_generic")) {
        return quantity > 1 ? quantity + " Hextech Chests" : "Hextech Chest";
    }
    if (raw.includes("CHEST_798")) {
        return quantity > 1 ? quantity + " Masterwork Chests" : "Masterwork Chest";
    }
    if (raw.includes("lootName == 'CHAMPION_SKIN_") || raw.startsWith("CHAMPION_SKIN_")) {
        isSpecific = true;
    }

    const typeRegex = /\btype\s*==\s*([A-Za-z_]+)/g;
    const types = [];
    let match;
    while ((match = typeRegex.exec(raw)) !== null) {
        if (!types.includes(match[1])) types.push(match[1]);
    }

    const tagRegex = /(!)?\bhasTag\(['"]([^'"]+)['"]\)/g;
    const posTags = [];
    const negTags = [];
    while ((match = tagRegex.exec(raw)) !== null) {
        const isNegated = !!match[1];
        const tagName = match[2];
        if (isNegated) {
            if (!negTags.includes(tagName)) negTags.push(tagName);
        } else {
            if (!posTags.includes(tagName)) posTags.push(tagName);
        }
    }

    const valueRegex = /\bvalue\s*(==|!=)\s*(\d+)/g;
    const values = [];
    const notValues = [];
    while ((match = valueRegex.exec(raw)) !== null) {
        const val = parseInt(match[2], 10);
        if (match[1] === '==') {
            if (!values.includes(val)) values.push(val);
        } else {
            if (!notValues.includes(val)) notValues.push(val);
        }
    }

    const isExclusive = posTags.includes('exclusive');
    const isMythic = posTags.includes('mythic');
    const isExalted = posTags.includes('exalted');
    const isTranscendent = posTags.includes('transcendent');

    let prefix = quantity > 1 ? quantity + "x " : "";

    if (posTags.includes('champie')) {
        const regionTag = posTags.find(t => t !== 'champie' && t !== 'exclusive');
        if (regionTag) {
            const capitalized = regionTag.charAt(0).toUpperCase() + regionTag.slice(1);
            return prefix + capitalized + " Champie Icon";
        }
        return prefix + "Champie Icon";
    }

    if (isSpecific && types.length === 0) {
        return prefix + "Specific Champion Skin";
    }

    const typeMap = {
        'SKIN': 'Skin',
        'SKIN_RENTAL': 'Skin Shard',
        'WARDSKIN': 'Ward Skin',
        'WARDSKIN_RENTAL': 'Ward Skin Shard',
        'CHAMPION': 'Champion',
        'CHAMPION_RENTAL': 'Champion Shard',
        'SUMMONERICON': 'Summoner Icon',
        'EMOTE': 'Emote',
        'CHROMA': 'Chroma'
    };

    const sortedTypes = ['SKIN', 'SKIN_RENTAL', 'WARDSKIN', 'WARDSKIN_RENTAL', 'CHAMPION', 'CHAMPION_RENTAL', 'EMOTE', 'SUMMONERICON', 'CHROMA'];
    const cleanedTypes = [];
    
    for (const t of sortedTypes) {
        if (types.includes(t)) {
            cleanedTypes.push(typeMap[t]);
        }
    }

    for (const t of types) {
        if (!typeMap[t] && !cleanedTypes.includes(t)) {
            const clean = t.replace('_RENTAL', ' Shard').toLowerCase().replace(/(^\w|_\w)/g, m => m.replace('_', ' ').toUpperCase());
            cleanedTypes.push(clean);
        }
    }

    let baseType = 'Loot Item';
    if (cleanedTypes.length === 1) {
        baseType = cleanedTypes[0];
    } else if (cleanedTypes.length === 2) {
        baseType = cleanedTypes[0] + " or " + cleanedTypes[1];
    } else if (cleanedTypes.length > 2) {
        baseType = cleanedTypes.slice(0, -1).join(', ') + ' or ' + cleanedTypes[cleanedTypes.length - 1];
    }

    const hasSkinRental = types.includes('SKIN_RENTAL');
    const hasSkinPermanent = types.includes('SKIN');
    
    if (hasSkinRental && hasSkinPermanent && values.includes(3250) && !isExclusive && !isMythic && !isExalted && !isTranscendent) {
        if (values.includes(520) && values.includes(1350) && values.includes(1820)) {
            return prefix + "Skin Shard (520-1820 RP) or Ultimate Skin";
        }
        if (values.includes(975) && values.includes(1350) && values.includes(1820) && !values.includes(520)) {
            return prefix + "Skin Shard (975+ RP) or Ultimate Skin";
        }
        return prefix + "Skin Shard or Ultimate Skin";
    }

    let exclusivity = '';
    if (isTranscendent) exclusivity = 'Transcendent ';
    else if (isExalted) exclusivity = 'Exalted ';
    else if (isMythic) exclusivity = 'Mythic ';
    else if (isExclusive) exclusivity = 'Mythic/Exclusive ';

    let suffix = '';
    if ((types.includes('SKIN') || types.includes('SKIN_RENTAL')) && values.length > 0 && !hasSkinPermanent) {
        const rpLabels = {
            3250: 'Ultimate',
            2775: 'Ultimate',
            1820: 'Legendary',
            1350: 'Epic',
            975: '975 RP',
            750: '750 RP',
            520: '520 RP',
            390: '390 RP'
        };
        const matchedVals = values.filter(v => rpLabels[v]).sort((a,b)=>a-b);
        if (matchedVals.length > 2) {
            let minLabel = matchedVals[0] + " RP";
            if (matchedVals[0] === 1350) minLabel = "Epic";
            else if (matchedVals[0] === 1820) minLabel = "Legendary";
            
            let maxLabel = matchedVals[matchedVals.length - 1] + " RP";
            if (matchedVals[matchedVals.length - 1] === 1350) maxLabel = "Epic";
            else if (matchedVals[matchedVals.length - 1] === 1820) maxLabel = "Legendary";
            else if (matchedVals[matchedVals.length - 1] === 3250 || matchedVals[matchedVals.length - 1] === 2775) maxLabel = "Ultimate";
            
            if (minLabel === maxLabel) suffix = " (" + minLabel + ")";
            else suffix = " (" + minLabel + " - " + maxLabel + ")";
        } else if (matchedVals.length > 0) {
            suffix = " (" + matchedVals.map(v => rpLabels[v]).join('/') + ")";
        }
    } else if (types.includes('CHAMPION_RENTAL')) {
        if (values.length > 0) {
            const beLabels = {
                3900: '7800 BE',
                3150: '6300 BE',
                2400: '4800 BE',
                1575: '3150 BE',
                675: '1350 BE',
                225: '450 BE'
            };
            const matchedVals = values.filter(v => beLabels[v]).sort((a,b)=>a-b);
            if (matchedVals.length > 2) {
                suffix = ` (${beLabels[matchedVals[0]]} - ${beLabels[matchedVals[matchedVals.length-1]]})`;
            } else if (matchedVals.length > 0) {
                suffix = " (" + matchedVals.map(v => beLabels[v]).join('/') + ")";
            }
        } else if (notValues.includes(225) && notValues.includes(675) && notValues.includes(1575)) {
            suffix = " (4800+ BE)";
        }
    }

    let label = prefix + exclusivity + baseType + suffix;
    
    if ((isExclusive || isMythic || isExalted || isTranscendent) && types.length > 2) {
        label = prefix + (exclusivity || 'Mythic/Exclusive ') + "Drop (" + baseType + ")";
    }

    if (baseType === 'Loot Item' && raw.length > 0) {
        if (raw.includes('==') || raw.includes('&&')) {
            return prefix + exclusivity + "Random Loot Item";
        }
        let niceRaw = raw.replace(/^(LOOTBUNDLE_|LOOTTABLE_)/, '');
        return prefix + niceRaw;
    }

    return label;
}

function parseOddsList(list) {
    const map = new Map();
    
    const flattened = [];
    for (const topNode of list) {
        flattened.push(...flattenOddsTree(topNode, 1));
    }
    
    for (const leaf of flattened) {
        const label = leaf.label;
        const rate = leaf.rate * 100;
        
        if (map.has(label)) {
            map.get(label).rate += rate;
            map.get(label).itemsCount += 1;
        } else {
            map.set(label, { label, rate: rate, itemsCount: 1 });
        }
    }
    
    return Array.from(map.values()).sort((a, b) => b.rate - a.rate);
}

function formatOddsList(parsedList) {
    if (parsedList.length > 8) {
        const firstFew = parsedList.slice(0, 5);
        const restCount = parsedList.slice(5).reduce((acc, val) => acc + val.itemsCount, 0);
        const result = firstFew.map(formatEntry);
        result.push(`<div style="color:#746e64; font-size:12px; margin-top:4px; text-align:center;">...and ${restCount} other item pools</div>`);
        return result.join('');
    }
    return parsedList.map(formatEntry).join('');
}

function colorizeRPAndTiers(text) {
    const colors = {
        ultimate: '#ffa500',
        legendary: '#e84057',
        epic: '#3ca7fe',
        classic: '#8a9aaa',
        mythic: '#c896e8',
        essence: '#0ac8b9',
        orange: '#e8a040'
    };
    
    let result = text;
    
    function safeReplace(str, pattern, color) {
        const regex = new RegExp('(?![^<]*>)' + pattern, 'gi');
        return str.replace(regex, `<span style="color:${color}; font-weight:bold;">$&</span>`);
    }
    
    result = safeReplace(result, '\\b(Ultimate|3250\\s*RP|3250|2775\\s*RP|2775)\\b', colors.ultimate);
    result = safeReplace(result, '\\b(Legendary|1820\\s*RP|1820|1850\\s*RP|1850)\\b', colors.legendary);
    result = safeReplace(result, '\\b(Epic|1350\\s*RP|1350)\\b', colors.epic);
    result = safeReplace(result, '\\b(Classic|975\\s*RP|975|750\\s*RP|750|520\\s*RP|520|975\\+)\\b', colors.classic);
    result = safeReplace(result, '\\b(Mythic|Exclusive|Transcendent|Exalted)\\b', colors.mythic);
    result = safeReplace(result, '\\b(Blue Essence)\\b', colors.essence);
    result = safeReplace(result, '\\b(Orange Essence)\\b', colors.orange);
    
    return result;
}

function formatEntry(entry) {
    let rateStr = '';
    if (Math.abs(entry.rate - 100) < 0.01) {
        rateStr = `<span style="color:#c8aa6e; font-weight:bold;">Guaranteed</span>`;
    } else if (entry.rate > 100) {
        rateStr = `<span style="color:#c8aa6e; font-weight:bold;">${(entry.rate / 100).toFixed(2)}x Expected</span>`;
    } else {
        rateStr = `<span style="color:#0ac8b9; font-weight:bold;">${entry.rate.toFixed(2)}%</span>`;
    }
    
    const coloredLabel = colorizeRPAndTiers(entry.label);
    const poolInfo = entry.itemsCount > 3 ? `<span style="color:#746e64; margin-left:6px; font-size:11px;">(Pool of ${entry.itemsCount} items)</span>` : '';
    
    return `<div class="odds-row" style="display:flex; justify-content:space-between; align-items:center; padding:10px 0; border-bottom:1px solid rgba(255,255,255,0.03); font-size:13px; transition: background 0.2s;">
        <div style="display:flex; align-items:center; flex-wrap:wrap; gap:4px;"><span style="color:#f0e6d2;">${coloredLabel}</span>${poolInfo}</div>
        <div style="white-space:nowrap; margin-left:12px;">${rateStr}</div>
    </div>`;
}

function renderOddsModal(item, odds) {
    const modalId = 'sm-whale-odds-modal';
    document.getElementById(modalId)?.remove();

    const root = document.createElement('div');
    root.id = modalId;
    Object.assign(root.style, {
        position: 'fixed', inset: 0, zIndex: 2147483647, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(3px)'
    });

    const modal = document.createElement('div');
    Object.assign(modal.style, {
        width: '630px', maxHeight: '85vh', backgroundColor: 'rgba(1, 10, 19, 0.75)', border: '1px solid rgba(200, 170, 110, 0.2)', borderRadius: '12px', display: 'flex', flexDirection: 'column', boxShadow: '0 16px 48px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.05)', backdropFilter: 'blur(25px) saturate(140%)', overflow: 'hidden', color: '#a09b8c', fontFamily: 'var(--font-body), "Segoe UI", sans-serif'
    });

    const header = document.createElement('div');
    Object.assign(header.style, { padding: '20px 24px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(0,0,0,0.2)' });

    const titleWrap = document.createElement('div');
    Object.assign(titleWrap.style, { display: 'flex', alignItems: 'center', gap: '12px' });
    
    if (item.tilePath) {
        const img = document.createElement('img');
        img.src = item.tilePath;
        Object.assign(img.style, { width: '32px', height: '32px', objectFit: 'contain', borderRadius: '4px', border: '1px solid rgba(200, 170, 110, 0.2)' });
        titleWrap.appendChild(img);
    }
    
    const title = document.createElement('div');
    title.textContent = item.itemDesc || item.localizedName || item.name || 'Loot Odds';
    Object.assign(title.style, { color: '#f0e6d2', fontWeight: 'bold', fontSize: '18px', textTransform: 'uppercase', letterSpacing: '1px' });
    titleWrap.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.innerHTML = '&#x2715;';
    Object.assign(closeBtn.style, { background: 'none', border: 'none', color: '#a09b8c', fontSize: '24px', cursor: 'pointer', padding: '0', lineHeight: '1', transition: 'color 0.15s', outline: 'none' });
    closeBtn.onmouseover = () => closeBtn.style.color = '#f0e6d2';
    closeBtn.onmouseout = () => closeBtn.style.color = '#a09b8c';
    closeBtn.onclick = () => root.remove();

    header.appendChild(titleWrap);
    header.appendChild(closeBtn);

    const body = document.createElement('div');
    Object.assign(body.style, { padding: '24px', overflowY: 'auto' });

    const css = document.createElement('style');
    css.textContent = `
        #${modalId} ::-webkit-scrollbar { width: 6px; }
        #${modalId} ::-webkit-scrollbar-track { background: transparent; }
        #${modalId} ::-webkit-scrollbar-thumb { background: rgba(200,170,110,0.15); border-radius: 3px; }
        #${modalId} ::-webkit-scrollbar-thumb:hover { background: rgba(200,170,110,0.3); }
        .odds-row:last-child { border-bottom: none !important; }
    `;
    body.appendChild(css);

    if (odds.message) {
        const msgEl = document.createElement('div');
        msgEl.textContent = odds.message;
        Object.assign(msgEl.style, { color: '#746e64', fontSize: '13px', fontStyle: 'italic', textAlign: 'center', margin: '40px 0' });
        body.appendChild(msgEl);
    } else {
        const guaranteed = parseOddsList(odds.guaranteedToContain || []);
        const chance = parseOddsList(odds.chanceToContain || []);

        if (guaranteed.length > 0) {
            const gTitle = document.createElement('div');
            gTitle.textContent = 'Guaranteed Drops';
            Object.assign(gTitle.style, { color: '#c8aa6e', fontWeight: 'bold', fontSize: '14px', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' });
            body.appendChild(gTitle);

            const gList = document.createElement('div');
            gList.innerHTML = formatOddsList(guaranteed);
            Object.assign(gList.style, {
                marginBottom: '20px', background: 'rgba(255,255,255,0.015)', padding: '12px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)'
            });
            body.appendChild(gList);
        }

        if (chance.length > 0) {
            const cTitle = document.createElement('div');
            cTitle.textContent = 'Bonus Chances';
            Object.assign(cTitle.style, { color: '#c8aa6e', fontWeight: 'bold', fontSize: '14px', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' });
            body.appendChild(cTitle);

            const cList = document.createElement('div');
            cList.innerHTML = formatOddsList(chance);
            Object.assign(cList.style, {
                marginBottom: '16px', background: 'rgba(255,255,255,0.015)', padding: '12px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.03)'
            });
            body.appendChild(cList);
        }

        const pityActive = odds.hasPityRules !== undefined ? odds.hasPityRules : (odds.badLuckProtectionActive !== undefined ? odds.badLuckProtectionActive : odds.pityActive);
        const checksOwnership = odds.checksOwnership;

        const flagsContainer = document.createElement('div');
        flagsContainer.style.display = 'flex';
        flagsContainer.style.justifyContent = 'center';
        flagsContainer.style.gap = '16px';
        flagsContainer.style.marginTop = '16px';
        flagsContainer.style.marginBottom = '8px';
        
        const iconFilter = 'invert(66%) sepia(9%) saturate(415%) hue-rotate(3deg) brightness(93%) contrast(88%)';
        if (pityActive !== undefined) {
            const pity = document.createElement('div');
            pity.style.display = 'flex';
            pity.style.alignItems = 'center';
            pity.style.gap = '6px';
            pity.innerHTML = pityActive ? `<img src="/fe/lol-static-assets/svg/bad_luck_protection_dice.svg" style="width:16px;height:16px;filter:${iconFilter};"> <span>Bad Luck Protection: <span style="color:#0ac8b9;font-weight:bold;">Active</span></span>` : `<img src="/fe/lol-static-assets/svg/bad_luck_protection_dice.svg" style="width:16px;height:16px;opacity:0.5;filter:${iconFilter};"> <span>Bad Luck Protection: <span style="color:#746e64;">Disabled</span></span>`;
            pity.style.color = '#a09b8c';
            pity.style.fontSize = '12px';
            flagsContainer.appendChild(pity);
        }

        if (checksOwnership !== undefined) {
            const ownership = document.createElement('div');
            ownership.style.display = 'flex';
            ownership.style.alignItems = 'center';
            ownership.style.gap = '6px';
            ownership.innerHTML = checksOwnership ? `<img src="/fe/lol-static-assets/svg/no_duplicates_cross_out.svg" style="width:16px;height:16px;filter:${iconFilter};"> <span>Checks Ownership: <span style="color:#0ac8b9;font-weight:bold;">Yes</span></span>` : `<img src="/fe/lol-static-assets/svg/no_duplicates_cross_out.svg" style="width:16px;height:16px;opacity:0.5;filter:${iconFilter};"> <span>Checks Ownership: <span style="color:#746e64;">No</span></span>`;
            ownership.style.color = '#a09b8c';
            ownership.style.fontSize = '12px';
            flagsContainer.appendChild(ownership);
        }

        if (flagsContainer.childNodes.length > 0) {
            body.appendChild(flagsContainer);
        }
    }

    modal.appendChild(header);
    modal.appendChild(body);
    root.appendChild(modal);

    root.onclick = (e) => { if (e.target === root) root.remove(); };

    document.body.appendChild(root);
}



let activeRecipeName = null;
let activeItemName = null;

function installContextMenuInterceptors() {
    const pattern = /\/lol-loot\/v1\/player-loot\/(.+)\/context-menu/;

    const handleResponse = (text) => {
        if (!isDropOddsEnabled) return text;
        try {
            const data = JSON.parse(text);
            if (Array.isArray(data)) {
                // Find any open or forge action to get its recipe name
                const openAction = data.find(a => a.actionType === 'OPEN' || a.actionType === 'FORGE' || a.actionType === 'CRAFT');
                if (openAction) {
                    activeRecipeName = openAction.name;
                    activeItemName = openAction.recipeDescription || openAction.recipeContextMenuAction || "Loot Item";
                    
                    Utils.Debug.log("[WhaleHelper Debug] Intercepted context-menu response for openable item. Recipe:", activeRecipeName);
                    
                    data.push({
                        actionType: "VIEW_ODDS", // VIEW_ODDS
                        enabled: true,
                        essenceQuantity: 0,
                        essenceType: "",
                        name: "VIEW_ODDS_" + openAction.name,
                        recipeContextMenuAction: "View Drop Rates",
                        recipeDescription: "View Drop Rates",
                        requiredOthers: "",
                        requiredOthersCount: 0,
                        requiredOthersName: "",
                        requiredTokens: ""
                    });
                    return JSON.stringify(data);
                }
            }
        } catch (err) {
            Utils.Debug.error("[WhaleHelper Debug] Context menu intercept error:", err);
        }
        return text;
    };

    // Intercept requests for context menu options
    Utils.Hooks.Fetch.hookRes(pattern, handleResponse);
    Utils.Hooks.Xhr.hookRes(pattern, (method, url, xhr, responseText) => {
        return handleResponse(responseText);
    });
}

function installClickCapture() {
    Utils.DOM.observer.observe('lol-uikit-context-menu', (menu) => {
        menu.addEventListener('click', (e) => {
            const path = e.composedPath() || [];
            const item = path.find(el => el && el.classList && el.classList.contains('context-menu-item'));
            
            if (item && (item.textContent.includes('View Drop Rates') || item.textContent.includes('View'))) {
                Utils.Debug.log("[WhaleHelper Debug] Captured click on View Drop Rates. Opening modal for recipe:", activeRecipeName);
                e.preventDefault();
                e.stopPropagation();
                
                if (typeof menu.close === 'function') {
                    menu.close();
                } else {
                    menu.remove();
                }
                
                if (activeRecipeName) {
                    showOddsModal({ name: activeItemName }, activeRecipeName);
                }
            }
        }, true);
    });
}

export function installEmberHook() {
    if (emberHookRegistered) return;
    emberHookRegistered = true;

    Utils.Hooks.Ember.registerRule({
        name: 'whale-helper-hook',
        matcher: 'loot-mass-disenchant-action-tab',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!isLootEnabled || !this.element) return;
                const container = this.element.closest('.loot-action-tabs-container') ?? this.element.parentElement;
                if (container) injectButton(container);
            }
        }, {
            name: 'willDestroyElement',
            callback(Ember, original, ...args) {
                removeButton();
                original(...args);
            }
        }]
    });

    Utils.Hooks.Ember.registerRule({
        name: 'skin-tier-name-hook',
        matcher: 'champion-skin-name',
        mixin() {
            return {
                didInsertElement() {
                    if (typeof this._super === 'function') {
                        this._super(...arguments);
                    }
                    this.addObserver('viewSkin', this, this.onSkinIdChange);
                    this.addObserver('skin', this, this.onSkinIdChange);
                    this.addObserver('selectedSkinId', this, this.onSkinIdChange);
                    this.onSkinIdChange();
                },
                willDestroyElement() {
                    this.removeObserver('viewSkin', this, this.onSkinIdChange);
                    this.removeObserver('skin', this, this.onSkinIdChange);
                    this.removeObserver('selectedSkinId', this, this.onSkinIdChange);
                    if (typeof this._super === 'function') {
                        this._super(...arguments);
                    }
                },
                onSkinIdChange() {
                    if (!isSkinTierEnabled || !this.element) return;
                    const skinId = extractSkinIdFromComponent(this);
                    updateBadge(this.element, skinId);
                }
            };
        }
    });

    Utils.Hooks.Ember.registerRule({
        name: 'skin-tier-select-hook',
        matcher: 'skin-select',
        wraps: [
            {
                name: 'handleSkinCarouselSkins',
                replacement: function(original, args) {
                    if (isHideUnownedEnabled && args && args[0] && Array.isArray(args[0])) {
                        // Filter unlocked skins
                        args[0] = args[0].filter(skin => {
                            if (!skin.unlocked && !skin.isBase && (!skin.id || skin.id % 1000 !== 0)) {
                                return false;
                            }
                            
                            // Mutate childSkins in-place to preserve object references for Ember observers
                            if (skin.childSkins && Array.isArray(skin.childSkins)) {
                                for (let i = skin.childSkins.length - 1; i >= 0; i--) {
                                    if (!skin.childSkins[i].unlocked) {
                                        skin.childSkins.splice(i, 1);
                                    }
                                }
                            }
                            return true;
                        });
                    }
                    return original.apply(this, args);
                }
            }
        ]
    });

    
        Utils.Debug.log('[WhaleHelper] Ember hooks registered.');
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: "whale-helper-settings",
        titleKey: "snooze_whale-helper",
        titleName: "Whale Helper",
        capitalTitleKey: "snooze_whale-helper_capital",
        capitalTitleName: "WHALE HELPER",
        class: "whale-helper-settings"
    });

    isLootEnabled     = Utils.Store.get('whaleHelper', 'lootHelperEnabled') ?? true;
    isSkinTierEnabled = Utils.Store.get('whaleHelper', 'skinTierEnabled') ?? true;
    isDropOddsEnabled = Utils.Store.get('whaleHelper', 'dropOddsEnabled') ?? true;
    isHideUnownedEnabled = Utils.Store.get('whaleHelper', 'hideUnownedEnabled') ?? false;

    if (window.SnoozeManager?.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'whaleHelper',
            name: 'Whale Helper',
            description: 'Shows you which rerollable skins you don\'t own yet, and adds a button to the loot page for easy access. It also adds skin tier badges in champion select.',
            settings: [
                {
                    type: 'toggle',
                    id: 'sm:whaleHelper',
                    label: 'Enable Rerollable Pool Button (Loot Page)',
                    value: isLootEnabled,
                    onChange: (val) => {
                        isLootEnabled = val;
                        Utils.Store.set('whaleHelper', 'lootHelperEnabled', val);
                        if (!val) { removeButton(); closePanel(); } 
                        else {
                            const container = document.querySelector('.loot-action-tabs-container');
                            if (container) injectButton(container);
                        }
                    }
                },
                {
                    type: 'toggle',
                    id: 'sm:skinTierDisplay',
                    label: 'Enable Skin Tier Badges (Champ Select)',
                    value: isSkinTierEnabled,
                    onChange: (val) => {
                        isSkinTierEnabled = val;
                        Utils.Store.set('whaleHelper', 'skinTierEnabled', val);
                        if (!val) {
                            document.querySelectorAll(`[${BADGE_ATTR}]`).forEach(el => el.remove());
                            unmountSessionObserver();
                        } else {
                            mountSessionObserver(); refreshAllBadges();
                        }
                    }
                },
                {
                    type: 'toggle',
                    id: 'sm:lootDropOdds',
                    label: 'Enable Loot Drop Odds Previewer (Loot Page)',
                    value: isDropOddsEnabled,
                    onChange: (val) => {
                        isDropOddsEnabled = val;
                        Utils.Store.set('whaleHelper', 'dropOddsEnabled', val);
                    }
                },
                {
                    type: 'toggle',
                    id: 'sm:hideUnownedSkins',
                    label: 'Hide Unowned Skins & Chromas (Champ Select)',
                    value: isHideUnownedEnabled,
                    onChange: (val) => {
                        isHideUnownedEnabled = val;
                        Utils.Store.set('whaleHelper', 'hideUnownedEnabled', val);
                    }
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.whale-helper-settings", (plugin) => {
            plugin.innerHTML = '';
            plugin.appendChild(Utils.Settings.createToggleRow("Enable Whale Helper (Loot Page)", isLootEnabled, (val) => {
                isLootEnabled = val; Utils.Store.set('whaleHelper', 'lootHelperEnabled', val);
                if (!val) { removeButton(); closePanel(); } else {
                    const container = document.querySelector('.loot-action-tabs-container'); if (container) injectButton(container);
                }
            }));

            plugin.appendChild(Utils.Settings.createToggleRow("Enable Skin Tier Badges (Champ Select)", isSkinTierEnabled, (val) => {
                isSkinTierEnabled = val; Utils.Store.set('whaleHelper', 'skinTierEnabled', val);
                if (!val) {
                    document.querySelectorAll(`[${BADGE_ATTR}]`).forEach(el => el.remove());
                    unmountSessionObserver();
                } else { mountSessionObserver(); refreshAllBadges(); }
            }));

            plugin.appendChild(Utils.Settings.createToggleRow("Enable Loot Drop Odds Previewer (Loot Page)", isDropOddsEnabled, (val) => {
                isDropOddsEnabled = val; Utils.Store.set('whaleHelper', 'dropOddsEnabled', val);
            }));

            plugin.appendChild(Utils.Settings.createToggleRow("Hide Unowned Skins & Chromas (Champ Select)", isHideUnownedEnabled, (val) => {
                isHideUnownedEnabled = val; Utils.Store.set('whaleHelper', 'hideUnownedEnabled', val);
            }));
        });
    }
}


export function load() {
    injectStyles();
    loadSkinsCache().catch(() => {});
    if (isSkinTierEnabled) mountSessionObserver();
    installContextMenuInterceptors();
    installClickCapture();
    Utils.Debug.log('[WhaleHelper] Module loaded.');
}
