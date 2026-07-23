/**
 * @name Snooze-ARAMNoCD
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Removes ARAM bench cooldowns.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';
import { t } from './i18n.js';

let isEnabled = false;

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('aramNocd', 'enabled', enabled);
}

function makeComputedOverride(Ember, valueToForce) {
    const version = Ember.VERSION ? parseFloat(Ember.VERSION) : 1.0;
    if (version >= 1.12) {
        return Ember.computed({
            get() {
                return isEnabled ? valueToForce : false;
            },
            set(key, value) {
                return isEnabled ? valueToForce : value;
            }
        });
    } else {
        return Ember.computed(function(key, value) {
            if (arguments.length > 1) {
                return isEnabled ? valueToForce : value;
            }
            return isEnabled ? valueToForce : false;
        });
    }
}

// Common mixin definition
const getCooldownMixin = (Ember) => ({
    init() {
        if (typeof this._super === 'function') {
            this._super(...arguments);
        }
        if (isEnabled) {
            this.set('onCooldownFromAllySwap', false);
            this.set('showCooldownAnimation2', false);
            this.set('showCooldownAnimation3', false);
            this.set('benchSwapOnCooldown', false);
            this.set('benchSoundOnCooldown', false);
            this.set('pendingRequest', false);
        }
    },
    _triggerCooldownAnimation() {
        if (isEnabled) {
            this.set('onCooldownFromAllySwap', false);
            this.set('showCooldownAnimation2', false);
            this.set('showCooldownAnimation3', false);
            return;
        }
        if (typeof this._super === 'function') {
            return this._super(...arguments);
        }
    },
    // Force active state block properties to false
    onCooldownFromAllySwap: makeComputedOverride(Ember, false),
    showCooldownAnimation2: makeComputedOverride(Ember, false),
    showCooldownAnimation3: makeComputedOverride(Ember, false),
    benchSwapOnCooldown: makeComputedOverride(Ember, false),
    benchSoundOnCooldown: makeComputedOverride(Ember, false),
    pendingRequest: makeComputedOverride(Ember, false)
});

export function init(context) {
    Utils.Settings.inject(context, {
        name: "aram-nocd-settings",
        titleKey: "snooze_aram-nocd",
        titleName: t("ARAM No Cooldown"),
        capitalTitleKey: "snooze_aram-nocd_capital",
        capitalTitleName: t("ARAM NO COOLDOWN"),
        class: "aram-nocd-settings"
    });

    isEnabled = Utils.Store.get('aramNocd', 'enabled') || false;

    // Hook the parent bench container
    Utils.Hooks.Ember.registerRule({
        name: 'aram-nocd-bench-hook',
        matcher: 'champion-bench',
        mixin(Ember) {
            const base = getCooldownMixin(Ember);
            return {
                ...base,
                championClicked() {
                    if (isEnabled) {
                        this.set('benchSwapOnCooldown', false);
                        this.set('pendingRequest', false);
                    }
                    if (typeof this._super === 'function') {
                        return this._super(...arguments);
                    }
                }
            };
        }
    });

    // Hook the individual bench slots
    Utils.Hooks.Ember.registerRule({
        name: 'aram-nocd-bench-item-hook',
        matcher: 'champion-bench-item',
        mixin(Ember) {
            const base = getCooldownMixin(Ember);
            return {
                ...base,
                click() {
                    if (isEnabled) {
                        this.set('onCooldownFromAllySwap', false);
                        this.set('benchSwapOnCooldown', false);
                    }
                    if (typeof this._super === 'function') {
                        return this._super(...arguments);
                    }
                }
            };
        }
    });

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'aramNocd',
            name: t('ARAM No Cooldown'),
            description: t('Removes the cooldown when swapping champions with the ARAM bench.'),
            settings: [{
                type: 'toggle',
                id: 'sm:aramNocd',
                label: t('Enable ARAM No Cooldown'),
                value: isEnabled,
                onChange: (val) => toggleFeature(val)
            }]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.aram-nocd-settings", (plugin) => {
            plugin.appendChild(Utils.Settings.createToggleRow(t("Enable ARAM No Cooldown"), isEnabled, (next) => {
                isEnabled = next;
                toggleFeature(isEnabled);
            }));
        });
    }
}

export function load() {
    // Managed by the Ember rules
}