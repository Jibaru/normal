import { z } from "zod";

const API_ORIGIN = "https://console.neon.tech/api/v2";
const RESTORE_ROLE = "whatsapp_restore_runtime";
const runtimeRoleSchema = z.enum([
  RESTORE_ROLE,
  "whatsapp_api_runtime",
  "whatsapp_recovery_verifier",
]);
const RECOVERY_ANNOTATION_KEY = "production-recovery";
const RECOVERY_ANNOTATION_VALUE = "true";
const HISTORY_WINDOW_MS = 7 * 86_400_000;
const branchIdSchema = z.string().regex(/^br-[a-z0-9-]{1,57}$/u);
const projectIdSchema = z.string().regex(/^[a-z0-9-]{1,60}$/u);
const canonicalTimestampSchema = z.string().refine((value) => {
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}, "must be a canonical UTC timestamp");

const operationStatusSchema = z.enum([
  "scheduling",
  "running",
  "finished",
  "failed",
  "error",
  "cancelling",
  "cancelled",
  "skipped",
]);

const operationSchema = z
  .object({
    id: z.uuid(),
    project_id: projectIdSchema,
    branch_id: branchIdSchema.optional(),
    endpoint_id: z
      .string()
      .regex(/^ep-[a-z0-9-]{1,57}$/u)
      .optional(),
    action: z.enum([
      "create_compute",
      "create_timeline",
      "start_compute",
      "suspend_compute",
      "apply_config",
      "check_availability",
      "delete_timeline",
      "create_branch",
      "import_data",
      "tenant_ignore",
      "tenant_attach",
      "tenant_detach",
      "tenant_detach_safekeepers",
      "tenant_attach_safekeepers",
      "tenant_reattach",
      "replace_safekeeper",
      "disable_maintenance",
      "apply_storage_config",
      "prepare_secondary_pageserver",
      "switch_pageserver",
      "detach_parent_branch",
      "timeline_archive",
      "timeline_unarchive",
      "start_reserved_compute",
      "sync_dbs_and_roles_from_compute",
      "apply_schema_from_branch",
      "timeline_mark_invisible",
      "timeline_update_protected_config",
      "prewarm_replica",
      "promote_replica",
      "set_storage_non_dirty",
      "swap_binding_id",
      "finalize_migration",
      "mark_migration_prepared",
      "update_catalog",
      "epc_sync",
    ]),
    status: operationStatusSchema,
    error: z.string().optional(),
    failures_count: z.number().int().nonnegative(),
    retry_at: z.iso.datetime({ offset: true }).optional(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    total_duration_ms: z.number().int().nonnegative(),
  })
  .passthrough();

const branchSchema = z
  .object({
    id: branchIdSchema,
    project_id: projectIdSchema,
    parent_id: branchIdSchema.optional(),
    parent_lsn: z.string().optional(),
    parent_timestamp: z.iso.datetime({ offset: true }).optional(),
    name: z.string().min(1),
    slug: z.string().optional(),
    project_slug: z.string().optional(),
    current_state: z.enum(["init", "ready"]).or(z.string().min(1)),
    pending_state: z.string().min(1).optional(),
    state_changed_at: z.iso.datetime({ offset: true }),
    logical_size: z.number().int().nonnegative().optional(),
    creation_source: z.string().min(1),
    primary: z.boolean().optional(),
    default: z.boolean(),
    protected: z.boolean(),
    cpu_used_sec: z.number().nonnegative(),
    compute_time_seconds: z.number().nonnegative(),
    active_time_seconds: z.number().nonnegative(),
    written_data_bytes: z.number().int().nonnegative(),
    data_transfer_bytes: z.number().int().nonnegative(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }).optional(),
    ttl_interval_seconds: z.number().int().nonnegative().optional(),
    init_source: z.enum([
      "parent-data",
      "parent-schema",
      "schema-only",
      "import",
    ]),
    restore_status: z.string().optional(),
    restored_from: z.string().optional(),
    restored_as: z.string().optional(),
    created_by: z
      .object({ name: z.string().optional(), image: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const operationResponseSchema = z
  .object({ operation: operationSchema })
  .passthrough();
const endpointSchema = z
  .object({
    host: z.string().min(1),
    id: z.string().regex(/^ep-[a-z0-9-]{1,57}$/u),
    name: z.string().optional(),
    project_id: projectIdSchema,
    branch_id: branchIdSchema,
    autoscaling_limit_min_cu: z.number().optional(),
    autoscaling_limit_max_cu: z.number().optional(),
    region_id: z.string().min(1),
    type: z.enum(["read_only", "read_write"]),
    current_state: z.enum(["init", "active", "idle"]),
    pending_state: z.enum(["init", "active", "idle"]).optional(),
    settings: z
      .object({
        pg_settings: z.record(z.string(), z.string()).optional(),
        preload_libraries: z
          .object({
            use_defaults: z.boolean().optional(),
            enabled_libraries: z.array(z.string()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
    pooler_enabled: z.boolean(),
    pooler_mode: z.literal("transaction").optional(),
    disabled: z.boolean(),
    passwordless_access: z.boolean(),
    creation_source: z.string().optional(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    proxy_host: z.string().optional(),
    suspend_timeout_seconds: z.number().int().optional(),
    provisioner: z.string().optional(),
  })
  .passthrough();
const roleSchema = z
  .object({
    branch_id: branchIdSchema,
    name: z.string(),
    password: z.string().min(1).optional(),
    protected: z.boolean().optional(),
    authentication_method: z.enum(["password", "oauth", "no_login"]).optional(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .passthrough();
const databaseSchema = z
  .object({
    id: z.number().int(),
    branch_id: branchIdSchema,
    name: z.string(),
    owner_name: z.string(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .passthrough();
const annotationSchema = z
  .object({
    object: z.object({ type: z.string(), id: z.string() }).passthrough(),
    value: z.record(z.string(), z.string()),
    created_at: z.iso.datetime({ offset: true }).optional(),
    updated_at: z.iso.datetime({ offset: true }).optional(),
  })
  .passthrough();
const branchResponseSchema = z
  .object({
    branch: branchSchema,
    annotation: annotationSchema.optional(),
  })
  .passthrough();
const operationsSchema = z.array(operationSchema);
const branchOperationsResponseSchema = z
  .object({ branch: branchSchema, operations: operationsSchema })
  .passthrough();
const createBranchResponseSchema = z
  .object({
    branch: branchSchema,
    endpoints: z.array(endpointSchema),
    operations: operationsSchema,
    roles: z.array(roleSchema).optional(),
    databases: z.array(databaseSchema).optional(),
  })
  .passthrough();
const branchesResponseSchema = z
  .object({
    branches: z.array(branchSchema),
    annotations: z.record(z.string(), annotationSchema),
    pagination: z
      .object({
        next: z.string().optional(),
        sort_by: z.string(),
        sort_order: z.string(),
      })
      .passthrough(),
  })
  .passthrough();
const roleOperationsResponseSchema = z
  .object({
    role: roleSchema.extend({ password: z.string().min(1) }).passthrough(),
    operations: operationsSchema,
  })
  .passthrough();
const connectionUriResponseSchema = z
  .object({ uri: z.string().min(1) })
  .passthrough();
const endpointsResponseSchema = z
  .object({ endpoints: z.array(endpointSchema) })
  .passthrough();
const endpointOperationsResponseSchema = z
  .object({ endpoint: endpointSchema, operations: operationsSchema })
  .passthrough();

const configSchema = z
  .object({
    apiKey: z
      .string()
      .min(20)
      .max(512)
      .refine(
        (value) =>
          value.trim() === value &&
          [...value].every((character) => {
            const code = character.charCodeAt(0);
            return code > 31 && code !== 127;
          }),
      )
      .refine((value) => !/example|placeholder|replace-with/iu.test(value)),
    projectId: projectIdSchema,
    parentBranchId: branchIdSchema,
    branchNamePrefix: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u),
    databaseName: z.string().regex(/^[a-z_][a-z0-9_$]{0,62}$/u),
    runtimeRole: runtimeRoleSchema.optional().default(RESTORE_ROLE),
    polling: z
      .object({
        maxAttempts: z.number().int().min(1).max(300),
        intervalMs: z.number().int().min(1).max(60_000),
        timeoutMs: z.number().int().min(1).max(3_600_000),
      })
      .strict(),
  })
  .strict();

export type NeonRecoveryConfig = z.input<typeof configSchema>;
export interface RecoveryBranch {
  readonly id: string;
  readonly name: string;
  readonly parentId: string;
  readonly parentTimestamp: string;
}
export type NeonFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;
export interface NeonRecoveryDependencies {
  readonly fetch?: NeonFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export class NeonRecoveryError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = false) {
    super(message);
    this.name = "NeonRecoveryError";
    this.retryable = retryable;
  }
}

const exactBranch = (
  branch: z.infer<typeof branchSchema>,
  expected: Omit<RecoveryBranch, "id"> & { readonly id?: string },
  projectId: string,
) =>
  branch.project_id === projectId &&
  branch.id !== expected.parentId &&
  (expected.id === undefined || branch.id === expected.id) &&
  branch.name === expected.name &&
  branch.parent_id === expected.parentId &&
  (branch.parent_timestamp === undefined ||
    new Date(branch.parent_timestamp).toISOString() ===
      expected.parentTimestamp) &&
  branch.default === false &&
  branch.primary !== true &&
  branch.protected === false &&
  branch.init_source === "parent-data";

const exactRecoveryAnnotation = (
  annotation: z.infer<typeof annotationSchema> | undefined,
  branchId: string,
  expected: Omit<RecoveryBranch, "id">,
) =>
  annotation?.object.type === "console/branch" &&
  annotation.object.id === branchId &&
  Object.keys(annotation.value).length === 1 &&
  annotation.value[RECOVERY_ANNOTATION_KEY] ===
    `${RECOVERY_ANNOTATION_VALUE}:${expected.parentId}:${expected.parentTimestamp}`;

export const createNeonRecoveryClient = (
  input: NeonRecoveryConfig,
  dependencies: NeonRecoveryDependencies = {},
) => {
  const config = configSchema.parse(input);
  const fetchImplementation: NeonFetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep =
    dependencies.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));

  const url = (path: string) => `${API_ORIGIN}${path}`;
  const request = async <T>(
    path: string,
    init: RequestInit,
    schema: z.ZodType<T>,
    allowedStatuses: readonly number[],
  ): Promise<{ readonly status: number; readonly value?: T }> => {
    let response: Response;
    try {
      response = await fetchImplementation(url(path), {
        ...init,
        redirect: "manual",
        signal: init.signal ?? AbortSignal.timeout(config.polling.timeoutMs),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiKey}`,
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
      });
    } catch {
      throw new NeonRecoveryError(
        "Neon control-plane request failed without a response",
        init.method === "GET",
      );
    }
    if (allowedStatuses.includes(response.status))
      return { status: response.status };
    if (!response.ok)
      throw new NeonRecoveryError(
        `Neon control-plane request failed with status ${response.status}`,
        init.method === "GET" &&
          (response.status === 423 ||
            response.status === 429 ||
            response.status >= 500),
      );
    if (
      !response.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/json")
    )
      throw new NeonRecoveryError("Neon control-plane response was not JSON");
    let candidate: unknown;
    try {
      candidate = await response.json();
    } catch {
      throw new NeonRecoveryError(
        "Neon control-plane response was not valid JSON",
      );
    }
    const parsed = schema.safeParse(candidate);
    if (!parsed.success)
      throw new NeonRecoveryError(
        "Neon control-plane response did not match its required contract",
      );
    return { status: response.status, value: parsed.data };
  };

  const waitForOperations = async (
    operations: readonly z.infer<typeof operationSchema>[],
  ) => {
    for (const initial of operations) {
      if (initial.project_id !== config.projectId)
        throw new NeonRecoveryError(
          "Neon operation belongs to a different project",
        );
      const startedAt = now();
      let operation = initial;
      for (let attempt = 1; operation.status !== "finished"; attempt += 1) {
        if (!["scheduling", "running"].includes(operation.status))
          throw new NeonRecoveryError(
            "Neon operation terminated without success",
          );
        if (
          attempt >= config.polling.maxAttempts ||
          now() - startedAt >= config.polling.timeoutMs
        )
          throw new NeonRecoveryError(
            "Neon operation polling bound was exhausted",
          );
        await sleep(config.polling.intervalMs);
        if (now() - startedAt >= config.polling.timeoutMs)
          throw new NeonRecoveryError(
            "Neon operation polling bound was exhausted",
          );
        let result: {
          readonly status: number;
          readonly value?: z.infer<typeof operationResponseSchema>;
        };
        try {
          result = await request(
            `/projects/${config.projectId}/operations/${operation.id}`,
            { method: "GET" },
            operationResponseSchema,
            [],
          );
        } catch (error) {
          if (error instanceof NeonRecoveryError && error.retryable) continue;
          throw error;
        }
        operation = result.value?.operation as z.infer<typeof operationSchema>;
        if (
          operation.id !== initial.id ||
          operation.project_id !== config.projectId
        )
          throw new NeonRecoveryError(
            "Neon returned a different operation identity",
          );
      }
    }
  };

  const listNamedBranches = async (name: string) => {
    const matches: Array<{
      readonly branch: z.infer<typeof branchSchema>;
      readonly annotation: z.infer<typeof annotationSchema> | undefined;
    }> = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (pages >= 100 || (cursor !== undefined && seenCursors.has(cursor)))
        throw new NeonRecoveryError(
          "Neon branch pagination bound was exhausted",
        );
      pages += 1;
      if (cursor !== undefined) seenCursors.add(cursor);
      const query = new URLSearchParams({ search: name, limit: "100" });
      if (cursor !== undefined) query.set("cursor", cursor);
      const result = await request(
        `/projects/${config.projectId}/branches?${query}`,
        { method: "GET" },
        branchesResponseSchema,
        [],
      );
      const page = result.value as z.infer<typeof branchesResponseSchema>;
      matches.push(
        ...page.branches
          .filter((branch) => branch.name === name)
          .map((branch) => ({
            branch,
            annotation: page.annotations[branch.id],
          })),
      );
      cursor = page.pagination.next;
    } while (cursor !== undefined);
    return matches;
  };

  const waitForReadyBranch = async (
    initial: z.infer<typeof branchSchema>,
    annotation: z.infer<typeof annotationSchema> | undefined,
    expected: Omit<RecoveryBranch, "id"> & { readonly id: string },
  ) => {
    const startedAt = now();
    let branch = initial;
    let branchAnnotation = annotation;
    for (let attempt = 1; ; attempt += 1) {
      if (!exactBranch(branch, expected, config.projectId))
        throw new NeonRecoveryError(
          "Existing Neon branch does not match the requested PITR source",
        );
      if (!exactRecoveryAnnotation(branchAnnotation, branch.id, expected))
        throw new NeonRecoveryError(
          "Neon recovery branch annotation guard failed",
        );
      if (branch.current_state === "ready") return branch;
      if (branch.current_state !== "init")
        throw new NeonRecoveryError("Existing Neon PITR branch is not ready");
      if (
        attempt >= config.polling.maxAttempts ||
        now() - startedAt >= config.polling.timeoutMs
      )
        throw new NeonRecoveryError("Neon branch polling bound was exhausted");
      await sleep(config.polling.intervalMs);
      if (now() - startedAt >= config.polling.timeoutMs)
        throw new NeonRecoveryError("Neon branch polling bound was exhausted");
      let fresh: {
        readonly status: number;
        readonly value?: z.infer<typeof branchResponseSchema>;
      };
      try {
        fresh = await request(
          `/projects/${config.projectId}/branches/${expected.id}`,
          { method: "GET" },
          branchResponseSchema,
          [],
        );
      } catch (error) {
        if (error instanceof NeonRecoveryError && error.retryable) continue;
        throw error;
      }
      const value = fresh.value as z.infer<typeof branchResponseSchema>;
      branch = value.branch;
      branchAnnotation = value.annotation;
    }
  };

  const reconcilePitrBranch = async (input: {
    readonly name: string;
    readonly parentTimestamp: string;
  }): Promise<RecoveryBranch> => {
    const name = z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u)
      .parse(input.name);
    const parentTimestamp = canonicalTimestampSchema.parse(
      input.parentTimestamp,
    );
    const sourceTime = Date.parse(parentTimestamp);
    const requestedAt = now();
    if (
      sourceTime > requestedAt ||
      requestedAt - sourceTime > HISTORY_WINDOW_MS
    )
      throw new NeonRecoveryError(
        "PITR timestamp is outside the configured history window",
      );
    if (!name.startsWith(config.branchNamePrefix))
      throw new NeonRecoveryError(
        "Recovery branch name is outside the configured prefix",
      );
    const expected = { name, parentId: config.parentBranchId, parentTimestamp };
    const existing = await listNamedBranches(name);
    if (existing.length > 1)
      throw new NeonRecoveryError(
        "Multiple Neon branches have the recovery branch name",
      );
    if (existing.length === 1) {
      const match = existing[0];
      if (match === undefined)
        throw new NeonRecoveryError("Neon branch reconciliation failed");
      const branch = await waitForReadyBranch(match.branch, match.annotation, {
        id: match.branch.id,
        ...expected,
      });
      return { id: branch.id, ...expected };
    }

    let result: {
      readonly status: number;
      readonly value?: z.infer<typeof createBranchResponseSchema>;
    };
    try {
      result = await request(
        `/projects/${config.projectId}/branches`,
        {
          method: "POST",
          body: JSON.stringify({
            branch: {
              name,
              parent_id: config.parentBranchId,
              parent_timestamp: parentTimestamp,
              protected: false,
              init_source: "parent-data",
            },
            endpoints: [{ type: "read_write" }],
            annotation_value: {
              [RECOVERY_ANNOTATION_KEY]: `${RECOVERY_ANNOTATION_VALUE}:${expected.parentId}:${expected.parentTimestamp}`,
            },
          }),
        },
        createBranchResponseSchema,
        [],
      );
    } catch (error) {
      const reconciled = await listNamedBranches(name);
      if (reconciled.length > 1)
        throw new NeonRecoveryError(
          "Multiple Neon branches have the recovery branch name",
        );
      const candidate = reconciled[0];
      if (candidate !== undefined) {
        const branch = await waitForReadyBranch(
          candidate.branch,
          candidate.annotation,
          { id: candidate.branch.id, ...expected },
        );
        return { id: branch.id, ...expected };
      }
      throw error;
    }
    const created = result.value as z.infer<typeof createBranchResponseSchema>;
    if (!exactBranch(created.branch, expected, config.projectId))
      throw new NeonRecoveryError(
        "Created Neon branch does not match the requested PITR source",
      );
    await waitForOperations(created.operations);
    const fresh = await request(
      `/projects/${config.projectId}/branches/${created.branch.id}`,
      { method: "GET" },
      branchResponseSchema,
      [],
    );
    const branch = (fresh.value as z.infer<typeof branchResponseSchema>).branch;
    const annotation = (fresh.value as z.infer<typeof branchResponseSchema>)
      .annotation;
    if (
      !exactBranch(
        branch,
        { ...expected, id: created.branch.id },
        config.projectId,
      ) ||
      branch.current_state !== "ready" ||
      !exactRecoveryAnnotation(annotation, branch.id, expected)
    )
      throw new NeonRecoveryError(
        "Neon did not reconcile the exact PITR branch",
      );
    return { id: branch.id, ...expected };
  };

  const findGuardedPitrBranch = async (input: {
    readonly name: string;
    readonly parentTimestamp: string;
  }): Promise<RecoveryBranch | "absent"> => {
    const name = z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u)
      .parse(input.name);
    const parentTimestamp = canonicalTimestampSchema.parse(
      input.parentTimestamp,
    );
    if (!name.startsWith(config.branchNamePrefix))
      throw new NeonRecoveryError(
        "Recovery branch name is outside the configured prefix",
      );
    const matches = await listNamedBranches(name);
    if (matches.length > 1)
      throw new NeonRecoveryError(
        "Multiple Neon branches have the recovery branch name",
      );
    const match = matches[0];
    if (match === undefined) return "absent";
    const expected = {
      id: match.branch.id,
      name,
      parentId: config.parentBranchId,
      parentTimestamp,
    };
    if (
      !exactBranch(match.branch, expected, config.projectId) ||
      !exactRecoveryAnnotation(match.annotation, match.branch.id, expected)
    )
      throw new NeonRecoveryError("Neon recovery branch cleanup guard failed");
    return expected;
  };

  const resetRestoreRuntimePassword = async (
    branch: RecoveryBranch,
  ): Promise<void> => {
    const verified = await getGuardedBranch(branch);
    const resetPassword = () =>
      request(
        `/projects/${config.projectId}/branches/${verified.id}/roles/${config.runtimeRole}/reset_password`,
        { method: "POST" },
        roleOperationsResponseSchema,
        [],
      );
    let result: Awaited<ReturnType<typeof resetPassword>>;
    try {
      result = await resetPassword();
    } catch {
      // A second child-only reset is safe, but first re-establish the exact
      // branch and annotation guard after an ambiguous control-plane result.
      await getGuardedBranch(branch);
      result = await resetPassword();
    }
    const value = result.value as z.infer<typeof roleOperationsResponseSchema>;
    if (
      value.role.branch_id !== verified.id ||
      value.role.name !== config.runtimeRole
    )
      throw new NeonRecoveryError("Neon reset a different role credential");
    await waitForOperations(value.operations);
  };

  const getDirectRestoreUri = async (
    branch: RecoveryBranch,
  ): Promise<string> => {
    const verified = await getGuardedBranch(branch);
    const query = new URLSearchParams({
      branch_id: verified.id,
      database_name: config.databaseName,
      role_name: config.runtimeRole,
      pooled: "false",
    });
    const result = await request(
      `/projects/${config.projectId}/connection_uri?${query}`,
      { method: "GET" },
      connectionUriResponseSchema,
      [],
    );
    const uri = (result.value as z.infer<typeof connectionUriResponseSchema>)
      .uri;
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new NeonRecoveryError(
        "Neon returned an unsafe restore database URI",
      );
    }
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      decodeURIComponent(parsed.username) !== config.runtimeRole ||
      parsed.password.length === 0 ||
      decodeURIComponent(parsed.pathname.slice(1)) !== config.databaseName ||
      !parsed.hostname.endsWith(".neon.tech") ||
      parsed.hostname.includes("-pooler.") ||
      parsed.searchParams.get("sslmode") !== "require"
    )
      throw new NeonRecoveryError(
        "Neon returned an unsafe restore database URI",
      );
    return uri;
  };

  const rotateGuardedEndpoint = async (branch: RecoveryBranch) => {
    const verified = await getGuardedBranch(branch);
    const list = async () => {
      const result = await request(
        `/projects/${config.projectId}/endpoints`,
        { method: "GET" },
        endpointsResponseSchema,
        [],
      );
      return (
        result.value as z.infer<typeof endpointsResponseSchema>
      ).endpoints.filter(
        (endpoint) =>
          endpoint.branch_id === verified.id && endpoint.type === "read_write",
      );
    };
    const existing = await list();
    if (existing.length !== 1)
      throw new NeonRecoveryError(
        "Guarded recovery branch must have one read-write endpoint",
      );
    const predecessor = existing[0] as z.infer<typeof endpointSchema>;
    try {
      const deleted = await request(
        `/projects/${config.projectId}/endpoints/${predecessor.id}`,
        { method: "DELETE" },
        endpointOperationsResponseSchema,
        [204],
      );
      if (deleted.status !== 204) {
        const value = deleted.value as z.infer<
          typeof endpointOperationsResponseSchema
        >;
        if (
          value.endpoint.id !== predecessor.id ||
          value.endpoint.branch_id !== verified.id
        )
          throw new NeonRecoveryError("Neon deleted a different endpoint");
        await waitForOperations(value.operations);
      }
    } catch (error) {
      if ((await list()).some((endpoint) => endpoint.id === predecessor.id))
        throw error;
    }
    if ((await list()).length !== 0)
      throw new NeonRecoveryError("Predecessor recovery endpoint remained");

    let replacement: z.infer<typeof endpointSchema> | undefined;
    try {
      const created = await request(
        `/projects/${config.projectId}/endpoints`,
        {
          method: "POST",
          body: JSON.stringify({
            endpoint: { branch_id: verified.id, type: "read_write" },
          }),
        },
        endpointOperationsResponseSchema,
        [],
      );
      const value = created.value as z.infer<
        typeof endpointOperationsResponseSchema
      >;
      replacement = value.endpoint;
      await waitForOperations(value.operations);
    } catch (error) {
      const reconciled = await list();
      if (reconciled.length !== 1) throw error;
      replacement = reconciled[0];
    }
    const reconciled = await list();
    if (
      replacement === undefined ||
      reconciled.length !== 1 ||
      reconciled[0]?.id !== replacement.id ||
      replacement.branch_id !== verified.id ||
      replacement.id === predecessor.id ||
      replacement.host === predecessor.host
    )
      throw new NeonRecoveryError(
        "Recovery endpoint rotation did not converge",
      );
    return {
      predecessorEndpointId: predecessor.id,
      replacementEndpointId: replacement.id,
    } as const;
  };

  async function getGuardedBranch(expected: RecoveryBranch) {
    validateRecoveryBranch(expected);
    const result = await request(
      `/projects/${config.projectId}/branches/${expected.id}`,
      { method: "GET" },
      branchResponseSchema,
      [],
    );
    const value = result.value as z.infer<typeof branchResponseSchema>;
    const branch = value.branch;
    if (
      !exactBranch(branch, expected, config.projectId) ||
      !exactRecoveryAnnotation(value.annotation, branch.id, expected)
    )
      throw new NeonRecoveryError("Neon child branch identity guard failed");
    return branch;
  }

  const deleteGuardedBranch = async (
    expected: RecoveryBranch,
  ): Promise<"deleted" | "absent"> => {
    validateRecoveryBranch(expected);
    const current = await request(
      `/projects/${config.projectId}/branches/${expected.id}`,
      { method: "GET" },
      branchResponseSchema,
      [404],
    );
    if (current.status === 404) return "absent";
    const currentValue = current.value as z.infer<typeof branchResponseSchema>;
    const branch = currentValue.branch;
    if (
      !exactBranch(branch, expected, config.projectId) ||
      !exactRecoveryAnnotation(currentValue.annotation, branch.id, expected)
    )
      throw new NeonRecoveryError("Neon child branch deletion guard failed");
    let deleted: {
      readonly status: number;
      readonly value?: z.infer<typeof branchOperationsResponseSchema>;
    };
    try {
      deleted = await request(
        `/projects/${config.projectId}/branches/${expected.id}`,
        { method: "DELETE" },
        branchOperationsResponseSchema,
        [],
      );
    } catch (error) {
      const state = await request(
        `/projects/${config.projectId}/branches/${expected.id}`,
        { method: "GET" },
        branchResponseSchema,
        [404],
      );
      if (state.status === 404) return "deleted";
      const stateValue = state.value as z.infer<typeof branchResponseSchema>;
      if (
        !exactBranch(stateValue.branch, expected, config.projectId) ||
        !exactRecoveryAnnotation(stateValue.annotation, expected.id, expected)
      )
        throw new NeonRecoveryError(
          "Neon child branch deletion reconciliation guard failed",
        );
      throw error;
    }
    const deletion = deleted.value as z.infer<
      typeof branchOperationsResponseSchema
    >;
    if (!exactBranch(deletion.branch, expected, config.projectId))
      throw new NeonRecoveryError(
        "Neon deleted a branch outside the guarded identity",
      );
    await waitForOperations(deletion.operations);
    const reconciled = await request(
      `/projects/${config.projectId}/branches/${expected.id}`,
      { method: "GET" },
      branchResponseSchema,
      [404],
    );
    if (reconciled.status !== 404)
      throw new NeonRecoveryError(
        "Neon child branch remained present after deletion",
      );
    return "deleted";
  };

  function validateRecoveryBranch(expected: RecoveryBranch) {
    branchIdSchema.parse(expected.id);
    z.string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u)
      .parse(expected.name);
    canonicalTimestampSchema.parse(expected.parentTimestamp);
    if (
      expected.parentId !== config.parentBranchId ||
      expected.id === config.parentBranchId ||
      !expected.name.startsWith(config.branchNamePrefix)
    )
      throw new NeonRecoveryError(
        "Neon child branch is not under the configured recovery parent",
      );
  }

  return {
    findGuardedPitrBranch,
    reconcilePitrBranch,
    resetRestoreRuntimePassword,
    getDirectRestoreUri,
    rotateGuardedEndpoint,
    deleteGuardedBranch,
  } as const;
};
