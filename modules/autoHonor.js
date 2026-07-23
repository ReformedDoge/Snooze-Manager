/**
 * @name Snooze-AutoHonor
 * @version 1.0.3
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically honor players after matches, with optional prioritization of friends or selection based on contributions, and score display on honor cards.
 * @link https://github.com/ReformedDoge
 */
import { t } from './i18n.js';
import Utils from './generalUtils.js';

let isEnabled = false;
let honorAttemptedForCurrentGame = false;
let eogStatsCache = null;
let friendPuuidsCache = null;
let scoresMapCache = null;
let hookCleanups = [];

function loadScoresMap() {
    if (eogStatsCache?.teams?.length) {
        scoresMapCache = Utils.Scoring.computeScores(Utils.Scoring.normalizeEogStats(eogStatsCache));
    } else {
        scoresMapCache = null;
    }
}

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('autoHonor', 'enabled', enabled);
}

function getDelay() {
    return Utils.Store.get('autoHonor', 'delayMs') || 200;
}

function uncheckToggleRow(row) {
    const cb = row?.querySelector('input[type="checkbox"]');
    if (cb) {
        cb.checked = false;
        const wrapper = cb.closest('lol-uikit-flat-checkbox');
        if (wrapper) wrapper.classList.remove('checked');
    }
}

function renderExtraSettings(container) {
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '10px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    const selectRow = document.createElement('div');
    selectRow.style.display = 'flex';
    selectRow.style.width = '100%';

    const select = document.createElement('select');
    Object.assign(select.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        padding: '6px',
        borderRadius: '2px',
        flex: '1',
        outline: 'none'
    });

    const optAllies = document.createElement('option');
    optAllies.value = 'allies';
    optAllies.textContent = t('Honor Allies');
    const optEnemies = document.createElement('option');
    optEnemies.value = 'enemies';
    optEnemies.textContent = t('Honor Enemies');
    const optRandom = document.createElement('option');
    optRandom.value = 'random';
    optRandom.textContent = t('Honor Random (Any)');

    select.appendChild(optAllies);
    select.appendChild(optEnemies);
    select.appendChild(optRandom);

    select.value = Utils.Store.get('autoHonor', 'mode') || 'allies';
    select.addEventListener('change', (e) => Utils.Store.set('autoHonor', 'mode', e.target.value));
    selectRow.appendChild(select);

    container.appendChild(selectRow);
    container.appendChild(Utils.Settings.createNumberInputRow(t('Delay between votes (ms)'), getDelay(), 0, 5000, 50, (v) => {
        Utils.Store.set('autoHonor', 'delayMs', v);
    }));

    // Skip Honor toggle
    const skipRow = Utils.Settings.createToggleRow(t('Skip Honor'), Utils.Store.get('autoHonor', 'skip') || false, (next) => {
        Utils.Store.set('autoHonor', 'skip', next);
        if (next) {
            Utils.Store.set('autoHonor', 'prioritizeByContribution', false);
            uncheckToggleRow(container.querySelector('.ah-prioritize-toggle'));
            Utils.Store.set('autoHonor', 'preferFriends', false);
            uncheckToggleRow(container.querySelector('.ah-prefer-friends-row'));
        }
    });
    skipRow.classList.add('ah-skip-honor-row');
    container.appendChild(skipRow);

    // Prioritize by Contribution toggle (mutually exclusive with Skip Honor)
    const prioRow = Utils.Settings.createToggleRow(t('Prioritize by Contribution'), Utils.Store.get('autoHonor', 'prioritizeByContribution') || false, (next) => {
        Utils.Store.set('autoHonor', 'prioritizeByContribution', next);
        if (next) {
            Utils.Store.set('autoHonor', 'skip', false);
            uncheckToggleRow(container.querySelector('.ah-skip-honor-row'));
        }
    });
    prioRow.classList.add('ah-prioritize-toggle');
    container.appendChild(prioRow);

    // Prefer Friends toggle — honor friends first out of the current mode's candidates
    const preferRow = Utils.Settings.createToggleRow(t('Prefer Friends'), Utils.Store.get('autoHonor', 'preferFriends') || false, (next) => {
        Utils.Store.set('autoHonor', 'preferFriends', next);
        if (next) {
            Utils.Store.set('autoHonor', 'skip', false);
            uncheckToggleRow(container.querySelector('.ah-skip-honor-row'));
        }
    });
    preferRow.classList.add('ah-prefer-friends-row');
    container.appendChild(preferRow);
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: "auto-honor-settings",
        titleKey: "snooze_auto-honor",
        titleName: t("Auto Honor"),
        capitalTitleKey: "snooze_auto-honor_capital",
        capitalTitleName: t("AUTO HONOR"),
        class: "auto-honor-settings"
    });

    isEnabled = Utils.Store.get('autoHonor', 'enabled') || false;

    const showScoreOnCard = Utils.Store.get('autoHonor', 'showScoreOnCard') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoHonor',
            name: t('Auto Honor'),
            description: t('Automatically honors a teammate, enemy, or random player when the game finishes.'),
            settings: [{
                    type: 'toggle',
                    id: 'sm:autoHonor',
                    label: t('Enable Auto Honor'),
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val)
                },
                {
                    type: 'custom',
                    render: (row) => renderExtraSettings(row)
                },
                {
                    type: 'toggle',
                    id: 'sm:showScoreOnCard',
                    label: t('Show KDA & Score on Honor Card'),
                    value: showScoreOnCard,
                    onChange: (val) => Utils.Store.set('autoHonor', 'showScoreOnCard', val)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.auto-honor-settings", (plugin) => {
            const mainToggle = Utils.Settings.createToggleRow(t('Enable Auto Honor'), isEnabled, (next) => {
                isEnabled = next;
                toggleFeature(next);
            });
            mainToggle.classList.add('plugins-settings-row');
            plugin.appendChild(mainToggle);

            const extraRow = document.createElement("div");
            extraRow.classList.add("plugins-settings-row");
            extraRow.style.marginTop = "10px";
            renderExtraSettings(extraRow);
            plugin.appendChild(extraRow);

            const scoreRow = Utils.Settings.createToggleRow(t('Show KDA & Score on Honor Card'), showScoreOnCard, (next) => {
                Utils.Store.set('autoHonor', 'showScoreOnCard', next);
            });
            scoreRow.classList.add('plugins-settings-row');
            scoreRow.style.marginTop = '10px';
            plugin.appendChild(scoreRow);
        });
    }
}

function getValidBallot() {
    return new Promise(async (resolve) => {
        let ballot = await Utils.LCU.get('/lol-honor-v2/v1/ballot').catch(() => null);
        if (ballot?.eligibleAllies?.length || ballot?.eligibleOpponents?.length) {
            Utils.Debug.log('[AutoHonor] Ballot already loaded and valid.');
            resolve(ballot);
            return;
        }

        Utils.Debug.log('[AutoHonor] Ballot not ready. Refreshing and subscribing to WebSocket...');
        await Utils.LCU.post('/lol-honor-v2/v1/ballot/refresh').catch(() => {});

        let resolved = false;
        const disconnect = Utils.LCU.observe('/lol-honor-v2/v1/ballot', (event) => {
            if (event.data?.eligibleAllies?.length || event.data?.eligibleOpponents?.length) {
                Utils.Debug.log('[AutoHonor] Socket event received: Ballot populated.');
                resolved = true;
                disconnect();
                resolve(event.data);
            }
        });

        ballot = await Utils.LCU.get('/lol-honor-v2/v1/ballot').catch(() => null);
        if (!resolved && (ballot?.eligibleAllies?.length || ballot?.eligibleOpponents?.length)) {
            Utils.Debug.log('[AutoHonor] Ballot populated (re-checked after subscribe).');
            resolved = true;
            disconnect();
            resolve(ballot);
        }

        await new Promise(r => setTimeout(r, 5000));
        if (!resolved) {
            Utils.Debug.log('[AutoHonor] Ballot timed out after 5s. Resolving with current state.');
            disconnect();
            resolve(ballot);
        }
    });
}

async function triggerAutoHonorIfReady() {
    const currentEnabled = Utils.Store.get('autoHonor', 'enabled');
    if (!currentEnabled) return;
    if (honorAttemptedForCurrentGame) return;

    honorAttemptedForCurrentGame = true;
    Utils.Debug.info('[AutoHonor] Postgame UI rendered. Starting honor sequence.');
    autoHonorTeammate();
}

async function getFriendPuuids() {
    if (friendPuuidsCache) return friendPuuidsCache;
    const friends = await Utils.LCU.get('/lol-chat/v1/friends').catch(() => null);
    const set = new Set();
    if (Array.isArray(friends)) {
        for (const f of friends) {
            if (f?.puuid) set.add(f.puuid);
        }
    }
    friendPuuidsCache = set;
    return set;
}

async function getEogStatsBlock() {
    if (eogStatsCache) return eogStatsCache;
    const data = await Utils.LCU.get('/lol-end-of-game/v1/eog-stats-block').catch(() => null);
    if (data?.teams?.length) {
        eogStatsCache = data;
        loadScoresMap();
        Utils.Debug.log('[AutoHonor] eogStatsBlock cached successfully.');
    }
    return eogStatsCache;
}

function findPlayerByPuuid(eogStats, puuid) {
    if (!eogStats?.teams) return null;
    for (const team of eogStats.teams) {
        const player = (team.players || []).find(p => p.puuid === puuid);
        if (player) return player;
    }
    return null;
}

function getScores(eogStats) {
    // Returns a Map<puuid, { score, kda, kills, deaths, assists, _scoreRatio }>
    if (!eogStats?.teams?.length) return new Map();
    return Utils.Scoring.computeScores(Utils.Scoring.normalizeEogStats(eogStats));
}

async function autoHonorTeammate() {
    const currentEnabled = Utils.Store.get('autoHonor', 'enabled');
    if (!currentEnabled) {
        return;
    }
    if (!Utils.LCU) {
        Utils.Debug.error('[AutoHonor] Process aborted: LCU utilities context is uninitialized.');
        return;
    }

    Utils.Debug.log('[AutoHonor] Starting auto-honor sequence...');

    try {
        const skip = Utils.Store.get('autoHonor', 'skip') || false;
        const prioritize = Utils.Store.get('autoHonor', 'prioritizeByContribution') || false;

        const ballot = await getValidBallot();
        if (!ballot) {
            Utils.Debug.warn('[AutoHonor] No ballot returned. Aborting.');
            return;
        }

        Utils.Debug.log('[AutoHonor] Ballot state:', {
            gameId: ballot.gameId,
            allies: ballot.eligibleAllies?.length || 0,
            opponents: ballot.eligibleOpponents?.length || 0,
            votes: ballot.votePool?.votes || 0
        });

        let didVote = false;

        if (skip) {
            Utils.Debug.info('[AutoHonor] Skip Honor is active. Requesting direct skip via LCU...');
            await Utils.LCU.post('/lol-honor-v2/v1/honor-player', {
                honorCategory: '',
                summonerId: 0
            }).catch(err => {
                Utils.Debug.error('[AutoHonor] Skip request rejected by LCU:', err);
            });
            didVote = true;
        } else {
            const mode = Utils.Store.get('autoHonor', 'mode') || 'allies';
            let candidates = [];

            if (mode === 'allies') candidates = [...(ballot.eligibleAllies || [])];
            else if (mode === 'enemies') candidates = [...(ballot.eligibleOpponents || [])];
            else if (mode === 'random') candidates = [...(ballot.eligibleAllies || []), ...(ballot.eligibleOpponents || [])];

            const preferFriends = Utils.Store.get('autoHonor', 'preferFriends') || false;
            const voteCount = ballot.votePool?.votes || 1;
            Utils.Debug.log(`[AutoHonor] Target mode: "${mode}", total candidates: ${candidates.length}, votes: ${voteCount}`);

            if (candidates?.length > 0) {
                let selectedCandidates = [];

                // Separate friends from the rest
                let friendCandidates = [];
                let otherCandidates = [];
                if (preferFriends) {
                    const friendPuuids = await getFriendPuuids();
                    for (const c of candidates) {
                        if (friendPuuids.has(c.puuid)) {
                            friendCandidates.push(c);
                        } else {
                            otherCandidates.push(c);
                        }
                    }
                    Utils.Debug.log(`[AutoHonor] Prefer Friends: ${friendCandidates.length} friend(s), ${otherCandidates.length} other(s).`);
                } else {
                    otherCandidates = [...candidates];
                }

                // Build ordered list: friends first, then rest (sorted by contribution or random)
                if (friendCandidates.length > 0) {
                    selectedCandidates = [...friendCandidates];
                }
                if (otherCandidates.length > 0) {
                    if (prioritize) {
                        Utils.Debug.log('[AutoHonor] Prioritize by Contribution enabled. Fetching stats...');
                        const eogStats = await getEogStatsBlock();
                        if (eogStats) {
                            const scoresMap = getScores(eogStats);
                            otherCandidates = otherCandidates.map(c => {
                                const s = scoresMap.get(c.puuid);
                                return { ...c, _score: s?.score || 0, _kda: s?.kda || '0.0' };
                            });
                            otherCandidates.sort((a, b) => b._score - a._score);
                            Utils.Debug.log('[AutoHonor] Priority order:', otherCandidates.map(c =>
                                `${c.summonerName || c.gameName || c.puuid}: score=${c._score} KDA=${c._kda}`
                            ));
                        } else {
                            Utils.Debug.warn('[AutoHonor] Could not fetch eogStatsBlock for scoring. Falling back to random selection.');
                            otherCandidates = [...otherCandidates].sort(() => 0.5 - Math.random());
                        }
                    } else {
                        otherCandidates = [...otherCandidates].sort(() => 0.5 - Math.random());
                    }
                    selectedCandidates = selectedCandidates.concat(otherCandidates);
                }

                for (let i = 0; i < Math.min(voteCount, selectedCandidates.length); i++) {
                    const target = selectedCandidates[i];
                    const targetName = target.summonerName || target.gameName || target.puuid;

                    const scoreInfo = target._score ? ` (score: ${target._score}, KDA: ${target._kda})` : '';
                    Utils.Debug.info(`[AutoHonor] [Vote ${i + 1}/${voteCount}] Staging HEART vote for: ${targetName}${scoreInfo}`);

                    await Utils.LCU.post('/lol-honor/v1/honor', {
                        honorType: 'HEART',
                        recipientPuuid: target.puuid
                    }).then(() => {
                        Utils.Debug.log(`[AutoHonor] Successfully staged vote for: ${targetName}`);
                    }).catch(err => {
                        Utils.Debug.error(`[AutoHonor] Vote staging failed for: ${targetName}`, err);
                    });

                    await new Promise(r => setTimeout(r, getDelay()));
                }
                didVote = true;
            } else {
                Utils.Debug.warn('[AutoHonor] No eligible candidates found.');
            }
        }

        if (didVote) {
            Utils.Debug.log('[AutoHonor] Committing/Finalizing ballot...');
            await Utils.LCU.post('/lol-honor/v1/ballot').then(response => {
                Utils.Debug.log('[AutoHonor] Ballot finalized successfully.', response);
            }).catch(err => {
                Utils.Debug.error('[AutoHonor] Ballot finalization failed:', err);
            });

            await Utils.LCU.post('/lol-honor-v2/v1/level-change/ack').catch(() => {});
        } else {
            Utils.Debug.log('[AutoHonor] No votes staged — skipped finalize and ack.');
        }

    } catch (err) {
        Utils.Debug.error('[AutoHonor] Critical error encountered during runtime:', err);
    }
}

function scoreColor(ratio) {
    // ratio 0 = worst (red), 0.5 = neutral (grey), 1 = best (vivid green)
    if (ratio >= 0.5) {
        const t = (ratio - 0.5) * 2;
        return `rgb(${Math.round(160 - t * 160)}, ${Math.round(160 + t * 60)}, ${Math.round(160 - t * 20)})`;
    } else {
        const t = ratio * 2;
        return `rgb(${Math.round(220 - t * 60)}, ${Math.round(60 + t * 100)}, ${Math.round(70 + t * 90)})`;
    }
}

function injectScoreOnHonorCard(element, puuid) {
    if (!element || !element.isConnected) return;
    if (element.querySelector('.ah-score-badge')) return;

    if (!scoresMapCache) return;
    const rating = scoresMapCache.get(puuid);
    if (!rating) return;

    if (!element || !element.isConnected) return;
    if (element.querySelector('.ah-score-badge')) return;

    const wrapper = element.querySelector('.vote-ceremony-candidate-champ-image-wrapper');
    if (!wrapper) return;

    const color = scoreColor(rating._scoreRatio);

    const chip = document.createElement('div');
    chip.className = 'ah-score-badge';
    chip.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(10,10,22,0.75);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);border-radius:4px;padding:4px 7px;text-align:center;line-height:1.4;pointer-events:none;z-index:10;';

    chip.innerHTML = `
        <div style="color:#e8d5a3;font-weight:700;font-size:11px;letter-spacing:0.3px;text-shadow:0 0 4px rgba(0,0,0,0.9),0 0 2px rgba(0,0,0,0.9);">${rating.kills}/${rating.deaths}/${rating.assists}</div>
        <div style="font-size:9px;display:flex;gap:6px;justify-content:center;">
            <span style="font-weight:600;text-shadow:0 0 3px rgba(0,0,0,0.9);color:#c0b89a;">${rating.kda} ${t('KDA')}</span>
            <span style="color:${color};font-weight:700;text-shadow:0 0 3px rgba(0,0,0,0.9),0 0 6px ${color}80;">${t('Score:')} ${rating.score}</span>
        </div>
    `;

    wrapper.style.position = 'relative';
    wrapper.appendChild(chip);
}

function injectFriendBadge(element, puuid) {
    if (!element || !element.isConnected) return;
    if (element.querySelector('.ah-friend-badge')) return;
    if (!friendPuuidsCache) return;
    if (!friendPuuidsCache.has(puuid)) return;
    if (!element || !element.isConnected) return;
    if (element.querySelector('.ah-friend-badge')) return;

    const wrapper = element.querySelector('.vote-ceremony-candidate-champ-image-wrapper');
    if (!wrapper) return;

    const chip = document.createElement('div');
    chip.className = 'ah-friend-badge';
    chip.innerHTML = `
        <span style="color:#ff6b8a;font-size:11px;text-shadow:0 0 4px rgba(0,0,0,0.9);">${t('&#9829;')}</span>
        <span style="color:#e8d5a3;font-weight:700;font-size:10px;letter-spacing:0.3px;text-shadow:0 0 4px rgba(0,0,0,0.9);">${t('Friend')}</span>
    `;

    // Adapt to native role indicator if present
    const roleIndicator = element.querySelector('.vote-ceremony-candidate-role');
    if (roleIndicator) {
        const wrapperRect = wrapper.getBoundingClientRect();
        const roleRect = roleIndicator.getBoundingClientRect();
        const badgeTop = roleRect.top - wrapperRect.top;
        const badgeLeft = (roleRect.left - wrapperRect.left) + roleRect.width + 6;
        chip.style.cssText = `position:absolute;top:${badgeTop}px;left:${badgeLeft}px;background:rgba(10,10,22,0.75);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);border-radius:4px;padding:3px 6px;display:flex;align-items:center;gap:3px;pointer-events:none;z-index:10;`;
    } else {
        chip.style.cssText = 'position:absolute;top:6px;left:6px;background:rgba(10,10,22,0.75);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);border-radius:4px;padding:3px 6px;display:flex;align-items:center;gap:3px;pointer-events:none;z-index:10;';
    }

    wrapper.style.position = 'relative';
    wrapper.appendChild(chip);
}

export function load() {
    Utils.Debug.log('[AutoHonor] Module loaded.');

    // Inject badge font to resist theme font overrides
    if (!document.getElementById('ah-badge-font')) {
        const s = document.createElement('style');
        s.id = 'ah-badge-font';
        s.textContent = '.ah-score-badge,.ah-score-badge *,.ah-friend-badge,.ah-friend-badge *{font-family:"Segoe UI","Helvetica Neue",Arial,sans-serif !important}';
        document.head.appendChild(s);
    }

    const scoreOnCard = () => Utils.Store.get('autoHonor', 'showScoreOnCard');
    const preferFriends = () => Utils.Store.get('autoHonor', 'preferFriends');
    if (Utils.LCU?.get && preferFriends()) {
        Utils.LCU.get('/lol-chat/v1/friends').then(friends => {
            const set = new Set();
            if (Array.isArray(friends)) {
                for (const f of friends) {
                    if (f?.puuid) set.add(f.puuid);
                }
            }
            friendPuuidsCache = set;
        }).catch(() => {});
    }

    // Pre-populate eogStatsBlock cache via WS observation (fast path)
    if (Utils.LCU?.observe && (Utils.Store.get('autoHonor', 'enabled') || scoreOnCard())) {
        const statsUnsub = Utils.LCU.observe('/lol-end-of-game/v1/eog-stats-block', (event) => {
            if (event.data?.teams?.length) {
                eogStatsCache = event.data;
                loadScoresMap();
                Utils.Debug.log('[AutoHonor] eogStatsBlock cached via WS push.');
                statsUnsub();
            }
        });
    }

    // Gameflow phase observer — only when auto-honor is enabled
    if (Utils.LCU?.observe && Utils.Store.get('autoHonor', 'enabled')) {
        Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', e => {
            const isHonorPhase = e.data === 'PreEndOfGame' || e.data === 'EndOfGame';

            if (!isHonorPhase && e.data !== 'WaitingForStats') {
                honorAttemptedForCurrentGame = false;
                eogStatsCache = null;
                friendPuuidsCache = null;
                scoresMapCache = null;
                return;
            }

            // Try to eagerly cache eogStatsBlock when phase changes
            if (['PreEndOfGame', 'WaitingForStats', 'EndOfGame'].includes(e.data) && !eogStatsCache) {
                Utils.LCU.get('/lol-end-of-game/v1/eog-stats-block').then(data => {
                    if (data?.teams?.length) {
                        eogStatsCache = data;
                        loadScoresMap();
                    }
                }).catch(() => {});
            }

            if (isHonorPhase && !honorAttemptedForCurrentGame) {
                Utils.Debug.log('[AutoHonor] Gameflow phase trigger:', e.data);
                triggerAutoHonorIfReady();
            }
        });
        Utils.Debug.log('[AutoHonor] Gameflow observer registered.');
    }

    // Register Ember hook for honor-card badges — score and/or friend marker
    if (Utils.Hooks?.Ember?.registerRule && (scoreOnCard() || preferFriends())) {
        const cleanup = Utils.Hooks.Ember.registerRule({
            name: 'ah-honor-card-badges',
            matcher: (args) => {
                for (const a of args) {
                    if (a && typeof a === 'object' && a.baseClassName === 'vote-ceremony-player-card') {
                        return true;
                    }
                }
                return false;
            },
            hookMethods: [{
                name: 'didRender',
                callback(Ember, original, ...args) {
                    original(...args);
                    if (!this.element) return;
                    if (!scoreOnCard() && !preferFriends()) return;

                    const candidate = this.get && this.get('candidate');
                    if (!candidate?.puuid) return;

                    if (scoreOnCard() && !this.element.querySelector('.ah-score-badge')) {
                        Utils.Debug.log('[AutoHonor] Injecting score badge for', candidate.puuid);
                        injectScoreOnHonorCard(this.element, candidate.puuid);
                    }
                    if (preferFriends() && !this.element.querySelector('.ah-friend-badge')) {
                        Utils.Debug.log('[AutoHonor] Injecting friend badge for', candidate.puuid);
                        injectFriendBadge(this.element, candidate.puuid);
                    }
                }
            }]
        });
        hookCleanups.push(cleanup);
        Utils.Debug.log('[AutoHonor] Honor card badge hook registered.');
    }
}
