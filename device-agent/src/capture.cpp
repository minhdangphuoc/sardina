#include "capture.h"
#include "paths.h"

#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusMessage>
#include <QDir>
#include <QFile>
#include <QFileInfo>

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

    // A fresh connection per request: the session bus may not have existed when the daemon started.
    QDBusConnection bus = QDBusConnection::connectToBus(Paths::sessionBusAddress(), QLatin1String(BUS_NAME));
    if (!bus.isConnected()) {
        QDBusConnection::disconnectFromBus(QLatin1String(BUS_NAME));
        fail(QStringLiteral("session bus not available: ") + bus.lastError().message());
        return;
    }
    QDBusInterface lipstick(QStringLiteral("org.nemomobile.lipstick"),
                            QStringLiteral("/org/nemomobile/lipstick/screenshot"),
                            QStringLiteral("org.nemomobile.lipstick"), bus);
    const QDBusMessage result = lipstick.call(QStringLiteral("saveScreenshot"), m_stagingPath);
    QDBusConnection::disconnectFromBus(QLatin1String(BUS_NAME));
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
