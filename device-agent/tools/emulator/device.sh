#!/bin/sh
# Emulator side of emulator-test.py, run as root from the test's own folder (BusyBox sh). It drives
# the input module the way the mirror does: commands as lines on its fd 0, events from its fd 1.
#
#   sh device.sh <command> [arguments]

D=$(cd "$(dirname "$0")" && pwd)
MOD=/usr/libexec/sailfish-devagent/sailfish-devagent-input
U=defaultuser
RT=/run/user/$(id -u $U)

# The agent's own user and groups (its unit: User=defaultuser, Group=privileged). A command, not a
# function, in the background: a function there keeps copies of the SSH session's descriptors.
AS="runuser -u $U -g privileged -G input -G $U -- env XDG_RUNTIME_DIR=$RT DBUS_SESSION_BUS_ADDRESS=unix:path=$RT/dbus/user_bus_socket"
asuser() { $AS "$@"; }

# waitfor FILE PATTERN TENTHS: 0 once the pattern shows up in the file.
waitfor() {
    i=0
    while ! grep -q "$2" "$1" 2>/dev/null; do
        i=$((i + 1))
        [ $i -gt "$3" ] && return 1
        sleep 0.1
    done
}

module_pid() { pgrep -f "^$MOD --serve" | head -n 1; }

# Ends the session like InputLink::stop: EOF on fd 0, SIGKILL after 500 ms.
stop_session() {
    [ -f $D/holder.pid ] && kill "$(cat $D/holder.pid)" 2>/dev/null
    rm -f $D/holder.pid
    p=$(cat $D/module.pid 2>/dev/null)
    rm -f $D/module.pid
    [ -n "$p" ] || return 0
    i=0
    while kill -0 "$p" 2>/dev/null && [ $i -lt 10 ]; do sleep 0.05; i=$((i + 1)); done
    if kill -0 "$p" 2>/dev/null; then kill -9 "$p"; echo killed; else echo exited; fi
}

send() { echo "$1" > $D/in; }

case $1 in
setup)
    chmod 755 $D $D/clip $D/uitouch
    chmod 644 $D/testapp.qml
    echo "0 none" > $D/app.ctl
    chmod 644 $D/app.ctl
    # A virtual touchscreen: the emulator has none the module could write to.
    nohup $D/uitouch > $D/uitouch.log 2>&1 < /dev/null &
    echo $! > $D/uitouch.pid
    waitfor $D/uitouch.log created 30 || { cat $D/uitouch.log; exit 1; }
    sleep 1 ;;
start)
    stop_session > /dev/null
    rm -f $D/in
    mkfifo -m 644 $D/in
    : > $D/out
    : > $D/err
    chmod 666 $D/out $D/err
    $AS sh -c "exec $MOD --serve < $D/in 2>>$D/err | cat >> $D/out" < /dev/null > /dev/null 2>&1 &
    # Holds the write end open, so single commands do not end the session.
    sleep 100000 < /dev/null > $D/in 2>/dev/null &
    echo $! > $D/holder.pid
    send '{"start":true}'
    waitfor $D/out ready 50 || { echo "no ready event"; cat $D/err; exit 1; }
    module_pid > $D/module.pid
    send '{"screen":[720,1600]}' ;;
overlay)
    : > $D/overlay.out
    send '{"overlay":true}'
    i=0
    while ! grep -q '"overlay"' $D/out && [ $i -lt 30 ]; do sleep 0.1; i=$((i + 1)); done
    grep -o '"overlay":[a-z]*' $D/out | tail -n 1 ;;
send) send "$2" ;;
tap) send "{\"tap\":[$2,$3]}"; sleep 0.3 ;;
# drag X1 Y1 X2 Y2: presses at the first point and moves to the second in 15 steps, still pressed;
# slow enough for the module's limit of 20 commands a second.
drag)
    send "{\"down\":[$2,$3]}"
    sleep 0.1
    for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
        send "{\"move\":[$(($2 + ($4 - $2) * i / 15)),$(($3 + ($5 - $3) * i / 15))]}"
        sleep 0.07
    done ;;
up) send '{"up":true}' ;;
stop) stop_session ;;
kill9)
    p=$(cat $D/module.pid 2>/dev/null)
    [ -n "$p" ] && kill -9 "$p"
    stop_session > /dev/null ;;
events) cat $D/out ;;
usage)
    p=$(cat $D/module.pid)
    echo "$(awk '/VmRSS/ { print $2 }' /proc/$p/status) $(ls /proc/$p/fd | wc -l)" ;;
clip) asuser $D/clip "$2" "$3" ;;
clip-start) $AS $D/clip 0 "$2" < /dev/null > /dev/null 2>&1 & ;;
clip-stop) pkill -f "^$D/clip" ;;
app-start)
    : > $D/app.log
    chmod 666 $D/app.log
    $AS env WAYLAND_DISPLAY=../../display/wayland-0 QT_QPA_PLATFORM=wayland QT_IM_MODULE=Maliit QT_LOGGING_TO_CONSOLE=1 \
        qmlscene $D/testapp.qml < /dev/null >> $D/app.log 2>&1 &
    waitfor $D/app.log "EVENT active true" 200 || { echo "test app did not start"; cat $D/app.log; exit 1; } ;;
app-cmd)
    n=$(($(cat $D/app.seq 2>/dev/null || echo 0) + 1))
    echo $n > $D/app.seq
    echo "$n $2" > $D/app.ctl ;;
app-log) grep EVENT $D/app.log | sed 's/^.*EVENT //' ;;
app-running) pgrep -x qmlscene > /dev/null && echo yes || echo no ;;
app-stop) pkill -x qmlscene ;;
mce) dbus-send --system --type=method_call --dest=com.nokia.mce /com/nokia/mce/request "com.nokia.mce.request.$2" $3 ;;
setting)
    asuser dbus-send --session --print-reply --dest=io.github.minhdangphuoc.SailfishDevAgent \
        /io/github/minhdangphuoc/SailfishDevAgent io.github.minhdangphuoc.SailfishDevAgent.SetBool \
        string:"$2" boolean:"$3" | grep -o 'boolean [a-z]*' ;;
status)
    asuser dbus-send --session --print-reply --dest=io.github.minhdangphuoc.SailfishDevAgent \
        /io/github/minhdangphuoc/SailfishDevAgent io.github.minhdangphuoc.SailfishDevAgent.GetStatusJson |
        sed -n 's/^ *string "\(.*\)"$/\1/p' ;;
asuser) shift; asuser "$@" ;;
teardown)
    stop_session > /dev/null
    pkill -f "^$D/clip"
    pkill -x qmlscene
    [ -f $D/uitouch.pid ] && kill "$(cat $D/uitouch.pid)" 2>/dev/null
    cd /
    rm -rf "$D" ;;
*) echo "unknown command $1" >&2; exit 2 ;;
esac
