# Instance enrollment and temporary guest uploads

An instance with no administrator exposes only health, non-secret configuration, authentication status and setup APIs until enrollment completes. The frontend routes to setup. Registration, normal sign-in, uploads, replay APIs and provider APIs cannot bypass first-run enrollment.

At web startup, `ADMIN_USERNAME` and `ADMIN_PASSWORD` can create the first administrator. Both must be set together. Username and password validation match local account rules, including the 12-character password minimum. An existing administrator is never renamed or reset from environment values. If the requested name already belongs to a non-admin account, startup fails rather than taking that account over.

Without those environment values, the web service creates a random 256-bit one-time code at `DATA_DIR/setup-token`, normally `/data/setup-token` in Compose. The file is created exclusively with mode 0600 under the private data directory. Opening rejects symlinks, nonregular files, multiple hardlinks, excessive size and public permissions, using nonblocking/no-follow reads. SQLite retains only the code's SHA-256 verifier.

The operator can read the code with:

```sh
docker compose exec web cat /data/setup-token
```

Submit the username, email address, password and setup code through the setup page. The environment bootstrap accepts an optional `ADMIN_EMAIL`. An address supplied through either setup method is recorded as verified at account creation, even with SMTP disabled. Check the address carefully because it can receive password-reset links once email delivery is enabled. The server requires exact Origin, rate limits failed attempts, validates the code before expensive hashing, then atomically rechecks that no administrator exists and consumes the verifier while creating the account. Competing enrollment requests cannot create two first administrators. Successful setup removes the code file and issues an enrollment-only session when the administrator role requires a second factor. Complete factor enrollment to enter the workspace. The code is never returned by an API or logged.

## Account sign-in and recovery

Public registration asks for an email address, display name and password. Email addresses are unique without regard to case. People may share a display name. Sign in with the address or the assigned username. Steam OpenID supplies a Steam ID. On first sign-in, complete the display name and address in cswatch. Later Steam linking keeps the account’s existing address. Email addresses stay private to the account and authorized account administration. Password and Steam sign-in prompt for a second factor whenever the account has one. A discoverable passkey with user verification can sign in directly. Passwords, TOTP and stored recovery codes depend on the user recognizing the correct site. WebAuthn binds passkeys to the configured origin and relying-party ID.

Once the instance has enrolled passkeys, startup checks the configured hostname against its stored relying-party ID. Restore that hostname if it was changed by mistake. For a planned hostname change, verify alternative sign-in methods, retire existing passkeys on the old hostname and enroll on the new one. The local factor-reset command is available during an outage. Startup similarly refuses a configuration that disables the sole administrator’s last primary method.

If passkey setup is interrupted, retry in the same tab. A retry can resume an attempt after reloading the page when the browser keeps tab data. If the tab is gone or that data is unavailable after reload, wait for the attempt to expire before starting again. If setup stops after your device creates a passkey, your device or password manager may still list it. Check your account’s passkey list before removing the unused entry from the device or password manager.

Correct any name error before creating or renaming a passkey. A name with hidden formatting or control characters may come from pasted text or joined emoji.

To finish setup for a passkey you already created, leave the name blank and choose **Continue setup**. If your device selects an existing passkey, choose **Continue setup** again and select the passkey you just created before the attempt expires. The passkey keeps its original name, and you can rename it once setup is complete.

Set `MFA_REQUIRED_ROLES=admin,member` to require enrollment for both roles, `admin` for administrators, or `none` for voluntary enrollment. An explicit value locks the instance setting. Leaving the variable unset permits a change in Administration and defaults to `admin`. Keep an independent working sign-in method before removing a credential. Save single-use recovery codes offline. A code can complete an account's second step, while changing security settings still requires a qualifying fresh proof.

A full session ends after 24 hours of inactivity or its configured absolute lifetime (`SESSION_DAYS`, default seven days), whichever comes first. Account settings list active browsers using a coarse address and a device label derived from the browser's user agent. Step-up lasts five minutes. A Steam reauthentication returns a new verified assertion and may use an existing Steam session.

Privileged API reads require same-origin browser metadata, the exact application Origin, or the session-bound read header used by the UI. An explicitly cross-site request is refused. Direct browser navigation to the admin page still uses the role and network checks.

An operator with local access can run `node dist/cli.js list-admins`, `create-admin USERNAME`, `reset-password USERNAME` or `reset-factors USERNAME`. Use an interactive terminal for credentials. A password reset deactivates the old password and signs out existing sessions. Deliver the ten-minute recovery code privately to the verified account owner. Open the recovery form in a signed-out browser, choose a password, then sign in with any surviving factors. Generate another code if the original expires or its browser is lost. If the connection drops while saving a password, reopen recovery in the same browser to check the completed reset. If two forms used the same claim, use the password from the request that completed. Where resetting the only admin would remove the last working sign-in, create a second admin first. A party that obtains a recovery code can claim it, so verify the recipient independently before delivering it. Encrypted backups and logging sinks need their own retention and access policies.

## Email delivery, verification and password reset

Use a fresh data directory for schema 9. The service rejects earlier schemas before opening SQLite. Preserve the old directory and operator-managed assets separately.

Configure `SMTP_HOST`, `SMTP_FROM`, `SMTP_USERNAME` and `SMTP_PASSWORD` on the web service. `SMTP_PORT` defaults to 465. The relay must support implicit TLS with a trusted certificate and authenticated PLAIN submission over that connection. Set `APP_URL` to the external HTTPS origin. Keep the relay credentials private to the web process.

With relay settings in place, enable **Email verification and password recovery** under **Administration → Instance settings**. Setting `EMAIL_DELIVERY_ENABLED=true` or `false` in the environment locks the switch. The default is off. When enabled, new registrations must open the email verification link while signed in to the same account and select **Confirm email** before using the workspace. The link lasts 30 minutes. The waiting screen allows correcting the address, requesting another message and signing out. Accounts admitted while verification was off and operator bootstrap accounts keep their access. Disabling delivery releases outstanding email verification requirements, retires affected sessions and invalidates mail-based links. Affected people can sign in again. Steam still requires a completed profile.

Under **Account settings → Email address**, the account holder can change their address after recent identity verification. Authorized administrators can do this under **Administration → Users** after a named confirmation and step-up. Changing the address clears its verification and retires prior reset credentials. The new address must be confirmed before email recovery works.

From **Recover your account**, request a reset link for a verified address. Everyone receives the same request acknowledgement. Receiving a request leaves the existing password, factors and sessions in place. The recipient opens the link in a signed-out browser, claims it, chooses a password and signs in again with any enrolled second factor. Email reset links last ten minutes. Operator-issued reset codes still work with delivery off. Mail possession alone cannot reset an authenticator or passkey.

## Administrative networks

`ADMIN_ALLOWED_IPS` accepts comma-separated IPv4 or IPv6 addresses and CIDRs. An empty setting permits administrators on any network. A denial applies to administration while ordinary account and demo access follows the member rules. IPv4-mapped IPv6 addresses resolve to their IPv4 equivalents. Invalid configuration stops startup.

With no `X-Real-IP` or `X-Forwarded-*` headers, the app checks the socket address against `ADMIN_ALLOWED_IPS`. Requests carrying these proxy headers must come from a peer in `TRUSTED_PROXY_IPS`. The app uses a single `X-Real-IP` or walks `X-Forwarded-For` from the socket toward the client, stopping at the first untrusted address or the end of the chain. The resulting client can share the proxy’s subnet. When both address headers are present they must identify the same client. Additional headers such as `CF-Connecting-IP` have no effect on the decision. When a proxy sends `X-Forwarded-*` metadata, it must also supply a supported client address. A malformed, duplicated or conflicting `X-Real-IP` or `X-Forwarded-For` still causes a denial.

Configure the edge proxy to overwrite client-supplied address headers, including on requests from outside your LAN. A proxy that omits all forwarding headers appears as a direct client at its own socket address. List only your actual proxy addresses or their dedicated subnets in `TRUSTED_PROXY_IPS`. For a direct deployment, leave this setting empty.

A signed-in administrator denied at `/admin` sees the TCP connection address, the verified client IP when available, and the reason address verification stopped. If the connection address belongs to your reverse proxy, list its precise address in `TRUSTED_PROXY_IPS`. Keep the networks from which people may administer the instance in `ADMIN_ALLOWED_IPS`. Check the values actually loaded into the web container with `docker compose exec -T web printenv TRUSTED_PROXY_IPS ADMIN_ALLOWED_IPS`. After editing them, apply the Compose configuration with `docker compose up -d web`.

A network denial on `/admin` means the account has the administrator role. The page explains the restriction and provides a link back to the library. An unrecognized client address points to the proxy configuration. Check the socket peer seen by the web container and ensure the proxy overwrites `X-Real-IP` with the client IP or forwards a canonical `X-Forwarded-For` chain. A client outside the allowed range should connect through an allowed network or have the operator update `ADMIN_ALLOWED_IPS`. For example, if cswatch sees the proxy at `192.0.2.10` and it forwards the browser address `198.51.100.42`, trust `192.0.2.10` and allow `198.51.100.42`. Use your deployment's actual addresses. Apply changes with `docker compose up -d web`. A message requiring administrator access means the signed-in account has the member role. **Account settings → Your account** displays the current role.

## Guest upload policy

`GUEST_UPLOADS_ENABLED` overrides the matching admin policy when set. Its default is true, but anonymous uploading is effective only on an initialized public instance. Disabling public access or guest uploads revokes guest replay reads as well as new uploads. Explicit shared-ID member demos remain independent of this guest feature. No public demo catalog exists.

`POST /api/guest/session` creates an opaque capability cookie and returns its CSRF token and expiry. It does not create a login, password, provider identity or authenticated account session. Internally a temporary owner principal reuses the same private demo foreign keys and quota pipeline. These principals cannot authenticate and are excluded from the administrator's account list. The capability cookie is HttpOnly, SameSite Lax, host-only and Secure with the `__Host-` prefix on HTTPS deployments. Only its SHA-256 digest is stored.

If a browser never receives a new guest cookie, retry the upload after 15 seconds. The same anonymous browser permits one fresh capability after that delay if the original cookie has yet to be confirmed and the temporary owner has no demo or upload reservation. Existing guest demos still require their original capability. Browser tabs serialize guest setup with anonymous bootstrap using IndexedDB. Guest setup reserves time for the full upload window, renewing the anonymous grant when its current lifetime runs short.

An upload that already reserved storage can finish through anonymous grant renewal within its original stream deadline. Sign-in, sign-out, guest expiry and disabling guest access can cancel the upload.

Guest uploads use the ordinary streamed `.dem` / `.dem.zst` route with exact Origin and guest CSRF. Missing or mismatched capability cookies cannot access their metadata, manifests, chunks or captions. Guest files stay private and cannot be published, renamed or used for personal account notes. Demo URLs alone are insufficient authorization. A visitor can delete their own completed guest demo with the same capability and CSRF checks.

Limits are independent of member uploads:

- `GUEST_RETENTION_HOURS` defaults to 24 and accepts 1 to 168 hours. Reusing a session does not extend its expiry.
- `GUEST_DEMO_LIMIT` defaults to 3. The visitor quota and a separate per-IP upload rate limit apply before accepting upload bytes.
- `GUEST_STORAGE_MB` defaults to 512. The advertised upload limit, stream limit and reservation use the smaller of this value and `MAX_UPLOAD_MB`. Prepared replay and subtitle publication also enforce the guest storage quota.
- At most 4096 guest sessions may exist at a time. Session creation is IP-rate-limited, and all uploads still consume global storage and CPU/parser bounds.

Each read checks capability expiry immediately. Worker maintenance deletes expired temporary owners, demo rows and files. A worker must be running for ingestion and storage reclamation. Expired browser cookies are not renewed implicitly, and missing capability data is never reconstructed from a filename, demo URL, nickname or account display name.

`/api/auth/me` exposes `guest_session: {csrf, expires_at} | null` separately from `user`. `/api/config` includes `setup_required`, effective `guest_uploads_enabled` and `guest_retention_hours`, without enrollment codes or administrator credentials.

## Steam and FACEIT

1. Complete first-administrator enrollment. Set `APP_URL` to the exact HTTPS origin used by members. Keep `COOKIE_SECURE=true` and preserve the configured Host through the reverse proxy. Enable providers in Administration or lock the policy with `STEAM_ENABLED` and `FACEIT_ENABLED`.
2. Steam uses OpenID 2.0. Accounts created through Steam take their Steam name, refreshed at each Steam sign-in until the member sets a password. The name comes from the Web API when `STEAM_API_KEY` is set and from the public Steam profile otherwise. The return endpoint is `<APP_URL>/api/auth/steam/callback`. Steam reads it from the request. For an existing member, start linking from Connected accounts. A closed registration policy allows an existing linked identity to sign in.
3. For Steam match sync, register an application key for the instance’s domain under the operator’s Steam account and store it as `STEAM_API_KEY`. Keep that key under the operator’s control. Publish the instance privacy policy identifying stored Steam data and storage countries and disclose the API’s as-is terms. Members use Steam Support to create their revocable game authentication code and copy a starting match sharing code. A recent older match sharing code from **Your Matches** in CS2 can start a wider sync. [Key registration](https://steamcommunity.com/dev/apikey) · [Key terms](https://steamcommunity.com/dev/apiterms) · [Match history access](https://help.steampowered.com/en/wizard/HelpWithGameIssue/?appid=730&issueid=128)
4. Match sync needs no other server setting. Saved game codes use the instance’s [encryption key](#encryption-key).
5. In Connected accounts, verify and save the game authentication code and match sharing code, then choose **View matches**. In the library’s **Steam** tab, **Sync Steam matches** walks forward up to five new entries per click and resumes from the last confirmed entry. On a browser that supports folder selection, **Import** lets the member choose their CS2 `game/csgo/replays` directory. An existing, complete replay with a matching sidecar imports directly. If the replay is missing, **Download in CS2** opens the desktop client. Keep the Steam tab open and cswatch will import the matching file when it finishes. Folder access lasts for this visit and **Forget folder** releases it. Members can also choose their own `.dem`, `.dem.zst` or `.dem.bz2` file on a Steam match.
6. In FACEIT App Studio, create an app and a **Server side** Data API key. Set `FACEIT_API_KEY` on the server. Members must have CS2 connected to their FACEIT profile and the same Steam ID verified in cswatch. **Verify FACEIT** resolves their profile from that Steam ID. **View matches** opens the library’s **FACEIT** tab, where members can page through their CS2 history. [App Studio](https://developers.faceit.com/) · [Key setup](https://docs.faceit.com/getting-started/authentication/api-keys/)
7. Apply separately for FACEIT Downloads API access and set the approved scoped token as `FACEIT_DOWNLOAD_TOKEN`. The owner must confirm that the approval covers the intended use. Start with the default fixed resource and signed hosts. If FACEIT confirms additional hosts for your approval, add the exact names to `FACEIT_RESOURCE_HOSTS` and `FACEIT_SIGNED_DOWNLOAD_HOSTS` as appropriate. Each accepts up to eight additional bare DNS names, comma-separated. Members choose **Download** on a match and select a file when several are available. **Import by FACEIT match URL** starts the same import from an older match room link. The row’s upload dialog links to its FACEIT match room and accepts the downloaded .dem, .dem.gz or .dem.zst file. [Downloads API](https://docs.faceit.com/getting-started/Guides/download-api/) · [Manual CS2 download](https://support.faceit.com/hc/en-us/articles/10622392832412-How-to-download-and-watch-a-CS2-demo)

Use **Downloaded** in either tab to see your paired demos, including queued, processing and failed recordings. This filter reads the private library during provider outages. **Not downloaded** searches provider history in bounded batches. Use **Next page** if the current batch contains only downloaded matches. FACEIT can identify a map before a demo is available from match history or matching player stats. When the provider supplies conflicting maps or no usable map evidence, the library leaves it unknown. Steam’s codes carry no recorded match date, map or score. The library shows map and score after processing when the demo supplies that evidence.

The Steam game authentication code is encrypted with AES-256-GCM and bound to the cswatch account and Steam ID. It uses the instance’s [encryption key](#encryption-key). **Remove Steam sync** deletes the saved code and discovery list immediately and leaves uploaded demos in the library. Account deletion cascades to both tables. Old backups can retain encrypted rows. A member can revoke the underlying code in Steam Support.

Exclude callback query strings, request bodies, cookies and outbound Steam query strings from proxy logs and APM captures. Keep the encryption key, API keys and approved token outside source control and browser bundles.

### Shared Steam replay imports

One optional Game Coordinator session serves the web instance. The account used for the session can look up a match that a linked member played. Before fetching bytes, cswatch checks the member’s saved sharing code, match and reservation IDs, replay token, current Steam identity and the roster supplied by the Coordinator. An operator enabling this connection needs permission for their deployment under Valve’s terms. A member’s game authentication code grants access to that member’s history. [Steam Subscriber Agreement, sections 2.G and 4.C](https://store.steampowered.com/subscriber_agreement/) · [Valve match-history announcement](https://blog.counter-strike.net/2019/09/25513/)

1. Configure `STEAM_API_KEY` and enable Steam in Administration or with `STEAM_ENABLED=true`.
2. In the web service environment, set `STEAM_COORDINATOR_ENABLED=true`, `STEAM_COORDINATOR_USERNAME` and `STEAM_COORDINATOR_PASSWORD`. If the account uses a mobile authenticator, set `STEAM_COORDINATOR_GUARD_SECRET` to its base64 shared secret. Store these values privately. Interactive Steam Guard email and approval prompts need operator attention. After correcting rejected credentials or a Guard challenge, recreate the web service to start a new login attempt.
3. Verify a member’s Steam sync codes and open **Library → Steam**. Import a match on demand or enable automatic imports for that account. Enabling automatic imports queues missing matches in the saved history, checks for new matches periodically, and feeds completed files into private demo processing. Opting out removes pending work. Removing the Steam connection also revokes the grant. The desktop CS2 handoff, replay folder import and paired upload are available when a replay has expired or the Coordinator cannot serve it.

For a server-account sign-in failure, run `docker compose logs web | grep -F 'Steam Coordinator request failed'`. The warning includes the stage (`login`, `hello` or `match`), the reason, and the numeric Steam result (`eresult`) when supplied. Account and Guard refusals pause further sign-in attempts and log once. A `busy`, `timeout` or `transient` warning identifies a temporary failure during an upstream attempt. An `invalid_reply` warning means the Coordinator response did not confirm the requested match.

| Log reason     | What to check                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credentials`  | Check that the server account can sign in to Steam. Use its account name and current password in the web service environment.                                                         |
| `guard_email`  | Steam requested email verification for the server account. The web service cannot enter an emailed code. Members can use the CS2 or file import while this challenge is required.     |
| `guard_mobile` | Check that the configured mobile authenticator shared secret belongs to the server account and the Docker host clock is correct. A one-time code cannot be used as the shared secret. |
| `guard`        | Steam reported a verification problem without a specific method. Check the server account’s Steam Guard settings and the Docker host clock.                                           |

After correcting the account or its environment, run `docker compose up -d --force-recreate web` and try one import. A per-match expiry has a separate message and does not pause the server account.

The web service logs in on demand, uses a single Coordinator request at a time and disconnects after five idle minutes. Source replies stay in memory briefly so multiple members in the same match can reuse a lookup. The replay host and path are constrained to the exact reservation and token. Valve sometimes returns an HTTP replay address. In that case the file travels in cleartext and has no transport authenticity. HTTPS responses use certificate validation. Both paths pin public DNS, reject redirects and enforce the upload limit. Parse and expansion run in the networkless sandbox.

| Web setting                                                                              |       Default | Scope                                                                        |
| ---------------------------------------------------------------------------------------- | ------------: | ---------------------------------------------------------------------------- |
| `STEAM_REQUESTS_PER_MINUTE` / `STEAM_MAX_CONCURRENT` / `STEAM_MAX_DOWNLOADS`             |    60 / 4 / 1 | Steam HTTP requests and active replay transfers                              |
| `STEAM_COORDINATOR_REQUESTS_PER_MINUTE`                                                  |             6 | Login, GC handshake and match lookup share this budget, with one active call |
| `FACEIT_REQUESTS_PER_MINUTE` / `FACEIT_MAX_CONCURRENT` / `FACEIT_MAX_DOWNLOADS`          |    90 / 4 / 2 | FACEIT Data API, download signing and replay transfers                       |
| `STEAM_BACKOFF_SECONDS` / `STEAM_COORDINATOR_BACKOFF_SECONDS` / `FACEIT_BACKOFF_SECONDS` | 60 / 120 / 30 | Initial cooldown on throttling or a temporary upstream outage                |
| `STEAM_AUTO_SYNC_MINUTES`                                                                |           120 | Minimum scheduled history interval per opted-in member                       |

The web process enforces rolling one-minute budgets across members. Download slots stay occupied through the transfer. Provider cooldown deadlines persist across restarts. Upstream retry hints are honored for up to seven days. With no usable hint, repeated outages double the delay up to one hour. The interactive route returns a retry time when busy. Automatic imports defer work and rotate between eligible members. Member storage limits, upload limits and the instance’s daily Steam API budget also apply.

### Disabling Steam

Keep Steam sign-in enabled while members who rely on it add and verify a password or passkey. An authenticator app or recovery code completes a second step and still requires a first factor. If a member needs help, open their account under **Administration → Users**, choose **Reset password**, and deliver the one-time link privately to the verified account holder. Wait for them to set a password and verify sign-in. Administration refuses to disable Steam while any linked account still relies on it as its sole first factor.

To lock Steam off with `STEAM_ENABLED=false`, first complete the same transition and verify an independent administrator sign-in. If possible, turn Steam off in Administration before applying the environment lock so the settings check can confirm the change. The environment lock takes precedence and startup logs a warning if accounts still rely on Steam. When an administrator can still sign in, use the individual recovery flow or restore the previous Steam setting temporarily. If startup reports that no administrator can sign in, restore the previous setting or use the local account CLI to create an administrator before bringing the service back up.

## Encryption key

One key per instance encrypts saved credentials, including Steam game authentication codes and pending or confirmed authenticator-app secrets. `ENCRYPTION_KEY` supplies it as 64 hexadecimal characters, for example from `openssl rand -hex 32`. Without that variable, the web service creates `encryption.key` with mode 0600 in the data directory at its first start. Back the key up with the same care as the database.

At every start the web service checks the key against all saved data. If any saved secret does not open, or if the key file is missing while secrets exist, it stops with an explanation before changing anything, so two keys are never mixed. Two commands change that deliberately. Stop the web service first.

- Change the key, for example after setting or replacing `ENCRYPTION_KEY`. The command asks for the previous key. Leave it empty when the previous key is `encryption.key`. Everything is re-encrypted in one transaction or nothing is. After the database commit, the command removes the replaced `encryption.key` and syncs the directory. If the host stops between commit and removal, rerun the change command with the verified new environment key to finish retirement. Protect historical database backups together with any retained old key.

  ```sh
  docker compose stop web
  docker compose run --rm web node dist/cli.js encryption-key change
  docker compose up -d
  ```

- If the previous key is lost, remove only the secrets that the current key cannot open. Members then save their codes again. Match lists and demos stay. Without `--yes` the command only counts them.

  ```sh
  docker compose run --rm web node dist/cli.js encryption-key forget --yes
  ```
