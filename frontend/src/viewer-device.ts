import { useCallback, useEffect, useState, type SetStateAction } from 'react';
import { readSettings, viewerPreferenceKey, type ViewerSettings } from './playback';

/** Phones keep their own opt-ins. A desktop's enabled HUD cannot silently fill
 * a phone screen. Rotation preserves the phone profile. */
const MOBILE_VIEWER_QUERY =
  '(max-width:760px),(max-width:960px) and (max-height:560px),(pointer:coarse) and (max-height:560px)';
export function useViewerPreferences() {
  const [state, setState] = useState(() => {
    const mobile = window.matchMedia(MOBILE_VIEWER_QUERY).matches;
    return { mobile, settings: readSettings(mobile) };
  });
  useEffect(() => {
    const media = window.matchMedia(MOBILE_VIEWER_QUERY);
    const update = () =>
      setState((current) =>
        current.mobile === media.matches
          ? current
          : {
              mobile: media.matches,
              settings: readSettings(media.matches),
            },
      );
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(viewerPreferenceKey(state.mobile), JSON.stringify(state.settings));
    } catch {}
  }, [state]);
  const setSettings = useCallback((value: SetStateAction<ViewerSettings>) => {
    setState((current) => ({
      ...current,
      settings: typeof value === 'function' ? value(current.settings) : value,
    }));
  }, []);
  return { settings: state.settings, setSettings, mobile: state.mobile };
}
