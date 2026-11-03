import { Toaster } from "@/components/ui/toaster";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Navbar } from "@/components/Navbar";
import { AppSidebar } from "@/components/AppSidebar";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { AuthProvider } from "@/hooks/useAuth";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { PWAInstallPrompt } from "@/components/PWAInstallPrompt";
import { OfflineIndicator } from "@/components/OfflineIndicator";
import { initializeSecurity } from "@/lib/security";
import { lazy, Suspense, useEffect } from "react";

const Landing = lazy(() => import("./pages/Landing"));
const Auth = lazy(() => import("./pages/Auth"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Products = lazy(() => import("./pages/Products"));
const NewProduct = lazy(() => import("./pages/NewProduct"));
const Sales = lazy(() => import("./pages/Sales"));
const Customers = lazy(() => import("./pages/Customers"));
const Vendors = lazy(() => import("./pages/Vendors"));
const PurchaseOrders = lazy(() => import("./pages/PurchaseOrders"));
const NewPurchaseOrder = lazy(() => import("./pages/NewPurchaseOrder"));
const ReceivePurchaseOrder = lazy(() => import("./pages/ReceivePurchaseOrder"));
const MobileCashier = lazy(() => import("./pages/MobileCashier"));
const Locations = lazy(() => import("./pages/Locations"));
const InventoryTransfers = lazy(() => import("./pages/InventoryTransfers"));
const VendorPortal = lazy(() => import("./pages/VendorPortal"));
const Reports = lazy(() => import("./pages/Reports"));
const Returns = lazy(() => import("./pages/Returns"));
const Shifts = lazy(() => import("./pages/Shifts"));
const Loyalty = lazy(() => import("./pages/Loyalty"));
const Settings = lazy(() => import("./pages/Settings"));
const Users = lazy(() => import("./pages/Users"));
const NotFound = lazy(() => import("./pages/NotFound"));
const Invoices = lazy(() => import("./pages/Invoices"));
const DeliveryNotes = lazy(() => import("./pages/DeliveryNotes"));
const SupplierInvoices = lazy(() => import("./pages/SupplierInvoices"));
const StockMovements = lazy(() => import("./pages/StockMovements"));
const AccountsReceivable = lazy(() => import("./pages/AccountsReceivable"));
const InventoryAdjustments = lazy(() => import("./pages/InventoryAdjustments"));
const StockTakes = lazy(() => import("./pages/StockTakes"));
const InventoryOperations = lazy(() => import("./pages/InventoryOperations"));
const Promotions = lazy(() => import("./pages/Promotions"));
const InstallmentPlans = lazy(() => import("./pages/InstallmentPlans"));

const queryClient = new QueryClient();

const App = () => {
  useEffect(() => {
    // Initialize security systems on app startup
    initializeSecurity().catch((error) => {
      console.error("Failed to initialize security systems:", error);
    });
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Sonner />
        <PWAInstallPrompt />
        <BrowserRouter>
          <AuthProvider>
            <OfflineIndicator />
            <Suspense
              fallback={
                <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
                  Loading page...
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/auth" element={<Auth />} />
                <Route
                  path="/*"
                  element={
                    <ProtectedRoute>
                      <div className="h-svh w-full overflow-hidden bg-gradient-to-br from-background via-background to-muted/20">
                        <SidebarProvider>
                          <AppSidebar />
                          <SidebarInset className="h-svh min-h-0 min-w-0 overflow-hidden">
                            <Navbar />
                            <main className="app-route-scroll min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
                              <div className="app-route-content mx-auto w-full max-w-[1920px] px-2 py-3 sm:px-4 sm:py-4 lg:px-6">
                                <Routes>
                                <Route
                                  path="/dashboard"
                                  element={<Dashboard />}
                                />
                                <Route
                                  path="/products"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <Products />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/products/new"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <NewProduct />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route path="/sales" element={<Sales />} />
                                <Route
                                  path="/invoices"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <Invoices />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/customers"
                                  element={<Customers />}
                                />
                                <Route
                                  path="/vendors"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <Vendors />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/purchase-orders"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <PurchaseOrders />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/purchase-orders/new"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <NewPurchaseOrder />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/purchase-orders/:id/receive"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <ReceivePurchaseOrder />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/delivery-notes"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <DeliveryNotes />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/supplier-invoices"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <SupplierInvoices />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/stock-movements"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <StockMovements />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/inventory-operations"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <InventoryOperations />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/accounts-receivable"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <AccountsReceivable />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/promotions"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <Promotions />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/mobile-cashier"
                                  element={<MobileCashier />}
                                />
                                <Route
                                  path="/locations"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin"]}>
                                      <Locations />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/inventory-transfers"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <InventoryTransfers />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/inventory-adjustments"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <InventoryAdjustments />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/stock-takes"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <StockTakes />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/vendor-portal"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <VendorPortal />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/reports"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager", "supervisor"]}>
                                      <Reports />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route path="/returns" element={<Returns />} />
                                <Route path="/shifts" element={<Shifts />} />
                                <Route path="/loyalty" element={<Loyalty />} />
                                <Route
                                  path="/settings"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin"]}>
                                      <Settings />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/installment-plans"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin", "manager"]}>
                                      <InstallmentPlans />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route
                                  path="/users"
                                  element={
                                    <ProtectedRoute allowedRoles={["admin"]}>
                                      <Users />
                                    </ProtectedRoute>
                                  }
                                />
                                <Route path="*" element={<NotFound />} />
                                </Routes>
                              </div>
                            </main>
                          </SidebarInset>
                        </SidebarProvider>
                      </div>
                    </ProtectedRoute>
                  }
                />
              </Routes>
            </Suspense>
          </AuthProvider>
        </BrowserRouter>
      </TooltipProvider>
    </QueryClientProvider>
  );
};

export default App;
