// SPDX-License-Identifier: LGPL-3.0-or-later
#include "PvzFacade.h"

#include <algorithm>
#include <format>
#include <string>
#include <utility>
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
	case SeedType::SEED_PEASHOOTER: return "peashooter";
	case SeedType::SEED_SUNFLOWER: return "sunflower";
	case SeedType::SEED_CHERRYBOMB: return "cherrybomb";
	case SeedType::SEED_WALLNUT: return "wallnut";
	case SeedType::SEED_POTATOMINE: return "potatomine";
	case SeedType::SEED_SNOWPEA: return "snowpea";
	case SeedType::SEED_CHOMPER: return "chomper";
	case SeedType::SEED_REPEATER: return "repeater";
	case SeedType::SEED_PUFFSHROOM: return "puffshroom";
	case SeedType::SEED_SUNSHROOM: return "sunshroom";
	case SeedType::SEED_FUMESHROOM: return "fumeshroom";
	case SeedType::SEED_GRAVEBUSTER: return "gravebuster";
	case SeedType::SEED_HYPNOSHROOM: return "hypnoshroom";
	case SeedType::SEED_SCAREDYSHROOM: return "scaredyshroom";
	case SeedType::SEED_ICESHROOM: return "iceshroom";
	case SeedType::SEED_DOOMSHROOM: return "doomshroom";
	case SeedType::SEED_LILYPAD: return "lilypad";
	case SeedType::SEED_SQUASH: return "squash";
	case SeedType::SEED_THREEPEATER: return "threepeater";
	case SeedType::SEED_TANGLEKELP: return "tanglekelp";
	case SeedType::SEED_JALAPENO: return "jalapeno";
	case SeedType::SEED_SPIKEWEED: return "spikeweed";
	case SeedType::SEED_TORCHWOOD: return "torchwood";
	case SeedType::SEED_TALLNUT: return "tallnut";
	case SeedType::SEED_SEASHROOM: return "seashroom";
	case SeedType::SEED_PLANTERN: return "plantern";
	case SeedType::SEED_CACTUS: return "cactus";
	case SeedType::SEED_BLOVER: return "blover";
	case SeedType::SEED_SPLITPEA: return "splitpea";
	case SeedType::SEED_STARFRUIT: return "starfruit";
	case SeedType::SEED_PUMPKINSHELL: return "pumpkinshell";
	case SeedType::SEED_MAGNETSHROOM: return "magnetshroom";
	case SeedType::SEED_CABBAGEPULT: return "cabbagepult";
	case SeedType::SEED_FLOWERPOT: return "flowerpot";
	case SeedType::SEED_KERNELPULT: return "kernelpult";
	case SeedType::SEED_INSTANT_COFFEE: return "instantcoffee";
	case SeedType::SEED_GARLIC: return "garlic";
	case SeedType::SEED_UMBRELLA: return "umbrella";
	case SeedType::SEED_MARIGOLD: return "marigold";
	case SeedType::SEED_MELONPULT: return "melonpult";
	case SeedType::SEED_GATLINGPEA: return "gatlingpea";
	case SeedType::SEED_TWINSUNFLOWER: return "twinsunflower";
	case SeedType::SEED_GLOOMSHROOM: return "gloomshroom";
	case SeedType::SEED_CATTAIL: return "cattail";
	case SeedType::SEED_WINTERMELON: return "wintermelon";
	case SeedType::SEED_GOLD_MAGNET: return "goldmagnet";
	case SeedType::SEED_SPIKEROCK: return "spikerock";
	case SeedType::SEED_COBCANNON: return "cobcannon";
	case SeedType::SEED_IMITATER: return "imitater";
	default: return "unknown";
	}
}

bool SeedFromName(const std::string& theName, SeedType& theOut)
{
	for (int anIndex = static_cast<int>(SeedType::SEED_PEASHOOTER);
		anIndex < static_cast<int>(NUM_SEEDS_IN_CHOOSER); ++anIndex)
	{
		const SeedType aSeed = static_cast<SeedType>(anIndex);
		if (aSeed != SeedType::SEED_IMITATER && SeedName(aSeed) == theName)
		{
			theOut = aSeed;
			return true;
		}
	}
	return false;
}

SeedType UpgradeRequirement(SeedType theType)
{
	switch (theType)
	{
	case SeedType::SEED_GATLINGPEA: return SeedType::SEED_REPEATER;
	case SeedType::SEED_WINTERMELON: return SeedType::SEED_MELONPULT;
	case SeedType::SEED_TWINSUNFLOWER: return SeedType::SEED_SUNFLOWER;
	case SeedType::SEED_SPIKEROCK: return SeedType::SEED_SPIKEWEED;
	case SeedType::SEED_COBCANNON: return SeedType::SEED_KERNELPULT;
	case SeedType::SEED_GOLD_MAGNET: return SeedType::SEED_MAGNETSHROOM;
	case SeedType::SEED_GLOOMSHROOM: return SeedType::SEED_FUMESHROOM;
	case SeedType::SEED_CATTAIL: return SeedType::SEED_LILYPAD;
	default: return SeedType::SEED_NONE;
	}
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

	// Expose the live chooser so the same Pi session can make the seed-deck
	// decision. A Crazy Dave dialog is advanced by the chooser-free lifecycle
	// action first; Imitater is omitted until its secondary type is in the wire contract.
	if (app_->mSeedChooserScreen != nullptr && app_->mCrazyDaveMessageIndex == -1 &&
		aBoard->mCutScene != nullptr && aBoard->mCutScene->mSeedChoosing &&
		aBoard->mSeedBank != nullptr)
	{
		SeedChooserScreen* aChooser = app_->mSeedChooserScreen.get();
		aSnapshot.seedChooser.active = true;
		aSnapshot.seedChooser.ready = aChooser->mSeedsInFlight == 0;
		aSnapshot.seedChooser.slots = aBoard->mSeedBank->mNumPackets;
		for (int anIndex = static_cast<int>(SeedType::SEED_PEASHOOTER);
			anIndex < static_cast<int>(NUM_SEEDS_IN_CHOOSER); ++anIndex)
		{
			const SeedType aSeed = static_cast<SeedType>(anIndex);
			if (aSeed == SeedType::SEED_IMITATER || !app_->HasSeedType(aSeed) ||
				aChooser->SeedNotAllowedToPick(aSeed) || aChooser->SeedNotAllowedDuringTrial(aSeed))
				continue;

			SeedOptionView aOption;
			aOption.type = SeedName(aSeed);
			aOption.cost = Plant::GetCost(aSeed);
			const unsigned int aFlags = aChooser->SeedNotRecommendedToPick(aSeed);
			auto addWarning = [&](NotRecommend theFlag, const char* theText) {
				if ((aFlags & (1u << static_cast<unsigned int>(theFlag))) != 0)
					aOption.warnings.emplace_back(theText);
			};
			addWarning(NotRecommend::NOT_RECOMMENDED_NOCTURNAL, "nocturnal_plant_on_day_stage");
			addWarning(NotRecommend::NOT_RECOMMENDED_NEEDS_POOL, "requires_pool");
			addWarning(NotRecommend::NOT_RECOMMENDED_NEEDS_GRAVES, "requires_graves");
			addWarning(NotRecommend::NOT_RECOMMENDED_NEEDS_FOG, "requires_fog");
			addWarning(NotRecommend::NOT_RECOMMENDED_NEEDS_ROOF, "requires_roof");
			addWarning(NotRecommend::NOT_RECOMMENDED_ON_ROOF, "not_recommended_on_roof");
			addWarning(NotRecommend::NOT_RECOMMENDED_FOR_CHALLENGE, "not_recommended_for_challenge");
			addWarning(NotRecommend::NOT_RECOMMENDED_AT_NIGHT, "not_recommended_at_night");
			aOption.recommended = aOption.warnings.empty();

			const SeedType aBase = UpgradeRequirement(aSeed);
			if (!app_->IsSurvivalMode() && aBase != SeedType::SEED_NONE &&
				app_->HasSeedType(aBase) && !aChooser->SeedNotAllowedToPick(aBase) &&
				!aChooser->SeedNotAllowedDuringTrial(aBase))
			{
				aOption.requirements.push_back(SeedName(aBase));
			}
			aSnapshot.seedChooser.availablePlants.push_back(std::move(aOption));

			const ChosenSeed& aChosen = aChooser->mChosenSeeds[aSeed];
			if (aChosen.mSeedState == ChosenSeedState::SEED_IN_BANK)
				aSnapshot.seedChooser.preselected.push_back(SeedName(aSeed));
			if (aChosen.mCrazyDavePicked)
				aSnapshot.seedChooser.required.push_back(SeedName(aSeed));
		}
	}

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

Issue PvzFacade::ChooseSeeds(const std::vector<std::string>& thePlants)
{
	if (app_ == nullptr)
		return Issue::NoSeedChooser;

	// Crazy Dave freezes the intro cutscene. Advancing his dialogue is
	// lifecycle work, not a seed-deck decision.
	if (app_->mCrazyDaveMessageIndex != -1)
	{
		if (!thePlants.empty())
			return Issue::InvalidSeedSelection;
		int aDaveGuard = 0;
		while (app_->mCrazyDaveMessageIndex != -1 && aDaveGuard++ < 64)
		{
			if (!app_->AdvanceCrazyDaveText())
				app_->CrazyDaveLeave();
		}
		return Issue::None;
	}

	Board* aBoard = app_->mBoard;
	if (aBoard == nullptr || aBoard->mCutScene == nullptr ||
		app_->mSeedChooserScreen == nullptr || !aBoard->mCutScene->mSeedChoosing)
		return thePlants.empty() ? Issue::None : Issue::NoSeedChooser;

	SeedChooserScreen* aChooser = app_->mSeedChooserScreen.get();
	if (aBoard->mSeedBank == nullptr)
		return Issue::NoSeedChooser;
	if (aChooser->mSeedsInFlight > 0)
		return Issue::SeedChooserNotReady;

	const int aSlots = aBoard->mSeedBank->mNumPackets;
	if (aSlots <= 0 || aSlots > SEEDBANK_MAX ||
		static_cast<int>(thePlants.size()) != aSlots)
		return Issue::InvalidSeedSelection;

	std::vector<SeedType> aAvailable;
	for (int anIndex = static_cast<int>(SeedType::SEED_PEASHOOTER);
		anIndex < static_cast<int>(NUM_SEEDS_IN_CHOOSER); ++anIndex)
	{
		const SeedType aSeed = static_cast<SeedType>(anIndex);
		if (aSeed == SeedType::SEED_IMITATER || !app_->HasSeedType(aSeed) ||
			aChooser->SeedNotAllowedToPick(aSeed) || aChooser->SeedNotAllowedDuringTrial(aSeed))
			continue;
		aAvailable.push_back(aSeed);
	}

	std::vector<SeedType> aChosen;
	for (const auto& aName : thePlants)
	{
		SeedType aSeed = SeedType::SEED_NONE;
		if (!SeedFromName(aName, aSeed) ||
			std::find(aAvailable.begin(), aAvailable.end(), aSeed) == aAvailable.end() ||
			std::find(aChosen.begin(), aChosen.end(), aSeed) != aChosen.end())
			return Issue::InvalidSeedSelection;
		aChosen.push_back(aSeed);
	}

	for (int anIndex = static_cast<int>(SeedType::SEED_PEASHOOTER);
		anIndex < static_cast<int>(NUM_SEEDS_IN_CHOOSER); ++anIndex)
	{
		const SeedType aSeed = static_cast<SeedType>(anIndex);
		if (aChooser->mChosenSeeds[aSeed].mCrazyDavePicked &&
			std::find(aChosen.begin(), aChosen.end(), aSeed) == aChosen.end())
			return Issue::InvalidSeedSelection;
	}
	if (!app_->IsSurvivalMode())
	{
		for (const SeedType aSeed : aChosen)
		{
			const SeedType aBase = UpgradeRequirement(aSeed);
			if (aBase != SeedType::SEED_NONE && app_->HasSeedType(aBase) &&
				std::find(aChosen.begin(), aChosen.end(), aBase) == aChosen.end())
				return Issue::InvalidSeedSelection;
		}
	}

	// Replace the whole ordered bank with the model's deck. Reset previous
	// selections first because CloseSeedChooser maps packet slots by index.
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

	for (int anIndex = 0; anIndex < aSlots; ++anIndex)
	{
		ChosenSeed& aSeed = aChooser->mChosenSeeds[aChosen[static_cast<std::size_t>(anIndex)]];
		int aX = 0;
		int aY = 0;
		aChooser->GetSeedPositionInBank(anIndex, aX, aY);
		aSeed.mSeedType = aChosen[static_cast<std::size_t>(anIndex)];
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

	// CloseSeedChooser can skip the one-tick slide animation. Keep the visible
	// bank aligned with the game's normal end-of-chooser position.
	aBoard->mSeedBank->mCutSceneDarken = 128;
	aBoard->mSeedBank->Move(SEED_BANK_OFFSET_X_END, 0);
	return Issue::None;
}
}
