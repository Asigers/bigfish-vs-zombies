// Bridge lifecycle hooks, called from the game loop.
// SPDX-License-Identifier: LGPL-3.0-or-later
#pragma once

class LawnApp;

namespace bigfish
{
/**
 * Starts the bridge on the first frame (loopback HTTP + token from the
 * environment) and pumps it once per frame afterwards.
 *
 * Environment:
 *   BIGFISH_BRIDGE_TOKEN  required; without it the bridge stays disabled
 *   BIGFISH_BRIDGE_PORT   optional; default 45941
 */
void PumpBridge(LawnApp* theApp);

/** Stop the HTTP server and release the bridge. Safe to call more than once. */
void ShutdownBridge();
}
