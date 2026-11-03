export interface SupplierInvoiceOcrFields {
  invoice_number?: string;
  supplier_name?: string;
  invoice_date?: string;
  due_date?: string;
  subtotal?: string;
  tax_amount?: string;
  total_amount?: string;
}

const findLabeledValue = (lines: string[], label: RegExp): string | undefined => {
  for (const line of lines) {
    const match = line.match(label);
    if (match?.[1]?.trim()) return match[1].trim();
  }
  return undefined;
};

const normalizeInvoiceDate = (value?: string): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  let year: number;
  let month: number;
  let day: number;

  const iso = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  const local = trimmed.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (iso) {
    [, year, month, day] = iso.map(Number) as [number, number, number, number];
  } else if (local) {
    [, day, month, year] = local.map(Number) as [number, number, number, number];
  } else {
    return undefined;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const findAmount = (lines: string[], label: RegExp): string | undefined => {
  for (const line of lines) {
    if (!label.test(line)) continue;
    const amounts = line
      .replace(/\d+(?:\.\d+)?\s*%/g, "")
      .match(/(?<![\d,.])\d[\d,]*(?:\.\d{1,2})?(?![\d.])/g);
    const amount = amounts?.[amounts.length - 1];
    if (!amount) continue;
    const normalized = amount.replace(/,/g, "");
    const numeric = Number(normalized);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return numeric.toFixed(2);
    }
  }
  return undefined;
};

export const parseSupplierInvoiceOcrText = (text: string): SupplierInvoiceOcrFields => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  const invoiceNumber = findLabeledValue(
    lines,
    /\b(?:invoice|inv|bill)\s*(?:(?:number|no\.?|id)\s*[:#-]?\s*|#\s*|[:#-]\s*)([A-Z0-9][A-Z0-9/-]{2,})\b/i,
  );
  const supplierName = findLabeledValue(
    lines,
    /\b(?:supplier|vendor|company|business)\s*(?:name)?\s*[:#-]\s*(.{2,200})/i,
  );
  const invoiceDateText = findLabeledValue(
    lines,
    /\b(?:invoice\s+date|date\s+of\s+invoice|issued\s+on)\s*[:#-]?\s*(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/i,
  );
  const dueDateText = findLabeledValue(
    lines,
    /\b(?:due\s+date|payment\s+due|pay\s+by)\s*[:#-]?\s*(\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})/i,
  );

  const subtotal = findAmount(lines, /\b(?:sub\s*total|subtotal|net\s+amount)\b/i);
  const taxAmount = findAmount(lines, /\b(?:vat|tax)\b/i);
  const totalAmount = findAmount(lines, /\b(?:grand\s+total|invoice\s+total|total\s+payable|amount\s+due|total)\b/i);

  const invoiceDate = normalizeInvoiceDate(invoiceDateText);
  const dueDate = normalizeInvoiceDate(dueDateText);
  return {
    ...(invoiceNumber ? { invoice_number: invoiceNumber.replace(/[.,;:]$/, "") } : {}),
    ...(supplierName ? { supplier_name: supplierName.replace(/[|]+/g, " ").trim() } : {}),
    ...(invoiceDate ? { invoice_date: invoiceDate } : {}),
    ...(dueDate ? { due_date: dueDate } : {}),
    ...(subtotal !== undefined ? { subtotal } : {}),
    ...(taxAmount !== undefined ? { tax_amount: taxAmount } : {}),
    ...(totalAmount !== undefined ? { total_amount: totalAmount } : {}),
  };
};
