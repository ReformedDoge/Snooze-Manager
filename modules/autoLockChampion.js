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
let actionActiveStartTimes = new Map(); // actionId -> timestamp when it first became isInProgress
let lastBanDebugKey = '';

let currentSummonerId = null;
let currentPuuid = null;
let emberTimerMs = null;
let lastSessionData = null;
let emberTimerCrossed = false;
let unregisterPanic = null;
let panicActive = false;

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

    // Panic Key Hotkey
    const currentPanicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    container.appendChild(Utils.Settings.createHotkeyRow(
        'Panic Key (Cancel Auto Lock)',
        currentPanicKey,
        (newKey) => Utils.Store.set('global', 'panicKey', newKey),
        'Press the panic key at any point during champion select to cancel auto-lock for the current champion select only. Next champ select will re-enable automatically.'
    ));

}

function completePendingActions() {
    const s = lastSessionData;
    if (!isEnabled || !s) return;
    const allActions = s.actions ? s.actions.flat(2) : [];
    const myActions = allActions.filter(a => {
        if (a.actorCellId !== s.localPlayerCellId || a.completed) return false;
        if (a.type !== 'pick' && a.type !== 'ban') return false;
        return a.isInProgress;
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
        const lastPatchTime = lastAutoLockKeys.get(action.id + '_time') || 0;
        if (now - lastPatchTime < 1500) continue;
        lastAutoLockKeys.set(action.id + '_time', now);
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
        titleName: "Auto Select Champ",
        capitalTitleKey: "snooze_autolock_capital",
        capitalTitleName: "AUTO SELECT CHAMP",
        class: "autolock-settings"
    });

    isEnabled = Utils.Store.get('autoLockChampion', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoLockChampion',
            name: 'Auto Select Champion',
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

    lastSessionData = s;

    Utils.Debug.log('[AutoSelect] processChampSelectSession: timer=', s?.timer, 'phase=', s?.phase);

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

    const allActions = s.actions ? s.actions.flat(2) : [];
    logBanSessionState(s, allActions, myPosition);

    Utils.Debug.log('[AutoSelect] all my actions:', allActions.filter(a => a.actorCellId === s.localPlayerCellId).map(a => ({
        id: a.id, type: a.type, completed: a.completed, isInProgress: a.isInProgress, championId: a.championId
    })));

    const myActions = allActions.filter(a => {
        if (a.actorCellId !== s.localPlayerCellId || a.completed) return false;
        if (a.type !== 'pick' && a.type !== 'ban') return false;

        if (a.isInProgress) return true;
        if (a.type === 'pick' && getChampSelectPhase(s) === 'PLANNING') return true;

        return false;
    });

    if (myActions.length === 0) {
        Utils.Debug.log('[AutoSelect] no myActions — clearing start times (phase:', getChampSelectPhase(s), ')');
        lastAutoLockKeys.clear();
        actionActiveStartTimes.clear();
        return;
    }

    Utils.Debug.log('[AutoSelect] processing actions:', myActions.map(a => ({
        id: a.id, type: a.type, completed: a.completed, isInProgress: a.isInProgress, championId: a.championId
    })));

    const instantPick = Utils.Store.get('autoLockChampion', 'instantPick') !== false;
    const instantBan = Utils.Store.get('autoLockChampion', 'instantBan') !== false;
    const lockSettings = getLockSettings();
    const hoverDelayMs = getHoverDelayMs();
    const now = Date.now();

    for (const action of myActions) {
        const phase = getChampSelectPhase(s);
        const isReadyForHover =
            (action.type === 'pick' && (action.isInProgress || phase === 'PLANNING')) ||
            (action.type === 'ban' && action.isInProgress && phase === 'BAN_PICK');

        if (isReadyForHover && !actionActiveStartTimes.has(action.id)) {
            actionActiveStartTimes.set(action.id, now);

            // Schedule a re-evaluation when the hover delay expires
            if (hoverDelayMs > 0) {
                setTimeout(() => {
                    if (!isEnabled || panicActive) return;
                    Utils.LCU.get('/lol-champ-select/v1/session').then(s => {
                        if (s) processChampSelectSession(s);
                    }).catch(() => {});
                }, hoverDelayMs + 50);
            }
            if (lockSettings.mode === 'after' && lockSettings.timeMs > 0) {
                setTimeout(() => {
                    if (!isEnabled || panicActive) return;
                    Utils.LCU.get('/lol-champ-select/v1/session').then(s => {
                        if (s) processChampSelectSession(s);
                    }).catch(() => {});
                }, lockSettings.timeMs + 50);
            }
        }

        if (!actionActiveStartTimes.has(action.id)) {
            continue;
        }

        const champId = chooseChampionForAction(s, action, myPosition);
        if (!champId) continue;

        const shouldComplete = shouldCompleteAction(s, action, instantPick, instantBan, lockSettings);

        // Hover delay: wait if not locking and delay hasn't elapsed
        if (!shouldComplete && hoverDelayMs > 0) {
            const elapsed = now - actionActiveStartTimes.get(action.id);
            if (elapsed < hoverDelayMs) {
                Utils.Debug.log(`[AutoSelect] Hover delay: ${elapsed}ms elapsed, waiting ${hoverDelayMs}ms before hovering action ${action.id}`);
                continue;
            }
        }

        if (action.championId === champId && action.completed === shouldComplete) {
            continue;
        }

        const lastPatchTime = lastAutoLockKeys.get(action.id + '_time') || 0;
        const cooldownMs = 1500;

        if (now - lastPatchTime < cooldownMs) {
            continue;
        }

        lastAutoLockKeys.set(action.id + '_time', now);

        const payload = {
            championId: champId,
            completed: shouldComplete
        };

        try {
            Utils.Debug.log(`[AutoSelect] ${action.type} patch`, {
                actionId: action.id,
                phase: getChampSelectPhase(s),
                isInProgress: !!action.isInProgress,
                payload
            });

            await Utils.LCU.patch(`/lol-champ-select/v1/session/actions/${action.id}`, payload);
        } catch (err) {
            Utils.Debug.warn(`[AutoSelect] ${action.type} patch failed`, {
                actionId: action.id,
                phase: getChampSelectPhase(s),
                payload,
                err
            });
        }
    }
}

function getChampSelectPhase(session) {
    return session?.timer?.phase || session?.phase || 'unknown';
}

function shouldCompleteAction(session, action, instantPick, instantBan, lockSettings) {
    if (!action.isInProgress) return false;

    const phase = getChampSelectPhase(session);
    
    if (action.type === 'ban' && (!instantBan || phase !== 'BAN_PICK')) return false;
    if (action.type === 'pick' && !instantPick) return false;

    if (lockSettings.timeMs > 0) {
        if (lockSettings.mode === 'after') {
            const startTs = actionActiveStartTimes.get(action.id);
            if (startTs) {
                const elapsed = Date.now() - startTs;
                return elapsed >= lockSettings.timeMs;
            }
            return false;
        } else {
            let timerSrc = 'none';
            let timeRemaining = null;

            // Raw session snapshot + elapsed time (fresh LCU push, accounts for elapsed time even with stale session)
            if (session?.timer?.adjustedTimeLeftInPhase !== undefined && session?.timer?.internalNowInEpochMs !== undefined) {
                timeRemaining = Math.max(session.timer.adjustedTimeLeftInPhase - (Date.now() - session.timer.internalNowInEpochMs), 0);
                timerSrc = 'raw-adjusted';
            }
            // Ember timer fallback (when raw session lacks timer data)
            if (timeRemaining === null && emberTimerMs !== null && emberTimerMs !== undefined) {
                timeRemaining = emberTimerMs;
                timerSrc = 'ember';
            }
            // raw snapshot value directly
            if (timeRemaining === null && session?.timer?.adjustedTimeLeftInPhase !== undefined) {
                timeRemaining = session.timer.adjustedTimeLeftInPhase;
                timerSrc = 'raw-snapshot';
            }

            if (timeRemaining !== null) {
                const shouldComplete = timeRemaining <= lockSettings.timeMs;
                Utils.Debug.log(`[AutoSelect] lockBeforeEnd: timer=${timeRemaining}ms, threshold=${lockSettings.timeMs}ms, complete=${shouldComplete}, src=${timerSrc}`);
                return shouldComplete;
            }
            Utils.Debug.warn('[AutoSelect] lockBeforeEnd enabled but no timer source available, falling through to instant');
        }
    }

    return true;
}

function logBanSessionState(session, allActions, myPosition) {
    const banActions = allActions.filter((action) => action.type === 'ban');
    if (banActions.length === 0) return;

    const compactActions = banActions.map((action) => ({
        id: action.id,
        actorCellId: action.actorCellId,
        isAllyAction: action.isAllyAction,
        isInProgress: action.isInProgress,
        completed: action.completed,
        championId: action.championId
    }));

    const debugState = {
        phase: getChampSelectPhase(session),
        localPlayerCellId: session.localPlayerCellId,
        myPosition,
        banPriority: getPriorityList(BAN_PRIORITY_KEY, myPosition),
        bannedChampionIds: [...getBannedChampionIds(session)],
        banActions: compactActions
    };
    const debugKey = JSON.stringify(debugState);
    if (debugKey === lastBanDebugKey) return;
    lastBanDebugKey = debugKey;

    Utils.Debug.log('[AutoSelect] ban state', debugState);
}

function getBannedChampionIds(session) {
    const bans = new Set();

    if (session?.actions) {
        session.actions.flat(2).forEach(action => {
            if (action.type === 'ban' && action.championId && action.completed) {
                bans.add(Number(action.championId));
            }
        });
    }

    return bans;
}

function getPickedChampionIds(session) {
    const players = [...(session?.myTeam || []), ...(session?.theirTeam || [])];
    return new Set(players
        .filter((player) => player.cellId !== session?.localPlayerCellId)
        .map((player) => Number(player.championId))
        .filter(Boolean));
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

    const bannedIds = getBannedChampionIds(session);
    const pickedIds = getPickedChampionIds(session);
    const currentChampionId = Number(action.championId || 0);

    if (currentChampionId && priorities.includes(currentChampionId)) {
        const banned = bannedIds.has(currentChampionId);
        const picked = actionType === 'pick' && pickedIds.has(currentChampionId);
        if (!banned && !picked) {
            return currentChampionId;
        }
        Utils.Debug.log(`[AutoSelect] chooseForAction(${actionType}): skipping current ${currentChampionId} (banned=${banned} picked=${picked})`);
    }

    const chosen = priorities.find((championId) => {
        if (bannedIds.has(championId)) return false;
        if (actionType === 'pick' && pickedIds.has(championId)) return false;
        return true;
    }) || null;

    Utils.Debug.log(`[AutoSelect] chooseForAction(${actionType}): priorities=[${priorities}] banned=[${[...bannedIds]}] picked=[${[...pickedIds]}] => chosen=${chosen}`);
    return chosen;
}

function panic() {
    Utils.Debug.log('[AutoSelect] Panic triggered, overriding controls');
    panicActive = true;
    emberTimerCrossed = false;
    lastAutoLockKeys.clear();
    actionActiveStartTimes.clear();

    Utils.Toast.info('Auto Lock Override — Next champ select will re-enable');
}

function mountAutoLockChampion() {
    if (!Utils.LCU || !Utils.LCU.observe || autoLockSessionUnsub) return;
    panicActive = false;
    unregisterPanic = Utils.Panic.register(panic);
    autoLockSessionUnsub = Utils.LCU.observe('/lol-champ-select/v1/session', e => {
        processChampSelectSession(e.data);
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
    lastAutoLockKeys.clear();
    actionActiveStartTimes.clear();
    lastBanDebugKey = '';
}

export function load() {
    if (isEnabled) mountAutoLockChampion();
    fetchCurrentSummoner();
}