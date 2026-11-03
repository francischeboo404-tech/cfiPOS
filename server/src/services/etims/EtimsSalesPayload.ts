import { Sale } from "../../entity/Sale";
import { VscuSalesSaveRequest } from "./EtimsVscuClient";
import { EtimsSignResult } from "./EtimsProvider";
import { centsToKesString, parseKesToCents } from "../../lib/exactMoney";

export interface EtimsSalesPayloadSettings {
    tin: string;
    branchId: string;
    deviceId: string;
    invoiceNumber: number;
    paymentTypeCode: string;
    buyerTin?: string | null;
}

const toKesNumber = (cents: bigint): number => Number(centsToKesString(cents));

const formatVscuDate = (value: Date): string => {
    if (Number.isNaN(value.getTime())) throw new Error("Sale timestamp is invalid.");
    const iso = value.toISOString();
    return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
};

const requireText = (value: string, field: string): string => {
    const normalized = value.trim();
    if (!normalized) throw new Error(`${field} is required for VSCU sale payload construction.`);
    return normalized;
};

export const buildEtimsSalesPayload = (
    sale: Sale,
    settings: EtimsSalesPayloadSettings,
): VscuSalesSaveRequest => {
    if (!Number.isSafeInteger(settings.invoiceNumber) || settings.invoiceNumber <= 0) {
        throw new Error("A positive allocated VSCU invoice number is required.");
    }
    if (!Array.isArray(sale.items) || sale.items.length === 0) {
        throw new Error("Sale must contain at least one item for VSCU submission.");
    }
    const tin = requireText(settings.tin, "KRA PIN");
    const branchId = requireText(settings.branchId, "KRA branch ID");
    const deviceId = requireText(settings.deviceId, "VSCU device ID");
    const paymentTypeCode = requireText(settings.paymentTypeCode, "VSCU payment type code");

    const taxTotals = new Map<string, { taxableCents: bigint; taxCents: bigint }>();
    let totalTaxableCents = 0n;
    let totalTaxCents = 0n;
    const itemList = sale.items.map((item, index) => {
        const mapping = item.etims_item_snapshot;
        if (!mapping) {
            throw new Error(`Sale item ${index + 1} is missing its eTIMS item mapping.`);
        }
        const itemCode = requireText(mapping.etims_item_code || "", `Sale item ${index + 1} code`);
        requireText(mapping.etims_item_class_code || "", `Sale item ${index + 1} classification`);
        requireText(mapping.etims_product_type_code || "", `Sale item ${index + 1} product type`);
        requireText(mapping.etims_origin_country_code || "", `Sale item ${index + 1} origin country`);
        const packagingUnit = requireText(mapping.etims_packaging_unit_code || "", `Sale item ${index + 1} packaging unit`);
        const quantityUnit = requireText(mapping.etims_quantity_unit_code || "", `Sale item ${index + 1} quantity unit`);
        const taxType = mapping.etims_tax_type_code;
        if (!taxType || !/^[A-E]$/.test(taxType)) {
            throw new Error(`Sale item ${index + 1} has an unsupported eTIMS tax type.`);
        }
        if (!item.product?.name) {
            throw new Error(`Sale item ${index + 1} is missing its product name.`);
        }
        if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
            throw new Error(`Sale item ${index + 1} must have a positive whole-number quantity.`);
        }
        if (
            item.line_total_cents === null ||
            item.discount_cents === null ||
            item.net_revenue_cents === null ||
            item.vat_cents === null
        ) {
            throw new Error(`Sale item ${index + 1} is missing exact-cent tax or discount snapshots.`);
        }

        const grossCents = BigInt(item.line_total_cents);
        const discountCents = BigInt(item.discount_cents);
        const taxableCents = BigInt(item.net_revenue_cents);
        const taxCents = BigInt(item.vat_cents);
        if (grossCents < 0n || discountCents < 0n || discountCents > grossCents ||
            taxableCents < 0n || taxCents < 0n ||
            taxableCents + taxCents !== grossCents - discountCents) {
            throw new Error(`Sale item ${index + 1} tax and discount snapshots do not reconcile.`);
        }
        const unitPriceCents = parseKesToCents(item.unit_price);
        const supplyCents = unitPriceCents * BigInt(item.quantity);
        if (supplyCents !== grossCents) {
            throw new Error(`Sale item ${index + 1} unit price does not match its exact gross amount.`);
        }

        const bucket = taxTotals.get(taxType) || { taxableCents: 0n, taxCents: 0n };
        bucket.taxableCents += taxableCents;
        bucket.taxCents += taxCents;
        taxTotals.set(taxType, bucket);
        totalTaxableCents += taxableCents;
        totalTaxCents += taxCents;

        const discountRateHundredths = grossCents === 0n
            ? 0n
            : discountCents * 10_000n / grossCents;

        return {
            itemSeq: index + 1,
            itemCd: itemCode,
            itemNm: item.product.name,
            pkgUnitCd: packagingUnit,
            qtyUnitCd: quantityUnit,
            qty: item.quantity,
            prc: toKesNumber(unitPriceCents),
            splyAmt: toKesNumber(supplyCents),
            dcRt: Number(discountRateHundredths) / 100,
            dcAmt: toKesNumber(discountCents),
            taxTyCd: taxType,
            taxblAmt: toKesNumber(taxableCents),
            taxAmt: toKesNumber(taxCents),
            totAmt: toKesNumber(taxableCents + taxCents),
        };
    });

    const saleTotalCents = parseKesToCents(sale.total_amount);
    if (totalTaxableCents + totalTaxCents !== saleTotalCents) {
        throw new Error("Sale item totals do not reconcile with the sale total.");
    }

    const payload: VscuSalesSaveRequest = {
        tin,
        bhId: branchId,
        dvcId: deviceId,
        invcNo: settings.invoiceNumber,
        orgnInvcNo: 0,
        custTin: settings.buyerTin?.trim() || "",
        custNm: sale.customer?.name?.trim() || "Cash Customer",
        salesSttsCd: "02",
        rcptTyCd: "1",
        pmtTyCd: paymentTypeCode,
        lptnDt: formatVscuDate(sale.created_at),
        totItemCnt: itemList.reduce((count, item) => count + item.qty, 0),
        totTaxblAmt: toKesNumber(totalTaxableCents),
        totTaxAmt: toKesNumber(totalTaxCents),
        totAmt: toKesNumber(totalTaxableCents + totalTaxCents),
        itemList,
    };

    for (const [taxType, totals] of taxTotals) {
        payload[`taxblAmt${taxType}`] = toKesNumber(totals.taxableCents);
        payload[`taxAmt${taxType}`] = toKesNumber(totals.taxCents);
    }

    return payload;
};

export const toEtimsSignResult = (
    response: {
        data: {
            rcptNo: string;
            intrLnk: string;
            rcptSign: string;
        };
    },
): EtimsSignResult => {
    let verificationUrl: URL;
    try {
        verificationUrl = new URL(response.data.intrLnk);
    } catch {
        throw new Error("VSCU returned an invalid receipt verification URL.");
    }
    if (verificationUrl.protocol !== "https:") {
        throw new Error("VSCU receipt verification URL must use HTTPS.");
    }
    return {
        receipt_no: response.data.rcptNo,
        qr_code: verificationUrl.toString(),
        signature: response.data.rcptSign,
        is_mock: false,
        disclaimer: "",
    };
};
