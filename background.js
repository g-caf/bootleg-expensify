// Background script to handle extension actions
chrome.commands.onCommand.addListener((command) => {
  if (command === '_execute_action') {
    // Open popup programmatically
    chrome.action.openPopup();
  }
});
