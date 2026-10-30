// SPDX-License-Identifier: LGPL-3.0-or-later
#include "HttpServer.h"

#include <arpa/inet.h>
#include <cerrno>
#include <cstring>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <cctype>
#include <sstream>
#include <string_view>

#include "BridgeCore.h"

namespace bigfish
{
namespace
{
constexpr std::size_t kMaxRequestLine = 2048;
constexpr std::size_t kMaxHeaders = 8192;

std::string ToLower(std::string theText)
{
	std::transform(theText.begin(), theText.end(), theText.begin(),
		[](unsigned char theChar) { return static_cast<char>(std::tolower(theChar)); });
	return theText;
}

std::string Trim(std::string_view theText)
{
	std::size_t aStart = 0;
	std::size_t aEnd = theText.size();
	while (aStart < aEnd && std::isspace(static_cast<unsigned char>(theText[aStart])))
		++aStart;
	while (aEnd > aStart && std::isspace(static_cast<unsigned char>(theText[aEnd - 1])))
		--aEnd;
	return std::string(theText.substr(aStart, aEnd - aStart));
}

/** Length-independent comparison: avoids leaking the token through timing. */
bool ConstantTimeEquals(std::string_view theLeft, std::string_view theRight)
{
	if (theLeft.size() != theRight.size())
		return false;
	unsigned char aDiff = 0;
	for (std::size_t i = 0; i < theLeft.size(); ++i)
		aDiff |= static_cast<unsigned char>(theLeft[i] ^ theRight[i]);
	return aDiff == 0;
}

const char* StatusText(int theStatus)
{
	switch (theStatus)
	{
	case 200: return "OK";
	case 400: return "Bad Request";
	case 401: return "Unauthorized";
	case 404: return "Not Found";
	case 405: return "Method Not Allowed";
	case 409: return "Conflict";
	case 413: return "Payload Too Large";
	case 504: return "Gateway Timeout";
	default: return "Internal Server Error";
	}
}

void SetTimeouts(int theFd)
{
	timeval aTimeout{};
	aTimeout.tv_sec = 3;
	aTimeout.tv_usec = 0;
	setsockopt(theFd, SOL_SOCKET, SO_RCVTIMEO, &aTimeout, sizeof(aTimeout));
	setsockopt(theFd, SOL_SOCKET, SO_SNDTIMEO, &aTimeout, sizeof(aTimeout));
}

bool SendAll(int theFd, std::string_view theData)
{
	std::size_t aSent = 0;
	while (aSent < theData.size())
	{
		const ssize_t aWritten = ::send(theFd, theData.data() + aSent, theData.size() - aSent, 0);
		if (aWritten <= 0)
			return false;
		aSent += static_cast<std::size_t>(aWritten);
	}
	return true;
}
}

HttpServer::HttpServer(BridgeCore& theCore, std::string theToken, int thePort)
	: core_(theCore), token_(std::move(theToken)), port_(thePort)
{
}

HttpServer::~HttpServer()
{
	Stop();
}

bool HttpServer::Start(std::string& theError)
{
	if (running_)
		return true;

	listenFd_ = ::socket(AF_INET, SOCK_STREAM, 0);
	if (listenFd_ < 0)
	{
		theError = std::string("socket: ") + std::strerror(errno);
		return false;
	}

	int aReuse = 1;
	setsockopt(listenFd_, SOL_SOCKET, SO_REUSEADDR, &aReuse, sizeof(aReuse));

	sockaddr_in aAddress{};
	aAddress.sin_family = AF_INET;
	aAddress.sin_port = htons(static_cast<std::uint16_t>(port_));
	// Loopback only: the bridge must never be reachable from the LAN.
	aAddress.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

	if (::bind(listenFd_, reinterpret_cast<sockaddr*>(&aAddress), sizeof(aAddress)) < 0)
	{
		theError = std::string("bind 127.0.0.1:") + std::to_string(port_) + ": " + std::strerror(errno);
		::close(listenFd_);
		listenFd_ = -1;
		return false;
	}
	if (::listen(listenFd_, 16) < 0)
	{
		theError = std::string("listen: ") + std::strerror(errno);
		::close(listenFd_);
		listenFd_ = -1;
		return false;
	}

	sockaddr_in aBound{};
	socklen_t aLength = sizeof(aBound);
	if (getsockname(listenFd_, reinterpret_cast<sockaddr*>(&aBound), &aLength) == 0)
		port_ = ntohs(aBound.sin_port);

	running_ = true;
	thread_ = std::thread([this] { Loop(); });
	return true;
}

void HttpServer::Stop()
{
	if (!running_.exchange(false))
		return;
	if (listenFd_ >= 0)
	{
		::shutdown(listenFd_, SHUT_RDWR);
		::close(listenFd_);
		listenFd_ = -1;
	}
	if (thread_.joinable())
		thread_.join();
}

int HttpServer::BoundPort() const
{
	return port_;
}

void HttpServer::Loop()
{
	while (running_)
	{
		sockaddr_in aPeer{};
		socklen_t aLength = sizeof(aPeer);
		const int aFd = ::accept(listenFd_, reinterpret_cast<sockaddr*>(&aPeer), &aLength);
		if (aFd < 0)
		{
			if (!running_)
				break;
			if (errno == EINTR)
				continue;
			break;
		}
		// The controller is a single client; handling requests serially keeps
		// the bridge allocation-free and strictly ordered.
		HandleConnection(aFd);
		::close(aFd);
	}
}

void HttpServer::HandleConnection(int theFd)
{
	SetTimeouts(theFd);
	int aNoDelay = 1;
	setsockopt(theFd, IPPROTO_TCP, TCP_NODELAY, &aNoDelay, sizeof(aNoDelay));

	std::string aBuffer;
	aBuffer.reserve(1024);
	char aChunk[2048];
	std::size_t aHeaderEnd = std::string::npos;
	while (aHeaderEnd == std::string::npos)
	{
		const ssize_t aRead = ::recv(theFd, aChunk, sizeof(aChunk), 0);
		if (aRead <= 0)
			return;
		aBuffer.append(aChunk, static_cast<std::size_t>(aRead));
		if (aBuffer.size() > kMaxHeaders)
		{
			SendResponse(theFd, 413, "{\"error\":\"headers_too_large\"}");
			return;
		}
		aHeaderEnd = aBuffer.find("\r\n\r\n");
	}
	if (aHeaderEnd > kMaxRequestLine + 64)
	{
		SendResponse(theFd, 400, "{\"error\":\"request_line_too_long\"}");
		return;
	}

	const std::string aHead = aBuffer.substr(0, aHeaderEnd);
	const std::string aBodyPrefix = aBuffer.substr(aHeaderEnd + 4);

	std::istringstream aStream(aHead);
	std::string aRequestLine;
	std::getline(aStream, aRequestLine);
	aRequestLine = Trim(aRequestLine);
	std::istringstream aRequest(aRequestLine);
	std::string aMethod;
	std::string aPath;
	std::string aVersion;
	aRequest >> aMethod >> aPath >> aVersion;
	if (aMethod.empty() || aPath.empty())
	{
		SendResponse(theFd, 400, "{\"error\":\"bad_request\"}");
		return;
	}

	std::string aAuthorization;
	std::size_t aContentLength = 0;
	std::string aLine;
	while (std::getline(aStream, aLine))
	{
		aLine = Trim(aLine);
		if (aLine.empty())
			continue;
		const std::size_t aColon = aLine.find(':');
		if (aColon == std::string::npos)
			continue;
		const std::string aName = ToLower(Trim(aLine.substr(0, aColon)));
		const std::string aValue = Trim(aLine.substr(aColon + 1));
		if (aName == "authorization")
			aAuthorization = aValue;
		else if (aName == "content-length")
		{
			try
			{
				aContentLength = static_cast<std::size_t>(std::stoul(aValue));
			}
			catch (...)
			{
				SendResponse(theFd, 400, "{\"error\":\"bad_content_length\"}");
				return;
			}
		}
	}

	if (aContentLength > kMaxRequestBody)
	{
		SendResponse(theFd, 413, "{\"error\":\"body_too_large\"}");
		return;
	}

	const std::string aExpected = "Bearer " + token_;
	if (!ConstantTimeEquals(aAuthorization, aExpected))
	{
		SendResponse(theFd, 401, "{\"error\":\"unauthorized\"}");
		return;
	}

	std::string aBody = aBodyPrefix;
	while (aBody.size() < aContentLength)
	{
		const ssize_t aRead = ::recv(theFd, aChunk, sizeof(aChunk), 0);
		if (aRead <= 0)
			break;
		aBody.append(aChunk, static_cast<std::size_t>(aRead));
		if (aBody.size() > kMaxRequestBody)
		{
			SendResponse(theFd, 413, "{\"error\":\"body_too_large\"}");
			return;
		}
	}
	if (aBody.size() < aContentLength)
	{
		SendResponse(theFd, 400, "{\"error\":\"short_body\"}");
		return;
	}

	const std::size_t aQuery = aPath.find('?');
	if (aQuery != std::string::npos)
		aPath = aPath.substr(0, aQuery);

	if (aMethod == "GET" && aPath == "/v1/health")
	{
		SendResponse(theFd, 200, core_.HealthJson());
		return;
	}
	if (aMethod == "GET" && aPath == "/v1/snapshot")
	{
		SendResponse(theFd, 200, core_.SnapshotEnvelope());
		return;
	}
	if (aMethod == "POST" && aPath == "/v1/command")
	{
		int aStatus = 200;
		const std::string aResponse = core_.CommandEnvelope(aBody.substr(0, aContentLength), aStatus);
		SendResponse(theFd, aStatus, aResponse);
		return;
	}
	if (aPath == "/v1/snapshot" || aPath == "/v1/command" || aPath == "/v1/health")
	{
		SendResponse(theFd, 405, "{\"error\":\"method_not_allowed\"}");
		return;
	}
	SendResponse(theFd, 404, "{\"error\":\"not_found\"}");
}

void HttpServer::SendResponse(int theFd, int theStatus, const std::string& theBody)
{
	std::ostringstream aOut;
	aOut << "HTTP/1.1 " << theStatus << ' ' << StatusText(theStatus) << "\r\n"
		 << "Content-Type: application/json\r\n"
		 << "Content-Length: " << theBody.size() << "\r\n"
		 << "Cache-Control: no-store\r\n"
		 << "Connection: close\r\n"
		 << "X-Content-Type-Options: nosniff\r\n\r\n"
		 << theBody;
	SendAll(theFd, aOut.str());
}
}
