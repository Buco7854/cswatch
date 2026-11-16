/** Recorded media stays under the same ownership and access policy as its demo. */
export type VoicePacket = {
  id: string;
  speaker: string;
  tick: number;
  /** One validated raw Opus packet, base64; no external URLs or executable content. */
  opus: string;
  sampleRate: 8000 | 12000 | 16000 | 24000 | 48000;
  channels: 1 | 2;
  durationMs: number;
};
export type ChatMessage = {
  id: string;
  tick: number;
  speaker: string | null;
  name: string;
  text: string;
  channel: 'all' | 'team' | 'unknown';
};
export type CaptionCue = {
  id: string;
  startTick: number;
  endTick: number;
  speaker: string | null;
  text: string;
  source: 'local-transcription' | 'imported';
  language?: string;
};
export type CommunicationInfo = {
  voice: 'available' | 'absent' | 'unsupported' | 'partial';
  chat: 'available' | 'absent' | 'encrypted' | 'partial';
  captions: 'disabled' | 'ready' | 'partial' | 'failed' | 'unavailable';
  unsupportedPackets: number;
};
