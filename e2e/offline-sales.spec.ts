import { expect, test } from "@playwright/test";

test("defaults the POS to the main warehouse for opening stock", async ({ page }) => {
  test.setTimeout(60_000);
  const requestedWarehouseIds: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "main-warehouse-e2e-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "main-warehouse-cashier",
          email: "cashier@example.test",
          role: "cashier",
        }),
      });
      return;
    }

    if (pathname.endsWith("/api/health")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "warehouse-other", name: "Other Warehouse", is_main: false },
          { id: "warehouse-main", name: "Main Warehouse", is_main: true },
        ]),
      });
      return;
    }

    if (pathname.endsWith("/products")) {
      const warehouseId = searchParams.get("warehouse_id") ?? "";
      requestedWarehouseIds.push(warehouseId);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "main-stock-product",
          sku: "MAIN-001",
          barcode: "616100000002",
          name: "Main Warehouse Product",
          retail_price: 100,
          tax_rate: 0,
          stock_on_hand: warehouseId === "warehouse-main" ? 7 : 0,
        }, {
          id: "other-warehouse-product",
          sku: "OTHER-001",
          barcode: null,
          name: "Other Warehouse Product",
          retail_price: 50,
          tax_rate: 0,
          stock_on_hand: 0,
        }]),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/sales", { waitUntil: "domcontentloaded" });
  await expect.poll(() => requestedWarehouseIds, { timeout: 30_000 }).toContain("warehouse-main");
  await expect(page.getByText("Main Warehouse Product", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText("Other Warehouse Product", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Stock: 7", { exact: true })).toBeVisible();
});

test("shows selected warehouse balances including zero-stock products and aggregates all warehouse stock", async ({ page }) => {
  const requestedProductUrls: string[] = [];

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "warehouse-products-e2e-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname, searchParams } = new URL(route.request().url());

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: "warehouse-products-manager",
          email: "manager@example.test",
          role: "admin",
        }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: "warehouse-main", name: "Main Warehouse" },
          { id: "warehouse-east", name: "East Warehouse" },
        ]),
      });
      return;
    }

    if (pathname.endsWith("/products")) {
      requestedProductUrls.push(route.request().url());
      const warehouseId = searchParams.get("warehouse_id");
      const stockByWarehouse: Record<string, number> = {
        "warehouse-main": 12,
        "warehouse-east": 3,
      };
      const products = [
        {
          id: "shared-product",
          sku: "SHARED-001",
          barcode: null,
          name: "Shared Warehouse Product",
          unit_cost: 10,
          retail_price: 18,
          reorder_level: 2,
          stock_on_hand: warehouseId ? stockByWarehouse[warehouseId] ?? 0 : 15,
        },
        {
          id: "main-only-product",
          sku: "MAIN-ONLY-001",
          barcode: null,
          name: "Main Only Product",
          unit_cost: 5,
          retail_price: 10,
          reorder_level: 2,
          stock_on_hand: warehouseId
            ? warehouseId === "warehouse-main" ? 4 : 0
            : 4,
        },
      ];
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(products),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/products", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Shared Warehouse Product", { exact: true })).toBeVisible();
  await expect(page.getByText("15", { exact: true })).toBeVisible();

  const warehouseSelector = page.getByRole("combobox", { name: "Filter products by warehouse" });
  await warehouseSelector.click();
  await page.getByRole("option", { name: "East Warehouse" }).click();
  await expect(page.getByText("3", { exact: true })).toBeVisible();
  const mainOnlyProductRow = page.getByRole("row").filter({ hasText: "Main Only Product" });
  await expect(mainOnlyProductRow).toBeVisible();
  await expect(mainOnlyProductRow.getByRole("cell").nth(5)).toHaveText("0");

  await page.getByRole("combobox", { name: "Filter products by warehouse" }).click();
  await page.getByRole("option", { name: "Main Warehouse" }).click();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  await expect(page.getByText("Main Only Product", { exact: true })).toBeVisible();
  expect(requestedProductUrls.some((url) => new URL(url).searchParams.get("warehouse_id") === "warehouse-east")).toBe(true);
  expect(requestedProductUrls.some((url) => new URL(url).searchParams.get("warehouse_id") === "warehouse-main")).toBe(true);
});

test("captures only provisional cash offline and syncs idempotently when the same cashier reconnects", async ({
  page,
  context,
}) => {
  const offlinePayloads: Record<string, unknown>[] = [];
  let authenticatedUserId = "cashier-offline-e2e";

  await page.addInitScript(() => {
    localStorage.setItem("jwt_token", "offline-e2e-token");
  });

  await page.route("**/api/**", async (route) => {
    const { pathname } = new URL(route.request().url());

    if (pathname.endsWith("/auth/me")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: authenticatedUserId,
          email: "offline@example.test",
          role: "cashier",
        }),
      });
      return;
    }

    if (pathname.endsWith("/api/health")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok" }),
      });
      return;
    }

    if (pathname.endsWith("/warehouses")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{ id: "warehouse-offline", name: "Main Warehouse" }]),
      });
      return;
    }

    if (pathname.endsWith("/products")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([{
          id: "product-offline",
          sku: "OFF-001",
          barcode: "616100000001",
          name: "Offline Test Product",
          retail_price: 100,
          tax_rate: 0,
          tax_class: { rate: 16 },
          stock_on_hand: 5,
        }]),
      });
      return;
    }

    if (pathname.endsWith("/sales") && route.request().method() === "POST") {
      offlinePayloads.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id: "server-sale-offline-e2e" }),
      });
      return;
    }

    if (pathname.endsWith("/sales/server-sale-offline-e2e")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          sale: {
            id: "server-sale-offline-e2e",
            created_at: "2026-10-20T09:00:00.000Z",
            total_amount: "100.00",
            subtotal: "100.00",
            tax_amount: "0.00",
            payment_method: "cash",
            payment_status: "paid",
            cash_amount: "100.00",
            mpesa_amount: null,
            change_amount: "0.00",
            loyalty_discount: null,
            voucher_id: null,
            voucher_points_redeemed: "0",
            voucher_points_earned: "0",
            voucher_balance_after: null,
            voucher_expiry_date: null,
            etims_status: "pending",
            etims_receipt_no: null,
            etims_qr_code: null,
            etims_signature: null,
            items: [{
              quantity: 1,
              unit_price: "100.00",
              line_total: "100.00",
              product: { name: "Offline Test Product", sku: "OFF-001" },
            }],
            customer: null,
            cashier: {
              id: "cashier-offline-e2e",
              email: "offline@example.test",
              profile: { full_name: "Offline Cashier" },
            },
          },
          mpesaTransaction: null,
        }),
      });
      return;
    }

    if (pathname.endsWith("/receipt-settings")) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({}),
      });
      return;
    }

    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });

  await page.goto("/sales", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Offline Test Product", { exact: true })).toBeVisible();

  await context.setOffline(true);
  await expect(page.getByText("Server unavailable - offline POS mode")).toBeVisible();
  await page.getByText("Offline Test Product", { exact: true }).click();
  await page.getByRole("button", { name: /Exact/ }).click();
  await page.getByRole("button", { name: "Complete Sale & Print Receipt" }).click();

  await expect(page.getByTestId("offline-sale-receipt")).toBeVisible();
  await expect(page.getByText("Provisional cash receipt")).toBeVisible();
  await expect(page.getByText("NOT YET SYNCED")).toBeVisible();
  await expect(page.getByText("This offline capture is not fiscalized.")).toBeVisible();
  await expect(page.getByText(/Syncing does not guarantee eTIMS submission/)).toBeVisible();
  await expect(page.getByText(/Fiscal receipt pending.*available shortly after sync/)).toHaveCount(0);
  expect(offlinePayloads).toHaveLength(0);

  await page.getByRole("button", { name: "Done" }).click();
  authenticatedUserId = "another-cashier";
  await context.setOffline(false);
  await expect(page.getByText(/belong to a different cashier/i)).toBeVisible();
  expect(offlinePayloads).toHaveLength(0);

  authenticatedUserId = "cashier-offline-e2e";
  await page.getByRole("button", { name: "Sync" }).click();
  await expect.poll(() => offlinePayloads.length, { timeout: 20_000 }).toBe(1);
  expect(offlinePayloads[0]).toMatchObject({
    payment_method: "cash",
    cash_amount: "100.00",
    expected_total_amount: "100.00",
    items: [{ product_id: "product-offline", quantity: 1 }],
  });
  expect(typeof offlinePayloads[0].offline_created_at).toBe("string");
  expect(String(offlinePayloads[0].idempotency_key)).toMatch(/^offline_/);

  await expect(page.getByText("Accepted by server; fiscal status unconfirmed")).toBeVisible();
  await page.getByRole("button", { name: "View server receipt & fiscal status" }).click();
  await expect(page.getByText("Fiscal receipt pending - do not treat this as a KRA tax invoice")).toBeVisible();
});
