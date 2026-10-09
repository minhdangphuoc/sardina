#ifndef SETTINGS_H
#define SETTINGS_H

#include <QObject>
#include <QString>
#include <QVariantMap>

// How a session is shown on the phone (PLAN-settings-page.md section 6). No level removes the
// notification entry that exists while a session is active.
enum class IndicatorLevel { Normal, Quiet, Minimal };

// The phone's settings for the agent (agent 1.9.0): what VS Code may do and how a session is
// shown. Changed only through the agent's D-Bus interface by a caller in the privileged group
// (the Settings app), never from a socket request. Kept in Paths::settingsPath(), a file in a
// root:privileged 0770 directory, written whole through a temporary file and rename. Read once at
// start: a missing file means defaults; a malformed file, an unknown version or a wrong type gives
// the default for the affected keys and one journal line.
class Settings : public QObject
{
    Q_OBJECT
public:
    explicit Settings(QObject *parent = nullptr);

    bool screenView() const { return m_screenView; }
    bool control() const { return m_control; }
    bool logs() const { return m_logs; }
    bool touchIndicator() const { return m_touchIndicator; }
    bool idleMode() const { return m_idleMode; }
    // The mirror's frame rate limit (agent 1.10.7): 30 or 60.
    int maxFps() const { return m_maxFps; }
    static bool validMaxFps(double fps) { return fps == 30 || fps == 60; }
    bool muteNotifications() const { return m_muteNotifications; }
    IndicatorLevel indicator() const { return m_indicator; }

    // Effective indication, with the mute folded in.
    bool bannersAllowed() const { return m_indicator == IndicatorLevel::Normal && !m_muteNotifications; }
    bool startNoticeAllowed() const { return !m_muteNotifications; }

    // Reads the file; false when it was missing or (partly) ignored. Defaults are kept for every
    // key the file does not give correctly.
    bool load();
    // Validate the key and value, store the change in memory, save the file, then emit changed()
    // (only when the value actually changed). A save failure is journalled; the change still
    // applies until the agent restarts. False only for an unknown key or an invalid value.
    bool setBool(const QString &key, bool value, QString *error);
    bool setString(const QString &key, const QString &value, QString *error);

    // The eight keys, for ping, GetStatus and the stream message.
    QVariantMap toMap() const;

    static QString indicatorName(IndicatorLevel level);

signals:
    void changed(const QString &key);

private:
    bool save(QString *error) const;

    bool m_screenView;
    bool m_control;
    bool m_logs;
    bool m_touchIndicator;
    bool m_muteNotifications;
    bool m_idleMode;
    int m_maxFps;
    IndicatorLevel m_indicator;
};

#endif
