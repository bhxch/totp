[简体中文](README.md) | [English](README_en.md)

# TOTP Code Tool

A pure front-end TOTP code manager: browser extension (Chrome/Edge/Firefox, all Manifest V3) + Tauri desktop app. No self-hosted backend — your data stays on your devices and your own cloud drives.

## Features

- **UI**: Material Design 3 design system, five-page navigation (Codes / Import / Sync / Security / Settings), 10 theme colors × light/dark modes (dark mode supports an AMOLED pure-black contrast layer), theme CSS lazy-loaded on demand
- **Security**: two passphrases (vault passphrase + backup passphrase), vault encryption at rest (envelope v2, three Argon2id strength profiles), DEK key store, Passkey (PRF) / OS-native auto unlock, lock policies (on restart / on system lock / after N minutes idle), clipboard auto-clear and secret masking
- **Data**: local backup (multiple directory sources, per-source retention), cloud sync across five backends (multiple targets of the same type, per-source baseline and retention), browser-to-browser sync, 17+ import formats (four-tier dedupe decision tree), otpauth link / image QR / clipboard entry capture
- **Desktop**: tray-resident read-only mini popup (global shortcut `Alt+Shift+T`), window resource release (hide → pause → destroy), built-in MCP server (local AI clients can read your codes)

Design doc: [docs/plans/2026-09-13-totp-tool-design.md](docs/plans/2026-09-13-totp-tool-design.md); implementation plans per milestone live in [docs/plans/](docs/plans/); review and end-to-end verification reports live in [docs/review/](docs/review/).

## Installation

### Browser extension (Chrome/Edge/Firefox, all MV3)

- Download the extension zips from [GitHub Releases](https://github.com/bhxch/totp/releases): `totp-extension-chromium-<version>.zip` / `totp-extension-firefox-<version>.zip` (releases include a `sha256sums.txt`)
  - Chrome/Edge: unzip, open `chrome://extensions`, enable "Developer mode" → "Load unpacked" and pick the unzipped folder
  - Firefox: requires Firefox 140+ (`strict_min_version: 140.0`); the unsigned zip can be loaded via `about:debugging` → "This Firefox" → "Load Temporary Add-on"; the store (AMO) package is uploaded manually from the zip
- Build from source: the Chrome target `pnpm --filter @totp/extension build` produces `.output/chrome-mv3`; the Firefox target is built separately with `pnpm --filter @totp/extension exec wxt build -b firefox`, producing `.output/firefox-mv3` (CI builds the two targets separately and asserts each manifest is MV3, see the [Assert MV3 artifacts step](.github/workflows/build.yml))

### Desktop (Tauri 2)

- Download the installer for your platform from [GitHub Releases](https://github.com/bhxch/totp/releases): Windows (NSIS `.exe`) / macOS (Universal `.dmg`) / Linux (`.deb`, `.AppImage`)
- For source builds and dev commands see [Desktop (Tauri)](#desktop-tauri) and [Development and build](#development-and-build) below

## Quick start

### Adding entries

Four entry points; all of them **prefill the entry form** (except batch import) and only persist after you confirm:

- **Manual entry**: account label + base32 secret (validated), TOTP/HOTP/Steam supported (SHA1/256/512, 5/6/7/8 digits)
- **otpauth link**: supports `otpauth://totp|hotp|steam|yaotp` (Yandex), three entry points:
  - Paste import (all platforms): the collapsible "Paste otpauth link to import" area above the popup form — paste the URI and click "Import"
  - Firefox protocol registration (`ext+otpauth`): the first invocation asks you to pick a handler; choose "TOTP Code Tool" and afterwards typing or clicking an `ext+otpauth:...` link opens the popup with the form prefilled. Platform limit: Firefox extensions cannot register the native `otpauth://` scheme (the manifest protocol allowlist only accepts `web+`/`ext+` prefixes), so real `otpauth://` links on web pages cannot be taken over
  - Context-menu import: select an `otpauth://` snippet on a page → right-click "Add the selected otpauth link as an entry" → after validation it is staged and the extension popup opens automatically when possible (Chrome 127+; otherwise click the extension icon to see the prefilled form); invalid selections raise a system notification
- **Recognize from image**: pick a local image in the entry form; the otpauth QR code inside is decoded and used to prefill
- **Import from clipboard**: the "Import from clipboard" button in the entry form — if the clipboard holds an image it goes through QR recognition and prefills; if it holds text, a single entry (otpauth URI / single-entry JSON) prefills the form and multiple entries import in bulk (bulk import lives in the entry form dialog on the Codes page; the popup form only supports single-entry prefill). Reading the clipboard requires the extension `clipboardRead` permission (system authorization on desktop) and a user gesture; empty clipboard or authorization failures produce explicit errors
- More bulk formats (17+) go through the [Import](#import) page wizard

### Locking

Enable vault encryption with a passphrase on the Security page and the lock screen takes effect; unlock methods (passphrase / Passkey / native auto unlock) and lock policies (on restart / on system lock / after N minutes idle) are described under [Security](#security).

### Daily use (extension)

- List: live codes + countdown, keyword search (optionally search secrets), filter by current site URL (five match strategies, configured per entry), pinning, context menu (edit / copy URI / pin), double-click an entry to show the plaintext code for 8 seconds before it is masked again automatically (masked by default)
- Management: edit/delete (double confirmation), tag management (Codes page), HOTP counter auto-increments after copy
- Options page: extension details → Extension options, mirroring the same five-page navigation; the "Open settings" button at the popup's top right deep-links to `options.html#/settings`
- Theme: switch theme mode (auto/light/dark) and 10 theme colors in the "Appearance" section of Settings; consistent across all four surfaces (popup/options/desktop main window/mini)

## Desktop (Tauri)

```bash
pnpm --filter @totp/desktop tauri dev    # dev (starts vite first, then compiles Rust)
pnpm --filter @totp/desktop tauri build  # build, produces exe + NSIS installer
```

- Data location: `%APPDATA%/com.totp.desktop/vault.json`
- Main window: full five-page management (isomorphic with the extension options). "Auto-hide on blur" is enabled in Settings; the "Hide to tray" button sits in the nav bar; clicking X collapses the main window to the tray; middle-click on the tray icon opens the main window (equivalent to the "Show main window" menu item); to quit entirely use the tray context menu → Quit
- Mini popup: read-only code list that hides itself after copy; all three of the following toggle it
  - Left click on the tray icon
  - Global shortcut `Alt+Shift+T`
  - Auto-hide on blur (always enabled for the mini window)

### Window resource release (desktop-only settings card; not rendered in the extension host)

A closed window does not have to keep the WebView alive: a three-stage policy (configured in the "Window resource release" settings card):

1. **Hide on close**: after the main window is closed via X (or hidden on blur) it lives on in the tray
2. **Pause**: after N minutes hidden the WebView rendering is suspended (Windows uses WebView2 `TrySuspend`, which requires the window to be invisible; on failure or on non-Windows platforms it silently degrades to staying hidden)
3. **Destroy**: after a further M minutes the window is destroyed, leaving only the tray process; clicking the tray icon or pressing the global shortcut rebuilds the window

- Defaults: N = 5 minutes, M = 30 minutes; both stages accept 0–1440 integer minutes, where **0 = stage disabled**
- "Lock on pause" defaults to off; "Lock on destroy" defaults to on
- With "Lock on destroy" off, the unlocked state is restored automatically after the rebuild (the key is held only in local process memory and cleared on lock/exit; never written to disk)
- Edge cases: idle lock does not fire while paused; on Windows the suspended window cannot stash its key, so **with "Pause after hiding" enabled, unlocking is still required after destroy + rebuild** — set "Pause after hiding" to 0 to guarantee an unlock-free restoration

## MCP server (desktop)

Enable it on the "MCP Server" settings card and local AI clients (MCP protocol, Streamable HTTP) can list accounts and read current codes. Design: [docs/plans/2026-09-21-mcp-server-design.md](docs/plans/2026-09-21-mcp-server-design.md); real-machine verification: [docs/review/2026-09-21-desktop-mcp-real-machine-test.md](docs/review/2026-09-21-desktop-mcp-real-machine-test.md).

- **Off by default**; binds to `127.0.0.1` only (never exposed to the LAN), default port `47215` (configurable 1024–65535)
- **Bearer connection token** authentication: shown / copied / regenerated on the card (regenerating invalidates the old token immediately); before the server is enabled the token shows the "(auto-generated when enabled)" placeholder and copying is disabled
- **Always errors while the vault is locked**; no tool ever returns secret/pin material
- **Four client authorization modes** (checked on connect): Token only (any client holding the token) / whitelist wildcards (recommended, e.g. `Claude*`) / whitelist exact match / confirm every connection (in-app approval dialog: Allow / Deny / Allow once / Add to whitelist; "Allow once" skips prompts for 15 minutes and is cleared on restart)
- **Tool surface** (exposed via checkboxes, effective immediately; calls to unexposed tools are rejected):
  - `list_accounts`, `get_code`: read-only, exposed by default
  - `trigger_backup`, `trigger_sync`: write triggers, optionally exposed and confirmed per call (authorization never remembered); only "Token only" mode skips confirmation

Client setup: the "Client connection config (JSON)" on the MCP card already contains the real token and works as copied; or wire it up in a project `.mcp.json` (ZCode/Claude Code etc.) following this shape:

```json
{
  "mcpServers": {
    "totp": {
      "type": "http",
      "url": "http://127.0.0.1:47215/mcp",
      "headers": { "Authorization": "Bearer <copy the connection token from the app's Settings → MCP Server card>" }
    }
  }
}
```

## Security

### Vault encryption at rest

- Off by default; enable it with a passphrase on the Security page and the vault is then written encrypted (desktop and extension store independently and enable separately)
- Same algorithm tier as the backup envelope (envelope v2): Argon2id derives a KEK from the passphrase → the KEK wraps a random 32-byte DEK with AES-256-GCM → the DEK encrypts the vault plaintext with AES-256-GCM (wrap/data nonces are independently random)
- **Three encryption strength profiles** ("Encryption strength" on the Security page): faster (low-end friendly) / balanced (default) / slower and more brute-force resistant. Changing requires the current passphrase; on confirmation the DEK is re-wrapped with the new profile immediately — the data itself is never re-encrypted
- Changing the passphrase **rotates the DEK** and re-wraps it (instant, no data re-encryption); existing Passkey/native auto unlock bindings are invalidated by the rotation and must be re-bound after unlocking (the UI hints dynamically). The Security page shows "local master passphrase unchanged for N days" to encourage rotation
- The passphrase is never stored or uploaded; if lost, encrypted data cannot be recovered (no backdoor, no recovery path)

### Unlock methods

Vault encryption supports multiple unlock sources (KEK sources) coexisting, managed in the "Unlock methods" section of the Security page; any one of them unlocks:

- **Passphrase (default)**: the only method when encryption is first enabled, and the fallback for everything else; cannot be removed
- **Passkey unlock (PRF extension)**:
  - After binding a Passkey on the Security page, the lock screen shows a "Unlock with Passkey" button: local verification (fingerprint/PIN prompt) lets the passkey PRF extension output derive the key directly and unwrap the DEK, unlocking without ever typing the passphrase
  - The PRF output is evaluated locally only, never sent out; binding data (credential id + salt + wrapped DEK) is stored locally
  - Browser support: Chrome/Edge and the desktop app (WebView2); PRF support on Firefox extension pages is limited — when probing fails the "Add Passkey unlock" entry hides itself with a hint
  - Binding pops two consecutive authenticator prompts (registration + evaluation confirmation); this is expected
  - Multiple Passkeys can be bound (managed individually in a list)
- **Native auto unlock (desktop only)**:
  - One osAutoUnlock channel: Windows = DPAPI (current user), macOS = Keychain, Linux = Secret Service keyring (GNOME Keyring/KWallet); when enabled the DEK is protected by OS-secure storage and the desktop lock screen silently attempts auto unlock when opened
  - Failing to unlock after switching OS accounts or machines is expected: it fails silently and falls back to manual passphrase/Passkey unlock without errors or interruptions; when no keyring service exists on Linux, or PRF is limited on macOS WKWebView, the corresponding option does not render
  - The Windows DPAPI path is covered by roundtrip unit tests; macOS/Linux keyring runtime behavior awaits real-machine verification
  - Not offered in the extension
- **Per-platform naming**: unlock method names on the Security page and lock screen are injected per platform — Windows shows "Windows Hello (Passkey)" / "Windows auto unlock", macOS shows "Touch ID (Passkey)" / "Keychain auto unlock", Linux and the browser extension show "Passkey" (desktop adds "Keyring auto unlock")
- **Switching devices**: binding data (ciphertext) travels with browser sync; cloud backup/sync (envelope) excludes it. When the Passkey credential lives on the local platform authenticator, PRF cannot be evaluated on another machine and must be re-bound; roaming credentials (e.g. YubiKey) unlock directly; native auto unlock fails silently on foreign machines. The universal path on a new device: unlock with the passphrase first, then re-bind the other methods

### DEK session sharing and lock policies

- **Extension**: after unlocking, the DEK is written to `chrome.storage.session` (browser-session storage, cleared when the browser exits); popup and options share the unlocked state — unlocking either unlocks both; locking clears it
- **Lock triggers** ("Lock policy" section on the Security page, preferences persisted):
  - "Keep locked after restart" (default on): the desktop has no session-level DEK storage so it is always locked after restart; on the extension the DEK session storage is necessarily cleared when the browser exits, so both values behave the same
  - "Lock on system lock" (default on): on desktop Windows this subscribes to system lock events (WTS); on mac/Linux the trigger is unavailable (backlog). On the extension it triggers via `chrome.idle`'s locked state
  - "Lock after N minutes idle" (default 0 = disabled): on the extension it polls `chrome.idle` every 30 seconds while the options page is alive (threshold = configured minutes); on desktop an idle executor decides. Firefox supports the idle API (including the `locked` state) — available since the MV3 migration (min_version 140); if it is still unavailable at runtime, a degradation notice is shown on startup

### Clipboard auto-clear and secret masking

- The clipboard is auto-cleared 30 seconds after copying a code (can be disabled on the Security page); on the extension this runs via the background worker (alarms + offscreen) on Chrome/Edge so it still clears after the popup closes; Firefox has no offscreen API, so auto-clear is unavailable — the toggle remains but has no effect
- In entry/edit forms the secret input is masked by default; the button on its right reveals it temporarily; double-clicking a list entry shows the plaintext for 8 seconds before it is masked again automatically

## Backup and cloud sync

Backup features live on the Sync page (desktop main window / extension options): the "Backup passphrase", "Backup", "Cloud sync" and "Browser sync" cards; the popup has no backup features.

### Encrypted format (envelope v2)

- A backup is a JSON text file with the `.totpbackup` extension: `v`, `kdf` (`alg`/`profile`/`m`/`t`/`p`/`salt`), `wrapNonce`, `wrappedDek`, `aead`, `dataNonce`, `ciphertext`
- Encryption flow: Argon2id (per the selected profile, default balanced m=65536, t=3, p=1, random 16-byte salt) derives a KEK from the passphrase → the KEK wraps a random 32-byte DEK with AES-256-GCM → the DEK encrypts the vault plaintext with AES-256-GCM
- The backup encryption profile is chosen on the "Backup" card (independent of the vault passphrase strength); a wrong passphrase or corrupted file fails decryption with an explicit error and never yields wrong data
- **Compatibility note**: v1 backup files generated before 2026-09-17 are incompatible with the current version (v2 no longer reads v1); to recover one, use an older build that produced it

### Backup passphrase (two passphrases)

- The tool distinguishes two independent passphrases: the **vault passphrase** (set on the Security page, encrypts the local vault and unlocks it) and the **backup passphrase** (encrypts local backup files and cloud-synced objects; shared by both)
- Set it on the "Backup passphrase" card: enter + confirm and click "Enable session"; unless remembered it lives only in session memory, never on disk, and is cleared on lock or page close
- The "Remember (store in key store)" toggle: when on, the backup passphrase is stored encrypted in a separate key store (DEK-encrypted `secretBag`, requires vault encryption enabled) and auto-loaded on unlock, so backups and cloud sync (including automatic runs) never ask for it; native auto unlock applies too; disabling vault encryption clears the store
- If the passphrase is lost the backup cannot be recovered (no backdoor, no recovery path) — keep it safe

### Desktop local backup (multiple directory sources)

- The "Backup" card manages local backups as a **source list**: beyond the default directory (`%APPDATA%/com.totp.desktop/backups/`) you can add any number of custom directory sources, each independently enabled, named, and retention-configured
- Per-source retention (preferences persisted):
  - **Keep latest N**: named `vault-date-time.totpbackup`; after each backup the oldest beyond N are deleted in a rolling fashion
  - **Overwrite**: always writes `vault-backup.totpbackup`
- Writes are atomic (temp file + rename); restore: pick one from the in-card backup list (newest first), decrypt with the passphrase, confirm twice, and the whole vault is replaced; conflict copies from cloud sync (`conflict-{source id}-{date}-{time}.totpbackup`) also appear in the list and are excluded from rolling deletion

### Automatic backup (desktop)

- Automatic triggers persist locally on desktop: "auto backup after changes" (debounced 10s after data commits, merging bursts) and "scheduled auto backup" (15 minutes / 1 hour / 6 hours / daily)
- Before running, the vault content SHA-256 is compared against the last baseline; unchanged content skips the write; manual backups bypass change detection and always write
- Automatic runs happen only in an unlocked session with the backup passphrase ready; results stay quiet — the status line shows "last auto backup: time + success/failure"; when the backup passphrase is unset or the vault is locked a skip reason is shown in Chinese

### Export / import files

- Desktop: native dialogs pick save/open paths (with a `.totpbackup` filter)
- Extension: browser download / file picker

### Cloud sync

Sync data across devices through your own cloud drive / object storage. Entry point: the "Cloud sync" card; cloud objects are encrypted backup envelopes.

#### Source model (multiple targets)

- Cloud sync is managed as a **source list**: "Add source" opens a five-backend menu, and **multiple sources of the same type are allowed** (e.g. two WebDAV accounts); each source is configured independently:
  - Name (to tell same-type sources apart), enable toggle
  - Credentials and target file path (each backend defaults to `totp-backup.totpbackup`)
  - **Retention**: overwrite (single fixed object) or keep latest N (keep sources write a timestamped `vault-date-time.totpbackup` per sync and roll-delete the oldest cloud backups beyond N)
  - Auto-sync preference (after changes / scheduled, independent per source)
- Credentials are **stored encrypted in the key store** (DEK-encrypted `secretBag`, loaded on vault unlock), never in plaintext; expired tokens must be re-obtained and pasted manually
- Each source keeps its own sync baseline; multi-source convergence is guaranteed by a unified orchestrator (see "Sync semantics")

#### Supported backends

| Backend | Credentials (all manually pasted, bring your own) |
| --- | --- |
| WebDAV | Server URL + username + app password (e.g. Jianguoyun) |
| S3-compatible | Region + Bucket + AccessKeyId + SecretAccessKey; optional Endpoint (e.g. MinIO `http://localhost:9000`) switches to path-style; optional key prefix |
| Google Drive | OAuth Access Token (the file id is created on first push and stored back into credentials) |
| OneDrive | Microsoft Graph Access Token (writes a same-named file in the drive root) |
| GitHub Gist | GitHub Token + Gist ID (secret gist recommended to keep backups off public pages) |

- S3 upload is a pure-fetch AWS Signature V4 implementation (no SDK), compatible with MinIO and other self-hosted services
- Self-hosted WebDAV/S3 (MinIO) must allow cross-origin (CORS), or the extension's requests are blocked by the browser

#### Encryption and passphrase

- Cloud objects use the same encrypted format as local backups (envelope v2, profile from the backup strength on the "Backup" card); servers only ever see ciphertext
- The cloud sync passphrase is the "backup passphrase", shared with local backups: enter it on the "Backup passphrase" card, or "Remember (store in key store)" so unlocking the vault suffices; all sources share one passphrase; if lost, cloud backups cannot be decrypted (no backdoor, no recovery path)

#### Sync semantics

- Sources run sequentially (not concurrently), each with its own baseline: read back the cloud object, compare with the baseline, decrypt with the passphrase; a single source's failure does not block the others (upload traffic/request count grows linearly with source count)
- Convergence: after any source adopts a newer cloud version, the final step pushes it back to the other sources whose baselines differ, preventing sources from fighting each other
- Conflict (cloud differs from the local baseline): the cloud wins (LWW, remote wins); before overwriting locally, the local data is saved as a conflict copy — desktop writes `conflict-{source id}-{date}-{time}.totpbackup` into the backup directory (excluded from rolling deletion, restorable from the backup list); the extension saves it as a download
- When the remote cannot be decrypted with the current passphrase (mismatch/corruption) it errors out immediately with no writes and the local data is untouched; on "failed: passphrase mismatch" you can "reset cloud with current passphrase" (three-step confirmation, local wins)
- Adopting cloud data requires an explicit prompt and two-step confirmation; afterwards the cloud data replaces the whole vault

#### Automatic cloud sync

- Each source offers two triggers: "auto sync after changes" (debounced 10s, merging bursts) and "scheduled auto sync" (15 minutes / 1 hour / 6 hours / daily)
- Full-featured on desktop; **on the extension, automatic sync runs only while the options page is open** (the Service Worker background holds no session passphrase/DEK and cannot encrypt, so no background alarm), stopping when the page closes
- Automatic runs happen only in an unlocked session with the backup passphrase ready; automatically adopting a cloud version skips confirmation (unlike manual sync's two-step confirmation); results stay quiet — the status line shows "last auto sync: time + success/failure/skipped + per-source details"; a Chinese skip reason is shown when the backup passphrase is unset / the vault is locked / no source is enabled

## Browser sync (extension only)

Extension only: uses your Chrome account via `chrome.storage.sync` to sync data across browsers signed into the same account (the desktop app has no such feature). The toggle sits on the "Browser sync" card, **off by default** and must be enabled explicitly; the card's status line shows the last sync time/state.

- Content: the full vault + app settings. With vault encryption enabled, what syncs is the AES-256-GCM ciphertext (same shape as Security-page encryption); without it, plaintext JSON syncs (same trust model as local — enabling encryption first is recommended)
- Sharding: the vault is split by UTF-8 bytes into shards of 5500 raw bytes each (keys `sync:v1:index/total`, each shard base64-encoded independently), ≈7.4KB encoded, under the 8KB per-key sync limit; settings sync as one plaintext blob (preferences only, no secrets)
- Conflict policy: simple LWW — each push monotonically +1s the revision, and a pull applies only when the remote revision is newer; local pushes on every change and pulls on any sync-area change; the toggle is per device and cannot be rewritten by other devices
- Quota behavior: the sync area totals ≈100KB; above 90% usage the status line warns "sync space is full — consider configuring cloud backup and turning off browser sync"
- Encrypted sync across devices: the new device receives ciphertext and needs the **same passphrase** to unlock; the passphrase never travels the sync channel — lose it and the data stays locked
- Browser support: primarily verified on Chrome/Edge; Firefox's storage.sync quota and behavior differ and are not fully verified

## Import

Imports start on the Import page. After picking a file the format is auto-sniffed and a wizard runs parse → **dedupe preview** → confirm → report; on mis-detection you can force a format in the dropdown. Field semantics align with Aegis's official importers (beemdevelopment/Aegis).

### Supported formats

**Text formats (desktop and extension)**

- **Aegis** (JSON vault): plaintext and passphrase-encrypted both supported; encrypted vaults need the export passphrase (scrypt + AES-GCM, aligned with Aegis's implementation)
- **WinAuth** (XML config): plaintext and passphrase-protected (entry-level/whole-file, PBKDF2 + Blowfish, aligned with the official algorithm) both supported; files encrypted with Windows DPAPI (user/machine scope) are **desktop-only** (they need system credentials to decrypt) — the extension reports "please import on desktop" per entry; YubiKey encryption unsupported
- **2FAS** (JSON export): plaintext supported (TOTP/HOTP/Steam); encrypted exports (servicesEncrypted) unsupported — re-export without a password
- **Bitwarden** (JSON export): plaintext supported; `login.totp` accepts otpauth URIs / `steam://` / bare base32 secrets (bare base32 is an extension beyond Aegis's `BitwardenImporter`); password-protected exports unsupported — re-export as plaintext
- **Ente Auth**: plaintext export is otpauth URI line text, same entry as "URI text"; encrypted export unsupported — re-export as plaintext in the app
- **Proton Authenticator** (JSON export): plaintext supported (entry uri is otpauth:// or steam://); encrypted export unsupported — re-export as plaintext
- **Stratum / Authenticator Pro** (JSON export): plaintext supported (uppercase-key schema, HOTP/TOTP/Steam); binary encrypted export unsupported
- **FreeOTP+** (JSON export) and **legacy FreeOTP** (shared_prefs tokens.xml): both supported; secrets restored as byte arrays, HOTP counters keep stored values (Aegis-aligned)
- **TOTP Authenticator**: plaintext JSON arrays and external share files (Base64 ciphertext) both supported; share files default to the passphrase `TotpAuthenticator` — enter a changed passphrase on the passphrase page
- **andOTP** (JSON export): plaintext supported; encrypted (binary) backups unsupported — re-export as plaintext
- **FoxAuth** (JSON backup): plaintext and passphrase-encrypted both supported; encrypted backups need the export passphrase (stored Base64 in `passwordInfo.encryptPassword`, HKDF-SHA-256 + AES-GCM, aligned with FoxAuth's implementation)
- **Authy** (shared_prefs XML): plaintext and passphrase-encrypted entries both supported; encrypted entries need the Authy backup passphrase (PBKDF2 + AES-CBC)
- **Battle.net** (shared_prefs XML): XOR-mask restore, one entry per file (8-digit TOTP)
- **Duo** (files/duokit/accounts.json): JSON array; entries with a counter import as HOTP
- **Microsoft Authenticator** (SQLite db): `accounts` table; regular entries are 6-digit, Microsoft-style 8-digit TOTP
- **Google Authenticator / otpauth URI text**: one `otpauth://totp/...|hotp/...|steam/...|yaotp/...` URI per line (most apps' URI/migration text exports land here, including Ente Auth plaintext exports)
- **Authenticator Plus**: passphrase-encrypted ZIP backups supported, needs the backup passphrase (AES-encrypted ZIP, aligned with the official layout)
- **Generic JSON / JSON array / JSONL**: configure dotted-path field mappings (e.g. `otp.params.secret`) to map row objects into entries; secret is required; a single JSON object auto-detects its nested row array. Secrets are trimmed and uppercased; invalid algorithm/digits/period fall back to defaults (SHA1/6/30); Steam entries are fixed at 5 digits. Mapping schemes can be named, saved, reused and deleted: re-importing a same-shaped file auto-recommends a scheme by column names, and schemes can be applied manually

**SQLite databases (desktop and extension, network required)**

- A source device database file (the app-private db, pulled via system backup/adb): validated by the SQLite file header, then tables are probed in sqlite_master by known names (currently Microsoft Authenticator's `accounts` table)
- Parsing uses sql.js whose wasm binary is loaded from the jsdelivr CDN, so **first use requires network**; offline it errors explicitly and SQLite imports are unavailable

**Not yet supported**

- **Legacy Google Authenticator SQLite databases** (≤5000100): requires rooting to pull the app-private database; unsupported
- **Steam Android client**: Steamguard-*.json unsupported; Steam tokens can come in via WinAuth

### Dedupe and conflict handling (four-tier decision tree)

The preview annotates each entry (mutually exclusive and exhaustive; secret takes priority over issuer+label):

- **Identical** (all key fields match): skipped automatically, no duplicate stored
- **Suspected same account** (same secret + algorithm, other fields differ): choose per entry — skip (default) / add / overwrite existing
- **Conflict** (same issuer + label, different secret, case/whitespace-insensitive): handled per the conflict policy — skip conflicted entries (default) / overwrite existing (keeping its tags and sort position) / keep both
- **New**: everything else is stored

Fully duplicated lines within a file are merged (first kept) to avoid inflated preview counts. After confirming, the report shows per-category counts and per-entry failure reasons (with line/entry numbers); single-entry parse failures do not block the import, and whole-file decryption failures (e.g. a wrong Aegis passphrase) error out explicitly without writing partial data.

## Icons

Entries can carry brand icons shown as list avatars and in the entry form; four sources, all configured in the entry/edit form's "Icon" section.

### Built-in icon set

- A curated **218 items** from Simple Icons (CC0, monochrome SVG) covering common 2FA issuers across dev/cloud/ops/identity/social/media/shopping/finance/crypto/gaming/self-hosted/password tools; generated from the simple-icons package by [scripts/gen-builtin-icons.mjs](scripts/gen-builtin-icons.mjs) into [packages/core/src/icons/builtin.json](packages/core/src/icons/builtin.json) (plus 58 issuer aliases)
- Trademark removals: upstream Simple Icons periodically removes brand icons at trademark holders' request; the built-in set can only include what the current package still ships. For removed or missing brands, use icon pack imports / uploads / URL references
- Issuer keyword suggestions: typing an issuer name in the form auto-matches (normalized ignoring case/whitespace/`.`/`-`/`_`, with Chinese aliases like "微信" (WeChat), "B站" (Bilibili), "战网" (Battle.net)); on a hit, a suggestion bubble appears (unless you picked an icon manually) — click to apply

### Icon pack import

- Supports the aegis-icons community pack and same-shaped zips: `.png` files at any directory depth are imported, **the filename (without extension) is the service name**, matched against the entry issuer after normalization
- Limits: files over 50KB are skipped; at most 500 icons per import; same-named (normalized) icons — later overwrites earlier
- Entry point: "Import icon pack (zip)" in the entry/edit form's "Icon" section; after import you must pick the icon manually in the entry editor (packs only fill the library, they do not bind entries)

### User upload

- Any image is scaled proportionally to a longest edge ≤128px (never upscaled) and stored as PNG

### URL reference

- Entering an image URL fetches it immediately and caches a local copy (cache key `urlcache:<id>`)
- Fetches are capped at 200KB — larger fails; failures (network down, non-2xx, CORS blocked) error explicitly and can be retried after fixing the URL; when the cache is lost (storage cleared, new device) the list falls back to an initial-letter placeholder and can be re-fetched in the edit form

### Storage location

- Icons are stored as dataUrls under the `'icons'` key (id→dataUrl map), independent of the vault
- Extension: `chrome.storage.local` with the `unlimitedStorage` permission declared, beyond the default 10MB quota; popup and options share one copy
- Desktop: next to the vault in `%APPDATA%/com.totp.desktop/`

## Development and build

```bash
pnpm install
pnpm test          # all frontend unit tests (core / ui / extension / desktop, four vitest packages; per-package counts shown in the output)
cargo test         # Rust-side unit tests (apps/desktop/src-tauri, CI gate; cargo clippy -- -D warnings likewise)
# Note: the extension's typecheck depends on the WXT-generated .wxt/ directory (git-ignored);
# run pnpm --filter @totp/extension exec wxt prepare first to generate the types, then pnpm typecheck.
pnpm --filter @totp/extension build                        # Chrome target artifacts .output/chrome-mv3
pnpm --filter @totp/extension exec wxt build -b firefox    # Firefox target artifacts .output/firefox-mv3
pnpm typecheck     # typecheck: core is plain tsc; ui/extension/desktop use vue-tsc (including .vue single-file components)
```

- Both extension targets are **Manifest V3**: Firefox `strict_min_version: 140.0`, gecko id `totp@bhxch.github.io` (immutable after first AMO publish); manifest config in [apps/extension/wxt.config.ts](apps/extension/wxt.config.ts); CI asserts both artifacts in the "Assert MV3 artifacts" step ([.github/workflows/build.yml](.github/workflows/build.yml))
- End-to-end verification infra (test-only, no runtime impact): [scripts/inject-test-shim.mjs](scripts/inject-test-shim.mjs) injects a chrome shim plus fetch/clipboard mocks into build artifacts, driven by `?seedVault=` / `?seedKeys=` / `?tabUrl=`; verification reports across rounds live in [docs/review/](docs/review/)

## Architecture and docs index

- [packages/core](packages/core/) — pure TS core: OTP engine (HOTP/TOTP/Steam/URI), match strategies, crypto and envelope, backup source model, cloud sync orchestration (multi-target/scheduler/rolling delete), importers (17+ formats and the dedupe tree), storage abstraction
- [packages/ui](packages/ui/) — Vue 3 shared layer: MD3 component library ([packages/ui/src/components/md/](packages/ui/src/components/md/)), theme system ([packages/ui/src/theme/](packages/ui/src/theme/): 10 seed colors × light/dark 35-role tokens + an AMOLED contrast overlay, lazy-loaded on demand), five-page navigation and pages, stores (DEK key store/passphrase rotation/unlock state machine), shared runners for both hosts (cloud sync/backup)
- [apps/extension](apps/extension/) — WXT browser extension (Chrome/Edge/Firefox, all MV3): popup, options (isomorphic five pages), background, DEK session persistence, cloud credential migration
- [apps/desktop](apps/desktop/) — Tauri 2 desktop app (reuses [packages/ui](packages/ui/)): main window five pages, mini popup, auto backup/cloud sync runners, window resource release, built-in MCP server, Rust side (backup directory commands / DPAPI / osAutoUnlock / Windows lock events / release policy / MCP server)

Docs index:

- Overall design and frontend redesign: [docs/plans/2026-09-13-totp-tool-design.md](docs/plans/2026-09-13-totp-tool-design.md), [docs/plans/2026-09-15-frontend-redesign-design.md](docs/plans/2026-09-15-frontend-redesign-design.md)
- Backup sources and crypto design: [docs/plans/2026-09-17-backup-sources-and-crypto-design.md](docs/plans/2026-09-17-backup-sources-and-crypto-design.md)
- MCP server design: [docs/plans/2026-09-21-mcp-server-design.md](docs/plans/2026-09-21-mcp-server-design.md)
- Implementation plans (per milestone): [docs/plans/](docs/plans/)
- Review and end-to-end verification reports (incl. the MCP real-machine test): [docs/review/](docs/review/)

## Known limitations

See the [plan13-16 full code review](docs/review/2026-09-18-plan13-16-full-code-review.md) and the [batch-8 six-spec review and verification](docs/review/2026-09-22-six-specs-review-and-verification.md).

- **Manual cloud sync has no content gate**: a manual run always pushes and pulls in full (the cloud object is rewritten even when nothing changed); automatic runs go through a persistent content gate and degrade to pull-only — nothing is uploaded when the content is unchanged, and two devices both sitting idle no longer kick each other into conflict copies
- **Google Drive's "keep latest N" currently behaves as "overwrite"** (timestamped names do not apply to gdrive; only one remote object ever exists)
- **Desktop auto backup advances the baseline on partial failure**: if any directory write fails the baseline still advances and the status line records "success"; no automatic retry follows — write a manual backup to catch up
- **The desktop "keep locked after restart" toggle currently has no effect** (the desktop has no session-level DEK storage and is always locked after restart); the "lock on system lock" trigger is unavailable on mac/Linux (backlog)
- **Firefox (MV3)**: clipboard auto-clear unavailable (no offscreen API, clearing degrades to foreground-only, unscheduled); idle/lock auto-lock is supported per MDN compatibility (including the `locked` state, min_version 140) — if anything misbehaves on real hardware, rely on the runtime degradation notice; Passkey (PRF) unlock is limited — the entry hides itself when probing fails
- **No pagination for cloud listings**: when objects under a single directory/prefix exceed the cloud API's page cap (e.g. 1000 for S3), rolling deletion may miss the oldest backups

## License

[MIT](LICENSE)
