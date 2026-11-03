import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { useAuth } from "@/hooks/useAuthContext";
import {
  centsToKesString,
  formatKesCents,
  parseKesToCents,
} from "@/lib/exactMoney";

interface Vendor {
  id: string;
  name: string;
}

interface Product {
  id: string;
  name: string;
  unit_cost: number;
}

interface Warehouse {
  id: string;
  name: string;
  is_main: boolean;
}

interface POItem {
  product_id: string;
  quantity: number;
  unit_cost: string;
}

export default function NewPurchaseOrder() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [warehouseId, setWarehouseId] = useState("");
  const [items, setItems] = useState<POItem[]>([
    { product_id: "", quantity: 1, unit_cost: "0.00" },
  ]);

  useEffect(() => {
    loadVendors();
    loadProducts();
    loadWarehouses();
  }, []);

  const loadVendors = async () => {
    try {
      const data = await ApiService.get<Vendor[]>("/vendors");
      setVendors(data || []);
    } catch (e) {
      toast.error("Failed to load vendors: " + e.message);
    }
  };

  const loadProducts = async () => {
    try {
      const data = await ApiService.get<Product[]>("/products");
      setProducts(data || []);
    } catch (e) {
      toast.error("Failed to load products: " + e.message);
    }
  };

  const loadWarehouses = async () => {
    try {
      const data = await ApiService.get<Warehouse[]>("/warehouses");
      const activeWarehouses = data || [];
      setWarehouses(activeWarehouses);
      const mainWarehouse = activeWarehouses.find(
        (warehouse) => warehouse.is_main,
      );
      if (mainWarehouse) setWarehouseId(mainWarehouse.id);
    } catch (e) {
      toast.error("Failed to load warehouses: " + e.message);
    }
  };

  const addItem = () => {
    setItems([...items, { product_id: "", quantity: 1, unit_cost: "0.00" }]);
  };

  const removeItem = (index: number) => {
    setItems(items.filter((_, i) => i !== index));
  };

  const updateItem = (index: number, field: keyof POItem, value: string | number) => {
    const newItems = [...items];
    newItems[index] = {
      ...newItems[index],
      [field]: field === "unit_cost" ? String(value) : value,
    };

    if (field === "product_id") {
      const product = products.find((p) => p.id === value);
      if (product) {
        newItems[index].unit_cost = String(product.unit_cost);
      }
    }

    setItems(newItems);
  };

  const calculateLineCents = (item: POItem): bigint | null => {
    if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) return null;
    try {
      return BigInt(item.quantity) * BigInt(parseKesToCents(item.unit_cost));
    } catch {
      return null;
    }
  };

  const calculateTotalCents = (): bigint | null => {
    const lineValues = items.map(calculateLineCents);
    if (lineValues.some((value) => value === null)) return null;
    return lineValues.reduce((sum, value) => sum + (value ?? 0n), 0n);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!vendorId || !warehouseId) {
      toast.error("Please select a vendor and receiving warehouse");
      return;
    }

    if (items.some((item) => !item.product_id || calculateLineCents(item) === null)) {
      toast.error("Please fill all item details with valid quantities and cent-precision unit costs");
      return;
    }

    setLoading(true);

    try {
      const safeItems = items.map((item) => ({
        ...item,
        unit_cost: centsToKesString(parseKesToCents(item.unit_cost)),
      }));

      await ApiService.post("/purchase-orders", {
        vendor_id: vendorId,
        warehouse_id: warehouseId,
        items: safeItems,
        created_by: user?.id,
      });

      toast.success("Purchase order created successfully");
      navigate("/purchase-orders");
    } catch (error) {
      toast.error(error.message || "Error creating purchase order");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" onClick={() => navigate("/purchase-orders")}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div>
          <h1 className="text-3xl font-bold">New Purchase Order</h1>
          <p className="text-muted-foreground">Create a new purchase order</p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <Card className="max-w-4xl">
          <CardHeader>
            <CardTitle>Order Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="vendor">Vendor *</Label>
              <Select value={vendorId} onValueChange={setVendorId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select vendor" />
                </SelectTrigger>
                <SelectContent>
                  {vendors.map((vendor) => (
                    <SelectItem key={vendor.id} value={vendor.id}>
                      {vendor.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="warehouse">Receiving Warehouse *</Label>
              <Select value={warehouseId} onValueChange={setWarehouseId}>
                <SelectTrigger id="warehouse">
                  <SelectValue placeholder="Select receiving warehouse" />
                </SelectTrigger>
                <SelectContent>
                  {warehouses.map((warehouse) => (
                    <SelectItem key={warehouse.id} value={warehouse.id}>
                      {warehouse.name}
                      {warehouse.is_main ? " (Main)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card className="max-w-4xl">
          <CardHeader>
            <div className="flex justify-between items-center">
              <CardTitle>Items</CardTitle>
              <Button type="button" onClick={addItem} size="sm">
                <Plus className="h-4 w-4 mr-2" />
                Add Item
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {items.map((item, index) => (
              <div key={index} className="flex gap-4 items-end">
                <div className="flex-1 space-y-2">
                  <Label htmlFor={`po-product-${index}`}>Product</Label>
                  <Select
                    value={item.product_id}
                    onValueChange={(value) =>
                      updateItem(index, "product_id", value)
                    }
                  >
                    <SelectTrigger id={`po-product-${index}`}>
                      <SelectValue placeholder="Select product" />
                    </SelectTrigger>
                    <SelectContent>
                      {products.map((product) => (
                        <SelectItem key={product.id} value={product.id}>
                          {product.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="w-32 space-y-2">
                  <Label htmlFor={`po-quantity-${index}`}>Quantity</Label>
                  <Input
                    id={`po-quantity-${index}`}
                    type="number"
                    min="1"
                    value={item.quantity}
                    onChange={(e) =>
                      updateItem(index, "quantity", parseInt(e.target.value))
                    }
                  />
                </div>
                <div className="w-40 space-y-2">
                  <Label htmlFor={`po-unit-cost-${index}`}>
                    Unit Cost (KSh)
                  </Label>
                  <Input
                    id={`po-unit-cost-${index}`}
                    type="text"
                    inputMode="decimal"
                    value={item.unit_cost}
                    onChange={(e) =>
                      updateItem(index, "unit_cost", e.target.value)
                    }
                  />
                </div>
                <div className="w-40 space-y-2">
                  <Label htmlFor={`po-line-total-${index}`}>Total</Label>
                  <Input
                    id={`po-line-total-${index}`}
                    value={
                      calculateLineCents(item) === null
                        ? "Invalid amount"
                        : formatKesCents(calculateLineCents(item) ?? 0n)
                    }
                    disabled
                  />
                </div>
                {items.length > 1 && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="icon"
                    onClick={() => removeItem(index)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}

            <div className="flex justify-end pt-4 border-t">
              <div className="text-right">
                <div className="text-sm text-muted-foreground">
                  Total Amount
                </div>
                <div className="text-2xl font-bold">
                  {calculateTotalCents() === null
                    ? "Invalid amount"
                    : formatKesCents(calculateTotalCents() ?? 0n)}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex gap-2 max-w-4xl">
          <Button type="submit" disabled={loading}>
            {loading ? "Creating..." : "Create Purchase Order"}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => navigate("/purchase-orders")}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
