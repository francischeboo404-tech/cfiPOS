import test from "node:test";
import assert from "node:assert/strict";
import {
    assertCompleteEtimsItemMapping,
    EtimsProductMappingValidationError,
    getEtimsItemMappingSnapshot,
    sanitizeEtimsItemMapping,
} from "./EtimsItemMapping";

const completeMapping = {
    etims_item_code: "KE2NTU0000001",
    etims_item_class_code: "5059690800",
    etims_product_type_code: "2",
    etims_origin_country_code: "KE",
    etims_packaging_unit_code: "NT",
    etims_quantity_unit_code: "U",
    etims_tax_type_code: "B",
} as const;

test("sanitizeEtimsItemMapping accepts and trims explicit KRA item values", () => {
    assert.deepEqual(
        sanitizeEtimsItemMapping({
            ...completeMapping,
            etims_item_code: " KE2NTU0000001 ",
            etims_item_class_code: " 5059690800 ",
        }),
        completeMapping,
    );
    assert.deepEqual(
        sanitizeEtimsItemMapping({ etims_tax_type_code: "B" }),
        { etims_tax_type_code: "B" },
    );
});

test("sanitizeEtimsItemMapping rejects invalid type, length, product type, and tax type values", () => {
    assert.throws(
        () => sanitizeEtimsItemMapping({ etims_item_code: 123 }),
        EtimsProductMappingValidationError,
    );
    assert.throws(
        () => sanitizeEtimsItemMapping({ etims_item_code: "X".repeat(21) }),
        /at most 20 characters/,
    );
    assert.throws(
        () => sanitizeEtimsItemMapping({ etims_item_class_code: "X".repeat(11) }),
        /at most 10 characters/,
    );
    assert.throws(
        () => sanitizeEtimsItemMapping({ etims_product_type_code: "4" }),
        /KRA product type code/,
    );
    assert.throws(
        () => sanitizeEtimsItemMapping({ etims_tax_type_code: "F" }),
        /KRA tax type codes/,
    );
});

test("product mapping snapshots remain independent of later product mapping changes", () => {
    const product = sanitizeEtimsItemMapping(completeMapping);
    const snapshot = getEtimsItemMappingSnapshot({
        ...completeMapping,
        ...product,
    });

    assert.deepEqual(snapshot, completeMapping);
    assert.doesNotThrow(() => assertCompleteEtimsItemMapping(snapshot));
    assert.throws(() => assertCompleteEtimsItemMapping(null), /missing one or more/);
    assert.throws(
        () => assertCompleteEtimsItemMapping({
            ...completeMapping,
            etims_tax_type_code: null,
        }),
        /missing one or more/,
    );
    assert.equal(getEtimsItemMappingSnapshot({
        etims_item_code: null,
        etims_item_class_code: null,
        etims_product_type_code: null,
        etims_origin_country_code: null,
        etims_packaging_unit_code: null,
        etims_quantity_unit_code: null,
        etims_tax_type_code: null,
    }), null);
});
