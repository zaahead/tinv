// tinv player — no manual UI. The extension makes .tinv links "just play":
// any navigation to a *.tinv URL is redirected to our minimal player page,
// which decodes and streams it inline, instead of the browser downloading an
// unknown file type. The user never sees a "pick a file" page.

const PLAYER_URL = chrome.runtime.getURL("player.html");

// Build a redirect rule that points a matched .tinv URL at the player page,
// passing the original URL through `\0` (the whole regex match). Registered
// dynamically so it can embed our real extension id via getURL().
function tinvRedirectRule() {
  return {
    id: 1,
    priority: 1,
    action: {
      type: "redirect",
      redirect: {
        // \0 = the entire matched URL (the .tinv address the user opened).
        regexSubstitution: `${PLAYER_URL}?url=\\0`,
      },
    },
    condition: {
      regexFilter: "^https?://[^?#]+\\.tinv([?#].*)?$",
      resourceTypes: ["main_frame"],
    },
  };
}

async function installRules() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [tinvRedirectRule()],
    });
  } catch (e) {
    console.error("[tinv] failed to install redirect rule", e);
  }
}

chrome.runtime.onInstalled.addListener(installRules);
chrome.runtime.onStartup.addListener(installRules);
