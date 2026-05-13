# rtpengine Kernel Module — Production Setup

**X01 — xt_RTPENGINE host-level configuration**

The kernel module (`xt_RTPENGINE`) enables near-zero-CPU RTP forwarding by
performing packet forwarding in the Linux kernel rather than in userspace.
This is required for the 1,500+ concurrent call target in production.

Dev and staging environments run in userspace mode (default). The kernel module
is only required for production loads above ~500 concurrent sessions.

---

## When to Use Kernel Mode

| Mode | Concurrent calls | CPU (FS+rtpengine) | Notes |
|---|---|---|---|
| Userspace (`RTPENGINE_KERNEL_MODE=0`) | Up to ~500 | ~30% on 4-core | Default; works on all hosts including Mac |
| Kernel (`RTPENGINE_KERNEL_MODE=1`) | 1,500+ | < 10% | Requires `xt_RTPENGINE` on the host |

---

## Prerequisites

- Linux host running the **same kernel** as the running system (check `uname -r`)
- Root access on the Docker host
- Internet access to the Sipwise APT repository OR rtpengine source tree

---

## Setup Steps

### 1. Install kernel headers

```bash
apt-get install -y linux-headers-$(uname -r)
```

### 2. Install DKMS build tools

```bash
apt-get install -y dpkg-dev dkms build-essential
```

### 3. Add the Sipwise APT repository (if not already present)

```bash
curl -fsSL https://deb.sipwise.com/spce/release.gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/sipwise-archive-keyring.gpg
echo "deb [signed-by=/usr/share/keyrings/sipwise-archive-keyring.gpg] \
https://deb.sipwise.com/spce/ bookworm main" \
    > /etc/apt/sources.list.d/sipwise.list
apt-get update
```

### 4. Install the kernel DKMS package

```bash
apt-get install -y ngcp-rtpengine-kernel-dkms
```

DKMS will automatically build the module against the running kernel.

### 5. Load the module

```bash
modprobe xt_RTPENGINE
```

Verify it loaded:

```bash
lsmod | grep xt_RTPENGINE
# Expected output: xt_RTPENGINE    <size>  0
```

### 6. Make the module load persistent across reboots

```bash
echo "xt_RTPENGINE" > /etc/modules-load.d/rtpengine.conf
```

### 7. Enable kernel mode in vici2

Set `RTPENGINE_KERNEL_MODE=1` in your `.env` file or docker-compose override:

```bash
echo "RTPENGINE_KERNEL_MODE=1" >> .env
docker compose restart rtpengine
```

### 8. Verify kernel forwarding is active

After rtpengine starts with kernel mode, make a test call and check:

```bash
cat /proc/rtpengine/0/list
# Should show kernel table entries for active calls.
```

---

## Troubleshooting

### Module not found after `modprobe`

If `modprobe xt_RTPENGINE` fails with "Module not found":

1. Verify DKMS build succeeded: `dkms status`
2. Rebuild manually: `dkms autoinstall`
3. If on a custom kernel, build from source:
   ```bash
   git clone https://github.com/sipwise/rtpengine.git
   cd rtpengine/kernel-module
   make && make install
   ```

### Kernel mode not active after setting `RTPENGINE_KERNEL_MODE=1`

Check rtpengine logs:
```bash
docker compose logs rtpengine | grep -i kernel
```

If you see "WARNING: /proc/rtpengine/control not found", the module is not
loaded on the host. Verify with `lsmod | grep xt_RTPENGINE`.

### Kernel update breaks the module

After a kernel update (`apt-get upgrade`), DKMS should rebuild automatically.
Verify with `dkms status` after the upgrade. If not rebuilt:

```bash
dkms autoinstall -m ngcp-rtpengine-kernel
```

---

## Security Notes

- The `xt_RTPENGINE` module is a Netfilter/iptables extension. It operates in
  kernel space and has access to all network packets.
- Only install this module on dedicated telephony hosts with appropriate network
  isolation.
- The rtpengine container requires `CAP_NET_ADMIN` and `CAP_SYS_MODULE` to
  communicate with the kernel module (set in docker-compose.dev.yml).
