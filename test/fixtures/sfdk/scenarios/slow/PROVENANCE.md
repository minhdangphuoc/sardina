# slow
reconstructed: synthesized. `_all.delay-ms` is a fake-binary extension (not
part of the literal per-key contract) applied as a fallback when a
key-specific `.delay-ms` file is absent, so every key in this scenario
sleeps 4000ms before responding — used to exercise timeouts/cancellation
(FR-1.3/1.5). All stdout content falls back to `default/`.
