import { t } from '../i18n';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ViewerSettings } from '../playback';
export default function ViewerOptions({
  settings,
  onChange,
  close,
}: {
  settings: ViewerSettings;
  onChange: (s: ViewerSettings) => void;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const toggle = (key: keyof ViewerSettings, title: string, description: string) => (
    <label className="toggle-row" key={key}>
      <span>
        {title}
        <small>{description}</small>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={Boolean(settings[key])}
        onChange={(e) => onChange({ ...settings, [key]: e.target.checked })}
      />
    </label>
  );
  return (
    <dialog
      ref={dialog}
      className="options-dialog member-dialog"
      onCancel={close}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      <div className="panel-heading">
        <h2>{t('Viewer options')}</h2>
        <button className="icon-button" aria-label={t('Close viewer options')} onClick={close}>
          <X size={20} />
        </button>
      </div>
      <p>{t('Saved on this device. The scene updates as you change settings.')}</p>
      <section>
        <h3>{t('Player visibility')}</h3>
        {toggle('xray', t('X-ray silhouettes'), t('Show player shapes through map geometry.'))}
        {toggle('crosshair', t('Crosshair'), t('Show a centered crosshair in player perspective.'))}
        {toggle('trails', t('Movement trails'), t('Show the selected player’s recent path.'))}
      </section>
      <section>
        <h3>{t('Match information')}</h3>
        {toggle(
          'radar',
          t('Position radar'),
          t('Show all alive players on a compact position plot.'),
        )}
        {toggle('killfeed', t('Elimination feed'), t('Show recent eliminations over the scene.'))}
        {toggle(
          'utilities',
          t('Utility zones'),
          t('Show event-based smoke and fire approximations.'),
        )}
        {toggle(
          'trajectories',
          t('Grenade paths'),
          t('Show recorded flight paths and projectile positions.'),
        )}
      </section>
      <section>
        <h3>{t('Playback & performance')}</h3>
        {toggle(
          'autoSkip',
          t('Skip dead time automatically'),
          t('Skip recorded freeze periods and tactical or technical timeouts.'),
        )}
        <label>
          {t('Rendering quality')}
          <select
            value={settings.quality}
            onChange={(e) =>
              onChange({ ...settings, quality: e.target.value as ViewerSettings['quality'] })
            }
          >
            <option value="auto">{t('Auto · mobile friendly')}</option>
            <option value="low">{t('Low · reduced resolution, no shadows')}</option>
            <option value="high">{t('High · shadows, higher resolution')}</option>
          </select>
        </label>
        <p className="muted">
          {t(
            'Utility zones approximate event positions and durations. They do not reproduce Source 2’s volumetric smoke simulation.',
          )}
        </p>
      </section>
    </dialog>
  );
}
