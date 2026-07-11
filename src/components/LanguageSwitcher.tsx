import { useI18n } from '../i18n/I18nProvider';

export default function LanguageSwitcher({
  className = '',
  variant = 'default',
}: {
  className?: string;
  variant?: 'default' | 'list';
}){
  const { locale, setLocale, t, availableLocales } = useI18n();
  const classes = ['language-switcher', className].filter(Boolean).join(' ');

  return (
    <div className={classes} aria-label={t('nav.languageLabel')}>
      {availableLocales.map(option => (
        <button
          key={option.code}
          type="button"
          onClick={() => setLocale(option.code)}
          className={option.code === locale ? 'active' : ''}
          title={t('language.switch', { language: option.label })}
          aria-label={t('language.switch', { language: option.label })}
        >
          <img src={option.flag} alt={option.label} />
          {variant === 'list' && (
            <span>{option.label}</span>
          )}
        </button>
      ))}
    </div>
  );
}

