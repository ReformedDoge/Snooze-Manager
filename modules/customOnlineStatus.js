/**
 * @name Snooze-customOnlineStatus
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Adds custom chat availability and status message controls.
 * @link https://github.com/ReformedDoge
 */
import Utils from './generalUtils.js';
import { t } from './i18n.js';

let isEnabled = false;
let statusMenu = null;
let statusMsgInput = null;
let documentClickHandlerAttached = false;

// Push the desired status to /me
async function syncAvailability() {
    if (!Utils.Store.get('customOnlineStatus', 'enabled') || !Utils.LCU) return;
    try {
        await Utils.LCU.put('/lol-chat/v1/me', {
            availability: Utils.Store.get('customOnlineStatus', 'status') || 'chat',
            statusMessage: Utils.Store.get('customOnlineStatus', 'statusMsg') || ''
        });
    } catch (e) {}
}

// Install WS + XHR hooks so the status stays locked even when the client resets it.
// Called once from init(). safe to call multiple times (hooks are registered once).
let _hooksInstalled = false;
let _emberHookInstalled = false;

function installHooks(context) {
    if (_hooksInstalled) return;
    _hooksInstalled = true;

    // Inbound WS hook 
    // Intercept server push of /lol-chat/v1/me to lock status UI.
    Utils.Hooks.WS.install(context);
    Utils.Hooks.WS.hook('/lol-chat/v1/me', (endpoint, payload) => {
        if (!isEnabled) return payload;
        if (!payload || typeof payload !== 'object') return payload;

        const desired = Utils.Store.get('customOnlineStatus', 'status') || 'chat';
        const desiredMsg = Utils.Store.get('customOnlineStatus', 'statusMsg') || '';

        const patched = {
            ...payload
        };
        if (patched.availability !== undefined) patched.availability = desired;
        if (patched.statusMessage !== undefined) patched.statusMessage = desiredMsg;
        return patched;
    });

    // Outbound XHR hook 
    // When the client sends a PUT /lol-chat/v1/me (e.g. entering lobby, post-game),
    // rewrite the body to keep our desired availability & statusMessage.
    Utils.Hooks.Xhr.hookReq('/lol-chat/v1/me', (method, url, xhr, body) => {
        if (method !== 'PUT' && method !== 'put') return body;
        if (!isEnabled) return body;

        let parsed;
        try {
            parsed = JSON.parse(body);
        } catch {
            return body;
        }

        const desired = Utils.Store.get('customOnlineStatus', 'status') || 'chat';
        const desiredMsg = Utils.Store.get('customOnlineStatus', 'statusMsg') || '';

        if (parsed.availability !== undefined) parsed.availability = desired;
        if (parsed.statusMessage !== undefined) parsed.statusMessage = desiredMsg;
        return JSON.stringify(parsed);
    });
}

function installEmberHook() {
    if (_emberHookInstalled) return;
    _emberHookInstalled = true;

    Utils.Hooks.Ember.registerRule({
        name: 'custom-online-status-identity',
        matcher: 'lol-social-identity',
        hookMethods: [{
            name: 'didInsertElement',
            callback(Ember, original, ...args) {
                original(...args);
                const hitbox = this.element.querySelector('.lol-social-availability-hitbox');
                if (hitbox && !hitbox.hasAttribute('data-pm-status-menu-hook')) {
                    hitbox.setAttribute('data-pm-status-menu-hook', 'true');
                    hitbox.addEventListener('click', (e) => {
                        const currentEnabled = Utils.Store.get('customOnlineStatus', 'enabled');
                        if (!currentEnabled) return;
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        const customMenu = getStatusMenu();
                        const r = hitbox.getBoundingClientRect();
                        customMenu.style.left = 'auto';
                        customMenu.style.right = (window.innerWidth - r.right) + 'px';
                        customMenu.style.top = (r.bottom + 5) + 'px';
                        customMenu.style.display = 'block';
                        if (Utils.LCU) {
                            Utils.LCU.get('/lol-chat/v1/me').then(me => {
                                if (me && statusMsgInput) statusMsgInput.value = me.statusMessage || '';
                            }).catch(() => {});
                        }
                    }, true);
                }
            }
        }]
    });
}

function cleanupDuplicateMenus(keep) {
    document.querySelectorAll('#pm-status-menu').forEach((menu) => {
        if (menu !== keep) menu.remove();
    });
}

function getStatusMenu() {
    if (statusMenu && document.body.contains(statusMenu)) {
        cleanupDuplicateMenus(statusMenu);
        return statusMenu;
    }

    document.querySelectorAll('#pm-status-menu').forEach((menu) => menu.remove());

    const customMenu = document.createElement('div');
    customMenu.id = 'pm-status-menu';
    Object.assign(customMenu.style, {
        position: 'fixed',
        minWidth: '160px',
        background: 'rgba(1,10,19,0.97)',
        border: '1px solid #785a28',
        borderRadius: '3px',
        boxShadow: '0 8px 24px rgba(0,0,0,0.7)',
        zIndex: '999999',
        display: 'none',
        padding: '6px',
        pointerEvents: 'auto',
        color: '#a09b8c',
        fontSize: '12px'
    });
    document.body.appendChild(customMenu);

    const opts = [{
            v: 'chat',
            l: t('Online (Green)'),
            d: '#43b581'
        },
        {
            v: 'away',
            l: t('Away (Red)'),
            d: '#f04747'
        },
        {
            v: 'dnd',
            l: t('Do Not Disturb (Yellow)'),
            d: '#faa61a'
        },
        {
            v: 'mobile',
            l: t('Mobile (Green)'),
            d: '#43b581'
        },
        {
            v: 'offline',
            l: t('Offline (Gray)'),
            d: '#747f8d'
        }
    ];

    opts.forEach(o => {
        const item = document.createElement('div');
        Object.assign(item.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '6px 12px',
            cursor: 'pointer',
            transition: '0.2s',
            borderRadius: '2px'
        });
        item.innerHTML = `<span style="width:8px;height:8px;border-radius:50%;background:${o.d}"></span><span>${o.l}</span>`;
        item.onmouseover = () => item.style.background = 'rgba(200,170,110,0.15)';
        item.onmouseout = () => item.style.background = 'none';
        item.onclick = async (ev) => {
            ev.stopPropagation();
            customMenu.style.display = 'none';
            try {
                Utils.Store.set('customOnlineStatus', 'status', o.v);
                if (Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                    await Utils.LCU.put('/lol-chat/v1/me', {
                        availability: o.v
                    });
                }
            } catch (err) {}
        };
        customMenu.appendChild(item);
    });

    const inputWrap = document.createElement('div');
    Object.assign(inputWrap.style, {
        padding: '6px 4px 0',
        marginTop: '4px',
        borderTop: '1px solid #3e2e13'
    });
    statusMsgInput = document.createElement('textarea');
    statusMsgInput.setAttribute('data-pm-status-message', 'true');
    statusMsgInput.placeholder = t('Custom Status Message...');
    Object.assign(statusMsgInput.style, {
        width: '100%',
        background: '#111',
        border: '1px solid #785a28',
        color: '#f0e6d2',
        padding: '6px 10px',
        borderRadius: '2px',
        outline: 'none',
        boxSizing: 'border-box',
        resize: 'vertical',
        minHeight: '60px',
        fontFamily: 'inherit',
        fontSize: '13px'
    });
    statusMsgInput.onchange = async (ev) => {
        try {
            Utils.Store.set('customOnlineStatus', 'statusMsg', ev.target.value);
            if (Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                await Utils.LCU.put('/lol-chat/v1/me', {
                    statusMessage: ev.target.value
                });
            }
        } catch (err) {}
    };
    statusMsgInput.onclick = (ev) => ev.stopPropagation();
    inputWrap.appendChild(statusMsgInput);
    customMenu.appendChild(inputWrap);

    statusMenu = customMenu;
    return statusMenu;
}

function toggleFeature(enabled) {
    isEnabled = enabled;
    Utils.Store.set('customOnlineStatus', 'enabled', enabled);
    if (!enabled) {
        const menu = statusMenu || document.getElementById('pm-status-menu');
        if (menu) menu.style.display = 'none';
    } else {
        // Force a sync immediately when turned ON
        syncAvailability();
    }
}



export function init(context) {
    isEnabled = Utils.Store.get('customOnlineStatus', 'enabled') || false;
    installHooks(context);

    Utils.Settings.inject(context, {
        name: "custom-status-settings",
        titleKey: "snooze_custom-status",
        titleName: t("Custom Status"),
        capitalTitleKey: "snooze_custom-status_capital",
        capitalTitleName: t("CUSTOM STATUS"),
        class: "custom-status-settings"
    });

    if (window.SnoozeManager && window.SnoozeManager.registerModule) {
        window.SnoozeManager.registerModule({
            id: 'customOnlineStatus',
            name: t('Custom Online Status'),
            description: t('Overrides your online status indicator. Menu available by clicking the availability icon under your icon.'),
            settings: [{
                    type: 'toggle',
                    id: 'sm:customOnlineStatus',
                    label: t('Enable Custom Online Status'),
                    value: isEnabled,
                    onChange: (val) => toggleFeature(val)
                },
                {
                    type: 'select',
                    id: 'sm:customStatus',
                    value: Utils.Store.get('customOnlineStatus', 'status') || 'chat',
                    options: [{
                            value: 'chat',
                            label: t('Online (Green)')
                        },
                        {
                            value: 'away',
                            label: t('Away (Red)')
                        },
                        {
                            value: 'dnd',
                            label: t('Do Not Disturb (Yellow)')
                        },
                        {
                            value: 'mobile',
                            label: t('Mobile (Green)')
                        },
                        {
                            value: 'offline',
                            label: t('Offline (Gray)')
                        }
                    ],
                    onChange: async (val) => {
                        Utils.Store.set('customOnlineStatus', 'status', val);
                        if (Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                            await Utils.LCU.put('/lol-chat/v1/me', {
                                availability: val
                            });
                        }
                    }
                },
                {
                    type: 'textarea',
                    id: 'sm:customStatusMsg',
                    placeholder: t('Custom Status Message...'),
                    value: Utils.Store.get('customOnlineStatus', 'statusMsg') || '',
                    onChange: async (val) => {
                        Utils.Store.set('customOnlineStatus', 'statusMsg', val);
                        if (Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                            await Utils.LCU.put('/lol-chat/v1/me', {
                                statusMessage: val
                            });
                        }
                    }
                }
            ]
        });
    } else {
        // Inject UI into native settings panel
        Utils.DOM.observer.observe("lol-uikit-scrollable.custom-status-settings", (plugin) => {
            plugin.innerHTML = '';
            plugin.appendChild(Utils.Settings.createToggleRow(t("Enable Custom Online Status"), isEnabled, async (next) => {
                isEnabled = next;
                Utils.Store.set('customOnlineStatus', 'enabled', isEnabled);
                await toggleFeature(isEnabled);
            }));

            // Native UI Fallback for Select and Textarea
            const selectRow = document.createElement("div");
            selectRow.classList.add("plugins-settings-row");
            selectRow.style.marginTop = "10px";
            const statusSelect = document.createElement("select");
            Object.assign(statusSelect.style, {
                background: '#111',
                color: '#f0e6d2',
                border: '1px solid #3e2e13',
                padding: '6px',
                borderRadius: '2px',
                outline: 'none',
                width: '100%'
            });
            const opts = [{
                v: 'chat',
                l: t('Online (Green)')
            }, {
                v: 'away',
                l: t('Away (Red)')
            }, {
                v: 'dnd',
                l: t('Do Not Disturb (Yellow)')
            }, {
                v: 'mobile',
                l: t('Mobile (Green)')
            }, {
                v: 'offline',
                l: t('Offline (Gray)')
            }];
            opts.forEach(o => {
                const opt = document.createElement('option');
                opt.value = o.v;
                opt.textContent = o.l;
                statusSelect.appendChild(opt);
            });
            statusSelect.value = Utils.Store.get('customOnlineStatus', 'status') || 'chat';
            statusSelect.addEventListener('change', async (e) => {
                Utils.Store.set('customOnlineStatus', 'status', e.target.value);
                if (Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                    await Utils.LCU.put('/lol-chat/v1/me', {
                        availability: e.target.value
                    });
                }
            });
            selectRow.appendChild(statusSelect);
            plugin.appendChild(selectRow);

            const textRow = document.createElement("div");
            textRow.classList.add("plugins-settings-row");
            textRow.style.marginTop = "10px";
            const statusInput = document.createElement('textarea');
            statusInput.placeholder = t('Custom Status Message...');
            Object.assign(statusInput.style, {
                background: '#111',
                color: '#f0e6d2',
                border: '1px solid #3e2e13',
                padding: '6px 10px',
                borderRadius: '2px',
                outline: 'none',
                boxSizing: 'border-box',
                width: '100%',
                minHeight: '60px',
                resize: 'vertical',
                fontFamily: 'inherit',
                fontSize: '13px'
            });
            statusInput.value = Utils.Store.get('customOnlineStatus', 'statusMsg') || '';
            statusInput.addEventListener('change', async (e) => {
                Utils.Store.set('customOnlineStatus', 'statusMsg', e.target.value);
                if (Utils.Store.get('customOnlineStatus', 'enabled') && Utils.LCU) {
                    await Utils.LCU.put('/lol-chat/v1/me', {
                        statusMessage: e.target.value
                    });
                }
            });
            textRow.appendChild(statusInput);
            plugin.appendChild(textRow);
        });
    }

}

export function load() {
    cleanupDuplicateMenus(statusMenu);

    if (!documentClickHandlerAttached) {
        documentClickHandlerAttached = true;
        document.addEventListener('click', (e) => {
            const menu = statusMenu || document.getElementById('pm-status-menu');
            if (menu && !menu.contains(e.target)) menu.style.display = 'none';
        });
    }

    installEmberHook();

    // Apply saved status to the server on load
    syncAvailability();
}