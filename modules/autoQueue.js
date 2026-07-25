/**
 * @name Snooze-AutoQueue
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically re-queues after a game ends using your chosen queue and delay.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';
import { t } from './i18n.js';

// Arm on WaitingForStats/PreEndOfGame, fire on EndOfGame
let _armed = false;
// Prevent double-firing
let _queuing = false;
let _phaseUnsub = null;
let _cancelPendingRequeue = null;
let _unloaded = false;

let _availableQueues = []; // [{ id, name }] from Utils.GameData.Assets
let _queuesLoadPromise = null;

// Queue list 

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
                    name: q.name || q.description || String(q.id)
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

// Core re-queue logic 

async function reQueue() {
    if (_queuing) {
        Utils.Debug.log('[AutoQueue]', 'reQueue() called but already queuing — skipped.');
        return;
    }
    _queuing = true;
    try {
        const queueId = Utils.Store.get('autoQueue', 'queueId');
        const delay = Utils.Store.get('autoQueue', 'delay') || 5;
        const enabled = Utils.Store.get('autoQueue', 'enabled');

        Utils.Debug.log('[AutoQueue]', `reQueue() — enabled=${enabled}, queueId=${queueId}, delay=${delay}s`);

        if (!queueId) {
            Utils.Debug.log('[AutoQueue]', 'No queue selected in settings — aborting re-queue.');
            return;
        }

        const delayMs = delay * 1000;
        if (delayMs > 0) {
            Utils.Debug.log('[AutoQueue]', `Waiting ${delay}s before re-queuing...`);
            let isCancelled = false;
            await new Promise(resolve => {
                let settled = false;
                let unregisterPanic = null;
                const finish = (cancelled = false) => {
                    if (settled) return;
                    settled = true;
                    isCancelled = cancelled;
                    clearTimeout(timer);
                    unregisterPanic?.();
                    unregisterPanic = null;
                    if (_cancelPendingRequeue === cancel) _cancelPendingRequeue = null;
                    resolve();
                };
                const cancel = () => finish(true);
                const timer = setTimeout(() => finish(false), delayMs);
                unregisterPanic = Utils.Panic.register(cancel);
                _cancelPendingRequeue = cancel;
            });

            if (isCancelled) {
                Utils.Debug.log('[AutoQueue]', 'Cancelled via Panic Key - aborting.');
                return;
            }
            if (!Utils.Store.get('autoQueue', 'enabled')) {
                Utils.Debug.log('[AutoQueue]', 'Feature was disabled during delay - aborting.');
                return;
            }
        }

        // Play-again dismisses the EOG screen and returns us to a lobby.
        // Immediately overwrite the lobby with the chosen queue.
        Utils.Debug.log('[AutoQueue]', 'POST /lol-lobby/v2/play-again');
        try {
            await Utils.LCU.post('/lol-lobby/v2/play-again');
            Utils.Debug.log('[AutoQueue]', 'play-again accepted.');
        } catch (e) {
            Utils.Debug.log('[AutoQueue]', 'ERROR on play-again (may already be in lobby):', e?.message ?? e);
            // if we're already past EOG the endpoint will 404, continue anyway
        }

        // Small settle pause so the lobby is fully created before we mutate it
        await new Promise(r => setTimeout(r, 500));
        if (_unloaded) return;

        Utils.Debug.log('[AutoQueue]', `POST /lol-lobby/v2/lobby  { queueId: ${queueId} }`);
        try {
            const lobbyRes = await Utils.LCU.post('/lol-lobby/v2/lobby', {
                queueId: Number(queueId)
            });
            Utils.Debug.log('[AutoQueue]', 'Lobby created:', JSON.stringify(lobbyRes)?.slice(0, 120));
        } catch (e) {
            Utils.Debug.log('[AutoQueue]', 'ERROR creating lobby:', e?.message ?? e);
            return;
        }

        Utils.Debug.log('[AutoQueue]', 'POST /lol-lobby/v2/lobby/matchmaking/search');
        try {
            await Utils.LCU.post('/lol-lobby/v2/lobby/matchmaking/search');
            Utils.Debug.log('[AutoQueue]', 'Matchmaking search started — waiting for ready check.');
        } catch (e) {
            Utils.Debug.log('[AutoQueue]', 'ERROR starting matchmaking search:', e?.message ?? e);
        }
    } finally {
        _queuing = false;
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

    async function populateQueueSelect() {
        queueSelect.innerHTML = '';
        const savedId = Utils.Store.get('autoQueue', 'queueId');
        Utils.Debug.log('[AutoQueue]', `Populating queue select — savedId=${savedId}, availableQueues=${_availableQueues}`);
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
    container.appendChild(queueRow);

    const delay = Utils.Store.get('autoQueue', 'delay') || 0;
    container.appendChild(Utils.Settings.createNumberInputRow(t('Delay before re-queue (seconds)'), delay, 0, 60, 1, (v) => {
        Utils.Store.set('autoQueue', 'delay', v);
    }));

    container.appendChild(Utils.Settings.createInfoBox(t(`<span style="color:#c8aa6e;font-weight:600;">Full Automation Guide:</span> For a completely hands-free journey from queue to game, make sure to also enable <b>Auto Accept</b>, <b>Auto Lock Champion</b>, and <b>Auto Honor</b> (with the <i>'Skip Honor'</i> option checked).`)));

    const currentPanicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    container.appendChild(Utils.Settings.createHotkeyRow(
        t('Panic Key (Cancel Auto Actions)'),
        currentPanicKey,
        (newKey) => Utils.Store.set('global', 'panicKey', newKey),
        t('Note: The Panic Key only works if you have set a Delay greater than 0 seconds. You must press the key during the countdown window to cancel the auto-queue.')
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
            description: t('Automatically re-queues into your chosen game mode after a match ends, with configurable delay.'),
            settings: [{
                    type: 'toggle',
                    label: t('Enable Auto Queue'),
                    value: isEnabled,
                    onChange: (val) => {
                        isEnabled = val;
                        Utils.Store.set('autoQueue', 'enabled', val);
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
    Utils.Debug.log('[AutoQueue]', 'load() called — loading queues and subscribing to gameflow phase.');
    await fetchQueues();

    if (!Utils.LCU || !Utils.LCU.observe) {
        Utils.Debug.log('[AutoQueue]', 'ERROR: Utils.LCU.observe not available — module inactive.');
        return;
    }

    if (_phaseUnsub) return;
    _phaseUnsub = Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (e) => {
        const isEnabled = Utils.Store.get('autoQueue', 'enabled');
        if (!isEnabled) {
            _armed = false;
            _queuing = false;
            return;
        }

        const phase = e.data;
        Utils.Debug.log('[AutoQueue]', `Phase → "${phase}"  |  armed=${_armed}  queuing=${_queuing}  enabled=${isEnabled}`);

        if (phase === 'WaitingForStats' || phase === 'PreEndOfGame') {
            if (!_armed) Utils.Debug.log('[AutoQueue]', `Arming on "${phase}".`);
            _armed = true;
            return;
        }

        if (phase === 'EndOfGame') {
            if (!_armed) Utils.Debug.log('[AutoQueue]', 'Arming on "EndOfGame".');
            _armed = true;
            Utils.Debug.log('[AutoQueue]', '"EndOfGame" reached while armed — triggering re-queue.');
            _armed = false;
            reQueue();
            return;
        }

        if (_armed) Utils.Debug.log('[AutoQueue]', `Phase "${phase}" — disarming.`);
        _armed = false;
        _queuing = false;
    });
}
export function unload() {
    _unloaded = true;
    _cancelPendingRequeue?.();
    _cancelPendingRequeue = null;
    _phaseUnsub?.();
    _phaseUnsub = null;
    _armed = false;
    _queuing = false;
}
