#include "agent.h"
#include "idleplan.h"
#include "indicator.h"
#include "moduleprocess.h"
#include "modules.h"
#include "paths.h"
#include "settings.h"
#include "settingsservice.h"

#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QStringList>
#include <cstdio>
#include <unistd.h>

namespace {

const int RETRY_MS = 2000;
const int DEVELOPER_MODE_CHECK_MS = 3000;
// An idle mode or frame rate limit change ends the mirror with a reason from restartReason
// (idleplan.h; the extension matches it and connects again once); the Settings page waits for the
// new stream for at most this long.
const int MIRROR_RESTART_MS = 10000;
const char *const DEVELOPER_MODE_OFF = "developer mode is off";
const char *const STOPPED_FROM_PHONE = "stopped from the phone";
// A replaced mirror gets this long to end before it is killed and the new one starts.
const int MIRROR_REPLACE_MS = 2000;

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
    connect(m_indicator, &StreamIndicator::controlChanged, this, &Agent::onControlShown);
    m_retry.setInterval(RETRY_MS);
    m_retry.setSingleShot(true);
    connect(&m_retry, &QTimer::timeout, this, &Agent::tryListen);
    m_restartTimer.setSingleShot(true);
    m_restartTimer.setInterval(MIRROR_RESTART_MS);
    connect(&m_restartTimer, &QTimer::timeout, this, [this]() { setMirrorRestarting(false); });
    m_replaceTimer.setSingleShot(true);
    m_replaceTimer.setInterval(MIRROR_REPLACE_MS);
    connect(&m_replaceTimer, &QTimer::timeout, this, [this]() {
        if (ModuleProcess *mirror = mirrorChild()) {
            mirror->kill();
        }
    });
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
    m_replaceTimer.stop();
    if (m_pendingMirror.fd >= 0) {
        close(m_pendingMirror.fd);
        m_pendingMirror.fd = -1;
    }
    // Streams that end during shutdown must not call back into a half-destroyed agent.
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
            if (child->indicated()) {
                m_indicator->streamStopped(); // it crashed or was killed before saying so
            }
            child->deleteLater();
            changed = true;
        }
    }
    if (!changed) {
        return;
    }
    if (m_pendingMirror.fd >= 0 && !mirrorChild()) {
        m_replaceTimer.stop();
        const PendingMirror next = m_pendingMirror;
        m_pendingMirror.fd = -1;
        spawnMirror(next.fd, next.request, next.client);
    }
    onSessionChanged();
}

ModuleProcess *Agent::mirrorChild() const
{
    const QList<ModuleProcess *> mirrors = children(QStringLiteral("mirror"));
    return mirrors.isEmpty() ? nullptr : mirrors.first();
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
    ModuleProcess *mirror = mirrorChild();
    if (mirror && mirror->ending()) {
        mirror = nullptr;
    }
    if (restart && mirror) {
        fprintf(stderr, "sailfish-devagent: settings: %s changed, restarting the mirror\n", keyName.constData());
        m_mirrorRestarting = true;
        m_restartTimer.start();
        mirror->end(QString::fromLatin1(restart));
    } else if (mirror && key == QLatin1String("screenView") && !m_settings->screenView()) {
        mirror->end(QStringLiteral("screen view disabled on the phone"));
    } else if (mirror) {
        // control goes to the stream's hooks
        mirror->send(QJsonObject{ { QStringLiteral("setting"),
                                    QJsonObject{ { QStringLiteral("key"), key },
                                                 { QStringLiteral("value"), QJsonValue::fromVariant(m_settings->toMap().value(key)) } } } });
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
    if (line.contains(QStringLiteral("status"))) {
        onSessionChanged();
    }
    const QJsonValue indicator = line.value(QStringLiteral("indicator"));
    if (indicator.isString()) {
        const bool started = indicator.toString() == QLatin1String("started");
        if (started != child->indicated()) {
            child->setIndicated(started);
            if (started) {
                m_indicator->streamStarted();
            } else {
                m_indicator->streamStopped();
            }
        }
    } else if (indicator.isObject() && child->indicated()) {
        const bool input = indicator.toObject().value(QStringLiteral("input")).toBool(false);
        if (m_indicator->setInputActive(input) && input) {
            sendInputShown(child, true);
        }
    }
}

void Agent::sendInputShown(ModuleProcess *mirror, bool shown)
{
    mirror->send(QJsonObject{ { QStringLiteral("indicator"), QJsonObject{ { QStringLiteral("inputShown"), shown } } } });
}

// The entry switched between "viewed" and "controlled": control waits for that answer.
void Agent::onControlShown()
{
    if (ModuleProcess *mirror = mirrorChild()) {
        sendInputShown(mirror, m_indicator->showingInput());
    }
    onSessionChanged();
}

QVariantMap Agent::statusMap() const
{
    QVariantMap m = m_settings->toMap();
    m.insert(QStringLiteral("version"), QStringLiteral(AGENT_VERSION));
    m.insert(QStringLiteral("developerMode"), Paths::developerModeOn());
    m.insert(QStringLiteral("modules"), Modules::installedNames());
    const ModuleProcess *mirror = mirrorChild();
    const QJsonObject status = mirror ? mirror->status() : QJsonObject();
    const bool mirrorActive = status.value(QStringLiteral("mirrorActive")).toBool(false);
    m.insert(QStringLiteral("mirrorActive"), mirrorActive);
    m.insert(QStringLiteral("mirrorRestarting"), m_mirrorRestarting);
    m.insert(QStringLiteral("mirrorSince"), mirrorActive ? qint64(status.value(QStringLiteral("mirrorSince")).toDouble()) : qint64(0));
    m.insert(QStringLiteral("mirrorControl"), mirrorActive && status.value(QStringLiteral("mirrorControl")).toBool(false));
    m.insert(QStringLiteral("mirrorEncoding"), mirrorActive ? status.value(QStringLiteral("mirrorEncoding")).toString() : QString());
    m.insert(QStringLiteral("mirrorCapture"), mirrorActive ? status.value(QStringLiteral("mirrorCapture")).toString() : QString());
    const QList<ModuleProcess *> logs = children(QStringLiteral("logs"));
    QString logClient;
    for (ModuleProcess *log : logs) {
        if (!log->client().isEmpty()) {
            logClient = log->client();
        }
    }
    m.insert(QStringLiteral("logStreams"), logs.size());
    m.insert(QStringLiteral("monitorStreams"), children(QStringLiteral("stats")).size());
    m.insert(QStringLiteral("client"), mirrorActive && !mirror->client().isEmpty() ? mirror->client() : logClient);
    return m;
}

int Agent::stopSessions()
{
    int stopped = 0;
    const QString reason = QLatin1String(STOPPED_FROM_PHONE);
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
    startModule(module, fd, request, client);
}

ModuleProcess *Agent::startModule(const QString &module, int fd, const QJsonObject &request, const QString &client,
                                  const QJsonObject &extra)
{
    QJsonObject control = extra;
    control.insert(QStringLiteral("request"), request);
    control.insert(QStringLiteral("client"), client);
    control.insert(QStringLiteral("settings"), QJsonObject::fromVariantMap(m_settings->toMap()));
    QString error;
    ModuleProcess *child = ModuleProcess::start(module, fd, control, client, &error, this);
    if (!child) {
        fprintf(stderr, "sailfish-devagent: cannot start the %s module: %s\n", qPrintable(module), qPrintable(error));
        RequestReader::replyAndClose(fd, errorReply(QStringLiteral("cannot start the %1 module").arg(module)));
        return nullptr;
    }
    close(fd);
    m_children << child;
    connect(child, &ModuleProcess::event, this, &Agent::onChildEvent);
    onSessionChanged();
    return child;
}

// One mirror per daemon: a running one ends with "replaced" (in its own encoding) and the new one
// starts once it has exited, so lipstick never sees two recorders of ours.
void Agent::startMirror(int fd, const QJsonObject &request, const QString &client)
{
    ModuleProcess *running = mirrorChild();
    if (!running) {
        spawnMirror(fd, request, client);
        return;
    }
    if (m_pendingMirror.fd >= 0) {
        RequestReader::replyAndClose(m_pendingMirror.fd, errorReply(QStringLiteral("replaced")));
    }
    m_pendingMirror.fd = fd;
    m_pendingMirror.request = request;
    m_pendingMirror.client = client;
    if (!running->ending()) {
        running->end(QStringLiteral("replaced"));
    }
    if (!m_replaceTimer.isActive()) {
        m_replaceTimer.start();
    }
}

void Agent::spawnMirror(int fd, const QJsonObject &request, const QString &client)
{
    setMirrorRestarting(false);
    QJsonObject extra;
    if (Modules::installed(QStringLiteral("input"))) {
        extra.insert(QStringLiteral("inputModule"), Modules::executable(QStringLiteral("input")));
    }
    startModule(QStringLiteral("mirror"), fd, request, client, extra);
}
