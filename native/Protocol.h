// BigFish vs Zombies — native bridge wire contract (schema 1).
// SPDX-License-Identifier: LGPL-3.0-or-later
#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace bigfish
{
constexpr int kSchemaVersion = 1;
constexpr std::size_t kMaxRequestBody = 64 * 1024;
constexpr std::size_t kMaxReceipts = 512;
constexpr int kRows = 5;
constexpr int kColumns = 9;
constexpr int kCommandWaitMs = 2500;

enum class Status
{
	Menu,
	/** Level intro / seed chooser: the board exists but the level is not live. */
	Intro,
	Playing,
	Won,
	Lost,
	Paused
};

const char* StatusName(Status theStatus);

/** Rejection reasons. Stable strings: the controller branches on these. */
enum class Issue
{
	None,
	StaleState,
	FutureState,
	NotPlaying,
	BadAction,
	UnsupportedAction,
	OutOfBounds,
	Occupied,
	Blocked,
	NoPlant,
	MissingCard,
	Cooldown,
	InsufficientSun,
	SunMissing,
	NoNextLevel,
	NoSeedChooser,
	NoEffect,
	DuplicateCommand
};

const char* IssueName(Issue theIssue);

struct PlantView
{
	std::string type;
	int row = 0;
	int col = 0;
	int health = 0;
};

struct ZombieView
{
	std::string type;
	int row = 0;
	float x = 0.0f;
	int health = 0;
};

struct CardView
{
	std::string type;
	int cost = 0;
	bool ready = false;
};

struct SunView
{
	std::string id;
	float x = 0.0f;
	float y = 0.0f;
	int expiresInMs = 0;
};

struct Snapshot
{
	std::string gameId;
	int revision = 0;
	int level = 1;
	int wave = 0;
	int totalWaves = 0;
	int sun = 0;
	int rows = kRows;
	int columns = kColumns;
	Status status = Status::Menu;
	bool hasNextLevel = true;
	/** Conveyor / mini-game banks hand out free seeds: sun is irrelevant. */
	bool freeSeeds = false;
	std::vector<PlantView> plants;
	std::vector<ZombieView> zombies;
	std::vector<CardView> cards;
	std::vector<SunView> suns;
};

struct Action
{
	std::string type;
	std::string plant;
	std::string id;
	int row = 0;
	int col = 0;
};

struct Command
{
	std::string commandId;
	int expectedRevision = 0;
	Action action;
};

struct Receipt
{
	std::string commandId;
	std::string status = "rejected";
	Issue issue = Issue::None;
	int revisionBefore = 0;
	int revisionAfter = 0;
};

/** True when two captures describe the same observable game state. */
bool SameState(const Snapshot& theLeft, const Snapshot& theRight);
}
