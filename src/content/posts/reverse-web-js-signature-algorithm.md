---
title: "把浏览器脚本搬进 Node：基于运行时观测的 JS 补环境方法"
published: 2025-11-11
updated: 2026-07-23
description: "从 Python 子进程、jsdom 骨架、Proxy 环境观测到内部 dispatcher 入口，完整拆解大型浏览器脚本的离线执行与可复现验证。"
image: "/images/legacy/62f17d7d-7fcf-44c8-8738-3477d49664d0.jpg"
tags: ["js"]
category: ""
draft: false
pinned: false
comment: true
author: "xiaoao"
sourceLink: ""
licenseName: ""
licenseUrl: ""
---
## 问题不在算法，而在它离不开浏览器

把页面里截获的一段大型 JavaScript 直接丢给 Node，通常第一轮就会死在 `window is not defined`。补一个 `window` 后，下一轮又可能缺 `document`、`navigator`、`screen`、Cookie、计时器或 XHR。真正有价值的工作不是把每个报错机械地设成空对象，而是找出算法实际读取了哪些环境字段，并建立一个可复现、可观测、足够小的运行时闭包。

这个案例的实际链路是：Python 组织请求参数并创建 Node 子进程；Node 加载一份从浏览器拿到的原始脚本；jsdom 提供最低限度的 DOM 和 XMLHttpRequest；手工补丁负责 viewport、screen、navigator、Cookie 等稳定字段；最后恢复脚本内部的真实入口，把结果通过 stdout 交回 Python。

![浏览器脚本离线执行与补环境架构图](/images/legacy/e0502394-b9cd-4549-a168-b753c7f2bdda.png)

## 第一步：先固定跨语言调用边界

上层不要通过字符串拼接执行任意表达式，而是把输入固定成三个位置参数。这样 URL、User-Agent 和 Cookie 的边界清楚，Node 崩溃也不会污染主进程。

```python
def run_signature(query, user_agent, cookie_snapshot):
    proc = subprocess.run(
        ["node", "./runtime.js", query, user_agent, cookie_snapshot],
        capture_output=True,
        text=True,
        timeout=8,
        check=True,
    )
    match = re.search(r"result:\s*(.+)", proc.stdout)
    if not match:
        raise RuntimeError(proc.stderr or proc.stdout)
    return match.group(1)
```

原实现会重试两次，但吞掉了所有异常。工程化时应该保留 stderr、退出码和超时类型，否则“返回 False”无法区分环境缺失、脚本语法错误和入口已经变化。

## 第二步：jsdom 只提供骨架，不能替你伪造浏览器

jsdom 适合提供 DOM 类、事件和 XMLHttpRequest，但它不会自动生成真实的屏幕尺寸、平台字段、Cookie 上下文或站点私有全局变量。因此环境分成两层：标准接口交给 jsdom，算法明确读取的稳定字段手工补齐。

```js
const { JSDOM } = require("jsdom");
const [query, userAgent, cookieSnapshot] = process.argv.slice(2);

const dom = new JSDOM("<!doctype html><body></body>", {
  url: "https://example.invalid/",
  userAgent,
});

global.window = global;
global.XMLHttpRequest = dom.window.XMLHttpRequest;
global.document = dom.window.document;

Object.assign(global, {
  innerWidth: 1707,
  innerHeight: 791,
  outerWidth: 1707,
  outerHeight: 912,
  screenX: 0,
  screenY: 0,
});
```

`window = global` 的目的不是声称 Node 就是浏览器，而是保持脚本里多种全局寻址方式指向同一对象。否则脚本写入 `window.\_U`，入口却从另一个 global 读取，会出现非常隐蔽的状态分裂。

## 第三步：补环境靠观测，不靠猜字段大全

最有效的工具是给关键对象套 Proxy，记录 get/set。调试阶段开启日志，跑固定输入，缺什么就补什么；稳定后关闭日志，防止几万次属性访问拖慢执行。

```js
function traceObject(name, target = {}) {
  return new Proxy(target, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver);
      console.error("[env:get]", name, String(key), typeof value);
      return value;
    },
    set(obj, key, value, receiver) {
      console.error("[env:set]", name, String(key), typeof value);
      return Reflect.set(obj, key, value, receiver);
    },
  });
}

global.navigator = traceObject("navigator", { userAgent, platform: "Win32" });
global.screen = traceObject("screen", {
  width: 1707, height: 960, availWidth: 1707, availHeight: 912,
  colorDepth: 24, pixelDepth: 24,
});
```

日志要写 stderr，最终结果单独写 stdout。否则 Python 用正则解析结果时，环境追踪日志可能恰好包含相同前缀，造成偶发误判。

## 第四步：空函数不是万能补丁

`setTimeout = () => {}` 和 `fetch = () => {}` 能让部分初始化代码跳过去，但必须先确认算法只检查接口存在、不依赖回调结果。如果脚本通过 timer 延迟初始化内部表，空函数会让入口存在但状态未完成；如果它读取 fetch 的 Promise 链，返回 undefined 会把错误推迟到更深的位置。

```js
global.fetch = async (url) => {
  throw new Error("unexpected network access: " + String(url));
};

global.requestAnimationFrame = (callback) => {
  callback(0);
  return 1;
};

global.cancelAnimationFrame = () => {};
```

测试如果触发这里，就证明所谓的“本地签名”仍依赖外部副作用。

## 第五步：Cookie 必须进入同一个 document 上下文

如果先拿 jsdom 的 document，随后又把 document 替换成普通对象，Cookie setter 就会丢失；表面上赋值成功，读取时却永远为空。正确做法是保留 jsdom document，只补方法，而不是整体覆盖。

```js
const document = dom.window.document;
document.cookie = cookieSnapshot;

const originalCreateElement = document.createElement.bind(document);
document.createElement = function patchedCreateElement(tag) {
  const element = originalCreateElement(tag);
  if (tag === "canvas") {
    // 只在确认算法读取 canvas 时安装可控实现
  }
  return element;
};
```

## 第六步：不要重写几万行混淆代码，只恢复入口

算法主体已经在浏览器中运行过，最小改动原则是保留主体，只在尾部恢复参数布局和 dispatcher 调用。实际入口接收一个六项数组：三个控制字段、原始 query、空字符串和 User-Agent；随后通过内部状态表选择真实函数。

```js
const args = [0, 1, 0, query, "", userAgent];

function invokeInternal(argv) {
  const route = window._U._v;
  return window._U._u(route[0], argv, route[1], route[2], null);
}

const result = invokeInternal(args);
process.stdout.write("result: " + result + "\n");
```

这比把混淆函数逐个翻译成另一门语言可靠得多：前者保留原始语义，后者会踩中 JavaScript 32 位位运算、隐式类型转换、UTF-16 字符串和稀疏数组等细节。

## 确定性验证：把“请求成功”降级成最后一项测试

首先准备固定 query、固定 UA、固定 Cookie 的向量，连续运行 100 次，确认输出一致且无网络访问。然后做单变量差分：只交换参数顺序、只改变 UA 的一个版本号、删除一项 Cookie、改变屏幕尺寸。每次只允许预期依赖发生变化。

最后才把结果带入真实请求。HTTP 200 不能单独证明算法正确，因为缓存、降级路径或匿名接口都可能掩盖问题。真正可靠的证据是：相同输入可复现、环境访问可解释、入口参数可追踪、单变量差分符合预期，并且错误能明确落在“环境、入口或上层请求”中的某一层。

## 收尾：补环境的目标是最小闭包

一份能长期维护的离线运行器，应当把原始脚本视为不可变资产，对它记录 SHA-256；环境补丁、入口适配器和测试向量分别版本化。上游脚本变化时，先比较环境访问日志和入口结构，而不是重新从第一行读混淆代码。这样问题会从“十万行脚本失效”缩小成“新增了哪个依赖，或哪一个 dispatcher 参数发生了变化”。
