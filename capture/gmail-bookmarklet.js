// "Email → Nextly" bookmarklet for Chrome and Safari (desktop).
// Set NEXTLY_HOST to your Cloudflare Tunnel hostname, then minify into a bookmark.
// The first use asks you to sign in with Cloudflare Access (see docs/cloudflare.md):
//   javascript:(()=>{...})()
//
// Uses the open message's Gmail message id when it can find it, so the link
// opens the same email from any device signed in to that Gmail account.
(() => {
  const NEXTLY_HOST = 'https://nextly.example.com'; // your Cloudflare Tunnel hostname
  const subject = (document.querySelector('h2[data-thread-perm-id], h2.hP')?.textContent
    || document.title.replace(/ - .*?Gmail$/, '')).trim();
  const legacyId = document.querySelector('[data-legacy-message-id]')?.getAttribute('data-legacy-message-id');
  const url = legacyId
    ? `https://mail.google.com/mail/u/0/#all/${legacyId}`
    : location.href;
  const target = `${NEXTLY_HOST}/capture?title=${encodeURIComponent(subject)}&url=${encodeURIComponent(url)}`;
  window.open(target, 'nextly', 'width=420,height=560');
})();
