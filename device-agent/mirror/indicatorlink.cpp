#include "indicatorlink.h"
#include "modulehost.h"

IndicatorLink::IndicatorLink(ModuleHost *host, QObject *parent)
    : QObject(parent)
    , m_host(host)
    , m_wantInput(false)
    , m_inputShown(false)
{
}

void IndicatorLink::send(const QJsonValue &value)
{
    QJsonObject event;
    event.insert(QStringLiteral("indicator"), value);
    m_host->sendEvent(event);
}

void IndicatorLink::streamStarted()
{
    send(QStringLiteral("started"));
}

void IndicatorLink::streamStopped()
{
    m_wantInput = false;
    m_inputShown = false;
    send(QStringLiteral("stopped"));
}

bool IndicatorLink::setInputActive(bool active)
{
    if (!active && !m_wantInput) {
        return true; // nothing asked for, nothing to take back
    }
    m_wantInput = active;
    if (!active) {
        m_inputShown = false;
    }
    send(QJsonObject{ { QStringLiteral("input"), active } });
    return !active || m_inputShown;
}

void IndicatorLink::handle(const QJsonObject &indicator)
{
    const bool shown = indicator.value(QStringLiteral("inputShown")).toBool(false);
    // A late answer must not bring back control that was given up meanwhile.
    const bool ready = shown && m_wantInput && !m_inputShown;
    m_inputShown = shown && m_wantInput;
    if (ready) {
        emit inputReady();
    }
}
