#!/usr/bin/env node
/**
 * 智慧树「掌握度」半自动练习助手
 * ---------------------------------------------------------------
 * 做什么：
 *   1. 扫描课程掌握度页面，列出所有知识点及当前掌握度
 *   2. 自动进入第一个未满分的知识点
 *   3. 抓出该知识点的全部题目和选项，打印给你
 *   4. 你输入答案 → 脚本自动勾选、提交
 *   5. 读取「掌握度 x% 总题数 n 已答对 m」，没满分就把解析抓出来
 *   6. 回到第 1 步，继续下一个知识点
 *
 * 不做什么：
 *   不判断答案。答案由你自己给，脚本只负责点鼠标和读结果。
 *
 * 依赖：Node 18+，Edge / Chrome 以 --remote-debugging-port=9223 启动
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const PORT = process.env.CDP_PORT || '9223';
const MATCH = process.env.CDP_MATCH || 'zhihuishu.com';
const SUBMIT_WAIT = parseInt(process.env.SUBMIT_WAIT || '9000', 10);

/* ============================ CDP 客户端 ============================ */

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((res, rej) => {
      this.ws.onopen = () => res();
      this.ws.onerror = () => rej(new Error('WebSocket 连接失败'));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error('CDP 超时: ' + method));
        }
      }, 45000);
    });
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result?.value;
  }

  async reload() {
    await this.send('Page.enable');
    await this.send('Page.reload', { ignoreCache: false });
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  let list;
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    list = await r.json();
  } catch {
    throw new Error(
      `连不上 127.0.0.1:${PORT}，说明浏览器不是用调试端口启动的。\n` +
        `解决办法：直接双击 启动.bat，它会用正确的参数打开浏览器。`
    );
  }
  const pages = list.filter((t) => t.type === 'page');
  const page = pages.find((t) => t.url.includes(MATCH)) || pages[0];
  if (!page) {
    throw new Error(
      '找不到可用的标签页。请确认浏览器是用 --remote-debugging-port 启动的。\n可用页面：\n  ' +
        pages.map((p) => p.url).join('\n  ')
    );
  }
  const c = new CDP(page.webSocketDebuggerUrl);
  await c.ready;
  return { c, url: page.url };
}

/* ============================ 页面操作 ============================ */

/** 扫描所有知识点卡片，返回 [{ i, name, rate }] */
async function scanPoints(c) {
  const raw = await c.eval(`(() => {
    var ps = [].slice.call(document.querySelectorAll('.mastery-box-custom-popover'));
    return JSON.stringify(ps.map(function (p, i) {
      var s = p.querySelector('strong.name');
      var t = p.querySelector('.text');
      return {
        i: i,
        name: s ? s.innerText.trim() : '',
        rate: t ? t.innerText.replace(/\\s+/g, '') : ''
      };
    }));
  })()`);
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

/** 点进第 idx 个知识点 */
async function enterPoint(c, idx) {
  return await c.eval(`(() => {
    var ps = [].slice.call(document.querySelectorAll('.mastery-box-custom-popover'));
    var p = ps[${idx}];
    if (!p) return 'NOT_FOUND';
    var btn = p.querySelector('button.el-button');
    if (!btn) return 'NO_BUTTON';
    btn.click();
    return 'OK';
  })()`);
}

/** 抓当前页面的题目 */
async function readQuestions(c) {
  const raw = await c.eval(`(() => {
    var qs = [].slice.call(document.querySelectorAll('.question-item'));
    return JSON.stringify(qs.map(function (q, i) {
      var txt = (q.innerText || '').replace(/\\r/g, '');
      var type = /多选题/.test(txt) ? '多选' : (/单选题/.test(txt) ? '单选' : '判断');
      var opts = [].slice.call(q.querySelectorAll('label.el-radio, label.el-checkbox'))
        .map(function (l) { return (l.innerText || '').replace(/\\s+/g, ' ').trim(); });
      // 题干 = 整个题目区去掉所有选项文本后剩下的部分
      var stem = txt;
      opts.forEach(function (o) {
        if (o) stem = stem.split(o).join(' ');
      });
      stem = stem.replace(/\\s+/g, ' ').replace(/^\\d+[\\.、]?\\s*/, '').trim().slice(0, 300);
      return { n: i + 1, type: type, stem: stem, opts: opts };
    }));
  })()`);
  try {
    return JSON.parse(raw || '[]');
  } catch {
    return [];
  }
}

/** 按答案数组勾选选项。answers[i] = [选项下标, ...]（0 基） */
async function pickAnswers(c, answers) {
  const payload = JSON.stringify(answers);
  return await c.eval(`(() => {
    var ans = ${payload};
    var qs = [].slice.call(document.querySelectorAll('.question-item'));
    if (!qs.length) return 'NO_QUESTION';
    var log = [];
    qs.forEach(function (q, i) {
      var ls = [].slice.call(q.querySelectorAll('label.el-radio, label.el-checkbox'));
      (ans[i] || []).forEach(function (k) {
        if (ls[k]) { ls[k].click(); log.push((i + 1) + '=' + k); }
        else { log.push((i + 1) + '=X/' + ls.length); }
      });
    });
    return log.join(' ');
  })()`);
}

/** 点击「提交」 */
async function submit(c) {
  const r = await c.eval(`(() => {
    var cands = [].slice.call(document.querySelectorAll('button, div, span'));
    var el = cands.filter(function (e) {
      return e.children.length <= 1 && (e.innerText || '').trim() === '提交';
    })[0];
    if (!el) return 'NO_SUBMIT_BTN';
    el.click();
    return 'SUBMITTED';
  })()`);
  return r;
}

/** 读取掌握度结果 */
async function readResult(c) {
  const raw = await c.eval(`(() => {
    var t = (document.body.innerText || '').replace(/\\s+/g, '');
    var m = t.match(/掌握度([\\d%.\\-]+)总题数(\\d+)已答对(\\d+)/);
    return m ? JSON.stringify({ rate: m[1], total: +m[2], right: +m[3] }) : 'PENDING';
  })()`);
  if (raw === 'PENDING') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 打开「查看作答记录与解析」，把解析文本抓回来 */
async function readAnalysis(c) {
  const clicked = await c.eval(`(() => {
    var el = [].slice.call(document.querySelectorAll('*')).filter(function (e) {
      return e.children.length <= 1 && /查看作答记录与解析/.test(e.innerText || '');
    })[0];
    if (!el) return 'NO_ANALYSIS_LINK';
    el.click();
    return 'OK';
  })()`);
  if (clicked !== 'OK') return null;
  await sleep(4000);
  return await c.eval(`(() => {
    var s = (document.body.innerText || '').split('测试题推荐').pop();
    return s ? s.replace(/\\n{2,}/g, '\\n').trim().slice(0, 1600) : '';
  })()`);
}

/* ============================ 答案解析 ============================ */

/**
 * 把 "A B AB C D" 或 "1 2 12 3 4" 解析成 [[0],[1],[0,1],[2],[3]]
 * 兼容：字母 / 数字 / 连写多选 / 逗号空格分隔
 */
function parseAnswer(input, count) {
  const tokens = String(input)
    .toUpperCase()
    .replace(/[,，、;；]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  const out = [];
  for (let i = 0; i < count; i++) {
    const tok = tokens[i];
    if (!tok) return null;
    const idx = [];
    for (const ch of tok) {
      let k = -1;
      if (/[A-Z]/.test(ch)) k = ch.charCodeAt(0) - 65;
      else if (/[0-9]/.test(ch)) k = parseInt(ch, 10) - 1;
      if (k >= 0) idx.push(k);
    }
    if (!idx.length) return null;
    out.push(idx);
  }
  return out;
}

/* ============================ 主流程 ============================ */

function hr(ch = '─', n = 64) {
  return ch.repeat(n);
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const ask = (q) => rl.question(q);

  console.log(hr('═'));
  console.log('  智慧树「掌握度」半自动练习助手');
  console.log(hr('═'));

  let conn;
  try {
    conn = await connect();
  } catch (e) {
    console.error('\n[错误] ' + e.message);
    console.error('\n请先运行 启动.bat，或者手动用调试端口启动浏览器。');
    process.exit(1);
  }

  const { c, url } = conn;
  console.log('已连接：' + url.slice(0, 90));

  let round = 0;
  for (;;) {
    round++;
    console.log('\n' + hr());
    console.log('第 ' + round + ' 轮 · 扫描知识点…');

    let points = await scanPoints(c);
    if (!points.length) {
      console.log('\n[提示] 当前页面没有找到知识点卡片。');
      console.log('       请确认已经打开课程「掌握度」页面（不是章节页、不是首页）。');
      const go = await ask('刷新页面重试？(y/n) ');
      if (go.toLowerCase() === 'y') {
        await c.reload();
        await sleep(8000);
        continue;
      }
      break;
    }

    const pending = points.filter((p) => !/100%/.test(p.rate));
    console.log('  共 ' + points.length + ' 个知识点，未满分 ' + pending.length + ' 个');
    points.forEach((p) => {
      const mark = /100%/.test(p.rate) ? '✔' : '○';
      if (!/100%/.test(p.rate)) console.log('   ' + mark + ' ' + p.rate.padEnd(8) + p.name);
    });

    if (!pending.length) {
      console.log('\n🎉 全部知识点都是 100% 了。');
      break;
    }

    const target = pending[0];
    console.log('\n→ 进入：' + target.name + '  (' + target.rate + ')');

    const entered = await enterPoint(c, target.i);
    if (entered !== 'OK') {
      console.log('[错误] 无法进入该知识点：' + entered);
      break;
    }
    await sleep(7000);

    let qs = await readQuestions(c);
    if (!qs.length) {
      console.log('[提示] 没抓到题目，可能是页面还没加载完，等 5 秒再试…');
      await sleep(5000);
      qs = await readQuestions(c);
    }
    if (!qs.length) {
      console.log('[错误] 仍然没有题目，跳过这个知识点。');
      continue;
    }

    console.log('\n' + hr('─'));
    qs.forEach((q) => {
      console.log('\n【' + q.n + '】' + q.type + '  ' + q.stem);
      q.opts.forEach((o, k) => {
        console.log('     ' + String.fromCharCode(65 + k) + '. ' + o.slice(0, 60));
      });
    });
    console.log('\n' + hr('─'));

    const input = await ask(
      '\n输入 ' + qs.length + ' 题的答案（例：A B AB C D，多选连写；直接回车跳过）：'
    );

    if (!input.trim()) {
      console.log('已跳过。');
      const ok = await ask('结束程序？(y/n) ');
      if (ok.toLowerCase() === 'y') break;
      continue;
    }

    const answers = parseAnswer(input, qs.length);
    if (!answers) {
      console.log('[错误] 答案格式不对，需要 ' + qs.length + ' 组。本轮跳过。');
      continue;
    }

    const picked = await pickAnswers(c, answers);
    console.log('\n勾选结果：' + picked);
    await sleep(1200);

    const sub = await submit(c);
    if (sub !== 'SUBMITTED') {
      console.log('[错误] 没找到「提交」按钮：' + sub);
      continue;
    }
    console.log('已提交，等待判分…');
    await sleep(SUBMIT_WAIT);

    const res = await readResult(c);
    if (!res) {
      console.log('[提示] 没读到掌握度，页面可能还在跳转。');
    } else {
      const full = res.right === res.total;
      console.log(
        '\n' + (full ? '✅' : '⚠️') +
          ' 掌握度 ' + res.rate + '  已答对 ' + res.right + '/' + res.total
      );
      if (!full) {
        console.log('\n正在抓解析…');
        const ana = await readAnalysis(c);
        if (ana) console.log('\n' + ana);
      }
    }

    const next = await ask('\n按回车继续下一个知识点（输入 q 退出）：');
    if (next.trim().toLowerCase() === 'q') break;

    // 回到掌握度总览
    await c.eval("location.href = document.location.href.split('#')[0]");
    await sleep(6000);
  }

  console.log('\n' + hr('═') + '\n程序结束。\n');
  rl.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('\n[异常] ' + e.message);
  process.exit(1);
});
