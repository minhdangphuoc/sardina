#ifndef CLIENT_H
#define CLIENT_H

#include <QStringList>

// `sailfish-devagent --request <cmd> [--lines N]`: connects to the daemon's
// socket, sends the request, copies the reply to stdout.
//
// Exit codes: 0 reply ok, 1 reply not ok (or stream error), 2 usage,
// 3 agent not running (no socket / connection refused).
namespace Client {

int run(const QStringList &args);

}

#endif
