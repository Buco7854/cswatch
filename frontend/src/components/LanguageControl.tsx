import i18n, { setLanguage, t, type Language } from '../i18n';
import { SelectControl } from './Controls';

/** One accessible language menu for public, private and member screens. */
export default function LanguageControl({ className = '' }: { className?: string }) {
  return (
    <SelectControl
      className={'language-control ' + className}
      label={t('Language')}
      value={i18n.language}
      onValueChange={(language) => setLanguage(language as Language)}
      options={[
        { value: 'en', label: 'English' },
        { value: 'fr', label: 'Français' },
      ]}
      displayValue={
        <>
          <span className="language-name">{i18n.language === 'fr' ? 'Français' : 'English'}</span>
          <span className="language-code">{i18n.language === 'fr' ? 'FR' : 'EN'}</span>
        </>
      }
    />
  );
}
