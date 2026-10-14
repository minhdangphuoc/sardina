TEMPLATE = app
TARGET = sailfish-devagent-debugmonitor
include(../common/module.pri)
QT = core network
SOURCES += main.cpp debugmonitor.cpp
HEADERS += debugmonitor.h
