-- CreateEnum
CREATE TYPE "PlatformAnnouncementDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- AlterTable
ALTER TABLE "platform_announcement_deliveries" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "leaseUntil" TIMESTAMP(3),
ADD COLUMN     "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "notificationId" TEXT,
ADD COLUMN     "status" "PlatformAnnouncementDeliveryStatus" NOT NULL DEFAULT 'PENDING',
ALTER COLUMN "deliveredAt" DROP NOT NULL,
ALTER COLUMN "deliveredAt" DROP DEFAULT;

-- `updatedAt` con DEFAULT, y el DEFAULT se queda (el modelo lo declara `@default(now())`).
-- Dos motivos, no uno: (1) esta tabla ya existe en `main` (la creó 20260827114447) y puede
-- tener filas, y Postgres rechaza una columna NOT NULL sin default sobre datos; (2) Render
-- aplica las migraciones en el BUILD, con el servidor VIEJO aún sirviendo: su cliente Prisma
-- no conoce esta columna y sus INSERT la omiten, así que sin default en la BASE el publicador
-- de anuncios rompería en producción hasta que arranque el servidor nuevo.
ALTER TABLE "platform_announcement_deliveries" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "platform_announcement_deliveries_status_nextAttemptAt_idx" ON "platform_announcement_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "platform_announcement_deliveries_status_leaseUntil_idx" ON "platform_announcement_deliveries"("status", "leaseUntil");

