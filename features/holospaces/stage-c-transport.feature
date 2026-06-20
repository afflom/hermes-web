Feature: Stage C — bind the dashboard transport to the substrate
  The api.ts seam is the single swap point for the dashboard's REST + sockets. The swap point exists
  today (green); routing it to the in-guest web_server.py over the emulator loopback bridge is pending
  the holospaces-web boot shim and the booted guest (Stage B).

  Scenario: the transport seam exposes the swap point (groundwork, in place today)
    Given the api.ts transport seam
    Then it exports "openSocket"
    And it exports "openSocketFromUrl"
    And it exports "setSocketFactory"
    And it exports "authedFetch"
    And it exports "buildWsUrl"

  @pending @stage-c-live
  Scenario: the hologram transport reaches the in-guest web_server
    Given the api.ts transport seam
    Then it exports "setSocketFactory"
    And the dashboard reaches web_server.py over the loopback bridge
