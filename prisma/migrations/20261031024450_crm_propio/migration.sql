-- CRM propio (spec 2026-10-30): 10 tablas nuevas, sus índices y sus llaves. Aditiva: no altera ninguna tabla existente.
-- Generada con `prisma migrate dev --create-only` contra una base desechable; se quitaron a mano 5 sentencias de
-- deriva que ya existían entre el historial y el esquema de develop (Customer_tags_gin_idx, BirthdayAutomation,
-- PaymentEffect, VenueFeature y el nombre recortado de DocumentRequestDelivery): no son de este cambio.
-- Editada a mano antes de aplicarse en ningún lado (tarea 3, rulings 7, 10, 14 y 15 y N-2): PlatformAccess.staffId
-- único, la tabla CrmTeam con sus llaves (RESTRICT) a Organization y Venue, y los índices de CrmInboundEntry.accountId,
-- CrmActivity.doneById y CrmTimelineEvent.actorStaffId.
-- Tarea 4 (ruling 12), también antes de aplicarse: CrmActivity.assigneeStaffId acepta null (actividad sin responsable).
-- Tarea 9 (rulings 39 y 41), también antes de aplicarse: la tabla CrmHiddenClient (organizaciones internas o de pruebas que
-- nunca salen en «Clientes», CASCADE con Organization) y los índices de los reportes: CrmAccount.wonAt, CrmAccount.lostAt y
-- CrmActivity.doneAt.
-- Revisión final (rulings 49, 50 y 51), también antes de aplicarse: CrmAccount.qualifiedAt, CrmInboundEntry.noticeSentAt y
-- noticeAttempts con su índice (noticeSentAt, receivedAt), y el índice PARCIAL CrmAccount_first_money_pending_idx, que
-- Prisma no sabe expresar (vive sólo aquí; ver el comentario del modelo CrmAccount).

-- CreateTable
CREATE TABLE "PlatformAccess" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "staffId" TEXT,
    "verScope" TEXT,
    "editarScope" TEXT,
    "contactar" BOOLEAN NOT NULL DEFAULT false,
    "campanas" BOOLEAN NOT NULL DEFAULT false,
    "exportar" BOOLEAN NOT NULL DEFAULT false,
    "ventas" BOOLEAN NOT NULL DEFAULT false,
    "admin" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmTeam" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL DEFAULT 'default',
    "organizationId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmTeam_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmAccount" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "giro" TEXT,
    "ventasRango" TEXT,
    "sucursales" INTEGER,
    "modulos" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "source" TEXT NOT NULL,
    "externalKey" TEXT,
    "sourceDetail" JSONB,
    "referidoPor" TEXT,
    "ownerStaffId" TEXT,
    "stageId" TEXT NOT NULL,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastTouchAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "nextActivityAt" TIMESTAMP(3),
    "lostReasonId" TEXT,
    "lostNote" TEXT,
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "organizationId" TEXT,
    "firstMoneyAt" TIMESTAMP(3),
    "firstMoneySource" TEXT,
    "consentMarketing" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentSource" TEXT,
    "consentNoticeVersion" TEXT,
    "qualificationAvailable" BOOLEAN NOT NULL DEFAULT true,
    "qualifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmContact" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneE164" TEXT,
    "email" TEXT,
    "role" TEXT,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmStage" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "staleDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmLostReason" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmLostReason_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "assigneeStaffId" TEXT,
    "doneAt" TIMESTAMP(3),
    "doneById" TEXT,
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmTimelineEvent" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actorStaffId" TEXT,
    "data" JSONB NOT NULL,
    "sourceKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmTimelineEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmInboundEntry" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "signupOutcome" JSONB,
    "signupResolvedAt" TIMESTAMP(3),
    "appliedAt" TIMESTAMP(3),
    "accountId" TEXT,
    "lastError" TEXT,
    "noticeSentAt" TIMESTAMP(3),
    "noticeAttempts" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CrmInboundEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmDigestSend" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT NOT NULL,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDigestSend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmHiddenClient" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmHiddenClient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAccess_email_key" ON "PlatformAccess"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAccess_staffId_key" ON "PlatformAccess"("staffId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTeam_key_key" ON "CrmTeam"("key");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTeam_organizationId_key" ON "CrmTeam"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTeam_venueId_key" ON "CrmTeam"("venueId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmAccount_organizationId_key" ON "CrmAccount"("organizationId");

-- CreateIndex
CREATE INDEX "CrmAccount_ownerStaffId_stageId_idx" ON "CrmAccount"("ownerStaffId", "stageId");

-- CreateIndex
CREATE INDEX "CrmAccount_nextActivityAt_idx" ON "CrmAccount"("nextActivityAt");

-- CreateIndex
CREATE INDEX "CrmAccount_source_organizationId_idx" ON "CrmAccount"("source", "organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmAccount_source_externalKey_key" ON "CrmAccount"("source", "externalKey");

-- CreateIndex
CREATE INDEX "CrmAccount_wonAt_idx" ON "CrmAccount"("wonAt");

-- CreateIndex
CREATE INDEX "CrmAccount_lostAt_idx" ON "CrmAccount"("lostAt");

-- Partial index, by hand (ruling 51): the first-money sweep (`fillFirstMoney`) walks, every 5 minutes, only the linked
-- accounts still without their first money. Prisma cannot express `WHERE` on an index, so `schema.prisma` only names it
-- in a comment; the query writes both conditions as literals, so any plan can prove the predicate.
CREATE INDEX "CrmAccount_first_money_pending_idx" ON "CrmAccount"("createdAt", "id") WHERE "firstMoneyAt" IS NULL AND "organizationId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "CrmContact_accountId_idx" ON "CrmContact"("accountId");

-- CreateIndex
CREATE INDEX "CrmContact_phoneE164_idx" ON "CrmContact"("phoneE164");

-- CreateIndex
CREATE INDEX "CrmContact_email_idx" ON "CrmContact"("email");

-- CreateIndex
CREATE UNIQUE INDEX "CrmStage_name_key" ON "CrmStage"("name");

-- CreateIndex
CREATE UNIQUE INDEX "CrmLostReason_name_key" ON "CrmLostReason"("name");

-- CreateIndex
CREATE INDEX "CrmActivity_assigneeStaffId_doneAt_dueAt_idx" ON "CrmActivity"("assigneeStaffId", "doneAt", "dueAt");

-- CreateIndex
CREATE INDEX "CrmActivity_accountId_idx" ON "CrmActivity"("accountId");

-- CreateIndex
CREATE INDEX "CrmActivity_doneById_idx" ON "CrmActivity"("doneById");

-- CreateIndex
CREATE INDEX "CrmActivity_doneAt_idx" ON "CrmActivity"("doneAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTimelineEvent_sourceKey_key" ON "CrmTimelineEvent"("sourceKey");

-- CreateIndex
CREATE INDEX "CrmTimelineEvent_accountId_createdAt_idx" ON "CrmTimelineEvent"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "CrmTimelineEvent_actorStaffId_idx" ON "CrmTimelineEvent"("actorStaffId");

-- CreateIndex
CREATE INDEX "CrmInboundEntry_appliedAt_idx" ON "CrmInboundEntry"("appliedAt");

-- CreateIndex
CREATE INDEX "CrmInboundEntry_accountId_idx" ON "CrmInboundEntry"("accountId");

-- CreateIndex
CREATE INDEX "CrmInboundEntry_noticeSentAt_receivedAt_idx" ON "CrmInboundEntry"("noticeSentAt", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmDigestSend_staffId_day_kind_key" ON "CrmDigestSend"("staffId", "day", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CrmHiddenClient_organizationId_key" ON "CrmHiddenClient"("organizationId");

-- AddForeignKey
ALTER TABLE "CrmTeam" ADD CONSTRAINT "CrmTeam_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmTeam" ADD CONSTRAINT "CrmTeam_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "Venue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAccount" ADD CONSTRAINT "CrmAccount_ownerStaffId_fkey" FOREIGN KEY ("ownerStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAccount" ADD CONSTRAINT "CrmAccount_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "CrmStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAccount" ADD CONSTRAINT "CrmAccount_lostReasonId_fkey" FOREIGN KEY ("lostReasonId") REFERENCES "CrmLostReason"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAccount" ADD CONSTRAINT "CrmAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmTimelineEvent" ADD CONSTRAINT "CrmTimelineEvent_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmInboundEntry" ADD CONSTRAINT "CrmInboundEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "CrmAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmHiddenClient" ADD CONSTRAINT "CrmHiddenClient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
