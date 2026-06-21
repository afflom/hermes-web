//! Serve-after-resume diagnostic: load the BANKED warm κ, restore it the way the browser's
//! `resume_devcontainer_net_bridged` does (restore → attach a router egress → enable loopback), then
//! pump and dial the in-guest dashboard on :9119 and read `/api/status`. The boot witness proved
//! boot→serve and snapshot→resume κ-identity; this proves the missing link the browser needs — that a
//! RESUMED machine actually SERVES over the loopback bridge. Run against vv/witness/hermes-warm.kappa.
use std::io::Read;
use std::path::{Path, PathBuf};

use holospaces::emulator::net::ChannelEgress;
use holospaces::emulator::{Emulator, Halt};
use holospaces::machine::MachineSpec;

fn warm_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../vv/witness/hermes-warm.kappa")
}

#[test]
#[ignore]
fn the_resumed_dashboard_serves_over_loopback() {
    let p = warm_path();
    if !p.exists() {
        eprintln!("SKIP: no banked warm κ at {p:?}");
        return;
    }
    let mut f = std::fs::File::open(&p).unwrap();
    let mut warm = Vec::new();
    f.read_to_end(&mut warm).unwrap();
    eprintln!("[resume-serve] read warm κ: {} bytes", warm.len());

    // EXACTLY what Workspace::resume_devcontainer_net_bridged does.
    let base = MachineSpec::devcontainer().base;
    let mut emu = Emulator::restore(base, &warm).expect("restore the warm machine");
    let (egress, _router) = ChannelEgress::new();
    emu.attach_net(Box::new(egress));
    let looped = emu.enable_loopback();
    eprintln!("[resume-serve] restored; enable_loopback={looped}");
    assert!(looped, "loopback must enable (virtionet present after attach_net)");

    // Pump and dial until the resumed server accepts a loopback connection.
    let mut id = None;
    for i in 0..4000 {
        emu.run(2_000_000);
        if let Some(c) = emu.dial_guest(9119) {
            id = Some(c);
            eprintln!("[resume-serve] dial succeeded at pump {i}, conn={c}");
            break;
        }
        if i % 200 == 0 {
            eprintln!("[resume-serve] pump {i}, still dialing…");
        }
    }
    let id = id.expect("the resumed in-guest server accepts a loopback dial");

    for _ in 0..80 {
        emu.run(2_000_000);
    }
    emu.guest_send(id, b"GET /api/status HTTP/1.0\r\nHost: app\r\n\r\n");
    let mut resp: Vec<u8> = Vec::new();
    for _ in 0..40_000 {
        emu.run(2_000_000);
        resp.extend(emu.guest_recv(id));
        if resp.windows(8).any(|w| w == b"HTTP/1.0") || resp.windows(8).any(|w| w == b"HTTP/1.1") {
            break;
        }
        if !emu.guest_is_open(id) {
            break;
        }
    }
    let text = String::from_utf8_lossy(&resp);
    eprintln!("[resume-serve] response ({} bytes): {}", resp.len(), &text.chars().take(200).collect::<String>());
    assert!(text.contains("HTTP/1."), "the RESUMED dashboard served /api/status over loopback");
    eprintln!("[resume-serve] ✓ serve-after-resume works");
}
