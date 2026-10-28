# Windows 배포용 네이티브 헬퍼(onegyeok-rdp-helper.exe / onegyeok-vnc-helper.exe)를 빌드한다(npm run build:native:win).
# 의존성(build/win-deps/prefix)이 없으면 먼저 build-native-deps.ps1로 만든다. 산출물은 native/*-helper/ 바로 아래에 생긴다.
$ErrorActionPreference = 'Stop'

$Root   = (Resolve-Path "$PSScriptRoot\..\..").Path
$Prefix = "$Root\build\win-deps\prefix"

& "$PSScriptRoot\build-native-deps.ps1"
. "$PSScriptRoot\msvc-env.ps1"

$PrefixFwd = $Prefix -replace '\\', '/'
foreach ($h in 'rdp-helper', 'vnc-helper') {
  Write-Host "== $h"
  $dir = "$Root\native\$h"
  $build = "$dir\build"
  Remove-Item -Recurse -Force $build -ErrorAction SilentlyContinue
  Invoke-Native cmake @('-S', $dir, '-B', $build, '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release',
    "-DDEPS_PREFIX=$PrefixFwd", '-DCMAKE_C_COMPILER=cl', "-DCMAKE_MAKE_PROGRAM=$((Get-Command ninja).Source -replace '\\', '/')")
  Invoke-Native cmake @('--build', $build)
  if (-not (Test-Path "$dir\onegyeok-$h.exe")) { throw "$dir\onegyeok-$h.exe 가 생성되지 않았습니다." }
}
Write-Host 'OK: native/rdp-helper/onegyeok-rdp-helper.exe, native/vnc-helper/onegyeok-vnc-helper.exe'

# 설치 파일에 같이 넣는 git(로컬 터미널용) — package.json build.win.extraResources 가 build/win-git/mingit 을 resources/git 으로 넣는다.
& "$PSScriptRoot\fetch-mingit.ps1"
