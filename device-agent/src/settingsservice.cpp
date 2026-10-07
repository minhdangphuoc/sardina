#include "settingsservice.h"
#include "agent.h"
#include "paths.h"
#include "settings.h"

#include <QDBusConnectionInterface>
#include <QDBusError>
#include <QDBusMessage>
#include <QDBusReply>
#include <QJsonDocument>
#include <QJsonObject>
#include <QFile>
#include <cstdio>
#include <grp.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {

const char *const SERVICE_NAME = "io.github.minhdangphuoc.SailfishDevAgent";
const char *const OBJECT_PATH = "/io/github/minhdangphuoc/SailfishDevAgent";
const char *const CONNECTION_NAME = "devagent-service";
const int RETRY_MS = 5000;
const int WATCH_MS = 30000;

QDBusConnection serviceBus()
{
    return QDBusConnection::connectToBus(Paths::sessionBusAddress(), QLatin1String(CONNECTION_NAME));
}

}

SettingsService::SettingsService(Settings *settings, Agent *agent, QObject *parent)
    : QObject(parent)
    , m_settings(settings)
    , m_agent(agent)
    , m_registered(false)
    , m_started(false)
    , m_privilegedGid(0)
    , m_haveGroup(false)
{
    // Resolved once: if the group does not exist, every change is refused.
    if (const struct group *gr = getgrnam("privileged")) {
        m_privilegedGid = gr->gr_gid;
        m_haveGroup = true;
    } else {
        fprintf(stderr, "sailfish-devagent: settings: no \"privileged\" group, every change will be refused\n");
    }
    m_retry.setSingleShot(true);
    m_retry.setInterval(RETRY_MS);
    connect(&m_retry, &QTimer::timeout, this, &SettingsService::tryRegister);
    m_watch.setInterval(WATCH_MS);
    connect(&m_watch, &QTimer::timeout, this, &SettingsService::checkBus);
}

void SettingsService::start()
{
    if (m_started) {
        return;
    }
    m_started = true;
    m_watch.start();
    tryRegister();
}

void SettingsService::stop()
{
    m_started = false;
    m_retry.stop();
    m_watch.stop();
    if (m_registered) {
        QDBusConnection bus = serviceBus();
        bus.unregisterService(QLatin1String(SERVICE_NAME));
        bus.unregisterObject(QLatin1String(OBJECT_PATH));
        m_registered = false;
    }
    QDBusConnection::disconnectFromBus(QLatin1String(CONNECTION_NAME));
}

void SettingsService::tryRegister()
{
    if (!m_started || m_registered) {
        return;
    }
    QDBusConnection bus = serviceBus();
    if (!bus.isConnected()) {
        QDBusConnection::disconnectFromBus(QLatin1String(CONNECTION_NAME));
        fprintf(stderr, "sailfish-devagent: settings service: session bus not available, retrying\n");
        m_retry.start();
        return;
    }
    bus.unregisterObject(QLatin1String(OBJECT_PATH));
    if (!bus.registerObject(QLatin1String(OBJECT_PATH), this,
                            QDBusConnection::ExportScriptableSlots | QDBusConnection::ExportScriptableSignals)) {
        fprintf(stderr, "sailfish-devagent: settings service: cannot register %s, retrying\n", OBJECT_PATH);
        m_retry.start();
        return;
    }
    if (!bus.registerService(QLatin1String(SERVICE_NAME))) {
        bus.unregisterObject(QLatin1String(OBJECT_PATH));
        fprintf(stderr, "sailfish-devagent: settings service: cannot own %s (%s), retrying\n", SERVICE_NAME,
                qPrintable(bus.lastError().message()));
        m_retry.start();
        return;
    }
    m_registered = true;
    fprintf(stderr, "sailfish-devagent: settings service: %s on the session bus\n", SERVICE_NAME);
}

// After a restart of the session bus the old connection is dead: drop it and register again.
void SettingsService::checkBus()
{
    if (!m_started || !m_registered) {
        return;
    }
    if (serviceBus().isConnected()) {
        return;
    }
    fprintf(stderr, "sailfish-devagent: settings service: session bus lost, registering again\n");
    m_registered = false;
    QDBusConnection::disconnectFromBus(QLatin1String(CONNECTION_NAME));
    tryRegister();
}

void SettingsService::notifyChanged(const QString &key)
{
    if (m_registered) {
        emit Changed(key);
        emit ChangedJson(key, GetStatusJson());
    }
}

bool SettingsService::privilegedCaller(uint *pid)
{
    *pid = 0;
    if (!calledFromDBus()) {
        return false;
    }
    const QString sender = message().service();
    bool ok = false;
    if (m_haveGroup && connection().interface()) {
        const QDBusReply<uint> reply = connection().interface()->servicePid(sender);
        if (reply.isValid() && reply.value() > 0) {
            *pid = reply.value();
            struct stat st;
            const QByteArray proc = "/proc/" + QByteArray::number(*pid);
            ok = stat(proc.constData(), &st) == 0 && st.st_uid == getuid() && st.st_gid == m_privilegedGid;
        }
    }
    if (!ok) {
        fprintf(stderr, "sailfish-devagent: settings: refused %s from pid %u (%s): caller is not in the privileged group\n",
                qPrintable(message().member()), *pid, qPrintable(sender));
        sendErrorReply(QDBusError::AccessDenied, QStringLiteral("caller is not in the privileged group"));
    }
    return ok;
}

QVariantMap SettingsService::GetStatus()
{
    return m_agent->statusMap();
}

QString SettingsService::GetStatusJson()
{
    return QString::fromUtf8(QJsonDocument(QJsonObject::fromVariantMap(m_agent->statusMap())).toJson(QJsonDocument::Compact));
}

bool SettingsService::SetBool(const QString &key, bool value)
{
    uint pid = 0;
    if (!privilegedCaller(&pid)) {
        return false;
    }
    QString error;
    // Logged before the change is applied, so the journal reads in order.
    if (!m_settings->toMap().contains(key) || key == QLatin1String("indicator")) {
        sendErrorReply(QDBusError::InvalidArgs, QStringLiteral("unknown boolean setting"));
        return false;
    }
    fprintf(stderr, "sailfish-devagent: settings: %s = %s (from pid %u)\n", qPrintable(key), value ? "true" : "false",
            pid);
    if (!m_settings->setBool(key, value, &error)) {
        sendErrorReply(QDBusError::InvalidArgs, error);
        return false;
    }
    return true;
}

bool SettingsService::SetString(const QString &key, const QString &value)
{
    uint pid = 0;
    if (!privilegedCaller(&pid)) {
        return false;
    }
    QString error;
    if (key != QLatin1String("indicator")
        || (value != QLatin1String("normal") && value != QLatin1String("quiet") && value != QLatin1String("minimal"))) {
        sendErrorReply(QDBusError::InvalidArgs, QStringLiteral("only indicator = normal, quiet or minimal"));
        return false;
    }
    fprintf(stderr, "sailfish-devagent: settings: %s = %s (from pid %u)\n", qPrintable(key), qPrintable(value), pid);
    if (!m_settings->setString(key, value, &error)) {
        sendErrorReply(QDBusError::InvalidArgs, error);
        return false;
    }
    return true;
}

int SettingsService::StopSessions()
{
    uint pid = 0;
    if (!privilegedCaller(&pid)) {
        return 0;
    }
    const int stopped = m_agent->stopSessions();
    fprintf(stderr, "sailfish-devagent: settings: stopped %d session(s) (from pid %u)\n", stopped, pid);
    return stopped;
}
