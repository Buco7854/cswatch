import { locale } from './i18n';
import { replayIdentity } from './steam-replay-folder';

export function steamMatchLink(matchId: string, shareCode?: string | null) {
  const identity = shareCode && replayIdentity(matchId, shareCode);
  if (!identity) return;
  return {
    identity,
    url: 'steam://rungame/730/76561202255233023/+csgo_download_match%20' + shareCode,
  };
}

export function faceitRoomUrl(matchId: string) {
  const language = locale() === 'fr-FR' ? 'fr' : 'en';
  return 'https://www.faceit.com/' + language + '/cs2/room/' + encodeURIComponent(matchId);
}
