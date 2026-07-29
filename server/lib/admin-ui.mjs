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
</style></head><body>
<header><h1>运营后台</h1><span class="mut" id="sub"></span><span class="sp"></span>
<button class="btn sm" id="logout" style="display:none">退出</button></header>
<div class="msg" id="msg"></div>
<main id="app"></main>
<dialog id="dlg"><form method="dialog"><div class="dlg-h" id="dlg-h"></div>
<div class="dlg-b" id="dlg-b"></div><div class="dlg-f" id="dlg-f"></div></form></dialog>
<script>
var S={users:[],tiers:[],skills:[],board:null,q:'',tab:'users'};
var $=function(s){return document.querySelector(s)};
var esc=function(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})};
var money=function(n){return '$'+(Number(n)||0).toFixed(4).replace(/0+$/,'').replace(/\\.$/,'.00')};
var dt=function(ms){if(!ms)return '—';var d=new Date(Number(ms));
  return d.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})};

function api(p,opt){return fetch('/admin/api/'+p,opt).then(function(r){
  if(r.status===401&&p!=='login')throw{unauth:1};return r.json()})}
function post(p,body){return api(p,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify(body||{})})}
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
  api('overview?q='+encodeURIComponent(S.q)).then(function(d){
    if(!d.ok)return renderLogin(d.err||'');
    S.users=d.users;S.tiers=d.tiers;S.skills=d.skills;S.board=d.board;S.total=d.total;S.matched=d.matched;
    render()}).catch(function(e){renderLogin(e&&e.unauth?'':'加载失败')})
}
function render(){
  $('#logout').style.display='';
  $('#sub').textContent='共 '+S.total+' 个账号';
  $('#app').innerHTML=
    '<div class="tabs">'+
      tabBtn('users','用户')+tabBtn('board','看板')+tabBtn('tiers','档位')+tabBtn('chan','上游通道')+tabBtn('audit','审计')+
    '</div><div id="pane"></div>';
  Array.prototype.forEach.call(document.querySelectorAll('.tabs button'),function(b){
    b.onclick=function(){S.tab=b.dataset.k;
      if(S.tab==='audit')loadAudit();else if(S.tab==='chan')loadChannels();else render()}});
  if(S.tab==='users')paneUsers();
  else if(S.tab==='board')paneBoard();
  else if(S.tab==='tiers')paneTiers();
  else if(S.tab==='chan')paneChannels();
}
function tabBtn(k,label){return '<button data-k="'+k+'" class="'+(S.tab===k?'on':'')+'">'+label+'</button>'}

// ---------- 用户 ----------
function paneUsers(){
  var rows=S.users.map(function(u){
    var lim=u.limits.daily,used=u.usage.today;
    var pct=lim>0?Math.min(100,Math.round(used/lim*100)):0;
    var cls=pct>=100?'bad':pct>=80?'warn':'';
    var usage=lim>0
      ? '<div class="usage">'+money(used)+' <span class="mut">/ '+money(lim)+' ('+pct+'%)</span></div>'+
        '<div class="bar '+cls+'"><i style="width:'+pct+'%"></i></div>'
      : '<span class="usage">'+money(used)+' <span class="mut">/ 不限</span></span>';
    return '<tr data-id="'+u.id+'">'+
      '<td><b>'+esc(u.displayName)+'</b>'+(u.surname?' <span class="rank">姓:'+esc(u.surname)+'</span>':'')+
        '<div class="mut" style="font-size:12.5px">'+esc(u.username)+(u.hospital?' · '+esc(u.hospital):'')+'</div></td>'+
      '<td><span class="tag">'+esc(u.tier)+'</span></td>'+
      '<td>'+(u.status==='active'?'<span class="tag ok">正常</span>':'<span class="tag bad">已停用</span>')+
        (u.mustChangePw?' <span class="tag warn">待改密</span>':'')+'</td>'+
      '<td>'+usage+'</td>'+
      '<td class="mut" style="font-size:12.5px">'+dt(u.lastSeenAt)+(u.clientVersion?'<br>v'+esc(u.clientVersion):'')+'</td>'+
      '<td class="row" style="gap:5px;flex-wrap:nowrap">'+
        '<button class="btn sm" data-a="edit">编辑</button>'+
        '<button class="btn sm" data-a="usage">用量</button>'+
        '<button class="btn sm" data-a="susp">'+(u.status==='active'?'停用':'恢复')+'</button>'+
        '<button class="btn sm" data-a="more">…</button></td></tr>'}).join('');
  $('#pane').innerHTML='<section>'+
    '<div class="row" style="margin-bottom:12px">'+
      '<input id="q" placeholder="按姓名筛选：输一个字或两个字（姓氏优先）" value="'+esc(S.q)+'" style="flex:1;min-width:260px">'+
      '<button class="btn" id="clear">清空</button>'+
      '<span class="sp"></span><button class="btn primary" id="add">+ 新建账号</button></div>'+
    '<div class="hint">例：输「张」→ 姓张的排最前，名字里带张的排后面；输「欧阳」「小明」同样可用。也可用登录名/手机号/医院找人。</div>'+
    (S.q?'<div class="hint">命中 '+S.matched+' / '+S.total+'</div>':'')+
    '<table style="margin-top:12px"><thead><tr><th>姓名 / 账号</th><th>档位</th><th>状态</th>'+
    '<th>今日用量</th><th>最近活跃</th><th></th></tr></thead><tbody>'+
    (rows||'<tr><td colspan="6" class="mut" style="padding:22px;text-align:center">没有匹配的账号</td></tr>')+
    '</tbody></table></section>';

  var q=$('#q');
  q.oninput=function(){clearTimeout(q.t);q.t=setTimeout(function(){S.q=q.value;load()},220)};
  q.focus();q.setSelectionRange(q.value.length,q.value.length);
  $('#clear').onclick=function(){S.q='';load()};
  $('#add').onclick=dlgAdd;
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

function skillChips(selected,all){
  var sel=selected||[];
  return '<div class="chips">'+all.map(function(s){
    return '<span class="chip'+(sel.indexOf(s.id)>=0?' on':'')+'" data-s="'+esc(s.id)+'">'+esc(s.label)+'</span>'}).join('')+'</div>'}

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
    '<div class="hint">全不选 = 随档位；选中即只允许这些。注意这是<b>软管控</b>：技能在客户端执行，'+
    '真正硬的闸是额度与模型档次。</div>'+skillChips(ov.skills==null?null:String(ov.skills).split(',').filter(Boolean),S.skills)+
    '<div class="row" style="margin-top:8px"><button class="btn sm" id="e-none">跟随档位</button>'+
    '<button class="btn sm" id="e-all">全选</button></div></div>'+
    '<div class="hint" style="margin-top:12px">改档位或额度会立刻吊销该用户已签发的 key，客户端需重新登录。</div>',
    '<button class="btn primary" id="ok" value="default">保存</button>');
  var follow=(ov.skills==null);
  var chips=$('#dlg-b').querySelectorAll('.chip');
  Array.prototype.forEach.call(chips,function(c){c.onclick=function(){follow=false;c.classList.toggle('on')}});
  $('#e-none').onclick=function(e){e.preventDefault();follow=true;
    Array.prototype.forEach.call(chips,function(c){c.classList.remove('on')});toast('已设为跟随档位',true)};
  $('#e-all').onclick=function(e){e.preventDefault();follow=false;
    Array.prototype.forEach.call(chips,function(c){c.classList.add('on')})};
  $('#ok').onclick=function(e){e.preventDefault();
    var picked=[];Array.prototype.forEach.call(chips,function(c){if(c.classList.contains('on'))picked.push(c.dataset.s)});
    post('user-update',{id:u.id,displayName:$('#e-dn').value.trim(),surname:$('#e-sn').value.trim(),
      hospital:$('#e-hos').value.trim(),position:$('#e-pos').value.trim(),phone:$('#e-ph').value.trim(),
      tier:$('#e-tier').value,note:$('#e-note').value.trim(),
      dailyOverride:$('#e-day').value.trim(),monthlyOverride:$('#e-mon').value.trim(),
      skillsOverride:follow?null:picked.join(',')}).then(function(j){
      if(!j.ok)return toast(j.err||'保存失败',false);
      $('#dlg').close();toast('已保存'+(j.keyRevoked?'（已吊销该用户 key，需重新登录）':''),true);load()})}
}

function dlgMore(u){
  dlg('更多操作 · '+u.displayName,
    '<div class="row" style="gap:10px;flex-direction:column;align-items:stretch">'+
    '<button class="btn" id="m-pw">重置口令</button>'+
    '<div class="hint">生成新的强随机口令，旧口令与已签发 key 立即失效，用户下次登录须再次改密。</div>'+
    '<button class="btn" id="m-key">重置 key</button>'+
    '<div class="hint">只吊销已签发的 key（口令不变）。怀疑 key 外借/泄露时用。</div>'+
    '<button class="btn danger" id="m-del">删除账号</button>'+
    '<div class="hint">连同用量记录一并删除，不可恢复。</div></div>');
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
      return '<tr><td class="mut" style="font-size:12.5px">'+dt(d.ts)+'</td><td>'+esc(d.model||'—')+'</td>'+
        '<td>'+esc(d.skill||'—')+'</td><td class="mut">'+d.prompt_tokens+'/'+d.completion_tokens+
        (d.cached_tokens?' <span class="tag">缓存'+d.cached_tokens+'</span>':'')+'</td>'+
        '<td>'+money(d.cost_usd)+'</td></tr>'}).join('');
    $('#dlg-b').innerHTML='<div class="kpi" style="margin-bottom:14px">'+
      '<div><span class="mut">今日</span><b>'+money(j.user.usage.today)+'</b></div>'+
      '<div><span class="mut">本月</span><b>'+money(j.user.usage.month)+'</b></div>'+
      '<div><span class="mut">日上限</span><b>'+(j.user.limits.daily?money(j.user.limits.daily):'不限')+'</b></div>'+
      '<div><span class="mut">月上限</span><b>'+(j.user.limits.monthly?money(j.user.limits.monthly):'不限')+'</b></div></div>'+
      spark+'<h2 style="margin:16px 0 8px">最近调用</h2>'+
      (det?'<table><thead><tr><th>时间</th><th>模型</th><th>技能</th><th>tokens 入/出</th><th>成本</th></tr></thead><tbody>'+det+'</tbody></table>'
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
    '</section>';
}

// ---------- 档位 ----------
function paneTiers(){
  var rows=S.tiers.map(function(t){
    var n=S.users.filter(function(u){return u.tier===t.key}).length;
    return '<tr data-k="'+esc(t.key)+'"><td><b>'+esc(t.key)+'</b><div class="mut" style="font-size:12.5px">'+esc(t.note||'')+'</div></td>'+
      '<td>'+(t.daily_usd?money(t.daily_usd):'不限')+'</td><td>'+(t.monthly_usd?money(t.monthly_usd):'不限')+'</td>'+
      '<td>'+esc(t.model||'—')+'</td><td class="mut" style="font-size:12.5px">'+(t.skills?esc(t.skills):'全部技能')+'</td>'+
      '<td>'+n+' 人</td><td><button class="btn sm" data-a="ed">编辑</button> '+
      '<button class="btn sm danger" data-a="rm">删除</button></td></tr>'}).join('');
  $('#pane').innerHTML='<section><div class="row"><h2 style="margin:0">档位</h2><span class="sp"></span>'+
    '<button class="btn primary" id="t-add">+ 新增档位</button></div>'+
    '<div class="hint" style="margin:8px 0 12px">改动档位会立刻吊销该档位下所有用户的 key，他们需重新登录后按新权限生效。</div>'+
    '<table><thead><tr><th>档位</th><th>日额度</th><th>月额度</th><th>模型</th><th>技能</th><th>用户</th><th></th></tr></thead>'+
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
function dlgTier(t){
  t=t||{key:'',daily_usd:0,monthly_usd:0,model:'',skills:'',note:'',sort:5};
  dlg(t.key?('编辑档位 · '+t.key):'新增档位',
    '<div class="grid">'+
    '<label>档位键 *</label><input id="t-k" value="'+esc(t.key)+'"'+(t.key?' readonly':'')+' placeholder="小写字母开头，如 gold">'+
    '<label>日额度 USD</label><input id="t-d" value="'+t.daily_usd+'" placeholder="0 = 不限">'+
    '<label>月额度 USD</label><input id="t-m" value="'+t.monthly_usd+'" placeholder="0 = 不限">'+
    '<label>模型</label><input id="t-mo" value="'+esc(t.model)+'" placeholder="该档位强制使用的模型名">'+
    '<label>说明</label><input id="t-n" value="'+esc(t.note)+'">'+
    '<label>排序</label><input id="t-s" value="'+t.sort+'"></div>'+
    '<div style="margin-top:14px"><label class="mut">可用技能（全不选 = 全部）</label>'+
    skillChips(String(t.skills||'').split(',').filter(Boolean),S.skills)+'</div>',
    '<button class="btn primary" id="ok" value="default">保存</button>');
  var chips=$('#dlg-b').querySelectorAll('.chip');
  Array.prototype.forEach.call(chips,function(c){c.onclick=function(){c.classList.toggle('on')}});
  $('#ok').onclick=function(e){e.preventDefault();
    var picked=[];Array.prototype.forEach.call(chips,function(c){if(c.classList.contains('on'))picked.push(c.dataset.s)});
    post('tier',{key:$('#t-k').value.trim(),dailyUSD:Number($('#t-d').value)||0,
      monthlyUSD:Number($('#t-m').value)||0,model:$('#t-mo').value.trim(),
      skills:picked.join(','),note:$('#t-n').value.trim(),sort:Number($('#t-s').value)||0}).then(function(j){
      if(!j.ok)return toast(j.err||'保存失败',false);
      $('#dlg').close();toast('已保存'+(j.affected?'（已吊销 '+j.affected+' 个用户的 key）':''),true);load()})}
}

// ---------- 上游通道 ----------
function loadChannels(){
  render();
  $('#pane').innerHTML='<section><h2>上游通道</h2><p class="mut">加载中…</p></section>';
  api('channels').then(function(d){S.chan=d;paneChannels()})
    .catch(function(){$('#pane').innerHTML='<section><p class="mut">加载失败</p></section>'})
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

// ---------- 审计 ----------
function loadAudit(){
  render();
  $('#pane').innerHTML='<section><h2>审计日志 <span class="mut">最近 300 条</span></h2><p class="mut">加载中…</p></section>';
  api('audit').then(function(j){
    var rows=(j.rows||[]).map(function(a){
      return '<tr><td class="mut" style="font-size:12.5px;white-space:nowrap">'+dt(a.ts)+'</td>'+
        '<td><span class="tag">'+esc(a.event)+'</span></td><td>'+esc(a.actor||'—')+'</td>'+
        '<td>'+esc(a.target||'—')+'</td><td class="mut" style="font-size:12.5px">'+esc(a.detail||'')+'</td>'+
        '<td class="mut" style="font-size:12.5px">'+esc(a.ip||'')+'</td></tr>'}).join('');
    $('#pane').innerHTML='<section><h2>审计日志 <span class="mut">最近 300 条 · 北京时间</span></h2>'+
      '<table><thead><tr><th>时间</th><th>事件</th><th>操作人</th><th>对象</th><th>详情</th><th>IP</th></tr></thead>'+
      '<tbody>'+(rows||'<tr><td colspan="6" class="mut">暂无记录</td></tr>')+'</tbody></table></section>'})
}

$('#logout').onclick=function(){post('logout').then(function(){renderLogin('')})};
load();
</script></body></html>`
