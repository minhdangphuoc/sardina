#include "idleplan.h"
#include "indicatorlink.h"
#include "mirror.h"
#include "modulehost.h"
#include "phonesettings.h"

#include <QCoreApplication>
#include <QDateTime>
#include <QLocalSocket>
#include <QPointer>

namespace {

const int DEFAULT_FPS = 4;
const int DEFAULT_WIDTH = 360;
const int DEFAULT_QUALITY = 60;
const int MAX_WIDTH = 2160;
const int MIN_WIDTH = 90;
const int DEFAULT_WINDOW = 2;
const int DEFAULT_LEASE = 60;
const int MIN_LEASE = 10;
const int MAX_LEASE = 300;
// VP8 video (1.6.0): up to 30 fps (60 since 1.10.7, capped by the phone's frame rate limit), a
// target bitrate in kbit/s, and a deeper ack window (about 130 ms, 4 frames at 30 fps and 8 above),
// since frames are small and come often.
const int MAX_FPS = 10;
const int VIDEO_DEFAULT_FPS = 30;
const int VIDEO_DEFAULT_BITRATE = 2000;
const int VIDEO_MIN_BITRATE = 100;
const int VIDEO_MAX_BITRATE = 20000;
const int VIDEO_WINDOW = 4;
const int VIDEO_FAST_WINDOW = 8; // above 30 fps: the same 133 ms in flight as 4 frames at 30

// The lease is always on for binary and VP8 streams, which travel over the SSH forward: a missing or
// non-positive value gets the default. A text stream has one when it asks: "lease":0 (or less) or no
// field means none, a value that is not a number means the default.
int lease(const QJsonValue &requested, bool required)
{
    if (requested.isUndefined() || (requested.isDouble() && requested.toDouble() < 1)) {
        return required ? DEFAULT_LEASE : 0;
    }
    return qBound(MIN_LEASE, requested.toInt(DEFAULT_LEASE), MAX_LEASE);
}

// The request's arguments, clamped; anything but "binary" or "vp8" is text.
MirrorStream *startStream(QLocalSocket *socket, const QJsonObject &request, IndicatorLink *indicator,
                          const PhoneSettings *settings, const QString &inputModule)
{
    const QString encodingName = request.value(QStringLiteral("encoding")).toString();
    const MirrorEncoding encoding = encodingName == QLatin1String("binary") ? MirrorEncoding::Binary
        : encodingName == QLatin1String("vp8")                              ? MirrorEncoding::Vp8
                                                                            : MirrorEncoding::Text;
    const bool video = encoding == MirrorEncoding::Vp8;
    int fps = request.value(QStringLiteral("fps")).toInt(video ? VIDEO_DEFAULT_FPS : DEFAULT_FPS);
    fps = video ? videoFps(fps, settings->maxFps()) : qBound(1, fps, MAX_FPS);
    int width = request.value(QStringLiteral("width")).toInt(DEFAULT_WIDTH);
    width = width <= 0 ? 0 : qBound(MIN_WIDTH, width, MAX_WIDTH); // 0: native size
    const int quality = qBound(1, request.value(QStringLiteral("quality")).toInt(DEFAULT_QUALITY), 100);
    const int window = video ? (fps > 30 ? VIDEO_FAST_WINDOW : VIDEO_WINDOW) : DEFAULT_WINDOW;
    // Adaptive quality (1.4.0) and the "settings" message (1.9.0) are opt-in, so older clients
    // get the stream they knew.
    const bool adapt = request.value(QStringLiteral("adapt")).toBool(false);
    const int bitrate = video ? qBound(VIDEO_MIN_BITRATE,
                                       request.value(QStringLiteral("bitrate")).toInt(VIDEO_DEFAULT_BITRATE),
                                       VIDEO_MAX_BITRATE)
                              : 0;
    const bool input = request.value(QStringLiteral("input")).toBool(false);
    const bool phoneState = request.value(QStringLiteral("phoneState")).toBool(false);
    return new MirrorStream(socket, fps, width, quality, encoding, window,
                            lease(request.value(QStringLiteral("lease")), encoding != MirrorEncoding::Text), indicator,
                            adapt, bitrate, input, settings, phoneState, inputModule);
}

QJsonObject statusEvent(const MirrorStream *stream)
{
    const bool active = stream->active();
    QJsonObject status;
    status.insert(QStringLiteral("mirrorActive"), active);
    status.insert(QStringLiteral("mirrorSince"), active ? stream->startedAt() : qint64(0));
    status.insert(QStringLiteral("mirrorControl"), active && stream->inputActive());
    status.insert(QStringLiteral("mirrorEncoding"), active ? stream->encodingName() : QString());
    status.insert(QStringLiteral("mirrorCapture"), active ? stream->captureName() : QString());
    return QJsonObject{ { QStringLiteral("status"), status } };
}

}

int main(int argc, char **argv)
{
    QCoreApplication app(argc, argv);
    ModuleHost host("mirror");
    const int code = host.init(app.arguments());
    if (code >= 0) {
        return code;
    }
    PhoneSettings settings;
    IndicatorLink indicator(&host);
    QPointer<MirrorStream> stream;
    QObject::connect(&host, &ModuleHost::started, [&](const QJsonObject &control) {
        settings.reset(control.value(QStringLiteral("settings")).toObject());
        // The daemon names the input module only when it is installed.
        stream = startStream(host.socket(), control.value(QStringLiteral("request")).toObject(), &indicator, &settings,
                             control.value(QStringLiteral("inputModule")).toString());
        QObject::connect(stream.data(), &MirrorStream::stateChanged, &host, [&]() {
            if (!stream) {
                return;
            }
            host.sendEvent(statusEvent(stream));
            if (!stream->active()) {
                host.finish(QStringLiteral("ended"));
            }
        });
        host.sendEvent(statusEvent(stream));
        if (!stream->active()) {
            host.finish(QStringLiteral("client gone"));
        }
    });
    QObject::connect(&host, &ModuleHost::control, [&](const QJsonObject &line) {
        const QJsonObject setting = line.value(QStringLiteral("setting")).toObject();
        if (!setting.isEmpty()) {
            const QString key = setting.value(QStringLiteral("key")).toString();
            settings.set(key, setting.value(QStringLiteral("value")));
            if (stream) {
                stream->applySetting(key);
            }
        }
        const QJsonValue shown = line.value(QStringLiteral("indicator"));
        if (shown.isObject()) {
            indicator.handle(shown.toObject());
        }
    });
    QObject::connect(&host, &ModuleHost::endRequested, [&](const QString &reason) {
        if (stream && stream->active()) {
            stream->finish(reason);
        } else {
            host.finish(reason);
        }
    });
    return app.exec();
}
