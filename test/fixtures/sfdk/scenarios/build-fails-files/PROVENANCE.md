# build-fails-files
real: the `RPM build errors` lines come from a failed rpmbuild reported by the
project owner (install root `/home/deploy/installroot`, missing
`libsfoscamera2.so` listed in `%files`). Exit code 1 is assumed (reconstructed).
Used to check the `File not found` / `Directory not found` mapping in
`mapBuildError`.
