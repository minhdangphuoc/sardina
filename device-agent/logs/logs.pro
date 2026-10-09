TEMPLATE = app
TARGET = sailfish-devagent-logs
include(../common/module.pri)
QT = core network

SOURCES += main.cpp logs.cpp
HEADERS += logs.h
