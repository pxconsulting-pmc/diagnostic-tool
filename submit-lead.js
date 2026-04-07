/* ═══════════════════════════════════════════════════════════════
   PX Consulting — Diagnostic Tool → Odoo CRM
   Netlify Serverless Function

   SETUP:
   1. In Netlify dashboard → Site configuration → Environment variables
      Add: ODOO_API_KEY = your key from Odoo Settings → Users → API Keys

   2. Deploy this file at: netlify/functions/submit-lead.js
      alongside your HTML file at the repo root.

   3. The HTML calls: /.netlify/functions/submit-lead
      This function calls: https://pxconsulting.odoo.com
      No CORS issue because this runs server-side.

   ODOO FIELDS USED:
   Standard:  name, contact_name, partner_name, email_from, mobile, description, stage_id
   Custom:    x_revenue_range, x_whatsapp, x_total_score, x_dim_scores, x_weakest_dim, x_qualification
   ═══════════════════════════════════════════════════════════════ */

const ODOO_BASE_URL = 'https://pxconsulting.odoo.com';
const ODOO_DB       = 'px-consulting';
const STAGE_ID      = 1; // "Score Delivered" — first stage in your CRM pipeline

exports.handler = async (event) => {

  // Only accept POST
  if(event.httpMethod !== 'POST'){
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Parse body
  let payload;
  try {
    payload = JSON.parse(event.body);
  } catch(e) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON in request body' })
    };
  }

  // Require API key in env
  const apiKey = process.env.ODOO_API_KEY;
  if(!apiKey){
    console.error('ODOO_API_KEY environment variable not set in Netlify.');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Server configuration error — API key missing' })
    };
  }

  // Build the CRM lead record
  const leadData = {
    // ── Standard Odoo CRM fields ──
    name:          `[Diagnostic] ${payload.name}${payload.company ? ' — ' + payload.company : ''}`,
    contact_name:  payload.name,
    partner_name:  payload.company || '',
    email_from:    payload.email,
    mobile:        payload.phone || '',
    description:   payload.description || '',
    stage_id:      STAGE_ID,

    // ── Custom PX fields (already exist in your Odoo CRM) ──
    x_revenue_range:  payload.revenue    || '',
    x_whatsapp:       payload.phone      || '',
    x_total_score:    payload.totalPct   || 0,
    x_dim_scores:     payload.dimScoresText || '',
    x_weakest_dim:    payload.weakestDim || '',
    x_qualification:  payload.qualification || 'junk',
  };

  // Call Odoo JSON-RPC
  try {
    const response = await fetch(`${ODOO_BASE_URL}/web/dataset/call_kw`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'call',
        params: {
          model:  'crm.lead',
          method: 'create',
          args:   [leadData],
          kwargs: {}
        }
      })
    });

    const data = await response.json();

    // Odoo returns errors inside a 200 response in the .error field
    if(data.error){
      console.error('Odoo API error:', JSON.stringify(data.error));
      return {
        statusCode: 500,
        body: JSON.stringify({
          success: false,
          error: data.error.data?.message || data.error.message || 'Odoo error'
        })
      };
    }

    // Success — data.result is the new lead ID
    console.log(`PX Diagnostic: Lead created. Odoo ID: ${data.result} | Name: ${payload.name} | Score: ${payload.totalPct}% | Qualification: ${payload.qualification}`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, leadId: data.result })
    };

  } catch(err) {
    console.error('PX Diagnostic: Fetch to Odoo failed:', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: err.message })
    };
  }
};
