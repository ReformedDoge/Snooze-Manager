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
                    description: 'Casts honor votes at end of game based on the mode set below',
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

/**
 * If the ballot is not immediately ready, we register a WebSocket observer and resolve & unsubscribe the moment the LCU populates it.
 */
function getValidBallot() {
    return new Promise(async (resolve) => {
        const initialBallot = await Utils.LCU.get('/lol-honor-v2/v1/ballot').catch(() => null);
        if (initialBallot && (initialBallot.eligibleAllies?.length || initialBallot.eligibleOpponents?.length)) {
            Utils.Debug.log('[AutoHonor] Ballot already loaded and valid.');
            resolve(initialBallot);
            return;
        }

        Utils.Debug.log('[AutoHonor] Ballot not ready yet. Subscribing to LCU WebSocket...');
        const disconnect = Utils.LCU.observe('/lol-honor-v2/v1/ballot', (event) => {
            if (event.data && (event.data.eligibleAllies?.length || event.data.eligibleOpponents?.length)) {
                Utils.Debug.log('[AutoHonor] Socket event received: Ballot populated.');
                disconnect();
                resolve(event.data);
            }
        });
    });
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

    Utils.Debug.log('[AutoHonor] Commencing auto-honor sequence...');

    try {
        const skip = Utils.Store.get('autoHonor', 'skip') || false;
        
        // Wait for the LCU to populate the ballot
        const ballot = await getValidBallot();
        if (!ballot) return;

        if (skip) {
            Utils.Debug.info('[AutoHonor] Skip Honor is active. Requesting direct skip via LCU...');
            await Utils.LCU.post('/lol-honor-v2/v1/honor-player', {
                honorCategory: '',
                summonerId: 0
            }).catch(err => {
                Utils.Debug.error('[AutoHonor] Skip request rejected by LCU:', err);
            });
        } else {
            // Pick candidates
            const mode = Utils.Store.get('autoHonor', 'mode') || 'allies';
            let candidates = [];
            
            if (mode === 'allies') candidates = ballot.eligibleAllies || [];
            else if (mode === 'enemies') candidates = ballot.eligibleOpponents || [];
            else if (mode === 'random') candidates = [...(ballot.eligibleAllies || []), ...(ballot.eligibleOpponents || [])];
            
            const voteCount = ballot.votePool?.votes || 1;
            Utils.Debug.log(`[AutoHonor] Target mode is set to: "${mode}". Total matches found: ${candidates.length}. Actionable votes: ${voteCount}`);

            if (candidates && candidates.length > 0) {
                // Shuffle candidates
                const shuffled = [...candidates].sort(() => 0.5 - Math.random());
                const votePromises = [];

                for (let i = 0; i < Math.min(voteCount, shuffled.length); i++) {
                    const target = shuffled[i];
                    const targetName = target.summonerName || target.gameName || target.puuid;
                    
                    Utils.Debug.info(`[AutoHonor] [Vote ${i + 1}/${voteCount}] Staging HEART vote for: ${targetName}`);
                    
                    // Push individual vote promiseS
                    votePromises.push(
                        Utils.LCU.post('/lol-honor/v1/honor', {
                            honorType: 'HEART',
                            recipientPuuid: target.puuid
                        }).then(() => {
                            Utils.Debug.log(`[AutoHonor] Successfully staged vote for: ${targetName}`);
                        }).catch(err => {
                            Utils.Debug.error(`[AutoHonor] Vote staging failed for: ${targetName}`, err);
                        })
                    );
                }

                // Wait for all vote transaction promises to complete
                await Promise.all(votePromises);
            } else {
                Utils.Debug.warn('[AutoHonor] No eligible candidates found matching the selected mode.');
            }
        }

        // finalize the ballot
        Utils.Debug.log('[AutoHonor] Committing/Finalizing ballot...');
        const ballotResponse = await fetch('/lol-honor/v1/ballot', { method: 'POST' });
        if (ballotResponse.ok) {
            const text = await ballotResponse.text();
            Utils.Debug.log('[AutoHonor] Ballot finalized successfully. LCU Response:', text);
        } else {
            Utils.Debug.error('[AutoHonor] Ballot finalization failed with status:', ballotResponse.status);
        }

        // Automatically acknowledge honor level changes if pending
        // Utils.Debug.log('[AutoHonor] Querying and acknowledging any pending Honor level-up animations...');
        await fetch('/lol-honor-v2/v1/level-change/ack', { method: 'POST' }).catch(() => {});

    } catch(err) {
        Utils.Debug.error('[AutoHonor] Critical error encountered during runtime:', err);
    }
}

export function load() {
    if (Utils.LCU && Utils.LCU.observe) {
        Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', e => {
            //Utils.Debug.log('[AutoHonor] Gameflow phase transition detected:', e.data);
            
            const isHonorPhase = e.data === 'PreEndOfGame' || e.data === 'EndOfGame';
            if (!isHonorPhase && e.data !== 'WaitingForStats') {
                /* if (honorAttemptedForCurrentGame) {
                    Utils.Debug.log('[AutoHonor] Transitioned out of postgame. Clearing active session tracking flags.');
                } */
                honorAttemptedForCurrentGame = false;
            }

            const currentEnabled = Utils.Store.get('autoHonor', 'enabled');
            if (!currentEnabled) return;
            if (isHonorPhase) {
                if (honorAttemptedForCurrentGame) {
                    //Utils.Debug.log('[AutoHonor] Postgame lobby detected, but action has already processed for this game session.');
                    return;
                }
                Utils.Debug.info('[AutoHonor] Reached Postgame! Directing execution thread to autoHonorTeammate().');
                honorAttemptedForCurrentGame = true;
                autoHonorTeammate();
            }
        });
    }
}