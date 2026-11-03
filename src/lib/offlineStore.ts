export interface CachedPosProduct {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  retail_price: number | string;
  tax_rate?: number | string | null;
  tax_class?: { rate: number | string } | null;
  stock_on_hand: number | string;
  unit_of_measure?: string;
  category?: string;
}

export interface OfflineSalePayload {
  items: Array<{ product_id: string; quantity: number }>;
  payment_method: "cash";
  cash_amount: number | string;
  idempotency_key: string;
  expected_total_amount: number | string;
  offline_created_at: string;
  warehouse_id?: string;
}

export type OfflineSaleStatus = "pending" | "syncing" | "conflict" | "synced";

export interface OfflineSaleRecord {
  id: string;
  userId: string;
  payload: OfflineSalePayload;
  capturedAt: string;
  expectedTotal: number | string;
  items: Array<{ productId: string; name: string; sku: string; quantity: number; unitPrice: number | string }>;
  status: OfflineSaleStatus;
  attempts: number;
  lastError?: string;
  serverSaleId?: string;
  syncedAt?: string;
}

interface CachedCatalog {
  key: string;
  userId: string;
  warehouseId: string;
  savedAt: string;
  products: CachedPosProduct[];
}

const DATABASE_NAME = "cfi-pos-offline";
const DATABASE_VERSION = 1;
const CATALOG_STORE = "catalogs";
const SALES_STORE = "offline-sales";

let databasePromise: Promise<IDBDatabase> | null = null;

const openDatabase = (): Promise<IDBDatabase> => {
  if (!("indexedDB" in globalThis)) {
    return Promise.reject(new Error("Offline storage is not available in this browser."));
  }

  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(CATALOG_STORE)) {
          database.createObjectStore(CATALOG_STORE, { keyPath: "key" });
        }
        if (!database.objectStoreNames.contains(SALES_STORE)) {
          const sales = database.createObjectStore(SALES_STORE, { keyPath: "id" });
          sales.createIndex("userId", "userId");
          sales.createIndex("capturedAt", "capturedAt");
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        databasePromise = null;
        reject(request.error ?? new Error("Unable to open offline storage."));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error("Offline storage is blocked by another open app tab."));
      };
    });
  }

  return databasePromise;
};

const withStore = async <T>(
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> => {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode);
    const request = action(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Offline storage request failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Offline storage transaction aborted."));
  });
};

const catalogKey = (userId: string, warehouseId: string) =>
  `${userId}:${warehouseId || "default"}`;

export const saveCachedCatalog = async (
  userId: string,
  warehouseId: string,
  products: CachedPosProduct[],
): Promise<void> => {
  const catalog: CachedCatalog = {
    key: catalogKey(userId, warehouseId),
    userId,
    warehouseId,
    savedAt: new Date().toISOString(),
    products,
  };
  await withStore(CATALOG_STORE, "readwrite", (store) => store.put(catalog));
};

export const readCachedCatalog = async (
  userId: string,
  warehouseId: string,
): Promise<CachedCatalog | undefined> =>
  withStore<CachedCatalog | undefined>(CATALOG_STORE, "readonly", (store) =>
    store.get(catalogKey(userId, warehouseId)),
  );

export const enqueueOfflineSale = async (
  record: OfflineSaleRecord,
): Promise<void> => {
  await withStore(SALES_STORE, "readwrite", (store) => store.add(record));
};

export const readOfflineSales = async (userId: string): Promise<OfflineSaleRecord[]> => {
  const records = await withStore<OfflineSaleRecord[]>(SALES_STORE, "readonly", (store) =>
    store.index("userId").getAll(userId),
  );
  return records.sort((left, right) => left.capturedAt.localeCompare(right.capturedAt));
};

export const saveOfflineSale = async (record: OfflineSaleRecord): Promise<void> => {
  await withStore(SALES_STORE, "readwrite", (store) => store.put(record));
};

export const removeOfflineSale = async (id: string): Promise<void> => {
  await withStore(SALES_STORE, "readwrite", (store) => store.delete(id));
};
