#ifndef VIRTUALPOINTER_H
#define VIRTUALPOINTER_H

#include "pointertrack.h"

#include <QPoint>
#include <QSize>

// A uinput mouse whose cursor the phone draws where remote touches land. It is relative (REL_X/Y):
// Qt's evdev mouse handler treats only such a device as a mouse and applies no acceleration, so
// deltas are exact; an absolute device could be taken for a second touchscreen. BTN_LEFT is declared
// so the device counts as a mouse, but no button is ever sent: taps go through the touchscreen.
// The device exists only between open() and close(); closing the fd also removes it if we crash.
class VirtualPointer
{
public:
    VirtualPointer();
    ~VirtualPointer();

    bool open();
    void close();
    bool isOpen() const { return m_fd >= 0; }
    // A new touch: the next move homes first, so drift never builds up.
    void touchStarted() { m_track.forget(); }
    void moveTo(const QPoint &point, const QSize &screen);

private:
    void rel(int dx, int dy);

    int m_fd;
    PointerTrack m_track;
};

#endif
