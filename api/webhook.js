// api/webhook.js — Agrolim 2.0 brain (zero dependencies)
const SHEET_URL = process.env.SHEET_BRIDGE_URL;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;
const WA_FROM = 'whatsapp:+14155238886';

async function sheet(req) {
  const r = await fetch(SHEET_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(req) });
  return r.json();
}
async function sendWhatsApp(to, body) {
  const auth = 'Basic ' + Buffer.from(TWILIO_SID + ':' + TWILIO_TOKEN).toString('base64');
  await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { 'Authorization': auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: WA_FROM, To: 'whatsapp:' + to, Body: body })
  });
}
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const now = () => new Date().toISOString();
const id = () => 'M-' + Date.now();

export default async function handler(req, res) {
  if (req.method === 'GET') return res.status(200).send('Agrolim bot is alive!');
  const from = String(req.body.From || '').replace('whatsapp:', '');
  const body = String(req.body.Body || '').trim();
  let reply;
  try { reply = await handle(from, body); }
  catch (e) { console.error(e); reply = '⚠️ Small technical hiccup — please try again.'; }
  res.setHeader('Content-Type', 'text/xml');
  res.send(`<Response><Message>${esc(reply)}</Message></Response>`);
}

async function handle(from, body) {
  const u = await sheet({ action: 'find', sheet: 'Users', match: { phone_number: from } });
  const user = u.rows[0];
  const msg = body.toLowerCase();
  const upd = d => sheet({ action: 'update', sheet: 'Users', match: { phone_number: from }, data: d });

  if (msg === 'hi' || msg === 'hello' || !user) {
    if (!user) await sheet({ action: 'add', sheet: 'Users', data: { phone_number: from, trust_score: 5, current_state: 'awaiting_role', created_time: now() } });
    else await upd({ current_state: 'awaiting_role' });
    return 'Welcome to Agrolim Groceries Waste Bot! 🌱\nReply 1 = Restaurant\nReply 2 = Farmer';
  }

  const state = String(user.current_state || '');

  if (state === 'awaiting_role') {
    if (body === '1') { await upd({ role: 'Restaurant', current_state: 'awaiting_location' }); return 'Registered as Restaurant! 🍽️ What city/area are you in?'; }
    if (body === '2') { await upd({ role: 'Farmer', current_state: 'awaiting_location' }); return 'Welcome Farmer! 🚜 What city/area are you in?'; }
    return 'Reply 1 for Restaurant, 2 for Farmer.';
  }
  if (state === 'awaiting_location') { await upd({ location: body, current_state: 'awaiting_capacity' }); return 'Got it! 📍 Roughly how many KG per week? (reply a number)'; }
  if (state === 'awaiting_capacity') { await upd({ capacity_kg: body, safety_consent: 'Yes', current_state: 'idle' }); return '🎉 You are verified!\nReply WASTE to post waste\nReply FEED to find waste\nReply HELP for menu'; }

  if (state === 'awaiting_waste_type') {
    if (msg === 'c') {
      await sheet({ action: 'add', sheet: 'Matches', data: { match_id: id(), restaurant_phone: from, waste_type: 'Raw Meat / Dairy', safety_status: 'Blocked', status: 'Compost', created_time: now(), location: user.location } });
      await upd({ current_state: 'idle' });
      return '⚠️ Safety Gate: raw meat/dairy cannot be fed to animals. We routed it to a certified compost partner instead. 🌱';
    }
    if (msg === 'a' || msg === 'b') { await upd({ pending_waste_type: msg === 'a' ? 'Cooked food' : 'Vegetable scraps', current_state: 'awaiting_kg' }); return 'Safe for animal feed! 🐖 How many KG is this batch?'; }
    return 'Reply A, B or C.';
  }
  if (state === 'awaiting_kg') { await upd({ pending_kg: body, current_state: 'awaiting_pickup' }); return '📦 When should the farmer pick up? (e.g. Today 2 PM)'; }

  if (state === 'awaiting_pickup') {
    const kg = parseFloat(user.pending_kg) || 0;
    await sheet({ action: 'add', sheet: 'Matches', data: { match_id: id(), restaurant_phone: from, waste_type: user.pending_waste_type, waste_kg: kg, pickup_window: body, safety_status: 'Safe', status: 'Open', created_time: now(), co2_saved: (kg * 2.5).toFixed(1), location: user.location } });
    await upd({ current_state: 'idle' });
    const f = await sheet({ action: 'find', sheet: 'Users', match: { role: 'Farmer', current_state: 'idle', location: user.location } });
    for (const farmer of f.rows) {
      await sendWhatsApp(farmer.phone_number, `🚨 New waste in ${user.location}! ${user.pending_waste_type}, ${kg} KG, pickup ${body}. Reply YES to claim!`);
    }
    return '✅ Match created! We alerted ' + f.rows.length + ' farmer(s) nearby. We will notify you when one claims it.';
  }

  if (state === 'idle') {
    if (msg === 'waste' && user.role === 'Restaurant') { await upd({ current_state: 'awaiting_waste_type' }); return 'What type of waste?\nA - Cooked food\nB - Vegetable scraps\nC - Raw meat / dairy'; }
    if (msg === 'yes' && user.role === 'Farmer') {
      const m = await sheet({ action: 'find', sheet: 'Matches', match: { status: 'Open' } });
      const match = m.rows.find(r => String(r.location || '').toLowerCase() === String(user.location || '').toLowerCase()) || m.rows[0];
      if (!match) return 'No open waste right now — we will alert you when new waste is posted! 🌱';
      await sheet({ action: 'update', sheet: 'Matches', match: { match_id: match.match_id }, data: { status: 'Matched', farmer_phone: from } });
      await sheet({ action: 'add', sheet: 'Impact', data: { date: now(), match_id: match.match_id, total_kg_diverted: match.waste_kg, total_co2_saved: match.co2_saved, grant_ready: 'Yes' } });
      await sendWhatsApp(match.restaurant_phone, `✅ Match! Farmer ${from} will collect your ${match.waste_kg} KG of ${match.waste_type} at ${match.pickup_window}. Farmer contact: ${from}`);
      return `✅ Matched! Restaurant contact: ${match.restaurant_phone}. Pickup: ${match.pickup_window}. Thank you for saving food! 🚜`;
    }
    if (msg === 'feed' && user.role === 'Farmer') return 'You are on the alert list! 🌱 We will message you when matching waste is posted in your area.';
    if (msg === 'help') return 'Menu:\nWASTE - post waste (restaurants)\nFEED - find waste (farmers)\nHELP - this menu';
    return 'Reply WASTE, FEED or HELP.';
  }
  return 'Reply hi to restart.';
}
