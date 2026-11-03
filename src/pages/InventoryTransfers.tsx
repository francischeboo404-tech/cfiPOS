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
import { Plus, ArrowRight, CheckCircle } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';

interface Warehouse {
  id: string;
  name: string;
}

interface Product {
  id: string;
  name: string;
  sku: string;
}

interface Transfer {
  id: string;
  product_id: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  quantity: number;
  status: string;
  created_at: string;
  product: { name: string; sku: string };
  from_warehouse: { name: string };
  to_warehouse: { name: string };
}

export default function InventoryTransfers() {
  const { role } = useAuth();
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formData, setFormData] = useState({
    product_id: '',
    from_warehouse_id: '',
    to_warehouse_id: '',
    quantity: 0,
  });

  const canManageTransfers = role === 'admin' || role === 'manager' || role === 'supervisor';

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const [transfersRes, warehousesRes, productsRes] = await Promise.all([
        ApiService.get<Transfer[]>('/inventory/transfers'),
        ApiService.get<Warehouse[]>('/warehouses'),
        ApiService.get<Product[]>('/products'),
      ]);
      setTransfers(transfersRes || []);
      setWarehouses(warehousesRes || []);
      setProducts(productsRes || []);
    } catch (error) {
      toast.error(error.message || 'Failed to load transfer data');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (formData.from_warehouse_id === formData.to_warehouse_id) {
      toast.error('Source and destination locations must be different');
      return;
    }

    try {
      await ApiService.post('/inventory/transfer', formData);
      toast.success('Transfer created');
      resetForm();
      loadData();
    } catch (error) {
      toast.error(error.message || 'Failed to create transfer');
    }
  };

  const resetForm = () => {
    setFormData({
      product_id: '',
      from_warehouse_id: '',
      to_warehouse_id: '',
      quantity: 0,
    });
    setDialogOpen(false);
  };

  const completeTransfer = async (transfer: Transfer) => {
    if (!confirm('Complete this transfer? This will update inventory levels.')) return;

    try {
      await ApiService.put(`/inventory/transfer/${transfer.id}/status`, {
        status: 'completed'
      });
      toast.success('Transfer completed');
      loadData();
    } catch (error) {
      toast.error(error.message || 'Failed to complete transfer');
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed': return 'default';
      case 'pending': return 'secondary';
      case 'cancelled': return 'destructive';
      default: return 'outline';
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-3xl font-bold">Inventory Transfers</h1>
          <p className="text-muted-foreground">Transfer stock between locations</p>
        </div>
        {canManageTransfers && (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button onClick={() => resetForm()}>
                <Plus className="h-4 w-4 mr-2" />
                New Transfer
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create Inventory Transfer</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div>
                  <Label htmlFor="product">Product *</Label>
                  <Select
                    value={formData.product_id}
                    onValueChange={(value) => setFormData({ ...formData, product_id: value })}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select product" />
                    </SelectTrigger>
                    <SelectContent>
                      {products.map((product) => (
                        <SelectItem key={product.id} value={product.id}>
                          {product.name} ({product.sku})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="from">From Location *</Label>
                  <Select
                    value={formData.from_warehouse_id}
                    onValueChange={(value) => setFormData({ ...formData, from_warehouse_id: value })}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select source" />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((warehouse) => (
                        <SelectItem key={warehouse.id} value={warehouse.id}>
                          {warehouse.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="to">To Location *</Label>
                  <Select
                    value={formData.to_warehouse_id}
                    onValueChange={(value) => setFormData({ ...formData, to_warehouse_id: value })}
                    required
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select destination" />
                    </SelectTrigger>
                    <SelectContent>
                      {warehouses.map((warehouse) => (
                        <SelectItem key={warehouse.id} value={warehouse.id}>
                          {warehouse.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="quantity">Quantity *</Label>
                  <Input
                    id="quantity"
                    type="number"
                    min="1"
                    value={formData.quantity}
                    onChange={(e) => setFormData({ ...formData, quantity: parseInt(e.target.value) })}
                    required
                  />
                </div>
                <div className="flex justify-end space-x-2">
                  <Button type="button" variant="outline" onClick={resetForm}>
                    Cancel
                  </Button>
                  <Button type="submit">Create Transfer</Button>
                </div>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Transfer History</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>From</TableHead>
                <TableHead className="text-center">→</TableHead>
                <TableHead>To</TableHead>
                <TableHead>Quantity</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transfers.map((transfer) => (
                <TableRow key={transfer.id}>
                  <TableCell>
                    <div>
                      <div className="font-medium">{transfer.product?.name || 'N/A'}</div>
                      <div className="text-sm text-muted-foreground">{transfer.product?.sku || ''}</div>
                    </div>
                  </TableCell>
                  <TableCell>{transfer.from_warehouse?.name || 'N/A'}</TableCell>
                  <TableCell className="text-center">
                    <ArrowRight className="h-4 w-4 mx-auto" />
                  </TableCell>
                  <TableCell>{transfer.to_warehouse?.name || 'N/A'}</TableCell>
                  <TableCell>{transfer.quantity}</TableCell>
                  <TableCell>
                    <Badge variant={getStatusColor(transfer.status)}>
                      {transfer.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{new Date(transfer.created_at).toLocaleDateString()}</TableCell>
                  <TableCell className="text-right">
                    {canManageTransfers && transfer.status === 'pending' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => completeTransfer(transfer)}
                      >
                        <CheckCircle className="h-4 w-4 mr-1" />
                        Complete
                      </Button>
                    )}
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
