#include "mirror.h"
#include "capture.h"
#include "paths.h"

#include <QBuffer>
#include <QByteArray>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QImage>
#include <QImageReader>
#include <QImageWriter>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLocalSocket>
#include <cstdio>

namespace {

const int CAPTURE_TIMEOUT_MS = 3000;
const int SLOW_INTERVAL_MS = 2000;
const int DROP_LOG_EVERY = 100;

QByteArray jsonString(const QString &s)
{
    QByteArray arr = QJsonDocument(QJsonArray{ s }).toJson(QJsonDocument::Compact); // ["..."]
    return arr.mid(1, arr.size() - 2);
}

bool canWriteJpeg()
{
    const QList<QByteArray> formats = QImageWriter::supportedImageFormats();
    return formats.contains("jpeg") || formats.contains("jpg");
}

}

MirrorStream::MirrorStream(QLocalSocket *socket, int fps, int width, int quality)
    : QObject(socket)
    , m_socket(socket)
    , m_fps(fps)
    , m_width(width)
    , m_quality(quality)
    , m_capture(nullptr)
    , m_captureTs(0)
    , m_frame(0)
    , m_seq(0)
    , m_drops(0)
    , m_slow(false)
    , m_cleaned(false)
{
    connect(m_socket, &QLocalSocket::disconnected, this, &MirrorStream::onClientGone);
    m_timer.setInterval(1000 / m_fps);
    connect(&m_timer, &QTimer::timeout, this, &MirrorStream::tick);

    writeLine(QByteArray("{\"ok\":true,\"stream\":\"mirror\",\"fps\":") + QByteArray::number(m_fps)
              + ",\"width\":" + QByteArray::number(m_width) + ",\"quality\":" + QByteArray::number(m_quality) + "}");
    fprintf(stderr, "sailfish-devagent: mirror started (fps %d, width %d, quality %d)\n", m_fps, m_width, m_quality);
    m_timer.start();
    QTimer::singleShot(0, this, &MirrorStream::tick);
}

MirrorStream::~MirrorStream()
{
    cleanup();
}

void MirrorStream::writeLine(const QByteArray &line)
{
    if (m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    m_socket->write(line);
    m_socket->write("\n");
    m_socket->flush();
}

void MirrorStream::tick()
{
    if (m_cleaned || m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    if (m_capture || m_socket->bytesToWrite() > 0) {
        if (++m_drops % DROP_LOG_EVERY == 0) {
            fprintf(stderr, "sailfish-devagent: mirror dropped %lld ticks\n", static_cast<long long>(m_drops));
        }
        return;
    }
    const QString ext = Paths::lipstickWritesJpeg() ? QStringLiteral("jpg") : QStringLiteral("png");
    ++m_seq;
    m_capturePath = Paths::screenshotStagingDir() + QStringLiteral("/mirror-%1.%2").arg(m_seq).arg(ext);
    m_captureTs = QDateTime::currentMSecsSinceEpoch();
    ++m_frame;
    m_capture = new Capture(m_capturePath, CAPTURE_TIMEOUT_MS, this);
    connect(m_capture, &Capture::finished, this, &MirrorStream::onCaptured);
    m_capture->start();
}

void MirrorStream::softError(const QString &message)
{
    writeLine("{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
              + ",\"error\":" + jsonString(message) + "}");
    if (!m_slow) {
        m_slow = true;
        m_timer.setInterval(SLOW_INTERVAL_MS);
    }
}

void MirrorStream::onCaptured(const QString &error)
{
    Capture *capture = m_capture;
    m_capture = nullptr;
    if (capture) {
        capture->deleteLater();
    }
    if (m_cleaned) {
        return;
    }
    if (!error.isEmpty()) {
        softError(error);
        return;
    }

    QFile file(m_capturePath);
    QByteArray bytes;
    if (file.open(QIODevice::ReadOnly)) {
        bytes = file.readAll();
        file.close();
    }
    QFile::remove(m_capturePath);
    QDir().rmdir(Paths::screenshotStagingDir()); // only if empty
    m_capturePath.clear();
    if (bytes.isEmpty()) {
        softError(QStringLiteral("cannot decode frame"));
        return;
    }
    if (m_slow) {
        m_slow = false;
        m_timer.setInterval(1000 / m_fps);
    }

    const QByteArray hash = QCryptographicHash::hash(bytes, QCryptographicHash::Md5);
    if (hash == m_lastHash) {
        writeLine("{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
                  + ",\"same\":true}");
        return;
    }

    QByteArray data;
    QByteArray format;
    QSize screen;
    QSize size;
    if (canWriteJpeg()) {
        QImage image = QImage::fromData(bytes);
        if (image.isNull()) {
            softError(QStringLiteral("cannot decode frame"));
            return;
        }
        screen = image.size();
        if (m_width > 0 && m_width < image.width()) {
            image = image.scaledToWidth(m_width, Qt::SmoothTransformation);
        }
        size = image.size();
        QBuffer buffer(&data);
        buffer.open(QIODevice::WriteOnly);
        if (!image.save(&buffer, "JPEG", m_quality)) {
            softError(QStringLiteral("cannot decode frame"));
            return;
        }
        format = "jpeg";
    } else {
        // No JPEG writer on this device: send lipstick's file as it is.
        QBuffer buffer(&bytes);
        buffer.open(QIODevice::ReadOnly);
        screen = QImageReader(&buffer).size();
        size = screen;
        data = bytes;
        format = Paths::lipstickWritesJpeg() ? "jpeg" : "png";
    }
    m_lastHash = hash;

    const QByteArray line = "{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
        + ",\"screen\":[" + QByteArray::number(screen.width()) + "," + QByteArray::number(screen.height())
        + "],\"size\":[" + QByteArray::number(size.width()) + "," + QByteArray::number(size.height())
        + "],\"format\":\"" + format + "\",\"data\":\"" + data.toBase64() + "\"}";
    writeLine(line);
}

void MirrorStream::onClientGone()
{
    cleanup();
}

// Idempotent: runs when the client goes away and again from the destructor.
void MirrorStream::cleanup()
{
    if (m_cleaned) {
        return;
    }
    m_cleaned = true;
    m_timer.stop();
    if (m_capture) {
        delete m_capture;
        m_capture = nullptr;
    }
    if (!m_capturePath.isEmpty()) {
        QFile::remove(m_capturePath);
        m_capturePath.clear();
    }
    QDir().rmdir(Paths::screenshotStagingDir()); // only if empty
    fprintf(stderr, "sailfish-devagent: mirror stopped\n");
}
