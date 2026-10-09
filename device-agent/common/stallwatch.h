#ifndef STALLWATCH_H
#define STALLWATCH_H

#include <QElapsedTimer>
#include <QLocalSocket>
#include <QObject>

#include "streamlimits.h"

// Tells a stream when its client stopped reading (streamlimits.h): call stalled() after each write.
// The stall clock runs from the last progress, or from when the queue last became non-empty.
class StallWatch : public QObject
{
public:
    explicit StallWatch(QLocalSocket *socket)
        : QObject(socket)
        , m_socket(socket)
    {
        m_sinceWrite.start();
        connect(socket, &QLocalSocket::bytesWritten, this, [this]() {
            m_sinceWrite.restart();
            m_drained = m_socket->bytesToWrite() == 0;
        });
    }

    bool stalled()
    {
        const qint64 unsent = m_socket->bytesToWrite();
        if (m_drained) {
            m_sinceWrite.restart(); // a new backlog starts now, not at the last write
        }
        m_drained = unsent == 0;
        return clientStalled(unsent, m_sinceWrite.elapsed());
    }

private:
    QLocalSocket *m_socket;
    QElapsedTimer m_sinceWrite;
    bool m_drained = true;
};

#endif
