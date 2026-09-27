# device-list-malformed
reconstructed: synthesized, deliberately violating FR-16.4's grammar
(missing quotes, missing `@`/`:` separators, a stray non-matching line, a
non-numeric index) so the tolerant device-list parser exercises its
`extra[]` bucket and fail-soft `ok:false` path.
