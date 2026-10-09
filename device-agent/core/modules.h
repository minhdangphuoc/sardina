#ifndef MODULES_H
#define MODULES_H

#include <QJsonObject>
#include <QString>
#include <QStringList>

// The feature modules: the request each serves and the phone switch that gates it. A module is
// installed when its executable is present; that is checked on every request, so an install or
// removal shows at once.
struct ModuleSpec {
    const char *name;    // also the package suffix: sailfish-devagent-<name>
    const char *command; // the request's "cmd", or nullptr (input: used by the mirror only)
    const char *gate;    // the Settings key that must be on, or nullptr
};

namespace Modules {

const ModuleSpec *forCommand(const QString &command);
// /usr/libexec/sailfish-devagent/sailfish-devagent-<name>
QString executable(const QString &name);
bool installed(const QString &name);
// The installed modules in their fixed order: logs, stats, screenshot, mirror, input.
QStringList installedNames();
// The phone's keypad ({"model":...,"keys":[...]}) from `sailfish-devagent-input --keypad`, run at
// most once per version of that executable; empty without the input module or a keypad.
QJsonObject keypadInfo();

}

#endif
