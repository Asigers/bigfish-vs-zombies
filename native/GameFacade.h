// The only surface the bridge needs from the game engine.
// SPDX-License-Identifier: LGPL-3.0-or-later
#pragma once

#include "Protocol.h"

namespace bigfish
{
class IGameFacade
{
public:
	virtual ~IGameFacade() = default;

	/** Capture the authoritative public board state. Called on the game thread. */
	virtual Snapshot Capture() = 0;

	/**
	 * Apply one validated action on the game thread using the engine's own
	 * mechanics. Returns Issue::None when the engine accepted it; the bridge
	 * then requires the effect to be visible in the next capture.
	 */
	virtual Issue PlacePlant(const Action& theAction) = 0;
	virtual Issue CollectSun(const Action& theAction) = 0;
	virtual Issue Shovel(const Action& theAction) = 0;
	virtual Issue NextLevel() = 0;
};
}
