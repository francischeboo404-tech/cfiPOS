import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { BarcodeGenerator } from "@/components/BarcodeGenerator";
import { toast } from "sonner";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { centsToKesString, parseKesToCents } from "@/lib/exactMoney";

interface TaxClass {
  id: string;
  name: string;
  rate: number;
  is_default: boolean;
}

interface ProductCategory {
  id: string;
  name: string;
}

interface Warehouse {
  id: string;
  name: string;
  is_main: boolean;
}

interface VariantOption {
  name: string;
  values: string; // comma separated
}

interface CreatedProduct {
  id: string;
  sku: string;
  barcode?: string | null;
  name: string;
  retail_price: number;
}

type CreateProductResponse =
  | CreatedProduct
  | { parent: CreatedProduct; variants: CreatedProduct[] };

export default function NewProduct() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [showBarcode, setShowBarcode] = useState(false);
  const [createdProduct, setCreatedProduct] = useState<CreatedProduct | null>(
    null,
  );

  const [taxClasses, setTaxClasses] = useState<TaxClass[]>([]);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [productUnits, setProductUnits] = useState<string[]>(["piece"]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [warehouseId, setWarehouseId] = useState("");
  const [hasVariants, setHasVariants] = useState(false);
  const [options, setOptions] = useState<VariantOption[]>([
    { name: "", values: "" },
  ]);
  const [generatedVariants, setGeneratedVariants] = useState<Array<{
    sku: string;
    barcode: string;
    variant_attributes: Record<string, string>;
    retail_price: string;
    unit_cost: string;
    stock_on_hand: string;
    etims_item_code: string;
  }>>([]);

  const [formData, setFormData] = useState({
    sku: "",
    barcode: "",
    name: "",
    unit_cost: "",
    retail_price: "",
    stock_on_hand: "0",
    reorder_level: "10",
    tax_class_id: "",
    category_id: "",
    unit_of_measure: "piece",
    location: "main",
    etims_item_code: "",
    etims_item_class_code: "",
    etims_product_type_code: "",
    etims_origin_country_code: "",
    etims_packaging_unit_code: "",
    etims_quantity_unit_code: "",
    etims_tax_type_code: "",
  });

  const getPriceCents = (value: string): number | null => {
    try {
      const cents = parseKesToCents(value);
      return cents <= 9_999_999_999 ? cents : null;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    void loadTaxClasses();
    void loadWarehouses();
    void loadCategories();
    void loadProductUnits();
  }, []);

  const loadTaxClasses = async () => {
    try {
      const data = await ApiService.get<TaxClass[]>("/taxes");
      setTaxClasses(data || []);
      const defaultTax = data?.find((t) => t.is_default);
      if (defaultTax) {
        setFormData((prev) => ({ ...prev, tax_class_id: defaultTax.id }));
      } else if (data && data.length > 0) {
        setFormData((prev) => ({ ...prev, tax_class_id: data[0].id }));
      }
    } catch (error) {
      console.error("Error loading taxes:", error);
    }
  };

  const loadWarehouses = async () => {
    try {
      const data = await ApiService.get<Warehouse[]>("/warehouses");
      const activeWarehouses = data || [];
      setWarehouses(activeWarehouses);
      const defaultWarehouse =
        activeWarehouses.find((warehouse) => warehouse.is_main) ||
        activeWarehouses[0];
      if (defaultWarehouse) setWarehouseId(defaultWarehouse.id);
    } catch (error) {
      toast.error(error.message || "Failed to load warehouses");
    }
  };

  const loadCategories = async () => {
    try {
      const data = await ApiService.get<ProductCategory[]>("/categories");
      setCategories(data || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load product categories");
    }
  };

  const loadProductUnits = async () => {
    try {
      const settings = await ApiService.get<Record<string, string>>("/settings");
      const configuredUnits = settings.product_unit_of_measures
        ? JSON.parse(settings.product_unit_of_measures) as unknown
        : ["piece"];
      if (
        !Array.isArray(configuredUnits) ||
        configuredUnits.length === 0 ||
        configuredUnits.some((unit) => typeof unit !== "string" || !unit.trim())
      ) {
        throw new Error("Product units are not configured correctly in Settings.");
      }
      const units = configuredUnits.map((unit) => (unit as string).trim());
      setProductUnits(units);
      setFormData((previous) => ({
        ...previous,
        unit_of_measure: units.includes(previous.unit_of_measure)
          ? previous.unit_of_measure
          : units[0],
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load product units");
    }
  };

  // Generate permutations when options change
  useEffect(() => {
    if (!hasVariants) return;

    // Filter out incomplete options
    const validOptions = options.filter(
      (o) => o.name.trim() && o.values.trim(),
    );
    if (validOptions.length === 0) {
      setGeneratedVariants([]);
      return;
    }

    const arraysToCombine = validOptions.map((opt) =>
      opt.values
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v)
        .map((v) => ({ [opt.name.trim()]: v })),
    );

    // Cartesian product
    const combinations = arraysToCombine.reduce((a, b) =>
      a.flatMap((d) => b.map((e) => ({ ...d, ...e }))),
    );

    const variants = combinations.map((attrs) => {
      const attrValuesString = Object.values(attrs).join("-");
      return {
        variant_attributes: attrs,
        sku: formData.sku
          ? `${formData.sku}-${attrValuesString.toUpperCase()}`
          : "",
        barcode: "",
        retail_price: formData.retail_price,
        unit_cost: formData.unit_cost,
        stock_on_hand: "0",
        etims_item_code: "",
      };
    });

    setGeneratedVariants(variants);
  }, [
    options,
    formData.sku,
    formData.retail_price,
    formData.unit_cost,
    hasVariants,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const openingQuantities =
      hasVariants && generatedVariants.length > 0
        ? generatedVariants.map((variant) =>
            Number(variant.stock_on_hand),
          )
        : [Number(formData.stock_on_hand)];
    if (hasVariants && generatedVariants.length === 0) {
      toast.error("Add at least one complete variant option before saving this product.");
      return;
    }
    if (openingQuantities.some((quantity) => !Number.isSafeInteger(quantity) || quantity < 0)) {
      toast.error("Opening stock must be a non-negative whole number.");
      return;
    }
    const pricesAreValid = hasVariants
      ? generatedVariants.every((variant) =>
          variant.sku.trim() &&
          getPriceCents(variant.retail_price) !== null &&
          getPriceCents(variant.unit_cost) !== null,
        )
      : getPriceCents(formData.retail_price) !== null &&
        getPriceCents(formData.unit_cost) !== null;
    if (!pricesAreValid) {
      toast.error("Enter a SKU and non-negative retail prices and unit costs with at most two decimal places (maximum KSh 99,999,999.99).");
      return;
    }
    const reorderLevel = Number(formData.reorder_level);
    if (!Number.isInteger(reorderLevel) || reorderLevel < 0) {
      toast.error("Reorder level must be a non-negative whole number.");
      return;
    }
    if (openingQuantities.some((quantity) => quantity > 0) && !warehouseId) {
      toast.error("Select a warehouse for opening stock");
      return;
    }
    setLoading(true);

    try {
      const productData: {
        name: string;
        sku: string;
        barcode: string;
        category_id: string | null;
        unit_cost: string;
        retail_price: string;
        stock_on_hand: number;
        reorder_level: number;
        tax_class_id: string | null;
        unit_of_measure: string;
        location: string;
        etims_item_code?: string;
        etims_item_class_code: string;
        etims_product_type_code: string;
        etims_origin_country_code: string;
        etims_packaging_unit_code: string;
        etims_quantity_unit_code: string;
        etims_tax_type_code: string;
        warehouse_id?: string;
        variants?: Array<{
          sku: string;
          barcode: string;
          variant_attributes: Record<string, string>;
          unit_cost: string;
          retail_price: string;
          stock_on_hand: number;
          etims_item_code: string;
        }>;
      } = {
        name: formData.name,
        sku: formData.sku,
        barcode: formData.barcode || formData.sku,
        category_id: formData.category_id || null,
        unit_cost: centsToKesString(getPriceCents(formData.unit_cost) ?? 0),
        retail_price: centsToKesString(getPriceCents(formData.retail_price) ?? 0),
        stock_on_hand: Number(formData.stock_on_hand || "0"),
        reorder_level: reorderLevel,
        tax_class_id: formData.tax_class_id || null,
        unit_of_measure: formData.unit_of_measure,
        location: formData.location.trim() || "main",
        etims_item_code: hasVariants ? undefined : formData.etims_item_code,
        etims_item_class_code: formData.etims_item_class_code,
        etims_product_type_code: formData.etims_product_type_code,
        etims_origin_country_code: formData.etims_origin_country_code,
        etims_packaging_unit_code: formData.etims_packaging_unit_code,
        etims_quantity_unit_code: formData.etims_quantity_unit_code,
        etims_tax_type_code: formData.etims_tax_type_code,
        warehouse_id: warehouseId || undefined,
      };

      if (hasVariants && generatedVariants.length > 0) {
        productData.variants = generatedVariants.map((v) => ({
          ...v,
          unit_cost: centsToKesString(getPriceCents(v.unit_cost) ?? 0),
          retail_price: centsToKesString(getPriceCents(v.retail_price) ?? 0),
          stock_on_hand: Number(v.stock_on_hand || "0"),
          barcode: v.barcode || v.sku,
          etims_item_code: v.etims_item_code,
        }));
      }

      const response = await ApiService.post<CreateProductResponse>(
        "/products",
        productData,
      );

      setCreatedProduct("parent" in response ? response.parent : response);
      setShowBarcode(true);
      toast.success("Product created successfully");
    } catch (error) {
      toast.error(error.message || "Error creating product");
    } finally {
      setLoading(false);
    }
  };

  const handleVariantChange = (index: number, field: string, value: string) => {
    const updated = [...generatedVariants];
    updated[index] = { ...updated[index], [field]: value };
    setGeneratedVariants(updated);
  };

  if (showBarcode && createdProduct) {
    return (
      <div className="p-2 sm:p-4 md:p-6 space-y-4 sm:space-y-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/products")}
            className="self-start"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Back to Products
          </Button>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">Product Created</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Print labels or add another product
            </p>
          </div>
        </div>

        <div className="max-w-2xl">
          <BarcodeGenerator
            value={createdProduct.barcode || createdProduct.sku}
            productName={createdProduct.name}
            price={createdProduct.retail_price}
            sku={createdProduct.sku}
          />
        </div>

        <div className="flex gap-2">
          <Button
            onClick={() => {
              setShowBarcode(false);
              setCreatedProduct(null);
              setFormData({
                sku: "",
                barcode: "",
                name: "",
                unit_cost: "",
                retail_price: "",
                stock_on_hand: "0",
                reorder_level: "10",
                tax_class_id: taxClasses.find((t) => t.is_default)?.id || "",
                category_id: "",
                unit_of_measure: productUnits[0] || "piece",
                location: "main",
              });
              setHasVariants(false);
              setOptions([{ name: "", values: "" }]);
              setGeneratedVariants([]);
            }}
          >
            Add Another Product
          </Button>
          <Button variant="outline" onClick={() => navigate("/products")}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-4 md:p-6 space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/products")}
          className="self-start"
        >
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">New Product</h1>
          <p className="text-sm sm:text-base text-muted-foreground">
            Add a new product to inventory
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6 max-w-4xl">
        <Card>
          <CardHeader>
            <CardTitle>Basic Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="name">Product Name *</Label>
                <Input
                  id="name"
                  required
                  value={formData.name}
                  onChange={(e) =>
                    setFormData({ ...formData, name: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tax_class">Tax Class</Label>
                <Select
                  value={formData.tax_class_id}
                  onValueChange={(val) =>
                    setFormData({ ...formData, tax_class_id: val })
                  }
                >
                  <SelectTrigger id="tax_class">
                    <SelectValue placeholder="Select Tax Class" />
                  </SelectTrigger>
                  <SelectContent>
                    {taxClasses.map((tax) => (
                      <SelectItem key={tax.id} value={tax.id}>
                        {tax.name} ({Number(tax.rate)}%)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="category">Category</Label>
                <Select
                  value={formData.category_id || "none"}
                  onValueChange={(value) =>
                    setFormData({
                      ...formData,
                      category_id: value === "none" ? "" : value,
                    })
                  }
                >
                  <SelectTrigger id="category">
                    <SelectValue placeholder="Select category" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No category</SelectItem>
                    {categories.map((category) => (
                      <SelectItem key={category.id} value={category.id}>
                        {category.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit_of_measure">Unit of Measure *</Label>
                <Select
                  value={formData.unit_of_measure}
                  onValueChange={(value) =>
                    setFormData({ ...formData, unit_of_measure: value })
                  }
                >
                  <SelectTrigger id="unit_of_measure">
                    <SelectValue placeholder="Select unit" />
                  </SelectTrigger>
                  <SelectContent>
                    {productUnits.map((unit) => (
                      <SelectItem key={unit} value={unit}>
                        {unit}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="location">Storage Location</Label>
                <Input
                  id="location"
                  maxLength={100}
                  value={formData.location}
                  onChange={(e) =>
                    setFormData({ ...formData, location: e.target.value })
                  }
                  placeholder="e.g. Main shelf"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sku">Parent SKU *</Label>
                <Input
                  id="sku"
                  required
                  value={formData.sku}
                  onChange={(e) =>
                    setFormData({ ...formData, sku: e.target.value })
                  }
                />
              </div>
              {!hasVariants && (
                <div className="space-y-2">
                  <Label htmlFor="barcode">Barcode</Label>
                  <Input
                    id="barcode"
                    value={formData.barcode}
                    onChange={(e) =>
                      setFormData({ ...formData, barcode: e.target.value })
                    }
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="retail_price">Base Retail Price (KSh) *</Label>
                <Input
                  id="retail_price"
                  type="text"
                  inputMode="decimal"
                  required
                  value={formData.retail_price}
                  onChange={(e) =>
                    setFormData({ ...formData, retail_price: e.target.value })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="unit_cost">Base Unit Cost (KSh) *</Label>
                <Input
                  id="unit_cost"
                  type="text"
                  inputMode="decimal"
                  required
                  value={formData.unit_cost}
                  onChange={(e) =>
                    setFormData({ ...formData, unit_cost: e.target.value })
                  }
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>KRA eTIMS Item Mapping</CardTitle>
            <CardDescription>
              Optional until an approved VSCU is configured. Enter the exact
              item and code values assigned or confirmed for your business by
              KRA; the POS does not infer tax, origin, packaging, or quantity
              units. Each variant needs its own unique KRA item code below.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {!hasVariants && (
              <div className="space-y-2">
                <Label htmlFor="etims_item_code">KRA Item Code</Label>
                <Input
                  id="etims_item_code"
                  maxLength={20}
                  value={formData.etims_item_code}
                  onChange={(e) => setFormData({ ...formData, etims_item_code: e.target.value })}
                />
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="etims_item_class_code">KRA Item Classification Code</Label>
              <Input
                id="etims_item_class_code"
                maxLength={10}
                value={formData.etims_item_class_code}
                onChange={(e) => setFormData({ ...formData, etims_item_class_code: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="etims_product_type_code">KRA Product Type</Label>
              <Select
                value={formData.etims_product_type_code || "none"}
                onValueChange={(value) => setFormData({
                  ...formData,
                  etims_product_type_code: value === "none" ? "" : value,
                })}
              >
                <SelectTrigger id="etims_product_type_code">
                  <SelectValue placeholder="Select KRA product type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not mapped</SelectItem>
                  <SelectItem value="1">1 - Raw material</SelectItem>
                  <SelectItem value="2">2 - Finished product</SelectItem>
                  <SelectItem value="3">3 - Service</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="etims_origin_country_code">KRA Country of Origin Code</Label>
              <Input
                id="etims_origin_country_code"
                maxLength={5}
                value={formData.etims_origin_country_code}
                onChange={(e) => setFormData({ ...formData, etims_origin_country_code: e.target.value })}
                placeholder="Enter the KRA country code"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="etims_packaging_unit_code">KRA Packaging Unit Code</Label>
              <Input
                id="etims_packaging_unit_code"
                maxLength={5}
                value={formData.etims_packaging_unit_code}
                onChange={(e) => setFormData({ ...formData, etims_packaging_unit_code: e.target.value })}
                placeholder="Enter the KRA packaging code"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="etims_quantity_unit_code">KRA Unit of Quantity Code</Label>
              <Input
                id="etims_quantity_unit_code"
                maxLength={5}
                value={formData.etims_quantity_unit_code}
                onChange={(e) => setFormData({ ...formData, etims_quantity_unit_code: e.target.value })}
                placeholder="Enter the KRA quantity code"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="etims_tax_type_code">KRA Tax Type</Label>
              <Select
                value={formData.etims_tax_type_code || "none"}
                onValueChange={(value) => setFormData({
                  ...formData,
                  etims_tax_type_code: value === "none" ? "" : value,
                })}
              >
                <SelectTrigger id="etims_tax_type_code">
                  <SelectValue placeholder="Select KRA tax type" />
                </SelectTrigger>
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
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <div className="space-y-0.5">
              <CardTitle>Product Variants</CardTitle>
              <CardDescription>
                Does this product come in multiple options like size or color?
              </CardDescription>
            </div>
            <Switch checked={hasVariants} onCheckedChange={setHasVariants} />
          </CardHeader>
          {hasVariants && (
            <CardContent className="space-y-4 pt-4 border-t">
              <div className="space-y-3">
                {options.map((opt, i) => (
                  <div key={i} className="flex gap-2 items-end">
                    <div className="flex-1 space-y-1">
                      <Label>Option Name</Label>
                      <Input
                        placeholder="e.g. Size"
                        value={opt.name}
                        onChange={(e) => {
                          const newOpts = [...options];
                          newOpts[i].name = e.target.value;
                          setOptions(newOpts);
                        }}
                      />
                    </div>
                    <div className="flex-[2] space-y-1">
                      <Label>Option Values (comma separated)</Label>
                      <Input
                        placeholder="e.g. Small, Medium, Large"
                        value={opt.values}
                        onChange={(e) => {
                          const newOpts = [...options];
                          newOpts[i].values = e.target.value;
                          setOptions(newOpts);
                        }}
                      />
                    </div>
                    {options.length > 1 && (
                      <Button
                        variant="ghost"
                        type="button"
                        size="icon"
                        onClick={() =>
                          setOptions(options.filter((_, idx) => idx !== i))
                        }
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    )}
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setOptions([...options, { name: "", values: "" }])
                  }
                >
                  <Plus className="h-4 w-4 mr-2" /> Add another option
                </Button>
              </div>

              {generatedVariants.length > 0 && (
                <div className="mt-6 border rounded-md overflow-hidden">
                  <div className="grid grid-cols-12 bg-muted p-2 text-sm font-medium">
                    <div className="col-span-3">Variant</div>
                    <div className="col-span-3">SKU</div>
                    <div className="col-span-2">Price</div>
                    <div className="col-span-2">Cost</div>
                    <div className="col-span-2">Stock</div>
                  </div>
                  <div className="divide-y max-h-[300px] overflow-y-auto">
                    {generatedVariants.map((v, i) => (
                      <div key={i} className="space-y-2 p-2">
                        <div className="grid grid-cols-12 gap-2 items-center">
                          <div className="col-span-3 text-sm">
                            {Object.values(v.variant_attributes).join(" / ")}
                          </div>
                          <div className="col-span-3">
                            <Input
                              className="h-8"
                              value={v.sku}
                              onChange={(e) => handleVariantChange(i, "sku", e.target.value)}
                            />
                          </div>
                          <div className="col-span-2">
                            <Input
                              className="h-8"
                              type="text"
                              inputMode="decimal"
                              value={v.retail_price}
                              onChange={(e) => handleVariantChange(i, "retail_price", e.target.value)}
                            />
                          </div>
                          <div className="col-span-2">
                            <Input
                              className="h-8"
                              type="text"
                              inputMode="decimal"
                              value={v.unit_cost}
                              onChange={(e) => handleVariantChange(i, "unit_cost", e.target.value)}
                            />
                          </div>
                          <div className="col-span-2">
                            <Input
                              className="h-8"
                              type="number"
                              min="0"
                              step="1"
                              value={v.stock_on_hand}
                              onChange={(e) => handleVariantChange(i, "stock_on_hand", e.target.value)}
                            />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`etims_item_code_${i}`}>KRA Item Code</Label>
                          <Input
                            id={`etims_item_code_${i}`}
                            maxLength={20}
                            value={v.etims_item_code}
                            onChange={(e) => handleVariantChange(i, "etims_item_code", e.target.value)}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Opening Stock Location</CardTitle>
            <CardDescription>
              Initial quantities for this product or its variants will be
              assigned here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Label htmlFor="opening-warehouse">Warehouse</Label>
            <Select value={warehouseId} onValueChange={setWarehouseId}>
              <SelectTrigger id="opening-warehouse">
                <SelectValue placeholder="Select a warehouse for opening stock" />
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
          </CardContent>
        </Card>

        {!hasVariants && (
          <Card>
            <CardHeader>
              <CardTitle>Inventory Details</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="stock_on_hand">Initial Stock</Label>
                  <Input
                    id="stock_on_hand"
                    type="number"
                    min="0"
                    step="1"
                    required
                    value={formData.stock_on_hand}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        stock_on_hand: e.target.value,
                      })
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="reorder_level">Reorder Level</Label>
                  <Input
                    id="reorder_level"
                    type="number"
                    min="0"
                    step="1"
                    required
                    value={formData.reorder_level}
                    onChange={(e) =>
                      setFormData({
                        ...formData,
                        reorder_level: e.target.value,
                      })
                    }
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={loading} size="lg">
            {loading ? "Saving..." : "Save Product"}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            onClick={() => navigate("/products")}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
