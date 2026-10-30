// HTTP/1.1 loopback server for the native bridge.
// SPDX-License-Identifier: LGPL-3.0-or-later
#pragma once

#include <atomic>
#include <string>
#include <thread>

namespace bigfish
{
class BridgeCore;

class HttpServer
{
public:
	HttpServer(BridgeCore& theCore, std::string theToken, int thePort);
	~HttpServer();

	HttpServer(const HttpServer&) = delete;
	HttpServer& operator=(const HttpServer&) = delete;

	/** Bind 127.0.0.1 and start the accept loop. Returns false and fills `theError`. */
	bool Start(std::string& theError);
	void Stop();
	int BoundPort() const;
	bool Running() const { return running_; }

private:
	void Loop();
	void HandleConnection(int theFd);
	void SendResponse(int theFd, int theStatus, const std::string& theBody);

	BridgeCore& core_;
	std::string token_;
	int port_;
	int listenFd_ = -1;
	std::atomic<bool> running_{false};
	std::thread thread_;
};
}
