#!/usr/bin/env bash
# crash-trace.sh — append system + witness resource stats to a persistent log every 2s, so that if the
# codespace recycles mid-run we can read (post-restart) exactly what the resource picture was at the
# moment of death: a memory/load spike (workload-caused) vs. flat resources (external platform recycle).
# Writes to /workspaces (proven to persist across the restarts). Runs until killed/restart.
set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT=vv/witness/crash-trace.log
echo "# crash-trace start $(date -u '+%Y-%m-%dT%H:%M:%SZ') uptime=$(awk '{print $1}' /proc/uptime)s" >> "$OUT"
while true; do
  ts=$(date '+%H:%M:%S')
  read -r mu ma <<<"$(free -m | awk '/Mem:/{print $3, $7}')"
  la=$(awk '{print $1" "$2" "$3}' /proc/loadavg)
  wr=$(ps -o rss= -C cc_hermes_guest 2>/dev/null | head -1)
  wc_=$(ps -o pcpu= -C cc_hermes_guest 2>/dev/null | head -1)
  echo "$ts load=[$la] mem_used=${mu}MB mem_avail=${ma}MB witness_rss_kb=${wr:-0} witness_cpu=${wc_:-0}" >> "$OUT"
  sync "$OUT" 2>/dev/null
  sleep 2
done
