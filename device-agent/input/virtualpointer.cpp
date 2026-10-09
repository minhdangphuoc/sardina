#include "virtualpointer.h"

#include <fcntl.h>
#include <linux/uinput.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <cstring>

VirtualPointer::VirtualPointer()
    : m_fd(-1)
{
}

VirtualPointer::~VirtualPointer()
{
    close();
}

bool VirtualPointer::open()
{
    if (m_fd >= 0) {
        return true;
    }
    const int fd = ::open("/dev/uinput", O_WRONLY | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0) {
        return false;
    }
    struct uinput_user_dev dev; // the legacy setup works on old Sailfish kernels too
    memset(&dev, 0, sizeof(dev));
    strncpy(dev.name, "sailfish-devagent pointer", UINPUT_MAX_NAME_SIZE - 1);
    dev.id.bustype = BUS_VIRTUAL;
    const bool ok = ioctl(fd, UI_SET_EVBIT, EV_KEY) == 0 && ioctl(fd, UI_SET_KEYBIT, BTN_LEFT) == 0
        && ioctl(fd, UI_SET_EVBIT, EV_REL) == 0 && ioctl(fd, UI_SET_RELBIT, REL_X) == 0
        && ioctl(fd, UI_SET_RELBIT, REL_Y) == 0 && write(fd, &dev, sizeof(dev)) == sizeof(dev)
        && ioctl(fd, UI_DEV_CREATE) == 0;
    if (!ok) {
        ::close(fd);
        return false;
    }
    m_fd = fd;
    m_track.forget();
    return true;
}

void VirtualPointer::close()
{
    if (m_fd < 0) {
        return;
    }
    ioctl(m_fd, UI_DEV_DESTROY);
    ::close(m_fd);
    m_fd = -1;
}

void VirtualPointer::moveTo(const QPoint &point, const QSize &screen)
{
    if (m_fd < 0 || screen.isEmpty()) {
        return;
    }
    const PointerMove m = m_track.moveTo(point.x(), point.y(), screen.width(), screen.height());
    if (m.home) {
        rel(m.homeX, m.homeY);
    }
    if (m.dx || m.dy) {
        rel(m.dx, m.dy);
    }
}

void VirtualPointer::rel(int dx, int dy)
{
    struct input_event ev[3];
    memset(ev, 0, sizeof(ev));
    ev[0].type = EV_REL;
    ev[0].code = REL_X;
    ev[0].value = dx;
    ev[1].type = EV_REL;
    ev[1].code = REL_Y;
    ev[1].value = dy;
    ev[2].type = EV_SYN;
    ev[2].code = SYN_REPORT;
    if (write(m_fd, ev, sizeof(ev)) < 0) {
        close(); // a vanished device is not retried; the next enable opens a new one
    }
}
