/**
 * @name Snooze-ArenaGod
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Enhances Arena mode champion grid and progress display.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';
const SETTINGS_KEY = 'enabled';
const POS_KEY = 'pos';
const PLAYED_ID = '602001';
const FIRST_ID = '602002';
const ARENA_QUEUES = [1700, 1710, 1720];

let isEnabled = false;
let currentArenaMode = false;
let progressCache = null;
let progressPanel = null;

const sheet = new CSSStyleSheet();
sheet.replaceSync(`
  .champion-grid.sm-arena-active .grid-champion[data-sm-status] .grid-champion-overlay {
    opacity: 1 !important;
    display: block !important;
  }

  .champion-grid.sm-arena-active .grid-champion[data-sm-status]::after {
    content: '';
    position: absolute;
    top: 50px;
    left: 33px;
    width: 32px;
    transform: translate(25%, -25%);
    height: 36px;
    z-index: 100;
    pointer-events: none;
    background-size: contain;
    background-repeat: no-repeat;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
  }

  .champion-grid.sm-arena-active .grid-champion[data-sm-status="played"]::after {
    background-image: url("data:image/svg+xml;charset=utf-8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><defs><linearGradient id='psg' x1='0%' y1='0%' x2='100%' y2='100%'><stop offset='0%' stop-color='%23FFD6EC'/><stop offset='100%' stop-color='%23FF69B4'/></linearGradient></defs><path d='M64 10 L79 45 L118 48 L88 72 L97 110 L64 90 L31 110 L40 72 L10 48 L49 45 Z' fill='url(%23psg)' stroke='%23FF4FA0' stroke-width='5' stroke-linejoin='round'/><circle cx='45' cy='44' r='4' fill='white' opacity='0.95'/><circle cx='53' cy='36' r='2' fill='white' opacity='0.8'/><circle cx='85' cy='40' r='3' fill='%23FFF5FA' opacity='0.7'/><ellipse cx='50' cy='66' rx='4' ry='5' fill='%237A1E48'/><ellipse cx='78' cy='66' rx='4' ry='5' fill='%237A1E48'/><circle cx='51' cy='64' r='1.2' fill='white'/><circle cx='79' cy='64' r='1.2' fill='white'/><path d='M52 82 Q64 92 76 82' stroke='%237A1E48' stroke-width='4' fill='none' stroke-linecap='round'/><ellipse cx='40' cy='76' rx='6' ry='3' fill='%23FF9FCF' opacity='0.6'/><ellipse cx='88' cy='76' rx='6' ry='3' fill='%23FF9FCF' opacity='0.6'/></svg>");
  }

  .champion-grid.sm-arena-active .grid-champion[data-sm-status="first"]::after {
    background-image: url("data:image/svg+xml;charset=utf-8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 128 128'><defs><linearGradient id='gg' x1='0%' y1='0%' x2='100%' y2='100%'><stop offset='0%' stop-color='%23FFF3A3'/><stop offset='100%' stop-color='%23F4B400'/></linearGradient></defs><path d='M24 36 C12 36 10 58 26 66' fill='none' stroke='%23D89B00' stroke-width='8' stroke-linecap='round'/><path d='M104 36 C116 36 118 58 102 66' fill='none' stroke='%23D89B00' stroke-width='8' stroke-linecap='round'/><path d='M34 22 H94 V44 C94 72 78 88 64 88 C50 88 34 72 34 44 Z' fill='url(%23gg)' stroke='%23D89B00' stroke-width='5'/><path d='M46 32 Q52 44 48 60' stroke='white' stroke-width='5' opacity='0.5' fill='none' stroke-linecap='round'/><path d='M64 42 L69 54 L82 55 L72 63 L75 76 L64 69 L53 76 L56 63 L46 55 L59 54 Z' fill='%23FFF1A8' stroke='%23E0A800' stroke-width='2'/><rect x='50' y='88' width='28' height='14' rx='4' fill='%23C98700'/><rect x='40' y='102' width='48' height='12' rx='4' fill='%23A86E00'/></svg>");
  }
`);

if (!document.adoptedStyleSheets.includes(sheet)) {
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

function makeDraggable(el) {
    el.addEventListener('pointerdown', (e) => {
        if (e.target.closest('#sm-arena-god-close')) return;
        e.preventDefault();

        const rect = el.getBoundingClientRect();
        el.style.right = '';
        el.style.left = rect.left + 'px';
        el.style.top  = rect.top  + 'px';

        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;

        el.style.cursor = 'grabbing';
        el.setPointerCapture(e.pointerId);

        const onMove = (e) => {
            el.style.left = (e.clientX - offsetX) + 'px';
            el.style.top  = (e.clientY - offsetY) + 'px';
        };

        el.addEventListener('pointermove', onMove);
        el.addEventListener('pointerup', () => {
            el.removeEventListener('pointermove', onMove);
            el.style.cursor = 'grab';
            Utils.Store.set('arenaGod', POS_KEY, { left: el.style.left, top: el.style.top });
        }, { once: true });
    });
}

function updatePanelContent() {
    if (!progressPanel || !progressCache) return;

    const current = progressCache.currentValue || 0;
    const required = progressCache.required || 0;
    const playedCount = progressCache.played?.size || 0;

    const pct = required
        ? Math.min(100, Math.round((current / required) * 100))
        : 0;

    const remaining = Math.max(0, required - current);

    progressPanel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px;">
        <div style="font-size:12px;font-weight:bold;text-transform:uppercase;letter-spacing:.06em;color:#c8aa6e;">
          Arena God
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span style="font-size:12px;color:#b7b1a1;">
            ${remaining} left
          </span>
          <span
            id="sm-arena-god-close"
            style="
              font-size:11px;
              color:#7e786d;
              cursor:pointer;
              line-height:1;
              padding:2px 4px;
              border-radius:3px;
              transition:background .12s ease,color .12s ease;
            "
            title="Close"
          >
            ✕
          </span>
        </div>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:flex-end;margin-bottom:8px;">
        <div>
          <div style="display:flex;align-items:baseline;gap:4px;">
            <span style="font-size:18px;font-weight:700;color:#f0e6d2;">
              ${current}
            </span>
            <span style="font-size:12px;color:#b7b1a1;">
              / ${required} unique champions
            </span>
          </div>
          <div style="font-size:11px;color:#8b8578;margin-top:2px;">
            first place wins
          </div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:13px;font-weight:600;color:#d3c7b3;">
            ${playedCount}
          </div>
          <div style="font-size:10px;color:#6f6a63;margin-top:2px;">
            champions played
          </div>
        </div>
      </div>
      <div style="height:5px;background:#1e2328;border:1px solid #2a2218;border-radius:999px;overflow:hidden;">
        <div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#c8aa6e,#f0e6d2);border-radius:999px;transition:width .2s ease;"></div>
      </div>
    `;

    const closeBtn = progressPanel.querySelector('#sm-arena-god-close');
    if (closeBtn) {
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(255,255,255,0.06)';
            closeBtn.style.color = '#f0e6d2';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'transparent';
            closeBtn.style.color = '#7e786d';
        });
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            progressPanel.remove();
            progressPanel = null;
        });
    }
}

function renderProgressPanel() {
    if (!progressCache || !isEnabled || !currentArenaMode) {
        if (progressPanel) { progressPanel.remove(); progressPanel = null; }
        return;
    }

    if (!progressPanel || !document.body.contains(progressPanel)) {
        progressPanel = document.createElement('div');
        progressPanel.id = 'sm-arena-god-progress';

        const savedPos = Utils.Store.get('arenaGod', POS_KEY);
        if (savedPos) {
            progressPanel.style.cssText = `position:fixed;left:${savedPos.left};top:${savedPos.top};z-index:19000;min-width:200px;background:rgba(1,10,19,0.92);border:1px solid #785a28;border-radius:3px;box-shadow:0 8px 24px rgba(0,0,0,0.45);padding:10px 12px;color:#f0e6d2;font-family:var(--font-body),sans-serif;cursor:grab;`;
        } else {
            progressPanel.style.cssText = `position:fixed;right:1.7vw;top:80vh;z-index:19000;min-width:200px;background:rgba(1,10,19,0.92);border:1px solid #785a28;border-radius:3px;box-shadow:0 8px 24px rgba(0,0,0,0.45);padding:10px 12px;color:#f0e6d2;font-family:var(--font-body),sans-serif;cursor:grab;`;
        }

        document.body.appendChild(progressPanel);
        makeDraggable(progressPanel);
    }

    updatePanelContent();
}

async function refreshProgress() {
    try {
        const res = await Utils.LCU.get('/lol-challenges/v1/challenges/local-player');
        const firstPlaceData = res?.[FIRST_ID] || {};
        progressCache = {
            played: new Set((res?.[PLAYED_ID]?.completedIds || []).map(Number)),
            first: new Set((firstPlaceData.completedIds || []).map(Number)),
            currentValue: Number(firstPlaceData.currentValue || 0),
            required: Number(firstPlaceData.thresholds?.MASTER?.value || 60)
        };
        renderProgressPanel();
    } catch (e) {}
}

async function handlePhaseChange(phase) {
    if (phase === 'ChampSelect' && isEnabled) {
        const session = await Utils.LCU.get('/lol-gameflow/v1/session').catch(() => null);
        const mode = (session?.gameData?.queue?.gameMode || '').toLowerCase();
        const qId = session?.gameData?.queue?.id;

        if (mode === 'cherry' || mode === 'arena' || ARENA_QUEUES.includes(qId)) {
            currentArenaMode = true;
            await refreshProgress();
        }
    } else {
        if (currentArenaMode) {
            currentArenaMode = false;
            if (progressPanel) { progressPanel.remove(); progressPanel = null; }
            document.querySelectorAll('.champion-grid').forEach(el => el.classList.remove('sm-arena-active'));
            document.querySelectorAll('.grid-champion[data-sm-status]').forEach(el => el.removeAttribute('data-sm-status'));
        }
    }
}

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('arenaGod', SETTINGS_KEY, enabled);
    Utils.LCU.get('/lol-gameflow/v1/gameflow-phase').then(handlePhaseChange).catch(() => {});
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: 'arena-god-settings',
        titleKey: 'snooze_arena-god',
        titleName: 'Arena God',
        capitalTitleKey: 'snooze_arena-god_capital',
        capitalTitleName: 'ARENA GOD',
        class: 'arena-god-settings'
    });

    isEnabled = Utils.Store.get('arenaGod', SETTINGS_KEY) || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'arenaGod',
            name: 'Arena God Tracker',
            description: 'Enhances Arena mode champion grid and progress display natively with status icons on individual grid tiles.',
            settings: [{
                type: 'toggle',
                id: SETTINGS_KEY,
                label: 'Enable Arena God Tracker',
                description: 'Marks played and first-place champions on the Arena grid and shows a progress panel',
                value: isEnabled,
                onChange: (val) => toggleFeature(val)
            }]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.arena-god-settings', (plugin) => {
            plugin.innerHTML = '';
            plugin.appendChild(Utils.Settings.createToggleRow('Enable Arena God Tracker', isEnabled, (next) => {
                isEnabled = next;
                Utils.Store.set('arenaGod', SETTINGS_KEY, isEnabled);
                toggleFeature(isEnabled);
            }));
        });
    }

    // Hook individual Arena champion grid cells directly
    Utils.Hooks.Ember.registerRule({
        name: 'arena-god-grid-champion-hook',
        matcher: 'grid-champion',
        mixin() {
            return {
                didRender() {
                    this._super(...arguments);
                    if (!isEnabled || !currentArenaMode || !this.element || !progressCache) return;
                    
                    const id = this.get('championConfiguration.champion.id');
                    if (!id) return;
                    
                    // Ensure the parent container knows the grid is active
                    const gridContainer = this.element.closest('.champion-grid');
                    if (gridContainer && !gridContainer.classList.contains('sm-arena-active')) {
                        gridContainer.classList.add('sm-arena-active');
                    }
                    
                    if (progressCache.first.has(id)) {
                        this.element.setAttribute('data-sm-status', 'first');
                    } else if (progressCache.played.has(id)) {
                        this.element.setAttribute('data-sm-status', 'played');
                    } else {
                        this.element.removeAttribute('data-sm-status');
                    }
                },
                willDestroyElement() {
                    if (this.element) {
                        this.element.removeAttribute('data-sm-status');
                    }
                    this._super(...arguments);
                }
            };
        }
    });
}

export function load() {
    Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', e => handlePhaseChange(e.data));
    Utils.LCU.get('/lol-gameflow/v1/gameflow-phase').then(handlePhaseChange).catch(() => {});
}