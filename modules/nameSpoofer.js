/**
 * @name NameSpoofer
 * @version 1.0.0
 * @author Lx - github@iIlusion
 * @description Locally spoofs your displayed Riot ID by rewriting the identity
 *              fields the LCU returns. Cosmetic only: others still see your real name.
 * @link https://github.com/iIlusion
 */
import Utils from './generalUtils.js';

const MODULE = 'nameSpoofer';

// In-memory mirror of the persisted config (read on every hook, so keep it hot).
const cfg = {
    enabled: false,         // global master switch (turns ALL spoofing on/off)
    spoofSelf: true,       // spoof my own name
    gameName: 'Name Spoofer',
    tagLine: 'Pengu',
    friendName: 'Friend', friendNumbers: true,
    allyName: 'Ally',          // allies are always numbered
    enemyName: 'Enemy',        // enemies are always numbered
    // Shared label for misc other players (suggested/invited/honored/recently-played/invite-by-name).
    globalName: 'Player', globalNumbers: true,
    spoofFriends: false,
    spoofLobby: false,
    spoofChampSelect: false,   // non-ranked only
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

// Live gameflow context, refreshed by polling (event delivery is unreliable here).
const ctx = { phase: 'None', isRanked: false };

// Fallback when gameData.queue.isRanked is absent.
const RANKED_QUEUES = new Set([420, 440]);

function catCfg(category) {
    switch (category) {
        case 'ally':    return [cfg.allyName, true];
        case 'enemy':   return [cfg.enemyName, true];
        case 'global':  return [cfg.globalName, cfg.globalNumbers];
        default:        return [cfg.friendName, cfg.friendNumbers];
    }
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
function friendLabel(key) { if (key) friendPuuids.add(key); return catLabel('friend', key); }

// Match-history / post-game others are numbered by render order per game.
function nextOther(counters, isAlly) {
    const [base, useNum] = catCfg(isAlly ? 'ally' : 'enemy');
    if (!useNum) return base;
    return base + ' ' + (isAlly ? ++counters.ally : ++counters.enemy);
}

// Real name -> alias capture, so the DOM scrubber can fix cached renders (hovercard).
const realToAlias = {};
function noteFriend(realName, label) {
    if (realName && label && realName !== label) realToAlias[realName] = label;
}

// Match data often anonymizes puuids to all-zeros, so the alias key falls back to name.
const ZERO_PUUID = '00000000-0000-0000-0000-000000000000';
function validPuuid(p) { return p && p !== ZERO_PUUID; }

// Endpoints whose response root is us -> rewrite unconditionally (incl. `name`).
const ME_ENDPOINTS = [
    '/lol-summoner/v1/current-summoner',
    '/lol-chat/v1/me'
];

// Multi-player endpoints -> self-spoof + alias known friends (by puuid). Chat
// conversations/participants are where the friend hovercard reads its name from.
const GENERIC_ENDPOINTS = [
    '/lol-gameflow/v1/session',
    '/lol-chat/v1/conversations'
];

// Summoner-name resolvers (by id/puuid), used by player search/profiles AND
// champ-select cells: self+friends normally, but alias everyone as allies while
// in champ select / lobby (the cells resolve names through here).
const SUMMONER_LOOKUP = [
    '/lol-summoner/v2/summoners',
    '/lol-summoner/v1/summoners'
];

// Match-history endpoints (LCU + external SGP). Substring matching also catches
// the absolute SGP URL.
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

// WebSocket pushes that carry our identity.
const ME_WS = [
    '/lol-summoner/v1/current-summoner',
    '/lol-chat/v1/me'
];

function loadConfig() {
    cfg.enabled = Utils.Store.get(MODULE, 'enabled', true);      // global master switch
    cfg.spoofSelf = Utils.Store.get(MODULE, 'spoofSelf', true);  // spoof only my own name
    cfg.gameName = Utils.Store.get(MODULE, 'gameName', 'Name Spoofer');
    cfg.tagLine = Utils.Store.get(MODULE, 'tagLine', 'Pengu');
    cfg.friendName = Utils.Store.get(MODULE, 'friendName', 'Friend') || 'Friend';
    cfg.allyName = Utils.Store.get(MODULE, 'allyName', 'Ally') || 'Ally';
    cfg.enemyName = Utils.Store.get(MODULE, 'enemyName', 'Enemy') || 'Enemy';
    cfg.globalName = Utils.Store.get(MODULE, 'globalName', 'Player') || 'Player';
    cfg.friendNumbers = Utils.Store.get(MODULE, 'friendNumbers', true);
    cfg.globalNumbers = Utils.Store.get(MODULE, 'globalNumbers', true);
    cfg.spoofFriends = Utils.Store.get(MODULE, 'spoofFriends') || false;
    cfg.spoofLobby = Utils.Store.get(MODULE, 'spoofLobby') || false;
    cfg.spoofChampSelect = Utils.Store.get(MODULE, 'spoofChampSelect') || false;
    cfg.spoofMatchHistory = Utils.Store.get(MODULE, 'spoofMatchHistory') || false;
}

// Self-name spoof: requires the master switch, the "spoof my name" toggle, and a name.
function active() {
    return cfg.enabled && cfg.spoofSelf && (cfg.gameName || cfg.tagLine);
}

// Whether others should currently be aliased in social UI (lobby/champ select),
// based on phase + ranked state. Match history is gated per-endpoint, not here.
// All others-aliasing is also gated by the master switch.
function aliasOthersNow() {
    if (!cfg.enabled) return false;
    if (ctx.phase === 'ChampSelect') return cfg.spoofChampSelect && !ctx.isRanked;
    if (ctx.phase === 'Lobby' || ctx.phase === 'Matchmaking' || ctx.phase === 'ReadyCheck') return cfg.spoofLobby;
    return false;
}

function scrubActive() {
    return cfg.enabled && ((active() && real.gameName) || aliasOthersNow() || cfg.spoofFriends || cfg.spoofMatchHistory);
}

// `allowName` gates the ambiguous `name` key (only safe on dedicated "me" endpoints).
function applyName(obj, allowName, gameName, tagLine) {
    if (gameName) {
        for (const k of ['gameName', 'displayName', 'summonerName', 'internalName',
                         'summonerInternalName', 'riotIdGameName']) {
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
    return 'gameName' in o || 'summonerName' in o || 'riotIdGameName' in o || 'displayName' in o;
}

function nameOf(o) {
    return o.gameName || o.summonerName || o.riotIdGameName || o.displayName;
}

// A real `puuid`, or the puuid embedded in chat ids like "f61f...@br1.pvp.net".
function puuidOf(o) {
    if (validPuuid(o.puuid)) return o.puuid;
    for (const k of ['id', 'pid']) {
        const v = o[k];
        if (typeof v === 'string') { const p = v.split('@')[0]; if (validPuuid(p)) return p; }
    }
    return null;
}

// Is this identity us? (puuid match, or name == our real OR already-spoofed name)
function isSelf(o, nm) {
    nm = nm || nameOf(o);
    return (validPuuid(o.puuid) && o.puuid === real.puuid)
        || (real.gameName && nm === real.gameName)
        || (cfg.gameName && nm === cfg.gameName);
}

function spoofSelf(node, isMeRoot) {
    if (Array.isArray(node)) { for (const n of node) spoofSelf(n, false); return; }
    if (!node || typeof node !== 'object') return;
    if (isMeRoot || isSelf(node)) applyName(node, isMeRoot, cfg.gameName, cfg.tagLine);
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') spoofSelf(v, false); }
}

// Spoof us, and alias any object whose puuid is a known friend (conversation
// participants, summoner lookups, chat, hovercard data...).
function spoofSelfAndFriends(node, isMeRoot, selfOn) {
    if (Array.isArray(node)) { for (const n of node) spoofSelfAndFriends(n, false, selfOn); return; }
    if (!node || typeof node !== 'object') return;
    if (isMeRoot || isSelf(node)) {
        if (selfOn) applyName(node, true, cfg.gameName, cfg.tagLine);
    } else if (cfg.spoofFriends && hasNameField(node)) {
        const pu = puuidOf(node);
        if (pu && friendPuuids.has(pu)) { const l = friendLabel(pu); noteFriend(nameOf(node), l); applyName(node, true, l, ''); }
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') spoofSelfAndFriends(v, false, selfOn); }
}

// Assign each non-self player a stable per-key alias in the given category.
function aliasFriendsList(node, selfOn, category) {
    if (Array.isArray(node)) { for (const n of node) aliasFriendsList(n, selfOn, category); return; }
    if (!node || typeof node !== 'object') return;
    if (hasNameField(node)) {
        if (isSelf(node)) { if (selfOn) applyName(node, true, cfg.gameName, cfg.tagLine); }
        else {
            const pu = puuidOf(node);
            const key = pu || (node.summonerId && ('sid:' + node.summonerId)) || nameOf(node);
            if (key) {
                if (category === 'friend' && pu) friendPuuids.add(pu);
                const l = catLabel(category, key);
                noteFriend(nameOf(node), l);
                applyName(node, true, l, '');
            }
        }
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') aliasFriendsList(v, selfOn, category); }
}

function applyOther(o, isAlly, counters, selfOn) {
    if (isSelf(o)) { if (selfOn) applyName(o, true, cfg.gameName, cfg.tagLine); return; }
    const label = nextOther(counters, isAlly);
    noteFriend(nameOf(o), label);
    applyName(o, true, label, '');
}

// Single-group ordered aliasing (lobby, champ select = your team): every non-self
// identity becomes "<base> N" by encounter order.
function aliasOrderedTree(node, selfOn, counters, category) {
    if (Array.isArray(node)) { for (const n of node) aliasOrderedTree(n, selfOn, counters, category); return; }
    if (!node || typeof node !== 'object') return;
    if (hasNameField(node)) {
        if (isSelf(node)) { if (selfOn) applyName(node, true, cfg.gameName, cfg.tagLine); }
        else {
            const [base, useNum] = catCfg(category);
            const label = useNum ? base + ' ' + (++counters.n) : base;
            noteFriend(nameOf(node), label);
            applyName(node, true, label, '');
        }
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') aliasOrderedTree(v, selfOn, counters, category); }
}

// Team-aware aliasing for match history / post-game. Detects the known game/team
// container shapes and numbers allies + enemies separately, by render order.
function aliasTeam(node, selfOn) {
    if (Array.isArray(node)) { for (const n of node) aliasTeam(n, selfOn); return; }
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.participantIdentities) && Array.isArray(node.participants)) {
        aliasLcuGame(node, selfOn); return;
    }
    if (Array.isArray(node.teams) && node.teams[0] && Array.isArray(node.teams[0].players)) {
        aliasEogTeams(node, selfOn); return;
    }
    if (Array.isArray(node.participants) && node.participants[0] && hasNameField(node.participants[0])) {
        aliasFlatParticipants(node.participants, selfOn); return;
    }
    // Honor ballot: eligible teammates (allies) + optional opponents.
    if (Array.isArray(node.eligiblePlayers) || Array.isArray(node.eligibleAllies) || Array.isArray(node.eligibleOpponents)) {
        const c = { ally: 0, enemy: 0 };
        for (const p of (node.eligibleAllies || node.eligiblePlayers || [])) if (p && hasNameField(p)) applyOther(p, true, c, selfOn);
        for (const p of (node.eligibleOpponents || [])) if (p && hasNameField(p)) applyOther(p, false, c, selfOn);
        return;
    }
    for (const k in node) { const v = node[k]; if (v && typeof v === 'object') aliasTeam(v, selfOn); }
}

// LCU match shape: participants[] (teamId) linked to participantIdentities[] by participantId.
function aliasLcuGame(game, selfOn) {
    const pidTeam = {};
    for (const p of game.participants) pidTeam[p.participantId] = p.teamId;
    let ourTeam = null;
    for (const idn of game.participantIdentities) {
        if (idn.player && isSelf(idn.player)) { ourTeam = pidTeam[idn.participantId]; break; }
    }
    const c = { ally: 0, enemy: 0 };
    for (const idn of game.participantIdentities) {
        if (!idn.player) continue;
        const team = pidTeam[idn.participantId];
        applyOther(idn.player, ourTeam != null ? team === ourTeam : team === 100, c, selfOn);
    }
}

// Post-game eog-stats-block shape: teams[].players[] (+ optional localPlayer).
function aliasEogTeams(node, selfOn) {
    let ourTeam = null;
    for (const t of node.teams) for (const pl of (t.players || [])) if (isSelf(pl)) ourTeam = t;
    const c = { ally: 0, enemy: 0 };
    for (const t of node.teams) {
        const ally = ourTeam != null ? t === ourTeam : t === node.teams[0];
        for (const pl of (t.players || [])) applyOther(pl, ally, c, selfOn);
    }
    if (node.localPlayer && selfOn) applyName(node.localPlayer, false, cfg.gameName, cfg.tagLine);
}

// SGP / flat shape: participants[] each with a name + teamId.
function aliasFlatParticipants(parts, selfOn) {
    let ourTeam = null;
    for (const p of parts) if (isSelf(p)) { ourTeam = p.teamId; break; }
    const c = { ally: 0, enemy: 0 };
    for (const p of parts) applyOther(p, ourTeam != null ? p.teamId === ourTeam : p.teamId === 100, c, selfOn);
}

function needsWork(opts) {
    return active() || (cfg.enabled && (opts.others || cfg.spoofFriends));
}

// Apply the right aliaser to an already-parsed object, in place.
//   opts.others: false | 'ally' | 'team' | 'friendsList' | 'globalList'
// The default (others = false) self-spoofs AND aliases known friends by puuid.
function transformObject(data, opts) {
    const others = opts.others;
    const selfOn = active();
    if (others === 'team') aliasTeam(data, selfOn);
    else if (others === 'ally') aliasFriendsList(data, selfOn, 'ally');
    else if (others === 'friendsList') aliasFriendsList(data, selfOn, 'friend');
    else if (others === 'globalList') aliasFriendsList(data, selfOn, 'global');
    else spoofSelfAndFriends(data, opts.isMeRoot, selfOn);
}

// Text wrapper for fetch hooks (parse -> transform -> stringify).
function transformText(text, opts) {
    if (!text || !needsWork(opts)) return text;
    let data;
    try { data = JSON.parse(text); } catch { return text; }
    try { transformObject(data, opts); return JSON.stringify(data); }
    catch (e) { Utils.Debug.warn('[NameSpoofer] transform failed:', e); return text; }
}

// XHR interceptor that also handles responseType:'json' (which the framework's
// XhrHook skips — that's why the post-game/honor screens leaked). Overrides the
// per-instance response/responseText getters so transformed data is returned no
// matter when or how the consumer reads it (avoids handler-ordering races).
//
// Other plugins may wrap XMLHttpRequest.prototype.open at load and end up
// outermost, shadowing a proto.send override — so we set up the getters inside our
// OWN open wrapper (not proto.send) and re-assert on top via assertXhr() (no-op
// once outermost). Re-called on each load()/poll to reclaim the outer slot.
let _xhrInstalled = false;
let _xhrRespGet, _xhrTextGet;
const _xhrRoutes = [];
function assertXhr() {
    const proto = XMLHttpRequest.prototype;
    if (proto.open && proto.open._nsHook) return;   // already outermost
    if (!_xhrRespGet) {
        _xhrRespGet = Object.getOwnPropertyDescriptor(proto, 'response').get;
        _xhrTextGet = Object.getOwnPropertyDescriptor(proto, 'responseText').get;
    }
    const prevOpen = proto.open;
    const respGet = _xhrRespGet, textGet = _xhrTextGet;
    const nsOpen = function (m, u, ...rest) {
        const url = String(u);
        const route = _xhrRoutes.find((rt) => url.indexOf(rt.pattern) !== -1);
        if (route) {
            const opts = route.optsFn;
            let objDone = false, textCache;
            try {
                Object.defineProperty(this, 'response', {
                    configurable: true,
                    get() {
                        let raw; try { raw = respGet.call(this); } catch { return undefined; }
                        if (this.readyState !== 4 || !needsWork(opts())) return raw;
                        if (raw && typeof raw === 'object') {
                            if (!objDone) { try { transformObject(raw, opts()); } catch {} objDone = true; }
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
                        let raw; try { raw = textGet.call(this); } catch { return ''; }
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
function installXhr() {
    if (_xhrInstalled) return;
    _xhrInstalled = true;
    assertXhr();
}

let _hooksInstalled = false;
function installHooks(context) {
    if (_hooksInstalled) return;
    _hooksInstalled = true;
    installXhr();

    // `optsFn` returns { isMeRoot, others } fresh per response so the decision is always current.
    const reg = (pattern, optsFn) => {
        Utils.Hooks.Fetch.hookRes(pattern, (text) => transformText(text, optsFn()));
        _xhrRoutes.push({ pattern, optsFn });
    };

    // Social lists of other players (recently played, suggested, invited, sent
    // requests, honored). Registered BEFORE the broad summoner/match-history
    // patterns so the XHR router matches these first.
    reg('/lol-match-history/v1/recently-played-summoners', () => ({ others: cfg.spoofFriends ? 'globalList' : false }));
    reg('/lol-summoner/v1/summoners/aliases', () => ({ others: cfg.spoofFriends ? 'friendsList' : false }));

    for (const ep of ME_ENDPOINTS) reg(ep, () => ({ isMeRoot: true, others: false }));
    for (const ep of GENERIC_ENDPOINTS) reg(ep, () => ({ isMeRoot: false, others: false }));
    // Alias non-self as allies while in champ select / lobby (the cells resolve
    // names here), else self + known friends.
    for (const ep of SUMMONER_LOOKUP) reg(ep, () => ({ others: aliasOthersNow() ? 'ally' : false }));

    reg('/lol-chat/v1/friends', () => ({ others: cfg.spoofFriends ? 'friendsList' : false }));
    reg('/lol-lobby/v2/lobby', () => ({ others: cfg.spoofLobby ? 'ally' : false }));
    reg('/lol-champ-select/v1/session', () => ({ others: (cfg.spoofChampSelect && !ctx.isRanked) ? 'ally' : false }));
    for (const ep of MATCH_HISTORY_ENDPOINTS) reg(ep, () => ({ others: cfg.spoofMatchHistory ? 'team' : false }));
    for (const ep of POST_GAME_ENDPOINTS) reg(ep, () => ({ others: cfg.spoofMatchHistory ? 'team' : false }));

    // Live WebSocket pushes (payload is already a parsed object).
    Utils.Hooks.WS.install(context);
    for (const ep of ME_WS) {
        Utils.Hooks.WS.hook(ep, (_endpoint, payload) => {
            if (!active() || !payload || typeof payload !== 'object') return payload;
            try { spoofSelf(payload, true); } catch (e) { Utils.Debug.warn('[NameSpoofer] WS transform failed:', e); }
            return payload;
        });
    }
}

// Poll the gameflow phase + ranked state (event delivery is unreliable in this
// client build, so a light poll keeps the context fresh for aliasOthersNow()).
async function refreshContext() {
    assertXhr();   // reclaim the outer proto.open slot if another plugin wrapped over us
    try {
        const phase = await Utils.LCU.get('/lol-gameflow/v1/gameflow-phase');
        if (typeof phase === 'string') ctx.phase = phase;
    } catch {}
    try {
        const s = await Utils.LCU.get('/lol-gameflow/v1/session');
        const q = s && s.gameData && s.gameData.queue;
        if (q) ctx.isRanked = !!q.isRanked || RANKED_QUEUES.has(q.id);
    } catch {}
}

// Decode a JWT payload (no verification — we only read claims).
function decodeJwtPayload(jwt) {
    try {
        const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        return JSON.parse(decodeURIComponent(escape(atob(part))));
    } catch { return null; }
}

// Learn our real identity. puuid comes from current-summoner (never rewritten).
// gameName/tagLine must come from a source we DON'T spoof — current-summoner is
// already rewritten by our hooks — so we read the untouched RSO userinfo JWT
// (acct.game_name / acct.tag_line). The real name is needed by the DOM scrubber
// to find-and-replace it where names resolve outside LCU REST (override map + chat).
async function captureRealIdentity() {
    if (!Utils.LCU) return;
    try {
        const me = await Utils.LCU.get('/lol-summoner/v1/current-summoner');
        if (me && me.puuid) real.puuid = me.puuid;

        const info = await Utils.LCU.get('/lol-rso-auth/v1/authorization/userinfo');
        const jwt = info && (info.userInfo || (typeof info === 'string' ? info : null));
        const payload = jwt ? decodeJwtPayload(jwt) : null;
        if (payload && payload.acct) {
            real.gameName = payload.acct.game_name || real.gameName;
            real.tagLine = payload.acct.tag_line || real.tagLine;
            real.displayName = real.gameName;
        }

        if (!real.puuid || !real.gameName) throw new Error('identity incomplete');
        DomScrubber.install();
        DomScrubber.sweep();
    } catch (e) {
        setTimeout(captureRealIdentity, 1500);   // client not ready yet; retry
    }
}

/**
 * DOM Scrubber
 *
 * Some names are NOT delivered as LCU REST/JSON (fetch/XHR hooks can't reach them):
 * the client resolves them through a puuid->name override map (the
 * `puuids-to-name-overrides-json` attribute on <lol-social-chat-room>) and renders
 * chat system messages inside <iframe> documents. This rewrites the real name in
 * the rendered DOM (main document + chat iframes) and proactively rewrites the
 * override map so on-demand UI (e.g. the avatar hovercard) is built with the spoof.
 *
 * Bare-name replacement is scoped to name/identity/system-message + toast surfaces
 * so we never clobber normal user-written chat.
 */
const OVERRIDE_ATTR = 'puuids-to-name-overrides-json';
const SCOPED_SEL = [
    '.name-text', '.player-name-wrapper', '.system-message',
    '.message-name', '.system-message-text',          // chat iframe sender + system text
    '[class*="message-name"]',
    '[class*="riot-id"]', '[class*="riotId"]',
    '[class*="summoner-name"]', '[class*="summonerName"]',
    '[class*="player-name"]', '[class*="playerName"]',
    '[class*="display-name"]', '[class*="displayName"]',
    '[class*="hovercard"]', '[class*="hover-card"]', '[class*="identity"]',
    '[class*="honor"]', '[class*="-name"]',
    '[class*="feedback"]', '[class*="update"]',
    '[class*="toast"]', '[class*="notification"]', '[class*="notify"]',
    '[class*="alert"]', '[class*="banner"]', '[class*="ticker"]',
    '[class*="popup"]', '[class*="modal"]', '[class*="dialog"]',
    'lol-uikit-toast', 'lol-uikit-notification', 'lol-uikit-dialog-frame',
    'lc-alert-modal', 'lc-confirm-modal'
].join(',');

const DomScrubber = {
    _installed: false,
    _docs: new WeakSet(),

    install() {
        if (this._installed) return;
        this._installed = true;
        this._attachDoc(document);
        // Re-attach to iframe documents as they appear (chat-messages-frame etc.).
        this._iframeObserver = new MutationObserver((muts) => {
            for (const m of muts) {
                for (const node of m.addedNodes) {
                    if (node.tagName === 'IFRAME') this._tryAttachIframe(node);
                }
            }
        });
        try { this._iframeObserver.observe(document.documentElement, { childList: true, subtree: true }); } catch {}
        // Safety net: chat <iframe> documents are recreated/written without reliable
        // load events, and live updates can outrun the observer, so a light periodic
        // pass guarantees convergence on chat frames + any view the observer missed.
        this._timer = setInterval(() => { try { this._sweepFrames(); } catch {} }, 700);
    },

    // Periodic safety net — only the (small) frame documents; the main document is
    // handled by its persistent observer, so we don't re-walk it every tick.
    _sweepFrames() {
        if (!this._installed || !scrubActive()) return;
        for (let i = 0; i < window.frames.length; i++) {
            try {
                const doc = window.frames[i].document;
                if (doc) { this._attachDoc(doc); this._scrubAll(doc); }
            } catch {}
        }
    },

    sweep() {
        if (!this._installed || !scrubActive()) return;
        this._attachDoc(document);
        this._scrubAll(document);
        this._sweepFrames();
        document.querySelectorAll('iframe').forEach((f) => this._tryAttachIframe(f));
    },

    _tryAttachIframe(iframe) {
        const grab = () => {
            try {
                const doc = iframe.contentDocument;
                if (doc) { this._attachDoc(doc); this._scrubAll(doc); }
            } catch {}
        };
        grab();
        iframe.addEventListener('load', grab);
    },

    _attachDoc(doc) {
        if (!doc || this._docs.has(doc)) return;
        this._docs.add(doc);
        const obs = new MutationObserver((muts) => this._onMutations(muts));
        try {
            obs.observe(doc.documentElement, {
                childList: true, subtree: true, characterData: true,
                attributes: true, attributeFilter: [OVERRIDE_ATTR]
            });
        } catch {}
    },

    _onMutations(muts) {
        if (!scrubActive()) return;
        for (const m of muts) {
            if (m.type === 'attributes') {
                this._fixOverrideAttr(m.target);
            } else if (m.type === 'characterData') {
                this._scrubTextNode(m.target);
            } else {
                for (const node of m.addedNodes) {
                    if (node.nodeType === Node.TEXT_NODE) this._scrubTextNode(node);
                    else if (node.nodeType === Node.ELEMENT_NODE) this._scrubAll(node);
                }
            }
        }
        // Cell names fill in after the cell mounts (character-data), so re-scan per batch.
        if (cfg.spoofFriends) this._scrubPlayerCells();
        this._scrubGridCells();
    },

    _scrubAll(root) {
        if (!scrubActive() || !root) return;
        try {
            if (root.querySelectorAll) {
                root.querySelectorAll('[' + OVERRIDE_ATTR + ']').forEach((el) => this._fixOverrideAttr(el));
            }
            this._scrubPlayerCells();
            this._scrubGridCells();
            const doc = root.ownerDocument || root;
            const start = root.nodeType === Node.ELEMENT_NODE ? root : (doc.body || doc.documentElement);
            if (!start) return;
            // Fast path: when only self-spoofing, skip the walk if our name isn't here.
            // When aliasing others/friends, names vary so we can't pre-filter.
            const selfOnly = (active() && real.gameName) && !aliasOthersNow() && !cfg.spoofFriends;
            if (selfOnly && (!start.textContent || start.textContent.indexOf(real.gameName) === -1)) return;
            const tw = doc.createTreeWalker(start, NodeFilter.SHOW_TEXT);
            let n;
            while ((n = tw.nextNode())) this._scrubTextNode(n);
        } catch {}
    },

    // Invite-panel cell category: actual friends use the friend name; everyone else
    // (invited / honored / recently-played suggestions) shares the global name.
    _inviteCategory(li) {
        if (li.querySelector('.invite-info-friend-icon')) return 'friend';
        return 'global';
    },

    // Alias one player cell's name to its category. A cell may render the name in
    // several spans (game-name-only + full-alias) plus a separate tagline; we set
    // every game-name span to the label and clear the tagline. Keyed by summonerId
    // when present, else by name. Skips self / already-aliased cells.
    _aliasCell(li, cat) {
        let targets = [...li.querySelectorAll('.player-name__game-name, .player-game-name')];
        if (!targets.length) {
            const f = li.querySelector('.name-text') || li.querySelector('[class*="game-name"]');
            if (f) targets = [f];
        }
        if (!targets.length) return;
        const cur = targets[0].textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
        if (!cur || cur === cfg.gameName) return;
        const [base] = catCfg(cat);
        if (cur === base || cur.indexOf(base + ' ') === 0) return;
        const sid = li.getAttribute('summonerid');
        const key = (sid && sid.length > 4) ? ('sid:' + sid) : ('name:' + cur);
        const label = catLabel(cat, key);
        if (cat === 'friend' && sid && sid.length > 4) friendPuuids.add('sid:' + sid);
        realToAlias[cur] = label;
        targets.forEach((t) => { t.textContent = label; });
        li.querySelectorAll('.player-name__tag-line').forEach((t) => { t.textContent = ''; });
    },

    // Alias player cells the data layer can't safely reach: lobby invite panel
    // (category by tab/icon) + friend-finder modal (sent requests / recently played).
    _scrubPlayerCells() {
        if (!cfg.spoofFriends) return;
        try {
            document.querySelectorAll('.v2-parties-invite-info-panel-player').forEach((li) => this._aliasCell(li, this._inviteCategory(li)));
            document.querySelectorAll('.lol-friend-finder-requested-player').forEach((li) => this._aliasCell(li, 'global'));
            document.querySelectorAll('.lol-friend-finder-recent-summoner').forEach((li) => this._aliasCell(li, 'global'));
            document.querySelectorAll('.invite-dialog-friend').forEach((li) => this._aliasCell(li, 'global'));
        } catch {}
    },

    // Champ-select grid cells (.summoner-object .summoner-name) render names via a
    // path the data hooks don't reach (esp. custom games showing both teams), so
    // alias them directly while in lobby / champ select. Left column = our team
    // (ally), right column = enemy. Keyed by name (cells carry no summonerId).
    _scrubGridCells() {
        if (!aliasOthersNow()) return;
        try {
            document.querySelectorAll('.summoner-object .summoner-name').forEach((el) => {
                const cur = el.textContent.replace(/[⁦-⁩‎‏]/g, '').trim();
                if (!cur || cur === cfg.gameName || cur === real.gameName) return;
                const cat = el.closest('.summoner-object').classList.contains('right') ? 'enemy' : 'ally';
                const [base] = catCfg(cat);
                if (cur === base || cur.indexOf(base + ' ') === 0) return;
                const label = catLabel(cat, 'name:' + cur);
                realToAlias[cur] = label;
                el.textContent = label;
            });
        } catch {}
    },

    _isScoped(textNode) {
        const el = textNode.parentElement;
        if (!el) return false;
        try { if (el.closest && el.closest(SCOPED_SEL)) return true; } catch {}
        // Fallback: a leaf whose text is exactly our real name (bare name cell).
        if (real.gameName) {
            const v = textNode.nodeValue.replace(/[⁦-⁩‎‏]/g, '').trim();
            if (v === real.gameName || v === (real.gameName + '#' + real.tagLine)) return true;
        }
        return false;
    },

    _scrubTextNode(node) {
        if (!node || !node.nodeValue) return;
        const next = this._scrubString(node.nodeValue, this._isScoped(node));
        if (next !== node.nodeValue) node.nodeValue = next;
    },

    _scrubString(s, scoped) {
        let out = s;
        if (active() && real.gameName) {
            const G = real.gameName, T = real.tagLine;
            const SG = cfg.gameName || G, ST = cfg.tagLine || T;
            if (T) {
                out = out.split(G + '#' + T).join(SG + '#' + ST);
                out = out.split(G + ' #' + T).join(SG + ' #' + ST);
            }
            if (scoped) {
                if (cfg.gameName && SG !== G) out = out.split(G).join(SG);
                if (cfg.tagLine && T && ST !== T) out = out.split(T).join(ST);
            }
        }
        // Replace cached real names (hovercard, post-game, honor) with their captured alias.
        if (scoped && (cfg.spoofFriends || cfg.spoofMatchHistory || aliasOthersNow())) {
            for (const rn in realToAlias) {
                if (rn && out.indexOf(rn) !== -1) out = out.split(rn).join(realToAlias[rn]);
            }
        }
        return out;
    },

    // Rewrite the puuid->name override map so any UI built from it (champ-select
    // cells, lobby, chat sender names, hovercards) uses the spoof. Our puuid ->
    // self-spoof; other puuids -> "<allyName> N" in map order, when aliasing is active.
    _fixOverrideAttr(el) {
        if (!el || !el.getAttribute) return;
        const selfOn = active() && cfg.gameName && real.puuid;
        const othersOn = aliasOthersNow();
        if (!selfOn && !othersOn) return;
        try {
            const raw = el.getAttribute(OVERRIDE_ATTR);
            if (!raw) return;
            const map = JSON.parse(raw);
            let changed = false;
            for (const puuid in map) {
                let desired = map[puuid];
                if (selfOn && puuid === real.puuid) desired = cfg.gameName;
                else if (othersOn && puuid !== real.puuid) desired = catLabel('ally', puuid);
                if (desired !== map[puuid]) { map[puuid] = desired; changed = true; }
            }
            if (changed) el.setAttribute(OVERRIDE_ATTR, JSON.stringify(map));
        } catch {}
    }
};

// Re-read config so live hooks pick up new values immediately. We deliberately do
// NOT fabricate WebSocket events to force-refresh the UI: a wrong payload envelope
// could feed malformed data to the client's own observers. Already-rendered views
// update on their next natural fetch (navigate away/back) or restart.
function applyConfig() {
    loadConfig();
    DomScrubber.sweep();
}

export function init(context) {
    loadConfig();
    installHooks(context);
    captureRealIdentity();
    refreshContext();
    setInterval(refreshContext, 1500);

    setupSettings(context);
}

const DESCRIPTION = 'Locally replaces your displayed Riot ID and optionally aliases other players (Friend / Ally / Enemy / Player) in the friends list, lobby, non-ranked champ select, and match history / post-game. Cosmetic only — nothing leaves your client.';

const PLUGIN_CFG = {
    name: 'name-spoofer-settings',
    titleKey: 'lx_name-spoofer',
    titleName: 'Name Spoofer',
    capitalTitleKey: 'lx_name-spoofer_capital',
    capitalTitleName: 'NAME SPOOFER',
    class: 'name-spoofer-settings'
};

// Register settings into the client Settings page via generalUtils. With the
// SnoozeManager loader present it renders our module; standalone it injects a
// native settings category and we fill its scroll container ourselves.
function setupSettings(context) {
    Utils.Settings.inject(context, PLUGIN_CFG);
    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: MODULE,
            name: 'Name Spoofer',
            description: DESCRIPTION,
            settings: [{ type: 'custom', render: (row) => buildSettings(row) }]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.name-spoofer-settings', (container) => buildSettings(container));
    }
}

function saveCfg(key, val) { Utils.Store.set(MODULE, key, val); applyConfig(); }

function settingSection(title, desc) {
    const sec = document.createElement('div');
    Object.assign(sec.style, { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', border: '1px solid rgba(200,170,110,0.2)', borderRadius: '10px', background: 'rgba(0,0,0,0.08)' });
    const t = document.createElement('div');
    t.textContent = title;
    Object.assign(t.style, { color: '#c8aa6e', fontSize: '13px', fontWeight: '700', textTransform: 'uppercase', letterSpacing: '0.04em' });
    sec.appendChild(t);
    if (desc) {
        const d = document.createElement('div');
        d.textContent = desc;
        Object.assign(d.style, { color: '#a09b8c', fontSize: '12px', lineHeight: '1.5' });
        sec.appendChild(d);
    }
    return sec;
}

// One configurable name: fixed-width label + right-sized text input + optional
// inline "Numbers" checkbox. opts.width sizes the input (default 150px — names are
// short, so no full-width fields). opts.numKey adds the checkbox; opts.fixedDefault
// falls an emptied field back to `dflt` (the other-player names must never be blank).
function nameRow(label, nameKey, dflt, opts = {}) {
    const { numKey, fixedDefault, width = '150px' } = opts;
    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '10px' });
    const lab = document.createElement('span');
    lab.textContent = label;
    Object.assign(lab.style, { color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap', flex: '0 0 80px' });
    const input = document.createElement('input');
    input.type = 'text';
    input.value = cfg[nameKey] || '';
    input.placeholder = dflt;
    Object.assign(input.style, { width, flex: '0 0 auto', background: '#111', border: '1px solid #3e2e13', color: '#f0e6d2', padding: '7px 9px', borderRadius: '4px', outline: 'none', fontSize: '13px', transition: 'border-color .15s ease' });
    input.addEventListener('click', (e) => e.stopPropagation());
    input.addEventListener('focus', () => { input.style.borderColor = '#c8aa6e'; });
    input.addEventListener('blur', () => { input.style.borderColor = '#3e2e13'; });
    input.addEventListener('change', () => { const v = input.value.trim(); saveCfg(nameKey, fixedDefault ? (v || dflt) : v); });
    row.appendChild(lab);
    row.appendChild(input);
    if (numKey) {
        const wrap = document.createElement('label');
        Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '6px', marginLeft: '4px', color: '#a09b8c', fontSize: '12px', whiteSpace: 'nowrap', cursor: 'pointer' });
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!cfg[numKey];
        cb.addEventListener('click', (e) => e.stopPropagation());
        cb.addEventListener('change', () => saveCfg(numKey, cb.checked));
        wrap.appendChild(cb);
        wrap.appendChild(document.createTextNode('Numbers'));
        row.appendChild(wrap);
    }
    return row;
}

// Build all controls into the given settings container (live-read from cfg),
// column of grouped section cards. Idempotent (clears first so a re-fired observer
// never duplicates). Never style the <lol-uikit-scrollable> itself — only inner divs.
function buildSettings(c) {
    while (c.firstChild) c.removeChild(c.firstChild);

    // Module description (shown in the native settings page; SnoozeManager shows
    // its own description, so only render this on the standalone/native path).
    if (!(window.SnoozeManager && window.SnoozeManager.registerModule)) {
        const desc = document.createElement('div');
        desc.textContent = DESCRIPTION;
        Object.assign(desc.style, { color: '#a09b8c', fontSize: '12px', lineHeight: '1.5', margin: '12px 0 2px' });
        c.appendChild(desc);
    }

    // Master toggle as a standalone card.
    const master = Utils.Settings.createToggleRow('Enable Name Spoofer (master)', cfg.enabled, (v) => saveCfg('enabled', v));
    master.classList.add('plugins-settings-row');
    Object.assign(master.style, { boxSizing: 'border-box', margin: '10px 0', padding: '12px 14px', background: 'rgba(200,170,110,0.06)', border: '1px solid rgba(200,170,110,0.22)', borderRadius: '8px', width: '100%' });
    c.appendChild(master);

    // Left-accented content column holding the section cards.
    const content = document.createElement('div');
    content.classList.add('plugins-settings-row');
    Object.assign(content.style, { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '12px', width: '100%', minWidth: '0', boxSizing: 'border-box', padding: '12px 0 0 20px', borderLeft: '2px solid #3e2e13', color: '#a09b8c', fontSize: '13px' });
    c.appendChild(content);

    const myName = settingSection('My Name', 'Replace your own displayed Riot ID.');
    myName.appendChild(Utils.Settings.createToggleRow('Spoof My Name', cfg.spoofSelf, (v) => saveCfg('spoofSelf', v)));
    myName.appendChild(nameRow('Game Name', 'gameName', real.gameName || 'Name Spoofer', { width: '180px' }));
    myName.appendChild(nameRow('Tagline', 'tagLine', real.tagLine || 'Pengu', { width: '90px' }));
    content.appendChild(myName);

    const where = settingSection('Where to Spoof', 'Also alias other players in these areas.');
    where.appendChild(Utils.Settings.createToggleRow('Friends list / social / invite panel', cfg.spoofFriends, (v) => saveCfg('spoofFriends', v)));
    where.appendChild(Utils.Settings.createToggleRow('Lobby', cfg.spoofLobby, (v) => saveCfg('spoofLobby', v)));
    where.appendChild(Utils.Settings.createToggleRow('Champ Select (non-ranked)', cfg.spoofChampSelect, (v) => saveCfg('spoofChampSelect', v)));
    where.appendChild(Utils.Settings.createToggleRow('Match History & Post-Game', cfg.spoofMatchHistory, (v) => saveCfg('spoofMatchHistory', v)));
    content.appendChild(where);

    const names = settingSection('Names for Other Players', 'Allies and enemies are always numbered.');
    names.appendChild(nameRow('Friend', 'friendName', 'Friend', { numKey: 'friendNumbers', fixedDefault: true }));
    names.appendChild(nameRow('Ally', 'allyName', 'Ally', { fixedDefault: true }));
    names.appendChild(nameRow('Enemy', 'enemyName', 'Enemy', { fixedDefault: true }));
    names.appendChild(nameRow('Other', 'globalName', 'Player', { numKey: 'globalNumbers', fixedDefault: true }));
    content.appendChild(names);
}

// Pengu calls load() on navigation; re-sweep so newly mounted views (champ
// select, lobby, fresh chat iframes) get scrubbed too.
export function load() {
    assertXhr();   // ensure our XHR interceptor is outermost before the new view fetches
    DomScrubber.sweep();
}
