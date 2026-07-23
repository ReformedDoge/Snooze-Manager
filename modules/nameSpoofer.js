/**
 * @name NameSpoofer
 * @version 1.0.0
 * @author Lx - github@iIlusion
 * @description Locally spoofs your displayed Riot ID by rewriting the identity fields. Cosmetic only: others still see your real name.
 * @link https://github.com/iIlusion
 */
import { t } from './i18n.js';
import Utils from './generalUtils.js';

const MODULE = 'nameSpoofer';

let _emberProvider = null;
let _hasSpoofedAnything = false;

// In-memory mirror of the persisted config (read on every hook, so keep it hot).
const cfg = {
    enabled: false, // global master switch (turns ALL spoofing on/off)
    spoofSelf: true, // spoof my own name
    gameName: t('Name Spoofer'),
    tagLine: t('Pengu'),
    friendName: t('Friend'),
    friendNumbers: true,
    globalName: t('Player'),
    globalNumbers: true,
    spoofFriends: false,
    spoofLobby: false,
    spoofChampSelect: false, // non-ranked only
    spoofMatchHistory: false
};

// Real identity, captured once. `puuid` lets us spoof ourselves on generic
// (multi-player) endpoints without touching anyone else.
const real = {
    puuid: null,
    gameName: '',
    tagLine: '',
    displayName: ''
};

// Live gameflow context, updated via LCU WebSocket observe.
const ctx = {
    phase: 'None',
    isRanked: false
};

// Fallback when gameData.queue.isRanked is absent.
const RANKED_QUEUES = new Set([420, 440]);

function catCfg(category) {
    // Only "friend" gets its own label; ally/enemy/other all share the global "Player" label.
    if (category === 'friend') return [cfg.friendName, cfg.friendNumbers];
    return [cfg.globalName, cfg.globalNumbers];
}

// Stable per-category, per-key numbering: a given key always reads "<Base> N".
// With "Include Numbers" off for the category, returns just "<Base>".
const catMaps = {};
const catCount = {};

function catLabel(category, key) {
    const [base, useNum] = catCfg(category);
    if (!useNum || !key) return base;
    const m = catMaps[category] || (catMaps[category] = {});
    if (m[key] == null) m[key] = (catCount[category] = (catCount[category] || 0) + 1);
    return base + ' ' + m[key];
}

// Known-friend membership, so friends are aliased wherever they appear (even when
// numbering is off and catLabel doesn't populate its map).
const friendPuuids = new Set();
const friendRegistry = new Map(); // key='puuid:<uuid>' or 'name:<name>' → {spoofLabel, realName}
let friendCounter = 0;

function friendLabel(key) {
    if (key) friendPuuids.add(key);
    if (key && friendRegistry.has('puuid:' + key)) return friendRegistry.get('puuid:' + key).spoofLabel;
    return registerFriend(null, key);
}

function registerFriend(realName, puuid) {
    if (puuid) {
        const k = 'puuid:' + puuid;
        if (friendRegistry.has(k)) {
            const e = friendRegistry.get(k);
            if (realName) realToAlias[realName] = e.spoofLabel;
            return e.spoofLabel;
        }
    }
    if (realName) {
        const k = 'name:' + realName;
        if (friendRegistry.has(k)) {
            const e = friendRegistry.get(k);
            if (puuid) {
                friendPuuids.add(puuid);
                friendRegistry.set('puuid:' + puuid, e);
            }
            return e.spoofLabel;
        }
    }
    const [base, useNum] = catCfg('friend');
    friendCounter++;
    const label = useNum ? (base + ' ' + friendCounter) : base;
    const entry = {
        spoofLabel: label,
        realName
    };
    if (puuid) {
        friendPuuids.add(puuid);
        friendRegistry.set('puuid:' + puuid, entry);
    }
    if (realName) {
        friendRegistry.set('name:' + realName, entry);
        realToAlias[realName] = label;
    }
    return label;
}

function lookupFriend(puuid, nameText) {
    if (puuid) {
        const e = friendRegistry.get('puuid:' + puuid.split('@')[0]);
        if (e) return e.spoofLabel;
    }
    if (nameText) {
        const e = friendRegistry.get('name:' + nameText);
        if (e) return e.spoofLabel;
    }
    return null;
}

// Match-history / post-game others are numbered by render order per game.
function nextOther(counters) {
    const [base, useNum] = catCfg('global');
    if (!useNum) return base;
    counters.n = (counters.n || 0) + 1;
    return base + ' ' + counters.n;
}

// Per-game counter for swapNameText fallback (enemies in post-game/honor).
let _postgameNameIndex = 0;

// Real name -> alias capture, so the DOM scrubber can fix cached renders (hovercard).
const realToAlias = {};

function noteFriend(realName, label) {
    if (realName && label && realName !== label) {
        const clean = realName.replace(/[⁦-⁩‎‏]/g, '');
        if (clean === label) return;
        // Prevent alias-to-alias entries: don't register an alias as a real name
        for (const v of Object.values(realToAlias)) {
            if (v === clean) return;
        }
        realToAlias[clean] = label;
    }
}

// Per-match-history context for component-data fallback (cached entries that
// don't trigger XHR). Reset on every match-history request.
let _mhCtx = null;

function _mhCtxGet() {
    if (!_mhCtx) _mhCtx = {
        selfTeamId: null,
        otherN: 0
    };
    return _mhCtx;
}

function _mhAliasFromComponent(comp) {
    let part, player;
    try {
        part = comp.get ? comp.get('participant') : comp.participant;
        player = part && (part.player || part);
    } catch {
        logDebug('mh-alias', 'catch');
        return null;
    }
    if (!player) {
        logDebug('mh-alias', 'null player');
        return null;
    }
    const pName = nameOf(player);
    if (!pName) {
        logDebug('mh-alias', 'null pName');
        return null;
    }
    const pPuuid = puuidOf(player);
    const ctx = _mhCtxGet();
    const pTeamId = part ? (part.teamId || player.teamId) : player.teamId;
    // Detect self via CSS class `me` FIRST; return self alias
    if (comp.element && comp.element.classList.contains('me')) {
        if (ctx.selfTeamId == null) ctx.selfTeamId = pTeamId;
        if (!ctx._mhSelfFound) {
            ctx._mhSelfFound = true;
            queueMicrotask(() => {
                const snapshot = [..._emberComponents];
                for (const c of snapshot) {
                    if (c !== comp && c.element && c.element.classList.contains('player-history-object')) {
                        try {
                            c.rerender();
                        } catch {}
                    }
                }
            });
        }
        return cfg.gameName;
    }
    // Use component-derived context only — never read from realToAlias
    if (ctx.selfTeamId == null || pTeamId == null) return null;
    // Local cache prevents double-counting on rerender triggered by the self
    // detection microtask above
    const cacheKey = pPuuid || pName;
    if (ctx._mhLabels && ctx._mhLabels[cacheKey] !== undefined) return ctx._mhLabels[cacheKey];
    if (!ctx._mhLabels) ctx._mhLabels = {};
    // Check if this player is a known friend
    if (pPuuid && friendPuuids.has(pPuuid)) {
        const label = friendLabel(pPuuid);
        ctx._mhLabels[cacheKey] = label;
        return label;
    }
    const [base, useNum] = catCfg('global');
    const label = useNum ? (base + ' ' + (++ctx.otherN)) : base;
    ctx._mhLabels[cacheKey] = label;
    logDebug('mh', 'alias "' + pName + '" teamId=' + pTeamId + ' selfTeamId=' + ctx.selfTeamId + ' -> ' + label);
    return label;
}



// Track Ember component instances that we modify, so we can rerender() them
// with real data when the module is disabled.
const _emberComponents = new Set();
const _hookCleanups = []; // cleanup functions returned by registerRule, called by dispose()
const _partyComponents = new Set();
const _mhComponents = new Set(); // match-history components, processed when identity arrives
function trackComponent(c) {
    if (c && c.element && c.rerender) _emberComponents.add(c);
}

function trackMhComponent(c) {
    if (c && c.element) _mhComponents.add(c);
}

function untrackComponent(c) {
    if (c) _emberComponents.delete(c);
}

function rerenderTracked() {
    logDebug('rerender', 'rerendering ' + _emberComponents.size + ' tracked components');
    for (const c of _emberComponents) {
        try {
            c.rerender();
        } catch {}
    }
    _emberComponents.clear();
}

function triggerRosterRebuild() {
    const provider = _emberProvider || window.__SM_EMBER;
    logDebug('roster', 'triggerRosterRebuild provider=' + (provider ? 'yes' : 'no') + ' __SM_EMBER=' + (window.__SM_EMBER ? 'yes' : 'no'));
    if (!provider) {
        logDebug('roster', 'no provider -> rerenderTracked');
        rerenderTracked();
        return;
    }
    provider.getEmber().then(Ember => {
        logDebug('roster', 'got Ember, searching namespaces...');
        let hadFriendGroups = false;
        try {
            for (const ns of Ember.Namespace.NAMESPACES) {
                const c = ns.__container__;
                if (!c) continue;
                const fg = c.lookup('service:friend-groups');
                if (fg) {
                    const groups = fg.get('friendGroups');
                    logDebug('roster', 'found friendGroups, len=' + (groups ? groups.length : 'null') + ' isArray=' + Array.isArray(groups));
                    if (groups && Array.isArray(groups)) {
                        fg.set('friendGroups', groups.slice());
                        logDebug('roster', 'set friendGroups to new array');
                        hadFriendGroups = true;
                    }
                    break;
                }
            }
        } catch (e) {
            Utils.Debug.warn('[NameSpoofer] Roster rebuild failed:', e);
        }
        if (!hadFriendGroups) {
            logDebug('roster', 'no friendGroups service -> rerenderTracked');
            rerenderTracked();
        }
        rerenderTracked();
    }).catch((e) => {
        Utils.Debug.warn('[NameSpoofer] getEmber failed:', e);
        rerenderTracked();
    });
}



// Match data often anonymizes puuids to all-zeros, so the alias key falls back to name.
const ZERO_PUUID = '00000000-0000-0000-0000-000000000000';

function validPuuid(p) {
    return p && p !== ZERO_PUUID;
}

// Endpoints whose response root is us -> rewrite unconditionally (incl. `name`).
const ME_ENDPOINTS = [
    '/lol-summoner/v1/current-summoner',
    '/lol-chat/v1/me'
];

// Multi-player endpoints -> self-spoof + alias known friends (by puuid). Chat
// conversations/participants are where the friend hovercard reads its name from.
const GENERIC_ENDPOINTS = [
    '/lol-gameflow/v1/session'
];

// Summoner-name resolvers (by id/puuid), used by player search/profiles AND
// champ-select cells: self+friends normally, but alias everyone as allies while
// in champ select / lobby (the cells resolve names through here).
const SUMMONER_LOOKUP = [
    '/lol-summoner/v2/summoners',
    '/lol-summoner/v1/summoners'
];

// Match-history endpoints (LCU + external SGP). Substring matching also catches
const MATCH_HISTORY_ENDPOINTS = [
    '/lol-match-history/v1/products/lol',
    '/lol-match-history/v1/games',
    'match-history-query/v1/products/lol'
];

// Post-game (end-of-game stats + honor ballot): same team-aware aliasing.
const POST_GAME_ENDPOINTS = [
    '/lol-end-of-game/v1/eog-stats-block',
    '/lol-honor-v2/v1/ballot'
];

// Champ-select data endpoints — names flow through here to the chat iframe override JSON
const CHAMPSELECT_ENDPOINTS = [
    '/lol-champ-select/v1/session',
    '/lol-champ-select/v1/summoners/'
];

// WebSocket pushes that carry our identity.
const ME_WS = [
    '/lol-summoner/v1/current-summoner',
    '/lol-chat/v1/me'
];

function loadConfig() {
    cfg.enabled = Utils.Store.get(MODULE, 'enabled') || false;
    cfg.spoofSelf = Utils.Store.get(MODULE, 'spoofSelf', true);
    cfg.gameName = Utils.Store.get(MODULE, 'gameName', t('Name Spoofer'));
    cfg.tagLine = Utils.Store.get(MODULE, 'tagLine', t('Pengu'));
    cfg.friendName = Utils.Store.get(MODULE, 'friendName', t('Friend')) || t('Friend');
    cfg.globalName = Utils.Store.get(MODULE, 'globalName', t('Player')) || t('Player');
    cfg.friendNumbers = Utils.Store.get(MODULE, 'friendNumbers', true);
    cfg.globalNumbers = Utils.Store.get(MODULE, 'globalNumbers', true);
    cfg.spoofFriends = Utils.Store.get(MODULE, 'spoofFriends') || false;
    cfg.spoofLobby = Utils.Store.get(MODULE, 'spoofLobby') || false;
    cfg.spoofChampSelect = Utils.Store.get(MODULE, 'spoofChampSelect') || false;
    cfg.spoofMatchHistory = Utils.Store.get(MODULE, 'spoofMatchHistory') || false;
}

function active() {
    return cfg.enabled && cfg.spoofSelf && (cfg.gameName || cfg.tagLine);
}

function aliasOthersNow() {
    if (!cfg.enabled) return false;
    if (ctx.phase === 'ChampSelect') return cfg.spoofChampSelect && !ctx.isRanked;
    if (ctx.phase === 'Lobby' || ctx.phase === 'Matchmaking' || ctx.phase === 'ReadyCheck') return cfg.spoofLobby;
    return false;
}

function logDebug(tag, msg, extra) {
    if (extra) Utils.Debug.log('[NS-DEBUG][' + tag + '] ' + msg, extra);
    else Utils.Debug.log('[NS-DEBUG][' + tag + '] ' + msg);
}

function scrubActive() {
    return cfg.enabled && ((active() && real.gameName) || aliasOthersNow() || cfg.spoofFriends || cfg.spoofMatchHistory);
}

function applyName(obj, allowName, gameName, tagLine) {
    if (!obj || typeof obj !== 'object') return;
    if (gameName) {
        for (const k of ['gameName', 'displayName', 'summonerName', 'internalName',
                'summonerInternalName', 'riotIdGameName'
            ]) {
            if (k in obj) obj[k] = gameName;
        }
        if (allowName && 'name' in obj && typeof obj.name === 'string') obj.name = gameName;
    }
    if (tagLine != null) {
        for (const k of ['tagLine', 'gameTag', 'riotIdTagLine']) {
            if (k in obj) obj[k] = tagLine;
        }
    }
}

function hasNameField(o) {
    return o !== null && typeof o === 'object' && ('gameName' in o || 'summonerName' in o || 'riotIdGameName' in o || 'displayName' in o);
}

function nameOf(o) {
    return o.gameName || o.summonerName || o.riotIdGameName || o.displayName;
}

function puuidOf(o) {
    if (validPuuid(o.puuid)) return o.puuid;
    for (const k of ['id', 'pid']) {
        const v = o[k];
        if (typeof v === 'string') {
            const p = v.split('@')[0];
            if (validPuuid(p)) return p;
        }
    }
    return null;
}

function isSelf(o, nm) {
    nm = nm || nameOf(o);
    return (validPuuid(o.puuid) && o.puuid === real.puuid) ||
        (real.gameName && nm === real.gameName) ||
        (cfg.gameName && nm === cfg.gameName);
}

function spoofSelf(node, isMeRoot) {
    if (Array.isArray(node)) {
        for (const n of node) spoofSelf(n, false);
        return;
    }
    if (!node || typeof node !== 'object') return;
    if (isMeRoot || isSelf(node)) applyName(node, isMeRoot, cfg.gameName, cfg.tagLine);
    for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') spoofSelf(v, false);
    }
}

function aliasConversations(data, selfOn) {
    if (Array.isArray(data)) {
        for (const n of data) aliasConversations(n, selfOn);
        return;
    }
    if (!data || typeof data !== 'object') return;
    if (isSelf(data)) {
        if (selfOn) applyName(data, true, cfg.gameName, cfg.tagLine);
    } else if (hasNameField(data)) {
        const pu = puuidOf(data);
        const nm = nameOf(data);
        const key = pu || nm;
        if (key) {
            let l;
            if (pu && friendPuuids.has(pu)) {
                l = registerFriend(nm, pu);
            } else {
                l = catLabel('global', key);
            }
            noteFriend(nameOf(data), l);
            applyName(data, true, l, '');
        }
    }
    for (const k in data) {
        const v = data[k];
        if (v && typeof v === 'object') aliasConversations(v, selfOn);
    }
}

function spoofSelfAndFriends(node, isMeRoot, selfOn) {
    if (Array.isArray(node)) {
        for (const n of node) spoofSelfAndFriends(n, false, selfOn);
        return;
    }
    if (!node || typeof node !== 'object') return;
    if (isMeRoot || isSelf(node)) {
        if (selfOn) applyName(node, true, cfg.gameName, cfg.tagLine);
    } else if (cfg.spoofFriends && hasNameField(node)) {
        const pu = puuidOf(node);
        if (pu && friendPuuids.has(pu)) {
            const l = friendLabel(pu);
            noteFriend(nameOf(node), l);
            applyName(node, true, l, '');
        }
    }
    for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') spoofSelfAndFriends(v, false, selfOn);
    }
}

function aliasFriendsList(node, selfOn, category) {
    if (Array.isArray(node)) {
        for (const n of node) aliasFriendsList(n, selfOn, category);
        return;
    }
    if (!node || typeof node !== 'object') return;
    if (hasNameField(node)) {
        if (isSelf(node)) {
            if (selfOn) applyName(node, true, cfg.gameName, cfg.tagLine);
        } else {
            const pu = puuidOf(node);
            const key = pu || (node.summonerId && ('sid:' + node.summonerId)) || nameOf(node);
            if (key) {
                const nm = nameOf(node);
                if (category === 'friend') {
                    const l = registerFriend(nm, pu);
                    noteFriend(nm, l);
                    applyName(node, true, l, '');
                } else {
                    if (pu) friendPuuids.add(pu);
                    const l = catLabel(category, key);
                    noteFriend(nm, l);
                    applyName(node, true, l, '');
                }
            }
        }
    }
    for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') aliasFriendsList(v, selfOn, category);
    }
}

async function syncFriends() {
    if (!Utils.LCU) return;
    try {
        const friends = await Utils.LCU.get('/lol-chat/v1/friends');
        if (Array.isArray(friends)) {
            for (const f of friends) {
                const pu = puuidOf(f);
                const nm = nameOf(f);
                if (pu && nm) registerFriend(nm, pu);
            }
        }
    } catch (e) {
        logDebug('syncFriends', 'failed: ' + e);
    }
}

function resolveAlias(nm, pu, counters) {
    if (!nm) return null;
    // Check friend status FIRST (before realToAlias cache) so a stale "Player N"
    // label from an early sweep gets corrected once friendPuuids is populated.
    if (pu && friendPuuids.has(pu)) {
        const label = friendLabel(pu);
        noteFriend(nm, label);
        return label;
    }
    if (realToAlias[nm]) return realToAlias[nm];
    if (counters) {
        const label = nextOther(counters);
        noteFriend(nm, label);
        return label;
    }
    const key = pu || ('name:' + nm);
    const label = catLabel('global', key);
    noteFriend(nm, label);
    return label;
}

function applyOther(o, counters, selfOn, readOnly) {
    if (!o || typeof o !== 'object') return;
    if (isSelf(o)) {
        if (selfOn && !readOnly) applyName(o, true, cfg.gameName, cfg.tagLine);
        return;
    }
    const nm = nameOf(o);
    if (!nm) return;
    const pu = puuidOf(o);
    const label = resolveAlias(nm, pu, counters);
    if (!label) return;
    if (!readOnly) noteFriend(nm, label);
    if (!readOnly) applyName(o, true, label, '');
}

function aliasTeam(node, selfOn, readOnly) {
    if (Array.isArray(node)) {
        for (const n of node) aliasTeam(n, selfOn, readOnly);
        return;
    }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.participantIdentities) && Array.isArray(node.participants)) {
        aliasLcuGame(node, selfOn, readOnly);
        return;
    }
    if (Array.isArray(node.teams) && node.teams[0] && Array.isArray(node.teams[0].players)) {
        aliasEogTeams(node, selfOn, readOnly);
        return;
    }
    if (Array.isArray(node.participants) && node.participants[0] && hasNameField(node.participants[0])) {
        aliasFlatParticipants(node.participants, selfOn, readOnly);
        return;
    }
    if (Array.isArray(node.eligiblePlayers) || Array.isArray(node.eligibleAllies) || Array.isArray(node.eligibleOpponents)) {
        const c = {};
        const allOthers = [...(node.eligibleAllies || node.eligiblePlayers || []), ...(node.eligibleOpponents || [])];
        for (const p of allOthers)
            if (p && hasNameField(p)) applyOther(p, c, selfOn, readOnly);
        return;
    }
    for (const k in node) {
        const v = node[k];
        if (v && typeof v === 'object') aliasTeam(v, selfOn, readOnly);
    }
}

function aliasLcuGame(game, selfOn, readOnly) {
    const c = {};
    for (const idn of game.participantIdentities) {
        if (!idn.player) continue;
        applyOther(idn.player, c, selfOn, readOnly);
    }
}

function aliasEogTeams(node, selfOn, readOnly) {
    const c = {};
    for (const t of node.teams) {
        for (const pl of (t.players || [])) applyOther(pl, c, selfOn, readOnly);
    }
    if (node.localPlayer && selfOn && !readOnly) applyName(node.localPlayer, false, cfg.gameName, cfg.tagLine);
}

function aliasFlatParticipants(parts, selfOn, readOnly) {
    const c = {};
    for (const p of parts) applyOther(p, c, selfOn, readOnly);
}

function needsWork(opts) {
    return active() || (cfg.enabled && (opts.others || cfg.spoofFriends));
}

function transformObject(data, opts) {
    const others = opts.others;
    const selfOn = active();
    if (others === 'team') aliasTeam(data, selfOn, opts.collectOnly);
    else if (others === 'friendsList') aliasFriendsList(data, selfOn, 'friend');
    else if (others === 'globalList') aliasFriendsList(data, selfOn, 'global');
    else if (others === 'conversations') aliasConversations(data, selfOn);
    else spoofSelfAndFriends(data, opts.isMeRoot, selfOn);
}

function transformText(text, opts) {
    if (!text || !needsWork(opts)) return text;
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        return text;
    }
    try {
        transformObject(data, opts);
        return opts.collectOnly ? text : JSON.stringify(data);
    } catch (e) {
        Utils.Debug.warn('[NameSpoofer] transform failed:', e);
        return text;
    }
}

let _xhrInstalled = false;
let _xhrFallbackUsed = false;
let _xhrRespGet, _xhrTextGet;
const _xhrRoutes = [];

function assertXhr() {
    const proto = XMLHttpRequest.prototype;
    if (proto.open && proto.open._nsHook) return;
    if (!_xhrRespGet) {
        const respDesc = Object.getOwnPropertyDescriptor(proto, 'response');
        const textDesc = Object.getOwnPropertyDescriptor(proto, 'responseText');
        if (!respDesc || !textDesc) {
            Utils.Debug.warn('[NameSpoofer] XHR getters unavailable — another plugin mangled XMLHttpRequest.prototype. Falling back to Utils.Hooks.Xhr.');
            installXhrFallback();
            return;
        }
        _xhrRespGet = respDesc.get;
        _xhrTextGet = textDesc.get;
    }
    const prevOpen = proto.open;
    const respGet = _xhrRespGet,
        textGet = _xhrTextGet;
    const nsOpen = function(m, u, ...rest) {
        if (!cfg.enabled) return prevOpen.call(this, m, u, ...rest);
        const url = String(u);
        const route = _xhrRoutes.find((rt) => url.indexOf(rt.pattern) !== -1);
        if (route) {
            const opts = route.optsFn;
            let objDone = false,
                textCache;
            try {
                Object.defineProperty(this, 'response', {
                    configurable: true,
                    get() {
                        let raw;
                        try {
                            raw = respGet.call(this);
                        } catch {
                            return undefined;
                        }
                        if (this.readyState !== 4 || !needsWork(opts())) return raw;
                        if (raw && typeof raw === 'object') {
                            if (!objDone) {
                                try {
                                    transformObject(raw, opts());
                                } catch {}
                                objDone = true;
                            }
                            return raw;
                        }
                        if (typeof raw === 'string') {
                            if (textCache === undefined) textCache = transformText(raw, opts());
                            return textCache;
                        }
                        return raw;
                    }
                });
                Object.defineProperty(this, 'responseText', {
                    configurable: true,
                    get() {
                        let raw;
                        try {
                            raw = textGet.call(this);
                        } catch {
                            return '';
                        }
                        if (this.readyState !== 4 || typeof raw !== 'string' || !raw || !needsWork(opts())) return raw;
                        if (textCache === undefined) textCache = transformText(raw, opts());
                        return textCache;
                    }
                });
            } catch (e) {}
        }
        return prevOpen.call(this, m, u, ...rest);
    };
    nsOpen._nsHook = true;
    proto.open = nsOpen;
}

function installXhrFallback() {
    if (_xhrFallbackUsed) return;
    _xhrFallbackUsed = true;
    const reg = (pattern, optsFn) => {
        Utils.Hooks.Xhr.hookRes(pattern, (...args) => transformText(args[3], optsFn()));
    };
    reg('/lol-match-history/v1/recently-played-summoners', () => ({
        others: cfg.spoofFriends ? 'globalList' : false
    }));
    reg('/lol-summoner/v1/summoners/aliases', () => ({
        others: cfg.spoofFriends ? 'friendsList' : false
    }));
    for (const ep of ME_ENDPOINTS) reg(ep, () => ({
        isMeRoot: true,
        others: false
    }));
    for (const ep of GENERIC_ENDPOINTS) reg(ep, () => ({
        isMeRoot: false,
        others: false
    }));
    reg('/lol-chat/v1/conversations', () => ({
        isMeRoot: false,
        others: 'conversations'
    }));
    reg('/lol-chat/v1/friends', () => ({
        isMeRoot: false,
        others: cfg.spoofFriends ? 'friendsList' : false
    }));
    for (const ep of MATCH_HISTORY_ENDPOINTS) reg(ep, () => {
        _mhCtx = null;
        return {
            others: 'team',
            collectOnly: true
        };
    });
    for (const ep of POST_GAME_ENDPOINTS) reg(ep, () => ({
        others: 'team',
        collectOnly: true
    }));
    for (const ep of CHAMPSELECT_ENDPOINTS) reg(ep, () => ({
        isMeRoot: false,
        others: 'conversations'
    }));
}

function installXhr() {
    if (_xhrInstalled) return;
    _xhrInstalled = true;
    assertXhr();
}

let _hooksInstalled = false;
const _fetchCleanups = [];

function installHooks(context) {
    if (_hooksInstalled) return;
    _hooksInstalled = true;
    installXhr();

    const reg = (pattern, optsFn) => {
        _fetchCleanups.push(Utils.Hooks.Fetch.hookRes(pattern, (text) => transformText(text, optsFn())));
        _xhrRoutes.push({
            pattern,
            optsFn
        });
    };

    reg('/lol-match-history/v1/recently-played-summoners', () => ({
        others: cfg.spoofFriends ? 'globalList' : false
    }));
    reg('/lol-summoner/v1/summoners/aliases', () => ({
        others: cfg.spoofFriends ? 'friendsList' : false
    }));

    for (const ep of ME_ENDPOINTS) reg(ep, () => ({
        isMeRoot: true,
        others: false
    }));
    for (const ep of GENERIC_ENDPOINTS) reg(ep, () => ({
        isMeRoot: false,
        others: false
    }));
    for (const ep of MATCH_HISTORY_ENDPOINTS) reg(ep, () => {
        _mhCtx = null;
        return {
            others: 'team',
            collectOnly: true
        };
    });
    for (const ep of POST_GAME_ENDPOINTS) reg(ep, () => ({
        others: 'team',
        collectOnly: true
    }));
    for (const ep of CHAMPSELECT_ENDPOINTS) reg(ep, () => ({
        isMeRoot: false,
        others: 'conversations'
    }));

    _fetchCleanups.push(Utils.Hooks.Fetch.hookRes('/lol-chat/v1/conversations', (text) => transformText(text, {
        isMeRoot: false,
        others: 'conversations'
    })));
    _xhrRoutes.unshift({
        pattern: '/lol-chat/v1/conversations',
        optsFn: () => ({
            isMeRoot: false,
            others: 'conversations'
        })
    });
    _fetchCleanups.push(Utils.Hooks.Fetch.hookRes('/lol-chat/v1/friends', (text) => transformText(text, {
        isMeRoot: false,
        others: cfg.spoofFriends ? 'friendsList' : false
    })));
    _xhrRoutes.unshift({
        pattern: '/lol-chat/v1/friends',
        optsFn: () => ({
            isMeRoot: false,
            others: cfg.spoofFriends ? 'friendsList' : false
        })
    });

    Utils.Hooks.WS.install(context);
    for (const ep of ME_WS) {
        Utils.Hooks.WS.hook(ep, (_endpoint, payload) => {
            if (!active() || !payload || typeof payload !== 'object') return payload;
            try {
                spoofSelf(payload, true);
            } catch (e) {
                Utils.Debug.warn('[NameSpoofer] WS transform failed:', e);
            }
            return payload;
        });
    }
    // Champ-select session WS: transform names in the session data
    Utils.Hooks.WS.hook('/lol-champ-select/v1/session', (_endpoint, payload) => {
        if (!payload || typeof payload !== 'object') return payload;
        try {
            const teams = ['myTeam', 'theirTeam'];
            for (const teamKey of teams) {
                const members = payload[teamKey];
                if (!Array.isArray(members)) continue;
                for (const m of members) {
                    if (!m || typeof m !== 'object') continue;
                    const nm = nameOf(m);
                    if (!nm) continue;
                    if (isSelf(m)) {
                        if (active()) applyName(m, true, cfg.gameName, cfg.tagLine);
                    } else if (cfg.spoofFriends || aliasOthersNow()) {
                        const pu = puuidOf(m);
                        const alias = resolveAlias(nm, pu);
                        if (alias && alias !== nm) {
                            applyName(m, true, alias, '');
                        }
                    }
                }
            }
        } catch (e) {
            Utils.Debug.warn('[NameSpoofer] ChampSelect WS transform failed:', e);
        }
        return payload;
    });

    // Friends list WS: alias known friends on live updates
    Utils.Hooks.WS.hook('/lol-chat/v1/friends', (_endpoint, payload) => {
        if (!payload || typeof payload !== 'object') return payload;
        if (!cfg.enabled || !cfg.spoofFriends) return payload;
        try {
            aliasFriendsList(payload, active(), 'friend');
        } catch (e) {
            Utils.Debug.warn('[NameSpoofer] WS friends transform failed:', e);
        }
        return payload;
    });

    // Conversations WS: alias participants on live updates
    Utils.Hooks.WS.hook('/lol-chat/v1/conversations', (_endpoint, payload) => {
        if (!payload || typeof payload !== 'object') return payload;
        if (!cfg.enabled) return payload;
        if (!active() && !cfg.spoofFriends) return payload;
        try {
            aliasConversations(payload, active());
        } catch (e) {
            Utils.Debug.warn('[NameSpoofer] WS conversations transform failed:', e);
        }
        return payload;
    });

    // Honor ballot WS: alias all players in post-game voting ceremony
    Utils.Hooks.WS.hook('/lol-honor-v2/v1/ballot', (_endpoint, payload) => {
        if (!payload || typeof payload !== 'object') return payload;
        if (!cfg.enabled) return payload;
        if (!active() && !aliasOthersNow() && !cfg.spoofFriends && !cfg.spoofMatchHistory) return payload;
        try {
            aliasTeam(payload, active(), false);
        } catch (e) {
            Utils.Debug.warn('[NameSpoofer] WS ballot transform failed:', e);
        }
        return payload;
    });

    // Post-game stats block WS: alias players in end-of-game stats
    Utils.Hooks.WS.hook('/lol-end-of-game/v1/eog-stats-block', (_endpoint, payload) => {
        if (!payload || typeof payload !== 'object') return payload;
        if (!cfg.enabled) return payload;
        if (!active() && !aliasOthersNow() && !cfg.spoofFriends && !cfg.spoofMatchHistory) return payload;
        try {
            aliasTeam(payload, active(), false);
        } catch (e) {
            Utils.Debug.warn('[NameSpoofer] WS eog-stats transform failed:', e);
        }
        return payload;
    });
}

async function refreshContext() {
    try {
        const phase = await Utils.LCU.get('/lol-gameflow/v1/gameflow-phase');
        if (typeof phase === 'string') ctx.phase = phase;
        const s = await Utils.LCU.get('/lol-gameflow/v1/session');
        const q = s && s.gameData && s.gameData.queue;
        if (q) ctx.isRanked = !!q.isRanked || RANKED_QUEUES.has(q.id);
        logDebug('refresh', 'phase=' + ctx.phase + ' isRanked=' + ctx.isRanked + ' aliasOthersNow=' + aliasOthersNow());
    } catch {
        logDebug('refresh', 'fetch failed (normal during None phase)');
    }
}

function decodeJwtPayload(jwt) {
    try {
        const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch {
        return null;
    }
}

async function captureRealIdentity() {
    if (!Utils.LCU) return;
    try {
        const me = await Utils.LCU.get('/lol-summoner/v1/current-summoner');
        if (me && me.puuid) real.puuid = me.puuid;

        const info = await Utils.LCU.get('/lol-rso-auth/v1/authorization/userinfo');
        const jwt = info && (info.userInfo || (typeof info === 'string' ? info : null));
        const payload = jwt ? decodeJwtPayload(jwt) : null;
        if (payload && payload.acct) {
            real.gameName = (payload.acct.game_name || real.gameName).replace(/[⁦-⁩‎‏]/g, '');
            real.tagLine = (payload.acct.tag_line || real.tagLine).replace(/[⁦-⁩‎‏]/g, '');
            real.displayName = real.gameName;
        }

        if (!real.puuid || !real.gameName) throw new Error('identity incomplete');
        if (real.gameName !== cfg.gameName) {
            realToAlias[real.gameName] = cfg.gameName;
        }

        if (cfg.enabled) {
            rerenderTracked();
            processMatchHistoryRows();
            triggerRosterRebuild();
        }
    } catch (e) {
        setTimeout(captureRealIdentity, 1500);
    }
}

const OVERRIDE_ATTR = 'puuids-to-name-overrides-json';

let _overrideAttrObserver = null;

function installOverrideAttrObserver() {
    if (_overrideAttrObserver) return;
    _overrideAttrObserver = new MutationObserver(() => {
        if (!scrubActive()) return;
        document.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => {
            DomScrubber._fixOverrideAttr(el);
        });
    });
    _overrideAttrObserver.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [OVERRIDE_ATTR]
    });
    // Immediately fix any existing elements
    document.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => {
        DomScrubber._fixOverrideAttr(el);
    });
}

function stopOverrideAttrObserver() {
    if (_overrideAttrObserver) {
        _overrideAttrObserver.disconnect();
        _overrideAttrObserver = null;
    }
}

function restoreTextNodeText(node) {
    if (!node || !node.nodeValue) return;
    let v = node.nodeValue;
    let changed = false;
    const G = real.gameName,
        T = real.tagLine;
    if (!G) return;
    if (T) {
        const nv = v.split(cfg.gameName + '#' + cfg.tagLine).join(G + '#' + T).split(cfg.gameName + ' #' + cfg.tagLine).join(G + ' #' + T);
        if (nv !== v) {
            v = nv;
            changed = true;
        }
    }
    if (cfg.gameName && cfg.gameName !== G && v.indexOf(cfg.gameName) !== -1) {
        v = v.split(cfg.gameName).join(G);
        changed = true;
    }
    if (cfg.tagLine && cfg.tagLine !== T && v.indexOf(cfg.tagLine) !== -1) {
        v = v.split(cfg.tagLine).join(T);
        changed = true;
    }
    const aliasToReal = {};
    for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
    for (const alias of Object.keys(aliasToReal)) {
        const rn = aliasToReal[alias];
        if (rn !== alias && v.indexOf(alias) !== -1) {
            v = v.split(alias).join(rn);
            changed = true;
        }
    }
    if (changed) node.nodeValue = v;
}

const DomScrubber = {
    _installed: false,
    _frameDocs: new WeakSet(),
    _frameObservers: new WeakMap(), // doc → MutationObserver, for cleanup

    install() {
        if (this._installed) return;
        this._installed = true;
        this._unobserveIframes = Utils.DOM.observer.observe('iframe', (node) => {
            const attach = () => {
                try {
                    const doc = node.contentDocument;
                    if (!doc || this._frameDocs.has(doc)) return;
                    this._frameDocs.add(doc);
                    this._applyFrameDoc(doc);
                    const mo = new MutationObserver(() => {
                        this._applyFrameDoc(doc);
                    });
                    try {
                        mo.observe(doc.documentElement, {
                            childList: true,
                            subtree: true,
                            characterData: true
                        });
                    } catch {}
                    this._frameObservers.set(doc, mo);
                } catch {}
            };
            attach();
            node.addEventListener('load', attach);
            node.addEventListener('unload', () => {
                try {
                    const doc = node.contentDocument;
                    if (doc) {
                        const mo = this._frameObservers.get(doc);
                        if (mo) {
                            mo.disconnect();
                            this._frameObservers.delete(doc);
                        }
                        this._frameDocs.delete(doc);
                    }
                } catch {}
            });
        });
    },

    disconnectFrameObservers() {
        for (const [doc, mo] of this._frameObservers) {
            try {
                mo.disconnect();
            } catch {}
        }
        this._frameObservers = new WeakMap();
        this._frameDocs = new WeakSet();
    },

    _applyFrameDoc(doc) {
        if (!doc) return;
        if (!cfg.enabled && !_hasSpoofedAnything) return;
        try {
            if (scrubActive()) {
                doc.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => this._fixOverrideAttr(el));
                const start = doc.body || doc.documentElement;
                if (!start) return;
                const tw = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = tw.nextNode())) aliasTextNodeText(n);
            } else if (!cfg.enabled && real.gameName) {
                doc.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => {
                    try {
                        const raw = el.getAttribute(OVERRIDE_ATTR);
                        if (!raw) return;
                        const map = JSON.parse(raw);
                        let changed = false;
                        for (const puuid in map) {
                            if (puuid === real.puuid && map[puuid] !== real.gameName) {
                                map[puuid] = real.gameName;
                                changed = true;
                            }
                        }
                        if (changed) el.setAttribute(OVERRIDE_ATTR, JSON.stringify(map));
                    } catch {}
                });
                const start = doc.body || doc.documentElement;
                if (!start) return;
                const tw = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = tw.nextNode())) restoreTextNodeText(n);
            }
        } catch {}
    },

    _scanFrames(fn) {
        document.querySelectorAll('iframe').forEach((iframe) => {
            try {
                const doc = iframe.contentDocument || iframe.contentWindow?.document;
                if (doc) {
                    fn(doc);
                    return;
                }
                iframe.addEventListener('load', () => {
                    try {
                        const d = iframe.contentDocument || iframe.contentWindow?.document;
                        if (d) fn(d);
                    } catch {}
                }, {
                    once: true
                });
            } catch {}
        });
        for (let i = 0; i < window.frames.length; i++) {
            try {
                const doc = window.frames[i].document;
                if (doc) fn(doc);
            } catch {}
        }
    },

    sweep() {
        if (!this._installed) return;
        this._frameDocs = new WeakSet();
        if (scrubActive()) {
            this._scanFrames((doc) => this._applyFrameDoc(doc));
        }
    },

    restore() {
        if (!this._installed || !real.gameName) return;
        this._frameDocs = new WeakSet();
        if (!cfg.enabled) {
            this._scanFrames((doc) => {
                const start = doc.body || doc.documentElement;
                if (!start) return;
                const tw = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = tw.nextNode())) restoreTextNodeText(n);
            });
        }
    },

    _fixOverrideAttr(el) {
        if (!el || !el.getAttribute) return;
        const selfOn = active() && cfg.gameName && real.puuid;
        const othersOn = aliasOthersNow() || cfg.spoofFriends || cfg.spoofMatchHistory;
        if (!selfOn && !othersOn) return;
        try {
            const raw = el.getAttribute(OVERRIDE_ATTR);
            if (!raw) return;
            const map = JSON.parse(raw);
            let changed = false;
            for (const puuid in map) {
                let desired = map[puuid];
                if (selfOn && puuid === real.puuid) {
                    desired = cfg.gameName;
                } else if (othersOn && puuid !== real.puuid) {
                    const curName = map[puuid];
                    const alias = resolveAlias(curName, puuid === '00000000-0000-0000-0000-000000000000' ? null : puuid);
                    if (alias && alias !== curName) {
                        desired = alias;
                    }
                }
                if (desired !== map[puuid]) {
                    map[puuid] = desired;
                    changed = true;
                }
            }
            if (changed) el.setAttribute(OVERRIDE_ATTR, JSON.stringify(map));
        } catch {}
    }
};

const TOOLTIP_SELECTOR = '.player-name__tooltip__game-name, .player-name__tooltip__tag-line, [class*="tooltip__game-name"]';

let _tooltipObs = null;
let _chatObs = null;

function installTooltipObserver() {
    if (_tooltipObs) return;
    _tooltipObs = new MutationObserver((mutations) => {
        if (!scrubActive() || !real.gameName) return;
        for (const m of mutations) {
            for (const n of m.addedNodes) {
                if (n.nodeType === 1) {
                    const tooltipEl = n.nodeType === 1 ? n.querySelector(TOOLTIP_SELECTOR) : null;
                    if (!tooltipEl && n.matches && n.matches(TOOLTIP_SELECTOR)) {
                        swapNameText(n.parentElement || n);
                        continue;
                    }
                    if (tooltipEl) swapNameText(n);
                }
            }
        }
    });
    _tooltipObs.observe(document.body, {
        childList: true,
        subtree: true
    });
}

function stopTooltipObserver() {
    if (_tooltipObs) {
        _tooltipObs.disconnect();
        _tooltipObs = null;
    }
    // Restore already-modified tooltip names (walk through shadow DOMs)
    if (!real.gameName) return;
    const aliasToReal = {};
    for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
    for (const el of _queryAllShadow(TOOLTIP_SELECTOR)) {
        const cur = (el.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
        const realName = aliasToReal[cur] || real.gameName;
        if (realName && realName !== cur) el.textContent = realName;
    }
}
const CHAT_NAME_SELECTORS = '.conversation-title, .player-name__game-name, .player-name__alias, .create-panel-game-name, .create-panel-gnt';

function patchUikitName(el) {
    const gn = el.getAttribute('game-name');
    if (gn && realToAlias[gn] && gn !== realToAlias[gn]) el.setAttribute('game-name', realToAlias[gn]);
}

function installChatObserver() {
    if (_chatObs) return;
    const target = document.querySelector('lol-social-chat-window') || document.body;
    if (target.querySelectorAll) {
        for (const u of target.querySelectorAll('lol-uikit-player-name')) patchUikitName(u);
    }
    // Sweep existing chat name elements (e.g. after restore + re-enable)
    const sweepChatNames = () => {
        if (!cfg.enabled) return;
        const els = _queryAllShadow(CHAT_NAME_SELECTORS);
        Utils.Debug.log('[NS-DEBUG][chat] sweep found ' + els.length + ' elements');
        for (const el of els) {
            // Skip conversation titles in the initial sweep — let deferred sweep
            // handle them after roster rebuild assigns stable realToAlias numbers.
            if (el.matches('.conversation-title')) continue;
            const cur = (el.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
            Utils.Debug.log('[NS-DEBUG][chat] sweep el="' + (el.className || el.tagName) + '" cur="' + cur + '" realToAliasKey=' + (realToAlias[cur] ? 'yes' : 'no'));
            const convo = el.closest('.conversation');
            const puuid = convo ? convo.getAttribute('data-id') : null;
            swapNameText(el.parentElement || el, puuid);
        }
    };
    sweepChatNames();
    _chatObs = new MutationObserver((mutations) => {
        if (!scrubActive() || !real.gameName) return;
        for (const m of mutations) {
            if (m.type === 'attributes' && m.target.matches('lol-uikit-player-name')) {
                patchUikitName(m.target);
                continue;
            }
            for (const n of m.addedNodes) {
                if (n.nodeType !== 1) continue;
                if (n.matches && n.matches(CHAT_NAME_SELECTORS)) {
                    const convo = n.closest('.conversation');
                    swapNameText(n.parentElement || n, convo ? convo.getAttribute('data-id') : null);
                } else if (n.querySelectorAll) {
                    const matches = n.querySelectorAll(CHAT_NAME_SELECTORS);
                    for (const el of matches) {
                        const convo = el.closest('.conversation');
                        swapNameText(el.parentElement || el, convo ? convo.getAttribute('data-id') : null);
                    }
                }
                if (n.matches && n.matches('lol-uikit-player-name')) {
                    patchUikitName(n);
                } else if (n.querySelectorAll) {
                    const uikitNames = n.querySelectorAll('lol-uikit-player-name');
                    for (const u of uikitNames) patchUikitName(u);
                }
            }
        }
    });
    _chatObs.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['game-name']
    });
    // Deferred re-sweep after roster rebuild populates realToAlias
    setTimeout(() => {
        if (!cfg.enabled) return;
        const els = _queryAllShadow(CHAT_NAME_SELECTORS);
        Utils.Debug.log('[NS-DEBUG][chat] deferred sweep found ' + els.length + ' elements');
        for (const el of els) {
            if (el.matches('.summoner-level') || el.closest('.summoner-level')) continue;
            const cur = (el.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
            const alias = realToAlias[cur];
            Utils.Debug.log('[NS-DEBUG][chat] deferred el="' + (el.className || el.tagName) + '" cur="' + cur + '" alias="' + (alias || 'null') + '"');
            if (!cur || cur === cfg.gameName || cur === real.gameName) continue;
            if (alias && alias !== cur) {
                el.textContent = alias;
                continue;
            }
            const convo = el.closest('.conversation');
            if (convo) {
                const rawPuuid = convo.getAttribute('data-id') || '';
                const label = lookupFriend(rawPuuid, cur);
                if (label && label !== cur) {
                    el.textContent = label;
                    continue;
                }
                const puuid = rawPuuid.split('@')[0];
                if (friendPuuids.has(puuid)) {
                    const fallback = friendLabel(puuid);
                    if (fallback && fallback !== cur) el.textContent = fallback;
                }
            }
        }
    }, 1500);
}

function stopChatObserver() {
    if (_chatObs) {
        _chatObs.disconnect();
        _chatObs = null;
    }
    // Restore already-modified chat names (walk through shadow DOMs)
    if (!real.gameName) return;
    const aliasToReal = {};
    for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
    for (const el of _queryAllShadow(CHAT_NAME_SELECTORS)) {
        if (el.matches('.summoner-level') || el.closest('.summoner-level')) continue;
        const cur = (el.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
        const realName = aliasToReal[cur];
        if (realName && realName !== cur) el.textContent = realName;
    }
}

function _queryAllShadow(selector, root) {
    // Recursively walk shadow roots to find elements that document.querySelectorAll can't see
    const results = [];
    (function walk(ctx) {
        if (!ctx || !ctx.querySelectorAll) return;
        results.push(...ctx.querySelectorAll(selector));
        for (const el of ctx.querySelectorAll('*')) {
            if (el.shadowRoot) walk(el.shadowRoot);
        }
    })(root || document);
    return results;
}

let _inviteOrigSummonerName = null;

function installInviteObserver() {
    if (_inviteOrigSummonerName) return;
    const Klass = customElements.get('lol-parties-game-invite');
    if (!Klass || !Klass.prototype) {
        Utils.Debug.log('[NS-DEBUG][invite] lol-parties-game-invite not registered yet');
        return;
    }
    const orig = Klass.prototype._summonerName;
    if (!orig) {
        Utils.Debug.log('[NS-DEBUG][invite] no _summonerName on prototype');
        return;
    }
    _inviteOrigSummonerName = orig;
    Klass.prototype._summonerName = async function(element, summonerId) {
        // Run original only if not cached (avoids double fetch)
        if (!this._name) await orig.call(this, element, summonerId);
        // Always attempt spoofing, even if name was already cached before our patch
        const cur = (element.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
        Utils.Debug.log('[NS-DEBUG][invite] _summonerName cur="' + cur + '" sid=' + summonerId + ' cfg.enabled=' + cfg.enabled);
        if (!cfg.enabled || !cur || cur === cfg.gameName || cur === real.gameName) return;
        const puKey = summonerId ? ('sid:' + summonerId) : undefined;
        const alias = resolveAlias(cur, puKey);
        Utils.Debug.log('[NS-DEBUG][invite] resolveAlias -> ' + alias);
        if (alias && alias !== cur) element.innerHTML = alias;
    };
    Utils.Debug.log('[NS-DEBUG][invite] patched _summonerName');
    // Sweep existing instances (already rendered before patch) through shadow DOMs
    for (const host of _queryAllShadow('lol-parties-game-invite')) {
        const root = host.shadowRoot;
        if (!root) continue;
        // Get summoner ID from the stored invite data for friend detection
        const sid = host._gameInvite && host._gameInvite.fromSummonerId;
        const sidKey = sid ? ('sid:' + sid) : undefined;
        delete host._name;
        for (const nameEl of root.querySelectorAll('.parties-game-invite-name')) {
            const cur = (nameEl.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
            if (!cfg.enabled || !cur || cur === cfg.gameName || cur === real.gameName) continue;
            const alias = resolveAlias(cur, sidKey);
            Utils.Debug.log('[NS-DEBUG][invite] sweep cur="' + cur + '" sidKey=' + sidKey + ' alias="' + alias + '"');
            if (alias && alias !== cur) nameEl.innerHTML = alias;
        }
    }
    // Deferred resweep after friend data settles (roster rebuild, conversation fetch, etc.)
    setTimeout(() => {
        if (!cfg.enabled) return;
        for (const host of _queryAllShadow('lol-parties-game-invite')) {
            const root = host.shadowRoot;
            if (!root) continue;
            const sid = host._gameInvite && host._gameInvite.fromSummonerId;
            const sidKey = sid ? ('sid:' + sid) : undefined;
            for (const nameEl of root.querySelectorAll('.parties-game-invite-name')) {
                const cur = (nameEl.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
                if (!cfg.enabled || !cur || cur === cfg.gameName || cur === real.gameName) continue;
                const alias = resolveAlias(cur, sidKey);
                Utils.Debug.log('[NS-DEBUG][invite] defer cur="' + cur + '" sidKey=' + sidKey + ' alias="' + alias + '"');
                if (alias && alias !== cur && alias !== nameEl.textContent) nameEl.innerHTML = alias;
            }
        }
    }, 1500);
}

function stopInviteObserver() {
    if (!_inviteOrigSummonerName) return;
    const Klass = customElements.get('lol-parties-game-invite');
    if (Klass && Klass.prototype) {
        Klass.prototype._summonerName = _inviteOrigSummonerName;
    }
    _inviteOrigSummonerName = null;
    Utils.Debug.log('[NS-DEBUG][invite] restored _summonerName');
    // Restore original names on existing instances
    for (const host of _queryAllShadow('lol-parties-game-invite')) {
        const root = host.shadowRoot;
        if (!root) continue;
        delete host._name;
        if (host._gameInvite) {
            // Re-run the original name-fetching to overwrite our spoofed values
            host._inviteFromPlayerText(host._gameInvite);
        }
    }
}

const spoofSummonerName = (name) => {
    if (!name) return name;
    const G = real.gameName,
        T = real.tagLine;
    const SG = cfg.gameName || G,
        ST = cfg.tagLine || T;
    let v = name;
    if (cfg.enabled) {
        if (active() && G) {
            if (T) {
                if (v.indexOf(G + '#' + T) !== -1) {
                    v = v.split(G + '#' + T).join(SG + '#' + ST);
                }
                if (v.indexOf(G + ' #' + T) !== -1) {
                    v = v.split(G + ' #' + T).join(SG + ' #' + ST);
                }
            }
            if (SG !== G && v.indexOf(G) !== -1) {
                v = v.split(G).join(SG);
            }
            if (T && ST !== T && v.indexOf(T) !== -1) {
                v = v.split(T).join(ST);
            }
        }
        if (cfg.spoofFriends || aliasOthersNow()) {
            const aliasValues = new Set(Object.values(realToAlias));
            for (const rn of Object.keys(realToAlias)) {
                if (aliasValues.has(rn)) continue; // skip keys that are already aliases (prevent cascade)
                const alias = realToAlias[rn];
                if (alias !== rn && v.indexOf(rn) !== -1) {
                    v = v.split(rn).join(alias);
                }
            }
        }
    } else {
        if (G && SG !== G && v.indexOf(SG) !== -1) {
            v = v.split(SG).join(G);
        }
        if (T && ST !== T && v.indexOf(ST) !== -1) {
            v = v.split(ST).join(T);
        }
        const aliasToReal = {};
        for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
        for (const alias of Object.keys(aliasToReal)) {
            const rn = aliasToReal[alias];
            if (rn !== alias && v.indexOf(alias) !== -1) {
                v = v.split(alias).join(rn);
            }
        }
    }
    return v;
};

function applyConfig() {
    const wasEnabled = cfg.enabled;
    const oldName = cfg.gameName;
    const oldTag = cfg.tagLine;
    loadConfig();
    if (cfg.enabled) _hasSpoofedAnything = true;
    if (oldName && oldName !== cfg.gameName) {
        noteFriend(oldName, cfg.gameName);
    }
    logDebug('cfg', 'applyConfig wasEnabled=' + wasEnabled + ' nowEnabled=' + cfg.enabled);
    if (cfg.enabled) {
        if (!real.gameName && Utils.LCU) {
            captureRealIdentity().then(() => {
                processMatchHistoryRows();
            });
        }
        DomScrubber.sweep();
        installTooltipObserver();
        installChatObserver();
        installOverrideAttrObserver();
        installInviteObserver();
    } else {
        DomScrubber.restore();
        stopTooltipObserver();
        stopChatObserver();
        stopOverrideAttrObserver();
        stopInviteObserver();
    }
    if (wasEnabled !== cfg.enabled) {
        for (const c of _partyComponents) {
            try {
                const val = c.get && c.get('partySummonerNames');
                if (!val) continue;
                const restored = Array.isArray(val) ?
                    val.map(n => spoofSummonerName(n)) :
                    spoofSummonerName(String(val));
                if (JSON.stringify(restored) !== JSON.stringify(val) && c.set) {
                    c.set('partySummonerNames', restored);
                }
            } catch {}
        }
        logDebug('cfg', 'triggering roster rebuild');
        triggerRosterRebuild();
        logDebug('cfg', 'triggerRosterRebuild returned');
    }
}

function processMatchHistoryRows() {
    if (!cfg.enabled && !_hasSpoofedAnything) return;
    if (!real.gameName) return;
    logDebug('mh-process', 'processing ' + _mhComponents.size + ' components');
    for (const comp of _mhComponents) {
        try {
            if (!comp.element) continue;
            const nameEl = comp.element.querySelector('.player-history-mode');
            if (!nameEl) continue;
            let cur = (nameEl.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
            if (!cur) continue;
            if (!cfg.enabled) {
                if (cur === cfg.gameName && cur !== real.gameName) {
                    nameEl.textContent = real.gameName;
                } else {
                    const aliasToReal = {};
                    for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
                    const realName = aliasToReal[cur];
                    if (realName && realName !== cur) nameEl.textContent = realName;
                }
                continue;
            }
            if (active() && cur === real.gameName && cur !== cfg.gameName) {
                logDebug('mh-process', 'self ' + cur + ' -> ' + cfg.gameName);
                nameEl.textContent = cfg.gameName;
                continue;
            }
            let alias = _mhAliasFromComponent(comp);
            if (!alias) alias = realToAlias[cur];
            if (alias && alias !== cur) {
                logDebug('mh-process', 'aliased ' + cur + ' -> ' + alias);
                nameEl.textContent = alias;
            }
        } catch (e) {
            logDebug('mh-process', 'error: ' + e.message);
        }
    }
}

function aliasTextNodeText(node) {
    if (!node || !node.nodeValue) return;
    if (node.parentElement && node.parentElement.closest('.summoner-level')) return;
    let v = node.nodeValue;
    let changed = false;
    if (active() && real.gameName) {
        const G = real.gameName,
            T = real.tagLine;
        const SG = cfg.gameName || G,
            ST = cfg.tagLine || T;
        if (T) {
            const nv = v.split(G + '#' + T).join(SG + '#' + ST).split(G + ' #' + T).join(SG + ' #' + ST);
            if (nv !== v) {
                v = nv;
                changed = true;
            }
        }
        if (SG !== G && v.indexOf(G) !== -1) {
            v = v.split(G).join(SG);
            changed = true;
        }
        if (ST !== T && v.indexOf(T) !== -1) {
            v = v.split(T).join(ST);
            changed = true;
        }
    }
    for (const rn of Object.keys(realToAlias)) {
        const alias = realToAlias[rn];
        if (alias !== rn && v.indexOf(rn) !== -1) {
            v = v.split(rn).join(alias);
            changed = true;
        }
    }
    if (changed) node.nodeValue = v;
}

const NAME_SELECTORS = '.name-text, .player-name__game-name, .player-game-name, .member-name, .create-panel-game-name, .hover-card-name, .parties-game-invite-name, [class*="game-name"]';
const TAG_LINE_SELECTORS = '.hover-card-game-tag-text, .player-name__tag-line, [class*="game-tag"], [class*="tag-line"]';

function swapNameText(el, contextPuuid) {
    if (!cfg.enabled && !_hasSpoofedAnything) return;
    if (!el || !real.gameName) return;
    if (el.closest && (el.closest('.summoner-level') || el.closest('.summoner-level-icon'))) return;
    let targets = Array.from(el.querySelectorAll(NAME_SELECTORS));
    // Scan into open shadow roots (e.g. lol-parties-game-invite)
    if (!targets.length) {
        for (const child of el.querySelectorAll('*')) {
            const sr = child.shadowRoot;
            if (sr) {
                targets.push(...sr.querySelectorAll(NAME_SELECTORS));
                if (targets.length) break;
            }
        }
    }
    if (!targets.length) {
        const tw = (el.ownerDocument || document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = tw.nextNode())) {
            if (n.nodeValue && n.nodeValue.trim()) {
                if (n.parentElement && n.parentElement.closest('.summoner-level')) continue;
                targets.push(n);
                break;
            }
        }
    }
    const aliasToReal = {};
    for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;

    const isSelfCtx = contextPuuid === real.puuid;

    for (const target of targets) {
        if (target.parentElement && target.parentElement.closest('.summoner-level')) continue;
        let cur = (target.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
        if (!cur) continue;
        if (cfg.enabled) {
            if (active() && isSelfCtx) {
                if (cur !== cfg.gameName) target.textContent = cfg.gameName;
                continue;
            }
            let alias = realToAlias[cur];
            if (!alias && contextPuuid) {
                alias = lookupFriend(contextPuuid, cur);
            }
            if (!alias && contextPuuid) {
                const puuid = contextPuuid.split('@')[0];
                if (friendPuuids.has(puuid)) {
                    alias = friendLabel(puuid);
                }
            }
            if (!alias && contextPuuid) {
                const puuid = contextPuuid.split('@')[0];
                if (!friendPuuids.has(puuid)) {
                    alias = catLabel('global', 'puuid:' + puuid);
                    noteFriend(cur, alias);
                }
            }
            if (alias && alias !== cur) {
                target.textContent = alias;
                continue;
            }
        } else {
            if (isSelfCtx) {
                if (cur !== real.gameName) target.textContent = real.gameName;
                continue;
            }
            const realName = aliasToReal[cur];
            if (realName && realName !== cur) {
                target.textContent = realName;
            }
        }
    }
    if (real.tagLine && cfg.tagLine && real.tagLine !== cfg.tagLine) {
        for (const target of el.querySelectorAll(TAG_LINE_SELECTORS)) {
            let cur = (target.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
            if (!cur) continue;
            if (cfg.enabled) {
                if (isSelfCtx) {
                    if (cur !== cfg.tagLine) target.textContent = cfg.tagLine;
                } else if (cur === real.tagLine) {
                    target.textContent = cfg.tagLine;
                }
            } else {
                if (isSelfCtx) {
                    if (cur !== real.tagLine) target.textContent = real.tagLine;
                } else if (cur === cfg.tagLine) {
                    target.textContent = real.tagLine;
                }
            }
        }
    }
}

function installEmberHook() {

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-lol-social-identity',
        matcher: 'lol-social-identity',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                trackComponent(this);
                swapNameText(this.element, real.puuid);
                if (!cfg.enabled && real.gameName) {
                    const tagEl = this.element.querySelector('.tag-line, [class*="tag-line"]');
                    if (tagEl && real.tagLine && tagEl.textContent.replace(/[⁦-⁩‎‏]/g, '').trim() !== real.tagLine) {
                        tagEl.textContent = real.tagLine;
                    }
                }
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-hovercard-content',
        matcher: (args) => args.some(arg => {
            const k = Object.keys(arg || {});
            return k.includes('partySummonerNames')
        }),
        mixin(Ember) {
            return {
                init() {
                    this._super(...arguments);
                    if (cfg.enabled) {
                        _partyComponents.add(this);
                        this.addObserver('partySummonerNames', this, '_onPartyNamesChange');
                        Ember.run.next(this, function() {
                            this._onPartyNamesChange();
                        });
                    }
                },

                _onPartyNamesChange() {
                    if (!cfg.enabled) return;
                    const val = this.get && this.get('partySummonerNames');
                    if (!val || (Array.isArray(val) && !val.length)) return;
                    const spoofed = Array.isArray(val) ?
                        val.map(n => spoofSummonerName(n)) :
                        spoofSummonerName(String(val));
                    if (JSON.stringify(spoofed) !== JSON.stringify(val) && this.set) {
                        this.set('partySummonerNames', spoofed);
                    }
                },

                willDestroy() {
                    _partyComponents.delete(this);
                    this.removeObserver('partySummonerNames', this, '_onPartyNamesChange');
                    this._super(...arguments);
                }
            };
        }
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-hovercard-component',
        matcher: 'hovercard-component',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                trackComponent(this);
                swapNameText(this.element, this.get && this.get('puuid'));
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-friend-finder-recent',
        matcher: 'lol-friend-finder-recent-summoner',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    const el = this.element.querySelector('.player-name__game-name, .player-game-name, .name-text');
                    if (el) {
                        const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                        if (cur && cur !== cfg.gameName) el.textContent = catLabel('global', 'name:' + cur);
                    }
                } else if (!cfg.enabled) {
                    swapNameText(this.element)
                }
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-friend-finder-requested',
        matcher: 'lol-friend-finder-requested-player',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    const el = this.element.querySelector('.player-name__game-name, .player-game-name, .name-text');
                    if (el) {
                        const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                        if (cur && cur !== cfg.gameName) el.textContent = catLabel('global', 'name:' + cur);
                    }
                } else if (!cfg.enabled) {
                    swapNameText(this.element)
                }
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-player-name',
        matcher: 'player-name',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                trackComponent(this);
                swapNameText(this.element, this.get && (this.get('short') || this.get('puuid')));
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    function setTextNode(el, oldText, newText) {
        const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = tw.nextNode())) {
            if (n.textContent.replace(/[⁦-⁩‎‏]/g, '').trim() === oldText) {
                n.textContent = n.textContent.split(oldText).join(newText);
                return true;
            }
        }
        return false;
    }

    const aliasPlayerName = (el, src) => {
        const ok = aliasOthersNow();
        logDebug('aliasPlayer', 'from=' + src + ' aliasOthersNow=' + ok + ' phase=' + ctx.phase + ' hasEl=' + !!el);
        if (!el || !ok) return;
        const textEl = el.querySelector('.name-text') || el;
        const cur = textEl.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
        logDebug('aliasPlayer', 'cur="' + cur + '" gameName="' + cfg.gameName + '" real="' + real.gameName + '"');
        if (!cur) return;
        if (cur === real.gameName) {
            const label = cfg.gameName;
            if (label === cur) return;
            logDebug('aliasPlayer', 'self aliasing "' + cur + '" -> "' + label + '"');
            setTextNode(textEl, cur, label);
        } else if (cur !== cfg.gameName) {
            const cell = el.closest('.summoner-object');
            if (!cell) {
                logDebug('aliasPlayer', 'no summoner-object parent');
                return;
            }
            // Check if known friend by looking up the cell's puuid context
            const cellPuuid = el.getAttribute('data-puuid') || (cell && cell.getAttribute && cell.getAttribute('data-puuid'));
            const label = resolveAlias(cur, cellPuuid);
            if (!label || label === cur) {
                logDebug('aliasPlayer', 'label unchanged or null, skip');
                return;
            }
            logDebug('aliasPlayer', 'other aliasing "' + cur + '" -> "' + label + '"');
            setTextNode(textEl, cur, label);
        }
    };

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-player-name-component',
        matcher: 'player-name-component',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                trackComponent(this);
                swapNameText(this.element, this.get && this.get('puuid'));
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-player-name-wrapper',
        matcher: 'player-name-wrapper',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                trackComponent(this);
                swapNameText(this.element, this.get && this.get('puuid'));
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-parties-invite-panel',
        matcher: 'v2-parties-invite-info-panel',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    this.element.querySelectorAll('.v2-parties-invite-info-panel-player').forEach((li) => {
                        const cat = li.querySelector('.invite-info-friend-icon') ? 'friend' : 'global';
                        const targets = [...li.querySelectorAll('.player-name__game-name, .player-game-name')];
                        const el = targets.length ? targets[0] : li.querySelector('.name-text, [class*="game-name"]');
                        if (!el) return;
                        const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                        if (!cur || cur === cfg.gameName) return;
                        const [base] = catCfg(cat);
                        if (cur === base || cur.indexOf(base + ' ') === 0) return;
                        const sid = li.getAttribute('summonerid');
                        let label;
                        if (cat === 'friend') {
                            label = registerFriend(cur, sid && sid.length > 4 ? ('sid:' + sid) : null);
                        } else {
                            const key = (sid && sid.length > 4) ? ('sid:' + sid) : ('name:' + cur);
                            label = catLabel('global', key);
                        }
                        if (cat === 'friend' && sid && sid.length > 4) friendPuuids.add('sid:' + sid);
                        el.textContent = label;
                        li.querySelectorAll('.player-name__tag-line').forEach((t) => {
                            t.textContent = '';
                        });
                    });
                } else if (!cfg.enabled) {
                    swapNameText(this.element)
                }
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-invite-dialog',
        matcher: 'parties-invite-dialog',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    this.element.querySelectorAll('.invite-dialog-friend').forEach((li) => {
                        const targets = [...li.querySelectorAll('.player-name__game-name, .player-game-name')];
                        const el = targets.length ? targets[0] : li.querySelector('.name-text, [class*="game-name"]');
                        if (!el) return;
                        const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                        if (!cur || cur === cfg.gameName) return;
                        const [base] = catCfg('global');
                        if (cur === base || cur.indexOf(base + ' ') === 0) return;
                        const sid = li.getAttribute('summonerid');
                        const key = (sid && sid.length > 4) ? ('sid:' + sid) : ('name:' + cur);
                        const label = catLabel('global', key);
                        realToAlias[cur] = label;
                        el.textContent = label;
                        li.querySelectorAll('.player-name__tag-line').forEach((t) => {
                            t.textContent = '';
                        });
                    });
                } else if (!cfg.enabled) {
                    swapNameText(this.element)
                }
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-player-history-row',
        matcher: 'player-history-object',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                trackComponent(this);
                trackMhComponent(this);
                logDebug('mh-hook', 'didRender element=' + (!!this.element) + ' real.gameName=' + (real.gameName || 'null'));
                if (!real.gameName) {
                    logDebug('mh-hook', 'early return: no real.gameName');
                    return;
                }
                const nameEl = this.element.querySelector('.player-history-mode');
                if (!nameEl) {
                    logDebug('mh-hook', 'early return: no .player-history-mode');
                    return;
                }
                let cur = (nameEl.textContent || '').replace(/[⁦-⁩‎‏]/g, '').trim();
                if (!cur) {
                    logDebug('mh-hook', 'early return: empty cur');
                    return;
                }
                logDebug('mh-hook', 'cur=' + cur + ' real.gameName=' + real.gameName);
                if (cfg.enabled) {
                    if (active() && cur === real.gameName && cur !== cfg.gameName) {
                        logDebug('mh-hook', 'self alias ' + cur + ' -> ' + cfg.gameName);
                        nameEl.textContent = cfg.gameName;
                    } else {
                        let alias = _mhAliasFromComponent(this);
                        logDebug('mh-hook', '_mhAliasFromComponent=' + (alias || 'null'));
                        if (!alias) alias = realToAlias[cur];
                        logDebug('mh-hook', 'realToAlias[' + cur + ']=' + (alias || 'null') + ' realToAlias size=' + Object.keys(realToAlias).length);
                        if (alias && alias !== cur) {
                            logDebug('mh-hook', 'aliased ' + cur + ' -> ' + alias);
                            nameEl.textContent = alias;
                        } else if (!alias) {
                            let retries = 0;
                            const retry = () => {
                                if (!this.element || retries++ > 10) {
                                    logDebug('mh-hook', 'retry exhausted');
                                    return;
                                }
                                alias = _mhAliasFromComponent(this);
                                if (!alias) alias = realToAlias[cur];
                                logDebug('mh-hook', 'retry ' + retries + ' alias=' + (alias || 'null') + ' realToAlias size=' + Object.keys(realToAlias).length);
                                if (alias && alias !== cur) {
                                    logDebug('mh-hook', 'retry aliased ' + cur + ' -> ' + alias);
                                    nameEl.textContent = alias;
                                } else setTimeout(retry, 100);
                            };
                            setTimeout(retry, 100);
                        }
                    }
                } else {
                    if (cur === cfg.gameName && cur !== real.gameName) {
                        nameEl.textContent = real.gameName;
                    } else {
                        let realName;
                        try {
                            const part = this.get ? this.get('participant') : this.participant;
                            const player = part && (part.player || part);
                            if (player) realName = nameOf(player);
                        } catch {}
                        if (!realName) {
                            const aliasToReal = {};
                            for (const rn of Object.keys(realToAlias)) aliasToReal[realToAlias[rn]] = rn;
                            realName = aliasToReal[cur];
                        }
                        if (realName && realName !== cur) {
                            nameEl.textContent = realName;
                        }
                    }
                }
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-roster-member',
        matcher: 'lol-social-roster-member',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                const nameEl = this.element.querySelector('.member-name, .player-name__game-name, .player-game-name, .name-text, [class*="game-name"]');
                if (!nameEl) {
                    logDebug('hook', 'ns-roster-member no nameEl');
                    return;
                }
                const cur = nameEl.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    if (cur && cur !== cfg.gameName) {
                        const [base] = catCfg('friend');
                        if (cur !== base && cur.indexOf(base + ' ') !== 0) {
                            const p = typeof this.get === 'function' && this.get('puuid');
                            let label = lookupFriend(p, cur);
                            if (!label) label = registerFriend(cur, p);
                            nameEl.textContent = label;
                            logDebug('hook', 'ns-roster-member spoofed "' + cur + '" -> "' + label + '"');
                            this.element.dataset.snoozeFriendName = cur;
                        } else {
                            const p = typeof this.get === 'function' && this.get('puuid');
                            let realName = null;
                            if (p) {
                                const entry = friendRegistry.get('puuid:' + p);
                                if (entry) realName = entry.realName;
                            }
                            if (!realName) {
                                for (const [, entry] of friendRegistry) {
                                    if (entry.spoofLabel === cur && entry.realName) {
                                        realName = entry.realName;
                                        break;
                                    }
                                }
                            }
                            if (realName) {
                                this.element.dataset.snoozeFriendName = realName;
                            } else if (p) {
                                this.element.dataset.snoozeFriendName = 'puuid:' + p;
                            }
                        }
                    }
                } else if (!cfg.enabled) {
                    let realName = null;
                    const p = typeof this.get === 'function' && this.get('puuid');
                    if (p) {
                        const entry = friendRegistry.get('puuid:' + p);
                        if (entry) realName = entry.realName;
                    }
                    if (!realName) realName = typeof this.get === 'function' && this.get('gameName');
                    if (realName && cur !== realName) {
                        nameEl.textContent = realName;
                        logDebug('hook', 'ns-roster-member restored "' + cur + '" -> "' + realName + '"');
                    }
                    delete this.element.dataset.snoozeFriendName;
                } else {
                    logDebug('hook', 'ns-roster-member skipped cfg.enabled=' + cfg.enabled + ' spoofFriends=' + cfg.spoofFriends);
                }
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-social-friend-request',
        matcher: 'lol-social-friend-request',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                if (cfg.enabled && cfg.spoofFriends) {
                    trackComponent(this);
                    this.element.querySelectorAll('lol-uikit-player-name').forEach(el => {
                        const cur = el.getAttribute('game-name');
                        if (!cur || cur === cfg.gameName) return;
                        const [base] = catCfg('friend');
                        if (cur === base || cur.indexOf(base + ' ') === 0) return;
                        let label = lookupFriend(null, cur);
                        if (!label) label = registerFriend(cur, null);
                        el.setAttribute('game-name', label);
                    });
                } else if (!cfg.enabled) {
                    this.element.querySelectorAll('lol-uikit-player-name').forEach(el => {
                        const req = this.get && (this.get('friendRequest') || this.get('request'));
                        const realName = req && (req.name || req.gameName);
                        if (realName) el.setAttribute('game-name', realName);
                    });
                }
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    function hookScoreboardRow() {
        const el = this.element;
        if (!el) return;
        trackComponent(this);
        if (!cfg.enabled) {
            swapNameText(el);
            return;
        }
        const nameEl = el.querySelector('.player-name__game-name, .player-game-name, [class*="game-name"]');
        if (!nameEl) return;
        let cur = nameEl.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
        if (!cur) return;
        if (active() && el.classList.contains('is-local-player')) {
            if (cur !== cfg.gameName) nameEl.textContent = cfg.gameName;
            return;
        }
        const alias = realToAlias[cur];
        if (alias && alias !== cur) {
            nameEl.textContent = alias;
        }
    }

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-scoreboard-row-component',
        matcher: 'scoreboard-row-component',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                hookScoreboardRow.call(this);
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));

    // Batch: simple didRender + swapNameText hooks for direct-name-rendering components
    const _nameHooks = [
        // champ-select
        'summoner-overlay',
        // postgame scoreboard
        'postgame-root-component', 'postgame-scoreboard-component',
        'scoreboard-root-component', 'scoreboard-header-component',
        'postgame-scoreboard-player-honor-flair', 'scoreboard-honor-flair-component',
        'postgame-tft-player', 'postgame-player-buttons',
        'winners-roster-component', 'honor-panel-component',
        // arena (strawberry/cherry) — completely uncovered previously
        'strawberry-postgame-root-component', 'strawberry-scoreboard-root-component',
        'strawberry-scoreboard-row-component', 'cherry-player-level-display',
        // profiles
        'style-profile-summoner-namings-component',
        // parties
        'custom-game-team-member', 'player-party-controls', 'v2-player-party-controls',
        'social-leaderboard-row',
        // social
        'hovercard-shell', 'hovercard-name-alias-mode', 'lol-friend-finder-by-summoner-name',
        'reform-card-chat-log', 'player-behavior-reform-card',
        'player-behavior-reform-card-v2', 'player-behavior-reform-card-v3',
        // clash
        'clash-roster-member', 'clash-roster-lobby-member', 'clash-roster-details',
        'clash-member-summoner', 'clash-overview-stat', 'clash-summoner-display',
        'util-tournament-scouting-member', 'clash-invite-dialog',
        // settings
        'lol-blocked-player',
        // shared
        'challenges-identity-customizer-root-component',
        // tft
        'rcp-fe-lol-tft-skill-tree-lb', 'tft-player-card',
        'tft-promethium-scoreboard', 'tft-promethium-score-row-component',
        // leagues
        'rank-standing-row-component',
        // shared: challenge comparison tooltips
        'challenge-item-tooltip', 'challenge-item-tooltip-component',
        // parties: penalty/error dialogs with summoner names
        'disruptive-gameplay-lockout-error-dialog', 'leaver-buster-lockout-error-dialog',
        'queue-dodge-error-dialog', 'ready-check-failer-error-dialog',
        // parties: spectator list
        'spectator-info-spectators-list-item',
        // champ select
        'summoner-object', 'summoner-object-component',
        // match history detail
        'match-details-scoreboard-component',
        // parties: game invites / party status
        'postgame-party-status', 'postgame-party-status-v2',
        'parties-invite-dialog', 'parties-invite-info-panel', 'v2-parties-invite-info-panel',
        'cherry-progression-lobby',
        // parties: notification area where invite popups appear
        'parties-footer-notifications', 'v2-footer-notifications', 'parties-notifications'
    ];
    for (const cls of _nameHooks) {
        _hookCleanups.push(Utils.Hooks.Ember.registerRule({
            name: 'ns-' + cls.replace(/[-\s]/g, '-'),
            matcher: cls,
            hookMethods: [{
                name: 'didRender',
                callback(Ember, original, ...args) {
                    original(...args);
                    if (!this.element) return;
                    if (!cfg.enabled && !_hasSpoofedAnything) return;
                    trackComponent(this);
                    swapNameText(this.element);
                }
            }, {
                name: 'willDestroy',
                callback(Ember, original, ...args) {
                    original(...args);
                    untrackComponent(this);
                    _mhComponents.delete(this);
                }
            }]
        }));

    }

    // Special: postgame-component — reads postgame.player.summonerName, needs puuid from postgame model
    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'ns-postgame-component',
        matcher: 'postgame-component',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) return;
                if (!cfg.enabled && !_hasSpoofedAnything) return;
                trackComponent(this);
                const model = this.get && (this.get('postgame') || this.get('model'));
                const puuid = model && (model.localSummoner && model.localSummoner.puuid || model.player && model.player.puuid);
                swapNameText(this.element, puuid);
            }
        }, {
            name: 'willDestroy',
            callback(Ember, original, ...args) {
                original(...args);
                untrackComponent(this);
            }
        }]
    }));


}

export function dispose() {
    rerenderTracked();
    DomScrubber.disconnectFrameObservers();
    stopTooltipObserver();
    stopChatObserver();
    stopOverrideAttrObserver();
    stopInviteObserver();
    for (const fn of _hookCleanups) try {
        fn();
    } catch {}
    _hookCleanups.length = 0;
    for (const fn of _fetchCleanups) try {
        fn();
    } catch {}
    _fetchCleanups.length = 0;
    _mhCtx = null;
    // Rerender tracked components to restore original model data
    for (const c of _emberComponents) {
        try {
            c.rerender();
        } catch {}
    }
    _emberComponents.clear();
    // Force full cleanup of realToAlias etc. after all rerenders
    for (const key of Object.keys(realToAlias)) delete realToAlias[key];
    friendPuuids.clear();
    friendRegistry.clear();
    friendCounter = 0;
    _postgameNameIndex = 0;
    Object.keys(catMaps).forEach(k => delete catMaps[k]);
    Object.keys(catCount).forEach(k => {
        catCount[k] = 0;
    });
    _xhrRoutes.length = 0;
    _hooksInstalled = false;
    _xhrInstalled = false;
    if (typeof Utils !== 'undefined' && Utils.Hooks && Utils.Hooks.Ember) {
        for (const rule of Utils.Hooks.Ember._rules) {
            if (rule.name && rule.name.startsWith('ns-')) rule.enabled = false;
        }
    }
}

export function init(context) {
    loadConfig();
    installHooks(context);
    installEmberHook();
    if (context && context.rcp) {
        context.rcp.postInit('rcp-fe-ember-libs', (api) => {
            _emberProvider = api;
        });
    }
    captureRealIdentity();
    refreshContext();

    if (Utils.LCU && Utils.LCU.observe) {
        Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (e) => {
            const prev = ctx.phase;
            ctx.phase = e.data || ctx.phase;
            logDebug('phase', 'phase=' + ctx.phase + ' prev=' + prev + ' enabled=' + cfg.enabled + ' aliasOthersNow=' + aliasOthersNow());
            if (!cfg.enabled) return;
            const p = e.data;
            if (p === 'Lobby' || p === 'Matchmaking' || p === 'ReadyCheck' || p === 'ChampSelect') {
                _postgameNameIndex = 0;
                Utils.LCU.get('/lol-gameflow/v1/session').then(s => {
                    const q = s && s.gameData && s.gameData.queue;
                    if (q) ctx.isRanked = !!q.isRanked || RANKED_QUEUES.has(q.id);
                    logDebug('session', 'isRanked=' + ctx.isRanked + ' queueId=' + (q ? q.id : 'null') + ' q.isRanked=' + (q ? q.isRanked : 'null'));
                }).catch(() => {
                    logDebug('session', 'fetch failed (404 normal during some phases)');
                });
                if (p === 'ChampSelect') {
                    // Name resolution handled by Ember didRender hooks exclusively
                }
            }
        });
    }

    setupSettings(context);
}

const DESCRIPTION = t('Locally replaces your displayed Riot ID and optionally aliases other players (Friend / Player) in the friends list, lobby, non-ranked champ select, and match history / post-game. Client-side Only.');

const PLUGIN_CFG = {
    name: 'name-spoofer-settings',
    titleKey: 'lx_name-spoofer',
    titleName: t('Name Spoofer'),
    capitalTitleKey: 'lx_name-spoofer_capital',
    capitalTitleName: t('NAME SPOOFER'),
    class: 'name-spoofer-settings'
};

function setupSettings(context) {
    Utils.Settings.inject(context, PLUGIN_CFG);
    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: MODULE,
            name: t('Name Spoofer'),
            description: DESCRIPTION,
            settings: [{
                    type: 'toggle',
                    id: 'enabled',
                    label: t('Enable Name Spoofer (master)'),
                    value: cfg.enabled,
                    onChange: (v) => saveCfg('enabled', v)
                },
                {
                    type: 'custom',
                    render: (row) => buildSettings(row)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.name-spoofer-settings', (container) => buildSettings(container));
    }
}

function saveCfg(key, val) {
    Utils.Store.set(MODULE, key, val);
    applyConfig();
}

function sectionTitle(text) {
    const t = document.createElement('div');
    t.textContent = text;
    Object.assign(t.style, {
        color: '#c8aa6e',
        fontSize: '13px',
        fontWeight: '700',
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
        marginTop: '12px'
    });
    return t;
}

function nameRow(label, nameKey, dflt, opts = {}) {
    const {
        numKey,
        fixedDefault,
        width = '150px'
    } = opts;
    const row = document.createElement('div');
    Object.assign(row.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
    });
    const lab = document.createElement('span');
    lab.textContent = label;
    Object.assign(lab.style, {
        color: '#a09b8c',
        fontSize: '12px',
        whiteSpace: 'nowrap',
        flex: '0 0 80px'
    });
    const input = document.createElement('input');
    input.type = 'text';
    input.value = cfg[nameKey] || '';
    input.placeholder = dflt;
    Object.assign(input.style, {
        width,
        flex: '0 0 auto',
        background: '#111',
        border: '1px solid #3e2e13',
        color: '#f0e6d2',
        padding: '7px 9px',
        borderRadius: '4px',
        outline: 'none',
        fontSize: '13px'
    });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('focus', () => {
        input.style.borderColor = '#c8aa6e';
    });
    input.addEventListener('blur', () => {
        input.style.borderColor = '#3e2e13';
    });
    input.addEventListener('change', () => {
        const v = input.value.trim();
        saveCfg(nameKey, fixedDefault ? (v || dflt) : v);
    });
    row.appendChild(lab);
    row.appendChild(input);
    if (numKey) {
        const wrap = document.createElement('label');
        Object.assign(wrap.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
            marginLeft: '4px',
            color: '#a09b8c',
            fontSize: '12px',
            whiteSpace: 'nowrap',
            cursor: 'pointer'
        });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!cfg[numKey];
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => saveCfg(numKey, cb.checked));
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode(t('Numbers')));
        row.appendChild(wrap);
    }
    return row;
}

function buildSettings(c) {
    while (c.firstChild) c.removeChild(c.firstChild);

    c.style.display = 'flex';
    c.style.flexDirection = 'column';
    c.style.alignItems = 'stretch';
    c.style.gap = '10px';
    c.style.paddingLeft = '20px';
    c.style.marginTop = '0';
    c.style.borderLeft = '2px solid #3e2e13';

    c.appendChild(sectionTitle(t('My Name')));
    c.appendChild(Utils.Settings.createToggleRow(t('Spoof My Name'), cfg.spoofSelf, (v) => saveCfg('spoofSelf', v)));
    c.appendChild(nameRow(t('Game Name'), 'gameName', real.gameName || t('Name Spoofer'), {
        width: '180px'
    }));
    c.appendChild(nameRow(t('Tagline'), 'tagLine', real.tagLine || t('Pengu'), {
        width: '90px'
    }));

    c.appendChild(sectionTitle(t('Where to Spoof')));
    c.appendChild(Utils.Settings.createToggleRow(t('Friends list / social / invite panel'), cfg.spoofFriends, (v) => saveCfg('spoofFriends', v)));
    c.appendChild(Utils.Settings.createToggleRow(t('Lobby'), cfg.spoofLobby, (v) => saveCfg('spoofLobby', v)));
    c.appendChild(Utils.Settings.createToggleRow(t('Champ Select (non-ranked)'), cfg.spoofChampSelect, (v) => saveCfg('spoofChampSelect', v)));
    c.appendChild(Utils.Settings.createToggleRow(t('Match History & Post-Game'), cfg.spoofMatchHistory, (v) => saveCfg('spoofMatchHistory', v)));

    c.appendChild(sectionTitle(t('Names for Other Players')));
    c.appendChild(nameRow(t('Friend'), 'friendName', t('Friend'), {
        numKey: 'friendNumbers',
        fixedDefault: true
    }));
    c.appendChild(nameRow(t('Other'), 'globalName', t('Player'), {
        numKey: 'globalNumbers',
        fixedDefault: true
    }));

    const credit = document.createElement('div');
    Object.assign(credit.style, {
        marginTop: 'auto',
        textAlign: 'right',
        fontSize: '11px',
        color: '#5a7080',
        paddingTop: '12px'
    });
    credit.textContent = t('by Lx @iIlusion');
    c.appendChild(credit);
}

export function load() {
    assertXhr();
    if (!cfg.enabled) return;
    DomScrubber.install();
    DomScrubber.sweep();
    installTooltipObserver();
    installChatObserver();
    installOverrideAttrObserver();
    installInviteObserver();
}