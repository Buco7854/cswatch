import { useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquareText, Play, Volume2, X } from 'lucide-react';
import { api } from '../api';
import { useApp } from '../context';
import { t } from '../i18n';
import type { Playback } from '../types';
import type { CaptionCue } from '../../../shared/communications';
import { frameAt, type ViewerSettings } from '../playback';
import { VoicePlayback } from '../voice-playback';
import { SelectControl } from './Controls';
import './communications.css';

type Captions = {
  status: 'disabled' | 'queued' | 'processing' | 'ready' | 'partial' | 'failed' | 'unavailable';
  cues: CaptionCue[];
};
const clock = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.floor(Math.max(0, seconds) % 60)).padStart(2, '0')}`;

export default function Communications({
  id,
  owned,
  data,
  tick,
  first,
  playing,
  speed,
  selected,
  settings,
  onChange,
  open,
  close,
  onSeek,
}: {
  id: string;
  data: Playback;
  tick: number;
  first: number;
  playing: boolean;
  speed: number;
  selected: string;
  settings: ViewerSettings;
  onChange: (settings: ViewerSettings) => void;
  open: boolean;
  close: () => void;
  onSeek: (tick: number) => void;
  owned: boolean;
}) {
  const { config } = useApp();
  const sampleExample = id === 'sample' && data.sample === true;
  const isSampleCue = (cue: CaptionCue) => sampleExample && cue.id.startsWith('sample-caption-');
  const captionText = (cue: CaptionCue) => (isSampleCue(cue) ? t(cue.text) : cue.text);
  const dialog = useRef<HTMLDialogElement>(null);
  const engine = useRef<VoicePlayback | null>(null);
  const [audioError, setAudioError] = useState('');
  const [captionError, setCaptionError] = useState('');
  const [captions, setCaptions] = useState<Captions>({ status: 'unavailable', cues: [] });
  const [captionsFor, setCaptionsFor] = useState(id);
  const [tab, setTab] = useState('voice');
  const [limit, setLimit] = useState(100);
  const [muted, setMuted] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const [retryBusy, setRetryBusy] = useState(false);
  async function retryTranscription() {
    if (!owned || retryBusy) return;
    setRetryBusy(true);
    setCaptionError('');
    try {
      await api(`/api/demos/${id}/captions/retry`, { method: 'POST', body: '{}' });
      setRetry((value) => value + 1);
    } catch (error) {
      setCaptionError((error as Error).message);
    } finally {
      setRetryBusy(false);
    }
  }
  useEffect(() => {
    setCaptions({ status: 'unavailable', cues: [] });
    setCaptionsFor(id);
    setMuted([]);
    setAudioError('');
    setCaptionError('');
  }, [id]);
  useEffect(() => {
    const audio = new VoicePlayback(setAudioError);
    engine.current = audio;
    return () => {
      audio.close();
      engine.current = null;
    };
  }, [id]);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (!settings.voice || !playing) engine.current?.stop();
    else void engine.current?.unlock();
  }, [settings.voice, playing, id]);
  const frame = frameAt(data, tick).frame;
  const selectedTeam = frame.players.find((player) => player.id === selected)?.team;
  const speakers = useMemo(() => {
    const available =
      settings.voiceScope === 'all'
        ? [
            ...new Set([
              ...data.players.map((player) => player.id),
              ...(data.voice || []).map((packet) => packet.speaker),
            ]),
          ]
        : settings.voiceScope === 'team' && selectedTeam !== undefined
          ? frame.players
              .filter((player) => player.team === selectedTeam)
              .map((player) => player.id)
          : [selected];
    return available.filter((speaker) => !muted.includes(speaker)).sort();
  }, [data.players, data.voice, frame.players, selected, selectedTeam, settings.voiceScope, muted]);
  const speakerKey = speakers.join(',');
  useEffect(() => {
    if (settings.voice && playing)
      engine.current?.sync(
        data.voice || [],
        tick,
        data.tickRate,
        speed,
        settings.voiceVolume,
        speakers,
      );
  }, [
    tick,
    data.voice,
    data.tickRate,
    playing,
    speed,
    settings.voice,
    settings.voiceVolume,
    speakerKey,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    if (!settings.subtitles && !open) return () => controller.abort();
    setCaptionError('');
    if (id === 'sample') {
      setCaptions({
        status: data.captions?.length ? 'ready' : 'unavailable',
        cues: data.captions || [],
      });
      setCaptionsFor(id);
      return () => controller.abort();
    }
    const load = async () => {
      try {
        const result = await api<Captions>(`/api/demos/${id}/captions`, {
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        setCaptions(result);
        setCaptionsFor(id);
        if (['queued', 'processing'].includes(result.status)) timer = setTimeout(load, 5000);
      } catch (error) {
        if (!controller.signal.aborted) setCaptionError((error as Error).message);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, settings.subtitles, open, retry]);
  useEffect(() => {
    setLimit(100);
  }, [tab, id]);
  const name = (speaker: string | null) =>
    data.players.find((player) => player.id === speaker)?.name || t('Unknown speaker');
  const permitted = (speaker: string | null) =>
    settings.voiceScope === 'all'
      ? !speaker || !muted.includes(speaker)
      : speaker !== null && speakers.includes(speaker);
  const cues = captionsFor === id ? captions.cues : [];
  const previewExample = () => {
    const cue = data.captions?.find(isSampleCue);
    if (!cue) return;
    onChange({ ...settings, subtitles: true });
    onSeek(cue.startTick);
    close();
  };
  const visibleCaptions = cues
    .filter(
      (cue) =>
        cue.startTick <= tick && cue.endTick > tick && (isSampleCue(cue) || permitted(cue.speaker)),
    )
    .slice(-3);
  const chat = data.chat || [];
  const visibleChat = chat
    .filter((message) => message.tick <= tick && message.tick > tick - data.tickRate * 8)
    .slice(-3);
  const recordedVoice =
    ['available', 'partial'].includes(data.communications?.voice || '') ||
    Boolean(data.voice?.length);
  const allSpeakers = [
    ...new Set([
      ...data.players.map((player) => player.id),
      ...(data.voice || []).map((packet) => packet.speaker),
    ]),
  ];
  const toggle = (
    key: 'voice' | 'subtitles' | 'chat',
    label: string,
    description: string,
    disabled = false,
  ) => (
    <label className="toggle-row">
      <span>
        {label}
        <small>{description}</small>
      </span>
      <input
        role="switch"
        type="checkbox"
        checked={settings[key]}
        disabled={disabled}
        onChange={(event) => onChange({ ...settings, [key]: event.target.checked })}
      />
    </label>
  );
  const captionStatus = () => {
    if (sampleExample)
      return t('Synthetic captions for the practice scene. No speech was recorded or transcribed.');
    if (captionError) return t('Subtitles could not be loaded.');
    if (captions.status === 'queued')
      return t('Local subtitles are queued. You can keep reviewing.');
    if (captions.status === 'processing')
      return t('Generating subtitles locally. Replay playback remains available.');
    if (captions.status === 'partial')
      return t(
        'Some recorded voice remains untranscribed because the processing budget was reached.',
      );
    if (captions.status === 'failed')
      return t('Subtitle generation failed. The replay and recorded voice are still available.');
    if (captions.status === 'disabled')
      return t('Local speech transcription is disabled or its model is not configured.');
    if (captions.status === 'unavailable')
      return t('No transcribable recorded voice is available for this demo.');
    return t('Generated locally. Check important calls against the recording.');
  };
  return (
    <>
      {(settings.subtitles || settings.chat) && (
        <div className="communication-overlay" aria-live="off">
          {settings.chat &&
            visibleChat.map((message) => (
              <div className="chat-caption" key={message.id}>
                <MessageSquareText size={15} />
                <p>
                  <strong>{message.name || name(message.speaker)}</strong> {message.text}
                </p>
              </div>
            ))}
          {settings.subtitles &&
            visibleCaptions.map((cue) => (
              <div
                className={'voice-caption' + (isSampleCue(cue) ? ' is-synthetic' : '')}
                key={cue.id}
              >
                {isSampleCue(cue) ? (
                  <>
                    <MessageSquareText size={16} />
                    <div className="caption-example-copy">
                      <span className="caption-example-label">{t('Synthetic example')}</span>
                      <p>
                        <strong>{name(cue.speaker)}</strong> {captionText(cue)}
                      </p>
                    </div>
                  </>
                ) : (
                  <>
                    <Volume2 size={16} />
                    <p>
                      <strong>{name(cue.speaker)}</strong> {cue.text}
                    </p>
                  </>
                )}
              </div>
            ))}
        </div>
      )}
      {open && (
        <dialog
          ref={dialog}
          className="member-dialog options-dialog communications-dialog"
          aria-labelledby="communications-title"
          onCancel={close}
          onClick={(event) => {
            if (event.target === dialog.current) close();
          }}
        >
          <div className="panel-heading">
            <h2 id="communications-title">{t('Communications')}</h2>
            <button className="icon-button" aria-label={t('Close communications')} onClick={close}>
              <X size={20} />
            </button>
          </div>
          <p>
            {t(
              'Recorded voice, local subtitles and demo chat. Display choices stay on this device.',
            )}
          </p>
          {sampleExample && data.captions?.length ? (
            <section className="subtitle-example-guide" aria-label={t('Subtitle example')}>
              <div>
                <strong>{t('Synthetic example')}</strong>
                <p>{t('Authored sample captions with no recorded audio.')}</p>
              </div>
              <button className="button" onClick={previewExample}>
                <Play size={15} />
                {t('Preview subtitle example')}
              </button>
            </section>
          ) : null}
          <nav className="tabs" aria-label={t('Communication view')}>
            {['voice', 'subtitles', 'chat'].map((value) => (
              <button
                key={value}
                className={tab === value ? 'active' : ''}
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
              >
                {t(value === 'voice' ? 'Voice' : value === 'subtitles' ? 'Subtitles' : 'Chat')}
              </button>
            ))}
          </nav>
          {tab === 'voice' ? (
            <section>
              {toggle(
                'voice',
                t('Recorded voice'),
                t('Play recorded Opus voice at the current replay speed.'),
                !recordedVoice,
              )}
              {!recordedVoice && (
                <p className="muted">
                  {t(
                    data.communications?.voice === 'unsupported'
                      ? 'Recorded voice could not be read or uses an unsupported codec.'
                      : 'This demo has no playable recorded voice.',
                  )}
                </p>
              )}
              {data.communications?.voice === 'partial' && (
                <p className="muted">
                  {t('Some recorded voice packets were unavailable or unsupported.')}
                </p>
              )}
              <label>
                {t('Voice perspective')}
                <SelectControl
                  label={t('Voice perspective')}
                  value={settings.voiceScope}
                  onValueChange={(value) =>
                    onChange({ ...settings, voiceScope: value as ViewerSettings['voiceScope'] })
                  }
                  options={[
                    { value: 'selected', label: t('Selected player') },
                    { value: 'team', label: t('Selected team') },
                    { value: 'all', label: t('All recorded speakers') },
                  ]}
                />
              </label>
              <label className="voice-volume">
                {t('Voice volume')}
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(settings.voiceVolume * 100)}
                  aria-label={t('Voice volume')}
                  onChange={(event) =>
                    onChange({ ...settings, voiceVolume: Number(event.target.value) / 100 })
                  }
                />
                <output>{Math.round(settings.voiceVolume * 100)}%</output>
              </label>
              {audioError && (
                <div role="status" className="communication-notice">
                  <p>{t(audioError)}</p>
                  {audioError.startsWith('Press ') && (
                    <button className="button" onClick={() => void engine.current?.unlock()}>
                      {t('Enable audio')}
                    </button>
                  )}
                </div>
              )}
              {recordedVoice && (
                <fieldset className="speaker-mutes">
                  <legend>{t('Mute individual speakers')}</legend>
                  {allSpeakers.map((speaker) => (
                    <label key={speaker}>
                      <input
                        type="checkbox"
                        checked={muted.includes(speaker)}
                        onChange={(event) =>
                          setMuted((previous) =>
                            event.target.checked
                              ? [...previous, speaker]
                              : previous.filter((id) => id !== speaker),
                          )
                        }
                      />
                      {name(speaker)}
                    </label>
                  ))}
                </fieldset>
              )}
            </section>
          ) : tab === 'subtitles' ? (
            <section>
              {toggle(
                'subtitles',
                t('Communication subtitles'),
                t('Show timestamped speech captions over the scene.'),
              )}
              <p className="muted" role="status">
                {captionStatus()}
              </p>
              {captionError && (
                <button className="button" onClick={() => setRetry((value) => value + 1)}>
                  {t('Try again')}
                </button>
              )}
              {owned &&
                recordedVoice &&
                config.transcription_enabled &&
                config.transcription_configured &&
                ['failed', 'unavailable', 'disabled'].includes(captions.status) && (
                  <button
                    className="button"
                    disabled={retryBusy}
                    onClick={() => void retryTranscription()}
                  >
                    {retryBusy ? t('Queuing subtitles…') : t('Generate subtitles')}
                  </button>
                )}
              <div className="communication-list">
                {cues.slice(0, limit).map((cue) => (
                  <button className="event-row" key={cue.id} onClick={() => onSeek(cue.startTick)}>
                    <time className="num">{clock((cue.startTick - first) / data.tickRate)}</time>
                    <span>
                      <strong>{name(cue.speaker)}</strong>
                      {captionText(cue)}
                    </span>
                    <Play size={14} />
                  </button>
                ))}
              </div>
              {cues.length > limit && (
                <button className="text-button" onClick={() => setLimit((value) => value + 100)}>
                  {t('Load more subtitles')}
                </button>
              )}
            </section>
          ) : (
            <section>
              {toggle(
                'chat',
                t('Chat overlay'),
                t('Show recent recorded text messages over the scene.'),
                !chat.length,
              )}
              {!chat.length && (
                <p className="muted">
                  {t(
                    data.communications?.chat === 'encrypted'
                      ? 'The demo chat is encrypted and its matching key was not supplied.'
                      : 'No readable chat messages were recorded in this demo.',
                  )}
                </p>
              )}
              {data.communications?.chat === 'partial' && (
                <p className="muted">{t('Some messages are encrypted or could not be read.')}</p>
              )}
              <div className="communication-list">
                {chat.slice(0, limit).map((message) => (
                  <button
                    className="event-row"
                    key={message.id}
                    onClick={() => onSeek(message.tick)}
                  >
                    <time className="num">{clock((message.tick - first) / data.tickRate)}</time>
                    <span>
                      <strong>{message.name || name(message.speaker)}</strong>
                      {message.text}
                    </span>
                    <Play size={14} />
                  </button>
                ))}
              </div>
              {chat.length > limit && (
                <button className="text-button" onClick={() => setLimit((value) => value + 100)}>
                  {t('Load more messages')}
                </button>
              )}
            </section>
          )}
        </dialog>
      )}
    </>
  );
}
