// 运营后台单页。纯 vanilla + fetch，无构建步骤、无外部资源（CSP 友好、离线可用）。
// 沿用 manager.mjs 时代的深色配色与交互习惯，运维不用重新适应。
//
// 唯一要注意的：本文件是一个大模板字符串，内部一律用单引号 + 字符串拼接，
// 不要在里面写反引号或 ${}，否则会被外层模板串吃掉。

export const ADMIN_HTML = `<!doctype html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>运营后台 · 科研医学 Agent</title>
<style>
:root{--bg:#0f1216;--panel:#171b21;--p2:#1e242c;--line:#2a323c;--fg:#e7ecf2;--mut:#93a1b0;
      --acc:#4f8cff;--ok:#39b57a;--warn:#e6a23c;--bad:#e05a5a}
*{box-sizing:border-box}
body{margin:0;font:14px/1.55 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;align-items:center;gap:12px;padding:13px 20px;border-bottom:1px solid var(--line);background:var(--panel);position:sticky;top:0;z-index:5}
header h1{font-size:16px;margin:0;font-weight:600}
.sp{flex:1}
main{max-width:1180px;margin:0 auto;padding:20px 20px 80px}
section{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:18px}
h2{font-size:15px;margin:0 0 14px;font-weight:600}
h2 .mut{font-weight:400}
input,select,textarea,button{font:inherit;color:var(--fg);background:var(--p2);border:1px solid var(--line);border-radius:8px;padding:7px 10px;outline:none}
input:focus,select:focus{border-color:var(--acc)}
button{cursor:pointer;background:var(--p2)}
button:hover{border-color:var(--acc)}
.btn.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}
.btn.danger{border-color:var(--bad);color:var(--bad)}
.btn.sm{padding:4px 9px;font-size:12.5px;border-radius:6px}
.mut{color:var(--mut)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
th{color:var(--mut);font-weight:600;font-size:12.5px;white-space:nowrap}
tr:last-child td{border-bottom:none}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line);background:var(--p2)}
.tag.ok{color:var(--ok);border-color:#2c5c46}
.tag.bad{color:var(--bad);border-color:#5c3030}
.tag.warn{color:var(--warn);border-color:#5c4a24}
/* 提示条固定在右上角、且【在 #app 之外】：操作成功后通常紧跟一次列表刷新，
   若提示条长在 #app 里会被重绘冲掉，用户永远看不到"已保存/已停用"。 */
.msg{display:none;position:fixed;top:62px;right:20px;z-index:20;max-width:380px;
     padding:10px 14px;border-radius:9px;font-size:13px;box-shadow:0 6px 22px rgba(0,0,0,.45)}
.msg.ok{display:block;background:#12301f;color:#7fe0ae;border:1px solid #2c5c46}
.msg.err{display:block;background:#301616;color:#ffb0b0;border:1px solid #5c3030}
.bar{height:6px;background:var(--p2);border-radius:4px;overflow:hidden;margin-top:3px}
.bar i{display:block;height:100%;background:var(--ok)}
.bar.warn i{background:var(--warn)}.bar.bad i{background:var(--bad)}
.usage{font-size:12.5px;white-space:nowrap}
dialog{background:var(--panel);color:var(--fg);border:1px solid var(--line);border-radius:14px;padding:0;max-width:620px;width:94%}
dialog::backdrop{background:rgba(0,0,0,.62)}
.dlg-h{padding:14px 18px;border-bottom:1px solid var(--line);font-weight:600}
.dlg-b{padding:16px 18px;max-height:66vh;overflow:auto}
.dlg-f{padding:12px 18px;border-top:1px solid var(--line);display:flex;gap:8px;justify-content:flex-end}
.grid{display:grid;grid-template-columns:104px 1fr;gap:9px 12px;align-items:center}
.grid label{color:var(--mut);font-size:13px}
.chips{display:flex;flex-wrap:wrap;gap:6px}
.chip{padding:3px 9px;border-radius:999px;border:1px solid var(--line);background:var(--p2);cursor:pointer;font-size:12.5px;user-select:none}
.chip.on{border-color:var(--acc);background:#1b2a45;color:#cfe0ff}
.pw{font-family:ui-monospace,Consolas,monospace;font-size:17px;letter-spacing:.08em;background:var(--p2);padding:10px 14px;border-radius:8px;border:1px dashed var(--acc);display:inline-block;user-select:all}
.spark{display:flex;align-items:flex-end;gap:2px;height:52px}
.spark i{flex:1;background:var(--acc);opacity:.75;border-radius:2px 2px 0 0;min-height:2px}
.kpi{display:flex;gap:26px;flex-wrap:wrap}
.kpi div b{display:block;font-size:23px;font-weight:600;line-height:1.25}
.tabs{display:flex;gap:4px;margin-bottom:14px}
.tabs button{border-radius:8px;padding:6px 14px}
.tabs button.on{background:var(--acc);border-color:var(--acc);color:#fff}
#login{max-width:390px;margin:12vh auto}
.hint{font-size:12.5px;color:var(--mut);margin-top:4px}
.rank{font-size:11px;color:var(--mut)}
/* 列头筛选（Excel 那种 ▾）：按钮常显，命中条件时高亮并带个数 */
.fbtn{display:inline-flex;align-items:center;gap:3px;margin-left:4px;padding:0 5px;border-radius:5px;
      border:1px solid var(--line);background:var(--p2);color:var(--mut);cursor:pointer;font-size:11px;line-height:18px}
.fbtn:hover{border-color:var(--acc);color:var(--fg)}
.fbtn.on{border-color:var(--acc);background:#1b2a45;color:#cfe0ff}
/* 筛选浮层放在 body 下（不在 #app 里），列表重绘不会把它冲掉 */
#pop{display:none;position:absolute;z-index:30;min-width:200px;max-width:290px;padding:10px;
     background:var(--panel);border:1px solid var(--acc);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5)}
#pop.on{display:block}
#pop .grp{font-size:11.5px;color:var(--mut);margin:6px 0 4px}
#pop label{display:flex;align-items:center;gap:7px;padding:3px 2px;font-size:13px;cursor:pointer}
#pop label input{margin:0}
#pop .pf{display:flex;gap:6px;margin-top:9px;padding-top:9px;border-top:1px solid var(--line)}
/* 批量操作条：勾了人才出现，贴在表格上方 */
.bulkbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:10px 0;padding:9px 12px;
         border:1px solid var(--acc);background:#16233a;border-radius:9px}
td.ck,th.ck{width:30px;padding-right:0}
</style></head><body>
<header><h1>运营后台</h1><span class="mut" id="sub"></span><span class="sp"></span>
<button class="btn sm" id="logout" style="display:none">退出</button></header>
<div class="msg" id="msg"></div>
<div id="pop"></div>
<main id="app"></main>
<dialog id="dlg"><form method="dialog"><div class="dlg-h" id="dlg-h"></div>
<div class="dlg-b" id="dlg-b"></div><div class="dlg-f" id="dlg-f"></div></form></dialog>
<script>
var S={users:[],tiers:[],skills:[],catalog:[],tierCounts:{},board:null,q:'',filter:'',
       offset:0,pageSize:100,tab:'users',
       // 列头筛选条件（列之间 AND、同列多选 OR，与服务端 buildUserPredicate 一一对应）
       f:{tiers:[],status:[],skillMode:[],usage:[],hasSkill:[],hospital:'',idle:false},
       sel:{},                 // 勾选的账号 id（翻页/改筛选都不丢，批量操作按它点名）
       matchedIds:[],maxBulk:500};
// 有没有设过任何列筛选（决定要不要把 f 发给服务端、以及"清空"按钮要不要亮）
function hasF(){var f=S.f;return !!(f.tiers.length||f.status.length||f.skillMode.length||
  f.usage.length||f.hasSkill.length||f.hospital||f.idle)}
function selIds(){return Object.keys(S.sel).filter(function(k){return S.sel[k]}).map(Number)}
var $=function(s){return document.querySelector(s)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var money=function(n){return '$'+(Number(n)||0).toFixed(4).replace(/0+$/,'').replace(/\\.$/,'.00')};
// 客户端只看积分（1 积分 = S.creditUsd 美元，默认 0.01）。后台仍按美元填写，但每处额度
// 旁边都要跟一句"用户看到的是 N 积分" —— 否则用户来问"我怎么只剩 3 分"，管理员对着
// 一屏美元根本对不上号。取整方向与客户端一致（上限下取整），显示的数就是用户看到的数。
var CREDIT=function(){return Number(S.creditUsd)||0.01};
var credits=function(n){return Math.floor((Number(n)||0)/CREDIT())};
var creditNote=function(n){return (Number(n)>0)?'<div class="mut" style="font-size:12.5px">= '+credits(n)+' 积分</div>':''};
var dt=function(ms){if(!ms)return '—';var d=new Date(Number(ms));
  return d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})};

// 【api 永不 reject】以前它对 401 抛异常、对非 JSON 响应让 r.json() 自己抛，而全文件
// 19 处 post(...) 里只有 2 处挂了 .catch —— 于是管理台会话一过期（或 Caddy 回了个 502
// 的 HTML 错误页），点"停用/保存/删除/重置口令"就是【没有 toast、不跳登录、按钮像坏了】。
// 统一在这里兜住：401 直接把人送回登录页，其余一律翻成 {ok:false,err}，调用方原有的
// "不 ok 就 toast(j.err)" 那一行就自然把话说出来了。
function api(p,opt){return fetch('/admin/api/'+p,opt).then(function(r){
  if(r.status===401&&p!=='login'){var e=new Error('unauth');e.unauth=1;throw e}
  return r.text().then(function(t){
    try{return JSON.parse(t)}catch(_){throw new Error('服务器返回了非 JSON（HTTP '+r.status+'，多半是网关错误页）')}})})
  .catch(function(e){
    if(e&&e.unauth){renderLogin('登录已过期，请重新登录');return {ok:false,unauth:1,err:'登录已过期'}}
    return {ok:false,err:(e&&e.message)||'网络错误'}})}
function post(p,body){return api(p,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(body||{})})}
// 数字输入：空 = 用 dflt；非法 = 返回 null（调用方据此报错，别再用 Number(x)||0 把
// 「-5」「abc」「1,000」全吞成 0 —— 额度那边 0 的含义是【不限】，一次手滑就放开全档。
function numIn(sel,dflt){var v=$(sel).value.trim();if(v==='')return dflt;
  var n=Number(v);return Number.isFinite(n)&&n>=0?n:null}
function toast(m,ok){var e=$('#msg');if(!e)return;e.textContent=m;e.className='msg '+(ok?'ok':'err');
  clearTimeout(toast.t);toast.t=setTimeout(function(){e.className='msg'},5000)}

// ---------- 登录 ----------
function renderLogin(err){
  $('#logout').style.display='none';$('#sub').textContent='';
  $('#app').innerHTML='<section id="login"><h2>运营后台登录</h2>'+
    '<div class="msg '+(err?'err':'')+'" style="'+(err?'display:block':'')+'">'+esc(err||'')+'</div>'+
    '<input id="pw" type="password" placeholder="管理员口令" autofocus style="width:100%">'+
    '<div class="row" style="margin:11px 0"><input id="cap" placeholder="验证码" maxlength="4" '+
    'autocomplete="off" style="flex:1;text-transform:uppercase;letter-spacing:.22em">'+
    '<img id="capimg" title="点击刷新" style="height:42px;border-radius:8px;cursor:pointer;border:1px solid var(--line)"></div>'+
    '<button class="btn primary" id="go" style="width:100%">登录</button></section>';
  var capId='';
  function refresh(){fetch('/captcha',{cache:'no-store'}).then(function(r){
    capId=r.headers.get('x-captcha-id')||'';return r.text()}).then(function(svg){
    $('#capimg').src='data:image/svg+xml;utf8,'+encodeURIComponent(svg)})}
  refresh();$('#capimg').onclick=refresh;
  var go=function(){post('login',{password:$('#pw').value,captcha:$('#cap').value.trim(),captchaId:capId})
    .then(function(j){if(j.ok)load();else renderLogin(j.err||'登录失败')})
    .catch(function(){renderLogin('网络错误')})};
  $('#go').onclick=go;
  $('#pw').onkeydown=$('#cap').onkeydown=function(e){if(e.key==='Enter')go()};
}

// ---------- 主界面 ----------
function load(){
  api('overview?q='+encodeURIComponent(S.q)+'&filter='+encodeURIComponent(S.filter||'')+
      (hasF()?'&f='+encodeURIComponent(JSON.stringify(S.f)):'')+
      '&limit='+S.pageSize+'&offset='+(S.offset||0)).then(function(d){
    if(!d.ok){if(!d.unauth)renderLogin(d.err||'加载失败');return}
    S.users=d.users;S.tiers=d.tiers;S.skills=d.skills;S.board=d.board;S.total=d.total;S.matched=d.matched;
    S.catalog=d.catalog||[];S.tierCounts=d.tierCounts||{};S.creditUsd=d.creditUsd||0.01;
    S.matchedIds=d.matchedIds||[];S.maxBulk=d.maxBulk||500;
    render()})
}
function render(){
  $('#logout').style.display='';
  $('#sub').textContent='共 '+S.total+' 个账号';
  $('#app').innerHTML=
    '<div class="tabs">'+
      tabBtn('users','用户')+tabBtn('board','看板')+tabBtn('bill','对账')+tabBtn('tiers','档位')+tabBtn('prov','模型供应商')+tabBtn('chan','上游通道')+tabBtn('packs','技能包')+tabBtn('webpacks','界面包')+tabBtn('feedback','用户反馈')+tabBtn('audit','审计')+
    '</div><div id="pane"></div>';
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'),function(b){
    b.onclick=function(){S.tab=b.dataset.k;
      if(S.tab==='audit')loadAudit();
      else if(S.tab==='chan')loadChannels();
      else if(S.tab==='prov')loadProviders();
      else if(S.tab==='bill')loadBill();
      else if(S.tab==='packs')loadPacks();
      else if(S.tab==='webpacks')loadWebPacks();
      else if(S.tab==='feedback')loadFeedback();
      else render()}});
  if(S.tab==='users')paneUsers();
  else if(S.tab==='board')paneBoard();
  else if(S.tab==='tiers')paneTiers();
  else if(S.tab==='prov')paneProviders();
  else if(S.tab==='chan')paneChannels();
  else if(S.tab==='bill')paneBill();
}
function tabBtn(k,label){return '<button data-k="'+k+'" class="'+(S.tab===k?'on':'')+'">'+label+'</button>'}

// ---------- 用户 ----------
// 一格「已用 / 上限」＋进度条。日、月两列共用。
function usageCell(used,lim){
  if(!(lim>0))return '<span class="usage">'+money(used)+' <span class="mut">/ 不限</span></span>';
  var pct=Math.min(100,Math.round(used/lim*100));
  return '<div class="usage">'+money(used)+' <span class="mut">/ '+money(lim)+' ('+pct+'%)</span></div>'+
    '<div class="bar '+(pct>=100?'bad':pct>=80?'warn':'')+'"><i style="width:'+pct+'%"></i></div>'}

var USER_FILTERS=[['','全部'],['overmonth','本月已触顶'],['nearmonth','本月≥80%'],
  ['overday','今日已触顶'],['suspended','已停用'],['pwchange','待改密'],['idle','30天未活跃']];

// ---- 列头筛选（Excel 式）----
// 每个可筛的列头挂一个 ▾，点开是勾选浮层；列之间 AND、同列多选 OR（服务端 buildUserPredicate 同口径）。
var SKMODE=[['follow','跟随档位'],['any','全部允许'],['pick','自定义白名单']];
function skillModeOf(u){return u.overrides.skills==null?'follow':(String(u.overrides.skills)?'pick':'any')}
function skillCell(u){
  var m=skillModeOf(u);
  if(m==='follow')return '<span class="tag">跟随档位</span><div class="mut" style="font-size:12px">'+
    (u.skills.length?u.skills.length+' 个技能':'不限')+'</div>';
  if(m==='any')return '<span class="tag ok">全部允许</span>';
  return '<span class="tag warn">白名单 '+u.skills.length+'</span>'+
    '<div class="mut" style="font-size:12px" title="'+esc(u.skills.join('、'))+'">'+
    esc(u.skills.slice(0,2).map(skillLabel).join('、'))+(u.skills.length>2?' …':'')+'</div>'}
function skillLabel(id){var hit=S.skills.filter(function(s){return s.id===id})[0];return hit?hit.label:id}
function tierFilterOpts(){
  var seen={},out=[];
  S.tiers.forEach(function(t){seen[t.key]=1;out.push([t.key,t.key+'（'+(S.tierCounts[t.key]||0)+' 人）'])});
  Object.keys(S.tierCounts).forEach(function(k){if(!seen[k])out.push([k,k+'（'+S.tierCounts[k]+' 人，档位已删）'])});
  return out}
// 每列的筛选分组。bool=单个开关（活跃列），text=文本包含（姓名列里的医院）。
function popGroups(col){
  if(col==='tier')return [{k:'tiers',t:'档位',opts:tierFilterOpts()}];
  if(col==='status')return [{k:'status',t:'状态',opts:[['active','正常'],['suspended','已停用'],['pwchange','待改密']]}];
  if(col==='skill')return [{k:'skillMode',t:'授权形态',opts:SKMODE},
    {k:'hasSkill',t:'能用这些技能（须全部满足）',opts:S.skills.map(function(s){return [s.id,s.label]})}];
  if(col==='usage')return [{k:'usage',t:'用量',opts:[['overday','今日已触顶'],['nearmonth','本月≥80%'],['overmonth','本月已触顶']]}];
  if(col==='seen')return [{k:'idle',t:'活跃',bool:1,opts:[['idle','30 天未活跃']]}];
  if(col==='name')return [{k:'hospital',t:'医院包含',text:1}];
  return []}
function popCount(col){
  return popGroups(col).reduce(function(n,g){
    if(g.bool)return n+(S.f[g.k]?1:0);
    if(g.text)return n+(S.f[g.k]?1:0);
    return n+(S.f[g.k]||[]).length},0)}
function th(label,col){
  if(!col)return '<th>'+label+'</th>';
  var n=popCount(col);
  // role/tabindex：这是个 span 做的按钮，不给这两样键盘用户根本按不到它
  return '<th>'+label+'<span class="fbtn'+(n?' on':'')+'" data-col="'+col+'" role="button" tabindex="0"'+
    ' title="筛选'+(n?'（已设 '+n+' 项）':'')+'" aria-label="筛选'+esc(label)+(n?'（已设 '+n+' 项）':'')+'">▾'+
    (n?' '+n:'')+'</span></th>'}
function closePop(){var p=$('#pop');p.className='';p.innerHTML=''}
function openPop(btn,col){
  var groups=popGroups(col);if(!groups.length)return;
  var html=groups.map(function(g){
    if(g.text)return '<div class="grp">'+g.t+'</div><input data-t="'+g.k+'" value="'+esc(S.f[g.k]||'')+'" style="width:100%">';
    return '<div class="grp">'+g.t+'</div>'+(g.opts.length?g.opts.map(function(o){
      var on=g.bool?!!S.f[g.k]:(S.f[g.k]||[]).indexOf(o[0])>=0;
      return '<label><input type="checkbox" data-g="'+g.k+'" data-v="'+esc(o[0])+'"'+(g.bool?' data-bool="1"':'')+
        (on?' checked':'')+'>'+esc(o[1])+'</label>'}).join(''):'<div class="mut" style="font-size:12.5px">（无可选项）</div>')}).join('');
  var p=$('#pop');
  p.innerHTML=html+'<div class="pf"><button class="btn sm" data-p="clear">清空本列</button>'+
    '<span class="sp" style="flex:1"></span><button class="btn sm primary" data-p="ok">确定</button></div>';
  var r=btn.getBoundingClientRect();
  p.className='on';
  // 贴着按钮左下角，右侧空间不够时往左挪，避免浮层跑出视口
  var left=Math.min(r.left+window.scrollX,window.scrollX+document.documentElement.clientWidth-p.offsetWidth-12);
  p.style.left=Math.max(8,left)+'px';p.style.top=(r.bottom+window.scrollY+6)+'px';
  var apply=function(){
    groups.forEach(function(g){
      if(g.text){S.f[g.k]=(p.querySelector('[data-t="'+g.k+'"]')||{value:''}).value.trim();return}
      if(g.bool){var b=p.querySelector('[data-g="'+g.k+'"]');S.f[g.k]=!!(b&&b.checked);return}
      S.f[g.k]=Array.prototype.filter.call(p.querySelectorAll('[data-g="'+g.k+'"]'),function(c){return c.checked})
        .map(function(c){return c.dataset.v})});
    S.offset=0;closePop();load()};
  p.querySelector('[data-p="ok"]').onclick=apply;
  p.querySelector('[data-p="clear"]').onclick=function(){
    groups.forEach(function(g){S.f[g.k]=g.bool?false:(g.text?'':[])});S.offset=0;closePop();load()};
  var inp=p.querySelector('input[data-t]');
  if(inp){inp.focus();inp.onkeydown=function(e){if(e.key==='Enter')apply()}}
}
document.addEventListener('mousedown',function(e){
  var p=$('#pop');if(!p||!p.classList.contains('on'))return;
  if(!p.contains(e.target)&&!(e.target.classList&&e.target.classList.contains('fbtn')))closePop()});
document.addEventListener('keydown',function(e){
  if(e.key==='Escape'&&$('#pop')&&$('#pop').classList.contains('on'))closePop()});

// opt.keep=1：这次重绘不要把焦点抢回搜索框（勾选复选框引起的局部重绘用它，
// 否则每点一下人名前的框，光标就跳去搜索框，接着敲的字全跑进搜索里）。
function paneUsers(opt){
  var sel=selIds();
  var rows=S.users.map(function(u){
    // 【月用量必须画出来】月额度才是主闸，而列表以前只画今日 —— 谁快到月上限只能逐个
    // 点开用量弹窗看。数据（usage.month / limits.monthly）后端一直就在返回，纯粹没画。
    var usage=usageCell(u.usage.today,u.limits.daily);
    var musage=usageCell(u.usage.month,u.limits.monthly);
    return '<tr data-id="'+u.id+'">'+
      '<td class="ck"><input type="checkbox" data-ck="'+u.id+'"'+(S.sel[u.id]?' checked':'')+'></td>'+
      '<td><b>'+esc(u.displayName)+'</b>'+(u.surname?' <span class="rank">姓:'+esc(u.surname)+'</span>':'')+
        '<div class="mut" style="font-size:12.5px">'+esc(u.username)+(u.hospital?' · '+esc(u.hospital):'')+'</div></td>'+
      '<td><span class="tag">'+esc(u.tier)+'</span></td>'+
      '<td>'+(u.status==='active'?'<span class="tag ok">正常</span>':'<span class="tag bad">已停用</span>')+
        (u.mustChangePw?' <span class="tag warn">待改密</span>':'')+'</td>'+
      '<td>'+skillCell(u)+'</td>'+
      '<td>'+usage+'</td>'+
      '<td>'+musage+'</td>'+
      '<td class="mut" style="font-size:12.5px">'+dt(u.lastSeenAt)+(u.clientVersion?'<br>v'+esc(u.clientVersion):'')+'</td>'+
      '<td class="row" style="gap:5px;flex-wrap:nowrap">'+
        '<button class="btn sm" data-a="edit">编辑</button>'+
        '<button class="btn sm" data-a="usage">用量</button>'+
        '<button class="btn sm" data-a="susp">'+(u.status==='active'?'停用':'恢复')+'</button>'+
        '<button class="btn sm" data-a="more">…</button></td></tr>'}).join('');
  // 分页：账号数超过一页时以前【没有任何翻页控件】，第 101 个人在后台根本找不到。
  var from=S.offset+1,to=S.offset+S.users.length;
  var pager=(S.matched>S.users.length||S.offset>0)
    ? '<div class="row" style="margin-top:12px"><span class="mut">第 '+from+'–'+to+' 条，共 '+S.matched+'</span>'+
      '<span class="sp"></span><button class="btn sm" id="prev"'+(S.offset<=0?' disabled':'')+'>上一页</button>'+
      '<button class="btn sm" id="next"'+(to>=S.matched?' disabled':'')+'>下一页</button></div>'
    : '';
  // 全选/全不选：只管【当前这页】。跨页要用下面那个"选中全部命中"，两者分开才不会误伤。
  var pageAll=S.users.length>0&&S.users.every(function(u){return !!S.sel[u.id]});
  var canAllMatched=S.matched>S.users.length&&S.matchedIds.length>0;
  var bulk=sel.length?'<div class="bulkbar">'+
      '<b>已选 '+sel.length+' 人</b>'+
      '<button class="btn sm" id="b-skill">批量技能授权</button>'+
      '<button class="btn sm" id="b-tier">批量改档位</button>'+
      '<button class="btn sm" id="b-susp">批量停用</button>'+
      '<button class="btn sm" id="b-resume">批量恢复</button>'+
      '<span class="sp" style="flex:1"></span>'+
      '<span class="mut" style="font-size:12.5px">一次最多 '+S.maxBulk+' 人</span>'+
      '<button class="btn sm" id="b-clear">取消选择</button></div>':'';
  $('#pane').innerHTML='<section>'+
    '<div class="row" style="margin-bottom:12px">'+
      '<input id="q" placeholder="按姓名筛选：输一个字或两个字（姓氏优先）" value="'+esc(S.q)+'" style="flex:1;min-width:260px">'+
      '<button class="btn" id="clear">清空</button>'+
      '<span class="sp"></span><button class="btn primary" id="add">+ 新建账号</button></div>'+
    '<div class="chips" style="margin-bottom:10px">'+USER_FILTERS.map(function(f){
      return '<span class="chip'+((S.filter||'')===f[0]?' on':'')+'" data-f="'+f[0]+'">'+f[1]+'</span>'}).join('')+'</div>'+
    '<div class="hint">例：输「张」→ 姓张的排最前，名字里带张的排后面；输「欧阳」「小明」同样可用。也可用登录名/手机号/医院找人。'+
    '　列头的 <b>▾</b> 可按档位 / 状态 / 技能授权 / 用量 组合筛选，勾人后可批量调整。</div>'+
    ((S.q||S.filter||hasF())?'<div class="hint">命中 '+S.matched+' / '+S.total+
      (hasF()?' <button class="btn sm" id="fclear" style="margin-left:6px">清空列筛选</button>':'')+'</div>':'')+
    bulk+
    '<table style="margin-top:12px"><thead><tr>'+
    '<th class="ck"><input type="checkbox" id="ckall"'+(pageAll?' checked':'')+' title="选中本页"></th>'+
    th('姓名 / 账号','name')+th('档位','tier')+th('状态','status')+th('技能授权','skill')+
    th('今日用量','usage')+th('本月用量')+th('最近活跃','seen')+th('')+
    '</tr></thead><tbody>'+
    (rows||'<tr><td colspan="9" class="mut" style="padding:22px;text-align:center">没有匹配的账号</td></tr>')+
    '</tbody></table>'+
    (canAllMatched?'<div class="hint"><button class="btn sm" id="selall">选中全部命中的 '+
      Math.min(S.matched,S.matchedIds.length)+' 人</button>'+
      (S.matched>S.matchedIds.length?' <span class="mut">（命中 '+S.matched+' 人，一次最多勾 '+S.maxBulk+'）</span>':'')+'</div>':'')+
    pager+'</section>';

  var q=$('#q');
  q.oninput=function(){clearTimeout(q.t);q.t=setTimeout(function(){S.q=q.value;S.offset=0;load()},220)};
  if(!(opt&&opt.keep)){q.focus();q.setSelectionRange(q.value.length,q.value.length)}
  $('#clear').onclick=function(){S.q='';S.filter='';
    S.f={tiers:[],status:[],skillMode:[],usage:[],hasSkill:[],hospital:'',idle:false};S.offset=0;load()};
  if($('#fclear'))$('#fclear').onclick=$('#clear').onclick;
  $('#add').onclick=dlgAdd;
  // 列头 ▾
  Array.prototype.forEach.call(document.querySelectorAll('#pane .fbtn'),function(b){
    b.onclick=function(e){e.stopPropagation();
      var open=$('#pop').classList.contains('on')&&$('#pop').dataset.col===b.dataset.col;
      closePop();if(open)return;$('#pop').dataset.col=b.dataset.col;openPop(b,b.dataset.col)};
    b.onkeydown=function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();b.onclick(e)}}});
  // 勾选
  Array.prototype.forEach.call(document.querySelectorAll('#pane [data-ck]'),function(c){
    c.onclick=function(){S.sel[c.dataset.ck]=c.checked;paneUsers({keep:1})}});
  $('#ckall').onclick=function(){var on=$('#ckall').checked;
    S.users.forEach(function(u){S.sel[u.id]=on});paneUsers({keep:1})};
  if($('#selall'))$('#selall').onclick=function(){
    S.matchedIds.forEach(function(id){S.sel[id]=true});paneUsers({keep:1})};
  if(sel.length){
    $('#b-clear').onclick=function(){S.sel={};paneUsers({keep:1})};
    $('#b-skill').onclick=function(){dlgBulkSkills(sel)};
    $('#b-tier').onclick=function(){dlgBulkTier(sel)};
    $('#b-susp').onclick=function(){bulkApply(sel,{suspended:true},'停用')};
    $('#b-resume').onclick=function(){bulkApply(sel,{suspended:false},'恢复')};
  }
  if($('#prev'))$('#prev').onclick=function(){S.offset=Math.max(0,S.offset-S.pageSize);load()};
  if($('#next'))$('#next').onclick=function(){S.offset=S.offset+S.pageSize;load()};
  Array.prototype.forEach.call(document.querySelectorAll('#pane .chip[data-f]'),function(c){
    c.onclick=function(){S.filter=c.dataset.f;S.offset=0;load()}});
  Array.prototype.forEach.call(document.querySelectorAll('#pane tbody button'),function(b){
    b.onclick=function(){
      var id=Number(b.closest('tr').dataset.id);
      var u=S.users.filter(function(x){return x.id===id})[0];
      if(b.dataset.a==='edit')dlgEdit(u);
      else if(b.dataset.a==='usage')dlgUsage(u);
      else if(b.dataset.a==='susp')post('suspend',{id:id,suspended:u.status==='active'}).then(function(j){
        toast(j.ok?'已'+(u.status==='active'?'停用':'恢复')+' '+u.displayName:(j.err||'失败'),j.ok);load()});
      else dlgMore(u)}});
}

// ---- 批量操作 ----
// 名单在弹窗里【列出来给人看】：批量操作没有撤销，"我以为选的是另一批人"是这里唯一
// 真正危险的失误，所以宁可多占几行也要把姓名摆出来。
function selNames(ids){
  var byId={};S.users.forEach(function(u){byId[u.id]=u});
  var named=ids.map(function(id){return byId[id]?byId[id].displayName:null}).filter(Boolean);
  var rest=ids.length-named.length;
  return esc(named.slice(0,12).join('、'))+(named.length>12?' 等':'')+
    (rest?'<span class="mut">（另有 '+rest+' 人在其它页）</span>':'')}
function bulkApply(ids,patch,what){
  if(!ids.length)return;
  if(ids.length>S.maxBulk)return toast('一次最多 '+S.maxBulk+' 人，请缩小范围',false);
  if(!confirm('确认对选中的 '+ids.length+' 个账号执行「'+what+'」？这会吊销他们已签发的 key（需重新登录），且不可撤销。'))return;
  post('users-bulk',Object.assign({ids:ids},patch)).then(function(j){
    if(!j.ok)return toast(j.err||'批量操作失败',false);
    var d=$('#dlg');if(d&&d.open)d.close();
    S.sel={};
    toast('已对 '+j.changed+' 个账号'+what+'（已吊销 key，需重新登录）'+
      (j.missing&&j.missing.length?'；'+j.missing.length+' 个已不存在，已跳过':''),true);
    load()})}
function dlgBulkTier(ids){
  dlg('批量改档位 · '+ids.length+' 人',
    '<div class="hint" style="margin-bottom:10px">将要改的账号：'+selNames(ids)+'</div>'+
    // 【必须有一个空的占位项】否则下拉一打开就默认选中第一个档位，管理员不点也是"已选"，
    // 手滑一次就把一批人改到了列表里的第一档。
    '<div class="grid"><label>目标档位</label><select id="bt">'+
      '<option value="">（请选择档位）</option>'+tierOpts('')+'</select></div>'+
    '<div class="hint" style="margin-top:10px">档位决定日/月额度、默认模型与技能白名单。'+
    '各人若单独设过额度覆盖或技能覆盖，那些覆盖<b>仍然优先</b>——要一并清掉请用「批量技能授权 → 跟随档位」。</div>',
    '<button class="btn primary" id="ok" value="default">应用</button>');
  $('#ok').onclick=function(e){e.preventDefault();
    var t=$('#bt').value;if(!t)return toast('请选择档位',false);
    bulkApply(ids,{tier:t},'改到档位 '+t)}}
function dlgBulkSkills(ids){
  dlg('批量技能授权 · '+ids.length+' 人',
    '<div class="hint" style="margin-bottom:10px">将要改的账号：'+selNames(ids)+'</div>'+
    '<div class="hint">与单人编辑同一套三态语义：'+
    '<b>跟随档位</b>＝清掉个人覆盖；<b>全部允许</b>＝覆盖档位、放行所有技能；<b>白名单</b>＝只许选中的这些。</div>'+
    skillChips([],S.skills)+
    '<div class="row" style="margin-top:8px"><button class="btn sm" id="b-follow">跟随档位</button>'+
    '<button class="btn sm" id="b-any">全部允许</button>'+
    '<button class="btn sm" id="b-all">全选为白名单</button>'+
    '<button class="btn sm" id="b-none">清空选择</button></div>'+
    '<div class="hint" id="b-state"></div>'+
    '<div class="hint" style="margin-top:10px">技能是<b>软管控</b>（在客户端执行）：改完会吊销这些人的 key，'+
    '他们下次请求即按新授权走；客户端界面上的模块卡片最迟在<b>下次登录</b>时跟着变。</div>',
    '<button class="btn primary" id="ok" value="default">应用</button>');
  var chips=$('#dlg-b').querySelectorAll('.chip');
  var mode='pick';
  var showState=function(){
    var n=0;Array.prototype.forEach.call(chips,function(c){if(c.classList.contains('on'))n++});
    $('#b-state').innerHTML=mode==='follow'?'将设为：<b>跟随档位</b>（清掉这些人的个人技能覆盖）'
      :mode==='any'?'将设为：<b>全部允许</b>（覆盖档位，放行所有技能）'
      :'将设为：<b>白名单</b>，只允许选中的 '+n+' 个'+(n?'':' —— 一个都没选等于「全部允许」，别用它来收紧')};
  Array.prototype.forEach.call(chips,function(c){c.onclick=function(){mode='pick';c.classList.toggle('on');showState()}});
  $('#b-follow').onclick=function(e){e.preventDefault();mode='follow';
    Array.prototype.forEach.call(chips,function(c){c.classList.remove('on')});showState()};
  $('#b-any').onclick=function(e){e.preventDefault();mode='any';
    Array.prototype.forEach.call(chips,function(c){c.classList.remove('on')});showState()};
  $('#b-all').onclick=function(e){e.preventDefault();mode='pick';
    Array.prototype.forEach.call(chips,function(c){c.classList.add('on')});showState()};
  $('#b-none').onclick=function(e){e.preventDefault();mode='pick';
    Array.prototype.forEach.call(chips,function(c){c.classList.remove('on')});showState()};
  showState();
  $('#ok').onclick=function(e){e.preventDefault();
    var picked=[];Array.prototype.forEach.call(chips,function(c){if(c.classList.contains('on'))picked.push(c.dataset.s)});
    var val=mode==='follow'?null:picked.join(',');
    var what=mode==='follow'?'技能授权改为跟随档位':(picked.length?'技能白名单设为 '+picked.length+' 个技能':'技能授权改为全部允许');
    bulkApply(ids,{skillsOverride:val},what)}}

function dlg(title,bodyHtml,footHtml){
  $('#dlg-h').textContent=title;$('#dlg-b').innerHTML=bodyHtml;
  $('#dlg-f').innerHTML=(footHtml||'')+'<button class="btn" value="cancel">关闭</button>';
  // 一步换成下一屏（如"新建"→"初始口令"）时对话框已经是开着的，
  // 对已打开的 dialog 再 showModal() 会抛 InvalidStateError，整条链就断在这。
  var d=$('#dlg');if(d.open)d.close();d.showModal()}

function tierOpts(sel){return S.tiers.map(function(t){
  return '<option value="'+esc(t.key)+'"'+(t.key===sel?' selected':'')+'>'+esc(t.key)+
    (t.daily_usd?' ($'+t.daily_usd+'/天)':' (日不限)')+'</option>'}).join('')}

function dlgAdd(){
  dlg('新建账号',
    '<div class="grid">'+
    '<label>姓名 *</label><input id="f-dn" placeholder="张三">'+
    '<label>登录名 *</label><input id="f-un" placeholder="zhangsan（小写字母开头）">'+
    '<label>医院</label><input id="f-hos">'+
    '<label>职位</label><input id="f-pos">'+
    '<label>手机号</label><input id="f-ph">'+
    '<label>档位</label><select id="f-tier">'+tierOpts('free')+'</select>'+
    '<label>备注</label><input id="f-note"></div>'+
    '<div class="hint">初始口令由系统强随机生成，创建后只显示这一次——请当场复制转交，库里只存哈希。用户首次登录会被强制改密。</div>',
    '<button class="btn primary" id="ok" value="default">创建</button>');
  $('#ok').onclick=function(e){e.preventDefault();
    post('user-add',{displayName:$('#f-dn').value.trim(),username:$('#f-un').value.trim(),
      hospital:$('#f-hos').value.trim(),position:$('#f-pos').value.trim(),phone:$('#f-ph').value.trim(),
      tier:$('#f-tier').value,note:$('#f-note').value.trim()}).then(function(j){
      if(!j.ok)return toast(j.err||'创建失败',false);
      dlg('账号已创建','<p>请把下面两项转交给用户，<b>初始口令只显示这一次</b>：</p>'+
        '<div class="grid" style="margin-top:10px"><label>登录名</label><div class="pw">'+esc(j.user.username)+'</div>'+
        '<label>初始口令</label><div class="pw">'+esc(j.initialPassword)+'</div></div>'+
        '<div class="hint">用户首次登录后必须修改口令才能使用。</div>');
      S.q='';load()})}
}

// 【已选但列表里没有的项也要画出来】保存时只收集"当前渲染出来的 chip"，所以任何渲染不
// 出来的已选项都会被静默丢掉：技能目录读不到（SKILLS_DIR 配错时 skillTable 静默返回 []）
// 就能把白名单整个清空，管理员只是进来改了个备注。画成灰 chip 并标「已失效」，既保住
// 数据、又让人看得见问题。
function skillChips(selected,all){
  var sel=selected||[];
  var known={};all.forEach(function(s){known[s.id]=1});
  var extra=sel.filter(function(id){return !known[id]}).map(function(id){return {id:id,label:id,stale:1}});
  return '<div class="chips">'+all.concat(extra).map(function(s){
    return '<span class="chip'+(sel.indexOf(s.id)>=0?' on':'')+'" data-s="'+esc(s.id)+'"'+
      (s.stale?' title="技能目录里已经没有它了（SKILLS_DIR 配错？）——保留原样，别静默丢掉"':'')+'>'+
      esc(s.label)+(s.stale?' <span class="mut">·已失效</span>':'')+'</span>'}).join('')+'</div>'}

function dlgEdit(u){
  var ov=u.overrides;
  dlg('编辑 · '+u.displayName,
    '<div class="grid">'+
    '<label>姓名</label><input id="e-dn" value="'+esc(u.displayName)+'">'+
    '<label>姓</label><input id="e-sn" value="'+esc(u.surname)+'" placeholder="留空则按姓名自动识别">'+
    '<label>医院</label><input id="e-hos" value="'+esc(u.hospital)+'">'+
    '<label>职位</label><input id="e-pos" value="'+esc(u.position)+'">'+
    '<label>手机号</label><input id="e-ph" value="'+esc(u.phone)+'">'+
    '<label>档位</label><select id="e-tier">'+tierOpts(u.tier)+'</select>'+
    '<label>日额度</label><input id="e-day" value="'+(ov.daily==null?'':ov.daily)+'" placeholder="留空=随档位（当前 '+(u.limits.daily||'不限')+'），0=不限">'+
    '<label>月额度</label><input id="e-mon" value="'+(ov.monthly==null?'':ov.monthly)+'" placeholder="留空=随档位（当前 '+(u.limits.monthly||'不限')+'），0=不限">'+
    '<label>备注</label><input id="e-note" value="'+esc(u.note)+'"></div>'+
    '<div style="margin-top:14px"><label class="mut">技能白名单</label>'+
    // 【三态必须写明】以前只有"跟随档位/全选"两个按钮，而把 chips 一个个点灭产生的
    // skillsOverride='' 在系统里的含义是【不限 = 全部放行】，与管理员"收回全部技能"的
    // 意图恰好相反，界面上还完全看不出区别。现在三态各有按钮、当前态实时显示在下面。
    '<div class="hint">这是<b>软管控</b>：技能在客户端执行，真正硬的闸是额度与模型档次。</div>'+
    skillChips(ov.skills==null?null:String(ov.skills).split(',').filter(Boolean),S.skills)+
    '<div class="row" style="margin-top:8px"><button class="btn sm" id="e-none">跟随档位</button>'+
    '<button class="btn sm" id="e-any">全部允许</button>'+
    '<button class="btn sm" id="e-all">全选为白名单</button></div>'+
    '<div class="hint" id="e-state"></div></div>'+
    '<div class="hint" style="margin-top:12px">改档位或技能会吊销该用户已签发的 key（需重新登录）；'+
    '<b>只改额度不会</b>——额度不在票据里，网关每一单都现查库，改完下一次请求就生效。</div>',
    '<button class="btn primary" id="ok" value="default">保存</button>');
  var chips=$('#dlg-b').querySelectorAll('.chip');
  var mode=ov.skills==null?'follow':(String(ov.skills)?'pick':'any');
  var showState=function(){
    var n=0;Array.prototype.forEach.call(chips,function(c){if(c.classList.contains('on'))n++});
    $('#e-state').innerHTML=mode==='follow'?'当前：<b>跟随档位</b>（该用户不做单独限制）'
      :mode==='any'?'当前：<b>全部允许</b>（覆盖档位，放行所有技能）'
      :'当前：<b>白名单</b>，只允许选中的 '+n+' 个'+(n?'':' —— 一个都没选等于「全部允许」，要收紧请改额度或档位')};
  Array.prototype.forEach.call(chips,function(c){c.onclick=function(){mode='pick';c.classList.toggle('on');showState()}});
  $('#e-none').onclick=function(e){e.preventDefault();mode='follow';
    Array.prototype.forEach.call(chips,function(c){c.classList.remove('on')});showState()};
  $('#e-any').onclick=function(e){e.preventDefault();mode='any';
    Array.prototype.forEach.call(chips,function(c){c.classList.remove('on')});showState()};
  $('#e-all').onclick=function(e){e.preventDefault();mode='pick';
    Array.prototype.forEach.call(chips,function(c){c.classList.add('on')});showState()};
  showState();
  $('#ok').onclick=function(e){e.preventDefault();
    var d=numIn('#e-day',''),m=numIn('#e-mon','');
    if(d===null||m===null)return toast('额度须是 ≥0 的数字（0=不限，留空=随档位）',false);
    var picked=[];Array.prototype.forEach.call(chips,function(c){if(c.classList.contains('on'))picked.push(c.dataset.s)});
    post('user-update',{id:u.id,displayName:$('#e-dn').value.trim(),surname:$('#e-sn').value.trim(),
      hospital:$('#e-hos').value.trim(),position:$('#e-pos').value.trim(),phone:$('#e-ph').value.trim(),
      tier:$('#e-tier').value,note:$('#e-note').value.trim(),
      dailyOverride:d,monthlyOverride:m,
      skillsOverride:mode==='follow'?null:picked.join(',')}).then(function(j){
      if(!j.ok)return toast(j.err||'保存失败',false);
      $('#dlg').close();toast('已保存'+(j.keyRevoked?'（已吊销该用户 key，需重新登录）':''),true);load()})}
}

function dlgMore(u){
  dlg('更多操作 · '+u.displayName,
    '<div class="row" style="gap:10px;flex-direction:column;align-items:stretch">'+
    // 临时加额是最高频的运维动作（"医生正跑着一篇综述，额度不够了"），以前要进编辑弹窗
    // 手算新数字。现在一格填增量、一键落。改额度不再吊销 key，所以人不会被踢下线。
    '<div class="row"><input id="m-amt" value="1" style="width:90px" inputmode="decimal">'+
    '<button class="btn" id="m-add" style="flex:1">日额度 +$，立即生效</button></div>'+
    '<div class="hint">当前日上限 '+(u.limits.daily?money(u.limits.daily):'不限')+
    '。这会把该用户的<b>日额度覆盖</b>设成「当前上限 + 增量」，一直有效到你把它清空（编辑弹窗里留空 = 随档位）。'+
    '<b>不会</b>吊销 key，用户手上正在跑的活不受影响。</div>'+
    '<button class="btn" id="m-pw">重置口令</button>'+
    '<div class="hint">生成新的强随机口令，旧口令与已签发 key 立即失效，用户下次登录须再次改密。</div>'+
    '<button class="btn" id="m-key">重置 key</button>'+
    '<div class="hint">只吊销已签发的 key（口令不变）。怀疑 key 外借/泄露时用。</div>'+
    '<button class="btn danger" id="m-del">删除账号</button>'+
    '<div class="hint">连同用量记录一并删除，不可恢复。</div></div>');
  $('#m-add').onclick=function(e){e.preventDefault();
    var inc=Number($('#m-amt').value.trim());
    if(!Number.isFinite(inc)||inc<=0)return toast('增量要是大于 0 的数字',false);
    if(!(u.limits.daily>0))return toast('该用户日额度本来就是「不限」，不需要加额',false);
    var nv=Math.round((u.limits.daily+inc)*10000)/10000;
    post('user-update',{id:u.id,dailyOverride:nv}).then(function(j){
      if(!j.ok)return toast(j.err||'失败',false);
      $('#dlg').close();toast('已把 '+u.displayName+' 的日上限提到 '+money(nv)+'（未吊销 key）',true);load()})};
  $('#m-pw').onclick=function(e){e.preventDefault();post('reset-password',{id:u.id}).then(function(j){
    if(!j.ok)return toast(j.err||'失败',false);
    dlg('新口令 · '+u.displayName,'<p>请转交给用户，<b>只显示这一次</b>：</p>'+
      '<div class="pw" style="margin-top:8px">'+esc(j.initialPassword)+'</div>');load()})};
  $('#m-key').onclick=function(e){e.preventDefault();post('reset-key',{id:u.id}).then(function(j){
    $('#dlg').close();toast(j.ok?'已吊销该用户全部 key':'失败',j.ok);load()})};
  $('#m-del').onclick=function(e){e.preventDefault();
    dlg('删除 · '+u.displayName,'<p>此操作<b>不可恢复</b>。请输入登录名 <code>'+esc(u.username)+'</code> 以确认：</p>'+
      '<input id="d-c" style="width:100%;margin-top:10px" autocomplete="off">',
      '<button class="btn danger" id="d-ok" value="default">确认删除</button>');
    $('#d-ok').onclick=function(ev){ev.preventDefault();
      post('user-del',{id:u.id,confirm:$('#d-c').value.trim()}).then(function(j){
        if(!j.ok)return toast(j.err||'删除失败',false);
        $('#dlg').close();toast('已删除 '+u.displayName,true);load()})}}
}

function dlgUsage(u){
  dlg('用量 · '+u.displayName,'<p class="mut">加载中…</p>');
  api('user-usage?id='+u.id).then(function(j){
    if(!j.ok)return $('#dlg-b').innerHTML='<p class="mut">'+esc(j.err||'加载失败')+'</p>';
    var s=j.series.slice().reverse();
    var max=Math.max.apply(null,s.map(function(x){return x.cost_usd}).concat([1e-9]));
    var spark=s.length?'<div class="spark">'+s.map(function(x){
      return '<i style="height:'+Math.max(2,Math.round(x.cost_usd/max*52))+'px" title="'+x.day+' '+money(x.cost_usd)+'"></i>'}).join('')+'</div>'+
      '<div class="hint">近 '+s.length+' 天，峰值 '+money(max)+'/天</div>':'<p class="mut">还没有用量记录</p>';
    var det=j.detail.map(function(d){
      // 【供应商这一列不能省】故障切换发生后，这一单到底是主供应商还是备用出的、该按谁的
      // 单价对账，只有这里看得出来。库里一直记着 provider，以前只是没画。
      return '<tr><td class="mut" style="font-size:12.5px">'+dt(d.ts)+'</td><td>'+esc(d.model||'—')+'</td>'+
        '<td class="mut" style="font-size:12.5px">'+esc(d.provider||'env兜底')+'</td>'+
        '<td>'+esc(d.skill||'—')+'</td><td class="mut">'+d.prompt_tokens+'/'+d.completion_tokens+
        (d.cached_tokens?' <span class="tag">缓存'+d.cached_tokens+'</span>':'')+'</td>'+
        '<td>'+money(d.cost_usd)+'</td></tr>'}).join('');
    $('#dlg-b').innerHTML='<div class="kpi" style="margin-bottom:14px">'+
      '<div><span class="mut">今日</span><b>'+money(j.user.usage.today)+'</b></div>'+
      '<div><span class="mut">本月</span><b>'+money(j.user.usage.month)+'</b></div>'+
      '<div><span class="mut">日上限</span><b>'+(j.user.limits.daily?money(j.user.limits.daily):'不限')+'</b></div>'+
      '<div><span class="mut">月上限</span><b>'+(j.user.limits.monthly?money(j.user.limits.monthly):'不限')+'</b></div></div>'+
      spark+'<h2 style="margin:16px 0 8px">最近调用</h2>'+
      (det?'<table><thead><tr><th>时间</th><th>模型</th><th>供应商</th><th>技能</th><th>tokens 入/出</th><th>成本</th></tr></thead><tbody>'+det+'</tbody></table>'
          :'<p class="mut">还没有调用记录</p>')})
}

// ---------- 看板 ----------
function paneBoard(){
  var s=S.board.series.slice().reverse();
  var max=Math.max.apply(null,s.map(function(x){return x.cost}).concat([1e-9]));
  var total=s.reduce(function(a,b){return a+b.cost},0);
  var calls=s.reduce(function(a,b){return a+b.calls},0);
  $('#pane').innerHTML='<section><h2>看板 <span class="mut">近 30 天</span></h2>'+
    '<div class="kpi" style="margin-bottom:16px">'+
    '<div><span class="mut">账号总数</span><b>'+S.total+'</b></div>'+
    '<div><span class="mut">近 24h 活跃</span><b>'+S.board.activeUsers+'</b></div>'+
    '<div><span class="mut">30 天总用量</span><b>'+money(total)+'</b></div>'+
    '<div><span class="mut">30 天调用数</span><b>'+calls+'</b></div></div>'+
    (s.length?'<div class="spark">'+s.map(function(x){
      return '<i style="height:'+Math.max(2,Math.round(x.cost/max*52))+'px" title="'+x.day+' '+money(x.cost)+'"></i>'}).join('')+
      '</div><div class="hint">峰值 '+money(max)+'/天</div>':'<p class="mut">还没有用量数据</p>')+
    '</section>'+
    '<section id="lm-box"><h2>并发与排队</h2><p class="mut">加载中…</p></section>'+
    '<section id="nt-box"><h2>公告</h2><p class="mut">加载中…</p></section>';
  // 【异步只填这一个盒子，不回调 render】render() 在 board 页会再调回本函数，
  // 走 load→render→pane→load 就是死循环（本文件另外两处已经踩过）。
  api('notice').then(function(d){if(d.ok)renderNotice(d)});
  loadLimits();
}

// ---------- 并发与排队 ----------
// 上游按并发/RPM 限速：人一多就是一片 429，而 429 到客户端上只表现为"这一轮没输出"，
// 用户既不知道发生了什么也不知道要等多久。配上并发上限后，超出的请求在网关排队，
// 客户端能显示"正在排队，前面还有 N 个"。这一页就是那个上限的开关 + 当下的实时队况。
function loadLimits(){
  api('limits').then(function(d){if(d.ok)renderLimits(d)});
  // 队况是实时的，看板开着就自动刷。
  // 【必须先看盒子在不在，再决定发不发请求】会话过期时 api() 会把人送回登录页 —— 那时 #lm-box
  // 已经不存在，若照旧每 10 秒打一次，就会不停地重画登录页（本文件另一处死循环的同类错法）。
  if(!window._lmTimer)window._lmTimer=setInterval(function(){
    if($('#lm-box')&&S.tab==='board')api('limits').then(function(d){if(d.ok)renderLimits(d)})},10000);
}
function renderLimits(d){
  var box=$('#lm-box');if(!box)return;                 // 用户可能已经切走了
  var L=d.limits||{},st=d.stats||{},cnt=st.counters||{};
  var secs=function(ms){return ms>=1000?(ms/1000).toFixed(ms>=10000?0:1)+' 秒':(ms||0)+' ms'};
  var tierConc=(d.tiers||[]).filter(function(t){return t.max_conc>0});
  box.innerHTML='<div class="row"><h2 style="margin:0">并发与排队</h2>'+
    (L.maxConcurrent>0?'<span class="tag ok">已限流 '+L.maxConcurrent+' 路</span>':'<span class="tag">未限流</span>')+
    (st.rateLimited?'<span class="tag bad" title="上游刚刚回过 429">上游限速中（约 '+secs(st.rateLimited.retryAfterMs)+'后恢复）</span>':'')+
    '<span class="sp"></span><button class="btn sm" id="lm-rf">刷新</button></div>'+
    '<div class="kpi" style="margin:12px 0">'+
    '<div><span class="mut">正在调用上游</span><b>'+(st.running||0)+(L.maxConcurrent>0?' / '+L.maxConcurrent:'')+'</b></div>'+
    '<div><span class="mut">正在排队</span><b>'+(st.waiting||0)+'</b></div>'+
    '<div><span class="mut">队首已等</span><b>'+secs(st.oldestWaitMs||0)+'</b></div>'+
    '<div><span class="mut">平均单次耗时</span><b>'+(st.avgMs?secs(st.avgMs):'—')+'</b></div></div>'+
    '<div class="grid" style="grid-template-columns:150px 1fr;max-width:660px">'+
    '<label>全站并发上限</label><input id="lm-c" value="'+(L.maxConcurrent||0)+'" placeholder="0 = 不限">'+
    '<label>单用户并发上限</label><input id="lm-u" value="'+(L.perUser||0)+'" placeholder="0 = 不限；档位可单独覆盖">'+
    '<label>最多排多少个</label><input id="lm-q" value="'+(L.maxQueue||0)+'" placeholder="0 = 不限；排满后新请求直接被拒">'+
    '<label>最长等待（秒）</label><input id="lm-w" value="'+Math.round((L.maxWaitMs||0)/1000)+'" placeholder="0 = 一直等">'+
    '</div>'+
    '<div class="hint" style="margin-top:10px">怎么定「全站并发上限」：看你上游套餐允许的并发数（DeepSeek 等按 RPM/并发限速），'+
    '<b>略小于</b>它。设 0 = 不限 = 全部请求直接打上游，撞上限就是 429（客户端只看到"这轮没输出"）。'+
    '改动<b>立刻生效</b>，不用重启，也不会踢任何人下线；放宽上限时队里的人当场被放出去。</div>'+
    '<div class="hint" style="margin-top:6px">「最长等待」到了还没轮到，客户端会收到一个明确的"服务器繁忙"而不是一直转圈。'+
    '排队期间客户端每两秒问一次自己的位次并显示给用户。<b>设到 3 分钟以上前</b>先确认 Caddy 的 '+
    '<code>response_header_timeout</code> 够大（排队时间和推理时间一起算在它里面，配小了会被 504 掐掉）。</div>'+
    (tierConc.length?'<div class="hint" style="margin-top:6px">档位单独设了并发的：'+
      tierConc.map(function(t){return '<span class="tag">'+esc(t.key)+' '+t.max_conc+' 路</span>'}).join(' ')+
      '（这些档位不看上面的「单用户并发上限」）</div>':'')+
    '<div class="row" style="margin-top:14px"><button class="btn primary" id="lm-save">保存</button>'+
    '<span class="mut" style="font-size:12.5px">累计：放行 '+(cnt.admitted||0)+' · 排过队 '+(cnt.queued||0)+
      ' · 等超时 '+(cnt.timeout||0)+' · 队满被拒 '+(cnt.rejected||0)+'</span></div>'+
    ((st.byUser||[]).length?'<div style="margin-top:14px"><label class="mut">此刻谁在占位</label>'+
      '<table><thead><tr><th>用户</th><th>在飞请求</th></tr></thead><tbody>'+
      st.byUser.map(function(r){return '<tr><td><b>'+esc(r.displayName||'')+'</b> <span class="mut">'+esc(r.username)+'</span></td>'+
        '<td>'+r.running+'</td></tr>'}).join('')+'</tbody></table></div>':'');
  $('#lm-rf').onclick=function(e){e.preventDefault();loadLimits()};
  $('#lm-save').onclick=function(e){e.preventDefault();
    var c=numIn('#lm-c',0),u=numIn('#lm-u',0),q=numIn('#lm-q',0),w=numIn('#lm-w',0);
    if(c===null||u===null||q===null||w===null)return toast('并发/排队参数须是 ≥0 的整数（0 = 不限）',false);
    if([c,u,q,w].some(function(x){return Math.floor(x)!==x}))return toast('并发/排队参数须是整数',false);
    if(u>0&&c>0&&u>c)return toast('单用户并发（'+u+'）比全站上限（'+c+'）还大，等于没设——请调小',false);
    post('limits',{maxConcurrent:c,perUser:u,maxQueue:q,maxWaitMs:w*1000}).then(function(j){
      if(!j.ok)return toast(j.err||'保存失败',false);
      toast('已保存并立刻生效',true);loadLimits()})}
}

// ---------- 公告 ----------
// 通知全员（今晚维护 / 某模型下线 / 新版客户端已发）此前只能一个个发微信。
//
// 【2026-07-31 改成"一条一行 + 历史"】老设计全站只有当前那一条：客户端点掉就再也找不回来，
// 管理员自己也查不到发过什么。现在发一条是新增一行，客户端在「公告」面板里能往回翻半年；
// 撤下只是标记（这一页仍列着，标灰），删除才是真删。
// 客户端拿列表走 /api/notices，未读红点走 /api/notice 的 digest（只有 id/级别/时间）。
var NT_EDIT = 0;   // 正在改哪一条（0 = 在写新的）
function renderNotice(d){
  var box=$('#nt-box');if(!box)return;              // 用户可能已经切走了
  var list=d.notices||[],vs=d.versions||[],keep=d.keepDays||180;
  var editing=NT_EDIT?list.filter(function(x){return x.id===NT_EDIT})[0]:null;
  if(NT_EDIT&&!editing)NT_EDIT=0;                   // 那条被别处删了
  var n=editing||{level:'info'};
  var lv=function(v,label,hint){return '<option value="'+v+'"'+(n.level===v?' selected':'')+'>'+label+' —— '+hint+'</option>'};
  var lvTag=function(l){return l==='urgent'?'<span class="tag bad">紧急</span>':
    l==='warn'?'<span class="tag warn">警告</span>':'<span class="tag">提示</span>'};

  var rows=list.map(function(x){
    var withdrawn=x.status!=='active';
    return '<tr data-id="'+x.id+'"'+(withdrawn?' style="opacity:.55"':'')+'>'+
      '<td style="white-space:nowrap">'+dt(x.createdAt)+
        (x.updatedAt-x.createdAt>60000?'<div class="mut" style="font-size:12px">改于 '+dt(x.updatedAt)+'</div>':'')+'</td>'+
      '<td>'+lvTag(x.level)+'</td>'+
      '<td>'+esc(x.text||'')+
        (x.minClientVersion?'<div class="mut" style="font-size:12.5px">要求 ≥ '+esc(x.minClientVersion)+
          (x.downloadUrl?'（带下载链接）':'')+'</div>':'')+'</td>'+
      '<td>'+(withdrawn?'<span class="tag">已撤下</span>':'<span class="tag ok">在架</span>')+'</td>'+
      '<td class="row" style="gap:5px;flex-wrap:nowrap">'+
        '<button class="btn sm" data-a="ed">编辑</button>'+
        '<button class="btn sm" data-a="'+(withdrawn?'restore':'withdraw')+'">'+(withdrawn?'恢复':'撤下')+'</button>'+
        '<button class="btn sm danger" data-a="rm">删除</button></td></tr>'}).join('');

  box.innerHTML='<div class="row"><h2 style="margin:0">公告</h2>'+
    '<span class="mut" style="font-size:12.5px">共 '+list.length+' 条 · 保留 '+keep+' 天</span></div>'+
    '<div class="hint" style="margin:8px 0 12px">发出去后：已登录的客户端几分钟内在顶栏「公告」按钮上看到未读红点，'+
    '点开就是<b>近 '+keep+' 天的公告列表</b>——不会自己弹出来打断人，也不会像以前那样点一下就再也找不回来。'+
    '内容写错了用「编辑」改（不会把已读的人重新标成未读）；有新消息就<b>发新的一条</b>。</div>'+
    '<div class="grid" style="grid-template-columns:104px 1fr">'+
    '<label>内容</label><textarea id="nt-t" rows="3" style="width:100%" placeholder="今晚 22:00–22:30 维护，期间可能无法生成。">'+esc(n.text||'')+'</textarea>'+
    '<label>级别</label><select id="nt-l">'+
      lv('info','提示','蓝色，日常通知')+lv('warn','警告','黄色，会影响使用')+lv('urgent','紧急','红色，需要立刻知道')+'</select>'+
    '<label>最低版本</label><input id="nt-v" value="'+esc(n.minClientVersion||'')+'" placeholder="如 1.2.0；留空 = 不检查">'+
    '<label>下载地址</label><input id="nt-u" value="'+esc(n.downloadUrl||'')+'" placeholder="带 http(s) 前缀，留空 = 只提示不给链接">'+
    '</div>'+
    '<div class="hint" style="margin-top:10px">填了「最低版本」后，比它旧的客户端会被额外提示升级'+
    '（认不出版本号的构建 —— 如开发机的 dev —— 一律不催，免得每次打开都被弹）。</div>'+
    '<div class="hint" style="margin-top:6px">当前在用的客户端版本：'+
      (vs.length?vs.map(function(v){return '<span class="tag">'+esc(v.v)+' × '+v.n+'</span>'}).join(' ')
                :'<span class="mut">还没有客户端报过版本</span>')+'</div>'+
    '<div class="row" style="margin-top:14px">'+
      '<button class="btn primary" id="nt-save">'+(editing?'保存修改（第 '+editing.id+' 条）':'发布新公告')+'</button>'+
      (editing?'<button class="btn" id="nt-cancel">取消编辑</button>':'')+
      '<span class="sp"></span><button class="btn sm" id="nt-prev">预览</button></div>'+
    '<div id="nt-pv" style="margin-top:12px"></div>'+
    '<h3 style="margin:18px 0 8px;font-size:15px">已发布的公告</h3>'+
    '<table><thead><tr><th>时间</th><th>级别</th><th>内容</th><th>状态</th><th></th></tr></thead>'+
    '<tbody>'+(rows||'<tr><td colspan="5" class="mut">还没发过公告</td></tr>')+'</tbody></table>'+
    '<div class="hint" style="margin-top:8px">「撤下」= 客户端立刻不再显示，但这一页仍留着（你要能查到自己发过什么）；'+
    '「删除」才是真删。超过 '+keep+' 天的行每天自动清理。</div>';

  var body=function(){return {text:$('#nt-t').value,level:$('#nt-l').value,
    minClientVersion:$('#nt-v').value.trim(),downloadUrl:$('#nt-u').value.trim()}};
  var reload=function(){api('notice').then(function(d2){if(d2.ok)renderNotice(d2)})};
  $('#nt-save').onclick=function(e){e.preventDefault();
    var b=body();b.action=NT_EDIT?'edit':'publish';if(NT_EDIT)b.id=NT_EDIT;
    post('notice',b).then(function(j){
      if(!j.ok)return toast(j.err||'保存失败',false);
      toast(NT_EDIT?'已保存修改（不会重新打扰已读的人）':'公告已发布（客户端几分钟内看到红点）',true);
      NT_EDIT=0;reload()})};
  if($('#nt-cancel'))$('#nt-cancel').onclick=function(e){e.preventDefault();NT_EDIT=0;reload()};
  $('#nt-prev').onclick=function(e){e.preventDefault();
    var b=body(),cls=b.level==='info'?'ok':'err';
    $('#nt-pv').innerHTML='<div class="msg '+cls+'" style="position:static;max-width:none;display:block">'+
      (b.level==='urgent'?'🔴 ':b.level==='warn'?'🟡 ':'🔵 ')+esc(b.text||'（没有正文）')+
      (b.minClientVersion?'<br><b>请升级到 '+esc(b.minClientVersion)+' 或更高版本</b>'+
        (b.downloadUrl?'（公告里会带一个下载链接）':''):'')+'</div>'};

  Array.prototype.forEach.call(box.querySelectorAll('tbody button'),function(btn){
    btn.onclick=function(e){e.preventDefault();
      var id=Number(btn.closest('tr').dataset.id),a=btn.dataset.a;
      if(a==='ed'){NT_EDIT=id;renderNotice(d);
        // 【重画后再滚回表单】编辑框在页面上半部分，长列表下点「编辑」不滚就像什么都没发生
        var t=$('#nt-t');if(t){t.scrollIntoView({block:'center'});t.focus()}
        return}
      if(a==='rm'&&!confirm('删除这条公告？删了就找不回来了（只是不想让客户端看到的话，用「撤下」）。'))return;
      post('notice',{action:a==='rm'?'remove':a,id:id}).then(function(j){
        if(!j.ok)return toast(j.err||'操作失败',false);
        toast(a==='rm'?'已删除':a==='withdraw'?'已撤下（客户端几分钟内不再显示）':'已恢复',true);
        if(a==='rm'&&NT_EDIT===id)NT_EDIT=0;
        reload()})}});
}

// ---------- 对账 ----------
// 为什么要有这一页：usage_log 一直记着 model 与 provider 两列，却没有任何一处按它们聚合，
// 要回答"这个月这家该收我多少""哪个模型最烧钱"只能 SSH 进去手写 SQL。而单价配错造成的
// 计费偏差不会报错、只会静默偏 —— 逐项对账是唯一能发现它的手段。
function dayStr(ms){var d=new Date(ms);return d.toISOString().slice(0,10)}
function loadBill(){
  render();
  if(!S.billTo){S.billTo=dayStr(Date.now());S.billFrom=dayStr(Date.now()-29*86400000)}
  $('#pane').innerHTML='<section><h2>对账</h2><p class="mut">加载中…</p></section>';
  api('usage-summary?from='+S.billFrom+'&to='+S.billTo).then(function(d){
    S.bill=d;paneBill()})
}
function paneBill(){
  var d=S.bill;
  if(!d){$('#pane').innerHTML='<section><h2>对账</h2><p class="mut">加载中…</p></section>';return}
  if(!d.ok){$('#pane').innerHTML='<section><h2>对账</h2><div class="msg err" style="display:block">'+esc(d.err||'加载失败')+'</div></section>';return}
  // 单价索引：同一个对外模型名挂了不同价的多家时要看得出来（那正是账会静默偏的形状）
  var byModelPrice={};(d.prices||[]).forEach(function(p){
    (byModelPrice[p.model]=byModelPrice[p.model]||[]).push(p)});
  var tbl=function(head,rows){return '<table><thead><tr>'+head.map(function(h){return '<th>'+h+'</th>'}).join('')+
    '</tr></thead><tbody>'+(rows||'<tr><td colspan="'+head.length+'" class="mut">这段时间没有用量</td></tr>')+'</tbody></table>'};
  var tot=(d.byModel||[]).reduce(function(a,b){return a+(b.cost||0)},0);
  var calls=(d.byModel||[]).reduce(function(a,b){return a+(b.calls||0)},0);

  var mrows=(d.byModel||[]).map(function(r){
    var ps=byModelPrice[r.model]||[];
    var mixed=ps.length>1&&ps.some(function(p){return p.priceIn!==ps[0].priceIn||p.priceOut!==ps[0].priceOut});
    return '<tr><td><b>'+esc(r.model||'(空)')+'</b>'+
      (mixed?' <span class="tag warn" title="同一模型名下各家单价不同：流量切到别家时账会跟着变，核对时注意">多家异价</span>':'')+
      (ps.length?'<div class="mut" style="font-size:12.5px">现价 入 '+ps[0].priceIn+' / 出 '+ps[0].priceOut+'</div>':'')+'</td>'+
      '<td>'+r.calls+'</td><td>'+money(r.cost)+'</td>'+
      '<td class="mut" style="font-size:12.5px">'+r.tin+' / '+r.tout+(r.tcached?'（缓存 '+r.tcached+'）':'')+'</td></tr>'}).join('');
  var prows=(d.byProvider||[]).map(function(r){
    return '<tr><td><b>'+esc(r.provider||'env 兜底上游')+'</b></td><td>'+r.calls+'</td><td>'+money(r.cost)+'</td>'+
      '<td class="mut" style="font-size:12.5px">'+r.tin+' / '+r.tout+'</td></tr>'}).join('');
  var urows=(d.byUser||[]).map(function(r){
    return '<tr><td><b>'+esc(r.display_name||'')+'</b> <span class="mut">'+esc(r.username||'(已删除)')+'</span></td>'+
      '<td><span class="tag">'+esc(r.tier||'—')+'</span></td><td>'+r.calls+'</td><td>'+money(r.cost)+'</td></tr>'}).join('');
  var krows=(d.bySkill||[]).map(function(r){
    return '<tr><td>'+esc(r.skill||'（自由对话）')+'</td><td>'+r.calls+'</td><td>'+money(r.cost)+'</td></tr>'}).join('');

  var q='from='+d.from+'&to='+d.to;
  $('#pane').innerHTML='<section><div class="row"><h2 style="margin:0">对账</h2>'+
    '<span class="sp"></span><input id="b-f" type="date" value="'+esc(d.from)+'">'+
    '<span class="mut">至</span><input id="b-t" type="date" value="'+esc(d.to)+'">'+
    '<button class="btn" id="b-go">查询</button></div>'+
    '<div class="kpi" style="margin:14px 0">'+
    '<div><span class="mut">区间花费</span><b>'+money(tot)+'</b></div>'+
    '<div><span class="mut">调用数</span><b>'+calls+'</b></div>'+
    '<div><span class="mut">天数</span><b>'+((new Date(d.to)-new Date(d.from))/86400000+1)+'</b></div></div>'+
    '<div class="row"><span class="mut">导出 CSV：</span>'+
    ['detail 明细','model 按模型','provider 按供应商','user 按用户'].map(function(x){
      var k=x.split(' ')[0];
      return '<a class="btn sm" style="text-decoration:none" href="/admin/api/usage-export?'+q+'&by='+k+'">'+x.split(' ')[1]+'</a>'}).join('')+
    '</div><div class="hint" style="margin-top:8px">CSV 带 BOM，Excel 直接打开不乱码。日期口径是 UTC 日切，与额度闸一致。</div></section>'+
    '<section><h2>按模型</h2>'+tbl(['模型','调用数','花费','tokens 入/出'],mrows)+
    '<div class="hint" style="margin-top:10px">核对方法：花费 ÷ tokens 应当等于该模型的现价。对不上就是某段时间用的是别家的价 —— 到「按供应商」看流量去了谁那儿。</div></section>'+
    '<section><h2>按供应商</h2>'+tbl(['供应商','调用数','花费','tokens 入/出'],prows)+'</section>'+
    '<section><h2>按用户</h2>'+tbl(['用户','档位','调用数','花费'],urows)+'</section>'+
    '<section><h2>按技能</h2>'+tbl(['技能','调用数','花费'],krows)+'</section>';
  $('#b-go').onclick=function(){S.billFrom=$('#b-f').value||S.billFrom;S.billTo=$('#b-t').value||S.billTo;loadBill()};
}

// ---------- 档位 ----------
function paneTiers(){
  var live={};S.catalog.forEach(function(m){live[m.model]=1});
  var rows=S.tiers.map(function(t){
    // 【人数取服务端 GROUP BY 的结果】以前是数"当前这页的用户"，一旦有搜索词或翻了页，
    // 每档显示的人数就是错的，而管理员正据此判断"这个档还有没有人、能不能删"。
    var n=(S.tierCounts||{})[t.key]||0;
    // 允许清单里可能有【目录里已经没有、或供应商停用了】的名字：运行时会被过滤掉，
    // 用户根本选不到，但后台直出库里的字符串就显得它还有效 —— 标红才分辨得出来。
    var ms=String(t.models||'').split(',').filter(Boolean);
    var msHtml=ms.length?ms.map(function(m){
      return live[m]?esc(m):'<span class="tag bad" title="目录里没有它、或它的供应商已停用——用户实际选不到">'+esc(m)+'</span>'}).join('、'):'';
    return '<tr data-k="'+esc(t.key)+'"><td><b>'+esc(t.key)+'</b><div class="mut" style="font-size:12.5px">'+esc(t.note||'')+'</div></td>'+
      '<td>'+(t.daily_usd?money(t.daily_usd)+creditNote(t.daily_usd):'不限')+'</td>'+
      '<td>'+(t.monthly_usd?money(t.monthly_usd)+creditNote(t.monthly_usd):'不限')+'</td>'+
      '<td>'+(t.model?esc(t.model):'<span class="tag bad" title="默认模型为空：该档用户可自选任意模型名，绕过允许清单">未设默认模型</span>')+
        (msHtml?'<div class="mut" style="font-size:12.5px">可选：'+msHtml+'</div>':'<div class="mut" style="font-size:12.5px">不可切换</div>')+'</td>'+
      '<td class="mut" style="font-size:12.5px">'+(t.skills?esc(t.skills):'全部技能')+'</td>'+
      '<td>'+(t.max_conc?t.max_conc+' 路':'<span class="mut">跟随全局</span>')+'</td>'+
      '<td class="mut" style="font-size:12.5px">'+({off:'不开放',preset:'仅模板',full:'自由'}[t.tasks_mode||'off'])+
        (t.tasks_model?'<div>'+esc(t.tasks_model)+'</div>':'')+'</td>'+
      '<td>'+n+' 人</td><td><button class="btn sm" data-a="ed">编辑</button> '+
      '<button class="btn sm danger" data-a="rm">删除</button></td></tr>'}).join('');
  $('#pane').innerHTML='<section><div class="row"><h2 style="margin:0">档位</h2><span class="sp"></span>'+
    '<button class="btn primary" id="t-add">+ 新增档位</button></div>'+
    '<div class="hint" style="margin:8px 0 12px">改动档位会立刻吊销该档位下所有用户的 key，他们需重新登录后按新权限生效。</div>'+
    '<table><thead><tr><th>档位</th><th>日额度</th><th>月额度</th><th>模型</th><th>技能</th><th>并发</th><th>定时任务</th><th>用户</th><th></th></tr></thead>'+
    '<tbody>'+rows+'</tbody></table></section>';
  $('#t-add').onclick=function(){dlgTier(null)};
  Array.prototype.forEach.call(document.querySelectorAll('#pane tbody button'),function(b){
    b.onclick=function(){
      var k=b.closest('tr').dataset.k;
      var t=S.tiers.filter(function(x){return x.key===k})[0];
      if(b.dataset.a==='ed')return dlgTier(t);
      post('tier',{key:k,remove:true}).then(function(j){
        toast(j.ok?'已删除档位 '+k:(j.err||'删除失败'),j.ok);if(j.ok)load()})}});
}
// 模型多选 chips：给档位挑「允许用户切换的模型」。数据来自模型目录（S.catalog）。
function modelChips(selected){
  var sel=selected||[];
  var known={};S.catalog.forEach(function(m){known[m.model]=1});
  // 【已选但目录里渲染不出来的也要画】保存时只收集渲染出来的 chip，所以停用一家供应商后
  // 再进来改个备注保存，那家的模型就被静默从允许清单里抹掉了，重新启用也回不来。
  var extra=sel.filter(function(x){return !known[x]}).map(function(x){return {model:x,label:x,stale:1}});
  var list=S.catalog.concat(extra);
  if(!list.length)return '<div class="hint">模型目录还是空的——先到「模型供应商」页加一家供应商与它的模型，这里才有得选。</div>';
  return '<div class="chips">'+list.map(function(m){
    return '<span class="chip'+(sel.indexOf(m.model)>=0?' on':'')+'" data-m="'+esc(m.model)+'" title="'+
      (m.stale?'目录里已经没有它、或它的供应商已停用——保留原样，取消勾选才会真的移除':esc(m.providerName||''))+'">'+
      esc(m.label||m.model)+(m.stale?' <span class="tag bad">已失效</span>':
        (m.providerName?' <span class="mut">·'+esc(m.providerName)+'</span>':''))+'</span>'}).join('')+'</div>'}

function dlgTier(t){
  t=t||{key:'',daily_usd:0,monthly_usd:0,model:'',models:'',skills:'',note:'',sort:5,tasks_mode:'off',tasks_model:''};
  // 默认模型给一个下拉（目录里的）+ 一个手填框：目录外的模型名（如只由 env 上游提供的那个）
  // 必须还能填，否则升级上来的老档位一进这个框就被清空。
  var catOpts='<option value="">（手填）</option>'+S.catalog.map(function(m){
    return '<option value="'+esc(m.model)+'"'+(m.model===t.model?' selected':'')+'>'+esc(m.label||m.model)+
      (m.providerName?' · '+esc(m.providerName):'')+'</option>'}).join('');
  dlg(t.key?('编辑档位 · '+t.key):'新增档位',
    '<div class="grid">'+
    '<label>档位键 *</label><input id="t-k" value="'+esc(t.key)+'"'+(t.key?' readonly':'')+' placeholder="小写字母开头，如 gold">'+
    // 额度按美元填（与计量、对账同一口径），旁边实时显示客户端会看到的积分数——
    // 边填边看，省得保存完再去客户端核对一遍。
    '<label>日额度 USD</label><input id="t-d" value="'+t.daily_usd+'" placeholder="0 = 不限">'+
    '<label></label><div class="hint" id="t-dc"></div>'+
    '<label>月额度 USD</label><input id="t-m" value="'+t.monthly_usd+'" placeholder="0 = 不限">'+
    '<label></label><div class="hint" id="t-mc"></div>'+
    '<label>单用户并发</label><input id="t-c" value="'+(t.max_conc||0)+'" placeholder="0 = 跟随全局设置">'+
    '<label>默认模型</label><select id="t-mosel">'+catOpts+'</select>'+
    '<label></label><input id="t-mo" value="'+esc(t.model)+'" placeholder="模型名（上面选一个会自动填到这里）">'+
    '<label>说明</label><input id="t-n" value="'+esc(t.note)+'">'+
    '<label>排序</label><input id="t-s" value="'+t.sort+'">'+
    // 定时任务：客户端到点自动跑一轮（用户不在场时花钱），所以放开到什么程度按档决定。
    '<label>定时任务</label><select id="t-tm">'+
      ['off','preset','full'].map(function(m){
        var label={off:'不开放（客户端不显示）',preset:'只能用模板（用户只填参数）',full:'自由指令'}[m]
        return '<option value="'+m+'"'+((t.tasks_mode||'off')===m?' selected':'')+'>'+label+'</option>'}).join('')+
    '</select>'+
    '<label>任务用模型</label><select id="t-tmo">'+
      '<option value="">（用该档默认模型）</option>'+
      S.catalog.map(function(m){return '<option value="'+esc(m.model)+'"'+(m.model===t.tasks_model?' selected':'')+'>'+
        esc(m.label||m.model)+'</option>'}).join('')+
    '</select>'+
    '<label></label><div class="hint">定时任务【强制】用这个模型，用户改不了。它不会出现在用户的模型下拉里，'+
      '只对定时任务生效——所以给 preset 档钉一个便宜模型是安全的。</div></div>'+
    '<div style="margin-top:14px"><label class="mut">允许用户切换的模型</label>'+
    '<div class="hint">默认模型<b>永远可用</b>，不用在这里重复勾。全不选 = 该档位<b>不能换模型</b>（升级上来的老档位就是这个状态）。'+
    '客户端只能在这份清单里选，点了清单外的模型会被网关静默打回默认模型。</div>'+
    modelChips(String(t.models||'').split(',').filter(Boolean))+'</div>'+
    '<div style="margin-top:14px"><label class="mut">可用技能（全不选 = 全部）</label>'+
    skillChips(String(t.skills||'').split(',').filter(Boolean),S.skills)+'</div>',
    '<button class="btn primary" id="ok" value="default">保存</button>');
  var mchips=$('#dlg-b').querySelectorAll('.chip[data-m]');
  var schips=$('#dlg-b').querySelectorAll('.chip[data-s]');
  Array.prototype.forEach.call(mchips,function(c){c.onclick=function(){c.classList.toggle('on')}});
  Array.prototype.forEach.call(schips,function(c){c.onclick=function(){c.classList.toggle('on')}});
  $('#t-mosel').onchange=function(){if(this.value)$('#t-mo').value=this.value};
  // 积分预览：非法输入不猜，直说"填个 ≥0 的数字"，别显示成 0 积分（0 在额度闸里是【不限】）
  var showCr=function(inp,box){var v=Number($(inp).value);
    $(box).innerHTML=(!$(inp).value.trim()||!isFinite(v)||v<0)?'请填 ≥0 的数字（0 = 不限）'
      :(v>0?'用户看到：<b>'+credits(v)+' 积分</b>（1 积分 = '+money(CREDIT())+'）':'不限额，用户看到「不限」')};
  ['#t-d','#t-m'].forEach(function(id,i){var box=i?'#t-mc':'#t-dc';
    $(id).oninput=function(){showCr(id,box)};showCr(id,box)});
  $('#ok').onclick=function(e){e.preventDefault();
    // 【别再用 Number(x)||0】负数与「abc」都会被它吞成 0，而 0 在额度闸里是【不限】——
    // 一次手滑就把整档放开，后台还显示得一切正常。
    var d=numIn('#t-d',0),m=numIn('#t-m',0),c=numIn('#t-c',0);
    if(d===null||m===null)return toast('额度须是 ≥0 的数字（0 = 不限）',false);
    if(c===null||Math.floor(c)!==c)return toast('单用户并发须是 ≥0 的整数（0 = 跟随全局）',false);
    if(!$('#t-mo').value.trim())return toast('请填默认模型——留空会让该档用户可以自选任意模型名，绕过允许清单',false);
    var picked=[];Array.prototype.forEach.call(schips,function(c){if(c.classList.contains('on'))picked.push(c.dataset.s)});
    var mpicked=[];Array.prototype.forEach.call(mchips,function(c){if(c.classList.contains('on'))mpicked.push(c.dataset.m)});
    post('tier',{key:$('#t-k').value.trim(),dailyUSD:d,
      monthlyUSD:m,model:$('#t-mo').value.trim(),models:mpicked.join(','),
      skills:picked.join(','),note:$('#t-n').value.trim(),sort:Number($('#t-s').value)||0,
      maxConc:c,tasksMode:$('#t-tm').value,tasksModel:$('#t-tmo').value}).then(function(j){
      if(!j.ok)return toast(j.err||'保存失败',false);
      $('#dlg').close();toast('已保存'+(j.affected?'（已吊销 '+j.affected+' 个用户的 key）':''),true);load()})}
}

// ---------- 模型供应商 ----------
function loadProviders(){
  render();
  $('#pane').innerHTML='<section><h2>模型供应商</h2><p class="mut">加载中…</p></section>';
  api('providers').then(function(d){
    if(!d.ok){if(!d.unauth)$('#pane').innerHTML='<section><div class="msg err" style="display:block">'+esc(d.err||'加载失败')+'</div></section>';return}
    S.prov=d;
    // 【顺手把档位对话框用的模型清单也刷了】它原本只在 overview 那一次取，而"加模型"恰恰
    // 发生在这一页：不同步的话，刚接入的模型在档位对话框里一个都看不到，得刷新整页才出现，
    // 而"加完模型去档位勾一下"正是紧接着的下一步动作。
    var seen={},cat=[];
    (d.models||[]).forEach(function(m){
      if(m.status!=='active'||m.providerStatus!=='active'||seen[m.model])return;
      seen[m.model]=1;cat.push({model:m.model,label:m.label||m.model,providerName:m.providerName||m.provider})});
    S.catalog=cat;
    paneProviders()})
    .catch(function(){$('#pane').innerHTML='<section><p class="mut">加载失败</p></section>'})
}
function paneProviders(){
  var d=S.prov;
  // 与「上游通道」页同一条铁律：没数据只画占位，取数单向由 loadProviders 驱动，
  // 否则 render() ↔ paneProviders() 会互相回调成死循环。
  if(!d){$('#pane').innerHTML='<section><h2>模型供应商</h2><p class="mut">加载中…</p></section>';return}
  var provs=d.providers||[],models=d.models||[],lg=d.legacy||{};
  // 供应侧（预算 / 摘除状态）与供应商清单同一口请求下发，按 key 索引好备用
  var sup={};(d.supply||[]).forEach(function(s){sup[s.provider]=s});
  S.windows=d.windows||[];

  // 一家的额度与健康画成一格。【为什么两者画在一起】运维看这张表只想回答一个问题：
  // "这家现在还能不能出活"。预算见底和刚撞过 402 是同一个答案的两种原因，分开两列反而要来回对。
  function supCell(k){
    var s=sup[k];if(!s)return '<span class="mut">—</span>';
    var out=[];
    var h=s.health||{};
    if(h.cooling)out.push('<div><span class="tag bad">已摘除</span> <span class="mut" style="font-size:12.5px">'+
      esc(h.reason||h.state||'')+'，约 '+Math.ceil((h.remainMs||0)/60000)+' 分钟后自动重试</span></div>');
    (s.budgets||[]).forEach(function(b){
      var cls=b.exhausted?'bad':(b.pct>=85?'warn':'ok');
      out.push('<div style="font-size:12.5px"><span class="tag '+cls+'">'+esc(b.label)+'</span> '+
        '$'+b.spentUsd.toFixed(2)+' / $'+b.limitUsd.toFixed(2)+
        '<span class="mut"> · 剩 $'+b.remainUsd.toFixed(2)+'（'+b.pct+'%）</span></div>')});
    if(!out.length)return '<span class="mut" style="font-size:12.5px">未设额度</span>';
    return out.join('')}

  // 这家名下所有模型行的优先级（决定出流量给谁的就是它，不是供应商那个「列表排序」）。
  // 各行不一致时把值都列出来 —— 逐行改优先级最常见的事故就是改漏一两行，主备只换了一半。
  function prioOf(k){
    var ss=models.filter(function(m){return m.provider===k}).map(function(m){return m.sort});
    if(!ss.length)return null;
    var uniq=ss.filter(function(v,i){return ss.indexOf(v)===i}).sort(function(a,b){return a-b});
    return {vals:uniq,mixed:uniq.length>1}}

  var prows=provs.map(function(p){
    var s=sup[p.key]||{},cooling=(s.health||{}).cooling,pr=prioOf(p.key);
    return '<tr data-k="'+esc(p.key)+'">'+
      '<td><b>'+esc(p.name||p.key)+'</b><div class="mut" style="font-size:12.5px">'+esc(p.key)+
        (p.note?' · '+esc(p.note):'')+'</div></td>'+
      '<td class="mut" style="font-size:12.5px">'+esc(p.baseUrl)+'</td>'+
      '<td>'+(p.status==='active'?'<span class="tag ok">启用</span>':'<span class="tag bad">已停用</span>')+
        (p.hasKey?'':' <span class="tag warn">缺 Key</span>')+'</td>'+
      '<td>'+p.models+' 个'+(pr?'<div class="mut" style="font-size:12.5px">优先级 '+pr.vals.join(' / ')+
        (pr.mixed?' <span class="tag warn">各行不一致</span>':'')+'</div>':'')+'</td>'+
      '<td>'+supCell(p.key)+'</td>'+
      '<td class="row" style="gap:5px;flex-wrap:nowrap">'+
        '<button class="btn sm" data-a="ed">编辑</button>'+
        '<button class="btn sm" data-a="prio" title="一次改掉这家名下所有模型的优先级（主备就是靠它定的）">优先级</button>'+
        '<button class="btn sm" data-a="budget">额度</button>'+
        (cooling?'<button class="btn sm" data-a="clear" title="充完值不想等冷却到期就点它">解除</button>':'')+
        '<button class="btn sm" data-a="add-models">+ 模型</button>'+
        '<button class="btn sm" data-a="toggle">'+(p.status==='active'?'停用':'启用')+'</button>'+
        '<button class="btn sm danger" data-a="rm">删除</button></td></tr>'}).join('');

  var mrows=models.map(function(m){
    var dead=m.providerStatus!=='active';
    return '<tr data-id="'+m.id+'">'+
      '<td><b>'+esc(m.model)+'</b>'+(m.label&&m.label!==m.model?'<div class="mut" style="font-size:12.5px">'+esc(m.label)+'</div>':'')+'</td>'+
      '<td>'+esc(m.providerName||m.provider)+(dead?' <span class="tag bad">供应商已停用</span>':'')+
        (m.upstream?'<div class="mut" style="font-size:12.5px">上游名：'+esc(m.upstream)+'</div>':'')+'</td>'+
      '<td class="mut" style="font-size:12.5px">入 '+m.priceIn+' / 出 '+m.priceOut+' / 缓存 '+m.priceCached+'</td>'+
      '<td>'+(m.status==='active'?'<span class="tag ok">启用</span>':'<span class="tag bad">已停用</span>')+
        ' <span class="mut" style="font-size:12.5px">优先级 '+m.sort+'</span></td>'+
      '<td class="mut" style="font-size:12.5px">'+(m.tiers.length?m.tiers.map(esc).join('、'):'没有档位在用')+'</td>'+
      '<td class="row" style="gap:5px;flex-wrap:nowrap">'+
        '<button class="btn sm" data-a="ed">编辑</button>'+
        '<button class="btn sm" data-a="test">测试</button>'+
        '<button class="btn sm danger" data-a="rm">删除</button></td></tr>'}).join('');

  $('#pane').innerHTML=
    '<section><div class="row"><h2 style="margin:0">供应商</h2><span class="sp"></span>'+
      '<button class="btn primary" id="p-add">+ 新增供应商</button></div>'+
    '<div class="hint" style="margin:8px 0 12px">任何 <b>OpenAI 兼容</b>端点都能加（DeepSeek、硅基流动、自建 one-api……）。'+
    'API Key 只存在服务器库里、转发时才贴，<b>绝不下发到客户端</b>；后台也只显示"有没有"，不回显。<br>'+
    '「额度」填的是<b>这家账户有多少钱</b>（不是用户额度）。填了之后：用到 85% 会在日志与审计里告警，'+
    '<b>用尽就不再往这家派单</b>，流量自动走同一模型名下的下一家。撞上 402/401/429 也会自动摘除一段时间，'+
    '到点半开重试——充完值不用手动点，但等不及可以点「解除」。</div>'+
    '<table><thead><tr><th>名称</th><th>地址</th><th>状态</th><th>模型</th><th>额度 / 供应侧状态</th><th></th></tr></thead><tbody>'+
    (prows||'<tr><td colspan="6" class="mut" style="padding:18px">还没有供应商——所有流量都走下面那条 env 兜底上游。</td></tr>')+
    '</tbody></table></section>'+

    '<section><div class="row"><h2 style="margin:0">模型目录</h2><span class="sp"></span>'+
      '<button class="btn primary" id="m-add">+ 新增模型</button></div>'+
    '<div class="hint" style="margin:8px 0 12px">一行 = 「某个对外模型名由某家提供」。'+
    '<b>同一个对外模型名可以有多行（多家）：优先级数字小的先用，它伺候不了时自动落到下一家</b>——这就是故障切换。'+
    '「伺候不了」= 连不上、5xx，以及 401/402/403/408/429（密钥失效、<b>余额不足</b>、超时、限流）；'+
    '400/404 这类请求本身的问题不切家，原样透传给客户端诊断。'+
    '单价<b>按行独立</b>，换家不会再让账静默偏。<br>'+
    '加完模型别忘了到「档位」页把它勾进对应档位的<b>允许清单</b>，客户端才选得到。</div>'+
    '<table><thead><tr><th>对外模型名</th><th>供应商</th><th>单价 USD/百万 token</th><th>状态</th><th>哪些档位在用</th><th></th></tr></thead><tbody>'+
    (mrows||'<tr><td colspan="6" class="mut" style="padding:18px">还没有模型</td></tr>')+
    '</tbody></table></section>'+

    '<section><h2>兜底上游 <span class="mut">来自 /etc/sci-auth.env</span></h2>'+
    '<div class="hint">模型目录里查不到的模型名，仍走这条老路：<code>'+esc(lg.url||'(未配)')+'</code>'+
    (lg.hasKey?' <span class="tag ok">已配 Key</span>':' <span class="tag bad">未配 Key</span>')+
    '，单价 入 '+lg.priceIn+' / 出 '+lg.priceOut+' / 缓存 '+lg.priceCached+'。<br>'+
    '这条路留着是为了让老部署一字不改也照常跑。要把它也纳入统一管理，就在上面把它加成一家供应商。</div></section>';

  $('#p-add').onclick=function(){dlgProvider(null)};
  $('#m-add').onclick=function(){dlgModel(null)};
  Array.prototype.forEach.call(document.querySelectorAll('#pane tbody button'),function(b){
    b.onclick=function(){
      var tr=b.closest('tr'),a=b.dataset.a;
      if(tr.dataset.k!==undefined&&tr.dataset.k!==''){
        var p=provs.filter(function(x){return x.key===tr.dataset.k})[0];
        if(a==='ed')return dlgProvider(p);
        if(a==='prio')return dlgPriority(p,models.filter(function(m){return m.provider===p.key}));
        if(a==='budget')return dlgBudget(p,sup[p.key]);
        if(a==='clear')return post('supply',{provider:p.key,action:'clear'}).then(function(j){
          toast(j.ok?'已解除摘除标记，下一单就会试这家':(j.err||'失败'),j.ok);loadProviders()});
        if(a==='add-models')return dlgFetchModels(p);
        if(a==='toggle')return post('provider',{key:p.key,name:p.name,baseURL:p.baseUrl,
          status:p.status==='active'?'disabled':'active',note:p.note,sort:p.sort}).then(function(j){
          toast(j.ok?'已'+(p.status==='active'?'停用':'启用')+' '+(p.name||p.key):(j.err||'失败'),j.ok);loadProviders()});
        if(a==='rm'){
          if(!confirm('删除供应商「'+(p.name||p.key)+'」？\\n\\n它名下的 '+p.models+' 个模型条目会一并删除，\\n'+
            '各档位的允许清单里也会把这些模型名摘掉（否则以后有人重建同名模型，授权会自动复活）。\\n'+
            '正在用这些模型的用户会退回各自档位的默认模型。'))return;
          return post('provider',{key:p.key,remove:true}).then(function(j){
            var dp=Object.keys(j.droppedFromTiers||{});
            toast(j.ok?('已删除（连带 '+j.removedModels+' 个模型'+(dp.length?'；已从档位 '+dp.join('、')+' 的清单里摘掉':'')+'）'):(j.err||'失败'),j.ok);
            loadProviders()})}
        return}
      var m=models.filter(function(x){return x.id===Number(tr.dataset.id)})[0];
      if(a==='ed')return dlgModel(m);
      if(a==='test'){
        b.disabled=true;
        return post('provider',{key:m.provider,action:'test',model:m.upstream||m.model}).then(function(j){
          b.disabled=false;
          toast(j.ok?('通了：'+j.ms+'ms'+(j.reply?'（回了「'+j.reply+'」）':'')):(j.err||'测试失败'),j.ok)})
          .catch(function(){b.disabled=false;toast('网络错误',false)})}
      if(a==='rm'){
        if(!confirm('删除模型「'+m.model+'@'+(m.providerName||m.provider)+'」？'+
          (m.tiers.length?'\\n\\n⚠ 这些档位正在用它：'+m.tiers.join('、'):'')))return;
        return post('model',{id:m.id,remove:true}).then(function(j){
          var dp=Object.keys(j.droppedFromTiers||{});
          toast(j.ok?('已删除'+(dp.length?'（已从档位 '+dp.join('、')+' 的清单里摘掉）':'')):(j.err||'失败'),j.ok);
          loadProviders()})}}});
}

function dlgProvider(p){
  var isNew=!p;
  p=p||{key:'',name:'',baseUrl:'',status:'active',note:'',sort:0,hasKey:false};
  dlg(isNew?'新增供应商':('编辑供应商 · '+(p.name||p.key)),
    '<div class="grid">'+
    '<label>供应商键 *</label><input id="p-k" value="'+esc(p.key)+'"'+(isNew?'':' readonly')+' placeholder="小写字母开头，如 siliconflow">'+
    '<label>显示名</label><input id="p-n" value="'+esc(p.name)+'" placeholder="硅基流动">'+
    // 这里【不能写整条示例 URL】：后台页面有一条"不许出现外部 URL"的自包含闸（离线/CSP 运维
    // 指望它），连 placeholder 与注释里的协议头都会把它踩响。所以示例只写域名部分。
    '<label>API 地址 *</label><input id="p-u" value="'+esc(p.baseUrl)+'" placeholder="带 http(s) 前缀，例 api.siliconflow.cn/v1">'+
    '<label>API Key '+(isNew?'*':'')+'</label><input id="p-key" type="password" autocomplete="off" placeholder="'+
      (p.hasKey?'已配置（留空 = 不改）':'sk-...')+'">'+
    '<label>状态</label><select id="p-st"><option value="active"'+(p.status==='active'?' selected':'')+'>启用</option>'+
      '<option value="disabled"'+(p.status!=='active'?' selected':'')+'>停用</option></select>'+
    // 【别再叫"排序"】它只排后台这张表的显示顺序。叫"排序/优先度"会被读成"主备顺序"，
    // 于是管理员改完它以为流量换家了，实际路由（models.sort）一动没动。名字与下面那句提示
    // 都是为这个踩过的坑留的，别改回去。
    '<label>列表排序</label><input id="p-s" value="'+p.sort+'">'+
    '<label>备注</label><input id="p-note" value="'+esc(p.note)+'"></div>'+
    '<div class="hint" style="margin-top:12px">地址填到 <code>/v1</code>（没写会自动补）。存好后用「+ 模型」从这家拉模型列表勾选接入。<br>'+
    '「列表排序」<b>只管这家在上面表格里显示的先后，不决定出流量给谁</b>——主备顺序看每个模型行的'+
    '<b>优先级</b>，要整家一起调就用列表里那个「优先级」按钮。</div>'+
    '<div class="msg" id="p-msg" style="position:static;max-width:none;margin-top:10px"></div>',
    '<button class="btn" id="p-test" value="">测试连通</button><button class="btn primary" id="ok" value="default">保存</button>');
  // 【display 要显式打开】.msg 默认 display:none，只有 .ok/.err 两个修饰类才显示；
  // "正在连…"这种中间态没有修饰类，不强开就永远看不见（点了测试像没反应）。
  var pmsg=function(cls,t){var e=$('#p-msg');e.className='msg '+cls;e.style.display='block';e.textContent=t};
  var body=function(){return {key:$('#p-k').value.trim(),name:$('#p-n').value.trim(),baseURL:$('#p-u').value.trim(),
    apiKey:$('#p-key').value,status:$('#p-st').value,sort:Number($('#p-s').value)||0,note:$('#p-note').value.trim()}};
  $('#p-test').onclick=function(e){e.preventDefault();
    var b=body();b.action='probe';pmsg('','正在连…');
    post('provider',b).then(function(j){
      if(!j.ok)return pmsg('err',j.err||'连不上');
      pmsg('ok','通了，这家有 '+j.models.length+' 个模型：'+j.models.slice(0,6).join('、')+(j.models.length>6?' …':''))})};
  $('#ok').onclick=function(e){e.preventDefault();
    post('provider',body()).then(function(j){
      if(!j.ok)return pmsg('err',j.err||'保存失败');
      $('#dlg').close();toast('已保存供应商',true);loadProviders()})}
}

/**
 * 整家批改模型优先级。
 *
 * 【为什么单开一个入口】决定出流量给谁的是【每个模型行】的优先级（models.sort），而供应商
 * 编辑框里那个是「列表排序」，只排显示顺序。要把一家整体降成备用，本来得把它名下十几个模型
 * 逐行点开改一遍 —— 烦，且改漏一行就是主备只换了一半，而这种半吊子状态在界面上看不出来
 * （所以列表那格会把不一致的优先级都列出来并标红）。
 */
function dlgPriority(p,ms){
  var cur=ms.map(function(m){return m.sort}),
      uniq=cur.filter(function(v,i){return cur.indexOf(v)===i}),
      def=uniq.length===1?uniq[0]:'';
  dlg('优先级 · '+(p.name||p.key),
    '<div class="grid"><label>优先级</label>'+
    '<input id="pr-s" value="'+def+'" placeholder="0-999，数字小的先用；这家名下 '+ms.length+' 个模型全设成它">'+
    '</div>'+
    '<div class="hint" style="margin-top:12px"><b>同一个对外模型名下，优先级数字小的那家先出流量</b>，'+
    '它伺候不了（连不上 / 5xx / 401 / 402 / 429…）时自动落到下一家。所以：主力填 <code>0</code>，'+
    '备用填 <code>1</code>。<br>供应商编辑框里的「列表排序」跟这个<b>没有关系</b>，那个只排后台表格的显示顺序。</div>'+
    (ms.length?'<table style="margin-top:12px"><thead><tr><th>模型</th><th>当前优先级</th></tr></thead><tbody>'+
      ms.map(function(m){return '<tr><td>'+esc(m.model)+'</td><td>'+m.sort+'</td></tr>'}).join('')+
      '</tbody></table>':'<div class="hint" style="margin-top:12px">这家名下还没有模型条目。</div>')+
    '<div class="msg" id="pr-msg" style="position:static;max-width:none;margin-top:10px"></div>',
    '<button class="btn primary" id="ok" value="default">保存</button>');
  var prmsg=function(cls,t){var e=$('#pr-msg');e.className='msg '+cls;e.style.display='block';e.textContent=t};
  $('#ok').onclick=function(e){e.preventDefault();
    if(!ms.length){$('#dlg').close();return}
    var v=$('#pr-s').value.trim(),n=Number(v);
    if(v===''||!Number.isInteger(n)||n<0||n>999)return prmsg('err','填 0-999 的整数（数字小的先用）');
    post('provider',{key:p.key,action:'priority',sort:n}).then(function(j){
      if(!j.ok)return prmsg('err',j.err||'保存失败');
      $('#dlg').close();toast('已把 '+(p.name||p.key)+' 名下 '+j.updated+' 个模型的优先级设为 '+n,true);loadProviders()})}
}

/**
 * 某家的额度线。一家可以同时挂几条（如包月套餐既有"每 5 小时"又有"每月"上限），
 * 任意一条用尽就不再往这家派单。
 *
 * 【全部是滚动窗口】"24 小时"是往前推 24 小时，不是自然日 —— 自然日切会在跨日那一刻把额度
 * 全放开，等于给了「23:59 和 00:01 各花一整天预算」的口子。累计窗口则从充值时刻起算、不重置。
 * 【留空 = 不限】不是 0；0 会被当成"取消这条线"。
 */
function dlgBudget(p,s){
  var cur={};((s&&s.budgets)||[]).forEach(function(b){cur[b.win]=b});
  var wins=(S.windows&&S.windows.length)?S.windows:
    [{win:'h5',label:'5 小时'},{win:'day',label:'24 小时'},{win:'week',label:'7 天'},
     {win:'month',label:'30 天'},{win:'total',label:'累计'}];
  dlg('额度 · '+(p.name||p.key),
    '<div class="grid">'+wins.map(function(w){
      var b=cur[w.win];
      return '<label>'+esc(w.label)+(w.win==='total'?'<div class="mut" style="font-size:12px;font-weight:400">从充值时刻起算</div>':'')+'</label>'+
        '<div><input id="b-'+w.win+'" value="'+(b?b.limitUsd:'')+'" placeholder="留空 = 不限，单位美元">'+
        (b?'<div class="mut" style="font-size:12.5px;margin-top:4px">已用 $'+b.spentUsd.toFixed(2)+
          '，剩 $'+b.remainUsd.toFixed(2)+'（'+b.pct+'%）</div>':'')+'</div>'}).join('')+'</div>'+
    '<div class="hint" style="margin-top:12px">额度按<b>我们自己的单价表</b>算出来的消费额判定，与对方真实账单必有偏差'+
    '（缓存计价、最小计费单位…）。它是<b>闸不是账本</b>——写宽一点没关系，写到分毫反而会误伤。<br>'+
    '改「累计」额度时会把起算时刻重置为现在，正好对应"又充了一笔"。要对账仍看「对账」页。</div>'+
    '<div class="msg" id="b-msg" style="position:static;max-width:none;margin-top:10px"></div>',
    '<button class="btn primary" id="ok" value="default">保存</button>');
  var bmsg=function(cls,t){var e=$('#b-msg');e.className='msg '+cls;e.style.display='block';e.textContent=t};
  $('#ok').onclick=function(e){e.preventDefault();
    var rows=[],bad='';
    wins.forEach(function(w){
      var v=$('#b-'+w.win).value.trim();
      // 留空 = 这条线不设；已经设过的留空 = 取消它（发 0 过去，服务端会删行）
      if(v===''){if(cur[w.win])rows.push({win:w.win,limitUSD:0});return}
      var n=Number(v);
      if(!Number.isFinite(n)||n<0){bad=w.label;return}
      rows.push({win:w.win,limitUSD:n,anchor:w.win==='total'?Date.now():0})});
    if(bad)return bmsg('err','「'+bad+'」要填 ≥0 的数字（美元），留空表示不限');
    if(!rows.length){$('#dlg').close();return}
    post('supply',{provider:p.key,action:'budget',budgets:rows}).then(function(j){
      if(!j.ok)return bmsg('err',j.err||'保存失败');
      $('#dlg').close();toast('已保存额度',true);loadProviders()})}
}

// 从某家拉模型列表 → 勾选 → 批量落库（这一步才让"加了供应商"变成"用户能选到的模型"）
function dlgFetchModels(p){
  dlg('从「'+(p.name||p.key)+'」接入模型','<p class="mut">正在拉取模型列表…</p>');
  post('provider',{key:p.key,action:'probe',baseURL:p.baseUrl}).then(function(j){
    if(!j.ok){
      $('#dlg-b').innerHTML='<div class="msg err" style="position:static;max-width:none">'+esc(j.err||'拉取失败')+'</div>'+
        '<div class="hint" style="margin-top:10px">有些兼容端点不实现 <code>/models</code>。用「+ 新增模型」手填模型名即可，功能一样。</div>';
      return}
    // 【已接入的要标出来】列表原来全是未勾状态，看不出哪些已经在目录里了；再勾一次会把
    // 管理员手工填好的真实单价/中文名/上游真实名洗回默认值。现在标灰不可选，后端也按
    // insertOnly 落库（双保险）。
    var had={};((S.prov&&S.prov.models)||[]).forEach(function(x){if(x.provider===p.key)had[x.model]=1});
    $('#dlg-b').innerHTML='<div class="hint">勾选要接入的模型。单价先按 env 的全局价填好，'+
      '<b>各家价格不同，务必到模型目录里逐个改成这家的真实单价</b>——否则额度会算偏。<br>'+
      '标「已接入」的不会被改动（再勾也不会覆盖你填好的单价），要改它请到模型目录里编辑。</div>'+
      '<div class="row" style="margin:10px 0"><input id="mf" placeholder="过滤" style="flex:1"></div>'+
      '<div class="chips" id="mlist">'+j.models.map(function(m){
        return had[m]
          ? '<span class="chip" data-m="'+esc(m)+'" data-had="1" style="opacity:.5;cursor:not-allowed" title="已经在模型目录里了">'+
            esc(m)+' <span class="mut">·已接入</span></span>'
          : '<span class="chip" data-m="'+esc(m)+'">'+esc(m)+'</span>'}).join('')+'</div>';
    $('#dlg-f').innerHTML='<button class="btn primary" id="ok" value="default">接入所选</button>'+
      '<button class="btn" value="cancel">关闭</button>';
    var chips=$('#mlist').querySelectorAll('.chip');
    Array.prototype.forEach.call(chips,function(c){c.onclick=function(){
      if(c.dataset.had)return toast('「'+c.dataset.m+'」已经在模型目录里了，改单价请到模型目录编辑',false);
      c.classList.toggle('on')}});
    $('#mf').oninput=function(){var q=this.value.trim().toLowerCase();
      Array.prototype.forEach.call(chips,function(c){
        c.style.display=!q||c.dataset.m.toLowerCase().indexOf(q)>=0?'':'none'})};
    $('#ok').onclick=function(e){e.preventDefault();
      var items=[];Array.prototype.forEach.call(chips,function(c){
        if(c.classList.contains('on')&&!c.dataset.had)items.push({model:c.dataset.m,provider:p.key})});
      if(!items.length)return toast('先勾几个模型',false);
      post('model',{items:items,bulk:true}).then(function(j2){
        if(!j2.ok)return toast(j2.err||'保存失败',false);
        $('#dlg').close();
        toast('已接入 '+j2.saved+' 个模型'+(j2.skipped?'（'+j2.skipped+' 个早已接入、保持原样）':'')+
          '（记得到档位页勾进允许清单）',true);loadProviders()})}})
}

function dlgModel(m){
  var provs=(S.prov&&S.prov.providers)||[];
  if(!provs.length)return toast('先加一家供应商',false);
  var isNew=!m;
  var lg=(S.prov&&S.prov.legacy)||{priceIn:0,priceOut:0,priceCached:0};
  m=m||{id:0,model:'',provider:provs[0].key,upstream:'',label:'',status:'active',sort:0,note:'',
    priceIn:lg.priceIn,priceOut:lg.priceOut,priceCached:lg.priceCached};
  dlg(isNew?'新增模型':('编辑模型 · '+m.model),
    '<div class="grid">'+
    '<label>对外模型名 *</label><input id="x-m" value="'+esc(m.model)+'" placeholder="客户端看到、请求里写的名字">'+
    '<label>中文名</label><input id="x-l" value="'+esc(m.label)+'" placeholder="给用户看的名字，如 DeepSeek 深度思考">'+
    '<label>供应商 *</label><select id="x-p">'+provs.map(function(p){
      return '<option value="'+esc(p.key)+'"'+(p.key===m.provider?' selected':'')+'>'+esc(p.name||p.key)+'</option>'}).join('')+'</select>'+
    '<label>上游真实名</label><input id="x-u" value="'+esc(m.upstream)+'" placeholder="留空 = 与对外名相同">'+
    '<label>输入单价</label><input id="x-pi" value="'+m.priceIn+'">'+
    '<label>输出单价</label><input id="x-po" value="'+m.priceOut+'">'+
    '<label>缓存命中价</label><input id="x-pc" value="'+m.priceCached+'">'+
    '<label>优先级</label><input id="x-s" value="'+m.sort+'" placeholder="数字小的先用；同名多家时靠它定主备">'+
    '<label>状态</label><select id="x-st"><option value="active"'+(m.status==='active'?' selected':'')+'>启用</option>'+
      '<option value="disabled"'+(m.status!=='active'?' selected':'')+'>停用</option></select>'+
    '<label>备注</label><input id="x-n" value="'+esc(m.note)+'"></div>'+
    '<div class="hint" style="margin-top:12px">单价单位是 <b>USD / 百万 token</b>，必须与这家的真实计费口径一致，否则额度会系统性偏。<br>'+
    '想让两家互为备份：给它们建<b>同一个对外模型名</b>的两行，各填各的上游真实名与单价，用优先级定主备。</div>',
    '<button class="btn primary" id="ok" value="default">保存</button>');
  $('#ok').onclick=function(e){e.preventDefault();
    // 【单价不能用 Number(x)||0】清空输入框会变成 0 = 该模型永久免费，调用再多也不扣额度，
    // 而服务端"字段缺省则回落 env 全局价"的分支从界面上根本走不到（前端永远发 0）。
    // 留空 → 不发这个字段 → 服务端用 env 默认价；填了非法值 → 报错，别静默。
    var pi=numIn('#x-pi',undefined),po=numIn('#x-po',undefined),pc=numIn('#x-pc',undefined);
    if(pi===null||po===null||pc===null)return toast('单价须是 ≥0 的数字（留空 = 用 env 兜底价）',false);
    if(!$('#x-m').value.trim())return toast('请填对外模型名',false);
    post('model',{id:m.id||undefined,model:$('#x-m').value.trim(),provider:$('#x-p').value,
      upstream:$('#x-u').value.trim(),label:$('#x-l').value.trim(),
      priceIn:pi,priceOut:po,priceCached:pc,
      sort:Number($('#x-s').value)||0,status:$('#x-st').value,note:$('#x-n').value.trim()}).then(function(j){
      if(!j.ok)return toast(j.err||'保存失败',false);
      $('#dlg').close();toast('已保存模型',true);loadProviders()})}
}

// ---------- 上游通道 ----------
function loadChannels(){
  render();
  $('#pane').innerHTML='<section><h2>上游通道</h2><p class="mut">加载中…</p></section>';
  api('channels').then(function(d){
    if(!d.ok){if(!d.unauth)$('#pane').innerHTML='<section><div class="msg err" style="display:block">'+esc(d.err||'加载失败')+'</div></section>';return}
    S.chan=d;paneChannels()})
}
function paneChannels(){
  var d=S.chan;
  // 【这里绝不能回调 loadChannels】loadChannels 会先 render()，而 render() 在 chan 页
  // 又会调回本函数 —— 数据还没到时就形成 loadChannels → render → paneChannels → loadChannels
  // 的死循环，页面直接爆栈。没数据就只画个占位，取数由 loadChannels 单向驱动。
  if(!d){$('#pane').innerHTML='<section><h2>上游通道</h2><p class="mut">加载中…</p></section>';return}
  if(!d.enabled||d.err){
    $('#pane').innerHTML='<section><h2>上游通道</h2><div class="msg err" style="display:block">'+
      esc(d.err||'未接入 one-api')+'</div>'+
      '<div class="hint">在 <code>/etc/sci-auth.env</code> 配 <code>ONEAPI_URL</code> 与 <code>ONEAPI_TOKEN</code>'+
      '（后者是 one-api 管理台的「系统访问令牌」，不是调模型的 sk- 令牌），然后 <code>systemctl restart sci-auth</code>。</div></section>';
    return
  }
  var chans=d.channels||[],byModel=d.byModel||{},tierModels=d.tierModels||[];
  // 各档位在用的模型名 → 这些模型名才是真正要保证有通道兜底的
  var usedModels={};tierModels.forEach(function(t){if(t.model)usedModels[t.model]=(usedModels[t.model]||[]).concat(t.key)});

  var modelRows=Object.keys(byModel).sort().map(function(m){
    var list=byModel[m],act=list.filter(function(x){return x.status===1});
    var def=act[0],backups=act.slice(1);
    var tiers=usedModels[m];
    return '<tr><td><b>'+esc(m)+'</b>'+(tiers?'<div class="mut" style="font-size:12.5px">档位：'+tiers.map(esc).join('、')+'</div>':'<div class="mut" style="font-size:12.5px">没有档位在用</div>')+'</td>'+
      '<td>'+(def?'<span class="tag ok">'+esc(def.name)+'</span> <span class="mut">优先级 '+def.priority+'</span>':'<span class="tag bad">无可用通道</span>')+'</td>'+
      '<td>'+(backups.length?backups.map(function(b){return '<span class="tag">'+esc(b.name)+'（'+b.priority+'）</span>'}).join(' '):'<span class="mut">无备用</span>')+'</td></tr>'}).join('');

  var rows=chans.map(function(c){
    var on=c.status===1;
    var modelOpts=c.models.map(function(m){return '<option value="'+esc(m)+'">'+esc(m)+'</option>'}).join('');
    return '<tr data-id="'+c.id+'">'+
      '<td><b>'+esc(c.name)+'</b><div class="mut" style="font-size:12.5px">#'+c.id+(c.baseUrl?' · '+esc(c.baseUrl):'')+'</div></td>'+
      '<td>'+(on?'<span class="tag ok">启用</span>':'<span class="tag bad">'+esc(c.statusText)+'</span>')+'</td>'+
      '<td class="mut" style="font-size:12.5px">'+(c.models.length?c.models.map(esc).join('<br>'):'—')+'</td>'+
      '<td><input class="p-in" value="'+c.priority+'" style="width:64px" inputmode="numeric"></td>'+
      '<td class="row" style="gap:5px;flex-wrap:nowrap">'+
        '<button class="btn sm" data-a="save">保存优先级</button>'+
        (c.models.length?'<select class="d-mod" style="max-width:150px">'+modelOpts+'</select><button class="btn sm" data-a="def">设为默认</button>':'')+
        '<button class="btn sm" data-a="serve">兜底某模型</button>'+
        '<button class="btn sm" data-a="toggle">'+(on?'停用':'启用')+'</button>'+
        '<button class="btn sm" data-a="test">测试</button></td></tr>'}).join('');

  $('#pane').innerHTML='<section><h2>按模型看：谁是默认、谁兜底</h2>'+
    '<div class="hint" style="margin-bottom:10px">one-api 按「同一模型名下优先级最高的启用通道」出流量，调用失败会自动重试同名的其它通道。'+
    '<b>所以两个通道只有挂了同一个模型名，才互为备用。</b></div>'+
    '<table><thead><tr><th>模型名</th><th>默认通道</th><th>备用</th></tr></thead><tbody>'+
    (modelRows||'<tr><td colspan="3" class="mut">还没有通道</td></tr>')+'</tbody></table></section>'+
    '<section><h2>通道</h2>'+
    '<table><thead><tr><th>名称</th><th>状态</th><th>模型</th><th>优先级</th><th></th></tr></thead><tbody>'+
    (rows||'<tr><td colspan="5" class="mut">还没有通道</td></tr>')+'</tbody></table>'+
    '<div class="hint" style="margin-top:12px">⚠ 计量单价是<b>全局一张表</b>（当前 输入 $'+d.priceNote.input+' / 输出 $'+d.priceNote.output+
    ' / 缓存 $'+d.priceNote.cached+' 每百万 token）。若在同一模型名下挂了<b>不同价</b>的供应商，流量切过去时账会静默偏——切之前先对价。<br>'+
    '新增/删除通道、改 key 与地址请到 one-api 自己的管理台，这里只做「用哪个、谁兜底」。</div></section>';

  Array.prototype.forEach.call(document.querySelectorAll('#pane tbody button'),function(b){
    b.onclick=function(){
      var tr=b.closest('tr'),id=Number(tr.dataset.id);
      var c=chans.filter(function(x){return x.id===id})[0];
      var body={id:id};
      if(b.dataset.a==='save')body.priority=Number(tr.querySelector('.p-in').value)||0;
      else if(b.dataset.a==='toggle')body.status=c.status===1?2:1;
      else if(b.dataset.a==='def'){body.action='default';body.model=tr.querySelector('.d-mod').value}
      else if(b.dataset.a==='test')body.action='test';
      else if(b.dataset.a==='serve'){
        // 让这条通道也接管某个模型名 —— 这一步才让"主挂了走备用"真正成立
        var used=Object.keys(usedModels);
        // 注意：本文件是个大模板字符串，这里的换行必须写成 \\n —— 写 \n 会被外层模板串
        // 先展开成【真换行】，于是浏览器拿到的是一个跨行的字符串字面量，整段脚本直接语法错误
        // （这条坑真踩过一次：后台整页白屏，页面 JS 一行都没执行）。
        var m=prompt('让「'+c.name+'」兜底哪个模型名？\\n\\n'+
          (used.length?'档位在用的：'+used.join('、'):'（还没有档位配了模型名）'),used[0]||'');
        if(!m)return;
        var mp=prompt('这家供应商自己的真实模型名是？\\n\\n'+
          '留空 = 它也用同一个名字。\\n填了会写进 one-api 的模型改名规则，请求转过去时自动换名。\\n'+
          '本通道现有模型：'+(c.models.join('、')||'无'), c.models[0]||'');
        if(mp===null)return;
        if(!confirm('确认：把「'+m+'」挂到通道「'+c.name+'」上作为备用。\\n\\n'+
          '⚠ 计量单价是全局一张表，若这家与现任默认价格不同，流量切过去时账会静默偏。\\n继续吗？'))return;
        body.action='serve';body.model=m.trim();body.mapTo=mp.trim()}
      b.disabled=true;
      post('channel',body).then(function(j){
        b.disabled=false;
        if(!j.ok)return toast(j.err||'操作失败',false);
        if(b.dataset.a==='test')return toast('通道 '+c.name+' 测试通过',true);
        if(b.dataset.a==='serve')toast('已把 '+body.model+' 挂到 '+c.name+'（优先级 '+j.priority+'，作备用）',true);
        else toast(b.dataset.a==='def'?('已把 '+c.name+' 设为该模型的默认'):'已保存',true);
        loadChannels()})
        .catch(function(){b.disabled=false;toast('网络错误',false)})}});
}

// ---------- 技能包 ----------
// 管理员把 scripts/make-skill-pack.mjs 出的整套技能 zip 传上来发布；客户端（桌面版）
// 轮询到新版本后自行提示更新——不强制、可回退。服务端侧回退 = 把出问题的版本「撤下」，
// 客户端此后看到的最新版就退回上一个 active 的版本。
function fmtSize(n){n=Number(n)||0;return n>=1048576?(n/1048576).toFixed(1)+' MB':Math.round(n/1024)+' KB'}
function loadPacks(){
  render();
  $('#pane').innerHTML='<section><h2>技能包</h2><p class="mut">加载中…</p></section>';
  Promise.all([api('skill-packs'),api('skill-src')]).then(function(rs){
    var j=rs[0],src=rs[1];
    if(!j.ok){if(!j.unauth)$('#pane').innerHTML='<section><div class="msg err" style="display:block">'+esc(j.err||'加载失败')+'</div></section>';return}
    if(!src||!src.ok)src={remote:{configured:false},localRoot:'',lastPublished:null,venvLint:false};
    var rows=(j.packs||[]).map(function(p){
      var tag=p.version===j.current?'<span class="tag" style="background:var(--acc);color:#fff">当前最新</span>'
        :p.status!=='active'?'<span class="tag">已撤下</span>':'';
      return '<tr'+(p.status!=='active'?' style="opacity:.55"':'')+'>'+
        '<td><b>'+esc(p.version)+'</b> '+tag+(p.fileOk?'':' <span class="tag" style="color:var(--bad)">文件缺失</span>')+'</td>'+
        '<td class="mut" style="white-space:nowrap">'+dt(p.createdAt)+'</td>'+
        '<td>'+fmtSize(p.size)+'</td>'+
        '<td class="mut" style="font-size:12.5px;max-width:300px">'+
          (p.changedSkills.length?'变更：'+esc(p.changedSkills.join('、'))+'<br>':'')+esc(p.changelog||'')+'</td>'+
        '<td style="white-space:nowrap">'+
          (p.status==='active'
            ?'<button class="btn sm" data-act="disable" data-v="'+esc(p.version)+'">撤下</button>'
            :'<button class="btn sm" data-act="enable" data-v="'+esc(p.version)+'">恢复</button>')+
          ' <button class="btn sm danger" data-act="delete" data-v="'+esc(p.version)+'">删除</button></td></tr>'}).join('');
    var vers=(j.versions||[]).map(function(v){
      return '<span class="tag">'+esc(v.v||'（未汇报）')+' × '+v.n+'</span>'}).join(' ');
    var srcLine=src.remote.configured
      ?'远程：<code>'+esc(src.remote.url)+'</code> @ <code>'+esc(src.remote.ref)+'</code>'
      :'<b>未配置 SKILL_REPO_URL</b>（/etc/sci-auth.env）——只能从服务器本地检出发布';
    $('#pane').innerHTML='<section><h2>从仓库发布（推荐）</h2>'+
      '<div class="hint" style="margin:0 0 10px">git 仓库是唯一源头，这里只当扳机：先「检查更新」看预览（待发布的提交、变更了哪些技能），确认无误再发布。'+
      '发布后客户端收到更新提示（不强制、可回退、本地留最近 5 版）。<br>'+srcLine+
      (src.lastPublished?'　·　上次发布：<code>'+esc(src.lastPublished.version)+'</code>'+(src.lastPublished.commitSha?' @ <code>'+esc(src.lastPublished.commitSha.slice(0,10))+'</code>':''):'')+
      (src.venvLint?'':'　·　<b>依赖 lint 未启用</b>（还没有嵌过 .venv 清单的整包，先手动上传一次脚本出的整包即可启用）')+'</div>'+
      '<div class="row"><select id="sr-src" style="max-width:180px">'+
        (src.remote.configured?'<option value="remote">远程同步（git fetch）</option>':'')+
        '<option value="local">服务器本地检出</option></select>'+
      '<button class="btn primary" id="sr-check">检查更新</button></div>'+
      '<div id="sr-preview"></div></section>'+
      '<section><h2>手动上传整包（兜底）</h2>'+
      '<div class="hint" style="margin:0 0 10px">用仓库里的 <code>node scripts/make-skill-pack.mjs</code> 出包后在这里上传即发布。'+
      '整包里嵌的 .venv 依赖清单会被留存，供上面「从仓库发布」做依赖 lint。'+
      '<b>技能若引入新 pip 依赖，走不了在线更新</b>——上传时会自动检查并拦下，那种更新要重新打包客户端分发。</div>'+
      '<div class="row"><input type="file" id="pk-file" accept=".zip">'+
      '<button class="btn" id="pk-up">上传并发布</button></div>'+
      '<div id="pk-lint"></div></section>'+
      '<section><h2>已发布版本'+(j.current?'（当前最新：'+esc(j.current)+'）':'（还没发布过）')+'</h2>'+
      '<div class="hint" style="margin:0 0 10px">客户端技能版本分布：'+(vers||'<span class="mut">暂无数据（客户端升级后才会汇报）</span>')+'</div>'+
      '<table><thead><tr><th>版本</th><th>发布时间</th><th>大小</th><th>说明</th><th></th></tr></thead>'+
      '<tbody>'+(rows||'<tr><td colspan="5" class="mut">暂无版本</td></tr>')+'</tbody></table></section>';
    function upload(force){
      var f=$('#pk-file').files[0];
      if(!f)return toast('先选择技能包 zip',false);
      $('#pk-up').disabled=true;toast('上传中…（'+fmtSize(f.size)+'）',true);
      api('skill-pack-upload'+(force?'?force=1':''),{method:'POST',body:f}).then(function(r){
        $('#pk-up').disabled=false;
        if(r.ok){
          toast('已发布 '+r.version+'（'+r.skills.length+' 个技能'+(r.forced?'，强制发布':'')+'）',true);
          if((r.warnings||[]).length)$('#pk-lint').innerHTML='<div class="msg" style="display:block">'+r.warnings.map(esc).join('<br>')+'</div>';
          loadPacks();return}
        // 依赖 lint 拦下：列出可疑 import，让管理员核实后决定强制与否
        if(r.needForce){
          $('#pk-lint').innerHTML='<div class="msg err" style="display:block">'+esc(r.err)+'<br><br>'+
            (r.lint||[]).map(function(i){return esc(i.file)+' → import <b>'+esc(i.module)+'</b>'}).join('<br>')+
            '<br><br><button class="btn danger sm" id="pk-force">我已核实，强制发布</button></div>';
          $('#pk-force').onclick=function(){upload(true)};
          return}
        toast(r.err||'上传失败',false)})}
    $('#pk-up').onclick=function(){upload(false)};
    // ---- 从仓库发布：检查更新 → 预览 → 发布 ----
    function srPublish(pv,force){
      var btn=$('#sr-go');if(btn){btn.disabled=true;btn.textContent='发布中…'}
      post('skill-src',{action:'publish',source:pv.source,sha:pv.sha,
        changelog:($('#sr-log')?$('#sr-log').value.trim():''),force:!!force}).then(function(r){
        if(r.ok){toast('已发布 '+r.version+'（'+r.skills.length+' 个技能'+(r.forced?'，强制发布':'')+'）',true);loadPacks();return}
        if(r.staleSha){toast(r.err,false);srCheck();return}
        if(r.needForce){
          $('#sr-preview').insertAdjacentHTML('beforeend','<div class="msg err" style="display:block">'+esc(r.err)+'<br><br>'+
            (r.lint||[]).map(function(i){return esc(i.file)+' → import <b>'+esc(i.module)+'</b>'}).join('<br>')+
            '<br><br><button class="btn danger sm" id="sr-force">我已核实，强制发布</button></div>');
          $('#sr-force').onclick=function(){srPublish(pv,true)};
          if(btn){btn.disabled=false;btn.textContent='发布 '+pv.nextVersion}
          return}
        toast(r.err||'发布失败',false);if(btn){btn.disabled=false;btn.textContent='发布 '+pv.nextVersion}})}
    function srCheck(){
      var srcSel=$('#sr-src').value;
      $('#sr-check').disabled=true;$('#sr-preview').innerHTML='<p class="mut">同步并比对中…（首次要克隆仓库，可能要一会儿）</p>';
      post('skill-src',{action:'check',source:srcSel}).then(function(pv){
        $('#sr-check').disabled=false;
        if(!pv.ok){$('#sr-preview').innerHTML='<div class="msg err" style="display:block">'+esc(pv.err||'检查失败')+'</div>';return}
        var logDflt=(pv.commits||[]).map(function(c){var i=c.indexOf(' ');return i>0?c.slice(i+1):c}).slice(0,10).join('；');
        $('#sr-preview').innerHTML=
          '<div class="hint" style="margin:10px 0 8px">源 <code>'+esc(pv.shortSha||'（非 git 检出）')+'</code> · '+
            pv.skills+' 个技能，'+fmtSize(pv.sizeBytes)+(pv.preserved&&pv.preserved.length?' · 包外保留：'+esc(pv.preserved.join('、')):'')+
            (pv.dropped&&pv.dropped.length?' · <b style="color:#c62828">客户端将删除：'+esc(pv.dropped.join('、'))+'</b>':'')+
            ' · 将发布为 <b>'+esc(pv.nextVersion)+'</b></div>'+
          (pv.upToDate?'<div class="msg ok" style="display:block">已是最新：源与上次发布的 commit 相同，没有要发的东西。</div>':
            ((pv.warnings||[]).length?'<div class="msg" style="display:block">'+pv.warnings.map(esc).join('<br>')+'</div>':'')+
            '<div style="margin:8px 0">变更技能：'+((pv.changedSkills||[]).length?pv.changedSkills.map(function(s){return '<span class="tag">'+esc(s)+'</span>'}).join(' '):'<span class="mut">（未知——将提示所有用户）</span>')+
              (pv.agentsChanged?' <span class="tag">AGENTS.md 路由表有更新</span>':'')+'</div>'+
            ((pv.commits||[]).length?'<div class="mut" style="font-size:12.5px;max-height:140px;overflow:auto;margin:8px 0">'+pv.commits.map(esc).join('<br>')+'</div>':'')+
            '<div class="row" style="margin-top:8px"><input id="sr-log" placeholder="更新说明（留空 = 用提交说明拼）" value="'+esc(logDflt).slice(0,300)+'" style="flex:1">'+
            '<button class="btn primary" id="sr-go">发布 '+esc(pv.nextVersion)+'</button></div>');
        var go=$('#sr-go');if(go)go.onclick=function(){srPublish(pv,false)};
      })}
    $('#sr-check').onclick=srCheck;
    Array.prototype.forEach.call(document.querySelectorAll('#pane [data-act]'),function(b){
      b.onclick=function(){
        var v=b.dataset.v,act=b.dataset.act;
        if(act==='delete'&&!confirm('删除版本 '+v+'？包文件一并删除，已装该版的客户端不受影响，但无法再从服务器重新下到它。'))return;
        if(act==='disable'&&!confirm('撤下版本 '+v+'？客户端将不再提示更新到它；已更新的客户端可自行回退本地留存的旧版。'))return;
        post('skill-pack',{version:v,action:act}).then(function(r){
          if(r.ok){toast('已'+(act==='delete'?'删除':act==='disable'?'撤下':'恢复')+' '+v,true);loadPacks()}
          else toast(r.err||'操作失败',false)})}});
  })
}

// ---------- 界面包 ----------
// 改个文案 / 调个样式 / 修个按钮，原先要重新打包整个安装器再催所有人重装。这里发一个包，
// 客户端提示一下、点一次、刷新页面就换过去了 —— 不重启后台、不打断正在跑的任务。
//
// 【能发什么】只有 web/ 下的静态资源（html/css/js/图片/字体）。**.mjs 发不了**：那是本机
// 网关的服务端代码，换它要重启网关、坏了客户端直接起不来，只能走重新打包安装器。
function loadWebPacks(){
  render();
  $('#pane').innerHTML='<section><h2>界面包</h2><p class="mut">加载中…</p></section>';
  api('web-packs').then(function(j){
    if(!j.ok){if(!j.unauth)$('#pane').innerHTML='<section><div class="msg err" style="display:block">'+esc(j.err||'加载失败')+'</div></section>';return}
    var rows=(j.packs||[]).map(function(p){
      var tag=p.version===j.current?'<span class="tag" style="background:var(--acc);color:#fff">当前最新</span>'
        :p.status!=='active'?'<span class="tag">已撤下</span>':'';
      return '<tr'+(p.status!=='active'?' style="opacity:.55"':'')+'>'+
        '<td><b>'+esc(p.version)+'</b> '+tag+(p.fileOk?'':' <span class="tag" style="color:var(--bad)">文件缺失</span>')+'</td>'+
        '<td class="mut" style="white-space:nowrap">'+dt(p.createdAt)+'</td>'+
        '<td>'+fmtSize(p.size)+'</td>'+
        '<td class="mut" style="font-size:12.5px;max-width:320px">'+esc(p.changelog||'')+
          (p.files.length?'<div style="font-size:12px;margin-top:3px">'+esc(p.files.join('、'))+'</div>':'')+'</td>'+
        '<td style="white-space:nowrap">'+
          (p.status==='active'
            ?'<button class="btn sm" data-wact="disable" data-v="'+esc(p.version)+'">撤下</button>'
            :'<button class="btn sm" data-wact="enable" data-v="'+esc(p.version)+'">恢复</button>')+
          ' <button class="btn sm danger" data-wact="delete" data-v="'+esc(p.version)+'">删除</button></td></tr>'}).join('');
    var vers=(j.versions||[]).map(function(v){
      return '<span class="tag">'+esc(v.v||'出厂版')+' × '+v.n+'</span>'}).join(' ');
    var srcLine=j.remote.configured
      ?'远程：<code>'+esc(j.remote.url)+'</code> @ <code>'+esc(j.remote.ref)+'</code>'
      :'<b>未配置 SKILL_REPO_URL</b>（/etc/sci-auth.env）——只能从服务器本地检出发布';
    $('#pane').innerHTML='<section><h2>从仓库发布（推荐）</h2>'+
      '<div class="hint" style="margin:0 0 10px">把 <code>web/</code> 下的<b>前端静态资源</b>打成一个版本包发给客户端：'+
      '改文案、调样式、修按钮这类小更新<b>不用再重打安装器</b>。客户端提示「更新并刷新」，点一次就换过去了——'+
      '不重启后台、不打断正在跑的任务；出问题在下面「撤下」，客户端可一键回退（本地留最近 5 版，出厂版永不清）。<br>'+
      '<b>发不了的东西</b>：<code>web/*.mjs</code>（本机网关代码）、Python/pandoc 等依赖、桌面壳本身 —— 那些仍要重新打包安装器。<br>'+srcLine+
      (j.lastPublished?'　·　上次发布：<code>'+esc(j.lastPublished.version)+'</code>'+(j.lastPublished.commitSha?' @ <code>'+esc(j.lastPublished.commitSha.slice(0,10))+'</code>':''):'')+'</div>'+
      '<div class="row"><select id="wr-src" style="max-width:180px">'+
        (j.remote.configured?'<option value="remote">远程同步（git fetch）</option>':'')+
        '<option value="local">服务器本地检出</option></select>'+
      '<button class="btn primary" id="wr-check">检查更新</button></div>'+
      '<div id="wr-preview"></div></section>'+
      '<section><h2>手动上传（兜底）</h2>'+
      '<div class="hint" style="margin:0 0 10px">zip 里要有 <code>pack.json</code>（含点分数字 version）与 <code>web/…</code> 若干静态资源。'+
      '不合规的条目（.mjs / .json / node_modules / 越界路径）一律整包拒收。</div>'+
      '<div class="row"><input type="file" id="wk-file" accept=".zip">'+
      '<button class="btn" id="wk-up">上传并发布</button></div></section>'+
      '<section><h2>已发布版本'+(j.current?'（当前最新：'+esc(j.current)+'）':'（还没发布过）')+'</h2>'+
      '<div class="hint" style="margin:0 0 10px">客户端界面版本分布：'+(vers||'<span class="mut">暂无数据（客户端升级后才会汇报）</span>')+'</div>'+
      '<table><thead><tr><th>版本</th><th>发布时间</th><th>大小</th><th>说明 / 包含文件</th><th></th></tr></thead>'+
      '<tbody>'+(rows||'<tr><td colspan="5" class="mut">暂无版本</td></tr>')+'</tbody></table></section>';

    $('#wk-up').onclick=function(){
      var f=$('#wk-file').files[0];
      if(!f)return toast('先选择界面包 zip',false);
      $('#wk-up').disabled=true;toast('上传中…（'+fmtSize(f.size)+'）',true);
      api('web-pack-upload',{method:'POST',body:f}).then(function(r){
        $('#wk-up').disabled=false;
        if(!r.ok)return toast(r.err||'上传失败',false);
        toast('已发布 '+r.version+'（'+r.files.length+' 个文件）',true);loadWebPacks()})};

    function wrPublish(pv){
      var btn=$('#wr-go');if(btn){btn.disabled=true;btn.textContent='发布中…'}
      post('web-src',{action:'publish',source:pv.source,sha:pv.sha,
        changelog:($('#wr-log')?$('#wr-log').value.trim():'')}).then(function(r){
        if(r.ok){toast('已发布 '+r.version+'（'+r.files.length+' 个文件）',true);loadWebPacks();return}
        if(r.staleSha){toast(r.err,false);wrCheck();return}
        toast(r.err||'发布失败',false);if(btn){btn.disabled=false;btn.textContent='发布 '+pv.nextVersion}})}
    function wrCheck(){
      $('#wr-check').disabled=true;$('#wr-preview').innerHTML='<p class="mut">同步并比对中…（首次要克隆仓库，可能要一会儿）</p>';
      post('web-src',{action:'check',source:$('#wr-src').value}).then(function(pv){
        $('#wr-check').disabled=false;
        if(!pv.ok){$('#wr-preview').innerHTML='<div class="msg err" style="display:block">'+esc(pv.err||'检查失败')+'</div>';return}
        $('#wr-preview').innerHTML=
          '<div class="hint" style="margin:10px 0 8px">源 <code>'+esc(pv.shortSha||'（非 git 检出）')+'</code> · '+
            (pv.files||[]).length+' 个文件，'+fmtSize(pv.sizeBytes)+' · 将发布为 <b>'+esc(pv.nextVersion)+'</b></div>'+
          ((pv.warnings||[]).length?'<div class="msg" style="display:block">'+pv.warnings.map(esc).join('<br>')+'</div>':'')+
          '<div class="mut" style="font-size:12.5px;margin:8px 0">'+(pv.files||[]).map(esc).join('、')+'</div>'+
          '<div class="row" style="margin-top:8px"><input id="wr-log" placeholder="更新说明（会显示在客户端的提示条上，如：闲置锁屏改成 24 小时）" style="flex:1">'+
          '<button class="btn primary" id="wr-go">发布 '+esc(pv.nextVersion)+'</button></div>';
        var go=$('#wr-go');if(go)go.onclick=function(){wrPublish(pv)}})}
    $('#wr-check').onclick=wrCheck;
    Array.prototype.forEach.call(document.querySelectorAll('#pane [data-wact]'),function(b){
      b.onclick=function(){
        var v=b.dataset.v,act=b.dataset.wact;
        if(act==='delete'&&!confirm('删除版本 '+v+'？包文件一并删除，已装该版的客户端不受影响，但无法再从服务器重新下到它。'))return;
        if(act==='disable'&&!confirm('撤下版本 '+v+'？客户端将不再提示更新到它；已更新的客户端可自行回退本地留存的旧版。'))return;
        post('web-pack',{version:v,action:act}).then(function(r){
          if(r.ok){toast('已'+(act==='delete'?'删除':act==='disable'?'撤下':'恢复')+' '+v,true);loadWebPacks()}
          else toast(r.err||'操作失败',false)})}});
  })
}

// ---------- 用户反馈 ----------
// 用户把一次会话（完整对话 + 可选产出）连同赞/踩与说明交上来。这一页管浏览、标记已处理、
// 下载附件、导出 HTML（单文件、离线可看，方便转给别人或存档）。
var FB = { status: '', vote: '', q: '', open: 0 }
function loadFeedback(){
  render();
  $('#pane').innerHTML='<section><h2>用户反馈</h2><p class="mut">加载中…</p></section>';
  api('feedback?status='+encodeURIComponent(FB.status)+'&vote='+encodeURIComponent(FB.vote)+'&q='+encodeURIComponent(FB.q))
    .then(function(j){
      if(!j.ok){if(!j.unauth)$('#pane').innerHTML='<section><div class="msg err" style="display:block">'+esc(j.err||'加载失败')+'</div></section>';return}
      paneFeedback(j)})
}
function voteTag(v){return v>0?'<span class="tag ok">👍</span>':v<0?'<span class="tag bad">👎</span>':'<span class="tag">💬</span>'}
function paneFeedback(j){
  var c=j.counts||{};
  var rows=(j.rows||[]).map(function(f){
    return '<tr data-id="'+f.id+'"'+(f.status==='done'?' style="opacity:.6"':'')+'>'+
      '<td>'+voteTag(f.vote)+'</td>'+
      '<td><b>'+esc(f.title||'(未命名会话)')+'</b>'+
        '<div class="mut" style="font-size:12.5px">'+esc(f.comment||'（没有留言）').slice(0,120)+'</div></td>'+
      '<td class="mut" style="white-space:nowrap">'+esc(f.username)+'<div style="font-size:12px">'+dt(f.created_at)+'</div></td>'+
      '<td class="mut" style="font-size:12.5px;white-space:nowrap">'+f.msgs+' 条'+(f.files.length?'<br>'+f.files.length+' 个附件':'')+'</td>'+
      '<td>'+(f.status==='done'?'<span class="tag">已处理</span>':'<span class="tag warn">待处理</span>')+'</td>'+
      '<td style="white-space:nowrap">'+
        '<button class="btn sm" data-fa="open">查看</button> '+
        '<a class="btn sm" style="text-decoration:none" href="/admin/api/feedback-export?id='+f.id+'">导出</a> '+
        '<button class="btn sm" data-fa="'+(f.status==='done'?'reopen':'done')+'">'+(f.status==='done'?'重开':'标记已处理')+'</button> '+
        '<button class="btn sm danger" data-fa="delete">删除</button></td></tr>'}).join('');
  var sel=function(id,cur,opts){return '<select id="'+id+'">'+opts.map(function(o){
    return '<option value="'+o[0]+'"'+(cur===o[0]?' selected':'')+'>'+o[1]+'</option>'}).join('')+'</select>'};
  $('#pane').innerHTML='<section><div class="row"><h2 style="margin:0">用户反馈</h2>'+
      '<span class="mut" style="font-size:12.5px">共 '+(c.all_n||0)+' 条 · 待处理 '+(c.new_n||0)+' · 👍'+(c.up_n||0)+' 👎'+(c.down_n||0)+'</span>'+
      '<span class="sp"></span>'+
      sel('fb-status',FB.status,[['','全部状态'],['new','待处理'],['done','已处理']])+
      sel('fb-vote',FB.vote,[['','赞踩不限'],['up','只看👍'],['down','只看👎']])+
      '<input id="fb-q" placeholder="搜用户/标题/留言" value="'+esc(FB.q)+'" style="max-width:200px">'+
      '<button class="btn" id="fb-go">筛选</button>'+
      '<a class="btn" style="text-decoration:none" href="/admin/api/feedback-export?status='+encodeURIComponent(FB.status)+'&vote='+encodeURIComponent(FB.vote)+'">导出当前筛选</a></div>'+
    '<div class="hint" style="margin:8px 0 12px">用户提交时会附上<b>那次会话的完整对话</b>（以及他自己勾选的产出文件）。'+
      '导出的是单文件 HTML，离线可看、可转发存档。<b>内容可能含患者信息</b>，转发前请自行判断。</div>'+
    '<table><thead><tr><th></th><th>会话 / 留言</th><th>用户 / 时间</th><th>规模</th><th>状态</th><th></th></tr></thead>'+
    '<tbody>'+(rows||'<tr><td colspan="6" class="mut">还没有反馈</td></tr>')+'</tbody></table></section>'+
    '<section id="fb-detail" hidden></section>';
  $('#fb-go').onclick=function(){FB.status=$('#fb-status').value;FB.vote=$('#fb-vote').value;FB.q=$('#fb-q').value.trim();loadFeedback()};
  $('#fb-q').onkeydown=function(e){if(e.key==='Enter')$('#fb-go').click()};
  Array.prototype.forEach.call($('#pane').querySelectorAll('tbody [data-fa]'),function(b){
    b.onclick=function(){
      var id=Number(b.closest('tr').dataset.id),a=b.dataset.fa;
      if(a==='open')return openFeedbackDetail(id);
      if(a==='delete'&&!confirm('删除这条反馈？对话记录与附件一并删除，不可恢复。'))return;
      post('feedback',{id:id,action:a}).then(function(r){
        if(!r.ok)return toast(r.err||'操作失败',false);
        toast(a==='delete'?'已删除':a==='done'?'已标记处理':'已重开',true);loadFeedback()})}});
}
function openFeedbackDetail(id){
  var box=$('#fb-detail');box.hidden=false;box.innerHTML='<h2>反馈 #'+id+'</h2><p class="mut">加载中…</p>';
  box.scrollIntoView({block:'start'});
  api('feedback?id='+id).then(function(j){
    if(!j.ok)return box.innerHTML='<div class="msg err" style="display:block">'+esc(j.err||'加载失败')+'</div>';
    var f=j.item;
    var msgs=(f.transcript||[]).map(function(m){
      var who=m.role==='user'?'用户':'助手';
      return '<div style="margin:0 0 10px;padding:9px 12px;border-radius:9px;background:'+(m.role==='user'?'#eff6ff':'#f9fafb')+
        ';border:1px solid var(--line)">'+
        '<div class="mut" style="font-size:12px;margin-bottom:4px">'+who+(m.ts?' · '+dt(m.ts):'')+
          ((m.skills||[]).length?' · 技能：'+esc(m.skills.join('、')):'')+'</div>'+
        '<div style="white-space:pre-wrap;word-break:break-word">'+esc(m.text||'')+'</div></div>'}).join('');
    box.innerHTML='<div class="row"><h2 style="margin:0">反馈 #'+f.id+' '+voteTag(f.vote)+'</h2>'+
      '<span class="mut" style="font-size:12.5px">'+esc(f.username)+' · '+dt(f.created_at)+' · '+f.msgs+' 条消息'+
        (f.meta.clientVersion?' · 客户端 '+esc(f.meta.clientVersion):'')+(f.meta.model?' · 模型 '+esc(f.meta.model):'')+'</span>'+
      '<span class="sp"></span><a class="btn sm" style="text-decoration:none" href="/admin/api/feedback-export?id='+f.id+'">导出 HTML</a>'+
      '<button class="btn sm" id="fb-hide">收起</button></div>'+
      (f.comment?'<div class="msg" style="display:block;position:static;max-width:none;margin:10px 0"><b>用户留言：</b>'+esc(f.comment)+'</div>':'')+
      ((f.files||[]).length?'<div class="hint" style="margin:8px 0">附带产出：'+f.files.map(function(x){
        return '<a href="/admin/api/feedback-file?id='+f.id+'&name='+encodeURIComponent(x.name)+'">'+esc(x.name)+'</a>（'+Math.round((x.size||0)/1024)+' KB）'}).join('　')+'</div>':'')+
      '<div style="max-height:60vh;overflow:auto;margin-top:10px">'+(msgs||'<p class="mut">（这条反馈没有带对话记录）</p>')+'</div>';
    $('#fb-hide').onclick=function(){box.hidden=true};
  })
}

// ---------- 审计 ----------
// 【必须能筛】login.ok / llm.quota_block 是高频事件，固定取最近 300 条时，"上周我把谁改成
// 了 plus 档"这类真正要查的管理动作早被冲出窗口了。按事件前缀 + 操作人筛，并翻页。
function loadAudit(){
  render();
  S.auOffset=S.auOffset||0;
  $('#pane').innerHTML='<section><h2>审计日志</h2><p class="mut">加载中…</p></section>';
  api('audit?limit=200&offset='+S.auOffset+'&event='+encodeURIComponent(S.auEvent||'')+
      '&actor='+encodeURIComponent(S.auActor||'')).then(function(j){
    if(!j.ok){if(!j.unauth)$('#pane').innerHTML='<section><div class="msg err" style="display:block">'+esc(j.err||'加载失败')+'</div></section>';return}
    var rows=(j.rows||[]).map(function(a){
      return '<tr><td class="mut" style="font-size:12.5px;white-space:nowrap">'+dt(a.ts)+'</td>'+
        '<td><span class="tag">'+esc(a.event)+'</span></td><td>'+esc(a.actor||'—')+'</td>'+
        '<td>'+esc(a.target||'—')+'</td><td class="mut" style="font-size:12.5px">'+esc(a.detail||'')+'</td>'+
        '<td class="mut" style="font-size:12.5px">'+esc(a.ip||'')+'</td></tr>'}).join('');
    // 事件下拉按前缀分组（user. / provider. / llm. …），前缀本身也能选：查"这段时间我动过
    // 哪些用户"就选 user.，不用一个个事件名去点。
    var pres={};(j.events||[]).forEach(function(e){var p=String(e.event).split('.')[0]+'.';pres[p]=(pres[p]||0)+e.n});
    var opts='<option value="">全部事件</option>'+
      Object.keys(pres).sort().map(function(p){
        return '<option value="'+esc(p)+'"'+(S.auEvent===p?' selected':'')+'>'+esc(p)+'*（'+pres[p]+'）</option>'}).join('')+
      (j.events||[]).map(function(e){
        return '<option value="'+esc(e.event)+'"'+(S.auEvent===e.event?' selected':'')+'>　'+esc(e.event)+'（'+e.n+'）</option>'}).join('');
    var from=S.auOffset+1,to=S.auOffset+(j.rows||[]).length;
    $('#pane').innerHTML='<section><div class="row"><h2 style="margin:0">审计日志</h2>'+
      '<span class="sp"></span><select id="a-ev" style="max-width:220px">'+opts+'</select>'+
      '<input id="a-ac" placeholder="操作人/登录名" value="'+esc(S.auActor||'')+'" style="width:150px">'+
      '<button class="btn" id="a-go">筛选</button></div>'+
      '<div class="hint" style="margin:8px 0 12px">第 '+from+'–'+to+' 条，共 '+j.total+' 条 · 北京时间。'+
      '超过 180 天的记录会被自动清理（AUDIT_KEEP_DAYS 可调）。</div>'+
      '<table><thead><tr><th>时间</th><th>事件</th><th>操作人</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>'+
      '<tbody>'+(rows||'<tr><td colspan="6" class="mut">暂无记录</td></tr>')+'</tbody></table>'+
      '<div class="row" style="margin-top:12px"><span class="sp"></span>'+
      '<button class="btn sm" id="a-prev"'+(S.auOffset<=0?' disabled':'')+'>上一页</button>'+
      '<button class="btn sm" id="a-next"'+(to>=j.total?' disabled':'')+'>下一页</button></div></section>';
    $('#a-go').onclick=function(){S.auEvent=$('#a-ev').value;S.auActor=$('#a-ac').value.trim();S.auOffset=0;loadAudit()};
    $('#a-prev').onclick=function(){S.auOffset=Math.max(0,S.auOffset-200);loadAudit()};
    $('#a-next').onclick=function(){S.auOffset=S.auOffset+200;loadAudit()};
  })
}

$('#logout').onclick=function(){post('logout').then(function(){renderLogin('')})};
load();
</script></body></html>`
