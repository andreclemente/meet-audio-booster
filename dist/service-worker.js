chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id) return

  try {
    const url = new URL(tab.url)
    if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com') return
  } catch { return }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        window.__meetingAudioBoosterShow?.()
      }
    })
  } catch (error) {
    console.warn('Meet Audio Booster could not be shown on this page', error)
  }
})
