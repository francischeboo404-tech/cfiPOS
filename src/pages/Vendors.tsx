import { useState, useEffect } from "react";
import { ApiService } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Edit, Trash2, Check } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuthContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import VendorPortalPage from "./VendorPortal";
import PurchaseOrdersPage from "./PurchaseOrders";
import DeliveryNotesPage from "./DeliveryNotes";
import SupplierInvoicesPage from "./SupplierInvoices";

interface Vendor {
  id: string;
  name: string;
  contact_person: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  payment_terms: string | null;
  needs_review: boolean;
}

export default function Vendors() {
  const { role } = useAuth();
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingVendor, setEditingVendor] = useState<Vendor | null>(null);
  const [vendorToDelete, setVendorToDelete] = useState<string | null>(null);
  const [formData, setFormData] = useState({
    name: "",
    contact_person: "",
    phone: "",
    email: "",
    address: "",
    payment_terms: "",
  });

  useEffect(() => {
    loadVendors();
  }, []);

  const loadVendors = async () => {
    try {
      const data = await ApiService.get<Vendor[]>("/vendors");
      setVendors(data || []);
    } catch (e) {
      toast.error("Failed to load suppliers: " + e.message);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (editingVendor) {
        await ApiService.put(`/vendors/${editingVendor.id}`, formData);
        toast.success("Supplier updated successfully");
      } else {
        await ApiService.post("/vendors", formData);
        toast.success("Supplier added successfully");
      }
      setIsDialogOpen(false);
      resetForm();
      loadVendors();
    } catch (error) {
      toast.error(error.message);
    }
  };

  const resetForm = () => {
    setFormData({
      name: "",
      contact_person: "",
      phone: "",
      email: "",
      address: "",
      payment_terms: "",
    });
    setEditingVendor(null);
  };

  const handleEdit = (vendor: Vendor) => {
    setEditingVendor(vendor);
    setFormData({
      name: vendor.name,
      contact_person: vendor.contact_person || "",
      phone: vendor.phone || "",
      email: vendor.email || "",
      address: vendor.address || "",
      payment_terms: vendor.payment_terms || "",
    });
    setIsDialogOpen(true);
  };

  const handleDelete = async () => {
    if (!vendorToDelete) return;

    try {
      await ApiService.delete(`/vendors/${vendorToDelete}`);
      toast.success("Supplier deleted");
      loadVendors();
    } catch (error) {
      toast.error(error.message || "Failed to delete supplier");
    }
    setVendorToDelete(null);
  };

  const handleReviewSupplier = async (vendor: Vendor) => {
    try {
      await ApiService.post(`/vendors/${vendor.id}/review`, {});
      toast.success("Supplier record reviewed");
      await loadVendors();
    } catch (error) {
      toast.error(error.message || "Failed to review supplier");
    }
  };

  const isAdmin = role === "admin";
  const canReviewSuppliers = role === "admin" || role === "manager";

  const tabItems = [
    { value: "vendors", label: "Suppliers" },
    { value: "vendor-portal", label: "Supplier Portal" },
    { value: "purchase-orders", label: "Purchase Orders" },
    { value: "delivery-notes", label: "Delivery Notes" },
    { value: "supplier-invoices", label: "Supplier Invoices" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">Supplier Operations</h1>
            <p className="text-muted-foreground">
              Manage suppliers, procurement, and fulfillment workflows
            </p>
          </div>
        </div>

        <Tabs defaultValue="vendors" className="w-full">
          <TabsList className="h-auto w-full flex-wrap justify-start rounded-lg bg-muted/60 p-1">
            {tabItems.map((tab) => (
              <TabsTrigger
                key={tab.value}
                value={tab.value}
                className="flex-1 sm:flex-none"
              >
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="vendors" className="mt-6">
            <div className="p-6 space-y-6">
              <div className="flex justify-between items-center">
                <div>
                  <h2 className="text-2xl font-bold">Suppliers</h2>
                  <p className="text-muted-foreground">
                    Manage supplier information
                  </p>
                </div>
                {isAdmin && (
                  <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
                    <DialogTrigger asChild>
                      <Button onClick={resetForm}>
                        <Plus className="h-4 w-4 mr-2" />
                        Add Supplier
                      </Button>
                    </DialogTrigger>
                    <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>
                          {editingVendor ? "Edit" : "Add"} Supplier
                        </DialogTitle>
                      </DialogHeader>
                      <form onSubmit={handleSubmit} className="space-y-4">
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor="name">Company Name *</Label>
                            <Input
                              id="name"
                              value={formData.name}
                              onChange={(e) =>
                                setFormData({
                                  ...formData,
                                  name: e.target.value,
                                })
                              }
                              required
                            />
                          </div>
                          <div>
                            <Label htmlFor="contact_person">
                              Contact Person
                            </Label>
                            <Input
                              id="contact_person"
                              value={formData.contact_person}
                              onChange={(e) =>
                                setFormData({
                                  ...formData,
                                  contact_person: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div>
                            <Label htmlFor="phone">Phone</Label>
                            <Input
                              id="phone"
                              value={formData.phone}
                              onChange={(e) =>
                                setFormData({
                                  ...formData,
                                  phone: e.target.value,
                                })
                              }
                              placeholder="+254 700 000000"
                            />
                          </div>
                          <div>
                            <Label htmlFor="email">Email</Label>
                            <Input
                              id="email"
                              type="email"
                              value={formData.email}
                              onChange={(e) =>
                                setFormData({
                                  ...formData,
                                  email: e.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                        <div>
                          <Label htmlFor="address">Address</Label>
                          <Textarea
                            id="address"
                            value={formData.address}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                address: e.target.value,
                              })
                            }
                            rows={2}
                          />
                        </div>
                        <div>
                          <Label htmlFor="payment_terms">Payment Terms</Label>
                          <Input
                            id="payment_terms"
                            value={formData.payment_terms}
                            onChange={(e) =>
                              setFormData({
                                ...formData,
                                payment_terms: e.target.value,
                              })
                            }
                            placeholder="e.g., Net 30, COD"
                          />
                        </div>
                        <Button type="submit" className="w-full">
                          {editingVendor ? "Update" : "Add"} Supplier
                        </Button>
                      </form>
                    </DialogContent>
                  </Dialog>
                )}
              </div>

              <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
                {vendors.map((vendor) => (
                  <Card key={vendor.id}>
                    <CardHeader>
                      <CardTitle className="flex justify-between items-start">
                        <div className="flex flex-col gap-2">
                          <span>{vendor.name}</span>
                          {vendor.needs_review && (
                            <Badge variant="destructive" className="w-fit">Review needed</Badge>
                          )}
                        </div>
                        <div className="flex gap-1">
                          {vendor.needs_review && canReviewSuppliers && (
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => handleReviewSupplier(vendor)}
                            >
                              <Check className="h-4 w-4 mr-1" />
                              Mark reviewed
                            </Button>
                          )}
                          {isAdmin && (
                            <>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleEdit(vendor)}
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => setVendorToDelete(vendor.id)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                            </>
                          )}
                        </div>
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm">
                      {vendor.contact_person && (
                        <div>
                          <span className="font-semibold">Contact:</span>{" "}
                          {vendor.contact_person}
                        </div>
                      )}
                      {vendor.phone && (
                        <div>
                          <span className="font-semibold">Phone:</span>{" "}
                          {vendor.phone}
                        </div>
                      )}
                      {vendor.email && (
                        <div>
                          <span className="font-semibold">Email:</span>{" "}
                          {vendor.email}
                        </div>
                      )}
                      {vendor.address && (
                        <div>
                          <span className="font-semibold">Address:</span>{" "}
                          {vendor.address}
                        </div>
                      )}
                      {vendor.payment_terms && (
                        <div>
                          <span className="font-semibold">Terms:</span>{" "}
                          {vendor.payment_terms}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
              </div>

              <AlertDialog
                open={!!vendorToDelete}
                onOpenChange={(open) => !open && setVendorToDelete(null)}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete Supplier</AlertDialogTitle>
                    <AlertDialogDescription>
                      Are you sure you want to delete this supplier? This will
                      also delete all related purchase orders. This action
                      cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </TabsContent>

          <TabsContent value="vendor-portal" className="mt-6">
            <VendorPortalPage />
          </TabsContent>

          <TabsContent value="purchase-orders" className="mt-6">
            <PurchaseOrdersPage />
          </TabsContent>

          <TabsContent value="delivery-notes" className="mt-6">
            <DeliveryNotesPage />
          </TabsContent>

          <TabsContent value="supplier-invoices" className="mt-6">
            <SupplierInvoicesPage />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
