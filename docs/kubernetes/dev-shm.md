# `/dev/shm` (POSIX Shared Memory / tmpfs)

In cloud Kubernetes clusters (AWS EKS, GCP GKE, Azure AKS), containers do not run on dedicated bare-metal NVMe drives by default. They are constrained by:
1. **Network-Attached Persistent Volumes (AWS EBS / GCP PD)**: Remote disk latency fluctuates between 1ms and 350ms during multi-tenant throttling, burning burst IOPS credits.
2. **Docker / Containerd Overlay Filesystem**: Copy-on-write overlay filesystems trigger inode contention and high write amplification.
3. **Strict Ephemeral-Storage Quotas**: If a container cache fills `/tmp`, the Kubernetes `kubelet` terminates the pod immediately (`Pod was evicted`).
4. **Zero-Trust Security Policies**: Hardened enterprise clusters enforce `readOnlyRootFilesystem: true`, blocking writes to standard filesystem directories.

---

## The Solution: Target `/dev/shm`

TriCache automatically detects Linux container runtimes and targets `/dev/shm` when writable and provided with adequate capacity ($\ge 256\text{ MB}$ total and $\ge 128\text{ MB}$ available space).

![Node.js POSIX Shared Memory Architecture](/docs/Node.js_shared_memory_architecture_20260910220529.jpeg)

::: details Memory Bus & Spill Topology
```
                      ┌─────────────────────────────────────────┐
                      │            Node.js Process              │
                      │  [L1 packed-data budget: 512MB]          │
                      └────────────────────┬────────────────────┘
                                           │ Spill on Eviction
                                           ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│   Linux /dev/shm (POSIX Shared Memory / tmpfs)                                         │
│   • Path: /dev/shm/tricache-disk                                                       │
│   • Speed: 0.02ms latency (Pure RAM bus, bypasses storage controllers entirely)        │
│   • GC Impact: encoding, buffers, and decoded values still use Node memory             │
│   • Security: writable mount required with readOnlyRootFilesystem: true                │
│   • Cloud IOPS: 0 IOPS burned (Zero AWS EBS volume cost)                              │
└────────────────────────────────────────────────────────────────────────────────────────┘
```
:::

---

## Why SREs Approve This Pattern

* **Memory Accounting**: Persisted tmpfs files are outside V8's managed heap but still count against cgroup memory. Encoding, I/O buffers, and decoded objects still allocate; there is no zero-GC or OOM guarantee.
* **Local Storage Latency**: Benchmark actual read/write latency on the target runtime and filesystem rather than assuming a fixed 20µs bound.
* **Zero Cloud IOPS**: Does not touch cloud storage volumes, eliminating EBS burst credit exhaustion.
* **Read-Only Root Compatibility**: Requires a separate writable mount. This setting alone does not establish CIS/SOC2 compliance.
