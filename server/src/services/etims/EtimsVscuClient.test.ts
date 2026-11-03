import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { EtimsVscuClient, type VscuSalesSaveRequest } from "./EtimsVscuClient";

const initializationRequest = {
    tin: "A00XXXXXXXXZ",
    bhId: "00",
    dvcId: "VSCU-TEST-001",
};

const initializationResponse = {
    resultCd: "000",
    resultMsg: "SUCCESS",
    data: {
        info: {
            ...initializationRequest,
            cmcKey: "sandbox-communication-key",
            mgrNm: "Test Manager",
            taxprNm: "Test Store",
            bsnsActv: "Wholesale Distribution",
        },
    },
};

const salesRequest: VscuSalesSaveRequest = {
    ...initializationRequest,
    invcNo: 1024,
    orgnInvcNo: 0,
    custTin: "",
    custNm: "Cash Customer",
    salesSttsCd: "02",
    rcptTyCd: "1",
    pmtTyCd: "01",
    lptnDt: "20261020080500",
    totItemCnt: 1,
    taxblAmtA: 1000,
    taxAmtA: 160,
    totTaxblAmt: 1000,
    totTaxAmt: 160,
    totAmt: 1160,
    itemList: [{
        itemSeq: 1,
        itemCd: "KE12345678",
        itemNm: "Bulk Product Box",
        pkgUnitCd: "BOX",
        qtyUnitCd: "U",
        qty: 1,
        prc: 1160,
        splyAmt: 1160,
        dcRt: 0,
        dcAmt: 0,
        taxTyCd: "A",
        taxblAmt: 1000,
        taxAmt: 160,
        totAmt: 1160,
    }],
};

const salesResponse = {
    resultCd: "000",
    resultMsg: "SUCCESS",
    data: {
        rcptNo: "KRAVSCU010000001024",
        intrLnk: "https://kra.go.ke/verify/example",
        rcptSign: "VSCU-SIGNATURE",
        totInvcNo: 1024,
        vsdcRcptPbctDt: "20261020080505",
    },
};

async function withVscu(
    handler: (path: string, headers: import("node:http").IncomingHttpHeaders, body: unknown, response: import("node:http").ServerResponse) => void,
    run: (client: EtimsVscuClient) => Promise<void>,
): Promise<void> {
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            const body = Buffer.concat(chunks).toString("utf8");
            handler(req.url || "", req.headers, body ? JSON.parse(body) : null, res);
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        throw new Error("Test VSCU server did not bind to a TCP port.");
    }

    try {
        await run(new EtimsVscuClient(`http://127.0.0.1:${address.port}`));
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

const respondJson = (res: import("node:http").ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
};

test("EtimsVscuClient initializes the device and stores the returned communication key", async () => {
    await withVscu((path, _headers, body, res) => {
        assert.equal(path, "/api/v1/init/selectInitInfo");
        assert.deepEqual(body, initializationRequest);
        respondJson(res, initializationResponse);
    }, async (client) => {
        assert.deepEqual(await client.initializeDevice(initializationRequest), initializationResponse);
    });
});

test("EtimsVscuClient accepts the minimal initialization envelope containing cmcKey", async () => {
    const response = {
        resultCd: "000",
        resultMsg: "SUCCESS",
        data: { info: { cmcKey: "sandbox-communication-key" } },
    };
    await withVscu((_path, _headers, _body, res) => {
        respondJson(res, response);
    }, async (client) => {
        assert.deepEqual(await client.initializeDevice(initializationRequest), response);
        await assert.rejects(client.saveSales(salesRequest), /incomplete sales receipt/);
    });
});

test("EtimsVscuClient submits the supplied sales contract with the initialized cmcKey", async () => {
    await withVscu((path, headers, body, res) => {
        if (path === "/api/v1/init/selectInitInfo") {
            respondJson(res, initializationResponse);
            return;
        }
        assert.equal(path, "/api/v1/sales/saveTrnsSalesOsd");
        assert.equal(headers.cmckey, "sandbox-communication-key");
        assert.deepEqual(body, salesRequest);
        respondJson(res, salesResponse);
    }, async (client) => {
        await client.initializeDevice(initializationRequest);
        assert.deepEqual(await client.saveSales(salesRequest), salesResponse);
    });
});

test("EtimsVscuClient requires initialization before submitting a transaction", async () => {
    const client = new EtimsVscuClient("http://127.0.0.1");
    await assert.rejects(
        client.saveSales(salesRequest),
        /must be initialized before submitting fiscal transactions/,
    );
});

test("EtimsVscuClient reports initialization and transaction business rejections", async () => {
    await withVscu((path, _headers, _body, res) => {
        respondJson(res, {
            resultCd: path === "/api/v1/init/selectInitInfo" ? "001" : "402",
            resultMsg: "Request rejected",
        });
    }, async (client) => {
        await assert.rejects(
            client.initializeDevice(initializationRequest),
            /VSCU rejected the initialization \(001\): Request rejected/,
        );
    });

    await withVscu((path, _headers, _body, res) => {
        respondJson(res, path === "/api/v1/init/selectInitInfo"
            ? initializationResponse
            : { resultCd: "402", resultMsg: "Mathematical checksum mismatch" });
    }, async (client) => {
        await client.initializeDevice(initializationRequest);
        await assert.rejects(
            client.saveSales(salesRequest),
            /VSCU rejected the sales request \(402\): Mathematical checksum mismatch/,
        );
    });
});

test("EtimsVscuClient rejects incomplete success responses", async () => {
    await withVscu((path, _headers, _body, res) => {
        respondJson(res, path === "/api/v1/init/selectInitInfo"
            ? { ...initializationResponse, data: { info: { cmcKey: "" } } }
            : { resultCd: "000", resultMsg: "SUCCESS", data: {} });
    }, async (client) => {
        await assert.rejects(
            client.initializeDevice(initializationRequest),
            /incomplete initialization data/,
        );
    });

    await withVscu((path, _headers, _body, res) => {
        respondJson(res, path === "/api/v1/init/selectInitInfo"
            ? initializationResponse
            : { resultCd: "000", resultMsg: "SUCCESS", data: {} });
    }, async (client) => {
        await client.initializeDevice(initializationRequest);
        await assert.rejects(client.saveSales(salesRequest), /incomplete sales receipt/);
    });
});

test("EtimsVscuClient rejects HTTP failures and malformed JSON", async () => {
    await withVscu((_path, _headers, _body, res) => {
        respondJson(res, { resultCd: "999", resultMsg: "Unavailable" }, 503);
    }, async (client) => {
        await assert.rejects(
            client.initializeDevice(initializationRequest),
            /VSCU initialization failed with HTTP 503/,
        );
    });

    await withVscu((_path, _headers, _body, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("not json");
    }, async (client) => {
        await assert.rejects(
            client.initializeDevice(initializationRequest),
            /invalid JSON response/,
        );
    });
});

test("EtimsVscuClient enforces its request timeout", async () => {
    const delayedFetch: typeof fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const client = new EtimsVscuClient("http://127.0.0.1", delayedFetch, 5);

    await assert.rejects(
        client.initializeDevice(initializationRequest),
        /VSCU initialization timed out after 5 ms/,
    );
});

test("EtimsVscuClient rejects invalid base URLs", () => {
    assert.throws(() => new EtimsVscuClient("not-a-url"), /valid HTTP\(S\) URL/);
    assert.throws(() => new EtimsVscuClient("ftp://127.0.0.1"), /HTTP\(S\) origin/);
    assert.throws(() => new EtimsVscuClient("******127.0.0.1"), /valid HTTP\(S\) URL/);
    assert.throws(() => new EtimsVscuClient("http://127.0.0.1/vscu"), /HTTP\(S\) origin/);
});
