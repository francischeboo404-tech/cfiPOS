export interface VscuInitializationRequest {
    tin: string;
    bhId: string;
    dvcId: string;
}

export interface VscuInitializationResponse {
    resultCd: string;
    resultMsg: string;
    data: {
        info: {
            cmcKey: string;
            tin?: string;
            bhId?: string;
            dvcId?: string;
            mgrNm?: string;
            taxprNm?: string;
            bsnsActv?: string;
        };
    };
}

export interface VscuSalesItem {
    itemSeq: number;
    itemCd: string;
    itemNm: string;
    pkgUnitCd: string;
    qtyUnitCd: string;
    qty: number;
    prc: number;
    splyAmt: number;
    dcRt: number;
    dcAmt: number;
    taxTyCd: string;
    taxblAmt: number;
    taxAmt: number;
    totAmt: number;
}

export interface VscuSalesSaveRequest {
    [key: string]: string | number | VscuSalesItem[] | undefined;
    tin: string;
    bhId: string;
    dvcId: string;
    invcNo: number;
    orgnInvcNo: number;
    custTin: string;
    custNm: string;
    salesSttsCd: "02" | "03" | "04" | "01";
    rcptTyCd: "1" | "2";
    pmtTyCd: string;
    lptnDt: string;
    totItemCnt: number;
    taxblAmtA?: number;
    taxAmtA?: number;
    taxblAmtB?: number;
    taxAmtB?: number;
    taxblAmtC?: number;
    taxAmtC?: number;
    taxblAmtD?: number;
    taxAmtD?: number;
    taxblAmtE?: number;
    taxAmtE?: number;
    totTaxblAmt: number;
    totTaxAmt: number;
    totAmt: number;
    itemList: VscuSalesItem[];
}

export interface VscuSalesSaveResponse {
    resultCd: string;
    resultMsg: string;
    data: {
        rcptNo: string;
        intrLnk: string;
        rcptSign: string;
        totInvcNo: number;
        vsdcRcptPbctDt: string;
    };
}

const VSCU_INITIALIZATION_PATH = "/api/v1/init/selectInitInfo";
const VSCU_SALES_SAVE_PATH = "/api/v1/sales/saveTrnsSalesOsd";

export class EtimsVscuClient {
    private readonly baseUrl: URL;
    private cmcKey: string | null = null;

    constructor(
        baseUrl: string,
        private readonly fetchImpl: typeof fetch = fetch,
        private readonly timeoutMs = 15_000,
    ) {
        let parsedUrl: URL;
        try {
            parsedUrl = new URL(baseUrl);
        } catch {
            throw new Error("ETIMS_VSCU_BASE_URL must be a valid HTTP(S) URL.");
        }

        if (
            (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") ||
            parsedUrl.username ||
            parsedUrl.password ||
            parsedUrl.search ||
            parsedUrl.hash ||
            (parsedUrl.pathname !== "/" && parsedUrl.pathname !== "")
        ) {
            throw new Error("ETIMS_VSCU_BASE_URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
        }
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
            throw new Error("VSCU request timeout must be a positive safe integer.");
        }

        this.baseUrl = parsedUrl;
    }

    async initializeDevice(request: VscuInitializationRequest): Promise<VscuInitializationResponse> {
        this.cmcKey = null;
        const response = await this.postJson<VscuInitializationResponse>(
            VSCU_INITIALIZATION_PATH,
            request,
            "VSCU initialization",
        );
        if (!response || typeof response !== "object" || Array.isArray(response)) {
            throw new Error("VSCU returned an invalid initialization response object.");
        }
        if (response.resultCd !== "000") {
            throw this.businessError("initialization", response.resultCd, response.resultMsg);
        }

        const info = response.data?.info;
        if (
            !info ||
            typeof info.cmcKey !== "string" ||
            !info.cmcKey.trim()
        ) {
            throw new Error("VSCU returned a success code with incomplete initialization data.");
        }

        this.cmcKey = info.cmcKey;
        return response;
    }

    async saveSales(request: VscuSalesSaveRequest): Promise<VscuSalesSaveResponse> {
        if (!this.cmcKey) {
            throw new Error("VSCU device must be initialized before submitting fiscal transactions.");
        }
        if (request.rcptTyCd !== "1" && request.rcptTyCd !== "2") {
            throw new Error("VSCU receipt type must be '1' (sale) or '2' (proforma).");
        }

        const response = await this.postJson<VscuSalesSaveResponse>(
            VSCU_SALES_SAVE_PATH,
            request,
            "VSCU sales request",
            this.cmcKey,
        );
        if (!response || typeof response !== "object" || Array.isArray(response)) {
            throw new Error("VSCU returned an invalid sales response object.");
        }
        if (response.resultCd !== "000") {
            throw this.businessError("sales request", response.resultCd, response.resultMsg);
        }

        const data = response.data;
        if (
            !data ||
            typeof data.rcptNo !== "string" ||
            !data.rcptNo ||
            typeof data.intrLnk !== "string" ||
            !data.intrLnk ||
            typeof data.rcptSign !== "string" ||
            !data.rcptSign ||
            !Number.isSafeInteger(data.totInvcNo) ||
            typeof data.vsdcRcptPbctDt !== "string" ||
            !data.vsdcRcptPbctDt ||
            typeof response.resultMsg !== "string"
        ) {
            throw new Error("VSCU returned a success code with an incomplete sales receipt.");
        }

        return response;
    }

    private businessError(operation: string, code: unknown, message: unknown): Error {
        const resultCode = typeof code === "string" ? code : "unknown";
        const resultMessage = typeof message === "string" ? message : "No result message";
        return new Error(`VSCU rejected the ${operation} (${resultCode}): ${resultMessage}`);
    }

    private async postJson<T>(
        path: string,
        body: unknown,
        operation: string,
        communicationKey?: string,
    ): Promise<T> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
        const headers: Record<string, string> = {
            "Content-Type": "application/json",
            Accept: "application/json",
        };
        if (communicationKey) headers.cmcKey = communicationKey;

        let response: Response;
        let responseBody: unknown;
        try {
            response = await this.fetchImpl(new URL(path, this.baseUrl), {
                method: "POST",
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            responseBody = await response.json();
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error(`${operation} timed out after ${this.timeoutMs} ms.`);
            }
            if (error instanceof SyntaxError) {
                throw new Error("VSCU returned an invalid JSON response.");
            }
            throw new Error(
                `${operation} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            throw new Error(`${operation} failed with HTTP ${response.status}.`);
        }
        return responseBody as T;
    }
}
