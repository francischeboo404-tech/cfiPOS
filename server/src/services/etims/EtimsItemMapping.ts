export interface EtimsItemMappingSnapshot {
    etims_item_code: string | null;
    etims_item_class_code: string | null;
    etims_product_type_code: string | null;
    etims_origin_country_code: string | null;
    etims_packaging_unit_code: string | null;
    etims_quantity_unit_code: string | null;
    etims_tax_type_code: string | null;
}

export const ETIMS_PRODUCT_MAPPING_FIELDS = [
    "etims_item_code",
    "etims_item_class_code",
    "etims_product_type_code",
    "etims_origin_country_code",
    "etims_packaging_unit_code",
    "etims_quantity_unit_code",
    "etims_tax_type_code",
] as const;

const FIELD_MAX_LENGTH: Record<(typeof ETIMS_PRODUCT_MAPPING_FIELDS)[number], number> = {
    etims_item_code: 20,
    etims_item_class_code: 10,
    etims_product_type_code: 5,
    etims_origin_country_code: 5,
    etims_packaging_unit_code: 5,
    etims_quantity_unit_code: 5,
    etims_tax_type_code: 5,
};

const PRODUCT_TYPE_CODES = new Set(["1", "2", "3"]);
const TAX_TYPE_CODES = new Set(["A", "B", "C", "D", "E"]);

export class EtimsProductMappingValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "EtimsProductMappingValidationError";
    }
}

export const sanitizeEtimsItemMapping = (
    input: Record<string, unknown>,
): Partial<EtimsItemMappingSnapshot> => {
    const sanitizeField = (field: (typeof ETIMS_PRODUCT_MAPPING_FIELDS)[number]): string | null => {
        if (input[field] === undefined || input[field] === null) return null;
        if (typeof input[field] !== "string") {
            throw new EtimsProductMappingValidationError(`${field} must be a string.`);
        }

        const value = input[field].trim();
        if (value.length > FIELD_MAX_LENGTH[field]) {
            throw new EtimsProductMappingValidationError(
                `${field} must be at most ${FIELD_MAX_LENGTH[field]} characters.`,
            );
        }
        if (field === "etims_product_type_code" && value && !PRODUCT_TYPE_CODES.has(value)) {
            throw new EtimsProductMappingValidationError(
                "etims_product_type_code must be a KRA product type code: 1 (raw material), 2 (finished product), or 3 (service).",
            );
        }
        if (field === "etims_tax_type_code" && value && !TAX_TYPE_CODES.has(value)) {
            throw new EtimsProductMappingValidationError(
                "etims_tax_type_code must be one of the KRA tax type codes A, B, C, D, or E.",
            );
        }

        return value || null;
    };

    const mapping: Partial<EtimsItemMappingSnapshot> = {};
    for (const field of ETIMS_PRODUCT_MAPPING_FIELDS) {
        if (field in input) {
            mapping[field] = sanitizeField(field);
        }
    }
    return mapping;
};

export const getEtimsItemMappingSnapshot = (
    product: EtimsItemMappingSnapshot,
): EtimsItemMappingSnapshot | null => {
    const mapping: EtimsItemMappingSnapshot = {
        etims_item_code: product.etims_item_code || null,
        etims_item_class_code: product.etims_item_class_code || null,
        etims_product_type_code: product.etims_product_type_code || null,
        etims_origin_country_code: product.etims_origin_country_code || null,
        etims_packaging_unit_code: product.etims_packaging_unit_code || null,
        etims_quantity_unit_code: product.etims_quantity_unit_code || null,
        etims_tax_type_code: product.etims_tax_type_code || null,
    };

    return ETIMS_PRODUCT_MAPPING_FIELDS.some((field) => mapping[field] !== null) ? mapping : null;
};

export const assertCompleteEtimsItemMapping = (
    snapshot: EtimsItemMappingSnapshot | null,
): asserts snapshot is EtimsItemMappingSnapshot => {
    if (!snapshot || ETIMS_PRODUCT_MAPPING_FIELDS.some((field) => !snapshot[field])) {
        throw new EtimsProductMappingValidationError(
            "Product is missing one or more required KRA eTIMS item mappings.",
        );
    }
};
