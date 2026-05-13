#!/usr/bin/env bash
# scripts/backup/preflight-host.sh — O02 one-shot host preflight check
# Validates that the host is correctly configured for backup operations.
# Run by `make dev` on first setup, or manually before running backups.
# See spec/modules/O02/PLAN.md §3.3 (fork-OOM mitigation).
set -euo pipefail

PASS=0
WARN=0
FAIL=0
ERRORS=()

ok()   { echo "  [OK]   $*"; PASS=$(( PASS + 1 )); }
warn() { echo "  [WARN] $*"; WARN=$(( WARN + 1 )); }
fail() { echo "  [FAIL] $*"; FAIL=$(( FAIL + 1 )); ERRORS+=("$*"); }

echo "=== vici2 backup host preflight check ==="
echo ""

# ── 1. vm.overcommit_memory must be 1 for Valkey BGSAVE ──────────────────────
echo "[1] Checking vm.overcommit_memory..."
OVERCOMMIT=$(cat /proc/sys/vm/overcommit_memory 2>/dev/null || echo "N/A")
if [[ "$OVERCOMMIT" == "1" ]]; then
  ok "vm.overcommit_memory=1 (required for safe Valkey BGSAVE)"
elif [[ "$OVERCOMMIT" == "N/A" ]]; then
  warn "Cannot read /proc/sys/vm/overcommit_memory (not Linux?)"
else
  fail "vm.overcommit_memory=${OVERCOMMIT} — must be 1 to prevent Valkey fork-OOM on BGSAVE"
  echo "         Remediation: sudo sysctl -w vm.overcommit_memory=1"
  echo "         Permanent: echo 'vm.overcommit_memory = 1' | sudo tee -a /etc/sysctl.d/99-vici2.conf"
fi

# ── 2. Required CLI tools ─────────────────────────────────────────────────────
echo ""
echo "[2] Checking required tools..."
TOOLS=(mysqldump zstd aws sha256sum valkey-cli)
for tool in "${TOOLS[@]}"; do
  if command -v "$tool" &>/dev/null; then
    ok "$tool found at $(command -v "$tool")"
  else
    # valkey-cli might also exist as redis-cli in older environments
    if [[ "$tool" == "valkey-cli" ]] && command -v redis-cli &>/dev/null; then
      warn "valkey-cli not found but redis-cli exists — acceptable if Valkey is Redis-compatible"
    else
      fail "$tool not found in PATH"
    fi
  fi
done

# ── 3. MySQL cnf file (backup-user credentials) ───────────────────────────────
echo ""
echo "[3] Checking MySQL backup credentials file..."
MYSQL_CNF="${MYSQL_CNF:-/etc/vici2/mysql-backup.cnf}"
if [[ -f "$MYSQL_CNF" ]]; then
  PERMS=$(stat -c "%a" "$MYSQL_CNF" 2>/dev/null || stat -f "%Lp" "$MYSQL_CNF" 2>/dev/null || echo "unknown")
  if [[ "$PERMS" == "600" || "$PERMS" == "0600" ]]; then
    ok "${MYSQL_CNF} exists with mode 0600"
  else
    warn "${MYSQL_CNF} exists but has mode ${PERMS} (should be 0600)"
    echo "       Remediation: chmod 0600 ${MYSQL_CNF}"
  fi
elif [[ -f "${HOME}/.my.cnf" ]]; then
  warn "${MYSQL_CNF} not found; ~/.my.cnf will be used as fallback (acceptable for dev)"
else
  warn "No MySQL cnf found at ${MYSQL_CNF} or ~/.my.cnf — mysqldump will require credentials another way"
fi

# ── 4. Prom textfile collector directory ─────────────────────────────────────
echo ""
echo "[4] Checking Prometheus textfile collector directory..."
TEXTFILE_DIR="${VICI2_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
if [[ -d "$TEXTFILE_DIR" ]]; then
  if [[ -w "$TEXTFILE_DIR" ]]; then
    ok "${TEXTFILE_DIR} exists and is writable"
  else
    warn "${TEXTFILE_DIR} exists but is not writable by current user (metrics will not be emitted)"
  fi
else
  warn "${TEXTFILE_DIR} does not exist — Prom backup metrics will not be emitted"
  echo "       Remediation: sudo mkdir -p ${TEXTFILE_DIR}"
fi

# ── 5. Docker availability (for Valkey docker cp mode) ───────────────────────
echo ""
echo "[5] Checking Docker availability..."
if command -v docker &>/dev/null && docker info &>/dev/null 2>&1; then
  ok "Docker is available"
else
  warn "Docker not available — Valkey backup will need --data-dir instead of --docker-cp"
fi

# ── 6. Disk space check ───────────────────────────────────────────────────────
echo ""
echo "[6] Checking disk space in /tmp..."
AVAIL_KB=$(df -k /tmp | awk 'NR==2{print $4}')
AVAIL_GB=$(( AVAIL_KB / 1024 / 1024 ))
if [[ "$AVAIL_GB" -ge 10 ]]; then
  ok "/tmp has ${AVAIL_GB} GB available (≥10 GB recommended for restore operations)"
elif [[ "$AVAIL_GB" -ge 3 ]]; then
  warn "/tmp has ${AVAIL_GB} GB available (≥10 GB recommended; borderline for large DBs)"
else
  fail "/tmp has ${AVAIL_GB} GB available — restore requires 3× compressed artifact size"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "=== preflight summary ==="
echo "  PASS: ${PASS}  WARN: ${WARN}  FAIL: ${FAIL}"

if [[ "$FAIL" -gt 0 ]]; then
  echo ""
  echo "FAILED checks:"
  for e in "${ERRORS[@]}"; do
    echo "  - $e"
  done
  echo ""
  echo "Fix the above failures before running backup scripts in production."
  exit 1
fi

if [[ "$WARN" -gt 0 ]]; then
  echo ""
  echo "Preflight passed with warnings. Review WARNs above before prod deployment."
  exit 0
fi

echo ""
echo "All checks passed. Host is ready for vici2 backup operations."
