/**
 * @name Snooze-Manager
 * @version 1.0.1
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
let _latestRelease = null;     // { version, url, name, body } or null
let _updateCheckPending = false;
let _updateBadgeCallback = null; // set by the Settings tab while it's open

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
  } catch (err) {
    Utils.Debug.warn('[Snooze-Manager] Update check failed:', err);
  } finally {
    _updateCheckPending = false;
  }
}

// Sidebar grouping: which part of the client each module touches. Order here
// is the order categories appear in the menu; ids not listed fall to 'Other'.
const CATEGORY_ORDER = [
  'Champion Select',
  'Matchmaking',
  'In-Game & Post-Game',
  'Profile & Social',
  'Store & Loot',
  'Client',
  'Other',
];
const DEFAULT_CATEGORY = 'Other';
const MODULE_CATEGORY = {
  autoLockChampion: 'Champion Select',
  champSelectQuitButton: 'Champion Select',
  skinRandomizer: 'Champion Select',
  aramNocd: 'Champion Select',
  SnoozeBalanceTooltip: 'Champion Select',
  arenaGod: 'Champion Select',
  autoAccept: 'Matchmaking',
  autoQueue: 'Matchmaking',
  modeSelectorTweaks: 'Matchmaking',
  lowPrioWarningSuppress: 'Matchmaking',
  gameAnalysisPopup: 'In-Game & Post-Game',
  autoHonor: 'In-Game & Post-Game',
  profileTweaks: 'Profile & Social',
  customOnlineStatus: 'Profile & Social',
  socialPanelTweaks: 'Profile & Social',
  whaleHelper: 'Store & Loot',
  whaleHelperSkins: 'Champion Select',
  clientWindowTweaks: 'Client',
};
function categoryOrderIndex(moduleId) {
  const idx = CATEGORY_ORDER.indexOf(MODULE_CATEGORY[moduleId] || DEFAULT_CATEGORY);
  return idx === -1 ? CATEGORY_ORDER.length : idx;
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
      .pm-tab-category { padding: 16px 20px 6px; font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #5a7080; cursor: default; user-select: none; border-top: 1px solid rgba(255, 255, 255, 0.04); }
      .pm-merged-module { margin: 18px 0 8px; }
      .pm-merged-module-title { color: #f0e6d2; font-size: 15px; font-weight: 700; }
      .pm-merged-module-desc { color: #a09b8c; font-size: 12px; line-height: 1.4; margin-top: 2px; }
      .pm-info { display: inline-flex; align-items: center; margin-left: 6px; color: #5a7080; vertical-align: middle; pointer-events: auto; cursor: help; transition: color 0.15s; }
      .pm-info:hover { color: #c8aa6e; }
      .pm-info svg { display: block; }
      .pm-tooltip { position: fixed; z-index: 2147483647; max-width: 260px; padding: 10px 12px; background: rgba(1, 10, 19, 0.95); border: 1px solid rgba(200, 170, 110, 0.35); border-radius: 8px; color: #f0e6d2; font-size: 12px; line-height: 1.4; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6); backdrop-filter: blur(25px) saturate(140%); pointer-events: none; opacity: 0; transition: opacity 0.15s ease; }
      .pm-tooltip.pm-show { opacity: 1; }
      .pm-content { flex: 1; padding: 24px; overflow-y: auto; position: relative; }
      .pm-tab-content { display: none; animation: fadeIn 0.2s ease-in-out; }
      .pm-tab-content.active { display: block; }
      @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
      .pm-section-title { color: #c8aa6e; font-size: 18px; font-weight: bold; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px; }
      .pm-search { display: flex; gap: 8px; margin-bottom: 12px; }
      .pm-input { flex: 1; background: #111; border: 1px solid #3e2e13; color: #f0e6d2; padding: 8px 14px; border-radius: 2px; outline: none; font-size: 13px; transition: border-color 0.2s, background-color 0.2s; }
      .pm-input:focus { border-color: #c8aa6e; background: rgba(0, 0, 0, 0.5); }
      .pm-btn { background: rgba(200, 170, 110, 0.08); border: 1px solid rgba(200, 170, 110, 0.25); color: #c8aa6e; padding: 8px 20px; cursor: pointer; border-radius: 2px; font-weight: bold; transition: all 0.2s ease; font-size: 13px; }
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

    function createCategoryDivider(title) {
      const divider = document.createElement('div');
      divider.className = 'pm-tab-category';
      divider.textContent = title;
      sidebar.appendChild(divider);
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
    Object.assign(regionSelect.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '8px 12px', borderRadius: '2px', outline: 'none', fontSize: '13px', cursor: 'pointer' });
    const regions = [
      { label: 'Local Region', value: '' },
      { label: 'Americas (NA/BR/LAN/LAS)', value: 'NA1' },
      { label: 'Europe (EUW/EUNE/TR/RU)', value: 'EUW' },
      { label: 'Asia (KR/JP)', value: 'KR' },
      { label: 'SEA / OCE', value: 'SG2' }
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
    
    const resultDiv = document.createElement('div');
    resultDiv.style.marginTop = '16px';
    resultDiv.style.fontSize = '14px';

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
                const alias = await Utils.LCU.get('/lol-summoner/v1/alias/lookup?gameName=' + encodeURIComponent(gameName) + '&tagLine=' + encodeURIComponent(tagLine)).catch(()=>null);
                
                if (alias && alias.puuid) {
                    puuidToUse = alias.puuid;
                    finalPlayer = { ...alias, gameName, tagLine };
                }
            }
        } else {
            // Try looking up by old summoner name
            const sumObj = await Utils.LCU.get('/lol-summoner/v1/summoners?name=' + encodeURIComponent(input)).catch(()=>null);
            if (sumObj && sumObj.puuid) {
                puuidToUse = sumObj.puuid;
                finalPlayer = sumObj;
            }
        }

        if (puuidToUse && finalPlayer) {
          try {
            const full = await Utils.LCU.get('/lol-summoner/v2/summoners/puuid/' + puuidToUse).catch(()=>null);
            if (full) finalPlayer = { ...finalPlayer, ...full };
          } catch(e) {}

          resultDiv.innerHTML = '<div style="color:#0ac8b9">Loading Match History...</div>';
          import('./modules/gameAnalysisPopup.js').then(mod => {
            mod.MatchHistoryModal.show(finalPlayer, '', selectedRegion);
          });
          setTimeout(() => { resultDiv.innerHTML = ''; searchInput.value = ''; }, 1000);
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
    lookupContent.appendChild(searchRow);
    lookupContent.appendChild(resultDiv);
    content.appendChild(lookupContent);

    // Modules Sections (grouped by where each feature applies)
    const orderedModules = registeredModules
      .filter(mod => mod.settings && mod.settings.length > 0)
      .sort((a, b) => {
        const oa = categoryOrderIndex(a.id);
        const ob = categoryOrderIndex(b.id);
        if (oa !== ob) return oa - ob;
        return a.name.localeCompare(b.name);
      });

    const isSimpleModule = (mod) => mod.settings.every(s => s.type === 'toggle');
    const categorySlug = (name) =>
      name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

    // custom hover tooltip that matches the menu styling; only fires on the "i" icon
    function attachInfoTooltip(infoEl, text) {
      infoEl.addEventListener('mouseenter', () => {
        let tip = document.getElementById('pm-tooltip-el');
        if (!tip) {
          tip = document.createElement('div');
          tip.id = 'pm-tooltip-el';
          tip.className = 'pm-tooltip';
          (_root || document.body).appendChild(tip);
        }
        tip.textContent = text;
        tip.classList.add('pm-show');
        const r = infoEl.getBoundingClientRect();
        const tw = tip.offsetWidth;
        const th = tip.offsetHeight;
        let left = r.left + r.width / 2 - tw / 2;
        let top = r.top - th - 8;
        if (top < 8) top = r.bottom + 8;
        left = Math.max(8, Math.min(left, window.innerWidth - tw - 8));
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
      });
      infoEl.addEventListener('mouseleave', () => {
        document.getElementById('pm-tooltip-el')?.classList.remove('pm-show');
      });
    }

    // renders one setting (toggle/select/textarea/custom) into a tab page
    function appendSettingRow(tabContent, mod, setting) {
        if (setting.type === 'toggle') {
          const row = document.createElement('div');
          row.className = 'pm-row';

          const lblWrapper = document.createElement('div');
          lblWrapper.className = 'pm-label-wrapper';
          const lblTitle = document.createElement('div');
          lblTitle.className = 'pm-label-title';
          lblTitle.textContent = setting.label || mod.name;
          if (setting.description) {
            const info = document.createElement('span');
            info.className = 'pm-info';
            info.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
            attachInfoTooltip(info, setting.description);
            lblTitle.appendChild(info);
          }
          lblWrapper.appendChild(lblTitle);

          const sw = document.createElement('button');
          sw.type = 'button';
          sw.className = 'pm-toggle-btn ' + (setting.value ? 'on' : 'off');
          
          const toggleFn = (e) => {
            if (e) { e.preventDefault(); e.stopPropagation(); }
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
          Object.assign(select.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '8px', borderRadius: '4px', flex: '1', outline: 'none', fontSize: '14px' });
          
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
          Object.assign(input.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '10px 14px', borderRadius: '4px', outline: 'none', boxSizing: 'border-box', width: '100%', minHeight: '80px', resize: 'vertical', fontFamily: 'inherit', fontSize: '14px' });
          
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
    }

    // Group modules by category (order preserved from orderedModules above),
    // then render each category: one merged page for its toggle-only modules,
    // plus a dedicated tab for every module with richer settings.
    const modulesByCategory = new Map();
    orderedModules.forEach(mod => {
      const category = MODULE_CATEGORY[mod.id] || DEFAULT_CATEGORY;
      if (!modulesByCategory.has(category)) modulesByCategory.set(category, []);
      modulesByCategory.get(category).push(mod);
    });

    modulesByCategory.forEach((mods, category) => {
      createCategoryDivider(category);

      const simpleMods = mods.filter(isSimpleModule);
      const complexMods = mods.filter((mod) => !isSimpleModule(mod));

      if (simpleMods.length) {
        const tabId = 'tab-cat-' + categorySlug(category);
        createTab(tabId, category);

        const tabContent = document.createElement('div');
        tabContent.id = tabId;
        tabContent.className = 'pm-tab-content';

        const pageTitle = document.createElement('div');
        pageTitle.className = 'pm-section-title';
        pageTitle.textContent = category;
        tabContent.appendChild(pageTitle);

        simpleMods.forEach((mod) => {
          const modBlock = document.createElement('div');
          modBlock.className = 'pm-merged-module';
          const h = document.createElement('div');
          h.className = 'pm-merged-module-title';
          h.textContent = mod.name;
          modBlock.appendChild(h);
          if (mod.description) {
            const d = document.createElement('div');
            d.className = 'pm-merged-module-desc';
            d.textContent = mod.description;
            modBlock.appendChild(d);
          }
          tabContent.appendChild(modBlock);
          mod.settings.forEach((setting) => appendSettingRow(tabContent, mod, setting));
        });

        content.appendChild(tabContent);
      }

      complexMods.forEach((mod) => {
        const tabId = 'tab-' + mod.id;
        createTab(tabId, mod.name);

        const tabContent = document.createElement('div');
        tabContent.id = tabId;
        tabContent.className = 'pm-tab-content';

        const modTitle = document.createElement('div');
        modTitle.className = 'pm-section-title';
        modTitle.textContent = mod.name;

        const modDesc = document.createElement('div');
        Object.assign(modDesc.style, { color: '#a09b8c', fontSize: '13px', marginBottom: '20px', lineHeight: '1.5' });
        modDesc.textContent = mod.description;

        tabContent.appendChild(modTitle);
        tabContent.appendChild(modDesc);

        mod.settings.forEach((setting) => appendSettingRow(tabContent, mod, setting));
        content.appendChild(tabContent);
      });
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
      
      let currentHotkey = Utils.Store.get('core', 'hotkeyObj');
      if (!currentHotkey) {
        const legacyHotkey = Utils.Store.get('core', 'hotkey');
        if (typeof legacyHotkey === 'string') {
          currentHotkey = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: legacyHotkey, display: legacyHotkey };
        } else {
          currentHotkey = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: 'F1', display: 'F1' };
        }
      }
      
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
            document.removeEventListener('keydown', onKeyDown, { capture: true });
            document.removeEventListener('keyup', onKeyUp, { capture: true });
            document.removeEventListener('mousedown', onMouseDown, { capture: true });
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

        document.addEventListener('keydown', onKeyDown, { capture: true });
        document.addEventListener('keyup', onKeyUp, { capture: true });
        document.addEventListener('mousedown', onMouseDown, { capture: true });
      });

      hotkeyRow.appendChild(hotkeyLabel);
      hotkeyRow.appendChild(hotkeyBtn);
      generalSection.appendChild(hotkeyRow);

      const panicRow = document.createElement('div');
      panicRow.className = 'pm-settings-row';
      const panicLabel = document.createElement('span');
      panicLabel.className = 'pm-settings-row-label';
      panicLabel.textContent = 'Panic Key (Cancel Auto Actions)';

      const panicBtn = document.createElement('button');
      panicBtn.className = 'pm-btn';
      panicBtn.style.minWidth = '140px';

      let currentPanicKey = Utils.Store.get('global', 'panicKey') || 'F2';
      panicBtn.textContent = currentPanicKey;

      panicBtn.addEventListener('click', (e) => {
        e.preventDefault();
        if (panicBtn.dataset.capturing) return;
        panicBtn.dataset.capturing = '1';
        panicBtn.textContent = 'Press a key...';
        panicBtn.style.borderColor = '#0ac8b9';
        panicBtn.style.color = '#0ac8b9';

        const handler = (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          let newKey = ev.key;
          if (newKey === ' ') newKey = 'Space';
          document.removeEventListener('keydown', handler, { capture: true });
          delete panicBtn.dataset.capturing;
          currentPanicKey = newKey;
          Utils.Store.set('global', 'panicKey', newKey);
          panicBtn.textContent = newKey;
          panicBtn.style.borderColor = '';
          panicBtn.style.color = '';
        };
        document.addEventListener('keydown', handler, { capture: true });
      });

      panicRow.appendChild(panicLabel);
      panicRow.appendChild(panicBtn);
      generalSection.appendChild(panicRow);

      const panicDesc = document.createElement('div');
      panicDesc.className = 'pm-settings-section-desc';
      panicDesc.style.marginTop = '8px';
      panicDesc.textContent = 'Press this key during champion select to cancel auto-lock for the current champ select only. It re-enables automatically next champ select.';
      generalSection.appendChild(panicDesc);

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
        setTimeout(() => { checkStatus.textContent = ''; }, 3000);
      });

      checkBtnRow.appendChild(checkBtn);
      checkBtnRow.appendChild(checkStatus);
      updateSection.appendChild(checkBtnRow);
      wrap.appendChild(updateSection);

      // About Section 
      const aboutSection = makeSettingsSection('About', '');

      const aboutContent = document.createElement('div');
      aboutContent.style.cssText = 'font-size:12px;color:#3a5060;line-height:1.8;margin-top:8px;';

      const aboutLines = [
        { label: 'Plugin:', value: 'Snooze-Manager by Reformed Doge' },
        { label: 'Version:', value: `v${CURRENT_VERSION}` },
        { label: 'GitHub:', value: 'github.com/ReformedDoge/Snooze-Manager', href: 'https://github.com/ReformedDoge/Snooze-Manager' },
      ];

      aboutLines.forEach(({ label, value, href }) => {
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
      wrap.appendChild(devSection);

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
    if (_visible) hide(); else show();
  }

  function onChange(f) {
    _cbs.add(f);
    return () => _cbs.delete(f);
  }

  function init() {
    create();
    document.addEventListener('keydown', (e) => {
      if (window._isCapturingHotkey) return;

      let shortcut = Utils.Store.get('core', 'hotkeyObj');
      if (!shortcut) {
        const legacy = Utils.Store.get('core', 'hotkey');
        if (typeof legacy === 'string') {
          shortcut = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: legacy, display: legacy };
        } else {
          shortcut = { ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, code: 'F1', display: 'F1' };
        }
      }

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

  return { init, show, hide, toggle, onChange };
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
import * as lowPrioWarningSuppressModule from './modules/LowPrioWarningSuppress.js';
import * as autoQueueModule from './modules/autoQueue.js';
import * as modeSelectorTweaksModule from './modules/modeSelectorTweaks.js';
import * as skinRandomizerModule from './modules/skinRandomizer.js';

const registeredModules = [];



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
  } catch(e) {}


  // Register the global SnoozeManager early so modules can hook into it
  window.SnoozeManager = { 
  init, load, 
  __isLoader: true, // Flag to tell modules NOT to show native settings
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
    } catch(e) {}
  },
  registerModule: (config) => {
    registeredModules.push(config);
    Utils.Debug.log(`[Snooze-Manager] Registered module: ${config.name}`);
  }
  };

  autoAcceptModule.init(ctx);
  aramNocdModule.init(ctx);
  autoLockChampionModule.init(ctx);
  champSelectQuitButtonModule.init(ctx);
  SnoozeBalanceTooltipModule.init(ctx);
  gameAnalysisPopupModule.init(ctx);
  customOnlineStatusModule.init(ctx);
  clientWindowTweaksModule.init(ctx);
  profileTweaksModule.init(ctx);
  autoHonorModule.init(ctx);
  arenaGodModule.init(ctx);
  socialPanelTweaksModule.init(ctx);
  whaleHelperModule.init(ctx);
  lowPrioWarningSuppressModule.init(ctx);
  autoQueueModule.init(ctx);
  modeSelectorTweaksModule.init(ctx);
  skinRandomizerModule.init(ctx);
}

export async function load(context) {
  if (_loaded) return;
  _loaded = true;
  await Utils.GameData.Assets.init();
  Modal.init();

  // Sync version from @version tag then check for updates if enabled
  await syncVersionWithMetadata();
  checkForUpdates();

  
  autoAcceptModule.load();
  aramNocdModule.load();
  autoLockChampionModule.load();
  champSelectQuitButtonModule.load();
  SnoozeBalanceTooltipModule.load();
  gameAnalysisPopupModule.load();
  customOnlineStatusModule.load();
  clientWindowTweaksModule.load();
  profileTweaksModule.load();
  autoHonorModule.load();
  arenaGodModule.load();
  socialPanelTweaksModule.load();
  whaleHelperModule.load();
  lowPrioWarningSuppressModule.load();
  autoQueueModule.load();
  modeSelectorTweaksModule.load();
  skinRandomizerModule.load();
}

const LEGACY_MIGRATION_MAP = {
  'sm:aramNocd': { module: 'aramNocd', key: 'enabled' },
  'sm:arenaGod': { module: 'arenaGod', key: 'enabled' },
  'sm:arenaGodPos': { module: 'arenaGod', key: 'pos' },
  'sm:autoAccept': { module: 'autoAccept', key: 'enabled' },
  'sm:autoAcceptDelay': { module: 'autoAccept', key: 'delay' },
  'sm:autoAcceptExitOnDecline': { module: 'autoAccept', key: 'exitOnDecline' },
  'sm:exitOnDecline': { module: 'autoAccept', key: 'exitOnDecline' },
  'sm:autoHonor': { module: 'autoHonor', key: 'enabled' },
  'sm:autoHonorMode': { module: 'autoHonor', key: 'mode' },
  'sm:autoHonorSkip': { module: 'autoHonor', key: 'skip' },
  'sm:autoLockChampion': { module: 'autoLockChampion', key: 'enabled' },
  'sm:autoLockDelay': { module: 'autoLockChampion', key: 'delay' },
  'sm:autoLockInstant': { module: 'autoLockChampion', key: 'instant' },
  'sm:autoLockChampionPickIds': { module: 'autoLockChampion', key: 'pickIds' },
  'sm:autoLockChampionBanIds': { module: 'autoLockChampion', key: 'banIds' },
  'sm:autoLockChampionId': { module: 'autoLockChampion', key: 'legacyPickId' },
  'sm:SnoozeBalanceTooltip': { module: 'SnoozeBalanceTooltip', key: 'enabled' },
  'sm:betterFriendsStatus': { module: 'socialPanelTweaks', key: 'enabled' },
  'sm:betterFriendsStatusDebugEmber': { module: 'socialPanelTweaks', key: 'debugEmber' },
  'sm:champSelectQuitButton': { module: 'champSelectQuitButton', key: 'enabled' },
  'sm:customOnlineStatus': { module: 'customOnlineStatus', key: 'enabled' },
  'sm:customStatus': { module: 'customOnlineStatus', key: 'status' },
  'sm:customStatusMsg': { module: 'customOnlineStatus', key: 'statusMsg' },
  'sm:gameAnalysisPopup': { module: 'gameAnalysisPopup', key: 'enabled' },
  'sm:hotkey': { module: 'core', key: 'hotkey' },
  'sm:lowPrioWarningSuppress': { module: 'lowPrioWarningSuppress', key: 'enabled' },
  'sm:lowPrioWarningSuppressMode': { module: 'lowPrioWarningSuppress', key: 'mode' },
  'sm:whaleHelper': { module: 'whaleHelper', key: 'lootHelperEnabled' },
  'sm:skinTierDisplay': { module: 'whaleHelper', key: 'skinTierEnabled' },
};
