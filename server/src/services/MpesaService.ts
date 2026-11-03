import { AppDataSource } from "../data-source";
import { MpesaTransaction } from "../entity/MpesaTransaction";
import { Setting } from "../entity/Setting";
import { Sale } from "../entity/Sale";
import { centsToKesString, parseKesToCents } from "../lib/exactMoney";
import { AccountingService } from "./AccountingService";

export const MPESA_RECONCILE_LOCK_ID = 71943003;

export interface StkQueryResult {
    responseCode: string;
    responseDescription?: string;
    merchantRequestId?: string;
    checkoutRequestId?: string;
    resultCode?: number;
    resultDesc?: string;
}

export interface ReconcileStats {
    checked: number;
    reconciledCompleted: number;
    reconciledFailed: number;
    reconciledNeedsReview: number;
}

// Terminal error codes from Safaricom Daraja STK Push / Query
// 1032: Request cancelled by user
// 1037: DS timeout / User cannot be reached
// 1: The balance is insufficient
// 2001: The initiator information is invalid / Wrong PIN
// 1019: Transaction expired
const TERMINAL_RESULT_CODES = new Set([1, 1019, 1032, 1037, 2001]);

export const classifyStkQueryResult = (
    result: StkQueryResult,
    expectedCheckoutRequestId: string,
): "completed" | "failed" | "pending" => {
    if (result.responseCode !== "0" || result.checkoutRequestId !== expectedCheckoutRequestId) {
        return "pending";
    }
    if (result.resultCode === 0) return "completed";
    if (result.resultCode !== undefined && TERMINAL_RESULT_CODES.has(result.resultCode)) return "failed";
    return "pending";
};

export class MpesaService {
    private static customFetch: typeof fetch | null = null;

    static setCustomFetch(fn: typeof fetch | null) {
        this.customFetch = fn;
    }

    private static get fetchFn(): typeof fetch {
        return this.customFetch || fetch;
    }

    /**
     * Authenticates with Safaricom Daraja OAuth and returns an access token.
     */
    static async getDarajaAccessToken(): Promise<string> {
        const consumerKey = process.env.MPESA_CONSUMER_KEY?.trim() || "";
        const consumerSecret = process.env.MPESA_CONSUMER_SECRET?.trim() || "";
        const apiBaseUrl = process.env.MPESA_API_BASE_URL?.trim().replace(/\/+$/, "") || "";

        if (!consumerKey || !consumerSecret || !apiBaseUrl) {
            throw new Error("M-Pesa Daraja credentials or MPESA_API_BASE_URL are not configured");
        }

        const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
        const tokenResponse = await this.fetchFn(`${apiBaseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
            headers: { Authorization: `Basic ${auth}` },
        });

        if (!tokenResponse.ok) {
            throw new Error(`Failed to authenticate with M-Pesa (HTTP ${tokenResponse.status})`);
        }

        const tokenData = await tokenResponse.json() as { access_token?: string };
        if (!tokenData.access_token) {
            throw new Error("M-Pesa did not return an access token");
        }

        return tokenData.access_token;
    }

    /**
     * Queries the status of an STK push transaction using Daraja STK Push Query API.
     */
    static async queryStkPushStatus(
        checkoutRequestId: string,
        options?: { shortcode?: string; passkey?: string; apiBaseUrl?: string; accessToken?: string },
    ): Promise<StkQueryResult> {
        let shortcode = options?.shortcode;
        if (!shortcode && AppDataSource.isInitialized) {
            try {
                const settingRepo = AppDataSource.getRepository(Setting);
                const [shortcodeSetting, legacyTillSetting, paybillSetting, accountTypeSetting] = await Promise.all([
                    settingRepo.findOneBy({ key: "mpesa_shortcode" }),
                    settingRepo.findOneBy({ key: "mpesa_till_number" }),
                    settingRepo.findOneBy({ key: "mpesa_paybill" }),
                    settingRepo.findOneBy({ key: "mpesa_stk_account_type" }),
                ]);
                const accountType = accountTypeSetting?.value?.trim().toLowerCase();
                // For paybill accounts the STK shortcode is stored under mpesa_paybill.
                shortcode = accountType === "paybill"
                    ? paybillSetting?.value?.trim() || shortcodeSetting?.value?.trim() || legacyTillSetting?.value?.trim() || ""
                    : shortcodeSetting?.value?.trim() || legacyTillSetting?.value?.trim() || "";
            } catch {
                shortcode = "";
            }
        }
        shortcode = shortcode || "";
        const passkey = options?.passkey || process.env.MPESA_PASSKEY?.trim() || "";
        const apiBaseUrl = (options?.apiBaseUrl || process.env.MPESA_API_BASE_URL?.trim() || "").replace(/\/+$/, "");

        if (!shortcode || !passkey || !apiBaseUrl) {
            throw new Error("Missing M-Pesa shortcode, passkey, or API base URL for STK push query");
        }

        const accessToken = options?.accessToken || await this.getDarajaAccessToken();
        const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
        const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString("base64");

        const queryResponse = await this.fetchFn(`${apiBaseUrl}/mpesa/stkpushquery/v1/query`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                BusinessShortCode: shortcode,
                Password: password,
                Timestamp: timestamp,
                CheckoutRequestID: checkoutRequestId,
            }),
        });

        if (!queryResponse.ok) {
            throw new Error(`M-Pesa STK query failed (HTTP ${queryResponse.status})`);
        }
        const responseBody: unknown = await queryResponse.json();
        if (!responseBody || typeof responseBody !== "object" || Array.isArray(responseBody)) {
            throw new Error("M-Pesa STK query returned an invalid response");
        }
        const data = responseBody as Record<string, unknown>;
        const responseCode = String(data.ResponseCode ?? "");
        const rawResultCode = data.ResultCode;
        const resultCode = rawResultCode !== undefined && rawResultCode !== null && Number.isInteger(Number(rawResultCode))
            ? Number(rawResultCode)
            : undefined;

        return {
            responseCode,
            responseDescription: typeof data.ResponseDescription === "string" ? data.ResponseDescription : undefined,
            merchantRequestId: typeof data.MerchantRequestID === "string" ? data.MerchantRequestID : undefined,
            checkoutRequestId: typeof data.CheckoutRequestID === "string" ? data.CheckoutRequestID : undefined,
            resultCode,
            resultDesc: typeof data.ResultDesc === "string" ? data.ResultDesc : (typeof data.errorMessage === "string" ? data.errorMessage : undefined),
        };
    }

    /**
     * Reconciles lost-callback M-Pesa STK transactions via PostgreSQL advisory lock.
     */
    static async reconcilePendingTransactions(options?: {
        queryTimeoutMinutes?: number;
        maxAgeMinutes?: number;
    }): Promise<ReconcileStats> {
        const stats: ReconcileStats = {
            checked: 0,
            reconciledCompleted: 0,
            reconciledFailed: 0,
            reconciledNeedsReview: 0,
        };

        const queryTimeoutMinutes = options?.queryTimeoutMinutes ??
            Math.max(1, parseInt(process.env.MPESA_PENDING_QUERY_TIMEOUT_MINUTES || "2", 10) || 2);
        const maxAgeMinutes = options?.maxAgeMinutes ??
            Math.max(queryTimeoutMinutes, parseInt(process.env.MPESA_PENDING_MAX_AGE_MINUTES || "15", 10) || 15);

        const queryRunner = AppDataSource.createQueryRunner();
        await queryRunner.connect();
        let lockAcquired = false;

        try {
            const lockResult = await queryRunner.query(
                "SELECT pg_try_advisory_lock($1) AS acquired",
                [MPESA_RECONCILE_LOCK_ID],
            ) as Array<{ acquired: boolean }>;
            lockAcquired = lockResult[0]?.acquired === true;

            if (!lockAcquired) {
                console.log("M-Pesa reconciliation is already running on another instance.");
                return stats;
            }

            const now = Date.now();
            const minPendingThreshold = new Date(now - queryTimeoutMinutes * 60 * 1000);
            const maxAgeThreshold = new Date(now - maxAgeMinutes * 60 * 1000);

            // Fetch pending transactions with checkout_request_id older than minPendingThreshold
            const pendingTransactions = await queryRunner.manager.createQueryBuilder(MpesaTransaction, "tx")
                .where("tx.status = :status", { status: "pending" })
                .andWhere("tx.created_at <= :threshold", { threshold: minPendingThreshold })
                .orderBy("tx.created_at", "ASC")
                .take(50)
                .getMany();

            stats.checked = pendingTransactions.length;
            if (pendingTransactions.length === 0) {
                return stats;
            }

            // Obtain access token once for the reconciliation batch
            let accessToken: string | null = null;
            try {
                accessToken = await this.getDarajaAccessToken();
            } catch (authError) {
                console.warn("Could not authenticate with Daraja for reconciliation; checking timeout expiry only:", authError);
            }

            for (const tx of pendingTransactions) {
                const txRunner = AppDataSource.createQueryRunner();
                await txRunner.connect();
                await txRunner.startTransaction();

                try {
                    const lockedTx = await txRunner.manager.findOne(MpesaTransaction, {
                        where: { id: tx.id },
                        lock: { mode: "pessimistic_write" },
                    });

                    if (!lockedTx || lockedTx.status !== "pending") {
                        await txRunner.rollbackTransaction();
                        continue;
                    }

                    const isExceededMaxAge = new Date(lockedTx.created_at).getTime() <= maxAgeThreshold.getTime();

                    let queryResult: StkQueryResult | null = null;
                    if (accessToken && lockedTx.checkout_request_id) {
                        try {
                            queryResult = await this.queryStkPushStatus(lockedTx.checkout_request_id, { accessToken });
                        } catch (queryError) {
                            console.warn(`STK query failed for transaction ${lockedTx.transaction_code}:`, queryError);
                        }
                    }

                    const queryOutcome = queryResult && lockedTx.checkout_request_id
                        ? classifyStkQueryResult(queryResult, lockedTx.checkout_request_id)
                        : "pending";

                    if (queryResult && queryOutcome === "completed") {
                        // Confirmed success!
                        lockedTx.status = "completed";
                        lockedTx.result_desc = queryResult.resultDesc || "STK query confirmed payment";
                        await txRunner.manager.save(lockedTx);

                        // If linked to an existing sale, update payment amounts
                        if (lockedTx.sale_id) {
                            const sale = await txRunner.manager.findOne(Sale, {
                                where: { id: lockedTx.sale_id },
                                lock: { mode: "pessimistic_write" },
                            });
                            if (sale) {
                                const mpesaAmountCents = parseKesToCents(String(sale.mpesa_amount || 0)) +
                                    parseKesToCents(String(lockedTx.amount));
                                const totalPaidCents = parseKesToCents(String(sale.cash_amount || 0)) +
                                    mpesaAmountCents +
                                    parseKesToCents(String(sale.store_credit_amount || 0));
                                const totalAmountCents = parseKesToCents(String(sale.total_amount));
                                sale.mpesa_amount = Number(centsToKesString(mpesaAmountCents));
                                sale.change_amount = Number(centsToKesString(
                                    totalPaidCents > totalAmountCents ? totalPaidCents - totalAmountCents : 0n,
                                ));
                                sale.payment_status = totalPaidCents >= totalAmountCents ? "paid" : "partially_paid";
                                await txRunner.manager.save(sale);

                                await AccountingService.recordMpesaReceivablePayment(
                                    txRunner.manager,
                                    sale.id,
                                    Number(lockedTx.amount),
                                );
                            }
                        }

                        await txRunner.commitTransaction();
                        stats.reconciledCompleted++;
                        continue;
                    }

                    if (queryResult && queryOutcome === "failed") {
                        // Terminal failure
                        lockedTx.status = "failed";
                        lockedTx.result_desc = queryResult.resultDesc || `M-Pesa STK query failed (ResultCode: ${queryResult.resultCode})`;
                        await txRunner.manager.save(lockedTx);
                        await txRunner.commitTransaction();
                        stats.reconciledFailed++;
                        continue;
                    }

                    if (isExceededMaxAge) {
                        lockedTx.status = "needs_review";
                        lockedTx.mismatch_reason = "No authoritative callback or Daraja query result was received before the reconciliation limit.";
                        lockedTx.result_desc = "M-Pesa payment outcome is unconfirmed; verify it in Safaricom Daraja before resolving.";
                        await txRunner.manager.save(lockedTx);
                        await txRunner.commitTransaction();
                        stats.reconciledNeedsReview++;
                        continue;
                    }

                    // Otherwise still in-flight, leave as pending
                    await txRunner.rollbackTransaction();
                } catch (txError) {
                    await txRunner.rollbackTransaction();
                    console.error(`Error reconciling transaction ${tx.id}:`, txError);
                    throw txError;
                } finally {
                    await txRunner.release();
                }
            }
        } catch (error) {
            console.error("M-Pesa reconciliation cron error:", error);
            throw error;
        } finally {
            if (lockAcquired) {
                try {
                    await queryRunner.query(
                        "SELECT pg_advisory_unlock($1)",
                        [MPESA_RECONCILE_LOCK_ID],
                    );
                } catch (error) {
                    console.error("Could not release M-Pesa reconciliation advisory lock:", error);
                }
            }
            await queryRunner.release();
        }

        return stats;
    }
}
