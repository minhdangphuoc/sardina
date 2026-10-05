#ifndef LOGS_H
#define LOGS_H

#include <QObject>
#include <QProcess>

class QLocalSocket;

// Runs `journalctl -f` and copies its output to the client socket until the
// client disconnects (then journalctl is killed) or journalctl exits.
class LogStream : public QObject
{
    Q_OBJECT
public:
    LogStream(QLocalSocket *socket, int lines);

private slots:
    void onOutput();
    void onClientGone();
    void onProcessFinished();

private:
    QLocalSocket *m_socket;
    QProcess m_process;
};

#endif
