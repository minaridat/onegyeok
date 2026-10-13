cmake_minimum_required(VERSION 3.20)
project(onegyeok-rdp-helper C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
# 배포용: VC 런타임 DLL 없이 돌도록 정적 CRT(/MT). 의존성도 모두 /MT로 빌드돼 있어야 한다.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

# 의존성은 scripts/win/build-native-deps.ps1이 만든 정적 prefix에서만 찾는다:
#   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DDEPS_PREFIX=<repo>/build/win-deps/prefix
set(DEPS_PREFIX "" CACHE PATH "build/win-deps/prefix")
list(PREPEND CMAKE_PREFIX_PATH "${DEPS_PREFIX}")
set(OPENSSL_ROOT_DIR "${DEPS_PREFIX}")
set(OPENSSL_USE_STATIC_LIBS ON)
set(OPENSSL_MSVC_STATIC_RT ON)
set(ZLIB_ROOT "${DEPS_PREFIX}")
# zlib은 정적(zlibstatic)·동적(zlib) 둘 다 설치되므로 정적 쪽을 고정한다.
set(ZLIB_INCLUDE_DIR "${DEPS_PREFIX}/include")
set(ZLIB_LIBRARY "${DEPS_PREFIX}/lib/zlibstatic.lib")

find_package(WinPR CONFIG REQUIRED)        # lib/cmake/WinPR3/
find_package(FreeRDP CONFIG REQUIRED)
find_package(FreeRDP-Client CONFIG REQUIRED)

add_executable(onegyeok-rdp-helper src/main.c src/framing.c src/jsonlite.c)
target_link_libraries(onegyeok-rdp-helper PRIVATE freerdp-client freerdp winpr)
if(WIN32)
	# FreeRDP/WinPR 헤더는 Windows에서 *_EXPORTS가 없으면 무조건 dllimport로 선언한다(정적 링크용 분기가 없음).
	# 정적 라이브러리에 직접 링크하므로 FreeRDP 트리 내부 빌드와 같이 *_EXPORTS를 정의해 __imp_ 참조를 피한다.
	target_compile_definitions(onegyeok-rdp-helper PRIVATE FREERDP_EXPORTS WINPR_EXPORTS _CRT_SECURE_NO_WARNINGS _CRT_NONSTDC_NO_WARNINGS)
	target_link_libraries(onegyeok-rdp-helper PRIVATE ws2_32 crypt32 secur32 ncrypt bcrypt advapi32 user32 shell32 ole32 dbghelp shlwapi rpcrt4 netapi32 ntdsapi)
endif()
if(MSVC)
	target_compile_options(onegyeok-rdp-helper PRIVATE /W3 /utf-8)
endif()

# 산출물은 Makefile과 같은 위치(native/rdp-helper/)에 둔다 — electron-builder extraResources와 helper-bridge.js가 여기서 찾는다.
set_target_properties(onegyeok-rdp-helper PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
