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

const PORT = process.env.PORT || 3000;
const BASE = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const PAYU_SUCCESS_URL = process.env.PAYU_SUCCESS_URL || `${BASE}/payu/success`;
const PAYU_FAILURE_URL = process.env.PAYU_FAILURE_URL || `${BASE}/payu/failure`;
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
  gateway_fee REAL,
  gateway_tax REAL,
  processing_fee REAL,
  total_amount REAL,
  payment_status TEXT DEFAULT 'CREATED',
  decentro_txn_id TEXT,
  payout_status TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
)`);
for (const column of ['gateway_fee', 'gateway_tax', 'processing_fee']) {
  try { db.exec(`ALTER TABLE orders ADD COLUMN ${column} REAL`); } catch (e) { /* already exists */ }
}

const money = n => Math.round(Number(n) * 100) / 100;
function pricing(cans) {
  const base = money(cans * Number(process.env.CAN_PRICE || 50));
  const platformFee = money(base * Number(process.env.PLATFORM_FEE_PERCENT || 2) / 100);
  const gatewayFee = money(base * Number(process.env.PAYU_FEE_PERCENT || 2) / 100);
  const gatewayTax = money(gatewayFee * Number(process.env.PAYU_GST_PERCENT || 18) / 100);
  const processingFee = money(gatewayFee + gatewayTax);
  return { base, platformFee, gatewayFee, gatewayTax, processingFee, total: money(base + platformFee + processingFee) };
}

function payuHash(fields) {
  const hashInput = [
    process.env.PAYU_KEY,
    fields.txnid,
    fields.amount,
    fields.productinfo,
    fields.firstname,
    fields.email,
    fields.udf1 || '',
    fields.udf2 || '',
    fields.udf3 || '',
    fields.udf4 || '',
    fields.udf5 || '',
    ...Array(10).fill(''),
    process.env.PAYU_SALT
  ].join('|');
  return crypto.createHash('sha512').update(hashInput).digest('hex');
}

function payuReverseHash(body) {
  const reverseInput = [
    ...(body.additionalCharges ? [body.additionalCharges] : []),
    process.env.PAYU_SALT,
    body.status || '',
    ...Array(10).fill(''),
    body.email || '',
    body.firstname || '',
    body.productinfo || '',
    body.amount || '',
    body.txnid || '',
    process.env.PAYU_KEY
  ].join('|');
  return crypto.createHash('sha512').update(reverseInput).digest('hex');
}

function safeEqual(left, right) {
  if (!left || !right || left.length !== right.length) return false;
  return crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

function payuSplitInfo(order) {
  const configured = process.env.PAYU_SPLIT_INFO_JSON;
  if (!configured) return null;
  const replacements = {
    '{{TOTAL_AMOUNT}}': order.total_amount,
    '{{BASE_AMOUNT}}': order.base_amount,
    '{{PLATFORM_FEE}}': order.platform_fee,
    '{{PROCESSING_FEE}}': order.processing_fee
  };
  let json = configured;
  for (const [token, value] of Object.entries(replacements)) json = json.replaceAll(token, String(value));
  return JSON.parse(json);
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
  db.prepare(`UPDATE orders SET cans=?,address=?,base_amount=?,decentro_fee=?,platform_fee=?,gateway_fee=?,gateway_tax=?,processing_fee=?,total_amount=?,payment_status='CHECKOUT_READY' WHERE id=?`).run(qty,address.trim(),p.base,0,p.platformFee,p.gatewayFee,p.gatewayTax,p.processingFee,p.total,req.params.id);
  res.json({id:req.params.id,pricing:p});
});

// PayU hosted checkout creation. Configure the exact splitInfo shape supplied by PayU.
app.post('/api/order/:id/pay', async (req,res)=>{
  const o=db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id); if(!o) return res.status(404).json({error:'Order not found'});
  if(!o.total_amount) return res.status(400).json({error:'Complete checkout first'});
  try {
    if (!process.env.PAYU_KEY || !process.env.PAYU_SALT) return res.status(500).json({error:'PayU is not configured'});
    const fields={
      key:process.env.PAYU_KEY,
      txnid:o.id,
      amount:o.total_amount.toFixed(2),
      productinfo:`WaterCan ${o.id}`,
      firstname:o.name || 'Customer',
      email:process.env.PAYU_DEFAULT_EMAIL || 'customer@example.com',
      phone:o.phone || '',
      udf1:o.id,
      surl:PAYU_SUCCESS_URL,
      furl:PAYU_FAILURE_URL,
      service_provider:'payu_paisa'
    };
    const splitInfo=payuSplitInfo(o);
    if (splitInfo) fields.splitInfo=JSON.stringify(splitInfo);
    fields.hash=payuHash(fields);
    db.prepare(`UPDATE orders SET payment_status='PAYMENT_INITIATED',decentro_txn_id=? WHERE id=?`).run(fields.txnid,o.id);
    res.json({ok:true,gatewayUrl:process.env.PAYU_PAYMENT_URL||'https://test.payu.in/_payment',fields});
  } catch(e){ console.error('PayU setup error',e.message); res.status(500).json({error:'Invalid PayU splitInfo configuration',details:e.message}); }
});

async function handlePayuCallback(req,res){
  try{
    console.log('PayU callback:',JSON.stringify(req.body));
    const b=req.body;
    const id=b.udf1 || b.txnid;
    const status=String(b.status || '').toLowerCase();
    if(!id) return res.status(400).send('Missing PayU transaction reference');
    const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id); if(!o) return res.status(404).send('Order not found');
    if (b.txnid !== o.id || Number(b.amount) !== Number(o.total_amount) || !safeEqual(String(b.hash || '').toLowerCase(), payuReverseHash(b))) {
      return res.status(400).send('Invalid PayU payment response');
    }
    if(status==='success'){
      db.prepare(`UPDATE orders SET payment_status='PAID',decentro_txn_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=?`).run(b.mihpayid||b.txnid,id);
      await sendConfirmation(o.phone,{...o,payment_status:'PAID'});
    } else {
      db.prepare(`UPDATE orders SET payment_status='FAILED' WHERE id=?`).run(id);
    }
    return res.redirect(`/success.html?ref=${encodeURIComponent(id)}`);
  }catch(e){ console.error('PayU callback error',e.message); return res.status(500).send('PayU callback error'); }
}

app.all('/payu/success', handlePayuCallback);
app.all('/payu/failure', handlePayuCallback);

app.get('/admin',authAdmin,(req,res)=>{
  const rows=db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Water Can Admin</title><style>body{font-family:Arial;margin:30px}table{border-collapse:collapse;width:100%}th,td{padding:8px;border:1px solid #ddd;text-align:left}th{background:#f4f4f4}.paid{color:green;font-weight:bold}</style></head><body><h1>Water Can Orders</h1><table><tr><th>Order</th><th>Customer</th><th>Cans</th><th>Address</th><th>Total</th><th>Payment</th><th>Payout</th><th>Created</th></tr>${rows.map(r=>`<tr><td>${r.id}</td><td>${r.name||''}<br>${r.phone||''}</td><td>${r.cans||''}</td><td>${r.address||''}</td><td>₹${r.total_amount||''}</td><td class="${r.payment_status==='PAID'?'paid':''}">${r.payment_status}</td><td>${r.payout_status||'-'}</td><td>${r.created_at}</td></tr>`).join('')}</table></body></html>`;
  res.send(html);
});

app.get('/health',(req,res)=>res.json({ok:true}));
app.listen(PORT,()=>console.log(`Server running on ${BASE} / port ${PORT}`));
