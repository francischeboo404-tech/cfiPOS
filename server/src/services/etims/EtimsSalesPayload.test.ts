import test from "node:test";
import assert from "node:assert/strict";
import { Sale } from "../../entity/Sale";
import { SaleItem } from "../../entity/SaleItem";
import { buildEtimsSalesPayload, toEtimsSignResult } from "./EtimsSalesPayload";

const settings = {
    tin: "A00XXXXXXXXZ",
    branchId: "00",
    deviceId: "VSCU-TEST-001",
    invoiceNumber: 1024,
    paymentTypeCode: "01",
};

const makeItem = (overrides: Partial<SaleItem> = {}): SaleItem => ({
    product: { name: "Wholesale Bulk Item A" } as SaleItem["product"],
    quantity: 1,
    unit_price: 11.6,
    line_total_cents: "1160",
    discount_cents: "0",
    net_revenue_cents: "1000",
    vat_cents: "160",
    etims_item_snapshot: {
        etims_item_code: "KE12345678",
        etims_item_class_code: "1234567890",
        etims_product_type_code: "2",
        etims_origin_country_code: "KE",
        etims_packaging_unit_code: "BOX",
        etims_quantity_unit_code: "U",
        etims_tax_type_code: "A",
    },
    ...overrides,
}) as SaleItem;

const makeSale = (items: SaleItem[] = [makeItem()]): Sale => ({
    items,
    total_amount: 11.6,
    created_at: new Date("2026-10-20T08:20:00.000Z"),
    customer: null,
} as Sale);

test("buildEtimsSalesPayload maps sale snapshots to the candidate VSCU invoice contract", () => {
    const payload = buildEtimsSalesPayload(makeSale(), settings);
    assert.deepEqual(payload, {
        tin: "A00XXXXXXXXZ",
        bhId: "00",
        dvcId: "VSCU-TEST-001",
        invcNo: 1024,
        orgnInvcNo: 0,
        custTin: "",
        custNm: "Cash Customer",
        salesSttsCd: "02",
        rcptTyCd: "1",
        pmtTyCd: "01",
        lptnDt: "20261020082000",
        totItemCnt: 1,
        taxblAmtA: 10,
        taxAmtA: 1.6,
        totTaxblAmt: 10,
        totTaxAmt: 1.6,
        totAmt: 11.6,
        itemList: [{
            itemSeq: 1,
            itemCd: "KE12345678",
            itemNm: "Wholesale Bulk Item A",
            pkgUnitCd: "BOX",
            qtyUnitCd: "U",
            qty: 1,
            prc: 11.6,
            splyAmt: 11.6,
            dcRt: 0,
            dcAmt: 0,
            taxTyCd: "A",
            taxblAmt: 10,
            taxAmt: 1.6,
            totAmt: 11.6,
        }],
    });
});

test("buildEtimsSalesPayload aggregates tax buckets using exact-cent snapshots", () => {
    const itemA = makeItem({
        line_total_cents: "1160",
        net_revenue_cents: "1000",
        vat_cents: "160",
    });
    const itemB = makeItem({
        unit_price: 5,
        line_total_cents: "500",
        net_revenue_cents: "500",
        vat_cents: "0",
        etims_item_snapshot: {
            ...itemA.etims_item_snapshot!,
            etims_item_code: "KE12345679",
            etims_tax_type_code: "B",
        },
    });
    const sale = makeSale([itemA, itemB]);
    sale.total_amount = 16.6;
    const payload = buildEtimsSalesPayload(sale, settings);
    assert.equal(payload.totItemCnt, 2);
    assert.equal(payload.taxblAmtA, 10);
    assert.equal(payload.taxAmtA, 1.6);
    assert.equal(payload.taxblAmtB, 5);
    assert.equal(payload.taxAmtB, 0);
    assert.equal(payload.totAmt, 16.6);
});

test("buildEtimsSalesPayload maps discount and buyer data while preserving reconciliation", () => {
    const discounted = makeItem({
        unit_price: 11.6,
        line_total_cents: "1160",
        discount_cents: "116",
        net_revenue_cents: "900",
        vat_cents: "144",
    });
    const sale = makeSale([discounted]);
    sale.total_amount = 10.44;
    sale.customer = { name: "Wholesale Buyer Ltd" } as NonNullable<Sale["customer"]>;
    const payload = buildEtimsSalesPayload(sale, { ...settings, buyerTin: "P051138983Z" });

    assert.equal(payload.custNm, "Wholesale Buyer Ltd");
    assert.equal(payload.custTin, "P051138983Z");
    assert.equal(payload.itemList[0].dcAmt, 1.16);
    assert.equal(payload.itemList[0].dcRt, 10);
    assert.equal(payload.itemList[0].taxblAmt, 9);
    assert.equal(payload.itemList[0].taxAmt, 1.44);
    assert.equal(payload.totAmt, 10.44);
});

test("buildEtimsSalesPayload rejects incomplete mappings and non-reconciling amounts", () => {
    assert.throws(
        () => buildEtimsSalesPayload(makeSale([makeItem({ etims_item_snapshot: null })]), settings),
        /missing its eTIMS item mapping/,
    );
    assert.throws(
        () => buildEtimsSalesPayload(makeSale([makeItem({ vat_cents: "159" })]), settings),
        /do not reconcile/,
    );
    assert.throws(
        () => buildEtimsSalesPayload(makeSale(), { ...settings, invoiceNumber: 0 }),
        /positive allocated VSCU invoice number/,
    );
    assert.throws(
        () => buildEtimsSalesPayload(makeSale(), { ...settings, paymentTypeCode: " " }),
        /payment type code is required/,
    );
});

test("toEtimsSignResult maps VSCU receipt values to fields persisted by sale signing", () => {
    assert.deepEqual(toEtimsSignResult({
        data: {
            rcptNo: "KRAVSCU010000001024",
            intrLnk: "https://kra.go.ke/verify/example",
            rcptSign: "VSCU-SIGNATURE",
        },
    }), {
        receipt_no: "KRAVSCU010000001024",
        qr_code: "https://kra.go.ke/verify/example",
        signature: "VSCU-SIGNATURE",
        is_mock: false,
        disclaimer: "",
    });

    assert.throws(
        () => toEtimsSignResult({
            data: { rcptNo: "1", intrLnk: "http://example.invalid/verify", rcptSign: "sig" },
        }),
        /must use HTTPS/,
    );
});
