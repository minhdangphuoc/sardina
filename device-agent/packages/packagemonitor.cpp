#include "packagemonitor.h"
#include "modulehost.h"

#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusReply>
#include <QJsonArray>
#include <QJsonDocument>
#include <QLocalSocket>
#include <QProcess>

namespace {

const char *const SERVICE = "org.freedesktop.PackageKit";
const char *const ROOT_PATH = "/org/freedesktop/PackageKit";
const char *const ROOT_INTERFACE = "org.freedesktop.PackageKit";
const char *const TRANSACTION_INTERFACE = "org.freedesktop.PackageKit.Transaction";
const int STALL_MS = 60 * 1000;

QString statusName(uint status)
{
    switch (status) {
    case 1:
        return QStringLiteral("waiting");
    case 2:
        return QStringLiteral("preparing");
    case 3:
        return QStringLiteral("running");
    case 4:
        return QStringLiteral("querying packages");
    case 6:
        return QStringLiteral("removing");
    case 7:
        return QStringLiteral("refreshing repositories");
    case 8:
        return QStringLiteral("downloading");
    case 9:
        return QStringLiteral("installing");
    case 10:
        return QStringLiteral("updating");
    case 11:
        return QStringLiteral("finishing");
    case 13:
        return QStringLiteral("resolving dependencies");
    case 14:
        return QStringLiteral("verifying packages");
    case 16:
        return QStringLiteral("committing changes");
    case 18:
        return QStringLiteral("finished");
    case 19:
        return QStringLiteral("cancelling");
    case 30:
        return QStringLiteral("waiting for the package lock");
    case 31:
        return QStringLiteral("waiting for authorization");
    default:
        return QStringLiteral("PackageKit status %1").arg(status);
    }
}

QString infoName(uint info)
{
    switch (info) {
    case 1:
        return QStringLiteral("installed");
    case 2:
        return QStringLiteral("available");
    case 10:
        return QStringLiteral("downloading");
    case 11:
        return QStringLiteral("updating");
    case 12:
        return QStringLiteral("installing");
    case 13:
        return QStringLiteral("removing");
    case 18:
        return QStringLiteral("finished");
    case 19:
        return QStringLiteral("reinstalling");
    case 21:
        return QStringLiteral("preparing");
    case 22:
        return QStringLiteral("decompressing");
    default:
        return QStringLiteral("processing");
    }
}

QString exitName(uint exit)
{
    switch (exit) {
    case 1:
        return QStringLiteral("succeeded");
    case 2:
        return QStringLiteral("failed");
    case 3:
        return QStringLiteral("was cancelled");
    case 6:
        return QStringLiteral("was killed");
    default:
        return QStringLiteral("ended with status %1").arg(exit);
    }
}

}

PackageMonitor::PackageMonitor(ModuleHost *host, const QStringList &packages, QObject *parent)
    : QObject(parent)
    , m_host(host)
{
    for (const QString &package : packages) {
        m_packages.insert(package);
    }
    m_stall.setSingleShot(true);
    m_stall.setInterval(STALL_MS);
    connect(&m_stall, &QTimer::timeout, this, &PackageMonitor::onStalled);
}

void PackageMonitor::start()
{
    QDBusConnection bus = QDBusConnection::systemBus();
    if (!bus.isConnected()
        || !bus.connect(QLatin1String(SERVICE), QLatin1String(ROOT_PATH), QLatin1String(ROOT_INTERFACE),
                        QStringLiteral("TransactionListChanged"), this,
                        SLOT(onTransactionListChanged(QStringList)))) {
        m_host->replyAndFinish(QJsonObject{ { QStringLiteral("ok"), false },
                                            { QStringLiteral("error"), QStringLiteral("PackageKit bus unavailable") } });
        return;
    }
    QDBusInterface control(QLatin1String(SERVICE), QLatin1String(ROOT_PATH), QLatin1String(ROOT_INTERFACE), bus);
    const QDBusReply<QList<QDBusObjectPath>> reply = control.call(QStringLiteral("GetTransactionList"));
    if (!reply.isValid()) {
        m_host->replyAndFinish(QJsonObject{ { QStringLiteral("ok"), false },
                                            { QStringLiteral("error"), QStringLiteral("PackageKit transaction list unavailable") } });
        return;
    }
    const QList<QDBusObjectPath> paths = reply.value();
    for (const QDBusObjectPath &path : paths) {
        m_baseline.insert(path.path());
    }
    send(QJsonObject{ { QStringLiteral("ok"), true }, { QStringLiteral("stream"), QStringLiteral("packages") },
                      { QStringLiteral("event"), QStringLiteral("ready") } });
    m_stall.start();
}

void PackageMonitor::onTransactionListChanged(const QStringList &paths)
{
    for (const QString &path : paths) {
        if (!m_baseline.contains(path) && !m_transactions.contains(path)) {
            attach(path);
        }
    }
}

void PackageMonitor::attach(const QString &path)
{
    m_transactions.insert(path);
    QDBusConnection bus = QDBusConnection::systemBus();
    bus.connect(QLatin1String(SERVICE), path, QLatin1String(TRANSACTION_INTERFACE), QStringLiteral("Package"), this,
                SLOT(onPackage(uint,QString,QString)));
    bus.connect(QLatin1String(SERVICE), path, QLatin1String(TRANSACTION_INTERFACE), QStringLiteral("ItemProgress"), this,
                SLOT(onItemProgress(QString,uint,uint)));
    bus.connect(QLatin1String(SERVICE), path, QLatin1String(TRANSACTION_INTERFACE), QStringLiteral("ErrorCode"), this,
                SLOT(onErrorCode(uint,QString)));
    bus.connect(QLatin1String(SERVICE), path, QLatin1String(TRANSACTION_INTERFACE), QStringLiteral("Finished"), this,
                SLOT(onFinished(uint,uint)));
    bus.connect(QLatin1String(SERVICE), path, QStringLiteral("org.freedesktop.DBus.Properties"),
                QStringLiteral("PropertiesChanged"), this, SLOT(onPropertiesChanged(QString,QVariantMap,QStringList)));
    activity();
    send(QJsonObject{ { QStringLiteral("event"), QStringLiteral("transaction") }, { QStringLiteral("path"), path } });
}

QString PackageMonitor::packageName(const QString &packageId) const
{
    return packageId.section(QLatin1Char(';'), 0, 0);
}

void PackageMonitor::onPackage(uint info, const QString &packageId, const QString &summary)
{
    const QString package = packageName(packageId);
    if (!m_packages.contains(package)) {
        return;
    }
    activity();
    send(QJsonObject{ { QStringLiteral("event"), QStringLiteral("package") }, { QStringLiteral("phase"), infoName(info) },
                      { QStringLiteral("package"), package }, { QStringLiteral("id"), packageId },
                      { QStringLiteral("summary"), summary } });
}

void PackageMonitor::onItemProgress(const QString &packageId, uint status, uint percentage)
{
    const QString package = packageName(packageId);
    if (!m_packages.contains(package)) {
        return;
    }
    activity();
    send(QJsonObject{ { QStringLiteral("event"), QStringLiteral("status") }, { QStringLiteral("phase"), statusName(status) },
                      { QStringLiteral("package"), package }, { QStringLiteral("percentage"), static_cast<int>(percentage) } });
}

void PackageMonitor::onErrorCode(uint code, const QString &details)
{
    activity();
    send(QJsonObject{ { QStringLiteral("event"), QStringLiteral("error") },
                      { QStringLiteral("code"), QString::number(code) },
                      { QStringLiteral("details"), details } });
}

void PackageMonitor::onFinished(uint exit, uint runtime)
{
    activity();
    QJsonObject event = installedState();
    event.insert(QStringLiteral("event"), QStringLiteral("finished"));
    event.insert(QStringLiteral("exit"), exitName(exit));
    event.insert(QStringLiteral("runtimeMs"), static_cast<int>(runtime));
    send(event);
}

void PackageMonitor::onPropertiesChanged(const QString &interface, const QVariantMap &changed, const QStringList &invalidated)
{
    Q_UNUSED(invalidated)
    if (interface != QLatin1String(TRANSACTION_INTERFACE)) {
        return;
    }
    QJsonObject event{ { QStringLiteral("event"), QStringLiteral("status") } };
    const QVariant statusValue = changed.value(QStringLiteral("Status"));
    const uint percentage = changed.value(QStringLiteral("Percentage"), 101).toUInt();
    const QString lastPackage = packageName(changed.value(QStringLiteral("LastPackage")).toString());
    if (statusValue.isValid()) {
        event.insert(QStringLiteral("phase"), statusName(statusValue.toUInt()));
    }
    if (percentage <= 100) {
        event.insert(QStringLiteral("percentage"), static_cast<int>(percentage));
    }
    if (m_packages.contains(lastPackage)) {
        event.insert(QStringLiteral("package"), lastPackage);
    }
    if (event.size() == 1) {
        return;
    }
    activity();
    send(event);
}

QJsonObject PackageMonitor::installedState() const
{
    QJsonArray installed;
    QJsonArray missing;
    for (const QString &package : m_packages) {
        const int code = QProcess::execute(QStringLiteral("/usr/bin/rpm"), QStringList() << QStringLiteral("-q") << package);
        (code == 0 ? installed : missing).append(package);
    }
    return QJsonObject{ { QStringLiteral("installed"), installed }, { QStringLiteral("missing"), missing } };
}

void PackageMonitor::onStalled()
{
    QJsonObject event = installedState();
    event.insert(QStringLiteral("event"), QStringLiteral("stalled"));
    event.insert(QStringLiteral("seconds"), STALL_MS / 1000);
    send(event);
    m_stall.start();
}

void PackageMonitor::activity()
{
    m_stall.start();
}

void PackageMonitor::send(const QJsonObject &event)
{
    QLocalSocket *socket = m_host->socket();
    if (!socket || socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    socket->write(QJsonDocument(event).toJson(QJsonDocument::Compact));
    socket->write("\n");
    socket->flush();
}
