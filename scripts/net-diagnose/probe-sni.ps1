# 二段诊断 —— 上一步（diagnose-server.ps1）已经确认：DNS 正确、TCP 443 能连上，
# 但 TLS 握手被 RST（"An existing connection was forcibly closed"）。
# 那只可能是中间设备在看到 ClientHello 之后把连接掐了。这个脚本只回答一个问题：
#
#     它掐的是【域名字符串】，还是【服务器 IP / 这条线路】？
#
# 这个答案决定解法，两者完全不同：
#   · 掐域名  → 换一个自有域名就能解决（DNS + Caddyfile + 客户端地址，改动很小）
#   · 掐 IP   → 换域名毫无用处，必须换服务器地区或加国内中转
#
# 做法：连同一个 IP:443，只把 SNI（ClientHello 里的域名）换掉，看是否还被掐。
# 判据是【错误的种类】，不是"成不成功"——用别的 SNI 时服务器本来就没有对应证书，
# 握手失败是正常的，但那会是一个规规矩矩的 TLS 警报；被中间设备掐则是 TCP RST。
param(
  [string]$Domain   = 'niuma.tellgen.com',
  [string]$ServerIp = '47.86.27.60',
  # 对照服务器：用来验证"同一个 Host 字符串打到一台【无关】服务器是不是也被掐"。
  # 是 → 拦的一定是域名字符串本身（跟我们的服务器没关系）。默认取一台公网 HTTP 服务器。
  [string]$ControlIp = ''
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir ("SNI诊断日志-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".txt")
$script:logBuf = New-Object Text.StringBuilder
function Say([string]$msg, [string]$color = 'Gray') {
  Write-Host $msg -ForegroundColor $color
  [void]$script:logBuf.AppendLine($msg)
}

# 把一次 TLS 尝试归成四类之一：
#   ok    握手成功（拿到证书）
#   rst   连接被强行关闭（TCP RST）—— 中间设备干的，服务器不会这么回
#   alert 服务器正常回了 TLS 警报 / 证书对不上 —— 说明 ClientHello 确实到达了服务器
#   tcp   连 TCP 都没连上
function Probe-Tls([string]$connectHost, [string]$sniHost, [int]$timeoutMs = 8000) {
  $r = @{ kind = 'tcp'; ms = 0; err = '' }
  $c = New-Object Net.Sockets.TcpClient
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $ar = $c.BeginConnect($connectHost, 443, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($timeoutMs)) { $r.err = 'TCP 连接超时'; return $r }
    $c.EndConnect($ar)
    $c.ReceiveTimeout = $timeoutMs; $c.SendTimeout = $timeoutMs
    $ssl = New-Object Net.Security.SslStream($c.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($sniHost, $null, [Security.Authentication.SslProtocols]::Tls12, $false)
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    $r.kind = 'ok'; $r.ms = $sw.ElapsedMilliseconds; $r.cert = $cert.Subject
    return $r
  } catch {
    $m = $_.Exception.GetBaseException().Message
    $r.ms = $sw.ElapsedMilliseconds; $r.err = $m
    # WSAECONNRESET / 管道被掐 = RST；其余（证书、警报、格式错）说明服务器端在正常应答
    if ($m -match 'forcibly closed|existing connection|重置|连接已中止|was aborted') { $r.kind = 'rst' }
    else { $r.kind = 'alert' }
    return $r
  } finally { try { $c.Close() } catch {} }
}

# 明文 HTTP（80 端口）——Host 头里同样带域名。若 80 也被掐，说明黑名单是按域名匹配的，
# 且不止作用在 TLS 层；若 80 正常回 308（Caddy 跳 HTTPS），说明只有 TLS/SNI 那一层在拦。
function Probe-Http80([string]$connectHost, [string]$hostHeader, [int]$timeoutMs = 6000) {
  $r = @{ kind = 'tcp'; err = ''; status = '' }
  $c = New-Object Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect($connectHost, 80, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($timeoutMs)) { $r.err = 'TCP 连接超时'; return $r }
    $c.EndConnect($ar)
    $c.ReceiveTimeout = $timeoutMs; $c.SendTimeout = $timeoutMs
    $s = $c.GetStream()
    $req = "GET / HTTP/1.1`r`nHost: $hostHeader`r`nUser-Agent: sni-probe`r`nConnection: close`r`n`r`n"
    $b = [Text.Encoding]::ASCII.GetBytes($req)
    $s.Write($b, 0, $b.Length); $s.Flush()
    $buf = New-Object byte[] 1024
    $n = $s.Read($buf, 0, $buf.Length)
    if ($n -le 0) { $r.kind = 'rst'; $r.err = '连上但没有任何应答'; return $r }
    $head = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
    if ($head -match '^HTTP/1\.[01] (\d{3})') { $r.kind = 'ok'; $r.status = $Matches[1] }
    else { $r.kind = 'alert'; $r.err = '应答不是 HTTP' }
    return $r
  } catch {
    $m = $_.Exception.GetBaseException().Message
    $r.err = $m
    if ($m -match 'forcibly closed|existing connection|重置|连接已中止|was aborted') { $r.kind = 'rst' }
    return $r
  } finally { try { $c.Close() } catch {} }
}

$desc = @{ ok = '握手成功'; rst = '被强行掐断(RST)'; alert = '服务器正常应答(TLS警报/证书不符)'; tcp = 'TCP 就没连上' }

Say ("════════ SNI 归因诊断  " + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + " ════════") 'Cyan'
Say ("目标：" + $ServerIp + ":443   域名：" + $Domain)
$px = $null
try { $px = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop) } catch {}
if ($px -and $px.ProxyEnable -eq 1) { Say ("⚠ 系统代理已开启（" + $px.ProxyServer + "）——本脚本用裸 socket、不走代理，结论仍有效，但浏览器的表现可能不同") 'Yellow' }
else { Say "系统代理：未启用" }
Say ""

# ---- 第一组：同一个 IP，只换 SNI ----
Say "[A] 连 $ServerIp`:443，只把 ClientHello 里的域名(SNI)换掉：" 'White'
$cases = @(
  @{ sni = $Domain;             label = ('本域名  ' + $Domain) }
  @{ sni = 'www.microsoft.com'; label = '无关域名 www.microsoft.com' }
  @{ sni = 'a' + $Domain;       label = ('变形域名 a' + $Domain + '（只多一个字母）') }
  @{ sni = $ServerIp;           label = '不带域名（SNI 用 IP，等于不发 SNI）' }
)
$res = @{}
foreach ($c in $cases) {
  $p = Probe-Tls $ServerIp $c.sni
  $res[$c.sni] = $p
  $line = "    " + $c.label.PadRight(46) + " → " + $desc[$p.kind] + "  " + $p.ms + "ms"
  Say $line $(if ($p.kind -eq 'rst') { 'Red' } elseif ($p.kind -eq 'ok') { 'Green' } else { 'Yellow' })
  if ($p.err) { Say ("        " + $p.err) 'DarkGray' }
}
Say ""

# ---- 第二组：本域名重复三次，确认是否稳定复现（间歇性故障要排除）----
Say "[B] 本域名重复 3 次（看是不是每次必掐）：" 'White'
$rstCount = 0
for ($i = 1; $i -le 3; $i++) {
  $p = Probe-Tls $ServerIp $Domain
  if ($p.kind -eq 'rst') { $rstCount++ }
  Say ("    第 $i 次 → " + $desc[$p.kind] + "  " + $p.ms + "ms") $(if ($p.kind -eq 'rst') { 'Red' } else { 'Yellow' })
}
Say ""

# ---- 第三组：对照——本网络的 TLS 本身好不好 ----
Say "[C] 对照组（证明本网络的 HTTPS 本身是好的）：" 'White'
$ctl = Probe-Tls 'www.baidu.com' 'www.baidu.com'
Say ("    www.baidu.com:443".PadRight(50) + " → " + $desc[$ctl.kind] + "  " + $ctl.ms + "ms") $(if ($ctl.kind -eq 'ok') { 'Green' } else { 'Red' })
Say ""

# ---- 第四组：80 端口的 Host 头是否也被匹配 ----
# 【这组往往比 [A] 更灵敏】宽松些的网络只在明文层执行黑名单、TLS 还放行；这时 [A] 全绿、
# 只有这里会亮红。同时用"同主域的另一个子域"分辨黑名单的粒度：
#   兄弟子域也被掐 → 匹配的是【主域后缀】，换个子域没用，必须换主域
#   兄弟子域放行   → 只精确匹配这一个全名，换子域即可（但不建议赌，主域仍在名单里）
$rootDomain = $Domain
$parts = $Domain.Split('.')
if ($parts.Count -ge 2) { $rootDomain = $parts[-2] + '.' + $parts[-1] }
$sibling = 'zzztest.' + $rootDomain
Say "[D] 明文 HTTP 80（Host 头带域名，看黑名单是不是按域名匹配、匹配到哪一级）：" 'White'
$h1 = Probe-Http80 $ServerIp $Domain
$h3 = Probe-Http80 $ServerIp $sibling
$h2 = Probe-Http80 $ServerIp 'www.microsoft.com'
$fmt80 = { param($r) if ($r.kind -eq 'ok') { 'HTTP ' + $r.status } else { $desc[$r.kind] } }
Say ("    Host: $Domain".PadRight(50) + " → " + (& $fmt80 $h1)) $(if ($h1.kind -eq 'rst') { 'Red' } else { 'Gray' })
Say ("    Host: $sibling  (同主域的另一个子域)".PadRight(50) + " → " + (& $fmt80 $h3)) $(if ($h3.kind -eq 'rst') { 'Red' } else { 'Gray' })
Say ("    Host: www.microsoft.com  (无关域名，对照)".PadRight(50) + " → " + (& $fmt80 $h2)) 'Gray'
Say ""

# ---- 第五组：把同样的 Host 打到一台【无关服务器】----
# 这一组是"跟我们服务器无关"的铁证：如果连别人家的服务器都因为这个 Host 被掐，
# 那拦截依据只可能是域名字符串，换服务器/换 IP 全都白搭，只能换域名。
Say "[E] 同样的 Host 打到一台无关服务器（排除是我们服务器自己的问题）：" 'White'
# 对照服务器【必须选一台在本网络里稳定可达的】：早先用 example.com，它是 Cloudflare 任播、
# 每次解析到的 IP 不同且国内常被重置，两个 Host 一起挂 → 这组白做。改用百度：境内直连、
# 对任何 Host 都会给个 HTTP 应答，能干净地把"域名字符串"这个变量单独拎出来。
$ctlIp = $ControlIp
$ctlName = 'www.baidu.com'
if (-not $ctlIp) {
  try { $ctlIp = (Resolve-DnsName $ctlName -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress } catch { $ctlIp = '' }
}
$e1 = $null; $e2 = $null
if ($ctlIp) {
  Say ("    对照服务器：" + $ctlIp + "（$ctlName）") 'DarkGray'
  $e1 = Probe-Http80 $ctlIp $Domain
  $e2 = Probe-Http80 $ctlIp $ctlName
  Say ("    Host: $Domain".PadRight(50) + " → " + (& $fmt80 $e1)) $(if ($e1.kind -eq 'rst') { 'Red' } else { 'Gray' })
  Say ("    Host: $ctlName".PadRight(50) + " → " + (& $fmt80 $e2)) 'Gray'
  if ($e2.kind -ne 'ok') { Say "    （对照 Host 自己就不通，这组作废——换 -ControlIp 指一台确定可达的服务器）" 'DarkGray' }
} else { Say "    （解析不到对照服务器，跳过这组）" 'DarkGray' }
Say ""

# ---- 结论 ----
Say "──────── 结论 ────────" 'Cyan'
$mine  = $res[$Domain].kind
$other = $res['www.microsoft.com'].kind
$noSni = $res[$ServerIp].kind
$variant = $res['a' + $Domain].kind

# 判定优先级：先看"最硬"的证据。
# 【要点】域名被拦【不一定】表现在 TLS 上 —— 宽松些的网络只在明文 HTTP 层执行（[D]），
# 严的网络才连 SNI 一起匹配（[A]）。所以只要 [D] 或 [E] 命中，即便 TLS 这次全通，
# 结论一样成立。早先版本只看 [A]，在"只有 80 被拦"的网络上会误报"没能复现"。
$dnsHit  = ($e1 -and $e1.kind -eq 'rst' -and $e2 -and $e2.kind -ne 'rst')   # 打无关服务器也被掐 = 铁证
$http80  = ($h1.kind -eq 'rst' -and $h2.kind -ne 'rst')                     # 明文层按域名匹配
$sniHit  = ($mine -eq 'rst' -and ($other -ne 'rst' -or $noSni -ne 'rst'))   # TLS 层按 SNI 匹配
$allDead = ($mine -eq 'rst' -and $other -eq 'rst' -and $noSni -eq 'rst')    # 什么 SNI 都掐 = 冲着 IP 来的

if ($ctl.kind -ne 'ok') {
  Say "本网络连百度的 HTTPS 都握不上手，先解决通用网络问题，本次结论不可用。" 'Yellow'
}
elseif ($dnsHit -or $http80 -or $sniHit) {
  Say "拦的是【域名】：拦截依据是 $Domain 这串字符，跟服务器 IP 无关。" 'Red'
  if ($dnsHit)  { Say "  · 铁证：同样的 Host 打到一台【无关服务器】($ctlIp) 也被掐，而换个 Host 就正常。" }
  if ($http80)  { Say "  · 明文 HTTP(80) 层按域名匹配：带本域名的 Host 被掐，别的 Host 正常 308。" }
  if ($sniHit)  { Say "  · TLS 层按 SNI 匹配：同一 IP:443，只换 SNI 就不掐了（这就是浏览器打不开的直接原因）。" }
  if (-not $sniHit -and $mine -ne 'rst') {
    Say "  · 注意：本网络【只】在明文层执行，TLS 还放行 —— 所以你这台机器现在可能还能正常用。" 'Yellow'
    Say "    更严的网络（带审计的单位网）会连 SNI 一起匹配，那边就彻底打不开。" 'Yellow'
  }
  # 黑名单粒度：优先看【实际亮红的那一层】的兄弟子域结果，别拿没被拦的层去推断
  if ($http80) {
    if ($h3.kind -eq 'rst') { Say "  · 粒度：同主域的另一个子域($sibling)照样被掐 → 匹配的是【主域 $rootDomain】，换子域没用，必须换主域。" 'Yellow' }
    else { Say "  · 粒度：同主域的另一个子域($sibling)放行 → 只精确匹配 $Domain 这一个全名。" }
  }
  elseif ($sniHit) {
    Say ("  · 粒度（TLS 层）：变形域名 a$Domain " + $desc[$variant] + $(if ($variant -ne 'rst') { " → 只精确匹配这一个全名" } else { " → 匹配的是主域后缀，换子域没用" }))
  }
  Say "→ 解法：换一个自有域名（DNS A 记录 + Caddyfile + 客户端接入地址），服务器不用动。" 'Green'
  Say "→ 过渡期让新旧域名并存：Caddyfile 站点地址写成「旧域名, 新域名 {」，老客户端不断线。" 'Green'
}
elseif ($allDead) {
  Say "拦的是【IP / 这条线路】：任何 SNI 打到 $ServerIp`:443 都被掐。" 'Red'
  Say "→ 换域名【无效】。要么换服务器地区（国内节点需备案），要么在国内加一台中转机反代过去。" 'Red'
}
elseif ($rstCount -gt 0) {
  Say "本域名 3 次里有 $rstCount 次被掐，但对照组没规律 —— 像是间歇性干扰或线路抖动。" 'Yellow'
  Say "请在【故障复现的那一刻】重跑一次，拿到稳定的一组再下结论。" 'Yellow'
}
else {
  Say "本次全通，没有发现按域名或按 IP 的拦截。" 'Green'
  Say "若用户仍报「打不开」，那多半不在网络层（看浏览器代理设置、客户端里写死的旧地址、或应用侧报错）。" 'Yellow'
}

Say ""
try { [IO.File]::WriteAllText($logPath, $script:logBuf.ToString(), (New-Object Text.UTF8Encoding($true))) ; Say ("日志已保存：" + $logPath) 'Cyan' } catch { Say ("日志保存失败：" + $_.Exception.Message) 'Yellow' }
