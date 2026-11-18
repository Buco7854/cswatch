import { ArrowUpRight, ExternalLink, UploadCloud } from 'lucide-react';
import { Link } from 'react-router-dom';
import { t } from '../i18n';
import { useApp } from '../context';
import './imports-guide.css';

export type GuidedSource = 'steam' | 'faceit' | 'hltv';
export const STEAM_GAME_DATA = 'https://steamcommunity.com/my/gcpd/730/';

/** Provider authentication and a replay file are separate resources. Never imply login downloads it. */
export default function ImportGuide({
  source,
  chooseFile,
  disabled,
}: {
  source: GuidedSource;
  chooseFile: () => void;
  disabled: boolean;
}) {
  const { config } = useApp();
  return (
    <div className="demo-import-guide">
      {source === 'steam' ? (
        <>
          <div className="import-guide-intro">
            <h3>{t('Your Premier, Competitive or Wingman match')}</h3>
            <p>
              {t(
                'Get the replay from Steam, then upload the demo here. Linking Steam is optional for this upload.',
              )}
            </p>
          </div>
          <ol>
            <li>
              <strong>{t('Open your CS2 match history.')}</strong>
              <p>
                {t(
                  'In Steam Personal Game Data, choose the history for Premier, Competitive or Wingman. Select Download Replay when the match offers it.',
                )}
              </p>
              <a className="button" href={STEAM_GAME_DATA} target="_blank" rel="noreferrer">
                {t('Open Steam match history')}
                <ExternalLink size={14} />
              </a>
            </li>
            <li>
              <strong>{t('Save the demo file.')}</strong>
              <p>
                {t(
                  'If Steam downloads a .bz2, .gz or archive file, extract it on your device first. Use the .dem file, or keep a .dem.zst file compressed. A .dem.info file is only metadata.',
                )}
              </p>
            </li>
            <li>
              <strong>{t('Upload your private copy.')}</strong>
              <p>
                {t(
                  'Choose the replay file below. Processing runs on this instance. You can watch the demo when it is ready.',
                )}
              </p>
            </li>
          </ol>
          <details className="import-guide-help">
            <summary>{t('Already downloaded it inside CS2?')}</summary>
            <p>
              {t(
                'Open Watch → Your Matches in CS2, select the match and download it. In Steam, browse CS2’s installed files, then look in the game/csgo/replays folder for the .dem file.',
              )}
            </p>
            <code>game/csgo/replays</code>
            <p>
              {t(
                'Your Steam library can be installed on another drive. Browse the installed files instead of assuming a fixed system path.',
              )}
            </p>
          </details>
          <p className="import-guide-availability">
            {t(
              'Valve controls replay availability, and downloads can expire. If no replay is offered, cswatch cannot recover it. A just-finished match may become available later.',
            )}
          </p>
          <p className="import-guide-reference">
            <a
              href="https://help.steampowered.com/en/faqs/view/55F0-5092-0365-2461"
              target="_blank"
              rel="noreferrer"
            >
              {t('Steam help: finding Personal Game Data')}
              <ArrowUpRight size={12} />
            </a>
          </p>
        </>
      ) : source === 'faceit' ? (
        <>
          <div className="import-guide-intro">
            <h3>{t('Your FACEIT match')}</h3>
            <p>
              {t(
                'Download the CS2 demo from your completed FACEIT match room, then upload the file here.',
              )}
            </p>
          </div>
          <ol>
            <li>
              <strong>{t('Open the completed match room.')}</strong>
              <p>
                {t(
                  'Sign in on FACEIT and find the match. Use its Watch demo or Download demo action when available.',
                )}
              </p>
              <a
                className="button"
                href="https://www.faceit.com/en/cs2"
                target="_blank"
                rel="noreferrer"
              >
                {t('Open FACEIT')}
                <ExternalLink size={14} />
              </a>
            </li>
            <li>
              <strong>{t('Prepare the replay file.')}</strong>
              <p>
                {t(
                  'Keep .dem.zst compressed. Extract other compressed or archive downloads until you have a .dem file.',
                )}
              </p>
            </li>
            <li>
              <strong>{t('Upload your private copy.')}</strong>
              <p>
                {t(
                  'Choose the replay file below. Processing runs on this instance. You can watch the demo when it is ready.',
                )}
              </p>
            </li>
          </ol>
          {config.faceit_enabled && (
            <p className="import-guide-availability">
              {t(
                'Connected FACEIT history is also available in your account. Automatic imports require this instance’s approved Downloads API access.',
              )}{' '}
              <Link to="/account/connections">
                {t('Manage connected accounts')}
                <ArrowUpRight size={13} />
              </Link>
            </p>
          )}
        </>
      ) : (
        <>
          <div className="import-guide-intro">
            <h3>{t('An HLTV or tournament match')}</h3>
            <p>
              {t('Download the CS2 demo from its original match page, then upload the file here.')}
            </p>
          </div>
          <ol>
            <li>
              <strong>{t('Find the match source.')}</strong>
              <p>
                {t(
                  'On HLTV, open the completed match and follow its demo link. Use the tournament’s own replay source when it provides one.',
                )}
              </p>
              <a
                className="button"
                href="https://www.hltv.org/results?content=demo"
                target="_blank"
                rel="noreferrer"
              >
                {t('Find demos on HLTV')}
                <ExternalLink size={14} />
              </a>
            </li>
            <li>
              <strong>{t('Extract the map you want.')}</strong>
              <p>
                {t(
                  'A series archive can contain several maps. Extract it on your device and choose one .dem, or upload a .dem.zst directly.',
                )}
              </p>
            </li>
            <li>
              <strong>{t('Upload your private copy.')}</strong>
              <p>
                {t(
                  'Choose the replay file below. Processing runs on this instance. You can watch the demo when it is ready.',
                )}
              </p>
            </li>
          </ol>
        </>
      )}
      <div className="import-guide-actions">
        <button
          type="button"
          className="button primary import-guide-upload"
          disabled={disabled}
          onClick={chooseFile}
        >
          <UploadCloud size={16} />
          {t('Choose demo file')}
        </button>
      </div>
    </div>
  );
}
