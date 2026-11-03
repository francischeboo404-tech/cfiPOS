import { useCallback, useState, useEffect, useRef } from "react";
import { ApiRequestError, ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuthContext";
import {
  Scan,
  Plus,
  Minus,
  Trash2,
  ShoppingCart,
  Check,
  Loader2,
} from "lucide-react";
import { BarcodeScanner } from "@/components/BarcodeScanner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  centsToKesString,
  formatKesCents,
  parseKesToCents,
} from "@/lib/exactMoney";

interface Product {
  id: string;
  name: string;
  retail_price: number | string;
  tax_rate?: number;
  tax_class?: { rate: number } | null;
  stock_on_hand: number;
  barcode: string | null;
}

interface CartItem {
  product: Product;
  quantity: number;
}

interface Warehouse {
  id: string;
  name: string;
  is_main?: boolean;
}

interface PricingPreview {
  cartSignature: string;
  checkoutSessionId: string;
  totalCents: string | null;
}

export default function MobileCashier() {
  const { user } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [showScanner, setShowScanner] = useState(false);
  const [activeShift, setActiveShift] = useState<string | null>(null);
  const [selectedWarehouse, setSelectedWarehouse] = useState("");
  const [warehousesLoading, setWarehousesLoading] = useState(true);
  const [productsLoading, setProductsLoading] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);
  const checkoutInProgress = useRef(false);
  const pricingPreviewRef = useRef<PricingPreview | null>(null);
  const [pricingPreview, setPricingPreview] = useState<PricingPreview | null>(null);
  const productLoadSequence = useRef(0);
  const checkoutKey = useRef<{ cartSignature: string; key: string } | null>(
    null,
  );

  const checkActiveShift = useCallback(async () => {
    if (!user) return;
    try {
      const shift = await ApiService.get<{ id: string } | null>(
        "/shifts/current",
      );
      setActiveShift(shift?.id || null);
    } catch (error) {
      setActiveShift(null);
    }
  }, [user]);

  const loadWarehouses = useCallback(async () => {
    try {
      const response = await ApiService.get<Warehouse[]>("/warehouses");
      const activeWarehouses = Array.isArray(response)
        ? response.filter((warehouse) => warehouse.id && warehouse.name)
        : [];
      setWarehouses(activeWarehouses);

      let savedWarehouseId = "";
      if (user?.id) {
        try {
          const saved = localStorage.getItem(`pos:last-warehouse:${user.id}`);
          savedWarehouseId = saved
            ? (JSON.parse(saved) as { id?: string }).id || ""
            : "";
        } catch (error) {
          console.error("Unable to restore the saved POS location:", error);
        }
      }
      const preferredWarehouse = activeWarehouses.find(
        (warehouse) => warehouse.id === savedWarehouseId,
      );
      const defaultWarehouse =
        activeWarehouses.find((warehouse) => warehouse.is_main) ??
        activeWarehouses[0];
      setSelectedWarehouse(
        preferredWarehouse?.id ?? defaultWarehouse?.id ?? "",
      );
    } catch (error) {
      setWarehouses([]);
      setSelectedWarehouse("");
      toast.error(
        error instanceof Error
          ? `Unable to load warehouses: ${error.message}`
          : "Unable to load warehouses",
      );
    } finally {
      setWarehousesLoading(false);
    }
  }, [user?.id]);

  const loadProducts = useCallback(async (warehouseId: string) => {
    const loadSequence = ++productLoadSequence.current;
    if (!warehouseId) {
      setProducts([]);
      setProductsLoading(false);
      return;
    }

    setProductsLoading(true);
    try {
      const response = await ApiService.get<Product[]>(
        `/products?warehouse_id=${encodeURIComponent(warehouseId)}`,
      );
      if (loadSequence !== productLoadSequence.current) return;
      setProducts(
        (response || []).filter((product) => Number(product.stock_on_hand) > 0),
      );
    } catch (error) {
      if (loadSequence !== productLoadSequence.current) return;
      setProducts([]);
      toast.error(
        error instanceof Error
          ? `Unable to load products: ${error.message}`
          : "Unable to load products",
      );
    } finally {
      if (loadSequence === productLoadSequence.current) {
        setProductsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadWarehouses();
    void checkActiveShift();
  }, [checkActiveShift, loadWarehouses]);

  useEffect(() => {
    void loadProducts(selectedWarehouse);
  }, [loadProducts, selectedWarehouse]);

  useEffect(() => {
    if (!user?.id || !selectedWarehouse) return;
    const warehouse = warehouses.find(
      (entry) => entry.id === selectedWarehouse,
    );
    if (!warehouse) return;
    try {
      localStorage.setItem(
        `pos:last-warehouse:${user.id}`,
        JSON.stringify(warehouse),
      );
    } catch (error) {
      console.error("Unable to save the selected POS location:", error);
    }
  }, [selectedWarehouse, user?.id, warehouses]);

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      p.barcode?.includes(searchTerm),
  );

  const getCartSignature = (
    items: CartItem[] = cart,
    warehouseId: string = selectedWarehouse,
  ) =>
    JSON.stringify({
      warehouse_id: warehouseId,
      items: items.map((item) => ({
        product_id: item.product.id,
        quantity: item.quantity,
      })),
    });

  const releasePricingPreview = () => {
    const preview = pricingPreviewRef.current;
    pricingPreviewRef.current = null;
    setPricingPreview(null);
    if (!preview?.checkoutSessionId) return;

    void ApiService.post(
      `/sales/checkouts/${encodeURIComponent(preview.checkoutSessionId)}/cancel`,
      {},
    ).catch((error) => {
      if (error instanceof ApiRequestError && error.status === 404) return;
      console.error("Unable to release the mobile checkout reservation:", error);
      toast.error(
        error instanceof Error
          ? `Unable to release the checkout reservation: ${error.message}`
          : "Unable to release the checkout reservation",
      );
    });
  };

  const handleBarcodeDetected = (barcode: string) => {
    const product = products.find((p) => p.barcode === barcode);
    if (product) {
      addToCart(product);
      setShowScanner(false);
      toast.success(`Added ${product.name} to cart`);
    } else {
      toast.error("Product not found");
    }
  };

  const addToCart = (product: Product) => {
    if (checkoutInProgress.current) return;
    const existingItem = cart.find((item) => item.product.id === product.id);
    if (existingItem) {
      if (existingItem.quantity >= product.stock_on_hand) {
        toast.error("Insufficient stock");
        return;
      }
      checkoutKey.current = null;
      releasePricingPreview();
      setCart(
        cart.map((item) =>
          item.product.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item,
        ),
      );
    } else {
      checkoutKey.current = null;
      releasePricingPreview();
      setCart([...cart, { product, quantity: 1 }]);
    }
  };

  const updateQuantity = (productId: string, change: number) => {
    if (checkoutInProgress.current) return;
    const currentItem = cart.find((item) => item.product.id === productId);
    if (!currentItem) return;
    const nextQuantity = currentItem.quantity + change;
    if (nextQuantity <= 0 || nextQuantity > currentItem.product.stock_on_hand) return;
    checkoutKey.current = null;
    releasePricingPreview();
    setCart(
      cart.map((item) => {
        if (item.product.id === productId) {
          const newQuantity = item.quantity + change;
          return { ...item, quantity: newQuantity };
        }
        return item;
      }),
    );
  };

  const removeFromCart = (productId: string) => {
    if (checkoutInProgress.current) return;
    if (!cart.some((item) => item.product.id === productId)) return;
    checkoutKey.current = null;
    releasePricingPreview();
    setCart(cart.filter((item) => item.product.id !== productId));
  };

  const handleWarehouseChange = (warehouseId: string) => {
    if (warehouseId === selectedWarehouse) return;
    if (cart.length > 0) {
      setCart([]);
      checkoutKey.current = null;
      releasePricingPreview();
      toast.info("Cart cleared because the sales branch changed.");
    }
    setSelectedWarehouse(warehouseId);
  };

  const getTotalCents = () => {
    return cart.reduce(
      (sum, item) =>
        sum +
        BigInt(parseKesToCents(String(item.product.retail_price))) *
          BigInt(item.quantity),
      0n,
    );
  };

  const handleCheckout = async () => {
    if (checkoutInProgress.current) return;
    if (cart.length === 0) {
      toast.error("Cart is empty");
      return;
    }

    if (!selectedWarehouse) {
      toast.error("Select an active branch before selling.");
      return;
    }

    if (!activeShift) {
      toast.error("No active shift. Please start a shift first.");
      return;
    }

    const saleItems = cart.map((item) => ({
      product_id: item.product.id,
      quantity: item.quantity,
    }));
    const cartSignature = getCartSignature(cart, selectedWarehouse);
    if (checkoutKey.current?.cartSignature !== cartSignature) {
      checkoutKey.current = { cartSignature, key: crypto.randomUUID() };
    }
    const idempotencyKey = checkoutKey.current.key;

    checkoutInProgress.current = true;
    setCheckingOut(true);
    try {
      let preview = pricingPreviewRef.current;
      if (!preview || preview.cartSignature !== cartSignature) {
        if (preview) releasePricingPreview();
        preview = {
          cartSignature,
          checkoutSessionId: crypto.randomUUID(),
          totalCents: null,
        };
        pricingPreviewRef.current = preview;
        setPricingPreview(preview);
      }

      if (preview.totalCents === null) {
        const reservedCheckout = await ApiService.post<{
          id: string;
          total_amount: number | string;
        }>("/sales/checkouts", {
          checkout_session_id: preview.checkoutSessionId,
          items: saleItems,
          warehouse_id: selectedWarehouse,
          cash_amount: 0,
          store_credit_amount: 0,
        });
        preview = {
          ...preview,
          totalCents: String(parseKesToCents(String(reservedCheckout.total_amount))),
        };
        pricingPreviewRef.current = preview;
        setPricingPreview(preview);
        toast.success("Exact total ready. Confirm the cash sale to continue.");
        return;
      }

      const totalCents = BigInt(preview.totalCents);
      const confirmedCheckout = await ApiService.post<{
        cash_amount: number | string;
      }>(
        `/sales/checkouts/${encodeURIComponent(preview.checkoutSessionId)}/confirm-cash`,
        {},
      );
      if (
        BigInt(parseKesToCents(String(confirmedCheckout.cash_amount))) !==
        totalCents
      ) {
        throw new Error("The confirmed cash amount did not match the server total.");
      }

      await ApiService.post("/sales", {
        items: saleItems,
        warehouse_id: selectedWarehouse,
        payment_method: "cash",
        cash_amount: centsToKesString(totalCents),
        checkout_session_id: preview.checkoutSessionId,
        idempotency_key: idempotencyKey,
      });

      toast.success("Sale completed!");
      checkoutKey.current = null;
      pricingPreviewRef.current = null;
      setPricingPreview(null);
      setCart([]);
      loadProducts(selectedWarehouse);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Unable to complete the sale",
      );
    } finally {
      checkoutInProgress.current = false;
      setCheckingOut(false);
    }
  };

  const activePricingPreview =
    pricingPreview?.cartSignature === getCartSignature() ? pricingPreview : null;
  const displayedTotalCents =
    activePricingPreview?.totalCents !== null &&
    activePricingPreview?.totalCents !== undefined
      ? BigInt(activePricingPreview.totalCents)
      : getTotalCents();

  return (
    <div className="min-h-screen bg-background p-4 pb-24">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Quick Sale</h1>
        <p className="text-muted-foreground">Tap products to add to cart</p>
      </div>

      <div className="mb-6 space-y-2">
        <label className="text-sm font-medium" htmlFor="mobile-cashier-warehouse">
          Sales branch
        </label>
        <Select
          value={selectedWarehouse}
          onValueChange={handleWarehouseChange}
          disabled={warehousesLoading || warehouses.length === 0 || checkingOut}
        >
          <SelectTrigger
            id="mobile-cashier-warehouse"
            className="h-12 text-base"
          >
            <SelectValue
              placeholder={
                warehousesLoading ? "Loading branches..." : "Select branch"
              }
            />
          </SelectTrigger>
          <SelectContent>
            {warehouses.map((warehouse) => (
              <SelectItem key={warehouse.id} value={warehouse.id}>
                {warehouse.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {!warehousesLoading && warehouses.length === 0 && (
          <p className="text-sm text-destructive">
            No active branch is available. Contact an administrator before
            making a sale.
          </p>
        )}
      </div>

      {/* Search and Scanner */}
      <div className="mb-6 space-y-3">
        <Input
          placeholder="Search products..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="h-14 text-lg"
        />
        <Button
          onClick={() => setShowScanner(!showScanner)}
          variant="outline"
          className="w-full h-14 text-lg"
        >
          <Scan className="h-6 w-6 mr-2" />
          {showScanner ? "Close Scanner" : "Scan Barcode"}
        </Button>
      </div>

      {showScanner && (
        <div className="mb-6">
          <BarcodeScanner onScan={handleBarcodeDetected} />
        </div>
      )}

      {/* Product Grid */}
      {productsLoading && (
        <p className="mb-4 text-sm text-muted-foreground">
          Loading branch stock...
        </p>
      )}
      <div className="grid grid-cols-2 gap-4 mb-6">
        {filteredProducts.slice(0, 20).map((product) => (
          <Card
            key={product.id}
            className="cursor-pointer active:scale-95 transition-transform"
            onClick={() => addToCart(product)}
          >
            <CardContent className="p-4">
              <h3 className="font-semibold text-lg mb-2 line-clamp-2">
                {product.name}
              </h3>
              <div className="space-y-2">
                <p className="text-2xl font-bold text-primary">
                  {formatKesCents(parseKesToCents(String(product.retail_price)))}
                </p>
                <Badge
                  variant={
                    product.stock_on_hand > 10 ? "default" : "destructive"
                  }
                >
                  Stock: {product.stock_on_hand}
                </Badge>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Floating Cart */}
      {cart.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-background border-t shadow-lg">
          <div className="p-4 space-y-3 max-h-[50vh] overflow-y-auto">
            {cart.map((item) => (
              <div
                key={item.product.id}
                className="flex items-center gap-3 bg-muted/50 p-3 rounded-lg"
              >
                <div className="flex-1">
                  <p className="font-semibold">{item.product.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {formatKesCents(parseKesToCents(String(item.product.retail_price)))} ×{" "}
                    {item.quantity}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => updateQuantity(item.product.id, -1)}
                    aria-label={`Decrease ${item.product.name} quantity`}
                    className="h-10 w-10"
                  >
                    <Minus className="h-5 w-5" />
                  </Button>
                  <span className="text-xl font-bold w-12 text-center">
                    {item.quantity}
                  </span>
                  <Button
                    size="icon"
                    variant="outline"
                    onClick={() => updateQuantity(item.product.id, 1)}
                    aria-label={`Increase ${item.product.name} quantity`}
                    className="h-10 w-10"
                  >
                    <Plus className="h-5 w-5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="destructive"
                    onClick={() => removeFromCart(item.product.id)}
                    aria-label={`Remove ${item.product.name} from cart`}
                    className="h-10 w-10"
                  >
                    <Trash2 className="h-5 w-5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>

          <div className="p-4 bg-primary text-primary-foreground">
            <div className="flex justify-between items-center mb-3">
              <span className="text-lg">
                {activePricingPreview?.totalCents === null ||
                !activePricingPreview
                  ? "Estimated total:"
                  : "Total:"}
              </span>
              <span className="text-3xl font-bold">
                {formatKesCents(displayedTotalCents)}
              </span>
            </div>
            <Button
              onClick={handleCheckout}
              disabled={checkingOut || !selectedWarehouse}
              className="w-full h-14 text-lg bg-background text-foreground hover:bg-background/90"
            >
              {checkingOut ? (
                <Loader2 className="h-6 w-6 mr-2 animate-spin" />
              ) : (
                <Check className="h-6 w-6 mr-2" />
              )}
              {checkingOut
                ? "Processing sale..."
                : activePricingPreview?.totalCents !== null &&
                    activePricingPreview
                  ? `Confirm Cash Sale (${cart.length} items)`
                  : `Review Exact Total (${cart.length} items)`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
