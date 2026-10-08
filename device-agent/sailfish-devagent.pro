TEMPLATE = app
TARGET = sailfish-devagent

# Plain Qt only (Qt 5.6 on the phone): no Silica. QtGui is for QImage (frame scaling, JPEG).
QT = core dbus network gui
CONFIG += c++11 console link_pkgconfig
CONFIG -= app_bundle
# Native mirror capture through lipstick's Wayland recorder (src/recorder.cpp).
PKGCONFIG += wayland-client
# VP8 video for the mirror (src/videoencoder.cpp): libvpx-devel from the target's repositories.
PKGCONFIG += vpx

AGENT_VERSION = 1.10.2
DEFINES += AGENT_VERSION=\\\"$$AGENT_VERSION\\\"

SOURCES += \
    src/main.cpp \
    src/paths.cpp \
    src/agent.cpp \
    src/screenshot.cpp \
    src/logs.cpp \
    src/stats.cpp \
    src/capture.cpp \
    src/mirror.cpp \
    src/mirrorinput.cpp \
    src/touchoverlay.cpp \
    src/indicator.cpp \
    src/recorder.cpp \
    src/waylandutil.cpp \
    src/videoencoder.cpp \
    src/settings.cpp \
    src/settingsservice.cpp \
    src/client.cpp

HEADERS += \
    src/paths.h \
    src/agent.h \
    src/screenshot.h \
    src/logs.h \
    src/stats.h \
    src/statsmath.h \
    src/capture.h \
    src/mirror.h \
    src/pacer.h \
    src/mirrorinput.h \
    src/touchoverlay.h \
    src/indicator.h \
    src/recorder.h \
    src/waylandutil.h \
    src/videoencoder.h \
    src/settings.h \
    src/settingsservice.h \
    src/client.h \
    src/firstline.h

# Client code for Lipstick's private recorder and overlay protocols, generated from the copies in
# protocol/ (see each file's copyright comment for its source and licence).
WAYLAND_CLIENT_PROTOCOLS = \
    protocol/lipstick-recorder.xml \
    protocol/alien-manager.xml
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

target.path = /usr/bin

unit.files = sailfish-devagent.service
unit.path = /usr/lib/systemd/system

# The page in Settings > System (agent 1.9.0). The settings file's directory,
# /var/lib/sailfish-devagent (root:privileged 0770), is created by the spec, not here.
entry.files = settings/sailfish-devagent.json
entry.path = /usr/share/jolla-settings/entries

page.files = settings/DeveloperAgentPage.qml
page.path = /usr/share/sailfish-devagent/settings

INSTALLS += target unit entry page

OTHER_FILES += \
    settings/sailfish-devagent.json \
    settings/DeveloperAgentPage.qml \
    protocol/lipstick-recorder.xml \
    protocol/alien-manager.xml \
    sailfish-devagent.service \
    rpm/sailfish-devagent.spec
