import QtQuick 2.0
import "private"
import "util.js" as Util
import Fixture.Widgets 1.0 as Fw

Item {
    id: root
    property alias title: caption.text
    property int padding: 4
    readonly property bool wide: width > Util.limit()
    signal activated(string reason)

    Text {
        id: caption
        anchors.fill: parent
        text: "{ not a block }"
    }
    Secret { id: secret }
    Fw.Knob { id: knob; onTurned: root.activated("knob") }
}
