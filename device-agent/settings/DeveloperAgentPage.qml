// The "Developer agent" page in Settings > System (sailfish-devagent 1.9.0).
// Every value comes from the agent over the session bus; a switch only changes after the agent
// accepted the change and reported the new state. The agent accepts changes only from callers in
// the "privileged" group (this Settings app), never from the SSH login VS Code uses.

import QtQuick 2.6
import Sailfish.Silica 1.0
import Nemo.DBus 2.0

Page {
    id: page

    property var st: ({})
    readonly property bool available: agent.status === DBusInterface.Available
    readonly property bool mirrorActive: available && st.mirrorActive === true
    readonly property int logStreams: available && st.logStreams !== undefined ? st.logStreams : 0

    function levelIndex(level) {
        return level === "quiet" ? 1 : level === "minimal" ? 2 : 0
    }

    // The status travels as a JSON string (GetStatusJson, ChangedJson), parsed here, so nothing
    // depends on how Nemo.DBus hands an a{sv} variant map to JavaScript.
    function applyJson(text) {
        try {
            var parsed = JSON.parse(text)
            page.st = (parsed !== null && typeof parsed === "object") ? parsed : ({})
        } catch (e) {
            console.log("devagent page: bad status reply: " + e)
            page.st = ({})
        }
    }

    function refresh() {
        if (!available) {
            page.st = ({})
            return
        }
        agent.call("GetStatusJson", [], function(result) {
            page.applyJson(result)
        }, function(error, message) {
            console.log("devagent page: GetStatusJson failed: " + error + " " + message)
            page.st = ({})
        })
    }

    function showMessage(text) {
        messageLabel.text = text
        messageTimer.restart()
    }

    function refused(name) {
        refresh()
        showMessage("The agent refused the change: " + (name ? name : "unknown error"))
    }

    function setBool(key, value) {
        agent.typedCall("SetBool", [{ "type": "s", "value": key }, { "type": "b", "value": value }],
                        function() { refresh() }, function(name) { refused(name) })
    }

    function setString(key, value) {
        agent.typedCall("SetString", [{ "type": "s", "value": key }, { "type": "s", "value": value }],
                        function() { refresh() }, function(name) { refused(name) })
    }

    function stopSessions() {
        agent.typedCall("StopSessions", [], function(count) {
            refresh()
            if (count === 1) {
                showMessage("Stopped 1 session.")
            } else if (count > 1) {
                showMessage("Stopped " + count + " sessions.")
            } else {
                showMessage("No session was running.")
            }
        }, function(name) { refused(name) })
    }

    onStChanged: {
        var index = levelIndex(st.indicator)
        if (indicatorBox.currentIndex !== index) {
            indicatorBox.currentIndex = index
        }
    }

    onStatusChanged: {
        if (status === PageStatus.Active) {
            refresh()
        }
    }

    Component.onCompleted: refresh()

    DBusInterface {
        id: agent

        bus: DBus.SessionBus
        service: "io.github.minhdangphuoc.SailfishDevAgent"
        path: "/io/github/minhdangphuoc/SailfishDevAgent"
        iface: "io.github.minhdangphuoc.SailfishDevAgent"
        watchServiceStatus: true
        signalsEnabled: true

        // The agent's ChangedJson(s key, s status) signal. Nemo.DBus calls the JavaScript function
        // named like the signal with its first letter lower-cased (QML methods cannot start with a
        // capital letter; a page that defines one does not load).
        function changedJson(key, status) {
            page.applyJson(status)
        }

        // The older Changed(s key) signal: only a prompt to ask again.
        function changed(key) {
            page.refresh()
        }

        onStatusChanged: {
            page.refresh()
        }
    }

    // Safety net in case the signal is not delivered: ask again while the page is showing.
    Timer {
        interval: 3000
        repeat: true
        running: page.status === PageStatus.Active && page.available
        onTriggered: page.refresh()
    }

    Timer {
        id: messageTimer
        interval: 5000
        onTriggered: messageLabel.text = ""
    }

    SilicaFlickable {
        anchors.fill: parent
        contentHeight: column.height + Theme.paddingLarge

        Column {
            id: column

            width: parent.width
            spacing: Theme.paddingMedium

            PageHeader {
                title: "Developer agent"
            }

            Label {
                x: Theme.horizontalPageMargin
                width: parent.width - 2 * x
                wrapMode: Text.Wrap
                color: Theme.highlightColor
                text: "The developer agent lets VS Code take screenshots, mirror and control the screen, and read system logs over its SSH login, while Developer Mode is on. These settings apply at once and override what VS Code asks for."
            }

            InfoLabel {
                visible: !page.available
                text: "The developer agent service is not running. Use \"Device Agent Status\" in VS Code, or on the phone: systemctl status sailfish-devagent"
            }

            SectionHeader {
                text: "Permissions"
            }

            TextSwitch {
                id: screenViewSwitch
                automaticCheck: false
                enabled: page.available
                checked: page.st.screenView === true
                text: "Allow screen view"
                description: "Live mirror and screenshots in VS Code. Turning this off ends a running mirror at once."
                onClicked: page.setBool("screenView", !checked)
            }

            TextSwitch {
                id: controlSwitch
                automaticCheck: false
                enabled: page.available && page.st.screenView === true
                checked: page.st.control === true
                text: "Allow control from VS Code"
                description: "Taps and swipes from the mirror panel. Turning this off stops control at once; viewing continues."
                onClicked: page.setBool("control", !checked)
            }

            TextSwitch {
                id: logsSwitch
                automaticCheck: false
                enabled: page.available
                checked: page.st.logs === true
                text: "Allow system logs"
                description: "Streaming the system journal to VS Code. Turning this off ends a running log stream."
                onClicked: page.setBool("logs", !checked)
            }

            SectionHeader {
                text: "Indication"
            }

            ComboBox {
                id: indicatorBox
                enabled: page.available
                label: "Session indicator"
                currentIndex: 0

                menu: ContextMenu {
                    MenuItem {
                        text: "Normal"
                        onClicked: page.setString("indicator", "normal")
                    }
                    MenuItem {
                        text: "Quiet"
                        onClicked: page.setString("indicator", "quiet")
                    }
                    MenuItem {
                        text: "Minimal"
                        onClicked: page.setString("indicator", "minimal")
                    }
                }
            }

            Label {
                x: Theme.horizontalPageMargin
                width: parent.width - 2 * x
                wrapMode: Text.Wrap
                font.pixelSize: Theme.fontSizeExtraSmall
                color: Theme.secondaryHighlightColor
                text: "Normal: a banner when a session starts, and an entry in Events. Quiet: no banner or sound, the Events entry only. Minimal: nothing on the screen, a low-priority Events entry while a session is active. This can only be changed here on the phone, never from VS Code. No setting hides every sign of a session."
            }

            TextSwitch {
                id: muteSwitch
                automaticCheck: false
                enabled: page.available
                checked: page.st.muteNotifications === true
                text: "Mute agent notifications"
                description: "No start-up notice, banners or sounds from the agent. The Events entry during a session stays."
                onClicked: page.setBool("muteNotifications", !checked)
            }

            TextSwitch {
                id: touchSwitch
                automaticCheck: false
                enabled: page.available && page.st.control === true
                checked: page.st.touchIndicator === true
                text: "Show touch indicator"
                description: "Draws a circle on the screen where VS Code touches it while control is active. For debugging; normally off."
                onClicked: page.setBool("touchIndicator", !checked)
            }

            SectionHeader {
                text: "Status"
            }

            DetailItem {
                label: "Version"
                value: page.available && page.st.version ? page.st.version : "—"
            }

            DetailItem {
                label: "Service"
                value: page.available ? "Running" : "Not running"
            }

            DetailItem {
                label: "Developer Mode"
                value: !page.available || page.st.developerMode === undefined ? "—"
                       : page.st.developerMode ? "On" : "Off"
            }

            DetailItem {
                label: "Screen"
                value: !page.mirrorActive ? "Not in use"
                       : (page.st.mirrorControl ? "Viewed and controlled since " : "Viewed since ")
                         + Qt.formatTime(new Date(page.st.mirrorSince), "hh:mm")
            }

            DetailItem {
                label: "Logs"
                value: page.logStreams === 0 ? "Not in use"
                       : page.logStreams === 1 ? "1 stream" : page.logStreams + " streams"
            }

            DetailItem {
                label: "Client"
                value: page.available && page.st.client ? "VS Code on " + page.st.client : "—"
            }

            Button {
                anchors.horizontalCenter: parent.horizontalCenter
                text: "Stop all sessions now"
                enabled: page.available && (page.mirrorActive || page.logStreams > 0)
                onClicked: page.stopSessions()
            }

            Label {
                id: messageLabel
                x: Theme.horizontalPageMargin
                width: parent.width - 2 * x
                visible: text.length > 0
                wrapMode: Text.Wrap
                color: Theme.highlightColor
            }

            Label {
                x: Theme.horizontalPageMargin
                width: parent.width - 2 * x
                wrapMode: Text.Wrap
                font.pixelSize: Theme.fontSizeSmall
                color: Theme.highlightColor
                text: "Changes made here are kept across restarts and upgrades of the agent. Uninstalling the agent removes them."
            }
        }

        VerticalScrollDecorator {}
    }
}
