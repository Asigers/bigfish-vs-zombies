// SPDX-License-Identifier: LGPL-3.0-or-later
#include "PvzFacade.h"

#include <algorithm>
#include <string>

#include "LawnApp.h"
#include "Lawn/Board.h"
#include "Lawn/Coin.h"
#include "Lawn/Plant.h"
#include "Lawn/SeedPacket.h"
#include "Lawn/Zombie.h"

namespace bigfish
{
namespace
{
using SeedTypeAlias = SeedType;

std::string SeedName(SeedType theType)
{
	switch (theType)
	{
	case SeedType::SEED_SUNFLOWER: return "sunflower";
	case SeedType::SEED_PEASHOOTER: return "peashooter";
	case SeedType::SEED_WALLNUT: return "wallnut";
	case SeedType::SEED_SNOWPEA: return "snowpea";
	case SeedType::SEED_REPEATER: return "repeater";
	case SeedType::SEED_CHERRYBOMB: return "cherrybomb";
	case SeedType::SEED_POTATOMINE: return "potatomine";
	case SeedType::SEED_CHOMPER: return "chomper";
	default: return "other";
	}
}

bool SeedFromName(const std::string& theName, SeedType& theOut)
{
	if (theName == "sunflower") { theOut = SeedType::SEED_SUNFLOWER; return true; }
	if (theName == "peashooter") { theOut = SeedType::SEED_PEASHOOTER; return true; }
	if (theName == "wallnut") { theOut = SeedType::SEED_WALLNUT; return true; }
	if (theName == "snowpea") { theOut = SeedType::SEED_SNOWPEA; return true; }
	if (theName == "repeater") { theOut = SeedType::SEED_REPEATER; return true; }
	if (theName == "cherrybomb") { theOut = SeedType::SEED_CHERRYBOMB; return true; }
	if (theName == "potatomine") { theOut = SeedType::SEED_POTATOMINE; return true; }
	if (theName == "chomper") { theOut = SeedType::SEED_CHOMPER; return true; }
	return false;
}

std::string ZombieName(ZombieType theType)
{
	switch (theType)
	{
	case ZombieType::ZOMBIE_NORMAL: return "normal";
	case ZombieType::ZOMBIE_FLAG: return "flag";
	case ZombieType::ZOMBIE_TRAFFIC_CONE: return "cone";
	case ZombieType::ZOMBIE_PAIL: return "bucket";
	case ZombieType::ZOMBIE_FOOTBALL: return "football";
	case ZombieType::ZOMBIE_GARGANTUAR: return "gargantuar";
	default: return "other";
	}
}

std::string SunId(Board* theBoard, Coin* theCoin)
{
	return "coin" + std::to_string(theBoard->mCoins.DataArrayGetID(theCoin));
}

SeedPacket* PacketFor(Board* theBoard, SeedType theSeed)
{
	if (!theBoard->mSeedBank)
		return nullptr;
	const int aCount = std::min(theBoard->mSeedBank->mNumPackets, SEEDBANK_MAX);
	for (int i = 0; i < aCount; ++i)
	{
		SeedPacket& aPacket = theBoard->mSeedBank->mSeedPackets[i];
		if (aPacket.mPacketType == theSeed)
			return &aPacket;
	}
	return nullptr;
}
}

PvzFacade::PvzFacade(LawnApp* theApp) : app_(theApp) {}

Snapshot PvzFacade::Capture()
{
	Snapshot aSnapshot;
	aSnapshot.rows = kRows;
	aSnapshot.columns = kColumns;
	aSnapshot.gameId = "pvz-portable";
	if (app_ == nullptr)
		return aSnapshot;

	Board* aBoard = app_->mBoard;
	if (aBoard == nullptr)
	{
		aSnapshot.status = Status::Menu;
		return aSnapshot;
	}

	aSnapshot.level = std::max(1, aBoard->mLevel);
	aSnapshot.wave = std::max(0, aBoard->mCurrentWave);
	aSnapshot.totalWaves = std::max(0, aBoard->mNumWaves);
	aSnapshot.sun = std::max(0, aBoard->mSunMoney);

	if (app_->mBoardResult == BoardResult::BOARDRESULT_LOST || app_->mGameScene == GameScenes::SCENE_ZOMBIES_WON)
		aSnapshot.status = Status::Lost;
	else if (aBoard->mLevelComplete || app_->mGameScene == GameScenes::SCENE_AWARD ||
		app_->mBoardResult == BoardResult::BOARDRESULT_WON)
		aSnapshot.status = Status::Won;
	else if (aBoard->mPaused)
		aSnapshot.status = Status::Paused;
	else if (app_->mGameScene == GameScenes::SCENE_PLAYING)
		aSnapshot.status = Status::Playing;
	else
		aSnapshot.status = Status::Menu;

	const bool aAdventure = app_->IsAdventureMode();
	aSnapshot.hasNextLevel = aAdventure ? aSnapshot.level < FINAL_LEVEL : true;

	for (Plant* aPlant : aBoard->mPlants)
	{
		if (aPlant == nullptr || aPlant->mDead)
			continue;
		aSnapshot.plants.push_back(PlantView{
			SeedName(aPlant->mSeedType),
			aPlant->mRow + 1,
			aPlant->mPlantCol + 1,
			std::max(0, aPlant->mPlantHealth)
		});
	}

	for (Zombie* aZombie : aBoard->mZombies)
	{
		if (aZombie == nullptr || aZombie->mDead)
			continue;
		aSnapshot.zombies.push_back(ZombieView{
			ZombieName(aZombie->mZombieType),
			aZombie->mRow + 1,
			aZombie->mPosX,
			std::max(0, aZombie->mBodyHealth) + std::max(0, aZombie->mHelmHealth)
		});
	}

	if (aBoard->mSeedBank)
	{
		const int aCount = std::min(aBoard->mSeedBank->mNumPackets, SEEDBANK_MAX);
		for (int i = 0; i < aCount; ++i)
		{
			const SeedPacket& aPacket = aBoard->mSeedBank->mSeedPackets[i];
			if (aPacket.mPacketType == SeedType::SEED_NONE)
				continue;
			const bool aReady = !aPacket.mRefreshing && aPacket.mRefreshCounter <= 0;
			aSnapshot.cards.push_back(CardView{
				SeedName(aPacket.mPacketType),
				Plant::GetCost(aPacket.mPacketType),
				aReady
			});
		}
	}

	for (Coin* aCoin : aBoard->mCoins)
	{
		if (aCoin == nullptr || aCoin->mDead || aCoin->mIsBeingCollected || !aCoin->IsSun())
			continue;
		aSnapshot.suns.push_back(SunView{
			SunId(aBoard, aCoin),
			aCoin->mPosX,
			aCoin->mPosY,
			0 // remaining lifetime is engine-internal; the policy treats it as unknown
		});
	}

	return aSnapshot;
}

Issue PvzFacade::PlacePlant(const Action& theAction)
{
	Board* aBoard = app_ ? app_->mBoard : nullptr;
	if (aBoard == nullptr)
		return Issue::NotPlaying;

	SeedType aSeed = SeedType::SEED_NONE;
	if (!SeedFromName(theAction.plant, aSeed))
		return Issue::MissingCard;

	const int aCol = theAction.col - 1;
	const int aRow = theAction.row - 1;
	if (aCol < 0 || aCol >= kColumns || aRow < 0 || aRow >= kRows)
		return Issue::OutOfBounds;

	if (aBoard->CanPlantAt(aCol, aRow, aSeed) != PlantingReason::PLANTING_OK)
		return Issue::Blocked;

	const int aCost = Plant::GetCost(aSeed);
	if (!aBoard->CanTakeSunMoney(aCost))
		return Issue::InsufficientSun;

	SeedPacket* aPacket = PacketFor(aBoard, aSeed);
	if (aPacket == nullptr)
		return Issue::MissingCard;
	if (aPacket->mRefreshing || aPacket->mRefreshCounter > 0)
		return Issue::Cooldown;

	if (!aBoard->TakeSunMoney(aCost))
		return Issue::InsufficientSun;
	Plant* aNewPlant = aBoard->AddPlant(aCol, aRow, aSeed);
	if (aNewPlant == nullptr)
		return Issue::Blocked;
	aPacket->WasPlanted();
	return Issue::None;
}

Issue PvzFacade::CollectSun(const Action& theAction)
{
	Board* aBoard = app_ ? app_->mBoard : nullptr;
	if (aBoard == nullptr)
		return Issue::NotPlaying;

	for (Coin* aCoin : aBoard->mCoins)
	{
		if (aCoin == nullptr || aCoin->mDead || aCoin->mIsBeingCollected || !aCoin->IsSun())
			continue;
		if (SunId(aBoard, aCoin) != theAction.id)
			continue;
		aCoin->PlayCollectSound();
		aCoin->Collect();
		return Issue::None;
	}
	return Issue::SunMissing;
}

Issue PvzFacade::Shovel(const Action& theAction)
{
	Board* aBoard = app_ ? app_->mBoard : nullptr;
	if (aBoard == nullptr)
		return Issue::NotPlaying;

	for (Plant* aPlant : aBoard->mPlants)
	{
		if (aPlant == nullptr || aPlant->mDead)
			continue;
		if (aPlant->mRow != theAction.row - 1 || aPlant->mPlantCol != theAction.col - 1)
			continue;
		aPlant->Die();
		aBoard->mPlantsShoveled++;
		return Issue::None;
	}
	return Issue::NoPlant;
}

Issue PvzFacade::NextLevel()
{
	if (app_ == nullptr || app_->mBoard == nullptr)
		return Issue::NotPlaying;
	Board* aBoard = app_->mBoard;
	const bool aWon = aBoard->mLevelComplete || app_->mBoardResult == BoardResult::BOARDRESULT_WON;
	if (!aWon)
		return Issue::NoNextLevel;
	if (app_->IsAdventureMode() && aBoard->mLevel >= FINAL_LEVEL)
		return Issue::NoNextLevel;

	// Same bookkeeping the award screen performs: advance the profile, then let
	// the engine build the next board. A seed chooser appears; the controller
	// must not send plant commands until it is dismissed.
	app_->UpdatePlayerProfileForFinishingLevel();
	app_->NewGame();
	return Issue::None;
}
}
