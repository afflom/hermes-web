// Shared boot-progress type (imported by the worker, the client, and the boot UI).
export interface HologramBootProgress {
  // "disk" = streaming the guest disk into the OPFS κ-store (the off-heap path).
  phase: "wasm" | "snapshot" | "disk" | "resume" | "attach" | "egress" | "token" | "ready" | "error";
  detail?: string;
  /** 0..1 within a phase that reports sub-progress (the snapshot fetch). */
  fraction?: number;
}
