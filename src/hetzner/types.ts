// Hand-written Hetzner Cloud API types (01 §3.9): only the fields that projections and guards read.
// No generator, the OpenAPI spec is not part of the repository (OP-14).
// Deprecated fields are never typed and never read (`deprecated`, Volume `server`, `datacenter`,
// Pricing `floating_ip`).

export type Labels = Readonly<Record<string, string>>;

/** Action object (R§3); every field is required in the spec. */
export interface HetznerAction {
  id: number;
  command: string;
  status: "running" | "success" | "error";
  progress: number;
  started: string;
  finished: string | null;
  resources: { id: number; type: string }[];
  error: { code: string; message: string } | null;
}

/** `meta.pagination` of every list response (R§2.5). */
export interface HetznerPagination {
  page: number;
  per_page: number;
  previous_page: number | null;
  next_page: number | null;
  last_page: number | null;
  total_entries: number | null;
}

/** Error body of every non-2xx response (R§2.2). */
export interface HetznerErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/**
 * `pricing` from `GET /pricing` (R§4.2). Placeholder for the gateway signature only: AP-13 replaces it
 * with the interface from 03 §2.3 (01 §3.9, 05 K-06). Callers must not read fields before that.
 */
export type HetznerPricing = Readonly<Record<string, unknown>>;

// Server, SshKey, Firewall, Volume, Image, ServerType, Location: added by the domain packages
// (AP-10/11/12/15/17), each with `labels: Labels` and – where present – `protection`.
