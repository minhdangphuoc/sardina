#ifndef DEBUGMONITOR_H
#define DEBUGMONITOR_H

#include <QObject>
#include <QTimer>
#include <QString>
#include <QElapsedTimer>
#include <QJsonObject>

class ModuleHost;

// Read-only Debugger Monitoring Agent: process arguments and socket ownership, no launch/kill
// method, no connection to the debugger, and no listening network socket of its own.
class DebugMonitor : public QObject
{
    Q_OBJECT
public:
    DebugMonitor(ModuleHost *host, const QString &exe, const QString &mode, int port);
    void start();
    void confirmOwner(const QJsonObject &value);

private slots:
    void poll();

private:
    ModuleHost *m_host;
    QString m_exe;
    QString m_mode;
    int m_port;
    bool m_seenApp = false;
    bool m_seenServer = false;
    QString m_lastState;
    int m_confirmedPid = 0;
    QByteArray m_confirmedInode;
    QElapsedTimer m_confirmationAge;
    QTimer m_poll;
};

#endif
