$payload = "protocol=https`nhost=github.com`n`n"
$out = $payload | git credential fill 2>&1
$tok = ($out | Select-String -Pattern '^password=(.*)$').Matches.Groups[1].Value
$gh = @{ 'User-Agent'='dsh'; 'Authorization'='Bearer ' + $tok; 'Accept'='application/vnd.github+json' }

Write-Output '--- delete old repo ---'
try {
  Invoke-RestMethod -Uri 'https://api.github.com/repos/Linmord/ypm-plugin-lingaiyue' -Method Delete -Headers $gh -TimeoutSec 30 | Out-Null
  Write-Output '  deleted'
} catch {
  Write-Output ('  FAIL: ' + $_.Exception.Message)
  Write-Output $_.ErrorDetails.Message
}

Start-Sleep -Seconds 3

Write-Output '--- confirm deleted ---'
try {
  Invoke-RestMethod -Uri 'https://api.github.com/repos/Linmord/ypm-plugin-lingaiyue' -Headers $gh -TimeoutSec 20 | Out-Null
  Write-Output '  still exists'
} catch { Write-Output '  gone (404)' }

Write-Output '--- create new repo ---'
$json = '{"name":"ypm-plugin-lingaiyuelx","description":"小林的音源扩展 - YesPlayMusic 插件：多平台用户数据 + 三方音源","private":false,"has_issues":true,"has_wiki":false}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
try {
  $repo = Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post -Headers $gh -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
  Write-Output ('  created: ' + $repo.full_name)
} catch {
  Write-Output ('  FAIL: ' + $_.Exception.Message)
  Write-Output $_.ErrorDetails.Message
}