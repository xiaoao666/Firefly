---
title: "Android 图片客户端的网络链路：OAuth/PKCE、QUIC 回退与可恢复下载"
published: 2026-07-22
updated: 2026-07-23
description: "从 OAuth/PKCE、opaque 分页和 JSON 归一化，到 DoH/Cronet 传输、图片域名路由与 DownloadManager 持久化，拆解一套 Android 图片客户端如何把不稳定因素关进边界。"
image: "/images/legacy/e10c03dd-641f-4bfe-a7f8-3692ce378d3a.jpg"
tags: ["java","Android","网络工程","客户端架构","性能优化"]
category: ""
draft: false
pinned: false
comment: true
author: "xiaoao"
sourceLink: ""
licenseName: ""
licenseUrl: ""
---
一张图片从“点开”到“落盘”，中间要经过的东西比瀑布流本身复杂得多：登录态可能过期，接口的分页游标不是页码，图片域名和 API 域名又是两套网络问题，最后还要把下载任务交给系统服务并在进程重启后恢复展示。真正值得拆的不是某个页面长什么样，而是这些不稳定因素被放在了哪些边界里。

下面按一套 Android 图片社区客户端的实际代码路径来复盘。项目名、域名、客户端密钥和可识别的第三方参数都做了脱敏；代码只保留能说明架构和失败处理的部分。

![Android 图片客户端网络与下载架构图](/images/legacy/fb082955-e8cc-474a-9b4c-88ca3188fa26.png "Android 图片客户端网络与下载架构图")

## 先把页面和网络隔开

页面层只拿 `ArtPage` 和 `ArtWork`，不直接拼 URL，也不直接碰 token。Fragment/Activity 负责生命周期、列表和交互；Repository 负责登录态、刷新、回退和本地状态合并；API client 只负责 HTTP 和 JSON 映射。这样做的价值不在于“分层看起来漂亮”，而在于网络策略可以替换：把系统 DNS 换成 DoH，或者把 OkHttp 的某一类请求转给 Cronet，UI 都不用改。

一个页面的最小数据对象大致是这样：

```java
public final class ArtPage {
    private final List<ArtWork> items;
    private final String nextUrl; // 服务端返回的 opaque continuation URL

    public ArtPage(List<ArtWork> items, String nextUrl) {
        this.items = Collections.unmodifiableList(new ArrayList<>(items));
        this.nextUrl = nextUrl == null ? "" : nextUrl;
    }

    public List<ArtWork> getItems() { return items; }
    public String getNextUrl() { return nextUrl; }
    public boolean hasNext() { return !nextUrl.isEmpty(); }
}
```

注意这里没有 `page=2`。分页 token 由服务端生成，客户端只把它当作不透明字符串保存和回传。客户端如果自己“修正”这个 URL，遇到服务端升级时就会出现很难定位的重复、漏项或 400。

## 登录：PKCE 保护的是授权码，不是客户端秘密

登录入口使用 OAuth 2.0 的授权码流程，并在移动端加上 PKCE。客户端随机生成 verifier，只把 challenge 放进浏览器跳转参数；回调回来后再用同一个 verifier 换 token。

```java
String verifier = randomVerifier();
prefs.edit().putString("pkce_verifier", verifier).apply();

String challenge = base64Url(
        sha256(verifier.getBytes(StandardCharsets.US_ASCII)));

return Uri.parse(LOGIN_URL).buildUpon()
        .appendQueryParameter("code_challenge", challenge)
        .appendQueryParameter("code_challenge_method", "S256")
        .appendQueryParameter("client", "android")
        .build().toString();
```

回调处理有三个容易被忽略的点：

1. verifier 是一次性的，交换成功后应删除；否则同一个回调被重复触发时，状态会变得含糊。
2. token 交换放在后台线程，UI 只接收成功或失败结果；网络异常不能卡住登录页。
3. access token 到期前留出安全窗口，提前 refresh，而不是等 API 返回 401 才在每个页面里各自重试。

还有一个经常被“逆向经验”掩盖的事实：APK 里的 `client\_secret` 无法被当作真正的秘密。它最终会出现在字符串、请求参数或运行时内存里。工程上应把它视为 public client 配置，真正需要保密的签名和高权限操作放到后端；至少也要做版本轮换、风控和速率限制。文章里的值全部删掉，不把可复用的凭据带出源码。

## API 映射：先稳定模型，再谈页面

接口返回的数据并不总是一个固定形状：单页作品在 `meta\_single\_page`，多页作品在 `meta\_pages`，小说又没有同样的图片字段。解析器把这些差异压成统一的 `ArtWork.pageUrls`，让详情页和下载器不必知道原始 JSON 的分支。

```java
private static ArtWork parseWork(JSONObject json) {
    if (json == null || json.optLong("id") == 0L) return null;

    JSONObject urls = json.optJSONObject("image_urls");
    String preview = firstNonEmpty(urls, "large", "medium", "square_medium");
    List<String> pages = new ArrayList<>();

    JSONObject single = json.optJSONObject("meta_single_page");
    if (single != null) {
        String original = single.optString("original_image_url", "");
        if (!original.isEmpty()) pages.add(original);
    }

    if (pages.isEmpty()) {
        JSONArray metaPages = json.optJSONArray("meta_pages");
        if (metaPages != null) for (int i = 0; i < metaPages.length(); i++) {
            JSONObject page = metaPages.optJSONObject(i);
            JSONObject pageUrls = page == null ? null
                    : page.optJSONObject("image_urls");
            String original = firstNonEmpty(pageUrls, "original", "large", "medium");
            if (!original.isEmpty()) pages.add(original);
        }
    }

    if (pages.isEmpty() && !preview.isEmpty()) pages.add(preview);
    String original = pages.isEmpty() ? preview : pages.get(0);
    return new ArtWork(id, title(json), author(json), type(json),
            preview, original, width(json), height(json), pages);
}
```

解析阶段还做了一次按 ID 的有序去重。这个动作看起来很小，但推荐流、相关作品和分页合并时经常会返回重复项；把去重放在数据层，所有页面都能共享同一套规则。

## Repository 的关键不是转发，而是定义失败语义

页面调用的是 `loadRecommended()`、`loadNext()` 和 `toggleBookmark()`，而不是直接调用 OkHttp。Repository 在进入 API 前先检查会话，在过期窗口内刷新，然后把本地收藏状态合并回模型。

```java
private void ensureFreshToken() {
    if (!session.isLoggedIn()) return;
    if (session.getExpiresAt() > System.currentTimeMillis() + 60_000L) return;

    AuthResult result = auth.refresh(session.getRefreshToken());
    if (result.success) session.saveAuth(result);
}

public ArtPage loadHomePage() {
    if (!session.isLoggedIn()) return demoPage();
    try {
        ensureFreshToken();
        return prepare(api.recommended(session.getAccessToken()));
    } catch (Exception error) {
        return demoPage();
    }
}
```

这里的“失败回退 Demo”适合保证首次打开仍有内容，但它也会隐藏真实网络错误。要做成长期维护的版本，最好把异常拆成 `AUTH\_EXPIRED`、`NETWORK\_UNAVAILABLE`、`REMOTE\_REJECTED`、`PARSE\_ERROR` 等类型：UI 可以继续展示缓存，同时给出可行动的提示；日志则保留 request path、HTTP code 和模型解析阶段。

## 传输策略：DoH、固定回退和 Cronet 各自解决什么

图片和 API 的问题不完全一样。API 更关心连接建立和请求成功率，图片更关心域名可达性、Referer 和缓存。代码把网络模式放进 `NetworkSettings`，由构造 OkHttpClient 的地方统一选择策略：

```java
OkHttpClient.Builder builder = new OkHttpClient.Builder()
        .connectTimeout(18, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS);

if (NetworkSettings.DOH.equals(settings.mode())) {
    builder.dns(new SecurePixivDns());
}
if (NetworkSettings.DIRECT.equals(settings.mode())) {
    builder.dns(new SecurePixivDns())
           .addInterceptor(new CronetInterceptor(context));
}
OkHttpClient client = builder.build();
```

自定义 DNS 的重要细节是：只替换解析结果，不改原始 URL 的主机名。这样 TLS 的 SNI 和证书校验仍然针对原域名，而不是针对返回的 IP。DoH 请求失败后可以回退到系统 DNS 或少量经过验证的地址，但固定 IP 不是永久方案，运营商、CDN 和证书策略一变就会失效。

Cronet 适合承载 HTTP/3/QUIC，但上层业务仍然习惯 OkHttp 的同步 `Interceptor`。适配器的做法是：复制请求头和 body，启动 Cronet 的异步回调，用 `CountDownLatch` 等待结果，超时或失败时回到原始链路。

```java
call.start();
if (!latch.await(35, TimeUnit.SECONDS)) {
    call.cancel();
    return chain.proceed(request); // 传输层失败不应拖死业务层
}
if (error[0] != null || info[0] == null) {
    return chain.proceed(request);
}
return buildOkHttpResponse(request, info[0], bodyBytes);
```

这个桥接的代价也很明确：阻塞线程数、响应体拷贝和取消语义都要自己管理。线程池太小会把高峰期请求排队，响应体太大则会增加内存峰值。它不是“加上 QUIC 就一定更快”，而是给特定网络环境提供一个可回退的传输选项。

## 图片域名重写：不是字符串替换那么简单

图片加载通过 `GlideUrl` 统一注入 Referer，并把原始图片域名映射到可选镜像。评论贴图则单独保留官方静态域名，因为镜像并不一定提供同一套路径。

```java
public static String rewrite(Context context, String originalUrl) {
    if (originalUrl == null || originalUrl.isEmpty()) return "";
    String selected = mode(context);
    if (AUTO.equals(selected)) {
        selected = directMode(context) ? MIRROR : OFFICIAL;
    }
    if (OFFICIAL.equals(selected)) return originalUrl;
    String host = MIRROR_NL.equals(selected) ? "i.example.nl" : "i.example.re";
    return originalUrl.replace("i.original.example", host);
}

public static GlideUrl stamp(Context context, String url) {
    return new GlideUrl(keepOfficialStaticHost(url),
            new LazyHeaders.Builder()
                    .addHeader("Referer", "https://api.example.invalid/")
                    .build());
}
```

这里有两个工程判断：一是镜像切换只发生在展示层，模型里仍保留原始 URL，方便分享、重试和回滚；二是不同资源类型要有不同的路由规则，不能用一个全局 `replace()` 把所有 host 都改掉。

## 列表与线程：稳定 ID、比例占位和主线程提交

首页使用两列瀑布流，首行是横跨两列的 Hero，后面是按原图宽高计算比例的卡片。Adapter 开启 stable IDs，以作品 ID 作为键；分页合并时用 `LinkedHashMap` 保持服务端顺序并去重。

```java
executor.execute(() -> {
    ArtPage page = repository.loadNext(nextUrl);
    if (!isAdded()) return;

    requireActivity().runOnUiThread(() -> {
        LinkedHashMap<Long, ArtWork> unique = new LinkedHashMap<>();
        for (ArtWork item : allWorks) unique.put(item.getId(), item);
        for (ArtWork item : page.getItems()) unique.put(item.getId(), item);
        allWorks = new ArrayList<>(unique.values());
        adapter.setWorks(allWorks, repository.session().isLoggedIn());
    });
});
```

这段代码里 `isAdded()` 不是多余的防御：Fragment 可能在请求返回前被销毁。真正上线时还应把请求取消和页面生命周期绑定，避免无效任务继续占用连接；列表更新也可以从全量 `notifyDataSetChanged()` 升级到 DiffUtil，减少长列表的重绘。

## 下载：系统任务和应用元数据分开存

远程图片交给 Android `DownloadManager`，应用自己的 `DownloadStore` 只记录任务 ID、标题、作者、预览图和作品 ID。这样进程退出后仍能通过系统服务查询真实进度，应用层只负责把任务重新投影成列表。

```java
DownloadManager.Request request = new DownloadManager.Request(
        Uri.parse(PixivImages.rewrite(activity, work.getOriginalUrl())));
request.addRequestHeader("Referer", "https://api.example.invalid/");
request.setNotificationVisibility(
        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
request.setDestinationInExternalPublicDir(
        Environment.DIRECTORY_PICTURES, "ClientGallery/" + fileName(work) + ".jpg");

long taskId = manager.enqueue(request);
new DownloadStore(activity).add(taskId, work);
```

Android 10 以后本地写入走 MediaStore 的 `IS\_PENDING`：先写入临时状态，流关闭后再提交为可见媒体。旧版本才需要申请外部存储权限。这个分支不是为了兼容表面上的 API 号，而是为了避免半文件出现在用户相册里。

当前实现用定时查询刷新任务列表，优点是简单，缺点是页面停留时会产生周期性查询。可以进一步监听系统广播、在 ViewModel 中集中轮询，或者只在任务状态发生变化时更新 UI。

## 搜索不是一个输入框，而是一组可组合约束

搜索参数被收进 `SearchOptions`：排序、匹配目标、最低收藏数、作品类型、时间范围、AI 类型和年龄分级。客户端只把有值的约束发给服务端，Demo 模式下再用同一对象做本地过滤，避免两种模式出现完全不同的交互。

```java
Map<String, String> query = mapOf(
        "word", word,
        "sort", options.sort,
        "search_target", options.target,
        "filter", "for_android");

if (options.bookmarkMin != null) {
    query.put("bookmark_num_min", String.valueOf(options.bookmarkMin));
}
if (options.startDate != null) query.put("start_date", options.startDate);
if (options.endDate != null) query.put("end_date", options.endDate);
query.put("search_ai_type", String.valueOf(options.aiType));
```

输入联想则用一个短延迟和 generation 计数器：旧请求即使晚返回，也不能覆盖用户已经输入的新关键词。这种“小状态机”比单纯加一个 debounce 更可靠。

## 如果要把它交付给别人，我会先补这些

- 把 SharedPreferences 中的长期 token 换成 Android Keystore 保护的存储，并在注销时清理所有派生缓存。
- 给网络层加指数退避、取消、连接复用指标和结构化错误；不要用一个空 catch 把授权失败伪装成空列表。
- 把客户端内置的 public 配置和真正的服务端秘密分离，建立轮换与撤销流程。
- 为 JSON 映射、分页去重、token 临界点、MediaStore 提交流程和 Cronet 回退补单元测试。
- 对图片镜像、评论和下载增加版权、隐私、速率限制与服务条款边界；兼容性工程不等于绕过服务端控制。

## 验证：先让工程过编译，再谈体验

这套源码在 JDK 11、Android SDK 36 环境下执行了下面的测试命令，Gradle 的 `app:test` 任务通过：

```powershell
.\gradlew.bat test --no-daemon
```

真正的设备验收还应覆盖：冷启动未登录、授权回调重复、token 临界过期、DoH 失败回退、QUIC 超时回退、单页与多页作品、下载中杀进程、MediaStore 写入失败以及镜像域名切换。能稳定走完这些分支，才说明这不是一个只能在演示机上跑通的 UI 样例。

## 小结

这类客户端最有价值的部分通常不在卡片颜色，而在“边界”：页面不拥有网络，Repository 不拥有渲染，图片 URL 不等于下载 URL，系统任务也不等于应用元数据。把这些边界写清楚，网络环境变化、接口字段变化和 Android 存储策略变化才不会一起把整个应用拖垮。
