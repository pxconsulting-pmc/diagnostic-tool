/* ═══════════════════════════════════════════════════════════════
   PX Consulting — Diagnostic Tool → Odoo CRM
   Netlify Serverless Function v3
   ═══════════════════════════════════════════════════════════════ */

const https = require('https');

const ODOO_BASE_URL = 'am595a.odoo.com';
const ODOO_DB       = 'px-consulting';
const STAGE_ID      = 1;

// Use Node's built-in https instead of fetch — works on all Netlify Node versions
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const options = {
      hostname,
      path,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(data),
      }
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

exports.handler = async (event) => {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const apiKey = process.env.ODOO_API_KEY;
  if (!apiKey) {
    console.error('ODOO_API_KEY not set');
    return { statusCode: 500, body: JSON.stringify({ error: 'API key missing' }) };
  }

  const leadData = {
    name:            `[Diagnostic] ${payload.name}${payload.company ? ' — ' + payload.company : ''}`,
    contact_name:    payload.name,
    partner_name:    payload.company    || '',
    email_from:      payload.email,
    mobile:          payload.phone      || '',
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
    const result = await httpsPost(
      ODOO_BASE_URL,
      '/json/2/crm.lead/create',
      {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'DATABASE':      ODOO_DB,
      },
      { args: [[leadData]] }
    );

    console.log(`Odoo HTTP status: ${result.status}`);
    console.log(`Odoo raw response (first 500): ${result.body.substring(0, 500)}`);

    // Detect HTML response (auth failure / redirect)
    if (result.body.trim().startsWith('<')) {
      console.error('Odoo returned HTML — auth failure or wrong endpoint');
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, error: 'Odoo returned HTML', preview: result.body.substring(0, 200) })
      };
    }

    let data;
    try {
      data = JSON.parse(result.body);
    } catch (e) {
      console.error('Could not parse Odoo response as JSON:', result.body.substring(0, 300));
      return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Odoo response not valid JSON' }) };
    }

    if (data.error) {
      console.error('Odoo API error:', JSON.stringify(data.error));
      return {
        statusCode: 500,
        body: JSON.stringify({
          success: false,
          error: data.error.data?.message || data.error.message || JSON.stringify(data.error)
        })
      };
    }

    const leadId = data.result;
    console.log(`✓ Lead created. Odoo ID: ${leadId} | ${payload.name} | ${payload.totalPct}% | ${payload.qualification}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, leadId })
    };

  } catch (err) {
    console.error('https request failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
