import type { ViewerSettings } from '../playback';
import { t } from '../i18n';
import { ViewerAudio, useViewerAudioState } from '../viewer-audio';
import { soundCategorySettings, type GameplayAudioReport } from '../useGameplayAudio';
import { gameplaySoundCategories } from '../gameplay-sound-assets';
import { RangeSetting, ToggleSetting } from './ViewerSettingControls';
import './gameplay-sound-settings.css';

const labels = {
  weapon: 'Shots',
  footstep: 'Footsteps',
  reload: 'Reload actions',
  utility: 'Grenades',
  objective: 'Bomb actions',
  round: 'Round cues',
} as const;
export default function GameplaySoundSettings({
  audio,
  report,
  settings,
  onChange,
}: {
  audio: ViewerAudio;
  report: GameplayAudioReport;
  settings: ViewerSettings;
  onChange: (settings: ViewerSettings) => void;
}) {
  const state = useViewerAudioState(audio);
  const status =
    report.status === 'unavailable'
      ? 'This demo has no supported recorded game sounds.'
      : report.status === 'loading'
        ? 'Checking local game sounds…'
        : report.status === 'missing'
          ? 'Install the local CS2 sound pack to hear game audio.'
          : report.status === 'error'
            ? 'Local game sounds could not be checked.'
            : report.missing
              ? 'Some recorded sounds have no installed sample.'
              : '';
  return (
    <div className="viewer-game-sounds" data-game-sound-status={report.status}>
      <h3>{t('Sound')}</h3>
      <ToggleSetting
        label={t('Game sounds')}
        description={t('Play recorded actions with locally prepared CS2 samples.')}
        checked={settings.gameSounds}
        onChange={(gameSounds) => {
          if (gameSounds) void audio.unlock();
          onChange({ ...settings, gameSounds });
        }}
      />
      <details className="viewer-sound-settings">
        <summary>{t('Sound settings')}</summary>
        <ToggleSetting
          label={t('Mute all audio')}
          description={t('Silence game sounds and recorded voice.')}
          checked={settings.audioMuted}
          onChange={(audioMuted) => {
            if (audioMuted) audio.flush();
            if (!audioMuted) void audio.unlock();
            onChange({ ...settings, audioMuted });
          }}
        />
        <RangeSetting
          label={t('Master volume')}
          value={settings.audioVolume}
          min={0}
          max={1}
          step={0.01}
          display={`${Math.round(settings.audioVolume * 100)}%`}
          onChange={(audioVolume) => {
            if (audioVolume === 0) audio.flush();
            onChange({ ...settings, audioVolume });
          }}
        />
        <RangeSetting
          label={t('Game sound volume')}
          value={settings.gameVolume}
          min={0}
          max={1}
          step={0.01}
          display={`${Math.round(settings.gameVolume * 100)}%`}
          onChange={(gameVolume) => onChange({ ...settings, gameVolume })}
        />
        <ToggleSetting
          label={t('Positional audio')}
          description={t(
            'Follow the 3D camera or the selected player in 2D. Distance and direction are approximate.',
          )}
          checked={settings.spatialAudio}
          onChange={(spatialAudio) => onChange({ ...settings, spatialAudio })}
        />
        <p className="viewer-option-note">
          {t(
            'Recorded timing uses native samples. Sample variants, map acoustics and the complete game mix are not reproduced.',
          )}
        </p>
        <fieldset className="viewer-sound-categories">
          <legend>{t('Sound categories')}</legend>
          {gameplaySoundCategories.map((category) => (
            <ToggleSetting
              key={category}
              label={t(labels[category])}
              checked={settings[soundCategorySettings[category]]}
              onChange={(checked) =>
                onChange({ ...settings, [soundCategorySettings[category]]: checked })
              }
              description={t(
                report.coverage?.coverage[category] === 'available'
                  ? 'Recorded cues available'
                  : report.coverage?.coverage[category] === 'partial'
                    ? 'Partial recorded coverage'
                    : 'No recorded coverage',
              )}
            />
          ))}
        </fieldset>
        {state === 'unavailable' ? (
          <p className="viewer-option-note">
            {t('Audio playback is unavailable in this browser.')}
          </p>
        ) : (
          state !== 'running' && (
            <button className="button" onClick={() => void audio.unlock()}>
              {t('Enable audio')}
            </button>
          )
        )}
        {report.status === 'ready' && (
          <p className="viewer-option-note">
            {t('Installed sound samples: {{count}}', { count: report.installed })}
          </p>
        )}
        {status && (
          <p className="viewer-option-note" role="status">
            {t(status)}
          </p>
        )}
        {(report.status === 'missing' ||
          report.status === 'error' ||
          report.missing > 0 ||
          report.error) && (
          <button className="button" onClick={report.retry}>
            {t('Check sounds again')}
          </button>
        )}
        {report.coverage?.truncated && (
          <p className="viewer-option-note">
            {t('Recorded game sound coverage reached its safety limit.')}
          </p>
        )}
        {report.error && (
          <p className="viewer-option-note" role="status">
            {t(report.error)}
          </p>
        )}
      </details>
    </div>
  );
}
