import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiService, API_BASE_URL } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Search,
  AlertCircle,
  Download,
  Upload,
  Loader2,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuthContext";
import { useToast } from "@/hooks/use-toast";
import { formatKesCents, parseKesToCents } from "@/lib/exactMoney";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type EtimsMappingForm = {
  etims_item_code: string;
  etims_item_class_code: string;
  etims_product_type_code: string;
  etims_origin_country_code: string;
  etims_packaging_unit_code: string;
  etims_quantity_unit_code: string;
  etims_tax_type_code: string;
};

interface Warehouse {
  id: string;
  name: string;
}

interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  unit_cost: number | string;
  retail_price: number | string;
  stock_on_hand: number;
  reorder_level: number;
  is_parent?: boolean;
  variant_attributes?: Record<string, string>;
  etims_item_code: string | null;
  etims_item_class_code: string | null;
  etims_product_type_code: string | null;
  etims_origin_country_code: string | null;
  etims_packaging_unit_code: string | null;
  etims_quantity_unit_code: string | null;
  etims_tax_type_code: string | null;
}

interface ProductImportResponse {
  message?: string;
  created: number;
  skipped: number;
  summary: string;
  errors: string[];
}

export default function Products() {
  const navigate = useNavigate();
  const { userRole } = useAuth();
  const canManageCatalog = userRole === "admin" || userRole === "manager";
  const { toast } = useToast();
  const [products, setProducts] = useState<Product[]>([]);
  const [filteredProducts, setFilteredProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [selectedWarehouse, setSelectedWarehouse] = useState("all");
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importSummary, setImportSummary] = useState("");
  const [mappingProduct, setMappingProduct] = useState<Product | null>(null);
  const [etimsMappingForm, setEtimsMappingForm] = useState<EtimsMappingForm>({
    etims_item_code: "",
    etims_item_class_code: "",
    etims_product_type_code: "",
    etims_origin_country_code: "",
    etims_packaging_unit_code: "",
    etims_quantity_unit_code: "",
    etims_tax_type_code: "",
  });
  const [savingEtimsMapping, setSavingEtimsMapping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadWarehouses = useCallback(async () => {
    try {
      const data = await ApiService.get<Warehouse[]>("/warehouses");
      setWarehouses(data || []);
    } catch (error) {
      toast({
        title: "Warehouse list unavailable",
        description:
          error instanceof Error ? error.message : "Unable to load warehouses.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const loadProducts = useCallback(async (warehouseId: string) => {
    setLoading(true);
    try {
      const endpoint = warehouseId === "all"
        ? "/products"
        : `/products?warehouse_id=${encodeURIComponent(warehouseId)}`;
      const data = await ApiService.get<Product[]>(endpoint);

      const catalogProducts = (data || [])
        .filter((product) => !product.is_parent)
        .map((product) => ({
          ...product,
          stock_on_hand: Number(product.stock_on_hand),
          reorder_level: Number(product.reorder_level),
        }));
      const sortedData = catalogProducts.sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      setProducts(sortedData);
      setFilteredProducts(sortedData);
    } catch (error) {
      toast({
        title: "Products unavailable",
        description:
          error instanceof Error ? error.message : "Unable to load products.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadWarehouses();
  }, [loadWarehouses]);

  useEffect(() => {
    void loadProducts(selectedWarehouse);
  }, [loadProducts, selectedWarehouse]);

  useEffect(() => {
    if (searchTerm) {
      const filtered = products.filter(
        (p) =>
          p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          p.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
          p.barcode?.toLowerCase().includes(searchTerm.toLowerCase()),
      );
      setFilteredProducts(filtered);
    } else {
      setFilteredProducts(products);
    }
  }, [searchTerm, products]);

  const downloadImportTemplate = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/products/template`, {
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error("Unable to download the product import template.");
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "product_import_template.csv";
      anchor.click();
      window.URL.revokeObjectURL(url);
      toast({
        title: "Template downloaded",
        description:
          "Use the CSV template to add multiple products and re-upload it.",
      });
    } catch (error) {
      toast({
        title: "Download failed",
        description:
          error instanceof Error
            ? error.message
            : "Unable to download the product template.",
        variant: "destructive",
      });
    }
  };

  const handleImportProducts = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    setIsImporting(true);
    setImportSummary("");
    setImportErrors([]);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const response = await fetch(`${API_BASE_URL}/products/import`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });

      const payload = await response.json().catch(() => ({})) as Partial<ProductImportResponse>;

      if (!response.ok) {
        throw new Error(payload.message || "Unable to import products.");
      }

      if (
        !Number.isInteger(payload.created) ||
        !Number.isInteger(payload.skipped) ||
        typeof payload.summary !== "string"
      ) {
        throw new Error("The server returned an incomplete product import result. Refresh the product list before retrying.");
      }

      const errors = Array.isArray(payload.errors) ? payload.errors : [];
      const importDescription = errors.length > 0
        ? `${payload.summary} ${errors.slice(0, 2).join(" ")}${errors.length > 2 ? ` And ${errors.length - 2} more row error(s); see the import details below.` : ""}`
        : payload.summary;

      toast({
        title: payload.created === 0 && payload.skipped > 0
          ? "Product import needs attention"
          : payload.skipped > 0
            ? "Products imported with skipped rows"
            : "Products imported",
        description: importDescription,
        variant: payload.created === 0 && payload.skipped > 0 ? "destructive" : "default",
      });
      setImportSummary(payload.summary);
      setImportErrors(errors);

      await loadProducts(selectedWarehouse);
    } catch (error) {
      setImportSummary("");
      setImportErrors([]);
      toast({
        title: "Import failed",
        description:
          error instanceof Error
            ? error.message
            : "Please check the file format and try again.",
        variant: "destructive",
      });
    } finally {
      setIsImporting(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const openEtimsMappingEditor = (product: Product) => {
    setMappingProduct(product);
    setEtimsMappingForm({
      etims_item_code: product.etims_item_code || "",
      etims_item_class_code: product.etims_item_class_code || "",
      etims_product_type_code: product.etims_product_type_code || "",
      etims_origin_country_code: product.etims_origin_country_code || "",
      etims_packaging_unit_code: product.etims_packaging_unit_code || "",
      etims_quantity_unit_code: product.etims_quantity_unit_code || "",
      etims_tax_type_code: product.etims_tax_type_code || "",
    });
  };

  const saveEtimsMapping = async () => {
    if (!mappingProduct || savingEtimsMapping) return;
    setSavingEtimsMapping(true);
    try {
      await ApiService.put<Product>(`/products/${mappingProduct.id}`, etimsMappingForm);
      toast({ title: "KRA item mapping saved" });
      setMappingProduct(null);
      await loadProducts(selectedWarehouse);
    } catch (error) {
      toast({
        title: "Unable to save KRA item mapping",
        description: error instanceof Error ? error.message : "Please verify the mapped values and try again.",
        variant: "destructive",
      });
    } finally {
      setSavingEtimsMapping(false);
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
    <div className="p-2 sm:p-4 md:p-6 space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Products</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Manage your product catalog
          </p>
        </div>
        {canManageCatalog && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={downloadImportTemplate}>
              <Download className="h-4 w-4 mr-2" />
              Download Template
            </Button>
            <Button
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={isImporting}
            >
              {isImporting ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Upload className="h-4 w-4 mr-2" />
              )}
              {isImporting ? "Importing..." : "Bulk Import"}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx"
              className="hidden"
              onChange={handleImportProducts}
            />
            <Button onClick={() => navigate("/products/new")}>
              <Plus className="h-4 w-4 mr-2" />
              Add Product
            </Button>
          </div>
        )}
      </div>

      {importSummary && (
        <Card>
          <CardContent className="space-y-2 pt-4">
            <p className="font-medium">{importSummary}</p>
            {importErrors.length > 0 && (
              <ul
                className="max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-sm text-destructive"
                aria-label="Rows skipped during product import"
              >
                {importErrors.map((message, index) => (
                  <li key={`${index}-${message}`}>{message}</li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-lg sm:text-xl">Product Catalog</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">
                {selectedWarehouse === "all"
                  ? "Stock shows the combined balance across all warehouses."
                  : "Stock shows the selected warehouse balance, including products with no stock."}
              </p>
            </div>
            <Select value={selectedWarehouse} onValueChange={setSelectedWarehouse}>
              <SelectTrigger className="w-full sm:w-[240px]" aria-label="Filter products by warehouse">
                <SelectValue placeholder="Select warehouse" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Warehouses</SelectItem>
                {warehouses.map((warehouse) => (
                  <SelectItem key={warehouse.id} value={warehouse.id}>
                    {warehouse.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, SKU, or barcode..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10 text-sm sm:text-base"
            />
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs sm:text-sm">SKU</TableHead>
                <TableHead className="hidden md:table-cell text-xs sm:text-sm">
                  Barcode
                </TableHead>
                <TableHead className="text-xs sm:text-sm">Name</TableHead>
                <TableHead className="text-right text-xs sm:text-sm">
                  Cost
                </TableHead>
                <TableHead className="text-right text-xs sm:text-sm">
                  Price
                </TableHead>
                <TableHead className="text-right text-xs sm:text-sm">
                  Stock
                </TableHead>
                <TableHead className="text-xs sm:text-sm">Status</TableHead>
                {canManageCatalog && <TableHead className="text-xs sm:text-sm">KRA eTIMS</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredProducts.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={canManageCatalog ? 8 : 7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    {selectedWarehouse === "all"
                      ? "No products match your search."
                      : "No products match your search in this warehouse."}
                  </TableCell>
                </TableRow>
              )}
              {filteredProducts.map((product) => {
                const isLowStock =
                  product.stock_on_hand <= product.reorder_level;
                return (
                  <TableRow key={product.id}>
                    <TableCell className="font-medium text-xs sm:text-sm">
                      {product.sku}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs sm:text-sm">
                      {product.barcode || "-"}
                    </TableCell>
                    <TableCell className="text-xs sm:text-sm">
                      {product.name}
                      {product.variant_attributes && (
                        <span className="ml-2 text-muted-foreground text-xs">
                          (
                          {Object.entries(product.variant_attributes)
                            .map(([k, v]) => `${v}`)
                            .join(" / ")}
                          )
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs sm:text-sm">
                      {formatKesCents(
                        parseKesToCents(String(product.unit_cost)),
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs sm:text-sm">
                      {formatKesCents(
                        parseKesToCents(String(product.retail_price)),
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs sm:text-sm">
                      {product.stock_on_hand}
                    </TableCell>
                    <TableCell>
                      {isLowStock ? (
                        <Badge variant="destructive" className="gap-1">
                          <AlertCircle className="h-3 w-3" />
                          Low Stock
                        </Badge>
                      ) : (
                        <Badge variant="default" className="bg-accent">
                          In Stock
                        </Badge>
                      )}
                    </TableCell>
                    {canManageCatalog && (
                      <TableCell>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => openEtimsMappingEditor(product)}
                        >
                          {product.etims_item_code ? "Edit mapping" : "Set mapping"}
                        </Button>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <Dialog
        open={!!mappingProduct}
        onOpenChange={(open) => {
          if (!open && !savingEtimsMapping) setMappingProduct(null);
        }}
      >
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>KRA eTIMS Mapping — {mappingProduct?.name}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Enter the codes confirmed for this item in KRA/VSCU. Values are not
            inferred from POS tax rates or product units.
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="edit_etims_item_code" className="text-sm font-medium">KRA Item Code</label>
              <Input
                id="edit_etims_item_code"
                maxLength={20}
                value={etimsMappingForm.etims_item_code}
                onChange={(event) => setEtimsMappingForm({ ...etimsMappingForm, etims_item_code: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit_etims_item_class_code" className="text-sm font-medium">KRA Item Classification Code</label>
              <Input
                id="edit_etims_item_class_code"
                maxLength={10}
                value={etimsMappingForm.etims_item_class_code}
                onChange={(event) => setEtimsMappingForm({ ...etimsMappingForm, etims_item_class_code: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit_etims_product_type_code" className="text-sm font-medium">KRA Product Type</label>
              <Select
                value={etimsMappingForm.etims_product_type_code || "none"}
                onValueChange={(value) => setEtimsMappingForm({
                  ...etimsMappingForm,
                  etims_product_type_code: value === "none" ? "" : value,
                })}
              >
                <SelectTrigger id="edit_etims_product_type_code"><SelectValue placeholder="Select type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not mapped</SelectItem>
                  <SelectItem value="1">1 - Raw material</SelectItem>
                  <SelectItem value="2">2 - Finished product</SelectItem>
                  <SelectItem value="3">3 - Service</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label htmlFor="edit_etims_origin_country_code" className="text-sm font-medium">Country of Origin Code</label>
              <Input
                id="edit_etims_origin_country_code"
                maxLength={5}
                value={etimsMappingForm.etims_origin_country_code}
                onChange={(event) => setEtimsMappingForm({ ...etimsMappingForm, etims_origin_country_code: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit_etims_packaging_unit_code" className="text-sm font-medium">Packaging Unit Code</label>
              <Input
                id="edit_etims_packaging_unit_code"
                maxLength={5}
                value={etimsMappingForm.etims_packaging_unit_code}
                onChange={(event) => setEtimsMappingForm({ ...etimsMappingForm, etims_packaging_unit_code: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit_etims_quantity_unit_code" className="text-sm font-medium">Unit of Quantity Code</label>
              <Input
                id="edit_etims_quantity_unit_code"
                maxLength={5}
                value={etimsMappingForm.etims_quantity_unit_code}
                onChange={(event) => setEtimsMappingForm({ ...etimsMappingForm, etims_quantity_unit_code: event.target.value })}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="edit_etims_tax_type_code" className="text-sm font-medium">KRA Tax Type</label>
              <Select
                value={etimsMappingForm.etims_tax_type_code || "none"}
                onValueChange={(value) => setEtimsMappingForm({
                  ...etimsMappingForm,
                  etims_tax_type_code: value === "none" ? "" : value,
                })}
              >
                <SelectTrigger id="edit_etims_tax_type_code"><SelectValue placeholder="Select tax type" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not mapped</SelectItem>
                  <SelectItem value="A">A - Exempt</SelectItem>
                  <SelectItem value="B">B - 16%</SelectItem>
                  <SelectItem value="C">C - Zero-rated</SelectItem>
                  <SelectItem value="D">D - Non-VAT</SelectItem>
                  <SelectItem value="E">E - 8%</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={savingEtimsMapping}
              onClick={() => setMappingProduct(null)}
            >
              Cancel
            </Button>
            <Button type="button" disabled={savingEtimsMapping} onClick={() => void saveEtimsMapping()}>
              {savingEtimsMapping ? "Saving..." : "Save mapping"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
