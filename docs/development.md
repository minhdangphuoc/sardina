# Development


Node.js 22 or newer is required.

```sh
npm ci
npm run build          # bundle dist/extension.js with esbuild
npm run check:types
npm run lint
npm run test:unit
npm run test:fuzz
npm run test           # unit, fuzz and integration tests (opens a VS Code test window)
npm run verify         # everything above, plus manifest checks and a packaging dry run
```

To try changes without packaging, run `npm run build` (or `npm run build:watch`)
and then `code --extensionDevelopmentPath=$PWD <your-project>`. There is no
`.vscode/launch.json`, so **F5** does not work out of the box.

The device agent is a separate Qt program in `device-agent/`.
`sh device-agent/build.sh` builds its RPMs for all three architectures with the
SDK and copies them to `media/agent/`; see
[`device-agent/README.md`](../device-agent/README.md) for its build needs and
protocol.

See [`CONVENTIONS.md`](../CONVENTIONS.md) for the module layout, stub APIs, and how tests stub UI
prompts and use the fake `sfdk` binary.

