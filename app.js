// 投资助理 - 应用逻辑（无外部依赖，图表用原生 SVG 渲染）
(function () {
  "use strict";
  var S = window.STOCKS, M = window.MKT, K = window.KLINE, MON = window.MONTHS;
  var CAT = window.CAT_META, DEF = window.PORTFOLIO_DEFAULT;
  var US = window.US_STOCKS || [], UM = window.US_MKT || { indices: [], asOfUS: "" };
  var UDEF = window.US_PORTFOLIO_DEFAULT || { steady: 40, growth: 35, rotate: 20, tenx: 5 };

  // ---------- 工具 ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function stripTag(s) { return String(s == null ? "" : s).replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"); }
  function pct(v, d) { return (v == null) ? "—" : v.toFixed(d == null ? 2 : d) + "%"; }
  function num(v, d) { return (v == null) ? "—" : Number(v).toFixed(d == null ? 2 : d); }
  function cls(v) { if (v == null || v === 0) return "c-flat"; return v > 0 ? "c-up" : "c-down"; }
  function byCode(c) { for (var i = 0; i < S.length; i++) if (S[i].code === c) return S[i]; return null; }
  function fmtCode(c) { return c.replace("sh", "").replace("sz", "").replace("hk", "").toUpperCase() + (c.indexOf("hk") === 0 ? ".HK" : ""); }
  function composite(st, w) {
    return (st.moat * w.moat + st.quality * w.quality + st.mgmt * w.mgmt + st.growth * w.growth + st.valuation * w.valuation) / (w.moat + w.quality + w.mgmt + w.growth + w.valuation);
  }
  function grade(v) { return v >= 8 ? "S" : v >= 7 ? "A" : v >= 6 ? "B" : "C"; }
  function opt(v, label, cur) { return '<option value="' + v + '"' + (cur === v ? " selected" : "") + '>' + label + '</option>'; }
  // ================= 老唐估值法（唐朝《价值投资实战手册》）=================
  // 三大前提：①利润为真 ②利润可持续 ③维持当前盈利无需大量资本投入
  // 估值链：基准EPS × 机构一致预期三年倍数 k3y → 三年后EPS
  //        × 合理PE（= 无风险收益率倒数，区间 15~33 倍，按质地与增速打折）→ 三年后合理估值
  // 无风险收益率 = 美债十年期（MKT.rfUS，refresh-data.js 每日自动刷新；此前误用固定 3.5%）
  // 理想买点 = 三年后合理估值 × 50%（三年一倍 ≈ 年化 26%）；确定性不足降至 45% / 40%
  // 卖出参考 = min(三年后合理估值 × 150%, 基准EPS × 50 倍)，二者孰低
  // 增速放缓的处理（本框架的核心）：不是简单“多打几折”，而是两处同时收紧——
  //   ① 三年后 EPS 用机构一致预期并按 75% 逐年衰减外推，不从历史高增长线性外推（避免泡泡玛特式虚高）
  //   ② 合理 PE 随三年年化增速「相对基准」下调封顶：≥15% 给基准×1.05，8~15% ×0.95，3~8% ×0.87，
  //      0~3% ×0.77，负增长 ×0.70；增速越低，市场愿意给的倍数越低，买点自然更低
  //      （2026-10-10 前为绝对封顶 30/27/25/22/20 倍——那是 rf≈3.5% 时代的产物，rf 升高后会失去区分度）
  var LT_F = window.LT_FORECAST || {};
  var LT_CFG = { rf: (M && M.rfUS && M.rfUS.v > 0) ? M.rfUS.v : 3.5, buyX: 0.50, sellX: 1.5, sellPe: 50 };
  var LT_LEVERAGE = ["银行", "保险"];                      // 高杠杆：老唐打七折，且列为能力圈外
  var LT_HEAVY = ["晶圆代工", "光伏/储能", "电信运营商"];   // 维持当前盈利需持续大额资本开支：打八折
  var LT_CYCLICAL = ["有色/黄金铜", "黄金珠宝"];            // 周期股：峰值盈利不可外推：打八折
  var VAL_MODE = "band";                                   // band = 合理PE带法（默认）；lt = 老唐估值法（页面可切换）
  var VAL_MODE_TXT = { lt: "老唐估值法", band: "合理PE带法" };

  // 基准 EPS（与股价同币种）：人工校准 > A股机构年度一致预期 > 前瞻PE > 静态PE
  function ltBaseEps(st) {
    if (st.epsBase) return { v: st.epsBase, src: (st.epsBaseNote || "校准EPS") };
    var f = LT_F[st.code];
    if (f && f.lv === 1 && f.e26 > 0 && st.mkt === "A") return { v: f.e26, src: "机构 2026E 一致预期EPS（" + f.nOrg + "家）" };
    if (st.peF && st.peF > 0) return { v: st.px / st.peF, src: "前瞻EPS" };
    if (st.pe && st.pe > 0) return { v: st.px / st.pe, src: "静态EPS" };
    return null;
  }
  // 三大前提体检：任一不满足即「看不懂，不做」
  function ltPremise(st) {
    var f = [];
    if (LT_LEVERAGE.indexOf(st.industry) >= 0) f.push("高杠杆（" + st.industry + "）：扩张需持续补充资本金，老唐列为能力圈外");
    if (st.moat < 6.5) f.push("护城河 " + st.moat + " < 6.5：利润可持续存疑");
    if (st.quality < 6.5) f.push("盈利质量 " + st.quality + " < 6.5：利润未必为真");
    return f;
  }
  function ltValue(st) {
    var b = ltBaseEps(st);
    if (!b || !(b.v > 0)) return null;
    var f = LT_F[st.code];
    if (!f || !(f.k3y > 0)) return null;
    var k = f.k3y, kNote = f.note;
    // 业绩显著下滑中（最新报告期归母净利同比 < -20%），机构一致预期多建立在「明年复苏」假设上。
    // 老唐要求「宁可低估」，此时不采信高增长外推，三年倍数封顶 1.0（即只认当前盈利水平）。
    if (st.npg != null && st.npg < -20 && k > 1) {
      k = 1;
      kNote += "；最新报告期净利 " + pct(st.npg, 1) + "，机构复苏预期不予采信，三年倍数封顶 1.0";
    }
    var eps3y = b.v * k;
    var g3y = Math.pow(k, 1 / 3) - 1;                  // 隐含三年年化增速
    var base = Math.max(15, Math.min(33, 100 / LT_CFG.rf)); // 无风险收益率（美债10Y）倒数；区间放宽为 15~33 倍（旧 25 下限是 rf≈3.5% 时代的产物，美债 >6% 时才触新下限）
    var d = 1, tags = [];
    if (LT_LEVERAGE.indexOf(st.industry) >= 0) { d *= 0.7; tags.push("高杠杆×0.7"); }
    if (LT_HEAVY.indexOf(st.industry) >= 0) { d *= 0.8; tags.push("重资本开支×0.8"); }
    if (LT_CYCLICAL.indexOf(st.industry) >= 0) { d *= 0.8; tags.push("周期股×0.8"); }
    if (st.quality < 7) { d *= 0.85; tags.push("利润含金量一般×0.85"); }
    // 增速封顶改为「相对基准」：高增长最多上浮 5%，增速越低封顶越低（负增长只给基准七成）。
    // 旧的绝对封顶 30/27/25/22/20 在 rf=5.24%（基准 19.1 倍）下会全面失效——所有增速档都拿同一个 PE，失去区分度。
    var capR = g3y >= 0.15 ? 1.05 : g3y >= 0.08 ? 0.95 : g3y >= 0.03 ? 0.87 : g3y >= 0 ? 0.77 : 0.70;
    var cap = base * capR;
    var pe = Math.min(base * d, cap);
    if (!(pe > 0)) pe = 20;
    var fair3y = eps3y * pe;
    var bx = LT_CFG.buyX;
    if (g3y < 0) bx = 0.40;                                 // 盈利下滑：要更高安全边际
    else if (g3y < 0.03 || LT_CYCLICAL.indexOf(st.industry) >= 0 || st.moat < 7) bx = 0.45;
    return {
      base: b.v, baseSrc: b.src, k: k, lv: f.lv, note: kNote, nOrg: f.nOrg, target: f.target,
      eps3y: eps3y, g3y: g3y, peBase: base, disc: d, discTags: tags, capR: capR, peCap: cap, pe: pe,
      fair3y: fair3y, buyX: bx, buy: fair3y * bx, sell: Math.min(fair3y * LT_CFG.sellX, b.v * LT_CFG.sellPe),
      premise: ltPremise(st)
    };
  }
  function ltLvTxt(lv) { return lv === 1 ? "机构年度一致预期" : lv === 2 ? "机构季度一致预期外推" : "模型保守假设"; }

  // 目标价区间：前瞻EPS × 合理PE带；无前瞻PE时用 PB 带回推每股净资产
  function targetRange(st, peLo, peHi) {
    if (VAL_MODE === "lt") {
      var L = ltValue(st);
      // 老唐法算不出来（无正 EPS 基准 / 无机构预期）即「看不懂，不做」，不回退到 PE 带法
      if (!L) return null;
      return {
        type: "LT", lt: L, buyOverride: L.buy,
        lo: L.buy, mid: L.fair3y, hi: L.sell,
        base: "老唐法：" + L.baseSrc + " " + num(L.base, 2) + " × 三年预期倍数 " + num(L.k, 3) +
              " → 三年后EPS " + num(L.eps3y, 2) + " × 合理PE " + num(L.pe, 1) + "倍 = 三年后合理估值 " + num(L.fair3y, 2)
      };
    }
    if (st.peF && peLo) {
      var eps = st.px / st.peF;
      return { type: "PE", lo: eps * peLo, mid: eps * (peLo + peHi) / 2, hi: eps * peHi, base: "前瞻EPS " + num(eps, 2) + " × 合理PE " + peLo + "~" + peHi + "倍（模型假设）" };
    }
    if (st.fairPB) {
      var bvps = st.px / st.pb;
      return { type: "PB", lo: bvps * st.fairPB[0], mid: bvps * (st.fairPB[0] + st.fairPB[1]) / 2, hi: bvps * st.fairPB[1], base: "每股净资产 " + num(bvps, 2) + " × 合理PB " + st.fairPB[0] + "~" + st.fairPB[1] + "倍（模型假设）" };
    }
    // 盈利基准校准：用于「TTM 盈利含高基数/周期峰值」的标的（如泡泡玛特 2025 净利+303% 后增速骤降、
    // 老铺黄金金价峰值盈利）。此时 px/pe 反推的 TTM EPS 不可靠，改由人工校准的常态/年化 EPS 算买点。
    if (st.epsBase && peLo) {
      var epsC = st.epsBase;
      return { type: "PE", lo: epsC * peLo, mid: epsC * (peLo + peHi) / 2, hi: epsC * peHi, base: (st.epsBaseNote || "校准EPS") + " " + num(epsC, 2) + " × 合理PE " + peLo + "~" + peHi + "倍（已剔除高基数）" };
    }
    if (st.pe && peLo) {
      var eps2 = st.px / st.pe;
      return { type: "PE", lo: eps2 * peLo, mid: eps2 * (peLo + peHi) / 2, hi: eps2 * peHi, base: "静态EPS " + num(eps2, 2) + " × 合理PE " + peLo + "~" + peHi + "倍（模型假设）" };
    }
    return null;
  }

  // ---------- 标签页 ----------
  // 2026-10-10 合并：市场雷达 / 好公司筛选 / 每日推荐 / 投资组合 四页并成一个「🧺 A股港股」页（版式同「美股组合」）
  var tabs = ["plan", "divcmp", "fund", "ah", "us", "backtest", "report", "history", "detail"];
  // 旧页面名兼容映射（页面内旧链接、历史书签与测试脚本仍可用）
  var TAB_ALIAS = { radar: "ah", screen: "ah", pick: "ah", portfolio: "ah" };
  var curTab = "plan";
  function showTab(t) {
    t = TAB_ALIAS[t] || t;
    curTab = t;
    for (var i = 0; i < tabs.length; i++) {
      $("tab-" + tabs[i]).style.display = (tabs[i] === t) ? "" : "none";
      var nav = $("nav-" + tabs[i]);
      if (nav) nav.className = (nav.id === "nav-detail") ? "nav-btn active" : (tabs[i] === t ? "nav-btn active" : "nav-btn");
    }
    $("nav-detail").style.display = (t === "detail") ? "" : "none";
    if (t === "plan") renderPlan();
    if (t === "divcmp") renderDivCmp();
    if (t === "fund") renderFund();
    if (t === "ah") renderAH();
    if (t === "us") renderUS();
    if (t === "backtest") renderBacktest();
    if (t === "report") buildReport();
    if (t === "history") renderHistory();
    // 移动端底部 tab 栏可横向滚动：把当前项滚到可见位置
    var nb = $("nav-" + t);
    if (nb && nb.scrollIntoView) { try { nb.scrollIntoView({ block: "nearest", inline: "center" }); } catch (e) { } }
  }
  window.showTab = showTab;
  var curDetail = null;
  function openDetail(code) {
    curDetail = code;
    showTab("detail");
    renderDetail();
  }
  window.openDetail = openDetail;

  // ---------- 全球指数（恒生科技 / 纳斯达克 / 标普 等） ----------
  function renderGlobalIndices() {
    if (!UM.indices || !UM.indices.length) return "";
    var h = '<div class="card"><b>全球指数</b> <span class="muted small">（' +
      (LIVE.on ? "实时行情" : "收盘快照") + ' · 各市场交易时段不同，时点见每格下方）</span><div class="grid3 ixgrid">';
    for (var i = 0; i < UM.indices.length; i++) {
      var ix = UM.indices[i];
      var p52 = (ix.hi52 && ix.lo52 && ix.hi52 > ix.lo52) ? Math.round((ix.close - ix.lo52) / (ix.hi52 - ix.lo52) * 100) : null;
      var hot = (ix.short === "HSTECH" || ix.short === "IXIC" || ix.short === "NDX");
      h += '<div class="ixbox' + (hot ? " ixhot" : "") + '"><div class="ixname">' + esc(ix.name) +
        '<span class="region">' + esc(ix.region) + '</span></div>' +
        '<div class="ixpx">' + num(ix.close, 2) + '</div>' +
        '<div class="' + cls(ix.chg) + '">' + (ix.chg > 0 ? "+" : "") + pct(ix.chg) +
        ' <span class="muted small">' + (ix.chgAmt > 0 ? "+" : "") + num(ix.chgAmt, 2) + '</span></div>' +
        '<div class="muted small">52周 ' + num(ix.lo52, 0) + ' ~ ' + num(ix.hi52, 0) +
        (p52 != null ? ' · 位置 ' + p52 + '%' : '') + '</div>' +
        '<div class="muted small">' + esc(ix.asOf || "") + '</div></div>';
    }
    h += '</div><div class="muted small" style="margin-top:6px">恒生科技（HSTECH）反映中国香港上市科技龙头表现，纳斯达克（IXIC/NDX）为全球科技与成长股风向标；' +
      '二者与 A 股相关性较低，可用于观察海外风险偏好与科技产业周期。</div></div>';
    return h;
  }

  // ---------- 市场雷达（已并入「🧺 A股港股」页，作为首屏板块） ----------
  function radarHTML() {
    var h = "";
    h += '<div class="sectitle"><b>市场雷达 · A股三大指数</b> <span class="muted small">' + mktAsOf("A") + '</span></div>';
    h += '<div class="grid3">';
    for (var i = 0; i < M.indices.length; i++) {
      var ix = M.indices[i];
      h += '<div class="card center"><div class="muted">' + ix.name + '</div><div class="big">' + num(ix.close, 2) + '</div><div class="' + cls(ix.chg) + '">' + (ix.chg > 0 ? "+" : "") + pct(ix.chg) + '</div>' +
        '<div class="muted small">60日 ' + pct(ix.chg60d) + ' · 250日 ' + pct(ix.chg250d) + ' · 52周 ' + num(ix.lo52, 0) + '~' + num(ix.hi52, 0) + '</div></div>';
    }
    h += '</div>';
    h += renderGlobalIndices();
    h += '<div class="card"><b>市场画像</b> <span class="muted small">（来源：腾讯自选股 · ' + mktAsOf("A") + '）</span><div class="grid2 tags">';
    for (var j = 0; j < M.profile.length; j++) {
      var p = M.profile[j];
      var tone = p.good === true ? "tag-ok" : p.good === false ? "tag-warn" : "tag-flat";
      h += '<div class="' + tone + '"><b>' + p.k + '</b>：' + p.v + '</div>';
    }
    h += '</div><div class="muted small" style="margin-top:8px">全指估值 PE-TTM ' + M.valuation.peTTM + '（10年分位 ' + M.valuation.pePct10y + '%，5年分位 ' + M.valuation.pePct5y + '%）· PB ' + M.valuation.pb + ' · 股息 ' + M.valuation.divTTM + '%（' + M.valuation.date + '）· 两市成交 ' + M.turnoverYi + ' 亿（10日均值的 ' + M.turnoverVs10dPct + '%）· 涨 ' + M.updown.up + ' 家 / 跌 ' + M.updown.down + ' 家 / 涨停 ' + M.updown.limitUp + ' 家</div></div>';
    h += '<div class="card verdict"><b>今日研判：</b>短期缩量调整、情绪偏热但技术走弱，估值处偏高区间；风格上<b>价值明显占优</b>（60日价值 +5.0% vs 成长 -10.0%）。策略上建议：以稳增长高股息为底仓，高增长逢回调分批，热点轮动小仓位跟踪主线，十倍空间类严格限制仓位并等待安全边际。</div>';
    return h;
  }

  // ---------- 好公司筛选（巴菲特评分） ----------
  // 巴菲特·芒格式五维评分（默认权重向「护城河 / 利润为真 / 低价格」倾斜：三者合计 78%）
  // 管理层与成长性降到 22%：好生意 + 真利润 + 好价格才是长期复利的核心，成长性只作加分项
  var W = { moat: 30, quality: 30, mgmt: 10, growth: 12, valuation: 18 };
  var valFilter = "all", sortBy = "score";
  window._setVF = function (v) { valFilter = v; renderScreenBlock(); };
  window._setSort = function (v) { sortBy = v; renderScreenBlock(); };
  // 只重刷筛选板块（不整页重渲染，避免拖动滑块时打断交互）
  function renderScreenBlock() { var el = $("screen-body"); if (el) el.innerHTML = screenHTML(); }
  function valScore(st) {  // 综合估值分位（低=便宜）
    var o = curVal(st);
    if (!o) return null;
    return o.mix != null ? o.mix : (o.pePct != null ? o.pePct : o.pbPct);
  }
  function screenHTML() {
    var h = "";
    h += changeCard("pool");
    h += '<div class="card note"><b>更新频率</b>：价格 / 涨跌 / PE / 估值分位 —— <b>每个交易日</b>随行情自动刷新（18:00 归档快照 + 打开页面实时行情）；基本面（财报增速 / 机构一致预期 / 护城河与五维评分 / 筛选池成员）—— <b>每月 1 日全面复核一次</b>。池子或名单有移入 / 移出时，上方「名单变动」会给出原因。</div>';
    h += '<div class="card">';
    h += '<b>巴菲特·芒格式五维评分</b> <span class="muted small">拖动滑块调整权重（满分10分）</span>';
    var dims = [["moat", "护城河"], ["quality", "盈利质量"], ["mgmt", "管理层"], ["growth", "成长性"], ["valuation", "估值安全"]];
    h += '<div class="grid5 sliders">';
    for (var i = 0; i < dims.length; i++) {
      var k = dims[i][0], label = dims[i][1];
      h += '<div><label>' + label + ' <b id="wv-' + k + '">' + W[k] + '%</b></label>' +
        '<input type="range" min="0" max="40" step="5" value="' + W[k] + '" oninput="window._setW(\'' + k + '\', this.value)"></div>';
    }
    h += '</div></div>';
    h += '<div class="card"><div class="vfilter"><b>好公司清单</b>' +
      '<div class="vf-right"><label class="muted small">估值筛选</label>' +
      '<select onchange="window._setVF(this.value)">' +
      opt("all", "全部", valFilter) + opt("low", "仅低估（分位≤30%）", valFilter) +
      opt("mid", "合理区（30%~60%）", valFilter) + opt("high", "仅高估（>70%）", valFilter) + '</select>' +
      '<label class="muted small" style="margin-left:8px">排序</label>' +
      '<select onchange="window._setSort(this.value)">' +
      opt("score", "按综合分", sortBy) + opt("val", "按估值分位（便宜优先）", sortBy) + '</select></div></div>';
    h += '<table class="tbl"><thead><tr>' +
      '<th>公司</th><th>行业</th><th>现价</th><th>涨跌</th><th>PE(静/前)</th><th>估值分位</th><th>PB</th><th>股息</th><th>年内</th><th>ROE(TTM)</th><th>综合分</th><th>评级</th><th>财报</th><th></th></tr></thead><tbody>';
    var rows = S.slice();
    if (valFilter !== "all") {
      rows = rows.filter(function (st) {
        var p = valScore(st);
        if (p == null) return false;
        if (valFilter === "low") return p <= 30;
        if (valFilter === "mid") return p > 30 && p <= 60;
        if (valFilter === "high") return p > 70;
        return true;
      });
    }
    rows.sort(function (a, b) {
      if (sortBy === "val") {
        var pa = valScore(a), pbv = valScore(b);
        if (pa == null) return 1;
        if (pbv == null) return -1;
        return pa - pbv;
      }
      return composite(b, W) - composite(a, W);
    });
    if (!rows.length) {
      h += '<tr><td colspan="14" class="muted">当前筛选条件下没有标的，请放宽估值筛选范围。</td></tr>';
    }
    for (var r = 0; r < rows.length; r++) {
      var st = rows[r];
      var vs = valScore(st);
      var vt = valTag(vs);
      var cv = curVal(st);
      h += '<tr onclick="openDetail(\'' + st.code + '\')" class="rowlink">' +
        '<td><b>' + esc(st.name) + '</b><span class="muted small"> ' + fmtCode(st.code) + '</span></td>' +
        '<td>' + st.industry + '</td>' +
        '<td>' + num(st.px, 2) + '</td>' +
        '<td class="' + cls(st.chg) + '">' + (st.chg > 0 ? "+" : "") + pct(st.chg) + '</td>' +
        '<td>' + num(st.pe, 1) + ' / ' + num(st.peF, 1) + '</td>' +
        '<td><span class="vchip ' + vt.c + '">' + (vs == null ? "—" : pct(vs, 0)) + '</span><div class="muted small">' + vt.t +
        (cv && cv.pe != null ? ' · PE ' + num(cv.pe, 1) + '倍' : '') + '</div></td>' +
        '<td>' + num(st.pb, 2) + '</td>' +
        '<td>' + pct(st.div, 1) + '</td>' +
        '<td class="' + cls(st.ytd) + '">' + (st.ytd > 0 ? "+" : "") + pct(st.ytd) + '</td>' +
        '<td>' + (st.roe == null ? "—" : pct(st.roe, 1)) + '</td>' +
        '<td><b>' + num(composite(st, W), 2) + '</b></td>' +
        '<td><span class="badge g' + grade(composite(st, W)) + '">' + grade(composite(st, W)) + '</span></td>' +
        '<td class="small">' + repLabel(st.code) + '</td>' +
        '<td><a href="javascript:void(0)" onclick="event.stopPropagation();openDetail(\'' + st.code + '\')">调研 →</a></td></tr>';
    }
    h += '</tbody></table>';
    h += '<div class="muted small" style="margin-top:8px">评级：S≥8（好生意+好价格）· A≥7 · B≥6 · C&lt;6。ROE/毛利率等基本面为 2026H1 报告期，"—"表示数据源未覆盖；五维分为模型评估，仅供参考。</div>';
    h += '<div class="muted small" style="margin-top:4px"><b>估值分位</b>＝当前 PE/PB/股息率在近 4 年逐月估值序列中的位置（PE、PB 分位越低越便宜，股息率分位越高越便宜，合成后为综合分位）；颜色由冷到暖表示由便宜到贵。</div></div>';
    return h;
  }
  window._setW = function (k, v) { W[k] = Number(v); var el = $("wv-" + k); if (el) el.textContent = v + "%"; renderScreenBlock(); };

  // ---------- 历史估值百分位（判断当前价格是否便宜） ----------
  var VAL = window.VAL || {};
  function valOf(c) { return VAL[c] || null; }
  // 序列中 <= v 的比例（百分位）
  function rankOf(hist, v) {
    if (!hist || !hist.length || v == null) return null;
    var le = 0;
    for (var i = 0; i < hist.length; i++) if (hist[i][1] <= v) le++;
    return le / hist.length * 100;
  }
  // 当前估值：以快照 PE/PB/股息率为锚，随实时价等比联动
  function curVal(st) {
    var v = valOf(st.code);
    if (!v || !v.px0) return null;
    var f = st.px / v.px0;
    var o = { v: v, f: f, pe: null, pePct: null, pb: null, pbPct: null, dy: null, dyPct: null, pxPct: null, mix: null };
    if (v.pe0) { o.pe = v.pe0 * f; o.pePct = rankOf(v.pe, o.pe); }
    if (v.pb0) { o.pb = v.pb0 * f; o.pbPct = rankOf(v.pb, o.pb); }
    if (v.dy && v.div0 != null) { o.dy = v.div0 / f; o.dyPct = rankOf(v.dy, o.dy); }
    o.pxPct = rankOf(v.px, st.px);
    var parts = [];
    if (o.pePct != null) parts.push(o.pePct);
    if (o.pbPct != null) parts.push(o.pbPct);
    if (o.dyPct != null) parts.push(100 - o.dyPct);   // 股息率分位越高越便宜 → 取反统一方向
    o.mix = parts.length ? parts.reduce(function (a, b) { return a + b; }, 0) / parts.length : null;
    return o;
  }
  // 估值分位 → 文字与温度色（低分位=便宜=冷色，高分位=贵=暖色）
  function valTag(p) {
    if (p == null) return { t: "无数据", c: "v-na" };
    if (p <= 20) return { t: "显著低估", c: "v1" };
    if (p <= 40) return { t: "偏低估", c: "v2" };
    if (p <= 60) return { t: "中位区", c: "v3" };
    if (p <= 80) return { t: "偏高", c: "v4" };
    return { t: "显著高估", c: "v5" };
  }
  function pctBar(p) {
    if (p == null) return '<div class="vbar muted small">—</div>';
    var pos = Math.max(0, Math.min(100, p));
    return '<div class="vbar"><div class="vbar-track">' +
      '<div class="vbar-band"></div>' +
      '<div class="vbar-tick" style="left:25%"></div><div class="vbar-tick" style="left:50%"></div><div class="vbar-tick" style="left:75%"></div>' +
      '<div class="vbar-mark" style="left:' + pos.toFixed(1) + '%"></div>' +
      '</div><div class="vbar-scale"><span>0% 最便宜</span><span>50%</span><span>100% 最贵</span></div></div>';
  }
  // 三档参考价：历史 P25 / 中位 / P75 估值 × 每股指标（锚定口径）
  function valPrices(o) {
    var v = o.v, out = [];
    if (v.peStats && v.pe0) {
      var eps = v.px0 / v.pe0;
      out.push({ k: "PE", stat: v.peStats, cur: o.pe, lo: v.peStats.p25 * eps, mid: v.peStats.med * eps, hi: v.peStats.p75 * eps });
    }
    if (v.pbStats && v.pb0) {
      var bvps = v.px0 / v.pb0;
      out.push({ k: "PB", stat: v.pbStats, cur: o.pb, lo: v.pbStats.p25 * bvps, mid: v.pbStats.med * bvps, hi: v.pbStats.p75 * bvps });
    }
    return out;
  }
  function vBlock(title, p, cur, stats, unit, invert) {
    var t = valTag(invert ? (p == null ? null : 100 - p) : p);
    var tip = invert ? "（股息率分位越高越便宜）" : "（分位越低越便宜）";
    var h = '<div class="vblock ' + t.c + '">';
    h += '<div class="muted small">' + title + ' <span class="vq" title="' + tip + '">?</span></div>';
    h += '<div class="vbig">' + (p == null ? "—" : pct(p, 0)) + '</div>';
    h += '<div class="vtag">' + t.t + '</div>';
    h += '<div class="muted small">当前 ' + (cur == null ? "—" : num(cur, 2) + unit) +
      (stats ? ' · 历史 ' + num(stats.min, 1) + '~' + num(stats.max, 1) + unit + '（中位 ' + num(stats.med, 1) + '）' : '') + '</div>';
    h += pctBar(invert ? (p == null ? null : 100 - p) : p);
    h += '</div>';
    return h;
  }
  // 历史估值走势图：P25~P75 带 + 中位线 + 历史折线 + 当前水平线
  function drawValChart(elId, hist, stats, cur, unit) {
    var el = $(elId);
    if (!el) return;
    if (!hist || !hist.length || cur == null) { el.innerHTML = '<div class="muted small">—</div>'; return; }
    var Wd = 640, Ht = 210, padL = 44, padR = 14, padT = 12, padB = 24;
    var vals = [];
    for (var i = 0; i < hist.length; i++) vals.push(hist[i][1]);
    var min = Math.min.apply(null, vals.concat([cur]));
    var max = Math.max.apply(null, vals.concat([cur]));
    var pad = (max - min) * 0.08 || 1; min -= pad; max += pad;
    function X(i) { return padL + (Wd - padL - padR) * i / (hist.length - 1); }
    function Y(v) { return padT + (Ht - padT - padB) * (1 - (v - min) / (max - min)); }
    var svg = '<svg viewBox="0 0 ' + Wd + ' ' + Ht + '" width="100%">';
    // P25~P75 舒适带
    if (stats) {
      var y1 = Y(stats.p75), y2 = Y(stats.p25);
      svg += '<rect x="' + padL + '" y="' + Math.min(y1, y2).toFixed(1) + '" width="' + (Wd - padL - padR) +
        '" height="' + Math.abs(y2 - y1).toFixed(1) + '" fill="rgba(37,99,235,0.07)"/>';
      svg += '<line x1="' + padL + '" y1="' + Y(stats.med).toFixed(1) + '" x2="' + (Wd - padR) + '" y2="' + Y(stats.med).toFixed(1) +
        '" stroke="#94a3b8" stroke-width="1" stroke-dasharray="6 4"/>';
      svg += '<text x="' + (padL + 4) + '" y="' + (Y(stats.med) - 4).toFixed(1) + '" font-size="10" fill="#64748b">中位 ' + num(stats.med, 1) + unit + '</text>';
    }
    for (var g = 0; g <= 3; g++) {
      var gy = padT + (Ht - padT - padB) * g / 3, gv = max - (max - min) * g / 3;
      svg += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (Wd - padR) + '" y2="' + gy.toFixed(1) + '" stroke="#eef2f7"/>';
      svg += '<text x="' + (padL - 5) + '" y="' + (gy + 4).toFixed(1) + '" text-anchor="end" font-size="10" fill="#8a93a3">' + gv.toFixed(1) + '</text>';
    }
    var pts = "";
    for (var i2 = 0; i2 < hist.length; i2++) pts += X(i2).toFixed(1) + "," + Y(hist[i2][1]).toFixed(1) + " ";
    svg += '<polyline points="' + pts + '" fill="none" stroke="#2563eb" stroke-width="2"/>';
    // 当前估值水平线
    svg += '<line x1="' + padL + '" y1="' + Y(cur).toFixed(1) + '" x2="' + (Wd - padR) + '" y2="' + Y(cur).toFixed(1) +
      '" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 3"/>';
    svg += '<text x="' + (Wd - padR - 4) + '" y="' + (Y(cur) - 5).toFixed(1) + '" text-anchor="end" font-size="11" font-weight="bold" fill="#dc2626">当前 ' + num(cur, 2) + unit + '</text>';
    for (var t = 0; t < hist.length; t += 6) {
      svg += '<text x="' + X(t).toFixed(1) + '" y="' + (Ht - 7) + '" text-anchor="middle" font-size="10" fill="#8a93a3">' + hist[t][0] + '</text>';
    }
    svg += '</svg>';
    el.innerHTML = svg;
  }
  // 详情页：历史估值百分位卡片
  function valCard(st) {
    var o = curVal(st);
    if (!o) return '<div class="card"><h3>历史估值百分位</h3><div class="muted small">该标的暂无历史估值序列（数据源未覆盖）。补齐财报历史与月K 后运行 <code>node fetch-finance.js &amp;&amp; node fetch-kline.js &amp;&amp; node calc-valuation.js</code> 即可生成。</div></div>';
    var v = o.v;
    // 样本长度提示：不足 3 年的序列（次新股）分位参考价值有限，必须显式说明，避免与 4 年样本混淆
    var nMon = v.px ? v.px.length : 0;
    var shortNote = nMon < 36 ? '<div class="muted small" style="margin-bottom:8px;color:#b45309">⚠ 样本偏短：该标的仅 ' + nMon + ' 个月历史（' + v.from + ' ~ ' + v.to + '），不足 3 年，分位受上市初期高估值影响较大，<b>仅供参考，不宜与 4 年样本的标的直接横向比较</b>。</div>' : "";
    var h = '<div class="card"><h3>历史估值百分位 <span class="muted small">' + v.from + ' ~ ' + v.to + '（' + nMon + ' 个月）</span></h3>';
    h += '<div class="muted small" style="margin-bottom:10px">口径：以当前 PE/PB 为锚，结合真实财报（滚动 EPS、每股净资产）与不复权月K 回推逐月估值，再用当前值校准；实时价变动时百分位同步重算。' + esc(v.note || "") + '</div>';
    h += shortNote;
    h += '<div class="grid3 vcards">';
    h += vBlock("PE(TTM) 分位", o.pePct, o.pe, v.peStats, "倍", false);
    h += vBlock("PB 分位", o.pbPct, o.pb, v.pbStats, "倍", false);
    h += vBlock("股息率 分位", o.dyPct, o.dy, v.dyStats, "%", true);
    h += '</div>';
    // 走势图
    if (v.pe && o.pe != null) {
      h += '<div style="margin-top:10px"><div class="muted small"><b>PE(TTM) 历史走势与当前位置</b>（蓝色带 = 历史 P25~P75 区间）</div><div id="val-chart"></div></div>';
    }
    // 三档参考价
    var pr = valPrices(o);
    if (pr.length) {
      h += '<div class="muted small" style="margin-top:10px"><b>按历史估值分位反推的参考价格</b></div>';
      h += '<table class="tbl"><thead><tr><th>口径</th><th>低估买入价（历史P25）</th><th>合理中枢价（历史中位）</th><th>高估警戒价（历史P75）</th><th>当前价</th></tr></thead><tbody>';
      for (var i = 0; i < pr.length; i++) {
        var p = pr[i];
        var hitLo = st.px <= p.lo, hitHi = st.px >= p.hi;
        h += '<tr><td><b>' + p.k + '</b> <span class="muted small">当前 ' + num(p.cur, 2) + ' 倍</span></td>' +
          '<td><b>' + num(p.lo, 2) + '</b>' + (hitLo ? ' <span class="badge gS">已到</span>' : '') + '</td>' +
          '<td>' + num(p.mid, 2) + '</td>' +
          '<td>' + num(p.hi, 2) + (hitHi ? ' <span class="badge gC">已超</span>' : '') + '</td>' +
          '<td><b>' + num(st.px, 2) + '</b></td></tr>';
      }
      h += '</tbody></table>';
    }
    // 结论
    var main = o.pePct != null ? o.pePct : (o.pbPct != null ? o.pbPct : null);
    var mainName = o.pePct != null ? "PE" : (o.pbPct != null ? "PB" : null);
    if (main != null) {
      var pr0 = pr[0];
      var verdict = "";
      if (pr0) {
        if (st.px <= pr0.lo) verdict = "当前价已跌破历史 P25 估值对应的价格（" + num(pr0.lo, 2) + "），从估值角度属于<b>历史低估区</b>，具备分批建仓的估值条件（仍需结合基本面与安全边际）。";
        else if (st.px <= pr0.mid) verdict = "当前价处于历史 P25 与中位估值之间（" + num(pr0.lo, 2) + " ~ " + num(pr0.mid, 2) + "），估值<b>合理偏低</b>，可小仓位介入或逢回调加仓。";
        else if (st.px <= pr0.hi) verdict = "当前价处于历史中位与 P75 之间（" + num(pr0.mid, 2) + " ~ " + num(pr0.hi, 2) + "），估值<b>偏贵</b>，追高性价比一般，建议等待回调。";
        else verdict = "当前价已超过历史 P75 估值对应价格（" + num(pr0.hi, 2) + "），处于<b>历史高估区</b>，不建议在此位置追高，等待回归中位区间更稳妥。";
      }
      h += '<div class="card verdict" style="margin-top:10px"><b>估值判断（' + mainName + ' 分位 ' + pct(main, 0) + '）：</b>' + verdict +
        '<div class="muted small" style="margin-top:6px">价格分位 ' + (o.pxPct == null ? "—" : pct(o.pxPct, 0)) + '（现价在近 ' + nMon + ' 个月收盘价中的位置）· 综合估值分位 ' + (o.mix == null ? "—" : pct(o.mix, 0)) + '（PE/PB/股息率合成）</div></div>';
    } else if (o.pxPct != null) {
      // 有价格序列但估值序列不足（如上市不足 1 年、或财报口径缺失）：退而用价格分位给出定位
      h += '<div class="card verdict" style="margin-top:10px"><b>估值判断：历史估值序列不足，暂无法给出 PE/PB 分位。</b>' +
        '已按<b>价格分位 ' + pct(o.pxPct, 0) + '</b>给出定位（现价在近 ' + nMon + ' 个月收盘价中的位置）：' +
        (o.pxPct <= 30 ? '处于近 ' + nMon + ' 个月的<b>偏低区域</b>。' : (o.pxPct >= 70 ? '处于近 ' + nMon + ' 个月的<b>偏高区域</b>，追高需谨慎。' : '处于近 ' + nMon + ' 个月的<b>中位区域</b>。')) +
        '<div class="muted small" style="margin-top:6px">价格分位只反映股价自身的相对位置，不含盈利与净资产变化，判断力弱于 PE/PB 分位，请结合基本面与老唐法买点综合判断。</div></div>';
    }
    h += '</div>';
    return h;
  }

  // ---------- 标的调研 ----------
  // 老唐估值法卡片：完整展示「基准EPS → 三年后EPS → 三年后合理估值 → 理想买点 → 卖出参考」链条
  function ltCard(st, L) {
    var dist = (st.px / L.buy - 1) * 100;
    var h = '<div class="card"><h3>老唐估值法 · 三年后估值与理想买点<span class="muted small">' +
      (VAL_MODE === "lt" ? '（当前生效）' : '（当前默认用PE带法，此处为对照）') + '</span></h3>';
    h += '<div class="vfilter"><span class="muted small">估值法：' +
      '<select onchange="window._setValMode(this.value)">' + opt("lt", "老唐估值法", VAL_MODE) + opt("band", "合理PE带法（默认）", VAL_MODE) + '</select></span>' +
      '<span class="vf-right muted small">无风险收益率（美债10Y ' + (M.rfUS && M.rfUS.asOf ? '· ' + M.rfUS.asOf : '') + '）<b>' + num(LT_CFG.rf, 1) + '%</b> → 合理PE基准 ' + num(L.peBase, 1) + ' 倍' +
      '<input type="range" min="15" max="65" step="1" value="' + Math.round(LT_CFG.rf * 10) + '" style="width:110px;vertical-align:middle;margin-left:6px" oninput="window._setRf(this.value)"></span></div>';
    h += '<div class="grid2 kv">';
    h += kvRow("① 基准 EPS", num(L.base, 2) + ' <span class="muted small">' + esc(L.baseSrc) + '</span>');
    h += kvRow("② 三年预期倍数", "× " + num(L.k, 3) + ' <span class="muted small">' + ltLvTxt(L.lv) + (L.nOrg ? '（' + L.nOrg + '家）' : '') + '</span>');
    h += kvRow("③ 三年后 EPS", num(L.eps3y, 2));
    h += kvRow("④ 隐含三年年化增速", (L.g3y > 0 ? "+" : "") + pct(L.g3y * 100, 1));
    h += kvRow("⑤ 合理 PE", '<b>' + num(L.pe, 1) + ' 倍</b> <span class="muted small">' + num(L.peBase, 1) + '×' + num(L.disc, 2) +
      (L.discTags.length ? '（' + esc(L.discTags.join("、")) + '）' : '') + '，增速封顶 ×' + num(L.capR, 2) + '（= ' + num(L.peCap, 1) + ' 倍）</span>');
    h += kvRow("⑥ 三年后合理估值", '<b>' + num(L.fair3y, 2) + '</b>');
    h += kvRow("⑦ 理想买点", '<b class="c-up">' + num(L.buy, 2) + '</b> <span class="muted small">三年后 × ' + Math.round(L.buyX * 100) + '%' +
      (L.buyX < 0.5 ? '（增速放缓/周期/护城河一般 → 加大安全边际）' : '') + '</span>');
    h += kvRow("⑧ 卖出参考", num(L.sell, 2) + ' <span class="muted small">min(三年后×150%, 基准EPS×50倍)</span>');
    h += '</div>';
    h += '<div class="note" style="margin-top:8px">' +
      (dist <= 0 ? '<span class="c-up">现价 ' + num(st.px, 2) + ' 已低于理想买点 ' + num(L.buy, 2) + '（低 ' + num(-dist, 1) + '%），落在老唐「理想买点」内</span>'
                 : '现价 ' + num(st.px, 2) + ' 距理想买点 ' + num(L.buy, 2) + ' 还需回落 <b>' + num(dist, 1) + '%</b>') + '</div>';
    h += '<div class="muted small" style="margin-top:6px"><b>增速放缓如何定价：</b>机构一致预期推出的三年年化增速 ' + pct(L.g3y * 100, 1) +
      ' → 合理 PE 封顶 = 基准 ×' + num(L.capR, 2) + '（≥15% ×1.05 / 8~15% ×0.95 / 3~8% ×0.87 / 0~3% ×0.77 / 负增长 ×0.70）= ' + num(L.peCap, 1) + ' 倍，' +
      '买点折让 ' + Math.round(L.buyX * 100) + '%。预期来源：' + esc(L.note) + '</div>';
    if (L.target) h += '<div class="muted small" style="margin-top:4px">机构综合目标价 ' + num(L.target, 2) + (L.nTarget ? '（' + L.nTarget + '家）' : '') +
      '，与三年后合理估值 ' + num(L.fair3y, 2) + ' 互为参照（前者多为 12 个月目标，后者为三年锚）。</div>';
    h += L.premise.length
      ? '<div class="note" style="margin-top:6px;background:#fff5f5"><b>三大前提未通过，老唐框架内不买入：</b>' + esc(L.premise.join("；")) + '</div>'
      : '<div class="muted small" style="margin-top:6px">三大前提（利润为真 / 利润可持续 / 维持盈利无需大量资本投入）：<span class="c-up">通过 ✓</span></div>';
    h += '</div>';
    return h;
  }
  window._setValMode = function (v) { VAL_MODE = (v === "band") ? "band" : "lt"; rerender(); };
  window._setRf = function (v) { LT_CFG.rf = Number(v) / 10; renderDetail(); };

  function renderDetail() {
    var st = byCode(curDetail) || S[0];
    curDetail = st.code;
    var sel = '<select id="detail-code" onchange="window._onSelChange(this.value)">';
    for (var i = 0; i < S.length; i++) sel += '<option value="' + S[i].code + '"' + (S[i].code === st.code ? " selected" : "") + '>' + esc(S[i].name) + '</option>';
    sel += '</select>';
    $("detail-sel").innerHTML = sel;
    var peLo = st.fairPE ? st.fairPE[0] : 0, peHi = st.fairPE ? st.fairPE[1] : 0;
    var h = '<div class="grid2">';
    // 左：质地
    h += '<div class="card"><h3>' + esc(st.name) + ' <span class="muted">' + fmtCode(st.code) + ' · ' + st.industry + ' · ' + (st.mkt === "A" ? "A股" : "港股") + '</span></h3>';
    h += '<div class="big ' + cls(st.chg) + '">' + num(st.px, 2) + ' <span class="mid">(' + (st.chg > 0 ? "+" : "") + pct(st.chg) + ')</span></div>';
    h += '<div class="grid2 kv">';
    h += kvRow("总市值", num(st.cap, 0) + " 亿");
    h += kvRow("年内涨跌", (st.ytd > 0 ? "+" : "") + pct(st.ytd));
    h += kvRow("PE 静态/前瞻", num(st.pe, 1) + " / " + num(st.peF, 1));
    h += kvRow("PB", num(st.pb, 2));
    h += kvRow("股息率 TTM", pct(st.div, 2));
    h += kvRow("52周区间", num(st.lo52, 2) + " ~ " + num(st.hi52, 2));
    var rpD = repInfo(st.code);
    if (rpD) h += kvRow("下次财报", repShort(rpD.date) + (rpD.days < 0 ? "（已披露）" : "（" + (rpD.days === 0 ? "今天" : rpD.days + " 天后") + "）"));
    if (st.roe != null) h += kvRow("ROE(TTM)", pct(st.roe, 1));
    if (st.gm != null) h += kvRow("毛利率(2026H1)", pct(st.gm, 1));
    if (st.npg != null) h += kvRow("归母净利同比", (st.npg > 0 ? "+" : "") + pct(st.npg, 1));
    if (st.revg != null) h += kvRow("营收同比", (st.revg > 0 ? "+" : "") + pct(st.revg, 1));
    h += '</div>';
    h += '<div class="pricebar"><div class="pb-lo">' + num(st.lo52, 1) + '</div><div class="pb-bar"><div class="pb-dot" style="left:' + pos52(st) + '%"></div></div><div class="pb-hi">' + num(st.hi52, 1) + '</div></div>';
    h += '<div class="muted small">现价处于52周区间 ' + pos52(st) + '% 分位 · 数据时点：' + mktAsOf(st.mkt === "A" ? "A" : "HK") + '</div></div>';
    // 右：五维 + 护城河/管理层
    h += '<div class="card"><h3>五维评估</h3><div id="radar-svg"></div>';
    h += '<div class="muted small"><b>护城河：</b>' + esc(st.moatTxt) + '</div>';
    h += '<div class="muted small" style="margin-top:6px"><b>管理层：</b>' + esc(st.mgmtTxt) + '</div>';
    h += '<div class="note" style="margin-top:8px">' + esc(st.note) + '</div></div>';
    h += '</div>';
    var L0 = ltValue(st);
    if (L0) h += ltCard(st, L0);
    // 历史估值百分位
    h += valCard(st);
    // 目标价计算（合理PE带法：老唐法的对照口径，可手动调 PE 带与安全边际）
    h += '<div class="card"><h3>目标投资价格区间与安全边际<span class="muted small"> · 合理PE带法' +
      (VAL_MODE === "lt" ? '（当前选股用老唐法，此处为对照）' : '（当前生效）') + '</span></h3>';
    if (st.fairPE) {
      h += '<div class="grid4 sliders2">' +
        inpNum("合理PE下限", "fpeLo", peLo) + inpNum("合理PE上限", "fpeHi", peHi) +
        inpNum("安全边际 %", "mos", 30) + '<div><label>估值基准</label><div class="muted" style="padding-top:24px">' + (st.peF ? "前瞻EPS " + num(st.px / st.peF, 2) : "静态EPS " + num(st.px / st.pe, 2)) + '</div></div></div>';
    } else if (st.fairPB) {
      h += '<div class="grid4 sliders2">' +
        inpNum("合理PB下限", "fpeLo", st.fairPB[0]) + inpNum("合理PB上限", "fpeHi", st.fairPB[1]) +
        inpNum("安全边际 %", "mos", 30) + '<div><label>估值基准</label><div class="muted" style="padding-top:24px">每股净资产 ' + num(st.px / st.pb, 2) + '（当前亏损期，用PB估值）</div></div></div>';
    } else {
      h += '<div class="grid4 sliders2">' + inpNum("合理PE下限", "fpeLo", 10) + inpNum("合理PE上限", "fpeHi", 15) + inpNum("安全边际 %", "mos", 30) + '<div><label>估值基准</label><div class="muted" style="padding-top:24px">静态EPS ' + num(st.px / st.pe, 2) + '</div></div></div>';
    }
    h += '<div id="target-out"></div></div>';
    h += '<div class="muted small" style="margin:8px 0">' + window.DISCLAIMER + '</div>';
    $("detail-body").innerHTML = h;
    var r = targetRange(st, st.fairPE ? st.fairPE[0] : (st.fairPB ? st.fairPB[0] : 10), st.fairPE ? st.fairPE[1] : (st.fairPB ? st.fairPB[1] : 15));
    drawRadar(st);
    var cv = curVal(st);
    if (cv && cv.v.pe && cv.pe != null) drawValChart("val-chart", cv.v.pe, cv.v.peStats, cv.pe, "倍");
    var els = document.querySelectorAll("#detail-body input");
    for (var e = 0; e < els.length; e++) els[e].oninput = recalcTarget;
    recalcTarget();
  }
  window.renderDetail = renderDetail;
  window._onSelChange = function (v) { curDetail = v; renderDetail(); };
  function kvRow(k, v) { return '<div class="muted">' + k + '</div><div><b>' + v + '</b></div>'; }
  function pos52(st) { if (st.hi52 <= st.lo52) return 50; return Math.max(0, Math.min(100, Math.round((st.px - st.lo52) / (st.hi52 - st.lo52) * 100))); }
  function inpNum(label, id, v) { return '<div><label>' + label + '</label><input type="number" id="' + id + '" value="' + v + '" step="0.5"></div>'; }
  function recalcTarget() {
    var st = byCode(curDetail) || S[0];
    var lo = Number($("fpeLo").value) || 0, hi = Number($("fpeHi").value) || 0, mos = Number($("mos").value) || 0;
    var r = targetRange(st, lo, hi);
    if (!r) { $("target-out").innerHTML = ""; return; }
    // 老唐法：买点已含 50% 安全边际，不再叠加 MOS；旧法：中枢 × (1−MOS)
    var buy = r.buyOverride != null ? r.buyOverride : r.mid * (1 - mos / 100);
    var vsNow = (r.mid / st.px - 1) * 100;
    var isLT = r.type === "LT";
    var out = '<div class="grid3 target-cards">';
    out += '<div class="tcard t-lo"><div class="muted">' + (isLT ? "理想买点（三年后×" + Math.round(r.lt.buyX * 100) + "%）" : "悲观（区间下沿）") + '</div><div class="tbig">' + num(r.lo, 2) + '</div><div class="muted small">现价 ' + pct((r.lo / st.px - 1) * 100, 1) + '</div></div>';
    out += '<div class="tcard t-mid"><div class="muted">' + (isLT ? "三年后合理估值" : "中性（合理中枢）") + '</div><div class="tbig">' + num(r.mid, 2) + '</div><div class="muted small">较现价空间 +' + pct(vsNow, 1) + '</div></div>';
    out += '<div class="tcard t-hi"><div class="muted">' + (isLT ? "卖出参考（孰低）" : "乐观（区间上沿）") + '</div><div class="tbig">' + num(r.hi, 2) + '</div><div class="muted small">较现价空间 +' + pct((r.hi / st.px - 1) * 100, 1) + '</div></div>';
    out += '</div>';
    out += '<div class="card-inner"><b>' + (isLT ? "理想买点：" : "安全边际买入参考价：") + num(buy, 2) + '</b> <span class="muted small">（' +
      (isLT ? "三年后合理估值 × " + Math.round(r.lt.buyX * 100) + "%，已内含安全边际" : "= 中性估值 × (1 − " + mos + "%)") + '）· ' +
      (st.px <= buy ? '<span class="c-up">当前价已进入安全边际区间 ✓</span>' : '当前价高于买入参考价，建议等待回调或分批建仓') + '</span></div>';
    out += '<div class="muted small" style="margin-top:6px">' + esc(r.base) + '。区间仅为估值框架输出，非预测。</div>';
    $("target-out").innerHTML = out;
  }
  window.recalcTarget = recalcTarget;
  function drawRadar(st) {
    var dims = [["护城河", st.moat], ["盈利质量", st.quality], ["管理层", st.mgmt], ["成长性", st.growth], ["估值安全", st.valuation]];
    var cx = 130, cy = 118, R = 86, N = 5, svg = "";
    svg += '<svg width="100%" viewBox="0 0 260 236">';
    for (var ring = 1; ring <= 4; ring++) {
      var pts = "";
      for (var i = 0; i < N; i++) {
        var ang = -Math.PI / 2 + i * 2 * Math.PI / N;
        pts += (cx + Math.cos(ang) * R * ring / 4).toFixed(1) + "," + (cy + Math.sin(ang) * R * ring / 4).toFixed(1) + " ";
      }
      svg += '<polygon points="' + pts + '" fill="none" stroke="#d8dee9" stroke-width="1"/>';
    }
    var vpts = "";
    for (var j = 0; j < N; j++) {
      var ang2 = -Math.PI / 2 + j * 2 * Math.PI / N;
      var rr = R * Math.max(0, Math.min(10, dims[j][1])) / 10;
      vpts += (cx + Math.cos(ang2) * rr).toFixed(1) + "," + (cy + Math.sin(ang2) * rr).toFixed(1) + " ";
    }
    svg += '<polygon points="' + vpts + '" fill="rgba(37,99,235,0.18)" stroke="#2563eb" stroke-width="2"/>';
    for (var k = 0; k < N; k++) {
      var ang3 = -Math.PI / 2 + k * 2 * Math.PI / N;
      var lx = cx + Math.cos(ang3) * (R + 16), ly = cy + Math.sin(ang3) * (R + 14);
      svg += '<text x="' + lx.toFixed(0) + '" y="' + ly.toFixed(0) + '" text-anchor="middle" font-size="11" fill="#5b6472">' + dims[k][0] + ' ' + dims[k][1] + '</text>';
    }
    svg += '</svg>';
    var el = document.getElementById("radar-svg");
    if (el) el.innerHTML = svg;
  }

  // ---------- 财报披露日历（下次财报预约披露日；data/reports.js 由 fetch-reports.js 每日刷新） ----------
  var REP = window.REPORTS || { asOf: "", dates: {} };
  function repInfo(code, ref) {           // ref：可选基准日 "YYYY-MM-DD"（默认今天），测试可注入固定日期
    var d = (REP.dates && REP.dates[code]) || null;
    if (!d) return null;
    var now = ref ? new Date(ref + "T00:00:00") : new Date();
    now = new Date(now.getFullYear(), now.getMonth(), now.getDate());   // 归到当天 0 点
    var tgt = new Date(d + "T00:00:00");
    var days = Math.round((tgt - now) / 86400000);
    return { date: d, days: days, soon: days >= 0 && days <= 7 };
  }
  function repShort(d) {                  // 同年省略年份，跨年带上
    return d.slice(0, 4) === String(new Date().getFullYear()) ? d.slice(5) : d;
  }
  function repLabel(code, ref) {          // 表格单元格用：7 天内披露的标红提示天数
    var r = repInfo(code, ref);
    if (!r) return '<span class="muted">—</span>';
    if (r.days < 0) return '<span class="muted small">已披露</span>';
    return '<span class="repchip' + (r.soon ? " rep-soon" : "") + '">📅 ' + repShort(r.date) +
      (r.soon ? ' · ' + r.days + '天' : '') + '</span>';
  }
  function repCalendarHTML(list, title) { // 页面顶部「财报日历」卡：未来 60 天披露安排，按日期升序
    var items = [];
    for (var i = 0; i < list.length; i++) {
      var r = repInfo(list[i].code);
      if (r && r.days >= 0 && r.days <= 60) items.push({ s: list[i], r: r });
    }
    items.sort(function (a, b) { return a.r.days - b.r.days; });
    var h = '<div class="card"><b>📅 财报日历</b> <span class="muted small">' + title +
      ' · 业绩预约披露日（' + esc(REP.asOf || "—") + ' 更新，实际以交易所公告为准）</span>';
    if (!items.length) {
      h += '<div class="small" style="margin-top:6px">未来 60 天内暂无披露安排；有预约后会在这里按时间列出。</div></div>';
      return h;
    }
    h += '<div class="small" style="margin-top:6px">';
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      h += '<span class="repitem' + (it.r.soon ? " rep-soon" : "") + '">📅 ' + repShort(it.r.date) + ' ' + esc(it.s.name) +
        '（' + (it.r.days === 0 ? '今天' : it.r.days + ' 天后') + '）</span>';
    }
    h += '</div></div>';
    return h;
  }
  window._repInfo = repInfo; window._repLabel = repLabel;   // 供回归测试注入基准日调用

  // ---------- 名单变动提示（与上次归档基线对比） ----------
  // 基线 data/baseline.js 由每日 18:00 自动化运行 gen-baseline.js 归档：
  //   picks = 每日推荐四象限名单 · formal = 建仓节奏正式名单 · us = 美股四象限名单 · pool = 筛选池成员
  // 展示口径：只列「移入 / 移出 + 一句话原因」，无变动时一句话带过，不展开长篇分析。
  function changeCard(scope) {
    var B = window.IA_BASELINE;
    if (!B) return "";
    var ch = (B.changes || {})[scope] || [];
    var h = '<div class="card chgcard"><b>⚑ 名单变动</b> <span class="muted small">对比 ' + esc(B.prevAsOf || "—") + ' → ' + esc(B.asOf || "—") + ' 归档</span>';
    if (!B.prevAsOf) {
      h += '<div class="small" style="margin-top:6px">首次归档基线（' + esc(B.asOf || "—") + '）。从下一次归档起，移入 / 移出会在这里提示并说明原因。</div></div>';
      return h;
    }
    if (!ch.length) {
      h += '<div class="small" style="margin-top:6px">名单无变动 —— 与上期归档一致。</div></div>';
      return h;
    }
    h += '<div class="small" style="margin-top:6px">';
    for (var i = 0; i < ch.length; i++) {
      var c = ch[i];
      h += '<div style="margin:2px 0">' + (c.dir === "in" ? '<span class="c-up">▲ 移入</span>' : '<span class="c-down">▽ 移出</span>') +
        ' <b>' + esc(c.name) + '</b>' + (c.tag ? ' <span class="muted">[' + esc(c.tag) + ']</span>' : '') +
        (c.reason ? ' —— ' + esc(c.reason) : '') + '</div>';
    }
    h += '</div></div>';
    return h;
  }

  // ---------- 每日推荐 ----------
  function picks() {
    function top(cat, n, fn) {
      var arr = S.filter(function (s) { return s.cat.indexOf(cat) >= 0; });
      // 老唐模式：与选股同口径，先过「三大前提」并排除无法估值的标的
      if (VAL_MODE === "lt") arr = arr.filter(function (s) { return ltValue(s) && !ltPremise(s).length; });
      return arr.sort(fn).slice(0, n);
    }
    var steady = top("steady", 3, function (a, b) { return (b.valuation * 2 + b.div) - (a.valuation * 2 + a.div); });
    var growth = top("growth", 3, function (a, b) { return (b.growth + b.quality) - (a.growth + a.quality); });
    var rotate = top("rotate", 2, function (a, b) { return composite(b, W) - composite(a, W); });
    var tenx = top("tenx", 2, function (a, b) { return b.growth - a.growth; });
    function reason(s, kind) {
      var bits = [];
      if (kind === "steady") bits.push("股息率 " + pct(s.div, 1) + "，PE " + num(s.pe, 1) + " 倍，" + (s.pb < 1 ? "PB " + num(s.pb, 2) + " 破净" : "PB " + num(s.pb, 2)));
      if (kind === "growth") bits.push(s.npg != null ? "2026H1 净利 +" + pct(s.npg, 1) : "盈利动能强", s.roe != null ? "ROE(TTM) " + pct(s.roe, 1) : "", "PE " + num(s.pe, 1) + " 倍");
      if (kind === "rotate") bits.push("契合当前价值/南向主线", s.npg != null ? "净利 +" + pct(s.npg, 1) : "", "综合分 " + num(composite(s, W), 1));
      if (kind === "tenx") bits.push("产业期权型标的", s.npg != null ? "净利 " + pct(s.npg, 1) : "", "波动大，仓位≤5%");
      return bits.filter(function (x) { return x; }).join(" · ");
    }
    function pack(list, kind) {
      return list.map(function (s) {
        var r = targetRange(s, s.fairPE ? s.fairPE[0] : (s.fairPB ? s.fairPB[0] : 10), s.fairPE ? s.fairPE[1] : (s.fairPB ? s.fairPB[1] : 15));
        var rg = !r ? "—" : (r.type === "LT"
          ? "理想买点 " + num(r.lo, 2) + " · 三年后合理 " + num(r.mid, 2) + " · 卖出参考 " + num(r.hi, 2)
          : num(r.lo, 2) + " ~ " + num(r.hi, 2) + "（中枢 " + num(r.mid, 2) + "）");
        return { s: s, reason: reason(s, kind), range: rg };
      });
    }
    return { steady: pack(steady, "steady"), growth: pack(growth, "growth"), rotate: pack(rotate, "rotate"), tenx: pack(tenx, "tenx") };
  }
  function picksHTML() {
    var P = picks();
    var h = '<div class="asof">名单基于 ' + (M.asOfA === M.asOfHK ? mktAsOf("A") : mktAsOf("A") + " / " + mktAsOf("HK")) + '行情重算 · 四象限名单每个交易日 18:00 归档一次（价格跌破/涨出排序线即换标的）· 与上期的移入移出见下方「名单变动」</div>';
    h += changeCard("picks");
    var blocks = [["steady", "稳增长 · 底仓（建议关注 2~3 只）"], ["growth", "高增长 · 进攻（逢回调分批）"], ["rotate", "热点轮动 · 卫星（小仓位跟踪主线）"], ["tenx", "十倍空间 · 期权（仓位严格 ≤10%）"]];
    for (var b = 0; b < blocks.length; b++) {
      var cat = blocks[b][0];
      h += '<div class="card"><h3><span class="dot" style="background:' + CAT[cat].color + '"></span>' + blocks[b][1] + '</h3><div class="muted small">' + CAT[cat].desc + '</div>';
      h += '<table class="tbl"><thead><tr><th>标的</th><th>现价</th><th>估值分位</th><th>关注理由</th><th>' +
        (VAL_MODE === "lt" ? "老唐法：买点 / 三年后 / 卖出" : "目标价区间（模型）") + '</th><th>财报</th><th>年内</th></tr></thead><tbody>';
      for (var i = 0; i < P[cat].length; i++) {
        var it = P[cat][i];
        var vs = valScore(it.s), vt = valTag(vs), cv = curVal(it.s);
        h += '<tr onclick="openDetail(\'' + it.s.code + '\')" class="rowlink"><td><b>' + esc(it.s.name) + '</b><span class="muted small"> ' + fmtCode(it.s.code) + '</span></td><td>' + num(it.s.px, 2) + '</td>' +
          '<td><span class="vchip ' + vt.c + '">' + (vs == null ? "—" : pct(vs, 0)) + '</span><div class="muted small">' + vt.t + (cv && cv.pe != null ? ' · PE ' + num(cv.pe, 1) + '倍' : '') + '</div></td>' +
          '<td class="small wrapcol">' + esc(it.reason) + '</td><td>' + it.range + '</td><td class="small">' + repLabel(it.s.code) + '</td><td class="' + cls(it.s.ytd) + '">' + (it.s.ytd > 0 ? "+" : "") + pct(it.s.ytd) + '</td></tr>';
      }
      h += '</tbody></table></div>';
    }
    h += '<div class="card verdict"><b>组合思路：</b>当前市场缩量调整+估值偏高，建议底仓（稳增长）不低于 40%，等待回调加仓高增长；热点轮动小仓位跟随价值主线；十倍空间类仅用“输得起”的仓位买期权。</div>';
    return h;
  }

  // ---------- 投资组合 ----------
  var ALLOC = { steady: DEF.steady, growth: DEF.growth, rotate: DEF.rotate, tenx: DEF.tenx };
  function portfolioHTML() {
    var h = "";
    h += '<div class="card"><b>四象限组合配比</b> <span class="muted small">拖动滑块调整（自动归一化）</span><div class="grid4 sliders">';
    var keys = ["steady", "growth", "rotate", "tenx"];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      h += '<div><label><span class="dot" style="background:' + CAT[k].color + '"></span>' + CAT[k].label + ' <b id="av-' + k + '">' + ALLOC[k] + '%</b></label>' +
        '<input type="range" min="0" max="60" step="5" value="' + ALLOC[k] + '" oninput="window._setA(\'' + k + '\', this.value)"></div>';
    }
    h += '</div></div>';
    h += '<div class="grid2"><div class="card"><h3>配置结构</h3><div id="donut"></div></div><div class="card"><h3>组合明细（与建仓节奏页同一选股口径）</h3><div id="pdetail"></div></div></div>';
    h += '<div class="muted small" style="margin:8px 0">本页是「股票部分」的配置结构 + 组合示意，<b>选股口径与「💰 建仓节奏」页完全一致</b>（三层门槛 + 护城河分象限 + 核心资产优先 + 象限配额）；具体买点、三批建仓与卖出纪律见「💰 建仓节奏」页。热点轮动 20% 中含 5% 备用金（落地时 15% 直配 + 5% 等更佳买点）。★核心 = 综合分≥8 且护城河≥8.5，象限内优先占位。</div>';
    return h;
  }
  window._setA = function (k, v) { ALLOC[k] = Number(v); $("av-" + k).textContent = v + "%"; drawAlloc(); };
  function drawAlloc() {
    var sum = ALLOC.steady + ALLOC.growth + ALLOC.rotate + ALLOC.tenx;
    var keys = ["steady", "growth", "rotate", "tenx"];
    var SP = stockPickList();                 // 与建仓节奏页「③ 股票端」同一套选股结果，保证两页标的清单一致
    var byCat = {};
    for (var bi = 0; bi < SP.picks.length; bi++) { var bc = SP.picks[bi].catKey; (byCat[bc] = byCat[bc] || []).push(SP.picks[bi]); }
    var wsum = 0, wpe = 0, wdiv = 0, wcomp = 0, rows = 0, held = 0, wpeSum = 0;
    var detail = "";
    var donut = '<svg viewBox="0 0 200 200" width="100%" style="max-width:280px">';
    var acc = 0;
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var share = sum > 0 ? ALLOC[k] / sum : 0;
      var members = byCat[k] || [];
      if (members.length && share > 0) {
        rows++;
        var mPE = 0, mDiv = 0, mC = 0, peCnt = 0;
        var cnt = members.length;              // 先定总数，避免边计数边算权重导致权重膨胀
        var eachW = share * 100 / cnt;         // 该象限内等权，象限内合计 = share*100
        for (var m = 0; m < members.length; m++) {
          var o = members[m], s = o.s;
          if (s.pe && s.pe > 0) { mPE += s.pe; peCnt++; }
          mDiv += s.div; mC += composite(s, W);
          var dTag = o.dist <= 0 ? '已达买点' : '距买点 +' + num(o.dist, 0) + '%';
          var buyTag = VAL_MODE === "lt" ? '买点 ' + num(o.buy, 1) + '（老唐法·三年后×' + Math.round((o.lt ? o.lt.buyX : 0.5) * 100) + '%）' : '买点 ' + num(o.buy, 1) + '（PE带×' + (100 - STK_MOS) + '%）';
          var rp = repInfo(s.code);
          var rpTag = rp && rp.days >= 0 && rp.days <= 14 ? ' · 📅 ' + repShort(rp.date) + (rp.soon ? '（' + rp.days + '天）' : '') : '';
          detail += '<div class="pline"><span class="dot" style="background:' + CAT[k].color + '"></span><b>' + esc(s.name) + '</b>' + (o.core ? '<span class="core-chip">★核心</span>' : '') + '<span class="muted small"> ' + fmtCode(s.code) + '</span><span class="right muted">组合权重 ' + pct(eachW, 1) + ' · ' + dTag + ' · ' + buyTag + ' · PE ' + num(s.pe, 1) + rpTag + '</span></div>';
        }
        wpe += (peCnt > 0 ? mPE / peCnt : 0) * share; if (peCnt > 0) wpeSum += share;
        wdiv += (mDiv / cnt) * share; wcomp += (mC / cnt) * share;
        wsum += share; held += cnt;
      } else if (share > 0) {
        // 该象限当前无达标标的：占位展示，权重计入，保持配置合计 100%
        detail += '<div class="pline"><span class="dot" style="background:' + CAT[k].color + '"></span><b>' + CAT[k].label + '</b><span class="muted small">暂无达标标的</span><span class="right muted">组合权重 ' + pct(share * 100, 1) + ' · 暂作备用金等待</span></div>';
        wsum += share;
      }
      var dash = share * 100 * 2.51327;
      donut += '<circle cx="100" cy="100" r="40" fill="none" stroke="' + CAT[k].color + '" stroke-width="26" stroke-dasharray="' + dash.toFixed(2) + ' 999" transform="rotate(' + (acc * 360 - 90).toFixed(1) + ' 100 100)"/>';
      acc += share;
    }
    donut += '<text x="100" y="96" text-anchor="middle" font-size="13" fill="#5b6472">组合加权</text>';
    donut += '<text x="100" y="116" text-anchor="middle" font-size="18" font-weight="bold" fill="#1c2333">股息 ' + wdiv.toFixed(2) + '%</text></svg>';
    $("donut").innerHTML = donut;
    var meta = '<div class="kv kvg k2" style="margin-top:8px"><div class="muted">权重合计</div><div><b>' + num(wsum * 100, 1) + '%</b></div>' +
      '<div class="muted">持仓只数</div><div><b>' + held + ' 只</b></div>' +
      '<div class="muted">加权 PE（有效样本）</div><div><b>' + (wpeSum > 0 ? num(wpe / wpeSum, 1) : "—") + '</b></div>' +
      '<div class="muted">加权股息率</div><div><b>' + num(wdiv / Math.max(0.01, wsum), 2) + '%</b></div>' +
      '<div class="muted">加权综合分</div><div><b>' + num(wcomp / Math.max(0.01, wsum), 2) + '</b></div>' +
      '<div class="muted">覆盖象限数</div><div><b>' + rows + ' / 4</b></div></div>';
    $("donut").innerHTML = donut + meta;
    $("pdetail").innerHTML = detail || '<div class="muted">请调高至少一个象限的配比</div>';
  }

  // ---------- 🧺 A股港股（合并页：市场雷达 + 每日推荐 + 投资组合 + 好公司筛选，版式同「美股组合」页） ----------
  // 标的池覆盖 A股 + 港股共 28 只；四个板块的旧页名（radar/pick/portfolio/screen）经 TAB_ALIAS 仍可访问
  function renderAH() {
    var h = '<div class="asof">A股 + 港股组合 · 原市场雷达 / 每日推荐 / 投资组合 / 好公司筛选 四页已合并到本页 · 行情截至 ' +
      (M.asOfA === M.asOfHK ? mktAsOf("A") : mktAsOf("A") + " / " + mktAsOf("HK")) +
      ' <button class="btn btn-mini" onclick="window.refreshLive()">↻ 刷新行情</button></div>';
    h += '<div class="vfilter" style="margin-bottom:8px"><span class="muted small">估值法（影响全站买点与选股）：' +
      '<select onchange="window._setValMode(this.value)">' + opt("lt", "老唐估值法", VAL_MODE) + opt("band", "合理PE带法（默认）", VAL_MODE) + '</select></span>' +
      '<span class="vf-right muted small">' + (VAL_MODE === "lt"
        ? "老唐法：基准EPS × 机构一致预期三年倍数 → 三年后EPS × 合理PE（25~30倍，按质地与增速打折）→ 三年后合理估值 × 50% = 理想买点"
        : "合理PE带法：前瞻EPS × 合理PE带中枢 × (1−30%安全边际) = 买点") + '</span></div>';
    h += '<div class="card note"><b>本页结构</b>：市场雷达（指数与市场画像）→ 每日推荐（四象限名单，每交易日 18:00 归档对比）→ 投资组合（四象限配比与明细）→ 好公司筛选（五维评分与全池清单）。名单变动提示在各板块顶部；A股与港股标的混排，点击任意标的行可看调研详情。</div>';
    h += repCalendarHTML(S, "A股 + 港股标的池 · 未来 60 天披露安排");
    h += '<div id="radar-body"></div>';
    h += '<div class="sectitle"><b>每日推荐 · 四象限名单</b> <span class="muted small">每个交易日随行情重算并归档</span></div>';
    h += '<div id="pick-body"></div>';
    h += '<div class="sectitle"><b>投资组合 · 四象限配比</b> <span class="muted small">选股口径与「💰 建仓节奏」一致</span></div>';
    h += '<div id="portfolio-body"></div>';
    h += '<div class="sectitle"><b>好公司筛选 · 五维评分与全池清单</b> <span class="muted small">池子成员每月 1 日复核</span></div>';
    h += '<div id="screen-body"></div>';
    h += '<div class="muted small" style="margin:8px 0">' + window.DISCLAIMER + '</div>';
    $("ah-body").innerHTML = h;
    $("radar-body").innerHTML = radarHTML();
    $("pick-body").innerHTML = picksHTML();
    $("portfolio-body").innerHTML = portfolioHTML();
    $("screen-body").innerHTML = screenHTML();
    drawAlloc();
  }

  // ---------- 美股组合（与 A股/港股组合完全独立，配比与标的池各自独立） ----------
  var US_ALLOC = { steady: UDEF.steady, growth: UDEF.growth, rotate: UDEF.rotate, tenx: UDEF.tenx };
  var US_KEYS = ["steady", "growth", "rotate", "tenx"];
  var US_VIEW = { cat: "all", sort: "comp" };

  function usSym(s) {
    // en 形如 "BRK.B.N" / "AAPL.OQ" / "KO.N"：去掉交易所后缀，保留 BRK.B 这类含点代码
    var t = String(s.en || s.code || "").replace(/^us/i, "").split(".");
    return (t.length >= 3) ? t[0] + "." + t[1] : t[0];
  }
  // 巴芒核心判定：护城河+质量双高（≥8 且 ≥8）才算「好生意」；其余为「观察/非核心」
  function usTier(s) {
    return (s.moat >= 8 && s.quality >= 8) ? "core" : "watch";
  }
  function usSortScore(s, k) {
    if (k === "steady") return composite(s, W);       // 好生意优先，避免「低估值+高股息」的价值陷阱排前
    if (k === "growth") return s.growth + s.quality;
    if (k === "rotate") return composite(s, W);
    return s.growth;
  }
  function usTop(k, n) {
    return US.filter(function (s) { return s.cat.indexOf(k) >= 0; })
      .sort(function (a, b) { return usSortScore(b, k) - usSortScore(a, k); }).slice(0, n);
  }
  // 参考价区间 = EPS(TTM) × 合理PE带（模型假设，非盈利预测）
  function usRange(s) {
    if (!s.eps || s.eps <= 0 || !s.fairPE || !(s.fairPE[1] > 0)) return null;
    var lo = s.eps * s.fairPE[0], hi = s.eps * s.fairPE[1];
    if (!isFinite(lo) || !isFinite(hi) || lo <= 0) return null;
    return { lo: lo, hi: hi, mid: (lo + hi) / 2 };
  }
  // 估值信号：当前 PE 与合理 PE 带比较（合理带为模型假设）；美股暂缺历史 PE 分位，用 52 周位置作补充
  function usSignal(s) {
    if (!s.pe || !s.fairPE || !(s.fairPE[1] > 0)) return { t: "盈利口径不适用", c: "v-na" };
    if (s.pe < s.fairPE[0]) return { t: "低于合理PE带", c: "v1" };
    if (s.pe > s.fairPE[1]) return { t: "高于合理PE带", c: "v5" };
    if (s.pos52 != null && s.pos52 > 90) return { t: "合理区间内·位置偏高", c: "v4" };
    return { t: "合理区间内", c: "v3" };
  }
  function usReason(s, kind) {
    var b = [];
    if (kind === "steady") {
      b.push(s.div != null ? "股息率 " + pct(s.div, 1) : "不分红，靠留存收益复利");
      b.push("PE " + num(s.pe, 1) + " 倍");
      b.push("52周位置 " + num(s.pos52, 0) + "%");
    }
    if (kind === "growth") {
      b.push("成长分 " + num(s.growth, 1) + " · 质量分 " + num(s.quality, 1));
      b.push("PE " + num(s.pe, 1) + " 倍");
      if (s.ytd != null) b.push("年内 " + (s.ytd > 0 ? "+" : "") + pct(s.ytd, 1));
    }
    if (kind === "rotate") {
      b.push("综合分 " + num(composite(s, W), 1));
      if (s.m12 != null) b.push("12月 " + (s.m12 > 0 ? "+" : "") + pct(s.m12, 1));
      b.push("年化波动 " + num(s.vol12, 0) + "%");
    }
    if (kind === "tenx") {
      b.push("成长分 " + num(s.growth, 1));
      if (s.ytd != null) b.push("年内 " + (s.ytd > 0 ? "+" : "") + pct(s.ytd, 1));
      b.push("波动 " + num(s.vol12, 0) + "%，仓位≤5%");
    }
    return b.filter(function (x) { return x; }).join(" · ");
  }
  function usPicks() {
    var out = {}, ns = { steady: 3, growth: 3, rotate: 2, tenx: 2 };
    for (var i = 0; i < US_KEYS.length; i++) {
      var k = US_KEYS[i];
      out[k] = usTop(k, ns[k]).map(function (s) {
        var r = usRange(s);
        return {
          s: s, reason: usReason(s, k),
          range: r ? num(r.lo, 2) + " ~ " + num(r.hi, 2) + "（中枢 " + num(r.mid, 2) + "）" : "盈利口径不适用"
        };
      });
    }
    return out;
  }
  window._usView = function (k, v) { US_VIEW[k] = v; usRenderTable(); };
  function usRenderTable() {
    var el = $("us-table");
    if (!el) return;
    var rows = US.filter(function (s) { return US_VIEW.cat === "all" || s.cat.indexOf(US_VIEW.cat) >= 0; });
    rows.sort(function (a, b) {
      if (US_VIEW.sort === "pos52") return (a.pos52 == null ? 999 : a.pos52) - (b.pos52 == null ? 999 : b.pos52);
      if (US_VIEW.sort === "pe") return (a.pe == null ? 1e9 : a.pe) - (b.pe == null ? 1e9 : b.pe);
      if (US_VIEW.sort === "ytd") return (b.ytd == null ? -999 : b.ytd) - (a.ytd == null ? -999 : a.ytd);
      if (US_VIEW.sort === "div") return (b.div || 0) - (a.div || 0);
      return composite(b, W) - composite(a, W);
    });
    var h = '<table class="tbl"><thead><tr><th>标的</th><th>行业</th><th>现价(USD)</th><th>涨跌</th><th>PE</th><th>EPS</th><th>股息</th><th>市值(亿$)</th><th>52周位置</th><th>年内</th><th>估值信号</th><th>综合分</th><th>评级</th><th>财报</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var s = rows[i], sg = usSignal(s), cv = composite(s, W);
      h += '<tr title="' + esc(s.note) + '"><td><b>' + esc(s.name) + '</b>' + (usTier(s) === "watch" ? '<span class="us-watch">观察</span>' : '<span class="us-core">巴芒核心</span>') + '<span class="muted small"> ' + usSym(s) + '</span></td>' +
        '<td>' + esc(s.industry) + '</td>' +
        '<td>' + num(s.px, 2) + '</td>' +
        '<td class="' + cls(s.chg) + '">' + (s.chg > 0 ? "+" : "") + pct(s.chg) + '</td>' +
        '<td>' + num(s.pe, 1) + '</td><td>' + num(s.eps, 2) + '</td><td>' + (s.div == null ? "—" : pct(s.div, 1)) + '</td>' +
        '<td>' + num(s.mcapYi, 0) + '</td>' +
        '<td>' + num(s.pos52, 0) + '%</td>' +
        '<td class="' + cls(s.ytd) + '">' + (s.ytd == null ? "—" : (s.ytd > 0 ? "+" : "") + pct(s.ytd, 1)) + '</td>' +
        '<td><span class="vchip ' + sg.c + '">' + sg.t + '</span></td>' +
        '<td>' + num(cv, 2) + '</td><td>' + grade(cv) + '</td><td class="small">' + repLabel(s.code) + '</td></tr>';
    }
    h += '</tbody></table>';
    el.innerHTML = h;
  }
  function renderUS() {
    var P = usPicks();
    var h = '<div class="asof">美股组合 · 独立标的池与配比（与 A股/港股组合互不干扰） · 行情截至 ' +
      mktAsOf("US") + '（美东） · ' + (LIVE.on ? "已接入实时行情" : "实时行情获取中或不可用") + '</div>';
    h += changeCard("us");
    h += '<div class="card note"><b>美股名单怎么变</b>：四象限推荐名单与 A股同一套逻辑 —— <b>每个交易日</b>随行情重算（价格变动 → PE / 52 周位置变 → 象限内排序变），18:00 归档对比；标的池成员与五维评分 <b>每月 1 日复核一次</b>。纳指定投倍数另随 PE 档位每日调整（见整体投顾页）。</div>';
    h += repCalendarHTML(US, "美股标的池 · 未来 60 天披露安排");

    // 相关全球指数
    if (UM.indices && UM.indices.length) {
      h += '<div class="card"><b>相关全球指数</b><div class="grid4 ixgrid">';
      var want = ["hkHSTECH", "usIXIC", "usNDX", "usINX"];
      for (var w = 0; w < want.length; w++) {
        var ix = null;
        for (var q = 0; q < UM.indices.length; q++) if (UM.indices[q].code === want[w]) ix = UM.indices[q];
        if (!ix) continue;
        h += '<div class="ixbox"><div class="ixname">' + esc(ix.name) + '</div><div class="ixpx">' + num(ix.close, 2) + '</div>' +
          '<div class="' + cls(ix.chg) + '">' + (ix.chg > 0 ? "+" : "") + pct(ix.chg) + '</div>' +
          '<div class="muted small">' + esc(ix.asOf || "") + '</div></div>';
      }
      h += '</div></div>';
    }

    // 四象限推荐
    var blocks = [["steady", "稳增长 · 底仓", "护城河+质量双高（巴芒核心），现金流防御"], ["growth", "高增长 · 进攻", "盈利质量与成长性俱佳（巴芒核心）"], ["rotate", "热点轮动 · 卫星", "顺应产业主线（非巴芒核心，卫星仓位）"], ["tenx", "十倍空间 · 期权", "高弹性高波动（非巴芒核心，严格限仓）"]];
    for (var b = 0; b < blocks.length; b++) {
      var cat = blocks[b][0];
      h += '<div class="card"><h3><span class="dot" style="background:' + CAT[cat].color + '"></span>' + blocks[b][1] + '</h3><div class="muted small">' + blocks[b][2] + '</div>';
      h += '<table class="tbl"><thead><tr><th>标的</th><th>现价(USD)</th><th>估值信号</th><th>关注理由（真实数据）</th><th>参考价区间（模型）</th><th>财报</th><th>年内</th></tr></thead><tbody>';
      for (var i = 0; i < P[cat].length; i++) {
        var it = P[cat][i], sg = usSignal(it.s);
        h += '<tr title="' + esc(it.s.note) + '"><td><b>' + esc(it.s.name) + '</b>' + (usTier(it.s) === "watch" ? '<span class="us-watch">观察</span>' : '<span class="us-core">巴芒核心</span>') + '<span class="muted small"> ' + usSym(it.s) + '</span></td>' +
          '<td>' + num(it.s.px, 2) + '</td>' +
          '<td><span class="vchip ' + sg.c + '">' + sg.t + '</span><div class="muted small">PE ' + num(it.s.pe, 1) + ' · 带 ' + (it.s.fairPE && it.s.fairPE[1] ? it.s.fairPE[0] + "~" + it.s.fairPE[1] : "—") + '</div></td>' +
          '<td class="small wrapcol">' + esc(it.reason) + '</td><td>' + it.range + '</td>' +
          '<td class="small">' + repLabel(it.s.code) + '</td>' +
          '<td class="' + cls(it.s.ytd) + '">' + (it.s.ytd == null ? "—" : (it.s.ytd > 0 ? "+" : "") + pct(it.s.ytd, 1)) + '</td></tr>';
      }
      h += '</tbody></table></div>';
    }

    // 独立配比
    h += '<div class="card"><b>美股组合配比</b> <span class="muted small">独立滑块，与 A股/港股组合分开计算（默认 40/35/20/5）</span><div class="grid4 sliders">';
    for (var k2 = 0; k2 < US_KEYS.length; k2++) {
      var kk = US_KEYS[k2];
      h += '<div><label><span class="dot" style="background:' + CAT[kk].color + '"></span>' + CAT[kk].label + ' <b id="uav-' + kk + '">' + US_ALLOC[kk] + '%</b></label>' +
        '<input type="range" min="0" max="60" step="5" value="' + US_ALLOC[kk] + '" oninput="window._setUA(\'' + kk + '\', this.value)"></div>';
    }
    h += '</div></div>';
    h += '<div class="grid2"><div class="card"><h3>配置结构</h3><div id="us-donut"></div></div><div class="card"><h3>组合明细（每象限取综合分前2名等权）</h3><div id="us-detail"></div></div></div>';

    // 标的池全表
    h += '<div class="card"><h3>美股标的池（' + US.length + ' 只）</h3>' +
      '<div class="btnrow" style="margin-bottom:8px">' +
      '<select onchange="window._usView(\'cat\', this.value)">' +
      opt("all", "全部象限", US_VIEW.cat) + opt("steady", "稳增长", US_VIEW.cat) + opt("growth", "高增长", US_VIEW.cat) +
      opt("rotate", "热点轮动", US_VIEW.cat) + opt("tenx", "十倍空间", US_VIEW.cat) + '</select>' +
      '<select onchange="window._usView(\'sort\', this.value)">' +
      opt("comp", "按综合分", US_VIEW.sort) + opt("pos52", "按52周位置(低→高)", US_VIEW.sort) +
      opt("pe", "按PE(低→高)", US_VIEW.sort) + opt("ytd", "按年内涨幅", US_VIEW.sort) + opt("div", "按股息率", US_VIEW.sort) + '</select>' +
      '</div><div id="us-table"></div>' +
      '<div class="muted small" style="margin-top:8px">鼠标悬停（手机长按）可查看该标的的护城河与风险说明。PE/EPS 为 TTM 口径；52周位置=现价在 52 周高低区间中的百分位（0=最低、100=最高），是价格位置的描述，<b>不等同于估值分位</b>；美股暂缺历史 PE 分位（数据源限制），估值信号用「当前 PE vs 合理 PE 带」+「52 周位置 &gt;90% 视为偏高」双重判断；合理 PE 带与参考价区间为模型假设。</div></div>';

    h += '<div class="card verdict"><b>美股组合思路：</b>美股与 A股/港股相关性低，用于分散单一市场风险。底仓配现金流稳定的分红与低估值资产，进攻端配 AI 与云产业链核心资产；' +
      '十倍空间类波动极大（年化波动 50%~96%），仅用"输得起"的仓位。注意：美股股息一般需缴 30% 预扣税，且存在汇率与交易时段（北京时间 21:30~04:00）差异。</div>';
    h += '<div class="muted small">' + window.DISCLAIMER + '</div>';
    $("us-body").innerHTML = h;
    usRenderTable();
    drawUsAlloc();
  }
  window._setUA = function (k, v) { US_ALLOC[k] = Number(v); $("uav-" + k).textContent = v + "%"; drawUsAlloc(); };
  function drawUsAlloc() {
    var sum = US_ALLOC.steady + US_ALLOC.growth + US_ALLOC.rotate + US_ALLOC.tenx;
    var wsum = 0, wpe = 0, wdiv = 0, wcomp = 0, held = 0, wpeSum = 0, detail = "", acc = 0;
    var donut = '<svg viewBox="0 0 200 200" width="100%" style="max-width:280px">';
    for (var i = 0; i < US_KEYS.length; i++) {
      var k = US_KEYS[i];
      var share = sum > 0 ? US_ALLOC[k] / sum : 0;
      var members = US.filter(function (s) { return s.cat.indexOf(k) >= 0; })
        .sort(function (a, b) { return composite(b, W) - composite(a, W); }).slice(0, 2);
      if (members.length && share > 0) {
        var mPE = 0, mDiv = 0, mC = 0, peCnt = 0, cnt = members.length, eachW = share * 100 / cnt;
        for (var m = 0; m < members.length; m++) {
          var s = members[m];
          if (s.pe && s.pe > 0) { mPE += s.pe; peCnt++; }
          mDiv += (s.div || 0); mC += composite(s, W);
          detail += '<div class="pline"><span class="dot" style="background:' + CAT[k].color + '"></span><b>' + esc(s.name) + '</b>' +
            '<span class="muted small"> ' + usSym(s) + '</span><span class="right muted">权重 ' + pct(eachW, 1) + ' · PE ' + num(s.pe, 1) + ' · 股息 ' + (s.div == null ? "—" : pct(s.div, 1)) + '</span></div>';
        }
        wpe += (peCnt > 0 ? mPE / peCnt : 0) * share; if (peCnt > 0) wpeSum += share;
        wdiv += (mDiv / cnt) * share; wcomp += (mC / cnt) * share;
        wsum += share; held += cnt;
      }
      var dash = share * 100 * 2.51327;
      donut += '<circle cx="100" cy="100" r="40" fill="none" stroke="' + CAT[k].color + '" stroke-width="26" stroke-dasharray="' + dash.toFixed(2) + ' 999" transform="rotate(' + (acc * 360 - 90).toFixed(1) + ' 100 100)"/>';
      acc += share;
    }
    donut += '<text x="100" y="96" text-anchor="middle" font-size="13" fill="#5b6472">组合加权</text>';
    donut += '<text x="100" y="116" text-anchor="middle" font-size="18" font-weight="bold" fill="#1c2333">股息 ' + wdiv.toFixed(2) + '%</text></svg>';
    var meta = '<div class="kv kvg k2" style="margin-top:8px"><div class="muted">权重合计</div><div><b>' + num(wsum * 100, 1) + '%</b></div>' +
      '<div class="muted">持仓只数</div><div><b>' + held + ' 只</b></div>' +
      '<div class="muted">加权 PE（有效样本）</div><div><b>' + (wpeSum > 0 ? num(wpe / wpeSum, 1) : "—") + '</b></div>' +
      '<div class="muted">加权股息率</div><div><b>' + num(wdiv / Math.max(0.01, wsum), 2) + '%</b></div>' +
      '<div class="muted">加权综合分</div><div><b>' + num(wcomp / Math.max(0.01, wsum), 2) + '</b></div>' +
      '<div class="muted">覆盖象限数</div><div><b>' + (wsum > 0 ? US_KEYS.filter(function (k) { return US_ALLOC[k] > 0 && US.some(function (s) { return s.cat.indexOf(k) >= 0; }); }).length : 0) + ' / 4</b></div></div>';
    var dEl = $("us-donut"), pEl = $("us-detail");
    if (dEl) dEl.innerHTML = donut + meta;
    if (pEl) pEl.innerHTML = detail || '<div class="muted">请调高至少一个象限的配比</div>';
  }

  // ============================================================
  // ---------- 整体投顾组合（资产配置层） ----------
  // 四模块：红利（低估买/高估卖，30%~50%）· 纳斯达克定投（20%）· 货币/弹药（20%起）· 巴菲特式股票（10%）
  // ============================================================
  var A = window.ASSET || null;
  var TGOAL = { lo: 10, hi: 20 };             // 目标年化区间
  // 目标达成模式：在用户给定框架内调整「货币下限 / 红利上限」，用来观察年化目标的可达性
  var PLAN_MODE = "std";
  var PLAN_MODES = {
    std: { t: "标准（按您给的框架：货币 20% 起）", d: "红利按股息率在 30%~50% 浮动，货币吸收差额（20%~40%）" },
    agg: { t: "进取（货币下限降到 10%）", d: "把闲置弹药压到 10%，多出来的仓位加到红利（至上限 50%）与纳指，提升收益、加大波动" },
    def: { t: "保守（红利上限 40%）", d: "红利最多 40%，其余放货币，牺牲部分收益换取更低回撤" }
  };
  window._setPlanMode = function (v) { PLAN_MODE = PLAN_MODES[v] ? v : "std"; renderPlan(); };
  function applyMode(w) {
    if (PLAN_MODE === "agg") {
      var ex = w.cash - 10;
      if (ex > 0) { var toDiv = Math.min(ex, 50 - w.div); w.div += toDiv; ex -= toDiv; w.nas += ex; w.cash = 10; }
    } else if (PLAN_MODE === "def") {
      var ex2 = w.div - 40;
      if (ex2 > 0) { w.div -= ex2; w.cash += ex2; }
    }
  }
  // 股息率档位改为「利差锚」：利差 = 股息率 − 10年国债收益率（单位 pp）。
  // 为什么不用绝对股息率：利率环境变了，同一个 4.28% 的吸引力完全不同 ——
  // 国债 1.75% 时利差 2.53pp 很有吸引力，国债若升到 3% 时只剩 1.28pp，绝对档位却还给同样仓位。
  // 档位阈值按当前利率环境（国债≈1.75%）+ 历史红利股息率区间（3.5%~4.6%）标定，后续可用历史利差分布再校准。
  var DIV_LADDER = [
    [3.5, 5, "利差极宽 · 重仓买入", 50, "v1"],
    [3.0, 4, "利差显著 · 加仓", 47, "v1"],
    [2.5, 3, "利差偏宽 · 小幅加仓", 44, "v2"],
    [2.0, 2, "利差中性 · 标准仓", 40, "v3"],
    [1.5, 1, "利差收窄 · 降至底仓上方", 35, "v4"],
    [1.0, 0, "利差偏窄 · 分批减仓", 32, "v5"],
    [-99, -1, "利差极窄 · 只留底仓", 30, "v5"]
  ];
  // 纳斯达克 PE 档位：PE 越低＝越便宜＝定投倍数越高（阈值 / 等级 / 标签 / 定投倍数 / 样式）
  var NAS_LADDER = [
    [24, 3, "显著低估 · 加倍定投", 2.0, "v1"],
    [27, 2, "偏低估 · 1.5 倍定投", 1.5, "v2"],
    [32, 1, "合理 · 标准定投", 1.0, "v3"],
    [36, 0, "偏高 · 减半定投 + 分批止盈", 0.5, "v4"],
    [1e9, -1, "高估 · 停止定投 + 分批止盈", 0.0, "v5"]
  ];
  function divLevel(spread) {
    if (spread == null || !isFinite(spread)) return { lv: 2, label: "数据缺失", w: 40, cls: "v-na" };
    for (var i = 0; i < DIV_LADDER.length; i++) {
      if (spread >= DIV_LADDER[i][0]) return { lv: DIV_LADDER[i][1], label: DIV_LADDER[i][2], w: DIV_LADDER[i][3], cls: DIV_LADDER[i][4] };
    }
    return { lv: 2, label: "利差中性 · 标准仓", w: 40, cls: "v3" };
  }
  function nasLevel(pe) {
    if (pe == null || !isFinite(pe)) return { lv: 1, label: "数据缺失", mult: 1, cls: "v-na" };
    for (var i = 0; i < NAS_LADDER.length; i++) {
      if (pe < NAS_LADDER[i][0]) return { lv: NAS_LADDER[i][1], label: NAS_LADDER[i][2], mult: NAS_LADDER[i][3], cls: NAS_LADDER[i][4] };
    }
    return { lv: 1, label: "合理 · 标准定投", mult: 1, cls: "v3" };
  }
  // ---------- 加仓增量（分标的：只有回测有效的技术信号才真的加仓，0 = 仅观察）----------
  // 依据 data/divbt.js 6 年周线回测：
  //  - 中证红利：「跌破年线」−0.30pp（偏弱）、RSI 超卖无回测证据 → 均不加仓，只保留「周线 BOLL 下轨以下 +5pp」；
  //  - 红利低波：「跌破年线 +4.73pp」「RSI(14)<30 +4.41pp」均有效 → 保留 +3pp / +2pp。
  var DIV_ADD = {
    csi: { ma250: 0, rsi: 0, wklow: 5 },
    lowvol: { ma250: 3, rsi: 2, wklow: 5 }
  };
  var DIV_CAP = 50, DIV_FLOOR = 30;   // 红利总仓上限 / 底仓

  // ---------- 卖出 / 止盈研究层（2026-10-09 回测结论：不采纳为执行规则）----------
  // 回测（backtest-sell.js：000922 17.7y / 510880 12.8y / 512890 6.9y）两件事：
  //   · 信号层面是有效的：年线上方 5%~8% 之后 3~6 个月跑输随机基准 2~7pp，26 周内可回补概率 69%~87%（均深 −7%~−9%）；
  //   · 但组合层面不成立：相对「只买不卖」年化 −0.13~−1.47pp，唯一的收益是回撤改善 +0.25~+1.86pp。
  // 用户口径是「有效的止盈策略才采纳」→ 对收益没有改善，因此不写入页面执行规则，
  // 只在「📈 回测 → 红利策略回测（买入 + 卖出）」里保留完整研究记录。
  // 减仓仍然靠第一层机制：利差档位（价涨 → 股息率降 → 利差收窄 → 档位降 → 仓位降，最低 30% 底仓）。
  var TRIM_ADOPTED = false;           // false = 止盈只作观察/研究，不参与 planState 的仓位计算
  var TRIM_RULE = {
    t1Cheap: 12, t1Mid: 8, t1Rich: 5,   // 浮仓止盈阈值：利差≥3.0pp(便宜) / 2.0~3.0(中性) / <2.0(偏贵)
    backRatio: 0.4, minBack: 2,         // 回补阈值 = t1×0.4（迟滞，避免在阈值附近反复）
    core: 30, core2: 20,                // 浮仓止盈只留底仓 30%；底仓止盈降到 20%
    t2Delta: 8, t2BackRatio: 0.45       // 底仓止盈阈值 = t1+8%，回补 = ×0.45
  };
  var TRIM_STATE = { csi: null, lowvol: null };
  function trimLevel(key, d, spread) {
    if (!d || d.distMA250 == null) return { lv: 0, t1: null, t2: null, back: null, hot: false, reason: "年线数据缺失" };
    var t1 = spread >= 3.0 ? TRIM_RULE.t1Cheap : (spread >= 2.0 ? TRIM_RULE.t1Mid : TRIM_RULE.t1Rich);
    var t2 = t1 + TRIM_RULE.t2Delta;
    var back = Math.max(TRIM_RULE.minBack, Math.round(t1 * TRIM_RULE.backRatio));
    var back2 = Math.round(t2 * TRIM_RULE.t2BackRatio);
    var hot = (d.wk && d.px != null && d.px >= d.wk.upper) || (d.rsi14 != null && d.rsi14 > 70);
    var dm = d.distMA250, lv;
    if (TRIM_STATE[key] == null) lv = (dm >= t2 && hot) ? 2 : (dm >= t1 ? 1 : 0);
    else {
      lv = TRIM_STATE[key];
      if (dm >= t2 && hot) lv = 2;                     // 过热确认 → 底仓止盈
      else if (dm >= t1) lv = 1;                       // 年线上方够高（但没过热/不够 t2）→ 浮仓止盈
      else if (dm <= back) lv = 0;                     // 跌回回补线 → 解除，按档位买回
      // back ~ t1 之间为迟滞区，维持上一状态，避免价格抖动导致反复买卖
    }
    TRIM_STATE[key] = lv;
    var distText = dm >= t2 ? "已在底仓止盈区（≥+" + t2 + "%）" :
      (dm >= t1 ? "已在浮仓止盈区（≥+" + t1 + "%）" :
        (dm > back ? "距浮仓止盈还需涨 " + pct(t1 - dm, 1) : "距浮仓止盈还需涨 " + pct(t1 - dm, 1) + "（回补线 +" + back + "%，已在线下待回补）"));
    return {
      lv: lv, t1: t1, t2: t2, back: back, back2: back2, hot: hot, distMA: dm, distText: distText,
      now: "年线 " + (d.ma250 != null ? num(d.ma250, d.ma250 < 10 ? 3 : 0) : "—") + " · 现价高出 " + pct(dm, 1) + "（阈值 +" + t1 + "%）",
      hotText: (d.wk && d.px != null ? (d.px >= d.wk.upper ? "周线 BOLL 上轨以上 ✓" : "周线上轨还需涨 " + pct((d.wk.upper / d.px - 1) * 100, 1)) : "—") +
        (d.rsi14 != null ? " · RSI " + num(d.rsi14, 0) + (d.rsi14 > 70 ? " ✓超买" : "") : "")
    };
  }

  // 单个红利指数的技术面信号（52周线 / RSI / 周线BOLL）
  function divTech(d) {
    var out = [];
    out.push({
      key: "ma250", name: "收盘价跌破 52 周线（年线）",
      ok: d.distMA250 != null && d.distMA250 <= 0,
      now: (d.px != null ? num(d.px, d.px < 10 ? 3 : 2) : "—") + " vs 年线 " + (d.ma250 != null ? num(d.ma250, d.ma250 < 10 ? 3 : 2) : "—"),
      dist: d.distMA250 == null ? null : Math.abs(d.distMA250),
      distText: d.distMA250 == null ? "—" : (d.distMA250 <= 0 ? "已在线下 " + pct(-d.distMA250, 1) : "需再跌 " + pct(d.distMA250, 1))
    });
    if (d.rsi14 != null) {
      out.push({
        key: "rsi", name: "RSI(14) 跌破 30（超卖）",
        ok: d.rsi14 <= 30, now: "RSI " + num(d.rsi14, 1),
        dist: (d.rsi30 && d.rsi30.distPct != null) ? Math.abs(d.rsi30.distPct) : null,
        distText: d.rsi14 <= 30 ? "已触发" :
          ((d.rsi30 && d.rsi30.price != null) ? "经验触发价约 " + num(d.rsi30.price, d.rsi30.price < 10 ? 3 : 0) + "（再跌 " + pct(-d.rsi30.distPct, 1) + "）" : "距 30 尚远")
      });
    }
    if (d.wk) {
      out.push({
        key: "wkmid", name: "周线 BOLL 中轨以下（开始提醒）",
        ok: d.distWkMid != null && d.distWkMid <= 0, now: "中轨 " + num(d.wk.mid, d.wk.mid < 10 ? 3 : 0),
        dist: d.distWkMid == null ? null : Math.abs(d.distWkMid),
        distText: d.distWkMid == null ? "—" : (d.distWkMid <= 0 ? "已在中轨下方 " + pct(-d.distWkMid, 1) : "需再跌 " + pct(d.distWkMid, 1))
      });
      out.push({
        key: "wklow", name: "周线 BOLL 下轨以下（重度提醒）",
        ok: d.distWkLow != null && d.distWkLow <= 0, now: "下轨 " + num(d.wk.lower, d.wk.lower < 10 ? 3 : 0),
        dist: d.distWkLow == null ? null : Math.abs(d.distWkLow),
        distText: d.distWkLow == null ? "—" : (d.distWkLow <= 0 ? "已在下轨下方 " + pct(-d.distWkLow, 1) : "需再跌 " + pct(d.distWkLow, 1))
      });
    }
    out.push({
      key: "wkup", name: "周 K 线向上（本周收阳 / 走平）",
      ok: d.wkUp === true, now: d.wkUp ? "本周收阳（或走平）" : "本周收阴",
      dist: null, distText: d.wkUp ? "已满足" : "待本周收盘确认"
    });
    return out;
  }
  // 综合出「整体投顾」的当前建议权重
  function planState() {
    if (!A) return null;
    var csi = A.dividend.csi, lv = A.dividend.lowvol;
    var bondY = (A.bond10y && A.bond10y.v != null) ? A.bond10y.v : 1.75;
    var spreadC = csi.dy - bondY, spreadL = lv.dy - bondY;
    var lc = divLevel(spreadC), ll = divLevel(spreadL);
    var base = Math.round((lc.w + ll.w) / 2);
    var tc = divTech(csi), tl = divTech(lv);
    // 技术面叠加（上限 50），按 6 年回测分标的差异化：
    //  - 中证红利「跌破年线」回测 -0.30pp（偏弱）、RSI 无回测证据 → 均不加仓，仅保留「周线 BOLL 下轨以下 +5pp」；
    //  - 红利低波「跌破年线 +4.73pp」「RSI +4.41pp」均有效 → 保留 +3pp / +2pp。
    // 注：周线 BOLL「中轨以下」已按回测结论降级为观察项，不再加仓（6 年 21 次触发、3 个月超额 −1.74pp）
    var add = 0, why = [];
    function scan(t, tag, key) {
      var opts = DIV_ADD[key] || {};
      for (var i = 0; i < t.length; i++) {
        var delta = opts[t[i].key] || 0;
        if (!t[i].ok || !delta) continue;
        add += delta; why.push(tag + t[i].name.replace(/（.*/, "") + " +" + delta + "pp");
      }
    }
    scan(tc, "中证红利 ", "csi");
    scan(tl, "红利低波 ", "lowvol");
    // 红利内部倾斜：利差档位高的多配（60/40），同档 50/50
    var tiltCsi = 50, tiltLv = 50;
    if (lc.lv > ll.lv) { tiltCsi = 60; tiltLv = 40; }
    else if (ll.lv > lc.lv) { tiltCsi = 40; tiltLv = 60; }
    // 卖出 / 止盈层：TRIM_ADOPTED=false 时只算不动（观察值仅用于页面一句话说明与回测页对照）
    var trC = trimLevel("csi", csi, spreadC), trL = trimLevel("lowvol", lv, spreadL);
    var cap = DIV_CAP, floor = DIV_FLOOR;
    if (TRIM_ADOPTED) {
      var capC = trC.lv === 2 ? TRIM_RULE.core2 : (trC.lv === 1 ? TRIM_RULE.core : DIV_CAP);
      var capL = trL.lv === 2 ? TRIM_RULE.core2 : (trL.lv === 1 ? TRIM_RULE.core : DIV_CAP);
      cap = Math.round((capC * tiltCsi + capL * tiltLv) / 100);
      floor = (trC.lv === 2 || trL.lv === 2) ? TRIM_RULE.core2 : DIV_FLOOR;
    }
    var raw = Math.max(DIV_FLOOR, Math.min(DIV_CAP, base + add));
    var wDiv = Math.max(floor, Math.min(cap, raw));
    var cut = Math.max(0, raw - wDiv);
    var wNas = 20, wStock = 10, wCash = 100 - wDiv - wNas - wStock;
    var nl = nasLevel(A.nasdaq.pe);
    var nasNote = "";
    if (A.nasdaq.distMA250 != null && A.nasdaq.distMA250 > 15 && A.nasdaq.rsi14 != null && A.nasdaq.rsi14 > 70) {
      nl = { lv: nl.lv, label: nl.label + "（技术过热，本期减半）", mult: nl.mult * 0.5, cls: nl.cls };
      nasNote = "价格高于年线 " + pct(A.nasdaq.distMA250, 1) + " 且 RSI " + num(A.nasdaq.rsi14, 0) + "，短期偏热 → 本期定投减半";
    } else if (A.nasdaq.distMA250 != null && A.nasdaq.distMA250 < -5 && A.nasdaq.rsi14 != null && A.nasdaq.rsi14 < 35) {
      nl = { lv: nl.lv, label: nl.label + "（技术超跌，本期加倍）", mult: nl.mult * 2, cls: nl.cls };
      nasNote = "价格低于年线 " + pct(-A.nasdaq.distMA250, 1) + " 且 RSI " + num(A.nasdaq.rsi14, 0) + "，短期超跌 → 本期定投加倍";
    }
    // 提醒清单
    var alerts = [];
    function pushAlerts(tag, t, keys, toneMap) {
      for (var i = 0; i < t.length; i++) {
        var c = t[i];
        if (keys && keys.indexOf(c.key) < 0) continue;
        var tm = (toneMap && toneMap[c.key]) || "";
        var tone = c.ok ? (tm === "heavy" ? "fire" : (tm === "watch" ? "watch" : "warn")) : (c.dist != null && c.dist <= 3 ? "near" : "idle");
        alerts.push({ tag: tag, name: c.name, ok: c.ok, now: c.now, dist: c.dist, distText: c.distText, tone: tone });
      }
    }
    pushAlerts("中证红利", tc, ["ma250", "wkmid", "wklow"], { wklow: "heavy", wkmid: "watch" });
    pushAlerts("红利低波", tl, ["ma250", "rsi", "wkup"], {});
    pushAlerts("纳斯达克100", divTechNas(), ["ma250", "rsi"], {});
    // 注：止盈条目已移除 —— 回测显示技术止盈对年化没有改善（−0.1~−1.5pp），卖出完全交给利差档位
    return {
      csi: csi, lowvol: lv, lc: lc, ll: ll, tc: tc, tl: tl,
      w: { div: wDiv, nas: wNas, stock: wStock, cash: wCash },
      base: base, add: add, why: why, tilt: { csi: tiltCsi, lowvol: tiltLv },
      trim: { csi: trC, lowvol: trL, cap: cap, floor: floor, raw: raw, cut: cut },
      nas: A.nasdaq, nasLv: nl, nasNote: nasNote, alerts: alerts
    };
  }
  function divTechNas() {
    var n = A.nasdaq;
    return [
      { key: "ma250", name: "价格回落至年线附近（更好的定投位置）", ok: n.distMA250 != null && n.distMA250 <= 0,
        now: (n.px != null ? num(n.px, 2) : "—") + " vs 年线 " + (n.ma250 != null ? num(n.ma250, 2) : "—"),
        dist: n.distMA250 == null ? null : Math.abs(n.distMA250),
        distText: n.distMA250 == null ? "—" : (n.distMA250 <= 0 ? "已在年线下方 " + pct(-n.distMA250, 1) : "高于年线 " + pct(n.distMA250, 1)) },
      { key: "rsi", name: "RSI(14) 跌破 30（超卖，加倍定投机会）", ok: n.rsi14 != null && n.rsi14 <= 30,
        now: "RSI " + num(n.rsi14, 1),
        dist: (n.rsi30 && n.rsi30.distPct != null) ? Math.abs(n.rsi30.distPct) : null,
        distText: n.rsi14 != null && n.rsi14 <= 30 ? "已触发" : ((n.rsi30 && n.rsi30.price != null) ? "经验触发价约 " + num(n.rsi30.price, 0) + "（再跌 " + pct(-n.rsi30.distPct, 1) + "）" : "距 30 尚远") }
    ];
  }
  function alertTone(t) {
    if (t.tone === "fire") return { c: "v5", s: "重度提醒 · 已触发" };
    if (t.tone === "watch") return { c: "v-na", s: "观察 · 不作为加仓依据" };
    if (t.tone === "warn") return { c: "v4", s: "提醒 · 已触发" };
    if (t.tone === "near") return { c: "v2", s: "临近触发" };
    return { c: "v-na", s: "未触发" };
  }
  // 止盈层的原因描述（TRIM_ADOPTED=false 时仅作研究记录，不参与仓位）
  function trimWhy(t) {
    if (!t) return "—";
    if (!TRIM_ADOPTED) return "止盈层未采纳（回测：年化 −0.1~−1.5pp，对收益无改善），卖出交给利差档位";
    var out = [];
    if (t.csi.lv >= 1) out.push("中证红利" + (t.csi.lv === 2 ? "底仓止盈" : "浮仓止盈") + "（年线上方 " + pct(t.csi.distMA, 1) + " ≥ +" + t.csi.t1 + "%）");
    if (t.lowvol.lv >= 1) out.push("红利低波" + (t.lowvol.lv === 2 ? "底仓止盈" : "浮仓止盈") + "（年线上方 " + pct(t.lowvol.distMA, 1) + " ≥ +" + t.lowvol.t1 + "%）");
    return out.length ? out.join("、") : "未触发";
  }
  // 暴露给自检脚本（sell-check.js）
  window._TRIM_RULE = TRIM_RULE;
  window._TRIM_ADOPTED = TRIM_ADOPTED;
  window._DIV_ADD = DIV_ADD;
  window._addPlanRows = addPlanRows;
  window._TRIM_STATE = TRIM_STATE;
  window._trimLevel = trimLevel;
  window._trimWhy = trimWhy;
  window._planState = planState;
  // ---- 名单归档钩子（gen-baseline.js 每日 18:00 调用，用于「名单变动」对比基线）----
  window._picksExpose = picks;                          // 每日推荐四象限名单
  window._stockPickListExpose = stockPickList;          // 正式名单（建仓节奏 ③ 股票端）
  window._usPicksExpose = usPicks;                       // 美股四象限名单
  // 单只标的的选股体检（用于生成「移出原因」：距买点 / 三大前提 / 门槛分）
  window._stockAuditExpose = function (code) {
    var s = byCode(code);
    if (!s) return { exists: false };
    var r = targetRange(s, s.fairPE ? s.fairPE[0] : (s.fairPB ? s.fairPB[0] : 10), s.fairPE ? s.fairPE[1] : (s.fairPB ? s.fairPB[1] : 15));
    var buy = r ? (r.buyOverride != null ? r.buyOverride : (r.mid > 0 ? r.mid * (1 - STK_MOS / 100) : null)) : null;
    var dist = (buy > 0 && s.px > 0) ? (s.px / buy - 1) * 100 : null;
    var catKey = s.cat.indexOf("tenx") >= 0 ? "tenx" : (s.cat.indexOf("growth") >= 0 ? "growth" : (s.cat.indexOf("rotate") >= 0 ? "rotate" : "steady"));
    return { exists: true, name: s.name, score: composite(s, W), moat: s.moat, quality: s.quality, dist: dist, premise: ltPremise(s), catKey: catKey };
  };
  function planDonut(w) {
    var seg = [
      { k: "红利资产", v: w.div, c: "#d92c2c" },
      { k: "纳斯达克", v: w.nas, c: "#1d4ed8" },
      { k: "货币/现金流", v: w.cash, c: "#0a8f4e" },
      { k: "巴菲特股票", v: w.stock, c: "#d97706" }
    ];
    var s = '<svg viewBox="0 0 200 200" width="100%" style="max-width:280px">', acc = 0, tot = 0;
    for (var i = 0; i < seg.length; i++) tot += seg[i].v;
    for (var j = 0; j < seg.length; j++) {
      var sh = tot > 0 ? seg[j].v / tot : 0;
      s += '<circle cx="100" cy="100" r="40" fill="none" stroke="' + seg[j].c + '" stroke-width="26" stroke-dasharray="' + (sh * 100 * 2.51327).toFixed(2) + ' 999" transform="rotate(' + (acc * 360 - 90).toFixed(1) + ' 100 100)"/>';
      acc += sh;
    }
    s += '<text x="100" y="96" text-anchor="middle" font-size="13" fill="#5b6472">长期目标</text>';
    s += '<text x="100" y="118" text-anchor="middle" font-size="20" font-weight="bold" fill="#1c2333">' + TGOAL.lo + '~' + TGOAL.hi + '%</text></svg>';
    var legend = '<div class="kv kvg k2" style="margin-top:8px">';
    for (var m = 0; m < seg.length; m++) legend += '<div><span class="dot" style="background:' + seg[m].c + '"></span>' + seg[m].k + '</div><div><b>' + seg[m].v + '%</b></div>';
    legend += '</div>';
    return s + legend;
  }
  function condRow(c) {
    var tone = c.ok ? "tag-ok" : (c.dist != null && c.dist <= 3 ? "tag-warn" : "tag-flat");
    return '<div class="' + tone + '" style="margin-top:6px;font-size:12.5px"><b>' + (c.ok ? "✅" : "⬜") + ' ' + esc(c.name) + '</b>' +
      '<div class="muted small">当前：' + esc(c.now) + ' · ' + (c.ok ? "已触发" : "距离：" + esc(c.distText)) + '</div></div>';
  }
  // ---------- 红利：两个标的表现对比 + 「什么时候加仓、加多少」 ----------
  // 月K（前复权含分红再投，36 个月）算出的表现指标，用来区分中证红利与红利低波的性格差异
  function divPerf(key) {
    var arr = A && A.kline ? A.kline[key] : null;
    if (!arr || arr.length < 14) return null;
    var n = arr.length, m = seriesMetrics(arr);
    return { ret1y: (arr[n - 1] / arr[n - 13] - 1) * 100, cagr: m.cagr, mdd: m.mdd, vol: m.vol, total: m.total };
  }
  // 加仓触发表：把「档位升级」与「技术信号」写成可执行的两类行
  function addPlanRows(key, d, lv, tech) {
    var bondY = A.bond10y.v, spread = d.dy - bondY, rows = [], i;
    // 两类触发的性质不同，金额必须都折算成「对红利总仓的贡献」才能横向比较：
    //  · 档位升档 = 常态仓位中枢抬升（该标的档位仓 +Npp，总仓 = 两标的均值 → 只贡献 N/2）
    //  · 技术信号 = 时机性加仓（全额加到总仓，回补后可撤回）
    // 所以「需再跌更多却加得更少」不是算错，而是性质不同；表按「需再跌 %」从小到大排，先触发的在上面。
    function etfRef(dropPct) {
      // 中证红利(000922 指数点位) / 红利低波(以 512890 现价代指) → 都用「需再跌 %」折算成各 ETF 的参考价
      var list = (window.DIV_ETF && window.DIV_ETF[key]) || null;
      if (!list || dropPct == null) return "";
      var s = [];
      for (var j = 0; j < list.length; j++) {
        s.push(list[j].code + " 约 " + num(list[j].px * (1 + dropPct / 100), 3));
      }
      return '<br><span class="muted">对应 ETF：' + esc(s.join(" / ")) + '</span>';
    }
    // ① 利差档位升级：利差每上一档，该标的档位仓抬升；红利总仓取两标的平均，所以对总仓的贡献约为增量的一半
    var ups = [];
    for (i = 0; i < DIV_LADDER.length; i++) {
      var th = DIV_LADDER[i][0], w = DIV_LADDER[i][3];
      if (w > lv.w && th > spread) ups.push({ th: th, w: w });
    }
    ups.sort(function (a, b) { return a.th - b.th; });
    ups = ups.slice(0, 3);
    for (i = 0; i < ups.length; i++) {
      var t = ups[i], dyT = t.th + bondY;
      var pxT = d.px * d.dy / dyT;                      // 分红不变假设下，股息率升到目标值对应的价格
      var dW = t.w - lv.w, dTot = dW / 2;                // 总仓 = 两标的档位仓均值 → 单标的的增量只贡献一半
      rows.push({
        kind: "ladder",
        trig: "利差升到 <b>≥" + num(t.th, 1) + "pp</b>（股息率 ≥" + pct(dyT, 2) + "）",
        how: "触发价约 <b>" + num(pxT, d.px < 10 ? 3 : 0) + "</b>（需再跌 " + pct(-drop1(pxT, d.px), 1) + "）" +
          etfRef(drop1(pxT, d.px)) +
          "<br><span class=\"muted\">或 10 年国债降到 " + pct(bondY - (t.th - spread), 2) + "</span>",
        add: "该标的档位仓 <b>" + lv.w + "% → " + t.w + "%</b>（+" + dW + "pp）" +
          '<br><span class="muted">常态抬升 · 对总仓只贡献一半</span>',
        amt: "总仓 <b>+" + num(dTot, 1) + "pp</b> ≈ <b>" + Math.round(dTot * 10000).toLocaleString() + " 元</b>",
        now: "当前利差 " + num(spread, 2) + "pp，还差 " + num(t.th - spread, 2) + "pp",
        _tot: dTot, _own: dW, _dist: Math.abs(drop1(pxT, d.px))
      });
    }
    // ② 技术信号：只有回测有效（DIV_ADD 里给了增量）的才列出
    var mp = DIV_ADD[key] || {};
    for (i = 0; i < tech.length; i++) {
      var c = tech[i], delta = mp[c.key] || 0;
      if (!delta) continue;
      var px2 = null;
      if (c.key === "ma250" && d.ma250 != null) px2 = d.ma250;
      else if (c.key === "rsi" && d.rsi30 && d.rsi30.price != null) px2 = d.rsi30.price;
      else if (c.key === "wklow" && d.wk) px2 = d.wk.lower;
      var how;
      if (c.key === "rsi" && px2 != null) {
        how = "触发价 <b>" + num(px2, d.px < 10 ? 3 : 0) + "</b><span class=\"muted\">（历史经验估算，需再跌 " +
          pct(-(d.rsi30 && d.rsi30.distPct != null ? d.rsi30.distPct : 0), 1) + "）</span>" + etfRef(d.rsi30 ? d.rsi30.distPct : null);
      } else {
        how = (px2 != null ? "触发价 <b>" + num(px2, d.px < 10 ? 3 : 0) + "</b><span class=\"muted\">（" : "<span class=\"muted\">（") + esc(c.distText) + "）</span>" +
          (px2 != null ? etfRef((px2 / d.px - 1) * 100) : "");
      }
      rows.push({
        kind: "tech",
        trig: esc(c.name.replace(/（.*/, "")) + " <span class=\"muted\">→ +" + delta + "pp</span>",
        how: how,
        add: "该标的 <b>+" + delta + "pp</b>" +
          '<br><span class="muted">时机性加仓 · 全额加到总仓</span>',
        amt: "总仓 <b>+" + delta + "pp</b> ≈ <b>" + (delta * 10000).toLocaleString() + " 元</b>",
        now: c.ok ? "已触发" : esc(c.distText),
        _tot: delta, _own: delta, _dist: c.ok ? 0 : (c.dist == null ? null : c.dist)
      });
    }
    // 按「还需下跌 %」从小到大排：先触发的排在上面，读起来才不会像「跌得多反而加得少」
    rows.sort(function (a, b) {
      if (a._dist == null && b._dist == null) return 0;
      if (a._dist == null) return 1;
      if (b._dist == null) return -1;
      return a._dist - b._dist;
    });
    return rows;
  }
  function drop1(pxT, px) { return (pxT / px - 1) * 100; }
  // 中证红利 vs 红利低波：表现 / 估值 / 利差 / 技术 / 配置 的横向对比（两个标的的性格差别很大，不能合并成"一个红利"看）
  function divCompareCard(P) {
    if (!A || !A.kline) return "";
    var c = P.csi, l = P.lowvol, bondY = A.bond10y.v, wDiv = P.w.div;
    var pc = divPerf("csi"), pl = divPerf("lowvol");
    var sc = c.dy - bondY, sl = l.dy - bondY;
    var rows = [], g;
    function R(label, aTxt, aV, bTxt, bV, mode) { rows.push({ g: g, label: label, a: { t: aTxt, v: aV }, b: { t: bTxt, v: bV }, mode: mode }); }
    function sgn(v) { return v == null ? "—" : (v > 0 ? "+" : "") + num(v, 1) + "%"; }
    function col(v, txt, d) { return v == null ? txt : '<span class="' + cls(v) + '">' + txt + '</span>'; }
    function amt(t) { return Math.round(wDiv * t / 100 * 10000).toLocaleString() + " 元"; }
    g = "表现（近 3 年月 K，前复权含分红再投）";
    R("现价", num(c.px, c.px < 10 ? 3 : 2), null, num(l.px, l.px < 10 ? 3 : 2), null, null);
    R("今日涨跌", col(c.chg, (c.chg > 0 ? "+" : "") + pct(c.chg, 2)), null, col(l.chg, (l.chg > 0 ? "+" : "") + pct(l.chg, 2)), null, null);
    R("近 1 年涨幅", pc ? col(pc.ret1y, sgn(pc.ret1y)) : "—", pc ? pc.ret1y : null, pl ? col(pl.ret1y, sgn(pl.ret1y)) : "—", pl ? pl.ret1y : null, "hi");
    R("近 3 年年化", pc ? col(pc.cagr, sgn(pc.cagr)) : "—", pc ? pc.cagr : null, pl ? col(pl.cagr, sgn(pl.cagr)) : "—", pl ? pl.cagr : null, "hi");
    R("近 3 年最大回撤", pc ? col(pc.mdd, sgn(pc.mdd)) : "—", pc ? pc.mdd : null, pl ? col(pl.mdd, sgn(pl.mdd)) : "—", pl ? pl.mdd : null, "hi");
    R("年化波动", pc ? num(pc.vol, 1) + "%" : "—", pc ? pc.vol : null, pl ? num(pl.vol, 1) + "%" : "—", pl ? pl.vol : null, "lo");
    g = "估值与利差（决定仓位）";
    R("PE-TTM", num(c.pe, 2) + " 倍", c.pe, num(l.pe, 2) + " 倍", l.pe, "lo");
    R("股息率（TTM）", pct(c.dy, 2), c.dy, pct(l.dy, 2), l.dy, "hi");
    R("股息率近 3 年分位", (c.dyPct == null ? "—" : pct(c.dyPct, 0) + "（越贵越低）"), c.dyPct, (l.dyPct == null ? "—" : pct(l.dyPct, 0)), l.dyPct, "hi");
    R("利差（股息率 − 国债 " + pct(bondY, 2) + "）", "<b>" + num(sc, 2) + "pp</b>", sc, "<b>" + num(sl, 2) + "pp</b>", sl, "hi");
    R("利差档位 → 该标的档位仓", esc(P.lc.label) + " → <b>" + P.lc.w + "%</b>", P.lc.w, esc(P.ll.label) + " → <b>" + P.ll.w + "%</b>", P.ll.w, "hi");
    g = "技术位置（决定加仓时机）";
    R("距 52 周年线", (c.distMA250 == null ? "—" : (c.distMA250 > 0 ? "+" : "") + pct(c.distMA250, 1)), c.distMA250, (l.distMA250 == null ? "—" : (l.distMA250 > 0 ? "+" : "") + pct(l.distMA250, 1)), l.distMA250, "lo");
    R("RSI(14)", num(c.rsi14, 1), c.rsi14, num(l.rsi14, 1), l.rsi14, "lo");
    R("52 周位置", (c.pos52 == null ? "—" : pct(c.pos52, 0)), c.pos52, (l.pos52 == null ? "—" : pct(l.pos52, 0)), l.pos52, "lo");
    R("周线 BOLL 下轨（重度加仓触发价）", (c.wk ? num(c.wk.lower, c.px < 10 ? 3 : 0) + "（需再跌 " + pct(c.distWkLow, 1) + "）" : "—"), null, (l.wk ? num(l.wk.lower, l.px < 10 ? 3 : 0) + "（需再跌 " + pct(l.distWkLow, 1) + "）" : "—"), null, null);
    g = "配置（红利总仓 " + wDiv + "%）";
    R("红利内部倾斜", "<b>" + P.tilt.csi + "%</b>", P.tilt.csi, "<b>" + P.tilt.lowvol + "%</b>", P.tilt.lowvol, "hi");
    R("按 100 万总资产折算", amt(P.tilt.csi), null, amt(P.tilt.lowvol), null, null);
    R("当前加仓信号", (P.tc.filter(function (t) { return t.ok && (DIV_ADD.csi[t.key] || 0) > 0; }).length ? "有 → +" + P.tc.reduce(function (a, t) { return a + (t.ok ? (DIV_ADD.csi[t.key] || 0) : 0); }, 0) + "pp" : "无"), null,
      (P.tl.filter(function (t) { return t.ok && (DIV_ADD.lowvol[t.key] || 0) > 0; }).length ? "有 → +" + P.tl.reduce(function (a, t) { return a + (t.ok ? (DIV_ADD.lowvol[t.key] || 0) : 0); }, 0) + "pp" : "无"), null, null);

    var h = '<div class="card"><h3>中证红利 vs 红利低波 <span class="muted small">两个标的表现与利差不同 —— 分开看、分开配</span></h3>';
    h += '<div class="tbl-scroll"><table class="tbl tbl-stack"><thead><tr><th>维度</th><th>中证红利（000922 · 515080）</th><th>红利低波（H30269 · 512890）</th></tr></thead><tbody>';
    var lastG = "";
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.g !== lastG) { h += '<tr class="grp muted"><td colspan="3" style="background:#f7f8fa"><b>' + esc(r.g) + '</b></td></tr>'; lastG = r.g; }
      var mk = "", badge = '<span class="muted small"> ✓较优</span>';
      if (r.mode && r.a.v != null && r.b.v != null && Math.abs(r.a.v - r.b.v) > 1e-9) {
        var aWin = r.mode === "hi" ? (r.a.v > r.b.v) : (r.a.v < r.b.v);
        mk = aWin ? badge : "";
      } else if (r.mode) mk = "";
      var mkB = "";
      if (r.mode && r.a.v != null && r.b.v != null && Math.abs(r.a.v - r.b.v) > 1e-9) {
        var bWin = r.mode === "hi" ? (r.b.v > r.a.v) : (r.b.v < r.a.v);
        mkB = bWin ? badge : "";
      }
      h += '<tr><td class="small wrapcol" data-l="维度">' + esc(r.label) + '</td>' +
        '<td class="small" data-l="中证红利">' + r.a.t + mk + '</td>' +
        '<td class="small" data-l="红利低波">' + r.b.t + mkB + '</td></tr>';
    }
    h += '</tbody></table></div>';
    // 差异解读
    var firstPick = (c.dyPct == null || l.dyPct == null) ? "两个标的" : (c.dyPct >= l.dyPct ? "中证红利" : "红利低波");
    h += '<div class="note" style="margin-top:10px"><b>怎么读这张表 —— 两个标的不是一回事：</b><br>' +
      '① <b>同一个绝对股息率，含义可以完全相反。</b>中证红利 ' + pct(c.dy, 2) + ' 处在自己近 3 年 <b>' + pct(c.dyPct, 0) + '</b> 分位（相对自己便宜），红利低波 ' + pct(l.dy, 2) + ' 只在 <b>' + pct(l.dyPct, 0) + '</b> 分位（相对自己偏贵）—— 所以不能只比绝对股息率。<br>' +
      '② <b>决定仓位的是利差，不是股息率。</b>利差 ' + num(sc, 2) + 'pp vs ' + num(sl, 2) + 'pp（都扣掉国债 ' + pct(bondY, 2) + '），对应档位仓 ' + P.lc.w + '% / ' + P.ll.w + '%，红利总仓取两者均值 = <b>' + P.base + '%</b>。<br>' +
      '③ <b>性格不同：</b>近 3 年中证红利年化 ' + (pc ? sgn(pc.cagr) : "—") + '、最大回撤 ' + (pc ? sgn(pc.mdd) : "—") + '、波动 ' + (pc ? num(pc.vol, 1) : "—") + '%；红利低波年化 ' + (pl ? sgn(pl.cagr) : "—") + '、回撤 ' + (pl ? sgn(pl.mdd) : "—") + '、波动 ' + (pl ? num(pl.vol, 1) : "—") + '% —— ' +
      '低波用更小的波动/回撤换到了相近的收益，适合当压舱石；' + firstPick + '的股息率分位更高（相对自己更便宜），是这一轮加仓的第一顺位。<br>' +
      '④ <b>分开加仓：</b>谁的利差更宽、分位更低，就把红利内部的倾斜给它（当前 ' + P.tilt.csi + '% / ' + P.tilt.lowvol + '%，' + (P.tilt.csi === P.tilt.lowvol ? "两者同档 → 各一半" : "档位更高的一边多配 10pp") + '）。' +
      '两者<b>各自的买入触发价、加仓金额与减仓触发价见「🧭 整体投顾 → 红利资产」</b>（红利是重仓，提示放首页）。</div>';
    h += '<div class="muted small" style="margin-top:6px">✓较优 = 该维度上两个标的里更占优的一侧（年化/利差/分位越高越好；波动/回撤深度/PE/52周位置越低越好）。表现指标为近 3 年（36 个月）月 K 前复权口径、含分红再投，与长期持有的真实体感仍有差异（未扣费、未计税）。</div>';
    h += '</div>';
    return h;
  }
  // ---------- 单个红利标的卡片（「⚖️ 红利对比」页使用；整体投顾页只放摘要） ----------
  function divCard(P, key, d, lv, tech, tiltPct, extraNote) {
    var s = '<div class="card"><h3><span class="dot" style="background:#d92c2c"></span>' + esc(d.name) + '（' + esc(d.code) + '） <span class="muted small">建议占红利内部 ' + tiltPct + '%</span> ' +
      '<span class="vchip ' + lv.cls + '">' + esc(lv.label) + '</span></h3>';
    s += '<div class="kv kvg k4" style="margin:6px 0">' +
      kvRow("现价", num(d.px, d.px < 10 ? 3 : 2) + ' <span class="' + cls(d.chg) + ' small">' + (d.chg > 0 ? "+" : "") + pct(d.chg) + '</span>') +
      kvRow("股息率(TTM)", pct(d.dy, 2) + ' <span class="muted small">绝对水平（参考）</span>') +
      kvRow("利差(股息率−国债)", num(d.dy - A.bond10y.v, 2) + 'pp <span class="muted small">利差档位基准仓 ' + lv.w + '% · 国债 ' + pct(A.bond10y.v, 2) + '</span>') +
      kvRow("股息率分位（模型）", (d.dyPct == null ? "—" : pct(d.dyPct, 0)) + ' <span class="muted small">' + (d.dyPct == null ? "" : (d.dyPct >= 70 ? "偏便宜" : d.dyPct <= 30 ? "偏贵" : "中性")) + '</span>') +
      kvRow("近3年股息率区间", (d.dyStats ? num(d.dyStats.min, 2) + ' ~ ' + num(d.dyStats.max, 2) + '%' : "—")) +
      kvRow("52 周位置", (d.pos52 == null ? "—" : pct(d.pos52, 0))) +
      '</div>';
    s += '<div class="muted small" style="margin-top:8px"><b>买入触发条件（实时进度）</b></div>';
    for (var i = 0; i < tech.length; i++) s += condRow(tech[i]);
    // 加仓触发表：明确「什么时候加、加多少」
    var aRows = addPlanRows(key, d, lv, tech), rawW = P.trim.raw;
    s += '<div class="muted small" style="margin-top:12px"><b>什么时候加仓、加多少</b>（按 100 万总资产折算，钱从货币端划转）</div>';
    if (!aRows.length) {
      s += '<div class="muted small" style="margin-top:4px">该标的已在最高档（利差 ≥3.5pp、档位仓 50%），暂无进一步加仓触发 —— 等回落到下一档或技术信号出现再动。</div>';
    } else {
      s += '<div class="tbl-scroll"><table class="tbl tbl-stack" style="margin-top:4px"><thead><tr><th>触发条件</th><th>触发价（含 ETF 参考）</th><th>加仓幅度与性质</th><th>对红利总仓的贡献</th><th>当前距离</th></tr></thead><tbody>';
      for (var ai2 = 0; ai2 < aRows.length; ai2++) {
        var r = aRows[ai2];
        s += '<tr><td class="small wrapcol" data-l="触发条件">' + r.trig + '</td><td class="small wrapcol" data-l="触发价">' + r.how + '</td>' +
          '<td class="small wrapcol" data-l="加仓幅度与性质">' + r.add + '</td><td class="small" data-l="金额">' + r.amt + '</td><td class="small" data-l="当前距离">' + r.now + '</td></tr>';
      }
      s += '</tbody></table></div>';
      s += '<div class="muted small" style="margin-top:6px"><b>怎么读这张表：</b>已按「还需再跌多少」<b>从小到大</b>排 —— 最上面一条是<b>最先会触发</b>的。' +
        '两类触发性质不同，不能只看跌幅比大小：<b>档位升档</b>是估值驱动的仓位中枢抬升（该标的档位仓 +Npp，因总仓取两标的均值，<b>只贡献 N/2</b>）；' +
        '<b>技术信号</b>是时机性加仓（<b>全额加到总仓</b>，属于"跌出来的机会"，回补后可撤回）。所以"跌得多却加得少"是口径不同，不是算错。<br>' +
        '执行口径：当前红利总仓 <b>' + rawW + '%</b>，上限 50%（还剩 <b>' + (50 - rawW) + 'pp</b> 空间）；' +
        '多条同时触发时<b>按上表从上到下执行，叠加后封顶 50%</b>；单条触发分 2~3 批（每周一批）从货币端划转，不一次性打满。</div>';
    }
    s += '<div class="note" style="margin-top:10px">' + extraNote + '</div>';
    s += etfAddTrim(key, d, lv, tech) +
      '<div class="muted small" style="margin-top:4px"><b>三个口径的区别：</b>「利差档位」看<b>股息率 − 10年国债</b>（跨周期可比，决定仓位，利率变了会自动调整）；「股息率分位」看<b>近 3 年相对位置</b>（锚定法模型估算，含分红增长假设）；「绝对股息率」只是参考。三者偶尔给出不同信号时，以<b>利差档位</b>为准 —— 它对应你相对债券真实能多拿到的现金流。</div></div>';
    return s;
  }
  // 该标的「最近的一条加仓触发」（按距离排序，用于整体投顾页的一句话摘要）
  function nearestAdd(key, d, lv, tech) {
    var rows = addPlanRows(key, d, lv, tech);
    if (!rows.length) return "<b>" + esc(d.name) + "</b> 暂无加仓触发（已在最高档）";
    var best = rows[0];
    for (var i = 1; i < rows.length; i++) {
      if (rows[i]._dist != null && (best._dist == null || rows[i]._dist < best._dist)) best = rows[i];
    }
    function plain(t) { return String(t || "").replace(/<br\s*\/?>/g, " ").replace(/<[^>]*>/g, ""); }
    return "<b>" + esc(d.name) + "</b> " + esc(plain(best.trig)) + "（" + esc(plain(best.now)) + "）";
  }
  // 档位标签去重：两个标的同档时只显示一次（否则首页会出现两个一模一样的「利差偏宽 · 小幅加仓」）
  function divLadderChips(P) {
    if (P.lc.label === P.ll.label) {
      return '<span class="vchip ' + P.lc.cls + '">' + esc(P.lc.label) + '</span>' +
        '<span class="muted small" style="margin-left:5px">两标的同档 · 各 ' + P.lc.w + '%</span>';
    }
    return '<span class="vchip ' + P.lc.cls + '">中证红利 ' + esc(P.lc.label) + '</span>' +
      '<span class="vchip ' + P.ll.cls + '" style="margin-left:4px">红利低波 ' + esc(P.ll.label) + '</span>';
  }
  // 仓位调整提示（减仓侧）：利差收窄到下一档 → 档位仓降多少、需要涨到什么价
  // 与加仓表对称：加仓看「再跌多少触发」，减仓看「再涨多少触发」
  function divTrimRow(key, d, lv) {
    var bondY = A.bond10y.v, spread = d.dy - bondY, idx = -1;
    for (var i = 0; i < DIV_LADDER.length; i++) { if (DIV_LADDER[i][3] === lv.w) { idx = i; break; } }
    if (idx < 0 || idx >= DIV_LADDER.length - 1) {
      return { name: d.name, bottom: true, w: lv.w, label: lv.label };
    }
    var nx = DIV_LADDER[idx + 1], dyT = nx[0] + bondY;
    if (!(dyT > 0) || !(d.dy > 0)) return { name: d.name, bottom: true, w: lv.w, label: lv.label };
    var pxT = d.px * d.dy / dyT, up = (pxT / d.px - 1) * 100;
    return {
      name: d.name, bottom: false, pxT: pxT, up: up,
      wFrom: lv.w, wTo: nx[3], dW: lv.w - nx[3], label: nx[2],
      need: spread - nx[0]
    };
  }
  function trimHintText(key, d, lv) {
    var t = divTrimRow(key, d, lv);
    if (t.bottom) return "<b>" + esc(t.name) + "</b> 已在底仓档（" + esc(t.label) + "），不再减仓，靠底仓吃息等下一轮";
    return "<b>" + esc(t.name) + "</b> 涨到 <b>" + num(t.pxT, d.px < 10 ? 3 : 0) + "</b>（+" + num(t.up, 1) + "%，利差再收窄 " + num(t.need, 2) + "pp）→ 档位仓 " +
      t.wFrom + "% → " + t.wTo + "%（<b>总仓约 −" + num(t.dW / 2, 1) + "pp</b> ≈ " + Math.round(t.dW / 2 * 10000).toLocaleString() + " 元）";
  }
  // 可投工具：把「指数/主 ETF 的加减仓触发」折算成各候选 ETF 的参考价。
  // 中证红利 → 515180 / 515080；红利低波 → 563020 / 512890。加仓用最近一条触发（需再跌 %），减仓用下一档（需再涨 %）。
  function etfAddTrim(key, d, lv, tech) {
    var list = (window.DIV_ETF && window.DIV_ETF[key]) || null;
    if (!list || !list.length) return "";
    var rows = addPlanRows(key, d, lv, tech), addRow = null;
    for (var i = 0; i < rows.length; i++) { if (rows[i]._dist != null) { addRow = rows[i]; break; } }
    var trim = divTrimRow(key, d, lv);
    var h = '<div class="muted small" style="margin-top:6px"><b>可投工具（ETF 加减仓参考价）</b> —— 现价为最近收盘，加/减仓参考价按「需再跌 / 涨的百分比」从指数点位折算：</div>';
    h += '<div class="tbl-scroll"><table class="tbl tbl-stack" style="margin-top:4px"><thead><tr>' +
      '<th>ETF</th><th>现价</th><th>加仓参考价（最近一条触发）</th><th>减仓参考价（利差收窄到下一档）</th></tr></thead><tbody>';
    for (var j = 0; j < list.length; j++) {
      var e = list[j];
      var addTxt = addRow ? num(e.px * (1 - addRow._dist / 100), 3) + '<span class="muted small">（需再跌 ' + num(addRow._dist, 1) + '%）</span>' : "—";
      var trimTxt = trim.bottom ? '<span class="muted small">已在底仓，不再减</span>' :
        num(e.px * (1 + trim.up / 100), 3) + '<span class="muted small">（需再涨 ' + num(trim.up, 1) + '%）</span>';
      h += '<tr><td data-l="ETF"><b>' + esc(e.code) + '</b><br><span class="muted small">' + esc(e.name) + '</span></td>' +
        '<td data-l="现价">' + num(e.px, 3) + '</td>' +
        '<td data-l="加仓参考价">' + addTxt + '</td>' +
        '<td data-l="减仓参考价">' + trimTxt + '</td></tr>';
    }
    h += '</tbody></table></div>';
    h += '<div class="muted small" style="margin-top:4px">加仓参考价取「最近一条会触发的加仓」；完整触发清单见上方触发表，每条已逐行标注对应 ETF 参考价。</div>';
    return h;
  }
  // ---------- 「⚖️ 红利对比」独立页：中证红利 vs 红利低波 · 分开看、分开配 ----------
  // 把原先堆在「整体投顾」页的横向对比、逐标的买入条件与加仓触发表整体搬到这里，
  // 让整体投顾页只剩「配置结论 + 一句话摘要」，两个页面各自保持干爽。
  function renderDivCmp() {
    if (!A) { $("divcmp-body").innerHTML = '<div class="card">整体投顾数据未加载（data/asset.js 缺失）</div>'; return; }
    var P = planState(), c = P.csi, l = P.lowvol, w = P.w;
    var bondY = A.bond10y.v, sc = c.dy - bondY, sl = l.dy - bondY;
    var h = '<div class="asof">红利两个标的 · 表现与利差不同 —— 分开看、分开配 · A股 ' + mktAsOf("A") +
      ' <button class="btn btn-mini" onclick="window.refreshLive()">↻ 刷新行情</button>' +
      ' <button class="btn btn-mini" onclick="showTab(\'plan\')">← 回整体投顾</button></div>';
    // ① 一句话结论
    var firstPick = (c.dyPct == null || l.dyPct == null) ? null : (c.dyPct >= l.dyPct ? c : l);
    var firstTilt = firstPick === l ? P.tilt.lowvol : P.tilt.csi;
    h += '<div class="card verdict"><b>当前结论：</b>红利总仓 <b>' + w.div + '%</b>（档位基准 ' + P.base + '%' + (P.add ? ' ＋ 加仓信号 ' + P.add + 'pp' : '') + '），' +
      '内部倾斜 <b>中证红利 ' + P.tilt.csi + '% / 红利低波 ' + P.tilt.lowvol + '%</b>（按 100 万：' +
      Math.round(w.div * P.tilt.csi / 100 * 10000).toLocaleString() + ' 元 / ' + Math.round(w.div * P.tilt.lowvol / 100 * 10000).toLocaleString() + ' 元）。' +
      '<div class="small" style="margin-top:6px">利差 <b>' + num(sc, 2) + 'pp</b> vs <b>' + num(sl, 2) + 'pp</b>，' +
      (firstPick ? '<b>' + esc(firstPick.name) + '</b> 的股息率分位更高（相对自己更便宜，' + pct(firstPick.dyPct, 0) + ' 分位），是这一轮加仓的第一顺位，内部多配到 ' + firstTilt + '%。' : '两个标的分位数据不足，暂按同档各半配置。') +
      '<br>下一次加仓：<b>' + nearestAdd("csi", c, P.lc, P.tc) + '</b>；<b>' + nearestAdd("lowvol", l, P.ll, P.tl) + '</b>。' +
      '<br>减仓不做技术止盈 —— 由<b>利差档位</b>承担：价涨 → 股息率降 → 利差收窄 → 档位降 → 仓位降（最低 30% 底仓）。</div></div>';
    // ② 横向对比（两个标的表现 / 估值 / 技术 / 配置）
    h += divCompareCard(P);
    // ③ 买入条件 / 加仓触发表 / 卖出侧口径已移到「🧭 整体投顾 → 红利资产」下（红利是重仓，提示要放在首页）
    h += '<div class="note" style="margin-top:10px"><b>本页只回答「两个标的怎么比、怎么配」。</b>' +
      '逐条的买入触发价、加仓金额与仓位调整提示（含减仓触发价）在 <button class="btn btn-mini" onclick="showTab(\'plan\')">🧭 整体投顾 → 红利资产</button> —— 红利是重仓配置，买入与调仓提示默认放在首页。<br>' +
      '<b>减仓不做额外技术止盈</b>：由<b>利差档位</b>承担（价涨 → 股息率降 → 利差收窄 → 档位降 → 仓位降，最低 30% 底仓）。' +
      '<b>观察值（不触发任何动作）：</b>中证红利距 50 周年线 ' + (P.trim.csi.distMA == null ? "—" : (P.trim.csi.distMA > 0 ? "+" : "") + pct(P.trim.csi.distMA, 1)) + '（研究阈值 +' + P.trim.csi.t1 + '%）、' +
      '红利低波 ' + (P.trim.lowvol.distMA == null ? "—" : (P.trim.lowvol.distMA > 0 ? "+" : "") + pct(P.trim.lowvol.distMA, 1)) + '（研究阈值 +' + P.trim.lowvol.t1 + '%）。</div>';
    // ⑤ 怎么配（内部倾斜规则 + 执行口径）
    h += '<div class="card"><h3>两个标的怎么配（内部倾斜）</h3>' +
      '<div class="kvg k2" style="margin-top:4px">' +
      kvRow("倾斜规则", "利差档位更高的一边多配 10pp（60/40）；两者同档 → 各 50%") +
      kvRow("当前倾斜", "<b>中证红利 " + P.tilt.csi + "% / 红利低波 " + P.tilt.lowvol + "%</b>") +
      kvRow("折算金额（100 万）", Math.round(w.div * P.tilt.csi / 100 * 10000).toLocaleString() + " 元 / " + Math.round(w.div * P.tilt.lowvol / 100 * 10000).toLocaleString() + " 元") +
      kvRow("再平衡触发", "红利偏离 ±5pp 或季度末；单条加仓分 2~3 批（每周一批）") +
      '</div>' +
      '<div class="note" style="margin-top:10px"><b>性格分工：</b>中证红利弹性更大（下跌时利差扩张更快），是<b>加仓时的第一顺位</b>；红利低波波动与回撤更小，适合当<b>压舱石</b>长期拿住。' +
      '两者都按各自的利差档位决定仓位，<b>谁的利差更宽、股息率分位更高，就把钱的倾斜给它</b>；不要因为某一个涨得多就换仓 —— 决定仓位的是估值，不是涨幅。</div></div>';
    h += '<div class="muted small">' + window.DISCLAIMER + '</div>';
    $("divcmp-body").innerHTML = h;
  }
  window.renderDivCmp = renderDivCmp;
  function renderPlan() {
    if (!A) { $("plan-body").innerHTML = '<div class="card">整体投顾数据未加载（data/asset.js 缺失）</div>'; return; }
    var P = planState();
    var h = "";
    h += '<div class="asof">整体投顾（资产配置层）· A股 ' + mktAsOf("A") + ' / 美股 ' + mktAsOf("US") + ' · 长期目标 ' + TGOAL.lo + '%~' + TGOAL.hi + '% <button class="btn btn-mini" onclick="window.refreshLive()">↻ 刷新行情</button></div>';

    // ① 总览
    var w = P.w;
    applyMode(w);
    var modeSel = '<div class="sliders" style="margin-top:10px"><label>目标达成模式（调整货币下限 / 红利上限，观察年化可达性）</label>' +
      '<select onchange="window._setPlanMode(this.value)">';
    var mk = ["std", "agg", "def"];
    for (var mi = 0; mi < mk.length; mi++) modeSel += '<option value="' + mk[mi] + '"' + (PLAN_MODE === mk[mi] ? " selected" : "") + '>' + PLAN_MODES[mk[mi]].t + '</option>';
    modeSel += '</select><div class="muted small" style="margin-top:4px">' + esc(PLAN_MODES[PLAN_MODE].d) + '</div></div>';
    var neu = w.div * 0.08 + w.nas * 0.12 + w.cash * 0.015 + w.stock * 0.13;
    var opt = w.div * 0.12 + w.nas * 0.18 + w.cash * 0.015 + w.stock * 0.20;
    h += '<div class="card verdict"><b>当前建议配置：</b>红利 <b>' + w.div + '%</b>（区间 30%~50%，底仓 30 / 上限 50）· 纳斯达克 <b>' + w.nas + '%</b>（定投）· 货币 <b>' + w.cash + '%</b>（弹药）· 巴菲特式股票 <b>' + w.stock + '%</b>。' +
      '<div class="small" style="margin-top:6px">红利仓位：利差档位基准 <b>' + P.base + '%</b>' + (P.add ? ' ＋ 加仓信号 <b>' + P.add + 'pp</b>（' + esc(P.why.join("、")) + '）' : '（无加仓信号）') + ' ＝ <b>' + P.trim.raw + '%</b>' +
      '<br>卖出侧不额外做技术止盈 —— 回测显示它只改善回撤、年化反而 −0.1~−1.5pp（研究保留在「回测」页）。<b>减仓完全由利差档位承担</b>：价涨 → 股息率降 → 利差收窄 → 档位降 → 仓位降，最低 30% 底仓；' +
      '多出来的仓位由货币端吸收 —— <b>红利越贵，货币越多</b>，这就是"自由现金流当弹药"的机制。' +
      '<br>按此配置的模型测算：中性情景年化约 <b>' + pct(neu, 1) + '</b>，乐观情景约 <b>' + pct(opt, 1) + '</b>（长期目标 ' + TGOAL.lo + '%~' + TGOAL.hi + '%，建仓期与稳态现实预期见下方「目标分层」）。</div>' + modeSel + '</div>';

    // ② 四模块
    h += '<div class="grid4">';
    h += '<div class="card"><div class="muted small">红利资产</div><div class="big">' + w.div + '%</div><div class="muted small">底仓 30 / 标准 40 / 上限 50，减仓靠利差档位</div>' +
      '<div style="margin-top:6px">' + divLadderChips(P) + '</div>' +
      '<div class="muted small" style="margin-top:6px">中证红利 ' + pct(P.csi.dy, 2) + '（利差 ' + num(P.csi.dy - A.bond10y.v, 2) + 'pp）／红利低波 ' + pct(P.lowvol.dy, 2) + '（利差 ' + num(P.lowvol.dy - A.bond10y.v, 2) + 'pp），低估加仓、高估减仓</div></div>';
    h += '<div class="card"><div class="muted small">纳斯达克100（只做指数定投）</div><div class="big">' + w.nas + '%</div><div class="muted small">长期定投 20%</div>' +
      '<div style="margin-top:6px"><span class="vchip ' + P.nasLv.cls + '">' + esc(P.nasLv.label) + '</span></div>' +
      '<div class="muted small" style="margin-top:6px">本期建议投 <b>' + num(P.nasLv.mult, 1) + ' 倍</b>基准金额</div></div>';
    h += '<div class="card"><div class="muted small">货币基金 / 自由现金流</div><div class="big">' + w.cash + '%</div><div class="muted small">基准 20%，随红利反向调节</div>' +
      '<div class="muted small" style="margin-top:6px">年化约 ' + pct(A.cash.rate, 1) + '，作用＝安全垫 + 抄底弹药</div></div>';
    h += '<div class="card"><div class="muted small">巴菲特式股票</div><div class="big">' + w.stock + '%</div><div class="muted small">护城河 + 安全边际</div>' +
      '<div class="muted small" style="margin-top:6px">由「每日推荐 / 投资组合」页选股承载</div></div>';
    h += '</div>';

    // ③ 结构图 + 调仓明细
    h += '<div class="grid2"><div class="card"><h3>建议配置结构</h3>' + planDonut(w) + '</div>';
    h += '<div class="card"><h3>若以 100 万总资产执行</h3><div class="kv kvg k2" style="margin-top:4px">' +
      '<div class="muted">红利资产</div><div><b>' + (w.div * 10000).toLocaleString() + ' 元</b>（中证红利 ' + (w.div * P.tilt.csi / 100 * 10000).toLocaleString() + ' / 红利低波 ' + (w.div * P.tilt.lowvol / 100 * 10000).toLocaleString() + '）</div>' +
      '<div class="muted">纳斯达克100</div><div><b>' + (w.nas * 10000).toLocaleString() + ' 元</b>（每月定投 ' + (P.nasLv.mult * 5000).toLocaleString() + ' 元示例）</div>' +
      '<div class="muted">货币/现金流</div><div><b>' + (w.cash * 10000).toLocaleString() + ' 元</b>（可随时转红利）</div>' +
      '<div class="muted">巴菲特股票</div><div><b>' + (w.stock * 10000).toLocaleString() + ' 元</b>（4~8 只集中持有）</div>' +
      '<div class="muted">年股息现金流（占总资产）</div><div><b>' + num((P.csi.dy * P.tilt.csi + P.lowvol.dy * P.tilt.lowvol) / 100 * w.div / 100, 2) + '%</b> <span class="muted small">红利部分贡献</span></div>' +
      '<div class="muted">再平衡触发</div><div><b>红利偏离 ±5pp 或季度末</b></div>' +
      '</div></div></div>';

    // ④ 红利模块：本页只留一句话摘要 —— 完整对比、逐条加仓触发价与金额在独立页「⚖️ 红利对比」
    var spC = P.csi.dy - A.bond10y.v, spL = P.lowvol.dy - A.bond10y.v;
    h += '<div class="card"><h3><span class="dot" style="background:#d92c2c"></span>红利资产 <b>' + w.div + '%</b> <span class="muted small">档位仓 ' + P.lc.w + '% / ' + P.ll.w + '%</span>' +
      '<button class="btn btn-mini" onclick="showTab(\'divcmp\')">⚖️ 两个标的对比 →</button></h3>' +
      '<div class="kv kvg k4" style="margin:6px 0">' +
      kvRow("中证红利", pct(P.csi.dy, 2) + ' · 利差 <b>' + num(spC, 2) + 'pp</b> · 档位仓 ' + P.lc.w + '%') +
      kvRow("红利低波", pct(P.lowvol.dy, 2) + ' · 利差 <b>' + num(spL, 2) + 'pp</b> · 档位仓 ' + P.ll.w + '%') +
      kvRow("档位基准 ＋ 加仓信号", P.base + '%' + (P.add ? ' ＋ ' + P.add + 'pp' : '') + ' ＝ <b>' + P.trim.raw + '%</b>') +
      kvRow("红利内部倾斜", '中证 ' + P.tilt.csi + '% / 低波 ' + P.tilt.lowvol + '%') +
      '</div>' +
      '<div class="small" style="margin-top:8px"><b>仓位调整提示</b>（按 100 万总资产折算，1pp = 1 万元）' +
      '<div style="margin-top:4px">· <b>加仓方向</b>：' + nearestAdd("csi", P.csi, P.lc, P.tc) + '；' + nearestAdd("lowvol", P.lowvol, P.ll, P.tl) + '。</div>' +
      '<div style="margin-top:3px">· <b>减仓方向</b>（利差收窄 → 档位降 → 仓位降）：' + trimHintText("csi", P.csi, P.lc) + '；' + trimHintText("lowvol", P.lowvol, P.ll) + '。</div>' +
      '<div class="muted small" style="margin-top:4px">不做额外技术止盈（回测年化反而 −0.1~−1.5pp，研究保留在「📈 回测」页）；' +
      '两个标的表现与利差不同，<b>分开看、分开配</b> —— 横向对比表与内部倾斜见「⚖️ 红利对比」页。</div></div>';
    // ④b 红利标的：买入条件 + 加仓触发表（重仓配置，必须在首页看到买入与仓位调整提示）
    h += '<div class="sectitle"><b>红利标的（低估买入 · 利差档位减仓）</b> <span class="muted small">仓位 30%~50%，底仓 30% 永不空仓；利差越宽越便宜</span></div>';
    h += '<div class="grid2">';
    h += divCard(P, "csi", P.csi, P.lc, P.tc, P.tilt.csi,
      '<b>规则（利差 = 股息率 − 10年国债）：</b>利差 ≥3.5pp 打满 50%；3.0~3.5pp → 47%；2.5~3.0pp → 44%；2.0~2.5pp → 40%（标准）；1.5~2.0pp → 35%；1.0~1.5pp → 32%；&lt;1.0pp → 30% 底仓（不再减，靠底仓吃息等下一轮）。' +
      '<br><b>叠加提醒（已按 6 年回测分标的调整）：</b>中证红利<b>跌破年线（回测 −0.30pp 偏弱）、RSI 超卖（无回测证据）均仅观察、不加仓</b>；只有<b>周线 BOLL 下轨以下 → +5pp 重度提醒</b>（回测 +6.34pp、胜率 100%，唯一稳定有效）才动用货币端弹药；<b>周线 BOLL 中轨以下 → 仅观察</b>（21 次触发、超额 −1.74pp，噪音）。');
    h += divCard(P, "lowvol", P.lowvol, P.ll, P.tl, P.tilt.lowvol,
      '<b>规则（技术三重买点，回测均有效）：</b>① 收盘价跌破 52 周线（回测 +4.73pp）→ <b>+3pp</b>；② RSI(14) &lt; 30 超卖（回测 +4.41pp）→ <b>+2pp</b>；③ 周 K 线向上（本周收阳）。三者同时满足 → 重点买入信号；满足 2 项 → 小仓位试买；仅 1 项 → 观察。' +
      '<br>估值上同样参考利差档位，与中证红利合并决定红利总仓位；周线 BOLL 下轨以下同样 +5pp。');
    h += '</div>';
    // ④c 卖出侧口径
    h += '<div class="note" style="margin-top:10px"><b>卖出侧 —— 为什么不额外做「技术止盈」：</b>' +
      '利差档位本身就是卖出机制：<b>价涨 → 股息率降 → 利差收窄 → 档位降 → 仓位降</b>（最低 30% 底仓）。' +
      '额外叠加的「年线上方 5%~8% 止盈浮仓」在三条长样本上确实能削掉 1~5pp 回撤，但<b>年化反而 −0.1~−1.5pp（对收益没有改善）</b>，' +
      '所以按「只有有效才采纳」的口径<b>不写入执行规则</b>，完整研究保留在「📈 回测 → 红利策略回测（买入 + 卖出）」。<br>' +
      '<b>观察值（不触发任何动作）：</b>中证红利距 50 周年线 ' + (P.trim.csi.distMA == null ? "—" : (P.trim.csi.distMA > 0 ? "+" : "") + pct(P.trim.csi.distMA, 1)) + '（研究阈值 +' + P.trim.csi.t1 + '%）、' +
      '红利低波 ' + (P.trim.lowvol.distMA == null ? "—" : (P.trim.lowvol.distMA > 0 ? "+" : "") + pct(P.trim.lowvol.distMA, 1)) + '（研究阈值 +' + P.trim.lowvol.t1 + '%）。' +
      '真要减仓时看的是<b>利差</b>（见上方「仓位调整提示 · 减仓方向」的触发价），不是价格涨幅。</div>';
    // ⑤ 纳斯达克模块
    var n = P.nas;
    h += '<div class="card"><h3><span class="dot" style="background:#1d4ed8"></span>纳斯达克100（只做指数，不做个股） <span class="vchip ' + P.nasLv.cls + '">' + esc(P.nasLv.label) + '</span></h3>';
    h += '<div class="kv kvg k4" style="margin:6px 0">' +
      kvRow("指数点位", num(n.idxPx, 2) + ' <span class="' + cls(n.chg) + ' small">' + (n.chg > 0 ? "+" : "") + pct(n.chg) + '</span>') +
      kvRow("PE-TTM", num(n.pe, 2) + ' 倍 <span class="muted small">' + esc(n.peAsOf) + '</span>') +
      kvRow("PE 近 1 年分位", pct(n.pePct1y, 2) + ' <span class="muted small">越低越便宜</span>') +
      kvRow("PE 锚定分位（模型）", pct(n.pePct, 0) + ' <span class="muted small">EPS 增速 25% 假设</span>') +
      kvRow("锚定分位敏感性", (n.peScen ? "增速15%→" + pct(n.peScen.g15, 0) + " / 20%→" + pct(n.peScen.g20, 0) + " / 25%→" + pct(n.peScen.g25, 0) + " / 30%→" + pct(n.peScen.g30, 0) : "—")) +
      kvRow("交易标的", esc(n.vehicle)) +
      kvRow("距年线（QQQ）", (n.distMA250 == null ? "—" : (n.distMA250 > 0 ? "+" : "") + pct(n.distMA250, 1))) +
      kvRow("RSI(14)", num(n.rsi14, 1)) +
      kvRow("52 周位置", (n.pos52 == null ? "—" : pct(n.pos52, 0))) +
      '</div>';
    h += '<table class="tbl" style="margin-top:10px"><thead><tr><th>PE 区间</th><th>估值判断</th><th>定投金额</th><th>止盈动作</th></tr></thead><tbody>' +
      '<tr><td>&lt; 24 倍</td><td>显著低估</td><td><b>2.0 倍</b>基准</td><td>不止盈，只加仓</td></tr>' +
      '<tr><td>24 ~ 27 倍</td><td>偏低估</td><td><b>1.5 倍</b>基准</td><td>不止盈</td></tr>' +
      '<tr><td>27 ~ 32 倍</td><td>合理</td><td><b>1.0 倍</b>基准</td><td>不止盈</td></tr>' +
      '<tr><td>32 ~ 36 倍</td><td>偏高</td><td><b>0.5 倍</b>基准</td><td>每涨 5% 减 10%</td></tr>' +
      '<tr><td>&gt; 36 倍</td><td>高估</td><td><b>暂停</b>定投</td><td>每涨 5% 减 20%，直至 20% 基准仓的一半</td></tr>' +
      '</tbody></table>';
    h += '<div class="note" style="margin-top:10px"><b>本期结论：</b>PE ' + num(n.pe, 2) + ' 倍处于「合理」档 → 按 <b>' + num(P.nasLv.mult, 1) + ' 倍</b>基准金额定投（建议每月固定日期自动扣款，不择时）。' +
      (P.nasNote ? ' ' + esc(P.nasNote) + '。' : '') +
      ' 定投的意义在于：纳指长期波动大（年化波动 20%+），用固定金额摊平成本；只有估值进入"偏高/高估"档才做分批止盈，其余时间不中断。' +
      '<br><b>技术提示：</b>距年线 ' + (n.distMA250 == null ? "—" : (n.distMA250 > 0 ? "+" : "") + pct(n.distMA250, 1)) + '、RSI ' + num(n.rsi14, 0) + '、52 周位置 ' + (n.pos52 == null ? "—" : pct(n.pos52, 0)) +
      ' —— ' + (n.pos52 != null && n.pos52 > 90 ? '处于历史高位区间，追高性价比低，等回调或降低单次金额' : '未处于极端位置') + '。</div>';
    h += '<div class="muted small" style="margin-top:6px">说明：美股只做指数（QDII 纳指ETF 或美股账户买 QQQ），不做个股；人民币投资者还需承担汇率波动与 QDII 溢价。PE 近 1 年分位来自基金公司披露（' + esc(n.peAsOf) + '），锚定分位为本项目模型估算，对 EPS 增速假设敏感，故同时给出敏感性区间。</div></div>';

    // ⑥ 货币 + 股票
    h += '<div class="grid2">';
    h += '<div class="card"><h3><span class="dot" style="background:#0a8f4e"></span>货币基金 / 自由现金流（' + w.cash + '%）</h3>' +
      '<div class="kv kvg k2" style="margin:6px 0">' +
      kvRow("参考年化", pct(A.cash.rate, 1) + ' <span class="muted small">' + esc(A.cash.note || "") + '</span>') +
      kvRow("当前建议占比", w.cash + '% <span class="muted small">基准 20%</span>') +
      kvRow("角色", "安全垫 + 抄底弹药") +
      kvRow("动用规则", "红利利差 ≥3.0pp 或周线 BOLL 下轨以下时，分 2~3 批转入红利") +
      '</div><div class="note" style="margin-top:8px">红利仓位越高，货币越少（弹药打出去）；红利降到 30% 底仓时，货币升至 ' + (100 - 30 - w.nas - w.stock) + '% —— 这就是"高估卖出"的落地方式：不是清仓离场，而是把钱放回弹药库等下一次机会。</div></div>';
    h += '<div class="card"><h3><span class="dot" style="background:#d97706"></span>巴菲特式股票（' + w.stock + '%）</h3>' +
      '<div class="kv kvg k2" style="margin:6px 0">' +
      kvRow("占比", w.stock + '% <span class="muted small">权益中的"进攻期权"</span>') +
      kvRow("选股框架", "护城河 / 盈利质量 / 管理层 / 成长 / 估值") +
      kvRow("买入条件", "估值分位偏低 + 目标价有安全边际") +
      kvRow("仓位纪律", "单只 ≤3%，总仓 ≤10%，不杠杆") +
      '</div><div class="note" style="margin-top:8px">名单、筛选与配比已合并到「🧺 A股港股」页（市场雷达 · 每日推荐 · 投资组合 · 好公司筛选）：<button class="btn btn-mini" onclick="showTab(\'ah\')">查看 A股港股组合 →</button>。股票部分追求超额收益，但仓位限制在 10%，即使判断错误也不影响整体目标的达成。</div></div>';
    h += '</div>';

    // ⑦ 提醒面板
    h += '<div class="card"><h3>提醒面板（已触发 / 临近触发）</h3>';
    h += '<table class="tbl tbl-stack"><thead><tr><th>模块</th><th>条件</th><th>状态</th><th>当前值</th><th>距离</th></tr></thead><tbody>';
    for (var ai = 0; ai < P.alerts.length; ai++) {
      var al = P.alerts[ai], tn = alertTone(al);
      h += '<tr><td data-l="模块">' + esc(al.tag) + '</td><td class="small wrapcol" data-l="条件">' + esc(al.name) + '</td>' +
        '<td data-l="状态"><span class="vchip ' + tn.c + '">' + tn.s + '</span></td>' +
        '<td class="small" data-l="当前值">' + esc(al.now) + '</td><td class="small" data-l="距离">' + esc(al.ok ? "已触发" : al.distText) + '</td></tr>';
    }
    h += '</tbody></table>';
    h += '<div class="muted small" style="margin-top:6px">距离口径：均线/BOLL 为价格百分比距离；RSI 为历史经验估算（历史上该标的 RSI 破 30 时相对近 60 日高点的平均回撤）。提醒仅基于公开行情与模型规则，不构成投资建议。</div></div>';


    // ⑧ 目标拆解
    h += '<div class="card"><h3>长期目标 ' + TGOAL.lo + '%~' + TGOAL.hi + '% 的来源与达成路径</h3>';
    h += '<table class="tbl"><thead><tr><th>模块</th><th>仓位</th><th>收益来源</th><th>中性假设</th><th>贡献（中性）</th><th>乐观假设</th><th>贡献（乐观）</th></tr></thead><tbody>' +
      '<tr><td>红利资产</td><td>' + w.div + '%</td><td>股息 ' + pct((P.csi.dy * P.tilt.csi + P.lowvol.dy * P.tilt.lowvol) / 100, 2) + ' + 分红增长/估值修复</td><td>8%</td><td>' + pct(w.div * 0.08, 2) + '</td><td>12%</td><td>' + pct(w.div * 0.12, 2) + '</td></tr>' +
      '<tr><td>纳斯达克100</td><td>' + w.nas + '%</td><td>盈利增长 + 长期复利</td><td>12%</td><td>' + pct(w.nas * 0.12, 2) + '</td><td>18%</td><td>' + pct(w.nas * 0.18, 2) + '</td></tr>' +
      '<tr><td>货币/现金流</td><td>' + w.cash + '%</td><td>7 日年化</td><td>1.5%</td><td>' + pct(w.cash * 0.015, 2) + '</td><td>1.5%</td><td>' + pct(w.cash * 0.015, 2) + '</td></tr>' +
      '<tr><td>巴菲特股票</td><td>' + w.stock + '%</td><td>好公司 + 安全边际</td><td>13%</td><td>' + pct(w.stock * 0.13, 2) + '</td><td>20%</td><td>' + pct(w.stock * 0.20, 2) + '</td></tr>' +
      '<tr><td><b>合计</b></td><td><b>100%</b></td><td></td><td></td><td><b>' + pct(w.div * 0.08 + w.nas * 0.12 + w.cash * 0.015 + w.stock * 0.13, 2) + '</b></td><td></td><td><b>' + pct(w.div * 0.12 + w.nas * 0.18 + w.cash * 0.015 + w.stock * 0.20, 2) + '</b></td></tr>' +
      '</tbody></table>';
    h += '<div class="note" style="margin-top:10px"><b>目标分层（诚实版）：</b>「长期目标 ' + TGOAL.lo + '%~' + TGOAL.hi + '%」是愿景，不是当前配置能保证的 —— 按当前「红利 ' + w.div + '% + 纳指 ' + w.nas + '% + 货币 ' + w.cash + '% + 股票 ' + w.stock + '%」，' +
      '<b>稳态中性约 ' + pct(neu, 1) + ' / 乐观约 ' + pct(opt, 1) + '</b>（中性够不到 10% 下限），' +
      '<b>建仓期第一年中性约 5%~7%</b>（近一半资金在货币端）。' +
      '要摸到 ' + TGOAL.lo + '%~' + TGOAL.hi + '%，靠的是三件事同时发生：' +
      '<br>① <b>红利在低估区真的加满</b>（利差 ≥3.0pp 时把仓位打到 47%~50%，而不是嘴上说越跌越买）；' +
      '② <b>纳指定投连续 3~5 年不中断</b>（历史上一轮完整周期的年化常在 12%~18%）；' +
      '③ <b>股票端只买安全边际内的好公司</b>，避免在高估值成长股上追高。' +
      '<br><b>可调开关（上方下拉）：</b>货币是明确的收益拖累（年化 1.5%）—— 切到<b>进取模式</b>（货币下限 10%）中性年化约 ' +
      pct(50 * 0.08 + 30 * 0.12 + 10 * 0.015 + 10 * 0.13, 1) + '、乐观约 ' + pct(50 * 0.12 + 30 * 0.18 + 10 * 0.015 + 10 * 0.20, 1) +
      '，但波动与回撤会加大；切到<b>保守模式</b>（红利上限 40%）则相反。三个模式都不改变"低估买入、高估卖出"的核心纪律，只改变弹药的闲置比例。</div>';
    h += '</div>';

    h += '<div class="muted small">' + window.DISCLAIMER + '</div>';
    $("plan-body").innerHTML = h;
  }

  // ---------- 资金落地：建仓节奏 ----------
  var CAP_KEY = "ia_capital";
  function getCap() {
    var v = null;
    try { v = Number(localStorage.getItem(CAP_KEY)); } catch (e) { }
    if (!(v > 0)) v = 300;
    return Math.round(v);
  }
  window._setCap = function (v) {
    var n = Math.round(Number(v));
    if (!(n > 0)) n = 300;
    n = Math.min(100000, Math.max(1, n));
    try { localStorage.setItem(CAP_KEY, String(n)); } catch (e) { }
    if (curTab === "fund") renderFund();
    else if (curTab === "plan") renderPlan();
  };
  // 预期年化假设（与页面年化测算口径一致）
  var EXPECT = { div: [8, 12], nas: [12, 18], stock: [13, 20], cash: 1.5 };
  // 建仓节奏（周维度）：底仓 8 周 / 估值仓第 9~14 周 / 信号仓第 3~4 周 / 纳指 78 周（≈18 个月）/ 股票参考 26 周
  var PLAN_W = { base: 8, valFrom: 9, val: 6, sigFrom: 3, sig: 2, nas: 78, stk: 26, build: 52 };
  function fundPlan(cap) {
    var P = planState();
    if (!P) return null;
    var w = P.w;
    var baseW = P.base, addW = P.add;
    var ammoW = Math.max(0, 50 - w.div);                    // 弹药预留：距离 50% 上限的空间
    var baseAmt = cap * 0.30;                               // 底仓（任何情况都要建）
    var valAmt = cap * Math.max(0, baseW - 30) / 100;       // 估值仓（利差档位给的额外部分）
    var sigAmt = cap * addW / 100;                          // 信号仓（技术叠加，已触发才投）
    var ammoAmt = cap * ammoW / 100;                        // 弹药仓（等极端信号）
    var nasAmt = cap * w.nas / 100, stkAmt = cap * w.stock / 100;
    var PW = PLAN_W;                                        // 周维度节奏参数
    var NW = PW.nas;                                        // 纳指定投总周数（78 周 ≈ 18 个月）
    var M = [], cum = { div: 0, nas: 0, stock: 0 };
    for (var i = 0; i < NW; i++) M.push({ div: 0, nas: nasAmt / NW, stock: i < PW.stk ? stkAmt / PW.stk : 0 });
    // 底仓：第 1~8 周，首周 2/9、其余 7 周各 1/9
    for (var i2 = 0; i2 < PW.base; i2++) M[i2].div += baseAmt * (i2 === 0 ? 2 / 9 : 1 / 9);
    // 估值仓：第 9~14 周，每周 1/6
    for (var i3 = 0; i3 < PW.val && valAmt > 0; i3++) M[PW.valFrom - 1 + i3].div += valAmt / PW.val;
    // 信号仓：第 3~4 周，分 2 批
    if (sigAmt > 0) { M[PW.sigFrom - 1].div += sigAmt / 2; M[PW.sigFrom].div += sigAmt / 2; }
    var rows = [], run = 0;
    for (var i4 = 0; i4 < M.length; i4++) {
      cum.div += M[i4].div; cum.nas += M[i4].nas; cum.stock += M[i4].stock;
      run += M[i4].div + M[i4].nas + M[i4].stock;
      rows.push({ i: i4, wk: i4 + 1, div: M[i4].div, nas: M[i4].nas, stock: M[i4].stock, cumDiv: cum.div, cumNas: cum.nas, cumStk: cum.stock, cum: run });
    }
    // 建仓期（前 52 周 = 1 年）时间加权平均仓位
    var ad = 0, an = 0, as = 0;
    for (var i5 = 0; i5 < Math.min(PW.build, rows.length); i5++) { ad += rows[i5].cumDiv / cap; an += rows[i5].cumNas / cap; as += rows[i5].cumStk / cap; }
    var nB = Math.min(PW.build, rows.length);
    var avg = { div: ad / nB * 100, nas: an / nB * 100, stock: as / nB * 100 };
    avg.cash = Math.max(0, 100 - avg.div - avg.nas - avg.stock);
    function exp(a, div, nas, stk) { return (a.div * div + a.nas * nas + a.stock * stk + a.cash * EXPECT.cash) / 100; }
    return {
      cap: cap, w: w, baseW: baseW, addW: addW, ammoW: ammoW,
      amt: { div: cap * w.div / 100, nas: nasAmt, stock: stkAmt, cash: cap * w.cash / 100 },
      parts: { base: baseAmt, val: valAmt, sig: sigAmt, ammo: ammoAmt },
      rows: rows, avg: avg, PW: PW, NAS_W: NW, STK_W: PW.stk, BUILD_W: PW.build,
      expBuild: { neu: exp(avg, EXPECT.div[0], EXPECT.nas[0], EXPECT.stock[0]), opt: exp(avg, EXPECT.div[1], EXPECT.nas[1], EXPECT.stock[1]) },
      expSteady: { neu: (w.div * EXPECT.div[0] + w.nas * EXPECT.nas[0] + w.stock * EXPECT.stock[0] + w.cash * EXPECT.cash) / 100, opt: (w.div * EXPECT.div[1] + w.nas * EXPECT.nas[1] + w.stock * EXPECT.stock[1] + w.cash * EXPECT.cash) / 100 }
    };
  }
  // ---------- 股票端：标的选择与分批节奏 ----------
  // 选股三层门槛：① 距离 30% 安全边际买点 ≤30%（26 周内够得着）② 综合分 ≥6.5（十倍空间期权型放宽 5.5）
  //              ③ 护城河分象限：稳增长（压舱石）≥7、高增长 ≥6、热点轮动/十倍空间 ≥5.5
  // 排序分 = 综合分×0.55 + 接近度×0.45（估值已在五维综合分里体现，不再单独加权，避免重复计入）
  // 核心资产优先：综合分≥8 且护城河≥8.5 视为「好生意」，在象限内优先占位，不被「跌得更深」的伪便宜压制
  // 象限配额：稳增长 40% / 高增长 30% / 热点轮动 15%（+5% 备用金 = 投资组合页的热点 20%）/ 十倍空间 10%
  var STK_QUOTA = { steady: { n: 2, w: 40 }, growth: { n: 3, w: 30 }, rotate: { n: 1, w: 15 }, tenx: { n: 1, w: 10 } };
  var STK_KEYS = ["steady", "growth", "rotate", "tenx"];
  var STK_RESERVE = 5, STK_MAX_DIST = 30, STK_MOS = 30;
  // 共享选股：三层门槛 + 分象限护城河 + rank 排序 + 配额名额（建仓节奏页「③ 股票端」与投资组合页「组合明细」共用同一套，保证两页标的清单一致）
  function stockPickList() {
    var cand = [];
    for (var i = 0; i < S.length; i++) {
      var s = S[i];
      var r = targetRange(s, s.fairPE ? s.fairPE[0] : (s.fairPB ? s.fairPB[0] : 10), s.fairPE ? s.fairPE[1] : (s.fairPB ? s.fairPB[1] : 15));
      if (!r || !(r.mid > 0)) continue;
      var sc = composite(s, W), vs = valScore(s);
      // 老唐模式下先过「三大前提」；合理PE带模式不做此项筛选
      if (VAL_MODE === "lt" && ltPremise(s).length) continue;
      // 买点：老唐法直接用「三年后合理估值 × 50%」；旧法用中枢 × 安全边际
      var buy = r.buyOverride != null ? r.buyOverride : r.mid * (1 - STK_MOS / 100);
      if (!(buy > 0)) continue;
      var dist = (s.px / buy - 1) * 100;                      // 正 = 还需下跌多少才到买点
      if (dist > STK_MAX_DIST) continue;                      // 太远，26 周窗口内不现实
      var catKey = s.cat.indexOf("tenx") >= 0 ? "tenx" : (s.cat.indexOf("growth") >= 0 ? "growth" : (s.cat.indexOf("rotate") >= 0 ? "rotate" : "steady"));
      // 门槛分象限：稳增长（压舱石）护城河最严 ≥7；高增长看成长动能，放宽 ≥6；热点/十倍放宽 ≥5.5
      var minScore = catKey === "tenx" ? 5.5 : 6.5;
      var minMoat = catKey === "steady" ? 7 : (catKey === "growth" ? 6 : 5.5);
      if (sc < minScore || s.moat < minMoat) continue;
      var dScore = Math.max(0, Math.min(1.2, 1 - dist / 40)); // 越接近买点越高（已在买点内给 1.2 加成）
      // 核心资产：护城河 ≥8.5 且综合分 ≥8（好生意 + 真利润 + 好价格三项占优），象限内优先占位
      var core = sc >= 8 && s.moat >= 8.5;
      cand.push({
        s: s, code: s.code, name: s.name, px: s.px, cat: s.cat, catKey: catKey,
        score: sc, grade: grade(sc), vs: vs, pe: s.pe, div: s.div, core: core,
        mid: r.mid, buy: buy, hi: r.hi, dist: dist, base: r.base, lt: r.lt || null,
        rank: sc / 10 * 0.55 + dScore * 0.45
      });
    }
    var picks = [], used = {};
    for (var ci = 0; ci < STK_KEYS.length; ci++) {
      var k = STK_KEYS[ci], q = STK_QUOTA[k];
      var list = cand.filter(function (o) { return o.catKey === k; }).sort(function (a, b) {
        if (a.core !== b.core) return a.core ? -1 : 1;      // 核心资产优先，避免「跌得越深越靠前」的伪便宜
        return b.rank - a.rank;
      }).slice(0, q.n);
      for (var li = 0; li < list.length; li++) {
        used[list[li].code] = 1;
        picks.push(list[li]);
      }
    }
    picks.sort(function (a, b) { return a.dist - b.dist; });
    // 备选：够得着但没进配额的次优标的（备用金在这里用）
    var alts = cand.filter(function (o) { return !used[o.code] && o.dist <= 20; }).sort(function (a, b) { return a.dist - b.dist; }).slice(0, 4);
    return { picks: picks, alts: alts };
  }
  function stockPlan(amt) {
    if (!amt || !(amt > 0)) return null;
    var SP = stockPickList();
    var picks = SP.picks, alts = SP.alts;
    var cntByCat = {};                                       // 各象限实际入选只数（名额 2 但只选 1 只时，该只独享象限配额）
    for (var pi = 0; pi < picks.length; pi++) cntByCat[picks[pi].catKey] = (cntByCat[picks[pi].catKey] || 0) + 1;
    for (var pi = 0; pi < picks.length; pi++) {
      var o = picks[pi];
      var q = STK_QUOTA[o.catKey];
      var each = amt * q.w / 100 / cntByCat[o.catKey];     // 象限配额金额 ÷ 实际入选只数（等权）
      o.amt = each;
      o.tranches = [
        { n: "首批 40%", p: o.buy, amt: each * 0.40 },
        { n: "二批 30%", p: o.buy * 0.92, amt: each * 0.30 },
        { n: "三批 30%", p: o.buy * 0.85, amt: each * 0.30 }
      ];
      o.state = o.dist <= 0 ? "buy" : (o.dist <= 15 ? "wait" : "watch");
    }
    picks.sort(function (a, b) { return a.dist - b.dist; });
    var first = 0, waitAmt = 0, watchAmt = 0;
    for (var pi = 0; pi < picks.length; pi++) {
      if (picks[pi].state === "buy") first += picks[pi].tranches[0].amt;
      else if (picks[pi].state === "wait") waitAmt += picks[pi].amt;
      else watchAmt += picks[pi].amt;
    }
    return {
      amt: amt, picks: picks, alts: alts, mos: STK_MOS,
      reserve: amt * STK_RESERVE / 100,
      alloc: picks.reduce(function (a, o) { return a + o.amt; }, 0),
      first: first, waitAmt: waitAmt, watchAmt: watchAmt,
      nBuy: picks.filter(function (o) { return o.state === "buy"; }).length
    };
  }

  function renderFund() {
    var cap = getCap();
    var F = A ? fundPlan(cap) : null;
    var h = '<div class="asof">资金落地 · 建仓节奏（周维度）· A股 ' + mktAsOf("A") + ' / 美股 ' + mktAsOf("US") + ' <button class="btn btn-mini" onclick="window.refreshLive()">↻ 刷新行情</button></div>';
    h += changeCard("formal");
    if (!F) { $("fund-body").innerHTML = h + '<div class="card"><div class="muted small">配置数据未加载（data/asset.js 缺失）。</div></div>'; return; }
    var P = planState();
    function w2(v) { return num(v, v >= 100 ? 0 : 1) + " 万"; }
    h += '<div class="card"><h3>💰 资金落地：建仓节奏（按周执行）</h3>';
    h += '<div class="sliders2" style="max-width:320px;margin-bottom:8px"><label>可投资金（万元，自动记住）</label>' +
      '<input type="number" min="1" step="10" value="' + cap + '" onchange="window._setCap(this.value)"></div>';
    h += '<div class="note verdict"><b>本金 ' + w2(cap) + ' → 目标配置：</b>红利 <b>' + w2(F.amt.div) + '</b>（' + F.w.div + '%）· 纳斯达克 <b>' + w2(F.amt.nas) + '</b>（' + F.w.nas + '%）· 巴菲特式股票 <b>' + w2(F.amt.stock) + '</b>（' + F.w.stock + '%）· 货币弹药 <b>' + w2(F.amt.cash) + '</b>（' + F.w.cash + '%）。' +
      '<div class="small" style="margin-top:6px"><b>不要一次性买满</b> —— 纳指当前 52 周位置 ' + num(A.nasdaq.pos52, 0) + '%、高于年线 ' + pct(A.nasdaq.distMA250, 1) + '，是最差的建仓时点；红利位置中性（52 周位置 ' + num(A.dividend.csi.pos52, 0) + '%、已跌破年线 ' + pct(-A.dividend.csi.distMA250, 1) + '）可以正常推进。' +
      '因此节奏的原则是：<b>便宜的先建、贵的最慢建、看不准的留给信号</b>。</div></div>';

    // ① 红利的四层拆分
    h += '<div style="margin-top:12px"><b>① 红利端 ' + w2(F.amt.div) + ' 拆成四层</b> <span class="muted small">（合计 ' + F.w.div + '%，弹药仓触发后最高到 50%）</span></div>';
    h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>层级</th><th>金额</th><th>占比</th><th>何时投</th><th>触发条件</th></tr></thead><tbody>';
    var lv = [
      ["底仓", F.parts.base, 30, "第 1~" + F.PW.base + " 周，每周一批（首周 2/9）", "无条件 —— 这部分永远在场，不择时"],
      ["估值仓", F.parts.val, F.baseW - 30, "第 " + F.PW.valFrom + "~" + (F.PW.valFrom + F.PW.val - 1) + " 周，每周 1/6", "利差档位 " + F.baseW + "% 有效（当前利差 " + pct(A.dividend.csi.dy - A.bond10y.v, 2) + "）"],
      ["信号仓", F.parts.sig, F.addW, (F.addW > 0 ? "第 " + F.PW.sigFrom + "~" + (F.PW.sigFrom + 1) + " 周，分 2 批" : "待技术信号触发才投"), (F.addW > 0 ? "已触发：" + esc(P_why()) : "当前无触发信号（跌破年线/RSI/周线下轨均未触发）")],
      ["弹药仓", F.parts.ammo, F.ammoW, "不限时，重度提醒才动", "周线 BOLL 下轨以下（中证红利还需再跌 " + num(A.dividend.csi.distWkLow, 1) + "%）；" + F.BUILD_W + " 周未触发则按利差档位补足"]
    ];
    for (var li = 0; li < lv.length; li++) {
      if (lv[li][1] <= 0.05 && lv[li][0] !== "信号仓") continue;
      var amtTxt = (lv[li][0] === "信号仓" && lv[li][1] <= 0.05) ? "0 万" : w2(lv[li][1]);
      h += '<tr><td class="small wrapcol"><b>' + lv[li][0] + '</b></td><td><b>' + amtTxt + '</b></td><td>' + num(lv[li][2], 0) + '%</td><td class="small wrapcol">' + lv[li][3] + '</td><td class="small wrapcol">' + lv[li][4] + '</td></tr>';
    }
    h += '</tbody></table></div>';

    // ② 纳指与股票
    h += '<div style="margin-top:12px"><b>② 纳斯达克 ' + w2(F.amt.nas) + '：' + F.NAS_W + ' 周（≈' + num(F.NAS_W / 4.345, 0) + ' 个月）匀速定投</b> <span class="muted small">（每周约 ' + num(F.amt.nas / F.NAS_W, 2) + ' 万，本期 PE 档位 ' + esc(P.nasLv.label) + ' → ' + num(P.nasLv.mult, 1) + ' 倍）</span></div>';
    h += '<div class="muted small">当前 PE ' + num(A.nasdaq.pe, 2) + ' 倍、52 周位置 ' + num(A.nasdaq.pos52, 0) + '%、RSI ' + num(A.nasdaq.rsi14, 0) + ' —— <b>位置偏高，所以拉长到 ' + F.NAS_W + ' 周</b>而不是一次性买入；每周固定一天扣款（建议周三，避开周一/周五的情绪波动）。PE 降到 24~27 倍时倍数升到 1.5 倍、低于 24 倍升到 2.0 倍，涨到 32 倍以上则减半、36 倍以上停止定投并开始分批止盈。</div>';
    h += '<div style="margin-top:10px"><b>③ 股票端 ' + w2(F.amt.stock) + '：' + F.STK_W + ' 周内，按「买点触发价」分批</b></div>';
    var isLT = VAL_MODE === "lt";
    h += '<div class="vfilter" style="margin:6px 0"><span class="muted small">股票端估值法：' +
      '<select onchange="window._setValMode(this.value)">' + opt("lt", "老唐估值法", VAL_MODE) + opt("band", "合理PE带法（默认）", VAL_MODE) + '</select></span>' +
      '<span class="vf-right muted small">' + (isLT
        ? '买点 = 三年后合理估值 × 50%（基准EPS × 机构一致预期三年倍数 → × 合理PE 25~30 倍，按质地与增速打折）；已过「三大前提」体检'
        : '买点 = 合理PE带中枢 × (1 − 30% 安全边际)') + '</span></div>';
    var SP = stockPlan(F.amt.stock);
    if (SP && SP.picks.length) {
      function stTag(o) { return o.state === "buy" ? '<span class="c-up">● 已达买点</span>' : (o.state === "wait" ? '<span class="c-warn">○ 距买点 +' + num(o.dist, 1) + '%</span>' : '<span class="muted">待观察 +' + num(o.dist, 1) + '%</span>'); }
      h += '<div class="muted small" style="margin-bottom:4px">选股 = 三层门槛（距 ' + SP.mos + '% 安全边际买点 ≤' + STK_MAX_DIST + '% + 综合分≥6.5 + 护城河分象限：稳增长≥7、高增长≥6、热点/十倍≥5.5）× 象限配额（稳增长 40% / 高增长 30% / 热点 15%+5% 备用金 / 十倍 10%，与投资组合页热点 20% 同口径）。' +
        '<b>核心资产优先</b>：综合分≥8 且护城河≥8.5 的标的（标 ★核心）在象限内优先占位，不被「跌得更深」的伪便宜压制。<b>只有「已达买点」才立即买首批</b>，其余挂条件单等触发。</div>';
      h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>标的</th><th>象限</th><th>现价</th><th>评级</th><th>' +
        (isLT ? "三年后合理估值" : "中性估值") + '</th><th>' + (isLT ? "理想买点(×50%)" : "买点价(" + SP.mos + "%折)") +
        '</th><th>状态</th><th>分配</th><th>三批触发价（40/30/30）</th><th>' + (isLT ? "卖出参考" : "卖出参考价") + '</th></tr></thead><tbody>';
      for (var si = 0; si < SP.picks.length; si++) {
        var o = SP.picks[si];
        var tr = o.tranches;
        h += '<tr><td><b>' + esc(o.name) + '</b>' + (o.core ? '<span class="core-chip">★核心</span>' : '') + '<span class="muted small"> ' + fmtCode(o.code) + '</span></td><td class="small">' + CAT[o.catKey].label + '</td><td>' + num(o.px, 2) + '</td><td>' + o.grade + '<span class="muted small"> ' + num(o.score, 1) + '</span></td>' +
          '<td>' + num(o.mid, 2) + '</td><td><b>' + num(o.buy, 2) + '</b></td><td class="small wrapcol">' + stTag(o) + '</td><td>' + num(o.amt, 1) + ' 万</td>' +
          '<td class="small wrapcol">' + num(tr[0].p, 2) + ' / ' + num(tr[1].p, 2) + ' / ' + num(tr[2].p, 2) + '</td>' +
          '<td class="small">' + (o.hi ? num(o.hi, 2) : '—') + '</td></tr>';
      }
      h += '</tbody></table></div>';
      if (isLT) {
        var exc = [];
        for (var xi = 0; xi < S.length; xi++) {
          var sx = S[xi];
          if (!ltValue(sx)) { exc.push(sx.name + "（无正 EPS 基准，无法估值）"); continue; }
          var pf = ltPremise(sx);
          if (pf.length) exc.push(sx.name + "（" + pf[0] + "）");
        }
        h += '<div class="muted small" style="margin-top:6px"><b>老唐法额外筛掉的 ' + exc.length + ' 只：</b>' + esc(exc.join("；")) +
          ' —— 老唐「看不懂不做」，这些只作观察，不进组合。切换到「合理PE带法」可看到它们。</div>';
        h += '<div class="muted small" style="margin-top:4px"><b>买点怎么来的：</b>三年后 EPS = 基准 EPS × 机构一致预期三年倍数（A股用 2026E→2028E 年度一致预期，港股用季度一致预期同比衰减外推，无覆盖时用模型保守值 ×0.9）；' +
          '三年后 EPS × 合理 PE（无风险收益率 = 美债十年期 ' + num(LT_CFG.rf, 2) + '% 的倒数 ' + num(100 / LT_CFG.rf, 1) + ' 倍，高杠杆 ×0.7、重资本/周期 ×0.8，再按增速相对封顶 ×0.70~×1.05）= 三年后合理估值；× 50% 即理想买点（三年一倍）。<b>增速放缓时，三年后 EPS 与合理 PE 同时下调，买点自动变低</b> —— 这就是泡泡玛特、老铺黄金买点被压下来的原因。</div>';
      }
      h += '<div class="muted small" style="margin-top:6px">单只三批：首批 40%（现价 ≤ 买点价立即执行）、再跌 8% 补 30%、再跌 15% 补满 30%。卖出参考 = ' +
        (isLT ? '「三年后合理估值 × 150%」与「基准 EPS × 50 倍」孰低' : '中性估值 × 合理 PE 上沿') + '，到价分批止盈。' +
        (SP.alts.length ? '<br>备选（等跌进买点再用 ' + w2(SP.reserve) + ' 备用金）：' + SP.alts.map(function (a) { return esc(a.name) + '（买点 ' + num(a.buy, 2) + '，' + (a.dist > 0 ? '还差 +' + num(a.dist, 1) + '%' : '已低于买点 ' + num(-a.dist, 1) + '%') + '）'; }).join('、') + '。' : '') +
        '</div>';
      h += '<div class="note" style="margin-top:8px"><b>买入节奏纪律：</b>首批本金约 <b>' + num(SP.first, 1) + ' 万</b>（' + SP.nBuy + ' 只已达买点，本周即可买）；' +
        '剩余 ' + num(SP.alloc - SP.first, 1) + ' 万全部挂条件单（每周三检查一次触发）。若第 ' + Math.max(1, F.STK_W - 2) + ' 周结束仍有标的未触发，' +
        '按<b>「距离最近者优先」</b>补足到其计划金额的 70%，避免永久空仓 —— ' + F.STK_W + ' 周是参考上限而非时间表。</div>';
      h += '<div class="note" style="margin-top:8px"><b>卖出纪律（补上此前缺失的退出规则）：</b>' +
        '① <b>逻辑证伪即止损</b>：护城河或盈利质量评分下调 ≥2 分、或 ROE/毛利率连续两季明显恶化 → 无条件卖出，不扛单；' +
        '② <b>到价分批止盈</b>：现价触及卖出参考价（上表）先卖 1/3，之后每再涨 10% 再卖 1/3，直至清仓或回落至买点重新接回；' +
        '③ <b>估值过热减仓</b>：估值分位 &gt;80% 且护城河评分已下调时，直接减半。十倍空间类（波动大）严格执行止损，不设「等回本」。</div>';
    } else {
      h += '<div class="muted small">当前没有满足「安全边际 + 质量门槛」的标的，这笔钱留在货币端 —— 空仓等待也是执行的一部分。</div>';
    }

    // ④ 周度时间表
    var nowD = new Date();
    var dow = (nowD.getDay() + 6) % 7;                     // 周一 = 0
    var mon0 = new Date(nowD.getFullYear(), nowD.getMonth(), nowD.getDate() - dow);
    function dlab(i) { var d = new Date(mon0.getTime() + i * 7 * 86400000); return (d.getMonth() + 1) + "/" + (d.getDate() < 10 ? "0" : "") + d.getDate(); }
    var SHOW_W = 12;                                        // 逐周展示前 12 周，之后分段汇总
    h += '<div style="margin-top:12px"><b>④ 前 ' + SHOW_W + ' 周时间表（单位：万元）</b> <span class="muted small">W1 从 ' + dlab(0) + ' 起算（A股下一交易日开盘即可执行首笔）</span></div>';
    h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>周次</th><th>红利</th><th>纳指</th><th>股票</th><th>本周投入</th><th>累计投入</th><th>剩余货币</th><th>仓位进度</th></tr></thead><tbody>';
    for (var ri = 0; ri < Math.min(SHOW_W, F.rows.length); ri++) {
      var r = F.rows[ri];
      h += '<tr><td class="small">W' + r.wk + '<br><span class="muted">' + dlab(ri) + '</span></td><td>' + num(r.div, 1) + '</td><td>' + num(r.nas, 1) + '</td><td>' + num(r.stock, 1) + '</td>' +
        '<td><b>' + num(r.div + r.nas + r.stock, 1) + '</b></td><td>' + num(r.cum, 1) + '</td><td>' + num(F.cap - r.cum, 1) + '</td>' +
        '<td class="small">' + num(r.cum / F.cap * 100, 0) + '%</td></tr>';
    }
    function seg(a, b) {                                    // 1-based 闭区间汇总
      var s = { div: 0, nas: 0, stock: 0, last: null };
      for (var k = a; k <= b && k <= F.rows.length; k++) { var x = F.rows[k - 1]; s.div += x.div; s.nas += x.nas; s.stock += x.stock; s.last = x; }
      return s;
    }
    var segs = [
      [SHOW_W + 1, F.PW.valFrom + F.PW.val - 1, "红利估值仓收尾"],
      [F.PW.valFrom + F.PW.val, F.STK_W, "股票端择机 + 纳指续投"],
      [F.STK_W + 1, F.NAS_W, "仅纳指定投"]
    ];
    for (var si = 0; si < segs.length; si++) {
      var a = segs[si][0], b = segs[si][1];
      if (b < a || !F.rows[a - 1]) continue;
      var s = seg(a, b);
      if (!s.last) continue;
      h += '<tr class="muted"><td class="small wrapcol">W' + a + '~W' + b + '<br><span class="muted">' + segs[si][2] + '</span></td>' +
        '<td>' + (s.div > 0.05 ? num(s.div, 1) : "—") + '</td><td>' + num(s.nas, 1) + '</td><td>' + (s.stock > 0.05 ? num(s.stock, 1) : "—") + '</td>' +
        '<td><b>' + num(s.div + s.nas + s.stock, 1) + '</b></td><td>' + num(s.last.cum, 1) + '</td><td>' + num(F.cap - s.last.cum, 1) + '</td>' +
        '<td class="small">' + num(s.last.cum / F.cap * 100, 0) + '%</td></tr>';
    }
    var lastR = F.rows[F.rows.length - 1];
    h += '</tbody></table></div>';
    h += '<div class="muted small" style="margin-top:6px">第 ' + F.NAS_W + ' 周（' + dlab(F.NAS_W - 1) + ' 当周）全部到位：红利 ' + num(lastR.cumDiv, 1) + ' + 纳指 ' + num(lastR.cumNas, 1) + ' + 股票 ' + num(lastR.cumStk, 1) + ' = <b>' + num(lastR.cum, 1) + ' 万</b>，货币 ' + num(F.cap - lastR.cum, 1) + ' 万（' + F.w.cash + '%）即目标弹药池。</div>';

    // ⑤ 分支应对
    h += '<div style="margin-top:12px"><b>⑤ 三种行情下的应对</b></div>';
    h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>情形</th><th>红利端</th><th>纳指端</th><th>货币端</th></tr></thead><tbody>' +
      '<tr><td class="small wrapcol"><b>先涨</b>（红利股息率跌破 3.5%）</td><td class="small wrapcol">底仓照建，<b>估值仓暂停</b>（变贵就不加）</td><td class="small wrapcol">PE&gt;32 定投减半、&gt;36 停止并分批止盈</td><td class="small wrapcol">被动升高 —— 这是设计意图，等回调</td></tr>' +
      '<tr><td class="small wrapcol"><b>先跌</b>（红利跌破周线 BOLL 下轨）</td><td class="small wrapcol">底仓+估值仓照常，<b>弹药仓 ' + w2(F.parts.ammo) + ' 分 3 批</b>（每再跌 2~3% 一批）</td><td class="small wrapcol">跌破年线且 RSI&lt;35 → 定投加倍</td><td class="small wrapcol">按信号释放，可降到 20%</td></tr>' +
      '<tr><td class="small wrapcol"><b>横盘</b></td><td class="small wrapcol">严格按上表周度执行</td><td class="small wrapcol">按 1.0 倍匀速</td><td class="small wrapcol">逐周自然下降</td></tr>' +
      '</tbody></table></div>';

    // ⑥ 收益预期与纪律
    h += '<div class="note" style="margin-top:10px"><b>⑥ 收益预期（诚实版）：</b>' +
      '<b>建仓期前 ' + F.BUILD_W + ' 周（1 年）年化约 ' + pct(F.expBuild.neu, 1) + '</b>（乐观 ' + pct(F.expBuild.opt, 1) + '）—— 因为平均仓位只有红利 ' + num(F.avg.div, 0) + '% / 纳指 ' + num(F.avg.nas, 0) + '% / 股票 ' + num(F.avg.stock, 0) + '%，近 ' + num(F.avg.cash, 0) + '% 还躺在货币里；' +
      '<b>稳态（第 ' + F.NAS_W + ' 周后）中性 ' + pct(F.expSteady.neu, 1) + '、乐观 ' + pct(F.expSteady.opt, 1) + '</b>。' +
      '<br>想更快贴近目标，只有三条路，每条都对应更大波动：① 纳指定投压缩到 52 周（每周约 ' + num(F.amt.nas / 52, 2) + ' 万）；② 红利在利差 ≥3.0pp 时直接打到 47%~50%；③ 接受更低的货币下限（10%，见「整体投顾」页的进取模式）。' +
      '<br><b>纪律清单：</b>每周固定一天投纳指（不看行情，建议周三）；红利按周表投、只在重度提醒时额外加；股票端不追高、分批买；每 13 周（一个季度）检查一次偏离，单一模块偏离目标 ±5pp 以上才再平衡。</div>';
    h += '</div>';
    h += '<div class="muted small">' + window.DISCLAIMER + '</div>';
    $("fund-body").innerHTML = h;
  }
  function P_why() {
    var P = planState();
    return P && P.why && P.why.length ? P.why.join("、") : "无";
  }

  // 红利提醒策略回测（数据来源：backtest-dividend.js 生成的 data/divbt.js）
  function renderDivBT() {
    var B = window.DIVBT;
    if (!B || !B.legs) return '<div class="card"><h3>红利提醒策略回测</h3><div class="muted small">回测数据未加载（data/divbt.js 缺失）。运行 <code>node backtest-dividend.js</code> 生成后刷新。</div></div>';
    var m = B.meta, sim = B.sim, legs = B.legs, mix = sim.mix.m;
    function pp(v) { return v == null ? "—" : (v > 0 ? "+" : "") + num(v, 2) + "pp"; }
    function pc(v, d) { return v == null ? "—" : num(v, d == null ? 1 : d) + "%"; }
    function tagFor(e) {
      if (e == null) return '<span class="vchip v-na">—</span>';
      if (e > 1) return '<span class="vchip v1">有效</span>';
      if (e < -1) return '<span class="vchip v5">噪音</span>';
      return '<span class="vchip v3">中性</span>';
    }
    var h = '<div class="card"><h3>🧪 红利提醒策略回测 <span class="muted small">' + esc(m.start) + ' ~ ' + esc(m.end) + '（' + m.years + ' 年 / ' + m.weeks + ' 周）</span></h3>';
    h += '<div class="note verdict"><b>结论：</b>' + esc(B.verdict) + '</div>';

    // ① 机会频率与信号有效性
    var totalLow = 0;
    for (var li = 0; li < legs.length; li++) {
      var leg = legs[li];
      var lowSig = null;
      for (var q = 0; q < leg.signals.length; q++) if (leg.signals[q].key === "wklow") lowSig = leg.signals[q];
      if (lowSig) totalLow += lowSig.stat.count;
      h += '<div style="margin-top:10px"><b>' + esc(leg.name) + '</b> <span class="muted small">' + esc(leg.etf) + ' · 样本内买入持有 ' + pc(leg.buyHold) + ' · 股息率区间（锚定估算）' + num(leg.dyMin, 2) + '%~' + num(leg.dyMax, 2) + '%</span></div>';
      h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>提醒信号</th><th>次数</th><th>年均</th><th>后3月</th><th>超额</th><th>后1年</th><th>超额</th><th>胜率(基准)</th><th>判断</th></tr></thead><tbody>';
      for (var si = 0; si < leg.signals.length; si++) {
        var s = leg.signals[si], st = s.stat, hd = st.hold;
        h += '<tr><td class="small wrapcol">' + esc(s.name) + '</td><td><b>' + st.count + '</b></td><td>' + num(st.perYear, 1) + '</td>' +
          '<td>' + pc(hd[13].avg) + '</td><td class="' + cls(hd[13].excess) + '">' + pp(hd[13].excess) + '</td>' +
          '<td>' + pc(hd[52].avg) + '</td><td class="' + cls(hd[52].excess) + '">' + pp(hd[52].excess) + '</td>' +
          '<td>' + (hd[13].win == null ? "—" : num(hd[13].win, 0) + '%（' + num(hd[13].baseWin, 0) + '%）') + '</td>' +
          '<td>' + tagFor(hd[13].excess) + '</td></tr>';
      }
      for (var ci = 0; ci < leg.controls.length; ci++) {
        var c = leg.controls[ci], ch = c.stat.hold;
        h += '<tr class="muted"><td class="small wrapcol">' + esc(c.name) + '</td><td>' + c.stat.count + '</td><td>' + num(c.stat.perYear, 1) + '</td>' +
          '<td>' + pc(ch[13].avg) + '</td><td>' + pp(ch[13].excess) + '</td><td>' + pc(ch[52].avg) + '</td><td>' + pp(ch[52].excess) + '</td>' +
          '<td>' + (ch[13].win == null ? "—" : num(ch[13].win, 0) + '%（' + num(ch[13].baseWin, 0) + '%）') + '</td><td class="small">对照</td></tr>';
      }
      h += '</tbody></table></div>';
    }
    h += '<div class="muted small" style="margin-top:6px">「超额」= 信号后收益 − 全样本<b>任意一周买入</b>持有同样时间的平均收益。真正值得动手的<b>重度提醒</b>（周线 BOLL 下轨以下）两个标的合计 ' + totalLow + ' 次，年均 ' + num(totalLow / m.years, 1) + ' 次。对照组（无脑抄底 / 近4周跌5%就买）用来检验技术条件是否比"逢跌就买"更有信息量。</div>';

    // ② 组合层面
    h += '<div style="margin-top:14px"><b>组合层面：动态调仓 vs 固定仓位</b> <span class="muted small">（红利子账户 = 红利ETF + 货币，仓位 ' + m.wMin + '~' + m.wMax + '%，货币 ' + num(m.cash, 1) + '%/年）</span></div>';
    h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>策略</th><th>中证红利 年化</th><th>红利低波 年化</th><th>混合 年化</th><th>混合 回撤</th><th>平均仓位</th></tr></thead><tbody>';
    var defs = [
      ["提醒驱动（" + m.baseW + "% 基准 + 技术叠加）", "dyn"],
      ["<b>调整后规则</b>（利差档位 + 下轨 +5pp）", "dydyn"],
      ["调整前规则（利差档位 + 下轨 +3pp）", "dydyn3"],
      ["固定 " + m.baseW + "% 不调仓", "fixed40"],
      ["固定 30%（只留底仓）", "fixed30"],
      ["全仓 100%", "allin"]
    ];
    for (var di = 0; di < defs.length; di++) {
      var k = defs[di][1];
      h += '<tr><td class="small wrapcol">' + defs[di][0] + '</td><td>' + pc(sim.csi.m[k].cagr, 2) + '</td><td>' + pc(sim.lowvol.m[k].cagr, 2) + '</td><td><b>' + pc(mix[k].cagr, 2) + '</b></td><td>' + pc(mix[k].mdd) + '</td><td>' + num(mix.avgWBy[k] * 100, 1) + '%</td></tr>';
    }
    h += '<tr class="muted"><td class="small">每周定投（' + m.years + ' 年累计收益率）</td><td>' + pc(sim.csi.m.dca.ret) + '</td><td>' + pc(sim.lowvol.m.dca.ret) + '</td><td>' + pc(mix.dca.ret) + '</td><td>—</td><td>—</td></tr>';
    h += '</tbody></table></div>';
    h += '<div class="note" style="margin-top:8px"><b>读法：</b>纯技术信号驱动的调仓（提醒驱动）相比固定 ' + m.baseW + '%，年化只多 <b>' + pp(mix.dyn.excessVs40) + '</b> —— 单靠技术信号择时，增量很小；' +
      '真正的改善来自两点：① 用<b>股息率估值档位</b>定主基调；② 把<b>重度提醒（周线 BOLL 下轨以下）从 +3pp 加码到 +5pp</b> —— 调整后混合年化 <b>' + pc(mix.dydyn.cagr, 2) + '</b>，比调整前（' + pc(mix.dydyn3.cagr, 2) + '）' +
      '<b>' + pp(mix.dydyn.cagr - mix.dydyn3.cagr) + '</b>、比固定 ' + m.baseW + '% <b>' + pp(mix.dydyn.excessVs40) + '/年</b>。代价是重度提醒只在极低位出现（合计 ' + totalLow + ' 次），等于在这几次集中下注，样本小、别当稳定规律。<br>' +
      '6 年里平均仓位 ' + num(mix.avgW * 100, 1) + '%，加仓动作 ' + mix.adds + ' 次、减仓 ' + mix.cuts + ' 次，每次仅 2~5pp，属于"微调"而非择时。' +
      '全仓 100% 年化更高（' + pc(mix.allin.cagr, 2) + '）但回撤 ' + pc(mix.allin.mdd) + '，是 ' + m.wMin + '~' + m.wMax + '% 仓位的 ' + num(Math.abs(mix.allin.mdd / mix.dyn.mdd), 1) + ' 倍。</div>';

    // ③ 建议
    h += '<div style="margin-top:12px"><b>哪些提醒该保留、哪些该降级</b></div>';
    var advice = {
      ma250: "保留（+3pp）：中证红利上偏弱（3 个月内小幅跑输），红利低波上有效（+4.7pp），定位为「开始关注」",
      rsi: "保留（+2pp）：红利低波上 8 次触发、3 个月超额 +4.4pp、胜率 100%",
      triple: "保留为最高级别，但样本仅 1 次，别指望经常出现",
      wklow: "重点保留并已加码：<b>叠加从 +3pp 提到 +5pp</b>，3 个月超额 +5.4~6.3pp、1 年 +4.3~9.4pp，胜率 100%",
      wkmid: "<b>已降级为「观察」</b>：21 次触发、3 个月超额 −1.74pp，前后半段都为负，不再参与仓位叠加"
    };
    h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>提醒</th><th>判断</th><th>建议</th></tr></thead><tbody>';
    for (var lj = 0; lj < legs.length; lj++) {
      for (var sj = 0; sj < legs[lj].signals.length; sj++) {
        var sg = legs[lj].signals[sj], e = sg.stat.hold[13].excess;
        h += '<tr><td class="small wrapcol">' + esc(legs[lj].name) + ' · ' + esc(sg.name) + '</td><td>' + tagFor(e) + ' <span class="small">' + sg.stat.count + ' 次 / ' + pp(e) + '</span></td><td class="small wrapcol">' + advice[sg.key] + '</td></tr>';
      }
    }
    h += '</tbody></table></div>';
    h += '<div class="note" style="margin-top:8px"><b>已按回测结论调整代码：</b><br>' +
      '① <b>「周线 BOLL 中轨以下」降为观察项</b>，不再参与仓位叠加（提醒面板显示为"观察 · 不作为加仓依据"）；<br>' +
      '② <b>「周线 BOLL 下轨以下」从 +3pp 加码到 +5pp</b>，重度提醒仍是唯一建议动用货币端弹药的信号（年均约 ' + num(totalLow / m.years, 1) + ' 次）；<br>' +
      '③ 仓位主基调仍交给股息率（估值），技术信号只做微调 —— 回测里估值档位的年化贡献大于纯技术信号。</div>';

    // ④ 局限
    h += '<div class="muted small" style="margin-top:8px"><b>局限：</b>' + esc(m.note) + ' <b>样本偏差：</b>' + esc(m.caveat) + '</div>';
    h += '</div>';
    return h;
  }

  // 红利「卖出 / 止盈」策略回测（数据来源：backtest-sell.js 生成的 data/divbt-sell.js）
  function renderSellBT() {
    var S = window.DIVBT_SELL;
    if (!S || !S.legs) return '<div class="card"><h3>红利卖出 / 止盈回测</h3><div class="muted small">回测数据未加载（data/divbt-sell.js 缺失）。运行 <code>node backtest-sell.js</code> 生成后刷新。</div></div>';
    function pp(v) { return v == null ? "—" : (v > 0 ? "+" : "") + num(v, 2) + "pp"; }
    function pc(v, d) { return v == null ? "—" : num(v, d == null ? 1 : d) + "%"; }
    function tagSell(e) {
      if (e == null) return '<span class="vchip v-na">—</span>';
      if (e < -2) return '<span class="vchip v1">卖对</span>';
      if (e < -0.5) return '<span class="vchip v3">偏对</span>';
      return '<span class="vchip v5">卖错</span>';
    }
    var m = S.meta, legs = S.legs;
    var h = '<div class="card"><h3>💰 红利卖出 / 止盈回测 <span class="muted small">长样本交叉验证 · ' + esc(m.generatedAt) + '</span></h3>';

    // 结论
    h += '<div class="note verdict"><b>核心结论：</b>' +
      '年线上方 <b>5%~8%</b> 是有效的止盈区间 —— 三个样本上都表现为「之后 3~6 个月跑输随机基准 2~7pp」，且 <b>69%~87%</b> 的概率能在 26 周内以平均低 7%~9% 的价格买回。' +
      '但把止盈加进组合后，<b>它买来的是更小的回撤（−1~−5pp）和更多弹药，代价是 0.2~1.5pp 的年化</b>，不是免费午餐。<br>' +
      '<b>反例：</b>红利ETF 510880（12.8 年、年化 12% 的强趋势样本）上年线上方 8% 后 6 个月反而继续跑赢 <b>+13.8pp</b> —— 单边上行阶段止盈必然踏空，这就是代价的来源。<br>' +
      '<b>关键前提：利差档位本身就是第一层卖出机制</b>（价涨 → 股息率降 → 档位降 → 仓位降），止盈只是叠加在其上的技术确认层，所以它的边际年化收益必然很小。<br>' +
      '<b>本页结论 → 不采纳为执行规则：</b>信号层面有效 ≠ 组合层面有效。按「只有对收益有改善才采纳」的口径，' +
      '这套止盈<b>不写入「整体投顾」的仓位计算</b>（那里卖出完全由利差档位承担），只在本页保留完整研究，供以后利率环境或样本变化后复查。</div>';

    // ① 卖出信号：触发后收益
    h += '<div style="margin-top:10px"><b>① 卖出信号触发后，还涨不涨？（负超额 = 卖对了）</b></div>';
    for (var li = 0; li < legs.length; li++) {
      var leg = legs[li];
      h += '<div style="margin-top:10px"><b>' + esc(leg.name) + '</b> <span class="muted small">' + esc(leg.note) + ' · ' + leg.years + ' 年 / ' + leg.weeks + ' 周（' + esc(leg.start) + ' ~ ' + esc(leg.end) + '）</span></div>';
      h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>卖出信号</th><th>次数</th><th>年均</th><th>后3月</th><th>超额</th><th>后6月</th><th>超额</th><th>后1年</th><th>超额</th><th>26周内可回补</th><th>52周最大踏空</th><th>判断</th></tr></thead><tbody>';
      for (var si = 0; si < leg.signals.length; si++) {
        var s = leg.signals[si], st = s.stat, hd = st.hold;
        h += '<tr><td class="small wrapcol">' + esc(s.name) + '</td><td><b>' + st.count + '</b></td><td>' + num(st.perYear, 1) + '</td>' +
          '<td>' + pc(hd[13].avg) + '</td><td class="' + cls(hd[13].excess) + '">' + pp(hd[13].excess) + '</td>' +
          '<td>' + pc(hd[26].avg) + '</td><td class="' + cls(hd[26].excess) + '">' + pp(hd[26].excess) + '</td>' +
          '<td>' + pc(hd[52].avg) + '</td><td class="' + cls(hd[52].excess) + '">' + pp(hd[52].excess) + '</td>' +
          '<td>' + (hd[26].backRate == null ? "—" : num(hd[26].backRate, 0) + '%（均深 ' + pc(hd[26].backAvg) + '）') + '</td>' +
          '<td>' + pc(st.maxUpAvg) + '</td>' +
          '<td>' + tagSell(hd[26].excess) + '</td></tr>';
      }
      h += '<tr class="muted"><td class="small">随机基准（任意一周持有）</td><td>' + leg.base[13].n + '</td><td>—</td>' +
        '<td>' + pc(leg.base[13].avg) + '</td><td>—</td><td>' + pc(leg.base[26].avg) + '</td><td>—</td><td>' + pc(leg.base[52].avg) + '</td><td>—</td><td colspan="3"></td></tr>';
      h += '</tbody></table></div>';
    }
    h += '<div class="muted small" style="margin-top:6px">「超额」= 信号后收益 − 全样本<b>任意一周买入</b>持有同样时间的平均收益，<b>负得越多说明卖得越对</b>。' +
      '「可回补」= 之后 26 周内出现过比信号时低 2% 以上的价格（即有更低价格买回的机会），括号里是这段时间的平均最低点深度。' +
      '「最大踏空」= 之后 52 周内最高价相对信号价的涨幅，代表卖飞的代价。</div>';

    // ② 组合层面
    h += '<div style="margin-top:14px"><b>② 组合层面：加止盈 vs 不加</b> <span class="muted small">（红利子账户 = 红利 + 货币，货币 ' + num(m.cashRate, 1) + '%/年）</span></div>';
    h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>策略</th>' +
      legs.map(function (l) { return '<th>' + esc(l.name.split(" ")[0]) + '<br><span class="muted small">' + l.years + '年</span></th>'; }).join("") +
      '</tr></thead><tbody>';
    for (var di = 0; di < S.sim.length; di++) {
      var d = S.sim[di];
      h += '<tr><td class="small wrapcol">' + d.name + '</td>' +
        d.rows.map(function (r) { return '<td>' + pc(r.cagr, 2) + '<br><span class="muted small">回撤 ' + pc(r.mdd) + ' · 均仓 ' + num(r.avgW, 0) + '%</span></td>'; }).join("") +
        '</tr>';
    }
    h += '</tbody></table></div>';
    h += '<div class="tbl-scroll" style="margin-top:10px"><table class="tbl"><thead><tr><th>相对基准</th>' +
      legs.map(function (l) { return '<th>' + esc(l.name.split(" ")[0]) + '</th>'; }).join("") + '</tr></thead><tbody>';
    for (var dj = 0; dj < S.sim.length; dj++) {
      var d2 = S.sim[dj];
      if (d2.key === "buy" || d2.key === "f40") continue;
      h += '<tr><td class="small wrapcol">' + esc(d2.name) + '<br><span class="muted small">vs 只买不卖</span></td>' +
        d2.rows.map(function (r) { return '<td class="' + cls(r.dCagr) + '">年化 ' + pp(r.dCagr) + '<br><span class="small">回撤 ' + (r.dMdd > 0 ? "改善 " : "恶化 ") + num(Math.abs(r.dMdd), 1) + 'pp</span></td>'; }).join("") + '</tr>';
    }
    h += '</tbody></table></div>';

    // ③ 规则（研究用，未采纳）
    var R = S.rule;
    h += '<div style="margin-top:14px"><b>③ 被检验的规则（仅研究，未采纳为执行规则）</b></div>';
    h += '<div class="tbl-scroll"><table class="tbl"><thead><tr><th>层级</th><th>触发条件</th><th>动作</th><th>回补</th></tr></thead><tbody>' +
      '<tr><td><b>浮仓止盈</b></td><td class="small wrapcol">距 50 周年线 ≥ 阈值<br><span class="muted">阈值随利差动态：' + R.t1Cheap + '%（利差≥3.0pp 便宜）/ ' + R.t1Mid + '%（中性）/ ' + R.t1Rich + '%（利差&lt;2.0pp 偏贵）</span></td>' +
      '<td class="small">上限降到 <b>' + R.core + '%</b>（只留底仓）</td><td class="small">回落至 阈值×' + R.backRatio + ' 以下解除</td></tr>' +
      '<tr><td><b>底仓止盈</b></td><td class="small wrapcol">距年线 ≥ 阈值+' + R.t2Delta + '% 且（周线 BOLL 上轨以上 或 RSI&gt;70）</td>' +
      '<td class="small">上限降到 <b>' + R.core2 + '%</b></td><td class="small">回落至 ×' + R.t2BackRatio + ' 或过热消失</td></tr>' +
      '</tbody></table></div>';
    h += '<div class="note" style="margin-top:8px"><b>怎么读这几张表：</b><br>' +
      '① <b>年线上方 10% 以上反而别急着卖</b> —— 中证红利上 ≥12% 只有 8 次样本，且后 6 个月是正超额（趋势延续）；真正的甜区在 5%~8%。<br>' +
      '② <b>RSI&gt;70 是被低估的止盈信号</b> —— 红利ETF 上 11 次触发，后 6 个月超额 −15.8pp、91% 可回补，比单看年线更强，但出现频率低（年均 0.9 次）。<br>' +
      '③ <b>止盈阈值要随估值浮动</b> —— 利差宽（便宜）时把阈值抬到 12%（不轻易下车），利差收窄（偏贵）时压到 5%（早点兑现），这比固定 8% 在三个样本上都更稳。<br>' +
      '④ <b>底仓止盈极少触发</b>（历史占比 1%~3% 的周），它的价值是给极端过热留一个「真减仓」的出口，平时用不到。<br>' +
      '⑤ <b>反例必须说清楚：红利ETF 510880（12.8 年、年化 12%）上，年线上方 8% 后 6 个月反而继续跑赢 13.8pp</b> —— 单边上行阶段止盈必然踏空，' +
      '这正是「止盈要付出 0.2~1.5pp 年化」的来源。所以阈值做成动态：利差宽（便宜）时自动抬到 12%，不在便宜的时候轻易下车。</div>';
    h += '<div class="muted small" style="margin-top:8px"><b>局限：</b>' + esc(m.note) + '<br><b>样本口径：</b>' + esc(m.caveat) + '<br><b>数据覆盖：</b>' + esc(m.reach) + '</div>';
    h += '</div>';
    return h;
  }

  // ---------- 回测 ----------
  function seriesMetrics(px) {
    var n = px.length, rets = [];
    for (var i = 1; i < n; i++) rets.push(px[i] / px[i - 1] - 1);
    var total = px[n - 1] / px[0] - 1;
    var yrs = (n - 1) / 12;
    var cagr = Math.pow(px[n - 1] / px[0], 1 / yrs) - 1;
    var peak = px[0], mdd = 0;
    for (var j = 0; j < n; j++) { if (px[j] > peak) peak = px[j]; var dd = px[j] / peak - 1; if (dd < mdd) mdd = dd; }
    var mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
    var vol = Math.sqrt(rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (rets.length - 1)) * Math.sqrt(12);
    var dca = { cost: 0, shares: 0 };
    for (var m = 0; m < n; m++) { dca.cost += 10000; dca.shares += 10000 / px[m]; }
    var dcaVal = dca.shares * px[n - 1];
    return { total: total * 100, cagr: cagr * 100, mdd: mdd * 100, vol: vol * 100, dcaRet: (dcaVal / dca.cost - 1) * 100, dcaCost: dca.cost, dcaVal: dcaVal };
  }
  // 单资产净值序列（期初=1）
  function navOf(arr) { var o = []; for (var i = 0; i < arr.length; i++) o.push(arr[i] / arr[0]); return o; }
  // 组合净值：按月再平衡，权重函数 w(i) → {div, nas, stock, cash}
  function btBuild(wFn) {
    var AK = A.kline, n = AK.months.length;
    var cashM = Math.pow(1 + A.cash.rate / 100, 1 / 12) - 1;
    var nav = [1];
    for (var i = 1; i < n; i++) {
      var w = wFn(i);
      var rDiv = 0.5 * (AK.csi[i] / AK.csi[i - 1] - 1) + 0.5 * (AK.lowvol[i] / AK.lowvol[i - 1] - 1);
      var rNas = AK.nasdaq[i] / AK.nasdaq[i - 1] - 1;
      var rStk = AK.stock[i] / AK.stock[i - 1] - 1;
      var r = w.div / 100 * rDiv + w.nas / 100 * rNas + w.stock / 100 * rStk + w.cash / 100 * cashM;
      nav.push(nav[i - 1] * (1 + r));
    }
    return nav;
  }
  // 红利动态仓位：按当月利差档位决定（30%~50%，利差 = 股息率 − 10年国债），其余模块固定，现金吸收差额
  // 注：历史利差用「历史股息率 − 当前国债利率」近似（无国债历史序列，早期利差可能被高估）
  function btDivW(i) {
    var bondY = (A.bond10y && A.bond10y.v != null) ? A.bond10y.v : 1.75;
    var w1 = divLevel(A.dividend.csi.dyHist[i] - bondY).w, w2 = divLevel(A.dividend.lowvol.dyHist[i] - bondY).w;
    return Math.max(30, Math.min(50, Math.round((w1 + w2) / 2)));
  }
  window._btDivW = btDivW;               // 供自检脚本验证动态仓位边界
  function btStrategies() {
    var AK = A.kline, defs = [];
    if (A) {
      defs.push({ id: "plan", name: "整体投顾组合（红利 30~50% 动态调整）", color: "#d92c2c", nav: btBuild(function (i) { var d = btDivW(i); return { div: d, nas: 20, stock: 10, cash: 100 - d - 30 }; }) });
      defs.push({ id: "planfix", name: "整体组合（固定 40/20/20/10）", color: "#f59e0b", nav: btBuild(function () { return { div: 40, nas: 20, stock: 10, cash: 30 }; }) });
      defs.push({ id: "div", name: "红利组合（红利+低波 50/50）", color: "#b91c1c", nav: btBuild(function () { return { div: 100, nas: 0, stock: 0, cash: 0 }; }) });
      defs.push({ id: "csi", name: "中证红利ETF（515080）", color: "#ef7b7b", nav: navOf(AK.csi) });
      defs.push({ id: "lowvol", name: "红利低波ETF（512890）", color: "#f0a5a5", nav: navOf(AK.lowvol) });
      defs.push({ id: "nas", name: "纳斯达克100（纳指ETF 513100）", color: "#1d4ed8", nav: navOf(AK.nasdaq) });
      defs.push({ id: "stock", name: "巴菲特股票组合（等权5只）", color: "#d97706", nav: navOf(AK.stock) });
      defs.push({ id: "hs300", name: "沪深300ETF（510300 · 基准）", color: "#64748b", nav: navOf(AK.hs300) });
      defs.push({ id: "cash", name: "货币基金（1.5%/年）", color: "#0a8f4e", nav: (function () { var o = [], f = Math.pow(1.015, 1 / 12); for (var i = 0; i < AK.months.length; i++) o.push(Math.pow(f, i)); return o; })() });
      var sk = Object.keys(AK.stocks);
      for (var s = 0; s < sk.length; s++) {
        defs.push({ id: "st_" + sk[s], name: AK.stocks[sk[s]].n + "（个股）", color: "#8b5cf6", nav: navOf(AK.stocks[sk[s]].px) });
      }
    }
    defs.push({ id: "idx300", name: "沪深300指数（价格指数）", color: "#94a3b8", nav: navOf(K.sh000300) });
    return defs;
  }
  // 月度胜率：策略月收益跑赢基准的比例
  function winRate(a, b) {
    var win = 0, tot = 0;
    for (var i = 1; i < a.length; i++) { if (b[i] > 0) { tot++; if (a[i] / a[i - 1] > b[i] / b[i - 1]) win++; } }
    return tot ? win / tot * 100 : null;
  }
  var btView = "main";                        // 回测页子视图：main = 组合/个股回测；div = 红利提醒策略回测
  function renderBacktest() {
    var seg = '<div class="seg">' +
      '<button class="seg-btn' + (btView === "main" ? " active" : "") + '" onclick="window._btSwitch(\'main\')">组合 / 个股回测</button>' +
      '<button class="seg-btn' + (btView === "div" ? " active" : "") + '" onclick="window._btSwitch(\'div\')">红利策略回测（买入 + 卖出）</button>' +
      '</div>';
    if (btView === "div") {
      $("backtest-body").innerHTML = seg + renderDivBT() + renderSellBT() + '<div class="muted small">' + window.DISCLAIMER + '</div>';
      return;
    }
    var defs = btStrategies();
    var baseIdx = 0;
    for (var b = 0; b < defs.length; b++) if (defs[b].id === "hs300") baseIdx = b;
    function sel(id, def, onch) {
      var s = '<select id="' + id + '" onchange="' + onch + '">';
      for (var i = 0; i < defs.length; i++) s += '<option value="' + i + '"' + (i === def ? " selected" : "") + '>' + defs[i].name + '</option>';
      return s + '</select>';
    }
    var h = seg + '<div class="card"><b>' + (A ? A.kline.months.length : 36) + ' 个月回测</b>（' + (A ? A.kline.months[0] + " ~ " + A.kline.months[A.kline.months.length - 1] : "") +
      '，月K 前复权含分红再投 · 来源：腾讯自选股）' +
      '<div class="sliders" style="margin-top:8px"><label>回测策略（可用组合 / 单资产 / 个股）</label>' + sel("bt-asset", 0, "window._btDraw()") + '</div>' +
      '<div class="sliders" style="margin-top:8px"><label>对比基准</label>' + sel("bt-base", baseIdx, "window._btDraw()") + '</div>' +
      '<div class="muted small" style="margin-top:6px">组合类策略按<b>月度再平衡</b>近似；「红利动态」按当月利差档位在 30%~50% 间调仓，差额由货币仓位吸收（该规则只用估值，不含技术叠加）。</div></div>';
    h += '<div class="grid2"><div class="card"><h3>净值走势（期初=1）</h3><div id="bt-chart"></div></div><div class="card"><h3>策略指标对比</h3><div id="bt-metrics"></div></div></div>';
    h += '<div class="card" id="bt-edge"><h3>组合优势判断</h3><div id="bt-edge-body"></div></div>';
    h += '<div class="card"><h3>个股回测（与组合、基准横向对比）</h3><div style="overflow-x:auto"><table class="tbl" id="bt-stocks"></table></div>' +
      '<div class="muted small" style="margin-top:6px">个股为等权示例，用于观察"单押一只"与"组合持有"在收益、回撤、波动上的差异。</div></div>';
    h += '<div class="muted small">' + window.DISCLAIMER + '</div>';
    $("backtest-body").innerHTML = h;
    window._btDefs = defs;
    window._btDraw();
  }
  window._btSwitch = function (v) {
    btView = (v === "div") ? "div" : "main";
    renderBacktest();
  };
  window._btDraw = function () {
    var defs = window._btDefs;
    var idx = Number($("bt-asset").value), bidx = Number($("bt-base").value);
    if (!(idx >= 0 && idx < defs.length)) idx = 0;
    if (!(bidx >= 0 && bidx < defs.length)) bidx = 0;
    var cur = defs[idx], base = defs[bidx];
    drawLine("bt-chart", [{ name: cur.name, color: cur.color, data: cur.nav }, { name: base.name, color: "#94a3b8", data: base.nav }], (A ? A.kline.months : MON));
    var m = seriesMetrics(cur.nav), mb = seriesMetrics(base.nav);
    // 定投：每月投入 1 万（组合按当期权重买入）
    function dca(nav) { var cost = 0, sh = 0; for (var i = 0; i < nav.length; i++) { cost += 10000; sh += 10000 / nav[i]; } return { ret: (sh * nav[nav.length - 1] / cost - 1) * 100, val: sh * nav[nav.length - 1], cost: cost }; }
    var d = dca(cur.nav), db = dca(base.nav);
    function row(name, a, bb, fmt, better) {
      var good = better === "high" ? a >= bb : a <= bb;
      return '<tr><td>' + name + '</td><td class="' + (good ? "c-up" : "c-down") + '">' + fmt(a) + '</td><td class="muted">' + fmt(bb) + '</td><td class="muted small">' + (better === "high" ? (a - bb >= 0 ? "+" : "") : (a - bb <= 0 ? "" : "+")) + fmt(a - bb) + '</td></tr>';
    }
    var f1 = function (v) { return pct(v, 1); };
    var t = '<table class="tbl"><thead><tr><th>指标</th><th>' + esc(cur.name) + '</th><th>' + esc(base.name) + '</th><th>差异</th></tr></thead><tbody>';
    t += row("累计收益", m.total, mb.total, f1, "high");
    t += row("年化收益(CAGR)", m.cagr, mb.cagr, f1, "high");
    t += row("最大回撤", m.mdd, mb.mdd, f1, "low");
    t += row("年化波动率", m.vol, mb.vol, f1, "low");
    t += row("每月定投1万 · 收益率", d.ret, db.ret, f1, "high");
    t += '<tr><td>月度胜率（跑赢基准）</td><td colspan="3"><b>' + (winRate(cur.nav, base.nav) == null ? "—" : pct(winRate(cur.nav, base.nav), 0)) + '</b> <span class="muted small">共 ' + (cur.nav.length - 1) + ' 个月</span></td></tr>';
    t += '<tr><td>定投期末市值（累计投入 ' + (d.cost / 10000).toFixed(0) + ' 万）</td><td class="' + cls(d.ret) + '">' + (d.val / 10000).toFixed(1) + ' 万</td><td class="muted">' + (db.val / 10000).toFixed(1) + ' 万</td><td class="muted small">' + (d.val - db.val >= 0 ? "+" : "") + ((d.val - db.val) / 10000).toFixed(1) + ' 万</td></tr>';
    t += '</tbody></table><div class="muted small" style="margin-top:6px">定投收益为简单收益率（未年化）；组合曲线为月度再平衡近似，未计交易成本与税费。</div>';
    $("bt-metrics").innerHTML = t;

    // 组合优势结论
    var wr = winRate(cur.nav, base.nav);
    var e = '<div class="kv kvg k2">' +
      kvRow("年化超额", pct(m.cagr - mb.cagr, 1)) +
      kvRow("回撤改善", pct(Math.abs(mb.mdd) - Math.abs(m.mdd), 1) + ' <span class="muted small">（正=更小）</span>') +
      kvRow("波动改善", pct(mb.vol - m.vol, 1) + ' <span class="muted small">（正=更低）</span>') +
      kvRow("月度胜率", (wr == null ? "—" : pct(wr, 0))) +
      '</div>';
    var cal = m.vol > 0.0001 ? (m.cagr / m.vol) : null, calb = mb.vol > 0.0001 ? (mb.cagr / mb.vol) : null;
    var verdict = "";
    if (m.cagr >= mb.cagr && Math.abs(m.mdd) <= Math.abs(mb.mdd)) {
      verdict = "收益更高、回撤更小 —— 组合在<b>收益与风险两个维度同时优于基准</b>，说明分散 + 再平衡确实创造了优势。";
    } else if (m.cagr >= mb.cagr) {
      verdict = "收益更高但回撤/波动也更大 —— 超额收益来自承担了更多风险，需确认自己能扛住该回撤。";
    } else if (Math.abs(m.mdd) < Math.abs(mb.mdd)) {
      verdict = "收益低于基准，但回撤与波动明显更小 —— 组合的价值在于<b>更好的持有体验</b>（更容易拿住、更适合定投），代价是牛市中跑输。";
    } else {
      verdict = "收益与回撤都不占优 —— 该对比下组合未体现优势，需检查权重设定或拉长回测周期（3 年样本对红利类策略偏短）。";
    }
    e += '<div class="note" style="margin-top:8px"><b>结论：</b>' + verdict +
      '<br>收益风险比（年化/波动）：本策略 <b>' + (cal == null ? "—" : num(cal, 2)) + '</b> vs 基准 <b>' + (calb == null ? "—" : num(calb, 2)) + '</b>（越高越好）。' +
      '<br><span class="muted small">口径提示：单资产（如纯纳指）在牛市里会显著跑赢组合，但最大回撤也更大；判断组合优势应同时看「收益风险比」与「回撤」，而不是只看收益。</span></div>';
    $("bt-edge-body").innerHTML = e;

    // 个股回测表
    var st = '<thead><tr><th>标的</th><th>累计</th><th>年化</th><th>最大回撤</th><th>波动率</th><th>定投收益</th><th>收益/风险</th></tr></thead><tbody>';
    var picksIdx = [0];                        // 整体投顾组合
    for (var i = 0; i < defs.length; i++) if (defs[i].id === "hs300") picksIdx.push(i);
    for (var j = 0; j < defs.length; j++) if (defs[j].id.indexOf("st_") === 0 || defs[j].id === "stock" || defs[j].id === "csi" || defs[j].id === "nas") picksIdx.push(j);
    for (var p = 0; p < picksIdx.length; p++) {
      var dd = defs[picksIdx[p]], mm = seriesMetrics(dd.nav);
      var rr = mm.vol > 0.0001 ? mm.cagr / mm.vol : null;
      st += '<tr><td><span class="dot" style="background:' + dd.color + '"></span>' + esc(dd.name) + '</td>' +
        '<td class="' + cls(mm.total) + '">' + pct(mm.total, 1) + '</td><td class="' + cls(mm.cagr) + '">' + pct(mm.cagr, 1) + '</td>' +
        '<td class="c-down">' + pct(mm.mdd, 1) + '</td><td>' + pct(mm.vol, 1) + '</td>' +
        '<td class="' + cls(mm.dcaRet) + '">' + pct(mm.dcaRet, 1) + '</td><td><b>' + (rr == null ? "—" : num(rr, 2)) + '</b></td></tr>';
    }
    st += '</tbody>';
    $("bt-stocks").innerHTML = st;
  };
  function drawLine(elId, series, labels) {
    var Wd = 640, Ht = 300, padL = 46, padR = 12, padT = 14, padB = 28;
    var all = [];
    for (var s = 0; s < series.length; s++) for (var i = 0; i < series[s].data.length; i++) all.push(series[s].data[i]);
    var min = Math.min.apply(null, all), max = Math.max.apply(null, all);
    var pad = (max - min) * 0.06; min -= pad; max += pad;
    function X(i) { return padL + (Wd - padL - padR) * i / (labels.length - 1); }
    function Y(v) { return padT + (Ht - padT - padB) * (1 - (v - min) / (max - min)); }
    var svg = '<svg viewBox="0 0 ' + Wd + ' ' + Ht + '" width="100%">';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (Ht - padT - padB) * g / 4, gv = max - (max - min) * g / 4;
      svg += '<line x1="' + padL + '" y1="' + gy + '" x2="' + (Wd - padR) + '" y2="' + gy + '" stroke="#e5eaf2"/>';
      svg += '<text x="' + (padL - 6) + '" y="' + (gy + 4) + '" text-anchor="end" font-size="10" fill="#8a93a3">' + gv.toFixed(2) + '</text>';
    }
    for (var t = 0; t < labels.length; t += 6) {
      svg += '<text x="' + X(t) + '" y="' + (Ht - 8) + '" text-anchor="middle" font-size="10" fill="#8a93a3">' + labels[t] + '</text>';
    }
    for (var s2 = 0; s2 < series.length; s2++) {
      var pts = "";
      for (var i2 = 0; i2 < series[s2].data.length; i2++) pts += X(i2).toFixed(1) + "," + Y(series[s2].data[i2]).toFixed(1) + " ";
      svg += '<polyline points="' + pts + '" fill="none" stroke="' + series[s2].color + '" stroke-width="' + (s2 === 0 ? 2.5 : 1.5) + '"' + (s2 === 1 ? ' stroke-dasharray="5 4"' : '') + '/>';
    }
    var lastIdx = labels.length - 1;
    for (var s3 = 0; s3 < series.length; s3++) {
      svg += '<circle cx="' + X(lastIdx) + '" cy="' + Y(series[s3].data[lastIdx]) + '" r="3.5" fill="' + series[s3].color + '"/>';
      svg += '<text x="' + (X(lastIdx) - 8) + '" y="' + (Y(series[s3].data[lastIdx]) - 8) + '" text-anchor="end" font-size="11" font-weight="bold" fill="' + series[s3].color + '">' + series[s3].data[lastIdx].toFixed(2) + '</text>';
    }
    svg += '<rect x="' + (Wd - 200) + '" y="' + (padT + 2) + '" width="192" height="' + (series.length * 18 + 8) + '" fill="rgba(255,255,255,0.85)" stroke="#e5eaf2" rx="4"/>';
    for (var lg = 0; lg < series.length; lg++) {
      svg += '<line x1="' + (Wd - 194) + '" y1="' + (padT + 14 + lg * 18) + '" x2="' + (Wd - 178) + '" y2="' + (padT + 14 + lg * 18) + '" stroke="' + series[lg].color + '" stroke-width="2.5"/>';
      svg += '<text x="' + (Wd - 172) + '" y="' + (padT + 18 + lg * 18) + '" font-size="11" fill="#3a4252">' + series[lg].name + '</text>';
    }
    svg += '</svg>';
    $(elId).innerHTML = svg;
  }

  // ---------- 每日总结 ----------
  function reportMarkdown() {
    var P = picks();
    var L = [];
    L.push("# 每日投资总结 · " + M.generatedAt);
    L.push("");
    L.push("> 数据：A股 " + mktAsOf("A") + " / 港股 " + mktAsOf("HK") + " · 来源：腾讯自选股 · 个人投资助理自动生成");
    L.push("");
    L.push("");
    L.push("## 一、整体投顾组合（资产配置层）");
    L.push("");
    if (A) {
      var PW = planState(), w = PW.w;
      L.push("> 长期目标 " + TGOAL.lo + "%~" + TGOAL.hi + "%；四模块：红利（低估买入/高估卖出，30%~50%，按「股息率−10年国债利差」定档）· 纳斯达克100（只做指数定投 20%）· 货币基金（安全垫+弹药）· 巴菲特式股票 10%");
      L.push("");
      L.push("| 模块 | 建议仓位 | 依据 |");
      L.push("|---|---:|---|");
      var scM = PW.csi.dy - A.bond10y.v, slM = PW.lowvol.dy - A.bond10y.v;
      L.push("| 红利资产 | " + w.div + "% | 中证红利股息率 " + pct(PW.csi.dy, 2) + "（利差 " + num(scM, 2) + "pp，" + PW.lc.label + "）／红利低波 " + pct(PW.lowvol.dy, 2) + "（利差 " + num(slM, 2) + "pp，" + PW.ll.label + "）；基准仓 " + PW.base + "%" + (PW.add ? "，技术叠加 +" + PW.add + "pp" : "") + "；内部倾斜 " + PW.tilt.csi + "% / " + PW.tilt.lowvol + "% |");
      L.push("| 纳斯达克100 | " + w.nas + "% | PE-TTM " + num(PW.nas.pe, 2) + " 倍 → " + PW.nasLv.label + "，本期定投 " + num(PW.nasLv.mult, 1) + " 倍基准金额 |");
      L.push("| 货币/自由现金流 | " + w.cash + "% | 随红利仓位反向调节，作为抄底弹药 |");
      L.push("| 巴菲特式股票 | " + w.stock + "% | 见下文每日推荐与组合配比 |");
      L.push("");
      L.push("**红利买入/卖出档位（利差 = 股息率 − 10年国债，利差越宽越便宜）：** ≥3.5pp → 50%（上限）；3.0~3.5pp → 47%；2.5~3.0pp → 44%；2.0~2.5pp → 40%（标准）；1.5~2.0pp → 35%；1.0~1.5pp → 32%；<1.0pp → 30%（底仓，不再减，靠底仓吃息等下一轮）。**卖出侧不做额外技术止盈** —— 回测显示它只改善回撤、年化反而 −0.1~−1.5pp，减仓交给利差档位本身。");
      L.push("");
      L.push("**中证红利 vs 红利低波（两个标的表现与利差不同，分开看）：**");
      L.push("");
      L.push("| 维度 | 中证红利（000922·515080） | 红利低波（H30269·512890） |");
      L.push("|---|---|---|");
      var pcM = divPerf("csi"), plM = divPerf("lowvol");
      function sg(v) { return v == null ? "—" : (v > 0 ? "+" : "") + num(v, 1) + "%"; }
      L.push("| 现价 / 今日 | " + num(PW.csi.px, PW.csi.px < 10 ? 3 : 2) + "（" + (PW.csi.chg > 0 ? "+" : "") + pct(PW.csi.chg, 2) + "） | " + num(PW.lowvol.px, PW.lowvol.px < 10 ? 3 : 2) + "（" + (PW.lowvol.chg > 0 ? "+" : "") + pct(PW.lowvol.chg, 2) + "） |");
      L.push("| 股息率 / 利差 | " + pct(PW.csi.dy, 2) + " / " + num(scM, 2) + "pp | " + pct(PW.lowvol.dy, 2) + " / " + num(slM, 2) + "pp |");
      L.push("| 股息率近3年分位 | " + pct(PW.csi.dyPct, 0) + "（越高越便宜） | " + pct(PW.lowvol.dyPct, 0) + " |");
      L.push("| 利差档位 → 档位仓 | " + PW.lc.label + " → " + PW.lc.w + "% | " + PW.ll.label + " → " + PW.ll.w + "% |");
      L.push("| 近3年 年化/回撤/波动 | " + sg(pcM && pcM.cagr) + " / " + sg(pcM && pcM.mdd) + " / " + (pcM ? num(pcM.vol, 1) : "—") + "% | " + sg(plM && plM.cagr) + " / " + sg(plM && plM.mdd) + " / " + (plM ? num(plM.vol, 1) : "—") + "% |");
      L.push("| 距年线 / RSI / 52周位置 | " + pct(PW.csi.distMA250, 1) + " / " + num(PW.csi.rsi14, 0) + " / " + pct(PW.csi.pos52, 0) + " | " + pct(PW.lowvol.distMA250, 1) + " / " + num(PW.lowvol.rsi14, 0) + " / " + pct(PW.lowvol.pos52, 0) + " |");
      L.push("| 周线 BOLL 下轨（重度加仓触发价） | " + (PW.csi.wk ? num(PW.csi.wk.lower, PW.csi.px < 10 ? 3 : 0) + "（需再跌 " + pct(PW.csi.distWkLow, 1) + "）" : "—") + " | " + (PW.lowvol.wk ? num(PW.lowvol.wk.lower, PW.lowvol.px < 10 ? 3 : 0) + "（需再跌 " + pct(PW.lowvol.distWkLow, 1) + "）" : "—") + " |");
      L.push("| 红利内部倾斜（100 万折算） | " + PW.tilt.csi + "%（" + Math.round(w.div * PW.tilt.csi / 100 * 10000).toLocaleString() + " 元） | " + PW.tilt.lowvol + "%（" + Math.round(w.div * PW.tilt.lowvol / 100 * 10000).toLocaleString() + " 元） |");
      L.push("");
      L.push("**下一次加仓是什么、加多少（按 100 万总资产折算，钱从货币端划转）：**");
      L.push("");
      [["中证红利", "csi", PW.csi, PW.lc, PW.tc], ["红利低波", "lowvol", PW.lowvol, PW.ll, PW.tl]].forEach(function (p) {
        var rs = addPlanRows(p[1], p[2], p[3], p[4]);
        if (!rs.length) { L.push("- " + p[0] + "：已在最高档（利差 ≥3.5pp、档位仓 50%），暂无进一步加仓触发"); return; }
        rs.forEach(function (r) {
          L.push("- " + p[0] + "：**" + stripTag(r.trig) + "** → " + stripTag(r.how) + "，加 " + stripTag(r.add) + "，约 " + stripTag(r.amt) + "（" + stripTag(r.now) + "）");
        });
      });
      L.push("");
      L.push("> 当前红利总仓 " + PW.trim.raw + "%，上限 50%（还剩 " + (50 - PW.trim.raw) + "pp 空间）；多条同时触发按上表顺序执行、叠加后封顶 50%，单条分 2~3 批（每周一批）从货币端划转。");
      L.push("");
      L.push("**当前提醒：**");
      L.push("");
      for (var al = 0; al < PW.alerts.length; al++) {
        var a1 = PW.alerts[al], tn1 = alertTone(a1);
        if (a1.tone === "idle") continue;
        L.push("- [" + tn1.s + "] " + a1.tag + "：" + a1.name + "（当前 " + a1.now + "，" + (a1.ok ? "已触发" : a1.distText) + "）");
      }
      L.push("");
      L.push("**纳斯达克定投/止盈规则：** PE<24 → 2.0 倍定投；24~27 → 1.5 倍；27~32 → 1.0 倍；32~36 → 0.5 倍并每涨 5% 减 10%；>36 → 停止定投并每涨 5% 减 20%。");
      L.push("");
    } else {
      L.push("（整体投顾数据未加载）");
      L.push("");
    }
    L.push("## 二、市场概况");
    L.push("");
    L.push("| 指数 | 收盘 | 涨跌幅 | 60日 | 250日 |");
    L.push("|---|---:|---:|---:|---:|");
    for (var i = 0; i < M.indices.length; i++) {
      var ix = M.indices[i];
      L.push("| " + ix.name + " | " + ix.close + " | " + ix.chg + "% | " + ix.chg60d + "% | " + ix.chg250d + "% |");
    }
    L.push("");
    L.push("- 两市成交额 " + M.turnoverYi + " 亿元（10日均值的 " + M.turnoverVs10dPct + "%），风格上价值占优（60日：全指价值 +" + M.style.value60d + "% vs 全指成长 " + M.style.growth60d + "%）");
    L.push("- 全指 PE-TTM " + M.valuation.peTTM + "（10年分位 " + M.valuation.pePct10y + "%，" + M.valuation.date + "）");
    L.push("- 市场画像：情绪偏热 / 技术偏弱 / 估值偏高 / 缩量调整 → 建议控节奏、逢低分批");
    L.push("");
    L.push("## 三、今日关注标的");
    L.push("");
    L.push("> 估值分位＝当前 PE/PB/股息率在近 4 年逐月估值序列中的位置：PE、PB 分位越低越便宜，股息率分位越高越便宜；≤20% 为显著低估，>80% 为显著高估（口径：真实财报滚动 EPS / 每股净资产 + 不复权月K，并以当前 PE/PB 校准）。");
    var blocks = [["steady", "稳增长（底仓）"], ["growth", "高增长（进攻）"], ["rotate", "热点轮动（卫星）"], ["tenx", "十倍空间（期权，仓位≤10%）"]];
    for (var b = 0; b < blocks.length; b++) {
      var cat = blocks[b][0];
      L.push("");
      L.push("### " + blocks[b][1]);
      L.push("");
      L.push("| 标的 | 代码 | 现价 | 估值分位 | 关注理由 | " + (VAL_MODE === "lt" ? "老唐法：买点 / 三年后合理 / 卖出参考" : "目标价区间（模型）") + " |");
      L.push("|---|---|---:|---|---|---|");
      for (var j = 0; j < P[cat].length; j++) {
        var it = P[cat][j];
        var vs = valScore(it.s), vt = valTag(vs);
        L.push("| " + it.s.name + " | " + fmtCode(it.s.code) + " | " + it.s.px + " | " +
          (vs == null ? "—" : pct(vs, 0) + "（" + vt.t + "）") + " | " + it.reason + " | " + it.range + " |");
      }
    }
    L.push("");
    L.push("## 四、组合配比建议");
    L.push("");
    L.push("| 方向 | 配比 | 说明 |");
    L.push("|---|---:|---|");
    for (var k = 0; k < 4; k++) {
      var kk = ["steady", "growth", "rotate", "tenx"][k];
      L.push("| " + CAT[kk].label + " | " + ALLOC[kk] + "% | " + CAT[kk].desc + " |");
    }
    L.push("");
    // ---- 美股组合：与 A股/港股完全独立 ----
    if (US.length) {
      L.push("");
      L.push("## 五、美股组合（独立于 A股/港股）");
      L.push("");
      L.push("> 行情 " + mktAsOf("US") + "（美东）。美股与 A股/港股相关性较低，用于分散单一市场风险；标的池与配比与 A股/港股组合分开。");
      L.push("");
      if (UM.indices && UM.indices.length) {
        L.push("### 全球指数");
        L.push("");
        L.push("| 指数 | 收盘 | 涨跌幅 |");
        L.push("|---|---:|---:|");
        for (var gi = 0; gi < UM.indices.length; gi++) {
          var gx = UM.indices[gi];
          L.push("| " + gx.name + " | " + gx.close + " | " + (gx.chg > 0 ? "+" : "") + gx.chg + "% |");
        }
        L.push("");
      }
      var UP = usPicks();
      var ub = [["steady", "稳增长（底仓）"], ["growth", "高增长（进攻）"], ["rotate", "热点轮动（卫星）"], ["tenx", "十倍空间（期权，仓位≤5%）"]];
      for (var ub2 = 0; ub2 < ub.length; ub2++) {
        var ucat = ub[ub2][0];
        L.push("### " + ub[ub2][1]);
        L.push("");
        L.push("| 标的 | 代码 | 现价(USD) | PE | 估值信号 | 关注理由 | 参考价区间（模型） |");
        L.push("|---|---|---:|---:|---|---|---|");
        for (var uj = 0; uj < UP[ucat].length; uj++) {
          var uit = UP[ucat][uj], usg = usSignal(uit.s);
          L.push("| " + uit.s.name + " | " + usSym(uit.s) + " | " + uit.s.px + " | " + num(uit.s.pe, 1) + " | " +
            usg.t + " | " + uit.reason + " | " + uit.range + " |");
        }
        L.push("");
      }
      L.push("**美股配比：** 稳增长 " + US_ALLOC.steady + "% / 高增长 " + US_ALLOC.growth + "% / 热点轮动 " + US_ALLOC.rotate + "% / 十倍空间 " + US_ALLOC.tenx + "%（独立滑块可调）");
      L.push("");
      L.push("- 估值信号＝当前 PE 与合理 PE 带（模型假设）的比较，非历史估值分位");
      L.push("- 美股股息一般需缴 30% 预扣税；交易时段为北京时间 21:30~04:00；还需承担汇率波动");
      L.push("");
    }

    L.push("## 六、风险提示");
    L.push("");
    L.push("- 本报告由个人投资助理基于公开数据自动生成，估值为模型假设，不构成投资建议");
    L.push("- 主要风险：宏观数据不及预期、行业政策变化、个股业绩证伪");
    L.push("");
    L.push("---");
    L.push("");
    L.push(window.DISCLAIMER);
    return L.join("\n");
  }
  // ---------- Markdown → 可读 HTML（每日总结的「排版视图」；无外部依赖，只实现报告中实际用到的语法） ----------
  // 生成物仍以 Markdown 为准（复制 / 下载 / 上传飞书 / 历史留档），这里只是把它渲染成肉眼可读的版式：
  // 支持 #~#### 标题、**粗体**、`代码`、表格（含 :--- 对齐）、> 引用、- / 数字 列表、--- 分隔线、普通段落。
  function mdInline(s) {
    s = esc(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    return s;
  }
  function mdToHtml(md) {
    var lines = String(md == null ? "" : md).split("\n");
    var h = "", i = 0;
    while (i < lines.length) {
      var t = lines[i].trim();
      if (!t) { i++; continue; }
      if (/^(-{3,}|\*{3,})$/.test(t)) { h += "<hr/>"; i++; continue; }
      var mh = t.match(/^(#{1,4})\s+(.*)$/);
      if (mh) { h += "<h" + mh[1].length + ">" + mdInline(mh[2]) + "</h" + mh[1].length + ">"; i++; continue; }
      if (t.charAt(0) === ">") {                                   // 引用块（连续行合并）
        var q = [];
        while (i < lines.length && lines[i].trim().charAt(0) === ">") { q.push(lines[i].trim().replace(/^>\s?/, "")); i++; }
        h += "<blockquote>" + q.map(mdInline).join("<br/>") + "</blockquote>";
        continue;
      }
      if (t.charAt(0) === "|" && i + 1 < lines.length && /^\|[\s:\-|]+\|$/.test(lines[i + 1].trim())) {
        var cellsOf = function (row) {                              // 拆 | a | b | → ["a","b"]
          return row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (x) { return x.trim(); });
        };
        var aligns = cellsOf(lines[i + 1]).map(function (x) {       // :--- 左 / :---: 中 / ---: 右
          var lf = x.charAt(0) === ":", rt = x.charAt(x.length - 1) === ":";
          return (lf && rt) ? "center" : (rt ? "right" : (lf ? "left" : ""));
        });
        var ths = cellsOf(lines[i]);
        h += '<div class="tbl-scroll"><table><thead><tr>';
        for (var c1 = 0; c1 < ths.length; c1++) h += "<th>" + mdInline(ths[c1]) + "</th>";
        h += "</tr></thead><tbody>";
        i += 2;
        while (i < lines.length && lines[i].trim().charAt(0) === "|") {
          var tds = cellsOf(lines[i]);
          h += "<tr>";
          for (var c2 = 0; c2 < ths.length; c2++) {
            h += "<td" + (aligns[c2] ? ' style="text-align:' + aligns[c2] + '"' : "") + ">" +
              mdInline(tds[c2] == null ? "" : tds[c2]) + "</td>";
          }
          h += "</tr>";
          i++;
        }
        h += "</tbody></table></div>";
        continue;
      }
      if (/^[-*]\s+/.test(t)) {                                     // 无序列表
        h += "<ul>";
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) { h += "<li>" + mdInline(lines[i].trim().replace(/^[-*]\s+/, "")) + "</li>"; i++; }
        h += "</ul>";
        continue;
      }
      if (/^\d+\.\s+/.test(t)) {                                   // 有序列表
        h += "<ol>";
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) { h += "<li>" + mdInline(lines[i].trim().replace(/^\d+\.\s+/, "")) + "</li>"; i++; }
        h += "</ol>";
        continue;
      }
      var para = [];                                               // 普通段落：连续普通行合成一段
      while (i < lines.length) {
        var nt = lines[i].trim();
        if (!nt || nt.charAt(0) === "#" || nt.charAt(0) === ">" || nt.charAt(0) === "|" ||
          /^[-*]\s+/.test(nt) || /^\d+\.\s+/.test(nt) || /^(-{3,}|\*{3,})$/.test(nt)) break;
        para.push(nt); i++;
      }
      h += "<p>" + para.map(mdInline).join("<br/>") + "</p>";
    }
    return h;
  }
  window._mdToHtml = mdToHtml;

  var rptRaw = false;                                              // 每日总结视图开关：false=排版视图（默认），true=原文 Markdown
  function rptApplyView() {
    var v = $("report-view"), ta = $("report-out"), b = $("rpt-toggle");
    v.style.display = rptRaw ? "none" : "block";
    ta.style.display = rptRaw ? "block" : "none";
    if (b) b.textContent = rptRaw ? "切换排版视图" : "查看原文 Markdown";
  }
  window.rptToggleView = function () {
    rptRaw = !rptRaw;
    rptApplyView();
    flash(rptRaw ? "原文 Markdown 视图（复制 / 下载仍为 Markdown）" : "排版视图");
  };
  function buildReport() {
    var md = reportMarkdown();
    $("report-out").textContent = md;                              // 原文保留（复制 / 下载 / 旧测试兼容）
    $("report-view").innerHTML = mdToHtml(md);                    // 排版视图：肉眼可读的表格与标题
    rptApplyView();
  }
  window.copyReport = function () {
    var md = reportMarkdown();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(md).then(function () { flash("已复制到剪贴板"); }, function () { flash("复制失败，请手动全选文本框"); });
    } else { flash("当前环境不支持一键复制，请手动全选文本框"); }
  };
  window.downloadReport = function () {
    var md = reportMarkdown();
    var blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "每日投资总结_" + M.generatedAt + ".md";
    a.click();
    flash("已下载，可手动上传到飞书「个人投顾」文件夹");
  };
  function flash(msg) {
    var el = $("flash");
    el.textContent = msg;
    el.style.display = "block";
    setTimeout(function () { el.style.display = "none"; }, 2600);
  }

  // ---------- 历史留档 ----------
  // 说明：云服务（云数据库）未开通，数据持久化改用浏览器 localStorage（本机）。
  // 同一浏览器可跨会话保留；换设备、换浏览器或清理缓存会丢失，请用「导出 JSON」备份。
  var HKEY = "ia_history_v1";
  var HSTORE_OK = true;
  function hLoad() {
    try {
      var raw = window.localStorage.getItem(HKEY);
      var d = raw ? JSON.parse(raw) : null;
      if (!d || !d.snaps) d = { version: 1, snaps: [], reports: {} };
      if (!d.reports) d.reports = {};
      return d;
    } catch (e) { HSTORE_OK = false; return { version: 1, snaps: [], reports: {} }; }
  }
  function hSave(d) {
    try { window.localStorage.setItem(HKEY, JSON.stringify(d)); return true; }
    catch (e) { HSTORE_OK = false; return false; }
  }
  function todayKey() {
    var d = new Date();
    return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2);
  }
  function snapshotNow() {
    var P = picks();
    var pack = function (list) { return list.map(function (it) { return { code: it.s.code, name: it.s.name, px: it.s.px }; }); };
    var keys = ["steady", "growth", "rotate", "tenx"];
    var sum = 0, wdiv = 0, wsum = 0, cnt = 0;
    for (var a = 0; a < keys.length; a++) sum += ALLOC[keys[a]];
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i], share = sum > 0 ? ALLOC[k] / sum : 0, mem = P[k];
      if (!mem.length || share <= 0) continue;
      var dv = 0;
      for (var m = 0; m < mem.length; m++) { dv += mem[m].s.div; cnt++; }
      wdiv += (dv / mem.length) * share; wsum += share;
    }
    return {
      date: todayKey(), ts: Date.now(), mode: LIVE.on ? "实时" : "快照",
      indices: M.indices.map(function (o) { return { name: o.name, close: o.close, chg: o.chg }; }),
      picks: { steady: pack(P.steady), growth: pack(P.growth), rotate: pack(P.rotate), tenx: pack(P.tenx) },
      alloc: { steady: ALLOC.steady, growth: ALLOC.growth, rotate: ALLOC.rotate, tenx: ALLOC.tenx },
      wdiv: wsum > 0 ? wdiv / wsum : null, count: cnt
    };
  }
  function hRecord(force) {
    var d = hLoad(), key = todayKey(), existed = false;
    for (var i = 0; i < d.snaps.length; i++) {
      if (d.snaps[i].date === key) { existed = true; if (force) d.snaps[i] = snapshotNow(); break; }
    }
    if (!existed) d.snaps.push(snapshotNow());
    d.snaps.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
    var ok = hSave(d);
    return { ok: ok, added: !existed, updated: existed && !!force };
  }
  function navSeries(d) {
    var base = {}, bmBase = null, nav = [], bm = [], labels = [], keys = ["steady", "growth", "rotate", "tenx"];
    for (var i = 0; i < d.snaps.length; i++) {
      var s = d.snaps[i], tot = 0, cnt = 0;
      for (var k = 0; k < keys.length; k++) {
        var list = s.picks[keys[k]] || [];
        for (var m = 0; m < list.length; m++) {
          var c = list[m];
          if (c.px == null) continue;
          if (!(c.code in base)) base[c.code] = c.px;
          if (base[c.code] > 0) { tot += c.px / base[c.code]; cnt++; }
        }
      }
      nav.push(cnt ? tot / cnt : 1);
      var sh = (s.indices && s.indices[0]) ? s.indices[0].close : null;
      if (sh != null && sh > 0) { if (bmBase == null) bmBase = sh; bm.push(sh / bmBase); }
      else bm.push(bm.length ? bm[bm.length - 1] : 1);
      labels.push(String(s.date).slice(5));
    }
    return { nav: nav, bm: bm, labels: labels };
  }
  // ---------- 历史数据快照（data/snap-all.js，archive-snap.js 每日 18:00 归档） ----------
  function snapDates() {
    var m = window.SNAPS || {};
    return Object.keys(m).sort().reverse();
  }
  function snapChips(items) {
    var out = (items || []).map(function (x) {
      return '<span class="repitem" title="' + esc(x.r || "") + '">' + esc(x.n) + '</span>';
    }).join(" ");
    return out || '<span class="muted small">—</span>';
  }
  function snapListsHTML(L) {
    if (!L) return "";
    var cats = [["steady", "稳增长"], ["growth", "高增长"], ["rotate", "热点轮动"], ["tenx", "十倍空间"]];
    var h = '<h4>当日名单</h4><div class="tbl-scroll"><table class="tbl"><tbody>';
    h += '<tr><td class="muted small" style="width:150px">每日推荐（A股港股）</td><td class="wrapcol">' +
      cats.map(function (c) { return '<div class="small" style="margin:2px 0"><b>' + c[1] + '</b> ' + snapChips(L.picks[c[0]]) + '</div>'; }).join("") + '</td></tr>';
    h += '<tr><td class="muted small">建仓正式名单</td><td class="wrapcol">' +
      (L.formal || []).map(function (x) { return '<span class="repitem">' + esc(x.n) + ' <span class="muted">' + (x.d == null ? "" : (x.d <= 0 ? "已达买点" : "+" + num(x.d, 0) + "%")) + '</span></span>'; }).join(" ") + '</td></tr>';
    h += '<tr><td class="muted small">美股推荐</td><td class="wrapcol">' +
      cats.map(function (c) { return '<div class="small" style="margin:2px 0"><b>' + c[1] + '</b> ' + snapChips(L.usPicks[c[0]]) + '</div>'; }).join("") + '</td></tr>';
    h += '<tr><td class="muted small">筛选池</td><td class="small">A股港股 ' + (L.pool.AH || []).length + ' 只 · 美股 ' + (L.pool.US || []).length + ' 只</td></tr>';
    return h + '</tbody></table></div>';
  }
  function snapViewHTML(s) {
    var h = "";
    h += '<div class="small muted" style="margin:8px 0">行情截至：A股 ' + esc(s.asOfA || "—") + ' · 港股 ' + esc(s.asOfHK || "—") +
      (s.rfUS ? ' · 美债10Y ' + num(s.rfUS.v, 2) + '%（' + esc(s.rfUS.asOf || "") + '）' : '') +
      (s.turnoverYi != null ? ' · 两市成交 ' + num(s.turnoverYi, 0) + ' 亿' : '') + '</div>';
    if (s.indices && s.indices.length) {
      h += '<div style="margin-bottom:6px">' + s.indices.map(function (ix) {
        return '<span class="repitem">' + esc(ix.name) + ' ' + num(ix.close, 2) + ' <span class="' + cls(ix.chg) + '">' + (ix.chg > 0 ? "+" : "") + pct(ix.chg) + '</span></span>';
      }).join(" ") + '</div>';
    }
    h += snapListsHTML(s.lists);
    h += '<h4>A股港股行情（' + (s.ah || []).length + ' 只）</h4><div class="tbl-scroll"><table class="tbl"><thead><tr><th>标的</th><th>现价</th><th>涨跌</th><th>PE(静/前)</th><th>PB</th><th>股息</th><th>年内</th><th>PE分位</th></tr></thead><tbody>';
    (s.ah || []).forEach(function (x) {
      var vp = s.valPct && s.valPct[x.c] ? s.valPct[x.c].pe : null;
      h += '<tr><td><b>' + esc(x.n) + '</b><span class="muted small"> ' + fmtCode(x.c) + '</span></td><td>' + num(x.px, 2) + '</td>' +
        '<td class="' + cls(x.chg) + '">' + (x.chg > 0 ? "+" : "") + pct(x.chg) + '</td>' +
        '<td>' + num(x.pe, 1) + ' / ' + num(x.peF, 1) + '</td><td>' + num(x.pb, 2) + '</td><td>' + pct(x.div, 2) + '</td>' +
        '<td class="' + cls(x.ytd) + '">' + (x.ytd > 0 ? "+" : "") + pct(x.ytd) + '</td>' +
        '<td>' + (vp == null ? "—" : vp + "%") + '</td></tr>';
    });
    h += '</tbody></table></div>';
    h += '<h4>美股行情（' + (s.us || []).length + ' 只）</h4><div class="tbl-scroll"><table class="tbl"><thead><tr><th>标的</th><th>现价(USD)</th><th>涨跌</th><th>PE</th><th>年内</th><th>52周位置</th><th>市值(亿$)</th></tr></thead><tbody>';
    (s.us || []).forEach(function (x) {
      h += '<tr><td><b>' + esc(x.n) + '</b><span class="muted small"> ' + fmtCode(x.c) + '</span></td><td>' + num(x.px, 2) + '</td>' +
        '<td class="' + cls(x.chg) + '">' + (x.chg > 0 ? "+" : "") + pct(x.chg) + '</td><td>' + num(x.pe, 1) + '</td>' +
        '<td class="' + cls(x.ytd) + '">' + (x.ytd == null ? "—" : (x.ytd > 0 ? "+" : "") + pct(x.ytd, 1)) + '</td>' +
        '<td>' + (x.pos52 == null ? "—" : num(x.pos52, 0) + "%") + '</td><td>' + num(x.mc, 0) + '</td></tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }
  function snapInit() {
    var sel = $("snap-date");
    if (!sel) return;
    var dates = snapDates();
    sel.innerHTML = dates.map(function (d) { return '<option value="' + d + '">' + d + '</option>'; }).join("");
    if (dates.length) window.snapView(dates[0]);
  }
  window.snapView = function (date) {
    var sel = $("snap-date"), sv = $("snap-view");
    if (!sv) return;
    var m = window.SNAPS || {};
    var d = date || (sel ? sel.value : "");
    var s = m[d];
    if (!s) { sv.innerHTML = '<div class="muted small">没有 ' + esc(String(d)) + ' 的归档。</div>'; return; }
    sv.innerHTML = snapViewHTML(s);
  };
  function renderHistory() {
    var d = hLoad();
    var h = "";
    h += '<div class="card note"><b>数据存储位置：本机浏览器（localStorage）</b> —— 云服务（云数据库）未开通，因此留档<b>不会跨设备同步</b>，清理浏览器缓存或更换设备会丢失。建议定期点「导出 JSON」备份，换设备时用「导入」恢复。<span class="muted small">（当前存储状态：' + (HSTORE_OK ? "可用" : "不可用（浏览器禁用了本地存储）") + '）</span></div>';
    h += '<div class="card"><b>今日快照</b> <span class="muted small">记录当日推荐组合的价格与配比，用于回看"某天推了什么、后来怎样"</span>' +
      '<div class="btnrow"><button class="btn" onclick="window.hRecordNow()">立即记录/更新今日快照</button>' +
      '<button class="btn" onclick="window.hExport()">导出 JSON</button></div>' +
      '<div class="btnrow"><input type="file" id="h-import-file" accept="application/json,.json"><button class="btn" onclick="window.hImport()">导入 JSON</button>' +
      '<button class="btn" onclick="window.hClear()">清空留档</button></div></div>';
    h += '<div class="card"><b>📂 历史数据（按日期查看）</b> <span class="muted small">archive-snap.js 每日 18:00 归档当日行情与名单快照，选日期可回看任意一天的完整数据；全量原始快照另存于项目 archive 目录供后续复用</span>' +
      '<div class="btnrow"><select id="snap-date" style="padding:6px 8px;border:1px solid #d4dae3;border-radius:8px"></select> <button class="btn" onclick="window.snapView()">查看</button></div>' +
      '<div id="snap-view"><div class="muted small">选择日期后展示该日快照。</div></div></div>';
    if (!d.snaps.length) {
      h += '<div class="card"><div class="muted">还没有留档记录。点上方「立即记录/更新今日快照」开始，之后每次打开网页会自动记录当天第一条快照。</div></div>';
      $("history-body").innerHTML = h;
      snapInit();
      return;
    }
    var ns = navSeries(d);
    h += '<div class="grid2"><div class="card"><h3>组合净值走势（等权，首条=1）</h3><div id="h-chart"></div></div>';
    h += '<div class="card"><h3>留档明细</h3><div style="max-height:320px;overflow:auto"><table class="tbl"><thead><tr><th>日期</th><th>来源</th><th>上证</th><th>组合净值</th><th>加权股息</th><th>标的</th><th>报告</th><th></th></tr></thead><tbody>';
    for (var i = 0; i < d.snaps.length; i++) {
      var s = d.snaps[i];
      var sh = (s.indices && s.indices[0]) ? s.indices[0].close : null;
      h += '<tr><td>' + esc(s.date) + '</td><td>' + esc(s.mode) + '</td><td>' + num(sh, 2) + '</td><td>' + num(ns.nav[i], 3) + '</td><td>' + (s.wdiv == null ? "—" : pct(s.wdiv, 2)) + '</td><td>' + (s.count || 0) + '</td>' +
        '<td>' + (d.reports[s.date] ? '<a href="javascript:void(0)" onclick="window.hViewReport(\'' + s.date + '\')">查看</a>' : '<span class="muted">—</span>') + '</td>' +
        '<td><a href="javascript:void(0)" onclick="window.hDelSnap(\'' + s.date + '\')">删除</a></td></tr>';
    }
    h += '</tbody></table></div></div></div>';
    h += '<div class="card"><b id="h-report-title">报告查看</b> <span class="muted small">点击上方「查看」加载当日总结（排版展示，与「每日总结」页同版式）</span><div id="h-report-box" class="report-view report-view-sm"><div class="muted">点击留档明细中的「查看」加载当日总结。</div></div></div>';
    h += '<div class="muted small">' + window.DISCLAIMER + '</div>';
    $("history-body").innerHTML = h;
    if (d.snaps.length >= 2) {
      drawLine("h-chart", [
        { name: "推荐组合（等权）", color: "#dc2626", data: ns.nav },
        { name: "上证指数", color: "#94a3b8", data: ns.bm }
      ], ns.labels);
    } else {
      $("h-chart").innerHTML = '<div class="muted small">至少 2 条留档后显示走势图（当前 ' + d.snaps.length + ' 条）</div>';
    }
    snapInit();
  }
  window.hRecordNow = function () {
    var r = hRecord(true);
    flash(r.ok ? (r.added ? "已记录今日快照" : "已更新今日快照") : "保存失败：浏览器本地存储不可用");
    renderHistory();
  };
  window.hSaveReport = function () {
    var d = hLoad();
    d.reports[todayKey()] = reportMarkdown();
    if (hSave(d)) flash("已保存今日报告到历史留档");
    else flash("保存失败：浏览器本地存储不可用");
    if (curTab === "history") renderHistory();
  };
  window.hViewReport = function (date) {
    var d = hLoad(), md = d.reports[date];
    if (!md) { flash("该日没有保存报告"); return; }
    $("h-report-title").textContent = date + " 每日投资总结";
    $("h-report-box").innerHTML = mdToHtml(md);                   // 与「每日总结」页同版式排版展示
  };
  window.hDelSnap = function (date) {
    var d = hLoad();
    d.snaps = d.snaps.filter(function (s) { return s.date !== date; });
    delete d.reports[date];
    hSave(d); renderHistory(); flash("已删除 " + date + " 的留档");
  };
  window.hExport = function () {
    var d = hLoad();
    var blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "投资助理_历史留档_" + todayKey() + ".json";
    a.click();
    flash("已导出 " + d.snaps.length + " 条留档");
  };
  window.hImport = function () {
    var inp = $("h-import-file");
    if (!inp || !inp.files || !inp.files.length) { flash("请先选择 JSON 文件"); return; }
    var f = inp.files[0], r = new FileReader();
    r.onload = function () {
      try {
        var nd = JSON.parse(r.result);
        if (!nd || !nd.snaps) throw new Error("格式不正确");
        var cur = hLoad(), map = {};
        cur.snaps.forEach(function (s) { map[s.date] = s; });
        nd.snaps.forEach(function (s) { if (s && s.date) map[s.date] = s; });
        cur.snaps = Object.keys(map).sort().map(function (k) { return map[k]; });
        Object.keys(nd.reports || {}).forEach(function (k) { cur.reports[k] = nd.reports[k]; });
        if (hSave(cur)) flash("已导入，当前共 " + cur.snaps.length + " 条留档");
        else flash("导入失败：浏览器本地存储不可用");
        renderHistory();
      } catch (e) { flash("导入失败：文件格式不正确"); }
    };
    r.readAsText(f);
  };
  window.hClear = function () {
    if (!window.confirm("确定清空本机全部历史留档？该操作不可恢复，建议先导出备份。")) return;
    hSave({ version: 1, snaps: [], reports: {} });
    renderHistory();
    flash("已清空历史留档");
  };

  // ---------- 实时行情：浏览器直连腾讯行情接口（云端托管 7×24 可用，不依赖本地电脑） ----------
  // LIVE.qt 记录各市场行情接口返回的真实时间（A股/H股为北京时间，美股为美东时间），
  // 刷新成功后同步回写 M.asOfA / M.asOfHK / UM.asOfUS，避免「价格变了但日期还是快照日」的错觉。
  var LIVE = { on: false, time: "", lastTime: "", err: "", warn: "", pending: true, qt: { A: "", HK: "", US: "" } };
  var IX_CODES = [["sh000001", "上证指数"], ["sz399001", "深证成指"], ["sz399006", "创业板指"]];

  // 行情接口时间字段归一：20261008161457 / 2026\/10\/08 16:08:24 / 2026-10-08 09:34:20 → "2026-10-08 16:14"
  function normTime(t) {
    if (!t) return "";
    var s = String(t).trim();
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(s);
    if (m) return m[1] + "-" + m[2] + "-" + m[3] + " " + m[4] + ":" + m[5];
    var m2 = /^(\d{4})[-\/](\d{2})[-\/](\d{2})[ T](\d{2}):(\d{2})/.exec(s);
    if (m2) return m2[1] + "-" + m2[2] + "-" + m2[3] + " " + m2[4] + ":" + m2[5];
    return "";
  }
  // 市场归类：hk → HK，us → US，其余 → A
  function mktOf(code) {
    var c = String(code || "");
    if (c.indexOf("hk") === 0) return "HK";
    if (c.indexOf("us") === 0) return "US";
    return "A";
  }
  // 统一「数据时点」文案：有实时行情时间则显示到分钟，否则回落快照收盘日
  function mktAsOf(mkt) {
    var t = (LIVE.qt && LIVE.on) ? LIVE.qt[mkt] : "";
    if (t) return t.slice(5) + " 最新";
    var d = mkt === "A" ? M.asOfA : (mkt === "HK" ? M.asOfHK : (UM.asOfUS || "—"));
    return (d || "—") + " 收盘";
  }

  function asofText() {
    var q = LIVE.qt || {}, seg = [];
    if (q.A) seg.push("A股 " + q.A.slice(5));
    if (q.HK) seg.push("港股 " + q.HK.slice(5));
    if (q.US) seg.push("美股 " + q.US.slice(5));
    if (LIVE.on) return "实时行情 · " + (seg.length ? seg.join(" / ") : "更新于 " + LIVE.time) + (LIVE.warn ? " · " + LIVE.warn : "") + " · 来源：腾讯行情（浏览器直连）";
    if (LIVE.lastTime) return "实时行情 · 上次更新 " + LIVE.lastTime + "（本次刷新失败：" + LIVE.err + "，价格为上次成功获取值）";
    if (LIVE.pending) return "正在获取实时行情…（失败则回退快照：" + M.asOfA + " / " + M.asOfHK + "）";
    return "快照数据：A股 " + M.asOfA + " 收盘 · 港股 " + M.asOfHK + " 收盘" + (LIVE.err ? "（实时行情暂不可用：" + LIVE.err + "）" : "");
  }
  function setAsOf() {
    var el = $("asof-line");
    if (el) el.textContent = asofText();
  }
  function rerender() {
    if (curTab === "plan") renderPlan();
    else if (curTab === "divcmp") renderDivCmp();
    else if (curTab === "fund") renderFund();
    else if (curTab === "ah") renderAH();
    else if (curTab === "us") renderUS();
    else if (curTab === "backtest") renderBacktest();
    else if (curTab === "report") buildReport();
    else if (curTab === "history") renderHistory();
    else if (curTab === "detail") renderDetail();
  }
  function parseQuote(code) {
    var raw = window["v_" + code];
    if (!raw || typeof raw !== "string" || raw.indexOf("~") < 0) return null;
    var f = raw.split("~");
    var px = Number(f[3]), prev = Number(f[4]);
    if (!isFinite(px) || px <= 0) return null;
    var chg = (isFinite(prev) && prev > 0) ? (px / prev - 1) * 100 : 0;
    return { name: f[1], px: px, chg: chg, time: normTime(f[30]) };
  }
  function applyLive() {
    var hit = 0, t = "", qt = { A: "", HK: "", US: "" };
    function mark(mkt, tm) { if (tm && tm > qt[mkt]) qt[mkt] = tm; }   // 取该市场最新的一条时间
    for (var i = 0; i < S.length; i++) {
      var q = parseQuote(S[i].code);
      if (!q) continue;
      if (!S[i].px0) {                                    // 快照基准值，只记一次，避免多次刷新累积缩放
        S[i].px0 = S[i].px; S[i].pe0 = S[i].pe; S[i].peF0 = S[i].peF; S[i].pb0 = S[i].pb; S[i].div0 = S[i].div;
      }
      var f = q.px / S[i].px0;                            // 价格变动倍数
      S[i].px = q.px;
      S[i].chg = q.chg;
      S[i].pe = S[i].pe0 == null ? null : S[i].pe0 * f;   // 每股收益不变 → PE/PB 随价等比缩放
      S[i].peF = S[i].peF0 == null ? null : S[i].peF0 * f;
      S[i].pb = S[i].pb0 == null ? null : S[i].pb0 * f;
      S[i].div = S[i].div0 == null ? null : S[i].div0 / f; // 股息率与价格反向
      mark(S[i].mkt === "HK" ? "HK" : "A", q.time);
      if (q.time) t = q.time;
      hit++;
    }
    for (var j = 0; j < IX_CODES.length; j++) {
      var qi = parseQuote(IX_CODES[j][0]);
      if (!qi) continue;
      for (var k = 0; k < M.indices.length; k++) {
        if (M.indices[k].name === IX_CODES[j][1]) { M.indices[k].close = qi.px; M.indices[k].chg = qi.chg; }
      }
      mark("A", qi.time);
      hit++;
    }
    // 美股：EPS 已知 → PE 直接由最新价重算，比按比例缩放更准确
    for (var u = 0; u < US.length; u++) {
      var su = US[u], qu = parseQuote(su.code);
      if (!qu) continue;
      if (!su.px0) { su.px0 = su.px; su.eps0 = su.eps; su.div0 = su.div; }
      su.px = qu.px;
      su.chg = qu.chg;
      su.pe = (su.eps0 && su.eps0 > 0) ? qu.px / su.eps0 : null;
      su.div = (su.div0 == null) ? null : su.div0 * su.px0 / qu.px;   // 股息率与价格反向
      if (su.hi52 && su.lo52 && su.hi52 > su.lo52) {
        su.pos52 = Math.max(0, Math.min(100, (qu.px - su.lo52) / (su.hi52 - su.lo52) * 100));
      }
      mark("US", qu.time);
      if (qu.time) t = qu.time;
      hit++;
    }
    // 全球指数（恒生科技 / 纳斯达克 / 标普 等）
    for (var g = 0; g < UM.indices.length; g++) {
      var ug = UM.indices[g], qg = parseQuote(ug.code);
      if (!qg) continue;
      ug.close = qg.px;
      ug.chg = qg.chg;
      if (qg.time) ug.asOf = qg.time.slice(0, 10);   // 指数卡片的时点也跟着刷新
      mark(mktOf(ug.code), qg.time);
      hit++;
    }
    return { hit: hit, time: t, qt: qt };
  }
  // 刷新成功后把各市场的「数据时点」从快照日换成行情日，页面/报告里的日期才会跟着变
  function syncAsOf(qt) {
    if (qt && qt.A) {
      var d = qt.A.slice(0, 10);
      M.asOfA = d;
      if (window.ASSET) window.ASSET.asOfA = d;          // 整体投顾页读的资产层快照日
    }
    if (qt && qt.HK) M.asOfHK = qt.HK.slice(0, 10);
    if (qt && qt.US) {
      if (UM) UM.asOfUS = qt.US.slice(0, 10);
      if (window.ASSET) window.ASSET.asOfUS = qt.US.slice(0, 10);
    }
  }
  function loadLive(manual) {
    LIVE.pending = true; LIVE.err = "";
    setAsOf();
    var codes = [];
    for (var i = 0; i < S.length; i++) codes.push(S[i].code);
    for (var j = 0; j < IX_CODES.length; j++) codes.push(IX_CODES[j][0]);
    var codesUS = [];
    for (var u = 0; u < US.length; u++) {
      // 代码含点（如 BRK.B）在接口返回的 `v_usBRK.B="..."` 语句中会触发 ReferenceError 并中断整段脚本，故跳过其实时刷新
      if (US[u].code.indexOf(".") >= 0) continue;
      codesUS.push(US[u].code);
    }
    for (var g = 0; g < UM.indices.length; g++) codesUS.push(UM.indices[g].code);
    var batches = [codes, codesUS];                        // 分两批，避免单次请求代码过多
    var settled = false;
    var bi = 0, okCount = 0, failCount = 0;
    function finish(ok, err, r) {
      if (settled) return;
      settled = true;
      LIVE.pending = false;
      if (ok) {
        LIVE.qt = (r && r.qt) || { A: "", HK: "", US: "" };
        syncAsOf(LIVE.qt);                                // 日期跟着行情走
        LIVE.on = true;
        LIVE.time = (r && r.time) ? r.time : new Date().toLocaleString("zh-CN", { hour12: false });
        LIVE.lastTime = LIVE.time;
        // 部分批次失败时必须明示，避免用户误以为所有市场都是最新价
        LIVE.warn = failCount > 0 ? ("有 " + failCount + " 个市场行情获取失败，其余为最新值") : "";
        try { hRecord(false); } catch (e) { }   // 每天自动留档第一条快照
      } else {
        LIVE.on = false; LIVE.err = err; LIVE.warn = "";
      }
      setAsOf(); rerender();
      if (manual) flash(ok ? (LIVE.warn || "实时行情已更新") : "实时行情获取失败，已回退快照数据");
    }
    // 串行加载两批（A/H+指数 → 美股+全球指数），全部结束后统一 applyLive
    function nextBatch() {
      if (bi >= batches.length) {
        var r = applyLive();
        if (r.hit > 0) finish(true, "", r);
        else finish(false, failCount > 0 ? "网络不可达" : "返回数据为空", r);
        return;
      }
      var cur = batches[bi++];
      if (!cur.length) { nextBatch(); return; }
      // 先清空本批对应的全局变量：否则请求失败时会残留上一次的值，导致过期数据被当作最新行情
      for (var c = 0; c < cur.length; c++) { try { window["v_" + cur[c]] = null; } catch (e) { } }
      var s = document.createElement("script");
      s.charset = "gbk";                                  // 接口返回 GBK，用 script 标签加载可绕过 CORS
      s.onload = function () { okCount++; nextBatch(); };
      s.onerror = function () { failCount++; nextBatch(); };  // 单批失败不阻断，其余批继续
      s.src = "https://qt.gtimg.cn/q=" + cur.join(",");
      (document.getElementsByTagName("head")[0] || document.body).appendChild(s);
    }
    nextBatch();
    setTimeout(function () { finish(LIVE.on, LIVE.on ? "" : "请求超时"); }, 12000);
  }
  window.refreshLive = function () { loadLive(true); };
  // 测试钩子：注入行情时间后重渲染，用于验证「刷新后日期同步更新」
  window._liveTestHook = function (qt) {
    LIVE.on = true; LIVE.pending = false;
    LIVE.qt = { A: qt.A || "", HK: qt.HK || "", US: qt.US || "" };
    syncAsOf(LIVE.qt);
    setAsOf(); rerender();
  };

  // ---------- PWA：注册 Service Worker（离线可用 + 添加到主屏幕）----------
  // 注：不显示任何安装引导条，安装由用户在浏览器菜单中自行完成
  function setupPWA() {
    var nav = window.navigator || {};
    if (nav.serviceWorker && location.protocol === "https:") {
      try { nav.serviceWorker.register("sw.js").catch(function () {}); } catch (e) {}
    }
  }

  // 初始化
  $("disc-line").textContent = window.DISCLAIMER;
  showTab("plan");
  setAsOf();
  setupPWA();
  try { loadLive(false); } catch (e) { LIVE.pending = false; LIVE.err = "不支持"; setAsOf(); }
})();
