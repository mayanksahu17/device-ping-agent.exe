// verifone-comprehensive-mock-server.js
// Comprehensive Mock Verifone/UPA terminal with full transaction lifecycle management
// Features: Complete transaction tracking, settlement management, batch operations,
// comprehensive error handling, and persistent storage
// -------------------------------------------------------------

const net = require('net');
const fs = require('fs');
const path = require('path');

const LISTEN_PORT = parseInt(process.argv[2] || '8081', 10);
const ECR_ID      = process.argv[3] || '13';
const DATA_FILE   = path.join(__dirname, 'verifone-transactions.json');

const STX = 0x02, LF = 0x0A, ETX = 0x03;

// Transaction States
const TXN_STATUS = {
    PENDING: 'PENDING',
    APPROVED: 'APPROVED', 
    DECLINED: 'DECLINED',
    VOIDED: 'VOIDED',
    SETTLED: 'SETTLED',
    REFUNDED: 'REFUNDED',
    PARTIAL_VOIDED: 'PARTIAL_VOIDED',
    TIP_ADJUSTED: 'TIP_ADJUSTED'
};

// Transaction Types
const TXN_TYPES = {
    SALE: 'Sale',
    PREAUTH: 'PreAuth',
    CAPTURE: 'Capture',
    VOID: 'Void',
    REFUND: 'Refund',
    TIP_ADJUST: 'TipAdjust',
    REVERSAL: 'Reversal',
    BATCH_CLOSE: 'BatchClose',
    FORCE_SALE: 'ForceSale'
};

// Card Types and Networks
const CARD_TYPES = {
    VISA: { name: 'Visa', bins: ['4'], emvAid: 'A0000000031010' },
    MASTERCARD: { name: 'MasterCard', bins: ['5', '2'], emvAid: 'A0000000041010' },
    AMEX: { name: 'American Express', bins: ['34', '37'], emvAid: 'A000000025' },
    DISCOVER: { name: 'Discover', bins: ['6'], emvAid: 'A0000001523010' }
};

// --- Storage Management ---------------------------------------------------
class TransactionStore {
    constructor() {
        this.data = this.loadData();
        this.initializeCounters();
    }

    loadData() {
        try {
            if (fs.existsSync(DATA_FILE)) {
                const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
                console.log(`Loaded ${data.transactions?.length || 0} existing transactions`);
                return data;
            }
        } catch (error) {
            console.warn('Failed to load existing data:', error.message);
        }

        return {
            transactions: [],
            batches: [],
            counters: {
                nextTranNo: 1,
                nextBatchNo: 1,
                nextRefNo: 200000000000
            },
            currentBatch: {
                id: null,
                openTime: null,
                isOpen: true,
                transactions: []
            },
            statistics: {
                totalSales: 0,
                totalRefunds: 0,
                totalVoids: 0,
                totalAmount: 0,
                dailyTotals: {}
            }
        };
    }

    initializeCounters() {
        if (!this.data.counters) {
            this.data.counters = {
                nextTranNo: Math.max(...this.data.transactions.map(t => parseInt(t.tranNo) || 0), 0) + 1,
                nextBatchNo: Math.max(...this.data.batches.map(b => parseInt(b.batchNumber) || 0), 0) + 1,
                nextRefNo: 200000000000
            };
        }
        
        if (!this.data.currentBatch) {
            this.openNewBatch();
        }
    }

    saveData() {
        try {
            fs.writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2));
            console.log(`Saved transaction data: ${this.data.transactions.length} transactions`);
        } catch (error) {
            console.error('Failed to save data:', error.message);
        }
    }

    openNewBatch() {
        const batchId = `B${String(this.data.counters.nextBatchNo++).padStart(4, '0')}`;
        this.data.currentBatch = {
            id: batchId,
            openTime: new Date().toISOString(),
            isOpen: true,
            transactions: []
        };
        console.log(`Opened new batch: ${batchId}`);
    }

    addTransaction(txn) {
        txn.id = `TXN${String(this.data.transactions.length + 1).padStart(8, '0')}`;
        txn.batchId = this.data.currentBatch.id;
        txn.createdAt = new Date().toISOString();
        txn.updatedAt = txn.createdAt;
        
        this.data.transactions.push(txn);
        this.data.currentBatch.transactions.push(txn.id);
        this.updateStatistics(txn);
        this.saveData();
        
        console.log(`Added transaction: ${txn.id} (${txn.type}) - ${txn.status}`);
        return txn;
    }

    updateTransaction(id, updates) {
        const txn = this.data.transactions.find(t => 
            t.id === id || t.tranNo === id || t.referenceNumber === id);
        
        if (txn) {
            Object.assign(txn, updates, { updatedAt: new Date().toISOString() });
            this.saveData();
            console.log(`Updated transaction: ${txn.id} - ${txn.status}`);
            return txn;
        }
        return null;
    }

    findTransaction(identifier) {
        return this.data.transactions.find(t => 
            t.id === identifier || 
            t.tranNo === String(identifier) || 
            t.referenceNumber === String(identifier) ||
            t.responseId === identifier);
    }

    getUnsettledTransactions() {
        return this.data.transactions.filter(t => 
            [TXN_STATUS.APPROVED, TXN_STATUS.TIP_ADJUSTED].includes(t.status) && 
            t.batchId === this.data.currentBatch.id);
    }

    closeBatch() {
        const unsettled = this.getUnsettledTransactions();
        unsettled.forEach(txn => {
            this.updateTransaction(txn.id, { status: TXN_STATUS.SETTLED });
        });

        const closedBatch = {
            ...this.data.currentBatch,
            closeTime: new Date().toISOString(),
            isOpen: false,
            settlementCount: unsettled.length,
            totalAmount: unsettled.reduce((sum, txn) => sum + parseFloat(txn.amounts.totalAmount || 0), 0)
        };

        this.data.batches.push(closedBatch);
        this.openNewBatch();
        this.saveData();

        return closedBatch;
    }

    updateStatistics(txn) {
        if (!this.data.statistics) {
            this.data.statistics = { totalSales: 0, totalRefunds: 0, totalVoids: 0, totalAmount: 0, dailyTotals: {} };
        }

        const today = new Date().toISOString().split('T')[0];
        if (!this.data.statistics.dailyTotals[today]) {
            this.data.statistics.dailyTotals[today] = { sales: 0, refunds: 0, voids: 0, amount: 0 };
        }

        const amount = parseFloat(txn.amounts.totalAmount || 0);
        
        switch (txn.type) {
            case TXN_TYPES.SALE:
                this.data.statistics.totalSales++;
                this.data.statistics.dailyTotals[today].sales++;
                this.data.statistics.totalAmount += amount;
                this.data.statistics.dailyTotals[today].amount += amount;
                break;
            case TXN_TYPES.REFUND:
                this.data.statistics.totalRefunds++;
                this.data.statistics.dailyTotals[today].refunds++;
                this.data.statistics.totalAmount -= amount;
                this.data.statistics.dailyTotals[today].amount -= amount;
                break;
            case TXN_TYPES.VOID:
                this.data.statistics.totalVoids++;
                this.data.statistics.dailyTotals[today].voids++;
                break;
        }
    }

    getStatistics() {
        return {
            ...this.data.statistics,
            currentBatch: this.data.currentBatch,
            totalTransactions: this.data.transactions.length,
            pendingSettlement: this.getUnsettledTransactions().length
        };
    }

    generateIds() {
        return {
            tranNo: String(this.data.counters.nextTranNo++).padStart(4, '0'),
            referenceNumber: String(this.data.counters.nextRefNo++),
            responseId: this.data.counters.nextRefNo + Math.floor(Math.random() * 1000),
            approvalCode: String(Math.floor(Math.random() * 999999)).padStart(6, '0')
        };
    }
}

// Initialize store
const store = new TransactionStore();

// --- Utility Functions ----------------------------------------------------
const frame = (obj) => {
    const j = Buffer.from(JSON.stringify(obj), 'ascii');
    return Buffer.concat([Buffer.from([STX, LF]), j, Buffer.from([LF, ETX, LF])]);
};

const strip = (b) => b.toString('ascii').replace(/[\x02\x03\x0A\x0D\x00]/g, '').trim();

const maskPAN = (pan) => {
    if (!pan) return '************0000';
    const clean = pan.replace(/\s/g, '');
    if (clean.length < 8) return '************0000';
    return clean.slice(0, 6) + '******' + clean.slice(-4);
};

const detectCardType = (pan) => {
    if (!pan) return CARD_TYPES.VISA;
    const clean = pan.replace(/\s/g, '');
    
    for (const [key, card] of Object.entries(CARD_TYPES)) {
        if (card.bins.some(bin => clean.startsWith(bin))) {
            return card;
        }
    }
    return CARD_TYPES.VISA; // default
};

const generateEMVTags = (cardType = CARD_TYPES.VISA) => ({
    "4F": cardType.emvAid,
    "50": `${cardType.name.toUpperCase()} CREDIT`,
    "82": "2000",
    "95": "0000000000",
    "9A": new Date().toISOString().slice(2, 10).replace(/-/g, ''),
    "9B": "0000",
    "9C": "00",
    "9F02": "000000000400",
    "9F03": "000000000000",
    "9F06": cardType.emvAid,
    "9F10": "06010A03A00000",
    "9F12": cardType.name.toUpperCase().slice(0, 4),
    "9F1A": "0840",
    "9F26": Math.random().toString(16).substring(2, 18).toUpperCase(),
    "9F27": "80",
    "9F33": "E0A8C8",
    "9F34": "1E0000",
    "9F35": "22",
    "9F36": "0001",
    "9F37": Math.random().toString(16).substring(2, 10).toUpperCase(),
    "9F40": "F000F0A001",
    "9F41": "00000001"
});

// Response helpers
function sendAck(sock) { 
    sock.write(frame({ message: "ACK", data: "" })); 
}

function sendMsg(sock, data, response, cmdResult) {
    const msg = { 
        message: "MSG", 
        data: { 
            ...data,
            EcrId: data?.EcrId ?? ECR_ID, 
            response, 
            cmdResult,
            timestamp: new Date().toISOString()
        } 
    };
    sock.write(frame(msg));
    console.log(`<< SENT: ${response} - ${cmdResult.result}`);
}

function resultSuccess(data = {}) { 
    return { result: "Success", ...data }; 
}

function resultFailed(code, msg, data = {}) { 
    return { result: "Failed", errorCode: code, errorMessage: msg, ...data }; 
}

// --- Enhanced Transaction Handlers ----------------------------------------

// Comprehensive Ping with system status
async function handlePing(sock, req) {
    sendAck(sock);
    
    setTimeout(() => {
        const stats = store.getStatistics();
        sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID),
            systemStatus: {
                batchOpen: store.data.currentBatch.isOpen,
                currentBatch: store.data.currentBatch.id,
                pendingTransactions: stats.pendingSettlement,
                uptime: process.uptime()
            }
        }, "Ping", resultSuccess());
    }, 150);
}

// Enhanced Sale with comprehensive validation
async function handleSale(sock, req) {
    sendAck(sock);

    try {
        const data = req.data?.data || {};
        const txn = data.transaction || {};
        const params = data.params || {};
        const acq = resolveCardAcquisition(req);
        
        // Amount validation
        const baseAmount = parseFloat(txn.baseAmount || txn.amount || "0.00");
        const tip = parseFloat(txn.tipAmount || "0.00");
        const tax = parseFloat(txn.taxAmount || "0.00");
        const cashback = parseFloat(txn.cashbackAmount || "0.00");
        const total = (baseAmount + tip + tax + cashback).toFixed(2);

        if (baseAmount <= 0) {
            return setTimeout(() => sendMsg(sock, {
                requestId: String(req.data?.requestId || ''),
                EcrId: String(req.data?.EcrId || ECR_ID)
            }, "Sale", resultFailed("AMT001", "INVALID AMOUNT")), 200);
        }

        const pan = params.cardPAN || params.pan || data.pan || 
                   (acq === 'MANUAL' ? "5473530000000014" : "4761739001010010");
        
        const cardType = detectCardType(pan);
        
        // Simulate various approval scenarios
        let status = TXN_STATUS.APPROVED;
        let partial = false;
        let authorized = total;
        let declineReason = null;

        // Business rules simulation
        if (parseFloat(total) >= 155.00 && parseFloat(total) < 200.00) {
            partial = true;
            authorized = "100.00";
        } else if (parseFloat(total) >= 500.00) {
            status = TXN_STATUS.DECLINED;
            declineReason = "AMOUNT TOO HIGH";
        } else if (pan.endsWith('0001')) {
            status = TXN_STATUS.DECLINED;
            declineReason = "CARD DECLINED";
        }

        const ids = store.generateIds();

        // Create transaction record
        const transaction = {
            tranNo: ids.tranNo,
            referenceNumber: ids.referenceNumber,
            responseId: ids.responseId,
            approvalCode: status === TXN_STATUS.APPROVED ? ids.approvalCode : null,
            type: TXN_TYPES.SALE,
            status: status,
            cardAcquisition: acq,
            cardType: cardType.name,
            maskedPAN: maskPAN(pan),
            amounts: {
                baseAmount: baseAmount.toFixed(2),
                tipAmount: tip.toFixed(2),
                taxAmount: tax.toFixed(2),
                cashbackAmount: cashback.toFixed(2),
                totalAmount: total,
                authorizedAmount: authorized
            },
            partialApproval: partial ? 1 : 0,
            declineReason: declineReason,
            metadata: {
                terminalId: "***605",
                merchantId: "*********712",
                cardholderName: params.cardholderName || "TEST CARD",
                expiryDate: params.expiryDate || "12/25"
            }
        };

        // Save transaction
        store.addTransaction(transaction);

        if (status === TXN_STATUS.DECLINED) {
            return setTimeout(() => sendMsg(sock, {
                requestId: String(req.data?.requestId || ''),
                EcrId: String(req.data?.EcrId || ECR_ID),
                cmdResult: resultFailed("DECLINE", declineReason)
            }, "Sale", resultFailed("DECLINE", declineReason)), 300);
        }

        // Build successful response
        const payment = {
            transactionType: "CREDIT SALE",
            cardGroup: "CREDIT",
            cardAcquisition: acq,
            maskedPAN: transaction.maskedPAN,
            cardType: cardType.name,
            expiryDate: transaction.metadata.expiryDate,
            cardholderName: transaction.metadata.cardholderName,
            fallback: "0"
        };

        const host = {
            respDateTime: new Date().toLocaleString('en-US', { 
                hour: 'numeric', minute: '2-digit', hour12: true 
            }),
            approvalCode: ids.approvalCode,
            amount: total,
            authorizedAmount: authorized,
            referenceNumber: ids.referenceNumber,
            responseText: partial ? "PARTIALLY APPROVED" : "APPROVAL",
            gatewayResponseCode: "0",
            responseId: ids.responseId,
            gatewayResponseMessage: "Success",
            responseCode: partial ? "10" : "00",
            tranNo: ids.tranNo,
            batchNumber: store.data.currentBatch.id
        };

        const response = {
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
                    cashbackAmount: cashback.toFixed(2),
                    totalAmount: authorized
                }
            }
        };

        // Add AVS/CVV for manual entry
        if (acq === 'MANUAL') {
            const { AvsResultCode, AvsResultText, CvvResultCode, CvvResultText } = 
                  mockAvsCvv(params);
            response.data.host.AvsResultCode = AvsResultCode;
            response.data.host.AvsResultText = AvsResultText;
            response.data.host.CvvResultCode = CvvResultCode;
            response.data.host.CvvResultText = CvvResultText;
        }

        // Add EMV data for chip transactions
        if (acq === 'INSERT') {
            response.data.emv = generateEMVTags(cardType);
        }

        // Add partial approval data
        if (partial) {
            response.data.partialApproval = "1";
            response.data.balanceDue = (parseFloat(total) - parseFloat(authorized)).toFixed(2);
            response.data.remainingBalance = response.data.balanceDue;
        }

        setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "Sale" })), 300);

    } catch (error) {
        console.error('Sale error:', error);
        sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "Sale", resultFailed("SYS001", "SYSTEM ERROR"));
    }
}

// Enhanced Void with comprehensive validation
async function handleVoid(sock, req) {
    sendAck(sock);

    const t = req.data?.data?.transaction || {};
    const ref = t.referenceNumber;
    const tranNo = t.tranNo;

    // Find original transaction
    const originalTxn = store.findTransaction(ref || tranNo);

    if (!originalTxn) {
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "Void", resultFailed("REF001", "REFERENCE # NOT FOUND")), 150);
    }

    // Validation rules
    if (originalTxn.status === TXN_STATUS.VOIDED) {
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "Void", resultFailed("VOID001", "TRANSACTION ALREADY VOIDED")), 150);
    }

    if (originalTxn.status === TXN_STATUS.SETTLED) {
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "Void", resultFailed("VOID002", "CANNOT VOID SETTLED TRANSACTION")), 150);
    }

    if (![TXN_STATUS.APPROVED, TXN_STATUS.TIP_ADJUSTED].includes(originalTxn.status)) {
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "Void", resultFailed("VOID003", "TRANSACTION CANNOT BE VOIDED")), 150);
    }

    // Update original transaction
    store.updateTransaction(originalTxn.id, { status: TXN_STATUS.VOIDED });

    // Create void transaction record
    const ids = store.generateIds();
    const voidTxn = {
        tranNo: ids.tranNo,
        referenceNumber: ids.referenceNumber,
        responseId: ids.responseId,
        type: TXN_TYPES.VOID,
        status: TXN_STATUS.APPROVED,
        originalTransaction: originalTxn.id,
        originalReferenceNumber: originalTxn.referenceNumber,
        amounts: { ...originalTxn.amounts },
        maskedPAN: originalTxn.maskedPAN,
        cardType: originalTxn.cardType
    };

    store.addTransaction(voidTxn);

    const response = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            multipleMessage: "0",
            host: {
                responseId: ids.responseId,
                tranNo: originalTxn.tranNo,
                respDateTime: new Date().toLocaleString('en-US', {
                    hour: 'numeric', minute: '2-digit', hour12: true
                }),
                gatewayResponseCode: "0",
                gatewayResponseMessage: "Success",
                referenceNumber: ids.referenceNumber,
                originalReferenceNumber: originalTxn.referenceNumber,
                baseAmount: originalTxn.amounts.baseAmount,
                tipAmount: originalTxn.amounts.tipAmount || "0.00",
                taxAmount: originalTxn.amounts.taxAmount || "0.00",
                totalAmount: originalTxn.amounts.totalAmount,
                voidReason: "MERCHANT REQUESTED"
            },
            payment: {
                transactionType: `VOID ${originalTxn.type.toUpperCase()}`,
                cardType: originalTxn.cardType,
                cardGroup: "CREDIT",
                maskedPAN: originalTxn.maskedPAN,
                originalApprovalCode: originalTxn.approvalCode
            },
            originalTransaction: {
                tranNo: originalTxn.tranNo,
                referenceNumber: originalTxn.referenceNumber,
                amount: originalTxn.amounts.totalAmount
            }
        }
    };

    setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "Void" })), 200);
}

// Enhanced EOD/Batch Close with detailed reporting
async function handleBatchClose(sock, req) {
    sendAck(sock);

    try {
        const unsettledTxns = store.getUnsettledTransactions();
        const closedBatch = store.closeBatch();

        // Calculate batch totals
        const salesTxns = unsettledTxns.filter(t => t.type === TXN_TYPES.SALE);
        const refundTxns = unsettledTxns.filter(t => t.type === TXN_TYPES.REFUND);
        const voidTxns = store.data.transactions.filter(t => 
            t.type === TXN_TYPES.VOID && t.batchId === closedBatch.id);

        const salesCount = salesTxns.length;
        const salesAmount = salesTxns.reduce((sum, t) => sum + parseFloat(t.amounts.totalAmount || 0), 0);
        const refundCount = refundTxns.length;
        const refundAmount = refundTxns.reduce((sum, t) => sum + parseFloat(t.amounts.totalAmount || 0), 0);
        const netAmount = salesAmount - refundAmount;

        const response = {
            EcrId: String(req.data?.EcrId || ECR_ID),
            requestId: String(req.data?.requestId || ''),
            cmdResult: resultSuccess(),
            data: {
                multipleMessage: "0",
                batchNumber: closedBatch.id,
                batchOpenTime: closedBatch.openTime,
                batchCloseTime: closedBatch.closeTime,
                responseText: "BATCH SUBMISSION SUCCESS",
                
                // Detailed batch summary
                batchSummary: {
                    totalTransactions: unsettledTxns.length,
                    salesCount,
                    salesAmount: salesAmount.toFixed(2),
                    refundCount,
                    refundAmount: refundAmount.toFixed(2),
                    voidCount: voidTxns.length,
                    netAmount: netAmount.toFixed(2),
                    settlementDate: new Date().toISOString().split('T')[0]
                },

                // Transaction breakdown by card type
                cardTypeSummary: Object.entries(
                    unsettledTxns.reduce((acc, txn) => {
                        const cardType = txn.cardType || 'Unknown';
                        if (!acc[cardType]) acc[cardType] = { count: 0, amount: 0 };
                        acc[cardType].count++;
                        acc[cardType].amount += parseFloat(txn.amounts.totalAmount || 0);
                        return acc;
                    }, {})
                ).map(([type, data]) => ({
                    cardType: type,
                    count: data.count,
                    amount: data.amount.toFixed(2)
                })),

                newBatchNumber: store.data.currentBatch.id
            }
        };

        console.log(`Batch ${closedBatch.id} closed: ${salesCount} sales, ${refundCount} refunds, $${netAmount.toFixed(2)} net`);
        setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "EOD" })), 300);

    } catch (error) {
        console.error('Batch close error:', error);
        sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "EOD", resultFailed("BATCH001", "BATCH CLOSE FAILED"));
    }
}

// Enhanced TipAdjust
async function handleTipAdjust(sock, req) {
    sendAck(sock);

    const t = req.data?.data?.transaction || {};
    const tipAmount = parseFloat(t.tipAmount || "0.00");
    const ref = t.referenceNumber;
    const tranNo = t.tranNo;

    const originalTxn = store.findTransaction(ref || tranNo);

    if (!originalTxn) {
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "TipAdjust", resultFailed("TRAN009", "TRANSACTION NOT FOUND")), 150);
    }

    if (originalTxn.status !== TXN_STATUS.APPROVED && originalTxn.status !== TXN_STATUS.TIP_ADJUSTED) {
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "TipAdjust", resultFailed("TIP001", "TRANSACTION CANNOT BE TIP ADJUSTED")), 150);
    }

    // Update amounts
    const baseAmount = parseFloat(originalTxn.amounts.baseAmount || 0);
    const tax = parseFloat(originalTxn.amounts.taxAmount || 0);
    const newTotal = (baseAmount + tax + tipAmount).toFixed(2);

    // Update transaction
    store.updateTransaction(originalTxn.id, {
        status: TXN_STATUS.TIP_ADJUSTED,
        'amounts.tipAmount': tipAmount.toFixed(2),
        'amounts.totalAmount': newTotal
    });

    const ids = store.generateIds();
    const response = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            multipleMessage: "0",
            host: {
                respDateTime: new Date().toLocaleString('en-US', {
                    hour: 'numeric', minute: '2-digit', hour12: true
                }),
                approvalCode: ids.approvalCode,
                authorizedAmount: newTotal,
                referenceNumber: originalTxn.referenceNumber,
                responseText: "TIP ADJUSTMENT APPROVED",
                gatewayResponseCode: "0",
                tranNo: originalTxn.tranNo,
                responseId: ids.responseId,
                gatewayResponseMessage: "Success",
                responseCode: "00",
                originalAmount: originalTxn.amounts.totalAmount,
                tipAdjustmentAmount: tipAmount.toFixed(2)
            },
            payment: {
                transactionType: "TIP ADJUST",
                cardType: originalTxn.cardType,
                cardGroup: "CREDIT",
                maskedPAN: originalTxn.maskedPAN,
                cardAcquisition: "TAP" // Tip adjustments typically don't require card present
            },
            transaction: {
                totalAmount: newTotal,
                tipAmount: tipAmount.toFixed(2),
                baseAmount: originalTxn.amounts.baseAmount,
                taxAmount: originalTxn.amounts.taxAmount || "0.00"
            }
        }
    };

    setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "TipAdjust" })), 250);
}

// Enhanced Refund with validation
async function handleRefund(sock, req) {
    sendAck(sock);

    try {
        const data = req.data?.data || {};
        const t = data.transaction || {};
        const params = data.params || {};
        const refundAmount = parseFloat(t.totalAmount || t.amount || "0.00");
        const ref = t.referenceNumber;
        const isReferencedRefund = !!ref;

        if (refundAmount <= 0) {
            return setTimeout(() => sendMsg(sock, {
                requestId: String(req.data?.requestId || ''),
                EcrId: String(req.data?.EcrId || ECR_ID)
            }, "Refund", resultFailed("AMT002", "INVALID REFUND AMOUNT")), 200);
        }

        let originalTxn = null;
        let pan = params.cardPAN || params.pan || "5473530000000014";

        // If referenced refund, find original transaction
        if (isReferencedRefund) {
            originalTxn = store.findTransaction(ref);
            if (!originalTxn) {
                return setTimeout(() => sendMsg(sock, {
                    requestId: String(req.data?.requestId || ''),
                    EcrId: String(req.data?.EcrId || ECR_ID)
                }, "Refund", resultFailed("REF002", "ORIGINAL TRANSACTION NOT FOUND")), 200);
            }

            // Validate refund amount doesn't exceed original
            if (refundAmount > parseFloat(originalTxn.amounts.totalAmount)) {
                return setTimeout(() => sendMsg(sock, {
                    requestId: String(req.data?.requestId || ''),
                    EcrId: String(req.data?.EcrId || ECR_ID)
                }, "Refund", resultFailed("AMT003", "REFUND AMOUNT EXCEEDS ORIGINAL")), 200);
            }

            pan = originalTxn.maskedPAN;
        }

        const cardType = detectCardType(pan);
        const acq = resolveCardAcquisition(req);
        const ids = store.generateIds();

        // Create refund transaction
        const refundTxn = {
            tranNo: ids.tranNo,
            referenceNumber: ids.referenceNumber,
            responseId: ids.responseId,
            approvalCode: ids.approvalCode,
            type: TXN_TYPES.REFUND,
            status: TXN_STATUS.APPROVED,
            cardAcquisition: acq,
            cardType: cardType.name,
            maskedPAN: maskPAN(pan),
            originalTransaction: originalTxn?.id,
            originalReferenceNumber: originalTxn?.referenceNumber,
            amounts: {
                totalAmount: refundAmount.toFixed(2),
                baseAmount: refundAmount.toFixed(2),
                tipAmount: "0.00",
                taxAmount: "0.00"
            },
            metadata: {
                refundReason: t.reason || "MERCHANT REQUESTED",
                isReferencedRefund,
                terminalId: "***605",
                merchantId: "*********712"
            }
        };

        store.addTransaction(refundTxn);

        const response = {
            EcrId: String(req.data?.EcrId || ECR_ID),
            requestId: String(req.data?.requestId || ''),
            cmdResult: resultSuccess(),
            data: {
                multipleMessage: "0",
                host: {
                    responseId: ids.responseId,
                    tranNo: ids.tranNo,
                    respDateTime: new Date().toLocaleString('en-US', {
                        hour: 'numeric', minute: '2-digit', hour12: true
                    }),
                    approvalCode: ids.approvalCode,
                    gatewayResponseCode: "0",
                    gatewayResponseMessage: "Success",
                    referenceNumber: ids.referenceNumber,
                    responseText: "REFUND APPROVED",
                    responseCode: "00",
                    amount: refundAmount.toFixed(2),
                    refundType: isReferencedRefund ? "REFERENCED" : "UNREFERENCED"
                },
                payment: {
                    transactionType: "CREDIT REFUND",
                    cardholderName: originalTxn?.metadata?.cardholderName || "TEST CARD",
                    cardType: cardType.name,
                    cardGroup: "CREDIT",
                    maskedPAN: maskPAN(pan),
                    cardAcquisition: acq
                },
                transaction: {
                    totalAmount: refundAmount.toFixed(2),
                    refundAmount: refundAmount.toFixed(2)
                }
            }
        };

        if (originalTxn) {
            response.data.originalTransaction = {
                tranNo: originalTxn.tranNo,
                referenceNumber: originalTxn.referenceNumber,
                originalAmount: originalTxn.amounts.totalAmount
            };
        }

        setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "Refund" })), 250);

    } catch (error) {
        console.error('Refund error:', error);
        sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "Refund", resultFailed("SYS002", "REFUND PROCESSING ERROR"));
    }
}

// Enhanced PreAuth with lodging support
async function handlePreAuth(sock, req) {
    sendAck(sock);

    try {
        const data = req.data?.data || {};
        const txn = data.transaction || {};
        const lodging = data.lodging || {};
        const params = data.params || {};
        const authAmount = parseFloat(txn.amount || txn.baseAmount || "0.00");

        if (authAmount <= 0) {
            return setTimeout(() => sendMsg(sock, {
                requestId: String(req.data?.requestId || ''),
                EcrId: String(req.data?.EcrId || ECR_ID)
            }, "PreAuth", resultFailed("AMT001", "INVALID AUTHORIZATION AMOUNT")), 200);
        }

        const acq = resolveCardAcquisition(req);
        const pan = params.cardPAN || params.pan || "4761739001010010";
        const cardType = detectCardType(pan);
        const ids = store.generateIds();

        // Create preauth transaction
        const preAuthTxn = {
            tranNo: ids.tranNo,
            referenceNumber: ids.referenceNumber,
            responseId: ids.responseId,
            approvalCode: ids.approvalCode,
            type: TXN_TYPES.PREAUTH,
            status: TXN_STATUS.APPROVED,
            cardAcquisition: acq,
            cardType: cardType.name,
            maskedPAN: maskPAN(pan),
            amounts: {
                authAmount: authAmount.toFixed(2),
                totalAmount: authAmount.toFixed(2)
            },
            metadata: {
                terminalId: "***605",
                merchantId: "*********712",
                lodging: lodging.folioNumber ? {
                    folioNumber: lodging.folioNumber,
                    stayDuration: lodging.stayDuration || "1",
                    checkInDate: lodging.checkInDate,
                    checkOutDate: lodging.checkOutDate,
                    dailyRate: lodging.dailyRate || "0.00"
                } : null
            }
        };

        store.addTransaction(preAuthTxn);

        const response = {
            EcrId: String(req.data?.EcrId || ECR_ID),
            requestId: String(req.data?.requestId || ''),
            cmdResult: resultSuccess(),
            data: {
                multipleMessage: "0",
                merchantId: "*********712",
                terminalId: "***605",
                host: {
                    respDateTime: new Date().toLocaleString('en-US', {
                        hour: 'numeric', minute: '2-digit', hour12: true
                    }),
                    approvalCode: ids.approvalCode,
                    amount: authAmount.toFixed(2),
                    authorizedAmount: authAmount.toFixed(2),
                    referenceNumber: ids.referenceNumber,
                    responseText: "PREAUTH APPROVED",
                    gatewayResponseCode: "0",
                    responseId: ids.responseId,
                    gatewayResponseMessage: "Success",
                    responseCode: "00",
                    tranNo: ids.tranNo
                },
                payment: {
                    transactionType: lodging.folioNumber ? "LODGING PREAUTH" : "PREAUTH",
                    cardType: cardType.name,
                    cardGroup: "CREDIT",
                    maskedPAN: maskPAN(pan),
                    cardAcquisition: acq,
                    expiryDate: params.expiryDate || "12/25"
                },
                transaction: {
                    authAmount: authAmount.toFixed(2),
                    totalAmount: authAmount.toFixed(2)
                }
            }
        };

        if (lodging.folioNumber) {
            response.data.lodging = {
                folioNumber: lodging.folioNumber,
                stayDuration: lodging.stayDuration || "1",
                checkInDate: lodging.checkInDate || new Date().toISOString().slice(0, 10).replace(/-/g, ''),
                checkOutDate: lodging.checkOutDate || new Date(Date.now() + 86400000).toISOString().slice(0, 10).replace(/-/g, ''),
                dailyRate: lodging.dailyRate || "0.00"
            };
        }

        setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "PreAuth" })), 250);

    } catch (error) {
        console.error('PreAuth error:', error);
        sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "PreAuth", resultFailed("SYS003", "PREAUTH PROCESSING ERROR"));
    }
}

// Transaction Status Inquiry
async function handleStatusInquiry(sock, req) {
    sendAck(sock);

    const t = req.data?.data?.transaction || {};
    const identifier = t.referenceNumber || t.tranNo || t.responseId;

    if (!identifier) {
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "StatusInquiry", resultFailed("REQ001", "MISSING TRANSACTION IDENTIFIER")), 150);
    }

    const txn = store.findTransaction(identifier);

    if (!txn) {
        return setTimeout(() => sendMsg(sock, {
            requestId: String(req.data?.requestId || ''),
            EcrId: String(req.data?.EcrId || ECR_ID)
        }, "StatusInquiry", resultFailed("TXN001", "TRANSACTION NOT FOUND")), 150);
    }

    const response = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            transaction: {
                tranNo: txn.tranNo,
                referenceNumber: txn.referenceNumber,
                responseId: txn.responseId,
                type: txn.type,
                status: txn.status,
                amount: txn.amounts.totalAmount,
                cardType: txn.cardType,
                maskedPAN: txn.maskedPAN,
                batchId: txn.batchId,
                createdAt: txn.createdAt,
                updatedAt: txn.updatedAt
            }
        }
    };

    setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "StatusInquiry" })), 200);
}

// Batch Inquiry
async function handleBatchInquiry(sock, req) {
    sendAck(sock);

    const stats = store.getStatistics();
    const currentBatch = store.data.currentBatch;
    const unsettledTxns = store.getUnsettledTransactions();

    const response = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            currentBatch: {
                id: currentBatch.id,
                isOpen: currentBatch.isOpen,
                openTime: currentBatch.openTime,
                transactionCount: unsettledTxns.length,
                totalAmount: unsettledTxns.reduce((sum, t) => sum + parseFloat(t.amounts.totalAmount || 0), 0).toFixed(2)
            },
            statistics: stats,
            recentBatches: store.data.batches.slice(-5).map(batch => ({
                id: batch.id,
                closeTime: batch.closeTime,
                settlementCount: batch.settlementCount,
                totalAmount: batch.totalAmount?.toFixed(2) || "0.00"
            }))
        }
    };

    setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "BatchInquiry" })), 200);
}

// Transaction List
async function handleTransactionList(sock, req) {
    sendAck(sock);

    const filters = req.data?.data?.filters || {};
    const limit = parseInt(filters.limit || '50');
    const offset = parseInt(filters.offset || '0');

    let transactions = store.data.transactions;

    // Apply filters
    if (filters.status) {
        transactions = transactions.filter(t => t.status === filters.status);
    }
    if (filters.type) {
        transactions = transactions.filter(t => t.type === filters.type);
    }
    if (filters.batchId) {
        transactions = transactions.filter(t => t.batchId === filters.batchId);
    }
    if (filters.dateFrom) {
        transactions = transactions.filter(t => t.createdAt >= filters.dateFrom);
    }
    if (filters.dateTo) {
        transactions = transactions.filter(t => t.createdAt <= filters.dateTo);
    }

    // Sort by creation date (newest first)
    transactions.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Paginate
    const total = transactions.length;
    const paginatedTxns = transactions.slice(offset, offset + limit);

    const response = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            transactions: paginatedTxns.map(t => ({
                tranNo: t.tranNo,
                referenceNumber: t.referenceNumber,
                type: t.type,
                status: t.status,
                amount: t.amounts.totalAmount,
                cardType: t.cardType,
                maskedPAN: t.maskedPAN,
                createdAt: t.createdAt,
                batchId: t.batchId
            })),
            pagination: {
                total,
                limit,
                offset,
                hasMore: offset + limit < total
            }
        }
    };

    setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "TransactionList" })), 300);
}

// System Reset
async function handleSystemReset(sock, req) {
    sendAck(sock);

    const resetType = req.data?.data?.resetType || 'soft';

    if (resetType === 'hard') {
        // Reset everything
        store.data = {
            transactions: [],
            batches: [],
            counters: { nextTranNo: 1, nextBatchNo: 1, nextRefNo: 200000000000 },
            currentBatch: null,
            statistics: { totalSales: 0, totalRefunds: 0, totalVoids: 0, totalAmount: 0, dailyTotals: {} }
        };
        store.openNewBatch();
        store.saveData();
        console.log('HARD RESET: All data cleared');
    } else {
        // Soft reset - just close current batch and start new one
        if (store.data.currentBatch.isOpen) {
            store.closeBatch();
        }
        console.log('SOFT RESET: New batch opened');
    }

    const response = {
        EcrId: String(req.data?.EcrId || ECR_ID),
        requestId: String(req.data?.requestId || ''),
        cmdResult: resultSuccess(),
        data: {
            resetType,
            newBatchId: store.data.currentBatch.id,
            message: `${resetType.toUpperCase()} RESET COMPLETED`
        }
    };

    setTimeout(() => sock.write(frame({ message: "MSG", data: response.data, response: "SystemReset" })), 200);
}

// --- Helper Functions Continued ------------------------------------------

function resolveCardAcquisition(req) {
    const mode = req.data?.data?.params?.cardAcquisition || 
                 req.data?.data?.transaction?.cardAcquisition || 
                 req.data?.cardAcquisition;
    return (mode || 'INSERT').toUpperCase();
}

function mockAvsCvv(params) {
    const addr = params?.avsAddress || params?.address || '';
    const zip = params?.avsZip || params?.zip || '';
    const cvv = params?.cvv || params?.cvv2 || params?.cardSecurityCode || '';
    
    const AvsResultCode = (addr === '76321' && zip === '76321') ? 'Y' : '0';
    const CvvResultCode = (cvv === '321') ? 'M' : 'N';
    
    return {
        AvsResultCode,
        AvsResultText: AvsResultCode === 'Y' ? 'Address & ZIP match' : 'AVS Not Requested.',
        CvvResultCode,
        CvvResultText: CvvResultCode === 'M' ? 'CVV Match' : 'CVV No Match'
    };
}

// --- Router with comprehensive command support ---------------------------
async function route(sock, obj) {
    if (obj.message === 'ACK') {
        console.log('<< ACK received from POS');
        return;
    }

    const cmd = obj.data?.command;
    if (!cmd) {
        console.log('!! No command specified in request');
        return;
    }

    console.log(`>> Processing command: ${cmd}`);

    try {
        switch (cmd) {
            case 'Ping':
                return handlePing(sock, obj);
            
            case 'Sale':
            case 'CreditSale':
                return handleSale(sock, obj);
            
            case 'PreAuth':
            case 'PreAuthorization':
                return handlePreAuth(sock, obj);
            
            case 'TipAdjust':
            case 'TipAdjustment':
                return handleTipAdjust(sock, obj);
            
            case 'Void':
            case 'VoidTransaction':
                return handleVoid(sock, obj);
            
            case 'Refund':
            case 'CreditRefund':
                return handleRefund(sock, obj);
            
            case 'EOD':
            case 'EODProcessing':
            case 'BatchClose':
            case 'Batch':
                return handleBatchClose(sock, obj);
            
            case 'StatusInquiry':
            case 'TransactionStatus':
                return handleStatusInquiry(sock, obj);
            
            case 'BatchInquiry':
            case 'BatchStatus':
                return handleBatchInquiry(sock, obj);
            
            case 'TransactionList':
            case 'TransactionHistory':
                return handleTransactionList(sock, obj);
            
            case 'SystemReset':
            case 'Reset':
                return handleSystemReset(sock, obj);
            
            default:
                sendAck(sock);
                console.log(`!! Unsupported command: ${cmd}`);
                return setTimeout(() => sendMsg(sock, {
                    requestId: String(obj.data?.requestId || ''),
                    EcrId: String(obj.data?.EcrId || ECR_ID)
                }, cmd, resultFailed("CMD001", `UNSUPPORTED COMMAND: ${cmd}`)), 100);
        }
    } catch (error) {
        console.error(`!! Error processing ${cmd}:`, error);
        sendAck(sock);
        setTimeout(() => sendMsg(sock, {
            requestId: String(obj.data?.requestId || ''),
            EcrId: String(obj.data?.EcrId || ECR_ID)
        }, cmd, resultFailed("SYS999", `SYSTEM ERROR: ${error.message}`)), 100);
    }
}

// --- TCP Server with enhanced connection handling ------------------------
const server = net.createServer(socket => {
    const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`== CLIENT CONNECTED: ${clientId} ==`);
    
    let acc = Buffer.alloc(0);
    let messageCount = 0;

    socket.on('data', chunk => {
        acc = Buffer.concat([acc, chunk]);
        
        while (true) {
            const s = acc.indexOf(STX);
            const e = acc.indexOf(ETX, s + 1);
            
            if (s === -1 || e === -1) break;

            const raw = acc.slice(s + 1, e);
            const text = strip(raw);
            messageCount++;
            
            console.log(`>> [${clientId}] MSG ${messageCount}: ${text.substring(0, 200)}${text.length > 200 ? '...' : ''}`);

            try {
                const obj = JSON.parse(text);
                route(socket, obj);
            } catch (err) {
                console.error(`!! [${clientId}] JSON PARSE ERROR:`, err.message);
                sendAck(socket);
                sendMsg(socket, { EcrId: ECR_ID }, "Error", 
                       resultFailed("JSON001", "INVALID JSON FORMAT"));
            }
            
            acc = acc.slice(e + 1);
        }
    });

    socket.on('close', () => {
        console.log(`== CLIENT DISCONNECTED: ${clientId} (${messageCount} messages processed) ==`);
    });

    socket.on('error', err => {
        console.error(`!! [${clientId}] SOCKET ERROR:`, err.message);
    });

    // Send welcome message
    setTimeout(() => {
        console.log(`<< Sending welcome ping to ${clientId}`);
        const welcomeMsg = {
            message: "MSG",
            data: {
                EcrId: ECR_ID,
                response: "SystemReady",
                cmdResult: resultSuccess(),
                systemInfo: {
                    serverVersion: "1.0.0",
                    currentBatch: store.data.currentBatch.id,
                    uptime: process.uptime(),
                    totalTransactions: store.data.transactions.length
                }
            }
        };
        socket.write(frame(welcomeMsg));
    }, 1000);
});

// --- Server startup and graceful shutdown --------------------------------
server.listen(LISTEN_PORT, () => {
    // const h= `${store.data.currentBatch?.id.padEnd(15)} Transactions: ${store.data.transactions.length.toString().padStart(8)}`
    console.log(`
╔═══════════════════════════════════════════════════════════════════════════════╗
║                    COMPREHENSIVE VERIFONE MOCK SERVER                        ║
║                                                                               ║
║  Port: ${LISTEN_PORT.toString().padEnd(10)} ECR ID: ${ECR_ID.padEnd(10)} Data File: verifone-transactions.json  ║
║                                                                               ║
║  Features:                                                                    ║
║  • Complete transaction lifecycle (Pending → Approved → Settled)             ║
║  • Comprehensive transaction types (Sale, PreAuth, Void, Refund, TipAdjust)  ║
║  • Batch management with automatic settlement on EOD                         ║
║  • Persistent storage in JSON format                                         ║
║  • Transaction tracking by reference number, tran ID, or response ID         ║
║  • Detailed reporting and statistics                                         ║
║  • System reset capabilities (soft/hard)                                     ║
║  • Transaction history and status inquiries                                  ║
║  • AVS/CVV validation for manual entry                                       ║
║  • EMV support for chip transactions                                         ║
║  • Partial approval simulation                                               ║
║  • Comprehensive error handling                                              ║
║                                                                               ║
║  Current Batch:                                                ║
╚═══════════════════════════════════════════════════════════════════════════════╝
    `);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n== SHUTTING DOWN SERVER ==');
    store.saveData();
    server.close(() => {
        console.log('== SERVER STOPPED ==');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('\n== RECEIVED SIGTERM ==');
    store.saveData();
    server.close(() => {
        console.log('== SERVER STOPPED ==');
        process.exit(0);
    });
});

// Auto-save every 30 seconds
setInterval(() => {
    store.saveData();
}, 30000);

console.log('== LOADING TRANSACTION STORE ==');