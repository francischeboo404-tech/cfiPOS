#!/usr/bin/env bash
# ==============================================================================
# cfi-POS Techiez - Automated Backup Restore Verification Script
#
# Restores a given backup file into an isolated scratch database, executes
# schema and data sanity verification queries, and drops the scratch database.
#
# Usage:
#   ./scripts/restore-test.sh <path-to-backup-file>
#
# Environment variables:
#   RESTORE_TEST_DATABASE_URL     - Required admin URL for a dedicated, non-production restore-test server
# ==============================================================================

set -euo pipefail

BACKUP_FILE="${1:-}"

if [ -z "$BACKUP_FILE" ]; then
    echo "Usage: $0 <path-to-backup-file>" >&2
    exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
    echo "ERROR: Backup file does not exist: $BACKUP_FILE" >&2
    exit 1
fi

if [ ! -s "$BACKUP_FILE" ]; then
    echo "ERROR: Backup file is empty: $BACKUP_FILE" >&2
    exit 1
fi

# Locate pg_restore and psql
PG_RESTORE_BIN="pg_restore"
PSQL_BIN="psql"

if ! command -v "$PG_RESTORE_BIN" >/dev/null 2>&1; then
    for pg_candidate in "/c/Program Files/PostgreSQL"/*/bin/pg_restore.exe "C:/Program Files/PostgreSQL"/*/bin/pg_restore.exe; do
        if [ -f "$pg_candidate" ]; then
            PG_RESTORE_BIN="$pg_candidate"
            break
        fi
    done
fi

if ! command -v "$PSQL_BIN" >/dev/null 2>&1; then
    for pg_candidate in "/c/Program Files/PostgreSQL"/*/bin/psql.exe "C:/Program Files/PostgreSQL"/*/bin/psql.exe; do
        if [ -f "$pg_candidate" ]; then
            PSQL_BIN="$pg_candidate"
            break
        fi
    done
fi

if [ -z "${RESTORE_TEST_DATABASE_URL:-}" ]; then
    echo "ERROR: RESTORE_TEST_DATABASE_URL must point to a dedicated, non-production PostgreSQL server." >&2
    exit 1
fi

if ! command -v "$PG_RESTORE_BIN" >/dev/null 2>&1 && [ ! -f "$PG_RESTORE_BIN" ]; then
    echo "ERROR: pg_restore utility not found on PATH or in standard locations." >&2
    exit 1
fi

if ! command -v "$PSQL_BIN" >/dev/null 2>&1 && [ ! -f "$PSQL_BIN" ]; then
    echo "ERROR: psql utility not found on PATH or in standard locations." >&2
    exit 1
fi

TARGET_URL="$RESTORE_TEST_DATABASE_URL"
SCRATCH_DB="cfi_pos_restore_test_$(date +%s)_$$"
SCRATCH_CREATED=0

echo "=================================================================="
echo "Starting Restore Verification Test"
echo "Source archive: ${BACKUP_FILE}"
echo "Scratch database: ${SCRATCH_DB}"
echo "=================================================================="

# Function to run SQL on administrative database
run_admin_sql() {
    local sql="$1"
    "$PSQL_BIN" "$TARGET_URL" -v ON_ERROR_STOP=1 -c "$sql"
}

cleanup() {
    local exit_code=$?
    trap - EXIT
    echo "Cleaning up scratch database: ${SCRATCH_DB}..."
    if [ "$SCRATCH_CREATED" -eq 1 ] &&
        ! run_admin_sql "DROP DATABASE \"${SCRATCH_DB}\" WITH (FORCE);"; then
        echo "ERROR: Failed to drop scratch database ${SCRATCH_DB}." >&2
        exit_code=1
    fi
    if [ $exit_code -eq 0 ]; then
        echo "=================================================================="
        echo "[SUCCESS] Backup verification PASSED cleanly."
        echo "=================================================================="
    else
        echo "=================================================================="
        echo "[FAILURE] Backup verification FAILED."
        echo "=================================================================="
    fi
    exit "$exit_code"
}
trap cleanup EXIT

# Validate the archive before provisioning the scratch database.
"$PG_RESTORE_BIN" --list "$BACKUP_FILE" >/dev/null

# Build a scratch connection URL while preserving query parameters.
SCRATCH_URL="$(printf '%s\n' "$TARGET_URL" | sed -E "s|/[^/?]+(\?.*)?$|/${SCRATCH_DB}\1|")"
if [ "$SCRATCH_URL" = "$TARGET_URL" ]; then
    echo "ERROR: RESTORE_TEST_DATABASE_URL must include a database name in its URL path." >&2
    exit 1
fi

# 1. Create scratch database
echo "Creating isolated scratch database: ${SCRATCH_DB}..."
run_admin_sql "CREATE DATABASE \"${SCRATCH_DB}\";"
SCRATCH_CREATED=1

# 2. Restore backup into scratch database
echo "Restoring backup archive with ${PG_RESTORE_BIN}..."
"$PG_RESTORE_BIN" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    --single-transaction \
    --dbname="$SCRATCH_URL" \
    "$BACKUP_FILE"

# 3. Execute Sanity Queries
echo "Executing sanity assertions against restored database..."

run_scratch_query() {
    local sql="$1"
    "$PSQL_BIN" "$SCRATCH_URL" -t -A -v ON_ERROR_STOP=1 -c "$sql"
}

MIGRATION_COUNT=$(run_scratch_query "SELECT count(*) FROM migrations;")
echo "  [Sanity] Applied migrations count: ${MIGRATION_COUNT}"
if [ "$MIGRATION_COUNT" -le 0 ]; then
    echo "ERROR: Migrations table is missing or empty in restored database." >&2
    exit 1
fi

CORE_TABLE_COUNT=$(run_scratch_query "SELECT count(*) FROM (VALUES ('users'), ('products'), ('sales'), ('stock_movements')) AS expected(table_name) WHERE to_regclass('public.' || table_name) IS NOT NULL;")
echo "  [Sanity] Required core tables present: ${CORE_TABLE_COUNT}/4"
if [ "$CORE_TABLE_COUNT" -ne 4 ]; then
    echo "ERROR: One or more required core tables are missing from the restored database." >&2
    exit 1
fi

USER_COUNT=$(run_scratch_query "SELECT count(*) FROM users;")
echo "  [Sanity] System users count: ${USER_COUNT}"

PRODUCT_COUNT=$(run_scratch_query "SELECT count(*) FROM products;")
echo "  [Sanity] Products count: ${PRODUCT_COUNT}"

SALE_COUNT=$(run_scratch_query "SELECT count(*) FROM sales;")
echo "  [Sanity] Sales ledger count: ${SALE_COUNT}"

TABLE_COUNT=$(run_scratch_query "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")
echo "  [Sanity] Public schema tables count: ${TABLE_COUNT}"

if [ "$TABLE_COUNT" -lt 15 ]; then
    echo "ERROR: Table count in restored database (${TABLE_COUNT}) is lower than expected schema." >&2
    exit 1
fi

echo "Sanity assertions passed: Restored schema contains ${TABLE_COUNT} tables and valid data."
