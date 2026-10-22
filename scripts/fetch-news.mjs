#!/usr/bin/env node
/**
 * 每日抓取「国内可直接访问」的芯片 / 半导体资讯 → news.json
 *
 * 数据源（全部国内站点，无需翻墙、无需代理）：
 *   1. 国际电子商情 ESM China  RSS      —— 垂直行业媒体，带真实发布时间
 *   2. 集微网                          —— 半导体产业媒体，首页头条
 *   3. 东方财富 7×24 快讯               —— 财经快讯，按芯片/代理关键词过滤
 *   4. 华尔街见闻 科技频道               —— 科技快讯，按关键词过滤
 *
 * 输出结构：
 *   { ok, generatedAt, generatedAtBeijing, chip: [...], agent: [...], sources: [...] }
 *
 * 规则：
 *   - 「综合资讯」= 芯片 / 半导体产业链，按发布时间倒序，多源轮转防止单一源刷屏
 *   - 「代理商动态」= 代理商类 + 原厂类，两类都要有保底条数
 *   - 跨源同一事件只留最早发布的一条，其余来源记在 alsoOn
 *   - 任一源失败不影响其他源；全部失败时退出码 1，由 workflow 保留旧文件
 */
import fs from 'node:fs';
import path from 'node:path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const OUT = path.resolve(process.cwd(), 'news.json');
const TMP = OUT + '.new';
const TIMEOUT = 15000;

/* ---------------- 关键词 ---------------- */

// 芯片 / 半导体产业链
const CHIP_RE = /芯片|半导体|晶圆|代工|封装|光刻|刻蚀|薄膜沉积|EDA|IP核|存储|内存|闪存|DRAM|NAND|HBM|算力|GPU|CPU|NPU|SoC|MCU|模拟芯片|功率器件|碳化硅|SiC|氮化镓|GaN|半导体设备|半导体材料|扩产|产能|涨价|降价|供需|交期|并购|资本开支|流片|制程|先进节点|台积电|中芯国际|华虹|长鑫|长江存储|长电科技|通富微|华天科技|寒武纪|海光|龙芯|地平线|英伟达|NVIDIA|AMD|英特尔|Intel|三星电子|SK海力士|美光|格芯|联电|力积电|光刻胶|硅片|封测|江波龙|澜起|兆易创新|中微公司|北方华创|拓荆|盛美|华峰测控|闻泰|三安光电|士兰微|华润微|比亚迪半导体|壁仞|摩尔线程|燧原|沐曦|黑芝麻|芯原|翱捷|恒玄|晶晨|瑞芯微|全志|汇顶|卓胜微|唯捷创芯|思瑞浦|纳芯微|圣邦微|艾为|力芯微|帝奥微/i;

// 人物 / 短主体语录（「黄仁勋：……」这类表态不算产业资讯）
const PERSON_QUOTE_RE = /^[\u4e00-\u9fa5A-Za-z]{2,4}[：:]/;

// 代理商 / 分销商
const AGENT_RE = /文晔|大联大|世平|品佳|诠鼎|友尚|艾睿|Arrow|安富利|Avnet|中电港|深圳华强|华强电子|力源信息|世健|威健|商络|科通|北高智|泰科源|新蕾|贝能|世强|润欣|英唐|富昌|Future Electronics|得捷|Digi-?Key|贸泽|Mouser|分销商|代理商|授权代理|代理线|渠道商|元器件分销/i;

// 芯片原厂
const VENDOR_RE = /德州仪器|\bTI\b|英飞凌|Infineon|恩智浦|NXP|瑞萨|Renesas|高通|Qualcomm|英伟达|NVIDIA|\bAMD\b|意法半导体|\bST\b|STMicro|微芯|Microchip|亚德诺|\bADI\b|安森美|onsemi|安世|Nexperia|罗姆|ROHM|铠侠|Kioxia|西部数据|三星电子|SK海力士|美光|华邦|兆易创新|圣邦微|纳芯微|韦尔|豪威|OMNIVISION|紫光展锐|华为海思|海思/i;

// 业务动作：用来剔除「只有公司名、没有业务信息」的闲聊与行情
const BIZ_RE = /发布|推出|上新|新品|量产|投产|扩产|增资|投资|收购|并购|合并|重组|合作|签约|授权|代理|分销|财报|业绩|营收|净利|利润|毛利|亏损|预警|预增|预减|涨价|降价|调价|报价|交期|缺货|产能|出货|交付|订单|配额|市占|份额|裁员|上市|融资|IPO|建厂|工厂|产线|研发|流片|制程|技术|方案|布局|拓展|深耕|落地|赋能|升级|供货|备货|库存|渠道/i;

// 纯行情 / 资金面（代理商板块直接排除）
const STOCK_RE = /股价|收跌|收涨|涨停|跌停|板块|指数|大盘|盘前|盘中|收盘|开盘|概念股|A股|港股|美股|涨逾|跌幅|涨幅|市值|净卖出|净买入|主力资金|融资余额|集体收|行情/i;

// 综合资讯只排除最硬的行情快讯（产业分析类保留）
const HARD_STOCK_RE = /收跌|收涨|涨停|跌停|净卖出|净买入|融资余额|集体收(涨|跌)|股价(上涨|下跌|涨|跌)|涨逾|跌幅达|涨幅达/i;

/* ---------------- 工具 ---------------- */

function stripTags(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function toIso(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (/^\d{10}$/.test(s)) return new Date(Number(s) * 1000).toISOString();
  if (/^\d{13}$/.test(s)) return new Date(Number(s)).toISOString();
  // 2026-10-22 15:12:39 视为北京时间
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const iso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}T` +
      `${String(m[4]).padStart(2, '0')}:${m[5]}:${m[6] || '00'}+08:00`;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toISOString();
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}

async function fetchText(url, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const resp = await fetch(url, {
      signal: ctl.signal,
      headers: Object.assign({
        'User-Agent': UA,
        'Accept': 'application/json, text/xml, text/html, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': new URL(url).origin + '/'
      }, headers || {})
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

// 标题清洗：去掉「8小时前」这类相对时间前缀与栏目前缀
function cleanTitle(t) {
  return stripTags(t)
    .replace(/^\s*\d+\s*(秒|分钟|小时|天)前\s*/, '')
    .replace(/^\s*【[^】]{0,8}】\s*/, '')
    .replace(/^(独家|快讯|要闻|重磅|突发)\s*[|｜:：]\s*/, '')
    .trim();
}

// 标题归一化：跨源去重用
function titleKey(t) {
  return String(t || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。、；：！？“”‘’（）【】《》—…·,.;:!?"'()\[\]<>\-|/\\]/g, '')
    .slice(0, 40);
}

/* ---------------- 各源解析 ---------------- */

// 1) 国际电子商情 RSS
async function fetchEsm() {
  const xml = await fetchText('https://www.esmchina.com/rss');
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);
  return items.map(block => {
    const pick = (tag) => {
      const re = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i');
      const mm = block.match(re);
      return mm ? stripTags(mm[1]) : '';
    };
    return {
      title: pick('title'),
      summary: pick('description').slice(0, 160),
      url: stripTags((block.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || ''),
      publishedAt: toIso(pick('pubDate1') || pick('pubDate') || pick('dc:date')),
      source: '国际电子商情'
    };
  }).filter(x => x.title && /^https?:/.test(x.url));
}

// 2) 集微网首页（首页无发布时间 → 按顺序递减近似，第一条最新）
async function fetchJiwei(nowMs) {
  const html = await fetchText('https://www.ijiwei.com/');
  const seen = new Set();
  const out = [];
  const re = /<a[^>]+href="(\/n\/\d+)"[^>]*>([\s\S]{0,240}?)<\/a>/g;
  let m;
  let i = 0;
  while ((m = re.exec(html))) {
    const href = m[1];
    const title = stripTags(m[2]);
    if (!title || title.length < 8 || seen.has(href)) continue;
    seen.add(href);
    out.push({
      title,
      summary: '',
      url: 'https://www.ijiwei.com' + href,
      // 首页顺序≈倒序，每条按 7 分钟递减，避免全部顶到最前
      publishedAt: new Date(nowMs - i * 7 * 60000).toISOString(),
      source: '集微网',
      timeApprox: true
    });
    i++;
    if (out.length >= 24) break;
  }
  return out;
}

// 详情页补摘要（只对最终入选、且首页没有摘要的几条调用）
async function fillSummary(item) {
  if (!item || item.summary || !item.url) return item;
  try {
    const html = await fetchText(item.url);
    const md = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    if (md && md[1]) item.summary = stripTags(md[1]).slice(0, 160);
  } catch (e) { /* 补不到摘要不影响收录 */ }
  return item;
}

// 3) 东方财富 7×24 快讯
async function fetchEastmoney() {
  const url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=60&req_trace=1';
  const data = JSON.parse(await fetchText(url));
  const list = (data && data.data && data.data.fastNewsList) || [];
  return list.map(it => ({
    title: stripTags(it.title || ''),
    summary: stripTags(it.summary || '').slice(0, 160),
    // 实测：kuaixun 路径 404，正确原文页是 finance/a/{code}.html
    url: it.code ? 'https://finance.eastmoney.com/a/' + it.code + '.html' : 'https://kuaixun.eastmoney.com/',
    publishedAt: toIso(it.showTime),
    source: '东方财富'
  })).filter(x => x.title);
}

// 4) 华尔街见闻 科技频道
async function fetchWallstreetcn() {
  const url = 'https://api-one.wallstcn.com/apiv1/content/lives?channel=tech-channel&limit=50';
  const data = JSON.parse(await fetchText(url));
  const items = (data && data.data && data.data.items) || [];
  return items.map(it => {
    const raw = stripTags(it.content_text || it.content || '');
    return {
      title: stripTags(it.title || '') || raw.slice(0, 60),
      summary: raw.slice(0, 160),
      url: it.uri || (it.id ? 'https://wallstreetcn.com/livenews/' + it.id : 'https://wallstreetcn.com/live/global'),
      publishedAt: toIso(it.display_time),
      source: '华尔街见闻'
    };
  }).filter(x => x.title && x.title.length >= 6);
}

// 5) 文晔科技官网新闻 —— 代理商营收 / 财报，最对口代理商动态
//    URL 前缀为 YYYYMM，取当月 1 日（只精确到月，前端按日期显示）
async function fetchWtMicro() {
  const html = await fetchText('https://www.wtmec.com/news');
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https:\/\/www\.wtmec\.com\/(\d{6})[^"]*)"[^>]*>([\s\S]{0,220}?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    const ym = m[2];
    const title = stripTags(m[3]);
    if (!title || title.length < 8 || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title,
      summary: '',
      url,
      publishedAt: new Date(`${ym.slice(0, 4)}-${ym.slice(4, 6)}-01T09:00:00+08:00`).toISOString(),
      source: '文晔科技',
      timeApprox: true,
      dateApprox: 'month'
    });
    if (out.length >= 8) break;
  }
  return out;
}

// 6) 大联大新闻 —— 页面无日期，按页序递减近似
async function fetchWPG(nowMs) {
  const html = await fetchText('https://www.wpgholdings.com/news');
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="([^"]*\/news\/detail\/[^"]+)"[^>]*>([\s\S]{0,220}?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    let url = m[1];
    if (!/^https?:/.test(url)) url = 'https://www.wpgholdings.com' + (url.startsWith('/') ? '' : '/') + url;
    const title = stripTags(m[2]);
    if (!title || title.length < 8 || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title,
      summary: '',
      url,
      publishedAt: new Date(nowMs - out.length * 86400000).toISOString(),
      source: '大联大',
      timeApprox: true
    });
    if (out.length >= 8) break;
  }
  return out;
}

// 7) 电子工程专辑 EET China —— 新闻 ID 前 8 位就是日期
async function fetchEET() {
  const html = await fetchText('https://www.eet-china.com/');
  const out = [];
  const seen = new Set();
  const re = /<a[^>]+href="(https:\/\/www\.eet-china\.com\/news\/(\d{8})\d+\.html)"[^>]*>([\s\S]{0,220}?)<\/a>/g;
  let m;
  while ((m = re.exec(html))) {
    const url = m[1];
    const d = m[2];
    const title = stripTags(m[3]);
    if (!title || title.length < 8 || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title,
      summary: '',
      url,
      publishedAt: new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T09:00:00+08:00`).toISOString(),
      source: '电子工程专辑',
      timeApprox: true
    });
    if (out.length >= 15) break;
  }
  return out;
}


/* ---------------- 分类 ---------------- */

function normItem(item) {
  const title = cleanTitle(item.title);
  const text = title + ' ' + (item.summary || '');
  const isBiz = BIZ_RE.test(text);
  const noStock = !STOCK_RE.test(text);
  const hasAgent = AGENT_RE.test(text);
  const hasVendor = VENDOR_RE.test(text);
  const hasChip = CHIP_RE.test(text);

  let tag = 'market';
  let tagLabel = '行业资讯';
  let kind = '';
  // 代理商：标题里出现代理商名本身就是「代理商动态」，不再额外要求业务动词
  if (hasAgent && noStock) { tag = 'agent'; tagLabel = '代理商'; kind = 'distributor'; }
  else if (hasVendor && isBiz && noStock) { tag = 'vendor'; tagLabel = '原厂'; kind = 'vendor'; }
  else if (hasChip) { tag = 'chip'; tagLabel = '芯片产业'; }
  return Object.assign({}, item, { title, tag, tagLabel, kind });
}

// 跨源同一事件：留最早发布那条，其余来源记录在 alsoOn
function dedupeAndMerge(items) {
  const map = new Map();
  items.forEach(raw => {
    if (!raw.title || !raw.url) return;
    const item = normItem(raw);
    const key = titleKey(item.title);
    if (!key) return;
    const prev = map.get(key);
    if (!prev) { map.set(key, item); return; }
    const a = prev.publishedAt || '';
    const b = item.publishedAt || '';
    if (b && (!a || b < a)) {
      map.set(key, Object.assign({}, item, {
        summary: (item.summary || '').length >= (prev.summary || '').length ? item.summary : prev.summary,
        alsoOn: (prev.alsoOn || []).concat([prev.source])
      }));
    } else {
      prev.alsoOn = (prev.alsoOn || []).concat([item.source]);
      if ((item.summary || '').length > (prev.summary || '').length) prev.summary = item.summary;
    }
  });
  return [...map.values()];
}

function sortByTimeDesc(list) {
  return list.slice().sort((x, y) => {
    const a = x.publishedAt || '';
    const b = y.publishedAt || '';
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? 1 : -1;
  });
}

// 两列交替合并（代理商 / 原厂）
function interleave(a, b) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (i < a.length) out.push(a[i]);
    if (i < b.length) out.push(b[i]);
  }
  return out;
}

// 多源轮转：避免单一源占满整个板块
function pickMixed(list, quota, order) {  const buckets = new Map();
  list.forEach(x => {
    const k = x.source;
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(x);
  });
  buckets.forEach(v => sortByTimeDesc(v));
  const keys = (order || [...buckets.keys()]).filter(k => buckets.has(k));
  const out = [];
  let round = 0;
  while (out.length < quota) {
    let added = false;
    for (const k of keys) {
      const b = buckets.get(k);
      if (!b || !b.length) continue;
      out.push(b.shift());
      added = true;
      if (out.length >= quota) break;
    }
    if (!added) break;
    round++;
    if (round > 60) break;
  }
  return out;
}

async function main() {
  const startedAt = new Date();
  const sources = [];
  const pool = [];

  const jobs = [
    ['国际电子商情', fetchEsm],
    ['集微网', () => fetchJiwei(startedAt.getTime())],
    ['电子工程专辑', fetchEET],
    ['东方财富', fetchEastmoney],
    ['华尔街见闻', fetchWallstreetcn],
    ['文晔科技', fetchWtMicro],
    ['大联大', () => fetchWPG(startedAt.getTime())]
  ];

  for (const [name, fn] of jobs) {
    try {
      const rows = await fn();
      sources.push({ name, ok: true, count: rows.length });
      rows.forEach(r => pool.push(Object.assign({ sourceName: name }, r)));
    } catch (e) {
      sources.push({ name, ok: false, count: 0, error: (e && e.message) || String(e) });
    }
  }

  const merged = dedupeAndMerge(pool);

  if (process.env.DEBUG_NEWS) {
    const counts = merged.reduce((a, x) => { a[x.tag] = (a[x.tag] || 0) + 1; return a; }, {});
    console.log('TAGS', JSON.stringify(counts));
    merged.filter(x => AGENT_RE.test(x.title)).slice(0, 10).forEach(x => {
      const t = x.title + ' ' + (x.summary || '');
      console.log('  [AGENT-DBG]', x.tag, x.kind, 'stock=' + STOCK_RE.test(t), 'biz=' + BIZ_RE.test(t), '|', x.title.slice(0, 50));
    });
  }

  // 综合资讯：标题必须与产业链相关（避免只在摘要里提到某家公司就混进来）
  const chipPoolAll = sortByTimeDesc(merged.filter(x =>
    x.tag !== 'agent' && !PERSON_QUOTE_RE.test(x.title) && (CHIP_RE.test(x.title) || x.tag === 'chip')
  )).filter(x => !HARD_STOCK_RE.test(x.title));
  const cut5 = startedAt.getTime() - 5 * 86400000;
  const chipRecent = chipPoolAll.filter(x => x.publishedAt && new Date(x.publishedAt).getTime() >= cut5);
  const chipPool = chipRecent.length >= 6 ? chipRecent : chipPoolAll;
  const chip = sortByTimeDesc(pickMixed(chipPool, 8, ['集微网', '电子工程专辑', '国际电子商情', '东方财富', '华尔街见闻']));

  // 代理商动态：代理商 + 原厂，两类都按来源轮转，避免单一来源刷屏
  const distributorPool = sortByTimeDesc(merged.filter(x => x.kind === 'distributor'));
  const vendorPool = sortByTimeDesc(merged.filter(x => x.kind === 'vendor'));
  const distributors = pickMixed(distributorPool, 5, null);
  const vendors = pickMixed(vendorPool, 6, null);
  // 代理商 / 原厂交替排列：两类都看得见，各自内部仍按时间倒序
  let agent = interleave(distributors, vendors).slice(0, 10);
  // 保底：至少 3 条代理商类（否则原厂快讯会把代理商动态挤没）
  const distInAgent = agent.filter(x => x.kind === 'distributor').length;
  if (distInAgent < 3) {
    const extra = distributorPool.filter(x => agent.indexOf(x) < 0).slice(0, 3 - distInAgent);
    const vendorOnly = agent.filter(x => x.kind !== 'distributor');
    agent = sortByTimeDesc(extra.concat(vendorOnly)).slice(0, 10);
  }

  // 入选条目补摘要（首页没有摘要的，最多 6 条，控制请求量）
  const needSummary = agent.concat(chip).filter(x => x.timeApprox && !x.summary).slice(0, 6);
  for (const it of needSummary) {
    await fillSummary(it);
  }

  const payload = {
    ok: chip.length > 0 || agent.length > 0,
    generatedAt: startedAt.toISOString(),
    generatedAtBeijing: new Date(startedAt.getTime() + 8 * 3600 * 1000).toISOString().replace('Z', '+08:00'),
    sources,
    chip,
    agent
  };

  if (!payload.ok) {
    console.error('全部数据源均未取到内容，保留旧文件');
    fs.writeFileSync(OUT + '.fail.log', JSON.stringify(payload, null, 2), 'utf8');
    process.exit(1);
  }

  fs.writeFileSync(TMP, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(TMP, OUT);
  console.log(`OK  chip=${chip.length} agent=${agent.length} (distributor=${agent.filter(a => a.kind === 'distributor').length})`);
  sources.forEach(s => console.log(`  ${s.ok ? 'OK ' : 'ERR'} ${s.name} ${s.count}${s.error ? ' ' + s.error : ''}`));
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});

