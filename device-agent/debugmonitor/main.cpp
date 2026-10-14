#include "debugmonitor.h"
#include "keepalivelease.h"
#include "modulehost.h"

#include <QCoreApplication>
#include <QLocalSocket>
#include <QRegularExpression>

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    ModuleHost host("debugmonitor");
    const int code = host.init(app.arguments());
    if (code >= 0) return code;
    QObject::connect(&host, &ModuleHost::started, [&](const QJsonObject &control) {
        const QJsonObject request = control.value(QStringLiteral("request")).toObject();
        const QString exe = request.value(QStringLiteral("exe")).toString();
        const QString mode = request.value(QStringLiteral("mode")).toString();
        const int port = request.value(QStringLiteral("port")).toInt();
        const QRegularExpression allowed(QStringLiteral("^/usr/bin/[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$"));
        if (!allowed.match(exe).hasMatch() || exe.contains(QStringLiteral(".."))
            || (mode != QLatin1String("qml") && mode != QLatin1String("cpp")) || port < 1024 || port > 65535) {
            host.replyAndFinish(QJsonObject{ { QStringLiteral("ok"), false }, { QStringLiteral("error"), QStringLiteral("invalid debugger monitor request") } });
            return;
        }
        // Mandatory bounded lease, renewed by the authenticated request client every ten seconds.
        const int seconds = qBound(10, request.value(QStringLiteral("lease")).toInt(30), 60);
        KeepaliveLease *lease = new KeepaliveLease(host.socket(), seconds, &host);
        QObject::connect(lease, &KeepaliveLease::expired, &host, [&]() { host.finish(QStringLiteral("lease expired")); });
        QObject::connect(host.socket(), &QLocalSocket::disconnected, &host, [&]() { host.finish(QStringLiteral("client gone")); });
        DebugMonitor *monitor = new DebugMonitor(&host, exe, mode, port);
        QObject::connect(lease, &KeepaliveLease::message, monitor, &DebugMonitor::confirmOwner);
        monitor->start();
    });
    QObject::connect(&host, &ModuleHost::endRequested, &host, [&](const QString &reason) { host.finish(reason); });
    return app.exec();
}
