-- CreateEnum
CREATE TYPE "public"."AppEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateTable
CREATE TABLE "public"."AppUpdate" (
    "id" TEXT NOT NULL,
    "versionName" TEXT NOT NULL,
    "versionCode" INTEGER NOT NULL,
    "environment" "public"."AppEnvironment" NOT NULL,
    "releaseNotes" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "downloadUrl" TEXT NOT NULL,
    "fileSize" BIGINT NOT NULL,
    "checksum" TEXT NOT NULL,
    "minAndroidSdk" INTEGER NOT NULL DEFAULT 27,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "uploadedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AppUpdate_environment_isActive_idx" ON "public"."AppUpdate"("environment", "isActive");

-- CreateIndex
CREATE INDEX "AppUpdate_versionCode_idx" ON "public"."AppUpdate"("versionCode");

-- CreateIndex
CREATE UNIQUE INDEX "AppUpdate_versionCode_environment_key" ON "public"."AppUpdate"("versionCode", "environment");

-- AddForeignKey
ALTER TABLE "public"."AppUpdate" ADD CONSTRAINT "AppUpdate_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "public"."Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
