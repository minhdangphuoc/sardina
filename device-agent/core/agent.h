#ifndef AGENT_H
#define AGENT_H

#include <QObject>
#include <QJsonObject>
#include <QList>
#include <QTimer>
#include <QVariantMap>

#include "notice.h"
#include "requestreader.h"

class ModuleProcess;
class Settings;
class SettingsService;
class StreamIndicator;

// The daemon: a Unix socket in the user's runtime directory, one JSON request per connection, a
// fixed set of commands. It answers ping and refusals itself and hands every other request, after
// its gates, to the module's own process. Runs as defaultuser.
class Agent : public QObject
{
    Q_OBJECT
public:
    explicit Agent(QObject *parent = nullptr);
    ~Agent();

    // Starts listening, or keeps retrying while /run/user/<uid> does not exist yet.
    void start();
    // Ends the module processes, removes the socket and the runtime directory.
    void stop();
    // SIGCHLD: collects the module processes that exited.
    void reapChildren();

    // For the Settings page (agent 1.9.0, SettingsService): the GetStatus map, and "Stop all
    // sessions now" (returns how many were running).
    QVariantMap statusMap() const;
    int stopSessions();
    // True from the moment an idle mode change ended the running mirror until VS Code has
    // reconnected (or MIRROR_RESTART_MS passed): the Settings page waits and SetBool refuses
    // idleMode and screenView meanwhile.
    bool mirrorRestarting() const { return m_mirrorRestarting; }

private slots:
    void tryListen();
    void onConnection(int fd);
    void onRequest(RequestReader *reader, const QJsonObject &request);
    void onRequestFailed(RequestReader *reader, const QString &error);
    // A phone setting changed: applied to running sessions before the D-Bus call returns.
    void onSettingChanged(const QString &key);
    // A stream started or stopped, control or the capture path changed.
    void onSessionChanged();
    // Ends every stream once Developer Mode is off.
    void checkDeveloperMode();
    void onChildEvent(ModuleProcess *child, const QJsonObject &line);
    void onControlShown();

private:
    struct PendingMirror {
        int fd = -1;
        QJsonObject request;
        QString client;
    };

    QJsonObject pingReply() const;
    ModuleProcess *startModule(const QString &module, int fd, const QJsonObject &request, const QString &client);
    void startMirror(int fd, const QJsonObject &request, const QString &client);
    void spawnMirror(int fd, const QJsonObject &request, const QString &client);
    ModuleProcess *mirrorChild() const;
    QList<ModuleProcess *> children(const QString &module) const;
    void sendInputShown(ModuleProcess *mirror, bool shown);
    void setMirrorRestarting(bool on);

    HandoffServer m_server;
    QTimer m_retry;
    QTimer m_developerModeCheck; // runs while a stream does
    QTimer m_restartTimer;       // single shot: gives up waiting for the mirror to come back
    QTimer m_replaceTimer;       // single shot: kills a replaced mirror that did not end in time
    bool m_mirrorRestarting;
    Settings *m_settings;         // a child of this, created first: the others read it
    StreamIndicator *m_indicator; // a child of this, so it outlives the streams
    SettingsService *m_service;   // a child of this
    StartNotice m_notice;
    QList<ModuleProcess *> m_children; // children of this, removed once reaped
    PendingMirror m_pendingMirror; // a mirror request waiting for the replaced one to exit
};

#endif
