//! Fast serve-after-resume validation (the net-device-config snapshot fix), using the small CC-21
//! server guest (TCP server on :8080) instead of the 26-min Hermes boot. Boot → serve over loopback →
//! SNAPSHOT → restore + re-attach egress + enable loopback → serve AGAIN. Proves a resumed machine's
//! network device works (the queues the guest negotiated survived the snapshot), which is exactly what
//! `Workspace::resume_devcontainer_net_bridged` relies on in the browser.
use std::io::Read;
use std::path::{Path, PathBuf};

use hologram_store_mem::MemKappaStore;
use hologram_substrate_core::KappaStore;
use holospaces::assembly::{assemble_ext4, Layer};
use holospaces::emulator::net::NoEgress;
use holospaces::emulator::{Emulator, Halt, SliceRead};
use holospaces::machine::MachineSpec;
use holospaces::oci::{ingest_image, IngestedImage, OciError};

fn cc21_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vv/artifacts/cc21")
}
fn cc16_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../vv/artifacts/cc16")
}
fn blob_bytes(digest: &str) -> Option<Vec<u8>> {
    let hex = digest.strip_prefix("sha256:")?;
    std::fs::read(cc21_dir().join("image/blobs/sha256").join(hex)).ok()
}
fn ingest(store: &MemKappaStore) -> Result<IngestedImage, OciError> {
    let layout = std::fs::read(cc21_dir().join("image/oci-layout")).unwrap();
    let index = std::fs::read(cc21_dir().join("image/index.json")).unwrap();
    ingest_image(store, &layout, &index, holospaces::Arch::Riscv64, blob_bytes)
}
fn gunzip(path: &Path) -> Vec<u8> {
    let raw = std::fs::read(path).unwrap();
    let mut d = flate2::read::GzDecoder::new(&raw[..]);
    let mut out = Vec::new();
    d.read_to_end(&mut out).unwrap();
    out
}

/// Dial :8080 over the loopback bridge and assert the guest server's marker comes back.
fn assert_serves(emu: &mut Emulator, ctx: &str) {
    let id = emu.dial_guest(8080).expect("loopback enabled → dial returns an id");
    for _ in 0..40 {
        emu.run(2_000_000);
    }
    emu.guest_send(id, b"GET / HTTP/1.0\r\nHost: app\r\n\r\n");
    let mut resp: Vec<u8> = Vec::new();
    for _ in 0..600 {
        emu.run(2_000_000);
        resp.extend(emu.guest_recv(id));
        if resp.windows(23).any(|w| w == b"HELLO-FROM-GUEST-SERVER") {
            break;
        }
        if !emu.guest_is_open(id) {
            break;
        }
    }
    let text = String::from_utf8_lossy(&resp).into_owned();
    let open = emu.guest_is_open(id);
    eprintln!("[resume-serve-fast] [{ctx}] resp={} bytes, still_open={open}, text={text:?}", resp.len());
    assert!(
        text.contains("HELLO-FROM-GUEST-SERVER"),
        "[{ctx}] the guest server replied over loopback; got:\n{text:?}"
    );
    emu.guest_close(id);
    eprintln!("[resume-serve-fast] ✓ served over loopback ({ctx})");
}

#[test]
#[ignore]
fn a_resumed_guest_still_serves_over_loopback() {
    let store = MemKappaStore::new();
    let img = match ingest(&store) {
        Ok(i) => i,
        Err(_) => {
            eprintln!("SKIP: CC-21 image not present");
            return;
        }
    };
    let blobs: Vec<(String, Vec<u8>)> = img
        .layers()
        .iter()
        .zip(img.layer_media_types())
        .map(|(k, mt)| (mt.clone(), store.get(k).unwrap().unwrap().as_ref().to_vec()))
        .collect();
    let layers: Vec<Layer> = blobs.iter().map(|(mt, b)| Layer { media_type: mt, blob: b }).collect();
    let rootfs = assemble_ext4(&layers).expect("assemble rootfs");
    let kernel = gunzip(&cc16_dir().join("kernel/Image.gz"));

    let spec = MachineSpec::devcontainer_net();
    let base = spec.base;
    let mut emu = spec.boot_net(&kernel, rootfs, Box::new(NoEgress)).expect("boot");
    assert!(emu.enable_loopback(), "loopback attaches");

    // Boot until the server is listening.
    let mut listening = false;
    for _ in 0..400 {
        if !matches!(emu.run(5_000_000), Halt::OutOfBudget) {
            break;
        }
        if String::from_utf8_lossy(emu.console()).contains("SERVER-LISTENING") {
            listening = true;
            break;
        }
    }
    assert!(listening, "server listened; console:\n{}", String::from_utf8_lossy(emu.console()));

    // ── snapshot the CLEAN listening state (NOT after a serve — like the Hermes κ banked at READY).
    // (Serving first would exhaust a one-shot server and snapshot an EXITING guest.) ──
    eprintln!("[resume-serve-fast] net BEFORE snapshot: {}", emu.net_debug());
    let snapshot = emu.snapshot();
    eprintln!("[resume-serve-fast] snapshot {} bytes", snapshot.len());
    drop(emu);
    let mut resumed = Emulator::restore(base, &snapshot).expect("restore");
    eprintln!("[resume-serve-fast] net AFTER restore: {}", resumed.net_debug());
    let preserved = resumed.reattach_net_egress(Box::new(NoEgress));
    assert!(preserved, "the snapshot carried the net device config (preserved, not freshly attached)");
    assert!(resumed.enable_loopback(), "loopback re-enables on the resumed machine");

    // Give the resumed machine a few cycles to re-establish its link before dialing.
    let before = resumed.console().len();
    for i in 0..50 {
        let h = resumed.run(2_000_000);
        if !matches!(h, Halt::OutOfBudget) {
            eprintln!("[resume-serve-fast] run#{i} → {h:?}");
        }
    }
    eprintln!(
        "[resume-serve-fast] post-resume console delta: {} bytes; net: {}",
        resumed.console().len() - before,
        resumed.net_debug()
    );

    // The KEY assertion: the RESUMED guest still serves over loopback (its negotiated device survived).
    assert_serves(&mut resumed, "after resume");
    eprintln!("[resume-serve-fast] ✓✓ serve-after-resume holds");
}

/// STREAMING resume: restore the clean κ via `restore_net_streamed` (paging the disk into a κ-store
/// instead of a monolithic in-RAM image) and prove the resumed guest still SERVES over loopback. This
/// is the substrate half of the browser's OPFS-κ-store path — same machine, disk off the heap.
#[test]
#[ignore]
fn a_streamed_resume_serves_over_loopback() {
    let store = MemKappaStore::new();
    let img = match ingest(&store) {
        Ok(i) => i,
        Err(_) => {
            eprintln!("SKIP: CC-21 image not present");
            return;
        }
    };
    let blobs: Vec<(String, Vec<u8>)> = img
        .layers()
        .iter()
        .zip(img.layer_media_types())
        .map(|(k, mt)| (mt.clone(), store.get(k).unwrap().unwrap().as_ref().to_vec()))
        .collect();
    let layers: Vec<Layer> = blobs.iter().map(|(mt, b)| Layer { media_type: mt, blob: b }).collect();
    let rootfs = assemble_ext4(&layers).expect("assemble rootfs");
    let kernel = gunzip(&cc16_dir().join("kernel/Image.gz"));

    let spec = MachineSpec::devcontainer_net();
    let base = spec.base;
    let mut emu = spec.boot_net(&kernel, rootfs, Box::new(NoEgress)).expect("boot");
    assert!(emu.enable_loopback());
    let mut listening = false;
    for _ in 0..400 {
        if !matches!(emu.run(5_000_000), Halt::OutOfBudget) {
            break;
        }
        if String::from_utf8_lossy(emu.console()).contains("SERVER-LISTENING") {
            listening = true;
            break;
        }
    }
    assert!(listening, "server listened");

    let snapshot = emu.snapshot();
    drop(emu);

    // The streamed restore reads the snapshot sequentially and pages the disk into a (here in-memory,
    // OPFS in the browser) κ-store — the disk image is never materialized whole.
    let mut reader = SliceRead::new(&snapshot);
    let mut resumed = Emulator::restore_net_streamed(base, &mut reader, Box::new(MemKappaStore::new()))
        .expect("streamed restore");
    // Cross-check: the streamed restore reconstructs the SAME machine as the monolithic restore.
    let mono = Emulator::restore(base, &snapshot).expect("monolithic restore");
    assert_eq!(
        holospaces::oci::sha256_digest(&resumed.snapshot()),
        holospaces::oci::sha256_digest(&mono.snapshot()),
        "streamed restore reconstructs a byte-identical machine"
    );

    resumed.reattach_net_egress(Box::new(NoEgress));
    assert!(resumed.enable_loopback());
    for _ in 0..50 {
        resumed.run(2_000_000);
    }
    assert_serves(&mut resumed, "streamed resume");
    eprintln!("[resume-serve-fast] ✓✓ STREAMED resume serves over loopback (disk off-heap)");
}
