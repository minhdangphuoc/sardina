# build-fails-compile (alias: build-error)
reconstructed: synthesized gcc compile-error transcript using engine-side
absolute paths (`/home/mersdk/share/<workspace-basename>/...`), matching the
`sailfish-gcc` problem matcher regex in package.json and pointing at
`src/main.cpp:12:5` in the `qml-app` fixture workspace (which has >=15
lines so that line exists). `build.stream` is present (empty = default
20ms/line) to exercise streamed sink consumption (FR-1.5 onLine).
