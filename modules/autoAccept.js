/**
 * @name Snooze-AutoAccept
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically accept ready checks with optional delay and decline handling.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';
import { t } from './i18n.js';

const SETTINGS_KEY = 'enabled';
const DELAY_KEY = 'delay';
const EXIT_ON_DECLINE_KEY = 'exitOnDecline';
const EXIT_ON_DODGE_KEY = 'exitOnDodge';
const HIDE_READY_CHECK_KEY = 'hideReadyCheck';
const DELAY_MIN = 0;
const DELAY_MAX = 10;

let isEnabled = false;
let acceptedCurrentReadyCheck = false;
let wasInReadyCheck = false;
let pendingAcceptTimer = null;
let pendingPanicUnsub = null;

function cancelPendingAccept() {
    if (pendingAcceptTimer !== null) clearTimeout(pendingAcceptTimer);
    pendingAcceptTimer = null;
    pendingPanicUnsub?.();
    pendingPanicUnsub = null;
}

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

function exitQueueOnDodge(source) {
    Utils.Debug.log(`[AutoAccept] Dodge detected via ${source}. Exiting queue...`);
    Utils.LCU.delete('/lol-lobby/v2/lobby/matchmaking/search').catch(() => {});
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

    container.appendChild(Utils.Settings.createNumberInputRow(t('Accept Delay (seconds)'), getDelay(), DELAY_MIN, DELAY_MAX, 0.5, (v) => {
        Utils.Store.set('autoAccept', DELAY_KEY, v);
    }));

    // Exit on Decline Toggle
    const exitEnabled = Utils.Store.get('autoAccept', EXIT_ON_DECLINE_KEY) || false;
    container.appendChild(Utils.Settings.createToggleRow(t('Exit queue if someone declines'), exitEnabled, (next) => {
        Utils.Store.set('autoAccept', EXIT_ON_DECLINE_KEY, next);
    }));

    // Exit on Dodge Toggle
    const exitDodgeEnabled = Utils.Store.get('autoAccept', EXIT_ON_DODGE_KEY) || false;
    container.appendChild(Utils.Settings.createToggleRow(t('Exit queue if someone dodges'), exitDodgeEnabled, (next) => {
        Utils.Store.set('autoAccept', EXIT_ON_DODGE_KEY, next);
    }));

    // Hide Ready Check Modal
    const hideReadyCheckEnabled = Utils.Store.get('autoAccept', HIDE_READY_CHECK_KEY) || false;
    container.appendChild(Utils.Settings.createToggleRow(t('Hide queue pop'), hideReadyCheckEnabled, (next) => {
        Utils.Store.set('autoAccept', HIDE_READY_CHECK_KEY, next);
    }));

    // Panic Key Hotkey
    const currentPanicKey = Utils.Store.get('global', 'panicKey') || 'F2';
    container.appendChild(Utils.Settings.createHotkeyRow(
        t('Panic Key (Cancel Auto Actions)'),
        currentPanicKey,
        (newKey) => Utils.Store.set('global', 'panicKey', newKey),
        t('Note: The Panic Key only works if you have set an Accept Delay greater than 0 seconds. You must press the key during the countdown window to cancel the action.')
    ));
}

export function init(context) {
    migrateSettings();

    Utils.Settings.inject(context, {
        name: "auto-accept-settings",
        titleKey: "snooze_auto-accept",
        titleName: t("Auto Accept"),
        capitalTitleKey: "snooze_auto-accept_capital",
        capitalTitleName: t("AUTO ACCEPT"),
        class: "auto-accept-settings"
    });

    isEnabled = Utils.Store.get('autoAccept', SETTINGS_KEY) || false;

    if (Utils.Store.get('autoAccept', DELAY_KEY) === undefined) {
        Utils.Store.set('autoAccept', DELAY_KEY, 0);
    }

    installExitOnDodgeEmberHook();
    installHideReadyCheckEmberHook();

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoAccept',
            name: t('Auto Accept'),
            description: t('Automatically accepts matchmaking ready checks with optional delay and queue exit on decline.'),
            settings: [{
                    type: 'toggle',
                    id: SETTINGS_KEY,
                    label: t('Enable Auto Accept'),
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
                Utils.Settings.createToggleRow(t("Enable Auto Accept"), isEnabled, (val) => {
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
            const phase = e.data;
            const exitOnDecline = Utils.Store.get('autoAccept', EXIT_ON_DECLINE_KEY);

            if (phase === 'ReadyCheck') {
                wasInReadyCheck = true;
                acceptedCurrentReadyCheck = false;
                if (!isEnabled) return;
                if (acceptedCurrentReadyCheck) return;
                acceptedCurrentReadyCheck = true;

                const delay = getDelay();
                if (delay <= 0) {
                    Utils.LCU.post('/lol-matchmaking/v1/ready-check/accept').catch(() => {});
                } else {
                    cancelPendingAccept();
                    let isCancelled = false;
                    pendingPanicUnsub = Utils.Panic.register(() => {
                        isCancelled = true;
                        cancelPendingAccept();
                    });

                    pendingAcceptTimer = setTimeout(() => {
                        pendingAcceptTimer = null;
                        pendingPanicUnsub?.();
                        pendingPanicUnsub = null;
                        if (isCancelled || !isEnabled || !acceptedCurrentReadyCheck) return;
                        Utils.LCU.post('/lol-matchmaking/v1/ready-check/accept').catch(() => {});
                    }, delay * 1000);
                }
            } else if (phase === 'Lobby' && wasInReadyCheck && exitOnDecline) {
                cancelPendingAccept();
                wasInReadyCheck = false;
                acceptedCurrentReadyCheck = false;
                Utils.Debug.log('[AutoAccept] ReadyCheck ended without accepting (decline/timeout). Exiting queue...');
                Utils.LCU.delete('/lol-lobby/v2/lobby/matchmaking/search').catch(() => {});
            } else {
                cancelPendingAccept();
                wasInReadyCheck = false;
                acceptedCurrentReadyCheck = false;
            }
        });

        Utils.LCU.observe('/lol-matchmaking/v1/ready-check', e => {
            if (!e.data || !Utils.Store.get('autoAccept', EXIT_ON_DECLINE_KEY)) return;
            if (e.data.state === 'StrangerNotReady' || e.data.state === 'PartyNotReady') {
                Utils.Debug.log('[AutoAccept] Queue declined by someone. Exiting queue...');
                Utils.LCU.delete('/lol-lobby/v2/lobby/matchmaking/search').catch(() => {});
            }
        });

        Utils.LCU.observe('/lol-lobby/v2/notifications', e => {
            if (!e.data || !Utils.Store.get('autoAccept', EXIT_ON_DODGE_KEY)) return;
            const notifications = Array.isArray(e.data) ? e.data : [e.data];
            for (const n of notifications) {
                if (n.notificationReason === 'StrangerDodged') {
                    exitQueueOnDodge('WS:/lol-lobby/v2/notifications');
                    break;
                }
            }
        });

    }
}

function installHideReadyCheckEmberHook() {
    if (!Utils.Hooks?.Ember?.registerRule) return;
    Utils.Hooks.Ember.registerRule({
        name: 'autoAccept-hideReadyCheck',
        matcher: 'ready-check-root-element',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                const enabled = Utils.Store.get('autoAccept', SETTINGS_KEY) && Utils.Store.get('autoAccept', HIDE_READY_CHECK_KEY);
                if (!enabled) {
                    original(...args);
                    return;
                }
                this._super(...arguments);
                this.registerStateMachineElement();
                this.setUpAudioListeners();
                const e = this.element?.parentElement?.parentElement;
                if (e && e.parentElement) {
                    e.parentElement.removeChild(e);
                }
            }
        }]
    });
}

function installExitOnDodgeEmberHook() {
    if (!Utils.Hooks?.Ember?.registerRule) return;
    Utils.Hooks.Ember.registerRule({
        name: 'autoAccept-exitOnDodge',
        matcher: 'parties-notifications',
        hookMethods: [{
            name: '_strangerDodged',
            callback(Ember, original, ...args) {
                original(...args);
                if (!Utils.Store.get('autoAccept', EXIT_ON_DODGE_KEY)) return;
                exitQueueOnDodge('EmberHook:parties-notifications._strangerDodged');
            }
        }]
    });
}
export function unload() {
    cancelPendingAccept();
    acceptedCurrentReadyCheck = false;
    wasInReadyCheck = false;
}
