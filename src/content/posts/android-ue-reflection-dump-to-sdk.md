---
title: "Android UE 反射数据 Dump：从三类全局锚点到可编译 SDK"
published: 2026-02-03
updated: 2026-07-23
description: "结合 GWorld、FNamePool、GUObjectArray 的定位思路，拆解 Android 外部读内存、反射对象遍历、属性布局兼容与 SDK 生成验证。"
image: "/images/legacy/826969e9-1acf-43d3-889f-43d4fc09bac1.jpg"
tags: ["UE","逆向","UE引擎"]
category: ""
draft: false
pinned: false
comment: true
author: "xiaoao"
sourceLink: ""
licenseName: ""
licenseUrl: ""
---
## Dump SDK 不是“找到三个偏移然后跑工具”

在 Android 上恢复 Unreal Engine 的反射数据，表面目标通常是 GWorld、NamePoolData/GNames 和 GUObjectArray。真正决定结果质量的却是后面的整条链：目标进程如何定位、[libUE4.so](<http://libUE4.so>) 的加载基址是否正确、跨进程读取是否完整、FNameEntry 如何推进、FUObjectItem 如何取出 UObject、属性链属于旧版 UProperty 还是新版 FProperty，以及生成的 padding 能否让结构体重新对齐。

因此更准确的描述不是“内存转储”，而是把运行时反射系统重新实现成一个只读解析器。本文只讨论自研、测试或明确授权样本中的结构恢复与兼容性验证。

![Android UE 反射数据 Dump 数据流图](/images/legacy/e66eb3cb-c7b5-4df8-930a-f9af0148edc2.png)

## 第一步：从 PID 与 ELF 映射建立地址坐标系

外部工具先扫描 `/proc`，比较每个进程的 cmdline 与目标包名，再读取 `/proc/<pid>/maps` 找到 [libUE4.so](<http://libUE4.so>) 的首个有效映射。静态分析得到的是模块内 RVA，运行时地址必须计算为 `moduleBase + rva`。

```text
long getModuleBase(const char* moduleName) {
    char path[64];
    snprintf(path, sizeof(path), "/proc/%d/maps", pid);

    FILE* maps = fopen(path, "r");
    char line[1024];
    while (maps && fgets(line, sizeof(line), maps)) {
        if (!strstr(line, moduleName)) continue;

        unsigned long start = 0;
        if (sscanf(line, "%lx-%*lx", &start) == 1) {
            fclose(maps);
            return static_cast<long>(start);
        }
    }
    if (maps) fclose(maps);
    return 0;
}
```

不能默认包含模块名的第一行永远是 ELF load bias。稳健实现还要解析权限、文件 offset 和 inode：优先选择文件偏移为 0 的映射，或依据 ELF program header 反推 load bias。split APK、匿名重映射以及壳把代码段搬到匿名页时，简单 strstr 会得到错误基址。

## 第二步：三类全局锚点分别解决什么问题

**NamePoolData/GNames**把整数 NameIndex 还原成字符串；**GUObjectArray**提供所有活跃 UObject 的索引空间；**GWorld**把解析器接入当前世界、PersistentLevel 和 Actor 集合。SDK 生成主要依赖前两者，GWorld 更适合做运行时对象链验证。

参考源码定位锚点时，字符串交叉引用比盲扫地址可靠。UE5/较新 UE4 的 FNamePool 构造阶段会初始化 `None`、`ByteProperty`、`IntProperty` 等稳定名字；沿这些字符串交叉引用回到构造函数，再观察 this 指针来源，可以定位 NamePoolData。GWorld 可从 World.cpp 中对全局变量的读写点反查，例如与关卡切换相关的稳定日志字符串。GUObjectArray 则可从垃圾回收或对象数组关闭初始化的代码路径反查。

但字符串只负责产生候选地址，最终必须用结构不变量确认：NameIndex 0 应解出 None；NumElements 应大于零且不超过 MaxElements；抽样 UObject 的 Class、Name 和 Outer 指针应落在可读映射中。

## 第三步：跨进程读取层必须把失败暴露出来

Android arm64 上可以通过 `process\_vm\_readv` 批量读取目标进程。它比逐字节 ptrace 更适合大量反射遍历，但调用成功不等于完整读取：返回值可能小于请求长度，跨越不可读页时尤其常见。

```text
bool readMemory(uintptr_t remote, void* local, size_t size) {
    iovec localVec  { local, size };
    iovec remoteVec { reinterpret_cast<void*>(remote), size };

    const ssize_t read = syscall(
        SYS_process_vm_readv,
        pid,
        &localVec, 1,
        &remoteVec, 1,
        0
    );
    return read == static_cast<ssize_t>(size);
}
```

解析层应只依赖 `Read<T>`、ReadPointer、ReadString 等少量接口，并返回显式成功状态。把读取失败默认为 0 会制造假对象：空指针可能被当成链表结尾，错误长度可能让 NamePool 提前结束，最后得到一份“能生成但缺一半类型”的 SDK。

## 第四步：FNamePool 是分块变长记录，不是字符串数组

较新引擎使用 FNamePool/FNameEntryAllocator。EntryId 通常由 Block 与 Offset 组合；Blocks 数组指向多个固定容量的内存块，块内条目由 Header 与字符串数据组成。Header 高位给出长度，低位保存宽字符等标志；下一条记录需要按 Stride 对齐。

```text
for (uint32_t block = 0; block < currentBlock; ++block) {
    uintptr_t chunk = Read<uintptr_t>(blocks + block * sizeof(void*));
    if (!chunk) continue;

    uintptr_t cursor = chunk;
    const uintptr_t end = chunk + blockSizeBytes;
    while (cursor < end) {
        const uint16_t header = Read<uint16_t>(cursor);
        const uint32_t len = header >> 6;
        if (len == 0 || len > 1024) break;

        const bool wide = (header & 1) != 0;
        dumpEntry(block, cursor, len, wide);
        cursor += alignedEntrySize(header);
    }
}
```

常见失败包括：把 UE4.23 前后的 GNames 与 FNamePool 混用、忽略 wide 标志导致中文名称乱码、Stride 错误导致从第二条开始全部错位，以及把 CurrentBlock 当成包含端点或不包含端点。最简单的验证向量仍然是前几个核心名字与大量 Property 类型名。

## 第五步：GUObjectArray 把名字变成类型图

全局对象数组往往是 chunked array。逻辑索引先拆成 chunk index 与 within-chunk index，再定位 FUObjectItem，最后取出 Object 指针。读取到 UObject 后，用 NamePrivate 解名字、ClassPrivate 判类型、OuterPrivate 恢复完整路径。

完整名一般由“类名 + Outer 链 + 对象名”组成，例如 Class、ScriptStruct、Enum、Function 等反射对象。只有名称表时，我们得到的是词典；加上对象数组，才得到带继承和所有权关系的图。

```text
for (int32_t i = 0; i < numElements; ++i) {
    UObject object = getObjectByIndex(i);
    if (!object.valid()) continue;

    if (object.isA<UFunction>() ||
        object.isA<UStruct>() ||
        object.isA<UEnum>()) {
        packages[object.package()].push_back(object);
    }
}
```

遍历前必须限制 NumElements 的合理范围，并对每个指针做 canonical address 与 maps 可读区间检查。对象数组结构判断错误时，最危险的现象不是 crash，而是每隔固定数量出现一个“看起来有效”的随机指针。

## 第六步：UE4 新旧属性系统决定 SDK 能否编译

较老版本把属性表示成 UObject 派生的 UProperty；较新版本把大量属性迁移到 FField/FProperty 链。两套布局的 Next、Name、Class、Offset\_Internal、ElementSize、ArrayDim 与 PropertyFlags 都不同。只兼容 UObject 数组而没有处理 FProperty，通常只能 Dump 出类名，成员字段会缺失。

本地实现的一个实用策略是：先用已知类型对象和可读指针判断子属性数据位于 FProperty 基址后的哪个对齐位置，再缓存这个偏移。这能覆盖少量编译器对齐差异，但不能代替引擎版本画像。更稳的实现应先识别版本或 profile，再选择明确的结构布局；启发式只作为回退。

## 第七步：生成器的核心是 padding，而不是打印成员名

对 UStruct，需要先递归确定父类大小，再按成员 Offset 排序。若下一个属性的 Offset 大于当前游标，生成字节 padding；BoolProperty 若共享同一字节，则根据 ByteOffset 与 FieldMask 生成 bit padding。最后把游标补到 StructSize。

数组、Map、Set、Object、Struct、Enum 和 Delegate 属性还要递归解析引用类型。包级生成时应按依赖关系排序，否则 A.hpp 引用尚未声明的 B 会导致输出无法编译。生成 SDK 后用 clang 做语法检查，是比肉眼抽查更硬的验证。

## GWorld 更适合做验证，不应成为唯一入口

从 GWorld 解引用到 UWorld、PersistentLevel 和 Actors，可以抽样确认 Actor 的 NamePrivate、ClassPrivate 与 SuperStruct 链。但世界对象会随加载场景变化，主菜单阶段可能为空，Actor 数组也可能受版本和 World Partition 影响。SDK 生成不应依赖当前一定存在可玩的关卡。

## 一套可重复的验证矩阵

第一层验证地址：三个 RVA 必须位于预期数据段，解引用后的指针落在已映射页。第二层验证名称：Name\[0\] 为 None，Property 核心名字可解码，随机抽样无大面积乱码。第三层验证对象：NumElements 合理，完整名能形成稳定的 Outer 路径。第四层验证结构：成员 offset 单调，不越过 StructSize，父类大小与第一个子类成员衔接。第五层验证输出：头文件可以被编译器解析，IDA/Ghidra 脚本中的函数地址落在 [libUE4.so](<http://libUE4.so>) 可执行段。

真正可维护的 Dumper 应把“地址发现、内存访问、版本布局、反射模型、代码生成”拆成五层。上游版本变化时，只替换发生变化的一层，而不是在一份巨型头文件里继续堆魔法偏移。

## 参考资料

[UE5 中定位 GWorld、GName 与 GUObjectArray 的源码交叉引用思路](<https://www.cnblogs.com/revercc/p/17641855.html>)

[Android Unreal Engine Dumper 的功能与输出设计](<https://github.com/MJx0/AndUEDumper>)
