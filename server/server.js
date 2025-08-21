// server/server.js
'use strict';
const { log } = require('console');
const express = require('express');
const net = require('net');

const app = express();
app.use(express.json()); // accept JSON POST bodies

const HTTP_PORT = process.env.AGENT_HTTP_PORT || 3000;

// Defaults (override via env or per-request query/body)
let CONFIG = {
  terminalIp: process.env.TERMINAL_IP || '192.168.1.91',
  primaryPort: Number(process.env.TERMINAL_PORT || 8081),
  altPort: Number(process.env.TERMINAL_PORT_ALT || 8080),
  ecrId: process.env.ECR_ID || '13',
  connectTimeoutMs: Number(process.env.CONNECT_TIMEOUT_MS || 5000),
  readTimeoutMs: Number(process.env.READ_TIMEOUT_MS || 180000),      // 3 min ceiling
  idleByteTimeoutMs: Number(process.env.IDLE_BYTE_TIMEOUT_MS || 25000), // 25s no-activity cutoff
};





// Framing bytes: <STX><LF> JSON <LF><ETX><LF>
const STX = 0x02, LF = 0x0A, ETX = 0x03;

// Utilities
const as2dp = (v) => (Number.isFinite(v) ? v : parseFloat(v)).toFixed(2);       // 12.34
const reqId = (digits = 6) => String(Date.now() % (10 ** digits)).padStart(digits, '0'); // 6–10 digits
const frameJson = (obj) => {
  const j = Buffer.from(JSON.stringify(obj), 'ascii');
  return Buffer.concat([Buffer.from([STX, LF]), j, Buffer.from([LF, ETX, LF])]);
};
const stripFrame = (buf) => buf.toString('ascii').replace(/[\x02\x03\x0A\x0D\x00]/g, '').trim();

class FrameAccumulator {
  constructor(onFrame) { this.onFrame = onFrame; this.buf = Buffer.alloc(0); }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    // find <STX> ... <ETX> windows repeatedly
    while (true) {
      const s = this.buf.indexOf(STX);
      if (s < 0) { this.buf = Buffer.alloc(0); return; }
      const e = this.buf.indexOf(ETX, s + 1);
      if (e < 0) { if (s > 0) this.buf = this.buf.slice(s); return; }
      const raw = this.buf.slice(s + 1, e);
      this.onFrame(stripFrame(raw), raw);
      this.buf = this.buf.slice(e + 1);
    }
  }
}

// Low-level TCP call with ACK/MSG/ACK handling


function sendCommandTcp({ ip, port, payload, timeouts }) {
  return new Promise((resolve) => {
    const log = [];
    const ev = (type, msg, data) => log.push({ t: new Date().toISOString(), type, msg, data });
    const sock = new net.Socket();
    let finished = false;

    const connectMs = timeouts.connect ?? CONFIG.connectTimeoutMs;
    const readMs    = timeouts.read    ?? CONFIG.readTimeoutMs;
    const idleMs    = timeouts.idle    ?? CONFIG.idleByteTimeoutMs;

    let overallTimer, idleTimer;
    function armOverall() { clearTimeout(overallTimer); overallTimer = setTimeout(() => done('read-timeout'), readMs); }
    function armIdle()    { clearTimeout(idleTimer);    idleTimer    = setTimeout(() => done('idle-timeout'), idleMs); }
    function clearTimers(){ clearTimeout(overallTimer); clearTimeout(idleTimer); }

    function done(error, rsp) {
      if (finished) return;
      finished = true;
      clearTimers();
      try { sock.destroy(); } catch {}
      if (error) return resolve({ ok: false, error, log });
      resolve({ ok: true, rsp, log });
    }

    // Accumulate raw chunks
    let buffer = Buffer.alloc(0);
    function processFrames() {
      const s = buffer.indexOf(STX);
      const e = buffer.indexOf(ETX, s+1);
      if (s !== -1 && e !== -1) {
        const raw = buffer.slice(s+1, e);
        buffer = buffer.slice(e+1);
        const text = raw.toString('utf8').trim();
        if (!text) return;
        ev('recv-json', text);
        let obj; try { obj = JSON.parse(text); } catch { ev('warn','Non-JSON'); return; }

        if (obj.message === 'ACK') { ev('event','ACK from terminal'); return; }
        if (['EVT','DSP','PIN','CNF','READY'].includes(obj.message)) {
          ev('event', `progress ${obj.message}`, obj); return;
        }
        if (obj.message === 'RSP' || obj.message === 'ERR' || obj.message === 'MSG') {
          // Final responses depending on firmware
          return done(null, obj);
        }
        ev('event', `Unhandled ${obj.message}`, obj);
      }
    }

    sock.on('data', (chunk) => {
      ev('recv-bytes', chunk.toString('hex'));
      buffer = Buffer.concat([buffer, chunk]);
      armIdle();
      processFrames();
    });
    sock.on('error', (err) => { ev('error', err.message); done(err.message); });

    const connectGuard = setTimeout(() => { done('connect-timeout'); }, connectMs);

    sock.connect(port, ip, () => {
      clearTimeout(connectGuard);
      ev('event', `TCP CONNECT ${ip}:${port}`);
      const frame = frameJson(payload);
      sock.write(frame);
      ev('send-json', JSON.stringify(payload));
      ev('send-bytes', [...frame].map(b => '0x'+b.toString(16).padStart(2,'0')).join(' '));
      armOverall(); armIdle();
    });
  });
}


// Build standard envelope
function buildEnvelope(command, ecrId, requestId, dataObj) {
  return {
    message: 'MSG',
    data: { command, EcrId: ecrId, requestId, ...(dataObj ? { data: dataObj } : {}) }
  };
}

// Availability probe (TCP connect only)
function checkAvailability(ip, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (ok, info) => { if (done) return; done = true; try { sock.destroy(); } catch { }; resolve({ ok, info }); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true, `Connected to ${ip}:${port}`));
    sock.once('timeout', () => finish(false, `Timeout connecting to ${ip}:${port}`));
    sock.once('error', (err) => finish(false, `Error: ${err.message}`));
    sock.connect(port, ip);
  });
}

/* ======================== HTTP API ======================== */

// Health & availability
app.get('/health', async (req, res) => {
  const ip = req.query.ip || CONFIG.terminalIp;
  const port = Number(req.query.port || CONFIG.primaryPort);
  const a = await checkAvailability(ip, port, CONFIG.connectTimeoutMs);
  res.json({ ok: a.ok, info: a.info, config: CONFIG });
});
app.get('/availability', async (req, res) => {
  const ip = req.query.ip || CONFIG.terminalIp;
  const port = Number(req.query.port || CONFIG.primaryPort);
  const a = await checkAvailability(ip, port, CONFIG.connectTimeoutMs);
  res.json(a);
});

// Ping
app.get('/ping', async (req, res) => {
  const ip = req.query.ip || CONFIG.terminalIp;
  const port = Number(req.query.port || CONFIG.primaryPort);
  const ecrId = req.query.ecrId || CONFIG.ecrId;
  const requestId = reqId(6);

  const payload = buildEnvelope('Ping', ecrId, requestId, null);
  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});
// LOCATION: server.js (or routes/pos.js) — replace the whole /sale handler
app.post('/sale', async (req, res) => {
  try {
    // --- 1) Accept BOTH shapes: top-level OR nested under "sale" (renderer uses this) ---
    const body = req.body || {};
    console.log("req.body" , req.body)
    const nested = body.sale || {};
    const conn = {
      ip:   body.ip   ?? CONFIG.terminalIp,
      port: body.port ?? CONFIG.primaryPort,
      ecrId: String(body.ecrId ?? CONFIG.ecrId),
    };

    // Merge precedence: nested > top-level (so renderer wins)
    const params = { ...(body.params || {}), ...(nested.params || {}) };
    const transaction =   req.body.sale.transaction
    
    // --- 2) Validate & normalize amounts for real transaction ---
    if (transaction.baseAmount == null) {
      return res.status(400).json({ success: false, message: 'baseAmount is required' });
    }
    transaction.baseAmount = as2dp(transaction.baseAmount);
    if (transaction.tipAmount != null)  transaction.tipAmount  = as2dp(transaction.tipAmount);
    if (transaction.taxAmount != null)  transaction.taxAmount  = as2dp(transaction.taxAmount);
    if (transaction.cashBackAmount != null) transaction.cashBackAmount = as2dp(transaction.cashBackAmount);

    // Defaults commonly required for live SALE on Verifone JSON ECR
    if (transaction.taxIndicator == null)   transaction.taxIndicator = '0'; // 0 = non-taxable line, per many setups
    if (transaction.allowDuplicate == null) transaction.allowDuplicate = 0; // safer default (enable = 1 if you retry same amount quickly)

    // UI sends allowPartialAuth as "0" | "1" – keep it numeric if present
    if (transaction.allowPartialAuth != null) {
      transaction.allowPartialAuth = Number(transaction.allowPartialAuth) ? 1 : 0;
    }

    // Optional fields commonly used in live flows
    // invoiceNbr, tipAmount, taxAmount already supported by UI

    // Note: card data is captured on terminal; if UI sends cardType/expiryDate we pass through (terminal usually ignores)
    // params: { clerkId, cardType, expiryDate, ... }

    // --- 3) Build envelope exactly as terminal expects ---
    const requestId = reqId(6); // keep your existing generator
    const dataObj = { params, transaction };
    const payload = buildEnvelope('Sale', conn.ecrId, requestId, dataObj);


    


const timeouts =  {
  connect: CONFIG.connectTimeoutMs,
  read:  CONFIG.readTimeoutMs,
  idle: CONFIG.idleByteTimeoutMs
}


console.log(payload)

    // --- 4) Send over TCP to terminal ---
    const out = await sendCommandTcp({
      ip: conn.ip,
      port: conn.port,
      payload,
      timeouts,
    });

    // --- 5) Return result + requestId + debug log ---
    return res.json({ success: true, requestId, ...out });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message || 'Sale failed' });
  }
});




// Sale (lodging add-on fields)
app.post('/sale/lodging', async (req, res) => {
  const {
    ip = CONFIG.terminalIp,
    port = CONFIG.primaryPort,
    ecrId = CONFIG.ecrId,
    params = {},            // { clerkId, ... }
    transaction = {
  "baseAmount": 4.00,
  "tipAmount": 0.00,
  "taxAmount": 1.00,
  "taxIndicator": 0,
  "cashBackAmount": 0.00,
  "allowDuplicate": 1
},      // { baseAmount, tipAmount, taxAmount, taxIndicator, ... }
    lodging = {},           // { folioNumber, stayDuration, checkInDate, checkOutDate, dailyRate, preferredCustomer, extraChargeTypes, extraChargeTotal, advanceDepositType, noShow, cardBrandTransID }
  } = req.body || {};

  // Amount normalization
  ['baseAmount', 'tipAmount', 'taxAmount', 'cashBackAmount'].forEach(k => {
    if (transaction[k] != null) transaction[k] = as2dp(transaction[k]);
  });
  if (lodging.dailyRate != null) lodging.dailyRate = as2dp(lodging.dailyRate);
  if (lodging.extraChargeTotal != null) lodging.extraChargeTotal = as2dp(lodging.extraChargeTotal);

  const requestId = reqId(6);
  const dataObj = { params, transaction, lodging };
  const payload = buildEnvelope('Sale', String(ecrId), requestId, dataObj);

  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});

// PreAuth (lodging check-in / incremental auth supported)
app.post('/preauth', async (req, res) => {
  const {
    ip = CONFIG.terminalIp,
    port = CONFIG.primaryPort,
    ecrId = CONFIG.ecrId,
    params = {},            // e.g. { clerkId, cardType, expiryDate }
    transaction = {},       // { amount, preAuthAmount, referenceNumber, allowDuplicate, ... }
    lodging = {},           // same lodging object as /sale/lodging
  } = req.body || {};

  if (transaction.amount != null) transaction.amount = as2dp(transaction.amount);
  if (transaction.preAuthAmount != null) transaction.preAuthAmount = as2dp(transaction.preAuthAmount);
  if (lodging.dailyRate != null) lodging.dailyRate = as2dp(lodging.dailyRate);
  if (lodging.extraChargeTotal != null) lodging.extraChargeTotal = as2dp(lodging.extraChargeTotal);

  const requestId = reqId(6);
  const dataObj = { params, transaction, ...(Object.keys(lodging).length ? { lodging } : {}) };
  const payload = buildEnvelope('PreAuth', String(ecrId), requestId, dataObj);

  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});

// Auth Completion / Close Tab (check-out)
app.post('/auth-completion', async (req, res) => {
  const {
    ip = CONFIG.terminalIp,
    port = CONFIG.primaryPort,
    ecrId = CONFIG.ecrId,
    params = {},
    transaction = {},     // typically includes { referenceNumber, amount, tipAmount, ... } per your UPA guide section
  } = req.body || {};

  if (transaction.amount != null) transaction.amount = as2dp(transaction.amount);
  if (transaction.tipAmount != null) transaction.tipAmount = as2dp(transaction.tipAmount);

  const requestId = reqId(6);
  const dataObj = { params, transaction };
  const payload = buildEnvelope('AuthCompletion', String(ecrId), requestId, dataObj);

  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});

// Void (cannot void PreAuth per guide; requires tranNo or referenceNumber)
app.post('/void', async (req, res) => {

   const  ip = CONFIG.terminalIp;
   const  port = CONFIG.primaryPort;
   const  ecrId = CONFIG.ecrId;
   const  params = { };    // { clerkId }
   const  transaction = {
      tranNo : req.body.void.transaction.tranNo
    }    // { tranNo } OR { referenceNumber }
  

//   {
// "message": "MSG",
// "data": {
// "command": "Void",
// "EcrId": "123",
// "requestId":"12",
// "data": {
// "params": {
// "clerkId":"1234"
// },
// "transaction": {
// "tranNo":"1234"
// }
// }
// }
// }

  const requestId = reqId(6);
  const dataObj = { params, transaction };
  const payload = buildEnvelope('Void', String(ecrId), requestId, dataObj);
console.log("************",payload)
  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});

// Refund
app.post('/refund', async (req, res) => {
  const {
    ip = CONFIG.terminalIp,
    port = CONFIG.primaryPort,
    ecrId = CONFIG.ecrId,
    params = {},            // { clerkId, tokenRequest, tokenValue, cardType, expiryDate, ... }
    transaction = {},       // { totalAmount, invoiceNbr, allowDuplicate, ... }
  } = req.body || {};

  if (transaction.totalAmount != null) transaction.totalAmount = as2dp(transaction.totalAmount);

  const requestId = reqId(6);
  const dataObj = { params, transaction };
  const payload = buildEnvelope('Refund', String(ecrId), requestId, dataObj);

  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});

// Tip Adjust
app.post('/tip-adjust', async (req, res) => {
  const {
    ip = CONFIG.terminalIp,
    port = CONFIG.primaryPort,
    ecrId = CONFIG.ecrId,
    params = {},            // { clerkId }
    transaction = {},       // { tranNo or referenceNumber, tipAmount }
  } = req.body || {};

  if (transaction.tipAmount != null) transaction.tipAmount = as2dp(transaction.tipAmount);

  const requestId = reqId(6);
  const dataObj = { params, transaction };
  const payload = buildEnvelope('TipAdjust', String(ecrId), requestId, dataObj);

  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});

// Batch Close / EOD (command name may vary in your guide; allow override)
app.post('/batch-close', async (req, res) => {
  const {
    ip = CONFIG.terminalIp,
    port = CONFIG.primaryPort,
    ecrId = CONFIG.ecrId,
    command = 'EODProcessing', // override if your guide uses a different verb
    data = {
      command,
      ecrId,
      requestId
    }               // pass-through structure if required by your build
  } = req.body || {};



  const requestId = reqId(6);
  const payload = buildEnvelope(command, String(ecrId), requestId, data);

  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});

// Generic command helper (for any UPA command)
app.post('/command', async (req, res) => {
  const {
    ip = CONFIG.terminalIp,
    port = CONFIG.primaryPort,
    ecrId = CONFIG.ecrId,
    command,            // REQUIRED
    data = {},          // { params?, transaction?, lodging?, ... } per section
    requestId = reqId(6),
  } = req.body || {};
  if (!command) return res.status(400).json({ ok: false, error: 'Missing command' });

  const payload = buildEnvelope(command, String(ecrId), String(requestId), data);
  const out = await sendCommandTcp({
    ip, port, payload,
    timeouts: { connect: CONFIG.connectTimeoutMs, read: CONFIG.readTimeoutMs }
  });
  res.json({ requestId, ...out });
});

// Update runtime defaults (optional)
app.post('/config', (req, res) => {
  CONFIG = { ...CONFIG, ...(req.body || {}) };
  res.json({ ok: true, CONFIG });
});

app.listen(HTTP_PORT, () => {
  console.log(`Agent listening on http://localhost:${HTTP_PORT}`);
  console.log(`Default terminal ${CONFIG.terminalIp}:${CONFIG.primaryPort} (alt ${CONFIG.altPort}), ECR=${CONFIG.ecrId}`);
});
