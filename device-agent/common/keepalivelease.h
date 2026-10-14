#ifndef KEEPALIVELEASE_H
#define KEEPALIVELEASE_H

#include <QObject>
#include <QJsonObject>
#include <QTimer>

#include "linebuffer.h"

class QLocalSocket;

// The opt-in stream lease: {"keepalive":...} renews it; other bounded JSON objects may be
// consumed by a module (the debugger's socket-owner confirmation). Oversize lines are dropped.
class KeepaliveLease : public QObject
{
    Q_OBJECT
public:
    KeepaliveLease(QLocalSocket *socket, int seconds, QObject *parent = nullptr);

signals:
    void expired();
    void message(const QJsonObject &value);

private slots:
    void onReadable();

private:
    QLocalSocket *m_socket;
    QTimer m_timer;
    LineBuffer m_lines;
};

#endif
