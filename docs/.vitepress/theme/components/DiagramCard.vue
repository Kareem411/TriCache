<script setup lang="ts">
import { ref } from 'vue';
import { withBase } from 'vitepress';

const copied = ref(false);

const asciiSpec = `                           [Incoming Read Request]
                                      │
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │       L1: Smart Memory (W-TinyLFU + CMS)         │  Bounded packed data
             │   Window LRU (1%) + Segmented Main SLRU (99%)    │  Workload-dependent latency
             └────────────────────────┬─────────────────────────┘
                                      │ Miss / Eviction Spill
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │    L1.5: Off-Heap /dev/shm & NVMe Spill Tier     │  Bounded write concurrency
             │   tmpfs counts against container memory usage  │  Writable mount required
             └────────────────────────┬─────────────────────────┘
                                      │ Miss
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │       L2: Redis / Valkey Distributed Tier        │  ~1.2 ms (Network)
             │   AES-256-GCM AEAD at-rest + msgpackr records    │  Pipelined MGET/MSET
             └────────────────────────┬─────────────────────────┘
                                      │ Complete Cache Miss
                                      ▼
             ┌──────────────────────────────────────────────────┐
             │   Upstream Database / API (Singleflight)         │  Per process/key
             │   Inflight Promise Map coalesces concurrent work│  Not a fleet-wide lock
             └──────────────────────────────────────────────────┘`;

async function copyRaw() {
  try {
    await navigator.clipboard.writeText(asciiSpec);
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch (e) {
    console.error('Failed to copy raw ASCII spec:', e);
  }
}
</script>

<template>
  <div class="diagram-card">
    <!-- Top: High-Res Visual Illustration -->
    <div class="diagram-image-wrapper">
      <img
        :src="withBase('/docs/Multi-tier_cache_architecture_di…_20260910200750.jpeg')"
        alt="TriCache Multi-Tier Architectural Topology"
        class="diagram-image"
      />
    </div>

    <!-- Bottom Attached Accordion Tab -->
    <details class="diagram-spec-tab">
      <summary class="tab-summary">
        <div class="tab-label">
          <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
          <span class="tab-title">View as ASCII Architecture Spec</span>
        </div>

        <div class="tab-actions" @click.stop>
          <button
            class="copy-raw-btn"
            :class="{ 'is-copied': copied }"
            @click="copyRaw"
            type="button"
            :title="copied ? 'Copied RAW ASCII to clipboard!' : 'Copy RAW ASCII Specification'"
            aria-label="Copy RAW ASCII Specification"
          >
            <svg v-if="!copied" class="copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
            <svg v-else class="copy-icon text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span>{{ copied ? 'Copied RAW' : 'Copy RAW' }}</span>
          </button>
        </div>
      </summary>

      <div class="tab-content">
        <pre class="ascii-code"><code>{{ asciiSpec }}</code></pre>
      </div>
    </details>
  </div>
</template>

<style scoped>
.diagram-card {
  margin: 2rem 0 3rem 0;
  border-radius: 16px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
  background-color: var(--vp-c-bg-elv);
  box-shadow: 0 8px 32px -4px rgba(0, 0, 0, 0.12);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.dark .diagram-card {
  border-color: rgba(63, 63, 70, 0.6);
  background-color: #0d1117;
  box-shadow: 0 12px 40px -4px rgba(0, 0, 0, 0.55);
}

.diagram-image-wrapper {
  width: 100%;
  overflow: hidden;
  background-color: #0d1117;
}

.diagram-image {
  display: block;
  width: 100%;
  height: auto;
  object-fit: cover;
}

/* Attached Bottom Tab Accordion */
.diagram-spec-tab {
  border-top: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  transition: background-color 0.2s ease;
}

.dark .diagram-spec-tab {
  border-top-color: rgba(63, 63, 70, 0.6);
  background: rgba(24, 24, 27, 0.7);
}

.tab-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.25rem;
  cursor: pointer;
  user-select: none;
  font-family: var(--vp-font-family-base);
  font-size: 0.825rem;
  font-weight: 500;
  color: var(--vp-c-text-2);
  list-style: none;
  transition: color 0.2s ease, background-color 0.2s ease;
}

.tab-summary::-webkit-details-marker {
  display: none;
}

.tab-summary:hover {
  color: var(--vp-c-text-1);
}

.dark .tab-summary:hover {
  background: rgba(39, 39, 42, 0.4);
}

:root:not(.dark) .tab-summary:hover {
  background: rgba(238, 242, 246, 0.7);
}

.tab-label {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
}

.tab-icon {
  width: 15px;
  height: 15px;
  opacity: 0.75;
}

.tab-title {
  letter-spacing: -0.01em;
}

.tab-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.copy-raw-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.25rem 0.6rem;
  font-size: 0.75rem;
  font-family: var(--vp-font-family-mono);
  font-weight: 500;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
  user-select: none;
}

.dark .copy-raw-btn {
  background: rgba(39, 39, 42, 0.7);
  border: 1px solid rgba(63, 63, 70, 0.7);
  color: #a1a1aa;
}

.dark .copy-raw-btn:hover {
  background: #27272a;
  border-color: #71717a;
  color: #ffffff;
}

.dark .copy-raw-btn.is-copied {
  border-color: rgba(52, 211, 153, 0.5);
  color: #34d399;
}

:root:not(.dark) .copy-raw-btn {
  background: #ffffff;
  border: 1px solid #d0d7de;
  color: #475569;
}

:root:not(.dark) .copy-raw-btn:hover {
  background: #f6f8fa;
  border-color: #94a3b8;
  color: #0f172a;
}

:root:not(.dark) .copy-raw-btn.is-copied {
  border-color: #10b981;
  color: #059669;
}

.copy-icon {
  width: 12px;
  height: 12px;
}

.tab-content {
  padding: 1rem 1.25rem;
  border-top: 1px solid var(--vp-c-divider);
  background: #09090b;
  overflow-x: auto;
}

.dark .tab-content {
  border-top-color: rgba(63, 63, 70, 0.4);
  background: #09090b;
}

:root:not(.dark) .tab-content {
  border-top-color: #d0d7de;
  background: #0d1117;
}

.ascii-code {
  margin: 0 !important;
  padding: 0 !important;
  font-family: var(--vp-font-family-mono) !important;
  font-size: 12px !important;
  line-height: 1.5 !important;
  color: #d4d4d8 !important;
  background: transparent !important;
}
</style>
