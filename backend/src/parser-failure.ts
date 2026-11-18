export const parserFailureMessages = {
  sandbox_unavailable:
    'The host could not start the required parser sandbox. Ask the administrator to check Linux Landlock support and worker permissions.',
  timeout:
    'Demo processing exceeded its time limit. Ask the administrator to check worker resources or the parser time limit.',
  memory_limit:
    'Demo processing ran out of memory. Ask the administrator to check worker memory limits.',
  storage_limit:
    'Demo processing exceeded its storage limit. Ask the administrator to check storage quotas and free disk space.',
  invalid_demo:
    'This file could not be read as a supported CS2 demo. Check that the download completed and try the original file.',
  demo_limit:
    'The demo exceeds the configured duration, frame, decompression or replay output limit.',
  cancelled: 'Demo processing was cancelled.',
  invalid_output:
    'The parser produced replay data that failed validation. The original file was kept.',
  parser_crash:
    'The native parser stopped unexpectedly. Ask the administrator to check the worker failure code and signal.',
  processing_failed:
    'Demo processing failed. Ask the administrator to check the worker log using this demo ID.',
} as const;
export type ParserFailureCode = keyof typeof parserFailureMessages;
export class JobFailure extends Error {
  constructor(
    readonly code: ParserFailureCode,
    readonly details: {
      exitCode?: number | null;
      signal?: string | null;
      sandboxReason?: string;
    } = {},
  ) {
    super(parserFailureMessages[code]);
    this.name = 'JobFailure';
  }
}

/** Child messages never leave the isolation boundary. Only known classifications do. */
export function classifyParserFailure(error: unknown): { code: ParserFailureCode } {
  const message = error instanceof Error ? error.message : '';
  if (['ENOSPC', 'EDQUOT', 'EFBIG'].includes(String((error as NodeJS.ErrnoException | null)?.code)))
    return { code: 'storage_limit' };
  if (
    /Expanded limit|Frame limit|exceeds 3 hours|no ticks|Replay output limit|Replay metadata limit|Stored replay limit|too many chunks/.test(
      message,
    )
  )
    return { code: 'demo_limit' };
  if (/memory|heap|allocat/i.test(message)) return { code: 'memory_limit' };
  return { code: 'invalid_demo' };
}

export function processingFailure(error: unknown, stage: string) {
  if (error instanceof JobFailure) return { code: error.code, ...error.details };
  const message = error instanceof Error ? error.message : '';
  const systemCode = (error as NodeJS.ErrnoException | null)?.code;
  let code: ParserFailureCode = 'processing_failed';
  if (stage === 'sandbox' && ['ENOENT', 'EACCES', 'EPERM'].includes(String(systemCode)))
    code = 'sandbox_unavailable';
  else if (
    ['ENOSPC', 'EDQUOT', 'EFBIG'].includes(String(systemCode)) ||
    /quota|storage|too many files|size/i.test(message)
  )
    code = 'storage_limit';
  else if (/cancelled/.test(message)) code = 'cancelled';
  else if (/Keep DATA_DIR|Untrusted parsing requires|Build the job/.test(message))
    code = 'sandbox_unavailable';
  else if (stage === 'validation') code = 'invalid_output';
  else if (stage === 'input') code = 'invalid_demo';
  const validation = stage === 'validation' ? replayValidationIssue(error) : undefined;
  return {
    code,
    ...(validation ? { validation } : {}),
    ...(typeof systemCode === 'string' && /^[A-Z_]{2,24}$/.test(systemCode) ? { systemCode } : {}),
  };
}

// Schema locations help diagnose publication failures. Values, arbitrary keys,
// filesystem paths and validator messages never enter the worker log.
const validationFields = new Set(
  (
    'version map tickRate firstTick lastTick worldBounds chunks index startTick endTick firstFrameTick frames bytes ' +
    'players id name team x y z yaw pitch health alive weapon armor money ammo duck flash helmet defuser ' +
    'scoped defusing equipmentValue startMoney spentThisRound inventory input source buttons pressedButtons releasedButtons mouseDx mouseDy ' +
    'stats kills deaths assists headshotKills damage events type tick rounds number liveTick winner deadTimes start end kind ' +
    'objectives matchState samples complete throwInputs eventIndex actorId sampleTick provenance clock phase ctScore tScore ' +
    'grenades points voice chat captions speaker text language opus sampleRate channels durationMs crosshairs actor code'
  ).split(' '),
);
const validationChecks = new Set([
  'Invalid replay artifact',
  'Invalid replay bounds',
  'Invalid recorded match state time',
  'Invalid throw input event identity or time',
  'Invalid throw input provenance or time',
  'Invalid objective state identity or time',
  'Invalid recorded crosshair identity or time',
  'Invalid replay directory',
  'Unexpected replay files',
  'Missing replay files',
  'Invalid chunk sequence',
  'Replay size mismatch',
  'Replay chunk mismatch',
  'Unordered replay frames',
  'Stored replay limit',
]);
function replayValidationIssue(error: unknown): string | undefined {
  if (error instanceof ZodError && error.issues.length) {
    const issue = error.issues[0];
    const path = issue.path
      .slice(0, 8)
      .map((part) =>
        typeof part === 'number' && Number.isSafeInteger(part) && part >= 0 && part <= 1_000_000
          ? String(part)
          : typeof part === 'string' && validationFields.has(part)
            ? part
            : '*',
      )
      .join('.');
    return `${issue.code}: ${path || 'root'}`;
  }
  return error instanceof Error && validationChecks.has(error.message) ? error.message : undefined;
}

export function sandboxFailureReason(stderr: string): string | undefined {
  const match = stderr.match(
    /cswatch parser sandbox: ([A-Za-z0-9_, /.-]{1,160}) \(([A-Za-z0-9_, .-]{1,100})\)/,
  );
  const stages = new Set([
    'open allowed path',
    'stat allowed path',
    'add filesystem rule',
    'install seccomp filter',
    'invalid limit',
    'missing expected worker parent',
    'invalid expected worker parent',
    'Landlock ABI 3 or newer required',
    'resolve runtime paths',
    'invalid job entry',
    'resolve readonly model',
    'set resource limit',
    'set no_new_privs',
    'worker parent changed',
    'bind parser lifetime to worker',
    'create filesystem ruleset',
    'package path too long',
    'enforce filesystem ruleset',
    'enter job directory',
    'job entry path too long',
    'execute parser',
  ]);
  if (!match || !stages.has(match[1])) return undefined;
  const knownErrors = new Set([
    'Success',
    'Operation not permitted',
    'No such file or directory',
    'No such process',
    'Permission denied',
    'Invalid argument',
    'Function not implemented',
    'Operation not supported',
    'No space left on device',
    'Cannot allocate memory',
    'Too many open files',
    'File exists',
  ]);
  return `${match[1]} (${knownErrors.has(match[2]) ? match[2] : 'host error'})`;
}
import { ZodError } from 'zod';
