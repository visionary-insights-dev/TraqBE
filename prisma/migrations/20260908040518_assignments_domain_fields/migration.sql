/*
  Warnings:

  - Added the required column `assignment_id` to the `assignment_change_requests` table without a default value. This is not possible if the table is not empty.
  - Added the required column `field` to the `assignment_change_requests` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "assignment_change_requests" ADD COLUMN     "admin_note" TEXT,
ADD COLUMN     "assignment_id" UUID NOT NULL,
ADD COLUMN     "current_value" JSON,
ADD COLUMN     "field" TEXT NOT NULL,
ADD COLUMN     "requested_value" JSON,
ALTER COLUMN "scholar_assignment_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "assignments" ADD COLUMN     "created_by" UUID,
ADD COLUMN     "edit_window_expires_at" TIMESTAMPTZ;

-- AlterTable
ALTER TABLE "scholar_assignments" ADD COLUMN     "earned_credit" DOUBLE PRECISION,
ADD COLUMN     "is_late" BOOLEAN;

-- CreateIndex
CREATE INDEX "assignment_change_requests_assignment_id_idx" ON "assignment_change_requests"("assignment_id");

-- CreateIndex
CREATE INDEX "assignments_created_by_idx" ON "assignments"("created_by");

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignment_change_requests" ADD CONSTRAINT "assignment_change_requests_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
