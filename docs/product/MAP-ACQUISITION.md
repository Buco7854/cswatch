# Automatic map preparation proposal

Status: proposed after the user's 2026-11-18 feasibility question. The application currently discovers operator-prepared packs. Its public server and networkless demo worker do not acquire or convert maps. Do not describe this proposal as an enabled feature.

The supplied REFERENCE recording shows “Decoding Mirage geometry…” followed by “Loading renderer…”. These are consistent with browser loading of prepared assets. The recording does not establish how that service acquires unknown maps. [S2V map export](https://s2v.app/ValveResourceFormat/guides/exporting-maps.html) is a separate CPU preparation step from browser mesh/texture decoding.

## Intended behavior

An uploaded demo can become replay-ready independently of map readiness. Resolve its bounded source map identity and any available version/build/Workshop evidence. Reuse an already validated pack when it matches. Otherwise queue one shared preparation job for that source version, so many viewers never trigger duplicate downloads/conversions.

Official depot maps and identifiable public Workshop content are practical sources. A map name alone does not establish a particular historical layout. Removed, private, unavailable or unidentifiable versions require an operator-supplied verified pack. Do not substitute a similarly named map or silently label the latest layout as the original recording's layout. Steam login for the user's account remains separate from game asset acquisition.

Cache keys must include verified source identity/version or content hash, preparation-tool version, asset schema and quality policy. Use immutable content-addressed URLs and per-demo pack references, rather than replacing the current single map-name path while other viewers are active. Preserve the current fixed local registry and access policy until that versioned design is implemented.

## Service boundary

Acquisition belongs in an optional dedicated service with approved Steam/depot/Workshop selectors, a durable queue, global and per-user rate limits, selected-byte/storage limits, deadlines, deduplication and retention. A demo must never authorize a caller-supplied URL, arbitrary filesystem path or broad game download. Environment locks and unlocked admin policy should govern whether an instance enables this service. No new public conversion endpoint is authorized merely by this proposal.

Keep downloads separate from native conversion. Conversion receives only its source pack, stripped credentials and bounded writable scratch, with network and unrelated demo/database access denied. Workshop packages require the same untrusted-native-input discipline. Scripts are data, never executed. Publication requires validated self-contained geometry, textures, overview calibration, environment metadata and provenance before an atomic ready state. Preparation failure must preserve replay access and allow an explicit retry or position view.

Steam can limit repeated logins and historical access. Serialize/deduplicate acquisition, reuse verified cached resources and report actual network failures. Public uploads must not create an unrestricted disk/CPU download service.

## Loading presentation

Distinguish the slower first preparation from subsequent cached loading. Report real stages such as resolving the map, acquiring resources, preparing geometry/textures, validating the pack, downloading viewer assets, decoding geometry/images and starting the renderer. Show byte progress only when a trustworthy total is known. Use stage state or completed counts for indeterminate work, without synthetic percentages or invented completion estimates.

Canceling a viewer's wait should leave that view safely and release its requests/resources. It must not cancel a shared preparation still needed by other viewers. The browser renders on its own GPU; the preparation server remains CPU-only. Real phone/TV performance needs separate device evidence.
