import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { EtimsService } from "./EtimsService";
import {
    OffEtimsProvider,
    MockEtimsProvider,
    LiveEtimsProvider,
    getEtimsPaymentTypeSettingName,
} from "./EtimsProvider";
import { Sale, EtimsStatus, PaymentMethod } from "../../entity/Sale";
import { CreditNote } from "../../entity/CreditNote";

test("EtimsService.resolveEtimsMode handles environment variables accurately", () => {
    const originalMode = process.env.ETIMS_MODE;
    try {
        delete process.env.ETIMS_MODE;
        EtimsService.resetProvider();
        // In dev and test environments, an unset ETIMS_MODE defaults to 'mock'
        assert.equal(EtimsService.resolveEtimsMode(), "mock");

        process.env.ETIMS_MODE = "off";
        EtimsService.resetProvider();
        assert.equal(EtimsService.resolveEtimsMode(), "off");

        process.env.ETIMS_MODE = "mock";
        EtimsService.resetProvider();
        assert.equal(EtimsService.resolveEtimsMode(), "mock");

        process.env.ETIMS_MODE = "live";
        EtimsService.resetProvider();
        assert.throws(
            () => EtimsService.resolveEtimsMode(),
            /Live eTIMS is disabled until the KRA VSCU integration is implemented and verified/,
        );

        process.env.ETIMS_MODE = "unsupported_mode";
        EtimsService.resetProvider();
        assert.throws(
            () => EtimsService.resolveEtimsMode(),
            /Invalid ETIMS_MODE/,
        );
    } finally {
        if (originalMode !== undefined) {
            process.env.ETIMS_MODE = originalMode;
        } else {
            delete process.env.ETIMS_MODE;
        }
        EtimsService.resetProvider();
    }
});

test("OffEtimsProvider returns null signatures for sales and credit notes", async () => {
    const provider = new OffEtimsProvider();
    assert.equal(provider.mode, "off");

    const dummySale = new Sale();
    dummySale.id = "test-sale-off";
    dummySale.total_amount = 500;
    const invoiceResult = await provider.signInvoice(dummySale);
    assert.equal(invoiceResult, null);

    const dummyCreditNote = new CreditNote();
    dummyCreditNote.id = "test-cn-off";
    dummyCreditNote.amount = 500;
    const cnResult = await provider.signCreditNote(dummyCreditNote);
    assert.equal(cnResult, null);
});

test("eTIMS payment mapping rejects hybrid and unknown tender methods", () => {
    assert.equal(getEtimsPaymentTypeSettingName(PaymentMethod.CASH), "ETIMS_PAYMENT_TYPE_CASH");
    assert.equal(getEtimsPaymentTypeSettingName(PaymentMethod.MPESA), "ETIMS_PAYMENT_TYPE_MPESA");
    assert.equal(getEtimsPaymentTypeSettingName(PaymentMethod.STORE_CREDIT), "ETIMS_PAYMENT_TYPE_STORE_CREDIT");
    assert.throws(
        () => getEtimsPaymentTypeSettingName(PaymentMethod.HYBRID),
        /does not support hybrid-tender sales/,
    );
    assert.throws(
        () => getEtimsPaymentTypeSettingName("unknown"),
        /does not support payment method 'unknown'/,
    );
});

test("MockEtimsProvider produces valid simulated signatures and QR codes", async () => {
    const provider = new MockEtimsProvider();
    assert.equal(provider.mode, "mock");
    const originalSaleQrUrl = process.env.ETIMS_QR_VERIFY_URL;
    const originalCreditNoteQrUrl = process.env.ETIMS_CREDIT_NOTE_QR_VERIFY_URL;

    try {
        process.env.ETIMS_QR_VERIFY_URL = "https://kra.go.ke/verify";
        process.env.ETIMS_CREDIT_NOTE_QR_VERIFY_URL = "https://kra.go.ke/verify-cn";

        const dummySale = new Sale();
        dummySale.id = "11111111-2222-3333-4444-555555555555";
        dummySale.total_amount = 1500;
        dummySale.created_at = new Date("2026-10-12T12:00:00Z");

        const signedSale = await provider.signInvoice(dummySale);
        assert.ok(signedSale);
        assert.match(signedSale.receipt_no, /^TEST-ETIMS-/);
        assert.match(signedSale.signature, /^TEST-SIG-/);
        assert.equal(new URL(signedSale.qr_code).hostname, "etims.invalid");
        assert.equal(new URL(signedSale.qr_code).searchParams.get("mock"), "true");
        assert.ok(signedSale.qr_code.includes(signedSale.receipt_no));

        const dummyCreditNote = new CreditNote();
        dummyCreditNote.id = "66666666-7777-8888-9999-000000000000";
        dummyCreditNote.amount = 300;
        dummyCreditNote.created_at = new Date("2026-10-12T12:00:00Z");

        const signedCN = await provider.signCreditNote(dummyCreditNote);
        assert.ok(signedCN);
        assert.match(signedCN.note_no, /^TEST-CN-ETIMS-/);
        assert.match(signedCN.signature, /^TEST-CNSIG-/);
        assert.equal(new URL(signedCN.qr_code).hostname, "etims.invalid");
        assert.equal(new URL(signedCN.qr_code).searchParams.get("mock"), "true");
        assert.ok(signedCN.qr_code.includes(signedCN.note_no));
    } finally {
        if (originalSaleQrUrl === undefined) {
            delete process.env.ETIMS_QR_VERIFY_URL;
        } else {
            process.env.ETIMS_QR_VERIFY_URL = originalSaleQrUrl;
        }
        if (originalCreditNoteQrUrl === undefined) {
            delete process.env.ETIMS_CREDIT_NOTE_QR_VERIFY_URL;
        } else {
            process.env.ETIMS_CREDIT_NOTE_QR_VERIFY_URL = originalCreditNoteQrUrl;
        }
    }
});

test("LiveEtimsProvider remains unavailable until the KRA VSCU integration is verified", async () => {
    const originalPin = process.env.ETIMS_KRA_PIN;
    const originalBranch = process.env.ETIMS_BRANCH_ID;
    const originalSerial = process.env.ETIMS_DEVICE_SERIAL;

    try {
        delete process.env.ETIMS_KRA_PIN;
        process.env.ETIMS_KRA_PIN = "P051234567X";
        process.env.ETIMS_BRANCH_ID = "00";
        process.env.ETIMS_DEVICE_SERIAL = "OSCU-TEST-001";

        assert.throws(
            () => new LiveEtimsProvider(),
            /Live eTIMS is disabled until the KRA VSCU integration is implemented and verified/,
        );
    } finally {
        if (originalPin) process.env.ETIMS_KRA_PIN = originalPin; else delete process.env.ETIMS_KRA_PIN;
        if (originalBranch) process.env.ETIMS_BRANCH_ID = originalBranch; else delete process.env.ETIMS_BRANCH_ID;
        if (originalSerial) process.env.ETIMS_DEVICE_SERIAL = originalSerial; else delete process.env.ETIMS_DEVICE_SERIAL;
    }
});

test("Production startup fails fast when ETIMS_MODE is missing or invalid", () => {
    const serverDir = path.resolve(__dirname, "../../..");
    const result = spawnSync(
        process.execPath,
        [
            "--require",
            "ts-node/register",
            "-e",
            "require('./src/index')",
        ],
        {
            cwd: serverDir,
            encoding: "utf8",
            env: {
                PATH: process.env.PATH,
                NODE_ENV: "production",
                PORT: "9999",
                DATABASE_URL: "postgresql://localhost:5432/pos_test",
                ENCRYPTION_KEY: "a".repeat(64),
                JWT_SECRET: "b".repeat(64),
                TYPEORM_SYNCHRONIZE: "false",
                // Whitespace is semantically missing and prevents the root .env fallback.
                ETIMS_MODE: " ",
            },
        },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ETIMS_MODE must be explicitly set/);
});
