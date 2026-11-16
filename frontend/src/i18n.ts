import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';
import fr from './locales/fr.json';
export type Language = 'en' | 'fr';
function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem('cswatch.language');
    if (saved === 'en' || saved === 'fr') return saved;
  } catch {}
  return navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}
void i18next.use(initReactI18next).init({
  resources: { en: { translation: en }, fr: { translation: fr } },
  lng: initialLanguage(),
  fallbackLng: 'en',
  supportedLngs: ['en', 'fr'],
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnEmptyString: false,
  initAsync: false,
});
export function t(key: string, values?: Record<string, unknown>): string {
  return String(i18next.t(key, values ?? {}));
}
export function locale() {
  return i18next.language === 'fr' ? 'fr-FR' : 'en-GB';
}
export function setLanguage(language: Language) {
  try {
    localStorage.setItem('cswatch.language', language);
  } catch {}
  void i18next.changeLanguage(language);
}
i18next.on('languageChanged', (language) => {
  document.documentElement.lang = language;
  document.title = t('cswatch — Counter-Strike demo viewer');
});
document.documentElement.lang = i18next.language;
export default i18next;

document.title = t('cswatch — Counter-Strike demo viewer');
