# Use Client In Game Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional module that dismisses the "game in progress" blocker during a live game so the user can browse the client read-only, restoring the blocker automatically when a reconnect is needed.

**Architecture:** A new self-contained module (`modules/useClientDuringGame.js`) subscribes to the LCU gameflow phase. On `InProgress` it injects a scoped `<style>` that hides `.rcp-fe-lol-game-in-progress` and restores the top nav bar; on `Reconnect` / any other phase / toggle-off it removes that style. Wired into `index.js` alongside the other modules.

**Tech Stack:** Vanilla ES modules, Pengu Loader plugin runtime, League LCU HTTP/WebSocket via `Utils.LCU`. No build step, no automated test harness — verification is manual against the live client.

## Global Constraints

- Module file header `@author` / `@link` copy the existing modules verbatim: `SnoozeFest - github@ReformedDoge` / `https://github.com/ReformedDoge`.
- Never add Claude as git author or co-author; no co-author trailer, no "Generated with" line.
- Module default state is OFF (disabled) until the user enables the toggle.
- No new queue / lobby / matchmaking actions — browsing stays read-only.
- Store namespace for this module is the id string `useClientDuringGame`.
- Follow the `autoQueue.js` module shape exactly (init + load exports, `SnoozeManager.registerModule` with native-settings fallback). No `unload` export — teardown happens via the toggle path, matching existing modules.

---

### Task 1: Create the module

**Files:**
- Create: `modules/useClientDuringGame.js`

**Interfaces:**
- Consumes: `Utils` from `./generalUtils.js` — `Utils.LCU.observe(uri, cb)`, `Utils.LCU.get(url)`, `Utils.Store.get/set(ns, key)`, `Utils.Settings.inject(ctx, cfg)`, `Utils.Settings.createToggleRow(label, value, onChange)`, `Utils.DOM.observer.observe(sel, cb)`, `Utils.Debug.log`.
- Produces: `export function init(context)` and `export async function load()` — consumed by `index.js` in Task 2.

- [ ] **Step 1: Write the module file**

Create `modules/useClientDuringGame.js`:

```js
/**
 * @name Snooze-UseClientInGame
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Dismiss the "game in progress" screen so you can browse the client during a live game.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

const STYLE_ID = 'snooze-use-client-in-game-style';

// Hide the full-window in-progress blocker and restore the top nav bar so the
// user can navigate the client while a game is running. Nav-bar selectors are
// confirmed/adjusted against the live client in Task 1 Step 3.
const BYPASS_CSS = `
    .rcp-fe-lol-game-in-progress { display: none !important; }
    .rcp-fe-lol-navigation-bar,
    .lol-nav__list,
    lol-uikit-navigation-bar {
        display: flex !important;
        visibility: visible !important;
        pointer-events: auto !important;
    }
`;

let _currentPhase = null;

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
        titleName: 'Use Client In Game',
        capitalTitleKey: 'snooze_use-client-in-game_capital',
        capitalTitleName: 'USE CLIENT IN GAME',
        class: 'use-client-in-game-settings'
    });

    let isEnabled = Utils.Store.get('useClientDuringGame', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'useClientDuringGame',
            name: 'Use Client In Game',
            description: 'Dismiss the "game in progress" screen so you can browse the client during a live game. The screen returns automatically when a reconnect is needed.',
            settings: [{
                type: 'toggle',
                label: 'Enable Use Client In Game',
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
            plugin.appendChild(Utils.Settings.createToggleRow('Enable Use Client In Game', isEnabled, (next) => {
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

    Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (e) => {
        _currentPhase = e.data;
        Utils.Debug.log('[UseClientInGame]', `Phase → "${_currentPhase}"`);
        applyPhase(_currentPhase);
    });

    // Apply the current phase on load in case a game is already in progress.
    try {
        const phase = await Utils.LCU.get('/lol-gameflow/v1/gameflow-phase');
        _currentPhase = phase;
        applyPhase(phase);
    } catch (e) {
        Utils.Debug.log('[UseClientInGame]', 'Initial phase fetch failed:', e);
    }
}
```

- [ ] **Step 2: Syntax-check the file**

Run: `node --check modules/useClientDuringGame.js`
Expected: no output, exit 0 (file parses).

- [ ] **Step 3: Live verify — enable + start a game**

With the plugin loaded in the client, open the Snooze manager, enable **Use Client In Game**, then start/enter a game so gameflow phase is `InProgress`. Open devtools console.
Expected: `[UseClientInGame] Bypass CSS injected.` logged; `.rcp-fe-lol-game-in-progress` hidden; the top nav bar is visible and clickable to Profile / Collection.
If the nav bar is still hidden or clicks do nothing, inspect the actual nav element in devtools and adjust the selectors in `BYPASS_CSS` to match, then re-verify. (This is the Approach-A selector confirmation called out in the spec.)

- [ ] **Step 4: Commit**

```bash
git add modules/useClientDuringGame.js
git commit -m "feat: add Use Client In Game module"
```

---

### Task 2: Wire the module into the loader

**Files:**
- Modify: `index.js` (import block ~line 1613; init dispatch ~line 1748; load dispatch ~line 1785)

**Interfaces:**
- Consumes: `useClientDuringGameModule.init(ctx)` / `.load()` from Task 1.
- Produces: nothing new — completes registration so the module appears in the manager and runs.

- [ ] **Step 1: Add the import**

In `index.js`, after the line `import * as nameSpooferModule from './modules/nameSpoofer.js';`, add:

```js
import * as useClientDuringGameModule from './modules/useClientDuringGame.js';
```

- [ ] **Step 2: Add the init dispatch**

After the line `if (!_initDisabledIds.has('nameSpoofer')) nameSpooferModule.init(ctx);`, add:

```js
    if (!_initDisabledIds.has('useClientDuringGame')) useClientDuringGameModule.init(ctx);
```

- [ ] **Step 3: Add the load dispatch**

After the line `if (!_disabledIds.has('nameSpoofer')) nameSpooferModule.load();`, add:

```js
    if (!_disabledIds.has('useClientDuringGame')) useClientDuringGameModule.load();
```

- [ ] **Step 4: Syntax-check**

Run: `node --check index.js`
Expected: no output, exit 0.

- [ ] **Step 5: Live verify the full behavior**

Reload the plugin. Run the spec's manual test sequence:
1. Enable module, start a game → blocker hidden, nav usable.
2. Kill the game client mid-match → phase `Reconnect` → blocker + Reconnect button return (console logs `Bypass CSS removed.`).
3. Toggle module OFF during a game → blocker returns immediately.
4. Game ends normally (`WaitingForStats` → `EndOfGame`) → no leftover style, stock behavior.
Expected: all four pass.

- [ ] **Step 6: Commit**

```bash
git add index.js
git commit -m "feat: register Use Client In Game module in loader"
```

---

### Task 3: Document the module in the README

**Files:**
- Modify: `README.md` (Modules bullet list)

**Interfaces:**
- Consumes: nothing. Produces: nothing. Docs only.

- [ ] **Step 1: Add the module bullet**

In `README.md`, in the `### Modules` list, add an alphabetically-placed bullet (after the `Social Panel Tweaks` entry, before `Whale Helper`):

```markdown
- `Use Client In Game`: Dismiss the "game in progress" screen so you can browse the client (profile, collection, match history) during a live game. The screen returns automatically when a reconnect is needed.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: document Use Client In Game module in README"
```

---

## Self-Review

**Spec coverage:**
- New module `modules/useClientDuringGame.js`, id `useClientDuringGame`, default OFF, standalone fallback → Task 1. ✓
- Event-driven on `/lol-gameflow/v1/gameflow-phase`; `InProgress` injects, `Reconnect`/other removes → Task 1 `applyPhase` + `load`. ✓
- Toggle-off during game removes style immediately → Task 1 `onChange` calls `applyPhase`. ✓
- Approach A CSS with live selector confirmation → Task 1 Steps 1 & 3. ✓
- Single toggle via `Settings.inject` + `registerModule` + native fallback → Task 1. ✓
- `index.js` wiring (import + init + load) → Task 2. ✓
- README bullet → Task 3. ✓
- Testing sequence from spec → Task 2 Step 5. ✓
- Approach B (EmberHook nav guard) is a documented fallback only, built only if Task 1 Step 3 shows CSS insufficient — no task, by design.

**Placeholder scan:** none. Selector adjustment in Task 1 Step 3 is a concrete live-verify action, not a code placeholder.

**Type consistency:** `applyPhase(phase)`, `injectBypass()`, `removeBypass()`, `STYLE_ID`, `_currentPhase`, store namespace `useClientDuringGame`, settings class `use-client-in-game-settings` — used identically across all references.
