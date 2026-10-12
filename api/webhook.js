import { createHmac, timingSafeEqual } from 'node:crypto';

const xml = s => String(s).replace(/[<>&"']/g, c =>
  ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;'
  }[c])
);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    return res.status(200).send('Agrolim is online');
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).end();
  }

  const env = process.env;

  const required = [
    'TWILIO_SID',
    'TWILIO_TOKEN',
    'WEBHOOK_URL',
    'SHEET_BRIDGE_URL',
    'BRIDGE_SECRET',
    'WA_FROM'
  ];

  if (required.some(k => !env[k])) {
    return res.status(503).send('Configuration missing');
  }

  if (!String(req.headers['content-type'] || '')
    .startsWith('application/x-www-form-urlencoded')) {
    return res.status(415).end();
  }

  let p = req.body;

  if (Buffer.isBuffer(p)) p = p.toString('utf8');

  if (typeof p === 'string') {
    const form = new URLSearchParams(p);

    if (new Set(form.keys()).size !== [...form.keys()].length) {
      return res.status(400).end();
    }

    p = Object.fromEntries(form);
  }

  if (
    !p ||
    typeof p !== 'object' ||
    Object.values(p).some(v => typeof v !== 'string')
  ) {
    return res.status(400).end();
  }

  // Include every received parameter when validating Twilio.
  const signed = env.WEBHOOK_URL +
    Object.keys(p).sort().map(k => k + p[k]).join('');

  const expected = createHmac('sha1', env.TWILIO_TOKEN)
    .update(signed)
    .digest('base64');

  const received = String(
    req.headers['x-twilio-signature'] || ''
  );

  if (
    Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
    !timingSafeEqual(
      Buffer.from(received),
      Buffer.from(expected)
    )
  ) {
    return res.status(403).end();
  }

  if (
    p.AccountSid !== env.TWILIO_SID ||
    p.To !== env.WA_FROM ||
    !/^whatsapp:\+[1-9]\d{7,14}$/.test(p.From || '') ||
    !/^SM[0-9a-f]{32}$/i.test(p.MessageSid || '')
  ) {
    return res.status(400).end();
  }

  try {
    const r = await fetch(env.SHEET_BRIDGE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify({
        secret: env.BRIDGE_SECRET,
        sid: p.MessageSid,
        phone: p.From.slice(9),
        body: p.Body || ''
      }),
      signal: AbortSignal.timeout(8500)
    });

    if (!r.ok) throw new Error('Bridge HTTP failure');

    const result = await r.json();

    if (!result.ok || typeof result.reply !== 'string') {
      throw new Error('Bridge rejected request');
    }

    // Best-effort alerts for recently active, consenting users.
    const jobs = (result.notifications || []).slice(0, 10);

    const sent = await Promise.allSettled(
      jobs.map(async n => {
        const response = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`,
          {
            method: 'POST',
            headers: {
              Authorization: 'Basic ' +
                Buffer.from(
                  env.TWILIO_SID + ':' + env.TWILIO_TOKEN
                ).toString('base64'),
              'Content-Type':
                'application/x-www-form-urlencoded'
            },
            body: new URLSearchParams({
              From: env.WA_FROM,
              To: 'whatsapp:' + n.to,
              Body: n.body
            }),
            signal: AbortSignal.timeout(2000)
          }
        );

        if (!response.ok) {
          throw new Error('Notification failed');
        }
      })
    );

    const failures = sent.filter(
      s => s.status === 'rejected'
    ).length;

    if (failures) {
      console.warn(
        'Agrolim notification failures:',
        failures
      );
    }

    const reply = result.reply + (
      failures
        ? '\nSome WhatsApp alerts failed. Check STATUS for the saved record.'
        : ''
    );

    res.setHeader(
      'Content-Type',
      'text/xml; charset=utf-8'
    );

    return res.status(200).send(
      `<Response><Message>${xml(reply)}</Message></Response>`
    );
  } catch {
    console.error('Agrolim bridge unavailable');

    return res.status(503).send(
      'Temporarily unavailable'
    );
  }
}
