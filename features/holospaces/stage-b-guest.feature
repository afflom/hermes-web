@pending @stage-b
Feature: Stage B — the Hermes runtime in the in-browser RISC-V guest
  The unmodified Python Hermes boots inside the wasmi-interpreted RISC-V emulator, with state on the
  OPFS κ-store. Red-by-design until the riscv64 image + kernel exist and the guest boots; each step
  records the precise external dependency.

  Scenario: the guest boots Hermes to userspace
    Given a linux/riscv64 OCI image carrying the Python Hermes runtime
    And a riscv64 Linux kernel image for the HGOS boot descriptor
    When the guest boots under the in-browser RISC-V emulator
    Then python run_agent.py --help returns inside the guest
