#ifndef CHILDLINK_H
#define CHILDLINK_H

#include <QByteArray>
#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QString>
#include <sys/types.h>

#include "linebuffer.h"

class QSocketNotifier;

// Process handoff between the daemon and its module executables: one JSON object per line on a
// pipe in each direction.
namespace ChildLink {

// Control and event lines are small; the first control line carries the request (at most 4 KB).
const size_t LINE_MAX_BYTES = 16384;

struct Child {
    pid_t pid = -1;
    int controlFd = -1; // our end of the child's fd 0
    int eventFd = -1;   // our end of the child's fd 1
};

// Starts `exe` with posix_spawn: fd 0 = control pipe, fd 1 = event pipe, fd 2 inherited, fd 3 =
// `handoffFd` when it is >= 0. Our pipe ends are close-on-exec and non-blocking.
bool spawn(const QByteArray &exe, const QList<QByteArray> &args, int handoffFd, Child *child, QString *error);

// Runs `exe` without a handoff and returns what it printed when it exited with 0 within
// `timeoutMs`; kills it otherwise. Blocks the caller.
bool capture(const QByteArray &exe, const QList<QByteArray> &args, int timeoutMs, QByteArray *out);

// Reaps `pid` if it has exited (never waits, never touches other children). True once reaped.
bool reap(pid_t pid);

}

// One end of a line link: reads lines from `readFd`, writes lines to `writeFd` (either may be -1).
// Takes ownership of both descriptors. Writes are buffered, so a slow reader never blocks the sender.
class LineLink : public QObject
{
    Q_OBJECT
public:
    LineLink(int readFd, int writeFd, QObject *parent = nullptr);
    ~LineLink();

    void send(const QJsonObject &line);
    // Writes what is still buffered, waiting at most `timeoutMs` (before an exit).
    void flush(int timeoutMs);

signals:
    void received(const QJsonObject &line);
    // The read side reached end of file or failed: the other process is gone.
    void closed();

private slots:
    void onReadable();
    void onWritable();

private:
    void writeOut();
    void closeRead();

    int m_readFd;
    int m_writeFd;
    QSocketNotifier *m_readNotifier;
    QSocketNotifier *m_writeNotifier;
    LineBuffer m_lines;
    QByteArray m_out;
};

#endif
