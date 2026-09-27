# no-engine
reconstructed: FR-16.6 [U] "stopped" text. `engine_start` and `build` are
intentionally NOT overridden here and fall back to `default/` (engine
starts successfully, then the build succeeds), to exercise the
ensureEngine-then-proceed path (FR-1.5).
