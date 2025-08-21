// Simple Electron renderer script that calls your local agent server (http://localhost:3000)

const logArea = document.getElementById('logArea');
const $ = (id) => document.getElementById(id);

function log(line = '') {
  logArea.textContent += (logArea.textContent ? '\n' : '') + line;
  logArea.scrollTop = logArea.scrollHeight;
}
function reset(msg = 'Running…') { logArea.textContent = msg; }

function baseConn() {
  const ip   = $('ip').value.trim();
  const port = Number($('port').value.trim());
  const ecr  = $('ecr').value.trim();
  return { ip, port, ecrId: ecr };
}

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

async function postJSON(path, body) {
  const r = await fetch(`http://localhost:3000${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

function renderResult(title, data) {
  log(`\n== ${title} RESULT ==`);
  log(JSON.stringify(data, null, 2));
  if (data && data.log) {
    log('\n--- Debug log ---');
    for (const entry of data.log) {
      const line = `[${entry.t}] ${entry.type}: ${entry.msg}` + (entry.data ? ` ${typeof entry.data === 'string' ? entry.data : JSON.stringify(entry.data)}` : '');
      log(line);
    }
  }
}

/* -------- Availability & Ping -------- */

$('btnAvail').addEventListener('click', async () => {
  reset();
  const { ip, port } = baseConn();
  try {
    const data = await getJSON(`http://localhost:3000/availability?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}`);
    renderResult('Availability', data);
  } catch (e) { log('ERROR: ' + e.message); }
});

$('btnPing').addEventListener('click', async () => {
  reset();
  const { ip, port, ecrId } = baseConn();
  try {
    const data = await getJSON(`http://localhost:3000/ping?ip=${encodeURIComponent(ip)}&port=${encodeURIComponent(port)}&ecrId=${encodeURIComponent(ecrId)}`);
    renderResult('Ping', data);
  } catch (e) { log('ERROR: ' + e.message); }
});

/* -------- Sale -------- */

$('btnSale').addEventListener('click', async () => {
  reset();
  const { ip, port, ecrId } = baseConn();
  const baseAmount = $('saleBase').value.trim();
  const tipAmount  = $('saleTip').value.trim();
  const taxAmount  = $('saleTax').value.trim();
  const invoiceNbr = $('saleInvoice').value.trim();
  const allowPartialAuth = $('saleAllowPartial').value.trim();

  const payload = {
    ip, port, ecrId,
    sale: {
      params: {},
      transaction: {
        baseAmount
      }
    }
  };
  if (tipAmount) payload.sale.transaction.tipAmount = tipAmount;
  if (taxAmount) payload.sale.transaction.taxAmount = taxAmount;
  if (invoiceNbr) payload.sale.transaction.invoiceNbr = invoiceNbr;
  if (allowPartialAuth !== '') payload.sale.transaction.allowPartialAuth = Number(allowPartialAuth);

  try {
    const data = await postJSON('/sale', payload);
    renderResult('Sale', data);
  } catch (e) { log('ERROR: ' + e.message); }
});

/* -------- PreAuth (with optional lodging) -------- */

$('btnPreAuth').addEventListener('click', async () => {
  reset();
  const { ip, port, ecrId } = baseConn();
  const amount = $('paAmount').value.trim();
  const clerkId = $('paClerk').value.trim();

  const lod = {};
  if ($('lodFolio').value.trim()) lod.folioNumber = $('lodFolio').value.trim();
  if ($('lodStay').value.trim())  lod.stayDuration = $('lodStay').value.trim();
  if ($('lodIn').value.trim())    lod.checkInDate  = $('lodIn').value.trim();
  if ($('lodOut').value.trim())   lod.checkOutDate = $('lodOut').value.trim();
  if ($('lodRate').value.trim())  lod.dailyRate    = $('lodRate').value.trim();
  if ($('lodPref').value.trim())  lod.preferredCustomer = $('lodPref').value.trim();

  const hasLodging = Object.keys(lod).length > 0;

  const payload = {
    ip, port, ecrId,
    preauth: {
      params: {},
      transaction: { amount }
    }
  };
  if (clerkId) payload.preauth.params.clerkId = clerkId;
  if (hasLodging) payload.preauth.lodging = lod;

  try {
    const data = await postJSON('/preauth', payload);
    renderResult('PreAuth', data);
  } catch (e) { log('ERROR: ' + e.message); }
});

/* -------- Void -------- */

$('btnVoid').addEventListener('click', async () => {
  reset();
  const { ip, port, ecrId } = baseConn();
  const tranNo  = $('voidTranNo').value.trim();
  const ref     = $('voidRef').value.trim();
  const invoice = $('voidInvoice').value.trim();
  const clerkId = $('voidClerk').value.trim();

  const payload = {
    ip, port, ecrId,
    void: {
      params: {},
      transaction: {}
    }
  };
  if (tranNo)  payload.void.transaction.tranNo = tranNo;
  if (ref)     payload.void.transaction.referenceNumber = ref;
  if (invoice) payload.void.transaction.invoiceNbr = invoice;
  if (clerkId) payload.void.params.clerkId = clerkId;

  try {
    const data = await postJSON('/void', payload);
    renderResult('Void', data);
  } catch (e) { log('ERROR: ' + e.message); }
});

/* -------- Refund -------- */

$('btnRefund').addEventListener('click', async () => {
  reset();
  const { ip, port, ecrId } = baseConn();
  const total   = $('rfTotal').value.trim();
  const ref     = $('rfRef').value.trim();
  const invoice = $('rfInvoice').value.trim();
  const clerkId = $('rfClerk').value.trim();

  const payload = {
    ip, port, ecrId,
    refund: {
      params: {},
      transaction: { totalAmount: total }
    }
  };
  if (ref)     payload.refund.transaction.referenceNumber = ref;
  if (invoice) payload.refund.transaction.invoiceNbr = invoice;
  if (clerkId) payload.refund.params.clerkId = clerkId;

  try {
    const data = await postJSON('/refund', payload);
    renderResult('Refund', data);
  } catch (e) { log('ERROR: ' + e.message); }
});

/* -------- Tip Adjust -------- */

$('btnTipAdjust').addEventListener('click', async () => {
  reset();
  const { ip, port, ecrId } = baseConn();
  const tip     = $('taTip').value.trim();
  const ref     = $('taRef').value.trim();
  const tranNo  = $('taTranNo').value.trim();
  const invoice = $('taInvoice').value.trim();

  const payload = {
    ip, port, ecrId,
    tipAdjust: {
      params: {},
      transaction: { tipAmount: tip }
    }
  };
  if (ref)     payload.tipAdjust.transaction.referenceNumber = ref;
  if (tranNo)  payload.tipAdjust.transaction.tranNo = tranNo;
  if (invoice) payload.tipAdjust.transaction.invoiceNbr = invoice;

  try {
    const data = await postJSON('/tip-adjust', payload);
    renderResult('Tip Adjust', data);
  } catch (e) { log('ERROR: ' + e.message); }
});

/* -------- Batch Close (EOD) -------- */

$('btnBatchClose').addEventListener('click', async () => {
  reset();
  const { ip, port, ecrId } = baseConn();
  console.log("hii this is btnBatchClose")
  const payload = { ip, port, ecrId, data: {} };
  try {
    const data = await postJSON('/batch-close', payload);
    renderResult('Batch Close', data);
  } catch (e) { log('ERROR: ' + e.message); }
});

$('btnManualSale').addEventListener('click', async () => {
  reset();
  const { ip, port, ecrId } = baseConn();
  console.log("hii this is VbtnBatchClose")
  const payload = { ip, port, ecrId, data: {} };
  try {
    const data = await postJSON('/batch-close', payload);
    renderResult('Batch Close', data);
  } catch (e) { log('ERROR: ' + e.message); }
});
