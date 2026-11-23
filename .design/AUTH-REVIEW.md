# Account security review

The design reviews preceded implementation. Implementation reviews examined generated source, state transitions and ordinary regression assertions. A source finding and a passing execution are recorded separately. Reviewers used isolated contexts. The severity counts below group duplicates within a round. The independent review and functional checks do not establish a penetration-test result.

## Plan

Two reviewers considered staged authentication, factor custody, administration and concurrency. Revisions specified the exact route/session matrix, randomized public sign-in names, separate Steam purposes, factor-bound step-up, the last usable administrator, fail-closed proxy trust and durable cleanup. Design findings were unscored. [Plan](AUTH-PLAN.md)

## Implementation round 1

| Severity | Finding and evidence | Correction and recheck |
| --- | --- | --- |
| High | A none-attested registration granted a full session before demonstrating signing-key possession. | Stage the key and require a fresh discoverable signed assertion with its account handle to activate. Independently traced by subsequent protocol reviewer. |
| High | Rejected per-address login requests still charged the instance budget. | All budgets apply together in a SQLite transaction. Subsequent session and web reviewers confirmed rollback and generic login failure behavior. |
| Medium | Disabling Steam did not invalidate a pending sign-in proved only by Steam. | Live pending checks in security.ts and policy retirement on change/startup. Subsequently traced. |
| Medium | Unfinished first-factor sessions could evict authenticated browsers. | Separate full-session eviction from pending records. Subsequent protocol review also removed displacement among pending browsers. |
| Medium | Disabling Steam could strand the last structurally signable administrator. | Admin settings mutation and startup validate primary methods under the effective provider policy. CLI refuses a destructive reset of the sole working administrator. Subsequent admin reviewer checked. |
| Medium | A COSE algorithm value alone did not establish the expected key shape. | Validate P-256/ES256 and bounded RS256 modulus and exponent alongside the pinned library. Subsequent protocol review tightened decoded byte types. |
| Medium | Concurrent OTP checks bypassed growing wait intervals and unrelated operations shared capacity. | Split ceremony budgets, reserve verification work transactionally and recheck after waiting. Independent follow-ups addressed clean browser availability and budget rollback. |
| Medium | Admin authority could age or change while a request body was being parsed. | Recheck after parsing and in the mutation or filesystem publication transaction. Confirmed by subsequent authorization and web reviewers. |
| Medium | A delayed bootstrap response could displace an authenticated session in the browser. | Separate bootstrap and account cookies, with live account grants selected first. Rechecked against auth-session.test.ts. |
| Medium | Steam verification consumed unbounded parallel provider capacity. | Bound outstanding verification and start admission. Reserve separate expensive password work for login. |
| Medium | Address throttling treated equivalent addresses and IPv6 privacy suffixes as different sources. | Normalize mapped addresses, use IPv4 address and IPv6 /64 admission keys. Client location in session detail is coarser. |
| Medium | Admin asset publication and SQLite audit success could diverge across process interruption. | Durable authorized intent before the externally visible write, revalidate in the publication transaction, correlate result or unknown outcome. Subsequent admin reviewer inspected map/presentation tests. |
| Medium | Descriptor reads and map queuing reused authorization captured before asynchronous filesystem reads. | Recheck member/guest, demo ACL and effective setting before response and during locked publication. Subsequently traced in admin review. |
| Medium | Deleting an account could release quota while an upload or provider download still held an open file. | Bound writer lifetime, preserve a tombstone reservation through close or recovery grace, retain it on failed cleanup. Subsequent admin reviewer inspected worker and stream tests. |
| Medium | Environment role-policy tightening temporarily hid insufficient sessions that could revive if it was relaxed. | Retire insufficient rows at startup and on settings changes. Same-database policy regression in auth-session.test.ts. |
| Low | Enrollment-only lifetime outlasted the initial proof. | Both expire after five minutes. Rechecked by session reviewer. |
| Low | Password recovery success omitted target/address. | Add target/address to recovery audit and explicit TOTP key-loss target. Rechecked by protocol reviewer. |
| Low | Rate-limit errors and expiry scans lacked accurate retry/expiry support. | Report remaining window and index expiry. |
| Low | Admin route integration referenced a stale helper and proxy test omitted raw headers. | Use matched API/page guards, and provide Node-shaped headers in fixture. |

## Quality review

A backend reviewer identified duplicate route and request policy, fragile route inventory parsing, evidence and test gaps, recovery reissue on ordinary sign-out, repeated password/Steam cleanup rules and two different proxy parsers. The integration now uses Fastify route metadata, an actual onRoute inventory, a shared mutation gate, one credential schema, common unlink cleanup and one IP parser. Generated state-machine sequences, encrypted pending/confirmed TOTP custody and administrative startup tests extend coverage. The sign-out exchange and its privilege boundary were rechecked in round 2.

A frontend reviewer identified stale-login navigation, serialized refresh blocking newer identity reads, enrollment/recovery status reconciliation, Steam step-up feedback, focus restoration, field contrast, translated errors and missing administrative/browser journeys. Refresh results now belong to the latest request. Remaining UI work is tracked in the integrated browser suite.

## Implementation round 2

| Severity | Finding and evidence | Correction |
| --- | --- | --- |
| High | Rebasing every outstanding reset could preserve a member-issued recovery grant through promotion. | Preserve a still-current exchange only across sign-out. Replace it when an admin changes an already stranded account's privilege or credentials. Test a claimed pre-promotion code. |
| Medium | Pacing contention in one browser could hard-reject a legitimate separate browser. | Per-session and account/address reservations with capped shared failure delay. A clean browser can complete. Cover contention and single-use redemption. |
| Medium | Excess first-factor logins displaced other browsers' pending MFA. | Full sessions have their own cap. Short-lived pending stages are bounded by primary issuance limits and expiration, without cross-browser eviction. |
| Medium | The RSA verifier could coerce decoded values after key-strength validation. | Require decoded byte strings for EC coordinates, RSA modulus and exponent, then validate their values. |
| Medium | A hostname change could make the sole passkey-only administrator unusable. | Persist the RP hostname, validate at startup and activation, fail closed with operational recovery instructions. |
| Medium | Anonymous admin denials could consume audit write capacity and displace authenticated denial history. | Sample unauthenticated denials with bounded memory, ignore invalid Host, partition denial retention, audit successful account-detail access. |
| Medium | OTP reservation collisions could still charge the admitted browser and global ceremony budgets. | Reserve and charge inside one synchronous transaction. Assert the committed global count for a contended operation. |
| Medium | Registration hashing could occupy every password-work slot. | Bound concurrent registration work separately and add instance admission. |
| Low | Anonymous logout rotated an anonymous browser unnecessarily. | Return its existing status without changing the database or cookie. |
| Low | Pending transition response could include the previous guest's CSRF. | Project guest status only in anonymous stage, including in rotation responses. Route inventory uses a real guest cookie at primary sign-in. |
| Low | Guest demo events retained a correlatable guest ID in the admin audit. | Store no guest actor for upload/deletion events. Signed-in member events retain their actor. |
| Low | Import authority could change between match lookup and storage reservation. | Revalidate at reservation under the write lock and before sending the fixed-endpoint signing call. |
| Low | None attestation accepted an unchecked statement shape. | Require an empty decoded map before entering the library verifier. |
| Low | Reload after browser-bound recovery claim lost the reset form, and completion omitted the assigned username. | Add authenticated-browser claim status and return the assigned username only after successful redemption. Frontend follow-up and regression cover this exchange. |

## Implementation round 3

Five independent reviewers inspected revision `12c3a48`. Multiple reports of the same failure appear once. These counts distinguish separate failures even when they share the same correction.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Medium | Concurrent OTP attempts from independent browsers could all wake together after an account delay. | Reserve per-user verification times under the SQLite lock with increasing spacing and a bounded queue, alongside shared admission. Authenticator lifecycle assertions cover shared-clock spacing and a returning legitimate browser. |
| Medium | Authenticated password verification could fill every Argon2 slot and sign-in could charge a budget on capacity rejection. | Reserve two slots for sign-in. Charge admitted login work after getting its slot. Auth login lifecycle checks capacity and charges. |
| Medium | Ordinary member admin denials and routine account activity could evict administrator denial and success history. | Sample member and public denials separately. Reserve audit retention for operator, account and public events. Admin accounts tests cover denial sampling and history isolation. |
| Low | Guest expiry could release quota while a writer still held the file or reserve against a just-expired owner. | Expire owner and queue reserved bytes atomically, recheck the owner during upload reservation, and release after close. Setup guest tests exercise an in-flight reservation. |
| Low | A full session opening an enrollment return URL could land on an enrollment-only view, and a shared-browser identity change could keep the previous recovery receipt visible. | Require a prior enrollment transition on the same route and key the receipt by assigned username. |
| Low | A pending user following an ordinary shell link could receive a JSON error. | Send browser GET/HEAD shell navigation to the required challenge or enrollment page. The route inventory still refuses protected API requests. |
| Low | A validated Steam step-up flow could expose a raw error page after provider refusal or expiry. | Return the browser to its validated local destination with a translated error marker, record the denial, and leave proof unchanged. |
| Low | With simultaneous member and guest cookies, a guest owner mutation could consume member CSRF and log the wrong actor. | Select one principal for the entire request. Check guest-only access, dual-cookie reads and deletion, and anonymous guest attribution in the guest regressions. |

A reviewer also noted that a network change before client-side entry could show cached administrator tabs while API requests were denied. The administration page now obtains current access before mounting the tabs.

## Implementation round 4

Five fresh reviewers inspected `8174271`. The web and transaction reviews identified overlapping OTP cases, listed once below. There were no critical or high findings. There were four medium findings and eight low findings.

| Severity | Finding and fixture | Correction |
| --- | --- | --- |
| Medium | Starting ineligible Steam ceremonies charged other users' instance admission. | Validate stage, identity and factor eligibility before charging and committing the state together. Security tests compare the instance count around an ordinary wrong-stage request. |
| Medium | Password attempt budgets for a username no longer spanned independent source addresses. | Add a short, fixed username window in the same admission transaction. Rejected requests do not extend that window. Login lifecycle tests check separate addresses and another identity. |
| Medium | Queued OTP work could reserve low delays before previous failures were recorded. | Each reservation budgets conservatively for earlier unfinished attempts for that account or source. Verification still rechecks live factor and session state. |
| Medium | Expired guest principals occupied all issuance slots until slow maintenance batches completed. | At the capacity ceiling, reclaim one expired principal under the issuance lock and preserve its unsettled demo reservations. The guest capacity test covers both live and expired cohorts. |
| Low | A submitted TOTP could expire while waiting for its server slot. | Validate the code at server admission time, revalidate the live seed, replay step and session at commit, and bound queue age. An enrollment fixture advances the clock two steps at verification. |
| Low | Late timers could collapse several scheduled OTP slots into consecutive verifications. | Enforce the account’s actual verification spacing in the transaction as well as staggering admissions. Lifecycle assertions check actual commit times. |
| Low | An in-flight guest request with an initiating browser session could finish after that session rotated. | Recheck the initiating anonymous grant as well as the still-live guest capability when publishing uploads and map work. |
| Low | A shared-browser account switch could combine a stale account label with a different account's fields. | Bind application reads to the session seen by the UI, refresh identity on a mismatch, and clear stale account views. Session regression and browser lifecycle tests exercise the transition. |
| Low | After an abandoned login succeeded, another mounted anonymous form could stay enabled on a full session. | Preserve the active attempt while it is pending, then show the signed-in account and give the user control of continuing or signing out. |
| Low | Returning from Steam after the initiating session expired could expose JSON. | A browser navigation with expired or unvalidated state returns to a fixed local sign-in page. A valid state may return to its own action. A fixture covers session expiry without granting fresh proof. |
| Low | Setup and local key-maintenance events used an account or public retention partition. | Mark these operator events explicitly and check the setup and environment provisioning records. |
| Low | Independent retention limits could separate a published operation's intent and terminal record. | Retire a linked pair together, and retain a terminal result independently when the original intent has already expired. Account tests check the retention boundary. |

An adjacent pre-existing cleanup limitation remains for ordinary owner deletion and age-based retention if the filesystem itself fails. The schema 8 account deletion and guest-expiry paths use durable reservations. The independent test-harness review also corrected Fastify registration timing, stale test sessions and false-positive guest/Steam assertions.

## Implementation round 5

Five fresh reviewers inspected `deb44e3`. Overlapping reports are grouped by failure. There were three medium findings and six low findings, with no high or critical findings.

| Severity | Finding and evidence | Correction |
| --- | --- | --- |
| Medium | A former tab's library, private bookmarks and per-demo requests could read under the browser's new identity. A failed cross-tab status refresh could leave the previous account's view visible. | Bind personalized demo reads (including the bounded map descriptor reader) and recovery status. Scope viewer and confirmation state to the current account, hide a known-changed account immediately and require new status before showing private views. Browser library and account lifecycle tests cover these requests. |
| Medium | A password recovery form could submit for a different account claimed in another tab of the same browser. | Bind each form to a public claim identifier plus the original browser and generation, and require the same claim before and after hashing. Reload resumes only the confirmation saved in that tab’s browser-history entry. Two-target redemption regression in password-recovery.test.ts. |
| Medium | Missing or ineligible factor ceremonies could charge a shared verification budget. | Check the live ceremony and authorized stage before shared admission. Subsequent proof and credential validation still take place at commit. |
| Low | OTP actual-spacing bookkeeping used the clock just before the synchronous verifier. | Record the completion time under the same lock as the proof result. |
| Low | Ordinary account audit events and session origins could record a trusted proxy itself when the client hop was unknown. | Use the strict peer resolver for authoritative event attribution and session display. An indeterminate client remains null. |
| Low | Guest capabilities were rechecked after routing only on writes. | Recheck captured guests before every handler, including authorized replay reads. |
| Low | Local key maintenance recorded its operator event after committing the secret changes. | Move rotation and confirmed loss events into the SQLite transaction. An induced audit storage error rolls the key changes back. |
| Low | Steam ceremony eligibility could change while waiting for the lock before charging shared start capacity. | Check Steam eligibility under the same admission lock. |
| Low | Wrong-origin requests carrying an administrator cookie could enter operator denial retention. | Track validated first-party request provenance for operator audit retention and sample untrusted requests separately. The wrong-origin fixture checks the operator denial count. |

## Implementation round 6

Five fresh reviewers examined `32e917a`. The combined findings were four medium and five low. No critical or high findings were reported. Each row identifies a distinct observable failure.

| Severity | Finding and evidence | Correction and regression |
| --- | --- | --- |
| Medium | A successful logout followed by a failed status/config refresh could still display private data and fail to notify other tabs. | Retire the previous account and notify other tabs as soon as the server confirms logout. Browser lifecycle coverage interrupts the follow-up read. |
| Medium | Restoring a suspended tab without a cross-tab signal could leave old private data visible while a session check was pending or failed. | Conceal suspended private views across validation and replace the account on a changed identity. Cover failed and successful same-account restoration. |
| Medium | Routine detail reads could evict step-up-protected administrative mutations from operator retention, as demonstrated by the prior retention fixture. | Separate routine reads and unlinked denials from durable administrative writes and bound repeated audit entries. Exercise publication intent and outcome retention under routine traffic. |
| Medium | Sustained failures from independent sources could reach the full shared OTP verification budget against one account. | Share a twelve-attempt, ten-second window across OTP methods on an account, increase spacing to two seconds after repeated failures and isolate high-entropy recovery code admission. Test saturated OTP admission, recovery availability and actual checking intervals. |
| Low | Following the recovery screen's own sign-out action could erase its submitted recovery link before use. | Carry a code through that explicit local sign-out in memory, scoped to the originating view. |
| Low | A cross-site administrator detail read could succeed while its event was classified as untrusted and unattributed. | Require first-party provenance for privileged API reads and test that cross-site detail access is denied. |
| Low | A browser-bound claim whose target generation changed could still spend Argon2 work and the completion allowance. | Check the live browser, matching claim, generation and expiry in the admission transaction before spending the allowance. Recheck all four when consuming. Test the budget before and after invalidation. |
| Low | Ordinary demo deletion could release its storage reservation before a parser or speech worker released scratch. | Lock ownership/status and durable deletion together. Preserve disk reservations across worker leases on ordinary deletion and age-based cleanup, as on guest expiry and account deletion. Exercise a still-active speech lease. |
| Low | A redundant pacing-row deletion after OTP completion could fail after the session and recovery codes had already committed. | Perform fallback pacing cleanup only after a failed transaction. Verify successful deletion occurs inside the proof transaction. |

## Implementation round 7

Five fresh reviewers traced `a369c97`. The protocol review found no actionable defects. Across all five lenses, five medium and five low findings remained. No critical or high findings were reported.

| Severity | Finding and evidence | Correction and regression |
| --- | --- | --- |
| Medium | A native confirmation attached outside the workspace could disclose a target account or trap focus during failed restoration. | Dismiss or conceal private modal and menu surfaces during validation. Exercise a target-named confirmation and keyboard access to retry. |
| Medium | Ending the current session or every session from the device list could leave private data visible while status refresh failed. | Route all browser-ending operations through the same successful-response retirement used by explicit logout. Also retire self-admin operations while preserving their intended one-time receipt. |
| Medium | The same account returning under a reduced role could retain its admin detail or confirmation until the configuration request finished. | Reconcile role and UI authority as soon as the authoritative status arrives. Retire privileged dialogs and content across a delayed or failed configuration read. |
| Medium | A refreshed anonymous session could display a previously cached guest replay after the guest capability expired or changed. | Include the guest capability in local view lifetime and invalidate cached private replay content when it changes. Keep the capability out of cross-tab messages. |
| Medium | A tab initially created hidden could reveal private content on its first foreground before validation. | Start the suspended state from actual document visibility and gate the first restore. |
| Low | A delayed logout notice from an older session could permanently reject a newly established browser session during Retry. | Treat peer notices as a reason to conceal and consult the authoritative status. Only actual local logout confirmation retires its exact context. |
| Low | A failed audit insert consumed the sampler reservation and suppressed the first successful read on retry. | Advance the bounded samples only after persistence succeeds. An injected write failure is followed by a successfully audited retry. |
| Low | The ordinary demo deletion transaction could use authority captured before waiting for its write lock. | Revalidate the initiating browser or guest inside the owner transaction. Use the same check for adjacent demo visibility, notes and caption mutations. A controlled prior revocation leaves both the demo and deletion queue intact. |
| Low | Retrying a caption job could erase the prior worker start time before a cancelled worker closed its files. | Preserve that timestamp until a new worker takes the lease. Its deletion deadline and byte reservation survive requeue. |
| Low | Without either Origin or Fetch Metadata, privileged API reads treated an unknown origin as first-party. | Require exact Origin, a same-origin fetch indicator or the live session-bound read header. Missing provenance now yields a denied read. |

## Implementation round 8

Five fresh reviewers examined `88aa1a4`. Three medium findings and five low findings remained. No high or critical findings were reported.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Medium | A locally held administrator self-reset link could reappear after another anonymous browser session replaced the original one. | Rotate to a specific anonymous grant in the self-action transaction, return it with the receipt and bind the browser’s in-memory receipt to that exact grant. Retain only same-grant retries. |
| Medium | A successful configuration read reporting loss of admin network access could leave a target-named modal or its focus trap on screen. | Scope administrative confirmations and step-up prompts to the live administrative view. Test a verified network denial with an open prompt. |
| Medium | A visible admin tab could retain old details on focus after status succeeded but the network-policy read failed. | Conceal the admin view when its access is being revalidated and require a successful decision before exposing it. |
| Low | A session could expire or be revoked while its activity update waited for the SQLite lock, immediately before serving private reads. | Read and check the live grant and clock in the activity transaction. Recheck the initiating principal after the touch. A fixture moves the idle deadline across the lock boundary. |
| Low | The audit insert could commit before count-based cleanup failed, incorrectly retaining a success row and allowing a duplicate on retry. | Commit insertion and count retention together, including when called outside an existing transaction. A failure during periodic cleanup rolls back that sample. |
| Low | An admitted OTP timer could outlive the HTTP socket and consume a valid proof after known disconnection. | Limit admission to the available response window, recheck the monotonic deadline and socket before consuming. Test a queued slot beyond the connection deadline. |
| Low | A delayed anonymous logout response could clear a newer account cookie from another tab. | Retire the old bearer in SQLite and set only the anonymous cookie on the response. Verify that the response never addresses the account cookie. |
| Low | A guest view could outlive a capability change during the paired status/config reads. | Bind the configuration read to the guest context and current browser context inside one transaction. Retry a mismatched pair while concealing private content. |

## Implementation round 9

Five fresh reviewers examined `5d91f92` on released base `97d1b9f`. Their reports contain five distinct medium and six low findings. No critical or high findings were reported. Recovery handoff received both low and medium ratings and is counted once at the higher rating.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Medium | An unconfirmed sign-out could pass a recovery code to an unrelated anonymous browser grant. | Keep the in-memory code only when the sign-out response establishes the exact anonymous grant. Cover loss of the response. |
| Medium | Guest expiry between request hooks could yield a generic error before the paired configuration check signalled that the browser context had changed. | Return the same context-change response on both paths. Exercise account and guest drift during hook processing. |
| Medium | An encoded or uppercase administrative route, or a same-account peer notice, could skip concealment while rechecking network access. | Match the same route as the browser router and conceal for sensitive revalidation triggered by focus or another tab. Exercise mixed-case encoded navigation with a failed configuration refresh. |
| Medium | Two tabs starting guest uploads could issue different guest capabilities and strand a private upload. | Permit a single guest issuance per anonymous browser grant. Serialize browser-side bootstrap and issuance using Web Locks when available. Include a two-tab upload assertion. |
| Medium | A delayed authenticated response could reinstall a previously signed-in account’s still-live cookie after a newer browser sign-in. | Track issuance by browser and retire superseded account grants on the server. Exercise out-of-order account responses and verified sign-out. |
| Low | Logout captured its initiating session before the SQLite write lock. | Revalidate inside the transaction before auditing or rotating. A controlled revocation prevents both. |
| Low | A guest owner could be created after policy or browser authority changed while the request waited. | Check policy, live authority, admission and creation under the same lock. Test an intervening policy or browser change. |
| Low | Sampling a detail read inside its enclosing transaction advanced the in-memory counter before SQLite committed. | Mark the sample after successful commit. A deferred constraint fixture forces an outer rollback and exercises the next successful retry. |
| Low | A Steam match read or sync removal could use a session revoked while awaiting admission. | Check the live session, charge admission and read or remove records in one transaction. Abort the live sync only after authorized removal commits. |
| Low | A delayed Steam callback could clear a newer attempt’s state cookie. | Consume each server-side state once and rely on the short cookie lifetime. Exercise overlapping attempts. |
| Low | Cross-origin navigation could extend the idle lifetime of an otherwise unused account session. | Renew activity only for a first-party request. Check that external navigation preserves the old deadline and an authenticated same-origin read advances it. |

## Implementation round 10

Five fresh reviewers inspected `d750226` on released base `9fdd7db`. Four medium and six low issues remained, including an inherited key-publication interruption. There were no critical or high findings.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Medium | Concurrent first visits could obtain unrelated account and guest browser bindings in one cookie jar. | Probe for an existing session without issuing cookies. Only the allocating request takes an origin-wide IndexedDB write lock. A cold two-tab browser fixture includes a context without Web Locks. |
| Medium | A foreground or peer refresh could supersede an ambiguous sign-out before the local revocation was confirmed. A device-list action could also report success after an unconfirmed wider write. | Keep outstanding local confirmation across refresh generations and retries. Bind the confirmation to the observed anonymous grant and distinguish a verified local sign-out from an uncertain wider change. |
| Medium | Setup, bound reads and upload admission could disagree with the framework over which API route an alternate request path selected. | Apply these checks to the matched route template. Keep the raw path check for unknown API routes so setup still protects them. |
| Medium | Cached private replay audio could resume before access was confirmed on tab restoration. | Stop scheduled sources, mute and suspend the shared audio context during validation. Resume playback only after the workspace becomes visible again. Browser coverage uses a synthetic recorded voice track. |
| Low | A pending-session redirect could retain a reset secret in its destination fragment. | Serve the recovery shell at its canonical path in both pending stages and offer only the required sign-out before redemption. Test the stripped fragment in both stages. |
| Low | An interrupted key publication could leave the canonical key and its staging name linked together. | Recover the precise private staging link to the canonical inode and retain denial for arbitrary additional links. Cover a restart between publication and cleanup. |
| Low | Manual operator artwork could complete an asynchronous read after instance access changed. | Revalidate shared asset reads at response time and discard their private content or cache headers if authorization has ended. |
| Low | An older Steam start response could overwrite a newer start cookie after its previous state had been invalidated. | Use attempt-scoped state cookies, retain the one-use server claim and cap starts per browser. The overlapping-ceremony fixture checks that cookie names differ. |
| Low | A near-expiry anonymous session could discard a valid guest transfer at completion. | At guest admission, renew the browser grant if it lacks sufficient time for the bounded upload. Keep guest capability and single-issuance checks separate. |
| Low | The hidden viewer could intercept Tab and prevent focus from reaching the connection retry control. | Ignore viewer shortcuts while its workspace is inert. The voice restoration regression reaches Retry using the keyboard. |

## Implementation round 11

Five fresh reviewers examined `a15c8a7` against `9fdd7db`. They reported four medium and nine low findings, including one pre-existing transcription publication race. No critical or high issues were reported. The review used source traces. The regression fixtures exercise expected behavior with disposable accounts, filesystem data and synthetic browser sessions.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Medium | A guest response and an anonymous bootstrap could install different guest capabilities when Web Locks were absent. | Coordinate cookie issuance using the same IndexedDB writer and exercise two simultaneous tabs without Web Locks. |
| Medium | A foreground administration page retained private settings after its API explicitly denied the current network. | Handle the typed network denial before returning control to the caller. Conceal the view, then confirm ordinary member access through status and configuration. |
| Medium | Disabling Steam in the UI could strand accounts that depended on that provider. | Roll back the change with an actionable explanation until those members have another first factor. An explicit environment lock takes precedence and records an operational warning. |
| Medium | Returning to an open viewer could resume cached frames and voice after its demo became private or was deleted. | Check the open demo using the observed account and guest context before revealing it. Drop its cache on access denial. The communications regression revokes access while the viewer has local frames. |
| Low | An indefinitely stalled sign-out request could prevent a new account from being verified. | Bound initial, fallback and status/configuration reads. A held-response browser test verifies replacement sign-in without repeating the original operation. |
| Low | Losing the password-reset completion response could hide the assigned login name after its code was spent. | Save a ten-minute receipt for the exact claim, browser and account generation. The receipt returns the sign-in name and confers no account authority. Test lost completion response, reload, wrong caller and reissue. |
| Low | File-backed key creation flushed its contents but could lose its directory entry on a host interruption. | Sync the parent directory before first use, including when another process published or recovered the link. Physical host failure was not simulated. |
| Low | Listing users or audit events could include rows committed by the operator CLI after checking the administrator. | Read authorization, page and count inside one synchronous transaction, including final diagnostic assembly. |
| Low | A fresh guest issuance whose response was lost could block a retry for the remaining anonymous grant lifetime. | Allow bounded retry for undelivered, unused guest issuance while preserving every owner that has private data. |
| Low | Guest admission near anonymous expiry could cascade-delete an active password recovery claim. | Retain the same anonymous grant through the bounded upload interval. True account transitions still revoke the associated claim. |
| Low | A tab could offer recovery codes for copying after another tab regenerated them. | Bind the receipt to the issuing session, retire superseded codes on verified change and give the user an explanation. |
| Low | Map preview metadata or image reads could finish after an access change. | Include both preview routes in the final artwork authorization hook. Test the switch to private access before sending the response. |
| Low | The speech worker could publish after the transcription setting changed while waiting for the SQLite write lock. | Check policy, cancellation and the active lease under the final publication lock for ready and unavailable outcomes. |

## Implementation round 12

Five new reviewers examined `5d75e44` on `9fdd7db`. Ten distinct low-severity findings remained. No critical, high or medium findings were reported.

| Finding | Correction or regression |
| --- | --- |
| Guest admission could promise more time than remained before its browser's hard deadline. | Verify the complete upload interval at admission, including at the hard cap. |
| Fallback sign-out could discard a recovery claim or receipt from a peer tab. | Invalidate preceding login proofs while preserving existing recovery work for the exact observed anonymous browser. Explicit sign-out retains its own semantics. |
| Recovery could start or complete too close to the browser deadline for a claim or its receipt to remain usable. | Confirm sufficient browser lifetime for each promised recovery interval. |
| A losing concurrent password form could imply its submitted password won. | Distinguish direct confirmation from a claim-level receipt and give neutral sign-in instructions for the latter. |
| A delayed guest renewal header could replace a newer anonymous browser cookie. | Provision cookie transport for its admissible lifetime and avoid resending the retired bearer on ordinary in-place extension. |
| Superseded backup codes could remain visible while a same-account configuration recheck failed. | Conceal account settings on a peer check and immediately conceal a verified scope change before awaiting configuration. The browser regression holds the configuration read before restoring. |
| An account-wide allowance for failed backup-code submissions could also block a correct high-entropy code from a different source. | Preserve browser, address and global admission limits. Apply the account failure limit to incorrect codes. A seeded limit fixture exercises a valid code from an independent source. |
| A late admin session loss could return a generic error and keep prior settings visible. | Bind admin writes as well as reads. Translate verified grant or role changes into the shared context-change signal before rereading settings. |
| A late 401 on the open-demo check could clear cached frames while restoring obsolete account controls. | Distinguish a changed browser or guest context from an object access denial on all bound reads. |
| A recovered username could remain visible if an anonymous grant changed during a failed focus check. | Treat the recovery page as a sensitive view and conceal it before the paired status/configuration read. |

## Implementation round 13

Five fresh source reviewers examined `1ea398d` against `9fdd7db`. Four distinct low findings and two informational observations were recorded. The administration and protocol lenses reported no issue above informational. No critical, high or medium issues were reported.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | Maintaining the same guest and browser across a grant rollover could still interrupt an already admitted private upload. | Bind each pending transfer to its own reservation and anonymous grant. Move that reservation only through a maintenance rollover, then recheck the original bearer, owner, authorization and current policy before publication. Actual sign-out still cancels the transfer. |
| Low | A delayed sign-out, device revocation or administrator self-action could install an older anonymous cookie after another tab started recovery. | Order all application requests that can return an anonymous cookie with the same browser writer used by recovery and bootstrap. Explicit sign-out can still revoke the account when IndexedDB is unavailable, without emitting a cookie outside that writer. |
| Low | Encoded account route aliases could leave sensitive state visible during a failed peer refresh. | Use React Router matching in the foreground check. Exercise the same-account backup-code receipt on an encoded account URL. |
| Low | A confirmed fallback sign-out could renew CSRF on the same anonymous grant and discard a newly issued self-reset link before it was copied. | Scope the receipt and recovery handoff to the server-issued anonymous grant ID. Check that same-grant CSRF rotation preserves it and a genuine replacement removes it before the next configuration is shown. |
| Informational | The browser-binding cookie could expire before the longest supported anonymous, pending and full account sequence. | Cover the complete anonymous absolute lifetime, pending interval and full-session lifetime when issuing the binding. |
| Informational | A file-to-environment encryption-key rotation could leave the old private file behind if the host stopped after the database commit. | Sync directory removal and document how to finish cleanup after an interruption. Historical key and backup custody remains an operator responsibility. Current credentials use the verified new key. |

During production verification, two rendering suites reported a browser-console error on an expected cold-session probe. A marked 204 now requests allocation under the same lock without producing an HTTP error. Guest ownership and admin navigation checks also use the released API's private flag and the menu's accessible names.

## Implementation round 14

Five fresh reviewers examined `70e89eb` on `9fdd7db`. They identified four low findings. The web reviewer also identified obsolete browser fixture expectations. The login and session reviewer found no issue above informational.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | Refocusing an already visible private library could leave the library on screen after status verification failed in a browser without BroadcastChannel. | Conceal personal workspaces and account entry forms before a foreground or peer check. A browser fixture holds the account status unavailable and verifies the library returns only after a successful retry. |
| Low | A guest upload first received after grant rollover but before the replacement cookie arrived could fall back to standalone guest authority. | Decline a guest mutation that supplies retired browser credentials. The guest rollover fixture exercises this arrival order and checks that an earlier, valid reservation can still complete. |
| Low | A reset link issued for another member could reappear after the same administrator signed in under a different session. | Bind the one-time display to the post-step-up issuing session and the reset lifetime. |
| Low | A recovery form could pass the secret from its original anonymous grant to an unrelated grant observed immediately before submission. | Bind the initial submission to the initiating grant, and allow a lost-response retry only for its corresponding recovery attempt. |
| Informational | Two synthetic browser cases still expected a cold probe failure or immediate new anonymous access without IndexedDB. | Check the 204 allocation signal and verify the retry state after session revocation without shared storage. |

## Implementation round 15

Five independent reviewers examined `7d5fa41` on `9fdd7db`. Their overlapping reports identified one medium and four low findings. The completion-identifier issue is counted at the highest severity reported. No critical or high findings were reported.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Medium | Reusing a client-chosen completion ID after a reset was replaced could allow an older form or in-flight password hash to match a different reset in the same anonymous grant. | Keep the server-issued claim ID immutable. Correlate lost delivery separately and require the original verifier, target and account generation at the password write. |
| Low | An admin reset could return a valid link that the issuing tab discarded if status or configuration was temporarily unavailable or the tab remained hidden. | Retain the returned link in memory under its exact issuing session and require a newer matching account and network check before display or copying. Retry verifies the existing receipt. |
| Low | Comparing the server's expiry timestamp with a fast browser clock could discard a just-issued reset link. | Start a monotonic browser timer at the request and use the remaining lifetime supplied by the server. A fixture advances the browser wall clock by 15 minutes. |
| Low | After anonymous sign-out confirmation rotated CSRF without replacing the grant, a recovery form could keep retrying its retired CSRF. | Permit an explicit retry after checking the same anonymous grant, with separate handling for an already-committed claim. |
| Low | A step-up prompt could keep requesting proof against a retired session after a successful proof response was lost. | Retire the obsolete prompt and give the user a way to confirm the action again under verified account context. |

### Integration follow-up

Before the next formal review, an additional independent administrative review of the interim receipt fix at `e63e65f` found two low issues. A pending settings, MFA policy, map or presentation change could cross into a fresh replacement session for the same administrator. A delayed self-reset response could give the browser a longer link display lifetime than the server allowed. The fixes bind the initiating confirmation and subsequent write to the verified session, and apply the remaining server lifetime to the self-reset receipt.

## Implementation round 16

Five fresh reviewers examined `42ef4d6` on `9fdd7db`. They reported six low findings. No critical, high or medium findings were reported. The administrative lens confirmed the session, network and object boundaries. The released map and viewer changes were subsequently integrated on `62328b3`.

| Finding | Correction and regression |
| --- | --- |
| An anonymous grant could expire between recovery authorization and the session sweep during hard-cap renewal, deleting an accepted claim or completion receipt. | Check the initiating grant at renewal and use that same transaction time for expiration and transfer. The clock boundary fixture verifies atomic refusal without consuming a code. |
| Backup codes could be treated as superseded after the user completed step-up and the factor write rotated the session a second time. | Track the verified session that actually issued each write and reveal or copy the receipt only after paired account and configuration verification. Browser cases cover consecutive proof and credential rotations and a failed read after first enrollment. |
| The active TOTP seed and QR could stay visible if its enrollment response was lost. | Scope setup and copying to its issuing grant, role and remaining lifetime. Conceal during verification, clear when already enrolled, and preserve wrong-code retry in the same grant. |
| A delayed upload could be admitted after its preliminary anonymous grant had too little time for the multipart reservation. | Check the actual write deadline when authorizing the reservation. A delayed-start regression checks refusal before allocation and successful retry after guest preparation. |
| A delayed completion response could show the recovered username while the browser's current session was unverified. | Read the username from the receipt after current status and configuration succeed. Cover replacement and same-grant retry/reload. |
| A reset shown by one administrator can be superseded by another operator before its maximum display time. | State explicitly in English and French that using the link or issuing another reset invalidates it. The server keeps only the newest verifier and rejects the earlier link immediately. A previously copied link can become invalid at any time. |

The earlier browser matrix also exposed stale fixture assumptions about foreground restoration, private-library mock cleanup, overlapping status responses and setup retry. The cases now wait for verified state and retain their original identity and mutation-count checks.

## Implementation round 17

Five independent reviewers inspected `f0339c84` on released base `62328b3`. They identified five distinct low findings in the account change, with no critical, high or medium findings. The administrative reviewer found no issue above informational. The map-worker observation below concerns the released baseline.

| Finding | Correction and regression |
| --- | --- |
| Opening authenticator setup twice in the same session replaced the seed while the first tab still displayed it. | Reopen the same live enrollment for that exact grant, without extending its lifetime. The options and activation tests exercise overlapping opens and use the first response. |
| TOTP setup could advertise a longer window than the fresh proof required to activate it. | Bound setup by the initiating proof, idle deadline and absolute expiry. Clear a terminal setup while keeping an incorrect OTP retryable under the same valid proof. |
| Returning to a completed recovery view could restore its username after its receipt expired or an operator issued another reset. | Bind display and copy to the current completion receipt, the verified account/configuration read and its remaining server lifetime. |
| A stalled recovery status read could leave the password form waiting indefinitely after completion. | Apply the existing browser deadline to status and receipt reads. Retrying the check leaves a completed password write untouched. |
| A guest request refused before storage reservation could spend the final allowance needed for its retry. | Keep address admission early. Charge the guest capability inside the successful storage reservation transaction. The delayed-admission case uses the supported one-upload limit. |

The released map worker snapshots a request before separately reading its result. A scan concurrent with an operator retry can pair the previous generation with a newly runnable result and charge the retired attempt group. This read order also exists on `62328b3`. It can require another operator retry and does not widen map or account authorization.

## Implementation round 18

Five fresh reviewers examined `eb292982` on `5ec4324`. They identified three low findings including a diagnostic logging issue inherited from the released version. There were no critical, high or medium findings. The administrative and transaction lenses found no further issue above informational.

| Finding | Correction and regression |
| --- | --- |
| A stalled HTTP response could leave a login or step-up form waiting after the server rotated the session. | Bound account HTTP requests, including reading the body, using the same deadline as status verification. An ordinary stalled-proof test verifies that reconciliation releases the obsolete prompt without repeating the underlying action. |
| An earlier successful factor response arriving late could overwrite a newer valid backup-code receipt. | Order accepted successful factor writes and preserve the receipt whose issuing session is still current. Browser fixtures delay an older response with and without codes until the newer ones have been shown. |
| Trace logging could serialize parser error fields containing raw request bytes. | Restrict diagnostic error serialization to approved fields. The regression uses an ordinary synthetic error containing placeholder private fields. |

## Implementation round 19

Five fresh reviewers examined `7d55ee8f` on `5ec4324`. They identified one medium and three distinct low findings. The login and protocol reviewers independently reported the same authenticator deadline. There were no high or critical findings.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Medium | At trace level, the installed multipart parser recorded the entire headers object when a member or guest uploaded a file. This existing path could record the new session credentials. | Remove both the request and multipart header objects from structured diagnostics. A successful synthetic multipart stream verifies that custom and credential headers stay out of the trace while parser limits and completion status remain. |
| Low | An admitted authenticator code could complete its 25-second server verification window after the browser's 15-second deadline. | Give the three paced authenticator POSTs 35 seconds including response delivery. The browser fixture advances the clock past the ordinary deadline and verifies that a single admitted request completes. |
| Low | An operator losing access while a map scan or queue operation was ending could see an ordinary service or conflict error and keep their cached administration view. | Recheck current administrative access before responding with asynchronous failures and nonpublishing outcomes. The synthetic settings and map regression changes the grant during the operation. Queue publication retains its own final authorization. |
| Low | A sudden host power loss could preserve the SQLite release of deletion quota before the filesystem persisted the unlink. | Sync affected directory metadata before releasing the cleanup record or upload reservation, including when a retry finds a path already gone. Injected sync failures verify reservation retention and successful retry. Physical power loss was outside this host check. |

The independent quality pass on the released base found three unused type exports and duplicate frontend role labels. The reviewed cleanup makes those types private and routes every displayed role through one exhaustive translation. The public browser matrix also caught an incomplete synthetic passkey projection in the delayed-response test. It now supplies the same device and date fields as the production response, including a nullable last-used time.

## Implementation round 20

Five fresh reviewers examined `e6fd48b0` on `5ec4324`. Their final source assessments identified three low findings and one informational usability observation. The race reviewer found no additional issue above informational. There were no critical, high or medium findings.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | A person entering a replacement password could continue editing after their original reset expired or was replaced. The server rejected a stale submission. | Return the pending claim's remaining lifetime with matching proof. Render the password field after a live status check, use a monotonic deadline, and recheck on foreground. Browser cases cover expiration, restoration of the same claim and replacement by a new reset. |
| Low | A matching asset preparation retry already in the queue could return a successful response after the initiating grant was revoked during the final asynchronous cleanup. | Check live administration access again before returning the terminal queue response. A synthetic session change after a recorded outcome exercises the pending retry. |
| Low | A private instance rejected a direct recovery page with an optional trailing slash before the browser could open it. The same mismatch affected the sessions page after sign-out. | Allow the single trailing slash on eligible HTML routes using the existing shell allowlist. Route tests exercise permitted and denied paths for anonymous and limited grants. |
| Informational | A cold browser with site storage disabled could only see generic connection advice. New account grants need the browser's shared IndexedDB writer. | Identify unavailable site storage and tell the user how to restore it. Shared-storage denials leave the browser without a new cookie and preserve the explicit sign-out fallback. |

## Implementation round 21

Five fresh reviewers examined `581101b4` on `5ec4324`. The transaction reviewer identified two low passkey enrollment issues. The login reviewer identified one low test defect that reproduced in both languages. The admin reviewer identified one informational coverage gap. The protocol and web reviewers found no issue above informational.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | Starting passkey registration in a second tab using the same grant could displace the first tab's challenge or staged key, even after its device created a credential. | Preserve one active enrollment per grant and identify cancellation by the issuing registration challenge. A second tab receives guidance while the first completes. Signed, discoverable proof still activates the key. |
| Low | The two WebAuthn prompts could offer longer than the grant or the fresh proof that authorized enrollment. | Cap each prompt by its server deadline and preserve the original enrollment limit through signed activation. Normal fixtures exercise short remaining lifetimes and attempted replacement. |
| Low | The two browser storage recovery cases expected one cookie after storage was enabled. Cold anonymous allocation issues a bearer and an independent browser binding. | Check the exact two cookie names, including the host prefix for secure cookies. The public browser run reproduced the failing assertion, and the corrected local retry cases passed. |
| Informational | The admin address resolver rejected duplicate forwarding headers and conflicting address fields without a corresponding assertion in the resolver fixture. | Add ordinary synthetic resolver inputs for duplicate records and agreement or disagreement between the supplied address fields. Deployed proxies remain outside local evidence. |

## Implementation round 22

Five fresh reviewers examined `e0bbaba1` on `5ec4324`. The transaction and web reviewers found two low enrollment delivery issues. The login and administrative reviewers identified two informational observations. The protocol reviewer found no issue above informational. There were no critical, high or medium findings.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | A native passkey prompt could begin after its grant deadline when a valid options response arrived slowly. | Subtract the request and delivery time on the browser's monotonic clock. Skip expired prompts and check the deadline again when the platform returns. A platform may keep its own UI open beyond a supplied timeout hint. |
| Low | If the browser lost the first options response, the server's exclusive enrollment remained active while the browser lacked the returned selector needed to resume or cancel. | Bind the server-generated challenge and fixed deadline to the exact session and an attempt selector that the browser knows before starting. Repeating that attempt returns the current registration or possession phase. Another active attempt cannot replace it. |
| Informational | The separate browser-binding cookie has sign-out authority over account grants in its own browser scope. | Document that custody property in the threat model. Independent browser sessions and account data retain their separate requirements. |
| Informational | Existing ownership fixtures proved own-session revocation and private note reads, but did not directly assert cross-account deletion behavior for session and bookmark IDs. | Extend the shared-demo ownership fixture with two members. Check that each member's bookmark and session survive the other member's deletion request and that each owner can still complete the action. |

## Implementation round 23

Five fresh reviewers examined `776bef39` on `5ec4324`. They identified three distinct low findings and two informational observations. Three lenses independently identified the same passkey dismissal issue. There were no critical, high or medium findings.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | A full member could remain signed in after the original enrollment proof expired and repeatedly receive a denial when trying to close the passkey form. A failed connection could also keep the form open. | Treat dismissal of an attempt under an expired proof as a successful no-op for its verified grant. Every state change still requires fresh authority. Local cancellation closes the form after the request settles, with a retryable error and the selector retained when delivery is uncertain. Server and browser cases cover both outcomes. |
| Low | The admin Steam unlink confirmation omitted the removal of linked FACEIT, Steam sync state and saved Steam matches. | Give each admin action a description of its effects. Steam unlink names the affected providers, explains the fate of imported demos, and describes session and recovery changes. The bilingual confirmation fixture cancels the action and checks that no mutation is sent. |
| Low | A completed private FACEIT transfer could be queued after its original ten-minute storage reservation deadline if publication was stalled. | Check the reservation deadline inside the transaction that queues the demo. A normal provider fixture advances the clock after transport success and verifies refusal, cleanup and ordinary retry. |
| Informational | Expired passkey setup rows can retain public credential metadata until a later sweep or session retirement. | Expired setup cannot be resumed or activated. Explicit cancellation during the live grant clears staged key data. |
| Informational | Browsers lacking the required modern abort and storage APIs were outside the executed matrix. | Production Chromium exercises these APIs. Legacy TV browser compatibility and physical operating-system dialogs remain unverified. |

## Implementation round 24

Five fresh reviewers examined `788117a9` on `5ec4324`. The administrative and web lenses found two low confirmation and form issues. The other three lenses found no issue above informational. Reviewers also noted two gaps in fixture wording or direct assertions. There were no critical, high or medium findings.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | An operator could change a role or another credential without being told that an existing password reset link stops working. If the account depends on recovery, the operator receives a replacement to deliver. | Explain earlier-link invalidation and private delivery in the affected account confirmations. Explicit password resets describe the new link. Sign-out and deletion retain their distinct behavior. The bilingual confirmation fixture covers role changes and Steam unlink. |
| Low | Resuming signed possession asked for a new passkey label even though the server retained the name from the original registration. | Explain the original name on resumed setup and let the existing credential be confirmed without entering a replacement name. The virtual authenticator fixture checks the name eventually listed for the completed passkey. |
| Informational | A browser cancellation fixture described an undelivered request as a lost cancellation reply. | Correct the fixture comment. Backend assertions separately cover a committed cancellation and delayed requests. |
| Informational | The CSP and cache fixtures covered surrounding controls without directly asserting the frame-ancestor rule and both successful and unsuccessful credential responses. | Pin the frame-ancestor restriction and no-store responses in the existing backend tests. |

The separate quality review found one low edge case in cancellation. A temporarily disabled Steam setting can invalidate an otherwise unexpired proof. The successful no-op now uses the proof’s actual time limit. A normal fixture checks that disabling Steam refuses live cancellation and re-enabling it restores the same challenge. The quality pass also removed an unused selected column.

The integrated provider regression also needed its expected network signing-call total increased to include its new late-publication case. The preceding assertions confirmed that the transfer was refused and the reservation cleaned up at the deadline.

## Implementation round 25

Five fresh reviewers examined `bb8834fdebdfd42e5d93efd9e4a7dce0c6b22784` on `5ec4324`. The login, protocol and administration reviewers each found one low issue. The transaction and web reviewers found no issue above informational. No critical, high or medium findings were reported.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | A Steam sign-in verified by the provider could lead to a generic verification error when registration was closed. Linking an identity already used elsewhere took a signed-in member away from Connections. | Fixed-purpose browser feedback returns to the validated initiating action with its safe return path. Both link conflicts share one public marker. Unbound or expired callback errors use the generic fallback. Real handler fixtures use simulated provider responses to check both HTML redirects and API status codes. The production browser fixture checks English and French feedback beside the Steam button. |
| Low | When adding a second passkey, selecting an existing key in the native possession dialog reported that setup had expired. The original attempt was still live. | An authorized, live possession attempt now distinguishes a different credential from an expired setup. The UI tells the member to choose the newly created passkey. A generated two-key fixture checks that the challenge and deadline survive and activates the intended key with one second remaining. |
| Low | An administrator with an enrolled factor could wait indefinitely for a policy update whose response stalled after commit. | Bound the policy exchange and reconcile the saved policy with an authorized settings read before another submission. The browser fixture checks an interrupted committed write and that only one mutation reached the server. |

The released FACEIT client can return an upstream error before checking for revocation when no data or success is published. A successful import rechecks the live identity and reservation under its write lock. The integrated provider fixture separately checks its normal ten-per-hour quota and the following import after that window.

## Implementation round 26

Five fresh reviewers evaluated `67a32d03d232fb14afdaa521cd6b1ca52458a00d` on `5ec4324`. There were three distinct low findings. The login and web reviewers reported the same Steam error path as low, and the transaction reviewer classified it as informational because it issued no grant. The higher rating is counted once. No critical, high or medium findings were reported.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | A Steam step-up error could carry the old action's return path into a later browser session if verification began before the attempt was superseded. | Recheck the effective provider setting and the exact session, purpose and state before sending a bound failure or recording its denial. The ordinary delayed provider fixture now starts a newer attempt during both sign-in and step-up. The retired callback receives the generic sign-in destination and the new attempt remains usable. |
| Low | A new passkey label containing a control or format character could start a native registration and then be refused by the server. | Validate creation labels against the shared rule before creating a device credential. Let an already staged possession retry keep its committed name. The browser fixture exercises a joined-emoji name and a corrected name. |
| Low | Reloading the second-factor policy preserved every displayed access flag, including flags the operator never edited. A later save could overwrite another operator's settings. | Keep actual edits separate from server values. A fresh settings read updates untouched flags, preserves outstanding edits and honors environment locks. Submit only changes. The policy fixture checks a peer's access change alongside the local draft. |

The integrated build also exposed an overly strict structural type on a callback return-path helper. Building the return location from the already validated state inside the route resolved it. The focused build, provider and callback fixtures, and interrupted-policy and localized Steam browser cases were rerun.

The separate quality pass removed obsolete locale keys, unused presentation declarations and a private permission type export. The generic authentication button now has a method-neutral CSS class. Two existing action failures gained English and French messages. The server and client both use a 25-item administration page size, which currently requires coordinated edits.

## Implementation round 27

Five fresh reviewers assessed `c8b7deaf25c905600141d671959b1d4957639b95` on `5ec4324`. Three distinct low findings concerned concurrent edits of the role policy, dismissal of passkey rename validation and the scope of password admission. The login reviewer confirmed that a superseded Steam sign-in or step-up cannot restore its old destination. No critical, high or medium findings were reported.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | Two administrators could open the same role policy, each edit a different role, and overwrite the other's requirement. | The update includes the policy originally displayed. In the same transaction as the policy write, compare the expected role set against the effective current set. A conflict leaves the policy intact, and the browser reads the new selection before another deliberate save. Separate operator sessions exercise the conflict. |
| Low | Canceling a passkey rename after a validation error left the old message visible and marked the original valid name invalid when reopening the form. | Clear local action feedback when opening or abandoning a rename and on editing a rejected value. The virtual-authenticator fixture cancels, checks focus and the absence of stale feedback, then reopens and completes the rename. |
| Low | Password changes were budgeted by the current session rather than by account as on the released base. Separate active browsers could each consume the same allowance. | Use the account identity for password-change and step-up admissions. Address and account step-up budgets are charged together. An ordinary two-browser fixture checks the shared allowance, and the password lifecycle fixture checks that changing a credential charges the account. |

The released general instance-settings form can still show a successful PATCH alongside a failed readback. A lost HTTP response allows the operator to choose Save again. Source comparison confirmed this behavior on `5ec4324`; schema 8 limits subsequent ordinary flag changes to explicit edits. Role-policy updates have their own readback and concurrency handling.

An additional pre-integration review found one low difference between the environment and UI paths for disabling Steam. Startup now retires outstanding OpenID attempts when Steam is disabled, and discards attempts whose recorded MFA policy differs from the effective policy. The same-database fixture covers disabling and re-enabling Steam and changing and restoring the role policy. This follow-up is separate from the three findings on the exact round 27 source.

## Implementation round 28

Five fresh reviewers assessed `90e877190b80a29dd3624497632ca7963c4cdb95` on `5ec4324`. Two distinct low findings concerned the browser's response to an administrative policy conflict or refresh. The protocol reviewer verified the rename correction, and the web reviewer confirmed the account-wide admission limits. No critical, high or medium findings were reported.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | A refused policy update that would have retired the initiating session could still prepare a fallback browser sign-out. A transient anonymous read during a legitimate grant rotation could then retire the replacement grant. | Recognize the typed no-write conflict and reconcile it with reads only. Preserve the original refusal across an interrupted status check. The browser fixture observes an anonymous status during a policy refusal, then opens the account using a replacement grant and checks that no sign-out request was sent. |
| Low | If the current role policy arrived in a diagnostics refresh before submission, the stale role switches reverted without telling the operator why. | Show the existing conflict message when a newer policy replaces an unsaved edit. The browser fixture covers both a refresh before submission and a refresh while confirmation is open. |
| Informational | A concurrent explicit administrative sign-out can advance the generation while a reset claim is hashing. | Completion checks the original generation and refuses that write. The existing unexpired claim may be retried after a status read. |
| Informational | The browser's authentication forms cancel native submission synchronously and send JSON. | Credential forms are rendered by React and no ordinary native submission path was identified in the reviewed app. |

## Implementation round 29

Five fresh reviewers assessed `92588dc1d53b424fcb3f8a15e074bc0f22a83bab` on `5ec4324`. The session, administrative and transaction reviewers identified one shared low browser-session issue. The protocol and web lenses found no separate issue. No critical, high or medium findings were reported.

| Severity | Finding | Correction and regression |
| --- | --- | --- |
| Low | The browser recognized a typed MFA policy conflict as a refusal, but a pre-dispatch session mismatch, an expired proof or network denial could still trigger a fallback browser logout after a policy save. A peer's replacement grant could be lost while its cookie was in transit. | Policy changes now leave grant retirement entirely to the server and reconcile the browser with reads for all delivery outcomes. Definite client errors on other delegated actions also avoid browser-wide sign-out. Existing explicit sign-out and ambiguous device revocation retain their handling. The browser fixture checks policy conflict, changed session, network denial, incomplete error bodies and a lost reply during a peer grant rotation. |

## Implementation round 30

All five independent reviewers checked `5e9c1125b3a3468c5ff06b6237d49184c8f8cc0a` on base `5ec4324fc307da0213f31b0567bd738808659a89`. The full round found zero critical, high, medium or low findings. The admission, race and web reviewers identified the same informational fixture gap.

| Lens | Conclusion from the independent source review |
| --- | --- |
| Login, sessions and pending admission | The dispatcher excludes pending grants from normal account and guest authority. Server policy retirement and explicit user sign-out have separate browser behavior. |
| WebAuthn, TOTP and recovery | Signed activation, RP and origin validation, replay checks, seed custody, scoped backup codes and restorable enrollment agree with the documented grant transitions. |
| Roles, object access and trusted networks | Administrative routes require the live administrator and configured network. Private demo ownership and guest capability boundaries hold. A stale role-policy save cannot erase a peer update. |
| Races and transactions | Live checks, credential consumption, role-policy comparison, affected-session retirement and audit publication occur in the appropriate synchronous write transactions. |
| Web platform | HTTP admission, CSRF, first-party reads, CSP, no-store, credential logging, account-wide password budgets and read-only reconciliation preserve the checked boundaries. |

The checked-in fixtures covered an interrupted save by an enrolled administrator and a replacement browser grant during a potentially session-ending save. They did not directly combine an interrupted, uncommitted policy write with the same factorless administrator grant surviving throughout. The local supplemental browser check is recorded in the verification results.

The separate exact-revision quality review found no blocking issue and no new dead translations, CSS, exports or dependency changes. It noted two redundant operations. A surviving session can receive a second session/configuration read before the actual policy read, and the UI policy path can sweep Steam states that it just cleared. The shared checks also serve interrupted verification and startup.

## Released map and viewer integration

The candidate was rebased onto `62328b3ec7014ad09558b469aa909196c92ddb0a`, including per-map lighting and preparer revision 3, actor label overlays, radar crop and overhead arrows. The account patch keeps final live demo authorization before sending a prepared environment face. Initial map-job publication uses the released create-only hard-link operation under the final authorized write. Retry staging preserves the verified immutable latest pack metadata and audit boundary. A separate quality review found an old revision-2 retry fixture and an unnecessary type export. Both were corrected.

The final rebase also includes the dead-code sweep on `5ec4324fc307da0213f31b0567bd738808659a89`. The removed map revision reader, retiering and compression tools, fog helpers, crosshair preset, member capture script, CSS and Inter dependency stay removed. The remaining package manifest and lockfile agree on the pinned account dependencies.

## Released library integration

The account changes were integrated with released revision `9fdd7db`. A separate quality reviewer checked the private library, account projection, Connections, uploads, provider cache, CSS and translations. The integrated candidate resets match history when its identity or session changes, checks Steam sync availability for the member before showing credential entry, restores the light-theme border declaration and removes obsolete selectors and messages. The released FACEIT session cache can delay retrying a demo the provider previously reported missing. This remains a provider availability limitation. The merged Steam and FACEIT flows have local fixed-endpoint fixture coverage. Real provider authorization and publication timing require a credentialed service.

## Verification

For executed lanes and limitations see [verification](../docs/VERIFICATION.md#schema-8-accounts-and-administration). Reviewers' source-only checks do not add to runtime test counts. Preliminary checks executed in isolated coding clones are excluded from the integrated verification totals.
