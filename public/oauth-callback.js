// OAuth 2.0 redirect target: hands the URL (with ?code=&state=) back to the Curlion tab that
// opened this window. BroadcastChannel is used because the site's Cross-Origin-Opener-Policy
// cuts window.opener once the popup has visited the provider's sign-in page.
;(() => {
  const msg = document.getElementById('msg')
  try {
    const ch = new BroadcastChannel('curlion-oauth')
    ch.postMessage({ type: 'redirect', url: location.href })
    ch.close()
    msg.textContent = 'Done. You can close this window and return to Curlion.'
    setTimeout(() => window.close(), 400)
  } catch {
    msg.textContent = 'Copy this page’s address and paste it into Curlion’s Auth tab to finish.'
  }
})()
