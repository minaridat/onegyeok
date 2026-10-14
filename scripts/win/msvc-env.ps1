# scripts/win/*.ps1 공통: MSVC x64 빌드 환경(vcvars64)과 빌드 도구 PATH를 현재 프로세스에 준비한다(dot-source해서 쓴다).
$ErrorActionPreference = 'Stop'

# --- 도구 경로: winget 설치 직후 셸에 PATH가 반영되지 않았을 수 있어 기본 설치 위치를 앞에 둔다.
$extra = @("$env:ProgramFiles\CMake\bin", "$env:ProgramFiles\NASM", "$env:LOCALAPPDATA\bin\NASM",
           "C:\Strawberry\perl\bin") +
         (Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages" -Directory -Filter 'Ninja-build.Ninja*' -ErrorAction SilentlyContinue | ForEach-Object FullName)
$env:PATH = (($extra | Where-Object { Test-Path $_ }) -join ';') + ';' + $env:PATH

# --- MSVC x64 환경(vcvars64)을 현재 프로세스로 가져온다.
if (-not (Get-Command cl.exe -ErrorAction SilentlyContinue)) {
  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  $vs = & $vswhere -latest -prerelease -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
  $vcvars = "$vs\VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path $vcvars)) { throw "vcvars64.bat 없음: Visual Studio C++ 빌드 도구를 설치하세요." }
  # vcvars는 내부에서 vswhere.exe를 PATH로 찾는다(없으면 stderr 경고 → PowerShell 5.1이 오류로 취급).
  $env:PATH = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer;$env:PATH"
  cmd /c "`"$vcvars`" >nul 2>nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2]) }
  }
}
foreach ($t in 'cl', 'cmake', 'ninja', 'perl', 'nasm', 'git') {
  if (-not (Get-Command $t -ErrorAction SilentlyContinue)) { throw "$t 를 찾을 수 없습니다." }
}
# Strawberry Perl의 c\bin(gcc 등)이 CMake의 컴파일러/라이브러리 탐색에 끼지 않도록 perl.exe만 쓰게 PATH에서 뺀다.
$env:PATH = ($env:PATH -split ';' | Where-Object { $_ -notlike 'C:\Strawberry\c\bin*' }) -join ';'

function Invoke-Native { # 네이티브 명령 실패 시 즉시 중단
  param([string]$Exe, [string[]]$ArgList)
  & $Exe @ArgList
  if ($LASTEXITCODE -ne 0) { throw "$Exe 실패 (exit $LASTEXITCODE)" }
}

