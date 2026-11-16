import { Link, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ArrowRight,
  ChevronRight,
  Menu,
  X,
  Sun,
  Moon,
  Play,
  Upload,
  Eye,
  Server,
  LogIn,
} from 'lucide-react';
import i18n, { t, setLanguage, type Language } from '../i18n';
import { useApp } from '../context';
import Brand from './Brand';
import ReviewPreview from './ReviewPreview';
import { UtilityProof, NoteProof } from './PublicProofs';
import { sample } from '../sample';

export function PublicShell({
  children,
  theme,
  toggleTheme,
}: {
  children: React.ReactNode;
  theme: string;
  toggleTheme: () => void;
}) {
  const { user, config, signIn } = useApp(),
    location = useLocation(),
    [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [location.pathname]);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add('public-enter');
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.12 },
    );
    document
      .querySelectorAll(
        '.public-site .section-intro>*,.public-site .feature-ledger>a,.public-site .review-story>div,.public-site .public-tool-proofs>article,.public-site .public-faq>div,.public-site .public-final>*',
      )
      .forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [location.pathname]);

  return (
    <div className="public-site">
      <header className="public-header">
        <Brand />
        <nav className={menu ? 'public-nav open' : 'public-nav'} aria-label={t('Main navigation')}>
          <Link to="/features/viewer">{t('Viewer')}</Link>
          <Link to="/features/imports">{t('Imports')}</Link>
          <Link to="/self-host">{t('Self-host')}</Link>
          {config.public_access && <Link to="/explore">{t('Explore')}</Link>}
        </nav>
        <div className="public-utilities">
          <select
            aria-label={t('Language')}
            value={i18n.language}
            onChange={(e) => setLanguage(e.target.value as Language)}
          >
            <option value="en">EN</option>
            <option value="fr">FR</option>
          </select>
          <button
            className="icon-button"
            aria-label={t(theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme')}
            onClick={toggleTheme}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          {user ? (
            <Link className="button primary" to="/library">
              {t('Open workspace')}
              <ArrowUpRight size={16} />
            </Link>
          ) : (
            <button className="button public-signin" aria-label={t('Sign in')} onClick={signIn}>
              {t('Sign in')}
              <LogIn size={15} />
            </button>
          )}
          <button
            className="icon-button public-menu-toggle"
            aria-expanded={menu}
            aria-label={t('Toggle navigation')}
            onClick={() => setMenu(!menu)}
          >
            {menu ? <X size={21} /> : <Menu size={21} />}
          </button>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="public-footer">
        <div>
          <Brand />
          <p>{t('The round is over. The review starts here.')}</p>
        </div>
        <nav aria-label={t('Footer navigation')}>
          <Link to="/features/viewer">{t('Viewer')}</Link>
          <Link to="/features/imports">{t('Imports')}</Link>
          <Link to="/self-host">{t('Self-host')}</Link>
          <a href="https://github.com/Buco7854/cswatch" target="_blank" rel="noreferrer">
            GitHub
            <ArrowUpRight size={13} />
          </a>
        </nav>
        <small>{t('Independent project. Not affiliated with Valve or FACEIT.')}</small>
      </footer>
    </div>
  );
}
function ImportAction() {
  const { user, config } = useApp();
  return (
    <Link className="button primary" to="/library?upload=1">
      {t(
        user
          ? 'Upload a demo'
          : config.registrations_enabled
            ? 'Start your review'
            : 'Sign in to upload',
      )}
      <ArrowUpRight size={18} />
    </Link>
  );
}
export function Landing() {
  return (
    <>
      <section className="landing-hero">
        <div className="hero-copy">
          <h1>
            {t('Every round.')}
            <br />
            {t('Every angle.')}
          </h1>
          <p>
            {t(
              'Watch your Counter-Strike 2 demos in your browser. Change perspective. Find the moment that changed the match.',
            )}
          </p>
          <div className="hero-actions">
            <ImportAction />
            <Link className="button hero-secondary" to="/watch/sample" state={{ from: '/' }}>
              <Play size={16} />
              {t('Try the viewer')}
            </Link>
          </div>
          <span className="hero-note">
            {t('Try the sample without an account. Your uploads stay private.')}
          </span>
        </div>
        <div className="hero-review">
          <ReviewPreview />
          <span className="hero-proof">
            {t('A real interactive preview. Practice data, not a personal match.')}
          </span>
        </div>
      </section>
      <section className="public-feature-section">
        <div className="section-intro">
          <h2>{t('A better second look.')}</h2>
          <p>
            {t(
              'For the duel you lost, the timing you missed, and the round you want to understand.',
            )}
          </p>
        </div>
        <div className="feature-ledger">
          <Link to="/features/viewer">
            <div>
              <Eye size={24} />
              <h3>{t('Own the perspective.')}</h3>
            </div>
            <p>
              {t(
                'Follow a player, read the round from above, or move the camera yourself. Keep the timeline in reach.',
              )}
            </p>
            <span>
              {t('Explore the viewer')}
              <ArrowUpRight size={18} />
            </span>
          </Link>
          <Link to="/features/imports">
            <div>
              <Upload size={24} />
              <h3>{t('Bring the match.')}</h3>
            </div>
            <p>
              {t(
                'Upload a .dem or .dem.zst, connect your identity, and use the import sources available on your instance.',
              )}
            </p>
            <span>
              {t('Ways to import')}
              <ArrowUpRight size={18} />
            </span>
          </Link>
          <Link to="/self-host">
            <div>
              <Server size={24} />
              <h3>{t('Keep the controls.')}</h3>
            </div>
            <p>
              {t(
                'Run cswatch on your own CPU server. Decide who can join, what is public, and how long demos stay.',
              )}
            </p>
            <span>
              {t('See self-hosting')}
              <ArrowUpRight size={18} />
            </span>
          </Link>
        </div>
      </section>
      <section className="review-story">
        <div>
          <h2>{t('Find the turning point.')}</h2>
          <p>
            {t(
              'Jump to the next live round. Skip the timeout. Follow a grenade. Save the moment you want to discuss.',
            )}
          </p>
          <Link className="button" to="/features/viewer">
            {t('Inside the review room')}
            <ArrowUpRight size={17} />
          </Link>
        </div>
        <div className="round-story" data-ui>
          <div className="story-rounds">
            {sample.rounds.map(({ number: n }) => (
              <span key={n} className={n === 1 ? 'selected' : ''}>
                {String(n).padStart(2, '0')}
                <i />
              </span>
            ))}
          </div>
          <div className="story-moment">
            <span>0:09</span>
            <strong>{t('The opening duel')}</strong>
            <ArrowRight size={18} />
          </div>
          <p>{t('Sample moment · change the view, then run it back.')}</p>
          <div className="story-tools">
            <span>{t('Player view')}</span>
            <span>{t('Grenade paths')}</span>
            <span>{t('Private notes')}</span>
          </div>
        </div>
      </section>
      <section className="public-tool-proofs">
        <article>
          <h2>{t('Trace the setup.')}</h2>
          <p>{t('Scrub the recorded path. Keep utility decisions in view.')}</p>
          <UtilityProof />
        </article>
        <article>
          <h2>{t('Keep the moment.')}</h2>
          <p>{t('A timestamp and a clear note make the next review easier.')}</p>
          <NoteProof />
        </article>
      </section>
      <section className="public-faq">
        <div>
          <h2>{t('Before you queue it up.')}</h2>
          <p>{t('A few things worth knowing before your first review.')}</p>
        </div>
        <div>
          {[
            [
              t('Do I need to install CS2?'),
              t(
                'You can use the viewer in a supported browser. Map and character assets are prepared by the instance operator; a 2D position view is available when assets or WebGL are unavailable.',
              ),
            ],
            [
              t('Are my demos public?'),
              t(
                'Uploads are private by default. Only the owner can publish a demo. Personal notes stay private even on a public match.',
              ),
            ],
            [
              t('Can I use my phone or TV?'),
              t(
                'The interface supports touch and keyboard controls, quality settings, and a low-power 2D mode. Actual performance depends on the device and installed map assets.',
              ),
            ],
            [
              t('Does Steam sign-in download my matches?'),
              t(
                'Steam verifies your identity and can support match discovery. Demo downloads from Steam’s Game Coordinator are not implemented; you can upload a downloaded demo. FACEIT downloads need approved API access.',
              ),
            ],
          ].map(([q, a]) => (
            <details key={q}>
              <summary>
                {q}
                <ChevronRight size={17} />
              </summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="public-final">
        <h2>{t('Your next round starts here.')}</h2>
        <div>
          <ImportAction />
          <Link to="/watch/sample" state={{ from: '/' }}>
            {t('Or take the sample for a spin')}
            <ArrowUpRight size={17} />
          </Link>
        </div>
      </section>
    </>
  );
}
const featureContent = {
  viewer: {
    title: 'See the round differently.',
    intro:
      'A review room built around the match. The controls you need stay close; the advanced tools stay out of your way until you need them.',
    rows: [
      [
        'Perspective, without the guesswork.',
        'Choose free camera, overhead, player perspective, or 2D tactical view. X-ray silhouettes, radar, and a centered crosshair help you read positions.',
      ],
      [
        'Get to the part that matters.',
        'Round jumps, playback speeds, live-round navigation, timeout skipping, and player kill/death jumps make long reviews manageable.',
      ],
      [
        'Read the utility.',
        'Recorded grenade paths and event-based smoke/fire zones help explain an execute. These overlays approximate game effects; they do not reproduce Source 2 smoke physics.',
      ],
      [
        'Keep your own review.',
        'Signed-in viewers can save private timestamp notes. Owners control naming, sharing, and deletion. Public viewers can watch without creating an account.',
      ],
    ],
  },
  imports: {
    title: 'Your match, ready to review.',
    intro:
      'Start with the file you already have. Add account connections when they make the next import easier.',
    rows: [
      [
        'Upload the demo.',
        'Choose a .dem or .dem.zst file. Uploads are private by default, bounded by your instance’s limits, and processed in a separate CPU worker.',
      ],
      [
        'Premier, Competitive and Wingman.',
        'Download an available CS2 replay from Steam Personal Game Data or the in-game match history, then upload its .dem or .dem.zst file. The upload guide walks you through finding and extracting the file.',
      ],
      [
        'Verify your Steam identity.',
        'Steam sign-in links an immutable Steam ID. With a configured API key, you can discover the next match sharing code. Automatic Steam demo downloads are not implemented.',
      ],
      [
        'Connect the right FACEIT account.',
        'cswatch verifies the FACEIT profile matching your Steam identity. Match history uses FACEIT’s Data API. Automatic demo imports require separate Downloads API approval.',
      ],
      [
        'Know where your match stands.',
        'Queued, processing, ready, or failed: a demo has a visible state. You can leave the processing page and return through your library.',
      ],
    ],
  },
  hosting: {
    title: 'Your server. Your rules.',
    intro:
      'Host cswatch behind your own reverse proxy. Keep the deployment CPU-only and choose the access policy that fits your players.',
    rows: [
      [
        'A public room or a private team space.',
        'Public access and registration are independent controls. Environment values lock policy; unset values can be managed in the admin interface.',
      ],
      [
        'One application, a separate worker.',
        'Docker Compose runs the web app and a network-isolated CPU parser worker. Persistent storage keeps accounts, originals, prepared playback, and notes together.',
      ],
      [
        'Stay in control of the data.',
        'Set upload, storage, processing, and retention limits. No proprietary game assets are bundled; prepare map and optional character assets offline with S2V.',
      ],
      [
        'Maintain it deliberately.',
        'Weekly workflows rebuild container bases and verify the app. Dependency updates arrive through reviewed PRs. Backups, updates, HTTPS, and deployment remain under your control.',
      ],
    ],
  },
};
export function FeaturePage({ kind }: { kind: keyof typeof featureContent }) {
  const { user, config } = useApp(),
    content = featureContent[kind];
  return (
    <>
      <section className="feature-page-hero">
        <div>
          <Link className="public-back" to="/">
            CSWATCH
            <ChevronRight size={13} />
            {t(kind === 'viewer' ? 'Viewer' : kind === 'imports' ? 'Imports' : 'Self-host')}
          </Link>
          <h1>{t(content.title)}</h1>
          <p>{t(content.intro)}</p>
          <div className="hero-actions">
            {kind === 'hosting' ? (
              <a
                className="button primary"
                href="https://github.com/Buco7854/cswatch#docker-deployment"
                target="_blank"
                rel="noreferrer"
              >
                {t('Deployment guide')}
                <ArrowUpRight size={18} />
              </a>
            ) : (
              <ImportAction />
            )}
            <Link
              className="button"
              to={kind === 'imports' && user ? '/connections' : '/watch/sample'}
            >
              {t(kind === 'imports' && user ? 'Manage connections' : 'Try the viewer')}
              <ArrowUpRight size={16} />
            </Link>
          </div>
        </div>
        {kind === 'viewer' ? (
          <ReviewPreview />
        ) : (
          <div className="feature-poster">
            <span className="poster-glyph">{kind === 'imports' ? <Upload /> : <Server />}</span>
            <strong>
              {t(kind === 'imports' ? 'FROM DEMO\nTO DEBRIEF.' : 'BUILT FOR\nYOUR SERVER.')}
            </strong>
            <span>
              {t(kind === 'imports' ? '.dem + .dem.zst' : 'CPU-only hosting · Docker · your proxy')}
            </span>
          </div>
        )}
      </section>
      <section className="feature-detail-list">
        {content.rows.map(([title, body]) => (
          <article key={title}>
            <h2>{t(title)}</h2>
            <p>{t(body)}</p>
          </article>
        ))}
      </section>
      {kind === 'imports' && (
        <section className="provider-availability">
          <h2>{t('Available on this instance')}</h2>
          <div>
            <span>{t('File uploads')}</span>
            <strong>{t('Available after sign-in')}</strong>
          </div>
          <div>
            <span>Steam</span>
            <strong>{t(config.steam_enabled ? 'Enabled' : 'Disabled by administrator')}</strong>
          </div>
          <div>
            <span>FACEIT</span>
            <strong>{t(config.faceit_enabled ? 'Enabled' : 'Disabled by administrator')}</strong>
          </div>
          <p>
            {t(
              'Provider credentials and download approval can add further requirements. Connections shows the exact state for your account.',
            )}
          </p>
        </section>
      )}
      <section className="public-final">
        <h2>{t('Ready for another look?')}</h2>
        <div>
          <ImportAction />
          <Link to="/">
            {t('Back to cswatch')}
            <ArrowUpRight size={17} />
          </Link>
        </div>
      </section>
    </>
  );
}
