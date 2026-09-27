# localized
reconstructed: synthesized German-language sfdk output. `_fake-core.js`
serves these `.stdout.de` files instead of `default/`'s English `.stdout`
when `LC_ALL` is not `C` (or `SFDK_FAKE_FORCE_LOCALIZED=1`), which is what
proves FR-1.3's requirement that SfdkRunner always sets `LC_ALL=C`. Contains
`Ziel` (target), `läuft` (running), `Gerät` (device) as required by the
harness contract. All other keys fall back to `default/`'s English output
unmodified.
