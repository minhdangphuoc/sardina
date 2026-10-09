#!/bin/sh
# Read-only check after "Uninstall Device Agent": prints one line per thing of the agent still on
# the device and exits 1 if there is any (0 when clean, 2 when not run as root). Changes nothing.
# Kept in sync with ROOT_PATHS and CLEANUP_SCRIPT in src/agent/uninstallCore.ts.
#
#   devel-su sh uninstall-check.sh

P=sailfish-devagent
U=defaultuser
left() {
    echo "left: $*"
}

exists() {
    [ -e "$1" ] || [ -L "$1" ]
}

if [ "$(id -u)" != 0 ]; then
    echo "run as root (devel-su)" >&2
    exit 2
fi

check() {
rpm -qa 2>/dev/null | grep "^$P" | while read -r n; do left "package $n"; done

# Unmatched globs stay literal and fail the test.
for p in /usr/bin/$P /usr/lib/systemd/system/$P.service \
    /usr/lib/systemd/system/multi-user.target.wants/$P.service \
    /etc/systemd/system/multi-user.target.wants/$P.service \
    /usr/share/jolla-settings/entries/$P.json /usr/share/$P /usr/libexec/$P /var/lib/$P \
    /tmp/$P.rpm /tmp/systemd-private-*-$P.service-* /var/tmp/systemd-private-*-$P.service-* \
    /run/user/*/$P; do
    exists "$p" && left "$p"
done

home=$(getent passwd $U 2>/dev/null | cut -d: -f6)
for h in $home /home/*; do
    [ -d "$h" ] || continue
    exists "$h/$P" && left "$h/$P"
    exists "$h/.cache/sailfish-tools" && left "$h/.cache/sailfish-tools"
done

pgrep -x $P >/dev/null 2>&1 && left "running process $P"
pgrep -f "^/usr/libexec/$P/" >/dev/null 2>&1 && left "running module process"

load=$(systemctl show -p LoadState --value $P.service 2>/dev/null)
[ -n "$load" ] && [ "$load" != not-found ] && left "systemd unit $P.service ($load)"
systemctl is-failed --quiet $P.service 2>/dev/null && left "systemd unit $P.service (failed)"

uid=$(id -u $U 2>/dev/null)
bus=/run/user/$uid/dbus/user_bus_socket
if [ -n "$uid" ] && [ -S "$bus" ] && command -v dbus-send >/dev/null 2>&1; then
    ds() { runuser -u $U -- dbus-send --bus="unix:path=$bus" --print-reply --reply-timeout=3000 "$@" 2>/dev/null; }
    ds --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.NameHasOwner \
        string:io.github.minhdangphuoc.SailfishDevAgent | grep -q 'boolean true' &&
        left "D-Bus name io.github.minhdangphuoc.SailfishDevAgent"
    ids=$(ds --dest=org.freedesktop.Notifications /org/freedesktop/Notifications \
        org.freedesktop.Notifications.GetNotifications string: |
        awk '/^ *struct \{$/ { s = 1; next } s == 1 { s = 0; g = ($0 ~ /^ *string "'$P'"$/); next } g && $1 == "uint32" { print $2; g = 0 }')
    for id in $ids; do left "notification $id"; done
else
    echo "unchecked: notifications and D-Bus name (no session bus)" >&2
fi

# Anything else named after the agent (removable media and virtual file systems skipped).
find / \( -path /proc -o -path /sys -o -path /dev -o -path /run/media -o -path /media \) -prune \
    -o -name "*$P*" -print 2>/dev/null | while read -r p; do left "$p"; done
}

# Several checks can name the same path: one line each.
out=$(check | sort -u)
if [ -n "$out" ]; then
    printf '%s\n' "$out"
    exit 1
fi
echo "clean: nothing of $P is left"
