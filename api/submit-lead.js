/* ═══════════════════════════════════════════════════════════════
   PX Consulting — Diagnostic Tool → Odoo CRM
   Vercel Serverless Function — Production version

   Security features:
   - Rate limiting: 3 submissions per IP per 10 minutes
   - Server-side input validation
   - CORS restricted to allowed domains
   ═══════════════════════════════════════════════════════════════ */

const https = require('https');

const ODOO_URL = 'px-consulting.odoo.com';
const ODOO_DB  = 'px-consulting';
const STAGE_ID = 1;

// ── ALLOWED ORIGINS ──────────────────────────────────────────
// Add your custom domain here once check.pxconsulting.in is live
const ALLOWED_ORIGINS = [
  'https://diagnostic-tool-two.vercel.app',
  'https://check.pxconsulting.in',
];

// ── RATE LIMITING ─────────────────────────────────────────────
// In-memory store: { ip: { count, firstRequest } }
// Soft limit — resets on cold start, but stops casual abuse
const RATE_LIMIT_MAX      = 3;    // max submissions
const RATE_LIMIT_WINDOW   = 10 * 60 * 1000; // 10 minutes in ms
const ipStore = {};

function isRateLimited(ip) {
  const now = Date.now();
  if (!ipStore[ip]) {
    ipStore[ip] = { count: 1, firstRequest: now };
    return false;
  }
  const record = ipStore[ip];
  // Reset window if expired
  if (now - record.firstRequest > RATE_LIMIT_WINDOW) {
    ipStore[ip] = { count: 1, firstRequest: now };
    return false;
  }
  record.count++;
  return record.count > RATE_LIMIT_MAX;
}

// ── INPUT VALIDATION ──────────────────────────────────────────
const VALID_REVENUES = ['under_5cr','5_10cr','10_25cr','25_50cr','50_100cr','100cr_plus'];
const VALID_QUALS    = ['qualified','unqualified','junk'];

function validatePayload(p) {
  const errors = [];

  // Enrichment update — minimal validation
  if (p._action === 'update') {
    if (!p.leadId || typeof p.leadId !== 'number') errors.push('Invalid leadId for update');
    return errors;
  }

  if (!p.name || typeof p.name !== 'string' || p.name.trim().length < 2) {
    errors.push('Invalid name');
  }
  if (!p.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) {
    errors.push('Invalid email');
  }
  if (p.phone) {
    const cleaned = p.phone.replace(/[\s\-]/g, '');
    if (!/^(\+91|91|0)?[6-9]\d{9}$/.test(cleaned)) {
      errors.push('Invalid phone number');
    }
  }
  if (!p.revenue || !VALID_REVENUES.includes(p.revenue)) {
    errors.push('Invalid revenue range');
  }
  if (p.qualification && !VALID_QUALS.includes(p.qualification)) {
    errors.push('Invalid qualification value');
  }
  if (p.totalPct !== undefined && (typeof p.totalPct !== 'number' || p.totalPct < 0 || p.totalPct > 100)) {
    errors.push('Invalid score');
  }

  return errors;
}

// ── XML-RPC HELPERS ───────────────────────────────────────────
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

// ── MAIN HANDLER ──────────────────────────────────────────────
export default async function handler(req, res) {

  // CORS
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Rate limiting
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';

  if (isRateLimited(ip)) {
    console.warn('Rate limited IP:', ip);
    return res.status(429).json({ error: 'Too many submissions. Please wait 10 minutes before trying again.' });
  }

  // Validate
  const payload = req.body;
  if (!payload) {
    return res.status(400).json({ error: 'Empty request body' });
  }

  const validationErrors = validatePayload(payload);
  if (validationErrors.length > 0) {
    console.warn('Validation failed:', validationErrors, '| IP:', ip);
    return res.status(400).json({ error: 'Validation failed', details: validationErrors });
  }

  // API key
  const apiKey = process.env.ODOO_API_KEY;
  if (!apiKey) {
    console.error('ODOO_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  // Authenticate with Odoo
  var uid;
  try {
    var authXml = xmlCall('authenticate', [
      ODOO_DB,
      'vinod.pandita@pxconsulting.in',
      apiKey,
      {}
    ]);
    var authRes = await post(ODOO_URL, '/xmlrpc/2/common', authXml);
    if (authRes.body.includes('<fault>')) {
      throw new Error('Auth fault: ' + authRes.body.substring(0, 200));
    }
    uid = parseXmlInt(authRes.body);
    if (!uid) throw new Error('No uid returned');
    console.log('Authenticated. UID: ' + uid + ' | IP: ' + ip);
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(500).json({ success: false, error: 'Authentication failed' });
  }

  // ── ENRICHMENT UPDATE (patch existing lead) ─────────────────
  if (payload._action === 'update') {
    try {
      const updateData = {};
      if (payload.industry) updateData.x_industry  = payload.industry;
      if (payload.teamSize)  updateData.x_team_size = payload.teamSize;

      if (Object.keys(updateData).length === 0) {
        return res.status(200).json({ success: true, skipped: true });
      }

      var updateXml = xmlCall('execute_kw', [
        ODOO_DB, uid, apiKey,
        'crm.lead', 'write',
        [[payload.leadId], updateData]
      ]);
      var updateRes = await post(ODOO_URL, '/xmlrpc/2/object', updateXml);
      if (updateRes.body.includes('<fault>')) {
        throw new Error(updateRes.body.substring(0, 300));
      }
      console.log('Enrichment updated. Lead ID: ' + payload.leadId);
      return res.status(200).json({ success: true, updated: true });
    } catch (err) {
      console.error('Enrichment update error:', err.message);
      return res.status(500).json({ success: false, error: 'Enrichment update failed' });
    }
  }

  // Build lead record
  var leadData = {
    name:         '[Diagnostic] ' + payload.name.trim() + (payload.company ? ' — ' + payload.company.trim() : ''),
    contact_name: payload.name.trim(),
    email_from:   payload.email.trim(),
    stage_id:     STAGE_ID,
  };

  if (payload.company)       leadData.partner_name    = payload.company.trim();
  if (payload.phone)         leadData.phone           = payload.phone.trim();
  if (payload.phone)         leadData.x_whatsapp      = payload.phone.trim();
  if (payload.description)   leadData.description     = payload.description;
  if (payload.revenue)       leadData.x_revenue_range = payload.revenue;
  if (payload.dimScoresText) leadData.x_dim_scores    = payload.dimScoresText;
  if (payload.weakestDim)    leadData.x_weakest_dim   = payload.weakestDim;
  if (payload.qualification) leadData.x_qualification = payload.qualification;
  if (payload.industry)      leadData.x_industry      = payload.industry;
  if (payload.teamSize)      leadData.x_team_size     = payload.teamSize;
  if (payload.totalPct !== undefined && payload.totalPct !== null) {
    leadData.x_total_score = parseInt(payload.totalPct) || 0;
  }

  // Create CRM lead
  try {
    var createXml = xmlCall('execute_kw', [
      ODOO_DB, uid, apiKey,
      'crm.lead', 'create',
      [leadData]
    ]);

    var createRes = await post(ODOO_URL, '/xmlrpc/2/object', createXml);

    if (createRes.body.includes('<fault>')) {
      console.error('Create fault:', createRes.body.substring(0, 3000));
      throw new Error(createRes.body.substring(0, 500));
    }

    var leadId = parseXmlInt(createRes.body);
    if (!leadId) throw new Error('No lead ID in response');

    console.log('Lead created. Odoo ID: ' + leadId + ' | ' + payload.name + ' | ' + payload.totalPct + '% | ' + payload.qualification + ' | IP: ' + ip);
    return res.status(200).json({ success: true, leadId: leadId });

  } catch (err) {
    console.error('Create error:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to create lead' });
  }
}
