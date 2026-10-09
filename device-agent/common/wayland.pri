# Client code for Lipstick's private protocols, generated from WAYLAND_CLIENT_PROTOCOLS (see each
# file's copyright comment for its source and licence).
PKGCONFIG += wayland-client
wayland_header.input = WAYLAND_CLIENT_PROTOCOLS
wayland_header.output = ${QMAKE_FILE_BASE}-client-protocol.h
wayland_header.commands = wayland-scanner client-header < ${QMAKE_FILE_IN} > ${QMAKE_FILE_OUT}
wayland_header.variable_out = HEADERS
wayland_header.CONFIG += target_predeps no_link
wayland_code.input = WAYLAND_CLIENT_PROTOCOLS
wayland_code.output = ${QMAKE_FILE_BASE}-protocol.c
wayland_code.commands = wayland-scanner private-code < ${QMAKE_FILE_IN} > ${QMAKE_FILE_OUT}
wayland_code.variable_out = SOURCES
QMAKE_EXTRA_COMPILERS += wayland_header wayland_code
