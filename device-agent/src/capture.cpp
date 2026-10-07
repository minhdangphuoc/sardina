#include "capture.h"
#include "paths.h"

#include <QDBusConnection>
#include <QDBusMessage>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QVariantList>

namespace {

const int POLL_MS = 100;
const char *BUS_NAME = "devagent-screenshot";

}

Capture::Capture(const QString &stagingPath, int timeoutMs, QObject *parent)
    : QObject(parent)
    , m_stagingPath(stagingPath)
    , m_polls(0)
    , m_pollMax(timeoutMs / POLL_MS > 0 ? timeoutMs / POLL_MS : 1)
    , m_lastSize(-1)
{
    m_poll.setInterval(POLL_MS);
    connect(&m_poll, &QTimer::timeout, this, &Capture::poll);
}

void Capture::start()
{
    const QString staging = Paths::screenshotStagingDir();
    if (!QDir().mkpath(staging)) {
        fail(QStringLiteral("cannot create ") + staging);
        return;
    }
    QFile::setPermissions(staging, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);

    // One named connection, made on first use and kept: the session bus may not have existed when
    // the daemon started, and a connection per capture leaked memory in Qt (about 6 KB a frame).
    QDBusConnection bus = QDBusConnection::connectToBus(Paths::sessionBusAddress(), QLatin1String(BUS_NAME));
    if (!bus.isConnected()) {
        QDBusConnection::disconnectFromBus(QLatin1String(BUS_NAME));
        fail(QStringLiteral("session bus not available: ") + bus.lastError().message());
        return;
    }
    QDBusMessage call = QDBusMessage::createMethodCall(QStringLiteral("org.nemomobile.lipstick"),
                                                       QStringLiteral("/org/nemomobile/lipstick/screenshot"),
                                                       QStringLiteral("org.nemomobile.lipstick"),
                                                       QStringLiteral("saveScreenshot"));
    call.setArguments(QVariantList() << m_stagingPath);
    const QDBusMessage result = bus.call(call);
    if (!bus.isConnected()) {
        QDBusConnection::disconnectFromBus(QLatin1String(BUS_NAME)); // the bus went away: reconnect next time
    }
    if (result.type() == QDBusMessage::ErrorMessage) {
        fail(QStringLiteral("lipstick refused: ") + result.errorName() + QStringLiteral(": ") + result.errorMessage());
        return;
    }
    m_poll.start();
}

// The file is done once it exists, is not empty and its size stopped changing.
void Capture::poll()
{
    QFileInfo info(m_stagingPath);
    info.refresh();
    if (info.exists() && info.size() > 0 && info.size() == m_lastSize) {
        m_poll.stop();
        emit finished(QString());
        return;
    }
    m_lastSize = info.exists() ? info.size() : -1;
    if (++m_polls >= m_pollMax) {
        m_poll.stop();
        QFile::remove(m_stagingPath);
        fail(QStringLiteral("lipstick did not write the screenshot (is the screen on?)"));
    }
}

void Capture::fail(const QString &message)
{
    QDir().rmdir(Paths::screenshotStagingDir()); // only if empty
    emit finished(message);
}
