// Re-runs game.js engine + inference under Node and checks that the JS port
// of the env + the JSON-exported policy reach a similar mean score to Python.
// Run from the project root:  node projects/snake-rl/training/verify_js_parity.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectDir = path.resolve(__dirname, '..');

const GRID = 12;
const DIRS = [{x:0,y:-1},{x:1,y:0},{x:0,y:1},{x:-1,y:0}];
const tR = (d) => (d + 1) % 4;
const tL = (d) => (d + 3) % 4;

function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=a;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return ((t^t>>>14)>>>0)/4294967296;};}

class Game {
  constructor(seed){this.rng=mulberry32(seed>>>0);this.reset();}
  reset(){const c=(GRID/2)|0;this.snake=[{x:c,y:c},{x:c-1,y:c},{x:c-2,y:c}];this.dir=1;this.alive=true;this.score=0;this.steps=0;this.stepsSinceFood=0;this._spawn();}
  _spawn(){const t=new Set(this.snake.map(s=>s.x*GRID+s.y));const free=[];for(let x=0;x<GRID;x++)for(let y=0;y<GRID;y++)if(!t.has(x*GRID+y))free.push({x,y});if(!free.length){this.food={x:-1,y:-1};return;}this.food=free[Math.floor(this.rng()*free.length)];}
  step(a){if(!this.alive)return{done:true};if(a===1)this.dir=tR(this.dir);else if(a===2)this.dir=tL(this.dir);
    const d=DIRS[this.dir];const h=this.snake[0];const nh={x:h.x+d.x,y:h.y+d.y};this.steps++;this.stepsSinceFood++;
    if(nh.x<0||nh.x>=GRID||nh.y<0||nh.y>=GRID){this.alive=false;return{done:true};}
    for(let i=0;i<this.snake.length-1;i++)if(this.snake[i].x===nh.x&&this.snake[i].y===nh.y){this.alive=false;return{done:true};}
    this.snake.unshift(nh);
    if(nh.x===this.food.x&&nh.y===this.food.y){this.score++;this.stepsSinceFood=0;this._spawn();return{done:false};}
    this.snake.pop();
    if(this.stepsSinceFood>100*this.snake.length){this.alive=false;return{done:true};}
    return{done:false};
  }
  obs(){const h=this.snake[0],d=this.dir;const f=DIRS[d],r=DIRS[tR(d)],l=DIRS[tL(d)];
    const c=(dl)=>{const x=h.x+dl.x,y=h.y+dl.y;if(x<0||x>=GRID||y<0||y>=GRID)return 1;for(let i=0;i<this.snake.length-1;i++)if(this.snake[i].x===x&&this.snake[i].y===y)return 1;return 0;};
    const fx=this.food.x,fy=this.food.y,hx=h.x,hy=h.y;
    return [c(f),c(r),c(l),d===0?1:0,d===1?1:0,d===2?1:0,d===3?1:0,fx<hx?1:0,fx>hx?1:0,fy<hy?1:0,fy>hy?1:0];
  }
}

function loadNet(p){return JSON.parse(fs.readFileSync(p,'utf8'));}
function fwd(net,x){let h=x;for(const L of net.layers){const W=L.W,b=L.b;const out=new Float32Array(W.length);for(let i=0;i<W.length;i++){let s=b[i];for(let j=0;j<W[i].length;j++)s+=W[i][j]*h[j];out[i]=L.activation==='relu'?(s>0?s:0):s;}h=out;}return h;}
function argmax(a){let b=0,v=a[0];for(let i=1;i<a.length;i++)if(a[i]>v){v=a[i];b=i;}return b;}

const net = loadNet(path.join(projectDir, 'weights.json'));
console.log('meta:', net.meta);
const N = 50;
const scores = [];
for (let ep = 0; ep < N; ep++) {
  const g = new Game(10000 + ep);
  while (g.alive) {
    const a = argmax(fwd(net, g.obs()));
    g.step(a);
  }
  scores.push(g.score);
}
const mean = scores.reduce((a,b)=>a+b,0)/N;
const sorted = [...scores].sort((a,b)=>a-b);
const med = sorted[Math.floor(N/2)];
console.log(`JS eval over ${N} eps: mean=${mean.toFixed(2)} median=${med} max=${Math.max(...scores)} min=${Math.min(...scores)}`);
