cmake_minimum_required(VERSION 3.20)
project(onegyeok-rdp-helper C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Dependencies come from vcpkg:
#   vcpkg install freerdp:x64-windows
#   cmake -S . -B build -DCMAKE_TOOLCHAIN_FILE=%VCPKG_ROOT%/scripts/buildsystems/vcpkg.cmake
find_package(FreeRDP3 CONFIG REQUIRED)
find_package(WinPR3 CONFIG REQUIRED)

add_executable(onegyeok-rdp-helper src/main.c src/framing.c src/jsonlite.c)
target_link_libraries(onegyeok-rdp-helper PRIVATE freerdp winpr)
if(MSVC)
	target_compile_options(onegyeok-rdp-helper PRIVATE /W3 /utf-8)
endif()
