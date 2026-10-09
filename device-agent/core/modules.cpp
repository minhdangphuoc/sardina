#include "modules.h"
#include "childlink.h"
#include "paths.h"

#include <QDateTime>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>

namespace {

const ModuleSpec MODULES[] = {
    { "logs", "logs", "logs" },
    { "stats", "stats", nullptr }, // Developer Mode only: /proc is readable over the SSH login
    { "screenshot", "screenshot", "screenView" },
    { "mirror", "mirror", "screenView" },
    { "input", nullptr, nullptr },
};

const int KEYPAD_PROBE_MS = 2000;

}

namespace Modules {

const ModuleSpec *forCommand(const QString &command)
{
    for (const ModuleSpec &spec : MODULES) {
        if (spec.command && command == QLatin1String(spec.command)) {
            return &spec;
        }
    }
    return nullptr;
}

QString executable(const QString &name)
{
    return Paths::moduleDir() + QStringLiteral("/sailfish-devagent-") + name;
}

bool installed(const QString &name)
{
    if (name == QLatin1String("input")) {
        return installed(QStringLiteral("mirror")); // still inside the mirror process
    }
    const QFileInfo info(executable(name));
    return info.isFile() && info.isExecutable();
}

QStringList installedNames()
{
    QStringList names;
    for (const ModuleSpec &spec : MODULES) {
        if (installed(QLatin1String(spec.name))) {
            names << QLatin1String(spec.name);
        }
    }
    return names;
}

QJsonObject keypadInfo()
{
    static QDateTime probedVersion;
    static QJsonObject cached;
    const QFileInfo info(executable(QStringLiteral("mirror")));
    if (!info.isFile() || !info.isExecutable()) {
        return QJsonObject();
    }
    if (info.lastModified() == probedVersion) {
        return cached;
    }
    probedVersion = info.lastModified();
    cached = QJsonObject();
    QByteArray out;
    if (ChildLink::capture(info.filePath().toLocal8Bit(), QList<QByteArray>() << QByteArrayLiteral("--keypad"),
                           KEYPAD_PROBE_MS, &out)) {
        const QJsonDocument doc = QJsonDocument::fromJson(out.trimmed());
        if (doc.isObject()) {
            cached = doc.object();
        }
    }
    return cached;
}

}
