/**
 * @name Snooze-AutoLockChampion
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Auto-locks priority champions during champ select with role-specific picks and bans.
 * @link https://github.com/ReformedDoge
 */
import Utils, { t } from './generalUtils.js';

let isEnabled = false;
let autoLockSessionUnsub = null;
let lastAutoLockKeys = new Map();
let actionActiveStartTimes = new Map(); // actionId -> timestamp when it first became active
let actionHoverStartTimes = new Map(); // actionId -> timestamp when first seen (includes PLANNING), for hover delay only
let lastBanDebugKey = '';
let bannableChampionSet = null;
let bannableChampUnsub = null;
let pickableChampionSet = null;
let pickableChampUnsub = null;

let currentSummonerId = null;
let currentPuuid = null;
let emberTimerMs = null;
let lastSessionData = null;
let lastSeenActionChampionIds = null; // Map<actionId, {championId, phase}> for change detection
let lastSeenPhase = undefined;
let lastActiveActionIds = new Set(); // action IDs that were active in the last processChampSelectSession call
let actionInitialTimers = new Map(); // actionId -> emberTimerMs value when action first became active (for ceremony-agnostic elapsed measurement)
let emberTimerCrossed = false;
let inSetTimeout = false; // true when processChampSelectSession was triggered by setTimeout, not a WS push
let lastTotalTimeInPhase = null; // previous totalTimeInPhase for detecting ceremony padding
let lastProcessPhase = null; // phase from the previous processChampSelectSession call
let ceremonyPadding = 0; // extra ms added to totalTimeInPhase mid-phase (e.g. ban→pick ceremony)
let unregisterPanic = null;
let panicActive = false;
let teammateIntents = new Set(); // championPickIntent > 0 from teammates
const pluginSetChampionIds = new Map(); // actionId → championId we last set via PATCH (manual pick detection)
let manuallyOverriddenActionIds = new Set(); // action IDs the user manually changed (per-action override tracking)
let pendingTimers = new Set(); // setTimeout IDs for cleanup on unmount

const MAX_PRIORITY_CHAMPS = 3;
const PICK_PRIORITY_KEY = 'pickIds';
const BAN_PRIORITY_KEY = 'banIds';
const LOCK_MODE_KEY = 'lockMode';
const LOCK_TIME_KEY = 'lockTime';
const HOVER_DELAY_KEY = 'hoverDelay';
const LOCK_TIME_MIN = 0;
const LOCK_TIME_MAX = 60;
const HOVER_DELAY_DEFAULT = 5;

function fetchCurrentSummoner() {
    if (currentSummonerId && currentPuuid) return;
    if (!Utils.LCU) return;
    Utils.LCU.get('/lol-summoner/v1/current-summoner').then(me => {
        if (me) {
            currentSummonerId = me.summonerId;
            currentPuuid = me.puuid;
        }
    }).catch(() => {});
}

function getLockSettings() {
    const mode = Utils.Store.get('autoLockChampion', LOCK_MODE_KEY) === 'after' ? 'after' : 'before';
    const time = Number(Utils.Store.get('autoLockChampion', LOCK_TIME_KEY));
    const timeMs = isFinite(time) ? Math.min(LOCK_TIME_MAX, Math.max(LOCK_TIME_MIN, time)) * 1000 : 0;
    return { mode, timeMs };
}

function getHoverDelayMs() {
    const v = Utils.Store.get('autoLockChampion', HOVER_DELAY_KEY);
    if (v === undefined || v === null) return HOVER_DELAY_DEFAULT * 1000;
    const n = Number(v);
    if (!isFinite(n) || n < 0) return 0;
    return n * 1000;
}

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('autoLockChampion', 'enabled', enabled);
    if (enabled) mountAutoLockChampion();
    else unmountAutoLockChampion();
}

function asChampionList(value) {
    const raw = Array.isArray(value) ? value : (value ? [value] : []);
    const seen = new Set();
    const ids = [];

    raw.forEach((item) => {
        const id = Number(item);
        if (!id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    });

    return ids.slice(0, MAX_PRIORITY_CHAMPS);
}

function getPriorityList(key, role = 'default') {
    const actualKey = role === 'default' ? key : `${key}_${role}`;
    const current = asChampionList(Utils.Store.get('autoLockChampion', actualKey));

    if (key === PICK_PRIORITY_KEY && current.length === 0 && role === 'default') {
        const legacyPick = Number(Utils.Store.get('autoLockChampion', 'legacyPickId'));
        if (legacyPick) {
            Utils.Store.set('autoLockChampion', actualKey, [legacyPick]);
            Utils.Store.remove('autoLockChampion', 'legacyPickId');
            return [legacyPick];
        }
    }

    return current;
}

function setPriorityList(key, role, ids) {
    const actualKey = role === 'default' ? key : `${key}_${role}`;
    Utils.Store.set('autoLockChampion', actualKey, ids);
}

function getChampionName(champions, id, championMap) {
    return (championMap?.get(Number(id))?.name) || champions?.find((champ) => Number(champ.id) === Number(id))?.name || t("Champion {{id}}", { id });
}

function displayChampionName(champ) {
    return Utils.GameData.Assets.getChampionName(champ.id, { enabled: true });
}

function styleButton(button, compact = false) {
    Object.assign(button.style, {
        background: '#1e2328',
        color: '#c8aa6e',
        border: '1px solid #785a28',
        borderRadius: '2px',
        cursor: 'pointer',
        padding: compact ? '2px 6px' : '6px 10px',
        fontSize: compact ? '11px' : '12px',
        lineHeight: '1.2'
    });
}

function renderPriorityPicker(container, labelText, storeKey, role, champions) {
    const championMap = new Map(champions.filter(c => c.id > 0).map(c => [Number(c.id), c]));
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '6px'
    });

    const label = document.createElement('div');
    label.textContent = labelText;
    Object.assign(label.style, {
        color: '#f0e6d2',
        fontSize: '12px',
        fontWeight: 'bold'
    });

    const chips = document.createElement('div');
    Object.assign(chips.style, {
        display: 'flex',
        gap: '6px',
        flexWrap: 'wrap',
        minHeight: '28px'
    });

    const controlRow = document.createElement('div');
    Object.assign(controlRow.style, {
        display: 'flex',
        gap: '6px',
        width: '100%'
    });

    const searchContainer = document.createElement('div');
    Object.assign(searchContainer.style, {
        position: 'relative',
        flex: '1',
        minWidth: '0'
    });

    const searchInput = document.createElement('input');
    searchInput.type = 'text';
    searchInput.placeholder = t('Search champion...');
    searchInput.autocomplete = 'off';
    Object.assign(searchInput.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        padding: '6px',
        borderRadius: '2px',
        width: '100%',
        outline: 'none',
        boxSizing: 'border-box',
        fontSize: '12px'
    });

    const dropdown = document.createElement('div');
    Object.assign(dropdown.style, {
        position: 'absolute',
        top: '100%',
        left: '0',
        right: '0',
        marginTop: '2px',
        maxHeight: '280px',
        overflowY: 'auto',
        background: '#1e2328',
        border: '1px solid #785a28',
        borderRadius: '2px',
        zIndex: '1000',
        display: 'none',
        boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
    });
    // Inject shared styles once
    if (!document.getElementById('alc-dd-style')) {
        const s = document.createElement('style');
        s.id = 'alc-dd-style';
        s.textContent = '.alc-dd-item{display:flex;align-items:center;gap:8px;padding:5px 8px;cursor:pointer;font-size:12px;color:#a09b8c;background:transparent}.alc-dd-item.hl{color:#f0e6d2;background:rgba(200,170,110,0.15)}.alc-dd-item img{width:22px;height:22px;border-radius:50%;flex-shrink:0;object-fit:cover}';
        document.head.appendChild(s);
    }

    let activeIdx = -1;
    let filteredChamps = champions.filter(c => c.id > 0 && !getPriorityList(storeKey, role).includes(Number(c.id)));
    let inputTimer = null;

    function highlightIndex(idx) {
        const prev = dropdown.children[activeIdx];
        if (prev) prev.classList.remove('hl');
        activeIdx = idx;
        const next = dropdown.children[activeIdx];
        if (next) { next.classList.add('hl'); next.scrollIntoView({ block: 'nearest' }); }
    }

    dropdown.onmouseleave = () => {
        const prev = dropdown.children[activeIdx];
        if (prev) prev.classList.remove('hl');
        activeIdx = -1;
    };

    function closeDropdown() {
        dropdown.style.display = 'none';
        activeIdx = -1;
        if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
    }

    function renderDropdown() {
        const selected = getPriorityList(storeKey, role);
        const query = searchInput.value.toLowerCase().trim();
        filteredChamps = champions.filter(c =>
            c.id > 0 &&
            !selected.includes(Number(c.id)) &&
            (!query || displayChampionName(c).toLowerCase().includes(query))
        );

        if (filteredChamps.length === 0) { dropdown.style.display = 'none'; dropdown.innerHTML = ''; return; }

        let html = '';
        for (let i = 0; i < filteredChamps.length; i++) {
            const champ = filteredChamps[i];
            html += '<div class="alc-dd-item' + (i === activeIdx ? ' hl' : '') + '" data-idx="' + i + '"><img src="/lol-game-data/assets/v1/champion-icons/' + champ.id + '.png" loading="lazy" onerror="this.style.opacity=\'0.3\'"><span>' + displayChampionName(champ) + '</span></div>';
        }
        dropdown.innerHTML = html;

        // Attach event listeners to each item
        const items = dropdown.children;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const champ = filteredChamps[i];
            item.onmousedown = (e) => { e.preventDefault(); e.stopPropagation(); addChampion(champ.id); };
            item.onmouseenter = () => { if (activeIdx !== i) highlightIndex(i); };
        }

        dropdown.style.display = 'block';
        if (activeIdx >= 0 && dropdown.children[activeIdx]) {
            dropdown.children[activeIdx].scrollIntoView({ block: 'nearest' });
        }
    }

    function addChampion(id) {
        id = Number(id);
        if (!id) return;
        const current = getPriorityList(storeKey, role);
        if (current.length >= MAX_PRIORITY_CHAMPS || current.includes(id)) return;
        const next = [...current, id];
        setPriorityList(storeKey, role, next);
        searchInput.value = '';
        closeDropdown();
        paint(next);
    }

    function openDropdown() { activeIdx = -1; renderDropdown(); }
    searchInput.onfocus = openDropdown;
    searchInput.onclick = () => { if (dropdown.style.display !== 'block') openDropdown(); };

    searchInput.oninput = () => {
        if (inputTimer) clearTimeout(inputTimer);
        activeIdx = -1;
        inputTimer = setTimeout(renderDropdown, 80);
    };

    searchInput.onkeydown = (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (filteredChamps.length) highlightIndex(Math.min(activeIdx + 1, filteredChamps.length - 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); highlightIndex(Math.max(activeIdx - 1, -1)); }
        else if (e.key === 'Enter') {
            e.preventDefault();
            if (activeIdx >= 0 && filteredChamps[activeIdx]) addChampion(filteredChamps[activeIdx].id);
            else if (filteredChamps.length > 0) addChampion(filteredChamps[0].id);
        }
        else if (e.key === 'Escape') { closeDropdown(); searchInput.blur(); }
    };

    const docHandler = (e) => {
        if (!searchContainer.contains(e.target)) closeDropdown();
    };
    document.addEventListener('click', docHandler);

    // Auto-cleanup when wrap is removed from DOM (role switch or modal close)
    wrap.addEventListener('DOMNodeRemoved', () => {
        document.removeEventListener('click', docHandler);
        clearTimeout(inputTimer);
    }, { once: true });

    function paint(selectedList) {
        const selected = selectedList || getPriorityList(storeKey, role);
        chips.innerHTML = '';
        selected.forEach((id, index) => {
            const chip = document.createElement('span');
            Object.assign(chip.style, {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '3px',
                background: '#111',
                color: '#f0e6d2',
                border: '1px solid #785a28',
                borderRadius: '2px',
                padding: '3px 5px',
                fontSize: '12px',
                maxWidth: '100%'
            });

            const champ = championMap.get(Number(id));
            const chipIcon = document.createElement('img');
            chipIcon.src = `/lol-game-data/assets/v1/champion-icons/${id}.png`;
            Object.assign(chipIcon.style, {
                width: '18px', height: '18px', borderRadius: '50%',
                flexShrink: '0', objectFit: 'cover'
            });
            chipIcon.onerror = () => { chipIcon.style.opacity = '0.3'; };

            const rank = document.createElement('strong');
            rank.textContent = `${index + 1}`;
            Object.assign(rank.style, { color: '#0ac8b9', fontSize: '11px', minWidth: '10px', textAlign: 'center' });

            const name = document.createElement('span');
            name.textContent = champ ? displayChampionName(champ) : getChampionName(champions, id, championMap);
            Object.assign(name.style, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });

            const up = document.createElement('button');
            up.type = 'button'; up.textContent = '\u25B2'; up.title = t('Higher priority');
            styleButton(up, true);
            up.disabled = index === 0;
            up.style.opacity = up.disabled ? '0.35' : '1';
            up.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                const next = selected.slice();
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                setPriorityList(storeKey, role, next);
                paint(next);
            };

            const down = document.createElement('button');
            down.type = 'button'; down.textContent = '\u25BC'; down.title = t('Lower priority');
            styleButton(down, true);
            down.disabled = index === selected.length - 1;
            down.style.opacity = down.disabled ? '0.35' : '1';
            down.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                const next = selected.slice();
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                setPriorityList(storeKey, role, next);
                paint(next);
            };

            const remove = document.createElement('button');
            remove.type = 'button'; remove.textContent = '\u2715'; remove.title = t('Remove');
            styleButton(remove, true);
            remove.onclick = (e) => {
                e.preventDefault(); e.stopPropagation();
                const next = selected.filter((champId) => champId !== id);
                setPriorityList(storeKey, role, next);
                paint(next);
            };

            chip.appendChild(chipIcon);
            chip.appendChild(rank);
            chip.appendChild(name);
            chip.appendChild(up);
            chip.appendChild(down);
            chip.appendChild(remove);
            chips.appendChild(chip);
        });
    }

    searchContainer.appendChild(searchInput);
    searchContainer.appendChild(dropdown);
    controlRow.appendChild(searchContainer);
    wrap.appendChild(label);
    wrap.appendChild(chips);
    wrap.appendChild(controlRow);
    container.appendChild(wrap);
    paint();
}

function renderExtraSettings(container) {
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '10px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    // Role Select
    const roleRow = document.createElement('div');
    Object.assign(roleRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
        marginTop: '5px'
    });

    const roleLabel = document.createElement('span');
    roleLabel.textContent = t('Configure Role:');
    Object.assign(roleLabel.style, {
        color: '#a09b8c',
        fontSize: '12px',
        whiteSpace: 'nowrap'
    });

    const roleSelect = document.createElement('select');
    Object.assign(roleSelect.style, {
        background: '#111',
        border: '1px solid #3e2e13',
        color: '#f0e6d2',
        padding: '5px 8px',
        borderRadius: '2px',
        outline: 'none',
        fontSize: '13px'
    });

    const ROLES = [{
            id: 'default',
            label: t('Default / Any')
        },
        {
            id: 'top',
            label: t('Top')
        },
        {
            id: 'jungle',
            label: t('Jungle')
        },
        {
            id: 'middle',
            label: t('Middle')
        },
        {
            id: 'bottom',
            label: t('Bottom')
        },
        {
            id: 'utility',
            label: t('Support')
        }
    ];

    ROLES.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.label;
        roleSelect.appendChild(opt);
    });

    roleRow.appendChild(roleLabel);
    roleRow.appendChild(roleSelect);
    container.appendChild(roleRow);

    const pickerHost = document.createElement('div');
    Object.assign(pickerHost.style, {
        display: 'flex',
        flexDirection: 'column',
        gap: '10px'
    });
    container.appendChild(pickerHost);

    let cachedChamps = [];
    let selectedRoleConfig = 'default';

    function updatePickers() {
        pickerHost.innerHTML = '';
        if (cachedChamps.length) {
            renderPriorityPicker(pickerHost, t('Pick Priority'), PICK_PRIORITY_KEY, selectedRoleConfig, cachedChamps);
            renderPriorityPicker(pickerHost, t('Ban Priority'), BAN_PRIORITY_KEY, selectedRoleConfig, cachedChamps);
        }
    }

    roleSelect.addEventListener('change', () => {
        selectedRoleConfig = roleSelect.value;
        updatePickers();
    });

    const lockSettings = getLockSettings();

    const modeRow = document.createElement('div');
    Object.assign(modeRow.style, {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: '10px'
    });

    const modeLabel = document.createElement('span');
    modeLabel.textContent = t('Auto Lock Timing:');
    Object.assign(modeLabel.style, {
        color: '#a09b8c',
        fontSize: '12px'
    });

    const modeSelect = document.createElement('select');
    Object.assign(modeSelect.style, {
        background: '#111',
        border: '1px solid #3e2e13',
        color: '#f0e6d2',
        padding: '5px 8px',
        borderRadius: '2px',
        outline: 'none',
        fontSize: '13px'
    });

    const modeOptBefore = document.createElement('option');
    modeOptBefore.value = 'before';
    modeOptBefore.textContent = t('Before turn ends');

    const modeOptAfter = document.createElement('option');
    modeOptAfter.value = 'after';
    modeOptAfter.textContent = t('After turn starts');

    modeSelect.appendChild(modeOptBefore);
    modeSelect.appendChild(modeOptAfter);
    modeSelect.value = lockSettings.mode;

    modeSelect.addEventListener('change', () => {
        Utils.Store.set('autoLockChampion', LOCK_MODE_KEY, modeSelect.value);
    });

    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    container.appendChild(modeRow);

    container.appendChild(Utils.Settings.createNumberInputRow(t('Time (Seconds, 0 = instant)'), lockSettings.timeMs / 1000, LOCK_TIME_MIN, LOCK_TIME_MAX, 0.5, (v) => {
        Utils.Store.set('autoLockChampion', LOCK_TIME_KEY, v);
    }));

    container.appendChild(Utils.Settings.createNumberInputRow(t('Hover after X seconds (0 = instant, default 3)'), getHoverDelayMs() / 1000, 0, 30, 0.5, (v) => {
        Utils.Store.set('autoLockChampion', HOVER_DELAY_KEY, v);
    }));

    const assets = Utils.GameData.Assets;
    (async () => {
        try {
            if (!Object.keys(assets.champs).length) await assets.init();
            cachedChamps = Object.values(assets.champs)
                .filter(c => c.id > 0)
                .sort((a, b) => displayChampionName(a).localeCompare(displayChampionName(b)));
            updatePickers();
        } catch (e) {}
    })();

    const pickToggleRow = document.createElement('div');
    Object.assign(pickToggleRow.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
        marginTop: '10px'
    });
    pickToggleRow.appendChild(Utils.Settings.createToggleRow(t('Auto Lock-in Pick'), Utils.Store.get('autoLockChampion', 'instantPick') !== false, (next) => {
        Utils.Store.set('autoLockChampion', 'instantPick', next);
    }));
    container.appendChild(pickToggleRow);

    const banToggleRow = document.createElement('div');
    Object.assign(banToggleRow.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
        marginTop: '10px'
    });
    banToggleRow.appendChild(Utils.Settings.createToggleRow(t('Auto Lock-in Ban'), Utils.Store.get('autoLockChampion', 'instantBan') !== false, (next) => {
        Utils.Store.set('autoLockChampion', 'instantBan', next);
    }));
    container.appendChild(banToggleRow);

    const intentRow = document.createElement('div');
    Object.assign(intentRow.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
        marginTop: '10px'
    });
    intentRow.appendChild(Utils.Settings.createToggleRow(t('Respect Team Intent'), Utils.Store.get('autoLockChampion', 'respectTeamIntent') !== false, (next) => {
        Utils.Store.set('autoLockChampion', 'respectTeamIntent', next);
    }));
    container.appendChild(intentRow);

    const manualPickRow = document.createElement('div');
    Object.assign(manualPickRow.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
        marginTop: '10px'
    });
    manualPickRow.appendChild(Utils.Settings.createToggleRow(t('Allow Manual Pick'), Utils.Store.get('autoLockChampion', 'respectManualPick') === true, (next) => {
        Utils.Store.set('autoLockChampion', 'respectManualPick', next);
    }));
    container.appendChild(manualPickRow);

    // Panic Key Hotkey
    const currentPanicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    container.appendChild(Utils.Settings.createHotkeyRow(
        t('Panic Key (Cancel Auto Lock)'),
        currentPanicKey,
        (newKey) => Utils.Store.set('global', 'panicKey', newKey),
        t('Press the panic key at any point during champion select to cancel auto-lock for the current champion select only. Next champ select will re-enable automatically.')
    ));

}

async function completePendingActions() {
    if (!isEnabled) return;
    // Fetch fresh session data to avoid stale lastSessionData
    const s = await Utils.LCU.get('/lol-champ-select/v1/session').catch(() => null);
    if (!s) return;
    lastSessionData = s;
    const allActions = s.actions ? s.actions.flat(2) : [];
    const myActions = allActions.filter(a => {
        if (a.actorCellId !== s.localPlayerCellId || a.completed) return false;
        if (a.type !== 'pick' && a.type !== 'ban') return false;
        return isActionActive(a, s);
    });
    if (myActions.length === 0) return;
    const lockSettings = getLockSettings();
    if (lockSettings.timeMs <= 0) return;
    for (const action of myActions) {
        const champId = chooseChampionForAction(s, action, 'unknown');
        if (!champId) continue;
        const shouldComplete = shouldCompleteAction(s, action, true, true, lockSettings);
        if (!shouldComplete) continue;
        if (action.type === 'ban' && getChampSelectPhase(s) !== 'BAN_PICK') continue;
        const now = Date.now();
        const lastPatchTime = lastAutoLockKeys.get(action.id + '_lock_time') || 0;
        if (now - lastPatchTime < 1500) continue;
        lastAutoLockKeys.set(action.id + '_lock_time', now);
        Utils.Debug.log(`[AutoSelect] Ember timer triggered lock for action ${action.id}`);
        Utils.LCU.patch(`/lol-champ-select/v1/session/actions/${action.id}`, {
            championId: champId,
            completed: true
        }).catch(() => {});
    }
}

let _emberTimerHookCleanup = null;

function installEmberTimerHook() {
    Utils.Debug.log('[AutoSelect] installing Ember timer hook');
    _emberTimerHookCleanup = Utils.Hooks.Ember.registerRule({
        name: 'sm-auto-lock-timer',
        matcher: 'champion-select',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                original(...args);
                const t = this.get('session.timer.timeRemainingInMs');
                Utils.Debug.log('[AutoSelect] EmberHook didInsertElement: timer=', t, 'session=', this.get('session'));
                emberTimerMs = t;
                this._smUpdateTimer = () => {
                    const v = this.get('session.timer.timeRemainingInMs');
                    emberTimerMs = v;
                    if (isEnabled && !panicActive) {
                        const lockSettings = getLockSettings();
                        if (lockSettings.mode === 'before' && lockSettings.timeMs > 0 && v !== null && v !== undefined) {
                            if (v <= lockSettings.timeMs && !emberTimerCrossed) {
                                emberTimerCrossed = true;
                                Utils.Debug.log('[AutoSelect] Ember timer crossed threshold, triggering lock');
                                completePendingActions();
                            } else if (v > lockSettings.timeMs) {
                                emberTimerCrossed = false;
                            }
                        }
                    }
                };
                this.addObserver('session.timer.timeRemainingInMs', this, '_smUpdateTimer');
            }
        }, {
            name: 'willDestroyElement',
            callback(Ember, original, ...args) {
                Utils.Debug.log('[AutoSelect] EmberHook willDestroyElement');
                this.removeObserver('session.timer.timeRemainingInMs', this, '_smUpdateTimer');
                original(...args);
            }
        }]
    });
}

export function init(context) {
    installEmberTimerHook();

    // Migrate legacy "instant" toggle
    if (Utils.Store.get('autoLockChampion', 'instant') !== undefined) {
        const legacyInstant = Utils.Store.get('autoLockChampion', 'instant');
        if (Utils.Store.get('autoLockChampion', 'instantPick') === undefined) {
            Utils.Store.set('autoLockChampion', 'instantPick', legacyInstant);
        }
        if (Utils.Store.get('autoLockChampion', 'instantBan') === undefined) {
            Utils.Store.set('autoLockChampion', 'instantBan', legacyInstant);
        }
        Utils.Store.remove('autoLockChampion', 'instant');
    }

    // Migrate legacy "lockBeforeEnd" to new lock mode system
    if (Utils.Store.get('autoLockChampion', LOCK_TIME_KEY) === undefined) {
        const legacy = Utils.Store.get('autoLockChampion', 'lockBeforeEnd');
        Utils.Store.set('autoLockChampion', LOCK_TIME_KEY, legacy !== undefined ? legacy : 0);
    }
    if (Utils.Store.get('autoLockChampion', LOCK_MODE_KEY) === undefined) {
        Utils.Store.set('autoLockChampion', LOCK_MODE_KEY, 'before');
    }

    Utils.Settings.inject(context, {
        name: "autolock-settings",
        titleKey: "snooze_autolock",
        titleName: t("Auto Select"),
        capitalTitleKey: "snooze_autolock_capital",
        capitalTitleName: t("AUTO SELECT"),
        class: "autolock-settings"
    });

    isEnabled = Utils.Store.get('autoLockChampion', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoLockChampion',
            name: t('Auto Select'),
            description: t('Automatically hovers, locks, or bans champions by priority & role in champion select, with separate top-3 priority lists per role.'),
            settings: [{
                    type: 'toggle',
                    id: 'sm:autoLockChampion',
                    label: t('Enable Auto Select Champion'),
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val)
                },
                {
                    type: 'custom',
                    render: (row) => renderExtraSettings(row)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.autolock-settings", (plugin) => {
            const mainToggle = Utils.Settings.createToggleRow(t('Enable Auto Select Champion'), isEnabled, (next) => {
                isEnabled = next;
                toggleFeature(next);
            });
            mainToggle.classList.add('plugins-settings-row');
            plugin.appendChild(mainToggle);

            const extraRow = document.createElement("div");
            extraRow.classList.add("plugins-settings-row");
            extraRow.style.marginTop = "10px";
            renderExtraSettings(extraRow);
            plugin.appendChild(extraRow);
        });
    }
}


async function processChampSelectSession(s) {
    if (!isEnabled || !s) return;

    if (panicActive) {
        if (lastSessionData && s.gameId === lastSessionData.gameId) return;
        panicActive = false;
        Utils.Debug.log('[AutoSelect] New champ select session, auto-lock re-enabled');
    }

    if (lastSessionData && s.gameId !== lastSessionData.gameId) {
        manuallyOverriddenActionIds.clear();
        pluginSetChampionIds.clear();
        ceremonyPadding = 0;
        lastTotalTimeInPhase = null;
        lastProcessPhase = null;
        Utils.Debug.log('[AutoSelect] New champ select session, plugin tracking reset');
    }

    lastSessionData = s;

    Utils.Debug.log('[AutoSelect] processChampSelectSession: timer=', s?.timer, 'phase=', s?.timer?.phase);

    fetchCurrentSummoner();

    let myPosition = 'default';
    if (s.myTeam) {
        const me = s.myTeam.find(p =>
            (currentPuuid && p.puuid === currentPuuid) ||
            (currentSummonerId && p.summonerId === currentSummonerId) ||
            (p.cellId === s.localPlayerCellId)
        );
        if (me && me.assignedPosition) {
            myPosition = me.assignedPosition;
        }
    }

    if (!myPosition) myPosition = 'default';

    // Collect teammate championPickIntent for team intent awareness
    teammateIntents = new Set();
    if (s.myTeam) {
        s.myTeam.forEach(p => {
            const isLocal = (currentPuuid && p.puuid === currentPuuid) ||
                (currentSummonerId && p.summonerId === currentSummonerId) ||
                (p.cellId === s.localPlayerCellId);
            if (!isLocal) {
                const intent = Number(p.championPickIntent);
                if (intent > 0) teammateIntents.add(intent);
            }
        });
    }

    // Check for manual user override (per-action: user changed a champion the plugin set)
    if (Utils.Store.get('autoLockChampion', 'respectManualPick') === true) {
        const allActions = s.actions ? s.actions.flat(2) : [];
        for (const action of allActions) {
            if (action.actorCellId === s.localPlayerCellId && !action.completed && (action.type === 'pick' || action.type === 'ban')) {
                const currentId = Number(action.championId || 0);
                if (currentId && pluginSetChampionIds.has(action.id) && currentId !== pluginSetChampionIds.get(action.id)) {
                    manuallyOverriddenActionIds.add(action.id);
                    Utils.Debug.log(`[AutoSelect] Manual override detected: action ${action.id} (${action.type}) championId=${currentId} !== plugin=${pluginSetChampionIds.get(action.id)}, backing off`);
                }
            }
        }
    }

    const allActions = s.actions ? s.actions.flat(2) : [];
    logBanSessionState(s, allActions, myPosition);

    // === CACHE: compute once per push ===
    const activeActionIds = new Set(getCurrentActiveActions(s).map(a => a.id));
    const bannedIds = getBannedChampionIds(s);
    const pickedIds = getPickedChampionIds(s);

    const myActions = allActions.filter(a => {
        if (a.actorCellId !== s.localPlayerCellId || a.completed) return false;
        if (a.type !== 'pick' && a.type !== 'ban') return false;
        return activeActionIds.has(a.id) || (a.type === 'pick' && getChampSelectPhase(s) === 'PLANNING');
    });

    if (myActions.length === 0) {
        lastAutoLockKeys.clear();
        actionActiveStartTimes.clear();
        actionHoverStartTimes.clear();
        actionInitialTimers.clear();
        lastActiveActionIds = activeActionIds;
        return;
    }

    // Update emberTimerMs from current session data
    if (s?.timer && s.timer.adjustedTimeLeftInPhase !== undefined && s.timer.internalNowInEpochMs !== undefined) {
        emberTimerMs = Math.max(s.timer.adjustedTimeLeftInPhase - (Date.now() - s.timer.internalNowInEpochMs), 0);
    }

    // Detect ceremony padding
    const currentPhase = getChampSelectPhase(s);
    const newTotal = s?.timer?.totalTimeInPhase;
    if (lastTotalTimeInPhase !== null && lastProcessPhase === currentPhase && newTotal > lastTotalTimeInPhase && newTotal !== undefined) {
        ceremonyPadding = newTotal - lastTotalTimeInPhase;
    } else if (currentPhase !== lastProcessPhase) {
        ceremonyPadding = 0;
    }
    lastTotalTimeInPhase = newTotal;
    lastProcessPhase = currentPhase;

    const instantPick = Utils.Store.get('autoLockChampion', 'instantPick') !== false;
    const instantBan = Utils.Store.get('autoLockChampion', 'instantBan') !== false;
    const lockSettings = getLockSettings();
    const hoverDelayMs = getHoverDelayMs();
    const now = Date.now();

    for (const action of myActions) {
        if (manuallyOverriddenActionIds.has(action.id)) {
            Utils.Debug.log(`[AutoSelect] manually overridden: skipping action ${action.id} (${action.type})`);
            continue;
        }

        // If champion was previously set by us and then cleared by the server (banned/timer expired), reset start times and clear plugin tracking to prevent re-trigger on subsequent pushes
        // Only apply on real WS pushes (not setTimeout callbacks) to avoid stale-lastSessionData race conditions
        if (!inSetTimeout && action.championId === 0 && (actionActiveStartTimes.has(action.id) || actionHoverStartTimes.has(action.id)) && pluginSetChampionIds.has(action.id)) {
            Utils.Debug.log(`[AutoSelect] action loop: action ${action.id} (${action.type}) champion cleared, resetting start time`);
            actionActiveStartTimes.delete(action.id);
            actionHoverStartTimes.delete(action.id);
            pluginSetChampionIds.delete(action.id);
        }

        const phase = getChampSelectPhase(s);
        const isActionTrulyActive = activeActionIds.has(action.id);

        // === HOVER HANDLING ===
        const isReadyForHover =
            (action.type === 'pick' && (isActionTrulyActive || phase === 'PLANNING')) ||
            (action.type === 'ban' && isActionTrulyActive && phase === 'BAN_PICK');

        if (isReadyForHover && hoverDelayMs > 0) {
            if (!actionHoverStartTimes.has(action.id)) {
                actionHoverStartTimes.set(action.id, now);
                const hTimer = setTimeout(async () => {
                    pendingTimers.delete(hTimer);
                    if (!isEnabled || panicActive || !lastSessionData) return;
                    inSetTimeout = true;
                    try { await processChampSelectSession(lastSessionData); }
                    finally { inSetTimeout = false; }
                }, hoverDelayMs + 50);
                pendingTimers.add(hTimer);
            }
            const hoverElapsed = now - actionHoverStartTimes.get(action.id);
            if (hoverElapsed >= hoverDelayMs) {
                const champId = chooseChampionForAction(s, action, myPosition, bannedIds, pickedIds);
                if (champId && action.championId !== champId) {
                    const lastHoverPatchTime = lastAutoLockKeys.get(action.id + '_hover_time') || 0;
                    if (now - lastHoverPatchTime >= 1500) {
                        lastAutoLockKeys.set(action.id + '_hover_time', now);
                        const payload = { championId: champId, completed: false };
                        Utils.Debug.log(`[AutoSelect] ${action.type} hover patch`, {
                            actionId: action.id, phase, payload, actionChampionId: action.championId,
                            hoverDelaySetting: hoverDelayMs, hoverElapsedMs: hoverElapsed
                        });
                        try {
                            await Utils.LCU.patch(`/lol-champ-select/v1/session/actions/${action.id}`, payload);
                            Utils.Debug.log(`[AutoSelect] ${action.type} hover patch sent for action=${action.id}`);
                            pluginSetChampionIds.set(action.id, champId);
                        } catch (err) {
                            Utils.Debug.warn(`[AutoSelect] ${action.type} hover patch failed`, {
                                actionId: action.id, err: err?.message ?? err
                            });
                        }
                    }
                }
            }
        }

        // === LOCK HANDLING ===
        if (!isActionTrulyActive || phase === 'PLANNING') continue;

        // Detect newly-active transition
        if (!inSetTimeout && !lastActiveActionIds.has(action.id)) {
            if (actionActiveStartTimes.has(action.id)) {
                actionActiveStartTimes.delete(action.id);
            }
        }

        if (!actionActiveStartTimes.has(action.id)) {
            actionActiveStartTimes.set(action.id, now);
            if (emberTimerMs !== null && emberTimerMs !== undefined) {
                actionInitialTimers.set(action.id, emberTimerMs - ceremonyPadding);
            }

            const lockDelay = ceremonyPadding + lockSettings.timeMs;
            if (lockSettings.mode === 'after' && lockSettings.timeMs > 0) {
                const lTimer = setTimeout(async () => {
                    pendingTimers.delete(lTimer);
                    if (!isEnabled || panicActive || !lastSessionData) return;
                    inSetTimeout = true;
                    try { await processChampSelectSession(lastSessionData); }
                    finally { inSetTimeout = false; }
                }, lockDelay + 50);
                pendingTimers.add(lTimer);
            }
        }

        const champId = chooseChampionForAction(s, action, myPosition, bannedIds, pickedIds);
        if (!champId) continue;

        const shouldComplete = shouldCompleteAction(s, action, instantPick, instantBan, lockSettings, isActionTrulyActive);

        if (!shouldComplete) continue;

        if (action.championId === champId && action.completed === shouldComplete) continue;

        const lockNow = Date.now();
        const lastLockPatchTime = lastAutoLockKeys.get(action.id + '_lock_time') || 0;

        if (lockNow - lastLockPatchTime < 1500) continue;

        lastAutoLockKeys.set(action.id + '_lock_time', lockNow);

        try {
            await Utils.LCU.patch(`/lol-champ-select/v1/session/actions/${action.id}`, {
                championId: champId,
                completed: shouldComplete
            });
            pluginSetChampionIds.set(action.id, champId);
        } catch (err) {
            Utils.Debug.warn(`[AutoSelect] ${action.type} lock patch failed`, {
                actionId: action.id, err: err?.message ?? err
            });
        }
    }

    lastActiveActionIds = activeActionIds;
}

/**
 * Returns the set of active (in-progress, non-completed) actions from the session.
 * Finds the first action set where not all actions are completed,
 * then returns only the non-completed actions within it.
 * During PLANNING and GAME_STARTING, no actions are active (matches the
 * Ember model's currentPhaseHasActions gate).
 */
function getCurrentActiveActions(session) {
    const phase = getChampSelectPhase(session);
    if (phase === 'PLANNING' || phase === 'GAME_STARTING') return [];
    const actions = session?.actions;
    if (!Array.isArray(actions)) return [];
    for (const actionSet of actions) {
        if (Array.isArray(actionSet) && actionSet.length > 0) {
            const playerActions = actionSet.filter(a => a.actorCellId >= 0);
            if (playerActions.length === 0) continue;
            const allCompleted = playerActions.every(a => a.completed);
            if (!allCompleted) {
                return actionSet.filter(a => !a.completed && a.actorCellId >= 0);
            }
        }
    }
    return [];
}

/**
 * Checks if an action is "active" (the player can act on it).
 * Finds the first incomplete action set within BAN_PICK/FINALIZATION phase
 * and checks if the action is among the non-completed actions in that set.
 * During PLANNING and GAME_STARTING, no actions are ever active.
 */
function isActionActive(action, session) {
    if (!action || action.completed) return false;
    const active = getCurrentActiveActions(session);
    return active.some(a => a.id === action.id);
}

function getChampSelectPhase(session) {
    return session?.timer?.phase || session?.phase || 'unknown';
}

function shouldCompleteAction(session, action, instantPick, instantBan, lockSettings, _isActive) {
    if (_isActive !== true && !isActionActive(action, session)) return false;

    const phase = getChampSelectPhase(session);
    
    if (action.type === 'ban') {
        if (phase !== 'BAN_PICK') {
            Utils.Debug.log(`[AutoSelect] shouldComplete: ban ${action.id} not completing (phase=${phase})`);
            return false;
        }
    }

    if (lockSettings.timeMs > 0) {
        if (lockSettings.mode === 'after') {
            let elapsed = null;
            const initialTimer = actionInitialTimers.get(action.id);
            if (initialTimer !== undefined && emberTimerMs !== null && emberTimerMs !== undefined) {
                elapsed = initialTimer - emberTimerMs;
            }
            if (elapsed === null) {
                const startTs = actionActiveStartTimes.get(action.id);
                if (startTs) elapsed = Date.now() - startTs;
            }
            if (elapsed !== null) {
                const complete = elapsed >= lockSettings.timeMs;
                Utils.Debug.log(`[AutoSelect] shouldComplete: action ${action.id} mode=after elapsed=${elapsed}ms threshold=${lockSettings.timeMs}ms complete=${complete} initTmr=${initialTimer} ember=${emberTimerMs} cerPad=${ceremonyPadding}`);
                return complete;
            }
            Utils.Debug.log(`[AutoSelect] shouldComplete: action ${action.id} mode=after but no elapsed measure, not completing`);
            return false;
        } else {
            let timerSrc = 'none';
            let timeRemaining = null;

            // Raw session snapshot + elapsed time (fresh LCU push, accounts for elapsed time even with stale session)
            if (session?.timer?.adjustedTimeLeftInPhase !== undefined && session?.timer?.internalNowInEpochMs !== undefined) {
                timeRemaining = Math.max(session.timer.adjustedTimeLeftInPhase - (Date.now() - session.timer.internalNowInEpochMs), 0);
                timerSrc = 'raw-adjusted';
                Utils.Debug.log(`[AutoSelect] shouldComplete: action ${action.id} timer trial 'raw-adjusted': ${timeRemaining}ms adjustedTimeLeftInPhase=${session.timer.adjustedTimeLeftInPhase} internalNowInEpochMs=${session.timer.internalNowInEpochMs} now=${Date.now()}`);
            }
            // Ember timer fallback (when raw session lacks timer data)
            if (timeRemaining === null && emberTimerMs !== null && emberTimerMs !== undefined) {
                timeRemaining = emberTimerMs;
                timerSrc = 'ember';
                Utils.Debug.log(`[AutoSelect] shouldComplete: action ${action.id} timer fallback 'ember': ${timeRemaining}ms`);
            }
            // raw snapshot value directly
            if (timeRemaining === null && session?.timer?.adjustedTimeLeftInPhase !== undefined) {
                timeRemaining = session.timer.adjustedTimeLeftInPhase;
                timerSrc = 'raw-snapshot';
                Utils.Debug.log(`[AutoSelect] shouldComplete: action ${action.id} timer fallback 'raw-snapshot': ${timeRemaining}ms`);
            }

            if (timeRemaining !== null) {
                const shouldComplete = timeRemaining <= lockSettings.timeMs;
                Utils.Debug.log(`[AutoSelect] lockBeforeEnd: timer=${timeRemaining}ms, threshold=${lockSettings.timeMs}ms, complete=${shouldComplete}, src=${timerSrc}`);
                return shouldComplete;
            }
            Utils.Debug.warn('[AutoSelect] lockBeforeEnd enabled but no timer source available, falling through to instant');
        }
    }

    if (action.type === 'ban') return instantBan;
    if (action.type === 'pick') return instantPick;
    return false;
}

function logBanSessionState(session, allActions, myPosition) {
    const banActions = allActions.filter((action) => action.type === 'ban');
    if (banActions.length === 0) return;

    const compactActions = banActions.map((action) => ({
        id: action.id,
        actorCellId: action.actorCellId,
        isAllyAction: action.isAllyAction,
        active: isActionActive(action, session),
        completed: action.completed,
        championId: action.championId
    }));

    const debugState = {
        phase: getChampSelectPhase(session),
        localPlayerCellId: session.localPlayerCellId,
        myPosition,
        banPriority: getPriorityList(BAN_PRIORITY_KEY, myPosition),
        bannedChampionIds: [...getBannedChampionIds(session)],
        bannableSetSize: bannableChampionSet?.size ?? 'N/A',
        banActions: compactActions
    };
    const debugKey = JSON.stringify(debugState);
    if (debugKey === lastBanDebugKey) return;
    lastBanDebugKey = debugKey;

    Utils.Debug.log('[AutoSelect] ban state', debugState);
}

function getBannedChampionIds(session, label) {
    const bans = new Set();
    const tag = label ? `[${label}]` : '';

    // Primary: completed ban actions from the flat action array
    if (session?.actions) {
        const rawBans = session.actions.flat(2).filter(a => a.type === 'ban');
        rawBans.forEach(action => {
            if (action.championId && action.completed) {
                bans.add(Number(action.championId));
            }
        });
        if (!label) {
            Utils.Debug.log(`[AutoSelect] getBannedChampionIds: scanned ${rawBans.length} ban actions: [${rawBans.map(a => `{id:${a.id},actor:${a.actorCellId},champId:${a.championId},completed:${a.completed}}`).join(', ')}] => included=${[...bans]}`);
        }
    }

    // Secondary: session.bans object (may have champion IDs that are hidden in the action array during simultaneous ban mode)
    if (session?.bans) {
        const extractBans = (arr) => {
            if (Array.isArray(arr)) {
                arr.forEach(entry => {
                    if (typeof entry === 'number' && entry > 0) bans.add(entry);
                    else if (entry && typeof entry === 'object' && entry.championId) bans.add(Number(entry.championId));
                });
            }
        };
        const beforeBans = bans.size;
        extractBans(session.bans.myTeamBans);
        extractBans(session.bans.theirTeamBans);
        if (bans.size > beforeBans) {
            Utils.Debug.log(`[AutoSelect] getBannedChampionIds${tag}: session.bans added ${bans.size - beforeBans} (myTeam=${JSON.stringify(session.bans.myTeamBans)}, theirTeam=${JSON.stringify(session.bans.theirTeamBans)}) => total=${[...bans]}`);
        }
    }

    return bans;
}

function getPickedChampionIds(session) {
    const picked = new Set();

    // Completed pick actions from the session
    if (session?.actions) {
        session.actions.flat(2).forEach(action => {
            if (action.type === 'pick' && action.championId && action.completed) {
                picked.add(Number(action.championId));
            }
        });
    }
    const fromActions = picked.size;

    // Also check player championId field (populated on lock-in)
    const players = [...(session?.myTeam || []), ...(session?.theirTeam || [])];
    players
        .filter((player) => player.cellId !== session?.localPlayerCellId)
        .forEach(player => {
            const id = Number(player.championId);
            if (id) picked.add(id);
        });
    const afterPlayers = picked.size;

    if (afterPlayers > fromActions) {
        Utils.Debug.log(`[AutoSelect] getPickedChampionIds: ${fromActions} from actions + ${afterPlayers - fromActions} from player.championId fallback = ${afterPlayers}`);
    }

    return picked;
}

function isChampionAvailableForAction(actionType, championId, session, bannedIds, pickedIds) {
    const b = bannedIds || getBannedChampionIds(session);
    if (b.has(championId)) return false;

    const p = pickedIds || getPickedChampionIds(session);
    if (actionType === 'pick' && p.has(championId)) return false;

    if (actionType === 'ban' && bannableChampionSet && !bannableChampionSet.has(championId)) return false;

    if (actionType === 'ban' && Utils.Store.get('autoLockChampion', 'respectTeamIntent') !== false && teammateIntents.has(championId)) return false;

    return true;
}

function chooseChampionForAction(session, action, role, bannedIds, pickedIds) {
    const actionType = action.type;

    let priorities = getPriorityList(actionType === 'ban' ? BAN_PRIORITY_KEY : PICK_PRIORITY_KEY, role);
    if (priorities.length === 0 && role !== 'default') {
        priorities = getPriorityList(actionType === 'ban' ? BAN_PRIORITY_KEY : PICK_PRIORITY_KEY, 'default');
    }

    if (priorities.length === 0) return null;

    const currentChampionId = Number(action.championId || 0);

    if (currentChampionId && priorities.includes(currentChampionId)) {
        if (isChampionAvailableForAction(actionType, currentChampionId, session, bannedIds, pickedIds)) return currentChampionId;
    }

    return priorities.find((championId) => isChampionAvailableForAction(actionType, championId, session, bannedIds, pickedIds)) || null;
}

function panic() {
    Utils.Debug.log('[AutoSelect] Panic triggered, overriding controls');
    panicActive = true;
    emberTimerCrossed = false;
    lastAutoLockKeys.clear();
    actionActiveStartTimes.clear();
    actionHoverStartTimes.clear();

    Utils.Toast.info(t('Auto Lock Override - Next champ select will re-enable'));
}

function mountAutoLockChampion() {
    Utils.Debug.log('[AutoSelect] mountAutoLockChampion: entered');
    if (!Utils.LCU || !Utils.LCU.observe) {
        Utils.Debug.log('[AutoSelect] mountAutoLockChampion: early return (LCU/observe unavailable)');
        return;
    }
    // Clean up any stale subscriptions from previous mounts (hot-reload safety)
    unmountAutoLockChampion();
    panicActive = false;
    unregisterPanic = Utils.Panic.register(panic);
    bannableChampionSet = null;
    pickableChampionSet = null;

    bannableChampUnsub = Utils.LCU.observe('/lol-champ-select/v1/bannable-champion-ids', e => {
        Utils.Debug.log(`[AutoSelect] [WS /lol-champ-select/v1/bannable-champion-ids] raw data: [${(e.data || []).join(',')}]`);
        bannableChampionSet = new Set(e.data || []);
        Utils.Debug.log(`[AutoSelect] [WS /lol-champ-select/v1/bannable-champion-ids] bannableChampionSet updated, size=${bannableChampionSet.size}`);
    });
    Utils.LCU.get('/lol-champ-select/v1/bannable-champion-ids')
        .then(data => {
            Utils.Debug.log(`[AutoSelect] [HTTP /lol-champ-select/v1/bannable-champion-ids] initial GET response: [${(data || []).join(',')}]`);
            bannableChampionSet = new Set(data || []);
        })
        .catch(() => {});

    pickableChampUnsub = Utils.LCU.observe('/lol-champ-select/v1/pickable-champion-ids', e => {
        Utils.Debug.log(`[AutoSelect] [WS /lol-champ-select/v1/pickable-champion-ids] raw data: [${(e.data || []).join(',')}]`);
        pickableChampionSet = new Set(e.data || []);
        Utils.Debug.log(`[AutoSelect] [WS /lol-champ-select/v1/pickable-champion-ids] pickableChampionSet updated, size=${pickableChampionSet.size}`);
    });
    Utils.LCU.get('/lol-champ-select/v1/pickable-champion-ids')
        .then(data => {
            Utils.Debug.log(`[AutoSelect] [HTTP /lol-champ-select/v1/pickable-champion-ids] initial GET response: [${(data || []).join(',')}]`);
            pickableChampionSet = new Set(data || []);
        })
        .catch(() => {});

    autoLockSessionUnsub = Utils.LCU.observe('/lol-champ-select/v1/session', e => {
        const s = e.data;
        const phase = s?.timer?.phase ?? 'N/A';
        Utils.Debug.log(`[AutoSelect] [WS /lol-champ-select/v1/session] push: timer.phase=${phase} gameId=${s?.gameId} actions=${s?.actions?.length ?? 'N/A'} actionsets=${s?.actions?.map?.(set => `${set.length}`)?.join(',') ?? 'N/A'}`);

        // Track championId changes in actions across pushes (e.g., enemy ban championId 0→real ID at phase transition)
        if (s?.actions) {
            const currentActions = new Map();
            s.actions.flat(2).forEach(a => {
                currentActions.set(a.id, { championId: a.championId, completed: a.completed, type: a.type, actorCellId: a.actorCellId });
            });
            if (lastSeenActionChampionIds) {
                const changes = [];
                currentActions.forEach((curr, id) => {
                    const prev = lastSeenActionChampionIds.get(id);
                    if (prev && prev.championId !== curr.championId) {
                        changes.push(`action[${id}] ${prev.type} championId ${prev.championId}→${curr.championId} (actorCellId=${curr.actorCellId}, completed=${curr.completed})`);
                    }
                });
                if (changes.length > 0) {
                    Utils.Debug.log(`[AutoSelect] [WS /lol-champ-select/v1/session] championId changes: ${changes.join(' | ')}`);
                }
            }
            lastSeenActionChampionIds = currentActions;
            // Also dump raw actions on phase transitions for full picture
            if (lastSeenPhase !== undefined && lastSeenPhase !== phase) {
                const allRaw = s.actions.flat(2).map(a => `{id:${a.id},type:${a.type},actor:${a.actorCellId},champId:${a.championId},completed:${a.completed}}`).join(', ');
                Utils.Debug.log(`[AutoSelect] [WS /lol-champ-select/v1/session] phase ${lastSeenPhase}→${phase} RAW actions: [${allRaw}]`);
            }
            lastSeenPhase = phase !== 'N/A' ? phase : lastSeenPhase;
        }

        processChampSelectSession(s);
    });
    Utils.LCU.get('/lol-champ-select/v1/session')
        .then(processChampSelectSession)
        .catch(() => {});
}

function unmountAutoLockChampion() {
    if (unregisterPanic) {
        unregisterPanic();
        unregisterPanic = null;
    }
    if (autoLockSessionUnsub) {
        autoLockSessionUnsub();
        autoLockSessionUnsub = null;
    }
    if (bannableChampUnsub) {
        bannableChampUnsub();
        bannableChampUnsub = null;
    }
    if (pickableChampUnsub) {
        pickableChampUnsub();
        pickableChampUnsub = null;
    }
    pendingTimers.forEach(id => clearTimeout(id));
    pendingTimers.clear();
    bannableChampionSet = null;
    pickableChampionSet = null;
    lastAutoLockKeys.clear();
    actionActiveStartTimes.clear();
    actionHoverStartTimes.clear();
    lastBanDebugKey = '';
    lastSeenActionChampionIds = null;
    lastSeenPhase = undefined;
}

export function load() {
    isEnabled = Utils.Store.get('autoLockChampion', 'enabled') || false;
    if (isEnabled) mountAutoLockChampion();
    fetchCurrentSummoner();
}
export function unload() {
    unmountAutoLockChampion();
    if (_emberTimerHookCleanup) {
        _emberTimerHookCleanup();
        _emberTimerHookCleanup = null;
    }
}
