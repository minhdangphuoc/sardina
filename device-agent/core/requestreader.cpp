#include "requestreader.h"

#include <QJsonDocument>
#include <QSocketNotifier>
#include <cerrno>
#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

namespace {

const int REQUEST_MAX_BYTES = 4096;
const int REQUEST_TIMEOUT_MS = 5000;

void writeAll(int fd, const QByteArray &data)
{
    const char *p = data.constData();
    size_t left = static_cast<size_t>(data.size());
    while (left > 0) {
        const ssize_t n = send(fd, p, left, MSG_NOSIGNAL);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n <= 0) {
            return;
        }
        p += n;
        left -= static_cast<size_t>(n);
    }
}

}

RequestReader::RequestReader(int fd, QObject *parent)
    : QObject(parent)
    , m_fd(fd)
    , m_notifier(nullptr)
{
    fcntl(m_fd, F_SETFL, fcntl(m_fd, F_GETFL) | O_NONBLOCK);
    m_notifier = new QSocketNotifier(m_fd, QSocketNotifier::Read, this);
    connect(m_notifier, &QSocketNotifier::activated, this, &RequestReader::onReadable);
    m_timeout.setSingleShot(true);
    m_timeout.setInterval(REQUEST_TIMEOUT_MS);
    connect(&m_timeout, &QTimer::timeout, this, &RequestReader::onTimeout);
    m_timeout.start();
}

RequestReader::~RequestReader()
{
    stop();
    if (m_fd >= 0) {
        close(m_fd);
    }
}

int RequestReader::takeFd()
{
    stop();
    const int fd = m_fd;
    m_fd = -1;
    return fd;
}

void RequestReader::stop()
{
    m_timeout.stop();
    delete m_notifier;
    m_notifier = nullptr;
}

void RequestReader::replyAndClose(int fd, const QJsonObject &reply)
{
    if (fd < 0) {
        return;
    }
    // Blocking for the one short line: a client that stopped reading cannot hold more than the
    // socket buffer anyway.
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) & ~O_NONBLOCK);
    writeAll(fd, QJsonDocument(reply).toJson(QJsonDocument::Compact) + '\n');
    shutdown(fd, SHUT_WR);
    close(fd);
}

void RequestReader::onReadable()
{
    char c;
    for (;;) {
        const ssize_t n = read(m_fd, &c, 1);
        if (n < 0 && errno == EINTR) {
            continue;
        }
        if (n < 0 && errno == EAGAIN) {
            return;
        }
        if (n <= 0) {
            stop();
            emit failed(this, QString());
            return;
        }
        if (c == '\n') {
            break;
        }
        if (m_line.size() >= REQUEST_MAX_BYTES) {
            stop();
            emit failed(this, QStringLiteral("request too large"));
            return;
        }
        m_line += c;
    }
    stop();
    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(m_line, &parseError);
    if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
        emit failed(this, QStringLiteral("malformed request"));
        return;
    }
    emit request(this, doc.object());
}

void RequestReader::onTimeout()
{
    stop();
    emit failed(this, QStringLiteral("request timeout"));
}
