#!/bin/sh
# Build sailfish-devagent RPMs for every supported arch and copy them to media/agent/<arch>/.
#
#   build.sh [--sdk | --docker] [--arch a,b] [--out DIR] [--no-install] [--image REF]
#            [--privileged]
#
# --sdk (the default) builds in place with the Sailfish SDK's sfdk (the owner's build engine).
# --docker builds out of tree inside the Sailfish platform SDK container (see docker/IMAGE).
# In-source builds leave objects behind; building another arch on top of them yields a broken
# package, so the sfdk path cleans the tree before each arch and once more at the end.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
release=SailfishOS-5.1.0.11
all_archs="aarch64 armv7hl i486"

usage() {
    cat <<'USAGE'
Usage: device-agent/build.sh [options]

Builds the sailfish-devagent RPMs and copies them to media/agent/<arch>/.

  --sdk             build in place with sfdk (the Sailfish SDK build engine); default
  --docker          build out of tree in the Sailfish platform SDK container (docker or podman);
                    needs no SDK and never touches the working tree
  --arch LIST       comma separated subset of: aarch64,armv7hl,i486 (default: all three)
  --out DIR         --docker only: build directory (default:
                    ${XDG_CACHE_HOME:-~/.cache}/sailfish-devagent/build)
  --no-install      --docker only: leave the RPMs in DIR/<arch>/out, do not copy to media/agent
  --image REF       --docker only: use this image instead of docker/IMAGE
  --privileged      --docker only: run the container with --privileged (not needed; on hosts
                    whose AppArmor confines unix_chkpwd it breaks sudo inside the container)
  --no-privileged   --docker only: no extra container privileges (the default)
  -h, --help        show this text

Environment: SFDK (sfdk path, --sdk), DOCKER (container client; default docker, then podman),
SAILFISH_DOCKER_RUN_ARGS (extra `docker run` arguments, split on spaces, --docker).
USAGE
}

die() { echo "build.sh: $*" >&2; exit 1; }

# One build gives the core and one package per module, all with the same version.
packages="sailfish-devagent sailfish-devagent-logs sailfish-devagent-stats sailfish-devagent-screenshot"

# collect_rpms DIR ARCH DEST: checks that DIR holds exactly the expected RPMs of ARCH (release 1,
# debuginfo ignored) and, unless DEST is empty, replaces the RPMs in DEST with them.
collect_rpms() {
    src=$1; rpm_arch=$2; dest=$3
    set -- "$src"/sailfish-devagent-[0-9]*-1."$rpm_arch".rpm
    [ -f "$1" ] || { echo "no core RPM with release 1 for $rpm_arch in $src" >&2; return 1; }
    [ $# = 1 ] || { echo "more than one core RPM for $rpm_arch in $src" >&2; return 1; }
    ver=$(basename "$1" | sed "s/^sailfish-devagent-\(.*\)-1\.$rpm_arch\.rpm$/\1/")
    found=$(cd "$src" && ls ./*.rpm | sed 's#^\./##' | grep -v -- '-debug\(info\|source\)-' | sort)
    expected=$(for p in $packages; do echo "$p-$ver-1.$rpm_arch.rpm"; done | sort)
    if [ "$found" != "$expected" ]; then
        echo "RPMs for $rpm_arch differ from the expected set:" >&2
        printf 'found:\n%s\nexpected:\n%s\n' "$found" "$expected" >&2
        return 1
    fi
    if [ -n "$dest" ]; then
        mkdir -p "$dest"
        rm -f "$dest"/*.rpm
        for f in $expected; do
            cp "$src/$f" "$dest/"
            echo "-> $dest/$f"
        done
    else
        for f in $expected; do echo "-> $src/$f"; done
    fi
}

mode=sdk
archs=$all_archs
out=
install=1
image_override=
privileged=0

while [ $# -gt 0 ]; do
    case $1 in
        --sdk) mode=sdk ;;
        --docker) mode=docker ;;
        --arch)
            [ $# -ge 2 ] || die "--arch needs a value"
            archs=$(printf '%s' "$2" | tr ',' ' '); shift ;;
        --out)
            [ $# -ge 2 ] || die "--out needs a value"
            out=$2; shift ;;
        --image)
            [ $# -ge 2 ] || die "--image needs a value"
            image_override=$2; shift ;;
        --no-install) install=0 ;;
        --privileged) privileged=1 ;;
        --no-privileged) privileged=0 ;;
        -h|--help) usage; exit 0 ;;
        *) usage >&2; die "unknown option: $1" ;;
    esac
    shift
done

[ -n "$archs" ] || die "--arch is empty"
for a in $archs; do
    case " $all_archs " in
        *" $a "*) ;;
        *) die "unknown architecture: $a (expected: $all_archs)" ;;
    esac
done
if [ "$mode" = sdk ]; then
    [ -z "$out" ] || die "--out only works with --docker"
    [ "$install" = 1 ] || die "--no-install only works with --docker"
    [ -z "$image_override" ] || die "--image only works with --docker"
    [ "$privileged" = 0 ] || die "--privileged only works with --docker"
fi

# ---------------------------------------------------------------------------------------------
# --sdk: in-place build with sfdk (unchanged behaviour)
# ---------------------------------------------------------------------------------------------
build_sdk() {
    sfdk="${SFDK:-$HOME/SailfishOS/bin/sfdk}"

    clean() {
        rm -rf "$here/RPMS" "$here/documentation.list"
        # Build leftovers of every subproject (objects, moc, generated protocol code, binaries).
        find "$here" \( -name '*.o' -o -name 'moc_*' -o -name '*-protocol.c' -o -name '*-client-protocol.h' \
            -o -name Makefile -o -name .qmake.stash -o -name 'sailfish-devagent' -o -name 'sailfish-devagent-*' \) \
            -type f ! -path "$here/docker/*" ! -path "$here/tools/*" -exec rm -f {} +
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
        collect_rpms "$here/RPMS" "$arch" "$root/media/agent/$arch" || exit 1
    done
}

# ---------------------------------------------------------------------------------------------
# --docker: out-of-tree build in the platform SDK container
# ---------------------------------------------------------------------------------------------
find_runtime() {
    if [ -n "${DOCKER:-}" ]; then
        command -v "$DOCKER" >/dev/null 2>&1 || die "DOCKER=$DOCKER is not on PATH."
        printf '%s\n' "$DOCKER"; return
    fi
    for c in docker podman; do
        if command -v "$c" >/dev/null 2>&1; then printf '%s\n' "$c"; return; fi
    done
    die "--docker needs Docker, and neither docker nor podman is on PATH. Install Docker
(Debian/Ubuntu: sudo apt install docker.io; then sudo usermod -aG docker \$USER and log in again),
or build with --sdk if you have the Sailfish SDK."
}

read_image() {
    if [ -n "$image_override" ]; then printf '%s\n' "$image_override"; return; fi
    [ -f "$here/docker/IMAGE" ] || die "missing $here/docker/IMAGE"
    img=$(grep -v '^[[:space:]]*#' "$here/docker/IMAGE" | grep -v '^[[:space:]]*$' | head -n 1 \
        | tr -d '[:space:]')
    [ -n "$img" ] || die "docker/IMAGE contains no image reference"
    printf '%s\n' "$img"
}

# Prints the rpmlint lines of one report in the normalised form used by the baseline: only
# E:/W: lines, without the "<package>.<arch>: " prefix, sorted and unique.
normalise_rpmlint() {
    grep -E '^[^ ]+: [EW]: ' "$1" | sed 's/^[^ ]*: //' | sort -u
}

# Compares one rpmlint report with docker/rpmlint-baseline.txt; fails on new errors.
check_rpmlint() {
    report=$1
    if [ ! -s "$report" ]; then
        echo "rpmlint: no report (not available in the image); skipped" >&2
        return 0
    fi
    # POSIX sh has no local variables: do not reuse build_docker's names (base, work, ...).
    baseline="$here/docker/rpmlint-baseline.txt"
    [ -f "$baseline" ] || die "missing $baseline"
    # Comment lines in the baseline never equal a finding, so they are harmless as patterns.
    new=$(normalise_rpmlint "$report" | grep -vxF -f "$baseline" || true)
    [ -n "$new" ] || { echo "rpmlint: only known findings"; return 0; }
    echo "rpmlint: findings not in docker/rpmlint-baseline.txt:" >&2
    printf '%s\n' "$new" | sed 's/^/  /' >&2
    if printf '%s\n' "$new" | grep -q '^E: '; then
        echo "rpmlint: new errors; fix them or, if advisory, add them to the baseline" >&2
        return 1
    fi
    return 0
}

build_docker() {
    rt=$(find_runtime)
    "$rt" info >/dev/null 2>&1 </dev/null || die "$rt is installed but not usable: the daemon is not
running or this user may not talk to it. Start it (sudo systemctl start docker) and make sure you
are in the docker group (sudo usermod -aG docker \$USER, then log in again)."
    image=$(read_image)
    if ! "$rt" image inspect "$image" >/dev/null 2>&1 </dev/null; then
        echo "Pulling $image (about 4.7 GB compressed, 10-12 GB on disk; only the first time)..."
        "$rt" pull "$image" </dev/null || die "could not pull $image"
    fi

    base=${out:-${XDG_CACHE_HOME:-$HOME/.cache}/sailfish-devagent/build}
    mkdir -p "$base"
    base=$(cd "$base" && pwd)
    case $base in "$root"|"$root"/*) die "--out must not be inside the repository: $base" ;; esac

    # The image needs no extra privileges: sb2 and the passwordless sudo it uses work in a default
    # container. --privileged also lifts the container's AppArmor profile, and then a host profile
    # for unix_chkpwd (Ubuntu's apparmor.d) confines the image's own unix_chkpwd, PAM's account
    # check fails and every sudo inside the container asks for a password.
    sec=
    [ "$privileged" = 0 ] || sec="--privileged"

    failed=0
    for arch in $archs; do
        echo "== $arch (docker) =="
        work="$base/$arch"
        rm -rf "${work:?}"
        mkdir -p "$work/src" "$work/out"

        # Sources only, no build leftovers; the container's copy never touches the worktree.
        tar -C "$here" -cf - \
            --exclude=./RPMS --exclude=./.sfdk --exclude=Makefile --exclude=.qmake.stash \
            --exclude=sailfish-devagent --exclude='sailfish-devagent-*' \
            --exclude=./documentation.list --exclude=./docker \
            --exclude='*.o' --exclude='moc_*' --exclude='*-protocol.c' \
            --exclude='*-client-protocol.h' . | tar -C "$work/src" -xf -

        # The container script lives next to the sources so no shell quoting crosses docker run.
        # The image runs as mersdk (uid 100000, HOME=/home/mersdk). The build directory must be
        # under HOME, not /tmp: sb2 maps /tmp to the target's own /tmp, so mb2 would not find the
        # .mb2/spec it writes there. mb2 runs rpmlint itself after the build (errors are reported
        # as warnings); its findings are taken from the build log.
        cat > "$work/run.sh" <<'RUN'
set -eu
build=$HOME/build
mkdir -p "$build"
cp -r /work/src/. "$build/"
cd "$build"
# -X: do not stamp a git tag into the version (the copy has no repository anyway).
mb2 -X -t "SailfishOS-$RELEASE-$ARCH" build 2>&1 | tee /work/out/build.log
[ "${PIPESTATUS[0]}" = 0 ] || exit 1
cp RPMS/*.rpm /work/out/
grep -E '^[^ ]+: [EW]: ' /work/out/build.log > /work/out/rpmlint.txt || true
find /work/out -mindepth 1 -exec chmod a+rwX {} +
RUN
        # The container's uid differs from the host user's: a world writable out directory lets it
        # write there; the results are re-created as the host user after the run.
        chmod a+rwx "$work/out"

        # shellcheck disable=SC2086 # sec and SAILFISH_DOCKER_RUN_ARGS are meant to word-split
        if ! timeout -s KILL 1800 "$rt" run --rm $sec ${SAILFISH_DOCKER_RUN_ARGS:-} \
            -v "$work/src:/work/src:ro" -v "$work/out:/work/out" -v "$work/run.sh:/work/run.sh:ro" \
            -e ARCH="$arch" -e RELEASE=5.1.0.11 \
            "$image" bash -lc 'bash /work/run.sh' </dev/null; then
            echo "build failed for $arch (log: $work/out/build.log)" >&2; failed=1; continue
        fi
        # Copy each result over itself so the host user owns it, not the container's uid.
        for f in "$work"/out/*; do
            [ -f "$f" ] || continue
            cp "$f" "$f.tmp" && mv -f "$f.tmp" "$f"
        done
        chmod 755 "$work/out"

        # Release must be 1 (matches the sfdk build with no-fix-version).
        check_rpmlint "$work/out/rpmlint.txt" || failed=1
        dest=
        [ "$install" = 0 ] || dest="$root/media/agent/$arch"
        collect_rpms "$work/out" "$arch" "$dest" || failed=1
    done
    [ "$failed" = 0 ] || exit 1
}

case $mode in
    sdk) build_sdk ;;
    docker) build_docker ;;
esac
