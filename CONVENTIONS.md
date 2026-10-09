# Conventions

One file for later agents to read instead of the full TRD/validation docs.
Binding rules are in the workflow task text; this file summarizes them for
day-to-day work in this repo.

## Repository layout and file ownership

Root: this directory (`extension/`). Docs live in `../docs`.

```
package.json, package-lock.json, tsconfig.json, tsconfig.test.json,
esbuild.mjs, eslint.config.mjs, .vscodeignore, .gitignore, README.md,
CHANGELOG.md, LICENSE, CONVENTIONS.md                                    [Scaffold]
scripts/check-manifest.mjs, check-proprietary.mjs, package-dry.mjs       [Scaffold]
resources/sardina.svg                                                  [Scaffold]
snippets/silica.code-snippets                                           [Task F]
media/walkthrough/*.md                                                  [Task F]
src/extension.ts                                                        [Scaffold — additive edits only]
src/core/types.ts                                                       [Scaffold — add types, never change existing fields]
src/core/services.ts                                                    [Scaffold]
src/core/output.ts                                                      [Task A]
src/core/contextKeys.ts                                                 [Task B]
src/settings/index.ts                                                   [Task B]
src/sfdk/discovery.ts, runner.ts, version.ts, parsers/**                [Task A]
src/project/detect.ts, specParser.ts, active.ts                         [Task B]
src/wizard/newProject.ts                                                [Task C]
src/targets/selectTarget.ts, statusBar.ts                               [Task C]
src/tasks/provider.ts, pseudoterminal.ts, pathMap.ts, launcher.ts,
       commands.ts, argv.ts                                             [Task D]
src/devices/tree.ts, commands.ts, vmCorrelation.ts                      [Task E]
src/qtqml/keys.ts (scaffold), silence.ts                                [Task F]
src/walkthrough/index.ts                                                [Task F]
src/ui/prompts.ts                                                       [Scaffold — test seam, don't bypass]
test/**                                                                 [Harness agent + each task's own area]
```

Rules:
- Only touch files in your task letter's paths, plus your own tests/fixtures.
- Shared files (`package.json`, `src/extension.ts`, `src/core/types.ts`,
  `src/core/services.ts`, this file) get minimal **additive** edits via the
  Edit tool only — never a whole-file rewrite.
- Every module exports `activate<Name>(ctx: vscode.ExtensionContext, services: Services): void`
  — synchronous; start async work without awaiting (NFR-1).
- Stub public APIs (`SfdkRunner`, `SdkLocator`, `ProjectRegistry`, `Settings`)
  may be extended but existing method names/signatures must stay
  source-compatible.
- All prompts go through `src/ui/prompts.ts`. All spawning of `sfdk` goes
  through `SfdkRunner` (Task A). The one exception is Task E's VBoxManage
  probe, which uses `spawnCapture(bin, args[])`, exported from
  `src/sfdk/runner.ts`.
- The other spawn exception is the screen-mirror forward in `src/agent/sshForward.ts`: it runs
  `ssh -N` (and, on macOS, `ps -p`) directly with `child_process` and an argv array
  (`shell: false`), because it needs the long-lived child handle. Its argv comes only from the
  pure `buildForwardArgs`; it never runs `sfdk` (that stays on `SfdkRunner`).
- No shell string interpolation, ever: `child_process.spawn(cmd, argsArray, { shell: false })`
  only.
- TypeScript strict; no `any` without a `// eslint-disable-next-line
  @typescript-eslint/no-explicit-any -- <reason>` comment; ESLint clean.
- Do not commit. The Final Gate handles git.

## Naming reconciliation

- SDK location setting: `sardina.sdkPath` (not `sardina.sfdkPath`).
- Output channel name: **Sardina** (not "Sailfish Tools").
- Demo/fixture project name: `harbour-demo` (not `harbour-example`).
- Fake sfdk layout: `test/fixtures/bin/{sfdk,sfdk.cmd,sfdk.js,_fake-core.js}`,
  `test/fixtures/sfdk/scenarios/<scenario>/<key>.stdout|.stderr|.exit|...`
  (validation-instructions §1.2/Appendix A), **not** TRD FR-17.1's
  `test/fake-sfdk/...json` layout. `happy` is an alias of `default`.

## Stub API (as implemented in the scaffold)

- `src/sfdk/runner.ts`:
  `SfdkRunOptions { args, cwd?, target?, device?, token?, timeoutMs?, onLine?, ensureEngine? }`,
  `SfdkResult { stdout, stderr, exitCode, signal?, argv, durationMs, timedOut, cancelled }`,
  `class SfdkRunner { constructor(services: Services); run(opts): Promise<SfdkResult> }`,
  `function spawnCapture(bin, args[], opts?): Promise<SfdkResult>` (implemented; the
  generic argv-array runner Task A and Task E both use).
- `src/sfdk/discovery.ts`:
  `class SdkLocator { current(): SdkInfo | undefined; refresh(): Promise<SdkInfo | undefined>; readonly onDidChange }`,
  `SdkInfo = { root, sfdkPath, version, source }`.
- `src/project/detect.ts`:
  `class ProjectRegistry { projects(); forFolder(folder); resolveActive(); refresh(); readonly onDidChange }`.
- `src/core/contextKeys.ts`:
  `class ContextKeys { set(key, value): Promise<void>; get(key); snapshot() }` — implemented.
- `src/settings/index.ts`:
  `class Settings { get<K>(key, scope?); onDidChange(key, listener) }` with
  `SardinaSettings` listing every §4.6 v0.1 key (dotted keys like
  `'build.jobs'` are TypeScript string-literal keys, not nested objects) —
  implemented.
- `src/core/output.ts`:
  `class Output { log(level, msg); logInvocation(argv, exitCode, durationMs); show(); readonly channel }` —
  implemented; channel name is **Sailfish OS**.

Everything else not yet implemented throws `new Error('not implemented: Task X')`
from its non-activation methods; each module's `activateX` registers its
command ids with a handler that calls
`services.prompts.showInformationMessage('Sardina: <command> is not implemented yet (Task X)')`
so `npm run check:manifest` passes before the task lands.

## How to run each script

```sh
npm install
npm run check:types      # tsc --noEmit against tsconfig.json and tsconfig.test.json
npm run lint             # eslint src test --max-warnings=0
npm run build            # esbuild src/extension.ts -> dist/extension.js
npm run build:watch      # same, with --watch
npm run test:unit        # tsc -p tsconfig.test.json, then mocha out/test/unit/**
npm run test:fuzz        # mocha out/test/fuzz/**, iterates src/sfdk/parsers/index.ts#allParsers
npm run test:integration # node out/test/runTest.js (VS Code integration host)
npm run test             # unit && fuzz && integration
npm run check:manifest   # scripts/check-manifest.mjs
npm run check:proprietary# scripts/check-proprietary.mjs
npm run package:dry      # scripts/package-dry.mjs (vsce package to a temp dir)
npm run verify           # the full gate
```

## How tests stub prompts

All UI prompts in `src/` go through `src/ui/prompts.ts`'s exported `prompts`
object (`showQuickPick`, `showInputBox`, `showOpenDialog`,
`showInformationMessage`, `showWarningMessage`, `showErrorMessage`). Tests
`sinon.stub(prompts, 'showQuickPick')` etc. — never stub `vscode.window.*`
directly, since production code never calls it directly either.
`test/integration/helpers.ts` (harness agent) wraps this into
`stubQuickPick`, `stubInputBox`, `stubOpenDialog`, `stubMessages`, all
auto-restored in a root `teardown`.

## Fake sfdk key table (validation §1.2, summarized)

| argv shape | key |
|---|---|
| `--version` (anywhere) | `version` |
| `init -l` / `init --list-types` | `init_list` |
| `init` (otherwise) | `init_template` |
| `config --show` | `config_show` |
| `config --global ...` | `config_set_global` |
| `config ...` | `config_set` |
| `tools target list` | `tools_target_list` |
| `tools list` | `tools_list` |
| `device exec [name] -- <cmd...>` | `device_exec.<basename of cmd[0]>` (fallback `device_exec`) |
| `device exec [name] -- <cmd> --request <req>` | `device_exec.<basename>.<req>` (fallback `device_exec.<basename>`, then `device_exec`; every dotted prefix, longest first) |
| `engine exec -- <cmd>` | `engine_exec.<cmd>` (fallback `engine_exec`) |
| `emulator show <name>` | `emulator_show` |
| `device exec [name] -- sailfish-devagent --request stats --exe <path> --interval <ms>` | `device_exec.sailfish-devagent.stats` (status line then one JSON line per tick; `.stream` + `.hang` make it live; Device Monitor scenarios `monitor-*`) |
| `device exec [name] -- sh -c <script> sh <args…>` | `device_exec.sh` (scenario-local only: never put it in `default/`, the agent install test also runs `sh -c`; `agent-uninstall*` hold the uninstall cleanup report) |
| `device exec [name] -- cat /etc/os-release` | `device_exec.cat` |
| `device exec [name] -- printenv SSH_CONNECTION` | `device_exec.printenv` |
| `device exec [name] -- ip -o -4 addr` | `device_exec.ip` |
| other `tools|emulator|device|engine <sub>` | `<a>_<b>` |
| `build|deploy|qmake|make|package|check|build-shell` | that word |
| anything else | `unknown` |

The fake `ssh` (`test/fixtures/bin/ssh`, same scenario lookup) answers only `ssh -N -L <local>:<remote> …` (key `ssh_forward`; modes in `ssh_forward.mode`, frames in `ssh_forward.frames.json`); any other argv exits 255 and is appended to `unrecorded.log`. Recorded output may contain `@FIXTURES_ROOT@`, which the fakes replace with the `FIXTURES_ROOT` environment value. In `ssh_forward.frames.json` an entry `{"settings": {...}}` is a header-only record (agent 1.9.0 phone settings message) that the fake sends only to a request containing `"phoneState":true`, and a `status` with `"ok": false` is sent and the connection closed (used by `agent-settings-*`). A `<key>.stdin-log` file makes the fake sfdk log each stdin line as `{event:'stdin', key, line}` while it is alive.

A `<key>.hang` file (empty) makes the fake stay alive after printing until SIGTERM/SIGINT and log a `killed` event; with `<key>.stream` (per-line delay in ms) it is a live stream, as for `device_exec.sailfish-devagent.mirror`.

Unknown/un-fixtured key → stderr `sfdk: unrecognized command (fake key "<key>", scenario "<scenario>")`,
exit 2, and the argv line is appended to `test/fixtures/sfdk/unrecorded.log`.
Scenario aliases: `happy` → `default`, `build-error` → `build-fails-compile`,
`old-format` → `tools-list-odd-glyphs`. `localized` uses `<key>.stdout.de`
files when `LC_ALL` is not `C` (or `SFDK_FAKE_FORCE_LOCALIZED=1`).

See `../docs/validation-instructions.md` §1.2/§1.5/Appendix A for the full
contract and scenario list; the harness agent owns `test/fixtures/**` and
`test/runTest.ts`.

## Integration launch: three flags are required, HOME is never overridden

`test/runTest.ts` launches every test-electron host with a fresh
`--user-data-dir`. Without `--password-store=basic`, Electron falls back to
the OS keychain (macOS Keychain / GNOME Keyring) on that first launch, which
can raise an interactive OS-level prompt and block or repeatedly interrupt
the run. On Linux this flag is sufficient (VS Code reads it to call
`safeStorage.setUsePlainTextEncryption`). On macOS it is NOT sufficient:
`--password-store` is never read there, so `--use-mock-keychain` (a Chromium
switch bundled in Electron's Framework) and `--use-inmemory-secretstorage`
(a VS Code switch) are also required. All three flags are REQUIRED on every
launch — never remove any of them — and any future `.vscode-test.mjs`/test-CLI
config must carry all three too.

`extensionTestsEnv` does NOT set `HOME`/`USERPROFILE` to the temp home.
`@vscode/test-electron` passes `extensionTestsEnv` to the whole Electron
process, not only the extension host, so overriding `HOME` leaves macOS
Security unable to find a default keychain under the fake home directory,
which raises the "Keychain Not Found" dialog for "Code Safe Storage" — the
same failure the three launch flags above are meant to avoid. Tests that
need the temp home read it from `TMP_HOME` (see `test/integration/helpers.ts`),
not from `process.env.HOME`.

## extensionDependencies is `["theqtcompany.qt-qml"]` (per TRD §2.2)

A hard `extensionDependencies` entry makes VS Code refuse to activate this
extension at all when `theqtcompany.qt-qml` isn't present — confirmed to
apply even to the extension under `--extensionDevelopmentPath` and even
under `--disable-extensions`, so no launch mode can skip installing it.
`test/runTest.ts` installs `test/fixtures/stub-qtqml/` — a minimal
declarative extension registering as `theqtcompany.qt-qml` and contributing
the `qml`/`qmldir` language ids, nothing else — into an isolated
`--extensions-dir` on every launch, bare or full.

Bare mode's `--extensions-dir` holds only that stub, never `--disable-extensions`
(which would leave the hard dependency unresolved and the extension
permanently inactive). This keeps bare mode's actual guarantee intact: no
*optional* extension (cpptools, VBoxManage, a real qt-qml) is needed for
activation, only the one dependency TRD §2.2 makes mandatory.
