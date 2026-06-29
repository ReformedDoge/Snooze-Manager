/**
 * @name Snooze-AutoHonor
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Automatically honor players after matches using configurable target selection.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

let isEnabled = false;
let honorAttemptedForCurrentGame = false;

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('autoHonor', 'enabled', enabled);
}

function getDelay() {
    return Utils.Store.get('autoHonor', 'delayMs') || 200;
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
    Object.assign(select.style, { background: '#111', color: '#f0e6d2', border: '1px solid #3e2e13', padding: '6px', borderRadius: '2px', flex: '1', outline: 'none' });
    
    const optAllies = document.createElement('option');
    optAllies.value = 'allies'; optAllies.textContent = 'Honor Allies';
    const optEnemies = document.createElement('option');
    optEnemies.value = 'enemies'; optEnemies.textContent = 'Honor Enemies';
    const optRandom = document.createElement('option');
    optRandom.value = 'random'; optRandom.textContent = 'Honor Random (Any)';

    select.appendChild(optAllies); 
    select.appendChild(optEnemies);
    select.appendChild(optRandom);
    
    select.value = Utils.Store.get('autoHonor', 'mode') || 'allies';
    select.addEventListener('change', (e) => Utils.Store.set('autoHonor', 'mode', e.target.value));
    selectRow.appendChild(select);

    container.appendChild(selectRow);
    container.appendChild(Utils.Settings.createNumberInputRow('Delay between votes (ms)', getDelay(), 0, 5000, 50, (v) => {
        Utils.Store.set('autoHonor', 'delayMs', v);
    }));
    container.appendChild(Utils.Settings.createToggleRow('Skip Honor', Utils.Store.get('autoHonor', 'skip') || false, (next) => {
        Utils.Store.set('autoHonor', 'skip', next);
    }));
}

export function init(context) {
    Utils.Settings.inject(context, {
        name: "auto-honor-settings",
        titleKey: "snooze_auto-honor",
        titleName: "Auto Honor",
        capitalTitleKey: "snooze_auto-honor_capital",
        capitalTitleName: "AUTO HONOR",
        class: "auto-honor-settings"
    });

    isEnabled = Utils.Store.get('autoHonor', 'enabled') || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'autoHonor',
            name: 'Auto Honor',
            description: 'Automatically honors a teammate, enemy, or random player when the game finishes.',
            settings: [
                {
                    type: 'toggle',
                    id: 'sm:autoHonor',
                    label: 'Enable Auto Honor',
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val)
                },
                {
                    type: 'custom',
                    render: (row) => renderExtraSettings(row)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.auto-honor-settings", (plugin) => {
            const mainToggle = Utils.Settings.createToggleRow('Enable Auto Honor', isEnabled, (next) => {
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

async function autoHonorTeammate() {
    const currentEnabled = Utils.Store.get('autoHonor', 'enabled');
    if (!currentEnabled) {
        //Utils.Debug.log('[AutoHonor] Process skipped: Auto-honor is disabled in settings.');
        return;
    }
    if (!Utils.LCU) {
        Utils.Debug.error('[AutoHonor] Process aborted: LCU utilities context is uninitialized.');
        return;
    }

    Utils.Debug.log('[AutoHonor] Starting auto-honor sequence...');

    try {
        const skip = Utils.Store.get('autoHonor', 'skip') || false;

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
        Utils.Debug.log('[AutoHonor] Eligible allies:', ballot.eligibleAllies?.map(p => ({ name: p.summonerName || p.gameName || p.puuid, puuid: p.puuid })));
        Utils.Debug.log('[AutoHonor] Eligible opponents:', ballot.eligibleOpponents?.map(p => ({ name: p.summonerName || p.gameName || p.puuid, puuid: p.puuid })));

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

            if (mode === 'allies') candidates = ballot.eligibleAllies || [];
            else if (mode === 'enemies') candidates = ballot.eligibleOpponents || [];
            else if (mode === 'random') candidates = [...(ballot.eligibleAllies || []), ...(ballot.eligibleOpponents || [])];

            const voteCount = ballot.votePool?.votes || 1;
            Utils.Debug.log(`[AutoHonor] Target mode: "${mode}", matches: ${candidates.length}, votes: ${voteCount}`);

            if (candidates?.length > 0) {
                const shuffled = [...candidates].sort(() => 0.5 - Math.random());

                for (let i = 0; i < Math.min(voteCount, shuffled.length); i++) {
                    const target = shuffled[i];
                    const targetName = target.summonerName || target.gameName || target.puuid;

                    Utils.Debug.info(`[AutoHonor] [Vote ${i + 1}/${voteCount}] Staging HEART vote for: ${targetName}`);

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

    } catch(err) {
        Utils.Debug.error('[AutoHonor] Critical error encountered during runtime:', err);
    }
}

export function load() {
    Utils.Debug.log('[AutoHonor] Module loaded.');

    if (Utils.LCU?.observe) {
        Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', e => {
            const isHonorPhase = e.data === 'PreEndOfGame' || e.data === 'EndOfGame';

            if (!isHonorPhase && e.data !== 'WaitingForStats') {
                honorAttemptedForCurrentGame = false;
                return;
            }

            if (isHonorPhase && !honorAttemptedForCurrentGame) {
                Utils.Debug.log('[AutoHonor] Gameflow phase trigger:', e.data);
                triggerAutoHonorIfReady();
            }
        });
        Utils.Debug.log('[AutoHonor] Gameflow observer registered.');
    }
}