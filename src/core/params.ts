// Parameter schemas shared by the CLI, the dashboard HTTP API and the MCP
// server, so every surface accepts and rejects the same values (AUDIT-3).

import { z } from 'zod';

/** Kinds a search can filter on. `module` symbols are never search hits, so it is rejected. */
export const SEARCH_KINDS = ['function', 'method', 'class', 'interface', 'type', 'variable'] as const;

export class ParamError extends Error {}

export function intParam(name: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  const message =
    max === Number.MAX_SAFE_INTEGER
      ? `${name} must be an integer ≥ ${min}`
      : `${name} must be an integer from ${min} to ${max}`;
  return z.number({ invalid_type_error: message }).int(message).min(min, message).max(max, message);
}

function nonEmpty(name: string) {
  return z.string().trim().min(1, `${name} must not be empty`);
}

export const kindSchema = z.enum(SEARCH_KINDS, {
  errorMap: (issue, ctx) => ({
    message:
      issue.code === 'invalid_enum_value'
        ? `unknown kind '${String(issue.received)}' (expected ${SEARCH_KINDS.join(', ')})`
        : ctx.defaultError,
  }),
});

export const searchParams = {
  query: nonEmpty('query'),
  kind: z.array(kindSchema).optional(),
  file: z.string().optional(),
  limit: intParam('limit', 1, 100).default(10),
};
export const SearchParamsSchema = z.object(searchParams);
export type SearchParams = z.infer<typeof SearchParamsSchema>;

export const askParams = {
  question: nonEmpty('question'),
  k: intParam('k', 1, 20).default(5),
  expand: intParam('expand', 0, 20).default(5),
};
export const AskParamsSchema = z.object(askParams);
export type AskParams = z.infer<typeof AskParamsSchema>;

// Graph and drift responses are bounded by default so an RPC reply stays far
// below the MCP SDK's 10 MiB stdio limit at any repo size (AUDIT-2 A2-04).
// The CLI exports everything unless `--limit` is given.
export const graphParams = {
  file: z.string().optional(),
  symbol: nonEmpty('symbol').optional(),
  depth: intParam('depth', 1, 3).default(1),
  limit: intParam('limit', 1, 5000).default(1000),
  edgeLimit: intParam('edgeLimit', 1, 10000).default(2000),
  offset: intParam('offset', 0).default(0),
};
export const GraphParamsSchema = z.object(graphParams);
export type GraphParams = z.infer<typeof GraphParamsSchema>;

export const driftParams = {
  limit: intParam('limit', 1, 1000).default(100),
  offset: intParam('offset', 0).default(0),
};
export const DriftParamsSchema = z.object(driftParams);
export type DriftParams = z.infer<typeof DriftParamsSchema>;

export const budgetSchema = intParam('budget', 1);
export const portSchema = intParam('port', 0, 65535);

/** Validate `raw` against `schema`; throws a `ParamError` naming every bad parameter. */
export function parseParams<S extends z.ZodTypeAny>(schema: S, raw: unknown): z.output<S> {
  const res = schema.safeParse(raw);
  if (res.success) return res.data as z.output<S>;
  throw new ParamError([...new Set(res.error.issues.map((i) => i.message))].join('; '));
}

/** A CLI/query-string number: absent stays undefined, anything else must be numeric. */
export function numberArg(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  return value.trim() === '' ? Number.NaN : Number(value);
}

/** A comma-separated CLI/query-string list, trimmed, blanks dropped. */
export function listArg(value: string | null | undefined): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
