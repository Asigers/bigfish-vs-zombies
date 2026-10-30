cmake_minimum_required(VERSION 3.16)
project(bigfish-bridge LANGUAGES CXX)

# Standalone build of the game-agnostic bridge core. It needs no game assets and
# no PvZ-Portable checkout, so it runs in CI and on any machine.
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
	set(CMAKE_BUILD_TYPE RelWithDebInfo)
endif()

find_package(Threads REQUIRED)

add_library(bigfish_bridge_core STATIC
	BridgeCore.cpp
	HttpServer.cpp
	Json.cpp
)
target_include_directories(bigfish_bridge_core PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})
target_link_libraries(bigfish_bridge_core PUBLIC Threads::Threads)
target_compile_options(bigfish_bridge_core PRIVATE -Wall -Wextra -Wpedantic)

add_executable(bigfish_core_test tests/core_test.cpp)
target_link_libraries(bigfish_core_test PRIVATE bigfish_bridge_core)
target_compile_options(bigfish_core_test PRIVATE -Wall -Wextra -Wpedantic)

enable_testing()
add_test(NAME bridge_core COMMAND bigfish_core_test)
