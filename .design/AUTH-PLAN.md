# Account security implementation plan

Private CS2 review application. Preserve the workspace shell, bilingual account forms, guest upload isolation and existing private demo checks. Schema 8 requires an empty data directory.

## Records and boundaries
One shared member/admin role catalog with derived permissions. Users have a random WebAuthn handle and an authentication generation. Session records carry a public management ID, hashed bearer, CSRF, user, stage, generation, issued/last-used/absolute expiry and recent proof. Touch within idle and absolute bounds. Browser bootstrap issues an opaque cookie and separate CSRF. Pending credentials have a separate discriminator and are never exposed as request.user. Single-use hashed challenges bind purpose, session, user if known, generation and expiry. Reset codes bind target and issue generation; redemption claims a browser-bound exchange. TOTP rows encrypt pending and confirmed seeds with the instance key. Passkeys store unique credential ID, public key, counter, backup flags and bounded name. Store recovery code hashes. Append bounded audit rows with actor/target IDs, action, time, outcome and trustworthy address. Durable file cleanup jobs outlive deleted accounts.

## Transitions
|Login input|Proof and transaction|Result|
|---|---|---|
|Anonymous browser|Password or verified Steam; compare current credential, generation and policy after await|Rotate into challenge when factors exist, enrol-only when required and absent, full otherwise|
|Anonymous browser|Discoverable passkey UV verification and atomic challenge consumption, handle/counter update|Rotate to full and record fresh proof|
|Challenge|Bound TOTP, passkey UV or individual recovery code; consume proof and re-evaluate policy|Rotate to full|
|Any|Logout, expiry, revoked privilege or credential generation|Revoke bearer|

|Enrolment input|Transaction|Result|
|---|---|---|
|Enrol-only or full + fresh proof|Create expiring session-bound seed or registration challenge|No change in privilege|
|Pending seed / challenge|Verify OTP or UP+UV registration; revalidate initiating session and current factors; consume once|Commit factor, revoke other sessions, rotate caller; display recovery codes once|

|Step-up input|Proof|Result|
|---|---|---|
|Full, enrolled|Fresh bound TOTP or passkey UV|Rotate, five-minute freshness|
|Full, unenrolled|Current password or fresh bound Steam reauthentication|Rotate, five-minute freshness|
|Sensitive write|Check freshness, role, target, policy and session again at commit|Audit change atomically|

|Recovery input|Transaction|Result|
|---|---|---|
|Fresh authorized admin or local CLI|Invalidate earlier resets, issue expiring hashed random code|Show once; no secret in URL query or logs|
|Browser + reset code + new password|Bind exchange to browser, validate after hashing and consume once|Invalidate sessions, retain enrolled factors; fresh login|

## Route contracts and UI
|Routes (under /api unless page)|Access|
|---|---|
|auth/me, config; auth/login, register, setup, Steam sign-in, auth/passkeys/login/{options,verify}, auth/recover|Anonymous bootstrap, exact origin + CSRF on writes; Steam callback bound state|
|auth/mfa/{totp,passkey/options,passkey/verify,recovery}, auth/logout|Matching pending stage or logout|
|auth/security, auth/factors/{totp,passkeys}/{options,verify}|Enrol-only or full with fresh proof for mutation|
|auth/step-up/*, auth/sessions|Full; sensitive writes require fresh proof|
|auth/password, identity changes, auth/factors/*, auth/sessions/:id and revoke-all|Full + fresh proof|
|/admin page, admin, admin/users, admin/users/:id, admin/audit, admin/assets/*|Full admin, permitted network; every mutation fresh and audited|
|All ordinary private/demo/guest routes|Existing owner/guest rules; pending bearer rejected globally|

AccountMenu and WorkspaceShell use server capability. AuthPage handles password, Steam, discoverable passkeys and pending challenges. Settings provides labelled factor enrolment, recovery and sessions. Admin reuses settings panels, search/pagination and Confirmation naming the target. Render errors at actions, return focus, wrap long handles; verify 1440/768/390 EN/FR both themes, reduced motion, keyboard and virtual authenticator.

## Risks and verification
Use canonical matched routes and a default-deny pending dispatcher, central admin page/API guard, trusted socket chain, strict CIDR parser including mapped addresses, and reject untrusted forwarding headers. Guard actor and target within synchronous write transactions; last usable admin counts primary credentials and required-factor eligibility. Preserve private demo data boundaries. Budget password/WebAuthn/OTP work by account/address/global without triggering prolonged target lockout. Verify static authorization coverage, positive/denied unit contracts, generated state transitions, functional browser journeys and independent defensive source reviews. Record actual fixtures and unresolved evidence. Workers run on detached independent checkouts, maximum two implementers concurrently.

## Revisions after two independent design reviews
Use exact registered method/template pairs, covering /api/setup, /api/admin/maps and all nested asset routes, HEAD, /admin and SPA navigation. On every async publication callback revalidate current actor, fresh proof, policy, session and IP. Use right-to-left trusted address selection, reject ambiguous forwarding and missing client information at a trusted proxy, normalize IPv4-mapped values. Use a separate stage-specific status projection and prevent pending bearers falling back to guest access. Role or credential changes revoke grants, and policy tightening also invalidates insufficient sessions. The usable-admin predicate counts usable primary sign-in and a path to fulfil policy (first enrolment allowed). FACEIT and TOTP alone cannot sign in. A recovery code may finish a challenge but cannot grant step-up freshness. First enrolment requires the recent primary; adding another factor requires existing factor proof. Recovery claim binds the issued verifier to a browser before password hashing and retains all remaining factors. No secret appears in audit output or screenshots.

### Implementation contract
Public registration always appends a random suffix to the requested name. This lets the browser display a usable, unique sign-in name without disclosing whether another account requested that name. Setup and CLI provisioning remain operator-bound. Steam starts via a CSRF-protected POST; only its protocol return uses navigation. A pending browser carries its own CSRF and cannot reuse a simultaneous guest capability. Password recovery uses a 10-minute code, claims it once to the recipient's anonymous session, then consumes it in the password replacement transaction. A public claim identifier binds a particular form and its browser history entry to that exchange. Login after redemption still requires enrolled factors. Store retention-limited audit events with enumerated actions and sanitized context. Render factor configuration locally and never capture live secrets in screenshots.
