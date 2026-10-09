TEMPLATE = app
TARGET = sailfish-devagent
include(../common/common.pri)

# QtGui is for QImage (frame scaling, JPEG).
QT = core dbus network gui
# Native mirror capture through lipstick's Wayland recorder, VP8 through libvpx.
PKGCONFIG += wayland-client vpx

INCLUDEPATH += ../mirror ../input

SOURCES += \
    main.cpp \
    agent.cpp \
    settings.cpp \
    settingsservice.cpp \
    indicator.cpp \
    client.cpp \
    requestreader.cpp \
    modules.cpp \
    moduleprocess.cpp \
    notice.cpp \
    ../mirror/mirror.cpp \
    ../mirror/recorder.cpp \
    ../mirror/videoencoder.cpp \
    ../mirror/displaystate.cpp \
    ../input/mirrorinput.cpp \
    ../input/touchoverlay.cpp \
    ../common/waylandutil.cpp

HEADERS += \
    agent.h \
    settings.h \
    settingsservice.h \
    indicator.h \
    client.h \
    requestreader.h \
    modules.h \
    moduleprocess.h \
    notice.h \
    ../common/firstline.h \
    ../common/idleplan.h \
    ../common/waylandutil.h \
    ../mirror/mirror.h \
    ../mirror/pacer.h \
    ../mirror/yuvrows.h \
    ../mirror/retrybudget.h \
    ../mirror/recorder.h \
    ../mirror/videoencoder.h \
    ../mirror/displaystate.h \
    ../input/mirrorinput.h \
    ../input/touchoverlay.h

WAYLAND_CLIENT_PROTOCOLS = ../mirror/protocol/lipstick-recorder.xml ../input/protocol/alien-manager.xml
include(../common/wayland.pri)

target.path = /usr/bin

unit.files = ../sailfish-devagent.service
unit.path = /usr/lib/systemd/system

# The page in Settings > System. The settings file's directory, /var/lib/sailfish-devagent
# (root:privileged 0770), is created by the spec, not here.
entry.files = ../settings/sailfish-devagent.json
entry.path = /usr/share/jolla-settings/entries

page.files = ../settings/DeveloperAgentPage.qml
page.path = /usr/share/sailfish-devagent/settings

INSTALLS += target unit entry page
