import { expect, test } from "@playwright/test";

declare global {
  interface Window {
    __grnBlobUrl?: string | null;
  }
}

test("cashier completes OTP login, sees dashboard data, and can log out", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname.endsWith("/auth/login")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ requires_otp: true, otp_token: "e2e-otp-token" }),
      });
      return;
    }

    if (pathname.endsWith("/auth/verify-otp")) {
      const payload = route.request().postDataJSON() as { code?: string };
      if (payload.code !== "123456") {
        await route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ message: "Invalid OTP code" }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          token: "e2e-session-token",
          user: { id: "cashier-e2e", email: "cashier@example.test", role: "cashier" },
        }),
      });
      return;
    }

    if (pathname.endsWith("/dashboard/stats")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          todaySales: 12500,
          todayTransactions: 25,
          lowStockCount: 2,
          totalProducts: 128,
          weeklyTrend: [],
          topProducts: [],
          salesByMethod: [],
          recentTransactions: [],
          totalCustomers: 64,
        }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/auth", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Email Address").fill("cashier@example.test");
  await page.getByLabel("Password").fill("ValidPassword123!");
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page.getByRole("heading", { name: "Security Verification" })).toBeVisible();
  const otpInput = page.getByLabel("OTP Code");
  await expect(otpInput).toHaveAttribute("placeholder", "Enter 6-digit code");
  await expect(otpInput).toHaveAttribute("autocomplete", "one-time-code");
  await expect(otpInput).not.toHaveAttribute("placeholder", /@/);
  await otpInput.fill("000000");
  await page.getByRole("button", { name: "Verify OTP" }).click();
  await expect(page.getByText("Invalid OTP code")).toBeVisible();

  await otpInput.fill("123456");
  await page.getByRole("button", { name: "Verify OTP" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();
  await expect(page.getByText("25 transactions")).toBeVisible();
  await expect(page.getByText("128", { exact: true })).toBeVisible();
  await expect(page.getByText("64 customers")).toBeVisible();

  await page.getByRole("button", { name: "Logout" }).click();
  await expect(page).toHaveURL(/\/auth$/);
  await expect(page.getByRole("button", { name: "Sign In" })).toBeVisible();
});

test("dashboard charts fit a narrow mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-session-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "cashier-e2e", email: "cashier@example.test", role: "cashier" }),
      });
      return;
    }

    if (pathname.endsWith("/dashboard/stats")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          todaySales: 12500,
          todayTransactions: 25,
          lowStockCount: 2,
          totalProducts: 128,
          weeklyTrend: [{ day: "Mon", salesCents: "1250000", transactions: 25 }],
          topProducts: [{ name: "Coffee", revenueCents: "1250000" }],
          salesByMethod: [{ method: "Cash", amountCents: "1250000" }],
          recentTransactions: [],
          totalCustomers: 64,
        }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

  const charts = page.locator('[data-chart^="chart-"]');
  await expect(charts).toHaveCount(3);
  for (const chart of await charts.all()) {
    const bounds = await chart.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(320);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("locations recover automatically after a temporary API outage", async ({ page }) => {
  let warehouseRequests = 0;

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-session-token");
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "cashier-e2e", email: "cashier@example.test", role: "cashier" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      warehouseRequests += 1;
      if (warehouseRequests === 1) {
        await route.abort("failed");
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "warehouse-e2e",
          name: "Main Warehouse",
          location_address: "Headquarters",
          is_main: true,
          is_active: true,
        }]),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/locations", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Main Warehouse" })).toBeVisible({ timeout: 10000 });
  expect(warehouseRequests).toBeGreaterThan(1);
});

test("admin navigation stays on the left at desktop and works as a phone drawer", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-admin-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "admin-e2e", email: "admin@example.test", role: "admin" }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  const widths = [1440, 1024, 768];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    if (width === widths[0]) await page.goto("/locations", { waitUntil: "domcontentloaded" });

    const navigation = page.getByRole("navigation", { name: "Main navigation" });
    await expect(navigation).toBeVisible();
    await expect(navigation.getByRole("link", { name: "Vendor Portal" })).toBeVisible();
    const rail = await page.locator('[data-side="left"]').boundingBox();
    expect(rail).not.toBeNull();
    expect(rail!.x).toBeLessThan(20);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }

  await page.setViewportSize({ width: 320, height: 740 });
  const toggle = page.getByRole("button", { name: "Toggle navigation" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const drawer = page.getByRole("dialog", { name: "Main navigation" });
  await expect(drawer).toBeVisible();
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox).not.toBeNull();
  expect(drawerBox!.x).toBeLessThan(10);
  await drawer.getByRole("link", { name: "Products" }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(drawer).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("mobile POS uses the server promotion and tax total for confirmed cash checkout", async ({ page }) => {
  let checkoutAttempts = 0;
  let reservationAttempts = 0;
  let cashConfirmations = 0;
  let reservationCancellations = 0;
  const checkoutPayloads: {
    cash_amount: string;
    checkout_session_id: string;
    idempotency_key: string;
    warehouse_id: string;
  }[] = [];
  const warehouseProductQueries: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-cashier-token");
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "cashier-e2e", email: "cashier@example.test", role: "cashier" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "warehouse-mobile", name: "Mobile Branch", is_main: true }]),
      });
      return;
    }

    if (pathname.endsWith("/products")) {
      warehouseProductQueries.push(url.searchParams.get("warehouse_id") || "");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "product-e2e",
          name: "Taxable Mobile Product",
          retail_price: 100,
          tax_rate: 0,
          tax_class: { rate: 16 },
          stock_on_hand: 5,
          barcode: null,
        }]),
      });
      return;
    }

    if (pathname.endsWith("/shifts/current")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "shift-e2e" }),
      });
      return;
    }

    if (pathname.endsWith("/sales/checkouts") && route.request().method() === "POST") {
      reservationAttempts += 1;
      const reservation = route.request().postDataJSON() as {
        checkout_session_id: string;
        cash_amount: number;
        items: Array<{ product_id: string; quantity: number }>;
        warehouse_id: string;
      };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          id: reservation.checkout_session_id,
          items: reservation.items,
          warehouse_id: reservation.warehouse_id,
          cash_amount: reservation.cash_amount,
          total_amount: "92.80",
          status: "reserved",
        }),
      });
      return;
    }

    if (pathname.endsWith("/confirm-cash") && route.request().method() === "POST") {
      cashConfirmations += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ cash_amount: "92.80" }),
      });
      return;
    }

    if (pathname.endsWith("/cancel") && route.request().method() === "POST") {
      reservationCancellations += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      return;
    }

    if (pathname.endsWith("/sales") && route.request().method() === "POST") {
      checkoutAttempts += 1;
      checkoutPayloads.push(route.request().postDataJSON() as {
        cash_amount: string;
        checkout_session_id: string;
        idempotency_key: string;
        warehouse_id: string;
      });
      await route.fulfill({
        status: checkoutAttempts <= 2 ? 503 : 201,
        contentType: "application/json",
        body: JSON.stringify(
          checkoutAttempts <= 2
            ? { message: "Temporary checkout failure" }
            : { message: "Sale completed" },
        ),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/mobile-cashier", { waitUntil: "domcontentloaded" });
  await page.getByText("Taxable Mobile Product", { exact: true }).click();
  const reviewButton = page.getByRole("button", { name: "Review Exact Total (1 items)" });
  await reviewButton.click();
  await expect(page.getByText("KES 92.80", { exact: true })).toBeVisible();
  await expect(page.getByText("Exact total ready. Confirm the cash sale to continue.")).toBeVisible();
  expect(checkoutAttempts).toBe(0);
  const checkoutButton = page.getByRole("button", { name: "Confirm Cash Sale (1 items)" });
  await checkoutButton.click();
  await expect(page.getByText("Temporary checkout failure")).toBeVisible();
  await expect(checkoutButton).toBeEnabled();
  const firstAttemptKey = checkoutPayloads[0].idempotency_key;
  await checkoutButton.click();
  await expect.poll(() => checkoutAttempts).toBe(2);
  await expect(page.getByText("Temporary checkout failure").last()).toBeVisible();
  await expect(checkoutButton).toBeEnabled();
  expect(checkoutPayloads[1].idempotency_key).toBe(firstAttemptKey);
  await page.getByRole("button", { name: "Increase Taxable Mobile Product quantity" }).click();
  await page.getByRole("button", { name: "Decrease Taxable Mobile Product quantity" }).click();
  expect(reservationCancellations).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Review Exact Total (1 items)" }).click();
  await page.getByRole("button", { name: "Confirm Cash Sale (1 items)" }).click();
  await expect(page.getByText("Sale completed!")).toBeVisible();

  expect(checkoutAttempts).toBe(3);
  expect(reservationAttempts).toBe(2);
  expect(cashConfirmations).toBe(3);
  expect(firstAttemptKey).toBeTruthy();
  expect(checkoutPayloads[2].idempotency_key).not.toBe(firstAttemptKey);
  expect(checkoutPayloads[2].cash_amount).toBe("92.80");
  expect(checkoutPayloads[2].checkout_session_id).toBeTruthy();
  expect(warehouseProductQueries.length).toBeGreaterThan(0);
  expect(warehouseProductQueries.every((warehouseId) => warehouseId === "warehouse-mobile")).toBe(true);
  expect(checkoutPayloads[2].warehouse_id).toBe("warehouse-mobile");
});

test("mobile POS blocks sales when no active warehouse is available", async ({ page }) => {
  let productRequests = 0;
  let checkoutRequests = 0;

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-cashier-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "cashier-e2e", email: "cashier@example.test", role: "cashier" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    if (pathname.endsWith("/products")) {
      productRequests += 1;
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    if (pathname.endsWith("/sales") && route.request().method() === "POST") {
      checkoutRequests += 1;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/mobile-cashier", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByText("No active branch is available. Contact an administrator before making a sale."),
  ).toBeVisible();
  expect(productRequests).toBe(0);
  expect(checkoutRequests).toBe(0);
});

test("sales refreshes stock for the selected warehouse after checkout", async ({ page }) => {
  const warehouseProductLoads: (string | null)[] = [];

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-cashier-token");
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "cashier-e2e", email: "cashier@example.test", role: "cashier" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "warehouse-e2e", name: "Main Warehouse" }]),
      });
      return;
    }

    if (pathname.endsWith("/products")) {
      warehouseProductLoads.push(url.searchParams.get("warehouse_id"));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "product-e2e",
          name: "Warehouse Stock Product",
          sku: "WSP-1",
          barcode: null,
          retail_price: 100,
          tax_rate: 0,
          stock_on_hand: 5,
        }]),
      });
      return;
    }

    if (pathname.endsWith("/shifts/current")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "shift-e2e" }),
      });
      return;
    }

    if (pathname.endsWith("/sales") && route.request().method() === "POST") {
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "sale-e2e" }),
      });
      return;
    }

    if (pathname.endsWith("/payments/mpesa/config")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ paybill_number: null, paybill_c2b_enabled: false }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/sales", { waitUntil: "domcontentloaded" });
  await page.getByText("Warehouse Stock Product", { exact: true }).first().click();
  await page.getByRole("button", { name: "Exact (100)" }).click();
  await page.getByRole("button", { name: "Complete Sale & Print Receipt" }).click();
  await expect(page.getByText("Sale completed successfully!")).toBeVisible();
  await expect.poll(() => warehouseProductLoads.length).toBeGreaterThanOrEqual(3);

  expect(warehouseProductLoads.at(-1)).toBe("warehouse-e2e");
});

test("sales opens a required shift before completing and renders numeric-string receipt amounts", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-cashier-token");
  });

  let shiftOpen = false;
  let saleRequests = 0;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;
    const method = route.request().method();

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "cashier-e2e", email: "cashier@example.test", role: "cashier" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    if (pathname.endsWith("/customers")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    if (pathname.endsWith("/products")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "product-shift-e2e",
          name: "Shift Required Product",
          sku: "SRP-1",
          barcode: null,
          retail_price: 100,
          tax_rate: 0,
          stock_on_hand: 5,
        }]),
      });
      return;
    }

    if (pathname.endsWith("/shifts/current")) {
      await route.fulfill(shiftOpen
        ? { status: 200, contentType: "application/json", body: JSON.stringify({ id: "shift-e2e" }) }
        : { status: 404, contentType: "application/json", body: JSON.stringify({ message: "No open shift found" }) });
      return;
    }

    if (pathname.endsWith("/payments/mpesa/config")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          paybill_number: null,
          paybill_c2b_enabled: false,
          stk_push_enabled: false,
          stk_push_issues: ["a public HTTPS STK callback URL in Settings"],
        }),
      });
      return;
    }

    if (pathname.endsWith("/shifts/open") && method === "POST") {
      shiftOpen = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "shift-e2e" }),
      });
      return;
    }

    if (pathname.endsWith("/sales") && method === "POST") {
      saleRequests += 1;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "sale-shift-e2e" }),
      });
      return;
    }

    if (pathname.endsWith("/sales/sale-shift-e2e")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sale: {
            id: "sale-shift-e2e",
            created_at: "2026-10-03T12:00:00.000Z",
            total_amount: "100.00",
            subtotal: "100.00",
            tax_amount: "0.00",
            payment_method: "cash",
            payment_status: "paid",
            cash_amount: "100.00",
            mpesa_amount: "0.00",
            change_amount: "0.00",
            loyalty_discount: "0.00",
            items: [{
              quantity: "1",
              unit_price: "100.00",
              line_total: "100.00",
              product: { name: "Shift Required Product", sku: "SRP-1" },
            }],
            customer: null,
            cashier: { id: "cashier-e2e", email: "cashier@example.test", profile: null },
          },
          mpesaTransaction: null,
        }),
      });
      return;
    }

    if (pathname.endsWith("/payments/mpesa/config")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ paybill_number: null, paybill_c2b_enabled: false }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/sales", { waitUntil: "domcontentloaded" });
  await page.getByText("Shift Required Product", { exact: true }).first().click();
  await expect(page.getByRole("alert")).toContainText("STK Push setup is incomplete");
  await expect(page.getByText("a public HTTPS STK callback URL in Settings")).toBeVisible();
  await expect(page.getByRole("button", { name: "Send STK" })).toBeDisabled();
  await page.getByRole("button", { name: "Exact (100)" }).click();
  await page.getByRole("button", { name: "Complete Sale & Print Receipt" }).click();
  await expect(page.getByRole("heading", { name: "Open a cashier shift" })).toBeVisible();
  expect(saleRequests).toBe(0);

  await page.getByLabel("Opening cash float (KSh)").fill("50");
  await page.getByRole("button", { name: "Open Shift" }).click();
  await expect(page.getByText("Shift opened. Complete the sale when ready.")).toBeVisible();
  await page.getByRole("button", { name: "Complete Sale & Print Receipt" }).click();

  await expect(page.getByText("Sale completed successfully!")).toBeVisible();
  await expect(page.getByText("1 x KSh 100.00")).toBeVisible();
  expect(saleRequests).toBe(1);
});

test("sales resumes a parked cart with its saved warehouse and amounts", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-cashier-token");
  });

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "cashier-e2e", email: "cashier@example.test", role: "cashier" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "warehouse-current", name: "Current Branch" },
          { id: "warehouse-saved", name: "Saved Branch" },
        ]),
      });
      return;
    }

    if (pathname.endsWith("/products")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "product-parked",
          name: "Parked Resume Product",
          sku: "PARK-1",
          barcode: null,
          retail_price: 120,
          tax_rate: 0,
          stock_on_hand: 8,
        }]),
      });
      return;
    }

    if (pathname.endsWith("/sales/parked")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "parked-sale-e2e",
          created_at: "2026-10-03T10:00:00.000Z",
          customer: null,
          warehouse: { id: "warehouse-saved", name: "Saved Branch" },
          loyalty_discount: 20,
          items: [{
            quantity: 2,
            unit_price: 100,
            tax_rate: 16,
            line_total: 200,
            product: {
              id: "product-parked",
              name: "Parked Resume Product",
              sku: "PARK-1",
              barcode: null,
              retail_price: 120,
              tax_rate: 0,
              stock_on_hand: 8,
            },
          }],
        }]),
      });
      return;
    }

    if (pathname.endsWith("/payments/mpesa/config")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ paybill_number: null, paybill_c2b_enabled: false }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/sales", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Saved Sales" }).click();
  await expect(page.getByRole("heading", { name: "Parked Sales" })).toBeVisible();
  await page.getByRole("button", { name: "Resume" }).click();

  await expect(page.getByText("Parked sale loaded")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Parked Sales" })).not.toBeVisible();
  await expect(page.getByText("Parked Resume Product", { exact: true })).toHaveCount(2);
  await expect(page.getByText("KES 212", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("combobox").first()).toContainText("Saved Branch");
});

test("cash-only reserved checkout can be released after refreshing the POS", async ({ page }) => {
  const checkoutSessionId = "123e4567-e89b-42d3-a456-426614174000";
  let cancelRequests = 0;

  await page.addInitScript((sessionId) => {
    localStorage.setItem("jwt_token", "e2e-cashier-token");
    localStorage.setItem("pos-checkout-session:cashier-e2e", sessionId);
    localStorage.setItem("pos-checkout-payment:cashier-e2e", JSON.stringify({
      cashAmount: 100,
      mpesaAmount: 0,
      storeCreditAmount: 0,
      storeCreditBarcode: null,
      mpesaTransactionIds: [],
    }));
  }, checkoutSessionId);

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const { pathname } = url;

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "cashier-e2e", email: "cashier@example.test", role: "cashier" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "warehouse-e2e", name: "Main Warehouse" }]),
      });
      return;
    }

    if (pathname.endsWith("/products")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "product-e2e",
          name: "Available Product",
          sku: "AVAILABLE-1",
          barcode: null,
          retail_price: 100,
          tax_rate: 0,
          stock_on_hand: 5,
        }]),
      });
      return;
    }

    if (pathname.endsWith(`/sales/checkouts/${checkoutSessionId}`)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: checkoutSessionId,
          status: "reserved",
          warehouse_id: "warehouse-e2e",
          customer_id: null,
          loyalty_discount: 0,
          items: [{
            product_id: "product-e2e",
            quantity: 1,
            unit_price: 100,
            tax_rate: 0,
            sku: "AVAILABLE-1",
            barcode: null,
            name: "Available Product",
          }],
          mpesa_transactions: [],
          total_amount: 100,
          cash_amount: 100,
          store_credit_amount: 0,
          store_credit_barcode: null,
        }),
      });
      return;
    }

    if (pathname.endsWith(`/sales/checkouts/${checkoutSessionId}/cancel`)) {
      cancelRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true }),
      });
      return;
    }

    if (pathname.endsWith("/payments/mpesa/config")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ paybill_number: null, paybill_c2b_enabled: false }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/sales", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Cash Paid:")).toBeVisible();
  const releaseButton = page.getByRole("button", { name: "Release Reserved Stock" });
  await expect(releaseButton).toBeVisible();
  await releaseButton.click();
  await expect.poll(() => cancelRequests).toBe(1);
  await expect(page.getByText("Available Product", { exact: true }).first()).toBeEnabled();
  await page.getByText("Available Product", { exact: true }).first().click();
  await expect(page.getByText("1 items", { exact: true })).toBeVisible();
});

test("return sale search uses invoice numbers and displays server-approved returnable sales", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-admin-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "admin-e2e", email: "admin@example.test", role: "admin" }),
      });
      return;
    }

    if (pathname.endsWith("/returns")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    if (pathname.endsWith("/returns/search")) {
      expect(new URL(route.request().url()).searchParams.get("invoice_number")).toBe("INV-GOOD123");
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "sale-good-12345678",
          invoice_number: "INV-GOOD123",
          status: "completed",
          payment_status: "paid",
          total_amount: 100,
          created_at: "2026-10-03T09:00:00.000Z",
          payment_method: "cash",
          items: [{ id: "item-returnable", quantity: 1, unit_price: 100, tax_rate: 0, product: { name: "Returnable item" } }],
        }]),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/returns", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Request Return" }).click();
  const saleSearch = page.getByPlaceholder("Enter invoice number...");
  await saleSearch.fill("INV-GOOD123");
  await saleSearch.press("Enter");
  await expect(page.getByText("INV-GOOD123", { exact: true })).toBeVisible();
  await page.getByText("INV-GOOD123", { exact: true }).click();
  await expect(page.getByText("Returnable item")).toBeVisible();
});

test("new purchase orders submit an explicit receiving warehouse", async ({ page }) => {
  let submittedOrder: { warehouse_id?: string } | null = null;

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-admin-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "admin-e2e", email: "admin@example.test", role: "admin" }),
      });
      return;
    }

    if (pathname.endsWith("/vendors")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "vendor-e2e", name: "Local Supplier" }]),
      });
      return;
    }

    if (pathname.endsWith("/products")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "product-e2e", name: "Stock Item", unit_cost: 12 }]),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "warehouse-e2e", name: "Main Warehouse", is_main: true, is_active: true }]),
      });
      return;
    }

    if (pathname.endsWith("/purchase-orders") && route.request().method() === "POST") {
      submittedOrder = route.request().postDataJSON() as { warehouse_id?: string };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "po-e2e" }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/purchase-orders/new", { waitUntil: "domcontentloaded" });
  const selectors = page.getByRole("combobox");
  await selectors.nth(0).click();
  await page.getByRole("option", { name: "Local Supplier" }).click();
  await selectors.nth(1).click();
  await page.getByRole("option", { name: "Main Warehouse (Main)" }).click();
  await selectors.nth(2).click();
  await page.getByRole("option", { name: "Stock Item" }).click();
  await page.getByLabel("Quantity").fill("3");
  await page.getByRole("button", { name: "Create Purchase Order" }).click();

  await expect(page).toHaveURL(/\/purchase-orders$/);
  expect(submittedOrder?.warehouse_id).toBe("warehouse-e2e");
});

test("purchase order list retries failed requests and shows its empty state", async ({ page }) => {
  let purchaseOrderRequests = 0;

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-admin-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "admin-e2e", email: "admin@example.test", role: "admin" }),
      });
      return;
    }

    if (pathname.endsWith("/purchase-orders")) {
      purchaseOrderRequests += 1;
      if (purchaseOrderRequests === 1) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ message: "Temporary procurement API failure" }),
        });
        return;
      }

      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/purchase-orders", { waitUntil: "domcontentloaded" });
  await expect(page.locator("tbody").getByText("Failed to load purchase orders: Temporary procurement API failure")).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("No purchase orders found")).toBeVisible();
  expect(purchaseOrderRequests).toBe(2);
});

test("delivery notes show receipt details and escape untrusted invoice content", async ({ page }) => {
  const maliciousProductName = "<script>window.__grnPwned=true</script>Product";
  const maliciousVendorName = "<img src=x onerror=window.__grnPwned=true>";
  const maliciousNotes = "<svg onload=window.__grnPwned=true>";

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-admin-token");
    window.__grnBlobUrl = null;
    window.open = ((url?: string | URL) => {
      window.__grnBlobUrl = url?.toString() ?? null;
      return { onload: null, print: () => undefined } as Window;
    }) as typeof window.open;
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "admin-e2e", email: "admin@example.test", role: "admin" }),
      });
      return;
    }

    if (pathname.endsWith("/delivery-notes/grn-e2e")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "grn-e2e",
          grn_number: "GRN-100",
          vendor: { name: maliciousVendorName },
          purchase_order: { po_number: "PO-100" },
          items: [{
            id: "grn-item-e2e",
            ordered_quantity: 5,
            received_quantity: 4,
            rejected_quantity: 1,
            unit_cost: 12,
            line_total: 48,
            product: { name: maliciousProductName, sku: "SKU-100" },
          }],
        }),
      });
      return;
    }

    if (pathname.endsWith("/delivery-notes")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "grn-e2e",
          grn_number: "GRN-100",
          po_id: "po-e2e",
          vendor_id: "vendor-e2e",
          vendor: { name: maliciousVendorName },
          purchase_order: { po_number: "PO-100" },
          total_items: 4,
          total_value: 48,
          notes: maliciousNotes,
          status: "completed",
          created_at: "2026-10-02T00:00:00.000Z",
        }]),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/delivery-notes", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "View GRN GRN-100" }).click();
  const dialog = page.getByRole("dialog", { name: "GRN: GRN-100" });
  await expect(dialog.getByText(maliciousProductName)).toBeVisible();
  await expect(dialog.getByText("4", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1", { exact: true })).toBeVisible();

  await dialog.getByRole("button", { name: "Download GRN Invoice" }).click();
  const generatedHtml = await page.evaluate(async () => {
    const url = window.__grnBlobUrl as string;
    return await (await fetch(url)).text();
  });
  expect(generatedHtml).toContain("&lt;script&gt;window.__grnPwned=true&lt;/script&gt;");
  expect(generatedHtml).toContain("&lt;img src=x onerror=window.__grnPwned=true&gt;");
  expect(generatedHtml).toContain("&lt;svg onload=window.__grnPwned=true&gt;");
});

test("supplier invoice creation links the completed GRN for its purchase order", async ({ page }) => {
  let submittedInvoice: { po_id?: string; delivery_note_id?: string; subtotal?: number } | null = null;

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-admin-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "admin-e2e", email: "admin@example.test", role: "admin" }),
      });
      return;
    }

    if (pathname.endsWith("/vendors")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "vendor-e2e", name: "Local Supplier", payment_terms: "Net 30" }]),
      });
      return;
    }

    if (pathname.endsWith("/purchase-orders")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "po-e2e", po_number: "PO-100", total_amount: 100, vendor_id: "vendor-e2e" }]),
      });
      return;
    }

    if (pathname.endsWith("/delivery-notes")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "grn-e2e",
          grn_number: "GRN-100",
          po_id: "po-e2e",
          vendor_id: "vendor-e2e",
          total_value: 60,
          status: "completed",
        }]),
      });
      return;
    }

    if (pathname.endsWith("/supplier-invoices")) {
      if (route.request().method() === "POST") {
        submittedInvoice = route.request().postDataJSON() as { po_id?: string; delivery_note_id?: string; subtotal?: number };
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({ message: "Invoice processed" }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify([{
            id: "invoice-e2e",
            invoice_number: "INV-LIST-100",
            vendor_id: "vendor-e2e",
            po_id: "po-e2e",
            delivery_note_id: "grn-e2e",
            invoice_date: "2026-10-01",
            due_date: "2026-11-01",
            subtotal: 60,
            tax_amount: 0,
            total_amount: 60,
            paid_amount: 0,
            balance_due: 60,
            status: "matched",
            payment_terms: "Net 30",
            created_at: "2026-10-01T00:00:00.000Z",
            vendor: { name: "Local Supplier" },
            purchase_order: { po_number: "PO-100" },
          }]),
        });
      }
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/supplier-invoices", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("row", { name: /INV-LIST-100 Local Supplier/ })).toBeVisible();
  await page.getByRole("button", { name: "New Invoice" }).click();
  const selectors = page.getByRole("combobox");
  await selectors.nth(1).click();
  await page.getByRole("option", { name: /PO-100/ }).click();
  await page.getByRole("button", { name: "Create Invoice" }).click();

  expect(submittedInvoice).toMatchObject({
    po_id: "po-e2e",
    delivery_note_id: "grn-e2e",
    subtotal: 60,
  });
});

test("new product opening stock is assigned to the selected warehouse", async ({ page }) => {
  let submittedProduct: { warehouse_id?: string; stock_on_hand?: number } | null = null;

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "e2e-admin-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ id: "admin-e2e", email: "admin@example.test", role: "admin" }),
      });
      return;
    }

    if (pathname.endsWith("/taxes")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "tax-e2e", name: "VAT", rate: 16, is_default: true }]),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "warehouse-e2e", name: "Main Warehouse", is_main: true, is_active: true }]),
      });
      return;
    }

    if (pathname.endsWith("/products") && route.request().method() === "POST") {
      submittedProduct = route.request().postDataJSON() as { warehouse_id?: string; stock_on_hand?: number };
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "product-e2e", name: "Opening Stock Item", sku: "OPEN-001", barcode: "OPEN-001", retail_price: 20 }),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/products/new", { waitUntil: "domcontentloaded" });
  await page.getByLabel("Product Name *").fill("Opening Stock Item");
  await page.getByLabel("Parent SKU *").fill("OPEN-001");
  await page.getByLabel("Base Retail Price (KSh) *").fill("20");
  await page.getByLabel("Base Unit Cost (KSh) *").fill("8");
  await page.getByLabel("Initial Stock").fill("7");
  await page.getByLabel("Warehouse").click();
  await page.getByRole("option", { name: "Main Warehouse (Main)" }).click();
  await page.getByRole("button", { name: "Save Product" }).click();

  await expect(page.getByRole("heading", { name: "Product Created" })).toBeVisible();
  expect(submittedProduct).toMatchObject({ warehouse_id: "warehouse-e2e", stock_on_hand: 7 });
});
