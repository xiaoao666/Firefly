---
title: "Android 上的 Dear ImGui 不是一张画布：Java、JNI、OpenGL ES 与输入法桥"
published: 2026-03-11
updated: 2026-07-23
description: "从 GLSurfaceView 帧循环、JNI 生命周期和窗口命中，到隐藏 EditText 的 IME 桥，拆解 Android Dear ImGui 的完整工程边界。"
image: "/images/legacy/b418fe94-7b58-44a6-88cb-4f58cf730b70.jpg"
tags: ["imgui","java","egl"]
category: ""
draft: false
pinned: false
comment: true
author: "xiaoao"
sourceLink: ""
licenseName: ""
licenseUrl: ""
---
## Android 上的 Dear ImGui，真正难的是平台边界

桌面示例里的初始化、NewFrame、Render 只是渲染主干。到了 Android，完整链路跨过 Java View、GLSurfaceView 渲染线程、JNI、ANativeWindow、OpenGL ES、MotionEvent 与系统输入法。图形出现并不等于移植完成：触摸命中、中文输入、旋转重建和资源释放仍可能全部有问题。

![Android Dear ImGui 渲染与输入桥架构图](/images/legacy/a2450750-5c0b-4c7c-8025-598686dc3cd8.png)

## 用 GLSurfaceView 承担 EGL 生命周期

Java 层选择 GLES 3.0，并把 surface 创建、尺寸变化和绘制回调映射到 Native。EGL 上下文继续交给 Android 管理，C++ 只维护 ImGui context 与 backend 状态。

```text
setEGLContextClientVersion(3);
setRenderer(new GLRenderer());
setRenderMode(GLSurfaceView.RENDERMODE_CONTINUOUSLY);

public void onDrawFrame(GL10 gl) {
    NativeMethod.onDrawFrame();
}
```

连续渲染最稳，但空闲时也持续占用 GPU。工具型界面可改成按需 requestRender，并用 Choreographer 合并同一帧内的刷新请求。

## Native 帧顺序不能颠倒

创建 ImGuiContext 后，Android backend 绑定 ANativeWindow，OpenGL backend 使用 `#version 300 es`。每帧先让 renderer backend 准备 GPU 状态，再由 platform backend 更新尺寸和 delta time，然后进入 NewFrame。

```text
ImGui_ImplOpenGL3_NewFrame();
ImGui_ImplAndroid_NewFrame();
ImGui::NewFrame();

DrawApplicationUI();

ImGui::Render();
ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
```

如果 GLSL 版本与 GLES 上下文不一致，部分设备会在 shader 编译阶段失败；如果 surface 重建后复用旧 backend 状态，则常见结果是黑屏、纹理失效或 native crash。

## 触摸需要命中路由，而不是全屏吞事件

Java 把 rawX、rawY 和 action 送入 Native，Native 更新 ImGuiIO，同时结合 `WantCaptureMouse` 返回是否消费。如果透明 GLSurfaceView 永远返回 true，底层原生界面将完全失去触摸。

```text
ImGuiIO& io = ImGui::GetIO();
io.AddMousePosEvent(x, y);

if (action == ACTION_DOWN)
    io.AddMouseButtonEvent(0, true);
if (action == ACTION_UP || action == ACTION_CANCEL)
    io.AddMouseButtonEvent(0, false);

return io.WantCaptureMouse;
```

工程还会遍历活跃顶层 ImGuiWindow，计算最小包围矩形，经 JNI 返回 Java。Java 约每 16 ms 同步代理窗口的 bounds，使 ImGui 外部区域仍可穿透。这里必须统一坐标系：raw 坐标、surface 坐标和窗口 bounds 若混用，状态栏或父布局偏移会造成“看得见但点不中”。bounds 没变化时不要反复提交 WindowManager.LayoutParams，否则会制造额外 layout。

## 隐藏 EditText 是 Native 输入框与 Android IME 的桥

ImGui 的 InputText 位于 C++，Android 输入法却要求一个真实、可聚焦并能提供 InputConnection 的 View。解决方法是在 Java 层放置几乎透明的 EditText。Native 观察 `io.WantTextInput` 的边沿变化，通过缓存的方法 ID 请求 Java 显示或隐藏键盘；TextWatcher 再把新增 UTF-8 文本送回 Native。

```text
inputEditText.setAlpha(0.001f);
inputEditText.setFocusableInTouchMode(true);
inputEditText.setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI);

public void onTextChanged(CharSequence s, int start, int before, int count) {
    if (count > 0) {
        NativeMethod.UpdateInputText(
            s.subSequence(start, start + count).toString()
        );
    }
}
```

退格不能只靠 TextWatcher，因为删除动作没有新增字符；需要在自定义 EditText 的 key 事件或 InputConnection.deleteSurroundingText 中单独转发 Backspace。调用 showSoftInput 必须回到 UI thread，不能直接从 GL render thread 操作 View。

## JNI 缓存与线程所有权

Native 可以缓存 JavaVM、类的 global reference 以及 show/hide 方法 ID，避免每帧 FindClass。但 JNIEnv 不能跨线程保存：GL 线程调用 Java 时要通过 JavaVM 获取当前 JNIEnv；Native 自建线程则需要 AttachCurrentThread，并在退出时 DetachCurrentThread。

global reference 必须在 surface 销毁或模块卸载时删除，否则 Activity 重建后仍可能持有旧 ClassLoader。销毁顺序应为 OpenGL backend、Android backend、ImGui context，最后清理 JNI 引用。顺序反过来会让 backend 在清理阶段访问已销毁的 context。

## 字体与 DPI 不是固定乘三

字体数据编译进头文件时，可设置 `FontDataOwnedByAtlas = false`，避免 atlas 释放静态内存。Android density 差异很大，固定调用 ScaleAllSizes(3.0f) 只能适配少量设备。更稳的是 Java 读取 density，把字号与 style scale 传给 Native，并在 density 或 surface 发生变化时重建字体纹理。

## 验证标准

至少要覆盖：连续旋转、前后台切换、中文与 Emoji、退格和长按删除、窗口拖动后的命中同步、ImGui 外部触摸穿透、不同 density 的字体清晰度，以及 Activity 重建后的 Native 内存回落。图形能显示只是第一步；线程、坐标系和资源所有权都可解释，才算真正完成移动端移植。
