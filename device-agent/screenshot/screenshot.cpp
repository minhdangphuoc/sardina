#include "screenshot.h"
#include "paths.h"
#include "capture.h"

#include <QDateTime>
#include <QDir>
#include <QFile>

namespace {

const int CAPTURE_TIMEOUT_MS = 10000;

}

Screenshot::Screenshot(QObject *parent)
    : QObject(parent)
{
}

void Screenshot::take()
{
    const QString name = QStringLiteral("shot-%1.png").arg(QDateTime::currentMSecsSinceEpoch());
    m_path = Paths::agentRuntimeDir() + QLatin1Char('/') + name;
    m_stagingPath = Paths::screenshotStagingDir() + QLatin1Char('/') + name;

    Capture *capture = new Capture(m_stagingPath, CAPTURE_TIMEOUT_MS, this);
    connect(capture, &Capture::finished, this, &Screenshot::onCaptured);
    capture->start();
}

void Screenshot::onCaptured(const QString &error)
{
    if (!error.isEmpty()) {
        fail(error);
        return;
    }
    // Different filesystems (home vs tmpfs): QFile::rename falls back to copy + remove.
    QFile::remove(m_path);
    if (!QFile::rename(m_stagingPath, m_path)) {
        QFile::remove(m_stagingPath);
        fail(QStringLiteral("cannot move the screenshot to ") + m_path);
        return;
    }
    QDir().rmdir(Paths::screenshotStagingDir()); // only if empty (another shot may be pending)
    QJsonObject o;
    o.insert(QStringLiteral("ok"), true);
    o.insert(QStringLiteral("path"), m_path);
    emit finished(o);
}

void Screenshot::fail(const QString &message)
{
    QDir().rmdir(Paths::screenshotStagingDir()); // only if empty
    QJsonObject o;
    o.insert(QStringLiteral("ok"), false);
    o.insert(QStringLiteral("error"), message);
    emit finished(o);
}
