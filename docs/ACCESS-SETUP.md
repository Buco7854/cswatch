# Instance enrollment and temporary guest uploads

An instance with no administrator exposes only health, non-secret configuration, authentication status and setup APIs until enrollment completes. The frontend routes to setup. Registration, normal sign-in, uploads, replay APIs and provider APIs cannot bypass first-run enrollment.

At web startup, `ADMIN_USERNAME` and `ADMIN_PASSWORD` can create the first administrator. Both must be set together. Username and password validation match local account rules, including the 12-character password minimum. An existing administrator is never renamed or reset from environment values. If the requested name already belongs to a non-admin account, startup fails rather than taking that account over.

Without those environment values, the web service creates a random 256-bit one-time code at `DATA_DIR/setup-token`, normally `/data/setup-token` in Compose. The file is created exclusively with mode 0600 under the private data directory. Opening rejects symlinks, nonregular files, multiple hardlinks, excessive size and public permissions, using nonblocking/no-follow reads. SQLite retains only the code's SHA-256 verifier.

The operator can read the code with:

```sh
docker compose exec web cat /data/setup-token
```

Submit username, password and that code through the setup page. The server requires exact Origin, rate limits failed attempts, validates the code before expensive hashing, then atomically rechecks that no administrator exists and consumes the verifier while creating the account. Competing enrollment requests cannot create two first administrators. Successful enrollment issues a normal authenticated session and removes the code file. The code is never returned by an API or logged.

## Guest upload policy

`GUEST_UPLOADS_ENABLED` overrides the matching admin policy when set. Its default is true, but anonymous uploading is effective only on an initialized public instance. Disabling public access or guest uploads revokes guest replay reads as well as new uploads. Explicit shared-ID member demos remain independent of this guest feature. No public demo catalog exists.

`POST /api/guest/session` creates an opaque capability cookie and returns its CSRF token and expiry. It does not create a login, password, provider identity or authenticated account session. Internally a temporary owner principal reuses the same private demo foreign keys and quota pipeline. These principals cannot authenticate and are excluded from the administrator's account list. The capability cookie is HttpOnly, SameSite Lax, host-only and Secure with the `__Host-` prefix on HTTPS deployments. Only its SHA-256 digest is stored.

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
5. In Connected accounts, verify and save the game authentication code and match sharing code, then choose **View matches**. In the library’s **Steam** tab, **Sync Steam matches** walks forward up to five new entries per click and resumes from the last confirmed entry. **Download in CS2** delegates to the desktop client, which saves the recording under `game/csgo/replays`. Choose **Upload this demo** on that match. Extract a `.bz2` archive locally if necessary.
6. In FACEIT App Studio, create an app and a **Server side** Data API key. Set `FACEIT_API_KEY` on the server. Members must have CS2 connected to their FACEIT profile and the same Steam ID verified in cswatch. **Verify FACEIT** resolves their profile from that Steam ID. **View matches** opens the library’s **FACEIT** tab, where members can page through their CS2 history. [App Studio](https://developers.faceit.com/) · [Key setup](https://docs.faceit.com/getting-started/authentication/api-keys/)
7. Apply separately for FACEIT Downloads API access and set the approved scoped token as `FACEIT_DOWNLOAD_TOKEN`. The owner must confirm that the approval covers the intended use. Start with the default fixed resource and signed hosts. If FACEIT confirms additional hosts for your approval, add the exact names to `FACEIT_RESOURCE_HOSTS` and `FACEIT_SIGNED_DOWNLOAD_HOSTS` as appropriate. Each accepts up to eight additional bare DNS names, comma-separated. Members choose **Download** on a match and select a file when several are available. **Import by FACEIT match URL** starts the same import from an older match room link. When automatic downloads are unavailable, members can use their FACEIT match room and upload the file against its row. [Downloads API](https://docs.faceit.com/getting-started/Guides/download-api/) · [Manual CS2 download](https://support.faceit.com/hc/en-us/articles/10622392832412-How-to-download-and-watch-a-CS2-demo)

Use **Downloaded** in either tab to see your paired demos, including queued, processing and failed recordings. This filter reads the private library during provider outages. **Not downloaded** searches provider history in bounded batches. Use **Next page** if the current batch contains only downloaded matches. Steam’s codes carry no recorded match date, map or score. The library shows map and score after processing when the demo supplies that evidence.

The Steam game authentication code is encrypted with AES-256-GCM and bound to the cswatch account and Steam ID. It uses the instance’s [encryption key](#encryption-key). **Remove Steam sync** deletes the saved code and discovery list immediately and leaves uploaded demos in the library. Account deletion cascades to both tables. Old backups can retain encrypted rows. A member can revoke the underlying code in Steam Support.

Exclude callback query strings, request bodies, cookies and outbound Steam query strings from proxy logs and APM captures. Keep the encryption key, API keys and approved token outside source control and browser bundles.

## Encryption key

One key per instance encrypts saved credentials, currently the members' Steam game authentication codes. `ENCRYPTION_KEY` supplies it as 64 hexadecimal characters, for example from `openssl rand -hex 32`. Without that variable, the web service creates `encryption.key` with mode 0600 in the data directory at its first start. Back the key up with the same care as the database.

At every start the web service checks the key against all saved data. If any saved secret does not open, or if the key file is missing while secrets exist, it stops with an explanation before changing anything, so two keys are never mixed. Two commands change that deliberately. Stop the web service first.

- Change the key, for example after setting or replacing `ENCRYPTION_KEY`. The command asks for the previous key. Leave it empty when the previous key is `encryption.key`. Everything is re-encrypted in one transaction or nothing is. A replaced `encryption.key` is removed.

  ```sh
  docker compose stop web
  docker compose run --rm web node dist/cli.js encryption-key change
  docker compose up -d
  ```

- If the previous key is lost, remove only the secrets that the current key cannot open. Members then save their codes again. Match lists and demos stay. Without `--yes` the command only counts them.

  ```sh
  docker compose run --rm web node dist/cli.js encryption-key forget --yes
  ```
