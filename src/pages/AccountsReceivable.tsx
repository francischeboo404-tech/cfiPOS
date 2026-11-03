import { useCallback, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuthContext";
import { ApiService } from "@/lib/api";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DollarSign,
  AlertTriangle,
  Clock,
  TrendingUp,
  Users,
  FileText,
  Phone,
  Mail,
} from "lucide-react";
import { format, differenceInDays, subDays } from "date-fns";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";

interface Invoice {
  id: string;
  invoice_number: string;
  customer_id: string | null;
  total_amount: number | string;
  paid_amount: number | string;
  balance_due: number | string;
  balance_due_cents: bigint;
  status: string;
  due_date: string | null;
  issued_at: string | null;
  created_at: string;
  customer?: {
    name: string;
    phone: string;
    email: string | null;
  };
}

interface AgingBucket {
  label: string;
  range: string;
  amount: bigint;
  count: number;
  color: string;
}

interface CustomerBalance {
  customer_id: string;
  customer_name: string;
  phone: string;
  email: string | null;
  total_outstanding: bigint;
  invoice_count: number;
  oldest_invoice_days: number;
}

const AccountsReceivable = () => {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [agingBuckets, setAgingBuckets] = useState<AgingBucket[]>([]);
  const [customerBalances, setCustomerBalances] = useState<CustomerBalance[]>(
    [],
  );
  const [totals, setTotals] = useState({
    totalReceivables: 0n,
    totalOverdue: 0n,
    totalCurrent: 0n,
    overdueCount: 0,
  });

  const calculateAging = useCallback((invoiceData: Invoice[]) => {
    const today = new Date();
    const buckets: AgingBucket[] = [
      {
        label: "Current",
        range: "Not Yet Due",
        amount: 0n,
        count: 0,
        color: "bg-green-500",
      },
      {
        label: "1-30 Days",
        range: "1-30 Days Overdue",
        amount: 0n,
        count: 0,
        color: "bg-yellow-500",
      },
      {
        label: "31-60 Days",
        range: "31-60 Days Overdue",
        amount: 0n,
        count: 0,
        color: "bg-orange-500",
      },
      {
        label: "61-90 Days",
        range: "61-90 Days Overdue",
        amount: 0n,
        count: 0,
        color: "bg-red-400",
      },
      {
        label: "90+ Days",
        range: "Over 90 Days Overdue",
        amount: 0n,
        count: 0,
        color: "bg-red-600",
      },
    ];

    invoiceData.forEach((invoice) => {
      if (!invoice.due_date) {
        buckets[0].amount += invoice.balance_due_cents;
        buckets[0].count++;
        return;
      }

      const dueDate = new Date(invoice.due_date);
      const daysOverdue = differenceInDays(today, dueDate);

      if (daysOverdue <= 0) {
        buckets[0].amount += invoice.balance_due_cents;
        buckets[0].count++;
      } else if (daysOverdue <= 30) {
        buckets[1].amount += invoice.balance_due_cents;
        buckets[1].count++;
      } else if (daysOverdue <= 60) {
        buckets[2].amount += invoice.balance_due_cents;
        buckets[2].count++;
      } else if (daysOverdue <= 90) {
        buckets[3].amount += invoice.balance_due_cents;
        buckets[3].count++;
      } else {
        buckets[4].amount += invoice.balance_due_cents;
        buckets[4].count++;
      }
    });

    setAgingBuckets(buckets);
  }, []);

  const calculateCustomerBalances = useCallback((invoiceData: Invoice[]) => {
    const today = new Date();
    const customerMap = new Map<string, CustomerBalance>();

    invoiceData.forEach((invoice) => {
      if (!invoice.customer_id || !invoice.customer) return;

      const existing = customerMap.get(invoice.customer_id);
      const invoiceDays = invoice.due_date
        ? Math.max(0, differenceInDays(today, new Date(invoice.due_date)))
        : 0;

      if (existing) {
        existing.total_outstanding += invoice.balance_due_cents;
        existing.invoice_count++;
        existing.oldest_invoice_days = Math.max(
          existing.oldest_invoice_days,
          invoiceDays,
        );
      } else {
        customerMap.set(invoice.customer_id, {
          customer_id: invoice.customer_id,
          customer_name: invoice.customer.name,
          phone: invoice.customer.phone,
          email: invoice.customer.email,
          total_outstanding: invoice.balance_due_cents,
          invoice_count: 1,
          oldest_invoice_days: invoiceDays,
        });
      }
    });

    const balances = Array.from(customerMap.values()).sort(
      (a, b) =>
        a.total_outstanding === b.total_outstanding
          ? 0
          : a.total_outstanding > b.total_outstanding
            ? -1
            : 1,
    );

    setCustomerBalances(balances);
  }, []);

  const calculateTotals = useCallback((invoiceData: Invoice[]) => {
    const today = new Date();
    let totalReceivables = 0n;
    let totalOverdue = 0n;
    let totalCurrent = 0n;
    let overdueCount = 0;

    invoiceData.forEach((invoice) => {
      totalReceivables += invoice.balance_due_cents;

      if (invoice.due_date) {
        const dueDate = new Date(invoice.due_date);
        if (differenceInDays(today, dueDate) > 0) {
          totalOverdue += invoice.balance_due_cents;
          overdueCount++;
        } else {
          totalCurrent += invoice.balance_due_cents;
        }
      } else {
        totalCurrent += invoice.balance_due_cents;
      }
    });

    setTotals({ totalReceivables, totalOverdue, totalCurrent, overdueCount });
  }, []);

  const loadReceivables = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await ApiService.get<Invoice[]>("/invoices");
      const invoiceData = (data || [])
        .filter((invoice) =>
          ["issued", "partially_paid"].includes(invoice.status),
        )
        .map((invoice) => ({
          ...invoice,
          balance_due_cents: BigInt(
            parseKesToCents(String(invoice.balance_due || 0)),
          ),
          customer: invoice.customer || undefined,
        })) as Invoice[];
      setInvoices(invoiceData);
      calculateAging(invoiceData);
      calculateCustomerBalances(invoiceData);
      calculateTotals(invoiceData);
    } catch (error) {
      console.error("Error loading receivables:", error);
      setLoadError(
        error instanceof Error ? error.message : "Failed to load receivables",
      );
    } finally {
      setLoading(false);
    }
  }, [calculateAging, calculateCustomerBalances, calculateTotals]);

  useEffect(() => {
    if (user) {
      void loadReceivables();
    }
  }, [loadReceivables, user]);

  const getStatusBadge = (invoice: Invoice) => {
    if (!invoice.due_date)
      return <Badge variant="secondary">No Due Date</Badge>;

    const daysOverdue = differenceInDays(
      new Date(),
      new Date(invoice.due_date),
    );

    if (daysOverdue > 90)
      return <Badge variant="destructive">90+ Days Overdue</Badge>;
    if (daysOverdue > 60)
      return <Badge className="bg-red-400">61-90 Days</Badge>;
    if (daysOverdue > 30)
      return <Badge className="bg-orange-500">31-60 Days</Badge>;
    if (daysOverdue > 0)
      return <Badge className="bg-yellow-500 text-black">1-30 Days</Badge>;
    return <Badge className="bg-green-500">Current</Badge>;
  };

  const totalAgingAmount = agingBuckets.reduce(
    (sum, bucket) => sum + bucket.amount,
    0n,
  );

  if (loading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <Skeleton className="h-8 w-64" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="container mx-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-5 w-5" />
              Receivables unavailable
            </CardTitle>
            <CardDescription role="alert">
              Receivables could not be loaded, so balances and aging totals are
              not shown. {loadError}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={() => void loadReceivables()}>
              Retry loading receivables
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Accounts Receivable</h1>
          <p className="text-muted-foreground">
            Track outstanding invoices and customer collections
          </p>
        </div>
        <Button onClick={() => navigate("/invoices")}>
          <FileText className="h-4 w-4 mr-2" />
          View All Invoices
        </Button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Total Receivables
            </CardTitle>
            <DollarSign className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {formatKesCents(totals.totalReceivables)}
            </div>
            <p className="text-xs text-muted-foreground">
              {invoices.length} outstanding invoices
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Current (Not Due)
            </CardTitle>
            <Clock className="h-4 w-4 text-green-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatKesCents(totals.totalCurrent)}
            </div>
            <p className="text-xs text-muted-foreground">
              Within payment terms
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Overdue</CardTitle>
            <AlertTriangle className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-red-600">
              {formatKesCents(totals.totalOverdue)}
            </div>
            <p className="text-xs text-muted-foreground">
              {totals.overdueCount} overdue invoices
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">
              Customers with Balance
            </CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{customerBalances.length}</div>
            <p className="text-xs text-muted-foreground">Requiring follow-up</p>
          </CardContent>
        </Card>
      </div>

      {/* Aging Report */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            Aging Report
          </CardTitle>
          <CardDescription>
            Breakdown of receivables by overdue period
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {agingBuckets.map((bucket, index) => (
              <div key={index} className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <div className={`w-3 h-3 rounded-full ${bucket.color}`} />
                    <span className="font-medium">{bucket.label}</span>
                    <span className="text-muted-foreground">
                      ({bucket.range})
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-muted-foreground">
                      {bucket.count} invoices
                    </span>
                    <span className="font-semibold w-32 text-right">
                      {formatKesCents(bucket.amount)}
                    </span>
                  </div>
                </div>
                <Progress
                  value={
                    totalAgingAmount > 0n
                      ? Number(bucket.amount * 10_000n / totalAgingAmount) / 100
                      : 0
                  }
                  className="h-2"
                />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Outstanding Customers */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Users className="h-5 w-5" />
              Top Outstanding Customers
            </CardTitle>
            <CardDescription>
              Customers with highest outstanding balances
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-center">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customerBalances.slice(0, 10).map((customer) => (
                  <TableRow key={customer.customer_id}>
                    <TableCell>
                      <div>
                        <p className="font-medium">{customer.customer_name}</p>
                        <p className="text-xs text-muted-foreground">
                          {customer.invoice_count} invoice(s) •
                          {customer.oldest_invoice_days > 0
                            ? ` ${customer.oldest_invoice_days} days overdue`
                            : " Current"}
                        </p>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatKesCents(customer.total_outstanding)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-center gap-1">
                        {customer.phone && (
                          <Button variant="ghost" size="icon" asChild>
                            <a href={`tel:${customer.phone}`}>
                              <Phone className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                        {customer.email && (
                          <Button variant="ghost" size="icon" asChild>
                            <a href={`mailto:${customer.email}`}>
                              <Mail className="h-4 w-4" />
                            </a>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {customerBalances.length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="text-center text-muted-foreground py-8"
                    >
                      No outstanding customer balances
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Recent Overdue Invoices */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5" />
              Overdue Invoices
            </CardTitle>
            <CardDescription>
              Invoices requiring immediate attention
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {invoices
                  .filter(
                    (inv) =>
                      inv.due_date &&
                      differenceInDays(new Date(), new Date(inv.due_date)) > 0,
                  )
                  .slice(0, 10)
                  .map((invoice) => (
                    <TableRow key={invoice.id}>
                      <TableCell>
                        <div>
                          <p className="font-medium">
                            {invoice.invoice_number}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {invoice.customer?.name || "Walk-in"} • Due:{" "}
                            {format(
                              new Date(invoice.due_date!),
                              "MMM dd, yyyy",
                            )}
                          </p>
                        </div>
                      </TableCell>
                      <TableCell>{getStatusBadge(invoice)}</TableCell>
                      <TableCell className="text-right font-semibold">
                        {formatKesCents(invoice.balance_due_cents)}
                      </TableCell>
                    </TableRow>
                  ))}
                {invoices.filter(
                  (inv) =>
                    inv.due_date &&
                    differenceInDays(new Date(), new Date(inv.due_date)) > 0,
                ).length === 0 && (
                  <TableRow>
                    <TableCell
                      colSpan={3}
                      className="text-center text-muted-foreground py-8"
                    >
                      No overdue invoices
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
};

export default AccountsReceivable;
