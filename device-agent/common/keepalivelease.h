#ifndef KEEPALIVELEASE_H
#define KEEPALIVELEASE_H

#include <QObject>
#include <QTimer>

#include "linebuffer.h"

class QLocalSocket;

// The opt-in lease of a log or stats stream: every {"keepalive":...} line from the client renews
// it; expired() fires once it ran out. Other lines are ignored, lines over 256 bytes dropped.
class KeepaliveLease : public QObject
{
    Q_OBJECT
public:
    KeepaliveLease(QLocalSocket *socket, int seconds, QObject *parent = nullptr);

signals:
    void expired();

private slots:
    void onReadable();

private:
    QLocalSocket *m_socket;
    QTimer m_timer;
    LineBuffer m_lines;
};

#endif
