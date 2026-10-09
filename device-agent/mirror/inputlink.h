#ifndef INPUTLINK_H
#define INPUTLINK_H

#include <QObject>
#include <QPoint>
#include <QSize>
#include <QString>
#include <sys/types.h>

class LineLink;

// The mirror's handle on the input module (sailfish-devagent-input): the calls MirrorStream made on
// the evdev injector, sent as lines to that process. Actions are fire and
// forget; busy() and liveContact() are a local guess the module corrects after every command.
class InputLink : public QObject
{
    Q_OBJECT
public:
    // Starts `executable` (empty: the input module is not installed) and waits up to 2 s for it.
    explicit InputLink(const QString &executable, QObject *parent = nullptr);
    ~InputLink();

    bool available() const { return m_touch || m_keypad; }
    bool keypadAvailable() const { return m_keypad; }
    QString error() const { return m_error; }
    bool busy() const { return m_busy; }
    bool liveContact() const { return m_busy && m_live; }
    static bool validKeyName(const QString &key);

    void setScreen(const QSize &size, bool nativeCoordinates);
    void tap(const QPoint &point);
    void swipe(const QPoint &from, const QPoint &to, int durationMs);
    void contactDown(const QPoint &point);
    void contactMove(const QPoint &point);
    void contactUp();
    void keyDown(const QString &key);
    void keyUp(const QString &key);
    void cancel();

    // The phone's own cursor follows the agent's touches (module-side virtual pointer).
    void setCursorEnabled(bool enabled);

signals:
    void contactChanged(const QPoint &point, bool pressed);

private:
    bool start(const QString &executable);
    void send(const QJsonObject &line);
    void onEvent(const QJsonObject &line);
    void stop();

    pid_t m_pid;
    LineLink *m_link;
    bool m_touch;
    bool m_keypad;
    QString m_error;
    bool m_busy;
    bool m_live;
    bool m_cursor = false;
};

#endif
