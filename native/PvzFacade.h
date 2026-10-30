// PvZ-Portable implementation of the bridge facade.
// SPDX-License-Identifier: LGPL-3.0-or-later
#pragma once

#include "GameFacade.h"

class LawnApp;

namespace bigfish
{
class PvzFacade final : public IGameFacade
{
public:
	explicit PvzFacade(LawnApp* theApp);

	Snapshot Capture() override;
	Issue PlacePlant(const Action& theAction) override;
	Issue CollectSun(const Action& theAction) override;
	Issue Shovel(const Action& theAction) override;
	Issue NextLevel() override;
	Issue EnterAdventure() override;
	Issue ChooseSeeds() override;
	std::string DiagnosticsJson() override;

private:
	LawnApp* app_;
};
}
