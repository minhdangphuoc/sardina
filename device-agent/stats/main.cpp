#include "modulehost.h"
#include "stats.h"
#include "statsmath.h"

#include <QCoreApplication>
#include <QLocalSocket>
#include <QPointer>

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    ModuleHost host("stats");
    const int code = host.init(app.arguments());
    if (code >= 0) {
        return code;
    }
    QPointer<StatsStream> stream;
    QObject::connect(&host, &ModuleHost::started, [&](const QJsonObject &control) {
        const QJsonObject request = control.value(QStringLiteral("request")).toObject();
        const QString exe = request.value(QStringLiteral("exe")).toString();
        if (!statsmath::validExe(exe.toStdString())) {
            host.replyAndFinish(QJsonObject{ { QStringLiteral("ok"), false }, { QStringLiteral("error"), QStringLiteral("invalid exe") } });
            return;
        }
        const int interval =
            statsmath::clampInterval(request.value(QStringLiteral("interval")).toInt(statsmath::INTERVAL_DEFAULT_MS));
        stream = new StatsStream(host.socket(), exe, interval, control.value(QStringLiteral("client")).toString());
        QObject::connect(stream.data(), &StatsStream::ended, &host, [&]() { host.finish(QStringLiteral("ended")); });
        if (host.socket()->state() != QLocalSocket::ConnectedState) {
            stream->endWithError(QStringLiteral("client gone"));
        }
    });
    QObject::connect(&host, &ModuleHost::endRequested, [&](const QString &reason) {
        if (stream) {
            stream->endWithError(reason);
        } else {
            host.finish(reason);
        }
    });
    return app.exec();
}
