/**
 * @name Snooze-ChampSelectQuitButton
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Adds a dodge button in champion select for quick lobby exit.
 * @link https://github.com/ReformedDoge
 */
import { t } from './i18n.js';
import Utils from './generalUtils.js';

let isEnabled = false;

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('champSelectQuitButton', 'enabled', enabled);
    if (!enabled) {
        document.querySelectorAll('#pm-quit-btn').forEach(btn => btn.remove());
    }
}

async function dodgeQueue() {
    const endpoint = '/lol-login/v1/session/invoke?destination=lcdsServiceProxy&method=call&args=["","teambuilder-draft","quitV2",""]';
    for (let i = 0; i < 10; i++) {
        try {
            await Utils.LCU.post(endpoint, '["","teambuilder-draft","quitV2",""]', {
                raw: true
            });
            Utils.Debug.log(`[DodgeButton] quitV2 attempt ${i + 1} sent`);
        } catch (err) {
            Utils.Debug.error(`[DodgeButton] quitV2 attempt ${i + 1} failed:`, err);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    try {
        await Utils.LCU.post('/lol-lobby/v1/lobby/custom/cancel-champ-select', null);
        Utils.Debug.log('[DodgeButton] cancel-champ-select sent');
    } catch (err) {
        Utils.Debug.error('[DodgeButton] cancel-champ-select failed:', err);
    }
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

    Utils.Hooks.Ember.registerRule({
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
    });

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
        Utils.DOM.observer.observe("lol-uikit-scrollable.dodge-button-settings", (plugin) => {
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