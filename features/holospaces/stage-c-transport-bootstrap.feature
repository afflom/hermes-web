Feature: Stage C — the transport bootstrap (HL-5)
  At startup the dashboard selects its transport — hologram (route /api + sockets to the in-guest
  web_server.py over the emulator loopback bridge), static (no-backend Pages shell), or origin
  (server-hosted default) — by the signals the holospace launcher injects into the mounted iframe.
  A server-hosted build injects no signal and stays on origin, completely unchanged.

  Scenario: the bootstrap selects the transport by launcher signal and is wired into the app entry
    Given the holo transport bootstrap
    Then it selects the "hologram" transport when "__HOLO_GUEST_BRIDGE__" is present
    And it selects the "static" transport when "__HOLO_STATIC__" is present
    And it defaults to the origin transport with no signal
    And selectHoloTransport is wired into the app entry
    And the static transport answers reads with empty states and inert sockets

  Scenario: the holospace Pages build renders the static shell when no guest has booted
    # The same bundle serves two contexts; the holospace build has no co-located /api backend, so with no
    # guest bridge it must render the static shell rather than 404 against the static host's origin.
    Given the holo transport bootstrap
    Then the holospace build defaults to the static shell when no guest bridge is present
    And the vite build wires the holospace-build flag
