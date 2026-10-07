#ifndef STATS_H
#define STATS_H

#include <QObject>
#include <QString>
#include <QTimer>

class QLocalSocket;

// The stats stream (agent 1.10.0): one JSON line per interval about the process whose first command
// line argument is `exe`, plus system numbers, until the client disconnects. Reads /proc only.
class StatsStream : public QObject
{
    Q_OBJECT
public:
    StatsStream(QLocalSocket *socket, const QString &exe, int intervalMs, const QString &client = QString());

    bool active() const { return !m_ended; }
    QString client() const { return m_client; }

    // Ends the stream from the phone: one last line {"ok":false,"error":<reason>}, then the
    // connection is closed (Developer Mode went off, "Stop all sessions now").
    void endWithError(const QString &reason);

signals:
    // The stream ended (client gone or ended from the phone).
    void ended();

private slots:
    void tick();
    void onClientGone();

private:
    int findPid() const;
    void writeLine(const QByteArray &json);
    void markEnded();

    QLocalSocket *m_socket;
    QTimer m_timer;
    QString m_exe;
    QString m_client;
    bool m_ended;
    int m_pid;
    qint64 m_lastWallMs;
    unsigned long long m_lastTicks;
    bool m_haveTicks;
    unsigned long long m_lastBusy;
    unsigned long long m_lastTotal;
    bool m_haveSys;
};

#endif
