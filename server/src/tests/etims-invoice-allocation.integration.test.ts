import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const loadModule = createRequire(__filename);
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
    throw new Error("eTIMS allocator integration test requires TEST_DATABASE_URL.");
}

const testDatabaseName = decodeURIComponent(new URL(testDatabaseUrl).pathname.replace(/^\/+/, ""));
if (!/test|testing|integration/i.test(testDatabaseName)) {
    throw new Error("TEST_DATABASE_URL must use a database name containing 'test' or 'integration'.");
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = "test";
process.env.TYPEORM_SYNCHRONIZE = "true";

const { AppDataSource } = loadModule("../data-source") as typeof import("../data-source");
const { Sale, PaymentMethod, SaleStatus } = loadModule("../entity/Sale") as typeof import("../entity/Sale");
const { User, AppRole } = loadModule("../entity/User") as typeof import("../entity/User");
const { EtimsInvoiceNumberAllocator } = loadModule(
    "../services/etims/EtimsInvoiceNumberAllocator",
) as typeof import("../services/etims/EtimsInvoiceNumberAllocator");
const { AddEtimsInvoiceNumberAllocation1792480600000 } = loadModule(
    "../migration/1792480600000-AddEtimsInvoiceNumberAllocation",
) as typeof import("../migration/1792480600000-AddEtimsInvoiceNumberAllocation");

const allocatedSaleIds: string[] = [];
let testUserId = "";
let firstInvoiceNumber = 0;
let unallocatedSaleId = "";

test.before(async () => {
    await AppDataSource.initialize();
    const migrationRunner = AppDataSource.createQueryRunner();
    await migrationRunner.connect();
    try {
        await new AddEtimsInvoiceNumberAllocation1792480600000().up(migrationRunner);
    } finally {
        await migrationRunner.release();
    }

    firstInvoiceNumber = 1000 + (Date.now() % 1_000_000);
    process.env.ETIMS_INITIAL_INVOICE_NUMBER = String(firstInvoiceNumber);

    const user = await AppDataSource.getRepository(User).save(
        AppDataSource.getRepository(User).create({
            email: `etims-allocator-${Date.now()}@example.com`,
            password_hash: "integration-test-only",
            role: AppRole.ADMIN,
            is_active: true,
        }),
    );
    testUserId = user.id;

    const sales = Array.from({ length: 51 }, () =>
        AppDataSource.getRepository(Sale).create({
            cashier: user,
            subtotal: 100,
            tax_amount: 0,
            total_amount: 100,
            payment_method: PaymentMethod.CASH,
            status: SaleStatus.COMPLETED,
        }),
    );
    const savedSales = await AppDataSource.getRepository(Sale).save(sales);
    allocatedSaleIds.push(...savedSales.map((sale: InstanceType<typeof Sale>) => sale.id));
    unallocatedSaleId = savedSales[50].id;
});

test.after(async () => {
    if (AppDataSource.isInitialized) {
        if (allocatedSaleIds.length > 0) {
            await AppDataSource.getRepository(Sale).delete(allocatedSaleIds);
        }
        if (testUserId) {
            await AppDataSource.getRepository(User).delete(testUserId);
        }
        await AppDataSource.destroy();
    }
});

test("PostgreSQL allocator assigns unique, contiguous invoice numbers to concurrent sales", async () => {
    const allocatedNumbers = await Promise.all(
        allocatedSaleIds.slice(0, 50).map(async (saleId: string) => {
            const sale = await AppDataSource.getRepository(Sale).findOneByOrFail({ id: saleId });
            return EtimsInvoiceNumberAllocator.reserveForSale(sale);
        }),
    );

    assert.equal(allocatedNumbers.length, 50);
    assert.equal(new Set(allocatedNumbers).size, 50, "allocator returned duplicate invoice numbers");
    assert.deepEqual(
        [...allocatedNumbers].sort((left, right) => left - right),
        Array.from({ length: 50 }, (_, index) => firstInvoiceNumber + index),
        "concurrent allocations must be contiguous without gaps",
    );

    const persistedSales: Array<{ etims_invoice_number: string }> = await AppDataSource.query(
        `SELECT "etims_invoice_number"::text AS "etims_invoice_number"
         FROM "sales"
         WHERE "id" = ANY($1::uuid[])`,
        [allocatedSaleIds.slice(0, 50)],
    );
    assert.equal(persistedSales.length, 50);
    assert.deepEqual(
        persistedSales.map((sale) => Number(sale.etims_invoice_number)).sort((a, b) => a - b),
        Array.from({ length: 50 }, (_, index) => firstInvoiceNumber + index),
        "each reserved invoice number must be stored against its sale",
    );

    const counterRows: Array<{ next_invoice_number: string }> = await AppDataSource.query(
        `SELECT "next_invoice_number"::text AS "next_invoice_number"
         FROM "etims_invoice_counters"
         WHERE "id" = 1`,
    );
    assert.equal(Number(counterRows[0]?.next_invoice_number), firstInvoiceNumber + 50);
});

test("concurrent reservations for one sale reuse its number without a seed setting", async () => {
    const sale = await AppDataSource.getRepository(Sale).findOneByOrFail({ id: unallocatedSaleId });
    delete process.env.ETIMS_INITIAL_INVOICE_NUMBER;

    const allocations = await Promise.all(
        Array.from({ length: 10 }, () => EtimsInvoiceNumberAllocator.reserveForSale(sale)),
    );
    const expectedNumber = firstInvoiceNumber + 50;
    assert.deepEqual(allocations, Array.from({ length: 10 }, () => expectedNumber));
    assert.equal(sale.etims_invoice_number, String(expectedNumber));

    const counterRows: Array<{ next_invoice_number: string }> = await AppDataSource.query(
        `SELECT "next_invoice_number"::text AS "next_invoice_number"
         FROM "etims_invoice_counters"
         WHERE "id" = 1`,
    );
    assert.equal(Number(counterRows[0]?.next_invoice_number), firstInvoiceNumber + 51);
});
