// 无头冒烟测试：在 Node 中加载游戏脚本（stub 浏览器 API），模拟运行并断言关键逻辑
'use strict';
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
if (!code) throw new Error('未找到 <script> 块');

let rafCb = null;
const ctxProxy = new Proxy({}, {
  get: (t, p) => (p in t ? t[p] : (t[p] = () => {})),
  set: (t, p, v) => { t[p] = v; return true; },
});
const canvasStub = { width: 0, height: 0, getContext: () => ctxProxy };

const sandbox = {
  window: { addEventListener: () => {} },
  document: { getElementById: () => canvasStub },
  requestAnimationFrame: cb => { rafCb = cb; },
  performance,
  console,
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

const run = (js) => vm.runInContext(js, sandbox);
let frames = 0;
function step(n, dtMs = 16.7) {
  for (let i = 0; i < n; i++) { frames++; run('loop(' + (frames * dtMs) + ')'); }
}
const ok = (cond, msg) => {
  if (!cond) { console.error('FAIL: ' + msg); process.exitCode = 1; throw new Error(msg); }
  console.log('PASS: ' + msg);
};

// 1. 初始状态
ok(run('state') === 'menu', '初始状态为 menu');
ok(run('field.length') === 26 && run('field[0].length') === 26, '地图为 26x26');
ok(run('field[24][12]') === 5, '基地鹰徽已放置 (T.BASE)');
ok(run('field[23][11]') === 1 && run('field[24][11]') === 1, '基地四周自动生成砖墙');

// 2. 开始游戏
run('startGame()');
ok(run('state') === 'playing', 'startGame 后进入 playing');
ok(run('player.x') === 128 && run('player.y') === 384, '玩家出生点正确');
ok(run('enemyQueue.length') === 20, '敌人生成队列为 20');
ok(run('lives') === 3 && run('score') === 0, '初始生命 3 / 分数 0');

// 3. 移动：向上移动 30 帧后 y 减小
const y0 = run('player.y');
run("pushDir('ArrowUp')");
step(30);
const y1 = run('player.y');
ok(y1 < y0, '按 ↑ 后玩家向上移动 (' + y0 + ' -> ' + y1 + ')');

// 4. 射击：发射子弹并击毁砖墙（在确定无阻挡的列放一块砖检验命中）
run("popDir('ArrowUp')");
step(5); // 等待冷却
const nb = run('bullets.length');
run('fire(player, true)');
ok(run('bullets.length') === nb + 1, '玩家开火生成子弹');
run('field[20][20] = 1'); // 放置测试砖墙
run('bullets.push({ x: 334, y: 380, dx: 0, dy: -1, speed: 6, w: 4, h: 4, owner: null, isPlayer: true, dead: false, power: false })');
step(20);
ok(run('field[20][20]') === 0, '子弹击毁砖墙 field[20][20] (1 -> 0)');

// 5. 敌人生成
step(80);
ok(run('enemies.length') >= 1, '敌人按计时生成 (enemies=' + run('enemies.length') + ')');

// 6. 击毁敌人加分
const sc0 = run('score');
run('hitEnemy(enemies[0])');
ok(run('score') > sc0, '击毁敌人得分增加 (' + sc0 + ' -> ' + run('score') + ')');
ok(run('enemies.filter(e=>!e.dead).length') === run('enemies.length') - 1, '敌人被击毁标记 dead');

// 7. 过关判定 -> 自动进入第 2 关
run('enemyQueue.length = 0; enemies = []');
step(2);
ok(run('state') === 'levelclear', '敌人清空后进入 levelclear');
step(200); // 2.5s 后自动进入下一关
ok(run('state') === 'playing' && run('level') === 2, '自动加载第 2 关');
ok(run('enemyQueue.length') === 20, '第 2 关敌人队列重置为 20');
ok(run('player.x') === 128 && run('player.y') === 384 && !run('player.dead'), '玩家回到出生点');

// 8. 装甲坦克需要多次命中
run('player.invulnTimer = 5'); // 护盾防干扰
run('frozenTimer = 999'); // 冻结敌军，防止其破坏基地干扰后续断言
run('enemies.push(makeEnemy(300, 200, ET.ARMOR))');
const armorIdx = run('enemies.length - 1');
step(100);
run('hitEnemy(enemies[' + armorIdx + '])');
ok(run('enemies[' + armorIdx + '].hp') === 3 && !run('enemies[' + armorIdx + '].dead'),
   '装甲坦克 4 血：命中一次后剩 3 血');

// 9. 基地被毁 -> game over
run('destroyBase()');
ok(run('state') === 'gameover', '基地被毁进入 gameover');
ok(run('field[24][12]') === 6 && run('field[25][13]') === 6, '基地变为废墟贴图 (T.BASE_BROKEN)');

// 10. 游戏结束重启
run('startGame()');
ok(run('state') === 'playing' && run('level') === 1 && run('score') === 0, 'gameover 后重新开始（分数清零、回到第 1 关）');

// 11. 暂停
step(1);
run('state = "paused"');
ok(run('state') === 'paused', '暂停状态切换正常');

// 12. 长跑稳定性：连续通关 4 关（3 张地图循环），全程渲染
run('startGame()');
let levels = 0, prevState = '', guard = 0;
while (levels < 4 && guard++ < 200000) {
  step(1);
  const st = run('state');
  if (st === 'gameover') throw new Error('长跑测试中基地被毁 / 玩家阵亡');
  if (st === 'levelclear' && prevState === 'playing') levels++;
  prevState = st;
  // 护盾保玩家不死；钢墙围住基地防被毁
  run('player.invulnTimer = 5');
  run("for (const [bx,by] of [[11,23],[12,23],[13,23],[14,23],[11,24],[14,24],[11,25],[14,25]]) field[by][bx] = 2");
  // 模拟玩家清场（装甲坦克循环命中）
  run('for (const e of enemies) { while (!e.dead) hitEnemy(e); }');
  run('enemies = enemies.filter(e => !e.dead)');
}
step(200); // 等待第 4 次 levelclear 完成，加载第 5 关
ok(levels === 4 && run('level') === 5 && run('state') === 'playing', '连续通关 4 关无异常，当前关卡 ' + run('level'));

console.log('\n全部测试通过 ✓');
