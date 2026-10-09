#ifndef PHONESETTINGS_H
#define PHONESETTINGS_H

#include <QJsonObject>
#include <QJsonValue>
#include <QString>

// A module's copy of the phone's settings: the snapshot from the daemon's first control line, then
// each {"setting":{...}} change. Read-only for the module; the daemon's Settings owns the file.
class PhoneSettings
{
public:
    void reset(const QJsonObject &snapshot) { m_values = snapshot; }
    void set(const QString &key, const QJsonValue &value) { m_values.insert(key, value); }

    bool screenView() const { return flag("screenView", true); }
    bool control() const { return flag("control", true); }
    bool logs() const { return flag("logs", true); }
    bool touchIndicator() const { return flag("touchIndicator", false); }
    bool idleMode() const { return flag("idleMode", true); }
    int maxFps() const { return m_values.value(QStringLiteral("maxFps")).toInt(30) == 60 ? 60 : 30; }

private:
    bool flag(const char *key, bool fallback) const { return m_values.value(QLatin1String(key)).toBool(fallback); }

    QJsonObject m_values;
};

#endif
