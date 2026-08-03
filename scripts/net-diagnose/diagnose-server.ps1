# 一键网络诊断 —— 排查「连不上服务器 / 登录异常」到底卡在哪一层
# 用法：双击同目录《一键网络诊断.bat》。结果打印在窗口里，同时保存为同目录
# 《网络诊断日志-时间.txt》，用户把这个文件发给管理员即可远程定位问题。
# 分层思路：本机网关 → 外网 → DNS(系统+公共对照) → 直连IP:443(绕开DNS) → TLS证书 → HTTP。
# 每层只依赖上一层，第一处断掉的层就是结论。
param(
  [string]$Domain   = 'weigu.duckdns.org',
  # 服务器公网 IP：用来绕开域名解析直测线路（duckdns 在部分国内网络会被污染/阻断，
  # 不能拿它当唯一入口）。服务器迁移换 IP 后这里要同步改。
  [string]$ServerIp = '47.86.27.60'
)
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir ("网络诊断日志-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + ".txt")
$script:logBuf = New-Object Text.StringBuilder
function Say([string]$msg, [string]$color = 'Gray') {
  Write-Host $msg -ForegroundColor $color
  [void]$script:logBuf.AppendLine($msg)
}

# TCP 连接测试（带超时与耗时）。返回 @{ok; ms; err}
function Test-Tcp([string]$target, [int]$port, [int]$timeoutMs = 5000) {
  $c = New-Object Net.Sockets.TcpClient
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $ar = $c.BeginConnect($target, $port, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($timeoutMs)) { return @{ ok = $false; err = ('超时(>' + $timeoutMs + 'ms)') } }
    $c.EndConnect($ar)
    return @{ ok = $true; ms = $sw.ElapsedMilliseconds }
  } catch { return @{ ok = $false; err = $_.Exception.GetBaseException().Message } }
  finally { try { $c.Close() } catch {} }
}

# TLS 握手 + 发一个真实 GET /，返回证书信息与 HTTP 状态码。
# connectHost 可以传 IP（SNI 用域名）——这样 DNS 坏了也能测到服务器本身好不好。
# 证书校验回调恒 true：这里是「诊断」，要拿到劫持者的假证书来看，而不是直接抛异常。
# 探测路径用 /captcha：manager 直出 200（不唤醒用户容器、不经反代上游），是「服务活着」的最硬证据；
# 裸 / 在部分版本回 404，不能当健康探针。
$probePath = '/captcha'
function Probe-Https([string]$connectHost, [string]$sniHost, [int]$timeoutMs = 8000) {
  $r = @{ ok = $false }
  $c = New-Object Net.Sockets.TcpClient
  try {
    $ar = $c.BeginConnect($connectHost, 443, $null, $null)
    if (-not $ar.AsyncWaitHandle.WaitOne($timeoutMs)) { $r.err = 'TCP 连接超时'; return $r }
    $c.EndConnect($ar)
    $c.ReceiveTimeout = $timeoutMs; $c.SendTimeout = $timeoutMs
    $ssl = New-Object Net.Security.SslStream($c.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($sniHost, $null, [Security.Authentication.SslProtocols]::Tls12, $false)
    $cert = New-Object Security.Cryptography.X509Certificates.X509Certificate2($ssl.RemoteCertificate)
    $r.certSubject = $cert.Subject; $r.certIssuer = $cert.Issuer; $r.certExpiry = $cert.NotAfter
    $san = ($cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' } | ForEach-Object { $_.Format($false) }) -join ' '
    $r.certMatch = (($cert.Subject -like ('*' + $sniHost + '*')) -or ($san -like ('*' + $sniHost + '*')))
    $req = "GET $script:probePath HTTP/1.1`r`nHost: $sniHost`r`nUser-Agent: net-diagnose`r`nConnection: close`r`n`r`n"
    $bytes = [Text.Encoding]::ASCII.GetBytes($req)
    $ssl.Write($bytes, 0, $bytes.Length); $ssl.Flush()
    $buf = New-Object byte[] 4096
    $n = $ssl.Read($buf, 0, $buf.Length)
    if ($n -gt 0) {
      $head = [Text.Encoding]::ASCII.GetString($buf, 0, $n)
      if ($head -match 'HTTP/[\d.]+\s+(\d{3})') { $r.httpStatus = [int]$Matches[1] }
    }
    $r.ok = $true
  } catch { $r.err = $_.Exception.GetBaseException().Message }
  finally { try { $c.Close() } catch {} }
  return $r
}

# 用指定 DNS 服务器解析域名。返回 @{ok; ips; err}
function Resolve-Via([string]$name, [string]$server) {
  try {
    if ($server) { $ans = Resolve-DnsName -Name $name -Type A -Server $server -DnsOnly -ErrorAction Stop }
    else { return @{ ok = $true; ips = @([Net.Dns]::GetHostAddresses($name) | Where-Object { $_.AddressFamily -eq 'InterNetwork' } | ForEach-Object { $_.IPAddressToString }) } }
    return @{ ok = $true; ips = @($ans | Where-Object { $_.Type -eq 'A' } | ForEach-Object { $_.IPAddress }) }
  } catch { return @{ ok = $false; err = $_.Exception.GetBaseException().Message } }
}

Say ('════════ 服务器连接诊断  ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ════════') 'Cyan'
Say ('目标：https://' + $Domain + '/   (服务器 IP ' + $ServerIp + ')')
try { Say ('系统：' + [Environment]::OSVersion.VersionString + '  PowerShell ' + $PSVersionTable.PSVersion) } catch {}
try {
  $dnsServers = (Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.ServerAddresses } | ForEach-Object { $_.ServerAddresses }) | Select-Object -Unique
  Say ('本机 DNS 服务器：' + ($dnsServers -join ', '))
} catch {}
try {
  $px = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
  if ($px.ProxyEnable -eq 1) { Say ('⚠ 检测到系统代理已开启：' + $px.ProxyServer + '（代理故障也会导致连不上，建议关掉代理重试）') 'Yellow' }
  else { Say '系统代理：未启用' }
} catch {}
Say ''

# ---- 第 1 层：本机 → 路由器 ----
$gwOk = $false; $gw = $null
try { $gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Sort-Object RouteMetric | Select-Object -First 1).NextHop } catch {}
if ($gw) {
  $gwOk = Test-Connection -ComputerName $gw -Count 1 -Quiet -ErrorAction SilentlyContinue
  if ($gwOk) { Say ('[1/6] 本机 → 路由器(' + $gw + ')          通 ✓') 'Green' } else { Say ('[1/6] 本机 → 路由器(' + $gw + ')          不通 ✗') 'Red' }
} else { Say '[1/6] 未找到默认网关（可能没连 WiFi/网线）✗' 'Red' }

# ---- 第 2 层：外网连通（拿 baidu 443 当参照物）----
$inet = Test-Tcp 'www.baidu.com' 443
if ($inet.ok) { Say ('[2/6] 外网连通(baidu:443)               通 ✓  ' + $inet.ms + 'ms') 'Green' } else { Say ('[2/6] 外网连通(baidu:443)               不通 ✗  ' + $inet.err) 'Red' }

# ---- 第 3 层：DNS 解析（系统 DNS 与公共 DNS 对照，专抓污染/阻断）----
$dnsSys = Resolve-Via $Domain $null
$dnsAli = Resolve-Via $Domain '223.5.5.5'
$dnsTx  = Resolve-Via $Domain '119.29.29.29'
foreach ($t in @(@('系统DNS', $dnsSys), @('阿里DNS 223.5.5.5', $dnsAli), @('腾讯DNS 119.29.29.29', $dnsTx))) {
  $name = $t[0]; $d = $t[1]
  if ($d.ok -and $d.ips.Count -gt 0) {
    if ($d.ips -contains $ServerIp) { Say ('[3/6] DNS 解析(' + $name + ')  → ' + ($d.ips -join ',') + '  正确 ✓') 'Green' }
    else { Say ('[3/6] DNS 解析(' + $name + ')  → ' + ($d.ips -join ',') + '  ⚠ 与服务器 IP 不符（疑似污染，或服务器已迁移）') 'Yellow' }
  } else { Say ('[3/6] DNS 解析(' + $name + ')  失败 ✗  ' + $d.err) 'Red' }
}
$dnsSysGood = ($dnsSys.ok -and ($dnsSys.ips -contains $ServerIp))
$dnsAnyGood = ($dnsSysGood -or ($dnsAli.ok -and ($dnsAli.ips -contains $ServerIp)) -or ($dnsTx.ok -and ($dnsTx.ips -contains $ServerIp)))

# ---- 第 4 层：直连服务器 IP:443（绕开 DNS，测线路本身）----
$tcpIp = Test-Tcp $ServerIp 443
if ($tcpIp.ok) { Say ('[4/6] 直连服务器 ' + $ServerIp + ':443       通 ✓  ' + $tcpIp.ms + 'ms') 'Green' } else { Say ('[4/6] 直连服务器 ' + $ServerIp + ':443       不通 ✗  ' + $tcpIp.err) 'Red' }

# ---- 第 5 层：TLS 证书 + HTTP（仍按 IP 直连，DNS 坏了也能测）----
$probeIp = @{ ok = $false }
if ($tcpIp.ok) {
  $probeIp = Probe-Https $ServerIp $Domain
  if ($probeIp.ok) {
    $certLine = '[5/6] TLS 证书  ' + $probeIp.certSubject + '  到期 ' + $probeIp.certExpiry.ToString('yyyy-MM-dd')
    if ($probeIp.certMatch) { Say ($certLine + '  匹配 ✓') 'Green' } else { Say ($certLine + '  ⚠ 证书与域名不符（HTTPS 疑似被劫持）') 'Red' }
    if ($probeIp.httpStatus) { Say ('[5/6] HTTP 应答(直连IP ' + $probePath + ')  状态码 ' + $probeIp.httpStatus) $(if ($probeIp.httpStatus -lt 500) { 'Green' } else { 'Red' }) }
  } else { Say ('[5/6] TLS 握手失败 ✗  ' + $probeIp.err) 'Red' }
} else { Say '[5/6] TLS/HTTP  跳过（上一步 443 不通）' 'DarkGray' }

# ---- 第 6 层：走域名的完整链路（用户浏览器实际走的路）----
$probeDom = @{ ok = $false }
if ($dnsSys.ok -and $dnsSys.ips.Count -gt 0) {
  $probeDom = Probe-Https $Domain $Domain
  if ($probeDom.ok -and $probeDom.httpStatus) { Say ('[6/6] 完整链路 https://' + $Domain + $probePath + '  状态码 ' + $probeDom.httpStatus) $(if ($probeDom.httpStatus -lt 500) { 'Green' } else { 'Red' }) }
  elseif ($probeDom.ok) { Say ('[6/6] 完整链路  TLS 通但未读到 HTTP 应答 ⚠') 'Yellow' }
  else { Say ('[6/6] 完整链路失败 ✗  ' + $probeDom.err) 'Red' }
} else { Say '[6/6] 完整链路  跳过（系统 DNS 解析不出域名）' 'DarkGray' }

# ---- 结论：第一处断掉的层即病因 ----
Say ''
Say '──────── 诊断结论 ────────' 'Cyan'
if (-not $gwOk) {
  Say '本机没连上路由器/WiFi。请检查 WiFi 或网线，连上后重跑本诊断。' 'Yellow'
} elseif (-not $inet.ok) {
  Say '能连路由器但上不了外网。请检查宽带是否欠费/掉线，或找单位网管。' 'Yellow'
} elseif (-not $tcpIp.ok) {
  Say '外网正常，但到服务器的 443 端口不通。可能原因：' 'Yellow'
  Say '  ① 服务器宕机或云防火墙拦截 —— 让管理员检查服务器状态；'
  Say '  ② 你所在网络对该 IP/端口有封锁（单位防火墙、地区线路）；'
  Say '  ③ 本单位出口 IP 被服务器防护临时封禁（密码连错 5 次会封整个出口 IP 1 小时，全单位共用出口时会被连坐）。'
  Say '  快速区分：用手机开热点、电脑连热点后重跑本诊断——热点能通，就是 ②③（本地网络或封禁）；热点也不通，就是 ①（服务器侧）。'
} elseif (-not $probeIp.ok) {
  Say '443 端口通，但 TLS 握手失败——网络中间设备在干扰 HTTPS（常见于带审计的单位网络）。把日志发管理员，并尝试换网络验证。' 'Yellow'
} elseif (-not $probeIp.certMatch) {
  Say '服务器证书与域名不符——HTTPS 疑似被劫持（或服务器证书配置异常）。不要在此网络输入密码，把日志发管理员。' 'Red'
} elseif ($probeIp.httpStatus -ge 500) {
  Say ('服务器返回 ' + $probeIp.httpStatus + '——网络没问题，是服务器端故障。把本日志发给管理员。') 'Yellow'
} elseif (-not $dnsAnyGood) {
  Say '服务器本身正常，但域名解析全失败——duckdns 域名在当前网络被阻断（部分网络常见）。' 'Yellow'
  Say ('解决：管理员指导修改 hosts 文件，加一行：  ' + $ServerIp + '  ' + $Domain)
  Say '（hosts 位于 C:\Windows\System32\drivers\etc\hosts，需管理员权限编辑；或把本机 DNS 改为 223.5.5.5 后重试）'
} elseif (-not $dnsSysGood) {
  Say '公共 DNS 能正确解析、系统 DNS 不行——本机/路由器的 DNS 有问题或被污染。' 'Yellow'
  Say ('解决：把网卡 DNS 改为 223.5.5.5；或改 hosts 加一行：  ' + $ServerIp + '  ' + $Domain)
} elseif ($dnsSys.ok -and ($dnsSys.ips.Count -gt 0) -and (-not $probeDom.ok)) {
  Say '直连 IP 一切正常，但走域名的完整链路失败——域名流量在当前网络被干扰。' 'Yellow'
  Say ('解决：改 hosts 加一行：  ' + $ServerIp + '  ' + $Domain + '  （改完重跑本诊断确认）')
} else {
  Say '网络与服务器全部正常 ✓' 'Green'
  Say '如果登录仍提示错误：先刷新页面重试一次；再确认账号密码大小写；若提示「尝试次数过多」请按提示等待。仍不行就把本日志+报错截图发给管理员。'
}
Say ''

# 日志落盘（UTF-8 BOM，记事本双击打开不乱码）
[IO.File]::WriteAllText($logPath, $script:logBuf.ToString(), (New-Object Text.UTF8Encoding($true)))
Say ('诊断日志已保存：' + $logPath) 'Cyan'
Say '把上面这个 txt 文件发给管理员，即可远程定位问题。'
