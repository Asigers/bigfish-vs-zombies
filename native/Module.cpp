// SPDX-License-Identifier: LGPL-3.0-or-later
#include "Module.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <string>

#include "BridgeCore.h"
#include "HttpServer.h"
#include "PvzFacade.h"

namespace bigfish
{
namespace
{
std::unique_ptr<PvzFacade> gFacade;
std::unique_ptr<BridgeCore> gCore;
std::unique_ptr<HttpServer> gServer;
bool gAttempted = false;
bool gEnabled = false;

void Log(const std::string& theMessage)
{
	std::fprintf(stderr, "[bigfish-bridge] %s\n", theMessage.c_str());
}

long long NowMs()
{
	return std::chrono::duration_cast<std::chrono::milliseconds>(
		std::chrono::steady_clock::now().time_since_epoch()).count();
}

void StartOnce(LawnApp* theApp)
{
	if (gAttempted)
		return;
	gAttempted = true;

	const char* aToken = std::getenv("BIGFISH_BRIDGE_TOKEN");
	if (aToken == nullptr || std::string(aToken).size() < 16)
	{
		Log("disabled: set BIGFISH_BRIDGE_TOKEN (>= 16 chars) to enable the local bridge");
		return;
	}
	int aPort = 45941;
	if (const char* aPortText = std::getenv("BIGFISH_BRIDGE_PORT"))
	{
		try
		{
			aPort = std::stoi(aPortText);
		}
		catch (...)
		{
			aPort = 45941;
		}
	}
	if (aPort <= 0 || aPort > 65535)
	{
		Log("disabled: invalid BIGFISH_BRIDGE_PORT");
		return;
	}

	try
	{
		gFacade = std::make_unique<PvzFacade>(theApp);
		gCore = std::make_unique<BridgeCore>(*gFacade, "pvz-portable", NowMs());
		gServer = std::make_unique<HttpServer>(*gCore, aToken, aPort);
	}
	catch (const std::exception& theError)
	{
		Log(std::string("disabled: ") + theError.what());
		return;
	}

	std::string aError;
	if (!gServer->Start(aError))
	{
		Log("disabled: " + aError);
		gServer.reset();
		gCore.reset();
		gFacade.reset();
		return;
	}
	gEnabled = true;
	Log("listening on http://127.0.0.1:" + std::to_string(gServer->BoundPort()));
}
}

void PumpBridge(LawnApp* theApp)
{
	StartOnce(theApp);
	if (!gEnabled || !gCore)
		return;
	gCore->Pump();
}

void ShutdownBridge()
{
	if (gServer)
	{
		gServer->Stop();
		gServer.reset();
	}
	gCore.reset();
	gFacade.reset();
	gEnabled = false;
}
}
