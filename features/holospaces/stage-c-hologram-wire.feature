Feature: Stage C — the hologram wire protocol
  The hologram transport reaches web_server.py inside the guest over the emulator loopback bridge
  (holospaces-web Workspace.dial_guest / guest_send / guest_recv, witnessed by CC-33), which is a raw
  TCP byte stream — so the transport speaks HTTP/1.1 and RFC-6455 over it. These scenarios run the real
  codec (web/src/lib/holo-wire.mjs) against a mock in-guest server: the exact bytes are proven, so only
  the live round-trip against a booted guest remains pending (Stage B + the loopback boot shim).

  Scenario: a REST read round-trips as HTTP/1.1
    Given a mock in-guest web_server replying 200 with body "{\"status\":\"ok\"}" to "/api/status"
    When the dashboard sends a GET "/api/status" through the wire codec
    Then the decoded response status is 200
    And the decoded response body is "{\"status\":\"ok\"}"

  Scenario: a REST verb round-trips as HTTP/1.1
    Given a mock in-guest web_server replying 200 with body "{\"set\":true}" to "/api/model/set"
    When the dashboard sends a POST "/api/model/set" through the wire codec
    Then the decoded response status is 200
    And the decoded response body is "{\"set\":true}"

  Scenario: a chunked response is reassembled
    Given a mock in-guest web_server replying chunked "hello holospace" to "/api/logs"
    When the dashboard reads the response through the wire codec
    Then the decoded response body is "hello holospace"

  Scenario: a /api/pty websocket upgrade completes and frames round-trip
    Given a mock in-guest web_server that accepts the websocket upgrade for "/api/pty"
    When the dashboard performs the websocket handshake through the wire codec
    Then the handshake is accepted
    When the dashboard sends the text frame "resize:80x24"
    And the guest echoes a text frame "ready"
    Then the dashboard decodes the text frame "ready"
    And a partial frame yields no message until complete

  Scenario: the transport glue installs the codec through the api.ts seam
    Given the hologram transport module
    Then it defines "GuestBridge"
    And it defines "installHologramTransport"
    And it defines "fromWorkspace"
    And it defines "HoloSocket"
    And the api.ts REST seam exports "setFetchImpl"
