/**
 * @name Snooze-AutoQueue
 * @version 1.2.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically re-queues after a game ends. The Start button
 * queues on demand; can also re-queue your last lobby.
 * @link https://github.com/ReformedDoge
 */
import Utils, { t } from './generalUtils.js';

// Arm on WaitingForStats/PreEndOfGame, fire on EndOfGame
let _armed = false;
// Prevent double-firing
let _queuing = false;
let _phaseUnsub = null;
let _cancelPendingRequeue = null;
let _unloaded = false;

// Start/Stop button in the settings UI (re-queried on re-render)
let _refreshStartButton = null;
// Cancels the active run (post-delay window: ready-wait, search, verify)
let _cancelActiveRun = null;
// Re-evaluates the active lobby-ready wait immediately (used on cancel)
let _waitKick = null;

// Called whenever enabled/queuing state changes so the button re-syncs
function notifyStateChanged() {
    _refreshStartButton?.();
}

// Abort any pending/active auto-queue run (used by Stop button and unload)
function requestStop() {
    _cancelPendingRequeue?.();
    _cancelActiveRun?.();
    _waitKick?.();
}

let _availableQueues = []; // [{ id, name }] from Utils.GameData.Assets
let _queuesLoadPromise = null;

const SEARCH_VERIFY_DELAY_MS = 1500;

// Queue list 
// Normalized names
const QUEUE_NAME_OVERRIDES = {
    4320: 'CO-OP SR (Classic)',
    3280: 'Custom Mayhem (Classic)',
    3270: 'Custom Mayhem',
    3262: 'Custom Draft (Classic)',
    3260: 'Custom Blind (Classic)',
    2450: 'Mayhem (Classic)',
    4310: 'SR (Classic)'
};

function queueDisplayName(q) {
    const id = Number(q.id);
    // Exact id overrides first (same ids gameAnalysisPopup special-cases)
    if (QUEUE_NAME_OVERRIDES[id]) return QUEUE_NAME_OVERRIDES[id];
    // Then the same name/gameMode heuristics normalizeModeName() uses
    const lower = (q.name || '').toLowerCase();
    const gm = (q.gameMode || '').toUpperCase();
    if (gm === 'KIWI_JADE') return t('Mayhem (Classic)');
    if (gm === 'KIWI') return t('ARAM: Mayhem');
    if (lower.includes('mayhem classic')) return t('Mayhem (Classic)');
    if (lower.includes('mayhem')) return t('ARAM: Mayhem');
    if (lower.includes('jade') || gm === 'JADE') return t('SR (Classic)');
    return q.name || q.description || String(id);
}

async function fetchQueues() {
    if (_availableQueues.length > 0) return _availableQueues;
    if (_queuesLoadPromise) return _queuesLoadPromise;

    _queuesLoadPromise = (async () => {
        Utils.Debug.log('[AutoQueue]', t('Loading queues...'));
        try {
            if (!Utils.GameData.Assets._initialized) {
                await Utils.GameData.Assets.init();
            }
            const queues = Utils.GameData.Assets.queues;
            if (!Array.isArray(queues) || queues.length === 0) {
                Utils.Debug.log('[AutoQueue]', 'No queues available from Assets.');
                return [];
            }
            _availableQueues = queues
                .filter(q => q.queueAvailability === 'Available' && q.isVisible)
                .map(q => ({
                    id: q.id,
                    name: queueDisplayName(q)
                }));
            Utils.Debug.log('[AutoQueue]', `Loaded ${_availableQueues.length} queues:`, _availableQueues.map(q => `${q.name}(${q.id})`).join(', '));
            return _availableQueues;
        } catch (e) {
            Utils.Debug.warn('[AutoQueue] Failed to load queues from Assets:', e);
            return [];
        }
    })();

    try {
        return await _queuesLoadPromise;
    } finally {
        _queuesLoadPromise = null;
    }
}

// Lobby helpers 

function isAutoQueueEnabled() {
    return !!Utils.Store.get('autoQueue', 'enabled');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function getCurrentLobby() {
    try {
        return await Utils.LCU.get('/lol-lobby/v2/lobby');
    } catch (e) {
        // 404 when no lobby exists
        return null;
    }
}

function lobbyQueueId(lobby) {
    const q = Number(lobby?.gameConfig?.queueId);
    return Number.isFinite(q) && q > 0 ? q : null;
}

async function inMatchmakingSearch() {
    try {
        const state = await Utils.LCU.get('/lol-lobby/v2/lobby/matchmaking/search-state');
        const s = state?.searchState;
        return s === 'Searching' || s === 'Found';
    } catch (e) {
        return false;
    }
}

/**
 * Event-driven readiness wait - mirrors the native parties frontend: it binds
 * /lol-lobby/v2/lobby over the websocket and drives its Find Match button from
 * lobby.canStartActivity (canStartMatchmaking alias):
 * subscribe to lobby pushes and react the moment the lobby is ready.
 * One initial GET covers the "already sitting in a lobby" case (the push only fires on change). No timeout - waiting continues until ready or cancelled.
 *
 * mode 'adopt':   take the lobby as it is ("requeue last lobby") - the native play-again flow restores the previous lobby, never rewrite it
 * mode 'enforce': make sure the lobby runs the selected queue (create/repair)
 */
function waitForLobbyReady(mode, targetQueueId, isCancelled) {
    return new Promise(resolve => {
        let settled = false;
        let unsub = null;
        let createAttempted = false;
        let rewriteAttemptedFor = null;

        const finish = (result) => {
            if (settled) return;
            settled = true;
            _waitKick = null;
            unsub?.();
            resolve(result);
        };

        const createLobby = async (queueId) => {
            Utils.Debug.log('[AutoQueue]', `POST /lol-lobby/v2/lobby { queueId: ${queueId} }`);
            try {
                await Utils.LCU.post('/lol-lobby/v2/lobby', { queueId: Number(queueId) });
            } catch (e) {
                Utils.Debug.log('[AutoQueue]', 'ERROR creating lobby:', e?.message ?? e);
            }
        };

        const describeLobby = (lobby) => {
            const members = lobby?.members || [];
            const invited = (lobby?.invitations || []).filter(i => i.state === 'INVITED').length;
            const ready = members.filter(m => m.ready).length;
            const leader = members.find(m => m.isLeader);
            return `members=${members.length} ready=${ready}/${members.length} invites=${invited} `
                + `leader=${leader ? (leader.isLocal ? 'you' : (leader.puuid ?? leader.summonerId)) : '?'} `
                + `canStart=${!!lobby?.canStartActivity} queue=${lobbyQueueId(lobby)}`;
        };

        const evaluate = (lobby) => {
            if (settled) return;
            if (isCancelled() || _unloaded) return finish({ ok: false, reason: 'cancelled' });

            if (!lobby || !lobby.gameConfig) {
                // No lobby (yet) - in enforce mode create it once, then wait for the push; in adopt mode there is nothing to adopt.
                if (mode === 'enforce' && !createAttempted) {
                    createAttempted = true;
                    createLobby(targetQueueId);
                }
                return;
            }
            if (!lobby.localMember) return; // member entry not synced yet

            // Diagnostics for the ready wait
            Utils.Debug.log('[AutoQueue]', `lobby: ${describeLobby(lobby)}`);

            if (!lobby.localMember.isLeader) return finish({ ok: false, reason: 'not-leader', lobby });

            const currentQueue = lobbyQueueId(lobby);
            if (mode === 'enforce' && targetQueueId != null && currentQueue !== targetQueueId) {
                // Wrong queue - rewrite the lobby once per observed queue value, then wait for the push of the new lobby
                if (rewriteAttemptedFor !== currentQueue) {
                    rewriteAttemptedFor = currentQueue;
                    createLobby(targetQueueId);
                }
                return;
            }

            // Same condition as the native Find Match button
            if (lobby.canStartActivity) finish({ ok: true, lobby });
        };

        // Event source: the same lobby push the native client UI reacts to
        unsub = Utils.LCU.observe('/lol-lobby/v2/lobby', (e) => evaluate(e?.data));

        // Cancel must take effect immediately, not on the next push
        _waitKick = () => evaluate(null);

        // Single initial state fetch (websocket pushes only fire on change)
        getCurrentLobby().then(lobby => evaluate(lobby)).catch(() => {});
    });
}

// Core re-queue logic 

async function reQueue(trigger) {
    if (_queuing) {
        Utils.Debug.log('[AutoQueue]', `reQueue(${trigger}) called but already queuing - skipped.`);
        return;
    }
    if (!isAutoQueueEnabled()) {
        if (trigger === 'manual') Utils.Toast.warning(t('Enable Auto Queue first.'));
        return;
    }

    // "Requeue last lobby": the native play-again flow restores the previous lobby as-is, so we adopt whatever lobby we land in - no queue needed.
    const requeueLast = !!Utils.Store.get('autoQueue', 'requeueLastLobby');
    let targetQueueId = null;
    if (!requeueLast) {
        targetQueueId = Number(Utils.Store.get('autoQueue', 'queueId'));
        if (!Number.isFinite(targetQueueId) || targetQueueId <= 0) {
            Utils.Debug.log('[AutoQueue]', 'No queue selected in settings - aborting.');
            Utils.Toast.error(t('Auto Queue: no queue selected.'));
            return;
        }
    }

    _queuing = true;
    notifyStateChanged();
    try {
        const delay = Utils.Store.get('autoQueue', 'delay') || 0;
        const delayMs = delay * 1000;

        Utils.Debug.log('[AutoQueue]', `reQueue(${trigger}) - queueId=${requeueLast ? 'last-lobby' : targetQueueId}, delay=${delay}s, requeueLastLobby=${requeueLast}`);

        // From here until the search starts the Panic Key / Stop button aborts immediately.
        let cancelled = false;
        _cancelActiveRun = () => { cancelled = true; };
        const unregisterPanic = Utils.Panic.register(() => { cancelled = true; });
        try {
            if (await inMatchmakingSearch()) {
                Utils.Debug.log('[AutoQueue]', 'Already in matchmaking - nothing to do.');
                if (trigger === 'manual') Utils.Toast.info(t('Auto Queue: already in matchmaking.'));
                return;
            }

            if (trigger === 'endOfGame') {
                // Play-again dismisses the EOG screen; the native client sends us back to the same lobby (with the same queue) after it.
                Utils.Debug.log('[AutoQueue]', 'POST /lol-lobby/v2/play-again');
                try {
                    await Utils.LCU.post('/lol-lobby/v2/play-again');
                    Utils.Debug.log('[AutoQueue]', 'play-again accepted.');
                } catch (e) {
                    Utils.Debug.log('[AutoQueue]', 'ERROR on play-again (may already be in lobby):', e?.message ?? e);
                    // if we're already past EOG the endpoint will 404, continue anyway
                }
            } else if (requeueLast) {
                // Manual "requeue last lobby" needs an existing lobby to adopt
                const lobby = await getCurrentLobby();
                if (!lobby || !lobby.gameConfig) {
                    Utils.Debug.log('[AutoQueue]', 'No lobby to re-queue - aborting.');
                    Utils.Toast.warning(t('Auto Queue: no lobby found to re-queue.'));
                    return;
                }
            }

            // Wait for the lobby to be startable. Parties waiting for members to return from EOG are handled by canStartActivity.
            const mode = requeueLast ? 'adopt' : 'enforce';
            const ready = await waitForLobbyReady(mode, targetQueueId, () => cancelled);
            if (!ready.ok) {
                if (ready.reason === 'cancelled') {
                    Utils.Debug.log('[AutoQueue]', 'Cancelled via Panic Key / Stop - aborting.');
                } else if (ready.reason === 'not-leader') {
                    Utils.Debug.warn('[AutoQueue]', 'Not the party leader - cannot start matchmaking.');
                    Utils.Toast.warning(t('Auto Queue: you are not the party leader.'));
                } else {
                    Utils.Debug.warn('[AutoQueue]', 'Lobby wait ended without readiness - aborting.');
                }
                return;
            }

            // Delay starts once the lobby is actually startable.
            if (delayMs > 0) {
                Utils.Debug.log('[AutoQueue]', `Lobby ready - waiting ${delay}s before searching...`);
                let isCancelled = false;
                await new Promise(resolve => {
                    let settled = false;
                    let unregisterDelayPanic = null;
                    const finish = (cancelledNow = false) => {
                        if (settled) return;
                        settled = true;
                        isCancelled = cancelledNow;
                        clearTimeout(timer);
                        unregisterDelayPanic?.();
                        unregisterDelayPanic = null;
                        if (_cancelPendingRequeue === cancel) _cancelPendingRequeue = null;
                        resolve();
                    };
                    const cancel = () => finish(true);
                    const timer = setTimeout(() => finish(false), delayMs);
                    unregisterDelayPanic = Utils.Panic.register(cancel);
                    _cancelPendingRequeue = cancel;
                });

                if (isCancelled) {
                    Utils.Debug.log('[AutoQueue]', 'Cancelled via Panic Key / Stop - aborting.');
                    return;
                }
                if (!isAutoQueueEnabled()) {
                    Utils.Debug.log('[AutoQueue]', 'Feature was disabled during delay - aborting.');
                    return;
                }
            }

            Utils.Debug.log('[AutoQueue]', `Lobby ready (queueId=${lobbyQueueId(ready.lobby)}) - starting matchmaking search.`);
            try {
                await Utils.LCU.post('/lol-lobby/v2/lobby/matchmaking/search');
                Utils.Debug.log('[AutoQueue]', 'Matchmaking search started.');
                Utils.Toast.success(t('Auto Queue: searching for a match...'));
            } catch (e) {
                Utils.Debug.log('[AutoQueue]', 'ERROR starting matchmaking search:', e?.message ?? e);
                Utils.Toast.error(t('Auto Queue: failed to start matchmaking.'));
                return;
            }

            // Sanity check: the search must not die immediately (eligibility, penalties, ...). Surface the first server error if it does.
            await sleep(SEARCH_VERIFY_DELAY_MS);
            if (cancelled || _unloaded) return;
            try {
                const state = await Utils.LCU.get('/lol-lobby/v2/lobby/matchmaking/search-state');
                const errors = state?.errors;
                if (Array.isArray(errors) && errors.length > 0) {
                    const msg = errors[0]?.message || errors[0]?.errorType || JSON.stringify(errors[0]);
                    Utils.Debug.warn('[AutoQueue]', 'Matchmaking error from server:', msg);
                    Utils.Toast.warning(t('Auto Queue: matchmaking error - {{msg}}', { msg }));
                } else if (state?.searchState && state.searchState !== 'Searching' && state.searchState !== 'Found') {
                    Utils.Debug.warn('[AutoQueue]', `Unexpected search state: ${state.searchState}`);
                }
            } catch (e) {
                // search-state is best-effort only?
            }
        } finally {
            unregisterPanic();
        }
    } catch (e) {
        Utils.Debug.error('[AutoQueue] Unexpected error during reQueue:', e);
    } finally {
        _cancelActiveRun = null;
        _queuing = false;
        notifyStateChanged();
    }
}

// Settings UI helpers 

function renderSettings(container) {
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '12px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    const requeueLastEnabled = !!Utils.Store.get('autoQueue', 'requeueLastLobby');

    // Queue selector
    const queueRow = document.createElement('div');
    Object.assign(queueRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
    });

    const queueLabel = document.createElement('span');
    queueLabel.textContent = t('Queue');
    Object.assign(queueLabel.style, {
        color: '#a09b8c',
        fontSize: '12px',
        whiteSpace: 'nowrap'
    });

    const queueSelect = document.createElement('select');
    Object.assign(queueSelect.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        padding: '5px 8px',
        borderRadius: '2px',
        flex: '1',
        outline: 'none',
        fontSize: '13px'
    });

    function applyQueueSelectDisabled() {
        const checked = !!Utils.Store.get('autoQueue', 'requeueLastLobby');
        queueSelect.disabled = checked;
        queueSelect.style.opacity = checked ? '0.4' : '1';
    }

    async function populateQueueSelect() {
        queueSelect.innerHTML = '';
        const savedId = Utils.Store.get('autoQueue', 'queueId');
        Utils.Debug.log('[AutoQueue]', `Populating queue select - savedId=${savedId}, availableQueues=${_availableQueues}`);
        if (_availableQueues.length === 0) {
            Utils.Debug.log('[AutoQueue]', 'No available queues yet; waiting for queue load.');
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = t('Loading queues...');
            queueSelect.appendChild(opt);
            await fetchQueues();
            if (_availableQueues.length === 0) return;
            queueSelect.innerHTML = '';
        }
        _availableQueues.forEach(q => {
            const opt = document.createElement('option');
            opt.value = String(q.id);
            opt.textContent = `${q.name} (${q.id})`;
            if (String(q.id) === String(savedId)) opt.selected = true;
            queueSelect.appendChild(opt);
        });
        if (!savedId && _availableQueues.length > 0) {
            Utils.Store.set('autoQueue', 'queueId', _availableQueues[0].id);
            queueSelect.value = String(_availableQueues[0].id);
        }
    }

    void populateQueueSelect();

    queueSelect.addEventListener('click', (e) => e.stopPropagation());
    queueSelect.addEventListener('change', (e) => {
        Utils.Store.set('autoQueue', 'queueId', Number(e.target.value));
    });

    queueRow.appendChild(queueLabel);
    queueRow.appendChild(queueSelect);

    // "Requeue last lobby" checkbox - ignores the queue selector above
    const requeueLastRow = Utils.Settings.createToggleRow(
        t('Requeue last lobby (ignores queue selection)'),
        requeueLastEnabled,
        (v) => {
            Utils.Store.set('autoQueue', 'requeueLastLobby', !!v);
            applyQueueSelectDisabled();
        }
    );
    requeueLastRow.addEventListener('click', (e) => e.stopPropagation());
    applyQueueSelectDisabled();

    container.appendChild(requeueLastRow);
    container.appendChild(queueRow);

    const delay = Utils.Store.get('autoQueue', 'delay') || 0;
    container.appendChild(Utils.Settings.createNumberInputRow(t('Delay before queue (seconds)'), delay, 0, 900, 1, (v) => {
        Utils.Store.set('autoQueue', 'delay', v);
    }));

    // Start/Stop button - queues on demand ("from the get-go", no game needed first); turns into Stop while a run is active
    const startRow = document.createElement('div');
    Object.assign(startRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
    });

    const startButton = document.createElement('button');
    Object.assign(startButton.style, {
        background: '#111',
        border: '1px solid #0ac8b9',
        color: '#0ac8b9',
        padding: '8px 24px',
        borderRadius: '2px',
        cursor: 'pointer',
        fontSize: '13px',
        fontWeight: 'bold',
        letterSpacing: '1px',
        textTransform: 'uppercase'
    });

    const setButtonState = () => {
        // Master toggle off: button disabled regardless of a run in flight (the toggle handler aborts the run)
        if (!isAutoQueueEnabled()) {
            startButton.textContent = t('Start');
            startButton.disabled = true;
            startButton.style.opacity = '0.4';
            startButton.style.cursor = 'not-allowed';
            startButton.style.color = '#a09b8c';
            startButton.style.borderColor = '#3e2e13';
            return;
        }
        const running = _queuing;
        const accent = running ? '#e84057' : '#0ac8b9';
        startButton.textContent = running ? t('Stop') : t('Start');
        startButton.disabled = false;
        startButton.style.opacity = '1';
        startButton.style.cursor = 'pointer';
        startButton.style.color = accent;
        startButton.style.borderColor = accent;
    };

    // Re-render sync (settings may be reopened mid-run) + toggle-on/off sync
    _refreshStartButton = () => setButtonState();
    setButtonState();

    startButton.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_queuing) {
            Utils.Debug.log('[AutoQueue]', 'Stop requested via Start/Stop button.');
            requestStop();
        } else {
            reQueue('manual');
        }
    });
    startRow.appendChild(startButton);
    container.appendChild(startRow);

    // Info box
    const guide = '<span style="color:#c8aa6e;font-weight:600;">' + t('Full Automation Guide:') + '</span> '
        + t('For a completely hands-free journey from queue to game, make sure to also enable the following features:')
        + '<br><b>' + t('Auto Accept') + '</b>'
        + '<br><b>' + t('Auto Lock Champion') + '</b>'
        + '<br><b>' + t('Auto Honor') + '</b> (' + t("with the 'Skip Honor' option checked") + ')';
    container.appendChild(Utils.Settings.createInfoBox(guide));

    const currentPanicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    container.appendChild(Utils.Settings.createHotkeyRow(
        t('Panic Key (Cancel Auto Actions)'),
        currentPanicKey,
        (newKey) => Utils.Store.set('global', 'panicKey', newKey),
        t('Note: The Panic Key cancels the auto-queue during the delay countdown and while waiting for the lobby to become ready.')
    ));
}

// Module lifecycle 

export function init(context) {
    Utils.Settings.inject(context, {
        name: 'auto-queue-settings',
        titleKey: 'snooze_auto-queue',
        titleName: t('Auto Queue'),
        capitalTitleKey: 'snooze_auto-queue_capital',
        capitalTitleName: t('AUTO QUEUE'),
        class: 'auto-queue-settings'
    });

    let isEnabled = Utils.Store.get('autoQueue', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoQueue',
            name: t('Auto Queue'),
            description: t('Automatically re-queues after a game ends. The Start button queues on demand. Can also re-queue your last lobby.'),
            settings: [{
                    type: 'toggle',
                    label: t('Enable Auto Queue'),
                    value: isEnabled,
                    onChange: (val) => {
                        isEnabled = val;
                        Utils.Store.set('autoQueue', 'enabled', val);
                        if (!val) requestStop();
                        notifyStateChanged();
                    }
                },
                {
                    type: 'custom',
                    render: (row) => renderSettings(row)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.auto-queue-settings", (plugin) => {
            plugin.appendChild(Utils.Settings.createToggleRow(t("Enable Auto Queue"), isEnabled, (next) => {
                isEnabled = next;
                Utils.Store.set('autoQueue', 'enabled', isEnabled);
                if (!next) requestStop();
                notifyStateChanged();
            }));

            const extraRow = document.createElement("div");
            extraRow.classList.add("plugins-settings-row");
            extraRow.style.marginTop = "10px";
            renderSettings(extraRow);
            plugin.appendChild(extraRow);
        });
    }
}

export async function load() {
    _unloaded = false;
    Utils.Debug.log('[AutoQueue]', 'load() called - loading queues and subscribing to gameflow phase.');
    await fetchQueues();

    if (!Utils.LCU || !Utils.LCU.observe) {
        Utils.Debug.log('[AutoQueue]', 'ERROR: Utils.LCU.observe not available - module inactive.');
        return;
    }

    if (_phaseUnsub) return;

    _phaseUnsub = Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (e) => {
        const enabledNow = isAutoQueueEnabled();
        if (!enabledNow) {
            _armed = false;
            _queuing = false;
            return;
        }

        const phase = e.data;
        Utils.Debug.log('[AutoQueue]', `Phase → "${phase}"  |  armed=${_armed}  queuing=${_queuing}  enabled=${enabledNow}`);

        if (phase === 'WaitingForStats' || phase === 'PreEndOfGame') {
            if (!_armed) Utils.Debug.log('[AutoQueue]', `Arming on "${phase}".`);
            _armed = true;
            return;
        }

        if (phase === 'EndOfGame') {
            if (!_armed) Utils.Debug.log('[AutoQueue]', 'Arming on "EndOfGame".');
            _armed = true;
            Utils.Debug.log('[AutoQueue]', '"EndOfGame" reached while armed - triggering re-queue.');
            _armed = false;
            reQueue('endOfGame');
            return;
        }

        if (_armed) Utils.Debug.log('[AutoQueue]', `Phase "${phase}" - disarming.`);
        _armed = false;
    });
}

export function unload() {
    _unloaded = true;
    _refreshStartButton = null;
    requestStop();
    _cancelPendingRequeue = null;
    _cancelActiveRun = null;
    _waitKick = null;
    _phaseUnsub?.();
    _phaseUnsub = null;
    _armed = false;
    _queuing = false;
}
