/**
 * @file i18n.js
 * @description Robust Internationalization utility for Snooze-Manager.
 * Uses Natural English strings as translation keys.
 */

const STORAGE_KEY = 'SnoozeManager_Language';
const DEFAULT_LANG = 'en';

// Define available languages for Settings UI (keys must match the .json filenames in /locales/)
export const SUPPORTED_LANGUAGES = {
    "en": "English",
    "es": "Español",
    "fr": "Français",
    "kr": "한국어",
    "cn": "中文",
    "pt-BR": "Português (Brasil)"
};

let currentLanguage = DEFAULT_LANG;
let translations = {};
let isInitialized = false;

/**
 * Initializes the i18n system. Loads saved language and fetches the JSON dictionary.
 * Should be called once during plugin bootstrap (e.g., at the top of index.js).
 * @returns {Promise<void>}
 */
export async function init() {
    if (isInitialized) return;

    try {
        const savedLang = localStorage.getItem(STORAGE_KEY);
        if (savedLang && Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, savedLang)) {
            currentLanguage = savedLang;
        }
    } catch (e) {
        console.warn('[Snooze-Manager:i18n] Failed to access localStorage:', e);
    }

    await loadDictionary(currentLanguage);
    isInitialized = true;
}

/**
 * Internal function to fetch the JSON dictionary.
 * @param {string} lang 
 */
async function loadDictionary(lang) {
    if (lang === 'en') {
        // English is our base language (keys are the English text).
        // We load an en.json if it exists to allow fixing typos without code changes, 
        // but if it fails, we safely fall back to an empty object.
        translations = {}; 
    }
    
    try {
        // Resolve the exact path in the Pengu CEF environment
        const normalized = import.meta.url.replace(/\\/g, "/");
        const moduleDir = normalized.substring(0, normalized.lastIndexOf("/") + 1);
        // i18n.js is inside /modules/, so we step back one folder to the plugin root
        const pluginRoot = moduleDir.replace(/\/modules\/$/, "/");
        const fileUrl = pluginRoot + `locales/${lang}.json`;

        const response = await fetch(fileUrl);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} - ${response.statusText} (${fileUrl})`);
        }
        
        const data = await response.json();
        if (typeof data === 'object' && data !== null) {
            translations = data;
            console.debug(`[Snooze-Manager:i18n] Successfully loaded locale: ${lang}`);
        }
    } catch (error) {
        // If en.json fails, it's totally fine since the keys are English.
        if (lang !== 'en') {
            console.warn(`[Snooze-Manager:i18n] Failed to load translations for '${lang}', falling back to default keys. Error:`, error);
        }
        translations = {}; // Reset to prevent mixing languages if a fetch fails
    }
}

/**
 * Translates a string and interpolates variables.
 * 
 * @param {string} key - The English string, e.g., "Hello {{name}}"
 * @param {Object} [params] - Variables to interpolate, e.g., { name: "Player" }
 * @returns {string} The translated string safely parsed
 */
export function t(key, params = {}) {
    if (typeof key !== 'string') {
        console.warn('[Snooze-Manager:i18n] t() called with non-string key:', key);
        return String(key);
    }

    // Get translation or fallback to the English key
    let str = Object.prototype.hasOwnProperty.call(translations, key) 
        ? translations[key] 
        : key;

    // Interpolate variables if provided
    if (params && typeof params === 'object') {
        for (const [paramKey, value] of Object.entries(params)) {
            // Safely convert value to string to avoid [object Object] or null errors
            const safeValue = (value !== null && value !== undefined) ? String(value) : '';
            // Replace all instances of {{paramKey}} globally
            const regex = new RegExp(`{{${paramKey}}}`, 'g');
            str = str.replace(regex, safeValue);
        }
    }

    return str;
}

/**
 * Changes the language, saves preference, and reloads the client.
 * @param {string} lang - The language code (e.g., 'es')
 * @returns {boolean} True if successful, false otherwise
 */
export async function setLanguage(lang) {
    if (!Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, lang)) {
        console.error(`[Snooze-Manager:i18n] Attempted to set unsupported language: ${lang}`);
        return false;
    }

    if (lang === currentLanguage) return true; // No change needed

    try {
        localStorage.setItem(STORAGE_KEY, lang);
        console.log(`[Snooze-Manager:i18n] Language saved as ${lang}. Reloading...`);
        fetch("/riotclient/kill-and-restart-ux", { method: "POST" });
        return true;
    } catch (e) {
        console.error('[Snooze-Manager:i18n] Failed to save language preference:', e);
        return false;
    }
}

/**
 * Gets the current active language code.
 * @returns {string}
 */
export function getCurrentLanguage() {
    return currentLanguage;
}
