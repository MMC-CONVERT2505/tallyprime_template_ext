export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000/api';

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

let accessToken: string | null = null;

/** Called once at app startup and whenever auth state changes (see auth.ts). */
export function setAccessToken(token: string | null): void {
  accessToken = token;
}

async function request<T>(
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean; raw?: boolean } = {},
): Promise<T> {
  const { body, auth = true, raw = false } = options;
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth && accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (raw) {
    if (!response.ok) {
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        parsed = null;
      }
      throw new ApiError(response.status, parsed, describeError(response.status, parsed));
    }
    return (await response.blob()) as unknown as T;
  }

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new ApiError(response.status, parsed, describeError(response.status, parsed));
  }
  return parsed as T;
}

function describeError(status: number, body: unknown): string {
  const message = (body as { message?: string | string[] } | null)?.message;
  if (Array.isArray(message)) return message.join('; ');
  if (typeof message === 'string') return message;
  return `HTTP ${status}`;
}

// ── Types (mirroring the backend DTOs/response shapes) ──────────────────────

export interface AuthResult {
  accessToken: string;
  user: { id: string; email: string; name: string | null; orgId: string; orgName: string };
}

export interface ConnectionSummary {
  id: string;
  label: string;
  defaultCompany: string | null;
  isActive: boolean;
  lastSeenAt: string | null;
  createdAt: string;
  connected: boolean;
}

export interface NewConnectionResult {
  id: string;
  label: string;
  token: string;
  /** True when this reused (rotated the token on) an existing connection for the same company, rather than creating a new one. */
  reused: boolean;
}

export interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'approved'; id: string; label: string; token: string; reused: boolean };

export interface DeviceApproveResult {
  approved: true;
  /** True when this call found the code already approved earlier (e.g. a retried request) rather than approving it fresh. */
  alreadyApproved: boolean;
}

/** Read-only pairing state, safe to poll after approving — see deviceAuthApi.status. */
export type DeviceStatusResult =
  | { status: 'pending'; userCode: string; expiresInSeconds: number }
  | { status: 'expired'; userCode: string }
  | { status: 'approved'; userCode: string; label?: string | null; defaultCompany?: string | null }
  | {
      status: 'consumed';
      userCode: string;
      connectionId?: string;
      label?: string | null;
      defaultCompany?: string | null;
      connected?: boolean;
    };

export type ExtractableType = 'COMPANIES' | 'LEDGERS' | 'STOCK_ITEMS' | 'GROUPS' | 'VOUCHERS' | 'RAW';
export type MasterType = 'COMPANIES' | 'LEDGERS' | 'STOCK_ITEMS' | 'GROUPS';

export interface ExtractionJob {
  id: string;
  type: ExtractableType;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  company: string | null;
  params: unknown;
  recordCount: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TallyProbeResult {
  reachable: true;
  companies: string[];
  durationMs: number;
}

// ── Auth ──────────────────────────────────────────────────────────────────

export const authApi = {
  register: (body: { email: string; password: string; name: string; orgName: string }) =>
    request<AuthResult>('POST', '/auth/register', { body, auth: false }),
  login: (body: { email: string; password: string }) =>
    request<AuthResult>('POST', '/auth/login', { body, auth: false }),
  me: () => request<{ sub: string; email: string; orgId: string }>('GET', '/auth/me'),
};

// ── Connections (manual) ─────────────────────────────────────────────────

export const connectionsApi = {
  list: (search?: string) =>
    request<ConnectionSummary[]>('GET', `/connections${search ? `?search=${encodeURIComponent(search)}` : ''}`),
  create: (body: { label: string; defaultCompany?: string }) =>
    request<NewConnectionResult>('POST', '/connections', { body }),
  revoke: (id: string) => request<{ revoked: true }>('POST', `/connections/${id}/revoke`),
  rotateToken: (id: string) => request<NewConnectionResult>('POST', `/connections/${id}/rotate-token`),
  delete: (id: string) => request<{ deleted: true }>('DELETE', `/connections/${id}`),
};

// ── Device pairing ────────────────────────────────────────────────────────

export const deviceAuthApi = {
  start: () => request<DeviceStartResult>('POST', '/connections/device/start', { body: {}, auth: false }),
  approve: (body: { userCode: string; label?: string; defaultCompany?: string }) =>
    request<DeviceApproveResult>('POST', '/connections/device/approve', { body }),
  poll: (deviceCode: string) =>
    request<DevicePollResult>('POST', '/connections/device/token', { body: { deviceCode }, auth: false }),
  /** Safe to poll repeatedly after approve() — never touches the bridge's own bearer token (that's poll()'s job). */
  status: (userCode: string) =>
    request<DeviceStatusResult>('GET', `/connections/device/status?userCode=${encodeURIComponent(userCode)}`),
};

// ── Tally direct (dev sanity checks — no bridge needed) ─────────────────────

export const tallyApi = {
  probe: () => request<TallyProbeResult>('GET', '/tally/probe'),
  companies: (fresh?: boolean) =>
    request<unknown[]>('GET', `/tally/companies${fresh ? '?fresh=true' : ''}`),
  ledgers: (params: { company: string; fromDate?: string; toDate?: string }) =>
    request<unknown[]>('GET', `/tally/ledgers?${qs(params)}`),
  stockItems: (params: { company: string; fromDate?: string; toDate?: string }) =>
    request<unknown[]>('GET', `/tally/stock-items?${qs(params)}`),
  groups: (params: { company: string }) => request<unknown[]>('GET', `/tally/groups?${qs(params)}`),
  vouchers: (params: { company: string; from: string; to: string; voucherType?: string }) =>
    request<unknown[]>('GET', `/tally/vouchers?${qs(params)}`),
  raw: (body: { reportName: string; company?: string; fromDate?: string; toDate?: string; voucherType?: string }) =>
    request<{ reportName: string; company: string | null; rawXml: string; bytes: number }>('POST', '/tally/raw', {
      body,
    }),
};

function qs(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) usp.set(key, value);
  }
  return usp.toString();
}

/**
 * Async counterpart of tallyApi's GET/POST routes above: queue → poll →
 * fetch, instead of the request blocking until Tally answers. Same shape as
 * extractionsApi, but no connectionId — dispatches straight to the backend's
 * own configured Tally. Probe isn't here: it's already a fast, no-retry
 * health check (see backend TALLY_PROBE_TIMEOUT_MS), not a long-running pull.
 */
export const tallyJobsApi = {
  create: (body: { type: ExtractableType; payload?: Record<string, unknown> }) =>
    request<{ id: string; status: string }>('POST', '/tally/jobs', { body }),
  status: (id: string) => request<ExtractionJob>('GET', `/tally/jobs/${id}`),
  result: (id: string) => request<unknown>('GET', `/tally/jobs/${id}/result`),
};

// ── Extractions (job API) ────────────────────────────────────────────────

export const extractionsApi = {
  create: (body: { connectionId: string; type: ExtractableType; payload?: Record<string, unknown> }) =>
    request<{ id: string; status: string }>('POST', '/extractions', { body }),
  fetchMaster: (body: { companyName: string; masterType: MasterType; fromDate?: string; toDate?: string }) =>
    request<{ id: string; status: string }>('POST', '/extractions/fetch-master', { body }),
  status: (id: string) => request<ExtractionJob>('GET', `/extractions/${id}`),
  result: (id: string) => request<unknown>('GET', `/extractions/${id}/result`),
  /** Excel needs the Authorization header, so a plain <a href> won't work — fetch as a blob and hand back an object URL to download/open. */
  excel: (id: string, groupsJobId?: string) =>
    request<Blob>('GET', `/extractions/${id}/excel${groupsJobId ? `?groupsJobId=${groupsJobId}` : ''}`, {
      raw: true,
    }),
};

export const healthApi = {
  infra: () => request<{ status: string }>('GET', '/health', { auth: false }),
  tally: () => request<{ status: string }>('GET', '/health/tally', { auth: false }),
};
