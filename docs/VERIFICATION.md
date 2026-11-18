# Verification record

Updated 2026-11-18. Use Node 24, a Linux kernel supporting required Landlock/seccomp confinement and the Playwright lockfile's Chromium. The current environment uses Node 24.22.3, Linux 6.12/Landlock ABI 6 and Chromium build 1255. Tests use disposable accounts and original synthetic or checksum-pinned public fixtures. The three authorized supplied recordings were separately verified and deleted.

These are local results. Source, visual and browser gates are complete. Docker is unavailable locally. Consult the commit-specific [Actions workflow](https://github.com/Buco7854/cswatch/actions/workflows/ci.yaml) for hardened container verification and image publication.

## Latest completed checks

| Check                                         | Result                                                                                     | Local evidence                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Backend/native/shared/offline speech          | 244 passed, 0 skipped                                                                      | `/tmp/cswatch-release-backend-final.log`                                                                 |
| Complete asset-tool aggregate                 | 121 passed, 0 skipped                                                                      | `/tmp/cswatch-release-assets-final.log`                                                                  |
| Explicit map manifest and installer guards    | 20 focused passes                                                                          | `/tmp/cswatch-explicit-map-manifest-tests.log`                                                           |
| Required runtime integration                  | Passed member/guest upload, ownership, notes, explicit sharing and confined offline speech | `/tmp/cswatch-release-runtime-world-equipment-2.log`                                                     |
| Final complete public browser run             | 122 passed, 2 intentional private/setup-policy skips                                       | `/tmp/cswatch-release-public-final.log`                                                                  |
| Dedicated setup/private registration policies | Private closed/open: one pass each. Setup: four passes                                     | `/tmp/cswatch-release-private-{closed,open}-final.log`, `/tmp/cswatch-final-dedicated-setup-browser.log` |
| Third-person follow                           | Three pure checks and one original real-shader browser case passed                         | Genuine CT/T captured and inspected after marker correction                                              |
| Optional agent loader                         | Two focused original-agent browser cases passed                                            | Missing/failure isolation, weighted skin/bone upload/disposal and cache reuse                            |

The backend aggregate includes the final HTTP model-route hardening and descriptor lifetime checks. Tiny original fixtures prove symlink/hardlink/FIFO rejection, bounded ranges, fresh content ETags, hashing disconnect cancellation and synchronous send-failure cleanup. A genuine prepared Mirage follow run also passed through the final HTTP model route. The asset aggregate includes streaming shader CRC verification, source-image compaction, sparse accessor preflight, exact retarget inversion, manifest pinning and operator path guards. Do not add independent focused totals together and label them a new aggregate.

The required runtime smoke produced 31 chunks, ten players, 30 match-state snapshots, 150 throw inputs, native counters and recorded crosshairs. It exercised actual HTTP member/guest uploads, anonymous private denial, confined parsing, authorized chunk reads, private notes, explicit sharing and required offline CPU transcription. Its final result reports `sandbox: required` and `transcription: passed`.

## Reproduce repository checks

Fetch the pinned demo and prepare the optional tools/models as documented in the root and transcription READMEs. Missing native or speech fixtures produce explicit skips, which do not count as successful verification.

```sh
npm run build
node scripts/fetch-test-demo.mjs
CSWATCH_TRANSCRIPTION_TEST_MODEL="$PWD/var/transcription-models/whisper-tiny" npm test
npm run test:assets
npm run check:locales
npm run format:check
npm run test:e2e
```

Run the explicit private policy journeys with each registration setting:

```sh
E2E_PRIVATE=1 E2E_REGISTRATIONS=false npm --prefix frontend run test:e2e -- app.spec.ts --grep 'private entry'
E2E_PRIVATE=1 E2E_REGISTRATIONS=true npm --prefix frontend run test:e2e -- app.spec.ts --grep 'private entry'
```

The required local runtime smoke uses the prepared public voice replay and pinned offline model:

```sh
CSWATCH_SMOKE_ASR_MODEL="$PWD/var/transcription-models/whisper-tiny" \
CSWATCH_SMOKE_VOICE_FIXTURE="$PWD/var/transcription-jfk-job" \
CSWATCH_REQUIRE_ASR_SMOKE=true node scripts/runtime-smoke.mjs
```

Run heavy native/inference, scene exports and software-rendered browser jobs serially. Preserve assertions, deadlines, resource limits and fixture separation when addressing failures.

## Supplied complete recordings

All three supplied files passed actual streamed uploads, required Landlock/seccomp parsing, anonymous private 404 responses, validated beginning/middle/final chunks, playback advancement and player POV selection on desktop and phone. These journeys used the position fallback, so they do not establish native map rendering.

| Map          | Input      | Players | Rounds | Events | Chunks |
| ------------ | ---------- | ------- | ------ | ------ | ------ |
| `de_dust2`   | `.dem.zst` | 10      | 23     | 4,151  | 61     |
| `de_ancient` | `.dem.zst` | 10      | 26     | 5,845  | 73     |
| `de_cache`   | `.dem`     | 10      | 31     | 6,866  | 132    |

The two compressed recordings supplied voice and chat, with zero unsupported packets after corrected cumulative-end Opus framing. A required-sandbox probe decoded all 128 sampled packets into finite nonzero PCM. Both voiced browser journeys decoded/scheduled locally under the production CSP. Cache supplied chat without recorded voice. Supplied-file subtitle accuracy was not assessed.

Before authorized deletion, every original was streamed through SHA-256 and matched against its earlier digest. All originals, known temporary replay copies and captures containing private replay data were removed. Only ignored aggregate reports remain at `.design/user-demo-validation/report.json` and `browser-report.json`. Never restore those recordings or commit extracted communications.

## Genuine map evidence

The operator pipeline selectively acquired explicit map/dependency chunks from pinned Steam depot `2347770`, not the complete game. Prepared geometry, textures, official overview, oriented sky faces and distant landscape were served by the real production app.

| Map     | Browser matrix                                | Data/actor provenance                                          | Evidence                                                                                                 |
| ------- | --------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Mirage  | 1440×900, 768×1024 and 390×844 in both themes | Checksum-pinned public replay                                  | `/tmp/cswatch-mirage-budgeted-environment-matrix.log`, `.design/real-environment-validation/report.json` |
| Dust2   | Dark desktop 1440×900 and light phone 390×844 | Original synthetic actors at that map's actual authored spawns | `/tmp/cswatch-dust2-final-family-browser-3.log`, `.design/map-family-final/report-de_dust2.json`         |
| Ancient | Dark desktop 1440×900 and light phone 390×844 | Original synthetic actors at that map's actual authored spawns | `/tmp/cswatch-ancient-final-family-browser.log`, `.design/map-family-final/report-de_ancient.json`       |

All profiles reported decoded required textures, loaded calibrated overview/sky/landscape, matching radar/full-2D projection, no page/console errors and no document overflow. Dust2/Ancient checks derive the actual GPU draw-time camera from model-view/native world matrices and compare it with the selected Source spawn. They do not relabel Mirage recordings or establish spawn-floor collision, historical-layout compatibility or physical-phone performance.

Imported native lights are isolated on cloned maps, and required texture decoding gates readiness. Authored sky geometry renders in a separate depth pass. Exact black-unlit/cubemap-fog compatibility and bounded static masks for three supported dust/cloud materials have original pixel/domain regressions and actual-scene inspection. They do not reproduce full Source 2 lighting, HDR/fog, native material animation or gameplay smoke physics.

Cache dependencies and shaders resolved, but scene export stopped at the 512 MiB free-space reserve. `/tmp/cswatch-final-cache-compacting-installer.log` records that failure. No runtime Cache pack was published. Insufficient current capacity is a real blocker, not a reason to lower the reserve or retry blindly.

The inspected packs use manifest `6678473446694075055`. Steam's later listing is `807392217824910805`. Explicit map `--manifest` pinning passed focused validation and source-mismatch tests. A different latest manifest must not silently relabel existing cached assets. Automatic per-demo acquisition remains only the [map preparation proposal](product/MAP-ACQUISITION.md).

## Genuine equipment and agents

The ordinary pinned installer prepared `ak47`, `knife`, all six utility types, `c4` and `plantedc4`. These ten GLBs total 6,302,528 bytes. All 34 embedded images were independently decoded to raw pixels, all lossless Meshopt geometry was locally decoded, and model hashes, actual decoded texture budgets, skinned bounds and measured POV clearance passed. Evidence: `/tmp/cswatch-equipment-weapons-proof.log` and `/tmp/cswatch-equipment-native-output-proof.json`.

The fixed registry has 67 IDs. Only these ten are prepared locally. Missing references keep fallbacks, and the successful proof does not establish all 67 models or native weapon animation/skins/attachments.

Genuine CT/T models were exported with only the authored third-person body/gloves and one separately exported native full-pose rifle-idle clip. Frame zero retargets 64 exact bone names per agent without loading the complete animation graph. The CT/T outputs are 914,800/937,868 bytes. All 28 images, decoded geometry, hash bindings and round-trip skinned bounds passed. They retain raw S2V meters/Y-up for the runtime's single +90° Y rotation. There are no animation tracks. Evidence: `/tmp/cswatch-agent-ct-cached-proof.log`, `/tmp/cswatch-agent-t-cached-proof.log` and `/tmp/cswatch-agents-native-output-proof.json`.

Real inputs exposed float32 matrix drift in deep finger hierarchies and valid sparse face morphs. Exact matrix inversion retains the original rigidity checks. Sparse counts, index/value ranges, alignment and strictly increasing in-range indices are validated before NodeIO under the unchanged 8 MiB decoded geometry cap, then stored densely before lossless compression. Original regressions cover implicit-zero bases, oversized/malformed declarations, duplicate/decreasing/out-of-range indices and deep-chain precision. Large character shader verification streams at most 64 KiB at once, separately from the unchanged 128 MiB resource allocation cap.

A genuine recorded Mirage AK POV passed with prepared geometry, native agents and equipment in dark desktop/high quality and light phone/low quality. Both profiles reported nine visible ready agents, zero agent fallbacks/errors, four ready equipment instances, four recorded world items/rotations, no page errors and no overflow. Ten other equipment references were unavailable, consistent with partial registry preparation. Evidence: `/tmp/cswatch-native-equipped-map-browser-3.log` and `.design/native-equipment-map/report.json`. This proves coexistence and observed native model rendering, not exact grips, recoil, player-specific animation or physical-device speed.

Final genuine third-person follow checks passed with a CT recorded AK at tick 12696 and a T recorded AK at tick 11520. The five/ten living native agents and three/four prepared equipment instances were ready, with zero fallbacks, asset errors, console errors or overflow. Fresh photographs were inspected after suppressing selected head/ground markers. The original real-shader browser regression also verifies exact camera/projection, immutable selection, backward seeking and marker-free pixels. Evidence: `/tmp/cswatch-final-native-model-route-browser.log` and `.design/native-equipment-map/follow-report.json`. Static attachments can diverge from posed hands and do not establish native grips or animation. The CT Bowie model remains unprepared.

## Container, final checks and remaining evidence

Compose uses `ghcr.io/buco7854/cswatch:latest`, with optional `CSWATCH_IMAGE` override and no bundled reverse proxy. Local Compose validation previously passed the read-only/non-root/networkless configuration. Docker is unavailable here. The [release workflow](https://github.com/Buco7854/cswatch/actions/workflows/ci.yaml) must build and exercise actual parsing/private uploads/offline speech in the hardened image before publishing the final commit. Earlier workflows do not establish this revision's result.

The final build, EN/FR coverage, formatting and four production dependency audits passed. The auth/setup focused run passed nine cases with one intentional setup-policy skip. Dedicated setup passed four cases with one environment-policy skip. Staged source review excludes recordings, extracted audio, game artwork, generated caches and private runtime credentials. Prepared packs remain local at ignored `var/maps-final` and are installed as `DATA_DIR/maps` separately from the code/image. No image publication is claimed until that revision's workflow succeeds. Cache remains unavailable unless a later run obtains enough storage and completes publication.

Live Steam/FACEIT credentials and approved partner downloads, broader map/version coverage, representative subtitle quality, physical S24/TV performance and independent security review remain external evidence. All QA artifacts above are local ignored output, not bundled game content or user data.
