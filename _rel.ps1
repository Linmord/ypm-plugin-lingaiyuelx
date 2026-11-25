$payload = "protocol=https`nhost=github.com`n`n"
$out = $payload | git credential fill 2>&1
$tok = ($out | Select-String -Pattern '^password=(.*)$').Matches.Groups[1].Value
$gh = @{ 'User-Agent'='dsh'; 'Authorization'='Bearer ' + $tok; 'Accept'='application/vnd.github+json' }
Set-Location 'D:\AI work\_repos\ypm-plugin-multisource'
git add -A 2>&1 | Out-Null
git -c user.name="Linmord" -c user.email="linmord@users.noreply.github.com" commit -m "v0.2.3：首页喜欢的音乐卡片动态封面 + 上游进度说明" 2>&1 | Select-Object -First 2
git push 2>&1 | Out-Null
git tag v0.2.3 2>&1 | Out-Null
git push origin v0.2.3 2>&1 | Out-Null
Write-Output 'tag 已推'
$notes = [System.IO.File]::ReadAllText('D:\AI work\_repos\ypm-plugin-multisource\_rel.md', [System.Text.Encoding]::UTF8)
$body = @{ tag_name='v0.2.3'; name='v0.2.3'; body=$notes; draft=$false; prerelease=$false } | ConvertTo-Json -Depth 3
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
$rel = Invoke-RestMethod -Uri 'https://api.github.com/repos/Linmord/ypm-plugin-lingaiyuelx/releases' -Method Post -Headers $gh -Body $bytes -ContentType 'application/json; charset=utf-8' -TimeoutSec 30
Write-Output ('Release: ' + $rel.tag_name)
$up = $rel.upload_url -replace '\{.*\}',''
$zip = Get-Item 'D:\AI work\_repos\ypm-plugin-multisource\dist\YesPlayMusic-multisource-0.2.3.zip'
$h2 = @{ 'User-Agent'='dsh'; 'Authorization'='Bearer ' + $tok; 'Content-Type'='application/zip' }
$a = Invoke-RestMethod -Uri ($up + '?name=' + $zip.Name) -Method Post -Headers $h2 -InFile $zip.FullName -TimeoutSec 180
Write-Output ('上传: ' + [math]::Round($a.size/1KB,0) + ' KB')
Remove-Item 'D:\AI work\_repos\ypm-plugin-multisource\_rel.md','D:\AI work\_repos\ypm-plugin-multisource\_rel.ps1' -Force -ErrorAction SilentlyContinue