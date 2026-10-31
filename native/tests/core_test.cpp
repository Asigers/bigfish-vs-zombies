// Native bridge core tests. No game assets or PvZ headers required.
// SPDX-License-Identifier: LGPL-3.0-or-later
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "BridgeCore.h"
#include "HttpServer.h"

using namespace bigfish;

namespace
{
int gFailures = 0;

void Check(bool theCondition, const std::string& theWhat)
{
	if (theCondition)
	{
		std::cout << "ok   " << theWhat << '\n';
		return;
	}
	std::cout << "FAIL " << theWhat << '\n';
	++gFailures;
}

const char* const kToken = "native-test-token-1234567890";

/** Small in-memory engine that mirrors the PvZ facade contract. */
class FakeFacade final : public IGameFacade
{
public:
	Snapshot Capture() override
	{
		Snapshot aSnapshot = state_;
		aSnapshot.revision = 0;
		return aSnapshot;
	}

	Issue PlacePlant(const Action& theAction) override
	{
		if (failSilently_)
			return Issue::None; // accepted but no observable change
		for (const auto& aPlant : state_.plants)
		{
			if (aPlant.row == theAction.row && aPlant.col == theAction.col)
				return Issue::Occupied;
		}
		state_.sun -= 100;
		state_.plants.push_back(PlantView{theAction.plant, theAction.row, theAction.col, 300});
		return Issue::None;
	}

	Issue CollectSun(const Action& theAction) override
	{
		for (std::size_t i = 0; i < state_.suns.size(); ++i)
		{
			if (state_.suns[i].id != theAction.id)
				continue;
			state_.suns.erase(state_.suns.begin() + static_cast<long>(i));
			state_.sun += 25;
			return Issue::None;
		}
		return Issue::SunMissing;
	}

	Issue Shovel(const Action& theAction) override
	{
		for (std::size_t i = 0; i < state_.plants.size(); ++i)
		{
			if (state_.plants[i].row != theAction.row || state_.plants[i].col != theAction.col)
				continue;
			state_.plants.erase(state_.plants.begin() + static_cast<long>(i));
			return Issue::None;
		}
		return Issue::NoPlant;
	}

	Issue EnterAdventure() override
	{
		if (state_.status != Status::Menu)
			return Issue::NotPlaying;
		state_.status = Status::Intro;
		return Issue::None;
	}

	Issue ChooseSeeds() override
	{
		if (state_.status != Status::Intro)
			return Issue::NoSeedChooser;
		state_.status = Status::Playing;
		return Issue::None;
	}

	Issue NextLevel() override
	{
		if (state_.status != Status::Won)
			return Issue::NoNextLevel;
		++state_.level;
		state_.status = Status::Playing;
		return Issue::None;
	}

	void SetFailSilently(bool theValue) { failSilently_ = theValue; }

	Snapshot state_{[] {
		Snapshot aSnapshot;
		aSnapshot.gameId = "fake-1";
		aSnapshot.level = 2;
		aSnapshot.wave = 1;
		aSnapshot.totalWaves = 4;
		aSnapshot.sun = 150;
		aSnapshot.status = Status::Playing;
		aSnapshot.plants = {};
		aSnapshot.zombies = {{"normal", 3, 6.5f, 200}};
		aSnapshot.suns = {{"coin7", 2.0f, 3.0f, 0}};
		aSnapshot.cards = {{"peashooter", 100, true}, {"sunflower", 50, true}, {"wallnut", 50, false}};
		return aSnapshot;
	}()};

private:
	bool failSilently_ = false;
};

std::string HttpGet(int thePort, const std::string& thePath, const std::string& theAuth)
{
	const int aFd = ::socket(AF_INET, SOCK_STREAM, 0);
	if (aFd < 0)
		return "";
	sockaddr_in aAddress{};
	aAddress.sin_family = AF_INET;
	aAddress.sin_port = htons(static_cast<std::uint16_t>(thePort));
	aAddress.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (::connect(aFd, reinterpret_cast<sockaddr*>(&aAddress), sizeof(aAddress)) < 0)
	{
		::close(aFd);
		return "";
	}
	const std::string aRequest = "GET " + thePath + " HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: " +
		theAuth + "\r\nConnection: close\r\n\r\n";
	::send(aFd, aRequest.data(), aRequest.size(), 0);
	std::string aResponse;
	char aBuffer[4096];
	ssize_t aRead = 0;
	while ((aRead = ::recv(aFd, aBuffer, sizeof(aBuffer), 0)) > 0)
		aResponse.append(aBuffer, static_cast<std::size_t>(aRead));
	::close(aFd);
	return aResponse;
}

std::string HttpPost(int thePort, const std::string& thePath, const std::string& theAuth, const std::string& theBody)
{
	const int aFd = ::socket(AF_INET, SOCK_STREAM, 0);
	if (aFd < 0)
		return "";
	sockaddr_in aAddress{};
	aAddress.sin_family = AF_INET;
	aAddress.sin_port = htons(static_cast<std::uint16_t>(thePort));
	aAddress.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
	if (::connect(aFd, reinterpret_cast<sockaddr*>(&aAddress), sizeof(aAddress)) < 0)
	{
		::close(aFd);
		return "";
	}
	const std::string aRequest = "POST " + thePath + " HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: " +
		theAuth + "\r\nContent-Type: application/json\r\nContent-Length: " + std::to_string(theBody.size()) +
		"\r\nConnection: close\r\n\r\n" + theBody;
	::send(aFd, aRequest.data(), aRequest.size(), 0);
	std::string aResponse;
	char aBuffer[4096];
	ssize_t aRead = 0;
	while ((aRead = ::recv(aFd, aBuffer, sizeof(aBuffer), 0)) > 0)
		aResponse.append(aBuffer, static_cast<std::size_t>(aRead));
	::close(aFd);
	return aResponse;
}

bool Contains(const std::string& theHaystack, const std::string& theNeedle)
{
	return theHaystack.find(theNeedle) != std::string::npos;
}

std::string StatusLine(const std::string& theResponse)
{
	const std::size_t aEnd = theResponse.find("\r\n");
	return aEnd == std::string::npos ? "" : theResponse.substr(0, aEnd);
}
}

int main()
{
	// ---- pure validation -------------------------------------------------
	{
		Snapshot aSnapshot;
		aSnapshot.gameId = "g";
		aSnapshot.revision = 5;
		aSnapshot.status = Status::Playing;
		aSnapshot.sun = 150;
		aSnapshot.plants = {{"sunflower", 1, 1, 300}};
		aSnapshot.cards = {{"peashooter", 100, true}, {"sunflower", 50, true}};

		Command aPlantCommand{"c1", 0, {"plant", "peashooter", "", 2, 2}};
		Check(BridgeCore::Validate(aSnapshot, aPlantCommand).issue == Issue::None, "validate: legal plant");

		Command aFuture{"c2", 9, {"plant", "peashooter", "", 2, 2}};
		Check(BridgeCore::Validate(aSnapshot, aFuture).issue == Issue::FutureState, "validate: future revision");

		Command aOccupied{"c3", 0, {"plant", "peashooter", "", 1, 1}};
		Check(BridgeCore::Validate(aSnapshot, aOccupied).issue == Issue::Occupied, "validate: occupied cell");

		Command aBroke{"c4", 0, {"plant", "repeater", "", 3, 3}};
		Check(BridgeCore::Validate(aSnapshot, aBroke).issue == Issue::MissingCard, "validate: unknown card");
		Snapshot aPoor = aSnapshot;
		aPoor.sun = 10;
		Check(BridgeCore::Validate(aPoor, aPlantCommand).issue == Issue::InsufficientSun, "validate: sun");

		Command aShovel{"c5", 0, {"shovel", "", "", 1, 1}};
		Check(BridgeCore::Validate(aSnapshot, aShovel).issue == Issue::None, "validate: shovel");

		Command aNoPlant{"c6", 0, {"shovel", "", "", 4, 4}};
		Check(BridgeCore::Validate(aSnapshot, aNoPlant).issue == Issue::NoPlant, "validate: shovel empty");

		Command aSun{"c7", 0, {"collect_sun", "", "coin1", 0, 0}};
		Check(BridgeCore::Validate(aSnapshot, aSun).issue == Issue::SunMissing, "validate: sun id");

		Command aNext{"c8", 0, {"next_level", "", "", 0, 0}};
		Check(BridgeCore::Validate(aSnapshot, aNext).issue == Issue::NotPlaying, "validate: next level before win");

		Snapshot aConveyor = aSnapshot;
		aConveyor.sun = 0;
		aConveyor.freeSeeds = true;
		Check(BridgeCore::Validate(aConveyor, aPlantCommand).issue == Issue::None, "validate: conveyor seeds are free");

		Snapshot aMenu = aSnapshot;
		aMenu.status = Status::Menu;
		Command aEnter{"c9", 0, {"enter_adventure", "", "", 0, 0}};
		Check(BridgeCore::Validate(aMenu, aEnter).issue == Issue::None, "validate: enter adventure from menu");
		Check(BridgeCore::Validate(aSnapshot, aEnter).issue == Issue::NotPlaying, "validate: enter adventure needs menu");

		Snapshot aIntro = aSnapshot;
		aIntro.status = Status::Intro;
		Command aSeeds{"c10", 0, {"choose_seeds", "", "", 0, 0}};
		Check(BridgeCore::Validate(aIntro, aSeeds).issue == Issue::None, "validate: choose seeds during intro");
		Check(BridgeCore::Validate(aSnapshot, aSeeds).issue == Issue::NotPlaying, "validate: choose seeds needs intro");
	}

	// ---- command lifecycle ----------------------------------------------
	{
		FakeFacade aFacade;
		BridgeCore aCore(aFacade, "test", 0);
		std::atomic<bool> aPumping{true};
		std::thread aPump([&] {
			while (aPumping)
			{
				aCore.Pump();
				std::this_thread::sleep_for(std::chrono::milliseconds(1));
			}
		});
		aCore.Pump();
		Check(aCore.Revision() == 1, "core: first pump publishes revision 1");
		Check(Contains(aCore.SnapshotEnvelope(), "\"revision\":1"), "core: snapshot envelope");

		int aStatus = 0;
		const std::string aPlant = aCore.CommandEnvelope(
			R"({"commandId":"a1","expectedRevision":1,"action":{"type":"plant","plant":"peashooter","row":2,"col":2}})",
			aStatus);
		Check(aStatus == 200, "core: command http status");
		Check(Contains(aPlant, "\"status\":\"applied\""), "core: plant applied");
		Check(Contains(aPlant, "\"revisionAfter\":2"), "core: revision advanced");

		const std::string aAfter = aCore.SnapshotEnvelope();
		Check(Contains(aAfter, "\"plants\":[{\"type\":\"peashooter\""), "core: plant visible in snapshot");

		const std::string aDuplicate = aCore.CommandEnvelope(
			R"({"commandId":"a1","expectedRevision":1,"action":{"type":"plant","plant":"peashooter","row":2,"col":2}})",
			aStatus);
		Check(Contains(aDuplicate, "\"status\":\"duplicate\""), "core: duplicate command id");
		const std::string aDupSnapshot = aCore.SnapshotEnvelope();
		std::size_t aCount = 0;
		for (std::size_t aPos = aDupSnapshot.find("\"row\":2,\"col\":2"); aPos != std::string::npos;
			aPos = aDupSnapshot.find("\"row\":2,\"col\":2", aPos + 1))
			++aCount;
		Check(aCount == 1, "core: duplicate not applied twice");

		const std::string aBad = aCore.CommandEnvelope("{not json", aStatus);
		Check(aStatus == 400, "core: malformed json rejected");
		Check(Contains(aBad, "bad_json"), "core: malformed json body");

		const std::string aUnknown = aCore.CommandEnvelope(
			R"({"commandId":"a9","expectedRevision":1,"action":{"type":"dance"}})", aStatus);
		Check(aStatus == 400 && Contains(aUnknown, "unsupported_action"), "core: unsupported action");

		aPumping = false;
		aPump.join();
	}

	// ---- no-effect rejection --------------------------------------------
	{
		FakeFacade aFacade;
		aFacade.SetFailSilently(true);
		BridgeCore aCore(aFacade, "test", 0);
		std::atomic<bool> aPumping{true};
		std::thread aPump([&] {
			while (aPumping)
			{
				aCore.Pump();
				std::this_thread::sleep_for(std::chrono::milliseconds(1));
			}
		});
		aCore.Pump();
		int aStatus = 0;
		const std::string aResponse = aCore.CommandEnvelope(
			R"({"commandId":"n1","expectedRevision":1,"action":{"type":"plant","plant":"peashooter","row":2,"col":2}})",
			aStatus);
		Check(Contains(aResponse, "\"status\":\"rejected\""), "core: silent failure is not success");
		Check(Contains(aResponse, "no_effect"), "core: no_effect issue");
		aPumping = false;
		aPump.join();
	}

	// ---- HTTP surface ----------------------------------------------------
	{
		FakeFacade aFacade;
		BridgeCore aCore(aFacade, "test", 0);
		HttpServer aServer(aCore, kToken, 0);
		std::string aError;
		Check(aServer.Start(aError), "http: server started (" + aError + ")");

		std::atomic<bool> aPumping{true};
		std::thread aPump([&] {
			while (aPumping)
			{
				aCore.Pump();
				std::this_thread::sleep_for(std::chrono::milliseconds(2));
			}
		});

		const std::string aAuth = std::string("Bearer ") + kToken;
		Check(Contains(HttpGet(aServer.BoundPort(), "/v1/health", aAuth), "pvz-portable-bridge"), "http: health");
		Check(StatusLine(HttpGet(aServer.BoundPort(), "/v1/health", "Bearer wrong-token")) == "HTTP/1.1 401 Unauthorized",
			"http: token required");
		Check(Contains(HttpGet(aServer.BoundPort(), "/v1/snapshot", aAuth), "\"snapshot\""), "http: snapshot");
		Check(StatusLine(HttpPost(aServer.BoundPort(), "/v1/command", aAuth, "{}")) == "HTTP/1.1 400 Bad Request",
			"http: bad command rejected");

		const std::string aReceipt = HttpPost(aServer.BoundPort(), "/v1/command", aAuth,
			R"({"commandId":"h1","expectedRevision":0,"action":{"type":"collect_sun","id":"coin7"}})");
		Check(Contains(aReceipt, "\"status\":\"applied\""), "http: command executed on the game thread");

		aPumping = false;
		aPump.join();
		aServer.Stop();
	}

	std::cout << (gFailures == 0 ? "all native bridge checks passed\n" : "native bridge checks failed\n");
	return gFailures == 0 ? 0 : 1;
}
