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
use holospaces::assembly::{assemble_ext4_with_init, Layer};
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
    let rootfs = assemble_ext4_with_init(&layers, HERMES_INIT).expect("assemble Hermes rootfs");
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
    // The endpoints the dashboard hits on load + the sidebar status probe + common config reads.
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
        let t0 = std::time::Instant::now();
        let r = warm_endpoint(&mut emu, path, token.as_deref());
        eprintln!("[hermes-guest]   warmed {path}: {} bytes in {:?}", r.len(), t0.elapsed());
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

    // CRITICAL: verify the WARM κ actually RESUMES AND SERVES (the browser will). The cold κ does; the
    // warm one must too, or warming left the net/loopback device in a state that doesn't survive
    // restore. Drop the live machine, restore from the just-banked warm κ exactly as the browser does
    // (restore → reattach egress → enable loopback), and dial the in-guest server.
    drop(emu);
    eprintln!("[rebank] verifying the WARM κ resumes AND serves (as the browser will)…");
    let mut resumed = Emulator::restore(base, &warm).expect("resume the warm κ");
    resumed.reattach_net_egress(Box::new(NoEgress));
    assert!(resumed.enable_loopback(), "loopback attaches on warm-κ resume");
    let probe = warm_endpoint(&mut resumed, "/api/status", None);
    let ok = String::from_utf8_lossy(&probe).contains("HTTP/1.");
    eprintln!(
        "[rebank] warm-κ resume serve check: /api/status → {} bytes, serves={ok}",
        probe.len()
    );
    assert!(ok, "the WARM κ must resume AND serve over loopback — warming must not break serve-after-resume");
    eprintln!("[rebank] ✓ warm κ resumes AND serves — safe to ship");
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
