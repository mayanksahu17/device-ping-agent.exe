// verifone-mock-server.js
// Mock Verifone/UPA terminal over raw TCP with STX LF JSON LF ETX LF framing.
// Supports: Ping, Sale (EMV/MSR/Manual), PreAuth (Lodging), Void, TipAdjust, Refund,
// Partial Approval, Batch Close / EOD.
// -------------------------------------------------------------

const net = require('net');

const LISTEN_PORT = parseInt(process.argv[2] || '8081', 10);
const ECR_ID      = process.argv[3] || '13';

const STX = 0x02, LF = 0x0A, ETX = 0x03;

// --- helpers --------------------------------------------------
const frame = (obj) => {
    const j = Buffer.from(JSON.stringify(obj), 'ascii');
    return Buffer.concat([Buffer.from([STX, LF]), j, Buffer.from([LF, ETX, LF])]);
};
const strip = (b) => b.toString('ascii').replace(/[\x02\x03\x0A\x0D\x00]/g, '').trim();
const pad     = (n, w=4) => String(n).padStart(w, '0');
const now12   = () => Math.floor(Date.now() % 1e12);
const maskPAN = (pan) => (pan ? (pan.slice(0,6) + '******' + pan.slice(-4)).replace(/\s/g,'') : '************0000');
const emvTags = () => ({
    "4F":"A0000000031010","50":"5649534120435245444954","82":"2000","95":"0000000000",
    "9A":"250101","9B":"0000","9C":"00","9F02":"000000000400","9F03":"000000000000",
    "9F06":"A0000000031010","9F10":"06010A03A00000","9F12":"56495341","9F1A":"0840",
    "9F26":"3473A7F81C417706","9F27":"80","9F33":"E0A8C8","9F34":"1E0000","9F35":"22",
    "9F36":"0001","9F37":"1F56527D","9F40":"F000F0A001","9F41":"00000001"
});

function sendAck(sock){ sock.write(frame({ message:"ACK", data:"" })); }

function sendMsg(sock, data, response, cmdResult) {
    const msg = { message:"MSG", data: { ...data,
            EcrId: data?.EcrId ?? ECR_ID, response, cmdResult } };
    sock.write(frame(msg));
}

// --- in-memory "batch" & sequences ----------------------------
const store = {
    nextTranNo: 1,
    batchOpen: true,
    txns: [] // {tranNo, referenceNumber, responseId, type, amounts, status, pan, tip, tax, approvalCode, partialApproval, authorizedAmount}
};

function allocateIds() {
    return {
        tranNo: pad(store.nextTranNo++),
        referenceNumber: String(200000000000 + Math.floor(Math.random()*900000000000)), // 12+ digits
        responseId: 200000000000 + Math.floor(Math.random()*900000000000),
        approvalCode: pad(Math.floor(Math.random()*999999)).slice(-6)
    };
}

function resultSuccess() { return { result:"Success" }; }
function resultFailed(code,msg){ return { result:"Failed", errorCode:code, errorMessage:msg }; }

// --- Core handlers --------------------------------------------
async function handlePing(sock, req) {
    sendAck(sock);
    setTimeout(() => {
        sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "Ping", resultSuccess());
    }, 150);
}

function resolveCardAcquisition(req) {
    const mode = req.data?.data?.params?.cardAcquisition || req.data?.data?.transaction?.cardAcquisition;
    // From test cases we just need: INSERT (EMV), SWIPE (MSR), MANUAL (keyed)
    return (mode || 'INSERT').toUpperCase();
}

// manual AVS/CVV rules for Test Case 3
function mockAvsCvv(params) {
    // If address "76321" + zip "76321" + cvv "321" => Y/M
    const addr = params?.avsAddress || params?.address || '';
    const zip  = params?.avsZip || params?.zip || '';
    const cvv  = params?.cvv || params?.cvv2 || params?.cardSecurityCode || '';
    const AvsResultCode = (addr==='76321' && zip==='76321') ? 'Y' : '0';
    const CvvResultCode = (cvv==='321') ? 'M' : 'N';
    return { AvsResultCode, AvsResultText: AvsResultCode==='Y' ? 'Address & ZIP match' : 'AVS Not Requested.',
        CvvResultCode, CvvResultText: CvvResultCode==='M' ? 'CVV Match' : 'CVV No Match' };
}

function buildPaymentSection(acq, pan, typeLabel) {
    const section = {
        transactionType: typeLabel,
        cardGroup: "CREDIT",
        cardAcquisition: acq,
        maskedPAN: maskPAN(pan || "4761739001010010"), // default VISA test
        cardType: "MasterCard",
        expiryDate: "12/25",
        fallback: "0"
    };
    if (acq === 'INSERT' || acq === 'TAP') section.appName = "EMV CREDIT";
    return section;
}

function hostSectionFrom(ids, amounts, opts={}) {
    const h = {
        respDateTime: new Date().toLocaleString('en-US', { hour:'numeric', minute:'2-digit', hour12:true }),
        approvalCode: ids.approvalCode,
        amount: (amounts?.totalAmount ?? amounts?.baseAmount ?? amounts?.amount ?? "0.00"),
        referenceNumber: ids.referenceNumber,
        responseText: opts.partial ? "PARTIALLY APPROVED" : "APPROVAL",
        gatewayResponseCode: "0",
        responseId: ids.responseId,
        gatewayResponseMessage: "Success",
        responseCode: opts.partial ? "10" : "00"
    };
    return h;
}

function packMSG(response, body){
    return { message:"MSG", data: { ...body, response } };
}

// Sale (covers Test Case 1,2,3 and Partial Approval (5))
async function handleSale(sock, req) {
    sendAck(sock);

    const data = req.data?.data || {};
    const txn  = data.transaction || {};
    const params = data.params || {};
    const acq  = resolveCardAcquisition(req); // INSERT/SWIPE/MANUAL
    const baseAmount = parseFloat(txn.baseAmount || txn.amount || "0.00");
    const tip = parseFloat(txn.tipAmount || "0.00");
    const tax = parseFloat(txn.taxAmount || "0.00");
    const total = (baseAmount + tip + tax).toFixed(2);

    // Simulate manual keyed card
    const pan = (params.cardPAN || params.pan || data.pan || (acq==='MANUAL' ? "5473530000000014" : null));

    // Partial Approval rule for test case 5: request $155.00 -> approve $100.00
    let partial = false;
    let authorized = total;
    if (parseFloat(total) >= 155.00) {
        partial = true;
        authorized = "100.00";
    }

    const ids = allocateIds();

    // Build response
    const payment = buildPaymentSection(acq, pan, "CREDIT SALE");
    const host = hostSectionFrom(ids, { totalAmount: total }, { partial });
    if (partial) host.authorizedAmount = authorized;

    const out = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            multipleMessage: "0",
            host,
            payment,
            transaction: {
                baseAmount: baseAmount.toFixed(2),
                tipAmount: tip.toFixed(2),
                taxAmount: tax.toFixed(2),
                totalAmount: partial ? authorized : total
            }
        }
    };

    // Manual sale AVS/CVV (Test Case 3)
    if (acq === 'MANUAL') {
        const { AvsResultCode, AvsResultText, CvvResultCode, CvvResultText } = mockAvsCvv(params);
        out.data.host.AvsResultCode = AvsResultCode;
        out.data.host.AvsResultText = AvsResultText;
        out.data.host.CvvResultCode = CvvResultCode;
        out.data.host.CvvResultText = CvvResultText;
    }

    // EMV section for INSERT (Test Case 1)
    if (acq === 'INSERT') {
        out.data.emv = emvTags();
    }

    // Partial approval flags
    if (partial) {
        out.data.partialApproval = "1";
        out.data.balanceDue = (parseFloat(total) - parseFloat(authorized)).toFixed(2);
    }

    // Persist for Void/TipAdjust/Refund
    store.txns.push({
        tranNo: ids.tranNo,
        referenceNumber: String(ids.referenceNumber),
        responseId: ids.responseId,
        type: 'Sale',
        amounts: { baseAmount: baseAmount.toFixed(2), tip: tip.toFixed(2), tax: tax.toFixed(2), total: total },
        status: 'Approved',
        pan: payment.maskedPAN,
        partialApproval: partial ? 1 : 0,
        authorizedAmount: partial ? authorized : total,
        approvalCode: ids.approvalCode
    });

    // Return MSG
    setTimeout(() => sock.write(frame(packMSG("Sale", out))), 250);
}

// PreAuth (Lodging basic)
async function handlePreAuth(sock, req) {
    sendAck(sock);

    const data = req.data?.data || {};
    const txn  = data.transaction || {};
    const lodging = data.lodging || {};
    const baseAmount = parseFloat(txn.amount || txn.baseAmount || "0.00").toFixed(2);
    const acq = resolveCardAcquisition(req);

    const ids = allocateIds();
    const payment = buildPaymentSection(acq, null, "Open Tab");
    const host = hostSectionFrom(ids, { amount: baseAmount });

    const out = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            multipleMessage: "0",
            merchantId: "*********712",
            host: { ...host, amount: baseAmount },
            payment,
            terminalId: "***605",
            lodging: {
                folioNumber: lodging.folioNumber || "1",
                stayDuration: lodging.stayDuration || "3",
                checkInDate: lodging.checkInDate || "01182022",
                checkOutDate: lodging.checkOutDate || "01202022",
                dailyRate: lodging.dailyRate || "10.00"
            }
        }
    };

    // Save as preauth for later completion/voids etc.
    store.txns.push({
        tranNo: ids.tranNo,
        referenceNumber: String(ids.referenceNumber),
        responseId: ids.responseId,
        type: 'PreAuth',
        amounts: { amount: baseAmount },
        status: 'Approved'
    });

    setTimeout(() => sock.write(frame(packMSG("PreAuth", out))), 250);
}

// TipAdjust
async function handleTipAdjust(sock, req) {
    sendAck(sock);

    const t = req.data?.data?.transaction || {};
    const tipAmount = parseFloat(t.tipAmount || "0.00").toFixed(2);
    const ref = t.referenceNumber;
    const tranNo = t.tranNo;

    const found = store.txns.find(x =>
        (ref && x.referenceNumber === String(ref)) ||
        (tranNo && x.tranNo === String(tranNo))
    );

    if (!found) {
        const fail = resultFailed("TRAN009","MISSING TRANSACTION IDENTIFIER / NOT FOUND");
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''), EcrId: String(req.data?.EcrId || ECR_ID)
        }, "TipAdjust", fail), 150);
    }

    found.amounts.tip = tipAmount;
    found.amounts.total = (parseFloat(found.amounts.baseAmount || "0") + parseFloat(found.amounts.tax || "0") + parseFloat(tipAmount)).toFixed(2);

    const ids = allocateIds();
    const payment = buildPaymentSection('TAP', null, "TIP ADJUST");

    const out = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            multipleMessage:"0",
            host: {
                respDateTime: new Date().toLocaleString('en-US',{hour:'numeric',minute:'2-digit',hour12:true}),
                approvalCode: ids.approvalCode,
                authorizedAmount: found.amounts.total,
                referenceNumber: ids.referenceNumber,
                responseText: "APPROVAL",
                gatewayResponseCode: "0",
                tranNo: found.tranNo,
                responseId: ids.responseId,
                gatewayResponseMessage: "Success",
                responseCode: "00",
                AvsResultCode: "0"
            },
            payment,
            transaction: {
                totalAmount: found.amounts.total,
                tipAmount: tipAmount,
                baseAmount: found.amounts.baseAmount || found.amounts.total
            }
        }
    };

    setTimeout(() => sock.write(frame(packMSG("TipAdjust", out))), 250);
}

// Void
async function handleVoid(sock, req) {
    sendAck(sock);
    const t = req.data?.data?.transaction || {};
    const ref = t.referenceNumber;
    const tranNo = t.tranNo;

    const found = store.txns.find(x =>
        (ref && x.referenceNumber === String(ref)) ||
        (tranNo && x.tranNo === String(tranNo))
    );

    if (!found) {
        const fail = resultFailed("REF001","REFERENCE # NOT FOUND");
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''), EcrId: String(req.data?.EcrId || ECR_ID)
        }, "Void", fail), 150);
    }

    found.status = 'Voided';

    const ids = allocateIds();
    const out = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            multipleMessage:"0",
            host: {
                responseId: ids.responseId,
                tranNo: found.tranNo,
                respDateTime: new Date().toLocaleString('en-US',{hour:'numeric',minute:'2-digit',hour12:true}),
                gatewayResponseCode:"0",
                gatewayResponseMessage:"Success",
                referenceNumber: String(ids.referenceNumber),
                baseAmount: found.amounts.baseAmount || found.amounts.total,
                tipAmount: found.amounts.tip || "0.00",
                taxAmount: found.amounts.tax || "0.00",
                cashbackAmount: "0.00",
                baseDue: "0.00"
            },
            payment: {
                transactionType: "VOID CREDIT SALE",
                cardType: "MasterCard",
                cardGroup: "CREDIT",
                maskedPAN: found.pan || "************0000",
                signatureLine: "0",
                PinVerified: "1"
            },
            emv: { "95":"8080048000","9F26":"367AE62221F54E90","9F10":"06010A03A08000","9F27":"80" }
        }
    };

    setTimeout(() => sock.write(frame(packMSG("Void", out))), 200);
}

// Refund (by reference or free)
async function handleRefund(sock, req) {
    sendAck(sock);

    const data = req.data?.data || {};
    const t = data.transaction || {};
    const total = parseFloat(t.totalAmount || "0.00").toFixed(2);
    const ref = t.referenceNumber;
    const baseAmount = t.baseAmount || total;

    const ids = allocateIds();

    const out = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            multipleMessage:"0",
            host: {
                responseId: String(ids.responseId),
                tranNo: pad(store.nextTranNo),
                respDateTime: new Date().toLocaleString('en-US',{hour:'numeric',minute:'2-digit',hour12:true}),
                gatewayResponseCode:"0",
                gatewayResponseMessage:"Success",
                referenceNumber: String(ids.referenceNumber)
            },
            payment: {
                transactionType: "CREDIT REFUND",
                cardHolderName: "TEST CARD",
                cardType: "MasterCard",
                cardGroup: "CREDIT",
                maskedPAN: "222300******5798"
            }
        }
    };

    // persist refund record
    store.txns.push({
        tranNo: pad(store.nextTranNo++),
        referenceNumber: String(ids.referenceNumber),
        responseId: ids.responseId,
        type: 'Refund',
        amounts: { totalAmount: total, baseAmount },
        status: 'Approved'
    });

    setTimeout(() => sock.write(frame(packMSG("Refund", out))), 250);
}

// Batch Close / EOD
async function handleBatchClose(sock, req) {
    sendAck(sock);

    // Mark open approvals "settled" and assign a batch number.
    const batchNumber = String(1000 + Math.floor(Math.random()*9000));
    store.batchOpen = false;

    const out = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            multipleMessage:"0",
            batchNumber,
            closedCount: store.txns.filter(t => t.status === 'Approved').length,
            responseText: "BATCH SUBMISSION SUCCESS"
        }
    };

    setTimeout(() => sock.write(frame(packMSG("EOD", out))), 300);
}

// Router
async function route(sock, obj) {
    if (obj.message === 'ACK') {
        // POS final ack – nothing to do
        return;
    }
    const cmd = obj.data?.command;
    if (!cmd) return;

    switch (cmd) {
        case 'Ping':     return handlePing(sock, obj);
        case 'Sale':     return handleSale(sock, obj);
        case 'PreAuth':  return handlePreAuth(sock, obj);
        case 'TipAdjust':return handleTipAdjust(sock, obj);
        case 'Void':     return handleVoid(sock, obj);
        case 'Refund':   return handleRefund(sock, obj);
        case 'EOD':
        case 'BatchClose':
        case 'Batch':    return handleBatchClose(sock, obj);
        default:
            sendAck(sock);
            return setTimeout(() => sendMsg(sock, {
                requestId: String(obj.data?.requestId || ''), EcrId: String(obj.data?.EcrId || ECR_ID)
            }, cmd, resultFailed("ERR999", `UNSUPPORTED COMMAND: ${cmd}`)), 100);
    }
}

// --- TCP server ----------------------------------------------
const server = net.createServer(socket => {
    console.log('== CLIENT CONNECTED ==');
    let acc = Buffer.alloc(0);

    socket.on('data', chunk => {
        acc = Buffer.concat([acc, chunk]);
        while (true) {
            const s = acc.indexOf(STX), e = acc.indexOf(ETX, s + 1);
            if (s === -1 || e === -1) break;

            const raw = acc.slice(s + 1, e);
            const text = strip(raw);
            console.log('>> RECEIVED:', text);

            try {
                const obj = JSON.parse(text);
                route(socket, obj);
            } catch (err) {
                console.log('!! PARSE ERROR:', err.message);
                sendAck(socket);
                sendMsg(socket, { EcrId: ECR_ID }, "Error", resultFailed("ERRJSON","INVALID JSON"));
            }
            acc = acc.slice(e + 1);
        }
    });

    socket.on('close', () => console.log('== CLIENT DISCONNECTED =='));
    socket.on('error', err => console.error('!! SOCKET ERROR:', err.message));
});

server.listen(LISTEN_PORT, () => {
    console.log(`== MOCK VERIFONE SERVER RUNNING on port ${LISTEN_PORT} (ECR_ID=${ECR_ID}) ==`);
});
