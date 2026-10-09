-- Additive: old clients and existing orders retain course/null semantics.
ALTER TABLE "Organization"
  ADD COLUMN "serviceCourses" JSONB,
  ADD COLUMN "serviceCoursesRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "VenueSettings"
  ADD COLUMN "serviceCourses" JSONB,
  ADD COLUMN "serviceCoursesRevision" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "OrderItem" ADD COLUMN "serviceCourse" JSONB;
