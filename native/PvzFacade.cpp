// SPDX-License-Identifier: LGPL-3.0-or-later
#include "PvzFacade.h"

#include <algorithm>
#include <format>
#include <string>
#include <vector>

#include "LawnApp.h"
#include "Lawn/Board.h"
#include "Lawn/Coin.h"
#include "Lawn/Cutscene.h"
#include "Lawn/Plant.h"
#include "Lawn/SeedPacket.h"
#include "Lawn/System/ProfileMgr.h"
#include "Lawn/Widget/SeedChooserScreen.h"
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

/** PvZ works in board pixels; the wire contract uses 1-based cells. */
float CellX(float thePixelX)
{
	return (thePixelX - static_cast<float>(LAWN_XMIN)) / 80.0f;
}

float CellY(float thePixelY)
{
	return (thePixelY - static_cast<float>(LAWN_YMIN)) / 85.0f;
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
	else if (app_->mSeedChooserScreen != nullptr || app_->mGameScene == GameScenes::SCENE_LEVEL_INTRO)
		aSnapshot.status = Status::Intro;
	else
		aSnapshot.status = Status::Menu;

	const bool aAdventure = app_->IsAdventureMode();
	aSnapshot.hasNextLevel = aAdventure ? aSnapshot.level < FINAL_LEVEL : true;
	aSnapshot.freeSeeds = aBoard->HasConveyorBeltSeedBank();

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
			CellX(aZombie->mPosX),
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
		// Suns age in engine ticks (~10 ms); report the remaining life so the
		// controller can tell an urgent sun from a fresh one.
		const int aRemainingTicks = std::max(0, aCoin->GetDisappearTime() - aCoin->mDisappearCounter);
		aSnapshot.suns.push_back(SunView{
			SunId(aBoard, aCoin),
			CellX(aCoin->mPosX),
			CellY(aCoin->mPosY),
			aRemainingTicks * 10
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

	// Conveyor / mini-game banks hand out free seeds; no sun is involved.
	const bool aFreeSeed = aBoard->HasConveyorBeltSeedBank();
	const int aCost = aFreeSeed ? 0 : Plant::GetCost(aSeed);
	if (!aFreeSeed && !aBoard->CanTakeSunMoney(aCost))
		return Issue::InsufficientSun;

	SeedPacket* aPacket = PacketFor(aBoard, aSeed);
	if (aPacket == nullptr)
		return Issue::MissingCard;
	if (aPacket->mRefreshing || aPacket->mRefreshCounter > 0)
		return Issue::Cooldown;

	if (!aFreeSeed && !aBoard->TakeSunMoney(aCost))
		return Issue::InsufficientSun;
	Plant* aNewPlant = aBoard->AddPlant(aCol, aRow, aSeed);
	if (aNewPlant == nullptr)
		return Issue::Blocked;
	if (aBoard->HasConveyorBeltSeedBank())
	{
		// Conveyor seeds are consumed (RemoveSeed), not refreshed.
		aPacket->WasPlanted();
	}
	else
	{
		// Mirror picking the packet up (Deactivate) and placing it (WasPlanted):
		// the refresh counter only advances while the packet is inactive.
		aPacket->Deactivate();
		aPacket->WasPlanted();
	}
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
	app_->KillAwardScreen();
	app_->UpdatePlayerProfileForFinishingLevel();
	app_->NewGame();
	return Issue::None;
}

std::string PvzFacade::DiagnosticsJson()
{
	if (app_ == nullptr)
		return "{}";
	Board* aBoard = app_->mBoard;
	std::string aOut = std::format(
		"{{\"scene\":{},\"active\":{},\"minimized\":{},\"paused\":{}",
		static_cast<int>(app_->mGameScene),
		app_->mActive ? "true" : "false",
		app_->mMinimized ? "true" : "false",
		(aBoard != nullptr && aBoard->mPaused) ? "true" : "false");
	if (aBoard != nullptr)
	{
		aOut += std::format(
			",\"tutorial\":{},\"seedChoosing\":{},\"boardUpdates\":{},\"sunCountdown\":{}"
			",\"zombieCountdown\":{},\"wave\":{},\"totalWaves\":{},\"packets\":{},"
			"\"cutsceneTime\":{},\"preUpdating\":{},\"crazyDaveMsg\":{},\"chooseSeeds\":{},"
			"\"gameMode\":{},\"boardLevel\":{},\"finishedAdventure\":{},\"firstTime\":{},"
			"\"draws\":{},\"updates\":{},\"sleeps\":{}",
			static_cast<int>(aBoard->mTutorialState),
			(aBoard->mCutScene != nullptr && aBoard->mCutScene->mSeedChoosing) ? "true" : "false",
			aBoard->mBoardUpdateCounter,
			aBoard->mSunCountDown,
			aBoard->mZombieCountDown,
			aBoard->mCurrentWave,
			aBoard->mNumWaves,
			(aBoard->mSeedBank != nullptr) ? aBoard->mSeedBank->mNumPackets : -1,
			(aBoard->mCutScene != nullptr) ? aBoard->mCutScene->mCutsceneTime : -1,
			(aBoard->mCutScene != nullptr && aBoard->mCutScene->mPreUpdatingBoard) ? "true" : "false",
			app_->mCrazyDaveMessageIndex,
			aBoard->ChooseSeedsOnCurrentLevel() ? "true" : "false",
			static_cast<int>(app_->mGameMode),
			aBoard->mLevel,
			(app_->mPlayerInfo != nullptr) ? app_->mPlayerInfo->mFinishedAdventure : -1,
			app_->IsFirstTimeAdventureMode() ? "true" : "false",
			app_->mDrawCount,
			app_->mUpdateCount,
			app_->mSleepCount);
	}
	aOut += "}";
	return aOut;
}

Issue PvzFacade::EnterAdventure()
{
	if (app_ == nullptr)
		return Issue::NotPlaying;
	if (app_->mBoard != nullptr || app_->mSeedChooserScreen != nullptr)
		return Issue::NotPlaying;

	// The engine dereferences mPlayerInfo when building a board. A fresh install
	// has no profile yet (the UI would show the New User dialog), so create the
	// default one here, exactly like FinishCreateUserDialog does.
	if (!app_->mProfileMgr)
		return Issue::NotPlaying;
	PlayerInfo* aProfile = app_->mPlayerInfo;
	if (aProfile == nullptr)
	{
		aProfile = app_->mProfileMgr->GetAnyProfile();
		if (aProfile == nullptr)
			aProfile = app_->mProfileMgr->AddProfile("BigFish");
		if (aProfile == nullptr)
			return Issue::NotPlaying;
	}
	// A bot profile skips the first-time tutorial: it cannot answer the scripted
	// "pick up the peashooter" steps, and the tutorial freezes sun and wave
	// spawning until they are done. Difficulty is unchanged.
	if (aProfile->mFinishedAdventure == 0)
	{
		aProfile->mFinishedAdventure = 1;
		app_->mProfileMgr->Save();
	}
	app_->mPlayerInfo = aProfile;

	// Start the profile's current level. FastLoad is the engine's own "skip the
	// title screen and start" path: it removes mTitleScreen before building the
	// board. Calling PreNewGame directly leaves the title widget on top, so the
	// board plays invisibly underneath it.
	if (app_->mGameSelector)
		app_->KillGameSelector();
	if (app_->mTitleScreen)
		app_->FastLoad(GameMode::GAMEMODE_ADVENTURE);
	else
		app_->PreNewGame(GameMode::GAMEMODE_ADVENTURE, false);
	return Issue::None;
}

Issue PvzFacade::ChooseSeeds()
{
	if (app_ == nullptr)
		return Issue::NoSeedChooser;

	// Crazy Dave can be holding the intro (he freezes the cutscene clock until
	// every line has been clicked through). Advance him exactly like a click,
	// even on levels that do not offer a seed chooser.
	int aDaveGuard = 0;
	while (app_->mCrazyDaveMessageIndex != -1 && aDaveGuard++ < 64)
	{
		if (!app_->AdvanceCrazyDaveText())
			app_->CrazyDaveLeave();
	}

	// Conveyor-belt and mini-game levels have no chooser: dismissing Dave above
	// is the whole job, the cutscene then starts the level by itself.
	if (app_->mSeedChooserScreen == nullptr)
		return Issue::None;
	SeedChooserScreen* aChooser = app_->mSeedChooserScreen.get();
	Board* aBoard = app_->mBoard;
	if (aBoard == nullptr || aBoard->mSeedBank == nullptr)
		return Issue::NoSeedChooser;
	if (aChooser->mSeedsInFlight > 0)
		return Issue::NoSeedChooser;

	const int aSlots = aBoard->mSeedBank->mNumPackets;
	if (aSlots <= 0 || aSlots > SEEDBANK_MAX)
		return Issue::NoSeedChooser;

	// Start from a clean chooser: previous attempts may have left packets in the
	// bank, and CloseSeedChooser maps slots by index.
	for (int anIndex = static_cast<int>(SeedType::SEED_PEASHOOTER);
		anIndex < static_cast<int>(NUM_SEEDS_IN_CHOOSER); ++anIndex)
	{
		ChosenSeed& aSeed = aChooser->mChosenSeeds[anIndex];
		if (aSeed.mSeedState == ChosenSeedState::SEED_IN_BANK)
		{
			aSeed.mSeedState = ChosenSeedState::SEED_IN_CHOOSER;
			aSeed.mSeedIndexInBank = -1;
		}
	}

	std::vector<SeedType> aAvailable;
	for (int anIndex = static_cast<int>(SeedType::SEED_PEASHOOTER);
		anIndex < static_cast<int>(NUM_SEEDS_IN_CHOOSER); ++anIndex)
	{
		const SeedType aSeed = static_cast<SeedType>(anIndex);
		if (aSeed == SeedType::SEED_IMITATER)
			continue;
		if (!app_->HasSeedType(aSeed))
			continue;
		if (aChooser->SeedNotAllowedToPick(aSeed))
			continue;
		if (aChooser->mChosenSeeds[aSeed].mSeedState != ChosenSeedState::SEED_IN_CHOOSER)
			continue;
		aAvailable.push_back(aSeed);
	}
	if (static_cast<int>(aAvailable.size()) < aSlots)
		return Issue::NoSeedChooser;

	// Deterministic preference order; the strategy only uses the first four.
	static const SeedType aPreferred[] = {
		SeedType::SEED_SUNFLOWER, SeedType::SEED_PEASHOOTER, SeedType::SEED_WALLNUT,
		SeedType::SEED_SNOWPEA, SeedType::SEED_REPEATER, SeedType::SEED_CHERRYBOMB,
		SeedType::SEED_POTATOMINE, SeedType::SEED_CHOMPER,
		SeedType::SEED_LILYPAD, SeedType::SEED_FLOWERPOT
	};
	std::vector<SeedType> aChosen;
	for (const SeedType aWant : aPreferred)
	{
		if (std::find(aAvailable.begin(), aAvailable.end(), aWant) != aAvailable.end())
			aChosen.push_back(aWant);
	}
	for (const SeedType aSeed : aAvailable)
	{
		if (static_cast<int>(aChosen.size()) >= aSlots)
			break;
		if (std::find(aChosen.begin(), aChosen.end(), aSeed) == aChosen.end())
			aChosen.push_back(aSeed);
	}
	aChosen.resize(static_cast<std::size_t>(aSlots));

	for (int anIndex = 0; anIndex < aSlots; ++anIndex)
	{
		ChosenSeed& aSeed = aChooser->mChosenSeeds[aChosen[static_cast<std::size_t>(anIndex)]];
		int aX = 0;
		int aY = 0;
		aChooser->GetSeedPositionInBank(anIndex, aX, aY);
		aSeed.mSeedIndexInBank = anIndex;
		aSeed.mSeedState = ChosenSeedState::SEED_IN_BANK;
		aSeed.mX = aX;
		aSeed.mY = aY;
		aSeed.mStartX = aX;
		aSeed.mStartY = aY;
		aSeed.mEndX = aX;
		aSeed.mEndY = aY;
		aSeed.mTimeStartMotion = 0;
		aSeed.mTimeEndMotion = 0;
		aSeed.mRefreshing = false;
		aSeed.mRefreshCounter = 0;
	}
	aChooser->mSeedsInBank = aSlots;
	aChooser->CloseSeedChooser();
	return Issue::None;
}
}
