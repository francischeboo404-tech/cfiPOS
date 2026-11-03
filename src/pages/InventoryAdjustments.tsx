import { useState, useEffect } from 'react';
import { ApiService } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuthContext';
import { Plus } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';

interface Product {
  id: string;
  name: string;
  sku: string;
}

interface Warehouse {
  id: string;
  name: string;
}

interface Adjustment {
  id: string;
  product_id: string;
  warehouse_id: string;
  type: string;
  quantity_adjusted: number;
  reason: string;
  created_at: string;
  product: { name: string; sku: string };
  warehouse: { name: string };
  authorizer: {
    email: string;
    profile?: { full_name: string } | null;
  } | null;
}

export default function InventoryAdjustments() {
  const { role } = useAuth();
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    product_id: '',
    warehouse_id: '',
    type: 'shrinkage',
    quantity_adjusted: 0,
    reason: '',
  });

  const canManageAdjustments = role === 'admin' || role === 'manager' || role === 'supervisor';

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [adjRes, prodRes, whRes] = await Promise.all([
        ApiService.get<Adjustment[]>('/inventory/adjustments'),
        ApiService.get<Product[]>('/products'),
        ApiService.get<Warehouse[]>('/warehouses')
      ]);
      setAdjustments(adjRes || []);
      setProducts(prodRes || []);
      setWarehouses(whRes || []);
    } catch (error) {
      toast.error(error.message || 'Failed to load adjustments');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.quantity_adjusted === 0) {
      toast.error('Quantity adjusted cannot be 0');
      return;
    }

    try {
      await ApiService.post('/inventory/adjustment', formData);
      toast.success('Adjustment created');
      setDialogOpen(false);
      setFormData({
        product_id: '',
        warehouse_id: '',
        type: 'shrinkage',
        quantity_adjusted: 0,
        reason: '',
      });
      loadData();
    } catch (error) {
      toast.error(error.message || 'Failed to create adjustment');
    }
  };

  const getBadgeVariant = (type: string): React.ComponentProps<typeof Badge>["variant"] => {
    switch(type) {
      case 'shrinkage': return 'destructive';
      case 'damage': return 'destructive';
      case 'miscount': return 'secondary';
      case 'expiration': return 'outline';
      default: return 'default';
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Inventory Adjustments</h1>
          <p className="text-muted-foreground">Manage stock damages, shrinkage, and miscounts</p>
        </div>
        {canManageAdjustments && (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="h-4 w-4 mr-2" />
                New Adjustment
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Manual Adjustment</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label>Product *</Label>
                  <Select
                    value={formData.product_id}
                    onValueChange={(val) => setFormData({ ...formData, product_id: val })}
                    required
                  >
                    <SelectTrigger><SelectValue placeholder="Select Product" /></SelectTrigger>
                    <SelectContent>
                      {products.map(p => <SelectItem key={p.id} value={p.id}>{p.name} ({p.sku})</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Warehouse *</Label>
                  <Select
                    value={formData.warehouse_id}
                    onValueChange={(val) => setFormData({ ...formData, warehouse_id: val })}
                    required
                  >
                    <SelectTrigger><SelectValue placeholder="Select Warehouse" /></SelectTrigger>
                    <SelectContent>
                      {warehouses.map(w => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Type *</Label>
                  <Select
                    value={formData.type}
                    onValueChange={(val) => setFormData({ ...formData, type: val })}
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="shrinkage">Shrinkage (Loss/Theft)</SelectItem>
                      <SelectItem value="damage">Damage</SelectItem>
                      <SelectItem value="miscount">Miscount Correction</SelectItem>
                      <SelectItem value="expiration">Expiration</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Quantity Adjusted * (Use negative for deduction)</Label>
                  <Input
                    type="number"
                    value={formData.quantity_adjusted}
                    onChange={(e) => setFormData({ ...formData, quantity_adjusted: parseInt(e.target.value) })}
                    required
                  />
                </div>
                <div>
                  <Label>Reason *</Label>
                  <Textarea
                    value={formData.reason}
                    onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                    required
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
                  <Button type="submit">Submit Adjustment</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Card>
        <CardHeader><CardTitle>Adjustment History</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Product</TableHead>
                <TableHead>Warehouse</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Qty Adjusted</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Authorizer</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {adjustments.map((adj) => (
                <TableRow key={adj.id}>
                  <TableCell>{new Date(adj.created_at).toLocaleString()}</TableCell>
                  <TableCell>
                    <div className="font-medium">{adj.product?.name}</div>
                    <div className="text-xs text-muted-foreground">{adj.product?.sku}</div>
                  </TableCell>
                  <TableCell>{adj.warehouse?.name}</TableCell>
                  <TableCell>
                    <Badge variant={getBadgeVariant(adj.type)}>{adj.type}</Badge>
                  </TableCell>
                  <TableCell className={adj.quantity_adjusted < 0 ? 'text-destructive font-bold' : 'text-green-600 font-bold'}>
                    {adj.quantity_adjusted > 0 ? '+' : ''}{adj.quantity_adjusted}
                  </TableCell>
                  <TableCell className="max-w-xs truncate">{adj.reason}</TableCell>
                  <TableCell>
                    {adj.authorizer?.profile?.full_name ||
                      adj.authorizer?.email ||
                      'Unknown authorizer'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
