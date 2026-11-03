import { Button } from "@/components/ui/button";
import { Download } from "lucide-react";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";

interface GRNItem {
  product_name: string;
  sku: string;
  ordered_quantity: number;
  received_quantity: number;
  rejected_quantity: number;
  unit_cost: number | string;
  line_total: number | string;
  batch_number?: string;
  expiry_date?: string;
}

interface GRNInvoiceData {
  grn_number: string;
  po_number: string;
  vendor_name: string;
  delivery_date: string;
  total_value: number | string;
  total_items: number;
  items: GRNItem[];
  notes?: string;
}

interface GRNInvoiceDownloadProps {
  data: GRNInvoiceData;
  className?: string;
}

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });

export function GRNInvoiceDownload({
  data,
  className,
}: GRNInvoiceDownloadProps) {
  const generateInvoiceHTML = () => {
    const itemsRows = data.items
      .map(
        (item) => `
      <tr>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb;">${escapeHtml(item.product_name)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; font-family: monospace;">${escapeHtml(item.sku)}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: center;">${item.ordered_quantity}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: center; color: #16a34a; font-weight: 600;">${item.received_quantity}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: center; color: ${item.rejected_quantity > 0 ? "#dc2626" : "#6b7280"};">${item.rejected_quantity || "-"}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: right;">${formatKesCents(parseKesToCents(String(item.unit_cost)))}</td>
        <td style="padding: 10px; border-bottom: 1px solid #e5e7eb; text-align: right; font-weight: 600;">${formatKesCents(parseKesToCents(String(item.line_total)))}</td>
      </tr>
    `,
      )
      .join("");

    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Goods Received Note - ${escapeHtml(data.grn_number)}</title>
        <style>
          @media print {
            body { margin: 0; }
            .no-print { display: none; }
          }
          body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.5;
            color: #1f2937;
            max-width: 800px;
            margin: 0 auto;
            padding: 40px 20px;
          }
          .header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 40px;
            padding-bottom: 20px;
            border-bottom: 2px solid #2563eb;
          }
          .title {
            font-size: 28px;
            font-weight: 700;
            color: #2563eb;
            margin: 0;
          }
          .subtitle {
            color: #6b7280;
            margin: 5px 0 0 0;
          }
          .grn-number {
            text-align: right;
          }
          .grn-number h2 {
            font-size: 14px;
            color: #6b7280;
            margin: 0;
            font-weight: 400;
          }
          .grn-number p {
            font-size: 20px;
            font-weight: 700;
            color: #1f2937;
            margin: 5px 0 0 0;
            font-family: monospace;
          }
          .info-grid {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 30px;
            background: #f9fafb;
            padding: 20px;
            border-radius: 8px;
          }
          .info-item label {
            display: block;
            font-size: 12px;
            color: #6b7280;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            margin-bottom: 4px;
          }
          .info-item p {
            margin: 0;
            font-weight: 600;
            color: #1f2937;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 30px;
          }
          thead {
            background: #f3f4f6;
          }
          th {
            padding: 12px 10px;
            text-align: left;
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: #6b7280;
            font-weight: 600;
          }
          .totals {
            display: flex;
            justify-content: flex-end;
            margin-bottom: 30px;
          }
          .totals-box {
            background: #f0fdf4;
            border: 1px solid #86efac;
            border-radius: 8px;
            padding: 20px;
            min-width: 250px;
          }
          .totals-row {
            display: flex;
            justify-content: space-between;
            margin-bottom: 8px;
          }
          .totals-row.total {
            font-size: 20px;
            font-weight: 700;
            color: #16a34a;
            border-top: 2px solid #86efac;
            padding-top: 10px;
            margin-top: 10px;
            margin-bottom: 0;
          }
          .notes {
            background: #fefce8;
            border: 1px solid #fde047;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 30px;
          }
          .notes h4 {
            margin: 0 0 8px 0;
            font-size: 14px;
            color: #854d0e;
          }
          .notes p {
            margin: 0;
            color: #713f12;
          }
          .footer {
            text-align: center;
            padding-top: 30px;
            border-top: 1px solid #e5e7eb;
            color: #6b7280;
            font-size: 12px;
          }
          .signature-section {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 40px;
            margin-top: 50px;
          }
          .signature-box {
            border-top: 1px solid #1f2937;
            padding-top: 10px;
            text-align: center;
          }
          .signature-box p {
            margin: 0;
            font-size: 12px;
            color: #6b7280;
          }
        </style>
      </head>
      <body>
        <div class="header">
          <div>
            <h1 class="title">Goods Received Note</h1>
            <p class="subtitle">Purchase Receipt Document</p>
          </div>
          <div class="grn-number">
            <h2>GRN Number</h2>
            <p>${escapeHtml(data.grn_number)}</p>
          </div>
        </div>

        <div class="info-grid">
          <div class="info-item">
            <label>Vendor</label>
            <p>${escapeHtml(data.vendor_name)}</p>
          </div>
          <div class="info-item">
            <label>PO Number</label>
            <p>${escapeHtml(data.po_number)}</p>
          </div>
          <div class="info-item">
            <label>Delivery Date</label>
            <p>${new Date(data.delivery_date).toLocaleDateString("en-KE", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}</p>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Product</th>
              <th>SKU</th>
              <th style="text-align: center;">Ordered</th>
              <th style="text-align: center;">Received</th>
              <th style="text-align: center;">Rejected</th>
              <th style="text-align: right;">Unit Cost</th>
              <th style="text-align: right;">Line Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows}
          </tbody>
        </table>

        <div class="totals">
          <div class="totals-box">
            <div class="totals-row">
              <span>Total Items:</span>
              <span>${data.total_items}</span>
            </div>
            <div class="totals-row total">
              <span>Total Value:</span>
              <span>${formatKesCents(parseKesToCents(String(data.total_value)))}</span>
            </div>
          </div>
        </div>

        ${
          data.notes
            ? `
          <div class="notes">
            <h4>Delivery Notes</h4>
            <p>${escapeHtml(data.notes)}</p>
          </div>
        `
            : ""
        }

        <div class="signature-section">
          <div class="signature-box">
            <p>Received By (Signature & Date)</p>
          </div>
          <div class="signature-box">
            <p>Verified By (Signature & Date)</p>
          </div>
        </div>

        <div class="footer">
          <p>This document serves as proof of goods received. Please retain for your records.</p>
          <p>Generated on ${new Date().toLocaleString("en-KE")}</p>
        </div>
      </body>
      </html>
    `;
  };

  const handleDownload = () => {
    const html = generateInvoiceHTML();
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);

    // Open in new window for printing/saving
    const printWindow = window.open(url, "_blank");
    if (printWindow) {
      printWindow.onload = () => {
        printWindow.print();
      };
    }

    // Cleanup
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <Button onClick={handleDownload} variant="outline" className={className}>
      <Download className="h-4 w-4 mr-2" />
      Download GRN Invoice
    </Button>
  );
}
