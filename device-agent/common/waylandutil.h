#ifndef WAYLANDUTIL_H
#define WAYLANDUTIL_H

#include <QString>

struct wl_display;

// The connection steps the recorder uses to reach lipstick's compositor.
namespace WaylandUtil {

// Opens the socket itself rather than through wl_display_connect, so the agent needs no
// XDG_RUNTIME_DIR: lipstick's socket is /run/display/wayland-0 (WAYLAND_DISPLAY=../../display/wayland-0
// relative to /run/user/<uid> in lipstick's own clients). Returns null and sets *error on failure.
wl_display *connectDisplay(QString *error);

// wl_display_roundtrip with a deadline, so a stuck compositor cannot hang the daemon. After a
// timeout the caller must disconnect the display: the pending callback points at this call's stack.
bool roundtrip(wl_display *display, int timeoutMs);

// The display's error as text ("timeout" when there is none, i.e. a roundtrip ran out of time).
QString displayError(wl_display *display);

}

#endif
