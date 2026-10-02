import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'TriCache',
  description: 'Enterprise Three-Tier Caching Engine for Node.js (RAM → /dev/shm → Redis)',
  base: '/TriCache/',
  cleanUrls: true,
  lastUpdated: true,

  markdown: {
    math: true,
    theme: {
      light: 'github-light',
      dark: 'tokyo-night',
    },
    config: (md) => {
      const prevFence = md.renderer.rules.fence;
      if (prevFence) {
        md.renderer.rules.fence = (tokens, idx, options, env, self) => {
          const token = tokens[idx];
          const match = token.info.match(/\[(.*?)\]/);
          const rendered = prevFence(tokens, idx, options, env, self);

          let insideCodeGroup = false;
          for (let i = 0; i < idx; i++) {
            if (tokens[i].type === 'container_code-group_open') insideCodeGroup = true;
            if (tokens[i].type === 'container_code-group_close') insideCodeGroup = false;
          }

          if (match && !insideCodeGroup) {
            const title = match[1];
            return rendered.replace(
              /<div class="language-([^"]*)"([^>]*)>/,
              `<div class="language-$1 has-title"$2><span class="title">${title}</span>`
            );
          }
          return rendered;
        };
      }
    },
  },

  head: [
    ['link', { rel: 'icon', type: 'image/jpeg', href: '/TriCache/tricache-favicon.jpeg' }],
    ['link', { rel: 'shortcut icon', type: 'image/jpeg', href: '/TriCache/tricache-favicon.jpeg' }],
    ['link', { rel: 'apple-touch-icon', href: '/TriCache/tricache-favicon.jpeg' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700;800&family=Geist+Mono:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Space+Grotesk:wght@500;600;700&display=swap',
      },
    ],
    ['meta', { name: 'theme-color', content: '#0b2241' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:locale', content: 'en' }],
    ['meta', { property: 'og:title', content: 'TriCache | Enterprise 3-Tier Caching Engine' }],
    ['meta', { property: 'og:site_name', content: 'TriCache' }],
    ['meta', { property: 'og:description', content: 'Enterprise Three-Tier Caching Engine for Node.js: L1 In-Memory RAM → L1.5 Off-Heap /dev/shm & NVMe Spill → L2 Redis/Valkey.' }],
    ['meta', { property: 'og:image', content: '/TriCache/tricache.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: '/TriCache/tricache.png' }],
  ],

  themeConfig: {
    logo: {
      light: '/tricache.png',
      dark: '/tricache-cyan.png',
      alt: 'TriCache',
    },
    siteTitle: false,

    nav: [
      { text: 'Guide', link: '/getting-started' },
      { text: 'Architecture', link: '/architecture-internals' },
      { text: 'Kubernetes SRE', link: '/kubernetes/' },
      { text: 'Clustering & HA', link: '/clustering-high-availability' },
      { text: 'Integrations', link: '/integrations/' },
      { text: 'Observability', link: '/observability' },
      { text: 'API', link: '/api-reference' },
      { text: 'Benchmarks', link: '/benchmarks' },
      {
        text: 'v0.8.0',
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing Guide', link: '/contributing' },
          { text: 'Security Policy', link: '/security' },
          { text: 'GitHub Repository', link: 'https://github.com/Kareem411/TriCache' },
        ],
      },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        collapsed: false,
        items: [
          { text: 'Introduction & Quickstart', link: '/getting-started' },
          { text: 'Production Presets', link: '/getting-started#production-presets' },
          { text: 'Core Operations', link: '/getting-started#core-caching-operations' },
        ],
      },
      {
        text: 'Architecture & Internals',
        collapsed: false,
        items: [
          { text: 'Architectural Deep Dive', link: '/architecture-internals' },
          { text: 'Window TinyLFU & CMS', link: '/architecture-internals#1-native-window-tinylfu-w-tinylfu-admission-engine' },
          { text: 'WASM & Murmur3 Filter', link: '/architecture-internals#2-webassembly-murmur3-bloom-filter' },
          { text: 'Zero-Dependency SigV4', link: '/architecture-internals#6-zero-dependency-aws-sigv4-snapshot-signer' },
          { text: 'Cold-Start Cloud Hydration', link: '/cold-start-cloud-hydration' },
        ],
      },
      {
        text: 'Kubernetes & Production SRE',
        collapsed: false,
        items: [
          { text: 'SRE Architecture Overview', link: '/kubernetes/' },
          { text: 'Complete Production Guide', link: '/kubernetes-production-guide' },
          { text: '/dev/shm Off-Heap tmpfs', link: '/kubernetes/dev-shm' },
          { text: 'Cgroup Memory Budgeting', link: '/kubernetes/cgroups' },
          { text: 'Liveness vs Readiness Probes', link: '/kubernetes/probes' },
          { text: 'Dynamic Latency Watchdog', link: '/kubernetes/watchdog' },
          { text: 'Ephemeral Eviction Defense', link: '/kubernetes/eviction-defense' },
          { text: 'Clustering & High Availability', link: '/clustering-high-availability' },
        ],
      },
      {
        text: 'Integrations & Ecosystem',
        collapsed: false,
        items: [
          { text: 'Ecosystem Directory', link: '/integrations/' },
          { text: 'Next.js 16 & 15 App Router', link: '/integrations/nextjs' },
          { text: 'NestJS Dynamic Module', link: '/integrations/nestjs' },
          { text: 'Prisma ORM Extension', link: '/integrations/prisma' },
          { text: 'Drizzle ORM Wrapper', link: '/integrations/drizzle' },
          { text: 'Express & Fastify Middleware', link: '/integrations/http' },
          { text: 'Hono Node Middleware', link: '/integrations/hono' },
          { text: 'Edge Isolates (Workers)', link: '/integrations/edge' },
          { text: 'Visual Dashboard & CLI', link: '/integrations/dashboard' },
        ],
      },
      {
        text: 'Observability & Telemetry',
        collapsed: false,
        items: [
          { text: 'Fleet Observability Overview', link: '/observability' },
          { text: 'Real-time Web Dashboard', link: '/observability#real-time-sse-web-dashboard' },
          { text: 'Prometheus & Grafana Alerting', link: '/observability#prometheus--grafana-golden-signals-dashboard' },
          { text: 'Prometheus /metrics Recipe', link: '/metrics-recipe' },
          { text: 'OpenTelemetry Tracing & Metrics', link: '/observability#opentelemetry-distributed-tracing--metrics' },
          { text: 'Terminal Interactive CLI', link: '/observability#terminal-cli-tricache-top' },
        ],
      },
      {
        text: 'Reference & Benchmarks',
        collapsed: false,
        items: [
          { text: 'API Reference', link: '/api-reference' },
          { text: 'Benchmarks & Cloud ROI', link: '/benchmarks' },
        ],
      },
      {
        text: 'Project & Community',
        collapsed: true,
        items: [
          { text: 'Changelog', link: '/changelog' },
          { text: 'Contributing Guide', link: '/contributing' },
          { text: 'Security Policy', link: '/security' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/Kareem411/TriCache' },
    ],

    outline: {
      level: [2, 3],
      label: 'On this page',
    },

    search: {
      provider: 'local',
    },
  },
});
