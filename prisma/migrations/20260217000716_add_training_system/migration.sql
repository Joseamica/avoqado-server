-- CreateEnum
CREATE TYPE "public"."TrainingCategory" AS ENUM ('VENTAS', 'INVENTARIO', 'PAGOS', 'ATENCION_CLIENTE', 'GENERAL');

-- CreateEnum
CREATE TYPE "public"."TrainingDifficulty" AS ENUM ('BASIC', 'INTERMEDIATE');

-- CreateEnum
CREATE TYPE "public"."TrainingStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "public"."TrainingMediaType" AS ENUM ('IMAGE', 'VIDEO');

-- AlterTable
ALTER TABLE "public"."Organization" ALTER COLUMN "type" SET DEFAULT 'OTHER';

-- CreateTable
CREATE TABLE "public"."training_modules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "coverImageUrl" TEXT,
    "category" "public"."TrainingCategory" NOT NULL DEFAULT 'GENERAL',
    "difficulty" "public"."TrainingDifficulty" NOT NULL DEFAULT 'BASIC',
    "estimatedMinutes" INTEGER NOT NULL DEFAULT 5,
    "isRequired" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "status" "public"."TrainingStatus" NOT NULL DEFAULT 'DRAFT',
    "featureTags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdBy" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_modules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."training_steps" (
    "id" TEXT NOT NULL,
    "trainingModuleId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "mediaType" "public"."TrainingMediaType" NOT NULL DEFAULT 'IMAGE',
    "mediaUrl" TEXT,
    "thumbnailUrl" TEXT,
    "tipText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "training_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."training_quiz_questions" (
    "id" TEXT NOT NULL,
    "trainingModuleId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" TEXT[],
    "correctIndex" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "training_quiz_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."training_progress" (
    "id" TEXT NOT NULL,
    "trainingModuleId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "lastStepViewed" INTEGER NOT NULL DEFAULT 0,
    "isCompleted" BOOLEAN NOT NULL DEFAULT false,
    "quizScore" INTEGER,
    "quizTotal" INTEGER,
    "quizPassed" BOOLEAN,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "training_progress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "training_steps_trainingModuleId_stepNumber_key" ON "public"."training_steps"("trainingModuleId", "stepNumber");

-- CreateIndex
CREATE UNIQUE INDEX "training_progress_trainingModuleId_staffId_key" ON "public"."training_progress"("trainingModuleId", "staffId");

-- AddForeignKey
ALTER TABLE "public"."training_modules" ADD CONSTRAINT "training_modules_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."training_steps" ADD CONSTRAINT "training_steps_trainingModuleId_fkey" FOREIGN KEY ("trainingModuleId") REFERENCES "public"."training_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."training_quiz_questions" ADD CONSTRAINT "training_quiz_questions_trainingModuleId_fkey" FOREIGN KEY ("trainingModuleId") REFERENCES "public"."training_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."training_progress" ADD CONSTRAINT "training_progress_trainingModuleId_fkey" FOREIGN KEY ("trainingModuleId") REFERENCES "public"."training_modules"("id") ON DELETE CASCADE ON UPDATE CASCADE;
