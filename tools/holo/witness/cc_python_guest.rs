//! HL-B / HL-C mechanism witness — CPython boots in the in-browser RISC-V guest and a Python server
//! inside it is reached from the host over the in-process loopback bridge. Identical path to `CC-33`
//! (ingest OCI → assemble ext4 → boot → `enable_loopback` → `dial_guest`), but the guest is the
//! `riscv64/python:3.11-slim` base image with an injected `/init` that proves Python runs and then
//! serves a marker on `:9119`. This isolates the convergence MECHANISM (HL-B python-in-guest + HL-C
//! host→guest ingress) from the heavier full-Hermes image. `#[ignore]` (a real-OS boot); carried at
//! `tools/holo/witness/cc_python_guest.rs`, run by `tools/holo/witness/run-python-guest.sh`.

use std::io::Read;
use std::path::{Path, PathBuf};

use hologram_store_mem::MemKappaStore;
use hologram_substrate_core::KappaStore;
use holospaces::assembly::{assemble_ext4_with_init, Layer};
use holospaces::emulator::net::NoEgress;
use holospaces::emulator::Halt;
use holospaces::machine::MachineSpec;
use holospaces::oci::ingest_image;

fn image_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../vv/witness/python-riscv64-oci")
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

// Injected /init: prove Python runs (console marker), then run a tiny Python socket server on :9119
// that replies with a fixed marker — the dual of CC-21's initserv, in Python.
const PYTHON_INIT: &[u8] = b"#!/bin/sh\n\
mkdir -p /proc /sys /dev /tmp 2>/dev/null\n\
mount -t proc proc /proc 2>/dev/null\n\
mount -t sysfs sysfs /sys 2>/dev/null\n\
mount -t devtmpfs devtmpfs /dev 2>/dev/null\n\
mount -t tmpfs tmpfs /tmp 2>/dev/null\n\
export HOME=/root TERM=xterm PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin\n\
python3 -c 'import sys; print(\"HERMES-GUEST-PYTHON-OK\", sys.version.split()[0])'\n\
cat > /tmp/srv.py <<'PY'\n\
import socket\n\
s = socket.socket()\n\
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n\
s.bind((\"0.0.0.0\", 9119))\n\
s.listen(1)\n\
print(\"GUEST-LISTENING\", flush=True)\n\
while True:\n\
    c, _ = s.accept(); c.recv(65536); c.send(b\"HELLO-FROM-HERMES-GUEST-PYTHON\"); c.close()\n\
PY\n\
exec python3 /tmp/srv.py\n";

#[test]
#[ignore]
fn cpython_boots_in_the_guest_and_is_reached_over_the_loopback_bridge() {
    let dir = image_dir();
    if !dir.join("index.json").exists() {
        eprintln!("SKIP: base python OCI layout absent (export it; see run-python-guest.sh) dir={dir:?}");
        return;
    }
    let store = MemKappaStore::new();
    let layout = std::fs::read(dir.join("oci-layout")).unwrap();
    let index = std::fs::read(dir.join("index.json")).unwrap();
    let blob_dir = dir.join("blobs/sha256");
    let fetch = |digest: &str| -> Option<Vec<u8>> {
        let hex = digest.strip_prefix("sha256:")?;
        std::fs::read(blob_dir.join(hex)).ok()
    };
    let img = ingest_image(&store, &layout, &index, holospaces::Arch::Riscv64, fetch)
        .expect("ingest the riscv64/python image");
    let blobs: Vec<(String, Vec<u8>)> = img
        .layers()
        .iter()
        .zip(img.layer_media_types())
        .map(|(k, mt)| (mt.clone(), store.get(k).unwrap().unwrap().as_ref().to_vec()))
        .collect();
    let layers: Vec<Layer> = blobs.iter().map(|(mt, b)| Layer { media_type: mt, blob: b }).collect();
    let rootfs = assemble_ext4_with_init(&layers, PYTHON_INIT).expect("assemble python rootfs");
    let kernel = gunzip(&cc16_dir().join("kernel/Image.gz"));

    let mut emu = MachineSpec::devcontainer_net()
        .boot_net(&kernel, rootfs, Box::new(NoEgress))
        .expect("boot the python devcontainer");
    assert!(emu.enable_loopback(), "the loopback bridge attaches");

    // HL-B: CPython boots and the server binds.
    let mut python_ok = false;
    let mut listening = false;
    for _ in 0..400_000 {
        if !matches!(emu.run(5_000_000), Halt::OutOfBudget) {
            break;
        }
        let console = String::from_utf8_lossy(emu.console());
        if console.contains("HERMES-GUEST-PYTHON-OK") {
            python_ok = true;
        }
        if console.contains("GUEST-LISTENING") {
            listening = true;
            break;
        }
    }
    let console = String::from_utf8_lossy(emu.console()).into_owned();
    assert!(python_ok, "CPython booted in the guest (HL-B); console:\n{console}");
    assert!(listening, "the in-guest Python server bound :9119; console:\n{console}");

    // HL-C: the host reaches the in-guest Python server over the loopback bridge.
    let id = emu.dial_guest(9119).expect("dialing the in-guest :9119 returns a connection id");
    for _ in 0..40 {
        emu.run(2_000_000);
    }
    emu.guest_send(id, b"GET / HTTP/1.0\r\nHost: app\r\n\r\n");
    let mut resp: Vec<u8> = Vec::new();
    for _ in 0..20_000 {
        emu.run(2_000_000);
        resp.extend(emu.guest_recv(id));
        if resp.windows(30).any(|w| w == b"HELLO-FROM-HERMES-GUEST-PYTHON") {
            break;
        }
        if !emu.guest_is_open(id) {
            break;
        }
    }
    let text = String::from_utf8_lossy(&resp).into_owned();
    assert!(
        text.contains("HELLO-FROM-HERMES-GUEST-PYTHON"),
        "the host reached the in-guest CPython server over the loopback bridge (HL-B + HL-C); \
         got:\n{text:?}\nconsole:\n{console}"
    );
    emu.guest_close(id);
}
