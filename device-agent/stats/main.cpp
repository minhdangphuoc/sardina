#include "keepalivelease.h"
#include "modulehost.h"
#include "streamlimits.h"
#include "stats.h"
#include "statsmath.h"

#include <QCoreApplication>
#include <QLocalSocket>
#include <QPointer>

namespace {

// The opt-in keepalive lease (agent 1.11.0): the stream ends when the client stops renewing it.
void addLease(const QJsonObject &request, QLocalSocket *socket, StatsStream *stream)
{
    const QJsonValue requested = request.value(QStringLiteral("lease"));
    const int seconds = streamLeaseSeconds(requested.isDouble(), requested.toDouble());
    if (seconds > 0) {
        KeepaliveLease *lease = new KeepaliveLease(socket, seconds, stream);
        QObject::connect(lease, &KeepaliveLease::expired, stream, [stream]() { stream->endWithError(QStringLiteral("lease expired")); });
    }
}

}

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
        addLease(request, host.socket(), stream.data());
        QObject::connect(stream.data(), &StatsStream::ended, &host, [&]() { host.finish(QStringLiteral("ended")); });
        if (host.socket()->state() != QLocalSocket::ConnectedState) {
            stream->endWithError(QStringLiteral("client gone"));
        }
        if (!stream->active()) {
            host.finish(QStringLiteral("client gone")); // it ended before the connection above
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
