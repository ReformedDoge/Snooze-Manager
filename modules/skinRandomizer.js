/**
 * @name Snooze-SkinRandomizer
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Randomizes your skin in champion select and marks owned skins/chromas on the carousel dots.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';

// The carousel renders one navigation pip (.skin-selection-indicator-selector)
// per skin, in the same order as /lol-champ-select/v1/skin-carousel-skins, so
// we map pip index -> fetched skin and fade-fill the dot for owned skins.
const PIP_SELECTOR =
  '.skin-selection-indicator-list .skin-selection-indicator-selector';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let randomizeEnabled = false;
let indicatorsEnabled = false;

let availableSkinsArray = [];
let lastSelectedSkinId = null;
let skinThumbnailObserver = null;

let carouselSkinsOwnership = [];
let carouselSkinsChroma = [];
let carouselWasPresent = false;
let carouselLoadInFlight = false;
let indicatorUpdateScheduled = false;
let autoRolled = false;
let bodyObserver = null;
let lastPipCount = 0;

// fetch all carousel skins for the currently selected champion
async function getChampionSkins() {
  return Utils.LCU.get('/lol-champ-select/v1/skin-carousel-skins');
}

// Whale Helper's "Hide Unowned Skins" filters the rendered carousel via its
// handleSkinCarouselSkins wrap, so the pips become an owned-only subset. Mirror
// that exact predicate here so our fetched list matches the rendered pips in
// both length and order, keeping the pip-index -> skin mapping correct.
function filterForHideUnowned(skins) {
  if (Utils.Store.get('whaleHelper', 'hideUnownedEnabled') !== true) return skins;
  return skins.filter(
    (skin) => !(!skin.unlocked && !skin.isBase && (!skin.id || skin.id % 1000 !== 0))
  );
}

// keep only unlocked skins/chromas for the randomizer to choose from
function manageSkinsArray(skinsArray) {
  availableSkinsArray = skinsArray
    .filter((s) => s.unlocked)
    .map((s) => ({
      skinId: s.id,
      chromas: s.childSkins.filter((c) => c.unlocked),
    }));
}

// pick a random unlocked skin, avoiding an immediate repeat
function getRandomSkin() {
  if (availableSkinsArray.length === 1) return availableSkinsArray[0];

  let randomSkin;
  do {
    randomSkin =
      availableSkinsArray[
        Math.floor(Math.random() * availableSkinsArray.length)
      ];
  } while (randomSkin.skinId === lastSelectedSkinId);
  return randomSkin;
}

// randomize a skin/chroma and apply it to the current selection
async function pickRandomSkin() {
  if (!availableSkinsArray.length) return;

  const randomSkin = getRandomSkin();
  lastSelectedSkinId = randomSkin.skinId;

  const options = [...randomSkin.chromas.map((c) => c.id), randomSkin.skinId];
  const selectedSkinId = options[Math.floor(Math.random() * options.length)];

  try {
    await Utils.LCU.patch('/lol-champ-select/v1/session/my-selection', {
      selectedSkinId,
    });
  } catch (err) {
    Utils.Debug.warn('[SkinRandomizer] Failed to apply skin:', err);
  }

  makeSkinThumbnailClickable();
}

// keep click-to-reroll on the centered skin thumbnail (bonus alongside the button)
function makeSkinThumbnailClickable() {
  const selectedLi = document.querySelector('li.skin-carousel-offset-2');
  if (!selectedLi) return;

  const apply = () => {
    const thumbnail = selectedLi.querySelector('.skin-selection-thumbnail');
    if (!thumbnail || thumbnail.dataset.randomizable) return;

    thumbnail.addEventListener('click', () => pickRandomSkin());
    thumbnail.title = 'Click me to randomize a skin!';
    thumbnail.dataset.randomizable = 'true';
  };

  apply();

  if (skinThumbnailObserver) skinThumbnailObserver.disconnect();
  skinThumbnailObserver = new MutationObserver(apply);
  skinThumbnailObserver.observe(selectedLi, { childList: true, subtree: true });
}

// add the "Random Skin" button below the carousel (idempotent)
function ensureRerollButton() {
  if (document.getElementById('skin-randomizer-reroll')) return;
  const container = document.querySelector('.skin-selection-carousel-container');
  if (!container) return;

  const btn = document.createElement('div');
  btn.id = 'skin-randomizer-reroll';
  btn.className = 'skin-randomizer-reroll';
  btn.setAttribute('role', 'button');
  btn.innerHTML = '<span class="skin-randomizer-reroll-icon">🎲</span> Random Skin';
  btn.addEventListener('click', () => pickRandomSkin());
  container.appendChild(btn);
}

function removeRerollButton() {
  const btn = document.getElementById('skin-randomizer-reroll');
  if (btn) btn.remove();
}

function isSkinOwned(skin) {
  return !!(skin && (skin.unlocked || (skin.ownership && skin.ownership.owned)));
}

function hasOwnedChroma(skin) {
  return !!(
    skin &&
    Array.isArray(skin.childSkins) &&
    skin.childSkins.some((c) => c.unlocked)
  );
}

// build both pip maps (ownership + owned-chroma) from the carousel skins
function setOwnershipData(skins) {
  carouselSkinsOwnership = skins.map(isSkinOwned);
  carouselSkinsChroma = skins.map((s) => isSkinOwned(s) && hasOwnedChroma(s));
}

// fade-fill the dot of every owned skin; pips re-render on scroll/selection,
// so this reapplies the class each time it runs
function paintOwnedPips() {
  const pips = document.querySelectorAll(PIP_SELECTOR);
  // Bail if the pip set no longer matches our loaded data (e.g. hide-unowned
  // toggled or champion swapped) so we never paint against a stale mapping;
  // scheduleCarouselUpdate reloads on the pip-count change.
  if (pips.length !== carouselSkinsOwnership.length) return;
  pips.forEach((pip, i) => {
    pip.classList.toggle('owned-skin-pip', !!carouselSkinsOwnership[i]);
    pip.classList.toggle('owned-chroma-pip', !!carouselSkinsChroma[i]);
  });
}

function clearPips() {
  document.querySelectorAll(PIP_SELECTOR).forEach((pip) => {
    pip.classList.remove('owned-skin-pip', 'owned-chroma-pip');
  });
}

// load the skins for the champion on screen (retry until the response length
// matches the rendered pips, so it is the right champion), then wire up the
// dots and button per the enabled toggles. Returns true once data is loaded.
async function refreshCarousel(attempts = 12) {
  if (carouselLoadInFlight) return false;
  carouselLoadInFlight = true;
  try {
    for (let i = 0; i < attempts; i++) {
      const pipCount = document.querySelectorAll(PIP_SELECTOR).length;
      if (!pipCount) return false; // carousel gone

      let skins = null;
      try {
        skins = await getChampionSkins();
      } catch (e) {
        // not ready yet, retry
      }

      if (Array.isArray(skins)) skins = filterForHideUnowned(skins);

      if (Array.isArray(skins) && skins.length === pipCount) {
        manageSkinsArray(skins);
        setOwnershipData(skins);
        if (indicatorsEnabled) paintOwnedPips();
        if (randomizeEnabled) ensureRerollButton();
        return true;
      }
      await delay(150);
    }
    return false;
  } finally {
    carouselLoadInFlight = false;
  }
}

// react to the carousel mounting/unmounting, at most once per frame
function scheduleCarouselUpdate() {
  if (indicatorUpdateScheduled) return;
  indicatorUpdateScheduled = true;
  requestAnimationFrame(() => {
    indicatorUpdateScheduled = false;

    const pipCount = document.querySelectorAll(PIP_SELECTOR).length;

    if (pipCount === 0) {
      // left champ select: drop everything so nothing carries over
      if (carouselWasPresent) {
        carouselWasPresent = false;
        lastPipCount = 0;
        autoRolled = false;
        carouselSkinsOwnership = [];
        carouselSkinsChroma = [];
        availableSkinsArray = [];
        removeRerollButton();
        if (skinThumbnailObserver) {
          skinThumbnailObserver.disconnect();
          skinThumbnailObserver = null;
        }
      }
      return;
    }

    carouselWasPresent = true;

    // (Re)load whenever the pip set changes - entering champ select, a champion
    // swap, or hide-unowned being toggled - so our pip-index -> skin mapping is
    // rebuilt against the currently rendered pips before we paint or roll.
    if ((randomizeEnabled || indicatorsEnabled) && pipCount !== lastPipCount) {
      lastPipCount = pipCount;
      refreshCarousel().then((ok) => {
        if (ok && randomizeEnabled && !autoRolled) {
          autoRolled = true;
          pickRandomSkin(); // auto-roll on entering champ select
        }
      });
    }

    if (randomizeEnabled) ensureRerollButton(); // keep the button alive across re-renders
    if (indicatorsEnabled) paintOwnedPips();
  });
}

// forcing lastPipCount stale makes the next update reload + apply the feature
function forceResync() {
  lastPipCount = -1;
  scheduleCarouselUpdate();
}

function setRandomizeEnabled(enabled) {
  randomizeEnabled = enabled;
  Utils.Store.set('skinRandomizer', 'autoRandomize', enabled);
  if (!enabled) {
    removeRerollButton();
    if (skinThumbnailObserver) {
      skinThumbnailObserver.disconnect();
      skinThumbnailObserver = null;
    }
  } else {
    forceResync();
  }
}

function setIndicatorsEnabled(enabled) {
  indicatorsEnabled = enabled;
  Utils.Store.set('skinRandomizer', 'indicators', enabled);
  if (!enabled) {
    clearPips();
  } else {
    forceResync();
  }
}

function injectStyles() {
  if (document.getElementById('skin-randomizer-styles')) return;
  const style = document.createElement('style');
  style.id = 'skin-randomizer-styles';
  style.textContent = `
    .skin-selection-carousel-container {
      position: relative;
    }
    .skin-randomizer-reroll {
      position: absolute;
      left: 50%;
      top: 100%;
      transform: translate(-50%, 18px);
      z-index: 5;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 10px;
      font-size: 9px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      white-space: nowrap;
      font-family: var(--font-display), "Beaufort for LOL", serif;
      color: #cdbe91;
      background: linear-gradient(180deg, #1e2328, #010a13);
      border: 1px solid transparent;
      border-image: linear-gradient(180deg, #c8aa6e, #785a28) 1;
      cursor: pointer;
      user-select: none;
      transition: color 0.15s, border-image 0.15s;
    }
    .skin-randomizer-reroll:hover {
      color: #f0e6d2;
      border-image: linear-gradient(180deg, #f0e6d2, #c8aa6e) 1;
    }
    .skin-randomizer-reroll:active {
      color: #fff;
      background: linear-gradient(180deg, #010a13, #1e2328);
    }
    .skin-randomizer-reroll-icon {
      font-size: 11px;
    }

    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-skin-pip {
      position: relative;
    }
    /* faded "selected" dot for owned skins (skip the one currently viewed) */
    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-skin-pip:not(.skin-selection-indicator-selector-viewed) {
      background-image: none;
    }
    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-skin-pip:not(.skin-selection-indicator-selector-viewed)::after {
      content: "";
      position: absolute;
      inset: 0;
      background: url(/fe/lol-champ-select/images/config/skin-carousel-pip-selected.png) 50% no-repeat;
      opacity: 0.35;
      pointer-events: none;
    }
    /* rainbow ring when the skin has an owned chroma */
    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-chroma-pip::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 10px;
      height: 10px;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background: conic-gradient(#ff4d4d, #ffb24d, #fff24d, #4dff7a, #4dd2ff, #4d6bff, #b24dff, #ff4d4d);
      -webkit-mask: radial-gradient(closest-side, transparent 58%, #000 62%);
      mask: radial-gradient(closest-side, transparent 58%, #000 62%);
      pointer-events: none;
    }
    /* dim the rainbow ring on pips that aren't currently viewed */
    .skin-selection-indicator-list .skin-selection-indicator-selector.owned-chroma-pip:not(.skin-selection-indicator-selector-viewed)::before {
      opacity: 0.35;
    }
  `;
  document.head.appendChild(style);
}

export function init(context) {
  randomizeEnabled = Utils.Store.get('skinRandomizer', 'autoRandomize') || false;
  indicatorsEnabled = Utils.Store.get('skinRandomizer', 'indicators') || false;

  if (window.SnoozeManager && window.SnoozeManager.registerModule) {
    window.SnoozeManager.registerModule({
      id: 'skinRandomizer',
      name: 'Skin Randomizer',
      description:
        'Randomizes your skin in champion select and marks which skins you own (and which have chromas) on the carousel dots.',
      settings: [
        {
          type: 'toggle',
          id: 'sm:skinRandomizerAuto',
          label: 'Auto-randomize skin',
          description: 'Rolls a random owned skin on entering champ select; adds a "Random Skin" button and lets you click the skin thumbnail to reroll any time',
          value: randomizeEnabled,
          onChange: (val) => setRandomizeEnabled(val),
        },
        {
          type: 'toggle',
          id: 'sm:skinRandomizerIndicators',
          label: 'Show owned & chroma indicators',
          description: 'Fills the carousel dot for each skin you own and rings dots with an owned chroma',
          value: indicatorsEnabled,
          onChange: (val) => setIndicatorsEnabled(val),
        },
      ],
    });
  }
}

export function load() {
  injectStyles();
  if (bodyObserver) return;
  bodyObserver = new MutationObserver(scheduleCarouselUpdate);
  bodyObserver.observe(document.body, { childList: true, subtree: true });
}
