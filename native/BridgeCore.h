// Game-agnostic bridge core: revisioned snapshots, at-most-once commands.
// SPDX-License-Identifier: LGPL-3.0-or-later
#pragma once

#include <condition_variable>
#include <cstdint>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>

#include "GameFacade.h"

namespace bigfish
{
/**
 * Threading model
 *  - `Pump()` runs on the game thread only. It captures state and applies at
 *    most one queued command per call, so a frame is never blocked by a burst.
 *  - HTTP threads only parse, deduplicate and enqueue. They never touch the
 *    game, and they wait for the game thread to answer with a receipt.
 */
class BridgeCore
{
public:
	BridgeCore(IGameFacade& theFacade, std::string theSessionId, long long theStartedAtMs);
	~BridgeCore();

	BridgeCore(const BridgeCore&) = delete;
	BridgeCore& operator=(const BridgeCore&) = delete;

	/** Game thread: capture state, apply at most one command, publish. */
	void Pump();

	/** Server thread: `GET /v1/snapshot` body. */
	std::string SnapshotEnvelope() const;

	/** Server thread: `GET /v1/health` body. */
	std::string HealthJson() const;

	/**
	 * Server thread: `POST /v1/command` body.
	 * Returns the JSON envelope and sets the HTTP status code. A 504 means the
	 * command may or may not be executing: the client must treat it as unknown.
	 */
	std::string CommandEnvelope(std::string_view theBody, int& theHttpStatus);

	int Revision() const;
	std::uint64_t PumpCount() const;
	bool HasBoard() const;
	std::size_t QueueDepth() const;

	/** Exposed for the native test harness. */
	static Receipt Validate(const Snapshot& theSnapshot, const Command& theCommand);

private:
	struct Slot
	{
		std::mutex mutex;
		std::condition_variable cv;
		std::string response;
		bool done = false;
	};

	struct Queued
	{
		std::uint64_t seq = 0;
		Command command;
	};

	Receipt Execute(const Snapshot& theSnapshot, const Command& theCommand);
	void Commit(Snapshot theFresh, bool theForceBump);
	void Remember(const Receipt& theReceipt);
	bool LookupReceipt(const std::string& theCommandId, Receipt& theOut) const;
	void Respond(std::uint64_t theSeq, const std::string& theBody);

	IGameFacade& facade_;
	std::string sessionId_;
	long long startedAtMs_;

	mutable std::mutex mutex_;
	std::deque<Queued> queue_;
	std::map<std::uint64_t, std::shared_ptr<Slot>> slots_;
	std::map<std::string, Receipt> receipts_;
	std::map<std::string, std::uint64_t> inFlight_;
	std::deque<std::string> receiptOrder_;
	Snapshot snapshot_;
	std::string snapshotJson_;
	std::string diagnosticsJson_ = "{}";
	bool hasSnapshot_ = false;
	int revision_ = 0;
	std::uint64_t nextSeq_ = 1;
	std::uint64_t pumpCount_ = 0;
};
}
