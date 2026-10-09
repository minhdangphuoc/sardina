# A module executable: started by the daemon in /usr/libexec/sailfish-devagent for one stream.
include(common.pri)
QT += network
HEADERS += $$PWD/modulehost.h $$PWD/keepalivelease.h $$PWD/streamlimits.h $$PWD/stallwatch.h
SOURCES += $$PWD/modulehost.cpp $$PWD/keepalivelease.cpp
target.path = /usr/libexec/sailfish-devagent
INSTALLS += target
