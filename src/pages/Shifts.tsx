import { useState, useEffect } from 'react';
import { ApiService } from '@/lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { Clock, Play, Square } from 'lucide-react';
import { useAuth } from '@/hooks/useAuthContext';

interface Shift {
  id: string;
  cashier_id: string;
  start_time: string;
  end_time: string | null;
  opening_float: string;
  expected_cash: string;
  actual_cash: string;
  mpesa_total: string;
  total_sales: string;
  status: string;
  cashier?: { full_name: string };
}

const parseMoneyCents = (value: string): bigint => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error('Invalid exact KES amount');
  const cents = BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0') || '0');
  return match[1] === '-' ? -cents : cents;
};

const formatMoneyCents = (cents: bigint): string => {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = new Intl.NumberFormat('en-KE').format(absolute / 100n);
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '-' : ''}KSh ${whole}.${fraction}`;
};

const formatMoney = (value: string): string => formatMoneyCents(parseMoneyCents(value));

export default function Shifts() {
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [activeShift, setActiveShift] = useState<Shift | null>(null);
  const [loading, setLoading] = useState(true);
  const [openingCash, setOpeningCash] = useState('');
  const [closingCash, setClosingCash] = useState('');
  const { user } = useAuth();

  useEffect(() => {
    loadShifts();
    loadActiveShift();
  }, []);

  const loadShifts = async () => {
    try {
      const data = await ApiService.get<Shift[]>('/shifts');
      setShifts(data || []);
    } catch (error) {
      toast.error(error.message || 'Error loading shifts');
    } finally {
      setLoading(false);
    }
  };

  const loadActiveShift = async () => {
    try {
      const data = await ApiService.get<Shift>('/shifts/current');
      if (data && data.id) {
        setActiveShift(data);
      }
    } catch (error) {
      // No active shift, fine to ignore
      setActiveShift(null);
    }
  };

  const startShift = async () => {
    if (!/^\d+(?:\.\d{1,2})?$/.test(openingCash.trim())) {
      toast.error('Please enter a valid opening cash float');
      return;
    }

    try {
      const data = await ApiService.post<Shift>('/shifts/open', {
        opening_float: openingCash.trim()
      });
      setActiveShift(data);
      setOpeningCash('');
      toast.success('Shift started successfully');
      loadShifts();
    } catch (error) {
      toast.error(error.message || 'Error starting shift');
    }
  };

  const endShift = async () => {
    if (!activeShift) return;
    
    if (!/^\d+(?:\.\d{1,2})?$/.test(closingCash.trim())) {
      toast.error('Please enter a valid closing cash amount');
      return;
    }

    try {
      // In the backend, the closing logic calculates expected_cash (opening_float + cash sales)
      // We send the actual_cash counted by the cashier
      const enteredClosingCash = closingCash.trim();

      const res = await ApiService.post<{message: string, shift: Shift}>(`/shifts/${activeShift.id}/close`, {
        actual_cash: enteredClosingCash
      });

      const closedShift = res.shift;
      const expectedClosingCents = parseMoneyCents(closedShift.expected_cash);
      const varianceCents = parseMoneyCents(enteredClosingCash) - expectedClosingCents;

      if (varianceCents !== 0n) {
        toast.warning(
          `Shift Closed with Cash Variance. Expected: ${formatMoney(closedShift.expected_cash)}, Entered: ${formatMoney(enteredClosingCash)}. Variance: ${formatMoneyCents(varianceCents)}`
        );
      } else {
        toast.success(`Shift ended perfectly! Total sales: ${formatMoney(closedShift.total_sales)}`);
      }

      setActiveShift(null);
      setClosingCash('');
      loadShifts();
    } catch (error) {
      toast.error(error.message || 'Error ending shift');
    }
  };

  const calculateShiftDuration = (start: string, end: string | null) => {
    const startTime = new Date(start);
    const endTime = end ? new Date(end) : new Date();
    const diff = endTime.getTime() - startTime.getTime();
    const hours = Math.floor(diff / 3600000);
    const minutes = Math.floor((diff % 3600000) / 60000);
    return `${hours}h ${minutes}m`;
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold">Register Management</h1>
        <p className="text-muted-foreground">Manage cash drawers, track shifts, and perform Z-Reports</p>
      </div>

      {/* Active Shift Card */}
      <Card className={activeShift ? 'border-primary' : ''}>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-5 w-5" />
            Current Shift
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {activeShift ? (
            <>
              <div className="grid sm:grid-cols-3 gap-4">
                <div className="p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground mb-1">Started</p>
                  <p className="font-semibold">
                    {new Date(activeShift.start_time).toLocaleTimeString()}
                  </p>
                </div>
                <div className="p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground mb-1">Duration</p>
                  <p className="font-semibold">
                    {calculateShiftDuration(activeShift.start_time, null)}
                  </p>
                </div>
                <div className="p-4 bg-muted rounded-lg">
                  <p className="text-sm text-muted-foreground mb-1">Opening Float</p>
                  <p className="font-semibold">
                    {formatMoney(activeShift.opening_float)}
                  </p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-4 items-end mt-4 pt-4 border-t border-border">
                <div className="flex-1">
                  <label className="text-sm font-medium mb-2 block text-destructive">Physical Cash Drawer Count (KSh) *</label>
                  <input
                    type="number"
                    step="0.01"
                    value={closingCash}
                    onChange={(e) => setClosingCash(e.target.value)}
                    placeholder="Count the money in the drawer and enter the total"
                    className="w-full px-3 py-2 border rounded-md"
                  />
                  <p className="text-xs text-muted-foreground mt-1">This will be compared against system records for discrepancies.</p>
                </div>
                <Button onClick={endShift} variant="destructive" className="w-full sm:w-auto h-12">
                  <Square className="mr-2 h-4 w-4" />
                  Perform Z-Report & End Shift
                </Button>
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <p className="text-muted-foreground">You must have an active shift to process sales.</p>
              <div className="flex flex-col sm:flex-row gap-4 items-end mt-2">
                <div className="flex-1">
                  <label className="text-sm font-medium mb-2 block text-primary">Opening Float (KSh) *</label>
                  <input
                    type="number"
                    step="0.01"
                    value={openingCash}
                    onChange={(e) => setOpeningCash(e.target.value)}
                    placeholder="Enter cash amount currently in drawer"
                    className="w-full px-3 py-2 border rounded-md"
                  />
                </div>
                <Button onClick={startShift} className="w-full sm:w-auto h-12">
                  <Play className="mr-2 h-4 w-4" />
                  Open Register & Start Shift
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Shift History */}
      <Card>
        <CardHeader>
          <CardTitle>Shift History</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cashier</TableHead>
                  <TableHead className="hidden sm:table-cell">Start Time</TableHead>
                  <TableHead className="hidden sm:table-cell">End Time</TableHead>
                  <TableHead className="hidden md:table-cell">Duration</TableHead>
                  <TableHead>Float</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Actual</TableHead>
                  <TableHead>Variance</TableHead>
                  <TableHead className="hidden lg:table-cell">Total Sales</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8">
                      Loading shifts...
                    </TableCell>
                  </TableRow>
                ) : shifts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      No shifts recorded
                    </TableCell>
                  </TableRow>
                ) : (
                  shifts.map((shift) => {
                    const expected = parseMoneyCents(shift.expected_cash || '0');
                    const actual = parseMoneyCents(shift.actual_cash || '0');
                    const variance = shift.status === 'closed' ? actual - expected : null;
                    return (
                      <TableRow key={shift.id}>
                        <TableCell className="font-medium">
                          {shift.cashier?.full_name || 'Unknown'}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm">
                          {new Date(shift.start_time).toLocaleString()}
                        </TableCell>
                        <TableCell className="hidden sm:table-cell text-sm">
                          {shift.end_time ? new Date(shift.end_time).toLocaleString() : '-'}
                        </TableCell>
                        <TableCell className="hidden md:table-cell text-sm">
                          {calculateShiftDuration(shift.start_time, shift.end_time)}
                        </TableCell>
                        <TableCell className="text-sm">
                          {formatMoney(shift.opening_float)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {shift.status === 'closed' ? formatMoneyCents(expected) : '-'}
                        </TableCell>
                        <TableCell className="text-sm font-medium">
                          {shift.status === 'closed' ? formatMoneyCents(actual) : '-'}
                        </TableCell>
                        <TableCell className={`text-sm font-bold ${variance && variance < 0 ? 'text-destructive' : variance && variance > 0 ? 'text-green-600' : ''}`}>
                          {variance !== null ? `${variance > 0n ? '+' : ''}${formatMoneyCents(variance)}` : '-'}
                        </TableCell>
                        <TableCell className="hidden lg:table-cell font-medium">
                          {formatMoney(shift.total_sales || '0')}
                        </TableCell>
                        <TableCell>
                          <Badge variant={shift.status === 'open' ? 'default' : 'secondary'}>
                            {shift.status.toUpperCase()}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
