/**
 * @name Snooze-ModeSelectorTweaks
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Mode Selector Tweaks:Mode Selector Tweaks: Declutters and cleans up the play screen by hiding unwanted navigation categories, game modes and queues.
 * @link https://github.com/ReformedDoge/Snooze-Manager
 */
import { t } from './i18n.js';
import Utils from './generalUtils.js';

let isEnabled = false;
let hiddenNavs = new Set();
let hiddenModes = new Set();
let hiddenQueues = new Set();
let emberHookRegistered = false;

const NAME_MAP = {
    'kPvP': t('PvP'),
    'kVersusAI': t('Co-op vs. AI'),
    'kTraining': t('Training'),
    'CreateCustom': t('Create Custom'),
    'JoinCustom': t('Join Custom'),
    'CLASSIC': t("Summoner's Rift"),
    'ARAM': t('ARAM'),
    'CHERRY': t('Arena'),
    'TFT': t('Teamfight Tactics'),
    'TUTORIAL': t('Tutorial'),
    'PRACTICETOOL': t('Practice Tool')
};

function getLabel(id) {
    return NAME_MAP[id] || id;
}

const styleId = 'pm-mode-selector-styles';
let styleEl = null;

function ensureStyleElement() {
    if (!styleEl) {
        styleEl = document.getElementById(styleId);
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = styleId;
            document.head.appendChild(styleEl);
        }
    }
}

function refreshCSS() {
    if (!isEnabled) {
        if (styleEl) styleEl.textContent = '';
        return;
    }
    ensureStyleElement();
    let css = '';

    // Automatically hide config button if the game mode selector screen is hidden
    css += `.parties-view:has(.parties-game-select-screen.game-select-hide) #pm-mode-config-btn { display: none !important; }\n`;

    hiddenNavs.forEach(nav => css += `lol-uikit-navigation-item[data-category="${nav}"] { display: none !important; }\n`);
    hiddenModes.forEach(mode => css += `div[data-game-mode="${mode}"] { display: none !important; }\n`);
    hiddenQueues.forEach(qId => css += `div.parties-game-type-card-category-div:has([data-queue-id="${qId}"]) { display: none !important; }\n`);

    // hide the separator logic
    const leftHidden = hiddenNavs.has('kPvP') && hiddenNavs.has('kVersusAI') && hiddenNavs.has('kTraining');
    const rightHidden = hiddenNavs.has('CreateCustom') && hiddenNavs.has('JoinCustom');
    if (leftHidden || rightHidden) {
        css += `.parties-game-navs-break { display: none !important; }\n`;
    }

    styleEl.textContent = css;
    if (EmberRef && partiesViewInstance) {
        EmberRef.run.scheduleOnce('afterRender', null, enforceValidSelection);
    }
}

function findComponentByElementId(view, id) {
    if (!view) return null;
    if (view.elementId === id) return view;

    let children = view.childViews || [];
    if (typeof children.toArray === 'function') children = children.toArray();

    for (let i = 0; i < children.length; i++) {
        const found = findComponentByElementId(children[i], id);
        if (found) return found;
    }
    return null;
}

function enforceValidSelection() {
    if (!isEnabled || !partiesViewInstance || !EmberRef) return;
    if (partiesViewInstance.isDestroyed || partiesViewInstance.isDestroying) return;

    const container = partiesViewInstance.element;
    if (!container) return;

    const activeCard = container.querySelector('.game-type-card.selected');
    const isSelectedModeHidden = activeCard && hiddenModes.has(activeCard.getAttribute('data-game-mode'));

    // 1. Enforce Valid Game Type Card (Mode fallback)
    if (isSelectedModeHidden || !activeCard) {
        const allCards = Array.from(container.querySelectorAll('.game-type-card'));
        const firstVisibleCard = allCards.find(card => !hiddenModes.has(card.getAttribute('data-game-mode')));

        if (firstVisibleCard && partiesViewInstance) {
            const cardView = findComponentByElementId(partiesViewInstance, firstVisibleCard.id);
            if (cardView && typeof cardView.send === 'function') {
                Utils.Debug.log('[ModeSelectorTweaks] Silently focusing valid mode via Ember:', firstVisibleCard.id);

                EmberRef.run(() => {
                    const origPlaySound = cardView.playSound;
                    if (origPlaySound) cardView.playSound = function() {};

                    const parent = cardView.get('parentView');
                    const origParentPlaySound = parent ? parent.playSound : null;
                    if (parent && typeof parent.playSound === 'function') {
                        parent.playSound = function() {};
                    }

                    try {
                        cardView.send('selectGameType');
                    } catch (e) {}
                    try {
                        cardView.send('selectQueue');
                    } catch (e) {}

                    if (origPlaySound) cardView.playSound = origPlaySound;
                    if (parent && origParentPlaySound) parent.playSound = origParentPlaySound;
                });
            } else {
                const clickTarget = firstVisibleCard.querySelector('.parties-game-type-upper-half') || firstVisibleCard;
                clickTarget.click();
            }
            return;
        }
    }

    // 2. Enforce Valid Queue Selection (Queue fallback)
    const currentQueueId = partiesViewInstance.get('selected.queueId');
    if (currentQueueId && hiddenQueues.has(currentQueueId.toString())) {
        if (activeCard) {
            const queueElements = Array.from(activeCard.querySelectorAll('.parties-game-type-card-category-div'));
            const firstValidQueueEl = queueElements.find(el => {
                const btn = el.querySelector('[data-queue-id]');
                return btn && !hiddenQueues.has(btn.getAttribute('data-queue-id'));
            });

            if (firstValidQueueEl) {
                const queueView = findComponentByElementId(partiesViewInstance, firstValidQueueEl.id);
                Utils.Debug.log('[ModeSelectorTweaks] Silently focusing valid queue via DOM Click + Mute:', firstValidQueueEl.id);

                EmberRef.run(() => {
                    let origPlaySound = null;
                    let parent = null;
                    let origParentPlaySound = null;

                    // Pre-mute the queue component to mask the switch
                    if (queueView) {
                        origPlaySound = queueView.playSound;
                        if (origPlaySound) queueView.playSound = function() {};

                        parent = queueView.get('parentView');
                        origParentPlaySound = parent && typeof parent.playSound === 'function' ? parent.playSound : null;
                        if (origParentPlaySound) {
                            parent.playSound = function() {};
                        }
                    }

                    // Native click invokes the proper parent action
                    const btn = firstValidQueueEl.querySelector('[data-queue-id]');
                    if (btn) btn.click();
                    else firstValidQueueEl.click();

                    // Restore sounds
                    if (queueView) {
                        if (origPlaySound) queueView.playSound = origPlaySound;
                        if (origParentPlaySound) parent.playSound = origParentPlaySound;
                    }
                });
            }
        }
    }
}

function saveConfig() {
    Utils.Store.set('modeSelectorTweaks', 'hiddenNavs', Array.from(hiddenNavs));
    Utils.Store.set('modeSelectorTweaks', 'hiddenModes', Array.from(hiddenModes));
    Utils.Store.set('modeSelectorTweaks', 'hiddenQueues', Array.from(hiddenQueues));
    Utils.Debug.log('[ModeSelectorTweaks] Config saved');
}

function loadConfig() {
    hiddenNavs = new Set(Utils.Store.get('modeSelectorTweaks', 'hiddenNavs') || []);
    hiddenModes = new Set(Utils.Store.get('modeSelectorTweaks', 'hiddenModes') || []);
    hiddenQueues = new Set(Utils.Store.get('modeSelectorTweaks', 'hiddenQueues') || []);
}

function injectButton() {
    if (!partiesViewInstance || !partiesViewInstance.element) return;

    const partiesView = partiesViewInstance.element;

    if (partiesView.querySelector('#pm-mode-config-btn')) return;

    const existing = document.getElementById('pm-mode-config-btn');
    if (existing) existing.remove();

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pm-mode-config-btn';
    btn.title = t('Configure Mode Selector');

    // SVG gear icon
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

    // Position relative to the parties-view
    btn.style.cssText = `
        position: absolute; right: 58px; top: 91px;
        background: transparent; color: #c8aa6e; border: none;
        padding: 4px; display: flex; justify-content: center; align-items: center;
        cursor: pointer; opacity: 0.7; transition: opacity 0.2s, color 0.2s;
    `;

    btn.onmouseenter = () => {
        btn.style.opacity = '1';
        btn.style.color = '#f0e6d2';
    };
    btn.onmouseleave = () => {
        btn.style.opacity = '0.7';
        btn.style.color = '#c8aa6e';
    };
    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        Utils.Debug.log('[ModeSelectorTweaks] Opening config modal');
        openConfigModal();
    };

    partiesView.appendChild(btn);
}

function openConfigModal() {
    if (document.getElementById('pm-mode-modal-overlay')) return;

    let modalStyle = document.getElementById('pm-mode-modal-styles');
    if (!modalStyle) {
        modalStyle = document.createElement('style');
        modalStyle.id = 'pm-mode-modal-styles';
        modalStyle.textContent = `
            #pm-mode-modal-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(3px); pointer-events: auto; font-family: var(--font-body), "Segoe UI", sans-serif; }
            #pm-mode-modal { position: relative; z-index: 1; width: 850px; height: 600px; max-height: 85vh; background: rgba(1, 10, 19, 0.75); border: 1px solid rgba(200, 170, 110, 0.2); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; color: #a09b8c; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.05); backdrop-filter: blur(25px) saturate(140%); pointer-events: auto; }
            #pm-mode-modal .pm-header { display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); background: rgba(0, 0, 0, 0.2); flex-shrink: 0; }
            #pm-mode-modal .pm-title { color: #f0e6d2; font-size: 20px; font-weight: bold; margin: 0; text-transform: uppercase; letter-spacing: 1px; }
            #pm-mode-modal .pm-close { background: none; border: none; color: #a09b8c; font-size: 24px; cursor: pointer; padding: 0; line-height: 1; transition: color 0.15s; }
            #pm-mode-modal .pm-close:hover { color: #f0e6d2; }
            #pm-mode-modal .pm-content { flex: 1; padding: 24px; overflow-y: auto; }
            #pm-mode-modal .pm-section-title { color: #c8aa6e; font-size: 18px; font-weight: bold; margin: 0 0 12px 0; text-transform: uppercase; letter-spacing: 0.5px; }
            #pm-mode-modal .pm-grid { display: grid; gap: 10px; margin-bottom: 24px; }
            #pm-mode-modal .pm-row { display: flex; justify-content: space-between; align-items: center; padding: 16px; background: rgba(255, 255, 255, 0.015); border: 1px solid rgba(255, 255, 255, 0.03); border-radius: 8px; transition: all 0.2s ease; cursor: pointer; }
            #pm-mode-modal .pm-row:hover { background: rgba(255, 255, 255, 0.04); border-color: rgba(200, 170, 110, 0.15); }
            #pm-mode-modal .pm-label-wrapper { display: flex; flex-direction: column; gap: 6px; flex: 1; pointer-events: none; }
            #pm-mode-modal .pm-label-title { color: #f0e6d2; font-size: 15px; font-weight: bold; pointer-events: none; }
            #pm-mode-modal .pm-toggle-btn { width: 44px; height: 22px; border-radius: 11px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(200, 170, 110, 0.2); position: relative; cursor: pointer; transition: 0.3s ease; flex-shrink: 0; outline: none; padding: 0; }
            #pm-mode-modal .pm-toggle-btn.on { background: #0ac8b9; border-color: #0ac8b9; }
            #pm-mode-modal .pm-toggle-btn::after { content: ''; position: absolute; top: 1px; left: 1px; width: 18px; height: 18px; background: #a09b8c; border-radius: 50%; transition: 0.3s cubic-bezier(0.2, 0.85, 0.32, 1.2); pointer-events: none; }
            #pm-mode-modal .pm-toggle-btn.on::after { left: 23px; background: #010a13; }
            #pm-mode-modal .pm-toggle-btn:hover::after { background: #f0e6d2; }
            #pm-mode-modal .pm-toggle-btn.on:hover::after { background: #fff; }
            #pm-mode-modal .pm-content::-webkit-scrollbar { width: 6px; }
            #pm-mode-modal .pm-content::-webkit-scrollbar-track { background: transparent; }
            #pm-mode-modal .pm-content::-webkit-scrollbar-thumb { background: rgba(200, 170, 110, 0.15); border-radius: 3px; }
            #pm-mode-modal .pm-content::-webkit-scrollbar-thumb:hover { background: rgba(200, 170, 110, 0.3); }
        `;
        document.head.appendChild(modalStyle);
    }

    const overlay = document.createElement('div');
    overlay.id = 'pm-mode-modal-overlay';
    overlay.onclick = (e) => {
        if (e.target === overlay) overlay.remove();
    };

    const modal = document.createElement('div');
    modal.id = 'pm-mode-modal';

    const header = document.createElement('div');
    header.className = 'pm-header';
    header.innerHTML = `<h2 class="pm-title">${t('Mode Selector Config')}</h2>`;
    const closeBtn = document.createElement('button');
    closeBtn.className = 'pm-close';
    closeBtn.innerHTML = t('✕');
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);
    modal.appendChild(header);

    const content = document.createElement('div');
    content.className = 'pm-content';
    modal.appendChild(content);

    function renderLists() {
        content.innerHTML = '';

        // Scope to parties views
        const container = partiesViewInstance && partiesViewInstance.element ? partiesViewInstance.element : document;

        const navs = [...container.querySelectorAll('lol-uikit-navigation-item[data-category]')].map(el => el.getAttribute('data-category'));
        const modes = [...container.querySelectorAll('.game-type-card')].map(el => el.getAttribute('data-game-mode'));

        const queues = [];
        container.querySelectorAll('.game-type-card').forEach(card => {
            const modeStr = card.getAttribute('data-game-mode');
            if (hiddenModes.has(modeStr)) return;

            card.querySelectorAll('.parties-game-type-card-category-btn[data-queue-id]').forEach(el => {
                queues.push({
                    id: el.getAttribute('data-queue-id'),
                    name: el.childNodes[0]?.nodeValue?.trim() || el.textContent.trim().split('\n')[0]
                });
            });
        });

        content.appendChild(createSection(t('Navigation Tabs'), navs, hiddenNavs, '', '', null, getLabel));
        content.appendChild(createSection(t('Game Modes'), modes, hiddenModes, '', '', renderLists, getLabel));
        content.appendChild(createSection(t('Queues'), queues, hiddenQueues, 'id', 'name', null, (label) => label));
    }

    function createSection(titleText, items, hiddenSet, idKey, labelKey, onToggleCallback, labelFormatter) {
        const sec = document.createElement('div');

        const h3 = document.createElement('div');
        h3.className = 'pm-section-title';
        h3.textContent = titleText;
        sec.appendChild(h3);

        const grid = document.createElement('div');
        grid.className = 'pm-grid';
        sec.appendChild(grid);

        const uniqueItems = [];
        const seen = new Set();
        items.forEach(item => {
            const id = typeof item === 'object' ? item[idKey] : item;
            if (id && !seen.has(id)) {
                seen.add(id);
                uniqueItems.push(item);
            }
        });

        const colCount = uniqueItems.length <= 4 ? 2 : (uniqueItems.length <= 6 ? 3 : 4);
        grid.style.gridTemplateColumns = `repeat(${colCount}, 1fr)`;

        uniqueItems.forEach(item => {
            const id = typeof item === 'object' ? item[idKey] : item;
            const rawLabel = typeof item === 'object' ? item[labelKey] : item;
            const cleanLabel = labelFormatter(rawLabel);

            const row = document.createElement('div');
            row.className = 'pm-row';

            const lblWrapper = document.createElement('div');
            lblWrapper.className = 'pm-label-wrapper';
            const lblTitle = document.createElement('div');
            lblTitle.className = 'pm-label-title';
            lblTitle.textContent = cleanLabel;
            lblWrapper.appendChild(lblTitle);

            const isVisible = !hiddenSet.has(id);
            const toggleBtn = document.createElement('button');
            toggleBtn.type = 'button';
            toggleBtn.className = 'pm-toggle-btn ' + (isVisible ? 'on' : 'off');

            const toggleFn = (e) => {
                if (e) {
                    e.preventDefault();
                    e.stopPropagation();
                }
                const v = !toggleBtn.classList.contains('on');

                if (v) hiddenSet.delete(id);
                else hiddenSet.add(id);

                toggleBtn.className = 'pm-toggle-btn ' + (v ? 'on' : 'off');

                saveConfig();
                refreshCSS();
                if (onToggleCallback) onToggleCallback();
            };

            toggleBtn.onclick = toggleFn;
            row.onclick = toggleFn;

            row.appendChild(lblWrapper);
            row.appendChild(toggleBtn);
            grid.appendChild(row);
        });
        return sec;
    }

    renderLists();

    overlay.appendChild(modal);

    const viewportOverlay = document.querySelector('.rcp-fe-viewport-overlay');
    if (viewportOverlay && viewportOverlay.parentNode === document.body) viewportOverlay.after(overlay);
    else document.body.appendChild(overlay);
}

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('modeSelectorTweaks', 'enabled', enabled);
    Utils.Debug.log('[ModeSelectorTweaks] Feature ' + (enabled ? 'enabled' : 'disabled'));

    if (enabled) {
        refreshCSS();
        injectButton();
    } else {
        if (styleEl) styleEl.textContent = '';
        const btn = document.getElementById('pm-mode-config-btn');
        if (btn) btn.remove();
    }
}

let EmberRef = null;
let partiesViewInstance = null;

export function installEmberHook() {
    if (emberHookRegistered) return;
    emberHookRegistered = true;

    Utils.Hooks.Ember.registerRule({
        name: 'mode-selector-tweaks-hook',
        matcher: 'parties-view',
        mixin(Ember) {
            EmberRef = Ember;
            return {
                init() {
                    this._super(...arguments);
                    this.addObserver('selected.queueId', this, 'checkHiddenSelectionChange');
                    this.addObserver('selected.gameMode', this, 'checkHiddenSelectionChange');
                },
                willDestroy() {
                    this.removeObserver('selected.queueId', this, 'checkHiddenSelectionChange');
                    this.removeObserver('selected.gameMode', this, 'checkHiddenSelectionChange');
                    this._super(...arguments);
                },
                checkHiddenSelectionChange() {
                    if (!isEnabled) return;
                    partiesViewInstance = this;
                    Ember.run.scheduleOnce('afterRender', null, enforceValidSelection);
                },
                didRender() {
                    partiesViewInstance = this;
                    this._super(...arguments);

                    if (!isEnabled) return;

                    refreshCSS();
                    injectButton();
                    Ember.run.scheduleOnce('afterRender', null, enforceValidSelection);
                },
                willDestroyElement() {
                    if (this.element) {
                        const btn = this.element.querySelector('#pm-mode-config-btn');
                        if (btn) btn.remove();
                    }
                    if (partiesViewInstance === this) partiesViewInstance = null;
                    this._super(...arguments);
                }
            };
        }
    });
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: "mode-selector-settings",
        titleKey: "snooze_mode-selector",
        titleName: t("Mode Selector"),
        capitalTitleKey: "snooze_mode-selector_capital",
        capitalTitleName: t("MODE SELECTOR"),
        class: "mode-selector-settings"
    });

    isEnabled = Utils.Store.get('modeSelectorTweaks', 'enabled') || false;
    loadConfig();

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'modeSelectorTweaks',
            name: t('Mode Selector Tweaks'),
            description: t('Declutter the game mode selection screen by hiding entire tabs, modes, or specific queues.'),
            settings: [{
                type: 'toggle',
                id: 'sm:modeSelectorTweaks',
                label: t('Enable Mode Selector Tweaks'),
                value: isEnabled,
                onChange: (val) => toggleFeature(val)
            }]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.mode-selector-settings", (plugin) => {
            plugin.appendChild(Utils.Settings.createToggleRow(t("Enable Mode Selector Tweaks"), isEnabled, (next) => {
                toggleFeature(next);
            }));
        });
    }
}

export function load() {
    installEmberHook();
}