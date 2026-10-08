hand-written: agent 1.10.3 keypad fixture derived from agent-forward-input-live. `ping` reports the
`key` capability and a Commodore Callback keypad without F23 (as the agent reports only the keys the
keypad device exposes), so an integration test can check that the panel gets the bundled layout and
that a pointer press/release reaches the agent while a key the phone lacks does not.
