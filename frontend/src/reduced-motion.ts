import { useSyncExternalStore } from 'react';

const query = '(prefers-reduced-motion: reduce)';
const snapshot = () => typeof window !== 'undefined' && window.matchMedia(query).matches;
const serverSnapshot = () => false;
function subscribe(changed: () => void) {
  const media = window.matchMedia(query);
  media.addEventListener('change', changed);
  return () => media.removeEventListener('change', changed);
}

/** Follow the OS setting live without persisting a competing device preference. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
