<script setup lang="ts">
import { withBase } from 'vitepress';

interface Props {
  hideHeader?: boolean;
}

withDefaults(defineProps<Props>(), {
  hideHeader: false,
});
</script>

<template>
  <section class="ecosystem-section" :class="{ 'no-header': hideHeader }">
    <div v-if="!hideHeader" class="ecosystem-header">
      <h2 class="ecosystem-title">Community & Ecosystem</h2>
      <p class="ecosystem-subtitle">
        First-class drivers and turnkey adapters built for zero serialization overhead across modern runtimes.
      </p>
    </div>

    <div class="ecosystem-grid">
      <!-- Next.js 15/16 -->
      <a :href="withBase('/integrations/nextjs')" class="ecosystem-card">
        <div class="card-icon-box">
          <img
            :src="withBase('/docs/nextjs-icon-svgrepo-com.svg')"
            alt="Next.js"
            class="card-svg-icon theme-invert-icon"
            loading="lazy"
          />
        </div>
        <div class="card-meta">
          <span class="card-name">Next.js 15/16</span>
          <span class="card-desc">App Router Handler</span>
        </div>
      </a>

      <!-- Prisma ORM -->
      <a :href="withBase('/integrations/prisma')" class="ecosystem-card">
        <div class="card-icon-box">
          <img
            :src="withBase('/docs/prisma-svgrepo-com.svg')"
            alt="Prisma ORM"
            class="card-svg-icon theme-invert-icon"
            loading="lazy"
          />
        </div>
        <div class="card-meta">
          <span class="card-name">Prisma ORM</span>
          <span class="card-desc">Client Extensions</span>
        </div>
      </a>

      <!-- Drizzle ORM -->
      <a :href="withBase('/integrations/drizzle')" class="ecosystem-card">
        <div class="card-icon-box">
          <img
            :src="withBase('/docs/drizzle-orm-dark.svg')"
            alt="Drizzle ORM"
            class="card-svg-icon dark-only"
            loading="lazy"
          />
          <img
            :src="withBase('/docs/drizzle-orm-light.svg')"
            alt="Drizzle ORM"
            class="card-svg-icon light-only"
            loading="lazy"
          />
        </div>
        <div class="card-meta">
          <span class="card-name">Drizzle ORM</span>
          <span class="card-desc">Zero-Alloc Wrapper</span>
        </div>
      </a>

      <!-- NestJS -->
      <a :href="withBase('/integrations/nestjs')" class="ecosystem-card">
        <div class="card-icon-box">
          <img
            :src="withBase('/docs/nestjs.svg')"
            alt="NestJS"
            class="card-svg-icon"
            loading="lazy"
          />
        </div>
        <div class="card-meta">
          <span class="card-name">NestJS</span>
          <span class="card-desc">Dynamic Module</span>
        </div>
      </a>

      <!-- Express / Hono -->
      <a :href="withBase('/integrations/http')" class="ecosystem-card">
        <div class="card-icon-box">
          <img
            :src="withBase('/docs/Hono--Streamline-Svg-Logos.svg')"
            alt="Hono / Express"
            class="card-svg-icon"
            loading="lazy"
          />
        </div>
        <div class="card-meta">
          <span class="card-name">Express / Hono</span>
          <span class="card-desc">Node + Edge Middleware</span>
        </div>
      </a>

      <!-- Cloudflare Edge -->
      <a :href="withBase('/integrations/edge')" class="ecosystem-card">
        <div class="card-icon-box">
          <img
            :src="withBase('/docs/cloudflare.svg')"
            alt="Cloudflare"
            class="card-svg-icon cloudflare-icon"
            loading="lazy"
          />
        </div>
        <div class="card-meta">
          <span class="card-name">Cloudflare Edge</span>
          <span class="card-desc">V8 Isolate Workers</span>
        </div>
      </a>
    </div>
  </section>
</template>

<style scoped>
.ecosystem-section {
  container-type: inline-size;
  padding: 3.5rem 0 1.5rem 0;
  border-top: 1px solid var(--vp-c-divider);
}

.ecosystem-section.no-header {
  border-top: none;
  padding: 0.75rem 0 1.5rem 0;
}

.ecosystem-header {
  margin-bottom: 1.5rem;
}

.ecosystem-title {
  font-family: var(--vp-font-family-heading);
  font-size: 1.35rem;
  font-weight: 700;
  letter-spacing: -0.025em;
  margin: 0 0 0.4rem 0;
  color: var(--vp-c-text-1);
}

.ecosystem-subtitle {
  font-family: var(--vp-font-family-base);
  font-size: 0.9rem;
  line-height: 1.5;
  color: var(--vp-c-text-2);
  margin: 0;
}

.ecosystem-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 0.875rem;
}

/* Container query: 2 columns on small containers */
@container (max-width: 480px) {
  .ecosystem-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* Container query: 3 spacious columns in docs layouts with sidebar + outline */
@container (min-width: 481px) and (max-width: 879px) {
  .ecosystem-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

/* Container query: 6 columns only on wide unconstrained viewports (e.g. homepage) */
@container (min-width: 880px) {
  .ecosystem-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }
}

.ecosystem-card {
  display: flex;
  flex-direction: column;
  padding: 1rem 0.95rem;
  min-height: 108px;
  justify-content: space-between;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg-soft);
  text-decoration: none !important;
  min-width: 0;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1),
              border-color 0.2s ease,
              background-color 0.2s ease,
              box-shadow 0.2s ease;
}

.dark .ecosystem-card {
  background: rgba(24, 24, 27, 0.55);
  border-color: rgba(63, 63, 70, 0.65);
}

.dark .ecosystem-card:hover {
  background: rgba(39, 39, 42, 0.85);
  border-color: rgba(125, 211, 252, 0.5);
  transform: translateY(-2px);
  box-shadow: 0 10px 24px -4px rgba(0, 0, 0, 0.5);
}

:root:not(.dark) .ecosystem-card {
  background: #ffffff;
  border-color: #d0d7de;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.04);
}

:root:not(.dark) .ecosystem-card:hover {
  background: #ffffff;
  border-color: #0f2b48;
  transform: translateY(-2px);
  box-shadow: 0 10px 20px -4px rgba(15, 43, 72, 0.08);
}

.card-icon-box {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  margin-bottom: 0.85rem;
}

.card-svg-icon {
  width: 26px;
  height: 26px;
  object-fit: contain;
  display: block;
}

.cloudflare-icon {
  width: 30px;
  height: 26px;
}

/* Next.js & Prisma: black in light mode, white in dark mode */
.dark .theme-invert-icon {
  filter: invert(1) brightness(1.2);
}

:root:not(.dark) .dark-only {
  display: none !important;
}

.dark .light-only {
  display: none !important;
}

.card-meta {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.card-name {
  font-family: var(--vp-font-family-base);
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--vp-c-text-1);
  line-height: 1.3;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.card-desc {
  font-family: var(--vp-font-family-mono);
  font-size: 0.725rem;
  color: var(--vp-c-text-2);
  letter-spacing: -0.01em;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
