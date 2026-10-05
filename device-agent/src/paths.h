#ifndef PATHS_H
#define PATHS_H

#include <QString>

// Everything derived from the uid the agent runs as (defaultuser, 100000 on
// current phones), so nothing here hard-codes the uid.
namespace Paths {

// /run/user/<uid>
QString userRuntimeDir();

// /run/user/<uid>/sailfish-devagent (socket and screenshots; mode 0700)
QString agentRuntimeDir();

// <home>/sailfish-devagent: lipstick only writes screenshots under the home directory and
// refuses hidden path parts (checked on 5.1.0.11), so it writes here; the agent then moves the
// file into agentRuntimeDir() and removes this folder again.
QString screenshotStagingDir();

// /run/user/<uid>/sailfish-devagent/agent.sock
QString socketPath();

// unix:path=/run/user/<uid>/dbus/user_bus_socket
QString sessionBusAddress();

// Whether lipstick accepts a .jpg staging path (decided by the M0.3 measurement; until then the
// agent asks for .png and encodes JPEG itself).
bool lipstickWritesJpeg();

// Developer Mode gate: jolla-developer-mode ships /usr/bin/devel-su.
bool developerModeOn();

}

#endif
