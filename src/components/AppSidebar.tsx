import {
  Home,
  ShoppingCart,
  Users,
  Settings,
  LogOut,
  TruckIcon,
  BarChart3,
  Receipt,
  History,
  RotateCcw,
  Clock,
  Wallet,
  Award,
  Smartphone,
  Package,
  FileText,
  Tag,
  CreditCard,
} from "lucide-react";
import { NavLink } from "react-router-dom";
import {
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
} from "@/components/ui/sidebar";
import { useSidebar } from "@/components/ui/sidebar-context";
import { useAuth } from "@/hooks/useAuthContext";
import { Button } from "./ui/button";
import { CompanyBrand } from "@/components/CompanyBranding";

export function AppSidebar() {
  const { userRole, signOut } = useAuth();
  const { isMobile, setOpenMobile } = useSidebar();

  const navSections = [
    {
      title: "Overview",
      items: [
        {
          title: "Dashboard",
          url: "/dashboard",
          icon: Home,
          roles: ["admin", "manager", "supervisor", "cashier"],
        },
      ],
    },
    {
      title: "Sales & Checkout",
      items: [
        {
          title: "Shift Register",
          url: "/shifts",
          icon: Clock,
          roles: ["admin", "manager", "supervisor", "cashier"],
        },
        {
          title: "POS Checkout",
          url: "/sales",
          icon: ShoppingCart,
          roles: ["admin", "manager", "supervisor", "cashier"],
        },
        {
          title: "Mobile POS",
          url: "/mobile-cashier",
          icon: Smartphone,
          roles: ["admin", "manager", "supervisor", "cashier"],
        },
        {
          title: "Invoices",
          url: "/invoices",
          icon: Receipt,
          roles: ["admin", "manager", "supervisor"],
        },
        {
          title: "Returns",
          url: "/returns",
          icon: RotateCcw,
          roles: ["admin", "manager", "supervisor", "cashier"],
        },
        {
          title: "Customers",
          url: "/customers",
          icon: Users,
          roles: ["admin", "manager", "supervisor", "cashier"],
        },
        {
          title: "Loyalty",
          url: "/loyalty",
          icon: Award,
          roles: ["admin", "manager", "supervisor", "cashier"],
        },
      ],
    },
    {
      title: "Inventory & Procurement",
      items: [
        {
          title: "Products",
          url: "/products",
          icon: Package,
          roles: ["admin", "manager"],
        },
        {
          title: "Promotions",
          url: "/promotions",
          icon: Tag,
          roles: ["admin", "manager"],
        },
        {
          title: "Inventory Operations",
          url: "/inventory-operations",
          icon: History,
          roles: ["admin", "manager", "supervisor"],
        },
        {
          title: "Purchase Orders",
          url: "/purchase-orders",
          icon: TruckIcon,
          roles: ["admin", "manager"],
        },
        {
          title: "Suppliers",
          url: "/vendors",
          icon: TruckIcon,
          roles: ["admin", "manager"],
        },
        {
          title: "Vendor Portal",
          url: "/vendor-portal",
          icon: FileText,
          roles: ["admin", "manager"],
        },
      ],
    },
    {
      title: "Finance & Reporting",
      items: [
        {
          title: "Receivables",
          url: "/accounts-receivable",
          icon: Wallet,
          roles: ["admin", "manager"],
        },
        {
          title: "Business Reports",
          url: "/reports",
          icon: BarChart3,
          roles: ["admin", "manager", "supervisor"],
        },
      ],
    },
    {
      title: "Administration",
      items: [
        {
          title: "Users",
          url: "/users",
          icon: Users,
          roles: ["admin"],
        },
        {
          title: "Settings",
          url: "/settings",
          icon: Settings,
          roles: ["admin"],
        },
        {
          title: "Installment Plans",
          url: "/installment-plans",
          icon: CreditCard,
          roles: ["admin", "manager"],
        },
      ],
    },
  ];

  const visibleSections = navSections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        item.roles.includes(userRole || ""),
      ),
    }))
    .filter((section) => section.items.length > 0);

  return (
    <Sidebar
      side="left"
      collapsible="icon"
      role="navigation"
      aria-label="Main navigation"
    >
      <SidebarHeader className="border-b border-sidebar-border p-4">
        <div className="flex min-w-0 items-center gap-3">
          <CompanyBrand
            className="gap-3"
            imageClassName="h-9 w-9"
            nameClassName="text-sm font-semibold text-sidebar-foreground group-data-[collapsible=icon]:hidden"
            subtitle={`${userRole} workspace`}
            subtitleClassName="capitalize text-sidebar-foreground/65 group-data-[collapsible=icon]:hidden"
          />
        </div>
      </SidebarHeader>
      <SidebarContent>
        {visibleSections.map((section) => (
          <SidebarGroup key={section.title}>
            <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {section.items.map((item) => (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton asChild>
                      <NavLink
                        to={item.url}
                        end
                        onClick={() => {
                          if (isMobile) setOpenMobile(false);
                        }}
                        className={({ isActive }) =>
                          isActive
                            ? "bg-sidebar-accent text-sidebar-accent-foreground"
                            : ""
                        }
                      >
                        <item.icon className="h-4 w-4" />
                        <span>{item.title}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <Button
          variant="ghost"
          className="w-full justify-start text-sidebar-foreground group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
          onClick={signOut}
        >
          <LogOut className="h-4 w-4 mr-2 group-data-[collapsible=icon]:mr-0" />
          <span className="group-data-[collapsible=icon]:hidden">Logout</span>
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
