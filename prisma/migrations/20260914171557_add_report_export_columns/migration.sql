-- AlterTable
ALTER TABLE "report_exports" ADD COLUMN     "completed_at" TIMESTAMPTZ,
ADD COLUMN     "expires_at" TIMESTAMPTZ,
ADD COLUMN     "format" TEXT NOT NULL DEFAULT 'csv',
ADD COLUMN     "r2_key" TEXT;

-- CreateIndex
CREATE INDEX "report_exports_organization_id_status_idx" ON "report_exports"("organization_id", "status");
