/**
 * 포쿨 광고 대시보드 — Cloudflare Worker
 * 역할: HMAC-SHA256 서명 + CORS 프록시 + 통계 집계
 *
 * 환경변수 (wrangler secret put):
 *   NAVER_API_KEY, NAVER_SECRET, NAVER_CUSTOMER_ID
 */

const BASE = 'https://api.searchad.naver.com';
const ALL_FIELDS = ['impCnt','clkCnt','ctr','cpc','salesAmt','ccnt','convAmt','ror','crto','cpConv'];

// ── HMAC-SHA256 서명 ──
async function sign(secret, timestamp, method, path) {
  const msg = `${timestamp}.${method}.${path}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function getHeaders(env, method, path, timestamp) {
  return {
    'X-Timestamp': timestamp,
    'X-API-KEY': env.NAVER_API_KEY,
    'X-Customer': env.NAVER_CUSTOMER_ID,
    'Content-Type': 'application/json',
  };
}

// ── CORS Headers ──
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

// ── Naver API call helper ──
async function naverFetch(env, method, path, queryString = '') {
  const ts = String(Date.now());
  const signature = await sign(env.NAVER_SECRET, ts, method, path);
  const headers = {
    ...getHeaders(env, method, path, ts),
    'X-Signature': signature,
  };
  const url = BASE + path + (queryString ? '?' + queryString : '');
  const res = await fetch(url, { method, headers });
  return res.json();
}

// ── Stats for one campaign ──
async function getStats(env, cid, fields, since, until, timeUnit = 'TOTAL') {
  const f = encodeURIComponent(JSON.stringify(fields));
  const t = encodeURIComponent(JSON.stringify({ since, until }));
  const qs = `ids=${cid}&fields=${f}&timeRange=${t}&timeUnit=${timeUnit}`;

  const ts = String(Date.now());
  const signature = await sign(env.NAVER_SECRET, ts, 'GET', '/stats');
  const headers = {
    ...getHeaders(env, 'GET', '/stats', ts),
    'X-Signature': signature,
  };
  const res = await fetch(`${BASE}/stats?${qs}`, { headers });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data && json.data[0] ? json.data[0] : null;
}

// ── Date helpers ──
function dateStr(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

// ── Aggregate KPI ──
function sumKPI(statsMap) {
  const totals = {};
  ALL_FIELDS.forEach(f => totals[f] = 0);
  let count = 0;
  for (const v of Object.values(statsMap)) {
    ALL_FIELDS.forEach(f => totals[f] += (v[f] || 0));
    count++;
  }
  if (totals.impCnt > 0) totals.ctr = Math.round(totals.clkCnt / totals.impCnt * 10000) / 100;
  if (totals.clkCnt > 0) totals.cpc = Math.round(totals.salesAmt / totals.clkCnt);
  if (totals.salesAmt > 0) totals.ror = Math.round(totals.convAmt / totals.salesAmt * 10000) / 100;
  if (totals.clkCnt > 0) totals.crto = Math.round(totals.ccnt / totals.clkCnt * 10000) / 100;
  if (totals.ccnt > 0) totals.cpConv = Math.round(totals.salesAmt / totals.ccnt);
  return totals;
}

// ── Main Dashboard Endpoint ──
async function handleDashboard(env) {
  const since = dateStr(7);
  const until = dateStr(1);
  const prevSince = dateStr(14);
  const prevUntil = dateStr(8);

  // Get campaigns
  const campaigns = await naverFetch(env, 'GET', '/ncc/campaigns');
  if (!Array.isArray(campaigns)) {
    return jsonResponse({ error: 'Failed to fetch campaigns', detail: campaigns }, 500);
  }

  // Collect stats (this week + prev week)
  const statsThis = {};
  const statsPrev = {};

  for (let i = 0; i < campaigns.length; i++) {
    const cid = campaigns[i].nccCampaignId;

    const [thisWeek, prevWeek] = await Promise.all([
      getStats(env, cid, ALL_FIELDS, since, until),
      getStats(env, cid, ALL_FIELDS, prevSince, prevUntil),
    ]);

    if (thisWeek) statsThis[cid] = thisWeek;
    if (prevWeek) statsPrev[cid] = prevWeek;

    // Rate limit: small delay every 10 campaigns
    if ((i + 1) % 10 === 0) await new Promise(r => setTimeout(r, 100));
  }

  // Daily stats for active campaigns
  const activeCids = Object.keys(statsThis);
  const daily = {};
  const dailyFields = ['impCnt','clkCnt','salesAmt','ccnt','convAmt'];

  for (let d = 7; d >= 1; d--) {
    const dt = dateStr(d);
    daily[dt] = {};
    dailyFields.forEach(f => daily[dt][f] = 0);

    for (const cid of activeCids) {
      const s = await getStats(env, cid, dailyFields, dt, dt);
      if (s) dailyFields.forEach(f => daily[dt][f] += (s[f] || 0));
    }
    await new Promise(r => setTimeout(r, 50));
  }

  const dailyList = Object.keys(daily).sort().map(dt => ({ date: dt, ...daily[dt] }));

  // Build campaign list
  const campList = campaigns.map(c => {
    const cid = c.nccCampaignId;
    const meta = {
      id: cid,
      name: c.name || '',
      type: c.campaignTp || '',
      deliveryStatus: c.status || '',
      dailyBudget: c.dailyBudget || 0,
    };
    if (statsThis[cid]) meta.stats = statsThis[cid];
    if (statsPrev[cid]) meta.prevStats = statsPrev[cid];
    return meta;
  });

  return jsonResponse({
    generated: new Date().toISOString(),
    period: { since, until },
    prevPeriod: { since: prevSince, until: prevUntil },
    kpi: sumKPI(statsThis),
    prevKpi: sumKPI(statsPrev),
    daily: dailyList,
    campaigns: campList,
    totalCampaigns: campaigns.length,
    statsCollected: Object.keys(statsThis).length,
  });
}

// ── Proxy Endpoint (generic) ──
async function handleProxy(env, path) {
  return jsonResponse(await naverFetch(env, 'GET', path));
}

// ── Router ──
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/api/dashboard') {
        return await handleDashboard(env);
      }

      if (path === '/proxy') {
        const apiPath = url.searchParams.get('path');
        if (!apiPath) return jsonResponse({ error: 'path parameter required' }, 400);
        return await handleProxy(env, apiPath);
      }

      if (path === '/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() });
      }

      return jsonResponse({ error: 'Not found', endpoints: ['/api/dashboard', '/proxy?path=...', '/health'] }, 404);
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};
