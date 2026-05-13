#!/usr/bin/env python3
"""
infra/kamailio/scripts/check_fs_load.py
X02 — Poll ESL from each FreeSWITCH instance; update dispatcher flags
if a FS is overloaded (session count > DRAIN_RATIO * max_sessions).

Run as a cron job or daemonized (every 30 seconds):
  # Run once:
  python3 check_fs_load.py

  # Loop (daemonize via supervisord or Docker entrypoint):
  while true; do python3 check_fs_load.py; sleep 30; done

Environment variables:
  FS_INSTANCES        Comma-separated FS IPs (default: 10.0.1.10,10.0.1.11)
  ESL_PORT            FreeSWITCH ESL port (default: 8021)
  ESL_PASSWORD        FreeSWITCH ESL password (default: ClueCon)
  FS_DRAIN_RATIO      Fraction of max sessions that triggers drain (default: 0.85)
  KAMAILIO_DB_HOST    Kamailio DB host (default: 127.0.0.1)
  KAMAILIO_DB_PORT    Kamailio DB port (default: 3306)
  KAMAILIO_DB_USER    Kamailio DB user (default: kamailio)
  KAMAILIO_DB_PASS    Kamailio DB password
  KAMAILIO_DB_NAME    Kamailio DB name (default: kamailio)
"""

import os
import re
import socket
import subprocess
import sys
import pymysql
import pymysql.cursors

FS_INSTANCES = os.environ.get('FS_INSTANCES', '10.0.1.10,10.0.1.11').split(',')
ESL_PORT     = int(os.environ.get('ESL_PORT', '8021'))
ESL_PASS     = os.environ.get('ESL_PASSWORD', 'ClueCon')
DRAIN_RATIO  = float(os.environ.get('FS_DRAIN_RATIO', '0.85'))

KAMAILIO_DB = {
    'host':        os.environ.get('KAMAILIO_DB_HOST', '127.0.0.1'),
    'port':        int(os.environ.get('KAMAILIO_DB_PORT', '3306')),
    'user':        os.environ.get('KAMAILIO_DB_USER', 'kamailio'),
    'password':    os.environ.get('KAMAILIO_DB_PASS', ''),
    'database':    os.environ.get('KAMAILIO_DB_NAME', 'kamailio'),
    'cursorclass': pymysql.cursors.DictCursor,
    'connect_timeout': 5,
}


def esl_command(host: str, cmd: str) -> str:
    """
    Send a single ESL command to FreeSWITCH and return the response body.
    Implements the minimal ESL authentication handshake.
    Raises: socket.timeout, ConnectionRefusedError, OSError on failure.
    """
    with socket.create_connection((host, ESL_PORT), timeout=5) as s:
        # ESL auth challenge arrives first
        s.recv(1024)
        # Authenticate
        s.sendall(f'auth {ESL_PASS}\n\n'.encode())
        auth_resp = s.recv(1024).decode(errors='replace')
        if '+OK accepted' not in auth_resp:
            raise RuntimeError(f"ESL auth failed on {host}: {auth_resp!r}")
        # Send the API command
        s.sendall(f'api {cmd}\n\n'.encode())
        # Read until we get the double-newline delimiter
        resp = b''
        while b'\n\n' not in resp:
            chunk = s.recv(4096)
            if not chunk:
                break
            resp += chunk
    return resp.decode(errors='replace')


def get_fs_session_info(fs_ip: str) -> tuple[int, int] | None:
    """
    Return (current_sessions, max_sessions) for a FreeSWITCH instance,
    or None if the FS is unreachable or the response is unparseable.
    """
    try:
        resp = esl_command(fs_ip, 'status')
        # FS status output: "X session(s) - max Y sessions ..."
        m = re.search(r'(\d+)\s+session.*?max\s+(\d+)', resp, re.IGNORECASE)
        if m:
            return int(m.group(1)), int(m.group(2))
        print(f"WARN: could not parse session count from {fs_ip}: {resp[:200]!r}",
              file=sys.stderr)
        return None
    except (socket.timeout, ConnectionRefusedError, OSError, RuntimeError) as e:
        print(f"WARN: ESL connection to {fs_ip}:{ESL_PORT} failed: {e}", file=sys.stderr)
        return None


def kamcmd_reload() -> None:
    """Trigger Kamailio dispatcher reload (best-effort)."""
    try:
        subprocess.run(['kamcmd', 'dispatcher.reload'],
                       capture_output=True, timeout=10)
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass


def check_and_flag() -> None:
    """
    Poll all FS instances. For each overloaded FS, set DS_INACTIVE_DST (flags=1)
    in the Kamailio dispatcher table to prevent new calls from being sent there.
    Restores flags=0 when FS is no longer overloaded.
    """
    conn = pymysql.connect(**KAMAILIO_DB)
    reload_needed = False

    try:
        for fs_ip in FS_INSTANCES:
            fs_ip = fs_ip.strip()
            if not fs_ip:
                continue

            info = get_fs_session_info(fs_ip)
            if info is None:
                # ESL unreachable: do not touch dispatcher flags here —
                # Kamailio's SIP OPTIONS probe will detect and mark inactive.
                print(f"INFO: {fs_ip} ESL unreachable — dispatcher probe will handle it")
                continue

            current, max_s = info
            overloaded = max_s > 0 and current > DRAIN_RATIO * max_s
            new_flags  = 1 if overloaded else 0

            with conn.cursor() as cur:
                # Only update if the flag has changed (avoid spurious reloads)
                cur.execute(
                    "SELECT id, flags FROM dispatcher WHERE destination LIKE %s",
                    (f'sip:{fs_ip}:%',)
                )
                rows = cur.fetchall()
                changed = False
                for row in rows:
                    if row['flags'] != new_flags:
                        cur.execute(
                            "UPDATE dispatcher SET flags=%s WHERE id=%s",
                            (new_flags, row['id'])
                        )
                        changed = True

            conn.commit()

            status_str = f"{current}/{max_s} sessions ({100*current//max_s if max_s else 0}%)"
            if overloaded and changed:
                print(f"DRAIN: {fs_ip} flagged as overloaded ({status_str})")
                reload_needed = True
            elif not overloaded and changed:
                print(f"RESTORE: {fs_ip} no longer overloaded ({status_str})")
                reload_needed = True
            else:
                print(f"OK: {fs_ip} {status_str}")
    finally:
        conn.close()

    if reload_needed:
        kamcmd_reload()


if __name__ == '__main__':
    try:
        check_and_flag()
    except pymysql.Error as e:
        print(f"ERROR: Kamailio DB unavailable: {e}", file=sys.stderr)
        sys.exit(1)
