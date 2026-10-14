cmake_minimum_required(VERSION 3.20)
project(onegyeok-vnc-helper C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
# 배포용: VC 런타임 DLL 없이 돌도록 정적 CRT(/MT). 의존성도 모두 /MT로 빌드돼 있어야 한다.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")

# vcpkg에는 libvncserver 포트가 없어 scripts/win/build-native-deps.ps1이 libvncclient를 소스에서 정적으로 빌드해 prefix에 넣는다:
#   cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DDEPS_PREFIX=<repo>/build/win-deps/prefix
set(DEPS_PREFIX "" CACHE PATH "build/win-deps/prefix")

find_path(RFBCLIENT_INCLUDE rfb/rfbclient.h HINTS "${DEPS_PREFIX}/include" REQUIRED NO_DEFAULT_PATH)
find_library(VNCCLIENT_LIB vncclient HINTS "${DEPS_PREFIX}/lib" REQUIRED NO_DEFAULT_PATH)
find_library(SSL_LIB libssl HINTS "${DEPS_PREFIX}/lib" REQUIRED NO_DEFAULT_PATH)
find_library(CRYPTO_LIB libcrypto HINTS "${DEPS_PREFIX}/lib" REQUIRED NO_DEFAULT_PATH)
find_library(ZLIB_LIB zlibstatic HINTS "${DEPS_PREFIX}/lib" REQUIRED NO_DEFAULT_PATH)

add_executable(onegyeok-vnc-helper src/main.c src/framing.c src/jsonlite.c)
target_include_directories(onegyeok-vnc-helper PRIVATE "${RFBCLIENT_INCLUDE}")
target_link_libraries(onegyeok-vnc-helper PRIVATE "${VNCCLIENT_LIB}" "${SSL_LIB}" "${CRYPTO_LIB}" "${ZLIB_LIB}")
if(WIN32)
	target_link_libraries(onegyeok-vnc-helper PRIVATE ws2_32 crypt32 advapi32 user32)
	target_compile_definitions(onegyeok-vnc-helper PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
if(MSVC)
	target_compile_options(onegyeok-vnc-helper PRIVATE /W3 /utf-8)
endif()

# 산출물은 Makefile과 같은 위치(native/vnc-helper/)에 둔다 — electron-builder extraResources와 main 프로세스가 여기서 찾는다.
set_target_properties(onegyeok-vnc-helper PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}")
