#ifndef MIRRORINPUT_H
#define MIRRORINPUT_H

#include <QObject>
#include <QPoint>
#include <QSet>
#include <QSize>
#include <QString>
#include <QStringList>
#include <QTimer>

struct MirrorKeypadInfo {
    QString model;
    QStringList keys;
};

// Injects one-finger gestures and whitelisted keypad events through the phone's existing evdev
// devices. The service runs as defaultuser and inherits that user's `input` group, so no new
// privilege is needed. Devices are opened without EVIOCGRAB: physical input keeps working.
// Native-recorder coordinates are already in the touchscreen's fixed panel coordinate system.
// Screenshot input is refused: Lipstick rotates saved screenshots by its top-window orientation,
// which is not exposed by its D-Bus API, and the physical orientation sensor is not equivalent.
class MirrorInput : public QObject
{
    Q_OBJECT
public:
    explicit MirrorInput(QObject *parent = nullptr);
    ~MirrorInput();

    bool available() const { return m_fd >= 0 || m_keyFd >= 0; }
    bool touchAvailable() const { return m_fd >= 0; }
    bool keypadAvailable() const { return m_keyFd >= 0; }
    QString error() const { return m_error; }
    bool busy() const { return m_down; }
    bool liveContact() const { return m_down && m_liveContact; }
    static MirrorKeypadInfo keypadInfo();
    static bool validKeyName(const QString &key);

    void setScreen(const QSize &size, bool nativeCoordinates)
    {
        m_screen = size;
        m_nativeCoordinates = nativeCoordinates;
    }
    bool tap(const QPoint &point);
    bool swipe(const QPoint &from, const QPoint &to, int durationMs);
    // Live contact primitives (agent 1.9.0): unlike tap/swipe replay, these keep the evdev
    // tracking id down until the client explicitly releases it. This is what makes press-and-hold
    // follow the mouse button in real time. cancel() remains the unconditional safety release.
    bool contactDown(const QPoint &point);
    bool contactMove(const QPoint &point);
    bool contactUp();
    bool keyDown(const QString &key);
    bool keyUp(const QString &key);
    void cancel();

signals:
    // Fixed-panel screen coordinates after validation, for the optional debug touch overlay.
    // A false state is emitted even if the evdev release write fails, so an overlay never remains
    // visible after the injector has abandoned a contact.
    void contactChanged(const QPoint &point, bool pressed);
    // busy() or liveContact() changed.
    void stateChanged();

private slots:
    void advance();

private:
    bool openTouchscreen();
    bool openKeypad();
    bool begin(const QPoint &point, bool live);
    bool move(const QPoint &point);
    bool end();
    bool writePosition(const QPoint &point, bool down, bool up);
    bool releaseContact();
    bool chooseSlot();
    bool physicalTouchDown() const;
    bool physicalKeyDown(int code) const;
    bool releaseKey();
    QPoint mapToPanel(const QPoint &point, bool *ok) const;
    int scaleAxis(int value, int screenMax, int axisMin, int axisMax) const;

    int m_fd;
    int m_keyFd;
    QString m_error;
    QString m_device;
    QSize m_screen;
    bool m_nativeCoordinates;
    bool m_multi;
    bool m_slot;
    bool m_absX;
    bool m_absY;
    bool m_btnTouch;
    int m_xCode;
    int m_yCode;
    int m_xMin;
    int m_xMax;
    int m_yMin;
    int m_yMax;
    int m_absXMin;
    int m_absXMax;
    int m_absYMin;
    int m_absYMax;
    int m_slotMin;
    int m_slotMax;
    int m_selectedSlot;
    int m_trackingId;
    bool m_down;
    bool m_liveContact;
    QSet<int> m_keyCodes;
    int m_keyCode;
    QPoint m_lastPoint;
    QPoint m_from;
    QPoint m_to;
    int m_durationMs;
    int m_step;
    int m_steps;
    QTimer m_timer;
};

#endif
