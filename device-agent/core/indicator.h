#ifndef INDICATOR_H
#define INDICATOR_H

#include <QElapsedTimer>
#include <QObject>
#include <QStringList>
#include <QTimer>

class Settings;

// The on-phone indicator while a mirror stream is active: one persistent notification (reused
// through replaces_id, so there is never more than one entry). A banner preview appears only when
// no stream was active for 5 minutes, so a quick hide/show in VS Code updates the entry silently.
// The entry is closed 10 s after the last stream stops. Viewing indication is best effort; remote
// input is enabled only after the controlled notification has been acknowledged by the service.
// The phone's indicator level (agent 1.9.0, Settings) only changes how loud the entry is: Normal
// as above; Quiet (or Normal while notifications are muted) never shows a banner; Minimal also
// lowers the priority and never turns the display on. The entry itself exists at every level
// while a stream is active, and control still waits for the "controlled" text to be acknowledged.
class StreamIndicator : public QObject
{
    Q_OBJECT
public:
    explicit StreamIndicator(const Settings *settings, QObject *parent = nullptr);

    // The summaries of the stream entry (to close entries left by a daemon that did not stop).
    static QStringList summaries();

    void streamStarted();
    void streamStopped();
    // Requests the persistent entry to say that remote control is active. True means that state is
    // already visible; false means input must remain disabled while the asynchronous Notify call
    // is pending or failed. Deactivation updates state immediately.
    bool setInputActive(bool active);
    // Closes the entry now (daemon shutdown).
    void closeNow();
    // Re-posts an active entry silently with the hints of the current level (a level or mute
    // change on the phone).
    void refresh();
    // Whether the entry currently says "controlled" (acknowledged by the notification service).
    bool showingInput() const { return m_showingInput; }

signals:
    // The asynchronous controlled notification succeeded while input is still requested.
    void inputReady();
    // The entry switched between "viewed" and "controlled" (for the Settings page's status).
    void controlChanged();

private slots:
    void closeNotification();

private:
    void notify(bool wantBanner);
    void setShowingInput(bool showing);

    const Settings *m_settings;
    int m_active;
    bool m_inputActive;
    bool m_showingInput;
    bool m_notifyPending;
    uint m_id;
    bool m_hasStopped;
    bool m_refreshWanted; // a refresh came while a Notify call was pending
    QElapsedTimer m_sinceStop;
    QTimer m_closeTimer;
};

#endif
