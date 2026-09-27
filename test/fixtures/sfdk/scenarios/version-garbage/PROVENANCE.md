# version-garbage
reconstructed: synthesized, to exercise the version parser's fail-soft path
(FR-16.1: never throws; returns ok:false) when `sdk-release`/`--version`
output is unparseable.
