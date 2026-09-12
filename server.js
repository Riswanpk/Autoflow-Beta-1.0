import express from 'express';
import axios from 'axios';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';

dotenv.config();
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.get('/checkout', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

const PORT = process.env.PORT || 3000;
const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const db = new Database('orders.db');
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  phone TEXT,
  name TEXT,
  cans INTEGER,
  address TEXT,
  base_amount REAL,
  decentro_fee REAL,
  platform_fee REAL,
  total_amount REAL,
  payment_status TEXT DEFAULT 'CREATED',
  decentro_txn_id TEXT,
  payout_status TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
)`);

const money = n => Math.round(Number(n) * 100) / 100;
function pricing(cans) {
  const base = money(cans * Number(process.env.CAN_PRICE || 50));
  const dfee = money(Number(process.env.DECENTRO_FEE || 3));
  const pfee = money(base * Number(process.env.PLATFORM_FEE_PERCENT || 2) / 100);
  // Fees are settlement deductions; the customer pays only the order amount.
  return { base, dfee, pfee, total: base };
}

function getUpiUri(value) {
  if (typeof value === 'string' && /^(upi|https?):\/\//i.test(value)) return value;
  if (Array.isArray(value)) return value.map(getUpiUri).find(Boolean) || null;
  if (value && typeof value === 'object') {
    return [value.common_uri, value.gpay_uri, value.phonepe_uri, value.paytm_uri]
      .map(getUpiUri).find(Boolean) || null;
  }
  return null;
}

function validateDecentroConfig() {
  const required = ['DECENTRO_BASE_URL', 'DECENTRO_CLIENT_ID', 'DECENTRO_CLIENT_SECRET', 'DECENTRO_CONSUMER_URN'];
  const missing = required.filter(name => !process.env[name]?.trim());
  if (missing.length) return `Missing Decentro configuration: ${missing.join(', ')}`;
  try { new URL(process.env.DECENTRO_BASE_URL); }
  catch { return 'DECENTRO_BASE_URL must be a valid HTTPS URL'; }
  return null;
}

function payuHash(fields, splitRequest = '') {
  const values = ['key', 'txnid', 'amount', 'productinfo', 'firstname', 'email', 'udf1', 'udf2', 'udf3', 'udf4', 'udf5']
    .map(name => fields[name] || '');
  const hashInput = `${values.join('|')}||||||${fields.salt}${splitRequest ? `|${splitRequest}` : ''}`;
  return crypto.createHash('sha512').update(hashInput).digest('hex');
}

function htmlEscape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[character]);
}

function payuConfigError() {
  const required = ['PAYU_KEY', 'PAYU_SALT', 'PAYU_EMAIL'];
  const missing = required.filter(name => !process.env[name]?.trim());
  return missing.length ? `Missing PayU configuration: ${missing.join(', ')}` : null;
}

function verifyPayuResponse(data) {
  if (!data.hash || !process.env.PAYU_SALT) return false;
  const prefix = data.additionalCharges ? `${data.additionalCharges}|` : '';
  const splitInfo = data.splitInfo || '';
  const input = `${prefix}${process.env.PAYU_SALT}|${data.status}|${splitInfo}||||||${data.udf5 || ''}|${data.udf4 || ''}|${data.udf3 || ''}|${data.udf2 || ''}|${data.udf1 || ''}|${data.email || ''}|${data.firstname || ''}|${data.productinfo || ''}|${data.amount || ''}|${data.txnid || ''}|${data.key || ''}`;
  const expected = crypto.createHash('sha512').update(input).digest('hex');
  const received = String(data.hash).toLowerCase();
  return received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function mockPayuSplit(orderId, payuId) {
  const platformPercent=Number(process.env.PAYU_TEST_PLATFORM_PERCENT || 2);
  const mainPercent=100 - platformPercent;
  return {
    status: 1,
    message: 'Test split created locally. No money was moved.',
    splitStatus: 'success',
    test: true,
    var1: {
      type: 'percentage',
      payuId,
      splitInfo: {
        TEST_PLATFORM_MERCHANT: { aggregatorSubTxnId: `TEST-PLATFORM-${orderId}`, aggregatorSubAmt: platformPercent.toFixed(2) },
        TEST_MAIN_MERCHANT: { aggregatorSubTxnId: `TEST-MAIN-${orderId}`, aggregatorSubAmt: mainPercent.toFixed(2) }
      }
    }
  };
}

async function waSend(payload) {
  const url = `https://graph.facebook.com/${process.env.WA_GRAPH_VERSION || 'v23.0'}/${process.env.WA_PHONE_NUMBER_ID}/messages`;
  return axios.post(url, payload, { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type':'application/json' } });
}

async function sendBookingTemplate(phone, ref, name) {
  return waSend({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: process.env.WA_BOOK_TEMPLATE_NAME,
      language: {
        code: process.env.WA_TEMPLATE_LANG || 'en_US'
      },
      components: [
        {
          type: 'body',
          parameters: [
            {
              type: 'text',
              text: name || 'Customer'
            }
          ]
        },
        {
          type: 'button',
          sub_type: 'url',
          index: '0',
          parameters: [
            {
              type: 'text',
              text: ref
            }
          ]
        }
      ]
    }
  });
}

async function sendConfirmation(phone, order) {
  const text = `✅ Order confirmed!\nOrder: ${order.id}\nCans: ${order.cans}\nAmount paid: ₹${order.total_amount}\nDelivery: ${order.address}`;
  return waSend({ messaging_product:'whatsapp', to:phone, type:'text', text:{body:text} });
}

function authAdmin(req,res,next){
  const h=req.headers.authorization||'';
  const expected='Basic '+Buffer.from(`${process.env.ADMIN_USER||'admin'}:${process.env.ADMIN_PASSWORD||'demo123'}`).toString('base64');
  if(h!==expected){ res.set('WWW-Authenticate','Basic realm="Water Can Admin"'); return res.status(401).send('Login required'); }
  next();
}

// Meta webhook verification
app.get('/webhook', (req,res)=>{
  const mode=req.query['hub.mode']; const token=req.query['hub.verify_token']; const challenge=req.query['hub.challenge'];
  if(mode==='subscribe' && token===process.env.WA_VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// Meta incoming messages
app.post('/webhook', async (req,res)=>{
  res.sendStatus(200); // acknowledge fast
  try {
    const entry=req.body.entry?.[0]; const value=entry?.changes?.[0]?.value; const msg=value?.messages?.[0];
    if(!msg || msg.type!=='text') return;
    const phone=msg.from;
    const name=value?.contacts?.[0]?.profile?.name || 'Customer';
    const ref=nanoid(10);
    db.prepare(`INSERT INTO orders(id,phone,name,payment_status) VALUES(?,?,?,?)`).run(ref,phone,name,'CHAT_STARTED');
    await sendBookingTemplate(phone, ref, name);
  } catch(e){ console.error('WA webhook error', e.response?.data || e.message); }
});

// Checkout page data
app.get('/api/pricing',(req,res)=>{ const qty=Number(req.query.cans||1); if(!Number.isInteger(qty)||qty<1||qty>20) return res.status(400).json({error:'Invalid quantity'}); res.json(pricing(qty)); });

app.get('/api/checkout/:id',(req,res)=>{
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if(!o) return res.status(404).json({error:'Order not found'});
  res.json({id:o.id, phone:o.phone, name:o.name, cans:o.cans||1, address:o.address||'', pricing:pricing(o.cans||1), payment_status:o.payment_status});
});

app.post('/api/order/:id', async (req,res)=>{
  const {cans,address}=req.body; const qty=Number(cans);
  if(!Number.isInteger(qty)||qty<1||qty>20) return res.status(400).json({error:'Cans must be 1-20'});
  if(!address || address.trim().length<8) return res.status(400).json({error:'Please enter a delivery address'});
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if(!o) return res.status(404).json({error:'Order not found'});
  const p=pricing(qty);
  db.prepare(`UPDATE orders SET cans=?,address=?,base_amount=?,decentro_fee=?,platform_fee=?,total_amount=?,payment_status='CHECKOUT_READY' WHERE id=?`).run(qty,address.trim(),p.base,p.dfee,p.pfee,p.total,req.params.id);
  res.json({id:req.params.id,pricing:p});
});

// Decentro payment-link creation
app.post('/api/order/:id/pay', async (req,res)=>{
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if(!o) return res.status(404).json({error:'Order not found'});
  if(!o.total_amount) return res.status(400).json({error:'Complete checkout first'});
  if (process.env.MOCK_PAYU_PAYMENT === 'true' || process.env.MOCK_DECENTRO === 'true') {
    const status=String(process.env.MOCK_DECENTRO_STATUS || 'SUCCESS').toUpperCase();
    const txn=`MOCK-${nanoid(8)}`;
    if (status === 'SUCCESS') {
      db.prepare(`UPDATE orders SET payment_status='PAID',decentro_txn_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(txn,o.id);
      if (process.env.PAYU_MOCK_SPLIT === 'true') {
        db.prepare(`UPDATE orders SET payout_status='SPLIT_TEST_SUCCESS' WHERE id=?`).run(o.id);
      }
      return res.json({ok:true,transaction_id:txn,payment_url:`${BASE}/success.html?ref=${encodeURIComponent(o.id)}`,mock:true});
    }
    if (status === 'PENDING') {
      db.prepare(`UPDATE orders SET payment_status='PAYMENT_LINK_CREATED',decentro_txn_id=? WHERE id=?`).run(txn,o.id);
      return res.status(202).json({ok:false,mock:true,error:'Mock payment is pending',transaction_id:txn});
    }
    db.prepare(`UPDATE orders SET payment_status='FAILED',decentro_txn_id=? WHERE id=?`).run(txn,o.id);
    return res.status(402).json({ok:false,mock:true,error:'Mock payment failed',transaction_id:txn});
  }
  const configError=payuConfigError();
  if(configError) return res.status(503).json({error:configError});
  try {
    const splitRequest=process.env.PAYU_SPLIT_REQUEST?.trim() || '';
    if (splitRequest) JSON.parse(splitRequest);
    const fields={
      key:process.env.PAYU_KEY,
      salt:process.env.PAYU_SALT,
      txnid:o.id,
      amount:o.total_amount.toFixed(2),
      productinfo:`WaterCan ${o.id}`,
      firstname:o.name || 'Customer',
      email:process.env.PAYU_EMAIL,
      phone:o.phone || '',
      api_version:splitRequest ? '7' : undefined,
      pg:'',
      bankcode:'',
      surl:`${BASE}/payu/success`,
      furl:`${BASE}/payu/failure`,
      udf1:o.id
    };
    if (splitRequest) fields.splitRequest=splitRequest;

    fields.hash=payuHash(fields,splitRequest);
    const paymentUrl=`${BASE}/payu/checkout/${encodeURIComponent(o.id)}`;
    db.prepare(`UPDATE orders SET payment_status='PAYMENT_LINK_CREATED',decentro_txn_id=? WHERE id=?`).run(o.id,o.id);
    res.json({ok:true,transaction_id:o.id,payment_url:paymentUrl,provider:'payu'});
  } catch(e){ console.error('PayU payment setup error',e.message); res.status(502).json({error:'PayU configuration error',details:e.message}); }
});

app.post('/api/order/:id/split', (req,res)=>{
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if(!o) return res.status(404).json({error:'Order not found'});
  if(o.payment_status!=='PAID') return res.status(400).json({error:'Payment must be successful before splitting'});
  if(process.env.PAYU_MOCK_SPLIT !== 'true') return res.status(503).json({error:'PayU split is not in test mode'});
  const payuId=req.body.payuId || `TEST-PAYU-${o.id}`;
  const result=mockPayuSplit(o.id,payuId);
  db.prepare(`UPDATE orders SET payout_status='SPLIT_TEST_SUCCESS' WHERE id=?`).run(o.id);
  res.json({ok:true,provider:'payu',result});
});

app.get('/payu/checkout/:id',(req,res)=>{
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if(!o || !o.total_amount) return res.status(404).send('Order not found or not ready');
  const splitRequest=process.env.PAYU_SPLIT_REQUEST?.trim() || '';
  const fields={key:process.env.PAYU_KEY,salt:process.env.PAYU_SALT,txnid:o.id,amount:o.total_amount.toFixed(2),productinfo:`WaterCan ${o.id}`,firstname:o.name||'Customer',email:process.env.PAYU_EMAIL,phone:o.phone||'',api_version:splitRequest?'7':undefined,pg:'',bankcode:'',surl:`${BASE}/payu/success`,furl:`${BASE}/payu/failure`,udf1:o.id};
  if(splitRequest) fields.splitRequest=splitRequest;
  fields.hash=payuHash(fields,splitRequest);
  const action=process.env.PAYU_BASE_URL || 'https://test.payu.in/_payment';
  const inputs=Object.entries(fields).filter(([,value])=>value !== undefined && value !== '').map(([name,value])=>`<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`).join('');
  res.send(`<!doctype html><html><body><p>Redirecting to PayU...</p><form id="payu" method="post" action="${htmlEscape(action)}">${inputs}</form><script>document.getElementById('payu').submit()</script></body></html>`);
});

app.post('/payu/success',(req,res)=>{
  const id=req.body.txnid; const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if(!o || String(req.body.status).toLowerCase()!=='success' || !verifyPayuResponse(req.body)) return res.status(400).send('Invalid PayU payment response');
  db.prepare(`UPDATE orders SET payment_status='PAID',decentro_txn_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.body.mihpayid||id,id);
  res.redirect(`/success.html?ref=${encodeURIComponent(id)}`);
});

app.post('/payu/failure',(req,res)=>{
  const id=req.body.txnid;
  if(id) db.prepare(`UPDATE orders SET payment_status='FAILED' WHERE id=?`).run(id);
  res.status(402).send('PayU payment failed. Please return to checkout and try again.');
});

// Decentro callback. Configure this exact URL in Decentro: /webhooks/decentro/payment
app.post('/webhooks/decentro/payment', async (req,res)=>{
  res.sendStatus(200);
  try{
    console.log('Decentro callback:',JSON.stringify(req.body));
    const b=req.body;
    const id=b.reference_id || b.referenceId || b.client_reference_id;
    const txn=b.decentro_txn_id || b.decentroTxnId;
    const status=String(b.transaction_status || b.transactionStatus || b.status || '').toUpperCase();
    if(!id) return;
    const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id); if(!o) return;
    if(status==='SUCCESS' || status==='SUCCEEDED'){
      db.prepare(`UPDATE orders SET payment_status='PAID',decentro_txn_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(txn||o.decentro_txn_id,id);
      // Optional payout. See README: collection settlement/split is preferable if Decentro configures it.
      if(process.env.DECENTRO_MASTER_VIRTUAL_ACCOUNT && process.env.DECENTRO_SECOND_UPI){
        const payoutAmount=money(o.platform_fee||0);
        try { const pr=await initiatePayout({order:o,amount:payoutAmount});
          db.prepare(`UPDATE orders SET payout_status=? WHERE id=?`).run(pr.transactionStatus||pr.status||'INITIATED',id);
        } catch(e){ console.error('Payout error',e.response?.data||e.message); db.prepare(`UPDATE orders SET payout_status='FAILED' WHERE id=?`).run(id); }
      }
      await sendConfirmation(o.phone,{...o,payment_status:'PAID'});
    } else if(status==='FAILED' || status==='FAILURE') {
      db.prepare(`UPDATE orders SET payment_status='FAILED' WHERE id=?`).run(id);
    }
  }catch(e){ console.error('callback error',e.message); }
});

async function initiatePayout({order,amount}){
  const payload={
    reference_id:`PO${order.id}`.slice(0,11),
    purpose_message:'WaterCan partner payout',
    from_account:process.env.DECENTRO_MASTER_VIRTUAL_ACCOUNT,
    transfer_type:'UPI',
    to_upi:process.env.DECENTRO_SECOND_UPI,
    transfer_amount:amount,
    beneficiary_details:{payee_name:process.env.DECENTRO_SECOND_PAYEE_NAME||'Partner'}
  };
  const headers={client_id:process.env.DECENTRO_CLIENT_ID,client_secret:process.env.DECENTRO_CLIENT_SECRET,module_secret:process.env.DECENTRO_MODULE_SECRET,provider_secret:process.env.DECENTRO_PROVIDER_SECRET};
  const r=await axios.post('https://in.staging.decentro.tech/core_banking/money_transfer/initiate',payload,{headers});
  return r.data;
}

app.get('/admin',authAdmin,(req,res)=>{
  const rows=db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Water Can Admin</title><style>body{font-family:Arial;margin:30px}table{border-collapse:collapse;width:100%}th,td{padding:8px;border:1px solid #ddd;text-align:left}th{background:#f4f4f4}.paid{color:green;font-weight:bold}</style></head><body><h1>Water Can Orders</h1><table><tr><th>Order</th><th>Customer</th><th>Cans</th><th>Address</th><th>Total</th><th>Payment</th><th>Payout</th><th>Created</th></tr>${rows.map(r=>`<tr><td>${r.id}</td><td>${r.name||''}<br>${r.phone||''}</td><td>${r.cans||''}</td><td>${r.address||''}</td><td>₹${r.total_amount||''}</td><td class="${r.payment_status==='PAID'?'paid':''}">${r.payment_status}</td><td>${r.payout_status||'-'}</td><td>${r.created_at}</td></tr>`).join('')}</table></body></html>`;
  res.send(html);
});

app.get('/health',(req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`Server running on ${BASE} / port ${PORT}`));
