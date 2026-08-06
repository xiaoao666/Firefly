---
title: "我如何用 Cloudflare Workers 搭建一个完整的全栈博客"
published: 2026-07-20
updated: 2026-07-22
description: "从 SSR、API、D1 数据库到 KV 缓存与 R2 媒体存储，拆解一个边缘全栈项目的架构选择。"
image: "./images/xiaoao-cloudflare.jpg"
tags: ["全栈开发", "Cloudflare", "工程实践"]
category: "工程实践"
draft: false
pinned: false
comment: true
---
## 为什么选择边缘全栈

个人博客看似简单，但一旦加入后台、登录、评论、搜索和图片管理，就变成了一个完整 Web 产品。我选择 Cloudflare Workers 作为运行环境，是因为它能让页面渲染、API 和数据服务靠近用户，同时减少传统服务器的运维负担。

## 系统分层

页面层使用 TanStack Start 与 React 19 负责 SSR、路由和交互；Hono 承担 API 网关；业务逻辑放在 service 层；Drizzle ORM 负责类型安全的数据访问；D1 保存文章、标签、评论和配置。KV 用于版本化缓存，R2 用于媒体文件。

功能模块按照 api、data、service、schema、components 和 workflows 拆分。data 层只处理数据库查询，service 层编排业务规则，UI 不直接依赖底层存储。这种边界让测试、替换实现和定位故障都更容易。

## 一次文章请求如何完成

1. 路由根据 slug 请求文章详情。
2. 服务层先读取版本化 KV 缓存，未命中时查询 D1。
3. 内容经过代码高亮和目录生成后返回 SSR 页面。
4. 页面设置缓存与 SEO 元数据，并在客户端完成交互增强。

## 我特别处理的工程问题

服务函数使用 Result 类型表达可预期错误，调用方必须穷举错误原因；全局中间件记录结构化 JSON 日志；发布流程生成公开内容快照，避免每次访问重复执行昂贵转换；集成测试运行在 Cloudflare Workers 测试池中，使测试环境更接近生产环境。

## 结论

技术选型的价值不在于新，而在于边界是否清晰、部署是否稳定、维护是否可控。这套架构让我能独立完成从数据库到用户界面的整条链路，也能在需求增长时继续演进。
