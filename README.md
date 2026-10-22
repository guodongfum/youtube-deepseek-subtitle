# YouTube 字幕翻译(DeepSeek)

在 **Shadowrocket(小火箭)** 上通过 MITM 拦截 YouTube App 的字幕请求(`/api/timedtext`),交给 DeepSeek 翻译后回写给 App,从而在官方 YouTube App 里直接看到 **双语字幕** 或 **纯中文字幕**。

无需越狱、无需改 App、无需装插件,字幕仍然由 YouTube 自己的播放器渲染,时间轴完全对齐。

## 功能特点

- 支持 YouTube 字幕的两种格式:`srv3`(XML)与 `json3`
- 两种模式:`bilingual` 双语(原文 + 译文)/ `only` 仅译文
- 批量并发翻译(每批 15 条,并发 40),一次请求能翻多少翻多少
- 按视频缓存译文,重复拖动进度条不会重复消耗 Token
- 漏译自动补译两轮;超时自动返回已翻译部分,剩余部分下次请求继续
- 自动跳过 YouTube 自带翻译(`tlang`)和原本就是中文的字幕
- 401/402 等致命错误不再重试,并通过通知提醒(同类通知 60 秒内只发一次)

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `youtube-deepseek-subtitle.js` | Shadowrocket 的 `http-response` 脚本本体 |
| `youtube-deepseek-subtitle.sgmodule` | 模块文件,包含规则、脚本引用与参数声明 |

## 安装步骤

1. 打开 Shadowrocket → **配置** → 右上角 `+` → 类型选 **模块**,粘贴本仓库 `youtube-deepseek-subtitle.sgmodule` 的直链(或本地导入该文件)。
   
   直链示例:
   ```
   https://raw.githubusercontent.com/guodongfum/youtube-translate/refs/heads/master/youtube-deepseek-subtitle.sgmodule
   ```
   如果你想改脚本逻辑,请把 `sgmodule` 里的 `script-path` 换成**你自己托管**的 `youtube-deepseek-subtitle.js` 直链(GitHub raw / Gist / 自建服务器均可)。

2. 安装模块时会要求填写参数,**`DEEPSEEK_API_KEY` 必填**,其余可保持默认。

3. 开启 **HTTPS 解密(MITM)**:
   - 安装并信任 Shadowrocket 的 CA 证书(配置 → HTTPS → 安装证书,再到系统设置里信任)
   - 模块已自动追加 MITM 主机名 `www.youtube.com`

4. 开启 **QUIC 禁用**:模块已内置规则
   ```
   AND,((DOMAIN-SUFFIX,youtube.com),(PROTOCOL,UDP)),REJECT-NO-DROP
   ```
   强制 YouTube 走 TCP,否则 QUIC 无法解密。

5. 打开 YouTube App 播放一个**带英文字幕**的视频,字幕出现后即会被替换为译文。首次可能需要等待几秒。

## 参数说明

| 参数 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | 无 | DeepSeek API Key,形如 `sk-xxxx` |
| `MODEL` | 否 | `deepseek-chat` | 模型名 |
| `TARGET_LANG` | 否 | `简体中文` | 目标语言 |
| `MODE` | 否 | `bilingual` | `bilingual` 双语 / `only` 仅译文 |
| `API_BASE` | 否 | `https://api.deepseek.com` | 接口地址,可填中转/代理地址(不要带结尾斜杠) |
| `TIME_BUDGET` | 否 | `5` | 单次请求内最多翻译多少秒。Shadowrocket 约 7 秒强杀脚本,不建议超过 6 |

> 参数除了在模块里填写,也可以写入 Shadowrocket 的「持久化存储」(`$persistentStore`)同名 Key 作为兜底:`DEEPSEEK_API_KEY`、`DEEPSEEK_MODEL`。

修改参数:配置 → 选中该模块 → 右上角 `i` → **模块参数**。

## 工作原理

1. 规则匹配 `^https://www.youtube.com/api/timedtext?`,以 `http-response` 拿到字幕原文。
2. 解析出全部字幕文本并去重,减去缓存中已有的译文。
3. 按批调用 DeepSeek `/chat/completions`(`response_format: json_object`),要求按 `id` 逐条返回译文。
4. 把译文写回字幕结构(XML 的 `<p>` 或 json3 的 `segs`),双语模式下原文与译文用换行拼接。
5. 删除 `Content-Length` / `Content-Encoding` 响应头后回传给 App。
6. 译文按视频 ID + 源语言缓存,最多保留最近 5 个视频。

## 常见问题

**字幕没变化**
- 确认已信任 CA 且 MITM 已开启,日志里能看到 `[YT-DeepSeek] 脚本已触发`;
- 确认视频真的有**非中文**字幕(自动生成的也行),且字幕开关已打开;
- 确认没有开启 YouTube 自带的「自动翻译」(那会带 `tlang`,脚本会跳过)。

**日志提示「未设置 API Key」**
- 在模块参数里填 `DEEPSEEK_API_KEY`,然后**重新开关**一次模块让参数生效。

**只翻译了一部分**
- 受 `TIME_BUDGET` 限制,脚本会在超时前返回已完成部分;拖动进度条触发下一次字幕请求时会继续翻译剩余部分(已有缓存)。可适当调大 `TIME_BUDGET`,但不要超过 6。

**提示「余额不足 / API Key 无效」**
- 到 DeepSeek 控制台检查 Key 与账户余额。

## 费用与隐私

- 每个视频的字幕只翻译一次(之后走本地缓存),长视频可能产生较多请求,注意 DeepSeek 账户余额。
- 字幕原文会发送给 DeepSeek(或你自定义的 `API_BASE`)进行翻译。
- **不要把 API Key 硬编码进 `sgmodule` 或脚本并提交到公开仓库**,请使用模块参数填写;若 Key 曾泄露,请立即到控制台重新生成。

## 调试

Shadowrocket:配置 → 选中模块 → 右上角 `i` → **脚本日志**,筛选 `[YT-DeepSeek]` 查看触发、待翻译条数、补译与超时信息。
