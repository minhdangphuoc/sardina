#include "logs.h"
#include "modulehost.h"

#include <QCoreApplication>
#include <QLocalSocket>
#include <QPointer>

namespace {

const int DEFAULT_LINES = 100;
const int MAX_LINES = 10000;

// Streams raw journal lines until the client goes away. "format":"json" (agent 1.10.0) is opt-in;
// anything else is text, byte for byte as before.
LogStream *startStream(ModuleHost &host, const QJsonObject &control)
{
    const QJsonObject request = control.value(QStringLiteral("request")).toObject();
    const int lines = qBound(1, request.value(QStringLiteral("lines")).toInt(DEFAULT_LINES), MAX_LINES);
    const bool json = request.value(QStringLiteral("format")).toString() == QLatin1String("json");
    const QString after = request.value(QStringLiteral("after")).toString();
    if (json) {
        LogStream::probeOutputFields();
    }
    return new LogStream(host.socket(), lines, control.value(QStringLiteral("client")).toString(), json,
                         json && LogStream::validCursor(after) ? after : QString());
}

}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    ModuleHost host("logs");
    const int code = host.init(app.arguments());
    if (code >= 0) {
        return code;
    }
    QPointer<LogStream> stream;
    QObject::connect(&host, &ModuleHost::started, [&](const QJsonObject &control) {
        stream = startStream(host, control);
        QObject::connect(stream.data(), &LogStream::ended, &host, [&]() { host.finish(QStringLiteral("ended")); });
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
