#!/bin/sh
# Build sailfish-devagent RPMs for every supported arch and copy them to media/agent/<arch>/.
# In-source builds leave objects behind; building another arch on top of them yields a broken
# package, so the tree is cleaned before each arch and once more at the end.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
sfdk="${SFDK:-$HOME/SailfishOS/bin/sfdk}"
release=SailfishOS-5.1.0.11
archs="aarch64 armv7hl i486"

clean() {
    rm -rf "$here/RPMS" "$here/Makefile" "$here/sailfish-devagent" \
        "$here/documentation.list"
    rm -f "$here"/*.o "$here"/moc_*
}

# .sfdk is only removed at the very end: sfdk fails with "Unable to open .sfdk/spec" when it
# vanishes between two builds of the same session.
final_clean() { clean; rm -rf "$here/.sfdk"; }
trap final_clean EXIT
cd "$here"

for arch in $archs; do
    echo "== $arch =="
    clean
    # sfdk ignores SIGTERM, hence SIGKILL; no-fix-version stops it stamping the git tag.
    timeout -s KILL 900 "$sfdk" -c "target=$release-$arch" -c no-fix-version build </dev/null
    set -- "$here"/RPMS/sailfish-devagent-*."$arch".rpm
    [ -f "$1" ] || { echo "no RPM produced for $arch" >&2; exit 1; }
    dest="$root/media/agent/$arch"
    mkdir -p "$dest"
    rm -f "$dest"/*.rpm
    cp "$1" "$dest/"
    echo "-> $dest/$(basename "$1")"
done
