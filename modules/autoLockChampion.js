/**
 * @name Snooze-AutoLockChampion
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Auto-locks priority champions during champ select with role-specific picks and bans.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

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
    Utils.Store.set('autoLockChampion', actualKey, asChampionList(ids));
}

function getChampionName(champions, id) {
    return champions.find((champ) => Number(champ.id) === Number(id))?.name || `Champion ${id}`;
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

    const select = document.createElement('select');
    Object.assign(select.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        padding: '6px',
        borderRadius: '2px',
        flex: '1',
        outline: 'none',
        minWidth: '0'
    });

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.textContent = 'Add';
    styleButton(addBtn);

    function paint() {
        const selected = getPriorityList(storeKey, role);
        chips.innerHTML = '';
        select.innerHTML = '';

        champions
            .filter((champ) => champ.id > 0 && !selected.includes(Number(champ.id)))
            .forEach((champ) => {
                const opt = document.createElement('option');
                opt.value = champ.id;
                opt.textContent = champ.name;
                select.appendChild(opt);
            });

        selected.forEach((id, index) => {
            const chip = document.createElement('span');
            Object.assign(chip.style, {
                display: 'inline-flex',
                alignItems: 'center',
                gap: '5px',
                background: '#111',
                color: '#f0e6d2',
                border: '1px solid #785a28',
                borderRadius: '2px',
                padding: '4px 6px',
                fontSize: '12px',
                maxWidth: '100%'
            });

            const rank = document.createElement('strong');
            rank.textContent = `${index + 1}`;
            Object.assign(rank.style, {
                color: '#0ac8b9',
                fontSize: '11px'
            });

            const name = document.createElement('span');
            name.textContent = getChampionName(champions, id);
            Object.assign(name.style, {
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap'
            });

            const up = document.createElement('button');
            up.type = 'button';
            up.textContent = 'Up';
            up.title = 'Higher priority';
            styleButton(up, true);
            up.disabled = index === 0;
            up.style.opacity = up.disabled ? '0.35' : '1';
            up.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const next = selected.slice();
                [next[index - 1], next[index]] = [next[index], next[index - 1]];
                setPriorityList(storeKey, role, next);
                paint();
            };

            const down = document.createElement('button');
            down.type = 'button';
            down.textContent = 'Dn';
            down.title = 'Lower priority';
            styleButton(down, true);
            down.disabled = index === selected.length - 1;
            down.style.opacity = down.disabled ? '0.35' : '1';
            down.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const next = selected.slice();
                [next[index], next[index + 1]] = [next[index + 1], next[index]];
                setPriorityList(storeKey, role, next);
                paint();
            };

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.textContent = 'x';
            remove.title = 'Remove';
            styleButton(remove, true);
            remove.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                setPriorityList(storeKey, role, selected.filter((champId) => champId !== id));
                paint();
            };

            chip.appendChild(rank);
            chip.appendChild(name);
            chip.appendChild(up);
            chip.appendChild(down);
            chip.appendChild(remove);
            chips.appendChild(chip);
        });

        addBtn.disabled = selected.length >= MAX_PRIORITY_CHAMPS || select.options.length === 0;
        addBtn.style.opacity = addBtn.disabled ? '0.45' : '1';
    }

    addBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const id = Number(select.value);
        if (!id) return;
        const selected = getPriorityList(storeKey, role);
        if (selected.length >= MAX_PRIORITY_CHAMPS || selected.includes(id)) return;
        setPriorityList(storeKey, role, [...selected, id]);
        paint();
    };

    controlRow.appendChild(select);
    controlRow.appendChild(addBtn);
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
    roleLabel.textContent = 'Configure Role:';
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
            label: 'Default / Any'
        },
        {
            id: 'top',
            label: 'Top'
        },
        {
            id: 'jungle',
            label: 'Jungle'
        },
        {
            id: 'middle',
            label: 'Middle'
        },
        {
            id: 'bottom',
            label: 'Bottom'
        },
        {
            id: 'utility',
            label: 'Support'
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
            renderPriorityPicker(pickerHost, 'Pick Priority', PICK_PRIORITY_KEY, selectedRoleConfig, cachedChamps);
            renderPriorityPicker(pickerHost, 'Ban Priority', BAN_PRIORITY_KEY, selectedRoleConfig, cachedChamps);
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
    modeLabel.textContent = 'Auto Lock Timing:';
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
    modeOptBefore.textContent = 'Before turn ends';

    const modeOptAfter = document.createElement('option');
    modeOptAfter.value = 'after';
    modeOptAfter.textContent = 'After turn starts';

    modeSelect.appendChild(modeOptBefore);
    modeSelect.appendChild(modeOptAfter);
    modeSelect.value = lockSettings.mode;

    modeSelect.addEventListener('change', () => {
        Utils.Store.set('autoLockChampion', LOCK_MODE_KEY, modeSelect.value);
    });

    modeRow.appendChild(modeLabel);
    modeRow.appendChild(modeSelect);
    container.appendChild(modeRow);

    container.appendChild(Utils.Settings.createNumberInputRow('Time (Seconds, 0 = instant)', lockSettings.timeMs / 1000, LOCK_TIME_MIN, LOCK_TIME_MAX, 0.5, (v) => {
        Utils.Store.set('autoLockChampion', LOCK_TIME_KEY, v);
    }));

    container.appendChild(Utils.Settings.createNumberInputRow('Hover after X seconds (0 = instant, default 3)', getHoverDelayMs() / 1000, 0, 30, 0.5, (v) => {
        Utils.Store.set('autoLockChampion', HOVER_DELAY_KEY, v);
    }));

    if (Utils.LCU) {
        Utils.LCU.get('/lol-game-data/assets/v1/champion-summary.json').then(champs => {
            if (champs && champs.length) {
                cachedChamps = champs.filter(c => c.id > 0).sort((a, b) => a.name.localeCompare(b.name));
                updatePickers();
            }
        }).catch(() => {});
    }

    const pickToggleRow = document.createElement('div');
    Object.assign(pickToggleRow.style, {
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        cursor: 'pointer',
        marginTop: '10px'
    });
    pickToggleRow.appendChild(Utils.Settings.createToggleRow('Auto Lock-in Pick', Utils.Store.get('autoLockChampion', 'instantPick') !== false, (next) => {
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
    banToggleRow.appendChild(Utils.Settings.createToggleRow('Auto Lock-in Ban', Utils.Store.get('autoLockChampion', 'instantBan') !== false, (next) => {
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
    intentRow.appendChild(Utils.Settings.createToggleRow('Respect Team Intent', Utils.Store.get('autoLockChampion', 'respectTeamIntent') !== false, (next) => {
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
    manualPickRow.appendChild(Utils.Settings.createToggleRow('Allow Manual Pick', Utils.Store.get('autoLockChampion', 'respectManualPick') === true, (next) => {
        Utils.Store.set('autoLockChampion', 'respectManualPick', next);
    }));
    container.appendChild(manualPickRow);

    // Panic Key Hotkey
    const currentPanicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    container.appendChild(Utils.Settings.createHotkeyRow(
        'Panic Key (Cancel Auto Lock)',
        currentPanicKey,
        (newKey) => Utils.Store.set('global', 'panicKey', newKey),
        'Press the panic key at any point during champion select to cancel auto-lock for the current champion select only. Next champ select will re-enable automatically.'
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

function installEmberTimerHook() {
    Utils.Debug.log('[AutoSelect] installing Ember timer hook');
    Utils.Hooks.Ember.registerRule({
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
        titleName: "Auto Select",
        capitalTitleKey: "snooze_autolock_capital",
        capitalTitleName: "AUTO SELECT",
        class: "autolock-settings"
    });

    isEnabled = Utils.Store.get('autoLockChampion', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoLockChampion',
            name: 'Auto Select',
            description: 'Automatically hovers, locks, or bans champions by priority & role in champion select, with separate top-3 priority lists per role.',
            settings: [{
                    type: 'toggle',
                    id: 'sm:autoLockChampion',
                    label: 'Enable Auto Select Champion',
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
            const mainToggle = Utils.Settings.createToggleRow('Enable Auto Select Champion', isEnabled, (next) => {
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

    Utils.Debug.log('[AutoSelect] all my actions:', allActions.filter(a => a.actorCellId === s.localPlayerCellId).map(a => ({
        id: a.id, type: a.type, completed: a.completed, active: isActionActive(a, s), championId: a.championId
    })));

    const myActions = allActions.filter(a => {
        if (a.actorCellId !== s.localPlayerCellId || a.completed) return false;
        if (a.type !== 'pick' && a.type !== 'ban') return false;

        if (isActionActive(a, s)) return true;
        if (a.type === 'pick' && getChampSelectPhase(s) === 'PLANNING') return true;

        return false;
    });

    if (myActions.length === 0) {
        Utils.Debug.log('[AutoSelect] no myActions — clearing start times (phase:', getChampSelectPhase(s), ')');
        lastAutoLockKeys.clear();
        actionActiveStartTimes.clear();
        actionHoverStartTimes.clear();
        actionInitialTimers.clear();
        lastActiveActionIds = new Set(
            (s?.actions ? s.actions.flat(2) : [])
                .filter(a => isActionActive(a, s))
                .map(a => a.id)
        );
        return;
    }

    if (manuallyOverriddenActionIds.size > 0) {
        const ids = [...manuallyOverriddenActionIds].join(',');
        Utils.Debug.log(`[AutoSelect] manually overridden action ids: ${ids}`);
    }

    // Update emberTimerMs from current session data (handles both fresh WS pushes and stale lastSessionData from setTimeout)
    if (s?.timer && s.timer.adjustedTimeLeftInPhase !== undefined && s.timer.internalNowInEpochMs !== undefined) {
        emberTimerMs = Math.max(s.timer.adjustedTimeLeftInPhase - (Date.now() - s.timer.internalNowInEpochMs), 0);
    }

    // Detect ceremony padding: when totalTimeInPhase increases mid-phase (e.g. ban→pick adds ceremony time)
    const currentPhase = getChampSelectPhase(s);
    const newTotal = s?.timer?.totalTimeInPhase;
    if (lastTotalTimeInPhase !== null && lastProcessPhase === currentPhase && newTotal > lastTotalTimeInPhase && newTotal !== undefined) {
        ceremonyPadding = newTotal - lastTotalTimeInPhase;
        Utils.Debug.log(`[AutoSelect] ceremony padding: ${ceremonyPadding}ms (total ${lastTotalTimeInPhase}→${newTotal})`);
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

    const totalTime = s?.timer?.totalTimeInPhase ?? 0;
    const phaseElapsed = totalTime && emberTimerMs !== null ? totalTime - emberTimerMs : null;
    const actionTimingInfo = myActions.map(a => ({
        id: a.id,
        type: a.type,
        initTmr: actionInitialTimers.get(a.id),
        active: isActionActive(a, s),
        initElapsed: (actionInitialTimers.has(a.id) && emberTimerMs !== null) ? actionInitialTimers.get(a.id) - emberTimerMs : null
    }));
    Utils.Debug.log(`[AutoSelect] [TIMING] phase=${getChampSelectPhase(s)} total=${totalTime}ms ember=${emberTimerMs}ms phaseElapsed=${phaseElapsed}ms ceremonyPad=${ceremonyPadding}ms mode=${lockSettings.mode} timeMs=${lockSettings.timeMs} actions=${JSON.stringify(actionTimingInfo)}`);

    Utils.Debug.log('[AutoSelect] processing actions:', myActions.map(a => ({
        id: a.id, type: a.type, completed: a.completed, active: isActionActive(a, s), championId: a.championId
    })));
    Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] actionActiveStartTimes state: ${JSON.stringify([...actionActiveStartTimes.entries()].map(([k,v]) => `${k}:${v}`))}`);
    Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] lastActiveActionIds: [${[...lastActiveActionIds].join(',')}]`);

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
        const isActionTrulyActive = isActionActive(action, s);

        // === HOVER HANDLING ===
        // Independent from lock timing. Works during PLANNING for pre-hover (picks only).
        const isReadyForHover =
            (action.type === 'pick' && (isActionTrulyActive || phase === 'PLANNING')) ||
            (action.type === 'ban' && isActionTrulyActive && phase === 'BAN_PICK');

        if (isReadyForHover && hoverDelayMs > 0) {
            if (!actionHoverStartTimes.has(action.id)) {
                actionHoverStartTimes.set(action.id, now);
                const hoverTimer = setTimeout(async () => {
                    if (!isEnabled || panicActive || !lastSessionData) return;
                    inSetTimeout = true;
                    try { await processChampSelectSession(lastSessionData); }
                    finally { inSetTimeout = false; }
                }, hoverDelayMs + 50);
            }
            const hoverElapsed = now - actionHoverStartTimes.get(action.id);
            if (hoverElapsed >= hoverDelayMs) {
                const champId = chooseChampionForAction(s, action, myPosition);
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
        // Only processes when the action is truly active and NOT during PLANNING.
        // isActionActive returns true for the first pending action even during PLANNING,
        // so we must explicitly exclude PLANNING here.
        if (!isActionTrulyActive || phase === 'PLANNING') {
            continue;
        }

        // ----- DEBUG: trace pick lock timing when it becomes active -----
        if (action.type === 'pick') {
            const existingStart = actionActiveStartTimes.get(action.id);
            const wasInLastActive = lastActiveActionIds.has(action.id);
            Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] action ${action.id}: isActionTrulyActive=${isActionTrulyActive} phase=${phase} inSetTimeout=${inSetTimeout} existingStart=${existingStart} wasInLastActive=${wasInLastActive}`);
        }

        // Detect newly-active transition: action was not active in the previous call
        // but is active now. Reset lock timer to start counting from when the action
        // truly becomes active. Hover timer is NOT reset — it carries over from
        // PLANNING pre-hover or the hover section's previous push.
        if (!inSetTimeout && !lastActiveActionIds.has(action.id)) {
            if (actionActiveStartTimes.has(action.id)) {
                const existingStart = actionActiveStartTimes.get(action.id);
                Utils.Debug.log(`[AutoSelect] action loop: action ${action.id} (${action.type}) newly active — resetting lock timer (existingStart=${existingStart})`);
                actionActiveStartTimes.delete(action.id);
            }
        }

        if (!actionActiveStartTimes.has(action.id)) {
            actionActiveStartTimes.set(action.id, now);
            if (emberTimerMs !== null && emberTimerMs !== undefined) {
                actionInitialTimers.set(action.id, emberTimerMs - ceremonyPadding);
            }
            Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] action ${action.id}: setting actionActiveStartTimes=${now} initialTimer=${actionInitialTimers.get(action.id) ?? 'N/A'} ceremonyPadding=${ceremonyPadding} mode=${lockSettings.mode} timeMs=${lockSettings.timeMs}`);
            
            const timerActionId = action.id;
            const lockDelay = ceremonyPadding + lockSettings.timeMs;
            if (lockSettings.mode === 'after' && lockSettings.timeMs > 0) {
                setTimeout(async () => {
                    Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] setTimeout callback firing for action ${timerActionId}, inSetTimeout=${inSetTimeout} lastSessionData exists=${!!lastSessionData}`);
                    if (!isEnabled || panicActive || !lastSessionData) return;
                    inSetTimeout = true;
                    try { await processChampSelectSession(lastSessionData); }
                    finally { inSetTimeout = false; }
                }, lockDelay + 50);
            }
        } else {
            if (action.type === 'pick') {
                const existingStart = actionActiveStartTimes.get(action.id);
                const initTimer = actionInitialTimers.get(action.id);
                const timerElapsed = (initTimer !== undefined && emberTimerMs !== null) ? initTimer - emberTimerMs : null;
                Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] action ${action.id}: actionActiveStartTimes ALREADY SET (existing=${existingStart} timerElapsed=${timerElapsed}ms)`);
            }
        }

        const champId = chooseChampionForAction(s, action, myPosition);
        if (!champId) {
            Utils.Debug.log(`[AutoSelect] action loop: action ${action.id} (${action.type}) skipped — no valid champion chosen from priorities`);
            continue;
        }

        const shouldComplete = shouldCompleteAction(s, action, instantPick, instantBan, lockSettings);

        // Wait for lock timer to elapse before completing
        if (!shouldComplete) {
            if (action.type === 'pick') {
                const startTs = actionActiveStartTimes.get(action.id);
                Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] action ${action.id}: shouldComplete=false startTs=${startTs} elapsed=${startTs ? Date.now() - startTs : 'N/A'}ms threshold=${lockSettings.timeMs}ms`);
            }
            continue;
        }

        if (action.championId === champId && action.completed === shouldComplete) {
            Utils.Debug.log(`[AutoSelect] action loop: action ${action.id} (${action.type}) already has championId=${champId} completed=${action.completed} — no-op`);
            continue;
        }

        const lockNow = Date.now();
        const lastLockPatchTime = lastAutoLockKeys.get(action.id + '_lock_time') || 0;
        const cooldownMs = 1500;

        if (lockNow - lastLockPatchTime < cooldownMs) {
            Utils.Debug.log(`[AutoSelect] action loop: action ${action.id} (${action.type}) — ${lockNow - lastLockPatchTime}ms since last lock patch < ${cooldownMs}ms cooldown, skipping`);
            continue;
        }

        if (action.type === 'pick') {
            Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] action ${action.id}: about to LOCK — shouldComplete=${shouldComplete} lockNow=${lockNow} lastLockPatchTime=${lastLockPatchTime} lockElapsedMs=${lockNow - lastLockPatchTime}`);
        }

        lastAutoLockKeys.set(action.id + '_lock_time', lockNow);

        const payload = {
            championId: champId,
            completed: shouldComplete
        };

        const lockStartTs = actionActiveStartTimes.get(action.id);
        const lockElapsedMs = lockStartTs ? Date.now() - lockStartTs : 0;
        try {
            Utils.Debug.log(`[AutoSelect] ${action.type} lock patch`, {
                actionId: action.id,
                phase: getChampSelectPhase(s),
                active: isActionTrulyActive,
                payload,
                actionChampionId: action.championId,
                lockElapsedMs,
                lockTimeSetting: lockSettings.timeMs
            });

            await Utils.LCU.patch(`/lol-champ-select/v1/session/actions/${action.id}`, payload);
            Utils.Debug.log(`[AutoSelect] ${action.type} lock patch sent for action=${action.id}`);
            pluginSetChampionIds.set(action.id, champId);
        } catch (err) {
            Utils.Debug.warn(`[AutoSelect] ${action.type} lock patch failed`, {
                actionId: action.id,
                phase: getChampSelectPhase(s),
                payload,
                err: err?.message ?? err
            });
        }
    }

    // Track which action IDs were active for newly-active detection next call
    const activeIds = new Set(
        (s?.actions ? s.actions.flat(2) : [])
            .filter(a => isActionActive(a, s))
            .map(a => a.id)
    );
    Utils.Debug.log(`[AutoSelect] [DEBUG-pick-lock] lastActiveActionIds updated: phase=${getChampSelectPhase(s)} ids=[${[...activeIds].join(',')}]`);
    lastActiveActionIds = activeIds;
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

function shouldCompleteAction(session, action, instantPick, instantBan, lockSettings) {
    if (!isActionActive(action, session)) return false;

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

function isChampionAvailableForAction(actionType, championId, session) {
    const bannedIds = getBannedChampionIds(session, 'isChampionAvailableForAction');
    if (bannedIds.has(championId)) {
        Utils.Debug.log(`[AutoSelect] isChampionAvailableForAction(${actionType}, ${championId}): blocked by bannedIds=[${[...bannedIds]}]`);
        return false;
    }

    const pickedIds = getPickedChampionIds(session);
    if (actionType === 'pick' && pickedIds.has(championId)) {
        Utils.Debug.log(`[AutoSelect] isChampionAvailableForAction(${actionType}, ${championId}): blocked by pickedIds=[${[...pickedIds]}]`);
        return false;
    }

    // Server-pushed bannable set may shrink as bans happen (guessing)
    if (actionType === 'ban') {
        if (bannableChampionSet && !bannableChampionSet.has(championId)) {
            Utils.Debug.log(`[AutoSelect] isChampionAvailableForAction(${actionType}, ${championId}): blocked by bannableChampionSet (not in set, size=${bannableChampionSet.size})`);
            return false;
        }
    }

    // Team intent awareness: don't ban a champion a teammate is hovering
    if (actionType === 'ban' && Utils.Store.get('autoLockChampion', 'respectTeamIntent') !== false) {
        if (teammateIntents.has(championId)) {
            Utils.Debug.log(`[AutoSelect] isChampionAvailableForAction(${actionType}, ${championId}): blocked by teammate championPickIntent`);
            return false;
        }
    }

    return true;
}

function chooseChampionForAction(session, action, role) {
    const actionType = action.type;

    let priorities = getPriorityList(actionType === 'ban' ? BAN_PRIORITY_KEY : PICK_PRIORITY_KEY, role);
    if (priorities.length === 0 && role !== 'default') {
        priorities = getPriorityList(actionType === 'ban' ? BAN_PRIORITY_KEY : PICK_PRIORITY_KEY, 'default');
    }

    if (priorities.length === 0) {
        Utils.Debug.log(`[AutoSelect] chooseForAction(${actionType}): no priorities for role="${role}"`);
        return null;
    }

    const currentChampionId = Number(action.championId || 0);

    if (currentChampionId && priorities.includes(currentChampionId)) {
        if (isChampionAvailableForAction(actionType, currentChampionId, session)) {
            Utils.Debug.log(`[AutoSelect] chooseForAction(${actionType}): using current championId=${currentChampionId} (still available in priorities)`);
            return currentChampionId;
        }
        Utils.Debug.log(`[AutoSelect] chooseForAction(${actionType}): skipping current ${currentChampionId} (unavailable), falling through to priority iteration`);
    }

    const chosen = priorities.find((championId) => {
        const available = isChampionAvailableForAction(actionType, championId, session);
        Utils.Debug.log(`[AutoSelect] chooseForAction(${actionType}): checking priority champ ${championId} => ${available ? 'AVAILABLE' : 'BLOCKED'}`);
        return available;
    }) || null;

    const bannedIds = getBannedChampionIds(session);
    const pickedIds = getPickedChampionIds(session);
    Utils.Debug.log(`[AutoSelect] chooseForAction(${actionType}): priorities=[${priorities}] banned=[${[...bannedIds]}] picked=[${[...pickedIds]}] bannableSet=${bannableChampionSet?.size ?? 'N/A'} pickableSet=${pickableChampionSet?.size ?? 'N/A'} => chosen=${chosen}`);
    return chosen;
}

function panic() {
    Utils.Debug.log('[AutoSelect] Panic triggered, overriding controls');
    panicActive = true;
    emberTimerCrossed = false;
    lastAutoLockKeys.clear();
    actionActiveStartTimes.clear();
    actionHoverStartTimes.clear();

    Utils.Toast.info('Auto Lock Override — Next champ select will re-enable');
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
    if (isEnabled) mountAutoLockChampion();
    fetchCurrentSummoner();
}