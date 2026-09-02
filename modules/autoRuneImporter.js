/**
 * @name Snooze-AutoRuneImporter
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Auto-imports optimal rune pages and summoner spells with Riot Recommended and Meta builds, featuring an interactive champ-select build selector widget.
 * @link https://github.com/ReformedDoge
 */
import Utils, { t } from './generalUtils.js';

const MODULE_KEY = 'autoRuneImporter';

// State
let isEnabled = false;
let autoApplyOnLock = false;
let importSpells = true;
let flashKeyPreference = 'D'; // 'D' | 'F' | 'keep'
let defaultSource = 'riot'; // 'riot' | 'blitz'
let showWidget = true;

let sessionUnsub = null;
let gameflowUnsub = null;
let currentSession = null;
let currentChampionId = 0;
let currentPosition = '';
let currentBuilds = [];
let appliedBuildId = null;
let autoAppliedForGame = false;
let lastGameId = null;
let widgetElement = null;
let isWidgetCollapsed = false;

// Style definitions
const PERK_STYLES = {
    8000: { id: 8000, name: 'Precision', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7201_Precision.png' },
    8100: { id: 8100, name: 'Domination', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7200_Domination.png' },
    8200: { id: 8200, name: 'Sorcery', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7202_Sorcery.png' },
    8300: { id: 8300, name: 'Inspiration', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7203_Whimsy.png' },
    8400: { id: 8400, name: 'Resolve', iconPath: '/lol-game-data/assets/v1/perk-images/Styles/7204_Resolve.png' }
};

const SUMMONER_SPELLS = {
    1: { id: 1, name: 'Cleanse', icon: '/lol-game-data/assets/v1/summoner-spells/1.png' },
    3: { id: 3, name: 'Exhaust', icon: '/lol-game-data/assets/v1/summoner-spells/3.png' },
    4: { id: 4, name: 'Flash', icon: '/lol-game-data/assets/v1/summoner-spells/4.png' },
    6: { id: 6, name: 'Ghost', icon: '/lol-game-data/assets/v1/summoner-spells/6.png' },
    7: { id: 7, name: 'Heal', icon: '/lol-game-data/assets/v1/summoner-spells/7.png' },
    11: { id: 11, name: 'Smite', icon: '/lol-game-data/assets/v1/summoner-spells/11.png' },
    12: { id: 12, name: 'Teleport', icon: '/lol-game-data/assets/v1/summoner-spells/12.png' },
    14: { id: 14, name: 'Ignite', icon: '/lol-game-data/assets/v1/summoner-spells/14.png' },
    21: { id: 21, name: 'Barrier', icon: '/lol-game-data/assets/v1/summoner-spells/21.png' },
    32: { id: 32, name: 'Mark', icon: '/lol-game-data/assets/v1/summoner-spells/32.png' }
};

function loadSettings() {
    isEnabled = Utils.Store.get(MODULE_KEY, 'enabled') ?? true;
    autoApplyOnLock = Utils.Store.get(MODULE_KEY, 'autoApplyOnLock') ?? false;
    importSpells = Utils.Store.get(MODULE_KEY, 'importSpells') ?? true;
    flashKeyPreference = Utils.Store.get(MODULE_KEY, 'flashKey') || 'D';
    defaultSource = Utils.Store.get(MODULE_KEY, 'source') || 'riot';
    showWidget = Utils.Store.get(MODULE_KEY, 'showWidget') ?? true;
    isWidgetCollapsed = Utils.Store.get(MODULE_KEY, 'widgetCollapsed') ?? false;
}

function getStyleInfo(styleId) {
    return PERK_STYLES[styleId] || { id: styleId, name: 'Runes', iconPath: '' };
}

function getSpellIcon(spellId) {
    if (!spellId) return '';
    return SUMMONER_SPELLS[spellId]?.icon || `/lol-game-data/assets/v1/summoner-spells/${spellId}.png`;
}

function getSpellName(spellId) {
    if (!spellId) return '';
    return SUMMONER_SPELLS[spellId]?.name || `Spell ${spellId}`;
}

// ---------------------------------------------------------
// Build Fetching (Riot LCU & Blitz Meta API)
// ---------------------------------------------------------

async function fetchRiotBuilds(champId, position = '') {
    try {
        if (!Utils.LCU?.get) return [];
        const pages = await Utils.LCU.get('/lol-perks/v1/recommended-pages').catch(() => []);
        if (!Array.isArray(pages) || pages.length === 0) return [];

        const champPages = pages.filter(p => !p.championId || Number(p.championId) === Number(champId));
        const listToUse = champPages.length > 0 ? champPages : pages;

        return listToUse.map((page, idx) => {
            const primaryStyle = getStyleInfo(page.primaryStyleId);
            const subStyle = getStyleInfo(page.subStyleId);
            const keystoneId = page.keystone?.id || page.selectedPerkIds?.[0] || 0;
            const keystoneIcon = page.keystone?.iconPath || (keystoneId ? `/lol-game-data/assets/v1/perk-images/Styles/${primaryStyle.name}/${page.keystone?.name || 'Keystone'}.png` : primaryStyle.iconPath);

            const posName = page.position ? page.position.toUpperCase() : (position ? position.toUpperCase() : '');
            let title = page.name || page.title || `${primaryStyle.name} Build`;
            if (page.keystone?.name) {
                title = `${page.keystone.name} • ${subStyle.name}`;
            }

            return {
                id: `riot-${page.id || idx}`,
                source: 'riot',
                sourceLabel: t('Riot Recommended'),
                name: title,
                position: posName,
                primaryStyleId: page.primaryStyleId,
                subStyleId: page.subStyleId,
                selectedPerkIds: page.selectedPerkIds || [],
                keystoneId,
                keystoneName: page.keystone?.name || 'Keystone',
                keystoneIcon,
                primaryStyleIcon: primaryStyle.iconPath,
                subStyleIcon: subStyle.iconPath,
                primaryStyleName: primaryStyle.name,
                subStyleName: subStyle.name,
                summonerSpell1: page.summonerSpell1 || page.spell1Id || 4,
                summonerSpell2: page.summonerSpell2 || page.spell2Id || 14,
                winRate: null,
                pickRate: null,
                recommendationType: page.recommendationType || 'RECOMMENDED'
            };
        });
    } catch (e) {
        Utils.Debug.error('[AutoRune] Failed to fetch Riot recommended builds:', e);
        return [];
    }
}

async function fetchBlitzBuilds(champId, position = '') {
    try {
        const url = `https://league-client-builds.blitz.gg/v1/champions/${champId}/builds`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(3500) });
        if (!resp.ok) return [];
        const data = await resp.json();
        if (!data || !Array.isArray(data.builds)) return [];

        const results = [];
        for (const [idx, b] of data.builds.entries()) {
            if (!b?.runes || !b.runes.primary_style_id) continue;

            const primaryStyle = getStyleInfo(b.runes.primary_style_id);
            const subStyle = getStyleInfo(b.runes.sub_style_id);
            const perks = Array.isArray(b.runes.perk_ids) ? b.runes.perk_ids : [];
            const keystoneId = perks[0] || 0;

            const spells = Array.isArray(b.spells) ? b.spells : [4, 14];
            const role = (b.role || b.position || position || '').toUpperCase();
            const wr = typeof b.win_rate === 'number' ? (b.win_rate * 100).toFixed(1) : null;
            const pr = typeof b.pick_rate === 'number' ? (b.pick_rate * 100).toFixed(1) : null;

            results.push({
                id: `blitz-${idx}`,
                source: 'blitz',
                sourceLabel: t('Meta Build'),
                name: b.name || `${primaryStyle.name} (${role || 'Meta'})`,
                position: role,
                primaryStyleId: b.runes.primary_style_id,
                subStyleId: b.runes.sub_style_id,
                selectedPerkIds: perks,
                keystoneId,
                keystoneName: b.runes.keystone_name || 'Keystone',
                keystoneIcon: primaryStyle.iconPath,
                primaryStyleIcon: primaryStyle.iconPath,
                subStyleIcon: subStyle.iconPath,
                primaryStyleName: primaryStyle.name,
                subStyleName: subStyle.name,
                summonerSpell1: spells[0] || 4,
                summonerSpell2: spells[1] || 14,
                winRate: wr,
                pickRate: pr,
                gamesCount: b.games_count || null
            });
        }
        return results;
    } catch (e) {
        Utils.Debug.log('[AutoRune] Blitz API unavailable or timed out, using fallback');
        return [];
    }
}

async function loadBuildsForChampion(champId, position = '') {
    if (!champId) {
        currentBuilds = [];
        return [];
    }

    let builds = [];
    const preferred = Utils.Store.get(MODULE_KEY, 'source') || defaultSource;

    if (preferred === 'blitz') {
        builds = await fetchBlitzBuilds(champId, position);
        if (builds.length === 0) {
            builds = await fetchRiotBuilds(champId, position);
        }
    } else {
        builds = await fetchRiotBuilds(champId, position);
        if (builds.length === 0) {
            builds = await fetchBlitzBuilds(champId, position);
        }
    }

    currentBuilds = builds;
    return builds;
}

// ---------------------------------------------------------
// Applying Runes and Summoner Spells
// ---------------------------------------------------------

async function applyRunePage(build) {
    if (!Utils.LCU || !build || !build.selectedPerkIds?.length) return false;

    try {
        const pageName = `Snooze: ${build.name.slice(0, 18)}`;
        const payload = {
            name: pageName,
            primaryStyleId: build.primaryStyleId,
            subStyleId: build.subStyleId,
            selectedPerkIds: build.selectedPerkIds,
            current: true
        };

        // 1. Try updating current page if editable
        const currentPage = await Utils.LCU.get('/lol-perks/v1/currentpage').catch(() => null);
        if (currentPage && (currentPage.isEditable || currentPage.isCustom)) {
            await Utils.LCU.put(`/lol-perks/v1/pages/${currentPage.id}`, payload);
            Utils.Debug.log(`[AutoRune] Updated active perk page ${currentPage.id}`);
            return true;
        }

        // 2. Otherwise find first editable custom page
        const pages = await Utils.LCU.get('/lol-perks/v1/pages').catch(() => []);
        const editablePage = Array.isArray(pages) ? pages.find(p => p.isEditable || p.isCustom) : null;

        if (editablePage) {
            await Utils.LCU.put(`/lol-perks/v1/pages/${editablePage.id}`, payload);
            Utils.Debug.log(`[AutoRune] Updated editable perk page ${editablePage.id}`);
            return true;
        }

        // 3. Try creating a new custom page or replacing
        await Utils.LCU.post('/lol-perks/v1/pages', payload).catch(async () => {
            if (Array.isArray(pages) && pages.length > 0) {
                // Delete oldest page to free up slot
                const oldest = pages[pages.length - 1];
                if (oldest?.id && (oldest.isEditable || oldest.isCustom)) {
                    await Utils.LCU.delete(`/lol-perks/v1/pages/${oldest.id}`).catch(() => {});
                    await Utils.LCU.post('/lol-perks/v1/pages', payload).catch(() => {});
                }
            }
        });

        return true;
    } catch (e) {
        Utils.Debug.error('[AutoRune] Failed to apply rune page:', e);
        return false;
    }
}

async function applySummonerSpells(spell1Id, spell2Id) {
    if (!Utils.LCU || !spell1Id || !spell2Id) return false;

    try {
        let s1 = Number(spell1Id);
        let s2 = Number(spell2Id);
        const pref = Utils.Store.get(MODULE_KEY, 'flashKey') || flashKeyPreference;

        // Flash is spell ID 4
        if (pref === 'D') {
            if (s2 === 4 && s1 !== 4) {
                [s1, s2] = [s2, s1];
            }
        } else if (pref === 'F') {
            if (s1 === 4 && s2 !== 4) {
                [s1, s2] = [s2, s1];
            }
        }

        await Utils.LCU.patch('/lol-champ-select/v1/session/my-selection', {
            spell1Id: s1,
            spell2Id: s2
        });
        Utils.Debug.log(`[AutoRune] Applied summoner spells: ${s1}, ${s2} (Flash pref: ${pref})`);
        return true;
    } catch (e) {
        Utils.Debug.error('[AutoRune] Failed to apply summoner spells:', e);
        return false;
    }
}

export async function applyBuild(build, silent = false) {
    if (!build) return;

    const runesOk = await applyRunePage(build);
    let spellsOk = true;

    const shouldImportSpells = Utils.Store.get(MODULE_KEY, 'importSpells') ?? importSpells;
    if (shouldImportSpells && build.summonerSpell1 && build.summonerSpell2) {
        spellsOk = await applySummonerSpells(build.summonerSpell1, build.summonerSpell2);
    }

    if (runesOk) {
        appliedBuildId = build.id;
        updateWidgetActiveState();
        if (!silent) {
            Utils.Toast.success(
                t('Applied {{name}} runes & spells!', { name: build.name }),
                { duration: 4000, closable: true, position: 'bottom-right' }
            );
        }
    }
}

// ---------------------------------------------------------
// Champ Select Widget UI
// ---------------------------------------------------------

function createWidgetStyles() {
    const styleId = 'snooze-rune-importer-styles';
    if (document.getElementById(styleId)) return;

    const s = document.createElement('style');
    s.id = styleId;
    s.textContent = `
    #snooze-rune-widget {
        position: fixed;
        bottom: 75px;
        right: 25px;
        z-index: 99999;
        width: 380px;
        background: radial-gradient(circle at 50% 0%, rgba(10, 200, 185, 0.12), transparent 45%), linear-gradient(180deg, rgba(1, 10, 19, 0.94), rgba(1, 10, 19, 0.88));
        border: 1px solid rgba(200, 170, 110, 0.4);
        border-radius: 10px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.75), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        backdrop-filter: blur(18px) saturate(140%);
        -webkit-backdrop-filter: blur(18px) saturate(140%);
        font-family: var(--font-body), "Segoe UI", sans-serif;
        color: #a09b8c;
        overflow: hidden;
        transition: transform 0.2s ease, opacity 0.2s ease;
        pointer-events: auto;
        user-select: none;
    }
    #snooze-rune-widget.collapsed {
        width: 260px;
    }
    #snooze-rune-widget.collapsed .srw-body,
    #snooze-rune-widget.collapsed .srw-footer {
        display: none;
    }
    .srw-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 14px;
        background: rgba(0, 0, 0, 0.25);
        border-bottom: 1px solid rgba(255, 255, 255, 0.06);
        cursor: move;
    }
    .srw-header-left {
        display: flex;
        align-items: center;
        gap: 10px;
    }
    .srw-champ-icon {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 1.5px solid #c8aa6e;
        object-fit: cover;
        background: #111;
    }
    .srw-champ-title {
        font-size: 13px;
        font-weight: 800;
        color: #f0e6d2;
        line-height: 1.2;
    }
    .srw-role-badge {
        display: inline-block;
        font-size: 10px;
        font-weight: 700;
        color: #0ac8b9;
        text-transform: uppercase;
        letter-spacing: 0.5px;
    }
    .srw-header-controls {
        display: flex;
        align-items: center;
        gap: 6px;
    }
    .srw-btn-icon {
        background: none;
        border: none;
        color: #a09b8c;
        font-size: 14px;
        cursor: pointer;
        padding: 4px;
        line-height: 1;
        transition: color 0.15s;
    }
    .srw-btn-icon:hover {
        color: #f0e6d2;
    }
    .srw-body {
        padding: 12px;
        max-height: 320px;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }
    .srw-body::-webkit-scrollbar {
        width: 4px;
    }
    .srw-body::-webkit-scrollbar-thumb {
        background: rgba(200, 170, 110, 0.25);
        border-radius: 2px;
    }
    .srw-source-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 4px;
        padding: 0 2px;
    }
    .srw-source-pills {
        display: flex;
        gap: 4px;
        background: rgba(0, 0, 0, 0.35);
        padding: 2px;
        border-radius: 4px;
        border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .srw-source-pill {
        padding: 3px 8px;
        font-size: 11px;
        font-weight: 700;
        color: #8a9aaa;
        background: transparent;
        border: none;
        border-radius: 3px;
        cursor: pointer;
        transition: all 0.15s ease;
    }
    .srw-source-pill.active {
        background: rgba(200, 170, 110, 0.18);
        color: #f0e6d2;
    }
    .srw-build-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.02);
        border: 1px solid rgba(200, 170, 110, 0.16);
        border-radius: 8px;
        transition: all 0.2s ease;
        cursor: pointer;
    }
    .srw-build-card:hover {
        background: rgba(200, 170, 110, 0.06);
        border-color: rgba(200, 170, 110, 0.4);
        transform: translateY(-1px);
    }
    .srw-build-card.applied {
        border-color: #0ac8b9;
        background: rgba(10, 200, 185, 0.08);
    }
    .srw-build-icons {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-shrink: 0;
    }
    .srw-keystone-icon {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        background: #010a13;
        border: 1px solid rgba(200, 170, 110, 0.4);
        object-fit: cover;
    }
    .srw-substyle-icon {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        opacity: 0.85;
    }
    .srw-build-info {
        flex: 1;
        min-width: 0;
    }
    .srw-build-name {
        font-size: 13px;
        font-weight: 700;
        color: #f0e6d2;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }
    .srw-build-meta {
        font-size: 11px;
        color: #8a9aaa;
        display: flex;
        gap: 8px;
        margin-top: 2px;
    }
    .srw-wr-badge {
        color: #0ac8b9;
        font-weight: 700;
    }
    .srw-build-actions {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        flex-shrink: 0;
    }
    .srw-spells-preview {
        display: flex;
        gap: 3px;
    }
    .srw-spell-mini {
        width: 18px;
        height: 18px;
        border-radius: 3px;
        border: 1px solid rgba(255, 255, 255, 0.1);
    }
    .srw-apply-btn {
        background: rgba(200, 170, 110, 0.12);
        border: 1px solid rgba(200, 170, 110, 0.35);
        color: #c8aa6e;
        padding: 4px 10px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
        transition: all 0.15s ease;
        letter-spacing: 0.3px;
    }
    .srw-apply-btn:hover {
        background: #c8aa6e;
        color: #010a13;
    }
    .srw-build-card.applied .srw-apply-btn {
        background: #0ac8b9;
        border-color: #0ac8b9;
        color: #010a13;
    }
    .srw-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 8px 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.05);
        background: rgba(0, 0, 0, 0.2);
        font-size: 11px;
    }
    .srw-auto-apply-label {
        display: flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        color: #8a9aaa;
    }
    .srw-auto-apply-label input {
        accent-color: #0ac8b9;
        cursor: pointer;
    }
    `;
    document.head.appendChild(s);
}

function updateWidgetActiveState() {
    if (!widgetElement) return;
    const cards = widgetElement.querySelectorAll('.srw-build-card');
    cards.forEach(card => {
        const id = card.getAttribute('data-build-id');
        const btn = card.querySelector('.srw-apply-btn');
        if (id === appliedBuildId) {
            card.classList.add('applied');
            if (btn) btn.textContent = t('✓ Active');
        } else {
            card.classList.remove('applied');
            if (btn) btn.textContent = t('Apply');
        }
    });
}

function renderWidget(champId, position, builds) {
    createWidgetStyles();

    if (!showWidget || !champId || champId <= 0) {
        removeWidget();
        return;
    }

    const champName = Utils.GameData?.Assets?.getChampionName?.(champId) || `Champion ${champId}`;
    const champIcon = `/lol-game-data/assets/v1/champion-icons/${champId}.png`;

    if (!widgetElement) {
        widgetElement = document.createElement('div');
        widgetElement.id = 'snooze-rune-widget';
        if (isWidgetCollapsed) widgetElement.classList.add('collapsed');
        document.body.appendChild(widgetElement);
        setupDraggable(widgetElement);
    }

    const currentSource = Utils.Store.get(MODULE_KEY, 'source') || defaultSource;
    const isAutoOn = Utils.Store.get(MODULE_KEY, 'autoApplyOnLock') ?? autoApplyOnLock;

    let buildsHtml = '';
    if (!builds || builds.length === 0) {
        buildsHtml = `<div style="text-align:center;padding:20px;color:#8a9aaa;font-size:12px;">${t('Loading builds...')}</div>`;
    } else {
        buildsHtml = builds.map(b => {
            const isApplied = b.id === appliedBuildId;
            const wrBadge = b.winRate ? `<span class="srw-wr-badge">${b.winRate}% WR</span>` : '';
            const prBadge = b.pickRate ? `<span>${b.pickRate}% Pick</span>` : '';
            const gamesBadge = b.gamesCount ? `<span>${b.gamesCount} games</span>` : '';

            const spell1 = getSpellIcon(b.summonerSpell1);
            const spell2 = getSpellIcon(b.summonerSpell2);

            return `
            <div class="srw-build-card ${isApplied ? 'applied' : ''}" data-build-id="${b.id}">
                <div class="srw-build-icons">
                    <img class="srw-keystone-icon" src="${b.primaryStyleIcon || b.keystoneIcon}" onerror="this.style.opacity='0.5'" title="${b.keystoneName}">
                    ${b.subStyleIcon ? `<img class="srw-substyle-icon" src="${b.subStyleIcon}" title="${b.subStyleName}">` : ''}
                </div>
                <div class="srw-build-info">
                    <div class="srw-build-name">${b.name}</div>
                    <div class="srw-build-meta">
                        ${wrBadge}
                        ${prBadge}
                        ${gamesBadge}
                    </div>
                </div>
                <div class="srw-build-actions">
                    <div class="srw-spells-preview">
                        ${spell1 ? `<img class="srw-spell-mini" src="${spell1}">` : ''}
                        ${spell2 ? `<img class="srw-spell-mini" src="${spell2}">` : ''}
                    </div>
                    <button class="srw-apply-btn">${isApplied ? t('✓ Active') : t('Apply')}</button>
                </div>
            </div>`;
        }).join('');
    }

    widgetElement.innerHTML = `
        <div class="srw-header">
            <div class="srw-header-left">
                <img class="srw-champ-icon" src="${champIcon}" onerror="this.style.opacity='0.4'">
                <div>
                    <div class="srw-champ-title">${champName}</div>
                    <div class="srw-role-badge">${position || t('ALL ROLES')}</div>
                </div>
            </div>
            <div class="srw-header-controls">
                <button class="srw-btn-icon srw-collapse-btn" title="${t('Minimize')}">─</button>
                <button class="srw-btn-icon srw-close-btn" title="${t('Close')}">✕</button>
            </div>
        </div>
        <div class="srw-body">
            <div class="srw-source-bar">
                <span style="font-size:11px;font-weight:700;color:#c8aa6e;text-transform:uppercase;">${t('Build Source')}</span>
                <div class="srw-source-pills">
                    <button class="srw-source-pill ${currentSource === 'riot' ? 'active' : ''}" data-src="riot">⚡ ${t('Riot')}</button>
                    <button class="srw-source-pill ${currentSource === 'blitz' ? 'active' : ''}" data-src="blitz">🌐 ${t('Meta')}</button>
                </div>
            </div>
            ${buildsHtml}
        </div>
        <div class="srw-footer">
            <label class="srw-auto-apply-label">
                <input type="checkbox" class="srw-auto-cb" ${isAutoOn ? 'checked' : ''}>
                <span>${t('Auto-apply on lock')}</span>
            </label>
        </div>
    `;

    // Event listeners
    const collapseBtn = widgetElement.querySelector('.srw-collapse-btn');
    collapseBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        isWidgetCollapsed = !isWidgetCollapsed;
        Utils.Store.set(MODULE_KEY, 'widgetCollapsed', isWidgetCollapsed);
        widgetElement.classList.toggle('collapsed', isWidgetCollapsed);
    });

    const closeBtn = widgetElement.querySelector('.srw-close-btn');
    closeBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        removeWidget();
    });

    const autoCb = widgetElement.querySelector('.srw-auto-cb');
    autoCb?.addEventListener('change', (e) => {
        Utils.Store.set(MODULE_KEY, 'autoApplyOnLock', e.target.checked);
        autoApplyOnLock = e.target.checked;
    });

    const pills = widgetElement.querySelectorAll('.srw-source-pill');
    pills.forEach(pill => {
        pill.addEventListener('click', async (e) => {
            e.stopPropagation();
            const src = pill.getAttribute('data-src');
            Utils.Store.set(MODULE_KEY, 'source', src);
            pills.forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            const newBuilds = await loadBuildsForChampion(currentChampionId, currentPosition);
            renderWidget(currentChampionId, currentPosition, newBuilds);
        });
    });

    const cards = widgetElement.querySelectorAll('.srw-build-card');
    cards.forEach(card => {
        const id = card.getAttribute('data-build-id');
        const targetBuild = builds.find(b => b.id === id);
        if (targetBuild) {
            card.addEventListener('click', () => {
                applyBuild(targetBuild, false);
            });
        }
    });
}

function removeWidget() {
    if (widgetElement) {
        widgetElement.remove();
        widgetElement = null;
    }
}

function setupDraggable(el) {
    let isDragging = false;
    let startX = 0;
    let startY = 0;
    let initialX = 0;
    let initialY = 0;

    const header = el.querySelector('.srw-header');
    if (!header) return;

    header.addEventListener('mousedown', (e) => {
        if (e.target.closest('.srw-header-controls')) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = el.getBoundingClientRect();
        initialX = rect.left;
        initialY = rect.top;

        const onMouseMove = (moveEvent) => {
            if (!isDragging) return;
            const dx = moveEvent.clientX - startX;
            const dy = moveEvent.clientY - startY;
            const newX = Math.max(10, Math.min(window.innerWidth - el.offsetWidth - 10, initialX + dx));
            const newY = Math.max(10, Math.min(window.innerHeight - el.offsetHeight - 10, initialY + dy));
            el.style.left = `${newX}px`;
            el.style.top = `${newY}px`;
            el.style.right = 'auto';
            el.style.bottom = 'auto';
        };

        const onMouseUp = () => {
            isDragging = false;
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

// ---------------------------------------------------------
// Champ Select Session Watcher
// ---------------------------------------------------------

async function onChampSelectSession(session) {
    if (!isEnabled || !session) {
        removeWidget();
        return;
    }

    currentSession = session;

    // Reset auto-apply on new game
    if (session.gameId && session.gameId !== lastGameId) {
        lastGameId = session.gameId;
        autoAppliedForGame = false;
        appliedBuildId = null;
    }

    const localCellId = session.localPlayerCellId;
    const myCell = session.myTeam?.find(m => m.cellId === localCellId);
    if (!myCell) return;

    const assignedPos = (myCell.assignedPosition || '').toUpperCase();
    currentPosition = assignedPos;

    // Detect active champion (locked or hovered)
    let champId = myCell.championId || myCell.championPickIntent || 0;
    const isLocked = myCell.championId > 0;

    if (champId !== currentChampionId) {
        currentChampionId = champId;
        appliedBuildId = null;
        if (champId > 0) {
            const builds = await loadBuildsForChampion(champId, assignedPos);
            renderWidget(champId, assignedPos, builds);

            // Auto-apply on lock if enabled
            if (isLocked && autoApplyOnLock && !autoAppliedForGame && builds.length > 0) {
                autoAppliedForGame = true;
                applyBuild(builds[0], false);
            }
        } else {
            removeWidget();
        }
    } else if (isLocked && autoApplyOnLock && !autoAppliedForGame && currentBuilds.length > 0) {
        autoAppliedForGame = true;
        applyBuild(currentBuilds[0], false);
    }
}

// ---------------------------------------------------------
// Settings & Lifecycle
// ---------------------------------------------------------

function renderExtraSettings(container) {
    container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:14px;width:100%;">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
                <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(200,170,110,0.15);border-radius:8px;padding:12px;">
                    <div style="font-size:13px;font-weight:700;color:#c8aa6e;margin-bottom:4px;">${t('Flash Key Slot')}</div>
                    <div style="font-size:11px;color:#8a9aaa;margin-bottom:8px;">${t('Choose preferred slot for Flash spell.')}</div>
                    <select id="srw-flash-key-select" style="background:#111;color:#f0e6d2;border:1px solid #3e2e13;padding:6px 10px;border-radius:4px;width:100%;outline:none;">
                        <option value="D" ${flashKeyPreference === 'D' ? 'selected' : ''}>D Key (D Tuşu)</option>
                        <option value="F" ${flashKeyPreference === 'F' ? 'selected' : ''}>F Key (F Tuşu)</option>
                        <option value="keep" ${flashKeyPreference === 'keep' ? 'selected' : ''}>Keep Default (Varsayılan)</option>
                    </select>
                </div>
                <div style="background:rgba(255,255,255,0.02);border:1px solid rgba(200,170,110,0.15);border-radius:8px;padding:12px;">
                    <div style="font-size:13px;font-weight:700;color:#c8aa6e;margin-bottom:4px;">${t('Default Build Source')}</div>
                    <div style="font-size:11px;color:#8a9aaa;margin-bottom:8px;">${t('Primary data provider for runes & spells.')}</div>
                    <select id="srw-source-select" style="background:#111;color:#f0e6d2;border:1px solid #3e2e13;padding:6px 10px;border-radius:4px;width:100%;outline:none;">
                        <option value="riot" ${defaultSource === 'riot' ? 'selected' : ''}>Riot Recommended (LCU)</option>
                        <option value="blitz" ${defaultSource === 'blitz' ? 'selected' : ''}>Blitz Meta (High WR)</option>
                    </select>
                </div>
            </div>
        </div>
    `;

    const flashSel = container.querySelector('#srw-flash-key-select');
    flashSel?.addEventListener('change', (e) => {
        flashKeyPreference = e.target.value;
        Utils.Store.set(MODULE_KEY, 'flashKey', e.target.value);
    });

    const srcSel = container.querySelector('#srw-source-select');
    srcSel?.addEventListener('change', (e) => {
        defaultSource = e.target.value;
        Utils.Store.set(MODULE_KEY, 'source', e.target.value);
    });
}

export function init(context) {
    loadSettings();

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: MODULE_KEY,
            name: t('Auto Rune & Spells'),
            description: t('Auto-imports optimal rune pages and summoner spells with Riot Recommended and Meta builds, featuring an interactive champ-select build selector widget.'),
            settings: [
                {
                    type: 'toggle',
                    id: 'sm:autoRuneImporterEnabled',
                    label: t('Enable Auto Rune & Spells Importer'),
                    value: isEnabled,
                    onChange: (v) => {
                        isEnabled = v;
                        Utils.Store.set(MODULE_KEY, 'enabled', v);
                        if (!v) removeWidget();
                    }
                },
                {
                    type: 'toggle',
                    id: 'sm:autoRuneAutoApply',
                    label: t('Auto-Apply Best Build on Champion Lock'),
                    value: autoApplyOnLock,
                    onChange: (v) => {
                        autoApplyOnLock = v;
                        Utils.Store.set(MODULE_KEY, 'autoApplyOnLock', v);
                    }
                },
                {
                    type: 'toggle',
                    id: 'sm:autoRuneImportSpells',
                    label: t('Import Recommended Summoner Spells'),
                    value: importSpells,
                    onChange: (v) => {
                        importSpells = v;
                        Utils.Store.set(MODULE_KEY, 'importSpells', v);
                    }
                },
                {
                    type: 'toggle',
                    id: 'sm:autoRuneShowWidget',
                    label: t('Show Champ Select Build Selector Widget'),
                    value: showWidget,
                    onChange: (v) => {
                        showWidget = v;
                        Utils.Store.set(MODULE_KEY, 'showWidget', v);
                        if (!v) removeWidget();
                    }
                },
                {
                    type: 'custom',
                    render: (row) => renderExtraSettings(row)
                }
            ]
        });
    }
}

export function load() {
    loadSettings();

    if (Utils.LCU?.observe) {
        if (sessionUnsub) sessionUnsub();
        sessionUnsub = Utils.LCU.observe('/lol-champ-select/v1/session', (e) => {
            onChampSelectSession(e.data);
        });

        if (gameflowUnsub) gameflowUnsub();
        gameflowUnsub = Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', (e) => {
            if (e.data !== 'ChampSelect') {
                removeWidget();
                currentChampionId = 0;
            }
        });
    }
}

export function unload() {
    if (sessionUnsub) sessionUnsub();
    sessionUnsub = null;
    if (gameflowUnsub) gameflowUnsub();
    gameflowUnsub = null;
    removeWidget();
}
