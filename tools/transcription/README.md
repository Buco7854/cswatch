# Offline voice transcription

These operator tools prepare a small multilingual Whisper ONNX model and verify the complete CPU transcription path. They do not upload recordings or contact a transcription service. Normal HTTP requests never import the speech model.

The optional worker stage reads recorded Opus voice packets from an already prepared replay. It runs in a separate disposable kernel-confined process, with a read-only model directory, no network, and time/audio/output limits. A failed or timed-out transcription does not fail the playable replay. Automatic captions are approximate and can miss or misrecognize speech; they are not authoritative communications logs.

## Prepare a model

Use Node 24. Model preparation uses Node built-ins and needs no Python, GPU, or extra npm packages:

```sh
node tools/transcription/prepare-model.mjs --out /srv/cswatch-models/whisper-tiny
```

The CLI downloads only the files listed in `model-manifest.json`, pinned to `Xenova/whisper-tiny` revision `5332fcc35e32a33b86612b9a57a89be7906102b1`. Every file has a fixed byte count and SHA-256 digest. The roughly 44 MB quantized bundle is multilingual; keep its model card and Apache-2.0 metadata. Correct existing files are reused. Downloads go to temporary files and are installed only after verification.

Mount the resulting model directory read-only into the worker and configure `TRANSCRIPTION_MODEL_DIR` with that in-container path. Enable the transcription policy through `TRANSCRIPTION_ENABLED=true` or the admin policy when the environment flag is unset. Keep the model in an operator-controlled directory rather than a user-upload directory. See the main deployment documentation for current Compose paths and worker roles.

The runtime always sets local-files-only mode and disables remote model loading and caches. It supports the prepared quantized Whisper tiny bundle, with bounded tiny/base-sized local model validation. Missing or invalid model files produce an unavailable/failed transcription state instead of a cloud fallback.

## Verify actual CPU inference

Install the small development-only Opus encoder and build the backend:

```sh
npm ci --prefix tools/transcription
npm --prefix backend run build
node tools/transcription/verify-transcription.mjs --model /srv/cswatch-models/whisper-tiny
```

The verification downloads a checksum-pinned, 11-second JFK inaugural-address fixture used in the Transformers.js documentation. The original presidential speech is public domain; this is not a personal demo or a production account. It mixes/resamples the known stereo WAV for the fixture encoder, encodes real Opus packets, writes a temporary replay, then runs the same transcription entry used by the worker. Production decoding itself outputs 16 kHz directly through libopus.

It verifies recognizable words, speaker identity, recorded tick bounds, actual language detection, caption provenance, and zero application network calls during inference. Temporary replay files are removed; the public fixture and test model can remain under ignored `var/` for repeated local checks. `--keep-job /tmp/empty-asr-fixture-job` retains only the public fixture replay to exercise the kernel runner separately.

The optional test suite also decodes the checksum-pinned French clip from the Transformers.js documentation and verifies explicit French and automatic French detection. Its small MP3 decoder and Opus encoder are development-only tools, not runtime requirements. Runtime language identification follows Whisper's start-of-transcript decoder pass, considering only language tokens; it does not silently default to English. Short, noisy or mixed-language speech can still be identified incorrectly.

To include this integration in the backend test suite:

```sh
CSWATCH_TRANSCRIPTION_TEST_MODEL=/srv/cswatch-models/whisper-tiny npm test
```

Without that variable the real-model test is explicitly skipped. Unit tests still exercise actual Opus decoding, speaker separation, gap handling, 30-second grouping, silence suppression, timestamp bounds, and processing budgets.

Resources: [model and license](https://huggingface.co/Xenova/whisper-tiny), [offline Transformers.js configuration](https://huggingface.co/docs/transformers.js/en/custom_usage), [Opus decoder implementation](https://github.com/eshaz/wasm-audio-decoders/tree/main/src/opus-decoder), [JFK inaugural address](https://www.jfklibrary.org/learn/about-jfk/historic-speeches/inaugural-address).
