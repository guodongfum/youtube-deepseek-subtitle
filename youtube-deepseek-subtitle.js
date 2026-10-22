/*
 * YouTube App 字幕翻译 - DeepSeek
 * 适用:Shadowrocket (http-response)
 * 拦截:https://www.youtube.com/api/timedtext?...   (srv3 XML / json3)
 * 功能:把整份字幕按批次交给 DeepSeek 翻译后再返回给 App,实现双语/纯译文字幕
 *
 * 参数(模块 argument 传入,或在 $persistentStore 中写入同名 key 作为兜底):
 *   DEEPSEEK_API_KEY  DeepSeek API Key(必填)
 *   MODEL             模型名,默认 deepseek-chat
 *   TARGET_LANG       目标语言,默认 简体中文
 *   MODE              bilingual(原文+译文) | only(仅译文),默认 bilingual
 *   API_BASE          接口地址,默认 https://api.deepseek.com
 */

var TAG = "[YT-DeepSeek]";

/* ======================= 参数 ======================= */
function parseArgs() {
  var out = {};
  var raw = typeof $argument !== "undefined" ? $argument : "";
  if (raw && typeof raw === "object") {
    out = raw;
  } else if (typeof raw === "string" && raw) {
    raw.split("&").forEach(function (kv) {
      var i = kv.indexOf("=");
      if (i < 0) return;
      var k = kv.slice(0, i).trim();
      var v = decodeURIComponent(kv.slice(i + 1).trim());
      out[k] = v;
    });
  }
  // 未填写的占位符视为空
  Object.keys(out).forEach(function (k) {
    if (/^\{\{\{.*\}\}\}$/.test(out[k]) || out[k] === "null") out[k] = "";
  });
  return out;
}

function store(k) {
  try { return $persistentStore.read(k) || ""; } catch (e) { return ""; }
}

var ARGS = parseArgs();
var CFG = {
  apiKey: ARGS.DEEPSEEK_API_KEY || store("DEEPSEEK_API_KEY") || "",
  model: ARGS.MODEL || store("DEEPSEEK_MODEL") || "deepseek-chat",
  target: ARGS.TARGET_LANG || "简体中文",
  mode: (ARGS.MODE || "bilingual").toLowerCase(),
  base: (ARGS.API_BASE || "https://api.deepseek.com").replace(/\/+$/, ""),
  chunkSize: 15,   // 每次请求翻译的字幕条数(越小越快)
  concurrency: 40, // 并发请求数
  budget: parseFloat(ARGS.TIME_BUDGET) > 0 ? parseFloat(ARGS.TIME_BUDGET) : 5 // 脚本时间预算(秒),Shadowrocket 约 7 秒会强杀脚本
};
var DEADLINE = Date.now() + CFG.budget * 1000;
function remainSec() { return Math.max(1, Math.ceil((DEADLINE - Date.now()) / 1000)); }

function log(m) { console.log(TAG + " " + m); }

function notifyOnce(sub, msg) {
  // 同一类通知 60 秒内只发一次,避免刷屏
  try {
    var key = "YT_DS_NOTIFY_" + sub;
    var last = parseInt(store(key) || "0", 10);
    var now = Date.now();
    if (now - last < 60000) return;
    $persistentStore.write(String(now), key);
    $notification.post("YouTube 字幕翻译", sub, msg);
  } catch (e) {}
}

/* ======================= 工具函数 ======================= */
function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); })
    .replace(/&#x([0-9a-fA-F]+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 16)); })
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function encodeEntities(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cleanText(s) {
  return s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function getQuery(url, name) {
  var m = url.match(new RegExp("[?&]" + name + "=([^&]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

/* ======================= DeepSeek 调用 ======================= */
var FATAL = false; // 401/402 等致命错误后不再继续请求

// items: [{id, text}] -> 返回 {id: 译文}(允许只返回部分),失败返回 null
function callDeepSeek(items) {
  return new Promise(function (resolve) {
    if (FATAL) return resolve(null);
    var sys =
      "你是专业的视频字幕翻译。用户给出一个 JSON 数组,每个元素形如 {\"id\":0,\"text\":\"原文\"}," +
      "是连续的字幕片段(可能来自语音识别,缺少标点、断句不完整)。" +
      "请结合上下文,把每条 text 翻译成" + CFG.target + ",译文口语化、简洁、符合字幕阅读习惯,专有名词/人名可保留原文。" +
      "严格要求:每个输入 id 都必须在输出中出现且只出现一次,不得合并、拆分或遗漏,不要解释。" +
      "只输出 json:{\"translations\":[{\"id\":0,\"text\":\"译文\"}]}";

    $httpClient.post({
      url: CFG.base + "/chat/completions",
      timeout: remainSec(),
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + CFG.apiKey
      },
      body: JSON.stringify({
        model: CFG.model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: JSON.stringify(items) }
        ],
        response_format: { type: "json_object" },
        temperature: 0.3,
        stream: false
      })
    }, function (err, resp, data) {
      try {
        if (err) throw new Error(String(err));
        var status = resp && (resp.status || resp.statusCode);
        if (status === 401) { FATAL = true; notifyOnce("API Key 无效", "请检查 DEEPSEEK_API_KEY"); throw new Error("401"); }
        if (status === 402) { FATAL = true; notifyOnce("余额不足", "DeepSeek 账户余额不足"); throw new Error("402"); }
        if (status !== 200) throw new Error("HTTP " + status + " " + String(data).slice(0, 120));
        var content = JSON.parse(data).choices[0].message.content;
        var arr = JSON.parse(content).translations;
        if (!Array.isArray(arr)) throw new Error("返回格式不对");
        var out = {};
        arr.forEach(function (x) {
          if (x && x.id != null && typeof x.text === "string" && x.text.trim()) {
            out[String(x.id)] = x.text.trim();
          }
        });
        return resolve(out);
      } catch (e) {
        log("请求/解析失败: " + e.message);
        return resolve(null);
      }
    });
  });
}

// 翻译一批;漏掉的条目会自动补译(第一轮整批补,第二轮每 5 条一组)
function translateChunk(items, round) {
  round = round || 0;
  return callDeepSeek(items).then(function (res) {
    var got = {};
    var missing = [];
    items.forEach(function (it) {
      if (res && res[String(it.id)]) got[String(it.id)] = res[String(it.id)];
      else missing.push(it);
    });
    if (!missing.length) return got;
    if (round >= 2 || FATAL || Date.now() > DEADLINE - 800) {
      log("仍有 " + missing.length + " 条未翻译,保留原文");
      return got;
    }
    log("补译 " + missing.length + " 条(第" + (round + 1) + "轮)");
    var sz = round === 0 ? missing.length : 5;
    var batches = [];
    for (var i = 0; i < missing.length; i += sz) batches.push(missing.slice(i, i + sz));
    return Promise.all(batches.map(function (b) { return translateChunk(b, round + 1); }))
      .then(function (rs) {
        rs.forEach(function (r) { Object.keys(r).forEach(function (k) { got[k] = r[k]; }); });
        return got;
      });
  });
}

function translateUnique(texts, map) {
  var items = texts.map(function (t, i) { return { id: i, text: t }; });
  var chunks = [];
  for (var i = 0; i < items.length; i += CFG.chunkSize) {
    chunks.push(items.slice(i, i + CFG.chunkSize));
  }
  var idx = 0;
  function worker() {
    if (idx >= chunks.length || Date.now() > DEADLINE) return Promise.resolve();
    var my = chunks[idx++];
    return translateChunk(my).then(function (res) {
      // 每批完成就立即写入 map,超时返回时已完成的部分不会丢
      my.forEach(function (it) { if (res[String(it.id)]) map[it.text] = res[String(it.id)]; });
      return worker();
    });
  }
  var workers = [];
  for (var w = 0; w < Math.min(CFG.concurrency, chunks.length); w++) workers.push(worker());

  return new Promise(function (resolve) {
    var done = false;
    function fin(why) {
      if (done) return;
      done = true;
      if (why) log(why);
      resolve(map);
    }
    Promise.all(workers).then(function () { fin(); });
    if (typeof setTimeout === "function") {
      setTimeout(function () {
        fin("达到时间预算(" + CFG.budget + "s),先返回已翻译部分,其余下次请求继续");
      }, Math.max(500, DEADLINE - Date.now()));
    }
  });
}

/* ======================= 缓存(按视频) ======================= */
function cacheKey(vid, lang) { return "YT_DS_CACHE_" + vid + "_" + lang + "_" + CFG.target; }

function loadCache(key) {
  try {
    var s = store(key);
    return s ? JSON.parse(s) : {};
  } catch (e) { return {}; }
}

function saveCache(key, map) {
  try {
    var s = JSON.stringify(map);
    if (s.length > 800000) return; // 过大不缓存
    $persistentStore.write(s, key);
    // 仅保留最近 5 个视频的缓存
    var keys = [];
    try { keys = JSON.parse(store("YT_DS_CACHE_KEYS") || "[]"); } catch (e) {}
    keys = keys.filter(function (k) { return k !== key; });
    keys.push(key);
    while (keys.length > 5) $persistentStore.write("", keys.shift());
    $persistentStore.write(JSON.stringify(keys), "YT_DS_CACHE_KEYS");
  } catch (e) {}
}

function composeText(orig, trans) {
  if (!trans) return orig;
  return CFG.mode === "only" ? trans : orig + "\n" + trans;
}

/* ======================= srv3 (XML) ======================= */
var P_RE = /<p\b([^>]*?)>([\s\S]*?)<\/p>/g;

function extractXmlText(inner) {
  var t = inner.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "");
  return cleanText(decodeEntities(t));
}

function processXml(xml, cacheMap) {
  var texts = [];
  var seen = {};
  var m;
  P_RE.lastIndex = 0;
  while ((m = P_RE.exec(xml))) {
    var t = extractXmlText(m[2]);
    if (t && !seen[t] && !cacheMap[t]) { seen[t] = 1; texts.push(t); }
  }
  log("XML 字幕待翻译 " + texts.length + " 条(去重后,已缓存 " + Object.keys(cacheMap).length + " 条)");

  return translateUnique(texts, cacheMap).then(function () {
    var out = xml.replace(P_RE, function (all, attrs, inner) {
      var orig = extractXmlText(inner);
      if (!orig) return all;
      var tr = cacheMap[orig];
      if (!tr) return all;
      return "<p" + attrs + '><s ac="0">' + encodeEntities(composeText(orig, tr)) + "</s></p>";
    });
    return { body: out, map: cacheMap, count: texts.length };
  });
}

/* ======================= json3 ======================= */
function processJson3(obj, cacheMap) {
  var events = obj.events || [];
  var texts = [];
  var seen = {};
  events.forEach(function (ev) {
    if (!ev.segs) return;
    var t = cleanText(ev.segs.map(function (s) { return s.utf8 || ""; }).join(""));
    if (t && !seen[t] && !cacheMap[t]) { seen[t] = 1; texts.push(t); }
  });
  log("json3 字幕待翻译 " + texts.length + " 条(去重后)");

  return translateUnique(texts, cacheMap).then(function () {
    events.forEach(function (ev) {
      if (!ev.segs) return;
      var orig = cleanText(ev.segs.map(function (s) { return s.utf8 || ""; }).join(""));
      if (!orig || !cacheMap[orig]) return;
      ev.segs = [{ utf8: composeText(orig, cacheMap[orig]) }];
      delete ev.wWinId; // 避免 ASR 逐词窗口干扰
    });
    return { body: JSON.stringify(obj), map: cacheMap, count: texts.length };
  });
}

/* ======================= 主流程 ======================= */
(function main() {
  try {
    var url = $request.url;
    var body = $response.body;

    log("脚本已触发 | key=" + (CFG.apiKey ? "已设置(" + CFG.apiKey.length + "位)" : "空") +
        " | body长度=" + (body ? body.length : 0) + " | " + url.slice(0, 90));

    if (!CFG.apiKey) {
      log("未读取到 API Key,跳过。请检查模块参数或直接把 Key 写进 argument");
      notifyOnce("未设置 API Key", "请在模块参数中填写 DEEPSEEK_API_KEY");
      return $done({});
    }
    if (!body || typeof body !== "string") return $done({});

    // 已经是 YouTube 自动翻译的字幕(tlang)或目标语言本身就是中文,不处理
    if (getQuery(url, "tlang")) return $done({});
    var lang = getQuery(url, "lang");
    if (/^zh/i.test(lang) && /中文/.test(CFG.target)) return $done({});

    var vid = getQuery(url, "v");
    var key = cacheKey(vid, lang);
    var cacheMap = loadCache(key);

    var trimmed = body.replace(/^\uFEFF/, "").trim();
    var job;
    if (trimmed.charAt(0) === "{") {
      var obj;
      try { obj = JSON.parse(trimmed); } catch (e) { return $done({}); }
      job = processJson3(obj, cacheMap);
    } else if (trimmed.indexOf("<timedtext") >= 0 || trimmed.indexOf("<transcript") >= 0 || trimmed.indexOf("<p ") >= 0) {
      job = processXml(body, cacheMap);
    } else {
      return $done({});
    }

    job.then(function (r) {
      if (r.count > 0) saveCache(key, r.map);
      var headers = $response.headers || {};
      Object.keys(headers).forEach(function (h) {
        var l = h.toLowerCase();
        if (l === "content-length" || l === "content-encoding") delete headers[h];
      });
      $done({ headers: headers, body: r.body });
    }).catch(function (e) {
      log("处理异常: " + e);
      $done({});
    });
  } catch (e) {
    log("脚本异常: " + e);
    $done({});
  }
})();
