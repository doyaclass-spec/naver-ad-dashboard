/**
 * 포쿨 광고 대시보드 — Cloudflare Worker v2.1
 * - 캠페인 타입별 배치 호출 (subrequest 50개 제한 대응)
 * - /api/dashboard: KPI + 캠페인 테이블
 * - /api/daily?date=X: 일별 집계 (대시보드에서 날짜별 호출)
 * - /api/ai: Claude API 프록시
 *
 * Secrets: NAVER_API_KEY, NAVER_SECRET, NAVER_CUSTOMER_ID, CLAUDE_API_KEY
 */

const NAVER_BASE = 'https://api.searchad.naver.com';
const CLAUDE_BASE = 'https://api.anthropic.com/v1/messages';
const ALL_FIELDS = ['impCnt','clkCnt','ctr','cpc','salesAmt','ccnt','convAmt','ror','crto','cpConv'];
const DAILY_FIELDS = ['impCnt','clkCnt','salesAmt','ccnt','convAmt'];
const ALLOWED_ORIGINS = [
  'https://doyaclass-spec.github.io',
  'http://localhost:8080',
  'http://localhost:3000',
];
const BATCH_IDS = 20; // max campaign IDs per stats call

// ── AI Rate Limit ──
const aiRateMap = new Map();
const AI_RATE_LIMIT = 20;
const AI_RATE_WINDOW = 3600000;

// ── HMAC-SHA256 ──
async function sign(secret, ts, method, path) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`${ts}.${method}.${path}`));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ── CORS ──
function getCorsHeaders(req) {
  const origin = req.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

function json(data, status, req) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: getCorsHeaders(req) });
}

function isOriginAllowed(req) {
  const origin = req.headers.get('Origin') || '';
  const referer = req.headers.get('Referer') || '';
  if (!origin && !referer) return true;
  return ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o));
}

// ── Naver API: 캠페인 목록 ──
async function getCampaigns(env) {
  const ts = String(Date.now());
  const sig = await sign(env.NAVER_SECRET, ts, 'GET', '/ncc/campaigns');
  const res = await fetch(NAVER_BASE + '/ncc/campaigns', {
    headers: {
      'X-Timestamp': ts, 'X-API-KEY': env.NAVER_API_KEY,
      'X-Customer': env.NAVER_CUSTOMER_ID, 'X-Signature': sig,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

// ── Naver API: 배치 통계 (같은 타입 캠페인 묶어서 호출) ──
async function getBatchStats(env, cids, fields, since, until) {
  const idsStr = cids.join(',');
  const f = encodeURIComponent(JSON.stringify(fields));
  const t = encodeURIComponent(JSON.stringify({ since, until }));
  const qs = `ids=${idsStr}&fields=${f}&timeRange=${t}&timeUnit=TOTAL`;

  const ts = String(Date.now());
  const sig = await sign(env.NAVER_SECRET, ts, 'GET', '/stats');
  const res = await fetch(`${NAVER_BASE}/stats?${qs}`, {
    headers: {
      'X-Timestamp': ts, 'X-API-KEY': env.NAVER_API_KEY,
      'X-Customer': env.NAVER_CUSTOMER_ID, 'X-Signature': sig,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return data.data || [];
}

// ── 타입별 배치 통계 수집 ──
async function collectAllStats(env, campaigns, fields, since, until) {
  // 타입별로 그룹화
  const typeGroups = {};
  for (const c of campaigns) {
    const tp = c.campaignTp || 'UNKNOWN';
    if (!typeGroups[tp]) typeGroups[tp] = [];
    typeGroups[tp].push(c.nccCampaignId);
  }

  const statsMap = {};

  // 각 타입의 캠페인을 BATCH_IDS개씩 묶어서 호출
  for (const [tp, cids] of Object.entries(typeGroups)) {
    for (let i = 0; i < cids.length; i += BATCH_IDS) {
      const batch = cids.slice(i, i + BATCH_IDS);
      const results = await getBatchStats(env, batch, fields, since, until);
      for (const row of results) {
        if (row.id) statsMap[row.id] = row;
      }
    }
  }

  return statsMap;
}

// ── 날짜 유틸 ──
function parseD(s) { return new Date(s + 'T00:00:00Z'); }
function fmtD(d) { return d.toISOString().slice(0, 10); }
function addD(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }
function daysBetween(a, b) { return Math.round((parseD(b) - parseD(a)) / 86400000) + 1; }

function calcPrev(since, until) {
  const days = daysBetween(since, until);
  const pu = addD(parseD(since), -1);
  const ps = addD(pu, -(days - 1));
  return { since: fmtD(ps), until: fmtD(pu) };
}

// ── KPI 합산 ──
function sumKPI(statsMap) {
  const t = {};
  ALL_FIELDS.forEach(f => t[f] = 0);
  for (const v of Object.values(statsMap)) {
    ALL_FIELDS.forEach(f => t[f] += (v[f] || 0));
  }
  if (t.impCnt > 0) t.ctr = Math.round(t.clkCnt / t.impCnt * 10000) / 100;
  if (t.clkCnt > 0) t.cpc = Math.round(t.salesAmt / t.clkCnt);
  if (t.salesAmt > 0) t.ror = Math.round(t.convAmt / t.salesAmt * 10000) / 100;
  if (t.clkCnt > 0) t.crto = Math.round(t.ccnt / t.clkCnt * 10000) / 100;
  if (t.ccnt > 0) t.cpConv = Math.round(t.salesAmt / t.ccnt);
  return t;
}

// ── /api/dashboard ──
async function handleDashboard(env, req) {
  const url = new URL(req.url);
  const today = fmtD(new Date());
  const yesterday = fmtD(addD(new Date(), -1));

  const since = url.searchParams.get('since') || fmtD(addD(new Date(), -7));
  const until = url.searchParams.get('until') || yesterday;

  const periodDays = daysBetween(since, until);
  if (periodDays > 366) return json({ error: '최대 1년까지 조회 가능합니다.' }, 400, req);

  const prev = calcPrev(since, until);

  // 1. 캠페인 목록 (1 subrequest)
  const campaigns = await getCampaigns(env);
  if (!Array.isArray(campaigns)) return json({ error: 'Failed to fetch campaigns' }, 500, req);

  // 2. 이번 기간 통계 (~12 subrequests)
  const statsThis = await collectAllStats(env, campaigns, ALL_FIELDS, since, until);

  // 3. 이전 기간 통계 (~12 subrequests)
  const statsPrev = await collectAllStats(env, campaigns, ALL_FIELDS, prev.since, prev.until);

  // Total: ~25 subrequests (well within 50 limit)

  // 캠페인 목록 + 경고 생성
  const alerts = [];
  const campList = campaigns.map(c => {
    const cid = c.nccCampaignId;
    const meta = {
      id: cid, name: c.name || '', type: c.campaignTp || '',
      deliveryStatus: c.status || '', dailyBudget: c.dailyBudget || 0,
    };
    if (statsThis[cid]) meta.stats = statsThis[cid];
    if (statsPrev[cid]) meta.prevStats = statsPrev[cid];

    // 광고비 급증 경고
    if (meta.stats && meta.prevStats) {
      const curr = meta.stats.salesAmt || 0;
      const prev = meta.prevStats.salesAmt || 0;
      if (prev > 0 && curr > 0) {
        const pct = Math.round(((curr - prev) / prev) * 100);
        if (pct >= 50) {
          meta.costAlert = { pctChange: pct, currCost: curr, prevCost: prev };
          alerts.push({ campaignId: cid, campaignName: c.name, type: 'COST_SPIKE', pctChange: pct, currCost: curr, prevCost: prev });
        }
      }
    }
    return meta;
  });

  const kpi = sumKPI(statsThis);
  const prevKpi = sumKPI(statsPrev);
  const totalCostChange = prevKpi.salesAmt > 0
    ? Math.round(((kpi.salesAmt - prevKpi.salesAmt) / prevKpi.salesAmt) * 100) : 0;

  if (totalCostChange >= 20) {
    alerts.unshift({
      type: 'TOTAL_COST_UP', pctChange: totalCostChange,
      currCost: kpi.salesAmt, prevCost: prevKpi.salesAmt,
      message: `전체 광고비가 이전 기간 대비 ${totalCostChange}% 증가했습니다.`,
    });
  }

  return json({
    generated: new Date().toISOString(),
    period: { since, until, days: periodDays },
    prevPeriod: prev,
    kpi, prevKpi, alerts,
    campaigns: campList,
    totalCampaigns: campaigns.length,
    statsCollected: Object.keys(statsThis).length,
    daily: [], // daily data fetched separately via /api/daily
  }, 200, req);
}

// ── /api/daily?date=YYYY-MM-DD ──
async function handleDaily(env, req) {
  const url = new URL(req.url);
  const date = url.searchParams.get('date');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return json({ error: 'date parameter required (YYYY-MM-DD)' }, 400, req);
  }

  // 캠페인 목록 (1 subrequest)
  const campaigns = await getCampaigns(env);
  if (!Array.isArray(campaigns)) return json({ error: 'Failed to fetch campaigns' }, 500, req);

  // 해당 날짜 통계 (~12 subrequests)
  const stats = await collectAllStats(env, campaigns, DAILY_FIELDS, date, date);

  // 합산
  const totals = {};
  DAILY_FIELDS.forEach(f => totals[f] = 0);
  for (const v of Object.values(stats)) {
    DAILY_FIELDS.forEach(f => totals[f] += (v[f] || 0));
  }

  return json({ date, ...totals, campaignsWithData: Object.keys(stats).length }, 200, req);
}

// ── /api/ai ──
async function handleAI(env, req) {
  const now = Date.now();
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const rate = aiRateMap.get(ip) || { count: 0, resetAt: now + AI_RATE_WINDOW };
  if (now > rate.resetAt) { rate.count = 0; rate.resetAt = now + AI_RATE_WINDOW; }
  if (rate.count >= AI_RATE_LIMIT) {
    return json({ error: `AI 분석은 시간당 ${AI_RATE_LIMIT}회로 제한됩니다.` }, 429, req);
  }
  rate.count++;
  aiRateMap.set(ip, rate);

  if (!env.CLAUDE_API_KEY) return json({ error: 'CLAUDE_API_KEY 미설정' }, 500, req);

  const body = await req.json();
  const res = await fetch(CLAUDE_BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: body.model || 'claude-sonnet-4-20250514',
      max_tokens: body.max_tokens || 2048,
      messages: body.messages,
    }),
  });
  return json(await res.json(), res.status, req);
}

// ── Router ──
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    if (path !== '/health' && !isOriginAllowed(request)) {
      return json({ error: 'Forbidden' }, 403, request);
    }

    try {
      if (path === '/health') return json({ status: 'ok', ts: new Date().toISOString() }, 200, request);
      if (path === '/api/dashboard') return await handleDashboard(env, request);
      if (path === '/api/daily') return await handleDaily(env, request);
      if (path === '/api/ai' && request.method === 'POST') return await handleAI(env, request);
      return json({ error: 'Not found' }, 404, request);
    } catch (e) {
      return json({ error: e.message }, 500, request);
    }
  }
};
