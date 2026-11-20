import { ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';
import { t } from '../i18n';
import { useApp } from '../context';
import './imports-guide.css';

export type GuidedSource = 'steam' | 'faceit' | 'hltv';
export const STEAM_GAME_DATA = 'https://steamcommunity.com/my/gcpd/730/';
const sources = {
  steam: {
    instruction: 'Find the match in Steam and choose Download Replay if it is available.',
    label: 'Open Steam match history',
    url: STEAM_GAME_DATA,
  },
  faceit: {
    instruction: 'Download the demo from the completed FACEIT match room.',
    label: 'Open FACEIT',
    url: 'https://www.faceit.com/en/cs2',
  },
  hltv: {
    instruction: 'Download the demo from the match page and pick the map you want to review.',
    label: 'Find demos on HLTV',
    url: 'https://www.hltv.org/results?content=demo',
  },
} satisfies Record<GuidedSource, { instruction: string; label: string; url: string }>;

export default function ImportGuide({ source }: { source: GuidedSource }) {
  const { config } = useApp();
  const { instruction, label, url } = sources[source];
  return (
    <div className="demo-import-guide">
      <p>{t(instruction)}</p>
      <a className="demo-source-link" href={url} target="_blank" rel="noreferrer">
        {t(label)} <ExternalLink size={14} aria-hidden="true" />
      </a>
      <p>{t('Extract archive downloads to get the .dem file.')}</p>
      {source === 'steam' && (
        <details className="import-guide-help">
          <summary>{t('Already downloaded it inside CS2?')}</summary>
          <p>{t('In Steam, browse CS2’s installed files and open this folder.')}</p>
          <code>game/csgo/replays</code>
        </details>
      )}
      {source === 'faceit' && config.faceit_enabled && config.faceit_downloads && (
        <Link className="demo-source-link" to="/account/connections">
          {t('Manage connected accounts')}
        </Link>
      )}
    </div>
  );
}
