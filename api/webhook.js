// Uses only your ORIGINAL Vercel environment variables.
const SHEET_URL = process.env.SHEET_BRIDGE_URL;
const TWILIO_SID = process.env.TWILIO_SID;
const TWILIO_TOKEN = process.env.TWILIO_TOKEN;

// Your original Twilio sandbox sender.
const WA_FROM = 'whatsapp:+14155238886';

function xml_(s) {
  return String(s).replace(/[<>&"']/g, c =>
    ({
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '"': '&quot;',
      "'": '&apos;'
    }[c])
  );
}

function reply_(res, text) {
  res.setHeader('Content-Type', 'text/xml; charset=utf-8');

  return res.status(200).send(
    `<Response><Message>${xml_(text)}</Message></Response>`
  );
}

async function alert_(n) {
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

      signal: AbortSignal.timeout(2000)
    }
  );

  if (!r.ok) {
    throw new Error('WhatsApp alert failed: ' + r.status);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).send('Agrolim bot is alive!');
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

  const phone = String(p.From || '')
    .replace(/^whatsapp:/, '');

  const sid = String(
    p.MessageSid || p.SmsMessageSid || ''
  );

  const body = String(p.Body || '').trim();

  if (
    !/^\+[1-9]\d{7,14}$/.test(phone) ||
    !/^SM[0-9a-f]{32}$/i.test(sid)
  ) {
    return res.status(400).send(
      'Expected an incoming Twilio WhatsApp message'
    );
  }

  if (body.length > 1600) {
    return reply_(
      res,
      'Please send a shorter message. Send HELP for the menu.'
    );
  }

  try {
    if (!SHEET_URL) {
      throw new Error('SHEET_BRIDGE_URL is missing');
    }

    const r = await fetch(SHEET_URL, {
      method: 'POST',

      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },

      body: JSON.stringify({
        action: 'message',
        phone,
        sid,
        body
      }),

      signal: AbortSignal.timeout(9000)
    });

    if (!r.ok) {
      throw new Error('Apps Script HTTP ' + r.status);
    }

    const result = await r.json();

    if (!result.ok || typeof result.reply !== 'string') {
      throw new Error(
        'Apps Script: ' +
        (
          result.error ||
          'Update the existing deployment to the replacement code'
        )
      );
    }

    const sent = await Promise.allSettled(
      (result.notifications || [])
        .slice(0, 8)
        .map(alert_)
    );

    const failed = sent.filter(
      x => x.status === 'rejected'
    ).length;

    if (failed) {
      console.warn('Agrolim alerts failed:', failed);
    }

    return reply_(
      res,
      result.reply +
      (
        failed
          ? '\nSome alerts could not be sent. Use STATUS to check the saved batch.'
          : ''
      )
    );
  } catch (err) {
    console.error('Agrolim:', err.message);

    return reply_(
      res,
      'Agrolim could not finish that request. ' +
      'Send STATUS to check whether it was saved, then try again.'
    );
  }
};
