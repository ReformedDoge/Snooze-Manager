/**
 * @name Snooze-ClientWindowTweaks
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Client window tweaks: custom resolution, title, and dynamic drag bar height.
 * @link https://github.com/ReformedDoge
 */
import { t } from './i18n.js';
import Utils from './generalUtils.js';

const MODULE_KEY = 'clientWindowTweaks';
const SETTINGS_KEY = 'enabled';
const RESIZE_KEY = 'applyResolution';
const TITLE_ENABLED_KEY = 'applyTitle';
const DRAG_ENABLED_KEY = 'applyDragBar';
const WIDTH_KEY = 'width';
const HEIGHT_KEY = 'height';
const PRESET_KEY = 'preset';
const TITLE_KEY = 'title';
const DRAGBAR_KEY = 'dragBarPercentage';
const DRAGBAR_DEFAULT = 7;
const NATIVE_STATE_KEY = 'nativeWindowState';
const TITLE_DEFAULT = t('League of Legends');
const FULLSCREEN_KEY = 'fullscreenEnabled';

const PRESETS = [{
        id: 'native-426x240',
        label: t('426 x 240'),
        width: 426,
        height: 240
    },
    {
        id: 'native-640x360',
        label: t('640 x 360'),
        width: 640,
        height: 360
    },
    {
        id: 'native-854x480',
        label: t('854 x 480'),
        width: 854,
        height: 480
    },
    {
        id: 'native-960x540',
        label: t('960 x 540'),
        width: 960,
        height: 540
    },
    {
        id: 'native-1024x576',
        label: t('1024 x 576'),
        width: 1024,
        height: 576
    },
    {
        id: 'native-1152x648',
        label: t('1152 x 648'),
        width: 1152,
        height: 648
    },
    {
        id: 'native-1280x720',
        label: t('1280 x 720'),
        width: 1280,
        height: 720
    },
    {
        id: 'native-1366x768',
        label: t('1366 x 768'),
        width: 1366,
        height: 768
    },
    {
        id: 'native-1600x900',
        label: t('1600 x 900'),
        width: 1600,
        height: 900
    },
    {
        id: 'native-1920x1080',
        label: t('1920 x 1080'),
        width: 1920,
        height: 1080
    },
    {
        id: 'native-2560x1440',
        label: t('2560 x 1440'),
        width: 2560,
        height: 1440
    },
    {
        id: 'native-3200x1800',
        label: t('3200 x 1800'),
        width: 3200,
        height: 1800
    },
    {
        id: 'native-3840x2160',
        label: t('3840 x 2160'),
        width: 3840,
        height: 2160
    },
    {
        id: 'native-5120x2880',
        label: t('5120 x 2880'),
        width: 5120,
        height: 2880
    },
    {
        id: 'native-7680x4320',
        label: t('7680 x 4320'),
        width: 7680,
        height: 4320
    }
];

let isProgrammaticResize = false;
let programmaticResizeTimeout = null;

let originalVideoSettings = null;

async function cacheOriginalVideoSettings() {
    const stored = getStoreValue('originalVideoSettings', null);
    if (stored) {
        originalVideoSettings = stored;
        return;
    }
    try {
        const settings = await Utils.LCU.get('/lol-settings/v1/local/video');
        if (settings && settings.data) {
            originalVideoSettings = {
                Width: settings.data.Width,
                Height: settings.data.Height,
                ZoomScale: settings.data.ZoomScale
            };
            setStoreValue('originalVideoSettings', originalVideoSettings);
        }
    } catch (e) {}
}

async function restoreNativeVideoSettings() {
    const stored = getStoreValue('originalVideoSettings', null);
    if (stored) {
        try {
            await Utils.LCU.patch('/lol-settings/v1/local/video', {
                data: stored,
                schemaVersion: 1
            });
        } catch (e) {}
    }
}

let isEnabled = false;
let _hooksInstalled = false;
let _fullscreenKeyListener = null;

function parseNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function riotInvoke(name, params = [], callbacks = {}) {
    if (typeof window?.riotInvoke !== 'function') return;
    try {
        window.riotInvoke({
            request: JSON.stringify({
                name,
                params
            }),
            ...callbacks
        });
    } catch (err) {
        Utils.Debug.warn('[ClientWindowTweaks] riotInvoke failed:', err);
    }
}

function parseRiotInvokeObject(response) {
    try {
        const envelope = JSON.parse(response);
        return JSON.parse(envelope.result);
    } catch (err) {
        Utils.Debug.warn('[ClientWindowTweaks] failed to parse riotInvoke response:', err);
        return null;
    }
}

function cacheNativeWindowState(onSuccess) {
    const stored = getStoreValue(NATIVE_STATE_KEY, null);
    if (stored) {
        return onSuccess(stored);
    }

    riotInvoke('Window.ScreenData', [], {
        onSuccess: (response) => {
            const data = parseRiotInvokeObject(response);
            if (data && typeof data === 'object') {
                const state = {
                    width: parseNumber(data.windowWidth, 0),
                    height: parseNumber(data.windowHeight, 0),
                    x: parseNumber(data.screenX, 0),
                    y: parseNumber(data.screenY, 0)
                };
                setStoreValue(NATIVE_STATE_KEY, state);
                onSuccess(state);
            } else {
                onSuccess(null);
            }
        }
    });
}

function getNativeCefZoom(h) {
    if (h <= 576) return 0.8;
    if (h >= 900) return 1.25;
    return 1.0;
}

function applyZoom(targetWidth, targetHeight) {
    const isCollapsedCrop = document.body.classList.contains('snooze-collapsed') &&
        (Utils.Store.get('socialPanelTweaks', 'collapseMethod') === 'crop');

    const virtualWidth = isCollapsedCrop ? (1280 - 224) : 1280;

    // CEF zooms forced to 1.0, style.zoom is targetHeight / 720
    const targetCssZoom = targetHeight / 720;
    document.documentElement.style.zoom = targetCssZoom;

    const expectedRatio = isCollapsedCrop ? (virtualWidth / 720) : (16 / 9);
    if (Math.abs(targetWidth / targetHeight - expectedRatio) > 0.02) {
        document.documentElement.style.backgroundColor = '#000';
    } else {
        document.documentElement.style.backgroundColor = '';
    }
}

function clearZoom() {
    document.documentElement.style.zoom = '';
    document.documentElement.style.backgroundColor = '';
}

function centerWindow() {
    riotInvoke('Window.CenterToScreen', []);
}

function enableFreeResizing(enable) {
    Utils.Debug.log('[CWT] enableFreeResizing:', enable ? 'ENABLE' : 'DISABLE');
    if (enable) {
        riotInvoke('Mouse.SetResizeEnabled', [true]);
        riotInvoke('Mouse.SetResizeBounds', [426, 240, 7680, 4320]);
        riotInvoke('Window.SetResizeBounds', [426, 240, 7680, 4320]);
        window.addEventListener('resize', handleDynamicResize);
        Utils.Debug.log('[CWT] enableFreeResizing: resize listener ADDED');
    } else {
        riotInvoke('Mouse.SetResizeEnabled', [false]);
        window.removeEventListener('resize', handleDynamicResize);
        Utils.Debug.log('[CWT] enableFreeResizing: resize listener REMOVED');
    }
}

function handleDynamicResize() {
    Utils.Debug.log('[CWT] handleDynamicResize: FIRED, inner:', window.innerWidth, 'x', window.innerHeight, '| fullscreen:', !!document.fullscreenElement, '| progResize:', isProgrammaticResize);
    if (isProgrammaticResize) return;

    if (document.fullscreenElement) {
        const fsZoom = window.innerHeight / 720;
        document.documentElement.style.zoom = fsZoom;
        document.documentElement.style.backgroundColor = '';
        Utils.Debug.log('[CWT] handleDynamicResize: fullscreen, zoom =', fsZoom);
        return;
    }

    const targetCssZoom = window.innerHeight / 720;
    document.documentElement.style.zoom = targetCssZoom;
    Utils.Debug.log('[CWT] handleDynamicResize: set zoom to', targetCssZoom);

    const isCollapsedCrop = document.body.classList.contains('snooze-collapsed') &&
        (Utils.Store.get('socialPanelTweaks', 'collapseMethod') === 'crop');
    const virtualWidth = isCollapsedCrop ? (1280 - 224) : 1280;

    const physicalWidth = Math.round(window.innerWidth * targetCssZoom);
    const physicalHeight = Math.round(window.innerHeight * targetCssZoom);
    const expectedRatio = isCollapsedCrop ? (virtualWidth / 720) : (16 / 9);

    if (Math.abs(physicalWidth / physicalHeight - expectedRatio) > 0.02) {
        document.documentElement.style.backgroundColor = '#000';
        Utils.Debug.log('[CWT] handleDynamicResize: letterbox ON');
    } else {
        document.documentElement.style.backgroundColor = '';
        Utils.Debug.log('[CWT] handleDynamicResize: letterbox OFF');
    }

    const dragEnabled = getStoreValue(DRAG_ENABLED_KEY, true);
    const dragBarPct = parseNumber(getStoreValue(DRAGBAR_KEY, DRAGBAR_DEFAULT));
    if (isEnabled && dragEnabled && dragBarPct >= 0) {
        const activeHeight = window.outerHeight || physicalHeight || 720;
        const dragBarPixels = Math.round((dragBarPct / 100) * activeHeight);
        Utils.Debug.log('[CWT] handleDynamicResize: set dragBar to', dragBarPixels);
        riotInvoke('Mouse.SetDragBarHeight', [dragBarPixels]);
    }
}

function restoreNativeWindowState() {
    clearZoom();

    const state = getStoreValue(NATIVE_STATE_KEY, null);
    if (!state) return;

    if (state.width > 0 && state.height > 0) {
        riotInvoke('Window.ResizeTo', [state.width, state.height]);
    }

    centerWindow();
}

function restoreTitle() {
    riotInvoke('Window.SetTitle', [TITLE_DEFAULT]);
}

function restoreDragBar() {
    riotInvoke('Mouse.SetDragBarHeight', [48]);
}

function restoreAllNativeSettings() {
    enableFreeResizing(false);
    restoreNativeWindowState();
    restoreNativeVideoSettings();
    restoreTitle();
    restoreDragBar();
    uninstallFullscreenListener();
    delete window.__snoozeTargetResolution;
}

let _fullscreenChangeHandler = null;

function installFullscreenListener() {
    if (_fullscreenKeyListener) return;
    _fullscreenKeyListener = (e) => {
        if (e.key === 'F11') {
            e.preventDefault();
            e.stopPropagation();
            Utils.Debug.log('[CWT] fullscreenKeyListener: F11 pressed, fullscreenElement =', !!document.fullscreenElement);
            if (document.fullscreenElement) {
                document.exitFullscreen().catch(() => {});
            } else {
                document.documentElement.requestFullscreen().catch(() => {});
            }
        }
    };
    document.addEventListener('keydown', _fullscreenKeyListener, true);

    if (!_fullscreenChangeHandler) {
        _fullscreenChangeHandler = () => {
            Utils.Debug.log('[CWT] fullscreenchange: fullscreenElement =', !!document.fullscreenElement, '| inner:', window.innerWidth, 'x', window.innerHeight);
        };
        document.addEventListener('fullscreenchange', _fullscreenChangeHandler);
    }
}

function uninstallFullscreenListener() {
    if (!_fullscreenKeyListener) return;
    document.removeEventListener('keydown', _fullscreenKeyListener, true);
    _fullscreenKeyListener = null;
    if (_fullscreenChangeHandler) {
        document.removeEventListener('fullscreenchange', _fullscreenChangeHandler);
        _fullscreenChangeHandler = null;
    }
    if (document.fullscreenElement) {
        Utils.Debug.log('[CWT] uninstallFullscreenListener: EXIT fullscreen');
        document.exitFullscreen().catch(() => {});
    }
}

function applyWindowSize(width, height) {
    if (width <= 0 || height <= 0) return;
    window.__snoozeTargetResolution = {
        w: width,
        h: height
    };

    isProgrammaticResize = true;
    if (programmaticResizeTimeout) clearTimeout(programmaticResizeTimeout);

    programmaticResizeTimeout = setTimeout(() => {
        isProgrammaticResize = false;
    }, 1000); // Reset flag after 1 second

    cacheNativeWindowState(async () => {
        const isCollapsedCrop = document.body.classList.contains('snooze-collapsed') &&
            (Utils.Store.get('socialPanelTweaks', 'collapseMethod') === 'crop');

        let targetWidth = width;
        let targetHeight = height;

        if (isCollapsedCrop) {
            const ratioCollapsed = (1280 - 224) / 720;
            targetWidth = Math.round(height * ratioCollapsed);
        }

        // Force the native settings to 1280x720 (ZoomScale: 1.0) natively
        try {
            await Utils.LCU.patch('/lol-settings/v1/local/video', {
                data: {
                    "ZoomScale": 1
                },
                schemaVersion: 1
            });
        } catch (err) {
            Utils.Debug.warn('[ClientWindowTweaks] Failed to reset native video settings:', err);
        }

        // riotInvoke call
        riotInvoke('Window.ResizeTo', [targetWidth, targetHeight]);
        applyZoom(targetWidth, targetHeight);
        centerWindow();

        // set the drag bar height based on the targetHeight
        const dragEnabled = getStoreValue(DRAG_ENABLED_KEY, true);
        const dragBarPct = parseNumber(getStoreValue(DRAGBAR_KEY, DRAGBAR_DEFAULT));
        if (dragEnabled && dragBarPct >= 0) {
            const dragBarPixels = Math.round((dragBarPct / 100) * targetHeight);
            riotInvoke('Mouse.SetDragBarHeight', [dragBarPixels]);
        }
    });
}

function setStoreValue(key, value) {
    Utils.Store.set(MODULE_KEY, key, value);
}

function getStoreValue(key, fallback = undefined) {
    const value = Utils.Store.get(MODULE_KEY, key);
    return value === undefined ? fallback : value;
}

function getSelectedPreset() {
    const stored = getStoreValue(PRESET_KEY, PRESETS[0].id);
    return PRESETS.find(p => p.id === stored) || PRESETS[0];
}

function updatePreset(presetId) {
    const preset = PRESETS.find(p => p.id === presetId);
    if (!preset) return;
    setStoreValue(PRESET_KEY, preset.id);
    if (preset.id !== 'custom') {
        setStoreValue(WIDTH_KEY, preset.width);
        setStoreValue(HEIGHT_KEY, preset.height);
    }
}

function applySettings() {
    if (!isEnabled) return;

    const title = String(getStoreValue(TITLE_KEY, '') || '').trim();
    const width = parseNumber(getStoreValue(WIDTH_KEY, 0));
    const height = parseNumber(getStoreValue(HEIGHT_KEY, 0));
    const dragBarPct = parseNumber(getStoreValue(DRAGBAR_KEY, DRAGBAR_DEFAULT));

    const resizeEnabled = getStoreValue(RESIZE_KEY, true);
    const titleEnabled = getStoreValue(TITLE_ENABLED_KEY, true);
    const dragEnabled = getStoreValue(DRAG_ENABLED_KEY, true);

    if (resizeEnabled && width > 0 && height > 0) {
        enableFreeResizing(true);
        applyWindowSize(width, height);
    } else {
        enableFreeResizing(false);
        restoreNativeWindowState();

        // Set drag bar based on live window state
        if (dragEnabled && dragBarPct >= 0) {
            riotInvoke('Window.ScreenData', [], {
                onSuccess: (response) => {
                    const data = parseRiotInvokeObject(response);
                    const activeHeight = (data && data.windowHeight) ? data.windowHeight : (window.outerHeight || 720);
                    const dragBarPixels = Math.round((dragBarPct / 100) * activeHeight);
                    riotInvoke('Mouse.SetDragBarHeight', [dragBarPixels]);
                }
            });
        } else if (!dragEnabled) {
            restoreDragBar();
        }
    }

    if (titleEnabled && title) {
        riotInvoke('Window.SetTitle', [title]);
    } else if (!titleEnabled) {
        restoreTitle();
    }

    const fullscreenEnabled = getStoreValue(FULLSCREEN_KEY, false);
    if (fullscreenEnabled) {
        installFullscreenListener();
    } else {
        uninstallFullscreenListener();
    }
}

// The League client's LayerWindowController observes /lol-settings/v1/local/video
// for ZoomScale changes via the WS dispatcher. When it fires (e.g. user opens video
// settings, or client startup reads settings), it resets the CSS zoom applied by
// applyZoom() call. We intercept both the inbound WS push and outbound XHR PUT to
// keep our zoom value in place while the module is enabled.
function getCurrentTargetZoom() {
    const resizeEnabled = isEnabled && getStoreValue(RESIZE_KEY, true);
    const w = parseNumber(getStoreValue(WIDTH_KEY, 0));
    const h = parseNumber(getStoreValue(HEIGHT_KEY, 0));

    if (resizeEnabled && w > 0 && h > 0) {
        return h / 720;
    }

    return null;
}

function installSettingsHooks(context) {
    if (_hooksInstalled) return;
    _hooksInstalled = true;

    Utils.Hooks.WS.install(context);

    // Inbound WS: Inject custom ZoomScale into native settings push
    // client's own zoom-application code uses our value instead of the stored one.
    Utils.Hooks.WS.hook('/lol-settings/v1/local/video', (endpoint, payload) => {
        const targetZoom = getCurrentTargetZoom();
        if (targetZoom !== null && payload?.data) {
            return {
                ...payload,
                data: {
                    ...payload.data,
                    ZoomScale: targetZoom
                }
            };
        }
        return payload;
    });

    // Outbound XHR PUT: if something in the client writes new video settings
    // (e.g. user changes a non-resolution setting), keep our ZoomScale in the body
    // so the round-trip doesn't revert the zoom.
    // No longer needed no push method. ignore
    Utils.Hooks.Xhr.hookReq('/lol-settings/v1/local/video', (method, url, xhr, body) => {
        if (method !== 'PUSH' && method !== 'push') return body;
        const targetZoom = getCurrentTargetZoom();
        if (targetZoom !== null) {
            let parsed;
            try {
                parsed = JSON.parse(body);
            } catch {
                return body;
            }
            parsed.ZoomScale = targetZoom;
            return JSON.stringify(parsed);
        }
        return body;
    });

    // Outbound Fetch: same guard for any fetch-based callers.
    Utils.Hooks.Fetch.hookRes(/\/lol-settings\/v1\/local\/video/, (text) => {
        const targetZoom = getCurrentTargetZoom();
        if (targetZoom !== null) {
            try {
                const data = JSON.parse(text);
                if (data && typeof data === 'object') {
                    data.ZoomScale = targetZoom;
                    return JSON.stringify(data);
                }
            } catch {}
        }
        return text;
    });
}

function createLabeledInput(labelText, inputElement) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.flexDirection = 'column';
    row.style.gap = '4px';

    const label = document.createElement('div');
    label.textContent = labelText;
    label.style.color = '#f0e6d2';
    label.style.fontSize = '12px';
    label.style.fontWeight = '600';

    row.appendChild(label);
    row.appendChild(inputElement);
    return row;
}

function renderSettings(container, showMasterToggle = true) {
    container.style.display = 'flex';
    container.style.flexDirection = 'column';
    container.style.alignItems = 'stretch';
    container.style.gap = '12px';
    container.style.paddingLeft = '20px';
    container.style.marginTop = '0';
    container.style.borderLeft = '2px solid #3e2e13';

    const settingsEnabled = getStoreValue(SETTINGS_KEY, false);
    const resizeEnabled = getStoreValue(RESIZE_KEY, true);
    const titleEnabled = getStoreValue(TITLE_ENABLED_KEY, true);
    const dragEnabled = getStoreValue(DRAG_ENABLED_KEY, true);
    const preset = getSelectedPreset();

    const width = parseNumber(getStoreValue(WIDTH_KEY, preset.width || 0));
    const height = parseNumber(getStoreValue(HEIGHT_KEY, preset.height || 0));
    const title = String(getStoreValue(TITLE_KEY, ''));
    const dragBarPct = parseNumber(getStoreValue(DRAGBAR_KEY, DRAGBAR_DEFAULT));

    if (showMasterToggle) {
        container.appendChild(Utils.Settings.createToggleRow(t('Enable Client Window Tweaks'), settingsEnabled, (next) => {
            setStoreValue(SETTINGS_KEY, next);
            isEnabled = next;
            if (next) {
                applySettings();
            } else {
                restoreAllNativeSettings();
            }
        }));
    }

    const sectionToggleRow = document.createElement('div');
    sectionToggleRow.style.display = 'grid';
    sectionToggleRow.style.gridTemplateColumns = '1fr 1fr';
    sectionToggleRow.style.gap = '10px';

    const resolutionToggle = Utils.Settings.createToggleRow(t('Apply Resolution'), resizeEnabled, (next) => {
        setStoreValue(RESIZE_KEY, next);
        if (isEnabled) {
            if (next) {
                applySettings();
            } else {
                restoreNativeWindowState();
            }
        }
    });

    const titleToggle = Utils.Settings.createToggleRow(t('Apply Title'), titleEnabled, (next) => {
        setStoreValue(TITLE_ENABLED_KEY, next);
        if (isEnabled) {
            if (next) {
                applySettings();
            } else {
                restoreTitle();
            }
        }
    });

    const dragToggle = Utils.Settings.createToggleRow(t('Apply Drag Bar'), dragEnabled, (next) => {
        setStoreValue(DRAG_ENABLED_KEY, next);
        if (isEnabled) {
            if (next) {
                applySettings();
            } else {
                restoreDragBar();
            }
        }
    });

    const fullscreenToggle = Utils.Settings.createToggleRow(t('Enable Fullscreen (F11)'), getStoreValue(FULLSCREEN_KEY, false), (next) => {
        setStoreValue(FULLSCREEN_KEY, next);
        if (isEnabled) {
            if (next) installFullscreenListener();
            else uninstallFullscreenListener();
        }
    });

    sectionToggleRow.appendChild(resolutionToggle);
    sectionToggleRow.appendChild(titleToggle);
    sectionToggleRow.appendChild(dragToggle);
    sectionToggleRow.appendChild(fullscreenToggle);
    container.appendChild(sectionToggleRow);

    const presetRow = document.createElement('div');
    Object.assign(presetRow.style, {
        display: 'flex',
        alignItems: 'center',
        gap: '10px'
    });

    const presetLabel = document.createElement('span');
    presetLabel.textContent = t('Resolution Preset');
    Object.assign(presetLabel.style, {
        color: '#a09b8c',
        fontSize: '12px',
        whiteSpace: 'nowrap'
    });

    const presetSelect = document.createElement('select');
    Object.assign(presetSelect.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        padding: '6px',
        borderRadius: '2px',
        minWidth: '170px',
        outline: 'none'
    });
    PRESETS.forEach((presetOption) => {
        const opt = document.createElement('option');
        opt.value = presetOption.id;
        opt.textContent = presetOption.label;
        presetSelect.appendChild(opt);
    });
    presetSelect.value = preset.id;
    presetSelect.addEventListener('change', () => {
        updatePreset(presetSelect.value);
        widthInput.value = String(parseNumber(getStoreValue(WIDTH_KEY, 0)));
        heightInput.value = String(parseNumber(getStoreValue(HEIGHT_KEY, 0)));
        if (Utils.Store.get(MODULE_KEY, SETTINGS_KEY)) applySettings();
    });

    presetRow.appendChild(presetLabel);
    presetRow.appendChild(presetSelect);
    container.appendChild(presetRow);

    const widthInput = document.createElement('input');
    widthInput.type = 'number';
    widthInput.min = '1';
    widthInput.step = '1';
    widthInput.value = String(width || '');
    Object.assign(widthInput.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        borderRadius: '2px',
        padding: '6px',
        width: '100px'
    });
    widthInput.addEventListener('change', () => {
        const value = parseNumber(widthInput.value);
        setStoreValue(WIDTH_KEY, value);
        if (Utils.Store.get(MODULE_KEY, SETTINGS_KEY) && getStoreValue(RESIZE_KEY, true)) applySettings();
    });

    const heightInput = document.createElement('input');
    heightInput.type = 'number';
    heightInput.min = '1';
    heightInput.step = '1';
    heightInput.value = String(height || '');
    Object.assign(heightInput.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        borderRadius: '2px',
        padding: '6px',
        width: '100px'
    });
    heightInput.addEventListener('change', () => {
        const value = parseNumber(heightInput.value);
        setStoreValue(HEIGHT_KEY, value);
        if (Utils.Store.get(MODULE_KEY, SETTINGS_KEY) && getStoreValue(RESIZE_KEY, true)) applySettings();
    });

    const sizeRow = document.createElement('div');
    sizeRow.style.display = 'flex';
    sizeRow.style.alignItems = 'center';
    sizeRow.style.gap = '10px';
    sizeRow.appendChild(createLabeledInput(t('Width'), widthInput));
    sizeRow.appendChild(createLabeledInput(t('Height'), heightInput));
    container.appendChild(sizeRow);

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.value = title;
    Object.assign(titleInput.style, {
        background: '#111',
        color: '#f0e6d2',
        border: '1px solid #3e2e13',
        borderRadius: '2px',
        padding: '6px',
        width: '95%',
        boxSizing: 'border-box'
    });
    titleInput.addEventListener('change', () => {
        setStoreValue(TITLE_KEY, titleInput.value.trim());
        if (Utils.Store.get(MODULE_KEY, SETTINGS_KEY) && getStoreValue(TITLE_ENABLED_KEY, true)) applySettings();
    });
    container.appendChild(createLabeledInput(t('Client title'), titleInput));

    const dragInputContainer = document.createElement('div');
    dragInputContainer.style.display = 'flex';
    dragInputContainer.style.alignItems = 'center';
    dragInputContainer.style.gap = '12px';

    const dragInput = document.createElement('input');
    dragInput.type = 'range';
    dragInput.min = '0';
    dragInput.max = '100';
    dragInput.step = '1';
    dragInput.value = String(dragBarPct);
    dragInput.style.flexGrow = '1';
    dragInput.style.cursor = 'pointer';

    const dragValueDisplay = document.createElement('span');
    dragValueDisplay.textContent = `${dragInput.value}%`;
    dragValueDisplay.style.color = '#f0e6d2';
    dragValueDisplay.style.fontSize = '13px';
    dragValueDisplay.style.width = '40px';

    dragInput.addEventListener('input', () => {
        dragValueDisplay.textContent = `${dragInput.value}%`;
    });

    dragInput.addEventListener('change', () => {
        const value = parseNumber(dragInput.value);
        setStoreValue(DRAGBAR_KEY, value);
        if (Utils.Store.get(MODULE_KEY, SETTINGS_KEY) && getStoreValue(DRAG_ENABLED_KEY, true)) applySettings();
    });

    dragInputContainer.appendChild(dragInput);
    dragInputContainer.appendChild(dragValueDisplay);

    container.appendChild(createLabeledInput(t('Drag bar height (%)'), dragInputContainer));

    container.appendChild(Utils.Settings.createInfoBox(t('Settings are applied when enabled and when values change.')));
}

export function init(context) {
    installSettingsHooks(context);

    Utils.Settings.inject(context, {
        name: 'client-window-tweaks-settings',
        titleKey: 'snooze_client-window-tweaks',
        titleName: t('Client Window Tweaks'),
        capitalTitleKey: 'snooze_client-window-tweaks_capital',
        capitalTitleName: t('CLIENT WINDOW TWEAKS'),
        class: 'client-window-tweaks-settings'
    });

    isEnabled = Utils.Store.get(MODULE_KEY, SETTINGS_KEY) || false;

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'clientWindowTweaks',
            name: t('Client Window Tweaks'),
            description: t('Apply custom client resolution presets, title, and drag-area height on startup or any time.'),
            settings: [{
                    type: 'toggle',
                    id: SETTINGS_KEY,
                    label: t('Enable Client Window Tweaks'),
                    value: isEnabled,
                    onChange: (val) => {
                        isEnabled = val;
                        setStoreValue(SETTINGS_KEY, val);
                        if (val) {
                            applySettings();
                        } else {
                            restoreAllNativeSettings();
                        }
                    }
                },
                {
                    type: 'custom',
                    render: (row) => renderSettings(row, false)
                }
            ]
        });
    } else {
        Utils.DOM.observer.observe('lol-uikit-scrollable.client-window-tweaks-settings', (plugin) => {
            const row = document.createElement('div');
            row.classList.add('plugins-settings-row');
            row.style.display = 'flex';
            row.style.flexDirection = 'column';
            row.style.gap = '12px';
            row.style.padding = '10px 0';
            renderSettings(row);
            plugin.appendChild(row);
        });
    }
}

export function load() {
    cacheOriginalVideoSettings();

    if (isEnabled) {
        applySettings();
    }
}