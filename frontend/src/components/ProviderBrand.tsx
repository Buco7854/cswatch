import { safeAuthReturnPath } from '../../../shared/auth-navigation.mjs';
import { t } from '../i18n';
import './provider-brand.css';

const steamArtwork = new URL('../assets/provider-brands/steam-openid.png', import.meta.url).href;
const faceitDarkArtwork = new URL('../assets/provider-brands/faceit-on-dark.png', import.meta.url)
  .href;
const faceitLightArtwork = new URL('../assets/provider-brands/faceit-on-light.png', import.meta.url)
  .href;

/** Fixed official artwork, preserved byte-for-byte. Steam's approved OpenID
 * artwork belongs only in an authentication link, never a standalone app mark. */
export function ProviderLogo({ provider }: { provider: 'steam' | 'faceit' }) {
  if (provider === 'steam')
    return (
      <img
        className="provider-logo provider-logo-steam"
        src={steamArtwork}
        width={180}
        height={35}
        alt=""
        aria-hidden="true"
      />
    );
  return (
    <span className="provider-logo provider-logo-faceit" aria-hidden="true">
      <img
        className="provider-logo-on-dark"
        src={faceitDarkArtwork}
        width={833}
        height={833}
        alt=""
      />
      <img
        className="provider-logo-on-light"
        src={faceitLightArtwork}
        width={833}
        height={833}
        alt=""
      />
    </span>
  );
}
export function SteamSignInLink({
  returnTo,
  label,
  className = '',
}: {
  returnTo: string;
  label: string;
  className?: string;
}) {
  return (
    <a
      className={'button provider-steam-link ' + className}
      href={'/api/auth/steam?returnTo=' + encodeURIComponent(safeAuthReturnPath(returnTo))}
      aria-label={label}
    >
      <ProviderLogo provider="steam" />
    </a>
  );
}
export function ProviderBrandNotice() {
  return (
    <a
      className="provider-brand-notice"
      href="/licenses/provider-brands.txt"
      target="_blank"
      rel="noreferrer"
    >
      {t('Provider brand notices')}
    </a>
  );
}
