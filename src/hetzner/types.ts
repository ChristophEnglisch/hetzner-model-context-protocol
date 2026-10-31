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

/** Net and gross of one price as decimal strings (`format: decimal`, R§4.2). */
export interface PriceStrings {
  net: string;
  gross: string;
}

export interface LocationPrice {
  location: string;
  price_hourly: PriceStrings;
  price_monthly: PriceStrings;
}

/**
 * `pricing` from `GET /pricing` (R§4.2, 03 §2.3), only the fields we read.
 * Not typed (01 §3.6): `floating_ip` (deprecated), `load_balancer_types` (1.1).
 */
export interface HetznerPricing {
  /** ISO 4217 (SPEC); the value is account-dependent (not documented) and never assumed. */
  currency: string;
  vat_rate: string;
  server_types: {
    id: number;
    name: string;
    prices: (LocationPrice & { included_traffic: number })[];
  }[];
  primary_ips: { type: "ipv4" | "ipv6"; prices: LocationPrice[] }[];
  floating_ips: {
    type: "ipv4" | "ipv6";
    prices: { location: string; price_monthly: PriceStrings }[];
  }[];
  volume: { price_per_gb_month: PriceStrings };
  image: { price_per_gb_month: PriceStrings };
  server_backup: { percentage: string };
}

/**
 * Server object (R§2.9, 02-tool-specs/core.md): only fields that guards, previews or mappers read.
 * Never read: `datacenter`, `server_type.deprecated`/`deprecation`, `image.deprecated`.
 * `volumes`, `load_balancers`, `placement_group` and `public_net.firewalls` are not `required` in the spec.
 */
export interface HetznerServer {
  id: number;
  name: string;
  status:
    | "running"
    | "initializing"
    | "starting"
    | "stopping"
    | "off"
    | "deleting"
    | "migrating"
    | "rebuilding"
    | "unknown";
  created: string;
  public_net: {
    ipv4: { id?: number; ip: string; blocked: boolean } | null;
    ipv6: { id?: number; ip: string; blocked: boolean } | null;
    floating_ips: number[];
    firewalls?: { id: number; status: "applied" | "pending" }[];
  };
  private_net: { network: number; ip: string; alias_ips: string[] }[];
  server_type: {
    id: number;
    name: string;
    cores: number;
    memory: number;
    disk: number;
    cpu_type: string;
    architecture: string;
    storage_type: string;
  };
  location: { id: number; name: string };
  image: {
    id: number;
    name: string | null;
    type: string;
    os_flavor: string;
    os_version: string | null;
  } | null;
  iso: { id: number; name: string | null } | null;
  rescue_enabled: boolean;
  locked: boolean;
  backup_window: string | null;
  outgoing_traffic: number | null;
  ingoing_traffic: number | null;
  included_traffic: number | null;
  protection: { delete: boolean; rebuild: boolean };
  labels: Labels;
  volumes?: number[];
  load_balancers?: number[];
  primary_disk_size: number;
  placement_group?: { id: number } | null;
}

// Server, SshKey, Firewall, Volume, Image, ServerType, Location: added by the domain packages
// (AP-10/11/12/15/17), each with `labels: Labels` and – where present – `protection`.
