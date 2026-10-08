#ifndef AGENT_H
#define AGENT_H

#include <QObject>
#include <QLocalServer>
#include <QJsonObject>
#include <QList>
#include <QPointer>
#include <QTimer>
#include <QVariantMap>

class QLocalSocket;
class LogStream;
class MirrorStream;
class Settings;
class SettingsService;
class StatsStream;
class StreamIndicator;

// The daemon: a Unix socket in the user's runtime directory, one JSON request
// per connection, a fixed set of commands. Runs as defaultuser.
class Agent : public QObject
{
    Q_OBJECT
public:
    explicit Agent(QObject *parent = nullptr);
    ~Agent();

    // Starts listening, or keeps retrying while /run/user/<uid> does not exist yet.
    void start();
    // Removes the socket and the runtime directory.
    void stop();

    // Closes every notification the agent posted (the start notice and a stream indicator). Run as
    // the device user by the package's %preun on uninstall; returns the exit code.
    static int removeNotifications();

    // For the Settings page (agent 1.9.0, SettingsService): the GetStatus map, and "Stop all
    // sessions now" (returns how many were running).
    QVariantMap statusMap() const;
    int stopSessions();

private slots:
    void tryListen();
    void onNewConnection();
    // A phone setting changed: applied to running sessions before the D-Bus call returns.
    void onSettingChanged(const QString &key);
    // A mirror or log stream started or stopped, control or the capture path changed.
    void onSessionChanged();
    // Ends the log and stats streams once Developer Mode is off: unlike the mirror they get no
    // keepalives on which to recheck it.
    void checkDeveloperMode();

private:
    void readRequest(QLocalSocket *socket);
    void dispatch(QLocalSocket *socket, const QJsonObject &request);
    void reply(QLocalSocket *socket, const QJsonObject &object);
    // Posts the start notice unless muted; `silent` posts it without a banner (after an unmute).
    void notifyStarted(bool silent = false);
    void closeStartNotice();
    void closeStaleStreamEntries();

    QLocalServer m_server;
    QTimer m_retry;
    QTimer m_developerModeCheck; // runs while a log or stats stream does
    bool m_notified;
    Settings *m_settings;         // a child of this, created first: the others read it
    StreamIndicator *m_indicator; // a child of this, so it outlives the sockets in m_server
    SettingsService *m_service;   // a child of this
    QPointer<MirrorStream> m_mirror;
    QString m_mirrorClient;
    QList<QPointer<LogStream>> m_logs;
    QList<QPointer<StatsStream>> m_stats; // agent 1.10.0: the monitor's stats streams
};

#endif
