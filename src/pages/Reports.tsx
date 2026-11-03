import { useCallback, useState, useEffect, useRef } from "react";
import { ApiService } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Download,
  TrendingUp,
  DollarSign,
  Package,
  AlertTriangle,
  CalendarIcon,
} from "lucide-react";
import {
  format,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  startOfQuarter,
  endOfQuarter,
  startOfYear,
  endOfYear,
} from "date-fns";
import { useAuth } from "@/hooks/useAuthContext";
import { InventoryAlerts } from "@/components/InventoryAlerts";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
} from "recharts";

interface SalesByPayment {
  method: string;
  count: number;
  totalCents: string;
}

interface TopProduct {
  product_id: string;
  name: string;
  sku: string;
  total_quantity: number;
  revenueCents?: string | null;
  costOfGoodsSoldCents?: string | null;
  grossProfitCents?: string | null;
}

interface LowStockProduct {
  id: string;
  name: string;
  sku: string;
  stock_on_hand: number;
  reorder_level: number;
}

interface CashierPerformance {
  cashier_id: string;
  name: string;
  totalCents: string;
  count: number;
  discountsCents?: string;
  refundsCents?: string;
  profitContributionCents?: string | null;
  refundTransactions?: number;
}

interface HourlySales {
  hour: number;
  salesCents: string;
  transactions: number;
  refundsCents?: string;
  refundTransactions?: number;
  activeDays: number;
}

interface HeatmapDay {
  weekday: number;
  hours: HourlySales[];
}

interface ProfitAndLoss {
  grossSalesCents: string;
  discountsCents: string;
  refundsCents: string;
  netRevenueCents: string;
  taxCollectedCents: string;
  costOfGoodsSoldCents: string | null;
  grossProfitCents: string | null;
  operatingExpensesCents: string;
  inventoryLossesCents: string;
  transactionCostsCents: string | null;
  netProfitCents: string | null;
  lossesCents: string | null;
  costDataComplete: boolean;
  netProfitUnavailableReason: string | null;
}

interface UnrecordedProcessingFeeSale {
  sale_id: string;
  created_at: string;
  payment_method: string;
  mpesa_amount: string;
  total_amount: string;
}

interface RecordedProcessingFee {
  sale_id: string;
  fee_id: string;
  fee_cents: string;
  recoverable_vat_cents: string;
  incurred_date: string;
  statement_reference: string;
  transaction_reference: string | null;
  revision: number;
}

interface ProcessingFeeEntry {
  incurred_date: string;
  fee_amount: string;
  recoverable_vat: string;
  statement_reference: string;
  transaction_reference: string;
  reason: string;
}

interface ReportSummary {
  salesByPayment: SalesByPayment[];
  topProducts: TopProduct[];
  lowStock: LowStockProduct[];
  cashierPerformance: CashierPerformance[];
  profitAndLoss?: ProfitAndLoss;
  comparison?: { currentSalesCents: string; previousSalesCents: string; salesChangeCents: string; salesChangePercentBasisPoints: string | null; transactions: number; currentTransactions: number; previousStart: string; previousEnd: string };
  history?: { activeDays: number; transactions: number };
  salesByHour?: HourlySales[];
  salesByWeekday?: Array<{ weekday: number; salesCents: string; transactions: number; refundsCents: string; activeDays: number }>;
  salesHeatmap?: HeatmapDay[];
  salesTrend?: Array<{ period: string; salesCents: string; transactions: number; refundsCents: string }>;
  hourlyDemand?: {
    peak?: HourlySales;
    slow?: HourlySales;
    minimumSamples: number;
  };
}

interface ProfitabilityRow {
  product_id: string | null;
  product: string | null;
  sku: string | null;
  category_id: string | null;
  category: string | null;
  day: string | null;
  month: string | null;
  quantity_sold: string;
  net_revenue_cents: string | null;
  cogs_cents: string | null;
  gross_profit_cents: string | null;
  margin_basis_points: string | null;
  data_complete: boolean;
  missing_revenue_count: number;
  missing_vat_count: number;
  missing_cogs_count: number;
}

interface CostingReport {
  purchases: Array<{
    product_id: string;
    sku: string;
    product: string;
    category_id: string | null;
    category: string | null;
    supplier_id: string | null;
    supplier: string | null;
    quantity: string;
    cost_cents: string;
  }>;
  purchases_total_cents: string;
  stock_valuation: Array<{
    warehouse_id: string;
    warehouse: string;
    product_id: string;
    sku: string;
    product: string;
    category_id: string | null;
    category: string | null;
    quantity: number;
    value_cents: string | null;
  }>;
  stock_value_total_cents: string | null;
  stock_value_data_available: boolean;
  stock_value_verified: boolean;
  profitability: Record<"product" | "category" | "day" | "month" | "overall", ProfitabilityRow[]>;
  supplier_profitability: {
    available: boolean;
    method: string;
    note: string;
    by_supplier: SupplierProfitabilityRow[];
    by_supplier_product: SupplierProfitabilityRow[];
    by_day: SupplierProfitabilityRow[];
    by_month: SupplierProfitabilityRow[];
    overall: SupplierProfitabilityRow[];
  };
  reconciliation: {
    balanced: boolean;
    available: boolean;
    baseline_verified?: boolean;
    message: string;
    opening_value_cents?: string;
    purchase_value_cents?: string;
    cogs_cents?: string;
    write_offs_cents?: string;
    expected_closing_value_cents?: string;
    actual_closing_value_cents?: string | null;
    difference_cents: string | null;
    scope_note?: string;
  };
}

interface SupplierProfitabilityRow {
  supplier_id: string | null;
  supplier: string;
  product_id: string | null;
  product: string | null;
  sku: string | null;
  category_id: string | null;
  category: string | null;
  day: string | null;
  month: string | null;
  quantity_sold: string;
  net_revenue_cents: string | null;
  fifo_cost_cents: string | null;
  gross_profit_cents: string | null;
  margin_basis_points: string | null;
  data_complete: boolean;
  supplier_attribution_complete: boolean;
}

interface CostingFilterOptions {
  warehouses: Array<{ id: string; name: string }>;
  products: Array<{ id: string; name: string; sku: string }>;
  categories: Array<{ id: string; name: string }>;
  suppliers: Array<{ id: string; name: string }>;
}

interface InventoryPeriodClose {
  id: string;
  period_end_date: string;
  opening_value_cents: string;
  purchase_value_cents: string;
  cogs_cents: string;
  write_offs_cents: string;
  adjustments_cents: string;
  closing_value_cents: string;
  closed_at: string;
  closed_by_name: string;
}

interface BaselineVerificationRow {
  warehouse_stock_id: string;
  warehouse_id: string;
  warehouse_name: string;
  product_id: string;
  sku: string;
  product_name: string;
  quantity: number;
  current_value_cents: string | null;
}

interface BaselineVerificationPreview {
  previous_baseline_at: string;
  previous_valuation_method: string;
  rows: BaselineVerificationRow[];
}

const formatCents = (value: string | null | undefined) => {
  if (value == null) return "Unavailable";
  const cents = BigInt(value);
  const absolute = cents < 0n ? -cents : cents;
  const whole = new Intl.NumberFormat("en-KE").format(absolute / 100n);
  const fraction = String(absolute % 100n).padStart(2, "0");
  return `${cents < 0n ? "-" : ""}KSh ${whole}.${fraction}`;
};

const formatCentsInput = (value: string | null | undefined) => {
  if (value == null || !/^\d+$/.test(value)) return "";
  const cents = BigInt(value);
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
};

const parseCentsInput = (value: string): string | null => {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return String(BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0") || "0"));
};

const formatMarginBasisPoints = (value: string | null | undefined) => {
  if (value == null) return "Unavailable";
  const basisPoints = BigInt(value);
  const sign = basisPoints < 0n ? "-" : "";
  const absolute = basisPoints < 0n ? -basisPoints : basisPoints;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}%`;
};

const formatSignedBasisPoints = (value: string | null) => {
  if (value === null) return "No prior sales";
  const basisPoints = BigInt(value);
  const sign = basisPoints > 0n ? "+" : basisPoints < 0n ? "-" : "";
  const absolute = basisPoints < 0n ? -basisPoints : basisPoints;
  return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}%`;
};

const ProfitabilityTable = ({
  title,
  labelHeader,
  rows,
  label,
}: {
  title: string;
  labelHeader: string;
  rows: ProfitabilityRow[];
  label: (row: ProfitabilityRow) => string;
}) => (
  <Card>
    <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
    <CardContent className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{labelHeader}</TableHead>
            <TableHead className="text-right">Qty sold (net of returns)</TableHead>
            <TableHead className="text-right">Net revenue</TableHead>
            <TableHead className="text-right">COGS</TableHead>
            <TableHead className="text-right">Gross profit</TableHead>
            <TableHead className="text-right">Margin</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow key={`${row.product_id || row.category_id || row.day || row.month || "overall"}-${index}`}>
              <TableCell>
                {label(row)}
                {!row.data_complete && (
                  <span className="block text-xs text-destructive">
                    Missing snapshots: {[
                      row.missing_revenue_count > 0 && `${row.missing_revenue_count} revenue`,
                      row.missing_vat_count > 0 && `${row.missing_vat_count} VAT`,
                      row.missing_cogs_count > 0 && `${row.missing_cogs_count} COGS`,
                    ].filter(Boolean).join(", ") || "historical cost coverage"}
                  </span>
                )}
              </TableCell>
              <TableCell className="text-right">{row.quantity_sold}</TableCell>
              <TableCell className="text-right">{formatCents(row.net_revenue_cents)}</TableCell>
              <TableCell className="text-right">{formatCents(row.cogs_cents)}</TableCell>
              <TableCell className="text-right">{formatCents(row.gross_profit_cents)}</TableCell>
              <TableCell className="text-right">{formatMarginBasisPoints(row.margin_basis_points)}</TableCell>
            </TableRow>
          ))}
          {rows.length === 0 && (
            <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No sales or returns were recorded in this period.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </CardContent>
  </Card>
);

export default function Reports() {
  const { userRole } = useAuth();
  const canViewFinancials = userRole === "manager" || userRole === "admin";
  const isAdmin = userRole === "admin";
  const [salesByPayment, setSalesByPayment] = useState<SalesByPayment[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [lowStock, setLowStock] = useState<LowStockProduct[]>([]);
  const [cashierPerformance, setCashierPerformance] = useState<CashierPerformance[]>([]);
  const [analytics, setAnalytics] = useState<ReportSummary | null>(null);
  const [costingReport, setCostingReport] = useState<CostingReport | null>(null);
  const [costingError, setCostingError] = useState("");
  const [periodCloses, setPeriodCloses] = useState<InventoryPeriodClose[]>([]);
  const [periodCloseDate, setPeriodCloseDate] = useState(() => {
    const yesterday = new Date();
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return yesterday.toISOString().slice(0, 10);
  });
  const [periodCloseBusy, setPeriodCloseBusy] = useState(false);
  const [periodCloseMessage, setPeriodCloseMessage] = useState("");
  const [periodCloseError, setPeriodCloseError] = useState("");
  const [baselinePreview, setBaselinePreview] = useState<BaselineVerificationPreview | null>(null);
  const [baselineValues, setBaselineValues] = useState<Record<string, string>>({});
  const [baselineCounts, setBaselineCounts] = useState<Record<string, string>>({});
  const [baselineEvidenceReference, setBaselineEvidenceReference] = useState("");
  const [baselineReason, setBaselineReason] = useState("");
  const [physicalCountsConfirmed, setPhysicalCountsConfirmed] = useState(false);
  const [baselineVerificationBusy, setBaselineVerificationBusy] = useState(false);
  const [baselineVerificationError, setBaselineVerificationError] = useState("");
  const [baselineVerificationMessage, setBaselineVerificationMessage] = useState("");
  const [costingFilterOptions, setCostingFilterOptions] = useState<CostingFilterOptions>({
    warehouses: [], products: [], categories: [], suppliers: [],
  });
  const [costingFilters, setCostingFilters] = useState({
    warehouse_id: "", product_id: "", category_id: "", supplier_id: "",
  });
  const [reportError, setReportError] = useState("");
  const [unrecordedFeeSales, setUnrecordedFeeSales] = useState<UnrecordedProcessingFeeSale[]>([]);
  const [recordedProcessingFees, setRecordedProcessingFees] = useState<RecordedProcessingFee[]>([]);
  const [processingFeeEntries, setProcessingFeeEntries] = useState<Record<string, ProcessingFeeEntry>>({});
  const [processingFeeError, setProcessingFeeError] = useState("");
  const [processingFeeMessage, setProcessingFeeMessage] = useState("");
  const [processingFeeLoading, setProcessingFeeLoading] = useState(false);
  const [processingFeeBusySaleId, setProcessingFeeBusySaleId] = useState("");
  const requestSequence = useRef(0);
  const [dateRange, setDateRange] = useState("today");
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(
    new Date(),
  );
  const [customDateMode, setCustomDateMode] = useState(false);
  const [rangeMode, setRangeMode] = useState<"day" | "week" | "month" | "quarter" | "year">(
    "day",
  );
  const [customStartDate, setCustomStartDate] = useState("");
  const [customEndDate, setCustomEndDate] = useState("");
  const [startHour, setStartHour] = useState("");
  const [endHour, setEndHour] = useState("");

  const getStartDate = useCallback((range: string) => {
    if (customDateMode && selectedDate) {
      let startDate: Date;

      switch (rangeMode) {
        case "day":
          startDate = new Date(selectedDate);
          startDate.setHours(0, 0, 0, 0);
          return startDate.toISOString();
        case "week":
          startDate = startOfWeek(selectedDate, { weekStartsOn: 1 }); // Monday
          return startDate.toISOString();
        case "month":
          startDate = startOfMonth(selectedDate);
          return startDate.toISOString();
        case "quarter":
          startDate = startOfQuarter(selectedDate);
          return startDate.toISOString();
        case "year":
          startDate = startOfYear(selectedDate);
          return startDate.toISOString();
        default:
          startDate = new Date(selectedDate);
          startDate.setHours(0, 0, 0, 0);
          return startDate.toISOString();
      }
    }

    const now = new Date();
    switch (range) {
      case "today":
        now.setHours(0, 0, 0, 0);
        return now.toISOString();
      case "week":
        return startOfWeek(now, { weekStartsOn: 1 }).toISOString();
      case "month":
        return startOfMonth(now).toISOString();
      case "quarter":
        return startOfQuarter(now).toISOString();
      case "year":
        return startOfYear(now).toISOString();
      case "custom":
        if (customStartDate) return new Date(`${customStartDate}T00:00:00`).toISOString();
        return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      default:
        return now.toISOString();
    }
  }, [customDateMode, customStartDate, rangeMode, selectedDate]);

  const getEndDate = useCallback(() => {
    if (!customDateMode || !selectedDate) {
      const now = new Date();
      switch (dateRange) {
        case "today":
          return now.toISOString();
        case "week":
        case "month":
        case "quarter":
        case "year":
          return now.toISOString();
        case "custom": {
          const end = customEndDate ? new Date(`${customEndDate}T00:00:00`) : new Date(now.getFullYear(), now.getMonth(), now.getDate());
          end.setDate(end.getDate() + 1);
          return end.toISOString();
        }
        default:
          return now.toISOString();
      }
    }

    let endDate: Date;
    switch (rangeMode) {
      case "day":
        endDate = new Date(selectedDate);
        endDate.setHours(0, 0, 0, 0);
        endDate.setDate(endDate.getDate() + 1);
        return endDate.toISOString();
      case "week":
        endDate = endOfWeek(selectedDate, { weekStartsOn: 1 });
        endDate.setHours(0, 0, 0, 0);
        endDate.setDate(endDate.getDate() + 1);
        return endDate.toISOString();
      case "month":
        endDate = endOfMonth(selectedDate);
        endDate.setHours(0, 0, 0, 0);
        endDate.setDate(endDate.getDate() + 1);
        return endDate.toISOString();
      case "quarter":
        endDate = endOfQuarter(selectedDate);
        endDate.setHours(0, 0, 0, 0);
        endDate.setDate(endDate.getDate() + 1);
        return endDate.toISOString();
      case "year":
        endDate = endOfYear(selectedDate);
        endDate.setHours(0, 0, 0, 0);
        endDate.setDate(endDate.getDate() + 1);
        return endDate.toISOString();
      default:
        endDate = new Date(selectedDate);
        endDate.setHours(23, 59, 59, 999);
        return endDate.toISOString();
    }
  }, [customDateMode, customEndDate, dateRange, rangeMode, selectedDate]);

  const loadReports = useCallback(async () => {
    const requestSequenceId = ++requestSequence.current;
    setReportError("");
    try {
      if (dateRange === "custom" && !customDateMode && (!customStartDate || !customEndDate)) {
        setAnalytics(null);
        setReportError("Choose both dates for the custom range.");
        return;
      }
      if ((startHour || endHour) && (!startHour || !endHour || startHour === endHour)) {
        setAnalytics(null);
        setReportError("Choose two distinct hours for the time filter.");
        return;
      }
      const startDate = getStartDate(dateRange);
      const endDate = getEndDate();
      if (new Date(startDate) >= new Date(endDate)) {
        setSalesByPayment([]);
        setTopProducts([]);
        setLowStock([]);
        setCashierPerformance([]);
        setAnalytics(null);
        return;
      }
      setAnalytics(null);
      setCostingReport(null);
      setCostingError("");
      const query = new URLSearchParams({ start: startDate, end: endDate });
      query.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
      if (startHour && endHour) {
        query.set("hourStart", startHour.slice(0, 2));
        query.set("hourEnd", endHour.slice(0, 2));
      }
      const report = await ApiService.get<ReportSummary>(
        `/reports/summary?${query.toString()}`,
      );
      if (requestSequenceId !== requestSequence.current) return;
      setAnalytics(canViewFinancials ? report : {
        salesByPayment: report.salesByPayment,
        topProducts: report.topProducts,
        lowStock: report.lowStock,
        cashierPerformance: [],
      });
      setSalesByPayment(report.salesByPayment || []);
      setTopProducts(report.topProducts || []);
      setLowStock(report.lowStock || []);
      setCashierPerformance(canViewFinancials ? report.cashierPerformance || [] : []);
      if (canViewFinancials) {
        try {
          const costingQuery = new URLSearchParams({
            start_date: format(new Date(startDate), "yyyy-MM-dd"),
            end_date: format(new Date(new Date(endDate).getTime() - 1), "yyyy-MM-dd"),
            time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          });
          for (const [name, value] of Object.entries(costingFilters)) {
            if (value) costingQuery.set(name, value);
          }
          const costing = await ApiService.get<CostingReport>(`/reports/costing?${costingQuery.toString()}`);
          if (requestSequenceId === requestSequence.current) {
            setCostingReport(costing);
            if (Object.values(costingFilters).every((value) => !value)) {
              setCostingFilterOptions({
                warehouses: [...new Map(costing.stock_valuation.map((row) => [row.warehouse_id, { id: row.warehouse_id, name: row.warehouse }])).values()],
                products: [...new Map([
                  ...costing.stock_valuation.map((row) => [row.product_id, { id: row.product_id, name: row.product, sku: row.sku }] as const),
                  ...costing.purchases.map((row) => [row.product_id, { id: row.product_id, name: row.product, sku: row.sku }] as const),
                ]).values()],
                categories: [...new Map([
                  ...costing.stock_valuation.flatMap((row) => row.category_id ? [[row.category_id, { id: row.category_id, name: row.category || "" }] as const] : []),
                  ...costing.purchases.flatMap((row) => row.category_id ? [[row.category_id, { id: row.category_id, name: row.category || "" }] as const] : []),
                ]).values()],
                suppliers: [...new Map(costing.purchases.flatMap((row) => row.supplier_id ? [[row.supplier_id, { id: row.supplier_id, name: row.supplier || "" }] as const] : [])).values()],
              });
            }
          }
          const closes = await ApiService.get<InventoryPeriodClose[]>("/reports/costing/closes");
          if (requestSequenceId === requestSequence.current) setPeriodCloses(closes);
        } catch (error) {
          console.error("Error loading costing report:", error);
          if (requestSequenceId === requestSequence.current) {
            setCostingReport(null);
            setCostingError("Costing reports could not be loaded. Check your connection and try again.");
          }
        }
      }
    } catch (error) {
      console.error("Error loading reports:", error);
      if (requestSequenceId === requestSequence.current) {
        setAnalytics(null);
        setReportError("Reports could not be loaded. Check your connection and try again.");
      }
    }
  }, [canViewFinancials, costingFilters, customDateMode, customEndDate, customStartDate, dateRange, endHour, getEndDate, getStartDate, startHour]);

  const loadUnrecordedProcessingFees = async () => {
    setProcessingFeeLoading(true);
    setProcessingFeeError("");
    setProcessingFeeMessage("");
    try {
      const startDate = getStartDate(dateRange);
      const endDate = getEndDate();
      const query = new URLSearchParams({
        start_date: format(new Date(startDate), "yyyy-MM-dd"),
        end_date: format(new Date(new Date(endDate).getTime() - 1), "yyyy-MM-dd"),
      });
      const [missingResult, recordedResult] = await Promise.all([
        ApiService.get<{ sales: UnrecordedProcessingFeeSale[] }>(
        `/admin/reports/payment-fees?${query.toString()}`,
        ),
        ApiService.get<{ fees: RecordedProcessingFee[] }>(`/admin/payment-fees?${query.toString()}`),
      ]);
      setUnrecordedFeeSales(missingResult.sales);
      setRecordedProcessingFees(recordedResult.fees);
      setProcessingFeeEntries((current) => {
        const next = { ...current };
        for (const sale of missingResult.sales) {
          next[sale.sale_id] = current[sale.sale_id] || {
            incurred_date: "",
            fee_amount: "",
            recoverable_vat: "",
            statement_reference: "",
            transaction_reference: "",
            reason: "",
          };
        }
        for (const fee of recordedResult.fees) {
          next[fee.sale_id] = {
            incurred_date: fee.incurred_date.slice(0, 10),
            fee_amount: formatCentsInput(fee.fee_cents),
            recoverable_vat: formatCentsInput(fee.recoverable_vat_cents),
            statement_reference: fee.statement_reference,
            transaction_reference: fee.transaction_reference || "",
            reason: current[fee.sale_id]?.reason || "",
          };
        }
        return next;
      });
      if (missingResult.sales.length === 0) {
        setProcessingFeeMessage("No electronic payments are missing a fee record in this period.");
      }
    } catch (error) {
      console.error("Loading missing electronic payment fee records failed:", error);
      setProcessingFeeError(error instanceof Error ? error.message : "Unable to load missing provider fees.");
    } finally {
      setProcessingFeeLoading(false);
    }
  };

  const updateProcessingFeeEntry = (saleId: string, field: keyof ProcessingFeeEntry, value: string) => {
    setProcessingFeeEntries((current) => ({
      ...current,
      [saleId]: { ...current[saleId], [field]: value },
    }));
  };

  const submitProcessingFee = async (saleId: string) => {
    const entry = processingFeeEntries[saleId];
    if (!entry) return;
    const feeCents = parseCentsInput(entry.fee_amount);
    const recoverableVatCents = parseCentsInput(entry.recoverable_vat);
    if (!entry.incurred_date || feeCents == null || recoverableVatCents == null ||
      !entry.statement_reference.trim()) {
      setProcessingFeeError("Enter the statement fee date, total fee, recoverable VAT, and statement reference.");
      return;
    }
    if (BigInt(recoverableVatCents) > BigInt(feeCents)) {
      setProcessingFeeError("Recoverable VAT cannot exceed the total provider fee.");
      return;
    }
    setProcessingFeeBusySaleId(saleId);
    setProcessingFeeError("");
    setProcessingFeeMessage("");
    try {
      await ApiService.post("/admin/payment-fees", {
        sale_id: saleId,
        incurred_date: entry.incurred_date,
        fee_cents: feeCents,
        recoverable_vat_cents: recoverableVatCents,
        statement_reference: entry.statement_reference.trim(),
        transaction_reference: entry.transaction_reference.trim() || null,
      });
      await loadUnrecordedProcessingFees();
      await loadReports();
      setProcessingFeeMessage("Fee recorded against its provider statement and posted to accounting.");
    } catch (error) {
      console.error("Recording electronic payment fee failed:", error);
      setProcessingFeeError(error instanceof Error ? error.message : "Unable to record provider fee.");
    } finally {
      setProcessingFeeBusySaleId("");
    }
  };

  const submitProcessingFeeCorrection = async (saleId: string) => {
    const entry = processingFeeEntries[saleId];
    if (!entry) return;
    const feeCents = parseCentsInput(entry.fee_amount);
    const recoverableVatCents = parseCentsInput(entry.recoverable_vat);
    if (!entry.incurred_date || feeCents == null || recoverableVatCents == null ||
      !entry.statement_reference.trim() || entry.reason.trim().length < 5) {
      setProcessingFeeError("Enter the corrected statement fee date, whole-cent amounts, statement reference, and reason (at least 5 characters).");
      return;
    }
    if (BigInt(recoverableVatCents) > BigInt(feeCents)) {
      setProcessingFeeError("Recoverable VAT cannot exceed the total provider fee.");
      return;
    }
    setProcessingFeeBusySaleId(saleId);
    setProcessingFeeError("");
    setProcessingFeeMessage("");
    try {
      await ApiService.post(`/admin/payment-fees/${encodeURIComponent(saleId)}/corrections`, {
        incurred_date: entry.incurred_date,
        fee_cents: feeCents,
        recoverable_vat_cents: recoverableVatCents,
        statement_reference: entry.statement_reference.trim(),
        transaction_reference: entry.transaction_reference.trim() || null,
        reason: entry.reason.trim(),
      });
      await loadUnrecordedProcessingFees();
      await loadReports();
      setProcessingFeeMessage("Correction recorded. The prior accounting posting was reversed and the corrected fee was posted in the correction period.");
    } catch (error) {
      console.error("Correcting electronic payment fee failed:", error);
      setProcessingFeeError(error instanceof Error ? error.message : "Unable to correct provider fee.");
    } finally {
      setProcessingFeeBusySaleId("");
    }
  };

  const closeInventoryPeriod = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(periodCloseDate) ||
        periodCloseDate >= new Date().toISOString().slice(0, 10)) {
      setPeriodCloseError("Choose a completed UTC date to close.");
      return;
    }
    if (!window.confirm(`Close inventory reconciliation for ${periodCloseDate}? This close is permanent.`)) return;
    setPeriodCloseBusy(true);
    setPeriodCloseError("");
    setPeriodCloseMessage("");
    try {
      const result = await ApiService.post<InventoryPeriodClose>("/reports/costing/closes", {
        end_date: periodCloseDate,
      });
      setPeriodCloseMessage(`Period ${result.period_end_date} closed and reconciled.`);
      setPeriodCloses(await ApiService.get<InventoryPeriodClose[]>("/reports/costing/closes"));
    } catch (error) {
      console.error("Inventory period close failed:", error);
      setPeriodCloseError(error instanceof Error ? error.message : "Period close failed");
    } finally {
      setPeriodCloseBusy(false);
    }
  };

  const loadBaselineVerification = async () => {
    setBaselineVerificationBusy(true);
    setBaselineVerificationError("");
    setBaselineVerificationMessage("");
    try {
      const preview = await ApiService.get<BaselineVerificationPreview>("/admin/costing-baseline-verification");
      setBaselinePreview(preview);
      setBaselineValues(Object.fromEntries(
        preview.rows.map((row) => [row.warehouse_stock_id, formatCentsInput(row.current_value_cents)]),
      ));
      setBaselineCounts(Object.fromEntries(preview.rows.map((row) => [row.warehouse_stock_id, ""])));
      setPhysicalCountsConfirmed(false);
    } catch (error) {
      console.error("Opening stock valuation preview failed:", error);
      setBaselineVerificationError(error instanceof Error ? error.message : "Unable to load stocktake rows.");
    } finally {
      setBaselineVerificationBusy(false);
    }
  };

  const submitBaselineVerification = async () => {
    if (!baselinePreview) return;
    if (!baselineEvidenceReference.trim() || !baselineReason.trim()) {
      setBaselineVerificationError("Enter the stocktake evidence reference and verification reason.");
      return;
    }
    if (!physicalCountsConfirmed) {
      setBaselineVerificationError("Confirm that the physical stocktake quantities match every displayed book quantity.");
      return;
    }
    const rows = baselinePreview.rows.map((row) => {
      const valuationCents = parseCentsInput(baselineValues[row.warehouse_stock_id] || "");
      const countedQuantity = baselineCounts[row.warehouse_stock_id];
      if (!/^(0|[1-9]\d*)$/.test(countedQuantity || "")) return null;
      return valuationCents == null ? null : {
        warehouse_stock_id: row.warehouse_stock_id,
        counted_quantity: Number(countedQuantity),
        valuation_cents: valuationCents,
      };
    });
    if (rows.some((row) => row == null)) {
      setBaselineVerificationError("Enter a valid non-negative KSh amount with no more than two decimal places for every row.");
      return;
    }
    if (!window.confirm(
      "This records a current, evidence-referenced opening valuation for future reconciliation only. It does not reconstruct historical costs or alter closed periods. Continue?",
    )) return;

    setBaselineVerificationBusy(true);
    setBaselineVerificationError("");
    setBaselineVerificationMessage("");
    try {
      const result = await ApiService.post<{
        verification_id: string;
        baseline_at: string;
        line_count: number;
        total_value_cents: string;
      }>("/admin/costing-baseline-verification", {
        evidence_reference: baselineEvidenceReference.trim(),
        reason: baselineReason.trim(),
        physical_counts_confirmed: physicalCountsConfirmed,
        rows,
      });
      setBaselineVerificationMessage(
        `Opening valuation verified for ${result.line_count} warehouse/product rows at ${formatCents(result.total_value_cents)}. Future period reconciliation is now available.`,
      );
      setBaselinePreview(null);
      setBaselineValues({});
      setBaselineCounts({});
      setBaselineEvidenceReference("");
      setBaselineReason("");
      setPhysicalCountsConfirmed(false);
      await loadReports();
    } catch (error) {
      console.error("Opening stock valuation verification failed:", error);
      setBaselineVerificationError(error instanceof Error ? error.message : "Opening valuation verification failed.");
    } finally {
      setBaselineVerificationBusy(false);
    }
  };

  useEffect(() => {
    void loadReports();
  }, [loadReports]);

  const peakHour = analytics?.hourlyDemand?.peak;
  const slowHour = analytics?.hourlyDemand?.slow;
  const heatmapCents = (analytics?.salesHeatmap || []).flatMap((day) => day.hours.map((hour) => BigInt(hour.salesCents)));
  const maxHeatmapSales = heatmapCents.reduce((max, value) => value > max ? value : max, 1n);

  const handleDateSelect = (date: Date | undefined) => {
    setSelectedDate(date);
    setCustomDateMode(true);
    setDateRange("custom");
  };

  const getDateRangeLabel = () => {
    if (!customDateMode || !selectedDate) return "Select Range";

    switch (rangeMode) {
      case "day":
        return format(selectedDate, "PPP");
      case "week":
        {
        const weekStart = startOfWeek(selectedDate, { weekStartsOn: 1 });
        const weekEnd = endOfWeek(selectedDate, { weekStartsOn: 1 });
        return `${format(weekStart, "MMM d")} - ${format(weekEnd, "MMM d, yyyy")}`;
        }
      case "month":
        return format(selectedDate, "MMMM yyyy");
      case "quarter":
        return `Q${Math.floor(selectedDate.getMonth() / 3) + 1} ${format(selectedDate, "yyyy")}`;
      case "year":
        return format(selectedDate, "yyyy");
      default:
        return format(selectedDate, "PPP");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Reports</h1>
          <p className="text-muted-foreground">
            Business analytics and insights
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={
              dateRange === "today" && !customDateMode ? "default" : "outline"
            }
            onClick={() => {
              setDateRange("today");
              setCustomDateMode(false);
            }}
            size="sm"
          >
            Today
          </Button>
          <Button
            variant={
              dateRange === "week" && !customDateMode ? "default" : "outline"
            }
            onClick={() => {
              setDateRange("week");
              setCustomDateMode(false);
            }}
            size="sm"
          >
            This Week
          </Button>
          <Button
            variant={
              dateRange === "month" && !customDateMode ? "default" : "outline"
            }
            onClick={() => {
              setDateRange("month");
              setCustomDateMode(false);
            }}
            size="sm"
          >
            This Month
          </Button>
          <Button
            variant={dateRange === "quarter" && !customDateMode ? "default" : "outline"}
            onClick={() => {
              setDateRange("quarter");
              setCustomDateMode(false);
            }}
            size="sm"
          >
            This Quarter
          </Button>
          <Button
            variant={dateRange === "year" && !customDateMode ? "default" : "outline"}
            onClick={() => {
              setDateRange("year");
              setCustomDateMode(false);
            }}
            size="sm"
          >
            This Year
          </Button>
          <Button
            variant={dateRange === "custom" && !customDateMode ? "default" : "outline"}
            onClick={() => {
              setDateRange("custom");
              setCustomDateMode(false);
            }}
            size="sm"
          >
            Custom dates
          </Button>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant={customDateMode ? "default" : "outline"}
                size="sm"
              >
                <CalendarIcon className="mr-2 h-4 w-4" />
                {getDateRangeLabel()}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-4" align="end">
              <div className="space-y-4">
                <div className="flex gap-2">
                  {(["day", "week", "month", "quarter", "year"] as const).map((mode) => (
                    <Button key={mode} size="sm" variant={rangeMode === mode ? "default" : "outline"} onClick={() => setRangeMode(mode)}>
                      {mode[0].toUpperCase() + mode.slice(1)}
                    </Button>
                  ))}
                </div>
                <Calendar
                  mode="single"
                  selected={selectedDate}
                  onSelect={handleDateSelect}
                  initialFocus
                  className="pointer-events-auto"
                />
                <p className="text-xs text-muted-foreground text-center">
                  Viewing{" "}
                  {rangeMode === "day" ? "single day" : `entire ${rangeMode}`}
                </p>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {dateRange === "custom" && !customDateMode && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-sm text-muted-foreground" htmlFor="report-start-date">From</label>
          <input id="report-start-date" type="date" className="h-9 rounded-md border bg-background px-3 text-sm" value={customStartDate} onChange={(event) => setCustomStartDate(event.target.value)} />
          <label className="text-sm text-muted-foreground" htmlFor="report-end-date">Through</label>
          <input id="report-end-date" type="date" className="h-9 rounded-md border bg-background px-3 text-sm" min={customStartDate || undefined} value={customEndDate} onChange={(event) => setCustomEndDate(event.target.value)} />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">Optional hours (local time)</span>
        <label className="sr-only" htmlFor="report-hour-start">Starting hour</label>
        <input id="report-hour-start" type="time" step="3600" className="h-9 rounded-md border bg-background px-2 text-sm" value={startHour} onChange={(event) => setStartHour(event.target.value)} />
        <span className="text-sm text-muted-foreground">to</span>
        <label className="sr-only" htmlFor="report-hour-end">Ending hour</label>
        <input id="report-hour-end" type="time" step="3600" className="h-9 rounded-md border bg-background px-2 text-sm" value={endHour} onChange={(event) => setEndHour(event.target.value)} />
        {(startHour || endHour) && <span className="text-xs text-muted-foreground">Choose both distinct hours. End time is exclusive; overnight ranges are supported.</span>}
      </div>
      {reportError && <p role="alert" className="text-sm text-destructive">{reportError}</p>}
      {costingError && <p role="alert" className="text-sm text-destructive">{costingError}</p>}
      {canViewFinancials && (
        <div className="flex flex-wrap gap-3">
          <select aria-label="Filter costing and profitability by warehouse" className="h-9 rounded-md border bg-background px-3 text-sm" value={costingFilters.warehouse_id} onChange={(event) => setCostingFilters((filters) => ({ ...filters, warehouse_id: event.target.value }))}>
            <option value="">All warehouses</option>{costingFilterOptions.warehouses.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
          <select aria-label="Filter costing and profitability by product" className="h-9 rounded-md border bg-background px-3 text-sm" value={costingFilters.product_id} onChange={(event) => setCostingFilters((filters) => ({ ...filters, product_id: event.target.value }))}>
            <option value="">All products</option>{costingFilterOptions.products.map((option) => <option key={option.id} value={option.id}>{option.name} ({option.sku})</option>)}
          </select>
          <select aria-label="Filter costing and profitability by category" className="h-9 rounded-md border bg-background px-3 text-sm" value={costingFilters.category_id} onChange={(event) => setCostingFilters((filters) => ({ ...filters, category_id: event.target.value }))}>
            <option value="">All categories</option>{costingFilterOptions.categories.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
          <select aria-label="Filter costing and profitability by supplier" className="h-9 rounded-md border bg-background px-3 text-sm" value={costingFilters.supplier_id} onChange={(event) => setCostingFilters((filters) => ({ ...filters, supplier_id: event.target.value }))}>
            <option value="">All suppliers</option>{costingFilterOptions.suppliers.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </div>
      )}

      <Tabs defaultValue="sales" className="w-full">
        <TabsList>
          <TabsTrigger value="sales">Sales</TabsTrigger>
          {analytics?.profitAndLoss && <TabsTrigger value="profit">Profit & Loss</TabsTrigger>}
          {analytics?.salesByHour && <TabsTrigger value="demand">Peak & Slow Periods</TabsTrigger>}
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
          {canViewFinancials && <TabsTrigger value="performance">Cashier Performance</TabsTrigger>}
          {canViewFinancials && <TabsTrigger value="costing">Costing & Profitability</TabsTrigger>}
          <TabsTrigger value="predictions">Forecast & Guidance</TabsTrigger>
        </TabsList>

        <TabsContent value="sales" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign className="h-5 w-5" />
                Sales by Payment Method
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {salesByPayment.length > 0 && (
                <ChartContainer
                  config={{
                    chartTotal: {
                      label: "Total Amount",
                      color: "hsl(var(--chart-1))",
                    },
                  }}
                  className="h-[350px]"
                >
                  <PieChart>
                    <Pie
                      data={salesByPayment.map((entry) => ({ ...entry, chartTotal: Number(BigInt(entry.totalCents)) / 100 }))}
                      dataKey="chartTotal"
                      nameKey="method"
                      cx="50%"
                      cy="50%"
                      innerRadius="35%"
                      outerRadius="65%"
                      paddingAngle={5}
                    >
                      {salesByPayment.map((entry, index) => (
                        <Cell
                          key={`cell-${index}`}
                          fill={`hsl(var(--chart-${(index % 5) + 1}))`}
                        />
                      ))}
                    </Pie>
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Legend />
                  </PieChart>
                </ChartContainer>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Method</TableHead>
                    <TableHead>Transactions</TableHead>
                    <TableHead className="text-right">Total Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {salesByPayment.map((row) => (
                    <TableRow key={row.method}>
                      <TableCell className="font-medium capitalize">
                        {row.method}
                      </TableCell>
                      <TableCell>{row.count}</TableCell>
                      <TableCell className="text-right">
                        {formatCents(row.totalCents)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          {analytics?.salesTrend && (
            <Card>
              <CardHeader><CardTitle>Net sales after refunds (incl. tax)</CardTitle></CardHeader>
              <CardContent>
                <ChartContainer config={{ chartSales: { label: "Sales (KSh)", color: "hsl(var(--chart-1))" } }} className="h-[320px]">
                  <LineChart data={analytics.salesTrend.map((row) => ({ ...row, chartSales: Number(BigInt(row.salesCents)) / 100 }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="period" stroke="hsl(var(--muted-foreground))" />
                    <YAxis stroke="hsl(var(--muted-foreground))" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line type="monotone" dataKey="chartSales" stroke="hsl(var(--chart-1))" strokeWidth={2} />
                  </LineChart>
                </ChartContainer>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingUp className="h-5 w-5" />
                Top Selling Products
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {topProducts.length > 0 && (
                <ChartContainer
                  config={{
                    total_quantity: {
                      label: "Quantity Sold",
                      color: "hsl(var(--chart-1))",
                    },
                  }}
                  className="h-[400px]"
                >
                  <BarChart
                    data={topProducts}
                    layout="vertical"
                    margin={{ left: 100 }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      type="number"
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      stroke="hsl(var(--muted-foreground))"
                      width={90}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar
                      dataKey="total_quantity"
                      fill="hsl(var(--chart-1))"
                      radius={[0, 8, 8, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Quantity Sold</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topProducts.map((product, idx) => (
                    <TableRow key={product.product_id}>
                      <TableCell>
                        <span className="font-medium">#{idx + 1}</span>{" "}
                        {product.name}
                      </TableCell>
                      <TableCell>{product.sku}</TableCell>
                      <TableCell className="text-right">
                        {product.total_quantity}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {canViewFinancials && analytics?.profitAndLoss && (
          <TabsContent value="profit" className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ["Gross sales (incl. tax)", analytics.profitAndLoss.grossSalesCents],
                ["Discounts", analytics.profitAndLoss.discountsCents],
                ["Refunds issued", analytics.profitAndLoss.refundsCents],
                ["Net revenue (excl. tax)", analytics.profitAndLoss.netRevenueCents],
                ["Cost of goods sold", analytics.profitAndLoss.costOfGoodsSoldCents],
                ["Gross profit", analytics.profitAndLoss.grossProfitCents],
                ["Recorded operating expenses", analytics.profitAndLoss.operatingExpensesCents],
                ["Inventory losses", analytics.profitAndLoss.inventoryLossesCents],
                ["Transaction costs", analytics.profitAndLoss.transactionCostsCents],
                ["Net profit", analytics.profitAndLoss.netProfitCents],
                ["Losses", analytics.profitAndLoss.lossesCents],
              ].map(([label, value]) => (
                <Card key={String(label)}>
                  <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{label}</CardTitle></CardHeader>
                  <CardContent>
                    <div className="text-2xl font-bold">
                      {formatCents(typeof value === "string" ? value : null)}
                    </div>
                    {label === "Net profit" && analytics.profitAndLoss.netProfitUnavailableReason && (
                      <p className="mt-1 text-xs text-muted-foreground">{analytics.profitAndLoss.netProfitUnavailableReason}</p>
                    )}
                    {label === "Recorded operating expenses" && (
                      <p className="mt-1 text-xs text-muted-foreground">From recorded expense ledger entries in the selected period.</p>
                    )}
                    {label === "Inventory losses" && (
                      <p className="mt-1 text-xs text-muted-foreground">Reported separately from operating expenses.</p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
            {isAdmin && (
              <Card>
                <CardHeader>
                  <CardTitle>Electronic payment provider fees</CardTitle>
                  <p className="text-sm text-muted-foreground">
                    Record the actual fee and recoverable input VAT from the provider statement. Fees are never estimated.
                  </p>
                </CardHeader>
                <CardContent className="space-y-4">
                  <Button type="button" variant="outline" onClick={() => void loadUnrecordedProcessingFees()} disabled={processingFeeLoading}>
                    {processingFeeLoading ? "Loading…" : "Load provider fee records for this report period"}
                  </Button>
                  {processingFeeError && <p role="alert" className="text-sm text-destructive">{processingFeeError}</p>}
                  {processingFeeMessage && <p role="status" className="text-sm text-green-700">{processingFeeMessage}</p>}
                  {unrecordedFeeSales.length > 0 && (
                    <div className="space-y-4">
                      {unrecordedFeeSales.map((sale) => {
                        const entry = processingFeeEntries[sale.sale_id];
                        if (!entry) return null;
                        return (
                          <div key={sale.sale_id} className="space-y-3 rounded-md border p-4">
                            <div className="text-sm">
                              <p className="font-medium">Sale {sale.sale_id}</p>
                              <p className="text-muted-foreground">
                                {new Date(sale.created_at).toLocaleString()} · {sale.payment_method} ·
                                {" "}M-Pesa portion{" "}
                                {formatKesCents(
                                  parseKesToCents(String(sale.mpesa_amount)),
                                )}
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                              <label className="space-y-1 text-sm">
                                <span>Provider fee date</span>
                                <input type="date" className="h-9 w-full rounded-md border bg-background px-3" value={entry.incurred_date} onChange={(event) => updateProcessingFeeEntry(sale.sale_id, "incurred_date", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span>Total fee (KSh)</span>
                                <input inputMode="decimal" className="h-9 w-full rounded-md border bg-background px-3" value={entry.fee_amount} onChange={(event) => updateProcessingFeeEntry(sale.sale_id, "fee_amount", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span>Recoverable input VAT (KSh)</span>
                                <input inputMode="decimal" className="h-9 w-full rounded-md border bg-background px-3" value={entry.recoverable_vat} onChange={(event) => updateProcessingFeeEntry(sale.sale_id, "recoverable_vat", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span>Provider statement reference</span>
                                <input className="h-9 w-full rounded-md border bg-background px-3" value={entry.statement_reference} onChange={(event) => updateProcessingFeeEntry(sale.sale_id, "statement_reference", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span>Provider transaction reference (optional)</span>
                                <input className="h-9 w-full rounded-md border bg-background px-3" value={entry.transaction_reference} onChange={(event) => updateProcessingFeeEntry(sale.sale_id, "transaction_reference", event.target.value)} />
                              </label>
                            </div>
                            <Button type="button" onClick={() => void submitProcessingFee(sale.sale_id)} disabled={processingFeeBusySaleId !== ""}>
                              {processingFeeBusySaleId === sale.sale_id ? "Recording…" : "Record fee"}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {recordedProcessingFees.length > 0 && (
                    <div className="space-y-4">
                      <h3 className="font-medium">Recorded fees and corrections</h3>
                      {recordedProcessingFees.map((fee) => {
                        const entry = processingFeeEntries[fee.sale_id];
                        if (!entry) return null;
                        return (
                          <div key={fee.fee_id} className="space-y-3 rounded-md border p-4">
                            <div className="text-sm">
                              <p className="font-medium">Sale {fee.sale_id} · {fee.revision === 0 ? "Original record" : `Correction ${fee.revision}`}</p>
                              <p className="text-muted-foreground">
                                Current statement fee {formatCents(fee.fee_cents)} · Recoverable VAT {formatCents(fee.recoverable_vat_cents)} ·
                                {" "}{fee.statement_reference}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                A correction reverses this posting and records the replacement in the correction date period. Prior records remain immutable.
                              </p>
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                              <label className="space-y-1 text-sm">
                                <span>Corrected provider fee date</span>
                                <input type="date" className="h-9 w-full rounded-md border bg-background px-3" value={entry.incurred_date} onChange={(event) => updateProcessingFeeEntry(fee.sale_id, "incurred_date", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span>Corrected total fee (KSh)</span>
                                <input inputMode="decimal" className="h-9 w-full rounded-md border bg-background px-3" value={entry.fee_amount} onChange={(event) => updateProcessingFeeEntry(fee.sale_id, "fee_amount", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span>Corrected recoverable input VAT (KSh)</span>
                                <input inputMode="decimal" className="h-9 w-full rounded-md border bg-background px-3" value={entry.recoverable_vat} onChange={(event) => updateProcessingFeeEntry(fee.sale_id, "recoverable_vat", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span>Corrected statement reference</span>
                                <input className="h-9 w-full rounded-md border bg-background px-3" value={entry.statement_reference} onChange={(event) => updateProcessingFeeEntry(fee.sale_id, "statement_reference", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm">
                                <span>Corrected transaction reference (optional)</span>
                                <input className="h-9 w-full rounded-md border bg-background px-3" value={entry.transaction_reference} onChange={(event) => updateProcessingFeeEntry(fee.sale_id, "transaction_reference", event.target.value)} />
                              </label>
                              <label className="space-y-1 text-sm sm:col-span-2 lg:col-span-3">
                                <span>Reason for correction (required)</span>
                                <textarea className="min-h-20 w-full rounded-md border bg-background px-3 py-2" value={entry.reason} onChange={(event) => updateProcessingFeeEntry(fee.sale_id, "reason", event.target.value)} />
                              </label>
                            </div>
                            <Button type="button" variant="outline" onClick={() => void submitProcessingFeeCorrection(fee.sale_id)} disabled={processingFeeBusySaleId !== ""}>
                              {processingFeeBusySaleId === fee.sale_id ? "Posting correction…" : "Correct fee"}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {!processingFeeLoading && unrecordedFeeSales.length === 0 && processingFeeMessage && (
                    <p className="text-sm text-muted-foreground">No electronic payments are missing a fee record in this period.</p>
                  )}
                </CardContent>
              </Card>
            )}
            {analytics.comparison && (
              <Card>
                <CardHeader><CardTitle>Previous-period comparison</CardTitle></CardHeader>
                <CardContent className="flex flex-wrap gap-8">
                  <div><p className="text-sm text-muted-foreground">Selected-period sales</p><p className="text-xl font-semibold">{formatCents(analytics.comparison.currentSalesCents)}</p></div>
                  <div><p className="text-sm text-muted-foreground">Previous-period sales</p><p className="text-xl font-semibold">{formatCents(analytics.comparison.previousSalesCents)}</p></div>
                  <div><p className="text-sm text-muted-foreground">Change</p><p className="text-xl font-semibold">{formatSignedBasisPoints(analytics.comparison.salesChangePercentBasisPoints)}</p></div>
                  <div><p className="text-sm text-muted-foreground">Transactions</p><p className="text-xl font-semibold">{analytics.comparison.currentTransactions} vs {analytics.comparison.transactions}</p></div>
                  <p className="self-end text-xs text-muted-foreground">
                    Comparison: {format(new Date(analytics.comparison.previousStart), "PP")} – {format(new Date(analytics.comparison.previousEnd), "PP")}
                  </p>
                </CardContent>
              </Card>
            )}
            <Card>
              <CardHeader><CardTitle>Top products by quantity</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Product</TableHead><TableHead className="text-right">Qty sold</TableHead><TableHead className="text-right">Net revenue</TableHead><TableHead className="text-right">COGS</TableHead><TableHead className="text-right">Gross profit</TableHead></TableRow></TableHeader>
                  <TableBody>{topProducts.map((product) => (
                    <TableRow key={product.product_id}>
                      <TableCell>{product.name}</TableCell>
                      <TableCell className="text-right">{product.total_quantity}</TableCell>
                      <TableCell className="text-right">{formatCents(product.revenueCents)}</TableCell>
                      <TableCell className="text-right">{formatCents(product.costOfGoodsSoldCents)}</TableCell>
                      <TableCell className="text-right">{formatCents(product.grossProfitCents)}</TableCell>
                    </TableRow>
                  ))}</TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {canViewFinancials && analytics?.salesHeatmap && (
          <TabsContent value="demand" className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader><CardTitle>Peak demand</CardTitle></CardHeader>
                <CardContent>
                  {peakHour
                    ? <p>Highest average net sales: {String(peakHour.hour).padStart(2, "0")}:00 ({peakHour.activeDays} observed days).</p>
                    : <p className="text-sm text-muted-foreground">Insufficient samples. Each recommended hour needs {analytics.hourlyDemand?.minimumSamples ?? 3} observed days.</p>}
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Lower observed activity</CardTitle></CardHeader>
                <CardContent>
                  {slowHour
                    ? <p>Lowest observed non-zero average: {String(slowHour.hour).padStart(2, "0")}:00 ({slowHour.activeDays} observed days). Validate against local operating context before changing hours.</p>
                    : <p className="text-sm text-muted-foreground">Insufficient samples to identify a reliable low-demand period.</p>}
                </CardContent>
              </Card>
            </div>
            <Card>
              <CardHeader><CardTitle>Sales heatmap by weekday and hour</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="min-w-[900px] w-full border-collapse text-xs">
                  <thead><tr><th className="sticky left-0 bg-background p-2 text-left">Day</th>{Array.from({ length: 24 }, (_, hour) => <th className="p-1 font-medium" key={hour}>{String(hour).padStart(2, "0")}</th>)}</tr></thead>
                  <tbody>{analytics.salesHeatmap.map((day) => (
                    <tr key={day.weekday}>
                      <th className="sticky left-0 bg-background p-2 text-left">{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day.weekday]}</th>
                      {day.hours.map((hour) => {
                        const cents = BigInt(hour.salesCents);
                        const intensity = Number(cents > 0n ? cents * 10000n / maxHeatmapSales : 0n) / 10000;
                        return (
                          <td
                            key={hour.hour}
                            title={`${hour.transactions} sales transactions; ${hour.refundTransactions} refunds; ${formatCents(hour.salesCents)} net sales`}
                            className="h-8 border text-center"
                            style={{ backgroundColor: `hsl(var(--chart-1) / ${intensity * 0.75})` }}
                          >
                            {hour.transactions || ""}
                          </td>
                        );
                      })}
                    </tr>
                  ))}</tbody>
                </table>
                <p className="mt-3 text-xs text-muted-foreground">Cell color indicates sales less refunds by event time; cell value is sales transaction count. Reporting uses {Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"} time.</p>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        <TabsContent value="inventory" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-destructive" />
                Low Stock Alert
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {lowStock.length > 0 && (
                <ChartContainer
                  config={{
                    stock_on_hand: {
                      label: "Current Stock",
                      color: "hsl(var(--chart-2))",
                    },
                    reorder_level: {
                      label: "Reorder Level",
                      color: "hsl(var(--chart-3))",
                    },
                  }}
                  className="h-[350px]"
                >
                  <BarChart data={lowStock.slice(0, 10)}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="name"
                      stroke="hsl(var(--muted-foreground))"
                      angle={-45}
                      textAnchor="end"
                      height={100}
                    />
                    <YAxis stroke="hsl(var(--muted-foreground))" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar
                      dataKey="stock_on_hand"
                      fill="hsl(var(--chart-2))"
                      name="Current Stock"
                      radius={[8, 8, 0, 0]}
                    />
                    <Bar
                      dataKey="reorder_level"
                      fill="hsl(var(--chart-3))"
                      name="Reorder Level"
                      radius={[8, 8, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead>Current Stock</TableHead>
                    <TableHead>Reorder Level</TableHead>
                    <TableHead className="text-right">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lowStock.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell className="font-medium">
                        {product.name}
                      </TableCell>
                      <TableCell>{product.sku}</TableCell>
                      <TableCell>{product.stock_on_hand}</TableCell>
                      <TableCell>{product.reorder_level}</TableCell>
                      <TableCell className="text-right">
                        <Badge
                          variant={
                            product.stock_on_hand === 0
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {product.stock_on_hand === 0
                            ? "Out of Stock"
                            : "Low Stock"}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {canViewFinancials && (
        <TabsContent value="performance" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package className="h-5 w-5" />
                Cashier Performance
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              {cashierPerformance.length > 0 && (
                <ChartContainer
                  config={{
                    total: {
                      label: "Total Sales (KSh)",
                      color: "hsl(var(--chart-4))",
                    },
                    count: {
                      label: "Transactions",
                      color: "hsl(var(--chart-5))",
                    },
                  }}
                  className="h-[350px]"
                >
                  <BarChart data={cashierPerformance}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                    />
                    <XAxis
                      dataKey="name"
                      stroke="hsl(var(--muted-foreground))"
                    />
                    <YAxis stroke="hsl(var(--muted-foreground))" />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar
                      dataKey="total"
                      fill="hsl(var(--chart-4))"
                      name="Total Sales (KSh)"
                      radius={[8, 8, 0, 0]}
                    />
                    <Bar
                      dataKey="count"
                      fill="hsl(var(--chart-5))"
                      name="Transactions"
                      radius={[8, 8, 0, 0]}
                    />
                  </BarChart>
                </ChartContainer>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Cashier</TableHead>
                    <TableHead>Transactions</TableHead>
                    <TableHead className="text-right">Total Sales</TableHead>
                    <TableHead className="text-right">Discounts</TableHead>
                    <TableHead className="text-right">Refunds</TableHead>
                    <TableHead className="text-right">Gross profit contribution</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {cashierPerformance.map((cashier) => (
                    <TableRow key={cashier.cashier_id}>
                      <TableCell className="font-medium">
                        {cashier.name}
                      </TableCell>
                      <TableCell>{cashier.count}</TableCell>
                      <TableCell className="text-right">
                        KSh{" "}
                        {formatCents(cashier.totalCents)}
                      </TableCell>
                      <TableCell className="text-right">{formatCents(cashier.discountsCents)}</TableCell>
                      <TableCell className="text-right">
                        {formatCents(cashier.refundsCents)}
                        <span className="block text-xs text-muted-foreground">{cashier.refundTransactions || 0} refunds</span>
                      </TableCell>
                      <TableCell className="text-right">
                        {formatCents(cashier.profitContributionCents ?? null)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
        )}

        {canViewFinancials && (
          <TabsContent value="costing" className="space-y-6">
            {costingReport ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Purchases in selected period</CardTitle></CardHeader>
                    <CardContent><p className="text-2xl font-bold">{formatCents(costingReport.purchases_total_cents)}</p></CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Current stock valuation</CardTitle></CardHeader>
                    <CardContent><p className="text-2xl font-bold">{formatCents(costingReport.stock_value_total_cents)}</p></CardContent>
                  </Card>
                  <Card>
                    <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">Inventory reconciliation</CardTitle></CardHeader>
                    <CardContent>
                      <p className={`text-lg font-semibold ${costingReport.reconciliation.available && costingReport.reconciliation.balanced ? "text-green-700" : "text-destructive"}`}>
                        {!costingReport.reconciliation.available ? "Unavailable" : costingReport.reconciliation.balanced ? "Balanced" : "Mismatch"}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">{costingReport.reconciliation.message}</p>
                      {costingReport.reconciliation.scope_note && <p className="mt-1 text-xs text-muted-foreground">{costingReport.reconciliation.scope_note}</p>}
                      {costingReport.reconciliation.difference_cents != null && (
                        <p className="mt-1 text-xs">Difference: {formatCents(costingReport.reconciliation.difference_cents)}</p>
                      )}
                    </CardContent>
                  </Card>
                </div>
                {!costingReport.stock_value_data_available && (
                  <p role="status" className="text-sm text-muted-foreground">Some products do not have a recorded stock value; the total is withheld rather than reported as zero.</p>
                )}
                {!costingReport.stock_value_verified && (
                  <p role="status" className="text-sm text-destructive">
                    Stock values use an unverified legacy opening-cost snapshot. Treat the valuation as provisional; reconciliation and period close are blocked until opening inventory value is verified.
                  </p>
                )}
                {isAdmin && !costingReport.stock_value_verified && (
                  <Card>
                    <CardHeader>
                      <CardTitle>Verify current opening inventory valuation</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <p className="text-sm text-muted-foreground">
                        Use a completed physical stocktake and its source-document reference. Every warehouse/product quantity must match the book quantity; quantity differences must first be posted through stock adjustments. This creates a new trusted baseline for future closes only—it cannot reconstruct historical sale costs, supplier origin, or prior periods.
                      </p>
                      {!baselinePreview ? (
                        <Button
                          variant="outline"
                          onClick={() => void loadBaselineVerification()}
                          disabled={baselineVerificationBusy}
                        >
                          {baselineVerificationBusy ? "Loading stock…" : "Load current stocktake rows"}
                        </Button>
                      ) : (
                        <>
                          <div className="grid gap-3 sm:grid-cols-2">
                            <label className="space-y-1 text-sm">
                              <span>Stocktake evidence reference</span>
                              <input
                                value={baselineEvidenceReference}
                                maxLength={120}
                                onChange={(event) => setBaselineEvidenceReference(event.target.value)}
                                className="h-9 w-full rounded-md border bg-background px-3"
                                placeholder="e.g. ST-2026-04-15"
                              />
                            </label>
                            <label className="space-y-1 text-sm">
                              <span>Reason for verifying the opening valuation</span>
                              <input
                                value={baselineReason}
                                maxLength={2000}
                                onChange={(event) => setBaselineReason(event.target.value)}
                                className="h-9 w-full rounded-md border bg-background px-3"
                                placeholder="Describe the physical stocktake and valuation source"
                              />
                            </label>
                          </div>
                          <div className="max-h-[32rem] overflow-auto rounded-md border">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Warehouse</TableHead>
                                  <TableHead>Product</TableHead>
                                  <TableHead className="text-right">Book quantity</TableHead>
                                  <TableHead className="text-right">Physical count</TableHead>
                                  <TableHead className="text-right">Current book value</TableHead>
                                  <TableHead className="text-right">Verified value (KSh)</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {baselinePreview.rows.map((row) => (
                                  <TableRow key={row.warehouse_stock_id}>
                                    <TableCell>{row.warehouse_name}</TableCell>
                                    <TableCell>
                                      <span className="font-medium">{row.product_name}</span>
                                      <span className="block text-xs text-muted-foreground">{row.sku}</span>
                                    </TableCell>
                                    <TableCell className="text-right">{row.quantity}</TableCell>
                                    <TableCell className="text-right">
                                      <input
                                        type="text"
                                        inputMode="numeric"
                                        aria-label={`Physical count for ${row.sku} at ${row.warehouse_name}`}
                                        value={baselineCounts[row.warehouse_stock_id] || ""}
                                        onChange={(event) => setBaselineCounts((current) => ({
                                          ...current,
                                          [row.warehouse_stock_id]: event.target.value,
                                        }))}
                                        className="h-9 w-24 rounded-md border bg-background px-2 text-right"
                                        placeholder="Count"
                                      />
                                    </TableCell>
                                    <TableCell className="text-right">{formatCents(row.current_value_cents)}</TableCell>
                                    <TableCell className="text-right">
                                      <input
                                        type="text"
                                        inputMode="decimal"
                                        aria-label={`Verified value for ${row.sku} at ${row.warehouse_name}`}
                                        value={baselineValues[row.warehouse_stock_id] || ""}
                                        onChange={(event) => setBaselineValues((current) => ({
                                          ...current,
                                          [row.warehouse_stock_id]: event.target.value,
                                        }))}
                                        className="h-9 w-36 rounded-md border bg-background px-2 text-right"
                                        placeholder="0.00"
                                      />
                                    </TableCell>
                                  </TableRow>
                                ))}
                                {baselinePreview.rows.length === 0 && (
                                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No warehouse stock rows exist.</TableCell></TableRow>
                                )}
                              </TableBody>
                            </Table>
                          </div>
                          <label className="flex items-start gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={physicalCountsConfirmed}
                              onChange={(event) => setPhysicalCountsConfirmed(event.target.checked)}
                              className="mt-1"
                            />
                            <span>I confirm the physical count for every listed warehouse/product row equals its book quantity. Any quantity discrepancy has already been recorded through the stock adjustment workflow.</span>
                          </label>
                          <div className="flex flex-wrap gap-3">
                            <Button
                              onClick={() => void submitBaselineVerification()}
                              disabled={baselineVerificationBusy}
                            >
                              {baselineVerificationBusy ? "Verifying…" : "Verify opening valuation"}
                            </Button>
                            <Button
                              variant="outline"
                              onClick={() => setBaselinePreview(null)}
                              disabled={baselineVerificationBusy}
                            >
                              Cancel
                            </Button>
                          </div>
                        </>
                      )}
                      {baselineVerificationError && <p role="alert" className="text-sm text-destructive">{baselineVerificationError}</p>}
                      {baselineVerificationMessage && <p role="status" className="text-sm text-green-700">{baselineVerificationMessage}</p>}
                    </CardContent>
                  </Card>
                )}
                <Card>
                  <CardHeader><CardTitle>Close a reconciled inventory period</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      Closing is permanent and always covers every warehouse and product. The server reconstructs stock value at the selected UTC date from exact, audited stock movements and blocks closing if the baseline, values, or reconciliation are incomplete.
                    </p>
                    <p className="text-xs text-muted-foreground">
                      The supplier filter selects products with purchase history from that supplier; valued stock remains weighted-average pooled across suppliers.
                    </p>
                    <div className="flex flex-wrap items-center gap-3">
                      <label htmlFor="inventory-period-close-date" className="text-sm text-muted-foreground">Period through (UTC)</label>
                      <input
                        id="inventory-period-close-date"
                        type="date"
                        max={new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)}
                        value={periodCloseDate}
                        onChange={(event) => setPeriodCloseDate(event.target.value)}
                        className="h-9 rounded-md border bg-background px-3 text-sm"
                      />
                      <Button onClick={() => void closeInventoryPeriod()} disabled={periodCloseBusy || !periodCloseDate}>
                        {periodCloseBusy ? "Reconciling…" : "Reconcile and close"}
                      </Button>
                    </div>
                    {periodCloseError && <p role="alert" className="text-sm text-destructive">{periodCloseError}</p>}
                    {periodCloseMessage && <p role="status" className="text-sm text-green-700">{periodCloseMessage}</p>}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Recent inventory period closes</CardTitle></CardHeader>
                  <CardContent className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow><TableHead>Period end (UTC)</TableHead><TableHead className="text-right">Opening</TableHead><TableHead className="text-right">Purchases</TableHead><TableHead className="text-right">COGS</TableHead><TableHead className="text-right">Write-offs</TableHead><TableHead className="text-right">Adjustments</TableHead><TableHead className="text-right">Closing value</TableHead><TableHead>Closed by</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {periodCloses.map((close) => (
                          <TableRow key={close.id}>
                            <TableCell>{close.period_end_date}</TableCell>
                            <TableCell className="text-right">{formatCents(close.opening_value_cents)}</TableCell>
                            <TableCell className="text-right">{formatCents(close.purchase_value_cents)}</TableCell>
                            <TableCell className="text-right">{formatCents(close.cogs_cents)}</TableCell>
                            <TableCell className="text-right">{formatCents(close.write_offs_cents)}</TableCell>
                            <TableCell className="text-right">{formatCents(close.adjustments_cents)}</TableCell>
                            <TableCell className="text-right">{formatCents(close.closing_value_cents)}</TableCell>
                            <TableCell>{close.closed_by_name}</TableCell>
                          </TableRow>
                        ))}
                        {periodCloses.length === 0 && <TableRow><TableCell colSpan={8} className="text-center text-muted-foreground">No inventory periods have been closed.</TableCell></TableRow>}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Overall profitability</CardTitle></CardHeader>
                  <CardContent className="space-y-3">
                    {costingReport.profitability.overall[0] ? (
                      <>
                        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                          <div><p className="text-xs text-muted-foreground">Net quantity sold</p><p className="text-lg font-semibold">{costingReport.profitability.overall[0].quantity_sold}</p></div>
                          <div><p className="text-xs text-muted-foreground">Net revenue</p><p className="text-lg font-semibold">{formatCents(costingReport.profitability.overall[0].net_revenue_cents)}</p></div>
                          <div><p className="text-xs text-muted-foreground">COGS</p><p className="text-lg font-semibold">{formatCents(costingReport.profitability.overall[0].cogs_cents)}</p></div>
                          <div><p className="text-xs text-muted-foreground">Gross profit</p><p className="text-lg font-semibold">{formatCents(costingReport.profitability.overall[0].gross_profit_cents)}</p></div>
                          <div><p className="text-xs text-muted-foreground">Margin</p><p className="text-lg font-semibold">{formatMarginBasisPoints(costingReport.profitability.overall[0].margin_basis_points)}</p></div>
                        </div>
                        {!costingReport.profitability.overall[0].data_complete && (
                          <p role="status" className="text-sm text-destructive">
                            Profit totals are withheld because sales/returns lack exact net-revenue, VAT, or COGS snapshots.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-muted-foreground">No sales or returns were recorded in this period.</p>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader>
                    <CardTitle>Supplier profitability (FIFO analysis)</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <p className="text-xs text-muted-foreground">
                      {costingReport.supplier_profitability.note}
                    </p>
                    {!costingReport.supplier_profitability.available ? (
                      <p role="status" className="text-sm text-destructive">
                        Supplier attribution is unavailable for this period because complete inventory movement coverage does not begin before the selected period.
                      </p>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Supplier</TableHead>
                                <TableHead className="text-right">Net quantity</TableHead>
                                <TableHead className="text-right">Net revenue</TableHead>
                                <TableHead className="text-right">FIFO cost</TableHead>
                                <TableHead className="text-right">Analytical gross profit</TableHead>
                                <TableHead className="text-right">Margin</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {costingReport.supplier_profitability.by_supplier.map((row, index) => (
                                <TableRow key={`${row.supplier_id || "unknown"}-${index}`}>
                                  <TableCell>
                                    {row.supplier}
                                    {!row.data_complete && (
                                      <span className="block text-xs text-destructive">
                                        Some historical revenue or cost snapshots are unavailable
                                      </span>
                                    )}
                                    {!row.supplier_attribution_complete && (
                                      <span className="block text-xs text-amber-700">
                                        Supplier source is unknown; displayed amounts are not attributed to a named supplier
                                      </span>
                                    )}
                                  </TableCell>
                                  <TableCell className="text-right">{row.quantity_sold}</TableCell>
                                  <TableCell className="text-right">{formatCents(row.net_revenue_cents)}</TableCell>
                                  <TableCell className="text-right">{formatCents(row.fifo_cost_cents)}</TableCell>
                                  <TableCell className="text-right">{formatCents(row.gross_profit_cents)}</TableCell>
                                  <TableCell className="text-right">{formatMarginBasisPoints(row.margin_basis_points)}</TableCell>
                                </TableRow>
                              ))}
                              {costingReport.supplier_profitability.by_supplier.length === 0 && (
                                <TableRow>
                                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                                    No FIFO-attributed sales or returns were recorded in this period.
                                  </TableCell>
                                </TableRow>
                              )}
                            </TableBody>
                          </Table>
                        </div>
                        <div className="overflow-x-auto">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Supplier / product</TableHead>
                                <TableHead className="text-right">Net quantity</TableHead>
                                <TableHead className="text-right">Net revenue</TableHead>
                                <TableHead className="text-right">FIFO cost</TableHead>
                                <TableHead className="text-right">Analytical gross profit</TableHead>
                                <TableHead className="text-right">Margin</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {costingReport.supplier_profitability.by_supplier_product.map((row, index) => (
                                <TableRow key={`${row.supplier_id || "unknown"}-${row.product_id}-${index}`}>
                                  <TableCell>
                                    {row.supplier} — {row.product || "Unknown product"}
                                    {row.sku ? ` (${row.sku})` : ""}
                                    {!row.data_complete && (
                                      <span className="block text-xs text-destructive">
                                        Some historical revenue or cost snapshots are unavailable
                                      </span>
                                    )}
                                    {!row.supplier_attribution_complete && (
                                      <span className="block text-xs text-amber-700">
                                        Supplier source is unknown
                                      </span>
                                    )}
                                  </TableCell>
                                  <TableCell className="text-right">{row.quantity_sold}</TableCell>
                                  <TableCell className="text-right">{formatCents(row.net_revenue_cents)}</TableCell>
                                  <TableCell className="text-right">{formatCents(row.fifo_cost_cents)}</TableCell>
                                  <TableCell className="text-right">{formatCents(row.gross_profit_cents)}</TableCell>
                                  <TableCell className="text-right">{formatMarginBasisPoints(row.margin_basis_points)}</TableCell>
                                </TableRow>
                              ))}
                              {costingReport.supplier_profitability.by_supplier_product.length === 0 && (
                                <TableRow>
                                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                                    No supplier/product results for the selected filters.
                                  </TableCell>
                                </TableRow>
                              )}
                            </TableBody>
                          </Table>
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
                <ProfitabilityTable
                  title="Profit/loss by product"
                  labelHeader="Product"
                  rows={costingReport.profitability.product}
                  label={(row) => `${row.product || "Unknown product"}${row.sku ? ` (${row.sku})` : ""}`}
                />
                <ProfitabilityTable
                  title="Profit/loss by category"
                  labelHeader="Category"
                  rows={costingReport.profitability.category}
                  label={(row) => row.category || "Uncategorized"}
                />
                <ProfitabilityTable
                  title="Profit/loss by day"
                  labelHeader="Day"
                  rows={costingReport.profitability.day}
                  label={(row) => row.day || ""}
                />
                <ProfitabilityTable
                  title="Profit/loss by month"
                  labelHeader="Month"
                  rows={costingReport.profitability.month}
                  label={(row) => row.month || ""}
                />
                <Card>
                  <CardHeader><CardTitle>Purchases by product and supplier</CardTitle></CardHeader>
                  <CardContent className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow><TableHead>Product</TableHead><TableHead>SKU</TableHead><TableHead>Category</TableHead><TableHead>Supplier</TableHead><TableHead className="text-right">Quantity</TableHead><TableHead className="text-right">Cost</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {costingReport.purchases.map((row, index) => (
                          <TableRow key={`${row.product_id}-${row.supplier || "unknown"}-${index}`}>
                            <TableCell>{row.product}</TableCell><TableCell>{row.sku}</TableCell><TableCell>{row.category || "—"}</TableCell><TableCell>{row.supplier || "Not recorded"}</TableCell><TableCell className="text-right">{row.quantity}</TableCell><TableCell className="text-right">{formatCents(row.cost_cents)}</TableCell>
                          </TableRow>
                        ))}
                        {costingReport.purchases.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No purchases were recorded in this period.</TableCell></TableRow>}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader><CardTitle>Stock valuation by warehouse and product</CardTitle></CardHeader>
                  <CardContent className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow><TableHead>Warehouse</TableHead><TableHead>Product</TableHead><TableHead>SKU</TableHead><TableHead>Category</TableHead><TableHead className="text-right">Quantity</TableHead><TableHead className="text-right">Value</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {costingReport.stock_valuation.map((row) => (
                          <TableRow key={`${row.warehouse_id}-${row.product_id}`}>
                            <TableCell>{row.warehouse}</TableCell><TableCell>{row.product}</TableCell><TableCell>{row.sku}</TableCell><TableCell>{row.category || "—"}</TableCell><TableCell className="text-right">{row.quantity}</TableCell><TableCell className="text-right">{formatCents(row.value_cents)}</TableCell>
                          </TableRow>
                        ))}
                        {costingReport.stock_valuation.length === 0 && <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground">No warehouse stock records are available.</TableCell></TableRow>}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </>
            ) : (
              <Card><CardContent className="py-8 text-center text-muted-foreground">Costing data is not available for the selected period.</CardContent></Card>
            )}
          </TabsContent>
        )}

        <TabsContent value="predictions" className="space-y-6">
          <InventoryAlerts />
        </TabsContent>
      </Tabs>
    </div>
  );
}
