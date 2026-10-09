#include "keepalivelease.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QLocalSocket>

KeepaliveLease::KeepaliveLease(QLocalSocket *socket, int seconds, QObject *parent)
    : QObject(parent)
    , m_socket(socket)
    , m_lines(256)
{
    m_timer.setSingleShot(true);
    m_timer.setInterval(seconds * 1000);
    connect(&m_timer, &QTimer::timeout, this, &KeepaliveLease::expired);
    connect(m_socket, &QLocalSocket::readyRead, this, &KeepaliveLease::onReadable);
    m_timer.start();
    onReadable(); // lines that came with the request
}

void KeepaliveLease::onReadable()
{
    const QByteArray data = m_socket->readAll();
    std::vector<std::string> lines;
    m_lines.feed(data.constData(), static_cast<size_t>(data.size()), lines);
    for (const std::string &line : lines) {
        const QJsonDocument doc = QJsonDocument::fromJson(QByteArray(line.data(), static_cast<int>(line.size())));
        if (doc.isObject() && doc.object().value(QStringLiteral("keepalive")).isDouble()) {
            m_timer.start();
        }
    }
}
