#include "paths.h"

#include <QDir>
#include <QFile>
#include <pwd.h>
#include <unistd.h>

namespace Paths {

QString userRuntimeDir()
{
    return QStringLiteral("/run/user/%1").arg(static_cast<qulonglong>(getuid()));
}

QString agentRuntimeDir()
{
    return userRuntimeDir() + QStringLiteral("/sailfish-devagent");
}

QString screenshotStagingDir()
{
    const struct passwd *pw = getpwuid(getuid());
    const QString home = pw && pw->pw_dir ? QString::fromLocal8Bit(pw->pw_dir) : QDir::homePath();
    return home + QStringLiteral("/sailfish-devagent");
}

QString socketPath()
{
    return agentRuntimeDir() + QStringLiteral("/agent.sock");
}

QString sessionBusAddress()
{
    return QStringLiteral("unix:path=") + userRuntimeDir() + QStringLiteral("/dbus/user_bus_socket");
}

QString settingsPath()
{
    return QStringLiteral("/var/lib/sailfish-devagent/settings.json");
}

bool lipstickWritesJpeg()
{
    return false;
}

bool developerModeOn()
{
    return QFile::exists(QStringLiteral("/usr/bin/devel-su"));
}

}
