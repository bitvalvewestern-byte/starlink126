const express = require("express");
const axios = require("axios");

const router = express.Router();

/* =====================================================================
 * 1. PAYHERO CONFIGURATION  (keys are set directly in this file)
 * ---------------------------------------------------------------------
 *  Replace the three values below with the ones from your PayHero
 *  dashboard (Settings -> API Keys / Channels).
 *
 *  SECURITY NOTE: because these are in the source file, never commit
 *  this file to a public repo, never paste it into a chat/forum, and
 *  never send it to anyone. If a key leaks, rotate it in the PayHero
 *  dashboard. If you later move to a public repo, switch to .env.
 * =================================================================== */
const PAYHERO_API_USERNAME = "CpLRSh1z0fV1PksHNEln";
const PAYHERO_API_PASSWORD = "ZndFVCxmuS7Mtrn7C92R0hO1CtX1bY7xwQhzTw8v";
const PAYHERO_CHANNEL_ID = "9959";

// Optional: PayHero base URL (only change this for testing)
const PAYHERO_BASE_URL = "https://backend.payhero.co.ke/api/v2";

// Public URL PayHero will POST the result to. Leave blank to auto-build it
// from the incoming request host (handy behind ngrok / a proxy).
const PAYHERO_CALLBACK_URL = "";

/* =====================================================================
 * 2. DELIVERY FEES  — the single source of truth for pricing
 *    The client can never choose the amount; it only picks a zone.
 * =================================================================== */
const DELIVERY_FEES = {
    inside: 500, // Inside Nairobi
    outside: 1000 // Outside Nairobi
};

/* =====================================================================
 * 3. TRANSACTION STORE
 * ---------------------------------------------------------------------
 *  Kept in memory so the page can poll for a result.
 *  NOTE: this resets when the server restarts. Swap this Map for your
 *  database (Mongo/MySQL/Postgres) before going live — see the marked
 *  `saveTransaction()` / `findTransaction()` helpers below.
 * =================================================================== */
const transactions = new Map();

function saveTransaction(tx) {
    transactions.set(tx.reference, tx);
    // TODO: await db.collection("payments").updateOne(...) or .insertOne(tx)
    return tx;
}

function findTransaction(reference) {
    if (!reference) return null;
    if (transactions.has(reference)) return transactions.get(reference);

    // Allow lookup by the PayHero CheckoutRequestID or our own external ref too
    for (const tx of transactions.values()) {
        if (
            tx.checkout_request_id === reference ||
            tx.external_reference === reference
        ) {
            return tx;
        }
    }
    return null;
}

/* =====================================================================
 * 4. HELPERS
 * =================================================================== */
function payheroAuth() {
    return {
        username: PAYHERO_API_USERNAME,
        password: PAYHERO_API_PASSWORD
    };
}

// 0712345678 / +254712345678 / 254712345678 -> 0712345678
function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.startsWith("254")) return "0" + digits.slice(3);
    if (digits.startsWith("7") || digits.startsWith("1")) return "0" + digits;
    return digits;
}

function isValidKenyanPhone(phone) {
    return /^0(7|1)\d{8}$/.test(phone);
}

// Server-side amount resolution — never trust the client's amount
function resolveAmount(zone, amountFromClient) {
    if (zone && DELIVERY_FEES[zone] !== undefined) return DELIVERY_FEES[zone];

    const amount = Number(amountFromClient);
    if (amount && Object.values(DELIVERY_FEES).includes(amount)) return amount;

    return null;
}

// PayHero uses several spellings; collapse them into SUCCESS / FAILED / QUEUED
function normalizeStatus(raw) {
    const status = String(raw || "").trim().toUpperCase();
    if (!status) return "QUEUED";

    if (["SUCCESS", "SUCCESSFUL", "COMPLETE", "COMPLETED", "PAID"].includes(status))
        return "SUCCESS";
    if (
        ["FAILED", "FAILURE", "CANCELLED", "CANCELED", "REVERSED", "TIMEOUT", "EXPIRED"].includes(
            status
        )
    )
        return "FAILED";

    return "QUEUED";
}

function callbackUrl(req) {
    if (PAYHERO_CALLBACK_URL) return PAYHERO_CALLBACK_URL;
    const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.headers["x-forwarded-host"] || req.get("host");
    return `${proto}://${host}/api/payhero-callback`;
}

/* =====================================================================
 * 5. POST /api/stk-push  — send the M-Pesa prompt
 * =================================================================== */
router.post("/stk-push", async(req, res) => {
    try {
        const { phone_number, zone, amount, name, address } = req.body || {};

        const phone = normalizePhone(phone_number);
        if (!isValidKenyanPhone(phone)) {
            return res.status(400).json({
                success: false,
                message: "Enter a valid Safaricom number (07XXXXXXXX or 01XXXXXXXX)."
            });
        }

        const chargeAmount = resolveAmount(zone, amount);
        if (!chargeAmount) {
            return res.status(400).json({
                success: false,
                message: "Invalid delivery zone. Allowed: inside (KES 500) or outside (KES 1000)."
            });
        }

        const externalReference = `DLV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

        const payload = {
            amount: chargeAmount,
            phone_number: phone,
            channel_id: PAYHERO_CHANNEL_ID,
            provider: "m-pesa",
            external_reference: externalReference,
            callback_url: callbackUrl(req)
        };
        if (name) payload.customer_name = name;

        const response = await axios.post(`${PAYHERO_BASE_URL}/payments`, payload, {
            auth: payheroAuth(),
            headers: { "Content-Type": "application/json" },
            timeout: 30000
        });

        const data = response.data || {};
        const reference =
            data.reference ||
            data.CheckoutRequestID ||
            data.checkout_request_id ||
            externalReference;

        const tx = saveTransaction({
            reference: String(reference),
            external_reference: externalReference,
            checkout_request_id: data.CheckoutRequestID || data.checkout_request_id || null,
            phone,
            zone: zone && DELIVERY_FEES[zone] !== undefined ? zone : null,
            amount: chargeAmount,
            name: name || null,
            address: address || null,
            status: normalizeStatus(data.status),
            mpesa_receipt: null,
            result_desc: null,
            created_at: new Date().toISOString()
        });

        console.log(
            `[STK] ${tx.reference} | ${tx.zone || "auto"} | KES ${chargeAmount} | ${phone}`
        );

        // Flattened shape so the front end can read data.reference directly
        return res.json({
            success: true,
            message: "STK Push sent successfully",
            reference: tx.reference,
            CheckoutRequestID: tx.checkout_request_id,
            status: tx.status,
            amount: tx.amount,
            zone: tx.zone,
            data
        });
    } catch (error) {
        const errorMessage =
            (error.response && error.response.data && error.response.data.message) ||
            (error.response && error.response.data && error.response.data.error_message) ||
            error.message;

        console.error("STK ERROR:", errorMessage);

        return res.status(error.response ? error.response.status : 500).json({
            success: false,
            message: errorMessage || "Payment initiation failed"
        });
    }
});

/* =====================================================================
 * 6. GET /api/check-status?reference=XXX  — what the page polls
 * =================================================================== */
router.get("/check-status", async(req, res) => {
    const reference = String(req.query.reference || "").trim();

    if (!reference) {
        return res.status(400).json({
            success: false,
            status: "QUEUED",
            message: "reference is required"
        });
    }

    const tx = findTransaction(reference);

    // Already settled locally (usually by the callback) — no need to ask PayHero
    if (tx && (tx.status === "SUCCESS" || tx.status === "FAILED")) {
        return res.json({
            success: true,
            status: tx.status,
            reference: tx.reference,
            amount: tx.amount,
            zone: tx.zone,
            mpesa_receipt: tx.mpesa_receipt,
            result_desc: tx.result_desc
        });
    }

    try {
        const response = await axios.get(`${PAYHERO_BASE_URL}/transaction-status`, {
            params: { reference: tx ? tx.external_reference : reference },
            auth: payheroAuth(),
            headers: { "Content-Type": "application/json" },
            timeout: 30000
        });

        const data = response.data || {};
        const providerTx = data.transaction || data;
        const status = normalizeStatus(providerTx.status || data.status);

        if (tx) {
            tx.status = status;
            if (status === "SUCCESS") {
                tx.mpesa_receipt =
                    providerTx.mpesa_receipt ||
                    providerTx.MpesaReceiptNumber ||
                    tx.mpesa_receipt;
            }
            saveTransaction(tx);
        }

        return res.json({
            success: true,
            status,
            reference: tx ? tx.reference : reference,
            amount: tx ? tx.amount : undefined,
            zone: tx ? tx.zone : undefined,
            mpesa_receipt: tx ? tx.mpesa_receipt : undefined,
            data
        });
    } catch (error) {
        // PayHero returns 404 for a transaction that is still queued — that is
        // not an error for us, the page should simply keep waiting.
        const providerMessage =
            (error.response && error.response.data && error.response.data.message) ||
            error.message;

        console.warn(`[Status] ${reference} -> QUEUED (${providerMessage})`);

        return res.json({
            success: false,
            status: "QUEUED",
            reference,
            amount: tx ? tx.amount : undefined,
            zone: tx ? tx.zone : undefined
        });
    }
});

/* =====================================================================
 * 7. POST /api/payhero-callback  — PayHero pushes the final result here
 *    Payload: { status, response: { CheckoutRequestID, ExternalReference,
 *              ResultCode, ResultDesc, Status, MpesaReceiptNumber, ... } }
 * =================================================================== */
router.post("/payhero-callback", async(req, res) => {
    // Always ACK fast so PayHero does not retry forever
    res.sendStatus(200);

    try {
        const body = req.body || {};
        const result = body.response || body;

        const checkoutId = result.CheckoutRequestID || body.CheckoutRequestID;
        const externalReference =
            result.ExternalReference || body.ExternalReference || body.external_reference;

        const tx = findTransaction(checkoutId) || findTransaction(externalReference);

        /*
         * ResultCode is the authoritative M-Pesa field:
         *   0    = paid
         *   1032 = cancelled by the user
         *   1037 = timed out, 1 = insufficient funds, 2001 = wrong PIN
         * `body.status` is only PayHero's "callback delivered" flag, so it must
         * NOT be treated as proof of payment.
         */
        const rawResultCode = result.ResultCode !== undefined ? result.ResultCode : null;
        const statusWord = String(result.Status || result.status || "");

        let isSuccess;
        if (rawResultCode !== null) {
            isSuccess = String(rawResultCode) === "0";
        } else if (statusWord) {
            isSuccess = /success/i.test(statusWord) && !/fail|cancel/i.test(statusWord);
        } else {
            isSuccess = body.status === true;
        }

        const status = isSuccess ? "SUCCESS" : "FAILED";

        // Guard against a paid amount that does not match what we charged
        if (tx && result.Amount !== undefined && Number(result.Amount) !== Number(tx.amount)) {
            console.warn(
                `[Callback] AMOUNT MISMATCH for ${tx.reference}: expected ${tx.amount}, got ${result.Amount}`
            );
        }

        console.log(
            `[Callback] ${(tx && tx.reference) || checkoutId || externalReference} -> ${status} | ` +
            `ResultCode=${rawResultCode} | ${result.ResultDesc || ""}`
        );

        if (tx) {
            tx.status = status;
            tx.mpesa_receipt = result.MpesaReceiptNumber || tx.mpesa_receipt || null;
            tx.result_desc = result.ResultDesc || null;
            tx.paid_at = new Date().toISOString();
            saveTransaction(tx);
        }

        // TODO: on SUCCESS — mark the order as paid in your database, then
        // trigger fulfilment / send the customer an SMS.
    } catch (error) {
        console.error("[Callback] Processing error:", error.message);
    }
});

/* =====================================================================
 * 8. GET /api/transaction/:reference  — small debug/verification helper
 *    Remove this (or protect it) in production.
 * =================================================================== */
router.get("/transaction/:reference", (req, res) => {
    const tx = findTransaction(req.params.reference);
    if (!tx) return res.status(404).json({ success: false, message: "Not found" });
    return res.json({ success: true, transaction: tx });
});

module.exports = router;
