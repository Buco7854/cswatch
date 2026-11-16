# Current handoff

Updated 2026-11-16. Start with `docs/product/WORK.md`; it reflects the latest user request. Earlier design/task records are history, not current blockers.

## Latest authorization

The user now likes the general feel of the landing and current neutral charcoal member UI. They want a coordinated agentic product rebuild preserving every agreed feature, fixing remaining navigation/control flaws, adding an explicit HLTV/pro-demo experience, and **pushing to main when verified**. They explicitly authorized specialized agents. Root coordinates bounded file ownership; agents do not commit/push independently.

Account and connections must move out of primary sidebar navigation into the user dropdown/account area. Viewer must remain whole-tab by default, with contained controls/panels; improve dropdowns and light-theme play control. Keep EN/FR, dark/light, CPU-only TypeScript deployment, S2V offline assets, mobile/TV/desktop, extensible auth, provider/env/admin policy controls, secure uploads/queue, Docker without proxy, weekly maintenance.

## Existing POC

GitHub is `Buco7854/cswatch`; local workspace remains `/workspace/reference`. Root will preserve a baseline commit before coordinated changes. No application code has yet been pushed; remote original main had only LICENSE. Do not commit proprietary assets or ignored runtime data. Original AGPL-3.0 license stays.

Public routes: `/`, `/features/viewer`, `/features/imports`, `/self-host`. Member routes: `/library`, `/explore`, `/connections`, `/account`, `/admin`. Viewer `/watch/:id` now uses its own full-viewport shell; sample is synthetic and explicitly labeled. Public/private gates are enforced server-side as well as in UI. Steam social auth adapter and verified FACEIT data source exist; no Game Coordinator auto-download implementation or live credentials validated. No HLTV/pro catalog exists yet.

Main frontend files: `main.tsx` shell/policy; public components/`public.css` approved; `member.css` scoped neutral member/viewer controls; older `styles.css`, `workspace.css`, `brand.css` provide accumulated foundations needing deliberate cleanup. `Viewer.tsx` has a large controller/render body worth decomposing while preserving all controls. No proprietary map/agent models are bundled; optional S2V assets and generic animation exist.

Backend: Fastify + SQLite WAL, private streaming uploads, native demoparser2 in disposable CPU child, persistent queue, retention/limits. Process isolation is **not filesystem sandboxing**. Current parser child sees shared data volume; entire replay is delivered as one gzip JSON with a 200 MB uncompressed ceiling. These are real security/mobile follow-ups, not hidden solved features. Read SECURITY/STATUS/ARCHITECTURE.

## Verification so far

Before this coordinated rebuild: production build/locale/format checks passed; 13 backend/replay/catalog tests passed with zero skips and real upstream `.dem`/`.dem.zst` fixture. Public browser suite: 4 passed, 1 private-only skip, including full-tab viewer, panels, notes and native fullscreen. Private suite with registrations off and on each passed its policy test. Member QA scripts cover authenticated fixtures, long strings, state-row heights, switch geometry, viewer/panel/dock bounds, both locales/themes and 6 viewport sizes. Latest EN dark/light batches each passed 60 checks; French batches may still run. Read actual logs/reports before claiming final matrix completion.

Previously fixed real UI bugs: `.demo-state processing` collided with generic `.processing` page layout (now `status-*`); mobile input min-height stretched switches; capped vertical navigation menu wrapped a last action off-canvas (now nowrap/scroll); D-pad focus now excludes hidden details content. Landing was pixel-identical in dark/light before/after member-only styling changes. Preserve it.

## Environment and tools

Node 22.23.4 locally; supported container/CI target Node 24. All npm dependencies already installed in root/backend/frontend/tools/assets. Commands: root build/test/check:locales/format:check/test:e2e. Tests use isolated temp data. `scripts/fetch-test-demo.mjs` fetches checksum-pinned public upstream Mirage fixture into ignored var/.

Chromium: `/home/paseo/.cache/ms-playwright/chromium-1254/chrome-linux64/chrome`; set `PLAYWRIGHT_CHROMIUM_EXECUTABLE`. Test-only flags: no-sandbox, disable-dev-shm-usage, enable-unsafe-swiftshader. Production preview at `http://localhost:8000` should be checked for liveness. Tests default 4174; member QA 4176. `/tmp/reference-chrome.sh` wraps Chrome for taste inspector. Generated screenshots/logs under ignored `.design/` or `/tmp/`.

No Docker binary was available; verify before claiming image execution. Plenty of disk headroom now (~6 GB at latest check); never delete other projects/data. Live Steam/FACEIT approval, actual S2V CS2 exports/alignment, independent security audit and S24/TV GPU/thermal performance remain unverified.
