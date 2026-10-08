hand-written: agent 1.10.4 touch-indicator fallback fixture derived from agent-forward-input-live. The
phone's touch-indicator switch is on but the phone has no usable overlay, so once input becomes active
the agent reports `touchIndicatorPath: "mirror"`, and it answers the first accepted `down` with a
`contact` record in native coordinates. An integration test can check that the panel gets the marker
and that the mirror details read `Touch indicator: in mirror`.
