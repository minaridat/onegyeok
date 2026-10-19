# Windows 배포용 네이티브 헬퍼 의존성(OpenSSL/zlib/FreeRDP/libvncclient)을 소스에서 정적(x64, /MT)으로 빌드한다.
# macOS의 scripts/mac/build-native-deps.sh와 같은 버전·같은 최소 구성(FreeRDP 채널 drdynvc+disp만)을 쓴다.
# 사용자 PC에 VC 런타임/vcpkg 없이 헬퍼 .exe 하나로 돌게 하려는 것이므로 모든 라이브러리를 정적 CRT로 맞춘다.
# 결과물: build/win-deps/prefix (정적 .lib + CMake 패키지) — native/*/CMakeLists.txt가 DEPS_PREFIX로 사용.
#
# 사전 준비(빌드 머신에만 필요): Visual Studio Build Tools(C++ 워크로드 + Windows SDK), CMake, Ninja,
#   Strawberry Perl, NASM, Git.  예) winget install Kitware.CMake Ninja-build.Ninja StrawberryPerl.StrawberryPerl NASM.NASM
$ErrorActionPreference = 'Stop'

$Root   = (Resolve-Path "$PSScriptRoot\..\..").Path
$Work   = "$Root\build\win-deps"
$Prefix = "$Work\prefix"
$Src    = "$Work\src"
$Jobs   = $env:NUMBER_OF_PROCESSORS

$OPENSSL_TAG = 'openssl-3.5.9'
$ZLIB_TAG    = 'v1.3.1'
$FREERDP_TAG = '3.32.1'
$LIBVNC_TAG  = 'LibVNCServer-0.9.15'

New-Item -ItemType Directory -Force $Src, $Prefix | Out-Null

. "$PSScriptRoot\msvc-env.ps1"

function Get-Source($url, $tag, $dir) {
  if (-not (Test-Path "$Src\$dir")) { Invoke-Native git @('clone', '-q', '--depth', '1', '--branch', $tag, $url, "$Src\$dir") }
}

$NinjaExe = (Get-Command ninja).Source -replace '\\', '/'
# 호스트에 깔린 다른 라이브러리(Chocolatey/MSYS/Strawberry 등)를 줍지 않도록 prefix만 보게 한다.
$PrefixFwd = $Prefix -replace '\\', '/'
$CommonCMake = @('-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release', "-DCMAKE_INSTALL_PREFIX=$PrefixFwd",
  "-DCMAKE_PREFIX_PATH=$PrefixFwd", "-DCMAKE_MAKE_PROGRAM=$NinjaExe",
  '-DCMAKE_IGNORE_PREFIX_PATH=C:/Strawberry/c;C:/msys64;C:/ProgramData/chocolatey',
  '-DBUILD_SHARED_LIBS=OFF', '-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded',
  '-DCMAKE_POLICY_VERSION_MINIMUM=3.5', '-DCMAKE_C_COMPILER=cl', '-DCMAKE_CXX_COMPILER=cl')

Write-Host "== OpenSSL $OPENSSL_TAG"
if (-not (Test-Path "$Prefix\lib\libssl.lib")) {
  Get-Source https://github.com/openssl/openssl $OPENSSL_TAG openssl
  Push-Location "$Src\openssl"
  try {
    # no-shared이면 OpenSSL은 /MT(정적 CRT)로 빌드한다.
    # no-module: legacy provider를 libcrypto 안에 넣는다. 이게 없으면 legacy가 별도 legacy.dll 모듈로 빠져서
    # libvncclient의 VNC 비밀번호 인증(DES, OSSL_PROVIDER_load("legacy"))이 실패한다.
    Invoke-Native perl @('Configure', 'VC-WIN64A', 'no-shared', 'no-module', 'no-tests', 'no-apps', 'no-docs',
      "--prefix=$Prefix", "--openssldir=$Prefix\ssl", '--libdir=lib')
    Invoke-Native nmake @('/nologo', 'build_libs')
    Invoke-Native nmake @('/nologo', 'install_dev')
  } finally { Pop-Location }
}

Write-Host "== zlib $ZLIB_TAG"
if (-not (Test-Path "$Prefix\lib\zlibstatic.lib")) {
  Get-Source https://github.com/madler/zlib $ZLIB_TAG zlib
  Invoke-Native cmake (@('-S', "$Src\zlib", '-B', "$Work\zlib-build") + $CommonCMake + @('-DZLIB_BUILD_EXAMPLES=OFF'))
  Invoke-Native cmake @('--build', "$Work\zlib-build", '-j', $Jobs)
  Invoke-Native cmake @('--install', "$Work\zlib-build")
}
# zlib은 정적/동적을 둘 다 설치하므로 정적 라이브러리를 명시한다.
$ZlibCMake = @("-DZLIB_INCLUDE_DIR=$PrefixFwd/include", "-DZLIB_LIBRARY=$PrefixFwd/lib/zlibstatic.lib")
$OpenSSLCMake = @("-DOPENSSL_ROOT_DIR=$PrefixFwd", '-DOPENSSL_USE_STATIC_LIBS=ON', '-DOPENSSL_MSVC_STATIC_RT=ON')

# 클라이언트 채널: 동적 해상도(화면 크기 조절)용 drdynvc + disp, 클립보드 공유용 cliprdr, 로컬 폴더(드라이브) 공유용 rdpdr + drive(+ rdpsnd)만 켜고
# 나머지는 끈다. 헬퍼는 채널이 빌드에 들어 있는지 실행 중에 확인하므로, 이 채널이 없는 빌드(현재 macOS)에서도 접속은 된다.
$channelFlags = @()
foreach ($ch in 'AINPUT AUDIN ECHO ENCOMSP GEOMETRY LOCATION PARALLEL PRINTER RAIL RDP2TCP RDPEAR RDPECAM RDPEI RDPEMSC RDPEWA RDPGFX REMDESK SERIAL SMARTCARD SSHAGENT TELEMETRY TSMF URBDRC VIDEO GFXREDIR'.Split(' ')) {
  $channelFlags += "-DCHANNEL_$ch=OFF"
}
$channelFlags += '-DCHANNEL_DRDYNVC=ON', '-DCHANNEL_DISP=ON', '-DCHANNEL_CLIPRDR=ON', '-DCHANNEL_RDPDR=ON', '-DCHANNEL_DRIVE=ON',
  '-DCHANNEL_RDPSND=ON' # rdpdr을 켜면 FreeRDP가 rdpsnd(sys:fake)를 함께 불러오므로 같이 빌드해야 접속이 막히지 않는다
# 채널 구성이 바뀌면 이미 설치된 FreeRDP를 다시 빌드한다(구성을 prefix에 기록해 비교).
$channelStamp = "$Prefix\freerdp-channels.txt"
$channelKey = ($channelFlags -join ' ')
if ((Test-Path "$Prefix\lib\freerdp3.lib") -and (-not (Test-Path $channelStamp) -or (Get-Content $channelStamp -Raw).Trim() -ne $channelKey)) {
  Write-Host '   FreeRDP 채널 구성 변경 → 다시 빌드'
  Remove-Item "$Prefix\lib\freerdp3.lib" -Force
  if (Test-Path "$Work\freerdp-build") { Remove-Item "$Work\freerdp-build" -Recurse -Force }
}

Write-Host "== FreeRDP $FREERDP_TAG"
if (-not (Test-Path "$Prefix\lib\freerdp3.lib")) {
  Get-Source https://github.com/FreeRDP/FreeRDP $FREERDP_TAG freerdp
  # 패치(macOS와 동일): 화면 크기 변경(재활성화) 직후 서버가 finalization이 끝나기 전에 화면 업데이트를 먼저 보내면
  # FreeRDP 3.32.1의 update_recv()가 연결을 끊는다 — CLIENT_SYNC 이후라면 업데이트를 받아들이도록 이 한 곳만 완화한다.
  $updateC = "$Src\freerdp\libfreerdp\core\update.c"
  $s = [IO.File]::ReadAllText($updateC)
  $a = $s.IndexOf('BOOL update_recv(rdpUpdate* update, wStream* s)')
  $old = 'if (!rdp_has_reached_state(update->context->rdp, CONNECTION_STATE_ACTIVE))'
  $new = 'if (!rdp_has_reached_state(update->context->rdp, CONNECTION_STATE_FINALIZATION_CLIENT_SYNC))'
  $i = if ($a -ge 0) { $s.IndexOf($old, $a) } else { -1 }
  if ($i -ne -1 -and ($i - $a) -lt 600) {
    $s = $s.Substring(0, $i) + $new + $s.Substring($i + $old.Length)
    [IO.File]::WriteAllText($updateC, $s)
    Write-Host '   update.c 패치 적용'
  } elseif ($s.Contains($new)) {
    Write-Host '   update.c 이미 패치됨'
  } else { throw 'update.c 패치 위치를 찾지 못했습니다(FreeRDP 버전 확인).' }

  # 패치(Windows 전용): 정적 채널을 전부 끄면 cmdline.c의 staticChannels[]가 빈 배열이 되는데, clang은 허용하지만
  # MSVC는 C7757 오류를 낸다. 맨 앞에 빈 항목(channelName=NULL)을 두고 반복문에서 건너뛰게 한다(동작은 동일).
  $cmdlineC = "$Src\freerdp\client\common\cmdline.c"
  $s = [IO.File]::ReadAllText($cmdlineC)
  if (-not $s.Contains('/* onegyeok: MSVC empty-array guard */')) {
    $re1 = [regex]'ChannelToLoad staticChannels\[\] = \{(\r?\n)'
    $re2 = [regex]'(for \(size_t i = 0; i < ARRAYSIZE\(staticChannels\); i\+\+\)\r?\n\s*\{(\r?\n))'
    if (-not ($re1.IsMatch($s) -and $re2.IsMatch($s))) { throw 'cmdline.c 패치 위치를 찾지 못했습니다(FreeRDP 버전 확인).' }
    $s = $re1.Replace($s, 'ChannelToLoad staticChannels[] = {$1		{ 0, nullptr, nullptr }, /* onegyeok: MSVC empty-array guard */$1', 1)
    $s = $re2.Replace($s, '$1		if (!staticChannels[i].channelName)$2			continue;$2', 1)
    [IO.File]::WriteAllText($cmdlineC, $s)
    Write-Host '   cmdline.c 패치 적용'
  }

  Invoke-Native cmake (@('-S', "$Src\freerdp", '-B', "$Work\freerdp-build") + $CommonCMake + $OpenSSLCMake + $ZlibCMake + @(
    '-DMSVC_RUNTIME=static', '-DWITH_CLIENT=OFF', '-DWITH_SERVER=OFF', '-DWITH_SHADOW=OFF', '-DWITH_PROXY=OFF',
    '-DWITH_SAMPLE=OFF', '-DBUILD_TESTING=OFF', '-DWITH_MANPAGES=OFF', '-DWITH_WINPR_TOOLS=OFF',
    '-DWITH_FFMPEG=OFF', '-DWITH_SWSCALE=OFF', '-DWITH_DSP_FFMPEG=OFF', '-DWITH_VIDEO_FFMPEG=OFF', '-DWITH_OPENH264=OFF',
    '-DWITH_MEDIA_FOUNDATION=OFF', '-DWITH_CAIRO=OFF', '-DWITH_PCSC=OFF', '-DWITH_KRB5=OFF', '-DWITH_AAD=OFF',
    '-DWITH_SDL=OFF', '-DWITH_CLIENT_SDL=OFF', '-DWITH_SMARTCARD_EMULATE=OFF', '-DWITH_JSON_DISABLED=ON',
    '-DWITH_URIPARSER=OFF', '-DUSE_UNWIND=OFF', '-DWITH_WEBVIEW=OFF', '-DWITH_OPUS=OFF', '-DWITH_FAAD2=OFF',
    '-DWITH_FAAC=OFF', '-DWITH_SOXR=OFF', '-DWITH_GSM=OFF', '-DWITH_LAME=OFF', '-DWITH_OPENCL=OFF', '-DWITH_JPEG=OFF',
    '-DWITH_INTERNAL_SHA=OFF', '-DWITH_CLIENT_CHANNELS=ON', '-DWITH_SERVER_CHANNELS=OFF',
    '-DWITH_INTERNAL_MD4=ON', '-DWITH_INTERNAL_RC4=ON') + $channelFlags)
  Invoke-Native cmake @('--build', "$Work\freerdp-build", '-j', $Jobs)
  Invoke-Native cmake @('--install', "$Work\freerdp-build")
  Set-Content -Path $channelStamp -Value $channelKey -Encoding ascii
}

Write-Host "== libvncclient $LIBVNC_TAG"
if (-not (Test-Path "$Prefix\lib\vncclient.lib")) {
  Get-Source https://github.com/LibVNC/libvncserver $LIBVNC_TAG libvncserver
  Invoke-Native cmake (@('-S', "$Src\libvncserver", '-B', "$Work\libvnc-build") + $CommonCMake + $OpenSSLCMake + $ZlibCMake + @(
    '-DWITH_EXAMPLES=OFF', '-DWITH_TESTS=OFF', '-DWITH_SDL=OFF', '-DWITH_GTK=OFF', '-DWITH_FFMPEG=OFF',
    '-DWITH_GNUTLS=OFF', '-DWITH_GCRYPT=OFF', '-DWITH_OPENSSL=ON', '-DWITH_JPEG=OFF', '-DWITH_PNG=OFF',
    '-DWITH_SYSTEMD=OFF', '-DWITH_LZO=OFF', '-DWITH_SASL=OFF', '-DWITH_THREADS=ON', '-DWITH_ZLIB=ON',
    '-DWITH_WEBSOCKETS=OFF', '-DWITH_IPv6=ON'))
  # 서버 라이브러리는 필요 없으므로 클라이언트만 빌드한다.
  Invoke-Native cmake @('--build', "$Work\libvnc-build", '-j', $Jobs, '--target', 'vncclient')
  New-Item -ItemType Directory -Force "$Prefix\include\rfb" | Out-Null
  Copy-Item "$Work\libvnc-build\vncclient.lib" "$Prefix\lib\vncclient.lib"
  Copy-Item "$Src\libvncserver\include\rfb\*.h" "$Prefix\include\rfb\"
  Copy-Item "$Work\libvnc-build\include\rfb\rfbconfig.h" "$Prefix\include\rfb\"
}

Write-Host "OK: $Prefix"
