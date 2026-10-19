# 설치 파일에 함께 넣을 git(MinGit)을 받아 build/win-git/mingit 에 푼다(npm run build:native:win 이 부른다).
# 로컬 터미널(cmd·PowerShell)에서 git을 PC에 따로 설치하지 않아도 쓰게 하려는 것이다. MinGit은 Git for Windows가 다른 앱에
# 넣어 배포하라고 내는 최소 패키지(git + 필요한 ssh/curl, Git Bash 없음)라 PortableGit보다 훨씬 작다.
# 버전과 SHA256을 고정해 두고, 받은 파일의 해시가 다르면 멈춘다. 같은 버전이 이미 풀려 있으면 다시 받지 않는다.
$ErrorActionPreference = 'Stop'

$Version = '2.56.0.2'
$Tag     = 'v2.56.0.windows.2'
$Sha256  = 'da35e72aa21c005a5a0d298cfbae110bc1609a815730ea0dde84b01a1b3cd3be'
$Url     = "https://github.com/git-for-windows/git/releases/download/$Tag/MinGit-$Version-64-bit.zip"

$Root  = (Resolve-Path "$PSScriptRoot\..\..").Path
$Work  = "$Root\build\win-git"
$Dest  = "$Work\mingit"
$Stamp = "$Dest\.onegyeok-mingit-version"

if ((Test-Path $Stamp) -and ((Get-Content $Stamp -Raw).Trim() -eq $Version) -and (Test-Path "$Dest\cmd\git.exe")) {
  Write-Host "== MinGit $Version (이미 있음)"
  return
}

Write-Host "== MinGit $Version 받는 중"
New-Item -ItemType Directory -Force $Work | Out-Null
$Zip = "$Work\MinGit-$Version-64-bit.zip"
if (-not (Test-Path $Zip) -or ((Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower() -ne $Sha256)) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
}
$Actual = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
if ($Actual -ne $Sha256) {
  Remove-Item -Force $Zip
  throw "MinGit 해시가 다릅니다: $Actual (기대값 $Sha256)"
}

Remove-Item -Recurse -Force $Dest -ErrorAction SilentlyContinue
Expand-Archive -Path $Zip -DestinationPath $Dest
if (-not (Test-Path "$Dest\cmd\git.exe")) { throw "$Dest\cmd\git.exe 가 없습니다." }
Set-Content -Path $Stamp -Value $Version -Encoding ascii
Write-Host "OK: $Dest"
