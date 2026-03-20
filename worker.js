/**
 * 포쿨 광고 대시보드 — Cloudflare Worker v2
 * - HMAC-SHA256 서명 + CORS 프록시
 * - 날짜 파라미터 지원 (최대 1년)
 * - Claude AI 프록시 (API 키 서버 보관)
 * - CORS 보안: GitHub Pages 도메인만 허용
 *
 * 환경변수 (wrangler secret put):
 *   NAVER_API_KEY, NAVER_SECRET, NAVER_CUSTOMER_ID, CLAUDE_API_KEY
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
const MAX_DAILY_DAYS = 31;
const BATCH_SIZE = 20;

// ── AI Rate Limit (in-memory, resets on Worker restart) ──
const aiRateMap = new Map();
const AI_RATE_LIMIT = 20; // max calls per hour
const AI_RATE_WINDOW = 3600000; // 1 hour in ms

// ── HMAC-SHA256 서명 ──
async function sign(secret, timestamp, method, path) {
  const msg = `${timestamp}.${method}.${path}`;
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

// ── CORS ──
function getCorsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
    'Vary': 'Origin',
  };
}

function jsonResponse(data, status, request) {
  return new Response(JSON.stringify(data), { status: status || 200, headers: getCorsHeaders(request) });
}

// ── Origin 검증 ──
function isOriginAllowed(request) {
  const origin = request.headers.get('Origin') || '';
  const referer = request.headers.get('Referer') || '';
  // Allow: valid origin, or no origin (direct curl/server calls for health)
  if (!origin && !referer) return true; // direct API call (curl, server)
  return ALLOWED_ORIGINS.some(o => origin.startsWith(o) || referer.startsWith(o));
}

// ── Naver API 호출 ──
async function naverFetch(env, method, path) {
  const ts = String(Date.now());
  const signature = await sign(env.NAVER_SECRET, ts, method, path);
  const res = await fetch(NAVER_BASE + path, {
    method,
    headers: {
      'X-Timestamp': ts,
      'X-API-KEY': env.NAVER_API_KEY,
      'X-Customer': env.NAVER_CUSTOMER_ID,
      'X-Signature': signature,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
}

async function getStats(env, cid, fields, since, until) {
  const f = encodeURIComponent(JSON.stringify(fields));
  const t = encodeURIComponent(JSON.stringify({ since, until }));
  const qs = `ids=${cid}&fields=${f}&timeRange=${t}&timeUnit=TOTAL`;
  const ts = String(Date.now());
  const signature = await sign(env.NAVER_SECRET, ts, 'GET', '/stats');
  const res = await fetch(`${NAVER_BASE}/stats?${qs}`, {
    headers: {
      'X-Timestamp': ts,
      'X-API-KEY': env.NAVER_API_KEY,
      'X-Customer': env.NAVER_CUSTOMER_ID,
      'X-Signature': signature,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) return null;
  const json = await res.json();
  return json.data && json.data[0] ? json.data[0] : null;
}

// ── 배치 병렬 처리 ──
async function batchProcess(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
  }
  return results;
}

// ── 날짜 유틸 ──
function parseDate(str) { return new Date(str + 'T00:00:00Z'); }
function fmtDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }
function daysBetween(a, b) { return Math.round((parseDate(b) - parseDate(a)) / 86400000) + 1; }

function calcPrevPeriod(since, until) {
  const days = daysBetween(since, until);
  const prevUntil = addDays(parseDate(since), -1);
  const prevSince = addDays(prevUntil, -(days - 1));
  return { since: fmtDate(prevSince), until: fmtDate(prevUntil) };
}

function getDateList(since, until) {
  const dates = [];
  let d = parseDate(since);
  const end = parseDate(until);
  while (d <= end) {
    dates.push(fmtDate(d));
    d = addDays(d, 1);
  }
  return dates;
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
async function handleDashboard(env, request) {
  const url = new URL(request.url);
  const today = new Date();
  const yesterday = fmtDate(addDays(today, -1));

  // 날짜 파라미터 (기본 최근 7일)
  const since = url.searchParams.get('since') || fmtDate(addDays(today, -7));
  const until = url.searchParams.get('until') || yesterday;
  const wantDaily = url.searchParams.get('daily') !== 'false';

  // 기간 제한 (최대 1년)
  const periodDays = daysBetween(since, until);
  if (periodDays > 366) {
    return jsonResponse({ error: '최대 1년(366일)까지 조회 가능합니다.' }, 400, request);
  }

  // 비교 기간 자동 계산
  const prev = calcPrevPeriod(since, until);

  // 캠페인 목록
  const campaigns = await naverFetch(env, 'GET', '/ncc/campaigns');
  if (!Array.isArray(campaigns)) {
    return jsonResponse({ error: 'Failed to fetch campaigns', detail: campaigns }, 500, request);
  }

  // 이번 기간 + 이전 기간 통계 (배치 병렬)
  const statsThis = {};
  const statsPrev = {};

  await batchProcess(campaigns, async (c) => {
    const cid = c.nccCampaignId;
    const [curr, previous] = await Promise.all([
      getStats(env, cid, ALL_FIELDS, since, until),
      getStats(env, cid, ALL_FIELDS, prev.since, prev.until),
    ]);
    if (curr) statsThis[cid] = curr;
    if (previous) statsPrev[cid] = previous;
    return cid;
  });

  // 일별 데이터 (31일 이하만)
  let dailyList = [];
  if (wantDaily && periodDays <= MAX_DAILY_DAYS) {
    const activeCids = Object.keys(statsThis);
    const dates = getDateList(since, until);
    const daily = {};

    for (const dt of dates) {
      daily[dt] = {};
      DAILY_FIELDS.forEach(f => daily[dt][f] = 0);

      await batchProcess(activeCids, async (cid) => {
        const s = await getStats(env, cid, DAILY_FIELDS, dt, dt);
        if (s) DAILY_FIELDS.forEach(f => daily[dt][f] += (s[f] || 0));
        return cid;
      });
    }

    dailyList = dates.map(dt => ({ date: dt, ...daily[dt] }));
  }

  // 캠페인별 경고 플래그 계산
  const alerts = [];
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

    // 광고비 급증 경고 (이전 기간 대비 50% 이상 증가)
    if (meta.stats && meta.prevStats) {
      const currCost = meta.stats.salesAmt || 0;
      const prevCost = meta.prevStats.salesAmt || 0;
      if (prevCost > 0 && currCost > 0) {
        const pctChange = ((currCost - prevCost) / prevCost) * 100;
        if (pctChange >= 50) {
          meta.costAlert = { pctChange: Math.round(pctChange), currCost, prevCost };
          alerts.push({
            campaignId: cid,
            campaignName: c.name,
            type: 'COST_SPIKE',
            pctChange: Math.round(pctChange),
            currCost,
            prevCost,
          });
        }
      }
    }
    return meta;
  });

  // 전체 KPI 경고
  const kpi = sumKPI(statsThis);
  const prevKpi = sumKPI(statsPrev);
  const totalCostChange = prevKpi.salesAmt > 0
    ? Math.round(((kpi.salesAmt - prevKpi.salesAmt) / prevKpi.salesAmt) * 100) : 0;

  if (totalCostChange >= 20) {
    alerts.unshift({
      type: 'TOTAL_COST_UP',
      pctChange: totalCostChange,
      currCost: kpi.salesAmt,
      prevCost: prevKpi.salesAmt,
      message: `전체 광고비가 이전 기간 대비 ${totalCostChange}% 증가했습니다.`,
    });
  }

  return jsonResponse({
    generated: new Date().toISOString(),
    period: { since, until, days: periodDays },
    prevPeriod: prev,
    kpi,
    prevKpi,
    daily: dailyList,
    campaigns: campList,
    alerts,
    totalCampaigns: campaigns.length,
    statsCollected: Object.keys(statsThis).length,
  }, 200, request);
}

// ── /api/ai ──
async function handleAI(env, request) {
  // Rate limit check
  const now = Date.now();
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateKey = clientIP;
  const rateData = aiRateMap.get(rateKey) || { count: 0, resetAt: now + AI_RATE_WINDOW };

  if (now > rateData.resetAt) {
    rateData.count = 0;
    rateData.resetAt = now + AI_RATE_WINDOW;
  }
  if (rateData.count >= AI_RATE_LIMIT) {
    return jsonResponse({ error: `AI 분석은 시간당 ${AI_RATE_LIMIT}회로 제한됩니다.` }, 429, request);
  }
  rateData.count++;
  aiRateMap.set(rateKey, rateData);

  if (!env.CLAUDE_API_KEY) {
    return jsonResponse({ error: 'CLAUDE_API_KEY가 설정되지 않았습니다.' }, 500, request);
  }

  const body = await request.json();
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

  const result = await res.json();
  return jsonResponse(result, res.status, request);
}

// ── Router ──
export default {
  async fetch(request, env) {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: getCorsHeaders(request) });
    }

    // Origin 검증 (health 제외)
    const url = new URL(request.url);
    const path = url.pathname;

    if (path !== '/health' && !isOriginAllowed(request)) {
      return jsonResponse({ error: 'Forbidden: origin not allowed' }, 403, request);
    }

    try {
      if (path === '/health') {
        return jsonResponse({ status: 'ok', timestamp: new Date().toISOString() }, 200, request);
      }

      if (path === '/api/dashboard') {
        return await handleDashboard(env, request);
      }

      if (path === '/api/ai' && request.method === 'POST') {
        return await handleAI(env, request);
      }

      if (path === '/proxy') {
        const apiPath = url.searchParams.get('path');
        if (!apiPath) return jsonResponse({ error: 'path parameter required' }, 400, request);
        return jsonResponse(await naverFetch(env, 'GET', apiPath), 200, request);
      }

      return jsonResponse({
        error: 'Not found',
        endpoints: ['/api/dashboard?since=&until=', '/api/ai', '/proxy?path=', '/health'],
      }, 404, request);
    } catch (e) {
      return jsonResponse({ error: e.message, stack: e.stack }, 500, request);
    }
  }
};
