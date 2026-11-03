import { useEffect, useState, useRef } from 'react';
import { ApiService } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DollarSign, ShoppingCart, Package, AlertCircle, TrendingUp } from 'lucide-react';
import { useInventoryAlerts } from '@/hooks/useInventoryAlerts';
import { Link } from 'react-router-dom';
import { ChartContainer, ChartTooltip, ChartTooltipContent } from '@/components/ui/chart';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Legend, ResponsiveContainer } from 'recharts';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuthContext';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface DashboardStats {
  todaySalesCents: string;
  todayTransactions: number;
  lowStockCount: number;
  totalProducts: number;
  weeklyTrend: Array<{ day: string; salesCents: string; transactions: number }>;
  topProducts: Array<{ name: string; quantity: number; revenueCents: string }>;
  salesByMethod: Array<{ method: string; amountCents: string }>;
  recentTransactions: Array<{ id: string; time: string; amountCents: string; method: string }>;
  totalCustomers: number;
}

interface ReportAnalytics {
  profitAndLoss: {
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
    netProfitUnavailableReason: string | null;
  };
  salesByHour: Array<{ hour: number; salesCents: string; transactions: number; refundsCents: string; activeDays: number }>;
  hourlyDemand: {
    peak?: { hour: number; salesCents: string; transactions: number; activeDays: number };
    slow?: { hour: number; salesCents: string; transactions: number; activeDays: number };
    minimumSamples: number;
  };
  salesByWeekday: Array<{ weekday: number; salesCents: string; transactions: number; refundsCents: string; activeDays: number }>;
  salesTrend: Array<{ period: string; salesCents: string; transactions: number; refundsCents: string }>;
  start: string;
  end: string;
  history: { activeDays: number; transactions: number };
  topProducts: Array<{ product_id: string; name: string; total_quantity: number; revenueCents: string | null; costOfGoodsSoldCents: string | null; grossProfitCents: string | null }>;
  cashierPerformance?: Array<{ cashier_id: string; name: string; totalCents: string; count: number; profitContributionCents: string | null }>;
}

const formatLocalDate = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

const formatMoneyCents = (value: string | null): string => {
  if (value === null) return 'Unavailable';
  const cents = BigInt(value);
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = new Intl.NumberFormat('en-KE').format(absolute / 100n);
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}KSh ${whole}.${fraction}`;
};

const chartMoneyFromCents = (value: string): number => Number(BigInt(value)) / 100;

export default function Dashboard() {
  const { alerts: lowStockProducts, loading: lowStockLoading } = useInventoryAlerts();
  const { userRole } = useAuth();
  const canViewFinancials = userRole === 'manager' || userRole === 'admin';
  const [reportPeriod, setReportPeriod] = useState('today');
  const [reportStartHour, setReportStartHour] = useState('');
  const [reportEndHour, setReportEndHour] = useState('');
  const [customStart, setCustomStart] = useState(() => formatLocalDate(new Date()));
  const [customEnd, setCustomEnd] = useState(() => formatLocalDate(new Date()));
  const [report, setReport] = useState<ReportAnalytics | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');
  const [stats, setStats] = useState<DashboardStats>({
    todaySalesCents: '0',
    todayTransactions: 0,
    lowStockCount: 0,
    totalProducts: 0,
    weeklyTrend: [],
    topProducts: [],
    salesByMethod: [],
    recentTransactions: [],
    totalCustomers: 0,
  });
  const [loading, setLoading] = useState(true);
  const [animatedTransactions, setAnimatedTransactions] = useState(0);

  useEffect(() => {
    loadDashboardStats();
    
    // Set up a polling interval for dashboard updates since we are not using websockets here currently
    const interval = setInterval(() => {
      loadDashboardStats();
    }, 30000); // 30 seconds

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!canViewFinancials) {
      setReport(null);
      setReportLoading(false);
      setReportError('');
      return;
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    let start = today;
    let end = now;
    if (reportPeriod === 'week') {
      start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    } else if (reportPeriod === 'month') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
    } else if (reportPeriod === 'quarter') {
      start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
    } else if (reportPeriod === 'year') {
      start = new Date(now.getFullYear(), 0, 1);
    } else if (reportPeriod === 'custom') {
      start = new Date(`${customStart}T00:00:00`);
      end = new Date(`${customEnd}T00:00:00`);
      end.setDate(end.getDate() + 1);
    }
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) {
      setReport(null);
      setReportLoading(false);
      setReportError('Choose a valid custom date range.');
      return;
    }
    if ((reportStartHour || reportEndHour) && (!reportStartHour || !reportEndHour || reportStartHour === reportEndHour)) {
      setReport(null);
      setReportLoading(false);
      setReportError('Choose two distinct hours for the time filter.');
      return;
    }

    const params = new URLSearchParams({
      start: start.toISOString(),
      end: end.toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    });
    if (reportStartHour && reportEndHour) {
      params.set('hourStart', reportStartHour);
      params.set('hourEnd', reportEndHour);
    }
    let active = true;
    setReport(null);
    setReportError('');
    setReportLoading(true);
    ApiService.get<ReportAnalytics & Record<string, unknown>>(`/reports/summary?${params.toString()}`)
      .then((result) => {
        if (active) setReport(result);
      })
      .catch((error) => {
        console.error('Error loading dashboard analytics:', error);
        if (active) setReportError('Financial analytics could not be loaded.');
      })
      .finally(() => {
        if (active) setReportLoading(false);
      });
    return () => { active = false; };
  }, [canViewFinancials, customEnd, customStart, reportEndHour, reportPeriod, reportStartHour]);

  const peakSalesHour = report?.hourlyDemand.peak;
  const lowSalesHour = report?.hourlyDemand.slow;

  // Animated counter effect
  useEffect(() => {
    const animateSales = setInterval(() => {
      setAnimatedTransactions(prev => {
        const newTransactions = prev < stats.todayTransactions
          ? Math.min(prev + 1, stats.todayTransactions)
          : stats.todayTransactions;
        
        if (newTransactions === stats.todayTransactions) {
          clearInterval(animateSales);
        }
        
        return newTransactions;
      });
    }, 50);

    return () => clearInterval(animateSales);
  }, [stats.todayTransactions]);

  const loadDashboardStats = async () => {
    try {
      const data = await ApiService.get<DashboardStats>('/dashboard/stats');
      if (data) {
        setStats(data);
      }
    } catch (error) {
      console.error('Error loading dashboard stats:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in p-6">
      {/* Header Section */}
      <div className="space-y-2">
        <h1 className="text-2xl sm:text-3xl font-bold bg-gradient-to-r from-primary to-primary/60 bg-clip-text text-transparent">
          Dashboard
        </h1>
        <p className="text-sm sm:text-base text-muted-foreground">
          Real-time overview of your wholesale business
        </p>
      </div>

      {/* Stats Cards Grid with Animated Counters */}
      <div className="grid gap-4 sm:gap-6 grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {/* Today's Sales Card */}
        <Card className="relative overflow-hidden border-primary/20 hover:shadow-lg transition-all duration-300 hover:scale-105">
          <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-primary/20 to-transparent rounded-full -mr-16 -mt-16" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Today's Sales</CardTitle>
            <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
              <DollarSign className="h-5 w-5 text-primary" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold animate-scale-in">
              {formatMoneyCents(stats.todaySalesCents)}
            </div>
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <TrendingUp className="h-3 w-3 text-green-500" />
              {stats.todayTransactions} transactions
            </p>
          </CardContent>
        </Card>

        {/* Transactions Card */}
        <Card className="relative overflow-hidden border-blue-500/20 hover:shadow-lg transition-all duration-300 hover:scale-105">
          <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-blue-500/20 to-transparent rounded-full -mr-16 -mt-16" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Transactions</CardTitle>
            <div className="h-10 w-10 rounded-full bg-blue-500/10 flex items-center justify-center">
              <ShoppingCart className="h-5 w-5 text-blue-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold animate-scale-in">{Math.floor(animatedTransactions)}</div>
            <p className="text-xs text-muted-foreground mt-1">Completed today</p>
          </CardContent>
        </Card>

        {/* Total Products Card */}
        <Card className="relative overflow-hidden border-green-500/20 hover:shadow-lg transition-all duration-300 hover:scale-105">
          <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-green-500/20 to-transparent rounded-full -mr-16 -mt-16" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Products & Customers</CardTitle>
            <div className="h-10 w-10 rounded-full bg-green-500/10 flex items-center justify-center">
              <Package className="h-5 w-5 text-green-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold">{stats.totalProducts}</div>
            <p className="text-xs text-muted-foreground mt-1">{stats.totalCustomers} customers</p>
          </CardContent>
        </Card>

        {/* Low Stock Alert Card */}
        <Card className="relative overflow-hidden border-orange-500/20 hover:shadow-lg transition-all duration-300 hover:scale-105">
          <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-orange-500/20 to-transparent rounded-full -mr-16 -mt-16" />
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Low Stock Alert</CardTitle>
            <div className="h-10 w-10 rounded-full bg-orange-500/10 flex items-center justify-center">
              <AlertCircle className="h-5 w-5 text-orange-500" />
            </div>
          </CardHeader>
          <CardContent>
            <div className="text-2xl sm:text-3xl font-bold text-orange-500">
              {stats.lowStockCount}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Items need reorder</p>
          </CardContent>
        </Card>
      </div>

      {canViewFinancials && (
        <section className="space-y-4" aria-label="Financial analytics">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">Profitability & demand</h2>
              <p className="text-sm text-muted-foreground">Manager and owner analytics for the selected period.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="dashboard-report-period">Analytics period</label>
              <select id="dashboard-report-period" className="h-9 rounded-md border bg-background px-3 text-sm" value={reportPeriod} onChange={(event) => setReportPeriod(event.target.value)}>
                <option value="today">Today</option>
                <option value="week">This week</option>
                <option value="month">This month</option>
                <option value="quarter">This quarter</option>
                <option value="year">This year</option>
                <option value="custom">Custom dates</option>
              </select>
              {reportPeriod === 'custom' && (
                <>
                  <label className="sr-only" htmlFor="dashboard-report-start">Start date</label>
                  <input id="dashboard-report-start" type="date" className="h-9 rounded-md border bg-background px-2 text-sm" value={customStart} onChange={(event) => setCustomStart(event.target.value)} />
                  <label className="sr-only" htmlFor="dashboard-report-end">End date</label>
                  <input id="dashboard-report-end" type="date" min={customStart} className="h-9 rounded-md border bg-background px-2 text-sm" value={customEnd} onChange={(event) => setCustomEnd(event.target.value)} />
                </>
              )}
              <label className="text-sm text-muted-foreground" htmlFor="dashboard-hour-start">Hours</label>
              <select id="dashboard-hour-start" className="h-9 rounded-md border bg-background px-2 text-sm" value={reportStartHour} onChange={(event) => setReportStartHour(event.target.value)}>
                <option value="">All day</option>
                {Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')).map((hour) => <option key={hour} value={hour}>{hour}:00</option>)}
              </select>
              <span aria-hidden="true">to</span>
              <label className="sr-only" htmlFor="dashboard-hour-end">Ending hour, exclusive</label>
              <select id="dashboard-hour-end" className="h-9 rounded-md border bg-background px-2 text-sm" value={reportEndHour} onChange={(event) => setReportEndHour(event.target.value)}>
                <option value="">All day</option>
                {Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, '0')).map((hour) => <option key={hour} value={hour}>{hour}:00</option>)}
              </select>
            </div>
          </div>
          {reportLoading && <p className="text-sm text-muted-foreground">Updating analytics…</p>}
          {reportError && <p role="alert" className="text-sm text-destructive">{reportError}</p>}
          {report?.profitAndLoss && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {[
                ['Net revenue', report.profitAndLoss.netRevenueCents],
                ['Gross sales', report.profitAndLoss.grossSalesCents],
                ['Discounts', report.profitAndLoss.discountsCents],
                ['Refunds', report.profitAndLoss.refundsCents],
                ['Cost of goods sold', report.profitAndLoss.costOfGoodsSoldCents],
                ['Gross profit', report.profitAndLoss.grossProfitCents],
                ['Recorded operating expenses', report.profitAndLoss.operatingExpensesCents],
                ['Inventory losses', report.profitAndLoss.inventoryLossesCents],
                ['Net profit', report.profitAndLoss.netProfitCents],
                ['Losses', report.profitAndLoss.lossesCents],
              ].map(([label, value]) => (
                <Card key={String(label)}>
                  <CardHeader className="pb-2"><CardTitle className="text-sm font-medium">{label}</CardTitle></CardHeader>
                  <CardContent>
                    <p className="text-2xl font-bold">{formatMoneyCents(typeof value === 'string' ? value : null)}</p>
                    {label === 'Net profit' && report.profitAndLoss.netProfitUnavailableReason && (
                      <p className="mt-1 text-xs text-muted-foreground">{report.profitAndLoss.netProfitUnavailableReason}</p>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {report && (
            <div className="grid gap-6 xl:grid-cols-2">
              <Card className="xl:col-span-2">
                <CardHeader><CardTitle>Net sales after refunds (incl. tax)</CardTitle></CardHeader>
                <CardContent>
                  <ChartContainer config={{ chartSales: { label: 'Net sales incl. tax (KSh)', color: 'hsl(var(--chart-1))' } }} className="h-[260px]">
                    <LineChart data={report.salesTrend.map((row) => ({ ...row, chartSales: chartMoneyFromCents(row.salesCents) }))}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="period" />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Line type="monotone" dataKey="chartSales" stroke="hsl(var(--chart-1))" strokeWidth={2} />
                    </LineChart>
                  </ChartContainer>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Net sales after refunds by hour (incl. tax)</CardTitle></CardHeader>
                <CardContent>
                  <ChartContainer config={{ chartSales: { label: 'Net sales incl. tax (KSh)', color: 'hsl(var(--chart-1))' } }} className="h-[260px]">
                    <BarChart data={report.salesByHour.map((row) => ({ ...row, chartSales: chartMoneyFromCents(row.salesCents) }))}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="hour" tickFormatter={(hour: number) => `${String(hour).padStart(2, '0')}:00`} />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="chartSales" fill="hsl(var(--chart-1))" />
                    </BarChart>
                  </ChartContainer>
                  <p className="mt-2 text-xs text-muted-foreground">Hours use the selected reporting period and your local time zone. Low activity is not a recommendation to close without sufficient history.</p>
                  <p className="mt-1 text-sm">
                    {peakSalesHour
                      ? `Peak average: ${String(peakSalesHour.hour).padStart(2, '0')}:00 (${peakSalesHour.activeDays} observed days). `
                      : `Insufficient samples: each recommended hour needs ${report.hourlyDemand.minimumSamples} observed days. `}
                    {lowSalesHour
                      ? `Lowest observed non-zero average: ${String(lowSalesHour.hour).padStart(2, '0')}:00 (${lowSalesHour.activeDays} observed days).`
                      : ''}
                  </p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Net sales after refunds by weekday (incl. tax)</CardTitle></CardHeader>
                <CardContent>
                  <ChartContainer config={{ chartSales: { label: 'Sales (KSh)', color: 'hsl(var(--chart-2))' } }} className="h-[260px]">
                    <BarChart data={report.salesByWeekday.map((row) => ({ ...row, chartSales: chartMoneyFromCents(row.salesCents) }))}>
                      <CartesianGrid strokeDasharray="3 3" />
                      <XAxis dataKey="weekday" tickFormatter={(day: number) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]} />
                      <YAxis />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Bar dataKey="chartSales" fill="hsl(var(--chart-2))" />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Product profitability</CardTitle></CardHeader>
                <CardContent>
                  <Table>
                    <TableHeader><TableRow><TableHead>Product</TableHead><TableHead className="text-right">Qty</TableHead><TableHead className="text-right">Revenue</TableHead><TableHead className="text-right">Gross profit</TableHead></TableRow></TableHeader>
                    <TableBody>{report.topProducts.map((product) => (
                      <TableRow key={product.product_id}>
                        <TableCell>{product.name}</TableCell>
                        <TableCell className="text-right">{product.total_quantity}</TableCell>
                        <TableCell className="text-right">{formatMoneyCents(product.revenueCents)}</TableCell>
                        <TableCell className="text-right">{formatMoneyCents(product.grossProfitCents)}</TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                </CardContent>
              </Card>
              {report.cashierPerformance && (
                <Card>
                  <CardHeader><CardTitle>Sales by cashier</CardTitle></CardHeader>
                  <CardContent>
                    <ChartContainer config={{ chartTotal: { label: 'Sales (KSh)', color: 'hsl(var(--chart-3))' } }} className="h-[260px]">
                      <BarChart data={report.cashierPerformance.map((row) => ({ ...row, chartTotal: chartMoneyFromCents(row.totalCents) }))}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="name" />
                        <YAxis />
                        <ChartTooltip content={<ChartTooltipContent />} />
                        <Bar dataKey="chartTotal" fill="hsl(var(--chart-3))" />
                      </BarChart>
                    </ChartContainer>
                  </CardContent>
                </Card>
              )}
            </div>
          )}
        </section>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-orange-500" />
              Products at or below reorder level
            </CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {lowStockProducts.length} product{lowStockProducts.length === 1 ? '' : 's'} need attention
            </p>
          </div>
          <Link to="/products" className="text-sm font-medium text-primary hover:underline">
            View products
          </Link>
        </CardHeader>
        <CardContent>
          {lowStockLoading ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Loading stock alerts...</p>
          ) : lowStockProducts.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              All products are above their reorder levels.
            </p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Product</TableHead>
                    <TableHead>SKU</TableHead>
                    <TableHead className="text-right">Available</TableHead>
                    <TableHead className="text-right">Reorder level</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lowStockProducts.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell className="font-medium">{product.name}</TableCell>
                      <TableCell>{product.sku}</TableCell>
                      <TableCell className="text-right font-semibold text-orange-600">
                        {Number(product.stock_on_hand).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-right">
                        {Number(product.reorder_level).toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Charts Section */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Weekly Sales Trend */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Weekly Sales Trend
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                chartSales: { label: "Sales (KSh)", color: "hsl(var(--chart-1))" },
                transactions: { label: "Transactions", color: "hsl(var(--chart-2))" },
              }}
              className="h-[300px]"
            >
              <LineChart data={stats.weeklyTrend.map((row) => ({ ...row, chartSales: chartMoneyFromCents(row.salesCents) }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" />
                <YAxis stroke="hsl(var(--muted-foreground))" />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend />
                <Line 
                  type="monotone" 
                  dataKey="chartSales"
                  stroke="hsl(var(--chart-1))" 
                  strokeWidth={2}
                  dot={{ fill: "hsl(var(--chart-1))", r: 4 }}
                  activeDot={{ r: 6 }}
                />
                <Line 
                  type="monotone" 
                  dataKey="transactions" 
                  stroke="hsl(var(--chart-2))" 
                  strokeWidth={2}
                  dot={{ fill: "hsl(var(--chart-2))", r: 4 }}
                />
              </LineChart>
            </ChartContainer>
          </CardContent>
        </Card>

        {/* Sales by Payment Method */}
        <Card>
          <CardHeader>
            <CardTitle>Sales by Payment Method</CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                chartAmount: { label: "Amount (KSh)", color: "hsl(var(--chart-1))" },
              }}
              className="h-[300px]"
            >
              <PieChart>
                <Pie
                  data={stats.salesByMethod.map((row) => ({
                    ...row,
                    chartAmount: chartMoneyFromCents(row.amountCents),
                    percentage: stats.todaySalesCents === '0'
                      ? 0
                      : Number((BigInt(row.amountCents) * 10000n) / BigInt(stats.todaySalesCents)) / 100,
                  }))}
                  dataKey="chartAmount"
                  nameKey="method"
                  cx="50%"
                  cy="50%"
                  innerRadius="35%"
                  outerRadius="65%"
                  paddingAngle={5}
                >
                  {stats.salesByMethod.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={`hsl(var(--chart-${(index % 5) + 1}))`} />
                  ))}
                </Pie>
                <ChartTooltip content={<ChartTooltipContent />} />
                <Legend />
              </PieChart>
            </ChartContainer>
          </CardContent>
        </Card>

        {/* Top Products */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Package className="h-5 w-5 text-green-500" />
              Top Products Today
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ChartContainer
              config={{
                chartRevenue: { label: "Revenue (KSh)", color: "hsl(var(--chart-3))" },
              }}
              className="h-[300px]"
            >
              <BarChart data={stats.topProducts.map((row) => ({ ...row, chartRevenue: chartMoneyFromCents(row.revenueCents) }))} layout="vertical" margin={{ left: 80 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis type="number" stroke="hsl(var(--muted-foreground))" />
                <YAxis 
                  type="category" 
                  dataKey="name" 
                  stroke="hsl(var(--muted-foreground))"
                  width={70}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="chartRevenue" fill="hsl(var(--chart-3))" radius={[0, 8, 8, 0]} />
              </BarChart>
            </ChartContainer>
          </CardContent>
        </Card>

        {/* Recent Transactions */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShoppingCart className="h-5 w-5 text-blue-500" />
              Recent Transactions
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Method</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.recentTransactions.map((txn) => (
                  <TableRow key={txn.id} className="animate-fade-in">
                    <TableCell className="font-medium">{txn.time}</TableCell>
                    <TableCell>
                      <span className="font-semibold text-green-600 dark:text-green-400">
                        {formatMoneyCents(txn.amountCents)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className="capitalize">
                        {txn.method}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
