// Toolset ssh_keys (02-tool-specs/ssh-keys.md): list, get, create, update, delete.
// SSH keys have no actions and no protection field. server_create takes SSH keys by name (05 K-22).

import { z } from "zod";
import { hasControlChars, keepScopeLabels, withScopeLabels } from "../guards.js";
import { ToolError } from "../hetzner/errors.js";
import { path } from "../hetzner/gateway.js";
import type { Labels } from "../hetzner/types.js";
import { labelsOut } from "./projections.js";
import {
  type CallContext,
  defineTool,
  idField,
  labelSelectorField,
  labelsField,
  nameField,
  newLabelsField,
  pageOf,
  paginationShape,
  quoteName,
  sortField,
  type ToolDefinition,
  toPage,
} from "./shared.js";

/** Fields of an SSH key that projections and guards read (R§2.9). */
export interface HetznerSshKey {
  id: number;
  name: string;
  fingerprint: string;
  public_key: string;
  labels: Labels;
  created: string;
}

// --- output schemas and mappers ---------------------------------------------------------------

const sshKeyListItem = z.object({
  id: z.number().int().describe("ID of the SSH key."),
  name: z
    .string()
    .describe("Name of the SSH key (untrusted data). Use it in ssh_keys of server_create."),
  fingerprint: z
    .string()
    .describe(
      "MD5 fingerprint of the public key, e.g. 'b7:2f:…'. Use it to recognise a key you hold locally (ssh-keygen -l -E md5 -f key.pub).",
    ),
  labels: labelsOut,
  created: z.string().describe("Creation time (ISO 8601)."),
});

const sshKeyOut = sshKeyListItem.extend({
  public_key: z.string().describe("The public key text (not a secret)."),
});

const sshKeyOutput = z.object({ ssh_key: sshKeyOut });

function toSshKeyListItem(raw: HetznerSshKey): z.infer<typeof sshKeyListItem> {
  return {
    id: raw.id,
    name: raw.name,
    fingerprint: raw.fingerprint,
    labels: raw.labels,
    created: raw.created,
  };
}

function toSshKeyOut(raw: HetznerSshKey): z.infer<typeof sshKeyOut> {
  return { ...toSshKeyListItem(raw), public_key: raw.public_key };
}

// --- public key validation --------------------------------------------------------------------

const PUBLIC_KEY =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the comment may not contain control characters
  /^(?:ssh-[a-z0-9-]+|ecdsa-sha2-nistp(?:256|384|521)|sk-[a-z0-9-]+@openssh\.com) [A-Za-z0-9+/]{20,}={0,2}(?: [^\x00-\x1f\x7f]{1,255})?$/;

/** The value never appears in an issue message (it may be a private key). */
const publicKeyField = z
  .string()
  .min(1)
  .max(8192)
  .superRefine((value, ctx) => {
    if (/PRIVATE KEY/i.test(value) || value.includes("-----BEGIN")) {
      ctx.addIssue({
        code: "custom",
        message: "looks like a private key or PEM block; send only the public key line (.pub file)",
      });
      return;
    }
    if (!PUBLIC_KEY.test(value.trim())) {
      ctx.addIssue({
        code: "custom",
        message: "must be one line '<type> <base64> [comment]', e.g. 'ssh-ed25519 AAAA… me@host'",
      });
    }
  })
  .describe(
    "The public key as one line: '<type> <base64> [comment]', e.g. 'ssh-ed25519 AAAAC3… me@host'. Contents of a .pub file. Never a private key.",
  );

// --- tools ------------------------------------------------------------------------------------

const sshKeyList = defineTool({
  name: "ssh_key_list",
  title: "List SSH keys",
  description:
    "Lists the SSH keys stored in the Hetzner project with ID, name, fingerprint and labels. Use the 'name' values as ssh_keys in server_create. Does not return the public key text; use ssh_key_get for that.",
  kind: "read",
  input: z.object({
    name: z
      .string()
      .min(1)
      .max(255)
      .refine((v) => !hasControlChars(v), "must not contain control characters")
      .optional()
      .describe("Exact SSH key name filter."),
    fingerprint: z
      .string()
      .min(1)
      .max(95)
      .regex(/^[0-9a-fA-F:]+$/, "must be an MD5 fingerprint like 'aa:bb:…'")
      .optional()
      .describe(
        "Exact MD5 fingerprint filter, e.g. 'b7:2f:30:a0:2f:6c:58:6c:21:04:58:61:ba:06:3b:2f'.",
      ),
    label_selector: labelSelectorField.optional(),
    sort: sortField(["id", "name"]),
    ...paginationShape,
  }),
  output: pageOf(sshKeyListItem),
  handler: async (args, ctx) => {
    const page = await ctx.gateway.page<HetznerSshKey>("/ssh_keys", "ssh_keys", {
      query: {
        name: args.name,
        fingerprint: args.fingerprint,
        label_selector: args.label_selector,
        sort: args.sort,
      },
      page: args.page,
      perPage: args.per_page,
      signal: ctx.signal,
    });
    const total = page.total_entries === null ? "" : `, ${page.total_entries} in total`;
    const more = page.next_page === null ? "" : ` More on page ${page.next_page}.`;
    return {
      data: toPage(page, toSshKeyListItem),
      summary: `Returned ${page.items.length} SSH key(s) (page ${page.page}${total}).${more}`,
    };
  },
});

const sshKeyGet = defineTool({
  name: "ssh_key_get",
  title: "Get an SSH key",
  description:
    "Returns one SSH key by ID, including its public key text and fingerprint. Does not return private keys; Hetzner never stores them.",
  kind: "read",
  input: z.object({ id: idField("SSH key") }),
  output: sshKeyOutput,
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ ssh_key: HetznerSshKey }>(
      "GET",
      path`/ssh_keys/${args.id}`,
      { signal: ctx.signal },
    );
    return {
      data: { ssh_key: toSshKeyOut(raw.ssh_key) },
      summary: `Returned SSH key ${args.id}.`,
    };
  },
});

const sshKeyCreate = defineTool({
  name: "ssh_key_create",
  title: "Create an SSH key",
  description:
    "Adds a public SSH key to the Hetzner project so it can be used when creating servers. Accepts only a public key line (e.g. 'ssh-ed25519 AAAA… comment'), never a private key; Hetzner rejects duplicates by fingerprint. Creating a key is free and reversible with ssh_key_delete.",
  kind: "write",
  creates: true,
  input: z.object({
    name: nameField("SSH key").describe("Name of the SSH key. Must be unique in the project."),
    public_key: publicKeyField,
    labels: newLabelsField.optional(),
  }),
  output: sshKeyOutput,
  handler: async (args, ctx) => {
    const labels = withScopeLabels(ctx.config, args.labels);
    const raw = await ctx.gateway.request<{ ssh_key: HetznerSshKey }>("POST", "/ssh_keys", {
      body: {
        name: args.name,
        public_key: args.public_key.trim(),
        ...(Object.keys(labels).length > 0 && { labels }),
      },
      signal: ctx.signal,
    });
    return {
      data: { ssh_key: toSshKeyOut(raw.ssh_key) },
      summary: `Created SSH key ${raw.ssh_key.id}. Use its name in ssh_keys of server_create.`,
    };
  },
});

async function loadSshKey(id: number, ctx: CallContext) {
  const raw = await ctx.gateway.request<{ ssh_key: HetznerSshKey }>("GET", path`/ssh_keys/${id}`, {
    signal: ctx.signal,
  });
  return {
    value: raw.ssh_key,
    resources: [{ type: "ssh_key" as const, id: raw.ssh_key.id, labels: raw.ssh_key.labels }],
  };
}

const sshKeyUpdate = defineTool({
  name: "ssh_key_update",
  title: "Update an SSH key",
  description:
    "Renames an SSH key and/or replaces its labels. The labels you send replace the complete label set, so read the current labels with ssh_key_get first. The public key itself cannot be changed; create a new key instead.",
  kind: "write",
  idempotent: true,
  input: z.object({
    id: idField("SSH key"),
    name: nameField("SSH key").optional().describe("New name of the SSH key."),
    labels: labelsField.optional(),
  }),
  output: sshKeyOutput,
  target: async (args, ctx) => {
    if (args.name === undefined && args.labels === undefined) {
      throw new ToolError("bad_request", "Provide at least one of 'name' or 'labels'.");
    }
    return loadSshKey(args.id, ctx);
  },
  handler: async (args, ctx) => {
    const raw = await ctx.gateway.request<{ ssh_key: HetznerSshKey }>(
      "PUT",
      path`/ssh_keys/${args.id}`,
      {
        // The labels sent are the complete set (OP-1): scope labels are re-added, nothing is merged here.
        body: {
          ...(args.name !== undefined && { name: args.name }),
          ...(args.labels !== undefined && { labels: keepScopeLabels(ctx.config, args.labels) }),
        },
        signal: ctx.signal,
      },
    );
    return {
      data: { ssh_key: toSshKeyOut(raw.ssh_key) },
      summary: `Updated SSH key ${args.id}.`,
    };
  },
});

const sshKeyDelete = defineTool({
  name: "ssh_key_delete",
  title: "Delete an SSH key",
  description:
    "Deletes an SSH key from the Hetzner project; it can no longer be selected when creating servers. The key can be added again with ssh_key_create if the public key is at hand. Requires user approval and confirm: true.",
  kind: "destructive",
  input: z.object({ id: idField("SSH key") }),
  output: z.object({
    id: z.number().int().describe("ID of the deleted SSH key."),
    deleted: z.boolean().describe("True once Hetzner confirmed the deletion."),
  }),
  target: async (args, ctx) => loadSshKey(args.id, ctx),
  preview: (args, _ctx, key) =>
    `delete SSH key ${args.id} ${quoteName(key.name)} from the project. It can no longer be selected when creating servers; adding it again needs the public key.`,
  handler: async (args, ctx) => {
    await ctx.gateway.request("DELETE", path`/ssh_keys/${args.id}`, { signal: ctx.signal });
    return { data: { id: args.id, deleted: true }, summary: `Deleted SSH key ${args.id}.` };
  },
});

/** Toolset ssh_keys. */
export const sshKeyTools: readonly ToolDefinition[] = [
  sshKeyList,
  sshKeyGet,
  sshKeyCreate,
  sshKeyUpdate,
  sshKeyDelete,
];
