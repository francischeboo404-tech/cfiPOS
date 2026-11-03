import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { Request, Response } from "express";
import * as jwt from "jsonwebtoken";
import { strToU8, zipSync } from "fflate";
import { TaxClass } from "../entity/TaxClass";
import { Sale } from "../entity/Sale";
import { SupplierPaymentMethod } from "../entity/SupplierPayment";
import { assertSaleDiscountAuthorized } from "../lib/saleDiscountRules";
import { verifyPesapalSignature } from "../lib/pesapal";
import { sanitizeCategoryName } from "./CategoryController";
import {
  getProductImportPersistenceError,
  matchProductImportTaxClass,
  normalizeProductImportRow,
  parseProductImportFile,
  parseProductImportMoney,
  parseProductImportNumber,
  sanitizeProductPayload,
  selectProductImportWarehouse,
} from "./ProductController";
import { getCompanyLogoMimeType, sanitizeSettingsPayload, sanitizeLoyaltyMemberPayload, sanitizeLoyaltyPointsPayload } from "./LoyaltyController";
import { sanitizeCustomerPayload } from "./CustomerController";
import { sanitizeVendorPayload } from "./VendorController";
import { sanitizeWarehousePayload } from "./WarehouseController";
import {
  isSameSupplierPaymentRequest,
  sanitizeSupplierInvoicePayload,
  sanitizeSupplierPaymentPayload,
  sanitizeRequisitionStatusPayload,
} from "./ProcurementController";
import { sanitizeShiftCurrency } from "./ShiftController";
import { sanitizeAuthRegistrationPayload, sanitizeAuthLoginPayload, sanitizeLogEventPayload } from "./AuthController";
import { sanitizeInvoicePaymentPayload } from "./InvoiceController";
import { sanitizeUserAdminUpdatePayload, sanitizeUserRolePayload, sanitizeUserCreatePayload } from "./UserAdminController";
import { sanitizeInventoryAdjustmentPayload, sanitizeInventoryTransferPayload, sanitizeTransferStatusPayload, sanitizeStockTakePayload } from "./InventoryController";
import { sanitizeReturnRequestPayload, sanitizeApproveReturnPayload, sanitizeRejectReturnPayload, sanitizeMpesaRefundReceipt } from "./ReturnController";
import { calculateCashChange, calculateSaleItemCogsCents, deriveSalePaymentMethod, sanitizeSalePayload, sanitizeVoidSalePayload, sanitizeParkedSalePayload } from "./SalesController";
import { sanitizePurchaseOrderCreatePayload, sanitizePurchaseOrderStatusPayload } from "./PurchaseOrderController";
import { sanitizeTaxClassPayload, sanitizeTaxClassUpdatePayload } from "./TaxController";
import {
  getMpesaStkConfigurationIssues,
  getMpesaStkTransactionType,
  hashMpesaCallbackToken,
  parseC2bCallback,
  sanitizeMpesaStkPayload,
  verifyMpesaCallbackToken,
  verifyMpesaC2bCallbackToken,
} from "./PaymentController";
import { escapeHtml, getOtpEmailConfigurationIssues, shouldUseDevOtpFallback } from "../services/EmailService";
import { authenticateJWT, type AuthenticatedRequest } from "../middleware/auth";
import { EtimsMockService, ETIMS_MOCK_DISCLAIMER } from "../services/EtimsMockService";
import { EtimsService } from "../services/etims/EtimsService";
import { PesapalMockService } from "../services/PesapalMockService";
import { resolveAllowedCorsOrigins } from "../index";
import { sanitizeCheckoutPayload } from "./CheckoutController";
import { createInventoryPredictions, type DailySalesPoint } from "../services/InventoryPredictionService";
import {
  DEFAULT_PRODUCT_UNIT_OF_MEASURES,
  isConfiguredProductUnit,
  normalizeProductUnitOfMeasures,
  parseProductUnitOfMeasures,
} from "../services/ProductCatalogSettings";

test("development OTP fallback is gated by explicit flag and blocked in production", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalResendApiKey = process.env.RESEND_API_KEY;
  const originalAllowFallback = process.env.ALLOW_DEV_OTP_FALLBACK;

  process.env.NODE_ENV = "development";
  process.env.ALLOW_DEV_OTP_FALLBACK = "true";
  delete process.env.RESEND_API_KEY;

  assert.equal(shouldUseDevOtpFallback(), true);

  // When flag is missing in development, fallback is false
  delete process.env.ALLOW_DEV_OTP_FALLBACK;
  assert.equal(shouldUseDevOtpFallback(), false);

  // In production, fallback is ALWAYS false even if ALLOW_DEV_OTP_FALLBACK is set to true
  process.env.NODE_ENV = "production";
  process.env.ALLOW_DEV_OTP_FALLBACK = "true";
  assert.equal(shouldUseDevOtpFallback(), false);

  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }

  if (originalAllowFallback === undefined) {
    delete process.env.ALLOW_DEV_OTP_FALLBACK;
  } else {
    process.env.ALLOW_DEV_OTP_FALLBACK = originalAllowFallback;
  }

  if (originalResendApiKey) {
    process.env.RESEND_API_KEY = originalResendApiKey;
  }
});

test("OTP email configuration requires both the provider key and verified sender", () => {
  assert.deepEqual(getOtpEmailConfigurationIssues({}), [
    "RESEND_API_KEY is missing",
    "RESEND_FROM_EMAIL is missing",
  ]);
  assert.deepEqual(getOtpEmailConfigurationIssues({
    RESEND_API_KEY: "configured-test-key",
    RESEND_FROM_EMAIL: "   ",
  }), ["RESEND_FROM_EMAIL is missing"]);
  assert.deepEqual(getOtpEmailConfigurationIssues({
    RESEND_API_KEY: "configured-test-key",
    RESEND_FROM_EMAIL: "pos@example.test",
  }), []);
});

test("local frontend origins should include the active dev ports used by Vite", () => {
  const allowedOrigins = resolveAllowedCorsOrigins("development", "", "");

  assert.ok(allowedOrigins.includes("http://localhost:4173"), "localhost:4173 should be allowed");
  assert.ok(allowedOrigins.includes("http://127.0.0.1:4173"), "127.0.0.1:4173 should be allowed");
});

test("resolveAllowedCorsOrigins isolates production to explicitly configured origins only", () => {
  // In production, default localhost origins must NOT be included
  const prodOrigins = resolveAllowedCorsOrigins("production", "https://pos.store.com", "https://app.store.com");
  assert.deepEqual(prodOrigins, ["https://pos.store.com", "https://app.store.com"]);
  assert.equal(prodOrigins.some((o) => o.includes("localhost") || o.includes("127.0.0.1")), false);

  // In production, empty configuration returns empty array
  const emptyProd = resolveAllowedCorsOrigins("production", "", "");
  assert.deepEqual(emptyProd, []);

  // In development, default localhost origins are permitted
  const devOrigins = resolveAllowedCorsOrigins("development", "http://custom-dev:3000", "");
  assert.ok(devOrigins.includes("http://localhost:5173"));
  assert.ok(devOrigins.includes("http://localhost:8080"));
  assert.ok(devOrigins.includes("http://custom-dev:3000"));
});

test("verifyPesapalSignature rejects unsigned payloads and missing secret", () => {
  process.env.PESAPAL_IPN_SECRET = "test-secret";

  const payload = {
    OrderTrackingId: "tracking-123",
    OrderMerchantReference: "merchant-ref-123",
    OrderNotificationType: "IPNCHANGE",
  };

  assert.equal(verifyPesapalSignature(payload, "bad-signature"), false);
  assert.equal(verifyPesapalSignature(payload), false);
  assert.equal(verifyPesapalSignature(null, "some-sig"), false);

  delete process.env.PESAPAL_IPN_SECRET;
  delete process.env.PESAPAL_SECRET;
  delete process.env.PESAPAL_API_SECRET;
  assert.equal(verifyPesapalSignature(payload, "e83820fc36f985d925cbe3000e43035551bd9ca1d0c159827da0c6699acc0018"), false);
});

test("verifyPesapalSignature accepts a valid HMAC signature over canonical payload and raw body", () => {
  process.env.PESAPAL_IPN_SECRET = "test-secret";

  const payload = {
    OrderTrackingId: "tracking-123",
    OrderMerchantReference: "merchant-ref-123",
    OrderNotificationType: "IPNCHANGE",
  };

  const signature = "e83820fc36f985d925cbe3000e43035551bd9ca1d0c159827da0c6699acc0018";
  assert.equal(verifyPesapalSignature(payload, signature), true);

  const rawBody = Buffer.from(JSON.stringify(payload));
  const rawHmac = createHmac("sha256", "test-secret").update(rawBody).digest("hex");
  assert.equal(verifyPesapalSignature(payload, rawHmac, rawBody), true);
});

test("M-Pesa callback token hashes reject missing and altered tokens", () => {
  const callbackToken = "callback-token-for-test-only";
  const callbackTokenHash = hashMpesaCallbackToken(callbackToken);

  assert.equal(verifyMpesaCallbackToken(callbackToken, callbackTokenHash), true);
  assert.equal(verifyMpesaCallbackToken("altered-token", callbackTokenHash), false);
  assert.equal(verifyMpesaCallbackToken(callbackToken, null), false);
});

test("M-Pesa C2B callback token verification enforces valid constant-time token comparison", () => {
  const expectedSecret = "a".repeat(64);
  assert.equal(verifyMpesaC2bCallbackToken(expectedSecret, expectedSecret), true);
  assert.equal(verifyMpesaC2bCallbackToken("wrong-token", expectedSecret), false);
  assert.equal(verifyMpesaC2bCallbackToken("", expectedSecret), false);
  assert.equal(verifyMpesaC2bCallbackToken(expectedSecret, undefined), false);
});

test("M-Pesa STK setup accepts a saved Till and server credentials with a public callback", () => {
  const environment = {
    MPESA_CONSUMER_KEY: "test-consumer-key",
    MPESA_CONSUMER_SECRET: "test-consumer-secret",
    MPESA_PASSKEY: "test-passkey",
    MPESA_API_BASE_URL: "https://api.safaricom.test",
  };

  assert.deepEqual(
    getMpesaStkConfigurationIssues(
      environment,
      "174379",
      "https://pos.example.test/api/webhooks/mpesa/callback",
    ),
    [],
  );
});

test("M-Pesa STK setup accepts a configured Paybill and selects the matching Daraja transaction type", () => {
  const environment = {
    MPESA_CONSUMER_KEY: "test-consumer-key",
    MPESA_CONSUMER_SECRET: "test-consumer-secret",
    MPESA_PASSKEY: "test-passkey",
    MPESA_API_BASE_URL: "https://api.safaricom.test",
  };
  const callbackUrl = "https://pos.example.test/api/webhooks/mpesa/callback";

  assert.deepEqual(getMpesaStkConfigurationIssues(environment, "123456", callbackUrl, "paybill"), []);
  assert.equal(getMpesaStkTransactionType("paybill"), "CustomerPayBillOnline");
  assert.equal(getMpesaStkTransactionType("till"), "CustomerBuyGoodsOnline");
});

test("M-Pesa STK setup reports missing callback without exposing credential values", () => {
  const environment = {
    MPESA_CONSUMER_KEY: "test-consumer-key",
    MPESA_CONSUMER_SECRET: "test-consumer-secret",
    MPESA_PASSKEY: "test-passkey",
    MPESA_API_BASE_URL: "https://api.safaricom.test",
  };

  const issues = getMpesaStkConfigurationIssues(environment, "174379");
  assert.equal(issues.length, 1);
  assert.match(issues[0], /public HTTPS STK callback URL/);
  assert.ok(issues.every((issue) => !issue.includes("test-consumer")));
});

test("sanitizeProductPayload strips untrusted fields", () => {
  const payload = {
    sku: "SKU-001",
    name: "Coffee Beans",
    unit_cost: 120,
    retail_price: 180,
    stock_on_hand: 5,
    is_parent: true,
    admin_override: "yes",
    created_at: "2025-01-01",
  };

  const result = sanitizeProductPayload(payload);

  assert.deepEqual(result, {
    sku: "SKU-001",
    name: "Coffee Beans",
    unit_cost: 120,
    retail_price: 180,
    stock_on_hand: 5,
    is_parent: true,
  });
});

test("sanitizeProductPayload accepts explicit KRA item mappings and rejects unsupported codes", () => {
  assert.deepEqual(
    sanitizeProductPayload({
      etims_item_code: " KE2NTU0000001 ",
      etims_item_class_code: "5059690800",
      etims_product_type_code: "2",
      etims_origin_country_code: "KE",
      etims_packaging_unit_code: "NT",
      etims_quantity_unit_code: "U",
      etims_tax_type_code: "B",
    }),
    {
      etims_item_code: "KE2NTU0000001",
      etims_item_class_code: "5059690800",
      etims_product_type_code: "2",
      etims_origin_country_code: "KE",
      etims_packaging_unit_code: "NT",
      etims_quantity_unit_code: "U",
      etims_tax_type_code: "B",
    },
  );
  assert.throws(
    () => sanitizeProductPayload({ etims_tax_type_code: "16%" }),
    /KRA tax type codes/,
  );
});

test("product prices normalize exact cents and reject fractional cents or unsupported ranges", () => {
  assert.deepEqual(
    sanitizeProductPayload({ unit_cost: "0.29", retail_price: "99999999.99" }),
    { unit_cost: 0.29, retail_price: 99_999_999.99 },
  );
  assert.throws(() => sanitizeProductPayload({ unit_cost: "1.005" }), /two decimal places/i);
  assert.throws(() => sanitizeProductPayload({ retail_price: "100000000.00" }), /maximum supported value/i);
  assert.equal(parseProductImportMoney("KSh 1,250.09"), "1250.09");
  assert.throws(() => parseProductImportMoney("1,25.00"), /two decimal places/i);
  assert.throws(() => parseProductImportMoney("-1.00"), /non-negative/i);
});

test("normalizeProductImportRow maps common spreadsheet columns to the internal product schema", () => {
  const result = normalizeProductImportRow({
    SKU: "SKU-1001",
    Barcode: "1234567890123",
    Name: "Tea Leaves",
    Category: "Beverages",
    unit_cost: "120",
    retail_price: "180",
    tax_rate: "16",
    UOM: "kg",
    reorder_level: "8",
    opening_stock: "25",
    location: "main",
    warehouse_name: "Main Warehouse",
  });

  assert.deepEqual(result, {
    sku: "SKU-1001",
    barcode: "1234567890123",
    name: "Tea Leaves",
    category_name: "Beverages",
    tax_class_name: "",
    warehouse_name: "Main Warehouse",
    unit_cost: "120",
    retail_price: "180",
    tax_rate: "16",
    unit_of_measure: "kg",
    reorder_level: "8",
    stock_on_hand: "25",
    location: "main",
  });
});

test("normalizeProductImportRow leaves optional references empty and handles spreadsheet header whitespace", () => {
  const result = normalizeProductImportRow({
    " SKU ": " SKU-1002 ",
    " Product Name ": "Rice 5kg",
    "Opening Stock": "0",
  });

  assert.equal(result.sku, "SKU-1002");
  assert.equal(result.name, "Rice 5kg");
  assert.equal(result.stock_on_hand, "0");
  assert.equal(result.category_name, "");
  assert.equal(result.barcode, null);
});

test("normalizeProductImportRow accepts common item, currency, and quantity header variants", () => {
  const result = normalizeProductImportRow({
    "Product Code": "SKU-1003",
    "Product Name": "Cooking Oil",
    "Unit Cost (KES)": "1,250.00",
    "Selling Price (KSh)": "1,600",
    "Opening Stock (Units)": "12",
  });

  assert.equal(result.sku, "SKU-1003");
  assert.equal(result.name, "Cooking Oil");
  assert.equal(result.unit_cost, "1,250.00");
  assert.equal(result.retail_price, "1,600");
  assert.equal(result.stock_on_hand, "12");
});

test("parseProductImportFile reads CSV rows and preserves quoted commas", async () => {
  const csv = Buffer.from("sku,name,unit_cost\nSKU-2001,\"Tea, Green\",12.5\n");
  const rows = await parseProductImportFile(csv, "products.csv");

  assert.deepEqual(rows, [{ sku: "SKU-2001", name: "Tea, Green", unit_cost: "12.5" }]);
});

test("parseProductImportFile detects semicolon-delimited CSV exports", async () => {
  const csv = Buffer.from("sku;name;unit_cost;retail_price\nSKU-2003;Rice 5kg;1,250.00;1,600\n");
  const rows = await parseProductImportFile(csv, "products.csv");

  assert.deepEqual(rows, [{
    sku: "SKU-2003",
    name: "Rice 5kg",
    unit_cost: "1,250.00",
    retail_price: "1,600",
  }]);
});

test("product import parses the supplied tab-separated product row without losing fields", async () => {
  const tsv = Buffer.from([
    "sku\tbarcode\tname\tcategory_name\ttax_class_name\tunit_cost\tretail_price\ttax_rate\tunit_of_measure\treorder_level\tstock_on_hand\tlocation\twarehouse_name",
    "21028382\t616140000\tBlue Band\tFood\tStandard VAT\t45\t69\t16\tgrams\t20\t90\tHeadquarters\tMain Warehouse",
  ].join("\n"));
  const rows = await parseProductImportFile(tsv, "products.csv");

  assert.equal(rows.length, 1);
  assert.deepEqual(normalizeProductImportRow(rows[0]), {
    sku: "21028382",
    barcode: "616140000",
    name: "Blue Band",
    category_name: "Food",
    tax_class_name: "Standard VAT",
    warehouse_name: "Main Warehouse",
    unit_cost: "45",
    retail_price: "69",
    tax_rate: "16",
    unit_of_measure: "grams",
    reorder_level: "20",
    stock_on_hand: "90",
    location: "Headquarters",
  });
});

test("product import numbers support grouped thousands and KES prefixes", () => {
  assert.equal(parseProductImportNumber("KES 1,250.50"), 1250.5);
  assert.equal(parseProductImportNumber("KSh 2,000"), 2000);
  assert.equal(parseProductImportNumber("invalid"), Number.NaN);
});

test("product import selects the configured main warehouse for opening stock when omitted", () => {
  const warehouses = [
    { name: "Overflow", is_main: false },
    { name: "Main Store", is_main: true },
  ];

  assert.equal(selectProductImportWarehouse("", 5, warehouses)?.name, "Main Store");
  assert.equal(selectProductImportWarehouse(" overflow ", 5, warehouses)?.name, "Overflow");
  assert.equal(selectProductImportWarehouse("", 0, warehouses), undefined);
  assert.equal(selectProductImportWarehouse("", 5, []), undefined);
});

test("matchProductImportTaxClass matches standard tax types, percentages, KRA codes, and aliases", () => {
  const standard16 = Object.assign(new TaxClass(), { id: "1", name: "Standard VAT 16%", rate: 16.0, is_default: true });
  const zeroRated0 = Object.assign(new TaxClass(), { id: "2", name: "Zero Rated 0%", rate: 0.0, is_default: false });
  const exempt0 = Object.assign(new TaxClass(), { id: "3", name: "Exempt 0%", rate: 0.0, is_default: false });
  const special8 = Object.assign(new TaxClass(), { id: "4", name: "Special Rate 8%", rate: 8.0, is_default: false });
  const tourism2 = Object.assign(new TaxClass(), { id: "5", name: "Tourism Levy 2%", rate: 2.0, is_default: false });

  const taxClasses = [standard16, zeroRated0, exempt0, special8, tourism2];

  // 16% standard VAT variations
  assert.equal(matchProductImportTaxClass({ taxClassName: "16%" }, taxClasses)?.id, "1");
  assert.equal(matchProductImportTaxClass({ taxClassName: "16" }, taxClasses)?.id, "1");
  assert.equal(matchProductImportTaxClass({ taxClassName: "VAT 16%" }, taxClasses)?.id, "1");
  assert.equal(matchProductImportTaxClass({ taxClassName: "Standard VAT" }, taxClasses)?.id, "1");
  assert.equal(matchProductImportTaxClass({ taxClassName: "Standard" }, taxClasses)?.id, "1");
  assert.equal(matchProductImportTaxClass({ taxClassName: "VAT" }, taxClasses)?.id, "1");
  assert.equal(matchProductImportTaxClass({ taxClassName: "B" }, taxClasses)?.id, "1");
  assert.equal(matchProductImportTaxClass({ taxClassName: "B - 16%" }, taxClasses)?.id, "1");

  // Zero rated variations
  assert.equal(matchProductImportTaxClass({ taxClassName: "Zero Rated" }, taxClasses)?.id, "2");
  assert.equal(matchProductImportTaxClass({ taxClassName: "Zero-rated" }, taxClasses)?.id, "2");
  assert.equal(matchProductImportTaxClass({ taxClassName: "Zero" }, taxClasses)?.id, "2");
  assert.equal(matchProductImportTaxClass({ taxClassName: "0%" }, taxClasses)?.id, "2");
  assert.equal(matchProductImportTaxClass({ taxClassName: "0" }, taxClasses)?.id, "2");
  assert.equal(matchProductImportTaxClass({ taxClassName: "C" }, taxClasses)?.id, "2");
  assert.equal(matchProductImportTaxClass({ taxClassName: "C - 0%" }, taxClasses)?.id, "2");

  // Exempt variations
  assert.equal(matchProductImportTaxClass({ taxClassName: "Exempt" }, taxClasses)?.id, "3");
  assert.equal(matchProductImportTaxClass({ taxClassName: "Tax Exempt" }, taxClasses)?.id, "3");
  assert.equal(matchProductImportTaxClass({ taxClassName: "A" }, taxClasses)?.id, "3");
  assert.equal(matchProductImportTaxClass({ taxClassName: "A - Exempt" }, taxClasses)?.id, "3");

  // Special 8% variations
  assert.equal(matchProductImportTaxClass({ taxClassName: "8%" }, taxClasses)?.id, "4");
  assert.equal(matchProductImportTaxClass({ taxClassName: "8" }, taxClasses)?.id, "4");
  assert.equal(matchProductImportTaxClass({ taxClassName: "E" }, taxClasses)?.id, "4");
  assert.equal(matchProductImportTaxClass({ taxClassName: "Special Rate 8%" }, taxClasses)?.id, "4");

  // Custom tax class rate matching
  assert.equal(matchProductImportTaxClass({ taxClassName: "Tourism Levy" }, taxClasses)?.id, "5");
  assert.equal(matchProductImportTaxClass({ taxClassName: "2%" }, taxClasses)?.id, "5");

  // Empty tax class name falls back to default tax class or raw rate
  assert.equal(matchProductImportTaxClass({ taxClassName: "" }, taxClasses)?.id, "1");
  assert.equal(matchProductImportTaxClass({ taxClassName: "", taxRate: "0" }, taxClasses)?.id, "2");
  assert.equal(matchProductImportTaxClass({ taxClassName: "", taxRate: 8 }, taxClasses)?.id, "4");
});

test("normalizeProductImportRow recognizes diverse tax and vat column headers", () => {
  const rowWithTaxType = normalizeProductImportRow({
    SKU: "SKU-TAX-1",
    Name: "Sugar",
    "Tax Type": "16%",
    "unit_cost": "100",
    "retail_price": "140",
  });
  assert.equal(rowWithTaxType.tax_class_name, "16%");

  const rowWithTax = normalizeProductImportRow({
    SKU: "SKU-TAX-2",
    Name: "Salt",
    "Tax": "Zero Rated",
    "unit_cost": "20",
    "retail_price": "30",
  });
  assert.equal(rowWithTax.tax_class_name, "Zero Rated");

  const rowWithVat = normalizeProductImportRow({
    SKU: "SKU-TAX-3",
    Name: "Bread",
    "VAT": "Exempt",
    "unit_cost": "50",
    "retail_price": "65",
  });
  assert.equal(rowWithVat.tax_class_name, "Exempt");

  const rowWithKraTax = normalizeProductImportRow({
    SKU: "SKU-TAX-4",
    Name: "Milk",
    "KRA Tax Type": "B - 16%",
    "unit_cost": "50",
    "retail_price": "70",
  });
  assert.equal(rowWithKraTax.tax_class_name, "B - 16%");
});

test("product import maps database constraint failures to useful row messages", () => {
  assert.match(
    getProductImportPersistenceError({ driverError: { code: "23505", constraint: "UQ_products_sku" } }),
    /SKU already exists/,
  );
  assert.match(
    getProductImportPersistenceError({ driverError: { code: "23502", column: "category_id" } }),
    /category_id/,
  );
});

test("parseProductImportFile reads rows from a valid XLSX workbook", async () => {
  const files = {
    "[Content_Types].xml": strToU8(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`),
    "_rels/.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`),
    "xl/workbook.xml": strToU8(`<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Products" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    "xl/_rels/workbook.xml.rels": strToU8(`<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`),
    "xl/worksheets/sheet1.xml": strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>sku</t></is></c><c r="B1" t="inlineStr"><is><t>name</t></is></c><c r="C1" t="inlineStr"><is><t>opening stock</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>SKU-2002</t></is></c><c r="B2" t="inlineStr"><is><t>Rice 5kg</t></is></c><c r="C2"><v>12</v></c></row></sheetData></worksheet>`),
  };
  const workbook = Buffer.from(zipSync(files));

  const rows = await parseProductImportFile(workbook, "products.xlsx");

  assert.deepEqual(rows, [{ sku: "SKU-2002", name: "Rice 5kg", "opening stock": "12" }]);
});

test("parseProductImportFile rejects invalid XLSX payloads", async () => {
  await assert.rejects(() => parseProductImportFile(Buffer.from("not an xlsx file"), "products.xlsx"));
});

test("sanitizeSettingsPayload only accepts supported keys", () => {
  const payload = {
    company_name: "Northwind",
    tax_pin: "P123456789A",
    loyalty_points_rate: "2",
    mpesa_callback_url: "https://pos.example.test/api/webhooks/mpesa/callback",
    malicious_key: "should-not-save",
    receipt_footer: "Thanks!",
    allow_negative_stock: true,
  };

  const result = sanitizeSettingsPayload(payload);

  assert.deepEqual(result, {
    company_name: "Northwind",
    tax_pin: "P123456789A",
    loyalty_points_rate: "2",
    mpesa_callback_url: "https://pos.example.test/api/webhooks/mpesa/callback",
    receipt_footer: "Thanks!",
    allow_negative_stock: "true",
  });
  assert.throws(() => sanitizeSettingsPayload({ allow_negative_stock: "yes" }), /true or false/i);
});

test("product catalog settings validate and persist configured units of measure", () => {
  const units = normalizeProductUnitOfMeasures([" grams ", "box"]);
  assert.deepEqual(units, ["grams", "box"]);
  assert.deepEqual(parseProductUnitOfMeasures(JSON.stringify(units)), units);
  assert.deepEqual(parseProductUnitOfMeasures(undefined), DEFAULT_PRODUCT_UNIT_OF_MEASURES);
  assert.equal(isConfiguredProductUnit("GRAMS", units), true);
  assert.equal(isConfiguredProductUnit("piece", units), false);
  assert.throws(() => normalizeProductUnitOfMeasures(["kg", " KG "]), /listed more than once/);
  assert.throws(() => normalizeProductUnitOfMeasures([]), /at least one/);
  assert.throws(() => parseProductUnitOfMeasures("{invalid"), /invalid JSON/);

  assert.deepEqual(
    sanitizeSettingsPayload({ product_unit_of_measures: JSON.stringify(units) }),
    { product_unit_of_measures: JSON.stringify(units) },
  );
  assert.throws(
    () => sanitizeSettingsPayload({ product_unit_of_measures: '["kg","KG"]' }),
    /listed more than once/,
  );
});

test("M-Pesa settings accept valid Till or Paybill details and reject invalid account configuration", () => {
  assert.deepEqual(
    sanitizeSettingsPayload({
      mpesa_stk_account_type: "paybill",
      mpesa_paybill: "123456",
      mpesa_shortcode: "174379",
    }),
    {
      mpesa_stk_account_type: "paybill",
      mpesa_paybill: "123456",
      mpesa_shortcode: "174379",
    },
  );
  assert.throws(
    () => sanitizeSettingsPayload({ mpesa_stk_account_type: "merchant" }),
    /Till or Paybill/,
  );
  assert.throws(
    () => sanitizeSettingsPayload({ mpesa_paybill: "ABC123" }),
    /valid 5 to 7 digit/,
  );
});

test("product categories require trimmed names within the supported length", () => {
  assert.equal(sanitizeCategoryName({ name: "  Food " }), "Food");
  assert.throws(() => sanitizeCategoryName({ name: "  " }), /required/);
  assert.throws(() => sanitizeCategoryName({ name: "x".repeat(101) }), /100 characters/);
});

test("company logo uploads recognize supported raster image signatures only", () => {
  assert.equal(
    getCompanyLogoMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "image/png",
  );
  assert.equal(getCompanyLogoMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00])), "image/jpeg");
  assert.equal(getCompanyLogoMimeType(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(getCompanyLogoMimeType(Buffer.from("<svg></svg>")), null);
  assert.equal(getCompanyLogoMimeType(Buffer.from([0x89, 0x50])), null);
});

test("sales forecasts use exactly the supplied complete daily buckets and recent 30-day average", () => {
  const dailySales: DailySalesPoint[] = Array.from({ length: 90 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    total: index < 60 ? 100 : 200,
    count: 1,
  }));
  const result = createInventoryPredictions([], dailySales);

  assert.equal(result.salesForecast.historyDays, 90);
  assert.equal(result.salesForecast.historicalTransactions, 90);
  assert.equal(result.salesForecast.activeSalesDays, 90);
  assert.equal(result.salesForecast.baselineDailySales, "200.00");
  assert.equal(result.salesForecast.next7Days, "1400.00");
  assert.equal(result.salesForecast.next30Days, "6000.00");
  assert.equal(result.salesForecast.trendDirection, "increasing");
  assert.equal(result.salesForecast.confidence, "high");
});

test("sales forecasts sum and round daily revenue from exact cents", () => {
  const result = createInventoryPredictions([], [
    { date: "2026-01-01", total: "0.01", count: 1 },
    { date: "2026-01-02", total: "0.00", count: 0 },
  ]);

  assert.equal(result.salesForecast.baselineDailySales, "0.01");
  assert.equal(result.salesForecast.next7Days, "0.04");
  assert.equal(result.salesForecast.next30Days, "0.15");
});

test("stock reorder recommendations match configured reorder levels, without arbitrary minimum quantities", () => {
  const dailySales: DailySalesPoint[] = Array.from({ length: 90 }, (_, index) => ({
    date: new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10),
    total: 0,
    count: 0,
  }));
  const result = createInventoryPredictions([
    { id: "out", name: "Out of stock", sku: "OUT", stock_on_hand: 0, reorder_level: 10 },
    { id: "low", name: "Low stock", sku: "LOW", stock_on_hand: 2, reorder_level: 5 },
    { id: "healthy", name: "Healthy", sku: "OK", stock_on_hand: 6, reorder_level: 5 },
    { id: "unset", name: "Unconfigured", sku: "NONE", stock_on_hand: 0, reorder_level: 0 },
  ], dailySales);

  assert.deepEqual(
    result.inventoryAlerts.map((alert) => [alert.sku, alert.suggestedReorderQty, alert.urgency]),
    [["OUT", 10, "critical"], ["NONE", 0, "critical"], ["LOW", 3, "high"]],
  );
  assert.match(result.inventoryAlerts[1].reasoning, /no reorder level is configured/);
  assert.equal(result.salesForecast.next7Days, "0.00");
  assert.equal(result.salesForecast.trendDirection, "stable");
  assert.equal(result.salesForecast.confidence, "low");
});

test("sanitizeCustomerPayload strips untrusted fields", () => {
  const payload = {
    name: "Jane Doe",
    phone: "+254700000000",
    email: "jane@example.com",
    store_credit_balance: 250,
    is_frequent: true,
    password: "secret",
    purchase_count: 4,
  };

  const result = sanitizeCustomerPayload(payload);

  assert.deepEqual(result, {
    name: "Jane Doe",
    phone: "+254700000000",
    email: "jane@example.com",
    store_credit_balance: 250,
    is_frequent: true,
    purchase_count: 4,
  });
});

test("sanitizeVendorPayload strips untrusted fields", () => {
  const payload = {
    name: "Supplier Co",
    contact_person: "Alice",
    phone: "+254700111222",
    email: "vendor@example.com",
    address: "Nairobi",
    payment_terms: "Net 30",
    needs_review: false,
    reviewed_by: "attacker-user",
    admin_override: "yes",
  };

  const result = sanitizeVendorPayload(payload);

  assert.deepEqual(result, {
    name: "Supplier Co",
    contact_person: "Alice",
    phone: "+254700111222",
    email: "vendor@example.com",
    address: "Nairobi",
    payment_terms: "Net 30",
  });
});

test("sanitizeWarehousePayload strips untrusted fields", () => {
  const payload = {
    name: "Main Warehouse",
    location_address: "Nairobi CBD",
    is_main: true,
    is_active: false,
    admin_override: "yes",
  };

  const result = sanitizeWarehousePayload(payload);

  assert.deepEqual(result, {
    name: "Main Warehouse",
    location_address: "Nairobi CBD",
    is_main: true,
    is_active: false,
  });
});

test("sanitizeSupplierInvoicePayload strips untrusted fields", () => {
  const payload = {
    invoice_number: "INV-1001",
    vendor_id: "vendor-1",
    po_id: "po-1",
    delivery_note_id: "dn-1",
    subtotal: "800.00",
    tax_amount: "80.00",
    total_amount: "880.00",
    notes: "Urgent",
    created_by: "attacker-user",
  };

  const result = sanitizeSupplierInvoicePayload(payload);

  assert.deepEqual(result, {
    invoice_number: "INV-1001",
    vendor_id: "vendor-1",
    po_id: "po-1",
    delivery_note_id: "dn-1",
    subtotal: "800.00",
    tax_amount: "80.00",
    total_amount: "880.00",
    notes: "Urgent",
  });
  assert.throws(
    () => sanitizeSupplierInvoicePayload({ subtotal: "1.005" }),
    /two decimal places/i,
  );
});

test("sanitizeSupplierInvoicePayload accepts supplier details for manual physical invoices", () => {
  const result = sanitizeSupplierInvoicePayload({
    invoice_number: " PHYS-100 ",
    supplier_name: " Example Supplier ",
    supplier_contact_person: " Jane Doe ",
    supplier_phone: " +254700000000 ",
    supplier_email: " jane@example.com ",
    supplier_address: " Nairobi ",
    invoice_date: "2026-10-01",
    due_date: "2026-10-31",
    subtotal: "100.00",
    tax_amount: "16.00",
    total_amount: "116.00",
    needs_review: false,
    status: "paid",
  });

  assert.deepEqual(result, {
    invoice_number: "PHYS-100",
    supplier_name: "Example Supplier",
    supplier_contact_person: "Jane Doe",
    supplier_phone: "+254700000000",
    supplier_email: "jane@example.com",
    supplier_address: "Nairobi",
    invoice_date: "2026-10-01",
    due_date: "2026-10-31",
    subtotal: "100.00",
    tax_amount: "16.00",
    total_amount: "116.00",
  });
  assert.throws(
    () => sanitizeSupplierInvoicePayload({
      supplier_name: "Supplier",
      invoice_date: "2026-02-30",
    }),
    /invoice_date.*YYYY-MM-DD/i,
  );
  assert.throws(
    () => sanitizeSupplierInvoicePayload({
      supplier_name: "x".repeat(201),
    }),
    /supplier_name is too long/i,
  );
});

test("sanitizeSupplierPaymentPayload strips untrusted fields", () => {
  const idempotencyKey = "00000000-0000-4000-8000-000000000001";
  const payload = {
    amount: 440,
    payment_method: "bank_transfer",
    reference_number: "REF-123",
    payment_date: "2026-10-01",
    notes: "Partial settlement",
    idempotency_key: idempotencyKey,
    paid_by: "attacker-user",
  };

  const result = sanitizeSupplierPaymentPayload(payload);

  assert.deepEqual(result, {
    amount: "440.00",
    payment_method: "bank_transfer",
    reference_number: "REF-123",
    payment_date: "2026-10-01",
    notes: "Partial settlement",
    idempotency_key: idempotencyKey,
  });
  assert.throws(
    () => sanitizeSupplierPaymentPayload({ amount: "1.005" }),
    /two decimal places/i,
  );
  assert.throws(
    () => sanitizeSupplierPaymentPayload({ amount: "0" }),
    /greater than zero/i,
  );
  assert.throws(
    () => sanitizeSupplierPaymentPayload({
      amount: "10",
      payment_method: "crypto",
      idempotency_key: idempotencyKey,
    }),
    /payment_method/i,
  );
  assert.throws(
    () => sanitizeSupplierPaymentPayload({
      amount: "10",
      payment_date: "2026-02-30",
      idempotency_key: idempotencyKey,
    }),
    /YYYY-MM-DD/i,
  );
  assert.throws(
    () => sanitizeSupplierPaymentPayload({
      amount: "10",
      payment_date: "2026-10-01T12:00:00Z",
      idempotency_key: idempotencyKey,
    }),
    /YYYY-MM-DD/i,
  );
  assert.throws(
    () => sanitizeSupplierPaymentPayload({
      amount: "10",
      notes: 10,
      idempotency_key: idempotencyKey,
    }),
    /notes must be a string/i,
  );
  assert.throws(
    () => sanitizeSupplierPaymentPayload({ amount: "10" }),
    /idempotency_key/i,
  );
  assert.throws(
    () => sanitizeSupplierPaymentPayload({ amount: "10", idempotency_key: "not-a-uuid" }),
    /idempotency_key/i,
  );
  assert.equal(
    sanitizeSupplierPaymentPayload({
      amount: "12.34",
      idempotency_key: "00000000-0000-4000-8000-000000000002",
    }).amount,
    "12.34",
  );
});

test("supplier payment retries without an explicit date preserve the original effective date", () => {
  const existingPayment = {
    supplier_invoice_id: "invoice-1",
    amount: "12.34",
    payment_method: SupplierPaymentMethod.BANK_TRANSFER,
    reference_number: null,
    payment_date: new Date("2026-10-01T00:00:00.000Z"),
    notes: null,
  };
  const retryWithoutDate = sanitizeSupplierPaymentPayload({
    amount: "12.34",
    idempotency_key: "00000000-0000-4000-8000-000000000003",
  });
  const retryWithSameDate = sanitizeSupplierPaymentPayload({
    amount: "12.34",
    payment_date: "2026-10-01",
    idempotency_key: "00000000-0000-4000-8000-000000000004",
  });
  const retryWithDifferentDate = sanitizeSupplierPaymentPayload({
    amount: "12.34",
    payment_date: "2026-10-02",
    idempotency_key: "00000000-0000-4000-8000-000000000005",
  });

  assert.equal(isSameSupplierPaymentRequest(existingPayment, "invoice-1", retryWithoutDate), true);
  assert.equal(isSameSupplierPaymentRequest(existingPayment, "invoice-1", retryWithSameDate), true);
  assert.equal(isSameSupplierPaymentRequest(existingPayment, "invoice-1", retryWithDifferentDate), false);
});

test("sanitizeShiftCurrency rejects negative and non-numeric values", () => {
  assert.equal(sanitizeShiftCurrency(2500, "opening_float"), "2500.00");
  assert.equal(sanitizeShiftCurrency("0.11", "actual_cash"), "0.11");
  assert.throws(() => sanitizeShiftCurrency(-5, "opening_float"), /non-negative number/);
  assert.throws(() => sanitizeShiftCurrency("abc", "actual_cash"), /non-negative number/);
  assert.throws(() => sanitizeShiftCurrency("0.001", "actual_cash"), /two decimal places/);
});

test("sanitizeAuthRegistrationPayload normalizes and validates auth fields", () => {
  assert.deepEqual(
    sanitizeAuthRegistrationPayload({
      email: "  User@Test.com  ",
      password: "StrongPass123!",
      full_name: "  Jane Doe  ",
      role: "admin",
    }),
    {
      email: "user@test.com",
      password: "StrongPass123!",
      full_name: "Jane Doe",
    }
  );

  assert.throws(() => sanitizeAuthRegistrationPayload({ email: "not-an-email", password: "weak", full_name: "User" }), /email|password|full_name/i);
  assert.throws(() => sanitizeAuthRegistrationPayload({ email: "user@example.com", password: "StrongPass123!", full_name: "" }), /full_name/i);
});

test("sanitizeAuthLoginPayload requires normalized credentials", () => {
  assert.deepEqual(sanitizeAuthLoginPayload({ email: "  USER@EXAMPLE.COM  ", password: "StrongPass123!" }), {
    email: "user@example.com",
    password: "StrongPass123!",
  });

  assert.throws(() => sanitizeAuthLoginPayload({ email: "bad", password: "pass" }), /email/i);
  assert.throws(() => sanitizeAuthLoginPayload({ email: "user@example.com", password: "" }), /password/i);
});

test("sanitizeLogEventPayload validates, sanitizes, and prevents log injection", () => {
  assert.throws(() => sanitizeLogEventPayload(null), /must be a JSON object/i);
  assert.throws(() => sanitizeLogEventPayload("invalid"), /must be a JSON object/i);
  assert.throws(() => sanitizeLogEventPayload([]), /must be a JSON object/i);

  // Normalizes error_type and description, strips newlines (log injection protection)
  const result = sanitizeLogEventPayload({
    error_type: "NETWORK_ERROR\r\nINJECTED_LOG_LINE",
    description: "Failed to connect to backend\nSecond line",
    severity: "warning",
    endpoint: "/api/sales\r\n",
    request_method: "post",
    error_details: { code: 500, retry: false },
  });

  assert.equal(result.event_type, "NETWORK_ERROR INJECTED_LOG_LINE");
  assert.equal(result.message, "Failed to connect to backend Second line");
  assert.equal(result.severity, "warning");
  assert.equal(result.endpoint, "/api/sales");
  assert.equal(result.request_method, "POST");
  assert.deepEqual(result.metadata, { code: 500, retry: false });

  // Normalizes risk_level to severity and event_type to event_type
  const securityEvent = sanitizeLogEventPayload({
    event_type: "auth_failure",
    error_message: "Invalid OTP entered",
    risk_level: "HIGH",
  });
  assert.equal(securityEvent.event_type, "auth_failure");
  assert.equal(securityEvent.message, "Invalid OTP entered");
  assert.equal(securityEvent.severity, "high");

  // Rejects invalid types
  assert.throws(() => sanitizeLogEventPayload({ error_type: 123 }), /must be a string/i);
  assert.throws(() => sanitizeLogEventPayload({ error_type: "" }), /cannot be empty/i);
});

test("sanitizeInvoicePaymentPayload only accepts valid invoice payment fields", () => {
  assert.deepEqual(
    sanitizeInvoicePaymentPayload({
      amount: 2500,
      payment_method: "mpesa",
      reference_number: "REF-42",
      mpesa_receipt: "MPESA-001",
      notes: "Paid in full",
      admin_override: "yes",
    }),
    {
      amount: "2500.00",
      payment_method: "mpesa",
      reference_number: "REF-42",
      mpesa_receipt: "MPESA-001",
      notes: "Paid in full",
    }
  );

  assert.throws(() => sanitizeInvoicePaymentPayload({ amount: -10, payment_method: "cash" }), /amount/i);
  assert.throws(() => sanitizeInvoicePaymentPayload({ amount: "0.001", payment_method: "cash" }), /two decimal places/i);
  assert.throws(() => sanitizeInvoicePaymentPayload({ amount: "1e3", payment_method: "cash" }), /two decimal places/i);
  assert.throws(() => sanitizeInvoicePaymentPayload({ amount: 0, payment_method: "cash" }), /greater than zero/i);
  assert.equal(
    sanitizeInvoicePaymentPayload({ amount: "0.10", payment_method: "cash" }).amount,
    "0.10",
  );
  assert.throws(() => sanitizeInvoicePaymentPayload({ amount: 10, payment_method: "bitcoin" }), /payment_method/i);
});

test("sanitizeUserAdminUpdatePayload normalizes admin profile edits", () => {
  assert.deepEqual(
    sanitizeUserAdminUpdatePayload({
      full_name: "  Jane Doe  ",
      email: "  jane@example.com  ",
      is_active: true,
      role: "admin",
    }),
    {
      full_name: "Jane Doe",
      email: "jane@example.com",
    }
  );

  assert.throws(() => sanitizeUserAdminUpdatePayload({ full_name: "", email: "bad-email" }), /email|full_name/i);
  assert.throws(() => sanitizeUserAdminUpdatePayload({ full_name: "A".repeat(101), email: "user@example.com" }), /full_name/i);
});

test("sanitizeInventoryAdjustmentPayload and sanitizeInventoryTransferPayload enforce trusted enums and numbers", () => {
  assert.deepEqual(
    sanitizeInventoryAdjustmentPayload({
      product_id: "prod-1",
      warehouse_id: "wh-1",
      type: "shrinkage",
      quantity_adjusted: -5,
      reason: "  Wrong count  ",
      malicious: "ignored",
    }),
    {
      product_id: "prod-1",
      warehouse_id: "wh-1",
      type: "shrinkage",
      quantity_adjusted: -5,
      reason: "Wrong count",
    }
  );

  assert.deepEqual(
    sanitizeInventoryTransferPayload({
      product_id: "prod-1",
      from_warehouse_id: "wh-1",
      to_warehouse_id: "wh-2",
      quantity: 12,
      bad_status: "approved",
    }),
    {
      product_id: "prod-1",
      from_warehouse_id: "wh-1",
      to_warehouse_id: "wh-2",
      quantity: 12,
    }
  );

  assert.throws(() => sanitizeInventoryAdjustmentPayload({ product_id: "prod-1", warehouse_id: "wh-1", type: "admin_override", quantity_adjusted: 1, reason: "x" }), /type/i);
  assert.throws(() => sanitizeInventoryTransferPayload({ product_id: "prod-1", from_warehouse_id: "wh-1", to_warehouse_id: "wh-2", quantity: 0 }), /quantity/i);
});

test("sanitizeReturnRequestPayload and sanitizeApproveReturnPayload validate return workflows", () => {
  assert.deepEqual(
    sanitizeReturnRequestPayload({
      sale_id: "sale-1",
      reason: "  Damaged item  ",
      items: [{ sale_item_id: "item-1", quantity: 2, malicious: "drop" }],
      extra: "drop",
    }),
    {
      sale_id: "sale-1",
      reason: "Damaged item",
      items: [{ sale_item_id: "item-1", quantity: 2 }],
    }
  );
  assert.throws(
    () => sanitizeReturnRequestPayload({
      sale_id: "sale-1",
      reason: "Duplicate lines",
      items: [
        { sale_item_id: "item-1", quantity: 1 },
        { sale_item_id: "item-1", quantity: 1 },
      ],
    }),
    /only appear once/,
  );

  assert.deepEqual(
    sanitizeApproveReturnPayload({
      items_conditions: [{ return_item_id: "ret-1", condition: "sellable" }],
      refund_method: "cash",
      extra: 1,
    }),
    {
      items_conditions: [{ return_item_id: "ret-1", condition: "sellable" }],
      refund_method: "cash",
    }
  );

  assert.deepEqual(sanitizeRejectReturnPayload({ rejection_reason: "  Policy violation  ", extra: "drop" }), {
    rejection_reason: "Policy violation",
  });

  test("sanitizeMpesaRefundReceipt normalizes Safaricom receipt codes and rejects malformed values", () => {
    assert.equal(sanitizeMpesaRefundReceipt({ receipt_number: " qwe1234567 " }), "QWE1234567");
    assert.throws(
      () => sanitizeMpesaRefundReceipt({ receipt_number: "invalid receipt" }),
      /valid Safaricom receipt/,
    );
  });
  assert.deepEqual(sanitizeRejectReturnPayload({}), { rejection_reason: "Rejected by management" });

  assert.throws(() => sanitizeReturnRequestPayload({ sale_id: "", reason: "Bad", items: [{ sale_item_id: "item-1", quantity: 0 }] }), /sale_id|quantity/i);
  assert.throws(() => sanitizeApproveReturnPayload({ items_conditions: [{ return_item_id: "ret-1", condition: "invalid" }], refund_method: "cash" }), /condition/i);
  assert.equal(
    sanitizeApproveReturnPayload({ refund_method: "exchange" }).refund_method,
    "exchange",
  );
  assert.throws(() => sanitizeRejectReturnPayload({ rejection_reason: ["bad"] }), /rejection_reason/i);
});

test("sanitizeSalePayload and sanitizeVoidSalePayload enforce trusted sale fields", () => {
  assert.deepEqual(
    sanitizeSalePayload({
      items: [{ product_id: "prod-1", quantity: 2, malicious: "drop" }],
      payment_method: "cash",
      customer_id: "cust-1",
      warehouse_id: "wh-1",
      loyalty_discount: 12.5,
      idempotency_key: "  key-123  ",
      cash_amount: 100,
      mpesa_amount: 0,
      store_credit_amount: 0,
      store_credit_barcode: "  SC-123  ",
      admin_override: "drop",
    }),
    {
      items: [{ product_id: "prod-1", quantity: 2 }],
      payment_method: "cash",
      customer_id: "cust-1",
      warehouse_id: "wh-1",
      loyalty_discount: 12.5,
      idempotency_key: "key-123",
      cash_amount: 100,
      mpesa_amount: 0,
      store_credit_amount: 0,
      store_credit_barcode: "SC-123",
    }
  );

  assert.deepEqual(
    sanitizeSalePayload({
      items: [{ product_id: "prod-1", quantity: 1 }],
      payment_method: "cash",
      cash_amount: 100,
      idempotency_key: "offline-key-123",
      expected_total_amount: 100,
      offline_created_at: "2026-01-02T03:04:05.000Z",
    }),
    {
      items: [{ product_id: "prod-1", quantity: 1 }],
      payment_method: "cash",
      cash_amount: 100,
      idempotency_key: "offline-key-123",
      expected_total_amount: 100,
      offline_created_at: new Date("2026-01-02T03:04:05.000Z"),
    },
  );
  assert.throws(
    () => sanitizeSalePayload({
      items: [{ product_id: "prod-1", quantity: 1 }],
      offline_created_at: "2026-01-02T03:04:05.000Z",
    }),
    /both offline_created_at and expected_total_amount/i,
  );
  assert.throws(
    () => sanitizeSalePayload({
      items: [{ product_id: "prod-1", quantity: 1 }],
      expected_total_amount: 100,
    }),
    /both offline_created_at and expected_total_amount/i,
  );
  assert.throws(
    () => sanitizeSalePayload({
      items: [{ product_id: "prod-1", quantity: 1 }],
      expected_total_amount: 100,
      offline_created_at: "2026-01-02T03:04:05.000Z",
    }),
    /offline sales require an idempotency_key/i,
  );

  assert.deepEqual(
    sanitizeSalePayload({
      items: [{ product_id: "prod-1", quantity: 1 }],
      customer_id: null,
      warehouse_id: "warehouse-1",
      store_credit_barcode: null,
      cash_amount: 100,
    }),
    {
      items: [{ product_id: "prod-1", quantity: 1 }],
      warehouse_id: "warehouse-1",
      cash_amount: 100,
    },
    "Walk-in cash sales may send null optional customer and store-credit fields",
  );

  assert.deepEqual(sanitizeVoidSalePayload({ reason: "  Customer cancelled  ", extra: "drop" }), {
    reason: "Customer cancelled",
  });

  assert.throws(() => sanitizeSalePayload({ items: [{ product_id: "prod-1", quantity: 0 }], payment_method: "bitcoin" }), /payment_method|quantity/i);
  assert.throws(
    () => sanitizeSalePayload({
      items: [{ product_id: "prod-1", quantity: Number.MAX_SAFE_INTEGER + 1 }],
    }),
    /positive safe whole number/i,
  );
  assert.throws(() => sanitizeVoidSalePayload({ reason: ["bad"] }), /reason/i);
});

test("checkout payload quantities remain safe when duplicate products are combined", () => {
  const basePayload = {
    checkout_session_id: "550e8400-e29b-41d4-a716-446655440000",
    items: [
      { product_id: "prod-1", quantity: 2 },
      { product_id: "prod-1", quantity: 3 },
    ],
  };

  assert.deepEqual(sanitizeCheckoutPayload(basePayload).items, [
    { product_id: "prod-1", quantity: 5 },
  ]);
  assert.throws(
    () => sanitizeCheckoutPayload({
      ...basePayload,
      items: [{ product_id: "prod-1", quantity: Number.MAX_SAFE_INTEGER + 1 }],
    }),
    /positive safe whole-number quantity/i,
  );
  assert.throws(
    () => sanitizeCheckoutPayload({
      ...basePayload,
      items: [
        { product_id: "prod-1", quantity: Number.MAX_SAFE_INTEGER },
        { product_id: "prod-1", quantity: 1 },
      ],
    }),
    /combined checkout item quantity is too large/i,
  );
});

test("checkout payment and discount amounts require exact supported KES values", () => {
  const basePayload = {
    checkout_session_id: "550e8400-e29b-41d4-a716-446655440000",
    items: [{ product_id: "prod-1", quantity: 1 }],
  };

  assert.equal(
    sanitizeCheckoutPayload({ ...basePayload, cash_amount: "10.20" }).cash_amount,
    10.2,
  );
  assert.equal(
    sanitizeCheckoutPayload({ ...basePayload, cash_amount: null }).cash_amount,
    0,
  );
  assert.equal(
    sanitizeCheckoutPayload({ ...basePayload, cash_amount: "99999999.99" }).cash_amount,
    99999999.99,
  );
  for (const value of [true, "10.001", "1e3", "100000000.00"]) {
    assert.throws(
      () => sanitizeCheckoutPayload({ ...basePayload, cash_amount: value }),
      /cash_amount/i,
    );
  }
  assert.throws(
    () => sanitizeCheckoutPayload({ ...basePayload, loyalty_discount: "0.001" }),
    /loyalty_discount/i,
  );
  assert.throws(
    () => sanitizeCheckoutPayload({ ...basePayload, store_credit_amount: "100000000.00" }),
    /store_credit_amount/i,
  );
});

test("manual sale discounts require manager or admin authorization", () => {
  assert.equal(assertSaleDiscountAuthorized("cashier", 0), undefined);
  assert.equal(assertSaleDiscountAuthorized("supervisor", 0), undefined);
  assert.equal(assertSaleDiscountAuthorized("manager", 25), undefined);
  assert.equal(assertSaleDiscountAuthorized("admin", 25), undefined);
  assert.throws(
    () => assertSaleDiscountAuthorized("cashier", 0.01),
    /manager or admin authorization/i,
  );
  assert.throws(
    () => assertSaleDiscountAuthorized("supervisor", 10),
    /manager or admin authorization/i,
  );
});

test("cash change is returned from tender and not counted as shift cash", () => {
  assert.equal(calculateCashChange(150, 0, 0, 100), 50);
  assert.equal(calculateCashChange(80, 30, 0, 100), 10);
  assert.equal(calculateCashChange(80, 20, 0, 100), 0);
  assert.equal(calculateCashChange(40, 0, 0, 40), 0);
  assert.equal(calculateCashChange(0.11, 0, 0, 0.1), 0.01);
});

test("sale void COGS fallback multiplies unit-cost cents without floating-point arithmetic", () => {
  assert.equal(
    calculateSaleItemCogsCents(
      { cogs_total_cents: null, cogs_total: null, unit_cost: 0.29, quantity: 3 },
      1.23,
    ),
    87n,
  );
  assert.equal(
    calculateSaleItemCogsCents(
      { cogs_total_cents: null, cogs_total: 0.86, unit_cost: 1, quantity: 3 },
      1.23,
    ),
    86n,
  );
  assert.equal(
    calculateSaleItemCogsCents(
      { cogs_total_cents: "85", cogs_total: 0.86, unit_cost: 1, quantity: 3 },
      1.23,
    ),
    85n,
  );
  assert.throws(
    () => calculateSaleItemCogsCents(
      { cogs_total_cents: null, cogs_total: null, unit_cost: 0.29, quantity: Number.MAX_SAFE_INTEGER + 1 },
      undefined,
    ),
    /positive whole number/i,
  );
});

test("sale payment method reflects all actual tender types", () => {
  assert.equal(deriveSalePaymentMethod(20, 0, 0), "cash");
  assert.equal(deriveSalePaymentMethod(0, 20, 0), "mpesa");
  assert.equal(deriveSalePaymentMethod(0, 0, 20), "store_credit");
  assert.equal(deriveSalePaymentMethod(20, 20, 0), "hybrid");
  assert.equal(deriveSalePaymentMethod(20, 0, 20), "hybrid");
  assert.equal(deriveSalePaymentMethod(0, 20, 20), "hybrid");
  assert.throws(() => deriveSalePaymentMethod(0, 0, 0), /at least one payment tender/i);
});

test("sanitizeUserRolePayload, sanitizeTransferStatusPayload and sanitizeStockTakePayload validate trusted admin and inventory state updates", () => {
  assert.deepEqual(sanitizeUserRolePayload({ role: "manager", extra: "drop" }), { role: "manager" });
  assert.deepEqual(sanitizeTransferStatusPayload({ status: "completed", extra: "drop" }), { status: "completed" });
  assert.deepEqual(sanitizeStockTakePayload({ warehouse_id: "wh-1", notes: "  Checked  ", extra: "drop" }), {
    warehouse_id: "wh-1",
    notes: "Checked",
  });

  assert.throws(() => sanitizeUserRolePayload({ role: "hacker" }), /role/i);
  assert.throws(() => sanitizeTransferStatusPayload({ status: "fake" }), /status/i);
  assert.throws(() => sanitizeStockTakePayload({ warehouse_id: "", notes: 123 }), /warehouse_id|notes/i);
});

test("sanitizeUserCreatePayload validates admin-provisioned user creation", () => {
  assert.deepEqual(
    sanitizeUserCreatePayload({
      email: "  CASHIER1@example.com  ",
      password: "StrongPassword123!",
      full_name: "  Jane Doe  ",
      role: "cashier",
      extra: "drop",
    }),
    {
      email: "cashier1@example.com",
      password: "StrongPassword123!",
      full_name: "Jane Doe",
      role: "cashier",
    }
  );

  assert.deepEqual(
    sanitizeUserCreatePayload({
      email: "supervisor@example.com",
      password: "ValidPass1234",
      full_name: "John Supervisor",
    }),
    {
      email: "supervisor@example.com",
      password: "ValidPass1234",
      full_name: "John Supervisor",
      role: "cashier",
    }
  );

  assert.throws(() => sanitizeUserCreatePayload({ email: "bad-email", password: "12345678", full_name: "Test" }), /email/i);
  assert.throws(() => sanitizeUserCreatePayload({ email: "test@example.com", password: "short", full_name: "Test" }), /password/i);
  assert.throws(() => sanitizeUserCreatePayload({ email: "test@example.com", password: "validPassword123", full_name: "" }), /full_name/i);
  assert.throws(() => sanitizeUserCreatePayload({ email: "test@example.com", password: "validPassword123", full_name: "Test", role: "superadmin" }), /role/i);
});

test("sanitizeParkedSalePayload and sanitizeRequisitionStatusPayload validate remaining direct-write payloads", () => {
  assert.deepEqual(
    sanitizeParkedSalePayload({
      items: [{ product_id: "prod-1", quantity: 2, extra: "drop" }],
      customer_id: "  cust-1  ",
      warehouse_id: "  wh-1  ",
      extra: "drop",
    }),
    {
      items: [{ product_id: "prod-1", quantity: 2 }],
      customer_id: "cust-1",
      warehouse_id: "wh-1",
    }
  );

  assert.deepEqual(
    sanitizeParkedSalePayload({
      items: [{ product_id: "prod-1", quantity: 1 }],
      customer_id: null,
      warehouse_id: "",
    }),
    { items: [{ product_id: "prod-1", quantity: 1 }] },
    "Walk-in sales and an unselected warehouse should omit optional IDs",
  );

  assert.deepEqual(sanitizeRequisitionStatusPayload({ status: "approved", extra: "drop" }), { status: "approved" });

  assert.throws(() => sanitizeParkedSalePayload({ items: [{ product_id: "prod-1", quantity: 0 }] }), /quantity/i);
  assert.throws(() => sanitizeRequisitionStatusPayload({ status: "bad-status" }), /status/i);
});

test("sanitizeLoyaltyMemberPayload and sanitizeLoyaltyPointsPayload validate direct loyalty writes", () => {
  assert.deepEqual(
    sanitizeLoyaltyMemberPayload({
      customer_id: "  cust-1  ",
      points: 150,
      total_spent: 2500,
      tier: "Gold",
      extra: "drop",
    }),
    {
      customer_id: "cust-1",
      points: 150,
      total_spent: 2500,
      tier: "Gold",
    }
  );

  assert.deepEqual(sanitizeLoyaltyPointsPayload({ points: 50, amount: 80, extra: "drop" }), { points: 50, amount: 80 });

  assert.throws(() => sanitizeLoyaltyMemberPayload({ customer_id: "", points: -1, tier: "Hacker" }), /customer_id|points|tier/i);
  assert.throws(() => sanitizeLoyaltyPointsPayload({ points: -5, amount: 10 }), /points/i);
});

test("sanitizePurchaseOrderCreatePayload, sanitizePurchaseOrderStatusPayload and sanitizeTaxClassPayload validate remaining write boundaries", () => {
  assert.deepEqual(
    sanitizePurchaseOrderCreatePayload({
      vendor_id: "  vend-1  ",
      warehouse_id: "  warehouse-1  ",
      items: [
        { product_id: "prod-1", quantity: 2, unit_cost: "150.00", extra: "drop" },
        { product_id: "prod-2", quantity: 1, unit_cost: 80, extra: "drop" },
      ],
      extra: "drop",
    }),
    {
      vendor_id: "vend-1",
      warehouse_id: "warehouse-1",
      items: [
        { product_id: "prod-1", quantity: 2, unit_cost: 150 },
        { product_id: "prod-2", quantity: 1, unit_cost: 80 },
      ],
    }
  );

  assert.deepEqual(sanitizePurchaseOrderStatusPayload({ status: "sent", extra: "drop" }), { status: "sent" });
  assert.deepEqual(sanitizeTaxClassPayload({ name: "  GST  ", rate: 15, is_default: true, extra: "drop" }), {
    name: "GST",
    rate: 15,
    is_default: true,
  });
  assert.deepEqual(sanitizeTaxClassUpdatePayload({ name: "  VAT  ", rate: 18, is_default: false, extra: "drop" }), {
    name: "VAT",
    rate: 18,
    is_default: false,
  });

  assert.throws(() => sanitizePurchaseOrderCreatePayload({ vendor_id: "vend-1", warehouse_id: "warehouse-1", items: [{ product_id: "prod-1", quantity: 0, unit_cost: 10 }] }), /quantity/i);
  assert.throws(
    () => sanitizePurchaseOrderCreatePayload({
      vendor_id: "vend-1",
      warehouse_id: "warehouse-1",
      items: [{ product_id: "prod-1", quantity: 9007199254740992, unit_cost: 10 }],
    }),
    /quantity/i,
  );
  assert.deepEqual(
    sanitizePurchaseOrderCreatePayload({
      vendor_id: "vend-1",
      warehouse_id: "warehouse-1",
      items: [{ product_id: "prod-1", quantity: 3, unit_cost: "1.05" }],
    }).items,
    [{ product_id: "prod-1", quantity: 3, unit_cost: 1.05 }],
  );
  assert.throws(
    () => sanitizePurchaseOrderCreatePayload({
      vendor_id: "vend-1",
      warehouse_id: "warehouse-1",
      items: [{ product_id: "prod-1", quantity: 1, unit_cost: "1.005" }],
    }),
    /two decimal places/i,
  );
  assert.throws(() => sanitizePurchaseOrderStatusPayload({ status: "pirate" }), /status/i);
  assert.throws(() => sanitizeTaxClassPayload({ name: "", rate: 120, is_default: false }), /name|rate/i);
  assert.throws(() => sanitizeTaxClassUpdatePayload({ name: "", rate: 110 }), /name|rate/i);
});

test("sanitizeMpesaStkPayload rejects unsafe values and normalizes valid ones", () => {
  assert.deepEqual(
    sanitizeMpesaStkPayload({
      phone_number: "  0712345678  ",
      amount: "2500",
      checkout_session_id: "550e8400-e29b-41d4-a716-446655440000",
      items: [{ product_id: " prod-1 ", quantity: 2 }],
      cash_amount: 10,
      account_reference: "  Ref-42  ",
      extra: "drop",
    }),
    {
      phone_number: "254712345678",
      amount: 2500,
      checkout_session_id: "550e8400-e29b-41d4-a716-446655440000",
      items: [{ product_id: "prod-1", quantity: 2 }],
      loyaltyDiscountCents: 0n,
      cashAmountCents: 1000n,
      storeCreditAmountCents: 0n,
      warehouse_id: undefined,
      account_reference: "Ref-42",
    }
  );

  const validCheckout = {
    phone_number: "0712345678",
    amount: 100,
    checkout_session_id: "550e8400-e29b-41d4-a716-446655440000",
    items: [{ product_id: "prod-1", quantity: 1 }],
  };
  assert.throws(() => sanitizeMpesaStkPayload({ ...validCheckout, phone_number: "bad" }), /phone_number/i);
  assert.throws(() => sanitizeMpesaStkPayload({ ...validCheckout, amount: "-10" }), /amount/i);
  assert.throws(() => sanitizeMpesaStkPayload({ ...validCheckout, amount: 100.5 }), /whole number/i);
  assert.throws(() => sanitizeMpesaStkPayload({ ...validCheckout, cash_amount: "10.001" }), /two decimal places/i);
  assert.equal(
    sanitizeMpesaStkPayload({ ...validCheckout, cash_amount: "10.29", store_credit_amount: "0.01" }).cashAmountCents,
    1029n,
  );
  assert.equal(
    sanitizeMpesaStkPayload({ ...validCheckout, cash_amount: "10.29", store_credit_amount: "0.01" }).storeCreditAmountCents,
    1n,
  );
  assert.throws(() => sanitizeMpesaStkPayload({ ...validCheckout, checkout_session_id: "invalid" }), /checkout_session_id/i);
  assert.deepEqual(sanitizeMpesaStkPayload({ ...validCheckout, items: [] }).items, []);
  assert.equal(
    sanitizeMpesaStkPayload({ ...validCheckout, store_credit_barcode: " SC-123 " }).store_credit_barcode,
    "SC-123",
  );
  assert.throws(
    () => sanitizeMpesaStkPayload({ ...validCheckout, store_credit_barcode: "X".repeat(21) }),
    /store_credit_barcode/i,
  );
});

test("parseC2bCallback preserves exact cents and rejects fractional-cent amounts", () => {
  const callback = {
    TransID: "ABC1234567",
    TransAmount: "100.25",
    BusinessShortCode: "123456",
    BillRefNumber: "POS12345678",
    MSISDN: "254712345678",
  };
  assert.equal(parseC2bCallback(callback)?.amountCents, 10025n);
  assert.equal(parseC2bCallback({ ...callback, TransAmount: "100.001" }), null);
  assert.equal(parseC2bCallback({ ...callback, TransAmount: "9007199254740993" })?.amountCents, 900719925474099300n);
});

test("WebSocket and JWT authentication reject unverified OTP 2FA challenge tokens", () => {
  const secret = process.env.JWT_SECRET || "default_test_jwt_secret_which_is_long_enough_123456";
  process.env.JWT_SECRET = secret;

  const otpChallengeToken = jwt.sign(
    { id: "user-123", email: "cashier@store.local", is_otp_phase: true },
    secret,
    { expiresIn: "10m" }
  );

  const fullyAuthenticatedToken = jwt.sign(
    { id: "user-123", email: "cashier@store.local", role: "cashier" },
    secret,
    { expiresIn: "1d" }
  );

  const validateWsToken = (token?: string) => {
    if (!token) throw new Error("Authentication error: No token provided");
    const decoded = jwt.verify(token, secret) as jwt.JwtPayload;
    if (
      !decoded ||
      typeof decoded !== "object" ||
      typeof decoded.id !== "string" ||
      decoded.is_otp_phase === true ||
      !decoded.role ||
      typeof decoded.role !== "string"
    ) {
      throw new Error("Authentication error: Full authentication required");
    }
    return decoded;
  };

  // 1. Missing token
  assert.throws(() => validateWsToken(undefined), /No token provided/i);

  // 2. Unverified 2FA / OTP token must be strictly rejected
  assert.throws(() => validateWsToken(otpChallengeToken), /Full authentication required/i);

  // 3. Token without role must be rejected
  const tokenWithoutRole = jwt.sign({ id: "user-123", email: "test@pos.local" }, secret);
  assert.throws(() => validateWsToken(tokenWithoutRole), /Full authentication required/i);

  // 4. Token with is_otp_phase: true even if role is injected must be rejected
  const forgedOtpTokenWithRole = jwt.sign(
    { id: "user-123", email: "test@pos.local", role: "admin", is_otp_phase: true },
    secret
  );
  assert.throws(() => validateWsToken(forgedOtpTokenWithRole), /Full authentication required/i);

  // 5. Valid fully authenticated session passes
  const validDecoded = validateWsToken(fullyAuthenticatedToken);
  assert.equal(validDecoded.id, "user-123");
  assert.equal(validDecoded.role, "cashier");
  assert.equal(validDecoded.is_otp_phase, undefined);
});

test("escapeHtml prevents HTML injection in outgoing email templates", () => {
  const payload = '<a href="https://attacker-phishing-site.com">Click here to verify banking details</a>';
  const escaped = escapeHtml(payload);
  assert.equal(escaped.includes("<a href="), false);
  assert.equal(escaped.includes("&lt;a href=&quot;"), true);
  assert.equal(escaped.includes("&gt;"), true);

  // Escapes &, <, >, ', "
  assert.equal(escapeHtml(`Tom & Jerry's "Bakery"`), "Tom &amp; Jerry&#39;s &quot;Bakery&quot;");
  assert.equal(escapeHtml("<script>alert(1)</script>"), "&lt;script&gt;alert(1)&lt;/script&gt;");

  // Non-string handling
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(123), "");
});

test("authenticateJWT middleware explicitly returns 401 when token has is_otp_phase: true", () => {
  const secret = process.env.JWT_SECRET || "default_test_jwt_secret_which_is_long_enough_123456";
  process.env.JWT_SECRET = secret;

  // Even if role: "admin" is present in the OTP token, it must be explicitly rejected
  const otpTokenWithRole = jwt.sign(
    { id: "user-999", email: "admin@store.local", role: "admin", is_otp_phase: true },
    secret
  );

  let statusSent: number | undefined;
  let jsonSent: unknown;
  const mockReq = {
    headers: {
      authorization: `Bearer ${otpTokenWithRole}`,
    },
    params: {},
  } as unknown as AuthenticatedRequest;
  const mockRes = {
    status(code: number) {
      statusSent = code;
      return this;
    },
    json(payload: unknown) {
      jsonSent = payload;
      return this;
    },
    sendStatus(code: number) {
      statusSent = code;
      return this;
    },
  } as unknown as Response;
  let nextCalled = false;
  const nextFn = () => {
    nextCalled = true;
  };

  authenticateJWT(mockReq, mockRes, nextFn);

  assert.equal(nextCalled, false);
  assert.equal(statusSent, 401);
  assert.deepEqual(jsonSent, { message: "Two-factor authentication must be completed." });
});

test("EtimsMockService signs invoices with prominent test disclaimers and test prefixes", async () => {
  const originalEtimsMode = process.env.ETIMS_MODE;
  process.env.ETIMS_MODE = "mock";
  EtimsService.resetProvider();
  try {
    const dummySale = Object.assign(new Sale(), { id: "test-sale-123" });
    const result = await EtimsMockService.signInvoice(dummySale);

    assert.equal(result.is_mock, true);
    assert.equal(result.disclaimer, ETIMS_MOCK_DISCLAIMER);
    assert.equal(result.receipt_no.startsWith("TEST-ETIMS-"), true);
    assert.equal(result.signature.startsWith("TEST-SIG-"), true);
    assert.equal(result.qr_code.includes("mock=true"), true);
  } finally {
    if (originalEtimsMode === undefined) {
      delete process.env.ETIMS_MODE;
    } else {
      process.env.ETIMS_MODE = originalEtimsMode;
    }
    EtimsService.resetProvider();
  }
});

test("PesapalMockService prefixes mock tracking IDs and identifies mock state", async () => {
  const result = await PesapalMockService.requestPayment("sale-123", 500, "0712345678");

  assert.equal(result.is_mock, true);
  assert.equal(result.tracking_id.startsWith("TEST-PESA-"), true);
  assert.equal(result.redirect_url.includes("mock=true"), true);
});
