// The Dragon Copilot SDK ships as a CDN <script> bundle (see index.html), not an npm runtime
// package — it attaches itself to `window.DragonCopilotSDK.dragon` at load time.
// @microsoft/dragon-copilot-sdk-types (devDependency) gives us the real type shape for it.
import type * as Dragon from '@microsoft/dragon-copilot-sdk-types';

declare global {
  interface Window {
    DragonCopilotSDK: {
      dragon: typeof Dragon;
    };
  }
}

export {};
