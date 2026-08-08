/**
 * Snooze-Manager i18n configuration.
 * Declares this plugin's own locale settings and exposes the i18n API from
 * generalUtils. Other plugins using generalUtils provide their own config
 * (or none at all — t() then just passes keys through).
 */
import { initI18n, setLanguage, getCurrentLanguage, t } from './generalUtils.js';

export const STORAGE_KEY = 'SnoozeManager_Language';
export const DEFAULT_LANG = 'en';

// Available languages for Settings UI (keys must match the .json filenames in /locales/)
export const SUPPORTED_LANGUAGES = {
    "en": "English",
    "es": "Español",
    "fr": "Français",
    "kr": "한국어",
    "cn": "中文",
    "pt-BR": "Português (Brasil)",
    "tr": "Türkçe"
};

/**
 * Initializes this plugin's i18n with its own config.
 * @returns {Promise<void>}
 */
export function init() {
    return initI18n({
        storageKey: STORAGE_KEY,
        defaultLang: DEFAULT_LANG,
        supportedLanguages: SUPPORTED_LANGUAGES
    });
}

export { setLanguage, getCurrentLanguage, t };