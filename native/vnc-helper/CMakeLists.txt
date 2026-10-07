cmake_minimum_required(VERSION 3.20)
project(onegyeok-vnc-helper C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# vcpkg has no libvncserver port, so libvncclient is built from source
# (https://github.com/LibVNC/libvncserver, static, `--target vncclient`) and located here:
#   cmake -S . -B build -DLIBVNC_SRC=C:/libvncserver -DLIBVNC_BUILD=C:/libvncserver/build
set(LIBVNC_SRC "" CACHE PATH "libvncserver source tree (contains include/rfb/rfbclient.h)")
set(LIBVNC_BUILD "" CACHE PATH "libvncserver build tree (contains include/rfb/rfbconfig.h and Release/vncclient.lib)")

find_path(RFBCLIENT_INCLUDE rfb/rfbclient.h HINTS "${LIBVNC_SRC}/include" REQUIRED)
find_path(RFBCONFIG_INCLUDE rfb/rfbconfig.h HINTS "${LIBVNC_BUILD}/include" REQUIRED)
find_library(VNCCLIENT_LIB vncclient HINTS "${LIBVNC_BUILD}/Release" "${LIBVNC_BUILD}" REQUIRED)

add_executable(onegyeok-vnc-helper src/main.c src/framing.c src/jsonlite.c)
target_include_directories(onegyeok-vnc-helper PRIVATE "${RFBCLIENT_INCLUDE}" "${RFBCONFIG_INCLUDE}")
target_link_libraries(onegyeok-vnc-helper PRIVATE "${VNCCLIENT_LIB}")
if(WIN32)
	target_link_libraries(onegyeok-vnc-helper PRIVATE ws2_32)
	target_compile_definitions(onegyeok-vnc-helper PRIVATE _CRT_SECURE_NO_WARNINGS)
endif()
if(MSVC)
	target_compile_options(onegyeok-vnc-helper PRIVATE /W3 /utf-8)
endif()
