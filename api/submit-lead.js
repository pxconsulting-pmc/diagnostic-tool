/* ═══════════════════════════════════════════════════════════════
   PX Consulting — Diagnostic Tool → Odoo CRM
   Vercel Serverless Function

   SETUP:
   Vercel dashboard → Project → Settings → Environment Variables
   Add: ODOO_API_KEY = your Odoo API key
   ═══════════════════════════════════════════════════════════════ */

const https = require('https');

const ODOO_URL = 'px-consulting.odoo.com';
const ODOO_DB  = 'px-consulting';
const STAGE_ID = 1;

function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'text/xml',
        'Content-Length': data.length,
      }
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function xmlCall(method, params) {
  const encode = (v) => {
    if (v === null || v === undefined) return '<value><boolean>0</boolean></value>';
    if (typeof v === 'boolean')  return `<value><boolean>${v?1:0}</boolean></value>`;
    if (typeof v === 'number')   return `<value><int>${v}</int></value>`;
    if (typeof v === 'string')   return `<value><string>${escXml(v)}</string></value>`;
    if (Array.isArray(v))        return `<value><array><data>${v.map(encode).join('')}</data></array></value>`;
    if (typeof v === 'object') {
      const members = Object.entries(v)
        .filter(([,val]) => val !== undefined && val !== null)
        .map(([k,val]) => `<member><n>${escXml(k)}</n>${encode(val)}</member>`)
        .join('');
      return `<value><struct>${members}</struct></value>`;
    }
    return `<value><string>${escXml(String(v))}</string></value>`;
  };
  return `<?xml version="1.0"?>
<methodCall>
  <methodName>${method}</methodName>
  <params>${params.map(p => `<param>${encode(p)}</param>`).join('')}</params>
</methodCall>`;
}

function escXml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function parseXmlInt(xml) {
  const m = xml.match(/<int>(\d+)<\/int>/) || xml.match(/<i4>(\d+)<\/i4>/);
  return m ? parseInt(m[1]) : null;
}

export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body;
  if (!payload) {
    return res.status(400).json({ error: 'Empty request body' });
  }

  const apiKey = process.env.ODOO_API_KEY;
  if (!apiKey) {
    console.error('ODOO_API_KEY not set');
    return res.status(500).json({ error: 'API key missing' });
  }

  // Step 1 — Authenticate
  let uid;
  try {
    const authXml = xmlCall('authenticate', [
      ODOO_DB,
      'vinod.pandita@pxconsulting.in',
      apiKey,
      {}
    ]);
    const authRes = await post(ODOO_URL, '/xmlrpc/2/common', authXml);
    console.log(`Auth status: ${authRes.status}`);
    if (authRes.body.includes('<fault>')) {
      throw new Error('Auth fault: ' + authRes.body.substring(0, 300));
    }
    uid = parseXmlInt(authRes.body);
    if (!uid) throw new Error('No uid returned — check API key');
    console.log(`Authenticated. UID: ${uid}`);
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(500).json({ success: false, error: 'Odoo auth failed: ' + err.message });
  }

  // Step 2 — Create lead
  const leadData = {
    name:            `[Diagnostic] ${payload.name}${payload.company ? ' — ' + payload.company : ''}`,
    contact_name:    payload.name,
    partner_name:    payload.company     || '',
    email_from:      payload.email,
    phone:           payload.phone       || '',
    description:     payload.description || '',
    stage_id:        STAGE_ID,
    x_revenue_range: payload.revenue       || '',
    x_whatsapp:      payload.phone         || '',
    x_total_score:   payload.totalPct      || 0,
    x_dim_scores:    payload.dimScoresText || '',
    x_weakest_dim:   payload.weakestDim    || '',
    x_qualification: payload.qualification || 'unqualified',
  };

  try {
    const createXml = xmlCall('execute_kw', [
      ODOO_DB, uid, apiKey,
      'crm.lead', 'create',
      [leadData], {}
    ]);
    const createRes = await post(ODOO_URL, '/xmlrpc/2/object', createXml);
    console.log(`Create status: ${createRes.status}`);

    if (createRes.body.includes('<fault>')) {
      console.error('Create fault:', createRes.body.substring(0, 2000));
      throw new Error('Create fault: ' + createRes.body.substring(0, 500));
    }

    const leadId = parseXmlInt(createRes.body);
    if (!leadId) throw new Error('No lead ID returned');

    console.log(`✓ Lead created. Odoo ID: ${leadId} | ${payload.name} | ${payload.totalPct}% | ${payload.qualification}`);
    return res.status(200).json({ success: true, leadId });

  } catch (err) {
    console.error('Create error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
