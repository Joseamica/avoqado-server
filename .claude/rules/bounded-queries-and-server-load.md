# Bounded Queries and Server Load

This rule is mandatory for every new or changed endpoint, service, MCP tool, job, or export that can
read a tenant-sized collection. Design against 10× and 100× today's largest tenant before coding.

## The contract

- The backend enforces the maximum; never trust a client-provided `limit`. Default to 50 and hard-cap
  normal interactive pages at 100 unless a measured, documented exception proves another value safe.
- Every list is paginated with deterministic ordering and a unique tie-breaker (for example,
  `createdAt DESC, id DESC`). Prefer cursor pagination for hot or very large tables.
- Return pagination metadata (`total`/`totalPages` or `hasMore`/`nextCursor`) so a limit never makes
  records unreachable. A bounded response is not permission to silently truncate the product.
- Search, filters, sorting, tenant scope, and permissions run in the database, before pagination.
- Dashboard cards and charts use `count`, `groupBy`, aggregates, or bounded SQL. Never hydrate the
  entire collection merely to calculate totals.
- Never add an unbounded tenant `findMany`. Every `findMany` needs `take`, a truly unique lookup, or a
  written explanation enforced by the architecture guard. Avoid N+1; batch or aggregate instead.
- Bound parallel work and background fan-out. Retries need backoff/jitter and must not multiply a
  failing database request across every client.

## UX and compatibility

- Keep existing response fields and behavior for released clients. Add fields/endpoints first,
  migrate consumers, observe them, and retire legacy paths only after compatibility is proven.
- Deploy the backend before any consumer that needs the new contract.
- Full exports may traverse bounded pages, use a server export job, or stream. They begin only after
  an explicit user action; an ordinary page load never preloads the complete dataset.
- If a page is capped, its UI must expose the total and a path to every matching record. “First 100”
  without pagination or an explanation is a bug.

## Database design

- Add or verify an index matching tenant scope plus the common filter/order path. Schema changes ship
  with a migration and regenerated `docs/SCHEMA_MAP.md`.
- For new aggregate SQL or a high-cardinality query, inspect the plan on representative large data
  (`EXPLAIN (ANALYZE, BUFFERS)` when safe). A unit test cannot prove a query plan.
- Raw SQL date binds for Prisma `DateTime` columns use `utcTs`, `utcTsOrNull`, or `utcTsParam` from
  `src/utils/sqlDates.ts`; never bind a JavaScript `Date` directly.

## Required verification

- Test the server clamp with a hostile/oversized requested limit.
- Test first page, next page/cursor, filters/search, deterministic ordering, empty results, and the
  aggregate totals independently from the returned row count.
- Test backward compatibility for any existing route or caller.
- Run the module suite plus typecheck/build. For stock, dates, money, permissions, or migrations,
  follow the repository's stricter TDD requirement.
- After deployment, canary the largest safe tenant and check latency, memory, database pressure,
  Better Stack incidents, and `[query-guard]` logs. No “production-safe” claim is complete before
  that observation window.
