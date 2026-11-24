export const gameplayAudioLimits: Readonly<{
  bankItems: number;
  bytes: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  bankBytes: number;
}>;
export function inspectGameplayAudio(input: Uint8Array | ArrayBuffer): {
  mime: 'audio/wav';
  extension: 'wav';
  durationMs: number;
  sampleRate: number;
  channels: number;
  decodedBytes: number;
};
