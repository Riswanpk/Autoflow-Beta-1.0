import express from 'express';
import axios from 'axios';
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
  return { base, dfee, pfee, total: money(base + dfee + pfee) };
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
  try {
    const payload={
      reference_id:o.id,
      consumer_urn:process.env.DECENTRO_CONSUMER_URN,
      amount:o.total_amount,
      purpose_message:`WaterCan ${o.id}`,
      generate_psp_uri:true,
      expiry_time:30,
      redirect_url:`${BASE}/success.html?ref=${encodeURIComponent(o.id)}`
    };
    if(process.env.DECENTRO_SPLIT_SETTLEMENT_RULE_URN) payload.split_settlement_rule_urn=process.env.DECENTRO_SPLIT_SETTLEMENT_RULE_URN;
    const headers={client_id:process.env.DECENTRO_CLIENT_ID,client_secret:process.env.DECENTRO_CLIENT_SECRET};
    const r=await axios.post(`${process.env.DECENTRO_BASE_URL}/v3/payments/upi/link`,payload,{headers});
    const data=r.data;
    db.prepare(`UPDATE orders SET payment_status='PAYMENT_LINK_CREATED',decentro_txn_id=? WHERE id=?`).run(data.decentro_txn_id||null,o.id);
    res.json({ok:true, transaction_id:data.decentro_txn_id, upi_uris:data.upi_uris, response:data});
  } catch(e){ console.error('Decentro collect error',e.response?.data||e.message); res.status(502).json({error:'Decentro error',details:e.response?.data||e.message}); }
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
        const payoutAmount=money(o.base_amount*Number(process.env.PLATFORM_FEE_PERCENT||2)/100);
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
