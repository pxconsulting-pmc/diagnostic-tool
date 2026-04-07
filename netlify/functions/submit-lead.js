/* ═══════════════════════════════════════════════════════════════
   PX Consulting — Diagnostic Tool → Odoo CRM
   Netlify Serverless Function

   SETUP:
   1. Netlify dashboard → Site configuration → Environment variables
      Add: ODOO_API_KEY = your key from Odoo Settings → Users → API Keys

   2. File lives at: netlify/functions/submit-lead.js

   3. HTML calls /.netlify/functions/submit-lead
      This function calls pxconsulting.odoo.com server-side — no CORS.

   ODOO 19 API:
   Uses the new JSON-2 endpoint: /json/2/<model>/<method>
   Old /web/dataset/call_kw returns HTML in Odoo 19 — do not use.

   ODOO FIELDS:
   Standard:  name, contact_name, partner_name, email_from, mobile, description, stage_id
   Custom:    x_revenue_range, x_whatsapp, x_total_score, x_dim_scores, x_weakest_dim, x_qualification
   ═══════════════════════════════════════════════════════════════ */

const ODOO_BASE_URL = 'https://pxconsulting.odoo.com';
const ODOO_DB       = 'px-consulting';
const STAGE_ID      = 1; // "Score Delivered" — first stage in CRM pipeline

exports.handler = async (event) => {

  if(event.httpMethod !== 'POST'){
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON in request body' }) };
  }

  const apiKey = process.env.ODOO_API_KEY;
  if(!apiKey){
    console.error('ODOO_API_KEY not set in Netlify environment variables.');
    return { statusCode: 500, body: JSON.stringify({ error: 'Server config error — API key missing' }) };
  }

  const leadData = {
    name:         `[Diagnostic] ${payload.name}${payload.company ? ' — ' + payload.company : ''}`,
    contact_name: payload.name,
    partner_name: payload.company || '',
    email_from:   payload.email,
    mobile:       payload.phone || '',
    description:  payload.description || '',
    stage_id:     STAGE_ID,
    x_revenue_range: payload.revenue       || '',
    x_whatsapp:      payload.phone         || '',
    x_total_score:   payload.totalPct      || 0,
    x_dim_scores:    payload.dimScoresText || '',
    x_weakest_dim:   payload.weakestDim    || '',
    x_qualification: payload.qualification || 'junk',
  };

  try {
    const odooResponse = await fetch(`${ODOO_BASE_URL}/json/2/crm.lead/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'DATABASE': ODOO_DB,
      },
      body: JSON.stringify({ args: [[leadData]] })
    });

    console.log(`Odoo response status: ${odooResponse.status}`);
    const responseText = await odooResponse.text();

    if(responseText.trim().startsWith('<')){
      console.error('Odoo returned HTML. First 300 chars:', responseText.substring(0, 300));
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, error: 'Odoo returned HTML — check API key and DATABASE header' })
      };
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch(e) {
      console.error('Could not parse Odoo response:', responseText.substring(0, 300));
      return { statusCode: 500, body: JSON.stringify({ success: false, error: 'Odoo response not valid JSON' }) };
    }

    if(data.error){
      console.error('Odoo API error:', JSON.stringify(data.error));
      return {
        statusCode: 500,
        body: JSON.stringify({ success: false, error: data.error.data?.message || data.error.message || JSON.stringify(data.error) })
      };
    }

    const leadId = data.result;
    console.log(`Lead created. Odoo ID: ${leadId} | Name: ${payload.name} | Score: ${payload.totalPct}% | Qual: ${payload.qualification}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, leadId })
    };

  } catch(err) {
    console.error('Fetch to Odoo failed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
