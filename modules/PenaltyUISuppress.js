/**
 * @name Snooze-PenaltyUISuppress
 * @version 1.1.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Suppresses low priority queue / leaverbuster warnings and player restriction info tooltips in the Ember layer.
 * @link https://github.com/ReformedDoge
 */
import { t } from './i18n.js';
import Utils from './generalUtils.js';

const MODULE_KEY = 'lowPrioWarningSuppress';

function migrateSettings() {
    const currentEnabled = Utils.Store.get(MODULE_KEY, 'enabled');
    const oldEnabled = Utils.Store.get('LowPrioWarningSuppress', 'enabled');

    if (currentEnabled === undefined && oldEnabled !== undefined) {
        Utils.Store.set(MODULE_KEY, 'enabled', oldEnabled);
        Utils.Store.removeModule('LowPrioWarningSuppress');
    }
}

let enabled;

let restrictionInfoEnabled;

let snoozeContext = null;
let modalManager = null;
let bypassModalHook = false;

function setRestrictionInfoEnabled(v) {
    restrictionInfoEnabled = v;
    Utils.Store.set(MODULE_KEY, 'restrictionInfoEnabled', v);
    Utils.Debug.log('[LowPrioWarningSuppress] restriction info suppression enabled state updated to:', v);

    if (v) {
        suppressRestrictionInfo();
    }
}

function setEnabled(v) {
    enabled = v;
    Utils.Store.set(MODULE_KEY, 'enabled', v);
    Utils.Debug.log('[LowPrioWarningSuppress] enabled state updated to:', v);

    if (v) {
        suppress();
    }
}

// Climb deep inside shadow DOM roots to clear any stray modals from test triggers
function findModalWrapperDeep(el) {
    Utils.Debug.log('[LowPrioWarningSuppress] climbing')
    let current = el;
    while (current) {
        if (current.nodeType === Node.ELEMENT_NODE) {
            if (current.matches?.('.modal')) {
                return current;
            }
        }

        if (current.parentNode) {
            current = current.parentNode;
        } else if (current instanceof ShadowRoot) {
            current = current.host;
        } else {
            current = null;
        }
    }
    return null;
}

function suppress() {
    Utils.Debug.log('[LowPrioWarningSuppress] Manual suppress() invoked.');
    const targets = document.querySelectorAll(
        '.parties-queue-error-dialog, .queue-dodge-error-dialog, ' +
        '.ready-check-failer-error-dialog, .disruptive-gameplay-lockout-error-dialog, ' +
        '.leaver-buster-lockout-error-dialog, .low-priority-dialog, ' +
        '.low-priority-queue-warning, .queue-restriction-notification'
    );

    targets.forEach(el => {
        const modal = findModalWrapperDeep(el);
        if (modal) {
            Utils.Debug.log('[LowPrioWarningSuppress] suppress() removing parent modal wrapper:', modal);
            modal.remove();
        } else {
            el.remove();
        }
    });

    document.querySelectorAll('.modal').forEach(modal => {
        const txt = (modal.textContent || '').toLowerCase();
        if (
            txt.includes('low priority') ||
            txt.includes('queue delay') ||
            txt.includes('leaverbuster') ||
            txt.includes('dodge') ||
            txt.includes('failed') ||
            txt.includes('lockout')
        ) {
            if (modal.querySelector('.low-prio-warning-suppress-settings')) return;
            Utils.Debug.log('[LowPrioWarningSuppress] suppress() removing stray penalty modal');
            modal.remove();
        }
    });
}

function suppressRestrictionInfo() {
    Utils.Debug.log('[LowPrioWarningSuppress] suppressRestrictionInfo() invoked.');
    document.querySelectorAll('.player-restriction-info-component, .player-restriction-warning-icon').forEach(el => {
        el.remove();
    });
}

function isLockoutModal(options) {
    if (bypassModalHook) {
        Utils.Debug.log('[LowPrioWarningSuppress] Bypassing lockout check (testing trigger active)');
        return false;
    }
    if (!options || !options.data) return false;

    const contents = options.data.contents;
    if (!contents) return false;

    // String component name
    if (typeof contents === 'string') {
        const lower = contents.toLowerCase();
        return (
            lower === 'parties-queue-error-dialog' ||
            lower === 'queue-dodge-error-dialog' ||
            lower === 'ready-check-failer-error-dialog' ||
            lower === 'disruptive-gameplay-lockout-error-dialog' ||
            lower === 'leaver-buster-lockout-error-dialog' ||
            lower === 'low-priority-dialog'
        );
    }

    // DOM Element (E.g. pre-rendered Component Factory node)
    if (contents.nodeType === Node.ELEMENT_NODE || contents instanceof HTMLElement) {
        // Match the structural class names assigned during component creation
        const hasPenaltyClass = contents.classList?.contains('PartyQueueErrorDialogComponent') ||
            contents.classList?.contains('LowPriorityQueueModalComponent') ||
            contents.matches?.('.parties-queue-error-dialog, .queue-dodge-error-dialog, .ready-check-failer-error-dialog, .disruptive-gameplay-lockout-error-dialog, .leaver-buster-lockout-error-dialog, .low-priority-dialog, .leaver-buster-dialog') ||
            contents.querySelector?.('.parties-queue-error-dialog, .queue-dodge-error-dialog, .ready-check-failer-error-dialog, .disruptive-gameplay-lockout-error-dialog, .leaver-buster-lockout-error-dialog, .low-priority-dialog, .leaver-buster-dialog');

        if (hasPenaltyClass) {
            Utils.Debug.log('[LowPrioWarningSuppress] [LockoutCheck] Lockout class matched inside contents');
            return true;
        }
    }

    return false;
}

function triggerNativeError(errorType) {
    if (!modalManager) {
        Utils.Debug.warn('[LowPrioWarningSuppress] ModalManager not available for triggering native modals');
        return false;
    }

    bypassModalHook = true;
    try {
        Utils.Debug.log('[LowPrioWarningSuppress] Instantiating native matchmaking error modal:', errorType);
        modalManager.add({
            type: 'DialogConfirm',
            data: {
                contents: 'parties-queue-error-dialog',
                errorType: errorType,
                errorData: {
                    errorType: errorType,
                    penalizedSummonerId: '3972163380807424',
                    penaltyTimeRemaining: 540.0,
                    isPenalizedSummoner: true
                }
            }
        });
    } catch (err) {
        Utils.Debug.error('[LowPrioWarningSuppress] Failed to spawn native modal:', err);
        return false;
    } finally {
        bypassModalHook = false;
    }
    return true;
}

function triggerNativeLowPriorityModal() {
    if (!modalManager) {
        Utils.Debug.warn('[LowPrioWarningSuppress] ModalManager not available');
        return false;
    }

    bypassModalHook = true;
    try {
        Utils.Debug.log('[LowPrioWarningSuppress] Instantiating native low priority queue delay modal');
        modalManager.add({
            type: 'DialogConfirm',
            data: {
                contents: 'low-priority-dialog',
                search: {
                    lowPriorityData: {
                        penaltyTime: 540,
                        penaltyTimeRemaining: 540,
                        reason: 'LEAVER_BUSTED'
                    }
                }
            }
        });
    } catch (err) {
        Utils.Debug.error('[LowPrioWarningSuppress] Failed to spawn native low priority modal:', err);
        return false;
    } finally {
        bypassModalHook = false;
    }
    return true;
}

function triggerNativeQueueDodge() {
    return triggerNativeError('QUEUE_DODGER');
}

function triggerNativeReadyCheckFailer() {
    return triggerNativeError('READY_CHECK_FAILER');
}

function triggerNativeDisruptiveGameplayLockout() {
    return triggerNativeError('DISRUPTIVE_GAMEPLAY_LOCKOUT');
}

function triggerNativeLeaverBusterLockout() {
    return triggerNativeError('LEAVER_BUSTER_QUEUE_LOCKOUT');
}

if (typeof window !== 'undefined') {
    window.SnoozeLowPrioWarningSuppress = window.SnoozeLowPrioWarningSuppress || {
        suppress,
        suppressRestrictionInfo,
        setEnabled,
        setRestrictionInfoEnabled,
        triggerNativeLeaverBusterWarning: () => triggerNativeError('LEAVER_BUSTER_QUEUE_DELAY'),
        triggerNativeLowPriorityModal,
        triggerNativeQueueDodge,
        triggerNativeReadyCheckFailer,
        triggerNativeDisruptiveGameplayLockout,
        triggerNativeLeaverBusterLockout,
        get enabled() {
            return enabled;
        },
        get restrictionInfoEnabled() {
            return restrictionInfoEnabled;
        }
    };
}

export function init(context) {
    snoozeContext = context;
    Utils.Debug.log('[LowPrioWarningSuppress] Initializing module...');
    migrateSettings();
    enabled = Utils.Store.get(MODULE_KEY, 'enabled') ?? true;
    restrictionInfoEnabled = Utils.Store.get(MODULE_KEY, 'restrictionInfoEnabled') ?? true;

    Utils.Settings.inject(context, {
        name: 'low-prio-warning-suppress-settings',
        titleKey: 'snooze_penalty-ui-suppress',
        titleName: t('Penalty UI Suppression'),
        capitalTitleKey: 'snooze_penalty-ui-suppress_capital',
        capitalTitleName: t('PENALTY UI SUPPRESSION'),
        class: 'low-prio-warning-suppress-settings'
    });

    // Hook ModalManager.add directly inside rcp-fe-lol-uikit.
    context.rcp.postInit("rcp-fe-lol-uikit", (api) => {
        if (!api || typeof api.getModalManager !== 'function') return;

        const originalGetModalManager = api.getModalManager;
        api.getModalManager = function() {
            modalManager = originalGetModalManager.apply(this, arguments);
            if (modalManager && !modalManager.__snoozeWrapped) {
                modalManager.__snoozeWrapped = true;
                const originalAdd = modalManager.add;
                modalManager.add = function(options) {
                    Utils.Debug.log('[LowPrioWarningSuppress] [ModalManager] add() intercepted options:', options);

                    if (enabled && isLockoutModal(options)) {
                        Utils.Debug.log('[LowPrioWarningSuppress] [ModalManager] BLOCKED native lockout dialogue completely.');
                        return {
                            acceptPromise: Promise.resolve(),
                            declinePromise: Promise.resolve(),
                            closePromise: Promise.resolve(),
                            domNode: document.createElement('div')
                        };
                    }

                    Utils.Debug.log('[LowPrioWarningSuppress] [ModalManager] PERMITTED modal:', options?.data?.contents);
                    return originalAdd.apply(this, arguments);
                };
            }
            return modalManager;
        };
    }, true);

    // Intercept showQueueErrorModal directly on the native matchmaking monitor component
    // This stops the ComponentFactory from ever being invoked.
    if (Utils.Hooks?.Ember?.registerRule) {
        Utils.Debug.log('[LowPrioWarningSuppress] Registering Matchmaking Error Monitor Hook Rule');
        Utils.Hooks.Ember.registerRule({
            name: 'matchmaking-error-monitor-suppress',
            matcher: (args) => {
                return args.some(arg => arg && typeof arg === 'object' && 'showQueueErrorModal' in arg);
            },
            hookMethods: [{
                name: 'showQueueErrorModal',
                callback(Ember, original, ...args) {
                    const [errorType, errorId] = args;
                    Utils.Debug.log(`[LowPrioWarningSuppress] [Ember] showQueueErrorModal() intercepted. errorType: ${errorType}, enabled: ${enabled}`);

                    if (enabled && (
                            errorType.includes('LEAVER_BUSTER') ||
                            errorType.includes('LOW_PRIORITY') ||
                            errorType.includes('DISRUPTIVE_GAMEPLAY') ||
                            errorType === 'QUEUE_DODGER' ||
                            errorType === 'READY_CHECK_FAILER'
                        )) {
                        Utils.Debug.log('[LowPrioWarningSuppress] [Ember] BLOCKED showQueueErrorModal execution completely for:', errorType);

                        const notified = this.get('_notifiedSearchErrorIds') || Ember.Object.create({});
                        notified[errorId] = true;
                        this.set('_notifiedSearchErrorIds', notified);
                        this.set('_isTransitioningState', false);
                        return;
                    }

                    Utils.Debug.log('[LowPrioWarningSuppress] [Ember] Pass-through to original showQueueErrorModal()');
                    return original(...args);
                }
            }]
        });

        // Fallback Ember rules for lockout dialog components
        const matchers = [
            'parties-queue-error-dialog',
            'queue-dodge-error-dialog',
            'ready-check-failer-error-dialog',
            'disruptive-gameplay-lockout-error-dialog',
            'leaver-buster-lockout-error-dialog',
            'low-priority-dialog'
        ];

        matchers.forEach(matcher => {
            Utils.Debug.log(`[LowPrioWarningSuppress] Registering fallback Ember Rule for matcher: ${matcher}`);
            Utils.Hooks.Ember.registerRule({
                name: `${matcher}-suppress`,
                matcher: matcher,
                mixin: (Ember) => ({
                    showError: Ember.computed('errorType', 'dialogSubComponent', function() {
                        const errorType = this.get('errorType');
                        Utils.Debug.log(`[LowPrioWarningSuppress] [Ember] ${matcher} showError evaluated. errorType:`, errorType);

                        if (!enabled) {
                            return !Ember.isEmpty(this.get('dialogSubComponent'));
                        }

                        if (errorType && (
                                errorType.includes('LEAVER_BUSTER') ||
                                errorType.includes('LOW_PRIORITY') ||
                                errorType.includes('DISRUPTIVE_GAMEPLAY') ||
                                errorType === 'QUEUE_DODGER' ||
                                errorType === 'READY_CHECK_FAILER'
                            )) {
                            Utils.Debug.log(`[LowPrioWarningSuppress] [Ember] ${matcher} showError overridden to false`);
                            return false;
                        }
                        return !Ember.isEmpty(this.get('dialogSubComponent'));
                    }),

                    didInsertElement() {
                        this._super(...arguments);
                        Utils.Debug.log(`[LowPrioWarningSuppress] [Ember] ${matcher} didInsertElement fired`);

                        if (!enabled) return;

                        const el = this.$();
                        if (el && el.length) {
                            el.hide();
                            const domNode = el[0];
                            const modal = findModalWrapperDeep(domNode);
                            if (modal) {
                                Utils.Debug.log(`[LowPrioWarningSuppress] [Ember] ${matcher} found deep modal container. Removing.`);
                                modal.remove();
                            } else {
                                el.remove();
                            }
                        }
                    }
                })
            });
        });

        // Suppress player restriction info component (warning icon + tooltip)
        Utils.Debug.log('[LowPrioWarningSuppress] Registering Ember Rule for player-restriction-info-component');
        Utils.Hooks.Ember.registerRule({
            name: 'player-restriction-info-suppress',
            matcher: 'player-restriction-info-component',
            mixin: (Ember) => ({
                isWarningShown: Ember.computed(
                    'isSocialPanelRestrictionEnabled',
                    'isProfileRestrictionsIntegrationEnabled',
                    'hasChatRestriction',
                    'hasRankedRestriction',
                    'hasRedemptionGamesRemaining',
                    'hasRestrictions',
                    function() {
                        if (!restrictionInfoEnabled) {
                            return !this.get('isSocialPanelRestrictionEnabled') && (
                                this.get('isProfileRestrictionsIntegrationEnabled')
                                    ? this.get('hasRestrictions')
                                    : this.get('hasChatRestriction') || this.get('hasRankedRestriction') || this.get('hasRedemptionGamesRemaining')
                            );
                        }
                        Utils.Debug.log('[LowPrioWarningSuppress] [Ember] player-restriction-info-component isWarningShown overridden to false');
                        return false;
                    }
                ),

                didInsertElement() {
                    this._super(...arguments);
                    if (!restrictionInfoEnabled) return;
                    Utils.Debug.log('[LowPrioWarningSuppress] [Ember] player-restriction-info-component didInsertElement hiding element');
                    const el = this.$();
                    if (el && el.length) {
                        el.hide();
                        el.remove();
                    }
                }
            })
        });
    }

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: MODULE_KEY,
            name: t('Penalty UI Suppression'),
            description: t('Suppresses low priority queue, leaverbuster, queue dodge, ready-check-failer warning dialogs, and player restriction info tooltips.'),
            settings: [{
                type: 'toggle',
                id: 'sm:lowPrioWarningSuppress',
                label: t('Low Priority Warning Suppression'),
                value: enabled,
                onChange: (v) => setEnabled(v)
            }, {
                type: 'toggle',
                id: 'sm:restrictionInfoSuppress',
                label: t('Restriction Info Tooltip Suppression'),
                value: restrictionInfoEnabled,
                onChange: (v) => setRestrictionInfoEnabled(v)
            }]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.low-prio-warning-suppress-settings', (plugin) => {
            plugin.innerHTML = '';
            plugin.appendChild(Utils.Settings.createToggleRow(t('Low Priority Warning Suppression'), enabled, (next) => {
                setEnabled(next);
            }));
            plugin.appendChild(Utils.Settings.createToggleRow(t('Restriction Info Tooltip Suppression'), restrictionInfoEnabled, (next) => {
                setRestrictionInfoEnabled(next);
            }));
        });
    }
}

export function load() {
    suppress();
    if (restrictionInfoEnabled) {
        suppressRestrictionInfo();
    }
}