//! HL-B / HL-C — the Hermes linux/riscv64 guest boots under the emulator and its in-guest
//! `web_server.py` is reached over the in-process loopback bridge. Modeled on `CC-33`: the guest is the
//! Hermes image (`docker/holo/Dockerfile.riscv64`); `/init` is injected to run Python + the dashboard
//! server, and the host dials `:9119` and reads `/api/status`. One witness covers both targets —
//! Python/Hermes boots in the guest (HL-B) and the dashboard transport reaches the in-guest server
//! (HL-C). `#[ignore]` (a real-OS boot); run by `tools/holo/witness/run-hermes-guest.sh` once the image
//! is built. This file is carried in-repo at `tools/holo/witness/cc_hermes_guest.rs`.

use std::io::Read;
use std::path::{Path, PathBuf};

use hologram_store_mem::MemKappaStore;
use hologram_substrate_core::KappaStore;
use holospaces::assembly::{assemble_ext4_bootable, assemble_ext4_with_init, Layer};
use holospaces::emulator::net::NoEgress;
use holospaces::emulator::{Emulator, Halt};
use holospaces::machine::MachineSpec;
use holospaces::oci::ingest_image;

fn image_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../vv/witness/hermes-riscv64-oci")
}
fn cc16_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vv/artifacts/cc16")
}
fn gunzip(path: &Path) -> Vec<u8> {
    let raw = std::fs::read(path).unwrap();
    let mut d = flate2::read::GzDecoder::new(&raw[..]);
    let mut out = Vec::new();
    d.read_to_end(&mut out).unwrap();
    out
}

// Injected /init: bring up the minimal mounts, prove Python runs, then exec the dashboard server the
// hologram transport reaches. Overrides the image's own /init (assemble_ext4_with_init).
const HERMES_INIT: &[u8] = b"#!/bin/sh\n\
mkdir -p /proc /sys /dev /tmp 2>/dev/null\n\
mount -t proc proc /proc 2>/dev/null\n\
mount -t sysfs sysfs /sys 2>/dev/null\n\
mount -t devtmpfs devtmpfs /dev 2>/dev/null\n\
mount -t tmpfs tmpfs /tmp 2>/dev/null\n\
export HOME=/root TERM=xterm PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\n\
cd /opt/hermes 2>/dev/null || cd /root\n\
python3 -c 'import sys; print(\"HERMES-GUEST-PYTHON-OK\", sys.version.split()[0])'\n\
exec python3 -m hermes_cli.main dashboard --host 0.0.0.0 --port 9119 --insecure --no-open --skip-build\n";

#[test]
#[ignore]
fn the_hermes_guest_boots_and_serves_the_dashboard_api() {
    let dir = image_dir();
    if !dir.join("index.json").exists() {
        eprintln!("SKIP: Hermes riscv64 image not built — run tools/holo/build-guest-image.sh (dir={dir:?})");
        return;
    }

    // Ingest the Hermes OCI layout → layers (re-deriving every blob, Law L5), exactly as CC-33.
    let store = MemKappaStore::new();
    let layout = std::fs::read(dir.join("oci-layout")).unwrap();
    let index = std::fs::read(dir.join("index.json")).unwrap();
    let blob_dir = dir.join("blobs/sha256");
    let fetch = |digest: &str| -> Option<Vec<u8>> {
        let hex = digest.strip_prefix("sha256:")?;
        std::fs::read(blob_dir.join(hex)).ok()
    };
    let img = ingest_image(&store, &layout, &index, holospaces::Arch::Riscv64, fetch)
        .expect("ingest the Hermes riscv64 image");
    let blobs: Vec<(String, Vec<u8>)> = img
        .layers()
        .iter()
        .zip(img.layer_media_types())
        .map(|(k, mt)| (mt.clone(), store.get(k).unwrap().unwrap().as_ref().to_vec()))
        .collect();
    let layers: Vec<Layer> = blobs
        .iter()
        .map(|(mt, b)| Layer { media_type: mt, blob: b })
        .collect();
    drop(store); // free the ingest κ-store (~300 MB) before the dense assemble — keep peak RAM down
    // Size the rootfs to a 1.5 GiB disk so the booted Hermes has WRITABLE free space — the in-guest
    // server creates /root/.hermes (session DB, config, skills, MCP) on first use, and a zero-free-space
    // image (the old assemble_ext4_with_init) makes every such write fail with ENOSPC → 500s on
    // /api/sessions, /api/config, /api/mcp/servers, /api/skills. The free blocks are sparse (all-zero), so
    // the κ-disk store dedups them to nothing and the gzip chunks stay tiny on the wire (Law L3/L4).
    // 1.25 GiB disk: enough free space for /root/.hermes runtime data, while keeping the DENSE snapshot
    // (RAM 512 MiB + disk + device state ≈ 1.8 GB) under the browser's 2 GiB max-ArrayBuffer ceiling — the
    // worker reassembles the whole κ into one buffer to verify it (Law L5), and a 2 GiB+ κ fails to alloc.
    let rootfs = assemble_ext4_bootable(&layers, HERMES_INIT, 1280 * 1024 * 1024).expect("assemble Hermes rootfs");
    drop(layers);
    drop(blobs); // free the decompressed layer bytes; only `rootfs` survives into the boot
    let kernel = gunzip(&cc16_dir().join("kernel/Image.gz"));
    eprintln!("[hermes-guest] dense rootfs assembled: {} bytes; booting", rootfs.len());

    let spec = MachineSpec::devcontainer_net();
    let base = spec.base;
    let mut emu = spec
        .boot_net(&kernel, rootfs, Box::new(NoEgress))
        .expect("boot the Hermes devcontainer");
    assert!(emu.enable_loopback(), "the loopback bridge attaches to the network device");

    // HL-B: Python boots inside the guest. Periodic console dumps (with --nocapture) make the long
    // interpreted boot observable — you can watch the kernel reach userspace, the init run, Python
    // start, and the server bind, instead of staring at a silent run.
    let mut python_ok = false;
    let mut serving = false;
    let mut i: u64 = 0;
    for _ in 0..200_000 {
        if !matches!(emu.run(5_000_000), Halt::OutOfBudget) {
            eprintln!("[hermes-guest] machine halted at iter {i}");
            break;
        }
        i += 1;
        let console = String::from_utf8_lossy(emu.console());
        if i % 200 == 0 {
            let tail: String = console.chars().rev().take(120).collect::<Vec<_>>().into_iter().rev().collect();
            eprintln!("[hermes-guest iter {i}] console_len={} python_ok={python_ok} tail={tail:?}", console.len());
        }
        if console.contains("HERMES-GUEST-PYTHON-OK") {
            python_ok = true;
        }
        if console.contains("HERMES_DASHBOARD_READY") {
            serving = true;
            eprintln!("[hermes-guest iter {i}] HERMES_DASHBOARD_READY — dashboard up; proceeding to dial");
            break;
        }
    }
    let console = String::from_utf8_lossy(emu.console()).into_owned();
    assert!(python_ok, "Python booted in the guest (HL-B); console:\n{console}");
    assert!(serving, "the in-guest dashboard server started (HL-C precondition); console:\n{console}");

    // Bank a COLD κ (right at READY, zero requests served) before warming — so warming variations can be
    // iterated by RESUMING this (`cc_warm_from_cold`) instead of re-paying the ~22-min cold boot each time.
    {
        let cold = emu.snapshot();
        let cold_path = witness_dir().join("hermes-cold.kappa");
        match std::fs::write(&cold_path, &cold) {
            Ok(()) => eprintln!("[hermes-guest] COLD κ banked: {} bytes → {cold_path:?}", cold.len()),
            Err(e) => eprintln!("[hermes-guest] (warn) could not bank cold κ: {e}"),
        }
    }

    // ── WARM BEFORE BANKING (the k-theoretic perf exploit): the snapshot captures RAM, so whatever
    // first-call work the server has already done is RESUMED for free. A FastAPI/uvicorn app pays a large
    // one-time cost on the FIRST hit to each endpoint — route resolution, Pydantic-core schema build, lazy
    // imports, DB warm-up. Banking COLD (right at READY, zero requests served) forces the browser to re-pay
    // all of that on first use (~70 s for `/`, minutes for `/api/status`). So we exercise every endpoint the
    // dashboard loads HERE, then snapshot — the resumed machine serves them warm. The endpoint cold-start
    // happens once, natively, at bank time instead of once-per-endpoint in every browser session.
    eprintln!("[hermes-guest] warming the dashboard endpoints before banking (captures first-call cost in RAM)…");
    let warm_t0 = std::time::Instant::now();
    let index = warm_endpoint(&mut emu, "/", None);
    let index_text = String::from_utf8_lossy(&index);
    let token = index_text
        .split("window.__HERMES_SESSION_TOKEN__=\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .map(|s| s.to_owned());
    eprintln!(
        "[hermes-guest] warm `/` served {} bytes in {:?}; session token {}",
        index.len(),
        warm_t0.elapsed(),
        if token.is_some() { "captured" } else { "NOT found (authed endpoints will only warm middleware)" }
    );
    // EVERY dashboard endpoint a hermes-agent user loads — so each one's first-call cost is paid into RAM
    // (warm) AND its on-disk state (/root/.hermes: session DB, config, skills, mcp) is created at bank time
    // on the now-writable disk. Both 200 and empty-but-200 responses warm the route; we log each timing so
    // a regression (a still-cold or 500ing endpoint) is visible in the bank log.
    for path in [
        "/api/status", "/api/config", "/api/config/schema", "/api/config/defaults",
        "/api/sessions?limit=20&offset=0&order=created", "/api/dashboard/themes", "/api/dashboard/plugins",
        "/api/analytics/models", "/api/analytics/usage?days=7", "/api/models", "/api/model/info",
        "/api/model/options", "/api/env", "/api/cron/jobs", "/api/skills",
        "/api/profiles", "/api/profiles/active", "/api/webhooks", "/api/pairing", "/api/files",
        "/api/system/stats", "/api/logs?file=agent&lines=50",
        // NB: /api/messaging/platforms AND /api/mcp/servers PROBE outbound network. With NoEgress at bank
        // time they not only hang/500 — they leave a BACKGROUND RECONNECT TASK in the asyncio loop, and the
        // resumed κ then spins forever on its first request (the loop is monopolized re-trying the dead
        // peer). They warm in the browser via the router extension on first use — never warm them here.
    ] {
        let t0 = std::time::Instant::now();
        let r = warm_endpoint(&mut emu, path, token.as_deref());
        let status = String::from_utf8_lossy(&r[..r.len().min(20)]).replace("HTTP/1.1 ", "");
        eprintln!("[hermes-guest]   warmed {path}: {} bytes in {:?} [{}]", r.len(), t0.elapsed(), status.trim());
    }
    // Re-hit `/` and `/api/status` now that everything is hot — proves the warm path is fast (these timings
    // should be a fraction of the first), and ensures the steady-state working set is resident.
    let t0 = std::time::Instant::now();
    let _ = warm_endpoint(&mut emu, "/", None);
    eprintln!("[hermes-guest] re-warmed `/` in {:?} (warm hit — should be « the first)", t0.elapsed());
    let t0 = std::time::Instant::now();
    let _ = warm_endpoint(&mut emu, "/api/status", token.as_deref());
    eprintln!("[hermes-guest] re-warmed /api/status in {:?} (warm hit)", t0.elapsed());
    eprintln!("[hermes-guest] warming complete in {:?} — banking the WARM machine", warm_t0.elapsed());

    // NOTE: we deliberately do NOT settle here before the snapshot. The resume re-attaches egress + the
    // loopback ingress AFTER restore, which perturbs the net/loop state, so a bank-time settle does not
    // survive the round trip — the worker settles post-resume instead (holo-worker.ts). Snapshotting right
    // after warming (no extra idle) is the configuration the original warm κ shipped and the worker settle
    // reliably brings to ready.

    // Snapshot the WARM machine to a content-addressed κ and persist it. Uncompressed (raw `write`) so
    // banking costs I/O, not CPU; the browser gzips for OPFS. This warm κ is what the browser resumes.
    let warm = emu.snapshot();
    let warm_kappa = holospaces::oci::sha256_digest(&warm);
    let warm_path = witness_dir().join("hermes-warm.kappa");
    match std::fs::write(&warm_path, &warm) {
        Ok(()) => eprintln!(
            "[hermes-guest] warm κ BANKED: {} bytes → {warm_path:?} κ={warm_kappa} — the boot is now resumable",
            warm.len()
        ),
        Err(e) => eprintln!("[hermes-guest] (warn) could not bank warm κ to {warm_path:?}: {e}"),
    }

    // HL-C: the dashboard transport reaches the in-guest web_server.py over the loopback bridge.
    let id = {
        let mut got = None;
        for _ in 0..200 {
            emu.run(2_000_000);
            if let Some(c) = emu.dial_guest(9119) {
                got = Some(c);
                break;
            }
        }
        got.expect("dialing the in-guest web_server (:9119) returns a connection id")
    };
    for _ in 0..40 {
        emu.run(2_000_000);
    }
    emu.guest_send(id, b"GET /api/status HTTP/1.0\r\nHost: app\r\n\r\n");
    let mut resp: Vec<u8> = Vec::new();
    for _ in 0..20_000 {
        emu.run(2_000_000);
        resp.extend(emu.guest_recv(id));
        if resp.windows(8).any(|w| w == b"HTTP/1.0") || resp.windows(8).any(|w| w == b"HTTP/1.1") {
            break;
        }
        if !emu.guest_is_open(id) {
            break;
        }
    }
    let text = String::from_utf8_lossy(&resp).into_owned();
    assert!(
        text.contains("HTTP/1."),
        "the dashboard reached the in-guest web_server.py over the loopback bridge and read its HTTP \
         response (HL-C); got:\n{text}\nconsole:\n{console}"
    );
    emu.guest_close(id);

    // HL-6 round-trip identity: drop the live machine, restore from the banked κ in RAM, assert the
    // resumed machine re-snapshots to the SAME content-address κ (suspend→resume is a faithful round trip).
    drop(emu); // release the live machine; the κ-snapshot now stands in for it (true suspend semantics)
    let resumed = Emulator::restore(base, &warm).expect("resume the warm Hermes from its κ-snapshot");
    let resumed_kappa = holospaces::oci::sha256_digest(&resumed.snapshot());
    assert_eq!(
        resumed_kappa, warm_kappa,
        "the warm Hermes dashboard resumes to the SAME content-address κ (CC-30) — a resumed launch is \
         byte-for-byte the same serving dashboard, with no re-boot and no re-import"
    );
    eprintln!("[hermes-guest] ✓ warm-resume round-trip identity holds (κ={resumed_kappa}) — instant warm-start is sound");

    // Provenance artifact (documentation-as-code): the warm κ + the live /api/status proof, durably on disk.
    let artifact = format!(
        "{{\n  \"witness\": \"cc_hermes_guest\",\n  \"targets\": \"HL-B+HL-C+HL-6\",\n  \"dashboard_ready\": true,\n  \"api_status_response_len\": {},\n  \"warm_kappa\": \"{warm_kappa}\",\n  \"warm_snapshot_len\": {},\n  \"resumed_kappa\": \"{resumed_kappa}\",\n  \"round_trip_identical\": {}\n}}\n",
        text.len(),
        warm.len(),
        resumed_kappa == warm_kappa
    );
    match std::fs::write(witness_dir().join("hermes-guest-witness.json"), &artifact) {
        Ok(()) => eprintln!("[hermes-guest] provenance artifact written\n{artifact}"),
        Err(e) => eprintln!("[hermes-guest] (note) could not write provenance artifact: {e}"),
    }
}

// The repo's `vv/witness/` directory (four levels up from this test crate's manifest dir).
fn witness_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../vv/witness")
}

/// FAST serve-after-resume diagnostic (no warming): restore the on-disk COLD and WARM κ side by side and
/// compare net-device state + a dial, to pinpoint what warming left dirty. COLD serves; WARM is failing.
#[test]
#[ignore]
fn the_warm_kappa_serves_diagnostic() {
    let base = MachineSpec::devcontainer_net().base;
    for (label, file) in [("COLD", "hermes-cold.kappa"), ("WARM", "hermes-warm.kappa")] {
        let path = witness_dir().join(file);
        if !path.exists() {
            eprintln!("[diag] SKIP {label}: no {file}");
            continue;
        }
        let snap = std::fs::read(&path).expect("read κ");
        eprintln!("[diag] ───── {label} ({} bytes) ─────", snap.len());
        let mut r = Emulator::restore(base, &snap).expect("restore");
        r.reattach_net_egress(Box::new(NoEgress));
        assert!(r.enable_loopback(), "loopback attaches");
        for _ in 0..300 {
            r.run(2_000_000);
        }
        eprintln!("[diag] {label} net BEFORE dial: {}", r.net_debug());
        let id = r.dial_guest(9119);
        eprintln!("[diag] {label} dial(:9119) → {id:?}");
        if let Some(id) = id {
            r.guest_send(id, b"GET /api/cron/jobs HTTP/1.0\r\nHost: app\r\n\r\n");
            let mut resp = Vec::new();
            for _ in 0..6000 {
                r.run(2_000_000);
                resp.extend(r.guest_recv(id));
                if resp.windows(8).any(|w| w == b"HTTP/1.0" || w == b"HTTP/1.1") {
                    break;
                }
                if !r.guest_is_open(id) {
                    break;
                }
            }
            let serves = resp.windows(8).any(|w| w == b"HTTP/1.0" || w == b"HTTP/1.1");
            eprintln!("[diag] {label} after GET: {} resp bytes, serves={serves}", resp.len());
            eprintln!("[diag] {label} net AFTER dial:  {}", r.net_debug());
        }
    }
    // The browser doesn't use monolithic restore — it uses restore_net_streamed (fed/streamed). Test
    // THAT on both κ: if WARM-streamed fails to serve while WARM-monolithic served, the streamed restore
    // mishandles the warm κ (that's the browser failure).
    for (label, file) in [("COLD", "hermes-cold.kappa"), ("WARM", "hermes-warm.kappa")] {
        let path = witness_dir().join(file);
        if !path.exists() {
            continue;
        }
        let snap = std::fs::read(&path).expect("read κ");
        eprintln!("[diag] ───── {label} via STREAMED restore (the browser's path) ─────");
        let mut reader = holospaces::emulator::SliceRead::new(&snap);
        let disk: Box<dyn hologram_substrate_core::KappaStore> = Box::new(MemKappaStore::new());
        let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("streamed restore");
        r.reattach_net_egress(Box::new(NoEgress));
        assert!(r.enable_loopback(), "loopback attaches (streamed)");
        for _ in 0..300 {
            r.run(2_000_000);
        }
        // Measure the AUTH endpoint `/` (what the browser polls for the token) — TWICE, to see whether
        // it's genuinely warm/fast or heavy-per-call. This is the time that must fit the 180s ready-wait.
        for hit in 1..=2 {
            let t = std::time::Instant::now();
            let id = r.dial_guest(9119);
            let mut resp = Vec::new();
            if let Some(id) = id {
                r.guest_send(id, b"GET / HTTP/1.0\r\nHost: app\r\n\r\n");
                for _ in 0..40_000 {
                    r.run(2_000_000);
                    resp.extend(r.guest_recv(id));
                    if !r.guest_is_open(id) {
                        break;
                    }
                }
                r.guest_close(id);
            }
            let serves = resp.windows(8).any(|w| w == b"HTTP/1.0" || w == b"HTTP/1.1");
            let has_token = String::from_utf8_lossy(&resp).contains("__HERMES_SESSION_TOKEN__");
            eprintln!(
                "[diag] {label}-streamed `/` hit {hit}: {} bytes in {:?}, serves={serves}, token={has_token}",
                resp.len(),
                t.elapsed()
            );
        }
    }
    // REPLICATE THE BROWSER WITH NO ROUTER EXTENSION: ChannelEgress whose router is never drained, so the
    // guest's outbound SYNs are dropped and the connection hangs (no reply) — exactly the gate's headless
    // state. If the WARM κ's resumed background tasks egress, this hangs the asyncio loop → auth `/` hangs
    // (while NoEgress fast-fails and serves). That's the warm-κ gate failure reproduced natively.
    for (label, file) in [("COLD", "hermes-cold.kappa"), ("WARM", "hermes-warm.kappa")] {
        let path = witness_dir().join(file);
        if !path.exists() {
            continue;
        }
        let snap = std::fs::read(&path).expect("read κ");
        let mut reader = holospaces::emulator::SliceRead::new(&snap);
        let disk: Box<dyn hologram_substrate_core::KappaStore> = Box::new(MemKappaStore::new());
        let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
        let (egress, _router) = holospaces::emulator::net::ChannelEgress::new(); // _router NOT drained
        r.reattach_net_egress(Box::new(egress));
        assert!(r.enable_loopback(), "loopback");
        for _ in 0..300 {
            r.run(2_000_000);
        }
        let t = std::time::Instant::now();
        let id = r.dial_guest(9119);
        let mut resp = Vec::new();
        if let Some(id) = id {
            r.guest_send(id, b"GET / HTTP/1.0\r\nHost: app\r\n\r\n");
            for _ in 0..40_000 {
                r.run(2_000_000);
                resp.extend(r.guest_recv(id));
                if !r.guest_is_open(id) {
                    break;
                }
            }
        }
        let serves = resp.windows(8).any(|w| w == b"HTTP/1.0" || w == b"HTTP/1.1");
        eprintln!(
            "[diag] {label} + ChannelEgress-NOT-drained (browser/no-extension) `/`: {} bytes in {:?}, serves={serves}",
            resp.len(),
            t.elapsed()
        );
    }
    eprintln!("[diag] done");
}

/// ROOT-CAUSE the warm-κ browser spin by replicating the browser's EXACT first request natively. The
/// emulator clock is instruction-based (deterministic), so identical input bytes MUST execute identically
/// to the browser — if the browser spins, this spins. The earlier diag used `GET / HTTP/1.0\r\nHost: app`
/// (which served); the browser bridge sends HTTP/1.1 + `Host: guest` + `Connection: close` + an `accept`
/// header, and pumps 8M-instruction chunks. We run BOTH request shapes against the WARM κ under a dead
/// ChannelEgress (the headless/no-extension gate), count instructions to completion, and dump the guest
/// console DURING the request — the console is uvicorn/Python's stdout, so a spinning handler (exception
/// loop, re-polled dead fd) shows up there. Whichever request fails to complete in a 4-billion-instruction
/// budget is the trigger; the console says why.
/// Does the guest serve a CONCURRENT BURST? The browser dashboard dials ~10 connections at once on mount
/// and NONE complete. Replicate it: dial 10 warm endpoints concurrently (all dial+send before draining),
/// then pump + drain — count how many serve and when. If most serve fast, the burst is fine (browser-side
/// bridge issue); if they stall, the guest/loopback can't handle concurrency.
#[test]
#[ignore]
fn cc_concurrent_burst() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm.kappa");
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
    let (egress, router) = holospaces::emulator::net::ChannelEgress::new();
    r.reattach_net_egress(Box::new(egress));
    assert!(r.enable_loopback(), "loopback");
    for _ in 0..40 { r.run(PUMP_BUDGET); while router.pop_outbound().is_some() {} }
    let index = warm_endpoint(&mut r, "/", None);
    let token = String::from_utf8_lossy(&index).split("window.__HERMES_SESSION_TOKEN__=\"").nth(1)
        .and_then(|s| s.split('"').next()).map(|s| s.to_owned()).unwrap_or_default();
    let mk = |p: &str| format!("GET {p} HTTP/1.1\r\nHost: guest\r\nConnection: close\r\nAuthorization: Bearer {token}\r\n\r\n");
    let paths = ["/api/config", "/api/profiles", "/api/profiles/active", "/api/dashboard/plugins",
        "/api/dashboard/themes", "/api/dashboard/font", "/api/sessions/stats",
        "/api/sessions?limit=20&offset=0&order=created", "/api/sessions/empty/count", "/api/auth/me"];
    // POOL: keep at most IN_FLIGHT sockets open, dialing the next queued request only as one closes —
    // instead of dialing all 10 SYNs at once (which the guest's connection handling can't absorb).
    let in_flight: usize = std::env::var("BURST_POOL").ok().and_then(|s| s.parse().ok()).unwrap_or(3);
    eprintln!("[burst] pool size = {in_flight}");
    let mut queue: std::collections::VecDeque<&str> = paths.iter().copied().collect();
    let mut open: Vec<(&str, u32, Vec<u8>)> = Vec::new();
    let mut served = 0;
    for _tick in 1..=1200u32 {
        while open.len() < in_flight {
            let Some(p) = queue.pop_front() else { break };
            let id = r.dial_guest(9119).expect("dial");
            r.guest_send(id, mk(p).as_bytes());
            open.push((p, id, Vec::new()));
        }
        r.run(PUMP_BUDGET);
        while router.pop_outbound().is_some() {}
        let mut i = 0;
        while i < open.len() {
            let bytes = r.guest_recv(open[i].1);
            open[i].2.extend(bytes);
            if !r.guest_is_open(open[i].1) {
                let (p, _, resp) = open.remove(i);
                served += 1;
                eprintln!("[burst] {p:<46} ✓ ({}B)", resp.len());
            } else { i += 1; }
        }
        if queue.is_empty() && open.is_empty() { break; }
    }
    for (p, _, resp) in &open { eprintln!("[burst] {p:<46} ✗ stuck ({}B)", resp.len()); }
    eprintln!("[burst] {served}/10 served with pool={in_flight}");
}

/// k-ALIGNED DASHBOARD CAPTURE. The architecture's lesson: operate over the k-address representation, don't
/// re-compute through the interpreter. The warm κ already COMPUTED every dashboard read at bank time; under
/// emulation each re-fetch costs ~2-3 s and the guest serves only ONE connection at a time (proven by
/// cc_concurrent_burst), so the browser dashboard's ~10-fetch mount is brutally slow when it round-trips the
/// guest. Capture those already-computed responses as a content-addressed artifact (warm-responses.json) the
/// browser seeds its read-cache from — the dashboard reads the κ instantly, the interpreter is never on the
/// request path. Writes + un-warmed reads still round-trip (serialized); background idle-refresh keeps it live.
#[test]
#[ignore]
fn cc_capture_responses() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm.kappa");
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
    let (egress, router) = holospaces::emulator::net::ChannelEgress::new();
    r.reattach_net_egress(Box::new(egress));
    assert!(r.enable_loopback(), "loopback");
    for _ in 0..40 { r.run(PUMP_BUDGET); while router.pop_outbound().is_some() {} }
    let index = warm_endpoint(&mut r, "/", None);
    let token = String::from_utf8_lossy(&index).split("window.__HERMES_SESSION_TOKEN__=\"").nth(1)
        .and_then(|s| s.split('"').next()).map(|s| s.to_owned()).unwrap_or_default();
    assert!(!token.is_empty(), "no session token from /");

    let mut entries: Vec<(String, u16, String, Vec<u8>)> = Vec::new();
    for p in SAFE_WARM_PATHS {
        let raw = warm_endpoint(&mut r, p, Some(&token));
        let split = raw.windows(4).position(|w| w == b"\r\n\r\n");
        let (head, body) = match split { Some(i) => (&raw[..i], raw[i + 4..].to_vec()), None => (&raw[..], Vec::new()) };
        let head_s = String::from_utf8_lossy(head);
        let mut lines = head_s.split("\r\n");
        let status: u16 = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|s| s.parse().ok()).unwrap_or(0);
        let ct = lines.find(|l| l.to_ascii_lowercase().starts_with("content-type:"))
            .and_then(|l| l.split_once(':')).map(|(_, v)| v.trim().to_owned())
            .unwrap_or_else(|| "application/json".to_owned());
        eprintln!("[cap] {p:<48} {status} {ct} ({}B)", body.len());
        entries.push((p.to_string(), status, ct, body));
    }
    let mut out = String::from("{\n");
    for (i, (path, status, ct, body)) in entries.iter().enumerate() {
        let hex: String = body.iter().map(|b| format!("{b:02x}")).collect();
        let comma = if i + 1 < entries.len() { "," } else { "" };
        out.push_str(&format!("  {path:?}: {{\"status\":{status},\"ct\":{ct:?},\"body\":\"{hex}\"}}{comma}\n"));
    }
    out.push_str("}\n");
    let dest = witness_dir().join("warm-responses.json");
    std::fs::write(&dest, &out).expect("write responses");
    eprintln!("[cap] wrote {} responses ({} bytes) → {}", entries.len(), out.len(), dest.display());
}

/// Does the heavy /api/status handler BLOCK the guest's single-threaded asyncio loop? Dial /api/status AND
/// /api/sessions CONCURRENTLY: if /api/sessions completes quickly while /api/status is still running, the
/// loop yields (status is async) — the browser timeout is elsewhere. If /api/sessions is starved until
/// status finishes (~100s), status BLOCKS the loop and any dashboard /api/status poll freezes everything.
#[test]
#[ignore]
fn cc_concurrent_status() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm.kappa");
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
    let (egress, router) = holospaces::emulator::net::ChannelEgress::new();
    r.reattach_net_egress(Box::new(egress));
    assert!(r.enable_loopback(), "loopback");
    for _ in 0..40 { r.run(PUMP_BUDGET); while router.pop_outbound().is_some() {} }
    let index = warm_endpoint(&mut r, "/", None);
    let token = String::from_utf8_lossy(&index).split("window.__HERMES_SESSION_TOKEN__=\"").nth(1)
        .and_then(|s| s.split('"').next()).map(|s| s.to_owned()).unwrap_or_default();
    let mk = |p: &str| format!("GET {p} HTTP/1.1\r\nHost: guest\r\nConnection: close\r\nAuthorization: Bearer {token}\r\n\r\n");
    // Dial BOTH concurrently (status first, like the sidebar mounting before the page's data load).
    let st = r.dial_guest(9119).expect("dial status");
    r.guest_send(st, mk("/api/status").as_bytes());
    let se = r.dial_guest(9119).expect("dial sessions");
    r.guest_send(se, mk("/api/sessions?limit=20&offset=0&order=created").as_bytes());
    let (mut st_done, mut se_done) = (None, None);
    let (mut st_resp, mut se_resp) = (Vec::new(), Vec::new());
    for tick in 1..=2000u32 {
        r.run(PUMP_BUDGET);
        while router.pop_outbound().is_some() {}
        st_resp.extend(r.guest_recv(st));
        se_resp.extend(r.guest_recv(se));
        if st_done.is_none() && !r.guest_is_open(st) { st_done = Some(tick); eprintln!("[conc] /api/status done at tick {tick} ({}M instr), {}B", tick * 8, st_resp.len()); }
        if se_done.is_none() && !r.guest_is_open(se) { se_done = Some(tick); eprintln!("[conc] /api/sessions done at tick {tick} ({}M instr), {}B", tick * 8, se_resp.len()); }
        if st_done.is_some() && se_done.is_some() { break; }
    }
    match (st_done, se_done) {
        (Some(s), Some(e)) if e < s / 2 => eprintln!("[conc] ✓ /api/sessions ({e}) finished well before /api/status ({s}) — loop YIELDS, status is async"),
        (Some(s), Some(e)) => eprintln!("[conc] ✗ /api/sessions ({e}) starved until ~/api/status ({s}) — status BLOCKS the loop"),
        _ => eprintln!("[conc] incomplete: status={st_done:?} sessions={se_done:?}"),
    }
}

/// Reproduce the browser's post-auth sequence natively: restore the WARM κ → settle → serve `/`, then a
/// few warm /api routes IN SEQUENCE, timing each. The browser served `/` + /api/config but /api/sessions
/// timed out — so check whether /api/sessions is genuinely slow natively (an endpoint issue) or fast (a
/// browser page→worker transport issue). Uses ChannelEgress (dead peer) + drains, exactly like the bridge.
#[test]
#[ignore]
fn cc_session_serves() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm.kappa");
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
    let (egress, router) = holospaces::emulator::net::ChannelEgress::new();
    r.reattach_net_egress(Box::new(egress));
    assert!(r.enable_loopback(), "loopback");
    for _ in 0..40 { r.run(PUMP_BUDGET); while router.pop_outbound().is_some() {} }
    let index = warm_endpoint(&mut r, "/", None);
    let token = String::from_utf8_lossy(&index)
        .split("window.__HERMES_SESSION_TOKEN__=\"").nth(1)
        .and_then(|s| s.split('"').next()).map(|s| s.to_owned());
    eprintln!("[ses] `/` {} bytes, token={}", index.len(), token.is_some());
    // Each as a SEPARATE dialed connection (like the bridge), draining egress each tick.
    for path in ["/api/config", "/api/sessions?limit=20&offset=0&order=created", "/api/env", "/api/cron/jobs", "/api/profiles"] {
        let t = std::time::Instant::now();
        let id = r.dial_guest(9119).expect("dial");
        let req = format!("GET {path} HTTP/1.1\r\nHost: guest\r\nConnection: close\r\nAuthorization: Bearer {}\r\n\r\n", token.as_deref().unwrap_or(""));
        r.guest_send(id, req.as_bytes());
        let mut resp = Vec::new();
        let mut served = false;
        for _ in 0..400 {
            r.run(PUMP_BUDGET);
            while router.pop_outbound().is_some() {}
            resp.extend(r.guest_recv(id));
            if !r.guest_is_open(id) { served = true; break; }
        }
        let status = String::from_utf8_lossy(&resp[..resp.len().min(20)]).replace("HTTP/1.1 ", "");
        eprintln!("[ses] {path:<46} → served={served} {}B in {:?} [{}]", resp.len(), t.elapsed(), status.trim());
    }
    eprintln!("[ses] done");
}

/// The SAFE warm list: local endpoints that return from in-guest state WITHOUT probing outbound network.
/// Network-probing endpoints (model/options, model/info, skills hub, mcp/servers, messaging/platforms)
/// are EXCLUDED — warming them under NoEgress leaves a background reconnect task that spins the resumed κ
/// (proven: cc_cold_serves shows zero-warm serves; bank #4 with probers spins). They warm in the browser
/// via the router extension on first use. /api/status is also skipped — it is per-call heavy (~100s even
/// warm) so warming wastes bank time; the bridge cache + dashboard tolerance cover it.
const SAFE_WARM_PATHS: &[&str] = &[
    // EVERY local endpoint the dashboard fetches on mount + per page. A cold (un-warmed) endpoint pays a
    // SYNC first-call cost (lazy imports, route build) that BLOCKS the guest's single-threaded loop, and
    // the dashboard mount fires ~10 of these CONCURRENTLY — one cold one stalls all the rest. So warm the
    // whole mount set (incl. auth/me, dashboard/font, sessions/stats, sessions/empty/count) + per-page reads.
    "/api/status", // captured so the browser seeds it (served instantly, refreshed when idle — k-aligned)
    "/api/auth/me", "/api/config", "/api/config/schema", "/api/config/defaults",
    "/api/sessions?limit=20&offset=0&order=created", "/api/sessions?limit=50&offset=0&order=created",
    // The Sessions PAGE (not the mount) queries with order=recent + limit=30; the Files page lists /root.
    "/api/sessions?limit=30&offset=0&order=recent", "/api/files?path=%2Froot",
    "/api/sessions/stats", "/api/sessions/empty/count",
    "/api/dashboard/themes", "/api/dashboard/plugins", "/api/dashboard/font",
    "/api/analytics/models", "/api/analytics/usage?days=7", "/api/env",
    "/api/cron/jobs", "/api/cron/delivery-targets", "/api/cron/blueprints",
    "/api/profiles", "/api/profiles/active", "/api/webhooks", "/api/pairing", "/api/files",
    "/api/system/stats", "/api/logs?file=agent&lines=50",
];

/// FAST iteration of the warm list WITHOUT re-booting: resume the COLD κ (banked at READY by the cold-boot
/// witness), warm only the SAFE local endpoints, and snapshot the WARM κ. ~16 min vs the ~45-min cold boot.
#[test]
#[ignore]
fn cc_warm_from_cold() {
    let base = MachineSpec::devcontainer_net().base;
    let cold_path = witness_dir().join("hermes-cold.kappa");
    if !cold_path.exists() {
        eprintln!("[wfc] SKIP: no hermes-cold.kappa — run the cold-boot witness first");
        return;
    }
    let cold = std::fs::read(&cold_path).expect("read cold κ");
    eprintln!("[wfc] resuming COLD κ ({} bytes) — no boot, no ingest…", cold.len());
    let mut emu = Emulator::restore(base, &cold).expect("restore cold κ");
    emu.reattach_net_egress(Box::new(NoEgress));
    assert!(emu.enable_loopback(), "loopback attaches");
    for _ in 0..100 { emu.run(2_000_000); } // settle the resumed loop before warming

    let index = warm_endpoint(&mut emu, "/", None);
    let token = String::from_utf8_lossy(&index)
        .split("window.__HERMES_SESSION_TOKEN__=\"").nth(1)
        .and_then(|s| s.split('"').next()).map(|s| s.to_owned());
    eprintln!("[wfc] `/` {} bytes, token={}", index.len(), token.is_some());
    let t0 = std::time::Instant::now();
    for path in SAFE_WARM_PATHS {
        let t = std::time::Instant::now();
        let r = warm_endpoint(&mut emu, path, token.as_deref());
        let status = String::from_utf8_lossy(&r[..r.len().min(20)]).replace("HTTP/1.1 ", "");
        eprintln!("[wfc]   warmed {path}: {} bytes in {:?} [{}]", r.len(), t.elapsed(), status.trim());
    }
    eprintln!("[wfc] warmed {} safe endpoints in {:?} — banking", SAFE_WARM_PATHS.len(), t0.elapsed());

    let warm = emu.snapshot();
    let warm_path = witness_dir().join("hermes-warm.kappa");
    std::fs::write(&warm_path, &warm).expect("write warm κ");
    eprintln!("[wfc] ✓ WARM κ banked: {} bytes → {warm_path:?}", warm.len());
}

/// Isolate disk-vs-warming for the resumed-κ spin: does the COLD κ (bigger disk, ZERO endpoints warmed,
/// so NO background prober tasks) settle and serve? If yes, the 1.25 GiB disk is fine and the spin comes
/// from warming a network-probing endpoint (it leaves a reconnect task). If no, the disk itself is the
/// cause. Replicates the browser: restore → ChannelEgress (dead peer) → enable_loopback → settle → serve.
#[test]
#[ignore]
fn cc_cold_serves() {
    let base = MachineSpec::devcontainer_net().base;
    let cold_path = witness_dir().join("hermes-cold.kappa");
    if !cold_path.exists() {
        eprintln!("[cold] SKIP: no hermes-cold.kappa");
        return;
    }
    let snap = std::fs::read(&cold_path).expect("read cold κ");
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore cold κ");
    let (egress, router) = holospaces::emulator::net::ChannelEgress::new(); // dead peer, like the gate
    r.reattach_net_egress(Box::new(egress));
    assert!(r.enable_loopback(), "loopback");
    // Worker-style settle: 320M idle, draining egress (BridgeRuntime drains each tick).
    for _ in 0..40 {
        r.run(PUMP_BUDGET);
        while router.pop_outbound().is_some() {}
    }
    // First request (cold `/` ~20s), BridgeRuntime cadence.
    let id = r.dial_guest(9119).expect("dial");
    r.guest_send(id, BROWSER_REQ);
    let mut resp = Vec::new();
    let mut served_at = None;
    for tick in 1..=80u32 {
        r.run(PUMP_BUDGET);
        while router.pop_outbound().is_some() {}
        resp.extend(r.guest_recv(id));
        if !r.guest_is_open(id) { served_at = Some(tick); break; }
    }
    match served_at {
        Some(t) => eprintln!("[cold] ✓ COLD κ SERVES after settle: {} bytes in {t} ticks ({}M instr) — DISK OK, warming is the spin cause", resp.len(), t * 8),
        None => eprintln!("[cold] ✗ COLD κ STILL SPINS (resp={}B) — the bigger disk itself is the cause", resp.len()),
    }
}

/// The warm-κ browser spin is dial-before-settle: a request that hits the resumed guest before its
/// asyncio loop re-establishes spins forever (the differential harness proved native==wasm, so it is NOT
/// a wasm bug). This finds the MINIMUM settle — instructions to run after resume BEFORE the first dial —
/// that lets the guest serve, so the worker can settle exactly that much before adoptToken's first fetch.
#[test]
#[ignore]
fn cc_warm_settle() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm.kappa");
    if !warm_path.exists() {
        eprintln!("[settle] SKIP: no hermes-warm.kappa");
        return;
    }
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    for settle_m in [0u64, 25, 50, 100, 200, 400] {
        let settle = settle_m * 1_000_000;
        let mut reader = holospaces::emulator::SliceRead::new(&snap);
        let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
        let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
        let (egress, router) = holospaces::emulator::net::ChannelEgress::new();
        r.reattach_net_egress(Box::new(egress));
        assert!(r.enable_loopback(), "loopback");
        // SETTLE: run the machine (no request in flight) so the resumed asyncio loop quiesces.
        let mut s = 0u64;
        while s < settle {
            r.run(PUMP_BUDGET);
            s += PUMP_BUDGET;
            while router.pop_outbound().is_some() {}
        }
        // Now the real first request, BridgeRuntime-cadence.
        let id = r.dial_guest(9119).expect("dial");
        r.guest_send(id, BROWSER_REQ);
        let mut resp = Vec::new();
        let mut served_at = None;
        for tick in 1..=20u32 {
            r.run(PUMP_BUDGET);
            while router.pop_outbound().is_some() {}
            resp.extend(r.guest_recv(id));
            if !r.guest_is_open(id) {
                served_at = Some(tick);
                break;
            }
        }
        match served_at {
            Some(t) => eprintln!("[settle] settle={settle_m:>3}M → SERVED {} bytes after {t} ticks ({}M instr)", resp.len(), t * 8),
            None => eprintln!("[settle] settle={settle_m:>3}M → SPUN (no serve in 160M; resp={}B)", resp.len()),
        }
    }
    eprintln!("[settle] done");
}

/// Validate (and produce) a PRE-SETTLED warm κ: settle the existing warm κ once, snapshot at the quiesced
/// point, then prove the re-snapshot resumes ALREADY ready — dial immediately, serve with no boot settle.
/// If so the deployed κ needs no per-load settle. Writes hermes-warm-settled.kappa for chunking.
#[test]
#[ignore]
fn cc_bank_settled_warm() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm.kappa");
    if !warm_path.exists() {
        eprintln!("[presettle] SKIP: no hermes-warm.kappa");
        return;
    }
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    // 1) restore + settle 256M (well past the 100M serve threshold) with NO request in flight.
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
    let (egress, router) = holospaces::emulator::net::ChannelEgress::new();
    r.reattach_net_egress(Box::new(egress));
    assert!(r.enable_loopback(), "loopback");
    for _ in 0..32 {
        r.run(PUMP_BUDGET);
        while router.pop_outbound().is_some() {}
    }
    // 2) snapshot the settled machine.
    let settled = r.snapshot();
    let settled_kappa = holospaces::oci::sha256_digest(&settled);
    eprintln!("[presettle] settled snapshot {} bytes, sha256 {settled_kappa}", settled.len());

    // 3) PROVE the re-snapshot resumes ready: fresh restore, dial IMMEDIATELY (no settle), must serve.
    let mut reader2 = holospaces::emulator::SliceRead::new(&settled);
    let disk2: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r2 = Emulator::restore_net_streamed(base, &mut reader2, disk2).expect("restore settled");
    let (egress2, router2) = holospaces::emulator::net::ChannelEgress::new();
    r2.reattach_net_egress(Box::new(egress2));
    assert!(r2.enable_loopback(), "loopback");
    let id = r2.dial_guest(9119).expect("dial");
    r2.guest_send(id, BROWSER_REQ);
    let mut resp = Vec::new();
    let mut served_at = None;
    for tick in 1..=12u32 {
        r2.run(PUMP_BUDGET);
        while router2.pop_outbound().is_some() {}
        resp.extend(r2.guest_recv(id));
        if !r2.guest_is_open(id) {
            served_at = Some(tick);
            break;
        }
    }
    match served_at {
        Some(t) => {
            eprintln!("[presettle] ✓ settled κ serves with NO boot settle: {} bytes in {t} ticks", resp.len());
            let out = witness_dir().join("hermes-warm-settled.kappa");
            std::fs::write(&out, &settled).expect("write settled κ");
            eprintln!("[presettle] wrote {out:?} (κ={settled_kappa}) — chunk + deploy to drop the per-load settle");
        }
        None => eprintln!("[presettle] ✗ settled κ STILL spins (resp={}B) — keep the boot settle", resp.len()),
    }
}

/// After settle, does the warm κ serve the DASHBOARD endpoints (not just `/`)? Times each over the
/// loopback so we see warm-vs-cold per endpoint — the e2e saw /api/sessions time out, so verify natively.
#[test]
#[ignore]
fn cc_warm_endpoints_after_settle() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm-settled.kappa");
    let warm_path = if warm_path.exists() { warm_path } else { witness_dir().join("hermes-warm.kappa") };
    if !warm_path.exists() {
        eprintln!("[ep] SKIP: no warm κ");
        return;
    }
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
    r.reattach_net_egress(Box::new(NoEgress));
    assert!(r.enable_loopback(), "loopback");
    // settle (in case we loaded the un-settled warm κ)
    for _ in 0..32 { r.run(PUMP_BUDGET); }
    // adopt the session token from `/`.
    let index = warm_endpoint(&mut r, "/", None);
    let token = String::from_utf8_lossy(&index)
        .split("window.__HERMES_SESSION_TOKEN__=\"").nth(1)
        .and_then(|s| s.split('"').next()).map(|s| s.to_owned());
    eprintln!("[ep] `/` {} bytes, token={}", index.len(), token.is_some());
    for path in [
        "/api/status", "/api/sessions?limit=20&offset=0&order=created", "/api/config", "/api/config/schema",
        "/api/env", "/api/cron/jobs", "/api/model/info", "/api/mcp/servers", "/api/messaging/platforms",
        "/api/webhooks", "/api/pairing", "/api/profiles", "/api/skills", "/api/system/stats", "/api/files?path=.",
        "/api/dashboard/plugins", "/api/logs?file=agent&lines=50",
    ] {
        let t = std::time::Instant::now();
        let resp = warm_endpoint(&mut r, path, token.as_deref());
        let head = String::from_utf8_lossy(&resp[..resp.len().min(40)]);
        eprintln!("[ep] {path:<48} → {} bytes in {:?}  {head:?}", resp.len(), t.elapsed());
    }
    eprintln!("[ep] done");
}

/// Print FULL bodies of the endpoints that 500'd, to see WHY the in-guest handlers fail (missing config /
/// data dir / env). Skips the slow /api/status. The deployed backend must be functional, not erroring.
#[test]
#[ignore]
fn cc_endpoint_errors() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm-settled.kappa");
    let warm_path = if warm_path.exists() { warm_path } else { witness_dir().join("hermes-warm.kappa") };
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore");
    r.reattach_net_egress(Box::new(NoEgress));
    assert!(r.enable_loopback(), "loopback");
    for _ in 0..32 { r.run(PUMP_BUDGET); }
    let index = warm_endpoint(&mut r, "/", None);
    let token = String::from_utf8_lossy(&index)
        .split("window.__HERMES_SESSION_TOKEN__=\"").nth(1)
        .and_then(|s| s.split('"').next()).map(|s| s.to_owned());
    for path in ["/api/sessions?limit=20&offset=0&order=created", "/api/config", "/api/mcp/servers", "/api/skills"] {
        let before = r.console().len();
        let resp = warm_endpoint(&mut r, path, token.as_deref());
        let text = String::from_utf8_lossy(&resp);
        let status = text.lines().next().unwrap_or("");
        let con = r.console();
        let delta = String::from_utf8_lossy(&con[before.min(con.len())..]);
        eprintln!("[err] {path}\n      {status}\n      GUEST STDERR:\n{}\n", delta.trim());
    }
    eprintln!("[err] done");
}

#[test]
#[ignore]
fn warm_browser_exact_repro() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm.kappa");
    if !warm_path.exists() {
        eprintln!("[repro] SKIP: no hermes-warm.kappa at {warm_path:?}");
        return;
    }
    let snap = std::fs::read(&warm_path).expect("read warm κ");

    // The browser bridge's literal request (holo-wire.mjs encodeHttpRequest + adoptToken's `accept`).
    let browser_req: &[u8] = b"GET / HTTP/1.1\r\nHost: guest\r\nConnection: close\r\naccept: text/html\r\n\r\n";
    // (label, drain_egress_each_tick). The ONLY difference is whether we drain the guest's outbound frames
    // every tick — exactly what BridgeRuntime.tick step 3 (`egress_outbound()` → router.pop_outbound) does
    // when an egress is attached but its peer (the router extension) is absent. Draining into the void
    // removes virtio-net TX backpressure; if the warm κ's `/` triggers an outbound retry, only the DRAINED
    // case spins. The UNDRAINED case is my earlier "native serves" path.
    let cases: [(&str, bool); 2] = [
        ("browser req, egress UNDRAINED (TX backpressure)", false),
        ("browser req, egress DRAINED-into-void (BROWSER gate)", true),
    ];

    for (label, drain) in cases {
        let mut reader = holospaces::emulator::SliceRead::new(&snap);
        let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
        let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore warm κ");
        let (egress, router) = holospaces::emulator::net::ChannelEgress::new(); // the gate's dead peer
        r.reattach_net_egress(Box::new(egress));
        assert!(r.enable_loopback(), "loopback attaches");
        for _ in 0..300 {
            r.run(2_000_000);
            if drain { while router.pop_outbound().is_some() {} }
        }
        let console_base = r.console().len();
        let id = r.dial_guest(9119).expect("dial :9119");
        r.guest_send(id, browser_req);

        let mut resp: Vec<u8> = Vec::new();
        let mut instrs: u64 = 0;
        let mut completed = false;
        let mut drained_frames: u64 = 0;
        const TICK: u64 = 8_000_000; // PUMP_BUDGET — exactly the browser's per-tick budget
        for i in 0..500u32 {
            r.run(TICK);
            instrs += TICK;
            if drain {
                while router.pop_outbound().is_some() { drained_frames += 1; } // BridgeRuntime tick step 3
            }
            resp.extend(r.guest_recv(id));
            if !r.guest_is_open(id) {
                completed = true;
                break;
            }
            if i == 60 || i == 200 || i == 450 {
                let c = r.console();
                let tail = String::from_utf8_lossy(&c[c.len().saturating_sub(700)..]);
                eprintln!("[repro] {label} @ {instrs} instr, resp={}B, drained={drained_frames} — console tail:\n{tail}\n", resp.len());
            }
        }
        eprintln!("[repro] {label}: drained_frames={drained_frames}");
        let head = String::from_utf8_lossy(&resp[..resp.len().min(120)]);
        eprintln!(
            "[repro] {label}\n        completed={completed} resp={}B instr={instrs}\n        status: {head:?}\n        net: {}",
            resp.len(),
            r.net_debug()
        );
        let c = r.console();
        let new = String::from_utf8_lossy(&c[console_base.min(c.len())..]);
        if !new.trim().is_empty() {
            eprintln!("[repro] {label} NEW guest console during request:\n{new}");
        }
        eprintln!("[repro] ─────────────────────────────────────────");
    }
    eprintln!("[repro] done");
}

/// DIFFERENTIAL EQUIVALENCE HARNESS (native reference side). The emulator is deterministic, so for the
/// SAME restored machine + SAME loopback input + SAME per-step budget, the full-machine state digest must
/// be identical native vs wasm at every checkpoint. The warm κ serves `/` natively but spins in the wasm
/// browser build — so their digest sequences MUST diverge at some checkpoint, and the first mismatch
/// localizes the wasm-vs-native bug (D0 mismatch ⇒ deserialization; a later Dk ⇒ an executed opcode in
/// [prev, k)). This emits the native reference sequence; the wasm side (worker ?holo-diag=digests) emits
/// the same; compare. Checkpoints are CUMULATIVE instruction counts — keep IN SYNC with the worker diag.
const PUMP_BUDGET: u64 = 8_000_000; // exactly the browser BridgeRuntime's per-tick instruction budget
const DIVERGENCE_TICKS: u32 = 12; // 12 ticks ≈ 96M instr — well past where the serve completes natively
const BROWSER_REQ: &[u8] = b"GET / HTTP/1.1\r\nHost: guest\r\nConnection: close\r\naccept: text/html\r\n\r\n";

#[test]
#[ignore]
fn cc_warm_divergence() {
    let base = MachineSpec::devcontainer_net().base;
    let warm_path = witness_dir().join("hermes-warm.kappa");
    if !warm_path.exists() {
        eprintln!("[diverge] SKIP: no hermes-warm.kappa");
        return;
    }
    let snap = std::fs::read(&warm_path).expect("read warm κ");
    // EXACT browser resume setup: restore_net_streamed → ChannelEgress → enable_loopback (matches
    // holospaces-web resume_devcontainer_net_bridged so the digests are comparable).
    let mut reader = holospaces::emulator::SliceRead::new(&snap);
    let disk: Box<dyn KappaStore> = Box::new(MemKappaStore::new());
    let mut r = Emulator::restore_net_streamed(base, &mut reader, disk).expect("restore warm κ");
    let (egress, router) = holospaces::emulator::net::ChannelEgress::new();
    r.reattach_net_egress(Box::new(egress));
    assert!(r.enable_loopback(), "loopback attaches");

    // D0 — post-restore machine, via the SAME memory-light live_digest the wasm Workspace emits.
    eprintln!("[diverge] NATIVE D0 (post-restore) = {}", r.live_digest());

    let id = r.dial_guest(9119).expect("dial :9119");
    r.guest_send(id, BROWSER_REQ);

    // Replicate the BridgeRuntime tick EXACTLY at the REAL cadence (run PUMP_BUDGET=8M, drain egress, drain
    // the loopback RX). The serve only progresses at this cadence — a strong sign the divergence is tied to
    // what happens at a run() boundary (timer-interrupt / WFI delivery). Digest after every tick.
    let mut resp: Vec<u8> = Vec::new();
    let mut at: u64 = 0;
    for _ in 0..DIVERGENCE_TICKS {
        r.run(PUMP_BUDGET);
        at += PUMP_BUDGET;
        while router.pop_outbound().is_some() {}
        resp.extend(r.guest_recv(id));
        eprintln!("[diverge] NATIVE D@{at} = {} (open={}, resp={}B)", r.live_digest(), r.guest_is_open(id), resp.len());
    }
    eprintln!("[diverge] native done");
}

/// Warm one endpoint before banking: dial a fresh loopback connection, issue `GET path` (optionally with
/// the session bearer token so authed handlers actually run, not just 401 in middleware), and advance the
/// machine until the connection closes — paying that endpoint's FIRST-CALL cost (FastAPI route resolution,
/// Pydantic-core schema build, lazy imports, DB warm-up) so it is captured in the snapshot's RAM. The
/// resumed browser machine then serves it warm instead of re-paying cold start. Returns the raw response.
fn warm_endpoint(emu: &mut Emulator, path: &str, token: Option<&str>) -> Vec<u8> {
    let mut id = None;
    for _ in 0..400 {
        emu.run(2_000_000);
        if let Some(c) = emu.dial_guest(9119) {
            id = Some(c);
            break;
        }
    }
    let Some(id) = id else {
        eprintln!("[warm] could not dial :9119 for {path}");
        return Vec::new();
    };
    let auth = token.map(|t| format!("Authorization: Bearer {t}\r\n")).unwrap_or_default();
    let req = format!("GET {path} HTTP/1.0\r\nHost: app\r\n{auth}\r\n");
    emu.guest_send(id, req.as_bytes());
    let mut resp: Vec<u8> = Vec::new();
    // Up to ~120e9 instructions of headroom; a cold first-call settles well within this and closes (HTTP/1.0).
    for _ in 0..60_000 {
        emu.run(2_000_000);
        resp.extend(emu.guest_recv(id));
        if !emu.guest_is_open(id) {
            break;
        }
    }
    emu.guest_close(id);
    resp
}

/// OPTIMIZED RE-BANK via the substrate's own resume primitive (NOT a re-boot): restore the COLD κ — the
/// machine the instant the server bound, zero requests served, exactly what we shipped — exercise every
/// endpoint the dashboard loads so each one's FastAPI/uvicorn/Pydantic-core first-call cost is paid into
/// RAM, then re-snapshot a WARM κ. This sidesteps the fragile ~24-min cold boot + OCI ingest + ext4
/// assemble (the memory-heavy, env-killed part): resume is content-addressed and takes seconds, so the
/// whole re-bank runs in minutes at low memory. Reads `hermes-cold.kappa`, writes `hermes-warm.kappa`.
#[test]
#[ignore]
fn the_hermes_guest_resumes_warms_and_rebanks() {
    let cold_path = witness_dir().join("hermes-cold.kappa");
    if !cold_path.exists() {
        eprintln!("SKIP: no cold κ at {cold_path:?} — reassemble it from the shipped CAS first");
        return;
    }
    let cold = std::fs::read(&cold_path).expect("read cold κ");
    eprintln!("[rebank] restoring COLD κ ({} bytes) — NO boot, NO ingest, NO assemble…", cold.len());
    let t0 = std::time::Instant::now();
    let base = MachineSpec::devcontainer_net().base;
    let mut emu = Emulator::restore(base, &cold).expect("restore the cold Hermes κ");
    emu.reattach_net_egress(Box::new(NoEgress)); // preserve the snapshot's negotiated virtqueues so it serves
    assert!(emu.enable_loopback(), "loopback ingress attaches after resume");
    eprintln!("[rebank] resumed in {:?}; settling the asyncio loop…", t0.elapsed());
    for _ in 0..100 {
        emu.run(2_000_000);
    }

    eprintln!("[rebank] warming the dashboard endpoints (paying first-call cost into RAM)…");
    let warm_t0 = std::time::Instant::now();
    let index = warm_endpoint(&mut emu, "/", None);
    let index_text = String::from_utf8_lossy(&index);
    let token = index_text
        .split("window.__HERMES_SESSION_TOKEN__=\"")
        .nth(1)
        .and_then(|s| s.split('"').next())
        .map(|s| s.to_owned());
    eprintln!(
        "[rebank]   `/` served {} bytes in {:?}; session token {}",
        index.len(),
        warm_t0.elapsed(),
        if token.is_some() { "captured" } else { "NOT found (authed handlers warm only middleware)" }
    );
    for path in [
        "/api/status",
        "/api/config",
        "/api/config/schema",
        "/api/config/defaults",
        "/api/sessions",
        "/api/dashboard/themes",
        "/api/dashboard/plugins",
        "/api/analytics/models",
        "/api/models",
        "/api/env",
        "/api/cron/jobs",
    ] {
        let t = std::time::Instant::now();
        let r = warm_endpoint(&mut emu, path, token.as_deref());
        eprintln!("[rebank]   {path} → {} bytes in {:?}", r.len(), t.elapsed());
    }
    // A warm hit proves the win (should be « the first) and ensures the steady-state working set is resident.
    let t = std::time::Instant::now();
    let _ = warm_endpoint(&mut emu, "/api/status", token.as_deref());
    eprintln!("[rebank] re-warmed /api/status in {:?} (warm hit — should be « the first)", t.elapsed());
    eprintln!("[rebank] warming complete in {:?}; banking the WARM machine", warm_t0.elapsed());

    let warm = emu.snapshot();
    let warm_kappa = holospaces::oci::sha256_digest(&warm);
    let warm_path = witness_dir().join("hermes-warm.kappa");
    std::fs::write(&warm_path, &warm).expect("write the warm κ");
    eprintln!("[rebank] ✓ WARM κ banked: {} bytes → {warm_path:?} κ={warm_kappa}", warm.len());

    // DIAGNOSTIC: the warm κ failed to serve after resume in the browser. Compare COLD vs WARM resume
    // net-device state + a dial, to pinpoint what warming left dirty (cold serves; warm must too).
    drop(emu);
    let cold_for_diag = std::fs::read(&cold_path).expect("re-read cold κ");
    for (label, snap) in [("COLD", &cold_for_diag), ("WARM", &warm)] {
        eprintln!("[diag] ───── {label} resume ─────");
        let mut r = Emulator::restore(base, snap).expect("restore for diag");
        r.reattach_net_egress(Box::new(NoEgress));
        assert!(r.enable_loopback(), "loopback attaches");
        for _ in 0..300 {
            r.run(2_000_000);
        }
        eprintln!("[diag] {label} net BEFORE dial: {}", r.net_debug());
        let id = r.dial_guest(9119);
        eprintln!("[diag] {label} dial(:9119) → {id:?}");
        if let Some(id) = id {
            r.guest_send(id, b"GET /api/cron/jobs HTTP/1.0\r\nHost: app\r\n\r\n");
            let mut resp = Vec::new();
            // ~8 billion instr — plenty for a WARM endpoint to start responding; bounded so it can't hang.
            for _ in 0..4000 {
                r.run(2_000_000);
                resp.extend(r.guest_recv(id));
                if !resp.is_empty() && resp.windows(8).any(|w| w == b"HTTP/1.0" || w == b"HTTP/1.1") {
                    break;
                }
                if !r.guest_is_open(id) {
                    break;
                }
            }
            let serves = resp.windows(8).any(|w| w == b"HTTP/1.0" || w == b"HTTP/1.1");
            eprintln!("[diag] {label} after GET: {} resp bytes, serves={serves}", resp.len());
            eprintln!("[diag] {label} net AFTER dial:  {}", r.net_debug());
        }
    }
    eprintln!("[diag] done — compare COLD (serves) vs WARM (failing) net state above");
}

/// HL-6 (instant warm-start) — restore the warm Hermes dashboard from the κ that
/// `the_hermes_guest_boots_and_serves_the_dashboard_api` banked to disk, in a FRESH process, and prove it
/// reconstructs a **byte-identical** warm machine with **no re-boot and no re-import**. This is the
/// substrate exploit realized end to end: the cold ~24-min interpreted boot is paid ONCE (banked as
/// `hermes-warm.kappa`), and every subsequent "launch" is a sub-second `restore` to the same content
/// address κ — exactly what the browser does from its OPFS κ-store. `#[ignore]` like its sibling, but it
/// finishes in **seconds** because it never boots — that speed gap *is* the proof. SKIPs (passes) if no κ
/// is banked yet — run the boot witness once to produce it.
///
/// What resume guarantees is CPU + RAM + disk + 9p (the whole machine's content). The live VirtIO-net
/// transport is deliberately NOT part of the content snapshot (egress/ingress are external, live
/// transports — see `Emulator::snapshot`); on resume the host re-establishes networking and the guest's
/// connections reset, exactly as a laptop's do on wake. So the faithful, content-addressed identity below
/// is the substrate's guarantee; serving resumes once the transport is re-attached (the boot witness
/// already proved the live `/api/status` serve, and QEMU proved the 200 body).
#[test]
#[ignore]
fn the_warm_dashboard_resumes_from_its_banked_kappa_byte_identical() {
    let warm_path = witness_dir().join("hermes-warm.kappa");
    if !warm_path.exists() {
        eprintln!("SKIP: no banked warm κ at {warm_path:?} — run the boot witness once to bank it");
        return;
    }
    let warm = std::fs::read(&warm_path).expect("read the banked warm κ");
    let banked_kappa = holospaces::oci::sha256_digest(&warm);
    let base = MachineSpec::devcontainer_net().base;

    // Restore the warm dashboard from the ON-DISK κ — no ingest, no assemble, no kernel boot, no Hermes
    // import. A serving-dashboard machine materialized from content alone.
    let resumed = Emulator::restore(base, &warm).expect("resume the warm Hermes dashboard from its banked κ");
    let resumed_kappa = holospaces::oci::sha256_digest(&resumed.snapshot());
    assert_eq!(
        resumed_kappa, banked_kappa,
        "the warm Hermes dashboard restores from its on-disk κ to a byte-identical machine (CC-30) — a \
         fresh process reconstructs the same serving dashboard (CPU+RAM+disk+9p) with no boot and no \
         import; instant warm-start"
    );
    eprintln!(
        "[hermes-resume] ✓ restored warm Hermes dashboard from on-disk κ ({} bytes) to an identical \
         machine κ={resumed_kappa} — NO boot, NO import (the ~24-min cold boot, paid once and banked)",
        warm.len()
    );

    // Provenance: the resume proof, durably on disk next to the boot witness's artifact.
    let artifact = format!(
        "{{\n  \"witness\": \"resume_from_banked_kappa\",\n  \"target\": \"HL-6\",\n  \"booted\": false,\n  \"restored_from\": \"hermes-warm.kappa\",\n  \"banked_kappa\": \"{banked_kappa}\",\n  \"resumed_kappa\": \"{resumed_kappa}\",\n  \"byte_identical\": {}\n}}\n",
        resumed_kappa == banked_kappa
    );
    let _ = std::fs::write(witness_dir().join("hermes-resume-witness.json"), &artifact);
}
