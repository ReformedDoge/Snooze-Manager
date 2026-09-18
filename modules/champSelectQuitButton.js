/**
 * @name Snooze-ChampSelectQuitButton
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Adds a dodge button in champion select for quick lobby exit.
 * @link https://github.com/ReformedDoge
 */
import Utils, { t } from './generalUtils.js';

let isEnabled = false;
let _hookCleanups = [];
let _domObserverCleanup = null;

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('champSelectQuitButton', 'enabled', enabled);
    if (!enabled) {
        document.querySelectorAll('#pm-quit-btn').forEach(btn => btn.remove());
    }
}

async function dodgeQueue() {
    Utils.Debug.log('[DodgeButton] Initiating champion select dodge...');
    let succeeded = false;

    // 1. Primary: Official Riot champion select quit endpoint
    try {
        await Utils.LCU.post('/lol-lobby-team-builder/champ-select/v1/session/quit', {});
        Utils.Debug.log('[DodgeButton] /lol-lobby-team-builder/champ-select/v1/session/quit succeeded');
        succeeded = true;
    } catch (err) {
        Utils.Debug.warn('[DodgeButton] team-builder session quit failed:', err);
        // Fallback: gameflow dodge endpoint
        try {
            await Utils.LCU.post('/lol-gameflow/v1/session/dodge', {});
            Utils.Debug.log('[DodgeButton] /lol-gameflow/v1/session/dodge sent');
            succeeded = true;
        } catch (dodgeErr) {
            Utils.Debug.warn('[DodgeButton] gameflow dodge failed:', dodgeErr);
        }
    }

    // Fallback: Custom lobby champ-select cancel
    try {
        await Utils.LCU.post('/lol-lobby/v1/lobby/custom/cancel-champ-select', {});
        Utils.Debug.log('[DodgeButton] /lol-lobby/v1/lobby/custom/cancel-champ-select sent');
    } catch (err) {
        Utils.Debug.debug('[DodgeButton] custom cancel-champ-select skipped or failed:', err);
    }

    // 2. Clean up matchmaking search state so the client doesn't get stuck in "Finding Match (0:00)"
    const cancelSearch = async () => {
        try { await Utils.LCU.delete('/lol-lobby/v2/lobby/matchmaking/search'); } catch (e) {}
        try { await Utils.LCU.delete('/lol-matchmaking/v1/search'); } catch (e) {}
    };

    await cancelSearch();
    setTimeout(cancelSearch, 300);

    return succeeded;
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: "dodge-button-settings",
        titleKey: "snooze_dodge-button",
        titleName: t('Dodge Button'),
        capitalTitleKey: "snooze_dodge-button_capital",
        capitalTitleName: t('DODGE BUTTON'),
        class: "dodge-button-settings"
    });

    isEnabled = Utils.Store.get('champSelectQuitButton', 'enabled') || false;

    _hookCleanups.push(Utils.Hooks.Ember.registerRule({
        name: 'champ-select-quit-button-hook',
        matcher: 'champion-select',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                original(...args);
                if (!Utils.Store.get('champSelectQuitButton', 'enabled')) return;
                if (!this.element) return;

                const container = this.element.querySelector('.bottom-right-buttons');
                if (!container) return;

                if (!container.querySelector('#pm-quit-btn')) {
                    const btn = document.createElement('lol-uikit-flat-button');
                    btn.id = 'pm-quit-btn';
                    btn.textContent = t('Dodge');
                    btn.style.cssText = 'margin-right: 10px; margin-top: 5px; width: auto; min-width: 80px; text-align: center;';

                    let dodging = false;
                    btn.onclick = async () => {
                        if (dodging) return;
                        dodging = true;
                        btn.disabled = true;
                        try {
                            await dodgeQueue();
                        } finally {
                            setTimeout(() => {
                                dodging = false;
                                btn.disabled = false;
                            }, 1000);
                        }
                    };

                    if (container.firstChild) {
                        container.insertBefore(btn, container.firstChild);
                    } else {
                        container.appendChild(btn);
                    }
                }
            }
        }, {
            name: 'willDestroyElement',
            callback(Ember, original, ...args) {
                const btn = document.getElementById('pm-quit-btn');
                if (btn) btn.remove();
                original(...args);
            }
        }]
    }));

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'champSelectQuitButton',
            name: t('Champ Select Dodge Button'),
            description: t('Adds a dodge button in the champion select.'),
            settings: [{
                type: 'toggle',
                id: 'sm:champSelectQuitButton',
                label: t('Enable Champ Select Dodge Button'),
                value: isEnabled,
                onChange: (val) => toggleFeature(val)
            }]
        });
    } else {
        _domObserverCleanup = Utils.DOM.observer.observe("lol-uikit-scrollable.dodge-button-settings", (plugin) => {
            plugin.appendChild(Utils.Settings.createToggleRow("Enable Dodge Button", isEnabled, (next) => {
                isEnabled = next;
                toggleFeature(isEnabled);
            }));
        });
    }
}

export function load() {
    // Rely exclusively on Ember Hook rendering the component to manage DOM lifecycle.
}

export function unload() {
    for (const cleanup of _hookCleanups) cleanup?.();
    _hookCleanups = [];
    if (typeof _domObserverCleanup === 'function') _domObserverCleanup();
    _domObserverCleanup = null;
}