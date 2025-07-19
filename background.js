// Background script to handle extension actions
console.log('Background script loaded');

// Handle extension icon click
chrome.action.onClicked.addListener(() => {
  chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 420,
    height: 400,
    left: 100,
    top: 100
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === '_execute_action') {
    // Open popup window programmatically
    chrome.windows.create({
      url: 'popup.html',
      type: 'popup',
      width: 420,
      height: 400,
      left: 100,
      top: 100
    });
  }
});
