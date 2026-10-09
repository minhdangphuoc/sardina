#ifndef STATS_H
#define STATS_H

#include <QObject>
#include <QString>
#include <QTimer>

class QLocalSocket;
class StallWatch;

// The stats stream (agent 1.10.0): one JSON line per interval about the process whose first command
// line argument is `exe`, plus system numbers, until the client disconnects. Reads /proc only.
class StatsStream : public QObject
{
    Q_OBJECT
public:
    StatsStream(QLocalSocket *socket, const QString &exe, int intervalMs, const QString &client = QString());

    bool active() const { return !m_ended; }
    QString client() const { return m_client; }

    // Ends the stream at once without a last line: the client stopped reading.
    void dropSlowClient();

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
    int findPid(qint64 now);
    int scanForPid() const;
    void writeLine(const QByteArray &json);
    void markEnded();

    QLocalSocket *m_socket;
    QTimer m_timer;
    QString m_exe;
    QString m_client;
    bool m_ended;
    int m_pid;
    qint64 m_lastWallMs;
    qint64 m_lastScanMs; // -1 before the first /proc scan
    StallWatch *m_stall;
    unsigned long long m_lastTicks;
    bool m_haveTicks;
    unsigned long long m_lastBusy;
    unsigned long long m_lastTotal;
    bool m_haveSys;
};

#endif
