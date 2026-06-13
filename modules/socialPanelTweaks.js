/**
 * @name Snooze-SocialPanelTweaks
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Improves friend list status display, same-party visuals, and adds a collapsible sidebar.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

const FRIENDS_URI = '/lol-chat/v1/friends';
const ACTIVE_ATTR = 'data-sm-social-panel-status';
const ORIGINAL_ATTR = 'data-sm-social-panel-status-original';
const ORIGINAL_TITLE_ATTR = 'data-sm-social-panel-status-original-title';
const ORIGINAL_STYLE_ATTR = 'data-sm-social-panel-status-original-style';
const CURRENT_TEXT_ATTR = 'data-sm-social-panel-status-current-text';
const PARTY_BORDER_ATTR = 'data-sm-party-border';
const PARTY_LOCK_ATTR = 'data-sm-party-lock';

const PARTY_HUE_SEED = 200;
const PARTY_GOLDEN_ANGLE = 137.508;
const LOCK_SCALE = 0.9;
const SIDEBAR_WIDTH = 224; // Custom 224px sidebar

const CLOSED_LOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="100%" height="100%" fill="none">
  <rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor"/>
  <path d="M5 7V5.2C5 3.44 6.34 2 8 2s3 1.44 3 3.2V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;

const OPEN_LOCK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="100%" height="100%" fill="none">
  <rect x="3" y="7" width="10" height="7" rx="2" fill="currentColor"/>
  <path d="M11 7V5.2C11 3.44 9.66 2 8 2c-1.2 0-2.2.6-2.7 1.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;

let isEnabled = false;
let isFolderInviteEnabled = false;
let currentGameflowPhase = '';
let isPartyGroupEnabled = false;
let isSidebarToggleEnabled = false;
let collapseMethod = 'crop'; // 'crop' or 'stretch' or `slide`
let friendListUnsub = null;
let champSelectPhaseUnsub = null;
let liveFriendStatuses = new Map();
let statusKeysByFriend = new Map();
let emberHookRegistered = false;
let trackedRosterMembers = new Set();
let isInChampSelect = false;
let isChampSelectAutoUncollapseActive = false;
let shouldRestoreCollapseAfterChampSelect = false;

// party state
let activeGroupState = new Map();
let previousFriendColors = new Map();
let partyColorIndex = 0;
let cachedFriendsList = new Map();

let puuidToStickyIds = new Map();
let puuidToPartyClosedStatus = new Map();

const RATIO_16_9 = 16 / 9;
const RATIO_COLLAPSED = (1280 - SIDEBAR_WIDTH) / 720;

let nativeClientHeight = 720;

function getActivePhysicalHeight() {
    const tweaksEnabled = Utils.Store.get('clientWindowTweaks', 'enabled');
    const resizeEnabled = Utils.Store.get('clientWindowTweaks', 'applyResolution');
    
    if (tweaksEnabled && resizeEnabled) {
        const customH = Number(Utils.Store.get('clientWindowTweaks', 'height'));
        if (customH > 0) return customH;
    }
    
    return nativeClientHeight;
}

function getPhysicalDimensions() {
    const h = getActivePhysicalHeight();
    const w = Math.round((window.innerWidth * h) / 720);
    return { h, w };
}

// color generation
function generatePartyColor(index) {
    const hue = Math.round((PARTY_HUE_SEED + index * PARTY_GOLDEN_ANGLE) % 360);
    return {
        solid: `hsl(${hue}, 60%, 62%)`,
        alpha: `hsla(${hue}, 60%, 62%, 0.08)`,
    };
}

function toggleFolderInvite(enabled) {
    isFolderInviteEnabled = enabled;
    Utils.Store.set('socialPanelTweaks', 'folderInvite', enabled);
}

async function inviteFolderGroup(folderName) {
    try {
        const groups = await Utils.LCU.get('/lol-chat/v1/friend-groups');
        if (!groups || !Array.isArray(groups)) return;

        const group = groups.find(g => g.name === folderName);
        if (!group) return;

        const friends = await Utils.LCU.get('/lol-chat/v1/friends');
        if (!friends || !Array.isArray(friends)) return;

        const targets = friends.filter(f => f.displayGroupId === group.id);
        if (!targets || targets.length === 0) return;

        await Utils.LCU.post('/lol-lobby/v2/lobby/invitations', targets.map(t => ({ toSummonerId: t.summonerId })));
    } catch (err) {
        Utils.Debug.error('[Snooze-SocialPanelTweaks] Failed to invite group folder:', err);
    }
}

// toggles
function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('socialPanelTweaks', 'enabled', enabled);
    syncLcuObserver();
    if (!enabled) restoreAllStatusLines();
    refreshTrackedRosterMembers();
}

function togglePartyGroup(enabled) {
    isPartyGroupEnabled = enabled;
    Utils.Store.set('socialPanelTweaks', 'partyGroup', enabled);
    syncLcuObserver();
    if (!enabled) removeAllPartyBorders();
    refreshTrackedRosterMembers();
}

function toggleSidebarFeature(enabled) {
    isSidebarToggleEnabled = enabled;
    Utils.Store.set('socialPanelTweaks', 'sidebarToggle', enabled);
    if (enabled) mountSidebarToggle();
    else unmountSidebarToggle();
}

function toggleCollapseMethod(method) {
    collapseMethod = method;
    Utils.Store.set('socialPanelTweaks', 'collapseMethod', method);

    const isCurrentlyCollapsed = document.body.classList.contains('snooze-collapsed');
    if (isCurrentlyCollapsed) {
        // Handle physical window transitions when changing settings live
        if (typeof window?.riotInvoke === 'function') {
            const dims = getPhysicalDimensions();
            const h = dims.h;
            const targetW = (method === 'crop') ? Math.round(h * RATIO_COLLAPSED) : Math.round(h * RATIO_16_9);
            window.riotInvoke({ request: JSON.stringify({ name: 'Window.ResizeTo', params: [targetW, h] }) });
        }
    }

    recreateSidebarStyles();
}

function applyCollapsedState(isCollapsed, options = {}) {
    const persist = options.persist !== false;
    const currentState = document.body.classList.contains('snooze-collapsed');
    if (currentState === isCollapsed) return;

    document.body.classList.toggle('snooze-collapsed', isCollapsed);
    if (persist) {
        Utils.Store.set('socialPanelTweaks', 'isCollapsed', isCollapsed);
    }
    if (typeof window?.riotInvoke === 'function') {
        const dims = getPhysicalDimensions();
        const h = dims.h;
        if (!h) return;
        const targetW = (collapseMethod === 'crop')
            ? Math.round(h * (isCollapsed ? RATIO_COLLAPSED : RATIO_16_9))
            : Math.round(h * RATIO_16_9);
        window.riotInvoke({ request: JSON.stringify({ name: 'Window.ResizeTo', params: [targetW, h] }) });
    }
}

function forceUncollapseForChampSelect() {
    if (!document.body.classList.contains('snooze-collapsed')) return;
    isChampSelectAutoUncollapseActive = true;
    shouldRestoreCollapseAfterChampSelect = true;
    applyCollapsedState(false, { persist: false });
}

function restoreCollapseAfterChampSelect() {
    if (!isChampSelectAutoUncollapseActive) return;
    isChampSelectAutoUncollapseActive = false;
    shouldRestoreCollapseAfterChampSelect = false;
    if (document.body.classList.contains('snooze-collapsed')) return;
    applyCollapsedState(true, { persist: false });
}

function handleGameflowPhaseChange(phase) {
    if (typeof phase !== 'string') return;
    currentGameflowPhase = phase;
    const isChamp = phase === 'ChampSelect';
    setChampSelectMode(isChamp);
    updateSidebarButtonVisibility();

    if (isChamp) {
        if (document.body.classList.contains('snooze-collapsed') && !isChampSelectAutoUncollapseActive) {
            forceUncollapseForChampSelect();
        }
        return;
    }

    if (isChampSelectAutoUncollapseActive && shouldRestoreCollapseAfterChampSelect) {
        restoreCollapseAfterChampSelect();
    }
}

// friend identity helpers
function getRiotName(friend) {
    return friend?.gameName || friend?.name || '';
}

function getStatusLookupKeys(friend) {
    const keys = new Set();
    const displayName = getRiotName(friend);

    if (displayName) keys.add(displayName);
    if (friend?.gameName && friend?.gameTag) keys.add(`${friend.gameName}#${friend.gameTag}`);
    if (friend?.puuid) keys.add(`puuid:${friend.puuid}`);

    return [...keys];
}

function getFriendCacheKey(friend) {
    if (friend?.puuid) return `puuid:${friend.puuid}`;
    if (friend?.gameName && friend?.gameTag) return `riot:${friend.gameName}#${friend.gameTag}`;
    return `name:${getRiotName(friend)}`;
}

function isTftFriend(friend) {
    const lol = friend?.lol || {};
    return lol.gameMode === 'TFT' || String(lol.gameQueueType || '').includes('TFT') || lol.iconOverride === 'companion';
}

// party & game tracking (DSU)
function rebuildPartyIndex(friendsArray) {
    activeGroupState.clear();

    const parent = new Map();
    const find = (i) => {
        if (!parent.has(i)) parent.set(i, i);
        if (parent.get(i) === i) return i;
        const p = find(parent.get(i));
        parent.set(i, p);
        return p;
    };
    const union = (i, j) => {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) parent.set(rootI, rootJ);
    };

    const partyOpenStatus = new Map();
    const puuidToKeys = new Map();
    const broadcastedPuuidToPartyId = new Map();
    const parsedPtyCache = new Map();

    // Pass 1: Parse PTYs & collect broadcasts
    friendsArray.forEach((friend) => {
        const puuid = friend?.puuid;
        if (!puuid) return;

        puuidToKeys.set(puuid, getStatusLookupKeys(friend));
        find(puuid);

        const ptyStr = friend?.lol?.pty;
        if (ptyStr) {
            try {
                const parsed = JSON.parse(ptyStr);
                parsedPtyCache.set(puuid, parsed);
                if (parsed.partyId && Array.isArray(parsed.summonerPuuids)) {
                    parsed.summonerPuuids.forEach(p => broadcastedPuuidToPartyId.set(p, `party:${parsed.partyId}`));
                }
            } catch (e) {}
        }
    });

    // Pass 2: Evaluate logic & Union nodes
    friendsArray.forEach((friend) => {
        const puuid = friend?.puuid;
        if (!puuid) return;

        const lol = friend.lol || {};
        const status = lol.gameStatus || '';
        const gameId = lol.gameId;

        const currentExplicitIds = new Set();
        let isCurrentClosed = false;
        
        if (gameId && gameId !== '0' && gameId !== '') {
            currentExplicitIds.add(`game:${gameId}`);
        }

        const parsedPty = parsedPtyCache.get(puuid);
        if (parsedPty?.partyId) {
            currentExplicitIds.add(`party:${parsedPty.partyId}`);
            if (parsedPty.isPartyOpen === false) isCurrentClosed = true;
        }

        if (broadcastedPuuidToPartyId.has(puuid)) {
            currentExplicitIds.add(broadcastedPuuidToPartyId.get(puuid));
        }

        const isActiveFlow = ['inQueue', 'championSelect', 'inGame'].includes(status);
        let stickySet = puuidToStickyIds.get(puuid) || new Set();
        let isStickyClosed = puuidToPartyClosedStatus.get(puuid) || false;

        if (isActiveFlow) {
            currentExplicitIds.forEach(id => stickySet.add(id));
            if (isCurrentClosed) isStickyClosed = true;
        } else {
            stickySet = currentExplicitIds;
            isStickyClosed = isCurrentClosed;
        }
        
        puuidToStickyIds.set(puuid, stickySet);
        puuidToPartyClosedStatus.set(puuid, isStickyClosed);

        if (isStickyClosed) partyOpenStatus.set(puuid, false);

        stickySet.forEach(id => union(puuid, id));
    });

    // Pass 3: Gather connected components
    const components = new Map();
    friendsArray.forEach((friend) => {
        const puuid = friend?.puuid;
        if (!puuid) return;
        const root = find(puuid);
        let comp = components.get(root);
        if (!comp) {
            comp = new Set();
            components.set(root, comp);
        }
        comp.add(puuid);
    });

    // Pass 4: Assign stable colors to valid groups
    const nextFriendColors = new Map();

    components.forEach((members) => {
        const realMembers = [...members].filter(id => !id.startsWith('game:') && !id.startsWith('party:'));
        if (realMembers.length < 2) return;

        let isOpen = true;
        for (const id of realMembers) {
            if (partyOpenStatus.get(id) === false) {
                isOpen = false;
                break;
            }
        }

        let assignedColorIndex = -1;
        for (const id of realMembers) {
            if (previousFriendColors.has(id)) {
                assignedColorIndex = previousFriendColors.get(id);
                break;
            }
        }
        if (assignedColorIndex === -1) {
            assignedColorIndex = partyColorIndex++;
        }

        const { solid, alpha } = generatePartyColor(assignedColorIndex);
        const groupData = { solid, alpha, isOpen, groupId: `group-${assignedColorIndex}` };

        realMembers.forEach(id => {
            nextFriendColors.set(id, assignedColorIndex);
            const keys = puuidToKeys.get(id) || [];
            keys.forEach(key => activeGroupState.set(key, groupData));
        });
    });

    previousFriendColors = nextFriendColors;
}

function getPartyStateForMember(member) {
    const name = getRosterMemberName(member);
    if (!name) return null;
    return activeGroupState.get(name) || null;
}

// party DOM update
function updatePartyBorder(member) {
    if (!isPartyGroupEnabled) {
        removePartyBorder(member);
        return;
    }

    const state = getPartyStateForMember(member);
    if (!state) {
        removePartyBorder(member);
        return;
    }

    const { solid, alpha, isOpen, groupId } = state;
    const prevGroupId = member.getAttribute(PARTY_BORDER_ATTR);
    let lockEl = member.querySelector(`[${PARTY_LOCK_ATTR}]`);
    
    const targetSvg = isOpen ? OPEN_LOCK_SVG : CLOSED_LOCK_SVG;
    const targetOpacity = isOpen ? '0.75' : '0.95';

    if (prevGroupId === groupId && lockEl) {
        if (lockEl.dataset.svg !== targetSvg) {
            lockEl.innerHTML = targetSvg;
            lockEl.dataset.svg = targetSvg;
            lockEl.style.opacity = targetOpacity;
        }
        return;
    }

    if (!member.dataset.partyStyled) {
        member.style.position = 'relative';
        member.style.transition = 'all 150ms ease';
        member.dataset.partyStyled = 'true';
    }

    if (prevGroupId !== groupId) {
        member.setAttribute(PARTY_BORDER_ATTR, groupId);
        member.style.borderRight = `3px solid ${solid}`;
        member.style.background = `linear-gradient(to left, ${alpha} 0%, transparent 90px)`;
    }

    if (!lockEl) {
        lockEl = document.createElement('span');
        lockEl.setAttribute(PARTY_LOCK_ATTR, 'true');
        Object.assign(lockEl.style, {
            position: 'absolute',
            right: '6px',
            top: '50%',
            transform: `translateY(-50%) scale(${LOCK_SCALE})`,
            transformOrigin: 'center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '14px',
            height: '14px',
            lineHeight: '0',
            pointerEvents: 'none',
            zIndex: '10',
        });
        member.appendChild(lockEl);
    }

    if (lockEl.dataset.svg !== targetSvg) {
        lockEl.innerHTML = targetSvg;
        lockEl.dataset.svg = targetSvg;
    }
    
    lockEl.style.color = solid;
    lockEl.style.opacity = targetOpacity;
}

function removePartyBorder(member) {
    if (!member.hasAttribute(PARTY_BORDER_ATTR)) return;
    member.removeAttribute(PARTY_BORDER_ATTR);
    member.removeAttribute('data-party-styled');
    member.style.borderRight = '';
    member.style.background = '';
    member.style.position = '';
    member.style.transition = '';
    const lockEl = member.querySelector(`[${PARTY_LOCK_ATTR}]`);
    if (lockEl) lockEl.remove();
}

function removeAllPartyBorders() {
    document.querySelectorAll(`[${PARTY_BORDER_ATTR}]`).forEach(removePartyBorder);
    activeGroupState.clear();
    previousFriendColors.clear();
    partyColorIndex = 0;
    puuidToStickyIds.clear();
    puuidToPartyClosedStatus.clear();
}

// activity status helpers
function getFallbackQueueName(lol) {
    const queueType = String(lol?.gameQueueType || '').trim();
    const gameMode = String(lol?.gameMode || '').trim();

    if (queueType) return queueType;
    if (gameMode === 'CHERRY') return 'Arena';
    if (gameMode === 'TFT') return 'TFT';
    if (gameMode === 'KIWI') return 'ARAM: Mayhem';
    if (gameMode === 'SWIFTPLAY') return 'Swiftplay';
    if (gameMode === 'ARAM') return 'ARAM';
    if (gameMode && gameMode !== 'CLASSIC') return gameMode;
    return 'League';
}

function buildActivity(friend) {
    const lol = friend?.lol || {};
    const gameId = Number(lol.gameId || 0);
    const startedAt = Number(lol.timeStamp || 0);
    const gameStatus = lol.gameStatus;

    if (!gameId || !startedAt || !gameStatus || String(gameStatus).toLowerCase() !== 'ingame') return null;

    return {
        displayName: getRiotName(friend),
        startedAt,
        queueId: Number(lol.queueId || 0),
        gameMode: String(lol.gameMode || ''),
        gameQueueType: String(lol.gameQueueType || ''),
        fallbackName: getFallbackQueueName(lol),
        isTft: isTftFriend(friend),
    };
}

function setFriendActivity(friend) {
    const ownerKey = getFriendCacheKey(friend);
    const oldKeys = statusKeysByFriend.get(ownerKey) || [];
    oldKeys.forEach((key) => liveFriendStatuses.delete(key));
    statusKeysByFriend.delete(ownerKey);

    const activity = buildActivity(friend);
    if (!activity) return;

    const keys = getStatusLookupKeys(friend);
    keys.forEach((key) => liveFriendStatuses.set(key, activity));
    statusKeysByFriend.set(ownerKey, keys);
}

function rebuildStatusIndex(friends) {
    if (friends?.friends && Array.isArray(friends.friends)) {
        rebuildStatusIndex(friends.friends);
        return;
    }

    if (!Array.isArray(friends)) {
        if (friends && typeof friends === 'object') {
            if (friends.puuid) cachedFriendsList.set(friends.puuid, friends);
            setFriendActivity(friends);
            rebuildPartyIndex(Array.from(cachedFriendsList.values()));
            refreshTrackedRosterMembers();
        }
        return;
    }

    cachedFriendsList.clear();
    const next = new Map();
    const nextKeysByFriend = new Map();
    
    friends.forEach((friend) => {
        if (friend.puuid) cachedFriendsList.set(friend.puuid, friend);

        const activity = buildActivity(friend);
        if (!activity) return;

        const keys = getStatusLookupKeys(friend);
        keys.forEach((key) => next.set(key, activity));
        nextKeysByFriend.set(getFriendCacheKey(friend), keys);
    });

    liveFriendStatuses = next;
    statusKeysByFriend = nextKeysByFriend;
    rebuildPartyIndex(friends);
    refreshTrackedRosterMembers();
}

function getKnownQueueLabel(activity) {
    const queueId = Number(activity.queueId || 0);
    const queueType = String(activity.gameQueueType || '').toUpperCase();
    const mode = String(activity.gameMode || '').toUpperCase();

    if ([1700, 1710, 1750].includes(queueId) || queueType === 'CHERRY' || mode === 'CHERRY') return 'Arena';
    if (queueId === 2400 || queueType === 'KIWI' || mode === 'KIWI') return 'ARAM: Mayhem';
    if (queueId === 420 || queueType === 'RANKED_SOLO_5X5') return 'Solo/Duo';
    if (queueId === 440 || queueType === 'RANKED_FLEX_SR') return 'Flex';
    if (queueId === 450 || queueType === 'ARAM_UNRANKED_5X5' || mode === 'ARAM') return 'ARAM';
    if (queueId === 480 || queueType === 'SWIFTPLAY' || mode === 'SWIFTPLAY') return 'Swiftplay';
    if (queueId === 490 || queueType === 'QUICKPLAY') return 'Quickplay';
    if (queueId === 400 || queueType === 'NORMAL_DRAFT') return 'Draft';
    if (queueId === 430 || queueType === 'NORMAL_BLIND') return 'Blind';
    if ([1090, 1100, 1130, 1160].includes(queueId) || queueType.includes('TFT') || mode === 'TFT') {
        if (queueType.includes('DOUBLE_UP') || queueId === 1160) return 'TFT Double Up';
        if (queueType.includes('TURBO') || queueType.includes('HYPER') || queueId === 1130) return 'TFT Hyper Roll';
        if (queueType.includes('RANKED') || queueId === 1100) return 'TFT Ranked';
        return 'TFT';
    }
    return '';
}

function abbreviateQueueLabel(label, activity) {
    const text = String(label || 'In Game').trim();
    const lower = text.toLowerCase();

    if (activity.isTft || lower.includes('teamfight tactics')) {
        if (lower.includes('double up')) return 'TFT Double Up';
        if (lower.includes('hyper roll')) return 'TFT Hyper Roll';
        if (lower.includes('rank')) return 'TFT Ranked';
        return 'TFT';
    }

    if (lower === 'aram_unranked_5x5') return 'ARAM';
    if (lower === 'ranked_solo_5x5') return 'Solo/Duo';
    if (lower === 'ranked_flex_sr') return 'Flex';
    if (lower === 'ranked_tft') return 'TFT Ranked';
    if (lower === 'swiftplay') return 'Swiftplay';
    if (lower === 'cherry') return 'Arena';
    if (lower === 'kiwi') return 'ARAM: Mayhem';
    if (lower === 'league') return 'League';
    if (lower.includes('ranked solo')) return 'Solo/Duo';
    if (lower.includes('ranked flex')) return 'Flex';
    if (lower.includes('normal draft')) return 'Draft';
    if (lower.includes('normal blind')) return 'Blind';
    if (lower.includes('quickplay')) return 'Quickplay';
    if (lower.includes('aram')) return text.replace(/^aram:?\s*/i, 'ARAM: ');
    if (lower.includes('arena')) return text.replace(/^arena:?\s*/i, 'Arena ');

    return text.replace(/^5v5\s+/i, '').replace(/^ranked\s+/i, '').replace(/\s+games?$/i, '');
}

function getQueueLabel(activity) {
    const knownQueue = getKnownQueueLabel(activity);
    if (knownQueue) return knownQueue;

    let label = activity.fallbackName;
    if (activity.queueId > 0) {
        const queue = Utils.GameData.Assets.queues.find((item) => Number(item.id) === activity.queueId);
        if (queue?.name) label = queue.name;
    }
    return abbreviateQueueLabel(label, activity);
}

function formatElapsed(startedAt) {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const minutes = Math.max(1, Math.floor(elapsedMs / 60000));
    return `${minutes}m`;
}

function formatFriendLine(activity) {
    return `${getQueueLabel(activity)} - ${formatElapsed(activity.startedAt)}`;
}

// roster member DOM
function getRosterMemberName(member) {
    return member.querySelector('.member-name')?.textContent?.trim() || '';
}

function resolveRosterMember(node) {
    if (!node) return null;
    // Ember hook component node
    if (node.tagName === 'LOL-SOCIAL-ROSTER-MEMBER' || node.classList?.contains('lol-social-roster-member')) {
        return node;
    }
    return node.closest?.('lol-social-roster-member') || null;
}

function findActivityForMember(member) {
    const name = getRosterMemberName(member);
    if (!name) return null;
    return liveFriendStatuses.get(name) || null;
}

function restoreStatusLine(statusEl) {
    if (!statusEl.hasAttribute(ACTIVE_ATTR)) return;

    const originalText = statusEl.getAttribute(ORIGINAL_ATTR);
    if (originalText != null) statusEl.innerText = originalText;

    const originalTitle = statusEl.getAttribute(ORIGINAL_TITLE_ATTR);
    if (originalTitle != null) statusEl.setAttribute('title', originalTitle);
    else statusEl.removeAttribute('title');

    const originalStyle = statusEl.getAttribute(ORIGINAL_STYLE_ATTR);
    if (originalStyle != null) statusEl.setAttribute('style', originalStyle);
    else statusEl.removeAttribute('style');

    statusEl.removeAttribute(ACTIVE_ATTR);
    statusEl.removeAttribute(ORIGINAL_ATTR);
    statusEl.removeAttribute(ORIGINAL_TITLE_ATTR);
    statusEl.removeAttribute(ORIGINAL_STYLE_ATTR);
    statusEl.removeAttribute(CURRENT_TEXT_ATTR);
}

function updateRosterMember(member) {
    const statusEl = member.querySelector('span.status-message');
    if (!statusEl) return;

    if (!isEnabled) {
        restoreStatusLine(statusEl);
    } else {
        const activity = findActivityForMember(member);
        if (!activity) {
            restoreStatusLine(statusEl);
        } else {
            if (!statusEl.hasAttribute(ACTIVE_ATTR)) {
                statusEl.setAttribute(ORIGINAL_ATTR, statusEl.innerText);
                if (statusEl.hasAttribute('title')) statusEl.setAttribute(ORIGINAL_TITLE_ATTR, statusEl.getAttribute('title'));
                if (statusEl.hasAttribute('style')) statusEl.setAttribute(ORIGINAL_STYLE_ATTR, statusEl.getAttribute('style'));
                statusEl.setAttribute(ACTIVE_ATTR, 'true');
            }

            const statusText = formatFriendLine(activity);
            if (statusEl.getAttribute(CURRENT_TEXT_ATTR) !== statusText) {
                Object.assign(statusEl.style, {
                    display: 'block',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: '100%',
                });
                statusEl.title = statusText;
                statusEl.innerText = statusText;
                statusEl.setAttribute(CURRENT_TEXT_ATTR, statusText);
            }
        }
    }

    updatePartyBorder(member);
}

function refreshTrackedRosterMembers() {
    trackedRosterMembers.forEach((member) => {
        if (!member.isConnected) {
            trackedRosterMembers.delete(member);
            return;
        }
        updateRosterMember(member);
    });
}

function refreshRosterMemberElement(element) {
    if (!element) return;
    const member = resolveRosterMember(element);
    if (member) {
        trackedRosterMembers.add(member);
        updateRosterMember(member);
    }
}

function restoreAllStatusLines() {
    document.querySelectorAll?.(`[${ACTIVE_ATTR}]`).forEach(restoreStatusLine);
}

// Decoupled LCU Observer Sync
function syncLcuObserver() {
    const needsObserver = isEnabled || isPartyGroupEnabled;
    if (needsObserver && !friendListUnsub) {
        if (Utils.LCU && Utils.LCU.observe) {
            Utils.GameData.Assets.init?.();
            friendListUnsub = Utils.LCU.observe(FRIENDS_URI, (event) => {
                rebuildStatusIndex(event?.data);
            });
            Utils.LCU.get(FRIENDS_URI)
                .then(rebuildStatusIndex)
                .catch(() => {});
        }
    } else if (!needsObserver && friendListUnsub) {
        friendListUnsub();
        friendListUnsub = null;
        liveFriendStatuses.clear();
        statusKeysByFriend.clear();
        cachedFriendsList.clear();
        previousFriendColors.clear();
        partyColorIndex = 0;
        puuidToStickyIds.clear();
        puuidToPartyClosedStatus.clear();
        restoreAllStatusLines();
        removeAllPartyBorders();
    }
}

// Dynamic stylesheet generation depending on active method ('crop', 'stretch', or 'slide')
function recreateSidebarStyles() {
    let style = document.getElementById('snooze-sidebar-toggle-style');
    if (!style) {
        style = document.createElement('style');
        style.id = 'snooze-sidebar-toggle-style';
        document.head.appendChild(style);
    }

    const SCALE_X = 1280 / (1280 - SIDEBAR_WIDTH);

    let methodStyles = '';
    if (collapseMethod === 'crop') {
        methodStyles = `
            /* Crop Method Styles */
            .snooze-collapsed .rcp-fe-viewport-sidebar { 
                opacity: 0 !important; 
                pointer-events: none !important; 
            }
            .snooze-collapsed #rcp-fe-viewport-root {
                width: 1280px !important;
                min-width: 1280px !important;
                max-width: 1280px !important;
                height: 720px !important;
                min-height: 720px !important;
                max-height: 720px !important;
            }
            .snooze-collapsed .riotclient-app-controls {
                display: grid !important;
                grid-template-columns: auto auto !important;
                gap: 4px !important;
                position: absolute !important;
                right: ${SIDEBAR_WIDTH - 10}px !important;
                left: auto !important;
                top: -1px !important;
                z-index: 1 !important;
                pointer-events: auto !important;
                justify-items: end !important;
                justify-content: end !important;
                align-items: center !important;
            }
            .snooze-collapsed #snooze-sidebar-zone {
                right: 0;
            }
            /* Position individual buttons and reset native offsets in collapsed mode */
            .snooze-collapsed .app-controls-button {
                position: relative !important;
                top: 0 !important;
                bottom: auto !important;
                left: auto !important;
                right: auto !important;
                margin: 0 !important;
            }
            .snooze-collapsed .app-controls-hide {
                grid-column: 1 !important;
                grid-row: 1 !important;
                top: -5px !important; /* Shifted up by 4px to match horizontal center of Close (X) */
            }
            .snooze-collapsed .app-controls-close {
                grid-column: 2 !important;
                grid-row: 1 !important;
            }
            .snooze-collapsed .app-controls-settings {
                grid-column: 1 / span 2 !important;
                grid-row: 2 !important;
                justify-self: end !important;
            }
            .snooze-collapsed .app-controls-support {
                grid-column: 1 / span 2 !important;
                grid-row: 3 !important;
                justify-self: end !important;
            }
        `;
    } else if (collapseMethod === 'stretch') {
        methodStyles = `
            /* Stretch Method Styles */
            .snooze-collapsed .rcp-fe-viewport-sidebar { 
                opacity: 0 !important; 
                pointer-events: none !important; 
            }
            .snooze-collapsed .rcp-fe-viewport-main, 
            .snooze-collapsed .rcp-fe-viewport-persistent,
            .snooze-collapsed .rcp-fe-viewport-overlay {
                transform-origin: left top !important;
                transform: scaleX(${SCALE_X}) !important;
            }
            .snooze-collapsed .rcp-fe-viewport-persistent, 
            .snooze-collapsed .rcp-fe-viewport-overlay { 
                right: 0 !important; 
                width: ${1280 - SIDEBAR_WIDTH}px !important;
            }
            .snooze-collapsed .riotclient-app-controls {
                display: grid !important;
                grid-template-columns: auto auto !important;
                gap: 4px !important;
                left: 10px !important;
                position: relative !important;
                z-index: 1 !important;
                pointer-events: auto !important;
                justify-items: end !important;
                justify-content: end !important;
                align-items: center !important;
            }
            .snooze-collapsed #snooze-sidebar-zone {
                right: 6px;
            }
            /* Position individual buttons and reset native offsets in collapsed mode */
            .snooze-collapsed .app-controls-button {
                position: relative !important;
                top: 0 !important;
                bottom: auto !important;
                left: auto !important;
                right: auto !important;
                margin: 0 !important;
            }
            .snooze-collapsed .app-controls-hide {
                grid-column: 1 !important;
                grid-row: 1 !important;
                top: -5px !important; /* Shifted up by 4px to match horizontal center of Close (X) */
            }
            .snooze-collapsed .app-controls-close {
                grid-column: 2 !important;
                grid-row: 1 !important;
            }
            .snooze-collapsed .app-controls-settings {
                grid-column: 1 / span 2 !important;
                grid-row: 2 !important;
                justify-self: end !important;
            }
            .snooze-collapsed .app-controls-support {
                grid-column: 1 / span 2 !important;
                grid-row: 3 !important;
                justify-self: end !important;
            }
        `;
    } else {
        methodStyles = `
            /* Slide Method Styles */
            .snooze-collapsed .lol-social-lower-pane-container,
            .snooze-collapsed lol-parties-game-info-panel,
            .snooze-collapsed .tournaments-persistent-panel,
            .snooze-collapsed .clash-social-persistent.ember-view,
            .snooze-collapsed .alpha-version-panel {
                transform: translateX(${SIDEBAR_WIDTH}px) !important;
            }

            .lol-social-lower-pane-container,
            lol-parties-game-info-panel,
            .tournaments-persistent-panel,
            .clash-social-persistent.ember-view,
            .alpha-version-panel {
                transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) !important;
            }

            .snooze-collapsed div[data-screen-name=social] > .social-plugin-home > .ember-view {
                height: 0% !important;
            }

            .snooze-collapsed .collections-application,
            .snooze-collapsed .parties-game-type-select-wrapper.ember-view,
            .snooze-collapsed .parties-custom-game-setup.ember-view,
            .snooze-collapsed .custom-game-list.ember-view,
            .snooze-collapsed .v2-footer-component.ember-view,
            .snooze-collapsed .parties-point-eligibility-custom.ember-view,
            .snooze-collapsed .custom-game-teams.ember-view,
            .snooze-collapsed .arrow-footer.ember-view > div,
            .snooze-collapsed .parties-invite-dropzone,
            .snooze-collapsed .party-members-container,
            .snooze-collapsed .tft-cards-container,
            .snooze-collapsed .tft-footer-container.ember-view,
            .snooze-collapsed .multiteam-lobby-root__scrollable-wrapper,
            .snooze-collapsed .career-postgame-progression-component, 
            .snooze-collapsed .postgame-root-component .postgame-footer,
            .snooze-collapsed .career-postgame-sub-navigation-component,
            .snooze-collapsed .postgame-root-component .postgame-progression-lottie-outline,
            .snooze-collapsed .scoreboard-root-content-container,
            .snooze-collapsed .emote-wheel-wrapper-v2,
            .snooze-collapsed .emote-root-component .nav-container,
            .snooze-collapsed .emote-delete-slot,
            .snooze-collapsed .emote-reaction-wrapper {
                transform: translateX(${SIDEBAR_WIDTH / 2}px) !important;
            }

            .collections-application,
            .parties-game-type-select-wrapper.ember-view,
            .parties-custom-game-setup.ember-view,
            .custom-game-list.ember-view,
            .v2-footer-component.ember-view,
            .parties-point-eligibility-custom.ember-view,
            .custom-game-teams.ember-view,
            .arrow-footer.ember-view > div,
            .parties-invite-dropzone,
            .party-members-container,
            .tft-cards-container,
            .tft-footer-container.ember-view,
            .multiteam-lobby-root__scrollable-wrapper,
            .career-postgame-progression-component, 
            .postgame-root-component .postgame-footer,
            .career-postgame-sub-navigation-component,
            .postgame-root-component .postgame-progression-lottie-outline,
            .scoreboard-root-content-container,
            .emote-wheel-wrapper-v2,
            .emote-root-component .nav-container,
            .emote-delete-slot,
            .emote-reaction-wrapper {
                transition: transform 0.25s cubic-bezier(0.2, 0.8, 0.2, 1) !important;
            }

            .snooze-collapsed #snooze-sidebar-zone {
                right: 15px; /* Restored back to narrow CSS hot-border zone */
            }
        `;
    }

    style.innerHTML = `
        .rcp-fe-viewport-sidebar { 
            transition: opacity 0.1s ease; 
        }

        ${methodStyles}
		
        /* Zone parameters made thin (15px wide) so it does not block clickable elements behind it */
        #snooze-sidebar-zone {
            position: fixed;
            top: 50%;
            transform: translateY(-50%);
            height: 300px;
            right: ${SIDEBAR_WIDTH}px;
            width: 30px; /* narrow trigger zone */
            z-index: 18999;
            pointer-events: auto;
            background: transparent;
            transition: right 0.25s ease !important;
        }

        .snooze-champselect-mode #snooze-sidebar-zone {
            display: none;
            pointer-events: none;
        }

        #snooze-sidebar-toggle {
            position: absolute;
            top: 50%;
            right: 10px;
            transform: translateY(-50%) scale(0.95);
            width: 30px;
            height: 30px;
            background: rgba(20, 20, 20, 0.85);
            backdrop-filter: blur(6px);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            box-shadow: 0 4px 12px rgba(0,0,0,0.4);
            opacity: 0;
            pointer-events: auto; /* Click-interactivity remains active directly on the button */
            transition: all 0.25s ease;
        }

        #snooze-sidebar-zone:hover #snooze-sidebar-toggle {
            opacity: 1;
            transform: translateY(-50%) scale(1);
            pointer-events: auto;
        }

        #snooze-sidebar-toggle:hover {
            background: rgba(35, 35, 35, 0.9);
            transform: translateY(-50%) scale(1.1);
        }

        #snooze-sidebar-toggle svg {
            width: 20px;
            height: 20px;
            stroke: #e0e0e0;
            stroke-width: 2.5;
            stroke-linecap: round;
            stroke-linejoin: round;
            transition: transform 0.3s ease;
            ${collapseMethod === 'crop' ? 'transform: rotate(180deg);' : ''}
        }

        .snooze-collapsed #snooze-sidebar-toggle svg { transform: rotate(${collapseMethod === 'crop' ? '0deg' : '180deg'}); }
    `;
}function setChampSelectMode(active) {
    if (isInChampSelect === active) return;
    isInChampSelect = active;
    document.body.classList.toggle('snooze-champselect-mode', active);
}

function updateSidebarButtonVisibility() {
    const zone = document.getElementById('snooze-sidebar-zone');
    if (!zone) return;
    zone.style.display = isInChampSelect ? 'none' : '';
    zone.style.pointerEvents = isInChampSelect ? 'none' : '';
}

// sidebar toggle
function mountSidebarToggle() {
    recreateSidebarStyles();

    const zone = document.createElement('div');
    zone.id = 'snooze-sidebar-zone';

    const btn = document.createElement('div');
    btn.id = 'snooze-sidebar-toggle';
    btn.innerHTML = `<svg fill="none" viewBox="0 0 24 24"><path d="M9 18l6-6-6-6"/></svg>`;
    zone.appendChild(btn);
    document.body.appendChild(zone);

    const enforceWindowSize = () => {
        if (typeof window?.riotInvoke !== 'function') return;
        const dims = getPhysicalDimensions();
        const h = dims.h;
        const w = dims.w;
        if (!h || !w) return;

        const currentRatio = w / h;
        const isCurrentlyCollapsed = document.body.classList.contains('snooze-collapsed');

        if (collapseMethod === 'crop') {
            if (isCurrentlyCollapsed && Math.abs(currentRatio - RATIO_16_9) < 0.05) {
                window.riotInvoke({ request: JSON.stringify({ name: 'Window.ResizeTo', params: [Math.round(h * RATIO_COLLAPSED), h] }) });
            } else if (!isCurrentlyCollapsed && Math.abs(currentRatio - RATIO_COLLAPSED) < 0.05) {
                window.riotInvoke({ request: JSON.stringify({ name: 'Window.ResizeTo', params: [Math.round(h * RATIO_16_9), h] }) });
            }
        } else {
            if (Math.abs(currentRatio - RATIO_16_9) > 0.05) {
                window.riotInvoke({ request: JSON.stringify({ name: 'Window.ResizeTo', params: [Math.round(h * RATIO_16_9), h] }) });
            }
        }
    };

    const isCollapsed = Utils.Store.get('socialPanelTweaks', 'isCollapsed') || false;
    if (isCollapsed) setTimeout(enforceWindowSize, 1000);

    if (!window.__snoozeSidebarResizeListener) {
        window.__snoozeSidebarResizeListener = true;
        window.addEventListener('resize', enforceWindowSize);
    }

    if (!window.__snoozeSidebarListenerAdded) {
        window.__snoozeSidebarListenerAdded = true;
        document.addEventListener('mousedown', (e) => {
            const toggleBtn = e.target.closest('#snooze-sidebar-toggle');
            if (!toggleBtn || e.button !== 0) return;

            e.preventDefault();
            e.stopPropagation();

            const isNowCollapsed = !document.body.classList.contains('snooze-collapsed');
            applyCollapsedState(isNowCollapsed, { persist: true });
            if (isChampSelectAutoUncollapseActive) {
                isChampSelectAutoUncollapseActive = false;
                shouldRestoreCollapseAfterChampSelect = false;
            }

            if (typeof window?.riotInvoke === 'function') {
                const dims = getPhysicalDimensions();
                const h = dims.h;
                let targetW;
                if (collapseMethod === 'crop') {
                    targetW = isNowCollapsed ? Math.round(h * RATIO_COLLAPSED) : Math.round(h * RATIO_16_9);
                } else {
                    targetW = Math.round(h * RATIO_16_9);
                }
                window.riotInvoke({ request: JSON.stringify({ name: 'Window.ResizeTo', params: [targetW, h] }) });
            }
        }, { capture: true });
    }
}

function unmountSidebarToggle() {
    document.getElementById('snooze-sidebar-toggle-style')?.remove();
    document.getElementById('snooze-sidebar-zone')?.remove();
    document.body.classList.remove('snooze-collapsed');

    if (typeof champSelectPhaseUnsub === 'function') {
        champSelectPhaseUnsub();
        champSelectPhaseUnsub = null;
    }
    window.__snoozeSidebarGameflowListenerAdded = false;
    isChampSelectAutoUncollapseActive = false;
    shouldRestoreCollapseAfterChampSelect = false;
}

// init / load
export function init(context) {
    Utils.Settings.inject(context, {
        name: 'social-panel-tweaks-settings',
        titleKey: 'snooze_social_panel_tweaks',
        titleName: 'Social Panel Tweaks',
        capitalTitleKey: 'snooze_social_panel_tweaks_capital',
        capitalTitleName: 'SOCIAL PANEL TWEAKS',
        class: 'social-panel-tweaks-settings',
    });

    isEnabled = Utils.Store.get('socialPanelTweaks', 'enabled') || false;
    isPartyGroupEnabled = Utils.Store.get('socialPanelTweaks', 'partyGroup') || false;
    isSidebarToggleEnabled = Utils.Store.get('socialPanelTweaks', 'sidebarToggle') || false;
    collapseMethod = Utils.Store.get('socialPanelTweaks', 'collapseMethod') || 'crop';
    isFolderInviteEnabled = Utils.Store.get('socialPanelTweaks', 'folderInvite') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'socialPanelTweaks',
            name: 'Social Panel Tweaks',
            description: 'Enhances the social panel with queue labels, in-game timers, connected party status visuals, and a collapsible sidebar.',
            settings: [
                {
                    type: 'toggle',
                    id: 'sm:socialPanelTweaks',
                    label: 'Enable Better Friends Status',
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val),
                },
                {
                    type: 'toggle',
                    id: 'sm:sidebarToggle',
                    label: 'Enable Sidebar Collapse Toggle',
                    value: isSidebarToggleEnabled,
                    onChange: (val) => toggleSidebarFeature(val),
                },
                {
                    type: 'toggle',
                    id: 'sm:partyGroup',
                    label: 'Highlight Friends In The Same Lobby',
                    value: isPartyGroupEnabled,
                    onChange: (val) => togglePartyGroup(val),
                },
                {
                    type: 'toggle',
                    id: 'sm:folderInvite',
                    label: 'Enable Group Folder Invite Option',
                    value: isFolderInviteEnabled,
                    onChange: (val) => toggleFolderInvite(val),
                },
                {
                    type: 'select',
                    id: 'sm:collapseMethod',
                    label: 'Collapse Method',
                    value: collapseMethod,
                    options: [
                        { value: 'crop', label: 'Crop (Resize Window)' },
                        { value: 'stretch', label: 'Stretch (Scale Layout)' },
                        { value: 'slide', label: 'Slide (Shift Layout)' }
                    ],
                    onChange: (val) => toggleCollapseMethod(val),
                },
                {
                    type: 'custom',
                    render: (row) => {
                        row.style.background = 'transparent';
                        row.style.border = 'none';
                        row.style.padding = '0 0 4px';
                        const note = document.createElement('div');
                        Object.assign(note.style, {
                            padding: '10px',
                            background: 'rgba(0,0,0,0.2)',
                            border: '1px solid rgba(255,255,255,0.05)',
                            borderRadius: '4px',
                            color: '#8a9aaa',
                            fontSize: '12px',
                            lineHeight: '1.5'
                        });
                        note.innerHTML = '<span style="color:#c8aa6e;font-weight:600;">Slide mode note:</span> Unlike Crop and Stretch, this method shifts interface elements without resizing the window — the original client background stays visible in the uncovered sidebar area. For the cleanest look, pair it with a custom theme that removes or replaces that background.';
                        row.appendChild(note);
                    }
                }
            ],
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.social-panel-tweaks-settings', (plugin) => {
            plugin.innerHTML = '';

            const createFlatCheckbox = (labelText, initialValue, onChange) => {
                const row = Utils.Settings.createToggleRow(labelText, initialValue, onChange);
                row.style.marginTop = '10px';
                return row;
            };

            plugin.appendChild(createFlatCheckbox('Enable Better Friends Status', isEnabled, toggleFeature));
            plugin.appendChild(createFlatCheckbox('Enable Sidebar Collapse Toggle', isSidebarToggleEnabled, toggleSidebarFeature));
            plugin.appendChild(createFlatCheckbox('Highlight friends in the same lobby', isPartyGroupEnabled, togglePartyGroup));
            plugin.appendChild(createFlatCheckbox('Enable Group Folder Invite Option', isFolderInviteEnabled, toggleFolderInvite));

            // Flat Select for STANDALONE mode
            const methodRow = document.createElement('div');
            methodRow.classList.add('plugins-settings-row');
            methodRow.style.marginTop = '10px';
            methodRow.style.display = 'flex';
            methodRow.style.justifyContent = 'space-between';
            methodRow.style.alignItems = 'center';

            const selectLabel = document.createElement('label');
            selectLabel.innerHTML = 'Collapse Method';
            selectLabel.style.color = '#a09b8c';
            selectLabel.style.fontSize = '12px';

            const select = document.createElement('select');
            select.style.background = '#111';
            select.style.color = '#f0e6d2';
            select.style.border = '1px solid #3e2e13';
            select.style.padding = '4px 8px';
            select.style.outline = 'none';

            const optCrop = document.createElement('option');
            optCrop.value = 'crop';
            optCrop.textContent = 'Crop (Resize Window)';
            select.appendChild(optCrop);

            const optStretch = document.createElement('option');
            optStretch.value = 'stretch';
            optStretch.textContent = 'Stretch (Scale Layout)';
            select.appendChild(optStretch);

            const optSlide = document.createElement('option');
            optSlide.value = 'slide';
            optSlide.textContent = 'Slide (Shift Layout)';
            select.appendChild(optSlide);

            select.value = collapseMethod;
            select.addEventListener('change', () => {
                toggleCollapseMethod(select.value);
            });

            methodRow.appendChild(selectLabel);
            methodRow.appendChild(select);
            plugin.appendChild(methodRow);

            const slideNoteRow = document.createElement('div');
            slideNoteRow.classList.add('plugins-settings-row');
            Object.assign(slideNoteRow.style, {
                display: 'block',
                marginTop: '10px',
                padding: '10px',
                background: 'rgba(0,0,0,0.2)',
                border: '1px solid rgba(255,255,255,0.05)',
                borderRadius: '4px',
                color: '#8a9aaa',
                fontSize: '12px',
                lineHeight: '1.5'
            });
            slideNoteRow.innerHTML = '<span style="color:#c8aa6e;font-weight:600;">Slide mode note:</span> Unlike Crop and Stretch, this method shifts interface elements without resizing the window — the original client background stays visible in the uncovered sidebar area. For the cleanest look, pair it with a custom theme that removes or replaces that background.';
            plugin.appendChild(slideNoteRow);
        });
    }
}

export function installEmberHook() {
    if (emberHookRegistered) return;
    emberHookRegistered = true;

    Utils.Hooks.Ember.registerRule({
        name: 'social-panel-tweaks-roster-member',
        matcher: 'lol-social-roster-member',
        mixin() {
            return {
                /*
				// Commented out since these seems redundent. keeping for keeps sake
                didInsertElement() {
                    this._super(...arguments);
                    refreshRosterMemberElement(this.element);
                },
                didUpdate() {
                    this._super(...arguments);
                    refreshRosterMemberElement(this.element);
                },
                */
                didRender() {
                    this._super(...arguments);
                    refreshRosterMemberElement(this.element);
                },
                willDestroyElement() {
                    const element = this.element;
                    if (element) {
                        const member = resolveRosterMember(element);
                        if (member) {
                            trackedRosterMembers.delete(member);
                            removePartyBorder(member);
                        }
                        element.querySelectorAll?.(`[${ACTIVE_ATTR}]`).forEach(restoreStatusLine);
                    }
                    this._super(...arguments);
                },
            };
        },
    });
    Utils.Hooks.Ember.registerRule({
        name: 'social-panel-tweaks-roster-group',
        matcher: 'lol-social-roster-group',
        mixin() {
            return {
                contextMenu(event) {
                    if (isFolderInviteEnabled) {
                        const group = this.get ? this.get('group') : this.group;
                        const isMetaGroup = group?.isMetaGroup || (this.element && this.element.querySelector('.group.meta'));
                        
                        if (currentGameflowPhase === 'Lobby' && !isMetaGroup) {
                            const tryInject = () => {
                                const menuEl = document.querySelector('lol-uikit-context-menu');
                                if (!menuEl) {
                                    requestAnimationFrame(tryInject);
                                    return;
                                }

                                const root = menuEl.shadowRoot;
                                if (!root) {
                                    requestAnimationFrame(tryInject);
                                    return;
                                }

                                const container = root.querySelector('.context-menu, .context-menu-root');
                                if (!container) {
                                    requestAnimationFrame(tryInject);
                                    return;
                                }

                                const existing = root.querySelector('[data-snooze-folder-invite-btn]');
                                if (existing) {
                                    existing.remove();
                                }

                                const customItem = document.createElement('div');
                                customItem.className = 'menu-item';
                                customItem.setAttribute('data-snooze-folder-invite-btn', 'true');
                                customItem.textContent = 'Invite Folder';

                                customItem.addEventListener('click', async (e) => {
                                    e.preventDefault();
                                    e.stopPropagation();

                                    if (typeof menuEl.close === 'function') {
                                        menuEl.close();
                                    }

                                    const name = group?.name || this.get?.('group.name') || this.get?.('name') || this.name;
                                    if (name) {
                                        await inviteFolderGroup(name);
                                    }
                                });

                                container.prepend(customItem);
                            };

                            requestAnimationFrame(tryInject);
                        }
                    }
                    this._super(...arguments);
                }
            };
        }
    });
}

export function load() {
    installEmberHook();
    syncLcuObserver();

    // Passively track the native client height via settings observer
    if (Utils.LCU && Utils.LCU.observe) {
        Utils.LCU.observe('/lol-settings/v1/local/video', (event) => {
            if (event?.data?.Height > 0) {
                nativeClientHeight = event.data.Height;
            }
        });
        Utils.LCU.get('/lol-settings/v1/local/video').then(settings => {
            if (settings?.data?.Height > 0) {
                nativeClientHeight = settings.data.Height;
            }
        }).catch(() => {});
    }

    if (isSidebarToggleEnabled) mountSidebarToggle();
    if (!window.__snoozeGameflowPhaseListenerAdded) {
        window.__snoozeGameflowPhaseListenerAdded = true;
        if (Utils.LCU && Utils.LCU.observe) {
            champSelectPhaseUnsub = Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (event) => {
                handleGameflowPhaseChange(event?.data);
            });
            Utils.LCU.get('/lol-gameflow/v1/gameflow-phase').then(handleGameflowPhaseChange).catch(() => {});
        }
    }
}