// Test app for the emulator test: logs what reaches it on stdout and takes "<n> <word>" commands
// from app.ctl next to this file (polled every 200 ms).
import QtQuick 2.6
import Sailfish.Silica 1.0

ApplicationWindow {
    id: app
    property bool landscape: false
    property int taps: 0
    property Item flick  // set by the page: ids inside initialPage are not visible here
    allowedOrientations: landscape ? Orientation.Landscape : Orientation.Portrait
    onDeviceOrientationChanged: console.log("EVENT orientation", deviceOrientation)
    Connections {
        target: Qt.application
        onActiveChanged: console.log("EVENT active", Qt.application.active)
    }
    Connections {
        target: Qt.inputMethod
        onVisibleChanged: console.log("EVENT keyboard", Qt.inputMethod.visible)
    }
    Timer {
        interval: 200; running: true; repeat: true
        property string last
        onTriggered: {
            var r = new XMLHttpRequest()
            r.onreadystatechange = function() {
                if (r.readyState !== XMLHttpRequest.DONE) return
                var cmd = r.responseText.trim()
                if (cmd === last || cmd === "") return
                last = cmd
                var word = cmd.split(" ")[1]
                if (word === "land") app.landscape = true
                else if (word === "port") app.landscape = false
                else if (word === "notype") { app.flick.forceActiveFocus(); Qt.inputMethod.hide() }
                console.log("EVENT command", word)
            }
            r.open("GET", Qt.resolvedUrl("app.ctl"))
            r.send()
        }
    }
    initialPage: Component {
        Page {
            allowedOrientations: app.allowedOrientations
            onOrientationChanged: console.log("EVENT page", orientation)
            SilicaFlickable {
                id: flick
                anchors.fill: parent
                Component.onCompleted: app.flick = flick
                contentHeight: height
                PullDownMenu {
                    onActiveChanged: console.log("EVENT pulley", active)
                    MenuItem { text: "Item"; onClicked: console.log("EVENT menu") }
                }
                TextField {
                    id: field
                    y: Theme.itemSizeLarge
                    width: parent.width
                    onTextChanged: console.log("EVENT text", text.length)
                }
                MouseArea {
                    y: parent.height / 3
                    width: parent.width
                    height: parent.height / 3
                    onClicked: { app.taps++; console.log("EVENT tap", app.taps) }
                }
            }
        }
    }
}
