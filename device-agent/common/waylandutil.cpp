#include "waylandutil.h"
#include "paths.h"

#include <QElapsedTimer>
#include <QList>
#include <QStringList>
#include <wayland-client.h>

#include <cerrno>
#include <cstring>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace {

int connectUnix(const QByteArray &path)
{
    sockaddr_un addr;
    std::memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    if (path.size() >= static_cast<int>(sizeof(addr.sun_path))) {
        errno = ENAMETOOLONG;
        return -1;
    }
    std::memcpy(addr.sun_path, path.constData(), static_cast<size_t>(path.size()));
    const int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return -1;
    }
    if (::connect(fd, reinterpret_cast<sockaddr *>(&addr), sizeof(addr)) != 0) {
        const int saved = errno;
        close(fd);
        errno = saved;
        return -1;
    }
    return fd;
}

void onSyncDone(void *data, wl_callback *callback, uint32_t)
{
    *static_cast<bool *>(data) = true;
    wl_callback_destroy(callback);
}

const wl_callback_listener syncListener = { onSyncDone };

}

namespace WaylandUtil {

wl_display *connectDisplay(QString *error)
{
    QList<QByteArray> candidates;
    const QByteArray name = qgetenv("WAYLAND_DISPLAY");
    if (!name.isEmpty()) {
        QByteArray dir = qgetenv("XDG_RUNTIME_DIR");
        if (dir.isEmpty()) {
            dir = Paths::userRuntimeDir().toLocal8Bit();
        }
        candidates << (name.startsWith('/') ? name : dir + '/' + name);
    } else {
        candidates << QByteArrayLiteral("/run/display/wayland-0")
                   << (Paths::userRuntimeDir().toLocal8Bit() + "/wayland-0");
    }
    QStringList tried;
    for (const QByteArray &path : candidates) {
        const int fd = connectUnix(path);
        if (fd < 0) {
            tried << QString::fromLocal8Bit(path) + QStringLiteral(": ") + QString::fromLocal8Bit(strerror(errno));
            continue;
        }
        wl_display *display = wl_display_connect_to_fd(fd); // owns fd from here, also on failure
        if (display) {
            return display;
        }
        tried << QString::fromLocal8Bit(path) + QStringLiteral(": wl_display_connect_to_fd failed");
    }
    *error = QStringLiteral("no Wayland display (") + tried.join(QStringLiteral(", ")) + QStringLiteral(")");
    return nullptr;
}

bool roundtrip(wl_display *display, int timeoutMs)
{
    bool done = false;
    wl_callback *callback = wl_display_sync(display);
    wl_callback_add_listener(callback, &syncListener, &done);
    QElapsedTimer clock;
    clock.start();
    const int fd = wl_display_get_fd(display);
    while (!done) {
        if (wl_display_dispatch_pending(display) < 0) {
            return false;
        }
        if (done) {
            break;
        }
        if (wl_display_flush(display) < 0 && errno != EAGAIN) {
            return false;
        }
        const qint64 left = timeoutMs - clock.elapsed();
        if (left <= 0) {
            return false;
        }
        if (wl_display_prepare_read(display) != 0) {
            continue; // events queued meanwhile: dispatch them first
        }
        pollfd p = { fd, POLLIN, 0 };
        const int n = poll(&p, 1, static_cast<int>(left));
        if (n <= 0) {
            wl_display_cancel_read(display);
            if (n == 0 || errno == EINTR) {
                continue; // the deadline check above ends the loop
            }
            return false;
        }
        if (wl_display_read_events(display) < 0) {
            return false;
        }
    }
    return wl_display_get_error(display) == 0;
}

QString displayError(wl_display *display)
{
    const int err = display ? wl_display_get_error(display) : 0;
    if (err == 0) {
        return QStringLiteral("timeout");
    }
    if (err == EPROTO) {
        const wl_interface *iface = nullptr;
        uint32_t id = 0;
        const uint32_t code = wl_display_get_protocol_error(display, &iface, &id);
        return QStringLiteral("protocol error %1 on %2").arg(code).arg(QLatin1String(iface ? iface->name : "?"));
    }
    return QString::fromLocal8Bit(strerror(err));
}

}
