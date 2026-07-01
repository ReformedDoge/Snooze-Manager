/**
 * @name Snooze-ProfileTweaks
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Profile customization utilities: remove banner/border, manage tokens, and unlock profile background.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

const MODULE_KEY = 'profileTweaks';
const SETTINGS_KEY_UNLOCK_BACKGROUND = 'unlockProfileBackground';
const SETTINGS_KEY_TOKEN_IDS = 'profileTokenIds';

let unlockBackgroundEnabled = false;
let currentProfilePreferences = null;
let tokenIds = ['', '', ''];
let _inventoryHookInstalled = false;
const PURCHASE_DATE_WINDOW_YEARS = 10;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function getRandomPastPurchaseDateMs(years = PURCHASE_DATE_WINDOW_YEARS) {
    const maxOffsetMs = Math.floor(years * MS_PER_YEAR);
    return Date.now() - Math.floor(Math.random() * maxOffsetMs);
}

function debugLog(...args) {
    Utils.Debug.log('[ProfileTweaks]', ...args);
}

function flashMessage(targetElement, message, color = '#4caf82') {
    targetElement.textContent = message;
    targetElement.style.color = color;
    setTimeout(() => {
        if (targetElement.textContent === message) {
            targetElement.textContent = '';
        }
    }, 2600);
}

function normalizeTokenIds(value) {
    if (!Array.isArray(value)) return ['', '', ''];
    return [0, 1, 2].map(i => String(value[i] ?? '').trim());
}

async function fetchProfileSummary() {
    try {
        return await Utils.LCU.get('/lol-challenges/v1/summary-player-data/local-player');
    } catch (err) {
        Utils.Debug.warn('[ProfileTweaks] Failed to fetch profile summary:', err);
        return null;
    }
}

function getCurrentPreferences(summary) {
    const data = summary || {};
    let title = String(data.title?.itemId ?? (typeof data.title === 'string' ? data.title : (data.title?.itemId ?? '10100006')));
    if (title === '-1') title = '';
    const bannerAccent = data.bannerAccent ?? data.bannerId ?? '24';
    const crestBorder = data.crestBorder ?? data.crestId ?? '1';
    const prestigeCrestBorderLevel = data.prestigeCrestBorderLevel ?? 350;
    let challengeIds = [];

    if (Array.isArray(data.challengeIds) && data.challengeIds.length > 0) {
        challengeIds = data.challengeIds.slice(0, 3).map(id => Number(id));
    } else if (Array.isArray(data.selectedChallengeIds) && data.selectedChallengeIds.length > 0) {
        challengeIds = data.selectedChallengeIds.slice(0, 3).map(id => Number(id));
    } else if (data.selectedChallengesString) {
        challengeIds = data.selectedChallengesString.split(',').filter(Boolean).map(s => Number(s.trim())).slice(0, 3);
    }

    return {
        title,
        bannerAccent,
        crestBorder,
        prestigeCrestBorderLevel,
        challengeIds,
        raw: data
    };
}

async function ensureCurrentPreferences() {
    if (!currentProfilePreferences) {
        const summary = await fetchProfileSummary();
        currentProfilePreferences = getCurrentPreferences(summary);
    }
    return currentProfilePreferences;
}

async function updatePlayerPreferences(challengeIds) {
    const prefs = await ensureCurrentPreferences();
    const payload = {
        title: String(prefs.title),
        bannerAccent: prefs.bannerAccent,
        crestBorder: prefs.crestBorder,
        prestigeCrestBorderLevel: prefs.prestigeCrestBorderLevel,
        challengeIds: Array.isArray(challengeIds) ? challengeIds.map(Number) : prefs.challengeIds
    };
    debugLog('updatePlayerPreferences payload', payload);
    const resp = await Utils.LCU.post('/lol-challenges/v1/update-player-preferences', payload);
    debugLog('updatePlayerPreferences response', resp);
    return resp;
}

async function removeBanner(statusMessageElement) {
    try {
        const prefs = await ensureCurrentPreferences();
        await Utils.LCU.post('/lol-challenges/v1/update-player-preferences', {
            title: prefs.title,
            bannerAccent: '2',
            crestBorder: prefs.crestBorder,
            prestigeCrestBorderLevel: prefs.prestigeCrestBorderLevel,
            challengeIds: prefs.challengeIds
        });
        flashMessage(statusMessageElement, 'Banner removed!', '#4caf82');

        currentProfilePreferences = null;
    } catch (err) {
        flashMessage(statusMessageElement, `Banner removal failed (${err.message || 'network error'})`, '#e49429');
    }
}

async function removeBorder(statusMessageElement) {
    try {
        await Utils.LCU.put('/lol-regalia/v2/current-summoner/regalia', {
            preferredCrestType: 'prestige',
            preferredBannerType: 'blank',
			selectedPrestigeCrest: 22,
        });
        flashMessage(statusMessageElement, 'Border removed!', '#4caf82');
    } catch (err) {
        flashMessage(statusMessageElement, `Border removal failed (${err.message || 'network error'})`, '#e49429');
    }
}

function saveTokenState() {
    Utils.Store.set(MODULE_KEY, SETTINGS_KEY_TOKEN_IDS, tokenIds);
}

function toggleUnlockProfileBackground(enabled) {
    unlockBackgroundEnabled = enabled;
    Utils.Store.set(
        MODULE_KEY,
        SETTINGS_KEY_UNLOCK_BACKGROUND,
        enabled
    );

    if (enabled) {
        installChampionInventoryHook();
    }
}

async function applyTokenSelection(statusMessageElement) {
    try {
        const chosenIds = tokenIds
            .map((tokenId) => tokenId.trim())
            .filter(Boolean)
            .map((tokenId) => Number(tokenId))
            .filter(Number.isFinite);

        if (chosenIds.length === 0) {
            flashMessage(statusMessageElement, 'Enter at least one token ID.', '#e49429');
            return;
        }

        debugLog('applyTokenSelection chosenIds', chosenIds);
        await updatePlayerPreferences(chosenIds);
        saveTokenState();
        flashMessage(statusMessageElement, 'Token selection saved!', '#4caf82');
        currentProfilePreferences = null;
    } catch (err) {
        flashMessage(statusMessageElement, `Token update failed (${err.message || 'network error'})`, '#e49429');
    }
}

function createActionButton(label, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pm-btn';
    button.textContent = label;
    button.style.minWidth = '120px';
    button.style.background = 'rgba(200,170,110,0.08)';
    button.style.border = '1px solid rgba(200,170,110,0.25)';
    button.style.color = '#c8aa6e';
    button.style.padding = '8px 14px';
    button.style.borderRadius = '6px';
    button.style.fontWeight = '700';
    button.style.fontSize = '13px';
    button.style.cursor = 'pointer';
    button.style.transition = 'all 0.2s ease';
    button.style.outline = 'none';
    button.style.whiteSpace = 'nowrap';
    button.addEventListener('mouseenter', () => {
        button.style.background = 'rgba(200,170,110,0.16)';
        button.style.color = '#f0e6d2';
    });
    button.addEventListener('mouseleave', () => {
        button.style.background = 'rgba(200,170,110,0.08)';
        button.style.color = '#c8aa6e';
    });
    button.addEventListener('click', onClick);
    return button;
}

function renderTokenRow(slotIndex, refreshTokenRow, statusMessageElement) {
    const row = document.createElement('div');
    row.className = 'pm-row';
    row.style.flexWrap = 'wrap';
    row.style.gap = '10px';

    const title = document.createElement('div');
    title.className = 'pm-label-title';
    title.textContent = `Token slot ${slotIndex + 1}`;
    title.style.flex = '1 1 100%';

    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Token ID';
    input.value = tokenIds[slotIndex] || '';
    Object.assign(input.style, {
        background: '#111',
        border: '1px solid #3e2e13',
        color: '#f0e6d2',
        padding: '8px',
        borderRadius: '4px',
        outline: 'none',
        minWidth: '130px',
        flex: '1 1 auto'
    });
    input.addEventListener('click', (event) => event.stopPropagation());
    input.addEventListener('change', () => {
        tokenIds[slotIndex] = input.value.trim();
        saveTokenState();
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'pm-btn';
    clearBtn.textContent = 'Clear';
    Object.assign(clearBtn.style, {
        minWidth: '72px',
        padding: '7px 10px',
        borderRadius: '6px',
        background: 'rgba(20,18,16,0.85)',
        border: '1px solid rgba(200,170,110,0.18)',
        color: '#c8aa6e',
        fontSize: '12px',
        fontWeight: '700',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        outline: 'none',
        whiteSpace: 'nowrap',
        flex: '0 0 auto'
    });
    clearBtn.addEventListener('mouseenter', () => {
        clearBtn.style.background = 'rgba(200,170,110,0.12)';
        clearBtn.style.color = '#f0e6d2';
    });
    clearBtn.addEventListener('mouseleave', () => {
        clearBtn.style.background = 'rgba(20,18,16,0.85)';
        clearBtn.style.color = '#c8aa6e';
    });
    clearBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        tokenIds[slotIndex] = '';
        input.value = '';
        saveTokenState();
        flashMessage(statusMessageElement, `Slot ${slotIndex + 1} cleared.`, '#c8aa6e');
    });

    const cloneBtn = document.createElement('button');
    cloneBtn.type = 'button';
    cloneBtn.className = 'pm-btn';
    cloneBtn.textContent = 'Clone';
    Object.assign(cloneBtn.style, {
        minWidth: '72px',
        padding: '7px 10px',
        borderRadius: '6px',
        background: 'rgba(20,18,16,0.85)',
        border: '1px solid rgba(200,170,110,0.18)',
        color: '#c8aa6e',
        fontSize: '12px',
        fontWeight: '700',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        outline: 'none',
        whiteSpace: 'nowrap',
        flex: '0 0 auto'
    });
    cloneBtn.addEventListener('mouseenter', () => {
        cloneBtn.style.background = 'rgba(200,170,110,0.12)';
        cloneBtn.style.color = '#f0e6d2';
    });
    cloneBtn.addEventListener('mouseleave', () => {
        cloneBtn.style.background = 'rgba(20,18,16,0.85)';
        cloneBtn.style.color = '#c8aa6e';
    });
    cloneBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        const tokenValue = input.value.trim();
        if (!tokenValue) {
            flashMessage(statusMessageElement, 'No token to clone.', '#e49429');
            return;
        }

        const targetSlotIndex = tokenIds.findIndex((storedTokenId, searchIndex) => searchIndex !== slotIndex && !storedTokenId);
        const destinationSlotIndex = targetSlotIndex !== -1 ? targetSlotIndex : (slotIndex === 2 ? 0 : slotIndex + 1);
        tokenIds[destinationSlotIndex] = tokenValue;
        saveTokenState();
        refreshTokenRow(destinationSlotIndex);
        flashMessage(statusMessageElement, `Cloned to slot ${destinationSlotIndex + 1}.`, '#4caf82');
    });

    row.appendChild(title);
    row.appendChild(input);
    row.appendChild(clearBtn);
    row.appendChild(cloneBtn);
    return row;
}

async function renderSettings(container) {
    const summary = await fetchProfileSummary();
    if (summary) {
        currentProfilePreferences = getCurrentPreferences(summary);
        
        // Sync the live profile tokens to the input state
        if (currentProfilePreferences.challengeIds) {
            tokenIds = normalizeTokenIds(currentProfilePreferences.challengeIds);
            saveTokenState();
        }
    }

    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '12px';
    container.style.width = '100%';
    container.style.minWidth = '0';
    container.style.margin = '0';
    container.style.padding = '12px 0 0 20px';
    container.style.boxSizing = 'border-box';
    container.style.borderLeft = '2px solid #3e2e13';
    container.style.color = '#a09b8c';
    container.style.fontSize = '13px';

    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.flexDirection = 'column';
    wrapper.style.gap = '14px';

    const statusMessage = document.createElement('div');
    statusMessage.style.minHeight = '18px';
    statusMessage.style.fontSize = '13px';
    statusMessage.style.color = '#a09b8c';

    const refreshRow = document.createElement('div');
    refreshRow.className = 'pm-row';
    refreshRow.style.justifyContent = 'space-between';
    refreshRow.style.alignItems = 'center';

    const refreshLabel = document.createElement('div');
    refreshLabel.style.display = 'flex';
    refreshLabel.style.flexDirection = 'column';
    refreshLabel.style.gap = '4px';

    const refreshTitle = document.createElement('div');
    refreshTitle.textContent = 'Current profile summary';
    refreshTitle.style.color = '#f0e6d2';
    refreshTitle.style.fontSize = '13px';
    refreshTitle.style.fontWeight = '700';

    const refreshDesc = document.createElement('div');
    refreshDesc.textContent = 'Loads the current title, banner, border, and token data.';
    refreshDesc.style.color = '#a09b8c';
    refreshDesc.style.fontSize = '12px';
    refreshDesc.style.lineHeight = '1.4';

    refreshLabel.appendChild(refreshTitle);
    refreshLabel.appendChild(refreshDesc);

    const refreshBtn = createActionButton('Refresh', async () => {
        currentProfilePreferences = null;
        await renderSettings(container);
    });

    refreshRow.appendChild(refreshLabel);
    refreshRow.appendChild(refreshBtn);
    wrapper.appendChild(refreshRow);

    // Profile summary display
    const summaryDisplay = document.createElement('div');
    summaryDisplay.style.display = 'flex';
    summaryDisplay.style.flexDirection = 'column';
    summaryDisplay.style.gap = '8px';
    summaryDisplay.style.padding = '8px 12px';
    summaryDisplay.style.borderLeft = '2px solid rgba(200,170,110,0.06)';

    if (currentProfilePreferences && currentProfilePreferences.raw) {
        const raw = currentProfilePreferences.raw;
        const infoRow = document.createElement('div');
        infoRow.style.display = 'flex';
        infoRow.style.alignItems = 'center';
        infoRow.style.gap = '12px';

        const titleName = document.createElement('div');
        titleName.textContent = raw.title?.name || (raw.title?.itemId ? String(raw.title.itemId) : String(currentProfilePreferences.title));
        titleName.style.color = '#f0e6d2';
        titleName.style.fontSize = '13px';
        titleName.style.fontWeight = '700';

        const bannerSpan = document.createElement('div');
        bannerSpan.textContent = 'Banner: ' + (raw.bannerId || currentProfilePreferences.bannerAccent || 'N/A');
        bannerSpan.style.color = '#a09b8c';
        bannerSpan.style.fontSize = '12px';

        const crestSpan = document.createElement('div');
        crestSpan.textContent = 'Crest: ' + (raw.crestId || currentProfilePreferences.crestBorder || 'N/A');
        crestSpan.style.color = '#a09b8c';
        crestSpan.style.fontSize = '12px';

        infoRow.appendChild(titleName);
        infoRow.appendChild(bannerSpan);
        infoRow.appendChild(crestSpan);

        summaryDisplay.appendChild(infoRow);

        // Tokens icons
        const tokensRow = document.createElement('div');
        tokensRow.style.display = 'flex';
        tokensRow.style.alignItems = 'center';
        tokensRow.style.gap = '8px';

        const selected = currentProfilePreferences.challengeIds || [];

        for (let i = 0; i < 3; i += 1) {
            const tid = selected[i];
            const holder = document.createElement('div');
            holder.style.width = '36px';
            holder.style.height = '36px';
            holder.style.display = 'flex';
            holder.style.alignItems = 'center';
            holder.style.justifyContent = 'center';
            holder.style.background = 'rgba(0,0,0,0.25)';
            holder.style.border = '1px solid rgba(255,255,255,0.03)';
            holder.style.borderRadius = '6px';

            if (tid) {
                // find token meta in topChallenges
                const meta = Array.isArray(raw.topChallenges) ? raw.topChallenges.find(o => Number(o.id) === Number(tid)) : null;
                let src = null;
                let tip = String(tid);
                if (meta) {
                    tip = meta.name || tip;
                    const p = meta.levelToIconPath || {};
                    const levelKey = (meta.currentLevel && typeof meta.currentLevel === 'string') ? meta.currentLevel.toUpperCase() : null;
                    if (levelKey && p[levelKey]) {
                        src = p[levelKey];
                    } else {
                        const fallbackOrder = ['CHALLENGER','MASTER','DIAMOND','GOLD','PLATINUM','SILVER','BRONZE'];
                        for (const k of fallbackOrder) {
                            if (p[k]) { src = p[k]; break; }
                        }
                        if (!src) src = Object.values(p)[0] || null;
                    }
                }
                if (src) {
                    const img = document.createElement('img');
                    img.src = src;
                    img.style.width = '28px';
                    img.style.height = '28px';
                    img.style.objectFit = 'contain';
                    img.title = tip;
                    holder.appendChild(img);
                } else {
                    holder.textContent = String(tid);
                    holder.title = tip;
                }
            } else {
                holder.textContent = '-';
                holder.style.opacity = '0.45';
            }

            tokensRow.appendChild(holder);
        }

        summaryDisplay.appendChild(tokensRow);
    }

    wrapper.appendChild(summaryDisplay);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'pm-row';
    buttonRow.style.display = 'flex';
    buttonRow.style.flexWrap = 'wrap';
    buttonRow.style.gap = '10px';

    const bannerBtn = createActionButton('Remove Banner', () => removeBanner(statusMessage));
    const borderBtn = createActionButton('Remove Border', () => removeBorder(statusMessage));
    buttonRow.appendChild(bannerBtn);
    buttonRow.appendChild(borderBtn);
    wrapper.appendChild(buttonRow);

    const tokenSection = document.createElement('div');
    tokenSection.style.display = 'flex';
    tokenSection.style.flexDirection = 'column';
    tokenSection.style.gap = '10px';
    tokenSection.style.padding = '12px';
    tokenSection.style.border = '1px solid rgba(200, 170, 110, 0.2)';
    tokenSection.style.borderRadius = '10px';
    tokenSection.style.background = 'rgba(0,0,0,0.08)';

    const tokenTitle = document.createElement('div');
    tokenTitle.textContent = 'Token selection';
    tokenTitle.style.color = '#c8aa6e';
    tokenTitle.style.fontSize = '13px';
    tokenTitle.style.fontWeight = '700';
    tokenTitle.style.textTransform = 'uppercase';
    tokenTitle.style.letterSpacing = '0.04em';
    tokenSection.appendChild(tokenTitle);

    const tokenDesc = document.createElement('div');
    tokenDesc.textContent = 'Choose up to 3 token ids, including duplicates, then save them to your profile preferences.';
    tokenDesc.style.color = '#a09b8c';
    tokenDesc.style.fontSize = '12px';
    tokenDesc.style.lineHeight = '1.5';
    tokenSection.appendChild(tokenDesc);

    const tokenRows = [];
    const refreshRowByIndex = (slotIndex) => {
        tokenRows[slotIndex].querySelector('input')?.focus();
        tokenRows[slotIndex].querySelector('input').value = tokenIds[slotIndex] || '';
    };

    for (let slotIndex = 0; slotIndex < 3; slotIndex += 1) {
        const tokenRow = renderTokenRow(slotIndex, refreshRowByIndex, statusMessage);
        tokenRows.push(tokenRow);
        tokenSection.appendChild(tokenRow);
    }

    const saveTokensBtn = createActionButton('Save token selection', () => applyTokenSelection(statusMessage));
    saveTokensBtn.style.alignSelf = 'flex-start';
    tokenSection.appendChild(saveTokensBtn);
    wrapper.appendChild(tokenSection);
    wrapper.appendChild(statusMessage);

    container.innerHTML = '';
    container.appendChild(wrapper);
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: 'profile-tweaks-settings',
        titleKey: 'snooze_profile-tweaks',
        titleName: 'Profile Tweaks',
        capitalTitleKey: 'snooze_profile-tweaks_capital',
        capitalTitleName: 'PROFILE TWEAKS',
        class: 'profile-tweaks-settings'
    });

    unlockBackgroundEnabled = Utils.Store.get(MODULE_KEY, SETTINGS_KEY_UNLOCK_BACKGROUND) || false;

    const storedTokens = Utils.Store.get(MODULE_KEY, SETTINGS_KEY_TOKEN_IDS);
    tokenIds = normalizeTokenIds(storedTokens || []);

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'profileTweaks',
            name: 'Profile Tweaks',
            description: 'Remove profile banner/border, manage token preferences, and unlock profile background.',
            settings: [
				{
					type: 'toggle',
					id: 'sm:unlockProfileBackground',
					label: 'Unlock Profile Background',
					description: 'Fakes champion and skin ownership so any splash can be set as your profile background',
					value: unlockBackgroundEnabled,
					onChange: (val) => toggleUnlockProfileBackground(val)
				},
				{
					type: 'custom',
					render: (row) => renderSettings(row)
				}
			]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.profile-tweaks-settings', (plugin) => {
            plugin.innerHTML = '';

            const toggleRow = Utils.Settings.createToggleRow('Unlock Profile Background', unlockBackgroundEnabled, (next) => {
                toggleUnlockProfileBackground(next);
            });
            toggleRow.classList.add('plugins-settings-row');
            toggleRow.style.marginTop = '10px';
            toggleRow.style.marginBottom = '10px';
            toggleRow.style.padding = '12px 14px';
            toggleRow.style.background = 'rgba(255,255,255,0.015)';
            toggleRow.style.border = '1px solid rgba(255,255,255,0.03)';
            toggleRow.style.borderRadius = '8px';
            toggleRow.style.width = '84%';
            plugin.appendChild(toggleRow);

            const row = document.createElement('div');
            row.classList.add('plugins-settings-row');
            row.style.marginLeft = '0';
            row.style.paddingLeft = '0';
            renderSettings(row);
            plugin.appendChild(row);
        });
    }
}

export function load() {
    if (unlockBackgroundEnabled) installChampionInventoryHook();
}

async function installChampionInventoryHook() {
    if (_inventoryHookInstalled) return;
    try {
        const summonerSummary = await Utils.LCU.get('/lol-summoner/v1/current-summoner');
        if (!summonerSummary) return;

        const summonerId = summonerSummary.summonerId || summonerSummary.summonerIdStr || summonerSummary.id || summonerSummary.summonerId;
        if (!summonerId) return;

        const inventoryEndpointPattern = new RegExp(`/lol-champions/v1/inventories/${summonerId}/champions`);
        Utils.Hooks.Xhr.hookRes(inventoryEndpointPattern, (method, url, xhr, responseText) => {
            if (!Utils.Store.get(MODULE_KEY, SETTINGS_KEY_UNLOCK_BACKGROUND)) return responseText;
            debugLog('champion inventory hook matched', url);
            try {
                        const responseBody = responseText;
                let inventoryItems = JSON.parse(responseBody);
                const fakePurchaseDateMs = getRandomPastPurchaseDateMs();
                if (Array.isArray(inventoryItems)) {
                    inventoryItems.forEach((championEntry) => {
                        try {
                            if (championEntry.ownership && championEntry.ownership.rental) {
                                championEntry.ownership.owned = true;
                                championEntry.ownership.rental.purchaseDate = fakePurchaseDateMs;
                                championEntry.purchased = fakePurchaseDateMs;
                            }
                            if (Array.isArray(championEntry.skins)) {
                                championEntry.skins.forEach((skinEntry) => {
                                    try {
                                        if (!skinEntry.ownership) skinEntry.ownership = {};
                                        skinEntry.ownership.owned = true;
                                        if (skinEntry.questSkinInfo && Array.isArray(skinEntry.questSkinInfo.tiers)) {
                                            skinEntry.questSkinInfo.tiers.forEach((tierEntry) => {
                                                try {
                                                    if (tierEntry && tierEntry.ownership) {
                                                        tierEntry.ownership.owned = true;
                                                    }
                                                } catch (err) {}
                                            });
                                        }
                                    } catch (err) {}
                                });
                            }
                        } catch (err) {}
                    });
                    Object.defineProperty(xhr, 'responseText', {
                        writable: true,
                        value: JSON.stringify(inventoryItems)
                    });
                    if (xhr.responseType === '' || xhr.responseType === 'text') {
                        try { Object.defineProperty(xhr, 'response', { writable: true, value: JSON.stringify(inventoryItems) }); } catch (err) {}
                    }
                }
                return JSON.stringify(inventoryItems);
            } catch (err) {
                return responseText;
            }
        });
        _inventoryHookInstalled = true;
    } catch (err) {
        debugLog('installChampionInventoryHook failed', err);
    }
}
