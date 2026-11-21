import { api } from './api';
import { useConfirm } from './components/Confirmation';
import { t } from './i18n';
import type { Demo } from './types';

export function useDeleteDemo() {
  const confirm = useConfirm();
  return async (demo: Demo, isCurrent: () => boolean, onConfirm: () => void) => {
    const confirmed = await confirm({
      title: t('Delete demo'),
      description: t(
        'Delete “{{v0}}”? This permanently removes its demo file, playback data, and all notes.',
        { v0: demo.name },
      ),
      confirmLabel: t('Delete permanently'),
      tone: 'danger',
    });
    if (!confirmed || !isCurrent()) return false;
    onConfirm();
    await api('/api/demos/' + demo.id, { method: 'DELETE' });
    return isCurrent();
  };
}
