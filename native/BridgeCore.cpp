// SPDX-License-Identifier: LGPL-3.0-or-later
#include "BridgeCore.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <sstream>

#include "Json.h"

namespace bigfish
{
namespace
{
const char* const kActionPlant = "plant";
const char* const kActionCollectSun = "collect_sun";
const char* const kActionShovel = "shovel";
const char* const kActionNextLevel = "next_level";

std::string SerializeSnapshot(const Snapshot& theSnapshot)
{
	std::ostringstream aOut;
	aOut << "{\"schema\":" << kSchemaVersion
		 << ",\"gameId\":\"" << JsonEscape(theSnapshot.gameId) << "\""
		 << ",\"revision\":" << theSnapshot.revision
		 << ",\"level\":" << theSnapshot.level
		 << ",\"wave\":" << theSnapshot.wave
		 << ",\"totalWaves\":" << theSnapshot.totalWaves
		 << ",\"sun\":" << theSnapshot.sun
		 << ",\"rows\":" << theSnapshot.rows
		 << ",\"columns\":" << theSnapshot.columns
		 << ",\"status\":\"" << StatusName(theSnapshot.status) << "\""
		 << ",\"hasNextLevel\":" << (theSnapshot.hasNextLevel ? "true" : "false")
		 << ",\"blocked\":[]";

	aOut << ",\"plants\":[";
	for (std::size_t i = 0; i < theSnapshot.plants.size(); ++i)
	{
		const auto& aPlant = theSnapshot.plants[i];
		if (i)
			aOut << ',';
		aOut << "{\"type\":\"" << JsonEscape(aPlant.type) << "\""
			 << ",\"row\":" << aPlant.row
			 << ",\"col\":" << aPlant.col
			 << ",\"health\":" << aPlant.health << '}';
	}
	aOut << "],\"zombies\":[";
	for (std::size_t i = 0; i < theSnapshot.zombies.size(); ++i)
	{
		const auto& aZombie = theSnapshot.zombies[i];
		if (i)
			aOut << ',';
		aOut << "{\"type\":\"" << JsonEscape(aZombie.type) << "\""
			 << ",\"row\":" << aZombie.row
			 << ",\"x\":" << JsonNumber(aZombie.x)
			 << ",\"health\":" << aZombie.health << '}';
	}
	aOut << "],\"cards\":[";
	for (std::size_t i = 0; i < theSnapshot.cards.size(); ++i)
	{
		const auto& aCard = theSnapshot.cards[i];
		if (i)
			aOut << ',';
		aOut << "{\"type\":\"" << JsonEscape(aCard.type) << "\""
			 << ",\"cost\":" << aCard.cost
			 << ",\"ready\":" << (aCard.ready ? "true" : "false") << '}';
	}
	aOut << "],\"suns\":[";
	for (std::size_t i = 0; i < theSnapshot.suns.size(); ++i)
	{
		const auto& aSun = theSnapshot.suns[i];
		if (i)
			aOut << ',';
		aOut << "{\"id\":\"" << JsonEscape(aSun.id) << "\""
			 << ",\"x\":" << JsonNumber(aSun.x)
			 << ",\"y\":" << JsonNumber(aSun.y)
			 << ",\"expiresInMs\":" << aSun.expiresInMs << '}';
	}
	aOut << "]}";
	return aOut.str();
}

std::string SerializeReceipt(const Receipt& theReceipt)
{
	std::ostringstream aOut;
	aOut << "{\"commandId\":\"" << JsonEscape(theReceipt.commandId) << "\""
		 << ",\"status\":\"" << theReceipt.status << "\"";
	if (theReceipt.issue != Issue::None)
		aOut << ",\"issue\":\"" << IssueName(theReceipt.issue) << "\"";
	aOut << ",\"revisionBefore\":" << theReceipt.revisionBefore
		 << ",\"revisionAfter\":" << theReceipt.revisionAfter << '}';
	return aOut.str();
}

std::string ReceiptEnvelope(const Receipt& theReceipt)
{
	return "{\"receipt\":" + SerializeReceipt(theReceipt) + "}";
}

bool ValidType(const std::string& theType)
{
	return theType == kActionPlant || theType == kActionCollectSun ||
		theType == kActionShovel || theType == kActionNextLevel;
}

int RoundToInt(double theValue)
{
	return static_cast<int>(std::lround(theValue));
}
}

const char* StatusName(Status theStatus)
{
	switch (theStatus)
	{
	case Status::Playing: return "playing";
	case Status::Won: return "won";
	case Status::Lost: return "lost";
	case Status::Paused: return "paused";
	case Status::Menu:
	default: return "menu";
	}
}

const char* IssueName(Issue theIssue)
{
	switch (theIssue)
	{
	case Issue::None: return "none";
	case Issue::StaleState: return "stale_state";
	case Issue::FutureState: return "future_state";
	case Issue::NotPlaying: return "not_playing";
	case Issue::BadAction: return "bad_action";
	case Issue::UnsupportedAction: return "unsupported_action";
	case Issue::OutOfBounds: return "out_of_bounds";
	case Issue::Occupied: return "occupied";
	case Issue::Blocked: return "blocked";
	case Issue::NoPlant: return "no_plant";
	case Issue::MissingCard: return "missing_card";
	case Issue::Cooldown: return "cooldown";
	case Issue::InsufficientSun: return "insufficient_sun";
	case Issue::SunMissing: return "sun_missing";
	case Issue::NoNextLevel: return "no_next_level";
	case Issue::NoEffect: return "no_effect";
	case Issue::DuplicateCommand: return "duplicate_command";
	}
	return "unknown";
}

bool SameState(const Snapshot& theLeft, const Snapshot& theRight)
{
	if (theLeft.gameId != theRight.gameId ||
		theLeft.level != theRight.level ||
		theLeft.wave != theRight.wave ||
		theLeft.totalWaves != theRight.totalWaves ||
		theLeft.sun != theRight.sun ||
		theLeft.rows != theRight.rows ||
		theLeft.columns != theRight.columns ||
		theLeft.status != theRight.status ||
		theLeft.hasNextLevel != theRight.hasNextLevel ||
		theLeft.plants.size() != theRight.plants.size() ||
		theLeft.zombies.size() != theRight.zombies.size() ||
		theLeft.cards.size() != theRight.cards.size() ||
		theLeft.suns.size() != theRight.suns.size())
	{
		return false;
	}
	for (std::size_t i = 0; i < theLeft.plants.size(); ++i)
	{
		const auto& a = theLeft.plants[i];
		const auto& b = theRight.plants[i];
		if (a.type != b.type || a.row != b.row || a.col != b.col || a.health != b.health)
			return false;
	}
	for (std::size_t i = 0; i < theLeft.zombies.size(); ++i)
	{
		const auto& a = theLeft.zombies[i];
		const auto& b = theRight.zombies[i];
		if (a.type != b.type || a.row != b.row || std::fabs(a.x - b.x) > 0.0005f || a.health != b.health)
			return false;
	}
	for (std::size_t i = 0; i < theLeft.cards.size(); ++i)
	{
		const auto& a = theLeft.cards[i];
		const auto& b = theRight.cards[i];
		if (a.type != b.type || a.cost != b.cost || a.ready != b.ready)
			return false;
	}
	for (std::size_t i = 0; i < theLeft.suns.size(); ++i)
	{
		const auto& a = theLeft.suns[i];
		const auto& b = theRight.suns[i];
		if (a.id != b.id)
			return false;
	}
	return true;
}

BridgeCore::BridgeCore(IGameFacade& theFacade, std::string theSessionId, long long theStartedAtMs)
	: facade_(theFacade),
	  sessionId_(std::move(theSessionId)),
	  startedAtMs_(theStartedAtMs)
{
}

BridgeCore::~BridgeCore() = default;

Receipt BridgeCore::Validate(const Snapshot& theSnapshot, const Command& theCommand)
{
	Receipt aReceipt;
	aReceipt.commandId = theCommand.commandId;
	const Action& aAction = theCommand.action;

	if (!ValidType(aAction.type))
	{
		aReceipt.issue = Issue::UnsupportedAction;
		return aReceipt;
	}
	if (theCommand.expectedRevision > theSnapshot.revision)
	{
		aReceipt.issue = Issue::FutureState;
		return aReceipt;
	}
	if (aAction.type == kActionNextLevel)
	{
		if (theSnapshot.status != Status::Won)
		{
			aReceipt.issue = Issue::NotPlaying;
			return aReceipt;
		}
		if (!theSnapshot.hasNextLevel)
		{
			aReceipt.issue = Issue::NoNextLevel;
			return aReceipt;
		}
		aReceipt.issue = Issue::None;
		aReceipt.status = "applied";
		return aReceipt;
	}
	if (theSnapshot.status != Status::Playing)
	{
		aReceipt.issue = Issue::NotPlaying;
		return aReceipt;
	}
	if (aAction.type == kActionCollectSun)
	{
		const bool aPresent = std::any_of(theSnapshot.suns.begin(), theSnapshot.suns.end(),
			[&](const SunView& theSun) { return theSun.id == aAction.id; });
		aReceipt.issue = aPresent ? Issue::None : Issue::SunMissing;
		aReceipt.status = aPresent ? "applied" : "rejected";
		return aReceipt;
	}

	const bool aInBounds = aAction.row >= 1 && aAction.row <= theSnapshot.rows &&
		aAction.col >= 1 && aAction.col <= theSnapshot.columns;
	if (aAction.type == kActionShovel)
	{
		if (!aInBounds)
		{
			aReceipt.issue = Issue::OutOfBounds;
			return aReceipt;
		}
		const bool aHasPlant = std::any_of(theSnapshot.plants.begin(), theSnapshot.plants.end(),
			[&](const PlantView& thePlant) {
				return thePlant.row == aAction.row && thePlant.col == aAction.col;
			});
		aReceipt.issue = aHasPlant ? Issue::None : Issue::NoPlant;
		aReceipt.status = aHasPlant ? "applied" : "rejected";
		return aReceipt;
	}

	// plant
	if (!aInBounds)
	{
		aReceipt.issue = Issue::OutOfBounds;
		return aReceipt;
	}
	for (const auto& aPlant : theSnapshot.plants)
	{
		if (aPlant.row == aAction.row && aPlant.col == aAction.col)
		{
			aReceipt.issue = Issue::Occupied;
			return aReceipt;
		}
	}
	const CardView* aCard = nullptr;
	for (const auto& aCandidate : theSnapshot.cards)
	{
		if (aCandidate.type == aAction.plant)
		{
			aCard = &aCandidate;
			break;
		}
	}
	if (aCard == nullptr)
	{
		aReceipt.issue = Issue::MissingCard;
		return aReceipt;
	}
	if (!aCard->ready)
	{
		aReceipt.issue = Issue::Cooldown;
		return aReceipt;
	}
	if (aCard->cost > theSnapshot.sun)
	{
		aReceipt.issue = Issue::InsufficientSun;
		return aReceipt;
	}
	aReceipt.issue = Issue::None;
	aReceipt.status = "applied";
	return aReceipt;
}

Receipt BridgeCore::Execute(const Snapshot& theSnapshot, const Command& theCommand)
{
	Receipt aReceipt = Validate(theSnapshot, theCommand);
	if (aReceipt.issue != Issue::None)
	{
		aReceipt.status = "rejected";
		aReceipt.revisionBefore = theSnapshot.revision;
		aReceipt.revisionAfter = theSnapshot.revision;
		return aReceipt;
	}

	Issue aIssue = Issue::None;
	const Action& aAction = theCommand.action;
	if (aAction.type == kActionPlant)
		aIssue = facade_.PlacePlant(aAction);
	else if (aAction.type == kActionCollectSun)
		aIssue = facade_.CollectSun(aAction);
	else if (aAction.type == kActionShovel)
		aIssue = facade_.Shovel(aAction);
	else if (aAction.type == kActionNextLevel)
		aIssue = facade_.NextLevel();

	aReceipt.revisionBefore = theSnapshot.revision;
	aReceipt.revisionAfter = theSnapshot.revision;
	if (aIssue != Issue::None)
	{
		aReceipt.status = "rejected";
		aReceipt.issue = aIssue;
		return aReceipt;
	}
	aReceipt.status = "applied";
	aReceipt.issue = Issue::None;
	return aReceipt;
}

void BridgeCore::Commit(Snapshot theFresh, bool theForceBump)
{
	std::lock_guard<std::mutex> aLock(mutex_);
	if (!hasSnapshot_)
		revision_ = 1;
	else if (theForceBump || !SameState(theFresh, snapshot_))
		revision_ += 1;
	theFresh.revision = revision_;
	snapshot_ = std::move(theFresh);
	snapshotJson_ = SerializeSnapshot(snapshot_);
	hasSnapshot_ = true;
}

void BridgeCore::Pump()
{
	Snapshot aBefore = facade_.Capture();

	Queued aItem;
	bool aHasItem = false;
	{
		std::lock_guard<std::mutex> aLock(mutex_);
		if (!queue_.empty())
		{
			aItem = std::move(queue_.front());
			queue_.pop_front();
			aHasItem = true;
		}
		if (!hasSnapshot_)
			aBefore.revision = 1;
		else
			aBefore.revision = revision_;
	}

	if (!aHasItem)
	{
		Commit(std::move(aBefore), false);
		return;
	}

	Receipt aReceipt = Execute(aBefore, aItem.command);
	Snapshot aAfter = aReceipt.status == "applied" ? facade_.Capture() : aBefore;
	const bool aObservable = aReceipt.status == "applied" && !SameState(aBefore, aAfter);
	Commit(std::move(aAfter), aObservable);

	if (aReceipt.status == "applied" && !aObservable)
	{
		aReceipt.status = "rejected";
		aReceipt.issue = Issue::NoEffect;
	}

	int aRevision = 0;
	{
		std::lock_guard<std::mutex> aLock(mutex_);
		aRevision = revision_;
	}
	aReceipt.revisionBefore = aBefore.revision;
	aReceipt.revisionAfter = aReceipt.status == "applied" ? aRevision : aBefore.revision;
	if (aReceipt.status != "applied")
		aReceipt.revisionAfter = aReceipt.revisionBefore;

	{
		std::lock_guard<std::mutex> aLock(mutex_);
		Remember(aReceipt);
	}
	Respond(aItem.seq, ReceiptEnvelope(aReceipt));
}

void BridgeCore::Remember(const Receipt& theReceipt)
{
	receipts_[theReceipt.commandId] = theReceipt;
	receiptOrder_.push_back(theReceipt.commandId);
	while (receiptOrder_.size() > kMaxReceipts)
	{
		receipts_.erase(receiptOrder_.front());
		receiptOrder_.pop_front();
	}
}

bool BridgeCore::LookupReceipt(const std::string& theCommandId, Receipt& theOut) const
{
	const auto aIt = receipts_.find(theCommandId);
	if (aIt == receipts_.end())
		return false;
	theOut = aIt->second;
	return true;
}

void BridgeCore::Respond(std::uint64_t theSeq, const std::string& theBody)
{
	std::shared_ptr<Slot> aSlot;
	{
		std::lock_guard<std::mutex> aLock(mutex_);
		const auto aIt = slots_.find(theSeq);
		if (aIt == slots_.end())
			return;
		aSlot = aIt->second;
		slots_.erase(aIt);
		for (auto aFlight = inFlight_.begin(); aFlight != inFlight_.end(); ++aFlight)
		{
			if (aFlight->second == theSeq)
			{
				inFlight_.erase(aFlight);
				break;
			}
		}
	}
	std::lock_guard<std::mutex> aSlotLock(aSlot->mutex);
	aSlot->response = theBody;
	aSlot->done = true;
	aSlot->cv.notify_all();
}

std::string BridgeCore::CommandEnvelope(std::string_view theBody, int& theHttpStatus)
{
	theHttpStatus = 200;
	if (theBody.size() > kMaxRequestBody)
	{
		theHttpStatus = 413;
		return "{\"error\":\"body_too_large\"}";
	}
	auto aParsed = ParseJson(theBody);
	if (!aParsed || !aParsed->IsObject())
	{
		theHttpStatus = 400;
		return "{\"error\":\"bad_json\"}";
	}
	const JsonValue* aCommandId = aParsed->Get("commandId");
	const JsonValue* aExpected = aParsed->Get("expectedRevision");
	const JsonValue* aAction = aParsed->Get("action");
	if (!aCommandId || !aCommandId->IsString() || aCommandId->text.empty() || aCommandId->text.size() > 96 ||
		!aExpected || !aExpected->IsNumber() || !aAction || !aAction->IsObject())
	{
		theHttpStatus = 400;
		return "{\"error\":\"bad_command\"}";
	}

	Command aCommand;
	aCommand.commandId = aCommandId->text;
	aCommand.expectedRevision = RoundToInt(aExpected->number);
	if (aCommand.expectedRevision < 0)
	{
		theHttpStatus = 400;
		return "{\"error\":\"bad_command\"}";
	}
	aCommand.action.type = aAction->StringOr("type");
	if (!ValidType(aCommand.action.type))
	{
		theHttpStatus = 400;
		return "{\"error\":\"unsupported_action\"}";
	}
	if (aCommand.action.type == kActionPlant)
	{
		aCommand.action.plant = aAction->StringOr("plant");
		if (aCommand.action.plant.empty() || aCommand.action.plant.size() > 32)
		{
			theHttpStatus = 400;
			return "{\"error\":\"bad_action\"}";
		}
	}
	if (aCommand.action.type == kActionCollectSun)
	{
		aCommand.action.id = aAction->StringOr("id");
		if (aCommand.action.id.empty() || aCommand.action.id.size() > 64)
		{
			theHttpStatus = 400;
			return "{\"error\":\"bad_action\"}";
		}
	}
	if (aCommand.action.type == kActionPlant || aCommand.action.type == kActionShovel)
	{
		aCommand.action.row = RoundToInt(aAction->NumberOr("row", -1));
		aCommand.action.col = RoundToInt(aAction->NumberOr("col", -1));
	}

	auto aSlot = std::make_shared<Slot>();
	std::uint64_t aSeq = 0;
	{
		std::lock_guard<std::mutex> aLock(mutex_);
		Receipt aKnown;
		if (LookupReceipt(aCommand.commandId, aKnown))
		{
			aKnown.status = "duplicate";
			aKnown.issue = Issue::DuplicateCommand;
			return ReceiptEnvelope(aKnown);
		}
		if (inFlight_.count(aCommand.commandId) != 0)
		{
			theHttpStatus = 409;
			return "{\"error\":\"command_in_flight\"}";
		}
		aSeq = nextSeq_++;
		slots_[aSeq] = aSlot;
		inFlight_[aCommand.commandId] = aSeq;
		queue_.push_back(Queued{aSeq, aCommand});
	}

	std::unique_lock<std::mutex> aSlotLock(aSlot->mutex);
	const bool aDone = aSlot->cv.wait_for(aSlotLock, std::chrono::milliseconds(kCommandWaitMs),
		[&] { return aSlot->done; });
	if (!aDone)
	{
		std::lock_guard<std::mutex> aLock(mutex_);
		slots_.erase(aSeq);
		inFlight_.erase(aCommand.commandId);
		theHttpStatus = 504;
		return "{\"error\":\"game_thread_timeout\"}";
	}
	return aSlot->response;
}

std::string BridgeCore::SnapshotEnvelope() const
{
	std::lock_guard<std::mutex> aLock(mutex_);
	if (!hasSnapshot_)
		return "{\"error\":\"no_snapshot\"}";
	return "{\"snapshot\":" + snapshotJson_ + "}";
}

std::string BridgeCore::HealthJson() const
{
	std::lock_guard<std::mutex> aLock(mutex_);
	std::ostringstream aOut;
	aOut << "{\"service\":\"pvz-portable-bridge\""
		 << ",\"schema\":" << kSchemaVersion
		 << ",\"session\":\"" << JsonEscape(sessionId_) << "\""
		 << ",\"ready\":" << (hasSnapshot_ ? "true" : "false")
		 << ",\"revision\":" << revision_
		 << ",\"level\":" << snapshot_.level
		 << ",\"status\":\"" << StatusName(snapshot_.status) << "\""
		 << ",\"uptimeMs\":" << (std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now().time_since_epoch()).count() - startedAtMs_)
		 << '}';
	return aOut.str();
}

int BridgeCore::Revision() const
{
	std::lock_guard<std::mutex> aLock(mutex_);
	return revision_;
}

bool BridgeCore::HasBoard() const
{
	std::lock_guard<std::mutex> aLock(mutex_);
	return hasSnapshot_ && snapshot_.status != Status::Menu;
}

std::size_t BridgeCore::QueueDepth() const
{
	std::lock_guard<std::mutex> aLock(mutex_);
	return queue_.size();
}
}
