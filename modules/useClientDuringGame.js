/**
 * @name Snooze-UseClientInGame
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Dismiss the "game in progress" screen so you can browse the client during a live game.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';
import { t } from './i18n.js';

const STYLE_ID = 'snooze-use-client-in-game-style';

// Hide the full-window in-progress blocker and un-hide the nav bar so the user
// can navigate the client while a game is running. The nav bar is a persistent
// chrome screen that stays mounted but is inline `visibility: hidden` during a
// game; un-hiding it lets nav clicks re-mount Profile/Collection/etc. into the
// (otherwise empty) content area. Selectors confirmed against the live client.
const BYPASS_CSS = `
    .rcp-fe-lol-game-in-progress { display: none !important; }
    .rcp-fe-lol-navigation {
        visibility: visible !important;
    }
    /* Block queueing a new game while a match is live. */
    .patcher-play-button {
        opacity: 0.4 !important;
        cursor: default !important;
    }
    .patcher-play-button,
    .patcher-play-button * {
        pointer-events: none !important;
    }
`;

let _currentPhase = null;
let _phaseUnsub = null;

function injectBypass() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = BYPASS_CSS;
    document.head.appendChild(style);
    Utils.Debug.log('[UseClientInGame]', 'Bypass CSS injected.');
}

function removeBypass() {
    const style = document.getElementById(STYLE_ID);
    if (!style) return;
    style.remove();
    Utils.Debug.log('[UseClientInGame]', 'Bypass CSS removed.');
}

// Single source of truth: inject only when enabled AND actively in a game.
// Reconnect / EndOfGame / any other phase (and toggle-off) remove the style,
// which brings the in-progress screen + Reconnect button back automatically.
function applyPhase(phase) {
    const enabled = Utils.Store.get('useClientDuringGame', 'enabled');
    if (enabled && phase === 'InProgress') {
        injectBypass();
    } else {
        removeBypass();
    }
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: 'use-client-in-game-settings',
        titleKey: 'snooze_use-client-in-game',
        titleName: t('Use Client In Game'),
        capitalTitleKey: 'snooze_use-client-in-game_capital',
        capitalTitleName: t('USE CLIENT IN GAME'),
        class: 'use-client-in-game-settings'
    });

    let isEnabled = Utils.Store.get('useClientDuringGame', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'useClientDuringGame',
            name: t('Use Client In Game'),
            description: t('Dismiss the "game in progress" screen so you can browse the client during a live game. The screen returns automatically when a reconnect is needed.'),
            settings: [{
                type: 'toggle',
                label: t('Enable Use Client In Game'),
                value: isEnabled,
                onChange: (val) => {
                    isEnabled = val;
                    Utils.Store.set('useClientDuringGame', 'enabled', val);
                    applyPhase(_currentPhase);
                }
            }]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.use-client-in-game-settings', (plugin) => {
            plugin.appendChild(Utils.Settings.createToggleRow(t('Enable Use Client In Game'), isEnabled, (next) => {
                isEnabled = next;
                Utils.Store.set('useClientDuringGame', 'enabled', isEnabled);
                applyPhase(_currentPhase);
            }));
        });
    }
}

export async function load() {
    if (!Utils.LCU || !Utils.LCU.observe) {
        Utils.Debug.log('[UseClientInGame]', 'ERROR: Utils.LCU.observe unavailable — module inactive.');
        return;
    }

    if (!_phaseUnsub) {
        _phaseUnsub = Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (e) => {
            _currentPhase = e.data;
            Utils.Debug.log('[UseClientInGame]', `Phase → "${_currentPhase}"`);
            applyPhase(_currentPhase);
        });
    }

    // Apply the current phase on load in case a game is already in progress.
    try {
        const phase = await Utils.LCU.get('/lol-gameflow/v1/gameflow-phase');
        _currentPhase = phase;
        applyPhase(phase);
    } catch (e) {
        Utils.Debug.log('[UseClientInGame]', 'Initial phase fetch failed:', e);
    }
}
export function unload() {
    _phaseUnsub?.();
    _phaseUnsub = null;
    _currentPhase = null;
    removeBypass();
}
