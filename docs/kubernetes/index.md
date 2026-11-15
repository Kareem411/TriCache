# Kubernetes Production & SRE Architecture

> **SRE Reference**: Bounded local storage, read-only root compatibility, and cgroup-aware memory budgeting. Deployment controls still require independent validation.

TriCache provides admission bounds, pressure guards, and storage quotas to reduce common cache failure risks. These do not eliminate GC pauses, OOMKills, storage pressure, or network partitions.

---

## SRE Deep Dives

Explore the dedicated Kubernetes guides:

| Topic | Focus Area | Key Architectural Advantage |
|:---|:---|:---|
| **[/dev/shm Off-Heap tmpfs](/kubernetes/dev-shm)** | Container Memory | Writable local storage that counts against cgroup memory; measure latency and pressure. |
| **[Cgroup Memory Budgeting](/kubernetes/cgroups)** | Container Sizing | Cgroup v1/v2 enforcement, 40/40/20 heap-to-spill ratios, GC-aware OOM emergency purges. |
| **[Liveness vs. Readiness Probes](/kubernetes/probes)** | Traffic Routing | Hard separation between `/healthz` (process survival) and `/ready` (traffic admission & degradation). |
| **[Dynamic Latency Watchdog](/kubernetes/watchdog)** | Blast-Radius Shielding | Asymmetric Redis hysteresis and 4-stage graduated disk shedding under noisy-neighbor load. |
| **[Ephemeral Eviction Defense](/kubernetes/eviction-defense)** | Quota Safety | Proactive `statfs` host capacity checks, anti-eviction write shedding, and graceful SIGTERM snapshot flusher. |

---

## The Golden Path Manifest

A sample Kubernetes `Deployment` manifest to adapt and validate for your own resource and security requirements:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api-service
  namespace: production
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api-service
  template:
    metadata:
      labels:
        app: api-service
    spec:
      containers:
        - name: web
          image: my-registry.example.com/api-service:v1.2.0
          securityContext:
            readOnlyRootFilesystem: true
            runAsNonRoot: true
            runAsUser: 10001
            allowPrivilegeEscalation: false
            capabilities:
              drop:
                - ALL
          resources:
            requests:
              cpu: "500m"
              memory: "1536Mi"
            limits:
              cpu: "2000m"
              memory: "2048Mi"
          volumeMounts:
            - name: dshm
              mountPath: /dev/shm
          livenessProbe:
            httpGet:
              path: /healthz
              port: 3000
            initialDelaySeconds: 5
            periodSeconds: 10
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            periodSeconds: 5
      volumes:
        - name: dshm
          emptyDir:
            medium: Memory
            sizeLimit: 512Mi
```
