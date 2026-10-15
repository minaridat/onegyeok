#!/usr/bin/env bash
# macOS 배포용 네이티브 헬퍼 의존성(OpenSSL/FreeRDP/libvncclient)을 소스에서 정적으로 빌드한다.
# Homebrew 바이너리는 빌드한 OS 버전(현재 26)을 최소 요구 버전으로 박아 넣고 ffmpeg/X11 등
# 수십 개 dylib을 끌고 오기 때문에, 하위 macOS(13+)에서 도는 배포용으로는 쓸 수 없다.
# 결과물: build/mac-deps/prefix (정적 .a + pkg-config) — native/*/Makefile이 DEPS_PREFIX로 사용.
#
# 사전 준비: brew install cmake ninja pkgconf   (빌드 머신에만 필요, 사용자 PC에는 불필요)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$ROOT/build/mac-deps"
PREFIX="$WORK/prefix"
SRC="$WORK/src"
export MACOSX_DEPLOYMENT_TARGET="${MACOSX_DEPLOYMENT_TARGET:-15.0}"
ARCH="${ARCH:-arm64}"
JOBS="$(sysctl -n hw.ncpu)"

OPENSSL_TAG=openssl-3.5.9
FREERDP_TAG=3.32.1
LIBVNC_TAG=LibVNCServer-0.9.15

mkdir -p "$SRC" "$PREFIX"
export PATH="/opt/homebrew/bin:$PATH"
export PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig"

fetch() { # <repo-url> <tag> <dir>
  [ -d "$SRC/$3" ] || git clone -q --depth 1 --branch "$2" "$1" "$SRC/$3"
}

COMMON_CMAKE=(-G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX"
  -DCMAKE_PREFIX_PATH="$PREFIX" -DCMAKE_OSX_DEPLOYMENT_TARGET="$MACOSX_DEPLOYMENT_TARGET"
  -DCMAKE_OSX_ARCHITECTURES="$ARCH" -DCMAKE_IGNORE_PREFIX_PATH=/opt/homebrew:/usr/local
  -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON)

echo "== OpenSSL $OPENSSL_TAG"
# no-module: OpenSSL 3는 DES를 legacy provider에 두는데, 이 옵션이 없으면 legacy가 별도 모듈(.dylib)로 빠져
# libvncclient의 VNC 비밀번호 인증(OSSL_PROVIDER_load("legacy"))이 정적 링크 환경에서 항상 실패한다.
# 옵션을 바꾸면 이미 빌드된 prefix도 다시 만들도록 stamp 파일로 구분한다.
OPENSSL_STAMP="$PREFIX/.openssl-no-module"
if [ ! -f "$PREFIX/lib/libssl.a" ] || [ ! -f "$OPENSSL_STAMP" ]; then
  fetch https://github.com/openssl/openssl "$OPENSSL_TAG" openssl
  ( cd "$SRC/openssl"
    [ -f Makefile ] && make distclean >/dev/null 2>&1 || true
    ./Configure darwin64-arm64-cc no-shared no-module no-tests no-apps no-docs \
      --prefix="$PREFIX" --libdir=lib -mmacosx-version-min="$MACOSX_DEPLOYMENT_TARGET"
    make -j"$JOBS" build_libs
    make install_dev )
  touch "$OPENSSL_STAMP"
fi

# 클라이언트 채널은 동적 해상도(drdynvc+disp)·클립보드(cliprdr)·로컬 드라이브 마운트(rdpdr+drive, FreeRDP가 rdpdr에 함께 요구하는 rdpsnd 가짜 장치 포함)만 켜고 나머지는 끈다(정적 링크 크기·의존성 최소화).
FREERDP_CHANNEL_FLAGS=""
for ch in AINPUT AUDIN ECHO ENCOMSP GEOMETRY LOCATION PARALLEL PRINTER RAIL RDP2TCP RDPEAR RDPECAM \
          RDPEI RDPEMSC RDPEWA RDPGFX REMDESK SERIAL SMARTCARD SSHAGENT TELEMETRY TSMF URBDRC VIDEO GFXREDIR; do
  FREERDP_CHANNEL_FLAGS="$FREERDP_CHANNEL_FLAGS -DCHANNEL_${ch}=OFF"
done
FREERDP_CHANNEL_FLAGS="$FREERDP_CHANNEL_FLAGS -DCHANNEL_DRDYNVC=ON -DCHANNEL_DISP=ON -DCHANNEL_CLIPRDR=ON -DCHANNEL_RDPDR=ON -DCHANNEL_DRIVE=ON -DCHANNEL_RDPSND=ON"

echo "== FreeRDP $FREERDP_TAG"
FREERDP_STAMP="$PREFIX/.freerdp-channels-clip-drive-v2" # 채널 구성이 바뀌면 이 이름을 바꿔 FreeRDP를 다시 빌드하게 한다
if [ ! -f "$PREFIX/lib/libfreerdp3.a" ] || [ ! -f "$FREERDP_STAMP" ]; then
  fetch https://github.com/FreeRDP/FreeRDP "$FREERDP_TAG" freerdp
  # 패치: 화면 크기 변경(재활성화) 직후 xrdp는 finalization(동기화 PDU)이 끝나기 전에 화면 업데이트를 먼저 보내는데,
  # FreeRDP 3.32.1의 update_recv()는 상태가 ACTIVE 미만이면 연결을 끊어버린다 — 클라이언트가 자기 finalization
  # 요청(CLIENT_SYNC)을 보낸 이후라면 업데이트를 받아들이도록 이 한 곳만 완화한다. (이미 패치된 소스에는 재적용 안 함)
  python3 - "$SRC/freerdp/libfreerdp/core/update.c" <<'PYEOF'
import sys
p = sys.argv[1]
s = open(p).read()
marker = "BOOL update_recv(rdpUpdate* update, wStream* s)"
a = s.index(marker)
old = "if (!rdp_has_reached_state(update->context->rdp, CONNECTION_STATE_ACTIVE))"
new = "if (!rdp_has_reached_state(update->context->rdp, CONNECTION_STATE_FINALIZATION_CLIENT_SYNC))"
i = s.find(old, a)
if i != -1 and i - a < 600:
    s = s[:i] + new + s[i + len(old):]
    open(p, 'w').write(s)
PYEOF
  cmake -S "$SRC/freerdp" -B "$WORK/freerdp-build" "${COMMON_CMAKE[@]}" \
    -DOPENSSL_ROOT_DIR="$PREFIX" -DOPENSSL_USE_STATIC_LIBS=ON \
    -DWITH_CLIENT=OFF -DWITH_SERVER=OFF -DWITH_SHADOW=OFF -DWITH_PROXY=OFF -DWITH_SAMPLE=OFF \
    -DBUILD_TESTING=OFF -DWITH_MANPAGES=OFF -DWITH_X11=OFF -DWITH_WAYLAND=OFF \
    -DWITH_FFMPEG=OFF -DWITH_SWSCALE=OFF -DWITH_DSP_FFMPEG=OFF -DWITH_VIDEO_FFMPEG=OFF -DWITH_OPENH264=OFF \
    -DWITH_CAIRO=OFF -DWITH_CUPS=OFF -DWITH_PULSE=OFF -DWITH_ALSA=OFF -DWITH_OSS=OFF -DWITH_PCSC=OFF \
    -DWITH_FUSE=OFF -DWITH_KRB5=OFF -DWITH_AAD=OFF -DWITH_SDL=OFF -DWITH_SMARTCARD_EMULATE=OFF \
    -DWITH_JSON_DISABLED=ON -DWITH_URIPARSER=OFF -DUSE_UNWIND=OFF -DWITH_WEBVIEW=OFF \
    -DWITH_OPUS=OFF -DWITH_FAAD2=OFF -DWITH_FAAC=OFF -DWITH_SOXR=OFF -DWITH_GSM=OFF -DWITH_LAME=OFF -DWITH_OPENCL=OFF -DWITH_JPEG=OFF -DWITH_INTERNAL_SHA=OFF \
    -DCHANNEL_URBDRC=OFF -DWITH_CLIENT_CHANNELS=ON -DWITH_SERVER_CHANNELS=OFF \
    $FREERDP_CHANNEL_FLAGS -DWITH_INTERNAL_MD4=ON -DWITH_INTERNAL_RC4=ON
  cmake --build "$WORK/freerdp-build" -j"$JOBS"
  cmake --install "$WORK/freerdp-build"
  touch "$FREERDP_STAMP"
fi

echo "== libvncclient $LIBVNC_TAG"
if [ ! -f "$PREFIX/lib/libvncclient.a" ]; then
  fetch https://github.com/LibVNC/libvncserver "$LIBVNC_TAG" libvncserver
  cmake -S "$SRC/libvncserver" -B "$WORK/libvnc-build" "${COMMON_CMAKE[@]}" \
    -DOPENSSL_ROOT_DIR="$PREFIX" -DOPENSSL_USE_STATIC_LIBS=ON \
    -DWITH_EXAMPLES=OFF -DWITH_TESTS=OFF -DWITH_SDL=OFF -DWITH_GTK=OFF -DWITH_FFMPEG=OFF -DWITH_GNUTLS=OFF \
    -DWITH_OPENSSL=ON -DWITH_JPEG=OFF -DWITH_PNG=OFF -DWITH_SYSTEMD=OFF -DWITH_LZO=OFF -DWITH_SASL=OFF \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DWITH_THREADS=ON -DWITH_ZLIB=ON -DWITH_WEBSOCKETS=OFF -DWITH_IPv6=ON
  cmake --build "$WORK/libvnc-build" -j"$JOBS"
  cmake --install "$WORK/libvnc-build"
fi

# cmake가 만든 .pc의 Libs.private에 "-lz.tbd -lssl.a"처럼 파일명이 그대로 박히는 경우가 있어 정상 -l 형태로 고친다.
for pc in "$PREFIX"/lib/pkgconfig/*.pc; do
  sed -i '' -E 's/-l([A-Za-z0-9_]+)\.(tbd|a|dylib)/-l\1/g' "$pc"
done

echo "OK: $PREFIX"
