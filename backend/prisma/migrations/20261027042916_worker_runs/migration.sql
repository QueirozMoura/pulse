-- CreateTable
CREATE TABLE "worker_runs" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT,
    "checks_claimed" INTEGER NOT NULL DEFAULT 0,
    "checks_recorded" INTEGER NOT NULL DEFAULT 0,
    "alerts_sent" INTEGER NOT NULL DEFAULT 0,
    "alerts_retried" INTEGER NOT NULL DEFAULT 0,
    "alerts_failed" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "worker_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_runs_started_at_idx" ON "worker_runs"("started_at");

-- CreateIndex
CREATE INDEX "worker_runs_status_finished_at_idx" ON "worker_runs"("status", "finished_at");
