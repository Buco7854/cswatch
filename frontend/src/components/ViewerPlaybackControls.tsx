import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, ScanLine } from 'lucide-react';
import { t } from '../i18n';
import { SelectControl } from './Controls';

// The transport tick changes every frame. Only camera, speed, range or locale
// changes need to reconcile the corresponding controls and their option lists.
export const ViewerCameraControls = memo(function ViewerCameraControls({
  activeCamera,
  has3DMap,
  cameraNotice,
  changeCamera,
}: {
  activeCamera: string;
  has3DMap: boolean;
  cameraNotice: boolean;
  changeCamera: (value: string) => void;
}) {
  useTranslation();
  const fallbackCamera = activeCamera === 'fallback';
  const cameraOptions = [
    ...(fallbackCamera
      ? [{ value: 'fallback', label: t('2D map fallback'), compactLabel: '2D', disabled: true }]
      : []),
    {
      value: 'orbit',
      label: t('Free camera'),
      compactLabel: t('Free'),
      disabled: !has3DMap,
    },
    {
      value: 'tactical',
      label: t('Overhead'),
      compactLabel: t('Overhead'),
      disabled: !has3DMap,
    },
    { value: '2d', label: t('2D tactical · low power'), compactLabel: '2D' },
    {
      value: 'follow',
      label: t('Third-person follow'),
      compactLabel: t('Follow'),
      disabled: !has3DMap,
    },
    {
      value: 'pov',
      label: t('Player perspective'),
      compactLabel: 'POV',
      disabled: !has3DMap,
    },
  ];
  return (
    <>
      <span className="visually-hidden" role="status">
        {cameraNotice
          ? t('Camera changed to {{mode}}', {
              mode: cameraOptions.find((option) => option.value === activeCamera)?.label,
            })
          : ''}
      </span>
      <div className="viewer-camera-row" role="group" aria-label={t('Camera mode')}>
        {['pov', 'follow', 'orbit', 'tactical', '2d'].map((value) => {
          const option = cameraOptions.find((item) => item.value === value)!;
          return (
            <button
              type="button"
              key={value}
              aria-pressed={activeCamera === value || (fallbackCamera && value === '2d')}
              disabled={option.disabled}
              aria-label={option.label}
              data-fallback={fallbackCamera && value === '2d' ? true : undefined}
              title={option.label}
              onClick={() => changeCamera(value)}
            >
              {option.compactLabel}
            </button>
          );
        })}
      </div>
      <SelectControl
        label={t('Camera mode')}
        className="camera-select"
        icon={<Eye size={16} />}
        value={activeCamera}
        onValueChange={changeCamera}
        options={cameraOptions}
      />
    </>
  );
});

const speeds = [0.25, 0.5, 1, 2, 4];
export const ViewerSpeedControls = memo(function ViewerSpeedControls({
  speed,
  changeSpeed,
  dropdown = false,
}: {
  speed: number;
  changeSpeed: (speed: number) => void;
  dropdown?: boolean;
}) {
  const { i18n } = useTranslation();
  return dropdown ? (
    <SelectControl
      label={t('Playback speed')}
      className="speed-select"
      value={String(speed)}
      onValueChange={(value) => changeSpeed(Number(value))}
      options={speeds.map((value) => ({
        value: String(value),
        label: value.toLocaleString(i18n.language) + '×',
      }))}
    />
  ) : (
    <div className="viewer-speed-row" role="group" aria-label={t('Playback speed')}>
      {speeds.map((value) => (
        <button
          type="button"
          key={value}
          aria-pressed={speed === value}
          onClick={() => changeSpeed(value)}
        >
          {value.toLocaleString(i18n.language)}×
        </button>
      ))}
    </div>
  );
});

export const ViewerTimelineScope = memo(function ViewerTimelineScope({
  timelineScope,
  setTimelineScope,
  hasRounds,
}: {
  timelineScope: 'round' | 'match';
  setTimelineScope: (scope: 'round' | 'match') => void;
  hasRounds: boolean;
}) {
  useTranslation();
  return (
    <SelectControl
      label={t('Timeline range')}
      className="timeline-scope-control"
      value={timelineScope}
      onValueChange={(value) => setTimelineScope(value === 'round' ? 'round' : 'match')}
      icon={<ScanLine size={16} />}
      options={[
        { value: 'match', label: t('All match'), compactLabel: t('Match') },
        {
          value: 'round',
          label: t('Current round'),
          compactLabel: t('Round'),
          disabled: !hasRounds,
        },
      ]}
    />
  );
});
