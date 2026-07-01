/**
 * @name Snooze-GeneralUtils
 * @version 1.0.0
 * @author SnoozeFest - github@ReformedDoge
 * @description Shared helper utilities used by Snooze modules.
 * @link https://github.com/ReformedDoge
 */

// Debug is exposed via Utils (Utils.Debug)

const _debugState = { enabled: false };
function setDebugEnabled(v) { _debugState.enabled = !!v; }
const Debug = {
  setEnabled: setDebugEnabled,
  log(...args) { if (!_debugState.enabled) return; console.log(...args); },
  info(...args) { if (!_debugState.enabled) return; console.info(...args); },
  warn(...args) { if (!_debugState.enabled) return; console.warn(...args); },
  error(...args) { if (!_debugState.enabled) return; console.error(...args); }
};

/**
 * Smart DOM observer:
 * - Runs callbacks only for matching selectors
 * - Deduplicates elements (runs once per element)
 * - Batches mutations using requestAnimationFrame
 */
 
function createSmartObserver(root = document.documentElement) {
    const registry = new Map(); // selector -> Set<{ callback, seen }>
    let scheduled = false;
    let pendingNodes = new Set();
    let observing = false;

    const observer = new MutationObserver((mutations) => {
        if (registry.size === 0) return;
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    pendingNodes.add(node);
                }
            }
        }

        if (scheduled) return;
        scheduled = true;

        requestAnimationFrame(() => {
            scheduled = false;

            const nodes = pendingNodes;
            pendingNodes = new Set();

            for (const node of nodes) {
                processNode(node);
            }
        });
    });

    function ensureObserving() {
        if (observing) return;
        observer.observe(root, {
            childList: true,
            subtree: true
        });
        observing = true;
    }

    function stopIfIdle() {
        if (registry.size > 0 || !observing) return;
        observer.disconnect();
        observing = false;
        pendingNodes = new Set();
        scheduled = false;
    }

    function processNode(node) {
        if (registry.size === 0) return;
        for (const [selector, entries] of registry.entries()) {
            for (const entry of entries) {
                const { callback, seen } = entry;

                // Direct match
                if (node.matches?.(selector) && !seen.has(node)) {
                    seen.add(node);
                    safeCall(callback, node);
                }

                // Descendants
                const matches = node.querySelectorAll?.(selector);
                if (matches && matches.length) {
                    for (const el of matches) {
                        if (seen.has(el)) continue;
                        seen.add(el);
                        safeCall(callback, el);
                    }
                }
            }
        }
    }

    function safeCall(cb, el) {
        try {
            cb(el);
        } catch (e) {
          Debug.error("SmartObserver error:", e);
        }
    }

    function observe(selector, callback) {
        if (!registry.has(selector)) registry.set(selector, new Set());
        ensureObserving();

        const entry = {
            callback,
            seen: new WeakSet()
        };
        registry.get(selector).add(entry);

        // Run immediately for existing elements within the observed root
        root.querySelectorAll(selector).forEach(el => {
            if (!entry.seen.has(el)) {
                entry.seen.add(el);
                safeCall(callback, el);
            }
        });

        return () => {
            const entries = registry.get(selector);
            if (!entries) return;
            entries.delete(entry);
            if (entries.size === 0) registry.delete(selector);
            stopIfIdle();
        };
    }

    return {
        observe,
        disconnect: () => {
            registry.clear();
            observer.disconnect();
            observing = false;
            pendingNodes = new Set();
            scheduled = false;
        }
    };
}
/** Shared singleton observer for all modules */
const observer = createSmartObserver();

/**
 * Ember Hook
 */

const EmberHook = window.__SM_EmberHook || (window.__SM_EmberHook = {
  _rules: [],
  _installed: false,
  _wrappedMark: Symbol('SnoozeEmberWrapped'),
  _appliedRulesKey: '__snoozeAppliedRules',
  _retroKey: '__sm_retro_applied',

  install(context) {
    if (this._installed) {
      Debug.warn('[EmberHook] Already installed');
      return;
    }
    this._installed = true;

    // Try sync Ember first (eager modules), fall back to async Promise (lazy modules).
    context.rcp.postInit('rcp-fe-ember-libs', (api) => {
      const emberLibs = api;
      if (!emberLibs || typeof emberLibs.getEmber !== 'function') {
        Debug.warn('[EmberHook] rcp-fe-ember-libs has no getEmber');
        return;
      }

      const hookEmber = (Ember) => {
        if (!Ember || !Ember.Component) return;
        if (!emberLibs[this._wrappedMark]) {
          try {
            this._hookComponentExtend(Ember);
            this._hookServiceExtend(Ember);
            Debug.log('[EmberHook] hooks installed');
          } catch (e) {
            Debug.warn('[EmberHook] hook error:', e);
          }
          emberLibs[this._wrappedMark] = true;
        }
      };

      // Sync path. catches eagerly-loaded component extends
      const Ember = this._findEmberSync(emberLibs);
      if (Ember) {
        hookEmber(Ember);
      }

      // Async fallback. catches lazily-loaded components
      Promise.resolve(emberLibs.getEmber()).then(Ember => hookEmber(Ember));
    }, true);
  },

  _findEmberSync(emberLibs) {
    if (window.Ember && typeof window.Ember.Component?.extend === 'function' &&
        typeof window.Ember.Service?.extend === 'function') {
      return window.Ember;
    }

    for (const key of Object.getOwnPropertyNames(emberLibs)) {
      const val = emberLibs[key];
      if (val && val !== emberLibs.getEmber &&
          typeof val.Component?.extend === 'function' &&
          typeof val.Service?.extend === 'function') {
        return val;
      }
    }

    try {
      const wpr = window.__webpack_require__;
      if (wpr?.c) {
        for (const id in wpr.c) {
          const mod = wpr.c[id];
          if (mod.exports &&
              typeof mod.exports.Component?.extend === 'function' &&
              typeof mod.exports.Service?.extend === 'function') {
            return mod.exports;
          }
        }
      }
    } catch (e) {}

    return null;
  },

  _wrapMethod(target, name, replacement) {
    const fn = target[name];
    if (typeof fn !== 'function') return false;

    const wrappedSet = (target[this._wrappedMark] ??= new Set());
    if (wrappedSet.has(name)) return false;

    const original = fn;
    target[name] = function(...args) {
      const caller = (...callArgs) => original.apply(this, callArgs);
      return replacement.call(this, caller, args);
    };

    wrappedSet.add(name);
    return true;
  },

  _extractClassNames(args) {
    const collected = [];
    for (const a of args) {
      if (a && typeof a === 'object') {
        const cn = a.classNames;
        if (Array.isArray(cn)) {
          for (const c of cn) {
            if (typeof c === 'string') collected.push(c);
          }
        }
      }
    }
    return collected;
  },

  _applyRuleToClass(Ember, klass, extendArgs, rule) {
    let cur = klass;

    if (rule.mixin) {
      try {
        let mixinObj = rule.mixin(Ember, extendArgs);
        // Runtime componentName filter: wrap init so only matching instances
        // (by _debugContainerKey) execute the hook code.
        if (rule.componentName && mixinObj && mixinObj.init) {
          mixinObj.init = this._wrapInitWithNameCheck(mixinObj.init, rule.componentName);
        }
        cur = cur.extend(mixinObj);
      } catch (e) {
        Debug.warn('[EmberHook] mixin failed:', rule.name, e);
      }
    }

    if (rule.wraps?.length) {
      try {
        const proto = cur.proto();

        const applied = (proto[this._appliedRulesKey] ??= new Set());
        if (!applied.has(rule.name)) {
          for (const w of rule.wraps) {
            this._wrapMethod(proto, w.name, w.replacement);
          }
          applied.add(rule.name);
          proto[this._appliedRulesKey] = applied;
        }
      } catch (e) {
        Debug.warn('[EmberHook] wraps failed:', rule.name, e);
      }
    }

    return cur;
  },

  _hookComponentExtend(Ember) {
    const Component = Ember.Component;
    if (!Component || typeof Component.extend !== 'function') {
      Debug.warn('[EmberHook] Ember.Component.extend not found');
      return;
    }

    const target = Component;
    if (target[this._wrappedMark]) {
      return;
    }

    const originalExtend = Component.extend.bind(Component);
    Component.extend = function(...args) {
      let klass = originalExtend(...args);

      if (this._rules.length > 0) {
        for (const rule of this._rules) {
          if (rule.type === 'service') continue;
          const m = rule.matcher;
          let matched = false;

          if (typeof m === 'function') {
            try { matched = m(args); } catch(e) { matched = false; }
          } else if (m === '*') {
            matched = true;
          } else {
            const classNames = this._extractClassNames(args);
            matched = classNames.includes(m);
          }

          if (matched) {
            klass = this._applyRuleToClass(Ember, klass, args, rule);
          }
        }
        if (klass) klass[this._retroKey] = true;
      }

      return klass;
    }.bind(this);

    target[this._wrappedMark] = true;
  },

  // Wraps init with runtime _debugContainerKey check; non-matching instances fall through to _super.
  _wrapInitWithNameCheck(initFn, componentName) {
    return function(...args) {
      const debugKey = this._debugContainerKey;
      let matchName = null;
      if (debugKey) {
        const afterColon = debugKey.split(':')[1];
        if (afterColon) matchName = afterColon.split('@')[0];
      }
      if (matchName && matchName !== componentName) {
        // Non-matching: just call _super (source init) without the hook code
        if (typeof this._super === 'function') {
          return this._super(...args);
        }
        return;
      }
      return initFn.apply(this, args);
    };
  },

  _hookServiceExtend(Ember) {
    const Service = Ember.Service;
    if (!Service || typeof Service.extend !== 'function') return;

    const target = Service;
    if (target[this._wrappedMark]) return;

    const originalExtend = Service.extend.bind(Service);
    Service.extend = function(...args) {
      let klass = originalExtend(...args);

      if (this._rules.length > 0) {
        for (const rule of this._rules) {
          if (rule.type !== 'service') continue;
          const m = rule.matcher;
          let matched = false;

          if (typeof m === 'function') {
            try { matched = m(args); } catch(e) { matched = false; }
          } else if (m === '*') {
            matched = true;
          } else {
            const classNames = this._extractClassNames(args);
            matched = classNames.includes(m);
          }

          if (matched) {
            klass = this._applyRuleToClass(Ember, klass, args, rule);
          }
        }
        if (klass) klass[this._retroKey] = true;
      }

      return klass;
    }.bind(this);

    target[this._wrappedMark] = true;
  },

  registerRule(rule) {
    const i = this._rules.findIndex(r => r.name === rule.name);
    if (i >= 0) {
      this._rules[i] = rule;
    } else {
      this._rules.push(rule);
    }
  },

  getRulesCount() {
    return this._rules.length;
  },
});


// Serialize a request body for LCU HTTP methods.
// Plain objects are JSON-stringified. Strings are passed through as-is,
// allowing callers to send pre-serialized payloads (e.g. the LCDS invoke endpoint).
function serializeBody(body) {
    if (body === undefined || body === null) return undefined;
    return typeof body === 'string' ? body : JSON.stringify(body);
}

// LCU
const LCU = {
  _ctx: null,
  _listeners: new Map(),
  _uris: new Set(),
  _subscribed: new Set(),
  _subscriptions: new Map(),

  bind(ctx) {
    if (this._ctx && this._ctx !== ctx) {
      this._subscriptions.forEach((_, uri) => this._disconnectUri(uri));
      this._subscribed.clear();
      this._subscriptions.clear();
    }
    this._ctx = ctx;
    window.LCU = this;
    Debug.log('[LCU] bindContext');
    this._uris.forEach(u => this._subscribe(u));
  },

  async get(url) {
    const r = await fetch(url.startsWith('/') ? url : '/' + url);
    if (!r.ok) throw new Error(r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  },

  async post(url, body, options = {}) {
      const {
          headers = {},
          raw = false
      } = options;

      const finalHeaders = raw
           ? headers
           : {
          'Content-Type': 'application/json',
          ...headers
      };

      const r = await fetch(url.startsWith('/') ? url : '/' + url, {
          method: 'POST',
          headers: finalHeaders,
          body: raw ? body : serializeBody(body)
      });

    if (!r.ok) throw new Error(r.status);

    const t = await r.text();
    return t ? JSON.parse(t) : null;
	},

  async put(url, body) {
    const r = await fetch(url.startsWith('/') ? url : '/' + url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: serializeBody(body)
    });
    if (!r.ok) throw new Error(r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  },

  async patch(url, body) {
    const r = await fetch(url.startsWith('/') ? url : '/' + url, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: serializeBody(body)
    });
    if (!r.ok) throw new Error(r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  },

  observe(uri, cb) {
    if (!this._listeners.has(uri)) this._listeners.set(uri, new Set());
    this._listeners.get(uri).add(cb);
    this._uris.add(uri);
    if (this._ctx?.socket) this._subscribe(uri);
    return () => {
      const listeners = this._listeners.get(uri);
      if (!listeners) return;
      listeners.delete(cb);
      if (listeners.size === 0) {
        this._listeners.delete(uri);
        this._uris.delete(uri);
        this._disconnectUri(uri);
      }
    };
  },

  _subscribe(uri) {
    if (!this._ctx?.socket) return;
    if (this._subscribed.has(uri)) return;
    this._subscribed.add(uri);
    const ctx = this._ctx;
    const listener = (data) => {
      if (this._ctx !== ctx) return;
      (this._listeners.get(uri) || []).forEach(cb => cb(data));
    };
    const subscription = ctx.socket.observe(uri, listener);
    this._subscriptions.set(uri, { ctx, listener, subscription });
  },

  _disconnectUri(uri) {
    const sub = this._subscriptions.get(uri);
    if (!sub) return;

    try {
      if (sub.subscription && typeof sub.subscription.disconnect === 'function') {
        sub.subscription.disconnect();
      } else if (typeof sub.subscription === 'function') {
        sub.subscription();
      } else if (sub.ctx?.socket?.disconnect) {
        sub.ctx.socket.disconnect(uri, sub.listener);
      }
    } catch (e) {}

    this._subscriptions.delete(uri);
    this._subscribed.delete(uri);
  },

  async delete(url) {
    const r = await fetch(url.startsWith('/') ? url : '/' + url, { method: 'DELETE' });
    if (!r.ok) throw new Error(r.status);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
};

/**
 * Settings Utils
 */
function settingsUtils(context, pluginConfig) {
  if (window.SnoozeManager && window.SnoozeManager.__isLoader) return;
  EmberHook.install(context);

  const categoryTitles = window.SnoozeCategoryTitles = window.SnoozeCategoryTitles || new Map();
  categoryTitles.set(pluginConfig.titleKey, pluginConfig.titleName);

  // Shared registries written by every module, read by a single patch
  const _smRoutes    = window.__SM_ROUTES    = window.__SM_ROUTES    || new Set();
  const _smTemplates = window.__SM_TEMPLATES = window.__SM_TEMPLATES || new Map();

  _smRoutes.add(pluginConfig.name);
  _smTemplates.set(pluginConfig.name, pluginConfig);

  const strings = {
    'snooze_plugins':         'Plugins',
    'snooze_plugins_capital': 'PLUGINS',
    [pluginConfig.titleKey]:         pluginConfig.titleName,
    [pluginConfig.capitalTitleKey]:  pluginConfig.capitalTitleName
  };

  context.rcp.postInit("rcp-fe-lol-settings", async (rcp) => {
    const em = await window.__SM_EMBER.getEmber();

    let pluginGroup = rcp._modalManager._registeredCategoryGroups.find(g => g.name === "plugins");
    if (!pluginGroup) {
      pluginGroup = { name: "plugins", titleKey: "snooze_plugins", capitalTitleKey: "snooze_plugins_capital", categories: [] };
      rcp._modalManager._registeredCategoryGroups.splice(1, 0, pluginGroup);
    }

    if (!pluginGroup.categories.some(c => c.name === pluginConfig.name)) {
      pluginGroup.categories.push({
        name: pluginConfig.name,
        titleKey: pluginConfig.titleKey,
        routeName: pluginConfig.name,
        group: pluginGroup,
        computeds: em.Object.create({ disabled: false }),
        isEnabled: () => true
      });
    }

    pluginGroup.categories.sort((a, b) => {
      const titleA = categoryTitles.get(a.titleKey) || a.name || '';
      const titleB = categoryTitles.get(b.titleKey) || b.name || '';
      return titleA.localeCompare(titleB);
    });

    rcp._modalManager._refreshCategoryGroups();
  });

  context.rcp.postInit("rcp-fe-ember-libs", async (rcp) => {
    window.__SM_EMBER = rcp;
    const em = await rcp.getEmber();

    // Router patch.  install once, route map reads from shared registry
    if (!em.Router.__snoozePatched) {
      em.Router.__snoozePatched = true;
      const nativeExtend = em.Router.extend;
      em.Router.extend = function() {
        const patchedRouter = nativeExtend.apply(this, arguments);
        patchedRouter.map(function() {
          _smRoutes.forEach(name => this.route(name));
        });
        return patchedRouter;
      };
    }

    // App factory patch. install once, template build reads from shared registry
    const appFactory = await rcp.getEmberApplicationFactory();
    if (!appFactory.__snoozePatched) {
      appFactory.__snoozePatched = true;
      const nativeBuilder = appFactory.factoryDefinitionBuilder;
      appFactory.factoryDefinitionBuilder = function() {
        const def = nativeBuilder.apply(this, arguments);
        const nativeBuild = def.build;
        def.build = function() {
          if (this.getName() === "rcp-fe-lol-settings") {
            _smTemplates.forEach((cfg) => {
              this.addTemplate(
                cfg.name,
                em.HTMLBars.template({
                  id: cfg.name,
                  block: JSON.stringify({
                    statements: [
                      ["open-element", "lol-uikit-scrollable", []],
                      ["static-attr", "class", cfg.class],
                      ["flush-element"],
                      ["close-element"]
                    ],
                    locals: [], named: [], yields: [], blocks: [], hasPartials: false
                  }),
                  meta: {}
                })
              );
            });
          }
          return nativeBuild.apply(this, arguments);
        };
        return def;
      };
    }
  });

  context.rcp.postInit("rcp-fe-lol-l10n", async (rcp) => {
    const l10n = rcp.tra();
    const nativeGet = l10n.__proto__.get;
    l10n.__proto__.get = function(key) {
      return strings[key] !== undefined ? strings[key] : nativeGet.call(this, key);
    };
  });

  if (LCU && !LCU._ctx) LCU.bind(context);
}

function createToggleRow(labelText, checked, onChange) {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.justifyContent = 'space-between';
    row.style.width = '100%';
    row.style.gap = '10px';

    const origin = document.createElement('lol-uikit-flat-checkbox');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!checked;
    if (checkbox.checked) origin.classList.add('checked');
    checkbox.setAttribute('slot', 'input');

    const label = document.createElement('label');
    label.textContent = labelText;
    label.setAttribute('slot', 'label');

    checkbox.addEventListener('click', (event) => {
        event.stopPropagation();
        const nextValue = checkbox.checked;
        origin.classList.toggle('checked', nextValue);
        if (typeof onChange === 'function') onChange(nextValue);
    });

    origin.appendChild(checkbox);
    origin.appendChild(label);
    row.appendChild(origin);
    return row;
}

// Shared Assets & Match History Helpers

const Assets = {
  champs: {}, items: {}, spells: {}, perks: {}, queues: [],
  _initPromise: null,
  _initialized: false,
  async init() {
    if (!LCU) return;
    if (this._initPromise) return this._initPromise;

    this._initPromise = (async () => {
      try {
        const [c, i, s, p, ps, q] = await Promise.all([
          LCU.get('/lol-game-data/assets/v1/champion-summary.json').catch(()=>[]),
          LCU.get('/lol-game-data/assets/v1/items.json').catch(()=>[]),
          LCU.get('/lol-game-data/assets/v1/summoner-spells.json').catch(()=>[]),
          LCU.get('/lol-game-data/assets/v1/perks.json').catch(()=>[]),
          LCU.get('/lol-game-data/assets/v1/perkstyles.json').catch(()=>({styles:[]})),
          LCU.get('/lol-game-queues/v1/queues').catch(()=>[])
        ]);
        if (Array.isArray(c) && c.length > 0) c.forEach(x => this.champs[x.id] = x);
        if (Array.isArray(i) && i.length > 0) i.forEach(x => this.items[x.id] = x);
        if (Array.isArray(s) && s.length > 0) s.forEach(x => this.spells[x.id] = x);
        if (Array.isArray(p) && p.length > 0) p.forEach(x => this.perks[x.id] = x);
        if (ps && Array.isArray(ps.styles) && ps.styles.length > 0) ps.styles.forEach(x => this.perks[x.id] = x);
        if (Array.isArray(q) && q.length > 0) {
          this.queues = q.filter(x => x.name && x.id).map(x => ({
            id: x.id, name: x.shortName || x.name, tag: 'q_' + x.id
          })).sort((a, b) => a.name.localeCompare(b.name));
        }
        
        this._initialized = true;

        if (this.queues.length === 0 || Object.keys(this.champs).length === 0) {
          this._initPromise = null;
          this._initialized = false;
        }
      } catch (e) {
        this._initPromise = null;
        this._initialized = false;
      }
    })();

    return this._initPromise;
  },
  getIcon(type, id) {
    if (!id || id <= 0) return '';
    const obj = this[type][id];
    let path = obj?.iconPath || obj?.squarePortraitPath || '';
    if (path) path = path.replace('/lol-game-data/assets/', '/lol-game-data/assets/'); 
    return path;
  }
};

const sgpContextCache = new Map();
const sgpContextPromise = new Map();

async function getSgpContext(overrideRegion = null) {
    const now = Date.now();
    const cacheKey = overrideRegion || 'LOCAL';
    const cached = sgpContextCache.get(cacheKey);
    
    if (cached && now < cached.expiresAt) return cached;
    if (sgpContextPromise.has(cacheKey)) return sgpContextPromise.get(cacheKey);

    const promise = (async () => {
        const entToken = await LCU.get('/entitlements/v1/token').catch(() => null);
        let serverCode = 'EUW';
        
        if (overrideRegion) {
            serverCode = overrideRegion;
        } else {
            const regionLocale = await LCU.get('/riotclient/region-locale').catch(() => null);
            if (regionLocale && regionLocale.region) {
                serverCode = regionLocale.region.toUpperCase();
            } else if (entToken && entToken.issuer) {
                const externalMatch = entToken.issuer.match(/https?:\/\/([a-z0-9]+)-[a-z0-9]+\.(?:lol\.)?sgp\.pvp\.net/);
                if (externalMatch) serverCode = externalMatch[1].toUpperCase();
            }
            
            // Normalize regions to SGP routing codes
            if (serverCode === 'EUW1') serverCode = 'EUW';
            if (serverCode === 'NA' || serverCode === 'NA1') serverCode = 'NA1';
            if (serverCode === 'EUNE') serverCode = 'EUN1';
            if (serverCode === 'TR') serverCode = 'TR1';
            if (serverCode === 'JP') serverCode = 'JP1';
            if (serverCode === 'BR') serverCode = 'BR1';
            if (serverCode === 'OCE') serverCode = 'OC1';
            if (serverCode === 'LAN') serverCode = 'LA1';
            if (serverCode === 'LAS') serverCode = 'LA2';
            if (serverCode === 'RU') serverCode = 'RU';
        }

        const SGP_SERVERS = {
            TW2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net', common: 'https://tw2-red.lol.sgp.pvp.net' },
            SG2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net', common: 'https://sg2-red.lol.sgp.pvp.net' },
            PH2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net', common: 'https://ph2-red.lol.sgp.pvp.net' },
            VN2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net', common: 'https://vn2-red.lol.sgp.pvp.net' },
            TH2:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net', common: 'https://th2-red.lol.sgp.pvp.net' },
            JP1:  { matchHistory: 'https://apne1-red.pp.sgp.pvp.net', common: 'https://jp-red.lol.sgp.pvp.net' },
            KR:   { matchHistory: 'https://apne1-red.pp.sgp.pvp.net', common: 'https://kr-red.lol.sgp.pvp.net' },
            NA1:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net', common: 'https://na-red.lol.sgp.pvp.net' },
            BR1:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net', common: 'https://br-red.lol.sgp.pvp.net' },
            LA1:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net', common: 'https://lan-red.lol.sgp.pvp.net' },
            LA2:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net', common: 'https://las-red.lol.sgp.pvp.net' },
            PBE:  { matchHistory: 'https://usw2-red.pp.sgp.pvp.net', common: 'https://pbe-red.lol.sgp.pvp.net' },
            OC1:  { matchHistory: 'https://apse1-red.pp.sgp.pvp.net', common: 'https://oce-red.lol.sgp.pvp.net' },
            EUW:  { matchHistory: 'https://euc1-red.pp.sgp.pvp.net', common: 'https://euw-red.lol.sgp.pvp.net' },
            EUN1: { matchHistory: 'https://euc1-red.pp.sgp.pvp.net', common: 'https://eune-red.lol.sgp.pvp.net' },
            TR1:  { matchHistory: 'https://euc1-red.pp.sgp.pvp.net', common: 'https://tr-red.lol.sgp.pvp.net' },
            RU:   { matchHistory: 'https://euc1-red.pp.sgp.pvp.net', common: 'https://ru-red.lol.sgp.pvp.net' }
        };

        let matchHistoryBase = '';
        let commonBase = '';

        const endpoints = SGP_SERVERS[serverCode];
        if (endpoints) {
            matchHistoryBase = endpoints.matchHistory;
            commonBase = endpoints.common;
        } else if (entToken && entToken.issuer && entToken.issuer.includes('.qq.com')) {
            const tencentMatch = entToken.issuer.match(/https?:\/\/([a-z0-9]+)(?:-[a-z0-9]+)*\.lol\.qq\.com/);
            if (tencentMatch) {
                const tCode = tencentMatch[1];
                if (tCode.startsWith('hn') || tCode.startsWith('bgp')) {
                    matchHistoryBase = `https://${tCode}-k8s-sgp.lol.qq.com:21019`;
                    commonBase = `https://${tCode}-k8s-sgp.lol.qq.com:21019`;
                } else {
                    matchHistoryBase = `https://${tCode}-sgp.lol.qq.com:21019`;
                    commonBase = `https://${tCode}-sgp.lol.qq.com:21019`;
                }
            }
        }

        if (!matchHistoryBase) matchHistoryBase = 'https://euc1-red.pp.sgp.pvp.net';
        if (!commonBase) commonBase = 'https://euw-red.lol.sgp.pvp.net';

        // sgpBase acts as an alias for matchHistoryBase to ensure older code doesn't break
        const context = { 
            accessToken: entToken?.accessToken, 
            sgpBase: matchHistoryBase, 
            matchHistoryBase, 
            commonBase,
            expiresAt: now + 5 * 60 * 1000
        };
        sgpContextCache.set(cacheKey, context);
        return context;
    })();

    sgpContextPromise.set(cacheKey, promise);
    try {
        return await promise;
    } finally {
        sgpContextPromise.delete(cacheKey);
    }
}

async function getSgpMatchHistory(puuid, startIndex = 0, count = 20, tag = '', overrideRegion = null) {
    if (!LCU) return null;
    try {
        const { accessToken, sgpBase } = await getSgpContext(overrideRegion);

        let url = `${sgpBase}/match-history-query/v1/products/lol/player/${puuid}/SUMMARY?startIndex=${startIndex}&count=${count}`;
        if (tag) url += `&tag=${tag}`;

        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': 'LeagueOfLegendsClient' } });
        if (!resp.ok) throw new Error('SGP Error: ' + resp.status);
        return resp.json();
    } catch(err) {
      Debug.error('SGP Match History Error:', err);
      return null;
    }
}

/**
 * Fetch Hook (Interception)
 */
const FetchHook = {
    _installed: false,
    _reqHooks: new Map(),
    _resHooks: new Map(),

    install() {
        if (this._installed) return;
        this._installed = true;

        const originalFetch = window.fetch;
        window.fetch = async (input, init) => {
            let currentInput = input;
            let currentInit = init;
            const urlStr = (input instanceof Request) ? input.url : input.toString();

            if (this._reqHooks.size > 0) {
                for (const [pattern, callbacks] of this._reqHooks.entries()) {
                    const matched = pattern instanceof RegExp ? pattern.test(urlStr) : urlStr.includes(pattern);
                    if (matched) {
                        for (const cb of callbacks) {
                            cb(currentInput, currentInit);
                        }
                    }
                }
            }

            try {
                const response = await originalFetch(currentInput, currentInit);
                
                let hooksToRun = [];
                for (const [pattern, callbacks] of this._resHooks.entries()) {
                    const matched = pattern instanceof RegExp ? pattern.test(urlStr) : urlStr.includes(pattern);
                    if (matched) {
                        hooksToRun.push(...callbacks);
                    }
                }

                if (hooksToRun.length > 0) {
                    const originalText = response.text.bind(response);
                    response.text = async () => {
                        let text = await originalText();
                        for (const cb of hooksToRun) {
                            text = cb(text) ?? text;
                        }
                        return text;
                    };
                    response.json = async () => {
                        let text = await response.text();
                        return JSON.parse(text);
                    };
                }

                return response;
            } catch (e) {
                throw e;
            }
        };
    },

    hookReq(pattern, callback) {
        this.install();
        if (!this._reqHooks.has(pattern)) this._reqHooks.set(pattern, []);
        this._reqHooks.get(pattern).push(callback);
        return () => {
            const hooks = this._reqHooks.get(pattern);
            if (!hooks) return;
            const idx = hooks.indexOf(callback);
            if (idx !== -1) hooks.splice(idx, 1);
            if (hooks.length === 0) this._reqHooks.delete(pattern);
        };
    },

    hookRes(pattern, callback) {
        this.install();
        if (!this._resHooks.has(pattern)) this._resHooks.set(pattern, []);
        this._resHooks.get(pattern).push(callback);
        return () => {
            const hooks = this._resHooks.get(pattern);
            if (!hooks) return;
            const idx = hooks.indexOf(callback);
            if (idx !== -1) hooks.splice(idx, 1);
            if (hooks.length === 0) this._resHooks.delete(pattern);
        };
    }
};

/**
 * XHR Hook (Interception)
 */
const XhrHook = {
    _installed: false,
    _reqHooks: new Map(),
    _resHooks: new Map(),

    install() {
        if (this._installed) return;
        this._installed = true;

        const originalOpen = XMLHttpRequest.prototype.open;
        const self = this;

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            const urlStr = url.toString();
            this.__urlStr = urlStr;
            this.__method = method;

            let matchedPre = [];
            let matchedPost = [];

            for (const [pattern, callbacks] of self._reqHooks.entries()) {
                if (pattern instanceof RegExp ? pattern.test(urlStr) : urlStr.includes(pattern)) {
                    matchedPre.push(...callbacks);
                }
            }

            for (const [pattern, callbacks] of self._resHooks.entries()) {
                if (pattern instanceof RegExp ? pattern.test(urlStr) : urlStr.includes(pattern)) {
                    matchedPost.push(...callbacks);
                }
            }

            if (matchedPre.length > 0 || matchedPost.length > 0) {
                const originalSend = this.send;
                
                this.send = function(body) {
                    let currentBody = body;
                    
                    for (const cb of matchedPre) {
                        currentBody = cb(this.__method, this.__urlStr, this, currentBody) ?? currentBody;
                    }

                    if (matchedPost.length > 0) {
                        let originalOnReadyStateChange = this.onreadystatechange;
                        this.onreadystatechange = function(ev) {
                            if (this.readyState === 4) {
                                if (this.responseType === '' || this.responseType === 'text') {
                                    let modifiedText = this.responseText;
                                    for (const cb of matchedPost) {
                                        modifiedText = cb(this.__method, this.__urlStr, this, modifiedText) ?? modifiedText;
                                    }
                                    if (modifiedText !== this.responseText) {
                                        Object.defineProperty(this, 'responseText', {
                                            writable: true,
                                            value: modifiedText
                                        });
                                        if (this.responseType === '') {
                                            Object.defineProperty(this, 'response', {
                                                writable: true,
                                                value: modifiedText
                                            });
                                        }
                                    }
                                }
                            }
                            if (originalOnReadyStateChange) {
                                return originalOnReadyStateChange.apply(this, arguments);
                            }
                        };
                    }

                    originalSend.call(this, currentBody);
                };
            }

            originalOpen.call(this, method, urlStr, ...rest);
        };
    },

    hookReq(pattern, callback) {
        this.install();
        if (!this._reqHooks.has(pattern)) this._reqHooks.set(pattern, []);
        this._reqHooks.get(pattern).push(callback);
        return () => {
            const hooks = this._reqHooks.get(pattern);
            if (!hooks) return;
            const idx = hooks.indexOf(callback);
            if (idx !== -1) hooks.splice(idx, 1);
            if (hooks.length === 0) this._reqHooks.delete(pattern);
        };
    },

    hookRes(pattern, callback) {
        this.install();
        if (!this._resHooks.has(pattern)) this._resHooks.set(pattern, []);
        this._resHooks.get(pattern).push(callback);
        return () => {
            const hooks = this._resHooks.get(pattern);
            if (!hooks) return;
            const idx = hooks.indexOf(callback);
            if (idx !== -1) hooks.splice(idx, 1);
            if (hooks.length === 0) this._resHooks.delete(pattern);
        };
    }
};

/**
 * WebSocket Mutation Hook
 */
const WSHook = {
    _installed: false,
    _hooks: new Map(),

    install(context) {
        if (this._installed || !context?.socket?._dispatcher?.publish) return;
        this._installed = true;

        const dispatcher = context.socket._dispatcher;
        const originalPublish = dispatcher.publish.bind(dispatcher);

        dispatcher.publish = (endpoint, payload) => {
            let currentPayload = payload;

            for (const [pattern, callbacks] of this._hooks.entries()) {
                const matched = pattern instanceof RegExp ? pattern.test(endpoint) : endpoint.includes(pattern);
                if (matched) {
                    for (const cb of callbacks) {
                        currentPayload = cb(endpoint, currentPayload) ?? currentPayload;
                    }
                }
            }

            if (currentPayload !== null && currentPayload !== undefined) {
                originalPublish(endpoint, currentPayload);
            }
        };
    },

    hook(pattern, callback) {
        if (!this._hooks.has(pattern)) this._hooks.set(pattern, []);
        this._hooks.get(pattern).push(callback);
        return () => {
            const hooks = this._hooks.get(pattern);
            if (!hooks) return;
            const idx = hooks.indexOf(callback);
            if (idx !== -1) hooks.splice(idx, 1);
            if (hooks.length === 0) this._hooks.delete(pattern);
        };
    }
};

const Store = {
    MAIN_KEY: 'Snooze-Store',
    _cache: null,

    _load() {
        if (this._cache) return this._cache;
        
        // Migrate data from previous temporary name 'Snooze-Modules' to 'Snooze-Store'
        if (window.DataStore.has('Snooze-Modules')) {
            const oldData = window.DataStore.get('Snooze-Modules');
            window.DataStore.set(this.MAIN_KEY, oldData);
            window.DataStore.remove('Snooze-Modules');
        }

        const data = window.DataStore.get(this.MAIN_KEY);
        this._cache = (data && typeof data === 'object') ? data : { schemaVersion: 0 };
        
        if (this._cache.schemaVersion === undefined) {
            this._cache.schemaVersion = 0;
        }

        return this._cache;
    },

    _save() {
        window.DataStore.set(this.MAIN_KEY, this._cache);
    },

    getSchemaVersion() {
        const data = this._load();
        return data.schemaVersion || 0;
    },

    get(moduleName, key, fallback) {
        const data = this._load();
        if (!data[moduleName]) return fallback;
        const val = data[moduleName][key];
        return val !== undefined ? val : fallback;
    },

    set(moduleName, key, value) {
        const data = this._load();
        if (!data[moduleName]) data[moduleName] = {};
        data[moduleName][key] = value;
        this._save();
    },

    remove(moduleName, key) {
        const data = this._load();
        if (data[moduleName] && data[moduleName][key] !== undefined) {
            delete data[moduleName][key];
            if (Object.keys(data[moduleName]).length === 0) {
                delete data[moduleName];
            }
            this._save();
        }
    },

    removeModule(moduleName) {
        const data = this._load();
        if (data[moduleName] !== undefined) {
            delete data[moduleName];
            this._save();
        }
    },

    migrateLegacyKeys(mapping, moduleVersion = 1) {
        const data = this._load();
        
        let migrated = false;

        for (const [oldKey, target] of Object.entries(mapping)) {
            if (!data[target.module]) data[target.module] = {};
            
            // Skip if this specific module has already been migrated to the requested version
            if (data[target.module].schemaVersion >= moduleVersion) continue;

            if (window.DataStore.has(oldKey)) {
                let oldVal = window.DataStore.get(oldKey);
                if (typeof oldVal === "string" && (oldVal.startsWith("{") || oldVal.startsWith("["))) {
                    try { oldVal = JSON.parse(oldVal); } catch (e) {}
                }
                
                data[target.module][target.key] = oldVal;
                window.DataStore.remove(oldKey);
                migrated = true;
            }
        }

        // Mark the modules as migrated to the requested version
        for (const target of Object.values(mapping)) {
            if (data[target.module]) {
                if ((data[target.module].schemaVersion || 0) < moduleVersion) {
                    data[target.module].schemaVersion = moduleVersion;
                    migrated = true;
                }
            }
        }

        if (migrated) {
            this._save();
        }
    }
};

const Panic = {
    _callbacks: new Set(),
    _installed: false,

    install() {
        if (this._installed) return;
        this._installed = true;

        if (Store.get('global', 'panicKey') === undefined) {
            Store.set('global', 'panicKey', 'F2');
        }

        document.addEventListener('keydown', (e) => {
            const key = Store.get('global', 'panicKey') || 'F2';
            if (e.key.toLowerCase() === key.toLowerCase() && this._callbacks.size > 0) {
                e.preventDefault();
                e.stopPropagation();

                this._callbacks.forEach(cb => {
                    try { cb(); } catch(err) {}
                });
                this._callbacks.clear();

                if (window.Toast && typeof window.Toast.success === 'function') {
                    window.Toast.success('Auto Actions Cancelled');
                } else {
                    Debug.log('Auto Actions Cancelled (Toast not found)');
                }
            }
        });
    },

    register(callback) {
        this.install();
        this._callbacks.add(callback);
        return () => {
            this._callbacks.delete(callback);
        };
    }
};

export const Utils = {
    DOM: { createSmartObserver, observer },
    Hooks: { Ember: EmberHook, Fetch: FetchHook, Xhr: XhrHook, WS: WSHook },
  Debug,
    LCU,
    Store,
    Panic,
    Settings: { inject: settingsUtils, createToggleRow },
    GameData: { Assets, getSgpContext, getSgpMatchHistory }
};
export default Utils;
