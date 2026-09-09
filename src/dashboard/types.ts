import type { CacheService } from '../cache-service.js';

export interface DashboardPeerInstance {
  name: string;
  url: string;
}

export interface DashboardActionEvent {
  action: 'clear' | 'invalidate-tag';
  target?: string;
  user?: string;
  ip?: string;
  timestamp: number;
  success: boolean;
  error?: string;
}

export interface DashboardOptions {
  /**
   * TriCache instance to monitor and manage.
   */
  cache: CacheService;

  /**
   * Base mounting path for the dashboard (e.g. '/cache/dashboard' or '/admin/cache').
   * Used for generating relative links and API request paths.
   * @default ''
   */
  basePath?: string;

  /**
   * Custom title displayed in the browser tab and dashboard header.
   * @default 'TriCache Observability'
   */
  title?: string;

  /**
   * Identifier for the local container/pod/process.
   * Defaults to process.env.POD_NAME, process.env.HOSTNAME, or os.hostname().
   */
  instanceId?: string;

  /**
   * Optional list of sibling peer instance URLs for pod switching in multi-pod clusters.
   */
  peerInstances?: DashboardPeerInstance[];

  /**
   * HTTP Basic Authentication credentials.
   * Evaluated using timing-safe comparison (crypto.timingSafeEqual with SHA-256).
   */
  auth?: {
    username: string;
    password: string;
  };

  /**
   * Bearer token or URL token query parameter ('?token=...') for API authentication.
   * Evaluated using timing-safe comparison.
   */
  authSecret?: string;

  /**
   * Enforces read-only mode: disables and blocks all mutating operations
   * (e.g. invalidate tag, clear cache tier). Mutating endpoints return 403 Forbidden.
   * @default false
   */
  readOnly?: boolean;

  /**
   * Server-Sent Events (SSE) metric stream push interval in milliseconds.
   * @default 2000
   */
  streamIntervalMs?: number;

  /**
   * Enterprise audit logging hook invoked when an administrative action is attempted.
   * Allows piping security/audit events to Datadog, CloudWatch, Splunk, etc.
   */
  onAction?: (event: DashboardActionEvent) => void;
}

export interface StandaloneDashboardOptions extends DashboardOptions {
  /**
   * Port to listen on.
   * @default 9090
   */
  port?: number;

  /**
   * Host / IP interface to bind. Defaults to '127.0.0.1' for security.
   * Use '0.0.0.0' only inside private VPCs or behind authenticated reverse proxies.
   * @default '127.0.0.1'
   */
  host?: string;
}
