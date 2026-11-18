/** Low-level media parsing runs only in the disposable, networkless parser child. */
import { DemoReader, EntityMode } from 'cs2parser';
import type { VoicePacket, ChatMessage, CommunicationInfo } from '../../shared/communications.js';
import { voiceFrames } from './voice-packets.js';
import { observeObjectives } from './objectives.js';
import { observeMatchState } from './match-state.js';
import { observeCrosshairs } from './crosshairs.js';
import { observeItemState } from './item-state.js';
import { observeMapIdentity } from './map-identity.js';

export async function readCommunications(
  path: string,
  tickRate: number,
  lastTick: number,
  actors: ReadonlySet<string>,
) {
  const voice: VoicePacket[] = [],
    chat: ChatMessage[] = [];
  const reader = new DemoReader();
  const finishMapIdentity = observeMapIdentity(reader);
  const finishObjectives = observeObjectives(reader, tickRate, lastTick);
  const finishMatchState = observeMatchState(reader, tickRate, lastTick);
  const finishCrosshairs = observeCrosshairs(reader, lastTick, actors);
  const finishItems = observeItemState(reader, lastTick);
  let unsupported = 0,
    encrypted = 0,
    bytes = 0,
    truncated = false;
  reader.on('svc_VoiceData', (message) => {
    if (!message.audio?.voice_data?.length) return;
    try {
      const speaker = message.xuid;
      if (typeof speaker !== 'string' || !/^\d{1,20}$/.test(speaker) || speaker === '0')
        throw new Error('Missing voice identity');
      if (
        (message.audio.format ?? 0) === 0 &&
        message.audio.voice_data.length >= 8 &&
        Buffer.from(message.audio.voice_data).readBigUInt64LE(0).toString() !== speaker
      )
        throw new Error('Voice identity mismatch');
      const base = Number.isFinite(message.tick) ? message.tick! : reader.currentTick;
      if (base < 0 || base > lastTick) return;
      let elapsed = 0;
      for (const part of voiceFrames(message.audio)) {
        bytes += part.data.byteLength;
        if (bytes > 64 * 1024 ** 2 || voice.length >= 250000) {
          truncated = true;
          throw new Error('Voice output limit');
        }
        voice.push({
          id: `voice-${voice.length}`,
          speaker,
          tick: base + (elapsed * tickRate) / 1000,
          opus: Buffer.from(part.data).toString('base64'),
          sampleRate: part.sampleRate,
          channels: part.channels,
          durationMs: part.durationMs,
        });
        elapsed += part.durationMs;
      }
    } catch {
      unsupported++;
    }
  });
  reader.on('svc_EncryptedData', () => {
    encrypted++;
  });
  reader.on('chat', (message) => {
    if (chat.length >= 10000) {
      truncated = true;
      return;
    }
    const tick = reader.currentTick;
    if (!Number.isSafeInteger(tick) || tick < 0 || tick > lastTick) return;
    const info = message.playerInfo,
      id = info?.xuid;
    const token = message.messageName || '';
    chat.push({
      id: `chat-${chat.length}`,
      tick,
      speaker: typeof id === 'string' && /^\d{1,20}$/.test(id) ? id : null,
      name: typeof info?.name === 'string' ? info.name.slice(0, 256) : '',
      text: message.text.slice(0, 1000).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''),
      channel: /(?:_CT|_T_|_Team)/.test(token) ? 'team' : token.includes('All') ? 'all' : 'unknown',
    });
  });
  let failed = false;
  try {
    const result = await reader.parseDemo(path, { entities: EntityMode.ALL });
    failed = result.status !== 'complete';
  } catch {
    failed = true;
  }
  voice.sort((a, b) => a.tick - b.tick);
  chat.sort((a, b) => a.tick - b.tick);
  const communications: CommunicationInfo = {
    voice: voice.length
      ? unsupported || truncated || failed
        ? 'partial'
        : 'available'
      : unsupported || failed
        ? 'unsupported'
        : 'absent',
    chat: chat.length
      ? encrypted || failed
        ? 'partial'
        : 'available'
      : encrypted
        ? 'encrypted'
        : failed
          ? 'partial'
          : 'absent',
    captions: voice.length ? 'disabled' : 'unavailable',
    unsupportedPackets: unsupported,
  };
  const warnings: string[] = [];
  if (failed) warnings.push('Some communication data could not be read.');
  if (unsupported)
    warnings.push('Some recorded voice packets use an unsupported or invalid codec.');
  if (truncated) warnings.push('Communication data reached the processing limit.');
  const objectives = finishObjectives(!failed);
  const matchState = finishMatchState(!failed);
  const items = finishItems(!failed);
  if (!items.complete) warnings.push('Some recorded world equipment state could not be read.');
  if (!objectives.complete) warnings.push('Some bomb objective state could not be read.');
  if (!matchState.complete) warnings.push('Some recorded match state could not be read.');
  return {
    voice,
    chat,
    mapIdentity: finishMapIdentity(),
    communications,
    objectives,
    matchState,
    crosshairs: finishCrosshairs(!failed),
    itemSamples: items.samples,
    itemState: { complete: items.complete, coverage: items.coverage },
    warnings,
  };
}
