#ifndef SETTINGSSERVICE_H
#define SETTINGSSERVICE_H

#include <QDBusConnection>
#include <QDBusContext>
#include <QObject>
#include <QString>
#include <QTimer>
#include <QVariantMap>
#include <sys/types.h>

class Agent;
class Settings;

// The agent's D-Bus interface on the user's session bus (agent 1.9.0), for the Settings page:
// GetStatus for anyone on the bus (the same information as ping); SetBool, SetString and
// StopSessions only for a caller whose /proc/<pid> shows the agent's uid and the effective group
// "privileged" (the Settings app; not the SSH login), the check lipstick applies to
// saveScreenshot. The name is requested once the socket listens, retried every 5 s, and owned
// again after the bus went away (checked every 30 s). There is no activation file.
class SettingsService : public QObject, protected QDBusContext
{
    Q_OBJECT
    Q_CLASSINFO("D-Bus Interface", "io.github.minhdangphuoc.SailfishDevAgent")
public:
    SettingsService(Settings *settings, Agent *agent, QObject *parent = nullptr);

    // Connects, registers the object and requests the name; retries on its own.
    void start();
    // Releases the name and drops the connection (daemon shutdown).
    void stop();
    // Emits the Changed signal on the bus (a setting or the session state changed).
    void notifyChanged(const QString &key);

public slots:
    Q_SCRIPTABLE QVariantMap GetStatus();
    // The same map as one JSON object string, for clients that cannot unwrap a{sv} (the Settings page).
    Q_SCRIPTABLE QString GetStatusJson();
    Q_SCRIPTABLE bool SetBool(const QString &key, bool value);
    Q_SCRIPTABLE bool SetString(const QString &key, const QString &value);
    Q_SCRIPTABLE int StopSessions();

signals:
    Q_SCRIPTABLE void Changed(const QString &key);
    // Same event with the whole status as a JSON object string.
    Q_SCRIPTABLE void ChangedJson(const QString &key, const QString &status);

private slots:
    void tryRegister();
    void checkBus();

private:
    // Runs before any argument is looked at; sends AccessDenied and returns false otherwise.
    bool privilegedCaller(uint *pid);

    Settings *m_settings;
    Agent *m_agent;
    bool m_registered;
    bool m_started;
    gid_t m_privilegedGid;
    bool m_haveGroup;
    bool m_loggedRestartRefusal; // the refusal while the mirror restarts is journalled once
    QTimer m_retry;
    QTimer m_watch;
};

#endif
