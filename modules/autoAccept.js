/**
 * @name Snooze-AutoAccept
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically accept ready checks with optional delay and decline handling.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

const SETTINGS_KEY = 'enabled';
const DELAY_KEY = 'delay';
const EXIT_ON_DECLINE_KEY = 'exitOnDecline';
const DELAY_MIN = 0;
const DELAY_MAX = 10;

let isEnabled = false;
let acceptedCurrentReadyCheck = false;

function toggleAutoAccept(enabled) {
    isEnabled = enabled;
    Utils.Store.set('autoAccept', SETTINGS_KEY, enabled);
}

function migrateSettings() {
    const currentExitOnDecline = Utils.Store.get('autoAccept', EXIT_ON_DECLINE_KEY);
    const oldExitOnDecline = Utils.Store.get('autoAccept', 'sm:autoAcceptExitOnDecline');

    if (currentExitOnDecline === undefined && oldExitOnDecline !== undefined) {
        Utils.Store.set('autoAccept', EXIT_ON_DECLINE_KEY, oldExitOnDecline);
        Utils.Store.remove('autoAccept', 'sm:autoAcceptExitOnDecline');
    }
}

function getDelay() {
    const v = Utils.Store.get('autoAccept', DELAY_KEY);
    if (v === undefined || v === null) return 0;
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.min(DELAY_MAX, Math.max(DELAY_MIN, n));
}

function renderExtraSettings(container, native = false) {
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '10px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    container.appendChild(Utils.Settings.createNumberInputRow('Accept Delay (seconds)', getDelay(), DELAY_MIN, DELAY_MAX, 0.5, (v) => {
        Utils.Store.set('autoAccept', DELAY_KEY, v);
    }));

    // Exit on Decline Toggle
    const exitEnabled = Utils.Store.get('autoAccept', EXIT_ON_DECLINE_KEY) || false;
    container.appendChild(Utils.Settings.createToggleRow('Exit queue if someone declines', exitEnabled, (next) => {
        Utils.Store.set('autoAccept', EXIT_ON_DECLINE_KEY, next);
    }));

    // Panic Key Hotkey
    const currentPanicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    container.appendChild(Utils.Settings.createHotkeyRow(
        'Panic Key (Cancel Auto Actions)', 
        currentPanicKey, 
        (newKey) => Utils.Store.set('global', 'panicKey', newKey),
        'Note: The Panic Key only works if you have set an Accept Delay greater than 0 seconds. You must press the key during the countdown window to cancel the action.'
    ));
}

export function init(context) {
    migrateSettings();

    Utils.Settings.inject(context, {
        name: "auto-accept-settings",
        titleKey: "snooze_auto-accept",
        titleName: "Auto Accept",
        capitalTitleKey: "snooze_auto-accept_capital",
        capitalTitleName: "AUTO ACCEPT",
        class: "auto-accept-settings"
    });

    isEnabled = Utils.Store.get('autoAccept', SETTINGS_KEY) || false;

    if (Utils.Store.get('autoAccept', DELAY_KEY) === undefined) {
        Utils.Store.set('autoAccept', DELAY_KEY, 0);
    }

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoAccept',
            name: 'Auto Accept Match',
            description: 'Automatically accepts matchmaking ready checks with optional delay and queue exit on decline.',
            settings: [
                {
                    type: 'toggle',
                    id: SETTINGS_KEY,
                    label: 'Enable Auto Accept',
                    value: isEnabled,
                    onChange: (val) => toggleAutoAccept(val)
                },
                {
                    type: 'custom',
                    render: (row) => renderExtraSettings(row)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.auto-accept-settings", (plugin) => {
            const row = document.createElement("div");
            row.classList.add("plugins-settings-row");
        row.appendChild(
            Utils.Settings.createToggleRow("Enable Auto Accept", isEnabled, (val) => {
                isEnabled = val;
                toggleAutoAccept(isEnabled);
            })
        );
            const extraRow = document.createElement("div");
            extraRow.classList.add("plugins-settings-row");
            extraRow.style.marginTop = "10px";
            renderExtraSettings(extraRow, true);
            plugin.appendChild(row);
            plugin.appendChild(extraRow);
        });
    }
}

export function load() {
    if (Utils.LCU && Utils.LCU.observe) {
        Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', e => {
            if (e.data !== 'ReadyCheck') {
                acceptedCurrentReadyCheck = false;
                return;
            }

            if (!isEnabled) return;

            if (acceptedCurrentReadyCheck) return;
            acceptedCurrentReadyCheck = true;

            const delay = getDelay();
            if (delay <= 0) {
                Utils.LCU.post('/lol-matchmaking/v1/ready-check/accept').catch(() => {});
            } else {
                let isCancelled = false;
                const unregisterPanic = Utils.Panic.register(() => {
                    isCancelled = true;
                });

                setTimeout(() => {
                    unregisterPanic();
                    if (isCancelled || !isEnabled || !acceptedCurrentReadyCheck) return;
                    Utils.LCU.post('/lol-matchmaking/v1/ready-check/accept').catch(() => {});
                }, delay * 1000);
            }
        });

        Utils.LCU.observe('/lol-matchmaking/v1/ready-check', e => {
            if (!e.data || !Utils.Store.get('autoAccept', EXIT_ON_DECLINE_KEY)) return;
			// playerResponse === "Declined" ? check needed?
            if (e.data.state === 'StrangerDeclined' || e.data.state === 'PartyDeclined') {
                Utils.Debug.log('[AutoAccept] Queue declined by someone. Exiting queue...');
                Utils.LCU.delete('/lol-matchmaking/v1/search').catch(() => {});
            }
        });
    }
}
