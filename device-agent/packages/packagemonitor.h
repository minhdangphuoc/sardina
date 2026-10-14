#ifndef PACKAGEMONITOR_H
#define PACKAGEMONITOR_H

#include <QDBusContext>
#include <QDBusObjectPath>
#include <QJsonObject>
#include <QObject>
#include <QSet>
#include <QStringList>
#include <QTimer>

class ModuleHost;

// A read-only observer for the PackageKit transaction started by the extension. The module starts
// before pkcon, takes the current transactions as its baseline, then follows only new transactions.
class PackageMonitor : public QObject, protected QDBusContext
{
    Q_OBJECT
public:
    PackageMonitor(ModuleHost *host, const QStringList &packages, QObject *parent = nullptr);
    void start();

private slots:
    void onTransactionListChanged(const QStringList &paths);
    void onPackage(uint info, const QString &packageId, const QString &summary);
    void onItemProgress(const QString &packageId, uint status, uint percentage);
    void onErrorCode(uint code, const QString &details);
    void onFinished(uint exit, uint runtime);
    void onPropertiesChanged(const QString &interface, const QVariantMap &changed, const QStringList &invalidated);
    void onStalled();

private:
    void attach(const QString &path);
    void send(const QJsonObject &event);
    void activity();
    QString packageName(const QString &packageId) const;
    QJsonObject installedState() const;

    ModuleHost *m_host;
    QSet<QString> m_packages;
    QSet<QString> m_baseline;
    QSet<QString> m_transactions;
    QTimer m_stall;
};

#endif
