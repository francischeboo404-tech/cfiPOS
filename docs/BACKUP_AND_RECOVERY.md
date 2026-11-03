# Database Backup and Recovery Guide

This guide details disaster recovery, automated backup creation, and recovery testing for the **cfi-POS Techiez Limited** production database.

---

## 1. Architecture Overview

- **Engine:** PostgreSQL 15+
- **Backup Format:** PostgreSQL custom archive format (`pg_dump -Fc -Z 9`), compressed and atomic.
- **Location & Artifacts:**
  - Backup creation script: `scripts/backup.sh`
  - Automated restore test script: `scripts/restore-test.sh`
- **Security:**
  - Scripts **never store or hardcode credentials**.
  - Backup connections use `DATABASE_URL`; restore tests require `RESTORE_TEST_DATABASE_URL` for a dedicated, non-production PostgreSQL server.

---

## 2. Backup Execution

### Running Manually

```bash
# Provide DATABASE_URL via environment
export DATABASE_URL="postgresql://user:password@hostname:5432/dbname"
export RETENTION_DAYS=7
export BACKUP_DIR="./backups"

./scripts/backup.sh
```

### Script Behaviors

1. **Atomic Dump:** Creates a compressed dump file `backups/cfi_pos_backup_YYYYMMDD_HHMMSS.dump`.
2. **Retention Policy:** Automatically identifies and removes local backups older than `RETENTION_DAYS` (default: 7 days).
3. **Optional S3 Replication:** If `BACKUP_S3_BUCKET` is configured, automatically replicates the new archive to S3-compatible cloud storage (AWS S3, Cloudflare R2, MinIO, or DigitalOcean Spaces) using `aws s3 cp`.

---

## 3. Restore and Verification Testing

To prevent "silent backup failures" where backups are generated but cannot be restored, run `scripts/restore-test.sh`:

```bash
# Set RESTORE_TEST_ADMIN_URL from the secret manager for a dedicated non-production PostgreSQL server.
# This URL must connect to a database on that server with permission to create databases.
export RESTORE_TEST_DATABASE_URL="${RESTORE_TEST_ADMIN_URL}"
./scripts/restore-test.sh ./backups/cfi_pos_backup_20261013_140000.dump
```

### Verification Flow

1. Connects only to the dedicated server configured by `RESTORE_TEST_DATABASE_URL`; it will not fall back to the production `DATABASE_URL`.
2. Provisions a temporary scratch database `cfi_pos_restore_test_<timestamp>_<pid>`.
3. Validates the archive with `pg_restore --list`, then restores with `--exit-on-error` in a single transaction.
4. Executes sanity queries:
   - Verifies the `migrations` ledger exists and has recorded applied migrations.
   - Verifies `users`, `products`, `sales`, and `stock_movements` tables.
   - Asserts public schema table count >= 15.
5. Fails on restore/query errors and reports failure if scratch-database cleanup fails.
6. Automatically drops the scratch database on exit when it was successfully created.

---

## 4. Scheduling Strategies

### Strategy A: Docker Compose Deployment (Cron Container or Host Cron)

On the Docker host, configure a root or deploy-user crontab (`crontab -e`):
Set `RESTORE_TEST_ADMIN_URL` in the cron environment to a dedicated, non-production PostgreSQL admin connection.

```cron
# Run daily database backup at 02:00 AM EAT
0 2 * * * cd /opt/cfi-pos && DATABASE_URL="postgresql://postgres:secure_pass@localhost:5432/postgres" RETENTION_DAYS=14 BACKUP_DIR="/var/backups/cfi-pos" ./scripts/backup.sh >> /var/log/cfi_pos_backup.log 2>&1

# Run weekly backup restore test on Sunday at 03:00 AM EAT
0 3 * * 0 cd /opt/cfi-pos && RESTORE_TEST_DATABASE_URL="${RESTORE_TEST_ADMIN_URL}" ./scripts/restore-test.sh "$(ls -t /var/backups/cfi-pos/*.dump | head -1)" >> /var/log/cfi_pos_restore_test.log 2>&1
```

### Strategy B: Managed PostgreSQL (Render / Supabase / AWS RDS)

When hosting the backend on Render or similar PaaS with a managed PostgreSQL instance:

1. **Automated Provider Snapshots:** Enable daily automatic backups in the Render/RDS dashboard.
2. **Off-site Disaster Recovery:**
   - Configure a GitHub Actions scheduled workflow or a lightweight Cron job runner using `DATABASE_URL` stored in secret manager.
   - Direct output to an S3-compatible bucket with bucket versioning and object lock enabled:
     ```bash
     export DATABASE_URL="${MANAGED_POSTGRES_EXTERNAL_URL}"
     export BACKUP_S3_BUCKET="cfi-pos-disaster-recovery"
     ./scripts/backup.sh
     ```

---

## 5. Recovery Runbook (Incident Response)

In the event of database corruption or hardware loss:

1. **Provision New Database:** Ensure a clean PostgreSQL instance is running.
2. **Retrieve Latest Verified Backup:**
   ```bash
   aws s3 cp s3://cfi-pos-disaster-recovery/cfi_pos_backup_YYYYMMDD_HHMMSS.dump ./latest.dump
   ```
3. **Verify Archive:**
   Configure `RESTORE_TEST_ADMIN_URL` from the secret manager for the dedicated restore-test server.
   ```bash
   RESTORE_TEST_DATABASE_URL="${RESTORE_TEST_ADMIN_URL}" ./scripts/restore-test.sh ./latest.dump
   ```
4. **Restore to Target Production Database:**
   ```bash
   pg_restore --clean --if-exists --no-owner --no-privileges -d "$DATABASE_URL" ./latest.dump
   ```
5. **Verify Application Readiness:**
   ```bash
   curl -I http://localhost:3000/ready
   # Expected: HTTP 200 {"status":"ready","database":"connected"}
   ```
