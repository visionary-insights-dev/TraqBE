-- AlterTable
ALTER TABLE "audit_logs" ADD COLUMN     "new_state" JSONB,
ADD COLUMN     "previous_state" JSONB;

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_created_at_idx" ON "audit_logs"("organization_id", "created_at");
