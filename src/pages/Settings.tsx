import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Settings as SettingsIcon,
  Save,
  Award,
  Plus,
  Trash2,
  CheckCircle2,
  Upload,
  Pencil,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuthContext";
import { ApiService } from "@/lib/api";
import {
  notifyCompanyBrandingUpdated,
  resolveCompanyLogoUrl,
} from "@/hooks/useCompanyBranding";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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

const DEFAULT_PRODUCT_UNITS = [
  "piece",
  "each",
  "kg",
  "g",
  "grams",
  "litre",
  "ml",
  "pack",
  "box",
  "dozen",
];

const parseProductUnits = (value: string | undefined): string[] => {
  if (!value) return [...DEFAULT_PRODUCT_UNITS];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((unit) => typeof unit !== "string")) {
    throw new Error("Saved product units are not a valid list.");
  }
  return parsed;
};

export default function Settings() {
  const { role } = useAuth();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [registeringC2b, setRegisteringC2b] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [categories, setCategories] = useState<ProductCategory[]>([]);
  const [categoriesLoading, setCategoriesLoading] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState("");
  const [productUnits, setProductUnits] = useState<string[]>([...DEFAULT_PRODUCT_UNITS]);
  const [newProductUnit, setNewProductUnit] = useState("");
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const settingsMap =
        await ApiService.get<Record<string, string>>("/settings");
      let units: string[];
      try {
        units = parseProductUnits(settingsMap?.product_unit_of_measures);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Unable to load product units");
        units = [...DEFAULT_PRODUCT_UNITS];
      }
      setProductUnits(units);
      setSettings({
        ...(settingsMap || {}),
        product_unit_of_measures: JSON.stringify(units),
        company_logo: resolveCompanyLogoUrl(settingsMap?.company_logo) || "",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load settings");
    }
  };

  const [taxes, setTaxes] = useState<TaxClass[]>([]);
  const [newTax, setNewTax] = useState({ name: "", rate: "" });

  const loadCategories = async () => {
    setCategoriesLoading(true);
    try {
      const data = await ApiService.get<ProductCategory[]>("/categories");
      setCategories(data || []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to load product categories");
    } finally {
      setCategoriesLoading(false);
    }
  };

  const loadTaxes = async () => {
    try {
      const data = await ApiService.get<TaxClass[]>("/taxes");
      setTaxes(data || []);
    } catch (error) {
      console.error("Error loading taxes:", error);
    }
  };

  useEffect(() => {
    loadTaxes();
    loadCategories();
  }, []);

  const handleAddCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) {
      toast.error("Enter a category name");
      return;
    }
    setLoading(true);
    try {
      const category = await ApiService.post<ProductCategory>("/categories", { name });
      setCategories((previous) => [...previous, category].sort((a, b) => a.name.localeCompare(b.name)));
      setNewCategoryName("");
      toast.success("Product category saved and ready for imports");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save product category");
    } finally {
      setLoading(false);
    }
  };

  const handleSaveCategory = async (id: string) => {
    const name = editingCategoryName.trim();
    if (!name) {
      toast.error("Enter a category name");
      return;
    }
    setLoading(true);
    try {
      const updated = await ApiService.put<ProductCategory>(`/categories/${id}`, { name });
      setCategories((previous) =>
        previous.map((category) => category.id === id ? updated : category)
          .sort((a, b) => a.name.localeCompare(b.name)),
      );
      setEditingCategoryId(null);
      setEditingCategoryName("");
      toast.success("Product category updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update product category");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteCategory = async (category: ProductCategory) => {
    if (!confirm(`Delete the "${category.name}" category? Categories used by products cannot be deleted.`)) return;
    setLoading(true);
    try {
      await ApiService.delete(`/categories/${category.id}`);
      setCategories((previous) => previous.filter((item) => item.id !== category.id));
      toast.success("Product category deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete product category");
    } finally {
      setLoading(false);
    }
  };

  const handleAddProductUnit = () => {
    const unit = newProductUnit.trim();
    if (!unit) {
      toast.error("Enter a unit of measure");
      return;
    }
    if (unit.length > 50) {
      toast.error("Unit names must be 50 characters or fewer");
      return;
    }
    if (productUnits.some((configuredUnit) => configuredUnit.toLocaleLowerCase() === unit.toLocaleLowerCase())) {
      toast.error(`The "${unit}" unit is already configured`);
      return;
    }
    const updatedUnits = [...productUnits, unit];
    setProductUnits(updatedUnits);
    updateSetting("product_unit_of_measures", JSON.stringify(updatedUnits));
    setNewProductUnit("");
  };

  const handleRemoveProductUnit = (unit: string) => {
    const updatedUnits = productUnits.filter((configuredUnit) => configuredUnit !== unit);
    if (updatedUnits.length === 0) {
      toast.error("At least one unit of measure must remain configured");
      return;
    }
    setProductUnits(updatedUnits);
    updateSetting("product_unit_of_measures", JSON.stringify(updatedUnits));
  };

  const handleAddTax = async () => {
    if (!newTax.name || !newTax.rate) return;
    setLoading(true);
    try {
      await ApiService.post("/taxes", {
        name: newTax.name,
        rate: parseFloat(newTax.rate),
        is_default: taxes.length === 0, // make default if it's the first one
      });
      setNewTax({ name: "", rate: "" });
      await loadTaxes();
      toast.success("Tax class added");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to add tax class");
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTax = async (id: string) => {
    if (!confirm("Are you sure you want to delete this tax class?")) return;
    setLoading(true);
    try {
      await ApiService.delete(`/taxes/${id}`);
      await loadTaxes();
      toast.success("Tax class deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to delete tax class");
    } finally {
      setLoading(false);
    }
  };

  const handleSetDefaultTax = async (id: string) => {
    setLoading(true);
    try {
      const tax = taxes.find((t) => t.id === id);
      if (tax) {
        await ApiService.put(`/taxes/${id}`, { ...tax, is_default: true });
        await loadTaxes();
        toast.success("Default tax class updated");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to update default tax");
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (role !== "admin") {
      toast.error("Only admins can update settings");
      return;
    }

    const stkAccountType = settings.mpesa_stk_account_type === "paybill" ? "paybill" : "till";
    const stkNumber = stkAccountType === "paybill"
      ? settings.mpesa_paybill?.trim() || ""
      : settings.mpesa_shortcode?.trim() || settings.mpesa_till_number?.trim() || "";
    if (stkNumber && !/^\d{5,7}$/.test(stkNumber)) {
      toast.error("The M-Pesa STK Till or Paybill number must contain 5 to 7 digits.");
      return;
    }
    if (!stkNumber) {
      toast.error(`Enter a valid 5–7 digit M-Pesa ${stkAccountType === "paybill" ? "Paybill" : "Till"} number for STK Push before saving.`);
      return;
    }
    if (settings.mpesa_paybill?.trim() && !/^\d{5,7}$/.test(settings.mpesa_paybill.trim())) {
      toast.error("The Paybill number must contain 5 to 7 digits.");
      return;
    }

    setLoading(true);
    try {
      const settingsToSave = Object.fromEntries(
        Object.entries(settings).filter(([key]) => key !== "company_logo"),
      );
      await ApiService.post("/settings", { settings: settingsToSave });
      notifyCompanyBrandingUpdated({
        company_logo: settings.company_logo || null,
        company_name: settings.company_name || "",
      });
      toast.success("Settings saved successfully");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save settings");
    } finally {
      setLoading(false);
    }
  };

  const handleLogoUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    const maxLogoSize = 3 * 1024 * 1024;
    if (file.size > maxLogoSize) {
      toast.error("The company logo must be 3 MB or smaller");
      return;
    }

    setUploadingLogo(true);
    let imageUrl: string | null = null;
    try {
      const previewUrl = URL.createObjectURL(file);
      imageUrl = previewUrl;
      await new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Choose a valid PNG, JPEG, or WebP image"));
        image.src = previewUrl;
      });

      const formData = new FormData();
      formData.append("logo", file);
      const response = await ApiService.request<{ company_logo: string }>(
        "/settings/company-logo",
        { method: "POST", body: formData },
      );
      const logoUrl = resolveCompanyLogoUrl(response.company_logo) || "";
      setSettings((previous) => ({ ...previous, company_logo: logoUrl }));
      notifyCompanyBrandingUpdated({ company_logo: logoUrl || null });
      toast.success("Company logo uploaded successfully");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to upload the company logo");
    } finally {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
      setUploadingLogo(false);
    }
  };

  const handleRemoveLogo = async () => {
    if (!settings.company_logo || !confirm("Remove the current company logo?")) return;

    setUploadingLogo(true);
    try {
      await ApiService.delete("/settings/company-logo");
      setSettings((previous) => ({ ...previous, company_logo: "" }));
      notifyCompanyBrandingUpdated({ company_logo: null });
      toast.success("Company logo removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to remove the company logo");
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleRegisterC2b = async () => {
    if (role !== "admin") {
      toast.error("Only admins can register M-Pesa callbacks");
      return;
    }
    setRegisteringC2b(true);
    try {
      const result = await ApiService.post<{ message?: string }>("/payments/mpesa/c2b/register", {});
      toast.success(result.message || "Paybill callbacks registered");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not register Paybill callbacks");
    } finally {
      setRegisteringC2b(false);
    }
  };

  const updateSetting = (key: string, value: string) => {
    setSettings({ ...settings, [key]: value });
  };

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <SettingsIcon className="h-8 w-8" />
          Settings
        </h1>
        <p className="text-muted-foreground">Configure your POS system</p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Product Catalog</CardTitle>
            <CardDescription>
              Configure category names and units of measure. Categories save immediately; save units with the Settings button below. Imports must use these configured values.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-8 lg:grid-cols-2">
            <section className="min-w-0 space-y-4" aria-labelledby="product-categories-heading">
              <div>
                <h2 id="product-categories-heading" className="font-semibold">Product Categories</h2>
                <p className="text-sm text-muted-foreground">
                  Use the category name exactly as it appears in your import file.
                </p>
              </div>
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleAddCategory();
                }}
              >
                <Input
                  value={newCategoryName}
                  onChange={(event) => setNewCategoryName(event.target.value)}
                  placeholder="e.g. Food"
                  aria-label="New product category name"
                  disabled={role !== "admin" || loading}
                  maxLength={100}
                />
                <Button type="submit" disabled={role !== "admin" || loading || !newCategoryName.trim()}>
                  <Plus className="mr-2 h-4 w-4" /> Add category
                </Button>
              </form>
              <div className="max-h-72 overflow-y-auto rounded-md border">
                {categoriesLoading ? (
                  <p className="p-4 text-sm text-muted-foreground">Loading categories...</p>
                ) : categories.length === 0 ? (
                  <p className="p-4 text-sm text-muted-foreground">No categories yet. Add one to use it in product imports.</p>
                ) : (
                  <ul className="divide-y">
                    {categories.map((category) => (
                      <li key={category.id} className="flex min-w-0 items-center gap-2 p-2">
                        {editingCategoryId === category.id ? (
                          <>
                            <Input
                              value={editingCategoryName}
                              onChange={(event) => setEditingCategoryName(event.target.value)}
                              aria-label={`Edit ${category.name} category`}
                              maxLength={100}
                              disabled={loading}
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="outline"
                              aria-label="Save category"
                              onClick={() => void handleSaveCategory(category.id)}
                              disabled={loading || !editingCategoryName.trim()}
                            >
                              <CheckCircle2 className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              aria-label="Cancel category edit"
                              onClick={() => setEditingCategoryId(null)}
                              disabled={loading}
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </>
                        ) : (
                          <>
                            <span className="min-w-0 flex-1 truncate font-medium">{category.name}</span>
                            {role === "admin" && (
                              <>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  aria-label={`Rename ${category.name}`}
                                  onClick={() => {
                                    setEditingCategoryId(category.id);
                                    setEditingCategoryName(category.name);
                                  }}
                                  disabled={loading}
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="text-destructive"
                                  aria-label={`Delete ${category.name}`}
                                  onClick={() => void handleDeleteCategory(category)}
                                  disabled={loading}
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>

            <section className="min-w-0 space-y-4" aria-labelledby="product-units-heading">
              <div>
                <h2 id="product-units-heading" className="font-semibold">Units of Measure</h2>
                <p className="text-sm text-muted-foreground">
                  Add the unit names used in your product import files (for example grams).
                </p>
              </div>
              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  handleAddProductUnit();
                }}
              >
                <Input
                  value={newProductUnit}
                  onChange={(event) => setNewProductUnit(event.target.value)}
                  placeholder="e.g. grams"
                  aria-label="New unit of measure"
                  disabled={role !== "admin"}
                  maxLength={50}
                />
                <Button type="submit" disabled={role !== "admin" || !newProductUnit.trim()}>
                  <Plus className="mr-2 h-4 w-4" /> Add unit
                </Button>
              </form>
              <div className="flex max-h-72 flex-wrap content-start gap-2 overflow-y-auto rounded-md border p-3">
                {productUnits.map((unit) => (
                  <Badge key={unit} variant="secondary" className="gap-1 py-1 pl-3">
                    {unit}
                    {role === "admin" && (
                      <button
                        type="button"
                        className="ml-1 rounded-full p-1 hover:bg-background"
                        aria-label={`Remove ${unit} unit`}
                        onClick={() => handleRemoveProductUnit(unit)}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Unit changes are saved when you select Save Settings. Existing products are not changed.
              </p>
            </section>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Company Information</CardTitle>
            <CardDescription>
              Business details for receipts and invoices
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              <Label htmlFor="company_logo">Company Logo</Label>
              <div className="flex min-w-0 flex-col gap-4 rounded-lg border p-3 sm:flex-row sm:items-center sm:p-4">
                <div className="flex h-24 w-full shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted p-2 sm:h-24 sm:w-36">
                  {settings.company_logo ? (
                    <img
                      src={settings.company_logo}
                      alt="Current company logo preview"
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-center text-xs text-muted-foreground">
                      No company logo uploaded
                    </span>
                  )}
                </div>
                <div className="min-w-0 space-y-2">
                  <p className="text-sm text-muted-foreground">
                    Upload a PNG, JPEG, or WebP image up to 3 MB. It will appear in the navigation and on receipts.
                  </p>
                  <input
                    ref={logoInputRef}
                    id="company_logo"
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={handleLogoUpload}
                    disabled={role !== "admin" || uploadingLogo}
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => logoInputRef.current?.click()}
                      disabled={role !== "admin" || uploadingLogo}
                    >
                      <Upload className="h-4 w-4" />
                      {uploadingLogo ? "Uploading..." : "Upload logo"}
                    </Button>
                    {settings.company_logo && (
                      <Button
                        type="button"
                        variant="ghost"
                        className="text-destructive"
                        onClick={handleRemoveLogo}
                        disabled={role !== "admin" || uploadingLogo}
                      >
                        <Trash2 className="h-4 w-4" />
                        Remove
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div>
              <Label htmlFor="company_name">Company Name</Label>
              <Input
                id="company_name"
                value={settings.company_name || ""}
                onChange={(e) => updateSetting("company_name", e.target.value)}
                disabled={role !== "admin"}
              />
            </div>
            <div>
              <Label htmlFor="company_address">Address</Label>
              <Textarea
                id="company_address"
                value={settings.company_address || ""}
                onChange={(e) =>
                  updateSetting("company_address", e.target.value)
                }
                rows={2}
                disabled={role !== "admin"}
              />
            </div>
            <div>
              <Label htmlFor="company_phone">Phone</Label>
              <Input
                id="company_phone"
                value={settings.company_phone || ""}
                onChange={(e) => updateSetting("company_phone", e.target.value)}
                disabled={role !== "admin"}
              />
            </div>
            <div>
              <Label htmlFor="tax_pin">KRA PIN</Label>
              <Input
                id="tax_pin"
                value={settings.tax_pin || ""}
                onChange={(e) => updateSetting("tax_pin", e.target.value)}
                placeholder="P000000000A"
                disabled={role !== "admin"}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>MPESA Configuration</CardTitle>
            <CardDescription>
              Configure STK Push and automatic Paybill confirmation
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label htmlFor="mpesa_stk_account_type">STK Push account type *</Label>
              <Select
                value={settings.mpesa_stk_account_type === "paybill" ? "paybill" : "till"}
                onValueChange={(value) => updateSetting("mpesa_stk_account_type", value)}
                disabled={role !== "admin"}
              >
                <SelectTrigger id="mpesa_stk_account_type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="till">Till (Buy Goods)</SelectItem>
                  <SelectItem value="paybill">Paybill</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">
                Select the type of business number that will receive STK Push payments.
              </p>
            </div>
            <div>
              <Label htmlFor="mpesa_shortcode">
                {settings.mpesa_stk_account_type === "paybill"
                  ? "Paybill Number for STK Push *"
                  : "Till Number for STK Push *"}
              </Label>
              <Input
                id="mpesa_shortcode"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{5,7}"
                maxLength={7}
                value={settings.mpesa_stk_account_type === "paybill"
                  ? settings.mpesa_paybill || ""
                  : settings.mpesa_shortcode || settings.mpesa_till_number || ""}
                onChange={(e) => updateSetting(
                  settings.mpesa_stk_account_type === "paybill" ? "mpesa_paybill" : "mpesa_shortcode",
                  e.target.value,
                )}
                placeholder={settings.mpesa_stk_account_type === "paybill"
                  ? "Enter your M-Pesa Paybill number"
                  : "Enter your M-Pesa Till number"}
                disabled={role !== "admin"}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Use the matching Safaricom Daraja business number. Numbers must contain 5 to 7 digits.
              </p>
            </div>
            <div>
              <Label htmlFor="mpesa_callback_url">STK Push Callback URL *</Label>
              <Input
                id="mpesa_callback_url"
                type="url"
                value={settings.mpesa_callback_url || ""}
                onChange={(e) =>
                  updateSetting("mpesa_callback_url", e.target.value)
                }
                placeholder="https://pos.example.com/api/webhooks/mpesa/callback"
                disabled={role !== "admin"}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Must be a <strong>public HTTPS URL</strong> ending exactly in{" "}
                <code>/api/webhooks/mpesa/callback</code>. Localhost and private
                network URLs cannot receive Safaricom callbacks. Safaricom
                requires port 443 (standard HTTPS).
              </p>
            </div>
            <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
              STK Push also requires the Daraja Consumer Key, Consumer Secret,
              Passkey, and API Base URL in the backend server environment.
              These credentials are not stored in POS Settings. The payment
              screen reports which server configuration entries are missing.
            </div>
            <div>
              <Label htmlFor="mpesa_paybill">Paybill Number for customer-initiated payments (Optional)</Label>
              <Input
                id="mpesa_paybill"
                value={settings.mpesa_paybill || ""}
                onChange={(e) => updateSetting("mpesa_paybill", e.target.value)}
                placeholder="123456"
                disabled={role !== "admin"}
              />
              <p className="text-xs text-muted-foreground mt-1">
                This also enables customer-initiated Paybill checkout after callback registration. It can be the same number used above for STK Push.
              </p>
              <Button
                type="button"
                variant="outline"
                className="mt-2"
                onClick={handleRegisterC2b}
                disabled={role !== "admin" || registeringC2b || !settings.mpesa_paybill}
              >
                {registeringC2b ? "Registering..." : "Register Paybill Callbacks"}
              </Button>
            </div>
            <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
              <p className="text-sm text-amber-800 dark:text-amber-200">
                <strong>Important:</strong> Choose the correct account type for
                STK Push. Till uses Buy Goods; Paybill uses PayBillOnline. The
                number and type must match your Safaricom Daraja account.
              </p>
            </div>
          </CardContent>
        </Card>

        {/* Loyalty Program Settings */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Award className="h-5 w-5" />
              Loyalty Program
            </CardTitle>
            <CardDescription>
              Configure customer loyalty points and tiers
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-md border p-4 space-y-3">
              <h3 className="font-semibold">Voucher card rules</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="voucher_points_per_100_kes">Points per KES 100 paid</Label>
                  <Input
                    id="voucher_points_per_100_kes"
                    type="number"
                    min="0"
                    step="1"
                    value={settings.voucher_points_per_100_kes ?? "1"}
                    onChange={(event) => updateSetting(
                      "voucher_points_per_100_kes",
                      event.target.value,
                    )}
                    disabled={role !== "admin"}
                  />
                </div>
                <div>
                  <Label htmlFor="voucher_renewal_fee_cents">Renewal fee (KES cents)</Label>
                  <Input
                    id="voucher_renewal_fee_cents"
                    type="number"
                    min="0"
                    step="1"
                    value={settings.voucher_renewal_fee_cents ?? "0"}
                    onChange={(event) => updateSetting(
                      "voucher_renewal_fee_cents",
                      event.target.value,
                    )}
                    disabled={role !== "admin"}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Points are earned from the final amount paid and are never recalculated when this rate changes. One point redeems as KES 1.
              </p>
              <p className="text-xs text-muted-foreground">
                Paid renewal fees are final VAT-inclusive amounts at Standard VAT 16%. Renewal expiry changes only after the full fee is confirmed as paid at checkout.
              </p>
            </div>
            <div className="rounded-md border p-4 space-y-2">
              <Label htmlFor="allow-negative-stock" className="font-semibold">
                Allow admin-configured negative stock sales
              </Label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  id="allow-negative-stock"
                  type="checkbox"
                  checked={settings.allow_negative_stock === "true"}
                  onChange={(event) => updateSetting(
                    "allow_negative_stock",
                    String(event.target.checked),
                  )}
                  disabled={role !== "admin"}
                />
                Permit sales that take available stock below zero
              </label>
              <p className="text-xs text-muted-foreground">
                Oversold quantities use the current warehouse average cost, or the product unit cost when warehouse stock is zero. Each override is recorded with the sale, user, time, and stock movement.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label htmlFor="loyalty_points_rate">Points Earned</Label>
                <Input
                  id="loyalty_points_rate"
                  type="number"
                  min="1"
                  value={settings.loyalty_points_rate || "1"}
                  onChange={(e) =>
                    updateSetting("loyalty_points_rate", e.target.value)
                  }
                  disabled={role !== "admin"}
                />
              </div>
              <div>
                <Label htmlFor="loyalty_points_per_amount">Per KES Spent</Label>
                <Input
                  id="loyalty_points_per_amount"
                  type="number"
                  min="1"
                  value={settings.loyalty_points_per_amount || "100"}
                  onChange={(e) =>
                    updateSetting("loyalty_points_per_amount", e.target.value)
                  }
                  disabled={role !== "admin"}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Customers earn {settings.loyalty_points_rate || "1"} point(s) for
              every KSh {settings.loyalty_points_per_amount || "100"} spent
            </p>

            <div className="border-t pt-4 mt-4">
              <Label className="text-sm font-semibold mb-3 block">
                Points Redemption Value
              </Label>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <Label htmlFor="loyalty_points_value">KES per Point</Label>
                  <Input
                    id="loyalty_points_value"
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={settings.loyalty_points_value || "1"}
                    onChange={(e) =>
                      updateSetting("loyalty_points_value", e.target.value)
                    }
                    disabled={role !== "admin"}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                Each loyalty point is worth KSh{" "}
                {settings.loyalty_points_value || "1"} when redeemed as a
                discount
              </p>
            </div>

            <div className="border-t pt-4 mt-4">
              <Label className="text-sm font-semibold mb-3 block">
                Tier Thresholds (Total Spend in KES)
              </Label>
              <div className="grid gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-gray-400" />
                  <Label htmlFor="loyalty_tier_silver_min" className="w-20">
                    Silver
                  </Label>
                  <Input
                    id="loyalty_tier_silver_min"
                    type="number"
                    min="0"
                    value={settings.loyalty_tier_silver_min || "50000"}
                    onChange={(e) =>
                      updateSetting("loyalty_tier_silver_min", e.target.value)
                    }
                    disabled={role !== "admin"}
                    className="flex-1"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-yellow-500" />
                  <Label htmlFor="loyalty_tier_gold_min" className="w-20">
                    Gold
                  </Label>
                  <Input
                    id="loyalty_tier_gold_min"
                    type="number"
                    min="0"
                    value={settings.loyalty_tier_gold_min || "150000"}
                    onChange={(e) =>
                      updateSetting("loyalty_tier_gold_min", e.target.value)
                    }
                    disabled={role !== "admin"}
                    className="flex-1"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <div className="w-4 h-4 rounded-full bg-purple-500" />
                  <Label htmlFor="loyalty_tier_platinum_min" className="w-20">
                    Platinum
                  </Label>
                  <Input
                    id="loyalty_tier_platinum_min"
                    type="number"
                    min="0"
                    value={settings.loyalty_tier_platinum_min || "300000"}
                    onChange={(e) =>
                      updateSetting("loyalty_tier_platinum_min", e.target.value)
                    }
                    disabled={role !== "admin"}
                    className="flex-1"
                  />
                </div>
              </div>
            </div>

            <div className="p-4 bg-primary/10 border border-primary/20 rounded-lg">
              <p className="text-sm">
                <strong>How it works:</strong> When a customer makes a payment
                (Cash or M-Pesa), they automatically earn loyalty points based
                on the amount spent. Points and tier are calculated in
                real-time.
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Receipt Settings</CardTitle>
            <CardDescription>Customize receipt footer message</CardDescription>
          </CardHeader>
          <CardContent>
            <div>
              <Label htmlFor="receipt_footer">Receipt Footer</Label>
              <Textarea
                id="receipt_footer"
                value={settings.receipt_footer || ""}
                onChange={(e) =>
                  updateSetting("receipt_footer", e.target.value)
                }
                rows={3}
                placeholder="Thank you for your business!"
                disabled={role !== "admin"}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Tax Engine</CardTitle>
            <CardDescription>
              Manage tax classes for your products
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex gap-2 items-end">
                <div className="flex-1 space-y-1">
                  <Label>Tax Name</Label>
                  <Input
                    placeholder="e.g. VAT 16%"
                    value={newTax.name}
                    onChange={(e) =>
                      setNewTax({ ...newTax, name: e.target.value })
                    }
                    disabled={role !== "admin"}
                  />
                </div>
                <div className="w-32 space-y-1">
                  <Label>Rate (%)</Label>
                  <Input
                    type="number"
                    placeholder="16"
                    value={newTax.rate}
                    onChange={(e) =>
                      setNewTax({ ...newTax, rate: e.target.value })
                    }
                    disabled={role !== "admin"}
                  />
                </div>
                <Button
                  onClick={handleAddTax}
                  disabled={loading || role !== "admin"}
                >
                  <Plus className="h-4 w-4 mr-2" /> Add Tax
                </Button>
              </div>

              <div className="border rounded-md divide-y">
                {taxes.map((tax) => (
                  <div
                    key={tax.id}
                    className="p-3 flex items-center justify-between hover:bg-muted/50"
                  >
                    <div>
                      <p className="font-medium flex items-center gap-2">
                        {tax.name}
                        {tax.is_default && (
                          <span className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" /> Default
                          </span>
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {Number(tax.rate).toFixed(2)}%
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!tax.is_default && role === "admin" && (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleSetDefaultTax(tax.id)}
                          disabled={loading}
                        >
                          Set Default
                        </Button>
                      )}
                      {role === "admin" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive"
                          onClick={() => handleDeleteTax(tax.id)}
                          disabled={loading}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                {taxes.length === 0 && (
                  <div className="p-4 text-center text-muted-foreground">
                    No tax classes configured.
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {role === "admin" && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={loading} size="lg">
            <Save className="h-4 w-4 mr-2" />
            {loading ? "Saving..." : "Save Settings"}
          </Button>
        </div>
      )}
    </div>
  );
}
