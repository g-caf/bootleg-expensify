// Background script to handle extension actions
chrome.action.onClicked.addListener(() => {
  // Check if tab is already open
  chrome.tabs.query({url: chrome.runtime.getURL('popup.html')}, (tabs) => {
    if (tabs.length > 0) {
      // Tab exists, focus it
      chrome.tabs.update(tabs[0].id, {active: true});
      chrome.windows.update(tabs[0].windowId, {focused: true});
    } else {
      // Create new tab
      chrome.tabs.create({
        url: chrome.runtime.getURL('popup.html')
      });
    }
  });
});

// Handle keyboard shortcut
chrome.commands.onCommand.addListener((command) => {
  if (command === '_execute_action') {
    chrome.tabs.query({url: chrome.runtime.getURL('popup.html')}, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, {active: true});
        chrome.windows.update(tabs[0].windowId, {focused: true});
      } else {
        chrome.tabs.create({
          url: chrome.runtime.getURL('popup.html')
        });
      }
    });
  }
});
