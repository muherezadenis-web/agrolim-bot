// Original environment variables. No new dependencies.
const SHEET_URL = process.env.SHEET_BRIDGE_URL;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;

const WA_FROM = 'whatsapp:+14155238886';

const esc = s => String(s)
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/[&<>"']/g, c => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;'
  }[c]));

function reply(res, body) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');

  return res.status(200).send(
    `<Response><Message>${esc(body)}</Message></Response>`
  );
}

async function sendWhatsApp(n) {
  if (!TWILIO_SID || !TWILIO_TOKEN) {
    throw new Error('Twilio credentials missing');
  }

  const r = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`,
    {
      method: 'POST',

      headers: {
        Authorization: 'Basic ' +
          Buffer.from(
            TWILIO_SID + ':' + TWILIO_TOKEN
          ).toString('base64'),

        'Content-Type': 'application/x-www-form-urlencoded'
      },

      body: new URLSearchParams({
        From: WA_FROM,
        To: 'whatsapp:' + n.to,
        Body: n.body
      }),

      signal: AbortSignal.timeout(1000)
    }
  );

  if (!r.ok) {
    throw new Error('Twilio alert HTTP ' + r.status);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).send(
      'Agrolim bot is alive! Flow v4'
    );
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  let p = req.body;

  if (Buffer.isBuffer(p)) {
    p = p.toString('utf8');
  }

  if (typeof p === 'string') {
    p = Object.fromEntries(new URLSearchParams(p));
  }

  p = p || {};

  const from = String(p.From || '')
    .replace(/^whatsapp:/, '');

  const sid = String(
    p.MessageSid || p.SmsMessageSid || ''
  );

  const body = String(p.Body || '').trim();

  if (
    !/^\+[1-9]\d{7,14}$/.test(from) ||
    !/^SM[0-9a-f]{32}$/i.test(sid)
  ) {
    return res.status(400).send(
      'Expected an incoming Twilio message'
    );
  }

  if (body.length > 1600) {
    return reply(
      res,
      'Please send a shorter message. Send MENU for options.'
    );
  }

  try {
    if (!SHEET_URL) {
      throw new Error('SHEET_BRIDGE_URL missing');
    }

    const r = await fetch(SHEET_URL, {
      method: 'POST',

      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },

      body: JSON.stringify({
        action: 'chat',
        phone: from,
        sid,
        body
      }),

      signal: AbortSignal.timeout(7000)
    });

    if (!r.ok) {
      throw new Error('Apps Script HTTP ' + r.status);
    }

    const raw = await r.text();
    let result;

    try {
      result = JSON.parse(raw);
    } catch (_) {
      throw new Error(
        'Apps Script did not return JSON; ' +
        'check its existing web-app deployment'
      );
    }

    if (
      !result ||
      !result.ok ||
      typeof result.reply !== 'string'
    ) {
      throw new Error(
        result && result.error ||
        'Apps Script needs the flow v4 code deployed'
      );
    }

    const alerts = await Promise.allSettled(
      (result.notifications || [])
        .slice(0, 4)
        .map(sendWhatsApp)
    );

    const failed = alerts.filter(
      x => x.status === 'rejected'
    ).length;

    if (failed) {
      console.warn('Agrolim alerts failed:', failed);
    }

    return reply(
      res,
      result.reply +
      (
        failed
          ? '\nSome alerts failed. Your record is saved; use My collections to check it.'
          : ''
      )
    );
  } catch (err) {
    console.error('Agrolim:', err.message);

    return reply(
      res,
      'Sorry, Agrolim could not finish that request. ' +
      'Send STATUS to check for a saved record before trying again.'
    );
  }
}
