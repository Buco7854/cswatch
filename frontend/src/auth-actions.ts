import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { passkeyNameIssue } from '../../shared/passkey-name.mjs';
import { api, ApiError } from './api';
import type { AuthStatus } from './types';

type RefreshAuth = () => Promise<AuthStatus>;

export function recoveryReceiptDeadline(startedAt: number, remainingMs = 0) {
  return startedAt + Math.min(remainingMs, 600_000);
}

export function authPost<T = AuthStatus>(path: string, body: object = {}, sessionContext?: string) {
  return api<T>(
    '/api/auth/' + path,
    { method: 'POST', body: JSON.stringify(body) },
    sessionContext,
  );
}

export async function reconcile<T>(request: Promise<T>, refresh: RefreshAuth) {
  let result: T;
  try {
    result = await request;
  } catch (error) {
    // A lost response can follow a committed cookie rotation.
    await refresh().catch(() => {});
    throw error;
  }
  const status = await refresh();
  return { result, status };
}

export function passkeySupported() {
  return window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined';
}

type PasskeyOptions<T> = { options: T; expires_in_ms: number };
type AssertionOptions = PasskeyOptions<PublicKeyCredentialRequestOptionsJSON>;
type EnrollmentPhase = 'create' | 'possession';
type EnrollmentOptions =
  | (PasskeyOptions<PublicKeyCredentialCreationOptionsJSON> & { phase: 'create' })
  | (AssertionOptions & { phase: 'possession' });

const passkeyNameErrors = {
  required: 'Enter a name to create a new passkey.',
  length: 'Shorten the passkey name and try again.',
  characters: 'Remove hidden formatting or control characters from the passkey name.',
};
const renameRequired = 'Enter a passkey name.';

export function passkeyNameError(name: string, rename = false) {
  const issue = passkeyNameIssue(name);
  if (issue === 'required' && rename) return renameRequired;
  if (issue) return passkeyNameErrors[issue];
}

export function isPasskeyNameError(message: string) {
  return message === renameRequired || Object.values(passkeyNameErrors).includes(message);
}

const passkeyExpired = () => new Error('Security verification expired. Start again.');
const passkeyVerificationIncomplete =
  'Passkey verification did not finish. Try again or use another method.';
const passkeyAttemptKey = 'cswatch-passkey-attempt';
let localPasskeyAttempt: string | undefined;
let activePasskeyPrompt: symbol | undefined;

function passkeyDeadline(
  startedAt: number,
  { options, expires_in_ms }: PasskeyOptions<{ timeout?: number }>,
  enrollmentDeadline = Infinity,
) {
  return Math.min(enrollmentDeadline, startedAt + Math.min(options.timeout ?? 0, expires_in_ms));
}

async function passkeyPrompt<T>(
  deadline: number,
  open: (timeout: number) => Promise<T>,
  abort: () => void,
  incomplete: string,
  onFailure?: () => Promise<void>,
) {
  const timeout = Math.floor(deadline - performance.now());
  if (!(timeout > 0)) throw passkeyExpired();
  const owner = Symbol();
  activePasskeyPrompt = owner;
  const expired = passkeyExpired();
  let timer = 0;
  const expiry = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      reject(expired);
      // The library's native abort controller belongs to the most recent call.
      if (activePasskeyPrompt === owner) abort();
    }, timeout);
  });
  let response;
  try {
    try {
      response = await Promise.race([open(timeout), expiry]);
    } finally {
      window.clearTimeout(timer);
      if (activePasskeyPrompt === owner) activePasskeyPrompt = undefined;
    }
  } catch (error) {
    if (error === expired || performance.now() >= deadline) throw expired;
    await onFailure?.();
    throw new Error(incomplete);
  }
  // The browser may clamp the hint or keep native UI open beyond it.
  if (performance.now() >= deadline) throw expired;
  return response;
}

async function passkeyGrantTag(sessionContext: string) {
  const bytes = new TextEncoder().encode('cswatch:passkey-attempt-grant:1:' + sessionContext);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return btoa(String.fromCharCode(...hash)) + ':';
}

function storedPasskeyAttempt(tag: string) {
  let value = localPasskeyAttempt;
  if (!value?.startsWith(tag)) {
    try {
      value = sessionStorage.getItem(passkeyAttemptKey) ?? undefined;
    } catch {
      // Browsers that block tab storage can retry while this document is open.
    }
  }
  const attempt = value?.startsWith(tag) ? value.slice(tag.length) : '';
  return /^[a-f0-9]{32}$/.test(attempt) ? attempt : undefined;
}

function newPasskeyAttempt(tag: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const attempt = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  localPasskeyAttempt = tag + attempt;
  try {
    sessionStorage.setItem(passkeyAttemptKey, localPasskeyAttempt);
  } catch {
    // The in-memory selector remains available for same-document retry.
  }
  return attempt;
}

function forgetPasskeyAttempt(tag: string, attempt: string) {
  const value = tag + attempt;
  if (localPasskeyAttempt === value) localPasskeyAttempt = undefined;
  try {
    if (sessionStorage.getItem(passkeyAttemptKey) === value)
      sessionStorage.removeItem(passkeyAttemptKey);
  } catch {
    // A completed or cancelled attempt cannot be reused even if storage fails.
  }
}

async function cancelPasskeyAttempt(tag: string, attempt: string, sessionContext: string) {
  await authPost('factors/passkeys/cancel', { attempt }, sessionContext);
  forgetPasskeyAttempt(tag, attempt);
}

export async function cancelPasskeyEnrollment(sessionContext: string) {
  const tag = await passkeyGrantTag(sessionContext);
  const attempt = storedPasskeyAttempt(tag);
  if (attempt) await cancelPasskeyAttempt(tag, attempt, sessionContext);
}

export async function hasPasskeyEnrollmentAttempt(sessionContext: string) {
  return Boolean(storedPasskeyAttempt(await passkeyGrantTag(sessionContext)));
}

export async function authenticatePasskey(
  path: string,
  active: () => boolean,
  sessionContext: string,
) {
  const { startAuthentication, WebAuthnAbortService } = await import('@simplewebauthn/browser');
  if (!active()) return;
  const startedAt = performance.now();
  const reply = await authPost<AssertionOptions>(path + '/options', {}, sessionContext);
  if (!active()) return;
  const response = await passkeyPrompt(
    passkeyDeadline(startedAt, reply),
    (timeout) => startAuthentication({ optionsJSON: { ...reply.options, timeout } }),
    () => WebAuthnAbortService.cancelCeremony(),
    passkeyVerificationIncomplete,
  );
  if (active()) return authPost(path + '/verify', { response }, sessionContext);
}

export async function registerPasskey(
  name: string,
  active: () => boolean,
  onPhase: (phase: EnrollmentPhase) => void,
  sessionContext: string,
) {
  const { startRegistration, startAuthentication, WebAuthnAbortService } =
    await import('@simplewebauthn/browser');
  const abort = () => WebAuthnAbortService.cancelCeremony();
  const tag = await passkeyGrantTag(sessionContext);
  if (!active()) return;
  const nameError = passkeyNameError(name);
  const requireName = () => {
    onPhase('create');
    if (nameError) throw new Error(nameError);
  };
  const startAttempt = () => {
    requireName();
    return newPasskeyAttempt(tag);
  };
  let attempt = storedPasskeyAttempt(tag) ?? startAttempt();
  const requestOptions = async () => {
    const startedAt = performance.now();
    const reply = await authPost<EnrollmentOptions>(
      'factors/passkeys/options',
      { attempt },
      sessionContext,
    );
    return { startedAt, reply };
  };
  const start = async () => {
    try {
      return await requestOptions();
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'passkey_setup_expired') throw error;
      if (!active()) return;
      attempt = startAttempt();
      return requestOptions();
    }
  };
  const initial = await start();
  if (!initial || !active()) return;
  const { startedAt, reply } = initial;
  const enrollmentDeadline = startedAt + reply.expires_in_ms;
  const cancelAfterNativeFailure = async () => {
    if (!active()) return;
    await cancelPasskeyAttempt(tag, attempt, sessionContext)
      .then(() => {
        if (active()) onPhase('create');
      })
      .catch(() => {});
  };
  let possession;
  let possessionStartedAt = startedAt;
  if (reply.phase === 'create') {
    requireName();
    const response = await passkeyPrompt(
      passkeyDeadline(startedAt, reply),
      (timeout) => startRegistration({ optionsJSON: { ...reply.options, timeout } }),
      abort,
      'Passkey setup did not finish. Try again or use another device.',
      cancelAfterNativeFailure,
    );
    if (!active()) return;
    possessionStartedAt = performance.now();
    possession = await authPost<AssertionOptions>(
      'factors/passkeys/verify',
      { attempt, name, response },
      sessionContext,
    );
  } else {
    possession = reply;
  }
  if (!active()) return;
  onPhase('possession');
  const confirmation = await passkeyPrompt(
    passkeyDeadline(possessionStartedAt, possession, enrollmentDeadline),
    (timeout) => startAuthentication({ optionsJSON: { ...possession.options, timeout } }),
    abort,
    passkeyVerificationIncomplete,
    cancelAfterNativeFailure,
  );
  if (!active()) return;
  const result = await authPost<FactorResult>(
    'factors/passkeys/confirm',
    { attempt, response: confirmation },
    sessionContext,
  );
  forgetPasskeyAttempt(tag, attempt);
  return result;
}

export type FactorResult = AuthStatus & { recovery_codes?: string[] };

export async function steamRedirect(
  path: 'steam' | 'step-up/steam' | 'steam/link',
  active: () => boolean,
  returnTo?: string,
  sessionContext?: string,
) {
  const { location } = await authPost<{ location: string }>(
    path,
    returnTo ? { return_to: returnTo } : {},
    sessionContext,
  );
  if (active()) window.location.assign(location);
}
