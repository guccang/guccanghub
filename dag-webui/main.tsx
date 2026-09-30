/** 浏览器宿主只加载 Cordis core，配置与装配使用统一入口。 */
import { Context } from '@cordisjs/core';
import { browserAppPlugin } from '../cordis/browser.js';
import { loadDag } from './DagWorkbench.js';
import '../pixel-studio/style.css';
import './style.css';
import './demo.css';
import './company.css';

const mode = new URLSearchParams(location.search).get('mode') === 'editor' ? 'editor' : 'company';
const element = document.getElementById('root');
if (!element) throw new Error('找不到 Web UI 挂载元素');
const ctx = new Context();
ctx.plugin(browserAppPlugin, {
  element, mode,
  ...(mode === 'editor' ? { dagGraph: { graph: loadDag() } } : {}),
});
await ctx.start();
window.addEventListener('pagehide', () => { void ctx.stop(); }, { once: true });
if (import.meta.hot) import.meta.hot.dispose(() => { void ctx.stop(); });
