#include "keepalivelease.h"
#include "modulehost.h"
#include "packagemonitor.h"

#include <QCoreApplication>
#include <QJsonArray>
#include <QLocalSocket>
#include <QPointer>
#include <QSet>

namespace {

const QSet<QString> ALLOWED_PACKAGES{ QStringLiteral("rsync"), QStringLiteral("sdk-deploy-rpm"),
                                      QStringLiteral("gdb-gdbserver"),
                                      QStringLiteral("qt5-qtdeclarative-plugin-qmlinspector") };

}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    ModuleHost host("packages");
    const int code = host.init(app.arguments());
    if (code >= 0) {
        return code;
    }
    QPointer<PackageMonitor> monitor;
    QObject::connect(&host, &ModuleHost::started, [&](const QJsonObject &control) {
        const QJsonArray requested = control.value(QStringLiteral("request")).toObject().value(QStringLiteral("packages")).toArray();
        QStringList packages;
        for (const QJsonValue &value : requested) {
            const QString package = value.toString();
            if (!ALLOWED_PACKAGES.contains(package) || packages.contains(package)) {
                host.replyAndFinish(QJsonObject{ { QStringLiteral("ok"), false },
                                                  { QStringLiteral("error"), QStringLiteral("invalid package") } });
                return;
            }
            packages << package;
        }
        if (packages.isEmpty()) {
            host.replyAndFinish(QJsonObject{ { QStringLiteral("ok"), false },
                                              { QStringLiteral("error"), QStringLiteral("no packages") } });
            return;
        }
        // This read-only stream still needs the same bounded client lease as other agent streams.
        const int seconds = qBound(10, control.value(QStringLiteral("request")).toObject().value(QStringLiteral("lease")).toInt(30), 60);
        KeepaliveLease *lease = new KeepaliveLease(host.socket(), seconds, &host);
        QObject::connect(lease, &KeepaliveLease::expired, &host, [&]() { host.finish(QStringLiteral("lease expired")); });
        monitor = new PackageMonitor(&host, packages, &host);
        QObject::connect(host.socket(), &QLocalSocket::disconnected, &host, [&]() { host.finish(QStringLiteral("client gone")); });
        monitor->start();
    });
    QObject::connect(&host, &ModuleHost::endRequested, [&](const QString &reason) { host.finish(reason); });
    return app.exec();
}
