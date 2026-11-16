# Verification record

Local verification on 2026-11-16 used Linux 6.12 / Landlock ABI 6, Node 22.23.4 and Chromium (Playwright build 1254). Node 24 is the supported CI/container target. Tests use disposable accounts and explicit synthetic or checksum-pinned public fixtures, never production accounts or private user demos.

## Automated checks

| Check                                  | Evidence                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build, formatting and EN/FR coverage   | `npm run build`, `npm run format:check`, `npm run check:locales`                                                                                                                                                          |
| Backend and shared domain              | 71 passed, 0 skipped with the pinned Mirage fixture and `CSWATCH_TRANSCRIPTION_TEST_MODEL` set                                                                                                                            |
| Public browser journeys                | 15 passed; 1 private-policy-only test intentionally skipped                                                                                                                                                               |
| Private instance, registrations closed | 1 passed; 15 public-only tests intentionally skipped                                                                                                                                                                      |
| Private instance, registrations open   | 1 passed; 15 public-only tests intentionally skipped                                                                                                                                                                      |
| Runtime integration                    | HTTP upload pipeline → required native sandbox → 31 replay chunks / 10 players → ownership/private 404 → private notes → explicit sharing; separate required-sandbox CPU captions and authorized caption HTTP read passed |
| Production dependency audit            | Backend, frontend, asset tools and transcription tools: no reported vulnerabilities at verification time                                                                                                                  |

Native tests exercise real `.dem` and bounded `.dem.zst` parsing. Kernel probes cover unrelated files, database access, writes outside the job, network, process escape/signals, alternate syscall ABI, ioctl and signal/lease-related fcntl operations. These are regression checks, not proof against kernel vulnerabilities or an independent security audit.

The final security review corrected the expected-parent check for a normal Docker PID 1 worker and added missing/changed-parent regression coverage. A local attempt to overlap native parsing, inference and multiple software-rendered browser matrices exhausted shared memory and caused killed processes/timeouts. The first CI run also exposed the CPU cost of two browser workers: the aggregate French layout test exceeded its deadline. Browser suites now explicitly use one worker, matching local verification. Assertions and resource deadlines were preserved.

Replay tests cover artifact validation, global bounds, time-slice overlap, context trails, cache/request limits, failed-seek retry and identity-safe lifecycle. Browser journeys cover authentication/return intent, private routing, account navigation, library search/paging, upload cancellation, malformed upload responses, full-tab/fullscreen controls, keyboard focus, phone event rails, optional HUDs and French communications in both themes.

## Speech and communications evidence

The pinned Mirage demo contains **no recorded voice or chat**. A synthetic Source 2 binary packet exercises the actual typed protocol reader; browser tests decode real Opus under the production CSP and check timed text/seek behavior. Test speech uses checksum-pinned public material, including an English public-domain speech and French documentation audio. Actual local Whisper inference detects/transcribes English and French, and a durable required-sandbox job publishes captions while preserving replay readiness.

To include all speech tests:

```sh
npm ci --prefix tools/transcription
node tools/transcription/prepare-model.mjs --out var/transcription-models/whisper-tiny
CSWATCH_TRANSCRIPTION_TEST_MODEL="$PWD/var/transcription-models/whisper-tiny" npm test
```

Without a model, three actual-inference tests explicitly skip. Missing native fixtures also skip rather than masquerading as passes. Run `node scripts/fetch-test-demo.mjs` first. Weights, fixture audio and generated output remain ignored under `var/`.

## Rendered review

The member matrix covers EN/FR × dark/light × 320, 390, 768, 844 landscape, 1440 and 1920 px. It checks 312 screen/state combinations, including account, connections, admin, library, whole-tab viewer, dialogs and progressive controls. It reported no layout/runtime findings. Dedicated HUD and communications fixtures exercise zero/missing values, long player names, per-speaker controls and bounded dropdowns. The final French communications test additionally checks both themes at phone/tablet/desktop sizes.

Screenshots were opened and reviewed, including French light phone and dark desktop communications. The app design inspector reported 0 failures and one accepted compact-metadata text-size warning; controls and working panels retain readable sizes and touch targets. Screenshot artifacts are local ignored QA output, not bundled product data. Viewport checks are not physical Galaxy S24/TV performance certification or user design approval.

## Container and release gate

Docker is unavailable in the development environment. The [release workflow](https://github.com/Buco7854/cswatch/actions/workflows/ci.yaml) uses Node 24, builds the real image, checks its HTTP health endpoint and runs `scripts/runtime-smoke.mjs` inside a non-root, read-only, networkless, capability-dropped container with CPU/memory/process limits. It mounts only explicit fixtures and the read-only local model; `CSWATCH_REQUIRE_ASR_SMOKE=true` makes missing speech verification a failure. Image publication depends on successful verification. Consult the workflow attached to the commit for actual container results.

Outstanding external evidence: a full S2V export/alignment with operator-owned CS2 assets; live Steam/FACEIT credentials and approved Downloads API access; a representative real voiced-demo corpus; physical mobile/TV performance; and independent security review. See [feature status](STATUS.md) and [security boundaries](../SECURITY.md).
