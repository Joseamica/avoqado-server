---
trigger: always_on
---

#Filetree This can be modified, so be aware of changes avoqado-server/ ┣ .vscode/ ┃ ┗ settings.json ┣ .windsurf/ ┃ ┗ rules/ ┃ ┗ rule1.md ┣
logs/ ┃ ┣ avoqado-backend-error.log ┃ ┣ avoqado-backend-out.log ┃ ┣ combined.log ┃ ┣ development.log ┃ ┗ error.log ┣ prisma/ ┃ ┣ migrations/
┃ ┃ ┣ 20250605211518\_/ ┃ ┃ ┃ ┗ migration.sql ┃ ┃ ┗ migration_lock.toml ┃ ┣ schema.prisma ┃ ┗ seed.ts ┣ src/ ┃ ┣ communication/ ┃ ┃ ┣
rabbitmq/ ┃ ┃ ┗ sockets/ ┃ ┣ config/ ┃ ┃ ┣ corsOptions.ts ┃ ┃ ┣ database.ts ┃ ┃ ┣ ecosystem.config.js ┃ ┃ ┣ env.ts ┃ ┃ ┣ logger.ts ┃ ┃ ┣
middleware.ts ┃ ┃ ┣ session.ts ┃ ┃ ┗ swagger.ts ┃ ┣ controllers/ ┃ ┃ ┣ dashboard/ ┃ ┃ ┃ ┣ auth.dashboard.controller.ts ┃ ┃ ┃ ┣
menuCategory.dashboard.controller.ts ┃ ┃ ┃ ┗ venue.dashboard.controller.ts ┃ ┃ ┣ organization/ ┃ ┃ ┣ public/ ┃ ┃ ┗ tpv/ ┃ ┃ ┗
auth.tpv.controller.ts ┃ ┣ errors/ ┃ ┃ ┗ AppError.ts ┃ ┣ middlewares/ ┃ ┃ ┣ authenticateToken.middleware.ts ┃ ┃ ┣
authorizeRole.middleware.ts ┃ ┃ ┣ requestLogger.ts ┃ ┃ ┗ validation.ts ┃ ┣ routes/ ┃ ┃ ┣ **tests**/ ┃ ┃ ┃ ┣ public.routes.test.ts ┃ ┃ ┃ ┗
secure.routes.test.ts ┃ ┃ ┣ dashboard.routes.ts ┃ ┃ ┣ index.ts ┃ ┃ ┣ orders.routes.ts ┃ ┃ ┣ organization.routes.ts ┃ ┃ ┣ products.routes.ts
┃ ┃ ┣ public.routes.ts ┃ ┃ ┣ publicMenu.routes.ts ┃ ┃ ┗ tpv.routes.ts ┃ ┣ schemas/ ┃ ┃ ┣ auth.schema.ts ┃ ┃ ┣ menuCategory.schema.ts ┃ ┃ ┗
venue.schema.ts ┃ ┣ scripts/ ┃ ┣ services/ ┃ ┃ ┣ dashboard/ ┃ ┃ ┃ ┣ auth.service.ts ┃ ┃ ┃ ┣ menuCategory.dashboard.service.ts ┃ ┃ ┃ ┗
venue.dashboard.service.ts ┃ ┃ ┗ tpv/ ┃ ┣ types/ ┃ ┃ ┣ express-session.d.ts ┃ ┃ ┗ express.d.ts ┃ ┣ utils/ ┃ ┃ ┣ prismaClient.ts ┃ ┃ ┗
slugify.ts ┃ ┣ app.ts ┃ ┣ jwt.service.ts ┃ ┣ security.ts ┃ ┗ server.ts ┣ .env ┣ .eslintrc.json ┣ .gitignore ┣ .prettierignore ┣ .prettierrc
┣ README.md ┣ ecosystem.config.js ┣ jest.config.js ┣ package-lock.json ┣ package.json ┗ tsconfig.json
