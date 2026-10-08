#include "settings.h"
#include "paths.h"

#include <QByteArray>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QStringList>
#include <QTemporaryFile>
#include <cstdio>
#include <sys/stat.h>
#include <unistd.h>

namespace {

const int FILE_VERSION = 1;
const qint64 FILE_MAX_BYTES = 4096;

const char *const KEY_SCREEN_VIEW = "screenView";
const char *const KEY_CONTROL = "control";
const char *const KEY_LOGS = "logs";
const char *const KEY_TOUCH = "touchIndicator";
const char *const KEY_MUTE = "muteNotifications";
const char *const KEY_IDLE_MODE = "idleMode";
const char *const KEY_INDICATOR = "indicator";

bool indicatorFromName(const QString &name, IndicatorLevel *level)
{
    if (name == QLatin1String("normal")) {
        *level = IndicatorLevel::Normal;
    } else if (name == QLatin1String("quiet")) {
        *level = IndicatorLevel::Quiet;
    } else if (name == QLatin1String("minimal")) {
        *level = IndicatorLevel::Minimal;
    } else {
        return false;
    }
    return true;
}

void ignored(const QString &reason)
{
    fprintf(stderr, "sailfish-devagent: settings: %s ignored: %s\n", qPrintable(Paths::settingsPath()),
            qPrintable(reason));
}

}

Settings::Settings(QObject *parent)
    : QObject(parent)
    , m_screenView(true)
    , m_control(true)
    , m_logs(true)
    , m_touchIndicator(false)
    , m_muteNotifications(false)
    , m_idleMode(true)
    , m_indicator(IndicatorLevel::Normal)
{
}

QString Settings::indicatorName(IndicatorLevel level)
{
    switch (level) {
    case IndicatorLevel::Quiet:
        return QStringLiteral("quiet");
    case IndicatorLevel::Minimal:
        return QStringLiteral("minimal");
    case IndicatorLevel::Normal:
        break;
    }
    return QStringLiteral("normal");
}

bool Settings::load()
{
    QFile file(Paths::settingsPath());
    if (!file.exists()) {
        fprintf(stderr, "sailfish-devagent: settings: defaults (no %s)\n", qPrintable(file.fileName()));
        return false;
    }
    if (!file.open(QIODevice::ReadOnly)) {
        ignored(file.errorString());
        return false;
    }
    if (file.size() > FILE_MAX_BYTES) {
        ignored(QStringLiteral("larger than %1 bytes").arg(FILE_MAX_BYTES));
        return false;
    }
    const QByteArray data = file.read(FILE_MAX_BYTES + 1);
    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(data, &parseError);
    if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
        ignored(QStringLiteral("not a JSON object"));
        return false;
    }
    const QJsonObject o = doc.object();
    const QJsonValue version = o.value(QStringLiteral("version"));
    if (!version.isDouble() || version.toDouble() != FILE_VERSION) {
        ignored(QStringLiteral("unknown version"));
        return false;
    }
    bool clean = true;
    struct BoolKey {
        const char *key;
        bool *value;
    };
    const BoolKey bools[] = { { KEY_SCREEN_VIEW, &m_screenView }, { KEY_CONTROL, &m_control },
                              { KEY_LOGS, &m_logs },              { KEY_TOUCH, &m_touchIndicator },
                              { KEY_MUTE, &m_muteNotifications },
                              { KEY_IDLE_MODE, &m_idleMode } };
    for (const BoolKey &b : bools) {
        const QJsonValue v = o.value(QLatin1String(b.key));
        if (v.isUndefined()) {
            continue;
        }
        if (!v.isBool()) {
            ignored(QStringLiteral("\"%1\" is not a boolean").arg(QLatin1String(b.key)));
            clean = false;
            continue;
        }
        *b.value = v.toBool();
    }
    const QJsonValue level = o.value(QLatin1String(KEY_INDICATOR));
    if (!level.isUndefined()) {
        IndicatorLevel parsed;
        if (level.isString() && indicatorFromName(level.toString(), &parsed)) {
            m_indicator = parsed;
        } else {
            ignored(QStringLiteral("\"indicator\" is not normal, quiet or minimal"));
            clean = false;
        }
    }
    fprintf(stderr,
            "sailfish-devagent: settings: screenView %d, control %d, logs %d, indicator %s, "
            "muteNotifications %d, touchIndicator %d, idleMode %d\n",
            m_screenView, m_control, m_logs, qPrintable(indicatorName(m_indicator)), m_muteNotifications,
            m_touchIndicator, m_idleMode);
    return clean;
}

bool Settings::setBool(const QString &key, bool value, QString *error)
{
    bool *target = nullptr;
    if (key == QLatin1String(KEY_SCREEN_VIEW)) {
        target = &m_screenView;
    } else if (key == QLatin1String(KEY_CONTROL)) {
        target = &m_control;
    } else if (key == QLatin1String(KEY_LOGS)) {
        target = &m_logs;
    } else if (key == QLatin1String(KEY_TOUCH)) {
        target = &m_touchIndicator;
    } else if (key == QLatin1String(KEY_MUTE)) {
        target = &m_muteNotifications;
    } else if (key == QLatin1String(KEY_IDLE_MODE)) {
        target = &m_idleMode;
    }
    if (!target) {
        if (error) {
            *error = QStringLiteral("unknown boolean setting");
        }
        return false;
    }
    if (*target == value) {
        return true;
    }
    *target = value;
    QString saveError;
    if (!save(&saveError)) {
        fprintf(stderr, "sailfish-devagent: settings: cannot save %s: %s (the change applies until a restart)\n",
                qPrintable(Paths::settingsPath()), qPrintable(saveError));
    }
    emit changed(key);
    return true;
}

bool Settings::setString(const QString &key, const QString &value, QString *error)
{
    IndicatorLevel level;
    if (key != QLatin1String(KEY_INDICATOR)) {
        if (error) {
            *error = QStringLiteral("unknown string setting");
        }
        return false;
    }
    if (!indicatorFromName(value, &level)) {
        if (error) {
            *error = QStringLiteral("indicator must be normal, quiet or minimal");
        }
        return false;
    }
    if (level == m_indicator) {
        return true;
    }
    m_indicator = level;
    QString saveError;
    if (!save(&saveError)) {
        fprintf(stderr, "sailfish-devagent: settings: cannot save %s: %s (the change applies until a restart)\n",
                qPrintable(Paths::settingsPath()), qPrintable(saveError));
    }
    emit changed(key);
    return true;
}

QVariantMap Settings::toMap() const
{
    QVariantMap m;
    m.insert(QLatin1String(KEY_SCREEN_VIEW), m_screenView);
    m.insert(QLatin1String(KEY_CONTROL), m_control);
    m.insert(QLatin1String(KEY_LOGS), m_logs);
    m.insert(QLatin1String(KEY_INDICATOR), indicatorName(m_indicator));
    m.insert(QLatin1String(KEY_MUTE), m_muteNotifications);
    m.insert(QLatin1String(KEY_TOUCH), m_touchIndicator);
    m.insert(QLatin1String(KEY_IDLE_MODE), m_idleMode);
    return m;
}

// The whole file through a temporary file in the same directory, mode 0660, then rename, so a
// crash leaves either the old or the new file. The group is the agent's effective group
// (privileged); the directory is not setgid.
bool Settings::save(QString *error) const
{
    const QString path = Paths::settingsPath();
    QJsonObject o;
    o.insert(QStringLiteral("version"), FILE_VERSION);
    const QVariantMap m = toMap();
    for (auto it = m.constBegin(); it != m.constEnd(); ++it) {
        o.insert(it.key(), QJsonValue::fromVariant(it.value()));
    }
    QByteArray data = QJsonDocument(o).toJson(QJsonDocument::Compact);
    data += '\n';

    QTemporaryFile tmp(path + QStringLiteral(".XXXXXX"));
    tmp.setAutoRemove(true);
    if (!tmp.open()) {
        *error = tmp.errorString();
        return false;
    }
    if (fchmod(tmp.handle(), 0660) != 0 || tmp.write(data) != data.size() || !tmp.flush()
        || fsync(tmp.handle()) != 0) {
        *error = QStringLiteral("cannot write %1").arg(tmp.fileName());
        return false;
    }
    const QString tmpName = tmp.fileName();
    tmp.close();
    if (::rename(QFile::encodeName(tmpName).constData(), QFile::encodeName(path).constData()) != 0) {
        *error = QStringLiteral("cannot rename %1").arg(tmpName);
        return false;
    }
    tmp.setAutoRemove(false); // renamed: nothing left to remove
    return true;
}
