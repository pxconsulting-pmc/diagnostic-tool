/* ═══════════════════════════════════════════════════════════════
   PX Consulting — Diagnostic Tool → Odoo CRM
   Netlify Serverless Function — XML-RPC approach
   More reliable than JSON-2 for Odoo SaaS instances
   ═══════════════════════════════════════════════════════════════ */

const https = require('https');

const ODOO_URL  = 'px-consulting.odoo.com';
const ODOO_DB   = 'px-consulting';
const STAGE_ID  = 1;

// Make an HTTPS POST request, return { status, body }
function post(hostname, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = https.request({
      hostname,
      path,
      method: 'POST',
      headers: {
        'Content-Type':   'text/xml',
        'Content-Length': data.length,
        ...headers
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

// Build XML-RPC call payload
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
        .map(([k,val]) => `<member><name>${escXml(k)}</name>${encode(val)}</member>`)
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
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');
}

// Parse the integer result from XML-RPC response
function parseXmlInt(xml) {
  const m = xml.match(/<int>(\d+)<\/int>/) || xml.match(/<i4>(\d+)<\/i4>/);
  return m ? parseInt(m[1]) : null;
}

// Parse fault string from XML-RPC fault response
function parseXmlFault(xml) {
  const m = xml.match(/<faultString><\/faultString>|<faultString>([\s\S]*?)<\/faultString>/);
  return m ? m[1] : xml.substring(0, 300);
}

exports.handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const apiKey = process.env.ODOO_API_KEY;
  if (!apiKey) {
    console.error('ODOO_API_KEY not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'API key missing' }) };
  }

  // ── Step 1: Authenticate via XML-RPC common endpoint ──
  // With API keys, we use the key as the password and any string as username
  let uid;
  try {
    const authXml = xmlCall('authenticate', [
      ODOO_DB,
      'vinod.pandita@pxconsulting.in',
      apiKey,     // API key acts as password
      {}
    ]);

    const authRes = await post(ODOO_URL, '/xmlrpc/2/common', authXml);
    console.log(`Auth status: ${authRes.status}`);
    console.log(`Auth response (first 300): ${authRes.body.substring(0, 300)}`);

    if (authRes.body.includes('<fault>')) {
      throw new Error('Auth fault: ' + parseXmlFault(authRes.body));
    }

    uid = parseXmlInt(authRes.body);
    if (!uid) throw new Error('Auth failed — no uid returned. Check API key and username.');
    console.log(`Authenticated. UID: ${uid}`);

  } catch (err) {
    console.error('Auth error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Odoo auth failed: ' + err.message }) };
  }

  // ── Step 2: Create CRM lead via XML-RPC object endpoint ──
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
    x_qualification: payload.qualification || 'junk',
  };

  try {
    const createXml = xmlCall('execute_kw', [
      ODOO_DB,
      uid,
      apiKey,
      'crm.lead',
      'create',
      [leadData],
      {}
    ]);

    const createRes = await post(ODOO_URL, '/xmlrpc/2/object', createXml);
    console.log(`Create status: ${createRes.status}`);
    console.log(`Create response (first 300): ${createRes.body.substring(0, 5000)}`);

    if (createRes.body.includes('<fault>')) {
      throw new Error('Create fault: ' + createRes.body.substring(0, 5000));
    }

    const leadId = parseXmlInt(createRes.body);
    if (!leadId) throw new Error('No lead ID returned: ' + createRes.body.substring(0, 200));

    console.log(`✓ Lead created. Odoo ID: ${leadId} | ${payload.name} | ${payload.totalPct}% | ${payload.qualification}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, leadId })
    };

  } catch (err) {
    console.error('Create error:', err.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
