Feature: Stage A — Hermes as a holospace app object
  The hermes-web dashboard is built as a content-addressed app object, sealed against the vendored
  os-holo κ primitives, and folded into the frame so the in-browser Service Worker serves it by κ.
  These behaviors run against the real build, seal, and assembled _site.

  Background:
    Given the os-holo frame is vendored at "holo"
    And the Hermes app is sealed

  Scenario: the seal is deterministic (content-addressed identity is stable)
    When I re-seal the app with relock
    Then re-sealing reports no changed files
    And the lock identifier is "foundation.uor.hermes"
    And every closure entry is dual-axis sha256 and blake3
    And the lock carries an atlas coordinate

  Scenario: the closure carries the entry and the pinned conscience gate
    When I re-seal the app with relock
    Then the closure contains "apps/hermes/index.html"
    And the conscience gate "_shared/holo-conscience.js" is pinned in the closure

  Scenario: the built entry resolves relative so it mounts inside the iframe closure
    Then the built "apps/hermes/index.html" has no leading-slash asset references

  Scenario: the dashboard data layer has a single transport chokepoint
    Then no WebSocket or raw fetch is constructed outside "lib/api.ts"

  Scenario: the app registers into the frame without dropping existing apps
    When I assemble the site into "_site"
    Then the served root contains "holo-fhs-sw.js"
    And the served root contains "usr/share/holospaces/hermes/index.html"
    And os-closure lists app "foundation.uor.hermes" with the sealed root κ
    And the catalog lists app "foundation.uor.hermes"
    And at least 32 pre-existing frame apps are preserved

  @pinned
  Scenario: the sealed root κ is pinned for this build
    # Content-addressed: this reds when web/ changes — the signal to re-pin after a rebuild + reseal.
    When I re-seal the app with relock
    Then the root κ equals "did:holo:sha256:9329795a79eda6b5978a596293473b0f4d0a9ea9cdb08766f76cb49c13a629c8"
