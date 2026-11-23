import { useEffect, useRef, useState } from 'react';
import { currentFocus, focusReturn } from './focus-restore';

export function useAction() {
  const scope = useRef({ active: true });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const current = { active: true };
    scope.current = current;
    return () => {
      current.active = false;
    };
  }, []);
  async function run(work: (active: () => boolean) => Promise<void>) {
    if (pending.current || !scope.current.active) return;
    const current = scope.current;
    const active = () => current.active;
    const trigger = currentFocus();
    const restore = trigger && focusReturn(trigger);
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await work(active);
    } catch (failure) {
      if (active()) setError((failure as Error).message);
    } finally {
      pending.current = false;
      if (active()) setBusy(false);
      restore?.();
    }
  }
  return { busy, error, run, clearError: () => setError('') };
}
