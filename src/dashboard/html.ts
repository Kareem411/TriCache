import { gzipSync } from 'node:zlib';

/**
 * Embedded Single-Page Observability Dashboard for TriCache.
 *
 * Design features:
 * - 100% self-contained & air-gapped (zero external CDN or font dependencies)
 * - Modern dark glassmorphic UI with high contrast and smooth micro-animations
 * - Server-Sent Events (SSE) live streaming with auto-reconnect and polling fallback
 * - Pod vs. Fleet cluster awareness indicators
 * - Immutable HTML pre-compressed with Gzip at module initialization
 */
export const DASHBOARD_HTML: string = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>TriCache Observability</title>
  <style>
    :root {
      --bg: #0b0f17;
      --card-bg: rgba(18, 24, 38, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --card-hover: rgba(255, 255, 255, 0.12);
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-glow: rgba(56, 189, 248, 0.25);
      --success: #10b981;
      --warning: #f59e0b;
      --danger: #ef4444;
      --l1-color: #38bdf8;
      --disk-color: #a855f7;
      --l2-color: #f97316;
      --db-color: #ef4444;
      --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font);
      line-height: 1.5;
      padding: 1.5rem;
      min-height: 100vh;
      -webkit-font-smoothing: antialiased;
    }
    header {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 1rem;
      margin-bottom: 2rem;
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--card-border);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.85rem;
    }
    .brand-logo {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: linear-gradient(135deg, #0284c7, #818cf8);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 800;
      color: #fff;
      font-size: 1.1rem;
      box-shadow: 0 0 16px var(--primary-glow);
    }
    .brand-text h1 {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    .brand-text p {
      font-size: 0.8rem;
      color: var(--text-muted);
    }
    .header-meta {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 0.75rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      padding: 0.3rem 0.65rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--card-border);
      color: var(--text-muted);
    }
    .badge-live {
      color: var(--success);
      border-color: rgba(16, 185, 129, 0.3);
      background: rgba(16, 185, 129, 0.1);
    }
    .pulse-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background-color: currentColor;
      box-shadow: 0 0 8px currentColor;
      animation: pulse 2s infinite ease-in-out;
    }
    @keyframes pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.4; transform: scale(0.85); } }
    .peer-select {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 0.3rem 0.65rem;
      border-radius: 6px;
      font-size: 0.8rem;
      outline: none;
      cursor: pointer;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 1.25rem;
      transition: border-color 0.2s, transform 0.2s;
    }
    .card:hover {
      border-color: var(--card-hover);
    }
    .card-label {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.4rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-value {
      font-size: 1.85rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      color: var(--text);
    }
    .card-sub {
      font-size: 0.8rem;
      color: var(--text-muted);
      margin-top: 0.35rem;
    }
    .tier-bar {
      height: 10px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.06);
      overflow: hidden;
      display: flex;
      margin: 0.75rem 0;
    }
    .tier-segment { height: 100%; transition: width 0.4s ease; }
    .tier-legend {
      display: flex;
      flex-wrap: wrap;
      gap: 0.85rem;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .tier-item { display: flex; align-items: center; gap: 0.35rem; }
    .tier-color-dot { width: 8px; height: 8px; border-radius: 2px; }
    .actions-panel {
      display: flex;
      flex-wrap: wrap;
      gap: 0.75rem;
      align-items: center;
      margin-top: 1rem;
    }
    .btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid var(--card-border);
      color: var(--text);
      font-family: inherit;
      font-size: 0.8rem;
      font-weight: 600;
      padding: 0.45rem 0.9rem;
      border-radius: 6px;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      transition: background 0.15s, border-color 0.15s;
    }
    .btn:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.15);
      border-color: rgba(255, 255, 255, 0.25);
    }
    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .btn-danger {
      background: rgba(239, 68, 68, 0.15);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
    .btn-danger:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.25);
    }
    .dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      display: none;
      place-items: center;
      z-index: 100;
    }
    .dialog-overlay.active { display: grid; }
    .dialog {
      background: #141c2e;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 1.5rem;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }
    .dialog h3 { font-size: 1.15rem; margin-bottom: 0.5rem; }
    .dialog p { font-size: 0.85rem; color: var(--text-muted); margin-bottom: 1rem; }
    .dialog input {
      width: 100%;
      background: rgba(0, 0, 0, 0.3);
      border: 1px solid var(--card-border);
      border-radius: 6px;
      padding: 0.5rem 0.75rem;
      color: var(--text);
      font-size: 0.9rem;
      margin-bottom: 1rem;
      outline: none;
    }
    .dialog-actions {
      display: flex;
      justify-content: flex-end;
      gap: 0.5rem;
    }
    #toast {
      position: fixed;
      bottom: 1.5rem;
      right: 1.5rem;
      background: #1e293b;
      border: 1px solid var(--card-border);
      padding: 0.75rem 1.25rem;
      border-radius: 8px;
      font-size: 0.85rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.4);
      display: none;
      z-index: 200;
      animation: slideIn 0.2s ease-out;
    }
    @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo">Δ</div>
      <div class="brand-text">
        <h1 id="ui-title">TriCache Observability</h1>
        <p id="ui-subtitle">Connecting to live metric stream...</p>
      </div>
    </div>
    <div class="header-meta">
      <div class="badge" id="pod-badge">Pod: ...</div>
      <div class="badge" id="uptime-badge">Uptime: 0s</div>
      <div class="badge" id="cb-badge">L2: ...</div>
      <div class="badge badge-live" id="stream-badge">
        <span class="pulse-dot"></span>
        <span id="stream-text">SSE Live</span>
      </div>
      <select id="peer-select" class="peer-select" style="display:none;" onchange="if(this.value) window.location.href=this.value;">
        <option value="">Switch Pod...</option>
      </select>
    </div>
  </header>

  <section class="grid">
    <!-- Stat 1: Overall Hit Ratio -->
    <div class="card">
      <div class="card-label">Hit Ratio <span>Global</span></div>
      <div class="card-value" id="val-hit-ratio">0.0%</div>
      <div class="card-sub" id="sub-hit-ratio">0 total gets</div>
      <div class="tier-bar">
        <div class="tier-segment" id="bar-l1" style="background:var(--l1-color); width:0%;"></div>
        <div class="tier-segment" id="bar-disk" style="background:var(--disk-color); width:0%;"></div>
        <div class="tier-segment" id="bar-l2" style="background:var(--l2-color); width:0%;"></div>
        <div class="tier-segment" id="bar-db" style="background:var(--db-color); width:0%;"></div>
      </div>
      <div class="tier-legend">
        <div class="tier-item"><span class="tier-color-dot" style="background:var(--l1-color);"></span> L1 RAM (<span id="pct-l1">0%</span>)</div>
        <div class="tier-item"><span class="tier-color-dot" style="background:var(--disk-color);"></span> Disk (<span id="pct-disk">0%</span>)</div>
        <div class="tier-item"><span class="tier-color-dot" style="background:var(--l2-color);"></span> L2 (<span id="pct-l2">0%</span>)</div>
        <div class="tier-item"><span class="tier-color-dot" style="background:var(--db-color);"></span> DB (<span id="pct-db">0%</span>)</div>
      </div>
    </div>

    <!-- Stat 2: Singleflight & Stampedes -->
    <div class="card">
      <div class="card-label">Stampedes Prevented <span>Singleflight</span></div>
      <div class="card-value" id="val-stampedes">0</div>
      <div class="card-sub" id="sub-stampedes">0 concurrent coalesced</div>
    </div>

    <!-- Stat 3: Memory Footprint & OOM Guard -->
    <div class="card">
      <div class="card-label">L1 Heap Memory <span>OOM Guard</span></div>
      <div class="card-value" id="val-memory">0 MB</div>
      <div class="card-sub" id="sub-memory">0 entries | 0 OOM rounds</div>
    </div>

    <!-- Stat 4: Invalidation Mesh -->
    <div class="card">
      <div class="card-label">Invalidation Mesh <span>Backplane</span></div>
      <div class="card-value" id="val-backplane">0 / 0</div>
      <div class="card-sub" id="sub-backplane">Sent / Received</div>
    </div>
  </section>

  <!-- Actions & Control Bar -->
  <div class="card">
    <div class="card-label">Operational Controls & Invalidation</div>
    <div class="actions-panel">
      <button class="btn" id="btn-invalidate" onclick="openInvalidateModal()">🏷️ Invalidate Tag</button>
      <button class="btn btn-danger" id="btn-clear" onclick="openClearModal()">🧹 Clear Cache</button>
      <button class="btn" onclick="fetchMetricsSnapshot()">🔄 Refresh Snapshot</button>
    </div>
  </div>

  <!-- Invalidate Modal -->
  <div class="dialog-overlay" id="invalidate-modal">
    <div class="dialog">
      <h3>Invalidate Tag</h3>
      <p>Increments generational tag version across local tiers and broadcast backplane.</p>
      <input type="text" id="tag-input" placeholder="e.g. products, tenant-123" />
      <div class="dialog-actions">
        <button class="btn" onclick="closeModals()">Cancel</button>
        <button class="btn btn-danger" onclick="submitTagInvalidation()">Invalidate</button>
      </div>
    </div>
  </div>

  <!-- Clear Modal -->
  <div class="dialog-overlay" id="clear-modal">
    <div class="dialog">
      <h3>Clear Cache</h3>
      <p>Evict all cached keys from the local L1 memory and NVMe disk tiers.</p>
      <div class="dialog-actions">
        <button class="btn" onclick="closeModals()">Cancel</button>
        <button class="btn btn-danger" onclick="submitClear()">Confirm Clear</button>
      </div>
    </div>
  </div>

  <div id="toast"></div>

  <script>
    (function() {
      let isReadOnly = false;
      let sseFailed = false;

      function showToast(msg, duration = 3000) {
        const t = document.getElementById('toast');
        t.innerText = msg;
        t.style.display = 'block';
        setTimeout(() => { t.style.display = 'none'; }, duration);
      }

      function formatBytes(bytes) {
        if (!bytes || bytes < 1024) return (bytes || 0) + ' B';
        if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / 1048576).toFixed(1) + ' MB';
      }

      function updateUI(data) {
        if (!data || !data.metrics) return;
        const m = data.metrics;
        isReadOnly = !!data.readOnly;

        if (data.title) document.getElementById('ui-title').innerText = data.title;
        if (data.instanceId) {
          document.getElementById('pod-badge').innerText = 'Pod: ' + data.instanceId;
          document.getElementById('ui-subtitle').innerText = 'Cluster Instance: ' + data.instanceId + ' | Node ' + (data.nodeVersion || '');
        }
        if (m.uptimeMs) {
          const s = Math.floor(m.uptimeMs / 1000);
          document.getElementById('uptime-badge').innerText = 'Uptime: ' + (s > 3600 ? (s/3600).toFixed(1) + 'h' : s + 's');
        }
        if (m.l2CircuitBreaker) {
          const cb = m.l2CircuitBreaker.state || 'closed';
          const el = document.getElementById('cb-badge');
          el.innerText = 'L2: ' + cb.toUpperCase();
          el.style.color = cb === 'closed' ? 'var(--success)' : 'var(--danger)';
        }

        // Peer dropdown
        if (data.peerInstances && data.peerInstances.length) {
          const ps = document.getElementById('peer-select');
          ps.style.display = 'inline-block';
          if (ps.options.length <= 1) {
            data.peerInstances.forEach(p => {
              const opt = document.createElement('option');
              opt.value = p.url;
              opt.innerText = p.name;
              ps.appendChild(opt);
            });
          }
        }

        // Read-only toggle
        if (isReadOnly) {
          document.getElementById('btn-invalidate').disabled = true;
          document.getElementById('btn-clear').disabled = true;
          document.getElementById('btn-invalidate').title = 'Read-Only Mode Enabled';
          document.getElementById('btn-clear').title = 'Read-Only Mode Enabled';
        }

        // Hit Ratio
        const gets = m.gets ? m.gets.total : 0;
        const l1 = m.gets ? m.gets.l1Hits : 0;
        const disk = m.gets ? m.gets.diskHits : 0;
        const l2 = m.gets ? m.gets.l2Hits : 0;
        const db = m.gets ? m.gets.fetches : 0;
        const hits = l1 + disk + l2;
        const hitRatio = gets > 0 ? (hits / gets * 100).toFixed(1) : '0.0';

        document.getElementById('val-hit-ratio').innerText = hitRatio + '%';
        document.getElementById('sub-hit-ratio').innerText = hits.toLocaleString() + ' hits / ' + gets.toLocaleString() + ' gets';

        const pL1 = gets > 0 ? Math.round(l1 / gets * 100) : 0;
        const pDisk = gets > 0 ? Math.round(disk / gets * 100) : 0;
        const pL2 = gets > 0 ? Math.round(l2 / gets * 100) : 0;
        const pDb = gets > 0 ? Math.round(db / gets * 100) : 0;

        document.getElementById('bar-l1').style.width = pL1 + '%';
        document.getElementById('bar-disk').style.width = pDisk + '%';
        document.getElementById('bar-l2').style.width = pL2 + '%';
        document.getElementById('bar-db').style.width = pDb + '%';

        document.getElementById('pct-l1').innerText = pL1 + '%';
        document.getElementById('pct-disk').innerText = pDisk + '%';
        document.getElementById('pct-l2').innerText = pL2 + '%';
        document.getElementById('pct-db').innerText = pDb + '%';

        // Stampedes
        const st = m.gets ? m.gets.stampedePrevented : 0;
        document.getElementById('val-stampedes').innerText = st.toLocaleString();
        document.getElementById('sub-stampedes').innerText = (m.revalidations ? m.revalidations.total : 0) + ' SWR refreshes';

        // Memory
        const mem = m.l1 ? m.l1.sizeBytes : 0;
        const entries = m.l1 ? m.l1.entries : 0;
        const oom = m.oom ? m.oom.evictions : 0;
        document.getElementById('val-memory').innerText = formatBytes(mem);
        document.getElementById('sub-memory').innerText = entries.toLocaleString() + ' entries | ' + oom + ' OOM purges';

        // Backplane & Mesh
        const bpSent = m.backplane ? m.backplane.sent : 0;
        const bpRecv = m.backplane ? m.backplane.received : 0;
        document.getElementById('val-backplane').innerText = bpSent + ' / ' + bpRecv;
        if (m.crossRegion && m.crossRegion.enabled) {
          document.getElementById('sub-backplane').innerText = 'Cross-Region: ' + m.crossRegion.sent + ' sent, ' + m.crossRegion.received + ' recv';
        }
      }

      window.fetchMetricsSnapshot = function() {
        fetch('api/metrics')
          .then(r => r.json())
          .then(data => updateUI(data))
          .catch(err => showToast('Failed to fetch snapshot: ' + err.message));
      };

      function connectSSE() {
        if (typeof EventSource === 'undefined') {
          fallbackPolling();
          return;
        }
        const sse = new EventSource('api/stream');
        sse.onmessage = function(e) {
          try {
            const data = JSON.parse(e.data);
            updateUI(data);
          } catch(err) { /* ignore */ }
        };
        sse.onerror = function() {
          sse.close();
          if (!sseFailed) {
            sseFailed = true;
            document.getElementById('stream-badge').className = 'badge';
            document.getElementById('stream-text').innerText = 'Polling Active';
            fallbackPolling();
          }
        };
      }

      function fallbackPolling() {
        fetchMetricsSnapshot();
        setInterval(fetchMetricsSnapshot, 3000);
      }

      window.openInvalidateModal = function() {
        if (isReadOnly) return;
        document.getElementById('invalidate-modal').classList.add('active');
        document.getElementById('tag-input').focus();
      };
      window.openClearModal = function() {
        if (isReadOnly) return;
        document.getElementById('clear-modal').classList.add('active');
      };
      window.closeModals = function() {
        document.getElementById('invalidate-modal').classList.remove('active');
        document.getElementById('clear-modal').classList.remove('active');
      };

      window.submitTagInvalidation = function() {
        const tag = document.getElementById('tag-input').value.trim();
        if (!tag) return;
        fetch('api/actions/invalidate-tag', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-TriCache-Action': '1'
          },
          body: JSON.stringify({ tag })
        })
        .then(r => r.json())
        .then(res => {
          closeModals();
          document.getElementById('tag-input').value = '';
          if (res.ok) {
            showToast('Tag "' + tag + '" invalidated across fleet');
            fetchMetricsSnapshot();
          } else {
            showToast('Error: ' + (res.error || 'Failed'));
          }
        })
        .catch(e => showToast('Request failed: ' + e.message));
      };

      window.submitClear = function() {
        fetch('api/actions/clear', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-TriCache-Action': '1'
          }
        })
        .then(r => r.json())
        .then(res => {
          closeModals();
          if (res.ok) {
            showToast('Local cache tiers cleared');
            fetchMetricsSnapshot();
          } else {
            showToast('Error: ' + (res.error || 'Failed'));
          }
        })
        .catch(e => showToast('Clear failed: ' + e.message));
      };

      // Bootstrap on load
      fetchMetricsSnapshot();
      connectSSE();
    })();
  </script>
</body>
</html>`;

/**
 * Pre-compressed Gzip binary representation of the immutable dashboard HTML.
 * Served directly with Content-Encoding: gzip to minimize latency and CPU overhead.
 */
export const DASHBOARD_GZIP_BUFFER: Buffer = gzipSync(Buffer.from(DASHBOARD_HTML, 'utf-8'));
