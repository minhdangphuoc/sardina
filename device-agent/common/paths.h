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

// /var/lib/sailfish-devagent/settings.json: the phone's settings (agent 1.9.0). The directory is
// root:privileged 0770 (created by the package), so only the agent (effective group privileged)
// and root can read or change the file; the SSH login cannot enter it.
QString settingsPath();

// /var/lib/sailfish-devagent/notice-shown (agent 1.10.1): present once the start notice was shown
// with a banner. The daemon closes its notifications when it stops, so later starts (reboots,
// upgrades) post the notice again silently. Removed with the folder on erase.
QString noticeShownPath();

// /usr/libexec/sailfish-devagent: the module executables (agent 1.11.0), one package each.
QString moduleDir();

// Developer Mode gate: jolla-developer-mode ships /usr/bin/devel-su.
bool developerModeOn();

}

#endif
