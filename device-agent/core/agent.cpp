#include "agent.h"
#include "idleplan.h"
#include "indicator.h"
#include "mirror.h"
#include "mirrorinput.h"
#include "moduleprocess.h"
#include "modules.h"
#include "paths.h"
#include "settings.h"
#include "settingsservice.h"

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QLocalSocket>
#include <QStringList>
#include <cstdio>
#include <unistd.h>

namespace {

const int RETRY_MS = 2000;
const int MIRROR_DEFAULT_FPS = 4;
const int MIRROR_DEFAULT_WIDTH = 360;
const int MIRROR_DEFAULT_QUALITY = 60;
const int MIRROR_MAX_WIDTH = 2160;
const int MIRROR_MIN_WIDTH = 90;
const int MIRROR_DEFAULT_WINDOW = 2;
const int MIRROR_DEFAULT_LEASE = 60;
const int MIRROR_MAX_FPS = 10;
const int MIRROR_VIDEO_DEFAULT_FPS = 30;
const int MIRROR_VIDEO_DEFAULT_BITRATE = 2000;
const int MIRROR_VIDEO_MIN_BITRATE = 100;
const int MIRROR_VIDEO_MAX_BITRATE = 20000;
const int MIRROR_VIDEO_WINDOW = 4;
const int MIRROR_VIDEO_FAST_WINDOW = 8;
const int MIRROR_MIN_LEASE = 10;
const int MIRROR_MAX_LEASE = 300;

const int DEVELOPER_MODE_CHECK_MS = 3000;
// An idle mode or frame rate limit change ends the mirror with a reason from restartReason
// (idleplan.h; the extension matches it and connects again once); the Settings page waits for the
// new stream for at most this long.
const int MIRROR_RESTART_MS = 10000;
const char *const DEVELOPER_MODE_OFF = "developer mode is off";
const char *const STOPPED_FROM_PHONE = "stopped from the phone";

// The "client" request field (agent 1.9.0): informational only, shown on the Settings page.
// Anything outside [A-Za-z0-9 ._-] is dropped, then the text is cut to 64 characters.
const int CLIENT_MAX_CHARS = 64;
QString clientName(const QJsonValue &value)
{
    if (!value.isString()) {
        return QString();
    }
    const QString raw = value.toString().left(4096);
    QString out;
    for (const QChar c : raw) {
        const ushort u = c.unicode();
        if ((u >= 'A' && u <= 'Z') || (u >= 'a' && u <= 'z') || (u >= '0' && u <= '9') || u == ' ' || u == '.'
            || u == '_' || u == '-') {
            out += c;
        }
    }
    return out.left(CLIENT_MAX_CHARS).trimmed();
}

int mirrorLease(const QJsonValue &requested, bool required)
{
    if (requested.isUndefined() || (requested.isDouble() && requested.toDouble() < 1)) {
        return required ? MIRROR_DEFAULT_LEASE : 0;
    }
    return qBound(MIRROR_MIN_LEASE, requested.toInt(MIRROR_DEFAULT_LEASE), MIRROR_MAX_LEASE);
}

QJsonObject errorReply(const QString &message)
{
    QJsonObject o;
    o.insert(QStringLiteral("ok"), false);
    o.insert(QStringLiteral("error"), message);
    return o;
}

}

Agent::Agent(QObject *parent)
    : QObject(parent)
    , m_mirrorRestarting(false)
    , m_settings(new Settings(this))
    , m_indicator(new StreamIndicator(m_settings, this))
    , m_service(nullptr)
    , m_notice(m_settings)
{
    m_settings->load();
    m_service = new SettingsService(m_settings, this, this);
    // Direct connection: a change reaches the running sessions inside the Set* call.
    connect(m_settings, &Settings::changed, this, &Agent::onSettingChanged);
    connect(m_indicator, &StreamIndicator::controlChanged, this, &Agent::onSessionChanged);
    m_retry.setInterval(RETRY_MS);
    m_retry.setSingleShot(true);
    connect(&m_retry, &QTimer::timeout, this, &Agent::tryListen);
    m_restartTimer.setSingleShot(true);
    m_restartTimer.setInterval(MIRROR_RESTART_MS);
    connect(&m_restartTimer, &QTimer::timeout, this, [this]() { setMirrorRestarting(false); });
    m_developerModeCheck.setInterval(DEVELOPER_MODE_CHECK_MS);
    connect(&m_developerModeCheck, &QTimer::timeout, this, &Agent::checkDeveloperMode);
    connect(&m_server, &HandoffServer::connection, this, &Agent::onConnection);
    // chmod 0600 on the socket: only the owning user may connect.
    m_server.setSocketOptions(QLocalServer::UserAccessOption);
}

Agent::~Agent()
{
    stop();
}

void Agent::start()
{
    tryListen();
}

void Agent::tryListen()
{
    if (m_server.isListening()) {
        return;
    }
    const QString userDir = Paths::userRuntimeDir();
    if (!QDir(userDir).exists()) {
        // The user session (and its bus) is not up yet; the unit is ordered after it, but be safe.
        fprintf(stderr, "sailfish-devagent: %s does not exist yet, retrying\n", qPrintable(userDir));
        m_retry.start();
        return;
    }
    const QString dir = Paths::agentRuntimeDir();
    if (!QDir().mkpath(dir)) {
        fprintf(stderr, "sailfish-devagent: cannot create %s, retrying\n", qPrintable(dir));
        m_retry.start();
        return;
    }
    QFile::setPermissions(dir, QFile::ReadOwner | QFile::WriteOwner | QFile::ExeOwner);

    const QString path = Paths::socketPath();
    QLocalServer::removeServer(path); // a stale socket from an unclean stop
    if (!m_server.listen(path)) {
        fprintf(stderr, "sailfish-devagent: cannot listen on %s: %s, retrying\n", qPrintable(path),
                qPrintable(m_server.errorString()));
        m_retry.start();
        return;
    }
    fprintf(stderr, "sailfish-devagent %s: listening on %s (modules: %s)\n", AGENT_VERSION, qPrintable(path),
            qPrintable(Modules::installedNames().join(QStringLiteral(", "))));
    StartNotice::closeStaleStreamEntries();
    m_notice.post();
    m_service->start();
}

void Agent::stop()
{
    m_retry.stop();
    m_developerModeCheck.stop();
    m_service->stop();
    // Streams that end during shutdown must not call back into a half-destroyed agent.
    if (m_mirror) {
        m_mirror->disconnect(this);
    }
    for (ModuleProcess *child : m_children) {
        child->disconnect(this);
        child->terminate();
    }
    m_indicator->disconnect(this);
    m_indicator->closeNow();
    const bool wasListening = m_server.isListening();
    if (wasListening) {
        m_server.close();
        // No entry of a stopped agent stays in the notification list (1.10.1): the start notice
        // goes too, and the next start posts it again silently (Paths::noticeShownPath()).
        StartNotice::removeAll();
        m_notice.forget();
    }
    QLocalServer::removeServer(Paths::socketPath());
    QDir dir(Paths::agentRuntimeDir());
    if (dir.exists()) {
        // Only our own files live here: the socket and screenshots not yet fetched.
        dir.removeRecursively();
    }
    // lipstick's staging folder in the home directory: a capture cut short by this stop leaves its
    // file there. Only the agent's own file names, then the folder if it is empty.
    QDir staging(Paths::screenshotStagingDir());
    if (staging.exists()) {
        for (const QString &name : staging.entryList(QStringList() << QStringLiteral("shot-*.png"), QDir::Files)) {
            staging.remove(name);
        }
        QDir().rmdir(Paths::screenshotStagingDir());
    }
}

void Agent::reapChildren()
{
    bool changed = false;
    for (int i = m_children.size() - 1; i >= 0; --i) {
        ModuleProcess *child = m_children.at(i);
        if (child->reap()) {
            m_children.removeAt(i);
            child->deleteLater();
            changed = true;
        }
    }
    if (changed) {
        onSessionChanged();
    }
}

QList<ModuleProcess *> Agent::children(const QString &module) const
{
    QList<ModuleProcess *> out;
    for (ModuleProcess *child : m_children) {
        if (child->module() == module) {
            out << child;
        }
    }
    return out;
}

void Agent::setMirrorRestarting(bool on)
{
    if (m_mirrorRestarting == on) {
        return;
    }
    m_mirrorRestarting = on;
    if (on) {
        m_restartTimer.start();
    } else {
        m_restartTimer.stop();
    }
    if (m_service) {
        m_service->notifyChanged(QStringLiteral("mirrorRestarting"));
    }
}

void Agent::onSettingChanged(const QString &key)
{
    // A running mirror cannot change its idle behaviour or frame rate limit: it ends with a reason VS Code answers by
    // connecting once more, and the new stream starts with the new value.
    const QByteArray keyName = key.toUtf8();
    const char *restart = restartReason(keyName.constData());
    if (restart && m_mirror && m_mirror->active()) {
        fprintf(stderr, "sailfish-devagent: settings: %s changed, restarting the mirror\n", keyName.constData());
        m_mirrorRestarting = true;
        m_restartTimer.start();
        m_mirror->finish(QString::fromLatin1(restart));
    } else if (m_mirror) {
        m_mirror->applySetting(key); // screenView off ends it; control/touchIndicator go to its hooks
    }
    if (key == QLatin1String("logs") && !m_settings->logs()) {
        for (ModuleProcess *child : children(QStringLiteral("logs"))) {
            child->end(QStringLiteral("logs disabled on the phone"));
        }
    } else if (key == QLatin1String("indicator")) {
        m_indicator->refresh();
    } else if (key == QLatin1String("muteNotifications")) {
        if (m_settings->muteNotifications()) {
            m_notice.close();
        } else {
            m_notice.post(true);
        }
        m_indicator->refresh();
    }
    m_service->notifyChanged(key);
}

void Agent::onSessionChanged()
{
    if (m_children.isEmpty()) {
        m_developerModeCheck.stop();
    } else if (!m_developerModeCheck.isActive()) {
        m_developerModeCheck.start();
    }
    m_service->notifyChanged(QStringLiteral("session"));
}

void Agent::checkDeveloperMode()
{
    if (Paths::developerModeOn()) {
        return;
    }
    for (ModuleProcess *child : m_children) {
        if (!child->ending()) {
            child->end(QLatin1String(DEVELOPER_MODE_OFF));
        }
    }
}

void Agent::onChildEvent(ModuleProcess *child, const QJsonObject &line)
{
    Q_UNUSED(child);
    if (line.contains(QStringLiteral("status"))) {
        onSessionChanged();
    }
}

QVariantMap Agent::statusMap() const
{
    QVariantMap m = m_settings->toMap();
    m.insert(QStringLiteral("version"), QStringLiteral(AGENT_VERSION));
    m.insert(QStringLiteral("developerMode"), Paths::developerModeOn());
    m.insert(QStringLiteral("modules"), Modules::installedNames());
    const bool mirrorActive = m_mirror && m_mirror->active();
    m.insert(QStringLiteral("mirrorActive"), mirrorActive);
    m.insert(QStringLiteral("mirrorRestarting"), m_mirrorRestarting);
    m.insert(QStringLiteral("mirrorSince"), mirrorActive ? m_mirror->startedAt() : qint64(0));
    m.insert(QStringLiteral("mirrorControl"), mirrorActive && m_mirror->inputActive());
    m.insert(QStringLiteral("mirrorEncoding"), mirrorActive ? m_mirror->encodingName() : QString());
    m.insert(QStringLiteral("mirrorCapture"), mirrorActive ? m_mirror->captureName() : QString());
    const QList<ModuleProcess *> logs = children(QStringLiteral("logs"));
    QString logClient;
    for (ModuleProcess *log : logs) {
        if (!log->client().isEmpty()) {
            logClient = log->client();
        }
    }
    m.insert(QStringLiteral("logStreams"), logs.size());
    m.insert(QStringLiteral("monitorStreams"), children(QStringLiteral("stats")).size());
    m.insert(QStringLiteral("client"), mirrorActive && !m_mirrorClient.isEmpty() ? m_mirrorClient : logClient);
    return m;
}

int Agent::stopSessions()
{
    int stopped = 0;
    const QString reason = QLatin1String(STOPPED_FROM_PHONE);
    if (m_mirror && m_mirror->active()) {
        m_mirror->finish(reason);
        ++stopped;
    }
    for (ModuleProcess *child : m_children) {
        if (child->module() != QLatin1String("screenshot") && !child->ending()) {
            child->end(reason);
            ++stopped;
        }
    }
    return stopped;
}

void Agent::onConnection(int fd)
{
    RequestReader *reader = new RequestReader(fd, this);
    connect(reader, &RequestReader::request, this, &Agent::onRequest);
    connect(reader, &RequestReader::failed, this, &Agent::onRequestFailed);
}

void Agent::onRequestFailed(RequestReader *reader, const QString &error)
{
    if (!error.isEmpty()) {
        RequestReader::replyAndClose(reader->takeFd(), errorReply(error));
    }
    reader->deleteLater();
}

QJsonObject Agent::pingReply() const
{
    const QStringList modules = Modules::installedNames();
    QJsonObject o;
    o.insert(QStringLiteral("ok"), true);
    o.insert(QStringLiteral("version"), QStringLiteral(AGENT_VERSION));
    o.insert(QStringLiteral("developerMode"), Paths::developerModeOn());
    o.insert(QStringLiteral("socket"), Paths::socketPath());
    o.insert(QStringLiteral("modules"), QJsonArray::fromStringList(modules));
    // The fields older extensions read, each only with the module that serves it.
    if (modules.contains(QStringLiteral("mirror"))) {
        o.insert(QStringLiteral("mirrorEncodings"), QJsonArray{ QStringLiteral("text"), QStringLiteral("binary"), QStringLiteral("vp8") });
    }
    if (modules.contains(QStringLiteral("mirror")) && modules.contains(QStringLiteral("input"))) {
        QJsonArray mirrorInput{ QStringLiteral("tap"), QStringLiteral("swipe"), QStringLiteral("down"), QStringLiteral("move"),
                                QStringLiteral("up") };
        // `key` and `keypad` only when a keypad device and a model name exist: the extension shows
        // the keypad by model, and key presses still pass the mirror's input lease and whitelist.
        const QJsonObject keypad = Modules::keypadInfo();
        if (!keypad.value(QStringLiteral("model")).toString().isEmpty()
            && !keypad.value(QStringLiteral("keys")).toArray().isEmpty()) {
            mirrorInput.append(QStringLiteral("key"));
            o.insert(QStringLiteral("keypad"), keypad);
        }
        o.insert(QStringLiteral("mirrorInput"), mirrorInput);
    }
    o.insert(QStringLiteral("settingsPage"), true);
    if (modules.contains(QStringLiteral("logs"))) {
        o.insert(QStringLiteral("logFormats"), QJsonArray{ QStringLiteral("text"), QStringLiteral("json") });
    }
    if (modules.contains(QStringLiteral("stats"))) {
        o.insert(QStringLiteral("stats"), true);
    }
    o.insert(QStringLiteral("settings"), QJsonObject::fromVariantMap(m_settings->toMap()));
    return o;
}

// Gates in order: known command, Developer Mode, module installed, phone switch. Nothing of a
// module runs before all of them passed.
void Agent::onRequest(RequestReader *reader, const QJsonObject &request)
{
    reader->deleteLater();
    const int fd = reader->takeFd();
    const QString cmd = request.value(QStringLiteral("cmd")).toString();
    if (cmd == QLatin1String("ping")) {
        // Answers even with Developer Mode off, so VS Code can say why the rest is refused.
        RequestReader::replyAndClose(fd, pingReply());
        return;
    }
    const ModuleSpec *spec = Modules::forCommand(cmd);
    if (!spec) {
        RequestReader::replyAndClose(fd, errorReply(QStringLiteral("unknown command")));
        return;
    }
    // Developer Mode gate: turning it off disables the agent without uninstalling it.
    if (!Paths::developerModeOn()) {
        RequestReader::replyAndClose(fd, errorReply(QLatin1String(DEVELOPER_MODE_OFF)));
        return;
    }
    const QString module = QLatin1String(spec->name);
    if (!Modules::installed(module)) {
        RequestReader::replyAndClose(fd, errorReply(module + QStringLiteral(" module not installed")));
        return;
    }
    // The phone's settings (agent 1.9.0). "Allow screen view" covers single screenshots too.
    if (spec->gate && !m_settings->toMap().value(QLatin1String(spec->gate)).toBool()) {
        const QString refusal = QLatin1String(spec->gate) == QLatin1String("logs")
            ? QStringLiteral("logs disabled on the phone")
            : QStringLiteral("screen view disabled on the phone");
        RequestReader::replyAndClose(fd, errorReply(refusal));
        return;
    }
    const QString client = clientName(request.value(QStringLiteral("client")));
    if (module == QLatin1String("mirror")) {
        startMirror(fd, request, client);
        return;
    }
    startModule(*spec, fd, request, client);
}

void Agent::startModule(const ModuleSpec &spec, int fd, const QJsonObject &request, const QString &client)
{
    const QString module = QLatin1String(spec.name);
    QJsonObject control;
    control.insert(QStringLiteral("request"), request);
    control.insert(QStringLiteral("client"), client);
    control.insert(QStringLiteral("settings"), QJsonObject::fromVariantMap(m_settings->toMap()));
    QString error;
    ModuleProcess *child = ModuleProcess::start(module, fd, control, client, &error, this);
    if (!child) {
        fprintf(stderr, "sailfish-devagent: cannot start the %s module: %s\n", qPrintable(module), qPrintable(error));
        RequestReader::replyAndClose(fd, errorReply(QStringLiteral("cannot start the %1 module").arg(module)));
        return;
    }
    close(fd);
    m_children << child;
    connect(child, &ModuleProcess::event, this, &Agent::onChildEvent);
    onSessionChanged();
}

// The mirror still runs inside the daemon (until it becomes a module process).
void Agent::startMirror(int fd, const QJsonObject &request, const QString &client)
{
    QLocalSocket *socket = new QLocalSocket(this);
    if (!socket->setSocketDescriptor(fd, QLocalSocket::ConnectedState, QIODevice::ReadWrite)) {
        close(fd);
        delete socket;
        return;
    }
    connect(socket, &QLocalSocket::disconnected, socket, &QObject::deleteLater);
    // Anything but "binary" or "vp8" is text, like the other clamped arguments.
    const QString encodingName = request.value(QStringLiteral("encoding")).toString();
    const MirrorEncoding encoding = encodingName == QLatin1String("binary") ? MirrorEncoding::Binary
        : encodingName == QLatin1String("vp8")                              ? MirrorEncoding::Vp8
                                                                            : MirrorEncoding::Text;
    const bool video = encoding == MirrorEncoding::Vp8;
    int fps = request.value(QStringLiteral("fps")).toInt(video ? MIRROR_VIDEO_DEFAULT_FPS : MIRROR_DEFAULT_FPS);
    fps = video ? videoFps(fps, m_settings->maxFps()) : qBound(1, fps, MIRROR_MAX_FPS);
    int width = request.value(QStringLiteral("width")).toInt(MIRROR_DEFAULT_WIDTH);
    if (width <= 0) {
        width = 0; // native size
    } else {
        width = qBound(MIRROR_MIN_WIDTH, width, MIRROR_MAX_WIDTH);
    }
    const int quality = qBound(1, request.value(QStringLiteral("quality")).toInt(MIRROR_DEFAULT_QUALITY), 100);
    const int lease = mirrorLease(request.value(QStringLiteral("lease")), encoding != MirrorEncoding::Text);
    // One mirror per daemon: the older stream is told (in its own encoding) and closed first.
    if (m_mirror) {
        m_mirror->finish(QStringLiteral("replaced"));
        delete m_mirror.data();
    }
    const bool adapt = request.value(QStringLiteral("adapt")).toBool(false);
    const int bitrate = video ? qBound(MIRROR_VIDEO_MIN_BITRATE,
                                       request.value(QStringLiteral("bitrate")).toInt(MIRROR_VIDEO_DEFAULT_BITRATE),
                                       MIRROR_VIDEO_MAX_BITRATE)
                              : 0;
    const bool input = request.value(QStringLiteral("input")).toBool(false);
    const bool phoneState = request.value(QStringLiteral("phoneState")).toBool(false);
    m_mirrorClient = client;
    setMirrorRestarting(false);
    m_mirror = new MirrorStream(socket, fps, width, quality, encoding,
                                video ? (fps > 30 ? MIRROR_VIDEO_FAST_WINDOW : MIRROR_VIDEO_WINDOW) : MIRROR_DEFAULT_WINDOW, lease, m_indicator, adapt,
                                bitrate, input, m_settings, phoneState);
    connect(m_mirror.data(), &MirrorStream::stateChanged, this, &Agent::onSessionChanged);
    onSessionChanged();
}
