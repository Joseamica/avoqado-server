# Repository Guidelines

## Project Structure & Module Organization
- `src/`: Express + TypeScript application.
  - `controllers/`, `services/`, `routes/`, `middlewares/`, `schemas/` (Zod), `communication/` (Socket.IO/RabbitMQ), `utils/`, `config/`.
  - `app.ts`: app wiring; `server.ts`: HTTP entrypoint.
- `prisma/`: `schema.prisma`, `migrations/`, `seed.ts`.
- `tests/`: `unit/`, `api-tests`, `workflows`, `__helpers__`, `__fixtures__`.
- `dist/`: compiled JS (output of `npm run build`).
- `scripts/`: one‑off helpers; `logs/` for runtime logs.

## Build, Test, and Development Commands
- `npm run dev`: start TS server with nodemon + ts-node.
- `npm run build`: compile TypeScript (`tsc` + `tsc-alias`).
- `npm start`: run built app from `dist/`.
- `npm test`: all tests; also `test:unit`, `test:api`, `test:workflows`, `test:watch`, `test:coverage`, `test:ci`.
- Module suites: `test:dashboard`, `test:pos-sync`, `test:tpv`, `test:orders`, `test:auth`, `test:communication`.
- `npm run lint` / `lint:fix`: ESLint checks and autofix.
- `npm run format`: Prettier write.
- `npm run migrate`: Prisma migrate dev; `npm run studio`: Prisma Studio.
- Deploy/CI: `predeploy:backend` runs `prisma generate` + `migrate deploy`.

## Database Operations
- Local dev: `npm run migrate` (creates/updates schema with history).
- Generate client: `npx prisma generate` (runs automatically on deploy script).
- In containers: `docker exec avoqado-server-dev npx prisma migrate deploy`.

## Coding Style & Naming Conventions
- Language: TypeScript. Indent 2 spaces.
- Prettier: single quotes, no semicolons, trailing commas, width 140.
- ESLint: `@typescript-eslint` + Prettier; avoid unused vars; `no-console` warned (allowed in tests).
- Paths: use `@/…` alias (tsconfig-paths).
- Naming: files kebab-case; `*.controller.ts`, `*.service.ts`; classes PascalCase; functions/vars camelCase; tests mirror paths.

## Testing Guidelines
- Framework: Jest + ts-jest (+ Supertest for API).
- Locations: `tests/unit`, `tests/api-tests`, `tests/workflows`.
- Naming: `*.test.ts`, `*.api.test.ts`, `*.workflow.test.ts`.
- Setup: `tests/__helpers__/setup.ts` auto-loaded.
- Coverage: global ≥70%; `src/services/{dashboard,pos-sync}` ≥80% (see `jest.config.js`).
- Example: `npm run test:coverage` to verify thresholds.

## Commit & Pull Request Guidelines
- Conventional Commits: `feat`, `fix`, `chore`, `refactor`, `docs` with optional scope.
  - Example: `feat(notifications): emit notification_new event`
- PRs: clear description, scope, linked issues, test plan (commands), and any DB/ENV changes.
- Before opening: `npm run lint && npm test`. Update `README.md`/Swagger if endpoints change and `.env.example` if adding env vars.

## Security & Configuration Tips
- Never commit secrets; use `.env` (copy from `.env.example`).
- Database: update Prisma schema → `npx prisma generate` and add a migration.
- Required envs: `DATABASE_URL`, `JWT_SECRET`, `SESSION_SECRET`, Redis/RabbitMQ URLs as applicable.

## Architecture Overview
- Domains: Organizations, Venues, Staff (RBAC), Menu/Product, Orders, POS Integration, Payments.
- Technical stack: Express + TypeScript; PostgreSQL + Prisma; Socket.IO (real-time); RabbitMQ (queue); Redis sessions; JWT auth; Zod validation; Jest tests.
- Layered flow: Routes → Middleware → Controllers → Services → Prisma (DB). Controllers stay thin; services hold business logic.
- Key service areas: `src/services/{dashboard,tpv,pos-sync,realtime,storage,auth}` and `src/communication/{sockets,rabbitmq}`.
- Database model: Multi-tenant (Organization → Venue), staff with venue roles, catalog, orders, payments, POS sync tracking.
- Real-time: Socket.IO rooms per venue/user; broadcast business events (orders, payments, notifications).
- Messaging: RabbitMQ for POS command queuing, consumers, retries for failed processing.

## Role Hierarchy (RBAC)
- SUPERADMIN: full-system access across all orgs/venues; cannot be invited.
- OWNER: org-wide access to all venues; manages staff (except SUPERADMIN).
- ADMIN: full access within assigned venues; management and configuration.
- MANAGER: operations within assigned venues (shifts, inventory, reports).
- WAITER: service-level (orders, table service).
- CASHIER: payments and POS operations.
- KITCHEN: kitchen display and prep tracking.
- HOST: reservations and seating.
- VIEWER: read-only access.
- Inheritance: higher roles include lower; middleware enforces role checks and cross-venue access rules.

## Docker Environment
- Development: `docker-compose -f docker-compose.yml -f docker-compose.dev.yml up -d`.
- Production: `docker-compose up -d`.
- Migrations in container: `docker exec avoqado-server-dev npx prisma migrate deploy`.
- Services: app (3000), Postgres (5434), Redis (6379), RabbitMQ (5672/15672).

## Testing Strategy
- Unit (`tests/unit`), API (`tests/api-tests`), Workflow (`tests/workflows`).
- Jest project-based config enables parallel suites; coverage: 70% global, 80% for critical services.

## Development Notes
- Graceful shutdown for HTTP, Socket.IO, RabbitMQ, and DB connections.
- Dev helper: `POST /api/dev/generate-token` issues JWT for testing.
- API docs: Swagger at `/api-docs`.
- Logging: Winston with correlation IDs for request tracing.
- Config: multi-environment via env vars; prefer `.env` for local.

