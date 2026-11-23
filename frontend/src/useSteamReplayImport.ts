import { useLayoutEffect, useRef, useState } from 'react';
import { uploadFile } from './api';
import { useApp } from './context';
import { t } from './i18n';
import type { MatchActivity } from './match-activity';
import {
  findSteamReplay,
  folderPicker,
  type ReplayFolder,
  replayIdentity,
} from './steam-replay-folder';

type Identity = NonNullable<ReturnType<typeof replayIdentity>>;
type Operation = {
  controller: AbortController;
  identity: Identity;
  timeout?: number;
  retry?: number;
  previous?: File;
};
type Feedback = {
  id: string;
  phase: 'checking' | 'download' | 'waiting' | 'upload' | 'error';
  message: string;
};

export function useSteamReplayImport(activity: MatchActivity, route: string) {
  const { config, session, user, captureSessionVersion, refresh } = useApp();
  const steamAccount = user?.identities?.find((identity) => identity.provider === 'steam')?.subject;
  const csrf = session.csrf;
  const folder = useRef<ReplayFolder | undefined>(undefined);
  const pending = useRef<Operation | undefined>(undefined);
  const [folderName, setFolderName] = useState('');
  const [feedback, setFeedback] = useState<Feedback>();
  function stop() {
    const operation = pending.current;
    pending.current = undefined;
    if (!operation) return;
    clearTimeout(operation.retry);
    clearTimeout(operation.timeout);
    operation.controller.abort();
  }
  useLayoutEffect(() => {
    setFolderName('');
    return () => {
      stop();
      folder.current = undefined;
    };
  }, [csrf, activity, steamAccount]);
  useLayoutEffect(() => {
    setFeedback(undefined);
    return stop;
  }, [route, csrf, activity, steamAccount]);

  function cancel() {
    stop();
    setFeedback(undefined);
  }
  function forget() {
    cancel();
    folder.current = undefined;
    setFolderName('');
  }
  function active(op: Operation) {
    return pending.current === op && captureSessionVersion(csrf) !== undefined;
  }
  function fail(op: Operation, message: string) {
    if (!active(op)) return;
    stop();
    setFeedback({ id: op.identity.matchId.toString(), phase: 'error', message });
  }
  function deadline(op: Operation) {
    clearTimeout(op.timeout);
    op.timeout = window.setTimeout(
      () => fail(op, t('The replay did not finish in time. Try again or choose the demo file.')),
      120_000,
    );
  }
  async function check(op: Operation, first: boolean) {
    if (!active(op) || !folder.current) return;
    const id = op.identity.matchId.toString();
    const signal = op.controller.signal;
    try {
      const file = await findSteamReplay(folder.current, op.identity, config.max_upload_mb, signal);
      if (!active(op)) return;
      if (!file && first) {
        clearTimeout(op.timeout);
        setFeedback({
          id,
          phase: 'download',
          message: t('Replay not found here. Download it in CS2 to continue.'),
        });
        return;
      }
      const previous = op.previous;
      if (
        file instanceof File &&
        previous &&
        file.name === previous.name &&
        file.size === previous.size &&
        file.lastModified === previous.lastModified
      ) {
        // A replay can finish while Steam is foregrounded or after a different
        // tab changes accounts. Revalidate before handing local bytes to XHR.
        const current = await refresh();
        if (!active(op)) return;
        if (
          !current.user?.match_sources?.steam ||
          current.user.id !== user?.id ||
          current.session.csrf !== csrf ||
          current.user.identities?.find((identity) => identity.provider === 'steam')?.subject !==
            steamAccount
        ) {
          forget();
          return;
        }
        clearTimeout(op.timeout);
        const progress = (n: number) => {
          if (active(op))
            setFeedback({
              id,
              phase: 'upload',
              message:
                n === 100 ? t('Adding to processing queue…') : t('Uploading {{v0}}%', { v0: n }),
            });
        };
        progress(0);
        const result = await uploadFile(file, progress, signal, csrf, { source: 'steam', id });
        if (active(op)) {
          cancel();
          activity.set('steam:' + id, { added: { id: result.id, status: 'queued' } });
        }
        return;
      }
      op.previous = file instanceof File ? file : undefined;
      setFeedback({
        id,
        phase: 'waiting',
        message: t('Waiting for CS2 to finish saving this replay…'),
      });
      op.retry = window.setTimeout(() => void check(op, false), 1500);
    } catch (error) {
      fail(
        op,
        error instanceof Error && !(error instanceof DOMException)
          ? error.message
          : t('Could not read this folder. Choose the replays folder again or select a demo file.'),
      );
    }
  }
  async function start(identity: Identity) {
    if (pending.current) return;
    const picker = folderPicker();
    if (!picker || captureSessionVersion(csrf) === undefined) return;
    const id = identity.matchId.toString();
    const op = { controller: new AbortController(), identity };
    pending.current = op;
    setFeedback({ id, phase: 'checking', message: t('Checking the replays folder…') });
    try {
      // The picker needs the original trusted click, before any asynchronous work.
      const directory = folder.current ?? (await picker({ mode: 'read' }));
      if (!active(op)) return;
      folder.current = directory;
      setFolderName(directory.name);
      deadline(op);
      await check(op, true);
    } catch (error) {
      if (active(op) && error instanceof DOMException && error.name === 'AbortError') cancel();
      else
        fail(
          op,
          t('Could not read this folder. Choose the replays folder again or select a demo file.'),
        );
    }
  }
  function download(id: string) {
    const op = pending.current;
    if (
      !op ||
      !active(op) ||
      op.identity.matchId.toString() !== id ||
      feedback?.phase !== 'download'
    )
      return;
    setFeedback({
      id,
      phase: 'waiting',
      message: t('Waiting for CS2 to finish saving this replay…'),
    });
    deadline(op);
    void check(op, false);
  }
  return { start, download, cancel, forget, feedback, folderName, busy: !!pending.current };
}
