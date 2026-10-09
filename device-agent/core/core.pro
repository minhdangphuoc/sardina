TEMPLATE = app
TARGET = sailfish-devagent
include(../common/common.pri)

# The resident daemon links no QtGui, Wayland or libvpx: those live in the mirror's process.
QT = core dbus network

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
    notice.cpp

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
    ../common/idleplan.h

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
