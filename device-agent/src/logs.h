#ifndef LOGS_H
#define LOGS_H

#include <QObject>
#include <QProcess>
#include <QString>

class QLocalSocket;

// Runs `journalctl -f` and copies its output to the client socket until the
// client disconnects (then journalctl is killed) or journalctl exits.
class LogStream : public QObject
{
    Q_OBJECT
public:
    // `json` selects `journalctl -o json` (agent 1.10.0); `after` is a journal cursor to resume
    // from (json only, already checked with validCursor()).
    LogStream(QLocalSocket *socket, int lines, const QString &client = QString(), bool json = false,
              const QString &after = QString());

    // ^[A-Za-z0-9;=:._-]{1,512}$: what a journal cursor looks like; anything else is ignored.
    static bool validCursor(const QString &cursor);
    // Checks once whether the installed journalctl accepts --output-fields (run at daemon start);
    // the result is cached. Streams started before the probe ran do not use the option.
    static void probeOutputFields();
    static bool outputFieldsSupported();

    // Ends the stream from the phone (agent 1.9.0): journalctl is stopped, what it already wrote is
    // passed on, then one last line {"ok":false,"error":<reason>} and the connection is closed.
    void endWithError(const QString &reason);

    bool active() const { return !m_ended; }
    QString client() const { return m_client; }

signals:
    // The stream ended (client gone, journalctl exited or ended from the phone).
    void ended();

private slots:
    void onOutput();
    void onClientGone();
    void onProcessFinished();

private:
    void markEnded();
    void write(const QByteArray &data);

    QLocalSocket *m_socket;
    QProcess m_process;
    QString m_client;
    bool m_ended;
    bool m_atLineStart; // the bytes sent so far end with a newline
};

#endif
