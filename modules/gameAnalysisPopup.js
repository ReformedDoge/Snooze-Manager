/**
 * @name Snooze-GameAnalysisPopup
 * @version 1.0.1
 * @author SnoozeFest - github@ReformedDoge
 * @description Adds game analysis enhancements with player rank, recent match history and game in progress player history analysis.
 * @link https://github.com/ReformedDoge
 */
import { t } from './i18n.js';
import Utils from './generalUtils.js';

// WS-cached session data (no HTTP GET needed)
let _wsCsSession = null;
let _wsCsSessionUnsub = null;
let _wsGfSession = null;
let _wsGfSessionUnsub = null;

let augmentsCache = {};
let augmentsLoaded = false;
const rankCache = new Map(); // puuid -> { tier, division, lp, isUnranked }

const TIER_ORDER = {
    IRON: 1,
    BRONZE: 2,
    SILVER: 3,
    GOLD: 4,
    PLATINUM: 5,
    EMERALD: 6,
    DIAMOND: 7,
    MASTER: 8,
    GRANDMASTER: 9,
    CHALLENGER: 10
};
const DIV_ORDER = {
    I: 4,
    II: 3,
    III: 2,
    IV: 1
};
const HIGH_ELO_COMPARE_SCALE = 100000; // solo vs flex pick only — not for display

function formatTierName(tierName) {
    return tierName.charAt(0) + tierName.slice(1).toLowerCase();
}

function isHighEloTier(tier) {
    return (TIER_ORDER[tier] || 0) >= 8;
}

function divisionScore(tier, division) {
    const tierVal = TIER_ORDER[tier];
    if (!tierVal || tierVal >= 8) return null;
    return (tierVal - 1) * 4 + (DIV_ORDER[division] || 1);
}

function highEloCompareValue(tier, lp) {
    return (TIER_ORDER[tier] || 8) * HIGH_ELO_COMPARE_SCALE + (lp || 0);
}

function tierNumToHighEloLabel(tierNum) {
    if (tierNum >= 10) return 'Challenger';
    if (tierNum >= 9) return 'Grandmaster';
    if (tierNum >= 8) return 'Master';
    return null;
}

function rankBestToValue(best) {
    if (!best || best.isUnranked) return null;
    if (isHighEloTier(best.tier)) return highEloCompareValue(best.tier, best.lp);
    return divisionScore(best.tier, best.division);
}

function buildDivisionEntries() {
    const entries = [];
    for (const tierName of Object.keys(TIER_ORDER)) {
        const tierVal = TIER_ORDER[tierName];
        if (tierVal >= 8) continue;
        for (const divName of Object.keys(DIV_ORDER)) {
            entries.push({
                score: (tierVal - 1) * 4 + DIV_ORDER[divName],
                tierVal,
                label: formatTierName(tierName) + ' ' + divName
            });
        }
    }
    return entries;
}
let _divisionEntries = null;

function getDivisionEntries() {
    if (!_divisionEntries) _divisionEntries = buildDivisionEntries();
    return _divisionEntries;
}

function divisionScoreToLabel(score) {
    const s = Math.round(score);
    const entries = getDivisionEntries();
    for (const entry of entries) {
        if (s === entry.score) return entry.label;
    }
    let best = null;
    let bestDist = Infinity;
    for (const entry of entries) {
        const dist = Math.abs(s - entry.score);
        if (dist < bestDist || (dist === bestDist && entry.tierVal > (best?.tierVal ?? 0))) {
            bestDist = dist;
            best = entry;
        }
    }
    return best?.label ?? null;
}

function computeTeamAvgLabel(bests) {
    const ranked = bests.filter(b => b && !b.isUnranked);
    if (ranked.length === 0) return null;

    const highElo = ranked.filter(b => isHighEloTier(b.tier));

    const formatHighEloAvg = (players) => {
        const avgTierNum = Math.round(players.reduce((s, b) => s + TIER_ORDER[b.tier], 0) / players.length);
        const avgLp = Math.round(players.reduce((s, b) => s + (b.lp || 0), 0) / players.length);
        const tierLabel = tierNumToHighEloLabel(avgTierNum);
            return tierLabel ? `${tierLabel} ${t("~{{lp}} LP", { lp: avgLp })}` : null;
    };

    // All Master+ — average tier + LP across everyone
    if (highElo.length === ranked.length) {
        return formatHighEloAvg(highElo);
    }

    // Mixed lobby but mostly Master+ — tier/LP from high-elo players only
    if (highElo.length > 0 && highElo.length >= Math.ceil(ranked.length / 2)) {
        return formatHighEloAvg(highElo);
    }

    // Mostly below Master — division averaging (Master+ collapsed to Diamond I step)
    const values = ranked.map(b => {
        if (isHighEloTier(b.tier)) return divisionScore('DIAMOND', 'I');
        return divisionScore(b.tier, b.division);
    }).filter(v => v != null);
    if (values.length === 0) return null;
    const avg = Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    return divisionScoreToLabel(avg);
}

const RANK_COLORS = {
    IRON: '#7b7b7b',
    BRONZE: '#9c6445',
    SILVER: '#bfc5cb',
    GOLD: '#d6ab4d',
    PLATINUM: '#5c88c7',
    EMERALD: '#46a96a',
    DIAMOND: '#4f75b5',
    MASTER: '#9f5bda',
    GRANDMASTER: '#d64f4f',
    CHALLENGER: '#e58c2c'
};

function normalizeTier(tier) {
    return tier ? String(tier).trim().toUpperCase() : '';
}

function getTierColor(tier) {
    const normalized = normalizeTier(tier);
    return RANK_COLORS[normalized] || '#c8aa6e';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[ch]);
}

function escapeJsSingleQuoted(value) {
    return String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ');
}

function getRankHtml(tier, division) {
    const rankColor = getTierColor(tier);
    const label = escapeHtml(`${tier}${division ? ' ' + division : ''}`);
    return `<span style="color:${rankColor}; font-weight:700; text-transform:uppercase; letter-spacing:0.5px;">${label}</span>`;
}

async function fetchRankForPuuid(puuid) {
    if (!puuid) return null;
    if (rankCache.has(puuid)) return rankCache.get(puuid);
    try {
        const ranked = await Utils.LCU.get('/lol-ranked/v1/ranked-stats/' + puuid).catch(() => null);

        function parseQueue(q) {
            if (q && q.tier && q.tier !== 'NONE' && q.tier !== 'UNRANKED') {
                return {
                    tier: q.tier,
                    division: (q.division && q.division !== 'NA') ? q.division : '',
                    lp: q.leaguePoints || 0,
                    isUnranked: false
                };
            }
            return {
                tier: '',
                division: '',
                lp: 0,
                isUnranked: true
            };
        }
        const solo = parseQueue(ranked?.queueMap?.RANKED_SOLO_5x5);
        const flex = parseQueue(ranked?.queueMap?.RANKED_FLEX_SR);
        const soloValue = rankBestToValue(solo) ?? -1;
        const flexValue = rankBestToValue(flex) ?? -1;
        // best = whichever queue is higher; ties favour solo
        const best = flexValue > soloValue ? {
            ...flex,
            queue: t('Flex')
        } : (!solo.isUnranked ? {
            ...solo,
            queue: t('Solo')
        } : {
            ...flex,
            queue: t('Flex')
        });
        const result = {
            solo,
            flex,
            best
        };
        rankCache.set(puuid, result);
        return result;
    } catch (e) {
        return null;
    }
}

async function loadAugments() {
    if (augmentsLoaded) return;
    try {
        const augs = await Utils.LCU.get('/lol-game-data/assets/v1/cherry-augments.json').catch(() => null);
        if (Array.isArray(augs)) {
            augs.forEach(a => {
                if (a.id && a.id > 0) {
                    augmentsCache[a.id] = {
                        name: a.nameTRA || t("Augment {{id}}", { id: a.id }),
                        icon: a.augmentSmallIconPath || a.augmentIconPath || ''
                    };
                }
            });
            augmentsLoaded = true;
        }
    } catch (e) {
        Utils.Debug.error('[GameAnalysis] Failed to load cherry augments:', e);
    }
}

let isPremadeHighlightEnabled = false;

const PREMADE_COLORS = ['#e84057', '#0ac8b9', '#c8aa6e', '#9090f4'];
const matchHistoryGameIdsCache = new Map();
let lastGameId = null; // tracks last seen game ID to detect stale gameflow sessions
let _cachedGfSessionPromise = null;
let _cachedGfSessionTime = 0;

async function getRecentGameIds(puuid) {
    if (!puuid) return new Map();
    const cached = matchHistoryGameIdsCache.get(puuid);
    if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
        return cached.gameTeams;
    }
    try {
        const h = await Utils.GameData.getSgpMatchHistory(puuid, 0, 20, '').catch(() => null);
        const gameTeams = new Map(); // gameId -> teamId
        if (h && h.games) {
            h.games.forEach(g => {
                if (g.json && g.json.gameId) {
                    const participant = (g.json.participants || []).find(p => p.puuid === puuid);
                    if (participant) {
                        let teamId = participant.teamId;
                        if (g.json.gameMode === 'CHERRY') {
                            const subteamId = participant.playerSubteamId ??
                                participant.PlayerSubteamId ??
                                participant.subteamId ??
                                participant.stats?.playerSubteamId ??
                                participant.stats?.subteamId;
                            if (subteamId !== undefined && subteamId !== null && subteamId !== 0) {
                                teamId = `cherry_subteam_${subteamId}`;
                            }
                        }
                        gameTeams.set(g.json.gameId, teamId);
                    }
                }
            });
        }
        matchHistoryGameIdsCache.set(puuid, {
            timestamp: Date.now(),
            gameTeams
        });
        return gameTeams;
    } catch (e) {
        return new Map();
    }
}

async function computePremadeGroups(teamPlayers) {
    if (!isPremadeHighlightEnabled) return new Map();

    const histories = await Promise.all(teamPlayers.map(async p => {
        const puuid = p.puuid || (p.summonerId ? await Utils.LCU.get('/lol-summoner/v1/summoners/' + p.summonerId).then(s => s.puuid).catch(() => null) : null);
        const games = await getRecentGameIds(puuid);
        return {
            puuid,
            games
        };
    }));

    const valid = histories.filter(h => h.puuid && h.games.size > 0);
    const groups = new Map();
    const find = (i) => {
        if (!groups.has(i)) groups.set(i, i);
        return groups.get(i) === i ? i : groups.set(i, find(groups.get(i))).get(i);
    };
    const union = (i, j) => {
        const rootI = find(i);
        const rootJ = find(j);
        if (rootI !== rootJ) groups.set(rootI, rootJ);
    };

    const PREMADE_THRESHOLD = 3;

    for (let i = 0; i < valid.length; i++) {
        for (let j = i + 1; j < valid.length; j++) {
            let shared = 0;
            for (const [gameId, teamId] of valid[i].games) {
                const jTeamId = valid[j].games.get(gameId);
                if (jTeamId !== undefined && jTeamId === teamId) {
                    shared++;
                }
            }
            if (shared >= PREMADE_THRESHOLD) {
                union(valid[i].puuid, valid[j].puuid);
            }
        }
    }

    const comps = new Map();
    valid.forEach(v => {
        const root = find(v.puuid);
        if (!comps.has(root)) comps.set(root, new Set());
        comps.get(root).add(v.puuid);
    });

    const premadeMap = new Map();
    let colorIdx = 0;
    comps.forEach(comp => {
        if (comp.size >= 2) {
            const color = PREMADE_COLORS[colorIdx % PREMADE_COLORS.length];
            colorIdx++;
            comp.forEach(puuid => premadeMap.set(puuid, color));
        }
    });
    return premadeMap;
}

let currentChampSelectSessionId = null;
let champSelectPremadeMap = new Map();
let computingPremades = null;
let lobbyGeneration = 0; // incremented each time we enter/exit ChampSelect

async function getChampSelectPremades(session) {
    const teamHash = session?.myTeam?.map(p => p.puuid || p.summonerId).join(',');
    if (!teamHash) return new Map();
    if (currentChampSelectSessionId === teamHash) return champSelectPremadeMap;
    if (computingPremades) return computingPremades;

    computingPremades = (async () => {
        const map = await computePremadeGroups(session.myTeam);
        currentChampSelectSessionId = teamHash;
        champSelectPremadeMap = map;
        computingPremades = null;
        return map;
    })();
    return computingPremades;
}

const ROLE_ORDER = {
    'TOP': 1,
    'JUNGLE': 2,
    'MIDDLE': 3,
    'UTILITY': 4,
    'BOTTOM': 5,
    'NONE': 99,
    'UNSELECTED': 99,
    '': 99
};

function sortPlayersWithPremades(players, premadeMap) {
    const hasRoles = players.some(p => {
        const pos = p.assignedPosition || p.selectedPosition || '';
        return pos && pos !== 'NONE' && pos !== 'UNSELECTED';
    });

    if (hasRoles) {
        return [...players].sort((a, b) => {
            const posA = (a.assignedPosition || a.selectedPosition || '').toUpperCase();
            const posB = (b.assignedPosition || b.selectedPosition || '').toUpperCase();
            const orderA = ROLE_ORDER[posA] || 99;
            const orderB = ROLE_ORDER[posB] || 99;
            return orderA - orderB;
        });
    }

    const groups = new Map();
    const ungrouped = [];
    players.forEach(p => {
        const color = premadeMap.get(p.puuid);
        if (color) {
            if (!groups.has(color)) groups.set(color, []);
            groups.get(color).push(p);
        } else {
            ungrouped.push(p);
        }
    });
    const sorted = [];
    groups.forEach(group => sorted.push(...group));
    sorted.push(...ungrouped);
    return sorted;
}

let isEnabled = false;
let isChampSelectStatsEnabled = false;
let includeAllQueues = false;
let gameAnalysisPhaseUnsub = null;
let gameAnalysisBtnObserver = null;
let analysisShownForCurrentGame = false;
let analysisPanel = null;

const champSelectStatsCache = new Map();

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('gameAnalysisPopup', 'enabled', enabled);
    if (!enabled) {
        document.querySelectorAll('.pm-view-history-btn, #pm-analysis-btn').forEach(b => b.remove());
        cleanupAnalysisPanel();
        analysisShownForCurrentGame = false;
    } else {
        if (Utils.LCU && Utils.LCU.get) {
            Utils.LCU.get('/lol-gameflow/v1/gameflow-phase').then(phase => handleGameAnalysisPhase(phase)).catch(() => {});
        }
    }
}

async function analyzePlayer(p, currentTag, premadeColor) {
    let sName = p.summonerName || 'Player';
    let puuid = p.puuid;

    // consolidate the role detection
    const assignedPos = p.assignedPosition || p.selectedPosition || '';
    const hasAssignedRole = assignedPos && assignedPos !== 'NONE' && assignedPos !== 'UNSELECTED';

    // Fallback queue check: server could hide assigned roles in Champ Select.
    // If we only relied on `hasAssignedRole`, we would fail to show role info.
    const isRoleMode = hasAssignedRole || ['q_400', 'q_420', 'q_440', 'q_490', 'q_700', 'q_720'].includes(currentTag);

    let roleHtml = '<div style="width:14px;height:14px;margin-right:4px;flex-shrink:0;"></div>';
    if (hasAssignedRole) {
        const posLower = assignedPos.toLowerCase();
        const displayRole = posLower === 'utility' ? t('Support') : (posLower.charAt(0).toUpperCase() + posLower.slice(1));
        roleHtml = `<img src="/fe/lol-parties/icon-position-${posLower}.png" style="width:14px;height:14px;margin-right:4px;vertical-align:middle;opacity:0.8;flex-shrink:0;" title="${displayRole}">`;
    }

    if (p.summonerId) {
        const s = await Utils.LCU.get('/lol-summoner/v1/summoners/' + p.summonerId).catch(() => null);
        if (s) {
            sName = s.gameName ? `${s.gameName}#${s.tagLine}` : s.displayName;
            puuid = s.puuid;
        }
    } else if (puuid) {
        const s = await Utils.LCU.get('/lol-summoner/v2/summoners/puuid/' + puuid).catch(() => null);
        if (s) {
            sName = s.gameName ? `${s.gameName}#${s.tagLine}` : s.displayName;
        }
    }

    let rankStr = `<span style="color:#746e64">${t('Unranked')}</span>`;
    if (puuid) {
        const ranked = await Utils.LCU.get('/lol-ranked/v1/ranked-stats/' + puuid).catch(() => null);
        if (ranked && ranked.queueMap && ranked.queueMap.RANKED_SOLO_5x5) {
            const q = ranked.queueMap.RANKED_SOLO_5x5;
            if (q.tier && q.tier !== 'NONE' && q.tier !== 'UNRANKED') {
                rankStr = getRankHtml(q.tier, q.division && q.division !== 'NA' ? q.division : '');
            }
        }
    }

    let wrStr = '';
    let trendHtml = '';
    let mainRoleHtml = '';
    let topChampsHtml = '';

    if (puuid) {
        try {
            const h = await Utils.GameData.getSgpMatchHistory(puuid, 0, 20, currentTag);
            if (h && h.games && h.games.length > 0) {
                const roleCounts = {};
                const champStats = {};

                const results = h.games.map(g => {
                    const pt = g.json.participants.find(x => x.puuid === puuid) || g.json.participants[0];
                    if (!pt) return 'remake';
                    const isWin = pt.win !== undefined ? pt.win : g.json.teams.find(t => t.teamId === pt.teamId)?.win;
                    const isRemake = g.json.gameDuration < 240 && g.json.gameMode !== 'PRACTICETOOL';

                    if (!isRemake) {
                        const cid = pt.championId;
                        if (cid) {
                            if (!champStats[cid]) champStats[cid] = {
                                plays: 0,
                                wins: 0
                            };
                            champStats[cid].plays++;
                            if (isWin) champStats[cid].wins++;
                        }
                        const pos = pt.teamPosition;
                        if (pos && ['TOP', 'JUNGLE', 'MIDDLE', 'BOTTOM', 'UTILITY'].includes(pos)) {
                            roleCounts[pos] = (roleCounts[pos] || 0) + 1;
                        }
                    }

                    if (isRemake) return 'remake';
                    return isWin ? 'Win' : 'Loss';
                });

                const wins = results.filter(r => r === 'Win').length;
                const totalValid = results.filter(r => r !== 'remake').length;
                const wr = totalValid > 0 ? Math.round((wins / totalValid) * 100) : 0;

                wrStr = `<span style="color:${wr >= 50 ? '#0ac8b9' : '#e84057'}">${wr}${t("% WR")}</span> <span style="color:#a09b8c;font-size:11px;margin-left:4px;">(${wins}${t("W")} ${totalValid - wins}${t("L")})</span>`;

                const recentResults = results.slice(0, 10);
                trendHtml = `<div style="display:flex; gap:3px; margin-top:6px; justify-content:center; height:8px;">${recentResults.map(res => `<div class="trend-dot ${res.toLowerCase()}"></div>`).join('')}</div>`;

                if (isRoleMode) {
                    let mainRole = null;
                    let maxRolePlays = 0;
                    for (const [r, count] of Object.entries(roleCounts)) {
                        if (count > maxRolePlays) {
                            maxRolePlays = count;
                            mainRole = r;
                        }
                    }
                    if (mainRole) {
                        const posLower = mainRole.toLowerCase();
                        const displayRole = posLower === 'utility' ? t('Support') : (posLower.charAt(0).toUpperCase() + posLower.slice(1));
                        mainRoleHtml = `<div style="display:flex; align-items:center; justify-content:center; gap:4px; font-size:11px; color:#a09b8c; height:14px;" title="${t("Main Role (Recent)")}">
                      <span style="font-weight:600; color:#8a9aaa;">${t("Main Role:")}</span>
                      <img src="/fe/lol-parties/icon-position-${posLower}.png" style="width:14px;height:14px;opacity:0.8;">
                      <span style="color:#f0e6d2;">${displayRole}</span>
                  </div>`;
                    }
                }

                const sortedChamps = Object.entries(champStats).sort((a, b) => b[1].plays - a[1].plays).slice(0, 2);
                if (sortedChamps.length > 0) {
                    const champBadges = sortedChamps.map(([cid, stats]) => {
                        let cIcon = (Utils.GameData.Assets.getIcon && Utils.GameData.Assets.getIcon('champs', cid)) || `/lol-game-data/assets/v1/champion-icons/${cid}.png`;
                        cIcon = cIcon.replace('/lol-game-data/assets/', '/lol-game-data/assets/');
                        const cWr = Math.round((stats.wins / stats.plays) * 100);
                        const wrColor = cWr >= 50 ? '#0ac8b9' : '#e84057';
                        return `
                    <div style="display:flex; align-items:center; gap:4px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px; font-size:10px; height:22px; box-sizing:border-box;">
                        <img src="${cIcon}" style="width:16px;height:16px;border-radius:50%;">
                        <span style="color:#f0e6d2;font-weight:600;">${stats.plays}x</span>
                        <span style="color:${wrColor};font-weight:600;">${cWr}%</span>
                    </div>
                  `;
                    }).join('');
                    topChampsHtml = `<div style="display:flex; gap:6px; justify-content:center; height:22px;">${champBadges}</div>`;
                }
            }
        } catch (e) {}
    }

    const champInfo = Utils.GameData.Assets.champs[p.championId];
    const champName = champInfo?.name || t('Unknown');
    let champIcon = champInfo?.squarePortraitPath || `/lol-game-data/assets/v1/champion-icons/${p.championId}.png`;
    champIcon = champIcon.replace('/lol-game-data/assets/', '/lol-game-data/assets/');
    const safeSummonerName = escapeHtml(sName);
    const safeChampionName = escapeHtml(champName);
    const safePuuid = escapeJsSingleQuoted(puuid);
    const safeTag = escapeJsSingleQuoted(currentTag);

    const borderTop = premadeColor ? `border-top:3px solid ${premadeColor};` : `border-top:1px solid rgba(255,255,255,0.03);`;

    return `
      <div style="display:flex; flex-direction:column; padding:10px; background:rgba(255,255,255,0.015); border-radius:6px; border:1px solid rgba(255,255,255,0.03); ${borderTop} transition: background 0.2s; position:relative; box-sizing:border-box; height:100%; overflow:hidden;">
        <div style="display:flex; flex-direction:column; align-items:center; text-align:center; gap:6px; margin-bottom:8px;">
          <img src="${champIcon}" style="width:44px; height:44px; border-radius:50%; border:2px solid #785a28; cursor:pointer; flex-shrink:0;" onerror="this.style.opacity=0" onclick="if(window._pmShowHistory) window._pmShowHistory('${safePuuid}', '${safeTag}')" title="${t("View Match History")}"/>
          <div style="display:flex; flex-direction:column; align-items:center; width:100%; gap:2px;">
            <span style="font-weight:bold; font-size:14px; color:#f0e6d2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; height:18px;" title="${safeSummonerName}">${safeSummonerName}</span>
            <span style="color:#a09b8c; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; display:flex; align-items:center; justify-content:center; height:16px;">${roleHtml}${safeChampionName}</span>
          </div>
        </div>
        <div style="height:1px; background:rgba(255,255,255,0.05); margin-bottom:8px; width:100%; flex-shrink:0;"></div>
        <div style="display:flex; flex-direction:column; align-items:center; justify-content:flex-start; text-align:center; gap:5px; width:100%; flex:1;">
          <div style="font-size:13px; font-weight:bold; height:16px; display:flex; align-items:center; justify-content:center;">${rankStr}</div>
          <div style="font-size:13px; height:16px; display:flex; align-items:center; justify-content:center;">          ${wrStr || `<span style="color:#746e64">${t("No recent matches")}</span>`}</div>
          ${trendHtml ? trendHtml : '<div style="height:8px;"></div>'}
          
          <div style="display:flex; flex-direction:column; align-items:center; gap:5px; margin-top:2px;">
            ${isRoleMode ? (mainRoleHtml || '<div style="height:14px;"></div>') : ''}
            ${topChampsHtml || '<div style="height:22px;"></div>'}
          </div>
        </div>
      </div>
    `;
}

const showGameAnalysis = async () => {
    if (!isEnabled) return;
    Utils.Debug.log('[GameAnalysis] showGameAnalysis started');

    // Invalidate cached gameflow session to ensure a fresh fetch
    _cachedGfSessionPromise = null;
    _cachedGfSessionTime = 0;

    document.querySelectorAll('.pm-analysis-modal-container').forEach(el => el.remove());

    let session;
    try {
        session = await Utils.LCU.get('/lol-gameflow/v1/session');
        // If the game ID matches the last seen game, the session is stale — retry once.
        const gid = session?.gameData?.gameId;
        if (gid && gid === lastGameId) {
            Utils.Debug.log('[GameAnalysis] Stale gameflow session detected. Retrying in 500ms...');
            await new Promise(r => setTimeout(r, 500));
            session = await Utils.LCU.get('/lol-gameflow/v1/session');
        }
        lastGameId = session?.gameData?.gameId || lastGameId;
    } catch (e) {
        Utils.Debug.error('[GameAnalysis] Failed to get session', e);
        session = null;
    }

    document.querySelectorAll('.pm-analysis-modal-container').forEach(el => el.remove());

    const panel = document.createElement('div');
    panel.className = 'pm-analysis-modal-container';

    let containerNode = document.querySelector('.rcp-fe-lol-game-in-progress');
    if (containerNode) {
        if (window.getComputedStyle(containerNode).position === 'static') {
            containerNode.style.position = 'relative';
        }
        panel.style.cssText = 'position:absolute; inset:0; width:100%; height:100%; background:rgba(1,10,19,0.95); padding:24px; z-index:2147483600; overflow-y:auto; color:#f0e6d2; pointer-events:auto; box-sizing:border-box; border-radius:0; font-family:var(--font-body),sans-serif; backdrop-filter:blur(25px) saturate(140%);';
    } else {
        containerNode = document.body;
        panel.style.cssText = 'position:fixed; top:50%; left:50%; transform:translate(-50%,-50%); width:85%; background:rgba(1,10,19,0.95); border:1px solid rgba(200,170,110,0.2); border-radius:12px; padding:24px; z-index:2147483600; max-height:85vh; overflow-y:auto; pointer-events:auto; box-sizing:border-box; color:#f0e6d2; font-family:var(--font-body),sans-serif; backdrop-filter:blur(25px) saturate(140%);';
    }

    panel.innerHTML = `
      <style>
        .trend-dot { width: 8px; height: 8px; border-radius: 50%; }
        .trend-dot.win { background: #0ac8b9; box-shadow: 0 0 8px rgba(10,200,185,0.6); }
        .trend-dot.loss { background: #e84057; box-shadow: 0 0 8px rgba(232,64,87,0.6); }
        .trend-dot.remake { background: #746e64; }
        .pm-analysis-btn-close { background:none; border:none; color:#a09b8c; font-size:24px; cursor:pointer; line-height:1; position:relative; z-index:2147483647; transition: color 0.15s; }
        .pm-analysis-btn-close:hover { color:#f0e6d2; }
      </style>
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #3e2e13;padding-bottom:12px;margin-bottom:16px;">
        <h2 style="margin:0;color:#c8aa6e;font-size:20px;text-transform:uppercase;letter-spacing:1px;">${t("Game Analysis")}</h2>
        <button class="pm-analysis-btn-close" onclick="window._pmCloseAnalysisModal(this)">${t('✕')}</button>
      </div>
      <div class="pm-analysis-content" style="text-align:center;color:#c8aa6e;margin-top:20px;">
        ${t("Fetching detailed player data...")}
      </div>
    `;

    containerNode.appendChild(panel);
    analysisPanel = panel;

    try {
        let html = '<div style="display:flex; flex-direction:column; gap:4px;">';
        if (session && session.gameData && session.gameData.teamOne) {
            const rawQueueId = session.gameData.queue?.id;
            const currentTag = rawQueueId ? 'q_' + rawQueueId : '';

            const team1Premades = await computePremadeGroups(session.gameData.teamOne);
            const team2Premades = await computePremadeGroups(session.gameData.teamTwo);

            const sortedTeam1 = sortPlayersWithPremades(session.gameData.teamOne, team1Premades);
            const sortedTeam2 = sortPlayersWithPremades(session.gameData.teamTwo, team2Premades);

            html += '<div style="background:rgba(74,158,255,0.02); border:1px solid rgba(74,158,255,0.15); border-radius:8px; padding:12px; margin-bottom:12px;">';
            html += `<div style="color:#4a9eff; font-weight:bold; font-size:14px; margin-bottom:12px; letter-spacing:1px; border-bottom:1px solid rgba(74,158,255,0.15); padding-bottom:6px;">${t("TEAM 1 (BLUE)")}</div><div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px;">`;
            const team1Htmls = await Promise.all(sortedTeam1.map(p => analyzePlayer(p, currentTag, team1Premades.get(p.puuid))));
            html += team1Htmls.join('');
            html += '</div></div>';

            html += '<div style="background:rgba(232,64,87,0.02); border:1px solid rgba(232,64,87,0.15); border-radius:8px; padding:12px;">';
            html += `<div style="color:#e84057; font-weight:bold; font-size:14px; margin-bottom:12px; letter-spacing:1px; border-bottom:1px solid rgba(232,64,87,0.15); padding-bottom:6px;">${t("TEAM 2 (RED)")}</div><div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:12px;">`;
            const team2Htmls = await Promise.all(sortedTeam2.map(p => analyzePlayer(p, currentTag, team2Premades.get(p.puuid))));
            html += team2Htmls.join('');
            html += '</div></div>';
        } else {
            html += `<div style="text-align:center; color:#a09b8c; padding:20px;">${t("No team data found")}</div>`;
        }
        html += '</div>';

        const contentTarget = panel.querySelector('.pm-analysis-content');
        if (contentTarget) contentTarget.innerHTML = html;
    } catch (e) {
        Utils.Debug.error('[GameAnalysis] Render error', e);
        const contentTarget = panel.querySelector('.pm-analysis-content');
        if (contentTarget) contentTarget.innerHTML = `<div style="color:#d92323;text-align:center;padding:20px;">${t("Error loading game data")}</div>`;
    }
};

function cleanupAnalysisPanel() {
    if (analysisPanel) {
        analysisPanel.remove();
        analysisPanel = null;
    }
}

let previousPhase = null;

function clearLobbyCache() {
    champSelectStatsCache.clear();
    matchHistoryGameIdsCache.clear(); // clear cache for premade detection
    currentChampSelectSessionId = null;
    champSelectPremadeMap = new Map();
    computingPremades = null;
    lobbyGeneration++;
    Utils.Debug.log(`[GameAnalysis] Lobby cache cleared. lobbyGeneration=${lobbyGeneration}`);
}

function handleGameAnalysisPhase(phase) {
    // Clear all lobby-scoped state whenever we enter OR leave ChampSelect
    const wasInChampSelect = previousPhase === 'ChampSelect';
    const isNowChampSelect = phase === 'ChampSelect';
    if (wasInChampSelect !== isNowChampSelect) {
        clearLobbyCache();
        // When leaving ChampSelect, clean dom
        if (wasInChampSelect && !isNowChampSelect) {
            document.querySelectorAll('.pm-cs-stats-row, .pm-pre-badge, .pm-rank-badge, .pm-champ-select-stats, .pm-cs-stats-wrapper').forEach(n => n.remove());
        }
    }
    previousPhase = phase;

    if (phase === 'InProgress') {
        if (isEnabled) {
            if (!analysisShownForCurrentGame) {
                analysisShownForCurrentGame = true;
                showGameAnalysis();
            }
            if (!gameAnalysisBtnObserver) {
                gameAnalysisBtnObserver = Utils.DOM.observer.observe('.game-in-progress-container', (container) => {
                    if (!document.getElementById('pm-analysis-btn')) {
                        const btn = document.createElement('lol-uikit-flat-button');
                        btn.id = 'pm-analysis-btn';
                        btn.textContent = t('Game Analysis');
                        btn.style.cssText = 'margin-top: 12px; width: 100%;';
                        btn.onclick = showGameAnalysis;
                        container.appendChild(btn);
                    }
                });
            }
        }
    } else {
        document.querySelectorAll('#pm-analysis-btn').forEach(btn => btn.remove());
        if (gameAnalysisBtnObserver) {
            gameAnalysisBtnObserver();
            gameAnalysisBtnObserver = null;
        }
        cleanupAnalysisPanel();
        analysisShownForCurrentGame = false;
    }
}

export function init(context) {

    Utils.Settings.inject(context, {
        name: "analysis-popup-settings",
        titleKey: "snooze_analysis-popup",
        titleName: t("Player Analysis"),
        capitalTitleKey: "snooze_analysis-popup_capital",
        capitalTitleName: t("PLAYER ANALYSIS"),
        class: "analysis-popup-settings"
    });

    isEnabled = Utils.Store.get('gameAnalysisPopup', 'enabled') || false;
    isPremadeHighlightEnabled = Utils.Store.get('gameAnalysisPopup', 'premadeHighlight');
    if (isPremadeHighlightEnabled === undefined) isPremadeHighlightEnabled = true;
    isChampSelectStatsEnabled = Utils.Store.get('gameAnalysisPopup', 'champSelectStats') || false;
    includeAllQueues = Utils.Store.get('gameAnalysisPopup', 'includeAllQueues') || false;

    window._pmShowHistory = (puuid, tag) => {
        if (!Utils.LCU) return;
        Utils.LCU.get('/lol-summoner/v2/summoners/puuid/' + puuid).then(player => {
            if (player) MatchHistoryModal.show(player, tag);
        }).catch(() => {});
    };
    window._pmCloseAnalysisModal = function(btn) {
        Utils.Debug.log('[GameAnalysis] Close button clicked!');
        const container = btn.closest('.pm-analysis-modal-container');
        if (container) container.remove();
        document.querySelectorAll('.pm-analysis-modal-container').forEach(el => el.remove());
    };

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'gameAnalysisPopup',
            name: t('Player Analysis'),
            description: t('Auto-opens a modal displaying rank and performance stats when game starts. Optionally shows stats & highlights premade groups in Champ Select.'),
            settings: [{
                    type: 'toggle',
                    id: 'sm:gameAnalysisPopup',
                    label: t('Enable Game Analysis Popup'),
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val)
                },
                {
                    type: 'toggle',
                    id: 'sm:champSelectStats',
                    label: t('Show Stats in Champ Select'),
                    value: isChampSelectStatsEnabled,
                    onChange: (val) => {
                        isChampSelectStatsEnabled = val;
                        Utils.Store.set('gameAnalysisPopup', 'champSelectStats', val);
                        champSelectStatsCache.clear();
                    }
                },
                {
                    type: 'toggle',
                    id: 'sm:premadeHighlight',
                    label: t('Highlight Premade Groups'),
                    value: isPremadeHighlightEnabled,
                    onChange: (val) => {
                        isPremadeHighlightEnabled = val;
                        Utils.Store.set('gameAnalysisPopup', 'premadeHighlight', val);
                        champSelectStatsCache.clear();
                    }
                },
                {
                    type: 'toggle',
                    id: 'sm:includeAllQueues',
                    label: t('Include all game modes in dropdown'),
                    value: includeAllQueues,
                    onChange: (val) => {
                        includeAllQueues = val;
                        Utils.Store.set('gameAnalysisPopup', 'includeAllQueues', val);
                    }
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe("lol-uikit-scrollable.analysis-popup-settings", (plugin) => {
            const row1 = Utils.Settings.createToggleRow(t("Enable Game Analysis Popup"), isEnabled, (next) => {
                isEnabled = next;
                toggleFeature(isEnabled);
            });
            plugin.appendChild(row1);

            const row2 = Utils.Settings.createToggleRow(t("Show Stats in Champ Select"), isChampSelectStatsEnabled, (next) => {
                isChampSelectStatsEnabled = next;
                Utils.Store.set('gameAnalysisPopup', 'champSelectStats', isChampSelectStatsEnabled);
                champSelectStatsCache.clear();
            });
            row2.style.marginTop = "10px";
            plugin.appendChild(row2);

            const row3 = Utils.Settings.createToggleRow(t("Highlight Premade Groups"), isPremadeHighlightEnabled, (next) => {
                isPremadeHighlightEnabled = next;
                Utils.Store.set('gameAnalysisPopup', 'premadeHighlight', isPremadeHighlightEnabled);
                champSelectStatsCache.clear();
            });
            row3.style.marginTop = "10px";
            plugin.appendChild(row3);

            const row4 = Utils.Settings.createToggleRow(t("Include all game modes in dropdown"), includeAllQueues, (next) => {
                includeAllQueues = next;
                Utils.Store.set('gameAnalysisPopup', 'includeAllQueues', includeAllQueues);
            });
            row4.style.marginTop = "10px";
            plugin.appendChild(row4);
        });
    }

    Utils.Hooks.Ember.registerRule({
        name: 'game-analysis-lobby-member',
        matcher: 'lobby-member',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                original(...args);
                if (!Utils.Store.get('gameAnalysisPopup', 'enabled')) return;
                if (!this.element) return;

                if (!this.element.querySelector('.pm-view-history-btn')) {
                    const el = this.element;
                    const btn = document.createElement('div');
                    btn.className = 'pm-view-history-btn';
                    btn.textContent = t('View History');
                    btn.style.cssText = 'position:absolute; bottom:5px; left:50%; transform:translateX(-50%); background:rgba(0,0,0,0.8); color:#0ac8b9; border:1px solid #0ac8b9; padding:2px 6px; font-size:10px; cursor:pointer; border-radius:4px; z-index:99; display:none; transition:opacity 0.2s;';

                    el.addEventListener('mouseenter', () => {
                        if (Utils.Store.get('gameAnalysisPopup', 'enabled')) {
                            btn.style.display = 'block';
                            setTimeout(() => btn.style.opacity = '1', 0);
                        }
                    });
                    el.addEventListener('mouseleave', () => {
                        btn.style.opacity = '0';
                        btn.style.display = 'none';
                    });

                    btn.addEventListener('click', async (e) => {
                        if (!Utils.Store.get('gameAnalysisPopup', 'enabled')) return;
                        e.stopPropagation();
                        e.preventDefault();
                        try {
                            const lobby = await Utils.LCU.get('/lol-lobby/v2/lobby');
                            if (lobby && lobby.members) {
                                const members = document.querySelectorAll('.lobby-member');
                                const idx = Array.from(members).indexOf(el);
                                const puuid = lobby.members[idx]?.puuid;
                                if (puuid) {
                                    const player = await Utils.LCU.get('/lol-summoner/v2/summoners/puuid/' + puuid);
                                    if (player) {
                                        const queueId = lobby?.gameConfig?.queueId;
                                        const tag = queueId ? 'q_' + queueId : '';
                                        MatchHistoryModal.show(player, tag);
                                    }
                                }
                            }
                        } catch (err) {}
                    });
                    el.style.position = 'relative';
                    el.appendChild(btn);
                }
            }
        }, {
            name: 'willDestroyElement',
            callback(Ember, original, ...args) {
                if (this.element) {
                    const btn = this.element.querySelector('.pm-view-history-btn');
                    if (btn) btn.remove();
                }
                original(...args);
            }
        }]
    });

    function getCachedCsSession() {
        return _wsCsSession ? Promise.resolve(_wsCsSession) : Utils.LCU.get('/lol-champ-select/v1/session').catch(() => null);
    }

    function getCachedGfSession() {
        return _wsGfSession ? Promise.resolve(_wsGfSession) : Utils.LCU.get('/lol-gameflow/v1/session').catch(() => null);
    }

    function renderStatsElements(el, statsData, premadeColor) {
        if (window._pmMockStats) {
            statsData = {
                empty: false,
                wr: 69,
                kda: '4.20',
                mostPickedCount: 42,
                mostPickedId: 222, // Jinx
                rankText: 'CHALLENGER',
                rankTier: 'CHALLENGER',
                results: ['win', 'loss', 'win', 'win', 'loss', 'win', 'win', 'win', 'loss', 'win']
            };
            premadeColor = '#e84057';
        }

        // Cleanup all injected elements
        ['.pm-champ-select-stats', '.pm-cs-stats-wrapper', '.pm-cs-stats-row', '.pm-pre-badge', '.pm-rank-badge'].forEach(sel => {
            el.querySelectorAll(sel).forEach(node => node.remove());
        });

        // Fetch native hooks
        const targetHook = el.querySelector('.player-details');
        const iconContainer = el.querySelector('.champion-icon-container');
        const nameContainer = el.querySelector('.summoner-name');

        if (!targetHook || !iconContainer || !nameContainer) return;

        // Reset any previous modifications for clean state
        targetHook.style.maxHeight = '';
        targetHook.style.overflow = '';
        nameContainer.style.display = '';
        nameContainer.style.alignItems = '';
        nameContainer.style.justifyContent = '';
        nameContainer.style.flexDirection = '';
        nameContainer.style.overflow = '';
        const nameText = nameContainer.querySelector('.name-text');
        if (nameText) {
            nameText.style.flex = '';
            nameText.style.overflow = '';
            nameText.style.textOverflow = '';
            nameText.style.whiteSpace = '';
        }

        if ((statsData.empty && !statsData.rankText && !premadeColor) || (!isChampSelectStatsEnabled && !window._pmMockStats)) {
            return;
        }

        const isRightSide = el.classList.contains('right');

        targetHook.style.maxHeight = 'none';
        targetHook.style.overflow = 'visible';

        // PRE Badge
        if (premadeColor) {
            if (window.getComputedStyle(iconContainer).position === 'static') {
                iconContainer.style.position = 'relative';
            }
            const preBadge = document.createElement('span');
            preBadge.className = 'pm-pre-badge';
            preBadge.textContent = t('PRE');
            preBadge.style.cssText = `position:absolute; top:-4px; left:50%; transform:translateX(-50%); font-size:11px; font-weight:900; color:${premadeColor}; text-shadow:-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 4px #000; text-transform:uppercase; z-index:10; pointer-events:none;`;
            iconContainer.appendChild(preBadge);
        }

        // Rank Badge (Below champion icon ring)
        if (statsData.rankText) {
            if (window.getComputedStyle(iconContainer).position === 'static') {
                iconContainer.style.position = 'relative';
            }
            const rankColor = getTierColor(statsData.rankTier || statsData.rankText?.split(' ')[0]);
            const rankBadge = document.createElement('div');
            rankBadge.className = 'pm-rank-badge';
            rankBadge.textContent = statsData.rankText;
            rankBadge.style.cssText = `position:absolute; bottom:-12px; left:50%; transform:translateX(-50%); font-size:9px; font-weight:bold; color:${rankColor}; background:rgba(0,0,0,0.8); padding:1px 4px; border-radius:4px; border:1px solid ${rankColor}44; text-transform:uppercase; line-height:1; white-space:nowrap; z-index:10; pointer-events:none; text-align:center; box-shadow:0 1px 3px rgba(0,0,0,0.5);`;
            iconContainer.appendChild(rankBadge);
        }

        // Stats Line (WR/KDA, Most Picked, Dots)
        let statsRowHtml = '';
        const wrColor = statsData.wr === '?' ? '#a09b8c' : (statsData.wr >= 50 ? '#0ac8b9' : '#e84057');

        let badgeWR = '';
        if (!statsData.empty) {
            badgeWR = `
            <div style="display:inline-flex; align-items:center; gap:3px; font-size:9px; color:#a09b8c; background:rgba(0,0,0,0.6); padding:2px 3px; border-radius:3px; border:1px solid rgba(255,255,255,0.08); white-space:nowrap;">
                <span style="color:${wrColor}; font-weight:bold;">${statsData.wr}${t("% WR")}</span>
                <span style="color:#746e64;">${t("|")}</span>
                <span style="font-weight:600;">${statsData.kda} ${t("KDA")}</span>
            </div>
            `;
        }

        let badgeMostPicked = '';
        if (!statsData.empty && statsData.mostPickedCount >= 3 && statsData.mostPickedId) {
            const champIcon = Utils.GameData.Assets?.getIcon?.('champs', statsData.mostPickedId) || `/lol-game-data/assets/v1/champion-icons/${statsData.mostPickedId}.png`;
            if (isRightSide) {
                badgeMostPicked = `
                <div style="display:inline-flex; align-items:center; gap:3px; background:rgba(0,0,0,0.6); padding:1px 5px; border-radius:3px; border:1px solid rgba(200,170,110,0.2); white-space:nowrap;">
                    <img src="${champIcon}" style="width:16px; height:16px; border-radius:50%; object-fit:cover;">
                    <span style="font-size:11px; font-weight:bold; color:#a09b8c;">${statsData.mostPickedCount}x</span>
                </div>
                `;
            } else {
                badgeMostPicked = `
                <div style="display:inline-flex; align-items:center; gap:3px; background:rgba(0,0,0,0.6); padding:1px 5px; border-radius:3px; border:1px solid rgba(200,170,110,0.2); white-space:nowrap;">
                    <span style="font-size:11px; font-weight:bold; color:#a09b8c;">${statsData.mostPickedCount}x</span>
                    <img src="${champIcon}" style="width:16px; height:16px; border-radius:50%; object-fit:cover;">
                </div>
                `;
            }
        }

        let badgeDots = '';
        if (statsData.results && statsData.results.length > 0) {
            const dots = statsData.results.map(r => {
                const bg = r === 'win' ? '#0ac8b9' : (r === 'loss' ? '#e84057' : '#746e64');
                return `<div style="width:3px;height:3px;border-radius:50%;background:${bg};"></div>`;
            }).join('');
            badgeDots = `<div style="display:inline-flex; gap:2px; align-items:center; background:rgba(0,0,0,0.6); padding:3px 4px; border-radius:3px; border:1px solid rgba(255,255,255,0.08); white-space:nowrap;">${dots}</div>`;
        }

        if (isRightSide) {
            if (badgeDots) statsRowHtml += badgeDots;
            if (badgeMostPicked) statsRowHtml += badgeMostPicked;
            if (badgeWR) statsRowHtml += badgeWR;
        } else {
            if (badgeWR) statsRowHtml += badgeWR;
            if (badgeMostPicked) statsRowHtml += badgeMostPicked;
            if (badgeDots) statsRowHtml += badgeDots;
        }

        if (statsRowHtml) {
            const statsRow = document.createElement('div');
            statsRow.className = 'pm-cs-stats-row';
            statsRow.style.cssText = `display:flex; align-items:center; gap:3px; flex-wrap:wrap; margin-top:2px; justify-content:${isRightSide ? 'flex-end' : 'flex-start'}; width:100%; pointer-events:none; overflow:hidden;`;
            statsRow.innerHTML = statsRowHtml;
            targetHook.appendChild(statsRow);
        }
    }

    Utils.Hooks.Ember.registerRule({
        name: 'game-analysis-summoner-object',
        matcher: 'summoner-object',
        hookMethods: [{
            name: 'didRender',
            callback(Ember, original, ...args) {
                original(...args);
                if (!this.element) {
                    Utils.Debug.warn('[GameAnalysis] didRender triggered but DOM element is missing.');
                    return;
                }

                const el = this.element;

                // Helper to dynamically extract the unique identifier from the active Ember component context
                const getPlayerId = () => {
                    const paths = [
                        'summonerId', 'summoner.summonerId', 'member.summonerId',
                        'cellId', 'summoner.cellId', 'member.cellId',
                        'puuid', 'summoner.puuid', 'member.puuid'
                    ];
                    for (const path of paths) {
                        try {
                            const val = this.get ? this.get(path) : path.split('.').reduce((acc, part) => acc?.[part], this);
                            // Filter out unassigned default states (0, -1, empty strings)
                            if (
                                val !== undefined &&
                                val !== null &&
                                val !== 0 &&
                                val !== '0' &&
                                val !== -1 &&
                                val !== '-1' &&
                                val !== ''
                            ) {
                                if (path.includes('summonerId')) return {
                                    type: 'summonerId',
                                    value: val
                                };
                                if (path.includes('cellId')) return {
                                    type: 'cellId',
                                    value: val
                                };
                                if (path.includes('puuid')) return {
                                    type: 'puuid',
                                    value: val
                                };
                            }
                        } catch (e) {}
                    }
                    return null;
                };

                const idInfo = getPlayerId();
                if (!idInfo) {
                    Utils.Debug.log('[GameAnalysis] Player component not fully initialized yet (id returned null/empty). Clearing stats and skipping render.');
                    renderStatsElements(el, { empty: true }, null);
                    this._renderedIdKey = null;
                    return;
                }

                Utils.Debug.log(`[GameAnalysis] didRender resolved dynamic identifier: ${idInfo.type} = ${idInfo.value}`);

                // History Modal Click Trigger
                const icon = el.querySelector('.champion-icon-container');
                if (icon && !icon.hasAttribute('data-pm-history')) {
                    icon.setAttribute('data-pm-history', 'true');
                    Utils.Debug.log('[GameAnalysis] Setting up history modal click trigger listener on icon element');

                    const updateCursor = () => {
                        icon.style.cursor = Utils.Store.get('gameAnalysisPopup', 'enabled') ? 'pointer' : 'default';
                    };
                    updateCursor();
                    icon.addEventListener('mouseenter', updateCursor);

                    icon.addEventListener('click', async (e) => {
                        if (!Utils.Store.get('gameAnalysisPopup', 'enabled')) return;
                        if (e.target.closest('.swap-button-component, .summoner-muted-icon')) return;
                        e.preventDefault();
                        e.stopPropagation();

                        // Dynamically evaluate player ID per click
                        const activeIdInfo = getPlayerId();
                        if (!activeIdInfo) {
                            Utils.Debug.warn('[GameAnalysis] Click event fired but dynamic player ID resolution returned null.');
                            return;
                        }

                        try {
                            Utils.Debug.log(`[GameAnalysis] History click dynamically resolved: ${activeIdInfo.type} = ${activeIdInfo.value}`);
                            const session = await getCachedCsSession();
                            if (!session) {
                                Utils.Debug.error('[GameAnalysis] Failed to resolve active Champ Select session during click dispatch.');
                                return;
                            }

                            const player = session.myTeam.find(m => {
                                if (activeIdInfo.type === 'summonerId') return m.summonerId === activeIdInfo.value;
                                if (activeIdInfo.type === 'cellId') return m.cellId === activeIdInfo.value;
                                if (activeIdInfo.type === 'puuid') return m.puuid === activeIdInfo.value;
                                return false;
                            });

                            if (player) {
                                Utils.Debug.log(`[GameAnalysis] Match found in session: ${player.gameName || 'Anonymous'}#${player.tagLine || '????'}`);
                                let queueId = null;
                                try {
                                    const gf = await getCachedGfSession();
                                    queueId = gf?.gameData?.queue?.id;
                                } catch (e) {
                                    Utils.Debug.error('[GameAnalysis] Failed to fetch queue ID tag for match history modal', e);
                                }
                                const tag = queueId ? 'q_' + queueId : '';

                                let lookupPlayer = null;
                                if (player.puuid) {
                                    Utils.Debug.log(`[GameAnalysis] Querying details for PUUID: ${player.puuid}`);
                                    lookupPlayer = await Utils.LCU.get('/lol-summoner/v2/summoners/puuid/' + player.puuid).catch((err) => {
                                        Utils.Debug.error('[GameAnalysis] LCU PUUID query failed:', err);
                                        return null;
                                    });
                                }
                                if (!lookupPlayer && player.summonerId) {
                                    Utils.Debug.log(`[GameAnalysis] Fallback: querying details for summonerId: ${player.summonerId}`);
                                    lookupPlayer = await Utils.LCU.get('/lol-summoner/v1/summoners/' + player.summonerId).catch((err) => {
                                        Utils.Debug.error('[GameAnalysis] LCU summonerId query failed:', err);
                                        return null;
                                    });
                                }
                                if (lookupPlayer) {
                                    Utils.Debug.log(`[GameAnalysis] Dispatching history modal for ${lookupPlayer.displayName || lookupPlayer.gameName}`);
                                    MatchHistoryModal.show(lookupPlayer, tag);
                                } else {
                                    Utils.Debug.warn('[GameAnalysis] Target profile details returned null.');
                                }
                            } else {
                                Utils.Debug.warn(`[GameAnalysis] Target not found in session matching ${activeIdInfo.type}_${activeIdInfo.value}`);
                            }
                        } catch (err) {
                            Utils.Debug.error('[GameAnalysis] Exception caught inside dynamic click handler:', err);
                        }
                    });
                }

                // Inline Champ Select Stats
                if (!isChampSelectStatsEnabled) {
                    renderStatsElements(el, { empty: true }, null);
                    this._renderedIdKey = null;
                    this._renderedStats = null;
                    return;
                }

                const trackingKey = `${idInfo.type}_${idInfo.value}`;

                // Capture the current lobby generation at render time so we can detect stale component instances that survived a lobby/phase transition
                const myGeneration = lobbyGeneration;
                const generationChanged = this._renderedGeneration !== myGeneration;

                // If the component was carried over from a previous lobby, wipe its cached state so we never re-display another player's stats.
                if (generationChanged) {
                    Utils.Debug.log(`[GameAnalysis] lobbyGeneration changed (${this._renderedGeneration} → ${myGeneration}). Discarding stale component state for ${trackingKey}.`);
                    this._renderedIdKey = null;
                    this._renderedStats = null;
                    this._renderedPremadeColor = null;
                    this._isLoadingStats = false;
                    this._loadingForId = null;
                    // Remove any stale DOM stat elements from the previous lobby
                    renderStatsElements(el, { empty: true }, null);
                }

                const hasStatsNow = el.querySelector('.pm-cs-stats-row') !== null || el.querySelector('.pm-rank-badge') !== null || el.querySelector('.pm-pre-badge') !== null;

                // If stats are already active and correct for this lobby, skip loading logic
                if (this._renderedIdKey === trackingKey && hasStatsNow) {
                    return;
                }

                // Re-render from cache if DOM structures were cleared but the player remains the same
                if (this._renderedIdKey === trackingKey && !hasStatsNow && this._renderedStats) {
                    Utils.Debug.log(`[GameAnalysis] DOM wiped but trackingKey matches active player (${trackingKey}). Restoring layout.`);
                    renderStatsElements(el, this._renderedStats, this._renderedPremadeColor);
                    return;
                }

                // Block concurrent loadings for the same player instance
                if (this._isLoadingStats && this._loadingForId === trackingKey) {
                    Utils.Debug.log(`[GameAnalysis] Load call blocked. Already fetching stats for: ${trackingKey}`);
                    return;
                }

                this._isLoadingStats = true;
                this._loadingForId = trackingKey;

                Utils.Debug.log(`[GameAnalysis] Queuing inline statistics render task for player: ${trackingKey}`);

                setTimeout(async () => {
                    try {
                        const currentIdInfo = getPlayerId();
                        const currentKey = currentIdInfo ? `${currentIdInfo.type}_${currentIdInfo.value}` : null;
                        if (currentKey !== trackingKey) {
                            Utils.Debug.warn(`[GameAnalysis] Swapped trackingKey context from ${trackingKey} to ${currentKey} during buffer delay. Aborting draw.`);
                            return;
                        }

                        Utils.Debug.log(`[GameAnalysis] Pulling active Champ Select session for ${trackingKey}`);
                        const session = await getCachedCsSession();
                        if (!session) {
                            Utils.Debug.warn('[GameAnalysis] Failed to resolve current Champ Select LCU session.');
                            return;
                        }

                        Utils.Debug.log(`[GameAnalysis] Finding player matching ${trackingKey} inside team lists...`);
                        const player = session.myTeam.find(m => {
                            if (idInfo.type === 'summonerId') return m.summonerId === idInfo.value;
                            if (idInfo.type === 'cellId') return m.cellId === idInfo.value;
                            if (idInfo.type === 'puuid') return m.puuid === idInfo.value;
                            return false;
                        });

                        if (!player) {
                            Utils.Debug.warn(`[GameAnalysis] Matching player not found in team array for mapping key: ${trackingKey}`);
                            renderStatsElements(el, { empty: true }, null);
                            this._renderedIdKey = trackingKey;
                            this._renderedStats = { empty: true };
                            return;
                        }

                        Utils.Debug.log(`[GameAnalysis] Target identified as: ${player.gameName || 'Anonymous'}#${player.tagLine || '????'}`);

                        let puuid = player.puuid;
                        if (!puuid && player.summonerId) {
                            Utils.Debug.log(`[GameAnalysis] PUUID is empty on session object. Resolving summoner details for summonerId: ${player.summonerId}`);
                            const p = await Utils.LCU.get('/lol-summoner/v1/summoners/' + player.summonerId).catch(() => null);
                            if (p) puuid = p.puuid;
                        }
                        if (!puuid) {
                            Utils.Debug.warn('[GameAnalysis] Could not locate valid PUUID for stats loading.');
                            renderStatsElements(el, { empty: true }, null);
                            this._renderedIdKey = trackingKey;
                            this._renderedStats = { empty: true };
                            return;
                        }

                        Utils.Debug.log(`[GameAnalysis] Target resolved PUUID: ${puuid}`);

                        // Resolve premades if enabled
                        const premades = isPremadeHighlightEnabled ? await getChampSelectPremades(session) : new Map();
                        const premadeColor = premades.get(puuid);
                        if (premadeColor) {
                            Utils.Debug.log(`[GameAnalysis] Player ${puuid} belongs to a premade group. Applying visual indicator color: ${premadeColor}`);
                            this._renderedPremadeColor = premadeColor;
                        } else {
                            this._renderedPremadeColor = null;
                        }

                        const gf = await getCachedGfSession();
                        const queueId = gf?.gameData?.queue?.id;
                        const tag = queueId ? 'q_' + queueId : '';
                        const cacheKey = `${puuid}_${tag}`;

                        Utils.Debug.log(`[GameAnalysis] Checking local inline stats cache with key: ${cacheKey}`);
                        let statsData = champSelectStatsCache.get(cacheKey);

                        if (!statsData) {
                            Utils.Debug.log(`[GameAnalysis] Cache MISS. Fetching match history and ranked stats for PUUID: ${puuid}`);
                            const [h, ranked] = await Promise.all([
                                Utils.GameData.getSgpMatchHistory(puuid, 0, 20, tag).catch((err) => {
                                    Utils.Debug.error('[GameAnalysis] Match History API fetch failed', err);
                                    return null;
                                }),
                                Utils.LCU.get('/lol-ranked/v1/ranked-stats/' + puuid).catch((err) => {
                                    Utils.Debug.error('[GameAnalysis] LCU Ranked Stats API fetch failed', err);
                                    return null;
                                })
                            ]);

                            let rankText = null;
                            let rankTier = null;
                            if (ranked?.queueMap?.RANKED_SOLO_5x5) {
                                const q = ranked.queueMap.RANKED_SOLO_5x5;
                                if (q.tier && q.tier !== 'NONE' && q.tier !== 'UNRANKED') {
                                    rankTier = q.tier;
                                    rankText = q.tier + (q.division && q.division !== 'NA' ? ' ' + q.division : '');
                                }
                            }
                            Utils.Debug.log(`[GameAnalysis] Resolved ranked stats: Tier = ${rankTier} | Text = ${rankText}`);

                            if (h && h.games && h.games.length > 0) {
                                Utils.Debug.log(`[GameAnalysis] Retrieved ${h.games.length} match records. Compiling stats averages...`);
                                let totalK = 0,
                                    totalD = 0,
                                    totalA = 0,
                                    totalW = 0,
                                    validG = 0;
                                const champCounts = {};
                                const results = [];

                                h.games.forEach(g => {
                                    const pt = g.json.participants.find(x => x.puuid === puuid) || g.json.participants[0];
                                    if (!pt) return;
                                    const isWin = pt.win !== undefined ? pt.win : g.json.teams.find(t => t.teamId === pt.teamId)?.win;
                                    const isRemake = g.json.gameDuration < 240 && g.json.gameMode !== 'PRACTICETOOL';

                                    if (!isRemake) {
                                        totalK += (pt.kills || 0);
                                        totalD += (pt.deaths || 0);
                                        totalA += (pt.assists || 0);
                                        if (isWin) totalW++;
                                        validG++;

                                        if (pt.championId) {
                                            champCounts[pt.championId] = (champCounts[pt.championId] || 0) + 1;
                                        }
                                    }

                                    results.push(isRemake ? 'remake' : (isWin ? 'win' : 'loss'));
                                });

                                let mostPickedId = null;
                                let mostPickedCount = 0;
                                for (const [cid, count] of Object.entries(champCounts)) {
                                    if (count > mostPickedCount) {
                                        mostPickedCount = count;
                                        mostPickedId = cid;
                                    }
                                }

                                const kda = validG > 0 ? ((totalK + totalA) / Math.max(1, totalD)).toFixed(2) : '?';
                                const wr = validG > 0 ? Math.round((totalW / validG) * 100) : '?';

                                statsData = {
                                    results: results.slice(0, 10),
                                    kda,
                                    wr,
                                    mostPickedId,
                                    mostPickedCount,
                                    validG,
                                    rankText,
                                    rankTier
                                };
                                champSelectStatsCache.set(cacheKey, statsData);
                            } else {
                                Utils.Debug.warn('[GameAnalysis] SGP match history array was empty or returned invalid.');
                                statsData = {
                                    empty: true,
                                    rankText,
                                    rankTier
                                };
                                champSelectStatsCache.set(cacheKey, statsData);
                            }
                        } else {
                            Utils.Debug.log(`[GameAnalysis] Cache HIT for player stats: ${cacheKey}`);
                        }

                        // Render and save to component tracking state
                        Utils.Debug.log(`[GameAnalysis] Drawing stats interface updates for player key: ${trackingKey}`);
                        renderStatsElements(el, statsData, premadeColor);
                        this._renderedIdKey = trackingKey;
                        this._renderedStats = statsData;
                        this._renderedGeneration = myGeneration;

                    } catch (err) {
                        Utils.Debug.error('[GameAnalysis] Exception caught in statistics calculation loop:', err);
                    } finally {
                        this._isLoadingStats = false;
                        this._loadingForId = null;
                    }
                }, 50);
            }
        }, {
            name: 'willDestroyElement',
            callback(Ember, original, ...args) {
                if (this.element) {
                    Utils.Debug.log('[GameAnalysis] willDestroyElement triggered. Cleaning up elements.');
                    const icon = this.element.querySelector('.champion-icon-container');
                    if (icon) icon.removeAttribute('data-pm-history');

                    // Clean up manually appended stats elements on destroy
                    ['.pm-champ-select-stats', '.pm-cs-stats-wrapper', '.pm-cs-stats-row', '.pm-pre-badge', '.pm-rank-badge'].forEach(sel => {
                        this.element.querySelectorAll(sel).forEach(node => node.remove());
                    });
                }
                this._renderedIdKey = null;
                this._renderedStats = null;
                this._renderedPremadeColor = null;
                this._renderedGeneration = null;
                this._isLoadingStats = false;
                this._loadingForId = null;
                original(...args);
            }
        }]
    });
}

export function load() {
    Utils.GameData.Assets.init();
    loadAugments();
    if (Utils.LCU && Utils.LCU.observe) {
        if (!gameAnalysisPhaseUnsub) {
            gameAnalysisPhaseUnsub = Utils.LCU.observe('/lol-gameflow/v1/gameflow-phase', e => handleGameAnalysisPhase(e.data));
            Utils.LCU.get('/lol-gameflow/v1/gameflow-phase').then(phase => handleGameAnalysisPhase(phase)).catch(() => {});
        }
        if (!_wsCsSessionUnsub) {
            _wsCsSessionUnsub = Utils.LCU.observe('/lol-champ-select/v1/session', e => { _wsCsSession = e.data; });
            Utils.LCU.get('/lol-champ-select/v1/session').then(data => { _wsCsSession = data; }).catch(() => {});
        }
        if (!_wsGfSessionUnsub) {
            _wsGfSessionUnsub = Utils.LCU.observe('/lol-gameflow/v1/session', e => { _wsGfSession = e.data; });
        }
    }
}

export function formatTime(ts) {
    const d = new Date(ts);
    const now = new Date();
    const diffDays = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / (1000 * 60 * 60 * 24));
    const time = d.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });
        if (diffDays === 0) return t("Today {{time}}", { time });
    if (diffDays === 1) return t("Yesterday {{time}}", { time });
    return d.toLocaleDateString(undefined, {
        month: '2-digit',
        day: '2-digit'
    }) + ' ' + time;
}

export function buildMatchRow(g, player, globalIdx) {
    const p = g.json.participants.find(x => x.puuid === player.puuid) || g.json.participants[0];
    if (!p) return '';
    const win = p.win !== undefined ? p.win : g.json.teams.find(t => t.teamId === p.teamId)?.win;
    const qData = Utils.GameData.Assets.queues?.find(q => Number(q.id) === g.json.queueId);
    const mode = qData ? qData.name : (g.json.gameMode || 'UNKNOWN');
    const isRemake = g.json.gameDuration < 240 && mode !== 'PRACTICETOOL';

    const statusClass = isRemake ? '#746e64' : (win ? '#0ac8b9' : '#e84057');
    const bgClass = isRemake ? 'rgba(116,110,100,0.03)' : (win ? 'rgba(10,200,185,0.03)' : 'rgba(232,64,87,0.03)');
    const statusText = isRemake ? t('REMAKE') : (win ? t('VICTORY') : t('DEFEAT'));

    const champIcon = Utils.GameData.Assets.getIcon('champs', p.championId) || '/lol-game-data/assets/v1/champion-icons/' + p.championId + '.png';
    const spell1 = Utils.GameData.Assets.getIcon('spells', p.spell1Id);
    const spell2 = Utils.GameData.Assets.getIcon('spells', p.spell2Id);

    const primaryStyle = p.perks?.styles?.[0];
    const subStyle = p.perks?.styles?.[1];
    const perk0Id = primaryStyle?.selections?.[0]?.perk;
    const perkSubId = subStyle?.style;

    const perkPrimary = Utils.GameData.Assets.getIcon('perks', perk0Id);
    const perkSub = Utils.GameData.Assets.getIcon('perks', perkSubId);

    const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map((id, idx) => {
        const isTrinket = idx === 6;
        const size = isTrinket ? '24px' : '28px';
        if (!id) return `<div style="width:${size};height:${size};background:rgba(30,35,40,0.8);border-radius:4px;"></div>`;
        const src = Utils.GameData.Assets.getIcon('items', id) || '/lol-game-data/assets/v1/items/' + id + '.png';
        return `<img src="${src}" style="width:${size};height:${size};border-radius:4px;border:1px solid rgba(200,170,110,0.2);" onerror="this.style.opacity=0"/>`;
    }).join('');

    const kda = ((p.kills + p.assists) / Math.max(1, p.deaths)).toFixed(2);
    const timestamp = g.json.gameCreation || 0;

    const cs = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
    const gold = p.goldEarned || 0;
    const goldStr = gold >= 1000 ? (gold / 1000).toFixed(1) + t('k') : gold;

    return `
      <div class="pm-match-row" data-idx="${globalIdx}" style="display:flex; align-items:center; justify-content:space-between; padding:12px 20px; background:${bgClass}; border-radius:6px; border-left:4px solid ${statusClass}; margin-bottom:8px; box-shadow:0 2px 8px rgba(0,0,0,0.2); cursor:pointer;">
        
        <div style="display:flex; flex-direction:column; width:110px;">
          <div style="color:${statusClass}; font-weight:bold; font-size:15px; letter-spacing:0.5px;">${statusText}</div>
          <div style="color:#a09b8c; font-size:12px; margin-top:2px; font-weight:600;">${mode}</div>
          <div style="color:#746e64; font-size:11px; margin-top:4px;">${formatTime(timestamp)}</div>
          <span data-avg-rank-row="${g.json.gameId}" style="color:#9a7b4f; font-size:10px; margin-top:2px;"></span>
        </div>

        <div style="display:flex; align-items:center; gap:12px; width:140px;">
          <div style="position:relative; width:48px; height:48px;">
            <img src="${champIcon}" style="width:100%; height:100%; border-radius:50%; border:2px solid ${statusClass}; object-fit:cover;" onerror="this.style.opacity=0"/>
            <div style="position:absolute; bottom:-6px; left:50%; transform:translateX(-50%); background:#010a13; border:1px solid ${statusClass}; border-radius:10px; padding:0 5px; display:flex; align-items:center; justify-content:center; font-size:10px; color:#f0e6d2; font-weight:bold;">
              ${p.champLevel || p.stats?.champLevel || ''}
            </div>
          </div>
          
          <div style="display:flex; flex-direction:column; gap:4px;">
            <div style="display:flex; gap:4px;">
              <img src="${spell1}" style="width:20px; height:20px; border-radius:3px;" onerror="this.style.display='none'"/>
              <img src="${spell2}" style="width:20px; height:20px; border-radius:3px;" onerror="this.style.display='none'"/>
            </div>
            <div style="display:flex; gap:4px;">
              <img src="${perkPrimary}" style="width:20px; height:20px; border-radius:50%; background:#000;" onerror="this.style.display='none'"/>
              <img src="${perkSub}" style="width:20px; height:20px; border-radius:50%; background:#000;" onerror="this.style.display='none'"/>
            </div>
          </div>
        </div>

        <div style="display:flex; flex-direction:column; align-items:center; width:110px;">
          <div style="color:#f0e6d2; font-weight:bold; font-size:15px; letter-spacing:0.5px;">${p.kills} <span style="color:#746e64">${t("/")}</span> <span style="color:#e84057">${p.deaths}</span> <span style="color:#746e64">${t("/")}</span> ${p.assists}</div>
          <div style="color:#a09b8c; font-size:12px; margin-top:4px;">${kda} <span style="color:#746e64; font-size:11px;">${t("KDA")}</span></div>
        </div>

        <div style="display:flex; flex-direction:column; align-items:center; width:80px; gap:4px;">
          <div style="color:#a09b8c; font-size:13px; display:flex; align-items:center; gap:4px;" title="${t("Minion Score")}">
            <span style="color:#f0e6d2; font-weight:600;">${cs}</span> <span style="color:#746e64; font-size:11px;">${t("CS")}</span>
          </div>
          <div style="color:#f0e6d2; font-size:13px; font-weight:600; display:flex; align-items:center; gap:4px;" title="${t("Gold Earned")}">
            <span style="color:#c8aa6e">${goldStr}</span> <span style="color:#746e64; font-size:11px;">${t("G")}</span>
          </div>
        </div>

        <div style="display:flex; gap:4px; align-items:center; justify-content:flex-end;">
          ${items}
        </div>
      </div>
    `;
}

function computePerformanceScores(participants, gameDuration) {
    const players = Utils.Scoring.normalizeParticipants(participants);
    const detailed = Utils.Scoring.computeScoresDetailed(players);
    const { scores, entries } = detailed;

    const sorted = [...entries].sort((a, b) => b.composite - a.composite);
    const mvpPuuid = sorted.find(e => e.win)?.puuid;
    const acePuuid = sorted.find(e => !e.win)?.puuid;

    const ranked = [...entries].sort((a, b) => b.score - a.score);

    const scoresMap = {};
    const debugTable = [];

    ranked.forEach((e, idx) => {
        scoresMap[e.puuid] = {
            score: e.score.toFixed(1),
            rank: idx + 1,
            isMvp: e.puuid === mvpPuuid,
            isAce: e.puuid === acePuuid
        };

        debugTable.push({
            rank: idx + 1,
            score: e.score.toFixed(1),
            win: e.win,
            kills: e.kills,
            deaths: e.deaths,
            assists: e.assists,
            dmg: e.dmg,
            gold: e.gold,
            cs: e.cs,
            healing: e.healing,
            tanking: e.tanking,
            teamId: e.teamId,
            champion: e.championName,
            kda: e.kda,
            kdaNorm: e.kdaNorm,
            kp: e.kp,
            killShare: e.killShare,
            healFrac: e.healFrac,
            tankFrac: e.tankFrac,
            dmgFrac: e.dmgFrac,
            role: e.role,
            teamKills: e.teamKills,
            gameDmg: detailed.gameDmg,
            kdaN: e.kdaN,
            kpN: e.kpN,
            killN: e.killN,
            dmgN: e.dmgN,
            goldN: e.goldN,
            composite: e.composite,
            z: e.z
        });
    });

    return {
        scoresMap,
        debugTable
    };
}

export const MatchHistoryModal = (function() {
    let _root = null,
        _content = null,
        _player = null;
    let _startIndex = 0,
        _isLoading = false,
        _hasMore = true,
        _currentTag = '';
    let _loadedGames = [];
    let _overrideRegion = null;
    let _lazyRankObserver = null;
    const FETCH_COUNT = 20;

    function create() {
        if (document.getElementById('pm-history-root')) return;
        _root = document.createElement('div');
        _root.id = 'pm-history-root';
        Object.assign(_root.style, {
            position: 'fixed',
            top: '0',
            left: '0',
            width: '100vw',
            height: '100vh',
            zIndex: '2147483647',
            display: 'none',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: '"Segoe UI", sans-serif',
            pointerEvents: 'none'
        });

        const overlay = document.createElement('div');
        Object.assign(overlay.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '100%',
            height: '100%',
            background: 'rgba(0, 0, 0, 0.45)',
            backdropFilter: 'blur(10px)',
            pointerEvents: 'auto'
        });
        overlay.addEventListener('click', hide);

        const modal = document.createElement('div');
        Object.assign(modal.style, {
            position: 'relative',
            zIndex: '1',
            width: '1000px',
            maxWidth: '90vw',
            height: '82vh',
            background: 'rgba(1, 10, 19, 0.75)',
            border: '1px solid rgba(200, 170, 110, 0.2)',
            borderRadius: '12px',
            display: 'flex',
            flexDirection: 'column',
            color: '#a09b8c',
            boxShadow: '0 16px 48px rgba(0, 0, 0, 0.7), inset 0 1px 0 rgba(255, 255, 255, 0.05)',
            backdropFilter: 'blur(25px) saturate(140%)',
            pointerEvents: 'auto'
        });

        const header = document.createElement('div');
        Object.assign(header.style, {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '16px 24px',
            borderBottom: '1px solid #3e2e13',
            background: 'rgba(30, 35, 40, 0.6)'
        });

        const titleSection = document.createElement('div');
        Object.assign(titleSection.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '16px'
        });

        const title = document.createElement('h2');
        title.id = 'pm-history-title';
        Object.assign(title.style, {
            color: '#f0e6d2',
            fontSize: '18px',
            fontWeight: 'bold',
            margin: '0',
            letterSpacing: '1px'
        });

        const filterSelect = document.createElement('select');
        filterSelect.id = 'pm-history-filter';
        Object.assign(filterSelect.style, {
            background: '#1e2328',
            color: '#f0e6d2',
            border: '1px solid #3e2e13',
            padding: '4px 8px',
            borderRadius: '2px',
            outline: 'none',
            maxWidth: '200px'
        });

        filterSelect.addEventListener('change', (e) => {
            _currentTag = e.target.value;
            _startIndex = 0;
            _hasMore = true;
            _loadedGames = [];
            const listDiv = document.getElementById('pm-history-list');
            if (listDiv) listDiv.innerHTML = '';
            if (_lazyRankObserver) {
                _lazyRankObserver.disconnect();
                _lazyRankObserver = null;
            }
            loadMatches(false);
        });

        titleSection.appendChild(title);
        titleSection.appendChild(filterSelect);

        const closeBtn = document.createElement('button');
        closeBtn.innerHTML = t('✕');
        Object.assign(closeBtn.style, {
            background: 'none',
            border: 'none',
            color: '#a09b8c',
            fontSize: '24px',
            cursor: 'pointer',
            padding: '0',
            lineHeight: '1'
        });
        closeBtn.addEventListener('click', hide);
        header.appendChild(titleSection);
        header.appendChild(closeBtn);

        _content = document.createElement('div');
        _content.id = 'pm-history-content';
        Object.assign(_content.style, {
            flex: '1',
            padding: '16px',
            overflowY: 'auto'
        });

        const css = document.createElement('style');
        css.textContent = `
      #pm-history-content::-webkit-scrollbar { width: 6px; }
      #pm-history-content::-webkit-scrollbar-track { background: transparent; }
      #pm-history-content::-webkit-scrollbar-thumb { background: rgba(200, 170, 110, 0.15); border-radius: 3px; }
      #pm-history-content::-webkit-scrollbar-thumb:hover { background: rgba(200, 170, 110, 0.3); }
      
      .pm-match-row { transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease; border: 1px solid transparent; }
      .pm-match-row:hover { transform: translateY(-1px); background: rgba(255,255,255,0.06) !important; border-color: rgba(200,170,110,0.2) !important; box-shadow: 0 4px 12px rgba(0,0,0,0.4); }
      .pm-match-row:active { transform: translateY(0px); }
      
      .pm-match-detail-row { position: relative; display: grid; grid-template-columns: minmax(120px, 1.5fr) minmax(82px, 0.72fr) minmax(0, 1.15fr); column-gap: 8px; align-items: center; padding: 6px 8px; background: rgba(255, 255, 255, 0.015); border-radius: 4px; border: 1px solid rgba(255,255,255,0.04); margin-bottom: 4px; }
      .pm-match-detail-row:hover { background: rgba(255, 255, 255, 0.035); }
      
      .pm-btn-back { color: #c8aa6e; transition: color 0.15s; }
      .pm-btn-back:hover { color: #f0e6d2 !important; }
    `;
        _content.appendChild(css);

        const listDiv = document.createElement('div');
        listDiv.id = 'pm-history-list';
        Object.assign(listDiv.style, {
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
        });

        listDiv.addEventListener('click', (e) => {
            const row = e.target.closest('.pm-match-row');
            if (row) {
                const idx = parseInt(row.getAttribute('data-idx'));
                if (!isNaN(idx) && _loadedGames[idx]) {
                    showMatchDetail(_loadedGames[idx]);
                }
            }
        });

        const detailDiv = document.createElement('div');
        detailDiv.id = 'pm-history-detail';
        Object.assign(detailDiv.style, {
            display: 'none',
            flexDirection: 'column',
            gap: '4px',
            height: '100%'
        });

        const loadingDiv = document.createElement('div');
        loadingDiv.id = 'pm-history-loading';
        Object.assign(loadingDiv.style, {
            color: '#c8aa6e',
            textAlign: 'center',
            marginTop: '20px',
            fontSize: '14px',
            display: 'none'
        });

        _content.appendChild(listDiv);
        _content.appendChild(detailDiv);
        _content.appendChild(loadingDiv);

        _content.addEventListener('scroll', () => {
            if (detailDiv.style.display === 'flex') return;
            if (_content.scrollTop + _content.clientHeight >= _content.scrollHeight - 100) {
                loadMatches(true);
            }
        });

        modal.appendChild(header);
        modal.appendChild(_content);
        _root.appendChild(overlay);
        _root.appendChild(modal);

        const viewportOverlay = document.querySelector('.rcp-fe-viewport-overlay');
        if (viewportOverlay && viewportOverlay.parentNode === document.body) viewportOverlay.after(_root);
        else document.body.appendChild(_root);
    }

    function initLazyRankObserver() {
        if (_lazyRankObserver) return _lazyRankObserver;
        _lazyRankObserver = new IntersectionObserver((entries, observer) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const row = entry.target;
                    observer.unobserve(row);
                    const idx = parseInt(row.getAttribute('data-idx'));
                    if (!isNaN(idx) && _loadedGames[idx]) {
                        const g = _loadedGames[idx];
                        const gameId = g.json.gameId;
                        const participants = g.json.participants || [];
                        Promise.all(participants.map(pt => fetchRankForPuuid(pt.puuid))).then(ranks => {
                            const bests = ranks.map(r => r?.best).filter(b => b && !b.isUnranked);
                            const label = computeTeamAvgLabel(bests);
                            if (!label) return;
                            const slot = row.querySelector(`[data-avg-rank-row="${gameId}"]`);
                            if (slot) slot.textContent = t('~') + label;
                        });
                    }
                }
            });
        }, {
            root: _content,
            rootMargin: '200px 0px',
            threshold: 0
        });
        return _lazyRankObserver;
    }

    async function loadMatches(append = false) {
        if (_isLoading || !_hasMore) return;
        _isLoading = true;

        const loadingDiv = document.getElementById('pm-history-loading');
        const listDiv = document.getElementById('pm-history-list');
        if (loadingDiv) {
            loadingDiv.style.display = 'block';
            loadingDiv.textContent = t('Loading matches from Riot...');
        }

        try {
            const h = await Utils.GameData.getSgpMatchHistory(_player.puuid, _startIndex, FETCH_COUNT, _currentTag, _overrideRegion);
            const games = h?.games || [];
            if (games.length < FETCH_COUNT) _hasMore = false;

            games.forEach(g => {
                _loadedGames.push(g);
            });

            let html = '';
            games.forEach((g, idx) => {
                const globalIdx = _loadedGames.length - games.length + idx;
                html += buildMatchRow(g, _player, globalIdx);
            });

            if (append) {
                listDiv.insertAdjacentHTML('beforeend', html);
            } else {
                listDiv.innerHTML = html;
                if (games.length === 0) listDiv.innerHTML = `<div style="color:#a09b8c;text-align:center;margin-top:40px;">${t("No matches found for this filter.")}</div>`;
            }

            _startIndex += games.length;
            if (!_hasMore && loadingDiv) loadingDiv.textContent = t('No more matches.');

            // Lazy load ranks for visible matches
            const observer = initLazyRankObserver();
            const addedRows = listDiv.querySelectorAll('.pm-match-row:not([data-observed])');
            addedRows.forEach(row => {
                row.setAttribute('data-observed', 'true');
                observer.observe(row);
            });
        } catch (err) {
            if (loadingDiv) loadingDiv.textContent = t('Failed to load Endpoint match history');
            Utils.Debug.error('SGP history error:', err);
        }
        _isLoading = false;
        if (loadingDiv && _hasMore) loadingDiv.style.display = 'none';
    }

    async function showMatchDetail(game) {
        const listDiv = document.getElementById('pm-history-list');
        const detailDiv = document.getElementById('pm-history-detail');
        const loadingDiv = document.getElementById('pm-history-loading');
        const filterSelect = document.getElementById('pm-history-filter');

        const savedScrollTop = _content.scrollTop;

        if (loadingDiv) loadingDiv.style.display = 'none';
        if (filterSelect) filterSelect.style.display = 'none';
        listDiv.style.display = 'none';

        detailDiv.innerHTML = '';
        detailDiv.style.display = 'flex';

        detailDiv.innerHTML = buildMatchDetailHtml(game);
        _content.scrollTop = 0;

        const backBtn = detailDiv.querySelector('.pm-btn-back');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                detailDiv.style.display = 'none';
                listDiv.style.display = 'flex';
                if (filterSelect) filterSelect.style.display = 'block';
                if (loadingDiv && _hasMore) loadingDiv.style.display = 'block';
                _content.scrollTop = savedScrollTop;
            });
        }

        // Async rank fetching update DOM slots as ranks resolve
        const participants = game.json.participants || [];
        const myTeamId = (participants.find(p => p.puuid === _player.puuid) || participants[0])?.teamId;
        const teamRanks = {}; // teamId -> [best rank objects]

        await Promise.all(participants.map(async p => {
            const rank = await fetchRankForPuuid(p.puuid);
            // Update player rank slot using best rank. solo queue vs flex
            const slot = detailDiv.querySelector(`[data-rank-slot="${p.puuid}"]`);
            if (slot) {
                const best = rank?.best;
                if (best && !best.isUnranked) {
                    const color = getTierColor(best.tier);
                    const label = best.tier.charAt(0) + best.tier.slice(1).toLowerCase() + (best.division ? ' ' + best.division : '') + (best.lp ? ' ' + t('·') + ' ' + best.lp + t('LP') : '');
                    slot.innerHTML = `<span style="color:${color};">${escapeHtml(label)}</span><span style="color:#5a5a5a; font-size:8px; margin-left:3px;">${best.queue}</span>`;
                } else {
                    slot.textContent = t('Unranked');
                }
            }
            if (rank?.best && !rank.best.isUnranked) {
                if (!teamRanks[p.teamId]) teamRanks[p.teamId] = [];
                teamRanks[p.teamId].push(rank.best);
            }
        }));

        // Update team avg rank slots
        Object.keys(teamRanks).forEach((teamId) => {
            const side = String(teamId) === String(myTeamId) ? 'left' : 'right';
            const label = computeTeamAvgLabel(teamRanks[teamId]);
            if (!label) return;
            const avgSlot = detailDiv.querySelector(`[data-avg-rank-slot="${side}"]`);
            if (avgSlot) {
                avgSlot.textContent = t('Avg:') + ' ' + label;
            }
        });
    }

    function buildMatchDetailHtml(game) {
        const participants = game.json.participants || [];
        const qData = Utils.GameData.Assets.queues?.find(q => Number(q.id) === game.json.queueId);
        const mode = qData ? qData.name : (game.json.gameMode || 'UNKNOWN');
        const durationMin = Math.floor(game.json.gameDuration / 60);
        const durationSec = game.json.gameDuration % 60;
        const dateStr = formatTime(game.json.gameCreation || 0);

        const me = participants.find(p => p.puuid === _player.puuid) || participants[0];
        if (!me) return `<div style="color:#a09b8c;text-align:center;padding:40px;font-size:13px;">${t("Match data unavailable")}</div>`;
        const isWin = me.win;
        const remakeMode = game.json.gameDuration < 240 && mode !== 'PRACTICETOOL';
        const statusText = remakeMode ? t('REMAKE') : (isWin ? t('VICTORY') : t('DEFEAT'));
        const statusColor = remakeMode ? '#746e64' : (isWin ? '#0ac8b9' : '#e84057');

        const maxDmg = Math.max(...participants.map(p => p.totalDamageDealtToChampions || 0), 1);
        const {
            scoresMap,
            debugTable
        } = computePerformanceScores(participants, game.json.gameDuration);

        if (window.managerdebug) {
            Utils.Debug.log(`[SnoozeManager Debug] Match ${game.json.gameId} — ${mode} ${durationMin}m${durationSec}s`);
            Utils.Debug.log(debugTable.map(r => ({
                '#': r.rank,
                score: r.score,
                win: r.win ? 'W' : 'L',
                champion: r.champion,
                role: r.role,
                kda: `${r.kills}/${r.deaths}/${r.assists}`,
                dmg: r.dmg,
                gold: r.gold,
                cs: r.cs,
                healing: r.healing,
                tanking: r.tanking,
                kdaNorm: r.kdaNorm,
                kp: r.kp,
                dmgShare: r.dmgShare,
                goldShare: r.goldShare,
                healShare: r.healShare,
                tankShare: r.tankShare,
                composite: r.composite,
                z: r.z,
                teamKills: r.teamTotals.kills,
                teamDmg: r.teamTotals.dmg
            })));
        }

        const myRating = scoresMap[_player.puuid];
        let ratingBadgeHtml = '';
        if (myRating) {
            const label = myRating.isMvp ? t('Match MVP') : (myRating.isAce ? t('Match ACE') : t("#{{rank}} in Match", { rank: myRating.rank }));
            const bg = myRating.isMvp ? 'rgba(10, 200, 185, 0.15)' : (myRating.isAce ? 'rgba(232, 64, 87, 0.15)' : 'rgba(200, 170, 110, 0.1)');
            const border = myRating.isMvp ? 'rgba(10, 200, 185, 0.3)' : (myRating.isAce ? 'rgba(232, 64, 87, 0.3)' : 'rgba(200, 170, 110, 0.25)');
            const color = myRating.isMvp ? '#0ac8b9' : (myRating.isAce ? '#e84057' : '#c8aa6e');

            ratingBadgeHtml = `
        <div style="font-size:11px; color:${color}; margin-top:6px; font-weight:bold; background:${bg}; padding:3px 10px; border-radius:4px; display:inline-block; border:1px solid ${border}; text-transform:uppercase; letter-spacing:0.5px;">
          ${t("Rating:")} ${myRating.score} ${t('•')} ${label}
        </div>
      `;
        }

        const teams = {};
        participants.forEach(p => {
            if (!teams[p.teamId]) {
                teams[p.teamId] = {
                    id: p.teamId,
                    players: [],
                    win: p.win !== undefined ? p.win : false,
                    kills: 0,
                    deaths: 0,
                    assists: 0,
                    gold: 0,
                    damage: 0
                };
            }
            teams[p.teamId].players.push(p);
            teams[p.teamId].kills += (p.kills || 0);
            teams[p.teamId].deaths += (p.deaths || 0);
            teams[p.teamId].assists += (p.assists || 0);
            teams[p.teamId].gold += (p.goldEarned || 0);
            teams[p.teamId].damage += (p.totalDamageDealtToChampions || 0);
        });

        const teamKeys = Object.keys(teams);

        let teamsHtml = '';
        if (teamKeys.length === 2) {
            const t1 = teams[teamKeys[0]];
            const t2 = teams[teamKeys[1]];

            const myTeamId = me.teamId;
            const leftTeam = t1.id === myTeamId ? t1 : t2;
            const rightTeam = t1.id === myTeamId ? t2 : t1;

            teamsHtml = `
        <div style="display:flex; gap:16px; width:100%;">
          <div style="flex:1; display:flex; flex-direction:column; min-width:0;">
            ${buildTeamColumnHtml(leftTeam, 'left', maxDmg, scoresMap)}
          </div>
          <div style="flex:1; display:flex; flex-direction:column; min-width:0;">
            ${buildTeamColumnHtml(rightTeam, 'right', maxDmg, scoresMap)}
          </div>
        </div>
      `;
        } else {
            teamKeys.sort((a, b) => {
                const winA = teams[a].win ? 1 : 0;
                const winB = teams[b].win ? 1 : 0;
                return winB - winA;
            });

            teamsHtml = `
        <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; width:100%; padding-bottom:12px;">
          ${teamKeys.map((tk, idx) => {
            const team = teams[tk];
            return buildTeamCardHtml(team, idx + 1, maxDmg, scoresMap);
          }).join('')}
        </div>
      `;
        }

        return `
      <div class="pm-btn-back" style="display:inline-flex; align-items:center; gap:6px; color:#c8aa6e; cursor:pointer; font-weight:bold; font-size:13px; margin-bottom:12px; transition:color 0.2s; max-width:fit-content;">
        <span style="font-size:16px;">${t('←')}</span> ${t("Back to Match History")}
      </div>
      
      <div style="background:rgba(255, 255, 255, 0.02); border:1px solid rgba(255, 255, 255, 0.05); border-radius:8px; padding:12px 16px; display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
        <div style="display:flex; flex-direction:column; gap:2px;">
          <div style="font-size:18px; font-weight:bold; color:${statusColor}; letter-spacing:0.5px;">${statusText}</div>
          <div style="font-size:11px; color:#a09b8c;">${mode} ${t('•')} ${durationMin}${t('m')} ${durationSec}${t('s')}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:12px; color:#f0e6d2; font-weight:600;">${dateStr}</div>
          <div style="font-size:11px; color:#746e64; margin-top:2px;">${t("ID: {{id}}", { id: game.json.gameId || '' })}</div>
          ${ratingBadgeHtml}
        </div>
      </div>
      
      ${teamsHtml}
    `;
    }

    function buildTeamColumnHtml(team, side, maxDmg, scoresMap) {
        const isWin = team.win;
        const teamColor = side === 'left' ? '#4a9eff' : '#e84057';
        const statusText = isWin ? t('VICTORY') : t('DEFEAT');
        const totalKills = team.kills;
        const totalGold = (team.gold / 1000).toFixed(1) + t('k');

        let html = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; background:rgba(255,255,255,0.02); border-bottom:2px solid ${teamColor}; margin-bottom:8px;">
        <span style="font-weight:bold; font-size:13px; color:${teamColor}; letter-spacing:0.5px;">
          ${side === 'left' ? t('YOUR TEAM') : t('ENEMY TEAM')} 
          <span style="font-size:11px; color:#a09b8c; font-weight:normal; margin-left:6px;">(${statusText})</span>
        </span>
        <span style="font-size:11px; color:#a09b8c; font-weight:600; display:flex; flex-direction:column; align-items:flex-end; gap:1px;">
          <span>${totalKills} ${t("Kills")} ${t('•')} ${totalGold} ${t("Gold")}</span>
          <span data-avg-rank-slot="${side}" style="font-size:10px; color:#746e64;"></span>
        </span>
      </div>
      <div style="display:flex; flex-direction:column; gap:4px;">
    `;

        team.players.forEach(p => {
            html += buildPlayerDetailRowHtml(p, side, maxDmg, scoresMap);
        });

        html += '</div>';
        return html;
    }

    function buildTeamCardHtml(team, teamIndex, maxDmg, scoresMap) {
        const isWin = team.win;
        const totalKills = team.kills;
        const teamColor = isWin ? '#0ac8b9' : 'rgba(255, 255, 255, 0.05)';
        const textColor = isWin ? '#0ac8b9' : '#a09b8c';
        const statusText = isWin ? t('1st Place') : t('Eliminated');

        let html = `
      <div style="background:rgba(255, 255, 255, 0.015); border:1px solid rgba(255, 255, 255, 0.04); border-radius:6px; padding:10px; display:flex; flex-direction:column; gap:4px; border-left:3px solid ${teamColor};">
        <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.05); padding-bottom:4px; margin-bottom:4px;">
          <span style="font-weight:bold; font-size:12px; color:${textColor};">${t("Team {{index}} ({{status}})", { index: teamIndex, status: statusText })}</span>
          <span style="font-size:10px; color:#746e64; font-weight:600;">${totalKills} ${t("Kills")}</span>
        </div>
    `;

        team.players.forEach(p => {
            html += buildPlayerDetailRowHtml(p, isWin ? 'left' : 'right', maxDmg, scoresMap);
        });

        html += '</div>';
        return html;
    }

    function buildPlayerDetailRowHtml(p, side, maxDmg, scoresMap) {
        const champInfo = Utils.GameData.Assets.champs[p.championId];
        const champName = champInfo?.name || p.championName || t('Unknown');
        let champIcon = champInfo?.squarePortraitPath || `/lol-game-data/assets/v1/champion-icons/${p.championId}.png`;
        champIcon = champIcon.replace('/lol-game-data/assets/', '/lol-game-data/assets/');

        const spell1 = Utils.GameData.Assets.getIcon('spells', p.spell1Id) || '';
        const spell2 = Utils.GameData.Assets.getIcon('spells', p.spell2Id) || '';

        const cs = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
        const gold = p.goldEarned || 0;

        const items = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6].map((id, idx) => {
            const size = '18px';
            if (!id) return `<div style="width:${size};height:${size};background:rgba(30,35,40,0.4);border-radius:3px;"></div>`;
            const src = Utils.GameData.Assets.getIcon('items', id) || '/lol-game-data/assets/v1/items/' + id + '.png';
            return `<img src="${src}" style="width:${size};height:${size};border-radius:3px;border:1px solid rgba(200,170,110,0.15);" onerror="this.style.opacity=0"/>`;
        }).join('');

        const augments = [p.playerAugment1, p.playerAugment2, p.playerAugment3, p.playerAugment4, p.playerAugment5, p.playerAugment6].filter(Boolean);
        let augmentsHtml = '';
        if (augments.length > 0) {
            augmentsHtml = `
        <div style="display:flex; gap:2px; margin-top:2px; justify-content:flex-end;">
          ${augments.map(id => {
            const aug = augmentsCache[id];
            const name = aug?.name || t("Augment {{id}}", { id });
            const safeName = escapeHtml(name);
            let src = aug?.icon || '';
            if (src) {
              src = src.replace('/lol-game-data/assets/', '/lol-game-data/assets/');
            } else {
               src = `/lol-game-data/assets/v1/perks/${id}.png`;
            }
            return `<img src="${src}" style="width:14px;height:14px;border-radius:50%;border:1px solid #785a28;background:#000;" onerror="this.style.opacity=0" title="${safeName}"/>`;
          }).join('')}
        </div>
      `;
        }

        const dmg = p.totalDamageDealtToChampions || 0;
        const dmgPercent = Math.min(100, Math.max(0, (dmg / maxDmg) * 100));
        const barColor = side === 'left' ? 'rgba(74, 158, 255, 0.06)' : 'rgba(232, 64, 87, 0.06)';
        const playerName = p.riotIdGameName ? `${p.riotIdGameName}#${p.riotIdTagline}` : (p.summonerName || t('Unknown'));
        const safePlayerName = escapeHtml(playerName);
        const safeChampName = escapeHtml(champName);
        const isMeHighlight = p.puuid === _player.puuid ? 'border-left: 3px solid #c8aa6e; background: rgba(200,170,110,0.04);' : '';

        const rating = scoresMap[p.puuid];
        let badgeHtml = '';
        if (rating) {
            const badgeColor = rating.isMvp ? '#0ac8b9' : (rating.isAce ? '#e84057' : 'rgba(255, 255, 255, 0.12)');
            const badgeTextColor = rating.isMvp || rating.isAce ? '#010a13' : '#a09b8c';
            const badgeText = rating.isMvp ? t('MVP') : (rating.isAce ? t('ACE') : rating.score);
            badgeHtml = `
        <span style="font-size:8px; font-weight:bold; color:${badgeTextColor}; background:${badgeColor}; padding:1px 4px; border-radius:3px; margin-left:6px; text-transform:uppercase; letter-spacing:0.5px; flex-shrink:0;" title="${t("Rating: {{score}}/10 (#{{rank}} in match)", { score: rating.score, rank: rating.rank })}">
          ${badgeText}
        </span>
      `;
        }

        return `
      <div class="pm-match-detail-row" style="${isMeHighlight}">
        <div style="position:absolute; left:0; top:0; bottom:0; width:${dmgPercent}%; background:${barColor}; pointer-events:none; transition: width 0.3s ease;"></div>
        
        <div style="display:grid; grid-template-columns:28px 13px minmax(0,1fr); align-items:center; gap:6px; min-width:0; position:relative; z-index:1;">
          <img src="${champIcon}" style="width:28px; height:28px; border-radius:50%; border:2px solid #785a28; flex-shrink:0;" onerror="this.style.opacity=0"/>
          <div style="display:flex; flex-direction:column; gap:2px; flex-shrink:0;">
            <img src="${spell1}" style="width:13px; height:13px; border-radius:2px;" onerror="this.style.display='none'"/>
            <img src="${spell2}" style="width:13px; height:13px; border-radius:2px;" onerror="this.style.display='none'"/>
          </div>
          <div style="display:flex; flex-direction:column; align-items:center; text-align:center; min-width:0; overflow:hidden;">
            <div style="display:flex; align-items:center; justify-content:center; min-width:0; max-width:100%;">
              <span style="font-weight:bold; font-size:11px; color:#f0e6d2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:pointer; transition:color 0.15s; ${p.puuid === _player.puuid ? 'color:#c8aa6e;' : ''}" title="${t("Click to copy: {{name}}", { name: safePlayerName })}" onclick="navigator.clipboard.writeText('${escapeJsSingleQuoted(playerName)}'); const el = this; const orig = el.innerText; const origColor = el.style.color; el.innerText = '${t('Copied!')}'; el.style.color = '#0ac8b9'; setTimeout(() => { el.innerText = orig; el.style.color = origColor; }, 1500);">
                ${safePlayerName}
              </span>
              ${badgeHtml}
            </div>
            <span style="font-size:10px; color:#a09b8c; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%;" title="${safeChampName}">${safeChampName}</span>
            <span data-rank-slot="${p.puuid}" style="font-size:9px; color:#746e64; margin-top:1px;">${t('…')}</span>
          </div>
        </div>
        
        <div style="display:flex; flex-direction:column; align-items:center; text-align:center; min-width:0; position:relative; z-index:1;">
          <span style="font-size:11px; font-weight:bold; color:#f0e6d2;">
            ${p.kills} <span style="color:#746e64">${t("/")}</span> <span style="color:#e84057">${p.deaths}</span> <span style="color:#746e64">${t("/")}</span> ${p.assists}
          </span>
          <span style="font-size:9px; color:#a09b8c; margin-top:1px;">
            ${dmg.toLocaleString()} ${t("DMG")} ${t('•')} <span style="color:#c8aa6e">${cs} ${t("CS")}</span>
          </span>
        </div>
        
        <div style="display:flex; flex-direction:column; justify-content:center; align-items:flex-end; min-width:0; position:relative; z-index:1;">
          <div style="display:flex; gap:2px; justify-content:flex-end;">
            ${items}
          </div>
          ${augmentsHtml}
        </div>
      </div>
    `;
    }

    async function show(player, defaultTag = '', overrideRegion = null) {
        if (!_root || !document.body.contains(_root)) create();
        _player = player;
        _startIndex = 0;
        _hasMore = true;
        _loadedGames = [];
        _overrideRegion = overrideRegion;
        if (_lazyRankObserver) {
            _lazyRankObserver.disconnect();
            _lazyRankObserver = null;
        }

        const listDiv = document.getElementById('pm-history-list');
        const detailDiv = document.getElementById('pm-history-detail');
        const filterSelect = document.getElementById('pm-history-filter');
        if (listDiv) {
            listDiv.style.display = 'flex';
            listDiv.innerHTML = `<div style="color:#c8aa6e;text-align:center;margin-top:40px;">${t('Loading...')}</div>`;
        }
        if (detailDiv) detailDiv.style.display = 'none';
        if (filterSelect) filterSelect.style.display = 'block';

        document.getElementById('pm-history-title').innerHTML = `<span style="color:#f0e6d2">${escapeHtml(player.gameName)}</span><span style="color:#785a28">#${escapeHtml(player.tagLine)}</span>`;

        const select = document.getElementById('pm-history-filter');
        if (select) {
            select.innerHTML = `<option value="">${t("All Modes")}</option>`;
        }

        _root.style.display = 'flex';
        const pmRoot = document.getElementById('pm-root');
        if (pmRoot) pmRoot.classList.remove('pm-show');

        await Utils.GameData.Assets.init();
        await loadAugments();

        if (!defaultTag) {
            try {
                const gf = await Utils.LCU.get('/lol-gameflow/v1/session').catch(() => null);
                if (gf?.gameData?.queue?.id) {
                    defaultTag = 'q_' + gf.gameData.queue.id;
                } else {
                    const lobby = await Utils.LCU.get('/lol-lobby/v2/lobby').catch(() => null);
                    if (lobby?.gameConfig?.queueId) {
                        defaultTag = 'q_' + lobby.gameConfig.queueId;
                    }
                }
            } catch (e) {}
        }
        _currentTag = defaultTag;

        if (select) {
            select.innerHTML = `<option value="">${t("All Modes")}</option>`;
            if (Utils.GameData.Assets.queues && Utils.GameData.Assets.queues.length > 0) {
                const queueList = includeAllQueues ?
                    Utils.GameData.Assets.queues :
                    Utils.GameData.Assets.queues.filter(q => q.queueAvailability === 'Available');
                queueList.forEach(q => {
                    const opt = document.createElement('option');
                    opt.value = q.tag;
                    opt.textContent = q.name;
                    select.appendChild(opt);
                });
            }
            const exactMatch = Array.from(select.options).some(o => o.value === _currentTag);
            select.value = exactMatch ? _currentTag : '';
            if (!exactMatch) _currentTag = '';
        }

        loadMatches(false);
    }

    function hide() {
        if (_root) _root.style.display = 'none';
        if (_lazyRankObserver) {
            _lazyRankObserver.disconnect();
            _lazyRankObserver = null;
        }
    }

    return {
        show,
        hide
    };
})();
export function unload() {
    gameAnalysisPhaseUnsub?.();
    gameAnalysisPhaseUnsub = null;
    _wsCsSessionUnsub?.();
    _wsCsSessionUnsub = null;
    _wsGfSessionUnsub?.();
    _wsGfSessionUnsub = null;
    _wsCsSession = null;
    _wsGfSession = null;
    cleanupAnalysisPanel();
    MatchHistoryModal.hide();
}
