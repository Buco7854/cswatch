import { locale, t } from '../i18n';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { MessageSquareText, X } from 'lucide-react';
import {
  KILL_LEAD_INS,
  UTILITY_LEAD_INS,
  RENDER_RESOLUTION_MIN,
  RENDER_RESOLUTION_MAX,
  type ViewerSettings,
} from '../playback';
import type { DemoMapSummary } from '../demo-map-assets';
import type { MapIdentity } from '../../../shared/map-acquisition';
import type { EquipmentRenderState } from '../equipment-assets';
import {
  CROSSHAIR_LIMITS,
  defaultCrosshairStyle,
  formatCrosshairPreset,
  type CrosshairStyle,
} from '../crosshair';
import Crosshair from './Crosshair';
import RecordedCrosshair from './RecordedCrosshair';
import MapDetails from './MapDetails';
import { RangeSetting, SelectSetting, ToggleSetting } from './ViewerSettingControls';
import GameplaySoundSettings from './GameplaySoundSettings';
import type { ViewerAudio } from '../viewer-audio';
import type { GameplayAudioReport } from '../useGameplayAudio';
import { recordedCrosshair } from '../recorded-crosshair';
import './viewer-options.css';

type Category = 'visuals' | 'crosshair' | 'playback' | 'camera' | 'performance';
type BooleanSetting = {
  [Key in keyof ViewerSettings]: ViewerSettings[Key] extends boolean ? Key : never;
}[keyof ViewerSettings];
const categories = [
  { id: 'visuals', label: 'Visuals' },
  { id: 'crosshair', label: 'Crosshair' },
  { id: 'playback', label: 'Playback' },
  { id: 'camera', label: 'Camera' },
  { id: 'performance', label: 'Performance' },
] as const;

export default function ViewerOptions({
  settings,
  onChange,
  close,
  openCommunications,
  playerCrosshairCode,
  equipment,
  renderResolution,
  shadowsPaused,
  mapAcquisition,
  recordedMapIdentity,
  audio,
  gameAudio,
}: {
  settings: ViewerSettings;
  onChange: (s: ViewerSettings) => void;
  close: () => void;
  openCommunications: () => void;
  playerCrosshairCode?: string;
  equipment?: EquipmentRenderState;
  renderResolution?: number;
  shadowsPaused?: boolean;
  mapAcquisition?: DemoMapSummary;
  recordedMapIdentity?: MapIdentity;
  audio: ViewerAudio;
  gameAudio: GameplayAudioReport;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const tabButtons = useRef<Partial<Record<Category, HTMLButtonElement>>>({});
  const [category, setCategory] = useState<Category>('visuals');
  const [colorDraft, setColorDraft] = useState(settings.crosshairStyle.color);
  const [presetText, setPresetText] = useState('');
  const [presetStatus, setPresetStatus] = useState<'copied' | 'manual' | ''>('');
  const copyGeneration = useRef(0);
  const seconds = new Intl.NumberFormat(locale(), {
    style: 'unit',
    unit: 'second',
    unitDisplay: 'narrow',
  });
  const leadInOptions = (values: number[]) =>
    values.map((value) => ({ value: String(value), label: seconds.format(value) }));
  const style = settings.crosshairStyle;
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => setColorDraft(style.color), [style.color]);
  useLayoutEffect(() => {
    // Invalidate before another interaction with the committed style. A delayed
    // clipboard permission result must never overwrite a later copy attempt.
    copyGeneration.current++;
    setPresetText('');
    setPresetStatus('');
    return () => {
      copyGeneration.current++;
    };
  }, [style]);

  const copyPreset = async () => {
    const generation = ++copyGeneration.current;
    const text = formatCrosshairPreset(style);
    setPresetText(text);
    setPresetStatus('');
    if (!navigator.clipboard?.writeText) {
      setPresetStatus('manual');
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      if (generation === copyGeneration.current) setPresetStatus('copied');
    } catch {
      if (generation === copyGeneration.current) {
        setPresetText(text);
        setPresetStatus('manual');
      }
    }
  };

  const updateCrosshair = <Key extends keyof CrosshairStyle>(
    key: Key,
    value: CrosshairStyle[Key],
  ) => onChange({ ...settings, crosshairStyle: { ...style, [key]: value } });
  const toggle = (key: BooleanSetting, title: string, description?: string) => (
    <ToggleSetting
      key={key}
      label={title}
      description={description}
      checked={settings[key]}
      onChange={(checked) => {
        if (key === 'voice' && checked) void audio.unlock();
        onChange({ ...settings, [key]: checked });
      }}
    />
  );
  const crosshairToggle = (key: 'outline' | 'centerDot' | 'tStyle', label: string) => (
    <label className="viewer-option-toggle">
      <span className="viewer-option-copy">{label}</span>
      <span className="viewer-option-switch">
        <input
          type="checkbox"
          role="switch"
          checked={style[key]}
          onChange={(event) => updateCrosshair(key, event.target.checked)}
        />
        <span className="viewer-option-switch-track" aria-hidden="true" />
      </span>
    </label>
  );
  const panel = (id: Category, children: ReactNode) => (
    <div
      id={'viewer-options-panel-' + id}
      className="viewer-options-panel"
      role="tabpanel"
      aria-labelledby={'viewer-options-tab-' + id}
      hidden={category !== id}
      tabIndex={0}
    >
      {children}
    </div>
  );
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, id: Category) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = categories.findIndex((item) => item.id === id);
    let next = index;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = (index + 1) % categories.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (index + categories.length - 1) % categories.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = categories.length - 1;
    else return;
    event.preventDefault();
    const nextId = categories[next].id;
    setCategory(nextId);
    tabButtons.current[nextId]?.focus();
    tabButtons.current[nextId]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  return (
    <dialog
      ref={dialog}
      className="viewer-options-dialog"
      aria-labelledby="viewer-options-title"
      onCancel={close}
      onClick={(event) => {
        if (event.target === dialog.current) close();
      }}
    >
      <div className="viewer-options-heading">
        <div>
          <h2 id="viewer-options-title">{t('Viewer options')}</h2>
          <p>{t('Saved on this device. The scene updates as you change settings.')}</p>
        </div>
        <button className="icon-button" aria-label={t('Close viewer options')} onClick={close}>
          <X size={20} />
        </button>
      </div>
      <div className="viewer-options-body">
        <div
          className="viewer-options-tabs"
          role="tablist"
          aria-label={t('Viewer settings categories')}
          aria-orientation="horizontal"
        >
          {categories.map(({ id, label }) => (
            <button
              key={id}
              ref={(node) => {
                tabButtons.current[id] = node || undefined;
              }}
              id={'viewer-options-tab-' + id}
              type="button"
              role="tab"
              aria-selected={category === id}
              aria-controls={'viewer-options-panel-' + id}
              tabIndex={category === id ? 0 : -1}
              onClick={() => setCategory(id)}
              onKeyDown={(event) => onTabKeyDown(event, id)}
            >
              <span>{t(label)}</span>
            </button>
          ))}
        </div>
        <div className="viewer-options-content">
          {panel(
            'visuals',
            <>
              <section className="viewer-option-section">
                <h3>{t('Player visibility')}</h3>
                {toggle(
                  'xray',
                  t('X-ray silhouettes'),
                  t('Show player shapes through map geometry.'),
                )}
                {toggle(
                  'playerLabels',
                  t('Player names and health'),
                  t('Show compact player labels. X-ray also makes them visible through walls.'),
                )}
                {toggle(
                  'damageFeedback',
                  t('Damage feedback'),
                  t('Tint the screen edges when the viewed player takes recorded damage.'),
                )}
                <SelectSetting
                  label={t('Flashbang feedback')}
                  value={settings.flashFeedback}
                  options={[
                    { value: 'off', label: t('Off') },
                    { value: 'indicator', label: t('Indicator only') },
                    { value: 'reduced', label: t('Reduced tint') },
                    { value: 'strong', label: t('Strong tint') },
                  ]}
                  description={t('Show the viewed player’s recorded flash state in first person.')}
                  onChange={(value) =>
                    onChange({
                      ...settings,
                      flashFeedback: value as ViewerSettings['flashFeedback'],
                    })
                  }
                />
                {toggle(
                  'shotEffects',
                  t('Shot effects'),
                  t('Show muzzle flashes and weapon movement from recorded shots.'),
                )}
                {toggle(
                  'trails',
                  t('Movement trails'),
                  t('Show the selected player’s recent path.'),
                )}
              </section>
              <section className="viewer-option-section">
                <h3>{t('Match information')}</h3>
                {toggle(
                  'radar',
                  t('Position radar'),
                  t('Show the calibrated overview when this map’s artwork is installed.'),
                )}
                {toggle(
                  'killfeed',
                  t('Elimination feed'),
                  t('Show recent eliminations over the scene.'),
                )}
                {toggle(
                  'utilities',
                  t('Utility zones'),
                  t(
                    'Show recorded detonation markers, available smoke volumes and approximate fire zones.',
                  ),
                )}
                {toggle(
                  'trajectories',
                  t('Grenade paths'),
                  t('Show the recorded flight paths. Grenade projectiles stay visible.'),
                )}
              </section>
              <section className="viewer-option-section">
                <h3>{t('Analysis HUD')}</h3>
                {toggle(
                  'inputs',
                  t('Recorded inputs'),
                  t(
                    'Show sampled movement, attack, and interaction actions for the selected player.',
                  ),
                )}
                {settings.inputs && (
                  <div className="viewer-option-dependent">
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
                    <SelectSetting
                      label={t('Keyboard display layout')}
                      value={settings.inputLayout}
                      onChange={(value) =>
                        onChange({
                          ...settings,
                          inputLayout: value as ViewerSettings['inputLayout'],
                        })
                      }
                      options={[
                        { value: 'wasd', label: 'WASD' },
                        { value: 'zqsd', label: 'ZQSD' },
                      ]}
                    />
                  </div>
                )}
                {toggle(
                  'matchScore',
                  t('Match score and clock'),
                  t('Show recorded side scores, round state and the match clock.'),
                )}
                {toggle(
                  'reviewFeed',
                  t('Kills and utility review'),
                  t('Show a compact round list with perspective replays and utility navigation.'),
                )}
                {toggle(
                  'economy',
                  t('Economy and loadouts'),
                  t('Show every player’s money, carried equipment value, status, and inventory.'),
                )}
                {settings.economy && (
                  <SelectSetting
                    label={t('Player overview layout')}
                    value={settings.teamLayout}
                    onChange={(value) =>
                      onChange({ ...settings, teamLayout: value as ViewerSettings['teamLayout'] })
                    }
                    options={[
                      { value: 'split', label: t('Teams on both sides') },
                      { value: 'right', label: t('Teams on the right') },
                    ]}
                    description={t('On narrow screens, teams share one edge.')}
                  />
                )}
                <p className="viewer-option-note">
                  {t(
                    'Available fields depend on what the demo recorded. Missing input and mouse values are never estimated.',
                  )}
                </p>
              </section>
            </>,
          )}
          {panel(
            'crosshair',
            <>
              <section className="viewer-option-section">
                <h3>{t('Crosshair')}</h3>
                {toggle(
                  'crosshair',
                  t('Crosshair'),
                  t('Show a centered crosshair in player perspective.'),
                )}
                <SelectSetting
                  label={t('Crosshair source')}
                  value={settings.crosshairSource}
                  onChange={(value) =>
                    onChange({ ...settings, crosshairSource: value as 'custom' | 'player' })
                  }
                  options={[
                    { value: 'custom', label: t('Your crosshair') },
                    { value: 'player', label: t('Current player') },
                  ]}
                />
                <div className="viewer-crosshair-preview">
                  {settings.crosshairSource === 'player' ? (
                    <RecordedCrosshair code={playerCrosshairCode} preview />
                  ) : (
                    <Crosshair value={style} preview label={t('Custom crosshair preview')} />
                  )}
                  <div>
                    <strong>
                      {t(
                        settings.crosshairSource === 'player'
                          ? 'Current player'
                          : 'Your review crosshair',
                      )}
                    </strong>
                    <p>
                      {settings.crosshairSource === 'player'
                        ? t(
                            recordedCrosshair(playerCrosshairCode)
                              ? 'Static shape from recorded settings. Weapon spread, recoil and scope animation are not simulated.'
                              : 'No supported crosshair was recorded for this player at this moment.',
                          )
                        : t('This custom crosshair is saved on this device.')}
                    </p>
                  </div>
                </div>
                <div
                  className="viewer-custom-crosshair-controls"
                  hidden={settings.crosshairSource !== 'custom'}
                >
                  <div className="viewer-crosshair-color">
                    <label htmlFor="viewer-crosshair-hex">{t('Crosshair color')}</label>
                    <div>
                      <input
                        type="color"
                        aria-label={t('Crosshair color picker')}
                        value={style.color}
                        onChange={(event) => updateCrosshair('color', event.target.value)}
                      />
                      <input
                        id="viewer-crosshair-hex"
                        type="text"
                        value={colorDraft}
                        maxLength={7}
                        autoComplete="off"
                        spellCheck={false}
                        aria-label={t('Crosshair hex color')}
                        aria-invalid={!/^#[0-9a-f]{6}$/i.test(colorDraft)}
                        onChange={(event) => {
                          const next = event.target.value;
                          setColorDraft(next);
                          if (/^#[0-9a-f]{6}$/i.test(next))
                            updateCrosshair('color', next.toLowerCase());
                        }}
                        onBlur={() => setColorDraft(style.color)}
                      />
                    </div>
                  </div>
                  <RangeSetting
                    label={t('Crosshair length')}
                    value={style.length}
                    {...CROSSHAIR_LIMITS.length}
                    display={style.length + ' px'}
                    onChange={(value) => updateCrosshair('length', value)}
                  />
                  <RangeSetting
                    label={t('Crosshair thickness')}
                    value={style.thickness}
                    {...CROSSHAIR_LIMITS.thickness}
                    display={style.thickness + ' px'}
                    onChange={(value) => updateCrosshair('thickness', value)}
                  />
                  <RangeSetting
                    label={t('Crosshair gap')}
                    value={style.gap}
                    {...CROSSHAIR_LIMITS.gap}
                    display={style.gap + ' px'}
                    onChange={(value) => updateCrosshair('gap', value)}
                  />
                  <RangeSetting
                    label={t('Crosshair opacity')}
                    value={style.opacity}
                    {...CROSSHAIR_LIMITS.opacity}
                    display={Math.round(style.opacity * 100) + '%'}
                    onChange={(value) => updateCrosshair('opacity', value)}
                  />
                  {crosshairToggle('outline', t('Crosshair outline'))}
                  {style.outline && (
                    <RangeSetting
                      label={t('Outline thickness')}
                      value={style.outlineWidth}
                      {...CROSSHAIR_LIMITS.outlineWidth}
                      display={style.outlineWidth + ' px'}
                      onChange={(value) => updateCrosshair('outlineWidth', value)}
                    />
                  )}
                  {crosshairToggle('centerDot', t('Center dot'))}
                  {crosshairToggle('tStyle', t('T-style crosshair'))}
                  <div className="viewer-crosshair-actions">
                    <button className="button" onClick={() => void copyPreset()}>
                      {t('Copy custom preset')}
                    </button>
                    <button
                      className="button"
                      onClick={() =>
                        onChange({ ...settings, crosshairStyle: { ...defaultCrosshairStyle } })
                      }
                    >
                      {t('Reset crosshair')}
                    </button>
                  </div>
                  <p className="viewer-option-note">
                    {t('A cswatch JSON preset, not a CS2 share code.')}
                  </p>
                  {presetStatus === 'copied' && (
                    <p className="viewer-option-note" role="status">
                      {t('Custom preset copied.')}
                    </p>
                  )}
                  {presetStatus === 'manual' && (
                    <label className="viewer-crosshair-copy-fallback">
                      <span>{t('Copy this cswatch preset')}</span>
                      <textarea
                        value={presetText}
                        readOnly
                        rows={4}
                        onFocus={(event) => event.currentTarget.select()}
                      />
                    </label>
                  )}
                </div>
              </section>
            </>,
          )}
          {panel(
            'playback',
            <section className="viewer-option-section">
              <GameplaySoundSettings
                audio={audio}
                report={gameAudio}
                settings={settings}
                onChange={onChange}
              />
              <h3>{t('Communications')}</h3>
              {toggle('voice', t('Recorded voice'))}
              {toggle('subtitles', t('Communication subtitles'))}
              {toggle('chat', t('Text chat'))}
              <h3>{t('Review navigation')}</h3>
              {toggle(
                'grenadeLanding',
                t('Utility replay shortcuts'),
                t('Offer a recent throw replay and recorded landing view.'),
              )}
              {toggle(
                'killReplay',
                t('Kill and death replay shortcuts'),
                t('Offer both recorded perspectives for recent eliminations.'),
              )}
              <SelectSetting
                label={t('Kill and death replay lead-in')}
                value={String(settings.killLeadIn)}
                options={leadInOptions(KILL_LEAD_INS)}
                onChange={(value) => onChange({ ...settings, killLeadIn: Number(value) })}
              />
              <SelectSetting
                label={t('Utility replay lead-in')}
                value={String(settings.utilityLeadIn)}
                options={leadInOptions(UTILITY_LEAD_INS)}
                onChange={(value) => onChange({ ...settings, utilityLeadIn: Number(value) })}
              />
              {toggle('autoSkipFreeze', t('Skip freeze time automatically'))}
              {toggle('autoSkipTimeouts', t('Skip timeouts automatically'))}
              {toggle(
                'autoFollowDeath',
                t('Follow another player after death'),
                t('Switch after three seconds, preferring a living teammate.'),
              )}
              <h3>{t('Viewing interface')}</h3>
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
            </section>,
          )}
          {panel(
            'camera',
            <section className="viewer-option-section">
              <h3>{t('Camera perspective')}</h3>
              <RangeSetting
                label={t('Vertical field of view')}
                value={settings.cameraFov}
                min={40}
                max={110}
                step={1}
                display={settings.cameraFov + '°'}
                description={t(
                  'Changes the vertical field of view for 3D cameras. The 2D view is unaffected.',
                )}
                onChange={(cameraFov) => onChange({ ...settings, cameraFov })}
              />
              <h3>{t('Free camera')}</h3>
              <RangeSetting
                label={t('Look sensitivity')}
                value={settings.lookSensitivity}
                min={0.25}
                max={2}
                step={0.05}
                display={new Intl.NumberFormat(locale()).format(settings.lookSensitivity) + '×'}
                onChange={(lookSensitivity) => onChange({ ...settings, lookSensitivity })}
              />
              {toggle(
                'invertLook',
                t('Invert vertical look'),
                t('Reverse vertical dragging in the free camera on recorded maps.'),
              )}
              <RangeSetting
                label={t('Movement speed')}
                value={settings.freeCameraSpeed}
                min={2}
                max={24}
                step={1}
                display={new Intl.NumberFormat(locale(), {
                  style: 'unit',
                  unit: 'meter-per-second',
                }).format(settings.freeCameraSpeed)}
                onChange={(freeCameraSpeed) => onChange({ ...settings, freeCameraSpeed })}
              />
            </section>,
          )}
          {panel(
            'performance',
            <section className="viewer-option-section">
              <h3>{t('Rendering')}</h3>
              <SelectSetting
                label={t('Rendering quality')}
                value={settings.quality}
                onChange={(value) =>
                  onChange({ ...settings, quality: value as ViewerSettings['quality'] })
                }
                options={[
                  { value: 'auto', label: t('Auto · mobile friendly') },
                  { value: 'compact', label: t('Compact 3D · simplified map') },
                  { value: 'low', label: t('Low · reduced resolution, no shadows') },
                  { value: 'high', label: t('High · shadows, higher resolution') },
                ]}
              />
              <RangeSetting
                label={t('3D render resolution')}
                value={settings.renderResolution}
                min={RENDER_RESOLUTION_MIN}
                max={RENDER_RESOLUTION_MAX}
                step={5}
                display={new Intl.NumberFormat(locale(), { style: 'percent' }).format(
                  settings.renderResolution / 100,
                )}
                description={t(
                  'Auto adjusts resolution during playback up to this limit and may pause live shadows under sustained load.',
                )}
                onChange={(renderResolution) => onChange({ ...settings, renderResolution })}
              />
              {settings.quality === 'auto' &&
                renderResolution !== undefined &&
                renderResolution < settings.renderResolution && (
                  <p className="viewer-option-note">
                    {t('Auto is rendering at {{resolution}}', {
                      resolution: new Intl.NumberFormat(locale(), { style: 'percent' }).format(
                        renderResolution / 100,
                      ),
                    })}
                  </p>
                )}
              {settings.quality === 'auto' && shadowsPaused && (
                <p className="viewer-option-note">{t('Auto has paused live shadows.')}</p>
              )}
              <p className="viewer-option-note">
                {t(
                  'Recorded grenades remain visible at every quality level. Paths and analytical zones have separate controls.',
                )}
              </p>
              <p className="viewer-option-note">
                {t(
                  'Smoke uses recorded volume data when available. Otherwise, smoke and fire zones show approximate event locations and durations.',
                )}
              </p>
              <p className="viewer-option-note">
                {t(
                  'Installed character cycles approximate locomotion from recorded speed and crouch. They do not reproduce the recorded animation graph.',
                )}
              </p>
              {mapAcquisition && (
                <MapDetails acquisition={mapAcquisition} recorded={recordedMapIdentity} />
              )}
              {equipment && (
                <div
                  className="viewer-equipment-report"
                  role="group"
                  aria-label={t('Equipment model status')}
                >
                  <h4>{t('Equipment models')}</h4>
                  <dl className="viewer-equipment-status">
                    <div>
                      <dt>{t('Ready models')}</dt>
                      <dd>{equipment.ready}</dd>
                    </div>
                    <div>
                      <dt>{t('Loading models')}</dt>
                      <dd>{equipment.pending}</dd>
                    </div>
                    <div>
                      <dt>{t('Unavailable models')}</dt>
                      <dd>{equipment.unavailable}</dd>
                    </div>
                    <div>
                      <dt>{t('Failed models')}</dt>
                      <dd>{equipment.failed}</dd>
                    </div>
                  </dl>
                  {equipment.status === 'error' && (
                    <p className="viewer-option-note">
                      {t('Equipment models could not be checked. Reopen the viewer to retry.')}
                    </p>
                  )}
                  {equipment.status === 'missing' && (
                    <p className="viewer-option-note">
                      {t('No equipment model pack is installed.')}
                    </p>
                  )}
                  {!equipment.active && (
                    <p className="viewer-option-note">{t('Equipment models load in a 3D view.')}</p>
                  )}
                  <p className="viewer-option-note">
                    {t(
                      'Held models follow an installed character’s weapon bone when available. POV models use approximate presets without first-person arms or recoil.',
                    )}
                  </p>
                </div>
              )}
            </section>,
          )}
        </div>
      </div>
      <div className="viewer-options-footer">
        <MessageSquareText size={18} aria-hidden="true" />
        <p>{t('Voice, communication subtitles and text chat have their own review controls.')}</p>
        <button className="button" onClick={openCommunications}>
          {t('Review communications')}
        </button>
      </div>
    </dialog>
  );
}
