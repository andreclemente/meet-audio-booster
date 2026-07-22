chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        window.__meetingAudioBoosterShow?.()
      }
    })
  } catch (error) {
    console.warn('Meeting Audio Booster could not be shown on this page', error)
  }
})
