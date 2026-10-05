TEMPLATE = app
TARGET = sailfish-devagent

# Plain Qt only (Qt 5.6 on the phone): no Silica. QtGui is for QImage (frame scaling, JPEG).
QT = core dbus network gui
CONFIG += c++11 console
CONFIG -= app_bundle

AGENT_VERSION = 1.1.0
DEFINES += AGENT_VERSION=\\\"$$AGENT_VERSION\\\"

SOURCES += \
    src/main.cpp \
    src/paths.cpp \
    src/agent.cpp \
    src/screenshot.cpp \
    src/logs.cpp \
    src/capture.cpp \
    src/mirror.cpp \
    src/client.cpp

HEADERS += \
    src/paths.h \
    src/agent.h \
    src/screenshot.h \
    src/logs.h \
    src/capture.h \
    src/mirror.h \
    src/client.h

target.path = /usr/bin

unit.files = sailfish-devagent.service
unit.path = /usr/lib/systemd/system

INSTALLS += target unit

OTHER_FILES += \
    sailfish-devagent.service \
    rpm/sailfish-devagent.spec
