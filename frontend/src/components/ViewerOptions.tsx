import { t } from '../i18n';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import type { ViewerSettings } from '../playback';
import { SelectControl } from './Controls';
export default function ViewerOptions({
  settings,
  onChange,
  close,
  openCommunications,
}: {
  settings: ViewerSettings;
  onChange: (s: ViewerSettings) => void;
  close: () => void;
  openCommunications: () => void;
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
      aria-labelledby="viewer-options-title"
      onCancel={close}
      onClick={(e) => {
        if (e.target === dialog.current) close();
      }}
    >
      <div className="panel-heading">
        <h2 id="viewer-options-title">{t('Viewer options')}</h2>
        <button className="icon-button" aria-label={t('Close viewer options')} onClick={close}>
          <X size={20} />
        </button>
      </div>
      <p>{t('Saved on this device. The scene updates as you change settings.')}</p>
      <section>
        <h3>{t('Communications')}</h3>
        <p>{t('Voice, communication subtitles and text chat have their own review controls.')}</p>
        <button className="button" onClick={openCommunications}>
          {t('Review communications')}
        </button>
      </section>
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
          t('Show recorded detonation markers and approximate smoke and fire zones.'),
        )}
        {toggle(
          'trajectories',
          t('Grenade paths'),
          t('Show the recorded flight paths. Grenade projectiles stay visible.'),
        )}
      </section>
      <section>
        <h3>{t('Analysis HUD')}</h3>
        {toggle(
          'inputs',
          t('Recorded inputs'),
          t('Show sampled movement, attack, and interaction actions for the selected player.'),
        )}
        {settings.inputs && (
          <div className="input-display-preferences">
            {toggle(
              'mouseInput',
              t('Mouse buttons and movement'),
              t('Show recorded attack actions and mouse movement on a mouse diagram.'),
            )}
            {toggle(
              'inputDetails',
              t('Input details'),
              t('Show the recorded input source and raw mouse movement values.'),
            )}
            <label>
              {t('Keyboard display layout')}
              <SelectControl
                label={t('Keyboard display layout')}
                value={settings.inputLayout}
                onValueChange={(value) =>
                  onChange({ ...settings, inputLayout: value as ViewerSettings['inputLayout'] })
                }
                options={[
                  { value: 'wasd', label: 'WASD' },
                  { value: 'zqsd', label: 'ZQSD' },
                ]}
              />
            </label>
          </div>
        )}
        {toggle(
          'economy',
          t('Economy and loadouts'),
          t('Show every player’s money, carried equipment value, status, and inventory.'),
        )}
        <p className="muted">
          {t(
            'Available fields depend on what the demo recorded. Missing input and mouse values are never estimated.',
          )}
        </p>
      </section>
      <section>
        <h3>{t('Playback & performance')}</h3>
        {toggle(
          'grenadeLanding',
          t('Grenade landing shortcut'),
          t('Offer a view of the recorded detonation after the observed player throws a grenade.'),
        )}
        {toggle(
          'killReplay',
          t('Kill replay shortcut'),
          t('Offer a short replay after an elimination by the observed player.'),
        )}
        {toggle(
          'autoHideControls',
          t('Hide controls during playback'),
          t(
            'Fade the viewing interface after a few seconds. Tap the scene or move the mouse to bring it back.',
          ),
        )}
        {toggle(
          'controlsHidden',
          t('Hide viewer controls'),
          t('Tap the scene or press H to show or hide the viewing interface.'),
        )}
        {toggle(
          'autoSkip',
          t('Skip dead time automatically'),
          t('Skip recorded freeze periods and tactical or technical timeouts.'),
        )}
        <label>
          {t('Rendering quality')}
          <SelectControl
            label={t('Rendering quality')}
            value={settings.quality}
            onValueChange={(value) =>
              onChange({ ...settings, quality: value as ViewerSettings['quality'] })
            }
            options={[
              { value: 'auto', label: t('Auto · mobile friendly') },
              { value: 'low', label: t('Low · reduced resolution, no shadows') },
              { value: 'high', label: t('High · shadows, higher resolution') },
            ]}
          />
        </label>
        <p className="muted">
          {t(
            'Recorded grenades remain visible at every quality level. Paths and analytical zones have separate controls.',
          )}
        </p>
        <p className="muted">
          {t(
            'Utility zones approximate event positions and durations. They do not reproduce Source 2’s volumetric smoke simulation.',
          )}
        </p>
      </section>
    </dialog>
  );
}
