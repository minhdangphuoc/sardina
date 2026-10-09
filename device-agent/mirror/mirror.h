#ifndef MIRROR_H
#define MIRROR_H

#include <QByteArray>
#include <QElapsedTimer>
#include <QHash>
#include <QList>
#include <QObject>
#include <QPointer>
#include <QSize>
#include <QString>
#include <QTimer>

#include "pacer.h"
#include "retrybudget.h"

class QImage;
class QJsonObject;
class Recorder;
class QLocalSocket;
class Settings;
class StreamIndicator;
class TouchOverlay;
class VideoEncoder;
class MirrorInput;
class DisplayState;

// Text and Binary carry JPEG/PNG images; Vp8 (agent 1.6.0) uses the binary framing with VP8 video.
enum class MirrorEncoding { Text, Binary, Vp8 };

// Streams the device screen until its socket disconnects, captured only through the compositor's
// recorder (the stream ends if it cannot be used). Text frames carry base64, while binary JPEG and VP8
// frames use acknowledged records so capture pauses before the client or socket queue is overrun.
// VP8 drops raw captures under backpressure, never encoded frames, because later deltas depend on
// earlier frames. Its pacer adapts when conversion cannot keep up, and idle messages distinguish a
// still screen from a stalled stream. The client may lower adaptive JPEG quality or size within the
// requested bounds. A keepalive lease ends abandoned streams. Owned by the socket, like LogStream.
class MirrorStream : public QObject
{
    Q_OBJECT
public:
    MirrorStream(QLocalSocket *socket, int fps, int width, int quality, MirrorEncoding encoding = MirrorEncoding::Text,
                 int window = 2, int leaseSeconds = 0, StreamIndicator *indicator = nullptr, bool adapt = false,
                 int bitrateKbps = 0, bool inputRequested = false, const Settings *settings = nullptr,
                 bool phoneState = false);
    ~MirrorStream();

    // Writes the fatal reply {"ok":false,"error":...} in the stream's encoding, flushes,
    // disconnects and cleans up.
    void finish(const QString &error);

    // The phone's settings (agent 1.9.0). Called synchronously from the Settings change, before
    // the D-Bus reply: "screenView" off ends the stream; "control" and "touchIndicator" go to the
    // input hooks below and, when the request opted in with "phoneState":true, a "settings"
    // message tells the client (PLAN-settings-page.md section 7.3).
    void applySetting(const QString &key);
    // The phone's idle mode switch (agent 1.10.6); on when there are no settings.
    bool idleModeOn() const;

    // For the Settings page's status (read only).
    bool active() const { return !m_cleaned; }
    bool inputActive() const { return m_inputActive; }
    qint64 startedAt() const { return m_startedAt; } // ms since the epoch
    QString encodingName() const;
    QString captureName() const; // "native", or "" before the recorder opened

signals:
    // The stream stopped or its capture path changed.
    void stateChanged();

private slots:
    void tick();
    void onRecorderFrame(const QImage &view, bool yInverted);
    void onRecorderFailed(const QString &error, bool fatal);
    void onRecorderTimeout();
    void onClientGone();
    void onUpstream();
    void onLeaseExpired();
    void onInputLeaseExpired();
    void pumpVideo();
    void onPace();
    void onBytesWritten();
    void onIdle();
    void onDisplayChanged();
    void sendSame();
    void wakeFromIdle(qint64 now);
    void onContactChanged(const QPoint &point, bool pressed);

private:
    // S6: enforce the phone's "Allow control" in the input path (allowed=false: setInputActive(false),
    // m_inputEnabled = false, refusal "control disabled on the phone"; allowed=true: re-enable a
    // stream refused for that reason). Returns the "input"/"inputLease"/"inputError" fields for the
    // "settings" message (leading comma, or empty when the request did not ask for input).
    QByteArray applyControlSetting(bool allowed);
    // S7: show or hide the debug touch circle at once (it never draws unless control is active).
    void applyTouchIndicatorSetting(bool on);
    // The input fields of the status line, from the current state (read only).
    QByteArray inputFields() const;
    // The "settings" message (only when the request asked for "phoneState").
    void sendPhoneSettings(const QByteArray &inputFields);
    QByteArray touchIndicatorPath() const;

    void writeLine(const QByteArray &line);
    void writeRecord(const QByteArray &headerJson, const QByteArray &payload);
    // A message without payload: a text line, or a payload-less record in binary mode.
    void writeMessage(const QByteArray &json);
    void handleUpstreamLine(const QByteArray &line);
    void handleSet(const QJsonObject &set);
    void handleInput(const QJsonObject &input);
    void setInputActive(bool active);
    bool allowInputMessage();
    bool allowKeyRequest();
    void softError(const QString &message);
    // Opens the recorder on first use, or again once after a fatal error if it had delivered frames.
    bool ensureRecorder();
    void endWithoutRecorder(const QString &reason);
    static QByteArray captureFields();
    void sendFrame(const QByteArray &hash, const QByteArray &data, const QByteArray &format, const QSize &screen,
                   const QSize &size, qint64 captureMs, const QElapsedTimer &agentClock);
    void cleanup();
    bool isVideo() const { return m_encoding == MirrorEncoding::Vp8; }
    bool binaryFraming() const { return m_encoding != MirrorEncoding::Text; }
    bool linkBusy() const;
    void handleKeyRequest();
    // Encodes one captured frame and sends it, or drops it while the link is behind.
    void videoFrame(const uchar *rows, int width, int height, int bytesPerLine, bool yInverted);
    // `captured`: a frame from the recorder (not a re-encode of the last picture): its stage times
    // (m_stages) go into the header.
    void sendVideoFrame(const QByteArray &data, bool key, qint64 pts, const QSize &screen, const QSize &size,
                        qint64 encodeMs, qint64 convertMs, bool refresh = false, bool captured = false);
    // Frame pacing (agent 1.8.0).
    double paceInterval() const;
    qint64 nextRequestAt() const;
    void notePaceArrival(qint64 at);
    void notePaceCost(double ms, qint64 now);

    QLocalSocket *m_socket;
    int m_fps;
    int m_width;
    int m_quality;
    QTimer m_timer;
    Recorder *m_recorder;
    bool m_recorderDelivered; // the current recorder delivered a frame (worth reopening after a failure)
    QString m_recorderError;  // last recorder failure, the reason the stream ends with
    RetryBudget m_recorderTries; // reopens of a broken recorder
    bool m_recorderStale;     // the pending frame already timed out: drop it when it arrives
    QTimer m_frameTimeout;
    qint64 m_captureTs;
    qint64 m_frame;
    qint64 m_drops;
    QByteArray m_lastHash;
    bool m_slow;
    bool m_cleaned;
    MirrorEncoding m_encoding;
    int m_window;
    int m_leaseSeconds;
    QTimer m_lease;
    QPointer<StreamIndicator> m_indicator;
    bool m_indicated; // streamStarted() was called, so cleanup() owes one streamStopped()
    QByteArray m_upstream;
    QList<qint64> m_pendingAcks;
    qint64 m_lastImageFrame;
    qint64 m_lastAcked;
    QElapsedTimer m_captureClock;
    QString m_stopReason;
    // The phone's settings (agent 1.9.0).
    const Settings *m_settings;
    bool m_phoneState;     // the request asked for "settings" messages
    bool m_inputRequested; // the request asked for input
    qint64 m_startedAt;
    // Adaptive quality (binary only).
    bool m_adapt;
    int m_maxWidth;   // the requested width (0 = native): a set width is clamped to it
    int m_maxQuality; // the requested quality: a set quality is clamped to it
    qint64 m_ticks;   // ticks that reached the skip decision
    qint64 m_linkSkips; // of those, skipped because of the link (unsent bytes or a full window)
    qint64 m_rttMs;   // round trip of the latest acknowledged image, -1 before the first ack
    qint64 m_rttFrame; // that image's frame number
    QElapsedTimer m_streamClock;
    QHash<qint64, qint64> m_sentAt; // image frame -> m_streamClock ms when it was written
    // Remote touch input (agent 1.7.0). The request must opt in, then focused-view heartbeats keep
    // a short lease alive. Every input object except immediate deactivation consumes this bounded
    // dispatch budget before validation; valid gestures are therefore still capped at 20/s.
    MirrorInput *m_input;
    TouchOverlay *m_touchOverlay;
    bool m_controlAllowed;
    bool m_inputEnabled;
    bool m_inputActive;
    bool m_controlRefusalLogged;
    QTimer m_inputLease;
    QList<qint64> m_inputMessageTimes;
    qint64 m_lastInputControlAt;
    // VP8 video (agent 1.6.0).
    VideoEncoder *m_video;
    int m_bitrate;       // target kbit/s
    int m_maxBitrate;    // the requested bitrate: a set bitrate is clamped to it
    QTimer m_pace;       // single shot: the next frame request (fps cap), or a skipped slot while the link is behind
    qint64 m_lastRequestAt; // m_streamClock ms of the last frame request, -1 before the first
    qint64 m_lastKeyAt;  // m_streamClock ms of the last key frame, -1 before the first
    qint64 m_lastPts;    // pts (stream ms) of the last encoded frame, -1 before the first
    bool m_forceKey;     // the next encoded frame is a key frame
    bool m_needRepaint;  // the next request asks for a repaint (start, key frame request, new level)
    bool m_dirty;        // a capture was dropped while the link was behind: capture again when it has room
    bool m_repaintAsked; // the pending request asked for a repaint (a timeout applies)
    qint64 m_keyRequests;
    QList<qint64> m_keyRequestTimes;
    // Frame pacing and the idle screen (agent 1.8.0).
    Pacer m_pacer;        // the slot length (1, 1.5, 2, 3, 4 frame intervals), from the convert + encode time
    double m_gridAt;      // m_streamClock ms of the last frame's slot, -1 before the first frame
    QTimer m_idle;        // single shot: the screen has not changed for a while
    int m_refreshes;      // re-encodes of the last picture since it last changed
    bool m_idleReported;  // that "same" has gone out since the last frame
    qint64 m_lastFrameAt; // m_streamClock ms of the last encoded frame, -1 before the first
    DisplayState *m_display; // blank display: nothing is sent while the screen is still
    QSize m_lastScreen;   // the last encoded frame's screen and output sizes, for refresh frames
    QSize m_lastSize;
    // Per-frame stage times (agent 1.10.7), ms, -1 when unknown: how long the request was held for
    // the pace or the link after the previous frame arrived, the wait for the compositor's render,
    // its readback and delivery, convert, encode, and the socket write of the previous frame.
    struct Stages {
        qint64 hold = -1;
        qint64 wait = -1;
        qint64 readback = -1;
        qint64 convert = -1;
        qint64 encode = -1;
    } m_stages;
    qint64 m_lastArrival; // wall ms of the last recorder frame, 0 before the first
    qint64 m_lastSendMs;  // the socket write of the last video frame, -1 before the first
};

#endif
