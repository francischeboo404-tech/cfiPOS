import { validatePhoneNumber, normalizeKenyanPhoneNumber, sanitizeInput, secureApiCall, apiRateLimiter } from '@/lib/security';
import { ApiService } from '@/lib/api';
import { useState, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import JsBarcode from 'jsbarcode';
import { Plus, Edit, Trash2, Users, Search, Printer, RefreshCw, UserPlus, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuthContext';
import { formatKesCents, parseKesToCents } from '@/lib/exactMoney';

interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  national_id: string | null;
  alternative_phone: string | null;
  address: string | null;
  total_purchases: number | string;
  purchase_count: number;
  is_frequent: boolean;
  credit_limit: number;
  credit_balance: number | string;
  loyalty_enrolled: boolean;
  voucher_status: 'Active' | 'Expired' | 'Not enrolled';
  open_installment_balance_cents: string;
  installment_overdue_cents: string;
  active_installment_agreements: number;
  voucher?: {
    id: string;
    number: string;
    issueDate: string;
    expiryDate: string;
    balance: string;
  } | null;
}

interface RenewalCheckout {
  id: string;
  status: 'reserved' | 'completed' | 'cancelled';
  total_amount: string;
  cash_amount: string;
  cash_paid_cents: string;
  mpesa_paid_cents: string;
  remaining_cents: string;
  max_mpesa_shillings: string;
  fully_paid: boolean;
  mpesa_transactions: Array<{
    id: string;
    status: string;
    amount: string;
    mpesa_receipt_number: string | null;
    result_desc?: string | null;
    mismatch_reason?: string | null;
  }>;
}

interface RenewalMpesaConfig {
  stk_push_enabled?: boolean;
  stk_push_issues?: string[];
}

export default function Customers() {
  const { role } = useAuth();
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [customerFilter, setCustomerFilter] = useState('all');
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [deleteCustomerId, setDeleteCustomerId] = useState<string | null>(null);
  const [renewVoucherCustomer, setRenewVoucherCustomer] = useState<Customer | null>(null);
  const [isRenewingVoucher, setIsRenewingVoucher] = useState(false);
  const [renewalCheckout, setRenewalCheckout] = useState<RenewalCheckout | null>(null);
  const [renewalMpesaConfig, setRenewalMpesaConfig] = useState<RenewalMpesaConfig>({});
  const [renewalPhone, setRenewalPhone] = useState('');
  const [renewalCashInput, setRenewalCashInput] = useState('');
  const [renewalPaymentBusy, setRenewalPaymentBusy] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    phone: '',
    email: '',
    national_id: '',
    alternative_phone: '',
    address: '',
  });
  const [selectedVoucherCustomers, setSelectedVoucherCustomers] = useState<string[]>([]);
  const [printCustomers, setPrintCustomers] = useState<Customer[]>([]);
  const [printMode, setPrintMode] = useState<'single' | 'batch'>('single');
  const [storeName, setStoreName] = useState('Store');
  const printRootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadCustomers();
    ApiService.get<Record<string, string>>('/receipt-settings')
      .then((settings) => setStoreName(settings.company_name || 'Store'))
      .catch((error) => console.error('Unable to load voucher card store name:', error));
  }, []);

  useEffect(() => {
    if (!printCustomers.length || !printRootRef.current) return;
    try {
      printRootRef.current.querySelectorAll<SVGSVGElement>('[data-voucher-barcode]').forEach((svg) => {
        const number = svg.dataset.voucherBarcode || '';
        JsBarcode(svg, number, {
          format: 'CODE128',
          displayValue: false,
          height: 32,
          width: 1.5,
          margin: 0,
        });
      });
      const timer = window.setTimeout(() => window.print(), 100);
      return () => window.clearTimeout(timer);
    } catch (error) {
      console.error('Unable to render voucher barcodes:', error);
      toast.error('Voucher barcode could not be prepared for printing.');
    }
  }, [printCustomers, printMode]);

  useEffect(() => {
    const clearPrintState = () => setPrintCustomers([]);
    window.addEventListener('afterprint', clearPrintState);
    return () => window.removeEventListener('afterprint', clearPrintState);
  }, []);

  const renewalCheckoutId = renewalCheckout?.id;
  const renewalCheckoutStatus = renewalCheckout?.status;
  useEffect(() => {
    if (!renewalCheckoutId || renewalCheckoutStatus !== 'reserved') return;
    let cancelled = false;
    const refreshCheckout = async () => {
      try {
        const current = await ApiService.get<RenewalCheckout>(`/sales/checkouts/${renewalCheckoutId}`);
        if (!cancelled) setRenewalCheckout(current);
      } catch (error) {
        if (!cancelled) {
          console.error('Unable to refresh voucher renewal payment status:', error);
        }
      }
    };

    const interval = window.setInterval(() => void refreshCheckout(), 2000);
    void refreshCheckout();
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [renewalCheckoutId, renewalCheckoutStatus]);

  const printVoucherCards = async (items: Customer[], mode: 'single' | 'batch') => {
    const printable = items.filter((customer) => customer.voucher?.id);
    if (!printable.length) {
      toast.error('The selected customer has no voucher card to print.');
      return;
    }
    try {
      await Promise.all(printable.map((customer) =>
        ApiService.post(`/vouchers/${customer.voucher!.id}/print`, {}),
      ));
      setPrintMode(mode);
      setPrintCustomers(printable);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Voucher print action could not be logged.');
    }
  };

  const toggleVoucherSelection = (customerId: string) => {
    setSelectedVoucherCustomers((current) => current.includes(customerId)
      ? current.filter((id) => id !== customerId)
      : [...current, customerId]);
  };

  const selectVisibleVouchers = (checked: boolean) => {
    const visibleVoucherIds = filteredCustomers
      .filter((customer) => customer.voucher)
      .map((customer) => customer.id);
    setSelectedVoucherCustomers((current) => checked
      ? Array.from(new Set([...current, ...visibleVoucherIds]))
      : current.filter((id) => !visibleVoucherIds.includes(id)));
  };

  const loadCustomers = async () => {
    try {
      const data = await ApiService.get<Customer[]>('/customers');
      setCustomers(data || []);
    } catch (error) {
      toast.error('Failed to load customers: ' + error.message);
    }
  };

  const filteredCustomers = customers.filter(
    (c) =>
      (c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        c.phone.toLowerCase().includes(searchTerm.toLowerCase()) ||
        c.voucher?.number.includes(searchTerm.trim())) &&
      (customerFilter === 'all' ||
        (customerFilter === 'loyalty_enrolled' && c.loyalty_enrolled) ||
        (customerFilter === 'not_enrolled' && !c.loyalty_enrolled) ||
        (customerFilter === 'expired' && c.voucher_status === 'Expired') ||
        (customerFilter === 'installment' && c.active_installment_agreements > 0) ||
        (customerFilter === 'overdue' && parseKesToCents(c.installment_overdue_cents) > 0n))
  );

  const enrollCustomer = async (customer: Customer) => {
    try {
      await ApiService.post('/loyalty/members', { customer_id: customer.id });
      toast.success('Customer enrolled in loyalty');
      await loadCustomers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to enrol customer in loyalty');
    }
  };

  const exportCustomers = () => {
    const rows = [
      ['Name', 'Phone', 'Email', 'Loyalty Enrolled', 'Voucher Number', 'Issue Date', 'Expiry Date',
        'Voucher Status', 'Points Balance', 'Open Installment Balance', 'Overdue Amount', 'Active Agreements'],
      ...filteredCustomers.map((customer) => [
        customer.name,
        customer.phone,
        customer.email || '',
        customer.loyalty_enrolled ? 'Yes' : 'No',
        customer.voucher?.number || '',
        customer.voucher?.issueDate || '',
        customer.voucher?.expiryDate || '',
        customer.voucher_status,
        customer.voucher?.balance || '0',
        formatCents(customer.open_installment_balance_cents),
        formatCents(customer.installment_overdue_cents),
        String(customer.active_installment_agreements),
      ]),
    ];
    const csv = rows.map((row) => row.map((value) =>
      `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'customers.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const voucherPages: Customer[][] = [];
  if (printMode === 'single') {
    printCustomers.forEach((customer) => voucherPages.push([customer]));
  } else {
    for (let index = 0; index < printCustomers.length; index += 8) {
      voucherPages.push(printCustomers.slice(index, index + 8));
    }
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // Validate inputs
    const sanitizedName = sanitizeInput(formData.name);
    const sanitizedPhone = formData.phone.replace(/\s+/g, '');
    const sanitizedEmail = formData.email ? sanitizeInput(formData.email) : '';

    if (!sanitizedName || sanitizedName.length < 2) {
      toast.error('Name must be at least 2 characters long');
      return;
    }

    if (!validatePhoneNumber(sanitizedPhone)) {
      toast.error('Please enter a valid Kenyan phone number (e.g. 0712345678 or 254712345678)');
      return;
    }

    if (sanitizedEmail && !sanitizedEmail.includes('@')) {
      toast.error('Please enter a valid email address');
      return;
    }

    try {
      const normalizedPhone = normalizeKenyanPhoneNumber(sanitizedPhone);

      if (!normalizedPhone) {
        toast.error('Please enter a valid Kenyan phone number (e.g. 0712345678 or 254712345678)');
        return;
      }

      const customerData = {
        name: sanitizedName,
        phone: normalizedPhone,
        email: sanitizedEmail || null,
        national_id: sanitizeInput(formData.national_id) || null,
        alternative_phone: formData.alternative_phone.trim() || null,
        address: sanitizeInput(formData.address) || null,
      };

      await secureApiCall(async () => {
        if (editingCustomer) {
          await ApiService.put(`/customers/${editingCustomer.id}`, customerData);
          toast.success('Customer updated successfully');
        } else {
          await ApiService.post('/customers', customerData);
          toast.success('Customer added successfully');
        }
      }, apiRateLimiter, 'customer_operation');

      setIsDialogOpen(false);
      setFormData({ name: '', phone: '', email: '', national_id: '', alternative_phone: '', address: '' });
      setEditingCustomer(null);
      loadCustomers();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const handleEdit = (customer: Customer) => {
    setEditingCustomer(customer);
    setFormData({
      name: customer.name,
      phone: customer.phone,
      email: customer.email || '',
      national_id: customer.national_id || '',
      alternative_phone: customer.alternative_phone || '',
      address: customer.address || '',
    });
    setIsDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!deleteCustomerId) return;
    try {
      await ApiService.delete(`/customers/${deleteCustomerId}`);
      toast.success('Customer deleted');
      loadCustomers();
    } catch (error) {
      toast.error(error.message);
    }
    setDeleteCustomerId(null);
  };

  const handleRenewVoucher = async () => {
    const voucher = renewVoucherCustomer?.voucher;
    if (!voucher) return;
    setIsRenewingVoucher(true);
    try {
      const result = await ApiService.post<RenewalCheckout | {
        number: string;
        expiryDate: string;
        balance: string;
        renewalId: string;
      }>(`/vouchers/${voucher.id}/renewal-checkouts`, {});
      setRenewVoucherCustomer(null);
      if ('renewalId' in result) {
        toast.success(`Voucher renewed. Valid until ${result.expiryDate}.`);
        await loadCustomers();
        return;
      }
      setRenewalCheckout(result);
      setRenewalPhone(renewVoucherCustomer?.phone || '');
      setRenewalCashInput('');
      try {
        setRenewalMpesaConfig(await ApiService.get<RenewalMpesaConfig>('/payments/mpesa/config'));
      } catch (error) {
        console.error('Unable to load M-Pesa configuration for voucher renewal:', error);
        setRenewalMpesaConfig({ stk_push_enabled: false });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to renew voucher.');
    } finally {
      setIsRenewingVoucher(false);
    }
  };

  const completeRenewalCheckout = async (checkoutId: string) => {
    if (renewalPaymentBusy) return;
    setRenewalPaymentBusy(true);
    try {
      const result = await ApiService.post<{
        expiryDate: string;
      }>(`/vouchers/renewal-checkouts/${checkoutId}/complete`, {});
      toast.success(`Voucher renewed. Valid until ${result.expiryDate}.`);
      setRenewalCheckout(null);
      setRenewalCashInput('');
      setRenewVoucherCustomer(null);
      await loadCustomers();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to complete voucher renewal.');
    } finally {
      setRenewalPaymentBusy(false);
    }
  };

  const recordRenewalCash = async () => {
    if (!renewalCheckout || !renewalCashInput.trim()) return;
    setRenewalPaymentBusy(true);
    try {
      const updated = await ApiService.post<RenewalCheckout>(
        `/vouchers/renewal-checkouts/${renewalCheckout.id}/cash`,
        { amount: renewalCashInput.trim() },
      );
      setRenewalCheckout(updated);
      setRenewalCashInput('');
      toast.success('Cash payment recorded.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to record cash payment.');
    } finally {
      setRenewalPaymentBusy(false);
    }
  };

  const requestRenewalMpesa = async () => {
    if (!renewalCheckout) return;
    const amount = Number(renewalCheckout.max_mpesa_shillings);
    if (!Number.isSafeInteger(amount) || amount <= 0 || !renewalPhone.trim()) return;
    setRenewalPaymentBusy(true);
    try {
      await ApiService.post('/payments/mpesa/stk-push', {
        phone_number: renewalPhone.trim(),
        amount,
        checkout_session_id: renewalCheckout.id,
        items: [],
        loyalty_discount: 0,
        cash_amount: renewalCheckout.cash_amount,
        store_credit_amount: 0,
      });
      toast.info('M-Pesa payment request sent.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to start M-Pesa payment.');
    } finally {
      setRenewalPaymentBusy(false);
    }
  };

  const cancelRenewalCheckout = async () => {
    if (!renewalCheckout) return;
    if (renewalCheckout.cash_paid_cents !== '0' || renewalCheckout.mpesa_paid_cents !== '0' ||
      renewalCheckout.mpesa_transactions.some((transaction) =>
        transaction.status === 'pending' || transaction.status === 'completed')) {
      toast.error('A checkout with a payment cannot be cancelled. Complete the payment to renew.');
      return;
    }
    setRenewalPaymentBusy(true);
    try {
      await ApiService.post(`/sales/checkouts/${renewalCheckout.id}/cancel`, {});
      setRenewalCheckout(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to cancel renewal checkout.');
    } finally {
      setRenewalPaymentBusy(false);
    }
  };

  const formatCents = (cents: string) => {
    const value = BigInt(cents);
    return `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
  };

  return (
    <div className="p-2 sm:p-4 md:p-6 space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Customers</h1>
          <p className="text-sm sm:text-base text-muted-foreground">Manage your customer database</p>
        </div>
        <Button
          variant="outline"
          disabled={!selectedVoucherCustomers.length}
          onClick={() => void printVoucherCards(
            customers.filter((customer) => selectedVoucherCustomers.includes(customer.id)),
            'batch',
          )}
        >
          <Printer className="h-4 w-4 mr-2" />
          Print selected cards ({selectedVoucherCustomers.length})
        </Button>
        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button onClick={() => { setEditingCustomer(null); setFormData({ name: '', phone: '', email: '', national_id: '', alternative_phone: '', address: '' }); }}>
              <Plus className="h-4 w-4 mr-2" />
              Add Customer
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingCustomer ? 'Edit' : 'Add'} Customer</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <Label htmlFor="name">Name *</Label>
                <Input
                  id="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                />
              </div>
              <div>
                <Label htmlFor="national_id">National ID</Label>
                <Input
                  id="national_id"
                  value={formData.national_id}
                  onChange={(e) => setFormData({ ...formData, national_id: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="alternative_phone">Alternative Phone</Label>
                <Input
                  id="alternative_phone"
                  value={formData.alternative_phone}
                  onChange={(e) => setFormData({ ...formData, alternative_phone: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="address">Address</Label>
                <Input
                  id="address"
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="phone">Phone *</Label>
                <Input
                  id="phone"
                  value={formData.phone}
                  onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                  placeholder="+254 700 000000"
                  required
                />
              </div>
              <div>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                />
              </div>
              <Button type="submit" className="w-full">
                {editingCustomer ? 'Update' : 'Add'} Customer
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search name, phone, or voucher number..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-10"
              />
            </div>
            <select
              aria-label="Filter customers"
              className="h-10 rounded-md border bg-background px-3 text-sm"
              value={customerFilter}
              onChange={(event) => setCustomerFilter(event.target.value)}
            >
              <option value="all">All customers</option>
              <option value="loyalty_enrolled">Loyalty enrolled</option>
              <option value="not_enrolled">Not enrolled</option>
              <option value="expired">Expired vouchers</option>
              <option value="installment">Installment customers</option>
              <option value="overdue">Overdue customers</option>
            </select>
            <Button variant="outline" onClick={exportCustomers}>
              <Download className="h-4 w-4 mr-2" />
              Export CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    aria-label="Select all customer voucher cards"
                    type="checkbox"
                    checked={filteredCustomers.length > 0 && filteredCustomers
                      .filter((customer) => customer.voucher)
                      .every((customer) => selectedVoucherCustomers.includes(customer.id))}
                    onChange={(event) => selectVisibleVouchers(event.target.checked)}
                  />
                </TableHead>
                <TableHead className="text-xs sm:text-sm">Name</TableHead>
                <TableHead className="text-xs sm:text-sm">Phone</TableHead>
                <TableHead className="text-xs sm:text-sm">Voucher</TableHead>
                <TableHead className="text-xs sm:text-sm">Loyalty Enrolled</TableHead>
                <TableHead className="hidden lg:table-cell text-xs sm:text-sm">Issue Date</TableHead>
                <TableHead className="hidden lg:table-cell text-xs sm:text-sm">Expiry Date</TableHead>
                <TableHead className="text-xs sm:text-sm">Voucher Status</TableHead>
                <TableHead className="text-xs sm:text-sm">Points</TableHead>
                <TableHead className="text-xs sm:text-sm">Installment Balance</TableHead>
                <TableHead className="text-xs sm:text-sm">Overdue</TableHead>
                <TableHead className="text-xs sm:text-sm">Active Plans</TableHead>
                <TableHead className="hidden md:table-cell text-xs sm:text-sm">Email</TableHead>
                <TableHead className="text-xs sm:text-sm">Purchases</TableHead>
                <TableHead className="hidden lg:table-cell text-xs sm:text-sm">Total Spent</TableHead>
                <TableHead className="hidden xl:table-cell text-xs sm:text-sm">Credit Balance</TableHead>
                <TableHead className="hidden sm:table-cell text-xs sm:text-sm">Status</TableHead>
                <TableHead className="text-right text-xs sm:text-sm">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredCustomers.map((customer) => (
                <TableRow key={customer.id}>
                  <TableCell>
                    <input
                      aria-label={`Select voucher for ${customer.name}`}
                      type="checkbox"
                      disabled={!customer.voucher}
                      checked={selectedVoucherCustomers.includes(customer.id)}
                      onChange={() => toggleVoucherSelection(customer.id)}
                    />
                  </TableCell>
                  <TableCell className="font-medium text-xs sm:text-sm">{customer.name}</TableCell>
                  <TableCell className="text-xs sm:text-sm">{customer.phone}</TableCell>
                  <TableCell className="text-xs sm:text-sm font-mono">
                    {customer.voucher ? (
                      <div className="space-y-1">
                        <div>{customer.voucher.number}</div>
                        <div className="font-sans">
                          {customer.voucher_status === 'Expired' ? (
                            <Badge variant="destructive">Expired</Badge>
                          ) : (
                            <span className="text-muted-foreground">Valid until {customer.voucher.expiryDate}</span>
                          )}
                        </div>
                      </div>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-xs sm:text-sm">
                    {customer.loyalty_enrolled ? 'Yes' : 'No'}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs sm:text-sm">
                    {customer.voucher?.issueDate || '—'}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell text-xs sm:text-sm">
                    {customer.voucher?.expiryDate || '—'}
                  </TableCell>
                  <TableCell className="text-xs sm:text-sm">
                    <Badge variant={customer.voucher_status === 'Expired' ? 'destructive' :
                      customer.voucher_status === 'Active' ? 'secondary' : 'outline'}>
                      {customer.voucher_status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs sm:text-sm">
                    {customer.voucher?.balance || '0'}
                  </TableCell>
                  <TableCell className="text-xs sm:text-sm">
                    {formatKesCents(parseKesToCents(customer.open_installment_balance_cents || '0'))}
                  </TableCell>
                  <TableCell className="text-xs sm:text-sm">
                    {formatKesCents(parseKesToCents(customer.installment_overdue_cents || '0'))}
                  </TableCell>
                  <TableCell className="text-xs sm:text-sm">{customer.active_installment_agreements || 0}</TableCell>
                  <TableCell className="hidden md:table-cell text-xs sm:text-sm">{customer.email || '-'}</TableCell>
                  <TableCell className="text-xs sm:text-sm">{customer.purchase_count}</TableCell>
                  <TableCell className="hidden lg:table-cell text-xs sm:text-sm">
                    {formatKesCents(parseKesToCents(String(customer.total_purchases)))}
                  </TableCell>
                  <TableCell className="hidden xl:table-cell text-xs sm:text-sm">
                    {parseKesToCents(String(customer.credit_balance)) > 0 ? (
                      <Badge variant="destructive">
                        {formatKesCents(parseKesToCents(String(customer.credit_balance)))}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">-</span>
                    )}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    {customer.is_frequent && (
                      <Badge variant="secondary">
                        <Users className="h-3 w-3 mr-1" />
                        Frequent
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right space-x-2">
                    {!customer.loyalty_enrolled && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Enrol ${customer.name} in loyalty`}
                        onClick={() => void enrollCustomer(customer)}
                      >
                        <UserPlus className="h-4 w-4" />
                      </Button>
                    )}
                    {customer.voucher && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Print voucher card for ${customer.name}`}
                          onClick={() => void printVoucherCards([customer], 'single')}
                        >
                          <Printer className="h-4 w-4" />
                        </Button>
                        {(role === 'admin' || role === 'manager') && (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Renew voucher for ${customer.name}`}
                            onClick={() => setRenewVoucherCustomer(customer)}
                          >
                            <RefreshCw className="h-4 w-4" />
                          </Button>
                        )}
                      </>
                    )}
                    <Button variant="ghost" size="icon" onClick={() => handleEdit(customer)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={() => setDeleteCustomerId(customer.id)}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div
        ref={printRootRef}
        className={`voucher-print-root ${printMode}`}
        aria-hidden="true"
      >
        <style>{`
          @page { size: auto; margin: 6mm; }
          @media screen { .voucher-print-root { display: none; } }
          @media print {
            body * { visibility: hidden !important; }
            .voucher-print-root, .voucher-print-root * { visibility: visible !important; }
            .voucher-print-root { position: absolute; inset: 0; }
            .voucher-page { box-sizing: border-box; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); grid-template-rows: repeat(4, minmax(0, 1fr)); gap: 3mm; width: 100%; height: 100%; page-break-after: always; break-after: page; }
            .voucher-page.single { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); page-break-after: auto; break-after: auto; }
            .voucher-page:last-child { page-break-after: auto; break-after: auto; }
            .voucher-card-cell { display: grid; min-width: 0; min-height: 0; place-items: center; container-type: size; }
            .voucher-card { box-sizing: border-box; width: min(100cqw, calc(100cqh * 1.585185)); aspect-ratio: 85.6 / 54; padding: 4.7cqw; border: 0.35cqw solid #111; border-radius: 3.5cqw; background: #fff; color: #111; font-family: Arial, sans-serif; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between; container-type: inline-size; }
            .voucher-store { font-size: 4.5cqw; font-weight: 700; }
            .voucher-customer { font-size: 3.7cqw; overflow-wrap: anywhere; }
            .voucher-number { font-size: 7cqw; font-weight: 700; letter-spacing: 0.4cqw; }
            .voucher-barcode { width: 100%; }
            .voucher-validity { font-size: 3.3cqw; text-align: right; }
          }
        `}</style>
        {voucherPages.map((page, pageIndex) => (
          <div
            className={`voucher-page ${printMode === 'single' ? 'single' : ''}`}
            key={`${printMode}-${pageIndex}`}
          >
            {page.map((customer) => (
              <div className="voucher-card-cell" key={customer.id}>
                <div className="voucher-card">
                  <div className="voucher-store">{storeName}</div>
                  <div className="voucher-customer">{customer.name} · {customer.phone}</div>
                  <div className="voucher-number">{customer.voucher?.number}</div>
                  <svg
                    className="voucher-barcode"
                    data-voucher-barcode={customer.voucher?.number}
                  />
                  <div className="voucher-validity">Valid until {customer.voucher?.expiryDate}</div>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <AlertDialog open={!!deleteCustomerId} onOpenChange={(open) => !open && setDeleteCustomerId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Customer</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this customer? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={renewVoucherCustomer !== null}
        onOpenChange={(open) => {
          if (!open && !isRenewingVoucher) setRenewVoucherCustomer(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Renew customer voucher?</AlertDialogTitle>
            <AlertDialogDescription>
              {renewVoucherCustomer?.name}'s voucher number and points balance will remain unchanged.
              If renewed on or before expiry, validity extends one year from the current expiry date;
              if expired, validity starts from the renewal date. Any configured renewal fee is collected separately before the expiry is changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isRenewingVoucher}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isRenewingVoucher}
              onClick={(event) => {
                event.preventDefault();
                void handleRenewVoucher();
              }}
            >
              {isRenewingVoucher ? 'Renewing…' : 'Renew voucher'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={renewalCheckout !== null}
        onOpenChange={(open) => {
          if (!open && !renewalPaymentBusy) void cancelRenewalCheckout();
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Voucher renewal payment</DialogTitle>
            <DialogDescription>
              The renewal fee is VAT-inclusive at Standard VAT 16%. The voucher expiry changes only after the full cash/M-Pesa payment is confirmed.
            </DialogDescription>
          </DialogHeader>
          {renewalCheckout && (
            <div className="space-y-4">
              <div className="rounded-md border p-3 text-sm">
                <div className="flex justify-between font-semibold">
                  <span>Renewal fee</span>
                  <span>KES {renewalCheckout.total_amount}</span>
                </div>
                <div className="mt-1 flex justify-between text-muted-foreground">
                  <span>Remaining</span>
                  <span>KES {formatCents(renewalCheckout.remaining_cents)}</span>
                </div>
                {renewalCheckout.mpesa_transactions.some((transaction) => transaction.status === 'pending') && (
                  <p className="mt-2 text-amber-700">Waiting for M-Pesa confirmation.</p>
                )}
                {renewalCheckout.mpesa_transactions.some((transaction) => transaction.status === 'needs_review') && (
                  <p className="mt-2 text-destructive">
                    An M-Pesa payment needs administrator review before any further payment or renewal.
                    {renewalCheckout.mpesa_transactions.find((transaction) => transaction.status === 'needs_review')?.mismatch_reason
                      ? ` ${renewalCheckout.mpesa_transactions.find((transaction) => transaction.status === 'needs_review')?.mismatch_reason}`
                      : ''}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="renewal-cash-amount">Cash tender (KES)</Label>
                <div className="flex gap-2">
                  <Input
                    id="renewal-cash-amount"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={renewalCashInput}
                    onChange={(event) => setRenewalCashInput(event.target.value)}
                    disabled={renewalPaymentBusy || renewalCheckout.fully_paid ||
                      renewalCheckout.mpesa_transactions.some((transaction) =>
                        transaction.status === 'pending' || transaction.status === 'needs_review')}
                  />
                  <Button
                    onClick={() => void recordRenewalCash()}
                    disabled={!renewalCashInput || renewalPaymentBusy || renewalCheckout.fully_paid ||
                      renewalCheckout.mpesa_transactions.some((transaction) =>
                        transaction.status === 'pending' || transaction.status === 'needs_review')}
                  >
                    Record cash
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Enter only the cash amount received. The server validates it against the unpaid fee.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="renewal-mpesa-phone">M-Pesa phone number</Label>
                <div className="flex gap-2">
                  <Input
                    id="renewal-mpesa-phone"
                    value={renewalPhone}
                    onChange={(event) => setRenewalPhone(event.target.value)}
                    disabled={renewalPaymentBusy || renewalCheckout.fully_paid}
                  />
                  <Button
                    variant="outline"
                    onClick={() => void requestRenewalMpesa()}
                    disabled={!renewalMpesaConfig.stk_push_enabled ||
                      Number(renewalCheckout.max_mpesa_shillings) <= 0 ||
                      renewalCheckout.mpesa_transactions.some((transaction) =>
                        transaction.status === 'pending' || transaction.status === 'needs_review') ||
                      renewalPaymentBusy || renewalCheckout.fully_paid}
                  >
                    Pay KES {renewalCheckout.max_mpesa_shillings} by M-Pesa
                  </Button>
                </div>
                {!renewalMpesaConfig.stk_push_enabled && (
                  <p className="text-xs text-muted-foreground">
                    M-Pesa STK is unavailable; record cash or resolve the payment configuration.
                  </p>
                )}
              </div>
              {renewalCheckout.fully_paid && (
                <p className="text-sm font-medium text-green-700">Full payment confirmed. Complete the renewal to update voucher expiry.</p>
              )}
              <DialogFooter>
                {renewalCheckout.fully_paid ? (
                  <Button onClick={() => void completeRenewalCheckout(renewalCheckout.id)} disabled={renewalPaymentBusy}>
                    {renewalPaymentBusy ? 'Completing…' : 'Complete renewal'}
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    onClick={() => void cancelRenewalCheckout()}
                    disabled={renewalPaymentBusy || renewalCheckout.cash_paid_cents !== '0' ||
                      renewalCheckout.mpesa_paid_cents !== '0' ||
                      renewalCheckout.mpesa_transactions.some((transaction) =>
                        transaction.status === 'pending' || transaction.status === 'needs_review' ||
                        transaction.status === 'completed')}
                  >
                    Cancel checkout
                  </Button>
                )}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
