/**
 * @name Snooze-Manager
 * @version 1.0.2
 * @author SnoozeFest - github@ReformedDoge
 * @description Modular plugin manager
 * @link https://github.com/ReformedDoge
 */
import Utils from './modules/generalUtils.js';

function log(...args) {
    Utils.Debug.log('[Snooze-Manager]', ...args);
}

// Update Checker 
const GITHUB_RELEASES_API =
    'https://api.github.com/repos/ReformedDoge/Snooze-Manager/releases/latest';

let CURRENT_VERSION = '1.0.0'; // fallback; overwritten by syncVersionWithMetadata
let _latestRelease = null; // { version, url, name, body } or null
let _updateCheckPending = false;
let _updateBadgeCallback = null; // set by the Settings tab while it's open
let _welcomeUpdateCallback = null; // set by the first-launch welcome modal while it's open

const DEFAULT_MENU_HOTKEY = {
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    code: 'F1',
    display: 'F1'
};

function getMenuHotkey() {
    const stored = Utils.Store.get('core', 'hotkeyObj');
    if (stored && typeof stored === 'object') return stored;

    const legacy = Utils.Store.get('core', 'hotkey');
    if (typeof legacy === 'string') {
        return {
            ctrlKey: false,
            shiftKey: false,
            altKey: false,
            metaKey: false,
            code: legacy,
            display: legacy
        };
    }

    return {
        ...DEFAULT_MENU_HOTKEY
    };
}

async function syncVersionWithMetadata() {
    try {
        const indexUrl = new URL('./index.js', import.meta.url);
        const response = await fetch(indexUrl);
        const text = await response.text();
        const match = text.match(/@version\s+([\d.]+)/);
        if (match && match[1]) {
            CURRENT_VERSION = match[1];
            log('Version synced:', CURRENT_VERSION);
        }
    } catch (err) {
        Utils.Debug.warn('[Snooze-Manager] Failed to sync version:', err);
    }
}

function _parseVersion(v) {
    return (v || '').replace(/^v/, '').trim();
}

function _isNewerVersion(latest, current) {
    const l = _parseVersion(latest).split('.').map(Number);
    const c = _parseVersion(current).split('.').map(Number);
    for (let i = 0; i < Math.max(l.length, c.length); i++) {
        const lv = l[i] || 0;
        const cv = c[i] || 0;
        if (lv > cv) return true;
        if (lv < cv) return false;
    }
    return false;
}

export async function checkForUpdates(force = false) {
    const autoCheck = Utils.Store.get('core', 'checkUpdates');
    if (autoCheck === false && !force) return;
    if (_updateCheckPending) return;
    _updateCheckPending = true;
    try {
        const resp = await fetch(GITHUB_RELEASES_API);
        if (!resp.ok) return;
        const data = await resp.json();
        const latestVersion = _parseVersion(data.tag_name || data.name || '');
        if (latestVersion && _isNewerVersion(latestVersion, CURRENT_VERSION)) {
            _latestRelease = {
                version: latestVersion,
                url: data.html_url || 'https://github.com/ReformedDoge/Snooze-Manager/releases',
                name: data.name || `v${latestVersion}`,
                body: (data.body || '').slice(0, 500),
            };
        } else {
            _latestRelease = null;
        }
        if (_updateBadgeCallback) _updateBadgeCallback(_latestRelease);
        if (_welcomeUpdateCallback) _welcomeUpdateCallback(_latestRelease);
    } catch (err) {
        Utils.Debug.warn('[Snooze-Manager] Update check failed:', err);
    } finally {
        _updateCheckPending = false;
    }
}

const Modal = (function() {
    let _root = null;
    let _visible = false;
    const _cbs = new Set();

    function create() {
        const old = document.getElementById('pm-root');
        if (old) old.remove();

        const styleId = 'pm-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
      #pm-root { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center; font-family: var(--font-body), "Segoe UI", sans-serif; }
      #pm-root.pm-show { display: flex; }
      #pm-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); backdrop-filter: blur(3px); pointer-events: auto; }
      #pm-modal { position: relative; z-index: 1; width: 850px; height: 600px; max-height: 85vh; background: rgba(1, 10, 19, 0.75); border: 1px solid rgba(200, 170, 110, 0.2); border-radius: 12px; display: flex; flex-direction: column; overflow: hidden; color: #a09b8c; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.05); backdrop-filter: blur(25px) saturate(140%); pointer-events: auto; }
      .pm-header { display: flex; justify-content: space-between; align-items: center; padding: 20px 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); background: rgba(0, 0, 0, 0.2); flex-shrink: 0; }
      .pm-title { color: #f0e6d2; font-size: 20px; font-weight: bold; margin: 0; text-transform: uppercase; letter-spacing: 1px; }
      .pm-close { background: none; border: none; color: #a09b8c; font-size: 24px; cursor: pointer; padding: 0; line-height: 1; transition: color 0.15s; }
      .pm-close:hover { color: #f0e6d2; }
      .pm-body { display: flex; flex: 1; overflow: hidden; }
      .pm-sidebar { width: 240px; border-right: 1px solid rgba(255, 255, 255, 0.06); display: flex; flex-direction: column; overflow-y: auto; background: rgba(0, 0, 0, 0.1); flex-shrink: 0; }
      .pm-tab { padding: 14px 20px; cursor: pointer; color: #a09b8c; font-size: 14px; font-weight: 600; border-bottom: 1px solid rgba(255, 255, 255, 0.02); transition: all 0.2s ease; border-left: 3px solid transparent; }
      .pm-tab:hover { background: rgba(200, 170, 110, 0.08); color: #f0e6d2; }
      .pm-tab.active { background: rgba(200, 170, 110, 0.15); color: #c8aa6e; border-left-color: #c8aa6e; }
      .pm-content { flex: 1; padding: 18px; overflow-y: auto; position: relative; }
      .pm-tab-content { display: none; animation: fadeIn 0.2s ease-in-out; }
      .pm-tab-content.active { display: block; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
      .pm-section-title { color: #c8aa6e; font-size: 18px; font-weight: bold; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px; }
      .pm-search { display: flex; gap: 8px; margin-bottom: 12px; }
      .pm-input { flex: 1; background: #111; border: 1px solid #3e2e13; color: #f0e6d2; padding: 8px 14px; border-radius: 2px; outline: none; font-size: 13px; transition: border-color 0.2s, background-color 0.2s; }
      .pm-input:focus { border-color: #c8aa6e; background: rgba(0, 0, 0, 0.5); }
      .pm-btn { background: rgba(200, 170, 110, 0.08); border: 1px solid rgba(200, 170, 110, 0.25); color: #c8aa6e; padding: 8px 10px; cursor: pointer; border-radius: 2px; font-weight: bold; transition: all 0.2s ease; font-size: 13px; }
      .pm-btn:hover { background: rgba(200, 170, 110, 0.16); color: #f0e6d2; border-color: #c8aa6e; }
      .pm-row { display: flex; justify-content: space-between; align-items: center; padding: 16px; background: rgba(255, 255, 255, 0.015); border: 1px solid rgba(255, 255, 255, 0.03); margin-bottom: 10px; border-radius: 8px; transition: all 0.2s ease; }
      .pm-row:hover { background: rgba(255, 255, 255, 0.04); border-color: rgba(200, 170, 110, 0.15); }
      .pm-label-wrapper { display: flex; flex-direction: column; gap: 6px; flex: 1; pointer-events: none; }
      .pm-label-title { color: #f0e6d2; font-size: 15px; font-weight: bold; pointer-events: none; }
      .pm-label-desc { color: #a09b8c; font-size: 12px; pointer-events: none; line-height: 1.4; }
      
      /* Pill Toggle styles */
      .pm-toggle-btn { width: 44px; height: 22px; border-radius: 11px; background: rgba(0, 0, 0, 0.4); border: 1px solid rgba(200, 170, 110, 0.2); position: relative; cursor: pointer; transition: 0.3s ease; flex-shrink: 0; outline: none; padding: 0; }
      .pm-toggle-btn.on { background: #0ac8b9; border-color: #0ac8b9; }
      .pm-toggle-btn::after { content: ''; position: absolute; top: 1px; left: 1px; width: 18px; height: 18px; background: #a09b8c; border-radius: 50%; transition: 0.3s cubic-bezier(0.2, 0.85, 0.32, 1.2); pointer-events: none; }
      .pm-toggle-btn.on::after { left: 23px; background: #010a13; }
      .pm-toggle-btn:hover::after { background: #f0e6d2; }
      .pm-toggle-btn.on:hover::after { background: #fff; }
      
      .pm-sidebar::-webkit-scrollbar, .pm-content::-webkit-scrollbar { width: 6px; }
      .pm-sidebar::-webkit-scrollbar-track, .pm-content::-webkit-scrollbar-track { background: transparent; }
      .pm-sidebar::-webkit-scrollbar-thumb, .pm-content::-webkit-scrollbar-thumb { background: rgba(200, 170, 110, 0.15); border-radius: 3px; }
      .pm-sidebar::-webkit-scrollbar-thumb:hover, .pm-content::-webkit-scrollbar-thumb:hover { background: rgba(200, 170, 110, 0.3); }

      /* Settings tab */
      .pm-tab-settings { margin-top: auto; border-top: 1px solid rgba(255,255,255,0.06); display: flex; align-items: center; gap: 8px; }
      .pm-tab-settings svg { flex-shrink: 0; opacity: 0.7; }
      .pm-tab-settings.active svg { opacity: 1; }
      .pm-settings-section { margin-bottom: 24px; }
      .pm-settings-section-title { color: #c8aa6e; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 4px; }
      .pm-settings-section-desc { color: #4a6070; font-size: 12px; line-height: 1.5; margin-bottom: 10px; }
      .pm-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; padding: 12px 14px; border: 1px solid rgba(255,255,255,0.03); border-radius: 8px; background: rgba(255,255,255,0.015); }
      .plugins-settings-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; padding: 12px 14px; border: 1px solid rgba(255,255,255,0.03); border-radius: 8px; background: rgba(255,255,255,0.015); color: #a09b8c; }
      .plugins-settings-row label,
      .plugins-settings-row span,
      .plugins-settings-row .pm-label-title,
      .plugins-settings-row .pm-label-desc { color: #a09b8c; }
      .pm-settings-row-label { font-size: 13px; color: #8a9aaa; }
      .pm-update-status { margin-top: 10px; padding: 8px 10px; background: rgba(0,0,0,0.2); border: 1px solid #1a2535; font-size: 12px; line-height: 1.6; border-radius: 4px; }
      .pm-update-status.has-update { border-color: #785a28; background: rgba(200,170,110,0.06); }
      .pm-update-title { font-size: 13px; font-weight: 600; color: #c8aa6e; margin-bottom: 4px; }
      .pm-update-rel-name { font-size: 12px; color: #8a9aaa; margin-bottom: 6px; }
      .pm-update-notes { font-size: 12px; color: #4a6070; margin-bottom: 8px; white-space: pre-wrap; max-height: 80px; overflow: hidden; }
      .pm-update-link { font-size: 12px; color: #785a28; text-decoration: underline; cursor: pointer; }
      .pm-update-check-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
      .pm-update-check-status { font-size: 12px; color: #4a6070; }
      `;
            document.head.appendChild(style);
        }

        _root = document.createElement('div');
        _root.id = 'pm-root';

        const overlay = document.createElement('div');
        overlay.id = 'pm-overlay';
        overlay.addEventListener('click', () => hide());

        const modal = document.createElement('div');
        modal.id = 'pm-modal';

        const header = document.createElement('div');
        header.className = 'pm-header';
        header.innerHTML = '<h2 class="pm-title">Snooze-Manager</h2>';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'pm-close';
        closeBtn.innerHTML = '&#x2715;';
        closeBtn.addEventListener('click', () => hide());
        header.appendChild(closeBtn);
        modal.appendChild(header);

        const body = document.createElement('div');
        body.className = 'pm-body';

        const sidebar = document.createElement('div');
        sidebar.className = 'pm-sidebar';

        const content = document.createElement('div');
        content.className = 'pm-content';

        body.appendChild(sidebar);
        body.appendChild(content);
        modal.appendChild(body);

        let activeTabId = 'tab-lookup';

        function switchTab(tabId) {
            activeTabId = tabId;
            sidebar.querySelectorAll('.pm-tab').forEach(t => t.classList.remove('active'));
            content.querySelectorAll('.pm-tab-content').forEach(c => c.classList.remove('active'));

            const tab = sidebar.querySelector(`[data-target="${tabId}"]`);
            const tabContent = content.querySelector(`#${tabId}`);
            if (tab) tab.classList.add('active');
            if (tabContent) tabContent.classList.add('active');
        }

        function createTab(id, title, isActive = false) {
            const tab = document.createElement('div');
            tab.className = 'pm-tab' + (isActive ? ' active' : '');
            tab.setAttribute('data-target', id);
            tab.textContent = title;
            tab.addEventListener('click', () => switchTab(id));
            sidebar.appendChild(tab);
        }

        // Search Section (Player Lookup)
        createTab('tab-lookup', 'Player Lookup', true);

        const lookupContent = document.createElement('div');
        lookupContent.id = 'tab-lookup';
        lookupContent.className = 'pm-tab-content active';
        lookupContent.innerHTML = `
      <div class="pm-section-title">Player Lookup</div>
      <div style="color:#a09b8c; font-size:13px; margin-bottom:20px; line-height:1.5;">Instantly look up match history for any player on any game mode using their Riot ID (Name#Tag).</div>
    `;

        const searchRow = document.createElement('div');
        searchRow.className = 'pm-search';

        const regionSelect = document.createElement('select');
        Object.assign(regionSelect.style, {
            background: '#111',
            color: '#f0e6d2',
            border: '1px solid #3e2e13',
            padding: '8px 12px',
            borderRadius: '2px',
            outline: 'none',
            fontSize: '13px',
            cursor: 'pointer'
        });
        const regions = [{
                label: 'Local Region',
                value: ''
            },
            {
                label: 'Americas (NA/BR/LAN/LAS)',
                value: 'NA1'
            },
            {
                label: 'Europe (EUW/EUNE/TR/RU)',
                value: 'EUW'
            },
            {
                label: 'Asia (KR/JP)',
                value: 'KR'
            },
            {
                label: 'SEA / OCE',
                value: 'SG2'
            }
        ];
        regions.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.value;
            opt.textContent = r.label;
            regionSelect.appendChild(opt);
        });

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.className = 'pm-input';
        searchInput.placeholder = 'e.g. Faker#KR1';

        const searchBtn = document.createElement('button');
        searchBtn.className = 'pm-btn';
        searchBtn.textContent = 'Search';

        const meBtn = document.createElement('button');
        meBtn.className = 'pm-btn';
        meBtn.textContent = 'Me';
        meBtn.title = 'Look up your own match history';

        const resultDiv = document.createElement('div');
        resultDiv.style.marginTop = '16px';
        resultDiv.style.fontSize = '14px';

        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                searchBtn.click();
            }
        });

        meBtn.addEventListener('click', async () => {
            resultDiv.innerHTML = '<div style="color:#c8aa6e">Looking up your account...</div>';
            try {
                const me = await Utils.LCU.get('/lol-summoner/v1/current-summoner').catch(() => null);
                if (!me || !me.puuid) {
                    resultDiv.innerHTML = '<div style="color:#d92323">Could not find your account? RIOT!</div>';
                    return;
                }
                const gameName = me.gameName || me.displayName || '';
                const tagLine = me.tagLine || '';
                const full = await Utils.LCU.get('/lol-summoner/v2/summoners/puuid/' + me.puuid).catch(() => null);
                const finalPlayer = {
                    ...me,
                    ...(full || {}),
                    gameName,
                    tagLine
                };

                resultDiv.innerHTML = '<div style="color:#0ac8b9">Loading Match History...</div>';
                import('./modules/gameAnalysisPopup.js').then(mod => {
                    mod.MatchHistoryModal.show(finalPlayer, '');
                });
                setTimeout(() => {
                    resultDiv.innerHTML = '';
                }, 1000);
            } catch (e) {
                resultDiv.innerHTML = '<div style="color:#d92323">Error looking up your account</div>';
            }
        });

        searchBtn.addEventListener('click', async () => {
            const input = searchInput.value.trim();
            const selectedRegion = regionSelect.value || null;

            if (!input) {
                resultDiv.innerHTML = '<div style="color:#d92323">Please enter a name</div>';
                return;
            }

            resultDiv.innerHTML = '<div style="color:#c8aa6e">Searching...</div>';
            try {
                let puuidToUse = null;
                let finalPlayer = null;

                // lookup handling
                if (input.includes('#')) {
                    const parts = input.split('#');
                    if (parts.length === 2 && parts[0] && parts[1]) {
                        const gameName = parts[0];
                        const tagLine = parts[1];
                        const alias = await Utils.LCU.get('/lol-summoner/v1/alias/lookup?gameName=' + encodeURIComponent(gameName) + '&tagLine=' + encodeURIComponent(tagLine)).catch(() => null);

                        if (alias && alias.puuid) {
                            puuidToUse = alias.puuid;
                            finalPlayer = {
                                ...alias,
                                gameName,
                                tagLine
                            };
                        }
                    }
                } else {
                    // Try looking up by old summoner name
                    const sumObj = await Utils.LCU.get('/lol-summoner/v1/summoners?name=' + encodeURIComponent(input)).catch(() => null);
                    if (sumObj && sumObj.puuid) {
                        puuidToUse = sumObj.puuid;
                        finalPlayer = sumObj;
                    }
                }

                if (puuidToUse && finalPlayer) {
                    try {
                        const full = await Utils.LCU.get('/lol-summoner/v2/summoners/puuid/' + puuidToUse).catch(() => null);
                        if (full) finalPlayer = {
                            ...finalPlayer,
                            ...full
                        };
                    } catch (e) {}

                    resultDiv.innerHTML = '<div style="color:#0ac8b9">Loading Match History...</div>';
                    import('./modules/gameAnalysisPopup.js').then(mod => {
                        mod.MatchHistoryModal.show(finalPlayer, '', selectedRegion);
                    });
                    setTimeout(() => {
                        resultDiv.innerHTML = '';
                        searchInput.value = '';
                    }, 1000);
                } else {
                    resultDiv.innerHTML = '<div style="color:#d92323">Player not found</div>';
                }
            } catch (e) {
                resultDiv.innerHTML = '<div style="color:#d92323">Error looking up player</div>';
            }
        });

        searchRow.appendChild(regionSelect);
        searchRow.appendChild(searchInput);
        searchRow.appendChild(searchBtn);
        searchRow.appendChild(meBtn);
        lookupContent.appendChild(searchRow);
        lookupContent.appendChild(resultDiv);
        content.appendChild(lookupContent);

        // Modules Sections
        registeredModules.sort((a, b) => a.name.localeCompare(b.name));

        function getHiddenModuleIds() {
            const v = Utils.Store.get('core', 'hiddenModules');
            return Array.isArray(v) ? new Set(v) : new Set();
        }

        function isModuleEnabled(mod) {
            return (mod.settings || []).some(s => s.type === 'toggle' && s.value === true);
        }

        registeredModules.forEach(mod => {
            if (!mod.settings || mod.settings.length === 0) return;

            const hiddenIds = getHiddenModuleIds();
            const isHidden = hiddenIds.has(mod.id);

            const tabId = 'tab-' + mod.id;
            createTab(tabId, mod.name);

            const tabEl = sidebar.querySelector(`[data-target="${tabId}"]`);
            if (tabEl && isHidden) tabEl.style.display = 'none';

            const tabContent = document.createElement('div');
            tabContent.id = tabId;
            tabContent.className = 'pm-tab-content';

            const modTitle = document.createElement('div');
            modTitle.className = 'pm-section-title';
            modTitle.textContent = mod.name;

            const modDesc = document.createElement('div');
            Object.assign(modDesc.style, {
                color: '#a09b8c',
                fontSize: '13px',
                marginBottom: '20px',
                lineHeight: '1.5'
            });
            modDesc.textContent = mod.description;

            tabContent.appendChild(modTitle);
            tabContent.appendChild(modDesc);

            mod.settings.forEach(setting => {
                if (setting.type === 'toggle') {
                    const row = document.createElement('div');
                    row.className = 'pm-row';

                    const lblWrapper = document.createElement('div');
                    lblWrapper.className = 'pm-label-wrapper';
                    const lblTitle = document.createElement('div');
                    lblTitle.className = 'pm-label-title';
                    lblTitle.textContent = setting.label || mod.name;
                    lblWrapper.appendChild(lblTitle);

                    const sw = document.createElement('button');
                    sw.type = 'button';
                    sw.className = 'pm-toggle-btn ' + (setting.value ? 'on' : 'off');

                    const toggleFn = (e) => {
                        if (e) {
                            e.preventDefault();
                            e.stopPropagation();
                        }
                        const v = !setting.value;
                        setting.value = v;
                        if (setting.onChange) setting.onChange(v);
                        sw.className = 'pm-toggle-btn ' + (v ? 'on' : 'off');
                    };
                    sw.onclick = toggleFn;
                    row.onclick = toggleFn;
                    row.style.cursor = 'pointer';

                    row.appendChild(lblWrapper);
                    row.appendChild(sw);
                    tabContent.appendChild(row);
                } else if (setting.type === 'select') {
                    const row = document.createElement('div');
                    row.className = 'pm-row';
                    row.style.background = 'transparent';
                    row.style.padding = '0 16px 16px';
                    row.style.border = 'none';
                    row.style.marginBottom = '0';

                    const select = document.createElement('select');
                    Object.assign(select.style, {
                        background: '#111',
                        color: '#f0e6d2',
                        border: '1px solid #3e2e13',
                        padding: '8px',
                        borderRadius: '4px',
                        flex: '1',
                        outline: 'none',
                        fontSize: '14px'
                    });

                    setting.options.forEach(opt => {
                        const el = document.createElement('option');
                        el.value = opt.value;
                        el.textContent = opt.label;
                        select.appendChild(el);
                    });

                    select.value = setting.value;
                    select.addEventListener('change', (e) => {
                        if (setting.onChange) setting.onChange(e.target.value);
                    });

                    row.appendChild(select);
                    tabContent.appendChild(row);
                } else if (setting.type === 'textarea') {
                    const row = document.createElement('div');
                    row.className = 'pm-row';
                    row.style.background = 'transparent';
                    row.style.padding = '0 16px 16px';
                    row.style.border = 'none';
                    row.style.marginBottom = '0';

                    const input = document.createElement('textarea');
                    input.placeholder = setting.placeholder || '';
                    Object.assign(input.style, {
                        background: '#111',
                        color: '#f0e6d2',
                        border: '1px solid #3e2e13',
                        padding: '10px 14px',
                        borderRadius: '4px',
                        outline: 'none',
                        boxSizing: 'border-box',
                        width: '100%',
                        minHeight: '80px',
                        resize: 'vertical',
                        fontFamily: 'inherit',
                        fontSize: '14px'
                    });

                    input.value = setting.value || '';
                    input.addEventListener('change', (e) => {
                        if (setting.onChange) setting.onChange(e.target.value);
                    });
                    input.addEventListener('click', (ev) => ev.stopPropagation());

                    row.appendChild(input);
                    tabContent.appendChild(row);
                } else if (setting.type === 'custom') {
                    const row = document.createElement('div');
                    row.className = 'pm-row';
                    row.style.background = 'transparent';
                    row.style.padding = '0 16px 16px';
                    row.style.border = 'none';
                    row.style.marginBottom = '0';

                    if (setting.render) {
                        setting.render(row);
                    }

                    tabContent.appendChild(row);
                }
            });
            content.appendChild(tabContent);
        });

        // Settings Tab
        const settingsTabId = 'tab-settings';

        const settingsTab = document.createElement('div');
        settingsTab.className = 'pm-tab pm-tab-settings';
        settingsTab.setAttribute('data-target', settingsTabId);
        settingsTab.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>Settings`;
        settingsTab.addEventListener('click', () => {
            switchTab(settingsTabId);
            buildSettingsContent(settingsTabContent);
        });
        sidebar.appendChild(settingsTab);

        const settingsTabContent = document.createElement('div');
        settingsTabContent.id = settingsTabId;
        settingsTabContent.className = 'pm-tab-content';
        content.appendChild(settingsTabContent);

        function buildSettingsContent(container) {
            container.innerHTML = '';

            const wrap = document.createElement('div');
            wrap.style.cssText = 'display:flex;flex-direction:column;gap:4px;';

            // Section helper
            function makeSettingsSection(title, desc) {
                const section = document.createElement('div');
                section.className = 'pm-settings-section';
                const h = document.createElement('div');
                h.className = 'pm-settings-section-title';
                h.textContent = title;
                section.appendChild(h);
                if (desc) {
                    const d = document.createElement('div');
                    d.className = 'pm-settings-section-desc';
                    d.textContent = desc;
                    section.appendChild(d);
                }
                return section;
            }

            // Pill toggle helper
            function makeSettingsToggle(initialValue, onChange) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'pm-toggle-btn ' + (initialValue ? 'on' : 'off');
                btn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const next = !btn.classList.contains('on');
                    btn.className = 'pm-toggle-btn ' + (next ? 'on' : 'off');
                    onChange(next);
                });
                return btn;
            }

            // General Section
            const generalSection = makeSettingsSection('General', 'Global plugin manager settings.');

            const hotkeyRow = document.createElement('div');
            hotkeyRow.className = 'pm-settings-row';
            const hotkeyLabel = document.createElement('span');
            hotkeyLabel.className = 'pm-settings-row-label';
            hotkeyLabel.textContent = 'Menu Shortcut (Click to set)';

            const hotkeyBtn = document.createElement('button');
            hotkeyBtn.className = 'pm-btn';
            hotkeyBtn.style.minWidth = '140px';

            let currentHotkey = getMenuHotkey();

            hotkeyBtn.textContent = currentHotkey.display;

            hotkeyBtn.addEventListener('click', (e) => {
                e.preventDefault();
                if (window._isCapturingHotkey) return;

                window._isCapturingHotkey = true;
                hotkeyBtn.textContent = 'Press keys...';
                hotkeyBtn.style.borderColor = '#0ac8b9';
                hotkeyBtn.style.color = '#0ac8b9';

                const cleanup = () => {
                    window._isCapturingHotkey = false;
                    document.removeEventListener('keydown', onKeyDown, {
                        capture: true
                    });
                    document.removeEventListener('keyup', onKeyUp, {
                        capture: true
                    });
                    document.removeEventListener('mousedown', onMouseDown, {
                        capture: true
                    });
                    hotkeyBtn.style.borderColor = '';
                    hotkeyBtn.style.color = '';
                };

                const onKeyDown = (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();

                    const isModifier = ['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key);

                    const parts = [];
                    if (ev.ctrlKey) parts.push('Ctrl');
                    if (ev.shiftKey) parts.push('Shift');
                    if (ev.altKey) parts.push('Alt');
                    if (ev.metaKey) parts.push('Win/Cmd');

                    if (!isModifier) {
                        // Cancel capture on Escape without modifiers
                        if (ev.code === 'Escape' && parts.length === 0) {
                            hotkeyBtn.textContent = currentHotkey.display;
                            cleanup();
                            return;
                        }

                        let keyName = ev.code;
                        if (keyName.startsWith('Key')) keyName = keyName.slice(3);
                        else if (keyName.startsWith('Digit')) keyName = keyName.slice(5);
                        else if (keyName === 'Space') keyName = 'Space';

                        parts.push(keyName);

                        if (parts.length > 3) {
                            hotkeyBtn.textContent = 'Max 3 keys!';
                            setTimeout(() => {
                                if (!window._isCapturingHotkey) return;
                                hotkeyBtn.textContent = currentHotkey.display;
                            }, 1000);
                            cleanup();
                            return;
                        }

                        const newHotkey = {
                            ctrlKey: ev.ctrlKey,
                            shiftKey: ev.shiftKey,
                            altKey: ev.altKey,
                            metaKey: ev.metaKey,
                            code: ev.code,
                            display: parts.join(' + ')
                        };

                        currentHotkey = newHotkey;
                        Utils.Store.set('core', 'hotkeyObj', currentHotkey);
                        hotkeyBtn.textContent = currentHotkey.display;
                        cleanup();
                    } else {
                        hotkeyBtn.textContent = parts.join(' + ') + ' + ...';
                    }
                };

                const onKeyUp = (ev) => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    const isModifier = ['Control', 'Shift', 'Alt', 'Meta'].includes(ev.key);
                    if (isModifier && window._isCapturingHotkey) {
                        if (!ev.ctrlKey && !ev.shiftKey && !ev.altKey && !ev.metaKey) {
                            hotkeyBtn.textContent = 'Press keys...';
                        } else {
                            const parts = [];
                            if (ev.ctrlKey) parts.push('Ctrl');
                            if (ev.shiftKey) parts.push('Shift');
                            if (ev.altKey) parts.push('Alt');
                            if (ev.metaKey) parts.push('Win/Cmd');
                            if (parts.length > 0) {
                                hotkeyBtn.textContent = parts.join(' + ') + ' + ...';
                            }
                        }
                    }
                };

                const onMouseDown = (ev) => {
                    if (!hotkeyBtn.contains(ev.target)) {
                        hotkeyBtn.textContent = currentHotkey.display;
                        cleanup();
                    }
                };

                document.addEventListener('keydown', onKeyDown, {
                    capture: true
                });
                document.addEventListener('keyup', onKeyUp, {
                    capture: true
                });
                document.addEventListener('mousedown', onMouseDown, {
                    capture: true
                });
            });

            hotkeyRow.appendChild(hotkeyLabel);
            hotkeyRow.appendChild(hotkeyBtn);
            generalSection.appendChild(hotkeyRow);
            wrap.appendChild(generalSection);

            // Updates Section 
            const updateSection = makeSettingsSection(
                'Updates',
                'Check GitHub for new Snooze-Manager releases.'
            );

            const autoCheckEnabled = Utils.Store.get('core', 'checkUpdates') !== false;

            const autoCheckRow = document.createElement('div');
            autoCheckRow.className = 'pm-settings-row';
            const autoCheckLabel = document.createElement('span');
            autoCheckLabel.className = 'pm-settings-row-label';
            autoCheckLabel.textContent = 'Auto-check for updates on startup';
            const autoCheckToggle = makeSettingsToggle(autoCheckEnabled, (val) => {
                Utils.Store.set('core', 'checkUpdates', val);
            });
            autoCheckRow.appendChild(autoCheckLabel);
            autoCheckRow.appendChild(autoCheckToggle);
            updateSection.appendChild(autoCheckRow);

            // Status area
            const updateStatusEl = document.createElement('div');
            updateStatusEl.className = 'pm-update-status' + (_latestRelease ? ' has-update' : '');

            function renderUpdateStatus() {
                updateStatusEl.innerHTML = '';
                updateStatusEl.className = 'pm-update-status' + (_latestRelease ? ' has-update' : '');
                if (_latestRelease) {
                    const title = document.createElement('div');
                    title.className = 'pm-update-title';
                    title.textContent = `Update available: v${_latestRelease.version}`;
                    updateStatusEl.appendChild(title);

                    const relName = document.createElement('div');
                    relName.className = 'pm-update-rel-name';
                    relName.textContent = _latestRelease.name;
                    updateStatusEl.appendChild(relName);

                    if (_latestRelease.body) {
                        const notes = document.createElement('div');
                        notes.className = 'pm-update-notes';
                        notes.textContent = _latestRelease.body;
                        updateStatusEl.appendChild(notes);
                    }

                    const linkRow = document.createElement('div');
                    linkRow.style.cssText = 'display:flex;gap:8px;align-items:center;';
                    const link = document.createElement('a');
                    link.href = _latestRelease.url;
                    link.target = '_blank';
                    link.className = 'pm-update-link';
                    link.textContent = 'View release on GitHub';
                    linkRow.appendChild(link);
                    updateStatusEl.appendChild(linkRow);
                } else {
                    const span = document.createElement('span');
                    span.style.color = '#3a5060';
                    span.textContent = `Current version: v${CURRENT_VERSION} — up to date`;
                    updateStatusEl.appendChild(span);
                }
            }

            renderUpdateStatus();
            updateSection.appendChild(updateStatusEl);

            // Live badge callback: update status box if tab is open when bg check finishes
            _updateBadgeCallback = renderUpdateStatus;

            // Check now button
            const checkBtnRow = document.createElement('div');
            checkBtnRow.className = 'pm-update-check-row';

            const checkBtn = document.createElement('button');
            checkBtn.className = 'pm-btn';
            checkBtn.style.cssText = 'font-size:12px;padding:5px 12px;';
            checkBtn.textContent = 'Check now';

            const checkStatus = document.createElement('span');
            checkStatus.className = 'pm-update-check-status';

            checkBtn.addEventListener('click', async () => {
                checkBtn.disabled = true;
                checkBtn.textContent = 'Checking...';
                checkStatus.textContent = '';
                await checkForUpdates(true);
                renderUpdateStatus();
                checkBtn.disabled = false;
                checkBtn.textContent = 'Check now';
                checkStatus.textContent = _latestRelease ? '' : 'Already up to date';
                setTimeout(() => {
                    checkStatus.textContent = '';
                }, 3000);
            });

            checkBtnRow.appendChild(checkBtn);
            checkBtnRow.appendChild(checkStatus);
            updateSection.appendChild(checkBtnRow);
            wrap.appendChild(updateSection);

            // About Section 
            const aboutSection = makeSettingsSection('About', '');

            const aboutContent = document.createElement('div');
            aboutContent.style.cssText = 'font-size:12px;color:#3a5060;line-height:1.8;margin-top:8px;';

            const aboutLines = [{
                    label: 'Plugin:',
                    value: 'Snooze-Manager by Reformed Doge'
                },
                {
                    label: 'Version:',
                    value: `v${CURRENT_VERSION}`
                },
                {
                    label: 'GitHub:',
                    value: 'github.com/ReformedDoge/Snooze-Manager',
                    href: 'https://github.com/ReformedDoge/Snooze-Manager'
                },
            ];

            aboutLines.forEach(({
                label,
                value,
                href
            }) => {
                const row = document.createElement('div');
                const labelEl = document.createElement('span');
                labelEl.style.color = '#5a7080';
                labelEl.textContent = label + ' ';
                let valueEl;
                if (href) {
                    valueEl = document.createElement('a');
                    valueEl.href = href;
                    valueEl.target = '_blank';
                    valueEl.style.cssText = 'color:#785a28;text-decoration:underline;cursor:pointer;';
                } else {
                    valueEl = document.createElement('span');
                    valueEl.style.color = '#7a8a9a';
                }
                valueEl.textContent = value;
                row.appendChild(labelEl);
                row.appendChild(valueEl);
                aboutContent.appendChild(row);
            });

            aboutSection.appendChild(aboutContent);
            wrap.appendChild(aboutSection);

            // Developer Section (debug logs)
            const devSection = makeSettingsSection('Developer', 'Developer / debug settings. Enable to see debug logs from modules.');
            const debugEnabled = Utils.Store.get('core', 'debugLogs') === true;
            const debugRow = document.createElement('div');
            debugRow.className = 'pm-settings-row';
            const debugLabel = document.createElement('span');
            debugLabel.className = 'pm-settings-row-label';
            debugLabel.textContent = 'Enable debug logs';
            const debugToggle = makeSettingsToggle(debugEnabled, (val) => {
                Utils.Store.set('core', 'debugLogs', val);
                Utils.Debug.setEnabled(val);
            });
            debugRow.appendChild(debugLabel);
            debugRow.appendChild(debugToggle);
            devSection.appendChild(debugRow);

            const resetWelcomeRow = document.createElement('div');
            resetWelcomeRow.className = 'pm-settings-row';
            resetWelcomeRow.style.cssText = 'padding:8px 10px;background:rgba(255,255,255,0.008);';
            const resetWelcomeLabelWrap = document.createElement('div');
            resetWelcomeLabelWrap.className = 'pm-label-wrapper';
            const resetWelcomeTitle = document.createElement('div');
            resetWelcomeTitle.className = 'pm-settings-row-label';
            resetWelcomeTitle.textContent = 'Welcome modal';
            const resetWelcomeDesc = document.createElement('div');
            resetWelcomeDesc.className = 'pm-label-desc';
            resetWelcomeDesc.style.color = '#4a6070';
            resetWelcomeDesc.textContent = 'Show again on next startup.';
            resetWelcomeLabelWrap.appendChild(resetWelcomeTitle);
            resetWelcomeLabelWrap.appendChild(resetWelcomeDesc);

            const resetWelcomeBtn = document.createElement('button');
            resetWelcomeBtn.type = 'button';
            resetWelcomeBtn.className = 'pm-btn';
            resetWelcomeBtn.style.cssText = 'font-size:11px;padding:4px 10px;flex-shrink:0;background:rgba(255,255,255,0.015);border-color:rgba(200,170,110,0.16);color:#785a28;';
            resetWelcomeBtn.textContent = 'Reset';
            resetWelcomeBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                Utils.Store.remove('core', 'welcomeModalDismissed');
                resetWelcomeBtn.textContent = 'Reset done';
                setTimeout(() => {
                    resetWelcomeBtn.textContent = 'Reset';
                }, 1800);
            });

            resetWelcomeRow.appendChild(resetWelcomeLabelWrap);
            resetWelcomeRow.appendChild(resetWelcomeBtn);
            devSection.appendChild(resetWelcomeRow);
            wrap.appendChild(devSection);

            // Module Visibility Section
            const visSection = makeSettingsSection('Module Visibility', 'Choose which modules appear in the sidebar. Modules with an active toggle are marked with a green dot - hidden modules can also be fully disabled so their code never runs (red dot).');

            const visDualList = document.createElement('div');
            visDualList.style.cssText = 'display:flex;gap:12px;margin-top:10px;';

            function buildVisibilityList() {
                const _prevScrollTops = [];
                visDualList.querySelectorAll('div[style*="overflow-y: auto"]').forEach(el => _prevScrollTops.push(el.scrollTop));
                visDualList.innerHTML = '';

                const hiddenIds = (() => {
                    const v = Utils.Store.get('core', 'hiddenModules');
                    return Array.isArray(v) ? new Set(v) : new Set();
                })();
                const disabledIds = getDisabledModuleIds();

                disabledIds.forEach(id => {
                    if (!registeredModules.some(m => m.id === id)) {
                        registeredModules.push({
                            id,
                            name: (MODULE_INFO[id] || {}).name || id,
                            description: '',
                            settings: [],
                            __disabledStub: true
                        });
                    }
                });

                const visibleMods = registeredModules.filter(m => (m.__disabledStub || (m.settings && m.settings.length > 0)) && !hiddenIds.has(m.id));
                const hiddenMods = registeredModules.filter(m => (m.__disabledStub || (m.settings && m.settings.length > 0)) && hiddenIds.has(m.id));

                function makeColumn(title, mods, actions) {
                    const col = document.createElement('div');
                    col.style.cssText = 'flex:1;display:flex;flex-direction:column;gap:6px;min-width:0;';

                    const colTitle = document.createElement('div');
                    colTitle.textContent = title;
                    colTitle.style.cssText = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#c8aa6e;margin-bottom:4px;';
                    col.appendChild(colTitle);

                    const list = document.createElement('div');
                    list.style.cssText = 'display:flex;flex-direction:column;gap:4px;min-height:80px;max-height:240px;overflow-y:auto;background:rgba(0,0,0,0.2);border:1px solid rgba(255,255,255,0.06);border-radius:6px;padding:6px;';
                    list.style.scrollbarWidth = 'thin';

                    if (mods.length === 0) {
                        const empty = document.createElement('div');
                        empty.textContent = 'None';
                        empty.style.cssText = 'color:#3a5060;font-size:12px;text-align:center;padding:20px 0;';
                        list.appendChild(empty);
                    }

                    mods.forEach(mod => {
                        const enabled = (mod.settings || []).some(s => s.type === 'toggle' && s.value === true);
                        const isDisabled = disabledIds.has(mod.id);
                        const item = document.createElement('div');
                        item.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:5px 8px;border-radius:4px;background:rgba(255,255,255,0.015);border:1px solid rgba(255,255,255,0.04);transition:background 0.15s;';
                        item.onmouseover = () => item.style.background = 'rgba(255,255,255,0.05)';
                        item.onmouseout = () => item.style.background = 'rgba(255,255,255,0.015)';

                        const nameWrap = document.createElement('div');
                        nameWrap.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0;flex:1;overflow:hidden;';

                        if (isDisabled) {
                            const dot = document.createElement('span');
                            dot.title = 'This module is disabled and will not load until re-enabled and restarted.';
                            dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#c84c4c;flex-shrink:0;';
                            nameWrap.appendChild(dot);
                        } else if (enabled) {
                            const dot = document.createElement('span');
                            dot.title = 'This module has active settings';
                            dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#0ac8b9;flex-shrink:0;';
                            nameWrap.appendChild(dot);
                        }

                        const nameEl = document.createElement('span');
                        nameEl.textContent = mod.name;
                        nameEl.style.cssText = 'font-size:12px;color:#f0e6d2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' + (isDisabled ? 'opacity:0.5;' : '');
                        nameWrap.appendChild(nameEl);

                        const actionsWrap = document.createElement('div');
                        actionsWrap.style.cssText = 'display:flex;gap:4px;flex-shrink:0;';

                        actions.forEach(action => {
                            const btn = document.createElement('button');
                            btn.textContent = typeof action.label === 'function' ? action.label(mod) : action.label;
                            btn.className = action.className || '';
                            btn.style.cssText = 'flex-shrink:0;padding:2px 8px;font-size:11px;border-radius:2px;cursor:pointer;border:1px solid rgba(200,170,110,0.3);background:rgba(200,170,110,0.06);color:#c8aa6e;transition:all 0.15s;';
                            btn.onmouseover = () => {
                                btn.style.background = 'rgba(200,170,110,0.15)';
                                btn.style.color = '#f0e6d2';
                            };
                            btn.onmouseout = () => {
                                btn.style.background = 'rgba(200,170,110,0.06)';
                                btn.style.color = '#c8aa6e';
                            };
                            btn.addEventListener('click', (e) => {
                                e.stopPropagation();
                                action.onClick(mod.id);
                            });
                            actionsWrap.appendChild(btn);
                        });

                        item.appendChild(nameWrap);
                        item.appendChild(actionsWrap);
                        list.appendChild(item);
                    });

                    col.appendChild(list);
                    return col;
                }

                function toggleVisibility(modId) {
                    const current = (() => {
                        const v = Utils.Store.get('core', 'hiddenModules');
                        return Array.isArray(v) ? new Set(v) : new Set();
                    })();

                    const tabEl = document.querySelector(`#pm-root .pm-tab[data-target="tab-${modId}"]`);

                    if (current.has(modId)) {
                        current.delete(modId);
                        if (tabEl) tabEl.style.display = '';
                    } else {
                        current.add(modId);
                        if (tabEl) {
                            tabEl.style.display = 'none';
                            if (tabEl.classList.contains('active')) {
                                document.querySelector('#pm-root .pm-tab[data-target="tab-lookup"]')?.click();
                            }
                        }
                    }

                    Utils.Store.set('core', 'hiddenModules', [...current]);
                    buildVisibilityList();
                }

                function toggleDisabled(modId) {
                    const current = getDisabledModuleIds();
                    if (current.has(modId)) {
                        current.delete(modId);
                        if (!registeredModules.some(m => m.id === modId)) {
                            registeredModules.push({
                                id: modId,
                                name: (MODULE_INFO[modId] || {}).name || modId,
                                description: '',
                                settings: [],
                            });
                        }
                    } else {
                        current.add(modId);
                    }
                    Utils.Store.set('core', 'disabledModules', [...current]);
                    buildVisibilityList();
                }

                const leftCol = makeColumn('Visible in Menu', visibleMods, [{
                    label: 'Hide',
                    className: 'pm-vis-hide-btn',
                    onClick: toggleVisibility
                }]);
                const rightCol = makeColumn('Hidden from Menu', hiddenMods, [{
                        label: (mod) => disabledIds.has(mod.id) ? 'Enable' : 'Disable',
                        onClick: toggleDisabled
                    },
                    {
                        label: 'Show',
                        className: 'pm-vis-show-btn',
                        onClick: toggleVisibility
                    }
                ]);

                visDualList.appendChild(leftCol);
                visDualList.appendChild(rightCol);

                visDualList.querySelectorAll('div[style*="overflow-y: auto"]').forEach((el, i) => {
                    if (_prevScrollTops[i] != null) el.scrollTop = _prevScrollTops[i];
                });
            }

            buildVisibilityList();
            visSection.appendChild(visDualList);

            const _restartDisabledCount = getDisabledModuleIds().size;
            if (_restartDisabledCount > 0) {
                const restartNote = document.createElement('div');
                restartNote.style.cssText = 'font-size:11px;color:#a09b8c;margin-top:8px;padding:6px 10px;border-radius:4px;background:rgba(200,170,110,0.06);border:1px solid rgba(200,170,110,0.15);display:flex;align-items:center;gap:6px;';
                restartNote.innerHTML = '<span style="color:#c8aa6e;font-weight:700;">!</span> Restart required for module enable/disable changes to take effect.';
                visSection.appendChild(restartNote);
            }

            wrap.appendChild(visSection);

            container.appendChild(wrap);
        }
        // End Settings Tab 

        _root.appendChild(overlay);
        _root.appendChild(modal);

        const viewportOverlay = document.querySelector('.rcp-fe-viewport-overlay');
        if (viewportOverlay && viewportOverlay.parentNode === document.body) viewportOverlay.after(_root);
        else document.body.appendChild(_root);
    }

    function show() {
        if (!_root || !document.body.contains(_root)) create();
        _root.classList.add('pm-show');
        _visible = true;
        _cbs.forEach(f => f(true));
    }

    function hide() {
        if (_root) _root.classList.remove('pm-show');
        _visible = false;
        _cbs.forEach(f => f(false));
    }

    function toggle() {
        if (_visible) hide();
        else show();
    }

    function onChange(f) {
        _cbs.add(f);
        return () => _cbs.delete(f);
    }

    function init() {
        create();
        document.addEventListener('keydown', (e) => {
            if (window._isCapturingHotkey) return;

            let shortcut = getMenuHotkey();

            if (!e.repeat &&
                e.ctrlKey === shortcut.ctrlKey &&
                e.shiftKey === shortcut.shiftKey &&
                e.altKey === shortcut.altKey &&
                e.metaKey === shortcut.metaKey &&
                e.code === shortcut.code) {

                // Prevent typing from triggering the modal
                const isInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
                if (isInput) {
                    const isSafeKey = /^F\d+$/.test(shortcut.code) || shortcut.code === 'Escape' || shortcut.code.startsWith('Arrow');
                    const hasModifier = shortcut.ctrlKey || shortcut.altKey || shortcut.metaKey;
                    if (!isSafeKey && !hasModifier) return;
                }

                e.preventDefault();
                toggle();
            }
        });
    }

    return {
        init,
        show,
        hide,
        toggle,
        onChange
    };
})();

const WelcomeModal = (function() {
    const STORE_KEY = 'welcomeModalDismissed';
    let _root = null;
    let _visible = false;
    let _listenerDocument = null;
    let _documentClickHandler = null;
    let _documentKeyHandler = null;

    function markDismissed() {
        try {
            Utils.Store.set('core', STORE_KEY, true);
        } catch (err) {
            Utils.Debug.warn('[Snooze-Manager] Failed to persist welcome modal state:', err);
        }
    }

    function getRoot() {
        return (_root && document.body.contains(_root)) ? _root : document.getElementById('pm-welcome-root');
    }

    function isVisible() {
        const root = getRoot();
        return _visible || !!root?.classList.contains('pm-welcome-show');
    }

    function installDocumentListeners() {
        if (_listenerDocument === document && _documentClickHandler && _documentKeyHandler) return;

        if (_listenerDocument && _documentClickHandler) {
            _listenerDocument.removeEventListener('click', _documentClickHandler, true);
        }
        if (_listenerDocument && _documentKeyHandler) {
            _listenerDocument.removeEventListener('keydown', _documentKeyHandler, true);
        }

        _documentClickHandler = (e) => {
            const root = getRoot();
            if (!root || !root.classList.contains('pm-welcome-show')) return;

            const target = e.target;
            if (!(target instanceof Element)) return;
            const shouldDismiss =
                target.id === 'pm-welcome-overlay' ||
                !!target.closest('.pm-welcome-close, .pm-welcome-btn');

            if (!shouldDismiss) return;
            e.preventDefault();
            e.stopPropagation();
            hide();
        };

        _documentKeyHandler = (e) => {
            if (!isVisible() || e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            hide();
        };

        _listenerDocument = document;
        document.addEventListener('click', _documentClickHandler, true);
        document.addEventListener('keydown', _documentKeyHandler, true);
    }

    function create() {
        installDocumentListeners();

        const old = document.getElementById('pm-welcome-root');
        if (old) old.remove();

        const styleId = 'pm-welcome-styles';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
      #pm-welcome-root { position: fixed; inset: 0; z-index: 2147483647; display: none; align-items: center; justify-content: center; padding: 24px; font-family: var(--font-body), "Segoe UI", sans-serif; color: #a09b8c; }
      #pm-welcome-root.pm-welcome-show { display: flex; }
      #pm-welcome-overlay { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.58); backdrop-filter: blur(5px); pointer-events: auto; }
      #pm-welcome-modal { position: relative; z-index: 1; width: min(760px, calc(100vw - 48px)); max-height: calc(100vh - 48px); overflow: hidden; display: flex; flex-direction: column; background: radial-gradient(circle at 50% 0%, rgba(10, 200, 185, 0.14), transparent 32%), linear-gradient(180deg, rgba(1, 10, 19, 0.96), rgba(1, 10, 19, 0.88)); border: 1px solid rgba(200, 170, 110, 0.32); border-radius: 12px; box-shadow: 0 22px 60px rgba(0, 0, 0, 0.78), inset 0 1px 0 rgba(255, 255, 255, 0.06); backdrop-filter: blur(24px) saturate(140%); pointer-events: auto; }
      .pm-welcome-header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 22px 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.06); background: rgba(0, 0, 0, 0.18); }
      .pm-welcome-kicker { color: #c8aa6e; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 5px; }
      .pm-welcome-title { color: #f0e6d2; font-size: 24px; line-height: 1.15; font-weight: 800; margin: 0; }
      .pm-welcome-close { width: 34px; height: 34px; display: grid; place-items: center; flex-shrink: 0; background: rgba(255, 255, 255, 0.025); border: 1px solid rgba(200, 170, 110, 0.18); border-radius: 6px; color: #a09b8c; font-size: 20px; cursor: pointer; transition: all 0.16s ease; }
      .pm-welcome-close:hover { color: #f0e6d2; border-color: rgba(200, 170, 110, 0.55); background: rgba(200, 170, 110, 0.08); }
      .pm-welcome-body { padding: 18px 22px 20px; overflow-y: auto; }
      .pm-welcome-copy { color: #a09b8c; font-size: 13px; line-height: 1.45; margin: 0 0 14px; }
      .pm-welcome-hotkey-card { position: relative; display: grid; grid-template-columns: minmax(145px, 190px) 1fr; gap: 18px; align-items: center; margin-bottom: 14px; padding: 14px; border: 1px solid rgba(200, 170, 110, 0.42); border-radius: 10px; background: linear-gradient(135deg, rgba(200, 170, 110, 0.16), rgba(10, 200, 185, 0.08)), rgba(255, 255, 255, 0.02); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 12px 28px rgba(0, 0, 0, 0.34); }
      .pm-welcome-keycap { min-height: 112px; display: grid; place-items: center; border: 1px solid rgba(240, 230, 210, 0.24); border-bottom-color: rgba(200, 170, 110, 0.62); border-radius: 8px; background: linear-gradient(180deg, rgba(240, 230, 210, 0.10), rgba(1, 10, 19, 0.64)); box-shadow: 0 8px 0 rgba(0, 0, 0, 0.25), inset 0 0 30px rgba(200, 170, 110, 0.08); color: #f0e6d2; font-size: 62px; line-height: 1; font-weight: 900; text-shadow: 0 0 22px rgba(200, 170, 110, 0.34); }
      .pm-welcome-hotkey-label { color: #c8aa6e; font-size: 12px; font-weight: 800; text-transform: uppercase; margin-bottom: 8px; }
      .pm-welcome-hotkey-title { color: #f0e6d2; font-size: 18px; line-height: 1.25; font-weight: 800; margin-bottom: 7px; }
      .pm-welcome-hotkey-note { color: #8a9aaa; font-size: 12px; line-height: 1.4; }
      .pm-welcome-hotkey-note strong { color: #0ac8b9; font-weight: 800; }
      .pm-welcome-hotkey-actions { margin-top: 12px; }
      .pm-welcome-grid { display: grid; grid-template-columns: 1.15fr 0.85fr; gap: 12px; margin-top: 0; }
      .pm-welcome-panel { border: 1px solid rgba(255, 255, 255, 0.055); border-radius: 8px; background: rgba(255, 255, 255, 0.018); padding: 12px; }
      .pm-welcome-panel-title { color: #c8aa6e; font-size: 12px; font-weight: 800; text-transform: uppercase; margin-bottom: 8px; }
      .pm-welcome-features { display: grid; gap: 6px; margin: 0; padding: 0; list-style: none; }
      .pm-welcome-features li { display: flex; align-items: flex-start; gap: 8px; color: #a09b8c; font-size: 12px; line-height: 1.32; }
      .pm-welcome-features li::before { content: ''; width: 6px; height: 6px; margin-top: 6px; border-radius: 50%; flex-shrink: 0; background: #0ac8b9; box-shadow: 0 0 10px rgba(10, 200, 185, 0.6); }
      .pm-welcome-about { display: grid; gap: 6px; color: #7a8a9a; font-size: 12px; line-height: 1.32; }
      .pm-welcome-about-row { display: grid; grid-template-columns: 64px 1fr; gap: 8px; min-width: 0; }
      .pm-welcome-about-label { color: #5a7080; }
      .pm-welcome-about a { color: #c8aa6e; text-decoration: underline; cursor: pointer; overflow-wrap: anywhere; }
      .pm-welcome-version-wrap { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
      .pm-welcome-update-link { color: #0ac8b9; text-decoration: none; font-weight: 800; cursor: pointer; }
      .pm-welcome-update-link:hover { color: #f0e6d2; text-decoration: underline; }
      .pm-welcome-btn { background: rgba(200, 170, 110, 0.12); border: 1px solid rgba(200, 170, 110, 0.45); color: #f0e6d2; padding: 7px 16px; cursor: pointer; border-radius: 4px; font-weight: 800; transition: all 0.16s ease; font-size: 12px; }
      .pm-welcome-btn:hover { background: rgba(200, 170, 110, 0.22); border-color: #c8aa6e; box-shadow: 0 0 18px rgba(200, 170, 110, 0.16); }
      #pm-welcome-root .pm-welcome-body::-webkit-scrollbar { width: 6px; }
      #pm-welcome-root .pm-welcome-body::-webkit-scrollbar-track { background: transparent; }
      #pm-welcome-root .pm-welcome-body::-webkit-scrollbar-thumb { background: rgba(200, 170, 110, 0.18); border-radius: 3px; }
      @media (max-width: 620px) {
        #pm-welcome-root { padding: 14px; }
        #pm-welcome-modal { width: calc(100vw - 28px); max-height: calc(100vh - 28px); }
        .pm-welcome-header, .pm-welcome-body { padding-left: 18px; padding-right: 18px; }
        .pm-welcome-title { font-size: 22px; }
        .pm-welcome-hotkey-card, .pm-welcome-grid { grid-template-columns: 1fr; }
        .pm-welcome-keycap { min-height: 108px; font-size: 56px; }
      }
      `;
            document.head.appendChild(style);
        }

        _root = document.createElement('div');
        _root.id = 'pm-welcome-root';
        _root.setAttribute('role', 'dialog');
        _root.setAttribute('aria-modal', 'true');
        _root.setAttribute('aria-labelledby', 'pm-welcome-title');

        const overlay = document.createElement('div');
        overlay.id = 'pm-welcome-overlay';
        overlay.addEventListener('click', () => hide());

        const modal = document.createElement('div');
        modal.id = 'pm-welcome-modal';

        const header = document.createElement('div');
        header.className = 'pm-welcome-header';

        const headingWrap = document.createElement('div');
        const kicker = document.createElement('div');
        kicker.className = 'pm-welcome-kicker';
        kicker.textContent = 'Snooze-Manager';
        const title = document.createElement('h2');
        title.id = 'pm-welcome-title';
        title.className = 'pm-welcome-title';
        title.textContent = 'Welcome to your new plugin manager';
        headingWrap.appendChild(kicker);
        headingWrap.appendChild(title);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'pm-welcome-close';
        closeBtn.setAttribute('aria-label', 'Close welcome');
        closeBtn.innerHTML = '&#x2715;';
        closeBtn.addEventListener('click', () => hide());

        header.appendChild(headingWrap);
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'pm-welcome-body';

        const copy = document.createElement('p');
        copy.className = 'pm-welcome-copy';
        copy.textContent = 'Snooze-Manager brings QoL features together in one menu, making them easy to configure and use.';
        body.appendChild(copy);

        const hotkeyCard = document.createElement('div');
        hotkeyCard.className = 'pm-welcome-hotkey-card';

        const keycap = document.createElement('div');
        keycap.className = 'pm-welcome-keycap';
        keycap.textContent = DEFAULT_MENU_HOTKEY.display;

        const hotkeyText = document.createElement('div');
        const hotkeyLabel = document.createElement('div');
        hotkeyLabel.className = 'pm-welcome-hotkey-label';
        hotkeyLabel.textContent = 'Default menu hotkey';
        const hotkeyTitle = document.createElement('div');
        hotkeyTitle.className = 'pm-welcome-hotkey-title';
        hotkeyTitle.textContent = `Press ${DEFAULT_MENU_HOTKEY.display} anytime to open the Snooze-Manager menu.`;
        const hotkeyNote = document.createElement('div');
        hotkeyNote.className = 'pm-welcome-hotkey-note';
        hotkeyNote.innerHTML = 'Prefer another shortcut? It is <strong>fully customizable</strong> in Settings under General > Menu Shortcut.';
        const hotkeyActions = document.createElement('div');
        hotkeyActions.className = 'pm-welcome-hotkey-actions';
        const gotItBtn = document.createElement('button');
        gotItBtn.type = 'button';
        gotItBtn.className = 'pm-welcome-btn';
        gotItBtn.textContent = 'Got it';
        gotItBtn.addEventListener('click', () => hide());
        hotkeyActions.appendChild(gotItBtn);
        hotkeyText.appendChild(hotkeyLabel);
        hotkeyText.appendChild(hotkeyTitle);
        hotkeyText.appendChild(hotkeyNote);
        hotkeyText.appendChild(hotkeyActions);

        hotkeyCard.appendChild(keycap);
        hotkeyCard.appendChild(hotkeyText);
        body.appendChild(hotkeyCard);

        const grid = document.createElement('div');
        grid.className = 'pm-welcome-grid';

        const featuresPanel = document.createElement('div');
        featuresPanel.className = 'pm-welcome-panel';
        const featuresTitle = document.createElement('div');
        featuresTitle.className = 'pm-welcome-panel-title';
        featuresTitle.textContent = 'What is inside';
        const featuresList = document.createElement('ul');
        featuresList.className = 'pm-welcome-features';
        [
            'Player lookup and match history tools',
            'Auto features for re-queue, auto accept, champion select, and honor',
            'Champion select quality-of-life options, Dodge Button',
            'Client window, profile, social panel, and mode selector tweaks',
            'Whale Helper loot and skin collection utilities',
            'And more...',
        ].forEach(feature => {
            const item = document.createElement('li');
            item.textContent = feature;
            featuresList.appendChild(item);
        });
        featuresPanel.appendChild(featuresTitle);
        featuresPanel.appendChild(featuresList);

        const aboutPanel = document.createElement('div');
        aboutPanel.className = 'pm-welcome-panel';
        const aboutTitle = document.createElement('div');
        aboutTitle.className = 'pm-welcome-panel-title';
        aboutTitle.textContent = 'About';
        const aboutContent = document.createElement('div');
        aboutContent.className = 'pm-welcome-about';

        function renderWelcomeUpdate(versionWrap, release) {
            versionWrap.querySelector('.pm-welcome-update-link')?.remove();
            if (!release) return;

            const updateLink = document.createElement('a');
            updateLink.className = 'pm-welcome-update-link';
            updateLink.href = release.url || 'https://github.com/ReformedDoge/Snooze-Manager/releases';
            updateLink.target = '_blank';
            updateLink.textContent = `Update available: v${release.version}`;
            versionWrap.appendChild(updateLink);
        }

        [{
                label: 'Plugin:',
                value: 'Snooze-Manager'
            },
            {
                label: 'Version:',
                value: `v${CURRENT_VERSION}`
            },
            {
                label: 'GitHub:',
                value: 'github.com/ReformedDoge/Snooze-Manager',
                href: 'https://github.com/ReformedDoge/Snooze-Manager'
            },
            {
                label: 'By:',
                value: 'SnoozeFest @ReformedDoge on github.'
            },
        ].forEach(({
            label,
            value,
            href
        }) => {
            const row = document.createElement('div');
            row.className = 'pm-welcome-about-row';
            const labelEl = document.createElement('span');
            labelEl.className = 'pm-welcome-about-label';
            labelEl.textContent = label;
            let valueEl;
            if (label === 'Version:') {
                valueEl = document.createElement('span');
                valueEl.className = 'pm-welcome-version-wrap';
                const currentVersion = document.createElement('span');
                currentVersion.textContent = value;
                valueEl.appendChild(currentVersion);
                renderWelcomeUpdate(valueEl, _latestRelease);
                _welcomeUpdateCallback = (release) => renderWelcomeUpdate(valueEl, release);
            } else if (href) {
                valueEl = document.createElement('a');
                valueEl.href = href;
                valueEl.target = '_blank';
                valueEl.textContent = value;
            } else {
                valueEl = document.createElement('span');
                valueEl.textContent = value;
            }
            row.appendChild(labelEl);
            row.appendChild(valueEl);
            aboutContent.appendChild(row);
        });
        aboutPanel.appendChild(aboutTitle);
        aboutPanel.appendChild(aboutContent);

        grid.appendChild(featuresPanel);
        grid.appendChild(aboutPanel);
        body.appendChild(grid);

        modal.appendChild(header);
        modal.appendChild(body);
        _root.appendChild(overlay);
        _root.appendChild(modal);

        const viewportOverlay = document.querySelector('.rcp-fe-viewport-overlay');
        if (viewportOverlay && viewportOverlay.parentNode === document.body) viewportOverlay.after(_root);
        else document.body.appendChild(_root);
    }

    function show() {
        installDocumentListeners();
        if (!_root || !document.body.contains(_root)) create();
        _root.classList.add('pm-welcome-show');
        _visible = true;
    }

    function hide() {
        markDismissed();
        const root = getRoot();
        if (root) root.classList.remove('pm-welcome-show');
        _visible = false;
        _welcomeUpdateCallback = null;
    }

    function showIfNeeded() {
        if (Utils.Store.get('core', STORE_KEY) === true) return;
        show();
    }

    function init() {
        installDocumentListeners();
    }

    return {
        init,
        showIfNeeded,
        hide
    };
})();

// Features aka plugins (Modules Loader)
import * as autoAcceptModule from './modules/autoAccept.js';
import * as aramNocdModule from './modules/aramNocd.js';
import * as autoLockChampionModule from './modules/autoLockChampion.js';
import * as champSelectQuitButtonModule from './modules/champSelectQuitButton.js';
import * as SnoozeBalanceTooltipModule from './modules/SnoozeBalanceTooltip.js';
import * as gameAnalysisPopupModule from './modules/gameAnalysisPopup.js';
import * as customOnlineStatusModule from './modules/customOnlineStatus.js';
import * as clientWindowTweaksModule from './modules/clientWindowTweaks.js';
import * as profileTweaksModule from './modules/profileTweaks.js';
import * as autoHonorModule from './modules/autoHonor.js';
import * as arenaGodModule from './modules/arenaGod.js';
import * as whaleHelperModule from './modules/whaleHelper.js';
import * as socialPanelTweaksModule from './modules/socialPanelTweaks.js';
import * as penaltyUISuppressModule from './modules/PenaltyUISuppress.js';
import * as autoQueueModule from './modules/autoQueue.js';
import * as modeSelectorTweaksModule from './modules/modeSelectorTweaks.js';
import * as nameSpooferModule from './modules/nameSpoofer.js';
import * as useClientDuringGameModule from './modules/useClientDuringGame.js';

const registeredModules = [];

function getDisabledModuleIds() {
    const v = Utils.Store.get('core', 'disabledModules');
    return Array.isArray(v) ? new Set(v) : new Set();
}

const MODULE_INFO = {
    autoAccept: {
        name: 'Auto Accept Match'
    },
    aramNocd: {
        name: 'ARAM No CD'
    },
    autoLockChampion: {
        name: 'Auto Lock Champion'
    },
    champSelectQuitButton: {
        name: 'Champ Select Quit Button'
    },
    SnoozeBalanceTooltip: {
        name: 'Balance Tooltip'
    },
    gameAnalysisPopup: {
        name: 'Game Analysis Popup'
    },
    customOnlineStatus: {
        name: 'Custom Online Status'
    },
    clientWindowTweaks: {
        name: 'Client Window Tweaks'
    },
    profileTweaks: {
        name: 'Profile Tweaks'
    },
    autoHonor: {
        name: 'Auto Honor'
    },
    arenaGod: {
        name: 'Arena God'
    },
    socialPanelTweaks: {
        name: 'Social Panel Tweaks'
    },
    whaleHelper: {
        name: 'Whale Helper'
    },
    lowPrioWarningSuppress: {
        name: 'Low Prio Warning Suppress'
    },
    autoQueue: {
        name: 'Auto Queue'
    },
    modeSelectorTweaks: {
        name: 'Mode Selector Tweaks'
    },
    nameSpoofer: {
        name: 'Name Spoofer'
    }
};


// Init Lifecycle
let _inited = false;
let _loaded = false;

export async function init(ctx) {
    if (_inited) return;
    _inited = true;
    // manually delete a module Store
    // Utils.Store.removeModule("customAvailability")

    // Run migration only if we are on an older schema version
    if (Utils.Store.getSchemaVersion() < 1) {
        Utils.Store.migrateLegacyKeys(LEGACY_MIGRATION_MAP);
    }

    Utils.Hooks.Ember.install(ctx);
    socialPanelTweaksModule.installEmberHook?.();
    whaleHelperModule.installEmberHook?.();
    modeSelectorTweaksModule.installEmberHook?.();

    Utils.LCU.bind(ctx);

    // initialize debug flag from settings store
    try {
        const dbg = Utils.Store.get('core', 'debugLogs') === true;
        Utils.Debug.setEnabled(dbg);
    } catch (e) {}


    // Register the global SnoozeManager early so modules can hook into it
    window.SnoozeManager = {
        init,
        load,
        __isLoader: true, // Flag to tell modules NOT to inject into native settings
        show: () => Modal.show(),
        hide: () => Modal.hide(),
        toggle: () => Modal.toggle(),
        showHistory: async (puuid, tag = '') => {
            try {
                const p = await Utils.LCU.get('/lol-summoner/v2/summoners/puuid/' + puuid);
                if (p) {
                    import('./modules/gameAnalysisPopup.js').then(mod => {
                        mod.MatchHistoryModal.show(p, tag);
                    });
                }
            } catch (e) {}
        },
        registerModule: (config) => {
            registeredModules.push(config);
            Utils.Debug.log(`[Snooze-Manager] Registered module: ${config.name}`);
        }
    };

    const _initDisabledIds = getDisabledModuleIds();

    if (!_initDisabledIds.has('autoAccept')) autoAcceptModule.init(ctx);
    if (!_initDisabledIds.has('aramNocd')) aramNocdModule.init(ctx);
    if (!_initDisabledIds.has('autoLockChampion')) autoLockChampionModule.init(ctx);
    if (!_initDisabledIds.has('champSelectQuitButton')) champSelectQuitButtonModule.init(ctx);
    if (!_initDisabledIds.has('SnoozeBalanceTooltip')) SnoozeBalanceTooltipModule.init(ctx);
    if (!_initDisabledIds.has('gameAnalysisPopup')) gameAnalysisPopupModule.init(ctx);
    if (!_initDisabledIds.has('customOnlineStatus')) customOnlineStatusModule.init(ctx);
    if (!_initDisabledIds.has('clientWindowTweaks')) clientWindowTweaksModule.init(ctx);
    if (!_initDisabledIds.has('profileTweaks')) profileTweaksModule.init(ctx);
    if (!_initDisabledIds.has('autoHonor')) autoHonorModule.init(ctx);
    if (!_initDisabledIds.has('arenaGod')) arenaGodModule.init(ctx);
    if (!_initDisabledIds.has('socialPanelTweaks')) socialPanelTweaksModule.init(ctx);
    if (!_initDisabledIds.has('whaleHelper')) whaleHelperModule.init(ctx);
    if (!_initDisabledIds.has('lowPrioWarningSuppress')) penaltyUISuppressModule.init(ctx);
    if (!_initDisabledIds.has('autoQueue')) autoQueueModule.init(ctx);
    if (!_initDisabledIds.has('modeSelectorTweaks')) modeSelectorTweaksModule.init(ctx);
    if (!_initDisabledIds.has('nameSpoofer')) nameSpooferModule.init(ctx);
    if (!_initDisabledIds.has('useClientDuringGame')) useClientDuringGameModule.init(ctx);
}

export async function load(context) {
    if (_loaded) {
        WelcomeModal.init();
        WelcomeModal.showIfNeeded();
        return;
    }
    _loaded = true;
    await Utils.GameData.Assets.init();
    Modal.init();
    WelcomeModal.init();

    // Sync version from @version tag then check for updates if enabled
    await syncVersionWithMetadata();
    WelcomeModal.showIfNeeded();
    checkForUpdates();

    const _disabledIds = getDisabledModuleIds();

    if (!_disabledIds.has('autoAccept')) autoAcceptModule.load();
    if (!_disabledIds.has('aramNocd')) aramNocdModule.load();
    if (!_disabledIds.has('autoLockChampion')) autoLockChampionModule.load();
    if (!_disabledIds.has('champSelectQuitButton')) champSelectQuitButtonModule.load();
    if (!_disabledIds.has('SnoozeBalanceTooltip')) SnoozeBalanceTooltipModule.load();
    if (!_disabledIds.has('gameAnalysisPopup')) gameAnalysisPopupModule.load();
    if (!_disabledIds.has('customOnlineStatus')) customOnlineStatusModule.load();
    if (!_disabledIds.has('clientWindowTweaks')) clientWindowTweaksModule.load();
    if (!_disabledIds.has('profileTweaks')) profileTweaksModule.load();
    if (!_disabledIds.has('autoHonor')) autoHonorModule.load();
    if (!_disabledIds.has('arenaGod')) arenaGodModule.load();
    if (!_disabledIds.has('socialPanelTweaks')) socialPanelTweaksModule.load();
    if (!_disabledIds.has('whaleHelper')) whaleHelperModule.load();
    if (!_disabledIds.has('lowPrioWarningSuppress')) penaltyUISuppressModule.load();
    if (!_disabledIds.has('autoQueue')) autoQueueModule.load();
    if (!_disabledIds.has('modeSelectorTweaks')) modeSelectorTweaksModule.load();
    if (!_disabledIds.has('nameSpoofer')) nameSpooferModule.load();
    if (!_disabledIds.has('useClientDuringGame')) useClientDuringGameModule.load();
}

const LEGACY_MIGRATION_MAP = {
    'sm:aramNocd': {
        module: 'aramNocd',
        key: 'enabled'
    },
    'sm:arenaGod': {
        module: 'arenaGod',
        key: 'enabled'
    },
    'sm:arenaGodPos': {
        module: 'arenaGod',
        key: 'pos'
    },
    'sm:autoAccept': {
        module: 'autoAccept',
        key: 'enabled'
    },
    'sm:autoAcceptDelay': {
        module: 'autoAccept',
        key: 'delay'
    },
    'sm:autoAcceptExitOnDecline': {
        module: 'autoAccept',
        key: 'exitOnDecline'
    },
    'sm:exitOnDecline': {
        module: 'autoAccept',
        key: 'exitOnDecline'
    },
    'sm:autoHonor': {
        module: 'autoHonor',
        key: 'enabled'
    },
    'sm:autoHonorMode': {
        module: 'autoHonor',
        key: 'mode'
    },
    'sm:autoHonorSkip': {
        module: 'autoHonor',
        key: 'skip'
    },
    'sm:autoLockChampion': {
        module: 'autoLockChampion',
        key: 'enabled'
    },
    'sm:autoLockDelay': {
        module: 'autoLockChampion',
        key: 'delay'
    },
    'sm:autoLockInstant': {
        module: 'autoLockChampion',
        key: 'instant'
    },
    'sm:autoLockChampionPickIds': {
        module: 'autoLockChampion',
        key: 'pickIds'
    },
    'sm:autoLockChampionBanIds': {
        module: 'autoLockChampion',
        key: 'banIds'
    },
    'sm:autoLockChampionId': {
        module: 'autoLockChampion',
        key: 'legacyPickId'
    },
    'sm:SnoozeBalanceTooltip': {
        module: 'SnoozeBalanceTooltip',
        key: 'enabled'
    },
    'sm:betterFriendsStatus': {
        module: 'socialPanelTweaks',
        key: 'enabled'
    },
    'sm:betterFriendsStatusDebugEmber': {
        module: 'socialPanelTweaks',
        key: 'debugEmber'
    },
    'sm:champSelectQuitButton': {
        module: 'champSelectQuitButton',
        key: 'enabled'
    },
    'sm:customOnlineStatus': {
        module: 'customOnlineStatus',
        key: 'enabled'
    },
    'sm:customStatus': {
        module: 'customOnlineStatus',
        key: 'status'
    },
    'sm:customStatusMsg': {
        module: 'customOnlineStatus',
        key: 'statusMsg'
    },
    'sm:gameAnalysisPopup': {
        module: 'gameAnalysisPopup',
        key: 'enabled'
    },
    'sm:hotkey': {
        module: 'core',
        key: 'hotkey'
    },
    'sm:lowPrioWarningSuppress': {
        module: 'lowPrioWarningSuppress',
        key: 'enabled'
    },
    'sm:lowPrioWarningSuppressMode': {
        module: 'lowPrioWarningSuppress',
        key: 'mode'
    },
    'sm:whaleHelper': {
        module: 'whaleHelper',
        key: 'lootHelperEnabled'
    },
    'sm:skinTierDisplay': {
        module: 'whaleHelper',
        key: 'skinTierEnabled'
    },
};