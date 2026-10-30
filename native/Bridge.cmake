# Injected into the PvZ-Portable CMake project after the game target exists.
# Kept separate from the upstream tree so upstream stays unmodified except for
# the two hook lines in native/patches/.
set(BIGFISH_BRIDGE_DIR ${CMAKE_CURRENT_LIST_DIR})

message(STATUS "BigFish bridge: ${BIGFISH_BRIDGE_DIR}")

target_sources(pvz-portable PRIVATE
	${BIGFISH_BRIDGE_DIR}/BridgeCore.cpp
	${BIGFISH_BRIDGE_DIR}/HttpServer.cpp
	${BIGFISH_BRIDGE_DIR}/Json.cpp
	${BIGFISH_BRIDGE_DIR}/Module.cpp
	${BIGFISH_BRIDGE_DIR}/PvzFacade.cpp
)

target_include_directories(pvz-portable PRIVATE ${BIGFISH_BRIDGE_DIR})

find_package(Threads REQUIRED)
target_link_libraries(pvz-portable PRIVATE Threads::Threads)

# The bridge must never be compiled into a release build by accident.
target_compile_definitions(pvz-portable PRIVATE BIGFISH_BRIDGE=1)
