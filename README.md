# 智慧树「掌握度」半自动练习助手

> 扫描知识点 → 抓题 → 你给答案 → 自动勾选提交 → 读掌握度 → 跳下一个。
> **它不判断答案，答案由你自己出。**

[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 这是什么

智慧树的课程练习页把每个知识点做成一排卡片，点进去是 5 道题，答完显示「掌握度 x% 总题数 5 已答对 m」。

这个脚本把「点进卡片 → 勾选项 → 提交 → 读结果 → 退出 → 下一张」这套重复动作自动化，
**但把「答案是什么」留给人**。适合这样的用法：

- 你手上有答案，只是不想一张张点卡片
- 你想先看到题目，再决定选什么
- 你想在答错后立刻拿到解析，不用手动翻

它刻意不做全自动答题 —— 那种东西的正确率反而比你随手猜还低。

---

## 前置条件

- Windows（macOS / Linux 用等价命令即可）
- Microsoft Edge 或 Chrome
- [Node.js](https://nodejs.org) 18 及以上

---

## 怎么用

```bash
git clone https://github.com/Maltts/zhihuishu-mastery.git
cd zhihuishu-mastery
```

1. 双击 **`启动.bat`**，会弹出一个带调试端口的独立浏览器窗口
2. 在这个窗口里登录智慧树，进入课程，打开 **「掌握度」页面**（能看到一排知识点卡片的那个）
3. 回到黑色命令窗口，按任意键

然后脚本会：

```
第 1 轮 · 扫描知识点…
  共 42 个知识点，未满分 12 个
   ○ 60%     艾滋病——民生问题
   ○ 80%     艾滋病能治愈吗？
   ...

→ 进入：艾滋病——民生问题  (60%)

【1】单选  艾滋病的主要传播途径不包括
     A. 血液传播
     B. 性传播
     C. 日常握手拥抱
     D. 母婴传播
...

输入 5 题的答案（例：A B AB C D，多选连写）：
```

输入 `C B AB A D` 回车，脚本自动勾选、提交、等判分，然后打印：

```
✅ 掌握度 100%  已答对 5/5
```

没满分的话会自动抓「查看作答记录与解析」的内容贴出来，再进下一个知识点。

**答案格式**：空格分隔，每题一组；多选连写（`AB`）、判断/单选写单个字母（`A`）；
也可以用数字（`1` 代表 A）。逗号、顿号也能当分隔符。

---

## 它靠什么定位页面元素

智慧树这个页面没提供 API，所有操作都落在 DOM 上。以下是实测可用的选择器（2026-10）：

| 用途 | 选择器 | 说明 |
|---|---|---|
| 知识点卡片 | `.mastery-box-custom-popover` | 每个卡片一个，整个页面平铺 |
| 知识点名称 | `strong.name` | 卡片内 |
| 掌握度文字 | `.text` | 形如 `60%` / `100%` |
| 进入按钮 | `button.el-button` | 卡片内 |
| 题目容器 | `.question-item` | 一页通常 5 个 |
| 选项 | `label.el-radio` / `label.el-checkbox` | 单选/多选不同 |
| 选项选中态 | 类名含 `is-checked` | |
| 提交按钮 | 文本为 `提交` 的叶子节点 | 无稳定 class，只能按文本找 |
| 解析入口 | 文本含 `查看作答记录与解析` | 同上 |
| 结果文字 | `掌握度(\S+)总题数(\d+)已答对(\d+)` | 从 `body.innerText` 正则提取 |

**踩过的坑**：

- 提交后页面要等 5–10 秒才出结果，读太早会拿到空值，所以默认等 9 秒（可用环境变量 `SUBMIT_WAIT` 调）
- 多选题必须**逐个点击并等待渲染**，连续快速点击会丢事件（Vue 的更新是异步的）
- 提交按钮没有稳定 class，只能按 `innerText === '提交'` 找，所以脚本里做了 `children.length <= 1` 过滤，避免点到外层容器
- 「掌握度」的正则去掉了所有空白再匹配，因为页面里夹着大量换行

---

## 工作原理

整个脚本就三件事：**连上浏览器、执行 JS、把结果带回来**。

```js
// 通过 Chrome DevTools 协议执行一段页面内的 JS
const r = await send('Runtime.evaluate', {
  expression: `JSON.stringify([].slice.call(document.querySelectorAll('.question-item')).map(...))`,
  returnByValue: true,
  awaitPromise: true,
});
```

所有页面操作都是 `element.click()`，没有模拟鼠标坐标 —— 因为智慧树的选项是标准 `label + input`，
原生 click 就足够触发 Vue 的绑定，比坐标点击稳定得多。

扫描卡片：

```js
var ps = document.querySelectorAll('.mastery-box-custom-popover');
ps.forEach(p => {
  var name = p.querySelector('strong.name').innerText;
  var rate = p.querySelector('.text').innerText;   // "60%"
});
```

判定是否完成，靠的是 `.text` 里有没有 `100%`，而不是别的状态字段。

---

## 常见问题

**提示「当前页面没有找到知识点卡片」？**
你打开的不是掌握度页面。正确页面是一排卡片、每张显示知识点名和百分比的那种。

**一直读不到掌握度？**
判分慢。把 `SUBMIT_WAIT` 调大一些：

```bash
set SUBMIT_WAIT=15000
node mastery.mjs
```

**能中途退出吗？**
随时 Ctrl+C。下次重新跑，脚本会自动找第一个不是 100% 的知识点接着做。

**为什么不做全自动？**
因为要理解题意才能选对。接个大模型也能跑，但正确率不比人高，还可能把已经答对的题改错。
这个工具的目标是省掉点击，不是省掉思考。

---

## 免责声明

- 本项目仅供**技术研究与学习使用**，用于了解浏览器自动化、CDP 协议和前端 DOM 结构的分析方法。
- 使用自动化脚本刷课可能违反智慧树 / 学堂在线的用户协议，**由此产生的账号风险由使用者自行承担**。
- 作者不对任何直接或间接损失负责，请勿用于商业用途。

说实话，练习题本来就是给你查漏补缺的。真不想手点，至少把题目看一眼。

---

## 相关项目

- **[yuketang-multispeed](https://github.com/Maltts/yuketang-multispeed)** — 雨课堂视频 5 倍速自动连播，同一套 CDP 技术栈，含「为什么 5 倍是上限」的实测数据

---

## License

[MIT](LICENSE)
