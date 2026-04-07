/* ═══════════════════════════════════════════════════════════════
   PX Consulting — Diagnostic Tool → Odoo CRM
   Vercel Serverless Function
   ═══════════════════════════════════════════════════════════════ */

const https = require('https');

const ODOO_URL = 'px-consulting.odoo.com';
const ODOO_DB  = 'px-consulting';
const STAGE_ID = 1;

function post(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body, 'utf8');
    const req = https.request({
      hostname, path, method: 'POST',
      headers: {
        'Content-Type':   'text/xml; charset=utf-8',
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

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

function encodeValue(v) {
  if (v === null || v === undefined) return '<value><string></string></value>';
  if (typeof v === 'boolean')  return '<value><boolean>' + (v?1:0) + '</boolean></value>';
  if (typeof v === 'number' && Number.isInteger(v)) return '<value><int>' + v + '</int></value>';
  if (typeof v === 'number')   return '<value><double>' + v + '</double></value>';
  if (typeof v === 'string')   return '<value><string>' + esc(v) + '</string></value>';
  if (Array.isArray(v)) {
    return '<value><array><data>' + v.map(encodeValue).join('') + '</data></array></value>';
  }
  if (typeof v === 'object') {
    const members = Object.entries(v)
      .map(function(entry) {
        return '<member><name>' + esc(entry[0]) + '</name>' + encodeValue(entry[1]) + '</member>';
      }).join('');
    return '<value><struct>' + members + '</struct></value>';
  }
  return '<value><string>' + esc(String(v)) + '</string></value>';
}

function xmlCall(method, params) {
  const paramXml = params.map(function(p) {
    return '<param>' + encodeValue(p) + '</param>';
  }).join('');
  return '<?xml version="1.0" encoding="utf-8"?><methodCall><methodName>' +
    esc(method) + '</methodName><params>' + paramXml + '</params></methodCall>';
}

function parseXmlInt(xml) {
  var m = xml.match(/<int>(\d+)<\/int>/) || xml.match(/<i4>(\d+)<\/i4>/);
  return m ? parseInt(m[1]) : null;
}

export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const payload = req.body;
  if (!payload || !payload.name || !payload.email) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const apiKey = process.env.ODOO_API_KEY;
  if (!apiKey) {
    console.error('ODOO_API_KEY not set');
    return res.status(500).json({ error: 'API key missing' });
  }

  // Step 1 — Authenticate
  var uid;
  try {
    var authXml = xmlCall('authenticate', [
      ODOO_DB,
      'vinod.pandita@pxconsulting.in',
      apiKey,
      {}
    ]);
    var authRes = await post(ODOO_URL, '/xmlrpc/2/common', authXml);
    console.log('Auth status: ' + authRes.status);
    if (authRes.body.includes('<fault>')) {
      throw new Error('Auth fault: ' + authRes.body.substring(0, 300));
    }
    uid = parseXmlInt(authRes.body);
    if (!uid) throw new Error('No uid returned — check API key and username');
    console.log('Authenticated. UID: ' + uid);
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(500).json({ success: false, error: 'Auth failed: ' + err.message });
  }

  // Step 2 — Create CRM lead
  var leadData = {
    name:         '[Diagnostic] ' + payload.name + (payload.company ? ' — ' + payload.company : ''),
    contact_name: payload.name,
    email_from:   payload.email,
    stage_id:     STAGE_ID,
  };

  // Only add optional fields if they have values
  if (payload.company)       leadData.partner_name    = payload.company;
  if (payload.phone)         leadData.phone           = payload.phone;
  if (payload.phone)         leadData.x_whatsapp      = payload.phone;
  if (payload.description)   leadData.description     = payload.description;
  if (payload.revenue)       leadData.x_revenue_range = payload.revenue;
  if (payload.dimScoresText) leadData.x_dim_scores    = payload.dimScoresText;
  if (payload.weakestDim)    leadData.x_weakest_dim   = payload.weakestDim;
  if (payload.qualification) leadData.x_qualification = payload.qualification;
  if (payload.totalPct !== undefined && payload.totalPct !== null) {
    leadData.x_total_score = parseInt(payload.totalPct) || 0;
  }

  try {
    var createXml = xmlCall('execute_kw', [
      ODOO_DB, uid, apiKey,
      'crm.lead', 'create',
      [leadData]
    ]);

    var createRes = await post(ODOO_URL, '/xmlrpc/2/object', createXml);
    console.log('Create status: ' + createRes.status);

    if (createRes.body.includes('<fault>')) {
      console.error('Create fault:', createRes.body.substring(0, 3000));
      throw new Error(createRes.body.substring(0, 500));
    }

    var leadId = parseXmlInt(createRes.body);
    if (!leadId) throw new Error('No lead ID in response: ' + createRes.body.substring(0, 200));

    console.log('Lead created. Odoo ID: ' + leadId + ' | ' + payload.name + ' | ' + payload.totalPct + '% | ' + payload.qualification);
    return res.status(200).json({ success: true, leadId: leadId });

  } catch (err) {
    console.error('Create error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
