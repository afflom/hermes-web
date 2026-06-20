@pending @stage-d
Feature: Stage D — convergence, the complete agent end to end in the browser
  The full learning loop runs in holospaces from Pages: a chat turn calls a tool in the guest, writes
  a session to the OPFS κ-store, and is recoverable after a tab reload; egress leaves via relay or
  direct CORS fetch. Red-by-design until Stages B–C land; each step records its dependency.

  Scenario: LLM egress leaves the guest
    Then LLM egress leaves via relay or direct CORS fetch

  Scenario: the full loop survives a tab reload
    Then a chat turn calls a tool, writes a session, and survives a tab reload
