#include "mirror.h"
#include "displaystate.h"
#include "idleplan.h"
#include "indicator.h"
#include "mirrorinput.h"
#include "paths.h"
#include "recorder.h"
#include "settings.h"
#include "touchoverlay.h"
#include "videoencoder.h"

#include <QBuffer>
#include <QByteArray>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QImage>
#include <QImageReader>
#include <QImageWriter>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QLocalSocket>
#include <algorithm>
#include <cmath>
#include <cstdio>

namespace {

const int CAPTURE_TIMEOUT_MS = 3000;
const int SLOW_INTERVAL_MS = 2000;
const int DROP_LOG_EVERY = 100;
const int UPSTREAM_LINE_MAX = 256;
const int UPSTREAM_BUFFER_MAX = 4096;
const qint64 TIMING_MAX_MS = 60000;
const int ADAPT_MIN_WIDTH = 90;  // as the request's minimum width
const int ADAPT_MAX_WIDTH = 2160; // as the request's maximum width (used when the request is native)
const int VIDEO_MIN_BITRATE = 100; // kbit/s, as the request's minimum
// Frame pacing (agent 1.8.0; the slot decision is in pacer.h since 1.8.1). A request goes out half a
// slot before the slot: the compositor delivers the next frame it renders, which on a busy phone or
// emulator is not every display frame. An early frame keeps the grid, so the average stays at the
// slot rate.
const double PACE_LEAD_SHARE = 0.5;
// The idle screen (agent 1.8.0): after this long without a new frame the last picture is encoded
// again (it sharpens), at most IDLE_REFRESHES times, then a "same" message goes out every
// IDLE_HEARTBEAT_MS. Neither asks the compositor for a repaint.
const int IDLE_AFTER_MS = 300;
const int IDLE_REFRESHES = 2;
const int IDLE_HEARTBEAT_MS = 1000;
const int WAKE_AFTER_MS = 1000; // a change after this long without a frame ends the idle pace
const int RECORDER_TRIES = 3; // reopens of a broken recorder within RECORDER_TRY_WINDOW_MS before the stream ends
const int RECORDER_TRY_WINDOW_MS = 5000;
const int INPUT_FOCUS_LEASE_MS = 3000;
const int INPUT_MESSAGES_PER_SECOND = 20; // also keeps accepted gestures at the existing 20/s ceiling
const int KEY_REQUESTS_PER_SECOND = 2;

QByteArray jsonString(const QString &s)
{
    QByteArray arr = QJsonDocument(QJsonArray{ s }).toJson(QJsonDocument::Compact); // ["..."]
    return arr.mid(1, arr.size() - 2);
}

bool canWriteJpeg()
{
    const QList<QByteArray> formats = QImageWriter::supportedImageFormats();
    return formats.contains("jpeg") || formats.contains("jpg");
}

bool jsonInteger(const QJsonObject &o, const QString &key, int min, int max, int *value)
{
    const QJsonValue v = o.value(key);
    if (!v.isDouble()) {
        return false;
    }
    const double d = v.toDouble();
    if (d < min || d > max || d != static_cast<int>(d)) {
        return false;
    }
    *value = static_cast<int>(d);
    return true;
}

bool jsonClampedInteger(const QJsonValue &v, int min, int max, int *value)
{
    if (!v.isDouble()) {
        return false;
    }
    const double d = v.toDouble();
    if (!qIsFinite(d) || std::floor(d) != d) {
        return false;
    }
    *value = static_cast<int>(qBound<double>(min, d, max));
    return true;
}

}

MirrorStream::MirrorStream(QLocalSocket *socket, int fps, int width, int quality, MirrorEncoding encoding,
                           int window, int leaseSeconds, StreamIndicator *indicator, bool adapt, int bitrateKbps,
                           bool inputRequested, const Settings *settings, bool phoneState)
    : QObject(socket)
    , m_socket(socket)
    , m_fps(fps)
    , m_width(width)
    , m_quality(quality)
    , m_recorder(nullptr)
    , m_recorderDelivered(false)
    , m_recorderTries(RECORDER_TRIES, RECORDER_TRY_WINDOW_MS)
    , m_recorderStale(false)
    , m_captureTs(0)
    , m_frame(0)
    , m_drops(0)
    , m_slow(false)
    , m_cleaned(false)
    , m_encoding(encoding)
    , m_window(window < 1 ? 1 : window)
    , m_leaseSeconds(leaseSeconds)
    , m_indicator(indicator)
    , m_indicated(false)
    , m_lastImageFrame(0)
    , m_lastAcked(0)
    , m_settings(settings)
    , m_phoneState(phoneState)
    , m_inputRequested(inputRequested)
    , m_startedAt(QDateTime::currentMSecsSinceEpoch())
    , m_adapt(adapt && encoding != MirrorEncoding::Text)
    , m_maxWidth(width)
    , m_maxQuality(quality)
    , m_ticks(0)
    , m_linkSkips(0)
    , m_rttMs(-1)
    , m_rttFrame(0)
    , m_input(inputRequested ? new MirrorInput(this) : nullptr)
    , m_touchOverlay(inputRequested ? new TouchOverlay(this) : nullptr)
    , m_controlAllowed(!settings || settings->control())
    , m_inputEnabled(m_controlAllowed && m_input && m_input->available())
    , m_inputActive(false)
    , m_controlRefusalLogged(false)
    , m_lastInputControlAt(-1)
    , m_video(nullptr)
    , m_bitrate(bitrateKbps)
    , m_maxBitrate(bitrateKbps)
    , m_lastRequestAt(-1)
    , m_lastKeyAt(-1)
    , m_lastPts(-1)
    , m_forceKey(true)
    , m_needRepaint(true)
    , m_dirty(false)
    , m_repaintAsked(false)
    , m_keyRequests(0)
    , m_pacer(fps)
    , m_gridAt(-1)
    , m_refreshes(IDLE_REFRESHES)
    , m_idleReported(false)
    , m_lastFrameAt(-1)
    , m_display(nullptr)
{
    m_streamClock.start();
    connect(m_socket, &QLocalSocket::disconnected, this, &MirrorStream::onClientGone);
    m_timer.setInterval(1000 / m_fps);
    connect(&m_timer, &QTimer::timeout, this, &MirrorStream::tick);
    m_frameTimeout.setSingleShot(true);
    m_frameTimeout.setInterval(CAPTURE_TIMEOUT_MS);
    connect(&m_frameTimeout, &QTimer::timeout, this, &MirrorStream::onRecorderTimeout);

    const bool binary = binaryFraming();
    QByteArray status = QByteArray("{\"ok\":true,\"stream\":\"mirror\",\"fps\":") + QByteArray::number(m_fps)
        + ",\"width\":" + QByteArray::number(m_width) + ",\"quality\":" + QByteArray::number(m_quality);
    if (binary) {
        status += QByteArray(",\"encoding\":\"") + (isVideo() ? "vp8" : "binary") + "\",\"window\":"
            + QByteArray::number(m_window);
        if (isVideo()) {
            status += ",\"bitrate\":" + QByteArray::number(m_bitrate);
        }
        if (m_adapt) {
            status += ",\"adapt\":true";
        }
    }
    status += inputFields();
    if (m_leaseSeconds > 0) {
        status += ",\"lease\":" + QByteArray::number(m_leaseSeconds);
    }
    status += "}";
    if (isVideo()) {
        fprintf(stderr, "sailfish-devagent: mirror started (fps %d, width %d, vp8 %d kbit/s%s, lease %d)\n", m_fps,
                m_width, m_bitrate, m_adapt ? ", adaptive" : "", m_leaseSeconds);
    } else {
        fprintf(stderr, "sailfish-devagent: mirror started (fps %d, width %d, quality %d%s%s, lease %d)\n", m_fps, m_width,
                m_quality, binary ? ", binary" : "", m_adapt ? ", adaptive" : "", m_leaseSeconds);
    }
    writeLine(status);
    if (m_cleaned) {
        // The client was already gone: the write failed, the socket emitted disconnected and
        // cleanup() ran inside writeLine. There is no stream to show or to time.
        return;
    }
    if (m_phoneState) {
        sendPhoneSettings(inputFields());
    }
    if (m_indicator) {
        m_indicator->streamStarted();
        m_indicated = true;
    }
    if (binary || m_leaseSeconds > 0 || m_inputRequested) {
        connect(m_socket, &QLocalSocket::readyRead, this, &MirrorStream::onUpstream);
        // Lines that arrived together with the request are already buffered: no readyRead for them.
        QTimer::singleShot(0, this, &MirrorStream::onUpstream);
    }
    if (m_input && m_input->available()) {
        m_inputLease.setSingleShot(true);
        m_inputLease.setInterval(INPUT_FOCUS_LEASE_MS);
        connect(&m_inputLease, &QTimer::timeout, this, &MirrorStream::onInputLeaseExpired);
        if (m_indicator) {
            connect(m_indicator, &StreamIndicator::inputReady, this, [this]() {
                if (!m_cleaned) {
                    setInputActive(true);
                }
            });
        }
        if (m_touchOverlay) {
            connect(m_input, &MirrorInput::contactChanged, this, &MirrorStream::onContactChanged);
        }
    }
    if (m_leaseSeconds > 0) {
        m_lease.setSingleShot(true);
        m_lease.setInterval(m_leaseSeconds * 1000);
        connect(&m_lease, &QTimer::timeout, this, &MirrorStream::onLeaseExpired);
        m_lease.start();
    }
    if (isVideo()) {
        // Capture follows the compositor's frames; m_pace keeps to the fps cap.
        m_video = new VideoEncoder;
        m_pace.setSingleShot(true);
        m_pace.setTimerType(Qt::PreciseTimer); // slots are 33 ms: a coarse timer would be 5 % off
        connect(&m_pace, &QTimer::timeout, this, &MirrorStream::onPace);
        m_idle.setSingleShot(true);
        connect(&m_idle, &QTimer::timeout, this, &MirrorStream::onIdle);
        m_display = new DisplayState(this);
        connect(m_display, &DisplayState::changed, this, &MirrorStream::onDisplayChanged);
        connect(m_socket, &QLocalSocket::bytesWritten, this, &MirrorStream::onBytesWritten);
        QTimer::singleShot(0, this, &MirrorStream::pumpVideo);
        return;
    }
    m_timer.start();
    QTimer::singleShot(0, this, &MirrorStream::tick);
}

MirrorStream::~MirrorStream()
{
    cleanup();
}

void MirrorStream::writeLine(const QByteArray &line)
{
    if (m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    m_socket->write(line);
    m_socket->write("\n");
    m_socket->flush();
}

void MirrorStream::writeRecord(const QByteArray &headerJson, const QByteArray &payload)
{
    if (m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    const quint32 n = static_cast<quint32>(headerJson.size());
    char prefix[4] = { static_cast<char>((n >> 24) & 0xff), static_cast<char>((n >> 16) & 0xff),
                       static_cast<char>((n >> 8) & 0xff), static_cast<char>(n & 0xff) };
    m_socket->write(prefix, 4);
    m_socket->write(headerJson);
    if (!payload.isEmpty()) {
        m_socket->write(payload);
    }
    m_socket->flush();
}

void MirrorStream::writeMessage(const QByteArray &json)
{
    if (binaryFraming()) {
        writeRecord(json, QByteArray());
    } else {
        writeLine(json);
    }
}

void MirrorStream::finish(const QString &error)
{
    if (m_cleaned) {
        return;
    }
    if (m_stopReason.isEmpty()) {
        m_stopReason = error;
    }
    if (binaryFraming()) {
        writeRecord("{\"ok\":false,\"error\":" + jsonString(error) + "}", QByteArray());
    } else {
        // The same bytes as Agent::reply wrote in 1.1.0 (QJsonObject keys are sorted).
        QJsonObject o;
        o.insert(QStringLiteral("ok"), false);
        o.insert(QStringLiteral("error"), error);
        writeLine(QJsonDocument(o).toJson(QJsonDocument::Compact));
    }
    if (m_socket->state() == QLocalSocket::ConnectedState) {
        m_socket->flush();
        m_socket->disconnectFromServer();
    }
    cleanup();
}

QByteArray MirrorStream::inputFields() const
{
    if (!m_inputRequested) {
        return QByteArray();
    }
    if (!m_controlAllowed) {
        return QByteArrayLiteral(",\"input\":false,\"inputError\":\"control disabled on the phone\"");
    }
    if (m_inputEnabled) {
        return QByteArray(",\"input\":true,\"inputLease\":3");
    }
    return ",\"input\":false,\"inputError\":" + jsonString(m_input ? m_input->error() : QStringLiteral("input unavailable"));
}

void MirrorStream::sendPhoneSettings(const QByteArray &fields)
{
    if (!m_phoneState || m_cleaned) {
        return;
    }
    const bool control = m_settings ? m_settings->control() : true;
    const bool touch = m_settings ? m_settings->touchIndicator() : false;
    writeMessage(QByteArray("{\"settings\":{\"control\":") + (control ? "true" : "false") + ",\"touchIndicator\":"
                 + (touch ? "true" : "false") + ",\"touchIndicatorPath\":\"" + touchIndicatorPath()
                 + "\",\"idleMode\":" + (idleModeOn() ? "true" : "false") + "}" + fields
                 + "}");
}

QByteArray MirrorStream::touchIndicatorPath() const
{
    if (!m_touchOverlay || !m_settings || !m_settings->touchIndicator() || !m_controlAllowed || !m_inputActive) {
        return QByteArrayLiteral("off");
    }
    if (m_touchOverlay->showingOnPhone()) {
        return QByteArrayLiteral("phone");
    }
    return m_phoneState ? QByteArrayLiteral("mirror") : QByteArrayLiteral("off");
}

void MirrorStream::applySetting(const QString &key)
{
    if (m_cleaned || !m_settings) {
        return;
    }
    if (key == QLatin1String("screenView")) {
        if (!m_settings->screenView()) {
            finish(QStringLiteral("screen view disabled on the phone"));
        }
        return;
    }
    if (key == QLatin1String("control")) {
        sendPhoneSettings(applyControlSetting(m_settings->control()));
        return;
    }
    if (key == QLatin1String("touchIndicator")) {
        applyTouchIndicatorSetting(m_settings->touchIndicator());
        sendPhoneSettings(inputFields());
    }
}

bool MirrorStream::idleModeOn() const
{
    return !m_settings || m_settings->idleMode();
}

QByteArray MirrorStream::applyControlSetting(bool allowed)
{
    if (!allowed) {
        setInputActive(false);
    }
    m_controlAllowed = allowed;
    m_inputEnabled = allowed && m_input && m_input->available();
    applyTouchIndicatorSetting(m_settings && m_settings->touchIndicator());
    fprintf(stderr, "sailfish-devagent: mirror: phone setting control = %s\n", allowed ? "true" : "false");
    return inputFields();
}

void MirrorStream::applyTouchIndicatorSetting(bool on)
{
    if (m_touchOverlay) {
        m_touchOverlay->setEnabled(on && m_controlAllowed && m_inputActive);
    }
}

void MirrorStream::onContactChanged(const QPoint &point, bool pressed)
{
    if (!m_touchOverlay) {
        return;
    }
    m_touchOverlay->setContact(point, pressed);
    if (touchIndicatorPath() == QByteArrayLiteral("mirror")) {
        writeMessage(QByteArray("{\"contact\":{\"x\":") + QByteArray::number(point.x()) + ",\"y\":"
                     + QByteArray::number(point.y()) + ",\"down\":" + (pressed ? "true" : "false") + "}}");
    }
}

QString MirrorStream::encodingName() const
{
    switch (m_encoding) {
    case MirrorEncoding::Binary:
        return QStringLiteral("binary");
    case MirrorEncoding::Vp8:
        return QStringLiteral("vp8");
    case MirrorEncoding::Text:
        break;
    }
    return QStringLiteral("text");
}

QString MirrorStream::captureName() const
{
    return m_recorder ? QStringLiteral("native") : QString();
}

void MirrorStream::onLeaseExpired()
{
    m_stopReason = QStringLiteral("lease expired after %1 s").arg(m_leaseSeconds);
    finish(QStringLiteral("lease expired"));
}

void MirrorStream::onUpstream()
{
    if (m_cleaned) {
        return;
    }
    m_upstream += m_socket->readAll();
    int eol;
    while ((eol = m_upstream.indexOf('\n')) >= 0) {
        const QByteArray line = m_upstream.left(eol);
        m_upstream.remove(0, eol + 1);
        if (line.size() > UPSTREAM_LINE_MAX) {
            m_stopReason = QStringLiteral("oversized upstream line");
            m_socket->abort();
            cleanup();
            return;
        }
        handleUpstreamLine(line);
        if (m_cleaned) {
            return;
        }
    }
    if (m_upstream.size() > UPSTREAM_BUFFER_MAX) {
        m_stopReason = QStringLiteral("oversized upstream buffer");
        m_socket->abort();
        cleanup();
    }
}

// Unknown or malformed lines are ignored (room for later message kinds) and never renew the lease.
void MirrorStream::handleUpstreamLine(const QByteArray &line)
{
    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(line, &parseError);
    if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
        return;
    }
    const QJsonObject o = doc.object();
    const QJsonValue ack = o.value(QStringLiteral("ack"));
    if (ack.isDouble() && binaryFraming()) {
        const double d = ack.toDouble();
        if (d >= 1 && d <= static_cast<double>(m_lastImageFrame) && d == static_cast<qint64>(d)) {
            const qint64 n = static_cast<qint64>(d);
            const int acknowledgedAt = m_pendingAcks.indexOf(n);
            if (n > m_lastAcked && acknowledgedAt >= 0) {
                m_lastAcked = n;
                for (int i = 0; i <= acknowledgedAt; ++i) {
                    m_pendingAcks.removeFirst();
                }
                if (m_adapt) {
                    const auto it = m_sentAt.constFind(n);
                    if (it != m_sentAt.constEnd()) {
                        m_rttMs = qBound<qint64>(0, m_streamClock.elapsed() - it.value(), TIMING_MAX_MS);
                        m_rttFrame = n;
                    }
                    for (auto i = m_sentAt.begin(); i != m_sentAt.end();) {
                        if (i.key() <= n) {
                            i = m_sentAt.erase(i);
                        } else {
                            ++i;
                        }
                    }
                }
                if (isVideo() && m_dirty && !linkBusy()) {
                    pumpVideo(); // a capture was dropped while the window was full: capture again now
                }
            }
        }
        return;
    }
    const QJsonValue set = o.value(QStringLiteral("set"));
    if (set.isObject()) {
        if (m_adapt) {
            handleSet(set.toObject());
        }
        return;
    }
    const QJsonValue input = o.value(QStringLiteral("input"));
    if (input.isObject()) {
        handleInput(input.toObject());
        return;
    }
    if (o.value(QStringLiteral("keyframe")).toBool(false)) {
        if (isVideo() && allowKeyRequest()) {
            handleKeyRequest();
        }
        return;
    }
    const QJsonValue keepalive = o.value(QStringLiteral("keepalive"));
    if (keepalive.isDouble() && m_leaseSeconds > 0) {
        const double d = keepalive.toDouble();
        if (d >= 0 && d <= 9e15 && d == static_cast<qint64>(d)) {
            if (!Paths::developerModeOn()) {
                finish(QStringLiteral("developer mode is off"));
                return;
            }
            m_lease.start();
            writeMessage("{\"pong\":" + QByteArray::number(static_cast<qint64>(d)) + ",\"ts\":"
                         + QByteArray::number(QDateTime::currentMSecsSinceEpoch()) + "}");
        }
    }
}

void MirrorStream::setInputActive(bool active)
{
    if (!active) {
        if (m_touchOverlay) {
            m_touchOverlay->setEnabled(false);
        }
        if (m_indicator) {
            m_indicator->setInputActive(false);
        }
        m_inputLease.stop();
        if (!m_inputActive) {
            return; // also cancels a notification that was pending before input became active
        }
        m_inputActive = false;
        m_input->cancel();
        sendPhoneSettings(inputFields());
        fprintf(stderr, "sailfish-devagent: mirror input inactive\n");
        return;
    }
    if (!m_inputEnabled) {
        return;
    }
    if (m_inputActive) {
        m_inputLease.start();
        return;
    }
    // The controlled notification is mandatory. Notify is asynchronous, so the first heartbeat
    // can leave input off; inputReady retries this transition after the service acknowledges it.
    if (!m_indicator || !m_indicator->setInputActive(true)) {
        return;
    }
    m_inputActive = active;
    m_inputLease.start();
    applyTouchIndicatorSetting(m_settings && m_settings->touchIndicator());
    sendPhoneSettings(inputFields());
    fprintf(stderr, "sailfish-devagent: mirror input active\n");
}

void MirrorStream::onInputLeaseExpired()
{
    setInputActive(false);
}

bool MirrorStream::allowInputMessage()
{
    const qint64 now = m_streamClock.elapsed();
    while (!m_inputMessageTimes.isEmpty() && now - m_inputMessageTimes.first() >= 1000) {
        m_inputMessageTimes.removeFirst();
    }
    if (m_inputMessageTimes.size() >= INPUT_MESSAGES_PER_SECOND) {
        return false;
    }
    m_inputMessageTimes.append(now);
    return true;
}

bool MirrorStream::allowKeyRequest()
{
    const qint64 now = m_streamClock.elapsed();
    while (!m_keyRequestTimes.isEmpty() && now - m_keyRequestTimes.first() >= 1000) {
        m_keyRequestTimes.removeFirst();
    }
    if (m_keyRequestTimes.size() >= KEY_REQUESTS_PER_SECOND) {
        return false;
    }
    m_keyRequestTimes.append(now);
    return true;
}

// Strict, fixed input vocabulary: active, touch gestures and whitelisted keypad keys. Except for
// immediate deactivation and release, every input object consumes the bounded dispatch budget
// before its fields are validated. No string reaches an executable, path or shell.
void MirrorStream::handleInput(const QJsonObject &input)
{
    const QString type = input.value(QStringLiteral("type")).toString();
    const QJsonValue active = input.value(QStringLiteral("active"));
    // Safety-off is fail-open and immediate: a flooded budget must never keep remote input active.
    if (type == QLatin1String("active") && active.isBool() && !active.toBool()) {
        m_lastInputControlAt = m_streamClock.elapsed();
        setInputActive(false);
        return;
    }
    // Release is idempotent and fail-open: neither a full budget nor a stale screen mapping may
    // leave a contact held down.
    if (type == QLatin1String("up")) {
        if (m_input && m_input->liveContact()) {
            m_input->contactUp();
        }
        return;
    }
    const QString key = input.value(QStringLiteral("key")).toString();
    const QJsonValue pressed = input.value(QStringLiteral("pressed"));
    if (type == QLatin1String("key") && MirrorInput::validKeyName(key) && pressed.isBool() && !pressed.toBool()) {
        if (m_input) {
            m_input->keyUp(key);
        }
        return;
    }
    if (!allowInputMessage()) {
        return;
    }
    if (!m_controlAllowed) {
        if (!m_controlRefusalLogged) {
            m_controlRefusalLogged = true;
            fprintf(stderr, "sailfish-devagent: mirror input refused: control disabled on the phone\n");
        }
        return;
    }
    if (type == QLatin1String("active")) {
        if (active.isBool()) {
            if (!Paths::developerModeOn()) {
                finish(QStringLiteral("developer mode is off"));
                return;
            }
            const qint64 now = m_streamClock.elapsed();
            // Duplicate activation heartbeats are accepted at most ten times per second; the
            // extension sends one per second.
            if (m_lastInputControlAt < 0 || now - m_lastInputControlAt >= 100) {
                m_lastInputControlAt = now;
                setInputActive(true);
            }
        }
        return;
    }
    if (!m_inputActive || !m_input) {
        return;
    }
    if (type == QLatin1String("key")) {
        if (MirrorInput::validKeyName(key) && pressed.isBool() && pressed.toBool() && m_input->keypadAvailable()) {
            m_input->keyDown(key);
        }
        return;
    }
    // The injector validates against the latest captured screen too. These bounds prevent very large
    // values before they reach any coordinate arithmetic.
    int x = 0;
    int y = 0;
    if (type == QLatin1String("down")) {
        if (m_input->busy() || !jsonInteger(input, QStringLiteral("x"), 0, 9999, &x)
            || !jsonInteger(input, QStringLiteral("y"), 0, 9999, &y)) {
            return;
        }
        m_input->contactDown(QPoint(x, y));
        return;
    }
    if (type == QLatin1String("move")) {
        if (!m_input->liveContact() || !jsonInteger(input, QStringLiteral("x"), 0, 9999, &x)
            || !jsonInteger(input, QStringLiteral("y"), 0, 9999, &y)) {
            return;
        }
        m_input->contactMove(QPoint(x, y));
        return;
    }
    if (m_input->busy()) {
        return;
    }
    if (type == QLatin1String("tap")) {
        if (!jsonInteger(input, QStringLiteral("x"), 0, 9999, &x)
            || !jsonInteger(input, QStringLiteral("y"), 0, 9999, &y)) {
            return;
        }
        m_input->tap(QPoint(x, y));
        return;
    }
    if (type == QLatin1String("swipe")) {
        int x2 = 0;
        int y2 = 0;
        int duration = 0;
        if (!jsonInteger(input, QStringLiteral("x1"), 0, 9999, &x)
            || !jsonInteger(input, QStringLiteral("y1"), 0, 9999, &y)
            || !jsonInteger(input, QStringLiteral("x2"), 0, 9999, &x2)
            || !jsonInteger(input, QStringLiteral("y2"), 0, 9999, &y2)
            || !jsonInteger(input, QStringLiteral("duration"), 50, 2000, &duration)) {
            return;
        }
        m_input->swipe(QPoint(x, y), QPoint(x2, y2), duration);
    }
}

// Width and quality for the next frames, clamped to what the request asked for: the client can
// lower them and restore them, never raise them above the request. Missing or non-integer
// fields keep their value.
void MirrorStream::handleSet(const QJsonObject &set)
{
    const int ceiling = m_maxWidth > 0 ? m_maxWidth : ADAPT_MAX_WIDTH;
    int width = m_width;
    int quality = m_quality;
    int requested = 0;
    if (jsonClampedInteger(set.value(QStringLiteral("width")), ADAPT_MIN_WIDTH, ceiling, &requested)) {
        // A native request stays native when asked for the ceiling again.
        width = (m_maxWidth == 0 && requested >= ceiling) ? 0 : requested;
    }
    if (isVideo()) {
        int bitrate = m_bitrate;
        if (jsonClampedInteger(set.value(QStringLiteral("bitrate")), qMin(VIDEO_MIN_BITRATE, m_maxBitrate),
                               m_maxBitrate, &requested)) {
            bitrate = requested;
        }
        if (width == m_width && bitrate == m_bitrate) {
            return;
        }
        m_width = width; // a new size reopens the encoder at the next frame, which is then a key frame
        m_bitrate = bitrate;
        if (m_video && m_video->isOpen() && !m_video->setBitrate(bitrate)) {
            m_video->close();
        }
        m_needRepaint = true; // a static screen shows the new level too
        fprintf(stderr, "sailfish-devagent: mirror: adaptive quality: width %d, bitrate %d kbit/s\n", m_width, m_bitrate);
        pumpVideo();
        return;
    }
    if (jsonClampedInteger(set.value(QStringLiteral("quality")), 1, m_maxQuality, &requested)) {
        quality = requested;
    }
    if (width == m_width && quality == m_quality) {
        return;
    }
    m_width = width;
    m_quality = quality;
    // The next frame is sent even if the screen has not changed, so a static screen shows the new level.
    m_lastHash.clear();
    fprintf(stderr, "sailfish-devagent: mirror: adaptive quality: width %d, quality %d\n", m_width, m_quality);
}

void MirrorStream::tick()
{
    if (m_cleaned || m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    const bool recorderBusy = m_recorder && m_recorder->pending();
    const bool linkBusy = m_socket->bytesToWrite() > 0
        || (m_encoding == MirrorEncoding::Binary && m_pendingAcks.size() >= m_window);
    ++m_ticks;
    if (linkBusy) {
        ++m_linkSkips;
    }
    if (recorderBusy || linkBusy) {
        if (recorderBusy && m_recorderStale) {
            m_recorder->repaint(); // still waiting, e.g. the screen is off: ask again
        }
        if (++m_drops % DROP_LOG_EVERY == 0) {
            fprintf(stderr, "sailfish-devagent: mirror dropped %lld ticks\n", static_cast<long long>(m_drops));
        }
        return;
    }
    if (!ensureRecorder()) {
        return;
    }
    ++m_frame;
    m_captureTs = QDateTime::currentMSecsSinceEpoch();
    m_captureClock.start();
    m_recorderStale = false;
    if (m_recorder->requestFrame()) {
        m_frameTimeout.start();
    }
    // Otherwise the connection failed: onRecorderFailed reported it, the next tick reopens it.
}

// False when the stream was ended: the mirror uses only the native recorder, never screenshots. A
// recorder that broke is reopened a few times, then the stream ends with the reason.
bool MirrorStream::ensureRecorder()
{
    if (m_recorder && !m_recorder->broken()) {
        return true;
    }
    if (m_recorder) {
        // deleteLater: this may run while the recorder is still on the stack.
        m_recorder->disconnect(this);
        m_recorder->deleteLater();
        m_recorder = nullptr;
        if (!m_recorderTries.take(m_streamClock.elapsed())) {
            endWithoutRecorder(m_recorderError.isEmpty() ? QStringLiteral("recorder failed") : m_recorderError);
            return false;
        }
    }
    QString error;
    m_recorder = Recorder::open(&error, this);
    m_recorderDelivered = false;
    m_recorderStale = false;
    if (!m_recorder) {
        endWithoutRecorder(error);
        return false;
    }
    connect(m_recorder, &Recorder::frameReady, this, &MirrorStream::onRecorderFrame);
    connect(m_recorder, &Recorder::failed, this, &MirrorStream::onRecorderFailed);
    emit stateChanged(); // the capture path is now known
    fprintf(stderr, "sailfish-devagent: mirror: native capture %dx%d\n", m_recorder->size().width(),
            m_recorder->size().height());
    return true;
}

void MirrorStream::endWithoutRecorder(const QString &reason)
{
    fprintf(stderr, "sailfish-devagent: mirror: native screen capture unavailable: %s\n", qPrintable(reason));
    finish(QStringLiteral("native screen capture unavailable: ") + reason);
}

QByteArray MirrorStream::captureFields()
{
    return QByteArray(",\"capture\":\"native\"");
}

void MirrorStream::onRecorderTimeout()
{
    if (m_cleaned || !m_recorder || !m_recorder->pending()) {
        return;
    }
    m_recorderStale = true;
    softError(QStringLiteral("lipstick did not deliver a frame (is the screen on?)"));
    if (isVideo()) {
        m_pace.start(SLOW_INTERVAL_MS); // pumpVideo asks for a repaint again, slowly, until a frame comes
    }
}

void MirrorStream::onRecorderFailed(const QString &error, bool fatal)
{
    m_frameTimeout.stop();
    if (m_cleaned) {
        return;
    }
    fprintf(stderr, "sailfish-devagent: mirror: %s\n", qPrintable(error));
    m_recorderError = error;
    const bool reported = m_recorderStale;
    m_recorderStale = false;
    if (fatal && !reported) {
        softError(error);
    }
    if (isVideo()) {
        // Reopen (or fall back) after a fatal error, ask again after a cancelled frame; never from
        // inside the recorder's own signal.
        m_repaintAsked = false;
        m_needRepaint = true;
        m_pace.start(fatal ? SLOW_INTERVAL_MS : 0);
    }
}

void MirrorStream::onRecorderFrame(const QImage &view, bool yInverted)
{
    m_frameTimeout.stop();
    const qint64 captureMs = m_captureClock.isValid() ? m_captureClock.elapsed() : 0;
    QElapsedTimer agentClock;
    agentClock.start();
    if (m_cleaned) {
        return;
    }
    m_recorderDelivered = true;
    if (isVideo()) {
        // The frame shows the screen as it is now (it was rendered just before this event), also
        // when it comes late, e.g. after the screen was off.
        m_recorderStale = false;
        m_repaintAsked = false;
        ++m_frame;
        m_captureTs = QDateTime::currentMSecsSinceEpoch();
        notePaceArrival(m_streamClock.elapsed());
        videoFrame(view.constBits(), view.width(), view.height(), view.bytesPerLine(), yInverted);
        return;
    }
    if (m_recorderStale) {
        // Its tick already got a soft error; the next tick asks for a fresh frame.
        m_recorderStale = false;
        return;
    }
    if (m_slow) {
        m_slow = false;
        m_timer.setInterval(1000 / m_fps);
    }

    const QByteArray hash = QCryptographicHash::hash(
        QByteArray::fromRawData(reinterpret_cast<const char *>(view.constBits()), view.byteCount()),
        QCryptographicHash::Md5);
    if (hash == m_lastHash) {
        writeMessage("{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
                     + ",\"same\":true}");
        return;
    }

    // Scale first, then flip the smaller image; both copy out of the shared buffer.
    QImage image;
    if (m_width > 0 && m_width < view.width()) {
        image = view.scaledToWidth(m_width, Qt::SmoothTransformation);
        if (yInverted) {
            image = image.mirrored(false, true);
        }
    } else {
        image = yInverted ? view.mirrored(false, true) : view.copy();
    }
    QByteArray data;
    QBuffer buffer(&data);
    buffer.open(QIODevice::WriteOnly);
    const bool jpeg = canWriteJpeg();
    if (!image.save(&buffer, jpeg ? "JPEG" : "PNG", jpeg ? m_quality : -1)) {
        softError(QStringLiteral("cannot encode frame"));
        return;
    }
    sendFrame(hash, data, jpeg ? QByteArray("jpeg") : QByteArray("png"), view.size(), image.size(), captureMs,
              agentClock);
}

void MirrorStream::softError(const QString &message)
{
    writeMessage("{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
                 + ",\"error\":" + jsonString(message) + "}");
    if (!m_slow) {
        m_slow = true;
        m_timer.setInterval(SLOW_INTERVAL_MS);
    }
}

void MirrorStream::sendFrame(const QByteArray &hash, const QByteArray &data, const QByteArray &format,
                             const QSize &screen, const QSize &size, qint64 captureMs, const QElapsedTimer &agentClock)
{
    if (m_input && m_input->available()) {
        m_input->setScreen(screen, true);
    }
    if (m_touchOverlay) {
        m_touchOverlay->setScreen(screen);
    }
    m_lastHash = hash;

    if (m_encoding == MirrorEncoding::Binary) {
        const qint64 cms = qBound<qint64>(0, captureMs, TIMING_MAX_MS);
        const qint64 ems = qBound<qint64>(0, agentClock.elapsed(), TIMING_MAX_MS);
        const QByteArray header = "{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":"
            + QByteArray::number(m_captureTs) + ",\"screen\":[" + QByteArray::number(screen.width()) + ","
            + QByteArray::number(screen.height()) + "],\"size\":[" + QByteArray::number(size.width()) + ","
            + QByteArray::number(size.height()) + "],\"format\":\"" + format + "\",\"bytes\":"
            + QByteArray::number(data.size()) + ",\"cms\":" + QByteArray::number(cms) + ",\"ems\":"
            + QByteArray::number(ems) + captureFields();
        QByteArray adapt;
        if (m_adapt) {
            // "q" only for JPEG: it is the quality the frame was encoded with.
            if (format == "jpeg") {
                adapt += ",\"q\":" + QByteArray::number(m_quality);
            }
            adapt += ",\"ticks\":" + QByteArray::number(m_ticks) + ",\"skips\":" + QByteArray::number(m_linkSkips);
            if (m_rttMs >= 0) {
                adapt += ",\"rtt\":" + QByteArray::number(m_rttMs) + ",\"rttFrame\":" + QByteArray::number(m_rttFrame);
            }
        }
        writeRecord(header + adapt + "}", data);
        m_lastImageFrame = m_frame;
        m_pendingAcks.append(m_frame);
        if (m_adapt) {
            m_sentAt.insert(m_frame, m_streamClock.elapsed());
        }
        return;
    }

    const QByteArray line = "{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
        + ",\"screen\":[" + QByteArray::number(screen.width()) + "," + QByteArray::number(screen.height())
        + "],\"size\":[" + QByteArray::number(size.width()) + "," + QByteArray::number(size.height())
        + "],\"format\":\"" + format + "\",\"data\":\"" + data.toBase64() + "\""
        + captureFields() + "}";
    writeLine(line);
}

void MirrorStream::onClientGone()
{
    cleanup();
}

// Idempotent: runs when the client goes away and again from the destructor.
void MirrorStream::cleanup()
{
    if (m_cleaned) {
        return;
    }
    m_cleaned = true;
    m_timer.stop();
    m_pace.stop();
    m_idle.stop();
    m_lease.stop();
    m_inputLease.stop();
    if (m_touchOverlay) {
        m_touchOverlay->setEnabled(false);
    }
    if (m_inputActive) {
        setInputActive(false);
    }
    m_frameTimeout.stop();
    delete m_video; // frees the encoder and its pictures now, not when the socket goes
    m_video = nullptr;
    if (m_recorder) {
        m_recorder->disconnect(this);
        m_recorder->deleteLater(); // cleanup() may run inside one of its signals
        m_recorder = nullptr;
    }
    if (m_stopReason.isEmpty()) {
        fprintf(stderr, "sailfish-devagent: mirror stopped\n");
    } else {
        fprintf(stderr, "sailfish-devagent: mirror stopped (%s)\n", qPrintable(m_stopReason));
    }
    if (m_indicator && m_indicated) {
        m_indicator->streamStopped();
    }
    emit stateChanged();
}

/* ---------------------------------------------------------------- VP8 video (agent 1.6.0) */

bool MirrorStream::linkBusy() const
{
    return m_socket->bytesToWrite() > 0 || m_pendingAcks.size() >= m_window;
}

void MirrorStream::onBytesWritten()
{
    if (!m_cleaned && m_dirty && !linkBusy()) {
        pumpVideo();
    }
}

void MirrorStream::onPace()
{
    if (m_cleaned) {
        return;
    }
    if (m_dirty && linkBusy()) {
        // A frame slot lost to the link while the screen has changed: counted for adaptive quality
        // like a skipped timer tick of the JPEG stream.
        ++m_ticks;
        ++m_linkSkips;
        m_pace.start(qMax(1, qRound(paceInterval())));
        return;
    }
    pumpVideo();
}

void MirrorStream::handleKeyRequest()
{
    ++m_keyRequests;
    if (m_keyRequests == 1 || m_keyRequests % DROP_LOG_EVERY == 0) {
        fprintf(stderr, "sailfish-devagent: mirror: key frame requested (%lld so far)\n",
                static_cast<long long>(m_keyRequests));
    }
    m_forceKey = true;
    m_needRepaint = true; // a static screen delivers a frame for it at once
    pumpVideo();
}

// Asks the compositor for the next frame. Without a repaint the frame arrives when the screen next
// changes, so a static screen costs nothing; a repaint is asked for at the start, for a key frame,
// for a new level and after a capture was dropped. Requests keep to the fps cap.
void MirrorStream::pumpVideo()
{
    if (m_cleaned || !m_video || m_socket->state() != QLocalSocket::ConnectedState) {
        return;
    }
    const int interval = qMax(1, qRound(paceInterval()));
    if (m_recorder && m_recorder->pending()) {
        if (m_recorderStale) {
            m_recorder->repaint(); // e.g. the screen is off: ask again, slowly
            m_pace.start(SLOW_INTERVAL_MS);
        } else if ((m_needRepaint || (m_dirty && !linkBusy())) && !m_repaintAsked) {
            m_recorder->repaint();
            m_repaintAsked = true;
            m_needRepaint = false;
            m_captureClock.start();
            m_frameTimeout.start();
        }
        return;
    }
    if (m_dirty && linkBusy()) {
        // Wait for an ack or the socket to drain (they call back here); onPace counts the lost slots.
        if (!m_pace.isActive()) {
            m_pace.start(interval);
        }
        return;
    }
    const qint64 now = m_streamClock.elapsed();
    if (!ensureRecorder()) {
        return;
    }
    // The next slot of the grid, a little early so the compositor's next frame lands on it.
    const qint64 due = nextRequestAt();
    if (now < due) {
        m_pace.start(static_cast<int>(due - now));
        return;
    }
    m_lastRequestAt = now;
    const bool repaint = m_needRepaint || m_dirty;
    m_recorderStale = false;
    m_repaintAsked = repaint;
    m_needRepaint = false;
    if (!m_recorder->requestFrame(repaint)) {
        m_pace.start(SLOW_INTERVAL_MS); // the connection failed: reopen then
        return;
    }
    if (repaint) {
        m_captureClock.start();
        m_frameTimeout.start();
    }
}

void MirrorStream::videoFrame(const uchar *rows, int width, int height, int bytesPerLine, bool yInverted)
{
    ++m_ticks;
    if (linkBusy()) {
        // Behind: drop the raw capture, never an encoded frame (the next one is coded against the
        // last frame sent). The screen is captured again once the link has room.
        ++m_linkSkips;
        m_dirty = true;
        if (++m_drops % DROP_LOG_EVERY == 0) {
            fprintf(stderr, "sailfish-devagent: mirror dropped %lld captures\n", static_cast<long long>(m_drops));
        }
        pumpVideo();
        return;
    }
    QElapsedTimer agentClock;
    agentClock.start();
    const qint64 now = m_streamClock.elapsed();
    const QSize screen(width, height);
    if (m_input && m_input->available()) {
        m_input->setScreen(screen, true);
    }
    if (m_touchOverlay) {
        m_touchOverlay->setScreen(screen);
    }
    const QSize out = VideoEncoder::outputSize(screen, m_width);
    // Key frames only at the start, after a size change and on request (agent 1.8.0: no periodic
    // one; the link is reliable and the client asks for one when it cannot decode).
    bool key = m_forceKey || m_lastKeyAt < 0;
    if (!m_video->isOpen() || m_video->size() != out) {
        QString error;
        if (!m_video->open(out, m_bitrate, &error)) {
            fprintf(stderr, "sailfish-devagent: mirror: %s\n", qPrintable(error));
            softError(QStringLiteral("cannot encode frame"));
            m_pace.start(SLOW_INTERVAL_MS);
            return;
        }
        fprintf(stderr, "sailfish-devagent: mirror: vp8 encoder %dx%d at %d kbit/s\n", out.width(), out.height(),
                m_bitrate);
        m_pacer.encoderOpened(now); // a new size has costs of its own
        key = true;
    }
    m_video->convert(rows, width, height, bytesPerLine, yInverted);
    const qint64 convertMs = agentClock.elapsed();
    if (!key && m_video->sameAsLast()) {
        m_dirty = false;
        writeMessage("{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
                     + ",\"same\":true}");
        pumpVideo();
        return;
    }
    wakeFromIdle(now);
    // The picture has been copied out of the shared buffer: ask for the next frame now, so the
    // compositor renders into the buffer while this one is encoded.
    m_dirty = false;
    pumpVideo();
    qint64 pts = now;
    if (m_lastPts >= 0 && pts <= m_lastPts) {
        pts = m_lastPts + 1;
    }
    const qint64 duration = m_lastPts < 0 ? 1000 / m_fps : pts - m_lastPts;
    QByteArray data;
    bool isKey = false;
    QString error;
    if (!m_video->encode(pts, duration, key, &data, &isKey, &error) || data.isEmpty()) {
        fprintf(stderr, "sailfish-devagent: mirror: %s\n", qPrintable(error.isEmpty() ? QStringLiteral("vp8: no output") : error));
        m_video->close(); // the next frame starts over with a key frame
        softError(QStringLiteral("cannot encode frame"));
        m_pace.start(SLOW_INTERVAL_MS);
        return;
    }
    m_lastPts = pts;
    if (isKey) {
        m_lastKeyAt = now;
        m_forceKey = false;
    }
    m_dirty = false;
    if (m_slow) {
        m_slow = false;
    }
    const qint64 frameMs = agentClock.elapsed();
    if (!isKey) {
        notePaceCost(static_cast<double>(frameMs), m_streamClock.elapsed());
    }
    m_lastScreen = screen;
    m_lastSize = out;
    m_refreshes = 0;
    m_idleReported = false;
    m_lastFrameAt = now;
    sendVideoFrame(data, isKey, pts, screen, out, frameMs, convertMs);
    m_idle.start(idleModeOn() ? IDLE_AFTER_MS : paceInterval());
    pumpVideo();
}

void MirrorStream::sendVideoFrame(const QByteArray &data, bool key, qint64 pts, const QSize &screen, const QSize &size,
                                  qint64 encodeMs, qint64 convertMs, bool refresh)
{
    QByteArray header = "{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
        + ",\"screen\":[" + QByteArray::number(screen.width()) + "," + QByteArray::number(screen.height())
        + "],\"size\":[" + QByteArray::number(size.width()) + "," + QByteArray::number(size.height())
        + "],\"format\":\"vp8\",\"key\":" + (key ? "true" : "false") + ",\"pts\":" + QByteArray::number(pts)
        + ",\"bytes\":" + QByteArray::number(data.size()) + ",\"ems\":"
        + QByteArray::number(qBound<qint64>(0, encodeMs, TIMING_MAX_MS)) + ",\"cvms\":"
        + QByteArray::number(qBound<qint64>(0, convertMs, TIMING_MAX_MS)) + captureFields()
        + ",\"pace\":" + QByteArray::number(qRound(paceInterval()));
    if (refresh) {
        header += ",\"refresh\":true";
    }
    if (m_adapt) {
        header += ",\"kbps\":" + QByteArray::number(m_bitrate) + ",\"ticks\":" + QByteArray::number(m_ticks)
            + ",\"skips\":" + QByteArray::number(m_linkSkips);
        if (m_rttMs >= 0) {
            header += ",\"rtt\":" + QByteArray::number(m_rttMs) + ",\"rttFrame\":" + QByteArray::number(m_rttFrame);
        }
    }
    writeRecord(header + "}", data);
    m_lastImageFrame = m_frame;
    m_pendingAcks.append(m_frame);
    if (m_adapt) {
        m_sentAt.insert(m_frame, m_streamClock.elapsed());
    }
}

/* ---------------------------------------------------------------- frame pacing (agent 1.8.0) */

double MirrorStream::paceInterval() const
{
    return m_pacer.intervalMs();
}

// m_streamClock ms at which the next frame may be requested: its slot less a lead, so the frame the
// compositor renders next (at most one display frame later) arrives on the slot. 0 without a grid.
qint64 MirrorStream::nextRequestAt() const
{
    if (m_gridAt < 0) {
        return 0;
    }
    const double interval = paceInterval();
    return static_cast<qint64>(std::ceil(m_gridAt + interval * (1 - PACE_LEAD_SHARE)));
}

// A frame arrived at `at`. Near its slot (early, or late by less than half a slot) the grid keeps
// its phase, so a late frame does not delay the ones after it; a frame much later than its slot (the
// screen was still, or the phone was busy) starts a new grid at its arrival.
void MirrorStream::notePaceArrival(qint64 at)
{
    const double interval = paceInterval();
    const double slot = m_gridAt + interval;
    if (m_gridAt < 0 || at > slot + interval / 2 || at < slot - interval) {
        m_gridAt = static_cast<double>(at);
    } else {
        m_gridAt = slot;
    }
}

// The convert + encode time of a delta frame (see pacer.h for the rule).
void MirrorStream::notePaceCost(double ms, qint64 now)
{
    if (m_pacer.addCost(ms, now)) {
        fprintf(stderr, "sailfish-devagent: mirror: pace %.1f fps (convert + encode %.0f ms per frame)\n",
                1000.0 / paceInterval(), m_pacer.changeCostMs());
    }
}

// The first change after a still screen: the frame request is already pending, so it is captured
// and encoded at once; the pace returns to the full rate instead of climbing back step by step.
void MirrorStream::wakeFromIdle(qint64 now)
{
    if (m_lastFrameAt >= 0 && now - m_lastFrameAt >= WAKE_AFTER_MS && m_pacer.wake(now)) {
        fprintf(stderr, "sailfish-devagent: mirror: pace %.1f fps (screen changed after idle)\n", 1000.0 / paceInterval());
    }
}

void MirrorStream::onDisplayChanged()
{
    if (!m_display->off()) {
        m_idle.start(idleModeOn() ? IDLE_AFTER_MS : paceInterval());
    }
}

void MirrorStream::sendSame()
{
    ++m_frame;
    m_captureTs = QDateTime::currentMSecsSinceEpoch();
    writeMessage("{\"frame\":" + QByteArray::number(m_frame) + ",\"ts\":" + QByteArray::number(m_captureTs)
                 + ",\"same\":true}");
}

// The screen has not changed since the last encoded frame (the frame request is still pending):
// sharpen the last picture by encoding it again, then tell the client once a second that the
// screen is idle. With the phone's idle mode off no such message goes out: the last picture is
// encoded again at the pace instead. Nothing at all while the display is blank. Nothing here asks
// the compositor for a repaint.
void MirrorStream::onIdle()
{
    if (m_cleaned || !m_video || !m_video->isOpen() || !m_recorder || !m_recorder->pending()
        || m_repaintAsked || m_socket->state() != QLocalSocket::ConnectedState || m_display->off()) {
        return;
    }
    const bool idleMode = idleModeOn();
    if (idleAction(idleMode, m_refreshes, IDLE_REFRESHES) == IdleAction::Reencode) {
        if (linkBusy()) {
            m_idle.start(idleDelayMs(idleMode, m_refreshes, IDLE_REFRESHES, IDLE_AFTER_MS, IDLE_HEARTBEAT_MS, paceInterval()));
            return;
        }
        QElapsedTimer clock;
        clock.start();
        const qint64 now = m_streamClock.elapsed();
        qint64 pts = now;
        if (m_lastPts >= 0 && pts <= m_lastPts) {
            pts = m_lastPts + 1;
        }
        QByteArray data;
        QString error;
        if (idleMode) {
            ++m_refreshes;
        }
        if (m_video->encodeAgain(pts, m_lastPts < 0 ? 1000 / m_fps : pts - m_lastPts, &data, &error) && !data.isEmpty()) {
            m_lastPts = pts;
            ++m_frame;
            m_captureTs = QDateTime::currentMSecsSinceEpoch();
            // Idle mode off: an ordinary frame, so the client never sees a still screen.
            sendVideoFrame(data, false, pts, m_lastScreen, m_lastSize, clock.elapsed(), 0, idleMode);
        } else if (idleMode) {
            m_refreshes = IDLE_REFRESHES; // nothing to sharpen: heartbeats only
        }
        m_idle.start(idleDelayMs(idleMode, m_refreshes, IDLE_REFRESHES, IDLE_AFTER_MS, IDLE_HEARTBEAT_MS, paceInterval()));
        return;
    }
    sendSame();
    m_idle.start(IDLE_HEARTBEAT_MS);
}
